#!/usr/bin/env node
// ==================== 「入库即入队」守卫（网络歌曲必须过一轮下载流程） ====================
//
// 契约（产品定调 2026-10-11，**最根本的一条**）：任何入库的网络歌曲（平台歌曲）——
// 不论来自插件歌单导入、单曲导入、每日推荐同步、跨源匹配还是发现页——都必须自动过
// 一轮下载流程（下载 → 落盘 → 把原 `web` 行迁移成指向本地文件的行；下载总开关关闭
// 时不下载）。
//
// 为什么必须静态钉死：这条链断了**不报任何错** —— 导入照常成功、库里照常有行、歌单
// 照常能看，只是「永远不会自动下载」，手测要等到用户抱怨「导入的歌怎么老是放不出来」
// 才浮现（本仓反复踩过的「静默退化」体质）。而它横跨 5 个文件 / 两套构建根：
//   导入层广播(backend) → 启动挂载(backend) → fetch 层实现(backend)
//   → 任务分栏白名单(frontend) → i18n(frontend)
// 任何一处被重构掉，功能都只剩「悄悄没了」，所以逐处钉死。
//
// 六条规则：
//   R1 导入层广播：`importOnlineSongs` 收集「本轮**新入库**」的行 id，并在返回前
//      `emitImportedSongs(addedSongIds, { providerId })`。这是唯一的平台歌曲落库收口点。
//   R2 启动挂载：`src/index.ts` 从 fetch/importTrigger 引入并调用
//      `registerFetchImportTrigger()`。注册制下**不挂 = 空实现 = 永远不下载**，
//      运行期完全看不出来，必须有静态钉子。
//   R3 实现侧闸门：importTrigger.ts 必须①读下载总开关 `cfg.enabled`（关闭即不下载）
//      ②按 songIds **点名**进计划 ③建 `kind: "import"` 任务 ④带 `noAutoContinue`
//      （否则会顺手开「全库自动续批」，把「下完这批」放大成「下完全库」）。
//   R4 任务分栏：前端 `DOWNLOAD_JOB_KINDS` 必须含 `"import"`，否则导入触发的任务
//      在两个列表里都看不见。
//   R5 i18n：`admin.fetch.jobs.kind.import` zh/en 都在（缺了会退化成裸 kind 串）。
//   R6 钩子契约未被绕过：service.ts 不得再出现「直接 import fetch 层」的静态依赖
//      （source 是底层，反向静态依赖会成环并让导入单测意外拉起真实下载）。
//
// 零依赖 node 脚本（与 check-renderer-host.mjs 同款），挂 ci.yml 的守卫 job。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const HOOK = "backend/src/services/source/online/importTriggerHook.ts";
const SERVICE = "backend/src/services/source/online/service.ts";
const TRIGGER = "backend/src/services/fetch/importTrigger.ts";
const BOOT = "backend/src/index.ts";
const VIEW = "frontend/src/views/admin/Fetch/index.vue";
const ZH = "frontend/src/locales/zh-CN.json";
const EN = "frontend/src/locales/en-US.json";

const errors = [];

function textOf(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    errors.push(`缺少文件：${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

/** 只取**有效代码行**（剔除注释、去首尾空白、丢空行）—— 注释里提到函数名不算接线。 */
function liveLines(text) {
  return stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 断言：某个文件的有效代码行里**至少有一行**匹配 re。 */
function mustMatch(rel, re, why) {
  const text = textOf(rel);
  if (!text) return;
  if (!liveLines(text).some((l) => re.test(l))) errors.push(`${rel}: ${why}`);
}

/** 断言：某个文件的有效代码行里**没有任何一行**匹配 re。 */
function mustNotMatch(rel, re, why) {
  const text = textOf(rel);
  if (!text) return;
  const hit = liveLines(text).find((l) => re.test(l));
  if (hit) errors.push(`${rel}: ${why} —— 命中: ${hit}`);
}

// ---------- R1 导入层广播 ----------
mustMatch(HOOK, /export function emitImportedSongs\s*\(/, "hook 必须导出 emitImportedSongs（导入层广播入口）");
mustMatch(SERVICE, /from "\.\/importTriggerHook\.js"/, "importOnlineSongs 所在模块必须引入 hook（广播入口）");
mustMatch(SERVICE, /emitImportedSongs\(addedSongIds, \{ providerId \}\)/, "必须在返回前广播「本轮新入库」的 songIds（唯一的平台歌曲落库收口点）");
mustMatch(SERVICE, /addedSongIds\.push\(plan\.songId\)/, "必须收集本轮**新入库**（非去重命中）的行 id");
mustMatch(SERVICE, /if \(plan\.deduped\) deduped\+\+/, "新增/去重必须分流（只有新增才入队下载）");

// ---------- R2 启动挂载 ----------
mustMatch(BOOT, /from "\.\/services\/fetch\/importTrigger\.js"/, "启动文件必须引入 fetch/importTrigger");
mustMatch(BOOT, /registerFetchImportTrigger\(\)/, "启动文件必须调用 registerFetchImportTrigger()（不挂 = 永远不下载）");

// ---------- R3 实现侧闸门 ----------
mustMatch(TRIGGER, /if \(!cfg\.enabled\)/, "必须尊重下载总开关 fetch.enabled（关闭时不下载）");
mustMatch(TRIGGER, /buildLibraryPlan\(cfg, \{ songIds: ids, limit: ids\.length \}\)/, "必须按 songIds 点名进计划（复用全库下载链路）");
mustMatch(TRIGGER, /buildLibraryTargets\(/, "必须复用全库下载的 target 构造（含 web 行迁移语义）");
mustMatch(TRIGGER, /buildLibraryJobConfig\(cfg, \{ noAutoContinue: true \}\)/, "必须带 noAutoContinue（防放大成全库自动续批）");
mustMatch(TRIGGER, /kind: "import"/, "导入触发的任务 kind 必须是 import（分栏与 i18n 依赖它）");
mustMatch(TRIGGER, /startFetchJob\(job\.id\)/, "创建任务后必须真正启动（否则行永远停在 pending）");

// ---------- R4 任务分栏 ----------
mustMatch(VIEW, /DOWNLOAD_JOB_KINDS = \[[^\]]*"import"/, "「下载任务列表」白名单必须含 import，否则新任务两个列表都看不见");

// ---------- R5 i18n ----------
for (const [rel, label] of [[ZH, "zh-CN"], [EN, "en-US"]]) {
  const raw = textOf(rel);
  if (!raw) continue;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push(`${rel}: JSON 解析失败 —— ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const kind = parsed?.admin?.fetch?.jobs?.kind;
  if (!kind || typeof kind.import !== "string" || !kind.import.trim()) {
    errors.push(`${rel}: 缺少 admin.fetch.jobs.kind.import（${label}）`);
  }
}

// ---------- R6 钩子契约未被绕过 ----------
mustNotMatch(
  SERVICE,
  /from "\.\.\/fetch\//,
  "source 层不得静态 import fetch 层（会成环并让导入单测意外拉起真实下载；必须走 hook 注册制）",
);

// ---------- 结果 ----------
if (errors.length > 0) {
  console.error("\n入库即入队守卫：发现接线缺失（这条链断了不会报错，只会悄悄不下载）:");
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("✓ 入库即入队链路完整（导入层广播 → 启动挂载 → fetch 层实现 → 分栏白名单 → i18n）");
