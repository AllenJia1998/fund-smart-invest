/**
 * Turso 存储连通性自检。
 * 用法：
 *   TURSO_URL=libsql://xxx.turso.io TURSO_TOKEN=xxx node scripts/check-storage.js
 * 或先在 .env 里配好，直接 node scripts/check-storage.js
 */
import { config } from '../server/config.js';
import { tursoExecute, tursoHealth } from '../server/lib/turso.js';

const health = await tursoHealth();
console.log('');
console.log('════ Turso 存储自检 ════');
console.log('  配置状态:', health.configured ? '已配置' : '未配置');
if (health.host) console.log('  数据库主机:', health.host);
console.log('  连通性  :', health.ok ? '✅ 正常' : `❌ ${health.reason}`);

if (!health.ok) {
  console.log('');
  console.log('  排查建议：');
  console.log('   1. TURSO_URL 形如 libsql://<库名>-<组织名>.turso.io');
  console.log('   2. TURSO_TOKEN 是「数据库令牌」，不是平台 API Token');
  console.log('   3. 确认该令牌对该数据库有读写权限');
  process.exit(1);
}

// 建表 + 读写回环测试
try {
  await tursoExecute(
    'CREATE TABLE IF NOT EXISTS fsi_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER)'
  );
  const probeKey = '__selfcheck__';
  await tursoExecute(
    'INSERT INTO fsi_kv (k, v, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
    [probeKey, JSON.stringify({ at: Date.now() }), Date.now()]
  );
  const { rows } = await tursoExecute('SELECT v FROM fsi_kv WHERE k = ?', [probeKey]);
  await tursoExecute('DELETE FROM fsi_kv WHERE k = ?', [probeKey]);

  console.log('  建表    : ✅ fsi_kv 就绪');
  console.log('  写入    : ✅');
  console.log('  读取    : ✅', rows[0]?.[0] ? '数据回读一致' : '未读到数据');
  console.log('  清理    : ✅');
  console.log('');
  console.log('  🎉 Turso 可正常作为持久化后端使用。');
  console.log('     把这两个变量加到部署环境（如 Render 的 Environment）后，');
  console.log('     报告 / 会话 / 自选 / 知识库就能跨重启保留了。');
  if (config.turso.url) console.log('');
} catch (error) {
  console.error('');
  console.error('  ❌ 读写测试失败：', error.message);
  process.exit(1);
}
