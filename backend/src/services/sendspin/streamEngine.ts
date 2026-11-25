// ==================== Sendspin 推流引擎(组时间线泵) ====================
//
// 真实音频链路:解析歌曲可播流 → ffmpeg 解码为 F32/48k 立体声 → 按组时间线切帧 →
// SendspinGroup.pushFrame(对每个成员独立编码 opus/flac/pcm 后下发)。同步维护
// group.positionMs 与 group.current,供 QueueController 的 pollState/自动切歌判定。
//
// 事件调度:按真实时间推进(每 ~100ms 一帧)。这是服务器权威播放的关键 ——
//   - pollAllDevices(QueueController 每 5s)上报 PLAYING/position,PlaybackTracker
//     据此记录 lastPlaying 并关闭乐观窗口;
//   - 帧推完(自然结束)时置空 group.current → 下一次 poll 上报 IDLE →
//     PlaybackTracker 看到 lastPlaying(PLAYING)→IDLE 判定"自然结束" → auto-advance。
//   - 若不按真实时间推进而是瞬间推完,首帧 poll 很可能先于乐观窗口(5s)错过
//     PLAYING,idle 又无 lastPlaying → 既不 advance 也不 stalled,队列卡死。
//     (DLNA 靠设备 GENA 秒级确认,无需此节奏;Sendspin 无设备回调,靠本节奏自洽。)
//
// 通过 SENDSPIN_PUSH_SPEED(>0)可加快推流节奏(纯测试/演示用,默认 1 = 实时)。
//
// 通过 overridePumpSource 可注入测试音源(真实本地 WAV),默认走
// ensurePlayableStream 解析真实网络曲源。

import {
  BRIDGE_CONTINUITY_ANCHOR_ENABLED,
  BRIDGE_CONTINUITY_MAX_WAIT_US,
  BRIDGE_CONTINUITY_MIXED_ENABLED,
  BRIDGE_CONTINUITY_STALE_US,
  BRIDGE_LEAD_TIERED,
  BRIDGE_PUSH_FLOOR_US,
  BRIDGE_PUSH_TICK_MS,
  BRIDGE_TRACK_KEEP_QUEUE_ENABLED,
  PREFILL_BUFFER_MAX_MS,
  PREFILL_BUFFER_MIN_MS,
} from "./constants.js";
import { paceBumpBus } from "./paceBumpBus.js";
import { streamToContentSec } from "../player/playbackSpeed.js";
// S7 消费驱动产出：上限常量复用 contentDemand 的 30s（对齐 MA
// _PRODUCER_BUFFER_LIMIT_US），不新增第二个 30s。contentDemand 零依赖 ⇒ 无环。
import { PUMP_LOOKAHEAD_DEFAULT_US } from "./contentDemand.js";

/** [2026-11-25 11:57 恢复 MA 的 cold 预热档] 进程内**第一次**泵起播按 cold（4.5s），
 *  之后（切歌/reseed/换歌）按 warm（2.5s）。
 *  背景：原实现 `bridgeStartLeadUs([{ warm: BRIDGE_LEAD_TIERED }])` 恒传 true
 *  ⇒ cold 4.5s 从未生效（注释自述「停用冷档，统一暖档」，为把 rehost 首帧
 *  从 4.5s 提前到 2.75s）。代价正是用户实测的问题：设备冷态渲染延迟尚未进入
 *  稳态就开播 ⇒ 成员延迟补偿建立在错误相位上 ⇒ 起播偏、切歌后（设备已热）才正常。
 *  MA sendspin_bridge.py:98-99 保留 warm 2.5 / cold 4.5 两档，cold 就是预热。 */
let bridgeColdLeadPending = true;

import { SAMPLE_RATE, CHANNELS } from "./encoding.js";
import { nowUs } from "./clock.js";
import { PcmWindow, WindowEvictedError, WINDOW_HIGH_SEC, type WindowSource } from "./streamSource.js";
import { recordSendspinDebug, refreshSendspinDebugEnabled } from "./debugLog.js";
import type { SendspinServer, SendspinGroup } from "./server.js";
import { bridgeStartLeadUs, capEndDrainMs } from "../airplay/bridgeMath.js";
import { ANCHOR_SAFE_LEAD_US } from "../airplay/rates.js";
import { createLogger } from "../../utils/logger.js";
import { ap2TruncateMissingSec } from "../source/prefetchConfig.js";
import { readBridgePrefetchConfig } from "./bridgePrefetchConfig.js";

const log = createLogger("Sendspin");

export interface GroupAudio {
  pcm: Float32Array;
  durationMs: number;
  /** 流式窗口(阶段二):有则走窗口取数,无则走整包 pcm。announce/测试保持整包。 */
  stream?: PcmWindow | null;
  /** 本轮**实际用来出流**的源行 id(裁决结果,可能已被「播放优选」换成组内兄弟行)。
   *  由 `GroupPump` 记账,同曲 seek 重建时作为 `preferRowId` 传回解析器以跳过优选
   *  (见 ResolvePlayableRowOpts)。注入音源(测试)不返回时视为「无记录」。 */
  sourceRowId?: string;
}

/** 插件配置重读缓存间隔(5s):「解码窗口上限」等配置的最大生效延迟。 */
const STREAM_SOURCE_CACHE_MS = 5000;

// ---------------- 判死跨进程回传(2026-10-28 240 生产事故) ----------------
//
// 事故:`stream-truncated`(提前 EOF 判死)发生在 **Sendspin 子进程**,而 `markUnplayable`
// 写的 `streamFallback` 负缓存是 module-local Map —— 子进程只改自己那份,主进程完全看不见。
// 后果:子进程 18:28:22 已判死,主进程 18:28:46 重播时 `judgePlayable` 仍读到 unknown ⇒
// 又把 60s 试听片段播了一遍(要等 18:29:06 主进程自己的预取判死才跳过)。
//
// 修法:子进程判死这一拍**同时**把事实上报主进程(IPC 事件 songUnplayable),由主进程
// supervisor 分发后自己写负缓存。
//
// 回传口挂在 GroupPump 实例上(`onUnplayable`),经 `pumpFor(_, _, sink)` 装填 —— 与
// playCore 的 `bridge?` 同款范式:可选参数 + 默认空,旧调用方零变化。泵实例在组内复用
// (WeakMap 池)且 rehost/移交搬运的是同一个对象,回传口随泵一起走。
export type SongUnplayableSink = (songId: string, reason: string) => void;

let windowSecCache: { value: number; at: number } | null = null;

/** 读插件配置的「解码窗口上限」(秒;5s 缓存)。
 *  读不到(子进程/单测)时回落缺省 30s(用户拍板 2026-10-08)。 */
async function readStreamWindowSeconds(): Promise<number> {
  const now = Date.now();
  if (windowSecCache && now - windowSecCache.at < STREAM_SOURCE_CACHE_MS) {
    return windowSecCache.value;
  }
  let value = WINDOW_HIGH_SEC;
  try {
    const { readSendspinPluginConfig } = await import("./index.js");
    value = readSendspinPluginConfig().streamWindowSeconds;
  } catch {
    value = WINDOW_HIGH_SEC;
  }
  windowSecCache = { value, at: now };
  return value;
}

// ==================== 预填充缓冲(B1)====================
//
// 设备侧缓冲深度 = 时间线游标已推进到哪儿 − 当前墙钟。
// 稳态下它恒等于「首帧锚点提前量」(800ms):服务端按实时速率推,设备按实时速率播,
// 差值永远填不满 —— 所以**光把锚点抬到 10s 只会换来 10s 静默**,填不出缓冲。
// 正确做法是把两件事解耦:
//   - 锚点提前量  → 决定**起播延迟**,固定留 800ms(真机验证过的最低可用水位);
//   - 预填充水位  → 决定**缓冲深度**,由推流循环在首帧后尽快灌满(卡顿后还会自动回补)。
// 这正对齐 MA:producer 一路领先消费端填充,直到客户端 buffer_capacity 上限。

// 预填充缓冲的合法区间:定义搬到 constants.ts(server.ts 的
// capacityLimitedPrefillMs 也要用,若留在本文件会与 `import ... from
// "./server.js"` 形成循环 import)。此处 re-export 保持对外 API 与
// 既有引用/测试不变。
export { PREFILL_BUFFER_MAX_MS, PREFILL_BUFFER_MIN_MS } from "./constants.js";
/** 缺省水位(毫秒):3 秒 —— 抗抖动与切歌间隙的折中。 */
export const PREFILL_BUFFER_DEFAULT_MS = 3_000;

/** 归一化插件配置里的 `prefill_buffer_ms`(下拉档位存的是字符串):非法/越界回落缺省。 */
export function normalizePrefillBufferMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PREFILL_BUFFER_DEFAULT_MS;
  return Math.min(PREFILL_BUFFER_MAX_MS, Math.max(PREFILL_BUFFER_MIN_MS, Math.round(n)));
}

let prefillCache: { valueMs: number; at: number } | null = null;
let prefillRefreshing = false;
/** 插件配置重读间隔:Web 改完最多 5s 内生效,且不中断当前播放。 */
const PREFILL_CACHE_MS = 5000;

/** 取当前预填充目标(毫秒)。**同步** —— 推流热路径不能被 DB 查询卡住;
 *  缓存过期时后台异步刷新,本轮先用上次的值。 */
export function prefillTargetMs(): number {
  // 环境变量显式覆盖(排障/二分用),优先于插件配置:`SENDSPIN_PREFILL_MS=800`。
  const env = process.env.SENDSPIN_PREFILL_MS;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return normalizePrefillBufferMs(n);
  }
  const now = Date.now();
  if (!prefillCache || now - prefillCache.at >= PREFILL_CACHE_MS) void refreshPrefillTarget(now);
  return prefillCache?.valueMs ?? PREFILL_BUFFER_DEFAULT_MS;
}

async function refreshPrefillTarget(now: number): Promise<void> {
  if (prefillRefreshing) return;
  prefillRefreshing = true;
  try {
    const { readSendspinPluginConfig } = await import("./index.js");
    prefillCache = { valueMs: readSendspinPluginConfig().prefillBufferMs, at: now };
    void refreshSendspinDebugEnabled(); // debug 开关跟随插件配置(5s 缓存),推流期间自动生效
  } catch {
    // 读不到(子进程/单测):保留旧值;首次则回落缺省。
    if (!prefillCache) prefillCache = { valueMs: PREFILL_BUFFER_DEFAULT_MS, at: now };
  } finally {
    prefillRefreshing = false;
  }
}

/** 预填充总开关(排障/回滚用):`SENDSPIN_PREFILL=0` 一键退回旧行为 ——
 *  锚点回到 send_ahead、不填充、曲末不排空。 */
export function prefillEnabled(): boolean {
  const raw = process.env.SENDSPIN_PREFILL;
  return !(raw === "0" || raw === "false" || raw === "off");
}

/** 曲末排空「桥续静音」总开关(A 方案):env 缺省 ON,`MF_BRIDGE_DRAIN_SILENCE=0/false/off` 关闭。
 *
 *  关闭 ⇒ 排空循环与引入本能力前**逐字节一致**(不写 ring、不打日志)。
 *  ⚠️ 缓存**按 env 取值**缓存(同一取值只判定一次;取值变化才重算):排空循环虽不热,
 *  但它是每首歌都要跑的路径,不该每步都解析字符串;同时这样单测能直接切 env 验证关闭语义
 *  (与 raop.ts 的实验开关同风格,但比"读一次永久缓存"更好测)。
 *  ⚠️ 消费点只在**排空循环**(曲末 ≤40 次/首),不要拿它做推流热路径的开关。 */
let drainSilenceCache: { raw: string | undefined; on: boolean } | null = null;
export function bridgeDrainSilenceEnabled(): boolean {
  const raw = process.env.MF_BRIDGE_DRAIN_SILENCE;
  if (drainSilenceCache && drainSilenceCache.raw === raw) return drainSilenceCache.on;
  const on = !(raw === "0" || raw === "false" || raw === "off");
  drainSilenceCache = { raw, on };
  return on;
}

/** S1 下一首预解码开关(2026-11-01)。
 *  **优先读 Web 开关**:音频页的「下一首预解码」写 sendspin-renderer 插件配置
 *  `next_track_prefetch`(缺省**开**,见 bridgePrefetchConfig.ts);本函数在子进程里
 *  直读 plugins 表,音频页改完下一首换歌即生效,无需重启、不打断当前播放。
 *  容器环境变量 `MF_BRIDGE_NEXT_TRACK_PREFETCH` 作排障总闸并**优先于 Web 开关**
 *  (0/false/off 关,1/true/on 开)。关闭时预取态机完全不启动,边界行为(锚点 /
 *  垫片 / 曲末排空)与本改造前逐字节一致 —— 单开关整体回退。 */
export function nextTrackPrefetchEnabled(): boolean {
  const raw = process.env.MF_BRIDGE_NEXT_TRACK_PREFETCH;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return readBridgePrefetchConfig();
}

/** 触发阈值(ms):本曲剩余 ≤ 5s 时开始预解码下一首(≤ bulk 6s 上限,保证边界前
 *  预取帧已在 ring 里)。 */
export const BRIDGE_NEXT_PREFETCH_TRIGGER_MS = 5_000;

/** 低缓冲自愈阈值（ms）：`depthMs`（已推未播）跌破它就认为缓冲被追发抽干。
 *  正常稳态 5000~6000，恶化时 0~175，取 3000 作分界可避开头抖动。 */
export const BRIDGE_LOW_BUFFER_RECOVER_MS = 3_000;
/** 自愈时把 pacing 墙钟基准前提的量（ms）：泵立即多吐这么长内容。
 *  2s 足以把 0 缓冲拉回 2s（deltaUs +2s），又不至于一次性灌太深。 */
export const BRIDGE_PACE_BUMP_MS = 2_000;
/** 自愈冷却（ms）：源真喂不上时不做无意义的反复加速。 */
export const BRIDGE_PACE_BUMP_COOLDOWN_MS = 60_000;
/** 预取内容长度(ms):只解新曲前 3s —— 覆盖边界处解码空窗(实测 1~3s)即可,
 *  再长只是多占 ring 与内存。 */
export const BRIDGE_NEXT_PREFETCH_CONTENT_MS = 3_000;
/** 曲末「等预取就绪」上限(ms):`contentEnded` 与预取开始是**同一拍**时(真机实测:
 *  近曲末 seek 后锚点深 4.5s,推流循环 34ms 内就把剩余内容灌进 ring),预取解码还差
 *  0.4~0.9s 才回来。这里先等它就绪再判排空 —— 就绪即整段跳过排空(见下方 S1 注释)。
 *  超过本上限仍未就绪 ⇒ 回到原排空路径(桥续静音照补,行为与改动前一致)。 */
export const BRIDGE_NEXT_PREFETCH_WAIT_MS = 2_000;

/** 解析某首歌的可播字节(默认真实);测试可注入。 */
/** 音源工厂契约。`startMs > 0` = 起播即定位(ffmpeg `-ss`),由 seek 重建与
 *  起播跳转共用 —— MA 语义里「从 X 秒开始播」和「跳到 X 秒」是同一件事:
 *  都是用新起点建一条流,而不是在旧流里挪指针。
 *  `opts.preferRowId` = 复用上一轮生效源行(pump 在**同曲**重建时回填),
 *  透传给 `resolvePlayableRow` 以跳过整段播放优选(实测省 1.85~2.53s/次)。
 *  `opts.dspFilters` = ③ 段 per-播放器音色(见 `WindowSource.dspFilters`;
 *  仅流式窗口路径用得上 —— 整包 `decodeToF32` 路径没有 ffmpeg 链可挂)。 */
export type PumpSource = (
  songId: string,
  startMs?: number,
  opts?: { preferRowId?: string; dspFilters?: string[]; speed?: number },
) => Promise<GroupAudio>;

let injectedSource: PumpSource | null = null;
/** 测试注入音源;传 null 恢复默认真实解析。 */
export function overridePumpSource(fn: PumpSource | null): void {
  injectedSource = fn;
}

/** 调度粒度(ms):每次循环从 PCM 取这么长一段交给编码器。
 *
 *  对齐 MA 的 `chunk_duration_us = 25_000`(25ms)。此前是 100ms —— 粒度越粗,
 *  首块到达越晚、时间戳量化误差越大,且 100ms(4800 样本)与 FLAC block 4096
 *  **永不对齐**(每批 1.17 帧),给整批打同一时刻会让时间轴塌陷。
 *  ⚠️ 本值只决定**喂料节奏**,不再是时间戳的推进单位 —— 时间戳一律按编码器
 *  实测样本数推进(见 pushLoop)。 */
export const FRAME_MS = 25;

/** 把时刻对齐到**帧栅格**(FRAME_MS 的整数倍,向下取整)。
 *
 *  ★ 这是硬约束,不是可选优化(2026-09-22 240 真机实锤):
 *  `pushLoop` 取帧用 `lo = floor(pos / FRAME_MS) * frameSamples`(帧栅格),
 *  而 `PcmWindow.baseSample = floor(pos / 1000 * SR * CH)`(毫秒→样本)。
 *  两者**只在 pos 为 FRAME_MS 整数倍时严格相等**;否则 `lo` 会落在 `base`
 *  **之前**(最多 24ms 的量化差),`slice()` 判 `lo < baseSample` →
 *  `WindowEvictedError` → 主循环 `continue` → 用**同一个游标**重算 → 再抛……
 *  整条循环退化成纯微任务自旋,事件循环彻底饿死:日志永远停在调用方的等待点之前
 *  (真机:「音源就绪」之后再无锚点/公告),心跳与 `poll` RPC 全部堆积
 *  (supervisor 记 `悬挂 RPC 12~15 个` / `最后消息 71s 前`)→ 65s 看门狗 SIGKILL →
 *  子进程重启 → frozen 兜底重投(位置仍是毫秒精度)→ 再挂,无限循环,听感全哑。
 *
 *  触发面(解释了「同一个 seek 接口,HA 卡片与 Web 前端必挂、客户端正常」):
 *  HA 卡片与 Web 前端把**当前播放位置原样下发**(31.178s / 30.178s 这类毫秒精度),
 *  客户端下发整秒(62.00 / 108.00 / …)恰好都是 25ms 整数倍,故从未触发。
 *  流式关闭时走整包 `pcm.subarray` 路径(越界只钳制、没有"淘汰"概念),
 *  所以**当初**流式可关时,关掉开关也"看起来正常"—— 这正是当初误判成"流式开关的问题"的原因。
 *  ⚠️ 「流式解码」开关本身已于 2026-10-08 移除(现恒走窗口路径),此处仅作历史教训保留。
 *
 *  代价:向下取整最多让起点早 FRAME_MS-1(24ms),远低于可闻阈值;
 *  换来的是 base 与游标同源,首帧即精确位置。 */
export function alignFrameMs(ms: number): number {
  return Math.max(0, Math.floor(ms / FRAME_MS) * FRAME_MS);
}

/** 首块音频的下发提前量(微秒):锚点 = 当前墙钟 + 本值。
 *  对齐 MA `push_stream.DEFAULT_INITIAL_DELAY_US = 250_000`(250ms)——
 *  给设备留出「收到首块 → 建解码环 → 排入 I2S」的启动时间。
 *  设备侧另有 `send_ahead`(音频帧头里,由设备上报参数算出)叠加,
 *  两者语义不同:本值只回答「第一块应该在多远的将来」,send_ahead 回答
 *  「每块要预留多少传输/缓冲余量」。 */
export const FIRST_FRAME_LEAD_US = 250_000;

/**
 * seek 后重锚时间线时用的**最小**提前量(3s)。
 * 见 pushLoop 中 `reseed` 分支:设备上报的缓冲参数常常全 0(实测
 * output_delay/required_lead/min_buffer 均为 0),send_ahead 退化成缺省
 * 800ms;而 seek 要重起 ffmpeg,首帧实测滞后 ~7.4s,期间设备缓冲已见底,
 * 之后按实时速率推,浅缓冲补不回来 → 持续卡顿。重锚时把 lead 抬到 3s,
 * 让设备先攒够缓冲再播。
 */
export const SEEK_RESEED_LEAD_US = 3_000_000;

/** 推流循环每推送多少帧强制让出一次宏任务(B2)。对齐 MA
 *  `connection.py`:每 50 次迭代强制 `await asyncio.sleep(0)`。
 *  ⚠️ 不能写成「每帧都让出」:追赶/填充时必须尽快补帧,每帧 await setImmediate
 *  会把循环绑死在「每宏任务一帧」的节奏上 —— 慢设备或假时钟下永远追不上实时
 *  (实测会把队列自动切歌用例全部拖垮:每 tick 只推一帧,进度永远到不了曲末)。 */
export const YIELD_EVERY_FRAMES = 50;

/** 「编码器零产出」多久后判定为**异常**(而非正常攒样),降级为按喂入量推进时间线。
 *
 *  块编码器(FLAC)每攒满一块才吐一帧,期间 pushFrame 返回 0 是**正常**的
 *  (libFLAC 4096 样本 @48k = 85.33ms)。所以不能一见到 0 就降级 ——
 *  那会让时间线超前约 75ms,设备反复 `Lost sync (75006us off)`、听感一卡一卡。
 *  给足 10 倍余量:连续 500ms 零产出才认为是编码器坏了,此时宁可时间线略偏,
 *  也不能让它彻底停摆(timestamp 冻结 → pump 永不结束 → 切歌卡死)。 */
export const STALL_GRACE_US = 500_000;
/** 「编码器疑似失效」降级推进的**上限**:降级只是「攒样(≤85ms)」与「真死」之间的
 *  过渡兜底,绝不能让死编码器把整首歌唱成默剧 —— 240 生产实锤(2026-10-07):
 *  libFLAC 中途崩死后 encode 静默放空,降级推进把剩余 191s/453s 全部推成静音、
 *  进度照走、切歌才恢复。超过上限仍零产出 ⇒ 本曲不可修复,提前按自然播完收场
 *  (endedNaturally → 自动切下一首;新曲新建编码器即恢复;配合 encoding.ts 的
 *  编码器重建/模块重载自愈)。env `SENDSPIN_MAX_SILENT_DEGRADE_MS` 可覆盖(测试)。 */
export function maxSilentDegradeUs(): number {
  const ms = Number(process.env.SENDSPIN_MAX_SILENT_DEGRADE_MS);
  const cap = Number.isFinite(ms) && ms > 0 ? ms : 5_000;
  return Math.max(STALL_GRACE_US, cap * 1000);
}

/** 歌曲音源(唯一路径):统一裁决(resolvePlayableRow,与 /rest/stream 同口径)
 *  → 流式滑动窗口(ffmpeg 直读输入;窗口上限与整曲保留见 streamSource)。
 *  2026-10-08:「整曲一次解完进内存」旧路径已删除 —— 被「解码窗口上限」的整曲保留
 *  模式涵盖(歌长 ≤ 上限时不淘汰/不背压/前后 seek 零成本,起播更快、切歌不翻倍),
 *  且长曲走滑动窗口更安全。整包 `GroupAudio.pcm` 仅留给 announce(TTS)与测试注入。
 *  `opts.preferRowId` = 复用上一轮生效源行(见 ResolvePlayableRowOpts):
 *  同曲 seek 重建时跳过整段播放优选;返回值回带实际用的行 id 供调用方记账。 */
async function defaultSource(
  songId: string,
  startMs = 0,
  opts?: { preferRowId?: string; dspFilters?: string[]; speed?: number },
): Promise<GroupAudio> {
  const { resolvePlayableRow } = await import("../source/resolveAudio.js");
  const r = await resolvePlayableRow(songId, { preferRowId: opts?.preferRowId });
  if (!r.row) throw new Error(`no playable stream for ${songId} (${r.reason})`);
  const sourceRowId = r.row.id;
  return { ...(await streamingSource(r.row as any, startMs, opts?.dspFilters, songId, opts?.speed)), sourceRowId };
}

/** 流式音源:行 → ffmpeg 直读输入 → 滑动窗口。首帧只等 2 秒预缓冲,
 *  不再等整曲解完(此前起播解码实测可达 7.4s)。时长取元数据(秒→ms),
 *  缺失则为 0(结束只靠 EOF＋耗尽,见 pushLoop)。 */
/** ffmpeg 输入硬契约(见 services/dlna/control.ts 注释 / SPEC §1.8):http(s) 直链
 *  一律改走本进程回环 token URL —— 静态 ffmpeg 在 Alpine 解析不了域名(含 302
 *  跳转目标),且跟随 302 会把 Authorization 头带给 CDN(OBS 400 InvalidAuthType)。
 *  独立导出供契约测试锁定(ffmpegInputContract);改本函数必须同步该测试。
 *  实现已下沉到 audio/pipeline.resolvePipelineInput,此处仅保留别名(调用方零改动)。 */
export async function resolveFfmpegInput(
  direct: { input: string; headers?: Record<string, string> },
  /** 曲目 id(可选):透传到回环 URL 的 `sid`,主进程据此查预取 membuf(零回源起播)。 */
  songId?: string,
): Promise<{ input: string; headers?: Record<string, string> }> {
  const { resolvePipelineInput } = await import("../audio/pipeline.js");
  return resolvePipelineInput(direct, songId);
}

async function streamingSource(
  row: { id?: string; duration?: number | null },
  startMs = 0,
  dspFilters?: string[],
  /** 曲目 id:透传给 PcmWindow.meta,debug 日志取证「哪首歌播到哪挂了」用。 */
  songId?: string,
  /** 倍速(2026-11-14):进 decode af 的 atempo;窗口/os 游标因此是**输出流时间轴**。 */
  speed: number = 1,
): Promise<GroupAudio> {
  const { resolveRowInput } = await import("../source/resolveAudio.js");
  const direct = resolveRowInput(row as any);
  if (!direct) throw new Error("no streamable input for row");
  // songId 透传到回环 URL(sid):该曲已预取进主进程 membuf 时 ffmpeg 直读内存,
  // 不再回源(网盘 FLAC 回源实测 6.4s,足以让桥补 1.555s 静音)。
  const source = await resolveFfmpegInput(direct, songId);
  // startMs 同时喂给两处,**口径不同**:
  //   ① PcmWindow 的 baseSample = 输出流绝对毫秒(atempo 压缩后);
  //   ② ffmpeg `-ss` = 内容秒。
  // 倍速下两者不等(1.5x 时输出 40s 对应内容 60s),故 spawnContentSec 必须显式换算
  // (2026-11-25 修:此前同一 startMs 直通 `-ss`,倍速下起播位置按倍速偏移)。
  // 起播即定位,省掉「先建流再 seekTo 冷起一次」的整段空窗。
  // 解码窗口上限(插件配置「解码窗口上限」):歌长 ≤ 上限 → 整曲保留(前后 seek 零成本);
  // 歌长 > 上限 → 滑动窗口(背压+淘汰),照样播完。duration 未知(0/null)时保守走滑动。
  const windowSec = await readStreamWindowSeconds();
  const durSec = typeof row.duration === "number" && row.duration > 0 ? row.duration : 0;
  // 倍速下"整曲保留"的判据是**输出流时长**(内容/speed):60s 的歌 1.5x 只有 40s,
  // 用内容时长判断会白留 20s 窗口(内存/背压都按错的口径算)。
  const retainWholeSong = durSec > 0 && durSec / speed <= windowSec;
  log.debug(`[window] 上限=${windowSec}s 整曲保留=${retainWholeSong} 歌长=${durSec}s speed=${speed}x`);
  const window = new PcmWindow(
    {
      ...source,
      ...(typeof row.id === "string" ? { rowId: row.id } : {}),
      ...(dspFilters && dspFilters.length > 0 ? { dspFilters } : {}),
      ...(speed !== 1 ? { speed } : {}),
    },
    startMs,
    {
      highSec: windowSec,
      retainWholeSong,
      meta: { songId, durationSec: durSec },
      // startMs 是**输出轴**毫秒(baseSample 用),`-ss` 要**内容秒**:
      // r=2 时输出 50s 对应内容 100s。1x 下两者相等,故旧行为不变。
      spawnContentSec: streamToContentSec(startMs / 1000, speed),
    },
  );
  try {
    await window.ready();
  } catch (e) {
    window.close();
    throw e;
  }
  const durationMs = typeof row.duration === "number" && row.duration > 0
    ? Math.round(row.duration * 1000)
    : 0;
  return { pcm: new Float32Array(0), durationMs, stream: window };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 让出一个**宏任务**周期。
 *
 *  ⚠️ 与 `await Promise.resolve()`(纯微任务)有本质区别:Node 在每个宏任务
 *  边界会把微任务队列**完全排空**,所以纯微任务 yield 不会给 I/O 回调任何机会;
 *  `setImmediate` 明确排在本轮 I/O 回调之后,能保证 WebSocket 的 message 回调
 *  (设备发来的 `client/time` 等)得以执行。
 *  对齐 MA:aiosendspin `connection.py` 每 50 次迭代强制 `asyncio.sleep(0)`。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

/** 安全日志:GroupPump 可能被以最小 stub server 构造(测试/嵌入式场景),
 *  不能假设 `server.log` 一定存在 —— 否则日志本身就抛错、把推流循环打死
 *  (2026-09-17 踩过:新增的锚点日志让 pumpFallback 三个用例全部超时)。 */
function logSafe(server: SendspinServer | undefined, level: "info" | "warn" | "error", msg: string): void {
  try {
    server?.log?.(level, msg);
    // debug 日志开时,全部 sendspin 日志自动入册(文件 + 内存环形缓冲),排障一条时间线。
    recordSendspinDebug("log", msg, { level });
  } catch { /* 日志失败绝不影响推流 */ }
}

/** 组的音色目标 peerId(③ 段 DSP 的配置键)。
 *
 *  sendspin 的音频是**按组一条共享流**(一个 ffmpeg 喂全组),所以一份音色只能染
 *  整条流 —— 分不了成员。于是取「这个播放目标自己」的配置:
 *    - 用户组(`ug:<gid>`,组名由 `playerCore.sendspinGroupName` 生成)→ `group:<gid>`
 *      —— 与前端「音色」下拉里群组条目的 peerId 同形,也让 plan §3.3「成组的音色
 *      由组的输出统一决定」真正落地;
 *    - 单设备组(组名 = 裸 clientId = `playCore`/`seekCore` 建的组)→ `sendspin:<id>`。
 *
 *  ⚠️ 两条都由 `playerDspFilters` 内部再判一层:设备已被拉进用户组时
 *  (`isPeerGrouped` 为真)整体返回空链 —— 成员自身的音色自动停用,与 MA 一致。
 *  该判断**必须**留在 playerDsp 侧(唯一判定入口),此处只做「组名 → peerId」的翻译。 */
export function dspPeerIdForGroup(groupName: string): string {
  return groupName.startsWith("ug:") ? `group:${groupName.slice("ug:".length)}` : `sendspin:${groupName}`;
}

/**
 * 对某个组驱动连续推流。同一组同时只允许一个 active pump。
 *
 * 状态机:
 *   - running = 当前是否持有已加载曲目并处于推流主循环;
 *   - paused  = 暂停标志(推流主循环挂起不推进,position 冻结);
 *   - epoch   = 每次 play 自增,使旧的推流循环失效(避免重叠)。
 *
 * 支持 pause/resume/seek(seek 直接改写 positionMs,主循环按 position 取帧)。
 */
/** S1(2026-11-01):下一首预解码结果(已按连续 ts 写进 ring 的下一代次帧)。 */
interface NextTrackPrefetch {
  /** 预取的歌(采纳时 songId 必须一致)。 */
  songId: string;
  /** 预取帧所属的内容代次(= 开始时的 bridgeContentEpoch + 1)。 */
  epochAtStart: number;
  /** 预取首帧的时间戳(内容域,沿用当前组游标 ⇒ 与旧曲末帧连续)。 */
  startTsUs: bigint;
  /** 解码好的音源(窗口**保持打开**,采纳时正片直接用它,不再取一次音源)。 */
  audio: GroupAudio;
}

/** 设备「距离开播」的 lead(ms):桥 tick 的 commandedLeadUs 实测 2050000。 */
const AUDIBLE_DEVICE_LEAD_MS = 2_050;

/** 暂停时长超过该值才重建时间线(短暂停缓冲未耗尽,重锚反而制造跳变)。 */
const PAUSE_RESEED_MS = 3_000;

/** 泵「新曲开始出声」的跨进程回调(实现由子进程入口注入,见 childMain)。
 *  只上报事实,不做广播决策 —— 广播在主进程。 */
type AudibleStartSink = (clientId: string, songId: string, positionMs: number, durationMs: number) => void;
let audibleStartSink: AudibleStartSink | null = null;

/** 注册/清除出声回调(childMain 启动时注册)。 */
export function setAudibleStartSink(fn: AudibleStartSink | null): void {
  audibleStartSink = fn;
}

export class GroupPump {
  private group: SendspinGroup;
  private server: SendspinServer;
  /** 推流节奏倍速(>1 加速,演示/测试用);默认 1 = 实时。 */
  private speed: number;

  private running = false;
  // 临时诊断计数器(2026-09-17 卡顿排查,定位后移除)。
  private dbgCount = 0;
  private dbgPrevWall = 0;
  private dbgPrevTs = 0;
  private paused = false;
  /** 暂停起点(ms);resume 用它判断是否需要重建时间线。 */
  private pausedAtMs = 0;
  /** 本段播放的「墙钟起点 / 内容起点」:显示位置的上界 = 内容起点 + 已流逝墙钟 × 倍速。
   *  设备不可能"听到"比这更多的内容 —— 起播瞬间时间线锚点可能落在过去(接续上一首),
   *  按 `pushed − depth` 算会把那点差值直接算成已播秒数,于是新曲第一眼不是 00:00
   *  (实测 13:58 那次首样本 pos=1)。取 min(可听位置, 上界) 即可,且它只在上界更小时生效。 */
  private playWallMs = 0;
  private playContentMs = 0;
  private epoch = 0;
  /** 起播预填充窗口是否已退出(pushLoop 里 wantFill 由 true 翻 false)。
   *  服务端开环检测靠它豁免「起播灌水位」阶段;设备不消费时 wantFill 会恒 true,
   *  故 server.ts 另有 SINK_WATCH_PREFILL_MAX_MS 硬回退兜底。 */
  prefillSettled = false;
  /** 当前是否处在起播灌水位(fill)阶段。 */
  prefillFilling = false;
  /** 推流 pacing 的**锚点对**:「某个播放位置」⇄「它对应的墙钟时刻」。
   *
   *  排程公式 `dueMs = paceAnchorWall + (i*FRAME_MS - paceAnchorMs)/speed`。
   *
   *  ⚠️ 为什么必须是"锚点对"而不是单一基准时刻:seek 会改写 positionMs 使 `i` 跳变,
   *  基准必须能表达"位置 i 应在何时播"。早先用「起播时刻 + i*FRAME_MS」的单一基准,
   *  seek 后 dueMs 会随 i 一起跳:
   *    · 向前拖 → dueMs 落到很远未来 → 主循环 sleep 掉**整个拖动距离**的时长
   *      (实测:拖 40s → 静默 40s) —— 即「sendspin 拖动后无法播放」;
   *    · 向后拖 → dueMs 全部落在过去 → delayMs≤0 → 帧无节制倒灌,瞬间灌爆设备缓冲。
   *  改用锚点对后,**每次循环都从同一对 (position, wall) 现算** dueMs:seek 只需把锚点
   *  对改写成 (目标位置, 现在),无需一次性标志 —— 也就不存在"标志被上一轮循环吃掉、
   *  seek 这一拍丢了基准"的竞态(第一版用布尔标志时实测仍会倒灌 192 帧/300ms)。
   */
  private paceAnchorMs = 0;
  private paceAnchorWall = 0;
  /** seek 后需重建时间线锚点(timelineBaseUs / cursorUs)。
   *
   *  时间戳必须与墙钟同源(见 pushLoop 头部"第三次无声事故"注释)。seek 时:
   *  `window.seekTo` 要重起 ffmpeg,期间主循环在 WindowEvictedError 上空转 ——
   *  这段时间 cursorUs 不推进而墙钟在走,窗口就绪后时间戳已落后于真实时间,
   *  设备端 `(ts - send_ahead) - now` 恒为负 → 立即吐字节 → underrun → 无声。
   *  故 seek 后必须按当时墙钟重新确立锚点。
   *
   *  用**自增序号**而非布尔:主循环可能已经越过了本轮的重锚判断点(seek 恰好插在
   *  取帧与排程之间),布尔会被这一轮吃掉、seek 的重锚就丢了。序号则让下一轮仍能
   *  看出"这是一次尚未消费的 seek"。 */
  private timelineReseed = 0;
  /** 起播窗口内到达的 seek 目标(ms),由 `play()` 取用后清空。
   *
   *  `play()` 会 `await source(...)`,内部要 spawn ffmpeg 并预缓冲(实测数秒,长曲更久)。
   *  这段时间 pump 已存在但 `running === false` —— 用户"刚点播就拖进度条"完全合理,
   *  而此刻 seek 只能写 `positionMs`,紧接着就被 `play()` 归零(新曲从 0 开始的语义),
   *  于是那次拖动被**整条吞掉**:接口返回 success、`[pump][seek]` 日志也打了,
   *  但音频从 0 开始播 → 用户观感「拖动无效 / 拖了没反应」(240 真机实测复现)。
   *  故窗口内的目标必须单独留一份,由 `play()` 作为起播位置消费。 */
  private pendingSeekMs: number | null = null;
  /** ★ pushLoop 的**自有取帧游标**(MA 位置模型:值+时间戳对,推送循环独占写)。
   *  此前 pushLoop 用共享的 group.positionMs 反推帧下标(`Math.floor(positionMs/FRAME_MS)`),
   *  而 seek() 的「先发布目标位置」恰好写的就是这个共享字段 → 旧循环下一帧直接
   *  跳到目标处取帧 → 旧滑窗给不出数据 → seg.length===0 误判 EOF →
   *  contentEnded → 触发收尾、预建流作废(2026-09-22 真机实锤,
   *  FP-TRACE 堆栈钉死 pushLoop EOF 路径)。原则:**共享位置只写不读**,取帧一律用本游标。 */
  private playCursorMs = 0;
  /** ★ 对外上报进度的**下界**(本轮起播位置 / seek 目标)。
   *
   *  为什么需要:上报的是「可听位置」(已推送 − 缓冲深度),它天然落后于已推送量:
   *   - 正常起播(startMs=0)时落后约一个锚点提前量 → 下界 0,开播即显示 00:00 ✅
   *     (这正是「预填充 10s 档开播就显示 00:10」的修复点);
   *   - 但 **seek 到 40s** 时若也这么算,首帧会显示 39.2s —— 而 MA 的权威语义是
   *     ① 先发布 `elapsed_time = position` 防 UI 回跳(controller.py @862),拖动后
   *     UI 必须立刻看到目标值。把刚发布的目标又拉低 = 用户观感「拖了没到位」。
   *
   *  故可听位置的下界取「本轮已发布的目标」,由 play()(起播位置)与 seek()(目标)
   *  两处写入 —— 与 `pendingSeekMs` 的区别:那个是**给音源 -ss 用的起播偏移**,
   *  这个是**给 UI 用的上报地板**,两者数值相同但用途不同、都不该互相替代。 */
  private reportedFloorMs = 0;
  private pcm: Float32Array | null = null;
  private window: PcmWindow | null = null;
  private durationMs = 0;
  private songId = "";
  /** 上一轮实际用来出流的**源行 id** 及其所属歌 id(源行复用记账)。
   *
   *  为什么记:seek 重建走 `source(songId, startMs)` —— 只带 songId,同一首歌内
   *  反复拖进度条会每次重跑「播放优选」(实测 1.85~2.53s/次,且结果恒定:web 行
   *  每次都 swap 到组内核心曲库行)。记住生效行,同曲重建把它当 `preferRowId`
   *  交给解析器直接命中,整段优选跳过。
   *
   *  生命周期:切歌(songId 变化)不复用;复用命中却出不了流时**清空并回退完整
   *  解析一次**(见 play 内 srcPromise),回退成功后按新结果重新记账。
   *  `stop()` 有意**不清** —— stop → 重播同一首等价于 seek 到 0,复用同样成立。 */
  /** 起播进行中(play() 已进入、音源尚未就绪):此刻 `running` 仍是 false,但**已有一次
   *  play 在飞** —— 起播窗口内的 seek 必须交给它自纠,调用方(seekCore)不得再起第二个
   *  play:两个 play 会各自 ++epoch,回来后验世代**互掐对方刚建好的窗口**,存活的那个
   *  pump 拿到的是零输出窗口(`eof=true` / `decoded == baseSample`)→ 被判成播完退出
   *  → IDLE → 15s stalled → 从 0 重投 → frozen → 放行切歌(240 日志 12:31 实锤)。 */
  private playInFlight = false;
  /** 起播自纠重来计数:仅作**收敛保险**(见 play 的起播期间 seek 分支),正常一次即归零。 */
  private playRetry = 0;
  /** 起播窗口判定:是否已有一次 play 在飞(见 playInFlight)。 */
  get busy(): boolean { return this.playInFlight; }

  /** 流代次(§4.3):`(epoch, timelineReseed)` 二元组的乘法混合。
   *  - 每次「新建播放上下文」都是新代次:新歌起播 / seek(epoch++)、rehost(只动
   *    timelineReseed,🔴 禁止给 rehost 加 epoch++,否则 :759 推流循环立即退出);
   *  - **乘法混合而非加法**:`epoch + reseed` 在两者交替自增时会撞出同一个和
   *    (epoch=2,reseed=0 与 epoch=1,reseed=1 都得 2);`1_000_003` 取大于
   *    timelineReseed 实际取值范围的质数。
   *  消费点:重锚分支(唯一落点,BLK-02)经 group.notifyBridgeGeneration 推给桥。 */
  get generation(): number {
    return this.epoch * 1_000_003 + this.timelineReseed;
  }

  /** 当前**正在播**的歌 id(未在播为空串)。
   *  ⚠️ 移交判定必须看它而不能只看 `active`:`active` 在 `running=true` 而首帧
   *  还没产出时就已经为真,拿它当"有流可借"会借到一条半成品。 */
  get playingSongId(): string { return this.running ? this.songId : ""; }
  private srcRowId: string | null = null;
  private srcRowSongId = "";
  // 暂停时被唤醒的等待器。
  private resumeWaiter: (() => void) | null = null;
  // 上一首是否已"自然播完"(用于结束时置空 current 触发 auto-advance)。
  private endedNaturally = false;

  // ---- P2(2026-11-02)接续锚点记账 ----
  /** 上一曲**自然播完**那一刻的时间线尾(µs,本泵绝对域)。手动切歌/seek 由 stop()
   *  打断,根本走不到记账户,故它天然只代表「同一时间线可以接着往下走」。
   *  生命周期:**记完即用一次**(下一次 `play()` 起手快照进 continuityFromUs 后清空)。 */
  private lastContentEndUs: bigint | null = null;
  /** 本轮起播可接续的上一曲尾(play() 起手从 lastContentEndUs 快照,随后清空)。 */
  private continuityFromUs: bigint | null = null;
  /** [P0 2026-11-24 桥断粮] 曲末**已按接续跳过排空**的承诺(曲末那一拍一次性定死)。
   *
   *  为什么必须是「承诺」而不是「再判一次」:`continuityDrainSkip` 一旦为真,旧曲尾
   *  (可能几十秒)就留在 ring 里没被排空成静音,新曲的时间线也已经押在「接上这条连续
   *  时间轴」上 —— 这个决定**不可逆**。旧实现让起播侧(playerCore)再用自己的一套判据
   *  (pump.active / gates / window / prefetch)重判一次,两侧一旦不一致(240 现场
   *  2026-11-24 17:26:07:泵记 `曲末排空跳过 continuity=1`、390ms 后起播侧记
   *  `continuity=false`),就会 `g.close({keepBridgeDelivery:false})` + `clearPlayback()`
   *  把这条 ring 整段清掉,而泵仍按 contig 把新曲首帧锚在**已被清掉的内容尾**之后
   *  (现场 `timeline anchored base=254545581990 contig=254545581990`,即 now+33.3s)
   *  ⇒ 投递窗口(上沿 now+8.5s)内一帧都没有(`bridge-servo cand=0 firstCandVsNow=33740`
   *  、`deliveredMs=0`)⇒ 两台桥同时断粮,泵又被 30s 背压钉死,只能等墙钟自己追上来。
   *  纪律:接续判定只有一个产地 = 曲末这一拍,后面所有人读这个字段。 */
  private continuityCommitted = false;
  /** `play()` 起手把 continuityCommitted 快照到这里(与 lastContentEndUs→continuityFromUs
   *  同款「记完即用一次」语义),随后清零 —— 一次起播只消费一次承诺。 */
  private continuityNext = false;
  /** [P0 2026-11-24 二次求值分叉] 曲末**判过但被时间窗否决** ⇒ 明确「不接续」。
   *
   *  为什么单独记 denied 而不靠 `!committed` 推断:起播侧不知道「曲末到底判没判」,
   *  若退回旧逻辑再算一次窗口,两次求值时刻不同(曲末用 cursor,起播用 lastContentEndUs)
   *  就会在临界点上翻转 —— 240 现场 10:16 实测:曲末 `差=35316ms` 否决(阈值 35000ms),
   *  1.5s 后起播侧再算却通过 ⇒ 起播侧 continuity=true、泵侧 continuity=false,两套
   *  时间轴并存(与 17:26 断粮同型,方向相反)。
   *  纪律:曲末一锤定音(granted / denied 二选一),后续只复核「是否已经太旧」。 */
  private continuityDenied = false;
  /** 起播起手把 denied 一起快照(与 continuityNext 同款「记完即用一次」)。 */
  private continuityNextDenied = false;

  /** 判死后回传(子进程 → 主进程负缓存同步):由 `pumpFor(_, _, sink)` 装填。
   *  未装填 = 静默丢弃(单测 / 主进程内起播都不受影响)。
   *  回传失败绝不影响推流收尾(调用点整段 try/catch)。 */
  onUnplayable: SongUnplayableSink | null = null;
  /** 「回传口未装填」已报过的 songId:每首最多一条 warn,同一首反复播不刷屏。 */
  private warnedNoSink = new Set<string>();

  // ---- S1(2026-11-01)下一首预解码态机(默认关,见 nextTrackPrefetchEnabled) ----
  /** 队列下一首 songId(play() 由 QueueController 透传;空 = 不预取)。 */
  private nextSongId = "";
  /** 预取就绪(已写入 ring 下一代次帧 + 音源窗口保持打开,等 play() 采纳)。 */
  private prefetch: NextTrackPrefetch | null = null;
  /** 预取解码在飞:防每帧重复 spawn ffmpeg。 */
  private prefetchInFlight = false;
  /** seek 重建保号(2026-11-01 真机实测):`QueueController.seek` → 组 seek → seekCore
   *  再走 playGroupCore,**重建这一路拿不到队列信息**(nextSongId 只能由 playCurrent
   *  下发),于是同一首拖进度后 nextSongId 被清空,曲末预取静默失效(日志
   *  `next-prefetch 判定 next=-`)。seek 时置位,下一次 play() 若**同曲**则沿用旧提示。 */
  private keepNextOnRebuild = false;
  /** 采纳预取后的**时间线交接点**:pushLoop 首帧锚点改用它(与 ring 里预取帧连续,
   *  不能再用 nowUs()+lead,否则同内容两套 ts ⇒ 后续帧被水位当重复丢弃)。 */
  private handoffTsUs: bigint | null = null;
  /** 本轮起播的音色片段(预取解码必须与正片同参数,否则两部分音色不一致)。 */
  private dspFilters: string[] = [];
  /** 本轮音源工厂(预取复用同一工厂;测试注入音源同样走它)。 */
  private srcFn: PumpSource | null = null;
  /**
   * 播放倍速(2026-11-14;1 = 原速)。
   *
   * 与 `this.speed`(SENDSPIN_PUSH_SPEED,推流 pacing 倍速)是**两件事**:
   *  - `speed`   :把帧推给设备的节奏倍率(压测用,通常 1);
   *  - `rate`    :音频内容本身的播放倍率(atempo)。音频已在解码段被压缩,
   *                因此泵内部**全部时间轴(playCursorMs/durationMs/positionMs/
   *                pendingSeekMs)统一是输出流毫秒**,对外只在 poll / seek 边界换算。
   */
  private rate = 1;

  /**
   * 倍速热切换序号(2026-11-25,§4.4)。
   *
   * 为什么必须另起一个序号,而不复用 `timelineReseed`/`epoch`:后两者任一变动都会让
   * pushLoop 的首帧分支走「重锚 + `notifyBridgeGeneration(…, "rehost"|"track", …)`」
   * ⇒ 桥侧判换代 ⇒ 重锚/清缓冲 ⇒ **听感断点**(240 实测 1.66s 空窗 + `newgen-skip`
   * 丢 1226ms)。而改倍速时时间轴**不能重锚**(ts 必须逐帧接续)、桥也**不该感知换代**
   * —— 故另设序号,pushLoop 见它只做「换窗口引用 + 输出轴换算」。
   *
   * 与 `setPlaybackRate` 的分工见该方法注释。
   */
  private rateSeq = 0;
  /** 待提交的热换源(由 `switchRate` 建好后填入,pushLoop 取帧前消费一次即清空)。 */
  private pendingSwap: {
    seq: number;
    win: PcmWindow;
    /** 新倍率。 */
    rate: number;
    /** 建窗时的旧倍率:提交前复核「还没被别人改过」(否则换算系数会算错)。 */
    prevRate: number;
    /** 建窗基准内容位置(内容毫秒):仅日志/诊断用,不参与换算。 */
    buildContentMs: number;
    /** 已在新窗口内 seekTo 到的输出轴位置(**上限**,提交时游标不得越过它)。 */
    seekedOutMs: number;
    /** 建窗耗时(ms):日志用。 */
    buildCostMs: number;
  } | null = null;
  /** 热换源正在建窗:并发守卫(A9),在途时再次调用直接返回 false(由调用方重投兜底)。 */
  private rateSwitching = false;

  /** 设置播放倍速(**下一次 play 生效**;运行中的真无缝热切换见 `switchRate`)。 */
  setPlaybackRate(rate: number): void {
    const r = Number(rate);
    this.rate = Number.isFinite(r) && r > 0 ? r : 1;
  }

  get playbackRate(): number {
    return this.rate;
  }

  /**
   * 热切换播放倍速:**不重建泵、不发任何生命周期消息、时间戳逐帧接续**。
   *
   * ## 为什么需要它(与 MA 的对照)
   *
   * MA 的 `set_playback_speed`(`player_queues/controller.py:504`)只能
   * 「结算旧速度墙钟 → `resume()` → `play_index()` 重开整条流」—— 因为它是**设备来拉**
   * 的 HTTP 架构,改速度必须换 URL。本项目 Sendspin 是**服务端推块 + 每块带绝对可听
   * 时刻戳**(`[0x04][i64 µs][data]`),只要新块的 ts 接着旧块、且不重发
   * `stream/start|clear|end`(改倍速不改 codec/采样率/声道数),设备端就感知不到换流
   * —— 这是「真无缝」的物理基础,MA 不具备。故本方法是**超越 MA**,不是对齐 MA;
   * atempo 本身仍与 MA 同构(`playbackSpeed.ts::withAtempo`,链尾、保音高)。
   *
   * ## 流程(`docs/倍速无缝切换-设计方案-20261125.md` §4.2)
   *
   * ```
   * C0 = playCursorMs × r0                  建窗基准(内容毫秒)
   *   → 新窗口 -ss(C0/r1) + atempo=r1, await ready()   ← 旧窗口持续供流,不断粮
   * C1 = playCursorMs × r0                  提交时刻前沿(C1 ≥ C0)
   *   → 新窗口 seekTo(C1/r1 + 一帧余量)      ← 命中已解区间则只改下标,零成本
   *   → this.pendingSwap = { … }             由 pushLoop 下一拍原子提交
   * ```
   *
   * ⚠️ **切换点必须取 C1(提交时刻前沿),不能取 C0**。`ready()` 实测 0.2~2s,期间旧流
   * 继续推、前沿已从 C0 推进到 C1;按 C0 提交等于把 C0~C1 这段**已推给设备**的音频再推
   * 一遍 —— 听感是「倒退重播」。
   *
   * @returns `false` = 条件不满足(未运行 / 无窗口 / 起播在飞 / 同速率 / 非法值 /
   *          已在建窗 / 建窗失败),**调用方必须回落整泵重投**(有断点但不无声)。
   */
  async switchRate(nextRate: number): Promise<boolean> {
    const r1 = Number(nextRate);
    if (!Number.isFinite(r1) || r1 <= 0) return false;
    // 只在「整曲已在推流」状态下热换:起播在飞(playInFlight)时起播位置尚未定,
    // 建窗基准无从取起,交给调用方重投(与 §8.3「暂停中改速」路径一致)。
    if (!this.running || !this.window || !this.songId) return false;
    if (this.playInFlight || this.rateSwitching) return false;
    const r0 = this.rate;
    if (Math.abs(r1 - r0) < 1e-9) return false;
    const src = this.srcFn;
    if (!src) return false;
    this.rateSwitching = true;
    const startedAt = Date.now();
    // 世代守卫基准:建窗期间若 play()/stop() 已经换代(++epoch),新窗口属于**上一段**
    // 播放上下文,提交上去就是把旧曲音频灌进新曲时间轴(必须就地掐掉)。
    const myEpoch = this.epoch;
    // 序号先取:即便本轮失败也保持单调,避免与上一轮的 seq 撞号(A9 幂等键)。
    this.rateSeq += 1;
    const seq = this.rateSeq;
    let newWin: PcmWindow | null = null;
    try {
      // C0:建窗基准内容位置。`playCursorMs` 是**输出轴**,乘 r0 折回内容轴(不变量)。
      const buildContentMs = Math.max(0, this.playCursorMs) * r0;
      // 新窗口起点(输出轴)必须与帧栅格同源 —— 否则接缝 ≤25ms 偏移,且子进程
      // 会因 lo < baseSample 的量化差走微任务自旋(见 alignFrameMs 的硬约束)。
      const startOutMs = alignFrameMs(buildContentMs / r1);
      const built = await src(this.songId, startOutMs, {
        ...(this.srcRowId ? { preferRowId: this.srcRowId } : {}),
        dspFilters: this.dspFilters,
        speed: r1,
      });
      newWin = built.stream ?? null;
      if (!newWin) {
        // 整包路径(TTS announce)没有 ffmpeg 链可换 atempo ⇒ 交给调用方重投。
        this.rateSwitching = false;
        return false;
      }
      // C1:提交时刻前沿。`await` 期间旧流仍在推 ⇒ 前沿必已前进(C1 ≥ C0)。
      // 多留一帧:pushLoop 提交本身可能晚几十毫秒,余量保证「绝不倒退重播」
      // (宁可多解 25ms 内容 —— 新窗口在后台解,零成本)。
      //
      // ★ 为什么是**循环**而不是一次 seekTo(2026-11-25 240 真机实证):
      //   建窗 + 预缓冲一旦慢到秒级(实测一次 9.7s:远程源 + loudnorm 单遍收敛),
      //   一次 seekTo 必然「超出已解前沿」⇒ `seekTo` 内部杀 ffmpeg 按 -ss 重起
      //   ⇒ 又要预缓冲 ⇒ 而旧流仍在推、前沿继续涨。上一版在这里直接判「未覆盖」
      //   回落整泵重投,结果正是本方案要消灭的东西:桥换代 `reason=track` +
      //   `newgen-skip` 丢 3777ms + 上百次 realign。
      //   正确做法:重起后 base 已等于上一轮目标,再取一次前沿再 seek 一次即可 ——
      //   新目标只比 base 多出「预缓冲那一小段」,第二次必然命中(命中=只改下标,零成本)。
      //   3 次上限兜极端慢源;超了也接受「刚 ready 的窗口」(base=目标,覆盖成立)。
      let seekedOutMs = startOutMs;
      for (let attempt = 0; attempt < 3; attempt++) {
        const commitContentMs = Math.max(buildContentMs, Math.max(0, this.playCursorMs) * r0);
        const target = alignFrameMs(commitContentMs / r1) + FRAME_MS;
        seekedOutMs = target;
        // `ms` 是输出轴,`-ss` 要内容秒(与 construction 同口径,P0 修正)。
        const respawned = await newWin.seekTo(target, {
          spawnContentSec: streamToContentSec(target / 1000, r1),
        });
        if (!respawned) break; // 命中:零成本,直接用
        // 重起后**必须**等预缓冲再提交:否则 pushLoop 的 slice 会挂在未解码区间
        // (await 到超时才返回 = 断粮),那比「不换源」更糟。
        await newWin.ready();
        // 上限轮:刚 ready 的窗口 base 已等于 target,覆盖成立,直接接受。
        if (attempt === 2) break;
      }
      // 世代守卫:建窗期间泵已停/已换代 ⇒ 新窗口是孤儿苗子,就地掐掉(同 play 的 superseded)。
      if (!this.running || !this.window || this.epoch !== myEpoch) {
        try { newWin.close(); } catch { /* ignore */ }
        this.rateSwitching = false;
        logSafe(
          this.server,
          "info",
          `[pump][rate] song=${this.songId} 建窗期间播放上下文已切换(epoch ${myEpoch}→${this.epoch}),新窗口释放`,
        );
        return false;
      }
      // ★ A8:旧预取窗口是按**旧 rate** 解的 atempo,换源后必须丢帧(保留「下一首是谁」)。
      this.cancelNextTrackPrefetch(true);
      this.pendingSwap = {
        seq,
        win: newWin,
        rate: r1,
        prevRate: r0,
        buildContentMs,
        seekedOutMs,
        buildCostMs: Date.now() - startedAt,
      };
      this.rateSwitching = false;
      logSafe(
        this.server,
        "info",
        `[pump][rate] song=${this.songId} ${r0}x→${r1}x 建窗 内容Ms=${Math.round(buildContentMs)} ` +
          `起点=${startOutMs}ms 追至=${seekedOutMs}ms 耗时=${Date.now() - startedAt}ms 待提交`,
      );
      return true;
    } catch (e: any) {
      try { newWin?.close(); } catch { /* ignore */ }
      this.rateSwitching = false;
      logSafe(
        this.server,
        "warn",
        `[pump][rate] 热换源建窗失败,回落整泵重投 song=${this.songId} ${r0}x→${r1}x: ${e?.message || e}`,
      );
      return false;
    }
  }

  constructor(server: SendspinServer, group: SendspinGroup) {
    this.server = server;
    this.group = group;
    const s = Number(process.env.SENDSPIN_PUSH_SPEED);
    this.speed = Number.isFinite(s) && s > 0 ? s : 1;
  }

  get active(): boolean {
    return this.running;
  }

  /** [P0 2026-11-24] 本曲是否**自然播完**(而非被 stop/seek 打断)。
   *
   *  起播侧用它区分「打断」与「播完但 pushLoop 还没退出」:两者下 `active` 都是 true,
   *  但只有前者该否定接续。240 现场:pushLoop 收尾(`running` 仍 true)与
   *  QueueController auto-advance 之间有 ~350ms 窗口,旧判据 `interrupted = pump.active`
   *  把这段窗口当成「手动打断」⇒ 接续承诺被否 ⇒ 清 ring ⇒ 断粮。 */
  get naturalEnded(): boolean {
    return this.endedNaturally;
  }

  /** 本组共享流的 ③ 段音色片段(见 `dspPeerIdForGroup` / `WindowSource.dspFilters`)。
   *
   *  三处刻意取舍:
   *   ① **动态 import** `playerDsp.js` —— 它静态依赖 `group/index.js`(组管理器),
   *      而组管理器反向要读 sendspin 的实时音量镜像;静态引入会把这条链在模块加载
   *      期就绑死(与 `readSendspinStreamSource` 的"不许静态 import index.js"同因);
   *   ② 注入音源(测试)直接返回 `[]` —— 测试不该因为加了 / 没加音色配置而变形;
   *   ③ 读失败一律回退 `[]` —— `getPlayerDspConfig` 本身已"永不抛",这里再兜一层:
   *      音色是可选装饰,**绝不能因为它让整组放不出声**(与「读路径永不抛」同一纪律)。 */
  private async groupDspFilters(): Promise<string[]> {
    if (injectedSource) return [];
    try {
      const { playerDspFilters } = await import("../playerDsp.js");
      return playerDspFilters(dspPeerIdForGroup(this.group.name));
    } catch {
      return [];
    }
  }

  /** 播放一个音频缓冲:按组时间线切帧推送,推进 positionMs。
   *  `nextSongId`(S1 2026-11-01):队列下一首(只传 id),供曲末预解码;空 = 不预取。
   *  `seedRowId`(2026-11-04 P2):主进程 `judgePlayable` 已裁决出的可播源行,供**跨进程**
   *  首次起播直接复用(子进程的 playableCache 不跨 fork,不传就得多探一次)。 */
  async play(songId: string, nextSongId?: string, seedRowId?: string): Promise<void> {
    // seek 重建(同曲)沿用本曲的下一首提示;其余情况(切歌/新起播)按调用方为准。
    const keepNext = nextSongId === undefined && this.keepNextOnRebuild && songId === this.songId;
    this.keepNextOnRebuild = false;
    if (!keepNext) this.nextSongId = nextSongId ?? "";
    // 新曲起播:预填充窗口重新打开(旧曲的 settle 状态不能带过来)。
    this.prefillSettled = false;
    this.prefillFilling = false;
    // ★ P2 接续锚点:先快照上一曲自然播完的时间线尾,再清空 —— 一次起播只消费一次。
    //   手动切歌/seek 重建走 stop() 中断,不会写 lastContentEndUs ⇒ 快照恒为 null。
    this.continuityFromUs = this.lastContentEndUs;
    this.lastContentEndUs = null;
    // [P0 2026-11-24] 接续承诺与内容尾一起搬交:曲末定死,起播消费一次。
    this.continuityNext = this.continuityCommitted;
    this.continuityCommitted = false;
    // [P0 2026-11-24] 否决也一起搬交:起播侧/泵侧都按同一个结论走,不再二次求值。
    this.continuityNextDenied = this.continuityDenied;
    this.continuityDenied = false;
    // debug 日志开关起播这一拍刷新(fire-and-forget,**不 await** —— play 的起播时序
    // 有用例钉死(busy/取源次数),多一个宏任务都会破坏;刷新在取音源的数秒窗口内
    // 必然完成,首个事件(play.start 除外)记录时开关已就绪)。
    void refreshSendspinDebugEnabled();
    const source = injectedSource ?? defaultSource;
    this.srcFn = source;
    // ③ 段 per-播放器音色(P4):本组共享流的音色片段,起播算一次(改配置下一首生效)。
    // 注入音源(测试)不读该 opts ⇒ 既有测试零影响。
    const dspFilters = await this.groupDspFilters();
    this.dspFilters = dspFilters;
    // ★ 切歌/重播必须先释放上一首持有的解码窗口(内含 ffmpeg 子进程)。
    // 此前 `this.window = stream ?? null` 直接覆盖,旧 WindowStream 从未 close(),
    // 其 ffmpeg 变成孤儿永久存活 —— 实测每次切歌泄漏一个,240 现场堆积 10 个、
    // 存活 18~29 分钟、各占 ~65MB RSS,最终 CPU/内存争抢触发
    // "PcmWindow 等数超时(15000ms)" → idle_early 误判 → 再次切歌,恶性循环。
    // 必须在 await source() **之前**释放:source() 会立刻 spawn 新 ffmpeg,
    // 先杀旧的可以把瞬时双进程压到最短。
    this.releaseAudio();
    // ★ 世代守卫:连续 seek/切歌会并发进入多个 play(),它们在 await source() 处
    // 交错 —— 后到的 releaseAudio 杀不掉先到者**还没建出来**的 ffmpeg,先到者
    // 建出来后又覆盖 this.window,旧 ffmpeg 永久孤儿(240 实锤:同一组 -ss 与全量
    // 两个解码器并存)。epoch 必须在 await **之前**抢,回来后验世代,若已不是
    // 最新则亲手杀掉刚建的窗口(不能指望别人的 releaseAudio)并直接返回。
    const myEpoch = ++this.epoch;
    this.playInFlight = true;
    // 起播位置已知(pendingSeekMs)时直接交给音源工厂,让 ffmpeg 从一开始
    // 就带 `-ss` 起 —— 省掉「建流 → 再 seekTo → 再冷起」的整段空窗。
    const startMsForSource = alignFrameMs(this.pendingSeekMs ?? 0);
    // ★ S1(2026-11-01):预取就绪 ⇒ 整段采纳,跳过本次 source()(省一次 ffmpeg
    //   冷起 + 播放优选,边界空窗由 ring 里的预取帧覆盖)。
    //   采纳条件(任一不成立即丢弃预取,走原完整起播):
    //    ① songId 就是预取的那首(手动 next 到别的歌 / 换源重播 ⇒ 作废);
    //    ② 内容代次仍是预取登记的那一代(中途 seek/rehost/另一次换歌会 ++epoch);
    //    ③ 没有待消费的 seek:预取窗口起点是 0,带 seek 起播必须重新建流。
    const pf = this.takePrefetchFor(songId);
    if (pf) {
      if (this.pendingSeekMs === null && startMsForSource === 0) {
        this.commitPrefetch(songId, pf);
        this.playInFlight = false;
        return;
      }
      this.closePrefetch(pf); // 带 seek 起播:预取的「从 0 起」窗口不适用
    }
    // ★ 音源获取熔断(**仅 seek 重建**,首播不动):source() 内部任何一步没超时
    // 保护(resolve/取字节/预缓冲),永挂会导致整组静默(无帧、无报错、无 pushLoop),
    // 随后看门狗误判、子进程被杀。240 实锤:seek 重建后新 pushLoop 永远没起来,
    // 旧循环已按世代退出,组静默至死。首播不加(大文件全量解码可能合法地慢)。
    // 30s 熔断 → 抛错 → onPlayFailed 走跳过/换源愈合,绝不停在"半截 rebuild"。
    // ★ 源行复用:同曲重建优先用泵自己的记账(它一定是**本曲实际生效**的那行);
    //   新曲起播则用主进程透传的 `seedRowId`(judgePlayable 刚裁决的行)。
    //   两者都命中 `reuse-active`,跳过整段播放优选;取流失败的回退见下方 srcPromise。
    //   用户口径 ——「网络源/webdav 源跳转进度时应该自动复用正在播放的地址,
    //   不应该回退到查找播放源这一步」。都没有 → undefined,走完整裁决。
    const reuseRowId = songId === this.srcRowSongId ? this.srcRowId ?? undefined : seedRowId;
    const NEED_FUSE = startMsForSource > 0;
    const SOURCE_TIMEOUT_MS = 30_000;
    let srcResult: Awaited<ReturnType<typeof source>>;
    log.debug(`[pump][play] song=${songId} startMs=${startMsForSource} 开始获取音源${NEED_FUSE ? "(seek 重建,30s 熔断)" : ""}${reuseRowId ? ` 复用源行=${reuseRowId}` : ""}`);
    recordSendspinDebug("play.start", NEED_FUSE ? "起播(seek 重建)" : "起播", {
      songId, startMs: startMsForSource, reuseRowId: reuseRowId ?? null, seekRebuild: NEED_FUSE,
    });
    let srcTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const srcPromise = (async () => {
        try {
          return await source(songId, startMsForSource, { preferRowId: reuseRowId, dspFilters, speed: this.rate });
        } catch (e) {
          // 复用命中却出不了流(源行已失效/被删/上游不可达):清掉记账,回退**完整解析**
          // 重试一次。只重试一次 —— 再失败就交给既有 onPlayFailed 愈合(跳过/换源),
          // 不在此处循环(那会把「复用」变成「先白等一次 + 再慢一次」)。
          if (!reuseRowId) throw e;
          logSafe(
            this.server,
            "warn",
            `sendspin 复用源行取流失败,回退完整解析 song=${songId} row=${reuseRowId}: ${(e as Error)?.message || e}`,
          );
          this.srcRowId = null;
          this.srcRowSongId = "";
          return await source(songId, startMsForSource, { dspFilters, speed: this.rate });
        }
      })();
      srcResult = NEED_FUSE
        ? await Promise.race([
            srcPromise,
            new Promise<never>((_, reject) => {
              srcTimer = setTimeout(() => reject(new Error(`音源获取超时(${SOURCE_TIMEOUT_MS}ms)`)), SOURCE_TIMEOUT_MS);
            }),
          ])
        : await srcPromise;
    } catch (e: any) {
      logSafe(this.server, "error", `sendspin play 音源失败 song=${songId}: ${e?.message || e}`);
      if (this.epoch === myEpoch) this.playInFlight = false;
      throw e;
    } finally {
      if (srcTimer) clearTimeout(srcTimer);
    }
    log.debug(`[pump][play] song=${songId} 音源就绪 dur=${srcResult.durationMs}ms window=${!!srcResult.stream}`);
    const { pcm, durationMs, stream, sourceRowId } = srcResult;
    if (this.epoch !== myEpoch) {
      // 等待期间已有更新的 play() 接管:刚建出来的窗口是孤儿苗子,就地掐掉。
      try { stream?.close(); } catch { /* ignore */ }
      logSafe(this.server, "info", `sendspin play superseded song=${songId} (epoch ${myEpoch}→${this.epoch}),窗口已就地释放`);
      return;
    }
    // ★ 起播期间又到了新的 seek(seekCore 在起播窗口内只记 pendingSeekMs、不再起第二个
    //   play,见 6.6):刚建好的窗口基准是**旧起点**,与新的起播位置不符 —— 若照旧提交,
    //   窗口会拿「新位置之前」的音频当本位置的数据(或直接越界淘汰),实测表现为
    //   `流式窗口提前 EOF: eof=true decoded==baseSample` → contentEnded → 拖完不播。
    //   正确做法:关掉刚建的窗口,**带新起点重来一次**。递归是自限的 —— 重来那一轮
    //   的 startMsForSource 就是当前 pendingSeekMs,除非期间又来一次 seek(即新的一次拖动)。
    if (this.pendingSeekMs !== null) {
      // 用**本轮刚拿到的**新歌时长再钳一次:此刻 this.durationMs 可能还是上一首的。
      const durNew = durationMs > 0 ? durationMs : null;
      const rawWant = this.pendingSeekMs;
      const wantMs = alignFrameMs(durNew != null ? Math.min(rawWant, durNew) : rawWant);
      if (wantMs !== startMsForSource) {
        try { stream?.close(); } catch { /* ignore */ }
        log.debug(`[pump][play] song=${songId} 起播期间收到新 seek(${startMsForSource}→${wantMs}ms) → 带新起点重来`);
        // 重来那轮必须按**钳制后**的位置起,否则又读到未钳制的原始值(超尾 → 空流)。
        this.pendingSeekMs = wantMs;
        // 刚拿到的源行虽对应旧起点,但行本身有效(同一首歌) → 记账,让重来那轮直接
        // 命中 reuse-active,省掉一次完整播放优选(240 实测 2.0~2.4s)。
        if (sourceRowId) {
          this.srcRowId = sourceRowId;
          this.srcRowSongId = songId;
        }
        // 收敛保险:回写后下一轮 startMsForSource 必等于 wantMs(正常一次即收敛)。若异常
        // 情况下不收敛,到此为止 —— 每轮重来都会重新取一次音源(spawn ffmpeg),无限重来
        // 就是 CPU 与上游灾难;宁可提交当前窗口,也不打转。
        if (++this.playRetry <= 2) return this.play(songId, this.nextSongId || undefined);
        logSafe(this.server, "warn", `sendspin 起播自纠超限(2 次),按当前窗口提交 song=${songId}`);
      }
    }
    this.running = true;
    this.paused = false;
    this.pcm = pcm;
    this.window = stream ?? null;
    this.durationMs = Math.round(durationMs / this.rate);
    this.songId = songId;
    // 记下本轮生效源行,供同曲 seek 重建复用(见 srcRowId 字段说明)。
    // 注入音源(测试)可不回带 → 记为 null,下次重建照旧走完整裁决。
    this.srcRowId = sourceRowId ?? null;
    this.srcRowSongId = songId;
    this.playRetry = 0; // 起播成功:自纠计数归零。
    this.endedNaturally = false;
    this.group.current = { songId, durationMs, title: this.group.current?.title, artist: this.group.current?.artist, album: this.group.current?.album, coverArt: this.group.current?.coverArt };
    // 起播位置:消费起播窗口内到达的 seek(见 pendingSeekMs 注释)。
    // 绝不能无条件写 0 —— 那正是「刚点播就拖、拖动被吞」的根因。
    // 起播位置必须与 startMsForSource **同源**(同一对齐函数),否则窗口 base 与
    // 帧栅格游标又会错位(见 alignFrameMs 的硬约束说明)。
    const startMs = alignFrameMs(this.pendingSeekMs ?? 0);
    this.pendingSeekMs = null;
    this.playCursorMs = startMs;
    this.notePosBack("start", this.group.positionMs, startMs);
    this.group.positionMs = startMs;
    // 本轮上报下界 = 起播位置(见 reportedFloorMs 注释:正常起播为 0,
    // 带 seek 起播时为目标位置,防止刚发布的目标被可听位置拉低)。
    this.reportedFloorMs = startMs;
    // 可听前报 buffering(见 SendspinGroup.audibleStarted):起播即复位。
    this.group.audibleStarted = false;
    // 起播跳转已由音源工厂的 `-ss` 完成(见 startMsForSource),无需再 seekTo ——
    // 此处若再调一次会 kill 刚 spawn 的 ffmpeg 并重起,白白多一次冷起空窗。
    /** pacing 锚点对:起播位置 ⇄ 现在。带 seek 起播时锚点必须是 startMs,
     *  否则 dueMs 会按 positionMs(=startMs)算出一个远在未来的时刻(见 paceAnchorMs)。 */
    this.paceAnchorMs = startMs;
    this.paceAnchorWall = Date.now();
    this.playWallMs = Date.now();
    this.playContentMs = startMs;
    this.resumeWaiter = null;
    // 主循环不阻塞调用方(playMedia 需尽快返回,由 pollState 反映进度)。
    void this.pushLoop(myEpoch);
    // 已提交(running=true、窗口已挂上):起播窗口结束,此后 seek 走窗口内快路径。
    if (this.epoch === myEpoch) this.playInFlight = false;
  }

  /** 释放音频持有(整包缓冲 / 流式窗口＋ffmpeg 二选一,调用方无需区分)。 */
  private releaseAudio(): void {
    this.pcm = null;
    // ★ 热换源「在途/待提交」的窗口也必须一并释放:它**不在** `this.window` 里,
    //   漏了就是一个孤儿 ffmpeg(切歌/seek 抢先时 pendingSwap 从未被 pushLoop 消费)。
    //   close() 幂等,与 this.window 撞车时第二次为空操作。
    if (this.pendingSwap) {
      try { this.pendingSwap.win.close(); } catch { /* ignore */ }
      this.pendingSwap = null;
    }
    if (this.window) {
      try { this.window.close(); } catch { /* ignore */ }
      this.window = null;
    }
  }

  // ---- S1 预取态机(默认关;开关关闭时这些方法不会被调用) ----

  /** S1:该曲是否已有**当前代次可采纳**的预取(供 playCore/playGroupCore 决定曲边界
   *  是否清桥队列)。
   *
   *  为什么需要它:纯桥组没有直连成员 ⇒ `SendspinGroup.canKeepStream()` 恒 false
   *  (实现里 `members.size === 0 ⇒ false`),起播先走 `finishPlayback` ⇒ 桥收到
   *  `BOUNDARY{stop}` ⇒ RAOP FLUSH ⇒ 桥队列里的旧曲尾连同刚预解的下一首头**全部被清**
   *  (真机实测 `staleFrames=250618`,`track-keep-queue keptFrames=0`)。于是 S2 的
   *  keep-queue 永远拿不到东西,S1 跳过排空反而多砍了尾巴。
   *  有预取时改走 `clearPlayback`(= 只发 BOUNDARY{track},S2 保留队列),边界内容由
   *  预取帧按连续 ts 接续,旧曲尾自然播完。 */
  hasPendingPrefetch(songId: string): boolean {
    const pf = this.prefetch;
    if (!pf || pf.songId !== songId) return false;
    return typeof this.group.bridgeEpochNow === "function"
      ? this.group.bridgeEpochNow() + 1 === pf.epochAtStart
      : false;
  }

  /** 取走预取并校验:歌 id 必须一致,且内容代次仍是预取登记的那一代
   *  (不匹配 = 期间发生过 seek/rehost/另一次换歌 ⇒ 帧/窗口均不可信)。
   *
   *  ⚠️ 代次判据是 `now + 1 === epochAtStart`(预取帧写在**下一代次**,采纳时
   *  才由 pushLoop 重锚的 notifyBridgeGeneration ++ 到该代次)。写成 `now ===
   *  epochAtStart` 会让预取**永远**被弃用(采纳前代次尚未推进)。 */
  private takePrefetchFor(songId: string): NextTrackPrefetch | null {
    const pf = this.prefetch;
    this.prefetch = null;
    if (!pf) return null;
    const epochOk =
      typeof this.group.bridgeEpochNow === "function"
        ? this.group.bridgeEpochNow() + 1 === pf.epochAtStart
        : false;
    if (pf.songId !== songId || !epochOk) {
      logSafe(this.server, "info", `sendspin next-prefetch 弃用 song=${pf.songId}(期望 ${songId}) epoch=${pf.epochAtStart}→${typeof this.group.bridgeEpochNow === "function" ? this.group.bridgeEpochNow() : "-"}`);
      this.closePrefetch(pf);
      return null;
    }
    return pf;
  }

  /** 弃用预取:关窗口 + **把预取帧从 ring 移除**。
   *  ⚠️ 后者不可省:预取帧的 ep 是「下一代次」,一旦真的换代(seek/rehost/下一首
   *  起播),它们就会变成「当前代次」被投给桥 —— 那就是**上一首预解的错歌内容**。
   *  正常采纳路径不经过这里(见 commitPrefetch)。 */
  private closePrefetch(pf: NextTrackPrefetch): void {
    this.dropPrefetchFrames(pf);
    try { pf.audio.stream?.close(); } catch { /* ignore */ }
  }

  /** 把某代次的预取帧从 ring 移除(桩兼容:最小测试 group 无该方法)。 */
  private dropPrefetchFrames(pf: NextTrackPrefetch): void {
    if (typeof this.group.dropBridgePrefetchFrames === "function") {
      this.group.dropBridgePrefetchFrames(pf.epochAtStart);
    }
  }

  /** 采纳预取:跳过 source(),直接提交预解码窗口;首帧时间线锚点 = 预取起点。 */
  private commitPrefetch(songId: string, pf: NextTrackPrefetch): void {
    this.running = true;
    this.paused = false;
    this.pcm = pf.audio.pcm;
    this.window = pf.audio.stream ?? null;
    this.durationMs = Math.round(pf.audio.durationMs / this.rate);
    this.songId = songId;
    this.srcRowId = pf.audio.sourceRowId ?? null;
    this.srcRowSongId = songId;
    this.playRetry = 0;
    this.endedNaturally = false;
    this.group.current = {
      songId,
      durationMs: pf.audio.durationMs,
      title: this.group.current?.title,
      artist: this.group.current?.artist,
      album: this.group.current?.album,
      coverArt: this.group.current?.coverArt,
    };
    // 起播位置 = 0(预取就是从 0 解出来的);上报下界与 pacing 锚点同一起播语义。
    this.pendingSeekMs = null;
    this.playCursorMs = 0;
    this.notePosBack("prefetch-start", this.group.positionMs, 0);
    this.group.positionMs = 0;
    this.reportedFloorMs = 0;
    this.group.audibleStarted = false;
    this.paceAnchorMs = 0;
    this.paceAnchorWall = Date.now();
    this.playWallMs = Date.now();
    this.playContentMs = 0;
    this.resumeWaiter = null;
    // ★ 时间线交接点:ring 里已有 [startTsUs, +3s] 的预取帧,正片必须从同一 ts
    //   继续(否则同内容两套 ts,后被水位判重丢弃,边界后跳掉一段)。
    this.handoffTsUs = pf.startTsUs;
    logSafe(
      this.server,
      "info",
      `sendspin next-prefetch 采纳 song=${songId} startTsUs=${pf.startTsUs} durMs=${pf.audio.durationMs} window=${!!pf.audio.stream}`,
    );
    recordSendspinDebug("play.start", "起播(采纳下一首预取)", { songId, startTsUs: String(pf.startTsUs) });
    // 同理先移除预取帧(见 dropBridgePrefetchFrames):不清理则 ring 里「追加顺序 =
    // ts 递增」被未来的预取帧破坏 —— 投递侧扫到它就 break,之后追加的正片帧永远
    // 扫不到(边界后彻底断粮)。正片从同一 ts 重新产出同样内容,已投出的帧留在桥
    // 队列、水位按 ts 去重 ⇒ 采纳后重放无副作用。
    this.dropPrefetchFrames(pf);
    void this.pushLoop(this.epoch);
  }

  /** 取消预取(真实结束语义:stopCore/stopGroupCore/seek 调用)。
   *  ⚠️ 不放进 `stop()`:playCore/playGroupCore 是「stop() → play()」序列,
   *  在那里取消会把刚预取好的下一首直接扔掉。
   *  ⚠️ `keepNextHint`(2026-11-01 真机):**seek 只该丢掉已解的预取帧**,
   *  不该丢「下一首是谁」—— 清掉提示后同曲拖进度再播到曲末,预取就静默失效
   *  (实测日志 `next-prefetch 判定 next=-`,边界回到断粮)。 */
  cancelNextTrackPrefetch(keepNextHint = false): void {
    if (!keepNextHint) this.nextSongId = "";
    this.handoffTsUs = null;
    // P2:真实结束(stopGroupCore)与 seek 都经这里 ⇒ 接续锚点记账一并作废。
    //   (自然换歌不走这里,故上一曲尾记账得以保留给下一曲。)
    this.lastContentEndUs = null;
    this.continuityFromUs = null;
    const pf = this.prefetch;
    this.prefetch = null;
    if (pf) this.closePrefetch(pf);
  }

  // ---- P2/P3(2026-11-02)接续判定 ----
  //
  // 「接续」= 自然换歌时新曲首帧锚在**上一曲自然播完的时间线尾**上,而不是
  // 「墙钟 + lead」重新立一条时间轴。时间轴连续 ⇒ 桥侧不换代、不清队列、
  // 不发 BOUNDARY、旧曲余料与新曲首帧无缝相接 ⇒ 既不等 lead 静默,也不吞开头。
  // 下面四个方法是**同一口径的四次投影**,不要在别处再抄一份判断。

  /** 结构门:开关 + S2 保留队列 + 桥组(纯桥,或混合组已开灰度)。 */
  private continuityGates(hasBridges?: boolean, isPureBridge?: boolean): boolean {
    if (!BRIDGE_CONTINUITY_ANCHOR_ENABLED || !BRIDGE_TRACK_KEEP_QUEUE_ENABLED) return false;
    const hb = hasBridges ?? this.group.hasBridges?.() === true;
    if (!hb) return false;
    const pure = isPureBridge ?? this.group.hasDirectMembers?.() !== true;
    return pure || BRIDGE_CONTINUITY_MIXED_ENABLED;
  }

  /** 时间窗门:接续点不得太旧(中断/卡了很久)也不得太远(游标领先 = 预填充深度)。
   *  ⚠️ **未来**这一段不是静默 —— 它是上一曲尚未播完的尾巴,所以 MAX_WAIT 必须
   *  覆盖预填充深度(纯桥组实测曲末游标领先墙钟 ~15s,旧值 3s 因此恒不触发)。 */
  private continuityWindowOk(from: bigint | null): boolean {
    if (from === null) return false;
    const now = nowUs();
    const ageUs = Number(now - from);
    const waitUs = Number(from - now);
    return ageUs <= BRIDGE_CONTINUITY_STALE_US && waitUs <= BRIDGE_CONTINUITY_MAX_WAIT_US;
  }

  /** [P0 2026-11-24] 二次复核专用:只判「接续点是否已经太旧」,不判「太远」。
   *
   *  太远(waitUs)是**曲末那一刻**的事实(旧曲尾还没播完,接续点落在未来),必须在那
   *  一刻用 cursor 一次定死;换到起播/泵侧再算就换了求值时刻,临界点会翻转(240 实测
   *  35316ms vs 阈值 35000ms)。太旧(ageUs)才是二次复核真正要防的:曲末判完到真正
   *  起播之间若隔了很久(pause/队列阻塞),接续点已成为过去 ⇒ 必须放弃,否则新曲首帧
   *  锚到过去 ⇒ 全量追发/断粮。 */
  private continuityAgeOk(from: bigint | null): boolean {
    if (from === null) return false;
    return Number(nowUs() - from) <= BRIDGE_CONTINUITY_STALE_US;
  }

  /** 本曲是否值得**跳过曲末排空**:队列里有下一首,且下一轮起播会走接续。
   *  排空会把数秒静音写进 ring,随后 playerCore 的 `g.close()` 又清掉 ring ——
   *  接续点与新曲首帧都在这份 ring 里,排空/清理一旦发生,接续就无从谈起。 */
  private continuitySlotAvailable(): boolean {
    if (!this.continuityGates()) return false;
    const next = this.nextSongId;
    return !!next && next !== this.songId;
  }

  /** 主进程(playGroupCore)判定「这次起播能否接续上一曲」。
   *  与泵内同一套结构门 + 时间窗;额外排除两种已有精确时间轴的路径:
   *  seek(新时间轴,判据与 `armSeek` 完全一致 —— `0` 是「从头起播」不是 seek)与
   *  S1 预取(handoffTsUs 已经指向预取起点)。
   *  ⚠️ 必须与 pushLoop 里的 `continuity` 判定保持**同源**,两侧不一致会让边界
   *  消息与时间线锚点各走各的(轻则多一条 BOUNDARY,重则 ring 顺序被未来帧打断)。 */
  continuityReady(songId?: string, seekMs?: number | null): boolean {
    if (seekMs != null && alignFrameMs(Math.max(0, Math.round(seekMs))) > 0) return false;
    // [P0 2026-11-24] 曲末已经**按接续跳过排空**⇒ 这个承诺不可撤回:旧曲尾还在 ring
    // 里没排空,起播侧若在这里改判 false 就会 clearPlayback 把它清掉,而泵仍锚 contig
    // ⇒ 新曲首帧落到投递窗口之外(现场 now+33.3s vs 上沿 now+8.5s)⇒ 全组断粮。
    // 故先于 gates 返回(桥集合在 prepare/reconnect 瞬间会短暂翻 false,不能让它否决
    // 一个已经落地的承诺)。窗口复核仍保留在泵侧锚点判定里(那一侧才真正用它)。
    if (this.continuityCommitted) return true;
    // [P0 2026-11-24] 曲末已明确否决 ⇒ 不许在这里再算一次窗口把它翻回 true
    // (临界点翻转 ⇒ 与泵侧分叉,证据见 continuityDenied 字段注释)。
    if (this.continuityDenied) return false;
    if (!this.continuityGates()) return false;
    if (songId && this.hasPendingPrefetch(songId)) return false;
    // 未经过曲末承诺(手动切歌/无槽位)才走到这里;二次复核只判「太旧」不判「太远」
    // —— 太远由曲末那一拍用 cursor 一次定死。
    return this.continuityAgeOk(this.lastContentEndUs);
  }

  /** [P0 2026-11-24] 撤回「曲末跳过了排空」的接续承诺。
   *
   *  调用点 = 起播侧判定**不接续**(手动切歌 / seek / 窗口失效 / 主动换代)时:该路径
   *  会 `g.close({keepBridgeDelivery:false})` + `clearPlayback()` 把 ring 清空,旧曲尾
   *  不复存在 ⇒ 泵必须同时放弃 contig 锚点(回落到「墙钟 + lead」),否则新曲首帧被锚在
   *  一段已经不存在的时间线之后,投递窗口内一帧都没有,泵被 30s 背压钉死直到墙钟追上。
   *  幂等。 */
  dropContinuityHandover(): void {
    if (this.continuityCommitted || this.continuityNext) {
      logSafe(
        this.server,
        "warn",
        `sendspin 接续承诺撤回(ring 将被清空,放弃 contig 锚点) song=${this.songId}` +
          ` committed=${this.continuityCommitted} next=${this.continuityNext}`,
      );
    }
    this.continuityCommitted = false;
    this.continuityNext = false;
    this.continuityDenied = false;
    this.continuityNextDenied = false;
    this.continuityFromUs = null;
    this.lastContentEndUs = null;
  }

  /** 曲末预解码下一首:墙钟剩余 ≤ 5s 且满足「纯桥组 / 开关开 / 未预取」时启动。
   *  只解前 3s 写进下一代次 ring;解码窗口保持打开供采纳时正片续用。 */
  private maybeStartNextPrefetch(): void {
    const remainingMs = this.durationMs - this.playCursorMs;
    // ★ 判据必须是**墙钟剩余**,不能用游标剩余:桥是「预填充推流」,游标(已推送)
    //   比设备此刻正在播的位置整整领先一个缓冲深度(真机 13.3s)。按游标算,摇到
    //   ≤5s 时边界早已过去 ⇒ 预取永远晚于曲末排空判定(实测:就绪日志出现在
    //   contentEnded 之后,排空照样等 8s,边界一字未变)。
    const depthMs = Math.max(0, Number(this.group.timelineBaseUs - nowUs()) / 1000);
    const wallRemainingMs = remainingMs - depthMs;
    if (!nextTrackPrefetchEnabled()) return;
    if (this.prefetch || this.prefetchInFlight) return;
    const next = this.nextSongId;
    if (!next || next === this.songId) return;
    if (this.paused || this.pendingSeekMs !== null) return;
    if (this.durationMs <= 0) return;
    if (remainingMs <= 0 || wallRemainingMs > BRIDGE_NEXT_PREFETCH_TRIGGER_MS) return;
    // 仅纯桥组:混合组/直连组里 ring 的未来帧会被直连成员实时消费(与正片重复 ⇒
    // 直连端跳变),且它们的边界本来不靠预取;预取只服务「桥队列断粮」这一个故障。
    if (this.group.hasBridges?.() !== true || this.group.hasDirectMembers?.() === true) return;
    if (typeof this.group.pushBridgePrefetch !== "function" || typeof this.group.bridgeEpochNow !== "function") return;
    const source = this.srcFn ?? injectedSource ?? defaultSource;
    const startTsUs = this.group.timelineBaseUs + BigInt(Math.round(remainingMs * 1000));
    const epochAtStart = this.group.bridgeEpochNow() + 1;
    this.prefetchInFlight = true;
    logSafe(
      this.server,
      "info",
      `sendspin next-prefetch 开始 song=${next} 当前=${this.songId} remainingMs=${Math.round(remainingMs)} startTsUs=${startTsUs} epoch=${epochAtStart}`,
    );
    void (async () => {
      let audio: GroupAudio | null = null;
      try {
        audio = await source(next, 0, { dspFilters: this.dspFilters, speed: this.rate });
        const wantSamples = Math.floor((SAMPLE_RATE * CHANNELS * BRIDGE_NEXT_PREFETCH_CONTENT_MS) / 1000);
        let buf: Float32Array;
        if (audio.stream) {
          buf = await audio.stream.slice(0, wantSamples);
        } else {
          buf = audio.pcm.subarray(0, Math.min(audio.pcm.length, wantSamples));
        }
        if (buf.length === 0) throw new Error("预取音源无输出");
        const r = await this.group.pushBridgePrefetch(buf, startTsUs);
        // 写完再验代次:期间 seek/rehost 已 ++epoch ⇒ 帧落在过期代次,作废。
        if (this.group.bridgeEpochNow() !== r.nextEpoch - 1) {
          throw new Error(`预取代次已切换(now=${this.group.bridgeEpochNow()} 期望=${r.nextEpoch - 1})`);
        }
        this.prefetch = { songId: next, epochAtStart: r.nextEpoch, startTsUs, audio };
        logSafe(
          this.server,
          "info",
          `sendspin next-prefetch 就绪 song=${next} ts=${startTsUs}..${r.endTsUs} epoch=${r.nextEpoch}`,
        );
      } catch (e: any) {
        try { if (audio) this.closePrefetch({ songId: next, epochAtStart, startTsUs, audio }); } catch { /* ignore */ }
        // 失败一次即停用本曲预取:每帧重试会连起 ffmpeg(spawn 风暴)。
        this.nextSongId = "";
        logSafe(this.server, "warn", `sendspin next-prefetch 失败 song=${next}: ${e?.message || e}(本曲不再重试)`);
      } finally {
        this.prefetchInFlight = false;
      }
    })();
  }

  /** 设备此刻**正在播出**的媒体位置 = 已推送位置 − 仍排在设备缓冲里的量。
   *
   *  ⚠️ 为什么必须减:预填充(B1)把「已推送」和「已听到」拉开了整整一个缓冲深度。
   *  服务端按快于实时的速度把缓冲灌满,设备仍按实时播 —— 于是 `framePosMs` 一开局
   *  就已经是 10s,而扬声器才刚要出第一个字节。直接把已推送量当进度报,表现就是
   *  「10s 档开播瞬间进度条和歌词都显示 00:10」(2026-09-24 真机),声音却从头开始。
   *
   *  `cursorUs`(时间线游标)与 `nowUs()`(host monotonic)同源,相减即设备侧
   *  当前缓冲深度(微秒 → 毫秒)。
   *
   *  下界 `floorMs`:本轮已发布的目标(起播位置 / seek 目标)。可听位置低于它时取它
   *  —— 既有「开播显示 00:00」的修复效果(正常起播 floor=0),又保住 MA 的
   *  「拖动后立刻显示目标值」语义(见 reportedFloorMs 注释)。
   *
   *  边界:缓冲被抽干(卡顿/停滞)时深度变负 → 位置不得超过已推送量。 */
  private audiblePositionMs(pushedMs: number, cursorUs: bigint, floorMs: number): number {
    const depthMs = (Number(cursorUs) - Number(nowUs())) / 1000;
    // [2026-11-21] MUZO/Linkplay 系接收端(如 HiVi H5MKII)收到即播、不等 RTP 时间戳;
    //   而 depth 里含着「距离开播还有多久」那一段(桥 commandedLead ≈ 2.05s),
    //   把它也扣掉会让 UI 恒定落后一个 lead(240 实测 3~4 秒;抓包确认发送侧 1x 无积累)。
    //   只保留「还没送出去」的部分(ring + inQueue),lead 加回来。
    //   ⚠️ 将来接入严格按 ts 播的设备要按类型分流,不能一律加回。
    const audible = pushedMs - depthMs;
    if (audible > pushedMs) return pushedMs;
    return audible < floorMs ? floorMs : audible;
  }

  /** S7 背压重查间隔(ms)；测试注入 0 —— setTimeout(0) 仍让出事件循环，
   *  用例借此验证等待**不会同步自旋**（饿死事件循环 = 看门狗误杀，2026-09-22 教训）。 */
  headroomPollMs = 100;

  /**
   * 消费驱动产出（S7，广播改造最后一环）：内容前沿超前最落后消费游标超过上限
   * （30s，复用 `PUMP_LOOKAHEAD_DEFAULT_US`）⇒ **await 睡眠等待** —— 不是丢、
   * 不是拒（丢/拒只影响投递面，治不了前沿本身；paceBumpBus 闸门只拦「加速
   * 请求」，拦不住基础产出节奏）。
   *
   * 对标 MA（2026-11-25 核原文）：`playback.py:922
   * await push_stream.sleep_to_limit_buffer(_PRODUCER_BUFFER_LIMIT_US)`
   * （值 30s，playback.py:82）—— 生产者提交后缓冲超限即睡眠到低于上限再继续。
   * 差异：MA 的缓冲面是每成员 PushStream（水位由 aiosendspin 库内调度）；
   * 我们是共享环 + 广播投递，水位由 `group.pumpHeadroomUs()` 直查
   * （前沿 − 最落后消费游标，同进程零延迟）。
   *
   * 信号面取舍（任务书两案选 a）：a) 同进程直查 minCursor/watermarks —— 零延迟、
   * 单代码路径；b) bridgeHealth 跨进程转发 —— 粒度粗且多一跳。
   *
   * 世代守卫：等待期间 seek/切歌已 ++epoch 或 stop ⇒ 立即返回，由 pushLoop 的
   * 世代检查退出 —— 绝不能在旧代次上多睡一拍。
   */
  private async waitUntilContentHeadroom(myEpoch: number): Promise<void> {
    let waitedMs = 0;
    for (;;) {
      if (!this.running || this.epoch !== myEpoch) return;
      // 可选调用：最小测试桩没有该方法 ⇒ undefined ⇒ 视为不设限（桩组零影响）。
      const headroom = this.group.pumpHeadroomUs?.();
      if (headroom === null || headroom === undefined || headroom <= PUMP_LOOKAHEAD_DEFAULT_US) {
        if (waitedMs > 0) {
          logSafe(this.server, "info", `sendspin 泵背压解除 headroomMs=${headroom ?? "null"} 共等待=${waitedMs}ms song=${this.songId}`);
        }
        return;
      }
      if (waitedMs === 0) {
        logSafe(
          this.server,
          "warn",
          `sendspin 泵背压启动 headroomMs=${Math.round(headroom / 1000)} 上限Ms=${Math.round(PUMP_LOOKAHEAD_DEFAULT_US / 1000)} song=${this.songId}` +
            `（前沿超前最落后消费游标,暂停产出等待消费追上 —— 对齐 MA sleep_to_limit_buffer）`,
        );
      } else if (
        Math.floor(waitedMs / 60_000) !== Math.floor((waitedMs - this.headroomPollMs) / 60_000)
      ) {
        // [S7 复核加固] 持续 >60s ⇒ error：正常背压几分钟内必解除（消费以实时速率
        // 追 30s 差距）；超 60s 说明消费侧异常（典型 = 摘桥残留冻结游标污染 min），
        // 真机排障第一落点：grep bridge-cursor-jump / 检查 pumpHeadroomUs 的 min 来源。
        logSafe(
          this.server,
          "error",
          `sendspin 泵背压持续超 60s headroomMs=${Math.round(headroom / 1000)} 已等=${waitedMs}ms song=${this.songId}` +
            `（消费侧疑似异常:检查设备游标是否冻结/摘桥清理是否生效）`,
        );
      } else if (Math.floor(waitedMs / 2000) !== Math.floor((waitedMs - this.headroomPollMs) / 2000)) {
        logSafe(this.server, "info", `sendspin 泵背压中 headroomMs=${Math.round(headroom / 1000)} 已等=${waitedMs}ms song=${this.songId}`);
      }
      await new Promise<void>((r) => setTimeout(r, this.headroomPollMs));
      waitedMs += this.headroomPollMs;
    }
  }

  /** 推流主循环:按真实墙钟节奏取 PCM 段 → 编码 → 下发,时间戳按**实测样本数**推进。 */
  private async pushLoop(myEpoch: number): Promise<void> {
    // ⚠️ 必须是 `let`:倍速热切换(`switchRate`)在循环内换窗口引用,**不重建循环**
    //    (重建循环 = 重建泵 = 断点,与无缝目标互斥)。
    let win = this.window;
    const pcm = this.pcm;
    if (!win && !pcm) { this.running = false; return; }
    const frameSamples = Math.floor((SAMPLE_RATE * CHANNELS * FRAME_MS) / 1000);
    // 流式无全长:total 仅整包路径用,窗口路径靠 EOF＋耗尽结束。
    const total = win ? Infinity : Math.ceil(pcm!.length / frameSamples);
    let contentEnded = false;
    let endReason = "cursor-reached"; // 默认=播到元数据时长(1093 行分支)
    let linkDied = false; // 推帧中断(编码器/连接死亡):与自然结束同口径清组状态
    /**
     * 流式窗口「提前 EOF」且**交付时长明显短于声明时长** = 源被截断(2026-10-27 240 事故)。
     * 与 `contentEnded` 分开记:`contentEnded` 的语义是「本循环该收尾了」(它的消费者还有
     * 曲末排空/过渡复位/调试事件多处),本标记只回答「这次算不算自然播完」
     * —— 见退出块末尾 `endedNaturally = contentEnded && !truncated`。
     */
    let truncated = false;
    let firstFrame = true;
    // ---- 时间线锚点(第三次无声事故的修复核心)----
    // `timelineBaseUs` 此前是**死字段**(全仓无赋值点,恒 0),时间戳退化成
    // 「调度帧序号 × FRAME_MS」,与墙钟完全脱钩。实测:首块下发时解码已耗时
    // 7.4s,而 ts 只有 2200ms → 落后真实时间 5.2s;设备按
    // `(ts - send_ahead) - now` 判定「目标时刻早已过去」→ 立即吐字节 →
    // 缓冲永远空 → 持续 underrun → **日志全绿、PLAYING、进度正常,但无声**。
    //
    // MA 的模型(aiosendspin `server/push_stream.py:1313`,权威):
    //   `_channel_timing[ch] = now_us + self._min_send_ahead_us()`
    //   —— 首块锚点 = **当前墙钟 + 组公共 send_ahead**,与音频帧头里填的
    //   `send_ahead` 是**同一个量**。设备侧判据 `delta = (ts - send_ahead) - now`
    //   因此恰好 ≈ 0:首块到达时目标时刻刚好到来,不多不少。
    //
    // ⚠️ 曾用固定常量 FIRST_FRAME_LEAD_US(250ms)当锚点提前量 —— 那是把 MA 的
    // `DEFAULT_INITIAL_DELAY_US` 误当成与 send_ahead 无关的第二个常量。真机后果:
    // 设备全报 0 → 缺省 send_ahead=800ms,而锚点只提前 250ms →
    // `delta = (锚点) - 800ms - now = 250 - 800 = -550ms` **恒为负** →
    // 设备收到首块即判「目标时刻已过 550ms」→ 立即吐字节 → underrun → 无声。
    // 两者必须同源:send_ahead 变,锚点跟着变。
    let tsUs = this.group.timelineBaseUs;
    /** 本组当前时间线游标(微秒,绝对墙钟)。每次新流(含 seek 重建)从 0 起立,
     *  首帧锚点 = 墙钟 + send_ahead(MA `_resolve_channel_play_start` 的
     *  auto 模式:channel_timing 初始化为 now + min_send_ahead)。 */
    let cursorUs = 0n;
    /** 连续零产出的累计时长(微秒),用于区分「编码器正常攒样」与「编码器失效」。 */
    let starvationUs = 0;
    this.group.timelineBaseUs = 0n; // 起播重置:锚点在首块时按当时墙钟确立
    /** 本循环已消费到的 seek 重锚序号(与字段比较,见 timelineReseed 注释)。 */
    let consumedReseed = this.timelineReseed;
    /** 本循环已消费到的**倍速热切换**序号(与 `timelineReseed` 严格分离,见 rateSeq 注释)。 */
    let consumedRateSeq = this.rateSeq;
    /** 连续未让出宏任务的帧数(B2,见 YIELD_EVERY_FRAMES 注释)。 */
    let sinceYield = 0;
    /** 本轮最后一次「已推送」的媒体位置(曲末排空期间刷新上报进度用)。
     *  循环外可见:`framePosMs` 是循环内 const,排空代码在循环之后。 */
    let lastPushedMs = this.playCursorMs;
    /** 本轮上报下界。正常起播=0、带 seek 起播=目标位置;泵移交(rehost)与 seek 同理,
     *  **只可能在时间线重锚那一拍被改写**,故取值放在下面的重锚分支里同步刷新一次。 */
    let floorMs = this.reportedFloorMs;
    const yieldEveryN = async (): Promise<void> => {
      if (++sinceYield < YIELD_EVERY_FRAMES) return;
      sinceYield = 0;
      await yieldToEventLoop();
    };

    // 码率计量按首清零:压缩字节/秒只与 codec 有关,跨歌复用会让「上一首的
    // 码率」冒充「本首的码率」把容量换算算歪(见 SendspinGroup.encodedBytesPerSec)。
    // ⚠️ 全部用可选调用:单测里的最小 stub group 没有这些方法,直接调会抛。
    this.group.resetPushMeter?.();
    // 档位被设备容量钳制只提示**一次**(每首歌一次):日志里能看到「你选了
    // 30s,设备只能装 Ns」,而不是静默削弱 —— 排障时这是第一手证据。
    let cappedLogged = false;
    // 真实字节闸生效(占用达预算)也只提示**一次**(每首歌一次):证明「时长口径
    // 估计偏浅、已按真实排队字节闭环」——现场核对水位是否被字节闸压短就看这条。
    let byteGateLogged = false;

    try {
      while (this.running && this.epoch === myEpoch) {
        // 暂停时挂起,等待 resume。
        if (this.paused) {
          await new Promise<void>((r) => { this.resumeWaiter = r; });
          // ⚠️ resume 后必须把 pacing 锚点挪到当前墙钟:暂停期间墙钟照走,
          // 若不重置,dueMs 会全部落在过去 → delayMs≤0 → 积压帧被一次性倒给设备
          // (瞬间灌爆环形缓冲,设备再次失步)。以「当前已播位置」为锚点重新对齐。
          this.paceAnchorMs = this.playCursorMs;
          this.paceAnchorWall = Date.now();
          continue;
        }
        // ==================== 倍速热切换提交(§4.2 / A12) ====================
        // 为什么放在「取帧之前」:换源后 `playCursorMs` 已折算到新输出轴,同一拍的
        // `i/lo` 必须按新游标算,否则这一帧会从旧位置取数(内容倒退/超前)。
        //
        // ⚠️ 三条铁律(破任一条就退化成断点):
        //   ① **不碰** `epoch` / `timelineReseed` / `handoffTsUs` —— 任一变动都会让下方
        //      首帧分支走重锚 + notifyBridgeGeneration ⇒ 桥换代 ⇒ 断点;
        //   ② `this.rate` 与全部输出轴字段**同一条同步语句序列内**写完,中间不得 await
        //      —— 否则 pollCore 的 `posOut = positionMs × rate` 会有一拍跳变(客户端可见);
        //   ③ 时间戳**不重锚**:下方 `else { tsUs = cursorUs }` 原样接续,`cursorUs` 是
        //      按编码器实测样本数推进的绝对时间线,与 rate 无关 ⇒ ts 天然连续。
        if (this.pendingSwap && this.pendingSwap.seq !== consumedRateSeq) {
          const sw = this.pendingSwap;
          this.pendingSwap = null;
          // seek / 切歌先到 ⇒ 热换源作废:它们会整条重建,新窗口已失去意义
          // (此时 playCursorMs 已是另一条时间轴的语义,套用会算出错误落点)。
          // 第四条:建窗期间倍率被 `setPlaybackRate` 改过 ⇒ 换算系数 k 已失效。
          if (
            !this.running ||
            this.timelineReseed !== consumedReseed ||
            this.pendingSeekMs !== null ||
            Math.abs(this.rate - sw.prevRate) > 1e-9
          ) {
            try { sw.win.close(); } catch { /* ignore */ }
            logSafe(this.server, "info", `[pump][rate] song=${this.songId} 热换源作废(被 seek/切歌/再次改速抢先) seq=${sw.seq}`);
          } else {
            consumedRateSeq = sw.seq;
            const r0 = sw.prevRate;
            const r1 = sw.rate;
            const k = r0 / r1; // 输出轴换算系数(内容量不变 ⇒ 输出轴 = 内容 / 新倍率)
            // 新游标:提交时刻的前沿折到新轴,**绝不超过已预解码位置**(seekedOutMs)。
            // 落后于前沿的部分(几十 ms)由新窗口按序补解 —— 绝不倒退重播。
            const aheadOutMs = Math.max(0, this.playCursorMs) * k;
            const nextCursor = Math.min(sw.seekedOutMs, alignFrameMs(aheadOutMs));
            // ------- 原子段(此间禁止 await)-------
            this.rate = r1;
            this.playCursorMs = nextCursor;
            if (this.durationMs > 0) this.durationMs = this.durationMs * k;
            this.reportedFloorMs = this.reportedFloorMs * k;
            this.playContentMs = this.playContentMs * k;
            // 对外位置同为输出轴:不同拍换算 ⇒ pollCore 会看到 `旧位置 × 新倍率` 的一拍跳变。
            this.group.positionMs = this.group.positionMs * k;
            // 显示位置是**纯派生量**(不写历史最大值):同比换算即可保持连续。
            this.group.displayPositionMs = this.group.displayPositionMs * k;
            floorMs = this.reportedFloorMs;
            // pacing 锚点必须挪到当下:否则 dueMs 全部落在过去 ⇒ 帧无节制连发 ⇒ 灌爆设备环。
            this.paceAnchorMs = nextCursor;
            this.paceAnchorWall = Date.now();
            this.pendingSeekMs = null;
            const prevWin = win;
            win = sw.win;
            this.window = sw.win;
            // ------- 原子段结束 -------
            // ★ 旧窗口必须在这里**立刻**关掉:上面 `this.window` 已指向新窗口,旧对象
            //   再无引用;不关就是一条孤儿 ffmpeg 一直解码到曲末(240 真机实测:改速后
            //   `ps` 里同时挂着 1x 与 1.5x 两条解码进程,各吃一份 CPU/IO,而且旧的那条
            //   还占着上游连接)。
            //   放在原子段**之后**是刻意的:上面那几句同步赋值是「出口两量同源同拍」的
            //   保障(A12),`close()` 涉及 SIGTERM 与日志,不该挤进那段。
            try { prevWin?.close(); } catch { /* 已退/未起 */ }
            logSafe(
              this.server,
              "info",
              `[pump][rate] song=${this.songId} ${r0}x→${r1}x 已提交 内容Ms=${Math.round(sw.buildContentMs)} ` +
                `游标P1=${Math.round(nextCursor)}ms dur=${Math.round(this.durationMs)}ms 建窗=${sw.buildCostMs}ms ` +
                `pump=${this.epoch}/${this.timelineReseed}`,
            );
          }
        }
        const i = Math.floor(this.playCursorMs / FRAME_MS);
        const lo = i * frameSamples;
        let seg: Float32Array;
        if (win) {
          // ⚠️ 本拍窗口引用必须固定成局部常量:`win` 已是 `let`(倍速热切换会在循环内换
          //   引用),若 catch/EOF 诊断里直接读 `win`,可能读到**已被换掉的新窗口**,
          //   而这里的 `lo` 仍是按旧窗口坐标系算的 —— 贴齐值会算错(2026-11-25 引入)。
          const curWin = win;
          try {
            seg = await curWin.slice(lo, lo + frameSamples);
          } catch (e) {
            // 淘汰 == 回放点已不在窗口:只发生在 seekTo 重定位竞态里,
            // 重定位已完成,按新 position 重取即可。
            if (e instanceof WindowEvictedError) {
              // ★ 护栏(第三层防御):淘汰**必须伴随游标前进**,否则就是自旋。
              // 真机事故(2026-09-22):游标永远算在窗口 base 之前,slice 每次抛错 →
              // `continue` 用同一个游标重算 → 纯微任务死循环,事件循环饿死
              // (心跳/poll RPC 全停 → 看门狗 SIGKILL),日志连锚点都到不了。
              // 这里把落后于窗口基准的游标**贴齐**到基准(向上取到帧栅格):
              // 贴齐后 lo >= base,下一次 slice 必然成功 —— 保证每轮淘汰都朝前走。
              const baseMs = curWin.baseMs;
              const snapMs = Math.ceil(baseMs / FRAME_MS) * FRAME_MS;
              if (snapMs > this.playCursorMs) {
                logSafe(this.server, "warn", `sendspin 游标落后窗口基准,贴齐继续: ${this.playCursorMs}ms → ${snapMs}ms song=${this.songId}`);
                this.playCursorMs = snapMs;
                this.group.positionMs = snapMs;
                this.paceAnchorMs = snapMs;
                this.paceAnchorWall = Date.now();
              }
              continue;
            }
            // 超时/失败 → 外层 catch 停 pump(同整包解码失败语义,不静默)。
            throw e;
          }
          // EOF 耗尽(短片/空):与整包 `i >= total` 同义。
          if (seg.length === 0) {
            logSafe(this.server, "warn", `sendspin 流式窗口提前 EOF: lo=${lo} frame=${i} pid=${curWin.pid} eof=${curWin.eof} failed=${curWin.failedReason ?? "-"} decoded=${curWin.decoded} song=${this.songId}`);
            contentEnded = true; endReason = "stream-eof"; break;
          }
        } else {
          if (i >= total) { contentEnded = true; endReason = "decode-exhausted"; break; } // 解码耗尽
          seg = pcm!.subarray(lo, Math.min(lo + frameSamples, pcm!.length));
        }

        // 时间线锚点:首帧确立;seek 后重建(见 timelineReseed 注释)。
        // 两条路径共用同一段 —— 时间戳锚点与 pacing 锚点必须一次性同源重设,
        // 分开写迟早漂移(此前 pacing 在 seek 时完全没被重设,是"拖动后无声"的真凶)。
        if (firstFrame || this.timelineReseed !== consumedReseed) {
          const reseed = !firstFrame;
          // 只有**新曲首帧**才把显示位置归零。reseed(曲末泵移交/内部重锚)不清 ——
          //   排空期 positionMs 会因 depth 增长往下掉(实测 252→243),清掉就等于把显示
          //   往回拽 9 秒(用户报「临近结尾往后跳」)。seek 另有专门重置。
          // ⚠️ 判据挂在**组**上(group.displaySongId),不是泵实例字段:曲末泵换代
          //   (handover)会 new 一个 GroupPump,实例字段恒空 ⇒ 同名曲首帧再清一次显示,
          //   把「pin 到时长」的 185 打回真实排空位置 176(实测 11:51:44 回退 9s)。
          if (this.group.displaySongId !== this.songId) {
            this.group.displaySongId = this.songId;
            this.group.displayLeadMs = 0;
            this.group.displayPositionMs = 0;
            this.group.displayDepthMs = null;
            logSafe(this.server, "info", `[pump] display-reset song=${this.songId} reason=new-song`);
          }
          consumedReseed = this.timelineReseed;
          firstFrame = false;
          // ★ S1(2026-11-01):采纳下一首预取后的**首个锚点**必须是预取起点,不是
          //   墙钟 + lead —— ring 里已有同一内容、同一 ts 的预取帧,这里若另立锚点,
          //   后续帧的 ts 会与预取帧错位(水位按「ts ≤ 已投」判重 ⇒ 边界后跳掉一段)。
          //   只对首帧有效(reseed 即 seek 时恒为 null,由 seek()/armSeek 清空)。
          const handoffUs = this.handoffTsUs;
          this.handoffTsUs = null;
          // ★ 桥组判定(锚点 / 接续 / 边界语义共用;桩缺失 hasDirectMembers 按纯桥组,
          //   与既有 ③ 用例口径一致)。
          const hasBridges = this.group.hasBridges?.() === true;
          // 未承诺分支要回落旧结构门,故纯桥判定仍需保留(见下方 continuity 表达式)。
          const isPureBridge = hasBridges && this.group.hasDirectMembers?.() !== true;
          // ★ P2 接续判定:这一拍**同时决定桥边界语义** —— 满足接续时新曲接在上一曲
          //   自然播完的时间线尾上,桥侧不换代、不清队列、不发 BOUNDARY(见 server.ts
          //   notifyBridgeGeneration 的 continuity 分支),旧曲余料与新曲首帧无缝相接。
          const continuity =
            !reseed &&
            handoffUs === null &&
            // [P0 2026-11-24] 只有曲末**真的跳过了排空**并留下了旧曲尾,才允许接续锚点。
            // ring 已由起播侧清掉却仍锚 contig ⇒ 新曲首帧落在投递窗口之外 ⇒ 全组断粮
            // (见 continuityCommitted 字段注释的现场证据链)。两个决定必须同源。
            !this.continuityNextDenied &&
            // 三态(与起播侧 continuityReady 严格同源):
            //   granted  ⇒ 曲末已用 cursor 一次定死窗口,这里**不再过结构门**(桥集合在
            //              prepare/reconnect 瞬间会短暂翻 false,不能让它否决已落地的承诺);
            //   未承诺   ⇒ 曲末没走到跳过排空(无下一首槽位/预取路径),回落旧结构门 ——
            //              这条路上 ring 未必被清,接续依然成立(bridgePumpGeneration ③b);
            //   denied   ⇒ 上面 !continuityNextDenied 已短路为 false。
            (this.continuityNext || this.continuityGates(hasBridges, isPureBridge)) &&
            this.continuityAgeOk(this.continuityFromUs);
          // ★ 桥代次钩子(§4.3,唯一落点,BLK-02 不新增 bridgeTimelineReset):
          //   这里同时持有 myEpoch 与 this.group,一次覆盖 seek/track(epoch 变)与
          //   rehost(timelineReseed 变)。seek 时 epoch 跳 2、投递路径只见最终值,
          //   恰好只发一次 BOUNDARY;同代次重复触发由桥侧幂等。禁定时器轮询。
          //   S3:handoff 非空 = 预取就绪 ⇒ 该 track 边界不加垫片(见 server.ts)。
          //   P2:continuity = 接续 ⇒ 不换代/不发 BOUNDARY/不清水位(见 server.ts)。
          this.group.notifyBridgeGeneration?.(
            this.epoch * 1_000_003 + this.timelineReseed,
            reseed ? "rehost" : "track",
            handoffUs !== null,
            continuity,
          );
          // ★ 重锚这一拍同步刷新上报下界:泵移交(rehost)把下界改成目标落点,seek 把
          //   下界写成目标位置 —— 这里不取,移交后目标端的进度会从
          //   (落点 − 缓冲深度) 一路爬上来,看起来像"没对齐"。
          floorMs = this.reportedFloorMs;
          // ★ seek 后的墙钟空洞必须在这里补偿 pacing 锚点。
          // seek() 在拖动那一刻就写了 paceAnchorWall=Date.now(),但重起 ffmpeg
          // 到首帧产出实测要 5~7.4s;若不在此重设,dueMs 会全部落在过去 →
          // delayMs≤0 → 帧无节制连发(灌爆设备环形缓冲 → hard sync 插静音 →
          // 听感卡顿),同时时间线游标被快速推进 → 进度条比真实时间快
          // (实测 3.94s 内 pos 涨 8.875s)。pushLoop 此前只有 pause→resume
          // 路径做过这个补偿,seek 路径漏了。
          // 与下面的 timeline lead 互补:时间线锚点提前 3s 让设备攒缓冲,
          // pacing 仍按实时速率发帧。
          if (reseed) {
            this.paceAnchorMs = this.group.positionMs;
            this.paceAnchorWall = Date.now();
          }
          // 锚点 = 墙钟 + 组公共 send_ahead(MA 公式;与帧头同源,故 delta≈0)。
          const aheadUs = this.group.commonSendAheadUs();
          // ★ seek 后重锚必须比平时更深:空窗已经把设备缓冲耗尽,按 800ms 的
          // 浅缓冲继续推只会持续欠载。抬到 3s 让设备先攒够再播(见
          // SEEK_RESEED_LEAD_US 注释)。正常起播路径保持原语义不变。
          const reseedLead = Math.max(aheadUs, SEEK_RESEED_LEAD_US);
          // ★ 预填充(B1):锚点只留「真机验证可用的浅水位」,目标缓冲深度交给
          //   下方 fill 分支尽快灌满 —— 把「起播延迟」与「缓冲深度」彻底解耦。
          //   - 旧行为:lead = send_ahead ⇒ 想缓冲 10s 就必须静默 10s;
          //   - 新行为:lead = min(send_ahead, 800ms) ⇒ 起播延迟恒 ≈0.8s,
          //     缓冲深度由 pushLoop 顶到插件配置的 prefill_buffer_ms(默认 3s)。
          // ★ 桥接路由绕过 800ms 截断(MAJ-01/§3.4):桥成员上报的冷/热启动 lead
          //   只在 anchorLead 里生效,**绝不并入 commonSendAheadUs()** —— 帧头
          //   9B 不含 send_ahead,并进去会让真实 ESP32 恒定 +3.7s 偏移(回归断言
          //   钉住 commonSendAheadUs 不被污染)。warm/cold Phase 3 一律按 cold 保守
          //   (R2:未收到 CONFIG 回执前不作 warm 假设)。
          // ★ 深锚**仅纯桥组**(2026-10-26 E3 真机判决):组时间线是全员共享的,
          //   混合组(有直连 sendspin 成员)抬深锚点后,每次重锚(起播/seek/换曲/
          //   rehost)都对直连设备造成秒级时间戳跳变 —— esp32 硬同步阈值仅 5ms,
          //   240 实测 lead 10.58s → 直连端「有声-卡顿」交替可听;而桥侧对同一
          //   跳变按设计优雅消化 ⇒ 深锚收益只在纯桥组(无可听直连者)成立。
          //   混合组回落链(800ms 截断,v4.6.76 语义):首帧 ts' = ts − sendAhead
          //   ≈ wall+0.8s,低于桥投递窗口 FLOOR 1.5s → 该帧对桥跳过(水位推过),
          //   桥首个实收帧 ≈ wall+1.5~2.5s,planBridgeAnchor 按其可达性立锚
          //   (不可达 → warmLead 2.5s 自锚,bridgeSession.ts 设计内路径),
          //   aligner 中和 behind-anchor 内容。**代价 = 桥入组/重锚时多一次自锚**
          //   (对桥听感为一次设计内静默重锚),换直连成员时间线零跳变。
          //   桩兼容:最小测试桩无 hasDirectMembers → 按 undefined !== true 视作
          //   纯桥组(维持 2026-10-25 深锚语义,既有 ③ 用例不破)。
          //   非 bridge 路径行为零变化(三元分支原样保留)。
          // ★ 混合组也必须抬 lead(2026-10-26 真机:每首歌开头必丢)。原实现让混合组
          //   回落 800ms 截断 ⇒ lead = min(sendAhead 500ms, 800ms) = 500ms,而桥投递
          //   窗口下沿是 1.5s ⇒ 组开播就把「桥来不及排程」的前 1s 内容推过去,桥只能
          //   从窗口下沿接(水位推过),用户实测「SENDSPIN 已出声、AirPlay 还没声、
          //   整首开头丢」。抬到「下沿 + 一个补投周期」后首帧即落窗内 ⇒ 开头零丢失;
          //   代价 = 每首歌起播多等 ~1.25s(全组一致,组内同步与时间线语义不变,
          //   仍**不是** cold 深锚 4.5s —— 直连 esp32 不承受秒级跳变)。
          // ★ P1(2026-11-02)分档:track 边界(暖,桥会话原地续用)只等 2.5s;
          //   旧实现让 seek/rehost 吃冷 4.5s,已于 2026-11-10 改为暖档(见下)。
          //   `MF_BRIDGE_LEAD_MODE=fixed` ⇒ warm 恒 false,回到「任何边界都冷 4.5s」的旧行为(唯一回退口)。
          // ★ P3(2026-11-02):**纯桥组与混合组统一口径**,不再有独立的
          //   `mixed_anchor_lead_ms`。旧实现给混合组配 5s(前端弹窗逐组覆盖)换
          //   「切歌后全组静默 5s」来避开接收端就绪窗口 —— 那 5s 就是切歌慢的直接
          //   来源,也是前端「切歌延迟」手动入口的由来(已删)。
          //   现在:起播/手切/seek 一律抬锚(暖档 2.5s;仅 `MF_BRIDGE_LEAD_MODE=fixed`
          //   回退时仍是冷 4.5s —— 均 ≥ 桥投递窗口下沿 1.5s ⇒ 首帧必落窗内,不吞开头);
          //   **自然换歌**再由接续锚点
          //   接上一曲时间线尾 ⇒ 既不等 5s,也不吞开头。
          //   两道防线分工仍不可混:本分支 = 时间线锚点;切歌垫片
          //   (pendingTrackLeadUs,server.ts)= 桥侧投递整形。
          // ★ 2026-11-02(投递下沿全局上调 2.5s 后的配套):桥组的锚点 lead 必须
          //   ≥「下沿 + 一个补投周期」,否则新曲首帧 ts 落在下沿以下被直接跳过
          //   (水位推过)= 每首歌开头被吞。暖档 2.5s 恰好等于下沿 ⇒ 显式取
          //   floor + tick(2.75s),只对桥生效;直连 sendspin 路径不变。
          // ★ 2026-11-10(流转出声提速):seek/rehost 不再按 `reseed` 吃冷 4.5s。
          //   冷档原本兜的是「RAOP 握手 + 设备缓冲」,但桥会话由主进程
          //   `prepareBridgeRoute` **在起播前**已 await 建好(RECORD 完成)——
          //   reseed 重锚发生时,桥侧只剩 BOUNDARY 重锚,与 track 暖复用同量级
          //   (那一段已由切歌垫片按暖档 800ms 覆盖)。故停用冷档,统一暖档;
          //   下限仍是 floor + tick(2.75s),首帧必落投递窗口内,不会吞歌开头。
          //   实测收益:client→group 流转的 rehost 首帧从 ~4.5s 提前到 ~2.75s。
          // [2026-11-25 11:57] cold/warm 真实分档：进程内首次起播 = cold（4.5s 预热，
          // 让设备进入稳态后成员补偿才成立）；之后 = warm（2.5s，切歌/换歌保速度）。
          const bridgeWarm = !bridgeColdLeadPending;
          if (hasBridges) bridgeColdLeadPending = false;
          const anchorLead = hasBridges
            ? Math.max(
                aheadUs,
                bridgeStartLeadUs([{ warm: bridgeWarm }]),
                BRIDGE_PUSH_FLOOR_US + BRIDGE_PUSH_TICK_MS * 1000,
              )
            : prefillEnabled()
              ? Math.min(aheadUs, ANCHOR_SAFE_LEAD_US)
              : (reseed ? reseedLead : aheadUs);
          // ★ P2(2026-11-02)接续锚点:自然换歌不按「墙钟 + lead」重立,而是接在上一曲
          //   自然播完的时间线尾之后 —— 时间轴连续 ⇒ 桥侧不换代/不清队列,旧曲余料与
          //   新曲首帧无缝相接,可听静默只剩「解码真实空窗」。
          //   判据全部收在 continuityGates / continuityWindowOk(与边界语义同一份),
          //   此处只负责把接续点抬到桥投递可达线之上。
          let contigUs: bigint | null = null;
          if (continuity && this.continuityFromUs !== null) {
            // 接续点不得落进桥投递窗口下沿以内(桥来不及排程 ⇒ 丢开头),故取
            // 「上一曲尾」与「下沿 + 一个补投周期」的较大者。
            const deliverFloorUs = nowUs() + BigInt(BRIDGE_PUSH_FLOOR_US + BRIDGE_PUSH_TICK_MS * 1000);
            contigUs = this.continuityFromUs > deliverFloorUs ? this.continuityFromUs : deliverFloorUs;
            // ★ C(2026-11-03)空窗续静音:静音尾也是**已经投给桥**的时间线 ⇒ 新曲首帧
            //   不得落在它之前,否则 ts ≤ 已投水位,被 deliverBridgeWindow 跳过 = 开头被吞。
            const gapTailUs = this.group.currentBridgeGapFillTailUs?.() ?? 0n;
            if (gapTailUs > contigUs) contigUs = gapTailUs;
          }
          const lead = BigInt(Math.max(anchorLead, FIRST_FRAME_LEAD_US));
          // ⚠️ 锚点必须**严格大于已发出的最后一个时间戳**(= 此刻的 cursorUs)。
          // 时间线游标按 `round(produced/采样率)` 步进,与墙钟速率几乎相等但不完全相等:
          // 220 帧后两者会积累出 ±几十~几百 µs 的交叉(高压负载下实测 -21µs / -185µs),
          // 此时若无条件写成 `nowUs()+lead`,新时间戳会**比上一帧更小** → 时间轴倒退。
          // 设备端按时间戳排程,倒退是失序信号(虽远低于 hard-sync 阈值,但没理由让它发生)。
          // 取二者较大值即可:回跳只换内容,时间轴永不倒退;与真值的偏差仅数百 µs,
          // 相对 800ms 的 send_ahead 是噪声级,不影响 delta≈0 的锚点语义。
          // ★ S1:预取交接时锚点 = 预取起点;P2:自然接续时锚点 = 接续点;否则原公式。
          const anchor = handoffUs ?? contigUs ?? nowUs() + lead;
          const clamped = anchor > cursorUs ? anchor : cursorUs;
          this.group.timelineBaseUs = clamped;
          cursorUs = clamped;
          tsUs = cursorUs;
          // ★ C(2026-11-03)首帧已锚定 ⇒ 空窗续静音收工:此后 tick 若再推进静音尾,
          //   会把投递水位推过锚点 ⇒ 新曲开头被判「已投过」而静默跳过。
          this.group.endBridgeAutoTrackGap?.("next-track");
          logSafe(
            this.server,
            "info",
            reseed
              ? `sendspin timeline RE-anchored after seek: pos=${this.group.positionMs}ms base=${cursorUs} lead=${lead}us (sendAhead=${aheadUs}us)` +
                (clamped > anchor ? ` [clamped: wall=${anchor} ≤ cursor,已保单调]` : "")
              : `sendspin timeline anchored: base=${cursorUs} lead=${lead}us (sendAhead=${aheadUs}us)` +
                ` handoff=${handoffUs ?? "-"} contig=${contigUs ?? "-"} continuity=${continuity}` +
                ` lastEnd=${this.continuityFromUs ?? "-"}` +
                ` mode=${BRIDGE_LEAD_TIERED ? "tiered" : "fixed"} frameMs=${FRAME_MS} frameSamples=${frameSamples}`,
          );
        } else {
          tsUs = cursorUs;
        }

        // ★ S7(2026-11-25)消费驱动产出：每次向编码器/环提交**前**，若内容前沿超前
        //   最落后消费游标 > 30s（MA _PRODUCER_BUFFER_LIMIT_US 口径）就 await 睡眠。
        //   真机 23:17 教训：本循环此前只受环容量（**按条数** 1400）约束，广播开关
        //   开启后前沿 3 分钟涨到 +178s、窗口内一帧没有 ⇒ 设备饿死。paceBumpBus
        //   闸门只拦加速请求，拦不住基础节奏 —— 时间量反压必须落在提交点本身。
        //   放在锚点块之后：等待不影响首帧锚点语义（锚点用的墙钟在等待前取好，
        //   ts 按绝对时间线排程，晚推不晚播）；等待期间 pause/seek/stop 均有守卫。
        await this.waitUntilContentHeadroom(myEpoch);
        let produced = 0;
        try {
          // pushFrame 返回本批产出包所覆盖的**总样本数**(编码器实测,见 EncodedChunk)。
          // 用 Number() 归一:最小 stub group(测试)可能返回 undefined。
          produced = Number(await this.group.pushFrame(tsUs, seg)) || 0;
        } catch (e) {
          // ⚠️ 别静默吞:pushFrame 抛错(编码器/连接)时此前完全无日志,表现为
          // 「decode 完成后推流戛然而止、服务端看起来一切正常但设备无声」(2026-09-17 真机)。
          logSafe(this.server, "warn", `sendspin pushFrame 中断 @frame=${i}/${total} song=${this.songId}: ${(e as Error)?.message || e}`);
          // 根因修复(2026-10-08「月满西楼」群组永久卡死):旧注释说「状态由
          // QueueController 处理」,但 QueueController 只能经 poll 看状态 ——
          // current 残留时 pollCore 恒报 playing,队列层全被假在播骗住,无人处理。
          // 置 linkDied ⇒ 收尾段清 current(仅置空,不再 finishPlayback)
          // ⇒ poll 报 IDLE ⇒ auto-advance 正常跳歌自愈。
          linkDied = true;
          break; // 连接断开等:停止推流,收尾段清组状态。
        }
        // ⚠️⚠️ 本批无产出时**绝大多数情况下必须推进 0**(2026-09-17 实锤)。
        //
        // 曾经这里写着 `produced > 0 ? produced : seg.length / CHANNELS`,理由是
        // 「避免时间线停滞」—— 但这与块编码器(FLAC)的工作方式直接冲突:
        //   - libFLAC 块大小 **4096 单声道样本 = 85.33ms**,攒满才吐一帧;
        //   - 喂料粒度 FRAME_MS=25 → 每批仅 1200 单声道样本;
        //   - 于是约 3.4 批里只有 1 批有产出,其余样本在**编码器内部攒着**,
        //     此刻根本还没上网,时间线却照样按 1200 推进。
        // 一个周期累计推进 = 1200×3 + 4096 = 7696 样本 = 160ms,
        // 而真正到达设备的音频只有 4096 样本 = 85ms → **时间线超前约 75ms**。
        // 设备端实锤反复 `Lost sync (75006us off)` / `Regained sync`,听感一卡一卡。
        // 「编码器内部攒样」≠「音频已经上网」,时间线只认真正出门的字节。
        //
        // 但完全不推进有反风险:编码器真出故障(持续零产出)会把时间线**永久冻死**
        // → 后续所有包 timestamp 相同 → pump 永不结束、切歌卡住。
        // 故区分两者:正常攒样窗口只有一块(85ms),超过 STALL_GRACE_US 仍零产出
        // 才判定为「编码器异常」并降级按喂入量推进(宁可时间线略偏,不可流逝停摆)。
        // 临时诊断(2026-09-17 卡顿排查):设备 hard sync 阈值仅 5ms,需确认
        // 「ts 增量」与「真实墙钟增量」是否一致 —— 两者不一致正是失步源。
        if (this.dbgCount < 40) {
          this.dbgCount++;
          const nowU = Number(nowUs());
          if (this.dbgPrevWall && this.dbgPrevTs) {
            const dWall = nowU - this.dbgPrevWall;
            const dTs = Number(tsUs) - this.dbgPrevTs;
            if (process.env.SENDSPIN_JITTER === "1") {
              logSafe(this.server, "info", `[JITTER ${this.dbgCount}] dTs=${dTs}us dWall=${dWall}us diff=${dTs - dWall}us produced=${produced}`);
            }
          }
          this.dbgPrevWall = nowU;
          this.dbgPrevTs = Number(tsUs);
        }
        const frameStepUs = BigInt(Math.round((frameSamples / CHANNELS / SAMPLE_RATE) * 1_000_000));
        if (produced > 0) {
          starvationUs = 0;
          cursorUs += BigInt(Math.round((produced / SAMPLE_RATE) * 1_000_000));
        } else {
          starvationUs += Number(frameStepUs);
          if (starvationUs >= STALL_GRACE_US) {
            cursorUs += frameStepUs; // 降级:编码器疑失效,保流逝不断
            logSafe(this.server, "warn", `sendspin 编码器疑似失效:连续 ${starvationUs}us 零产出,时间线降级推进`);
            // ★ 降级不是无限期的:持续零产出超过上限 ⇒ 编码器已死(240 生产实锤:
            //   降级曾把剩余整首推成静音)。提前按自然播完收场 → 自动切下一首,
            //   新曲新建编码器即恢复(encoding.ts 侧另有重建/模块重载自愈)。
            if (starvationUs >= maxSilentDegradeUs()) {
              logSafe(this.server, "error", `sendspin 编码器持续零产出超过 ${Math.round(maxSilentDegradeUs() / 1000)}ms,放弃本曲提前切歌 song=${this.songId}`);
              contentEnded = true; endReason = "encoder-dead";
              break;
            }
          }
        }
        this.group.timelineBaseUs = cursorUs;

        const framePosMs = this.durationMs > 0
          ? Math.min(this.durationMs, i * FRAME_MS + FRAME_MS)
          : i * FRAME_MS + FRAME_MS; // 时长未知(流式元数据缺失):不钳制,
        // 否则 position 恒 0 → 同一片无限重推 ＋ pacing 永不 sleep,饿死事件循环
        this.playCursorMs = framePosMs;
        lastPushedMs = framePosMs;
        // ★ 上报进度必须是「设备此刻正在播」的位置,不能是「已推送」的位置
        //   (2026-09-24 真机:预填充 10s 档下,开播瞬间进度条与歌词直接显示 00:10,
        //    而声音明明从头开始 —— 已推送量比实际听到的多出整整一个缓冲深度)。
        //  取帧仍用 playCursorMs(已推送),只有对外上报走可听位置。
        {
          {
            const nextPos = this.audiblePositionMs(framePosMs, cursorUs, floorMs);
            this.notePosBack("push", this.group.positionMs, nextPos);
            this.group.positionMs = nextPos;
          }
          // [2026-11-21] 显示位置与判定位置分离:MUZO/Linkplay 系接收端收到即播、不等 RTP ts,
          //   所以「对外进度」要加回桥的 commandedLead(2.05s);而「唱完/切歌」判定必须用真实
          //   位置,否则曲末进度提前 2 秒撞到总时长 ⇒ 切歌等待 → 又拉回播放 → 真唱完才切。
          {
            // lead 按曲粘住(只升不降):曲末桥会话收尾瞬间 hasBridges() 翻 false,
            //   跟着翻 0 会让显示位置当场掉 2.05s。
            if (this.group.hasBridges?.() === true) this.group.displayLeadMs = AUDIBLE_DEVICE_LEAD_MS;
            const leadBack = this.group.displayLeadMs;
            // 显示位置 = 当前可听位置的**纯派生量**(+ 粘住的 lead,钳到时长)。
            //   不取历史最大值:positionMs 在曲内只前进(推送/排空都以内容时间为准),
            //   天然单调;取最大值反而让 seek 往回拖时进度条卡死。回退只有换曲/seek
            //   两个合法来源,各自由 displaySongId 与 seek 的显式复位负责。
            // 显示 = 设备**此刻在响**的位置 = (已推送 − 缓冲深度) + lead。
            //   不能用 positionMs:它被 floorMs 钳在 ≥0,而起播头 lead(2.05s)内
            //   pushed−depth 还是负的,钳 0 之后再加 lead ⇒ 进度凭空从 2s 起步
            //   (用户报「切歌到下一首,进度直接是 02 秒」)。这里取未钳值再加 lead,
            //   最后统一钳 [0, dur]:起播头 lead 秒显示 0.0→2.05,与真实出声同步。
            // [显示 2026-11-25] `cursor - now` 在换代/重锚时从 ~5.5s 突变成 0
            // (cursor 复位到 now) ⇒ 显示位置凭空 +5.5s ⇒ 被 capDisplayByElapsed 钳住
            // ⇒ 进度条停顿数秒(音频正常)。**限速跟随**: 每拍最多变 50ms, 突变抹平、
            // 真实缓冲缓变仍跟随; 换曲/seek 由 displayPositionMs=0 处一并清 null。
            const depthNowMs = (Number(cursorUs) - Number(nowUs())) / 1000;
            if (this.group.displayDepthMs === null) {
              this.group.displayDepthMs = depthNowMs;
            } else {
              const prev = this.group.displayDepthMs;
              const step = depthNowMs - prev;
              const MAX_STEP_MS = 50;
              this.group.displayDepthMs = prev + Math.max(-MAX_STEP_MS, Math.min(MAX_STEP_MS, step));
            }
            const depthMs = this.group.displayDepthMs;
            const raw = framePosMs - depthMs + leadBack;
            let capped = this.durationMs > 0 ? Math.min(this.durationMs, raw) : raw;
            capped = this.capDisplayByElapsed(capped);
            this.group.displayPositionMs = capped < 0 ? 0 : capped;
          }
        }
        // 加压执行：是否「需要补」已由投递侧判断（bridgePushTick 判 deliverable：
        //   超标 → reject 丢弃，否则 → approve 转入 approvedMs）。
        //   ⚠️ 必须取 takeApproved 而非 take：泵每 25ms 一拍、server 每 250ms 才检查，
        //   若泵直接 take 会把待审请求抢走，判据永远看不到它（2026-11-19 20:04 事故）。
        {
          const bumpMs = paceBumpBus.takeApproved();
          if (bumpMs > 0) {
            this.paceAnchorWall -= bumpMs;
            logSafe(
              this.server,
              "warn",
              `sendspin pace-bump ms=${bumpMs} ⇒ 泵多吐内容 song=${this.songId}`,
            );
          }
        }
        // 首次越过上报下界 ⇒ 已可听,解除 buffering(严格大于:等于 floor 时仍被钳位,不可分辨)。
        if (!this.group.audibleStarted && this.group.positionMs > floorMs) {
          this.group.audibleStarted = true;
          // 新曲**真正出声**这一刻上报主进程:主进程立刻放开封面延迟并广播状态,
          //   界面第一眼就是 00:00(不必等 400ms 观察器 + 子进程 RPC 回来,实测迟 1~2s)。
          try {
            // 上报值 = **起播下界**(floorMs):「刚越过下界」这一刻,设备播到的正是下界
            //   本身。新曲下界 = 0、seek 下界 = 目标 ⇒ 天然精确,不依赖任何外推。
            //   (用 positionMs/displayPositionMs 都不行:接续切歌的锚点落在过去时,
            //    两者一上来就是 1~2s,界面第一眼还是「02 秒」。)
            audibleStartSink?.(this.group.name, this.songId, Math.max(0, floorMs), this.durationMs);
          } catch { /* 上报失败不影响推流 */ }
        }
        // S1:曲末窗口内预解码下一首(开关关时立即返回,零开销)。
        this.maybeStartNextPrefetch();
        // ⚠️⚠️ 必须用**绝对时刻调度**,不能用「每轮固定 sleep(FRAME_MS)」(2026-09-17 实锤)。
        //
        // 固定 sleep 的致命缺陷:`await sleep(25)` 之外还有 encode/send/pushFrame 本身的开销,
        // 实际周期恒为 ≈26ms,而时间戳只按 25ms 推进 —— **每包落后 1~1.8ms 并无限累积**。
        // 实测 JITTER 诊断:
        //     dTs=25000us  dWall=26066us  diff=-1066us   ← 且每轮都是负的
        // 累积几百包后偏到 `-611ms`,设备端环形缓冲被抽干 → 反复进入 hard sync
        // (阈值仅 5ms)→ 往音乐里**插静音补空** → 听感「一卡一卡」。
        //
        // 绝对时刻调度:记录起播墙钟,每帧的到期时刻 = startWall + i*帧长/speed,
        // sleep 到**那个绝对时刻**。某轮处理慢了就自动少睡,把落后补回来;
        // 长期平均严格 = 实时,漂移不累积(这是 MA push_stream 的做法)。
        const dueMs = this.paceAnchorWall + (i * FRAME_MS - this.paceAnchorMs) / this.speed;
        const delayMs = dueMs - Date.now();
        // 设备侧当前缓冲深度 = 时间线游标已推进到哪儿 − 现在(墙钟)。
        // 卡顿/停滞期间墙钟照走而游标不动 → 深度被抽干,且旧行为**补不回来**
        // (按实时速率推,差值永远填不满) → 缓冲长期浅 → 持续卡顿。
        const depthUs = Number(cursorUs) - Number(nowUs());
        // ★ 档位 × 设备容量匹配:下拉里选的 `prefill_buffer_ms` 只是**期望值**,
        //   真正的目标水位还要受设备宣告的缓冲容量(压缩字节数)与 30s 时长上限
        //   钳制(见 SendspinGroup.capacityLimitedPrefillMs)。设备未宣告容量时
        //   上界就是 30s,行为与不引入本逻辑前完全一致。
        const capacityCapMs = this.group.capacityLimitedPrefillMs?.() ?? PREFILL_BUFFER_MAX_MS;
        const wantedMs = prefillTargetMs();
        const targetUs = Math.min(wantedMs, capacityCapMs) * 1000;
        // ⚠️ 等到**已有实测码率**再打:首帧时 pushedSamples 还是 0,码率走名义回落
        //   (FLAC 名义 134400B/s),打出来的实际秒数偏保守,会让人误以为「设备只能装这么点」。
        //   真机实测 105052B/s → 1.6MB 装 15.2s;名义值算出来只有 11.9s。
        if (!cappedLogged && wantedMs > capacityCapMs && this.group.hasMeasuredRate?.()) {
          cappedLogged = true;
          const capB = this.group.deviceCapacityBytes?.() ?? 0;
          const rateB = this.group.encodedBytesPerSec?.() ?? 0;
          const wantB = Math.round((capacityCapMs / 1000) * rateB);
          logSafe(
            this.server,
            "info",
            `sendspin 预填充水位按设备容量钳制:档位=${wantedMs}ms → 实际=${capacityCapMs}ms ` +
              `(设备 buffer_capacity=${capB}B, 实测码率=${Math.round(rateB)}B/s, ` +
              `目标占用≈${wantB}B=${Math.round((wantB * 100) / Math.max(1, capB))}%) song=${this.songId}`,
          );
        }
        // ⚠️ 两个必须的条件:
        //  ① 目标水位必须**严格大于**锚点(800ms)。选「0.8 秒(关闭预填充)」档时
        //     target == anchor,此时若用 `<` 比较,深度恒比目标少几微秒(取时刻差
        //     必然有耗时)→ 每帧都误判「未达标」→ 退化成全程爆推,实时配速失效。
        //  ② 留一帧的容差,避免在目标水位附近反复横跳。
        //
        // ★★ 真实字节闸(核心修复):上面的 `capacityCapMs` 是**时长口径**
        //   (`0.6·cap ÷ 实测平均码率`),只有在「窗口瞬时码率 == 整首平均码率」
        //   时才等于设备的真实占用。FLAC 瞬时码率随内容起伏(坑 B12),深档位
        //   (30s)撞上比平均码率更密的段落时,真实占用会超过估算并吃穿 0.6 余量
        //   → 设备逐帧拒收 + `SYNC LOST`(2026-10 生产:4.8MB/30s/60% 仍溢出,
        //   起播后约一个水位即开始 `Failed to send audio chunk`)。
        //   故再加一道以**真实累计压缩字节**为准的闸:由 SendspinGroup 从
        //   late-join 缓存里数「尚未播到的字节」(= 设备 `BufferTracker` 口径),
        //   达到 `cap × 0.6` 即停灌。设备未宣告容量时该闸关闭(行为与旧版一致)。
        const byteBudget = this.group.prefillByteBudget?.() ?? 0;
        const bufferedBytes = byteBudget > 0 ? (this.group.bufferedCompressedBytes?.() ?? 0) : 0;
        const byteOk = byteBudget <= 0 || bufferedBytes < byteBudget;
        if (!byteGateLogged && byteBudget > 0 && !byteOk) {
          byteGateLogged = true;
          const capB = this.group.deviceCapacityBytes?.() ?? 0;
          const rateB = this.group.encodedBytesPerSec?.() ?? 0;
          logSafe(
            this.server,
            "info",
            `sendspin 预填充按**真实排队字节**封顶:占用=${bufferedBytes}B ≥ 预算=${byteBudget}B ` +
              `(设备 buffer_capacity=${capB}B, 实测平均码率=${Math.round(rateB)}B/s) ` +
              `→ 停在较短水位(时长口径估计偏浅,已按字节闭环) song=${this.songId}`,
          );
        }
        const wantFill =
          prefillEnabled() &&
          targetUs > ANCHOR_SAFE_LEAD_US &&
          depthUs < targetUs - FRAME_MS * 1000 &&
          byteOk;
        // ★ 起播预填充窗口的退出点,供服务端开环检测豁免灌水阶段。
        //   注意:设备不消费时 `depthUs` 是**服务端自己**的游标(照实时推进),
        //   wantFill 会恒 true ⇒ 光靠这条信号永远判不出本故障,server.ts 侧
        //   另设 60s 硬回退(见 SINK_WATCH_PREFILL_MAX_MS)。
        if (wantFill) this.prefillFilling = true;
        else if (this.prefillFilling) {
          this.prefillFilling = false;
          this.prefillSettled = true;
        }
        if (wantFill) {
          // ★ 预填充 / 回补:缓冲未达目标水位 → **不 sleep**,尽快灌。
          //   - 起播:一次灌到目标水位,而起播延迟仍只有锚点的 0.8s;
          //   - 卡顿后:编码器/音源恢复时自动把被抽干的缓冲补回来。
          await yieldEveryN();
          // 灌满后把 pacing 锚点挪到当下,之后严格按实时速率推进(水位维持)。
          this.paceAnchorMs = i * FRAME_MS;
          this.paceAnchorWall = Date.now();
        } else if (delayMs > 0) {
          await sleep(delayMs);
          sinceYield = 0; // 睡过一轮等于已经让出,计数归零
        } else {
          // ★ B2:落后时也必须让出**宏任务**。
          // 原本这里什么都不做 → 整条 pushLoop 在 await 链上退化成微任务自旋:
          // Node 在每个宏任务边界会把微任务队列**完全排空**,而 ws 的 I/O 回调
          // (含设备发来的 client/time)属于宏任务 —— 于是落后期间 client/time
          // 永远排不上队 → 设备侧 `Time message N/8 timed out` → 重同步 → 卡顿。
          // 对齐 MA:connection.py 每 50 次迭代强制 `asyncio.sleep(0)`。
          await yieldEveryN();
        }
        // 元数据时长与实际解码长度常差几十 ms:解码偏长时 i 永远到不了 total,
        // positionMs 又被 clamp 在 durationMs → 同一尾帧无限重推、永不结束。
        // 到达元数据时长即视为播完(退出后 endedNaturally 照常置空 current 触发切歌)。
        // 注意 break 必须在 sleep 之后(保持旧 pacing):提前跳过末帧 sleep 会打乱
        // 乐观窗口/自然结束的时序判定,导致切歌变重播(见 queueModes 回归)。
        if (this.durationMs > 0 && this.playCursorMs >= this.durationMs) { contentEnded = true; break; }
      }
      logSafe(this.server, "info", `sendspin pushLoop 退出: contentEnded=${contentEnded} endReason=${endReason} running=${this.running} epochSame=${this.epoch === myEpoch} song=${this.songId}`);
      if (this.epoch === myEpoch) {
        // ==================== 提前 EOF 判据（2026-10-27 240 生产事故） ====================
        //
        // 事故：插件源（web/汽水音乐）声明 276s，实际只吐出 ~30s 的音频就 EOF。流式窗口
        // 路径**从不比较「已交付时长 vs 声明时长」**（完整性判官只在「整曲字节到手」的
        // membuf 路径跑，流式窗口走不到），于是 `contentEnded=true / endReason="stream-eof"`
        // 被当成**自然播完** → 置空 current → auto-advance → 单曲循环下回到同一首 → 每 30s
        // 重播一次。这里补的就是这条判据：**交付不足 = 源坏，不是播完**。
        //
        // 已交付时长的口径（优先顺序，都是播放侧实测，不用 metadata）：
        //   ① 已解码样本数 `win.decoded`：窗口累计解出的**交错样本**（48k × 2ch），
        //      故除 `SAMPLE_RATE * CHANNELS` —— 只除 SAMPLE_RATE 会大 2 倍，把截断漏掉。
        //   ② `lastPushedMs`：本循环最后一次**推送**到的媒体位置（整包/窗口都维护），
        //      等价于「已按实测码率交付了多少秒」。
        //   ③ 两者都拿不到（0）⇒ **不判**：没有交付证据就不许判死（同「不把不知道当成死的」）。
        // 判据：`声明 − 已交付 > ap2TruncateMissingSec()`（默认 80s，理由见 prefetchConfig）。
        // 差 ≤ 80s（正常曲目的末端抖动 + 设备缓冲）⇒ 一个字不改，走原自然播完路径。
        if (contentEnded && endReason === "stream-eof") {
          const deliveredSec =
            win && win.decoded > 0
              ? win.decoded / (SAMPLE_RATE * CHANNELS)
              : lastPushedMs > 0
                ? lastPushedMs / 1000
                : 0;
          const expectedSec = this.durationMs > 0 ? this.durationMs / 1000 : 0;
          const missingSec = expectedSec - deliveredSec;
          if (expectedSec > 0 && deliveredSec > 0 && missingSec > ap2TruncateMissingSec()) {
            truncated = true;
            // 结构化 warn（字段固定，便于 grep / 守卫钉住）：ev + song + 三个秒数 + endReason。
            logSafe(
              this.server,
              "warn",
              `sendspin stream-truncated ev=stream-truncated song=${this.songId} ` +
                `expectedSec=${Math.round(expectedSec)} deliveredSec=${Math.round(deliveredSec)} ` +
                `missingSec=${Math.round(missingSec)} endReason=${endReason}`,
            );
            // 负缓存：出流侧（换源/探测）与队列 judgePlayable 都读这一份。
            // 动态 import 防环（sendspin ← source/online 的 registry/plugins 依赖链）。
            // 唯一一处 await：只在判死这一拍发生，每首歌最多一次。
            try {
              const { markUnplayable } = await import("../source/online/streamFallback.js");
              markUnplayable(this.songId);
            } catch (e: any) {
              logSafe(this.server, "warn", `sendspin stream-truncated: 记负缓存失败(已忽略): ${String(e?.message || e).slice(0, 120)}`);
            }
            // ★ 跨进程回传:子进程这份负缓存主进程看不见,必须经 IPC 让主进程再记一次
            //   (详见本文件「判死跨进程回传」段)。clientId 取组名:单设备组名就是裸 clientId,
            //   用户组则是 `ug:<gid>` —— 主进程侧只用 songId/reason,组名仅供日志溯源。
            // ★ 跨进程回传:子进程这份负缓存主进程看不见,必须经 IPC 让主进程再记一次
            //   (详见本文件「判死跨进程回传」段)。回传口由 pumpFor 装填。
            try {
              if (!this.onUnplayable) {
                // 🔴 最危险的失败模式:判死了但**没人回传** ⇒ 主进程永远不知道,bug 原样复现
                //   (与 2026-10-28 事故同型)。绝不静默 —— 每首歌最多报一次。
                if (!this.warnedNoSink.has(this.songId)) {
                  this.warnedNoSink.add(this.songId);
                  logSafe(this.server, "warn", `sendspin stream-truncated: 判死回传口未装填,主进程不会同步记负缓存 song=${this.songId}`);
                }
              }
              this.onUnplayable?.(
                this.songId,
                `stream-truncated 期望${Math.round(expectedSec)}s 实际${Math.round(deliveredSec)}s`,
              );
            } catch (e: any) {
              logSafe(this.server, "warn", `sendspin stream-truncated: 判死回传失败(已忽略): ${String(e?.message || e).slice(0, 120)}`);
            }
          }
        }

        // ★ 曲末排空(深缓冲):必须等设备把缓冲里的音频播完,再收流。
        // 协议规定 stream/end 会让客户端**清空缓冲** —— 不等就发,设备里还排着
        // 若干毫秒没播的音频会被直接砍掉。旧行为(800ms)砍掉 800ms 无人察觉,
        // 缓冲抬到秒级后必须补这一步。
        // 只等「超出旧水位的那部分」:尾部截断量保持与旧行为一致(800ms),
        // 新增的切歌间隙恰好 = 预填充水位 − 800ms。
        // ⚠️ 必须在 running=false **之前**完成:外部(单测 waitInactive / 看门狗)
        // 一看到 inactive 就会去读 group.current,而排空期间它还没置空,
        // 会被误判成「已停却仍在播」。
        // ★ S1:预取已就绪时**跳过曲末排空**。预取帧已按「本曲末 = 新曲首」的连续
        //   ts 占住 [cursorUs, +3s];排空期再给桥续静音会与预取帧时间重叠(同一段
        //   时间线两套内容),且排空本身就是为了等旧内容播完 —— 边界已由预取帧衔接,
        //   再等只是把下一首整体推后。预取只发生在纯桥组(见 maybeStartNextPrefetch)。
        // ★ S1:预取尚未就绪但**仍在解码**时先等它(上限 BRIDGE_NEXT_PREFETCH_WAIT_MS)。
        //   触发窗口内预取总是与本曲末同一拍(见 maybeStartNextPrefetch 的墙钟判据),
        //   解码要 0.4~0.9s,而推流循环灌完剩余内容只要几十毫秒 ⇒ 不等这一拍,预取
        //   "就绪"永远发生在排空判定之后,排空照等 8s、边界一字未变(真机实测)。
        //   等到了就由下面的「曲末排空跳过」整段跳过;等不到(解码失败/超时)回到原路径。
        if (contentEnded && !this.prefetch && this.prefetchInFlight) {
          const waitAt = Date.now();
          const waitUntil = waitAt + BRIDGE_NEXT_PREFETCH_WAIT_MS;
          while (Date.now() < waitUntil && !this.prefetch && this.prefetchInFlight) {
            await sleep(100);
          }
          logSafe(
            this.server,
            "info",
            `sendspin 曲末:等下一首预取就绪 ${this.prefetch ? "成功" : "超时"} ` +
              `used=${Date.now() - waitAt}ms 上限=${BRIDGE_NEXT_PREFETCH_WAIT_MS}ms song=${this.songId}`,
          );
        }
        if (contentEnded && this.prefetch) {
          logSafe(
            this.server,
            "info",
            `sendspin 曲末排空跳过:下一首预取已就绪 song=${this.songId} next=${this.prefetch.songId} ` +
              `startTsUs=${this.prefetch.startTsUs}`,
          );
        }
        // ★ P2(2026-11-02):**接续换歌必须跳过曲末排空**。排空会把数秒静音写进 ring,
        //   随后 playerCore 的 `g.close()` 又清掉 ring —— 接续点(上一曲内容尾)与新曲
        //   首帧都在这份 ring 里,清掉就没有「连续时间轴」可言。接续时旧曲尾仍按 250ms
        //   补投窗口继续投给桥(旧曲自然播完),不需要再让服务端干等。
        const continuityDrainSkip = contentEnded && !this.prefetch && this.continuitySlotAvailable();
        // [P0 2026-11-24 单一产地] 接续承诺在这里一次性定死,后续两处(起播侧
        // `continuityReady` / 泵侧 contig 锚点)都只读它,不再各判一套。
        // 窗口判据在此刻用 `cursorUs` 求值 —— 跳过排空后它就是 `contentTailUs`
        // (= 下一轮 `lastContentEndUs` 的取值),与泵侧锚点判定同源同值。
        this.continuityCommitted = continuityDrainSkip && this.continuityWindowOk(cursorUs);
        // [P0 2026-11-24] granted / denied 同时定死:跳过排空但窗口不过 ⇒ 明确否决,
        // 后续任何人都不许再算一次窗口(见 continuityDenied 字段注释)。
        this.continuityDenied = continuityDrainSkip && !this.continuityCommitted;
        if (continuityDrainSkip && !this.continuityCommitted) {
          // 承诺落不下去(上一曲尾离得太远)⇒ 必须留痕:此时照旧跳过排空,但下一曲
          // 不会接续锚点,边界会清队列 —— 这是「宁可整段换时间线也不吞」的取舍,
          // 不允许静默发生(与 drain-fill 的三选一留痕同纪律)。
          logSafe(
            this.server,
            "warn",
            `sendspin 接续承诺被时间窗否决:尾=${cursorUs} now=${nowUs()} ` +
              `差=${Math.round(Number(cursorUs - nowUs()) / 1000)}ms song=${this.songId}`,
          );
        }
        if (continuityDrainSkip) {
          logSafe(
            this.server,
            "info",
            `sendspin 曲末排空跳过:接续下一首 continuity=1 next=${this.nextSongId} ` +
              `endUs=${cursorUs} song=${this.songId}`,
          );
        }
        // ★ P3(2026-11-02):曲末续静音也是**内容尾**的一部分 —— 它是真实写进 ring
        //   并被投给桥的帧。接续锚点必须落在静音之后,否则下一曲首帧的 ts 与静音
        //   区间重叠:桥先收到静音、水位推过 ⇒ 新曲开头被判「已投过」直接跳过
        //   (可闻=开头被吞)。无排空时与 cursorUs 同值,行为零变化。
        let contentTailUs = cursorUs;
        if (contentEnded && !this.prefetch && !continuityDrainSkip) {
          // ⚠️ 除以 speed:设备侧的播出同样按倍率走(SENDSPIN_PUSH_SPEED 快进时,
          // 缓冲里的音频会以 speed 倍速播完),不折算会在快进用例里白等几十秒。
          const rawDrainMs =
            (Number(cursorUs) - Number(nowUs()) - ANCHOR_SAFE_LEAD_US) / 1000;
          // ★ 纯桥组(有桥 **且** 无直连成员,判据与上面锚点分支同一口径):桥的投递窗口
          //   下沿是「现在 + 1.5s」,故桥**结构上拿不到**距此刻不足
          //   `BRIDGE_END_DRAIN_MARGIN_MS`(扣掉排空公式已减的 ANCHOR_SAFE_LEAD 之后)的那段
          //   内容(§6.2 水位推过)⇒ 承诺排空它纯属白等(真机实测白等 1.72s,表现为换歌处
          //   RTP 完全静默 3~7s);再以桥队列硬上限兜顶(排空期间 pushLoop 已退出、队列只进不出)。
          //   ⚠️ 混合组/纯直连组**必须原值**:直连 sendspin 设备的缓冲真有 ~9.78s,提前 advance
          //   会被 BOUNDARY{track} 的 player.flush() 砍掉尾巴(见上方「只等超出旧水位的那部分」)。
          const pureBridge =
            this.group.hasBridges?.() === true && this.group.hasDirectMembers?.() !== true;
          const drainCap = capEndDrainMs(rawDrainMs, pureBridge);
          const extraDrainMs =
            Math.min(drainCap.drainMs, PREFILL_BUFFER_MAX_MS) / (this.speed > 0 ? this.speed : 1);
          if (prefillEnabled() && extraDrainMs > 0) {
            // 只在**真的发生钳制**时打(否则每首歌都刷一条噪声日志)。
            if (drainCap.clamped) {
              logSafe(
                this.server,
                "info",
                `sendspin 曲末排空:纯桥组,排空量按桥投递上界钳制 ` +
                  `${Math.round(drainCap.contentMs)}ms → ${Math.round(drainCap.drainMs)}ms song=${this.songId}`,
              );
            }
            logSafe(
              this.server,
              "info",
              `sendspin 曲末排空:等设备播完缓冲 ${Math.round(extraDrainMs)}ms 后再收流 song=${this.songId}`,
            );
            // 分段等待而不是一次睡到底:每步按墙钟刷新上报进度,让进度条/歌词
            // 平滑走到曲末。一次睡到底会让进度停在 durationMs 之前,拖后自动切歌判定。
            const drainStepMs = 200;
            // ★ A 方案:排空期间本循环不再产出 PCM,桥侧 `pullChunk` 只能等 waitDataMs
            //   超时后每秒吐一块静音 ⇒ RTP 从 125pps 掉到约 1pps(接收端长时间近零速率
            //   会被判假死/重锚)。这里**每步**给桥续一段与其等长(且同起点)的静音帧,
            //   总量严格等于实际排空时长(多补会让桥收到超出内容尾的静音)。
            //   判据:开关(MF_BRIDGE_DRAIN_SILENCE,缺省 ON)+ 组上有该能力(最小测试桩无
            //   → 自动退化,与 `hasBridges?.()` 同风格)。两个条件分开存,只为了**可观测**:
            //   跳过时必须能一眼分辨「开关关了」/「桩没有该方法」/「方法在但桥集合是空的」。
            const silenceSwitchOn = bridgeDrainSilenceEnabled();
            const hasFillApi = typeof this.group.pushBridgeOnlySilence === "function";
            const canFillSilence = silenceSwitchOn && hasFillApi;
            let fillTsUs = cursorUs;
            let fillMs = 0;
            let fillChunks = 0;
            for (
              let left = Math.min(extraDrainMs, PREFILL_BUFFER_MAX_MS);
              left > 0;
              left -= drainStepMs
            ) {
              // 🔴 stepMs 必须是**正整数**:`extraDrainMs` 是浮点(µs 差 /1000,真机
              //   实测 14180.15899999999965),最后一步的 `left` 会带着小数尾巴,直接
              //   拿去 `BigInt(stepMs * 1000)` 会抛 TypeError("not an integer") ⇒
              //   pushLoop 异常终止,且崩在 `ev=bridge-drain-fill` 那行日志之前(真机
              //   2026-11 首夜实锤,14180ms 排空那首)。
              //   - `Math.ceil` 而非 `Math.round`:① 恒得正整数,BigInt 转换不可能抛;
              //     ② ceil 让最后一步**吞掉**小数尾巴,不会出现 `left=0.16` 时 round→0
              //     的 `sleep(0)` + `push(0µs)` 空转步(`pushBridgeOnlySilence` 对
              //     `durUs<=0` 返回 0,白跑一次循环);
              //   - 代价:总排空量最多多 1ms(相对于 14s 量级完全无意义)。
              const stepMs = Math.min(drainStepMs, Math.ceil(left));
              await sleep(stepMs);
              {
                const nextPos = this.audiblePositionMs(lastPushedMs, cursorUs, floorMs);
                this.notePosBack("drain", this.group.positionMs, nextPos);
                this.group.positionMs = nextPos;
                // 排空期显示位置也要跟着走(否则整段停在推完那一刻,曲末少走 9s)。
                //   与推送循环同一口径:加粘住的 lead、钳到时长、只升不降。
                if (this.group.hasBridges?.() === true) this.group.displayLeadMs = AUDIBLE_DEVICE_LEAD_MS;
                // 与推送循环同一口径:未钳的可听位置 + lead,再钳 [0, dur]。
                const depthDrainMs = (Number(cursorUs) - Number(nowUs())) / 1000;
                const rawDisp = lastPushedMs - depthDrainMs + this.group.displayLeadMs;
                let cappedDisp = this.durationMs > 0 ? Math.min(this.durationMs, rawDisp) : rawDisp;
                cappedDisp = this.capDisplayByElapsed(cappedDisp);
                this.group.displayPositionMs = cappedDisp < 0 ? 0 : cappedDisp;
              }
              if (!this.group.audibleStarted && this.group.positionMs > floorMs) this.group.audibleStarted = true;
              if (canFillSilence) {
                fillChunks += this.group.pushBridgeOnlySilence?.(fillTsUs, stepMs * 1000) ?? 0;
                fillTsUs += BigInt(stepMs * 1000);
                fillMs += stepMs;
              }
            }
            // 真有续静音写进 ring ⇒ 内容尾后移(静音尾也属于桥时间线)。
            if (fillMs > 0) contentTailUs = fillTsUs;
            // ★ 每首歌**恰好一行**(不是每步),且**三选一必须都留痕** —— 绝不允许静默:
            //   2026-11 真机教训:排空期 `fillChunks` 恒 0 而一行日志都没有,A/B 连续两次
            //   被误判成「公式错」,真因是 `pushBridgeOnlySilence` 内部 `bridges.size === 0`
            //   直接 return 0(桥压根没挂上,见 G2)。字段固定便于 grep:
            //   - `ev=bridge-drain-fill`        真的补了,带 dev / bridges / durMs / chunks;
            //   - `ev=bridge-drain-fill-skip`   没补,`reason=disabled|no-api|no-bridge`,
            //     并带 bridges/members/gid(no-bridge 时就是「组里没有桥」的直接证据)。
            const bridgesN = this.group.bridges?.size ?? 0;
            const membersN = this.group.members?.size ?? 0;
            if (fillChunks > 0) {
              const devs =
                typeof this.group.bridges?.keys === "function"
                  ? [...this.group.bridges.keys()].join(",")
                  : "";
              logSafe(
                this.server,
                "info",
                `sendspin 曲末排空:桥续静音 ev=bridge-drain-fill dev=${devs || "-"} ` +
                  `bridges=${bridgesN} durMs=${Math.round(fillMs)} chunks=${fillChunks} song=${this.songId}`,
              );
            } else if (!canFillSilence) {
              logSafe(
                this.server,
                "info",
                `sendspin 曲末排空:桥续静音跳过 ev=bridge-drain-fill-skip ` +
                  `reason=${silenceSwitchOn ? "no-api" : "disabled"} bridges=${bridgesN} song=${this.songId}`,
              );
            } else {
              logSafe(
                this.server,
                "info",
                `sendspin 曲末排空:桥续静音跳过 ev=bridge-drain-fill-skip ` +
                  `reason=no-bridge bridges=${bridgesN} members=${membersN} ` +
                  `gid=${this.group.name} song=${this.songId}`,
              );
            }
          }
        }
        this.running = false;
        // 语义：**自然播完**才置 true。提前 EOF 且交付严重不足（truncated）= 源坏，
        // 不是播完 —— 置 false 让「上报边播边测」等消费者别再把它当好曲
        // （见下方 finally 里的 `natural && win`）。
        // ⚠️ 注意 `contentEnded` 本身**不动**：它回答的是「本循环该收尾了吗」，
        // 曲末排空 / 过渡复位 / 调试事件都依赖它（改成 false 会让设备缓冲被砍、
        // 甚至让 poll 永远报 PLAYING —— 见下面过渡复位那段的判据）。
        this.endedNaturally = contentEnded && !truncated;
        // ★ P2:只有**自然播完**才记时间线尾(供下一曲接续锚点)。手动切歌/中断经
        //   stop() 打断,根本走不到这里 ⇒ 下一曲的 continuityFromUs 恒为 null,
        //   「manual 不透传到泵」也就不会误接续(与 D6 的手动语义天然一致)。
        // ★ P3(2026-11-02):必须取**内容尾**(含已写进 ring 的曲末续静音),不能再用
        //   `cursorUs`。续静音占 `[contentEnd, contentEnd+fill]` 且随 ring 保留到下一
        //   曲起播,若锚点仍落在静音**之前**,下一曲首帧的 ts 会与静音区间重叠:
        //   桥的水位早已推过那段(静音已投过)⇒ 首帧被判「已投过」直接跳过 ——
        //   可闻就是「吞歌开头」。无排空时 contentTailUs === cursorUs,行为零变化。
        if (this.endedNaturally) this.lastContentEndUs = contentTailUs;
        // ★ C(2026-11-03)换歌空窗续静音:自然播完且还有下一首时,从内容尾起由桥侧
        //   每 tick 按 25ms 片续静音到窗口下沿,直到下一首首帧到达(`next-track` 收工)。
        //   上游取源/解码空窗期 ring 不再断料 ⇒ RAOP 维持 1x;否则 producer 只能按
        //   `waitDataMs`(1s)吐一块 8ms 静音,240 实测换歌处 RTP maxGap 4008ms。
        //   · 手动切歌走 stop() 中断,走不到这里(continuityFromUs 也恒 null);
        //   · 预取已就绪/在飞时下一首内容马上进 ring,续静音会与预取帧同 ts 重叠 ⇒ 不介入。
        if (
          this.endedNaturally && this.nextSongId !== ""
          && !this.prefetch && !this.prefetchInFlight
        ) {
          this.group.noteBridgeAutoTrackGap?.(contentTailUs);
        }
        recordSendspinDebug(
          linkDied ? "play.link_died" : contentEnded ? "play.finished" : "play.stopped",
          linkDied
            ? "推帧中断(编码器/连接死亡),组状态已清"
            : contentEnded
              ? "播放自然结束(解码 EOF/耗尽)"
              : "播放被打断(stop/切歌/世代更替)",
          { songId: this.songId, cursorMs: this.playCursorMs, durationMs: this.durationMs, linkDied },
        );
        try {
          // 自然播完 → 置空 current,让 pollState 上报 IDLE → PlaybackTracker auto-advance。
          // linkDied(推帧中断/链路死亡)同样清 current —— 否则 pollCore 恒报
          // playing(pos 冻结在死亡点),队列层永久假在播(「月满西楼」卡死根因)。
          // ★ MA 对齐(2026-10-19):这里**不发** stream/end、也**不报** stopped ——
          //   spec 把 stream/end 保留给「队列空/真正结束」(MA player.py:1454),
          //   自动切歌是「取消+续流」:过渡期只由起播侧发一条 stream/clear。
          //   终态收尾(队列放完 / 用户 stop)统一由 stopCore → finishPlayback 发
          //   stream/end + group/update(stopped),与 MA group.stop() 唯一产地一致。
          // ⚠️ 判据用 `contentEnded` 而**不是** `endedNaturally`：后者在「提前 EOF 截断」
          //   时被置 false（不是自然播完），但过渡复位**照做不可**省略 —— 不置空 current
          //   ⇒ pollCore 恒报 playing ⇒ 队列既不切歌也不重投，整组卡死在「PLAYING pos=60s」。
          //   语义分工：contentEnded 管「收尾+切歌」，endedNaturally 管「算不算好曲」。
          if (contentEnded || linkDied) {
            // MA `metadata_role.freeze_progress()` 等价(MA playback.py 的
            // `_stop_push_stream(snapshot_progress=...)`):清 current 前先把该曲时长
            // 冻结到组上 —— pollCore 的 durationMs 兜底读它,让曲终的 UI 停在
            // 「当前时间 4:22 / 总时长 4:22」,而非清 current 后总时长归 0:00。
            // 位置(positionMs)本就不在此清零,故「冻结」只需补时长这一个维度。
            this.group.frozenDurationMs = this.group.current?.durationMs ?? Math.round(this.durationMs * this.rate);
            // ★ S1(2026-11-01 真机):自然播完时把上报位置**钉到时长**。
            //   「曲末排空跳过」会在设备真正播完前若干秒收尾,此时 positionMs 仍停在
            //   起播点(实测 seek 到 67s / 时长 76s ⇒ 一直上报 pos=67)。PlaybackTracker
            //   的「IDLE 但位置远未到时长」判据会把它当成误报(idle_early),再叠加 seek
            //   冷静期(8s)⇒ 既不 advance 也不 stalled(真机实测卡 20s 后 stall 重投)。
            //   内容确实已到结尾,上报时长即真实终态;非自然结束(截断/链路死亡)不动。
            if (this.endedNaturally && this.durationMs > 0) {
              // positionMs 钉到时长 = 喂给 tracker 的「已到结尾」判据(idle_early 会拦下
              //   「IDLE 但位置远未到时长」)。**只钉判定值**:显示值是纯派生量,让它停在
              //   真实可听位置,下一首起播按 displaySongId 归零 —— 否则 185 这个"将来的数"
              //   会在泵换代那一刻被打回 176(用户报的曲末回退 9s)。
              this.group.positionMs = this.durationMs;
            }
            this.group.current = null;
          }
        } finally {
          // 整首音频到此无用,立即释放(长曲上百 MB),不等下一首覆盖。
          // 放 finally:finishPlayback 抛错(最小 stub 组/嵌入式场景)也不能跳过释放,
          // 否则整包 PCM/流式 ffmpeg 永久残留。
          const win = this.window;
          const songId = this.songId;
          const natural = this.endedNaturally;
          this.releaseAudio();
          // P0-4 sendspin 落点:自然播完(ffmpeg 正常 EOF,末尾打出 loudnorm JSON)
          // 时上报边播边测;stop/异常/时长钳制(ffmpeg 被杀,无 JSON)解析失败即 false。
          if (natural && win) {
            void (async () => {
              try {
                const { reportPlaybackLoudness } = await import("../audio/analysisStore.js");
                reportPlaybackLoudness(songId, win.stderrText());
              } catch { /* 入库失败不影响切歌 */ }
            })();
          }
        }
      }
    } catch (e) {
      // 外抛异常(解码失败/源不可播等)同样不能静默,否则推流停摆无迹可循。
      logSafe(this.server, "warn", `sendspin pushLoop 异常终止 song=${this.songId}: ${(e as Error)?.message || e}`);
      recordSendspinDebug("play.aborted", `pushLoop 异常终止: ${(e as Error)?.message || e}`, { songId: this.songId });
      this.running = false;
      // 根因修复(2026-10-08 240「月满西楼」群组永久卡死):异常死亡旧代码只置
      // running —— group.current 残留 ⇒ pollCore `playing: !!g.current` 永远 true
      // ⇒ 主进程 pollState 永远 PLAYING pos=0 uri=- ⇒ tracker/QueueController 被
      // 假在播状态骗住,既不重投也不切歌。与自然结束分支同口径:清 current(过渡复位,
      // 只发 stream/end 不报 stopped)⇒ poll 上报 IDLE ⇒ auto-advance 走既有跳歌自愈
      // (失败矩阵:显式失败 ⇒ 跳下一首取新流)。releaseAudio 同样必须做,否则
      // 整包 PCM/流式 ffmpeg 残留(与自然路径 finally 同理)。
      try {
        // MA 对齐:异常终止同样只做「过渡复位」—— 只发 stream/end 收尾旧流,**不报**
        // stopped(silentState),避免固件把 group/update→stopped 镜像成 IDLE 闩锁;
        // 终态(队列放完)仍由 stopCore 走默认 finishPlayback(带 stopped)。
        this.group.frozenDurationMs = this.group.current?.durationMs ?? Math.round(this.durationMs * this.rate);
        this.group.current = null;
        this.group.finishPlayback({ silentState: true });
      } catch { /* 最小 stub 组无 finishPlayback 时忽略 */ }
      this.releaseAudio();
    }
  }

  /** 软停止(当前帧后不再推;置空 current,供 stop/切歌打断)。 */
  stop(): void {
    this.epoch++;
    this.running = false;
    this.playInFlight = false; // 起播在飞也算被打断:不清会让标志永久为真,后续 seek 全被跳过。
    this.playRetry = 0; // 上一段播放上下文已丢弃,重来计数跟着归零。
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    // 起播窗口内的 seek 归属**上一首**:stop 意味着这段播放上下文已被丢弃,
    // 若不清,playCore 的 "stop → 起播新曲" 序列会把上一次拖动带到新曲上。
    this.pendingSeekMs = null;
    // S1:旧上下文的预取交接点一并作废(否则新起播会误用上一段的时间线锚点)。
    this.handoffTsUs = null;
    // 旧曲音频立即释放(切歌瞬间,不等新解码覆盖):整包清引用,流式杀进程。
    this.releaseAudio();
  }

  /** 显示位置的上界:内容起点 + 已流逝墙钟 × 倍速 —— 不可能"听到"比这更多。
   *  只在上界更小时生效(稳态下可听位置总是更小,行为不变),专治接续切歌时
   *  时间线锚点落在过去导致的「新曲第一眼 01~02 秒」。 */
  private capDisplayByElapsed(dispMs: number): number {
    if (!(this.playWallMs > 0)) return dispMs;
    const speed = this.speed > 0 ? this.speed : 1;
    const capMs = this.playContentMs + (Date.now() - this.playWallMs) * speed;
    return dispMs > capMs ? capMs : dispMs;
  }

  /** 位置回退观测:对内 positionMs 的任何向下跳都留痕(只诊断,不改取值)。 */
  private notePosBack(src: string, prev: number, next: number): void {
    if (prev > 0 && next < prev - 500) {
      logSafe(
        this.server,
        "warn",
        `[pump-pos-back] src=${src} ${Math.round(prev)}->${Math.round(next)} song=${this.songId}` +
          ` cursor=${Math.round(this.playCursorMs)} dur=${Math.round(this.durationMs)}` +
          ` started=${this.group.audibleStarted} disp=${Math.round(this.group.displayPositionMs)}`,
      );
    }
  }

  pause(): void {
    this.paused = true;
    this.pausedAtMs = Date.now();
  }

  resume(): void {
    if (!this.paused) return;
    // [2026-11-21] 暂停期间桥把内存队列一次推给设备(实测 7.86s)并播完,而 cursorUs
    //   停在暂停时刻 ⇒ 恢复后新内容 ts 已落后墙钟,设备收到即播/丢弃 ⇒「每秒卡一下」。
    //   超过阈值就重建时间线(与 rehost/seek 的重锚路径同源)。
    const pausedMs = this.pausedAtMs > 0 ? Date.now() - this.pausedAtMs : 0;
    this.pausedAtMs = 0;
    if (pausedMs > PAUSE_RESEED_MS) {
      this.timelineReseed++;
      // 重锚只是把时间线平移到「现在 + lead」,不改变「这首已经在出声」的事实;
      // 不清这一位,恢复后会出现一段假的 BUFFERING(测试 queueModes 也据此断言)。
      this.group.audibleStarted = true;
      // 上报下界保底 = 暂停时的位置:重锚把 cursor 推到 now+lead,若内容量还不足一个
      // lead(短曲/测试),audible 会被算成 0 ⇒ 进度条从 0 跳回。保底后只会原地不动。
      this.reportedFloorMs = Math.max(this.reportedFloorMs, this.group.positionMs);
      logSafe(
        this.server,
        "info",
        `[pump] resume 重建时间线 pausedMs=${pausedMs} reseed=${this.timelineReseed}`,
      );
    }
    this.paused = false;
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  /** 跳转进度 —— **MA 权威语义**(music_assistant/controllers/player_queues/controller.py
   *  `seek` @862,逐条对齐,不自创机制):
   *    ① `queue.elapsed_time = position; elapsed_time_last_updated = now; signal_update()`
   *       → 这里对应 `group.positionMs = targetMs`(推送循环每帧重写它,取帧用自有
   *       游标 playCursorMs,互不干扰 —— MA 的推流引擎同样从不读 elapsed_time 取帧)。
   *    ② `await self.play_index(queue_id, current_index, seek_position=position)`
   *       → **整条流重建,走与正常起播完全相同的路径**(停旧流 → stream/end 成对 →
   *       全新音源带 seek 起点起流 → 新时间线锚点)。这一步由 playerCore.seekCore
   *       调 playCore/playGroupCore 完成;pump 只负责 ① 与空闲态的位置记忆。
   *  MA 没有「帧边界无缝换流」;设备端缓冲自然耗尽后接新流,听感即 MA 真机行为。 */
  seek(seconds: number, opts?: { clamp?: boolean }): void {
    // 入参是**内容秒**（QueueController/客户端语义），泵内部是输出流毫秒 ⇒ 除以倍速。
    const wantMs = Math.max(0, Math.round((seconds * 1000) / this.rate));
    // opts.clamp=false 时**不做时长钳制**:起播窗口内 `durationMs` 可能还是上一首的
    // (新歌的 play 尚未提交),据此钳制会把目标裁短 —— 240 实测:切歌后拖到 140s,
    // 被上一首的 114s 裁成了 114s。此时先记原始位置,由本轮 play() 拿到新歌时长后收口
    // (见 GroupPump.play 的起播期间 seek 分支)。
    const targetMs = opts?.clamp !== false && this.durationMs > 0 ? Math.min(this.durationMs, wantMs) : wantMs;
    // ★ 帧栅格对齐:发布/记忆的位置必须与 PcmWindow 的 baseSample 同源
    //   (见 alignFrameMs —— 目标不是 25ms 整数倍时子进程会微任务自旋被看门狗强杀)。
    const alignedMs = alignFrameMs(targetMs);
    log.debug(`[pump][seek] group=${this.group.name} want=${wantMs}ms target=${targetMs}ms 对齐=${alignedMs}ms dur=${this.durationMs} running=${this.running} paused=${this.paused} window=${!!this.window}`);
    // ① 发布位置对(防 UI 拿旧值回跳)。
    this.group.positionMs = alignedMs;
    // ① 之后还要记住这个下界:新 pushLoop 的首帧会按「可听位置」上报,而刚拖动完
    // 缓冲还没建立,可听位置会低于目标 —— 不设下界 UI 会看到「拖到 40s 却显示 39.2s」。
    this.reportedFloorMs = alignedMs;
    this.playWallMs = Date.now();
    this.playContentMs = alignedMs;
    this.group.audibleStarted = false; // seek 重建缓冲,回到可听前
    this.group.displayPositionMs = 0; // seek 允许显示回退,单调保护从头起算
    logSafe(this.server, "info", `[pump] display-reset song=${this.songId} reason=seek`);
    // S1:拖动会改变内容位置 ⇒ 预取的「下一首从 0 起」内容不再是用得上的衔接。
    // 只丢帧、**保留**「下一首是谁」:拖完继续播到曲末照样要在 ≤5s 窗口预解码。
    this.cancelNextTrackPrefetch(true);
    // S1:seek 重建(seekCore → playGroupCore)拿不到队列信息,置位让下一次同曲 play()
    // 沿用本曲的下一首提示(见 keepNextOnRebuild)。
    if (this.running && this.songId) this.keepNextOnRebuild = true;
    if (!this.running || !this.songId) {
      // 泵未运行(空闲/起播窗口):MA 对应 resume_with_position —— 记起播位置,
      // 下一次 play() 起流即带 -ss 消费,无需现在重建。
      this.pendingSeekMs = alignedMs;
      log.debug(`[pump][seek] pump 未运行 → 记起播位置 ${alignedMs}ms 交由 play() 消费`);
    }
    // ② 重建由 seekCore → playCore/playGroupCore 走完整起播路径(见 seekCore)。
  }

  /** 起播位置装填(playCore 重建路径用):在 pump.stop() **之后**调用
   *  (stop 会清 pendingSeekMs —— 那是"旧上下文丢弃"语义,MA 的 seek_position
   *  属于新流,必须在其后装填)。 */
  armSeek(ms: number): void {
    // 入参是**内容毫秒**；内部时间轴是输出流毫秒 ⇒ 除以倍速后再按帧栅格对齐。
    const alignedMs = alignFrameMs(Math.max(0, Math.round(ms / this.rate)));
    // ★ S1(2026-11-01 真机):`0` 不是 seek,是「从头起播」。QueueController 每次
    //   playMedia 都把 startMs=0 一并下发(auto-advance/手动 next 全是 0),旧实现
    //   在这里无条件丢预取 ⇒ **下一首起播那一拍**恰好把刚预解好的帧扔掉(日志
    //   `bridge-prefetch-drop epoch=3 frames=120`),预取永远无法被采纳。
    //   真正的 seek→0 重建(同一首)不受影响:play() 的 takePrefetchFor 会因
    //   songId 不符预取目标而自行弃用并丢帧。
    if (alignedMs <= 0) return;
    this.pendingSeekMs = alignedMs;
    // S1:带 seek 起播不走预取(预取窗口起点是 0)。但**只丢帧、保留**「下一首是谁」:
    // seek 重建是"从 X 秒继续播同一首",曲末照样要预解码下一首(真机实测:此处
    // 清提示会让每次拖动之后的边界都退回断粮)。
    this.cancelNextTrackPrefetch(true);
  }

  /** ★ 泵移交:把本泵(连同**已解码窗口**、时间线、推流节奏)整体改挂到另一个组。
   *
   *  ============ 为什么只需改一个字段 ============
   *  本泵的下发目标就是 `this.group`:pushFrame / positionMs / timelineBaseUs /
   *  current / commonSendAheadUs() 全部在**每一帧读取时**取自 `this.group`,没有
   *  任何一处把它缓存成局部量(`win`/`pcm` 缓存的是音频数据本身,与组无关)。
   *  所以"把这条流交给另一个组"= 换掉 `this.group` + 让时间线按**新组**的时钟
   *  (commonSendAheadUs)重锚一帧即可 —— 不需要第二份解码、不需要第二个 ffmpeg、
   *  不需要多消费者窗口(同一时刻只有一个组在播)。
   *
   *  ============ 起点为什么必须回退 ============
   *  对外可见的 `group.positionMs` 是**可听位置**(已推送 − 缓冲深度),而取帧游标
   *  `playCursorMs` 是**已推送位置**,两者相差整整一个预填充水位(默认 3s,可配到
   *  30s)。若照搬游标,目标端会从"源端还排在设备缓冲里、用户还没听到"的那一段开始
   *  —— 听感就是"一下子往前跳了 N 秒"。故移交必须把游标回退到源端此刻的可听位置。
   *
   *  ⚠️ 回退有物理下限:窗口只保留 5s 已消费历史(`HISTORY_KEEP_SEC`),水位比它深时
   *  回退不到可听位置。此时以窗口基准为下限 —— 宁可少退几秒(听感上少跳几秒),也
   *  不能让 `slice()` 直接命中淘汰路径。另一个方向的上限是已推送位置(超过即重发同一段)。
   *
   *  @param next    新组(移交后本泵唯一的下发目标)
   *  @param wantMs  期望起点(通常 = 源端可听位置)
   *  @returns       实际落点(ms)
   */
  rehost(next: SendspinGroup, wantMs: number): number {
    const prev = this.group;
    let start = alignFrameMs(Math.max(0, Math.round(wantMs)));
    // 下限:窗口还能读到的最早点(向上取到帧栅格,与 slice 的绝对下标同源)。
    if (this.window) {
      const winBase = Math.ceil(this.window.baseMs / FRAME_MS) * FRAME_MS;
      if (start < winBase) start = winBase;
    }
    // 上限:已推送位置(超过它就是把同一段音频重发一遍)。
    const pushed = alignFrameMs(this.playCursorMs);
    if (start > pushed) start = pushed;
    // 旧组的时间线上游作废:新组由本轮 reseed 按**新组**的 send_ahead 重立。
    prev.timelineBaseUs = 0n;
    this.group = next;
    this.playCursorMs = start;
    next.positionMs = start;
    next.audibleStarted = false; // 新组需重新建立缓冲,回到可听前
    // 上报下界 = 落点:目标端 UI/歌词立刻显示正确位置(与带 seek 起播同款语义),
    // 由 pushLoop 的重锚分支取用(见 floorMs)。
    this.reportedFloorMs = start;
    // ★ 重锚序号自增 —— 这一帧起,时间戳锚点按 next.commonSendAheadUs() 重立。
    // 序号(而非布尔)保证"移交这一拍"不会被已经越过重锚判断点的循环吃掉。
    this.timelineReseed++;
    // 暂停态也照常交付:流转的语义是"接着播",不是"把暂停一起搬过去"。
    if (this.paused) this.resume();
    log.debug(
      `[pump][rehost] ${prev.name} → ${next.name} 起点=${start}ms(需求 ${Math.round(wantMs)}ms,已推送 ${pushed}ms)`,
    );
    return start;
  }

  /** 窗口当前还能回退到的最早位置(ms,已对齐帧栅格);没有窗口 → null。
   *
   *  给**借流武装前的可行性判定**用:预填充水位(已推送 − 可听)比窗口历史深时,
   *  rehost 只能落在窗口底 —— 听感一下子超前好几秒,且新组要把这段缓冲重建回来
   *  (对外表现为 BUFFERING 数秒)。与其白搬一次泵,不如提前拒掉、走完整起播。 */
  readableBaseMs(): number | null {
    if (!this.window) return null;
    return Math.ceil(this.window.baseMs / FRAME_MS) * FRAME_MS;
  }

}

// ---- 单组 pump 池(server:group 生命周期内复用) ----
const pumpByGroup = new WeakMap<SendspinGroup, GroupPump>();

/** 存活泵计数(建 +1 / `stopGroupPump` -1)。WeakMap 不可枚举,而桥组的泵是按
 *  `ug:<groupId>` 的组对象建的、不在 `server.groups`(按 clientId 索引)里,
 *  枚举法会漏 ⇒ 只能用计数器。用途仅是「子进程预热要不要探源」的门控:
 *  计数偏高只会多探一次(可接受),偏低才会漏预热,故只在 stop 时递减、且不置负。 */
let activePumpCount = 0;

/** 取(或建)该组的 pump。 */
/** 取(或建)该组的 pump。
 *
 *  `onUnplayable`(2026-10-28 事故修复):本次起播的判死回传口,装填到泵实例上。
 *  **不传 = 不动泵上已有的回传口** —— seek 重建路径(seekCore 内部再调 playCore)
 *  不重复传,泵沿用初始起播时那个,语义一致。 */
export function pumpFor(
  server: SendspinServer,
  group: SendspinGroup,
  onUnplayable?: SongUnplayableSink | null,
): GroupPump {
  let p = pumpByGroup.get(group);
  if (!p) {
    p = new GroupPump(server, group);
    pumpByGroup.set(group, p);
    activePumpCount += 1;
  }
  if (onUnplayable) p.onUnplayable = onUnplayable;
  return p;
}

export function stopGroupPump(group: SendspinGroup): void {
  const p = pumpByGroup.get(group);
  if (p) {
    try { p.stop(); } catch { /* ignore */ }
    pumpByGroup.delete(group);
    activePumpCount = Math.max(0, activePumpCount - 1);
  }
}

/** 读该组现有的泵(**不创建**)。移交前的可行性判定必须用它 —— `pumpFor()` 会凭空
 *  建一个空泵,把"源端根本没在播"误判成"有个泵在"。 */
export function peekPump(group: SendspinGroup): GroupPump | undefined {
  return pumpByGroup.get(group);
}

/** 本进程里是否**有活着的**泵(建 +1 / `stopGroupPump` -1)。
 *
 *  供子进程预热做门控:纯 DLNA / 直连播放时不该为一首根本不归 sendspin 推的歌
 *  白探一次源(每首一次 3s 的对外探测,会占上游配额)。
 *
 *  ⚠️ 不要用「遍历 `server.groups` 再 `pumpByGroup.has()`」:桥组的泵是按
 *  `ug:<groupId>` 的组对象建的,与 `server.groups`(按 clientId 索引)不是同一批键,
 *  2026-10-30 真机首版就是这么写的 —— 门控恒 false,子进程静默跳过。 */
export function hasActivePump(): boolean {
  return activePumpCount > 0;
}

/** 测试用:复位泵计数(模块级状态,不随 resetDrainPreheat 清)。 */
export function resetActivePumpCountForTest(): void {
  activePumpCount = 0;
}

/** 把 `from` 名下的泵整体移交到 `to`(含 WeakMap 键),返回落点(ms)。
 *
 *  ⚠️ 只做**泵这一侧**的搬运:两端的组状态(current / 成员 / stream 宣告 / 编码器)
 *  由调用方负责 —— 那是会话语义,属于 playerCore.handoverCore。
 *  返回 null 表示没有可移交的泵(或源目标同组)。 */
export function transferPumpTo(from: SendspinGroup, to: SendspinGroup, wantMs: number): number | null {
  if (from === to) return null;
  const p = pumpByGroup.get(from);
  if (!p) return null;
  const at = p.rehost(to, wantMs);
  pumpByGroup.delete(from);
  pumpByGroup.set(to, p);
  return at;
}
