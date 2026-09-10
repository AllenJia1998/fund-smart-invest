/** 每日推送路由：报告列表 / 详情 / 生成（SSE 进度）/ 删除。 */
import { openSse, sendJson } from '../lib/http.js';
import { generateReport, getReport, listReports, removeReport } from '../services/push.js';

export function registerPushRoutes(router) {
  router.get('/api/push/reports', async ({ res }) => {
    sendJson(res, { ok: true, data: listReports() });
  });

  router.get('/api/push/reports/:id', async ({ res, params }) => {
    const report = getReport(params.id);
    if (!report) return sendJson(res, { ok: false, error: '报告不存在' }, 404);
    sendJson(res, { ok: true, data: report });
  });

  router.delete('/api/push/reports/:id', async ({ res, params }) => {
    sendJson(res, { ok: true, data: { removed: removeReport(params.id) } });
  });

  /** 生成报告：SSE 推送进度，避免长请求超时。 */
  router.post('/api/push/generate', async ({ res, body, req }) => {
    const sse = openSse(res);
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    const timer = setInterval(() => sse.comment('ping'), 15_000);

    try {
      sse.send('progress', { stage: 'collecting', message: '正在采集基金行情与实时资讯…' });
      const report = await generateReport({ triggeredBy: body?.triggeredBy ?? 'manual' });
      if (report.status === 'complete') {
        sse.send('progress', { stage: 'done', message: '报告生成完成' });
      } else {
        sse.send('progress', { stage: 'failed', message: report.error ?? '生成失败' });
      }
      sse.send('report', { id: report.id, status: report.status });
    } catch (error) {
      sse.send('error', { message: String(error?.message ?? error) });
    } finally {
      clearInterval(timer);
      sse.end();
    }
  });
}
