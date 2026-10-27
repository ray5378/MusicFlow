// ==================== 下一首预缓冲（后台预热 membuf，2026-10-12） ====================
//
// **要解决的问题**（240 生产实测）：播放队列里下一首若是天翼网盘（`w:` WebDAV 行）或插件在线源
// （`web` 行）的大文件，`/rest/stream` 的整曲内存缓冲要等上游取完才吐第一个字节 —— 实测 3~10s，
// 慢的那首直接撞 18s 硬顶回退直通，客户端首播体验差并触发反代超时。
//
// **做法**：服务端在切歌事件里用 `peekUpcomingPositions` 算出下一首，后台 fire-and-forget 把整曲
// 取进 membuf 并记到 `songId → token` 索引；用户真切过去时 `resolveTranscodeInput` 同步命中，
// 首字节从「等上游」变成「一次 Map 查找」。
//
// ### 三条红线（违反即事故，测试已锁）
//   1. **绝不共用播放路径的 single-flight**。`fetchSongWithRetryWindow` 的 key 是 `song:${songId}`，
//      与正在播的那条共用一个循环 —— 预取若先建循环，播放请求会**继承预取的 cfg**（30 分钟重试窗被
//      改短 / 后台任务被挂 30 分钟）。故这里只用 `fetchWholeSongBuffered`，去重**自己维护**。
//   2. **绝不动播放路径的超时**。放宽（deadline 120s / stall 30s）只发生在后台预取；
//      `STREAM_BUFFER_TOTAL_TIMEOUT_MS=18s` / `STREAM_BUFFER_STALL_MS=10s` 一个字都不改。
//   3. **取流失败全静默**（不 warn、不重试、不抛给调用方、不写任何可播性缓存 —— 那是 PreProbe 的
//      地盘，把「慢」误判成「无源」会冤枉好歌）。
//      ⚠ 唯一例外 = 下面的**完整性判官**：它依据是「整首歌的字节已经抓下来了」这个硬事实，比
//      PreProbe 的在线探测结论更强 —— 文件头是 HTML/JSON 错误页（假成功）、或实际时长比曲库
//      基准短 15s 以上（平台试听片段/截断）。这种歌登记进预取缓存只会害播放器，故判死后写
//      streamFallback 负缓存（复用「无可用源」语义，PreProbe 与播放路径都读它）。
//
// ### 完整性判官（2026-10-12 用户拍板：差值兜底判「试听/截断片段」）
//   网络平台大量歌曲整首只放几十秒试听。判官在 `registerMemStream` **之前**跑，判死即放弃登记：
//     档 1 too-small ：buf < 64KB —— 音频不可能这么小；
//     档 2 magic     ：`sniffMagic` 判非音频 —— 上游把 HTML/JSON 错误页当 200 返回（最常见假成功）；
//     档 3 duration  ：`parseBuffer` 拿实际时长，与曲库基准（`songs.duration`，队列 item 同源）
//                      比，**实际比期望短超过 15s ⇒ 判死**（覆盖 4 分钟给 30 秒、也覆盖给 3 分钟）；
//     档 4 bitrate   ：duration 缺失（ogg 等）时码率×字节推算实际时长，判死线**单独放宽到 80s**
//                      （推算是近似值，VBR/封面/tag 都会偏 —— 宁可漏杀不可误杀）。
//   保守原则：无基准（曲库 duration=0）不杀；magic 认音频但 metadata 解析失败不杀（防冷门容器误杀）。
//   ffmpeg 全解码档（decodable）**不做**：它抓「头对中间坏」，抓不到完整的短文件，还每首几秒 CPU。
//
// ### 组内换源（2026-10-12 用户拍板：判死先换源，全死才跳下一首）
//   判官判死**不直接跳下一首**：候选链 = 解析后首选行 + 同组其他网络源行（WebDAV 行优先
//   于平台 web 行 —— 自己的曲库文件没有「试听片段」问题；上限 PREFETCH_MAX_ALT_SOURCES=3）。
//   逐个抓取 + 判官；通过即登记并**双写索引**（候选 id + 解析后 id —— membuf 存的是**内容**，
//   ffmpeg 不关心字节来自组内哪一行，出流侧解析到哪行都能命中）。
//   每个判死的候选都逐个记无源负缓存；**全部**候选都判死时才把**队列行 id**也标上
//   （judgePlayable/客户端「无可用源」按队列行 id 判跳 —— 不标就变成播 30s 试听片段）。
//   有候选没被评估（取流失败 / 闸门拦下）时不标队列行：知识不完整，不能把未知当死。
//
// ### 五道闸门（进预取前全查）
//   1. 同曲去重（已缓存 / 在途）；
//   2. 全局并发 1（串行排队，不并发 —— 天翼那跳带宽共享，并发只会一起变慢并拖慢正在播的那条）；
//   3. 预算：在途 + 预估 > 全局预算 × 0.5 → 放弃（给正在播的那条留一半）；
//   4. 单曲 > `STREAM_BUFFER_MAX_FILE_MB`(100MB) → 跳过（必然 too-big，白取）；
//   5. 只预取网络源（web 无可用 cachePath / `w:` 行）；`l:` 本地磁盘行不走 membuf，预取无意义。
//
// 一句话：**宁可预取失败，也绝不能让正在播的流变慢或断流。**

import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import { isNetworkSong, resolveNetworkInput } from "./networkInput.js";
import { sniffMagic } from "../fetch/integrity.js";
import { parseBuffer } from "music-metadata";
import {
  bufferedInFlightBytes,
  fetchWholeSongBuffered,
  peekMemStream,
  registerMemStream,
  STREAM_BUFFER_BUDGET_MB,
  STREAM_BUFFER_MAX_FILE_MB,
} from "./bufferedFetch.js";
import { peekUpcomingPositions, type QueuePeekSource } from "../player/preProbeScheduler.js";
import { getPrefetchSettings } from "./prefetchConfig.js";

const log = createLogger("PREFETCH");

const MB = 1024 * 1024;

// ---------------- 配置（模块常量 = **文档默认值**；运行时一律读 settings 表） ----------------
// 2026-10-12 起全部可调项搬到 settings 表（`prefetch.settings`，前端「插件管理 →
// 媒体获取」页即存即生效，见 prefetchConfig.ts）。下面的常量只作默认值与文档，
// 热路径读 getPrefetchSettings()（getSetting 5s 缓存，成本可忽略）。

/** 向前预取几首。1 = 只预取下一首（用户痛点集中在「切到下一首卡」）。 */
export const PREFETCH_LOOKAHEAD = 1;
/** 单次预取的**总取流时长硬顶**（ms）。放宽到 120s：后台跑，用户感知不到。 */
export const PREFETCH_DEADLINE_MS = 120_000;
/** 单次预取的停摆判据（ms）。天翼是「慢但不停」，10s 太激进 —— 它不是停摆，只是慢。 */
export const PREFETCH_STALL_MS = 30_000;
/** 预取并发上限。1 = 串行。 */
export const PREFETCH_CONCURRENCY = 1;
/** 预算闸门系数：在途 + 预估超过 `全局预算 × 本系数` 就放弃本次预取。 */
export const PREFETCH_BUDGET_RATIO = 0.5;
/** 无 size 信息（web 行常为 0）时的预估字节数 —— 取 240 曲库 `w:` 行实测均值 29.3MB。 */
export const PREFETCH_ASSUMED_BYTES = 30 * MB;
/**
 * 组内换源的候选源上限：首选行（解析后）判死后，最多再试几个同组其他网络源。
 * 用户 2026-10-12 拍板「先换源、全不可用才跳下一首」；0 = 关闭换源（旧行为）。
 */
export const PREFETCH_MAX_ALT_SOURCES = 3;
/** 索引条目有效期（与 membuf 未消费条目的 TTL 10min 对齐）。 */
export const PREFETCH_ENTRY_TTL_MS = 10 * 60_000;
/** AbortController 兜底计时器在 deadline 之外的宽限（ms）。 */
const PREFETCH_GUARD_GRACE_MS = 5_000;

// ---------------- 完整性判官配置 ----------------

/**
 * 判死线（秒）：实际时长比曲库基准**短超过这么多** ⇒ 判「试听/截断片段」。
 * 用户 2026-10-12 拍板用差值兜底（不用比例）：既覆盖「4 分钟给 30 秒」，也覆盖
 * 「4 分钟给 3 分钟」这种截一半的。env `PREFETCH_INTEGRITY_DELTA_SEC` 可调。
 */
export const PREFETCH_INTEGRITY_DELTA_SEC = 15;
/** 音频文件的最小合理字节数（低于此高度可疑：真音频不可能这么小）。 */
export const PREFETCH_MIN_AUDIO_BYTES = 64 * 1024;
/**
 * **硬算术下界**用的地板码率（字节/秒），4000 = 32kbps（2026-10-27）。
 * 任何真实音乐流都 ≥32kbps：buf < expectedSec × 4000 时，无论什么编码都装不下
 * expectedSec 秒 ⇒ 「残缺」是**硬结论**而非弱信号，不走「重试一次不记负缓存」
 * 的宽待（那套宽待只配给「装得下、只是这次拿少了」的场景）。取地板值防误杀：
 * 宁可漏过一个 24kbps 的天书，不可误杀正常歌。
 */
export const PREFETCH_HARD_MIN_BYTES_PER_SEC = 4000;
/**
 * **码率推算路径**的判死线（秒），默认 80 —— 比 metadata 真值路径（15s）宽松得多。
 * 用户 2026-10-12 拍板：推算 `actual ≈ bytes*8/bitrate` 是近似值（VBR 文件平均码率
 * ≠ 瞬时码率、大封面/冗余地 tag 也占字节，可超可不足），只在 duration 缺失
 * （ogg 等容器）时兜底 —— 判据松一档，宁可漏过一个截断片段，也不可误杀正常歌。
 * env `PREFETCH_INTEGRITY_DELTA_SEC_BITRATE` 可调。
 */
export const PREFETCH_INTEGRITY_DELTA_SEC_BITRATE = 80;

/**
 * 判官总开关 + 两条判死线。真源在 settings 表(`prefetch.settings`,前端「媒体获取」
 * 页可调,即存即生效);UI 从没保存过时回落 env / 模块默认(见 prefetchConfig.ts)。
 * 本函数保留为兼容导出(tests 与旧调用方沿用)。
 */
export function prefetchIntegrityConfig(): { enabled: boolean; deltaSec: number; bitrateDeltaSec: number } {
  const s = getPrefetchSettings();
  return {
    enabled: s.integrityEnabled,
    deltaSec: s.integrityDeltaSec,
    bitrateDeltaSec: s.integrityBitrateDeltaSec,
  };
}

export interface PrefetchVerdict {
  dead: boolean;
  /** 判死原因（too-small / too-small-hard / not-audio / preview）；放过时为 undefined。 */
  reason?: string;
  /** probe 档拿到的实际时长（秒，能解析出才有）。 */
  actualSec?: number;
  /** 曲库基准时长（秒，>0 才有时长对比档）。 */
  expectedSec?: number;
  /** 实际时长来源：metadata 真值 / 码率推算（两条路径判死线不同，日志可辨）。 */
  via?: "metadata" | "bitrate";
}

/**
 * 对预取到的完整 Buffer 做完整性判定（纯判定，不碰任何缓存/索引，便于测试）。
 *
 * 规则（保守优先 —— 宁可放过一个片段，不可误杀一首冷门格式的好歌）：
 *   1. `sniffMagic(buf)` 判非音频 → dead: not-audio（HTML/JSON 错误页假成功）；
 *      240 实测：平台试听文件是 **M4A/mp4**（fLaC 之外的各种容器 sniffMagic 都认）；
 *      ★ 2026-10-27 起**先判 magic、后判体积**（顺序理由见下方 judgePrefetchedBuffer
 *      函数体注释）：几 KB 的 JSON/HTML 错误页是**硬结论**，不是「弱信号 too-small」。
 *   2. `buf.length < PREFETCH_MIN_AUDIO_BYTES` → dead: too-small（**弱信号**，
 *      2026-10-21 策略：只重试一次、不写负缓存，见下方 tooSmallRetry 注释）；
 *      ★ 2026-10-27 起先过一道**硬算术下界**：`buf < expectedSec × 4000`（32kbps
 *      地板，装不下期望时长）⇒ dead: too-small-hard，照常记负缓存 —— 残缺是硬
 *      结论，宽待只配给「装得下、只是这次拿少了」的场景（fetch 层截断对账的
 *      chunked 兜底，见 bufferedFetch.ts TRUNCATION_TOLERANCE）；
 *   3. 基准 <= 0（曲库无 duration）→ 放过（没有参考答案，只靠绝对阈值会误杀真短歌）；
 *   4. `parseBuffer` 解析失败 → 放过（magic 已认它是音频容器；冷门容器/怪 metadata 不杀）；
 *   5. 能解析出时长且 `expected - actual > deltaSec` → dead: preview；
 *   6. **解析不出时长但有码率** → 码率推算兜底 `actual ≈ bytes*8/bitrate`（240 实测：
 *      ogg Buffer 模式 duration=undefined，但 640kbps×20.31MB ⇒ 253s 成功抓出截断；
 *      mp3 128kbps×5.04MB=330s 与 music-metadata 真值完全吻合 —— 推算可信）。
 *      ⚠ 推算是近似值（VBR/封面/tag 都会让字节≠时长×码率）⇒ 该路径判死线**单独放宽
 *      到 80s**（`PREFETCH_INTEGRITY_DELTA_SEC_BITRATE`，用户 2026-10-12 拍板），
 *      宁可漏杀不可误杀。
 *      240 实测样例（泪海-许茹芸，基准 298s）：汽水音乐源 = 0.89MB M4A，
 *      duration=29.0017s、256kbps —— 差值 269s ⇒ 必判死。
 */
export async function judgePrefetchedBuffer(buf: Buffer, expectedSec: number): Promise<PrefetchVerdict> {
  const base: PrefetchVerdict = dead0(expectedSec);
  // ==================== 判据顺序（2026-10-27 240 生产缺陷修复）====================
  //
  // **magic 必须先于 too-small**。原顺序是 too-small 在前，于是插件源（web/汽水音乐）
  // 回的那几 KB JSON/HTML 错误页先撞上 `<64KB`，被归类成「弱信号 too-small」——
  // 按 2026-10-21 的策略（见下方 tooSmallRetry）**只重试一次、不写负缓存**，等于放行；
  // 播放侧随后照播这段假成功内容，整首歌的「无源」结论永远建立不起来。
  //
  // 两个判据的**证据强度不同**，所以不能合并、也不能颠倒：
  //   · `sniffMagic` 判非音频 = **硬结论**。文件头既不是任何已知音频容器（flac/ogg/
  //     mp3/ape/wav/aiff/mp4），也不是裸帧同步字，而是 `<` / `{` / `[` 开头的文本
  //     （或彻底认不出的字节）—— 这份字节**不可能是音频**，与「字节少」无关：
  //     哪怕上游给了 10MB 的 HTML 错误页，它照样不是音频。故直接 `not-audio` →
  //     调用方 `markUnplayable()` 记负缓存 → 出流侧换源 / 队列判跳。
  //   · `<64KB` 只是**弱信号**。「这次拿到的字节太少」既可能是错误页，也可能是
  //     上游一次截断（240 实测同一首预取两次 <64KB，几分钟后播放路径整曲缓冲
  //     1.93MB 成功）。所以它必须留在 magic **之后**：真错误页已被上一档摘走，
  //     能走到这里的「音频头 + 字节少」才配得上「重试一次、不记负缓存」的宽待。
  //
  // 这也是 2026-10-21 那条策略（重试一次 / 不记负缓存）的**前提**：它的适用面被
  // magic 收窄到「确实是音频、只是这次拿少了」，而不是「任何小响应」。
  const sniff = sniffMagic(buf);
  if (!sniff.audio) {
    return { ...base, dead: true, reason: "not-audio" };
  }
  if (buf.length < prefetchMinAudioBytes()) {
    // ★ 硬算术下界（2026-10-27，《纵身一跃》事故补刀）：期望时长连地板码率都装不下
    //   ⇒ 必然残缺，不是「弱信号」。fetch 层对账只拦「有 content-length」的截断，
    //   chunked 响应（无 cl）提前断流时会漏到这里 —— 用 32kbps 地板一算便知。
    //   命中即走 markUnplayable 记负缓存（调用方对非 "too-small" 的 reason 一律判死），
    //   不再享受「重试一次、不记负缓存」的宽待。expectedSec<=0 无从算起，保持弱信号。
    if (expectedSec > 0 && buf.length < expectedSec * PREFETCH_HARD_MIN_BYTES_PER_SEC) {
      return { ...base, dead: true, reason: "too-small-hard" };
    }
    return { ...base, dead: true, reason: "too-small" };
  }
  if (!(expectedSec > 0)) return base;
  let actualSec: number | undefined;
  let via: "metadata" | "bitrate" | undefined;
  try {
    const meta = await parseBuffer(buf, { duration: true } as any);
    const f: any = meta?.format;
    const d = f?.duration;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) {
      actualSec = d;
      via = "metadata";
    } else if (typeof f?.bitrate === "number" && f.bitrate > 0) {
      // 规则 6：duration 缺失（ogg 等）时用码率×字节推算（单位：bit → 秒）。
      actualSec = (buf.length * 8) / f.bitrate;
      via = "bitrate";
    }
  } catch {
    // magic 说是音频但 metadata 解析不出：冷门容器/怪 tag，保守放过（见规则 4）。
    return base;
  }
  if (actualSec === undefined) return base;
  const icfg = prefetchIntegrityConfig();
  // 码率推算是近似值 ⇒ 判死线放宽到 80s（防误杀）；metadata 真值路径仍 15s。
  const deltaSec = via === "bitrate" ? icfg.bitrateDeltaSec : icfg.deltaSec;
  if (expectedSec - actualSec > deltaSec) {
    return { ...base, dead: true, reason: "preview", actualSec, via };
  }
  return via ? { ...base, via } : base;
}

function dead0(expectedSec: number): PrefetchVerdict {
  return expectedSec > 0 ? { dead: false, expectedSec } : { dead: false };
}

/**
 * 全局并发缓冲预算(字节)。优先读 env `STREAM_BUFFER_BUDGET_MB`(与 bufferedFetch 同一把尺子),
 * 没设才用模块常量 —— 运维调预算时预取闸门跟着一起变,不会各按一套算。
 */
function prefetchBudgetBytes(): number {
  const n = Number(process.env.STREAM_BUFFER_BUDGET_MB);
  return (Number.isFinite(n) && n > 0 ? Math.floor(n) : STREAM_BUFFER_BUDGET_MB) * MB;
}

/** 单文件上限(字节),同读 env `STREAM_BUFFER_MAX_MB`。 */
function prefetchMaxFileBytes(): number {
  const n = Number(process.env.STREAM_BUFFER_MAX_MB);
  return (Number.isFinite(n) && n > 0 ? Math.floor(n) : STREAM_BUFFER_MAX_FILE_MB) * MB;
}

// ---------------- 运行时配置(settings 表,前端「媒体获取」页可调,即存即生效) ----------------
// 真源在 prefetchConfig.ts;下面的 getter 只是把秒/KB 换算成本模块使用的毫秒/字节。
// 模块常量(如 PREFETCH_DEADLINE_MS)降级为**文档默认值**,运行时一律读 settings。

function prefetchDeadlineMs(): number {
  return getPrefetchSettings().deadlineSec * 1000;
}
function prefetchStallMs(): number {
  return getPrefetchSettings().stallSec * 1000;
}
function prefetchBudgetRatio(): number {
  return getPrefetchSettings().budgetRatio;
}
function prefetchConcurrency(): number {
  return getPrefetchSettings().concurrency;
}
function prefetchEntryTtlMs(): number {
  return getPrefetchSettings().entryTtlSec * 1000;
}
function prefetchLookahead(): number {
  return getPrefetchSettings().lookahead;
}
function prefetchMaxAltSources(): number {
  return getPrefetchSettings().maxAltSources;
}
function prefetchMinAudioBytes(): number {
  return getPrefetchSettings().minAudioKB * 1024;
}

// ---------------- 索引 ----------------

interface PrefetchEntry {
  token: string;
  /** 登记时算好的 membuf 回环 URL（`/rest/membuf/:token`）。 */
  url: string;
  bytes: number;
  at: number;
}

/** 解析后的 songId（= 出流侧实际用的 key）→ membuf 条目。
 *  只记**预取**产生的条目（播放路径的条目不进这里，避免互相污染）。
 *  ⚠ key 是 `resolvePreferredSong(row).id`，**不是**队列行 id —— 出流侧
 *  `resolveTranscodeInput` 拿到的就是解析后的行，`prefetchHit(song?.id)` 查的也是它。 */
const bySong = new Map<string, PrefetchEntry>();
/** 队列行 id → 解析后 id 的别名。去重仍按**队列行 id** 走，索引登记在**解析后 id** 上：
 *  同曲多源组里，队列行可能是 web 行、实际出流却是组内 local/webdav 兄弟行。 */
const alias = new Map<string, string>();
/** 同曲去重（自己维护，不与播放共用 —— 见文件头红线 1）。 */
const inflight = new Map<string, Promise<void>>();
/** 解析后 songId → 在途预取的落地 promise（冷播放搭车用，2026-10-13）。
 *  与 inflight（按队列行 id）分开记：播放路径 bufferNetworkSource 拿到的是
 *  **解析后** id（resolvePreferredSong 之后），两边才能对上。 */
const inflightByResolved = new Map<string, Promise<void>>();
/** 并发闸门后的等待队列（FIFO）。 */
const queued: string[] = [];
let running = 0;

/** `loopbackBase` 的引用。由出流模块在加载时 bind，或首次预取时惰性取。 */
let loopbackBaseRef: (() => string) | null = null;

/** 出流模块（routes/rest/index.ts）在模块加载时把自己用的 `loopbackBase` 交出来。 */
export function bindLoopbackBase(fn: () => string): void {
  loopbackBaseRef = fn;
}

async function ensureLoopbackBase(): Promise<void> {
  if (loopbackBaseRef) return;
  try {
    const m = await import("../dlna/control.js");
    loopbackBaseRef = m.loopbackBase;
  } catch {
    /* 取不到就退回「只认 token」，由调用方自行拼 URL */
  }
}

// ---------------- 查询（出流侧热路径，同步，纳秒级） ----------------

/** 该 songId 是否有**仍存活**的预取条目；返回 membuf token，没有 → null。
 *  不写 `lastReadAt`（不把预取条目标记成「已消费」，否则会被 120s 空闲回收提前清掉）。 */
export function prefetchToken(songId: string): string | null {
  if (!songId) return null;
  const e = bySong.get(songId);
  if (!e) return null;
  if (Date.now() - e.at > prefetchEntryTtlMs()) {
    bySong.delete(songId);
    dropAliasesFor(songId);
    return null;
  }
  // 条目可能已被 sweepMemStreams 回收（TTL / 总字节上限）→ 索引同步失效。
  if (!peekMemStream(e.token)) {
    bySong.delete(songId);
    dropAliasesFor(songId);
    return null;
  }
  return e.token;
}

/** 出流侧唯一入口：命中则返回 membuf 回环 URL，未命中返回 null。 */
export function prefetchHit(songId: string): string | null {
  const t = prefetchToken(songId);
  if (!t || !loopbackBaseRef) return null;
  return `${loopbackBaseRef()}/rest/membuf/${t}`;
}

// ---------------- 触发 ----------------

/** 该队列行 id 的「解析后 id」是否已有存活条目（= 去重命中）。 */
function aliasLive(queueId: string): boolean {
  const resolved = alias.get(queueId);
  return !!resolved && bySong.has(resolved);
}

/** 清掉所有指向该解析后 id 的别名，避免条目死后留下悬空别名。 */
function dropAliasesFor(resolvedId: string): void {
  for (const [q, r] of alias) {
    if (r === resolvedId) alias.delete(q);
  }
}

/**
 * 预取一首（幂等）。fire-and-forget 用；返回的 promise 仅供测试等待。
 * 命中任一闸门 → 立即 resolve，不产生任何副作用。
 * **入参是队列行 id**；索引实际登记在 `resolvePreferredSong` 之后的 id 上（见 doPrefetch）。
 */
export function prefetchSong(songId: string): Promise<void> {
  if (!songId) return Promise.resolve();
  if (aliasLive(songId)) return Promise.resolve(); // 闸门 1（已缓存）
  const pending = inflight.get(songId);
  if (pending) return pending; // 闸门 1（在途）
  if (running >= prefetchConcurrency()) {
    // 闸门 2：串行排队（不并发）。
    if (!queued.includes(songId)) queued.push(songId);
    return Promise.resolve();
  }
  const p = runOne(songId);
  inflight.set(songId, p);
  return p;
}

/**
 * 队列变动后预取前方 N 首（fire-and-forget）。
 * **「下一首是谁」一律由 `peekUpcomingPositions` 算**（四种 playMode 全覆盖、只读不改状态）。
 * `n` 省略时取运行时配置（settings `lookahead`，前端「媒体获取」页可调）。
 */
export function prefetchUpcoming(peek: QueuePeekSource | undefined, n?: number): void {
  if (!peek) return;
  const count = n ?? prefetchLookahead();
  if (count <= 0) return;
  try {
    const { positions } = peekUpcomingPositions(peek, count);
    for (const p of positions.slice(0, count)) {
      const songId = peek.items?.[p]?.songId;
      if (songId) void prefetchSong(songId);
    }
  } catch (e: any) {
    // 预取绝不能影响调用方（localSetIndex / 切歌推进）。
    log.debug(`预取排程异常（已忽略）: ${String(e?.message || e).slice(0, 120)}`);
  }
}

async function runOne(songId: string): Promise<void> {
  running++;
  try {
    await doPrefetch(songId);
  } catch (e: any) {
    log.debug(`[prefetch] ${songId} 异常（已忽略）: ${String(e?.message || e).slice(0, 160)}`);
  } finally {
    running--;
    inflight.delete(songId);
    drain();
  }
}

function drain(): void {
  while (running < prefetchConcurrency() && queued.length > 0) {
    const next = queued.shift();
    if (!next) break;
    if (aliasLive(next) || inflight.has(next)) continue;
    const p = runOne(next);
    inflight.set(next, p);
  }
}

async function doPrefetch(songId: string): Promise<void> {
  if (aliasLive(songId)) return; // 闸门 1（排队期间可能已被填上）
  const row = db.select().from(songs).where(eq(songs.id, songId)).get() as any;
  if (!row) return;

  // 出流侧（/rest/stream、cast、flow 三处）都先过 resolvePreferredSong —— 预取必须登记在
  // **解析后**的 id 上。否则「队列行是 webId、实际出流是组内 localId」时，
  // 出流查 prefetchHit(resolvedId) 必然 miss（240 实测：83dc3a9b 预取、fa623669 出流）。
  // 惰性 import：preferredSource 会拉进 playPreference / localSourceProbe，
  // 静态 import 可能引出循环依赖（参照 networkInput 对 streamFallback 的 await import 写法）。
  const { resolvePreferredSong } = await import("./preferredSource.js");
  const resolved: any = await resolvePreferredSong(row);
  const resolvedId: string = resolved?.id ?? songId;

  // 解析后去重：同一个 resolvedId 可能被多个队列行映射（组内多个 web 兄弟行）。
  if (bySong.has(resolvedId)) {
    alias.set(songId, resolvedId);
    return;
  }

  // 闸门 5：只预取网络源（`l:` 本地磁盘行不走 membuf，预取纯浪费）—— 用**解析后**的行判。
  if (!(await isNetworkSong(resolved))) return;

  // ---- 候选源链（组内换源，2026-10-12 用户拍板）----
  // 首选行判死后**不直接跳下一首**：同曲多源组里其他网络源可能完整可播（平台 A 只给
  // 30s 试听、平台 B 给全曲是常态 —— 240 实测泪海-许茹芸：汽水 29s 片段、酷狗 404）。
  // 候选链 = 解析后的首选行 + 同组其他网络源行（WebDAV 行优先于平台 web 行：
  // 自己的曲库文件没有「试听片段」问题），逐个抓取 + 判官，通过即登记。
  const candidates = await listPrefetchCandidates(resolved, resolvedId);

  // 闸门 3：预算 —— 给正在播的那条留一半（在途字节是**全局**记账，预取也占）。
  const budgetBytes = prefetchBudgetBytes();
  const icfg = prefetchIntegrityConfig();
  // 判官开时才惰性 import streamFallback（会拉进 registry/plugins，静态引入有环风险；
  // networkInput 对同一模块也是惰性 import，模式已验证）。
  // ⚠ 相对基准是本文件（src/services/source/）—— online 在 source **下面**，是 ./ 不是 ../
  const sf = icfg.enabled ? await import("./online/streamFallback.js") : null;
  await ensureLoopbackBase();

  // ---- 冷播放搭车登记（2026-10-13）----
  // 播放路径（bufferNetworkSource）发现同一首有预取正在飞时，不起第二份下载，
  // 等这一份落地（有界，见 index.ts）。只在**确定要下了**之后登记（五道闸门全过、
  // 候选链已算出）—— 排队中 / 被闸门拦下的场景等它没有意义，那些走冷路径。
  // 判官判死（试听片段）时本 promise 照常 settle，播放侧拿到「没落地」落冷路径，
  // 此时负缓存已被判官写上，冷路径选源/跳过行为与今天一致（且不双份下载）。
  let settleJoin: () => void = () => {};
  const joinP = new Promise<void>((r) => { settleJoin = r; });
  inflightByResolved.set(resolvedId, joinP);

  // 自带 AbortController + 兜底计时器：预取没人会 abort 它，不能泄漏。
  const ctrl = new AbortController();
  const guard = setTimeout(() => ctrl.abort(), prefetchDeadlineMs() + PREFETCH_GUARD_GRACE_MS);
  // 真拿到完整字节并过了判官的候选（按 id 去重：too-small 的候选会被重试一次，
  // 不能用自增计数，否则「全候选判死」的判断会算重）。
  const evaluatedIds = new Set<string>();
  const deadIds = new Set<string>();
  /**
   * too-small 重试队列（2026-10-21 用户拍板）。
   *
   * 判据背景：too-small（<64KB）几乎都是**上游一次截断/错误页**，不是「这首歌只有
   * 试听片段」—— 240 实测同一首预取拿到 <64KB，几分钟后播放路径整曲缓冲 1.93MB
   * 成功。此前直接 `markUnplayable`（TTL 5 分钟）会让 `QueueController.judgePlayable`
   * 把整首歌判跳，正是「一直跳下一首」的放大器。
   *
   * 现在的顺序：主链先把**同曲其他源**全部试完（真正的换源），都没成才回到这里
   * 把 too-small 的候选**再抓一次**；重试仍 too-small **也不写负缓存**（弱信号，
   * 交给播放侧 probe 用 404/403 做硬判定），避免一次上游截断把整首歌判跳。
   */
  const tooSmallRetry: any[] = [];

  /** 抓一个候选并判定/登记。ok = 已登记；dead = 内容判死；toosmall = 可重试；skip = 闸门/取流失败。 */
  const attempt = async (cand: any): Promise<"ok" | "dead" | "toosmall" | "skip"> => {
    // 闸门 4：超单文件上限必然 too-big，白取一趟（每个候选各判一次）。
    const csize = typeof cand.size === "number" && cand.size > 0 ? cand.size : 0;
    if (csize > prefetchMaxFileBytes()) return "skip";
    // 闸门 3（候选循环内复判：在途字节会随抓取增长）。
    const estimate = csize > 0 ? csize : PREFETCH_ASSUMED_BYTES;
    if (bufferedInFlightBytes() + estimate > budgetBytes * prefetchBudgetRatio()) {
      log.debug(`[prefetch] ${songId} 预算闸门拦下 cand=${cand.id} inFlight=${bufferedInFlightBytes()} est=${estimate}`);
      return "skip";
    }
    // 与出流**共用同一份** URL 推导（见 networkInput.ts）—— 喂候选行。
    const net = await resolveNetworkInput(cand);
    if (!net) return "skip";
    const r = await fetchWholeSongBuffered(net.url, net.headers, {
      signal: ctrl.signal,
      retries: 0,
      deadlineMs: prefetchDeadlineMs(),
      stallMs: prefetchStallMs(),
    });
    if (!r.ok) {
      // 静默：kind 不写任何可播性缓存（那是 PreProbe 的地盘）。
      log.debug(`[prefetch] ${songId} cand=${cand.id} 未成 kind=${r.kind}${r.err ? ` err=${r.err}` : ""}`);
      return "skip";
    }
    // ---- 完整性判官（红线 3 的唯一例外，理由见文件头）----
    // 依据是「整首字节已在手里」这个硬事实：判死 ⇒ 不登记 + 记无源负缓存 + 换下一个候选。
    if (icfg.enabled) {
      const expectedSec = candidateDurationSec(cand, row);
      const verdict = await judgePrefetchedBuffer(r.buf, expectedSec);
      if (verdict.dead) {
        evaluatedIds.add(cand.id);
        const act = verdict.actualSec !== undefined ? ` 实际${Math.round(verdict.actualSec)}s` : "";
        const exp = verdict.expectedSec !== undefined ? ` 期望${Math.round(verdict.expectedSec)}s` : "";
        if (verdict.reason === "too-small") {
          // 先不判死、不写负缓存：主链走完其他源后再重试一次（见 tooSmallRetry）。
          log.info(
            `[prefetch] ${songId} cand=${cand.id} 判 too-small${act}${exp} ⇒ 暂不记负缓存（稍后重试一次）`,
          );
          return "toosmall";
        }
        deadIds.add(cand.id);
        sf?.markUnplayable(cand.id); // 逐个记：出流侧换源/探测/判跳都读这份负缓存
        log.info(
          `[prefetch] ${songId} cand=${cand.id} 完整性判死 reason=${verdict.reason}${act}${exp}` +
            ` ⇒ 记无源负缓存（不登记预取）`,
        );
        return "dead";
      }
      evaluatedIds.add(cand.id);
    }
    const token = registerMemStream(r.buf, undefined, { songId: resolvedId, prefetched: true });
    // 驱逐不掉（全是正在消费的在用条目）→ 放弃登记，绝不踢正在播的那条。
    if (!token) {
      log.debug(`[prefetch] ${songId} cand=${cand.id} 注册表无空位，放弃登记（不驱逐在用条目）`);
      return "skip";
    }
    if (!loopbackBaseRef) {
      log.debug(`[prefetch] ${songId} cand=${cand.id} 取不到 loopbackBase，放弃索引`);
      return "skip";
    }
    const entry: PrefetchEntry = {
      token,
      url: `${loopbackBaseRef()}/rest/membuf/${token}`,
      bytes: r.bytes,
      at: Date.now(),
    };
    // 双写：候选 id + 解析后 id。出流侧 resolvePreferredSong 永远解析到 resolvedId，
    // 而 membuf 里存的是**内容**（ffmpeg 不关心字节来自组内哪一行）⇒ 两个 key 同指一条。
    bySong.set(cand.id, entry);
    if (cand.id !== resolvedId) {
      bySong.set(resolvedId, entry);
      log.info(`[prefetch] ${songId} 换源成功：首选 ${resolvedId} 不可用，改用组内候选 ${cand.id}`);
    }
    alias.set(songId, resolvedId);
    // ★ 2026-10-21：整曲字节已完整拿到 = 这首歌**确实可播**的硬证据 —— 主动失效
    //   此前写下的负缓存。只清**这份内容实际来自的行**(cand) 与**队列行**
    //   (judgePlayable 的判跳键)；不要清 resolvedId —— 它可能是刚被判死的兄弟源，
    //   清掉会让下一轮预取/探测重复去试一个已知坏的源。
    const { evictStreamFallbackCache } = await import("./online/streamFallback.js");
    evictStreamFallbackCache(cand.id);
    if (songId !== cand.id) evictStreamFallbackCache(songId);
    log.info(`[prefetch] ${songId} → ${resolvedId} 预取完成 ${r.bytes}B/${Math.round(r.ms)}ms → 切过去即零上游`);
    return "ok";
  };
  try {
    // 第一轮：候选链按原顺序（首选 + 组内其他网络源），too-small 先挂起。
    for (const cand of candidates) {
      const out = await attempt(cand);
      if (out === "ok") return;
      if (out === "toosmall") tooSmallRetry.push(cand);
    }
    // 第二轮：其他源都没成，too-small 的候选再抓一次（只此一次）。
    for (const cand of tooSmallRetry) {
      const out = await attempt(cand);
      if (out === "ok") return;
      if (out === "dead") {
        deadIds.add(cand.id);
        sf?.markUnplayable(cand.id);
        log.info(`[prefetch] ${songId} cand=${cand.id} 重试判死 ⇒ 记无源负缓存`);
      } else if (out === "toosmall") {
        // ★ 重试仍 too-small **不写负缓存**（2026-10-21）：它只是「这次拿到的字节
        //   太小」这一个弱信号 —— 240 实测同一首预取两次 <64KB、播放路径几分钟后
        //   整曲缓冲 1.93MB 成功。写 5 分钟「无源」会让 judgePlayable 直接判跳，
        //   正是「一直跳下一首」的放大器。真死假死交给播放侧 probe(404/403 才是硬证据)。
        log.info(`[prefetch] ${songId} cand=${cand.id} 重试仍 too-small ⇒ 不记负缓存（弱信号，交给播放侧探测）`);
      }
    }
    // 全候选都判死（每个候选都真拿到了完整字节且都判死）⇒ 把**队列行 id** 也标上。
    // judgePlayable/客户端「无可用源」判定按**队列行 id** 查（QueueController.judgePlayable），
    // 不标这一条的后果是播 30s 试听片段而不是跳下一首。有候选没被评估（取流失败/
    // 闸门拦下）时不标 —— 知识不完整，不能把「未知」当「死」（红线同 streamFallback 2026-09-11）。
    if (deadIds.size > 0 && deadIds.size === evaluatedIds.size && evaluatedIds.size === candidates.length && songId !== resolvedId) {
      sf?.markUnplayable(songId);
      log.info(`[prefetch] ${songId} 全部 ${candidates.length} 个候选源均判死 ⇒ 记队列行负缓存（跳下一首）`);
    }
  } finally {
    clearTimeout(guard);
    inflightByResolved.delete(resolvedId);
    settleJoin();
  }
}

/**
 * 组内换源的候选链：首选行（解析后）打头，随后是同 groupId 的其他行。
 * 排序：WebDAV 行（path `w:`）优先于平台 web 行（自己的曲库文件没有试听片段问题）；
 * 只收**网络源**（本地直读行不走 membuf，且它真能播时出流侧自己会优选到它）。
 * 无 groupId / 查询失败 / 上限为 0 ⇒ 只有首选行（行为与换源前完全一致）。
 */
async function listPrefetchCandidates(resolved: any, resolvedId: string): Promise<any[]> {
  const out: any[] = [resolved];
  const gid = resolved?.groupId;
  if (!gid || prefetchMaxAltSources() <= 0) return out;
  try {
    const sibs = db.select().from(songs).where(eq(songs.groupId, gid)).all() as any[];
    const seen = new Set<string>([resolvedId]);
    const ranked = sibs
      .filter((s) => !!s?.id && !seen.has(s.id))
      .sort((a, b) => webdavRank(a) - webdavRank(b));
    let added = 0;
    for (const s of ranked) {
      if (added >= prefetchMaxAltSources()) break;
      seen.add(s.id);
      if (!(await isNetworkSong(s))) continue;
      out.push(s);
      added++;
    }
  } catch {
    /* 查询失败 ⇒ 只用首选行,行为安全 */
  }
  return out;
}

/** WebDAV 行排在前（0），平台 web 行排后（1）。 */
function webdavRank(s: any): number {
  return String(s?.path || "").startsWith("w:") ? 0 : 1;
}

/** 候选行的时长基准：候选自身 duration 优先，缺省回退队列行（同曲多源组两行时长应一致）。 */
function candidateDurationSec(cand: any, queueRow: any): number {
  for (const r of [cand, queueRow]) {
    const d = typeof r?.duration === "number" && r.duration > 0 ? r.duration : 0;
    if (d > 0) return d;
  }
  return 0;
}

// ---------------- 测试用 ----------------

/** 清空全部预取内存状态。 */
export function resetPrefetchForTest(): void {
  bySong.clear();
  alias.clear();
  inflight.clear();
  inflightByResolved.clear();
  queued.length = 0;
  running = 0;
}

/** 观测用：当前索引条目数 / 在途数 / 排队数。 */
export function prefetchStats(): { cached: number; inflight: number; queued: number; running: number } {
  return { cached: bySong.size, inflight: inflight.size, queued: queued.length, running };
}

/** 观测用：别名表（队列行 id → 解析后 id）快照。用于断言「条目回收后别名不悬空」。 */
export function prefetchAliasesForTest(): Array<[string, string]> {
  return [...alias.entries()];
}

/**
 * 冷播放搭车入口（routes/rest/index.ts 的 bufferNetworkSource 用）：该**解析后
 * songId** 是否有**正在下载**的预取。返回其落地 promise（landed-or-failed，
 * 不 reject；落地后 `prefetchHit` 即可命中）；没有（未触发 / 排队中 / 已结束 /
 * 闸门拦下）⇒ null，调用方走既有冷路径。
 *
 * 语义边界（与文件头红线 1 对齐）：本函数只让播放**等待同一份在途下载**，
 * 绝不把预取拉进播放路径的 single-flight（`song:${songId}` 重试表保持为空，
 * 既有守卫 retryLoopKeysForTest 不变）。
 */
export function prefetchInFlight(songId: string): Promise<void> | null {
  if (!songId) return null;
  return inflightByResolved.get(songId) ?? null;
}
