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

import { BridgeServer, type BridgeAudioEvent, type BridgeServerHandlers } from "./bridgeServer.js";
import { bridgeSocketPath } from "./bridgeChannel.js";
import {
  AP2_DEFAULT_LATENCY_FRAMES,
  AP2_EFFECTIVE_LATENCY_FRAMES,
  AP2_LATE_SKIP_US,
  AP2_WAIT_SLICE_MS,
  BRIDGE_MAX_HELD_AUDIO_US,
  BRIDGE_PCM_BYTES_PER_SEC,
  BRIDGE_RESUME_REBASE_US,
  BRIDGE_WARM_START_LEAD_US,
  PROTOCOL_CAPS,
  RAOP_SAFETY_MS,
  SENDSPIN_RATE,
  type BridgeProtocol,
} from "./rates.js";
import { computeBridgeBackoffMs } from "./bridgeSource.js";
import { PolyphaseResampler, floatToPcmS16, pcmS16ToFloat } from "./resampler.js";
import { audibleAtUs, computeBridgeAnchors, driftCorrection, type BridgeAnchors } from "./bridgeMath.js";
import { nowUs } from "../../utils/hostClock.js";
import { RaopPlayer, CHUNK_LEN, raopBridgeConnectPrimeEnabled, type BridgeStreamEndReason, type RaopSession } from "./raop.js";
import { getAirPlayVolumeState, DEFAULT_AIRPLAY_VOLUME } from "./deviceState.js";
import { degreesToDb } from "./decoder.js";
import { AP2_SEND_ERROR_LIMIT, Ap2StreamSession, type Ap2StreamOptions, type Ap2StreamState } from "./ap2/ap2Stream.js";
import { createLogger } from "../../utils/logger.js";

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
    // 无组上下文(undefined)回落 airplay_device_state 设备落库值(旧行为)。
    if (typeof groupVolume === "number") {
      const gdb = groupVolume === 0 ? -144 : degreesToDb(groupVolume);
      player.setVolumeDb(gdb);
      log.info(`push initial volume: ${gdb.toFixed(2)}dB (groupVol=${groupVolume}%) device=${deviceId}`);
      return;
    }
    const saved = getAirPlayVolumeState(deviceId);
    const vol = saved?.volume ?? DEFAULT_AIRPLAY_VOLUME;
    const db = saved?.muted || vol === 0 ? -144 : degreesToDb(vol);
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
  /** 落定的 A(可达 = 首帧 tsUs;不可达 = max(now + warmLead, 首帧 tsUs))。 */
  anchorUs: bigint;
  /** 四字段锚点(computeBridgeAnchors 产出,baseTs/startTs/headTs/startNtp/A′)。 */
  anchors: BridgeAnchors;
  /** 是否触发了可达性重锚(A − L − SAFETY < now)。 */
  reAnchored: boolean;
  /** E2 实验:now 锚(MF_BRIDGE_RAOP_NOW_ANCHOR)生效 —— anchorUs = now(+shift)。 */
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

/** 看门狗阈值 ms(MF_BRIDGE_RAOP_LIVENESS_MS,缺省 15000,下限 5000)。 */
export function raopBridgeLivenessMs(): number {
  const v = Number(process.env.MF_BRIDGE_RAOP_LIVENESS_MS);
  // 判据 = timing 心跳。缺省 **15s** 而不是 v4.10.0 的 45s(2026-10-30 实测改)：
  //   240 全量 pcap 里 HiVi 上行 NTP 共 4611 包 / 9 个会话 / ≈4.1 小时播放,
  //   **会话内最大间隔只有 6.0 秒**(直方图 0.5-5s:4583、5-10s:3、>10s:0),
  //   即健康期铁定 20 次/分钟、绝不抖到 10s 以上 ⇒ 15s = 自然上限的 2.5 倍仍有富余。
  //   而 45s 会把每次"接收端僵死"的失声拉长到 45s 以上:实测一次事件的纯断音是
  //   14s,其中 45s 全耗在"等判据",用户听感就是"失声一分钟"。
  // env 下限放到 5s(排障用);低于 5s 视为误配,回落缺省。
  return Number.isFinite(v) && v >= 5000 ? v : 15000;
}

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
}): boolean {
  if (!opts.enabled) return false;
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
  /** A/V 标定位移(µs,正 = 内容落点整体后移 = 桥延后)。缺省 0(历史行为)。 */
  anchorShiftUs?: number;
  /** E2 实验:forceNow = now 锚(anchorUs = now(+shift)),首包即发;
   *  泵 lead 段相对组时间线提前播,对齐器以首帧 tsUs 为零点(见 maybeBeginStream)。 */
  forceNow?: boolean;
}): BridgeAnchorPlan {
  let anchorUs = opts.firstFrameTsUs + BigInt(opts.anchorShiftUs ?? 0);
  const warmUs = BigInt(opts.warmLeadUs ?? BRIDGE_WARM_START_LEAD_US);
  const lUs = BigInt(Math.round((opts.latencyFrames / opts.rate) * 1e6));
  const safetyUs = BigInt(RAOP_SAFETY_MS * 1000);
  let reAnchored = false;
  if (opts.forceNow === true) {
    // E2 实验(MF_BRIDGE_RAOP_NOW_ANCHOR,缺省 ON):now 锚 —— anchorUs = now(+shift)。
    // 背景(2026-10-28 240 实证):MUZO 类固件只支持「到包即播」语义,对
    // 「SYNC 未来锚 2.3s + 首包延迟 1.25s」的桥会话永不开始渲染(solo 旧墙钟
    // 路径 now 锚可出声)。now 锚下首包立即发;泵 lead 段相对组时间线提前播;
    // 对齐器以首帧 tsUs 为零点(见 maybeBeginStream)保持内容连续 —— 绝不触发
    // skip 跳段时间线(skip 会把 RTP 重新标回未来,等于没修)。
    // exp2:+ raopNowAnchorOffsetUs()(缺省 400ms)—— 设备抖动缓冲深度;
    // 对齐器零点仍取首帧 tsUs(见 maybeBeginStream),lead≈offset ≪ 2s 补静音上限。
    // exp6(2026-10-29):offset 下限钳到 lUs+safetyUs —— sendAt(0) 绝不能落到过去,
    // 否则首包即欠账且该欠账够不着 rebase 阈值,整首歌带着欠账跑(见函数头注释)。
    // env 仍可上调(想要更深缓冲时);下调被拒绝,逃生门是关掉 forceNow 本身。
    const wantLeadUs = raopNowAnchorOffsetUs();
    const floorLeadUs = lUs + safetyUs;
    const leadUs = wantLeadUs > floorLeadUs ? wantLeadUs : floorLeadUs;
    anchorUs = opts.nowUs + BigInt(opts.anchorShiftUs ?? 0) + leadUs;
  } else if (anchorUs - lUs - safetyUs < opts.nowUs) {
    const floorUs = opts.nowUs + warmUs;
    if (floorUs > anchorUs) {
      anchorUs = floorUs;
      reAnchored = true;
    }
  }
  const anchors = computeBridgeAnchors({
    anchorUs,
    latencyFrames: opts.latencyFrames,
    rate: opts.rate,
    chunkLen: CHUNK_LEN,
    compensateGroupDelay: opts.resampled,
  });
  return { anchorUs, anchors, reAnchored, commandedLeadUs: anchorUs - opts.nowUs, forceNow: opts.forceNow === true };
}

// ---------------------------------------------------------------------------
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
  const rebaseUs = deps.rebaseUs ?? BRIDGE_RESUME_REBASE_US;
  const errorLimit = deps.sendErrorLimit ?? AP2_SEND_ERROR_LIMIT;
  // L_eff(帧) → µs 用同一份换算函数(audibleAtUs(0 锚点) = 纯帧→µs)。
  const lEffUs = audibleAtUs(deps.lEffFrames, 0n, deps.rate);
  let idx = 0;
  let chunks = 0;
  let lateSkipped = 0;
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
   *  undefined = 无组上下文,pushInitialVolume 回落设备落库值(旧行为)。 */
  initialVolume?: number;
  /** v4.9.4-exp4:同 host DLNA renderer id(主进程判定后下发;子进程注册表恒空,
   *  不可自查)。初始 SET_PARAMETER volume 的 Linkplay 豁免依据。 */
  sameHostDlnaPeer?: string;
  /** producer 等料超时(ms),超时补静音块。默认 1000。 */
  waitDataMs?: number;
  /** stats tick 周期(ms,§10.5 每设备一行 JSON)。默认 2000;≤0 关闭。 */
  statsIntervalMs?: number;
}

export interface BridgeSessionStats {
  framesIn: number;
  chunksOut: number;
  silenceChunks: number;
  /** §4.5 补静音帧数(内容落后/有洞)。 */
  insertedFrames: number;
  /** §4.5 裁头帧数(内容超前/重叠 + 欠料跳段出清)。 */
  droppedFrames: number;
  /** 欠料超上限直接跳段时间线的内容帧数(不物化静音)。 */
  skippedFrames: number;
  /** |drift| > 1ms 的对齐次数(§4.5 realigned)。 */
  realignments: number;
  /** 旧 generation 帧/队列丢弃计数(Phase 5 BLK-02 判据:seek/rehost 后 > 0)。 */
  staleFramesDropped: number;
}

export class BridgeSession {
  readonly deviceId: string;
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
  private inBytes = 0;
  /** 输出速率 s16le 出缓冲(producer 逐 352 帧切割)。 */
  private outBuf: Buffer = Buffer.alloc(0);
  /** producer 预填充已完成 —— 预填充只在首块做一次(不是每块都做)。 */
  private prefillDone = false;
  readonly stats: BridgeSessionStats = {
    framesIn: 0, chunksOut: 0, silenceChunks: 0,
    insertedFrames: 0, droppedFrames: 0, skippedFrames: 0, realignments: 0,
    staleFramesDropped: 0,
  };
  private streamPromise: Promise<void> | null = null;

  // ---- Phase 4:锚点与对齐状态 ----
  private connected = false;
  /** 首帧有效 AUDIO 的 tsUs(A 候选;§7.2:锚点只在此刻确定)。 */
  private firstFrameTsUs: bigint | null = null;
  /** 锚点已落定(aligner 非 null ⇒ 已进入四锚点驱动)。 */
  private aligner: BridgeTimelineAligner | null = null;
  private anchors: BridgeAnchors | null = null;
  private anchorUs: bigint | null = null;
  private commandedLeadUs: bigint | null = null;
  /** E3:锚点落定时刻的 chunksOut 快照(tick deltaUs 用增量)。 */
  private chunksOutAtPlan = 0;
  private generation = 0;
  private maxQueueMs = 0;
  private deltaSamples: number[] = [];
  private statsTimer: NodeJS.Timeout | null = null;

  // ---- Phase 5:生命周期(代次重锚 / 暂停 / stall / RAOP 重连) ----
  /** 推流被终态打断(boundary/stall):producer 立刻返回 null,旧 streamBridge 循环退出。 */
  private streamAborted = false;
  /** A(垫片窗静音续流):token 递增令在跑 filler 退出;promise 供新流首包前收尾。 */
  private gapFillerToken = 0;
  private gapFillerPromise: Promise<number> | null = null;
  /** B(消费停滞看门狗):重连进行中防重入。 */
  private livenessReconnectInFlight = false;
  /** 心跳看门狗触发历史已上提为**设备级**(见 livenessBreakerState)——
   *  挂在 session 上会随每次触发重建而清零,熔断永远攒不满。 */
  /** 上一次看门狗触发时刻 player.timingCount 的快照(判「这次重连救回来没有」)。 */
  private timingCountAtFire = 0;
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

  constructor(opts: BridgeSessionOpts) {
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
    return !this.closed && this.ap2LinkLoss === null && this.ap2Session?.currentState !== "error";
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
      onStall: () => this.onLinkStall(),
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
    pushInitialVolume(player, this.opts.deviceId, this.opts.initialVolume, this.opts.sameHostDlnaPeer);
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

  /** AP2 初始音量(dB,0-100 标尺 → -30..0dB,静音 → -144):与 RAOP 同源(库值,失败回退 80)。 */
  private ap2InitialVolumeDb(): number {
    try {
      const saved = getAirPlayVolumeState(this.deviceId);
      const vol = saved?.volume ?? DEFAULT_AIRPLAY_VOLUME;
      return saved?.muted || vol === 0 ? -144 : degreesToDb(vol);
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
  private ingestAudio(a: BridgeAudioEvent): number {
    if (this.closed) return this.backlogMs();
    if (a.tsUs !== 0n && a.generation !== 0 && a.generation < this.generation) {
      this.stats.staleFramesDropped += a.payload.byteLength >> 2;
      return this.backlogMs();
    }
    if (a.tsUs !== 0n && a.generation !== 0) this.generation = a.generation;
    const buf = Buffer.from(a.payload.buffer, a.payload.byteOffset, a.payload.byteLength);
    if (this.firstFrameTsUs === null && a.tsUs !== 0n) {
      this.firstFrameTsUs = a.tsUs;
      void this.maybeBeginStream();
    }
    this.inQueue.push({ buf, tsUs: a.tsUs, generation: a.generation });
    this.inBytes += buf.length;
    this.stats.framesIn += buf.length >> 2;
    return this.backlogMs();
  }

  private backlogMs(): number {
    return Math.round((this.inBytes / BRIDGE_PCM_BYTES_PER_SEC) * 1000);
  }

  // ---- Phase 5:生命周期(§5.2/§5.4) ------------------------------------

  /** 流代次变更(BOUNDARY,§4.3/§5.4):
   *  - track/seek/rehost:清旧代次队列 + 计入 staleFramesDropped + 重锚 —— 新代次
   *    首帧确立新 A ⇒ 新 scheduledAnchorUs(可 grep `ev:"gen"` + `ev:"anchor"`);
   *  - stop:流终态(跨源切歌/组停),停推流;RAOP 会话由编排侧 bridgeStop 拆。 */
  private onBoundary(generation: number, reason: string): void {
    if (this.closed) return;
    log.info(`[airplay-bridge] ${JSON.stringify({ ev: "gen", dev: this.deviceId, gen: generation >>> 0, prevGen: this.generation, reason })}`);
    // 清旧代次:入队未消费 + 出缓冲未切割的全部计入丢弃。
    const stale = (this.inBytes >> 2) + (this.outBuf.length >> 2);
    this.inQueue = [];
    this.inBytes = 0;
    this.outBuf = Buffer.alloc(0);
    if (stale > 0) this.stats.staleFramesDropped += stale;
    if (stale > 0) log.info(`[airplay-bridge] ${JSON.stringify({ ev: "stale", dev: this.deviceId, gen: generation >>> 0, reason, staleFrames: stale, totalStaleFrames: this.stats.staleFramesDropped })}`);
    this.generation = generation >>> 0;
    this.firstFrameTsUs = null;
    this.aligner = null;
    this.anchors = null;
    this.anchorUs = null;
    this.commandedLeadUs = null;
    if (reason === "stop") {
      // 终态:停推流(保留 listener 与 RAOP 会话;编排侧 bridgeStop 负责拆会话)。
      this.streamAborted = true;
      this.player?.flush();
      return;
    }
    // track/seek/rehost:热复用 RAOP 会话,推流循环立刻退出,新代次首帧重新起流
    // (player.flush 置 started=false ⇒ 新流首包带 0xE0 marker,接收端重锚)。
    this.streamAborted = true;
    this.player?.flush();
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
  /** §4.4 接收侧积压超上限(服务端已决定销毁该 session):把积压一并丢弃。
   *
   *  为什么必须丢(2026-10-30 240 实证):积压之所以能长到 8s,是因为**没有消费者**
   *  (看门狗重连窗口内 aligner=null)。这些 PCM 对时间线早已过期 —— 留着只会在发送侧
   *  重连(&rehost)后被当成正常内容消费,表现为 `ev=stale staleFrames=385200`
   *  (≈8.7s 内容一次性废弃)且旧会话 Socket 生命周期被拉长。丢弃是显式的、有界的。 */
  private onReceiveOverflow(ms: number): void {
    const dropped = this.inBytes;
    this.inQueue = [];
    this.inBytes = 0;
    this.outBuf = Buffer.alloc(0);
    log.warn(`[airplay-bridge] ${JSON.stringify({
      ev: "recv-overflow",
      dev: this.deviceId,
      gen: this.generation,
      backlogMs: Math.round(ms),
      droppedBytes: dropped,
      droppedMs: Math.round((dropped / BRIDGE_PCM_BYTES_PER_SEC) * 1000),
    })}`);
  }

  private onLinkStall(): void {
    if (this.closed || !this.aligner) return;
    log.warn(`[airplay-bridge] link stall: device=${this.deviceId} 停推流,等待发送侧重连(无残留播放)`);
    this.streamAborted = true;
    this.player?.flush();
    this.aligner = null;
    this.anchors = null;
    this.anchorUs = null;
    this.commandedLeadUs = null;
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
    const rate = this.outRate;
    // L = RECORD 协商的接收端缓冲深度(不得归零,§3.3);锚点公式与 SYNC 用同一值。
    const raopLatency = player ? Math.max(1, player.negotiatedLatencyFrames) : 1;
    // AP2 realtime:L 的等价物 = 我方在 SETUP 里声明的 latencyMin(接收端抖动缓冲深度)。
    // 两条出口各取自己的 L,但**共用同一个 planBridgeAnchor**(锚点只落一次)。
    const latencyFrames = this.ap2Session !== null ? this.ap2DeclaredLatencyFrames : raopLatency;
    const plan = planBridgeAnchor({
      firstFrameTsUs: this.firstFrameTsUs,
      latencyFrames,
      rate,
      resampled: this.resampler !== null,
      nowUs: nowUs(),
      anchorShiftUs: this.opts.anchorShiftUs ?? 0,
      forceNow: this.ap2Session === null && raopNowAnchorEnabled(),
    });
    if (plan.reAnchored) {
      log.warn(`[airplay-bridge] anchor unreachable: device=${this.deviceId} commanded=${this.firstFrameTsUs} now=${nowUs()} → re-anchor ${plan.anchorUs}(丢弃更早内容)`);
    }
    this.anchorUs = plan.anchorUs;
    this.commandedLeadUs = plan.commandedLeadUs;
    this.anchors = plan.anchors;
    // E3:锚点落定时刻的 chunksOut 快照 —— tick deltaUs 用本次 plan 起的增量,
    // 修 warm-reuse 会话跨 gen 累积导致的恒偏谬值(240 实证 35.68s)。
    this.chunksOutAtPlan = this.stats.chunksOut;
    if (plan.forceNow) {
      log.warn(`[airplay-bridge] forceNow anchor (MF_BRIDGE_RAOP_NOW_ANCHOR): device=${this.deviceId} anchorUs=now+${Number(raopNowAnchorOffsetUs())}µs 首包即发(E2/exp2,组 lead 内容按偏移提前播)`);
    }
    // forceNow:对齐器零点取首帧 tsUs(内容序)而非 plan.anchorUs(=now)——
    // 否则泵 lead 段 target−pos ≈ +2.3s > 2s 补静音上限 ⇒ 走 skip 跳段时间线,
    // startTs 前移把 RTP 重新标回未来,now 锚失效。
    this.aligner = new BridgeTimelineAligner(plan.forceNow && this.firstFrameTsUs !== null ? this.firstFrameTsUs : plan.anchorUs, rate);
    this.streamAborted = false;
    this.emitAnchorReport(plan, latencyFrames);
    // ---- 双出口(Phase 6b · T03):同一个 plan.anchorUs,只是出口不同 ----
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
    this.streamPromise = player
      .streamBridge(() => this.pullChunk(), session, {
        baseTs: plan.anchors.baseTs,
        startTs: plan.anchors.startTs,
        headTs: plan.anchors.headTs,
        startNtp: plan.anchors.startNtp,
        anchorUsShifted: plan.anchors.anchorUsShifted,
        anchorUs: plan.anchorUs,
        latencyFrames,
        rate,
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
   *   - 节拍只用 `plan.anchorUs`(唯一那次 planBridgeAnchor 的产物),**绝不另起时间线**;
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
      nowUs: () => nowUs(),
      sleepUs: (us) => this.ap2SleepUs(us),
      shouldStop: () => this.closed || this.streamAborted || this.ap2LinkLoss !== null,
      isPaused: () => this.pausedState,
      anchorUs: plan.anchorUs,
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
  private scheduleRaopReconnect(reason: string): void {
    if (this.closed || this.raopReconnectTimer) return;
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
        pushInitialVolume(player, this.deviceId, this.opts.initialVolume, this.opts.sameHostDlnaPeer);
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
      })
    ) {
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
      log.warn(`[airplay-bridge] liveness watchdog: device=${this.deviceId} gen=${this.generation} timing 心跳已停 ${(livenessQuietMs / 1000).toFixed(1)}s ≥ ${(livenessThresholdMs / 1000).toFixed(0)}s ⇒ 判会话未被接管/接收端僵死,先 TEARDOWN 旧会话再完整重握手(10min 内第 ${fired.firesInWindow} 次,连续未救回 ${fired.failedRun} 次)`);
      void this.reconnectRaop()
        .catch(() => { /* 重连失败已由 scheduleRaopReconnect 接管退避 */ })
        .finally(() => {
          this.livenessReconnectInFlight = false;
          // ★ v4.10.1 复核 C-2:重连完成必须同时重置 **quiet 基线**。
          //   新 player 在 `connect()` **之前**构造,而 connect 预算是 12s
          //  (raop.ts AIRPLAY_CONNECT_BUDGET_MS)⇒ 一次慢重连做完时 lastTimingAt 已经
          //   "12s 旧",15s 阈值下再过一个 2s tick 就会立刻二次判定 ⇒ TEARDOWN 刚建好的
          //   会话。45s 阈值时 12s 远小于阈值所以从不暴露,降到 15s 才成为真风险。
          //   这里只给"宽限窗",不代表设备活过来 —— 活体判据看 timingCount。
          if (this.player) {
            this.player.lastDeviceSignalAt = Date.now();
            this.player.lastTimingAt = Date.now();
          }
        });
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
      this.deltaSamples.push(deltaUs);
      if (this.deltaSamples.length > 25) this.deltaSamples.shift();
    }
    const sorted = [...this.deltaSamples].sort((a, b) => a - b);
    const p95 = sorted.length > 0
      ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))]
      : 0;
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
      driftUs: this.aligner?.lastDriftUs ?? 0,
      deltaUs,
      deltaP95Us: p95,
      samples: this.deltaSamples.length,
      anchorUs: this.anchorUs !== null ? Number(this.anchorUs) : null,
      leadUs: this.commandedLeadUs !== null ? Number(this.commandedLeadUs) : null,
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
      const act = aligner.onFrame(entry.tsUs);
      if (act.insertFrames > 0) {
        // 内容落后(有洞)⇒ 补静音(占据真实时间线)。
        this.appendOut(Buffer.alloc(act.insertFrames * 4));
        this.stats.insertedFrames += act.insertFrames;
      }
      if (act.dropFrames > 0) {
        // 内容超前(重叠)⇒ 裁头:从后续重采样输出中丢弃(takeDrop,追加流保持连续,
        // RTP 时间线自洽);baseTs/startTs 均不动。
        this.stats.droppedFrames += act.dropFrames;
      }
      if (act.skipFrames > 0) {
        // 长欠料:跳段(不物化静音),RTP 时间线同步前移。
        this.stats.skippedFrames += act.skipFrames;
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
    };
  }
}

/** 子进程侧桥会话表(按 sessionToken 索引;同 deviceId 新 prepare 拆旧)。 */
export class BridgeSessionManager {
  private readonly sessions = new Map<string, BridgeSession>();

  list(): Array<ReturnType<BridgeSession["snapshot"]>> {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  has(deviceId: string): boolean {
    for (const s of this.sessions.values()) if (s.deviceId === deviceId) return true;
    return false;
  }

  /** 按 deviceId 下发音量到桥会话(桥占用设备的 volume RPC 落点)。
   *  命中即下发并返回 true;未命中返回 false,调用方据此判定「桥上也没人接」。
   *  同一 deviceId 只可能有一座桥(`prepare` 会先拆同 deviceId 旧会话)。 */
  setVolumeDb(deviceId: string, db: number): boolean {
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId) {
        s.setVolumeDb(db);
        return true;
      }
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
    if (
      prev && prev.deviceId === opts.deviceId && prev.opts.protocol === opts.protocol
      && prev.opts.host === opts.host && prev.opts.port === opts.port
      && prev.warmReusable
    ) {
      log.info(`[airplay-bridge] sessions: prepare warm-reuse deviceId=${opts.deviceId} token=${opts.token} gen=${prev.snapshot().generation}`);
      return { listening: true, socketPath: prev.listeningOn ?? opts.socketPath };
    }
    for (const [, s] of [...this.sessions]) {
      if (s.deviceId === opts.deviceId) {
        this.sessions.delete(s.token);
        await s.stop().catch(() => {});
      }
    }
    const session = new BridgeSession(opts);
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
