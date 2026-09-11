/** AI 对话路由：SSE 流式回答 + 附件解析 + 会话持久化。 */
import { openSse, sendJson } from '../lib/http.js';
import { chatLimiter, guard } from '../lib/auth.js';
import { Collection, newId } from '../lib/store.js';
import { runAgent } from '../services/agent.js';
import { extractFile } from '../services/extract.js';

const sessionCol = new Collection('sessions');
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

function summarize(session) {
  const last = session.messages.at(-1);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    preview: last ? String(last.content ?? '').slice(0, 50) : '',
  };
}

/** 解析前端上传的附件（base64）为可注入的文本。 */
async function parseAttachments(raw = []) {
  const out = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    const name = String(item.name ?? 'attachment');
    const base64 = String(item.data ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) continue;
    const size = Math.floor((base64.length * 3) / 4);
    if (size > MAX_ATTACHMENT_BYTES) {
      out.push({ name, kind: 'unknown', method: '文件过大', text: `附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 限制，已跳过解析。`, size });
      continue;
    }
    try {
      const buffer = Buffer.from(base64, 'base64');
      const result = await extractFile(buffer, name);
      out.push({ ...result, name, size });
    } catch (error) {
      out.push({ name, kind: 'unknown', method: '解析失败', text: `解析失败：${error.message}`, size });
    }
  }
  return out;
}

export function registerChatRoutes(router) {
  /** 会话读写属于对话功能的一部分，含用户会话内容，因此统一要求口令。 */
  const requireAccess = (req, url, res) => {
    const denied = guard(req, url, null);
    if (denied) {
      sendJson(res, { ok: false, error: denied.error, code: denied.code }, denied.status);
      return true;
    }
    return false;
  };

  router.get('/api/sessions', async ({ res, req, url }) => {
    if (requireAccess(req, url, res)) return;
    const list = sessionCol
      .all()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summarize);
    sendJson(res, { ok: true, data: list });
  });

  router.post('/api/sessions', async ({ res, body, req, url }) => {
    if (requireAccess(req, url, res)) return;
    const session = sessionCol.insert({
      id: newId('sess'),
      title: body.title || '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    });
    sendJson(res, { ok: true, data: summarize(session) });
  });

  router.get('/api/sessions/:id', async ({ res, params, req, url }) => {
    if (requireAccess(req, url, res)) return;
    const session = sessionCol.find((s) => s.id === params.id);
    if (!session) return sendJson(res, { ok: false, error: '会话不存在' }, 404);
    sendJson(res, { ok: true, data: session });
  });

  router.delete('/api/sessions/:id', async ({ res, params, req, url }) => {
    if (requireAccess(req, url, res)) return;
    const ok = sessionCol.remove(params.id);
    sendJson(res, { ok: ok, data: { id: params.id } });
  });

  /** 主对话入口：SSE 流式返回。 */
  router.post('/api/chat', async ({ res, body, req, url }) => {
    // 消耗 DeepSeek 额度：先校验口令，再做单 IP 频率限制
    const denied = guard(req, url, chatLimiter);
    if (denied) {
      sendJson(res, { ok: false, error: denied.error, code: denied.code }, denied.status);
      return;
    }
    const sse = openSse(res);
    const abort = new AbortController();
    req.on('close', () => abort.abort());

    try {
      let session = body.sessionId
        ? sessionCol.find((s) => s.id === body.sessionId)
        : undefined;
      if (!session) {
        session = sessionCol.insert({
          id: newId('sess'),
          title: String(body.message ?? '新对话').slice(0, 20) || '新对话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        });
      }
      sse.send('session', { id: session.id, title: session.title });

      // 1. 解析附件
      const attachments = await parseAttachments(body.attachments ?? []);
      if (attachments.length > 0) {
        sse.send('attachments', {
          items: attachments.map((a) => ({
            name: a.name,
            kind: a.kind,
            method: a.method,
            size: a.size,
            chars: a.text?.length ?? 0,
            preview: (a.text ?? '').slice(0, 300),
          })),
        });
      }

      // 2. 落盘用户消息
      const userMessage = {
        role: 'user',
        content: body.message ?? '',
        attachments: attachments.map((a) => ({ name: a.name, kind: a.kind, method: a.method, chars: a.text?.length ?? 0 })),
        ts: Date.now(),
      };
      const history = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');

      // 3. 运行 Agent
      const result = await runAgent({
        history: history.map((m) => ({ role: m.role, content: m.content })),
        input: body.message ?? '',
        attachments,
        emit: (event, data) => sse.send(event, data),
        signal: abort.signal,
      });

      const assistantMessage = {
        role: 'assistant',
        content: result.content,
        steps: result.steps,
        ts: Date.now(),
      };

      sessionCol.update(session.id, {
        messages: [...session.messages, userMessage, assistantMessage],
        updatedAt: Date.now(),
        title:
          session.messages.length === 0
            ? String(body.message ?? '新对话').slice(0, 20) || '新对话'
            : session.title,
      });

      sse.send('usage', result.usage);
      sse.send('done', { sessionId: session.id, steps: result.steps });
    } catch (error) {
      sse.send('error', { message: String(error?.message ?? error) });
    } finally {
      sse.end();
    }
  });
}
