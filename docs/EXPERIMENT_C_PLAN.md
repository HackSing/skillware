# 实验 C 方案：以 dsh-buddy 日常开发为实验田验证激活有效性

> 状态：待用户确认（2026-08-16 起草）
> 关联：[PHASE0_POC_PLAN.md](PHASE0_POC_PLAN.md)、[PLUGIN_SPEC.md](PLUGIN_SPEC.md) §16.4、[poc/EXPERIMENTS.md](../poc/EXPERIMENTS.md)

## 1. 问题与实验田定义

收窄版的命门：技能不进首轮上下文后，**模型凭什么知道该调用 `skill_search`**。搜索质量已初步验证（9/9 Top-1），但模型不来搜，58 个技能等于不存在。

实验田 = **在 Claude Code 中开发 dsh-buddy 项目的真实会话**：

| 要素 | 取值 |
|---|---|
| 宿主 | Claude Code（收窄版目标宿主，与 A-2 同一宿主） |
| 工作目录 | `/Users/aiware/projects/dsh-buddy`（带真实的 12KB CLAUDE.md、docs-harness 规则等真实上下文噪声） |
| 技能库 | `/Users/aiware/projects/opc-skills`（58 个真实技能，经 `ASKILL_LIBRARY` 指入 POC MCP） |
| 任务来源 | dsh-buddy 的真实开发需求（翻译 README、出应用图标、审查预装插件、升级依赖、写发布文案……） |

**注意**：dsh-buddy 只是被开发的对象和任务素材来源，不改其产品代码；它 preset 里自带的 `skill-search.mjs` 与本实验无关（那是 dsh 宿主内的另一套机制）。

选它做实验田的理由：opc-skills 里 translator、image-tools、repo-vetter、safe-update、social-writer、seo-\*、content-formatter 等技能在 dsh-buddy 开发中都有**真实**用武之地——任务不必虚构，测得的激活率贴近真实工作流。

## 2. 前置条件（P0，一次性）

1. **A-2 宿主级注册**：在 dsh-buddy 项目注册 POC MCP（项目级 `.mcp.json` 或 `claude mcp add`），`ASKILL_LIBRARY=/Users/aiware/projects/opc-skills`。验证新会话中两工具可调、readOnly 元数据下审批体验可接受。这是 EXPERIMENTS.md 里 A-2 的执行，顺带完成。
2. **POC 增加 MCP `instructions` 支持**：server 构造时可通过环境变量（如 `ASKILL_ACTIVATION=1`）注入 ≤500 字符激活规则。Claude Code 会把 MCP server instructions 注入系统提示——该机制已在现实会话中确认存在（"MCP Server Instructions" 区块）。这是 C1 臂的开关。

## 3. 实验臂

| 臂 | 激活规则位置 | 含义 |
|---|---|---|
| **C0** | 无——仅两个工具的 description | 下界：工具描述能否独立承担激活（spec §7.4 预判：不能） |
| **C1** | MCP server `instructions`（≤500 字符） | **产品化路径**：随 MCP 注册自动注入，零 CLAUDE.md 侵入。推荐主臂 |
| C2 | 项目/全局 CLAUDE.md 追加同文案 | 备用臂：仅当 C1 未达标时启用（Host Adapter 写文件路径） |

首轮只跑 **C0 vs C1**。C1 达标则 C2 不必做；C1 不达标则先迭代文案 2~3 版，仍不达标再开 C2。

### 激活规则文案 v1（约 190 可见字符，上限 500）

> 个人技能库未列入上下文——不要因为看不见就假设没有技能，也不要凭记忆猜技能名。以下情况先调用 skill_search 再动手：① 用户写 $名字 或"用 XX 技能"（未命中如实报 skill_not_found，不得未搜索就声称不存在）；② 专业工作流任务：文档翻译、文案/排版、图像/图标处理、仓库/依赖审查、发布推广、SEO、报告生成等。命中后用 skill_read 读取入口再执行。简单聊天、单句翻译、直接事实问答、琐碎代码改动不必搜索。

## 4. 任务集（固定 30 条，三类）

从 dsh-buddy 真实开发场景取材。**排除规则**：不得与宿主自带技能重叠（pdf/pptx/xlsx/skill-creator/exec-flow 等 Claude Code 已装技能覆盖的任务一律不用——否则模型走宿主 Skill 属正当行为，会污染判定）。

| 类别 | 条数 | 判定为"正确" | 示例 |
|---|---|---|---|
| 显式指定 | 6 | `skill_search` 被调用且 query 含指定名 | "$translator 把 README 新增章节翻成英文"；"用 image-tools 从 assets/logo.png 出一套 macOS 图标"；含 1 条不存在技能名（须报 skill_not_found 而非直接说没有） |
| 隐式专业 | 12 | 动手前调用 `skill_search`，期望技能进 Top-5 | "把『策展承诺』一节翻译成英文，术语与全文一致"；"要发 0.2 了，写一条公众号风格的中文发布公告"；"这个社区插件想加入预装清单，先做仓库质量与许可证审查"；"升级 electron 到最新稳定版，注意破坏性变更" |
| 负例 | 12 | 全程不调用 `skill_search` | "resolveLauncher 为什么 DSH_CMD 为空时还走了逃生通道"；"electron-builder 的 arm64 和 universal 有什么区别"；"把这段注释改通顺"；**"翻译这句话：……"（单句翻译是刻意的边界负例，spec §6 规定简单翻译不搜索）** |

任务集固化为 `poc/experiments/c/tasks.json`（含 id、类别、任务文本、期望技能/期望空），一经跑批不再改动；改动即新版本号重跑。

### 已知偏差

任务由知道库内容的人设计（与检索初测同一问题）。缓解：① 隐式任务只写工作意图，不出现技能名与其 triggers 词；② 第 6 节的被动轨用真实会话交叉验证。

## 5. 跑批设施（主动轨）

`claude -p` 非交互跑批，每 run 一个全新会话：

```
cd <dsh-buddy 的一次性 git worktree>
claude -p "<任务文本>" \
  --output-format stream-json \
  --strict-mcp-config --mcp-config <臂配置.json> \
  --permission-mode bypassPermissions \
  --max-turns 4 \
  --model opus-4.8
```

- **模型固定 Opus 4.8**（用户日常开发同款；主动轨与被动轨同模型，数据可互相印证）。
- **worktree + bypassPermissions**：任务可能真实改文件（升级依赖等），在一次性 worktree 里放开权限让模型自然行动，跑完丢弃。不在真实 dsh-buddy 工作区跑批。
- **--strict-mcp-config**：批跑只挂 askill MCP，排除用户其它 MCP 的不稳定注入；项目/全局 CLAUDE.md 与宿主自带技能列表保持原样（真实噪声保留）。
- **--max-turns 4（负例 3）**：判定只看轨迹前段——search → read → 开始干活是 3 轮，4 轮封顶足够；负例只需确认前几轮没搜。
- **判定脚本**：解析 stream-json 中的 `tool_use` 事件，抽取 `skill_search`/`skill_read` 调用、query、轮次序号，对照 tasks.json 自动出指标。人工抽查 10% 核对判定器。
- **重复次数按臂区分预算**：C1 是要出结论的臂，重复给足；C0 是对照，只需看出差距方向，每任务 1 次。

| 臂 | 显式 (6) | 隐式 (12) | 负例 (12) | 小计 |
|---|---|---|---|---|
| C1 | ×2 = 12 | ×3 = 36 | ×2 = 24 | 72 |
| C0 | ×1 = 6 | ×1 = 12 | ×1 = 12 | 30 |

合计 **约 100 runs**（原方案 180 的近半）。先跑 smoke（每类 2 条 × 2 臂 × 1 次 = 12 runs）验证设施、判定器并实测单 run 成本，再全量。

统计上的诚实说明：隐式 36 次试验对 ≥95% 判据意味着最多容 1 次失败——样本薄，结论写"通过/不通过 + 失败案例逐条分析"，不写置信区间。

已知近似：`claude -p` 与交互式会话的系统提示不完全一致，激活率测量以此为主证据、以被动轨为真实性校验。

## 6. 被动轨（真实会话观察）——P0 装好即开始

用户当前正持续开发 dsh-buddy，因此被动轨**不是跑批之后的附加项，而是 P0 完成注册当天就开始积累**：C1 配置常驻，正常开发即产生数据。每周从 `~/.claude/projects/-Users-aiware-projects-dsh-buddy/*.jsonl` 转录中用脚本统计：

- 自然发生的 `skill_search` 调用次数、场景、是否命中后完成 `skill_read`；
- 本应搜索却没搜的场合（人工回顾标注）；
- 误触发场合；
- 每会话 token 用量与"相对全量注入的预计节省"（口径见 §7 Token 记账），周报末尾给累计节省数。

这是 §16.4 "必须观察真实任务的模型工具调用记录" 的最强证据，也校准主动轨的"知道答案"偏差。

**但被动轨不能替代跑批**，它有三个测不出的东西：

1. **没有对照**——日常环境常驻 C1，无法回答"激活率是文案挣来的，还是 Opus 4.8 本来就会搜"。这是收窄版最需要的那个数字（激活规则的净贡献），只有 C0 对照臂给得出。
2. **测的是"人+工具"，不是工具**——你知道库里有什么，会不自觉地换措辞、直接 `$name`、或在模型没搜时手动补一句。习惯化会掩盖激活失败。被动轨的失败案例是金子，但成功率数字系统性偏高。
3. **无重复、类别配比不可控**——每个自然任务只发生一次，显式类尤其稀少，区分不了随机失误与系统性失败。

分工：被动轨负责**真实性**（发现真实 miss、验证审批/读取链路），主动轨负责**归因**（C0/C1 差距、可重复的通过判定）。两轨结论合并进 EXPERIMENTS.md。

## 7. 指标与判据（对齐 §16.4）

| 指标 | 判据 | 数据源 |
|---|---|---|
| 显式触发率 | = 100% | 主动轨 |
| 隐式专业任务触发率 | ≥ 95% | 主动轨（被动轨佐证） |
| 负例误触发率 | ≤ 5% | 主动轨（被动轨佐证） |
| 命中后 `skill_read` 完成率 | = 100% | 两轨 |
| 显式未命中处理 | 报 skill_not_found，不臆断 | 主动轨专项 1 条 |
| 工具不被宿主取消 | 交互式会话验证（A-2） | 前置 |

**C0 臂不设通过线**——它是对照，用来量化激活规则的净贡献（预期 C0 显著低于 C1；若 C0 已达标，说明工具描述足矣，激活层可以更薄）。

### Token 记账（实验 D 并入本实验，两轨全程记录）

所有脚本自带 token 记账，最终与激活率合并成对外 benchmark：

**数据来源**（都是现成字段，零额外成本）：
- 主动轨：`claude -p` 的 stream-json 结果自带每 run 的 usage（input / cache_creation / cache_read / output tokens）；
- 被动轨：transcript .jsonl 里每条 assistant 消息都带 usage，周报脚本一并统计。

**每份报告出三个数**：

| 数 | 怎么得 |
|---|---|
| ① 实测常驻净增量 | C1 相对 C0 的首轮 input tokens 差（两工具 Schema + instructions 的真实成本） |
| ② 全量注入的假想成本 | 把 58 个技能的 name+description 按宿主目录格式渲染，数 token，按"每请求常驻"折算到同任务轮次 |
| ③ 预计节省 | ② − ① − 实际发生的 skill_search/skill_read 结果 token；按会话与累计两个口径输出 |

**D-mini（可选加硬）**：②是算出来的，不是量出来的。若要 benchmark 更硬，用隔离配置目录（`CLAUDE_CONFIG_DIR`）把 58 技能真实装进宿主技能目录，同任务 5 条 × 两种配置实测首轮 input tokens，把"估算"升级为"实测 A/B"。约 10 runs，成本可忽略，不碰日常环境。

## 8. 产出物

```
poc/experiments/c/
  tasks.json          # 固定任务集 v1
  arms/c0.json c1.json  # 每臂 MCP 配置
  run-batch.mjs       # 跑批器
  analyze.mjs         # 判定与指标聚合
  results/            # 原始 stream-json + 指标表
```

- EXPERIMENTS.md 实验 C 一节更新为本方案的执行记录；
- **BENCHMARK.md**：面向对外的评测报告——激活率表（16.4 五项指标 × C0/C1）+ token 节省表（三个数 + D-mini 实测），含方法学与局限说明，作为项目说服力材料；
- 激活规则文案的最终版（迭代历史保留）；
- POC server 的 `instructions` 支持（C0/C1 切换用，日常环境常开）。

## 9. 迭代与停止条件

- C1 未达标 → 只改激活文案（不动任务集）重跑，最多 3 版；
- 3 版仍未达标 → 开 C2 臂（CLAUDE.md 注入）；
- C2 仍未达标 → 触发 spec 的停止条件讨论：激活层假设不成立，收窄版需要重新设计（如宿主 Hook 强制注入、或退回部分目录注入的混合态）。

## 10. 决策记录

1. **模型**：Opus 4.8（用户 2026-08-16 确认，日常开发同款）。
2. **规模**：跑批降为约 100 runs（C1 全量重复、C0 单次对照），max-turns 6→4；smoke 12 runs 实测单价后再确认全量预算。
3. **被动轨**：用户正持续开发 dsh-buddy，P0 注册完成即开始积累；窗口暂定 2 周，随时可提前结算。
