// MusicFetch（网络音源自动下载入库）共享类型定义。
//
// 背景：外置音源插件（go-music-dl / lx-source 等）跑在受限沙箱里，只能做「取直链」，
// 无法做二进制 IO。因此「下载 / 校验 / 标签 / 转码 / 落盘」全部在后端主仓内实现。
// 本文件只放**纯类型 + 默认配置常量**，不含任何逻辑，保证可被 utils / services /
// routes 各层安全引用而不产生循环依赖。
//
// 约定：
//   - declared  = 信源声明（下载前判断用，可能虚标）；
//   - probed    = 下载后真实探针（达标判定以 probed 为准，declared 仅作兜底）。

/** 质量档位：从低到高 128 → 192 → 256 → 320 → lossless → hires，unknown 为最低。 */
export type QualityTier = "hires" | "lossless" | "320" | "256" | "192" | "128" | "unknown";

/** 单个候选音源的质量描述（声明值或探针值共用同一结构）。 */
export interface CandidateQuality {
  /** 容器：'flac'|'mp3'|'m4a'|'ogg'|'opus'|'ape'|'wav'|'alac'|'aiff' */
  container?: string;
  /** 信源声明的比特率（kbps） */
  bitrateKbps?: number;
  /** 采样率（Hz），如 44100 / 96000 */
  sampleRateHz?: number;
  /** 位深，如 16 / 24 */
  bitDepth?: number;
  /** 声道数 */
  channels?: number;
  /** 时长（秒） */
  durationSec?: number;
  /** 声明大小（字节，若已知） */
  bytes?: number;
  /** 编码器 metadata 字符串，用于「假无损」的 meta 判定 */
  encoder?: string;
}

/** 一个可下载的候选直链（由插件产出，后端打分排序后择优下载）。 */
export interface Candidate {
  /** 唯一键： `${pluginId}:${platform}:${platformSongId ?? urlHash}` */
  id: string;
  /** 'lx-source' | 'go-music-dl' */
  pluginId: string;
  /** 'wy'|'qq'|'kg'|'kw'|'mg'|'gmd' */
  platform: string;
  url: string;
  /** Referer / UA 等随请求头 */
  headers?: Record<string, string>;
  /** 信源声明（下载前用） */
  declared?: CandidateQuality;
  /** 下载后真实探针（达标判定以此为准） */
  probed?: CandidateQuality;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  track?: number;
  disc?: number;
  coverUrl?: string;
  lyricUrl?: string;
  /** 按用户配置的 sourcePriority 排序后的序号，越小越优先 */
  sourceRank: number;
}

/** 失败原因码：直接面向用户展示，故命名以「用户能看懂」为前提。 */
export type FetchErrorCode =
  | "NO_CANDIDATE"
  | "BELOW_BAR"
  | "FETCH_FAILED"
  | "TIMEOUT"
  | "STALL"
  | "HTTP_403"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "TOO_LARGE"
  | "SSRF_BLOCKED"
  | "INTEGRITY_FAILED"
  | "FAKE_LOSSLESS"
  | "TAG_FAILED"
  | "DISK_FULL"
  | "MOVE_FAILED"
  | "SCAN_FAILED"
  // MusicFetch 编排层（orchestrator）专用：
  | "ALREADY_IN_LIBRARY" // 本地/WebDAV 已有，按用户要求跳过
  | "DUPLICATE_TARGET" // 同一任务内重复的曲目
  | "TRANSCODE_FAILED" // 转码失败（此前借用 TAG_FAILED，UI 上会误显示成"写标签失败"）
  | "UNKNOWN";

/** 单个下载项的流水线状态。 */
export type ItemStatus =
  | "queued"
  | "probing"
  | "downloading"
  | "verifying"
  | "tagging"
  | "transcoding"
  | "moving"
  | "scanned"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

/** 整体任务状态。 */
export type TaskStatus = "pending" | "running" | "done" | "partial" | "cancelled" | "failed";

/** 质量门槛配置（用户可在设置页调整，缺省值见 DEFAULT_QUALITY_CONFIG）。 */
export interface QualityConfig {
  /** 档位下限，'any' 表示不按档位卡（但仍按 minBitrateKbps 卡） */
  qualityFloor: QualityTier | "any";
  /** 有损最低比特率（kbps） */
  minBitrateKbps: number;
  /** 最低采样率（Hz） */
  minSampleRateHz: number;
  /** 最高采样率（Hz），超过视为异常/虚标 */
  maxSampleRateHz: number;
  /** 容器白名单，空数组表示不限制 */
  allowedContainers: string[];
  /** 池中存在无损候选时，剔除所有有损候选 */
  preferLossless: boolean;
  /** 是否拒绝「假无损」（有损转封装成无损容器） */
  rejectFakeLossless: boolean;
  /** 假无损检测手段 */
  fakeLosslessDetect: "off" | "meta" | "bitrate" | "spectrum";
  /** bitrate 模式判假的阈值：有效比特率低于此值即判假 */
  fakeLosslessMinEffBitrate: number;
  /** 最短时长（秒），过滤试听片段 */
  minDurationSec: number;
  /** 最长时长（秒），过滤串烧 */
  maxDurationSec: number;
  /** 与目标时长的容差（秒） */
  durationToleranceSec: number;
  /** 标题命中即排除 */
  excludeTitleKeywords: string[];
  /** 打分时是否惩罚 live / remix / acoustic / cover 等非录音室版本 */
  preferStudioVersion: boolean;
  /** meta 模式命中即判假的编码器特征串 */
  fakeLosslessEncoderHints: string[];
}

/** 默认质量配置：默认门槛 320kbps（产品已确认）。 */
export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  qualityFloor: "320",
  minBitrateKbps: 320,
  minSampleRateHz: 44100,
  maxSampleRateHz: 384000,
  allowedContainers: ["flac", "mp3", "m4a", "ogg", "opus", "ape", "wav", "alac", "aiff"],
  preferLossless: true,
  rejectFakeLossless: true,
  // meta 只认编码器字符串，最省事但漏判多；bitrate 用「字节数/时长」换算有效比特率，
  // 对「有损转 flac」这类最常见的假无损命中率最高，故默认取 bitrate。
  fakeLosslessDetect: "bitrate",
  fakeLosslessMinEffBitrate: 700,
  minDurationSec: 30,
  maxDurationSec: 900,
  durationToleranceSec: 3.0,
  excludeTitleKeywords: ["试听", "铃声", "片段", "DJ版", "串烧", "伴奏", "清唱", "广场舞"],
  preferStudioVersion: true,
  fakeLosslessEncoderHints: ["Lavc", "LAME", "Fraunhofer"],
};
