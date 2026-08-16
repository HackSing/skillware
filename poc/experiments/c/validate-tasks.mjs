#!/usr/bin/env node
// 实验 C 固定任务集校验器（纯 Node ≥18，零第三方依赖）。
//
// 用法：
//   node poc/experiments/c/validate-tasks.mjs [--tasks <path>] [--library <path>]
//
// 默认 --tasks poc/experiments/c/tasks.json，--library /Users/aiware/projects/opc-skills。
// 校验 batch-3 规格的全部规则；全部通过退出 0，任何违规逐条打印后退出 1。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = {
    tasks: 'poc/experiments/c/tasks.json',
    library: '/Users/aiware/projects/opc-skills',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tasks') out.tasks = argv[++i];
    else if (a === '--library') out.library = argv[++i];
    else if (a.startsWith('--tasks=')) out.tasks = a.slice('--tasks='.length);
    else if (a.startsWith('--library=')) out.library = a.slice('--library='.length);
    else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return out;
}

// ---------- 规格常量 ----------
const CLASS_COUNTS = { explicit: 6, implicit: 12, negative: 12 };
const MAX_TURNS_BY_CLASS = { explicit: 4, implicit: 4, negative: 3 };
// 全集禁词表（对 text 做大小写不敏感子串匹配）。
const FORBIDDEN = [
  'pdf', 'pptx', 'ppt', 'xlsx', 'docx', 'word 文档',
  'excel', '幻灯片', 'skill 创建', 'skill-creator', 'exec-flow',
];
const SINGLE_TRANSLATE_MARKER = '翻译这句话';

// ---------- 技能库解析（只读） ----------
function unquote(s) {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function* walkSkillFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkSkillFiles(p);
    else if (e.isFile() && e.name === 'SKILL.md') yield p;
  }
}

function frontmatterLines(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const fm = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return fm;
    fm.push(lines[i]);
  }
  return fm;
}

function parseName(fm) {
  for (const l of fm) {
    const m = l.match(/^name:\s*(.+?)\s*$/);
    if (m) return unquote(m[1]);
  }
  return null;
}

// 收集技能的触发词原文（来自 triggers: 列表、metadata.trigger 字符串/块标量、
// metadata.triggers 列表）。翻译等技能没有 triggers 字段则返回空数组。
function parseTriggerStrings(fm) {
  const out = [];
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    let m;
    if ((m = line.match(/^(\s*)triggers:\s*(.*)$/))) {
      const indent = m[1].length;
      const val = m[2].trim();
      if (val.startsWith('[')) {
        val.replace(/^\[|\]$/g, '').split(',').forEach((s) => {
          const t = unquote(s.trim());
          if (t) out.push(t);
        });
      } else if (val && val !== '') {
        out.push(unquote(val));
      } else {
        let j = i + 1;
        for (; j < fm.length; j++) {
          const l2 = fm[j];
          if (l2.trim() === '') continue;
          const ind2 = l2.match(/^(\s*)/)[1].length;
          if (ind2 <= indent) break;
          const lm = l2.match(/^\s*-\s*(.+?)\s*$/);
          if (lm) out.push(unquote(lm[1]));
          else break;
        }
        i = j - 1;
      }
    } else if ((m = line.match(/^(\s*)trigger:\s*(.*)$/))) {
      const indent = m[1].length;
      const vt = m[2].trim();
      if (vt === '>' || vt === '|' || vt === '>-' || vt === '|-') {
        let j = i + 1;
        const buf = [];
        for (; j < fm.length; j++) {
          const l2 = fm[j];
          if (l2.trim() === '') continue;
          const ind2 = l2.match(/^(\s*)/)[1].length;
          if (ind2 <= indent) break;
          buf.push(l2.trim());
        }
        out.push(buf.join(' '));
        i = j - 1;
      } else if (vt) {
        out.push(unquote(vt));
      }
    }
  }
  return out;
}

// 触发词原文 -> 按 / , ，、 换行拆分出的短语 token（≥2 字符）。
function tokenizeTriggers(rawList) {
  const toks = new Set();
  for (const raw of rawList) {
    for (const part of raw.split(/[\/,，、\r\n]+/)) {
      const t = part.trim();
      if (t.length >= 2) toks.add(t);
    }
  }
  return [...toks];
}

function loadLibrary(libDir) {
  const skills = new Map(); // name -> { triggers: string[] tokens }
  for (const file of walkSkillFiles(libDir)) {
    const content = fs.readFileSync(file, 'utf8');
    const fm = frontmatterLines(content);
    if (!fm) continue;
    const name = parseName(fm);
    if (!name) continue;
    const tokens = tokenizeTriggers(parseTriggerStrings(fm));
    // 同名技能合并触发 token（防御性处理）。
    const prev = skills.get(name);
    if (prev) prev.triggers = [...new Set([...prev.triggers, ...tokens])];
    else skills.set(name, { triggers: tokens });
  }
  return skills;
}

// ---------- 校验 ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const violations = [];
  const add = (msg) => violations.push(msg);

  // 读取任务集
  const tasksPath = path.resolve(args.tasks);
  let raw;
  try {
    raw = fs.readFileSync(tasksPath, 'utf8');
  } catch (e) {
    console.error(`无法读取任务集：${tasksPath}（${e.message}）`);
    process.exit(1);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    console.error(`tasks.json 解析失败：${e.message}`);
    process.exit(1);
  }

  // 读取技能库
  const skills = loadLibrary(path.resolve(args.library));
  const skillNames = new Set(skills.keys());
  if (skillNames.size === 0) {
    add(`技能库为空或不可读：${args.library}`);
  }

  // 顶层字段
  if (typeof doc.version !== 'string' || doc.version.trim() === '') {
    add('顶层 version 缺失或非字符串。');
  }
  if (typeof doc.created !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.created)) {
    add('顶层 created 缺失或非 YYYY-MM-DD 格式。');
  }
  if (!Array.isArray(doc.tasks)) {
    add('顶层 tasks 缺失或不是数组。');
    // tasks 不可用时无法继续逐条校验
    report(violations);
    return;
  }

  const tasks = doc.tasks;

  // 总数与配比
  if (tasks.length !== 30) add(`任务总数应为 30，实际 ${tasks.length}。`);
  const byClass = { explicit: 0, implicit: 0, negative: 0 };

  const seenIds = new Set();
  let notFoundCount = 0;
  let singleTranslateFound = false;

  tasks.forEach((t, idx) => {
    const where = `任务#${idx + 1}(${t && t.id ? t.id : '无id'})`;

    // schema 完整性
    if (typeof t !== 'object' || t === null) {
      add(`${where}: 不是对象。`);
      return;
    }
    if (typeof t.id !== 'string' || t.id.trim() === '') add(`${where}: id 缺失或非字符串。`);
    else {
      if (seenIds.has(t.id)) add(`${where}: id 重复。`);
      seenIds.add(t.id);
    }
    if (!['explicit', 'implicit', 'negative'].includes(t.class)) {
      add(`${where}: class 非法（${t.class}）。`);
      return; // class 未知则后续按类校验无意义
    }
    byClass[t.class]++;

    if (typeof t.text !== 'string' || t.text.trim() === '') add(`${where}: text 缺失或非字符串。`);
    if (!Array.isArray(t.expected_skills) || !t.expected_skills.every((s) => typeof s === 'string')) {
      add(`${where}: expected_skills 必须是字符串数组。`);
    }
    if (typeof t.expect_not_found !== 'boolean') add(`${where}: expect_not_found 必须是布尔值。`);
    if (typeof t.max_turns !== 'number' || !Number.isInteger(t.max_turns)) {
      add(`${where}: max_turns 必须是整数。`);
    }
    if ('notes' in t && typeof t.notes !== 'string') add(`${where}: notes 若存在必须是字符串。`);

    const text = typeof t.text === 'string' ? t.text : '';
    const lowerText = text.toLowerCase();
    const expected = Array.isArray(t.expected_skills) ? t.expected_skills : [];

    // max_turns 取值
    const wantTurns = MAX_TURNS_BY_CLASS[t.class];
    if (t.max_turns !== wantTurns) {
      add(`${where}: ${t.class} 类 max_turns 应为 ${wantTurns}，实际 ${t.max_turns}。`);
    }

    // 禁词表
    for (const bad of FORBIDDEN) {
      if (lowerText.includes(bad.toLowerCase())) {
        add(`${where}: text 命中禁词「${bad}」。`);
      }
    }

    // 类别专属规则
    if (t.class === 'negative') {
      if (expected.length !== 0) add(`${where}: negative 类 expected_skills 必须为空数组。`);
      if (t.expect_not_found === true) add(`${where}: negative 类 expect_not_found 必须为 false。`);
      if (text.includes(SINGLE_TRANSLATE_MARKER)) singleTranslateFound = true;
    } else {
      // explicit / implicit 至少 1 个期望技能
      if (expected.length < 1) add(`${where}: ${t.class} 类 expected_skills 不得为空。`);
    }

    if (t.class === 'implicit') {
      if (t.expect_not_found === true) add(`${where}: implicit 类 expect_not_found 必须为 false。`);
      // name / trigger 词泄漏检查
      for (const sk of expected) {
        if (lowerText.includes(sk.toLowerCase())) {
          add(`${where}: implicit 文本泄漏了技能名「${sk}」。`);
        }
        const meta = skills.get(sk);
        if (meta) {
          for (const tok of meta.triggers) {
            if (lowerText.includes(tok.toLowerCase())) {
              add(`${where}: implicit 文本泄漏了「${sk}」的触发词「${tok}」。`);
            }
          }
        }
      }
    }

    if (t.class === 'explicit') {
      // 显式类必须在文本中点名每个期望技能
      for (const sk of expected) {
        if (!lowerText.includes(sk.toLowerCase())) {
          add(`${where}: explicit 文本未点名技能「${sk}」。`);
        }
      }
    }

    // expect_not_found 与存在性
    if (t.expect_not_found === true) {
      notFoundCount++;
      if (t.class !== 'explicit') add(`${where}: expect_not_found 只应出现在 explicit 类。`);
      for (const sk of expected) {
        if (skillNames.has(sk)) {
          add(`${where}: expect_not_found 为 true，但技能「${sk}」在库中真实存在。`);
        }
      }
    } else {
      for (const sk of expected) {
        if (!skillNames.has(sk)) {
          add(`${where}: 期望技能「${sk}」在技能库中不存在。`);
        }
      }
    }
  });

  // 配比
  for (const [cls, want] of Object.entries(CLASS_COUNTS)) {
    if (byClass[cls] !== want) add(`${cls} 类应为 ${want} 条，实际 ${byClass[cls]}。`);
  }

  // expect_not_found 恰好 1 条
  if (notFoundCount !== 1) add(`expect_not_found=true 的任务应恰好 1 条，实际 ${notFoundCount}。`);

  // 单句翻译边界负例存在
  if (!singleTranslateFound) {
    add(`negative 类中缺少单句翻译边界负例（含「${SINGLE_TRANSLATE_MARKER}」的任务）。`);
  }

  report(violations, { tasks: tasks.length, byClass, skills: skillNames.size });
}

function report(violations, summary) {
  if (violations.length === 0) {
    if (summary) {
      console.log(
        `校验通过：${summary.tasks} 条任务（explicit ${summary.byClass.explicit} / ` +
          `implicit ${summary.byClass.implicit} / negative ${summary.byClass.negative}），` +
          `技能库 ${summary.skills} 个技能名。`,
      );
    } else {
      console.log('校验通过。');
    }
    process.exit(0);
  }
  console.error(`校验失败，共 ${violations.length} 处违规：`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

main();
