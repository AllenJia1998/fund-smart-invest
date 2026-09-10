/**
 * 财经资讯聚合：7×24 快讯 + 财经新闻 + 政策公告，多源合并去重。
 * 全部使用公开接口，无需鉴权。
 */
import { TtlCache } from '../lib/store.js';
import { fetchJson, parseMaybeJson } from '../lib/http.js';

const cache = new TtlCache(120_000);
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

/** 关键词分类：把资讯归到 政策 / 宏观 / 市场 / 行业 / 国际 五个维度。 */
const CATEGORY_RULES = [
  { key: '政策', words: ['国务院', '央行', '证监会', '财政部', '发改委', '人民银行', '政策', '监管', '降准', '降息', 'LPR', 'MLF', '国常会', '政治局', '试点', '新规', '征求意见'] },
  { key: '宏观', words: ['GDP', 'CPI', 'PPI', 'PMI', '社融', '信贷', '进出口', '外汇储备', '统计局', '经济数据', '失业率', '消费价格'] },
  { key: '国际', words: ['美联储', '欧洲央行', '日本央行', '美股', '纳斯达克', '道琼斯', '美元', '原油', '黄金', '关税', '美联储主席', 'EIA', '非农'] },
  { key: '市场', words: ['A股', '沪指', '深成指', '创业板', '科创板', '北向', '两市', '成交额', '涨停', '跌停', '基金', 'ETF', '债券', '收益率'] },
  { key: '行业', words: ['白酒', '新能源', '光伏', '半导体', '医药', '煤炭', '银行', '地产', '汽车', '军工', '消费', '电力', 'AI', '人工智能'] },
];

export function categorize(text) {
  const hits = [];
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => text.includes(w))) hits.push(rule.key);
  }
  return hits.length > 0 ? hits : ['其他'];
}

/** 源 1：东方财富 7×24 全球快讯（数量最大、时效最强）。 */
async function eastmoneyFlash(limit = 100) {
  const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_${limit}_1_.html`;
  const res = await fetch(url, { headers: UA });
  const text = await res.text();
  const data = parseMaybeJson(text);
  const list = data?.LivesList ?? [];
  return list.map((item) => ({
    id: `em-${item.newsid ?? item.id}`,
    title: item.title ?? item.simtitle ?? '',
    summary: (item.digest ?? item.simdigest ?? '').replace(/\s+/g, ' ').trim(),
    url: item.url_w ?? item.url_m ?? '',
    source: '东方财富·快讯',
    time: item.showtime ?? null,
    ts: item.showtime ? Date.parse(item.showtime.replace(/-/g, '/')) : Date.now(),
  }));
}

/** 源 2：新浪财经滚动新闻（带摘要与媒体来源）。 */
async function sinaRoll(limit = 50) {
  const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=155&lid=1686&num=${limit}&page=1`;
  const data = await fetchJson(url, { headers: UA });
  const list = data?.result?.data ?? [];
  return list.map((item) => ({
    id: `sina-${item.docid ?? item.oid ?? item.url}`,
    title: item.title ?? item.stitle ?? '',
    summary: (item.intro ?? item.summary ?? '').replace(/\s+/g, ' ').trim(),
    url: item.url ?? item.wapurl ?? '',
    source: item.media_name ? `新浪财经·${item.media_name}` : '新浪财经',
    time: item.ctime ? new Date(Number(item.ctime) * 1000).toISOString().slice(0, 19).replace('T', ' ') : null,
    ts: item.ctime ? Number(item.ctime) * 1000 : Date.now(),
  }));
}

/** 源 3：沪深公告（政策与公司层面的一手信息）。 */
async function eastmoneyAnnouncements(limit = 30) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=${limit}&page_index=1&ann_type=A&client_source=web`;
  const data = await fetchJson(url, { headers: UA });
  const list = data?.data?.list ?? [];
  return list.map((item) => {
    const codes = (item.codes ?? []).map((c) => `${c.short_name ?? ''}(${c.stock_code ?? ''})`).join('、');
    const kinds = (item.columns ?? []).map((c) => c.column_name).join('、');
    return {
      id: `ann-${item.art_code}`,
      title: `${codes ? codes + '：' : ''}${item.title ?? ''}`,
      summary: `公告类型：${kinds}`,
      url: `https://data.eastmoney.com/notices/detail/${item.codes?.[0]?.stock_code ?? ''}/${item.art_code}.html`,
      source: '沪深公告',
      time: item.display_time ? item.display_time.slice(0, 19) : null,
      ts: item.display_time ? Date.parse(item.display_time.replace(/-/g, '/').slice(0, 19)) : Date.now(),
    };
  });
}

/** 全部源，任何一个失败都不影响其余源。 */
export async function fetchNews({ limit = 60, sources = ['flash', 'sina', 'announcement'] } = {}) {
  return cache.wrap(`news:${sources.join(',')}`, async () => {
    const tasks = [];
    if (sources.includes('flash')) tasks.push(eastmoneyFlash(100));
    if (sources.includes('sina')) tasks.push(sinaRoll(50));
    if (sources.includes('announcement')) tasks.push(eastmoneyAnnouncements(30));

    const settled = await Promise.allSettled(tasks);
    const merged = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') merged.push(...result.value);
      else console.warn('[news] 源抓取失败：', result.reason?.message ?? result.reason);
    }

    const seen = new Set();
    const deduped = [];
    for (const item of merged.sort((a, b) => b.ts - a.ts)) {
      const key = item.title.slice(0, 24);
      if (!item.title || seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...item, categories: categorize(`${item.title} ${item.summary}`) });
    }
    return deduped.slice(0, limit);
  });
}

/** 只取政策/宏观相关，供"政策面"分析使用。 */
export async function fetchPolicyNews(limit = 20) {
  const all = await fetchNews({ limit: 200 });
  return all
    .filter((n) => n.categories.includes('政策') || n.categories.includes('宏观'))
    .slice(0, limit);
}

export function newsStats(items) {
  const byCategory = {};
  for (const item of items) {
    for (const cat of item.categories) byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }
  return { total: items.length, byCategory };
}
