/** 知识库路由：文档导入 / 列表 / 删除 / 检索。 */
import { sendJson } from '../lib/http.js';
import { addDocument, kbStats, listDocuments, removeDocument, search } from '../services/kb.js';

export function registerKbRoutes(router) {
  router.get('/api/kb', async ({ res }) => {
    sendJson(res, { ok: true, data: { stats: kbStats(), documents: listDocuments() } });
  });

  router.post('/api/kb', async ({ res, body }) => {
    const text = String(body.text ?? '').trim();
    if (!text) throw Object.assign(new Error('文档内容不能为空'), { statusCode: 400 });
    const doc = addDocument({
      title: body.title || `未命名文档 ${new Date().toLocaleString('zh-CN')}`,
      text,
      source: body.source ?? 'manual',
      tags: body.tags ?? [],
    });
    sendJson(res, { ok: true, data: doc });
  });

  router.delete('/api/kb/:id', async ({ res, params }) => {
    sendJson(res, { ok: true, data: { removed: removeDocument(params.id) } });
  });

  router.get('/api/kb/search', async ({ res, url }) => {
    const query = url.searchParams.get('q') ?? '';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 4) || 4, 20);
    sendJson(res, { ok: true, data: query ? search(query, limit) : [] });
  });
}
