/**
 * 访问控制与限流。
 *
 * 需求：行情看板、资讯等只读接口对公网开放；而 AI 对话与报告生成会消耗
 * DeepSeek 额度，必须凭口令访问，并做单 IP 频率限制，避免 Key 被白嫖。
 */
import { config } from '../config.js';

/* --------------------------- 访问口令 --------------------------- */

/** 常量时间比较，避免时序侧信道。 */
function safeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/** 从请求里取口令：优先 Header，其次查询参数（便于 EventSource 场景）。 */
export function extractCode(req, url) {
  const header = req.headers['x-access-code'];
  if (header) return String(header);
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return url?.searchParams?.get('code') ?? '';
}

/**
 * 校验访问口令。
 * 未配置 ACCESS_CODE 时视为未启用保护（本地开发方便），但会在启动时告警。
 */
export function checkAccess(req, url) {
  if (!config.accessCode) return { ok: true, disabled: true };
  const provided = extractCode(req, url);
  if (safeEqual(provided, config.accessCode)) return { ok: true };
  return { ok: false, reason: '需要访问口令' };
}

/* ---------------------------- 限流 ---------------------------- */

/**
 * 滑动窗口限流器：按 IP 统计时间窗内的请求数。
 * 用于保护消耗额度的接口。
 */
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    // 定期清理过期记录，避免内存增长
    this.timer = setInterval(() => this.sweep(), Math.max(windowMs, 60_000));
    this.timer.unref?.();
  }

  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }

  /** 返回 { allowed, remaining, retryAfterMs }。 */
  check(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      const retryAfterMs = list[0] + this.windowMs - now;
      this.hits.set(key, list);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, remaining: this.limit - list.length, retryAfterMs: 0 };
  }
}

/** 对话接口：默认每 IP 每分钟 12 次 */
export const chatLimiter = new RateLimiter(Number(process.env.RATE_CHAT ?? 12), 60_000);
/** 报告生成：默认每 IP 每小时 5 次（单次消耗额度较大） */
export const reportLimiter = new RateLimiter(Number(process.env.RATE_REPORT ?? 5), 3_600_000);

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * 受保护接口的统一前置检查。
 * @returns {null | {status:number, error:string, retryAfterMs?:number}} null 表示通过
 */
export function guard(req, url, limiter) {
  const access = checkAccess(req, url);
  if (!access.ok) {
    return { status: 401, error: '需要访问口令：请在页面中输入访问码', code: 'UNAUTHORIZED' };
  }
  if (limiter) {
    const rate = limiter.check(clientIp(req));
    if (!rate.allowed) {
      return {
        status: 429,
        error: `请求过于频繁，请 ${Math.ceil(rate.retryAfterMs / 1000)} 秒后重试`,
        code: 'RATE_LIMITED',
        retryAfterMs: rate.retryAfterMs,
      };
    }
  }
  return null;
}

export function authStatus() {
  return {
    enabled: Boolean(config.accessCode),
    protectedEndpoints: ['POST /api/chat', 'POST /api/push/generate'],
    rateLimit: {
      chat: '每 IP 每分钟 12 次',
      report: '每 IP 每小时 5 次',
    },
  };
}
