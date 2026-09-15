/**
 * 轻量持久化与 TTL 缓存。
 *
 * 双后端：
 *   1. 本地 JSON 文件（data/*.json）—— 默认，本地开发用
 *   2. Turso（SQLite 云）—— 配置了 TURSO_URL / TURSO_TOKEN 时启用
 *
 * 之所以需要 Turso：Render 等云平台的免费实例文件系统是临时的，
 * 休眠唤醒或重新部署都会清空 data/，导致报告、会话、自选等全部丢失。
 *
 * 设计：所有集合常驻内存（读走内存，快），写操作同时落本地文件（兜底）
 * 并按防抖异步推送到 Turso（远端权威副本）。启动时若配置了 Turso，
 * 则用远端数据覆盖内存，实现跨重启、跨实例持久化。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { tursoConfigured, tursoExecute } from './turso.js';

function ensureDir(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(file);
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return value;
}

/* --------------------------- 远端持久化 --------------------------- */

const TABLE = 'fsi_kv';
/** 最近一次 initStore 的结果，供 /api/status 展示。 */
let lastInit = { backend: 'local', collections: 0 };

/** 返回存储后端状态（含远端健康摘要）。 */
export function storeStatus() {
  return { ...lastInit, tursoConfigured: tursoConfigured() };
}
/** 已实例化的全部集合，供 initStore 统一注水。 */
const registry = new Set();

/** 把某个集合写入远端（UPSERT），失败只告警不阻断业务。 */
async function saveRemote(name, items) {
  const sql =
    `INSERT INTO ${TABLE} (k, v, updated_at) VALUES (?, ?, ?) ` +
    `ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`;
  try {
    await tursoExecute(sql, [`collection:${name}`, JSON.stringify(items), Date.now()]);
  } catch (error) {
    console.warn(`[store] 远端保存 ${name} 失败（已保留本地副本）：${error.message}`);
  }
}

/** 写入防抖：同一集合 600ms 内的多次写入合并为一次远端请求。 */
const pendingRemote = new Map();
function scheduleRemoteSave(name, items) {
  if (!tursoConfigured()) return;
  const existing = pendingRemote.get(name);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingRemote.delete(name);
    saveRemote(name, items());
  }, 600);
  timer.unref?.();
  pendingRemote.set(name, { timer, items });
}

/** 上一次远端保存失败、尚未重试的集合（用于 flushPending）。 */
export async function flushPendingRemote() {
  const tasks = [];
  for (const col of registry) {
    if (col.dirty) tasks.push(saveRemote(col.name, col.items).then(() => { col.dirty = false; }));
  }
  await Promise.allSettled(tasks);
}

/**
 * 启动时初始化存储：建表 + 从远端注水所有集合。
 * 必须在开始接受请求之前 await。
 *
 * 健壮性：远端任何一步失败都必须回退到本地文件，绝不能让集合停在空数组上
 * （否则 Turso 一抖动，线上就会表现为「数据全没了」）。
 */
export async function initStore() {
  if (!tursoConfigured()) {
    for (const col of registry) col.items = readJson(col.file, []);
    lastInit = { backend: 'local', collections: registry.size };
    return lastInit;
  }

  let remote;
  try {
    await tursoExecute(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER)`
    );
    const { rows } = await tursoExecute(`SELECT k, v FROM ${TABLE}`);
    remote = new Map(rows.map(([k, v]) => [k, v]));
  } catch (error) {
    // 远端不可用：整体退回本地文件模式，保证服务可用
    for (const col of registry) col.items = readJson(col.file, []);
    lastInit = {
      backend: 'local',
      collections: registry.size,
      fallbackReason: String(error?.message ?? error),
    };
    return lastInit;
  }

  let restored = 0;
  const seeded = [];
  for (const col of registry) {
    const raw = remote.get(`collection:${col.name}`);
    if (raw !== undefined) {
      try {
        col.items = JSON.parse(raw);
        restored += 1;
        continue;
      } catch {
        console.warn(`[store] 远端 ${col.name} 数据损坏，回退本地文件`);
      }
    }
    // 远端还没有这份数据（首次启用）：用本地已有数据播种，实现无痛迁移
    col.items = readJson(col.file, []);
    if (col.items.length > 0) {
      col.dirty = true;
      seeded.push(col.name);
      await saveRemote(col.name, col.items);
    }
  }
  lastInit = { backend: 'turso', collections: registry.size, restored, seeded, keys: remote.size };
  return lastInit;
}

/* ------------------------------ 集合 ------------------------------ */

/** 单文件集合：一个 JSON 数组，适合会话、报告等中小规模数据。 */
export class Collection {
  constructor(name) {
    this.name = name;
    this.file = join(DATA_DIR, `${name}.json`);
    this.items = [];
    this.dirty = false;
    registry.add(this);
  }

  all() {
    return this.items;
  }

  find(predicate) {
    return this.items.find(predicate);
  }

  filter(predicate) {
    return this.items.filter(predicate);
  }

  insert(item) {
    this.items.push(item);
    this.flush();
    return item;
  }

  update(id, patch) {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) return undefined;
    this.items[index] = { ...this.items[index], ...patch, id };
    this.flush();
    return this.items[index];
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) this.flush();
    return before !== this.items.length;
  }

  flush() {
    writeJson(this.file, this.items); // 本地兜底：远端不可用时数据仍在
    this.dirty = true;
    scheduleRemoteSave(this.name, () => this.items);
    return this;
  }
}

/** 带 TTL 的内存缓存，用于行情等高频读取。 */
export class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value) {
    this.map.set(key, { at: Date.now(), value });
    return value;
  }

  /** 读缓存，未命中则执行 loader 并写回。 */
  async wrap(key, loader) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    this.set(key, value);
    return value;
  }
}

let counter = 0;
export function newId(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}
