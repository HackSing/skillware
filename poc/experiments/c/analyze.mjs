#!/usr/bin/env node
// 实验 C 判定与聚合脚本（纯 Node ≥18，零第三方依赖）。
//
// 解析 run-batch 产出的 stream-json 轨迹，按 PLUGIN_SPEC §16.3/§16.4 判定并聚合
// 双臂指标，输出 markdown 报告 + 逐 run 明细。设计依据 docs/EXPERIMENT_C_PLAN.md §5/§7。
//
// 用法：
//   node poc/experiments/c/analyze.mjs --results <目录> [--results <另一臂目录> ...]
//     [--tasks poc/experiments/c/tasks.json] [--format md|json|both=both]
//
// `--results` 目录里是 `<taskid>-r<k>.jsonl` + `.meta.json`（单臂一目录；允许多个 --results
// 以并排对比多臂）。报告写到第一个 --results 的同级目录：analysis.md / analysis.json，
// 同时把 markdown 打到 stdout。
//
// 配置类错误（目录/任务集缺失或非法、参数非法）退出码 2；正常结束退出码 0。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------- 业务默认值（单一来源）----------
const DEFAULT_TASKS = 'poc/experiments/c/tasks.json';
const VALID_FORMATS = ['md', 'json', 'both'];
const DEFAULT_FORMAT = 'both';

const EXIT_CONFIG_ERROR = 2;

// 复用口径（batch-2 规格）：/(^|__)skill_(search|read)$/。拆成两支便于区分调用。
const SEARCH_TOOL_RE = /(^|__)skill_search$/;
const READ_TOOL_RE = /(^|__)skill_read$/;

// 显式 not_found 如实报告的关键词（任一命中即视为如实）。
const HONEST_RE = /不存在|未找到|没有找到|not found|skill_not_found/i;

const TOP_N = 5; // 检索质量按 Top-5 判（§16.3）

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { resultsDirs: [], tasks: DEFAULT_TASKS, format: DEFAULT_FORMAT };
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
      case '--results':
        out.resultsDirs.push(val('--results'));
        break;
      case '--tasks':
        out.tasks = val('--tasks');
        break;
      case '--format':
        out.format = val('--format');
        break;
      default:
        configError(`未知参数：${argv[i]}`);
    }
  }
  if (out.resultsDirs.length === 0) configError('缺少必填参数 --results（可重复以对比多臂）。');
  if (!VALID_FORMATS.includes(out.format)) {
    configError(`--format 只能是 ${VALID_FORMATS.join('|')}，实际「${out.format}」。`);
  }
  return out;
}

function configError(msg) {
  console.error(`配置错误：${msg}`);
  process.exit(EXIT_CONFIG_ERROR);
}

// ---------- 解析层（一次性防御：损坏行跳过计数，下游不再判空）----------

// 解析单个 run 的 stream-json 文本，抽出复用信号与 token。返回结构化对象。
export function parseRun(jsonlText) {
  const lines = String(jsonlText).split('\n');
  let corruptedLines = 0;
  let assistantTurn = 0;
  let firstSearchTurn = null;
  let finalAssistantText = '';

  const searchCalls = []; // { id, query, turn, resultNames: string[] }
  const readCalls = []; // { id, skillId, turn }
  const searchById = new Map();
  const pendingSearchNoId = []; // 无 tool_use_id 时按出现顺序回填
  let usage = null; // { input, cache_creation, cache_read, output }
  let totalCostUsd = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      corruptedLines++;
      continue;
    }

    if (ev.type === 'assistant') {
      assistantTurn++;
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        let turnText = '';
        for (const item of content) {
          if (item?.type === 'tool_use') {
            const name = String(item.name ?? '');
            if (SEARCH_TOOL_RE.test(name)) {
              const call = {
                id: item.id ?? null,
                query: item.input?.query != null ? String(item.input.query) : '',
                turn: assistantTurn,
                resultNames: [],
              };
              searchCalls.push(call);
              if (call.id) searchById.set(call.id, call);
              else pendingSearchNoId.push(call);
              if (firstSearchTurn === null) firstSearchTurn = assistantTurn;
            } else if (READ_TOOL_RE.test(name)) {
              readCalls.push({
                id: item.id ?? null,
                skillId: item.input?.skill_id != null ? String(item.input.skill_id) : '',
                turn: assistantTurn,
              });
            }
          } else if (item?.type === 'text' && typeof item.text === 'string') {
            turnText += item.text;
          }
        }
        if (turnText.trim()) finalAssistantText = turnText;
      }
    } else if (ev.type === 'user') {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type !== 'tool_result') continue;
          const text = extractToolResultText(item.content);
          if (text == null) continue;
          const names = extractResultNames(text);
          if (names == null) continue; // 非 search 结果（如 read 结果）忽略
          // 优先按 tool_use_id 匹配，回落到出现顺序
          const call = (item.tool_use_id && searchById.get(item.tool_use_id)) || pendingSearchNoId.shift();
          if (call) call.resultNames = names;
        }
      }
    } else if (ev.type === 'result') {
      const u = ev.usage ?? {};
      usage = {
        input: numOr0(u.input_tokens),
        cache_creation: numOr0(u.cache_creation_input_tokens),
        cache_read: numOr0(u.cache_read_input_tokens),
        output: numOr0(u.output_tokens),
      };
      totalCostUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
    }
  }

  return {
    corruptedLines,
    firstSearchTurn,
    finalAssistantText,
    searchCalls,
    readCalls,
    usage,
    totalCostUsd,
  };
}

function numOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// tool_result 的 content 可能是字符串或 [{type:'text',text}] 数组。
function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    if (parts.length) return parts.join('');
  }
  return null;
}

// 若文本是 skill_search 结果（JSON 且含 results 数组），返回候选名数组；否则 null。
function extractResultNames(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.results)) return null;
  return parsed.results.map((r) => (r?.name != null ? String(r.name) : '')).filter(Boolean);
}

// ---------- 逐 run 判定（按任务 class）----------

export function judgeRun(parsed, task, meta) {
  const status = meta?.status ?? 'missing_meta';
  const searched = parsed.searchCalls.length > 0;
  const expected = Array.isArray(task?.expected_skills) ? task.expected_skills : [];
  const expectedLc = expected.map((s) => s.toLowerCase());

  // Top-5 命中：各 search 取前 5 名并集，与期望技能名做精确（忽略大小写）匹配。
  const topNames = new Set();
  for (const call of parsed.searchCalls) {
    for (const n of call.resultNames.slice(0, TOP_N)) topNames.add(n.toLowerCase());
  }
  const expectedInTop5 = expectedLc.some((e) => topNames.has(e));

  // skill_read 命中：任一 read 的 skill_id 含期望技能名（子串，忽略大小写）。
  const readExpected = parsed.readCalls.some((rc) =>
    expectedLc.some((e) => rc.skillId.toLowerCase().includes(e)),
  );

  // 全程 search 结果是否都为空（显式 not_found 用）。
  const anyResultNames = parsed.searchCalls.some((c) => c.resultNames.length > 0);
  const searchEmpty = searched && !anyResultNames;

  const record = {
    task_id: task?.id ?? meta?.task_id ?? '(unknown)',
    class: task?.class ?? meta?.class ?? '(unknown)',
    arm: meta?.arm ?? null,
    repeat: meta?.repeat ?? null,
    status,
    valid: status === 'ok',
    expect_not_found: !!task?.expect_not_found,
    searched,
    expected_in_top5: expectedInTop5,
    read_expected: readExpected,
    honest: null, // 仅 not_found 赋值：'yes' | 'human_review'
    first_search_turn: parsed.firstSearchTurn,
    query: parsed.searchCalls[0]?.query ?? null,
    corrupted_lines: parsed.corruptedLines,
    usage: parsed.usage,
    total_cost_usd: parsed.totalCostUsd,
    pass: false,
  };

  const cls = record.class;
  if (cls === 'explicit' && record.expect_not_found) {
    record.honest = HONEST_RE.test(parsed.finalAssistantText) ? 'yes' : 'human_review';
    record.pass = searched && searchEmpty; // 行为通过：搜了且结果为空
  } else if (cls === 'explicit') {
    record.pass = searched && expectedInTop5 && readExpected;
  } else if (cls === 'implicit') {
    record.pass = searched; // 触发通过 = 是否调用 skill_search（16.4）
  } else if (cls === 'negative') {
    record.pass = !searched; // 全程零次 skill_search 调用
  }
  return record;
}

// ---------- 目录装载 ----------

// 读取一个结果目录：配对每个 <base>.jsonl 与 <base>.meta.json。
export function loadRunsFromDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    configError(`无法读取结果目录：${dir}（${e.message}）`);
  }
  const bases = entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();

  return bases.map((base) => {
    const jsonlPath = path.join(dir, `${base}.jsonl`);
    const metaPath = path.join(dir, `${base}.meta.json`);
    const jsonlText = fs.readFileSync(jsonlPath, 'utf8');
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {
        meta = null; // 损坏的 meta 视为缺失 -> invalid
      }
    }
    return { base, jsonlPath, metaPath, jsonlText, meta };
  });
}

// ---------- 聚合（每臂一列）----------

function rate(num, den) {
  return den === 0 ? null : num / den;
}

// 判定一个臂：装载 -> 逐 run 判定 -> 聚合。tasksById 为 id -> task 映射。
export function analyzeArm(dir, tasksById) {
  const loaded = loadRunsFromDir(dir);
  const runs = loaded.map(({ jsonlText, meta }) => {
    const parsed = parseRun(jsonlText);
    const task = tasksById.get(meta?.task_id) ?? null;
    return judgeRun(parsed, task, meta);
  });

  const armName = runs.find((r) => r.arm)?.arm ?? path.basename(path.resolve(dir));
  const valid = runs.filter((r) => r.valid);
  const invalid = runs.filter((r) => !r.valid);

  const explicit = valid.filter((r) => r.class === 'explicit');
  const explicitNotFound = explicit.filter((r) => r.expect_not_found);
  const implicit = valid.filter((r) => r.class === 'implicit');
  const negative = valid.filter((r) => r.class === 'negative');

  const implicitSearched = implicit.filter((r) => r.searched);
  const readPool = valid.filter((r) => r.expected_in_top5);

  const humanReview = explicitNotFound.filter((r) => r.honest === 'human_review');

  const metrics = {
    explicit_trigger: mk(explicit.filter((r) => r.searched).length, explicit.length, '=100%'),
    notfound_honest: {
      ...mk(explicitNotFound.filter((r) => r.honest === 'yes').length, explicitNotFound.length, '=100%'),
      human_review: humanReview.length,
    },
    implicit_trigger: mk(implicit.filter((r) => r.searched).length, implicit.length, '≥95%'),
    implicit_top5: mk(implicitSearched.filter((r) => r.expected_in_top5).length, implicitSearched.length, '≥95%'),
    negative_falsetrigger: mk(negative.filter((r) => r.searched).length, negative.length, '≤5%'),
    read_completion: mk(readPool.filter((r) => r.read_expected).length, readPool.length, '=100%'),
  };

  const tokens = aggregateTokens(valid);

  return {
    arm: armName,
    dir,
    runs,
    invalid,
    humanReview,
    metrics,
    tokens,
    corrupted: runs.reduce((a, r) => a + (r.corrupted_lines || 0), 0),
  };
}

function mk(num, den, criterion) {
  return { num, den, rate: rate(num, den), criterion };
}

function aggregateTokens(validRuns) {
  const withUsage = validRuns.filter((r) => r.usage);
  const sum = { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
  for (const r of withUsage) {
    sum.input += r.usage.input;
    sum.cache_creation += r.usage.cache_creation;
    sum.cache_read += r.usage.cache_read;
    sum.output += r.usage.output;
  }
  const n = withUsage.length;
  const mean = {
    input: n ? sum.input / n : 0,
    cache_creation: n ? sum.cache_creation / n : 0,
    cache_read: n ? sum.cache_read / n : 0,
    output: n ? sum.output / n : 0,
  };
  const costRuns = validRuns.filter((r) => typeof r.total_cost_usd === 'number');
  const costSum = costRuns.reduce((a, r) => a + r.total_cost_usd, 0);
  return { n, sum, mean, cost_sum: costSum, cost_n: costRuns.length };
}

// 顶层：多臂并排。
export function analyze({ resultsDirs, tasks }) {
  const tasksById = new Map((tasks || []).map((t) => [t.id, t]));
  const arms = resultsDirs.map((dir) => analyzeArm(dir, tasksById));
  return { arms };
}

// ---------- 渲染 ----------

function pct(r) {
  return r == null ? 'n/a' : `${(r * 100).toFixed(1)}%`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

const METRIC_ROWS = [
  ['显式触发率', 'explicit_trigger'],
  ['显式 not_found 如实率', 'notfound_honest'],
  ['隐式触发率', 'implicit_trigger'],
  ['隐式期望技能 Top-5 率', 'implicit_top5'],
  ['负例误触发率', 'negative_falsetrigger'],
  ['命中后 skill_read 完成率', 'read_completion'],
];

export function renderMarkdown(analysis) {
  const arms = analysis.arms;
  const lines = [];
  lines.push('# 实验 C 判定与聚合报告');
  lines.push('');
  lines.push(`臂：${arms.map((a) => a.arm).join(' · ')}`);
  lines.push('');

  // 聚合指标表
  lines.push('## 聚合指标');
  lines.push('');
  lines.push(`| 指标 | 判据 | ${arms.map((a) => a.arm).join(' | ')} |`);
  lines.push(`|---|---|${arms.map(() => '---').join('|')}|`);
  for (const [label, key] of METRIC_ROWS) {
    const criterion = arms[0]?.metrics[key]?.criterion ?? '';
    const cells = arms.map((a) => {
      const m = a.metrics[key];
      let cell = `${pct(m.rate)} (${m.num}/${m.den})`;
      if (key === 'notfound_honest' && m.human_review) cell += ` · human_review ${m.human_review}`;
      return cell;
    });
    lines.push(`| ${label} | ${criterion} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Token 表（报告值，无判据）
  lines.push('## Token 与成本（有效 run）');
  lines.push('');
  lines.push(`| 项 | ${arms.map((a) => a.arm).join(' | ')} |`);
  lines.push(`|---|${arms.map(() => '---').join('|')}|`);
  const tokRow = (label, pick) => `| ${label} | ${arms.map((a) => pick(a.tokens)).join(' | ')} |`;
  lines.push(tokRow('有效 run 数', (t) => String(t.n)));
  lines.push(tokRow('input 合计 / 均值', (t) => `${t.sum.input} / ${round(t.mean.input)}`));
  lines.push(tokRow('cache_creation 合计 / 均值', (t) => `${t.sum.cache_creation} / ${round(t.mean.cache_creation)}`));
  lines.push(tokRow('cache_read 合计 / 均值', (t) => `${t.sum.cache_read} / ${round(t.mean.cache_read)}`));
  lines.push(tokRow('output 合计 / 均值', (t) => `${t.sum.output} / ${round(t.mean.output)}`));
  lines.push(tokRow('cost 合计 (USD)', (t) => `${round(t.cost_sum)} (n=${t.cost_n})`));
  lines.push('');

  // human_review 清单
  lines.push('## human_review 清单');
  lines.push('');
  const hr = arms.flatMap((a) => a.humanReview.map((r) => ({ arm: a.arm, r })));
  if (hr.length === 0) {
    lines.push('（无）');
  } else {
    for (const { arm, r } of hr) {
      lines.push(`- [${arm}] ${r.task_id} r${r.repeat}：未在最终文本中检出如实报未找到关键词，需人工核对。`);
    }
  }
  lines.push('');

  // invalid 清单
  lines.push('## invalid 清单（error/timeout，不计入分母）');
  lines.push('');
  const inv = arms.flatMap((a) => a.invalid.map((r) => ({ arm: a.arm, r })));
  if (inv.length === 0) {
    lines.push('（无）');
  } else {
    for (const { arm, r } of inv) {
      lines.push(`- [${arm}] ${r.task_id} r${r.repeat}：status=${r.status}`);
    }
  }
  lines.push('');

  // 逐 run 明细
  for (const a of arms) {
    lines.push(`## 逐 run 明细 · ${a.arm}`);
    lines.push('');
    lines.push('| task | class | r | status | searched | top5 | read | honest | first_turn | pass | in/cc/cr/out | cost |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of a.runs) {
      const u = r.usage ? `${r.usage.input}/${r.usage.cache_creation}/${r.usage.cache_read}/${r.usage.output}` : '-';
      const cost = r.total_cost_usd == null ? 'null' : String(round(r.total_cost_usd));
      lines.push(
        `| ${r.task_id} | ${r.class} | ${r.repeat ?? '-'} | ${r.status} | ${b(r.searched)} | ${b(r.expected_in_top5)} | ${b(r.read_expected)} | ${r.honest ?? '-'} | ${r.first_search_turn ?? '-'} | ${r.valid ? b(r.pass) : '-'} | ${u} | ${cost} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function b(v) {
  return v ? '✓' : '✗';
}

// JSON 报告：结构化输出，供下游程序消费。
export function renderJson(analysis) {
  return {
    arms: analysis.arms.map((a) => ({
      arm: a.arm,
      dir: a.dir,
      metrics: a.metrics,
      tokens: a.tokens,
      corrupted: a.corrupted,
      human_review: a.humanReview.map((r) => ({ task_id: r.task_id, repeat: r.repeat })),
      invalid: a.invalid.map((r) => ({ task_id: r.task_id, repeat: r.repeat, status: r.status })),
      runs: a.runs,
    })),
  };
}

// ---------- CLI ----------

function loadTasks(tasksArg) {
  const abs = path.resolve(tasksArg);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    configError(`无法读取任务集：${abs}（${e.message}）`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    configError(`任务集 JSON 解析失败：${abs}（${e.message}）`);
  }
  if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) {
    configError(`任务集 tasks 字段缺失或为空：${abs}`);
  }
  return doc.tasks;
}

export function main(argv) {
  const args = parseArgs(argv);
  for (const dir of args.resultsDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      configError(`--results 不是有效目录：${dir}`);
    }
  }
  const tasks = loadTasks(args.tasks);
  const analysis = analyze({ resultsDirs: args.resultsDirs, tasks });

  const md = renderMarkdown(analysis);
  console.log(md);

  const outParent = path.dirname(path.resolve(args.resultsDirs[0]));
  if (args.format === 'md' || args.format === 'both') {
    fs.writeFileSync(path.join(outParent, 'analysis.md'), md + '\n');
  }
  if (args.format === 'json' || args.format === 'both') {
    fs.writeFileSync(path.join(outParent, 'analysis.json'), JSON.stringify(renderJson(analysis), null, 2) + '\n');
  }
  process.exit(0);
}

// 仅在作为脚本直接运行时执行 CLI（被 test import 时不触发）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
