/**
 * 天天基金 / 东方财富 数据源实现。
 *
 * 说明：支付宝蚂蚁财富（fundmobapi.alipay.com）在公网 DNS 层面不可解析，
 * 本实现作为可用的等价数据源。蚂蚁财富展示的基金净值同样源自天天基金，
 * 因此数据口径一致。详见 providers/antfortune.js 与 README 的说明。
 */
import { fetchJson, parseMaybeJson } from '../lib/http.js';

const DEVICE_ID = 'dsh-fund-smart-invest';
const UA_REFERER = 'https://fund.eastmoney.com/';

/** 从 pingzhongdata 这类 JS 文本里取出某个 `var x = ...;` 的 JSON 值。 */
function extractVar(text, name) {
  const match = text.match(new RegExp(`var\\s+${name}\\s*=\\s*([\\s\\S]*?);\\s*(?:/\\*|var\\s|$)`));
  if (!match) return undefined;
  const raw = match[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const eastmoney = {
  id: 'eastmoney',
  label: '天天基金（东方财富）',
  /** 该源是否需要网络代理 */
  proxyRequired: false,

  /** 批量实时行情：净值、日涨跌幅、盘中估值。 */
  async quote(codes) {
    const list = [...new Set(codes.filter(Boolean))];
    if (list.length === 0) return [];
    const url =
      `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo` +
      `?pageIndex=1&pageSize=${Math.max(list.length, 20)}&plat=Android&appType=ttjj` +
      `&product=EFund&Version=1&deviceid=${DEVICE_ID}&Fcodes=${list.join(',')}`;
    const data = await fetchJson(url, { headers: { Referer: UA_REFERER } });
    const rows = data?.Datas ?? [];
    return rows.map((row) => ({
      code: row.FCODE,
      name: row.SHORTNAME,
      navDate: row.PDATE ?? null,
      nav: num(row.NAV),
      accNav: num(row.ACCNAV),
      changePct: num(row.NAVCHGRT),
      // 盘中估值（交易时段由上游提供，盘后为 null）
      estNav: num(row.GSZ),
      estChangePct: num(row.GSZZL),
      estTime: row.GZTIME ?? null,
      redPacket: row.ISHAVEREDPACKET === true,
    }));
  },

  /** 基金详情：类型、成立日、规模、费率、经理等。 */
  async detail(code) {
    const url =
      `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation` +
      `?FCODE=${code}&deviceid=${DEVICE_ID}&plat=Android&product=EFund&version=6.2.8`;
    const data = await fetchJson(url, { headers: { Referer: UA_REFERER } });
    const d = data?.Datas ?? {};
    return {
      code: d.FCODE ?? code,
      name: d.SHORTNAME ?? null,
      fullName: d.FULLNAME ?? null,
      type: d.FTYPE ?? null,
      inceptionDate: d.ESTABDATE ?? null,
      scale: num(d.ENDNAV),
      scaleDate: d.FEGMRQ ?? null,
      manager: d.JJJL ?? null,
      company: d.JJGS ?? null,
      rating: d.RLEVEL_SZ ?? null,
      riskLevel: d.RISKLEVEL ?? null,
      benchmark: d.BENCH ?? null,
      goal: d.INVESTGOAL ?? null,
      strategy: d.INVESTSTRATEGY ?? null,
    };
  },

  /**
   * 完整历史净值序列 + 各周期收益率。
   * 数据量大（单只约 700KB），调用方应缓存。
   */
  async history(code) {
    const text = await fetchJson(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
      headers: { Referer: UA_REFERER },
      timeoutMs: 20_000,
    })
      .then((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .catch(async () => {
        const res = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
          headers: { Referer: UA_REFERER, 'User-Agent': 'Mozilla/5.0' },
        });
        return res.text();
      });

    const netWorth = extractVar(text, 'Data_netWorthTrend') ?? [];
    const accWorth = extractVar(text, 'Data_ACWorthTrend') ?? [];
    const accMap = new Map(accWorth.map(([ts, v]) => [ts, v]));

    const points = netWorth.map((p) => ({
      ts: p.x,
      date: new Date(p.x).toISOString().slice(0, 10),
      nav: p.y,
      changePct: p.equityReturn ?? null,
      accNav: accMap.get(p.x) ?? null,
    }));

    return {
      code,
      name: extractVar(text, 'fS_name') ?? null,
      points,
      managers: extractVar(text, 'Data_currentFundManager') ?? [],
      fee: {
        current: extractVar(text, 'fund_Rate') ?? null,
        original: extractVar(text, 'fund_sourceRate') ?? null,
      },
      /** 上游直接给出的区间收益（%）：1月 / 3月 / 6月 / 1年 */
      periodReturns: {
        m1: num(extractVar(text, 'syl_1y')),
        m3: num(extractVar(text, 'syl_3y')),
        m6: num(extractVar(text, 'syl_6y')),
        y1: num(extractVar(text, 'syl_1n')),
      },
    };
  },

  /**
   * 排行榜。direction: 'up' 涨幅榜 / 'down' 跌幅榜。
   * 上游返回逗号分隔字符串，列序见 FIELD 映射。
   */
  async ranking(direction = 'up', limit = 10) {
    const st = direction === 'down' ? 'asc' : 'desc';
    const url =
      `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all` +
      `&sc=1nzf&st=${st}&pi=1&pn=${limit}&v=${Date.now()}`;
    const res = await fetch(url, {
      headers: { Referer: 'https://fund.eastmoney.com/data/fundranking.html', 'User-Agent': 'Mozilla/5.0' },
    });
    const text = await res.text();
    const match = text.match(/datas:\s*(\[[\s\S]*?\])\s*,\s*allRecords/);
    if (!match) return [];
    let rows;
    try {
      rows = JSON.parse(match[1]);
    } catch {
      return [];
    }
    return rows.map((line) => {
      const c = line.split(',');
      return {
        code: c[0],
        name: c[1],
        navDate: c[3] || null,
        nav: num(c[4]),
        accNav: num(c[5]),
        changePct: num(c[6]),
        week1: num(c[7]),
        month1: num(c[8]),
        month3: num(c[9]),
        month6: num(c[10]),
        year1: num(c[11]),
        year3: num(c[13]),
        thisYear: num(c[14]),
        sinceInception: num(c[15]),
        inceptionDate: c[16] || null,
      };
    });
  },

  /** 基金搜索（代码或名称关键字）。 */
  async search(keyword, limit = 10) {
    const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(keyword)}`;
    const data = await fetchJson(url, { headers: { Referer: UA_REFERER } });
    const list = data?.Datas ?? [];
    return list.slice(0, limit).map((item) => ({
      code: item.CODE,
      name: item.NAME,
      type: item.FundBaseInfo?.FTYPE ?? null,
      pinyin: item.JP ?? null,
    }));
  },

  /** 基金相关资讯（用于每日推送的个股/基金维度补充）。 */
  async fundNews(code, limit = 5) {
    const url = `https://api.fund.eastmoney.com/zm/GetFundNews?fundcode=${code}&pageIndex=1&pageSize=${limit}`;
    try {
      const data = await fetchJson(url, { headers: { Referer: UA_REFERER } });
      return data?.Data ?? [];
    } catch {
      return [];
    }
  },
};

/** 供 history 的文本抓取复用。 */
export { parseMaybeJson };
