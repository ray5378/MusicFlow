// ==================== 离线预测量（P5-3，可选优化层，**默认关**） ====================
//
// 为什么需要它：② 段的默认路径是**实时 loudnorm**（D2）—— 首播即生效，不需要任何前置测量。
// 代价是每首歌起播时都要跑一遍动态归一化（多一次全曲分析 + 一个更重的滤镜）。
// 对**自持源**（local / webdav，行背后的文件今天明天都一样）可以把这个分析提前做掉：
// 量一次落进 `audio_analysis`，以后起播就走 `volume=XdB` 静态增益
// （判定链已经在 P0 打通：`pipeline.resolveLoudnessAf` → 有测量值 → fixed_gain）。
//
// 三条自我约束（都很容易做错，写在这里免得以后再讨论一遍）：
//   1. **默认关**。plan §3.2 明确「预测量是可选优化，不是前置条件 —— 不能让『没测完就没效果』
//      阻塞本轮价值」。它是省 CPU 的锦上添花，不是正确性的一环。
//   2. **只测 local 行**。web（网络源）每次取到的字节都不保证一致，测了写下来下次会被当成
//      「这首已经测过」而误用（D8 / `analysisStore.shouldPersistAnalysis`）。这里连候选集都
//      不选 web；`saveAnalysis` 再兜一道（双保险，不是重复）。
//   3. **不占 playback 并发池**。它天生被串行化为 1 个 ffmpeg（模块级 `running` + 逐曲 await），
//      占用有界；反过来去抢 `quality` 池的话，一次批量测量会把客户端的音质转码请求顶到队尾。
//
// 顺带说明「热点曲目输出缓存」为什么**不做**：plan §2 核心原则写着「不做『预渲染缓存』这类
// 旁路：MA 没有这一层」。缓存编码产物会与 D9 的「所有出口同一条实时管道」直接冲突
// （缓存命中就等于绕过 ②–⑤，且 DSP/响度目标一改就得整库失效）。真到 CPU 不够那天再评估。
import { spawn } from "node:child_process";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";
import { parseSongPath } from "../../utils/localSourceProbe.js";
import { getSettingBool, setSetting } from "../settings.js";
import { resolveFfmpeg } from "../transcode.js";
import { saveAnalysis } from "./analysisStore.js";
import { parseLoudnorm } from "./loudness.js";
import { LOUDNORM_ARGS } from "./pipeline.js";
import { StderrTail, STDERR_KEEP_BYTES } from "./stderrTail.js";

const log = createLogger("Measure");

/** 开关键（缺省关）。与 `pipeline.*` 同族，便于一处枚举全部管道开关。 */
export const MEASURE_ENABLED_KEY = "measure.enabled";

/** 单次手动触发的默认/最大曲数 —— 上限防止一次点按把整库几万首都排上队。 */
export const MEASURE_DEFAULT_LIMIT = 50;
export const MEASURE_MAX_LIMIT = 500;

/** 单曲测量墙钟上限。整曲分析在 8 核机约 20~60x 实时，1 小时长曲也够；
 *  超过即判失败并杀掉进程（避免一个卡死的 ffmpeg 把串行队列堵住）。 */
export const MEASURE_TIMEOUT_MS = 5 * 60 * 1000;

export function isOfflineMeasureEnabled(): boolean {
  return getSettingBool(MEASURE_ENABLED_KEY, false);
}

export function setOfflineMeasureEnabled(on: boolean): void {
  setSetting(MEASURE_ENABLED_KEY, on ? "1" : "0");
}

// ==================== 纯函数层（零 IO，可单测） ====================

/**
 * 测量命令：只解码 + 分析，**不出音频**（`-f null -`）。
 *
 * 用 `loudnorm` 的 JSON 报告而不是 `ebur128=peak=true` 的文本汇总：两者测的是同一个量，
 * 而 `parseLoudnorm()`（P0 起就在实时路径上用）已经是经过单测的那一份解析器 ——
 * 「离线测的值」和「实时路径算的值」因此**按构造成对**，不会出现两套解析口径。
 * `-loglevel info` 是 JSON 能被打出来的前提（同 `pipeline.decodeArgs` 的 needsInfo）。
 */
export function buildMeasureArgs(input: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "info",
    "-i", input,
    "-vn", "-sn", "-dn", "-map", "0:a:0",
    "-af", `loudnorm=${LOUDNORM_ARGS}`,
    "-f", "null", "-",
  ];
}

/** 把用户传的 limit 归一化到 [1, MEASURE_MAX_LIMIT]，非法值回落默认值。 */
export function normalizeLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MEASURE_DEFAULT_LIMIT;
  return Math.min(MEASURE_MAX_LIMIT, Math.floor(n));
}

/** 行是否可测：path 必须是 `l:<sourceId>:<绝对路径>` 形态的本地行。 */
export function measurableLocalPath(path: string | null | undefined): string | null {
  const parsed = parseSongPath(path || "");
  if (!parsed || parsed.type !== "l" || !parsed.filePath) return null;
  return parsed.filePath;
}

// ==================== 候选集 / 统计 ====================

/** 「本地行」的 SQL 口径 —— 与 analysisStore 的 `type || "local"` 惯例一致（NULL/空串算 local）。
 *  抽成常量避免两处各写一遍后漂移。 */
const LOCAL_SQL = `COALESCE(NULLIF(s.type,''),'local') = 'local' AND s.path LIKE 'l:%'`;

export interface MeasureCandidate {
  id: string;
  path: string;
}

/** 取「尚未测量」的本地行（有测量值的直接跳过，重复点是幂等的）。 */
export function listMeasureCandidates(limit: number): MeasureCandidate[] {
  const n = normalizeLimit(limit);
  return sqlite
    .prepare(
      `SELECT s.id AS id, s.path AS path
         FROM songs s
         LEFT JOIN audio_analysis a ON a.row_id = s.id
        WHERE ${LOCAL_SQL} AND a.loudness_integrated IS NULL
        ORDER BY s.id
        LIMIT ?`,
    )
    .all(n) as MeasureCandidate[];
}

export interface MeasureCounts {
  total: number;
  measured: number;
  pending: number;
}

export function measureCounts(): MeasureCounts {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN a.loudness_integrated IS NOT NULL THEN 1 ELSE 0 END) AS measured
         FROM songs s
         LEFT JOIN audio_analysis a ON a.row_id = s.id
        WHERE ${LOCAL_SQL}`,
    )
    .get() as { total: number; measured: number | null } | undefined;
  const total = Number(row?.total) || 0;
  const measured = Number(row?.measured) || 0;
  return { total, measured, pending: Math.max(0, total - measured) };
}

// ==================== 执行层 ====================

/** 跑一次 ffmpeg 并只收集 stderr 尾部（JSON 报告在最后）。 */
function captureFfmpegStderr(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    // 本次已把 sendspin / airplay / 这里三处统一到同一个「留末尾」实现（stderrTail.ts）。
    const tail = new StderrTail(STDERR_KEEP_BYTES);
    let settled = false;
    const child = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolve(tail.text());
    }, timeoutMs);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tail.text());
    };
    child.stderr?.on("data", (chunk: Buffer) => { tail.push(chunk); });
    // 没有 error 监听时 spawn 失败(EACCES/ENOENT)会抛成未捕获异常(进程级崩溃)。
    child.on("error", (e) => {
      log.warn("ffmpeg 拉起失败", { message: e?.message });
      finish();
    });
    child.on("close", finish);
  });
}

/** 测一首：解析本地路径 → 跑分析 → 落库。返回是否真的写入了测量值。 */
async function measureOne(row: MeasureCandidate): Promise<boolean> {
  const filePath = measurableLocalPath(row.path);
  if (!filePath) return false;
  const stderr = await captureFfmpegStderr(buildMeasureArgs(filePath), MEASURE_TIMEOUT_MS);
  const m = parseLoudnorm(stderr);
  if (!m) return false;
  // rowType 固定 "local"：候选集已限定本地行，这里再兜一道 D8。
  return saveAnalysis(row.id, "local", { loudnessIntegrated: m.inputI, truePeak: m.inputTp });
}

export interface MeasureRunSummary extends MeasureCounts {
  considered: number;
  measured: number;
  failed: number;
}

// 模块级运行态：`running` 是**唯一的并发闸门**（见文件头第 3 条自我约束）。
let running = false;
let progress: { done: number; total: number } = { done: 0, total: 0 };

export function isMeasuring(): boolean {
  return running;
}

/**
 * 串行测一批（逐曲 await）。**不抛**：单曲失败只计入 failed，不中断整批。
 * `limit` 之外还会被候选集本身（只取未测量的）限制。
 */
export async function runOfflineMeasure(opts: { limit?: number } = {}): Promise<MeasureRunSummary> {
  const rows = listMeasureCandidates(normalizeLimit(opts.limit));
  progress = { done: 0, total: rows.length };
  let measured = 0;
  let failed = 0;
  for (const row of rows) {
    const ok = await measureOne(row).catch((e) => {
      log.warn("测量失败", { id: row.id, message: e?.message });
      return false;
    });
    if (ok) measured++;
    else failed++;
    progress.done++;
  }
  // 先铺全局计数（total / pending），再用**本次运行**的实测数覆盖 measured / failed
  // —— 顺序不能反：反过来 measured 会被全局值盖掉（TS2783 也会直接拦下）。
  const summary: MeasureRunSummary = { ...measureCounts(), considered: rows.length, measured, failed };
  log.info("离线预测量完成", summary as unknown as Record<string, unknown>);
  return summary;
}

/**
 * 手动触发（异步）。立即返回，前端轮询 `getMeasureStatus()` 看进度 ——
 * 同步等一批会撞上前端 15s 的请求超时。
 */
export function startOfflineMeasure(limit?: number): { started: boolean; reason?: string } {
  if (!isOfflineMeasureEnabled()) return { started: false, reason: "disabled" };
  if (running) return { started: false, reason: "busy" };
  running = true;
  void runOfflineMeasure({ limit })
    .catch(() => { /* runOfflineMeasure 自身不抛，这里只兜底 */ })
    .finally(() => { running = false; });
  return { started: true };
}

export interface MeasureStatus extends MeasureCounts {
  enabled: boolean;
  running: boolean;
  progress: { done: number; total: number };
}

export function getMeasureStatus(): MeasureStatus {
  return { enabled: isOfflineMeasureEnabled(), running, progress: { ...progress }, ...measureCounts() };
}

/** 测试用：清掉模块级运行态（vitest 同进程多用例会共享它）。 */
export function resetOfflineMeasureStateForTests(): void {
  running = false;
  progress = { done: 0, total: 0 };
}
