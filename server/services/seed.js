/**
 * 启动期自动初始化。
 *
 * 云平台（Render / Railway 等）的免费实例磁盘是临时的，每次重新部署都会清空
 * data/。而 knowledge/ 目录随仓库一起发布，因此这里在启动时检查：知识库为空就
 * 自动重新导入，保证每次冷启动后知识库都是可用的。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';
import { addDocument, kbStats } from './kb.js';

export function autoSeedKnowledgeBase() {
  const knowledgeDir = join(ROOT, 'knowledge');
  if (!existsSync(knowledgeDir)) return { seeded: 0, reason: '无 knowledge/ 目录' };

  const stats = kbStats();
  if (stats.documents > 0) {
    return { seeded: 0, reason: `知识库已有 ${stats.documents} 篇，跳过` };
  }

  let seeded = 0;
  for (const file of readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'))) {
    try {
      const text = readFileSync(join(knowledgeDir, file), 'utf8');
      const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file;
      addDocument({ title, text, source: `knowledge/${file}`, tags: ['种子文档'] });
      seeded += 1;
    } catch (error) {
      console.warn(`[seed] 导入 ${file} 失败：${error.message}`);
    }
  }
  return { seeded, reason: seeded > 0 ? `已导入 ${seeded} 篇` : '无可用文档' };
}
