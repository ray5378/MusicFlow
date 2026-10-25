// ==================== AP2 realtime 会话编排（Phase 6b 批 3/4）====================
//
// 组合 rtspClient（加密 RTSP）+ bplist（SETUP 体）+ alac（编码）+ rtpAudio（打包发送）
// + timingClient（event/timing 排水通道）+ resampler（147/160，仅协商 44.1k 时启用）：
//
//   pair-verify → 加密通道
//   SETUP(session)  bplist{timingPort, timingProtocol:'NTP'}        → {eventPort, timingPort?}
//   RECORD
//   SETUP(stream)   bplist{streams:[{type:96, ct:2(ALAC), sr, audioFormat, spf, shk,
//                     controlPort, dataPort, streamConnectionID, latencyMin/Max,
//                     audioMode, isMedia}]}                          → {streams:[...]}
//   event/timing TCP 保活 + 周期 NTP 请求
//   UDP 音频循环：PCM(sourceRate) →(按需 147/160)→ ALAC escape → RTP(+ChaCha) → dataPort
//
// 速率协商（判据③）：请求速率取自 AP2_RATES（[48000, 44100]），绝不硬编码；
//   设备若在 SETUP 响应里回报 sr 则以回报为准；最终 rate= 与 sourceRate 比较决定
//   是否走 147/160 重采样（48k 直通 / 44.1k 走 resampler + compensateGroupDelay 锚点）。
//
// 异常路径（批 4，纪律要求：任何失败都必须收敛为确定状态并清干净资源）：
//   - SETUP/RECORD 失败      → state='error' + cleanup()，open() 抛出原错误；
//   - RECORD 中途断链        → rtspClient 'close'/'error' → failLink() → state='error' + cleanup()；
//   - UDP 端口不可达         → sink 连续错误达 AP2_SEND_ERROR_LIMIT → failLink()（不无限空转）；
//   - TEARDOWN 失败          → 只记 lastError，清理照做（close() 幂等，任何状态可调）。
//
// 桥接点：pumpRealtime() 只吃「PCM 供给」（Ap2PcmProvider 或裸函数），桥侧只需实现
//   pull()：返回一包 s16le 交织 PCM（null = 会话终止）。数据面单向往外拉，桥不认识 AP2。
import { randomBytes, randomInt } from "node:crypto";
import type { Ap2RtspClient } from "./rtspClient.js";
import { openVerifiedChannel, pairNewDevice, type HapCredsHex } from "./ap2Session.js";
import { bplistDecode, bplistEncode, type PlistValue } from "./bplist.js";
import { AlacEncoder } from "./alac.js";
import { RtpRealtimeSender, UdpAudioSink } from "./rtpAudio.js";
import { EventTimingChannels } from "./timingClient.js";
import { AP2_TRACE_LOOP_SAMPLES, AP2_TRACE_ON, Ap2OpenTrace, nowUs } from "./ap2Trace.js";
import { AP2_RATES } from "../rates.js";
import { PolyphaseResampler, pcmS16ToFloat, floatToPcmS16 } from "../resampler.js";
import { createLogger } from "../../../utils/logger.js";

export const AP2_REALTIME_STREAM_TYPE = 96;
export const AP2_ALAC_CODEC = 2;
/** 连续发送错误达到该值 ⇒ 判定 UDP 出口不可达（ICMP port unreachable 持续），收敛为 error。 */
export const AP2_SEND_ERROR_LIMIT = 20;

const log = createLogger("airplay-ap2");

export class Ap2StreamError extends Error {
  constructor(message: string, public readonly stage = "") {
    super(message);
    this.name = "Ap2StreamError";
  }
}

export type Ap2StreamState = "idle" | "opening" | "open" | "closed" | "error";

/** 速率协商结果（纯函数，便于单测与日志）。 */
export interface Ap2RateDecision {
  /** 最终用于 SETUP 与编码的流速率。 */
  rate: number;
  /** 设备是否在 SETUP 响应中回报了速率。 */
  fromDevice: boolean;
  /** 是否需要 147/160 重采样（rate ≠ sourceRate）。 */
  resampled: boolean;
}

/** 选速率：preferred 合法则用之；否则 AP2_RATES 首项；设备回报优先。 */
export function negotiateAp2Rate(opts: {
  sourceRate: number;
  preferredRate?: number;
  deviceReportedRate?: number;
}): Ap2RateDecision {
  const wanted = opts.preferredRate !== undefined && AP2_RATES.includes(opts.preferredRate)
    ? opts.preferredRate
    : AP2_RATES[0]!;
  const fromDevice = opts.deviceReportedRate !== undefined && AP2_RATES.includes(opts.deviceReportedRate);
  const rate = fromDevice ? opts.deviceReportedRate! : wanted;
  return { rate, fromDevice, resampled: rate !== opts.sourceRate };
}

/** PCM 供给接点（结构类型：桥只需有 pull()，与 AP2 零耦合）。 */
export interface Ap2PcmProvider {
  /** 返回一包 s16le 交织 PCM（sourceRate）；null = 会话终止（推流循环退出）。 */
  pull(): Promise<Buffer | null>;
}

/** 音频出口最小契约（UdpAudioSink 结构化满足；测试可注入假实现验证失败收敛）。 */
export interface Ap2AudioSink {
  connect(host: string, port: number): Promise<void>;
  send(pkt: Buffer): void;
  destroy(): void;
}

/** 把一个「拉块」实现（如 BridgeSession.pullOutChunk）适配成 PCM 供给。 */
export function bridgePcmProvider(source: {
  pullOutChunk(): Promise<Buffer | null>;
}): Ap2PcmProvider {
  return { pull: () => source.pullOutChunk() };
}

export interface Ap2StreamOptions {
  host: string;
  port: number;
  controllerId: string;
  creds?: HapCredsHex;
  pin?: string;
  onNewControllerSeed?: (seedHex: string) => void;
  /** 源 PCM 速率（桥组泵侧，默认 48k）。 */
  sourceRate?: number;
  /** 期望的 AP2 流速率（须在 AP2_RATES 内；缺省取 AP2_RATES[0]）。 */
  preferredRate?: number;
  spf?: number; // 默认 352
  hkp?: number; // 2=HomeKit 凭据会话、4=transient
  /** 声明给接收端的最小延迟（样本数，默认 11025）。接收端据此算抖动缓冲大小
   *  （bed: buffer = latencyMin*7/spf + 1）。0 → 1 包缓冲（LAN 直连实测用）。 */
  latencyMin?: number;
  /** 声明给接收端的最大延迟（样本数，默认 88200）。 */
  latencyMax?: number;
  timeoutMs?: number;
  /** 测试接缝：注入已连接（可已加密）的 client，跳过 pair 流程。 */
  client?: Ap2RtspClient;
  /** 测试接缝：注入音频出口（缺省用 UdpAudioSink；注入者 connect() 会被调用一次）。 */
  sink?: Ap2AudioSink;
  /** 测试接缝：固定流密钥 shk（缺省每次随机会话随机 32B；仅离线对账用，绝不进日志）。 */
  shk?: Buffer;
}

export interface Ap2StreamInfo {
  streamId: number;
  dataPort: number;
  controlPort: number;
  eventPort: number;
  timingPort: number;
  /** 源速率（输入 PCM）。 */
  sourceRate: number;
  /** 协商后的流速率（编码/SETUP 用）。 */
  agreedRate: number;
  rateFromDevice: boolean;
  resampled: boolean;
  spf: number;
}

/** 一个 realtime 音频会话（pump 推送 PCM；close 幂等）。 */
export class Ap2StreamSession {
  private state: Ap2StreamState = "idle";
  private client: Ap2RtspClient | null = null;
  private sender: RtpRealtimeSender | null = null;
  private sink: Ap2AudioSink | null = null;
  private timing: EventTimingChannels | null = null;
  private encoder: AlacEncoder;
  private resampler: PolyphaseResampler | null = null;
  /** 非整帧/重采样尾部残字节（s16le）。 */
  private carry: Buffer = Buffer.alloc(0);
  private info: Ap2StreamInfo | null = null;
  private readonly streamKey: Buffer; // shk（我方生成，发给设备）
  private readonly streamConnId = randomInt(1, 2 ** 31);
  private readonly localRtpPort = randomInt(40000, 60000);
  private readonly localControlPort = randomInt(40000, 60000);
  private readonly opts: Required<Pick<Ap2StreamOptions, "sourceRate" | "spf">> & Ap2StreamOptions;
  private sentPackets = 0;
  private sendErrors = 0;
  /** 连续发送失败计数（成功发送清零）；达 AP2_SEND_ERROR_LIMIT 判定出口不可达。 */
  private consecutiveSendErrors = 0;
  private lastError: string | null = null;
  /** 链路失败原因（ev:"link-loss" 的 reason；空 = 未发生）。 */
  private linkLossReason: string | null = null;
  /** 首包延迟分解埋点（MUSICFLOW_AP2_TRACE=1 才有实例；否则恒为 null ⇒ 打点分支零开销）。 */
  private readonly trace: Ap2OpenTrace | null;
  /** client 事件监听器引用（cleanup 时精确摘除，避免悬挂监听）。 */
  private readonly onClientClose = (): void => this.failLink("rtsp-close", "rtsp");
  private readonly onClientError = (e: Error): void => {
    // RTSP 侧 socket 错误：记错误但不断链（close 随后会到，由 onClientClose 收敛）。
    this.lastError = e.message;
  };

  constructor(options: Ap2StreamOptions) {
    this.opts = { sourceRate: 48000, spf: 352, ...options };
    this.encoder = new AlacEncoder({ spf: this.opts.spf });
    this.streamKey = options.shk ?? randomBytes(32);
    this.trace = AP2_TRACE_ON ? new Ap2OpenTrace(options.controllerId) : null;
  }

  get streamInfo(): Ap2StreamInfo | null {
    return this.info;
  }

  get currentState(): Ap2StreamState {
    return this.state;
  }

  get stats(): {
    sent: number;
    errors: number;
    lastError: string | null;
    linkLoss: string | null;
  } {
    return {
      sent: this.sentPackets,
      errors: this.sendErrors,
      lastError: this.lastError,
      linkLoss: this.linkLossReason,
    };
  }

  /** 建立控制面：配对/verify → SETUP(session) → RECORD → SETUP(stream) → 排水通道。 */
  async open(): Promise<Ap2StreamInfo> {
    if (this.state !== "idle") throw new Ap2StreamError(`open 状态非法: ${this.state}`, "state");
    this.state = "opening";
    try {
      const { host, port, controllerId } = this.opts;
      let client: Ap2RtspClient;
      if (this.opts.client) {
        client = this.opts.client; // 测试接缝：已连接/已加密
      } else if (this.opts.creds) {
        ({ client } = await openVerifiedChannel({
          host, port, controllerId, creds: this.opts.creds, timeoutMs: this.opts.timeoutMs,
        }));
      } else {
        if (!this.opts.pin) throw new Ap2StreamError("无凭据时必须提供 pin", "auth");
        const creds = await pairNewDevice({
          host, port, controllerId, pin: this.opts.pin,
          onNewControllerSeed: this.opts.onNewControllerSeed,
          timeoutMs: this.opts.timeoutMs,
        });
        this.opts.creds = creds;
        ({ client } = await openVerifiedChannel({
          host, port, controllerId, creds, timeoutMs: this.opts.timeoutMs,
        }));
      }
      this.client = client;
      // 链路事件：断链即收敛（RECORD 中途断链 / 控制面被对端拆除）。
      client.on("close", this.onClientClose);
      client.on("error", this.onClientError);

      const common = { dacpId: controllerId, activeRemote: controllerId.slice(0, 10), hkp: this.opts.hkp ?? 2 };
      const url = `rtsp://${host}/${this.streamConnId}`;

      // 1) SETUP(session)
      const sessionResp = await client.request({
        method: "SETUP", url, common,
        contentType: "application/x-apple-binary-plist",
        body: bplistEncode({ timingPort: 0, timingProtocol: "NTP", timingPeerInfo: {} }),
        timeoutMs: this.opts.timeoutMs,
      });
      const sessionBody = this.parsePlist(sessionResp.body);
      const eventPort = this.numField(sessionBody, "eventPort") ?? 0;
      const timingHeader = sessionResp.headers.get("timing_port") ?? sessionResp.headers.get("timingport");
      const timingPort = this.numField(sessionBody, "timingPort")
        ?? (timingHeader ? Number(timingHeader) : 0);

      // 2) RECORD
      await client.request({ method: "RECORD", url, common, timeoutMs: this.opts.timeoutMs });

      // 3) SETUP(stream)：先按 wanted 速率，SETUP 后以设备回报为准重算
      const wanted = negotiateAp2Rate({ sourceRate: this.opts.sourceRate, preferredRate: this.opts.preferredRate });
      const streamResp = await client.request({
        method: "SETUP", url, common,
        contentType: "application/x-apple-binary-plist",
        body: bplistEncode({
          streams: [{
            type: AP2_REALTIME_STREAM_TYPE,
            ct: AP2_ALAC_CODEC,
            sr: wanted.rate,
            // AirplayAudFmt：ALAC_44100_16_2 = 1<<18、ALAC_48000_16_2 = 1<<20
            audioFormat: wanted.rate === 48000 ? 1 << 20 : 1 << 18,
            spf: this.opts.spf,
            shk: this.streamKey,
            controlPort: this.localControlPort,
            dataPort: this.localRtpPort,
            streamConnectionID: this.streamConnId,
            latencyMin: this.opts.latencyMin ?? 11025,
            latencyMax: this.opts.latencyMax ?? 88200,
            audioMode: "default",
            isMedia: true,
          }],
        }),
        timeoutMs: this.opts.timeoutMs,
      });
      if (this.trace) this.trace.markSetupResp(nowUs()); // 埋点起点：SETUP(stream) 响应到达
      const streamBody = this.parsePlist(streamResp.body);
      const st = this.firstStream(streamBody);
      if (!st || typeof st.dataPort !== "number") {
        throw new Ap2StreamError("SETUP(stream) 响应缺少 dataPort", "setup");
      }
      const deviceRate = this.numField(streamBody, "sr");
      const decision = negotiateAp2Rate({
        sourceRate: this.opts.sourceRate,
        preferredRate: wanted.rate,
        deviceReportedRate: deviceRate,
      });

      // 判据③：SETUP 速率日志（rate 为最终协商值，来源与重采样策略显式可查）
      log.info(`[airplay-ap2] setup ${JSON.stringify({
        ev: "setup", dev: this.opts.controllerId, rate: decision.rate,
        src: this.opts.sourceRate, req: wanted.rate, from: decision.fromDevice ? "device" : "request",
        resampled: decision.resampled, spf: this.opts.spf,
      })}`);

      if (decision.resampled) {
        this.resampler = new PolyphaseResampler(this.opts.sourceRate, decision.rate, 2);
      }
      this.carry = Buffer.alloc(0);

      // 4) 排水通道 + 周期 NTP（bed 丢弃；真机 NTP 应答处理留后续批次）
      this.timing = new EventTimingChannels();
      if (eventPort && timingPort) {
        let tConn0 = 0;
        if (this.trace) tConn0 = nowUs();
        await this.timing.connect(host, { eventPort, timingPort });
        if (this.trace) this.trace.markTiming(tConn0, nowUs()); // #1 设备侧 accept
        this.timing.startNtp(1000);
      }

      // 5) UDP 出口 + 打包器（端口不可达经 onError/回调上报，连续超限即收敛）
      this.sink = this.opts.sink ?? new UdpAudioSink({ onError: (e: Error) => this.onSinkError(e) });
      await this.sink.connect(host, st.dataPort);
      if (this.trace) {
        // #4/#7：UdpAudioSink 自己在 connect() 里分段计时（注入的假出口没有该字段 ⇒ 0）
        const span = (this.sink as { connectSpanUs?: { dgramImportUs: number; socketUs: number } | null })
          .connectSpanUs ?? null;
        this.trace.markDgram(span?.dgramImportUs ?? 0, span?.socketUs ?? 0);
      }
      this.sender = new RtpRealtimeSender(this.streamKey);

      this.info = {
        streamId: st.streamID ?? 0,
        dataPort: st.dataPort,
        controlPort: st.controlPort ?? 0,
        eventPort,
        timingPort,
        sourceRate: this.opts.sourceRate,
        agreedRate: decision.rate,
        rateFromDevice: decision.fromDevice,
        resampled: decision.resampled,
        spf: this.opts.spf,
      };
      if (this.trace) this.trace.markOpenDone(nowUs());
      this.state = "open";
      return this.info;
    } catch (e) {
      this.state = "error";
      this.lastError = (e as Error).message;
      this.cleanup();
      throw e;
    }
  }

  /** 读一次 PCM（s16le 交织，任意长度），按需重采样 + 整帧编码发送。返回发送包数。 */
  pump(pcm: Buffer): number {
    if (this.state !== "open") throw new Ap2StreamError(`pump 状态非法: ${this.state}`, "state");
    if (!this.sender || !this.sink) throw new Ap2StreamError("会话未开启", "state");

    // 只处理完整立体声样本（4B/帧）——奇数残字节直接丢弃，杜绝错位。
    const usable = pcm.length - (pcm.length % 4);
    let stream: Buffer;
    if (this.resampler) {
      const f32 = pcmS16ToFloat(this.toInt16(usable === pcm.length ? pcm : pcm.subarray(0, usable)));
      stream = this.fromInt16(floatToPcmS16(this.resampler.process(f32)));
    } else {
      stream = usable === pcm.length ? pcm : pcm.subarray(0, usable);
    }

    const buf = this.carry.length ? Buffer.concat([this.carry, stream]) : stream;
    let off = 0;
    let sent = 0;
    while (off + this.encoder.frameBytes <= buf.length && this.state === "open") {
      const frame = this.encoder.encodeFrame(buf.subarray(off, off + this.encoder.frameBytes));
      try {
        this.sink.send(this.sender.next(frame, this.opts.spf));
        sent++;
        this.sentPackets++;
        this.consecutiveSendErrors = 0;
      } catch (e) {
        this.sendErrors++;
        this.consecutiveSendErrors++;
        this.lastError = (e as Error).message;
        this.maybeAbortUdp();
      }
      off += this.encoder.frameBytes;
    }
    this.carry = Buffer.from(buf.subarray(off));
    return sent;
  }

  /** 按实时时钟推流（供给可为 Ap2PcmProvider 或裸函数；null = 结束）。 */
  async pumpRealtime(
    source: Ap2PcmProvider | (() => Promise<Buffer | null>),
  ): Promise<number> {
    const pull = typeof source === "function" ? source : () => source.pull();
    const rate = this.info?.agreedRate ?? this.opts.sourceRate;
    const periodMs = (this.opts.spf / rate) * 1000;
    let total = 0;
    let nextAt = Date.now();
    if (this.trace) this.trace.markPumpEnter(nowUs()); // #3 与 open() 结束时刻之差
    try {
      for (;;) {
        if (this.state !== "open") break; // 链路已收敛（error/closed）：立即停止拉取
        let tPull0 = 0;
        let tWall0 = 0;
        if (this.trace) {
          tPull0 = nowUs();
          tWall0 = Date.now();
        }
        const pcm = await pull();
        if (this.trace) this.trace.markFirstPull(tPull0, nowUs(), Date.now() - tWall0); // #2
        if (!pcm) break;
        const before = this.sentPackets;
        total += this.pump(pcm);
        if (this.trace && this.sentPackets > before) this.trace.markFirstSend(nowUs());
        const srcFrames = pcm.length / 4;
        const outFrames = this.resampler ? Math.ceil((srcFrames * rate) / this.opts.sourceRate) : srcFrames;
        nextAt += periodMs * Math.max(1, Math.floor(outFrames / this.opts.spf));
        const wait = nextAt - Date.now();
        const tSched = this.trace ? nowUs() : 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        else nextAt = Date.now(); // 落后重置锚点，避免追赶抖动
        if (this.trace) {
          // #3：实际唤醒 − 计划唤醒（wait≤0 时计划值取 0）
          this.trace.sampleLoopDelay(nowUs() - tSched - (wait > 0 ? wait * 1000 : 0));
          // 样本够数就出报告：不等整场结束，避免中途被杀时拿不到数据
          if (this.trace.loopSamples >= AP2_TRACE_LOOP_SAMPLES) this.trace.emit(rate);
        }
      }
    } catch (e) {
      // 供给器（或循环体）抛错：先按 failLink 纪律收敛状态机，再把异常交给调用方
      // —— 绝不吞异常，调用方仍要看到它；但状态不能停在 open（与 :failLink 一致）。
      this.lastError = e instanceof Error ? e.message : String(e);
      this.failLink("provider-error", "pump");
      throw e;
    } finally {
      this.trace?.emit(rate); // 会话提前结束（null 供给/断链/异常）也要如实出一行
    }
    return total;
  }

  /** TEARDOWN（best-effort）+ 全量资源回收（幂等；任何状态下可调）。 */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.client && this.state === "open") {
      try {
        await this.client.request({
          method: "TEARDOWN",
          url: `rtsp://${this.opts.host}/${this.streamConnId}`,
          common: {
            dacpId: this.opts.controllerId,
            activeRemote: this.opts.controllerId.slice(0, 10),
            hkp: this.opts.hkp ?? 2,
          },
          timeoutMs: 2000,
        });
      } catch (e) {
        this.lastError = (e as Error).message; // TEARDOWN 失败不阻塞清理
      }
    }
    this.cleanup();
    this.state = "closed";
  }

  // ---- 内部：异常收敛 ---------------------------------------------------

  /** UDP 出口错误（异步回调：ICMP 不可达 / send 回调失败）⇒ 计数并判收敛。 */
  private onSinkError(e: Error): void {
    this.sendErrors++;
    this.lastError = e.message;
    this.consecutiveSendErrors++;
    this.maybeAbortUdp();
  }

  /** 连续发送失败超限 ⇒ 判定出口不可达，收敛为 error 并清理（不无限空转）。 */
  private maybeAbortUdp(): void {
    if (this.consecutiveSendErrors >= AP2_SEND_ERROR_LIMIT && this.state === "open") {
      this.failLink("udp-unreachable", "udp");
    }
  }

  /** 链路失败统一收敛：状态置 error + 资源清理（不清状态原因，便于诊断）。 */
  private failLink(reason: string, stage: string): void {
    if (this.state === "closed" || this.state === "error") return;
    this.linkLossReason = reason;
    this.state = "error";
    this.lastError = this.lastError ?? `链路中断: ${reason}`;
    log.warn(`[airplay-ap2] link-loss ${JSON.stringify({
      ev: "link-loss", dev: this.opts.controllerId, reason, stage,
      sent: this.sentPackets, errors: this.sendErrors,
    })}`);
    this.cleanup();
  }

  /** 资源回收（幂等）：摘监听 → 停定时器 → 关 socket。 */
  private cleanup(): void {
    const client = this.client;
    if (client) {
      client.removeListener("close", this.onClientClose);
      client.removeListener("error", this.onClientError);
      client.destroy();
    }
    this.client = null;
    this.timing?.destroy();
    this.timing = null;
    this.sink?.destroy();
    this.sink = null;
    this.sender = null;
    this.resampler = null;
    this.carry = Buffer.alloc(0);
  }

  private toInt16(buf: Buffer): Int16Array {
    const out = new Int16Array(buf.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
    return out;
  }

  private fromInt16(arr: Int16Array): Buffer {
    const out = Buffer.alloc(arr.length * 2);
    for (let i = 0; i < arr.length; i++) out.writeInt16LE(arr[i]!, i * 2);
    return out;
  }

  private parsePlist(body: Buffer): PlistValue | null {
    if (!body || body.length < 8) return null;
    try {
      return bplistDecode(body);
    } catch {
      return null;
    }
  }

  private firstStream(
    body: PlistValue | null,
  ): { dataPort?: number; controlPort?: number; streamID?: number; type?: number } | null {
    if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return null;
    const streams = (body as Record<string, PlistValue>)["streams"];
    if (!Array.isArray(streams) || streams.length === 0) return null;
    const s = streams[0];
    if (!s || typeof s !== "object" || Array.isArray(s) || Buffer.isBuffer(s)) return null;
    return s as { dataPort?: number; controlPort?: number; streamID?: number; type?: number };
  }

  private numField(obj: PlistValue | null, key: string): number | undefined {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || Buffer.isBuffer(obj)) return undefined;
    const v = (obj as Record<string, PlistValue>)[key];
    return typeof v === "number" ? v : undefined;
  }
}
