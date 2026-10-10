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
  /** 码率是否为直链体积预探的估算值（体积×8/目标时长；PATCH15）。 */
  estimated?: boolean;
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
  /** 风格；仅信源 `extra` 显式声明时才填，取不到留 undefined（不臆造）。 */
  genre?: string;
  /** 信源原始附加信息（go-music-dl 的 data-extra 原样透传；其它源可能为空）。
   *  目前承载平台音质阶梯（kugou 的 sq_hash/hq_hash/... 、migu 的 format_type 等），
   *  供 candidates.declaredFromExtra 推「声明档位」，也是 inspect 判不可用后的诊断依据。 */
  extra?: Record<string, string>;
  /** inspect 预探**明确**返回 `{valid:false}` 时为 true（服务端说这一档取不到地址，
   *  例如酷狗 privilege=10 的官方歌、QQ 当前凭据过期的歌）。
   *  这是**正常业务响应，不是失败**：候选保留在列表里但排到最后（声明质量已清空，
   *  避免乐观的 extra 阶梯把它推到最优位）；原始阶梯仍在 `extra` 里可查。 */
  inspectUnavailable?: boolean;
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
  // HTTP_4XX 细分成三个「资源本身不存在」的码（永久失效判定用，见 attempts.ts
  // PERMANENT_FAILURE_CODES）：其余 4xx（401 凭据过期 / 408 请求超时 / 429 限流 /
  // 416 Range 不满足 …）都是可恢复的，仍归 HTTP_4XX 兜底，**绝不参与永久失效计数**。
  | "HTTP_4XX"
  | "HTTP_404" // 资源不存在
  | "HTTP_410" // 资源已下架
  | "HTTP_451" // 因法律原因不可用
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
  // DURATION_MISMATCH：下载到的音频**时长与目标曲目偏差超容差** —— 拿到的是另一个版本
  //   （现场版 / 混音 / 试听），资源本身**存在且完整**，只是不是我们要的那一版。
  //   必须与 INTEGRITY_FAILED（字节残缺 / 文件头不对 / 根本解析不了）严格分开：
  //   前者是「换一版就可能成」，后者才是「源站确实给不出可用文件」。
  //   历史坑（2026-10-11 生产实测）：此前两者共用 INTEGRITY_FAILED，而它在
  //   PERMANENT_FAILURE_CODES 白名单里 → 只是版本时长不同、仍能在线播放的歌会被
  //   当作死链移出曲库（用户侧表现为「歌莫名消失」）。
  | "DURATION_MISMATCH"
  | "ALREADY_IN_LIBRARY" // 本地/WebDAV 已有，按用户要求跳过
  | "COOLDOWN_SKIPPED" // PATCH17 台账冷却：最近试过（无论成败），秒跳
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
  /**
   * 有损最低比特率（kbps）—— 兜底闸，**unknown 档也按此闸卡**（低于 128kbps 的流会被
   * classifyTier 归成 unknown）。缺省 90。
   */
  minBitrateKbps: number;
  /** 最低采样率（Hz） */
  minSampleRateHz: number;
  /** 最高采样率（Hz），超过视为异常/虚标 */
  maxSampleRateHz: number;
  /** 容器白名单，空数组表示不限制 */
  allowedContainers: string[];
  /** 池中存在无损候选时，剔除所有有损候选 */
  preferLossless: boolean;
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
  /**
   * 未压缩无损容器（这些容器要求更高的有效码率，见 `uncompressedMinKbps`）。
   * **默认 [] = 不启用该规则**（既有行为逐字节不变）；只有洗版档（buildUpgradeQuality）才填
   * `["wav","aiff"]`。
   */
  uncompressedContainers: string[];
  /** 未压缩无损容器的最低有效码率（kbps）；仅当容器命中 `uncompressedContainers` 时生效。 */
  uncompressedMinKbps: number;
}

/**
 * 默认质量配置。
 *
 * **缺省 = 兜底 90kbps、不卡档位**（2026-10-10 产品调整）。理由：下载链路已经有两道
 * 「自动变好」的机制 —— ①同一首歌在多源里自动取最高音质；②洗版（把低码率的重新回炉
 * 搜一遍无损）。有了它们，再把硬门槛定在 320kbps 只会适得其反：只找得到 128kbps 源的歌
 * 会被**整首拒收**，连「先拿到手、以后再洗」的机会都没有。
 *
 * 所以缺省放成 `qualityFloor: "any"` + `minBitrateKbps: 90` —— 只挡「明显不能听」的超低
 * 码率，其余先按能力拿到，再靠「取最高」与「洗版」逐步升级。
 * 想要严格门槛的用户仍可在设置页把 qualityFloor 调回 320 / lossless。
 */
export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  qualityFloor: "any",
  minBitrateKbps: 90,
  minSampleRateHz: 44100,
  maxSampleRateHz: 384000,
  allowedContainers: ["flac", "mp3", "m4a", "ogg", "opus", "ape", "wav", "alac", "aiff"],
  preferLossless: true,
  // 「拒绝假无损」开关已删除（产品定调 2026-10-11）：flac 只是容器，不等于无损 ——
  // 档位判定（classifyTier）本就会按有效码率把「有损转 flac」归回真实档位，
  // 于是洗版档（qualityFloor=lossless）照常挡得住，下载档（qualityFloor=any）正常放行。
  // meta 只认编码器字符串，最省事但漏判多；bitrate 用「字节数/时长」换算有效比特率，
  // 对「有损转 flac」这类最常见的假无损命中率最高，故默认取 bitrate。
  fakeLosslessDetect: "bitrate",
  fakeLosslessMinEffBitrate: 700,
  minDurationSec: 30,
  maxDurationSec: 900,
  // 默认 3.0s 过严（2026-10-10 240 实测：Live/重制版与候选动辄差 3s+ → 79/140 全拒 BELOW_BAR）。
  durationToleranceSec: 10.0,
  excludeTitleKeywords: ["试听", "铃声", "片段", "DJ版", "串烧", "伴奏", "清唱", "广场舞"],
  preferStudioVersion: true,
  fakeLosslessEncoderHints: ["Lavc", "LAME", "Fraunhofer"],
  // 默认关闭「未压缩无损更高码率门槛」：空数组 → 不启用，所有既有判定逐字节不变。
  uncompressedContainers: [],
  uncompressedMinKbps: 1400,
};
