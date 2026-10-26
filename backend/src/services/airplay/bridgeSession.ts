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
 */

import { BridgeServer, type BridgeAudioEvent, type BridgeServerHandlers } from "./bridgeServer.js";
import { bridgeSocketPath } from "./bridgeChannel.js";
import {
  BRIDGE_MAX_HELD_AUDIO_US,
  BRIDGE_PCM_BYTES_PER_SEC,
  BRIDGE_WARM_START_LEAD_US,
  PROTOCOL_CAPS,
  RAOP_SAFETY_MS,
  SENDSPIN_RATE,
  type BridgeProtocol,
} from "./rates.js";
import { computeBridgeBackoffMs } from "./bridgeSource.js";
import { PolyphaseResampler, floatToPcmS16, pcmS16ToFloat } from "./resampler.js";
import { computeBridgeAnchors, driftCorrection, type BridgeAnchors } from "./bridgeMath.js";
import { nowUs } from "../../utils/hostClock.js";
import { RaopPlayer, CHUNK_LEN, type RaopSession } from "./raop.js";
import { getAirPlayVolumeState, DEFAULT_AIRPLAY_VOLUME } from "./deviceState.js";
import { degreesToDb } from "./decoder.js";
import { createLogger } from "../../utils/logger.js";

/** Fix-1: 桥会话建立(RECORD 完成)后主动推一次初始音量。此前桥会话只在音量
 *  **变更**事件时才有 SET_PARAMETER(cast 路径 control.applyVolumeDb 不覆盖桥),
 *  起播/重连会话从不推,接收端落默认初始音量(shairport-sync -18dB ⇒ loopback
 *  实测 -50.8dB 峰值,近乎无声)。音量以 airplay_device_state 落库值为准
 *  (读失败回退 80),0-100 标尺映射 -30..0dB;失败只记日志,不阻断起流。 */
function pushInitialVolume(player: RaopPlayer, deviceId: string): void {
  try {
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
  /** 指令提前量 = A − now(锚点确定时刻;§3.5 commandedLeadUs)。 */
  commandedLeadUs: bigint;
}

/** 由首帧 tsUs 与 RECORD 协商 L 计算四字段锚点(含可达性检查,§3.3 末段)。
 *
 *  - 可达(A − L − SAFETY ≥ now):A = 首帧 tsUs 原样;
 *  - 不可达:A = max(now + warmLead, 首帧 tsUs) —— 桥会话刚完成 RECORD,按热启 lead 重锚,
 *    更早的内容(含首帧)由对齐器按 drop 出清,绝不硬塞。
 *  - 群延迟补偿仅重采样路径(48k 直通 resampled=false ⇒ A′ = A)。 */
export function planBridgeAnchor(opts: {
  firstFrameTsUs: bigint;
  latencyFrames: number;
  rate: number;
  /** 是否经过重采样(决定群延迟补偿方向,MIN-01)。 */
  resampled: boolean;
  nowUs: bigint;
  warmLeadUs?: number;
}): BridgeAnchorPlan {
  let anchorUs = opts.firstFrameTsUs;
  const warmUs = BigInt(opts.warmLeadUs ?? BRIDGE_WARM_START_LEAD_US);
  const lUs = BigInt(Math.round((opts.latencyFrames / opts.rate) * 1e6));
  const safetyUs = BigInt(RAOP_SAFETY_MS * 1000);
  let reAnchored = false;
  if (anchorUs - lUs - safetyUs < opts.nowUs) {
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
  return { anchorUs, anchors, reAnchored, commandedLeadUs: anchorUs - opts.nowUs };
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
  /** RAOP 目标(四锚点驱动出声);dry 模式可缺省。 */
  host?: string;
  port?: number;
  pk?: string;
  et?: string;
  /** 测试/落盘干跑:不做 RTSP 握手,只起 listener 验证 48k→44.1k 生产管线。 */
  dry?: boolean;
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
  private generation = 0;
  private maxQueueMs = 0;
  private deltaSamples: number[] = [];
  private statsTimer: NodeJS.Timeout | null = null;

  // ---- Phase 5:生命周期(代次重锚 / 暂停 / stall / RAOP 重连) ----
  /** 推流被终态打断(boundary/stall):producer 立刻返回 null,旧 streamBridge 循环退出。 */
  private streamAborted = false;
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
      onOverflow: (ms) => log.warn(`bridge overflow: device=${this.deviceId} backlog=${Math.round(ms)}ms`),
      log: (...args: unknown[]) => log.info(args.map((a) => String(a)).join(" ")),
    };
    const server = new BridgeServer(
      { deviceId: this.opts.deviceId, token: this.opts.token, protocol: this.opts.protocol },
      handlers,
    );
    await server.listen(this.opts.socketPath);
    this.server = server;
    if (this.opts.dry) return;
    const player = new RaopPlayer({
      host: this.opts.host ?? "",
      port: this.opts.port ?? 5000,
      pk: this.opts.pk,
      et: this.opts.et,
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
    pushInitialVolume(player, this.opts.deviceId);
    // 首帧可能早于 connect 完成 —— 连接就绪后立即补判起流。
    void this.maybeBeginStream();
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
  }

  /** 链路 stall(2s 无任何帧,含心跳):sendspin 子进程死亡/链路断。
   *  §5.2「sendspin 子进程崩溃 ⇒ airplay 侧无残留播放」:立刻停推流(不写静音),
   *  保留 listener 等重连;BridgeMember 重连成功会发 BOUNDARY{rehost} ⇒ 走 onBoundary 重锚。 */
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
    const player = this.player;
    const session = this.raopSession;
    if (!player || !session) return;
    const rate = this.outRate;
    // L = RECORD 协商的接收端缓冲深度(不得归零,§3.3);锚点公式与 SYNC 用同一值。
    const latencyFrames = Math.max(1, player.negotiatedLatencyFrames);
    const plan = planBridgeAnchor({
      firstFrameTsUs: this.firstFrameTsUs,
      latencyFrames,
      rate,
      resampled: this.resampler !== null,
      nowUs: nowUs(),
    });
    if (plan.reAnchored) {
      log.warn(`[airplay-bridge] anchor unreachable: device=${this.deviceId} commanded=${this.firstFrameTsUs} now=${nowUs()} → re-anchor ${plan.anchorUs}(丢弃更早内容)`);
    }
    this.anchorUs = plan.anchorUs;
    this.commandedLeadUs = plan.commandedLeadUs;
    this.anchors = plan.anchors;
    this.aligner = new BridgeTimelineAligner(plan.anchorUs, rate);
    this.streamAborted = false;
    this.emitAnchorReport(plan, latencyFrames);
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
      .then(() => {
        // 正常结束(producer null / 终态):stall/boundary 场景由对应路径处置;
        // 设备侧 RAOP 断开(sendChunk false) ⇒ 走 RAOP 重连(§5.2 设备级重连必须新会话)。
        if (!this.closed && this.connected && !this.streamAborted) this.scheduleRaopReconnect("stream ended");
      })
      .catch((e) => {
        log.warn(`bridge raop stream ended: device=${this.deviceId} err=${(e as Error)?.message || e}`);
        if (!this.closed && this.connected && !this.streamAborted) this.scheduleRaopReconnect("stream error");
      });
    this.startStatsTick();
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
    const player = new RaopPlayer({
      host: this.opts.host ?? "",
      port: this.opts.port ?? 5000,
      pk: this.opts.pk,
      et: this.opts.et,
    });
    try {
      const session = await player.connect();
      this.raopSession = session;
      this.player = player;
      this.raopReconnectAttempt = 0;
      log.info(`[airplay-bridge] raop reconnected: device=${this.deviceId}(新 RECORD,等待新代次首帧重锚)`);
      pushInitialVolume(player, this.deviceId);
      try { oldPlayer?.forceClose(); } catch { /* ignore */ }
    } catch (e) {
      try { player.forceClose(); } catch { /* ignore */ }
      log.warn(`[airplay-bridge] raop reconnect failed: device=${this.deviceId} err=${(e as Error)?.message || e}`);
      this.scheduleRaopReconnect("reconnect failed");
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
    const rate = this.outRate;
    const queueMs = Math.round(((this.outBuf.length >> 2) / rate) * 1000);
    if (queueMs > this.maxQueueMs) this.maxQueueMs = queueMs;
    let deltaUs = 0;
    const anchors = this.anchors;
    if (anchors) {
      // deltaUs(§10.5):已写入 RAOP 的内容前沿相对 A′ 的超前量 ≈ L + 队列 + 在途。
      // 锚点错 X ⇒ 恒偏 X;与 driftUs(对齐残差)/ late(lead 不足)可区分。
      const writtenFrames = this.stats.chunksOut * CHUNK_LEN;
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
      maxQueueMs: this.maxQueueMs,
      late: this.player?.bridgeLateCount ?? 0,
      realigned: this.stats.realignments,
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
    const deadline = Date.now() + this.waitDataMs;
    while (this.outBuf.length < need) {
      const next = this.inQueue.shift();
      if (next !== undefined) {
        this.inBytes -= next.buf.length;
        this.resampleIn(next);
        continue;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 5));
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
      latencyFrames: this.player?.negotiatedLatencyFrames ?? null,
      latePackets: this.player?.bridgeLateCount ?? 0,
      paused: this.pausedState,
      reconnecting: this.raopReconnectTimer !== null,
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

  /** 起一座桥会话(同 deviceId 旧会话先拆 = 新流语义)。 */
  async prepare(opts: BridgeSessionOpts): Promise<{ listening: true; socketPath: string }> {
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
