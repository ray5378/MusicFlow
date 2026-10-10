// MusicFetch（网络音源自动下载入库）任务登记：`fetch_jobs` 单表的读写封装。
//
// 设计口径见 M2 架构文档 §3（B.2 建表 / B.3 JSON 契约 / B.5 保洁）：
//   - 一次任务一行；items / imports 落 JSON 列，不做拆表（item 只在任务内被读写）。
//   - 单元素更新 = 读整列 → 改 → 整列写回；调用方收全量数组直接整列写回即可。
//   - 保洁：保留最近 N 条**已终态**任务（SPEC §六.7 禁止无上限常驻结构）。
//
// 本模块只依赖 db（db/index.ts）+ fetchJobs（db/schema.ts）+ drizzle，可在主进程与
// 批量子进程里同源使用（子进程持有独立的 better-sqlite3 连接）。

import { eq, desc, inArray, lt, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/index.js";
import { fetchJobs } from "../../db/schema.js";
import type { ItemStatus, TaskStatus, FetchErrorCode, CandidateQuality } from "./types.js";

/** items_json 元素：一首歌从取链到落盘的完整生命周期，重试只增 attempts 不增元素。 */
export interface FetchJobItem {
  id: string;
  targetId: string;
  status: ItemStatus;
  attempts: number;
  chosen?: {
    candidateId: string;
    pluginId: string;
    platform: string;
    declared?: CandidateQuality;
    probed?: CandidateQuality;
  };
  rejected?: Array<{ candidateId: string; reason: FetchErrorCode }>;
  host?: string;
  bytes?: number;
  cachePath?: string;
  finalPath?: string;
  errorCode?: FetchErrorCode;
  errorMsg?: string;
  /** 洗版审计：命中更好音质后对原低码率文件的处置结果（items_json 整体 JSON 落库，加字段零成本）。 */
  replaced?: { originalPath: string; newPath: string; action: string; deleted?: boolean; movedTo?: string };
  /** 原地替换（洗版：假无损但高于原件）：新文件落在原媒体源目录，按原 sourceId 入库。 */
  inPlace?: { fsPath: string; sourceId: string };
  startedAt?: string;
  finishedAt?: string;
}

/** imports_json 元素：入库结果（一首最多一条，重试成功只更新不追加）。 */
export interface FetchJobImport {
  itemId: string;
  songId?: string;
  result?: "added" | "updated" | "skipped" | "failed";
  filePath?: string;
  err?: string;
}

/** 聚合计数（落 counts_json，列表页免解析 items_json）。 */
export interface FetchJobCounts {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  added: number;
  updated: number;
  bytes: number;
}

/** 反序列化后的任务记录（对外形态）。 */
export interface FetchJobRecord {
  id: string;
  kind: string;
  status: TaskStatus;
  sourceId: string | null;
  targets: any;
  items: FetchJobItem[];
  imports: FetchJobImport[];
  config: Record<string, any>;
  counts: FetchJobCounts;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** 已终态集合：只有这些状态才会被保洁删除。 */
const TERMINAL_STATUSES = ["done", "partial", "failed", "cancelled"] as const;

/** 零值计数基线：counts_json 缺键 / 为空 / 坏数据时的兜底，与建表 SQL 的 `'{}'` 语义一致。 */
const ZERO_COUNTS: FetchJobCounts = {
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  added: 0,
  updated: 0,
  bytes: 0,
};

/** 保洁保留条数（仅对已终态任务计），与 M2 §B.5 / SPEC §六.7 一致。 */
export const FETCH_JOBS_KEEP_MAX = 200;

function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 容错 JSON 解析：坏数据绝不抛异常，一律回落到 fallback。 */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return (v === null || v === undefined ? fallback : v) as T;
  } catch {
    return fallback;
  }
}

function readArray<T>(raw: string | null | undefined): T[] {
  const v = parseJson<unknown>(raw, []);
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 解析 counts_json，按 ZERO_COUNTS 补齐缺失键并丢弃非数值字段。 */
function readCounts(raw: string | null | undefined): FetchJobCounts {
  const src = parseJson<Record<string, unknown>>(raw, {});
  const out: FetchJobCounts = { ...ZERO_COUNTS };
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const key of Object.keys(ZERO_COUNTS) as (keyof FetchJobCounts)[]) {
      const v = (src as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

type FetchJobRow = typeof fetchJobs.$inferSelect;

function rowToRecord(row: FetchJobRow): FetchJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as TaskStatus,
    sourceId: row.sourceId ?? null,
    targets: parseJson<any>(row.targetsJson, {}),
    items: readArray<FetchJobItem>(row.itemsJson),
    imports: readArray<FetchJobImport>(row.importsJson),
    config: parseJson<Record<string, any>>(row.configJson, {}),
    counts: readCounts(row.countsJson),
    error: row.error ?? null,
    createdAt: row.createdAt ?? "",
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    updatedAt: row.updatedAt ?? "",
  };
}

/**
 * 创建一条下载任务（状态 pending），成功后顺带跑一次保洁。
 * targets / config 由调用方给定并整体快照进 JSON 列。
 */
export function createFetchJob(input: {
  id?: string;
  kind?: string;
  targets: any;
  config?: Record<string, any>;
  sourceId?: string | null;
}): FetchJobRecord {
  const id = input.id ?? uuidv4();
  const now = new Date().toISOString();
  db.insert(fetchJobs)
    .values({
      id,
      kind: input.kind ?? "manual",
      status: "pending",
      sourceId: input.sourceId ?? null,
      targetsJson: JSON.stringify(input.targets ?? {}),
      itemsJson: "[]",
      importsJson: "[]",
      configJson: JSON.stringify(input.config ?? {}),
      countsJson: JSON.stringify(ZERO_COUNTS),
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    })
    .run();
  pruneFetchJobs();
  return getFetchJob(id)!;
}

/** 读取单条任务；不存在返回 null。 */
export function getFetchJob(id: string): FetchJobRecord | null {
  const row = db.select().from(fetchJobs).where(eq(fetchJobs.id, id)).get();
  return row ? rowToRecord(row) : null;
}

/** 列出任务，默认按 created_at DESC（最新在前），默认最多 100 条。 */
export function listFetchJobs(opts?: { limit?: number; status?: TaskStatus }): FetchJobRecord[] {
  const limit = opts?.limit ?? 100;
  const rows = opts?.status
    ? db
        .select()
        .from(fetchJobs)
        .where(eq(fetchJobs.status, opts.status))
        .orderBy(desc(fetchJobs.createdAt))
        .limit(limit)
        .all()
    : db
        .select()
        .from(fetchJobs)
        .orderBy(desc(fetchJobs.createdAt))
        .limit(limit)
        .all();
  return rows.map(rowToRecord);
}

/**
 * 更新任务状态。流转到 `running` 补 startedAt；流转到终态补 finishedAt。
 * extra.error / extra.sourceId 显式传入时一并覆盖（传 undefined 表示不改）。
 */
export function updateFetchJobStatus(
  id: string,
  status: TaskStatus,
  extra?: { error?: string | null; sourceId?: string | null },
): void {
  const now = new Date().toISOString();
  const set: Partial<FetchJobRow> = { status, updatedAt: now };
  if (extra && "error" in extra) set.error = extra.error ?? null;
  if (extra && "sourceId" in extra) set.sourceId = extra.sourceId ?? null;
  if (status === "running") set.startedAt = now;
  if (isTerminal(status)) set.finishedAt = now;
  db.update(fetchJobs).set(set).where(eq(fetchJobs.id, id)).run();
}

/** 删除单条任务记录（存在与否由调用方判定）；仅终态任务可删由路由层把关。 */
export function deleteFetchJobRow(id: string): boolean {
  const job = getFetchJob(id);
  if (!job) return false;
  db.delete(fetchJobs).where(eq(fetchJobs.id, id)).run();
  return true;
}

/** 清空任务记录（只清终态；running/pending 不动）。返回删除行数。 */
export function clearFetchJobRows(): number {
  const stale = db
    .select({ id: fetchJobs.id })
    .from(fetchJobs)
    .where(inArray(fetchJobs.status, [...TERMINAL_STATUSES]))
    .all();
  if (stale.length === 0) return 0;
  db.delete(fetchJobs)
    .where(inArray(fetchJobs.status, [...TERMINAL_STATUSES]))
    .run();
  return stale.length;
}

/**
 * 按保留天数清理过期任务记录（只清终态）。retentionDays <= 0 = 关闭。
 * 以 updatedAt 为基准（进行中会不断刷新，终态后停止）。
 */
export function cleanExpiredFetchJobs(retentionDays: number): number {
  if (!(Number(retentionDays) > 0)) return 0;
  const cutoff = new Date(Date.now() - Number(retentionDays) * 86_400_000).toISOString();
  const cond = and(
    inArray(fetchJobs.status, [...TERMINAL_STATUSES]),
    lt(fetchJobs.updatedAt, cutoff),
  );
  const stale = db.select({ id: fetchJobs.id }).from(fetchJobs).where(cond).all();
  if (stale.length === 0) return 0;
  db.delete(fetchJobs).where(cond).run();
  return stale.length;
}

/**
 * 启动恢复：把上一进程遗留的 pending/running 任务落 failed 终态。
 *
 * 跑批循环是**进程内**的（jobRunner 持有 AbortController），服务重启即消亡；
 * 不恢复的话这些行永远卡在 running，UI 取消也无效（无 controller 可 abort）。
 * 返回恢复行数。
 */
export function recoverInterruptedFetchJobs(): number {
  const now = new Date().toISOString();
  const stale = db
    .select({ id: fetchJobs.id })
    .from(fetchJobs)
    .where(inArray(fetchJobs.status, ["pending", "running"]))
    .all();
  if (stale.length === 0) return 0;
  db.update(fetchJobs)
    .set({ status: "failed", error: "服务重启，任务中断（boot 恢复）", updatedAt: now, finishedAt: now })
    .where(inArray(fetchJobs.status, ["pending", "running"]))
    .run();
  return stale.length;
}

/**
 * 整列写回 items（调用方收全量数组）。counts 传入时按 Partial 合并进既有计数
 * （未给的键保留现值），避免调用方每次都要回传全量计数。
 */
export function saveFetchJobItems(
  id: string,
  items: FetchJobItem[],
  counts?: Partial<FetchJobCounts>,
): void {
  const now = new Date().toISOString();
  const set: Partial<FetchJobRow> = {
    itemsJson: JSON.stringify(Array.isArray(items) ? items : []),
    updatedAt: now,
  };
  if (counts) {
    const current = getFetchJob(id);
    const merged: FetchJobCounts = { ...ZERO_COUNTS, ...(current?.counts ?? {}), ...counts };
    set.countsJson = JSON.stringify(merged);
  }
  db.update(fetchJobs).set(set).where(eq(fetchJobs.id, id)).run();
}

/** 整列写回 imports（调用方收全量数组）。 */
export function saveFetchJobImports(id: string, imports: FetchJobImport[]): void {
  db.update(fetchJobs)
    .set({
      importsJson: JSON.stringify(Array.isArray(imports) ? imports : []),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(fetchJobs.id, id))
    .run();
}

/**
 * 保洁：只对**已终态**任务（done|partial|failed|cancelled）计算，保留最近 keepMax 条，
 * 超限的按 created_at 升序删最老。pending / running 永不删除。返回删除条数。
 */
export function pruneFetchJobs(keepMax = FETCH_JOBS_KEEP_MAX): number {
  const rows = db
    .select({ id: fetchJobs.id, createdAt: fetchJobs.createdAt })
    .from(fetchJobs)
    .where(inArray(fetchJobs.status, [...TERMINAL_STATUSES]))
    .orderBy(desc(fetchJobs.createdAt))
    .all();
  const toDelete = rows.slice(Math.max(0, keepMax)).map((r) => r.id);
  if (toDelete.length === 0) return 0;
  db.delete(fetchJobs).where(inArray(fetchJobs.id, toDelete)).run();
  return toDelete.length;
}

/** 删除单条任务（含未终态；任务取消/清理时用）。 */
export function deleteFetchJob(id: string): void {
  db.delete(fetchJobs).where(eq(fetchJobs.id, id)).run();
}

/** 测试专用：清空整表。 */
export function _resetFetchJobsForTest(): void {
  db.delete(fetchJobs).run();
}
