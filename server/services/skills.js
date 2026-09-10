/**
 * Skills 挂载系统。
 *
 * 每个 skill 是一个目录，内含 SKILL.md（YAML frontmatter + 正文指令），
 * 与 Claude Code / Codex 的技能约定保持一致。挂载后其指令会被注入 Agent
 * 的系统提示，可按需启用/停用，实现能力的"插拔"。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SKILLS_DIR } from '../config.js';
import { Collection } from '../lib/store.js';

const mountCol = new Collection('skill-mounts');

/** 解析 SKILL.md 的 frontmatter。 */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

function scanDir(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const skillFile = join(full, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const { meta, body } = parseFrontmatter(readFileSync(skillFile, 'utf8'));
    out.push({
      name: meta.name || entry,
      description: meta.description || '',
      body,
      dir: full,
      builtin: false,
    });
  }
  return out;
}

export function listSkills() {
  if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
  const skills = scanDir(SKILLS_DIR);
  const mounts = new Map(mountCol.all().map((m) => [m.id, m]));
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    mounted: mounts.get(skill.name)?.mounted ?? true,
    source: 'project',
    path: `skills/${skill.name}/SKILL.md`,
  }));
}

export function getSkill(name) {
  return scanDir(SKILLS_DIR).find((s) => s.name === name);
}

export function setMounted(name, mounted) {
  if (mountCol.find((m) => m.id === name)) mountCol.update(name, { mounted });
  else mountCol.insert({ id: name, mounted });
  return listSkills();
}

/** 取所有已挂载 skill 的正文，拼成注入系统提示的段落。 */
export function mountedInstructions() {
  const list = listSkills().filter((s) => s.mounted);
  if (list.length === 0) return '';
  const blocks = list
    .map((s) => {
      const skill = getSkill(s.name);
      if (!skill) return null;
      return `<skill name="${s.name}">\n${skill.body}\n</skill>`;
    })
    .filter(Boolean);
  if (blocks.length === 0) return '';
  return [
    '## 已挂载的技能（Skills）',
    '下面是当前挂载的技能指令，请在回答时遵循：',
    ...blocks,
  ].join('\n\n');
}
