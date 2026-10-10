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

export interface FetchPreviewItem {
  targetId?: string;
  title: string;
  artist?: string;
  status: string;
  tier?: string;
  reason?: string;
}

export interface FetchPreviewSummary {
  total: number;
  downloadable: number;
  belowBar: number;
  noCandidate: number;
}

export interface FetchConfig {
  enabled?: boolean;
  downloadRoot?: string;
  cacheRoot?: string;
  qualityFloor?: string;
  minBitrateKbps?: number;
  minSampleRateHz?: number;
  preferLossless?: boolean;
  rejectFakeLossless?: boolean;
  skipIfInLibrary?: boolean;
  strictBestTier?: boolean;
  integrityLevel?: string;
  transcodeEnabled?: boolean;
  transcodeTarget?: string;
  transcodeSampleRateHz?: number;
  transcodeBitDepth?: number;
  transcodeKeepOriginal?: boolean;
  maxConcurrentDownloads?: number;
  maxConcurrentPerHost?: number;
  perHostMinIntervalMs?: number;
  rateLimitKBps?: number;
  fileConflictPolicy?: string;
  sourcePriority?: string[];
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

export async function previewFetch(
  targets: FetchTargetInput[],
): Promise<{ summary: FetchPreviewSummary; items: FetchPreviewItem[] }> {
  const res = await api.post(`${BASE}/preview`, { targets });
  return {
    summary: res.data?.summary as FetchPreviewSummary,
    items: (res.data?.items ?? []) as FetchPreviewItem[],
  };
}

export async function createFetchTask(targets: FetchTargetInput[], dryRun = false): Promise<string> {
  const res = await api.post(`${BASE}/tasks`, { targets, dryRun });
  return res.data?.jobId as string;
}

export async function listFetchJobs(params?: {
  limit?: number;
  status?: string;
}): Promise<FetchJobSummary[]> {
  const res = await api.get(`${BASE}/jobs`, { params });
  return (res.data?.jobs ?? []) as FetchJobSummary[];
}

export async function getFetchJob(id: string): Promise<FetchJobDetail | null> {
  const res = await api.get(`${BASE}/jobs/${encodeURIComponent(id)}`);
  return (res.data?.job ?? null) as FetchJobDetail | null;
}

export async function cancelFetchJob(id: string): Promise<void> {
  await api.post(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`);
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
  inspectCandidates?: boolean;
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
  dryRun?: boolean;
}): Promise<FetchJobSummary | null> {
  const res = await api.post(`${BASE}/upgrade/tasks`, body);
  return (res.data?.job ?? null) as FetchJobSummary | null;
}
