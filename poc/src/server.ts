#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildIndex } from "./index.js";
import { searchSkills } from "./search.js";
import { readEntry, readByPackageRef } from "./read.js";
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  ACTIVATION_ENABLED,
} from "./config.js";
import { ACTIVATION_POLICY } from "./activation.js";

const index = buildIndex();

const server = new Server(
  { name: "skillware-poc", version: "0.0.0" },
  {
    capabilities: { tools: {} },
    // 实验 C：C1 开关开时把激活规则挂到 initialize 的 instructions 字段；关时不传该字段（行为同现状）。
    ...(ACTIVATION_ENABLED ? { instructions: ACTIVATION_POLICY } : {}),
  }
);

// 两个只读工具。annotations 向支持的宿主声明只读、非破坏、非开放网络。
const SKILL_SEARCH_TOOL = {
  name: "skill_search",
  description:
    "Search the local Skill Library for skills relevant to the current task. " +
    "Returns up to 5 short candidate summaries (no skill body). " +
    "Call before specialized work, or when the user explicitly names a skill ($name / /name).",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The current task, or an explicit $name / /name.",
      },
      limit: { type: "number", description: "Max candidates (1-10), default 5." },
    },
    required: ["query"],
  },
  annotations: {
    title: "Search Skills",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
};

const SKILL_READ_TOOL = {
  name: "skill_read",
  description:
    "Read a selected skill. First call with skill_id to read its SKILL.md entry and get a package_ref; " +
    "then call with package_ref + a resource path (relative to the Skill Package root) to read one " +
    "referenced text resource at a time. Read-only; never executes anything.",
  inputSchema: {
    type: "object",
    properties: {
      skill_id: {
        type: "string",
        description: "Skill ID from skill_search (first read only).",
      },
      package_ref: {
        type: "string",
        description: "Short-lived ref from the first read (subsequent resource reads).",
      },
      resource: {
        type: "string",
        description: "Path relative to the Skill Package root. Defaults to SKILL.md on first read.",
      },
    },
  },
  annotations: {
    title: "Read Skill",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  // 阶段 0：低层 API 精确控制 annotations；用 as any 规避字面量类型摩擦。
  tools: [SKILL_SEARCH_TOOL, SKILL_READ_TOOL] as any,
}));

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params as {
    name: string;
    arguments?: Record<string, unknown>;
  };
  try {
    if (name === "skill_search") {
      const query = String(args?.query ?? "");
      if (!query.trim()) throw new Error("query is required");
      let limit = Number(args?.limit ?? SEARCH_DEFAULT_LIMIT);
      if (!Number.isFinite(limit)) limit = SEARCH_DEFAULT_LIMIT;
      limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
      const results = searchSkills(index, query, limit);
      return json({ results, index_version: 1, total_candidates: results.length });
    }
    if (name === "skill_read") {
      const resource = args?.resource ? String(args.resource) : undefined;
      if (args?.package_ref) {
        return json(readByPackageRef(String(args.package_ref), resource, index));
      }
      if (args?.skill_id) {
        return json(readEntry(String(args.skill_id), resource, index));
      }
      throw new Error(
        "skill_read requires skill_id (first read) or package_ref (subsequent reads)"
      );
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: (err as Error).message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[skillware-poc] MCP server ready; indexed", index.length, "skills");
