#!/usr/bin/env node
// 版本守卫:**拒绝「main 版本」发布** —— 版本号必须是数字(semver)。
//
// 背景(用户定调 2026-09-24):
//   发布出去的版本号必须是数字(如 v4.0.17 / v3.4.9 / v2.4.9),**绝不允许把分支名
//   (main / master / latest / dev …)当成版本号发出来**。分支名当版本的危害:
//     ① 产物不可区分 —— 两次 main 构建同名,用户侧「检查更新」无法判断新旧;
//     ② 升级链错乱 —— 客户端/卡片按版本号比较决定是否升级,"main" 无法比较;
//     ③ 回溯断链 —— 线上跑的是哪次提交,光看版本号答不出来。
//   HACS 的 validate 动作只认 main 分支(它按默认分支取版本),与本仓库「拒绝 main
//   版本」直接冲突 ⇒ **永久禁用 HACS 校验**,改由本守卫 + 仓库自带校验覆盖。
//
// 三条规则:
//   R1 tag 守卫:tag 触发时,tag 名必须是 vX.Y.Z(可带 -rc.N / +build 后缀);
//      出现 main/master/latest/… 等分支名或非 semver 一律失败。
//   R2 版本声明:仓库内各版本字段(package.json / pubspec.yaml / CARD_VERSION …)
//      不得是分支名,且必须是数字开头。
//   R3 workflow 静态扫描:①不得出现 hacs/action(永久禁用);
//      ②不得把 `github.ref_name` 当版本号赋值(推 main 时它 = "main")。
//
// 用法:node <本脚本>   (需 node 18+;零依赖;退出码非 0 = 拒绝发布)
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = process.cwd();
// semver:v 前缀可选,三段数字必填,允许 -rc.1 / +build.5 之类后缀。
const SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
// 「分支名黑名单」:这些字符串无论带不带 v 前缀都不是版本号。
const BRANCH_NAMES = new Set([
  "main", "master", "latest", "stable", "dev", "develop", "release",
  "head", "trunk", "default", "nightly", "beta", "edge",
]);

const fails = [];
const notes = [];
const fail = (m) => fails.push(m);
const read = (p) => {
  try {
    return fs.readFileSync(path.join(ROOT, p), "utf8");
  } catch {
    return null;
  }
};

// ---------- R1 tag 守卫 ----------
const ref = process.env.GITHUB_REF || "";
if (ref.startsWith("refs/tags/")) {
  const tag = ref.slice("refs/tags/".length);
  const bare = tag.replace(/^v/i, "").toLowerCase();
  if (BRANCH_NAMES.has(bare)) {
    fail(`R1 tag 名 "${tag}" 是分支名 —— 拒绝发布。发版必须打数字 tag(vX.Y.Z)。`);
  } else if (!SEMVER.test(tag)) {
    fail(`R1 tag 名 "${tag}" 不是数字版本号 —— 拒绝发布。只认 vX.Y.Z(可带 -rc.N / +build 后缀)。`);
  } else {
    notes.push(`R1 tag "${tag}" 为合法数字版本号`);
  }
} else {
  notes.push(`R1 跳过:当前 ref 不是 tag(${ref || "本地运行"})`);
}

// ---------- R2 版本声明守卫 ----------
// 各仓库只命中自己存在的文件;pubspec 形如 `3.4.7+12`(build 段允许非数字语义)。
const VERSION_SOURCES = [
  { file: "package.json", re: /"version"\s*:\s*"([^"]+)"/ },
  { file: "backend/package.json", re: /"version"\s*:\s*"([^"]+)"/ },
  { file: "frontend/package.json", re: /"version"\s*:\s*"([^"]+)"/ },
  { file: "pubspec.yaml", re: /^version:\s*(\S+)/m },
  { file: "src/musicflow-remote-card.js", re: /CARD_VERSION\s*=\s*"([^"]+)"/ },
];
let checked = 0;
for (const src of VERSION_SOURCES) {
  const txt = read(src.file);
  if (txt == null) continue;
  const m = txt.match(src.re);
  if (!m) continue;
  checked++;
  const raw = String(m[1]);
  const core = raw.split("+")[0]; // pubspec 的 +build 段不参与判定
  if (BRANCH_NAMES.has(raw.toLowerCase()) || BRANCH_NAMES.has(core.toLowerCase())) {
    fail(`R2 ${src.file} 版本字段 = "${raw}"(分支名) —— 拒绝发布,必须是数字版本号。`);
  } else if (!/^\d+\.\d+\.\d+/.test(core)) {
    fail(`R2 ${src.file} 版本字段 = "${raw}" 不是数字版本号(应形如 X.Y.Z)。`);
  } else {
    notes.push(`R2 ${src.file} = ${raw}`);
  }
}
if (!checked) notes.push("R2 未找到任何版本声明文件(按仓库类型可忽略)");

// ---------- R3 workflow 静态扫描 ----------
const WF_DIR = path.join(ROOT, ".github", "workflows");
if (fs.existsSync(WF_DIR)) {
  const files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/i.test(f));
  for (const f of files) {
    const rel = `.github/workflows/${f}`;
    const raw = read(rel);
    if (raw == null) continue;
    // 先剥掉 YAML 注释再判(注释里写「已移除 hacs/action」不该被判红)。
    const lines = raw.split("\n").map((l) => l.replace(/(^|\s)#.*$/, ""));
    const txt = lines.join("\n");
    // ① HACS 校验永久禁用:它只认 main 分支版本,与「拒绝 main 版本」冲突。
    if (/hacs\/action/i.test(txt)) {
      fail(`R3 ${rel} 使用了 hacs/action —— HACS 校验只认 main 分支版本,与本仓「拒绝 main 版本发布」冲突,永久禁用。`);
    }
    // ② 禁止把 ref_name 当版本号赋值:推 main 时它等于 "main"。
    lines.forEach((line, idx) => {
      if (/(version|VERSION|versionName|tag_name|artifact_tag)\s*[:=][^\n]*github\.ref_name/.test(line)) {
        fail(`R3 ${rel}:${idx + 1} 把 github.ref_name 当版本号("${line.trim()}") —— 推 main 时即解析成 "main" 版本,必须改为从 refs/tags/v* 解析。`);
      }
    });
  }
  notes.push(`R3 已扫描 ${files.length} 个 workflow`);
} else {
  notes.push("R3 跳过:无 .github/workflows");
}

// ---------- 结论 ----------
for (const n of notes) console.log(`· ${n}`);
if (fails.length) {
  console.error(`\n❌ 版本守卫失败:${fails.length} 条(禁止发布非数字版本)`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✅ 版本守卫通过:版本号均为数字,无 main/分支名版本,无 HACS 校验。");
