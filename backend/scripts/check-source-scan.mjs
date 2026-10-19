#!/usr/bin/env node
// ==================== 媒体源扫描「实时进度 + 每日定时增量」链路守卫 ====================
//
// 本脚本锁的是 2026-10-19「媒体源扫描进度实时可见」+「每源每日定时增量扫描」这一组
// 契约的**静默失效**。它们的共同特点是:坏掉不报错、不会让任何既有动态用例变红,
// 只是让前端「什么都看不到」或让定时扫描悄悄不触发:
//   S1 进度收口:扫描进度只存在于批量子进程 IPC 回调的瞬时载荷里,必须落进一份**可查询的
//      进程内状态**(scanRunner 的 scanJobs)。若手动/定时任一路径不落这份状态,前端轮询
//      聚合接口时拿不到任何进度 —— 表现为「只有完成后才有最终态」。
//   S2 定时共用:定时扫描此前直接调 runBatchJob 且不传 onProgress,既不写 scanJobs 也无进度。
//      必须改走 scanRunner.startSourceScan(trigger=auto),与手动路径共用同一份状态。
//   S3 并发让渡:定时侧遇「该源已在跑」必须**跳过且不落 lastRunAt 标记**,下一 tick 再判
//      —— 若误落了标记,该源当天定时会被一次手动扫描顶掉,静默漏跑。
//   S4 聚合接口:前端不再依赖「谁发起谁轮询」,改常驻轮询 GET /v1/sources/scan-status
//      一次拿全部源状态。这条接口若被拆回单源查询,定时/他人触发的扫描前端又不可见。
//   S5 定时配置消毒:POST /v1/sources 必须与 PUT 同口径 sanitizeScanAuto(否则前端开关
//      回传的非布尔值会原样落库,调度器读到脏值静默不触发)。
//
// 零依赖 node 脚本(strip-comments 与 check-home-perf.mjs 同款),挂 ci.yml 的 source-scan-guard 作业。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RUNNER = "backend/src/services/source/scanRunner.ts";
const SCHED = "backend/src/services/source/scanScheduler.ts";
const SOURCES = "backend/src/routes/api/sources.ts";
const SHARED = "backend/src/routes/api/shared.ts";
const VIEW = "frontend/src/views/admin/Sources/index.vue";

const errors = [];
let checks = 0;

function textOf(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    errors.push(`缺少文件：${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

/** 只取**有效代码行**（剔除注释、去首尾空白、丢空行）—— 注释里提到符号不算接线。 */
function liveLines(text) {
  return stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 断言：某个文件的有效代码行里**至少有一行**匹配 re。 */
function mustMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  if (!liveLines(text).some((l) => re.test(l))) errors.push(`${rel}: ${why}`);
}

/** 断言：某个文件的有效代码行里**没有任何一行**匹配 re。 */
function mustNotMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const hit = liveLines(text).find((l) => re.test(l));
  if (hit) errors.push(`${rel}: ${why} —— 命中: ${hit.slice(0, 120)}`);
}

/** 断言：某个文件的有效代码行里 re 的匹配次数**恰好**为 n（防重复定义/防退化）。 */
function mustCount(rel, re, n, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const c = (stripComments(text).match(g) || []).length;
  if (c !== n) errors.push(`${rel}: ${why} —— 期望 ${n} 处，实际 ${c} 处`);
}

/** 模板文件（.vue）用**原样文本**计数：模板里没有 TS 注释语义，绕过剥注释更稳。 */
function mustCountRaw(rel, re, n, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const c = (text.match(g) || []).length;
  if (c < n) errors.push(`${rel}: ${why} —— 期望至少 ${n} 处，实际 ${c} 处`);
}

/** 断言：有效代码行里 reA 的首次出现必须**早于** reB（「先判定后落标记」这类顺序契约）。 */
function mustOrderBefore(rel, reA, reB, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const lines = liveLines(text);
  const ia = lines.findIndex((l) => reA.test(l));
  const ib = lines.findIndex((l) => reB.test(l));
  if (ia === -1 || ib === -1) {
    errors.push(`${rel}: ${why} —— 前置/后置之一缺失(A=${ia}, B=${ib})`);
    return;
  }
  if (ia >= ib) errors.push(`${rel}: ${why} —— A(第${ia + 1}有效行)未早于 B(第${ib + 1}有效行)`);
}

// ---------- S1 扫描状态收口（scanRunner） ----------
mustMatch(RUNNER, /export const scanJobs = new Map</, "必须导出可查询的进程内扫描状态 scanJobs（进度无处落 = 前端拿不到实时进度）");
mustMatch(RUNNER, /export function startSourceScan\(/, "必须导出 startSourceScan（手动/定时共用的唯一扫描入口）");
mustMatch(RUNNER, /export function isSourceScanRunning\(/, "必须导出 isSourceScanRunning（并发闸与定时让渡共用）");
mustMatch(RUNNER, /export function listScanJobs\(/, "必须导出 listScanJobs（聚合接口一次外发全部源状态，需摘掉 controller）");
mustCount(RUNNER, /const finalize =/, 1, "收尾逻辑必须只定义一处，避免各路触发方式收尾语义漂移");
mustMatch(
  RUNNER,
  /job\.progress = \{ \.\.\.p \};/,
  "非 scrape-* 的扫描载荷必须落进 job.progress（否则进度永不外发）",
);
mustMatch(
  RUNNER,
  /p\.stage\.startsWith\("scrape"\)/,
  "scrape-* 载荷必须旁路回调用方（不得污染 job.progress，保持既有 scrapeJobs 语义）",
);
mustMatch(
  RUNNER,
  /SCAN_JOB_TTL_MS = 30 \* 60 \* 1000/,
  "完成态扫描任务必须保留 30min（前端轮询取结果），缺 TTL 会让 Map 无界",
);
mustMatch(
  RUNNER,
  /\(scanJobsSweep as any\)\.unref\?\.\(\)/,
  "清扫定时器必须 unref（否则无谓地阻止进程退出）",
);
mustMatch(
  RUNNER,
  /await runBatchJob\(/,
  "scanRunner 是扫描批量任务的唯一发起处（手动/定时路径都不得再直调 runBatchJob）",
);
// batch 作业的 scanHandler 返回 { result, aborted, scrape }，其外再套 runner 的
// { result, childRss, aborted } —— 真正的扫描计数在 **result.result**。少解一层，
// completed/stopped 里存的就是外层包装，前端 r.added/r.failed 恒为 0、失败告警永不弹。
mustCount(
  RUNNER,
  /result\?\.result/,
  2,
  "扫描结果必须解一层 batch 外层载荷（result?.result），否则前端计数恒为 0、失败告警不弹",
);
mustNotMatch(RUNNER, /\{ result \}/, "禁止直接落 batch 外层载荷（result）—— 必须用 result?.result 取出真实计数");

// ---------- S2/S3 定时扫描共用同一入口 + 并发让渡 ----------
mustMatch(
  SCHED,
  /import \{ isSourceScanRunning, startSourceScan \} from "\.\/scanRunner\.js";/,
  "定时调度必须从 scanRunner 取共享入口（不得退回直调 runBatchJob）",
);
mustMatch(SCHED, /startSourceScan\(\{/, "定时扫描必须走 startSourceScan（与手动共用状态与进度）");
mustMatch(SCHED, /trigger: "auto"/, "定时扫描必须标记来源 trigger=auto（前端据此显示「定时」标签）");
mustMatch(SCHED, /mode: "incremental"/, "定时扫描必须固定增量（产品定调：全量不做定时）");
mustMatch(
  SCHED,
  /if \(isSourceScanRunning\(s\.id\)\) continue;/,
  "该源已在跑时必须让渡且**不落 lastRunAt 标记**（下一 tick 再判），否则当天定时被手动扫描顶掉而静默漏跑",
);
mustOrderBefore(
  SCHED,
  /isSourceScanRunning\(s\.id\)/,
  /setSetting\(key/,
  "并发让渡判定必须排在 setSetting(落 lastRunAt) 之前 —— 顺序颠倒会在让渡时也落标记，顶掉当天定时而漏跑",
);
mustMatch(
  SCHED,
  /setSetting\(key, String\(nowMs\)\)/,
  "触发后必须落每源 lastRunAt（scan.auto.lastRunAt.<id>）；缺了会每个 tick 重复触发同一源",
);
mustNotMatch(SCHED, /runBatchJob\(/, "定时调度不得再直调 runBatchJob（绕过 scanRunner 即丢失进度与状态）");

// ---------- S4 聚合状态接口 ----------
mustMatch(
  SOURCES,
  /app\.get\("\/v1\/sources\/scan-status"/,
  "必须注册聚合接口 GET /v1/sources/scan-status（前端常驻轮询一次拿全部源状态）",
);
mustMatch(
  SOURCES,
  /import \{ isSourceScanRunning, listScanJobs, scanJobs, startSourceScan \} from "\.\.\/\.\.\/services\/source\/scanRunner\.js";/,
  "sources 路由必须从 scanRunner 取扫描入口与状态（不得自建一份）",
);
mustMatch(SOURCES, /listScanJobs\(\)/, "聚合接口必须返回 listScanJobs()");
mustCount(SOURCES, /app\.get\("\/v1\/sources\/scan-status"/, 1, "聚合路由只允许挂一处，重复挂靠后才注册的会静默失效");

// ---------- S5 定时配置消毒 + 手动入口接线 ----------
mustMatch(
  SOURCES,
  /sanitizeScanAuto\(body\.config \|\| \{\}\)/,
  "POST /v1/sources 必须与 PUT 同口径消毒定时两键（否则脏值落库，调度器静默不触发）",
);
mustMatch(SOURCES, /if \(isSourceScanRunning\(id\)\)/, "POST /scan 的并发闸必须走 isSourceScanRunning");
mustMatch(SOURCES, /trigger: "manual"/, "手动扫描必须标记来源 trigger=manual");
mustNotMatch(SOURCES, /runBatchJob\(/, "sources 路由不得再直调 runBatchJob（扫描实体已收口到 scanRunner）");
mustMatch(
  SHARED,
  /export \{ scanJobs, SCAN_JOB_TTL_MS, scanJobsSweep \} from "\.\.\/\.\.\/services\/source\/scanRunner\.js";/,
  "shared.ts 必须转出 scanJobs/TTL/sweep（保持既有引用面不变）",
);

// ---------- S1/S4 前端：常驻轮询聚合接口 + 实时进度 + 定时配置 UI ----------
mustMatch(
  VIEW,
  /api\.get\("\/rest\/api\/v1\/sources\/scan-status"\)/,
  "媒体源页必须常驻轮询聚合接口 /rest/api/v1/sources/scan-status（不再依赖「谁发起谁轮询」）",
);
mustMatch(
  VIEW,
  /setInterval\(pollScanStatus, 3000\)/,
  "聚合轮询必须常驻（onMounted 起 3s 定时器），否则定时/他人触发的扫描仍不可见",
);
mustMatch(VIEW, /clearInterval\(pollTimer\)/, "卸载时必须清掉常驻轮询定时器");
mustMatch(
  VIEW,
  /_scanProgress: old\?\._scanProgress/,
  "loadSources 重载必须保留进行中的运行态（否则轮询刷新会把已显示的进度抹掉、闪烁）",
);
mustNotMatch(VIEW, /startProgressPolling/, "不得退回旧版「谁发起谁轮询」的 startProgressPolling（定时触发的扫描将不可见）");
// 定时配置 UI：新增/编辑两处开关 + 时间选择器，卡片摘要 + 定时标签
mustCountRaw(VIEW, /t\('admin\.sources\.autoScan'\)/g, 3, "定时增量扫描配置必须在卡片摘要 + 新增/编辑两个对话框各就位");
mustCountRaw(VIEW, /<el-time-picker/g, 2, "新增与编辑对话框各需一个扫描时间选择器");
mustCountRaw(VIEW, /value-format="HH:mm"/g, 2, "两个时间选择器都必须以 HH:mm 字符串对外（否则提交格式与后端校验不符）");
mustCountRaw(VIEW, /t\('admin\.sources\.autoTriggered'\)/g, 1, "进度区必须显示「定时」来源标签");

if (errors.length) {
  console.error(`✗ 媒体源扫描链路守卫失败：${errors.length} 项违规（共 ${checks} 条断言）`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(
  `✅ 媒体源扫描链路守卫通过：${checks} 条断言全部成立（实时进度收口 / 定时共用入口 / 并发让渡 / 聚合接口 / 配置消毒 / 前端常驻轮询）。`,
);
