// MusicFetch(网络音源自动下载入库)前端 API 封装。
//
// 所有路径前缀 /rest/api/v1,均需管理员权限(沿用 src/api/index.ts 的 axios 实例,
// 拦截器会自动带上 Authorization / x-mf-lang / x-mf-client-id)。
// 后端契约见任务书,这里只做薄封装 + 类型标注,不改路径、不做业务拼装。
import api from "@/api";

export interface FetchTargetInput {
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
}

export interface FetchJobCounts {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  added: number;
  updated: number;
  bytes: number;
}

export interface FetchJobSummary {
  id: string;
  kind: string;
  status: string;
  sourceId?: string;
  counts: FetchJobCounts;
  createdAt?: string | number;
  startedAt?: string | number;
  finishedAt?: string | number;
}

export interface FetchChosen {
  pluginId: string;
  platform?: string;
  declared?: any;
  probed?: any;
}

export interface FetchJobItem {
  id: string;
  targetId?: string;
  title: string;
  artist?: string;
  status: string;
  attempts?: number;
  chosen?: FetchChosen;
  rejected?: Array<{ candidateId: string; reason: string }>;
  bytes?: number;
  finalPath?: string;
  errorCode?: string;
  errorMsg?: string;
}

export interface FetchJobDetail extends FetchJobSummary {
  items: FetchJobItem[];
  error?: string;
}

export interface FetchSourceInfo {
  pluginId: string;
  platform: string;
  capabilities: string[];
}

export interface FetchConfig {
  enabled?: boolean;
  downloadRoot?: string;
  cacheRoot?: string;
  qualityFloor?: string;
  minBitrateKbps?: number;
  /** 时长容差（秒）：候选与库内行时长偏差超过此值判不匹配。默认 10 */
  durationToleranceSec?: number;
  minSampleRateHz?: number;
  preferLossless?: boolean;
  skipIfInLibrary?: boolean;
  strictBestTier?: boolean;
  /** 下载尝试冷却天数：最近 N 天试过的歌直接跳过（0 = 关闭）。默认 7 */
  downloadCooldownDays?: number;
  /** 死链清理阈值：连续 N 次「资源不存在类」失败即移出曲库（0 = 关闭）。默认 2 */
  deadSongPurgeThreshold?: number;
  transcodeEnabled?: boolean;
  transcodeTarget?: string;
  transcodeSampleRateHz?: number;
  transcodeBitDepth?: 16 | 24 | "auto";
  transcodeKeepOriginal?: boolean;
  maxConcurrentDownloads?: number;
  maxConcurrentJobs?: number;
  /** 单任务内同时推进的歌曲数（目标级并行）。全库下载/洗版都是单任务，此值就是它们真正的并发上限。 */
  maxConcurrentTargets?: number;
  maxConcurrentPerHost?: number;
  perHostMinIntervalMs?: number;
  rateLimitKBps?: number;
  fileConflictPolicy?: string;
  sourcePriority?: string[];
  ssrfTrustedHosts?: string[];
  jobRetentionDays?: number;
  libraryAutoContinue?: boolean;
  /** 全库下载冷却天数（失败尝试 N 天内不再自动选中）。默认 30 */
  libraryCooldownDays?: number;
  /** 定时自动全库下载总开关。默认 false */
  libraryAutoEnabled?: boolean;
  /** 定时自动全库下载间隔天数。默认 1 */
  libraryAutoIntervalDays?: number;
  /** 定时自动全库下载时刻（HH:mm）。默认 "03:00" */
  libraryAutoTimeOfDay?: string;
}

const BASE = "/rest/api/v1/fetch";

export async function getFetchConfig(): Promise<Partial<FetchConfig>> {
  const res = await api.get(`${BASE}/config`);
  return (res.data?.config ?? {}) as Partial<FetchConfig>;
}

export async function updateFetchConfig(cfg: Partial<FetchConfig>): Promise<void> {
  await api.put(`${BASE}/config`, cfg);
}

export async function getFetchSources(): Promise<FetchSourceInfo[]> {
  const res = await api.get(`${BASE}/sources`);
  return (res.data?.sources ?? []) as FetchSourceInfo[];
}

export async function createFetchTask(targets: FetchTargetInput[]): Promise<string> {
  const res = await api.post(`${BASE}/tasks`, { targets });
  return res.data?.jobId as string;
}

export async function listFetchJobs(params?: {
  limit?: number;
  status?: string;
  /** 任务类型白名单（后端 kind IN 过滤）。「下载任务」面板一次拉全部非洗版 kind。 */
  kinds?: string[];
}): Promise<FetchJobSummary[]> {
  // ⚠️ kinds 必须**手动 join 成逗号串**再传：axios 对数组的默认序列化是 `kinds[]=a&kinds[]=b`，
  // 后端按 `kinds` 取值会读不到 → 过滤条件被静默丢掉 → 「下载任务 / 洗版任务」两个 tab
  // 都退化成「不过滤」，两边显示同一份混合列表（真实线上事故，2026-10-11 修复）。
  const { kinds, ...rest } = params ?? {};
  const res = await api.get(`${BASE}/jobs`, {
    params: kinds && kinds.length > 0 ? { ...rest, kinds: kinds.join(",") } : rest,
  });
  return (res.data?.jobs ?? []) as FetchJobSummary[];
}

export async function getFetchJob(id: string): Promise<FetchJobDetail | null> {
  const res = await api.get(`${BASE}/jobs/${encodeURIComponent(id)}`);
  return (res.data?.job ?? null) as FetchJobDetail | null;
}

export async function cancelFetchJob(id: string): Promise<void> {
  await api.post(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`);
}

/** 删除单条任务记录（仅终态任务，运行中会被后端拒绝）。 */
export async function deleteFetchJob(id: string): Promise<void> {
  await api.delete(`${BASE}/jobs/${encodeURIComponent(id)}`);
}

/** 一键清空任务记录（只清终态）。返回删除条数。 */
export async function clearFetchJobs(): Promise<{ cleared: number }> {
  const r = await api.post(`${BASE}/jobs/clear`);
  return (r as any)?.data ?? r;
}

export interface FetchRetryOptions {
  /** 只重试失败项(顶部「重试全部失败项」用)。 */
  onlyFailed?: boolean;
  /** 只重试指定曲目(targetId 列表,逐行「重试」用)。 */
  targetIds?: string[];
}

export async function retryFetchJob(
  id: string,
  opts: FetchRetryOptions = { onlyFailed: true },
): Promise<string> {
  const res = await api.post(`${BASE}/jobs/${encodeURIComponent(id)}/retry`, opts);
  return res.data?.jobId as string;
}

// ---------- 洗版(无损替换低码率) ----------
export interface UpgradePlanItem {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  suffix?: string;
  bitrateKbps?: number;
  durationSec?: number;
  path?: string;
  reason?: string;
}

export interface UpgradePlan {
  sourceIds: string[];
  sourceNames: string[];
  total: number;
  belowBar: number;
  /** 因冷却期跳过的低于门槛数(N 天内已尝试过洗版,无论成败)。 */
  cooled: number;
  truncated: boolean;
  items: UpgradePlanItem[];
}

export interface UpgradeConfig {
  sourceIds?: string[];
  batchLimit?: number;
  originalAction?: "keep" | "move" | "delete";
  losslessRoot?: string;
  compressedMinKbps?: number;
  uncompressedMinKbps?: number;
  /** 洗版冷却天数(1-365,默认 30):N 天内尝试过(无论成败)就跳过。 */
  upgradeCooldownDays?: number;
  /** 定时自动洗版开关(默认关闭)。 */
  upgradeAutoEnabled?: boolean;
  /** 自动洗版间隔天数(1-365,默认 30)。 */
  upgradeAutoIntervalDays?: number;
  /** 每日触发时刻("HH:mm" 24 小时制,服务器本地时区,默认 "03:00")。 */
  upgradeAutoTimeOfDay?: string;
}

export async function getUpgradePlan(params?: {
  sourceId?: string;
  limit?: number;
  offset?: number;
}): Promise<UpgradePlan> {
  const res = await api.get(`${BASE}/upgrade/plan`, { params });
  return (res.data?.plan ?? {
    sourceIds: [],
    sourceNames: [],
    total: 0,
    belowBar: 0,
    cooled: 0,
    truncated: false,
    items: [],
  }) as UpgradePlan;
}

export async function getUpgradeConfig(): Promise<Partial<UpgradeConfig>> {
  const res = await api.get(`${BASE}/upgrade/config`);
  return (res.data?.config ?? {}) as Partial<UpgradeConfig>;
}

export async function updateUpgradeConfig(patch: Partial<UpgradeConfig>): Promise<void> {
  await api.put(`${BASE}/upgrade/config`, patch);
}

export async function startUpgradeTask(body: {
  sourceId?: string;
  songIds?: string[];
  limit?: number;
}): Promise<FetchJobSummary | null> {
  const res = await api.post(`${BASE}/upgrade/tasks`, body);
  return (res.data?.job ?? null) as FetchJobSummary | null;
}

// ---------- 全库平台音乐下载 ----------
export interface LibraryPlanItem {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  suffix?: string;
  bitRate?: number;
}

export interface LibraryPlan {
  total: number;
  attempted: number;
  pending: number;
  willEnqueue: number;
  truncated: boolean;
  items: LibraryPlanItem[];
}

export interface LibraryTaskResult {
  job: FetchJobSummary | null;
  enqueued: number;
  remaining: number;
}

export async function getLibraryPlan(limit = 0): Promise<LibraryPlan> {
  const res = await api.get(`${BASE}/library/plan`, { params: { limit } });
  return (res.data?.plan ?? {
    total: 0,
    attempted: 0,
    pending: 0,
    willEnqueue: 0,
    truncated: false,
    items: [],
  }) as LibraryPlan;
}

export async function startLibraryTask(limit: number): Promise<LibraryTaskResult> {
  const res = await api.post(`${BASE}/library/tasks`, { limit });
  return {
    job: (res.data?.job ?? null) as FetchJobSummary | null,
    enqueued: Number(res.data?.enqueued ?? 0),
    remaining: Number(res.data?.remaining ?? 0),
  };
}

export async function resetLibraryAttempts(): Promise<number> {
  const res = await api.post(`${BASE}/library/reset`);
  return Number(res.data?.cleared ?? 0);
}

/** 清空洗版冷却记录(下一次所有歌都可重新触发洗版)。 */
export async function resetUpgradeAttempts(): Promise<number> {
  const res = await api.post(`${BASE}/upgrade/reset`);
  return Number(res.data?.cleared ?? 0);
}
