# askill-search

> askill-search 通过“按任务搜索、按需加载”替代 AI Agent 宿主对全量 Skills 的首轮注入，在不牺牲技能可用性的前提下，显著降低不同 Agent 产品和项目的 Token 消耗。

askill-search 是一个独立于具体业务项目和具体 Agent 宿主的通用插件。它以 MCP 提供 `skill_search` 与 `skill_read` 两个跨宿主工具，并允许用户把任意一个或多个本地目录配置为 Skill Library。Codex 是首个适配和验证对象，不是产品边界。

完整的产品边界、架构、配置、实施路线和验收标准见：

- [插件产品与技术方案](docs/PLUGIN_SPEC.md)
- [宿主接入指南](docs/HOST_SETUP.md)——新宿主/新机器挂载 MCP 的步骤、验收清单与常见坑

## 核心边界

- askill-search Core 负责配置、索引、检索、Skill Package 读取和安全边界。
- MCP Server 是跨 Agent 宿主的搜索与读取接口。
- Activation Layer 定义模型何时应搜索 Skill；工具描述只说明能力，不能单独承担激活。
- Host Adapter 负责为每个 Agent 产品安装最小 Activation Policy、配置两个只读工具、全局启用、关闭原 Skills 注入和回滚。
- 支持插件机制的宿主可以把 Core、MCP 和 Adapter 打包成宿主插件。
- Skill Library 是用户可配置的本地技能目录，不要求位于任何 Agent 宿主的默认 Skills 目录。
- 首轮只暴露两个小型工具 Schema，不注入 Skill Library 的全量技能目录。
- 显式指定或需要专业工作流时先搜索；简单聊天、翻译和直接事实问题不搜索。
- Skill 以 `SKILL.md` 为入口、以其目录内引用资源组成 Skill Package；只有已选 Package 的入口和实际需要的单个资源才按需进入当前任务上下文。
- askill-search 不执行 Package 内脚本；宿主能否访问本地模板、素材或脚本，由对应 Host Adapter 明确声明和验收。
- MVP 建议每个宿主会话使用独立 MCP 进程，并通过 SQLite WAL、单写入锁和搜索前增量检查共享索引；该运行拓扑尚未验证，后台单例服务只作为验收不达标时的升级方案。

## 当前状态（2026-08-16，回来先看这里）

**进度台账（单一真源）：[poc/EXPERIMENTS.md](poc/EXPERIMENTS.md)** ——每个实验做没做、结论是什么、下一步待办，全在这一个文件里滚动记录。

当前走**收窄版**：只做「个人技能库按需搜索」，技能不放宿主自动发现目录（天然绕过实验 B）。真实技能库 = `~/projects/opc-skills`（58 个技能）。

- ✅ 阶段 0 POC 已实现（`poc/`）：MCP 双工具（`skill_search`/`skill_read`）协议级验证通过；中文检索 9/9 Top-1（bigram 规则，无 embedding）。
- ✅ 实验 C（激活有效性）P0 设施就绪：C0/C1 激活文案开关、被动轨周报脚本、30 条固定任务集。方案见 [docs/EXPERIMENT_C_PLAN.md](docs/EXPERIMENT_C_PLAN.md)（实验田 = 在 Claude Code 里开发 dsh-buddy 的真实会话）。
- ⬜ **等用户做**：真实终端 `cd poc && npm run build`，然后在 dsh-buddy 目录 `claude mcp add askill --env ASKILL_LIBRARY=… --env ASKILL_ACTIVATION=1 -- node …/poc/dist/server.js`（完整命令见 EXPERIMENTS.md 实验 A-2 节）——装完被动轨即开始积累，顺带完成 A-2 宿主级验收。
- ⬜ 实验 C P1：跑批器 + 判定脚本 + smoke 12 runs + 全量 ~100 runs（Opus 4.8）。
- ⬜ 实验 D（token 降本）：记账已并入实验 C 两轨，正式 A/B（D-mini 实测基线）待做。
- 未动工：正式版 Core、配置 CLI、SQLite 索引、Host Adapter、多宿主验收（均在 POC 结论之后）。
