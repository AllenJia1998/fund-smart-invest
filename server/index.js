/**
 * 基金智投 服务端入口。
 * 零第三方依赖：node:http + 自建路由 + 静态文件服务。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { config, paths, assertConfig } from './config.js';
import { readJsonBody, sendError, sendJson, serveStatic } from './lib/http.js';
import { createRouter } from './lib/router.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerFundRoutes } from './routes/funds.js';
import { registerKbRoutes } from './routes/kb.js';
import { registerPushRoutes } from './routes/push.js';
import { registerSystemRoutes } from './routes/system.js';
import { startScheduler } from './services/push.js';

const router = createRouter();
registerSystemRoutes(router);
registerFundRoutes(router);
registerChatRoutes(router);
registerPushRoutes(router);
registerKbRoutes(router);

for (const dir of [paths.DATA_DIR, paths.UPLOAD_DIR, paths.SKILLS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    if (serveStatic(paths.PUBLIC_DIR, pathname, res)) return;
    // 未命中的页面路径回落到首页
    if (!pathname.includes('.')) {
      if (serveStatic(paths.PUBLIC_DIR, '/index.html', res)) return;
    }
    sendJson(res, { ok: false, error: 'not found' }, 404);
    return;
  }

  try {
    const matched = await router.handle({ method: req.method, pathname });
    if (!matched) {
      sendJson(res, { ok: false, error: `未知接口 ${req.method} ${pathname}` }, 404);
      return;
    }
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await readJsonBody(req);
    }
    await matched.handler({ req, res, body, url, params: matched.params });
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  const problems = assertConfig();
  console.log('');
  console.log('  基金智投 · FundSmartInvest');
  console.log('  ─────────────────────────────────────────');
  console.log(`  ▸ 服务地址   http://${config.host}:${config.port}`);
  console.log(`  ▸ DeepSeek   ${config.deepseek.model} / 分析模型 ${config.deepseek.analystModel}`);
  console.log(`  ▸ 凭据来源   ${config.deepseek.source}`);
  console.log(`  ▸ 数据源     ${config.fundProvider}`);
  console.log('  ─────────────────────────────────────────');
  if (problems.length > 0) {
    console.log('  ⚠ 需要注意：');
    for (const p of problems) console.log(p);
  }
  console.log('');
  startScheduler();
});
