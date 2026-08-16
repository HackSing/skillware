# askill-search

> askill-search 通过“按任务搜索、按需加载”替代 AI Agent 宿主对全量 Skills 的首轮注入，在不牺牲技能可用性的前提下，显著降低不同 Agent 产品和项目的 Token 消耗。

askill-search 是一个独立于具体业务项目和具体 Agent 宿主的通用插件。它以 MCP 提供 `skill_search` 与 `skill_read` 两个跨宿主工具，并允许用户把任意一个或多个本地目录配置为 Skill Library。Codex 是首个适配和验证对象，不是产品边界。

当前仓库处于方案阶段，尚未实现代码。完整的产品边界、架构、配置、实施路线和验收标准见：

- [插件产品与技术方案](docs/PLUGIN_SPEC.md)

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

## 当前状态

- 已完成：产品与技术方案。
- 未完成：Core、MCP Server、配置 CLI、索引器、Host Adapter、共享索引运行拓扑验证和真实宿主验收测试。
- 当前目录未初始化 Git 仓库，也没有对任何 Agent 宿主的全局配置做修改。
