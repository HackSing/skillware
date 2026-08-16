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

### A-2 宿主级（PLUGIN_SPEC 16.7 第 5 层「真实宿主层」）— ✅ 通过（2026-08-16）

用户在真实终端完成注册（C1 形态）；`claude mcp list` 显示 `askill ✔ Connected`（与用户其余 MCP 共存）。宿主级调用验证：在 dsh-buddy 目录以 `claude -p`（opus-4.8，仅放行两个 skill 工具）发显式任务「用 translator 技能翻译 README 一句」，观察到完整链路：

1. 模型经 ToolSearch 加载两个延迟工具 → `skill_search`（query "translator 文档翻译"）→ translator Top-1；
2. `skill_read` 读入口拿到 `package_ref`；
3. 按技能 quick 模式产出翻译。

首轮上下文实测：cache_creation 22,684 + cache_read 123,550 tokens（dsh-buddy 真实环境很重，后续 D 记账的现实基线）。

**新发现**：
- 🐛 **frontmatter 块标量解析缺陷**：`description: >`（YAML 折叠块，translator/snail 等技能在用）被索引成字面 `">"` ——这类技能的 description 完全没进索引，搜索结果 `short_description` 也显示 `">"`。显式/name 匹配不受影响，但**隐式检索会系统性吃亏，P1 跑批前必须修**，否则实验 C 的隐式触发率会被这个 bug 拉低而误归因为激活问题。
  → ✅ 已修复（2026-08-16，同批还发现并修复点目录排除未真正落地的问题，见"真实库勘察"节更正）：`parseScalar` 支持 `>`/`|` 块标量；复测 translator/snail/design-taste-frontend 描述均为真文本，索引 58 条，smoke 回归通过。**已重新 build，用户重开会话即生效。**
- 宿主环境事实：该环境下 MCP 工具经**延迟加载**（ToolSearch）暴露，工具 schema 不直接全量进首轮——C1 的 instructions 注入因此更关键（它始终在系统提示里）。
- 本次 `-p` 验证会话写进了 dsh-buddy 转录目录（2026-08-16，含 translator 显式任务），被动轨周报人工回顾时应剔除。

判据补充说明：交互式会话的免审批体验未单独验证，将由被动轨第一周真实使用自然覆盖；若出现审批阻断按 `activation_blocked` 记录。

原注册命令（备查）：

注册（用户在真实终端，先 build 出 `dist/`；在 dsh-buddy 目录注册 = 只对该项目生效，实验 C 的实验田）：

```bash
cd /Users/aiware/projects/askill-search/poc && npm run build
cd /Users/aiware/projects/dsh-buddy && claude mcp add askill \
  --env ASKILL_LIBRARY=/Users/aiware/projects/opc-skills \
  --env ASKILL_ACTIVATION=1 \
  -- node /Users/aiware/projects/askill-search/poc/dist/server.js
```

`ASKILL_ACTIVATION=1` = C1 形态（注入激活文案）；去掉该行 = C0 对照形态。卸载：`claude mcp remove askill`。

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
   > ⚠️ 更正（2026-08-16）：本条当时**记录先行、未真正落入代码**——A-2 验收后实测线上索引仍为 368（含 308 条 .backups）。已随块标量修复一并真正实现（点目录 + EXCLUDE_DIRS 双重排除），复测 58 条、.backups 为 0、重名为空。教训：验收记录必须以当次可复现命令的输出为准。

**结论**：收窄版的两大技术风险初步排除——① 索引兼容性（100%）；② 中文检索质量（规则+bigram 即可，MVP 无需 embedding）。

### 局限（不能当验收通过）

- 仅 10 条、由我按技能名反推设计，存在"知道答案"偏差；PLUGIN_SPEC 16.3 要求 ≥50 条固定基准集，尚未建立。
- 这是**协议级**检索质量，非宿主级；模型在真实会话是否主动调用（实验 C 宿主部分）、token 是否下降（实验 D）均未验。

### 待办

- [x] `xueqiu-blogger-archive` 两条同分 → 已定位并解决（2026-08-16）：根因即 `.backups` 重复进索引；点目录排除真正落地后 duplicate names 为空。
- [ ] `include`/`exclude` 配置化（真实库混入 docs/outputs 等，当前靠点目录排除 + `ASKILL_EXCLUDE_DIRS`）。
- [ ] 扩到 ≥50 条固定基准集，含未见过的自然表达，重测 Top-1/Top-5。

---

## 实验 C — 激活有效性（Q3）— 🟡 P0 设施就绪（2026-08-16）

方案见 [../docs/EXPERIMENT_C_PLAN.md](../docs/EXPERIMENT_C_PLAN.md)（实验田 = Claude Code 中开发 dsh-buddy 的真实会话；C0 仅工具描述 vs C1 MCP instructions 激活文案；主动轨跑批 ~100 runs + 被动轨真实会话周报，Opus 4.8，token 记账并入实验 D）。

P0 已完成（claude-code 执行器实现，三批全验收，`b8c3163` 合入 main）：

- **C0/C1 开关**：`ASKILL_ACTIVATION=1` 时 MCP initialize 注入激活文案（`src/activation.ts` 单一来源，≈190 可见字符）；`scripts/smoke-instructions` 双态验证通过。
- **被动轨周报**：`experiments/passive/report.mjs` 扫转录统计触发链 + 四类 token + 全量注入估算（真实库 58 条目 ≈3966 token/请求，估算口径已标注）。
- **固定任务集 v1**：`experiments/c/tasks.json` 30 条（显式 6 / 隐式 12 / 负例 12），`validate-tasks.mjs` 校验通过，用户已确认题目（2026-08-16）。

判据（PLUGIN_SPEC 16.4）：显式触发率=100%、专业任务≥95%、简单任务误触发≤5%、命中后 `skill_read` 完成率=100%。C0 为对照臂不设通过线。

### P1 设施 + smoke 12 runs（2026-08-16）

设施合入 main（`baf3f8d`）：`run-batch.mjs`（一次性 worktree 驱动 `claude -p`，stdin 喂任务）+ `arms/c0|c1.json` + `analyze.mjs`（16.3/16.4 判定聚合；有效性按轨迹 `result.subtype`——`max_turns` 属有效，因测量窗口只在轨迹前段）。原始轨迹在 `results/`（gitignore，不入库）。

**smoke 结果（6 任务 × 2 臂 × 1 次，opus-4.8，12/12 有效）**：

| 指标 | C0（无文案） | C1（instructions 文案） |
|---|---|---|
| 显式触发率 | **0/2**（连 $名字 都不搜） | **2/2** |
| 隐式触发率 | 0/2 | 1/2（translator ✓；safe-update ✗） |
| 隐式 Top-5 / read 完成 | n/a | 1/1 / 2/2 |
| 负例误触发 | 0/2 ✅ | 0/2 ✅ |

- **C0 归零证实 spec §7.4 预判：工具描述不能独立承担激活**——没有文案时模型完全无视技能库（连显式点名都不搜）。C1 的激活增量就是文案的净贡献。
- not_found 例（C1）：搜索触发 ✓、结果空，但模型未报 skill_not_found 而是径直自己干（4 轮被切断）——触发合格、如实报告未达（n=1，全量时复核；或考虑显式类窗口 +1 轮）。
- 隐式 safe-update 未触发（n=1）——全量 3 重复后再判断是否属系统性、是否需要文案迭代。
- **成本实测：12 runs 共 $3.81，均值 ≈$0.32/run；全量 102 runs 预估 ≈$33**。单 run 上下文 ~10–13 万 token（dsh-buddy 真实环境）。

**决策（2026-08-16，用户拍板）**：全量跑批**暂缓**，转入被动轨两周观察，由周报数据驱动后续——若隐式 miss 常见且在乎自动激活，先花 ≈$12 跑隐式 C1×3（36 runs）钉死隐式触发率再迭代文案；BENCHMARK 对外发布前仍需全量跑批（被动轨数据有习惯化偏差，不可作对外证据）。设施与任务集随时可跑，推迟零成本。

待办：被动轨周报（每周，`node poc/experiments/passive/report.mjs --all-projects`）、周报后决策隐式专项/全量、BENCHMARK.md（全量后）。

---

## 多宿主：Kimi Code 接入（2026-08-16）

用户升级为 Claude Code **user 级**注册（所有项目生效，已在 ZBuddy/askill-search 目录实测 Connected）。同日接入第二宿主 **Kimi Code**（VS 插件与 kimi CLI 共用 `~/.kimi-code/`）：

- 配置：`~/.kimi-code/mcp.json` 增加 `askill` 条目（stdio，同一 dist/server.js + 同环境变量；原文件备份 `mcp.json.bak-20260816`）。Kimi 有自己的 `~/.kimi-code/skills/` 全量目录机制，**刻意不用**（收窄版原则）。
- 端到端验证（kimi CLI 显式任务）：✅ `skill_search` → `skill_read`（入口）→ `skill_read`（`EXTEND.md` 子资源探查）→ 按 translator quick 模式产出翻译。**两宿主同一 MCP 合同吃同一技能库，16.7 多宿主层首个证据。**

开放问题 / 待办：
- [ ] Kimi 是否注入 MCP `instructions` 未验——本次是显式任务，无法区分它处于 C1 还是 C0 形态；需 Kimi 侧隐式任务或上下文检查来判定（影响 Kimi 被动数据的归类）。
- [ ] Kimi 会话轨迹在 `~/.kimi-code/sessions/`，格式与 Claude Code 转录不同，周报脚本暂不解析（Kimi 侧使用数据当前只能人工回顾）。

---

## 实验 D — Token 降本（Q4）— ⬜ 待执行

同宿主/模型/项目/任务集下 A/B：原全量注入 vs 关闭注入+两工具+激活规则，测真实首轮 input tokens。

判据（PLUGIN_SPEC 16.2）：Skill 发现常驻上下文降 ≥80%；两工具 Schema ≤1500 字符、激活规则 ≤500 字符；真实 input tokens 明显下降。
