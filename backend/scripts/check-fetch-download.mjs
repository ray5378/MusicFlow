#!/usr/bin/env node
// ==================== 下载任务「取消 / 完全停止」与续批链路守卫 ====================
//
// 本脚本锁的是下载任务生命周期里**两条停止语义**的可逆性与链路完整性。这些契约的共同点是
// 断了不报错、不会让动态用例变红，只会让任务行**永久卡在 running**、让「已完成」被降级成
// 「已取消」、或让自动续批链无限复活：
//
//   取消（排空式）＝ 停止准入新条目，但在途下载 / 缓存待转码的歌**必须走完并落地**；
//   完全停止（硬终止）＝ 彻底终止整个流程（含自动续批链），未完成条目不落地。
//
// 八条规则：
//   R1 双控制器：jobRunner 必须同时持有 hard（硬停）与 drain（排空）两个 AbortController，
//      并把 drain 转发给批量子进程（只停「开始新工作」，不挂 killTimer）。
//   R2 取消语义：drain 触发后不再开新片、本片走完即收尾（drained）。
//   R3 完全停止语义：hard 触发即补写终态（"用户完全停止"），并**掐断自动续批链**。
//   R4 终态守卫：收尾只能在 pending/running/cancelled 上落 cancelled，绝不把 done 降级。
//   R5 未开始条目补全：未出现在 items 的 target 必须补写成 cancelled，且 counts.total 对齐。
//   R6 重入守卫 + boot 恢复延迟：同 jobId 不得起两条循环；boot 恢复延后 60s 且跳过本进程已在跑的。
//   R7 续批链保护：无进展 / 零尝试必须停链并**清会话标记**（否则调度器每个 tick 反复建批）。
//   R8 API + 前端二次确认：/cancel→drain、/force-stop→hard；两个按钮都必须有二次确认弹窗。
//
// 零依赖 node 脚本（与 check-dead-song-purge.mjs 同款，共用 strip-comments），挂 ci.yml 守卫 job。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const JOBRUNNER = "backend/src/services/fetch/jobRunner.ts";
const RUNNER = "backend/src/batch/runner.ts";
const ROUTES = "backend/src/routes/api/fetch.ts";
const FE_API = "frontend/src/api/fetch.ts";
const JOBPANEL = "frontend/src/views/admin/Fetch/JobListPanel.vue";
const ZH = "frontend/src/locales/zh-CN.json";
const EN = "frontend/src/locales/en-US.json";

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

function liveLines(text) {
  return stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function mustMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  if (!liveLines(text).some((l) => re.test(l))) errors.push(`${rel}: ${why}`);
}

function mustNotMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const hit = liveLines(text).find((l) => re.test(l));
  if (hit) errors.push(`${rel}: ${why} —— 命中: ${hit.slice(0, 120)}`);
}

function mustHave(rel, needle, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  if (!text.includes(needle)) errors.push(`${rel}: ${why}`);
}

// ---------- R1 双控制器 + drain 转发 ----------
mustMatch(JOBRUNNER, /const hard = new AbortController\(\);/, "必须持有 hard（硬停）AbortController");
mustMatch(JOBRUNNER, /const drain = new AbortController\(\);/, "必须持有 drain（排空）AbortController");
mustMatch(JOBRUNNER, /controllers\.set\(jobId, \{ hard, drain \}\);/, "两个控制器必须成对登记（缺一取消语义即失真）");
mustMatch(RUNNER, /drainSignal\?: AbortSignal;/, "批处理运行器必须接受 drainSignal（排空信号）");
mustMatch(
  RUNNER,
  /const drainNow = \(\) => sendToChild\(\{ type: "drain", jobId \}\);/,
  "drain 必须转发给子进程（只停开始新工作、走完在途）",
);
mustMatch(JOBRUNNER, /drainSignal: drain\.signal,/, "逐片 runBatchJob 必须把 drain 信号透传给子进程");

// ---------- R2 取消（排空）语义 ----------
mustMatch(
  JOBRUNNER,
  /if \(drain\.signal\.aborted\) \{ drained = true; break; \}/,
  "drain 触发后必须不再开启新片（本片走完即收尾）",
);
mustMatch(JOBRUNNER, /if \(drained\) finalizeDrainedFetchJob\(jobId\);/, "排空退出必须走排空收尾（补终态）");

// ---------- R3 完全停止（硬终止）语义 ----------
mustMatch(
  JOBRUNNER,
  /if \(hard\.signal\.aborted\) finalizeDrainedFetchJob\(jobId, "用户完全停止"\);/,
  "完全停止后必须补写 cancelled 终态（否则非末片被硬停时任务行永久卡 running）",
);
mustMatch(
  JOBRUNNER,
  /const hardStopped = hard\.signal\.aborted;/,
  "必须在续批判定前取出 hardStopped（完全停止要掐断续批链，即便本任务恰已 done）",
);
mustMatch(JOBRUNNER, /maybeContinueLibraryJob\(jobId, hardStopped\);/, "全库续批必须收到完全停止信号");
mustMatch(JOBRUNNER, /maybeContinueUpgradeJob\(jobId, hardStopped\);/, "洗版续批必须收到完全停止信号");

// ---------- R4 终态守卫（不降级 done） ----------
mustMatch(
  JOBRUNNER,
  /if \(job\.status === "pending" \|\| job\.status === "running" \|\| job\.status === "cancelled"\) \{/,
  "收尾只允许在确未跑完的终态上落 cancelled（否则会把已 done 的任务降级 + 挂上不实的取消说明）",
);
mustMatch(
  JOBRUNNER,
  /updateFetchJobStatus\(jobId, "cancelled", \{ error: terminalError \}\);/,
  "收尾必须落 cancelled 终态并带原因文案",
);

// ---------- R5 未开始条目补全 ----------
mustMatch(JOBRUNNER, /errorMsg: "任务已取消（未开始）"/, "未开始条目必须补写「未开始」说明（重试可恢复）");
mustMatch(
  JOBRUNNER,
  /saveFetchJobItems\(jobId, \[\.\.\.job\.items, \.\.\.missing\], \{ total: all\.length \}\);/,
  "补全条目时 counts.total 必须与 items 对齐（否则列表「总数」与条目数不一致）",
);

// ---------- R6 重入守卫 + boot 恢复 ----------
mustMatch(JOBRUNNER, /if \(controllers\.has\(jobId\)\) return;/, "同 jobId 的循环已在跑时不得再起一条");
mustMatch(JOBRUNNER, /export const BOOT_RESUME_DELAY_MS = 60_000;/, "boot 恢复必须延后 60s（启动瞬间抢资源会导致容器刚起就卡）");
mustMatch(
  JOBRUNNER,
  /if \(controllers\.has\(id\)\) continue;/,
  "boot 恢复必须跳过本进程已在推进的任务（否则同一 job 被两条循环并发推进）",
);

// ---------- R7 续批链保护 ----------
mustMatch(JOBRUNNER, /if \(!libraryBatchProgressed\(job\.counts\)\) \{/, "全库续批必须有无进展保护（否则无限重选同一批）");
mustMatch(JOBRUNNER, /setAutoSession\("library", false\);/, "停链必须清 library 会话标记（否则调度器每 tick 反复建批）");
mustMatch(
  JOBRUNNER,
  /Number\(cc\?\.total \?\? 0\) > 0 && !Number\(cc\?\.done\) && !Number\(cc\?\.failed\) && !Number\(cc\?\.skipped\)/,
  "洗版续批必须有零尝试闸（启动预检失败时停链，避免整池扫进冷却）",
);
mustMatch(JOBRUNNER, /setAutoSession\("upgrade", false\);/, "停链必须清 upgrade 会话标记");

// ---------- R8 API + 前端二次确认 ----------
mustMatch(JOBRUNNER, /export function abortFetchJob\(jobId: string\): boolean \{/, "硬停 API 必须存在");
mustMatch(JOBRUNNER, /export function drainFetchJob\(jobId: string\): boolean \{/, "排空 API 必须存在");
mustMatch(
  ROUTES,
  /app\.post\("\/v1\/fetch\/jobs\/:id\/cancel", adminMiddleware/,
  "必须有 /jobs/:id/cancel 端点（排空式取消）",
);
mustMatch(
  ROUTES,
  /app\.post\("\/v1\/fetch\/jobs\/:id\/force-stop", adminMiddleware/,
  "必须有 /jobs/:id/force-stop 端点（完全停止）",
);
mustMatch(ROUTES, /finishStop\(id, job, drainFetchJob\)/, "cancel 端点必须接 drainFetchJob（排空）");
mustMatch(ROUTES, /finishStop\(id, job, abortFetchJob\)/, "force-stop 端点必须接 abortFetchJob（硬停）");
mustMatch(
  FE_API,
  /\/jobs\/\$\{encodeURIComponent\(id\)\}\/cancel/,
  "前端 drainJob 必须打 /cancel 端点",
);
mustMatch(
  FE_API,
  /\/jobs\/\$\{encodeURIComponent\(id\)\}\/force-stop/,
  "前端 forceStopJob 必须打 /force-stop 端点",
);
mustMatch(JOBPANEL, /await ElMessageBox\.confirm\(/, "取消/完全停止必须走二次确认弹窗");
mustMatch(JOBPANEL, /t\("admin\.fetch\.jobs\.cancelConfirm"/, "取消按钮必须弹「排空式停止」后果说明");
mustMatch(JOBPANEL, /t\("admin\.fetch\.jobs\.forceStopConfirm"/, "完全停止按钮必须弹「硬终止」后果说明");
mustMatch(JOBPANEL, /await drainJob\(job\.id\);/, "取消必须调 drainJob（排空）");
mustMatch(JOBPANEL, /await forceStopJob\(job\.id\);/, "完全停止必须调 forceStopJob（硬停）");
mustHave(ZH, '"cancelConfirm"', "zh-CN 缺 jobs.cancelConfirm 文案");
mustHave(ZH, '"forceStopConfirm"', "zh-CN 缺 jobs.forceStopConfirm 文案");
mustHave(EN, '"cancelConfirm"', "en-US 缺 jobs.cancelConfirm 文案");
mustHave(EN, '"forceStopConfirm"', "en-US 缺 jobs.forceStopConfirm 文案");

// ---------- R9 标签修复入队（下载终态事件主路径） ----------
mustMatch(
  JOBRUNNER,
  /enqueueTagRepairs\(\[\.\.\.new Set\(ids\)\]\);/,
  "任务终态必须把本批入库歌曲入「标签修复」队列（否则下载期拿不到的标签永不补）",
);
mustMatch(
  JOBRUNNER,
  /i\.result === "added" \|\| i\.result === "updated"/,
  "只对真正落盘入库（added/updated）的歌入队",
);

// ---------- 自检：守卫必须真的扫到了东西 ----------
if (checks < 25) {
  console.error(`✗ 守卫自身失效：只执行了 ${checks} 条检查 —— 扫描逻辑或文件路径约定已变，请先修守卫本身`);
  process.exit(1);
}

if (errors.length > 0) {
  console.error(`\n下载任务取消/停止链路守卫：发现问题（${errors.length} 处 / 共 ${checks} 条检查）:`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`✅ 下载任务取消/停止链路守卫通过：${checks} 条检查（只认非注释行）—— 双控制器 / 取消语义 / 完全停止语义 / 终态守卫 / 条目补全 / boot 恢复 / 续批链保护 / API+前端二次确认 全部在位`);
