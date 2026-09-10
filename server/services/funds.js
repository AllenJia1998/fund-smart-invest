/**
 * 基金业务服务：自选管理、行情聚合、周期净值序列、排行榜。
 */
import { config } from '../config.js';
import { Collection, TtlCache } from '../lib/store.js';
import { getProvider } from '../providers/index.js';

export const RANGES = {
  '7d': { label: '7天', days: 7 },
  '1m': { label: '1月', days: 30 },
  '3m': { label: '3月', days: 90 },
  '6m': { label: '6月', days: 180 },
  '1y': { label: '1年', days: 365 },
  '3y': { label: '3年', days: 1095 },
};

/** 默认自选池：覆盖图片里的主题分类。 */
const DEFAULT_WATCHLIST = [
  { code: '000001', theme: '混合' },
  { code: '110022', theme: '消费' },
  { code: '161725', theme: '消费' },
  { code: '006228', theme: '医疗' },
  { code: '008279', theme: '煤炭' },
  { code: '519674', theme: '科技' },
  { code: '019058', theme: '电力' },
  { code: '090010', theme: '红利' },
  { code: '002963', theme: '黄金' },
];

const watchCol = new Collection('watchlist');
const quoteCache = new TtlCache(config.quoteTtlMs);
const historyCache = new TtlCache(10 * 60_000);
const rankingCache = new TtlCache(60_000);

function ensureSeeded() {
  if (watchCol.all().length === 0) {
    for (const item of DEFAULT_WATCHLIST) {
      watchCol.insert({ id: item.code, code: item.code, theme: item.theme, addedAt: Date.now() });
    }
  }
  return watchCol.all();
}

export async function getWatchlist() {
  return ensureSeeded().map(({ code, theme }) => ({ code, theme }));
}

export async function addWatch(code, theme = '自选') {
  const normalized = String(code).trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw Object.assign(new Error('基金代码必须是 6 位数字'), { statusCode: 400 });
  }
  if (!watchCol.find((i) => i.code === normalized)) {
    watchCol.insert({ id: normalized, code: normalized, theme, addedAt: Date.now() });
  }
  return getWatchlist();
}

export function removeWatch(code) {
  watchCol.remove(code);
  return getWatchlist();
}

/** 批量行情（带 TTL 缓存）。 */
export async function getQuotes(codes) {
  const { provider } = await getProvider();
  const missing = codes.filter((code) => quoteCache.get(`q:${code}`) === undefined);
  if (missing.length > 0) {
    const fresh = await provider.quote(missing);
    for (const row of fresh) quoteCache.set(`q:${row.code}`, row);
    // 上游未返回的代码标记为缺失，避免每次重复请求
    for (const code of missing) {
      if (quoteCache.get(`q:${code}`) === undefined) {
        quoteCache.set(`q:${code}`, { code, name: null, missing: true, changePct: null, nav: null });
      }
    }
  }
  return codes.map((code) => quoteCache.get(`q:${code}`)).filter(Boolean);
}

/** 历史净值序列（带缓存）。 */
export async function getHistory(code) {
  return historyCache.wrap(`h:${code}`, async () => {
    const { provider } = await getProvider();
    return provider.history(code);
  });
}

/** 按周期裁剪序列并计算区间涨跌幅。 */
export function sliceSeries(points, range = '1m') {
  const spec = RANGES[range] ?? RANGES['1m'];
  if (points.length === 0) {
    return { range, label: spec.label, points: [], changePct: null, start: null, end: null };
  }
  const cutoff = Date.now() - spec.days * 86_400_000;
  let sliced = points.filter((p) => p.ts >= cutoff);
  // 区间内数据过少（如新基金）时回退到最近 N 个点，保证图有内容
  if (sliced.length < 2) sliced = points.slice(-Math.min(points.length, 30));

  const first = sliced[0];
  const last = sliced[sliced.length - 1];
  const changePct =
    first?.nav && last?.nav ? Number((((last.nav - first.nav) / first.nav) * 100).toFixed(2)) : null;
  return {
    range,
    label: spec.label,
    points: sliced,
    changePct,
    start: first?.date ?? null,
    end: last?.date ?? null,
  };
}

/** 排行榜（涨幅/跌幅）。 */
export async function getRanking(direction, limit = 5) {
  return rankingCache.wrap(`r:${direction}:${limit}`, async () => {
    const { provider } = await getProvider();
    return provider.ranking(direction, limit);
  });
}

/** 搜索基金。 */
export async function searchFunds(keyword) {
  const { provider } = await getProvider();
  return provider.search(keyword);
}

/** 看板聚合：自选行情 + 主题分类 + 涨跌幅榜。 */
export async function dashboard() {
  const watchlist = await getWatchlist();
  const codes = watchlist.map((w) => w.code);
  const themeOf = new Map(watchlist.map((w) => [w.code, w.theme]));

  const [quotes, marketGainers, marketLosers] = await Promise.all([
    getQuotes(codes),
    getRanking('up', 5),
    getRanking('down', 5),
  ]);

  const funds = quotes.map((q) => ({
    ...q,
    theme: themeOf.get(q.code) ?? '自选',
    // 盘中估值优先用于"实时"口径，盘后回落到最新净值涨跌幅
    livePct: q.estChangePct ?? q.changePct,
    liveNav: q.estNav ?? q.nav,
    liveLabel: q.estChangePct !== null ? '盘中估值' : '最新净值',
  }));

  const themes = ['全部', ...new Set(funds.map((f) => f.theme))];

  // 看板右侧的涨跌幅榜看的是"自选池内今日表现"，与产品形态一致
  const ranked = funds
    .filter((f) => f.livePct !== null && f.livePct !== undefined)
    .sort((a, b) => b.livePct - a.livePct);
  const gainers = ranked.filter((f) => f.livePct > 0).slice(0, 5);
  const losers = ranked
    .filter((f) => f.livePct < 0)
    .slice(-5)
    .reverse();

  return {
    funds,
    themes,
    gainers,
    losers,
    marketGainers,
    marketLosers,
    updatedAt: new Date().toISOString(),
  };
}
