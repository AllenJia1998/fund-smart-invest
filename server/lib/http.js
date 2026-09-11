/**
 * HTTP 基础工具：请求体解析、统一 JSON 响应、SSE 流、静态文件服务。
 * 全部基于 node:http / node:fs，无第三方依赖。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from '../config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * 写入跨域响应头。
 *
 * 前端部署在 GitHub Pages（不同源）时，必须允许跨域；由于调用方会带
 * 自定义头 X-Access-Code，浏览器会先发 OPTIONS 预检，因此需要一并放行。
 * @returns true 表示这是预检请求且已处理完毕。
 */
export function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins;
  if (origin) {
    if (allowed === '*' || (Array.isArray(allowed) && allowed.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowed === '*' ? '*' : origin);
      if (allowed !== '*') res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Code, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/** 读取并解析 JSON 请求体（上限 64MB，用于携带 base64 附件）。 */export async function readJsonBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

export function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, error) {
  const status = error?.statusCode ?? 500;
  if (status >= 500) console.error('[error]', error);
  sendJson(res, { ok: false, error: String(error?.message ?? error) }, status);
}

/** 打开一条 SSE 通道，返回发送/结束方法。 */
export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    end() {
      if (!closed) res.end();
    },
  };
}

/** 静态文件服务，带目录穿越防护。 */
export function serveStatic(rootDir, urlPath, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = resolve(join(rootDir, normalize(rel)));
  const root = resolve(rootDir);
  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(res, { ok: false, error: 'forbidden' }, 403);
    return true;
  }
  if (!existsSync(target) || !statSync(target).isFile()) return false;
  const stat = statSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=60',
  });
  createReadStream(target).pipe(res);
  return true;
}

/** 带超时与重试的 fetch + JSON 解析。 */
export async function fetchJson(url, { timeoutMs = 12_000, headers = {}, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          ...headers,
        },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      return parseMaybeJson(text);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** 兼容 JSON / JSONP / `var x = {...}` 三种上游返回形态。 */
export function parseMaybeJson(text) {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试其它形态 */
  }
  const jsonp = trimmed.match(/^[\w$.]+\s*\((.*)\)\s*;?$/s);
  if (jsonp) {
    try {
      return JSON.parse(jsonp[1]);
    } catch {
      /* 落到赋值形态 */
    }
  }
  const assign = trimmed.match(/^\s*var\s+[\w$]+\s*=\s*(.*?);?\s*$/s);
  if (assign) {
    try {
      return JSON.parse(assign[1]);
    } catch {
      /* 无法解析 */
    }
  }
  throw new Error('upstream returned unparseable payload');
}
