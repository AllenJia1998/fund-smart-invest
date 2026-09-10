/**
 * 支付宝 · 蚂蚁财富 数据源实现。
 *
 * 现状（已在目标机器实测）：`fundmobapi.alipay.com` 在公网 DNS 层面无法解析
 * （curl exit 6 / could not resolve host），因此本 Provider 默认处于
 * `unavailable` 状态，仅在探测到可达时启用。
 *
 * 保留完整实现的意义：
 *   1. 架构上把「数据源」做成可插拔，接入蚂蚁财富不需要改动业务代码；
 *   2. 在 DNS 可达的网络（如已配置内网代理 / 白名单出口）下可通过
 *      FUND_PROVIDER=antfortune 直接切换到本数据源；
 *   3. 前端会明确展示当前数据源与健康状态，不做虚假声称。
 */
import { fetchJson } from '../lib/http.js';

/** 蚂蚁财富开放接口基址（支付宝基金业务网关）。 */
const BASE = 'https://fundmobapi.alipay.com/fundprod/fund';

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 探测蚂蚁财富域名是否可达，结果缓存 5 分钟。 */
let healthCache = { at: 0, ok: false, reason: '' };
export async function probe() {
  if (Date.now() - healthCache.at < 300_000) return healthCache;
  try {
    await fetchJson(`${BASE}/Detail.json?fundCode=000001`, { timeoutMs: 6000, retries: 0 });
    healthCache = { at: Date.now(), ok: true, reason: '' };
  } catch (error) {
    healthCache = {
      at: Date.now(),
      ok: false,
      reason: String(error?.cause?.code ?? error?.message ?? error),
    };
  }
  return healthCache;
}

export const antfortune = {
  id: 'antfortune',
  label: '支付宝 · 蚂蚁财富',
  proxyRequired: false,

  async isAvailable() {
    return (await probe()).ok;
  },

  async quote(codes) {
    const list = [...new Set(codes.filter(Boolean))];
    const out = [];
    for (const code of list) {
      const data = await fetchJson(`${BASE}/Detail.json?fundCode=${code}`, { timeoutMs: 8000 });
      const d = data?.resultObj ?? data?.data ?? {};
      out.push({
        code: d.fundCode ?? code,
        name: d.fundName ?? d.shortName ?? null,
        navDate: d.endDate ?? d.navDate ?? null,
        nav: num(d.netValue ?? d.nav),
        accNav: num(d.totalNetValue ?? d.accNav),
        changePct: num(d.dayGrowth ?? d.navChgRt),
        estNav: num(d.estimateValue ?? d.gsz),
        estChangePct: num(d.estimateGrowth ?? d.gszzl),
        estTime: d.estimateTime ?? d.gztime ?? null,
        redPacket: false,
      });
    }
    return out;
  },

  async detail(code) {
    const data = await fetchJson(`${BASE}/Detail.json?fundCode=${code}`, { timeoutMs: 8000 });
    const d = data?.resultObj ?? data?.data ?? {};
    return {
      code: d.fundCode ?? code,
      name: d.fundName ?? d.shortName ?? null,
      fullName: d.fullName ?? null,
      type: d.fundType ?? null,
      inceptionDate: d.establishDate ?? null,
      scale: num(d.fundSize),
      scaleDate: d.fundSizeDate ?? null,
      manager: d.managerName ?? null,
      company: d.companyName ?? null,
      rating: d.rating ?? null,
      riskLevel: d.riskLevel ?? null,
      benchmark: d.benchmark ?? null,
      goal: d.investGoal ?? null,
      strategy: d.investStrategy ?? null,
    };
  },

  async history(code, pageSize = 2000) {
    const data = await fetchJson(
      `${BASE}/NetValueTrend.json?fundCode=${code}&pageSize=${pageSize}`,
      { timeoutMs: 12_000 }
    );
    const rows = data?.resultObj?.datas ?? data?.data ?? [];
    const points = rows
      .map((r) => ({
        ts: Date.parse(r.endDate ?? r.date ?? ''),
        date: r.endDate ?? r.date ?? null,
        nav: num(r.netValue ?? r.nav),
        changePct: num(r.dayGrowth ?? r.navChgRt),
        accNav: num(r.totalNetValue ?? r.accNav),
      }))
      .filter((p) => p.date !== null)
      .sort((a, b) => a.ts - b.ts);

    return {
      code,
      name: null,
      points,
      managers: [],
      fee: { current: null, original: null },
      periodReturns: { m1: null, m3: null, m6: null, y1: null },
    };
  },

  async ranking(direction = 'up', limit = 10) {
    const sort = direction === 'down' ? 'asc' : 'desc';
    const data = await fetchJson(
      `${BASE}/RankList.json?pageSize=${limit}&sortType=${sort}`,
      { timeoutMs: 10_000 }
    );
    const rows = data?.resultObj?.datas ?? data?.data ?? [];
    return rows.map((r) => ({
      code: r.fundCode,
      name: r.fundName,
      navDate: r.endDate ?? null,
      nav: num(r.netValue),
      accNav: num(r.totalNetValue),
      changePct: num(r.dayGrowth),
      week1: null,
      month1: num(r.monthGrowth),
      month3: num(r.threeMonthGrowth),
      month6: num(r.sixMonthGrowth),
      year1: num(r.yearGrowth),
      year3: null,
      thisYear: num(r.thisYearGrowth),
      sinceInception: null,
      inceptionDate: null,
    }));
  },

  async search(keyword, limit = 10) {
    const data = await fetchJson(
      `${BASE}/Search.json?keywords=${encodeURIComponent(keyword)}&pageSize=${limit}`,
      { timeoutMs: 8000 }
    );
    const rows = data?.resultObj?.datas ?? data?.data ?? [];
    return rows.slice(0, limit).map((r) => ({
      code: r.fundCode,
      name: r.fundName,
      type: r.fundType ?? null,
      pinyin: null,
    }));
  },

  async fundNews() {
    return [];
  },
};
