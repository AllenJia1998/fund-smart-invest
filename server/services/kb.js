/**
 * 知识库（KB）：文本切块 + 轻量 TF-IDF 检索。
 *
 * 不引入向量数据库依赖：对基金/财经这类术语密集、规模中等的语料，
 * TF-IDF + 余弦相似度已经足够，且完全可解释、零外部依赖。
 */
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { Collection, newId, readJson, writeJson } from '../lib/store.js';

const docCol = new Collection('kb-docs');
const INDEX_FILE = join(DATA_DIR, 'kb-index.json');

/** 中英文混合分词：中文按 2-gram，英文/数字按词。 */
export function tokenize(text) {
  const lower = String(text).toLowerCase();
  const tokens = [];
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length > 1) tokens.push(word);
  }
  const cjk = lower.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/** 按段落/长度切块，保留少量重叠以免切断语义。 */
export function chunkText(text, { size = 500, overlap = 80 } = {}) {
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  if (normalized.length <= size) return normalized ? [normalized] : [];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks = [];
  let buffer = '';
  for (const para of paragraphs) {
    if ((buffer + '\n\n' + para).length <= size) {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
      continue;
    }
    if (buffer) chunks.push(buffer);
    if (para.length <= size) {
      buffer = para;
    } else {
      for (let i = 0; i < para.length; i += size - overlap) {
        chunks.push(para.slice(i, i + size));
      }
      buffer = '';
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.filter((c) => c.trim().length > 0);
}

function loadIndex() {
  return readJson(INDEX_FILE, { chunks: [], df: {}, total: 0 });
}

/** 重建 TF-IDF 索引。 */
export function rebuildIndex() {
  const docs = docCol.all();
  const chunks = [];
  for (const doc of docs) {
    for (const [i, text] of doc.chunks.entries()) {
      const tokens = tokenize(text);
      const tf = {};
      for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
      chunks.push({
        id: `${doc.id}#${i}`,
        docId: doc.id,
        title: doc.title,
        source: doc.source,
        text,
        tf,
        length: tokens.length,
      });
    }
  }
  const df = {};
  for (const chunk of chunks) {
    for (const term of Object.keys(chunk.tf)) df[term] = (df[term] ?? 0) + 1;
  }
  const index = { chunks, df, total: chunks.length, builtAt: Date.now() };
  writeJson(INDEX_FILE, index);
  return index;
}

/** 新增知识文档并增量重建索引。 */
export function addDocument({ title, text, source = 'manual', tags = [] }) {
  const chunks = chunkText(text);
  const doc = docCol.insert({
    id: newId('doc'),
    title: title || '未命名文档',
    source,
    tags,
    chars: text.length,
    chunks,
    createdAt: Date.now(),
  });
  rebuildIndex();
  return { id: doc.id, title: doc.title, chunks: doc.chunks.length, chars: doc.chars };
}

export function listDocuments() {
  return docCol.all().map((d) => ({
    id: d.id,
    title: d.title,
    source: d.source,
    tags: d.tags,
    chars: d.chars,
    chunks: d.chunks.length,
    createdAt: d.createdAt,
  }));
}

export function removeDocument(id) {
  const ok = docCol.remove(id);
  if (ok) rebuildIndex();
  return ok;
}

/** 余弦相似度检索。 */
export function search(query, limit = 4) {
  const index = loadIndex();
  if (index.chunks.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const qtf = {};
  for (const t of queryTokens) qtf[t] = (qtf[t] ?? 0) + 1;
  const N = index.chunks.length;

  const scored = index.chunks.map((chunk) => {
    let dot = 0;
    let qNorm = 0;
    let dNorm = 0;
    for (const [term, count] of Object.entries(qtf)) {
      const idf = Math.log(1 + N / (1 + (index.df[term] ?? 0)));
      const qw = (count / queryTokens.length) * idf;
      qNorm += qw * qw;
      const dCount = chunk.tf[term] ?? 0;
      if (dCount > 0) {
        const dw = (dCount / chunk.length) * idf;
        dot += qw * dw;
        dNorm += dw * dw;
      }
    }
    const score = qNorm > 0 && dNorm > 0 ? dot / (Math.sqrt(qNorm) * Math.sqrt(dNorm)) : 0;
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({
      id: s.chunk.id,
      title: s.chunk.title,
      source: s.chunk.source,
      score: Number(s.score.toFixed(4)),
      text: s.chunk.text,
    }));
}

export function kbStats() {
  const index = loadIndex();
  return {
    documents: docCol.all().length,
    chunks: index.chunks.length,
    terms: Object.keys(index.df).length,
    builtAt: index.builtAt ?? null,
  };
}

/** 检索结果拼成可注入的上下文块。 */
export function kbContext(query, limit = 4) {
  const hits = search(query, limit);
  if (hits.length === 0) return { text: '', hits: [] };
  const text = [
    '## 知识库检索结果',
    '以下是与本轮问题相关的知识库片段，请优先依据它们回答，并标注来源：',
    ...hits.map((h, i) => `[${i + 1}] 来源《${h.title}》\n${h.text}`),
  ].join('\n\n');
  return { text, hits };
}
