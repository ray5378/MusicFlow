// ==================== AP2 realtime 会话编排（Phase 6b 批 3）====================
//
// 组合 rtspClient（加密 RTSP）+ bplist（SETUP 体）+ alac（编码）+ rtpAudio（打包发送）
// + timingClient（event/timing 排水通道），产出「一个可播放的 realtime 音频会话」：
//
//   pair-verify → 加密通道
//   SETUP(session)  bplist{timingPort(我方), timingProtocol:'NTP'}  → {eventPort, timingPort?}
//   RECORD
//   SETUP(stream)   bplist{streams:[{type:96(realtime), ct:2(ALAC), sr, spf, shk,
//                     controlPort, dataPort, streamConnectionID, latencyMin/Max,
//                     audioMode:'default', isMedia:true}]}
//                   → {streams:[{controlPort, dataPort, streamID, type}]}
//   event/timing TCP 连接保活 + 周期 NTP 请求
//   UDP 音频循环：PCM 352 帧/包 → ALAC escape → RTP(+ChaCha) → dataPort，按采样时钟节流
import { randomBytes, randomInt } from "node:crypto";
import type { Ap2RtspClient } from "./rtspClient.js";
import { openVerifiedChannel, pairNewDevice, type HapCredsHex } from "./ap2Session.js";
import { bplistDecode, bplistEncode, type PlistValue } from "./bplist.js";
import { AlacEncoder } from "./alac.js";
import { RtpRealtimeSender, UdpAudioSink } from "./rtpAudio.js";
import { EventTimingChannels } from "./timingClient.js";

export const AP2_REALTIME_STREAM_TYPE = 96;
export const AP2_ALAC_CODEC = 2;

export class Ap2StreamError extends Error {
  constructor(message: string, public readonly stage = "") {
    super(message);
    this.name = "Ap2StreamError";
  }
}

export interface Ap2StreamOptions {
  host: string;
  /** 控制端口（AirPlay 主端口 7000/7200 等）。 */
  port: number;
  controllerId: string;
  /** 既有凭据（免 PIN）；无则用 pin 走配对。 */
  creds?: HapCredsHex;
  pin?: string;
  onNewControllerSeed?: (seedHex: string) => void;
  sampleRate?: number; // 默认 44100
  spf?: number; // 默认 352
  /** X-Apple-HKP：2=HomeKit 凭据会话、4=transient。默认 2。 */
  hkp?: number;
  timeoutMs?: number;
}

export interface Ap2StreamInfo {
  streamId: number;
  dataPort: number;
  controlPort: number;
  eventPort: number;
  timingPort: number;
  sampleRate: number;
  spf: number;
  agreedRate: number; // 与设备协商后的采样率（决定是否重采样，批 4 用）
}

/** 一个 realtime 音频会话（pump 推送 PCM）。 */
export class Ap2StreamSession {
  private client: Ap2RtspClient | null = null;
  private sender: RtpRealtimeSender | null = null;
  private sink: UdpAudioSink | null = null;
  private timing: EventTimingChannels | null = null;
  private encoder: AlacEncoder;
  private readonly opts: Required<Pick<Ap2StreamOptions, "sampleRate" | "spf">> & Ap2StreamOptions;
  private info: Ap2StreamInfo | null = null;
  private pumping = false;
  private readonly streamKey = randomBytes(32); // shk（我方生成，发给设备）
  private readonly streamConnId = randomInt(1, 2 ** 31);
  private localRtpPort = 0;
  private localControlPort = 0;

  constructor(options: Ap2StreamOptions) {
    this.opts = { sampleRate: 44100, spf: 352, ...options };
    this.encoder = new AlacEncoder({ spf: this.opts.spf });
  }

  /** 建立控制面：配对/verify → SETUP(session) → RECORD → SETUP(stream) → 排水通道。 */
  async open(): Promise<Ap2StreamInfo> {
    const { host, port, controllerId } = this.opts;
    // 1) 控制通道（明文 → pair-verify → 加密）
    let client: Ap2RtspClient;
    if (this.opts.creds) {
      ({ client } = await openVerifiedChannel({
        host, port, controllerId: controllerId, creds: this.opts.creds, timeoutMs: this.opts.timeoutMs,
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
    const common = { dacpId: controllerId, activeRemote: controllerId.slice(0, 10), hkp: this.opts.hkp ?? 2 };
    const url = `rtsp://${host}/${this.streamConnId}`;

    // 2) SETUP(session)：声明我方 NTP timing 端口
    const sessionResp = await client.request({
      method: "SETUP", url, common,
      contentType: "application/x-apple-binary-plist",
      body: bplistEncode({ timingPort: 0, timingProtocol: "NTP", timingPeerInfo: {} }),
      timeoutMs: this.opts.timeoutMs,
    });
    const sessionBody = this.parsePlist(sessionResp.body);
    const eventPort = this.numField(sessionBody, "eventPort") ?? 0;
    // bed 以 RTSP 头形式回报 timing_port=NNN（cliairplay 亦兼容）
    const timingHeader = sessionResp.headers.get("timing_port") ?? sessionResp.headers.get("timingport");
    const timingPort = this.numField(sessionBody, "timingPort")
      ?? (timingHeader ? Number(timingHeader) : 0);

    // 3) RECORD
    await client.request({ method: "RECORD", url, common, timeoutMs: this.opts.timeoutMs });

    // 4) SETUP(stream)：申请 realtime 流（本地 UDP 端口由内核分配后回报）
    if (!this.localRtpPort) this.localRtpPort = randomInt(40000, 60000);
    if (!this.localControlPort) this.localControlPort = randomInt(40000, 60000);
    const streamResp = await client.request({
      method: "SETUP", url, common,
      contentType: "application/x-apple-binary-plist",
      body: bplistEncode({
        streams: [{
          type: AP2_REALTIME_STREAM_TYPE,
          ct: AP2_ALAC_CODEC,
          sr: this.opts.sampleRate,
          spf: this.opts.spf,
          shk: this.streamKey,
          controlPort: this.localControlPort,
          dataPort: this.localRtpPort,
          streamConnectionID: this.streamConnId,
          latencyMin: 11025,
          latencyMax: 88200,
          audioMode: "default",
          isMedia: true,
        }],
      }),
      timeoutMs: this.opts.timeoutMs,
    });
    const streamBody = this.parsePlist(streamResp.body) as { streams?: { controlPort?: number; dataPort?: number; streamID?: number; type?: number }[] } | null;
    const st = streamBody?.streams?.[0];
    if (!st || typeof st.dataPort !== "number") {
      throw new Ap2StreamError("SETUP(stream) 响应缺少 dataPort", "setup");
    }

    // 5) 排水通道 + 周期 NTP（bed 丢弃；真机由响应驱动时钟，批 4 补应答处理）
    this.timing = new EventTimingChannels();
    if (eventPort && timingPort) {
      await this.timing.connect(host, { eventPort, timingPort });
      this.timing.startNtp(1000);
    }

    // 6) UDP 音频出口 + 打包器
    this.sink = new UdpAudioSink();
    await this.sink.connect(host, st.dataPort);
    this.sender = new RtpRealtimeSender(this.streamKey);

    // 协商速率：设备回报的采样率优先（bed 固定接受请求值；真机可能下调）
    const agreedRate = this.numField(streamBody as unknown as PlistValue ?? null, "sr") ?? this.opts.sampleRate;
    this.info = {
      streamId: st.streamID ?? 0,
      dataPort: st.dataPort,
      controlPort: st.controlPort ?? 0,
      eventPort,
      timingPort,
      sampleRate: this.opts.sampleRate,
      spf: this.opts.spf,
      agreedRate,
    };
    return this.info;
  }

  /** 读一次 PCM（s16le 交织，任意长度），按帧切分/补齐后编码发送。 */
  pump(pcm: Buffer): number {
    if (!this.sender || !this.sink) throw new Ap2StreamError("会话未开启", "state");
    let off = 0;
    let sent = 0;
    while (off + this.encoder.frameBytes <= pcm.length) {
      const frame = this.encoder.encodeFrame(pcm.subarray(off, off + this.encoder.frameBytes));
      this.sink.send(this.sender.next(frame, this.opts.spf));
      off += this.encoder.frameBytes;
      sent++;
    }
    this.pumping = true;
    return sent;
  }

  /** 按实时时钟推流（pcmSource 每次返回一包 PCM；null = 结束）。 */
  async pumpRealtime(pcmSource: () => Promise<Buffer | null>): Promise<number> {
    let total = 0;
    const periodMs = (this.opts.spf / this.opts.sampleRate) * 1000;
    let nextAt = Date.now();
    for (;;) {
      const pcm = await pcmSource();
      if (!pcm) break;
      total += this.pump(pcm);
      nextAt += periodMs * Math.max(1, Math.floor(pcm.length / this.encoder.frameBytes));
      const wait = nextAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else nextAt = Date.now(); // 落后则重置锚点，避免追赶抖动
    }
    return total;
  }

  get streamInfo(): Ap2StreamInfo | null {
    return this.info;
  }

  get isPumping(): boolean {
    return this.pumping;
  }

  /** TEARDOWN + 资源回收（幂等）。 */
  async close(): Promise<void> {
    this.timing?.destroy();
    this.timing = null;
    this.sink?.destroy();
    this.sink = null;
    this.client?.destroy();
    this.client = null;
  }

  private parsePlist(body: Buffer): PlistValue | null {
    if (!body || body.length < 8) return null;
    try {
      return bplistDecode(body);
    } catch {
      return null;
    }
  }

  private numField(obj: PlistValue | null, key: string): number | undefined {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || Buffer.isBuffer(obj)) return undefined;
    const v = (obj as Record<string, PlistValue>)[key];
    return typeof v === "number" ? v : undefined;
  }
}
