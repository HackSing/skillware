#!/usr/bin/env node
// 被动轨周报（实验 C §6 / §7 Token 记账）。零第三方依赖，纯 Node ≥18。
//
// 扫描 Claude Code 会话转录（*.jsonl），统计 skill_search / skill_read 触发情况
// 与四类 token 用量，附全量注入成本估算，输出 markdown 周报到 stdout。
//
// CLI：node report.mjs [--dir <转录目录>]... [--all-projects] [--since <YYYY-MM-DD>] [--library <技能库路径>]
//   --dir 可重复出现（多项目分别统计 + 合计）；--all-projects 自动扫描 ~/.claude/projects 下
//   所有含 *.jsonl 的项目目录。两者都省略时默认 dsh-buddy 单项目。
//
// 为何未复用 poc/dist 的编译产物做技能库扫描：dist/config.js 在模块加载时一次性把
// LIBRARY_ROOT 绑定到 ASKILL_LIBRARY 环境变量，无法干净地按本脚本的 --library 参数取库；
// 且其排除集只含 node_modules/.git，与本报告要求的“排除全部点目录 + node_modules”口径不同。
// 故此处按 poc/src/index.ts 的扫描思路独立实现一份最小版本（仅取 name/description）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// MCP 前缀（mcp__askill__skill_search）与裸名（skill_read）都要匹配。
const SKILL_TOOL_RE = /(^|__)skill_(search|read)$/;

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const HOME = os.homedir();
  const expand = (p) => (p.startsWith("~") ? path.join(HOME, p.slice(1)) : p);

  const DEFAULT_DIR = path.join(HOME, ".claude/projects/-Users-aiware-projects-dsh-buddy");
  const dirs = [];
  let allProjects = false;
  let library = "/Users/aiware/projects/opc-skills";

  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  let since = d.toISOString().slice(0, 10); // 默认今天减 7 天（UTC 日期）

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      const v = argv[++i];
      if (v) dirs.push(expand(v));
    } else if (a === "--all-projects") allProjects = true;
    else if (a === "--since") since = argv[++i] ?? since;
    else if (a === "--library") library = expand(argv[++i] ?? library);
  }

  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(since) ? since + "T00:00:00.000Z" : since);
  return {
    dirs: dirs.length > 0 ? dirs : [DEFAULT_DIR],
    allProjects,
    since,
    sinceMs: Number.isNaN(parsed) ? -Infinity : parsed,
    library,
  };
}

// --all-projects：~/.claude/projects 下所有含 *.jsonl 的项目目录（稳定排序）。
export function resolveDirs(opts) {
  if (!opts.allProjects) return opts.dirs;
  const root = path.join(os.homedir(), ".claude/projects");
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    let has = false;
    try {
      has = fs.readdirSync(p).some((f) => f.endsWith(".jsonl"));
    } catch {
      // 不可读目录跳过
    }
    if (has) out.push(p);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 读入层一次性防御：把一行原始文本规整成可信结构，或判定为损坏（返回 null）。
// 此函数之后的逻辑信任返回结构，不再层层判空。
// ---------------------------------------------------------------------------
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toMs(ts) {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // 无法解析 → 损坏
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;

  const message = obj.message && typeof obj.message === "object" ? obj.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const toolUses = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "tool_use") {
      toolUses.push({
        name: typeof block.name === "string" ? block.name : "",
        input: block.input && typeof block.input === "object" ? block.input : {},
      });
    }
  }
  const u = message.usage && typeof message.usage === "object" ? message.usage : {};
  return {
    type: typeof obj.type === "string" ? obj.type : "",
    timestampRaw: typeof obj.timestamp === "string" ? obj.timestamp : "",
    timestampMs: toMs(obj.timestamp),
    toolUses,
    usage: {
      input: num(u.input_tokens),
      cacheCreation: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      output: num(u.output_tokens),
    },
  };
}

// ---------------------------------------------------------------------------
// 转录扫描
// ---------------------------------------------------------------------------
export function scanTranscripts(dir, sinceMs) {
  const result = {
    dir,
    sessions: [],
    sessionCount: 0,
    sessionsWithSearch: 0,
    corruptLines: 0,
    assistantRequests: 0,
    searchCount: 0,
    readCount: 0,
    triggers: [],
    totals: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
  };

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    files = []; // 目录缺失/无权限 → 视作无匹配文件
  }
  result.sessionCount = files.length;

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }

    const session = {
      file,
      searchCount: 0,
      readCount: 0,
      assistantRequests: 0,
      tokens: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
      triggers: [],
    };

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue; // 空行不计入损坏

      const record = normalizeLine(line);
      if (record === null) {
        result.corruptLines++;
        continue;
      }
      // since 过滤：无法定位到时间窗内的行不参与统计（损坏行已在上面独立计数）。
      if (record.timestampMs === null || record.timestampMs < sinceMs) continue;
      if (record.type !== "assistant") continue;

      session.assistantRequests++;
      session.tokens.input += record.usage.input;
      session.tokens.cacheCreation += record.usage.cacheCreation;
      session.tokens.cacheRead += record.usage.cacheRead;
      session.tokens.output += record.usage.output;

      for (const tu of record.toolUses) {
        const m = tu.name.match(SKILL_TOOL_RE);
        if (!m) continue;
        const kind = m[2]; // "search" | "read"
        if (kind === "search") {
          session.searchCount++;
          session.triggers.push({
            file,
            timestamp: record.timestampRaw,
            tool: "skill_search",
            query: typeof tu.input.query === "string" ? tu.input.query : "",
            target: typeof tu.input.query === "string" ? tu.input.query : "",
            followedByRead: false, // 稍后回填
          });
        } else {
          const target =
            (typeof tu.input.skill_id === "string" && tu.input.skill_id) ||
            (typeof tu.input.package_ref === "string" && "package_ref:" + tu.input.package_ref) ||
            "";
          session.triggers.push({
            file,
            timestamp: record.timestampRaw,
            tool: "skill_read",
            query: target,
            target,
            followedByRead: null, // read 行本列不适用
          });
        }
      }
    }

    // 回填：同一会话内、按文件（时间）顺序，某次 search 之后是否出现 skill_read。
    for (let i = 0; i < session.triggers.length; i++) {
      const t = session.triggers[i];
      if (t.tool !== "skill_search") continue;
      t.followedByRead = session.triggers.slice(i + 1).some((x) => x.tool === "skill_read");
    }

    // session.readCount 以 read 触发条数为单一真源
    session.readCount = session.triggers.filter((x) => x.tool === "skill_read").length;

    if (session.searchCount > 0) result.sessionsWithSearch++;
    result.assistantRequests += session.assistantRequests;
    result.totals.input += session.tokens.input;
    result.totals.cacheCreation += session.tokens.cacheCreation;
    result.totals.cacheRead += session.tokens.cacheRead;
    result.totals.output += session.tokens.output;
    result.triggers.push(...session.triggers);
    result.sessions.push(session);
  }

  // 触发计数以最终 triggers 为准，保持单一真源。
  result.searchCount = result.triggers.filter((t) => t.tool === "skill_search").length;
  result.readCount = result.triggers.filter((t) => t.tool === "skill_read").length;
  return result;
}

// ---------------------------------------------------------------------------
// 技能库扫描 + 全量注入 token 估算
// ---------------------------------------------------------------------------
function walkSkillFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 缺失/无权限目录跳过，不阻断其他目录
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue; // 排除点目录与 node_modules
      walkSkillFiles(path.join(dir, e.name), acc);
    } else if (e.isFile() && e.name === "SKILL.md") {
      acc.push(path.join(dir, e.name));
    }
  }
}

// 极简 frontmatter：只取 name / description（与 poc/src/index.ts 的思路一致，MVP 不引 YAML）。
function parseFrontmatter(text) {
  const out = {};
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim().replace(/^["']/, "").replace(/["']$/, "").trim();
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
  }
  return out;
}

// 启发式估算：CJK 表意/假名字符每字≈1 token，其余按≈4 字符/token。仅估算，非实测。
function estimateTokens(text) {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
      (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
      (cp >= 0x3040 && cp <= 0x30ff) // 平/片假名
    ) {
      cjk++;
    }
  }
  const rest = total - cjk;
  return cjk + Math.ceil(rest / 4);
}

export function estimateLibrary(libraryPath) {
  const files = [];
  walkSkillFiles(libraryPath, files);
  const entries = [];
  for (const abs of files) {
    let raw;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    entries.push({
      name: fm.name || path.basename(path.dirname(abs)),
      description: fm.description || "",
    });
  }
  // 稳定排序，保证同库确定性
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description));
  const catalog = entries.map((e) => `- ${e.name}: ${e.description}`).join("\n");
  return {
    libraryPath,
    skillCount: entries.length,
    visibleChars: [...catalog].length,
    estTokens: estimateTokens(catalog),
  };
}

// ---------------------------------------------------------------------------
// 渲染 markdown（无颜色码）
// ---------------------------------------------------------------------------
function mdEscape(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderReport(stats, lib, opts, nowIso) {
  const out = [];
  out.push("# 被动轨周报：skill_search / skill_read 触发与 token 记账");
  out.push("");
  out.push(
    `> 生成时间：${nowIso}  ·  时间窗：timestamp ≥ ${opts.since}  ·  转录目录：${opts.dir}`
  );
  out.push("> 口径见 docs/EXPERIMENT_C_PLAN.md §6（被动轨）、§7（Token 记账）。");
  out.push("");

  const noData = stats.sessionCount === 0;
  if (noData) {
    out.push("> **本期无数据**：目录为空或无匹配的 `*.jsonl` 文件。以下为报告骨架。");
    out.push("");
  }

  // 概览
  out.push("## 概览");
  out.push("");
  out.push(`- 会话数：${stats.sessionCount}`);
  out.push(`- 含 skill_search 的会话数：${stats.sessionsWithSearch}`);
  out.push(`- 本期 assistant 请求数：${stats.assistantRequests}`);
  out.push(`- skill_search 触发次数：${stats.searchCount}`);
  out.push(`- skill_read 触发次数：${stats.readCount}`);
  out.push(`- 跳过的损坏行数：${stats.corruptLines}`);
  out.push("");

  // 触发清单
  out.push("## 触发清单");
  out.push("");
  if (stats.triggers.length === 0) {
    out.push("_本期无 skill 工具触发。_");
  } else {
    out.push("| 会话 | 时间 | 工具 | query / 目标 | search→read |");
    out.push("|---|---|---|---|---|");
    for (const t of stats.triggers) {
      const pair = t.tool === "skill_search" ? (t.followedByRead ? "✅ 是" : "❌ 否") : "—";
      out.push(
        `| ${mdEscape(t.file)} | ${mdEscape(t.timestamp)} | ${t.tool} | ${mdEscape(t.target)} | ${pair} |`
      );
    }
  }
  out.push("");

  // Token 记账
  out.push("## Token 记账（四类）");
  out.push("");
  out.push("| 会话 | input | cache_creation | cache_read | output |");
  out.push("|---|---:|---:|---:|---:|");
  for (const s of stats.sessions) {
    out.push(
      `| ${mdEscape(s.file)} | ${s.tokens.input} | ${s.tokens.cacheCreation} | ${s.tokens.cacheRead} | ${s.tokens.output} |`
    );
  }
  out.push(
    `| **合计** | **${stats.totals.input}** | **${stats.totals.cacheCreation}** | **${stats.totals.cacheRead}** | **${stats.totals.output}** |`
  );
  out.push("");

  out.push(...renderEstimateSection(lib, stats.assistantRequests));

  return out.join("\n");
}

// 全量注入估算段（单/多项目共用；assistantRequests 为本期合计请求数）。
function renderEstimateSection(lib, assistantRequests) {
  const hypo = lib.estTokens * assistantRequests;
  return [
    "## 全量注入估算（估算，非实测）",
    "",
    `- 技能库：\`${lib.libraryPath}\`（只读扫描 \`SKILL.md\`，排除点目录与 \`node_modules\`）`,
    `- 目录条目数：${lib.skillCount}`,
    `- 渲染目录（\`- name: description\`）可见字符数：${lib.visibleChars}`,
    `- 估算 token：${lib.estTokens}（启发式：CJK 字符每字≈1 token，其余≈4 字符/token；此为**估算**，非实测）`,
    `- 若该目录每请求常驻：本期会话合计假想成本 ≈ 估算 token × 本期 assistant 请求数 = ${lib.estTokens} × ${assistantRequests} = **${hypo}** token`,
    "- 局限：此为估算而非实测；skill_search / skill_read 的实际结果 token 无法从转录的 `usage` 中单独拆出，故未从上表 token 中扣除。",
    "",
  ];
}

// 多项目报告：项目概览 + 全部触发清单 + 按项目 token + 合计 + 一次估算段。
export function renderMultiReport(scans, lib, opts, nowIso) {
  const out = [];
  out.push("# 被动轨周报（多项目）：skill_search / skill_read 触发与 token 记账");
  out.push("");
  out.push(`> 生成时间：${nowIso}  ·  时间窗：timestamp ≥ ${opts.since}  ·  项目数：${scans.length}`);
  out.push("> 口径见 docs/EXPERIMENT_C_PLAN.md §6（被动轨）、§7（Token 记账）。");
  out.push("");

  const g = {
    sessions: 0, withSearch: 0, search: 0, read: 0, req: 0, corrupt: 0,
    tokens: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
  };

  out.push("## 项目概览");
  out.push("");
  out.push("| 项目 | 会话数 | 含 search 会话 | search | read | assistant 请求 | 损坏行 |");
  out.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const s of scans) {
    const st = s.stats;
    out.push(
      `| ${mdEscape(path.basename(s.dir))} | ${st.sessionCount} | ${st.sessionsWithSearch} | ${st.searchCount} | ${st.readCount} | ${st.assistantRequests} | ${st.corruptLines} |`
    );
    g.sessions += st.sessionCount; g.withSearch += st.sessionsWithSearch;
    g.search += st.searchCount; g.read += st.readCount;
    g.req += st.assistantRequests; g.corrupt += st.corruptLines;
    g.tokens.input += st.totals.input; g.tokens.cacheCreation += st.totals.cacheCreation;
    g.tokens.cacheRead += st.totals.cacheRead; g.tokens.output += st.totals.output;
  }
  out.push(
    `| **合计** | **${g.sessions}** | **${g.withSearch}** | **${g.search}** | **${g.read}** | **${g.req}** | **${g.corrupt}** |`
  );
  out.push("");

  out.push("## 触发清单（全部项目）");
  out.push("");
  if (!scans.some((s) => s.stats.triggers.length > 0)) {
    out.push("_本期无 skill 工具触发。_");
  } else {
    out.push("| 项目 | 会话 | 时间 | 工具 | query / 目标 | search→read |");
    out.push("|---|---|---|---|---|---|");
    for (const s of scans) {
      for (const t of s.stats.triggers) {
        const pair = t.tool === "skill_search" ? (t.followedByRead ? "✅ 是" : "❌ 否") : "—";
        out.push(
          `| ${mdEscape(path.basename(s.dir))} | ${mdEscape(t.file)} | ${mdEscape(t.timestamp)} | ${t.tool} | ${mdEscape(t.target)} | ${pair} |`
        );
      }
    }
  }
  out.push("");

  out.push("## Token 记账（按项目）");
  out.push("");
  out.push("| 项目 | input | cache_creation | cache_read | output |");
  out.push("|---|---:|---:|---:|---:|");
  for (const s of scans) {
    const t = s.stats.totals;
    out.push(`| ${mdEscape(path.basename(s.dir))} | ${t.input} | ${t.cacheCreation} | ${t.cacheRead} | ${t.output} |`);
  }
  out.push(
    `| **合计** | **${g.tokens.input}** | **${g.tokens.cacheCreation}** | **${g.tokens.cacheRead}** | **${g.tokens.output}** |`
  );
  out.push("");

  out.push(...renderEstimateSection(lib, g.req));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dirs = resolveDirs(opts);
  const lib = estimateLibrary(opts.library);
  const nowIso = new Date().toISOString();
  if (dirs.length <= 1) {
    const dir = dirs[0] ?? opts.dirs[0];
    const stats = scanTranscripts(dir, opts.sinceMs);
    process.stdout.write(renderReport(stats, lib, { ...opts, dir }, nowIso) + "\n");
  } else {
    const scans = dirs.map((d) => ({ dir: d, stats: scanTranscripts(d, opts.sinceMs) }));
    process.stdout.write(renderMultiReport(scans, lib, opts, nowIso) + "\n");
  }
  process.exit(0);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
