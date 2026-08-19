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
import { createLogger } from "../../utils/logger.js";

const log = createLogger("RAOP");

export const SAMPLE_RATE = 44100;
export const SAMPLE_SIZE = 16;
export const CHANNELS = 2;
export const CHUNK_LEN = 352;              // frames per RTP packet (DEFAULT_FRAMES_PER_CHUNK)
export const PCM_BYTES_PER_CHUNK = CHUNK_LEN * CHANNELS * (SAMPLE_SIZE / 8); // 1408
export const RAOP_LATENCY_MIN = 11025;     // frames (libraop's LATENCY_MIN)
export const NTP_EPOCH_DELTA = 2208988800; // seconds 1970→1900

// ---------------------------------------------------------------------------
// NTP / timestamp helpers (mirror libraop macros)
// ---------------------------------------------------------------------------
export function ntpNow(): bigint {
  // Monotonic NTP: libraop anchors everything on gettime_us() (monotonic), and
  // the device only ever consumes NTP *differences*, so the epoch is arbitrary
  // as long as it never jumps. Using the wall clock here would let an NTP daemon
  // step corrupt the (rtp_remote - remote) deltas the receiver relies on.
  const ms = performance.now();
  const sec = BigInt(Math.floor(ms / 1000));
  const frac = (BigInt(Math.trunc(ms)) << 32n) / 1000n;
  return (sec << 32n) | frac;
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

// ---------------------------------------------------------------------------
// RTSP request builder
// ---------------------------------------------------------------------------
export class RaopPlayer {
  opts: RaopConnectOptions & { host: string; port: number; sampleRate: number };
  private rsa = false;
  private aesKey = randomBytes(16);
  private aesIv = randomBytes(16);
  private ssrc = randomBytes(4).readUInt32BE(0);
  private seq = (Math.random() * 0xffff) | 0;
  private headTs = 0;
  private startTs = 0;
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
      let head = ` ${this.url}\r\n`;
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
          if (status >= 200 && status < 300) resolve({ status, headers: headersOut, body: headBody.slice(0, clen) });
          else reject(new Error(`RTSP ${method} failed: ${firstLine}${headBody ? " — " + headBody.slice(0, 120) : ""}`));
        }
      };
      const sock = this.socket;
      if (!sock) { reject(new Error("RTSP socket closed")); return; }
      sock.on("data", onData);
      sock.write(req);
      const t = setTimeout(() => {
        sock.off("data", onData);
        reject(new Error(`RTSP ${method} timeout`));
      }, 10000);
      sock.once("close", () => clearTimeout(t));
    });
  }

  /** Fire-and-forget RTSP request: write it and resolve immediately without
   *  waiting for (or parsing) the reply. AirPlay volume SET_PARAMETER must be
   *  non-blocking: many receivers (e.g. HiVi H5MKII) accept it silently while
   *  streaming but never reply, and waiting ties up the HTTP handler (frontend
   *  volume slider stalls for the whole timeout). libraop's raopcl_set_volume
   *  is likewise asynchronous. */
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
    let head = ` ${this.url}\r\n`;
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

  async connect(): Promise<RaopSession> {
    this.destroying = false;
    await this.bindUdp();
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: this.opts.host, port: this.opts.port }, () => {
        this.socket = s;
        resolve();
      });
      s.on("error", (e) => reject(e));
      setTimeout(() => reject(new Error("RTSP connect timeout")), 8000).unref();
    });
    this.url = `rtsp://${this.opts.host}:${this.opts.port}/${this.sid}`;

    const announce = await this.sendRtsp("ANNOUNCE", this.sdp(), "application/sdp");
    this.session = announce.headers["session"] || null;

    // SETUP
    const ctrlPort = this.ctrlSocket!.address().port;
    const timePort = this.timeSocket!.address().port;
    const setup = await this.sendRtsp("SETUP", null, null, [
      ["Transport", `RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=${ctrlPort};timing_port=${timePort}`],
    ]);
    let audioPort = 0;
    let controlPort = 0;
    let timingPort = 0;
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
    this.headTs = ntp2ts(ntpNow(), this.opts.sampleRate);
    this.headTs -= this.headTs % CHUNK_LEN;
    this.startTs = this.headTs;
    const rtpInfo = `seq=${this.seq};rtptime=${this.headTs}`;
    const record = await this.sendRtsp("RECORD", null, null, [["Range", "npt=0-"], ["RTP-Info", rtpInfo]]);
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
    this.positionSec = (ts2ms((this.headTs - this.startTs) >>> 0, this.opts.sampleRate)) / 1000;
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
    const ntp = ts2ntp(this.headTs, this.opts.sampleRate);
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
    // real time, so sync-packet ts2ntp(headTs) and timing-reply ntpNow() always
    // share the same clock base — the receiver's per-second synchro recalcs
    // stay correct instead of muting in a fixed rhythm.
    const wallStart = performance.now();
    let idx = 0;
    let firstSyncSent = false;
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
        await new Promise((r) => setTimeout(r, delay));
      } else {
        // Fell behind (decode/scheduling): send immediately to catch up with
        // the real clock — timestamps stay continuous (no jumps, no holes).
        this.stats.reanchors++;
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

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
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
    this.socket?.destroy();
    for (const s of [this.ctrlSocket, this.timeSocket, this.audioSocket]) {
      try { s?.close(); } catch { /* ignore */ }
    }
  }
}

function writeNtp(buf: Buffer, sec: number, frac: number, off: number): void {
  buf.writeUInt32BE(sec >>> 0, off);
  buf.writeUInt32BE(frac >>> 0, off + 4);
}