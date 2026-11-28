/** 桥会话(Phase 4 四锚点精确驱动,spec §3.3/§3.5/§4.5):
 *  bridgeServer 收到 48k s16le PCM(tsUs = 组时间线可听时刻,host 单调 µs)
 *  → 147/160 重采样(AP1 协商 44.1k;48k 协商直通)
 *  → BridgeTimelineAligner 漂移对齐(补静音/裁头,阈值 441 帧 ≈10ms,>1ms 记 realigned)
 *  → RaopPlayer.streamBridge 四锚点驱动(RTP↔NTP 映射 + sendAt = A′+i·352/rate − L − SAFETY 节拍)。
 *
 *  锚点口径(§7.2):A 只在收到第一帧有效 AUDIO 时确定(= 首帧 tsUs);
 *  RAOP connect 完成后做可达性检查(A − L − SAFETY < now ⇒ 重锚 A = max(now + warmLead, 首帧 tsUs),
 *  丢弃更早内容,不得把迟到首帧硬塞成开始,§3.3 末段)。
 *  群延迟(MIN-01,符号钉死):有重采样器时 A′ = A + 0.3627ms(computeBridgeAnchors 内补偿);
 *  48k 直通(无重采样器)不做补偿。
 *  无 ack 诚实语义(§3.5):scheduledAnchorUs 只经日志/状态快照上报,绝不伪造设备播放确认。
 *  stats tick(§10.5/MAJ-08):每设备默认 2s 一行 JSON(ev:"tick");deltaUs = 已写入 RAOP 的
 *  内容前沿相对 A′ 的超前量 ≈ L + 队列深度 —— 锚点写错 X ⇒ deltaUs 恒偏 X;driftUs 是本地
 *  对齐残差(对齐错才涨),late 是 lead 不足 —— 三者可区分。
 *
 *  硬约束:纯数据面 —— 本文件不做任何选歌/预取逻辑。
 *
 *  Phase 6b(T03)双出口:protocol 为 `ap2-realtime` 时,start() 建 Ap2StreamSession
 *  (48k 直通,无重采样 ⇒ 无群延迟补偿),maybeBeginStream 在**同一个 plan.anchorUs**
 *  上分流到 runAp2Output(节拍 = A + i·spf/rate − L_eff);RAOP 路径逐字节不变。
 *  运行期链路断 ⇒ snapshot().degraded=true,主进程看门狗摘桥并让该设备本流回落 solo cast
 *  (绝不在会话内切协议 = 绝不中途换锚点)。
 */
//
// ===== 对标 MA（隔离模式）=====
// MA 位置：music_assistant/providers/airplay/stream.py:327（每播放器一个专属
//          cliairplay 子进程：AsyncProcess(args, stdin=True, …)）、
//          stream.py:1195-1197（「Audio is fed continuously on the process stdin;
//          the binary reads it into a single ring buffer for the whole session
//          lifetime (flushed and refilled in place on a seek, never reconnected)」）、
//          airplay/sendspin_bridge.py:103-106（BRIDGE_MIN_BUFFER_MS=1000）与
//          :511-517（set_timing(min_buffer_ms=BRIDGE_MIN_BUFFER_MS)）、
//          sendspin/playback.py:55-64（live 源 send-ahead 固定在 min_buffer_ms floor）。
// MA 语义：每台播放器的上游缓冲是**该播放器进程私有**的 stdin ring —— 整个会话
//          生命周期一段缓冲（seek 原地 flush/refill，绝不重连）；供给节奏由
//          Sendspin 按 min_buffer_ms(1s) 固定 send-ahead 持续维持，而不是由
//          生产者一次性灌满。
// 我们：隔离模式（playerIsolationEnabled()）下的 ringBuf + startRingDrain 就是
//          这层「每设备私有缓冲 + 到达节拍消化」的等价物 —— 上游（组广播/泵）
//          只管把帧送进本设备的 ring，ring 按 100ms 节拍定量下泄给原有投递链路
//          （ingestAudioDirect）：设备之间互不共享、互不阻塞。
//          差异：MA 的 ring 在黑盒二进制里由其自身消化；我们的 ring 在
//          BridgeSession 内、由本文件定时器节拍显式驱动，参数（容量/节拍/预灌）
//          因此显式可调、可观测（[ring-diag] 日志）。

import { BridgeServer, type BridgeAudioEvent, type BridgeServerHandlers } from "./bridgeServer.js";
import { bridgeSocketPath } from "./bridgeChannel.js";
import {
  AP2_DEFAULT_LATENCY_FRAMES,
  AP2_EFFECTIVE_LATENCY_FRAMES,
  AP2_LATE_SKIP_US,
  AP2_WAIT_SLICE_MS,
  BRIDGE_MAX_HELD_AUDIO_US,
  BRIDGE_PCM_BYTES_PER_SEC,
  BRIDGE_REBASE_MIN_AHEAD_US,
  BRIDGE_RESUME_REBASE_US,
  BRIDGE_REJOIN_ATTEMPT_MAX,
  BRIDGE_SPLICE_LEAD_MARGIN_US,
  BRIDGE_WARM_START_LEAD_US,
  PROTOCOL_CAPS,
  RAOP_SAFETY_MS,
  SENDSPIN_RATE,
  bridgeSyncGroupTimelineEnabled,
  type BridgeProtocol,
} from "./rates.js";
import { computeBridgeBackoffMs } from "./bridgeSource.js";
// S8 校准闭环/锚点 rebase 显著性:复用 contentDemand 的 500ms(零依赖,无环)。
// 对标 MA playback.py:90 ANCHOR_REBASE_SIGNIFICANT_US(值 500_000,语义=锚点移动
// 超 500ms 才算显著偏移)—— 广播游标跳转与 pacing rebase 共用同一「显著」阈值。
import { CURSOR_JUMP_BEHIND_US } from "../sendspin/contentDemand.js";
import { BRIDGE_TRANSPORT_RECOVERY_GUARD_MS } from "../sendspin/constants.js";
import { PolyphaseResampler, floatToPcmS16, pcmS16ToFloat } from "./resampler.js";
import { audibleAtUs, computeBridgeAnchors, driftCorrection, groupDelayUs, type BridgeAnchors } from "./bridgeMath.js";
import { nowUs } from "../../utils/hostClock.js";
import {
  RaopPlayer,
  CHUNK_LEN,
  optionsProbeSaysAlive,
  raopBridgeConnectPrimeEnabled,
  raopOptionsProbe,
  type BridgeStreamEndReason,
  type RaopSession,
} from "./raop.js";
import { DEFAULT_AIRPLAY_VOLUME } from "./volumeDefault.js";
import { degreesToDb } from "./decoder.js";
import { AP2_SEND_ERROR_LIMIT, Ap2StreamSession, type Ap2StreamOptions, type Ap2StreamState } from "./ap2/ap2Stream.js";
import { createLogger } from "../../utils/logger.js";
import { PlayerRing } from "../playerHost/playerRing.js";
import { playerIsolationEnabled } from "../playerHost/isolationFlag.js";

/**
 * exp4 实验开关(全部缺省关闭 = 现行为):
 *  - MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME:桥完全不发初始 SET_PARAMETER volume
 *    (solo 从不在「非变更」路径发这条?不 —— solo v4.9.3 Fix-1 也发,但有同 host
 *    DLNA 渲染器豁免;本开关用于验证「SET_PARAMETER 本身」是否为无声触发器)。
 *  - MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER:桥对齐 solo 豁免 —— 同 host 存在
 *    DLNA 渲染器(Linkplay 类:HiVi H5MKII 的 RAOP 忽略 SET_PARAMETER,音量走
 *    RenderingControl)时跳过初始 SET_PARAMETER。主卧 DLNA 停播后桥无声的头号嫌疑。
 */
export function raopSuppressInitialVolume(): boolean {
  const v = process.env.MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME;
  return v === "1" || v === "true";
}

export function raopSkipVolumeWithDlnaPeer(): boolean {
  const v = process.env.MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER;
  return v === "1" || v === "true";
}

/** 初始 SET_PARAMETER 是否跳过(纯函数,单测直测两分支):
 *  - SUPPRESS:无条件抑制(A/B 实验用);
 *  - SKIP_WITH_DLNA_PEER:仅当主进程判定存在同 host DLNA renderer(Linkplay 类
 *    RAOP 忽略 SET_PARAMETER,与 solo control.ts Fix-1 豁免同语义)。
 *  ⚠️ sameHostDlnaPeer 来自主进程 bridgePrepare 载荷 —— 子进程的 airplay discovery
 *  与 DLNA cachedDevices 都是空的,桥上自查恒 undefined(240 实证,E1 空转)。 */
export function shouldSkipBridgeInitialVolume(sameHostDlnaPeer?: string): boolean {
  if (raopSuppressInitialVolume()) return true;
  return raopSkipVolumeWithDlnaPeer() && !!sameHostDlnaPeer;
}

/** exp4:prime 灌包数量(10 包 ≈ 80ms,足够建立 RTP 流存在感)。 */
const RAOP_CONNECT_PRIME_CHUNKS = 10;

/** D6/P1(2026-10-31):用户手动 next/prev 的 RTP ts 回拨量(毫秒)。
 *  基线 17 次实测:新流首包 ts 相对上一包回拨 1.588–1.695s(p50 1.662s)。
 *  落点见 raop.streamBridge 的 `rewindFrames`(352 帧对齐 ⇒ 44.1k 实际 1.660s)。 */
const BRIDGE_MANUAL_REWIND_MS = 1662;

/** 「手动」sticky 标记的有效期(ms):超时未等到 track boundary 即作废,
 *  防止 playMedia 失败/被取消时残留,误伤后续自动换歌。 */
const BRIDGE_MANUAL_STICKY_MS = 30_000;

/** 手动标记从 `stop` 边界「传递」到紧随 `track` 边界的有效期(ms)。
 *  实测 playFrom = stop→track,两者间隔 <200ms;超过 3s 视为「只停了、没再播」,
 *  传递作废(不允许残留到后续自动换歌)。 */
const BRIDGE_MANUAL_CARRY_MS = 3_000;

/** 回拨需求的有效期(ms):boundary 到首帧重新起流之间通常 <100ms,
 *  10s 只为兜底「新曲迟迟不来」时不把旧需求套到更晚的流上。 */
const BRIDGE_MANUAL_REWIND_TTL_MS = 10_000;

// ---------------------------------------------------------------------------
// producer 预填充 / 低水位补货(与 decoder.ts 的 PREFILL_MS 同一层 jitter buffer)
//
// 根因(HiVi H5MKII 曲中失声实证):桥接 producer(pullChunk)此前直接消费 outBuf,
// 没有 decoder.ts 那层 prefill ⇒ outBuf 常驻 0~8ms(不到 1 个 352 帧块),上游一阵
// 供料抖动就见底 ⇒ 352/44100 ≈ 7.98ms 的发送节拍被打断 ⇒ late 以 ~22/s 单调累积
// ⇒ 设备 1.05s 缓冲抽干 ⇒ 追赶模式 + 大量「未来包」重传 ⇒ 哑音数秒后自愈。
// 修复 = 给桥接 producer 补上解码路径已有的那层预填充(纯缓冲层,不动内容时间线)。
// ---------------------------------------------------------------------------

/** 桥接 producer 预填充水位(ms)—— 与 decoder.ts 的 PREFILL_MS 对齐(同为 1500)。 */
const BRIDGE_PREFILL_MS = 1500;

/** 首块预填充的单次等待预算(ms)。独立小常量,不再借 waitDataMs(1000):开局 bulk
 *  到位时 inQueue 一次到位,预算只是兜底;预算过长会把首块(0xE0 首包)拖后,
 *  加剧换歌处静默(旧形状 1000ms + 二级等待最坏 ~2s,已回收)。 */
const BRIDGE_PREFILL_WAIT_MS = 300;

/** 运行中低水位补货目标(ms):outBuf 跌破它就先等补货到该水位再出块,避免把上游
 *  抖动直接传导成发送节拍抖动(late)。做成常量便于调。 */
const BRIDGE_LOW_WATER_MS = 200;

/** 低水位补货的单次等待预算(ms)。刻意远小于 waitDataMs:上游恰好 1x 供料时
 *  outBuf 涨不上去,必须很快放弃并降级到原有欠料逻辑,否则反把节拍拖慢。 */
const BRIDGE_LOW_WATER_WAIT_MS = 40;

/** 等料轮询粒度(ms)。原为 5ms,而发送节拍仅 7.98ms —— 等一轮就吃掉大半个节拍
 *  窗口;细化到 1ms 以降低残留抖动(该定时器只在欠料/补货等待期间才会转)。 */
const BRIDGE_PULL_POLL_MS = 1;

/** 新代次首帧「大缺口」阈值(µs):换曲/重锚时上游泵短暂断供,时间戳却继续前进,旧行为把
 *  这段缺口物化成静音塞进 outBuf(240 实测 1704ms / 1768.5ms)⇒ 内容前沿被垫高、与节拍轴
 *  错位,叠加 raop 的 lag rebase 后演成「追发风暴」(12:34 `late` +100/s、16s 积压 overflow)。
 *  新代次首帧缺口 > 该阈值 ⇒ 走 skip(前移 RTP 时间线,不物化静音):听感同样是静音,
 *  但不污染内容前沿/节拍轴,也不再产生秒级突发缓冲。 */
const BRIDGE_NEWGEN_GAP_SKIP_US = 500_000;

/** front-rebase 冷却期(ms):换曲/重锚残波里 tick 每 2s 一次、把 pacing shift 顶到 4s 上限
 *  (12:33/20:33 实证 ×7)。同一次偏差只允许补偿一次,给恢复留出观察窗。 */
const BRIDGE_FRONT_REBASE_COOLDOWN_MS = 5_000;

/** front-rebase 允许的上游积压上限(ms):一旦接收侧已积压,deltaUs 变小是「欠料」而非
 *  「贴住墙钟」,此时停喂只会把积压推向 overflow。稳态 inQueue ≈1.5–1.75s,阈值取 3s。 */
const BRIDGE_FRONT_REBASE_MAX_BACKLOG_MS = 3_000;

/** 接收侧 overflow 保留上限(ms):裁旧保新时把 inQueue 压回该深度(与接收端 L 同量级),
 *  余下的时间线缺口交给 aligner 的 skip 路径自然吸收。 */
// [验收9/MA 差异] 对齐 sendspin_bridge.py:1511-1516 `_held_chunks`
// (MAX_HELD_AUDIO_US=45s / MAX_HELD_CHUNKS=4000)防「锚点永不落定 ⇒ hold 无限涨」
// 的同一故障面;本仓取 2s 裁旧保新(更激进更早丢旧),hold 恒 ≤2s,
// **结构性排除**该故障面 —— 不叠 MA 同款层(2026-11-25 裁决:双重丢帧策略会打架)。
const BRIDGE_OVERFLOW_KEEP_MS = 2_000;

// [N4/MA sendspin_bridge.py:118-124 SILENCE_BLOCK 同款] 1 秒 48k/s16le/2ch 静音共享块:
// 对齐器补静音/欠料补静音的**只读母版**(immutable 全零),消费侧一律切片后 copy,
// 绝不把共享块本体交给会改写的持有者 —— 防 timeline rebase 大洞的 MB 级一次性分配。
const SILENCE_BLOCK = Buffer.alloc(BRIDGE_PCM_BYTES_PER_SEC);

/** Fix-1: 桥会话建立(RECORD 完成)后主动推一次初始音量。此前桥会话只在音量
 *  **变更**事件时才有 SET_PARAMETER(cast 路径 control.applyVolumeDb 不覆盖桥),
 *  起播/重连会话从不推,接收端落默认初始音量(shairport-sync -18dB ⇒ loopback
 *  实测 -50.8dB 峰值,近乎无声)。音量以 airplay_device_state 落库值为准
 *  (读失败回退 80),0-100 标尺映射 -30..0dB;失败只记日志,不阻断起流。 */
function pushInitialVolume(
  player: RaopPlayer,
  deviceId: string,
  groupVolume?: number,
  sameHostDlnaPeer?: string,
  /** 无组上下文时的设备落库音量/静音(主进程从 DB 解析后下发;子进程不碰 DB)。 */
  deviceFallback?: { volume?: number; muted?: boolean },
): void {
  try {
    if (raopSuppressInitialVolume()) {
      log.info(`push initial volume skipped (MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME) device=${deviceId}`);
      return;
    }
    if (raopSkipVolumeWithDlnaPeer() && sameHostDlnaPeer) {
      log.info(`push initial volume skipped: same-host DLNA peer=${sameHostDlnaPeer}(对齐 solo 豁免, MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER) device=${deviceId}`);
      return;
    }
    // v4.9.3(§音量语义):组上下文桥会话初始音量 = player_groups 落库值(用户裁定:
    // 流转/起播绝不采用成员设备自身音量,否则「流转后组音量变成员旧值」);
    // 无组上下文(undefined)回落设备落库值 —— 由主进程随 bridgePrepare 下发
    // (2026-11-11:子进程不再 import deviceState,那条链会拉 db/index 多开一条连接)。
    if (typeof groupVolume === "number") {
      const gdb = groupVolume === 0 ? -144 : degreesToDb(groupVolume);
      player.setVolumeDb(gdb);
      log.info(`push initial volume: ${gdb.toFixed(2)}dB (groupVol=${groupVolume}%) device=${deviceId}`);
      return;
    }
    const vol = deviceFallback?.volume ?? DEFAULT_AIRPLAY_VOLUME;
    const db = deviceFallback?.muted || vol === 0 ? -144 : degreesToDb(vol);
    player.setVolumeDb(db);
    log.info(`push initial volume: ${db.toFixed(2)}dB (vol=${vol}%) device=${deviceId}`);
  } catch (e: any) {
    log.warn(`push initial volume failed: device=${deviceId} err=${e?.message || e}`);
  }
}

const log = createLogger("AirPlay");

// ---------------------------------------------------------------------------
// 漂移对齐(§4.5:targetFrames = round((tsUs − A)·rate/1e6) vs 实际内容位置)
// ---------------------------------------------------------------------------

export interface BridgeAlignAction {
  /** 需补的静音帧数(内容落后/有洞;调用方把等量静音追加进输出)。 */
  insertFrames: number;
  /** 需裁头帧数(内容超前/重叠;调用方跳过后续等量输出,并经 bridgeSkipFrames 前移 RTP 时间线)。 */
  dropFrames: number;
  /** 欠料超上限:不物化静音,内容位置直接跳到 target(此后旧 tsUs 帧按 drop 出清)。 */
  skipFrames: number;
  /** |drift| > 1ms(§4.5:记 realigned)。 */
  realigned: boolean;
  /** 原始差 target − contentPos(帧)。 */
  diff: number;
  /** 本次 skip 是否来自**换代首帧**的大缺口（newgen-skip）。
   *
   *  分账用途（2026-11-19）：换代首帧撞结构缺口是**正常**行为（每次新会话/换歌都会），
   *  与「曲中 seek/断料导致的本地跳段」性质完全不同。前者若计入 `skippedFrames`，
   *  `isContentAxisPoisoned()` 会恒真 ⇒ 每次换歌都 `resetTimeline` ⇒ 曲头反复重建
   *  ⇒ 曲中 insert 变密（240 实测 50min 7 次）。故只累加 `newgenSkipFrames`。 */
  newgenSkip?: boolean;
}

/** realigned 日志分级(降噪 rider):无动作(insert/drop/skip 全 0)的恒定漂移
 *  是稳态噪声(实测 2.1 万行/20min,低功耗机白烧 CPU),降 DEBUG;有补/裁/跳
 *  动作的对齐才是真事件,保持 WARN。 */
export function realignedLogLevel(
  act: Pick<BridgeAlignAction, "insertFrames" | "dropFrames" | "skipFrames">,
): "debug" | "warn" {
  return act.insertFrames === 0 && act.dropFrames === 0 && act.skipFrames === 0
    ? "debug"
    : "warn";
}

/** 内容时间线对齐器(§4.5)。
 *
 *  contentPos = 已追加输出流的内容前沿(帧,A 起算;= 上一帧输出之后的位置):
 *  - 追加 n 帧输出 → pos += n(produced);
 *  - 补静音 n 帧(内容落后/有洞)→ 静音占据真实时间线,pos += n;
 *  - 裁头 n 帧(内容重叠)→ pos **不**推进:从后续重采样输出中丢弃 n 帧(takeDrop),
 *    追加流保持连续,内容位置自动回落到源时间线(RTP 时间线随之自洽,无需跳帧);
 *  - 欠料超上限 → pos 直接跳到 target(skip),不物化大段静音(可闻结果等价:静音),
 *    此时内容与 RTP 时间线出现 S 帧错位,由调用方经 bridgeSkipFrames(S) 前移 RTP 闭合。
 *
 *  ⚠️ 对齐参照是「已产出/待产出」的内容位置,不是「已写入 RAOP」的位置(§4.5 的
 *  queuedFrames 口径):outBuf 里还有未发余料,若按已写入数比对,常驻 pending 会被
 *  误判成内容超前。 */
export class BridgeTimelineAligner {
  private pos = 0;
  private drops = 0;
  private realignCount = 0;
  private lastDrift = 0;

  constructor(
    /** 对齐锚点 A(host µs):tsUs 内容时间线零点(第一帧有效 AUDIO 的 tsUs)。 */
    private readonly anchorUs: bigint,
    /** 输出采样率(44.1k 重采样 / 48k 直通)。 */
    private readonly rate: number,
    /** 不动作阈值(帧;默认 441 ≈ 10ms,driftCorrection 同源)。 */
    private readonly thresholdFrames = 441,
    /** 补静音上限(帧;默认 2s,超过改走 skip)。 */
    private readonly insertCapFrames = rate * 2,
  ) {}

  get contentPos(): number { return this.pos; }
  /** 内容零点(host µs):早于它的输入帧**整块丢弃、不补静音**(D5,MA `_drop_until_us`)。 */
  get contentAnchorUs(): bigint { return this.anchorUs; }

  get pendingDrops(): number { return this.drops; }
  get realignments(): number { return this.realignCount; }
  get lastDriftUs(): number { return this.lastDrift; }

  /** AUDIO 帧到达(tsUs = 帧首样本的组时间线可听时刻)。返回对齐计划;
   *  内部已按计划推进 contentPos,调用方负责落实样本(补/丢/追加)。 */
  onFrame(tsUs: bigint): BridgeAlignAction {
    const target = Math.round((Number(tsUs - this.anchorUs) * this.rate) / 1e6);
    const plan = driftCorrection(target, this.pos, { thresholdFrames: this.thresholdFrames });
    let insert = 0;
    let drop = 0;
    let skip = 0;
    if (plan.insert > 0) {
      if (plan.insert > this.insertCapFrames) {
        // 长欠料:不物化静音,直接跳到新时间线;滞留的旧 tsUs 帧随后按 drop 出清。
        skip = plan.insert;
        this.pos = target;
      } else {
        insert = plan.insert;
        this.pos += insert;
      }
    } else if (plan.drop > 0) {
      // 内容落后于已写流(重叠):这些帧已被更早写出的内容/静音覆盖,只能裁掉 ——
      // 不推进 pos,从后续重采样输出中丢弃(takeDrop),追加流保持连续。
      //
      // ⚠️ 只补记「尚未排队」的重叠量:pendingDrops 已在队列里等 takeDrop 消费,
      //    若每帧再按**绝对** drift 重记(旧实现),pos 在被全部裁掉时不前进 ⇒
      //    同一段重叠被逐帧重复记账 ⇒ 队列三角累计。2026-10-26 真机实锤:
      //    切歌重锚只有 1.48s 重叠,队列却累计到 43s(1914975 帧)⇒ 之后 43 秒
      //    100% 输出被裁(只剩补静音),可闻 = 切歌后约 45 秒无声,而 bridge
      //    state 全程 live、queueMs 仅 4-12ms(极易误判成"桥没在播")。
      const overlap = Math.max(0, plan.drop - this.drops);
      drop = overlap;
      this.drops += overlap;
    }
    this.lastDrift = Math.round((plan.diff / this.rate) * 1e6);
    const realigned = Math.abs(this.lastDrift) > 1000;
    if (realigned) this.realignCount++;
    return { insertFrames: insert, dropFrames: drop, skipFrames: skip, realigned, diff: plan.diff };
  }

  /** 实际追加 n 帧重采样输出(insert 静音已在 onFrame 内计,勿重复调)。 */
  produced(n: number): void {
    if (n > 0) this.pos += n;
  }

  /** 到目标时间线的帧差(target − pos;正 = 内容落后/有洞)。只读,不改状态。 */
  gapFramesTo(tsUs: bigint): number {
    const target = Math.round((Number(tsUs - this.anchorUs) * this.rate) / 1e6);
    return target - this.pos;
  }

  /** 新代次首帧大缺口:内容位置直接跳到 target(不物化静音,语义 = skip)。
   *  返回实际跳过的帧数(≤0 = 无需跳);调用方负责经 bridgeSkipFrames 同步 RTP 时间线。 */
  skipGapTo(tsUs: bigint): number {
    const gap = this.gapFramesTo(tsUs);
    if (gap <= 0) return 0;
    this.pos += gap;
    this.lastDrift = Math.round((gap / this.rate) * 1e6);
    this.realignCount++;
    return gap;
  }

  /** producer 欠料静音补块占 n 帧(占据内容时间线,保持对齐连续)。 */
  padded(n: number): void {
    if (n > 0) this.pos += n;
  }

  /** 从重采样输出中消费裁头余量,返回实际裁掉的帧数(≤ n)。 */
  takeDrop(n: number): number {
    const d = Math.min(Math.max(0, n), this.drops);
    this.drops -= d;
    return d;
  }
}

// ---------------------------------------------------------------------------
// 锚点计划(§3.3;纯函数,单测钉住可达性重锚)
// ---------------------------------------------------------------------------

export interface BridgeAnchorPlan {
  /** 组时间线锚点 A(host µs,**不含成员补偿**;对齐零点/节拍基准)。
   *  旧模式(开关关闭)下它仍含成员补偿(逐字节退回改造前语义)。 */
  anchorUs: bigint;
  /** 节拍锚点 = A + 重采样群延迟(GD,µs):RAOP `sendAt` 的基准。
   *  **不含成员补偿** ⇒ 同内容在各成员的同刻送包时刻一致(抓包同刻内容一致)。
   *  旧模式下 = anchors.anchorUsShifted(改造前节拍基准)。 */
  beatAnchorUs: bigint;
  /** 出声锚点 = A + 成员补偿(µs):AP2 出口(无 RTP 映射)的可听基准。 */
  playAnchorUs: bigint;
  /** 四字段锚点(computeBridgeAnchors 产出,baseTs/startTs/headTs/startNtp/A′)。 */
  anchors: BridgeAnchors;
  /** 是否触发了可达性重锚(A − L − SAFETY < now)。 */
  reAnchored: boolean;
  /** E2 实验:now 锚(MF_BRIDGE_RAOP_NOW_ANCHOR)生效 —— anchorUs = now。 */
  forceNow: boolean;
  /** 指令提前量 = A − now(锚点确定时刻;§3.5 commandedLeadUs)。 */
  commandedLeadUs: bigint;
}

/** 由首帧 tsUs 与 RECORD 协商 L 计算四字段锚点(含可达性检查,§3.3 末段)。
 *
 *  - 可达(A − L − SAFETY ≥ now):A = 首帧 tsUs 原样;
 *  - 不可达:A = max(now + warmLead, 首帧 tsUs) —— 桥会话刚完成 RECORD,按热启 lead 重锚,
 *    更早的内容(含首帧)由对齐器按 drop 出清,绝不硬塞。
 *  - 群延迟补偿仅重采样路径(48k 直通 resampled=false ⇒ A′ = A)。 */
/** exp2:now 锚前向偏移(ms→µs)。缺省 400 = 设备抖动缓冲深度 —— 偏移为 0 时
 *  RTP 时间线=到包即播,设备缓冲≈0,任何网络抖动直接饿流(240 真机「秒级循环
 *  卡顿」,周期 ≈ L=1s)。非法值回退默认。
 *
 *  ⚠️⚠️ 方向修正(2026-10-29,原注释写反了):offset 应 **≥** L+SAFETY,不是 <。
 *  节拍 sendAt = A′ − L − SAFETY,而 now 锚 A′ = now + offset:
 *    - offset **<** L+SAFETY ⇒ sendAt(0) 落到**过去**,首包即欠账 (L+SAFETY−offset)。
 *      该欠账是**常量**:后续每包同额落后,又够不着 BRIDGE_RESUME_REBASE_US(2s)
 *      ⇒ pacing rebase 永不触发 ⇒ 整首歌每包都「迟到追发」(latePackets≈100%),
 *      设备有效缓冲被砍到只剩 offset。空档 > offset 即欠载。
 *      (240 实证:offset=400/L=1s ⇒ 首包欠账 655ms、latePackets 34857/34859、
 *       设备缓冲仅 400ms;maxGap 1005ms / 切歌饥饿 2.6~3.0s 一来,
 *       HiVi(MUZO)固件欠载播静音且不自动重缓冲 —— 「播放中死掉后再不出声」。)
 *    - offset **≥** L+SAFETY ⇒ sendAt(0) 在未来(或恰为 now)。首包仍是**立即发**
 *      (offset 恰等于 L+SAFETY 时 sendAt(0)=now,零等待),只是可听时刻相应后移;
 *      设备拿满 L+SAFETY 缓冲。落未来不是问题,落过去才是。
 *  下限由 planBridgeAnchor 强制(此处无法得知 L);env 只可上调不可下调。 */
export function raopNowAnchorOffsetUs(): bigint {
  const v = Number(process.env.MF_BRIDGE_RAOP_NOW_ANCHOR_OFFSET_MS);
  const ms = Number.isFinite(v) && v >= 0 ? v : 400;
  return BigInt(Math.round(ms * 1000));
}

/** E2 实验:RAOP 出口 now 锚开关(MF_BRIDGE_RAOP_NOW_ANCHOR)。
 *  缺省(未设置)= ON;显式 0/false = 关闭回旧路径(未来锚)。
 *  仅作用于 RAOP 出口成员;AP2 出口(maybeBeginStream)不透传 forceNow。 */
export function raopNowAnchorEnabled(): boolean {
  const v = process.env.MF_BRIDGE_RAOP_NOW_ANCHOR;
  return !(v === "0" || v === "false");
}

/** 换歌垫片窗静音续流开关(MF_BRIDGE_RAOP_GAP_FILL)。缺省 ON;0/false = 关闭回
 *  「垫片窗 RTP 断流」旧行为。2026-10-29 240 实证:断流窗反复饿死 MUZO 接收端
 *  (欠载假死)⇒ 永久无声;续流让接收端全程有包(可听间隙不变,仍是静音)。 */
export function raopBridgeGapFillEnabled(): boolean {
  const v = process.env.MF_BRIDGE_RAOP_GAP_FILL;
  return !(v === "0" || v === "false");
}

/** S2(2026-11-01)自然换歌保留桥队列开关。缺省 ON;`MF_BRIDGE_TRACK_KEEP_QUEUE=0/
 *  false/off` 回退到「边界清空 inQueue/outBuf」的旧行为。
 *  背景:自动换歌(track 且非手动)本应是同一时间线的纯内容替换 —— 旧曲余料已经在
 *  桥队列里、ts 全部合法,清掉只会把「旧曲尾巴 + 新曲开头」整段砍掉(§8.5 实测
 *  0.41–1.26s);保留后旧余料自然播完,新代次帧按 ts 接在其后。 */
// ==================== 可听位置校正 ====================
// tick 的 commandedLeadUs = 「已写入 RAOP、但设备还要这么久才出声」的音频量。
// 对外上报/队列推进必须减掉它，否则进度恒领先声音（240 实测 ~2.05s，与倍速无关）。
const bridgeLeadByDevice = new Map<string, { ms: number; at: number }>();
const BRIDGE_LEAD_TTL_MS = 5_000;

/** 记录并回填 tick 的 leadUs（保持原日志字段语义）。 */
function recordBridgeLead(deviceId: string, leadUs: bigint | number | null): number | null {
  if (leadUs === null || leadUs === undefined) return null;
  const n = Number(leadUs);
  if (!Number.isFinite(n) || n < 0) return null;
  bridgeLeadByDevice.set(deviceId, { ms: n / 1000, at: Date.now() });
  return n;
}

/** 该设备当前「写入未出声」的毫秒数；过期(>5s 无 tick)按 0 处理。 */
export function getBridgeLeadMs(deviceId: string): number {
  const v = bridgeLeadByDevice.get(deviceId);
  if (!v) return 0;
  if (Date.now() - v.at > BRIDGE_LEAD_TTL_MS) return 0;
  return v.ms;
}

export function bridgeTrackKeepQueueEnabled(): boolean {
  const v = process.env.MF_BRIDGE_TRACK_KEEP_QUEUE;
  return !(v === "0" || v === "false" || v === "off");
}

/** 会话活性看门狗开关(MF_BRIDGE_RAOP_LIVENESS_WATCHDOG)。缺省 ON;0/false = 关。
 *  判据 = 设备 **timing(NTP)心跳** 停摆超阈值 ⇒ 判会话未被接管/接收端僵死 ⇒ 先 TEARDOWN
 *  旧会话再完整重握手。 */
export function raopBridgeLivenessWatchdogEnabled(): boolean {
  // 判据演进史(三步都踩过,别再退回去):
  //   v4.9.7 判据=合流 lastDeviceSignalAt(含 timing)→ 缺省关闭(当时误以为 MUZO 正常播放
  //          会停发 timing);
  //   v4.9.8 判据=ctrl 重传请求停摆(lastCtrlSignalAt)→ **误杀健康流**:重传请求是丢包驱动
  //          信号,流越干净设备越不发(240 实证 loss=0 的 170s 流 latePackets 仅 297),
  //          ctrl 静默满 300s 即被判「audio 通道死亡」→ 每 5min00s 一次、每次 9~14s 静音;
  //   v4.10.0 判据=timing 心跳(lastTimingAt)→ 240 实测健康期恒为 **20 次/分钟(每 3s 一次)**,
  //          跨 8 次换歌不断流;设备接收端僵死时**立刻归零且永不恢复**(12:12:38 后 0 次/10min,
  //          同期服务端推完 3 条流)。「MUZO 正常播放会停发 timing」的旧结论据此推翻。
  // 误报代价 = 一次 reconnect(新 RECORD + 重锚)。阈值 v4.10.1 起为 15s(≈漏 4 个心跳),
  // 并有 0/30s/120s 分级退避 + 连续 3 次救不回则停用 30min 兜底。
  const v = process.env.MF_BRIDGE_RAOP_LIVENESS_WATCHDOG;
  return !(v === "0" || v === "false");
}

/** 看门狗阈值 ms(MF_BRIDGE_RAOP_LIVENESS_MS,缺省 30000,下限 5000)。 */
export function raopBridgeLivenessMs(): number {
  const v = Number(process.env.MF_BRIDGE_RAOP_LIVENESS_MS);
  // 判据 = timing 心跳静默。缺省 **30s**(2026-11-03 由 15s 改,取证见下)：
  //   ① 15s 是照 **HiVi**(09 会话、会话内最大间隔 6.0s)标定的,但同一群里**MUZO
  //      (.102)** 的健康节律是"每 3s 一次 + 偶发 16~17s 空档"(240 实测:671 个间隔中
  //      593 个=3s,空档 16.14/16.52/17.06/17.37/17.57s)⇒ 15s 落在健康行为包络内,
  //      必然误杀。同一台 HiVi 在 MA 下不卡,正是因为 MA/libraop **没有**这条判据。
  //   ② 真正的死会话不再靠时间猜:先做**只读** OPTIONS 仲裁(arbitrateLiveness),
  //      有应答就绝不 TEARDOWN;30s 只是"开始怀疑"的门槛,不再等于"判死"。
  //   ③ 单次误杀的实际代价 = 整条桥队列(实测 6.28~7.60s 静音 + 内容丢弃),
  //      所以宁可晚 15s 怀疑,也不能把 16s 的健康空档当死。
  // env 下限放到 5s(排障用);低于 5s 视为误配,回落缺省。
  return Number.isFinite(v) && v >= 5000 ? v : 30000;
}

/** P1 仲裁探测节流:与 MA 的 RTSP OPTIONS 保活同频(25s);失败后 5s 重试,
 *  连续 2 次不可达才判死(单次可能是瞬断,重连代价 = 一整个队列的静音)。 */
const LIVENESS_PROBE_INTERVAL_MS = 25_000;
const LIVENESS_PROBE_RETRY_MS = 5_000;
const LIVENESS_PROBE_TIMEOUT_MS = 3_000;
/** 僵尸强制重建下限(ms):OPTIONS 有应答最多只能"推迟"重建,不能永久否决。
 *  240 实证(2026-11-03 10:10:52):HiVi 停发 timing 心跳(20 次/分钟→0)且永不恢复,
 *  但 RTSP OPTIONS 一直 200 ⇒ 旧仲裁把会话永久钉在"活着但不消费"(服务端 tick 全绿)。
 *  健康 MUZO 实测最大空档 17.6s,60s = 3.4×包络,不会误杀。 */
const LIVENESS_ZOMBIE_MIN_MS = 60_000;

/** 零心跳强制重建窗口(ms):会话起流后仍 **一次 timing 请求都没收到** ⇒ 设备接收端
 *  没切到本会话,必须 TEARDOWN + 重握手才能唤醒。240 实证(2026-11-03 10:29–11:28):
 *  MUZO(.102:4515)收到 122 包/秒 RTP、RTSP RECORD/OPTIONS 全 200,但 60 分钟零 timing、
 *  零重传请求、零出声 —— 旧实现把「从未收到 timing」整段豁免(判据不适用),于是永久静音。
 *  健康 MUZO/HiVi 固件实测恒 20 次/分钟(R7「正常播放停发 timing」已推翻),
 *  45s ≈ 两侧包络,不会误杀。 */
const NEVER_TIMING_REBUILD_MS = 45_000;

/** 熔断(纯函数):10 分钟内因心跳缺失重连 ≥2 次 ⇒ 判据可疑,停用 30 分钟。
 *  任何自动恢复都必须有失败退避 —— v4.9.8 的反面教材就是没有退避,一次误判变连环重连。 */
export function livenessBreakerActive(fireAtMs: number[], nowMs: number): boolean {
  const recent = fireAtMs.filter((t) => nowMs - t < 600000);
  return recent.length >= 2;
}

/** 熔断状态 —— **按 deviceId 持久,不随 BridgeSession 销毁**(2026-10-30 修结构性失效)。
 *
 *  原实现把 fireAt/cooldownUntil 放在 session 实例上,而看门狗每次触发都会重建 RAOP
 *  会话、进而重建 session 对象 ⇒ 历史随旧实例一起销毁 ⇒「窗口内 ≥2 次」的门槛永远
 *  攒不满,熔断等于摆设。240 实证:2026-10-29 10:03–10:48 连炸 10 次、间隔精确 300s,
 *  熔断一次都没生效。
 *
 *  分级策略(既不连环重连、也不把用户永久钉在无声上):
 *    - 窗口内第 1 次：立即重连(cooldown 0);
 *    - 窗口内第 2 次：最小间隔 30s;
 *    - 窗口内 ≥3 次：最小间隔 120s;
 *    - **连续 3 次重连都没把心跳救回来**(每次 fire 后 lastTimingAt 仍早于上次 fire)
 *      ⇒ 判「判据或设备侧已不可救」,停用 30min 止损并告警。
 *  只要重连后设备恢复过心跳(heartbeatSinceLastFire=true),failedRun 立刻归零,
 *  下一次该救的时候照常立刻救。 */
export interface LivenessBreakerState {
  fireAt: number[];
  cooldownUntil: number;
  lastFireAt: number;
  failedRun: number;
}
const livenessBreakerByDevice = new Map<string, LivenessBreakerState>();

export function livenessBreakerState(deviceId: string): LivenessBreakerState {
  let s = livenessBreakerByDevice.get(deviceId);
  if (!s) {
    s = { fireAt: [], cooldownUntil: 0, lastFireAt: 0, failedRun: 0 };
    livenessBreakerByDevice.set(deviceId, s);
  }
  return s;
}

/** 记一次看门狗触发,返回本次要不要重连、退避多久。纯状态机(便于单测)。
 *  @param heartbeatSinceLastFire 上次触发之后设备是否又发过心跳。 */
export function noteLivenessFire(
  deviceId: string,
  nowMs: number,
  heartbeatSinceLastFire: boolean,
): { firesInWindow: number; failedRun: number; cooldownUntil: number; disabled: boolean } {
  const s = livenessBreakerState(deviceId);
  s.fireAt = s.fireAt.filter((t) => nowMs - t < 600000);
  s.fireAt.push(nowMs);
  if (s.lastFireAt > 0 && !heartbeatSinceLastFire) s.failedRun += 1;
  else s.failedRun = 0;
  s.lastFireAt = nowMs;
  if (s.failedRun >= 2) {
    // 连续 3 次(T0 + 两次后续)重连全部没救回心跳 ⇒ 停用 30min。
    s.cooldownUntil = nowMs + 1800000;
    s.fireAt = [];
    s.failedRun = 0;
    return { firesInWindow: 0, failedRun: 0, cooldownUntil: s.cooldownUntil, disabled: true };
  }
  const gap = s.fireAt.length >= 3 ? 120000 : s.fireAt.length === 2 ? 30000 : 0;
  s.cooldownUntil = gap > 0 ? nowMs + gap : 0;
  return { firesInWindow: s.fireAt.length, failedRun: s.failedRun, cooldownUntil: s.cooldownUntil, disabled: false };
}

/** 测试用:清空熔断状态(不传 = 全清)。 */
export function resetLivenessBreaker(deviceId?: string): void {
  if (deviceId) livenessBreakerByDevice.delete(deviceId);
  else livenessBreakerByDevice.clear();
}

/** 看门狗触发判据(纯函数,便于测试):设备主动信号停摆超阈值且当前确在推流。
 *  暂停期不判(AP2 出口不判;重连进行中/已排程不重复触发)。 */
export function livenessWatchdogShouldFire(opts: {
  enabled: boolean;
  isAp2: boolean;
  paused: boolean;
  connected: boolean;
  closed: boolean;
  hasPlayer: boolean;
  streaming: boolean;
  reconnectInFlight: boolean;
  reconnectTimerSet: boolean;
  quietMs: number;
  thresholdMs: number;
  /** 本会话设备是否**证明过**自己会发 timing(NTP)心跳(player.timingCount > 0)。
   *  ⚠️ false 表示设备结构上从不发心跳(2026-11-01 240 pcap 实证:GGMM 240A64FED051
   *  20min 内 0 个 timing 请求,同组 HiVi 399 个)⇒ 「心跳停摆」判据对它恒真、且**无法
   *  区分僵死与健康**,只会每阈值一次 TEARDOWN + 重锚(实测把健康流切成每 6~7s 跳变)。
   *  因此本判据只在设备确有过心跳时才启用(与「ctrl 重传请求停摆」同罪的教训见上方演进史)。 */
  hasTimingHeartbeat: boolean;
}): boolean {
  if (!opts.enabled) return false;
  if (!opts.hasTimingHeartbeat) return false;
  if (opts.isAp2 || opts.paused || !opts.connected || opts.closed) return false;
  if (!opts.hasPlayer || !opts.streaming) return false;
  if (opts.reconnectInFlight || opts.reconnectTimerSet) return false;
  return opts.quietMs > opts.thresholdMs;
}

export function planBridgeAnchor(opts: {
  firstFrameTsUs: bigint;
  latencyFrames: number;
  rate: number;
  /** 是否经过重采样(决定群延迟补偿方向,MIN-01)。 */
  resampled: boolean;
  nowUs: bigint;
  warmLeadUs?: number;
  /** A/V 标定位移(µs,正 = 内容落点整体后移 = 桥延后)。缺省 0(历史行为)。
   *  群组同内容同步开启时它**只进映射锚点/AP2 出声锚点**,不进送包节拍(见 D1–D5)。 */
  anchorShiftUs?: number;
  /** E2 实验:forceNow = now 锚(anchorUs = now),首包即发;
   *  泵 lead 段相对组时间线提前播,对齐器以该锚点为零点(见 maybeBeginStream)。 */
  forceNow?: boolean;
  /** D7(2026-11-01):同组已发布的共享锚点(见 BridgeGroupAnchorRegistry)。
   *  仅 forceNow 分支消费;缺省 = 本会话自行取 now 锚(旧行为)。 */
  groupAnchorUs?: bigint;
  /** [2026-11-25 12:52] 设备**当前已排到的位置**（inBytes 换算，µs）。
   *  锚点 lead 必须覆盖它，否则新内容播点落在设备当前位置之前 ⇒ 被 D5 整块丢弃
   *  （真机：设备持 5.4s 而 lead 3.5s ⇒ 切歌一次丢 20 万帧 ≈ 4.2s）。 */
  queuedUs?: bigint;
  /** [2026-11-25 11:58] 本会话**首次**锚定 ⇒ cold 预热(MA sendspin_bridge.py:98-99
   *  的 cold 4.5s)。设备冷态渲染延迟远小于稳态值，若不预热就开播，成员延迟补偿会
   *  建立在错误相位上（用户实测：起播偏、切歌后设备已热才正常）。切歌(reseed)不预热，
   *  否则每次换歌都要多等 2 秒（真机 lead 3595ms ⇒ 换歌静音过长）。 */
  coldPreheat?: boolean;
  /** [P0-B 2026-11-25] 保留队列(S2 track-keep-queue)尾的内容时刻(µs,内容域)。
   *  非接续换代时锚点必须 ≥ 它,否则旧曲尾被排进「未来」。缺省 0 = 没有保留队列,
   *  该下限不参与(纯 seek/rehost/清队列路径行为不变)。 */
  keepQueueTailUs?: bigint;
}): BridgeAnchorPlan {
  const sync = bridgeSyncGroupTimelineEnabled();
  const shiftUs = BigInt(opts.anchorShiftUs ?? 0);
  // 组时间线锚点(**不含成员补偿**)
  let anchorUs = opts.firstFrameTsUs;
  const warmUs = BigInt(opts.warmLeadUs ?? BRIDGE_WARM_START_LEAD_US);
  const lUs = BigInt(Math.round((opts.latencyFrames / opts.rate) * 1e6));
  const safetyUs = BigInt(RAOP_SAFETY_MS * 1000);
  let reAnchored = false;
  if (opts.forceNow === true) {
    // E2 实验(MF_BRIDGE_RAOP_NOW_ANCHOR,缺省 ON):now 锚 —— anchorUs = now。
    // 背景(2026-10-28 240 实证):MUZO 类固件只支持「到包即播」语义,对
    // 「SYNC 未来锚 2.3s + 首包延迟 1.25s」的桥会话永不开始渲染(solo 旧墙钟
    // 路径 now 锚可出声)。now 锚下首包立即发;泵 lead 段相对组时间线提前播;
    // 对齐器以组锚点为零点(见 maybeBeginStream)保持内容连续 —— 绝不触发
    // skip 跳段时间线(skip 会把 RTP 重新标回未来,等于没修)。
    // exp2:+ raopNowAnchorOffsetUs()(缺省 400ms)—— 设备抖动缓冲深度;
    // exp6(2026-10-29):offset 下限钳到 lUs+safetyUs —— sendAt(0) 绝不能落到过去,
    // 否则首包即欠账且该欠账够不着 rebase 阈值,整首歌带着欠账跑(见函数头注释)。
    // env 仍可上调(想要更深缓冲时);下调被拒绝,逃生门是关掉 forceNow 本身。
    const wantLeadUs = raopNowAnchorOffsetUs();
    const floorLeadUs = lUs + safetyUs;
    let leadUs = wantLeadUs > floorLeadUs ? wantLeadUs : floorLeadUs;
    // [2026-11-25 12:04 实验：cold 预热] forceNow 分支的 lead 只由 offset(400ms)+L+safety
    // 决定（实测 2.05s），设备冷态渲染延迟尚未进入稳态就开播 ⇒ 成员延迟补偿建立在
    // 错误相位上 ⇒ 起播偏快、切歌后（设备已热）才对齐。
    // MA sendspin_bridge.py:98-99 用 cold 4.5s 预热解决同一问题。此处先做**全局**实验
    // （每次起播都给 4.5s），验证「预热是否解决起播偏移」；成立后再按 warm/cold 分档
    // 收紧到 2.5s 以免牺牲切歌速度。
    // [2026-11-25 14:22 修「首曲吞开头几秒」] cold 预热 4.5s → 3.0s。
    // 真机证据：起播 ack 报首帧提前量 actualLeadMs=4198，而锚点 lead=4500 ⇒
    // 锚点比**首帧内容**晚 302ms 以上，凡 ts 早于锚点的内容被 D5「早于 contentAnchorUs
    // 整块丢弃/裁头」判掉 ⇒ 用户听到开头几秒被吞（HiVi 补偿 0、锚点更晚，故比 iEAST 明显）。
    // 收紧到 3.0s：锚点不晚于首帧（3.0s < 4.2s），内容完整；设备仍有 3 秒预热。
    // [2026-11-25 14:45] cold 预热降级：仅作为「尚未收到首帧」时的回退值。
    // 收到首帧后锚点改由首帧内容时刻决定（见下方 anchor-content 段），
    // 否则 cold 会叠加在投递提前量之上、把锚点推到内容之后 ⇒ 吞开头。
    const COLD_PREHEAT_US = 3_000_000n;
    if (opts.coldPreheat === true && leadUs < COLD_PREHEAT_US) leadUs = COLD_PREHEAT_US;
    // [2026-11-25 12:52 结构性防护] 锚点 lead 必须覆盖设备**当前已排到的位置**，
    // 否则新内容播点落在设备当前位置之前 ⇒ 被 D5「早于锚点整块丢弃」判掉
    // （真机：设备持 5.4s 而 lead 3.5s ⇒ 切歌一次丢 20 万帧）。此处按实测
    // inQueue + 400ms 余量抬高 lead，使「缓冲深度」与「切歌提前量」永远配套 ——
    // 与 MA 的 AIRPLAY_LATE_JOIN_MIN_HEADROOM_MS(2.5s) 配 2.5s 缓冲同一思路。
    // [P0-C 2026-11-25] 余量改用命名常量(BRIDGE_SPLICE_LEAD_MARGIN_US,语义见 rates.ts):
    // splice 型接收端只在指令时刻落在残留音频之后才换锚,余量不够 ⇒ 指令被忽略 ⇒
    // 时戳域整体错位(240 iEAST 14:45:33 实证)。行为与旧 inline 400ms 逐字节一致。
    if ((opts.queuedUs ?? 0n) + BigInt(BRIDGE_SPLICE_LEAD_MARGIN_US) > leadUs) {
      leadUs = (opts.queuedUs ?? 0n) + BigInt(BRIDGE_SPLICE_LEAD_MARGIN_US);
    }
    // [2026-11-25 14:22] lead **上限 3.8s**：父侧投递上沿 5s、实测首帧提前量 ~4.2s；
    // lead 一旦越过首帧时刻，锚点就会落在内容之后 ⇒ D5 丢弃开头内容（吞开头）。
    const LEAD_CAP_US = 3_800_000n;
    if (leadUs > LEAD_CAP_US) leadUs = LEAD_CAP_US;
    // [2026-11-24 缓冲深度] warm 起播也保底 bridgeStartLeadUs(2.5s)。
    //   forceNow 分支此前只取 max(offset 400ms, L+safety≈2.05s) ⇒ tick 实测真实出音
    //   提前量 `deltaUs` 恒 2.06s、设备 inQueueMs 仅 1.1s（用户要求 2.5s 量级）。
    //   cold 已由 COLD_PREHEAT_US(3.0s) 覆盖，此处只抬 warm；代价是切歌首帧多 ~450ms
    //   静默。注意 deltaUs 才是「设备提前拿到多久的音频」，inQueueMs 里含对齐器垫的
    //   静音，两者不是同一口径，不要拿 inQueueMs 当缓冲深度来调这个值。
    // 三重门：①显式 warm(`coldPreheat === false`,未传参 `undefined` 一律不动 —— 保底是"同会话 reseed"语义,不是"任何未声明调用"的缺省);
    // ②用户没显式上调 env offset(`wantLeadUs <= floorLeadUs`,即 offset 未越过 L+SAFETY 下限);
    // ③确实低于 warm 保底值。env 上调(offset > L+SAFETY)优先,不被保底覆盖。
    if (opts.coldPreheat === false && wantLeadUs <= floorLeadUs && leadUs < warmUs) leadUs = warmUs;
    // ===== [2026-11-25 14:45 对齐 MA _anchor_stream：锚点 = 内容起点] =====
    // MA 语义（sendspin_bridge.py:886-1030）：
    //   anchor_ms = max(now + 最小安全, first_chunk_unix_ms)  —— 锚点绝不晚于首帧内容；
    //   随后 _drop_until_us = anchor_us，内容一律从该零点起算，故不会「吞开头」。
    // 我们此前的错误：forceNow 分支把锚点写成 now + 预热(cold 4.5s/3.0s)，而父侧投递的
    // 内容时间戳本身已在 now + ~4.2s（投递上沿 5s）—— 预热其实已由投递提前量提供；
    // 再叠加一次 cold 预热 ⇒ 锚点晚于首帧 ⇒ ts 早于 contentAnchorUs 的内容被 D5
    // 裁头/整块丢弃 ⇒ 用户听到「开头几秒被吞」（HiVi 补偿 0、锚点更晚，故比 iEAST 明显）。
    // 正解：锚点直接取首帧内容时刻（设备从第 0 秒出声，首包已提前 ~4.2s 到达 = 天然预热）；
    // 仅当首帧早于设备最小安全(L+safety)时才抬到该下限（那时丢一点不可避免）。
    {
      // [2026-11-25 14:48 修正] 锚点 = now + lead，且 **lead 绝不越过首帧内容时刻**。
      // 上一版直接取「首帧内容时刻」当锚点 ⇒ 父侧首帧已提前 ~4.9s 到位 ⇒ 设备要等
      // 4.9 秒才出声、期间 inQ=0、late 暴涨（真机 14:45 实证）。MA 的 first_chunk 是
      // 「当前待播内容」而非「未来内容」，直接照抄语义会把投递提前量误当成起播延迟。
      // 正确：锚点取期望预热(cold/warm/自适应)，但夹在 [minSafe, 首帧-200ms] 之间 ——
      //   · 上限保证不越过首帧 ⇒ D5 不会裁头/丢弃开头（不吞）；
      //   · 下限保证设备来得及（L+safety）。
      const minSafeUs = opts.nowUs + lUs + safetyUs;
      const contentUs = opts.firstFrameTsUs;
      // [P0-B 2026-11-25 单一约束点] 锚点必须同时满足:minSafe(设备来得及)/
      // ≥ 保留队列尾(旧尾不被排进未来)/ ≤ 首帧 −200ms(新曲开头不被 D5 裁头)。
      // 三者合并进同一个 floor/ceiling 夹紧,不另起第二套判据。
      const keepFloorUs = (opts.keepQueueTailUs ?? 0n) > 0n
        ? (opts.keepQueueTailUs as bigint) - opts.nowUs
        : 0n;
      if (contentUs && contentUs > 0n) {
        let useLead = leadUs;
        // [v6] 抬升前的值: 组锚共享路径的 floor 语义仍用它(它已吸收 splice 残留下限),
        // 绝不能让「向首帧靠拢」污染组锚下限 —— 否则组锚会被顶到 now+4s 而失去同源
        // (单测 groupAnchorShare ② 抓到的真 bug)。
        const useLeadPreLift = useLead;
        const contentOffsetUs = contentUs - opts.nowUs;
        const ceiling = contentOffsetUs - 200_000n; // 留 200ms 余量，确保锚点在首帧之前
        // [治本 v6 2026-11-25] 锚点向首帧**靠拢**（此前只降不升）。
        // 真机 06:14 实证: 切歌时 contentVsNowMs=4708 而 finalLeadMs=2500 ⇒ 锚点比
        // 首帧早 2.2s ⇒ 该段先播静音、随后被判过期丢弃(droppedFrames +145272≈3.3s)。
        // 抬到「首帧−200ms」使设备恰好在内容到达时出声, 消除空洞。
        // 上限 BRIDGE_START_WAIT_MAX_US(30s): 取源慢(首帧更晚)时只等 30s, 绝不挂死;
        // 剩余差额仍是静音, 但绝不会出现「无限等待」。
        // 上限 30s(用户口径: 宁可多等也要稳)。实际永不触顶: 父侧投递视界只有
        // CAP 5s + ahead 0.5s, contentVsNow 最大约 5.5s, 故真实等待仍 ~4.5s;
        // 30s 只为在异常大间距时也不强行截断(宁可多等, 不丢内容)。
        const BRIDGE_START_WAIT_MAX_US = 30_000_000;
        if (ceiling > 0n) {
          const waitMax = BigInt(BRIDGE_START_WAIT_MAX_US);
          const target = ceiling < waitMax ? ceiling : waitMax;
          // 只处理「空洞 > 1.5s」的大错配(真机 06:14: contentVsNow 4.7s vs lead 2.5s
          // ⇒ 2.2s 空洞)。小于 1.5s 保持原样 —— 既避免为极小差额改变既有时序,
          // 也保护 forceNow 系列用例依赖的「下限钳制」语义。
          // 注意用 >= : 真机《燃》冷启动实测 contentVsNow 4713 ⇒ ceiling 4513 ⇒
          // target = min(4513, 4000) = 4000, 而 useLead 2500 ⇒ 差恰好 1500ms。
          // 用 > 会让这个最常见的场景(5s 视界 + 2.5s warm lead)永远差 1µs 不触发。
          if (target - useLead >= 1_500_000n) useLead = target;
          if (useLead > ceiling) useLead = ceiling;
        }
        const floorUs = minSafeUs - opts.nowUs > keepFloorUs ? minSafeUs - opts.nowUs : keepFloorUs;
        if (useLead < floorUs) useLead = floorUs;
        // [验收6/MA A] 组共享锚点仍不得击穿本设备的 minSafe/splice 下限,也不得晚于
        // 首帧−200ms(宁吞新头)。MA 出处:sendspin_bridge.py:934-945(splice 下限链)
        // 与 :886-1030(组时间线归属);差异=MA 把 adjust 折进命令时刻,我们在此夹紧。
        if (opts.groupAnchorUs !== undefined) {
          anchorUs = opts.groupAnchorUs;
          // floorAllUs 必须包含 useLead(它已吸收 splice 残留下限):组锚不得击穿
          // 本设备自身的任何下限(MA :934-945 splice 链是 per-device 的)。
          const floorA = minSafeUs - opts.nowUs > keepFloorUs ? minSafeUs - opts.nowUs : keepFloorUs;
          const floorAllUs = floorA > useLeadPreLift ? floorA : useLeadPreLift;
          if (anchorUs < opts.nowUs + floorAllUs) anchorUs = opts.nowUs + floorAllUs;
          const firstCeilUs = contentUs - 200_000n;
          if (anchorUs > firstCeilUs) anchorUs = firstCeilUs;
        } else {
          anchorUs = opts.nowUs + useLead;
        }
        log.info(
          "[anchor-content] dev=" + (opts.coldPreheat === true ? "cold" : "warm")
          + " contentVsNowMs=" + String(Math.round(Number(contentOffsetUs) / 1000))
          + " minSafeMs=" + String(Math.round(Number(floorUs) / 1000))
          + " finalLeadMs=" + String(Math.round(Number(useLead) / 1000))
          + " picked=" + (opts.groupAnchorUs ? "shared" : "now+lead"),
        );
      } else {
        anchorUs = opts.groupAnchorUs ?? opts.nowUs + leadUs;
        log.warn(
          "[anchor-content] dev=" + (opts.coldPreheat === true ? "cold" : "warm")
          + " no-first-frame -> fallback now+preheatMs=" + String(Math.round(Number(leadUs) / 1000)),
        );
      }
    }
  } else if (anchorUs - lUs - safetyUs < opts.nowUs) {
    const floorUs = opts.nowUs + warmUs;
    if (floorUs > anchorUs) {
      anchorUs = floorUs;
      reAnchored = true;
    }
  }
  // [2026-11-25 12:02] 恢复：映射锚点吃成员补偿（见下）。原 10:49 的移出改动
  // 导致补偿彻底失效（真机 12:00 实证），已回退。
  //   · 补偿由投递时间线承载（server.bridgeDeliveryShiftUs，带换代后 3s 稳态窗口）；
  //   · 若这里再加 shift，起播时映射锚点 A′ 会被平移 -500ms（真机 anchor 日志：
  //     iEAST shifted=sched−499637µs 而 HiVi 只 +363µs）⇒ iEAST 抢先出声、快半秒；
  //   · 切歌后重新 plan（shift=0）就不偏 ⇒ 这正是"起播错、切歌对"的根因。
  // 旧注释保留供追溯：曾认为「补偿唯一落点=桥会话锚点」（MA sync_adjust 语义），
  // 但设备起播以锚点为基准、且 warm 复用会沿用带 retime 偏移的旧映射，无法保证一致。
  // [2026-11-25 12:02 恢复] 映射锚点吃成员补偿（A′ = 该值 + 重采样群延迟）。
  const mapAnchorUs = sync ? anchorUs + shiftUs : anchorUs;
  const anchors = computeBridgeAnchors({
    anchorUs: mapAnchorUs,
    latencyFrames: opts.latencyFrames,
    rate: opts.rate,
    chunkLen: CHUNK_LEN,
    compensateGroupDelay: opts.resampled,
  });
  return {
    anchorUs,
    // 节拍基准不含成员补偿 ⇒ 同内容在各成员的同刻送包时刻一致
    beatAnchorUs: sync ? anchorUs + (opts.resampled ? BigInt(Math.round(groupDelayUs(opts.rate))) : 0n) : anchors.anchorUsShifted,
    // 出声锚点(AP2 出口;无 RTP 映射)才吃补偿
    playAnchorUs: sync ? anchorUs + shiftUs : anchors.anchorUsShifted,
    anchors,
    reAnchored,
    commandedLeadUs: anchorUs - opts.nowUs,
    forceNow: opts.forceNow === true,
  };
}

// ---------------------------------------------------------------------------
// D7(2026-11-01):组时间线**共享锚点**登记表
// ---------------------------------------------------------------------------

/** 复用共享锚点允许的「lead 不足」容差(µs):被复用的锚点最多比本设备的 lead 下限
 *  早这么多 ⇒ 首包迟到该量级,由 pacing 立即追发吸收(宁晚不散)。 */
export const GROUP_ANCHOR_LATE_TOLERANCE_US = 500_000;

/** 同组同 gen 的锚点登记表(跨会话状态,由 BridgeSessionManager 持有)。
 *
 *  根因(240 抓包实证 2026-11-01):forceNow 锚 = `nowUs + lead`,**每会话各自取 now**
 *  ⇒ 同组两台设备因 RECORD 握手完成时差(实测 47.6ms)拿到不同的 `scheduledAnchorUs`
 *  (1395870728313 vs 1395870775885)。该锚点同时决定「内容零点(对齐器 target)」与
 *  「送包节拍基准」⇒ 同刻包内内容整体错位 6 个包:payload bytes 仍 100%(同一内容集合),
 *  但 lag0_corr 掉到 0.76~0.84、best_lag=+6 包 —— 直接违反验收判据
 *  「同一时刻包内音频内容一致」。
 *
 *  修法(与 D1–D6「组时间线唯一」同一不变量):同组同 gen **只允许一个锚点** ——
 *  首个规划者发布,同组后续规划者复用(内容轴/节拍轴因此逐 µs 同源)。
 *
 *  安全边界:①只对带 groupKey 的桥共享(单机桥不参与,也避免不同组 gen 撞车);
 *  ②复用前校验该锚点对本设备仍可达(`anchorUs ≥ now + floor − 容差`),否则不共享
 *  (中途重连那种「锚点在几十秒前」的场景属于组级重锚问题,不在本表职责内)。 */
export class BridgeGroupAnchorRegistry {
  private readonly byKey = new Map<string, { anchorUs: bigint; leadUs: bigint; atMs: number }>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxEntries = 32,
  ) {}

  /** 取同组同 gen 的共享锚点;无 / 过期 / 对本设备已不可达 ⇒ null(调用方自行规划并发布)。
   *  [验收6/MA A] 返回值携带**组级 lead**(首个规划者的 commandedLeadUs):后续成员的
   *  锚点必须从同一组参考派生,不允许各自独立种子漂移。MA 出处:sendspin_bridge.py
   *  `_anchor_stream` —— "Always a join: the Sendspin timeline is the group's, never
   *  the bridge's to set";START 一律 join=True 并把设备 ack 映射回组时间线。
   *  本仓差异:未做 ack 映射(结构改动),以「共享锚点 + 本设备下限夹紧」近似,
   *  见 planBridgeAnchor 的 groupAnchorUs 分支与 maybeBeginStream 的 floormiss 诊断。 */
  peek(
    groupKey: string,
    gen: number,
    nowHostUs: bigint,
    floorLeadUs: bigint,
  ): { anchorUs: bigint; leadUs: bigint } | null {
    const k = `${groupKey}#${gen}`;
    const e = this.byKey.get(k);
    if (!e) return null;
    if (Date.now() - e.atMs > this.ttlMs) {
      this.byKey.delete(k);
      return null;
    }
    if (e.anchorUs + BigInt(GROUP_ANCHOR_LATE_TOLERANCE_US) < nowHostUs + floorLeadUs) return null;
    return { anchorUs: e.anchorUs, leadUs: e.leadUs };
  }

  /** 发布锚点(同 key 已有则保留先发布者 = 首个规划者的组时间线零点与组级 lead)。
   *  [验收6/MA A] lead 与 anchor 一起登记,后到成员以同一组参考派生锚点。 */
  publish(groupKey: string, gen: number, anchorUs: bigint, leadUs: bigint): void {
    const k = `${groupKey}#${gen}`;
    if (this.byKey.has(k)) return;
    this.byKey.set(k, { anchorUs, leadUs, atMs: Date.now() });
    if (this.byKey.size > this.maxEntries) {
      const oldest = [...this.byKey.entries()].sort((a, b) => a[1].atMs - b[1].atMs)[0];
      if (oldest) this.byKey.delete(oldest[0]);
    }
  }

  clear(): void { this.byKey.clear(); }
}

// ---------------------------------------------------------------------------
// D8(2026-11-01):组时间线**边界一致性**登记表
// ---------------------------------------------------------------------------

/** 同组同 gen 的「换歌边界处置」登记表(clear 优先)。
 *
 *  问题(240 实测):BOUNDARY 由组泵逐成员下发,各成员看到的 reason 可能不同
 *  (一台 stop、另一台 track),而 onBoundary 的处置是**成员本地**决定的 ——
 *  一台清空桥队列、另一台保留旧余料 ⇒ 同代次的内容起点不唯一;该起点差一旦产生,
 *  后续每次自然换歌都会带着它走(cap6 实测分裂 2.7~2.95s 跨换歌粘住)。
 *
 *  不变量:同组同 gen 的边界处置必须一致 —— 任一成员要「重启型」(清队列)⇒ 全组清;
 *  只有全组都只看到 track(纯内容替换)时才保留队列。 */
export class BridgeGroupBoundaryRegistry {
  private readonly byKey = new Map<string, { clear: boolean; atMs: number }>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 32,
  ) {}

  /** 登记本成员的处置(clear 可升级不可降级)。 */
  publish(groupKey: string, gen: number, clear: boolean): void {
    const k = `${groupKey}#${gen}`;
    const prev = this.byKey.get(k);
    if (prev && (prev.clear || !clear)) return;
    this.byKey.set(k, { clear, atMs: Date.now() });
    if (this.byKey.size > this.maxEntries) {
      const oldest = [...this.byKey.entries()].sort((a, b) => a[1].atMs - b[1].atMs)[0];
      if (oldest) this.byKey.delete(oldest[0]);
    }
  }

  /** 同组同 gen 是否已有成员要求「重启型」处置。 */
  isClearRequired(groupKey: string, gen: number): boolean {
    const k = `${groupKey}#${gen}`;
    const e = this.byKey.get(k);
    if (!e) return false;
    if (Date.now() - e.atMs > this.ttlMs) {
      this.byKey.delete(k);
      return false;
    }
    return e.clear;
  }

  clear(): void { this.byKey.clear(); }
}

// AP2 realtime 出口(Phase 6b · T03:与 RAOP 并列的第二出口)
// ---------------------------------------------------------------------------

/** AP2 realtime 会话的最小契约(`Ap2StreamSession` 结构化满足;测试可注入假实现)。
 *  ⚠️ 刻意不把 `Ap2StreamSession` 的类型写进 BridgeSession 的公开签名 —— 桥只认
 *  「开 / 推 / 关 + 状态」四件事,ALAC/RTP/HAP 细节全在 ap2/* 里。 */
export interface Ap2SessionLike {
  /** 建控制面(pair-verify → SETUP(session) → RECORD → SETUP(stream) → 排水通道)。 */
  open(): Promise<unknown>;
  /** 推一块 PCM(s16le 交织),返回实际发出的包数。 */
  pump(pcm: Buffer): number;
  /** TEARDOWN + 资源回收(幂等)。 */
  close(): Promise<void>;
  /** 会话状态(缺省按 open 处理;测试假件可省略)。 */
  readonly currentState?: Ap2StreamState;
  /** 累计统计(linkLoss 非空 = 链路已断,`ev=link-loss` 已在 AP2 侧记录)。 */
  readonly stats?: { sent: number; errors: number; lastError: string | null; linkLoss: string | null };
}

/** AP2 会话工厂(生产 = `new Ap2StreamSession(opts)`;测试注入假件,不连设备)。 */
export type Ap2SessionFactory = (opts: Ap2StreamOptions) => Ap2SessionLike;

/** AP2 输出循环的注入依赖(纯逻辑可测:不碰真实时钟/socket)。 */
export interface Ap2OutputDeps {
  /** 拉一块 352 帧 s16le(`BridgeSession.pullOutChunk` 适配);null = 会话终止。 */
  pull(): Promise<Buffer | null>;
  /** 发一块(等价 RAOP 的 sendChunk)。`errors` 是**累计**错误数(驱动自行取增量)。 */
  send(pcm: Buffer): { sent: number; errors: number; state: string };
  nowUs(): bigint;
  /** 等待(µs;实现须可被 shouldStop 提前打断,且不留悬挂定时器)。 */
  sleepUs(us: number): Promise<void>;
  /** 会话已停 / 代次中止 / 链路已断 ⇒ 立刻退出(不泄漏定时器与监听)。 */
  shouldStop(): boolean;
  /** 组泵暂停中:暂停期**不拉块、不发送、不写静音**(与 RAOP pause 同语义)。 */
  isPaused(): boolean;
  /** 唯一那次 `planBridgeAnchor` 的锚点(host µs)—— AP2 **不得**另起时间线。 */
  anchorUs: bigint;
  /** 输出速率(= agreedRate;ap2-realtime 恒 48000)。 */
  rate: number;
  /** 每块帧数(= CHUNK_LEN 352)。 */
  spf: number;
  /** 有效提前量(帧):sendAt_i = A + i·spf/rate − L_eff。 */
  lEffFrames: number;
  lateSkipUs?: number;
  rebaseUs?: number;
  sendErrorLimit?: number;
  /** [S8 校准闭环]首块实际发出墙钟(µs,host 单调钟)——会话内只回调一次。
   *  测量点 = send(pcm) 成功后,是「实际出声时刻」的发送面 proxy(差一个
   *  设备确定性渲染延迟 = 声明的 latency,可解析抵消)。 */
  onFirstSend?: (wallUs: number) => void;
  onLateSkip?: (total: number, lagUs: number) => void;
  onRebase?: (lagUs: number) => void;
  onSendError?: (consecutive: number, total: number) => void;
}

export interface Ap2OutputResult {
  /** 实际发出块数(不含被 late-skip 丢掉的)。 */
  chunks: number;
  /** 因 sendAt 已过太久被丢弃的块数(`ev=ap2-late-skip` 计数)。 */
  lateSkipped: number;
  stopReason: "eof" | "aborted" | "link-loss";
}

/** AP2 realtime 发送节拍循环(纯驱动,零 IO)。
 *
 *  - 节拍:`sendAt_i = A + i·spf/rate − L_eff`(A 来自唯一那次 planBridgeAnchor)。
 *    **不加 `RAOP_SAFETY_MS`** —— 那是 RAOP 的 socket 调度余量,AP2 的提前量已由
 *    latencyMin 声明给接收端,再叠加会让 AP2 恒早 50ms 与同组 RAOP 成员错位。
 *  - 迟到:lag ≤ LATE_SKIP 照发(等价 RAOP 追发);lag > LATE_SKIP 丢块并计数
 *    (等价 RAOP 的 skip 语义:内容位置照常推进,时间线仍只有一条);
 *    lag > REBASE(长时间饥饿/恢复)只前移**发送**参考、不动锚点(与 RAOP 一致)。
 *  - 退出:供给 null(eof)/ shouldStop(aborted)/ 会话状态非 open 或连续发送错误
 *    达上限(link-loss)。三种都必须离开循环(调用方不再有定时器/监听残留)。
 */
export async function runAp2OutputLoop(deps: Ap2OutputDeps): Promise<Ap2OutputResult> {
  const lateSkipUs = deps.lateSkipUs ?? AP2_LATE_SKIP_US;
  // [S8 任务 3]rebase 显著性阈值:BRIDGE_RESUME_REBASE_US(2s) → 500ms。
  // 对标 MA playback.py:90 ANCHOR_REBASE_SIGNIFICANT_US(值 500_000,语义=锚点移动
  // 超 500ms 才算显著偏移,值得立即 rebase/重锚;player.py:2706-2711 同口径过滤)。
  // 行为变更(审计采纳项,裁决允许):旧阈值 2s 下,恒定 0.5~2s 的欠账永远够不着
  // rebase ⇒ 整首歌每包「迟到追发」(latePackets≈100%,见 :410 事故注释);
  // 新阈值下 ≥500ms 的持续滞后立即前移发送参考,<500ms 的噪声不 rebase、
  // 注意:lag ∈ (lateSkip, rebase) 区间**没有累积机制** —— 实际行为是逐块 late-skip 丢帧追赶(每块丢一拍追一拍),不是攒着到下一拍。只动判据这一处,冷却/互斥(front-rebase)不碰。
  const rebaseUs = deps.rebaseUs ?? CURSOR_JUMP_BEHIND_US;
  const errorLimit = deps.sendErrorLimit ?? AP2_SEND_ERROR_LIMIT;
  // L_eff(帧) → µs 用同一份换算函数(audibleAtUs(0 锚点) = 纯帧→µs)。
  const lEffUs = audibleAtUs(deps.lEffFrames, 0n, deps.rate);
  let idx = 0;
  let chunks = 0;
  let lateSkipped = 0;
  let firstSent = false;
  let pacingShiftUs = 0n;
  let prevErrors = 0;
  let consecutiveErrors = 0;
  let stopReason: Ap2OutputResult["stopReason"] = "eof";
  while (!deps.shouldStop()) {
    if (deps.isPaused()) {
      // 暂停期:不拉块(否则会把组泵内容提前从队列里抽走)、不发送、不写静音。
      await deps.sleepUs(AP2_WAIT_SLICE_MS * 1000);
      continue;
    }
    const pcm = await deps.pull();
    if (pcm === null) {
      stopReason = deps.shouldStop() ? "aborted" : "eof";
      break;
    }
    const sendAt = audibleAtUs(idx * deps.spf, deps.anchorUs, deps.rate) - lEffUs + pacingShiftUs;
    const now = deps.nowUs();
    if (now < sendAt) {
      await deps.sleepUs(Number(sendAt - now));
      if (deps.shouldStop()) {
        stopReason = "aborted";
        break;
      }
    }
    // 睡醒/到达后的迟到判定(暂停恢复与长饥饿都落在这里)。
    const lagUs = Number(deps.nowUs() - sendAt);
    if (lagUs > rebaseUs) {
      // pacing 参考前移:锚点/RTP 映射不动(AP2 不另起时间线),恢复首块立即发出。
      pacingShiftUs += BigInt(lagUs);
      deps.onRebase?.(lagUs);
    } else if (lagUs > lateSkipUs) {
      lateSkipped++;
      idx++;
      deps.onLateSkip?.(lateSkipped, lagUs);
      continue;
    }
    const r = deps.send(pcm);
    if (!firstSent) {
      firstSent = true;
      deps.onFirstSend?.(Number(deps.nowUs()));
    }
    chunks++;
    idx++;
    if (r.state !== "open") {
      stopReason = "link-loss";
      break;
    }
    const delta = r.errors - prevErrors;
    prevErrors = r.errors;
    consecutiveErrors = delta > 0 ? consecutiveErrors + delta : 0;
    if (consecutiveErrors >= errorLimit) {
      deps.onSendError?.(consecutiveErrors, r.errors);
      stopReason = "link-loss";
      break;
    }
  }
  return { chunks, lateSkipped, stopReason };
}

// ---------------------------------------------------------------------------
// BridgeSession
// ---------------------------------------------------------------------------

export interface BridgeSessionOpts {
  deviceId: string;
  token: string;
  protocol: BridgeProtocol;
  /** 会合 socket 路径(主进程按 bridgeSocketPath() 计算后下发)。 */
  socketPath: string;
  /** RAOP 目标(四锚点驱动出声);dry 模式可缺省。AP2 realtime 同样用 host/port 建 RTSP。 */
  host?: string;
  port?: number;
  pk?: string;
  et?: string;
  /** AP2 realtime 建链载荷(仅 `protocol` 为 ap2-* 时使用;来自主进程 bridgePrepare)。
   *  缺省 ⇒ AP2 路径快速失败(stage="payload")、RAOP 路径完全不受影响。 */
  ap2?: {
    controllerId: string;
    credsHex?: { accessoryLTPK: string; controllerLTSK: string };
    latencyMin?: number;
  };
  /** 测试接缝:注入 AP2 会话工厂(缺省 `new Ap2StreamSession(...)`)。
   *  生产路径恒不传 ⇒ 与真设备建链;单测用它验双出口/节拍/降级而不连设备。 */
  ap2SessionFactory?: Ap2SessionFactory;
  /** 测试/落盘干跑:不做 RTSP 握手,只起 listener 验证 48k→44.1k 生产管线。 */
  dry?: boolean;
  /** A/V 标定位移(微秒,正 = 桥延后;主进程按 settings 下发)。见 bridgeCalib.ts。 */
  anchorShiftUs?: number;
  /** v4.9.3(§音量语义):桥会话初始音量(0-100,player_groups 落库值,主进程下发)。
   *  undefined = 无组上下文,pushInitialVolume 回落 deviceVolume(旧行为)。 */
  initialVolume?: number;
  /** 2026-11-11:无组上下文时的设备落库音量/静音(主进程从 airplay_device_state 解析后下发)。
   *  子进程**不 import deviceState** —— 那条链会拉 db/index,在 import 时就多开一条
   *  SQLite 连接(airplay 子进程本该零 DB)。 */
  deviceVolume?: number;
  deviceMuted?: boolean;
  /** v4.9.4-exp4:同 host DLNA renderer id(主进程判定后下发;子进程注册表恒空,
   *  不可自查)。初始 SET_PARAMETER volume 的 Linkplay 豁免依据。 */
  sameHostDlnaPeer?: string;
  /** producer 等料超时(ms),超时补静音块。默认 1000。 */
  waitDataMs?: number;
  /** stats tick 周期(ms,§10.5 每设备一行 JSON)。默认 2000;≤0 关闭。 */
  statsIntervalMs?: number;
  /** D7(2026-11-01):所属组 id(仅用于「组时间线共享锚点」,子进程不碰 DB)。
   *  缺省 = 无组上下文:该会话不参与共享(单机桥无「同刻同内容」要求)。 */
  groupKey?: string;
}

export interface BridgeSessionStats {
  framesIn: number;
  chunksOut: number;
  silenceChunks: number;
  /** §4.5 补静音帧数(内容落后/有洞)。 */
  insertedFrames: number;
  /** §4.5 裁头帧数(内容超前/重叠 + 欠料跳段出清)。 */
  droppedFrames: number;
  /** 欠料超上限直接跳段时间线的内容帧数(不物化静音)。
   *  ⚠️ 只记**曲中**跳段(seek/长断料)。换代首帧的 newgen-skip 记在
   *  `newgenSkipFrames`,不计入这里 —— 见 BridgeAlignAction.newgenSkip。 */
  skippedFrames: number;
  /** 换代首帧大缺口跳过的帧数（正常换代行为，诊断用；不参与污染判据）。 */
  newgenSkipFrames: number;
  /** |drift| > 1ms 的对齐次数(§4.5 realigned)。 */
  realignments: number;
  /** 旧 generation 帧/队列丢弃计数(Phase 5 BLK-02 判据:seek/rehost 后 > 0)。 */
  staleFramesDropped: number;
}

export class BridgeSession {
  readonly deviceId: string;
  /** 低缓冲持续起点(0 = 当前不低)。 */
  private lowQueueSinceMs = 0;
  /** 上次发出加压请求的时刻(冷却)。 */
  private lastPaceBumpReqAt = 0;
  readonly token: string;
  readonly opts: BridgeSessionOpts;
  /** 输出采样率(raop/ap2-compat = 44100;48k 协商直通 = 48000)。 */
  readonly outRate: number;

  private player: RaopPlayer | null = null;
  private raopSession: RaopSession | null = null;
  /** AP2 realtime 会话(protocol 为 ap2-* 时非空;与 player/raopSession 互斥)。 */
  private ap2Session: Ap2SessionLike | null = null;
  /** AP2 链路断开原因(`ev=link-loss` 的 reason;非空 ⇒ degraded,主进程看门狗摘桥)。 */
  private ap2LinkLoss: string | null = null;
  /** 因 sendAt 过久被丢弃的 AP2 块数(诊断口径,与 RAOP 的 latePackets 并列)。 */
  private ap2LateSkips = 0;
  private server: BridgeServer | null = null;
  private closed = false;
  private readonly waitDataMs: number;
  /** 48k 协商直通时为 null。 */
  private readonly resampler: PolyphaseResampler | null;

  /** 48k s16le 入队(桥帧 payload 原样 + tsUs)。 */
  private inQueue: Array<{ buf: Buffer; tsUs: bigint; generation: number }> = [];
  /** 群组同内容同步(D1–D5)开关快照:会话建立时读一次,热路径不查 env。 */
  private readonly groupTimelineSync = bridgeSyncGroupTimelineEnabled();
  private inBytes = 0;
  /** 输出速率 s16le 出缓冲(producer 逐 352 帧切割)。 */
  private outBuf: Buffer = Buffer.alloc(0);
  /** producer 预填充已完成 —— 预填充只在首块做一次(不是每块都做)。 */
  private prefillDone = false;
  readonly stats: BridgeSessionStats = {
    framesIn: 0, chunksOut: 0, silenceChunks: 0,
    insertedFrames: 0, droppedFrames: 0, skippedFrames: 0, newgenSkipFrames: 0, realignments: 0,
    staleFramesDropped: 0,
  };
  private streamPromise: Promise<void> | null = null;

  // ---- Phase 4:锚点与对齐状态 ----
  private connected = false;
  /** 会话对象创建时刻(ms)：空壳判据/暖复用判据的时间基准。 */
  private readonly createdAtMs = Date.now();
  /** 首帧有效 AUDIO 的 tsUs(A 候选;§7.2:锚点只在此刻确定)。 */
  /** [2026-11-25 11:58] 本会话是否已锚定过（首次锚定才 cold 预热，切歌不预热）。 */
  private anchoredOnce = false;
  private firstFrameTsUs: bigint | null = null;
  /** 锚点已落定(aligner 非 null ⇒ 已进入四锚点驱动)。 */
  private aligner: BridgeTimelineAligner | null = null;
  private anchors: BridgeAnchors | null = null;
  private anchorUs: bigint | null = null;
  private commandedLeadUs: bigint | null = null;
  /** [S8 校准闭环]锚定后**首块实际发出**的墙钟(µs,host 单调钟);null = 尚未发出。
   *  RAOP 路径在 pullChunk 首个成功块处记录(发送面 proxy,≤1 个节拍 before socket 写);
   *  AP2 路径由 runAp2OutputLoop 的 onFirstSend 精确记录。随 bridgeStats 每 2s 上报
   *  主进程,drift 判定 = actualSendAtUs − (anchorUs − firstPacketLeadUs)(S8 复核②修正:
   *  旧公式用 commandedLeadUs = anchorUs − now_plan,锚点对消后 drift ≡ 实际 − now_plan,
   *  测的是「计划→首包」墙钟差;改用**会话有效延迟**才与设备真实出声对齐)。
   *  RAOP 的 L_true 精确值需解析设备 TIMING,后续项 —— 当前 L_true ≈ 声明 latency。 */
  actualSendAtUs: number | null = null;
  /** [S8 复核②]锚点建立时确定的首包**预期提前量**(µs):AP2 = latencyFrames→µs;
   *  RAOP forceNow = 0(预期首包 = now_plan);RAOP 非 forceNow = L + SAFETY。
   *  drift = actualSendAtUs − (anchorUs − 本值)。null = 未锚定。 */
  firstPacketLeadUs: number | null = null;
  /** E3:锚点落定时刻的 chunksOut 快照(tick deltaUs 用增量)。 */
  private chunksOutAtPlan = 0;
  private generation = 0;
  /** 已进入 resampleIn 的最后一帧代次(0 = 旧无代次路径未计入)。用于识别「新代次首帧」。 */
  private lastResampledGen = 0;
  /** D6/P1:主进程 `bridgeManual` RPC 置的 sticky「用户手动 next/prev」标记(时间戳;0=无)。 */
  private manualPendingAt = 0;
  /** D6/P1:手动操作在泵侧先发 `stop` 再发 `track`(playFrom = stop→play)。
   *  标记必须在 stop 上**传递**给紧随的 track(否则回拨永不落地)。 */
  private carriedManualAt = 0;
  /** D6/P1:本次手动操作的「恰 1 次 FLUSH」是否已在 stop 边界发过(防 track 边界重复 FLUSH)。 */
  private manualFlushDone = false;
  /** D6/P1:手动 boundary 之后待应用的一次性 ts 回拨量(输出帧数;0=无)。 */
  private pendingRewindFrames = 0;
  private pendingRewindAt = 0;
  private maxQueueMs = 0;
  private deltaSamples: number[] = [];
  private statsTimer: NodeJS.Timeout | null = null;

  // ---- Phase 5:生命周期(代次重锚 / 暂停 / stall / RAOP 重连) ----
  /** 推流被终态打断(boundary/stall):producer 立刻返回 null,旧 streamBridge 循环退出。 */
  private streamAborted = false;
  /** 上一 tick 的内容前沿:用于判定「还有料可补」,冻结即跳过 pacing 重锚。 */
  private lastFrontierUs = 0n;
  /** A(垫片窗静音续流):token 递增令在跑 filler 退出;promise 供新流首包前收尾。 */
  private gapFillerToken = 0;
  /** [组A] 上次 late-selfheal-retime 时刻的 late 累计基线:retime 只对两次之间
   *  **新增**的 late 帧负责(MA _absorb_playout_shift 的 delta 口径;无新增=无证据
   *  不平移,防把猜测当实测)。 */
  private lastRetimeLateTotal = 0;
  private gapFillerPromise: Promise<number> | null = null;
  /** B(消费停滞看门狗):重连进行中防重入。 */
  private livenessReconnectInFlight = false;
  /** 心跳看门狗触发历史已上提为**设备级**(见 livenessBreakerState)——
   *  挂在 session 上会随每次触发重建而清零,熔断永远攒不满。 */
  /** 上一次看门狗触发时刻 player.timingCount 的快照(判「这次重连救回来没有」)。 */
  private timingCountAtFire = 0;
  /** 「本代次已打过『设备从不发 timing,看门狗豁免』日志」的代次号(防 2s tick 刷屏)。 */
  private livenessNoTimingLoggedGen = "";
  /** 本次起流(aligner 建立)时刻;零心跳重建用它判「起了多久还没一次 timing」。 */
  private streamStartedAtMs = 0;
  /** P1(2026-11-03):看门狗仲裁 —— 静默只触发一次**只读** OPTIONS 探测,探测在飞时防重入。 */
  private livenessProbeInFlight = false;
  private livenessProbeAtMs = 0;
  private livenessProbeFailures = 0;
  /** 「本代次已打过『探测有应答 ⇒ 判良性』日志」的代次号(探测每 25s 一次,不刷屏)。 */
  private livenessProbeOkGen = "";
  /** C-4 结构性兜底:connected 且有 player 却一直 aligner=null(无消费者)的起始时刻。 */
  private noConsumerSince = 0;
  /** v4.9.7:RAOP 会话重建期间的互斥门 —— 期间禁止 maybeBeginStream 起流,
   *  防止新流起在即将被 forceClose 的旧 player 上(见 reconnectRaop)。 */
  private raopReconnectInFlight = false;
  /** 组泵暂停状态(HEARTBEAT flags bit1,§5.4)。 */
  private pausedState = false;
  private pausedAtUs: bigint | null = null;
  /** RAOP 会话级重连退避(设备离线/推流异常断;与 sendspin 侧 BridgeSource 退避同参数)。 */
  private raopReconnectTimer: NodeJS.Timeout | null = null;
  private raopReconnectAttempt = 0;

  constructor(
    opts: BridgeSessionOpts,
    /** D7:同组共享锚点登记表(由 BridgeSessionManager 注入;缺省 = 不共享,旧行为)。 */
    private readonly groupAnchors?: BridgeGroupAnchorRegistry,
    /** D8:同组边界处置登记表(同上;缺省 = 成员本地处置,旧行为)。 */
    private readonly groupBoundaries?: BridgeGroupBoundaryRegistry,
  ) {
    this.opts = opts;
    this.deviceId = opts.deviceId;
    this.token = opts.token;
    this.waitDataMs = opts.waitDataMs ?? 1000;
    const outRate = PROTOCOL_CAPS[opts.protocol].rate;
    this.outRate = outRate;
    this.resampler = outRate === SENDSPIN_RATE ? null : new PolyphaseResampler(SENDSPIN_RATE, outRate, 2);
  }

  get listeningOn(): string | null {
    return this.server?.listeningOn ?? null;
  }

  /** 暖复用判据(B 方案,对齐 MA _can_reuse_stream_warm):会话未关闭且链路未降级
   *  (AP2 link-loss/error;RAOP 重连退避不算 —— 会话对象会自愈重连)。 */
  get warmReusable(): boolean {
    if (this.closed || this.ap2LinkLoss !== null || this.ap2Session?.currentState === "error") return false;
    // 空壳会话不得暖复用：见 BRIDGE_UNANCHORED_REBUILD_MS 注释。这里只挡"超时仍无 anchor"
    // 的，正常起播窗口（刚建 <15s）仍允许复用，避免每次 prepare 都重来一遍 RADOP 握手。
    if (this.anchorUs === null && Date.now() - this.createdAtMs > BRIDGE_UNANCHORED_REBUILD_MS) return false;
    return true;
  }

  /** 起 listener(+ 非 dry 时 RAOP 握手,等首帧 AUDIO 后进入四锚点驱动推流)。 */
  async start(): Promise<void> {
    const handlers: BridgeServerHandlers = {
      onAudio: (a) => this.ingestAudio(a),
      onSession: (ev) => {
        this.connected = ev.connected;
        if (!ev.connected) log.warn(`bridge session 断开: device=${this.deviceId} reason=${ev.reason ?? "-"}`);
      },
      onBoundary: (gen, reason) => this.onBoundary(gen, reason),
      onStall: (ev) => this.onLinkStall(ev),
      onHeartbeat: (gen, seq, paused) => this.onBridgeHeartbeat(paused === true),
      onOverflow: (ms) => this.onReceiveOverflow(ms),
      log: (...args: unknown[]) => log.info(args.map((a) => String(a)).join(" ")),
    };
    const server = new BridgeServer(
      { deviceId: this.opts.deviceId, token: this.opts.token, protocol: this.opts.protocol },
      handlers,
    );
    await server.listen(this.opts.socketPath);
    this.server = server;
    if (this.opts.dry) return;
    // ---- AP2 realtime 分支(Phase 6b · T03):只加分支,下面 RAOP 语句一行不动 ----
    if (this.isAp2) {
      await this.startAp2(server);
      return;
    }
    const player = new RaopPlayer({
      host: this.opts.host ?? "",
      port: this.opts.port ?? 5000,
      pk: this.opts.pk,
      et: this.opts.et,
      deviceId: this.opts.deviceId,
    });
    let session: RaopSession;
    try {
      session = await player.connect();
    } catch (e) {
      await server.close();
      throw e;
    }
    this.raopSession = session;
    this.player = player;
    this.connected = true;
    pushInitialVolume(player, this.opts.deviceId, this.opts.initialVolume, this.opts.sameHostDlnaPeer, {
      volume: this.opts.deviceVolume,
      muted: this.opts.deviceMuted,
    });
    // exp4:RECORD 后立即灌静音(缺省关闭)—— 把「设备见到 RTP 流」压到 solo 量级。
    // 必须传 session:端口在这里才被 apply,否则 sendto 目标端口=0(见 primeSilence 注释)。
    if (raopBridgeConnectPrimeEnabled()) {
      try { player.primeSilence(RAOP_CONNECT_PRIME_CHUNKS, session); } catch (e: any) { log.error(`prime silence failed: ${e?.message || e}`); }
    }
    // 首帧可能早于 connect 完成 —— 连接就绪后立即补判起流。
    void this.maybeBeginStream();
  }

  /** 本会话是否走 AP2 realtime(`ap2-*` 两态都不实现 buffered,但选择器只产出
   *  `ap2-realtime`;这里按前缀判定,便于未来扩展而不改调用点)。 */
  private get isAp2(): boolean {
    return this.opts.protocol.startsWith("ap2-");
  }

  /** AP2 建链:pair-verify(库内凭据)→ SETUP/RECORD → UDP 出口。
   *  与 RAOP 路径完全并列:失败 ⇒ 关 listener 并抛(错误带 stage,主进程据此回落 solo cast)。
   *  ⚠️ 出声节拍**不在这里** —— 由 runAp2Output 用唯一那次锚点驱动。 */
  private async startAp2(server: BridgeServer): Promise<void> {
    const ap2 = this.opts.ap2;
    if (!ap2 || !ap2.controllerId) {
      await server.close();
      const err = new Error("桥 AP2 载荷缺失(controllerId/credsHex):主进程必须先完成配对") as Error & { stage?: string };
      err.stage = "payload";
      throw err;
    }
    const factory: Ap2SessionFactory = this.opts.ap2SessionFactory ?? ((o) => new Ap2StreamSession(o));
    const session = factory({
      host: this.opts.host ?? "",
      port: this.opts.port ?? 5000,
      controllerId: ap2.controllerId,
      creds: ap2.credsHex,
      // 组泵侧恒 48k;ap2-realtime 声明 48k ⇒ resampled=false ⇒ 不做群延迟补偿。
      sourceRate: SENDSPIN_RATE,
      preferredRate: PROTOCOL_CAPS["ap2-realtime"].rate,
      spf: CHUNK_LEN,
      latencyMin: ap2.latencyMin ?? AP2_DEFAULT_LATENCY_FRAMES,
    });
    try {
      await session.open();
    } catch (e) {
      await server.close();
      void session.close().catch(() => { /* 建链失败清理失败不掩盖原错误 */ });
      throw e;
    }
    this.ap2Session = session;
    this.connected = true;
    log.info(`[airplay-bridge] ap2 realtime 就绪: device=${this.deviceId} rate=${this.outRate} spf=${CHUNK_LEN}`);
    this.pushAp2Volume(this.ap2InitialVolumeDb());
    // 首帧可能早于建链完成 —— 就绪后立即补判起流(与 RAOP 路径同语义)。
    void this.maybeBeginStream();
  }

  /** AP2 声明给接收端的 latencyMin(样本数;进 planBridgeAnchor 的 L 与 SETUP 同源)。 */
  private get ap2DeclaredLatencyFrames(): number {
    return Math.max(1, this.opts.ap2?.latencyMin ?? AP2_DEFAULT_LATENCY_FRAMES);
  }

  /** AP2 初始音量(dB,0-100 标尺 → -30..0dB,静音 → -144):与 RAOP 同源(主进程下发的
   *  设备落库值,未下发回退 80 —— 子进程不读 DB)。 */
  private ap2InitialVolumeDb(): number {
    try {
      const vol = this.opts.deviceVolume ?? DEFAULT_AIRPLAY_VOLUME;
      return this.opts.deviceMuted || vol === 0 ? -144 : degreesToDb(vol);
    } catch {
      return degreesToDb(DEFAULT_AIRPLAY_VOLUME);
    }
  }

  /** AP2 音量下发。`Ap2StreamSession` 本轮**未**暴露 setVolumeDb(其文件不在本轮改动
   *  范围内)⇒ 鸭子类型探测:命中即下发,未命中只 warn —— **音量失败 ≠ 无声**,
   *  绝不因音量路径缺失而拆掉一座能出声的桥。 */
  private pushAp2Volume(db: number): void {
    const s = this.ap2Session as unknown as { setVolumeDb?: (v: number) => void } | null;
    if (!s || typeof s.setVolumeDb !== "function") {
      log.warn(`[airplay-bridge] ap2 volume path unavailable: device=${this.deviceId} db=${db.toFixed(2)} (接收端沿用默认音量)`);
      return;
    }
    try {
      s.setVolumeDb(db);
      log.info(`ap2 push initial volume: ${db.toFixed(2)}dB device=${this.deviceId}`);
    } catch (e: any) {
      log.warn(`[airplay-bridge] ap2 setVolumeDb failed: device=${this.deviceId} db=${db.toFixed(2)} err=${e?.message || e}`);
    }
  }

  /** 48k s16le 原样入队(无时间线信息;兼容旧测试/落盘路径,tsUs 按 0 处理)。 */
  ingest(payload: Uint8Array): void {
    this.ingestAudio({ tsUs: 0n, generation: 0, sequence: 0, payload });
  }

  /** AP2 realtime 接点(Phase 6b):按 CHUNK_LEN=352 帧(输出速率 s16le/2ch)拉取一块;
   *  null = 会话已停/代次中止(AP2 pumpRealtime 随即退出)。纯数据面:
   *  桥不感知 AP2,只暴露"拉块"能力;重采样/对齐/补静音全在本类内完成。 */
  pullOutChunk(): Promise<Buffer | null> {
    return this.pullChunk();
  }

  /** 48k s16le 入队(bridgeServer AUDIO 回调)。返回输入积压 ms(§4.4 overflow 判定)。
   *  Phase 5:旧 generation 的迟到帧(BOUNDARY 清队后的在途残余)直接丢弃并计数
   *  —— BLK-02 判据「旧 generation 帧丢弃计数 > 0」的落点(绝不入队、绝不立锚)。 */
  /** 隔离模式下的本进程缓冲（到达节拍制，不用墙钟判过期）。
   *
   *  ⚠️ 2026-11-23 实测教训：`a.tsUs` 是**内容时间线**口径（父侧已减去 sendAhead），
   *  拿 `nowUs()` 去比"是否过期"会把每一帧都判掉（buffered 恒 0、pushed 停在 1693）。
   *  真正需要的是：按到达节奏排队（父侧本来就是 1x 投递），开局预灌一段让设备有垫子。
   */
  private ringBuf: Array<{ tsUs: number; nFrames: number; data: Uint8Array }> = [];
  private ringBufUs = 0;
  private ringSeq = 0;
  private ringPrefilled = false;
  private ringTimer: NodeJS.Timeout | null = null;
  private ringPushCount = 0;
  private ringPullCount = 0;
  private ringDropOld = 0;

  /**
   * 隔离模式入口（直通路径见 ingestAudioDirect）：上游帧先进本设备私有 ring，
   * 再由 startRingDrain 按节拍下泄。
   *
   * 对标 MA「每 cliairplay 进程自有 stdin ring」（stream.py:327 每播放器一进程、
   * :1195-1197 整会话一段 ring）—— 一台设备卡住只堵自己的缓冲，不影响组内
   * 其它设备；这正是隔离模式要在会话内复刻的缓冲隔离面。
   */
  private ingestAudio(a: BridgeAudioEvent): number {
    if (this.closed) return this.backlogMs();
    if (!playerIsolationEnabled() || a.tsUs === 0n) return this.ingestAudioDirect(a);

    // 换代（切歌/seek）：内容时间线重锚 ⇒ 旧缓冲作废
    if (a.generation !== 0 && a.generation !== this.generation && this.ringBuf.length > 0) {
      this.resetRingBuf();
      log.warn(`[ring-diag] dev=${this.deviceId} 换代清缓冲 gen ${this.generation}→${a.generation}`);
    }
    const ts = Number(a.tsUs);
    const nFrames = a.payload.byteLength >> 2;
    const durUs = (nFrames / 48_000) * 1e6;
    const last = this.ringBuf.length > 0 ? this.ringBuf[this.ringBuf.length - 1].tsUs : null;
    if (last !== null && ts <= last) {
      this.ringDropOld += 1; // 重复/回退（换代由 reset 负责，这里只防乱序）
      return this.backlogMs();
    }
    this.ringBuf.push({ tsUs: ts, nFrames, data: a.payload });
    this.ringBufUs += durUs;
    this.ringPushCount += 1;
    // 容量上限 20s：超了丢最旧（保实时）。
    // 对标 MA playback.py:82 _PRODUCER_BUFFER_LIMIT_US（值 30_000_000，语义=单成员
    //   缓冲上限，超则生产者睡眠）。我们：20_000_000 —— 差异原因：MA 用「睡生产者」
    //   反压，我们的上游是共享泵、不能被单设备反压，所以只能丢最旧；
    //   私有 ring 只是隔离面缓冲，组侧另有共享环兜底（见 playerRing.ts 同口径注释）。
    while (this.ringBufUs > 20_000_000 && this.ringBuf.length > 1) {
      const f = this.ringBuf.shift()!;
      this.ringBufUs -= (f.nFrames / 48_000) * 1e6;
      this.ringDropOld += 1;
    }
    if (!this.ringTimer) this.startRingDrain();
    if (this.ringPushCount === 1) {
      log.warn(`[ring-diag] dev=${this.deviceId} 首帧入队 ts=${ts} nFrames=${nFrames}`);
    }
    return this.backlogMs();
  }

  /**
   * 到达节拍制：首拍一次灌 6s（等价旧 bulk 回填），之后每 100ms 最多 250ms。
   *
   * 对标 MA（固定 send-ahead 的供给节奏）：MA 经 set_timing 声明
   * min_buffer_ms=1s（sendspin_bridge.py:511-517，值取自 :106），Sendspin 由此
   * 按**固定 send-ahead** 持续维持桥的 stdin ring（playback.py:55-64：live 源
   * send-ahead 恒为 min_buffer floor，不随曲长增长）—— 「续杯」节奏由成员缓冲
   * 水位驱动，不由生产者决定。
   * 我们：6s 首灌取 MA cold start lead（4.5s = warm headroom 2.5s + connect 预算
   * 2s，sendspin_bridge.py:92-98）量级偏上，吸收子进程冷启动；稳态 250ms/100ms
   * = 每个节拍周期补一小步，与 MA「持续小步供给」同形。差异：MA 由库内调度器
   * 按水位反压续杯，我们是显式定时器 —— ring 在自己代码里，水位/节拍显式
   * 可观测（[ring-diag]）。
   */
  private startRingDrain(): void {
    if (this.ringTimer) return;
    this.ringTimer = setInterval(() => {
      if (this.closed) return;
      this.ringPullCount += 1;
      // 水位伺服（2026-11-25 级联缓冲调参）：下泄预算 = 补齐「inQueue 目标 − 当前
      // inQueue」与 1.05x 实时速率的较大者 —— 设备侧 inQueue（RAOP 发送队列）
      // 保持在目标水位附近，既不饿死也不锯齿。旧实现固定 250ms/100ms（2.5x），
      // 与父侧 250ms 伺服突发叠加成「锯齿振荡」（inQ 0~125ms、late 缓涨）。
      // 6s 首灌（prefilled=false 阶段）保留 —— 冷启动快速建立缓冲。
      // 对标 MA PushStream 按成员水位供给（playback.py:947-963）。
      // [2026-11-25 12:44 修「秒级卡顿」] 目标水位 2s → 6s。
      // 真机证据：inQMs=1925、budgetMs=105（1.05x）⇒ 每 100ms 只喂 100ms 内容，
      // 供给恒等于消费、零余量；任何抖动直接吃掉设备可播放时长，累积到 0 即 underrun
      // （用户听到的秒级卡顿）。且包在 ring 里等到接近 ts 才发出 ⇒ late 持续缓涨。
      // MA sendspin_bridge.py:83-89 喂 CLI 是「设备缓冲 < MAX_DEVICE_BUFFER_SECONDS(8s)
      // 就持续喂」，从不贴着目标水位跑。
      // [2026-11-25 12:52 关键约束] 目标必须 **< 切歌 lead（3.5s）**：
      //   取 6s 时设备持 5.4s，切歌新锚点只提前 3.5s ⇒ 新内容播放点落在设备
      //   **已排到的位置之前** ⇒ 被 D5「早于 contentAnchorUs 整块丢弃」判掉
      //   （真机 gen=6000018 一次丢 20 万帧 ≈ 4.2s = 用户听到的秒级跳跃）。
      // 取 3s：稳态有 3s 抗抖余量（vs 1.9s 时的秒级卡顿），且 < lead 3.5s 不撞车。
      const inQueueTargetUs = 3_000_000;
      // [2026-11-25 09:02 对齐 MA 桥喂 CLI] 反馈量必须是**设备侧水位**（RAOP 发送队列
      // inBytes），不能是总缓冲 —— ringBuf 是子进程手里的存量，设备拿不到。用总缓冲会
      // 出现：ringBuf 2s + 设备 0 ⇒ 总缓冲 2s ≈ 目标 ⇒ 判定"够了"⇒ 只 1.05x 喂 ⇒
      // 设备永远拿不到那 2s ⇒ queueMs 205ms、late 涨（真机 08:58 cand=0/dueMs=0 实锤）。
      // MA sendspin_bridge.py 喂 CLI：只要设备缓冲 < MAX_DEVICE_BUFFER_SECONDS(8s) 就持续喂。
      const inQueueNowMs = Math.round((this.inBytes / BRIDGE_PCM_BYTES_PER_SEC) * 1000);
      const inQueueNowUs = BigInt(inQueueNowMs * 1000);
      const servoUs = inQueueNowUs >= BigInt(inQueueTargetUs) ? 0n : BigInt(inQueueTargetUs) - inQueueNowUs;
      // （backlogMs 现为总缓冲 = inBytes + ringBuf：ringBuf 有货时 inQueue 补齐不触发，
      //   总量稳定在 2s；ringBuf 排空且 inQueue < 2s 时按差量补 —— 平滑无锯齿）
      // [2026-11-25 12:56 闭环伺服] 三档：
      //   · 低于目标 ⇒ max(servoUs, 1.5x)：快速补足，给足追赶能力（旧 1.05x 毫无余量）；
      //   · 达到目标 ⇒ 1.0x 维持：**不能**再超前喂，否则缓冲单调增长（真机 12:55
      //     inQMs 5450 且不回落 ⇒ 切歌 lead 被自适应抬到 5.8s，换歌要等 6 秒）；
      //   · 冷启动首灌 ⇒ 3.5s（略高于目标，避免一开始就贴薄水位）。
      // 抖动丢失的缓冲会在下一拍被「低于目标」分支自动补回 —— 标准水位伺服。
      const catchupUs = 150_000;
      // [2026-11-25 13:06] 维持档 1.05x：1.0x 时任何一拍被拖慢就净损失缓冲且无法补回
      // （低于目标才补，但补的量又被 ring 存量限制）。1.05x 给微量正余量，缓慢自愈。
      const maintainUs = 105_000;
      const budgetUs = !this.ringPrefilled
        ? 3_500_000
        : servoUs > 0n
          ? (servoUs > catchupUs ? servoUs : catchupUs)
          : maintainUs;
      let taken = 0;
      let n = 0;
      while (this.ringBuf.length > 0) {
        const f = this.ringBuf[0];
        const durUs = (f.nFrames / 48_000) * 1e6;
        if (taken + durUs > budgetUs) break;
        this.ringBuf.shift();
        this.ringBufUs -= durUs;
        taken += durUs;
        n += 1;
        this.ringSeq += 1;
        this.ingestAudioDirect({
          tsUs: BigInt(f.tsUs),
          generation: this.generation,
          sequence: this.ringSeq,
          payload: f.data,
        });
      }
      if (!this.ringPrefilled && n > 0) this.ringPrefilled = true;
      if (this.ringPullCount <= 3 || this.ringPullCount % 50 === 0) {
        log.warn(
          `[ring-diag] dev=${this.deviceId} pull#${this.ringPullCount} n=${n} buffered=${this.ringBuf.length} bufferedMs=${Math.round(this.ringBufUs / 1000)} inQMs=${inQueueNowMs} budgetMs=${Math.round(Number(budgetUs) / 1000)} prefilled=${this.ringPrefilled} pushed=${this.ringPushCount} dropOld=${this.ringDropOld}`,
        );
      }
    }, 100);
    this.ringTimer.unref?.();
  }

  /** 换代：清空缓冲（内容时间线重锚）。 */
  private resetRingBuf(): void {
    this.ringBuf.length = 0;
    this.ringBufUs = 0;
    this.ringPrefilled = false;
  }

  private ingestAudioDirect(a: BridgeAudioEvent): number {
    if (this.closed) return this.backlogMs();
    if (a.tsUs !== 0n && a.generation !== 0 && a.generation < this.generation) {
      this.stats.staleFramesDropped += a.payload.byteLength >> 2;
      return this.backlogMs();
    }
    if (a.tsUs !== 0n && a.generation !== 0) this.generation = a.generation;
    const buf = Buffer.from(a.payload.buffer, a.payload.byteOffset, a.payload.byteLength);
    if (this.firstFrameTsUs === null && a.tsUs !== 0n) {
      this.firstFrameTsUs = a.tsUs;
      log.warn(`[ring-diag] dev=${this.deviceId} firstFrameTsUs 设置 → maybeBeginStream ts=${a.tsUs}`);
      void this.maybeBeginStream().catch((e) => log.error(`[ring-diag] dev=${this.deviceId} beginStream 失败: ${(e as Error)?.message}`));
    }
    this.inQueue.push({ buf, tsUs: a.tsUs, generation: a.generation });
    this.inBytes += buf.length;
    this.stats.framesIn += buf.length >> 2;
    return this.backlogMs();
  }

  private backlogMs(): number {
    // 总缓冲 = RAOP 发送队列(inBytes) + 到达环(ringBuf)。只报 inQueue 会让父侧
    // 伺服看不到 arrival ring 的锯齿（ringBuf 0↔4s 振荡、40s 周期）⇒ 补量失真。
    const ringMs = Math.round((this.ringBufUs / 1000));
    return Math.round((this.inBytes / BRIDGE_PCM_BYTES_PER_SEC) * 1000) + ringMs;
  }

  // ---- Phase 5:生命周期(§5.2/§5.4) ------------------------------------

  /** 流代次变更(BOUNDARY,§4.3/§5.4):
   *  - track/seek/rehost:清旧代次队列 + 计入 staleFramesDropped + 重锚 —— 新代次
   *    首帧确立新 A ⇒ 新 scheduledAnchorUs(可 grep `ev:"gen"` + `ev:"anchor"`);
   *  - stop:流终态(跨源切歌/组停),停推流;RAOP 会话由编排侧 bridgeStop 拆。 */
  /** D6/P1:`bridgeManual` RPC 落点 —— 只置 sticky 标记,不立即 FLUSH。
   *  真正的「1 次 FLUSH + ts 回拨」在下一个 track boundary 到达时执行,
   *  避免与正在跑的推流节拍/重传路径抢 socket。 */
  /** [验收10/debug-only] 复采注入口:模拟一次传输死亡,走与真实 send-error 完全相同的
   *  scheduleRaopReconnect 路径(守卫/上限/退避全部生效)。debug-only:仅复采/测试用,
   *  触发动作均为自愈链路已有动作,无额外破坏面(已批准不加 env 开关)。 */
  debugReconnect(reason: string): void {
    this.scheduleRaopReconnect(`debug/${reason}`);
  }

  /** [验收10/debug-only] 复采注入口:模拟一次**恢复成功** —— 同时喂两个基准:
   *  player.lastTimingAt(liveness 静默基线,防看门狗立刻二次判定)与
   *  lastRecoveryAtMs(30s 恢复守卫窗起点)。debug-only,语义同上。 */
  debugMarkRecovery(): void {
    const now = Date.now();
    if (this.player !== null) {
      (this.player as unknown as { lastTimingAt: number }).lastTimingAt = now;
    }
    this.lastRecoveryAtMs = now;
    log.info(`[airplay-bridge] debug mark-recovery: device=${this.deviceId} lastRecoveryAtMs=${now}`);
  }

  markManual(): void {
    this.manualPendingAt = Date.now();
    log.info(`[airplay-bridge] ${JSON.stringify({ ev: "manual-mark", dev: this.deviceId, gen: this.generation })}`);
  }

  /** 消费 sticky「手动」意图:无论有效与否都清零(过期标记不得泄漏到后续边界)。 */
  private takeManualIntent(): boolean {
    const at = this.manualPendingAt;
    this.manualPendingAt = 0;
    return at > 0 && Date.now() - at <= BRIDGE_MANUAL_STICKY_MS;
  }

  /** 消费「从 stop 传递过来」的手动意图(仅紧随的 track/rehost 有效)。 */
  private takeCarriedManual(): boolean {
    const at = this.carriedManualAt;
    this.carriedManualAt = 0;
    return at > 0 && Date.now() - at <= BRIDGE_MANUAL_CARRY_MS;
  }

  /** 最近一次 onBoundary 的原因(track/seek/rehost/stop)。Fix G 用它判换代->显式重锚。 */
  private lastBoundaryReason: string | null = null;
  /** 最近一次边界时刻(ms)。用于识别「track 之后紧随的同代次 seek」。 */
  private lastBoundaryAtMs = 0;
  private onBoundary(generation: number, reason: string): void {
    if (this.closed) return;
    const prevReason = this.lastBoundaryReason;
    const prevAtMs = this.lastBoundaryAtMs;
    this.lastBoundaryReason = reason;
    this.lastBoundaryAtMs = Date.now();
    log.info(`[airplay-bridge] ${JSON.stringify({ ev: "gen", dev: this.deviceId, gen: generation >>> 0, prevGen: this.generation, reason })}`);
    // sticky「手动」意图必须**先**消费(下面的 keepQueue 判据要用):手动 next 在泵侧
    // 是 stop→track 两步(playFrom = stop→play),也可能被标成 rehost —— 三种都必须认,
    // 但只能在**重启型**边界上落地。
    const pendingManual = this.takeManualIntent();
    const manual = reason === "stop" ? pendingManual : (pendingManual || this.takeCarriedManual());
    const queueFrames = (this.inBytes >> 2) + (this.outBuf.length >> 2);
    // S2(2026-11-01):自然换歌(track 且非手动)= 同一时间线的**纯内容替换** ⇒
    // 保留 inQueue/outBuf:旧曲余料已在桥队列里且 ts 全部合法,让它自然播完,
    // 新代次帧按 ts 接在其后(清掉等于把旧曲尾 + 新曲头整段砍掉,§8.5 实测
    // 0.41–1.26s)。只有会重启推流的边界(stop / seek / rehost / 手动)才清队列。
    // 回退:MF_BRIDGE_TRACK_KEEP_QUEUE=0 ⇒ 与改造前逐字节一致(恒清 + stale 统计)。
    const localKeep = reason === "track" && !manual && bridgeTrackKeepQueueEnabled();
    // [S15 无缝切歌 2026-11-28] 换曲后泵会紧接着发一次**同代次** seek(
    // `bridge-start-seek reason=new-session-first-delivery`,非用户 seek)。
    // 旧逻辑把它当「换代重启」:再清锚点 + flush,并丢掉刚排进桥队列的新曲帧
    // (240 实测 stale 128575 帧≈2.9s → 抓包 2.4s 静音,HiVi/iEAST 同时)。
    // track 边界已经重锚过,这次同代 seek 只是新曲的起点声明 ⇒ 吸收掉。
    const absorbInitialSeek =
      reason === "seek" &&
      prevReason === "track" &&
      (generation >>> 0) === this.generation &&
      Date.now() - prevAtMs <= 2000;
    // D8(2026-11-01):边界处置必须**组级统一**。各成员看到的 reason 可能不同
    // (A=stop / B=track),本地判定会让一台清队列、另一台保留 → 同代次内容起点不唯一
    // (cap6 实测分裂 2.7~2.95s 且跨换歌粘住)。规则:clear 优先(任一成员要清 ⇒ 全组清)。
    const groupKey = this.opts.groupKey;
    let keepQueue = localKeep || absorbInitialSeek;
    if (this.groupTimelineSync && groupKey && this.groupBoundaries) {
      this.groupBoundaries.publish(groupKey, generation >>> 0, !localKeep);
      if (localKeep && this.groupBoundaries.isClearRequired(groupKey, generation >>> 0)) {
        keepQueue = false;
        log.info(`[airplay-bridge] ${JSON.stringify({ ev: "group-boundary-clear", dev: this.deviceId, gen: generation >>> 0, reason })}`);
      }
    }
    const stale = keepQueue ? 0 : queueFrames;
    if (!keepQueue) {
      this.inQueue = [];
      this.inBytes = 0;
      this.outBuf = Buffer.alloc(0);
    }
    if (stale > 0) this.stats.staleFramesDropped += stale;
    if (stale > 0) log.info(`[airplay-bridge] ${JSON.stringify({ ev: "stale", dev: this.deviceId, gen: generation >>> 0, reason, staleFrames: stale, totalStaleFrames: this.stats.staleFramesDropped })}`);
    if (keepQueue) log.info(`[airplay-bridge] ${JSON.stringify({ ev: "track-keep-queue", dev: this.deviceId, gen: generation >>> 0, reason, keptFrames: queueFrames })}`);
    this.generation = generation >>> 0;
    if (reason === "stop") {
      // 终态:停推流(保留 listener 与 RAOP 会话;编排侧 bridgeStop 负责拆会话)。
      // [裁决2/warm grace, MA BRIDGE_WARM_GRACE_SECONDS=4s :81-85] MA 在流结束后
      // 保活 4s 等复用、真停(用户显式)立即拆。本仓语义**严格更长**:stop 边界只停
      // 推流,会话/socket 保留到显式 bridgeStop(组停/摘成员/孤儿回收),期间任何
      // 再播都走 prepare warm-reuse(F7 3s 例);显式停止路径立即拆(F7 真停例)。
      // 故不引入 4s 定时拆除 —— 见 rates.ts BRIDGE_WARM_GRACE_SECONDS 注释。
      this.firstFrameTsUs = null;
      this.aligner = null;
      this.anchors = null;
      this.anchorUs = null;
      this.commandedLeadUs = null;
      this.firstPacketLeadUs = null;
      this.streamAborted = true;
      this.player?.flush();
      // 手动标记**传递**给紧随的 track:回拨必须在重启型边界落地(MA 口径:
      // 恰 1 次 FLUSH + 新流 ts 回拨),而 FLUSH 已经在上面这条发过了
      // ⇒ 记 manualFlushDone 防 track 边界重复 FLUSH。
      this.carriedManualAt = pendingManual ? Date.now() : 0;
      this.manualFlushDone = pendingManual;
      return;
    }
    if (!manual) this.manualFlushDone = false;
    if (absorbInitialSeek) {
      // 保留刚排入的新曲帧,不再二次重锚/flush(track 边界已完成重锚)。
      log.info(`[airplay-bridge] ${JSON.stringify({
        ev: "track-initial-seek-absorbed",
        dev: this.deviceId,
        gen: generation >>> 0,
        keptFrames: queueFrames,
        sinceTrackMs: Date.now() - prevAtMs,
      })}`);
      return;
    }
    if (reason === "track" && !manual) {
      // [P0-B 2026-11-25 对齐 MA sendspin_bridge] **换代 track 边界必须重锚**。
      // 上游 `notifyBridgeGeneration(continuity=true)` 的分支根本不会给桥发 BOUNDARY
      // (server.ts 1008 早退),所以凡是在这里收到「gen 变了」的 track ⇒ 泵侧一定是
      // 非接续(continuity=false / contig=-):泵已按「墙钟 + lead」重立时间线。此时
      // 本会话若继续沿用旧锚点 + 保留队列,就是 MA 明确禁止的「两套时间轴并存」——
      // 真机三次实证(2026-11-24):realigned drift=-70879 帧(-1607.2ms) / -45202 帧
      // (1.02s) / -76456 帧(1.73s),全部是同形态、全部是新曲开头被 D5 裁头。
      // MA 语义:换曲即重新 anchor,`_drop_until_us = anchor_us`,新时间线零点唯一。
      // 实现:清锚点状态 + abort 推流(下一帧经 maybeBeginStream 重新 planBridgeAnchor,
      // 由 keepQueueTail 夹紧决定旧队列去留,见 planBridgeAnchor 的 keepQueueTailUs)。
      // gen 未变(同代重复边界 / clearPlayback 不换代)保持旧行为,逐字节不变。
      // MA 出处:sendspin_bridge.py:886-1030 `_anchor_stream` —— "换曲即重新 anchor",
      // 新时间线零点唯一(`_drop_until_us = anchor_us`);差异取舍:MA 每曲都重锚,
      // 我们只在**非接续**(gen 变)时重锚,接续(continuity=true)上游根本不发
      // BOUNDARY,旧曲尾与新曲首帧按连续 ts 无缝衔接,等价 MA 的 splice 语义且更省。
      const genChanged = (generation >>> 0) !== this.generation;
      if (!genChanged) {
        void this.stopGapFiller();
        return;
      }
      log.info(`[airplay-bridge] ${JSON.stringify({ ev: "track-reanchor", dev: this.deviceId, prevGen: this.generation, gen: generation >>> 0, keptFrames: queueFrames, note: "非接续换代 ⇒ 重新 planBridgeAnchor(MA 换曲重锚)" })}`);
      void this.stopGapFiller();
      this.firstFrameTsUs = null;
      this.aligner = null;
      this.anchors = null;
      this.anchorUs = null;
      this.commandedLeadUs = null;
      this.firstPacketLeadUs = null;
      this.streamAborted = true;
      this.player?.flush();
      return;
    }
    // 以下为「换代重启」:seek / rehost / 用户手动 next-prev(track+manual)。
    // [N-附 2026-11-25 第一轮复采] 该分支与 track 边界的 track-reanchor 是**两条重锚
    // 路径**(后者只覆盖 gen 变化的 track 边界),效果等价(清锚点状态+flush+重新
    // planBridgeAnchor)但此前无统一 ev 名 ⇒ 复采 grep 漏一半。这里补 boundary-reanchor
    // 留痕,与 track-reanchor 同字段口径,复采两条都要查。
    log.info(`[airplay-bridge] ${JSON.stringify({
      ev: "boundary-reanchor",
      dev: this.deviceId,
      prevGen: this.generation,
      gen: generation >>> 0,
      reason,
      note: "换代重启路径重锚(seek/rehost/手动),与 track-reanchor 等价",
    })}`);
    this.firstFrameTsUs = null;
    this.aligner = null;
    this.anchors = null;
    this.anchorUs = null;
    this.commandedLeadUs = null;
    this.firstPacketLeadUs = null;
    // 热复用 RAOP 会话,推流循环立刻退出,新代次首帧重新起流
    // (player.flush 置 started=false ⇒ 新流首包带 0xE0 marker,接收端重锚)。
    this.streamAborted = true;
    if (!(manual && this.manualFlushDone)) this.player?.flush();
    if (manual) {
      // 用户操作:MA 实测「恰 1 次 FLUSH、seq +1、新流 ts 回拨 1.588–1.695s」。
      // stop 边界已发过 FLUSH 时这里不重复发(manualFlushDone)。
      // 回拨量在流侧落地(只有 RaopPlayer 知道 lastSentTs),这里只记录需求;
      // AP2 无 RTP 时间线,不参与回拨。
      this.manualFlushDone = false;
      if (this.ap2Session === null) {
        this.pendingRewindFrames = Math.round((BRIDGE_MANUAL_REWIND_MS * this.outRate) / 1000);
        this.pendingRewindAt = Date.now();
      }
      // 基线中断仅 48–160ms:手动路径**不**起静音垫片(垫片会拉长中断并污染 ts 序列)。
      return;
    }
    // A(2026-10-29):垫片窗内静音续流 —— 旧流已停、新流未起,RTP 断流 ~2.5-3s
    // 会反复把 MUZO 接收端饿到假死(实证:零 timing/零重传后只有完整重握手能救)。
    // 续流只发静音,可听间隙不变;新流 0xE0 重锚语义不变。
    this.startGapFiller();
  }

  /** A:垫片窗静音续流(仅 RAOP 出口;AP2 不启用)。maxMs 8s 封顶:下一首真不来
   *  就回到旧断流行为,绝不无限续。filler 与新流互斥由 stopGapFiller 保证。 */
  private startGapFiller(): void {
    const player = this.player;
    if (!player || this.ap2Session !== null || this.opts.dry) return;
    if (!raopBridgeGapFillEnabled()) return;
    if (typeof (player as unknown as { fillGapSilence?: unknown }).fillGapSilence !== "function") return; // 测试桩/旧 player
    const token = ++this.gapFillerToken;
    const startedAt = Date.now();
    this.gapFillerPromise = player
      .fillGapSilence({
        shouldStop: () => token !== this.gapFillerToken || this.closed || this.pausedState,
        maxMs: 8000,
      })
      .then((n) => {
        if (n > 0) {
          log.info(`[airplay-bridge] ${JSON.stringify({ ev: "gap-fill", dev: this.deviceId, chunks: n, ms: Date.now() - startedAt })}`);
        }
        return n;
      })
      .catch(() => 0);
  }

  /** 停掉垫片续流并等它收尾(新流首包发出前必须完成,防 seq/时间线交错;
   *  filler 每 8ms 一拍,50ms 宽限足够干净退出)。 */
  private async stopGapFiller(): Promise<void> {
    this.gapFillerToken++;
    const p = this.gapFillerPromise;
    this.gapFillerPromise = null;
    if (!p) return;
    await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
  }

  /** 链路 stall(2s 无任何帧,含心跳):sendspin 子进程死亡/链路断。
   *  §5.2「sendspin 子进程崩溃 ⇒ airplay 侧无残留播放」:立刻停推流(不写静音),
   *  保留 listener 等重连;BridgeMember 重连成功会发 BOUNDARY{rehost} ⇒ 走 onBoundary 重锚。 */
  /** §4.4 接收侧积压超上限(发送侧仍在消费,**不再断连**)。
   *
   *  2026-11-03 改为「裁旧保新」:旧实现清空 inQueue/outBuf 后服务端还 destroy socket ⇒
   *  换代 rehost(240 实测 12:33:36 / 20:33:35:16s 积压 → 断链 → 新流重锚 → 再积压)。
   *  积压本质只是「生产者比发送侧快」,丢最旧的一段即可追上;保留当前内容与 outBuf,
   *  余下的时间线缺口由 aligner 的 skip 路径自然吸收(不物化静音)。
   */
  // [验收9/MA 对齐说明] sendspin_bridge.py:1511-1516 `_held_chunks`(45s/4000 双上限)
  // 防「锚点永不落定 ⇒ hold 无限涨」。本仓不叠同款层:onReceiveOverflow 以
  // BRIDGE_OVERFLOW_KEEP_MS=2s 裁旧保新,hold 上限恒 ≤2s,结构性排除该故障面;
  // 两层丢帧策略会打架(谁先丢/丢谁不一致)。验收9=断言 hold 不超 2s 口径。
  private onReceiveOverflow(ms: number): void {
    const keepBytes = Math.round((BRIDGE_OVERFLOW_KEEP_MS / 1000) * BRIDGE_PCM_BYTES_PER_SEC);
    let dropped = 0;
    while (this.inBytes > keepBytes && this.inQueue.length > 0) {
      const head = this.inQueue.shift()!;
      this.inBytes -= head.buf.length;
      dropped += head.buf.length;
    }
    log.warn(`[airplay-bridge] ${JSON.stringify({
      ev: "recv-overflow",
      dev: this.deviceId,
      gen: this.generation,
      backlogMs: Math.round(ms),
      droppedBytes: dropped,
      droppedMs: Math.round((dropped / BRIDGE_PCM_BYTES_PER_SEC) * 1000),
      keptMs: this.backlogMs(),
    })}`);
  }

  /** 断帧处理:分两级(2026-11-26,对齐 MA sendspin_bridge)。
   *
   *  非致命(默认 2s 无帧):**什么都不做** —— 不断流、不 flush、不清锚点。
   *  MA 的 `_on_audio_chunk` 是纯回调,上游暂时缺数据时设备继续播已缓冲内容
   *  (`MAX_DEVICE_BUFFER_SECONDS = 8.0`);它只有 CLI 进程真的退出才判
   *  `transport_lost`。此前这里一命中就 flush + 清锚点 ⇒ `pull()` 立即返回 null
   *  ⇒ producer 结束 ⇒ `scheduleRaopReconnect("stream ended")` ⇒ 整条 RAOP 会话
   *  重建,把上游几百毫秒抖动放大成 2~5s 真静音(每首歌一次)。
   *
   *  致命(默认 15s 无帧):泵进程真卡死 / 组已销毁,保持链路只会一直播静音
   *  ⇒ 走原来的断流路径,让新的泵实例重新锚定。
   *
   *  `commandedLeadUs` 打印出来是为了区分「上游没帧」与「锚点被推太远」:
   *  前者 lead 正常、后者 lead 异常放大(越界推流会让投递窗口一帧都没有)。 */
  private onLinkStall(ev: { fatal: boolean; silentMs: number }): void {
    if (this.closed || !this.aligner) return;
    if (!ev.fatal) {
      log.warn(
        `[airplay-bridge] link stall(等待,不断流): device=${this.deviceId}` +
          ` silentMs=${ev.silentMs} cmdLeadUs=${this.commandedLeadUs ?? "-"} gen=${this.generation}`,
      );
      return;
    }
    log.warn(
      `[airplay-bridge] link stall fatal: device=${this.deviceId} silentMs=${ev.silentMs}` +
        ` 判链路死亡,断流重连`,
    );
    this.streamAborted = true;
    this.player?.flush();
    this.aligner = null;
    this.anchors = null;
    this.anchorUs = null;
    this.commandedLeadUs = null;
    this.firstPacketLeadUs = null;
    this.firstFrameTsUs = null;
  }

  /** 组泵暂停/恢复(HEARTBEAT flags bit1,§5.4)。
   *  暂停:冻结推流(不写静音/不动 headTs/不计 latePackets),心跳维持不触发 stalled。
   *  恢复:≤45s 按「继续」(streamBridge 恢复后 sendAt pacing 自动 rebase,drift 由
   *  tsUs 重对齐);>45s 按「锚点不可达」重新锚定(丢弃更早内容)。 */
  private onBridgeHeartbeat(paused: boolean): void {
    if (this.closed || paused === this.pausedState) return;
    this.pausedState = paused;
    if (paused) {
      this.pausedAtUs = nowUs();
      log.info(`[airplay-bridge] ${JSON.stringify({ ev: "pause", dev: this.deviceId, gen: this.generation })}`);
      this.player?.pause();
      return;
    }
    const heldUs = this.pausedAtUs !== null ? Number(nowUs() - this.pausedAtUs) : 0;
    this.pausedAtUs = null;
    log.info(`[airplay-bridge] ${JSON.stringify({ ev: "resume", dev: this.deviceId, gen: this.generation, heldUs })}`);
    this.player?.resume();
    if (heldUs > BRIDGE_MAX_HELD_AUDIO_US) {
      // §5.4:暂停超 45s ⇒ 锚点不可达 —— 重锚到恢复时刻(新代次语义,旧内容丢弃)。
      log.warn(`[airplay-bridge] resume after ${Math.round(heldUs / 1000)}ms > 45s: re-anchor(锚点不可达,丢弃更早内容)`);
      this.streamAborted = true;
      this.player?.flush();
      this.aligner = null;
      this.anchors = null;
      this.anchorUs = null;
      this.commandedLeadUs = null;
      this.firstFrameTsUs = null;
    }
  }

  /** 锚点落定 + 进入四锚点驱动推流(dry / 未连接 / 未 connect / 已起流均不动作)。 */
  private async maybeBeginStream(): Promise<void> {
    if (this.opts.dry || this.closed || !this.connected || this.firstFrameTsUs === null) return;
    if (this.aligner !== null) return;
    // v4.9.7:RAOP 会话重建窗口内不起流 —— 否则会起在即将被回收的旧 player 上。
    // 复位后由下一帧 AUDIO 自然触发,最多推迟一个帧间隔。
    if (this.raopReconnectInFlight) return;
    // A:新流首包发出前必须收掉垫片续流(防两路同时 sendChunk 打乱 seq/时间线)。
    // 仅在 filler 真在跑时 await(否则保持本函数原有同步语义,测试桩不破)。
    if (this.gapFillerPromise !== null) await this.stopGapFiller();
    const player = this.player;
    const session = this.raopSession;
    // AP2 realtime 没有 RAOP 会话对象(player/raopSession 恒 null)⇒ 判空必须放行 AP2;
    // ap2 === null 时本式与原 `if (!player || !session) return;` 逐字节等价(RAOP 不变)。
    if (this.ap2Session === null && (!player || !session)) return;
    // [验收11/MA ClockReadiness.STALLED :903-911 姿态对齐] 设备时钟始终未就绪
    // (timing 心跳一次都没来)⇒ MA = warning "never answered the server's PTP
    // clock, so this stream will be silent until it does; anchoring anyway":
    // 仍然锚定 —— 停下会掐死音箱,stall 不足以证明该弃;且**每个锚定周期重臂**
    // 该报告(本仓落点在 maybeBeginStream,天然逐周期重臂,不会读到上轮旧状态)。
    // 本仓差异:MA 等 PTP 时钟,我们等 RAOP timing 心跳(player.timingCount);
    // 无阻断逻辑,报告即动作(锚定照常)。
    if (player !== null && (player as unknown as { timingCount?: number }).timingCount === 0) {
      log.warn(
        `[airplay-bridge] clock-stalled dev=${this.deviceId} gen=${this.generation} ` +
        `timingCount=0 ⇒ 设备时钟未就绪,anchoring anyway(MA STALLED 姿态);流将静音直到 timing 心跳到达`,
      );
    }
    const rate = this.outRate;
    // L = RECORD 协商的接收端缓冲深度(不得归零,§3.3);锚点公式与 SYNC 用同一值。
    const raopLatency = player ? Math.max(1, player.negotiatedLatencyFrames) : 1;
    // AP2 realtime:L 的等价物 = 我方在 SETUP 里声明的 latencyMin(接收端抖动缓冲深度)。
    // 两条出口各取自己的 L,但**共用同一个 planBridgeAnchor**(锚点只落一次)。
    const latencyFrames = this.ap2Session !== null ? this.ap2DeclaredLatencyFrames : raopLatency;
    // D7(2026-11-01):同组同 gen **共享锚点** —— 首个规划者发布,其余成员复用,
    // 保证各成员的「内容零点 = 对齐器 target 基准」与「送包节拍基准」逐 µs 同源。
    // 只在 forceNow(now 锚)且带 groupKey 时启用;AP2 出口不吃 now 锚(forceNow=false)。
    const useSharedAnchor =
      this.ap2Session === null && raopNowAnchorEnabled()
      && bridgeSyncGroupTimelineEnabled() && !!this.opts.groupKey && !!this.groupAnchors;
    const nowHostUs = nowUs();
    const floorLeadUs = BigInt(Math.round((latencyFrames / rate) * 1e6)) + BigInt(RAOP_SAFETY_MS * 1000);
    const sharedAnchor = useSharedAnchor
      ? this.groupAnchors!.peek(this.opts.groupKey!, this.generation, nowHostUs, floorLeadUs)
      : null;
    const sharedAnchorUs = sharedAnchor === null ? null : sharedAnchor.anchorUs;
    const sharedAnchorLeadUs = sharedAnchor === null ? 0n : sharedAnchor.leadUs;
    // [P0-B 2026-11-25] 保留队列(S2)与新锚点必须同源:锚点不得早于**保留队列尾**的
    // 内容时刻,否则旧曲尾被排进「未来」;也不得晚于新曲首帧 −200ms,否则新曲开头被
    // D5 裁头(真机 -1607ms/-1.02s/-1.73s 三次实证)。区间为空 ⇒ 宁可丢旧曲尾巴
    // (出清队列),绝不丢新曲开头。
    // MA 出处:sendspin_bridge.py:934-945 —— `anchor_ms = max(anchor_ms,
    // now_ms + stream.warm_lead_ms - min(0, adjust_ms) + AIRPLAY_SPLICE_LEAD_MARGIN_MS)`
    // 与 `max(anchor_ms, stream.flushed_head_unix_ms - adjust_ms + ...)` 的 max 链;
    // 差异:MA 用 flushed_head(已冲刷头),我们用保留队列尾(尚未投出的旧代帧尾),
    // 两者同为「新指令不得早于残留音频」的 splice 下界。
    // 只统计**旧代次**帧(非接续换代后 inQueue 里同时有旧尾与新曲帧,新曲帧不能抬 floor)。
    let keepQueueTailUs = 0n;
    for (const q of this.inQueue) {
      if (q.generation !== 0 && q.generation !== this.generation && q.tsUs > keepQueueTailUs) {
        keepQueueTailUs = q.tsUs;
      }
    }
    const plannedFirstFrame = this.firstFrameTsUs;
    if (plannedFirstFrame !== null && keepQueueTailUs > 0n && keepQueueTailUs > plannedFirstFrame - 200_000n) {
      log.info(`[airplay-bridge] ${JSON.stringify({
        ev: "anchor-clamp-conflict",
        dev: this.deviceId,
        gen: this.generation,
        keepQueueTailUs: Number(keepQueueTailUs),
        firstFrameTsUs: Number(plannedFirstFrame),
        gapUs: Number(plannedFirstFrame - keepQueueTailUs),
        action: "drop-keep-queue(宁丢旧尾不吞新头)",
      })}`);
      this.inQueue = [];
      this.inBytes = 0;
      this.outBuf = Buffer.alloc(0);
      keepQueueTailUs = 0n;
    }
    const plan = planBridgeAnchor({
      firstFrameTsUs: this.firstFrameTsUs,
      latencyFrames,
      rate,
      resampled: this.resampler !== null,
      nowUs: nowHostUs,
      anchorShiftUs: this.opts.anchorShiftUs ?? 0,
      forceNow: this.ap2Session === null && raopNowAnchorEnabled(),
      groupAnchorUs: sharedAnchorUs ?? undefined,
      coldPreheat: !this.anchoredOnce,
      // [P0-C 2026-11-25 splice 残留口径] 「设备残留音频」= RAOP 发送队列(inBytes)
      // + 已编码待发(outBuf)。旧口径只算 inBytes,漏掉 outBuf ⇒ 指令落点可能仍落在
      // 设备还没排完的音频之前 ⇒ splice 被忽略(240 iEAST 14:45:33 实证链)。
      // MA 同口径:sendspin_bridge 的 flushed_head/.audio_pending_ms。
      queuedUs: BigInt(Math.round(((this.inBytes + this.outBuf.length) / BRIDGE_PCM_BYTES_PER_SEC) * 1e6)),
      keepQueueTailUs: keepQueueTailUs > 0n ? keepQueueTailUs : undefined,
    });
    // [P0-C 诊断] splice 下限是否生效、生效多少,一眼可查:residualUsMs = 设备残留,
    // MA 出处:sendspin_bridge.py:958-963 —— 锚点下发时若残留 pending 音频,warning
    // "its content will play that late"(报告不吞掉);我们把同一事实折成可 grep 字段。
    // spliceFloorMs = residual+margin,finalLeadMs = 实际 lead。若 finalLeadMs 明显小于
    // spliceFloorMs,说明 lead 被 ceiling(首帧−200ms)压回 —— 那就是「宁吞新头」的取舍点。
    {
      const residualUs = BigInt(Math.round(((this.inBytes + this.outBuf.length) / BRIDGE_PCM_BYTES_PER_SEC) * 1e6));
      const spliceFloorMs = Math.round(Number(residualUs + BigInt(BRIDGE_SPLICE_LEAD_MARGIN_US)) / 1000);
      log.info(`[airplay-bridge] ${JSON.stringify({
        ev: "anchor-splice",
        dev: this.deviceId,
        gen: this.generation,
        residualUsMs: Math.round(Number(residualUs) / 1000),
        spliceFloorMs,
        // [N-D 修 2026-11-25 第一轮复采] commandedLeadUs 是 µs,字段名是 Ms ⇒ 必须换算,
        // 否则显示 3800ms/2500ms 实为 3.8s/2.5s 的 µs 值,误导排障。
        finalLeadMs: Math.round(Number(plan.commandedLeadUs) / 1000),
        shared: sharedAnchorUs !== null,
      })}`);
    }
    // [P0-B 诊断] 三个时基一眼可比:泵新时间线基(pumpBase = 新曲首帧 ts)、保留队列尾、
    // 最终落锚。锚点被夹紧(= minSafe/keepQueueTail 上抬 或 首帧-200ms 下压)时,
    // anchorMinusTailUs / firstMinusAnchorUs 的符号就是裁头方向的直接证据。
    log.info(`[airplay-bridge] ${JSON.stringify({
      ev: "anchor-clamp",
      dev: this.deviceId,
      gen: this.generation,
      pumpBaseUs: plannedFirstFrame === null ? null : Number(plannedFirstFrame),
      keepQueueTailUs: Number(keepQueueTailUs),
      bridgeAnchorUs: Number(plan.anchorUs),
      anchorMinusTailUs: Number(plan.anchorUs - keepQueueTailUs),
      firstMinusAnchorUs: plannedFirstFrame === null ? null : Number(plannedFirstFrame - plan.anchorUs),
      commandedLeadUs: Number(plan.commandedLeadUs),
      reAnchored: plan.reAnchored,
      shared: sharedAnchorUs !== null,
    })}`);
    this.anchoredOnce = true; // 后续 reseed/切歌按 warm 档，避免换歌多等 2 秒
    if (useSharedAnchor) {
      if (sharedAnchorUs !== null) {
        log.info(`[airplay-bridge] group-anchor reuse: device=${this.deviceId} gen=${this.generation} anchorUs=${sharedAnchorUs}(leadUs=${sharedAnchorUs - nowHostUs})`);
        if (plan.anchorUs > sharedAnchorUs) {
          // [验收6/MA A] 组锚早于本设备自身下限(splice/minSafe)⇒ 已在 planBridgeAnchor
          // 内抬到下限;此差值 = 该设备比组基准多出的残留。MA 出处:sendspin_bridge.py
          // :934-945 —— 命令时刻必须落在残留音频之后,设备的 sync_adjust 不进组时间线。
          log.info(`[airplay-bridge] ${JSON.stringify({
            ev: "group-anchor-floormiss",
            dev: this.deviceId,
            gen: this.generation,
            sharedAnchorUs: Number(sharedAnchorUs),
            finalAnchorUs: Number(plan.anchorUs),
            raisedUs: Number(plan.anchorUs - sharedAnchorUs),
            sharedLeadUs: Number(sharedAnchorLeadUs),
          })}`);
        }
      } else {
        // [验收6/MA A] 发布时同时登记**组级 lead**,后到成员以它为同源参考。
        this.groupAnchors!.publish(this.opts.groupKey!, this.generation, plan.anchorUs, plan.commandedLeadUs);
        log.info(`[airplay-bridge] group-anchor publish: device=${this.deviceId} gen=${this.generation} anchorUs=${plan.anchorUs}(leadUs=${plan.commandedLeadUs})`);
      }
    }
    if (plan.reAnchored) {
      log.warn(`[airplay-bridge] anchor unreachable: device=${this.deviceId} commanded=${this.firstFrameTsUs} now=${nowUs()} → re-anchor ${plan.anchorUs}(丢弃更早内容)`);
    }
    this.anchorUs = plan.anchorUs;
    this.commandedLeadUs = plan.commandedLeadUs;
    this.actualSendAtUs = null; // 新锚点 ⇒ 首包测量重置
    // [S8 复核②]首包预期提前量(L_eff):AP2 = 声明 latencyFrames→µs;
    // RAOP forceNow = 0(首包即发);RAOP 非 forceNow = L + SAFETY(节拍公式 A−i·帧−L−SAFETY)。
    this.firstPacketLeadUs = this.ap2Session !== null
      ? Math.round((latencyFrames / rate) * 1e6)
      : (plan.forceNow ? 0 : Math.round((latencyFrames / rate) * 1e6) + RAOP_SAFETY_MS * 1000);
    this.anchors = plan.anchors;
    // E3:锚点落定时刻的 chunksOut 快照 —— tick deltaUs 用本次 plan 起的增量,
    // 修 warm-reuse 会话跨 gen 累积导致的恒偏谬值(240 实证 35.68s)。
    this.chunksOutAtPlan = this.stats.chunksOut;
    if (plan.forceNow) {
      log.warn(`[airplay-bridge] forceNow anchor (MF_BRIDGE_RAOP_NOW_ANCHOR): device=${this.deviceId} anchorUs=now+${Number(raopNowAnchorOffsetUs())}µs 首包即发(E2/exp2,组 lead 内容按偏移提前播)`);
    }
    // D4(2026-11-01):对齐零点 = 组时间线锚点(plan.anchorUs),**不再**取本会话首帧 ——
    // 桥重建/迟到加入/bulk 回填时首帧可能是旧内容,零点随之后移 ⇒ 该设备从旧进度起播、
    // 内容整体错位(用户可见「进度不一样」),且错位只能靠对齐器 drop 追平 ⇒ outBuf 被
    // 裁空后 pullChunk 补静音 = 丢音变静音(240 实测 droppedFrames 7.5~12s)。
    // 旧模式保留首帧零点(forceNow 的注释:否则泵 lead 段 target−pos > 2s 走 skip)。
    this.aligner = new BridgeTimelineAligner(
      bridgeSyncGroupTimelineEnabled()
        ? plan.anchorUs
        : plan.forceNow && this.firstFrameTsUs !== null
          ? this.firstFrameTsUs
          : plan.anchorUs,
      rate,
      undefined,
      // D8(2026-11-01):组同步模式把补静音上限从 2s 抬到 10s —— **冷启/迟到加入这类正常
      // 4~6s 缺口不再走本地跳段**,而是如实补静音(可听时间 = 内容 ts,与跳段等价,但不动
      // RTP 内容轴:不调用 bridgeSkipFrames ⇒ 没有 startTs 位移可被暖复用/换歌带过去)。
      // 超过 10s 的极端断料仍保留跳段(内存兜底,1 帧 4B ⇒ 10s ≈ 1.76MB)。
      bridgeSyncGroupTimelineEnabled() ? rate * 10 : undefined,
    );
    this.streamAborted = false;
    this.lastFrontierUs = 0n;
    this.streamStartedAtMs = Date.now();
    this.emitAnchorReport(plan, latencyFrames);
    // AP2 ⇒ runAp2Output(节拍 = A + i·spf/rate − L_eff,不加 RAOP_SAFETY_MS);
    // 否则落到下面的 RAOP streamBridge(语句一行不动)。
    if (this.ap2Session !== null) {
      this.streamPromise = this.runAp2Output(plan);
      this.startStatsTick();
      return;
    }
    // 类型收窄(不可达:上面已判空且 ap2 分支已 return)—— 只为让下面这条 RAOP 语句
    // 保持**逐字节原样**(不带 `!`/强转)。
    if (!player || !session) return;
    // D6/P1:手动 next/prev 的一次性 ts 回拨需求(在 onBoundary 里登记)。
    // 只有 RaopPlayer 知道 lastSentTs,所以回拨在 streamBridge 内落地;
    // 过期(>10s)视为无效 —— 绝不把旧需求套到晚得多的新流上。
    const rewindFrames =
      this.pendingRewindFrames > 0 && Date.now() - this.pendingRewindAt <= BRIDGE_MANUAL_REWIND_TTL_MS
        ? this.pendingRewindFrames
        : 0;
    this.pendingRewindFrames = 0;
    // (2026-11-19 立项) 旧流的退出**只**由 raop.waitUntilUs 的中止判据负责，此处保持
    // 同步覆盖语义不变：resetTimeline 已置 `streamAborted` 并 `flush()`（streaming
    // 同步 false），旧循环最迟一个 10ms 轮询就回主条件退出。
    // ⚠️ 不要在这里 await 旧 streamPromise —— 它整首歌期间都不 resolve，await 等于
    // 每次换歌硬等超时；也不要引入任何 await，会让起播路径失去同步语义
    // （bridgePhase5.qa2 的同步驱动断言会直接红）。
    this.streamPromise = player
      .streamBridge(() => this.pullChunk(), session, {
        baseTs: plan.anchors.baseTs,
        startTs: plan.anchors.startTs,
        headTs: plan.anchors.headTs,
        startNtp: plan.anchors.startNtp,
        anchorUsShifted: plan.anchors.anchorUsShifted,
        anchorUs: plan.anchorUs,
        // 送包节拍基准(**不含成员补偿**):同内容在各成员的同刻送包时刻一致
        beatAnchorUs: plan.beatAnchorUs,
        latencyFrames,
        rate,
        // D6/P1:自动换歌(以及任何 track 换代)= 0 FLUSH、0 RECORD,同一会话内容替换。
        // 用户操作(seek / 泵移交 rehost)= FLUSH-only;MA 实测新流 ts 相对上一包回拨
        // 1.588–1.695s(p50 1.662),因此允许时间轴后退(track 仍保留前跳保护)。
        allowTsRewind: this.lastBoundaryReason === "seek" || this.lastBoundaryReason === "rehost",
        // 手动 next/prev:显式回拨(基准 = 上一包 ts),与 allowTsRewind 互斥使用。
        ...(rewindFrames > 0 ? { rewindFrames } : {}),
      })
      .then((endedBy) => {
        // v4.9.7:只有 `send`(sendChunk 返 false,设备侧真断开)才重连。
        // `producer` = pullChunk 的 closed/streamAborted 分支 ⇒ **曲目播完**或上层主动
        // 停流,交给 onBoundary 换代处置。历史缺陷:此处不区分原因,导致每首歌播完都
        // 触发一次 reconnectRaop,而它在 await connect() 后 forceClose 掉刚起的新流 ⇒
        // 6 轮 / 36s 无声死循环(240 实证 05:33:00)。destroy/stopped 同样不重连。
        if (endedBy !== "send") return;
        if (!this.closed && this.connected && !this.streamAborted) this.scheduleRaopReconnect("stream ended");
      })
      .catch((e) => {
        log.warn(`bridge raop stream ended: device=${this.deviceId} err=${(e as Error)?.message || e}`);
        if (!this.closed && this.connected && !this.streamAborted) this.scheduleRaopReconnect("stream error");
      });
    this.startStatsTick();
  }

  // -------------------------------------------------------------------------
  // AP2 realtime 出口(T03):纯数据面,不做任何选歌/预取
  // -------------------------------------------------------------------------

  /** AP2 出声循环:拉块(`pullOutChunk`,与 RAOP 同一生产管线)→ 按 sendAt 发送。
   *
   *  硬约束:
   *   - 节拍只用 `plan.playAnchorUs`(唯一那次 planBridgeAnchor 的产物),**绝不另起时间线**;
   *   - `RAOP_SAFETY_MS` 不进 sendAt(见 rates.ts 注释:否则 AP2 恒早 50ms);
   *   - 暂停期不拉块、不发送、不写静音(与 RAOP pause 同语义);
   *   - `streamAborted` / `closed` / 链路断 ⇒ 循环立刻退出,不留悬挂定时器;
   *   - 链路断 ⇒ 记 `ap2LinkLoss` 并由主进程看门狗摘桥 + 本流回落 solo cast
   *     (**绝不在会话内切协议** —— 那等于中途换锚点)。 */
  private async runAp2Output(plan: BridgeAnchorPlan): Promise<void> {
    const session = this.ap2Session;
    if (!session) return;
    const rate = this.outRate;
    const result = await runAp2OutputLoop({
      // 中止后立即返回 null(不等 waitDataMs),让循环在下一个块边界就退出。
      pull: () => (this.closed || this.streamAborted ? Promise.resolve(null) : this.pullOutChunk()),
      send: (pcm) => this.ap2Send(pcm),
      // [S8 校准闭环]首块实际发出墙钟 → 会话字段(随 bridgeStats 上报主进程)
      onFirstSend: (wallUs) => { this.actualSendAtUs = wallUs; },
      nowUs: () => nowUs(),
      sleepUs: (us) => this.ap2SleepUs(us),
      shouldStop: () => this.closed || this.streamAborted || this.ap2LinkLoss !== null,
      isPaused: () => this.pausedState,
      // AP2 无 RTP 映射 ⇒ 节拍即出声时刻:用出声锚点(含成员补偿;旧模式与
      // plan.anchorUs 逐字节相同 —— 那时补偿就在 anchorUs 里)。
      anchorUs: plan.playAnchorUs,
      rate,
      spf: CHUNK_LEN,
      lEffFrames: AP2_EFFECTIVE_LATENCY_FRAMES,
      onLateSkip: (total, lagUs) => {
        this.ap2LateSkips = total;
        log.warn(`[airplay-bridge] ${JSON.stringify({
          ev: "ap2-late-skip", dev: this.deviceId, gen: this.generation,
          total, lagUs, rate,
        })}`);
      },
      onRebase: (lagUs) => {
        log.info(`[airplay-bridge] ${JSON.stringify({
          ev: "ap2-pacing-rebase", dev: this.deviceId, gen: this.generation, lagUs,
        })}`);
      },
      onSendError: (consecutive, total) => {
        log.warn(`[airplay-bridge] ${JSON.stringify({
          ev: "ap2-send-error", dev: this.deviceId, gen: this.generation,
          consecutive, total, limit: AP2_SEND_ERROR_LIMIT,
        })}`);
      },
    });
    // 链路断:记原因(诊断快照 degraded=true),主进程看门狗据此摘桥。
    if (result.stopReason === "link-loss") {
      this.ap2LinkLoss = session.stats?.linkLoss ?? "send-error";
      log.warn(`[airplay-bridge] ${JSON.stringify({
        ev: "ap2-degraded", dev: this.deviceId, gen: this.generation,
        reason: this.ap2LinkLoss, chunks: result.chunks, lateSkipped: result.lateSkipped,
        sent: session.stats?.sent ?? 0, errors: session.stats?.errors ?? 0,
      })}`);
      this.streamAborted = true;
    }
    log.info(`[airplay-bridge] ap2 stream done: device=${this.deviceId} chunks=${result.chunks} `
      + `lateSkipped=${result.lateSkipped} stop=${result.stopReason}`);
    // 会话侧资源回收(幂等;TEARDOWN best-effort)。不在此处改协议/重建会话。
    try { await session.close(); } catch { /* 清理失败不掩盖中止原因 */ }
  }

  /** AP2 单块发送(错误只计数,不打断节拍;收敛判定在循环里统一做)。 */
  private ap2Send(pcm: Buffer): { sent: number; errors: number; state: string } {
    const session = this.ap2Session;
    if (!session) return { sent: 0, errors: 0, state: "closed" };
    try {
      const sent = session.pump(pcm);
      return { sent, errors: session.stats?.errors ?? 0, state: session.currentState ?? "open" };
    } catch (e: any) {
      // pump 抛错 = 会话状态机已非法(非 open)/出口不可用:交给循环按 link-loss 收敛。
      log.warn(`[airplay-bridge] ap2 pump failed: device=${this.deviceId} err=${e?.message || e}`);
      return { sent: 0, errors: (session.stats?.errors ?? 0) + 1, state: "error" };
    }
  }

  /** AP2 可中止等待(µs):按 AP2_WAIT_SLICE_MS 切片轮询中止标志 ——
   *  每个定时器都短且必然 resolve(不留悬挂句柄),中止最迟一个切片即返回。 */
  private async ap2SleepUs(us: number): Promise<void> {
    const until = nowUs() + BigInt(Math.max(0, Math.round(us)));
    while (!this.closed && !this.streamAborted && this.ap2LinkLoss === null && nowUs() < until) {
      const remainMs = Number(until - nowUs()) / 1000;
      const slice = Math.min(AP2_WAIT_SLICE_MS, Math.max(1, Math.ceil(remainMs)));
      await new Promise((r) => setTimeout(r, slice));
    }
  }

  /** RAOP 会话级重连(§5.2「桥设备重连必须重建 RAOP 会话」):5s/30s ±20% 退避。
   *  重连成功后重新 RECORD(新 baseTs/startNtp)并对齐器复位 —— 下一帧 AUDIO 用
   *  新会话重新锚定(新 scheduledAnchorUs)。仅推流异常断开时触发(boundary/stall
   *  不触发:那些场景会话仍健康)。 */
  /** [验收10/MA :1481-1490] 上一次传输**恢复成功**的时刻(ms;0 = 从未恢复过)。
   *  消费点 = transportGiveUp 的 30s 守卫:恢复后 30s 内再死 ⇒ 放弃(防 churn,
   *  MA "died again within 30s of the previous recovery, giving up")。
   *  写入点 = reconnectRaop 成功路径(看门狗与 send-error 两条路都汇于此)。 */
  private lastRecoveryAtMs = 0;
  /** [验收10/MA :1196-1219] rejoin 尝试用尽 ⇒ 保持移出(不再调度/执行重连)。
   *  复位 = 新 BridgeSession(syncGroupBridges 重建句柄);显式重试走编排侧重建。 */
  private transportGivenUp = false;
  /** [验收10] 守卫/上限统一闸(§见 rates.ts BRIDGE_REJOIN_ATTEMPT_MAX 注释)。
   *  @returns true = 已放弃,调用方不得再调度/执行重连。 */
  private transportGiveUp(reason: string): boolean {
    if (this.transportGivenUp) return true;
    const withinGuard = this.lastRecoveryAtMs > 0
      && Date.now() - this.lastRecoveryAtMs < BRIDGE_TRANSPORT_RECOVERY_GUARD_MS;
    const exhausted = this.raopReconnectAttempt >= BRIDGE_REJOIN_ATTEMPT_MAX;
    if (!withinGuard && !exhausted) return false;
    this.transportGivenUp = true;
    log.error(
      `[airplay-bridge] raop transport give-up: device=${this.deviceId} ` +
      (exhausted
        ? `rejoin attempts exhausted(${BRIDGE_REJOIN_ATTEMPT_MAX}, MA (5,30))`
        : `died again within ${BRIDGE_TRANSPORT_RECOVERY_GUARD_MS / 1000}s of previous recovery`) +
      ` ⇒ 保持移出,等编排侧对账/用户显式重试 reason=${reason}`,
    );
    return true;
  }
  private scheduleRaopReconnect(reason: string): void {
    if (this.closed || this.raopReconnectTimer) return;
    // [验收10] 守卫窗内再死 / 尝试用尽 ⇒ 放弃,不再排程(MA :1481-1490/:1196-1219)。
    if (this.transportGiveUp(reason)) return;
    this.raopReconnectAttempt++;
    const delay = computeBridgeBackoffMs(this.raopReconnectAttempt, Math.random());
    log.warn(`[airplay-bridge] raop reconnect in ${delay}ms (attempt ${this.raopReconnectAttempt}, ${reason}) device=${this.deviceId}`);
    this.raopReconnectTimer = setTimeout(() => {
      this.raopReconnectTimer = null;
      void this.reconnectRaop();
    }, delay);
    this.raopReconnectTimer.unref?.();
  }

  private async reconnectRaop(): Promise<void> {
    if (this.closed || !this.connected) return;
    // v4.9.7 互斥门:connect() 的 await 窗口内绝不允许 maybeBeginStream 在 oldPlayer
    // 上起流 —— 否则 connect 完成后 oldPlayer.forceClose() 会把刚起 0.3~0.6s 的新流
    // 当场掐死(240 实证 05:33:00.388 anchor → .705 reconnected → .708
    // sendChunk false destroying=true),进而 .then() 再判「非正常结束」继续调度重连,
    // 形成 36s 无声死循环。重入也一并挡掉。
    if (this.raopReconnectInFlight) return;
    // [验收10] 看门狗(arbitrateLiveness)直调路径同样受守卫/上限闸 —— 30s 恢复窗内
    // 再死或尝试用尽 ⇒ 放弃(F6b 场景的判定点)。已放弃时不再执行,现场保留供排查。
    if (this.transportGivenUp) return;
    this.raopReconnectInFlight = true;
    try {
      // 标记 degraded:推流停,对齐器复位,等新会话 + 新帧重锚(重连窗口内旧队列清空)。
      this.streamAborted = true;
      this.aligner = null;
      this.anchors = null;
      this.anchorUs = null;
      this.commandedLeadUs = null;
      this.firstFrameTsUs = null;
      this.inQueue = [];
      this.inBytes = 0;
      this.outBuf = Buffer.alloc(0);
      const oldPlayer = this.player;
      // v4.10.0 根因修复:先对设备**显式 TEARDOWN 旧会话**,再 ANNOUNCE 新会话。
      // 只 forceClose 会把 MUZO 的接收端留在旧会话上 —— 新 RECORD 虽然 RTSP 200,
      // 但设备既不收包也不发 timing、不出声(2026-10-29 12:12 实证:重启后 10 分钟
      // 3 条流全推完,设备心跳 0 次,只有组级 stop(TEARDOWN)才能救活)。
      if (oldPlayer) {
        try {
          await oldPlayer.stop();
        } catch {
          try { oldPlayer.forceClose(); } catch { /* ignore */ }
        }
        if (this.player === oldPlayer) this.player = null;
      }
      const player = new RaopPlayer({
        host: this.opts.host ?? "",
        port: this.opts.port ?? 5000,
        pk: this.opts.pk,
        et: this.opts.et,
        deviceId: this.opts.deviceId,
      });
      try {
        const session = await player.connect();
        this.raopSession = session;
        this.player = player;
        // 新 player 的 timingCount 从 0 起算,快照同步归零才能正确判"这一次救回来没有"。
        this.timingCountAtFire = 0;
        this.raopReconnectAttempt = 0;
        log.info(`[airplay-bridge] raop reconnected: device=${this.deviceId}(新 RECORD,等待新代次首帧重锚)`);
        // [验收10] 恢复成功 = 30s 守卫窗起点(看门狗与 send-error 两路都汇于此,
        // 故只需这一处写入)。MA :1481-1490 的 recovery 语义。
        this.lastRecoveryAtMs = Date.now();
        pushInitialVolume(player, this.deviceId, this.opts.initialVolume, this.opts.sameHostDlnaPeer, {
          volume: this.opts.deviceVolume,
          muted: this.opts.deviceMuted,
        });
        if (raopBridgeConnectPrimeEnabled()) {
          try { player.primeSilence(RAOP_CONNECT_PRIME_CHUNKS, session); } catch (e: any) { log.error(`prime silence failed(reconnect): ${e?.message || e}`); }
        }
        // v4.9.7 守卫:只有当前实例确实是这次新建的那个,才回收旧实例 ——
        // 期间若已被别的路径替换,forceClose 会误杀正在推流的会话。
        try { if (this.player === player) oldPlayer?.forceClose(); } catch { /* ignore */ }
      } catch (e) {
        try { player.forceClose(); } catch { /* ignore */ }
        log.warn(`[airplay-bridge] raop reconnect failed: device=${this.deviceId} err=${(e as Error)?.message || e}`);
        this.scheduleRaopReconnect("reconnect failed");
      }
    } finally {
      this.raopReconnectInFlight = false;
      // ★ v4.10.1 根因修复:互斥门复位后**必须补一次起流判定**。
      //   connect() 的 await 窗口(~0.5s)内到达的 AUDIO 帧会把 firstFrameTsUs 设好、
      //   并在 maybeBeginStream 里因 raopReconnectInFlight=true 早退;而 ingestAudio
      //   只在 firstFrameTsUs 从 null→非null 的那一帧才触发起流 ⇒ 从此**没人再触发**。
      //   后果(240 实证 2026-10-30 04:21:37–04:21:44):新会话永不进 live(aligner 恒
      //   null)即**没有消费者**,接收侧积压按实时速率涨到 8s → §4.4 overflow 断连 →
      //   发送侧再等 ~6s rehost。看门狗本来只手握 0.5s,却被这一条拉成两次断音 ~14s。
      //   maybeBeginStream 幂等(aligner!==null 即 return),补调无副作用。
      void this.maybeBeginStream();
    }
  }

  /** §3.5 无 ack 诚实语义:只上报 scheduled anchor,绝不假装收到设备播放确认。 */
  private emitAnchorReport(plan: BridgeAnchorPlan, latencyFrames: number): void {
    log.info(`[airplay-bridge] ${JSON.stringify({
      ev: "anchor",
      dev: this.deviceId,
      gen: this.generation,
      scheduledAnchorUs: Number(plan.anchorUs),
      shiftedAnchorUs: Number(plan.anchors.anchorUsShifted),
      commandedLeadUs: Number(plan.commandedLeadUs),
      latePackets: 0,
      mapping: "local-rtp-ntp",
      latencyFrames,
      baseTs: plan.anchors.baseTs >>> 0,
      rate: this.outRate,
      resampled: this.resampler !== null,
      reAnchored: plan.reAnchored,
      forceNow: plan.forceNow,
    })}`);
  }

  private startStatsTick(): void {
    const interval = this.opts.statsIntervalMs ?? 2000;
    if (interval <= 0 || this.statsTimer) return;
    this.statsTimer = setInterval(() => this.emitStatsTick(), interval);
    this.statsTimer.unref?.();
  }

  /** P1(2026-11-03)看门狗仲裁:静默只能"开始怀疑",不能直接判死。
   *
   *  判据 `quiet > threshold` 只说明设备没发 NTP 请求。MUZO 的健康节律本身就含
   *  16~17s 空档(240 实测 671 个间隔里 593 个=3s,空档 16.14~17.57s),而 MA/libraop
   *  全程没有这条判据(只有 RTSP/控制面报错才重连)⇒ 同一台设备在 MA 下不卡。
   *
   *  仲裁 = 一次**只读** OPTIONS(绝不复用会盲发 TEARDOWN 的 raopTeardownProbe):
   *  有状态码应答 ⇒ 会话活着,**短期**内不 TEARDOWN;连续 2 次 TCP/RTSP 无响应才走原重连。
   *  但"活着"≠"在消费":静默 ≥ max(2×阈值, 60s)时即使 OPTIONS 应答也强制重建(P1.1)。
   *  为什么要 2 次:单次可能是瞬断,而误判代价 = 整条桥队列(实测 6.28~7.60s 静音)。
   */
  private async arbitrateLiveness(quietMs: number, thresholdMs: number): Promise<void> {
    if (this.closed || this.livenessReconnectInFlight || this.livenessProbeInFlight) return;
    if (this.raopReconnectTimer !== null) return;
    const now = Date.now();
    const minGap = this.livenessProbeFailures > 0 ? LIVENESS_PROBE_RETRY_MS : LIVENESS_PROBE_INTERVAL_MS;
    if (now - this.livenessProbeAtMs < minGap) return;
    this.livenessProbeAtMs = now;
    this.livenessProbeInFlight = true;
    let verdict: { reachable: boolean; status: number | null; detail: string };
    try {
      verdict = await raopOptionsProbe(this.opts.host ?? "", this.opts.port ?? 5000, LIVENESS_PROBE_TIMEOUT_MS);
    } catch (e) {
      verdict = { reachable: false, status: null, detail: `probe threw: ${(e as Error)?.message || e}` };
    } finally {
      this.livenessProbeInFlight = false;
    }
    // 探测在飞的 3s 里状态可能已变(重连已排上/已暂停/已关闭)⇒ 以最新状态为准,不重复动手
    if (this.closed || this.livenessReconnectInFlight || this.raopReconnectTimer !== null) return;
    if (!this.connected || this.player === null || this.aligner === null || this.pausedState) return;
    if (optionsProbeSaysAlive(verdict)) {
      this.livenessProbeFailures = 0;
      // P1.1(2026-11-03):OPTIONS 应答只证明**控制面**活着,不能证明设备在消费。
      // 240 实证:HiVi 停发 timing 心跳后 OPTIONS 一直 200 ⇒ 旧仲裁把会话永久钉死。
      // 硬上限:静默 ≥ max(2×阈值, 60s) ⇒ 判「活着但不消费」僵尸,强制重建会话。
      const zombieLimitMs = Math.max(thresholdMs * 2, LIVENESS_ZOMBIE_MIN_MS);
      if (quietMs < zombieLimitMs) {
        if (this.livenessProbeOkGen !== String(this.generation)) {
          this.livenessProbeOkGen = String(this.generation);
          log.info(`[airplay-bridge] liveness watchdog 仲裁: device=${this.deviceId} gen=${this.generation} timing 心跳静默 ${(quietMs / 1000).toFixed(1)}s(≥ ${(thresholdMs / 1000).toFixed(0)}s),但 RTSP OPTIONS 应答 ${verdict.status} ⇒ 会话健康,不 TEARDOWN`);
        }
        return;
      }
      log.warn(`[airplay-bridge] liveness watchdog 僵尸判定: device=${this.deviceId} gen=${this.generation} timing 静默 ${(quietMs / 1000).toFixed(1)}s ≥ ${(zombieLimitMs / 1000).toFixed(0)}s(OPTIONS ${verdict.status} 仍应答)⇒ 活着但不消费,强制重建会话`);
    } else {
      this.livenessProbeFailures += 1;
      log.warn(`[airplay-bridge] liveness watchdog 仲裁失败: device=${this.deviceId} gen=${this.generation} 静默 ${(quietMs / 1000).toFixed(1)}s,RTSP OPTIONS ${verdict.detail}(连续 ${this.livenessProbeFailures} 次不可达)`);
      if (this.livenessProbeFailures < 2) return;
      this.livenessProbeFailures = 0;
    }
    // 判「上一次重连到底救没救回来」= **同一个 player** 的 timingCount 有没有涨过。
    // ⚠️ 绝不能用 lastTimingAt 比较:它是字段初值=构造时刻,新 player 恰在 fire 之后
    // 构造 ⇒ 条件恒真 ⇒ failedRun 永远归零 ⇒ 30min 止损变成死代码(复核 C-1)。
    const heartbeatSinceLastFire = this.player !== null && this.player.timingCount > this.timingCountAtFire;
    if (this.player !== null) this.timingCountAtFire = this.player.timingCount;
    const fired = noteLivenessFire(this.deviceId, Date.now(), heartbeatSinceLastFire);
    if (fired.disabled) {
      log.warn(`[airplay-bridge] liveness watchdog 熔断: device=${this.deviceId} 连续 3 次重连都没换回心跳 ⇒ 停用 30min(判据或设备侧已不可救,止损避免连环重连)`);
      return;
    }
    this.livenessReconnectInFlight = true;
    log.warn(`[airplay-bridge] liveness watchdog: device=${this.deviceId} gen=${this.generation} timing 心跳已停 ${(quietMs / 1000).toFixed(1)}s ≥ ${(thresholdMs / 1000).toFixed(0)}s 且 RTSP 探测连续 2 次不可达 ⇒ 判会话已死,先 TEARDOWN 旧会话再完整重握手(10min 内第 ${fired.firesInWindow} 次,连续未救回 ${fired.failedRun} 次)`);
    void this.reconnectRaop()
      .catch(() => { /* 重连失败已由 scheduleRaopReconnect 接管退避 */ })
      .finally(() => {
        this.livenessReconnectInFlight = false;
        // ★ v4.10.1 复核 C-2:重连完成必须同时重置 **quiet 基线**。
        //   新 player 在 `connect()` **之前**构造,而 connect 预算是 12s
        //  (raop.ts AIRPLAY_CONNECT_BUDGET_MS)⇒ 一次慢重连做完时 lastTimingAt 已经
        //   "12s 旧",短阈值下再过一个 2s tick 就会立刻二次判定 ⇒ TEARDOWN 刚建好的会话。
        //   这里只给"宽限窗",不代表设备活过来 —— 活体判据看 timingCount。
        if (this.player) {
          this.player.lastDeviceSignalAt = Date.now();
          this.player.lastTimingAt = Date.now();
        }
      });
  }

  /** §10.5 stats tick:每设备一行 JSON(ev:"tick"),clock 恒 local-rtp-ntp(同源 host 单调钟)。 */
  private emitStatsTick(): void {
    if (this.closed) return;
    // C-3(复核):熔断状态是模块级、跨 session 永生 —— 只要设备**真的**在发心跳就必须解除,
    // 否则一次"30min 止损"会跨越用户手动重播/换会话残留,让设备长时间不被看护。
    // 注意:解除门槛是"最近 5s 内真收到心跳",不是"重连过",所以救不回来的连续失败
    // (全程无心跳)仍然照常累计 failedRun → 3 次止损那级依然可达。
    if (this.player !== null && Date.now() - this.player.lastTimingAt < 5000) {
      resetLivenessBreaker(this.deviceId);
    }
    // B(会话活性看门狗,2026-10-29,v4.10.0 判据换 timing 心跳):心跳停摆超阈值
    // ⇒ 会话未被设备接管 / 接收端僵死(数据面再健康也救不回,实证只有 TEARDOWN +
    // 完整重握手能唤醒)⇒ 自动重连。
    const livenessThresholdMs = raopBridgeLivenessMs();
    const livenessQuietMs = this.player !== null ? Date.now() - this.player.lastTimingAt : 0;
    const livenessBreaker = livenessBreakerState(this.deviceId);
    // 无心跳设备**不能永久豁免**(P1.2,2026-11-03 MUZO 无声):livenessWatchdogShouldFire
    // 要求 hasTimingHeartbeat,而「本会话一次 timing 都没收到」正是设备接收端没切到
    // 本会话的指纹(RECORD/OPTIONS 照样 200、RTP 照样 122 包/秒)。旧实现整段跳过并打
    // 「判据不适用」⇒ 设备永久静音、无任何自愈。这里独立补一条零心跳重建:
    // 起流 ≥45s 仍 0 次 timing ⇒ TEARDOWN + 完整重握手;走同一熔断记账(连续 3 次
    // 救不回 ⇒ 停 30min,说明设备侧已不可救,需人工断电)。
    const livenessHasHeartbeat = this.player !== null && this.player.timingCount > 0;
    const streamAgeMs = this.streamStartedAtMs > 0 ? Date.now() - this.streamStartedAtMs : 0;
    if (
      !livenessHasHeartbeat &&
      this.ap2Session === null &&
      this.connected &&
      this.player !== null &&
      this.aligner !== null &&
      !this.pausedState &&
      !this.raopReconnectInFlight &&
      this.raopReconnectTimer === null &&
      streamAgeMs >= NEVER_TIMING_REBUILD_MS &&
      Date.now() >= livenessBreaker.cooldownUntil
    ) {
      const fired = noteLivenessFire(this.deviceId, Date.now(), false);
      if (fired.disabled) {
        if (this.livenessNoTimingLoggedGen !== String(this.generation)) {
          this.livenessNoTimingLoggedGen = String(this.generation);
          log.warn(`[airplay-bridge] 零心跳重建熔断: device=${this.deviceId} gen=${this.generation} 连续 ${fired.failedRun} 次重连仍 0 次 timing ⇒ 停用 30min(设备接收端已不可救,需人工断电重启)`);
        }
      } else {
        this.livenessReconnectInFlight = true;
        this.streamStartedAtMs = 0;
        log.warn(`[airplay-bridge] 零心跳重建: device=${this.deviceId} gen=${this.generation} 起流 ${Math.round(streamAgeMs / 1000)}s 仍 0 次 timing 请求(健康固件恒 20 次/分钟)⇒ 设备接收端未接管本会话,先 TEARDOWN 旧会话再完整重握手(10min 内第 ${fired.firesInWindow} 次)`);
        void this.reconnectRaop()
          .catch(() => { /* 重连失败已由 scheduleRaopReconnect 接管退避 */ })
          .finally(() => {
            this.livenessReconnectInFlight = false;
            if (this.player) {
              this.player.lastDeviceSignalAt = Date.now();
              this.player.lastTimingAt = Date.now();
            }
          });
      }
    }

    if (
      Date.now() >= livenessBreaker.cooldownUntil &&
      livenessWatchdogShouldFire({
        enabled: raopBridgeLivenessWatchdogEnabled(),
        isAp2: this.ap2Session !== null,
        paused: this.pausedState,
        connected: this.connected,
        closed: this.closed,
        hasPlayer: this.player !== null,
        streaming: this.aligner !== null,
        reconnectInFlight: this.livenessReconnectInFlight,
        reconnectTimerSet: this.raopReconnectTimer !== null,
        quietMs: livenessQuietMs,
        thresholdMs: livenessThresholdMs,
        hasTimingHeartbeat: livenessHasHeartbeat,
      })
    ) {
      // ★ P1(2026-11-03):静默 ≠ 会话死。设备只是"没发 NTP 请求",RTSP 通道可能完全健康
      //   (MA/libraop 从不用静默判死,只有 RTSP/控制面报错才重连)。先做一次**只读**
      //   OPTIONS 仲裁:有状态码应答就判良性、绝不 TEARDOWN;连续 2 次无响应才重连。
      void this.arbitrateLiveness(livenessQuietMs, livenessThresholdMs);
    }
    // C-4(复核)结构性兜底:看门狗要求 `streaming = aligner !== null`,而本次事故的
    // 状态恰恰是 **aligner 恒 null**(240 实证 04:21:37–04:21:44 无一个 anchor)⇒ 看门狗
    // 在最需要它的状态里是关闭的。这里独立补一条:connected + 有 player + 无消费者,且
    // 积压已超 1.5s 并持续 8s ⇒ 说明起流判定被漏掉,主动补一次并告警。
    // (8s 门槛高于实测换歌断流中位数 3.78s / p90 13.45s 的起流延迟,不会误触正常换代。)
    if (this.connected && this.player !== null && this.aligner === null && !this.pausedState) {
      if (this.noConsumerSince === 0) this.noConsumerSince = Date.now();
      const stalledMs = Date.now() - this.noConsumerSince;
      if (stalledMs >= 8000 && this.inBytes >= BRIDGE_PCM_BYTES_PER_SEC * 1.5) {
        log.warn(`[airplay-bridge] ${JSON.stringify({
          ev: "no-consumer",
          dev: this.deviceId,
          gen: this.generation,
          stalledMs,
          backlogMs: this.backlogMs(),
        })}`);
        this.noConsumerSince = Date.now();
        void this.maybeBeginStream();
      }
    } else {
      this.noConsumerSince = 0;
    }
    const rate = this.outRate;
    const queueMs = Math.round(((this.outBuf.length >> 2) / rate) * 1000);
    if (queueMs > this.maxQueueMs) this.maxQueueMs = queueMs;
    let deltaUs = 0;
    const anchors = this.anchors;
    if (anchors) {
      // deltaUs(§10.5):已写入 RAOP 的内容前沿相对 A′ 的超前量 ≈ L + 队列 + 在途。
      // 锚点错 X ⇒ 恒偏 X;与 driftUs(对齐残差)/ late(lead 不足)可区分。
      const writtenFrames = (this.stats.chunksOut - this.chunksOutAtPlan) * CHUNK_LEN;
      const frontier = anchors.anchorUsShifted + BigInt(Math.round((writtenFrames / rate) * 1e6));
      deltaUs = Number(frontier - nowUs());
      // ---- 2026-11-02 判据修复:内容前沿贴住墙钟 ⇒ 向前重锚 pacing ----
      // 旧 rebase 只认「节拍滞后 > BRIDGE_RESUME_REBASE_US(2s)」;HiVi 实测恒定
      // 落后 ~0.52s,2s 阈值永远触发不了 ⇒ 整首歌带欠账跑、每秒欠一块(一卡一卡)。
      // 这里以「内容前沿距 now 的最小可听余量」为第二条判据:低于 1.5s 就前移
      // pacing(= 该值 − deltaUs),主动停喂让设备缓冲排空,把余量垫回。
      // 只动 sendAt 参考,RTP 映射/内容轴不变。落点 = 下限 + 100ms、触发线 = 下限 −
      // 100ms ⇒ 前移后自带 200ms 回差,不会让「卡在阈值上」反复停喂;单次前移 ≤4s
      // (极端陈旧锚点由下几个 tick 继续收,绝不为一次缺口停喂十几秒)。
      // 门控(实测排空期 37 次 ×4s 空转):会话已停/正在排空时 deltaUs 深度为负
      // 是「内容轴已走完」而非「贴住墙钟」,重锚既救不回内容,还会把残尾继续推后。
      // 判据 = 内容前沿本 tick 仍在推进 + 链路活着仍出流;前沿冻结即视为无料可补。
      // 2026-11-03 补三道闸(12:33/20:33 换曲风暴实证)——
      //   a) deltaUs > 0:前沿已落到墙钟之后(= 真欠料),再停喂只会更深负、救不回来;
      //   b) 上游积压 ≤3s:有积压说明 delta 变小是「欠料」而非「贴住墙钟」,
      //      停喂会把积压推向 overflow(实测 15.5s → 16s 断连 rehost);
      //   c) 冷却 5s:与 raop 的 pause/lag rebase 互斥(同一偏差只补一次),
      //      否则每 2s 一次把 shift 顶到 4s 上限(实测 ×7)。
      const frontierAdvanced = frontier > this.lastFrontierUs;
      this.lastFrontierUs = frontier;
      const player = this.player;
      if (
        frontierAdvanced
        && player !== null && this.aligner !== null && !this.pausedState
        && !this.closed && !this.streamAborted && player.isStreaming
        && deltaUs > 0
        && this.backlogMs() <= BRIDGE_FRONT_REBASE_MAX_BACKLOG_MS
        && player.msSinceLastPacingRebase >= BRIDGE_FRONT_REBASE_COOLDOWN_MS
        && deltaUs < BRIDGE_REBASE_MIN_AHEAD_US - 100_000
      ) {
        const shiftUs = Math.min(
          BRIDGE_REBASE_MIN_AHEAD_US + 100_000 - deltaUs,
          4_000_000,
        );
        player.requestPacingRebase(shiftUs);
        log.warn(`[airplay-bridge] ${JSON.stringify({
          ev: "front-rebase",
          dev: this.deviceId,
          gen: this.generation,
          deltaUs,
          shiftUs,
          minAheadUs: BRIDGE_REBASE_MIN_AHEAD_US,
          backlogMs: this.backlogMs(),
        })}`);
      }
      // [N1/MA _absorb_playout_shift :1411-1446 差异说明] MA 的 cliairplay 断粮时会
    // 自行推迟 playout re-anchor 并上报 cumulative_shift_seconds,桥据此折回映射
    // (drop_until_us += delta;负 delta 取新基线不追旧账)。本仓 RAOP/AP2 侧**没有**
    // 该上报源(全仓 grep cumulative/shift 仅剩已移除的 S8 校准链残留),设备自行
    // 重排不可观测 ⇒ 只能把「late 暴涨 + 残留积压 0」这一可观测指纹诊断化:
    // late 涨幅超阈值时打一行联动日志(与 bridge-late-selfheal 守卫互为印证 ——
    // 该行出现即说明存在 MA 所述的设备端 shift,等价于 `_absorb_playout_shift` 的
    // 折回量,可由 selfheal 的 BOUNDARY{seek} 重建映射来吸收)。
    this.deltaSamples.push(deltaUs);
      if (this.deltaSamples.length > 25) this.deltaSamples.shift();
    }
    const sorted = [...this.deltaSamples].sort((a, b) => a - b);
    const p95 = sorted.length > 0
      ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))]
      : 0;
    // A：空壳自检（每 2s）—— 有内容在投却始终无 anchor ⇒ 强制重建。
    // 不依赖设备上线事件（mDNS 抖动/上线事件漏发时的兜底）。
    this.reanchorIfUnanchored(0, "tick");

    // 低缓冲自愈(指令式):**判断留在桥侧**(只有它知道被抽干成什么样),发"请加速"指令,
    // 主进程转发给 sendspin 子进程执行 —— 泵是唯一能多产内容的一方,但它看不到设备侧水位。
    {
      const bridgeInQ = this.backlogMs();
      bridgeStatsSink?.({
        deviceId: this.deviceId,
        inQueueMs: bridgeInQ,
        backlogMs: bridgeInQ,
        actualSendAtUs: this.actualSendAtUs,
        commandedAnchorUs: this.anchorUs !== null ? Number(this.anchorUs) : 0,
        firstPacketLeadUs: this.firstPacketLeadUs,
        firstFrameTsUs: this.firstFrameTsUs === null ? null : Number(this.firstFrameTsUs),
        isAp2: this.ap2Session !== null,
        lateTotal: this.player?.bridgeLateCount ?? 0,
        // 设备已收未播(= 内容前沿相对 A′ 的超前量,§10.5)。排空/未锚期 deltaUs 可为负
        // (frontier 已落后墙钟),归 0 让下游「余量」判据不会被负值反噬。
        deviceLeadMs: Math.max(0, Math.round(deltaUs / 1000)),
      });
      const nowMs = Date.now();

      // 低缓冲自愈：桥侧**只报事实**（设备侧饿了），不设次数/时长限制。
      //   2026-11-19 教训：这里曾堆过"补后验证 / 停手 120s / 次数额度"，全部是
      //   在错误动作发生后才刹车。真正该做的是判断"是否需要补"——而判断依据
      //   （内容前沿超前多少）只有泵侧有，所以判断搬到那边，这里保持纯粹。
      // ★设备没接流时绝不报饿（2026-11-20 10:16 实测）：HiVi 断电后会话进入 listening
      //   （connected=false、anchorUs=null），inQueue 恒 0 ⇒ 每 6s 一条 pace-bump-req
      //   （inQueueMs=0 roomMs=8000），sendspin 侧再判 deliverableMs=0「真缺料」放行，
      //   泵被无限加速 —— 与 2026-11-19 18:42 连补 287 次同款。设备上电后内容轴已超前
      //   几十秒，只会溢出/追发。判据必须是"有真实消费者"：anchorUs 非空才算在流。
      // 垫子补足：低于阈值就报一次，补量由 deficit 限到目标水位（见 BRIDGE_TOPUP_THRESHOLD_MS）。
      if (bridgeInQ < BRIDGE_TOPUP_THRESHOLD_MS && this.anchorUs !== null) {
        if (this.lowQueueSinceMs === 0) this.lowQueueSinceMs = nowMs;
        if (
          nowMs - this.lowQueueSinceMs >= BRIDGE_LOW_QUEUE_PERSIST_MS
          && nowMs - this.lastPaceBumpReqAt >= BRIDGE_PACE_BUMP_COOLDOWN_MS
          && bridgeInQ + BRIDGE_PACE_BUMP_MS <= BRIDGE_DEVICE_BUFFER_MAX_MS
        ) {
          this.lastPaceBumpReqAt = nowMs;
          this.lowQueueSinceMs = 0;
          // deficit = 离目标水位还差多少：投递侧据此把 bulk 量限到「刚好补满」，
          // 而不是固定 6s（实测固定 6s 会把 5.5s 顶到 11.3s，超设备天花板）。
          const deficitMs = Math.max(
            0,
            BRIDGE_DEVICE_BUFFER_MAX_MS - Math.round(bridgeInQ),
          );
          paceBumpSink?.({ deviceId: this.deviceId, ms: BRIDGE_PACE_BUMP_MS, deficitMs });
          log.info(
            `[airplay-bridge] ${JSON.stringify({
              ev: "pace-bump-req",
              dev: this.deviceId,
              inQueueMs: Math.round(bridgeInQ),
              ms: BRIDGE_PACE_BUMP_MS,
              roomMs: BRIDGE_DEVICE_BUFFER_MAX_MS - Math.round(bridgeInQ),
              thrMs: BRIDGE_TOPUP_THRESHOLD_MS,
              deficitMs,
            })}`,
          );
        }
      } else {
        // 桥水位恢复正常：结束本轮低缓冲计时。
        this.lowQueueSinceMs = 0;
      }
    }
    log.info(`[airplay-bridge] ${JSON.stringify({
      ev: "tick",
      dev: this.deviceId,
      gen: this.generation,
      state: this.pausedState ? "paused" : this.aligner ? "live" : (this.connected ? "connected" : "listening"),
      clock: "local-rtp-ntp",
      queueMs,
      // inQueue 深度(ms)= inBytes / BRIDGE_PCM_BYTES_PER_SEC(即 backlogMs()):
      // 分辨欠料在哪一层 —— 上游没给(bulk 未生效,应 ≈6000)还是 resample 没转。
      inQueueMs: this.backlogMs(),
      maxQueueMs: this.maxQueueMs,
      late: this.player?.bridgeLateCount ?? 0,
      // 4.11.10 空口加固观测:重传请求总量 / 实补 / 补不到 / 未来包,
      // 以及三条加固判据各自拦下的包数(风暴是否被就地压住,看这几个增量即可)。
      lossReq: this.player?.lossRequestedCount ?? 0,
      lossResent: this.player?.lossResentCount ?? 0,
      lossMiss: this.player?.lossMissCount ?? 0,
      lossFuture: this.player?.lossFutureCount ?? 0,
      lossDedup: this.player?.lossDedupCount ?? 0,
      lossThr: this.player?.lossThrottledCount ?? 0,
      lossStale: this.player?.lossStaleCount ?? 0,
      // D 组观测(2026-10-30):距设备上一次 timing 心跳的毫秒数 —— 看门狗判据的唯一
      // 输入,必须能被事后复核(null = 尚无 player)。健康期应恒 < 6000。
      timingAgeMs: this.player !== null ? Date.now() - this.player.lastTimingAt : null,
      ap2LateSkips: this.ap2LateSkips,
      ap2Degraded: this.ap2LinkLoss !== null,
      realigned: this.stats.realignments,
      silenceChunks: this.stats.silenceChunks,
      insertedFrames: this.stats.insertedFrames,
      droppedFrames: this.stats.droppedFrames,
      skippedFrames: this.stats.skippedFrames,
      newgenSkipFrames: this.stats.newgenSkipFrames,
      driftUs: this.aligner?.lastDriftUs ?? 0,
      deltaUs,
      deltaP95Us: p95,
      samples: this.deltaSamples.length,
      anchorUs: this.anchorUs !== null ? Number(this.anchorUs) : null,
      leadUs: recordBridgeLead(this.deviceId, this.commandedLeadUs),
    })}`);
  }

  /** RAOP producer:凑满一个 352 帧 chunk(输出速率 s16le/2ch = 1408B)。
   *  欠料等待 waitDataMs,超时补静音(保持 RTP 时钟连续,宁出静音不断流;
   *  补块计入内容时间线,对齐不破)。返回 null = 会话已停止(结束 stream 循环)。 */
  private async pullChunk(): Promise<Buffer | null> {
    if (this.closed || this.streamAborted) return null;
    const need = CHUNK_LEN * 4;
    // —— 新增:producer 预填充 / 低水位补货(decoder.ts PREFILL 的桥接对应层)——
    // 首块先囤到预填充水位再出块;运行中跌破低水位则先等补货到该水位,避免把上游抖动
    // 直接传导成发送节拍抖动。两段都带超时,超时降级到下面的原有欠料逻辑(不补静音、
    // 不报错)。纯缓冲层:tsUs / baseTs / startTs / 锚点 / aligner 一律不碰 —— 只是让
    // outBuf 多囤一些已解码音频,不改变任何一帧的内容位置。
    const prefillBytes = this.prefillTargetBytes();
    const lowWaterBytes = this.lowWaterTargetBytes();
    const filling = !this.prefillDone;
    const wantBytes = filling ? Math.max(need, prefillBytes) : Math.max(need, lowWaterBytes);
    const refillBudgetMs = filling ? BRIDGE_PREFILL_WAIT_MS : BRIDGE_LOW_WATER_WAIT_MS;
    // 首填等待只对「已有在途数据」的流有意义(生产上 maybeBeginStream 由首帧 ingest
    // 触发 ⇒ 首次 pull 必有在途料)。一帧都没到过(无上游/注入桩)时不空等预算:
    // 立刻落回下方原有 waitDataMs 欠料逻辑 —— 否则首块 sendAt 被拖过
    // AP2_LATE_SKIP_US ⇒ pacing 迟到级联(要追到 BRIDGE_RESUME_REBASE_US 才发首块)。
    const hasInFlight = this.inQueue.length > 0 || this.inBytes > 0 || this.outBuf.length > 0;
    // outBuf 已不足一块(真欠料)时不进补货阶段,交给下面原有的 waitDataMs 等料逻辑。
    if (this.outBuf.length >= need || (filling && hasInFlight)) {
      const refillDeadline = Date.now() + refillBudgetMs;
      while (this.outBuf.length < wantBytes) {
        // 预填充/补货期间会话被停 ⇒ 立即返回 null,绝不能卡死发送循环。
        if (this.closed || this.streamAborted) return null;
        const next = this.inQueue.shift();
        if (next !== undefined) {
          this.inBytes -= next.buf.length;
          this.resampleIn(next);
          continue;
        }
        if (Date.now() >= refillDeadline) break;
        await new Promise((r) => setTimeout(r, BRIDGE_PULL_POLL_MS));
      }
      if (filling) {
        // 预填充只做一次(首块):没攒够目标水位也只是记一条 info,后续照旧走原有逻辑。
        this.prefillDone = true;
        if (this.outBuf.length < prefillBytes) {
          log.info(`[airplay-bridge] ${JSON.stringify({
            ev: "producer-prefill-short",
            dev: this.deviceId,
            gen: this.generation,
            targetBytes: prefillBytes,
            gotBytes: this.outBuf.length,
            budgetMs: refillBudgetMs,
          })}`);
        }
      }
    }
    const deadline = Date.now() + this.waitDataMs;
    while (this.outBuf.length < need) {
      const next = this.inQueue.shift();
      if (next !== undefined) {
        this.inBytes -= next.buf.length;
        this.resampleIn(next);
        continue;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, BRIDGE_PULL_POLL_MS));
    }
    if (this.outBuf.length < need) {
      // 欠料:可用部分 + 静音补齐;未凑满的余料留在 outBuf 下一轮先用。
      const had = this.outBuf.length;
      const silence = Buffer.alloc(need);
      this.outBuf.copy(silence, 0);
      this.outBuf = Buffer.alloc(0);
      this.stats.silenceChunks++;
      if (this.aligner) this.aligner.padded((need - had) >> 2);
      return silence;
    }
    const chunk = Buffer.from(this.outBuf.subarray(0, need));
    this.outBuf = Buffer.from(this.outBuf.subarray(need));
    this.stats.chunksOut++;
    // [S8 校准闭环]RAOP 首块发出 proxy:producer 产出即被节拍循环写入 socket
    // (≤1 个 sendAt 粒度),比真实 socket 写早 ≤1 拍 —— 校准判据 500ms 阈值下
    // 该误差可忽略。AP2 路径走 runAp2OutputLoop 的 onFirstSend(精确)。
    if (this.actualSendAtUs === null) this.actualSendAtUs = Number(nowUs());
    return chunk;
  }

  /** 预填充目标字节数 = BRIDGE_PREFILL_MS 对应的 PCM 字节数。
   *  按**本实例**的实际输出速率换算(48k 直通或重采样后的 outRate),不硬编码采样率。 */
  private prefillTargetBytes(): number {
    return Math.round((BRIDGE_PREFILL_MS / 1000) * this.outRate * 2 * 2);
  }

  /** 低水位目标字节数(同上,按本实例的实际输出速率换算)。 */
  private lowWaterTargetBytes(): number {
    return Math.round((BRIDGE_LOW_WATER_MS / 1000) * this.outRate * 2 * 2);
  }

  /** 单帧处理:对齐(§4.5)→ 重采样 → 裁头出清 → 追加输出。 */
  private resampleIn(entry: { buf: Buffer; tsUs: bigint; generation: number }): void {
    const aligner = this.aligner;
    const rate = this.outRate;
    if (aligner && entry.tsUs !== 0n) {
      // D5(2026-11-01):早于内容零点(组时间线锚点)的输入**整块丢弃、不补静音**
      // —— MA `_drop_until_us` 语义。旧实现把这份「超前」交给对齐器 drop
      // (pendingDrops):drop 从**后续输出**里裁帧,outBuf 一旦被裁空,`pullChunk`
      // 只能补静音 ⇒ 用户听感是「声音丢了 / 静音」(240 实测 droppedFrames 7.5~12s)。
      // 这里直接裁掉输入前缀(48k / 4 字节每帧),对齐器从 target≈0 起步,不产生 drop。
      // 仅新模型生效:旧模型的零点取首帧,裁头会改变逐字节行为(回退开关要求等价)。
      if (this.groupTimelineSync && entry.tsUs < aligner.contentAnchorUs) {
        const startUs = aligner.contentAnchorUs;
        const frames = entry.buf.length >> 2;
        const durUs = BigInt(Math.round((frames / SENDSPIN_RATE) * 1e6));
        const endUs = entry.tsUs + durUs;
        if (endUs <= startUs) {
          // 整帧在锚点之前:不计入插入/跳过,只记丢帧(与 MA「不补静音」一致)。
          this.stats.droppedFrames += frames;
          return;
        }
        const off = Math.min(frames, Math.round((Number(startUs - entry.tsUs) / 1e6) * SENDSPIN_RATE));
        if (off > 0) {
          entry = {
            ...entry,
            buf: entry.buf.subarray(off * 4),
            tsUs: entry.tsUs + BigInt(Math.round((off / SENDSPIN_RATE) * 1e6)),
          };
          this.stats.droppedFrames += off;
        }
      }
      // ① 换曲/重锚的新代次首帧:大缺口走 skip(不物化静音),见 BRIDGE_NEWGEN_GAP_SKIP_US。
      //   缺口 > 阈值时内容位置直接跳到新时间线、RTP 时间线同步前移;听感仍是静音,
      //   但不再把秒级静音塞进 outBuf(那会把内容前沿垫高、与节拍轴错位 ⇒ 追发风暴)。
      const genChanged = entry.generation !== 0 && entry.generation !== this.lastResampledGen;
      if (entry.generation !== 0) this.lastResampledGen = entry.generation;
      let act: BridgeAlignAction;
      const newGenGap = genChanged ? aligner.gapFramesTo(entry.tsUs) : 0;
      if (newGenGap > 0 && (newGenGap / rate) * 1e6 > BRIDGE_NEWGEN_GAP_SKIP_US) {
        const frames = aligner.skipGapTo(entry.tsUs);
        act = {
          insertFrames: 0, dropFrames: 0, skipFrames: frames, realigned: frames > 0, diff: frames,
          newgenSkip: true,
        };
        log.warn(`[airplay-bridge] ${JSON.stringify({
          ev: "newgen-skip",
          dev: this.deviceId,
          gen: this.generation,
          frames,
          ms: Math.round((frames / rate) * 1000),
        })}`);
      } else {
        act = aligner.onFrame(entry.tsUs);
      }
      if (act.insertFrames > 0) {
        // 内容落后(有洞)⇒ 补静音(占据真实时间线)。D8:稳态对齐不设上限(长缺口也补,
        // 绝不跳段 —— 跳段会把本成员 RTP 内容轴前移,永久错位)。
        // 唯一例外 = 新代次首帧的大缺口:按 ① 先走 skip(见上),不会落到这里。
        // [N4/MA SILENCE_BLOCK] sendspin_bridge.py:118-124(1s immutable 共享静音块)
        // + :1567(_queue_silence):timeline rebase 可开出几十秒的洞,MA 用共享块重复
        // 引用、只分配子块余量 —— 防 MB 级一次性分配压 event loop。本仓同形:
        // 按 ≤1s 切片追加(避免 outBuf 直接别名共享块被上层改写)。
        {
          let left = act.insertFrames * 4;
          while (left > 0) {
            const piece = left <= SILENCE_BLOCK.length
              ? SILENCE_BLOCK.subarray(0, left)
              : SILENCE_BLOCK;
            this.appendOut(Buffer.from(piece));
            left -= piece.length;
          }
        }
        this.stats.insertedFrames += act.insertFrames;
        if (act.insertFrames > rate * 2) {
          log.warn(`[airplay-bridge] ${JSON.stringify({ ev: "pad-insert", dev: this.deviceId, gen: this.generation, frames: act.insertFrames, ms: Math.round((act.insertFrames / rate) * 1000) })}`);
        }
      }
      if (act.dropFrames > 0) {
        // 内容超前(重叠)⇒ 裁头:从后续重采样输出中丢弃(takeDrop,追加流保持连续,
        // RTP 时间线自洽);baseTs/startTs 均不动。
        this.stats.droppedFrames += act.dropFrames;
      }
      if (act.skipFrames > 0) {
        // 长欠料:跳段(不物化静音),RTP 时间线同步前移。
        // 分账(2026-11-19):换代首帧的 newgen-skip 是**正常**换代行为,只记诊断字段;
        // 只有曲中跳段(seek/长断料)才算「内容轴被污染」——否则 isContentAxisPoisoned()
        // 恒真 ⇒ 每次换歌都 resetTimeline ⇒ 曲头反复重建 ⇒ 曲中 insert 变密。
        if (act.newgenSkip) this.stats.newgenSkipFrames += act.skipFrames;
        else this.stats.skippedFrames += act.skipFrames;
        this.player?.bridgeSkipFrames(act.skipFrames);
      }
      if (act.realigned) {
        this.stats.realignments++;
        // 稳态无动作漂移 → DEBUG(刷屏降噪);动作型对齐 → WARN。
        const msg = `[airplay-bridge] realigned: device=${this.deviceId} drift=${act.diff} frames (${((act.diff / rate) * 1000).toFixed(1)}ms) insert=${act.insertFrames} drop=${act.dropFrames} skip=${act.skipFrames}`;
        if (realignedLogLevel(act) === "debug") log.debug(msg);
        else log.warn(msg);
      }
    }
    // 48k s16le → Float32 →(147/160)→ 输出速率 Float32 → s16le 追加
    const s16 = new Int16Array(entry.buf.buffer, entry.buf.byteOffset, entry.buf.length >> 1);
    const f32 = pcmS16ToFloat(s16);
    let out = this.resampler ? this.resampler.process(f32) : f32;
    if (aligner && aligner.pendingDrops > 0 && out.length > 0) {
      const dropFrames = aligner.takeDrop(out.length >> 1);
      if (dropFrames > 0) out = out.subarray(dropFrames * 2);
    }
    if (out.length > 0) {
      const s16out = floatToPcmS16(out);
      this.appendOut(Buffer.from(s16out.buffer, s16out.byteOffset, s16out.byteLength));
      if (aligner) aligner.produced(out.length >> 1);
    }
  }

  private appendOut(piece: Buffer): void {
    this.outBuf = this.outBuf.length === 0 ? piece : Buffer.concat([this.outBuf, piece]);
  }

  /** 停止:断 listener + TEARDOWN RAOP。幂等。 */
  async stop(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.pausedState = false;
    this.streamAborted = true;
    this.gapFillerToken++; // A:令在跑的垫片续流立即退出(closed 亦使其自停)
    this.gapFillerPromise = null;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.raopReconnectTimer) {
      clearTimeout(this.raopReconnectTimer);
      this.raopReconnectTimer = null;
    }
    const server = this.server;
    this.server = null;
    if (server) await server.close();
    this.inQueue = [];
    this.inBytes = 0;
    this.outBuf = Buffer.alloc(0);
    const player = this.player;
    this.player = null;
    if (player) {
      try { await player.stop(); } catch { /* ignore */ }
    }
    // AP2 会话回收(幂等;TEARDOWN best-effort)。循环已因 streamAborted 退出。
    const ap2 = this.ap2Session;
    this.ap2Session = null;
    if (ap2) {
      try { await ap2.close(); } catch { /* ignore */ }
    }
  }

  /** 运行期下发音量(dB)。**桥占用设备音量 RPC 的唯一落点**:
   *  主进程 `applyVolumeDb` → 子进程 `setVolumeDb` op → native 会话未命中时回落到这里。
   *  player 在 RECORD 完成前为 null(`:279` 声明、`:372` 赋值),停止/重连期间同样可能为 null
   *  ⇒ 用可选链;失败只 warn,绝不打断推流(音量是旁路能力,不能因它拆桥会话)。 */
  setVolumeDb(db: number): void {
    try {
      // AP2 桥的音量走 AP2 会话自己的路径(SET_PARAMETER volume);无该能力时只 warn。
      if (this.ap2Session !== null) {
        this.pushAp2Volume(db);
        return;
      }
      this.player?.setVolumeDb(db);
    } catch (e: any) {
      log.warn(`[airplay-bridge] setVolumeDb failed: device=${this.deviceId} db=${db} err=${e?.message || e}`);
    }
  }

  /** D8(2026-11-01):内容轴是否已被本地跳段污染(S 帧偏移会永久带过换代)。 */
  isContentAxisPoisoned(): boolean {
    return this.stats.skippedFrames > 0;
  }

  /** D8(2026-11-01):丢弃当前内容轴(锚点/对齐器)并中止旧推流,让下一帧 AUDIO 重新规划。
   *
   *  与「重启型边界(rehost/seek)」同一语义:旧 streamBridge 立即退出、新流首包带 0xE0
   *  重锚;锚点重新规划时若带 groupKey 会走 D7 共享锚点,因此组内不会因这次复位再分裂。
   *  用于暖复用路径:旧会话的内容轴被 `bridgeSkipFrames` 平移过(或锚点早已过期),
   *  继续沿用会把历史偏移/旧锚点带进新代次(240 实测 tick 恒报旧 anchorUs、分裂 2.95s)。 */
  resetTimeline(reason: string): void {
    if (this.closed) return;
    this.firstFrameTsUs = null;
    this.aligner = null;
    this.anchors = null;
    this.anchorUs = null;
    this.commandedLeadUs = null;
    this.streamAborted = true;
    this.stats.skippedFrames = 0;
    this.stats.newgenSkipFrames = 0;
    // ⛔ **绝不要在这里重置 `lastResampledGen`**（2026-11-19 二次否决，4.14.15 撤回）。
    //   重置它会让复位后首帧走 `newgen-skip`（跳掉 ~2.15s 内容而不补静音），单次听感
    //   确实更好；但**每次换代都把内容轴前移 2.15s**，跑一夜后 240 实测：
    //     deltaUs  +2059294 → −431704（内容轴被推到节拍轴前面）
    //     inQueueMs    5525 →     2000（投递窗口算出的量缩水，设备侧只剩 2s 余量）
    //   ⇒ 任何抖动即欠载 ⇒ 可闻卡顿+静音，比「每轮偶发 2.14s 静音」严重得多。
    //   复位后补静音虽然断 2.14s，但**不累积漂移**，这才是有界的行为。
    //   P1（raop.waitUntilUs 中止判据）与跳段分账与本行无关，均已保留。
    this.player?.flush();
    log.info(`[airplay-bridge] ${JSON.stringify({ ev: "timeline-reset", dev: this.deviceId, gen: this.generation, reason })}`);
  }

  /** D6(2026-11-01):运行中改成员补偿 —— **只平移本设备的 RTP↔NTP 映射**,不重建桥。
   *
   *  背景(240 实测):`PUT /groups/:id/delays` 旧实现只重发 `bridgePrepare`,而 warm-reuse
   *  直接复用旧会话、且 `anchorShiftUs` 只在 `maybeBeginStream` 里消费一次 ⇒ 改值对**运行中**
   *  会话永不生效(两次 PUT 后 anchor 的 shifted−scheduled 恒 old 值)。
   *
   *  语义:补偿 = 「本设备相对组时间线的出声偏移」,组时间线(内容/投递节拍)不动
   *  (D1/D3 已保证同刻同内容) ⇒ 改值只需把设备侧的映射平移 Δ = next − prev。
   *  未起流时只更新 opts,下一次锚定自然取新值。
   *
   *  @returns true = 已落到会话(opts 已更新;流在跑时已 retime);false = AP2 出口
   *  (无 RTP 时间线,只能重建桥)或参数非法。
   */

  applyAnchorShift(shiftUs: number): boolean {
    const next = Number.isFinite(shiftUs) ? Math.round(shiftUs) : 0;
    const prev = this.opts.anchorShiftUs ?? 0;
    this.opts.anchorShiftUs = next;
    const delta = next - prev;
    if (delta === 0) return true;
    if (this.ap2Session !== null) {
      log.warn(`[airplay-bridge] ${JSON.stringify({
        ev: "set-delay-unsupported", dev: this.deviceId, gen: this.generation,
        prevUs: prev, nextUs: next, reason: "ap2-no-rtp-timeline",
      })}`);
      return false;
    }
    const applied = this.player?.retimeByUs(delta) ?? false;
    log.info(`[airplay-bridge] ${JSON.stringify({
      ev: "set-delay", dev: this.deviceId, gen: this.generation,
      prevUs: prev, nextUs: next, deltaUs: delta, applied,
    })}`);
    return true;
  }

  /** D9(2026-11-01)/方案1(2026-11-03):改补偿的落地 —— **只平移运行中的映射,绝不重建 RTSP 会话**。
   *
   *  历史(D9):为保证设备"必吃"新映射,这里曾 TEARDOWN → 新 ANNOUNCE/SETUP/RECORD。
   *  实测代价不可接受(2026-11-03 240 真机):重建会清空桥队列并对新会话重新锚定,
   *  单次换来 6.28~7.60s 静音;而且它把「拖一次延迟滑杆」变成一次设备级重连,是
   *  HiVi(MUZO)被搞成永久无声的触发链之一。
   *
   *  现在:运行中只调 `retimeByUs`(平移 startNtp + 立即一段 SYNC),会话/队列/锚点全部不动。
   *  SYNC 单向无回执 ⇒ 若设备运行中不采纳,新值不丢(opts 已更新),在**下一次自然的**
   *  会话建立(RECORD)或代次重锚时生效 —— 宁可变声晚一点,也不再拿整条队列陪跑。
   *
   *  @returns true = 已接受(opts 已更新,运行中已原地 retime);false = 会话已关闭或 AP2 出口
   *  (无 RTP 时间线,主进程按路由重建兜底)。 */
  async rebuildForShift(shiftUs: number, reason = "delay-change"): Promise<boolean> {
    if (this.closed) return false;
    // [组A] late-selfheal-retime:shift 由**桥内** late 增量自估(数据在设备侧,
    // 主进程传 shiftUs=0 触发)。MA 出处:sendspin_bridge.py:1411-1446
    // _absorb_playout_shift —— MA 的 delta 来自 binary cumulative_shift_seconds
    // 上报;本仓 RAOP 无该上报源,用 late 帧增量估计(352/44100≈7.98ms/帧;
    // 真机标定 late≈+123/s ≈ 设备 1x 实时落后)。基线 lastRetimeLateTotal
    // 防重放:两次 retime 之间只对**新增** late 负责;无新增 late = 无证据,
    // 不做映射平移(禁止把猜测当实测),守卫侧按「未奏效」升级 lightRestart。
    let effectiveShift = shiftUs;
    if (reason === "late-selfheal-retime") {
      const late = this.player?.bridgeLateCount ?? 0;
      const deltaFrames = Math.max(0, late - this.lastRetimeLateTotal);
      this.lastRetimeLateTotal = late;
      effectiveShift = Math.round(deltaFrames * 7980);
      // 桥侧自估钳制:与守卫侧 BRIDGE_SELFHEAL_RETIME_SHIFT_MAX_US(10s,sendspin/
      // constants.ts)同值 —— retime 只救「轻错位」,超出即判定过深(01:05 事故实证
      // 29s 平移会环空),skip 让守卫 armed 再到升级二级 lightRestart。
      const SELFHEAL_RETIME_SHIFT_MAX_US = 10_000_000;
      if (effectiveShift <= 0 || effectiveShift > SELFHEAL_RETIME_SHIFT_MAX_US) {
        log.info(`[airplay-bridge] ${JSON.stringify({
          ev: "late-selfheal-retime-skip", dev: this.deviceId, late, deltaFrames, shiftUs: effectiveShift,
          note: effectiveShift <= 0
            ? "无新增 late 证据,不平移映射(自愈分级一级无证据即让位二级)"
            : "自估 shift 超 10s 门,过深错位 retime 救不动,让位二级 lightRestart",
        })}`);
        return true;
      }
    }
    // AP2 无 RTP 时间线:opts 已更新,只能靠主进程重建桥路由(调用方兜底)。
    if (this.ap2Session !== null) {
      this.applyAnchorShift(effectiveShift);
      return false;
    }
    if (!this.applyAnchorShift(effectiveShift)) return false;
    log.info(`[airplay-bridge] ${JSON.stringify({
      ev: "set-delay-inplace", dev: this.deviceId, gen: this.generation,
      shiftUs: effectiveShift, reason,
      // 原地 retime 是否真的落到了在跑的流(未起流/已中止 ⇒ false,新值留待下次锚定)
      applied: this.player !== null && this.aligner !== null && !this.streamAborted,
    })}`);
    return true;
  }

  /** [组A/N3,MA sendspin_bridge.py:640-693 _restart_transport 同形态] 轻量重启:
   *  清内容管线(锚点/对齐器/首帧时戳全部作废)+ flush 推流,下一帧在新锚点重排;
   *  **绝不 reconnectRaop**(RAOP socket 仍 warm 复用,与 MA "kept, still-connected
   *  stream" 一致)。触发面:自愈分级第二级(retime 无效/shift 超 10s 门)。
   *  差异取舍:MA 清 write_queue+held chunks;本仓锚点状态在 session 字段,
   *  清法与 onBoundary 换代重启分支(1780)同款 —— 已被真机验证的重锚三件套。 */
  lightRestart(reason: string): boolean {
    if (this.closed) return false;
    log.warn(`[airplay-bridge] ${JSON.stringify({
      ev: "late-selfheal-light-restart", dev: this.deviceId, gen: this.generation, reason,
      note: "清锚点/对齐器 + flush 重锚,不拆 socket(MA _restart_transport 形态)",
    })}`);
    this.firstFrameTsUs = null;
    this.aligner = null;
    this.anchors = null;
    this.anchorUs = null;
    this.commandedLeadUs = null;
    this.firstPacketLeadUs = null;
    this.streamAborted = true;
    this.player?.flush();
    return true;
  }

  /** 空壳：已建连、内容在投（backlog>0），但始终无 anchor（从未进 live）。
   *  graceMs <= 0 时用 BRIDGE_UNANCHORED_REBUILD_MS。
   *  为什么要求 backlog>0：正常起播前还没内容投进来，那时 anchor 也是 null，
   *  不能当成空壳；一旦有内容在投却锚不上，才是设备侧真的没接流。 */
  private isUnanchoredShell(graceMs: number): boolean {
    if (this.closed || !this.connected) return false;
    if (this.anchorUs !== null) return false;
    if (this.raopReconnectInFlight || this.raopReconnectTimer !== null) return false;
    if (this.backlogMs() <= 0) return false;
    const grace = graceMs > 0 ? graceMs : BRIDGE_UNANCHORED_REBUILD_MS;
    return Date.now() - this.createdAtMs >= grace;
  }

  /** 重建空壳会话（A 自检 / B 设备上线共用）。
   *  @returns true = 判为空壳且已调度重建。 */
  reanchorIfUnanchored(graceMs: number, reason: string): boolean {
    if (!this.isUnanchoredShell(graceMs)) return false;
    log.warn(`[airplay-bridge] ${JSON.stringify({
      ev: "unanchored-rebuild",
      dev: this.deviceId,
      gen: this.generation,
      ageMs: Date.now() - this.createdAtMs,
      backlogMs: Math.round(this.backlogMs()),
      reason,
    })}`);
    this.scheduleRaopReconnect(`unanchored(${reason})`);
    return true;
  }

  /** D9(2026-11-01):会话是否已关闭 —— manager 据此**跳过僵尸会话**。
   *  240 实证:同 deviceId 可能残留一条 `reason=closed` 的旧条目(泵断连后未从表里摘除),
   *  按 deviceId 查找时它会**遮蔽**真正在跑的那座桥 ⇒ 改补偿/音量全部落到死会话上。 */
  isClosedSession(): boolean {
    return this.closed;
  }

  /** 会话年龄(ms)：供 manager 日志使用（createdAtMs 是私有字段）。 */
  createdAtMsForLog(): number { return this.createdAtMs; }

  /** 诊断快照(bridgeStatus op 用)。 */
  snapshot(): {
    deviceId: string;
    token: string;
    socketPath: string | null;
    streaming: boolean;
    stats: BridgeSessionStats;
    anchored: boolean;
    anchorUs: number | null;
    commandedLeadUs: number | null;
    generation: number;
    latencyFrames: number | null;
    latePackets: number;
    /** 组泵暂停中(§5.4;推流被冻结,不写静音不计 late)。 */
    paused: boolean;
    /** RAOP 重连退避进行中(设备离线 degraded)。 */
    reconnecting: boolean;
    /** AP2 链路已断(主进程看门狗据此摘桥 + 本流回落 solo cast;RAOP 恒 false)。 */
    degraded: boolean;
    /** AP2 链路失败原因(`ev=link-loss` 的 reason;空 = 正常/非 AP2)。 */
    linkLoss: string | null;
    /** 因 sendAt 过久被丢弃的 AP2 块数(RAOP 恒 0)。 */
    ap2LateSkips: number;
    /** 设备侧待播缓冲(ms) = inQueue + outBuf 折算,与 tick 日志同源(backlogMs)。 */
    inQueueMs: number;
  } {
    return {
      deviceId: this.deviceId,
      token: this.token,
      socketPath: this.listeningOn,
      streaming: this.player?.isStreaming ?? false,
      stats: { ...this.stats },
      anchored: this.aligner !== null,
      anchorUs: this.anchorUs !== null ? Number(this.anchorUs) : null,
      commandedLeadUs: this.commandedLeadUs !== null ? Number(this.commandedLeadUs) : null,
      generation: this.generation,
      latencyFrames: this.player?.negotiatedLatencyFrames ?? (this.ap2Session ? this.ap2DeclaredLatencyFrames : null),
      latePackets: this.player?.bridgeLateCount ?? 0,
      paused: this.pausedState,
      reconnecting: this.raopReconnectTimer !== null,
      degraded: this.ap2LinkLoss !== null || this.ap2Session?.currentState === "error",
      linkLoss: this.ap2LinkLoss,
      ap2LateSkips: this.ap2LateSkips,
      inQueueMs: this.backlogMs(),
    };
  }
}

/** 桥水位上报出口(诊断用;childMain 接到 process.send)。
 *  [S8 校准闭环]扩展字段:actualSendAtUs(首块实际发出墙钟,null=未发)/
 *  commandedAnchorUs(命令锚点 A,0=未锚)/holdDepthMs(设备持有深度估计 =
 *  子进程入向 ring 未消费时长,同 inQueueMs 口径)—— 校准判定与逐设备投递
 *  窗口的数据源。 */
type BridgeStatsSink = (row: {
  deviceId: string;
  inQueueMs: number;
  /** [S8 复核④]如实命名:值 = 子进程入向 ring 积压(backlogMs),非设备侧持有深度。 */
  backlogMs: number;
  actualSendAtUs: number | null;
  commandedAnchorUs: number;
  firstPacketLeadUs: number | null;
  /** [2026-11-25 11:33 对齐 MA ack] 首包的名义播放时刻(µs)。
   *  与 actualSendAtUs 一起才能算出「桥实际提前量」= firstFrameTsUs − actualSendAtUs，
   *  与命令提前量 firstPacketLeadUs 相比即得偏差（MA _anchor_stream 的 skipped_us 口径）。 */
  firstFrameTsUs: number | null;
  /** AP2 会话标记:S8 复核② —— AP2 执行端(applyAnchorShift)是 no-op,
   *  排除出校准判定面,避免「每 10s 判定→下发→false→空转」。 */
  isAp2: boolean;
  /** [组A] 设备侧累计 late 帧(RAOP 352/44100≈7.98ms/帧)—— 自愈分级 retime 的
   *  shift 估计输入(上行链:本 sink → childMain bridgeStats → 主进程 supervisor →
   *  sendspin bridgeHealth rpc → server.bridgeLateTotal → 守卫三级分级)。 */
  lateTotal: number;
  /** [方案A 2026-11-26] 设备侧「已收未播」时长(ms)= 本 tick 的 `deltaUs/1000`(≤0 归 0)。
   *  上行链与 backlogMs 同路(→ supervisor bridgeHealth → sendspin server)。
   *  为什么必须单独一列:曲末泵停投后,桥还能撑多久 = **垫子(backlogMs)+ 已收未播
   *  (本列)**;只报垫子会把「设备还能播十几秒真实音频」误判成「马上要播空」,
   *  泵据此灌静音 ⇒ 静音被设备完整播出(真机 2026-11-26 每首 8~30s 可闻静音)。 */
  deviceLeadMs: number;
}) => void;
let bridgeStatsSink: BridgeStatsSink | null = null;

/** 加压请求出口(指令式):桥侧判断"缓冲被抽干"后发出,主进程转给 sendspin 子进程执行。 */
type PaceBumpSink = (req: { deviceId: string; ms: number; deficitMs?: number }) => void;
let paceBumpSink: PaceBumpSink | null = null;

export function setBridgeStatsSink(fn: BridgeStatsSink | null): void {
  bridgeStatsSink = fn;
}

export function setPaceBumpSink(fn: PaceBumpSink | null): void {
  paceBumpSink = fn;
}

/** 桥缓冲判据(指令式,全部在 airplay 侧):跌破即计时,持续够久才发指令。 */
const BRIDGE_LOW_QUEUE_BUMP_MS = 2_000;
const BRIDGE_LOW_QUEUE_PERSIST_MS = 3_000;

/** 垫子补足阈值（ms，2026-11-20 定案）。
 *
 *  背景：`inQueueMs` 不是"设备缓冲"，而是**桥侧垫子**——已收到、还没写进 RAOP 的音频。
 *  它的物理作用是吸收投递停顿：sendspin 一停投，桥还能靠它按 1x 继续喂设备。
 *  实测（bridge-gen-delivery-loss）：换代会让投递损失 **5.99 秒（29.6%）**，
 *  垫子 7.0→2.7 秒 ⇒ delta 转负 ⇒ 听感秒级断续。
 *
 *  目标水位取设备天花板 8s（`BRIDGE_DEVICE_BUFFER_MAX_MS`，借自 MA 的
 *  MAX_DEVICE_BUFFER_SECONDS）；减 2s 作为触发余量，避免"刚补完立刻又触发"。
 *  补多少由 `deficitMs`（= 目标 − 当前）决定，所以补完恰好到 8s，不会顶过头。
 *
 *  为什么不按"换代窗口"触发：`continuity=1` 的换代走 keep 路径、**不改帧代次**，
 *  桥侧的 `generation` 不变 ⇒ 窗口感知不到换代（240 实测 09:23 损失 5.99s 却漏触发）。
 *  直接按垫子水位判断更可靠，也不依赖任何换代信号。 */
const BRIDGE_TOPUP_THRESHOLD_MS = 6_000;
const BRIDGE_PACE_BUMP_MS = 2_000;
const BRIDGE_PACE_BUMP_COOLDOWN_MS = 5_000;
/** 设备侧缓冲天花板（ms）—— 借自 MA `sendspin_bridge.py` 的 `MAX_DEVICE_BUFFER_SECONDS
 *  = 8.0`：设备"已收未播"的音频最多喂到这么多（其 prefill 需求约 2s lead + 2s 内部
 *  缓冲，再加余量）。超过就说明补够了，再补只会把设备灌爆/推离锚点。
 *  用它替代"连续补 3 次"这种固定额度：按剩余空间判断，更贴实际。 */
const BRIDGE_DEVICE_BUFFER_MAX_MS = 8_000;

/** A(2026-11-20)：空壳会话重建门槛 —— 会话已建连、内容已在投，却始终拿不到 anchor
 *  （设备从未真正接流）。240 实测 09:37：设备离线时 prepare 建出 connected 无 anchor
 *  的空壳，之后每次换代都 warm-reuse 它 ⇒ 同 token 复用 8 小时、全程 0 条
 *  `bridge first packet`、内容按 14s/次 overflow 丢弃、设备整首静音。
 *  超时即走 reconnectRaop（显式 TEARDOWN + 新 RECORD），这是唯一能救活 MUZO 的动作。
 *  为什么是 25s 而不是 15s：`resetTimeline`（换代/复位）也会把 anchorUs 清成 null，
 *  而曲末排空 8s + 换代后 bulk 等 6s 最坏约 14s 仍在合法无锚窗口内 —— 门槛必须
 *  明显高于它，否则正常换代会被误判成空壳、白丢一次会话（1~2s 静音 + 队列清空）。 */
const BRIDGE_UNANCHORED_REBUILD_MS = 25_000;
/** B：设备上线事件触发时的宽限 —— 刚 prepare 的会话还没来得及拿到首帧，别当场重建。 */
const BRIDGE_UNANCHORED_ONLINE_GRACE_MS = 5_000;

/** 子进程侧桥会话表(按 sessionToken 索引;同 deviceId 新 prepare 拆旧)。 */
export class BridgeSessionManager {
  private readonly sessions = new Map<string, BridgeSession>();
  /** D7:同组同 gen 共享锚点(跨会话状态,随 manager 生命周期;见 BridgeGroupAnchorRegistry)。 */
  private readonly groupAnchors = new BridgeGroupAnchorRegistry();
  /** D8:同组同 gen 边界处置一致性(同上;见 BridgeGroupBoundaryRegistry)。 */
  private readonly groupBoundaries = new BridgeGroupBoundaryRegistry();

  /** D9(2026-11-01):剔除已关闭的僵尸会话 —— 否则按 deviceId 查找会命中死条目,
   *  改补偿/音量/重建全部落到死会话(240 实证:`reason=closed` 旧条目遮蔽在跑的那座桥,
   *  `bridgeRebuildDelay` 因此恒返回 false)。 */
  private pruneClosed(): void {
    for (const [token, s] of [...this.sessions]) {
      if (s.isClosedSession()) this.sessions.delete(token);
    }
  }

  list(): Array<ReturnType<BridgeSession["snapshot"]>> {
    this.pruneClosed();
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  has(deviceId: string): boolean {
    this.pruneClosed();
    for (const s of this.sessions.values()) if (s.deviceId === deviceId) return true;
    return false;
  }

  /** 按 deviceId 下发音量到桥会话(桥占用设备的 volume RPC 落点)。
   *  命中即下发并返回 true;未命中返回 false,调用方据此判定「桥上也没人接」。
   *  同一 deviceId 只可能有一座桥(`prepare` 会先拆同 deviceId 旧会话)。 */
  setVolumeDb(deviceId: string, db: number): boolean {
    this.pruneClosed();
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId) {
        s.setVolumeDb(db);
        return true;
      }
    }
    return false;
  }

  /** D6/P1:按 sessionToken 标记「用户手动 next/prev」;未知 token 幂等忽略。 */
  markManual(token: string): void {
    this.sessions.get(token)?.markManual();
  }

  /** [验收10/debug-only] 按 deviceId 注入一次传输死亡(复采用;见 BridgeSession.debugReconnect)。 */
  debugReconnect(deviceId: string, reason: string): boolean {
    this.pruneClosed();
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId) {
        s.debugReconnect(reason);
        return true;
      }
    }
    return false;
  }

  /** [验收10/debug-only] 按 deviceId 注入一次恢复成功(复采用;见 BridgeSession.debugMarkRecovery)。 */
  debugMarkRecovery(deviceId: string): boolean {
    this.pruneClosed();
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId) {
        s.debugMarkRecovery();
        return true;
      }
    }
    return false;
  }

  /** D6(2026-11-01):按 deviceId **运行中改成员补偿**(命中即更新并平移设备侧映射)。
   *  @returns true = 设备有桥会话且已接受;false = 无会话(调用方按重建/加入兜底)。 */

  setAnchorShift(deviceId: string, shiftUs: number): boolean {
    this.pruneClosed();
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId) return s.applyAnchorShift(shiftUs);
    }
    return false;
  }

  /** D9(2026-11-01):按 deviceId **必生效**改补偿 —— 重建该成员的 RTSP 会话
   *  (设备重新吃一次映射;代价重建窗口 ~1~2s 静音)。
   *  @returns true = 命中会话并已重建/已入 opts;false = 该设备当前无桥会话。 */
  async rebuildForShift(deviceId: string, shiftUs: number, reason = "delay-change"): Promise<boolean> {
    this.pruneClosed();
    for (const s of this.sessions.values()) {
      if (s.deviceId !== deviceId) continue;
      if (await s.rebuildForShift(shiftUs, reason)) return true;
    }
    return false;
  }

  /** [组A/N3] 按 deviceId 轻量重启内容管线(自愈分级第二级,清管线不拆 socket)。
   *  @returns true = 命中会话并已重启;false = 该设备当前无桥会话。 */
  lightRestart(deviceId: string, reason: string): boolean {
    this.pruneClosed();
    for (const s of this.sessions.values()) {
      if (s.deviceId !== deviceId) continue;
      return s.lightRestart(reason);
    }
    return false;
  }

  /** B(2026-11-20)：按 deviceId 重建空壳会话（设备上线时调用）。
   *  @returns true = 命中且已调度重建。 */
  reanchorUnanchored(deviceId: string, graceMs: number, reason: string): boolean {
    this.pruneClosed();
    for (const s of this.sessions.values()) {
      if (s.deviceId !== deviceId) continue;
      if (s.reanchorIfUnanchored(graceMs, reason)) return true;
    }
    return false;
  }

  /** 起一座桥会话(同 deviceId 旧会话先拆 = 新流语义;同 token 暖复用除外)。 */
  async prepare(opts: BridgeSessionOpts): Promise<{ listening: true; socketPath: string }> {
    // 暖复用(B 方案,对齐 MA sendspin_bridge._can_reuse_stream_warm):同 token + 同
    // 设备 + 同协议 + 同 RAOP 目标 + 会话健康 ⇒ 原样续用 —— RAOP 握手/设备缓冲零重来,
    // 新曲内容由组泵 BOUNDARY(track) 驱动重锚(与 seek 同路径,bridgeAttach.syncGroupBridges
    // 热复用句柄)。token 由主进程 protocolPlayer 的路由复用保证「复用 = 同 token」;
    // token 变 = 上游判定冷启(成员/协议变化),走下方拆旧建新。
    const prev = this.sessions.get(opts.token);
    this.pruneClosed();
    if (
      prev && !prev.isClosedSession() && prev.deviceId === opts.deviceId
      && prev.opts.protocol === opts.protocol
      && prev.opts.host === opts.host && prev.opts.port === opts.port
      && prev.warmReusable
    ) {
      // D6(2026-11-01):暖复用必须把**可变标定**刷进现有会话 —— 否则 `PUT /groups/:id/delays`
      // 的重建请求会在这里静默丢弃新值(240 实测:两次 PUT 后 anchor 仍是旧 shift)。
      prev.applyAnchorShift(opts.anchorShiftUs ?? 0);
      // D8(2026-11-01):旧会话内容轴已被本地跳段污染(skippedFrames>0)⇒ 暖复用必须重锚。
      // 否则 `bridgeSkipFrames` 平移过的 startTs 会跟着会话带进新代次 —— 240 实测该偏移
      // 跨换歌粘住(2.95s 分裂),且 tick 一直报旧 anchorUs。
      if (bridgeSyncGroupTimelineEnabled() && prev.isContentAxisPoisoned()) {
        prev.resetTimeline("warm-reuse-poisoned");
      }
      log.info(`[airplay-bridge] sessions: prepare warm-reuse deviceId=${opts.deviceId} token=${opts.token} gen=${prev.snapshot().generation} shiftUs=${opts.anchorShiftUs ?? 0}`);
      return { listening: true, socketPath: prev.listeningOn ?? opts.socketPath };
    }
    if (prev && !prev.isClosedSession() && prev.deviceId === opts.deviceId) {
      // 走到这里 = 同 token 同设备却不可暖复用。最常见原因就是空壳（设备离线时建出、
      // 从未锚定）—— 必须让它可见，否则现场看起来只是"每次换代都重建"，查不出为什么。
      const snap = prev.snapshot();
      log.warn(`[airplay-bridge] sessions: warm-reuse 拒绝 deviceId=${opts.deviceId} token=${opts.token} gen=${snap.generation} anchored=${snap.anchorUs !== null} ageMs=${Date.now() - prev.createdAtMsForLog()} → 拆旧建新`);
    }
    for (const [, s] of [...this.sessions]) {
      if (s.deviceId === opts.deviceId) {
        this.sessions.delete(s.token);
        await s.stop().catch(() => {});
      }
    }
    const session = new BridgeSession(opts, this.groupAnchors, this.groupBoundaries);
    await session.start();
    this.sessions.set(opts.token, session);
    log.info(`[airplay-bridge] sessions: prepare deviceId=${opts.deviceId} token=${opts.token} sessions=${this.sessions.size}`);
    return { listening: true, socketPath: session.listeningOn ?? opts.socketPath };
  }

  async stop(token: string): Promise<void> {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    log.info(`[airplay-bridge] sessions: stop token=${token} sessions=${this.sessions.size}`);
    await s.stop().catch(() => {});
  }

  async stopAll(): Promise<void> {
    for (const [token, s] of [...this.sessions]) {
      this.sessions.delete(token);
      await s.stop().catch(() => {});
    }
  }
}

// 供编排侧(主进程)复用的纯函数重导出:socket 路径计算必须同一处实现。
export { bridgeSocketPath };
