#!/usr/bin/env node
// i18n 合规守卫:确保界面文案全部走 translations,无遗漏。
//  1. zh-CN.json 与 en-US.json 的键集合必须完全一致(缺 key 即失败)。
//  2. 前端源码(.vue/.ts)里,除注释与 locales 目录外,不得出现硬编码中文(CJK)。
// 目的:CI 在 push/PR 时拦截"新增文案忘加翻译"或"改了一边漏改另一边"。
// 运行方法(node 22,零依赖): node backend/scripts/check-i18n.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const LOCALES_DIR = join(ROOT, "frontend", "src", "locales");
const SRC_DIR = join(ROOT, "frontend", "src");

const EXCLUDE_DIRS = new Set(["locales", "node_modules", ".git"]);
const SCAN_EXTS = [".vue", ".ts", ".js", ".tsx", ".jsx"];
// 非翻译文件里出现 CJK 即视为漏译(硬编码中文)。
const CJK = /[\u3400-\u9fff\u3040-\u30ff]/;

let failures = 0;

function fail(msg) {
  failures++;
  console.error(`[i18n] FAIL: ${msg}`);
}

// ---------- 1. 键对齐 ----------
function flattenKeys(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flattenKeys(v, key, out);
    else out.push(key);
  }
  return out;
}
function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
(function checkKeyParity() {
  const zh = readJson(join(LOCALES_DIR, "zh-CN.json"));
  const en = readJson(join(LOCALES_DIR, "en-US.json"));
  const zhKeys = flattenKeys(zh).sort();
  const enKeys = flattenKeys(en).sort();
  const zhSet = new Set(zhKeys);
  const enSet = new Set(enKeys);
  const missingEn = zhKeys.filter((k) => !enSet.has(k));
  const missingZh = enKeys.filter((k) => !zhSet.has(k));
  const extraEn = enKeys.filter((k) => !zhSet.has(k));
  if (missingEn.length) fail(`en-US 缺以下键: ${missingEn.join(", ")}`);
  if (missingZh.length) fail(`zh-CN 缺以下键: ${missingZh.join(", ")}`);
  if (extraEn.length) fail(`en-US 存在 zh-CN 没有的键(需同步补充): ${extraEn.join(", ")}`);
  if (zhKeys.join("|") !== enKeys.join("|")) {} // 上面已给出明细
  if (failures === 0) console.log(`[i18n] keys ok (${zhKeys.length} shared keys)`);
})();

// ---------- 2. 硬编码 CJK 扫描(剔除注释) ----------
// 去掉块注释 / HTML 注释 / 行注释(:// 里的 // 不算,避免误伤 http:// 等 URL)。
function stripComments(src, isVue) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (isVue) s = s.replace(/<!--[\s\S]*?-->/g, "");
  return s
    .split("\n")
    .map((line) => {
      let idx = line.indexOf("//");
      while (idx !== -1) {
        if (line[idx - 1] !== ":") return line.slice(0, idx);
        idx = line.indexOf("//", idx + 2);
      }
      return line;
    })
    .join("\n");
}
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (SCAN_EXTS.includes(extname(name))) out.push(full);
  }
  return out;
}
(function scanHardcoded() {
  const files = walk(SRC_DIR);
  let hits = 0;
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    const isVue = f.endsWith(".vue");
    const body = stripComments(raw, isVue);
    // 跳过字符串字面量外检测的古文/拼音干扰:逐行找含 CJK 的行。
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      if (CJK.test(line)) {
        const rel = f.replace(ROOT, "");
        const clean = line.trim().slice(0, 80);
        console.error(`[i18n] ${rel}:${i + 1}  含硬编码中文 → ${clean}`);
        hits++;
      }
    });
  }
  if (hits) {
    fail(`${hits} 处硬编码中文未走翻译(见上方行号)`);
  } else {
    console.log("[i18n] no hardcoded CJK outside comments");
  }
})();

if (failures > 0) {
  console.error(`\n[i18n] ${failures} 项不通过。`);
  process.exit(1);
}
process.exit(0);