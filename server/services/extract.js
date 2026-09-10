/**
 * 文件内容提取：图片 OCR + 文档正文解析。
 *
 * - 图片：调用 tools/ocr 下用 Swift + macOS Vision 框架编译的原生二进制，
 *         支持中英文识别（DeepSeek 公开 API 不支持图片输入，故由 harness 侧兜底）。
 * - 文档：纯文本/JSON/CSV/Markdown 直接解码；
 *         DOCX/XLSX 走内置极简 ZIP 读取器解析 XML；
 *         PDF 走内置流解压 + 文本算子提取。
 */
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { OCR_BIN } from '../config.js';

const execFileAsync = promisify(execFile);

/** 对图片文件执行 OCR，返回识别文本。 */
export async function ocrImage(filePath) {
  if (!existsSync(OCR_BIN)) {
    throw new Error('OCR 二进制缺失，请运行 npm run ocr 编译');
  }
  try {
    const { stdout } = await execFileAsync(OCR_BIN, [filePath], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TMPDIR: tmpdir() },
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`OCR 失败：${error.message}`);
  }
}

/** OCR 一段 base64 图片数据。 */
export async function ocrBase64(base64, ext = '.png') {
  const dir = mkdtempSync(join(tmpdir(), 'fsi-ocr-'));
  const file = join(dir, `input${ext}`);
  writeFileSync(file, Buffer.from(base64, 'base64'));
  return ocrImage(file);
}

/* ------------------------------------------------------------------ */
/* 极简 ZIP 读取器（DOCX / XLSX 都是 ZIP 容器）                          */
/* ------------------------------------------------------------------ */

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 容器');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let content;
    try {
      content = method === 0 ? raw : inflateRawSync(raw);
    } catch {
      content = Buffer.alloc(0);
    }
    entries.set(name, content);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

function extractDocx(buf) {
  const entries = readZipEntries(buf);
  const xml = entries.get('word/document.xml');
  if (!xml) throw new Error('DOCX 缺少 word/document.xml');
  const text = xml
    .toString('utf8')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return unescapeXml(text).replace(/\n{3,}/g, '\n\n').trim();
}

function extractXlsx(buf) {
  const entries = readZipEntries(buf);
  const shared = entries.get('xl/sharedStrings.xml');
  const strings = [];
  if (shared) {
    const xml = shared.toString('utf8');
    for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
      strings.push(parts.join(''));
    }
  }
  const out = [];
  for (const [name, content] of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = content.toString('utf8');
    out.push(`### ${name}`);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c[^>]*?(?:\st="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)) {
        const type = cell[1];
        const vMatch = cell[2].match(/<v>([\s\S]*?)<\/v>/);
        const inlineMatch = cell[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
        if (type === 's' && vMatch) cells.push(strings[Number(vMatch[1])] ?? '');
        else if (inlineMatch) cells.push(unescapeXml(inlineMatch[1]));
        else if (vMatch) cells.push(unescapeXml(vMatch[1]));
        else cells.push('');
      }
      if (cells.some((c) => c !== '')) out.push(cells.join('\t'));
    }
  }
  return out.join('\n');
}

/** 从 PDF 中做基础文本提取（FlateDecode + Tj/TJ 算子）。 */
function extractPdf(buf) {
  const chunks = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let index = 0;

  while (index < buf.length) {
    const start = buf.indexOf(marker, index);
    if (start < 0) break;
    let dataStart = start + marker.length;
    if (buf[dataStart] === 0x0d) dataStart += 1;
    if (buf[dataStart] === 0x0a) dataStart += 1;
    const end = buf.indexOf(endMarker, dataStart);
    if (end < 0) break;
    const raw = buf.subarray(dataStart, end);

    let text;
    try {
      text = inflateSync(raw).toString('latin1');
    } catch {
      text = raw.toString('latin1');
    }
    chunks.push(text);
    index = end + endMarker.length;
  }

  const decoded = chunks.join('\n');
  const pieces = [];
  // (string) Tj  与  [ ... ] TJ
  for (const match of decoded.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\]\\]|\\.)*\]\s*TJ/g)) {
    const token = match[0];
    const literal = [...token.matchAll(/\((?:\\.|[^\\()])*\)/g)]
      .map((m) =>
        m[0]
          .slice(1, -1)
          .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '' }[c] ?? c))
      )
      .join('');
    if (literal.trim()) pieces.push(literal);
  }
  return pieces.join(' ').replace(/\s{3,}/g, '\n').trim();
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.yaml', '.yml', '.js', '.mjs', '.ts', '.py', '.css', '.sql', '.ini', '.conf']);
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.heic']);

/**
 * 统一入口：根据文件类型提取可读文本。
 * @returns {{kind:'image'|'document'|'unknown', text:string, method:string}}
 */
export async function extractFile(buffer, filename) {
  const ext = extname(filename || '').toLowerCase();

  if (IMAGE_EXT.has(ext)) {
    const dir = mkdtempSync(join(tmpdir(), 'fsi-img-'));
    const file = join(dir, `input${ext}`);
    writeFileSync(file, buffer);
    const text = await ocrImage(file);
    return { kind: 'image', text, method: 'macOS Vision OCR（中英文）' };
  }

  if (ext === '.docx') {
    return { kind: 'document', text: extractDocx(buffer), method: 'DOCX 解析' };
  }
  if (ext === '.xlsx') {
    return { kind: 'document', text: extractXlsx(buffer), method: 'XLSX 解析' };
  }
  if (ext === '.pdf') {
    const text = extractPdf(buffer);
    return {
      kind: 'document',
      text,
      method: text ? 'PDF 文本层提取' : 'PDF 可提取文本为空（可能是扫描件，建议转图片后走 OCR）',
    };
  }
  if (TEXT_EXT.has(ext) || ext === '') {
    return { kind: 'document', text: buffer.toString('utf8'), method: '纯文本解码' };
  }

  // 未知类型：按文本尝试，失败则给出明确说明
  const asText = buffer.toString('utf8');
  const printable = asText.replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fa5]/g, '');
  if (printable.length > asText.length * 0.7) {
    return { kind: 'document', text: asText, method: '按文本尝试解码' };
  }
  return {
    kind: 'unknown',
    text: '',
    method: `暂不支持的类型 ${ext || '(无扩展名)'}，请提供图片、PDF、DOCX、XLSX 或纯文本`,
  };
}
