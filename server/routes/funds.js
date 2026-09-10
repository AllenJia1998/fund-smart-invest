/** 行情看板 / 自选 / 搜索 / 净值序列 路由。 */
import { sendJson } from '../lib/http.js';
import {
  addWatch,
  dashboard,
  getHistory,
  getRanking,
  getWatchlist,
  removeWatch,
  searchFunds,
  sliceSeries,
} from '../services/funds.js';
import { getProvider, sourceStatus } from '../providers/index.js';

export function registerFundRoutes(router) {
  router.get('/api/funds/dashboard', async ({ res }) => {
    sendJson(res, { ok: true, data: await dashboard() });
  });

  router.get('/api/funds/source', async ({ res }) => {
    sendJson(res, { ok: true, data: await sourceStatus() });
  });

  router.get('/api/funds/search', async ({ res, url }) => {
    const keyword = url.searchParams.get('q') ?? '';
    if (!keyword.trim()) return sendJson(res, { ok: true, data: [] });
    sendJson(res, { ok: true, data: await searchFunds(keyword) });
  });

  router.get('/api/funds/ranking', async ({ res, url }) => {
    const direction = url.searchParams.get('dir') === 'down' ? 'down' : 'up';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 5) || 5, 50);
    sendJson(res, { ok: true, data: await getRanking(direction, limit) });
  });

  router.get('/api/watchlist', async ({ res }) => {
    const list = await getWatchlist();
    sendJson(res, { ok: true, data: list });
  });

  router.post('/api/watchlist', async ({ res, body }) => {
    const list = await addWatch(body.code, body.theme);
    sendJson(res, { ok: true, data: list });
  });

  router.delete('/api/watchlist/:code', async ({ res, params }) => {
    sendJson(res, { ok: true, data: removeWatch(params.code) });
  });

  // 具体基金：/series 必须放在 /:code 之前，避免被通配吞掉
  router.get('/api/funds/:code/series', async ({ res, params, url }) => {
    const range = url.searchParams.get('range') ?? '1m';
    const history = await getHistory(params.code);
    const sliced = sliceSeries(history.points, range);
    sendJson(res, {
      ok: true,
      data: {
        code: params.code,
        name: history.name,
        range: sliced.range,
        rangeLabel: sliced.label,
        changePct: sliced.changePct,
        start: sliced.start,
        end: sliced.end,
        periodReturns: history.periodReturns,
        fee: history.fee,
        points: sliced.points,
      },
    });
  });

  router.get('/api/funds/:code', async ({ res, params }) => {
    const { provider } = await getProvider();
    const [detail, history] = await Promise.all([
      provider.detail(params.code).catch(() => ({})),
      getHistory(params.code).catch(() => ({ points: [], periodReturns: null })),
    ]);
    const latest = history.points.at(-1) ?? null;
    sendJson(res, {
      ok: true,
      data: {
        ...detail,
        code: params.code,
        latestNav: latest?.nav ?? null,
        latestDate: latest?.date ?? null,
        periodReturns: history.periodReturns,
      },
    });
  });
}
