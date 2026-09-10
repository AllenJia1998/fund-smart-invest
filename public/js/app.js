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

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
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
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `请求失败 (${res.status})`);
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
