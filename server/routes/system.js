/** 系统路由：运行状态、数据源健康、skills 挂载、tools 清单、资讯。 */
import { existsSync } from 'node:fs';
import { sendJson } from '../lib/http.js';
import { authStatus, guard } from '../lib/auth.js';
import { config, OCR_BIN, paths } from '../config.js';
import { kbStats } from '../services/kb.js';
import { llmStatus } from '../services/llm.js';
import { fetchNews, newsStats } from '../services/news.js';
import { listSkills, setMounted } from '../services/skills.js';
import { listTools } from '../services/tools.js';
import { sourceStatus } from '../providers/index.js';

export function registerSystemRoutes(router) {
  router.get('/api/status', async ({ res }) => {
    const [source] = await Promise.all([sourceStatus()]);
    sendJson(res, {
      ok: true,
      data: {
        app: '基金智投',
        time: new Date().toISOString(),
        llm: llmStatus(),
        dataSource: source,
        ocr: {
          available: existsSync(OCR_BIN),
          engine: 'macOS Vision（Swift 原生二进制）',
          languages: ['zh-Hans', 'en-US'],
          path: OCR_BIN.replace(paths.ROOT + '/', ''),
        },
        kb: kbStats(),
        skills: listSkills(),
        tools: listTools(),
        pushCron: config.pushCron,
        access: authStatus(),
      },
    });
  });

  router.get('/api/skills', async ({ res }) => {
    sendJson(res, { ok: true, data: listSkills() });
  });

  router.post('/api/skills/:name/mount', async ({ res, params, body, req, url }) => {
    const denied = guard(req, url, null);
    if (denied) throw Object.assign(new Error(denied.error), { statusCode: denied.status });
    sendJson(res, { ok: true, data: setMounted(params.name, body.mounted !== false) });
  });

  router.get('/api/tools', async ({ res }) => {
    sendJson(res, { ok: true, data: listTools() });
  });

  router.get('/api/news', async ({ res, url }) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 40) || 40, 200);
    const category = url.searchParams.get('category');
    const items = await fetchNews({ limit: 150 });
    const filtered = category && category !== '全部'
      ? items.filter((n) => n.categories.includes(category))
      : items;
    sendJson(res, {
      ok: true,
      data: { items: filtered.slice(0, limit), stats: newsStats(items) },
    });
  });
}
