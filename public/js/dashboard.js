/* 行情看板：自选基金实时行情 + 净值走势图 + 涨跌幅榜 */
import {
  $, $$, api, escapeHtml, fmtNum, fmtPct, fmtTime, mountShell,
  pctClass, renderStatus, toast,
} from './app.js';

const RANGES = [
  ['7d', '7天'], ['1m', '1月'], ['3m', '3月'],
  ['6m', '6月'], ['1y', '1年'], ['3y', '3年'],
];

const state = {
  data: null,
  theme: '全部',
  selected: null,      // 当前选中的基金代码
  range: '1m',
  series: null,
  chartPoints: [],
};

const { content } = mountShell({
  active: 'dashboard',
  title: '基金行情看板',
  subtitle: '数据源：天天基金（东方财富）· 实时净值与盘中估值',
  actionsHtml: `
    <button class="btn btn-sm" id="btnRefresh">↻ 刷新</button>
    <button class="btn btn-sm btn-primary" id="btnAdd">+ 添加基金</button>`,
});

content.innerHTML = `
  <div class="chips" id="chips"></div>
  <div class="dash">
    <div class="dash-left">
      <div class="fund-grid" id="fundGrid"></div>
      <div class="card chart-card" id="chartCard">
        <div class="chart-head">
          <div>
            <div class="chart-title" id="chartTitle">净值走势</div>
            <div class="chart-sub" id="chartSub">选择上方基金查看走势</div>
          </div>
          <div class="ranges" id="ranges"></div>
        </div>
        <div class="chart-stats" id="chartStats"></div>
        <div id="chartHost" style="position:relative"></div>
      </div>
    </div>
    <div class="dash-right">
      <div class="card">
        <div class="card-head"><div class="card-title up">📈 涨幅榜 Top 5</div></div>
        <div class="rank-list" id="gainers"></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title down">📉 跌幅榜 Top 5</div></div>
        <div class="rank-list" id="losers"></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">数据源状态</div></div>
        <div id="sourceBox" class="small muted">加载中…</div>
      </div>
    </div>
  </div>`;

/* ============================ 数据加载 ============================ */

async function loadDashboard() {
  const grid = $('#fundGrid');
  if (!state.data) {
    grid.innerHTML = Array.from({ length: 4 })
      .map(() => '<div class="skeleton" style="height:104px"></div>')
      .join('');
  }
  state.data = await api('/api/funds/dashboard');
  if (!state.selected && state.data.funds.length > 0) {
    state.selected = state.data.funds[0].code;
  }
  renderChips();
  renderFunds();
  renderRanks();
}

async function loadSeries(code, range) {
  const host = $('#chartHost');
  host.innerHTML = '<div class="skeleton" style="height:260px;margin-top:10px"></div>';
  try {
    state.series = await api(`/api/funds/${code}/series?range=${range}`);
    renderChart();
  } catch (error) {
    host.innerHTML = `<div class="empty"><span class="empty-icon">⚠️</span>${escapeHtml(error.message)}</div>`;
  }
}

/* ============================ 渲染：分类 ============================ */

function renderChips() {
  const { funds, themes } = state.data;
  const counts = {};
  for (const f of funds) counts[f.theme] = (counts[f.theme] ?? 0) + 1;

  $('#chips').innerHTML = themes
    .map((theme) => {
      const count = theme === '全部' ? funds.length : counts[theme] ?? 0;
      return `<button class="chip ${state.theme === theme ? 'active' : ''}" data-theme="${escapeHtml(theme)}">
        ${escapeHtml(theme)}<span class="count">${count}</span></button>`;
    })
    .join('');
}

/* ============================ 渲染：基金卡 ============================ */

function renderFunds() {
  const funds = state.data.funds.filter(
    (f) => state.theme === '全部' || f.theme === state.theme
  );
  const grid = $('#fundGrid');

  if (funds.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <span class="empty-icon">📭</span>该分类下暂无基金</div>`;
    return;
  }

  grid.innerHTML = funds
    .map((f) => {
      const cls = pctClass(f.livePct);
      return `<div class="fund-card ${state.selected === f.code ? 'selected' : ''}" data-code="${f.code}">
        <button class="remove-btn" data-remove="${f.code}" title="移除自选">✕</button>
        <div class="fund-card-top">
          <div style="min-width:0">
            <div class="fund-code">${f.code}</div>
            <div class="fund-name" title="${escapeHtml(f.name ?? '')}">${escapeHtml(f.name ?? '—')}</div>
          </div>
          <div class="fund-chg ${cls}">${fmtPct(f.livePct)}</div>
        </div>
        <div class="fund-meta">
          <span>净值 <span class="fund-nav">${fmtNum(f.liveNav, 4)}</span></span>
          <span class="badge">${escapeHtml(f.theme)}</span>
        </div>
      </div>`;
    })
    .join('');
}

/* ============================ 渲染：榜单 ============================ */

function renderRanks() {
  const draw = (list, el, kind) => {
    if (list.length === 0) {
      el.innerHTML = '<div class="small faint" style="padding:14px 0;text-align:center">今日无符合条件基金</div>';
      return;
    }
    el.innerHTML = list
      .map(
        (f, i) => `<div class="rank-item ${i === 0 ? kind : ''}" data-code="${f.code}">
          <span class="rank-index">${i + 1}</span>
          <span class="rank-name" title="${escapeHtml(f.name ?? '')}">${escapeHtml(f.name ?? f.code)}</span>
          <span class="rank-val ${pctClass(f.livePct)}">${fmtPct(f.livePct)}</span>
        </div>`
      )
      .join('');
  };
  draw(state.data.gainers, $('#gainers'), 'top');
  draw(state.data.losers, $('#losers'), 'bottom');
}

/* ============================ 渲染：走势图 ============================ */

/** 手写 SVG 折线图：面积渐变 + 网格 + 悬停十字线与提示框。 */
function renderChart() {
  const series = state.series;
  if (!series) return;

  $('#chartTitle').textContent = `${series.name ?? series.code} 净值走势`;
  $('#chartSub').textContent =
    `${series.rangeLabel} · ${series.start ?? '—'} 至 ${series.end ?? '—'} · 共 ${series.points.length} 个交易日`;

  const change = series.changePct;
  const cls = pctClass(change);
  const color = change > 0 ? 'var(--up)' : change < 0 ? 'var(--down)' : 'var(--flat)';

  const pr = series.periodReturns ?? {};
  $('#chartStats').innerHTML = `
    <div><div class="chart-stat-label">区间涨跌</div>
      <div class="chart-stat-value ${cls}">${fmtPct(change)}</div></div>
    <div><div class="chart-stat-label">最新净值</div>
      <div class="chart-stat-value">${fmtNum(series.points.at(-1)?.nav, 4)}</div></div>
    ${pr.m1 !== null && pr.m1 !== undefined ? `<div><div class="chart-stat-label">近1月</div><div class="chart-stat-value ${pctClass(pr.m1)}">${fmtPct(pr.m1)}</div></div>` : ''}
    ${pr.m3 !== null && pr.m3 !== undefined ? `<div><div class="chart-stat-label">近3月</div><div class="chart-stat-value ${pctClass(pr.m3)}">${fmtPct(pr.m3)}</div></div>` : ''}
    ${pr.y1 !== null && pr.y1 !== undefined ? `<div><div class="chart-stat-label">近1年</div><div class="chart-stat-value ${pctClass(pr.y1)}">${fmtPct(pr.y1)}</div></div>` : ''}`;

  const host = $('#chartHost');
  const points = series.points.filter((p) => p.nav !== null);
  state.chartPoints = points;

  if (points.length < 2) {
    host.innerHTML = `<div class="empty"><span class="empty-icon">📉</span>该区间暂无足够净值数据</div>`;
    return;
  }

  const width = Math.max(host.clientWidth || 720, 320);
  const height = 264;
  const pad = { l: 54, r: 14, t: 14, b: 26 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const navs = points.map((p) => p.nav);
  let min = Math.min(...navs);
  let max = Math.max(...navs);
  if (min === max) { min -= 0.01; max += 0.01; }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;

  const x = (i) => pad.l + (i / (points.length - 1)) * innerW;
  const y = (v) => pad.t + innerH - ((v - min) / (max - min)) * innerH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.nav).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;

  // 横向网格 5 条
  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const value = min + ((max - min) * i) / 4;
    const gy = y(value);
    return `<line x1="${pad.l}" y1="${gy.toFixed(1)}" x2="${width - pad.r}" y2="${gy.toFixed(1)}"
              stroke="var(--border-soft)" stroke-dasharray="3 4" />
            <text x="${pad.l - 8}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end"
              fill="var(--text-faint)" font-size="10.5" font-family="var(--mono)">${value.toFixed(3)}</text>`;
  }).join('');

  // 日期轴：首 / 中 / 尾
  const dateLabels = [0, Math.floor((points.length - 1) / 2), points.length - 1]
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      return `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}"
        fill="var(--text-faint)" font-size="10.5">${points[i].date.slice(5)}</text>`;
    })
    .join('');

  const gradientId = `grad-${series.code}-${state.range}`;
  host.innerHTML = `
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;overflow:visible">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.26" />
          <stop offset="100%" stop-color="${color}" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${areaPath}" fill="url(#${gradientId})" />
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.8"
        stroke-linejoin="round" stroke-linecap="round" />
      <line id="hoverLine" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + innerH}"
        stroke="var(--text-faint)" stroke-width="1" stroke-dasharray="3 3" opacity="0" />
      <circle id="hoverDot" r="4" fill="${color}" stroke="var(--bg)" stroke-width="2" opacity="0" />
      ${dateLabels}
      <rect id="hoverZone" x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}"
        fill="transparent" style="cursor:crosshair" />
    </svg>
    <div id="chartTip" style="position:absolute;pointer-events:none;opacity:0;transition:opacity .12s;
      background:#1d2739;border:1px solid var(--border);border-radius:8px;padding:7px 11px;
      font-size:12px;box-shadow:var(--shadow-lg);white-space:nowrap;z-index:5">
    </div>`;

  bindChartHover({ points, x, y, width, color, pad, innerH });
}

function bindChartHover({ points, x, y, width, color, pad, innerH }) {
  const zone = $('#hoverZone');
  const line = $('#hoverLine');
  const dot = $('#hoverDot');
  const tip = $('#chartTip');
  if (!zone) return;

  const show = (event) => {
    const host = $('#chartHost');
    const rect = host.getBoundingClientRect();
    const svgWidth = width;
    const ratio = svgWidth / rect.width;
    const localX = (event.clientX - rect.left) * ratio;
    const idx = Math.round(((localX - pad.l) / (svgWidth - pad.l - 14)) * (points.length - 1));
    const i = Math.min(Math.max(idx, 0), points.length - 1);
    const p = points[i];

    line.setAttribute('x1', x(i));
    line.setAttribute('x2', x(i));
    line.setAttribute('opacity', '1');
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(p.nav));
    dot.setAttribute('opacity', '1');

    tip.innerHTML = `<div style="color:var(--text-faint);font-size:11px">${p.date}</div>
      <div style="font-family:var(--mono);font-size:14px;color:#fff">${p.nav.toFixed(4)}</div>
      ${p.changePct !== null && p.changePct !== undefined
        ? `<div class="${pctClass(p.changePct)}" style="font-family:var(--mono);font-size:11.5px">${fmtPct(p.changePct)}</div>`
        : ''}`;
    tip.style.opacity = '1';

    const px = (x(i) / svgWidth) * rect.width;
    const py = (y(p.nav) / 264) * rect.height;
    const flip = px > rect.width - 140;
    tip.style.left = `${flip ? px - tip.offsetWidth - 12 : px + 12}px`;
    tip.style.top = `${Math.min(Math.max(py - 30, 0), rect.height - 64)}px`;
  };

  const hide = () => {
    line.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    tip.style.opacity = '0';
  };

  zone.addEventListener('mousemove', show);
  zone.addEventListener('mouseleave', hide);
}

/* ============================ 渲染：数据源状态 ============================ */

async function renderSource() {
  try {
    const source = await api('/api/funds/source');
    $('#sourceBox').innerHTML = `
      <div style="margin-bottom:6px">
        <span class="dot ${source.degraded ? 'bad' : 'ok'}"></span>
        当前：<strong style="color:var(--text)">${escapeHtml(source.activeLabel)}</strong>
      </div>
      ${source.candidates
        .map(
          (c) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0">
            <span>${c.reachable ? '✅' : '❌'} ${escapeHtml(c.label)}</span>
          </div>`
        )
        .join('')}
      ${source.reason ? `<div style="margin-top:8px;color:var(--warn);line-height:1.5">${escapeHtml(source.reason)}</div>` : ''}
      <div style="margin-top:8px;color:var(--text-faint);font-size:11px">
        蚂蚁财富接口在公网 DNS 不可解析，已自动使用同源口径的天天基金数据。
      </div>`;
  } catch {
    $('#sourceBox').textContent = '状态获取失败';
  }
}

/* ============================ 添加基金弹窗 ============================ */

function openAddModal() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:min(520px,100%)">
      <div class="modal-head">
        <h3>添加基金到自选</h3>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>输入基金代码或名称关键字</label>
          <input class="input" id="searchInput" placeholder="例如：000001 或 白酒" autocomplete="off" />
        </div>
        <div id="searchResults" class="small faint">输入关键字开始搜索…</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>关闭</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  const input = $('#searchInput', mask);
  input.focus();

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const keyword = input.value.trim();
    const box = $('#searchResults', mask);
    if (!keyword) {
      box.innerHTML = '输入关键字开始搜索…';
      return;
    }
    box.innerHTML = '<div class="skeleton" style="height:44px;margin-top:6px"></div>';
    timer = setTimeout(async () => {
      try {
        const list = await api(`/api/funds/search?q=${encodeURIComponent(keyword)}`);
        if (list.length === 0) {
          box.innerHTML = '<div style="padding:14px 0">未找到匹配的基金</div>';
          return;
        }
        box.innerHTML = list
          .map(
            (f) => `<div class="search-result" data-add="${f.code}">
              <div style="min-width:0">
                <div class="mono small" style="color:var(--text-dim)">${f.code}</div>
                <div style="color:var(--text);font-size:13px">${escapeHtml(f.name)}</div>
              </div>
              <span class="badge badge-primary">+ 添加</span>
            </div>`
          )
          .join('');
      } catch (error) {
        box.innerHTML = `<div style="padding:14px 0;color:var(--danger)">${escapeHtml(error.message)}</div>`;
      }
    }, 260);
  });

  $('#searchResults', mask).addEventListener('click', async (e) => {
    const row = e.target.closest('[data-add]');
    if (!row) return;
    try {
      await api('/api/watchlist', { method: 'POST', body: { code: row.dataset.add, theme: '自选' } });
      toast(`已添加 ${row.dataset.add} 到自选`);
      close();
      await loadDashboard();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

/* ============================ 事件绑定 ============================ */

$('#chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.theme = chip.dataset.theme;
  renderChips();
  renderFunds();
});

// 点击基金卡 / 榜单项 → 切换图表
content.addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    e.stopPropagation();
    try {
      await api(`/api/watchlist/${remove.dataset.remove}`, { method: 'DELETE' });
      toast(`已移除 ${remove.dataset.remove}`);
      if (state.selected === remove.dataset.remove) state.selected = null;
      await loadDashboard();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  const target = e.target.closest('[data-code]');
  if (!target) return;
  const code = target.dataset.code;
  if (state.selected === code) return;
  state.selected = code;
  renderFunds();
  await loadSeries(code, state.range);
});

// 区间切换
$('#ranges').innerHTML = RANGES
  .map(([key, label]) => `<button class="range-btn ${state.range === key ? 'active' : ''}" data-range="${key}">${label}</button>`)
  .join('');

$('#ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  state.range = btn.dataset.range;
  $$('.range-btn').forEach((b) => b.classList.toggle('active', b === btn));
  if (state.selected) loadSeries(state.selected, state.range);
});

$('#btnRefresh').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 刷新中';
  try {
    await loadDashboard();
    if (state.selected) await loadSeries(state.selected, state.range);
    await renderSource();
    toast('行情已刷新');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '↻ 刷新';
  }
});

$('#btnAdd').addEventListener('click', openAddModal);

// 窗口尺寸变化时重绘图表（SVG 按实际宽度计算）
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.series) renderChart();
  }, 180);
});

/* ============================ 启动 ============================ */

(async function init() {
  renderSource();
  try {
    await loadDashboard();
    if (state.selected) await loadSeries(state.selected, state.range);
    renderStatus();
  } catch (error) {
    $('#fundGrid').innerHTML = `<div class="empty" style="grid-column:1/-1">
      <span class="empty-icon">⚠️</span>加载失败：${escapeHtml(error.message)}</div>`;
  }
})();
