// ==================== realtime 音频 RTP/UDP 发送（Phase 6b 批 3）====================
//
// 对端 ap2/connections/audio.py RTP/RTP_REALTIME 逐字对齐（接收端解析即权威）：
//   包 = 12B 头 ++ [ChaCha20-Poly1305 密文 ++ 16B tag] ++ 8B nonce
//   - 头：V=2(0x80) | M|PT(7b) | seq(2B BE) | timestamp(4B BE) | ssrc(4B BE)
//   - AAD = 头 [4..12]（timestamp+ssrc 8B）；tag 16B；nonce 8B 由发送端生成放包尾
//   - 密钥 = SETUP streams[0].shk（32B，发送端生成）
//   - ChaCha nonce(12B) = 4 零前缀 ++ 包尾 8B nonce（pycryptodome 8B nonce 语义，
//     与批 1 nonce8() 实测互操作一致）
// 不带 RFC2198 冗余（feature bit 61 才启用，Bed/真机均不要求）。
import { createCipheriv } from "node:crypto";

const TAG_LEN = 16;
const NONCE_LEN = 8;

/** 单帧加密（AAD = ts+ssrc 8B）。返回 [密文+tag, 包尾 8B nonce]。 */
function encryptFrame(
  key: Buffer,
  nonce8: Buffer,
  aad: Buffer,
  plain: Buffer,
): { body: Buffer; nonce8: Buffer } {
  if (key.length !== 32) throw new Error(`session key 必须 32B，实际 ${key.length}`);
  if (nonce8.length !== NONCE_LEN) throw new Error("nonce 必须 8B");
  const n12 = Buffer.alloc(12);
  nonce8.copy(n12, 4); // 4 零前缀 ++ 8B nonce
  const cipher = createCipheriv("chacha20-poly1305", key, n12, { authTagLength: TAG_LEN });
  cipher.setAAD(aad, { plaintextLength: plain.length });
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { body: Buffer.concat([ct, Buffer.from(cipher.getAuthTag())]), nonce8 };
}

export interface RtpRealtimeOptions {
  ssrc?: number;
  payloadType?: number; // 默认 96（dynamic；接收端仅记录不校验）
}

/** realtime 音频 RTP 打包器：`next(alacFrame)` 产出完整 UDP 包。 */
export class RtpRealtimeSender {
  private seq = 0;
  private ts = 0;
  private readonly ssrc: number;
  private readonly pt: number;
  private nonceCounter = 0;

  constructor(
    private readonly sessionKey: Buffer,
    opts: RtpRealtimeOptions = {},
  ) {
    this.ssrc = opts.ssrc ?? 0x4d464142; // "MFAB"
    this.pt = opts.payloadType ?? 96;
  }

  get sequence(): number {
    return this.seq;
  }

  get timestamp(): number {
    return this.ts;
  }

  /** 打包一帧并推进 seq/ts（ts 步进 = 帧样本数，调用方传 spf）。 */
  next(alacFrame: Buffer, samplesPerFrame: number): Buffer {
    const header = Buffer.alloc(12);
    header[0] = 0x80; // V=2, P=0, X=0, CC=0
    header[1] = this.pt & 0x7f; // M=0, PT
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.ts >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);

    // 包尾 nonce：8B 大端计数器（确定性、可抓包复现；接收端按包取用）
    const nonce8 = Buffer.alloc(8);
    nonce8.writeBigUInt64BE(BigInt(this.nonceCounter++), 0);

    const aad = header.subarray(4, 12);
    const { body } = encryptFrame(this.sessionKey, nonce8, aad, alacFrame);
    const pkt = Buffer.concat([header, body, nonce8]);

    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + samplesPerFrame) >>> 0;
    return pkt;
  }
}

/** UDP 发送小封装（包级 sendto，错误不中断流；错误经 onError 上报供上层判定）。 */
export class UdpAudioSink {
  private udp: import("node:dgram").Socket | null = null;
  private host = "";
  private port = 0;
  /** 连续发送错误数（成功发送会清零）；用于上层判定「端口不可达」并收敛状态。 */
  private errorStreak = 0;
  private lastErrorText: string | null = null;

  constructor(private readonly opts: { onError?: (e: Error) => void } = {}) {}

  async connect(host: string, port: number): Promise<void> {
    const dgram = await import("node:dgram");
    this.udp = dgram.createSocket("udp4");
    this.host = host;
    this.port = port;
    this.errorStreak = 0;
    this.lastErrorText = null;
    this.udp.on("error", (e: Error) => {
      // 单包错误不中断；持续错误由上层（连续错误阈值）收敛为链路失败。
      this.errorStreak++;
      this.lastErrorText = e.message;
      this.opts.onError?.(e);
    });
  }

  /** 发送一包；`onSent` 在 send 回调成功后触发（用于清错误连击计数）。 */
  send(pkt: Buffer): void {
    const sock = this.udp;
    if (!sock) return;
    sock.send(pkt, this.port, this.host, (err) => {
      if (err) {
        this.errorStreak++;
        this.lastErrorText = err.message;
        this.opts.onError?.(err);
        return;
      }
      this.errorStreak = 0;
    });
  }

  get stats(): { errorStreak: number; lastError: string | null } {
    return { errorStreak: this.errorStreak, lastError: this.lastErrorText };
  }

  destroy(): void {
    const sock = this.udp;
    this.udp = null;
    if (!sock) return;
    try {
      sock.close();
    } catch {
      /* 已关闭 */
    }
  }
}
