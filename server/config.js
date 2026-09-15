/**
 * 全局配置与凭据解析。
 *
 * DeepSeek API Key 解析优先级：
 *   1. 进程环境变量 DEEPSEEK_API_KEY
 *   2. 项目根目录 .env 文件
 *   3. DeepSeek Harness 的凭据文件 ~/.dsh/.credentials.yaml
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = join(ROOT, 'public');
export const DATA_DIR = join(ROOT, 'data');
export const SKILLS_DIR = join(ROOT, 'skills');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
export const OCR_BIN = join(ROOT, 'tools', 'ocr', 'ocr-bin');

/** 解析 .env（形如 KEY=VALUE，忽略注释与空行）。 */
function readEnvFile() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 从 DSH 凭据文件里取出 DEEPSEEK_API_KEY（避免为一行数据引入 yaml 依赖）。 */
function readDshCredential() {
  const file = join(homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(file)) return undefined;
  const match = readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
  return match?.[1];
}

function resolveDeepSeekKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fileEnv = readEnvFile();
  if (fileEnv.DEEPSEEK_API_KEY) return { key: fileEnv.DEEPSEEK_API_KEY, source: '.env' };
  const dsh = readDshCredential();
  if (dsh) return { key: dsh, source: '~/.dsh/.credentials.yaml' };
  return { key: undefined, source: 'none' };
}

const deepseek = resolveDeepSeekKey();
const envFile = readEnvFile();

/**
 * 访问口令：保护消耗 DeepSeek 额度的接口。
 * 未显式配置时自动生成并持久化到 data/access-code.txt，
 * 保证「默认即受保护」且重启后口令不变。
 */
function resolveAccessCode() {
  const explicit = process.env.ACCESS_CODE ?? envFile.ACCESS_CODE;
  if (explicit) return { code: explicit, generated: false };

  const file = join(ROOT, 'data', 'access-code.txt');
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return { code: saved, generated: false };
  }
  const code = Array.from({ length: 4 }, () =>
    Math.random().toString(36).slice(2, 6).toUpperCase()
  ).join('-');
  try {
    const dir = join(ROOT, 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, code, 'utf8');
  } catch {
    /* 写不了也不影响启动，只是口令每次变化 */
  }
  return { code, generated: true };
}

const access = resolveAccessCode();

/** 允许跨域的来源：GitHub Pages 等静态前端会跨域调用本后端。 */
function resolveCorsOrigins() {
  const raw = process.env.CORS_ORIGINS ?? envFile.CORS_ORIGINS ?? '*';
  return raw === '*' ? '*' : raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  // 默认 5399 而非 5173：后者常被 Vite 等前端脚手架占用（本机确有其它项目在用），
  // 端口重叠会导致浏览器访问到错误的站点。
  port: Number(process.env.PORT ?? envFile.PORT ?? 5399),
  host: process.env.HOST ?? '0.0.0.0',

  /** 访问口令（保护 AI 对话与报告生成） */
  accessCode: access.code,
  accessCodeGenerated: access.generated,

  /** 跨域白名单：'*' 或逗号分隔的来源列表 */
  corsOrigins: resolveCorsOrigins(),

  /**
   * 持久化存储（可选）。
   * 云平台（Render 免费实例等）的文件系统是临时的，重启即清空，
   * 因此把数据落到 Turso（SQLite 云）上。未配置时退回本地 JSON 文件。
   */
  turso: {
    url: process.env.TURSO_URL ?? envFile.TURSO_URL ?? '',
    token: process.env.TURSO_TOKEN ?? envFile.TURSO_TOKEN ?? '',
  },

  deepseek: {
    key: deepseek.key,
    source: deepseek.source,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? envFile.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    /** 对话/推理主模型 */
    model: process.env.DEEPSEEK_MODEL ?? envFile.DEEPSEEK_MODEL ?? 'deepseek-flash',
    /** 复杂分析（投资建议、趋势预测）用更强模型 */
    analystModel:
      process.env.DEEPSEEK_ANALYST_MODEL ?? envFile.DEEPSEEK_ANALYST_MODEL ?? 'deepseek-v4-pro',
  },

  /** 行情数据源：eastmoney（默认，可用） / antfortune（支付宝蚂蚁财富） */
  fundProvider: process.env.FUND_PROVIDER ?? envFile.FUND_PROVIDER ?? 'eastmoney',
  /** 实时数据缓存毫秒数，避免高频打爆上游 */
  quoteTtlMs: Number(process.env.QUOTE_TTL_MS ?? 20_000),

  /** 每日推送定时任务 cron 表达式（默认每天 14:10，收盘后） */
  pushCron: process.env.PUSH_CRON ?? envFile.PUSH_CRON ?? '10 14 * * 1-5',
};

export const paths = { PUBLIC_DIR, DATA_DIR, SKILLS_DIR, UPLOAD_DIR, OCR_BIN, ROOT };

export function assertConfig() {
  const problems = [];
  if (!config.deepseek.key) {
    problems.push(
      '  • 缺少 DEEPSEEK_API_KEY：请设置环境变量、或在项目根目录创建 .env 写入 DEEPSEEK_API_KEY=sk-xxx'
    );
  }
  if (!existsSync(OCR_BIN)) {
    problems.push(`  • OCR 二进制缺失：${OCR_BIN}（运行 npm run ocr 重新编译）`);
  }
  return problems;
}
