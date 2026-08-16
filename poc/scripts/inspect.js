// 用真实技能库（opc-skills）跑召回，验证收窄版可用性。
// server 经 ASKILL_LIBRARY 指向真实库；索引数从 server stderr 打印。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = process.env.LIB || "/Users/aiware/projects/opc-skills";
function textOf(r) {
    return JSON.parse(r.content[0].text);
}
// 隐式任务 → 期望命中的技能名（用于人工判断 Top-3 是否命中）
const cases = [
    { q: "$ppt", expect: "ppt" },
    { q: "/translator", expect: "translator" },
    { q: "帮我做一个产品发布会的演示文稿", expect: "ppt" },
    { q: "创建一个飞书云文档并写入内容", expect: "lark-doc" },
    { q: "把这段 AI 生成的文字改得更像真人写的", expect: "humanizer" },
    { q: "给我的网站做一次 SEO 审计", expect: "seo-audit" },
    { q: "把这段中文翻译成英文", expect: "translator" },
    { q: "识别这张发票上的信息", expect: "invoice-skill" },
    { q: "抓取某个雪球博主的历史文章", expect: "xueqiu-blogger-archive" },
    { q: "今天北京天气怎么样", expect: undefined }, // 简单问题：期望无/低召回
];
async function main() {
    const serverPath = path.resolve(__dirname, "../dist/server.js");
    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: { ...process.env, ASKILL_LIBRARY: LIB },
        stderr: "inherit", // 让 server 的 "indexed N skills" 显示
    });
    const client = new Client({ name: "inspect", version: "0.0.0" });
    await client.connect(transport);
    console.log(`\n库: ${LIB}\n`);
    let hit = 0;
    let total = 0;
    for (const c of cases) {
        const r = await client.callTool({
            name: "skill_search",
            arguments: { query: c.q, limit: 3 },
        });
        const parsed = textOf(r);
        const names = parsed.results.map((x) => x.name);
        let mark = "";
        if (c.expect) {
            total++;
            const rank = names.indexOf(c.expect);
            if (rank === 0) {
                hit++;
                mark = "✅ Top-1";
            }
            else if (rank > 0) {
                hit++;
                mark = `⚠️ Top-${rank + 1}`;
            }
            else
                mark = "❌ miss";
        }
        else {
            mark = names.length === 0 ? "✅ 无召回" : `⚠️ 召回 ${names.length}`;
        }
        console.log(`【${c.q}】 ${mark}`);
        for (const x of parsed.results) {
            console.log(`    ${x.name}  score=${x.score.toFixed(2)}  by=${x.matched_by.join(",")}`);
        }
        if (parsed.results.length === 0)
            console.log("    (no results)");
    }
    console.log(`\n有期望的用例命中率(Top-3): ${hit}/${total}`);
    await client.close();
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
