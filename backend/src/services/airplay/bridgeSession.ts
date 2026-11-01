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
  bridgeSyncGroupTimelineEnabled,
  type BridgeProtocol,
} from "./rates.js";
import { computeBridgeBackoffMs } from "./bridgeSource.js";
import { PolyphaseResampler, floatToPcmS16, pcmS16ToFloat } from "./resampler.js";
import { audibleAtUs, computeBridgeAnchors, driftCorrection, groupDelayUs, type BridgeAnchors } from "./bridgeMath.js";
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
    const leadUs = wantLeadUs > floorLeadUs ? wantLeadUs : floorLeadUs;
    // D7:同组同 gen 复用已发布锚点 ⇒ 各成员的内容零点/送包节拍完全同源。
    anchorUs = opts.groupAnchorUs ?? opts.nowUs + leadUs;
  } else if (anchorUs - lUs - safetyUs < opts.nowUs) {
    const floorUs = opts.nowUs + warmUs;
    if (floorUs > anchorUs) {
      anchorUs = floorUs;
      reAnchored = true;
    }
  }
  // 旧模式:补偿进锚点(改造前逐字节行为;对齐器零点/节拍基准都含 shift)
  if (!sync) anchorUs += shiftUs;
  // 映射锚点输入 = 组锚点 + 成员补偿(A′ = 该值 + 重采样群延迟,computeBridgeAnchors 内)
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
  private readonly byKey = new Map<string, { anchorUs: bigint; atMs: number }>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxEntries = 32,
  ) {}

  /** 取同组同 gen 的共享锚点;无 / 过期 / 对本设备已不可达 ⇒ null(调用方自行规划并发布)。 */
  peek(groupKey: string, gen: number, nowHostUs: bigint, floorLeadUs: bigint): bigint | null {
    const k = `${groupKey}#${gen}`;
    const e = this.byKey.get(k);
    if (!e) return null;
    if (Date.now() - e.atMs > this.ttlMs) {
      this.byKey.delete(k);
      return null;
    }
    if (e.anchorUs + BigInt(GROUP_ANCHOR_LATE_TOLERANCE_US) < nowHostUs + floorLeadUs) return null;
    return e.anchorUs;
  }

  /** 发布锚点(同 key 已有则保留先发布者 = 首个规划者的组时间线零点)。 */
  publish(groupKey: string, gen: number, anchorUs: bigint): void {
    const k = `${groupKey}#${gen}`;
    if (this.byKey.has(k)) return;
    this.byKey.set(k, { anchorUs, atMs: Date.now() });
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
  /** 群组同内容同步(D1–D5)开关快照:会话建立时读一次,热路径不查 env。 */
  private readonly groupTimelineSync = bridgeSyncGroupTimelineEnabled();
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
  /** A(垫片窗静音续流):token 递增令在跑 filler 退出;promise 供新流首包前收尾。 */
  private gapFillerToken = 0;
  private gapFillerPromise: Promise<number> | null = null;
  /** B(消费停滞看门狗):重连进行中防重入。 */
  private livenessReconnectInFlight = false;
  /** 心跳看门狗触发历史已上提为**设备级**(见 livenessBreakerState)——
   *  挂在 session 上会随每次触发重建而清零,熔断永远攒不满。 */
  /** 上一次看门狗触发时刻 player.timingCount 的快照(判「这次重连救回来没有」)。 */
  private timingCountAtFire = 0;
  /** 「本代次已打过『设备从不发 timing,看门狗豁免』日志」的代次号(防 2s tick 刷屏)。 */
  private livenessNoTimingLoggedGen = "";
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
  /** D6/P1:`bridgeManual` RPC 落点 —— 只置 sticky 标记,不立即 FLUSH。
   *  真正的「1 次 FLUSH + ts 回拨」在下一个 track boundary 到达时执行,
   *  避免与正在跑的推流节拍/重传路径抢 socket。 */
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
  private onBoundary(generation: number, reason: string): void {
    if (this.closed) return;
    this.lastBoundaryReason = reason;
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
    // D8(2026-11-01):边界处置必须**组级统一**。各成员看到的 reason 可能不同
    // (A=stop / B=track),本地判定会让一台清队列、另一台保留 → 同代次内容起点不唯一
    // (cap6 实测分裂 2.7~2.95s 且跨换歌粘住)。规则:clear 优先(任一成员要清 ⇒ 全组清)。
    const groupKey = this.opts.groupKey;
    let keepQueue = localKeep;
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
      this.firstFrameTsUs = null;
      this.aligner = null;
      this.anchors = null;
      this.anchorUs = null;
      this.commandedLeadUs = null;
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
    if (reason === "track" && !manual) {
      // 自动换歌(D6/P1)= 同一时间线「纯内容替换」:不 FLUSH、不 RECORD、不重锚。
      // 关键:保留 aligner / anchors / firstFrameTsUs,且**不 abort 推流循环** ——
      // 旧 streamBridge 继续消费新代次帧,seq/ts 自然连续(+352/包)。
      // S2:旧曲余料**保留**(上面 keepQueue 分支),新代次帧按 ts 接在其后;
      // 只有关掉 MF_BRIDGE_TRACK_KEEP_QUEUE 时才在此前出清队列。
      void this.stopGapFiller();
      return;
    }
    // 以下为「换代重启」:seek / rehost / 用户手动 next-prev(track+manual)。
    this.firstFrameTsUs = null;
    this.aligner = null;
    this.anchors = null;
    this.anchorUs = null;
    this.commandedLeadUs = null;
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
    // D7(2026-11-01):同组同 gen **共享锚点** —— 首个规划者发布,其余成员复用,
    // 保证各成员的「内容零点 = 对齐器 target 基准」与「送包节拍基准」逐 µs 同源。
    // 只在 forceNow(now 锚)且带 groupKey 时启用;AP2 出口不吃 now 锚(forceNow=false)。
    const useSharedAnchor =
      this.ap2Session === null && raopNowAnchorEnabled()
      && bridgeSyncGroupTimelineEnabled() && !!this.opts.groupKey && !!this.groupAnchors;
    const nowHostUs = nowUs();
    const floorLeadUs = BigInt(Math.round((latencyFrames / rate) * 1e6)) + BigInt(RAOP_SAFETY_MS * 1000);
    const sharedAnchorUs = useSharedAnchor
      ? this.groupAnchors!.peek(this.opts.groupKey!, this.generation, nowHostUs, floorLeadUs)
      : null;
    const plan = planBridgeAnchor({
      firstFrameTsUs: this.firstFrameTsUs,
      latencyFrames,
      rate,
      resampled: this.resampler !== null,
      nowUs: nowHostUs,
      anchorShiftUs: this.opts.anchorShiftUs ?? 0,
      forceNow: this.ap2Session === null && raopNowAnchorEnabled(),
      groupAnchorUs: sharedAnchorUs ?? undefined,
    });
    if (useSharedAnchor) {
      if (sharedAnchorUs !== null) {
        log.info(`[airplay-bridge] group-anchor reuse: device=${this.deviceId} gen=${this.generation} anchorUs=${sharedAnchorUs}(leadUs=${sharedAnchorUs - nowHostUs})`);
      } else {
        this.groupAnchors!.publish(this.opts.groupKey!, this.generation, plan.anchorUs);
        log.info(`[airplay-bridge] group-anchor publish: device=${this.deviceId} gen=${this.generation} anchorUs=${plan.anchorUs}(leadUs=${plan.commandedLeadUs})`);
      }
    }
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
    // D6/P1:手动 next/prev 的一次性 ts 回拨需求(在 onBoundary 里登记)。
    // 只有 RaopPlayer 知道 lastSentTs,所以回拨在 streamBridge 内落地;
    // 过期(>10s)视为无效 —— 绝不把旧需求套到晚得多的新流上。
    const rewindFrames =
      this.pendingRewindFrames > 0 && Date.now() - this.pendingRewindAt <= BRIDGE_MANUAL_REWIND_TTL_MS
        ? this.pendingRewindFrames
        : 0;
    this.pendingRewindFrames = 0;
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
    // 无心跳设备豁免(判据见 livenessWatchdogShouldFire 的 hasTimingHeartbeat):设备
    // 结构上从不发 timing 时,quiet 恒超阈值 —— 必须整段跳过,否则每次 TEARDOWN 都把
    // 组时间线推后 6~7s(重锚 skip),健康流被切成一跳一跳的哑音。
    const livenessHasHeartbeat = this.player !== null && this.player.timingCount > 0;
    if (
      !livenessHasHeartbeat &&
      this.aligner !== null &&
      livenessQuietMs > livenessThresholdMs &&
      this.livenessNoTimingLoggedGen !== String(this.generation)
    ) {
      this.livenessNoTimingLoggedGen = String(this.generation);
      log.info(`[airplay-bridge] liveness watchdog 豁免: device=${this.deviceId} gen=${this.generation} 本会话从未收到 timing 请求(${Math.round(livenessQuietMs / 1000)}s 静默)⇒ 判据不适用,不触发 TEARDOWN`);
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
      const act = aligner.onFrame(entry.tsUs);
      if (act.insertFrames > 0) {
        // 内容落后(有洞)⇒ 补静音(占据真实时间线)。D8:组同步模式不设上限(长缺口也补,
        // 绝不跳段 —— 跳段会把本成员 RTP 内容轴前移,永久错位)。
        this.appendOut(Buffer.alloc(act.insertFrames * 4));
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

  /** D9(2026-11-01):改补偿的**必生效**兜底 —— 重建本设备侧 RTSP 会话
   *  (TEARDOWN → 新 ANNOUNCE/SETUP/RECORD),让设备**重新吃一次** RTP↔NTP 映射。
   *
   *  为什么必须有这条:SYNC 是单向的、无回执,且实测 GGMM 这类接收端只在 RECORD
   *  时吃映射、运行中改 SYNC 不一定采纳 ⇒ 仅 `retimeByUs`(D6)无法保证出声时刻真的变。
   *  内容轴不受影响(可听时间 = 内容 ts;锚点仍走 D7/D8 的组规则),代价 = 重建窗口
   *  (~1~2s)静音 —— 这是用户明确接受的兜底代价。
   *
   *  @returns true = 已接受(流在跑时已完成重建;未起流/AP2 时值已进 opts,
   *  下一次起流或主进程路由重建自然生效);false = 会话已关闭。 */
  async rebuildForShift(shiftUs: number, reason = "delay-change"): Promise<boolean> {
    if (this.closed) return false;
    // AP2 无 RTP 时间线:opts 已更新,只能靠主进程重建桥路由(调用方兜底)。
    if (this.ap2Session !== null) {
      this.applyAnchorShift(shiftUs);
      return false;
    }
    if (!this.applyAnchorShift(shiftUs)) return false;
    // 流未在跑(起流判定前/已中止)⇒ 新值已进 opts,起流时天然生效,不必拆会话。
    if (!this.player || this.aligner === null || this.streamAborted) {
      log.info(`[airplay-bridge] ${JSON.stringify({
        ev: "rebuild-deferred", dev: this.deviceId, gen: this.generation,
        shiftUs, reason,
      })}`);
      return true;
    }
    log.info(`[airplay-bridge] ${JSON.stringify({
      ev: "rebuild-shift", dev: this.deviceId, gen: this.generation,
      shiftUs, reason,
    })}`);
    // 立刻重建(不走退避):清掉可能挂着的重连定时器,复用现成的
    // 「TEARDOWN 旧会话 → 新 RECORD → 等新帧重锚」流程。
    if (this.raopReconnectTimer) {
      clearTimeout(this.raopReconnectTimer);
      this.raopReconnectTimer = null;
    }
    await this.reconnectRaop();
    return true;
  }

  /** D9(2026-11-01):会话是否已关闭 —— manager 据此**跳过僵尸会话**。
   *  240 实证:同 deviceId 可能残留一条 `reason=closed` 的旧条目(泵断连后未从表里摘除),
   *  按 deviceId 查找时它会**遮蔽**真正在跑的那座桥 ⇒ 改补偿/音量全部落到死会话上。 */
  isClosedSession(): boolean {
    return this.closed;
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
