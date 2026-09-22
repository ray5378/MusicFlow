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

import { SAMPLE_RATE, CHANNELS, decodeToF32 } from "./encoding.js";
import { nowUs } from "./clock.js";
import { PcmWindow, WindowEvictedError, type WindowSource } from "./streamSource.js";
import type { SendspinServer, SendspinGroup } from "./server.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin");

export interface GroupAudio {
  pcm: Float32Array;
  durationMs: number;
  /** 流式窗口(阶段二):有则走窗口取数,无则走整包 pcm。announce/测试保持整包。 */
  stream?: PcmWindow | null;
}

/** 流式音源开关:插件配置 `stream_source` 为单一可信源(配置页开关,下一首生效);
 *  环境变量仅做显式覆盖(1=强制开,0=强制关,供测试/排障)。
 *  注意 ./index.js 只许动态导入(禁环:index → 本文件静态导入 stopGroupPump)。 */
export async function isStreamSource(): Promise<boolean> {
  if (process.env.SENDSPIN_STREAM_SOURCE === "1") return true;
  if (process.env.SENDSPIN_STREAM_SOURCE === "0") return false;
  return readSendspinStreamSource();
}

let streamSourceCache: { value: boolean; at: number } | null = null;
const STREAM_SOURCE_CACHE_MS = 5000;

/** 读插件配置的流式开关(5s 缓存:每首歌只查一次 DB,开关翻转最多延迟 5s 生效)。 */
async function readSendspinStreamSource(): Promise<boolean> {
  const now = Date.now();
  if (streamSourceCache && now - streamSourceCache.at < STREAM_SOURCE_CACHE_MS) {
    return streamSourceCache.value;
  }
  let value = false;
  try {
    const { readSendspinPluginConfig } = await import("./index.js");
    value = readSendspinPluginConfig().streamSource === true;
  } catch {
    value = false;
  }
  streamSourceCache = { value, at: now };
  return value;
}

/** 解析某首歌的可播字节(默认真实);测试可注入。 */
/** 音源工厂契约。`startMs > 0` = 起播即定位(ffmpeg `-ss`),由 seek 重建与
 *  起播跳转共用 —— MA 语义里「从 X 秒开始播」和「跳到 X 秒」是同一件事:
 *  都是用新起点建一条流,而不是在旧流里挪指针。 */
export type PumpSource = (songId: string, startMs?: number) => Promise<GroupAudio>;

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
 *  所以旧开关关掉时也"看起来正常"—— 这也是当初误判成"流式开关的问题"的原因。
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

/** 「编码器零产出」多久后判定为**异常**(而非正常攒样),降级为按喂入量推进时间线。
 *
 *  块编码器(FLAC)每攒满一块才吐一帧,期间 pushFrame 返回 0 是**正常**的
 *  (libFLAC 4096 样本 @48k = 85.33ms)。所以不能一见到 0 就降级 ——
 *  那会让时间线超前约 75ms,设备反复 `Lost sync (75006us off)`、听感一卡一卡。
 *  给足 10 倍余量:连续 500ms 零产出才认为是编码器坏了,此时宁可时间线略偏,
 *  也不能让它彻底停摆(timestamp 冻结 → pump 永不结束 → 切歌卡死)。 */
export const STALL_GRACE_US = 500_000;

/** 默认音源:统一裁决(resolvePlayableRow,与 /rest/stream 同口径) → 取字节 → 解码。
 *  整个文件解码为内存 F32(功能性实现;长曲适度占用,见引擎头部说明)。 */
async function defaultSource(songId: string, startMs = 0): Promise<GroupAudio> {
  const { resolvePlayableRow, fetchRowBytes } = await import("../source/resolveAudio.js");
  const r = await resolvePlayableRow(songId);
  if (!r.row) throw new Error(`no playable stream for ${songId} (${r.reason})`);
  if (await isStreamSource()) return streamingSource(r.row as any, startMs);
  const bytes = await fetchRowBytes(r.row);
  if (!bytes) throw new Error(`fetch bytes failed for ${songId} (${r.reason})`);
  const pcm = await decodeToF32(bytes);
  const durationMs = bufferDurationMs(pcm);
  return { pcm, durationMs };
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
  direct: { input: string; headers?: Record<string, string> }
): Promise<{ input: string; headers?: Record<string, string> }> {
  const { resolvePipelineInput } = await import("../audio/pipeline.js");
  return resolvePipelineInput(direct);
}

async function streamingSource(
  row: { id?: string; duration?: number | null },
  startMs = 0,
): Promise<GroupAudio> {
  const { resolveRowInput } = await import("../source/resolveAudio.js");
  const direct = resolveRowInput(row as any);
  if (!direct) throw new Error("no streamable input for row");
  const source = await resolveFfmpegInput(direct);
  // startMs 直达 ffmpeg `-ss`(PcmWindow 构造本就支持,此前未透传):
  // 起播即定位,省掉「先建流再 seekTo 冷起一次」的整段空窗。
  const window = new PcmWindow(
    { ...source, rowId: typeof row.id === "string" ? row.id : undefined },
    startMs,
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

function bufferDurationMs(pcm: Float32Array): number {
  const perSec = SAMPLE_RATE * CHANNELS; // interleaved frames per second
  return Math.round((pcm.length / perSec) * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 安全日志:GroupPump 可能被以最小 stub server 构造(测试/嵌入式场景),
 *  不能假设 `server.log` 一定存在 —— 否则日志本身就抛错、把推流循环打死
 *  (2026-09-17 踩过:新增的锚点日志让 pumpFallback 三个用例全部超时)。 */
function logSafe(server: SendspinServer | undefined, level: "info" | "warn" | "error", msg: string): void {
  try {
    server?.log?.(level, msg);
  } catch { /* 日志失败绝不影响推流 */ }
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
  private epoch = 0;
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
   *  contentEnded → finishPlayback → 设备 IDLE、预建流作废(2026-09-22 真机实锤,
   *  FP-TRACE 堆栈钉死 pushLoop EOF 路径)。原则:**共享位置只写不读**,取帧一律用本游标。 */
  private playCursorMs = 0;
  private pcm: Float32Array | null = null;
  private window: PcmWindow | null = null;
  private durationMs = 0;
  private songId = "";
  // 暂停时被唤醒的等待器。
  private resumeWaiter: (() => void) | null = null;
  // 上一首是否已"自然播完"(用于结束时置空 current 触发 auto-advance)。
  private endedNaturally = false;

  constructor(server: SendspinServer, group: SendspinGroup) {
    this.server = server;
    this.group = group;
    const s = Number(process.env.SENDSPIN_PUSH_SPEED);
    this.speed = Number.isFinite(s) && s > 0 ? s : 1;
  }

  get active(): boolean {
    return this.running;
  }

  /** 播放一个音频缓冲:按组时间线切帧推送,推进 positionMs。 */
  async play(songId: string): Promise<void> {
    const source = injectedSource ?? defaultSource;
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
    // 起播位置已知(pendingSeekMs)时直接交给音源工厂,让 ffmpeg 从一开始
    // 就带 `-ss` 起 —— 省掉「建流 → 再 seekTo → 再冷起」的整段空窗。
    const startMsForSource = alignFrameMs(this.pendingSeekMs ?? 0);
    // ★ 音源获取熔断(**仅 seek 重建**,首播不动):source() 内部任何一步没超时
    // 保护(resolve/取字节/预缓冲),永挂会导致整组静默(无帧、无报错、无 pushLoop),
    // 随后看门狗误判、子进程被杀。240 实锤:seek 重建后新 pushLoop 永远没起来,
    // 旧循环已按世代退出,组静默至死。首播不加(大文件全量解码可能合法地慢)。
    // 30s 熔断 → 抛错 → onPlayFailed 走跳过/换源愈合,绝不停在"半截 rebuild"。
    const NEED_FUSE = startMsForSource > 0;
    const SOURCE_TIMEOUT_MS = 30_000;
    let srcResult: Awaited<ReturnType<typeof source>>;
    log.debug(`[pump][play] song=${songId} startMs=${startMsForSource} 开始获取音源${NEED_FUSE ? "(seek 重建,30s 熔断)" : ""}`);
    let srcTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const srcPromise = source(songId, startMsForSource);
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
      throw e;
    } finally {
      if (srcTimer) clearTimeout(srcTimer);
    }
    log.debug(`[pump][play] song=${songId} 音源就绪 dur=${srcResult.durationMs}ms window=${!!srcResult.stream}`);
    const { pcm, durationMs, stream } = srcResult;
    if (this.epoch !== myEpoch) {
      // 等待期间已有更新的 play() 接管:刚建出来的窗口是孤儿苗子,就地掐掉。
      try { stream?.close(); } catch { /* ignore */ }
      logSafe(this.server, "info", `sendspin play superseded song=${songId} (epoch ${myEpoch}→${this.epoch}),窗口已就地释放`);
      return;
    }
    this.running = true;
    this.paused = false;
    this.pcm = pcm;
    this.window = stream ?? null;
    this.durationMs = durationMs;
    this.songId = songId;
    this.endedNaturally = false;
    this.group.current = { songId, durationMs, title: this.group.current?.title, artist: this.group.current?.artist, album: this.group.current?.album, coverArt: this.group.current?.coverArt };
    // 起播位置:消费起播窗口内到达的 seek(见 pendingSeekMs 注释)。
    // 绝不能无条件写 0 —— 那正是「刚点播就拖、拖动被吞」的根因。
    // 起播位置必须与 startMsForSource **同源**(同一对齐函数),否则窗口 base 与
    // 帧栅格游标又会错位(见 alignFrameMs 的硬约束说明)。
    const startMs = alignFrameMs(this.pendingSeekMs ?? 0);
    this.pendingSeekMs = null;
    this.playCursorMs = startMs;
    this.group.positionMs = startMs;
    // 起播跳转已由音源工厂的 `-ss` 完成(见 startMsForSource),无需再 seekTo ——
    // 此处若再调一次会 kill 刚 spawn 的 ffmpeg 并重起,白白多一次冷起空窗。
    /** pacing 锚点对:起播位置 ⇄ 现在。带 seek 起播时锚点必须是 startMs,
     *  否则 dueMs 会按 positionMs(=startMs)算出一个远在未来的时刻(见 paceAnchorMs)。 */
    this.paceAnchorMs = startMs;
    this.paceAnchorWall = Date.now();
    this.resumeWaiter = null;
    // 主循环不阻塞调用方(playMedia 需尽快返回,由 pollState 反映进度)。
    void this.pushLoop(myEpoch);
  }

  /** 释放音频持有(整包缓冲 / 流式窗口＋ffmpeg 二选一,调用方无需区分)。 */
  private releaseAudio(): void {
    this.pcm = null;
    if (this.window) {
      try { this.window.close(); } catch { /* ignore */ }
      this.window = null;
    }
  }

  /** 推流主循环:按真实墙钟节奏取 PCM 段 → 编码 → 下发,时间戳按**实测样本数**推进。 */
  private async pushLoop(myEpoch: number): Promise<void> {
    const win = this.window;
    const pcm = this.pcm;
    if (!win && !pcm) { this.running = false; return; }
    const frameSamples = Math.floor((SAMPLE_RATE * CHANNELS * FRAME_MS) / 1000);
    // 流式无全长:total 仅整包路径用,窗口路径靠 EOF＋耗尽结束。
    const total = win ? Infinity : Math.ceil(pcm!.length / frameSamples);
    let contentEnded = false;
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
        const i = Math.floor(this.playCursorMs / FRAME_MS);
        const lo = i * frameSamples;
        let seg: Float32Array;
        if (win) {
          try {
            seg = await win.slice(lo, lo + frameSamples);
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
              const baseMs = win.baseMs;
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
            logSafe(this.server, "warn", `sendspin 流式窗口提前 EOF: lo=${lo} frame=${i} pid=${win.pid} eof=${win.eof} failed=${win.failedReason ?? "-"} decoded=${win.decoded} song=${this.songId}`);
            contentEnded = true; break;
          }
        } else {
          if (i >= total) { contentEnded = true; break; } // 解码耗尽
          seg = pcm!.subarray(lo, Math.min(lo + frameSamples, pcm!.length));
        }

        // 时间线锚点:首帧确立;seek 后重建(见 timelineReseed 注释)。
        // 两条路径共用同一段 —— 时间戳锚点与 pacing 锚点必须一次性同源重设,
        // 分开写迟早漂移(此前 pacing 在 seek 时完全没被重设,是"拖动后无声"的真凶)。
        if (firstFrame || this.timelineReseed !== consumedReseed) {
          const reseed = !firstFrame;
          consumedReseed = this.timelineReseed;
          firstFrame = false;
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
          const lead = BigInt(
            Math.max(reseed ? reseedLead : aheadUs, FIRST_FRAME_LEAD_US),
          );
          // ⚠️ 锚点必须**严格大于已发出的最后一个时间戳**(= 此刻的 cursorUs)。
          // 时间线游标按 `round(produced/采样率)` 步进,与墙钟速率几乎相等但不完全相等:
          // 220 帧后两者会积累出 ±几十~几百 µs 的交叉(高压负载下实测 -21µs / -185µs),
          // 此时若无条件写成 `nowUs()+lead`,新时间戳会**比上一帧更小** → 时间轴倒退。
          // 设备端按时间戳排程,倒退是失序信号(虽远低于 hard-sync 阈值,但没理由让它发生)。
          // 取二者较大值即可:回跳只换内容,时间轴永不倒退;与真值的偏差仅数百 µs,
          // 相对 800ms 的 send_ahead 是噪声级,不影响 delta≈0 的锚点语义。
          const anchor = nowUs() + lead;
          const clamped = anchor > cursorUs ? anchor : cursorUs;
          this.group.timelineBaseUs = clamped;
          cursorUs = clamped;
          tsUs = cursorUs;
          logSafe(
            this.server,
            "info",
            reseed
              ? `sendspin timeline RE-anchored after seek: pos=${this.group.positionMs}ms base=${cursorUs} lead=${lead}us (sendAhead=${aheadUs}us)` +
                (clamped > anchor ? ` [clamped: wall=${anchor} ≤ cursor,已保单调]` : "")
              : `sendspin timeline anchored: base=${cursorUs} lead=${lead}us (sendAhead=${aheadUs}us) ` +
                `frameMs=${FRAME_MS} frameSamples=${frameSamples}`,
          );
        } else {
          tsUs = cursorUs;
        }

        let produced = 0;
        try {
          // pushFrame 返回本批产出包所覆盖的**总样本数**(编码器实测,见 EncodedChunk)。
          // 用 Number() 归一:最小 stub group(测试)可能返回 undefined。
          produced = Number(await this.group.pushFrame(tsUs, seg)) || 0;
        } catch (e) {
          // ⚠️ 别静默吞:pushFrame 抛错(编码器/连接)时此前完全无日志,表现为
          // 「decode 完成后推流戛然而止、服务端看起来一切正常但设备无声」(2026-09-17 真机)。
          logSafe(this.server, "warn", `sendspin pushFrame 中断 @frame=${i}/${total} song=${this.songId}: ${(e as Error)?.message || e}`);
          break; // 连接断开等:停止推流(状态由 QueueController 处理)。
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
          }
        }
        this.group.timelineBaseUs = cursorUs;

        const framePosMs = this.durationMs > 0
          ? Math.min(this.durationMs, i * FRAME_MS + FRAME_MS)
          : i * FRAME_MS + FRAME_MS; // 时长未知(流式元数据缺失):不钳制,
        // 否则 position 恒 0 → 同一片无限重推 ＋ pacing 永不 sleep,饿死事件循环
        this.playCursorMs = framePosMs;
        this.group.positionMs = framePosMs;
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
        if (delayMs > 0) await sleep(delayMs);
        // 元数据时长与实际解码长度常差几十 ms:解码偏长时 i 永远到不了 total,
        // positionMs 又被 clamp 在 durationMs → 同一尾帧无限重推、永不结束。
        // 到达元数据时长即视为播完(退出后 endedNaturally 照常置空 current 触发切歌)。
        // 注意 break 必须在 sleep 之后(保持旧 pacing):提前跳过末帧 sleep 会打乱
        // 乐观窗口/自然结束的时序判定,导致切歌变重播(见 queueModes 回归)。
        if (this.durationMs > 0 && this.playCursorMs >= this.durationMs) { contentEnded = true; break; }
      }
      logSafe(this.server, "info", `sendspin pushLoop 退出: contentEnded=${contentEnded} running=${this.running} epochSame=${this.epoch === myEpoch} song=${this.songId}`);
      if (this.epoch === myEpoch) {
        this.running = false;
        this.endedNaturally = contentEnded;
        try {
          // 自然播完 → 置空 current,让 pollState 上报 IDLE → PlaybackTracker auto-advance。
          // 同时宣告流结束:缺 stream/end + group/update(stopped),客户端永远卡 PLAYING。
          if (this.endedNaturally) {
            this.group.current = null;
            this.group.finishPlayback();
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
      this.running = false;
    }
  }

  /** 软停止(当前帧后不再推;置空 current,供 stop/切歌打断)。 */
  stop(): void {
    this.epoch++;
    this.running = false;
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    // 起播窗口内的 seek 归属**上一首**:stop 意味着这段播放上下文已被丢弃,
    // 若不清,playCore 的 "stop → 起播新曲" 序列会把上一次拖动带到新曲上。
    this.pendingSeekMs = null;
    // 旧曲音频立即释放(切歌瞬间,不等新解码覆盖):整包清引用,流式杀进程。
    this.releaseAudio();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
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
  seek(seconds: number): void {
    const wantMs = Math.max(0, Math.round(seconds * 1000));
    const targetMs = this.durationMs > 0 ? Math.min(this.durationMs, wantMs) : wantMs;
    // ★ 帧栅格对齐:发布/记忆的位置必须与 PcmWindow 的 baseSample 同源
    //   (见 alignFrameMs —— 目标不是 25ms 整数倍时子进程会微任务自旋被看门狗强杀)。
    const alignedMs = alignFrameMs(targetMs);
    log.debug(`[pump][seek] group=${this.group.name} want=${wantMs}ms target=${targetMs}ms 对齐=${alignedMs}ms dur=${this.durationMs} running=${this.running} paused=${this.paused} window=${!!this.window}`);
    // ① 发布位置对(防 UI 拿旧值回跳)。
    this.group.positionMs = alignedMs;
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
    // 同样按帧栅格对齐(seekCore 传进来的是毫秒精度的目标,见 alignFrameMs)。
    this.pendingSeekMs = alignFrameMs(Math.max(0, Math.round(ms)));
  }

}

// ---- 单组 pump 池(server:group 生命周期内复用) ----
const pumpByGroup = new WeakMap<SendspinGroup, GroupPump>();

/** 取(或建)该组的 pump。 */
export function pumpFor(server: SendspinServer, group: SendspinGroup): GroupPump {
  let p = pumpByGroup.get(group);
  if (!p) {
    p = new GroupPump(server, group);
    pumpByGroup.set(group, p);
  }
  return p;
}

/** 停掉某组的 pump 并摘除(组空/断开清理用)。停后重播走 pumpFor 重建。
 *  注意只停音频生产,不碰队列(重连恢复靠队列,见 QueueController)。 */
export function stopGroupPump(group: SendspinGroup): void {
  const p = pumpByGroup.get(group);
  if (p) {
    try { p.stop(); } catch { /* ignore */ }
    pumpByGroup.delete(group);
  }
}