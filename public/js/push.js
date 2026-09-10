/**
 * 每日推送页面
 *  左栏：报告列表（按日期分组 / 悬停删除 / 手动生成）
 *  右栏：报告详情（市场综述 / 逐只基金诊断 / 综合操作总结 / 结论 / 资讯依据 / 免责声明）
 * 生成走 SSE：POST /api/push/generate，实时展示采集进度与耗时。
 */
import {
  $,
  escapeHtml,
  fmtPct,
  pctClass,
  fmtNum,
  fmtTime,
  api,
  streamSSE,
  toast,
  mountShell,
  renderMarkdown,
} from './app.js';

/* ------------------------------- 状态 ------------------------------- */

let reports = []; // 报告列表（listReports 的返回结构）
let currentId = null; // 当前选中报告 id
let selectToken = 0; // 防止快速切换时的竞态渲染
let pollTimer = null; // 生成中报告的轮询刷新

let generating = false; // 是否正在生成
let genTicker = null; // 生成耗时计时器
let genStartAt = 0; // 生成本地开始时间
let genMessage = ''; // 服务端推送的阶段说明

const PERIODS = [
  ['7d', '近7日'],
  ['1m', '近1月'],
  ['3m', '近3月'],
  ['6m', '近6月'],
  ['1y', '近1年'],
];

const NEWS_CATS = ['政策', '宏观', '市场', '行业', '国际'];

/* ------------------------------ 渲染外壳 ------------------------------ */

const { content } = mountShell({
  active: 'push',
  title: '每日推送',
  subtitle: '资讯聚合 + 持仓诊断 + 趋势预测',
  actionsHtml: '<button class="btn btn-sm" id="btnRefreshList">↻ 刷新列表</button>',
});

content.innerHTML = `
  <div class="push-layout">
    <aside class="push-side">
      <div class="push-side-head">
        <button class="btn btn-primary" id="btnGenerate" style="width:100%">📋 手动生成报告</button>
        <div class="small faint mt-8" id="genHint">生成约需 1–3 分钟，请勿重复点击。</div>
      </div>
      <div class="push-side-scroll" id="reportList"></div>
    </aside>
    <section class="push-detail" id="reportDetail"></section>
  </div>`;

const listEl = $('#reportList');
const detailEl = $('#reportDetail');
const btnGenerate = $('#btnGenerate');
const genHint = $('#genHint');

/* ------------------------------ 小工具 ------------------------------ */

const isEmpty = (v) => v === null || v === undefined || v === '';

/** 建议 → badge 配色：减仓类绿色，加仓/持有类红色，其余默认。 */
function adviceClass(advice) {
  const a = String(advice ?? '');
  if (/减仓|短线止盈/.test(a)) return 'badge-down';
  if (/加仓|积极持有|定投布局/.test(a)) return 'badge-up';
  return '';
}

/** 置信度配色：>=70 主色，50-69 绿色，<50 橙色。 */
function confColor(value) {
  const n = Number(value);
  if (n >= 70) return 'var(--primary)';
  if (n >= 50) return 'var(--down)';
  return 'var(--warn)';
}

/** 置信度：数字 + 自绘进度条。 */
function confBar(value, mini = false) {
  const n = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  return `<span class="conf ${mini ? 'conf-end' : ''}">
      <span class="num">${n}%</span>
      <span class="bar ${mini ? 'bar-sm' : ''}">
        <span class="bar-in" style="width:${n}%;background:${confColor(n)}"></span>
      </span>
    </span>`;
}

/** 展望：方向 badge + 说明文字；无内容时返回空字符串。 */
function trendHtml(trend) {
  if (!trend || (isEmpty(trend.direction) && isEmpty(trend.note))) return '';
  const dir = String(trend.direction ?? '');
  const cls = /涨/.test(dir) ? 'badge-up' : /跌/.test(dir) ? 'badge-down' : 'badge-warn';
  const badge = dir ? `<span class="badge ${cls}">${escapeHtml(dir)}</span>` : '';
  const note = trend.note ? `<span class="muted">${escapeHtml(trend.note)}</span>` : '';
  return [badge, note].filter(Boolean).join(' ');
}

/** 两列信息表的一行。 */
const kvRow = (label, valueHtml) => `<tr><th>${label}</th><td>${valueHtml}</td></tr>`;

/** 阶段收益小字行。 */
function periodsHtml(periodReturns) {
  if (!periodReturns) return '';
  const items = PERIODS.filter(([key]) => !isEmpty(periodReturns[key])).map(
    ([key, label]) =>
      `<span class="faint">${label}</span> <span class="num ${pctClass(periodReturns[key])}">${fmtPct(
        periodReturns[key]
      )}</span>`
  );
  if (items.length === 0) return '';
  return `<div class="small period-line">${items.join('<span class="faint">·</span>')}</div>`;
}

/** 资讯分类统计：政策 X · 宏观 X · …… */
function newsStatsText(stats) {
  const byCat = stats?.byCategory;
  if (!byCat) return '';
  const parts = [];
  const seen = new Set();
  for (const cat of NEWS_CATS) {
    if (byCat[cat]) {
      parts.push(`${cat} ${byCat[cat]}`);
      seen.add(cat);
    }
  }
  for (const [cat, count] of Object.entries(byCat)) {
    if (!seen.has(cat)) parts.push(`${cat} ${count}`);
  }
  return parts.join(' · ');
}

/* ------------------------------ 左栏：列表 ------------------------------ */

/** 状态图标：完成 ✓ / 生成中 spinner / 失败 ✗ */
function statusIcon(status) {
  if (status === 'complete') return '<span class="st-icon st-ok">✓</span>';
  if (status === 'failed') return '<span class="st-icon st-bad">✗</span>';
  return '<span class="st-icon"><span class="spin-blue"></span></span>';
}

const TRIGGER_LABEL = { manual: '手动生成', schedule: '定时生成' };

function renderList() {
  if (reports.length === 0) {
    listEl.innerHTML = `
      <div class="empty">
        <span class="empty-icon">📭</span>
        还没有报告，点击上方按钮生成第一份日报
      </div>`;
    return;
  }

  // 按日期分组：列表已按 createdAt 倒序，顺序遍历即可保证日期倒序
  const groups = [];
  for (const r of reports) {
    const key = r.date ?? '未知日期';
    let group = groups[groups.length - 1];
    if (!group || group.date !== key) {
      group = { date: key, items: [] };
      groups.push(group);
    }
    group.items.push(r);
  }

  listEl.innerHTML = groups
    .map(
      (group) => `
      <div class="push-group-hd small faint">${escapeHtml(group.date)}</div>
      ${group.items.map(itemHtml).join('')}`
    )
    .join('');
}

function itemHtml(r) {
  const summary = r.conclusion ? r.conclusion.slice(0, 50) : '';
  const summaryText = summary ? escapeHtml(summary) + (r.conclusion.length > 50 ? '…' : '') : '（无结论摘要）';
  const trigger = TRIGGER_LABEL[r.triggeredBy] ?? escapeHtml(r.triggeredBy ?? '—');

  return `
    <div class="push-item ${r.id === currentId ? 'active' : ''}" data-id="${escapeHtml(r.id)}">
      <button class="push-del" data-del="${escapeHtml(r.id)}" title="删除该报告">🗑</button>
      <div class="row" style="align-items:flex-start;gap:8px">
        ${statusIcon(r.status)}
        <div style="flex:1;min-width:0">
          <div class="push-item-title">${escapeHtml(r.date)} 基金投资日报（${escapeHtml(r.slot)}）</div>
          <div class="small faint push-item-sum">${summaryText}</div>
          <div class="small faint push-item-meta">
            <span>${escapeHtml(fmtTime(r.createdAt))}</span>
            <span>·</span>
            <span>${trigger}</span>
          </div>
        </div>
      </div>
    </div>`;
}

/* ------------------------------ 右栏：详情 ------------------------------ */

const DETAIL_EMPTY = `
  <div class="detail-center">
    <span class="empty-icon">📄</span>
    <div class="muted">请从左侧选择一份报告查看详情</div>
  </div>`;

function renderDetail(report) {
  if (!report) {
    detailEl.innerHTML = DETAIL_EMPTY;
    return;
  }
  if (report.status === 'generating') {
    detailEl.innerHTML = `
      <div class="detail-center">
        <span class="spinner spinner-lg"></span>
        <div class="muted mt-16">正在生成报告…</div>
        <div class="small faint mt-8">报告通常需要 1–3 分钟，生成完成后自动刷新。</div>
      </div>`;
    return;
  }
  if (report.status === 'failed') {
    detailEl.innerHTML = `
      <div class="stack">
        <div class="card">
          <div class="card-head">
            <div class="card-title">报告生成失败</div>
            <span class="badge badge-warn">${escapeHtml(report.date ?? '')} ${escapeHtml(report.slot ?? '')}</span>
          </div>
          <div class="muted">${escapeHtml(report.error || '未知错误')}</div>
          <div class="row mt-16">
            <button class="btn btn-primary" id="btnRegen">↻ 重新生成</button>
          </div>
        </div>
      </div>`;
    return;
  }

  detailEl.innerHTML = renderComplete(report);
}

/** 完整报告的渲染（重点还原信息层次）。 */
function renderComplete(r) {
  const parts = [];

  /* 1) 市场综述 */
  parts.push(`
    <div class="card">
      <div class="card-head">
        <div class="card-title">市场综述</div>
        ${
          r.positionAdvice
            ? `<span class="badge badge-primary">建议仓位 ${escapeHtml(r.positionAdvice)}</span>`
            : ''
        }
      </div>
      <div class="md">${renderMarkdown(r.marketSummary || '（暂无市场综述）')}</div>
    </div>`);

  /* 2) 逐只基金诊断 */
  const funds = Array.isArray(r.funds) ? r.funds : [];
  parts.push('<div class="sec-title">逐只基金诊断</div>');
  if (funds.length === 0) {
    parts.push('<div class="card faint">本次报告未包含基金诊断数据。</div>');
  } else {
    parts.push(`<div class="stack">${funds.map(fundCard).join('')}</div>`);
  }

  /* 3) 综合操作总结 */
  const tableRows =
    Array.isArray(r.summaryTable) && r.summaryTable.length > 0
      ? r.summaryTable
      : funds.map((f) => ({ code: f.code, name: f.name, advice: f.advice, confidence: f.confidence }));
  if (tableRows.length > 0) {
    parts.push(`
      <div class="card">
        <div class="card-head"><div class="card-title">综合操作总结</div></div>
        <table class="table">
          <thead>
            <tr>
              <th>基金代码</th>
              <th>基金名称</th>
              <th>操作建议</th>
              <th class="num">置信度</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows
              .map(
                (row) => `
              <tr>
                <td class="mono">${escapeHtml(row.code ?? '—')}</td>
                <td>${escapeHtml(row.name ?? '—')}</td>
                <td><span class="badge ${adviceClass(row.advice)}">${escapeHtml(row.advice ?? '—')}</span></td>
                <td class="num">${isEmpty(row.confidence) ? '—' : confBar(row.confidence, true)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`);
  }

  /* 4) 结论 */
  if (r.conclusion) {
    parts.push(`
      <div class="card card-conclusion">
        <div class="card-head"><div class="card-title">结论</div></div>
        <div class="md">${renderMarkdown(r.conclusion)}</div>
      </div>`);
  }

  /* 5) 资讯依据（可折叠） */
  const news = Array.isArray(r.news) ? r.news : [];
  const statsText = newsStatsText(r.newsStats);
  parts.push(`
    <div class="card">
      <div class="card-head">
        <div class="row wrap" style="gap:8px;align-items:baseline">
          <div class="card-title">资讯依据（${news.length} 条）</div>
          ${statsText ? `<span class="small faint">${escapeHtml(statsText)}</span>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm" id="newsToggle">收起 ▾</button>
      </div>
      <div id="newsBody">
        ${news.length === 0 ? '<div class="faint small">本次报告未附带资讯。</div>' : news.map(newsItem).join('')}
      </div>
    </div>`);

  /* 6) 免责声明 */
  if (r.disclaimer) {
    parts.push(`<div class="small faint">${escapeHtml(r.disclaimer)}</div>`);
  }

  return `<div class="stack">${parts.join('')}</div>`;
}

/** 单只基金诊断卡片。 */
function fundCard(f) {
  const rows = [];

  if (!isEmpty(f.advice)) {
    rows.push(kvRow('操作建议', `<span class="badge ${adviceClass(f.advice)}">${escapeHtml(f.advice)}</span>`));
  }
  if (!isEmpty(f.confidence)) rows.push(kvRow('置信度', confBar(f.confidence)));
  if (!isEmpty(f.reason)) rows.push(kvRow('理由', escapeHtml(f.reason)));
  if (!isEmpty(f.recentTrend)) rows.push(kvRow('近期走势', escapeHtml(f.recentTrend)));

  const shortTerm = trendHtml(f.shortTerm);
  if (shortTerm) rows.push(kvRow('短期展望', shortTerm));
  const longTerm = trendHtml(f.longTerm);
  if (longTerm) rows.push(kvRow('中长期展望', longTerm));

  const navLine = `最新净值 ${fmtNum(f.nav, 4)}（${escapeHtml(f.navDate || '—')}）
      <span class="num ${pctClass(f.changePct)}">当日 ${fmtPct(f.changePct)}</span>`;

  return `
    <div class="card">
      <div class="card-head" style="align-items:flex-start">
        <div style="min-width:0">
          <div class="card-title">${escapeHtml(f.code ?? '—')} · ${escapeHtml(f.name ?? '—')}</div>
          <div class="small faint">${navLine}</div>
        </div>
        ${isEmpty(f.theme) ? '' : `<span class="badge">${escapeHtml(f.theme)}</span>`}
      </div>
      ${rows.length > 0 ? `<table class="kv"><tbody>${rows.join('')}</tbody></table>` : ''}
      ${periodsHtml(f.periodReturns)}
    </div>`;
}

/** 单条资讯。 */
function newsItem(n) {
  const cats = Array.isArray(n.categories) ? n.categories : [];
  const catHtml = cats.map((c) => `<span class="badge">${escapeHtml(c)}</span>`).join('');
  const titleHtml = escapeHtml(n.title ?? '（无标题）');
  const safeUrl = /^https?:\/\//i.test(String(n.url ?? '')) ? escapeHtml(n.url) : '';
  const link = safeUrl
    ? `<a class="news-title" href="${safeUrl}" target="_blank" rel="noopener">${titleHtml}</a>`
    : `<span class="news-title">${titleHtml}</span>`;
  const meta = [n.time, n.source].filter(Boolean).map(escapeHtml).join(' · ');

  return `
    <div class="news-item">
      <div class="news-line">
        ${catHtml ? `<span class="news-cats">${catHtml}</span>` : ''}
        ${link}
      </div>
      ${meta ? `<div class="small faint news-meta">${meta}</div>` : ''}
    </div>`;
}

/* ------------------------------ 数据加载 ------------------------------ */

/** 拉取列表并渲染，返回列表数据。 */
async function refreshList() {
  try {
    const list = await api('/api/push/reports');
    reports = Array.isArray(list) ? list : [];
  } catch (error) {
    reports = [];
    toast(`加载报告列表失败：${error.message}`, 'error');
  }
  renderList();
  return reports;
}

/** 选中某份报告并加载详情。 */
async function selectReport(id) {
  currentId = id;
  renderList();

  const token = (selectToken += 1);
  detailEl.innerHTML = `
    <div class="detail-center">
      <span class="spinner spinner-lg"></span>
      <div class="muted mt-16">加载中…</div>
    </div>`;

  try {
    const report = await api(`/api/push/reports/${encodeURIComponent(id)}`);
    if (token !== selectToken) return; // 已经有更新的选择，丢弃本次结果
    renderDetail(report);
  } catch (error) {
    if (token !== selectToken) return;
    detailEl.innerHTML = `
      <div class="detail-center">
        <span class="empty-icon">⚠️</span>
        <div class="muted">${escapeHtml(error.message)}</div>
      </div>`;
  }
}

/** 报告仍在生成时（例如定时任务发起），轮询刷新直到出结果。 */
function schedulePoll() {
  clearTimeout(pollTimer);
  if (generating || !reports.some((r) => r.status === 'generating')) return;
  pollTimer = setTimeout(async () => {
    const before = reports.find((r) => r.id === currentId)?.status;
    await refreshList();
    const after = reports.find((r) => r.id === currentId)?.status;
    if (currentId && before !== after) await selectReport(currentId);
    else schedulePoll();
  }, 5000);
}

/* ------------------------------ 手动生成 ------------------------------ */

const elapsedSec = () => Math.max(0, Math.round((Date.now() - genStartAt) / 1000));

function setHint(html) {
  genHint.className = 'small faint mt-8';
  genHint.innerHTML = html;
}

function startTicker(message) {
  genMessage = message || '正在采集数据…';
  genStartAt = Date.now();
  clearInterval(genTicker);
  const tick = () => {
    const s = elapsedSec();
    // 超过 20 秒补充说明，避免用户以为卡死
    const extra = s >= 20 ? '模型正在分析，通常需要 1–3 分钟' : '正在采集数据…';
    setHint(`<span class="spin-blue" style="vertical-align:middle;margin-right:5px"></span>已用时 ${s} 秒 · ${escapeHtml(
      genMessage
    )}（${extra}）`);
  };
  tick();
  genTicker = setInterval(tick, 1000);
}

function stopTicker() {
  clearInterval(genTicker);
  genTicker = null;
}

/** 生成期间禁用按钮并显示 spinner，防重复点击。 */
function lockButton() {
  btnGenerate.disabled = true;
  btnGenerate.innerHTML = '<span class="spinner"></span> 正在采集数据…';
}

function unlockButton(label) {
  btnGenerate.disabled = false;
  btnGenerate.textContent = label;
}

async function startGenerate() {
  if (generating) return;
  generating = true;
  lockButton();
  startTicker('正在采集数据…');

  let finishedId = null;
  let failed = false;

  try {
    await streamSSE(
      '/api/push/generate',
      {},
      {
        // 进度事件：collecting / done / failed
        progress: (p) => {
          const stage = p?.stage;
          if (stage === 'collecting') {
            startTicker(p?.message || '正在采集数据…');
            btnGenerate.innerHTML = '<span class="spinner"></span> 正在采集数据…';
          } else if (stage === 'done') {
            stopTicker();
            btnGenerate.innerHTML = '✓ 生成完成';
            setHint(`报告生成完成，用时 ${elapsedSec()} 秒。`);
          } else if (stage === 'failed') {
            failed = true;
            stopTicker();
            toast(p?.message || '报告生成失败', 'error');
            setHint(escapeHtml(p?.message || '报告生成失败'));
          }
        },
        // 生成结束：拿到报告 id
        report: (r) => {
          finishedId = r?.id ?? null;
          if (r?.status === 'failed') failed = true;
        },
        error: (e) => {
          failed = true;
          stopTicker();
          toast(e?.message || '生成失败', 'error');
        },
      }
    );
  } catch (error) {
    failed = true;
    stopTicker();
    toast(`生成请求失败：${error.message}`, 'error');
  } finally {
    generating = false;
    stopTicker();
  }

  await refreshList();
  if (finishedId) await selectReport(finishedId);
  schedulePoll();

  if (failed) {
    unlockButton('📋 手动生成报告');
    if (!genHint.innerHTML) setHint('生成失败，可稍后重试。');
    return;
  }

  // 保留「生成完成」的状态一会儿，再恢复按钮文案
  setTimeout(() => {
    unlockButton('📋 手动生成报告');
    setHint('生成约需 1–3 分钟，请勿重复点击。');
  }, 1600);
  if (!genHint.textContent) setHint(`报告生成完成，用时 ${elapsedSec()} 秒。`);
}

/* ------------------------------ 事件绑定 ------------------------------ */

// 左栏：选中 / 悬停删除（事件委托）
listEl.addEventListener('click', async (event) => {
  const delBtn = event.target.closest('.push-del');
  if (delBtn) {
    event.stopPropagation();
    const id = delBtn.dataset.del;
    if (!window.confirm('确定删除这份报告？')) return;
    try {
      await api(`/api/push/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('报告已删除');
      if (currentId === id) {
        currentId = null;
        detailEl.innerHTML = DETAIL_EMPTY;
      }
      await refreshList();
      schedulePoll();
    } catch (error) {
      toast(`删除失败：${error.message}`, 'error');
    }
    return;
  }

  const item = event.target.closest('.push-item');
  if (item) await selectReport(item.dataset.id);
});

// 右栏：重新生成 / 资讯折叠（事件委托，详情每次重渲染都能生效）
detailEl.addEventListener('click', (event) => {
  if (event.target.closest('#btnRegen')) {
    startGenerate();
    return;
  }

  const toggle = event.target.closest('#newsToggle');
  if (toggle) {
    const body = $('#newsBody');
    if (!body) return;
    const collapsed = body.classList.toggle('hidden');
    toggle.textContent = collapsed ? '展开 ▾' : '收起 ▾';
  }
});

btnGenerate.addEventListener('click', startGenerate);

$('#btnRefreshList')?.addEventListener('click', async () => {
  await refreshList();
  if (currentId) await selectReport(currentId);
  toast('列表已刷新');
});

/* ------------------------------ 初始化 ------------------------------ */

(async function init() {
  detailEl.innerHTML = DETAIL_EMPTY;
  await refreshList();
  if (reports.length > 0) await selectReport(reports[0].id); // 默认选中最新一份
  schedulePoll();
})();
