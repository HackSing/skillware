# 宿主接入指南：把你自己的技能库接入任意 Agent 宿主

> 一句话架构：**技能库一份（你自己的）、MCP server 一份、宿主配置每家一条。**
> skillware 不自带技能，也不要求技能放在任何宿主的默认目录——你指定一个本地目录作为技能库，它负责按需搜索与读取。
> 已验证宿主：Claude Code、Kimi Code、Codex CLI。

## 技能库格式要求

技能库是一个普通本地目录，里面每个技能一个子目录、以 `SKILL.md` 为入口，frontmatter 至少含 `name` 与 `description`（可选 `triggers` 触发词，支持 YAML 块标量写法）：

```
my-skills/
  translator/SKILL.md
  seo-audit/SKILL.md
  …
```

以 `.` 开头的目录与 `node_modules` 不会被索引（历史备份放 `.backups/` 即可自动排除）。

## 快速接入（推荐）：配置向导

```bash
git clone <本仓库> && cd skillware/poc && npm ci && npm run build
node scripts/setup.mjs
```

向导只问两件事：**① 你的技能库目录**（当场扫描并报告发现的技能数）；**② 接入哪些宿主**（自动检测本机的 Claude Code / Kimi Code，回车全选）。写配置前自动备份，结束时给出验证与回滚方式。

非交互 / 脚本化：

```bash
node scripts/setup.mjs --library <你的技能库路径> [--hosts claude,kimi] [--no-activation] [--dry-run]
```

## 环境变量（手动配置时传给 server）

| 变量 | 必填 | 含义 |
|---|---|---|
| `SKILLWARE_LIBRARY` | 是 | 技能库根目录绝对路径 |
| `SKILLWARE_ACTIVATION` | 建议 `1` | `1` = 经 MCP `instructions` 注入激活规则（C1 形态）。不设则为纯工具形态（C0）——实验实测 C0 激活率为零，日常使用应开 |
| `SKILLWARE_EXCLUDE_DIRS` | 否 | 逗号分隔的额外排除目录名 |

## 手动接法（向导之外的等价操作）

以下 `<skillware>` 代表本仓库绝对路径，`<library>` 代表你的技能库绝对路径。

### Claude Code

```bash
claude mcp add skillware --scope user \
  --env SKILLWARE_LIBRARY=<library> \
  --env SKILLWARE_ACTIVATION=1 \
  -- node <skillware>/poc/dist/server.js
```

- `--scope user` = 全部项目生效；只想单项目试验则去掉该参数并在目标项目目录里执行（local 级会覆盖同名 user 级，别两级同时挂）。
- 回滚：`claude mcp remove skillware`。

### Kimi Code（VS 插件与 kimi CLI 共用）

编辑 `~/.kimi-code/mcp.json`（改前备份），在 `mcpServers` 里加：

```json
"skillware": {
  "transport": "stdio",
  "command": "node",
  "args": ["<skillware>/poc/dist/server.js"],
  "env": { "SKILLWARE_LIBRARY": "<library>", "SKILLWARE_ACTIVATION": "1" }
}
```

- `transport` 字段是 Kimi 要求的；VS 插件需重启窗口生效。
- Kimi 自带的 `~/.kimi-code/skills/` 全量注入目录**刻意不用**——本项目的意义就是替代全量注入。
- 回滚：删掉该条目。

### Codex CLI

编辑 `~/.codex/config.toml`（改前备份），加：

```toml
[mcp_servers.skillware]
command = "node"
args = ["<skillware>/poc/dist/server.js"]

[mcp_servers.skillware.env]
SKILLWARE_LIBRARY = "<library>"
SKILLWARE_ACTIVATION = "1"
```

- 验证：`codex mcp list` 应显示 `skillware ... enabled`。
- 回滚：删掉这两段。

### 其他宿主（通用判定三问）

1. **支持 stdio MCP 吗？** 支持则在其 MCP 配置处加等价条目（字段名可能小有出入）。不支持则暂不可接。
2. **吃 MCP `instructions` 吗？** 决定激活形态：吃 = C1（自动激活可用）；不吃 = 实际是 C0，激活率会归零，需把激活文案写进该宿主自己的提示词安装位（如 AGENTS.md、系统提示配置）。
3. **会话轨迹存哪、什么格式？** 决定使用数据能否被统计脚本解析（当前只解析 Claude Code 转录）。

## 接入验收清单（每个新宿主/新机器走一遍）

- [ ] **连接层**：宿主的 MCP 列表显示 skillware 已连接（如 `claude mcp list` → `✔ Connected`）。
- [ ] **调用层**：新会话发一条显式任务（"用 <你的某个技能名> 技能 …"），观察到 `skill_search` → `skill_read` 调用且产出遵循技能指令。
- [ ] **激活形态判定**：发一条**隐式**专业任务（不点技能名），触发搜索 = 该宿主大概率吃 instructions（C1）；显式稳定但隐式从不触发 = 疑似 C0，考虑该宿主的文案安装位。

## 常见坑（实战踩过的）

- **改了索引器/技能库没生效**：server 每会话启动时扫描一次，重开会话即可；改了 `src/` 必须重新 `npm run build`。
- **技能描述显示 `">"`**：旧版不支持 YAML 块标量，已修；遇到类似异常先拉最新代码 + 重 build。
- **索引数量异常偏大**：确认备份/历史目录以 `.` 开头（自动排除），否则用 `SKILLWARE_EXCLUDE_DIRS` 点名排除。
- **两级配置重复**：Claude Code 同名 server 在 local 与 user 同时存在时 local 优先，容易造成"这个项目形态和别的项目不一样"的困惑。
