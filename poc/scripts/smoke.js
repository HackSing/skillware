// 实验 A 协议级冒烟测试：用 MCP client 连自己的 server，验证 tools/list + 两个工具可调用，
// 并验证 skill_read 的路径逃逸 / 嵌套 Package 边界。真实宿主级验证（在 Claude Code 里注册 MCP）另做。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function textOf(r) {
    return JSON.parse(r.content[0].text);
}
async function main() {
    const serverPath = path.resolve(__dirname, "../dist/server.js");
    const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
    const client = new Client({ name: "smoke", version: "0.0.0" });
    await client.connect(transport);
    console.log("=== tools/list ===");
    const tools = await client.listTools();
    for (const t of tools.tools) {
        console.log(`- ${t.name}  annotations=${JSON.stringify(t.annotations)}`);
    }
    const queries = [
        "$react-review",
        "帮我审查这个 React 页面的性能问题",
        "帮我写一篇微信公众号文章",
        "把这段话翻译成英文", // 期望：无命中 / 不误召回
    ];
    for (const q of queries) {
        const r = await client.callTool({ name: "skill_search", arguments: { query: q } });
        const parsed = textOf(r);
        console.log(`\n=== skill_search: ${q} ===`);
        const lines = parsed.results
            .map((x) => `  ${x.name}  score=${x.score.toFixed(2)}  by=${x.matched_by.join(",")}`)
            .join("\n");
        console.log(lines || "  (no results)");
    }
    console.log("\n=== skill_read: entry + sub-resource ===");
    const entry = textOf(await client.callTool({
        name: "skill_read",
        arguments: { skill_id: "poc:react-review/SKILL.md", resource: "SKILL.md" },
    }));
    console.log(`  entry ok: ref=${entry.package_ref?.slice(0, 8)}… hash=${entry.content_hash?.slice(0, 16)}…`);
    const sub = textOf(await client.callTool({
        name: "skill_read",
        arguments: { package_ref: entry.package_ref, resource: "references/performance-checklist.md" },
    }));
    console.log(`  sub-resource ok: ${sub.resource} (${sub.content?.length} chars)`);
    console.log("\n=== security boundaries (expect errors) ===");
    const esc1 = textOf(await client.callTool({
        name: "skill_read",
        arguments: { package_ref: entry.package_ref, resource: "../wechat-writer/SKILL.md" },
    }));
    console.log(`  ../wechat-writer  => ${esc1.error ?? "!!! LEAKED !!!"}`);
    const esc2 = textOf(await client.callTool({
        name: "skill_read",
        arguments: { skill_id: "poc:pdf-tools/SKILL.md", resource: "nested/SKILL.md" },
    }));
    console.log(`  nested package    => ${esc2.error ?? "!!! LEAKED !!!"}`);
    const esc3 = textOf(await client.callTool({
        name: "skill_read",
        arguments: { skill_id: "poc:react-review/SKILL.md", resource: "/etc/passwd" },
    }));
    console.log(`  /etc/passwd       => ${esc3.error ?? "!!! LEAKED !!!"}`);
    await client.close();
    console.log("\nsmoke: done");
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
