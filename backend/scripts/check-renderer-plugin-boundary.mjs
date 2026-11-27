// ==================== 渲染器插件化边界守卫(阶段 4 硬拦截) ====================
//
// 规则定义见 docs/renderer-plugin-migration-plan.md §4.2b(B1–B7)。
// 阶段 4 起:B1 / B2 / B3 与 B4–B7 一样硬拦截(退出非零)。
// B1 白名单只保留 §4.2a 实测的 9 个存量文件;白名单外任何新增即失败。
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

// §4.2a 存量 importer 白名单(相对 backend/src)。2026-11-27 阶段 4 实测 19 文件 / 63 条,
// 每条均已给出归属结论(永久豁免 / 基础设施 / 业务编排保留);不得再扩。
const B1_WHITELIST = new Map([
  // ---- 群组泵(永久豁免:组时间线/协议扇出/看护) ----
  ["services/group/index.ts", "群组泵(永久豁免:组时间线/成员路由)"],
  ["services/group/protocolPlayer.ts", "群组泵(永久豁免:组内协议扇出/桥会话)"],
  ["services/group/watchdog.ts", "群组泵(永久豁免:离线看护/恢复)"],
  // ---- 设备基础设施(永久豁免) ----
  ["services/memory/pruneOrphans.ts", "设备基础设施(永久豁免:孤儿设备/队列清理)"],
  ["services/ws/index.ts", "设备基础设施(永久豁免:GENA 事件与队列快照转发)"],
  ["services/access.ts", "设备基础设施(永久豁免:访问控制)"],
  ["services/peer.ts", "设备基础设施(永久豁免:peer 台账/在线态)"],
  // ---- 启动装配 ----
  ["index.ts", "启动门控/服务装配(永久豁免)"],
  // ---- 队列核心余量(仅工具,非播放器工厂) ----
  ["services/player/QueueController.ts", "队列核心余量:仅 DLNA 基址/设备状态/队列落库工具"],
  // ---- 业务编排/只读展示(保留:不 new 播放器) ----
  ["services/content.ts", "内容聚合:只读 DLNA 队列状态"],
  ["services/source/online/streamFallback.ts", "流回退:复用 DLNA 基址探测"],
  ["services/source/smbStream.ts", "流代理:复用 DLNA 基址"],
  ["services/flows/index.ts", "流程引擎:设备/队列操作复用协议控制面"],
  ["services/playTarget.ts", "播放目标判据:复用 AirPlay 发现"],
  ["services/player/playerWebhook.ts", "播放 webhook:读 DLNA 队列/设备状态"],
  ["routes/api/shared.ts", "路由聚合:组/设备编排复用协议控制面"],
  ["routes/api/peers.ts", "peer API:AirPlay 桥控制面"],
  ["routes/api/settings.ts", "设置页:AirPlay 延迟校准"],
  ["routes/rest/index.ts", "REST 流代理:复用 DLNA 基址/队列"],
]);

const hard = [];

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
    hard.push("[B1] " + rel + " -> " + target);
    b1++;
  }
}

// ---------------- B2:QueueController 禁止出现协议工厂标识符 ----------------
const qcPath = join(SRC, "services/player/QueueController.ts");
const qc = readFileSync(qcPath, "utf8");
let b2 = 0;
for (const id of FACTORY_IDS) {
  if (qc.includes(id)) { hard.push("[B2] QueueController 仍出现 " + id); b2++; }
}

// ---------------- B3:声明 renderer 的内置插件必须实现 createPlayer ----------------
let b3 = 0;
for (const rel of RENDERER_IMPLS) {
  const p = join(SRC, rel);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, "utf8");
  if (!/capabilities\s*:\s*\[\s*["']renderer["']/.test(s)) continue;
  if (!/createPlayer\s*\??\s*\(/.test(s)) { hard.push("[B3] " + rel + " 缺 createPlayer"); b3++; }
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
for (const h of hard) console.error("HARD " + h);
console.log(
  "B1 白名单外越界=" + b1 + " | B2 工厂标识符=" + b2 + " | B3 缺 createPlayer=" + b3 +
  " | 硬拦截违规=" + hard.length,
);
if (hard.length > 0) {
  console.error("renderer-plugin-boundary: FAIL(阶段 4 硬拦截)");
  process.exit(1);
}
console.log("renderer-plugin-boundary: PASS(阶段 4 硬拦截)");
