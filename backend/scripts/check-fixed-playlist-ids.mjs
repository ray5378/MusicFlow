#!/usr/bin/env node
// ==================== 固定推荐歌单 ID 守卫 ====================
//
// 契约:今日推荐 / 本地推荐 / 今日漫游 使用**固定歌单 id**(pl-daily-today /
// pl-daily-local / pl-daily-roam),客户端(音流 Flows / OpenSubsonic / HA)可长期
// 稳定引用。这些 id 只能存在于三个插件服务文件的常量定义中;核心代码、路由、
// 前端**一律不得写死** pl-daily-* 字面量(必须经 manifest.homePlaylistId 或
// fixedRecommend.ts 的 isFixedRecommendPlaylist / 常量引用)。
//
// 规则:
//   - 白名单文件(常量定义/测试)允许出现 pl-daily-* 字面量;
//   - 其余 frontend/src 与 backend/src 任何文件出现 pl-daily-today|local|roam
//     字面量 → 违规,exit 1(CI 失败)。
//
// 零依赖 node 脚本,挂 ci.yml frontend-plugin-isolation job。
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ID_PATTERN = /pl-daily-(today|local|roam)/;
// 白名单:三个固定 id 的常量定义文件 + 测试文件。
const WHITELIST = [
  "backend/src/services/plugin/dailyRecommend.ts",
  "backend/src/services/plugin/localRecommend.ts",
  "backend/src/services/plugin/dailyRoam.ts",
  "backend/tests/",
  "frontend/tests/",
];
const WHITELIST_RELS = WHITELIST.map((w) => w.replace(/\\/g, "/"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      walk(p, out);
    } else if (extname(p) === ".ts" || extname(p) === ".vue" || extname(p) === ".tsx") {
      out.push(p);
    }
  }
  return out;
}

function isWhitelisted(rel) {
  return WHITELIST_RELS.some((w) => rel === w || rel.startsWith(w.replace(/\/$/, "")) || rel.startsWith(w));
}

let violations = [];
for (const base of ["backend/src", "frontend/src"]) {
  const dir = join(root, base);
  if (!statSync(dir, { throwIfNoEntry: false })) continue;
  for (const file of walk(dir)) {
    const rel = file.replace(root + "\\", "").replace(root + "/", "").replace(/\\/g, "/");
    if (isWhitelisted(rel)) continue;
    const content = readFileSync(file, "utf8");
    // 剥离注释(块注释 + 行注释)后再匹配——只拦「代码里写死」,注释/文档说明不拦。
    const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    if (ID_PATTERN.test(code)) {
      violations.push(rel);
    }
  }
}

if (violations.length) {
  console.error("❌ 固定推荐歌单 ID 守卫失败 — 以下文件写死了 pl-daily-* 字面量:");
  for (const v of violations) console.error(`   - ${v}`);
  console.error("固定歌单 id 只能通过 manifest.homePlaylistId / fixedRecommend.ts 引用,不得写死(否则 ID 可被改动,音流引用断链)。");
  process.exit(1);
}
console.log("✓ 固定推荐歌单 ID 守卫:前后端无 pl-daily-* 字面量(仅常量定义与测试白名单)");
