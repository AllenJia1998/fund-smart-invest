/**
 * 知识库种子导入：把 knowledge/*.md 导入本地知识库。
 * 用法：node scripts/seed-kb.js
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDocument, kbStats, listDocuments } from '../server/services/kb.js';
import { ROOT } from '../server/config.js';

const dir = join(ROOT, 'knowledge');
const existing = new Set(listDocuments().map((d) => d.title));

let imported = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(join(dir, file), 'utf8');
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file;
  if (existing.has(title)) {
    console.log(`跳过（已存在）：${title}`);
    continue;
  }
  const result = addDocument({ title, text, source: `knowledge/${file}`, tags: ['种子文档'] });
  console.log(`导入：${title} → ${result.chunks} 个片段 / ${result.chars} 字`);
  imported += 1;
}

console.log(`\n完成，本次导入 ${imported} 篇。当前知识库：`, kbStats());
