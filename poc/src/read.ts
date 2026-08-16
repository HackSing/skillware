import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SkillRecord } from "./index.js";
import { LIBRARY_ROOT, MAX_RESOURCE_BYTES } from "./config.js";

// package_ref -> skill_id（内存映射，绑定当前进程）
const refs = new Map<string, string>();

function sha256(buf: Buffer): string {
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

function findSkill(index: SkillRecord[], skillId: string): SkillRecord {
  const s = index.find((x) => x.skill_id === skillId);
  if (!s) throw new Error(`skill_not_found: ${skillId}`);
  return s;
}

function escapes(fromDir: string, target: string): boolean {
  const rel = path.relative(fromDir, target);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

// 解析 Package 内相对资源，逐层拒绝逃逸：绝对路径 / .. / 逃库 / 符号链接逃逸 / 进入嵌套 Package。
function resolveWithinPackage(
  skill: SkillRecord,
  resource: string,
  index: SkillRecord[]
): string {
  if (path.isAbsolute(resource)) {
    throw new Error("resource_outside_package: absolute path not allowed");
  }
  const packageDirAbs = path.resolve(LIBRARY_ROOT, skill.package_dir);
  const target = path.resolve(packageDirAbs, resource);

  if (escapes(packageDirAbs, target)) {
    throw new Error(`resource_outside_package: ${resource}`);
  }
  if (escapes(LIBRARY_ROOT, target)) {
    throw new Error(`path_outside_library: ${resource}`);
  }

  // 符号链接：realpath 后重新校验仍在 Package 内
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw new Error(`resource_not_found: ${resource}`);
  }
  if (escapes(packageDirAbs, real)) {
    throw new Error("resource_outside_package: symlink escape");
  }

  // 嵌套 Package：target 落入另一个更深的已索引 Package
  for (const other of index) {
    if (other.skill_id === skill.skill_id) continue;
    const otherPkgAbs = path.resolve(LIBRARY_ROOT, other.package_dir);
    const deeper = otherPkgAbs.startsWith(packageDirAbs + path.sep);
    if (deeper && !escapes(otherPkgAbs, target)) {
      throw new Error(`resource_outside_package: enters nested package ${other.skill_id}`);
    }
  }

  return target;
}

function readOne(skill: SkillRecord, target: string, resourceRel: string) {
  const stat = fs.statSync(target);
  if (stat.size > MAX_RESOURCE_BYTES) {
    throw new Error(`resource_too_large: ${resourceRel}`);
  }
  const buf = fs.readFileSync(target);
  return {
    resource: resourceRel,
    content: buf.toString("utf8"),
    content_hash: sha256(buf),
    source: {
      library_id: skill.library_id,
      relative_path: path.join(skill.package_dir, resourceRel),
    },
  };
}

// 首次读取：入口 SKILL.md（或指定资源），返回短期 package_ref。
export function readEntry(
  skillId: string,
  resource: string | undefined,
  index: SkillRecord[]
) {
  const skill = findSkill(index, skillId);
  const res = resource ?? "SKILL.md";
  const target = resolveWithinPackage(skill, res, index);
  const base = readOne(skill, target, res);
  const ref = crypto.randomUUID();
  refs.set(ref, skill.skill_id);
  return {
    skill_id: skill.skill_id,
    name: skill.name,
    package_ref: ref,
    ...base,
    capabilities: { text_resource_read: true, host_package_access: false },
  };
}

// 后续读取：凭 package_ref 读同一 Package 内的单个资源。
export function readByPackageRef(
  ref: string,
  resource: string | undefined,
  index: SkillRecord[]
) {
  const skillId = refs.get(ref);
  if (!skillId) throw new Error("package_ref_expired");
  const skill = findSkill(index, skillId);
  if (!resource) throw new Error("resource is required when using package_ref");
  const target = resolveWithinPackage(skill, resource, index);
  const base = readOne(skill, target, resource);
  return { skill_id: skill.skill_id, name: skill.name, package_ref: ref, ...base };
}
