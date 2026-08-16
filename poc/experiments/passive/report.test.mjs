#!/usr/bin/env node
// 验收：针对 fixtures 转录目录跑 report.mjs 的扫描逻辑，断言与 fixture 预期严格一致。
// 通过 = 退出码 0。运行：node poc/experiments/passive/report.test.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { scanTranscripts } from "./report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures/sample-transcripts");
const reportPath = path.join(__dirname, "report.mjs");
const SINCE_MS = Date.parse("2000-01-01T00:00:00.000Z");

// ---- 结构化断言（直接调用扫描逻辑，避免 markdown 正则脆性）----
const stats = scanTranscripts(fixturesDir, SINCE_MS);

assert.equal(stats.sessionCount, 2, "会话数应为 2");
assert.equal(stats.sessionsWithSearch, 1, "含 skill_search 的会话数应为 1");
assert.equal(stats.corruptLines, 1, "损坏行计数应为 1");
assert.equal(stats.assistantRequests, 7, "本期 assistant 请求数应为 7");

assert.equal(stats.searchCount, 1, "skill_search 触发次数应为 1");
assert.equal(stats.readCount, 1, "skill_read 触发次数应为 1");

const search = stats.triggers.find((t) => t.tool === "skill_search");
assert.ok(search, "应存在一条 skill_search 触发");
assert.equal(search.query, "把 README 新增章节翻译成英文", "query 文本应与 fixture 一致");
assert.equal(search.followedByRead, true, "同会话中 search 之后应出现 skill_read");

const read = stats.triggers.find((t) => t.tool === "skill_read");
assert.ok(read, "应存在一条 skill_read 触发");
assert.equal(read.target, "lib:translator/SKILL.md", "skill_read 目标应与 fixture 一致");

assert.deepEqual(
  stats.totals,
  { input: 9800, cacheCreation: 400, cacheRead: 54500, output: 680 },
  "四类 token 总计应与 fixture 一致"
);

// ---- CLI 冒烟：退出码 0，且 markdown 含关键数字 ----
const out = execFileSync("node", [reportPath, "--dir", fixturesDir, "--since", "2000-01-01"], {
  encoding: "utf8",
});
assert.match(out, /把 README 新增章节翻译成英文/, "报告应含 search 的 query 文本");
assert.match(out, /跳过的损坏行数：1/, "报告应报告 1 条损坏行");
assert.match(out, /\*\*9800\*\*/, "报告 token 合计应含 input 总计 9800");

console.log("PASS: batch-2 被动轨周报 — 全部断言通过");
