/**
 * 基金智投 · AI 对话页
 *
 * 组成：
 *  1) 三栏骨架：shell 侧边栏（mountShell）+ 中间对话区 + 右侧「会话历史」；
 *  2) 对话区：SSE 流式回答、工具调用过程可视化、附件（图片 OCR / 文档解析）；
 *  3) 顶部「能力挂载」：知识库 / 技能 / 工具 三个弹窗。
 *
 * 接口契约见 server/routes/chat.js、server/routes/system.js、server/routes/kb.js。
 */
import {
  $,
  escapeHtml,
  fmtTime,
  fmtSize,
  api,
  streamSSE,
  toast,
  mountShell,
  renderMarkdown,
  renderStatus,
} from './app.js';

/* ============================ 常量与状态 ============================ */

const MAX_FILE_BYTES = 12 * 1024 * 1024; // 单文件上限 12MB
const MAX_FILES = 5; // 单次最多 5 个附件

/** 空状态建议问题 */
const SUGGESTIONS = [
  '今天市场行情如何？',
  '帮我分析一下上证指数的趋势',
  '现在适合买基金吗？',
  '最近北向资金流向如何？',
];

const state = {
  sessionId: null, // 当前会话 id（首轮由后端创建后回填）
  title: '新对话',
  sessions: [], // 会话列表（右侧面板）
  messages: [], // 当前会话消息（本地渲染用）
  files: [], // 待发送附件 [{ key, file, name, size, isImage, url }]
  sending: false, // 是否正在流式生成
  abort: null, // 当前请求的 AbortController
};

/* ============================== 页面骨架 ============================== */

const { content } = mountShell({
  active: 'chat',
  title: 'AI 投资对话',
  subtitle: '由 DeepSeek Agent 驱动',
  actionsHtml: `
    <span class="badge badge-primary" id="shellBadge">新对话</span>
    <button class="btn btn-sm" id="btnStop" disabled>⏹ 停止生成</button>`,
});

content.classList.add('chat-content');
content.innerHTML = `
  <div class="chat-wrap">
    <!-- ============ 中间：对话区 ============ -->
    <section class="chat-main" id="chatMain">
      <!-- 顶部条：会话标题 + 能力挂载开关 -->
      <div class="chat-bar">
        <div class="row" style="min-width:0">
          <span class="chat-bar-dot"></span>
          <span class="chat-bar-title" id="chatSessionTitle">新对话</span>
        </div>
        <div class="row" style="gap:8px">
          <button class="btn btn-sm" id="capKb" title="查看并导入知识库文档">📚 知识库</button>
          <button class="btn btn-sm" id="capSkills" title="挂载 / 卸载技能">🧩 技能</button>
          <button class="btn btn-sm" id="capTools" title="查看 Agent 可用工具">🛠 工具</button>
        </div>
      </div>

      <!-- 消息列表（可滚动） -->
      <div class="chat-scroll" id="chatScroll"></div>

      <!-- 底部输入区 -->
      <div class="composer">
        <div class="composer-inner">
          <div class="attach-row hidden" id="attachRow"></div>
          <div class="composer-box">
            <button class="icon-btn" id="btnAttach" title="添加附件（图片 / 文档）">📎</button>
            <textarea id="composerInput" rows="1" placeholder="问我任何基金投资问题…"></textarea>
            <button class="btn btn-primary" id="btnSend">发送</button>
          </div>
          <div class="composer-hint">
            Enter 发送 · Shift+Enter 换行 · 支持拖拽或粘贴图片/文档（单个 ≤ 12MB，最多 ${MAX_FILES} 个）
          </div>
        </div>
      </div>
      <input type="file" id="fileInput" class="hidden" multiple />
    </section>

    <!-- ============ 右侧：会话历史 ============ -->
    <aside class="chat-side">
      <div class="side-head">
        <h3>会话历史</h3>
        <button class="btn btn-sm btn-ghost" id="btnNewChat" title="开始新对话">＋ 新对话</button>
      </div>
      <div class="side-list" id="histList"></div>
    </aside>
  </div>`;

init();

function init() {
  renderMessages(); // 初始为空状态
  bindComposer();
  bindChatArea();
  bindHistory();
  bindCapabilities();
  refreshSessions();
}

/* =========================== 对话渲染（消息） =========================== */

/** 空状态：图标 + 文案 + 四个建议问题 */
function emptyStateHtml() {
  return `<div class="chat-empty" id="chatEmpty">
      <div class="chat-empty-icon">💬</div>
      <h2>你可以问我任何关于基金投资的问题</h2>
      <div class="small faint mt-8">Agent 会按需调用行情 / 资讯 / 知识库等工具，并展示完整调用过程</div>
      <div class="suggest">
        ${SUGGESTIONS.map((q) => `<button type="button" data-suggest="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}
      </div>
    </div>`;
}

/** 附件信息：未解析时显示文件 chip，已解析（含 method）时显示解析摘要 */
function attachmentsHtml(list = []) {
  if (!list || list.length === 0) return '';
  const rows = list.map((item) => {
    if (item.method || item.kind) {
      const bits = [item.name];
      if (item.method) bits.push(item.method);
      if (item.size) bits.push(fmtSize(item.size));
      if (item.chars) bits.push(`提取 ${item.chars} 字`);
      return `<div class="small muted att-parsed">已解析：${bits.map((v) => escapeHtml(v)).join(' · ')}</div>`;
    }
    return `<div class="att-pill">📎 <span>${escapeHtml(item.name)}</span><span class="faint">${fmtSize(item.size)}</span></div>`;
  });
  return `<div class="att-chips">${rows.join('')}</div>`;
}

/** 历史消息里已完成的工具调用 */
function historyToolLineHtml(step) {
  const ok = step.ok !== false;
  const ms = step.elapsedMs ?? 0;
  return ok
    ? `<div class="tool-line small muted">✓ <code>${escapeHtml(step.name)}</code> 完成 · 耗时 ${ms}ms</div>`
    : `<div class="tool-line small tool-bad">✗ <code>${escapeHtml(step.name)}</code> 失败</div>`;
}

/** 单条消息 → HTML */
function messageHtml(msg) {
  if (msg.role === 'user') {
    return `<div class="msg user"><div class="bubble">
        ${msg.content ? `<div class="bubble-text">${escapeHtml(msg.content)}</div>` : ''}
        ${attachmentsHtml(msg.attachments)}
        <div class="msg-meta">${fmtTime(msg.ts)}</div>
      </div></div>`;
  }
  const tools = (msg.tools ?? msg.steps ?? []).map(historyToolLineHtml).join('');
  return `<div class="msg assistant"><div class="bubble">
      ${tools ? `<div class="tool-lines">${tools}</div>` : ''}
      <div class="md">${renderMarkdown(msg.content)}</div>
      <div class="msg-meta">${fmtTime(msg.ts)}</div>
    </div></div>`;
}

/** 重绘整个消息区（会话切换 / 新建对话 / 初始空状态） */
function renderMessages() {
  const scroll = $('#chatScroll');
  if (state.messages.length === 0) {
    scroll.innerHTML = emptyStateHtml();
    return;
  }
  scroll.innerHTML = `<div class="chat-inner" id="msgList">${state.messages.map(messageHtml).join('')}</div>`;
  scrollToBottom(true);
}

/** 从空状态切换到消息列表，返回消息容器 */
function ensureList() {
  $('#chatEmpty')?.remove();
  let list = $('#msgList');
  if (!list) {
    list = document.createElement('div');
    list.className = 'chat-inner';
    list.id = 'msgList';
    $('#chatScroll').appendChild(list);
  }
  return list;
}

/** 滚动到底部；force=false 时仅在接近底部才跟随（避免打断用户回看历史） */
function scrollToBottom(force = false) {
  const el = $('#chatScroll');
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

/* ========================= 流式助手气泡（工具过程） ========================= */

/**
 * 创建一个「流式助手气泡」控制器：
 * 工具调用行在正文上方，正文随 delta 实时重渲染 Markdown。
 */
function createStreamBubble() {
  const node = document.createElement('div');
  node.className = 'msg assistant';
  node.innerHTML = `<div class="bubble streaming">
      <div class="tool-lines hidden"></div>
      <div class="md"><p class="small muted">正在思考…</p></div>
      <div class="msg-meta"></div>
    </div>`;

  const bubble = node.querySelector('.bubble');
  const toolLines = node.querySelector('.tool-lines');
  const mdEl = node.querySelector('.md');
  const metaEl = node.querySelector('.msg-meta');
  const toolMap = new Map(); // tool id → { el, startedAt }
  const steps = []; // 本次调用的工具摘要
  let raw = '';
  let failed = false;

  return {
    node,
    raw: () => raw,
    steps: () => steps,

    /** delta：追加文本并实时渲染 Markdown */
    append(chunk) {
      if (!chunk) return;
      raw += chunk;
      mdEl.innerHTML = renderMarkdown(raw);
      scrollToBottom();
    },

    /** tool_start：追加「⚙ 正在调用 …」 */
    toolStart(data) {
      const el = document.createElement('div');
      el.className = 'tool-line small muted';
      el.innerHTML = `⚙ 正在调用 <code>${escapeHtml(data.name)}</code>…`;
      toolLines.classList.remove('hidden');
      toolLines.appendChild(el);
      toolMap.set(data.id ?? data.name, { el, startedAt: Date.now() });
      scrollToBottom(true);
    },

    /** tool_end：改写成「✓ … 完成 · 耗时 320ms」/「✗ … 失败」 */
    toolEnd(data) {
      const key = data.id ?? data.name;
      const rec = toolMap.get(key);
      const el = rec?.el ?? document.createElement('div');
      if (!rec) {
        el.className = 'tool-line small muted';
        toolLines.classList.remove('hidden');
        toolLines.appendChild(el);
      }
      const ok = data.ok !== false;
      const ms = data.elapsedMs ?? (rec ? Date.now() - rec.startedAt : 0);
      el.className = `tool-line small ${ok ? 'muted' : 'tool-bad'}`;
      el.innerHTML = ok
        ? `✓ <code>${escapeHtml(data.name)}</code> 完成 · 耗时 ${ms}ms`
        : `✗ <code>${escapeHtml(data.name)}</code> 失败`;
      steps.push({ name: data.name, ok, elapsedMs: ms });
      scrollToBottom(true);
    },

    /** error 事件：展示后端返回的失败原因 */
    fail(message) {
      failed = true;
      const box = document.createElement('div');
      box.className = 'stream-error small';
      box.textContent = `⚠ ${message}`;
      bubble.insertBefore(box, metaEl);
      scrollToBottom(true);
    },

    /** 中性提示（例如用户主动停止） */
    note(message) {
      const box = document.createElement('div');
      box.className = 'small faint';
      box.style.marginTop = '8px';
      box.textContent = `— ${message} —`;
      bubble.insertBefore(box, metaEl);
    },

    /** 收尾：去掉光标与占位 */
    finish() {
      bubble.classList.remove('streaming');
      if (!raw && !failed) mdEl.innerHTML = '<p class="small muted">（本次没有返回文本内容）</p>';
      metaEl.textContent = fmtTime(Date.now());
    },
  };
}

/* ============================== 发送流程 ============================== */

/** File → { name, data: 'data:xxx;base64,...' } */
function fileToAttachment(rec) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: rec.name, data: String(reader.result ?? '') });
    reader.onerror = () => reject(new Error(`无法读取「${rec.name}」`));
    reader.readAsDataURL(rec.file);
  });
}

async function send(textOverride) {
  if (state.sending) return;
  const input = $('#composerInput');
  const text = String(textOverride ?? input.value ?? '').trim();
  const files = state.files.slice();
  if (!text && files.length === 0) {
    toast('请输入内容或添加附件', 'error');
    return;
  }

  setSending(true);
  input.value = '';
  autoGrow();

  // 1) 附件转 base64
  let attachments = [];
  try {
    attachments = await Promise.all(files.map(fileToAttachment));
  } catch (error) {
    toast(`附件读取失败：${error.message}`, 'error');
    setSending(false);
    return;
  }
  clearFiles();

  // 2) 渲染用户气泡
  const userMsg = {
    role: 'user',
    content: text,
    ts: Date.now(),
    attachments: files.map((f) => ({ name: f.name, size: f.size })),
  };
  state.messages.push(userMsg);
  const list = ensureList();
  list.insertAdjacentHTML('beforeend', messageHtml(userMsg));
  const userNode = list.lastElementChild;

  // 3) 助手占位气泡
  const assistant = createStreamBubble();
  list.appendChild(assistant.node);
  scrollToBottom(true);

  const controller = new AbortController();
  state.abort = controller;
  let sessionMissing = false;

  try {
    // streamSSE 返回 Promise，读完整条流后 resolve（不依赖 done 事件收尾）
    await streamSSE(
      '/api/chat',
      {
        sessionId: state.sessionId || undefined, // 缺省时由后端新建会话
        message: text,
        attachments,
      },
      {
        /** 会话已创建 / 已存在 */
        session(data) {
          if (!data?.id) return;
          state.sessionId = data.id;
          state.title = data.title || state.title;
          updateSessionTitle();
        },
        /** 附件解析结果：替换用户气泡里的附件 chip 为解析摘要 */
        attachments(data) {
          const items = data?.items ?? [];
          if (items.length === 0) return;
          userMsg.attachments = items;
          const box = userNode?.querySelector('.att-chips');
          if (box) box.outerHTML = attachmentsHtml(items);
          else userNode?.querySelector('.msg-meta')?.insertAdjacentHTML('beforebegin', attachmentsHtml(items));
          scrollToBottom(true);
        },
        /** 文本增量 */
        delta(data) {
          assistant.append(data?.content ?? '');
        },
        tool_start(data) {
          assistant.toolStart(data ?? {});
        },
        tool_end(data) {
          assistant.toolEnd(data ?? {});
        },
        usage(data) {
          state.usage = data;
        },
        /** 后端异常（仍会正常关闭流） */
        error(data) {
          assistant.fail(data?.message ?? '生成失败');
        },
      },
      controller.signal
    );
  } catch (error) {
    if (error?.name === 'AbortError') assistant.note('已停止生成');
    else assistant.fail(String(error?.message ?? error));
  } finally {
    assistant.finish();
    state.abort = null;
    setSending(false);

    // 本地记录助手回复，便于会话内一致重绘
    if (assistant.raw()) {
      state.messages.push({
        role: 'assistant',
        content: assistant.raw(),
        ts: Date.now(),
        tools: assistant.steps(),
      });
    }
    if (!sessionMissing) refreshSessions();
    input.focus();
  }
}

/** 生成中的 UI 状态：禁用按钮 + spinner */
function setSending(on) {
  state.sending = on;
  const send = $('#btnSend');
  send.disabled = on;
  send.innerHTML = on ? '<span class="spinner"></span>' : '发送';
  const stop = $('#btnStop');
  if (stop) stop.disabled = !on;
  const attach = $('#btnAttach');
  if (attach) attach.disabled = on;
}

/* ============================== 输入区交互 ============================== */

function bindComposer() {
  const input = $('#composerInput');

  input.addEventListener('input', autoGrow);
  // Enter 发送 / Shift+Enter 换行（中文输入法组词中不触发）
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('paste', onPaste);

  $('#btnSend').addEventListener('click', () => send());
  $('#btnStop').addEventListener('click', () => {
    if (!state.abort) return;
    state.abort.abort();
    toast('已停止生成');
  });

  $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  // 附件 chip 的单个删除
  $('#attachRow').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) removeFile(btn.dataset.remove);
  });

  autoGrow();
}

/** textarea 高度自适应，最多约 120px */
function autoGrow() {
  const input = $('#composerInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

/** 粘贴：优先取剪贴板里的文件（截图等） */
function onPaste(e) {
  const items = [...(e.clipboardData?.items ?? [])];
  const files = items
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length === 0) return; // 纯文本走默认粘贴
  e.preventDefault();
  addFiles(files);
}

/* ------------------------------ 附件管理 ------------------------------ */

function extFromType(type = '') {
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('pdf')) return 'pdf';
  return 'png';
}

/** 补全文件名：粘贴的图片常常没有名字或没有扩展名 */
function normalizeName(file) {
  const raw = String(file.name ?? '').trim();
  const type = file.type || '';
  if (!raw) {
    return type.startsWith('image/')
      ? `粘贴图片-${Date.now()}.${extFromType(type)}`
      : `附件-${Date.now()}.txt`;
  }
  if (!raw.includes('.') && type) return `${raw}.${extFromType(type)}`;
  return raw;
}

/** 校验并加入待发送附件（单个 ≤12MB，最多 5 个） */
function addFiles(fileList) {
  const incoming = [...(fileList ?? [])].filter(Boolean);
  if (incoming.length === 0) return;

  for (const file of incoming) {
    if (state.files.length >= MAX_FILES) {
      toast(`最多添加 ${MAX_FILES} 个附件`, 'error');
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast(`「${normalizeName(file)}」超过 12MB 限制`, 'error');
      continue;
    }
    if (file.size === 0) {
      toast(`「${normalizeName(file)}」是空文件，已忽略`, 'error');
      continue;
    }
    const isImage = String(file.type ?? '').startsWith('image/');
    state.files.push({
      key: `f${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file,
      name: normalizeName(file),
      size: file.size,
      isImage,
      url: isImage ? URL.createObjectURL(file) : '',
    });
  }
  renderFiles();
}

function removeFile(key) {
  const idx = state.files.findIndex((f) => f.key === key);
  if (idx < 0) return;
  const [removed] = state.files.splice(idx, 1);
  if (removed?.url) URL.revokeObjectURL(removed.url);
  renderFiles();
}

function clearFiles() {
  for (const f of state.files) if (f.url) URL.revokeObjectURL(f.url);
  state.files = [];
  renderFiles();
}

/** 渲染输入框上方的附件 chip（图片显示缩略图） */
function renderFiles() {
  const row = $('#attachRow');
  if (state.files.length === 0) {
    row.innerHTML = '';
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  row.innerHTML = state.files
    .map(
      (f) => `<div class="att-chip" title="${escapeHtml(f.name)}">
        ${f.isImage ? `<img src="${f.url}" alt="${escapeHtml(f.name)}" />` : '<span class="att-ico">📄</span>'}
        <span class="att-name">${escapeHtml(f.name)}</span>
        <span class="faint">${fmtSize(f.size)}</span>
        <button class="att-del" type="button" data-remove="${f.key}" title="移除附件">✕</button>
      </div>`
    )
    .join('');
}

/* ========================== 对话区：拖拽与建议问题 ========================== */

function bindChatArea() {
  const main = $('#chatMain');
  let dragDepth = 0;

  ['dragenter', 'dragover'].forEach((type) => {
    main.addEventListener(type, (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (type === 'dragenter') dragDepth += 1;
      main.classList.add('dragging');
    });
  });

  main.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) main.classList.remove('dragging');
  });

  // 拖拽文件到对话区即添加为附件
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    main.classList.remove('dragging');
    addFiles(e.dataTransfer?.files);
  });

  // 阻止浏览器默认的「打开文件」行为
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // 建议问题（事件委托，空状态与消息列表共用）
  $('#chatScroll').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-suggest]');
    if (btn) send(btn.dataset.suggest);
  });
}

/* ============================== 会话历史 ============================== */

async function refreshSessions() {
  try {
    const list = await api('/api/sessions');
    state.sessions = Array.isArray(list) ? list : [];
    renderSessionList();
  } catch (error) {
    toast(`会话列表加载失败：${error.message}`, 'error');
  }
}

function renderSessionList() {
  const box = $('#histList');
  if (!state.sessions.length) {
    box.innerHTML = `<div class="empty" style="padding:28px 12px">
        <span class="empty-icon">🗂</span>暂无历史对话
      </div>`;
    return;
  }
  box.innerHTML = state.sessions
    .map(
      (s) => `<div class="hist-item ${s.id === state.sessionId ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
        <button class="hist-del" type="button" data-del="${escapeHtml(s.id)}" title="删除会话">✕</button>
        <div class="hist-title">${escapeHtml(s.title || '新对话')}</div>
        <div class="hist-time">${fmtTime(s.updatedAt)} · ${s.messageCount ?? 0} 条</div>
      </div>`
    )
    .join('');
}

function bindHistory() {
  $('#btnNewChat').addEventListener('click', newChat);

  $('#histList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      await deleteSession(del.dataset.del);
      return;
    }
    const item = e.target.closest('.hist-item');
    if (item) await loadSession(item.dataset.id);
  });
}

function newChat() {
  if (state.sending) {
    toast('正在生成中，请先停止或等待完成', 'error');
    return;
  }
  state.sessionId = null;
  state.title = '新对话';
  state.messages = [];
  updateSessionTitle();
  renderMessages();
  renderSessionList();
  $('#composerInput').focus();
}

async function loadSession(id) {
  if (state.sending) {
    toast('正在生成中，请先停止或等待完成', 'error');
    return;
  }
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
    state.sessionId = session.id;
    state.title = session.title || '新对话';
    state.messages = (session.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      ts: m.ts,
      attachments: m.attachments,
      tools: m.steps,
    }));
    updateSessionTitle();
    renderMessages();
    renderSessionList();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteSession(id) {
  const target = state.sessions.find((s) => s.id === id);
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(`已删除会话${target?.title ? `「${target.title}」` : ''}`);
    if (state.sessionId === id) {
      state.sessionId = null;
      state.title = '新对话';
      state.messages = [];
      updateSessionTitle();
      renderMessages();
    }
    await refreshSessions();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/** 同步会话标题到对话区顶部条与 shell 顶栏徽标 */
function updateSessionTitle() {
  const title = state.title || '新对话';
  $('#chatSessionTitle').textContent = title;
  const badge = $('#shellBadge');
  if (badge) badge.textContent = title.length > 12 ? `${title.slice(0, 12)}…` : title;
}

/* ============================ 能力挂载弹窗 ============================ */

function openModal(title, bodyHtml = '') {
  closeModal();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'modalMask';
  mask.innerHTML = `<div class="modal">
      <div class="modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="btn btn-ghost btn-sm" type="button" data-close title="关闭">✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) closeModal();
  });
  document.body.appendChild(mask);
  return mask;
}

function closeModal() {
  document.getElementById('modalMask')?.remove();
}

function bindCapabilities() {
  $('#capKb').addEventListener('click', openKbModal);
  $('#capSkills').addEventListener('click', openSkillsModal);
  $('#capTools').addEventListener('click', openToolsModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

/* ------------------------------ 知识库 ------------------------------ */

async function openKbModal() {
  const mask = openModal('知识库', '<div class="skeleton" style="height:160px"></div>');
  const body = mask.querySelector('.modal-body');

  // 删除文档（事件委托只绑定一次）
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-kb-del]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api(`/api/kb/${encodeURIComponent(btn.dataset.kbDel)}`, { method: 'DELETE' });
      toast('文档已删除');
      await renderKb(body);
      renderStatus(); // 刷新侧边栏状态
    } catch (error) {
      btn.disabled = false;
      toast(error.message, 'error');
    }
  });

  await renderKb(body);
}

async function renderKb(body) {
  try {
    const data = await api('/api/kb');
    const stats = data.stats ?? {};
    body.innerHTML = `
      <div class="row between wrap" style="margin-bottom:12px">
        <span class="small muted">文档 <b class="num">${stats.documents ?? 0}</b> 篇 ·
          片段 <b class="num">${stats.chunks ?? 0}</b> ·
          词条 <b class="num">${stats.terms ?? 0}</b></span>
        <button class="btn btn-sm btn-primary" type="button" id="kbAddToggle">+ 导入文档</button>
      </div>

      <form class="kb-form hidden" id="kbForm">
        <div class="field">
          <label>标题</label>
          <input class="input" id="kbTitle" placeholder="例如：2025 年二季度宏观展望" />
        </div>
        <div class="field">
          <label>正文</label>
          <textarea class="textarea" id="kbText" placeholder="粘贴研报、公告或笔记正文，保存后会自动切片建立索引…"></textarea>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn btn-sm" type="button" id="kbCancel">取消</button>
          <button class="btn btn-sm btn-primary" type="submit">保存并建索引</button>
        </div>
      </form>

      <div>${kbListHtml(data.documents ?? [])}</div>`;

    bindKbForm(body);
  } catch (error) {
    body.innerHTML = `<div class="empty"><span class="empty-icon">⚠️</span>${escapeHtml(error.message)}</div>`;
  }
}

function kbListHtml(documents) {
  if (!documents.length) {
    return `<div class="empty" style="padding:30px 12px"><span class="empty-icon">📚</span>知识库还是空的，导入第一篇资料吧</div>`;
  }
  return documents
    .map(
      (d) => `<div class="cap-row">
        <div style="flex:1;min-width:0">
          <div class="cap-name">${escapeHtml(d.title)}</div>
          <div class="cap-desc">${escapeHtml(d.source ?? 'manual')} · ${d.chars ?? 0} 字 · ${d.chunks ?? 0} 片段 · ${fmtTime(d.createdAt)}</div>
        </div>
        <button class="btn btn-sm" type="button" data-kb-del="${escapeHtml(d.id)}">删除</button>
      </div>`
    )
    .join('');
}

function bindKbForm(body) {
  const form = $('#kbForm', body);
  const toggle = $('#kbAddToggle', body);
  const titleInput = $('#kbTitle', body);
  const textInput = $('#kbText', body);

  toggle?.addEventListener('click', () => {
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) titleInput.focus();
  });
  $('#kbCancel', body)?.addEventListener('click', () => form.classList.add('hidden'));

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text) {
      toast('文档内容不能为空', 'error');
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api('/api/kb', { method: 'POST', body: { title: titleInput.value.trim(), text } });
      toast('文档已导入，索引已更新');
      await renderKb(body);
      renderStatus(); // 刷新侧边栏状态
    } catch (error) {
      submit.disabled = false;
      toast(error.message, 'error');
    }
  });
}

/* ------------------------------- 技能 ------------------------------- */

async function openSkillsModal() {
  const mask = openModal('技能挂载', '<div class="skeleton" style="height:180px"></div>');
  const body = mask.querySelector('.modal-body');

  body.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-skill]');
    if (!input) return;
    const name = input.dataset.skill;
    const mounted = input.checked;
    input.disabled = true;
    try {
      const list = await api(`/api/skills/${encodeURIComponent(name)}/mount`, {
        method: 'POST',
        body: { mounted },
      });
      toast(`技能「${name}」已${mounted ? '挂载' : '卸载'}`);
      renderSkills(body, Array.isArray(list) ? list : []);
      renderStatus(); // 刷新侧边栏状态
    } catch (error) {
      input.checked = !mounted;
      input.disabled = false;
      toast(error.message, 'error');
    }
  });

  await loadSkills(body);
}

async function loadSkills(body) {
  try {
    const list = await api('/api/skills');
    renderSkills(body, Array.isArray(list) ? list : []);
  } catch (error) {
    body.innerHTML = `<div class="empty"><span class="empty-icon">⚠️</span>${escapeHtml(error.message)}</div>`;
  }
}

function renderSkills(body, list) {
  if (!list.length) {
    body.innerHTML = `<div class="empty" style="padding:30px 12px"><span class="empty-icon">🧩</span>暂无可挂载技能</div>`;
    return;
  }
  body.innerHTML = `
    <div class="small faint" style="margin-bottom:10px">挂载后技能指令会注入 Agent 系统提示，可随时插拔。</div>
    ${list
      .map(
        (s) => `<div class="cap-row">
          <div style="flex:1;min-width:0">
            <div class="cap-name">${escapeHtml(s.name)}</div>
            <div class="cap-desc">${escapeHtml(s.description || '（无描述）')}</div>
            <div class="cap-desc faint mono" style="font-size:11px">${escapeHtml(s.path ?? '')}</div>
          </div>
          <label class="switch" title="${s.mounted ? '已挂载' : '未挂载'}">
            <input type="checkbox" data-skill="${escapeHtml(s.name)}" ${s.mounted ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>`
      )
      .join('')}`;
}

/* ------------------------------- 工具 ------------------------------- */

async function openToolsModal() {
  const mask = openModal('Agent 工具', '<div class="skeleton" style="height:180px"></div>');
  const body = mask.querySelector('.modal-body');
  try {
    const list = await api('/api/tools');
    const tools = Array.isArray(list) ? list : [];
    body.innerHTML = tools.length
      ? `<div class="small faint" style="margin-bottom:10px">共 ${tools.length} 个工具，由 Agent 按需自动调用（只读清单）。</div>
         ${tools
           .map(
             (t) => `<div class="cap-row">
               <div style="flex:1;min-width:0">
                 <div class="cap-name mono">${escapeHtml(t.name)}</div>
                 <div class="cap-desc">${escapeHtml(t.description || '（无描述）')}</div>
               </div>
             </div>`
           )
           .join('')}`
      : `<div class="empty" style="padding:30px 12px"><span class="empty-icon">🛠</span>暂无可用工具</div>`;
  } catch (error) {
    body.innerHTML = `<div class="empty"><span class="empty-icon">⚠️</span>${escapeHtml(error.message)}</div>`;
  }
}
