/* 基金智投 · 前端公共库：布局外壳 / API / SSE / 格式化 / Markdown */

/* ----------------------------- 基础工具 ----------------------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 涨跌格式化：带符号，并沿用中国惯例（红涨绿跌）。 */
export function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function pctClass(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'flat';
  const n = Number(value);
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

export function fmtNum(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* ------------------------------- API ------------------------------- */

/**
 * API 基址。
 * 解析优先级：
 *   1. localStorage 覆盖（可在页面上随时改，无需重新部署）
 *   2. js/config.js 注入的 window.__API_BASE__
 *   3. 空字符串 = 与后端同源（本地直接访问时）
 */
// v2：修复旧版本会把「自动探测到的地址」误写进存储的问题。
// 换 key 名可让浏览器里的旧脏数据自然失效，用户无需手动清理。
const BACKEND_KEY = 'fsi_api_base_v2';
try {
  localStorage.removeItem('fsi_api_base'); // 清理旧版遗留的脏数据
} catch {
  /* 隐私模式下 localStorage 可能不可用 */
}

export function getApiBase() {
  const stored = localStorage.getItem(BACKEND_KEY);
  if (stored) return stored.replace(/\/$/, '');
  return String(window.__API_BASE__ ?? '').replace(/\/$/, '');
}

export function setApiBase(url) {
  const value = String(url ?? '').trim().replace(/\/$/, '');
  if (value) localStorage.setItem(BACKEND_KEY, value);
  else localStorage.removeItem(BACKEND_KEY);
}

/**
 * 仅返回「用户手动保存过」的后端地址覆盖；没有显式覆盖时返回 null。
 * 用于设置弹窗的回显：不要用自动探测值预填，否则会误把旧的部署地址
 * 固化进 localStorage，覆盖掉 config.js 里的最新地址。
 */
export function getStoredApiBase() {
  return localStorage.getItem(BACKEND_KEY) ?? null;
}

export function apiUrl(path) {
  return getApiBase() + path;
}

/** 是否处于"前端已部署、后端在别处"的分离模式。 */
export function isSplitDeploy() {
  return getApiBase() !== '';
}

/** 访问口令：保存在 localStorage，随请求头 X-Access-Code 发送。 */
const CODE_KEY = 'fsi_access_code';

export function getAccessCode() {
  return localStorage.getItem(CODE_KEY) ?? '';
}

export function setAccessCode(code) {
  if (code) localStorage.setItem(CODE_KEY, code);
  else localStorage.removeItem(CODE_KEY);
}

function authHeaders() {
  const code = getAccessCode();
  return code ? { 'X-Access-Code': code } : {};
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const error = new Error(data.error || '需要访问口令');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data.data;
}

/**
 * 基于 fetch 的 SSE 客户端（支持 POST）。
 * handlers: { [eventName]: (data) => void, error, done }
 */
export async function streamSSE(path, body, handlers = {}, signal) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `请求失败 (${res.status})`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = parsed.error;
    } catch {
      if (text) message = text.slice(0, 200);
    }
    const error = new Error(message);
    if (res.status === 401) error.code = 'UNAUTHORIZED';
    if (res.status === 429) error.code = 'RATE_LIMITED';
    throw error;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let event = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let payload;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      const handler = handlers[event] ?? handlers.message;
      if (handler) handler(payload);
    }
  }
  if (handlers.done) handlers.done();
}

/* --------------------------- 口令设置弹窗 --------------------------- */

/**
 * 弹出「连接设置」窗口：可填写访问口令与后端地址。
 * @param {{requireCode?: boolean, reason?: string}} options
 * @returns {Promise<boolean>} 是否已保存
 */
export function openSettings({ requireCode = false, reason = '' } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:min(460px,100%)">
        <div class="modal-head">
          <h3>连接设置</h3>
          <button class="btn btn-sm btn-ghost" data-close>✕</button>
        </div>
        <div class="modal-body">
          ${reason ? `<div class="small" style="color:var(--warn);margin-bottom:14px;line-height:1.6">${escapeHtml(reason)}</div>` : ''}
          <div class="field">
            <label>访问口令${requireCode ? '（必填）' : ''}</label>
            <input class="input" id="cfgCode" placeholder="例如：054X-5OTX-45PB-FRW5" value="${escapeHtml(getAccessCode())}" autocomplete="off" />
            <div class="small faint" style="margin-top:6px">用于解锁 AI 对话与报告生成；行情与资讯无需口令。</div>
          </div>
          <div class="field">
            <label>后端地址（可选）</label>
            <input class="input" id="cfgBase" placeholder="留空 = 自动检测（推荐）" value="${escapeHtml(getStoredApiBase() ?? '')}" autocomplete="off" />
            <div class="small faint" style="margin-top:6px">通常<b>留空</b>即可，会自动使用部署好的后端地址；只有自己另外部署了后端时才需要手动填。</div>
          </div>
          <div class="field" style="margin-bottom:4px">
            <button class="btn btn-sm btn-ghost" id="cfgReset" style="color:var(--warn)">↺ 清除已保存的后端地址，恢复自动检测</button>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close>取消</button>
          <button class="btn btn-primary" id="cfgSave">保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const done = (ok) => {
      mask.remove();
      resolve(ok);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.closest('[data-close]')) done(false);
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onEsc);
        done(false);
      }
    });
    mask.querySelector('#cfgSave').addEventListener('click', () => {
      const code = mask.querySelector('#cfgCode').value.trim();
      if (requireCode && !code) {
        toast('请填写访问口令', 'error');
        return;
      }
      setAccessCode(code);
      setApiBase(mask.querySelector('#cfgBase').value);
      toast('设置已保存，正在重新加载…');
      setTimeout(() => location.reload(), 600);
      done(true);
    });
    // 一键清除后端地址覆盖，恢复自动检测
    mask.querySelector('#cfgReset').addEventListener('click', () => {
      setApiBase('');
      mask.querySelector('#cfgBase').value = '';
      toast('已恢复自动检测后端地址，保存后生效');
    });
    mask.querySelector('#cfgCode').focus();
  });
}

/**
 * 统一处理受保护接口的失败：口令缺失或错误时引导用户填写。
 * @returns {boolean} 是否已处理
 */
export async function handleAuthError(error, actionLabel = '该功能') {
  if (error?.code === 'UNAUTHORIZED') {
    await openSettings({
      requireCode: true,
      reason: `${actionLabel}需要访问口令。请输入管理员提供访问码后重试。`,
    });
    return true;
  }
  if (error?.code === 'RATE_LIMITED') {
    toast(error.message, 'error', 5000);
    return true;
  }
  return false;
}

/* ------------------------------ Toast ------------------------------ */

let toastWrap;
export function toast(message, type = 'info', ms = 3000) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'error' : ''}`;
  node.textContent = message;
  toastWrap.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 250);
  }, ms);
}

/* ------------------------------ 布局 ------------------------------ */

const NAV = [
  { key: 'dashboard', href: 'index.html', icon: '📊', label: '行情看板' },
  { key: 'chat', href: 'chat.html', icon: '💬', label: 'AI 对话' },
  { key: 'push', href: 'push.html', icon: '🔔', label: '每日推送' },
];

/**
 * 渲染应用外壳（侧边栏 + 顶栏），返回主内容容器。
 */
export function mountShell({ active, title, subtitle = '', actionsHtml = '' }) {
  const navHtml = NAV.map(
    (item) =>
      `<a class="nav-item ${item.key === active ? 'active' : ''}" href="${item.href}">
         <span class="nav-icon">${item.icon}</span><span>${item.label}</span>
       </a>`
  ).join('');

  document.body.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-name">基金智投</div>
          <div class="brand-sub">DeepSeek Agent 投研终端</div>
        </div>
        <nav class="nav">${navHtml}</nav>
        <div class="sidebar-foot" id="sidebarFoot">
          <div><span class="dot ok"></span>连接中…</div>
        </div>
        <button class="nav-item" id="btnSettings" style="margin-top:6px;font-size:12.5px">
          <span class="nav-icon">⚙</span><span>连接设置</span>
        </button>
      </aside>
      <main class="main">
        <header class="topbar">
          <div>
            <h1>${escapeHtml(title)}</h1>
            ${subtitle ? `<div class="topbar-sub">${escapeHtml(subtitle)}</div>` : ''}
          </div>
          <div class="topbar-actions">${actionsHtml}</div>
        </header>
        <div class="content" id="content"></div>
      </main>
    </div>`;

  $('#btnSettings')?.addEventListener('click', () => openSettings({}));
  renderStatus();
  return { content: $('#content'), sidebarFoot: $('#sidebarFoot') };
}

/** 侧边栏底部展示数据源与模型状态，避免"静默降级"。 */
export async function renderStatus() {
  const foot = $('#sidebarFoot');
  if (!foot) return;
  try {
    const status = await api('/api/status');
    const source = status.dataSource;
    foot.innerHTML = `
      <div><span class="dot ${source.degraded ? 'bad' : 'ok'}"></span>${escapeHtml(source.activeLabel)}</div>
      <div title="${escapeHtml(status.llm.model)}">模型 ${escapeHtml(status.llm.model)}</div>
      <div>知识库 ${status.kb.documents} 篇 · 技能 ${status.skills.filter((s) => s.mounted).length} 个</div>`;
  } catch {
    foot.innerHTML = '<div><span class="dot bad"></span>服务未连接</div>';
  }
}

/* --------------------------- Markdown --------------------------- */

/** 轻量 Markdown 渲染：覆盖标题/列表/表格/代码/强调/引用/链接。 */
export function renderMarkdown(src) {
  if (!src) return '';
  let text = escapeHtml(src);
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  const lines = text.split('\n');
  const out = [];
  let listType = null;
  let inTable = false;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
      closeList();
      closeTable();
      out.push(line.trim());
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => inline(c.trim()));
      const next = lines[i + 1] ?? '';
      if (!inTable && /^\s*\|[\s:|-]+\|\s*$/.test(next)) {
        closeList();
        out.push('<table><thead><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true;
        i += 1;
        continue;
      }
      if (inTable) {
        out.push('<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>');
        continue;
      }
    } else {
      closeTable();
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
      continue;
    }

    closeList();
    if (line.trim() === '') continue;
    out.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  closeTable();
  let html = out.join('\n');
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, n) => codeBlocks[Number(n)]);
  return html;

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
}
