# skillware 插件产品与技术方案

> 文档状态：待实现  
> 独立项目：`/Users/aiware/projects/skillware`  
> 方案日期：2026-08-09

## 1. 一句话目的

skillware 通过“按任务搜索、按需加载”替代 AI Agent 宿主对全量 Skills 的首轮注入，在不牺牲技能可用性的前提下，显著降低不同 Agent 产品和项目的 Token 消耗。

## 2. 背景

以 Codex 当前行为为首个观察样本：它的 Skill 渐进加载只解决了“不会在首轮读取每个 `SKILL.md` 正文”，没有解决“首轮仍要注入所有 Skill 的名称、描述和路径”这一发现成本。其他采用类似全量能力目录注入方式的 Agent 宿主也存在同类问题。

当用户安装的个人 Skill、系统 Skill 和插件 Skill 逐渐增加时，首轮会出现三个问题：

1. **固定 Token 成本持续增长**：即使任务只需要文件和终端，模型仍会收到大量无关 Skill 描述。
2. **任务判断受到干扰**：大量触发条件、排除条件和插件说明同时出现，会稀释当前任务的核心信息。
3. **全局能力与项目需求耦合**：用户为了保留偶尔需要的专业 Skill，只能接受所有项目持续承担它们的首轮成本。

2026-08-09 在当前本机 Codex 环境中的观察值如下。这些数据只代表当时的本机版本和已安装能力，后续必须用同一环境重新建立基线：

| 指标 | 观察值 |
|---|---:|
| Desktop 首轮 Skills 目录 | 约 162 项、20,614 个可见字符 |
| `codex debug prompt-input` 中 Skills 区块 | 18,219 个可见字符 |
| ZBuddy CLI 默认可见提示 | 33,034 个可见字符 |
| 使用精简测试 Profile 后 | 25,002 个可见字符 |

另外，当前本机 Codex CLI 0.147.0 中名为 `skill_search` 的 feature flag，并没有暴露本方案所需的模型工具，也没有减少 Skills 目录注入。因此，Codex 适配器不能把该 feature flag 当作已经存在的按需检索能力。这是首个宿主的实测限制，不应被写成 skillware 的通用产品限制。

## 3. 产品定位

skillware 是一个**跨 Agent 宿主的全局基础能力插件**，不属于 ZBuddy、Codex 或任何具体业务项目，也不应该包含它们的业务逻辑。

它解决的是 AI Agent 宿主的技能发现和上下文装载问题。这里的 Skill 不是单个 `SKILL.md` 文件，而是以 `SKILL.md` 为入口、包含其同目录下引用资源的 **Skill Package**：

```text
用户任务
  ↓
Host Adapter 安装的最小 Activation Policy 判断是否需要 Skill
  ↓
skill_search 检索用户配置的 Skill Library
  ↓
只返回最相关的 3～5 个候选摘要
  ↓
模型选中一个候选
  ↓
skill_read 读取该 Skill Package 的 SKILL.md
  ↓
按需继续读取该 Package 内被引用的 references、scripts、模板或素材
  ↓
模型按 Skill 完成任务
```

产品采用“Core 负责通用能力、MCP 负责跨宿主运行时接口、Activation Layer 负责技能调用时机、Host Adapter 负责宿主集成、Skill Library 作为被检索内容”的分层设计。对于支持插件机制的宿主，再把这些组件封装为该宿主的插件。

### 3.1 产品目标

1. 建立一套不依赖具体 Agent 产品的本地 Skill 检索与按需读取能力。
2. 允许用户直接指定自己已有的一个或多个技能文件夹，不要求改变原有目录组织。
3. 把技能发现的固定上下文成本从“随 Skill 数量线性增长”变为“两个固定工具 Schema + 本次命中的少量结果”。
4. 在降低 Token 的同时保持显式 Skill 调用和普通任务自动匹配的可用性。
5. 在不预先注入整个 Skill Package 的前提下，保证已选 Skill 的必要引用资源仍然可用。
6. 通过最小、版本化的 Activation Policy 保证模型在显式指定和需要专业工作流时会主动搜索，同时避免简单任务误调用。
7. 通过 Host Adapter 支持不同 Agent 产品，并把宿主配置变更控制在可预览、可验证、可回滚的边界内。

### 3.2 成功定义

skillware 成功不等于 MCP 工具能够启动，而是同时满足：

- 用户配置的技能目录能够被正确索引和搜索，已选 Skill Package 的入口与必要引用资源能够被按需读取。
- 真实 Agent 宿主首轮不再注入该 Skill Library 的全量目录。
- 技能发现相关常驻上下文相对同环境基线减少至少 80%。
- 固定任务集的 Top-5 命中率和代表性任务质量达到验收门槛。
- 真实宿主能够在该搜索时稳定调用 `skill_search`，在简单任务中不误调用，并在命中后继续读取 Skill。
- 宿主集成可以安全回滚，且不移动、删除或修改用户的技能文件。
- 每个对外宣称支持的 Agent 产品都通过自己的 Adapter 和真实运行态验收。

## 4. 用户与使用场景

### 4.1 目标用户

- 在 Codex、Claude Code 或其他支持 MCP/工具扩展的 Agent 产品中安装了较多个人 Skill 的用户。
- 在多个项目间切换，希望所有项目统一降低首轮 Token 的用户。
- 已经有独立技能文件夹，希望直接使用而不迁移进某个 Agent 宿主默认目录的用户。
- 需要控制哪些技能库可用、不同技能库优先级和扫描范围的高级用户。

### 4.2 典型场景

1. 用户把所有自建 Skill 放在 `/Users/example/my-skills`，将该目录加入插件后即可搜索使用。
2. 用户同时拥有“个人技能库”“公司技能库”“实验技能库”，可以分别启停并设置优先级。
3. 用户明确输入 `$presentations` 时，插件应优先精确命中同名 Skill。
4. 用户提出“帮我审查 React 页面的性能问题”时，插件只返回最相关的 React、前端审查或性能类 Skill。
5. 用户修改、增加或删除某个 `SKILL.md` 后，索引能够增量刷新，而不需要重新安装插件。

## 5. 需求

### 5.1 核心功能需求

#### FR-1：全局生效

skillware 在某个宿主中全局安装并启用后，应服务于该宿主的所有项目，而不是根据某个项目路径绑定。不同宿主分别通过 Host Adapter 完成全局集成。

#### FR-2：关闭全量 Skill 目录注入

目标运行态中，Skill Library 内的全部 Skill 名称、描述和路径不得再进入首轮提示词。首轮只保留使用 `skill_search` 和 `skill_read` 所必需的最小工具说明。

“增加 Skill Search，但继续注入全量 Skills”不算完成，因为这只增加了新工具，没有消除原成本。

#### FR-3：用户可配置 Skill Library 目录

用户必须能够配置任意一个或多个本地目录作为 Skill Library，而不是只能使用插件内置目录。

每个目录至少支持：

- 新增、删除、启用和停用。
- 使用绝对路径或可展开的用户路径。
- 是否递归扫描。
- include/exclude 规则。
- 优先级。
- 是否自动监听变更。
- 独立的稳定标识和显示名称。

插件不得复制或移动用户的 Skill 文件；默认在原目录只读索引。

#### FR-4：按任务搜索

`skill_search` 根据当前用户任务检索候选，默认返回 5 个，允许调用者请求 1～10 个。结果只包含选择所需的短信息，不包含 `SKILL.md` 正文。

#### FR-5：按需读取完整 Skill Package

`skill_read` 首次读取一个已经由索引确认的 Skill 入口文件，并返回仅对该 Skill Package 有效的短期 `package_ref`。模型可以继续使用同一个工具，按相对路径逐个读取该 Package 内被 `SKILL.md` 引用的文本资源。

Skill Package 的默认边界是入口 `SKILL.md` 所在目录；如果其后代目录中存在另一个已索引的 `SKILL.md`，该后代目录视为独立 Package，不属于父 Package 的可读范围。

每次调用只返回一个资源，不批量注入整个目录。读取结果必须包含资源相对路径、内容哈希和来源，确保模型知道实际使用的是哪一份内容。

#### FR-6：支持显式指定

当用户明确输入 `$skill-name`、`/skill-name` 或完整技能名时，精确匹配必须高于语义或关键词匹配。

#### FR-7：索引自动更新

新增、修改、删除 Skill 后，插件应通过文件监听或低成本增量扫描更新索引。MVP 建议先在 MCP 启动和搜索前执行带 TTL 的低成本增量检查，不默认启动跨进程长期文件监听；同时提供显式刷新命令。该运行策略尚未通过多进程和性能验证，验证不通过时再评估单例后台服务。

#### FR-8：可诊断、可回滚

用户能够查看当前配置的技能库、索引数量、异常文件和最后刷新时间。关闭 skillware 或恢复宿主原始 Skill 注入时，不得丢失或修改用户技能文件。

#### FR-9：跨宿主扩展

Core、索引格式和两个 MCP 工具合同不得包含 Codex 等具体宿主的配置路径或启动参数。新增 Agent 产品时，应通过 Host Adapter 接入，而不是复制或修改搜索核心。

#### FR-10：Skill 激活策略

Host Adapter 必须为目标宿主安装一段版本化的最小 Activation Policy，使模型在以下场景先调用 `skill_search`：

- 用户显式指定 `$skill-name`、`/skill-name` 或完整技能名。
- 用户任务需要专业工作流、专业产物或可能受益于已安装的复用能力。

命中相关 Skill 后必须调用 `skill_read` 再执行；显式指定未命中时必须报告 `skill_not_found`，不能未经搜索直接声称 Skill 不存在。简单聊天、翻译和直接事实问题不应调用 Skill 工具。

激活支持 `auto` 和 `explicit_only` 两种模式。`auto` 是默认模式；`explicit_only` 只响应显式 Skill 指定。

### 5.2 非功能需求

- **本地优先**：索引、搜索和读取默认全部在本机完成。
- **隐私**：未选中的 Skill Package 正文和依赖资源不得发送给模型或外部服务。
- **确定性**：相同索引、相同查询和相同配置应得到稳定排序。
- **低开销**：MCP 只暴露两个模型工具，避免用更多工具 Schema 重新制造固定上下文成本。
- **激活成本可控**：Activation Policy 目标不超过 500 个可见字符，并与两个工具 Schema 分别计量。
- **跨项目一致**：不同项目共享同一份用户级配置和索引，但允许把当前工作目录作为排序信号。
- **跨进程一致**：CLI、Desktop 和其他 Agent 的多个 MCP 进程共享索引时，只能看到完整提交的索引快照，不能并发执行数据库迁移或无协调写入。
- **错误隔离**：单个损坏或无权限的技能库不能导致整个 MCP Server 不可用。
- **只读安全**：插件不得执行 Skill，也不得编辑 Skill Package 内的任何文件；它只负责发现和按需读取。脚本是否由 Agent 宿主执行，属于宿主自身的能力和授权边界。

## 6. 明确不做的事情

- 不负责执行 Skill 中描述的任务。
- 不修改 Skill 正文，不提供 Skill 编辑器。
- 不由 skillware 直接执行 Skill Package 内的脚本；需要执行脚本时，由 Host Adapter 声明宿主是否具备访问所选 Package 和安全执行本地文件的能力。
- 不把所有 Skill 正文预先合并成一个超级 Router Skill。
- MVP 不依赖云端向量数据库或远程 Embedding 服务。
- 不把 ZBuddy、Docs Harness、Codex 专属行为或其他业务项目规则写进 Core。
- 不自动覆盖任何 Agent 宿主的全局配置；涉及关闭原 Skill 注入时必须先预览、备份并得到用户确认。
- 不把“源码实现”“本机 MCP 可运行”“某个 Host Adapter 生效”“真实宿主生效”混为同一验收层。

## 7. 总体架构

```text
skillware
├── Core
│   └── 配置、技能库、索引、排序与安全边界
├── MCP Server
│   ├── skill_search
│   └── skill_read
├── Activation Layer
│   ├── 版本化 Activation Contract
│   ├── auto / explicit_only 模式
│   └── 激活规则安装与真实任务验证
├── Host Adapters
│   ├── Codex Adapter
│   ├── 其他 MCP Agent Adapter
│   └── 宿主安装、激活、关闭原注入与回滚
├── Plugin Packaging
│   └── 按宿主插件规范封装 Core、MCP 和 Adapter
├── Library Manager
│   ├── 读取用户配置
│   ├── 校验技能库根目录
│   └── 管理启停、优先级和扫描规则
├── Indexer
│   ├── 扫描 SKILL.md
│   ├── 解析 frontmatter
│   ├── 生成稳定 Skill ID
│   └── 增量更新索引
├── Skill Package Reader
│   ├── 建立已选 Package 的短期读取授权
│   ├── 读取 Package 内单个相对资源
│   └── 阻止目录逃逸与跨 Package 读取
├── Ranker
│   ├── 显式名称匹配
│   ├── 关键词与描述匹配
│   └── 项目上下文与技能库优先级加权
├── Local Index
│   └── SQLite 或等价的本地持久化索引
├── Runtime Coordination
│   ├── 共享 SQLite WAL
│   ├── refresh.lock / migration.lock
│   └── 事务提交后递增 index_version
└── Config CLI
    ├── library add/list/remove/enable/disable
    ├── config validate
    ├── index refresh/status
    └── host plan/apply/status/rollback
```

### 7.1 为什么运行时采用 MCP

- MCP 能把搜索和读取暴露为模型可直接调用的结构化工具。
- 参数、返回值、错误和权限边界稳定，不需要模型通过终端拼命令并解析文本。
- MCP Server 可以在模型上下文之外完成本地索引和排序。
- 两个小型工具 Schema 的固定成本可测量、可约束。

### 7.2 为什么采用“通用 Core + MCP + Host Adapter”

MCP 让搜索与读取能力可以被多个 Agent 宿主复用；Host Adapter 隔离各宿主在安装方式、全局配置、Skills 自动注入和重载机制上的差异；Core 不依赖 Codex 等具体产品。

当宿主支持插件机制时，插件负责把 MCP Server、索引器、配置 CLI 和 Host Adapter 作为一个产品安装和升级。MCP 与插件不是二选一：插件是宿主内的交付形态，MCP 是跨宿主能力接口。

### 7.3 为什么不以普通 Skill 作为主入口

如果关闭全量 Skill 注入，模型就无法先发现一个名为 Skill Search 的普通 Skill；如果保留它，又会继续依赖原有 Skill 发现机制。普通 Skill 也不能像 MCP 一样提供稳定的结构化搜索接口。

如宿主必须依赖提示词才能形成调用习惯，可以保留一段极短的插件级说明，但不应贡献新的可自动发现 Skill。

### 7.4 Activation Layer

Skill 搜索能力由 MCP 提供，但模型何时调用搜索由 Activation Layer 负责。该层不进入搜索 Core，而是由一份跨宿主共享的 Activation Contract 和每个 Host Adapter 的具体安装实现组成。

Activation Contract 固定以下语义：

1. 显式 `$name`、`/name` 必须先搜索，未命中时明确报告。
2. 需要专业工作流或专业产物的任务在作答前搜索一次。
3. 命中相关候选后读取 Skill，再按 Skill 执行。
4. 简单聊天、翻译和直接事实问题不搜索。

建议的最小规则如下，具体宿主可以按自己的指令格式编码，但不得改变语义：

```text
用户显式指定 $name 或 /name 时，必须先调用 skill_search；未命中时明确报告。
任务需要专业工作流或专业产物时，回答前调用一次 skill_search；命中后调用 skill_read。
简单聊天、翻译和直接事实问题不调用 Skill 工具。
```

Host Adapter 按“宿主原生插件 developer/system instruction → 经实测有效的 MCP Server instructions → 用户级全局 Agent 指令托管区块”的优先级选择安装渠道。项目级 `AGENTS.md` 只能用于测试或局部兼容，不能作为全局支持的完成证据。如果宿主没有任何稳定的全局模型可见指令渠道，应标记为 `activation_unsupported`。

如果宿主支持命令 Hook 或显式调用解析器，Adapter 应把 `$name`、`/name` 确定性转换为精确搜索；如果只能依靠模型路由，则必须通过显式调用 100% 触发的真实任务验收。

## 8. Skill Library 配置设计

### 8.1 建议配置位置

skillware 配置与各 Agent 宿主的主配置分离，避免升级或回滚时破坏用户现有配置：

```text
macOS:   ~/Library/Application Support/skillware/config.toml
Linux:   ${XDG_CONFIG_HOME:-~/.config}/skillware/config.toml
Windows: %APPDATA%\skillware\config.toml
```

具体路径在实现阶段按跨平台规范和各宿主插件规范校准。

### 8.2 配置示例

```toml
version = 1

[search]
default_limit = 5
max_limit = 10
use_project_context = true

[[libraries]]
id = "personal"
name = "我的技能库"
path = "/Users/example/my-skills"
enabled = true
recursive = true
priority = 100
watch = true
include = ["**/SKILL.md"]
exclude = ["**/node_modules/**", "**/.git/**", "**/archive/**"]

[[libraries]]
id = "team"
name = "团队技能库"
path = "/Users/example/company-agent-skills"
enabled = true
recursive = true
priority = 80
watch = false
include = ["**/SKILL.md"]
exclude = ["**/.git/**"]
```

### 8.3 配置行为

- 支持多个技能库，目录不要求位于 `~/.codex/skills`。
- `path` 在写入配置时规范化为绝对路径；展示时可以保留用户友好形式。
- 同名 Skill 可以来自不同技能库，通过 `library_id + relative_path` 形成唯一 ID。
- `priority` 只作为排序加权，不能覆盖显式名称匹配。
- 禁用技能库后，其 Skill 立即从搜索结果消失，但索引数据可以保留以便快速恢复。
- 删除技能库配置只删除索引记录，不删除原目录或文件。
- 缺失或暂时离线的目录标记为 `unavailable`，不能导致其他技能库不可用。
- 默认不跟随逃逸出技能库根目录的符号链接。

### 8.4 建议 CLI

```bash
skillware library add \
  --id personal \
  --name "我的技能库" \
  --path /Users/example/my-skills \
  --priority 100

skillware library list
skillware library disable personal
skillware library enable personal
skillware library remove personal
skillware config validate
skillware index refresh
skillware index status
```

管理能力放在 CLI，而不是继续增加模型可见的 MCP 工具，避免增加常驻工具 Schema。

## 9. Skill 索引设计

### 9.1 MVP 索引字段

每个 Skill 只索引路由所需信息：

```json
{
  "skill_id": "personal:writing/wechat/SKILL.md",
  "name": "wechat-writer",
  "short_description": "生成微信公众号文章草稿",
  "keywords": ["微信", "公众号", "文章", "wechat"],
  "category": "content",
  "library_id": "personal",
  "relative_path": "writing/wechat/SKILL.md",
  "priority": 100,
  "mtime": 1786240800,
  "size": 6234,
  "content_hash": "sha256:...",
  "status": "ready"
}
```

标准字段优先从 YAML frontmatter 读取：

- `name`
- `description`
- 可选扩展：`keywords`
- 可选扩展：`category`

如果没有扩展字段，MVP 使用名称、描述和相对路径完成检索，不强迫用户重写现有 Skill。

### 9.2 扫描规则

1. 只扫描启用技能库中命中 include 且未命中 exclude 的 `SKILL.md`。
2. 解析 frontmatter，校验必要字段和文件大小上限。
3. 解析失败的文件进入诊断列表，但不阻断其他文件。
4. 使用 `mtime + size` 做快速变化判断，变化后计算内容哈希。
5. 索引记录保存规范化路径，但对模型返回相对路径，避免不必要暴露用户绝对路径。
6. 文件读取前再次校验解析后的真实路径仍位于已授权技能库根目录内。
7. 入口 `SKILL.md` 所在目录作为 Skill Package 根目录；扫描时记录其下是否存在独立的嵌套 Skill Package，供读取边界校验使用。

### 9.3 索引存储

MVP 推荐 SQLite：

- 无需单独服务。
- 支持事务和增量更新。
- 可使用 FTS5 完成名称、关键词和描述的本地全文检索。
- 容易记录库状态、文件状态和索引版本。

索引只保存检索字段、入口文件指纹和 Package 边界；`SKILL.md` 正文及引用资源默认不进入搜索表。`skill_read` 命中后从原文件读取并校验哈希。

### 9.4 MVP 运行拓扑与并发协调（待验证）

当前建议采用“每个宿主会话独立 MCP 进程、多个进程共享用户级 SQLite、单写入锁”的 MVP 运行拓扑：

```text
Codex CLI 会话 ─┐
Codex Desktop ──┼→ 各自启动的 MCP 进程
其他 Agent ─────┘          │
                           ├→ 共享 SQLite（WAL）
                           ├→ refresh.lock
                           └→ migration.lock
```

该方案遵循以下约束：

1. 每个 MCP 进程可以并发读取同一个已提交索引快照。
2. MCP 启动和 `skill_search` 前执行带短 TTL 的 `ensureFresh()`；TTL 内直接读取现有快照，超过 TTL 才尝试低成本增量检查。
3. 只有取得 `refresh.lock` 的进程可以扫描变化并写入索引。其他进程可以继续读取上一个完整快照，或在配置允许时短暂等待，不能自行并发刷新。
4. `skillware index refresh` 与 MCP 使用同一套刷新锁和事务，CLI 不得旁路写入数据库。
5. 数据库 Schema 迁移必须取得独立 `migration.lock`；迁移期间不允许旧版本进程继续写入。
6. SQLite 使用 WAL 和短事务；`index_version` 只在一次完整刷新事务成功提交后递增。
7. `package_ref` 绑定当前 MCP 会话和内容版本，不跨进程共享。
8. 进程在持锁期间崩溃后，锁必须能够通过操作系统文件锁释放或可验证的租约机制恢复，不能依赖永久存在的普通锁文件。

MVP 不默认安装跨平台后台 daemon，也不默认让每个 MCP 进程分别启动长期文件监听。只有当 1,000 个 Skill 的增量检查、搜索延迟或索引新鲜度达不到验收门槛时，才评估“单例后台 daemon 负责监听和写入、MCP 与 CLI 作为客户端”的后续架构。

**验证状态：未验证。** 当前尚未证明目标宿主一定按会话启动独立 MCP 进程，尚未完成多进程刷新、迁移竞争、崩溃恢复和 1,000 Skill 性能测试，因此本节不能作为已冻结实现结论。

## 10. 搜索与排序

### 10.1 MVP 不使用 Embedding

第一版优先使用确定性的规则匹配和 BM25/FTS：

1. 用户显式 `$name` 或 `/name` 精确匹配。
2. 完整 Skill 名精确匹配。
3. 名称前缀和别名匹配。
4. `keywords` 匹配。
5. `description` 和路径片段的全文匹配。
6. 当前项目语言、框架或任务类型加权。
7. 技能库 `priority` 加权。

同分时按以下顺序稳定排序：匹配等级、技能库优先级、Skill 名、Skill ID。

Embedding 只有在基准集证明规则检索达不到质量门槛时才进入后续版本，并且必须保持本地隐私边界或明确获得用户授权。

### 10.2 项目上下文

`cwd`、项目名和有限的技术栈标识可以作为排序信号，但不能成为可用性边界。插件是全局能力，不因项目路径自动切换整套配置。

项目上下文只允许使用低成本、低敏感字段，不默认读取整个仓库内容。

## 11. MCP 工具合同

### 11.1 `skill_search`

请求：

```json
{
  "query": "检查这个 React 页面有没有性能问题",
  "limit": 5,
  "project_context": {
    "cwd": "/workspace/project",
    "technologies": ["react", "typescript"]
  }
}
```

约束：

- `query` 必填，设置长度上限。
- `limit` 默认 5，最大 10。
- `project_context` 可选，宿主未提供时也必须正常工作。
- 不接受任意文件路径，搜索范围只能来自已配置技能库。

响应：

```json
{
  "results": [
    {
      "skill_id": "vercel:react-best-practices/SKILL.md",
      "name": "react-best-practices",
      "short_description": "审查 React 代码的性能与实现方式",
      "library": "vercel",
      "score": 0.94,
      "matched_by": ["technology", "description"],
      "content_hash": "sha256:..."
    }
  ],
  "index_version": 42,
  "total_candidates": 3
}
```

不得返回：

- Skill 正文。
- 未命中 Skill 的描述列表。
- 用户技能库的绝对根目录。
- 调试日志和内部索引结构。

### 11.2 `skill_read`

首次读取 Skill Package 入口：

```json
{
  "skill_id": "vercel:react-best-practices/SKILL.md",
  "resource": "SKILL.md",
  "expected_hash": "sha256:..."
}
```

响应：

```json
{
  "skill_id": "vercel:react-best-practices/SKILL.md",
  "name": "react-best-practices",
  "package_ref": "opaque-short-lived-token",
  "resource": "SKILL.md",
  "content": "完整的 SKILL.md 正文",
  "content_hash": "sha256:...",
  "source": {
    "library_id": "vercel",
    "relative_path": "react-best-practices/SKILL.md"
  },
  "capabilities": {
    "text_resource_read": true,
    "host_package_access": false
  }
}
```

继续读取已选 Skill Package 内的引用资源：

```json
{
  "package_ref": "opaque-short-lived-token",
  "resource": "references/performance-checklist.md"
}
```

响应继续返回单个资源的 `resource`、`content`、`content_hash` 和来源信息，不返回整个目录内容。

约束：

- 每次只能读取一个 Package 内的一个资源。
- 首次读取的 `skill_id` 必须存在于当前启用索引；后续读取必须使用首次响应生成的不可猜测、短期有效 `package_ref`。
- `resource` 必须是相对于 Skill Package 根目录的规范化路径，不接受绝对路径和包含 `..` 的路径。
- 读取前重新解析真实路径，拒绝逃逸技能库根目录、逃逸当前 Package 或进入另一个嵌套 Skill Package。
- `package_ref` 只授权当前已选 Package；Skill 被禁用、删除、内容版本失效或授权过期后必须拒绝读取。
- 提供 `expected_hash` 时，如果文件已变化则返回明确的 `content_changed`，要求重新搜索或确认。
- MVP 默认内联返回受支持的文本资源；设置单文件大小、文件类型和单次任务累计读取上限，超限时明确失败，不静默截断关键规则。
- 二进制模板、素材和需要执行的脚本不得自动注入模型上下文。Host Adapter 必须声明宿主是否支持所选 Package 的本地只读访问；只有具备该能力的宿主才能对依赖本地文件或脚本执行的 Skill 宣称完整支持。

### 11.3 工具安全元数据与审批

`skill_search` 和 `skill_read` 必须向支持 MCP Tool Annotations 的宿主声明只读、非破坏和非开放网络属性：

```text
readOnlyHint = true
destructiveHint = false
openWorldHint = false
```

`skill_search` 可以声明 `idempotentHint = true`。`skill_read` 是否声明幂等取决于内容版本一致性合同；在相同 `expected_hash` 下返回相同内容后才可以声明。

Host Adapter 应只对 skillware 的两个已知工具配置宿主支持的自动允许模式，不能对该宿主的全部 MCP 工具进行宽泛授权。若模型决定调用但被宿主审批阻断，应报告 `activation_blocked`，不能误判为搜索召回失败。

## 12. 宿主集成与迁移方案

### 12.1 目标运行态

```text
支持的 Agent 宿主首轮上下文
├── 必要系统与项目指令
├── 常用基础工具
├── skill_search Schema
├── skill_read Schema
└── 版本化的最小 Activation Policy

不会出现
└── 数百项 Skill 名称、描述和路径目录
```

### 12.2 Activation Policy 安装与验证

Host Adapter 必须实现以下激活能力：

```text
detect_activation()    检测宿主支持的全局指令渠道和显式调用 Hook
plan_activation()      预览规则文本、安装位置、作用域和固定上下文成本
apply_activation()     安装规则及两个工具的只读审批配置
status_activation()    检查规则、工具和审批状态是否一致
verify_activation()    运行显式、隐式专业任务和简单任务三类真实验证
rollback_activation()  只撤销 skillware 管理的激活内容
```

安装必须按以下顺序执行，避免新旧机制切换时出现能力真空：

```text
注册两个 MCP 工具
  → 验证 tools/list
  → 配置两个工具的只读安全元数据与自动允许
  → 安装 Activation Policy
  → 完成三类激活验证
  → 最后关闭原全量 Skills 注入
```

回滚时先恢复宿主原 Skills 注入，再移除 Activation Policy，最后移除 MCP 工具配置。

`status_activation()` 至少区分：

- `activation_ready`：规则、工具、审批和真实任务验证全部通过。
- `activation_missing`：工具存在，但规则未安装或不再可见。
- `activation_orphaned`：规则存在，但工具不可用。
- `activation_blocked`：模型决定调用，但被审批机制阻断。
- `activation_ineffective`：配置存在，但应搜索的真实任务没有触发。
- `activation_unsupported`：宿主没有稳定的全局模型可见指令渠道。

2026-08-09 的最小方向性验证使用 Codex CLI 0.147.0、`gpt-5.6-sol` 和临时只读 MCP，每格只运行一次：

| 条件 | 显式 `$skill` | 隐式专业任务 | 简单翻译 |
|---|---|---|---|
| 普通工具描述 | 未搜索 | 未搜索 | 未搜索 |
| 增强 `skill_search` 工具描述 | 未搜索 | 未搜索 | 未搜索 |
| 434 个可见字符的宿主级激活规则 | 完成搜索与读取 | 完成搜索与读取 | 未搜索 |

该结果证明工具描述不能单独承担激活，宿主级模型可见规则是正式架构的一部分。它只是 CLI 单次方向性证据，不代表统计验收，也不能替代 Desktop、全量 Skills 已关闭或 Token 降本证明。测试还确认：没有只读 Tool Annotations 和宿主自动允许配置时，模型虽会发起调用，但宿主可能取消工具执行。

### 12.3 关闭原 Skill 注入的实现策略

这是项目最大的宿主集成风险，必须在编码前单独验证，不能仅凭设计文档宣称可行。

按优先级采用以下策略：

1. **宿主原生全局开关**：如果目标宿主提供关闭 Skills 自动发现/注入的正式配置，优先使用。
2. **逐项禁用配置**：如果只有单 Skill 的 `enabled=false`，由集成器枚举当前 Skill 并生成可预览的托管禁用项；插件升级或 Skill 路径变化后需要重新对账。
3. **非自动发现目录**：用户个人 Skill 迁移或直接存放到自定义 Skill Library，不放在目标宿主的自动发现目录中。skillware 只索引原位置。
4. **宿主插件 Skill 处理**：其他已安装插件贡献的 Skills 也必须纳入禁用和对账，否则全量目录仍会重新出现。

任何策略都必须满足：

- 先输出变更预览。
- 备份原宿主配置。
- 只修改与 Skill 注入相关的精确配置。
- 提供一键回滚。
- 不删除或移动用户 Skill 文件。
- 宿主升级后重新检查注入是否恢复。

### 12.4 建议集成命令

```bash
skillware host plan --host codex
skillware host apply --host codex --from-plan <plan-id>
skillware host status --host codex
skillware host rollback --host codex
```

`plan` 必须报告：

- 当前宿主名称、版本和配置层级。
- 当前自动发现的 Skill 数量。
- 拟禁用的 Skill 数量和来源。
- 拟保留的 MCP 工具。
- Activation Policy 的版本、模式、安装渠道、作用域和完整文本。
- 两个工具的安全元数据与审批配置。
- 显式、隐式和排除任务的验证计划。
- 预计首轮字符/Token 变化。
- 具体配置变更和回滚位置。

### 12.5 Host Adapter 合同

每个 Agent 宿主通过独立 Adapter 接入，Core 不直接依赖宿主配置格式。Adapter 至少实现：

```text
detect()    识别宿主版本、配置位置和能力
plan()      生成启用 MCP、关闭原注入和回滚预览
apply()     按已确认计划执行精确变更
status()    检查实际运行态是否仍符合计划
rollback()  恢复变更前配置
measure()   收集该宿主首轮上下文和 Token 指标
```

通用 `detect/plan/apply/status/rollback` 必须组合本节的 Activation 能力，确保 MCP 注册、激活规则和原 Skills 注入切换属于同一个可预览、可验证、可回滚的宿主集成计划。

如果宿主不支持插件，只要支持本地 MCP 或等价的结构化工具协议，并能提供稳定的全局模型可见 Activation 渠道，也可以通过 Adapter 安装 skillware。若宿主不能注册外部工具、不能形成稳定激活或不能关闭原 Skills 注入，应明确标记对应能力为 `unsupported`，不能用项目文档提示词模拟全局完成。

### 12.6 Codex 首个适配器

当前已经确认 Profile 是启动命令级能力，不会根据项目路径自动绑定；`codex app` 也不能通过 `-p` 继承 Profile。因此，本插件采用全局集成方向，而不是 ZBuddy 专属 Profile。

但以下结果必须分别验证：

1. MCP Server 源码和单元测试通过。
2. 本机 MCP 协议调用成功，两个工具具备只读安全元数据且不会被宿主审批阻断。
3. Codex 的插件指令、MCP instructions 或用户级全局指令中，至少一种渠道能够稳定安装 Activation Policy。
4. 显式、隐式专业任务和简单任务在 Codex CLI 中达到激活验收门槛。
5. Codex CLI 新任务实际只出现两个搜索工具，不再注入全量 Skills。
6. Codex Desktop 分别达到相同的激活和按需加载运行态。

CLI 成功不能替代 Desktop 成功；调试命令输出也不能替代真实首轮使用量。

这些内容属于 Codex Adapter 的约束，不得进入 Core。后续接入 Claude Code 或其他 Agent 产品时，需要按同一 Adapter 合同重新验证其 MCP 注册、Skills 注入、全局/项目配置优先级、重载和 Token 计量方式。

## 13. 安全与隐私

### 13.1 信任边界

- 用户配置的每个技能库目录是一个显式信任根。
- 搜索只能访问信任根内命中规则的 `SKILL.md`。
- 首次读取只能使用索引生成的 `skill_id`；后续资源读取只能使用短期 `package_ref` 和 Package 内相对路径，不能接受模型提供的任意绝对路径。
- 符号链接解析后必须仍位于技能库信任根和当前已选 Skill Package 内，且不能进入另一个嵌套 Skill Package。
- `package_ref` 不得横向访问未选中的 Skill Package，并在对应 Skill 被禁用、删除或版本失效时立即失效。
- MCP Server 以只读方式打开 Skill Package 内的文件，不负责执行脚本。

### 13.2 日志规则

日志可以记录：

- Skill ID。
- 匹配类型。
- 耗时。
- 索引版本。
- 错误代码。

日志不得记录：

- `SKILL.md` 正文。
- 用户任务全文。
- 用户技能库绝对路径。
- 模型原始工具 I/O。
- 密钥、token 或环境变量值。

### 13.3 恶意 Skill

插件只负责检索和读取，不等于 Skill 内容可信。`skill_read` 返回内容时应标明来源库和哈希；未来可以增加签名或信任级别，但 MVP 不执行 Skill，也不自动提升其权限。

## 14. 错误模型

建议使用稳定错误码：

| 错误码 | 含义 | 处理方式 |
|---|---|---|
| `library_unavailable` | 技能库目录不存在或暂时不可访问 | 跳过该库，其他库继续工作 |
| `invalid_library_config` | 技能库配置无效 | 拒绝该项并给出字段级诊断 |
| `invalid_skill_metadata` | `SKILL.md` 元数据不可解析 | 不入索引，加入诊断列表 |
| `skill_not_found` | Skill ID 不在启用索引 | 重新搜索 |
| `content_changed` | 搜索后文件哈希变化 | 刷新索引并重新选择 |
| `path_outside_library` | 路径或符号链接逃逸 | 拒绝读取并记录安全事件 |
| `skill_too_large` | 正文超过限制 | 明确失败，不静默截断 |
| `package_ref_expired` | Package 读取授权已过期或失效 | 重新搜索并读取入口 |
| `resource_not_found` | 引用资源不存在或已被删除 | 返回缺失资源诊断 |
| `resource_outside_package` | 资源路径逃逸当前 Package 或进入其他 Package | 拒绝读取并记录安全事件 |
| `resource_type_unsupported` | 当前宿主或 MCP 不支持该资源类型 | 返回能力限制，不自动读取或执行 |
| `resource_too_large` | 单资源或累计读取量超过限制 | 明确失败，不静默截断 |
| `index_refresh_busy` | 另一个 MCP 进程正在刷新共享索引 | 默认继续读取上一个完整快照；强一致请求可短暂等待后重试 |
| `schema_migration_busy` | 另一个进程正在迁移索引 Schema | 暂停写入，等待迁移完成后重新打开索引 |
| `index_schema_incompatible` | 当前进程版本与共享索引 Schema 不兼容 | 拒绝写入并提示升级、重启或重建索引 |
| `index_unavailable` | 索引损坏或初始化失败 | 尝试只读恢复或要求重建 |

## 15. 实施阶段

### 阶段 0：宿主能力验证

目标：确认项目成立所依赖的通用 MCP 能力，并完成首个 Codex Adapter 的宿主集成验证。

交付物：

- 通用 MCP Server 最小样例，以及当前目标 Codex 版本的 Adapter/插件 Manifest 最小样例。
- 注册两个 MCP 工具后的真实首轮工具 Schema 测量。
- 至少一种全局 Activation Policy 注入渠道，以及显式、隐式和排除任务的最小验证。
- 两个工具的只读安全元数据和无交互审批调用验证。
- 关闭全量 Skills 注入的可执行策略。
- Codex CLI 与 Desktop 是否共享全局插件配置的实测结论。
- Codex CLI 与 Desktop 的 MCP 进程生命周期实测结论：按任务、按会话、按应用常驻或其他模式。
- “多 MCP 进程共享 SQLite”最小验证：并发读取、单写入锁、刷新中崩溃和旧快照可用性。
- 配置变更与回滚 PoC。

停止条件：如果不能在 Codex Desktop 和 CLI 中消除全量 Skills 注入，Codex Adapter 只能标记为“局部可用”；这不否定通用 Core，但不能宣称 Codex 已全局完成。其他宿主也必须分别通过同类门槛。

### 阶段 1：本地 Skill Library 与索引

交付物：

- 配置模型和校验器。
- 多技能库扫描。
- frontmatter 解析。
- SQLite WAL 索引、`refresh.lock` / `migration.lock` 和带 TTL 的 `ensureFresh()` 增量检查。
- Skill Package 边界识别。
- 重名、坏文件、缺失目录、嵌套 Package 和符号链接安全处理。
- 多 MCP 进程并发读、单写、迁移竞争和崩溃恢复测试。

### 阶段 2：搜索与读取 MCP

交付物：

- `skill_search`。
- 支持入口与 Package 内单资源读取的 `skill_read`。
- 短期 `package_ref` 授权和失效机制。
- 稳定排序和错误合同。
- 工具 Schema 体积测量。
- MCP Tool Annotations 和宿主审批行为测试。
- MCP 协议级自动化测试。

### 阶段 3：通用封装、配置 CLI 与 Adapter SDK

交付物：

- 通用安装包和首个宿主插件包。
- 技能库管理 CLI。
- 索引状态和诊断命令。
- Host Adapter 接口、能力检测和测试夹具。
- 版本化 Activation Contract、`auto` / `explicit_only` 模式和激活验证夹具。
- 升级时配置保留测试。

### 阶段 4：首个宿主全局集成与迁移

交付物：

- `plan/apply/status/rollback` 流程。
- 原配置备份。
- Activation Policy 安装、状态诊断和回滚。
- 显式、隐式专业任务和简单任务的真实激活验证。
- 全量 Skill 注入关闭。
- Codex CLI 与 Desktop 实际新任务验证。
- 宿主能力矩阵和新增 Adapter 接入模板。

### 阶段 5：质量与 Token 验收

交付物：

- 固定检索基准集。
- 同环境 A/B Token 报告。
- 搜索质量、延迟和隐私报告。
- 激活召回率、误触发率和命中后读取完成率报告。
- 安装、升级、回滚验收记录。

## 16. 验收标准

### 16.1 功能验收

- [ ] 用户可以新增一个位于任意本地路径的 Skill Library。
- [ ] 支持至少 3 个同时启用的 Skill Library。
- [ ] 用户可以启停、删除和调整技能库优先级。
- [ ] 删除配置不会删除或修改原 Skill 文件。
- [ ] 新增、修改、删除 `SKILL.md` 后索引能正确更新。
- [ ] 中文名称、中文描述和中文查询能够正常检索。
- [ ] 用户可以选择 `auto` 或 `explicit_only` 激活模式。
- [ ] Host Adapter 能报告 Activation Policy 的版本、安装渠道和当前状态。
- [ ] 显式 Skill 名称 100% 返回正确候选第一名。
- [ ] `skill_search` 默认最多返回 5 个摘要，不返回正文。
- [ ] `skill_read` 首次只能读取一个索引内 Skill 的入口文件，每次调用只返回一个资源。
- [ ] 读取入口后可以使用 `package_ref` 读取该 Skill Package 内被引用的文本资源。
- [ ] `package_ref` 不能读取相邻或嵌套的其他 Skill Package。
- [ ] 依赖二进制模板、本地素材或脚本的 Skill，只有在 Host Adapter 明确具备所选 Package 本地访问能力时才标记为完整支持。
- [ ] 重名 Skill 能通过来源库和稳定 ID 区分。
- [ ] 一个不可用技能库不会影响其他技能库。
- [ ] 关闭 skillware 后可以恢复该宿主原有 Skill 机制。

### 16.2 Token 验收

对每个声称支持的 Agent 宿主，必须在同一宿主版本、模型、插件集合、项目和用户任务下分别进行 A/B：

- [ ] 首轮不再出现 Skill Library 的全量名称、描述和路径目录。
- [ ] Skill 发现相关常驻上下文相对基线减少至少 80%。
- [ ] `skill_search` 与 `skill_read` 两个工具 Schema 合计不超过 1,500 个可见字符；如宿主包装不可控，必须单独报告净增量。
- [ ] Activation Policy 不超过 500 个可见字符，并与工具 Schema 分别报告常驻成本。
- [ ] 首轮实际 API input tokens 明显下降，并与可见提示字符变化方向一致。
- [ ] 读取一个 Skill Package 后，只增加该 Package 的入口、实际请求的单个资源和必要工具结果，不出现其他 Skill Package 的正文或资源。

可见字符只用于快速定位，最终必须以真实任务的 input tokens 为主证据。

### 16.3 检索质量验收

建立至少 50 条覆盖不同领域、中文/英文、显式/隐式表达的固定任务集：

- [ ] 显式名称查询 Top-1 命中率 100%。
- [ ] 普通任务 Top-5 命中率不低于 95%。
- [ ] 普通任务 Top-1 命中率不低于 80%。
- [ ] 无适合 Skill 的任务能够返回空结果或低置信提示，不强行选择无关 Skill。
- [ ] 与全量目录模式相比，代表性任务完成质量没有显著下降。

### 16.4 激活质量验收

建立覆盖显式指定、应自动使用 Skill 和不应使用 Skill 三类任务的固定集合；每个声称支持的宿主形态分别验收：

- [ ] 显式 `$name`、`/name` 的 `skill_search` 触发率为 100%。
- [ ] 应使用 Skill 的专业任务搜索触发率不低于 95%。
- [ ] 简单聊天、翻译和直接事实问题的误触发率不高于 5%。
- [ ] 搜索命中相关候选后，`skill_read` 完成率为 100%。
- [ ] 显式指定未命中时返回 `skill_not_found`，不未经搜索直接声称 Skill 不存在。
- [ ] 无相关 Skill 的自动搜索可以安静回退，不强行读取无关候选。
- [ ] 两个工具不会因为缺少只读安全元数据或审批配置而被宿主取消。
- [ ] 仅配置存在不算通过，必须观察真实任务的模型工具调用记录。

### 16.5 性能验收

以 1,000 个 Skill 的本地库为基准：

- [ ] 热索引 `skill_search` P95 小于 100ms。
- [ ] 单个 `skill_read` P95 小于 50ms，不含宿主模型耗时。
- [ ] 无变化时启动检查小于 300ms。
- [ ] 全量冷扫描目标小于 2s；若硬件差异较大，报告真实数据而不是硬判完成。
- [ ] 文件变更后增量索引不需要重扫所有正文。
- [ ] 至少 5 个 MCP 进程并发搜索且其中 1 个进程刷新时，读取方只能看到刷新前或刷新后的完整快照，不能看到半成品索引。
- [ ] CLI 手动刷新与 MCP 搜索并发执行时，不出现数据库损坏、重复写入或不可恢复锁死。
- [ ] 刷新进程在提交前异常退出后，上一个完整快照仍可读取，后续进程能够重新取得刷新权并完成恢复。
- [ ] Schema 迁移竞争期间，旧版本进程不能继续写入不兼容结构。

### 16.6 安全与隐私验收

- [ ] 任意路径输入不能绕过已配置技能库根目录。
- [ ] 符号链接无法逃逸技能库根目录。
- [ ] 未选中的 `SKILL.md` 正文不进入模型上下文。
- [ ] 未选中的 Skill Package 依赖资源不进入模型上下文。
- [ ] 已选 Package 的资源相对路径、符号链接和嵌套 Package 均不能绕过 Package 边界。
- [ ] 日志不包含 Skill 正文、用户任务全文或技能库绝对路径。
- [ ] 插件不修改或执行任何 Skill 文件。
- [ ] 配置备份、迁移和回滚经过故障注入测试。

### 16.7 验收层级

完成声明必须明确停在哪一层：

1. **方案层**：只有本文档。
2. **源码层**：实现和测试存在。
3. **本机 MCP 层**：两个工具可被协议客户端调用。
4. **Host Adapter 层**：某个宿主的安装、关闭原注入与回滚能够执行。
5. **真实宿主层**：该宿主的新任务实际达到按需加载；不同产品形态分别验收，例如 Codex CLI 与 Codex Desktop。
6. **多宿主层**：至少两个不同 Agent 宿主通过同一 Core 和 MCP 合同验收。
7. **发布层**：通用包和对应宿主插件可安装、升级、回滚并有发布物。

低层证据不能代替高层验收。

## 17. 测试矩阵

| 类别 | 必测场景 |
|---|---|
| 目录配置 | 单目录、多目录、路径含空格、中文路径、目录不存在、无权限目录 |
| 扫描 | 递归开关、include/exclude、隐藏目录、超大文件、坏 frontmatter |
| 更新 | 新增、修改、删除、重命名、监听中断、手动刷新 |
| 并发与拓扑 | 5 个 MCP 进程并发读取、单进程刷新、CLI 与 MCP 竞争刷新、锁等待、刷新中崩溃、迁移竞争、旧快照恢复 |
| 重名 | 同库重名、跨库重名、优先级变化、稳定 ID |
| 搜索 | 中文、英文、中英混合、显式名称、别名、无结果、低置信结果 |
| 激活 | `$name`、`/name`、专业工作流、专业产物、简单聊天、翻译、直接事实、无命中、命中后读取、审批阻断 |
| 读取 | 入口读取、引用文本、多级目录、模板与素材、脚本能力、授权过期、读取后变化、Skill 被删除、超限正文、目录逃逸、跨 Package 读取 |
| 宿主适配 | MCP 注册、全局/项目配置、首轮、第二轮读取、插件升级、宿主升级 |
| Codex 首适配 | CLI 首轮、Desktop 首轮、Profile 限制、全局配置、回滚 |
| 回滚 | 配置 apply 失败、MCP 启动失败、索引损坏、恢复原 Skills 注入 |

## 18. 建议项目结构

实现阶段建议使用 TypeScript/Node.js，以便于 MCP、跨平台 CLI 和多宿主 Adapter 打包；如果阶段 0 证明目标宿主运行时有不同约束，再调整语言或为 Adapter 使用独立封装。

```text
skillware/
├── README.md
├── docs/
│   ├── PLUGIN_SPEC.md
│   ├── ARCHITECTURE.md
│   └── ACCEPTANCE_REPORT.md
├── src/
│   ├── core/
│   ├── mcp/
│   ├── activation/
│   ├── config/
│   ├── libraries/
│   ├── indexer/
│   ├── runtime/
│   ├── packages/
│   ├── search/
│   ├── security/
│   ├── hosts/
│   │   └── codex/
│   └── cli/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── benchmarks/
├── adapters/
│   └── codex/
├── plugins/
│   └── host-specific packages
└── package.json
```

## 19. 关键风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 某个宿主没有稳定的全局关闭开关 | 无法真正消除该宿主的全量目录 | Adapter 阶段优先验证；提供逐项禁用和非自动发现目录策略 |
| 插件升级改变 Skill 路径 | 已禁用 Skill 重新出现 | 运行集成对账，按内容/来源识别变化 |
| MCP 工具 Schema 过大 | 节省被新工具抵消 | 严格限制为两个工具并设置 1,500 字符预算 |
| 模型没有主动调用 `skill_search` | 关闭原目录后 Skill 实际不可发现 | Host Adapter 安装版本化 Activation Policy，并用三类真实任务验收 |
| 只在工具描述中写激活规则 | 模型可能忽略显式和隐式 Skill 需求 | 工具描述只说明能力，宿主级模型可见指令承担激活 |
| 只读 MCP 工具被宿主审批阻断 | 模型决定调用但无法执行 | 声明只读 Tool Annotations，并只对两个已知工具配置自动允许 |
| 多个 MCP 进程并发刷新共享索引 | 出现半成品结果、写锁竞争或索引损坏 | SQLite WAL 提供已提交快照读取，`refresh.lock` 保证单写入者，短事务提交后再提升 `index_version` |
| 进程崩溃留下永久锁 | 后续会话无法刷新索引 | 使用随进程释放的操作系统锁或可校验租约，不以普通永久锁文件作为唯一判断 |
| 过早引入后台 daemon | 增加安装、升级、保活和跨平台故障面 | MVP 不默认引入；只有会话启动、并发或新鲜度验收不达标时才升级拓扑 |
| 搜索召回率不足 | 模型选不到正确 Skill | 固定任务集、显式名称优先、先规则检索后决定是否引入本地 Embedding |
| 用户目录包含恶意链接或大文件 | 越权读取或资源耗尽 | 根目录校验、拒绝逃逸、大小和扫描数量上限 |
| Skill 引用 references、scripts、模板或素材 | 只能发现入口，无法完整使用 Skill | 以 Skill Package 为能力边界，用同一个 `skill_read` 按需读取资源，并由 Adapter 声明本地文件访问能力 |
| 同一宿主的不同产品形态行为不一致 | 只能局部受益 | 分别验收，不用一个形态的结果替代另一个 |
| Host Adapter 修改宿主配置失败 | 用户环境受损 | 默认只生成 plan，apply 前备份，原子写入和一键 rollback |

## 20. 实现前必须确认的七件事

1. 通用 MCP Server 的分发方式和首个目标宿主的 Adapter/插件注册方式。
2. 首个目标宿主是否存在正式的全局 Skills 自动发现/注入关闭开关。
3. 两个 MCP 工具 Schema 在该宿主真实首轮中的净 Token 成本。
4. 同一宿主不同产品形态是否读取相同的全局插件和 MCP 配置；Codex 首先验证 Desktop 与 CLI。
5. 目标宿主如何管理 MCP 生命周期，以及“每个会话独立 MCP + 共享 SQLite WAL + 单写入锁 + 搜索前增量检查”能否通过并发、崩溃恢复和性能验证；验证失败后是否需要升级为单例后台服务。
6. 首个目标宿主如何访问已选 Skill Package 的引用资源，以及对二进制文件和脚本执行能够声明到哪一层能力。
7. 首个目标宿主使用哪一种全局 Activation Policy 渠道，显式调用能否确定性转译，以及两个只读工具能否无交互完成调用。

以上七项确认后再冻结 `ARCHITECTURE.md`，避免在宿主能力未经验证时提前写死实现。

## 21. 后续架构讨论待办

以下事项尚未形成正式架构结论，当前只作为后续讨论清单，不应据此直接进入实现：

| 顺序 | 待讨论事项 | 需要形成的结论 | 状态 |
|---|---|---|---|
| 1 | Host Adapter 配置变更安全 | 明确 `plan/apply/status/rollback` 如何识别配置漂移、保护用户并发修改、原子提交并可靠恢复 | 待讨论 |
| 2 | `skill_search → skill_read` 一致性绑定 | 明确搜索结果与后续读取如何通过内容哈希、索引版本或短期授权绑定，以及内容变化后的处理方式 | 待讨论 |
| 3 | 检索排序与置信度 | 明确中文/英文检索、显式名称优先、Top-K、低置信提示和无合适 Skill 时返回空结果的规则 | 待讨论 |
| 4 | Skill 身份与变更语义 | 明确稳定 ID、跨库重名、目录移动、重命名、复制和删除重建时的识别规则 | 待讨论 |

关闭单项待办需要同时满足：方案正文已更新、关键取舍及风险已记录、验收标准已补齐；需要实测的事项必须标记验证状态，不能仅凭文档讨论标记为已验证。

## 22. 当前交付结论

当前只完成了独立通用插件的方案层交付：项目目录、入口文档和本文档已经建立。尚未编写 Core、MCP 或 Host Adapter 代码，尚未修改任何 Agent 宿主的全局配置，也尚未证明任何真实宿主已经降低 Token。
