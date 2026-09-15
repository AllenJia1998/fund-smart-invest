/**
 * Turso 极简 HTTP 客户端（零依赖）。
 *
 * 使用 Turso 的 "SQL over HTTP"（Hrana over HTTP v2）协议：
 *   POST https://<db>.<org>.turso.io/v2/pipeline
 *   Authorization: Bearer <token>
 *   { "requests": [{ "type": "execute", "stmt": { "sql": "...", "args": [...] } }, { "type": "close" }] }
 *
 * 之所以不引入 @libsql/client：本项目坚持零第三方依赖，而该协议只是几行 fetch。
 * 参考：https://docs.turso.tech/sdk/http/reference
 */
import { config } from '../config.js';

export function tursoConfigured() {
  return Boolean(config.turso.url && config.turso.token);
}

/** 把 JS 值转成协议要求的 Value 结构。 */
function toValue(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  return { type: 'text', value: String(value) };
}

/** 把协议返回的 Value 还原成 JS 值。 */
function fromValue(v) {
  if (v === null || v === undefined) return null;
  switch (v.type) {
    case 'null':
      return null;
    case 'integer':
      return Number(v.value);
    case 'float':
      return v.value;
    case 'text':
      return v.value;
    case 'blob':
      return v.base64;
    default:
      return null;
  }
}

/**
 * 执行单条 SQL。
 * @param {string} sql
 * @param {Array} args 位置参数，对应 SQL 里的 `?`
 * @returns {Promise<{rows: Array<Array<any>>, cols: string[], affectedRowCount: number}>}
 */
export async function tursoExecute(sql, args = []) {
  if (!tursoConfigured()) throw new Error('未配置 TURSO_URL / TURSO_TOKEN');

  const base = config.turso.url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const body = {
    requests: [
      { type: 'execute', stmt: { sql, args: args.map(toValue) } },
      { type: 'close' },
    ],
  };

  const res = await fetch(`${base}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.turso.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Turso HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const first = data.results?.[0];
  if (!first) throw new Error('Turso 返回结果为空');
  if (first.type === 'error') {
    throw new Error(`Turso 执行失败: ${first.error?.message ?? JSON.stringify(first.error)}`);
  }

  const result = first.response?.result ?? {};
  return {
    cols: (result.cols ?? []).map((c) => c.name),
    rows: (result.rows ?? []).map((row) => row.map(fromValue)),
    affectedRowCount: result.affected_row_count ?? 0,
  };
}

/** 连通性自检，返回可读状态。 */
export async function tursoHealth() {
  if (!tursoConfigured()) {
    return { configured: false, ok: false, reason: '未配置 TURSO_URL / TURSO_TOKEN' };
  }
  try {
    await tursoExecute('SELECT 1');
    return { configured: true, ok: true, reason: null, host: safeHost(config.turso.url) };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      reason: String(error?.message ?? error),
      host: safeHost(config.turso.url),
    };
  }
}

function safeHost(url) {
  try {
    return new URL(url.replace(/^libsql:\/\//, 'https://')).host;
  } catch {
    return '(无法解析)';
  }
}
