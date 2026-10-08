#!/usr/bin/env node
// scripts/check-frontend-no-qr.mjs
//
// 前端零 QR 编码逻辑守卫(T05 通用扫码弹窗,R24-AC)。
//
// 架构约束:二维码的生成只允许存在于后端(backend/src/utils/qrcode.ts 自研编码器
// + backend/src/plugins/qrAction.ts 归一化出 imageDataUrl)。前端扫码弹窗
// (frontend/src/components/QrLoginDialog.vue)只做 `<img :src="imageDataUrl">`
// 直显 + 轮询,不得出现任何 QR/编码逻辑——否则后端归一化(image/url/text 三态
// 降级)就会被绕过,插件生态退化为每个插件自带编码实现。
//
// 规则:frontend/src/**/*.{vue,ts,js}(locales 目录除外)的**非注释行**不得出现:
//   (1) 导入/require 任何 qrcode 库(import ... qrcode / require("qrcode") 等);
//   (2) 调用后端 qrToSvg;
//   (3) 自拼 data:image/svg+xml;base64 data URL;
//   (4) 使用 QRCode 对象(new QRCode / QRCode.);
//   (5) canvas.toDataURL( 绘码。
// 注释(整行 //、/* */、<!-- -->、块注释续行 *)不参与匹配——说明文字合法。
//
// 该脚本零依赖,直接用 `node` 运行,挂 ci.yml 守卫 job(与 check-* 系列同款)。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const SRC_DIR = join(repoRoot, "frontend", "src");
const SKIP_DIRS = new Set(["locales", "node_modules", ".git"]);
const EXTS = new Set([".vue", ".ts", ".js"]);

// 违禁模式(对「去注释后」的文本做匹配)。[正则, 说明]
const FORBIDDEN = [
  [/(import[\s\S]{0,200}?from\s*["'][^"']*qrcode|require\s*\(\s*["'][^"']*qrcode["']\s*\))/i, "导入/require QR 库"],
  [/\bqrToSvg\s*\(/, "前端调用 qrToSvg(编码只许在后端)"],
  [/data:image\/svg\+xml;base64/, "前端自拼 svg base64 data URL(应由后端下发)"],
  [/new\s+QRCode\b|QRCode\s*\.\s*\w+\s*\(/, "使用 QRCode 对象绘码"],
  [/\btoDataURL\s*\(/, "canvas.toDataURL(前端绘码)"],
];

let failures = 0;

/** 去注释:块注释(斜杠星号对)与 HTML 注释整体删除;行内斜杠斜杠注释删除(保护 "https://" 协议);块注释续行(星号开头)整行删除。 */
function stripComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, ""); // /* ... */
  out = out.replace(/<!--[\s\S]*?-->/g, ""); // <!-- ... -->
  const lines = out.split("\n").map((line) => {
    const t = line.trimStart();
    if (t.startsWith("*") || t.startsWith("//")) return ""; // 块注释续行 / 整行注释
    // 行内 //:跳过 "://"(URL 协议)
    const idx = line.indexOf("//");
    if (idx !== -1 && (idx === 0 || line[idx - 1] !== ":")) return line.slice(0, idx);
    return line;
  });
  return lines.join("\n");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else if (EXTS.has(extname(name))) {
      out.push(p);
    }
  }
  return out;
}

console.log("[前端零 QR 编码守卫] 扫描:", SRC_DIR);
const files = walk(SRC_DIR);
for (const file of files) {
  let src;
  try {
    src = stripComments(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  for (const [re, why] of FORBIDDEN) {
    if (re.test(src)) {
      failures++;
      console.error(`  \u2717 ${file.replace(SRC_DIR, "frontend/src")}: ${why}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n\u2717 前端零 QR 编码守卫失败:${failures} 处违规。`);
  console.error("  二维码生成只允许在后端(qrcode.ts + qrAction.ts);前端扫码弹窗只直显 imageDataUrl。");
  process.exit(1);
}
console.log(`  \u2713 ${files.length} 个前端源文件无非注释 QR 编码逻辑(导入库/qrToSvg/dataURL 自拼/canvas 绘码)。`);
