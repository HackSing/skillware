# 阶段 0 实验记录

> 依据 [../docs/PHASE0_POC_PLAN.md](../docs/PHASE0_POC_PLAN.md) 第 6 节。
> 宿主：Claude Code。技术栈：TypeScript + 官方 `@modelcontextprotocol/sdk`（低层 `Server` API）。

## 运行方式（重要）

当前执行沙箱**跨命令回收编译产物**（`dist/`、`scripts/*.js` 不跨 Bash 调用保留），因此 build 与运行必须在**同一条命令链**内：

```bash
cd poc && npm run build \
  && npx tsc scripts/smoke.ts --module nodenext --moduleResolution nodenext \
       --target es2022 --esModuleInterop --skipLibCheck --outDir scripts \
  && node scripts/smoke.js
```

> 用户真实终端不受此限制：`npm run build` 后 `dist/` 会正常持久，可直接被宿主以 `node dist/server.js` 拉起。

---

## 实验 A — 工具可调用性（Q1）

### A-1 协议级（PLUGIN_SPEC 16.7 第 3 层「本机 MCP 层」）— ✅ 通过（2026-08-16）

用 MCP `Client` 经 stdio 连自建 `Server`，验证 `tools/list` 与两个工具调用。

| 检查项 | 结果 |
|---|---|
| `tools/list` 返回两个工具 | ✅ `skill_search`、`skill_read` |
| 只读安全元数据 | ✅ 两者均 `readOnlyHint=true, destructiveHint=false, openWorldHint=false`；`skill_search` 另带 `idempotentHint=true` |
| 显式 `$react-review` | ✅ `react-review` score=1.00，`matched_by=[explicit]` |
| 隐式专业任务「审查 React 页面性能」 | ✅ `react-review` 排第一（name+keyword+description） |
| 中文任务「写微信公众号文章」 | ✅ `wechat-writer` 命中 |
| 简单任务「翻译成英文」 | ✅ 无命中，不误召回 |
| `skill_read` 入口 + `package_ref` | ✅ 返回入口正文、hash、短期 ref |
| `skill_read` 子资源 | ✅ 凭 ref 读取 `references/performance-checklist.md` |
| 安全：`../wechat-writer/SKILL.md` | ✅ 拒绝 `resource_outside_package` |
| 安全：嵌套 Package `nested/SKILL.md` | ✅ 拒绝 `enters nested package` |
| 安全：绝对路径 `/etc/passwd` | ✅ 拒绝 `absolute path not allowed` |

**结论**：协议层假设成立——两个只读工具能被 MCP 客户端稳定调用，搜索/读取逻辑正确，路径与 Package 边界有效。

### A-2 宿主级（PLUGIN_SPEC 16.7 第 5 层「真实宿主层」）— ⬜ 待执行

在 Claude Code 注册本 MCP，验证模型**免交互审批**调用两个只读工具。

注册（用户在真实终端，先 build 出 `dist/`）：

```bash
cd /Users/aiware/projects/askill-search/poc && npm run build
claude mcp add askill-search-poc -- node /Users/aiware/projects/askill-search/poc/dist/server.js
```

判据：新会话中 `skill_search` / `skill_read` 能被调用，只读元数据下不被宿主取消执行；若被审批阻断记 `activation_blocked`。

---

## 实验 B — 关闭全量注入（Q2，最致命）— ⬜ 待执行

> 敏感操作：改 Claude Code 配置前必须先备份、可回滚；效果仅在**新会话**可见。需用户明确同意。

1. 侦测 Claude Code 是否有关闭 skills 全量注入的正式开关（查配置/文档/首轮实际内容）。
2. 若无 → 退到逐项禁用 / 非自动发现目录策略（测试 Skill 只由本 MCP 索引）。
3. 开新会话，测首轮是否还出现全量 skills 目录。

判据：首轮不再出现 Skill Library 全量名称/描述/路径。两条策略都做不到 → 触发停止条件，Claude Code 标「局部不可用」。

---

## 真实库勘察 + 检索质量初测（2026-08-16，收窄版）

用户确认走**收窄版**：只做「个人技能库按需搜索」，技能不放宿主自动发现目录 → 天然绕过实验 B。
真实库：`/Users/aiware/projects/opc-skills`。

### 库勘察

| 项 | 值 |
|---|---|
| `SKILL.md` 原始总数 | 368 |
| 其中 `.backups/` 历史备份 | 308（噪声，需排除） |
| 真实技能数（排除点目录/node_modules） | **58** |
| frontmatter 兼容率（有 `name`+`description`） | **58/58 = 100%** |
| 触发词字段 | 多用 `triggers`（非 `keywords`），已让解析器合并读取 |

### 检索质量（10 条中英/显式/隐式查询，MCP 协议级）

| | 改进前 | 改进后 |
|---|---|---|
| 有期望用例 Top-1 命中 | 3/9（且 2 个是显式） | **9/9 全部 Top-1** |
| 简单问题（"今天天气"）误召回 | 无 ✅ | 无 ✅ |

关键改进（均为便宜的确定性规则，**未引入 embedding**）：
1. 索引 `triggers` 字段（人工触发词）。
2. **中文 2-gram (bigram) 匹配**——解决"中文无空格分词导致子串匹配失效"这一根因。
3. 排除 `.backups` 等点目录（索引 368 → 58）。

**结论**：收窄版的两大技术风险初步排除——① 索引兼容性（100%）；② 中文检索质量（规则+bigram 即可，MVP 无需 embedding）。

### 局限（不能当验收通过）

- 仅 10 条、由我按技能名反推设计，存在"知道答案"偏差；PLUGIN_SPEC 16.3 要求 ≥50 条固定基准集，尚未建立。
- 这是**协议级**检索质量，非宿主级；模型在真实会话是否主动调用（实验 C 宿主部分）、token 是否下降（实验 D）均未验。

### 待办

- [ ] `xueqiu-blogger-archive` 在结果中出现两条同分，`find` 仅见一个入口且 name 无重复 → 来源待查（疑似嵌套 `SKILL.md`）。
- [ ] `include`/`exclude` 配置化（真实库混入 docs/outputs 等，当前靠点目录排除 + `ASKILL_EXCLUDE_DIRS`）。
- [ ] 扩到 ≥50 条固定基准集，含未见过的自然表达，重测 Top-1/Top-5。

---

## 实验 C — 激活有效性（Q3）— ⬜ 待执行

三类任务各 ≥5 次，对比「仅工具描述」vs「加 ≤500 字符宿主级激活规则」。

判据（PLUGIN_SPEC 16.4）：显式触发率=100%、专业任务≥95%、简单任务误触发≤5%、命中后 `skill_read` 完成率=100%。

---

## 实验 D — Token 降本（Q4）— ⬜ 待执行

同宿主/模型/项目/任务集下 A/B：原全量注入 vs 关闭注入+两工具+激活规则，测真实首轮 input tokens。

判据（PLUGIN_SPEC 16.2）：Skill 发现常驻上下文降 ≥80%；两工具 Schema ≤1500 字符、激活规则 ≤500 字符；真实 input tokens 明显下降。
