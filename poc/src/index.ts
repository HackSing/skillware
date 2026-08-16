import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LIBRARY_ROOT, LIBRARY_ID, EXCLUDE_DIRS } from "./config.js";

export interface SkillRecord {
  skill_id: string; // `${LIBRARY_ID}:${relative_path}`
  name: string;
  short_description: string;
  keywords: string[];
  library_id: string;
  relative_path: string; // 相对 LIBRARY_ROOT 的 SKILL.md 路径
  package_dir: string; // Skill Package 根目录，相对 LIBRARY_ROOT
  abs_path: string; // 绝对路径，仅内部使用，不返回给模型
  content_hash: string;
  size: number;
}

function unquote(s: string): string {
  return s.replace(/^["']/, "").replace(/["']$/, "").trim();
}

function parseList(inline: string, lines: string[], idx: number): string[] {
  const t = inline.trim();
  if (t.startsWith("[")) {
    return t
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((x) => unquote(x.trim()))
      .filter(Boolean);
  }
  // 块状列表：随后的 "  - item" 行
  const items: string[] = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const lm = lines[j].match(/^\s*-\s+(.*)$/);
    if (!lm) break;
    items.push(unquote(lm[1].trim()));
  }
  return items;
}

// 极简 frontmatter 解析：只取 name / description / keywords。夹具格式可控，MVP 不引入 YAML 依赖。
function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
  keywords?: string[];
} {
  const out: { name?: string; description?: string; keywords?: string[] } = {};
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === "name") out.name = unquote(val);
    else if (key === "description") out.description = unquote(val);
    // keywords 与 triggers 都是人工标注的触发词，合并利用（真实技能多用 triggers）
    else if (key === "keywords" || key === "triggers") {
      out.keywords = (out.keywords ?? []).concat(parseList(val, lines, i));
    }
  }
  return out;
}

function walk(dir: string, acc: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 缺失/无权限目录跳过，不阻断其他目录
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && e.name === "SKILL.md") acc.push(full);
  }
}

// 内存级极简索引：启动时一次性扫描。阶段 0 不做 SQLite / 增量 / 监听。
export function buildIndex(): SkillRecord[] {
  const files: string[] = [];
  walk(LIBRARY_ROOT, files);
  const records: SkillRecord[] = [];
  for (const abs of files) {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(abs);
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw.toString("utf8"));
    const relative_path = path.relative(LIBRARY_ROOT, abs);
    const dir = path.dirname(relative_path);
    const package_dir = dir === "." ? "" : dir;
    records.push({
      skill_id: `${LIBRARY_ID}:${relative_path}`,
      name: fm.name ?? path.basename(path.dirname(abs)),
      short_description: fm.description ?? "",
      keywords: fm.keywords ?? [],
      library_id: LIBRARY_ID,
      relative_path,
      package_dir,
      abs_path: abs,
      content_hash: "sha256:" + crypto.createHash("sha256").update(raw).digest("hex"),
      size: raw.length,
    });
  }
  // 稳定排序，保证相同库/查询下确定性
  records.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  return records;
}
