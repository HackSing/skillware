#!/usr/bin/env node
// skillware 新人配置向导：选择你自己的技能库 → 自动接入本机检测到的宿主。
//
// 交互模式（推荐）：  node scripts/setup.mjs
// 非交互模式：        node scripts/setup.mjs --library <你的技能库路径> [--hosts claude,kimi] [--no-activation] [--dry-run]
//
// 设计原则：只问必须问的——技能库路径是唯一必答题；宿主自动检测默认全选；
// 激活文案默认开启（实验已证明关闭时激活率为零）。所有写入动作先备份、可回滚。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POC_ROOT = path.resolve(HERE, "..");
const SERVER_JS = path.join(POC_ROOT, "dist", "server.js");
const INDEX_JS = path.join(POC_ROOT, "dist", "index.js");
const KIMI_HOME = path.join(os.homedir(), ".kimi-code");
const KIMI_MCP = path.join(KIMI_HOME, "mcp.json");
const MCP_NAME = "skillware";

const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

// 行队列式 prompt：提前到达的输入行入队而不丢弃（readline/promises 在无挂起
// question 时会丢行——管道/粘贴多行答案会踩中）；EOF 后返回空串走默认值。
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const queue = [];
  let pending = null;
  let closed = false;
  rl.on("line", (l) => {
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve(l);
    } else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve("");
    }
  });
  return {
    get closed() {
      return closed && queue.length === 0;
    },
    question(prompt) {
      process.stdout.write(prompt);
      if (queue.length > 0) {
        const l = queue.shift();
        process.stdout.write(l + "\n");
        return Promise.resolve(l);
      }
      if (closed) {
        process.stdout.write("\n");
        return Promise.resolve("");
      }
      return new Promise((resolve) => {
        pending = { resolve };
      });
    },
    close: () => rl.close(),
  };
}

// ---------- CLI 参数 ----------
function parseArgs(argv) {
  const out = { library: null, hosts: null, activation: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--library") out.library = expand(argv[++i] ?? null);
    else if (a === "--hosts") out.hosts = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--no-activation") out.activation = false;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法：node scripts/setup.mjs [--library <路径>] [--hosts claude,kimi] [--no-activation] [--dry-run]");
      process.exit(0);
    } else {
      console.error(`未知参数：${a}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return out;
}

// ---------- 步骤 1：确保 server 已构建 ----------
function ensureBuilt(dryRun) {
  if (fs.existsSync(SERVER_JS)) return;
  console.log("· 首次使用，构建 server（npm ci && npm run build）…");
  if (dryRun) return;
  for (const args of [["ci", "--no-audit", "--no-fund"], ["run", "build"]]) {
    const r = spawnSync("npm", args, { cwd: POC_ROOT, stdio: "inherit" });
    if (r.status !== 0) {
      console.error("构建失败，请先在 poc/ 下手动执行 npm ci && npm run build 后重试。");
      process.exit(1);
    }
  }
}

// ---------- 步骤 2：技能库扫描（复用 dist 的真实索引逻辑，保证向导所见 = server 所见） ----------
function scanLibrary(dir) {
  const code = `import(${JSON.stringify(INDEX_JS)}).then(m => {
    const idx = m.buildIndex();
    const ok = idx.filter(r => r.name && r.short_description).length;
    console.log(JSON.stringify({ total: idx.length, withDesc: ok }));
  }).catch(e => { console.error(String(e && e.message || e)); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, SKILLWARE_LIBRARY: dir },
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  } catch {
    return null;
  }
}

async function askLibrary(rl) {
  for (;;) {
    const input = (await rl.question("① 你的技能库目录（存放 SKILL.md 技能的根目录）：")).trim();
    if (!input) {
      if (rl.closed) {
        console.error("输入已结束但未提供技能库路径；非交互场景请用 --library <路径>。");
        process.exit(2);
      }
      console.log("  路径不能为空。");
      continue;
    }
    const dir = path.resolve(expand(input));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.log(`  目录不存在：${dir}`);
      continue;
    }
    const scan = scanLibrary(dir);
    if (!scan || scan.total === 0) {
      console.log("  ⚠ 该目录下没有扫描到任何 SKILL.md 技能。确认这是技能库根目录？（输入其他路径，或 Ctrl-C 退出）");
      continue;
    }
    console.log(`  ✓ 发现 ${scan.total} 个技能（name+description 完整：${scan.withDesc}/${scan.total}）`);
    return dir;
  }
}

// ---------- 步骤 3：宿主检测 ----------
function detectHosts() {
  const hosts = [];
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (claude.status === 0) hosts.push("claude");
  if (fs.existsSync(KIMI_HOME)) hosts.push("kimi");
  return hosts;
}

const HOST_LABEL = { claude: "Claude Code", kimi: "Kimi Code（VS 插件 + CLI）" };

async function askHosts(rl, detected) {
  if (detected.length === 0) return [];
  const names = detected.map((h) => HOST_LABEL[h]).join("、");
  const ans = (await rl.question(`② 检测到宿主：${names}。全部接入？[Y/n/逗号分隔选择 如 claude] `)).trim().toLowerCase();
  if (ans === "" || ans === "y" || ans === "yes") return detected;
  if (ans === "n" || ans === "no") return [];
  return ans.split(/[,，]/).map((s) => s.trim()).filter((h) => detected.includes(h));
}

// ---------- 步骤 4：写宿主配置 ----------
function installClaude(library, activation, dryRun) {
  const envArgs = ["--env", `SKILLWARE_LIBRARY=${library}`];
  if (activation) envArgs.push("--env", "SKILLWARE_ACTIVATION=1");
  const addArgs = ["mcp", "add", MCP_NAME, "--scope", "user", ...envArgs, "--", "node", SERVER_JS];
  if (dryRun) {
    console.log(`  [dry-run] claude mcp remove ${MCP_NAME} --scope user（若存在）`);
    console.log(`  [dry-run] claude ${addArgs.join(" ")}`);
    return true;
  }
  spawnSync("claude", ["mcp", "remove", MCP_NAME, "--scope", "user"], { encoding: "utf8" }); // 不存在则失败，忽略
  const r = spawnSync("claude", addArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`  ✗ Claude Code 配置失败：${(r.stderr || r.stdout || "").trim()}`);
    return false;
  }
  console.log("  ✓ Claude Code 已配置（user 级，全部项目生效）");
  return true;
}

function installKimi(library, activation, dryRun) {
  let config = { mcpServers: {} };
  if (fs.existsSync(KIMI_MCP)) {
    try {
      config = JSON.parse(fs.readFileSync(KIMI_MCP, "utf8"));
    } catch {
      console.error(`  ✗ ${KIMI_MCP} 不是合法 JSON，跳过 Kimi（请手动检查后重跑）`);
      return false;
    }
    if (typeof config.mcpServers !== "object" || config.mcpServers === null) config.mcpServers = {};
  }
  const entry = {
    transport: "stdio",
    command: "node",
    args: [SERVER_JS],
    env: { SKILLWARE_LIBRARY: library, ...(activation ? { SKILLWARE_ACTIVATION: "1" } : {}) },
  };
  if (dryRun) {
    console.log(`  [dry-run] 备份 ${KIMI_MCP} 并写入 mcpServers.${MCP_NAME} = ${JSON.stringify(entry)}`);
    return true;
  }
  if (fs.existsSync(KIMI_MCP)) {
    fs.copyFileSync(KIMI_MCP, `${KIMI_MCP}.bak-${new Date().toISOString().slice(0, 10)}`);
  }
  config.mcpServers[MCP_NAME] = entry;
  fs.mkdirSync(path.dirname(KIMI_MCP), { recursive: true });
  fs.writeFileSync(KIMI_MCP, JSON.stringify(config, null, 2) + "\n");
  console.log("  ✓ Kimi Code 已配置（原 mcp.json 已备份；VS 插件需重启窗口）");
  return true;
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("skillware 配置向导：把你自己的技能库接入本机的 Agent 宿主\n");

  ensureBuilt(args.dryRun);

  let library = args.library ? path.resolve(args.library) : null;
  let hosts = args.hosts;
  const interactive = library === null;

  const rl = interactive || hosts === null ? makePrompter() : null;

  if (library === null) {
    library = await askLibrary(rl);
  } else {
    const scan = scanLibrary(library);
    if (!scan || scan.total === 0) {
      console.error(`技能库无效或没有技能：${library}`);
      process.exit(1);
    }
    console.log(`✓ 技能库：${library}（${scan.total} 个技能）`);
  }

  const detected = detectHosts();
  if (hosts === null) {
    hosts = rl ? await askHosts(rl, detected) : detected;
  } else {
    hosts = hosts.filter((h) => detected.includes(h));
  }
  rl?.close();

  if (detected.length === 0) {
    console.log("\n未检测到已支持的宿主（Claude Code / Kimi Code）。装好宿主后重跑本向导即可。");
    process.exit(0);
  }
  if (hosts.length === 0) {
    console.log("\n未选择任何宿主，未做修改。");
    process.exit(0);
  }

  console.log("");
  const results = [];
  for (const h of hosts) {
    if (h === "claude") results.push(installClaude(library, args.activation, args.dryRun));
    if (h === "kimi") results.push(installKimi(library, args.activation, args.dryRun));
  }

  console.log(`\n完成${args.dryRun ? "（dry-run，未实际写入）" : ""}。验证方式：`);
  console.log("  · 重开一个新会话（已开着的会话不生效）；");
  console.log('  · 发一条点名技能的任务，例如"用 <你的某个技能名> 技能 …"，应看到 skill_search / skill_read 被调用；');
  console.log("  · Claude Code 可用 `claude mcp list` 确认 skillware 显示 Connected。");
  console.log("回滚：`claude mcp remove skillware`；Kimi 删除 mcp.json 中的 skillware 条目（有自动备份）。");
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});
