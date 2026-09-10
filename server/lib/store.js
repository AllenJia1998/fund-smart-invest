/**
 * 轻量持久化（JSON 文件）与 TTL 缓存。
 * 聊天会话、知识库、推送报告都落盘到 data/ 下，重启不丢。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../config.js';

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

/** 单文件集合：一个 JSON 数组，适合会话、报告等中小规模数据。 */
export class Collection {
  constructor(name) {
    this.file = join(DATA_DIR, `${name}.json`);
    this.items = readJson(this.file, []);
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
    writeJson(this.file, this.items);
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
