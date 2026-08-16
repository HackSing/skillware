// 实验 C 冒烟测试：验证 MCP initialize 的 instructions 注入开关（C0/C1）。
// 做两次独立连接：不带 ASKILL_ACTIVATION → getInstructions() 应为 undefined；
// 带 ASKILL_ACTIVATION=1 → getInstructions() 应与 ACTIVATION_POLICY 严格相等（import 同一常量比较）。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 从已构建产物导入同一常量：server.js 也从 dist/activation.js 取值，比较的是同一份来源，非复制字符串。
// （验收命令用 tsc 单独编译本文件；若引 src/*.ts 会把 rootDir 抬到 poc/ 导致输出落点偏移，故引 dist 的 .js。）
import { ACTIVATION_POLICY } from "../dist/activation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../dist/server.js");

let failed = false;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

// env 需显式构造传入：StdioClientTransport 会把传入的 env 合并进子进程环境。
// 第一次显式给空 env（子进程只拿到 SDK 默认继承的安全变量，确保没有 ASKILL_ACTIVATION）；
// 第二次显式注入 ASKILL_ACTIVATION=1。两次都不依赖父进程环境继承。
async function getInstructionsWith(env: Record<string, string>): Promise<string | undefined> {
  const transport = new StdioClientTransport({ command: "node", args: [serverPath], env });
  const client = new Client({ name: "smoke-instructions", version: "0.0.0" });
  await client.connect(transport);
  const instructions = client.getInstructions();
  await client.close();
  return instructions;
}

async function main() {
  const off = await getInstructionsWith({});
  check("C0 (no ASKILL_ACTIVATION): getInstructions() === undefined", off === undefined);

  const on = await getInstructionsWith({ ASKILL_ACTIVATION: "1" });
  check("C1 (ASKILL_ACTIVATION=1): getInstructions() === ACTIVATION_POLICY", on === ACTIVATION_POLICY);

  if (failed) process.exit(1);
  console.log("smoke-instructions: done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
