// ==================== RAOP (AirPlay v1) transport ====================
//
// AirPlay v1 (RAOP) client, ported to TypeScript from music-assistant's
// libraop (`src/raop_client.c` + `src/rtsp_client.c`). MA drives RAOP through
// the C binary cliraop; we reimplement the same protocol semantics natively so
// the renderer stays a self-contained built-in plugin:
//
//   - RTSP handshake over TCP:5000 — ANNOUNCE (SDP) → SETUP → RECORD.
//   - RSA-OAEP (aeskey encrypted with the device's public key) + AES-128-CBC
//     audio payload, exactly like `crypto = (encryption||auth) && et ∋ '1'`.
//   - RTP packets: audio type 0x60/0xE0 (first), sync type 0x94/0xD4, NTP-
//     aligned rtptime, device-initiated NTP timing replies, loss retransmit.
//   - Codec: raw ALAC (pcm_to_alac_raw), the default cliraop stream format —
//     a ~40-line bit-packing, no native ALAC encoder required.
//
// This module is protocol-only (no ffmpeg, no state) so it can be unit-tested
// and reused by services/airplay/control.ts.
import * as net from "net";
import * as dgram from "dgram";
import { publicEncrypt, createPublicKey, randomBytes, constants, createCipheriv } from "crypto";
import { ntpFromHostUs, nowUs } from "../../utils/hostClock.js";
import { audibleAtUs, ntpToRtpMod, sendAtUs } from "./bridgeMath.js";
import { BRIDGE_RESUME_REBASE_US, RAOP_SAFETY_MS } from "./rates.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("RAOP");

export const SAMPLE_RATE = 44100;
export const SAMPLE_SIZE = 16;
export const CHANNELS = 2;
export const CHUNK_LEN = 352;              // frames per RTP packet (DEFAULT_FRAMES_PER_CHUNK)
export const PCM_BYTES_PER_CHUNK = CHUNK_LEN * CHANNELS * (SAMPLE_SIZE / 8); // 1408
export const RAOP_LATENCY_MIN = 11025;     // frames (libraop's LATENCY_MIN)
export const NTP_EPOCH_DELTA = 2208988800; // seconds 1970→1900

/** 单条 RTSP 请求的默认超时(常规操作)。 */
export const RTSP_TIMEOUT_MS = 10_000;
/** 清理类请求(TEARDOWN/FLUSH)的超时:设备不答也必须尽快放行,否则新 cast 被拖着。 */
export const RTSP_CLEANUP_TIMEOUT_MS = 2_500;
/** 握手(ANNOUNCE→SETUP→RECORD)的**总预算**。
 *
 *  三步各自 10s 串起来 = 30s,正好撞上 QueueController 的 cast 30s 硬顶 —— 真机实测
 *  HiVi 一次流转就在这 30s 上崩(2026-10-21)。健康握手实测约 1s,给 8s 足够宽松,
 *  超时则快速失败、交给上层重投,而不是把整个 cast 拖死。 */
export const HANDSHAKE_BUDGET_MS = 8_000;
/** 握手期间单步的最小等待(预算快耗尽时也要给设备一个响应的机会)。 */
export const RTSP_STEP_MIN_MS = 1_500;

/** 按方法 + 握手剩余预算选超时:清理请求永远短;握手请求受总预算约束。 */
export function rtspTimeoutFor(method: string, remainingHandshakeMs: number | null): number {
  if (method === "TEARDOWN" || method === "FLUSH") return RTSP_CLEANUP_TIMEOUT_MS;
  if (remainingHandshakeMs === null) return RTSP_TIMEOUT_MS;
  return Math.max(RTSP_STEP_MIN_MS, Math.min(RTSP_TIMEOUT_MS, remainingHandshakeMs));
}

/** 推流节拍健康度(可观测指标,由 `RaopPlayer.realtimeStats` 暴露)。 */
export interface RaopRealtimeStats {
  /** 已发出的 RTP 音频包数。 */
  chunks: number;
  /** 因解码/调度跟不上墙钟而「立即补发」(而非按节拍等待)的次数 —— 越大说明事件循环被拖累越重。 */
  reanchors: number;
  /** 相邻两次发包的最大间隔(ms)。chunkDurMs ≈ 7.98ms,远超即说明节拍被打断过。 */
  maxGapMs: number;
  /** 本次 `stream()` 已运行时长(ms)。 */
  elapsedMs: number;
  /** 接收端请求重传(RTP loss)的次数。 */
  lossRequests: number;
}

// ---------------------------------------------------------------------------
// NTP / timestamp helpers (mirror libraop macros)
// ---------------------------------------------------------------------------
export function ntpNow(): bigint {
  // Monotonic NTP: libraop anchors everything on gettime_us() (monotonic), and
  // the device only ever consumes NTP *differences*, so the epoch is arbitrary
  // as long as it never jumps. Using the wall clock here would let an NTP daemon
  // step corrupt the (rtp_remote - remote) deltas the receiver relies on.
  // Phase 1:统一时钟源 —— 与 sendspin/clock 的 nowUs() 同为 host 单调 µs
  // (CLOCK_MONOTONIC,跨进程同源),sendspin 的 tsUs 与 RAOP NTP 可直接比较。
  // ⚠️ 纪元 = 机器开机时长(44.1k 下 2^32/rate ≈ 27.05h 就回绕)⇒ 转 RTP 必须
  // 显式截断(RECORD 处 MAJ-10,唯一出处 bridgeMath.ntpToRtpMod)。
  return ntpFromHostUs(nowUs());
}

/** Wall-clock NTP (seconds since 1900) as 64-bit (32s/32f). */
export function ntpFromDate(d: Date): bigint {
  const sec = BigInt(Math.floor(d.getTime() / 1000) + NTP_EPOCH_DELTA);
  const frac = (BigInt(Math.floor(((d.getTime() % 1000) + 1000) % 1000)) << 32n) / 1000n;
  return (sec << 32n) | frac;
}

export function ts2ntp(ts: number, rate: number): bigint {
  const ntp = ((BigInt(ts) << 16n) / BigInt(rate)) << 16n;
  return ntp;
}

export function ntp2ts(ntp: bigint, rate: number): number {
  return Number(((ntp >> 16n) * BigInt(rate)) >> 16n);
}

export function ms2ts(ms: number, rate: number): number {
  return Math.floor((ms * rate) / 1000);
}

export function ts2ms(ts: number, rate: number): number {
  return Math.floor((ts * 1000) / rate);
}

export function ntpToMs(ntp: bigint): number {
  return Number((ntp >> 32n) * 1000n + (((ntp & 0xffffffffn) * 1000n) >> 32n));
}

/** Session base timeline: RTP timestamp that file-time 0 maps to. Set once at
 *  RECORD time; every later in-place seek re-anchors `startTs` on top of it so
 *  position (headTs − baseTs)/rate always equals the *content* position. */
export function seekStartTs(baseTs: number, seekSec: number, sampleRate: number, chunkLen: number): number {
  const targetFrames = Math.max(0, Math.round(seekSec * sampleRate));
  const aligned = targetFrames - (targetFrames % chunkLen);
  return (baseTs + aligned) >>> 0;
}

/** Content position in seconds of the chunk sequence starting at `startTs`
 *  (anchored on `baseTs`) after `idx` chunks have been sent. */
export function seekPositionSec(baseTs: number, startTs: number, idx: number, chunkLen: number, sampleRate: number): number {
  return ts2ms(((startTs + idx * chunkLen - baseTs) >>> 0), sampleRate) / 1000;
}

// ---------------------------------------------------------------------------
// RAW ALAC encoder — verbatim port of libcodecs `pcm_to_alac_raw`.
// Input: interleaved stereo signed-16-le. Output: the exact packed lossless
// bitstream MA's cliraop pushes by default (codec = RAOP_ALAC_RAW).
// ---------------------------------------------------------------------------
export function pcmToAlacRaw(sample: Buffer, frames: number, bsize: number): Buffer {
  const out = Buffer.alloc(bsize * 4 + 16 + 1, 0);
  let p = 0;
  const b = (bsize & 0x80000000) >>> 31;
  const readU16 = (i: number) => sample.readUInt16LE(i);
  out[p++] = 1 << 5;
  out[p++] = 0;
  out[p++] = (1 << 4) | (1 << 1) | b;
  out[p++] = ((bsize & 0x7f800000) << 1) >>> 24;
  out[p++] = ((bsize & 0x007f8000) << 1) >>> 16;
  out[p++] = ((bsize & 0x00007f80) << 1) >>> 8;
  out[p] = ((bsize & 0x0000007f) << 1) & 0xff;
  out[p] |= (readU16(0) & 0x8000) >> 15;
  p++;

  let count = Math.min(frames, bsize) - 1;
  for (let i = 0; i < count; i++) {
    const l = readU16(i * 4);
    const r = readU16(i * 4 + 2);
    out[p++] = (l & 0x7f80) >>> 7;
    out[p++] = ((l & 0x007f) << 1) | ((r & 0x8000) >>> 15);
    out[p++] = (r & 0x7f80) >>> 7;
    out[p++] = ((r & 0x007f) << 1) | ((readU16((i + 1) * 4) & 0x8000) >>> 15);
  }
  const i = count;
  const l0 = readU16(i * 4);
  const r0 = readU16(i * 4 + 2);
  out[p++] = (l0 & 0x7f80) >>> 7;
  out[p++] = ((l0 & 0x007f) << 1) | ((r0 & 0x8000) >>> 15);
  out[p++] = (r0 & 0x7f80) >>> 7;
  out[p++] = (r0 & 0x007f) << 1;

  count = (bsize - frames) * 4;
  while (count-- > 0) out[p++] = 0;

  out[p - 1] |= 1;
  out[p] = (7 >> 1) << 6;
  return out.subarray(0, p + 1);
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------
const WELL_KNOWN_AIRPORT_N_B64 =
  "59dE8qLieItsH1WgjrcFRKj6eUWqi+bGLOX1HL3U3GhC/j0Qg90u3sG/1CUtwC5vOYvfDm" +
  "FI6oSFXi5ELabWJmT2dKHzBJKa3k9ok+8t9ucRqMd6DZHJ2YCCLlDRKSKv6kDqnw4UwP" +
  "dpOMXziC/AMj3Z/lUVX1G7WSHCAWKf1zNS1eLvqr+boEjXuBOitnZ/bDzPHrTOZz0Dew0" +
  "uowxf/+sG+NCK3eQJVxqcaJ/vEHKIVd2M+5qL71yJQ+87X6oV3eaYvt3zWZYD6z5vYTc" +
  "rtij2VZ9Zmni/UAaHqn9JdsBWLUEpVviYnhimNVvYFZeCXg/IdTQ+x4IRdiXNv5hEew==";

/** Build an RSA public key for aieve's AirPlay encrypted-audio path.
 *  Prefers the device's mDNS `pk` TXT (SPKI DER or raw modulus); falls back to
 *  the well-known shared AirPort public key embedded in libraop. */
export function resolveRsaPublicKey(pkBase64?: string): Buffer {
  if (pkBase64) {
    const der = Buffer.from(pkBase64, "base64");
    if (der.length > 0) {
      try {
        createPublicKey({ key: der, format: "der", type: "spki" });
        return der;
      } catch {
        // try as raw modulus (256B) with e=65537
        if (der.length === 256) {
          try {
            return createPublicKey({
              key: {
                kty: "RSA",
                alg: "RSA-OAEP",
                ext: true,
                n: der.toString("base64url"),
                e: Buffer.from("010001", "hex").toString("base64url"),
              },
              format: "jwk",
            }).export({ format: "der", type: "spki" });
          } catch {
            /* fall through */
          }
        }
      }
    }
  }
  const mod = Buffer.from(WELL_KNOWN_AIRPORT_N_B64, "base64");
  return createPublicKey({
    key: {
      kty: "RSA",
      ext: true,
      n: mod.toString("base64url"),
      e: Buffer.from("010001", "hex").toString("base64url"),
    },
    format: "jwk",
  }).export({ format: "der", type: "spki" });
}

/** RSA-OAEP encrypt `data` with a DER SPKI public key → ciphertext. */
export function rsaOaepEncrypt(pubDer: Buffer, data: Buffer): Buffer {
  const key = createPublicKey({ key: pubDer, format: "der", type: "spki" });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING }, data);
}

/** AES-128-CBC encrypt `data` (encrypts whole 16-byte blocks, last partial
 *  block left untouched — mirrors libraop's raopcl_encrypt behaviour). */
export function aesCbcEncrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const n = Math.floor(data.length / 16) * 16;
  if (n === 0) return data;
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(data.subarray(0, n)), cipher.final()]);
  return Buffer.concat([enc, data.subarray(n)]);
}

export interface RaopSession {
  session: string;
  audioPort: number;   // server_port from SETUP (audio destination)
  controlPort: number; // control_port from SETUP (sync / loss-detect destination)
  timingPort: number;  // timing_port from SETUP (our reply destination)
}

export interface RaopConnectOptions {
  host: string;
  port?: number; // RTSP port, default 5000
  /** mDNS TXT `pk` (base64) if the device advertises one. */
  pk?: string;
  /** mDNS TXT `et` — enable RSA encryption when it contains "1". */
  et?: string;
  /** Force RSA encryption path even if the device doesn't advertise it. */
  forceRsa?: boolean;
  sampleRate?: number;
}

export type PcmProducer = () => Promise<Buffer | null>;

/** 桥接锚点(§3.3/MAJ-09:四字段必须一起写;由 bridgeMath.computeBridgeAnchors 产出,
 *  BridgeSession 用首帧 tsUs 与 RECORD 协商 L 组装)。 */
export interface RaopBridgeAnchor {
  /** RTP base(32 位回绕安全、352 对齐;baseTs/startTs/headTs 三者同值)。 */
  baseTs: number;
  startTs: number;
  headTs: number;
  /** = ntpFromHostUs(A′ − L);A′ = A + 重采样群延迟补偿(MIN-01,computeBridgeAnchors 内)。 */
  startNtp: bigint;
  /** 补偿后的映射锚点 A′(host µs):接收端播放 RTP baseTs 的时刻。 */
  anchorUsShifted: bigint;
  /** 内容首样本应可听时刻 A(host µs,组时间线域;对齐/漂移换算基准)。 */
  anchorUs: bigint;
  /** L(帧;RECORD 协商,不得为 0 —— 接收端保持缓冲深度,§3.3)。 */
  latencyFrames: number;
  /** 输出采样率(AP1 = 44100;48k 直通协议 = 48000)。 */
  rate: number;
}

// ---------------------------------------------------------------------------
// RTSP request builder
// ---------------------------------------------------------------------------
/**
 * exp4 实验开关(全部缺省关闭 = 现行为):桥 RECORD→首包段对齐 solo 语义。
 *  - MF_BRIDGE_RAOP_CONNECT_PRIME:RECORD 后立即灌静音包(无 SYNC),把「设备见到
 *    RTP 流」的间隔压到 solo 量级,验证 MUZO/Linkplay 是否因长静默期拒绝渲染。
 *  - MF_BRIDGE_RAOP_FIRST_SYNC_NOW:首包时刻 startNtp=now(与 solo 同语义),
 *    验证接收端对 anchor−L 映射的接受度;只动 NTP 锚,RTP 节拍/pacing 不变。
 */
export function raopBridgeConnectPrimeEnabled(): boolean {
  const v = process.env.MF_BRIDGE_RAOP_CONNECT_PRIME;
  return v === "1" || v === "true";
}

export function raopBridgeFirstSyncNowEnabled(): boolean {
  const v = process.env.MF_BRIDGE_RAOP_FIRST_SYNC_NOW;
  return v === "1" || v === "true";
}

export class RaopPlayer {
  opts: RaopConnectOptions & { host: string; port: number; sampleRate: number };
  private rsa = false;
  private aesKey = randomBytes(16);
  private aesIv = randomBytes(16);
  private ssrc = randomBytes(4).readUInt32BE(0);
  private seq = (Math.random() * 0xffff) | 0;
  /** 握手总预算的截止时刻(epoch ms;0 = 不在握手阶段)。见 rtspTimeoutFor。 */
  private handshakeDeadline = 0;
  private headTs = 0;
  private startTs = 0;
  /** `startTs` 对应的真实 NTP 时刻(内容时间线 → 墙钟的锚点)。
   *
   *  为什么必须单独记(2026-10-21 230 测试床实锤):seek 走"完整重建"后,`startTs`
   *  会被重锚成 `baseTs + seekSec*rate`(内容位置),而 RTP→NTP 的换算若仍用
   *  `ts2ntp(headTs)`,SYNC 包就会把"30 秒处的内容"标成"未来 30 秒才播" ——
   *  shairport 实测日志 `Check packet from buffer … 31.08 seconds ahead` /
   *  `crazy time interval of -30.08 seconds`,接收端因此一直等这个时间点,
   *  表现就是**拖动进度后彻底无声**(HiVi 用户反馈同症状)。
   *  正确做法:RTP 时间线只负责包间连续性,NTP 锚点 = 真正开始推流的墙钟时刻。 */
  private startNtp = 0n;
  private baseTs = 0; // RTP ts of file-time 0 (fixed at RECORD; seek re-anchors startTs on it)
  // libraop default latency_frames = 1s of frames (cliraop passes MS2TS(1000,sr));
  // the device derives its RTP hold depth mostly from this sync field, and a
  // too-small value makes it run dry → periodic total silence while progress
  // keeps advancing. Updated from the RECORD reply's Audio-Latency when present.
  private latencyFrames = SAMPLE_RATE;
  private started = false;
  private paused = false;
  private cseq = 0;
  private sid: string;
  private clientInstance: string;
  private challenge: string;
  private session: string | null = null;

  private socket: net.Socket | null = null;
  private ctrlSocket: dgram.Socket | null = null;
  private timeSocket: dgram.Socket | null = null;
  private audioSocket: dgram.Socket | null = null;
  private localIp = "";
  private buffered: Buffer[] = [];
  private producer: PcmProducer | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private streaming = false;
  private destroying = false;
  private stats: { chunks: number; maxGapMs: number; reanchors: number; lastSendMs: number; startMs: number } | null = null;
  private lossRequests = 0;
  /** 桥接路径 latePackets(§3.3):sendAt 已过期仍「追发但不改 RTP 映射」的包数。
   *  连续过期说明启动 lead 不足 —— 由上层(BridgeSession stats tick)报警/重锚。 */
  private bridgeLatePackets = 0;

  // runtime state for the app layer
  positionSec = 0;
  durationSec = 0;

  constructor(opts: RaopConnectOptions) {
    this.opts = {
      host: opts.host,
      port: opts.port ?? 5000,
      sampleRate: opts.sampleRate ?? SAMPLE_RATE,
      pk: opts.pk,
      et: opts.et,
      forceRsa: opts.forceRsa,
    };
    this.rsa = !!opts.forceRsa || !!opts.et?.includes("1");
    this.sid = String(Math.floor(Math.random() * 1e10)).padStart(10, "0");
    this.clientInstance = (Math.random() * 0xffffffffffffffff).toString(16).padStart(16, "0");
    const chal = randomBytes(16);
    this.challenge = Buffer.from(chal).toString("base64").replace(/=+$/, "");
  }

  get encrypted(): boolean { return this.rsa; }
  get isStreaming(): boolean { return this.streaming; }
  get isPaused(): boolean { return this.paused; }

  /**
   * 推流节拍健康度快照(可观测指标)。
   *
   * 此前 `reanchors` / `maxGapMs` 只在 `stream()` 收尾时打一行日志 —— 只能事后归因,
   * 拿不到趋势,也无法在**播放中**判断「此刻是不是已经被拖垮」。现在它是随时可读的指标:
   * 状态接口读它(`getAirPlayStatus().stream`),会话运行期还会周期打点(log)。
   * 没有进行中的流时返回 null。
   */
  get realtimeStats(): RaopRealtimeStats | null {
    const s = this.stats;
    if (!s) return null;
    return {
      chunks: s.chunks,
      reanchors: s.reanchors,
      maxGapMs: s.maxGapMs,
      elapsedMs: Math.max(0, Date.now() - s.startMs),
      lossRequests: this.lossRequests,
    };
  }

  /** 桥接路径 latePackets(§3.3;BridgeSession stats tick 消费)。 */
  get bridgeLateCount(): number {
    return this.bridgeLatePackets;
  }

  /** RECORD 协商的接收端缓冲深度(帧)—— 锚点公式 L 的唯一来源(§3.3:L = latencyFrames/rate
   *  不得归零,接收端保持缓冲深度;RECORD reply 的 Audio-Latency 可抬高,缺省 1s)。 */
  get negotiatedLatencyFrames(): number {
    return this.latencyFrames;
  }

  /** 桥接路径内容跳段(§4.5 欠料超上限 skip / 时间线重锚):RTP 时间线前移 frames 帧。
   *
   *  为什么动 startTs 而不是 baseTs(MAJ-09 语义保持):
   *  - positionSec = (headTs − baseTs)/rate 必须恒等于**内容位置** —— baseTs 是
   *    内容零点的 RTP 锚,永不移动;
   *  - startTs 前移 frames 后,sendSync 的 NTP = startNtp + (headTs − startTs)/rate
   *    恰好把「跳过的 frames」折算进播放头推进 —— 接收端学到的时间线映射
   *    (RTP ↔ 可听时刻)保持自洽,已发包不受影响。
   *  (注:普通重叠裁头不需要本方法 —— 丢弃输出样本后追加流仍连续,RTP 自洽。) */
  bridgeSkipFrames(frames: number): void {
    if (!Number.isFinite(frames) || frames <= 0) return;
    this.startTs = (this.startTs + Math.round(frames)) >>> 0;
  }

  private async bindUdp(): Promise<void> {
    const mk = (reuse: boolean) =>
      new Promise<dgram.Socket>((res, rej) => {
        const s = dgram.createSocket({ type: "udp4", reuseAddr: reuse });
        s.on("error", rej);
        s.bind(0, () => res(s));
      });
    this.timeSocket = await mk(true);
    this.ctrlSocket = await mk(true);
    this.audioSocket = await mk(false);
    this.localIp = this.audioSocket.address().address;
  }

  /**
   * 发一条 RTSP 请求。
   *
   * ⚠️ 请求行必须是 `METHOD url RTSP/1.0` 三段 —— **版本段不能省**(2026-10-20 定位):
   * 此前只发 `METHOD url`,真机 HiVi H5MKII **容错吸收**了非法请求行,所以一直没暴露;
   * 但标准合规的接收端(如 shairport-sync)会直接回 `RTSP/1.0 400 Bad Request`
   * (对端日志 `msg_handle_line fail` / `can't find an RTSP header`),表现为
   * 「ATV/AirPlay 接收器连不上、一个字都放不出来」。用 230 上的 shairport 做 A/B 实测:
   * 无版本段 → 400;补上 `RTSP/1.0` → ANNOUNCE/SETUP/RECORD 全 200。
   */
  private sendRtsp(method: string, body: string | null, contentType: string | null, extra: [string, string][] = []): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    if (!this.socket) return Promise.reject(new Error("RTSP socket closed"));
    return new Promise((resolve, reject) => {
      const headers: [string, string][] = [
        ["CSeq", String(++this.cseq)],
        ["User-Agent", "iTunes/7.6.2 (Windows; N;)"],
        ["Client-Instance", this.clientInstance],
        ["Active-Remote", "ap5918800d"],
      ];
      if (this.session) headers.push(["Session", this.session]);
      if (extra.length) headers.push(...extra);
      let head = ` ${this.url} RTSP/1.0\r\n`;
      let payload = "";
      let extraBody: Buffer | null = null;
      if (contentType && body !== null) {
        payload = body;
        head += `Content-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
      }
      for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
      head += "\r\n";
      const req = Buffer.concat([Buffer.from(method + head, "latin1"), extraBody ?? Buffer.from(payload, "latin1")]);

      let buf = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const sock = this.socket;
      if (!sock) { reject(new Error("RTSP socket closed")); return; }
      const onClose = () => bad(new Error(`RTSP ${method} failed: socket closed`));
      const onErr = (e: unknown) => bad(e instanceof Error ? e : new Error(String(e)));
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        sock.off("data", onData);
        sock.off("close", onClose);
        sock.off("error", onErr);
      };
      const ok = (v: { status: number; headers: Record<string, string>; body: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      };
      const bad = (e: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      };
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        this.socket?.off("data", onData);
        const rawHeaders = buf.slice(0, idx);
        let headBody = buf.slice(idx + 4);
        const firstLine = rawHeaders.split("\r\n")[0];
        const status = Number(firstLine.split(" ")[1] || 0);
        const headersOut: Record<string, string> = {};
        for (const line of rawHeaders.split("\r\n").slice(1)) {
          const i = line.indexOf(":");
          if (i < 0) continue;
          headersOut[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const clen = parseInt(headersOut["content-length"] || "0", 10);
        if (headBody.length < clen) {
          const more = (chunk2: Buffer) => {
            headBody += chunk2.toString("latin1");
            if (headBody.length >= clen) {
              this.socket?.off("data", more);
              finish();
            }
          };
          this.socket?.on("data", more);
          return;
        }
        finish();
        function finish() {
          if (status >= 200 && status < 300) ok({ status, headers: headersOut, body: headBody.slice(0, clen) });
          else bad(new Error(`RTSP ${method} failed: ${firstLine}${headBody ? " — " + headBody.slice(0, 120) : ""}`));
        }
      };
      sock.on("data", onData);
      sock.write(req);
      const waitMs = rtspTimeoutFor(
        method,
        this.handshakeDeadline > 0 ? this.handshakeDeadline - Date.now() : null,
      );
      timer = setTimeout(() => bad(new Error(`RTSP ${method} timeout(${waitMs}ms)`)), waitMs);
      // ★ 连接在等响应期间被关闭/出错:**必须 reject**,不能只 clearTimeout。
      //   旧实现只 `close → clearTimeout`,Promise 永不 settle ⇒ 子进程里的
      //   stop()/cast() 永久挂起(fork 模式 seek 报 `rpc 超时: cast (25000ms)`)。
      sock.once("close", onClose);
      sock.once("error", onErr);
    });
  }

  /** Fire-and-forget RTSP request: write it and resolve immediately without
   *  waiting for (or parsing) the reply. AirPlay volume SET_PARAMETER must be
   *  non-blocking: many receivers (e.g. HiVi H5MKII) accept it silently while
   *  streaming but never reply, and waiting ties up the HTTP handler (frontend
   *  volume slider stalls for the whole timeout). libraop's raopcl_set_volume
   *  is likewise asynchronous.
   *
   *  请求行同样必须带 `RTSP/1.0` 版本段 —— 与 sendRtsp 同一条契约;漏一处就等于
   *  那条控制指令(FLUSH / TEARDOWN / SET_PARAMETER)被合规接收端 400。 */
  private sendRtspNoWait(method: string, body: string | null, contentType: string | null, extra: [string, string][] = []): void {
    if (!this.socket || this.socket.destroyed) return;
    const headers: [string, string][] = [
      ["CSeq", String(++this.cseq)],
      ["User-Agent", "iTunes/7.6.2 (Windows; N;)"],
      ["Client-Instance", this.clientInstance],
      ["Active-Remote", "ap5918800d"],
    ];
    if (this.session) headers.push(["Session", this.session]);
    if (extra.length) headers.push(...extra);
    let head = ` ${this.url} RTSP/1.0\r\n`;
    let payload = "";
    if (contentType && body !== null) {
      payload = body;
      head += `Content-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`;
    }
    for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
    head += "\r\n";
    this.socket.write(Buffer.concat([Buffer.from(method + head, "latin1"), Buffer.from(payload, "latin1")]));
  }

  private sdp(): string {
    const lines = [
      "v=0",
      `o=iTunes ${this.sid} 0 IN IP4 ${this.localIp}`,
      "s=iTunes",
      `c=IN IP4 ${this.opts.host}`,
      "t=0 0",
      "m=audio 0 RTP/AVP 96",
      "a=rtpmap:96 AppleLossless",
      `a=fmtp:96 ${CHUNK_LEN} 0 ${SAMPLE_SIZE} 40 10 14 ${CHANNELS} 255 0 0 ${this.opts.sampleRate}`,
    ];
    if (this.rsa) {
      const pub = resolveRsaPublicKey(this.opts.pk);
      const enc = rsaOaepEncrypt(pub, this.aesKey);
      lines.push(`a=rsaaeskey:${enc.toString("base64").replace(/=+$/, "")}`);
      lines.push(`a=aesiv:${this.aesIv.toString("base64").replace(/=+$/, "")}`);
    }
    return lines.join("\r\n") + "\r\n";
  }

  /** 建会话的**总**上限:bindUdp/建 TCP/三步 RTSP 任何一步卡住都必须失败返回。
   *  只给单步设超时不够 —— 卡在 bindUdp 这类「没有超时」的步骤上时,cast 会一直
   *  悬着并占住设备闸,后续所有流转全部排队(2026-10-21 HiVi 现场)。 */
  async connect(): Promise<RaopSession> {
    const budget = Number(process.env.AIRPLAY_CONNECT_BUDGET_MS) > 0
      ? Number(process.env.AIRPLAY_CONNECT_BUDGET_MS)
      : 12_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`RAOP connect 总超时(${budget}ms)`)), budget);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.doConnect(), timeout]);
    } catch (e) {
      // 半开资源就地收掉:否则下一次 cast 与残留 socket/会话并存。
      try { this.socket?.destroy(); } catch { /* ignore */ }
      try { this.audioSocket?.close(); this.ctrlSocket?.close(); this.timeSocket?.close(); } catch { /* ignore */ }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async doConnect(): Promise<RaopSession> {
    this.destroying = false;
    const tBind = Date.now();
    await this.bindUdp();
    log.debug(`connect: UDP bind 完成 ${Date.now() - tBind}ms (local=${this.localIp})`);
    const tTcp = Date.now();
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: this.opts.host, port: this.opts.port }, () => {
        this.socket = s;
        resolve();
      });
      s.on("error", (e) => reject(e));
      setTimeout(() => reject(new Error("RTSP connect timeout")), 5000).unref();
    });
    log.debug(`connect: RTSP TCP 已连上 ${Date.now() - tTcp}ms`);
    this.url = `rtsp://${this.opts.host}:${this.opts.port}/${this.sid}`;

    // 握手总预算(见 HANDSHAKE_BUDGET_MS):三步串行,单步 10s 会让 cast 撞上 30s 硬顶。
    const hsBudget = Number(process.env.AIRPLAY_HANDSHAKE_BUDGET_MS) > 0
      ? Number(process.env.AIRPLAY_HANDSHAKE_BUDGET_MS)
      : HANDSHAKE_BUDGET_MS;
    this.handshakeDeadline = Date.now() + hsBudget;
    const hsT0 = Date.now();
    let audioPort = 0;
    let controlPort = 0;
    let timingPort = 0;
    try {
      const tAnnounce = Date.now();
      const announce = await this.sendRtsp("ANNOUNCE", this.sdp(), "application/sdp");
      this.session = announce.headers["session"] || null;
      log.debug(`RTSP ANNOUNCE ${announce.status} ${Date.now() - tAnnounce}ms`);

      // SETUP
      const ctrlPort = this.ctrlSocket!.address().port;
      const timePort = this.timeSocket!.address().port;
      const tSetup = Date.now();
      const setup = await this.sendRtsp("SETUP", null, null, [
        ["Transport", `RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=${ctrlPort};timing_port=${timePort}`],
      ]);
      log.debug(`RTSP SETUP ${setup.status} ${Date.now() - tSetup}ms`);
      const t = setup.headers["transport"] || "";
      for (const tok of t.split(";")) {
        const [k, v] = tok.split("=");
        if (k === "server_port") audioPort = parseInt(v, 10);
        if (k === "control_port") controlPort = parseInt(v, 10);
        if (k === "timing_port") timingPort = parseInt(v, 10);
      }
      if (!audioPort) throw new Error("RAOP SETUP: no server_port in Transport response");
      if (setup.headers["session"]) this.session = setup.headers["session"];

      // RECORD
      const ntp0 = ntpNow();
      // 🔴 MAJ-10:ntpNow 已是 host 开机纪元(可达 >27h),必须先 ToUint32 截断、
      // 再对齐(顺序反了会残 32 破坏 352 对齐;`>>> 0` 而非 `& 0xFFFFFFFF`——
      // 后者在边界得 −1,负余数让对齐失效)。唯一出处 bridgeMath.ntpToRtpMod。
      this.headTs = ntpToRtpMod(ntp0, this.opts.sampleRate, CHUNK_LEN);
      this.startTs = this.headTs;
      this.baseTs = this.headTs;
      this.startNtp = ntp0;
      const rtpInfo = `seq=${this.seq};rtptime=${this.headTs}`;
      const tRecord = Date.now();
      const record = await this.sendRtsp("RECORD", null, null, [["Range", "npt=0-"], ["RTP-Info", rtpInfo]]);
      log.debug(`RTSP RECORD ${record.status} ${Date.now() - tRecord}ms (握手总耗时 ${Date.now() - hsT0}ms)`);
      // libraop: Audio-Latency (frames) from the RECORD reply adjusts the latency
      // the device expects us to honor in sync packets. Ours must be >= 1s of
      // frames, matching what cliraop uses by default (MS2TS(1000, sr)); the
      // device-side rtp hold depth is derived from the sync packet's
      // rtp_timestamp_latency field, so a too-small value underruns and stutters.
      const audioLatency = parseInt(record.headers["audio-latency"] || "", 10);
      if (Number.isFinite(audioLatency) && audioLatency > 0) {
        this.latencyFrames = Math.max(audioLatency, this.opts.sampleRate);
        log.info(`audio latency: ${audioLatency} frames -> sync latency ${this.latencyFrames} frames (${Math.round(this.latencyFrames / this.opts.sampleRate * 1000)}ms)`);
      }
    } finally {
      this.handshakeDeadline = 0;
    }

    // ---- RTP plumbing ----
    this.startUdpListeners(controlPort, timingPort);
    return { session: this.session || "", audioPort, controlPort, timingPort };
  }

  private url = "";

  private startUdpListeners(controlRport: number, timingRport: number): void {
    // Audio send target; a failed socket means the stream dies with it, so log
    // it (the stream loop / session finally will tear everything down).
    this.audioSocket!.on("error", (e) => {
      log.error("audio socket error", { host: this.opts.host, err: (e as Error)?.message || e });
      this.streaming = false;
    });
    // Control socket: reply to loss-retransmit requests + periodic sync.
    this.ctrlSocket!.on("message", (msg) => {
      // lost packet request: 4-byte RAOP header + seqno(2) + n(2), type 0x55|0x80
      if (msg.length >= 8 && (msg[1] & 0x7f) === 0x55) {
        const seqno = msg.readUInt16BE(4);
        const n = msg.readUInt16BE(6);
        this.onLoss(seqno, n, controlRport);
      }
      void timingRport;
    });
    // Timing socket: device-initiated NTP → echo back a D3 reply.
    // Layout must mirror libraop's rtp_time_pkt_t (32 bytes):
    //   hdr(4) | dummy(4) | ref_time(8) | recv_time(8) | send_time(8)
    // ref_time echoes the request's send_time (the device stuffs a 32-bit ms
    // counter into its low NTP word) so the device can compute a sane
    // roundtrip (gettime_ms() - reference). recv/send = our current NTP.
    this.timeSocket!.on("message", (msg, rinfo) => {
      const header = msg.subarray(0, 4);
      const reqSendTime = msg.subarray(24, 32);
      const reply = Buffer.alloc(32);
      reply[0] = header[0];
      reply[1] = 0x53 | 0x80;
      reply[2] = header[2];
      reply[3] = header[3];
      reqSendTime.copy(reply, 8);
      const now = ntpNow();
      const sec = Number(now >> 32n);
      const frac = Number(now & 0xffffffffn);
      writeNtp(reply, sec, frac, 16);
      writeNtp(reply, sec, frac, 24);
      this.timeSocket!.send(reply, rinfo.port, rinfo.address);
      log.info(`timing reply ref=${reqSendTime.toString("hex")} ntp=${sec}.${frac.toString(16)}`);
    });
  }

  private audioBacklog = new Map<number, Buffer>();
  private backlogSeq = 0;

  /** exp4 实验开关(MF_BRIDGE_RAOP_CONNECT_PRIME):RECORD 后立即向设备灌 n 包
   *  静音(**无 SYNC**),把「RECORD → 设备见到 RTP 流」的间隔从桥的泵预热 6-7s
   *  压到 solo 量级 —— 验证 MUZO/Linkplay 是否因长静默期拒绝渲染主卧 DLNA 停播后
   *  的桥会话。ts 用 RECORD 协商的 startTs 起点(与真流时间线无关,真流 startTs
   *  由锚点重写);发完复位 started ⇒ 真·首包仍带 marker 位(libraop 语义);
   *  seq 连续不清零(设备侧重序缓冲按 seq 走)。仅实验用,缺省关闭。 */
  primeSilence(count: number): void {
    if (!this.audioSocket || this.destroying || count <= 0) return;
    const savedHead = this.headTs;
    const zeros = Buffer.alloc(CHUNK_LEN * 4);
    this.headTs = this.startTs >>> 0;
    try {
      for (let i = 0; i < count; i++) {
        if (!this.sendChunk(zeros)) break;
      }
    } finally {
      this.headTs = savedHead;
      this.started = false; // 真·首包保留 marker 位
      this.positionSec = ts2ms((this.headTs - this.baseTs) >>> 0, this.opts.sampleRate) / 1000;
    }
    log.info(`prime silence: ${count} chunks (MF_BRIDGE_RAOP_CONNECT_PRIME, no SYNC, marker reserved)`);
  }

  /** Send one ALAC chunk as an RTP audio packet. Returns false when stopped. */
  sendChunk(pcm: Buffer): boolean {
    if (!this.audioSocket || this.destroying) return false;
    const enc = this.rsa ? aesCbcEncrypt(pcmToAlacRaw(pcm, pcm.length / 4, CHUNK_LEN), this.aesKey, this.aesIv) : pcmToAlacRaw(pcm, pcm.length / 4, CHUNK_LEN);
    const first = this.started ? 0 : 0x80;
    if (!this.started) this.started = true;
    this.seq = (this.seq + 1) & 0xffff;
    const pkt = Buffer.alloc(12 + enc.length);
    pkt[0] = 0x80;
    pkt[1] = 0x60 | first;
    pkt.writeUInt16BE(this.seq, 2);
    pkt.writeUInt32BE(this.headTs >>> 0, 4);
    pkt.writeUInt32BE(this.ssrc >>> 0, 8);
    enc.copy(pkt, 12);
    this.audioBacklog.set(this.seq, Buffer.from(pkt));
    if (this.audioBacklog.size > 128) {
      const firstKey = this.audioBacklog.keys().next().value as number;
      this.audioBacklog.delete(firstKey);
    }
    this.audioSocket.send(pkt, 0, pkt.length, this.serverAudioPort, this.opts.host);
    this.headTs = (this.headTs + CHUNK_LEN) >>> 0;
    this.positionSec = ts2ms((this.headTs - this.baseTs) >>> 0, this.opts.sampleRate) / 1000;
    return true;
  }

  private serverAudioPort = 0;
  private serverControlPort = 0;

  private onLoss(seqno: number, n: number, controlPort: number): void {
    this.lossRequests++;
    for (let i = 0; i < n; i++) {
      const idx = (seqno + i) & 0xffff;
      const pkt = this.audioBacklog.get(idx);
      if (!pkt) continue;
      const resend = Buffer.from(pkt);
      resend[0] = 0x80;
      resend[1] = 0x56 | 0x80;
      resend[2] = 0;
      resend[3] = 1;
      if (this.ctrlSocket && controlPort) {
        this.ctrlSocket.send(resend, 0, resend.length, controlPort, this.opts.host);
      }
    }
  }

  /** Periodic sync packet to control port (libraop _raopcl_send_sync). */
  private sendSync(first: boolean): void {
    if (!this.ctrlSocket || !this.started || this.destroying) return;
    const pkt = Buffer.alloc(20);
    pkt[0] = 0x80 | (first ? 0x10 : 0);
    pkt[1] = 0x54 | 0x80;
    pkt[2] = 0;
    pkt[3] = 7;
    pkt.writeUInt32BE((this.headTs - this.latencyFrames) >>> 0, 4);
    // NTP 锚点 = startNtp + (headTs - startTs) 对应的时长 —— **不能用**
    // ts2ntp(headTs):headTs 里含内容偏移(seek 后 +seekSec*rate),直接换算会把
    // 音频标到未来(实测 shairport 报 "31.08 seconds ahead" → 拖动后无声)。
    const elapsedTs = (this.headTs - this.startTs) >>> 0;
    const ntp = this.startNtp + ts2ntp(elapsedTs, this.opts.sampleRate);
    writeNtp(pkt, Number(ntp >> 32n), Number(ntp & 0xffffffffn), 8);
    pkt.writeUInt32BE(this.headTs >>> 0, 16);
    if (this.serverControlPort) this.ctrlSocket.send(pkt, 0, pkt.length, this.serverControlPort, this.opts.host);
  }

  private syncLoop(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      if (this.streaming && !this.paused) this.sendSync(false);
    }, 1000);
    this.syncTimer.unref?.();
  }

  /** Start pulling PCM from `producer` and streaming it.
   *
   *  Pacing: the producer decodes as fast as possible (see control.ts), so the
   *  real-time rhythm must be enforced here against the wall clock — each chunk
   *  carries CHUNK_LEN frames ≈ 7.98ms of audio. A drift-corrected accumulator
   *  keeps the average interval exactly realtime regardless of send cost, and
   *  re-anchors instead of bursting when decode can't keep up. The producer's
   *  PREFILL lead absorbs jitter so we never starve the receiver. */
  async stream(producer: PcmProducer, session: RaopSession): Promise<void> {
    if (session.audioPort) this.serverAudioPort = session.audioPort;
    if (session.controlPort) this.serverControlPort = session.controlPort;
    this.producer = producer;
    this.paused = false;
    this.streaming = true;
    this.syncLoop();
    this.stats = { chunks: 0, maxGapMs: 0, reanchors: 0, lastSendMs: performance.now(), startMs: Date.now() };
    const chunkDurMs = (CHUNK_LEN / this.opts.sampleRate) * 1000;
    // Anchor headTs to the wall clock for the whole stream (libraop gate
    // semantics: every chunk carries startTs + idx*CHUNK_LEN and is sent once
    // the wall clock has reached its slot). headTs therefore never drifts from
    // real time; SYNC 包的 NTP 由 startNtp + (headTs − startTs) 换算(见 sendSync),
    // 与 timing-reply 的 ntpNow() 同源,接收端的每秒校准才不会被 seek 偏移带歪。
    const wallStart = performance.now();
    // 真正开始推流的墙钟锚点:内容 `startTs` 就在这一刻开始播。seek 重建会话后
    // `startTs` 被重锚到内容位置(可能 +30s),SYNC 的 NTP 必须仍取"现在",
    // 否则接收端会把音频当成"未来 N 秒才该播"而一直保持静音(见 startNtp 注释)。
    this.startNtp = ntpNow();
    let idx = 0;
    let firstSyncSent = false;
    // 追赶(burst)时连续发送的包数:每 16 包让出一次事件循环。
    // 子进程里 RPC/IPC/RTSP 响应都靠事件循环的 poll 阶段;若 producer 的 10s
    // jitter buffer 一直有货,`await producer()` 只走微任务,连续数百包会把
    // 消息处理饿死(fork 模式 seek 的 RPC 超时根因之一)。16 包≈128ms 音频,
    // 让出一次 setImmediate 对发流节拍无可感知影响。
    let burst = 0;
    while (this.streaming && !this.destroying) {
      if (this.paused) {
        // Freeze the RTP clock while paused: no chunks go out, so idx (and thus
        // headTs) must not advance or the content timeline desyncs from the PCM.
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const target = wallStart + idx * chunkDurMs;
      const now = performance.now();
      const delay = target - now;
      if (delay > 0) {
        burst = 0;
        await new Promise((r) => setTimeout(r, delay));
      } else {
        // Fell behind (decode/scheduling): send immediately to catch up with
        // the real clock — timestamps stay continuous (no jumps, no holes).
        this.stats.reanchors++;
        if (++burst >= 16) {
          burst = 0;
          await new Promise((r) => setImmediate(r));
        }
      }
      this.headTs = (this.startTs + idx * CHUNK_LEN) >>> 0;
      const pcm = await this.producer();
      if (pcm === null || this.destroying) { log.warn(`stream break: pcm=${pcm !== null} destroying=${this.destroying} streaming=${this.streaming}`); break; }
      if (!this.sendChunk(pcm)) { log.warn(`stream break: sendChunk false, audioSocket=${!!this.audioSocket} destroying=${this.destroying}`); break; }
      // libraop sends the first sync only after the first audio packet has gone
      // out, so the receiver has real data to anchor its latency on.
      if (!firstSyncSent) { firstSyncSent = true; this.sendSync(true); }
      idx++;
      this.stats.chunks++;
      const nowSend = performance.now();
      const gap = nowSend - this.stats.lastSendMs;
      if (gap > this.stats.maxGapMs) this.stats.maxGapMs = gap;
      this.stats.lastSendMs = nowSend;
    }
    this.streaming = false;
    const s = this.stats;
    if (s) {
      const secs = (Date.now() - s.startMs) / 1000;
      log.info(`stream done: ${s.chunks} chunks / ${secs.toFixed(1)}s = ${(s.chunks / Math.max(secs, 0.001)).toFixed(1)}/s (expect ${(44100 / CHUNK_LEN).toFixed(1)}), maxGap=${s.maxGapMs.toFixed(0)}ms, reanchors=${s.reanchors}, loss=${this.lossRequests}`);
    }
  }

  // -------------------------------------------------------------------------
  // 桥接推流路径(Phase 4,spec §3.3/§3.5/§4.5)—— 与旧 stream() 物理分离
  // -------------------------------------------------------------------------

  /** 等到目标 host µs 时刻(桥接节拍专用)。
   *  循环上限 50ms 重读时钟:node 定时器只会晚不会早,保证「不早于 sendAt」判据;
   *  假时钟(测试)与真实定时器解耦时也只多轮询不挂死。 */
  private async waitUntilUs(targetUs: bigint): Promise<void> {
    for (;;) {
      const delayUs = Number(targetUs - nowUs());
      if (delayUs <= 0) return;
      await new Promise((r) => setTimeout(r, Math.min(delayUs / 1000, 50)));
    }
  }

  /**
   * AirPlay 桥接专用推流(四锚点精确驱动,§3.3/§4.5)。
   *
   * 与旧 `stream()`(native cast,墙钟 drift-corrected accumulator)物理分离,互不共用节拍:
   *   - 锚点:四字段一次写齐(MAJ-09)—— baseTs/startTs/headTs 同值 + startNtp = ntp(A′−L);
   *     RTP↔NTP 映射 = SYNC 的 (headTs−L) ↔ startNtp+(headTs−startTs)/rate,首包可听 = A′。
   *   - 节拍:sendAt(i) = audibleAt(i) − L − SAFETY(§3.3),audibleAt(i) = A′ + i·352/rate;
   *     迟到追发不改映射,记 latePackets(连续过期 = lead 不足,上层报警/重锚)。
   *   - 跳段:BridgeSession 漂移对齐发现欠料超上限时经 bridgeSkipFrames() 前移 startTs,
   *     本循环每包按 startTs + idx·CHUNK_LEN 重算 headTs,自动跟随(baseTs 不动 ⇒
   *     positionSec 恒等于内容位置);普通重叠裁头丢弃输出样本即可,RTP 自洽。
   *   - 无 ack 诚实语义(§3.5):本路径绝不伪造设备播放确认;锚点经 scheduledAnchorUs 上报。
   *   - 🔉 bridge 路径禁用 prepareSeek()/setStartPosition()/cast seekSec(AirPlay 无 seek,
   *     seek = 重建会话/换代次,§5.4)。
   */
  async streamBridge(producer: PcmProducer, session: RaopSession, anchor: RaopBridgeAnchor): Promise<void> {
    if (session.audioPort) this.serverAudioPort = session.audioPort;
    if (session.controlPort) this.serverControlPort = session.controlPort;
    this.producer = producer;
    this.paused = false;
    this.streaming = true;
    this.syncLoop();
    this.stats = { chunks: 0, maxGapMs: 0, reanchors: 0, lastSendMs: performance.now(), startMs: Date.now() };
    // 🔴 四字段锚点一次写齐(MAJ-09/§3.3):baseTs/startTs/headTs 同值 + startNtp = ntp(A′−L)。
    //    只替换其中两个会让 positionSec / SYNC 映射当场错乱;模域 >>> 0(MAJ-10)。
    this.baseTs = anchor.baseTs >>> 0;
    this.startTs = anchor.startTs >>> 0;
    this.headTs = anchor.headTs >>> 0;
    this.startNtp = anchor.startNtp;
    // L 不得归零(§3.3):RECORD 协商的接收端保持深度;SYNC offset4 与锚点公式用同一值。
    if (Number.isFinite(anchor.latencyFrames) && anchor.latencyFrames > 0) {
      this.latencyFrames = Math.max(1, Math.round(anchor.latencyFrames));
    }
    this.positionSec = ts2ms((this.headTs - this.baseTs) >>> 0, this.opts.sampleRate) / 1000;
    this.bridgeLatePackets = 0;
    const rate = this.opts.sampleRate;
    let idx = 0; // 已发包数(内容样本 [idx·352, (idx+1)·352) 的序号)
    let firstSyncSent = false;
    let burst = 0;
    /** pacing 重锚偏移(§5.4 暂停恢复):只影响 sendAt,RTP 映射不动。 */
    let pacingShiftUs = 0n;
    while (this.streaming && !this.destroying) {
      if (this.paused) {
        // 冻结 RTP 时钟(与 stream() 同语义):不出包,headTs 不推进。
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      // 先取料再等节拍:producer 阻塞(欠料)期间越过 sendAt ⇒ 记 latePackets,追发不改映射。
      const pcm = await this.producer();
      if (pcm === null || this.destroying) {
        log.warn(`bridge stream break: pcm=${pcm !== null} destroying=${this.destroying} streaming=${this.streaming}`);
        break;
      }
      // 发送节拍(§3.3):sendAt = audibleAt − L − SAFETY(换算唯一出处 bridgeMath)。
      // pacingShiftUs:暂停恢复/长饥饿后的 pacing 重锚(§5.4)—— sendAt 落后墙钟超过
      // BRIDGE_RESUME_REBASE_US ⇒ 内容时间线未变而墙钟前跳,把 pacing 参考前移,
      // RTP 映射(startTs/startNtp)不动,恢复段不计 latePackets;恢复首包立即发出。
      const audible = audibleAtUs(idx * CHUNK_LEN, anchor.anchorUsShifted, rate);
      const sendAt = sendAtUs(audible, anchor.latencyFrames, rate) + pacingShiftUs;
      if (nowUs() < sendAt) {
        burst = 0;
        await this.waitUntilUs(sendAt);
        if (this.paused) {
          // 等待期间被暂停:冻结(不发包、headTs 不推进;本包 ≤8ms 内容让位给暂停点)。
          continue;
        }
      } else {
        const lagUs = Number(nowUs() - sendAt);
        if (lagUs > BRIDGE_RESUME_REBASE_US) {
          // 暂停恢复/长饥饿:整体时间线落后墙钟 → pacing 前移,恢复首包立即发,
          // 后续包按新节拍(不重取料,已取到的本包照发 —— 不得造成内容缺口)。
          pacingShiftUs += BigInt(lagUs);
          log.info(`bridge pacing rebase: +${lagUs}µs (pause/starvation recovery, RTP 映射不动) idx=${idx}`);
        } else {
          this.bridgeLatePackets++;
          if (++burst >= 4) {
            // 连续追赶也让出事件循环(与 stream() 同理:勿饿死 IPC/RTSP 处理;
            // Phase 5 由 16 放宽到 4:追发段最长 4 连发,IPC 响应更及时)。
            burst = 0;
            await new Promise((r) => setImmediate(r));
          }
        }
      }
      // headTs 每包按 startTs + idx·CHUNK_LEN 重算:裁头(bridgeSkipFrames)前移 startTs 后自动跟随。
      this.headTs = (this.startTs + idx * CHUNK_LEN) >>> 0;
      if (!this.sendChunk(pcm)) {
        log.warn(`bridge stream break: sendChunk false, audioSocket=${!!this.audioSocket} destroying=${this.destroying}`);
        break;
      }
      // libraop 语义:首包发出后才发首条 SYNC(接收端有真实数据可锚定)。
      // 此刻 headTs 已被 sendChunk 推进一包 ⇒ SYNC 映射恒定带 ≤8ms 共模滞后
      // (与旧 stream()/libraop 同一口径;同组各设备一致,不影响互相对齐)。
      if (!firstSyncSent) {
        firstSyncSent = true;
        // exp4:首 SYNC 对齐 solo 语义(首个 RTP 出包时刻 startNtp=now)—— 验证
        // MUZO 对 anchor−L 映射的接受度;只动 NTP 锚,RTP 节拍/pacing 不变。缺省关闭。
        if (raopBridgeFirstSyncNowEnabled()) {
          this.startNtp = ntpNow();
          log.info("bridge first SYNC now-semantics (MF_BRIDGE_RAOP_FIRST_SYNC_NOW)");
        }
        this.sendSync(true);
      }
      idx++;
      this.stats.chunks++;
      const nowSend = performance.now();
      const gap = nowSend - this.stats.lastSendMs;
      if (gap > this.stats.maxGapMs) this.stats.maxGapMs = gap;
      this.stats.lastSendMs = nowSend;
      if (idx === 1) log.info(`bridge first packet: deviationUs=${Number(nowUs() - sendAt)} (>=0 means not earlier than sendAt)`);
    }
    this.streaming = false;
    const s = this.stats;
    if (s) {
      const secs = (Date.now() - s.startMs) / 1000;
      log.info(`bridge stream done: ${s.chunks} chunks / ${secs.toFixed(1)}s, maxGap=${s.maxGapMs.toFixed(0)}ms, latePackets=${this.bridgeLatePackets}, loss=${this.lossRequests}`);
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Prepare for an in-place seek WITHOUT tearing down the RTSP session.
   *
   *  Flushes the receiver's audio buffer (RAOP FLUSH with the new anchor),
   *  then resets all per-stream state so a fresh `stream()` call picks up at
   *  file-time `seekSec`: re-anchored startTs (clock keeps its session base),
   *  new RTP seq, first-packet marker, cleared retransmit backlog, stopped
   *  sync timer, and a positionSec that already reflects the target. A FLUSH
   *  rejection is non-fatal: the 0xE0 first-packet marker on the next stream
   *  re-anchors receivers that don't answer FLUSH. */
  async prepareSeek(seekSec: number): Promise<void> {
    this.streaming = false; // no further chunks from the old timeline
    this.paused = false;
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    this.startTs = seekStartTs(this.baseTs, seekSec, this.opts.sampleRate, CHUNK_LEN);
    // ⚠️ **seq 必须保持连续**,不能随机重置(2026-10-21 240 现网「HiVi 拖动后彻底无声」)。
    // RTP 的 16 位 seq 是接收端判丢包的唯一依据:一重置,设备会认为中间缺了一大段包,
    // 持续发 NACK 重传请求(实测 seek 后 loss 每秒 +30),而旧包已清空无从补发 ⇒
    // 设备一直等"丢失的包",时间线停住 = 无声。原地 seek 只需要**新的 rtptime + marker**,
    // seq 继续递增即可(与 libraop 的 flush 语义一致)。
    this.started = false;
    this.audioBacklog.clear();
    this.backlogSeq = 0;
    this.positionSec = seekSec;
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.sendRtsp("FLUSH", null, null, [["RTP-Info", `seq=${this.seq};rtptime=${this.startTs}`]]);
      } catch (e) {
        log.warn(`RAOP FLUSH rejected (${(e as Error)?.message}); relying on first-packet marker`);
      }
    }
  }

  /** 新会话起播时的内容起点(秒):只重锚 RTP 时间线与上报位置,**不发 FLUSH**。
   *  用于「seek 走完整重建」路径 —— 新 RTSP 会话刚建立,没有旧时间线需要冲刷。
   *  (2026-10-21:HiVi 对 FLUSH 后的原地重锚处理不正确 → 拖动后无声,故 seek 改重建。) */
  setStartPosition(seekSec: number): void {
    this.startTs = seekStartTs(this.baseTs, seekSec, this.opts.sampleRate, CHUNK_LEN);
    this.positionSec = seekSec;
    this.started = false;
  }

  /** Send volume via SET_PARAMETER (dB, -30..0). Fire-and-forget: receivers
   *  often never reply while streaming, so waiting blocks the caller. */
  setVolumeDb(db: number): void {
    this.sendRtspNoWait("SET_PARAMETER", `volume: ${db.toFixed(2)}\r\n`, "text/parameters");
    log.info(`SET_PARAMETER volume=${db.toFixed(2)} (no-wait)`);
  }

  /** Reset the stream so a new source can start at a given second. */
  async flush(): Promise<void> {
    this.started = false;
    this.streaming = false;
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
  }

  async stop(): Promise<void> {
    this.destroying = true;
    this.streaming = false;
    this.paused = false;
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    // TEARDOWN (best effort)
    if (this.socket && !this.socket.destroyed) {
      try { await this.sendRtsp("TEARDOWN", null, null); } catch { /* ignore */ }
    }
    this.forceClose();
  }

  /** 强制关闭传输层(不等 TEARDOWN 响应)。
   *
   *  收尾超时兜底专用:子进程里的 RPC(cast/stop)不能因为一条不答 TEARDOWN 的
   *  设备连接被永久挂住 —— `AirplaySessionRuntime.stop()` 用硬上限包住 `stop()`,
   *  超时后调用本方法立刻释放 socket/RTP 端口。幂等。 */
  forceClose(): void {
    this.destroying = true;
    this.streaming = false;
    this.paused = false;
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    try { this.socket?.destroy(); } catch { /* ignore */ }
    for (const s of [this.ctrlSocket, this.timeSocket, this.audioSocket]) {
      try { s?.close(); } catch { /* ignore */ }
    }
  }
}

function writeNtp(buf: Buffer, sec: number, frac: number, off: number): void {
  buf.writeUInt32BE(sec >>> 0, off);
  buf.writeUInt32BE(frac >>> 0, off + 4);
}