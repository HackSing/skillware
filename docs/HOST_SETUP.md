# 宿主接入指南：让任意 Agent 宿主用上 askill-search

> 一句话架构：**技能库一份、MCP server 一份、宿主配置每家一条。**
> 已验证宿主：Claude Code（2026-08-16）、Kimi Code（2026-08-16）。验收证据见 [../poc/EXPERIMENTS.md](../poc/EXPERIMENTS.md)。

## 0. 前提（所有宿主共用，每台机器一次）

- Node ≥18、git。
- 两个仓库在本机（示例路径按实际 clone 位置替换）：
  - 技能库：`/Users/aiware/projects/opc-skills`
  - 本仓库：`/Users/aiware/projects/askill-search`
- 构建一次 server：

```bash
cd /Users/aiware/projects/askill-search/poc && npm ci && npm run build
```

产物是 `poc/dist/server.js`——所有宿主的配置都指向这一个文件。改代码后重新 build，各宿主**新会话**自动生效（server 是每会话按需拉起的子进程）。

## 1. 环境变量（宿主配置里传给 server）

| 变量 | 必填 | 含义 |
|---|---|---|
| `ASKILL_LIBRARY` | 是 | 技能库根目录绝对路径 |
| `ASKILL_ACTIVATION` | 建议 `1` | `1` = 经 MCP `instructions` 注入激活规则文案（C1 形态）。不设则为纯工具形态（C0）——实验已证明 C0 激活率为零，日常使用应开 |
| `ASKILL_EXCLUDE_DIRS` | 否 | 逗号分隔的额外排除目录名（点目录与 `node_modules` 始终排除） |

## 2. 各宿主接法

### Claude Code

```bash
claude mcp add askill --scope user \
  --env ASKILL_LIBRARY=/Users/aiware/projects/opc-skills \
  --env ASKILL_ACTIVATION=1 \
  -- node /Users/aiware/projects/askill-search/poc/dist/server.js
```

- `--scope user` = 全部项目生效（产品目标形态）；只想单项目试验则去掉该参数并在目标项目目录里执行（local 级会覆盖同名 user 级，别两级同时挂）。
- 回滚：`claude mcp remove askill`。

### Kimi Code（VS 插件与 kimi CLI 共用）

编辑 `~/.kimi-code/mcp.json`（改前先备份），在 `mcpServers` 里加：

```json
"askill": {
  "transport": "stdio",
  "command": "node",
  "args": ["/Users/aiware/projects/askill-search/poc/dist/server.js"],
  "env": {
    "ASKILL_LIBRARY": "/Users/aiware/projects/opc-skills",
    "ASKILL_ACTIVATION": "1"
  }
}
```

- 注意 `transport` 字段是 Kimi 要求的；VS 插件需重启窗口生效。
- Kimi 自带 `~/.kimi-code/skills/` 全量注入机制——**刻意不用**（本项目的意义就是替代全量注入）。
- 回滚：删掉该条目。

### 其他宿主（通用判定三问）

1. **支持 stdio MCP 吗？** 支持则在其 MCP 配置处加等价条目（字段名可能小有出入）。不支持则该宿主暂不可接。
2. **吃 MCP `instructions` 吗？** 决定激活形态：吃 = C1（自动激活可用）；不吃 = 实际是 C0，激活率会归零，需要 Host Adapter 把激活文案写进该宿主自己的提示词安装位（如 AGENTS.md、系统提示配置）。
3. **会话轨迹存哪、什么格式？** 决定被动轨周报能否统计它（当前周报只解析 Claude Code 转录）。

## 3. 接入验收清单（每个新宿主/新机器都走一遍）

- [ ] **连接层**：宿主的 MCP 列表显示 askill 已连接（如 `claude mcp list` → `✔ Connected`）。
- [ ] **调用层**：新会话发一条显式任务（如"用 translator 技能把这句话翻成英文：……"），观察到 `skill_search` → `skill_read` 调用且译文按技能模式产出。
- [ ] **激活形态判定**：发一条**隐式**专业任务（不点技能名，如"把这段 README 翻成英文，术语与全文一致"），触发搜索 = 该宿主大概率吃 instructions（C1）；连显式都稳定但隐式从不触发 = 疑似 C0，记录到 EXPERIMENTS.md 并考虑该宿主的文案安装位。
- [ ] **记录**：宿主名、版本、验收日期、激活形态写入 [../poc/EXPERIMENTS.md](../poc/EXPERIMENTS.md)。

## 4. 常见坑（都是实战踩过的）

- **改了索引器 / 技能库没生效**：server 每会话启动时扫描一次；重开会话即可，无需重注册。但改了 `src/` 必须重新 `npm run build`。
- **技能描述显示 `">"`**：旧版不支持 YAML 块标量，已修（2026-08-16）；遇到类似显示异常先 `git pull` + 重 build。
- **索引数量异常偏大**：确认技能库里的备份/历史目录以 `.` 开头（自动排除），否则用 `ASKILL_EXCLUDE_DIRS` 点名排除。
- **两级配置重复**：Claude Code 同名 server 在 local 与 user 同时存在时 local 优先，容易造成"这个项目形态和别的项目不一样"的困惑。
