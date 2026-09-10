/**
 * 工具注册表：以 OpenAI Function Calling 的 JSON Schema 形式暴露给模型，
 * 由 Agent 循环负责调度执行。新增能力只需在此注册。
 */
import { getHistory, getQuotes, getRanking, searchFunds, sliceSeries, RANGES } from './funds.js';
import { kbContext, search as kbSearch } from './kb.js';
import { fetchNews } from './news.js';

/* ------------------------- 安全表达式求值 ------------------------- */
function evaluateExpression(input) {
  const src = String(input).replace(/[，,]/g, '');
  if (!/^[\d+\-*/%^().\s]+$/.test(src)) throw new Error('表达式仅支持数字与 + - * / % ^ ( )');
  let pos = 0;
  const peek = () => src[pos];
  const skip = () => {
    while (/\s/.test(src[pos] ?? '')) pos += 1;
  };
  function parseExpr() {
    let value = parseTerm();
    skip();
    while (peek() === '+' || peek() === '-') {
      const op = src[pos++];
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
      skip();
    }
    return value;
  }
  function parseTerm() {
    let value = parsePower();
    skip();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[pos++];
      const rhs = parsePower();
      if ((op === '/' || op === '%') && rhs === 0) throw new Error('除数不能为 0');
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
      skip();
    }
    return value;
  }
  function parsePower() {
    const base = parseUnary();
    skip();
    if (peek() === '^') {
      pos += 1;
      return base ** parsePower();
    }
    return base;
  }
  function parseUnary() {
    skip();
    if (peek() === '-') {
      pos += 1;
      return -parseUnary();
    }
    if (peek() === '+') {
      pos += 1;
      return parseUnary();
    }
    return parseAtom();
  }
  function parseAtom() {
    skip();
    if (peek() === '(') {
      pos += 1;
      const value = parseExpr();
      skip();
      if (peek() !== ')') throw new Error('括号不匹配');
      pos += 1;
      return value;
    }
    const match = src.slice(pos).match(/^\d+(\.\d+)?/);
    if (!match) throw new Error('表达式格式错误');
    pos += match[0].length;
    return Number(match[0]);
  }
  const result = parseExpr();
  skip();
  if (pos !== src.length) throw new Error('表达式存在多余字符');
  return result;
}

/* ------------------------------ 工具定义 ------------------------------ */
export const TOOLS = [
  {
    name: 'search_fund',
    description: '按基金代码或名称关键字搜索基金，返回代码、名称、类型。用于把用户口语化的基金名转成 6 位代码。',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '基金代码或名称关键字，如 "白酒"、"000001"' } },
      required: ['keyword'],
    },
    async handler({ keyword }) {
      return await searchFunds(keyword);
    },
  },
  {
    name: 'get_fund_quote',
    description: '获取一只或多只基金的实时行情：最新单位净值、累计净值、日涨跌幅(%)、盘中估值与估值涨跌幅(%)。',
    parameters: {
      type: 'object',
      properties: {
        codes: { type: 'array', items: { type: 'string' }, description: '6 位基金代码数组，如 ["000001","110022"]' },
      },
      required: ['codes'],
    },
    async handler({ codes }) {
      return await getQuotes(codes.slice(0, 20));
    },
  },
  {
    name: 'get_fund_history',
    description:
      '获取基金历史净值序列与阶段涨幅。range 可选 7d/1m/3m/6m/1y/3y，返回区间涨跌幅(%)、区间起止日期，以及抽样后的净值点（用于画图或判断趋势）。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '6 位基金代码' },
        range: { type: 'string', enum: Object.keys(RANGES), description: '统计区间，默认 3m' },
      },
      required: ['code'],
    },
    async handler({ code, range = '3m' }) {
      const history = await getHistory(code);
      const sliced = sliceSeries(history.points, range);
      const points = sliced.points;
      // 抽样到至多 60 个点，避免把整条序列塞进上下文
      const step = Math.max(1, Math.ceil(points.length / 60));
      return {
        code,
        name: history.name,
        range: sliced.label,
        changePct: sliced.changePct,
        start: sliced.start,
        end: sliced.end,
        latestNav: points.at(-1)?.nav ?? null,
        periodReturns: history.periodReturns,
        points: points.filter((_, i) => i % step === 0).map((p) => ({ date: p.date, nav: p.nav })),
      };
    },
  },
  {
    name: 'get_fund_detail',
    description: '获取基金详情：全称、类型、成立日、规模、基金经理、基金公司、风险等级、投资目标与策略。',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: '6 位基金代码' } },
      required: ['code'],
    },
    async handler({ code }) {
      const { provider } = await import('../providers/index.js').then((m) => m.getProvider());
      return await provider.detail(code);
    },
  },
  {
    name: 'get_fund_ranking',
    description: '获取基金涨幅榜或跌幅榜，返回代码、名称、最新净值、日涨跌幅与近 1 周/1 月/3 月/6 月/1 年涨幅。',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'up=涨幅榜，down=跌幅榜' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 50' },
      },
      required: ['direction'],
    },
    async handler({ direction, limit = 10 }) {
      return await getRanking(direction, Math.min(Math.max(limit, 1), 50));
    },
  },
  {
    name: 'get_financial_news',
    description: '获取最新财经快讯、市场新闻与政策公告，用于判断市场情绪与宏观环境。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 15' },
        keyword: { type: 'string', description: '可选，按关键字过滤，如 "降准"、"美联储"' },
      },
      required: [],
    },
    async handler({ limit = 15, keyword }) {
      const news = await fetchNews({ limit: Math.min(limit * 3, 90) });
      const filtered = keyword
        ? news.filter((n) => `${n.title} ${n.summary}`.includes(keyword))
        : news;
      return filtered.slice(0, limit).map((n) => ({
        title: n.title,
        time: n.time,
        source: n.source,
        summary: (n.summary ?? '').slice(0, 160),
      }));
    },
  },
  {
    name: 'search_knowledge',
    description: '在本地知识库中检索资料（已导入的研究报告、政策文件、笔记等），返回相关片段与来源。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问题或关键词' },
        limit: { type: 'number', description: '返回片段数，默认 4' },
      },
      required: ['query'],
    },
    async handler({ query, limit = 4 }) {
      const { hits } = kbContext(query, limit);
      const list = hits.length > 0 ? hits : kbSearch(query, limit);
      return list.map((h) => ({ title: h.title, source: h.source, score: h.score, text: h.text.slice(0, 400) }));
    },
  },
  {
    name: 'calculate',
    description: '安全地计算数学表达式，支持 + - * / % ^ 与括号。用于收益率、复利、仓位等计算。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '如 "(1.262-1.245)/1.245*100"' } },
      required: ['expression'],
    },
    async handler({ expression }) {
      return { expression, result: evaluateExpression(expression) };
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** 转成 DeepSeek/OpenAI 的 tools 参数格式。 */
export function toolSchemas(enabled = null) {
  const list = enabled ? TOOLS.filter((t) => enabled.includes(t.name)) : TOOLS;
  return list.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function listTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description }));
}

/** 执行一次工具调用，异常转为结构化结果回传给模型。 */
export async function runTool(name, args) {
  const tool = byName.get(name);
  if (!tool) return { ok: false, error: `未知工具 ${name}` };
  const started = Date.now();
  try {
    const result = await tool.handler(args ?? {});
    return { ok: true, result, elapsedMs: Date.now() - started };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), elapsedMs: Date.now() - started };
  }
}
