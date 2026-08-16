#!/usr/bin/env node
// 实验 C 跑批器（纯 Node ≥18，零第三方依赖）。
//
// 批量驱动 `claude -p` 在一次性 git worktree 中执行固定任务集，按臂（C0/C1）
// 收集 stream-json 轨迹到结果目录。设计依据 docs/EXPERIMENT_C_PLAN.md §5。
//
// 用法：
//   node poc/experiments/c/run-batch.mjs --arm c0|c1 [--repeats N=1] [--only id1,id2]
//     [--tasks poc/experiments/c/tasks.json] [--target /Users/aiware/projects/dsh-buddy]
//     [--out poc/experiments/c/results/<UTC时间戳>-<arm>] [--model claude-opus-4-8]
//     [--timeout-ms 480000] [--dry-run]
//
// 配置类错误（tasks/臂文件缺失或非法 JSON、target 非 git 仓库、参数非法）退出码 2。
// 单 run 失败/超时不中断批次；批末打汇总，正常结束退出码 0。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- 业务默认值（单一来源）----------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARMS_DIR = path.join(SCRIPT_DIR, 'arms');
const VALID_ARMS = ['c0', 'c1'];

const DEFAULT_TASKS = 'poc/experiments/c/tasks.json';
const DEFAULT_TARGET = '/Users/aiware/projects/dsh-buddy';
const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_REPEATS = 1;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000; // 单 run 8 分钟
const RESULTS_ROOT = 'poc/experiments/c/results';
const CLAUDE_MAX_BUFFER = 512 * 1024 * 1024; // stream-json 轨迹缓冲上限
const KILL_SIGNAL = 'SIGKILL';

const EXIT_CONFIG_ERROR = 2;

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = {
    arm: null,
    repeats: DEFAULT_REPEATS,
    only: null, // string[] | null
    tasks: DEFAULT_TASKS,
    target: DEFAULT_TARGET,
    outDir: null, // 默认在校验后按 arm + 时间戳计算
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false,
  };
  // 支持 `--opt value` 与 `--opt=value` 两种写法。
  const take = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined) configError(`参数 ${name} 缺少取值。`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inlineVal = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) {
      inlineVal = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const val = (name) => (inlineVal !== null ? inlineVal : take(i++, name));
    switch (a) {
      case '--arm':
        out.arm = val('--arm');
        break;
      case '--repeats':
        out.repeats = parseIntStrict(val('--repeats'), '--repeats');
        break;
      case '--only':
        out.only = val('--only')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--tasks':
        out.tasks = val('--tasks');
        break;
      case '--target':
        out.target = val('--target');
        break;
      case '--out':
        out.outDir = val('--out');
        break;
      case '--model':
        out.model = val('--model');
        break;
      case '--timeout-ms':
        out.timeoutMs = parseIntStrict(val('--timeout-ms'), '--timeout-ms');
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      default:
        configError(`未知参数：${argv[i]}`);
    }
  }
  return out;
}

function parseIntStrict(s, name) {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) configError(`${name} 必须是正整数，实际「${s}」。`);
  return n;
}

function configError(msg) {
  console.error(`配置错误：${msg}`);
  process.exit(EXIT_CONFIG_ERROR);
}

// ---------- 校验（配置类错误立即退出 2）----------
function isGitRepo(target) {
  const r = spawnSync('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

function loadJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    configError(`无法读取${label}：${file}（${e.message}）`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    configError(`${label} JSON 解析失败：${file}（${e.message}）`);
  }
}

// ---------- worktree 生命周期 ----------
function worktreeAdd(target, wt) {
  return spawnSync('git', ['-C', target, 'worktree', 'add', wt, '--detach'], { encoding: 'utf8' });
}

function worktreeRemove(target, wt) {
  return spawnSync('git', ['-C', target, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
}

function worktreePrune(target) {
  return spawnSync('git', ['-C', target, 'worktree', 'prune'], { encoding: 'utf8' });
}

// ---------- 命令行渲染（dry-run 展示用）----------
function shQuote(s) {
  return /^[A-Za-z0-9_.:/=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildClaudeArgs(model, maxTurns, armConfigAbs) {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--strict-mcp-config',
    '--mcp-config',
    armConfigAbs,
    '--permission-mode',
    'bypassPermissions',
  ];
}

// ---------- 主流程 ----------
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.arm) configError('缺少必填参数 --arm（c0|c1）。');
  if (!VALID_ARMS.includes(args.arm)) configError(`--arm 只能是 ${VALID_ARMS.join('|')}，实际「${args.arm}」。`);

  const armConfigAbs = path.join(ARMS_DIR, `${args.arm}.json`);
  if (!fs.existsSync(armConfigAbs)) configError(`臂配置文件不存在：${armConfigAbs}`);
  loadJson(armConfigAbs, '臂配置'); // 仅校验 JSON 合法

  const tasksAbs = path.resolve(args.tasks);
  const doc = loadJson(tasksAbs, '任务集');
  if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) {
    configError(`任务集 tasks 字段缺失或为空：${tasksAbs}`);
  }

  // --only 过滤（保持 tasks.json 原始顺序）
  let selected = doc.tasks;
  if (args.only) {
    const wanted = new Set(args.only);
    const known = new Set(doc.tasks.map((t) => t.id));
    const missing = args.only.filter((id) => !known.has(id));
    if (missing.length) configError(`--only 指定了不存在的任务 id：${missing.join(', ')}`);
    selected = doc.tasks.filter((t) => wanted.has(t.id));
  }
  if (selected.length === 0) configError('筛选后没有任何任务可执行。');

  if (!isGitRepo(args.target)) configError(`target 不是 git 仓库：${args.target}`);

  // 结果目录：默认 <RESULTS_ROOT>/<UTC时间戳>-<arm>
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const outDir = path.resolve(args.outDir ?? path.join(RESULTS_ROOT, `${stamp}-${args.arm}`));

  // 计划的 run 列表：任务 × 重复
  const plan = [];
  for (const task of selected) {
    for (let k = 1; k <= args.repeats; k++) {
      plan.push({ task, repeat: k });
    }
  }

  if (args.dryRun) {
    runDryRun(plan, args, armConfigAbs, outDir, tasksAbs);
    process.exit(0);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const counts = { ok: 0, error: 0, timeout: 0 };

  plan.forEach(({ task, repeat }, idx) => {
    const res = runOne({ task, repeat, args, armConfigAbs, outDir });
    counts[res.status] = (counts[res.status] ?? 0) + 1;
    const secs = (res.duration_ms / 1000).toFixed(1);
    console.log(
      `[${idx + 1}/${plan.length}] ${task.id} ${args.arm} r${repeat} ${res.status} ${secs}s`,
    );
  });

  // 批末：清理残留 worktree 引用
  worktreePrune(args.target);

  console.log('');
  console.log(`批次完成：共 ${plan.length} 个 run —— ok ${counts.ok} / error ${counts.error} / timeout ${counts.timeout}`);
  console.log(`结果目录：${outDir}`);
  console.log(`下一步：解析该目录下的 *.jsonl 轨迹出激活/命中指标（analyze）。`);
  process.exit(0);
}

// 执行单个 run；异常均转为 status，不抛出、不中断批次。
function runOne({ task, repeat, args, armConfigAbs, outDir }) {
  const base = `${task.id}-r${repeat}`;
  const jsonlPath = path.join(outDir, `${base}.jsonl`);
  const errPath = path.join(outDir, `${base}.err`);
  const metaPath = path.join(outDir, `${base}.meta.json`);

  const started_at = new Date().toISOString();
  const t0 = Date.now();

  const meta = {
    task_id: task.id,
    class: task.class,
    arm: args.arm,
    repeat,
    model: args.model,
    exit_code: null,
    status: 'error',
    duration_ms: 0,
    started_at,
  };

  // 一次性 worktree（父目录唯一 -> 子目录 wt 由 git 创建）
  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'expc-'));
  const wt = path.join(wtBase, 'wt');

  try {
    const addRes = worktreeAdd(args.target, wt);
    if (addRes.status !== 0) {
      meta.status = 'error';
      meta.note = `worktree add 失败：${String(addRes.stderr || addRes.error?.message || '').trim()}`;
      fs.writeFileSync(errPath, String(addRes.stderr ?? ''));
      return finalizeMeta(meta, metaPath, t0);
    }

    const claudeArgs = buildClaudeArgs(args.model, task.max_turns, armConfigAbs);
    const res = spawnSync('claude', claudeArgs, {
      cwd: wt,
      input: task.text, // 任务文本经 stdin 传入，避免被可变参数选项吞掉
      timeout: args.timeoutMs,
      killSignal: KILL_SIGNAL,
      maxBuffer: CLAUDE_MAX_BUFFER,
    });

    fs.writeFileSync(jsonlPath, res.stdout ?? Buffer.alloc(0));
    fs.writeFileSync(errPath, res.stderr ?? Buffer.alloc(0));

    const timedOut = res.error && (res.error.code === 'ETIMEDOUT' || res.error.errno === 'ETIMEDOUT');
    if (timedOut) {
      meta.status = 'timeout';
      meta.exit_code = null;
      meta.note = `超时 ${args.timeoutMs}ms，已发 ${KILL_SIGNAL}`;
    } else if (res.error) {
      meta.status = 'error';
      meta.exit_code = null;
      meta.note = `spawn 失败：${res.error.message}`;
    } else {
      meta.exit_code = res.status;
      meta.status = res.status === 0 ? 'ok' : 'error';
    }
    return finalizeMeta(meta, metaPath, t0);
  } finally {
    const rm = worktreeRemove(args.target, wt);
    if (rm.status !== 0) {
      console.error(`  警告：worktree remove 失败（${wt}）：${String(rm.stderr || rm.error?.message || '').trim()}`);
    }
    try {
      fs.rmSync(wtBase, { recursive: true, force: true });
    } catch {
      /* 忽略临时目录清理失败 */
    }
  }
}

function finalizeMeta(meta, metaPath, t0) {
  meta.duration_ms = Date.now() - t0;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

function runDryRun(plan, args, armConfigAbs, outDir, tasksAbs) {
  console.log(`dry-run：臂 ${args.arm}，任务集 ${tasksAbs}，target ${args.target}`);
  console.log(`结果目录（未创建）：${outDir}`);
  console.log(`计划 ${plan.length} 个 run（${new Set(plan.map((p) => p.task.id)).size} 任务 × ${args.repeats} 重复）：`);
  console.log('');
  plan.forEach(({ task, repeat }, idx) => {
    const base = `${task.id}-r${repeat}`;
    const claudeArgs = buildClaudeArgs(args.model, task.max_turns, armConfigAbs);
    const cmd = ['claude', ...claudeArgs].map(shQuote).join(' ');
    console.log(`[${idx + 1}/${plan.length}] ${task.id} (${task.class}) r${repeat}`);
    console.log(`  cwd    : <一次性 worktree of ${args.target}>`);
    console.log(`  cmd    : ${cmd}`);
    console.log(`  stdin  : <任务文本，${task.text.length} 字>`);
    console.log(`  stdout : ${path.join(outDir, `${base}.jsonl`)}`);
    console.log(`  stderr : ${path.join(outDir, `${base}.err`)}`);
    console.log(`  meta   : ${path.join(outDir, `${base}.meta.json`)}`);
  });
  console.log('');
  console.log(`dry-run 完成：共 ${plan.length} 个计划 run，未创建 worktree、未调用 claude。`);
}

main();
