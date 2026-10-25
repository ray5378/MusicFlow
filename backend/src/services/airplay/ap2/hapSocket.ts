// ==================== HAP 块加密通道（HAPSocket，Phase 6b 批 2）====================
//
// pair-verify 成功后，RTSP 连接整体升级为本通道（对端 hap.py HAPSocket 逐字对齐）：
//   - 帧格式：2B LE 长度（**不含** 16B tag）+ 密文 + 16B tag；单块明文 ≤ 0x400。
//   - nonce：12B = 4 零字节 ++ 8B LE64(counter)（对端 hap.py
//     `struct.pack("Q", count).rjust(12, b"\x00")` 逐字对齐；in/out 两条独立计数）。
//   - AAD：2B LE 长度字段。
//   - 密钥：HKDF-SHA512(shared, salt="Control-Salt") 两条：
//       "Control-Write-Encryption-Key" = controller 发送 / accessory 接收
//       "Control-Read-Encryption-Key"  = accessory 发送 / controller 接收
//     ⚠️ 方向与角色绑定（hap.py 是 accessory 视角 OUT=Read；我们做 controller，
//     必须发=Write、收=Read —— 两端映射相反，同端互拷即错）。构造时显式选角色。
// 组合模式包装 net.Socket（不继承）：write() 加密后下发；socket data → 解密 →
// 重新发 'data'（明文）。计数器状态即会话状态，不可复制。
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { hkdfSha512 } from "./hapCrypto.js";

const SALT = Buffer.from("Control-Salt", "ascii");
const KEY_WRITE = Buffer.from("Control-Write-Encryption-Key", "utf8");
const KEY_READ = Buffer.from("Control-Read-Encryption-Key", "utf8");
const MAX_BLOCK = 0x400;
const TAG_LEN = 16;
const LEN_LEN = 2;

/** 通道角色：controller（MusicFlow 本体）/ accessory（对端，测试假床用）。 */
export type HapRole = "controller" | "accessory";

/** HAP 帧加密器/解密器（纯逻辑，可独立向量测试）。 */
export class HapCipher {
  private outCount = 0;
  private inCount = 0;
  private readonly outKey: Buffer;
  private readonly inKey: Buffer;

  constructor(sharedKey: Buffer, role: HapRole = "controller") {
    const writeKey = hkdfSha512(sharedKey, SALT, KEY_WRITE, 32);
    const readKey = hkdfSha512(sharedKey, SALT, KEY_READ, 32);
    this.outKey = role === "controller" ? writeKey : readKey;
    this.inKey = role === "controller" ? readKey : writeKey;
  }

  private static nonce(counter: number): Buffer {
    const n = Buffer.alloc(12);
    n.writeBigUInt64LE(BigInt(counter), 4); // 4 零前缀 ++ LE64（hap.py pack("Q").rjust(12)）
    return n;
  }

  /** 加密一个明文块 → 完整帧（2B LE len + ct + tag）。len 超限抛错（调用方分块）。 */
  encryptBlock(plain: Buffer): Buffer {
    if (plain.length > MAX_BLOCK) throw new Error(`块超限 ${plain.length} > ${MAX_BLOCK}`);
    const lenBuf = Buffer.alloc(LEN_LEN);
    lenBuf.writeUInt16LE(plain.length, 0);
    const cipher = createCipheriv("chacha20-poly1305", this.outKey, HapCipher.nonce(this.outCount), {
      authTagLength: TAG_LEN,
    });
    cipher.setAAD(lenBuf, { plaintextLength: plain.length });
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.outCount++;
    return Buffer.concat([lenBuf, ct, tag]);
  }

  /** 解密一个完整帧体（ct+tag），需配 blockLen（AAD）。counter 自动递增。 */
  decryptBlock(blockLen: number, frame: Buffer): Buffer {
    if (frame.length !== blockLen + TAG_LEN) throw new Error(`帧长不符 ${frame.length} ≠ ${blockLen}+16`);
    const lenBuf = Buffer.alloc(LEN_LEN);
    lenBuf.writeUInt16LE(blockLen, 0);
    const decipher = createDecipheriv("chacha20-poly1305", this.inKey, HapCipher.nonce(this.inCount), {
      authTagLength: TAG_LEN,
    });
    decipher.setAAD(lenBuf, { plaintextLength: blockLen });
    decipher.setAuthTag(frame.subarray(frame.length - TAG_LEN));
    const plain = Buffer.concat([
      decipher.update(frame.subarray(0, frame.length - TAG_LEN)),
      decipher.final(),
    ]);
    this.inCount++;
    return plain;
  }

  get outCounter(): number {
    return this.outCount;
  }
  get inCounter(): number {
    return this.inCount;
  }
}

/** HAP 块加密通道：包装 TCP socket，对外暴露明文流。
 *  事件：'data'(明文 Buffer)、'error'、'close'。 */
export class HapChannel extends EventEmitter {
  private readonly cipher: HapCipher;
  private readonly socket: Socket;
  /** 重组缓冲：半块/跨块累积。 */
  private pending: Buffer = Buffer.alloc(0);
  private destroyed = false;

  constructor(socket: Socket, sharedKey: Buffer, role: HapRole = "controller") {
    super();
    this.cipher = new HapCipher(sharedKey, role);
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onCipherData(chunk));
    socket.on("error", (e: Error) => this.emit("error", e));
    socket.on("close", () => {
      if (!this.destroyed) this.emit("close");
    });
  }

  /** 明文写出：按 MAX_BLOCK 分块加密（保序——单线程调用方保证；Node 流本身保序）。 */
  write(plain: Buffer): void {
    if (this.destroyed) throw new Error("HapChannel 已关闭");
    for (let off = 0; off < plain.length; off += MAX_BLOCK) {
      const block = plain.subarray(off, Math.min(plain.length, off + MAX_BLOCK));
      this.socket.write(this.cipher.encryptBlock(block));
    }
  }

  private onCipherData(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= LEN_LEN) {
      const blockLen = this.pending.readUInt16LE(0);
      const frameLen = LEN_LEN + blockLen + TAG_LEN;
      if (this.pending.length < frameLen) return; // 半帧，等下一段
      const frame = this.pending.subarray(LEN_LEN, LEN_LEN + blockLen + TAG_LEN);
      this.pending = this.pending.subarray(frameLen);
      try {
        this.emit("data", this.cipher.decryptBlock(blockLen, frame));
      } catch (e) {
        this.emit("error", new Error(`HAP 帧解密失败: ${(e as Error).message}`));
        this.destroy();
        return;
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.socket.destroy();
  }

  get closed(): boolean {
    return this.destroyed;
  }
}
