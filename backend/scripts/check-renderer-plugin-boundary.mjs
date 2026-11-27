// ==================== 渲染器插件化边界守卫(阶段 0 上线) ====================
//
// 规则定义见 docs/renderer-plugin-migration-plan.md §4.2b(B1–B7)。
// 阶段 0 口径:B1 / B2 / B3 只打印不失败(白名单模式);
//              B4 / B5 / B6 / B7 硬拦截(它们只防误改,不误伤存量)。
//
// 用法:cd backend && node scripts/check-renderer-plugin-boundary.mjs
// 本文件位于 backend/scripts,已被 check-workflow-paths.mjs 的 SCRIPT_DIRS 自动扫描,
// 无需手工登记(2026-11-27 核对)。

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "backend/src");
const BASELINE = process.env.MFB_BASELINE || "f8227576";

const PROTOCOL_DIRS = ["services/airplay", "services/sendspin", "services/dlna"];
const RENDERER_IMPLS = [
  "services/plugin/renderers/airplay.ts",
  "services/plugin/renderers/dlna.ts",
  "services/plugin/renderers/sendspin.ts",
];
const FACTORY_IDS = [
  "createAirPlayPlayerForDevice",
  "createSendspinProtocolPlayer",
  "createDlnaProtocolPlayer",
];

// §4.2a 存量 importer 白名单(相对 backend/src)。阶段 4 前逐条给出迁移/豁免结论。
const B1_WHITELIST = new Map([
  ["group/index.ts", "群组泵(永久豁免)"],
  ["group/protocolPlayer.ts", "群组泵(永久豁免)"],
  ["group/watchdog.ts", "群组泵(永久豁免)"],
  ["index.ts", "启动门控(永久豁免)"],
  ["services/dlna/announce.ts", "§1.4 互斥(永久豁免)"],
  ["services/access.ts", "设备基础设施(永久豁免)"],
  ["services/peer.ts", "设备基础设施(永久豁免)"],
  ["memory/pruneOrphans.ts", "设备基础设施(永久豁免)"],
  ["routes/api/airplay.ts", "待定:阶段 4 前给结论"],
  ["routes/api/peers.ts", "待定:阶段 4 前给结论"],
  ["routes/api/settings.ts", "待定:阶段 4 前给结论"],
  ["routes/api/shared.ts", "待定:阶段 4 前给结论"],
  ["routes/rest/index.ts", "待定:阶段 4 前给结论"],
  ["services/flows/index.ts", "待定:阶段 4 前给结论"],
  ["services/playTarget.ts", "待定:阶段 4 前给结论"],
  ["services/player/playerWebhook.ts", "待定:阶段 4 前给结论"],
]);

const hard = [];
const soft = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC);

// ---------------- B1:核心不得静态引用协议模块的非类型导出 ----------------
let b1 = 0;
for (const abs of files) {
  const rel = relative(SRC, abs).split("\\").join("/");
  if (rel.startsWith("services/plugin/renderers/")) continue; // 插件侧,本就该 import 实现
  if (PROTOCOL_DIRS.some((d) => rel.startsWith(d))) continue; // 协议实现内部互引,不属于核心越界
  const lines = readFileSync(abs, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["'](\.[^"']+)["']/);
    if (!m) continue;
    if (m[1]) continue; // import type 放行
    const spec = m[2].replace(/\.js$/, ".ts");
    const target = relative(SRC, resolve(dirname(abs), spec)).split("\\").join("/");
    if (!PROTOCOL_DIRS.some((d) => target.startsWith(d))) continue;
    if (B1_WHITELIST.has(rel)) continue;
    soft.push("[B1] " + rel + " -> " + target);
    b1++;
  }
}

// ---------------- B2:QueueController 禁止出现协议工厂标识符 ----------------
const qcPath = join(SRC, "services/player/QueueController.ts");
const qc = readFileSync(qcPath, "utf8");
let b2 = 0;
for (const id of FACTORY_IDS) {
  if (qc.includes(id)) { soft.push("[B2] QueueController 仍出现 " + id); b2++; }
}

// ---------------- B3:声明 renderer 的内置插件必须实现 createPlayer ----------------
let b3 = 0;
for (const rel of RENDERER_IMPLS) {
  const p = join(SRC, rel);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, "utf8");
  if (!/capabilities\s*:\s*\[\s*["']renderer["']/.test(s)) continue;
  if (!/createPlayer\s*\??\s*\(/.test(s)) { soft.push("[B3] " + rel + " 缺 createPlayer"); b3++; }
}

// ---------------- B4:元守卫自动扫描(脚本目录在 SCRIPT_DIRS 内) ----------------
const meta = join(ROOT, "backend/scripts/check-workflow-paths.mjs");
if (!existsSync(meta) || !readFileSync(meta, "utf8").includes('"backend/scripts"')) {
  hard.push("[B4] check-workflow-paths.mjs 缺失或不再扫描 backend/scripts");
}

// ---------------- B5:manifest 本期不新增字段 ----------------
for (const abs of files) {
  if (readFileSync(abs, "utf8").includes("allowDisable")) {
    hard.push("[B5] " + relative(SRC, abs) + " 出现新增 manifest 字段 allowDisable");
  }
}

// ---------------- B6:createPlayer 同步签名锁定 ----------------
const typesSrc = readFileSync(join(SRC, "plugins/types.ts"), "utf8");
const declLine = typesSrc.split("\n").find((l) => l.includes("createPlayer?(")) || "";
if (/async|Promise/.test(declLine)) hard.push("[B6] createPlayer 声明含 async/Promise:" + declLine.trim());
if (/await\s+createRendererPlayer\s*\(/.test(qc)) hard.push("[B6] QueueController 对 createRendererPlayer 使用了 await");

// ---------------- B7:启用逻辑冻结(相对阶段 0 基线) ----------------
try {
  const diff = execSync(
    "git diff -U0 " + BASELINE + " -- backend/src/routes/api/plugins.ts backend/src/plugins/builtins.ts backend/src/services/plugin/renderers",
    { cwd: ROOT, encoding: "utf8" },
  );
  const frozen = /(BUILTIN_RENDERER_IDS|isAirPlayEnabled|isSendspinEnabled|isDlnaEnabled|defaultEnabled\s*:)/;
  const bad = diff.split("\n").filter((l) => /^[+-][^+-]/.test(l) && frozen.test(l));
  if (bad.length) hard.push("[B7] 启用判定相对基线变化:" + bad.slice(0, 3).join(" | "));
} catch {
  // git 不可用(极少见)时跳过;CI 环境一定有 git
}

// ---------------- 汇总 ----------------
for (const s of soft) console.log("SOFT " + s);
console.log(
  "B1 白名单外越界=" + b1 + " | B2 工厂标识符=" + b2 + " | B3 缺 createPlayer=" + b3 +
  " | 硬拦截违规=" + hard.length,
);
for (const h of hard) console.error("HARD " + h);
if (hard.length > 0) process.exit(1);
console.log("renderer-plugin-boundary: PASS(阶段 0 白名单模式)");
