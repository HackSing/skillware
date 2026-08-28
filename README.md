# skillware

> skillware 通过“按任务搜索、按需加载”替代 AI Agent 宿主对全量 Skills 的首轮注入，在不牺牲技能可用性的前提下，显著降低不同 Agent 产品和项目的 Token 消耗。

skillware 是一个独立于具体业务项目和具体 Agent 宿主的通用插件。它以 MCP 提供 `skill_search` 与 `skill_read` 两个跨宿主工具，并允许用户把任意一个或多个本地目录配置为 Skill Library。Codex 是首个适配和验证对象，不是产品边界。

完整的产品边界、架构、配置、实施路线和验收标准见：

- [插件产品与技术方案](docs/PLUGIN_SPEC.md)
- [宿主接入指南](docs/HOST_SETUP.md)——新宿主/新机器挂载 MCP 的步骤、验收清单与常见坑

## 快速上手

```bash
git clone <本仓库> && cd skillware/poc && npm ci && npm run build && node scripts/setup.mjs
```

配置向导只问两件事：你的技能库目录在哪（当场扫描反馈技能数）、接入哪些宿主（自动检测本机的 Claude Code / Kimi Code，回车全选）。写配置前自动备份，结束给出验证与回滚方式。技能库格式与手动接法见[宿主接入指南](docs/HOST_SETUP.md)。

## 核心边界

- skillware Core 负责配置、索引、检索、Skill Package 读取和安全边界。
- MCP Server 是跨 Agent 宿主的搜索与读取接口。
- Activation Layer 定义模型何时应搜索 Skill；工具描述只说明能力，不能单独承担激活。
- Host Adapter 负责为每个 Agent 产品安装最小 Activation Policy、配置两个只读工具、全局启用、关闭原 Skills 注入和回滚。
- 支持插件机制的宿主可以把 Core、MCP 和 Adapter 打包成宿主插件。
- Skill Library 是用户可配置的本地技能目录，不要求位于任何 Agent 宿主的默认 Skills 目录。
- 首轮只暴露两个小型工具 Schema，不注入 Skill Library 的全量技能目录。
- 显式指定或需要专业工作流时先搜索；简单聊天、翻译和直接事实问题不搜索。
- Skill 以 `SKILL.md` 为入口、以其目录内引用资源组成 Skill Package；只有已选 Package 的入口和实际需要的单个资源才按需进入当前任务上下文。
- skillware 不执行 Package 内脚本；宿主能否访问本地模板、素材或脚本，由对应 Host Adapter 明确声明和验收。
- MVP 建议每个宿主会话使用独立 MCP 进程，并通过 SQLite WAL、单写入锁和搜索前增量检查共享索引；该运行拓扑尚未验证，后台单例服务只作为验收不达标时的升级方案。

## 当前状态（2026-08-16，回来先看这里）

**进度台账（单一真源）：[poc/EXPERIMENTS.md](poc/EXPERIMENTS.md)** ——每个实验做没做、结论是什么、下一步待办，全在这一个文件里滚动记录。

当前走**收窄版**：只做「个人技能库按需搜索」，技能不放宿主自动发现目录（天然绕过实验 B）。作者以自己的真实私人技能库（58 个技能）作为实验库；库的名称、路径与内容不写入对外文档——skillware 对用户永远是"接你自己的库"。

- ✅ 阶段 0 POC（`poc/`）：MCP 双工具协议级验证通过；中文检索 9/9 Top-1（bigram 规则，无 embedding）；块标量描述与点目录排除两缺陷已修。
- ✅ 实验 C（激活有效性）设施全就绪并出首批实测：C0/C1 文案开关、30 条固定任务集、跑批器 + 判定器、被动轨周报（多项目）。smoke 12 runs：**C0 激活归零（证实工具描述不能独立承担激活）、C1 显式 2/2、误触发 0**；单价 ≈$0.32/run。方案见 [docs/EXPERIMENT_C_PLAN.md](docs/EXPERIMENT_C_PLAN.md)。
- ✅ 双宿主接入验证：Claude Code（user 级全局）与 Kimi Code 端到端链路均通过；新人配置向导 `poc/scripts/setup.mjs`。
- ⏸ 全量跑批（~102 runs ≈$33）暂缓：转被动轨两周真实使用，周报驱动后续决策（详见台账）。
- ⬜ 实验 D 正式 A/B（D-mini 实测基线）、BENCHMARK.md（全量后）。
- 未动工：正式版 Core、SQLite 共享索引与并发拓扑验证、发布层（npm 包 / 宿主插件）。
