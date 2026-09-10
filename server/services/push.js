/**
 * 每日推送：聚合资讯 + 实时行情 → 由 LLM 产出结构化投资建议与趋势预测。
 *
 * 产出结构与产品形态对应：
 *   - 每只基金：最新净值、近期走势、操作建议、置信度、理由
 *   - 综合操作总结表 + 市场结论 + 免责声明
 */
import { config } from '../config.js';
import { Collection, newId } from '../lib/store.js';
import { fetchNews, newsStats } from './news.js';
import { getHistory, getQuotes, getWatchlist, sliceSeries } from './funds.js';
import { complete, parseJsonLoose } from './llm.js';

const reportCol = new Collection('reports');

const DISCLAIMER =
  '以上分析由 AI 基于公开数据自动生成，仅供参考，不构成投资建议。基金投资有风险，入市需谨慎，历史净值不代表未来表现。';

/** 汇总每只基金的多周期表现，供模型分析。 */
async function collectFundSnapshot() {
  const watchlist = await getWatchlist();
  const codes = watchlist.map((w) => w.code);
  const themeOf = new Map(watchlist.map((w) => [w.code, w.theme]));
  const quotes = await getQuotes(codes);

  const rows = await Promise.all(
    quotes.map(async (q) => {
      let periods = null;
      let recent = null;
      try {
        const history = await getHistory(q.code);
        periods = {
          '7d': sliceSeries(history.points, '7d').changePct,
          '1m': sliceSeries(history.points, '1m').changePct,
          '3m': sliceSeries(history.points, '3m').changePct,
          '6m': sliceSeries(history.points, '6m').changePct,
          '1y': sliceSeries(history.points, '1y').changePct,
        };
        const tail = history.points.slice(-10);
        recent = tail.map((p) => `${p.date}:${p.nav}`).join(' ');
      } catch {
        /* 单只基金历史缺失不影响整体报告 */
      }
      return {
        code: q.code,
        name: q.name,
        theme: themeOf.get(q.code) ?? '自选',
        navDate: q.navDate,
        nav: q.nav,
        accNav: q.accNav,
        changePct: q.changePct,
        estChangePct: q.estChangePct,
        periodReturns: periods,
        last10: recent,
      };
    })
  );
  return rows;
}

/** 分析 Prompt：要求返回严格 JSON。 */
function buildPrompt({ funds, news }) {
  const newsLines = news
    .slice(0, 24)
    .map((n, i) => `${i + 1}. [${n.categories.join('/')}] ${n.time ?? ''} ${n.title}${n.summary ? ` —— ${n.summary.slice(0, 90)}` : ''}`)
    .join('\n');

  const fundLines = funds
    .map(
      (f) =>
        `- ${f.code} ${f.name}（${f.theme}）| 净值 ${f.nav ?? '—'} (${f.navDate ?? '—'}) | ` +
        `当日 ${f.changePct ?? '—'}% | 盘中估值 ${f.estChangePct ?? '—'}% | ` +
        `近7日 ${f.periodReturns?.['7d'] ?? '—'}% 近1月 ${f.periodReturns?.['1m'] ?? '—'}% ` +
        `近3月 ${f.periodReturns?.['3m'] ?? '—'}% 近6月 ${f.periodReturns?.['6m'] ?? '—'}% 近1年 ${f.periodReturns?.['1y'] ?? '—'}%\n` +
        `  最近10个交易日净值：${f.last10 ?? '—'}`
    )
    .join('\n');

  return `你是一名严谨的公募基金研究员。请基于下面的真实数据，输出一份中文投研日报。

## 最新财经资讯（按时间倒序）
${newsLines || '（暂无）'}

## 自选基金实时行情与阶段表现
${fundLines || '（暂无）'}

## 输出要求
只输出一个 JSON 对象（不要任何额外文字、不要 markdown 代码块），结构如下：

{
  "marketSummary": "120-200字的市场综述，结合上面的资讯说明当前宏观与市场环境",
  "funds": [
    {
      "code": "基金代码",
      "name": "基金名称",
      "nav": 数字或null,
      "changePct": 数字或null,
      "recentTrend": "30-60字，描述该基金近期净值走势特征",
      "advice": "从以下之一选择：积极持有 / 持有不动 / 维持标配 / 小幅加仓 / 定投布局 / 减仓 / 短线止盈 / 观望 / 谨慎减仓",
      "confidence": 0到100的整数，表示该建议的置信度,
      "reason": "60-120字，说明给出该建议的数据依据与逻辑",
      "shortTerm": {"direction": "上涨/震荡/下跌", "note": "20-40字的1-4周短期展望"},
      "longTerm": {"direction": "上涨/震荡/下跌", "note": "20-40字的3-12月中长期展望"}
    }
  ],
  "conclusion": "80-150字的综合操作结论，说明整体策略取向与仓位建议",
  "positionAdvice": "建议的整体权益仓位区间，如 50%-60%"
}

硬性约束：
- funds 数组必须覆盖我给出的每一只基金，数量与顺序保持一致。
- confidence 必须是根据数据强弱给出的真实判断，不要所有基金都给接近的数值。
- 不得编造数据；数据缺失时如实说明"数据不足"。
- 观点要有区分度，避免套话。`;
}

/** 生成一份报告。 */
export async function generateReport({ triggeredBy = 'manual' } = {}) {
  const started = Date.now();
  const id = newId('report');
  const now = new Date();

  const report = {
    id,
    date: now.toISOString().slice(0, 10),
    slot: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    createdAt: now.toISOString(),
    status: 'generating',
    triggeredBy,
    model: config.deepseek.analystModel,
  };
  reportCol.insert(report);

  try {
    const [funds, news] = await Promise.all([collectFundSnapshot(), fetchNews({ limit: 80 })]);
    const prompt = buildPrompt({ funds, news });
    const raw = await complete(prompt, { model: config.deepseek.analystModel, jsonMode: true });
    const parsed = parseJsonLoose(raw);

    if (!parsed) throw new Error('模型未能返回可解析的 JSON');

    // 用真实行情回填行情字段，避免模型在数值上出现偏差
    const byCode = new Map(funds.map((f) => [f.code, f]));
    const analyzed = (parsed.funds ?? []).map((item) => {
      const real = byCode.get(item.code);
      return {
        code: item.code,
        name: item.name ?? real?.name ?? item.code,
        theme: real?.theme ?? '自选',
        nav: real?.nav ?? item.nav ?? null,
        navDate: real?.navDate ?? null,
        changePct: real?.changePct ?? null,
        periodReturns: real?.periodReturns ?? null,
        recentTrend: item.recentTrend ?? '',
        advice: item.advice ?? '观望',
        confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
        reason: item.reason ?? '',
        shortTerm: item.shortTerm ?? null,
        longTerm: item.longTerm ?? null,
      };
    });

    // 模型漏掉的基金补齐为"数据不足"，保证覆盖完整
    for (const fund of funds) {
      if (!analyzed.some((a) => a.code === fund.code)) {
        analyzed.push({
          code: fund.code,
          name: fund.name,
          theme: fund.theme,
          nav: fund.nav,
          navDate: fund.navDate,
          changePct: fund.changePct,
          periodReturns: fund.periodReturns,
          recentTrend: '数据不足',
          advice: '暂不操作',
          confidence: null,
          reason: '模型未覆盖该基金，请人工核对。',
          shortTerm: null,
          longTerm: null,
        });
      }
    }

    const updated = reportCol.update(id, {
      status: 'complete',
      marketSummary: parsed.marketSummary ?? '',
      conclusion: parsed.conclusion ?? '',
      positionAdvice: parsed.positionAdvice ?? null,
      funds: analyzed,
      summaryTable: analyzed.map((f) => ({
        code: f.code,
        name: f.name,
        advice: f.advice,
        confidence: f.confidence,
      })),
      news: news.slice(0, 20).map((n) => ({
        title: n.title,
        time: n.time,
        source: n.source,
        url: n.url,
        categories: n.categories,
      })),
      newsStats: newsStats(news),
      disclaimer: DISCLAIMER,
      elapsedMs: Date.now() - started,
    });
    return updated;
  } catch (error) {
    const failed = reportCol.update(id, {
      status: 'failed',
      error: String(error?.message ?? error),
      elapsedMs: Date.now() - started,
    });
    return failed;
  }
}

export function listReports() {
  return reportCol
    .all()
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((r) => ({
      id: r.id,
      date: r.date,
      slot: r.slot,
      status: r.status,
      createdAt: r.createdAt,
      triggeredBy: r.triggeredBy,
      conclusion: r.conclusion ? r.conclusion.slice(0, 60) : '',
      error: r.error ?? null,
    }));
}

export function getReport(id) {
  return reportCol.find((r) => r.id === id);
}

export function removeReport(id) {
  return reportCol.remove(id);
}

/* ---------------------------- 定时任务 ---------------------------- */

let timer;

/** 解析 "分 时 * * 周" 形式的极简 cron（仅支持本项目的默认表达式）。 */
function matchesCron(expr, date) {
  const [min, hour, , , dow] = expr.trim().split(/\s+/);
  const ok = (field, value) => {
    if (field === '*') return true;
    return field.split(',').some((part) => {
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        return value >= a && value <= b;
      }
      return Number(part) === value;
    });
  };
  return ok(min, date.getMinutes()) && ok(hour, date.getHours()) && ok(dow, date.getDay());
}

/** 启动定时生成（每分钟检查一次，同一分钟内只跑一次）。 */
export function startScheduler() {
  if (timer) return;
  let lastRunKey = null;
  timer = setInterval(async () => {
    const now = new Date();
    const key = `${now.toISOString().slice(0, 16)}`;
    if (key === lastRunKey) return;
    if (!matchesCron(config.pushCron, now)) return;
    lastRunKey = key;
    console.log('[push] 定时生成日报…', now.toLocaleString('zh-CN'));
    const report = await generateReport({ triggeredBy: 'schedule' });
    console.log('[push] 日报生成结束：', report.status);
  }, 60_000);
  timer.unref?.();
  console.log(`[push] 定时任务已启动，cron="${config.pushCron}"`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
