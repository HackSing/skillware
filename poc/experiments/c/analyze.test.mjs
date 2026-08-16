#!/usr/bin/env node
// 实验 C 判定与聚合脚本的合成夹具测试（纯 Node ≥18，零 API 成本）。
//
// 运行：node poc/experiments/c/analyze.test.mjs
// 覆盖 ≥6 情形：explicit 全通过 / explicit 未搜索 / not_found 如实 / implicit 未搜索 /
// negative 误触发 / negative 干净 + 1 个 status=error 的 invalid run；断言各聚合率、
// 逐 run 判定、token 合计严格等于预期。通过则退出码 0。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseRun, judgeRun, analyzeArm, renderMarkdown, renderJson } from './analyze.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_RUNS = path.join(SCRIPT_DIR, 'fixtures', 'runs');

// —— 与夹具对应的合成任务集（source of truth：class / expected / expect_not_found）——
const TASKS = [
  { id: 'expc-e1', class: 'explicit', expected_skills: ['translator'], expect_not_found: false },
  { id: 'expc-e2', class: 'explicit', expected_skills: ['image-tools'], expect_not_found: false },
  { id: 'expc-nf1', class: 'explicit', expected_skills: ['changelog-writer'], expect_not_found: true },
  { id: 'expc-i1', class: 'implicit', expected_skills: ['social-writer'], expect_not_found: false },
  { id: 'expc-i2', class: 'implicit', expected_skills: ['translator'], expect_not_found: false },
  { id: 'expc-n1', class: 'negative', expected_skills: [], expect_not_found: false },
  { id: 'expc-n2', class: 'negative', expected_skills: [], expect_not_found: false },
  { id: 'expc-inv1', class: 'implicit', expected_skills: ['content-formatter'], expect_not_found: false },
];

// —— 极简断言 ——
let checks = 0;
function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) fail(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function close(actual, expected, label, eps = 1e-9) {
  checks++;
  if (Math.abs(actual - expected) > eps) fail(`${label}：期望≈${expected}，实际 ${actual}`);
}
function ok(cond, label) {
  checks++;
  if (!cond) fail(`${label}：期望为真`);
}
function fail(msg) {
  console.error(`✗ 断言失败：${msg}`);
  process.exit(1);
}

// ---------- 1. 逐 run 判定 ----------
const tasksById = new Map(TASKS.map((t) => [t.id, t]));
const arm = analyzeArm(FIXTURE_RUNS, tasksById);
const byId = new Map(arm.runs.map((r) => [r.task_id, r]));
const get = (id) => byId.get(id);

// explicit 全通过
{
  const r = get('expc-e1');
  eq(r.searched, true, 'e1.searched');
  eq(r.expected_in_top5, true, 'e1.top5');
  eq(r.read_expected, true, 'e1.read');
  eq(r.pass, true, 'e1.pass');
  eq(r.first_search_turn, 1, 'e1.first_search_turn');
  eq(r.corrupted_lines, 1, 'e1.corrupted_lines'); // 损坏行被解析层跳过并计数
}
// explicit 未搜索
{
  const r = get('expc-e2');
  eq(r.searched, false, 'e2.searched');
  eq(r.pass, false, 'e2.pass');
  eq(r.first_search_turn, null, 'e2.first_search_turn');
}
// explicit not_found 如实
{
  const r = get('expc-nf1');
  eq(r.searched, true, 'nf1.searched');
  eq(r.honest, 'yes', 'nf1.honest');
  eq(r.expected_in_top5, false, 'nf1.top5');
  eq(r.pass, true, 'nf1.pass'); // 搜了且结果为空
}
// implicit 未搜索
{
  const r = get('expc-i1');
  eq(r.searched, false, 'i1.searched');
  eq(r.pass, false, 'i1.pass');
  eq(r.total_cost_usd, null, 'i1.cost'); // 缺 total_cost_usd -> null
}
// implicit 全通过
{
  const r = get('expc-i2');
  eq(r.searched, true, 'i2.searched');
  eq(r.expected_in_top5, true, 'i2.top5');
  eq(r.read_expected, true, 'i2.read');
  eq(r.pass, true, 'i2.pass');
}
// negative 误触发
{
  const r = get('expc-n1');
  eq(r.searched, true, 'n1.searched');
  eq(r.pass, false, 'n1.pass'); // 搜了 = 不通过
}
// negative 干净
{
  const r = get('expc-n2');
  eq(r.searched, false, 'n2.searched');
  eq(r.pass, true, 'n2.pass');
}
// invalid（status=error）
{
  const r = get('expc-inv1');
  eq(r.valid, false, 'inv1.valid');
  eq(r.status, 'error', 'inv1.status');
}

// ---------- 2. 聚合率 ----------
const m = arm.metrics;
// 显式触发率：e1(T) e2(F) nf1(T) => 2/3
eq(m.explicit_trigger.num, 2, 'agg.explicit_trigger.num');
eq(m.explicit_trigger.den, 3, 'agg.explicit_trigger.den');
close(m.explicit_trigger.rate, 2 / 3, 'agg.explicit_trigger.rate');
// not_found 如实率：nf1 honest yes => 1/1；human_review 0
eq(m.notfound_honest.num, 1, 'agg.notfound_honest.num');
eq(m.notfound_honest.den, 1, 'agg.notfound_honest.den');
eq(m.notfound_honest.human_review, 0, 'agg.notfound_honest.human_review');
// 隐式触发率：i1(F) i2(T) => 1/2（inv1 无效不计入分母）
eq(m.implicit_trigger.num, 1, 'agg.implicit_trigger.num');
eq(m.implicit_trigger.den, 2, 'agg.implicit_trigger.den');
// 隐式 Top-5 率：分母 = 已搜索的隐式 run（仅 i2）=> 1/1
eq(m.implicit_top5.num, 1, 'agg.implicit_top5.num');
eq(m.implicit_top5.den, 1, 'agg.implicit_top5.den');
// 负例误触发率：n1(T) n2(F) => 1/2
eq(m.negative_falsetrigger.num, 1, 'agg.negative_falsetrigger.num');
eq(m.negative_falsetrigger.den, 2, 'agg.negative_falsetrigger.den');
// 命中后 read 完成率：分母 = expected_in_top5 为真（e1, i2）=> 2/2
eq(m.read_completion.num, 2, 'agg.read_completion.num');
eq(m.read_completion.den, 2, 'agg.read_completion.den');
close(m.read_completion.rate, 1, 'agg.read_completion.rate');

// invalid / human_review / corrupted 计数
eq(arm.invalid.length, 1, 'arm.invalid.length');
eq(arm.invalid[0].task_id, 'expc-inv1', 'arm.invalid[0]');
eq(arm.humanReview.length, 0, 'arm.humanReview.length');
eq(arm.corrupted, 1, 'arm.corrupted');

// ---------- 3. token 合计（仅有效 run；夹具轨迹含 usage 数字）----------
const t = arm.tokens;
eq(t.n, 7, 'tokens.n'); // 8 run - 1 invalid
eq(t.sum.input, 570, 'tokens.sum.input');
eq(t.sum.cache_creation, 35, 'tokens.sum.cache_creation');
eq(t.sum.cache_read, 4200, 'tokens.sum.cache_read');
eq(t.sum.output, 193, 'tokens.sum.output');
eq(t.cost_n, 6, 'tokens.cost_n'); // i1 缺 cost
close(t.cost_sum, 0.084, 'tokens.cost_sum');

// ---------- 4. judgeRun 分支单测：not_found 文本不含关键词 -> human_review ----------
{
  const parsed = parseRun(
    [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'mcp__askill__skill_search', input: { query: '$foo' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's', content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '我帮你手写了一份更新日志。' }] } }),
    ].join('\n'),
  );
  const r = judgeRun(parsed, { id: 'x', class: 'explicit', expected_skills: ['foo'], expect_not_found: true }, { status: 'ok', task_id: 'x' });
  eq(r.honest, 'human_review', 'unit.notfound.human_review');
  eq(r.pass, true, 'unit.notfound.pass'); // 行为仍通过（搜了且结果为空）
}

// ---------- 5. 端到端 CLI（复制夹具到临时目录，产物落临时区不污染仓库）----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'expc-analyze-test-'));
  const runsDir = path.join(tmp, 'arm-cx');
  fs.cpSync(FIXTURE_RUNS, runsDir, { recursive: true });
  const tasksFile = path.join(tmp, 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify({ version: '1', tasks: TASKS }, null, 2));

  const analyzePath = path.join(SCRIPT_DIR, 'analyze.mjs');
  const res = spawnSync('node', [analyzePath, '--results', runsDir, '--tasks', tasksFile, '--format', 'both'], { encoding: 'utf8' });
  eq(res.status, 0, 'cli.exit');
  ok(res.stdout.includes('聚合指标'), 'cli.stdout.has_table');
  const outJson = JSON.parse(fs.readFileSync(path.join(tmp, 'analysis.json'), 'utf8'));
  eq(outJson.arms.length, 1, 'cli.json.arms');
  eq(outJson.arms[0].metrics.explicit_trigger.den, 3, 'cli.json.explicit_trigger.den');
  eq(outJson.arms[0].tokens.sum.cache_read, 4200, 'cli.json.tokens');
  ok(fs.existsSync(path.join(tmp, 'analysis.md')), 'cli.md.written');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// renderMarkdown 冒烟：不抛异常且含关键区块
{
  const md = renderMarkdown({ arms: [arm] });
  ok(md.includes('逐 run 明细'), 'render.md.detail');
  ok(md.includes('Token 与成本'), 'render.md.tokens');
  renderJson({ arms: [arm] }); // 不抛
}

console.log(`✓ 全部通过（${checks} 条断言）`);
process.exit(0);
