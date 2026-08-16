import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 阶段 0 唯一配置点：写死的技能库根目录。
// 默认指向 poc/fixtures；可用 ASKILL_LIBRARY 环境变量覆盖（用于实验 C/D 换真实技能库）。
export const LIBRARY_ROOT = process.env.ASKILL_LIBRARY
  ? path.resolve(process.env.ASKILL_LIBRARY)
  : path.resolve(__dirname, "../fixtures");

export const LIBRARY_ID = "poc";

// 实验 C 的 C0/C1 开关：为 1 时在 MCP initialize 结果里注入激活规则（instructions 字段），否则行为同现状。
export const ACTIVATION_ENABLED = process.env.ASKILL_ACTIVATION === "1";

export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;

// skill_read 单资源大小上限：超限明确失败，不静默截断关键规则。
export const MAX_RESOURCE_BYTES = 256 * 1024;

// 额外排除的目录名（除点目录/node_modules 外）。真实库常混入 docs/outputs 等非技能目录。
// 逗号分隔，经 ASKILL_EXCLUDE_DIRS 传入。core 不硬编码任何具体库的目录名。
export const EXCLUDE_DIRS = new Set(
  (process.env.ASKILL_EXCLUDE_DIRS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
