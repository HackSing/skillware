import type { SkillRecord } from "./index.js";

export interface SearchResult {
  skill_id: string;
  name: string;
  short_description: string;
  library: string;
  score: number;
  matched_by: string[];
  content_hash: string;
}

// 提取显式指定：$name 或 /name
function extractExplicit(query: string): string | null {
  const m = query.match(/[$/]([\w-]+)/);
  return m ? m[1].toLowerCase() : null;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

// 中文没有空格分词，用连续汉字的 2-gram 做召回锚点（"演示文稿" → 演示/示文/文稿）。
function cjkBigrams(s: string): Set<string> {
  const out = new Set<string>();
  const segs = s.match(/[一-鿿]{2,}/g) || [];
  for (const seg of segs) {
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

// 阶段 0 确定性规则匹配：显式名 > 完整名 > 关键词/触发词 > 中文 bigram > 描述/路径。
export function searchSkills(
  index: SkillRecord[],
  query: string,
  limit: number
): SearchResult[] {
  const q = query.toLowerCase();
  const explicit = extractExplicit(query);
  const qTokens = new Set(tokenize(query));
  const qBigrams = cjkBigrams(query);

  const scored = index
    .map((s) => {
      const name = s.name.toLowerCase();
      let score = 0;
      const matched: string[] = [];

      if (explicit) {
        if (explicit === name) {
          score += 100;
          matched.push("explicit");
        } else if (name.startsWith(explicit) || explicit.startsWith(name)) {
          score += 50;
          matched.push("explicit_prefix");
        }
      }
      // 完整技能名出现在查询里（子串，兼容中文无分词）
      if (name.length > 1 && q.includes(name)) {
        score += 40;
        if (!matched.includes("name")) matched.push("name");
      }
      // 关键词/触发词命中（双向子串：短词出现在查询里，或查询词出现在触发词里）
      let kwHit = 0;
      for (const kw of s.keywords) {
        const k = kw.toLowerCase();
        if (!k) continue;
        if (q.includes(k) || (k.length > 3 && k.includes(q))) kwHit++;
      }
      if (kwHit) {
        score += Math.min(40, kwHit * 15);
        matched.push("keyword");
      }
      // 中文 bigram 交集（覆盖 name + description + keywords/triggers）
      const hay = cjkBigrams(
        `${s.name} ${s.short_description} ${s.keywords.join(" ")}`
      );
      let bg = 0;
      for (const b of qBigrams) if (hay.has(b)) bg++;
      if (bg) {
        score += Math.min(45, bg * 7);
        matched.push("cjk");
      }
      // 描述 token 交集（英文）
      const descTokens = new Set(tokenize(s.short_description));
      let overlap = 0;
      for (const t of qTokens) if (descTokens.has(t)) overlap++;
      if (overlap) {
        score += Math.min(25, overlap * 8);
        matched.push("description");
      }
      // 路径片段
      const pathToks = tokenize(s.relative_path);
      for (const t of qTokens) {
        if (pathToks.includes(t)) {
          score += 3;
          if (!matched.includes("path")) matched.push("path");
          break;
        }
      }

      return { s, score, matched };
    })
    .filter((x) => x.score > 0);

  // 稳定排序：分数 desc → 名称 → skill_id
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.s.name.localeCompare(b.s.name) ||
      a.s.skill_id.localeCompare(b.s.skill_id)
  );

  return scored.slice(0, limit).map((x) => ({
    skill_id: x.s.skill_id,
    name: x.s.name,
    short_description: x.s.short_description,
    library: x.s.library_id,
    score: Math.min(1, x.score / 100),
    matched_by: x.matched,
    content_hash: x.s.content_hash,
  }));
}
