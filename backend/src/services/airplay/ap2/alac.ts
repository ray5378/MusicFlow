// ==================== ALAC escape 模式编码器（Phase 6b 批 3）====================
//
// 产出合法 Apple ALAC 码流（ffmpeg/PyAV 语法，逐字对齐 libavcodec/alac.c decode_element）：
//   3bit  element=TYPE_CPE(1)      —— 立体声一组
//   4bit  instance tag（0）
//   12bit 保留（0）
//   1bit  has_size=1 → 32bit 样本数
//   2bit  extra_bits=0
//   1bit  压缩标志=0（0 = 未压缩 escape 帧；解码端 is_compressed = !bit）
//   样本区：按 (样本 i, 通道 ch) 交织，每样本 sample_size 位大端有符号
//   3bit  element=TYPE_END(7)，随后补零到字节边界（解码端允许 ≤8 bit 残留）
//
// 设计权衡：escape 模式 = 容器合法、样本未压缩（352×2ch×16bit ≈ 1418B/帧，MTU 内），
// 换取零编码延迟与极小实现面；真机若带宽吃紧再补 rice/LPC 压缩路径。
// 跨实现验证：TS 编码 → 床 venv PyAV(alac) 解码 → PCM 逐字节还原。
const TYPE_CPE = 1;
const TYPE_END = 7;

export class AlacError extends Error {}

/** ALAC 帧编码器（16bit 立体声，spf=每帧样本数）。 */
export class AlacEncoder {
  readonly spf: number;
  private readonly sampleSize: number;

  constructor(opts: { spf: number; sampleSize?: number }) {
    if (opts.spf <= 0 || opts.spf > 65535) throw new AlacError(`spf 非法: ${opts.spf}`);
    this.spf = opts.spf;
    this.sampleSize = opts.sampleSize ?? 16;
    if (this.sampleSize !== 16) throw new AlacError("当前仅支持 16bit（bed/真机 realtime 主路径）");
  }

  /** 每帧输入字节数：spf × 2ch × 2B（s16le 交织）。 */
  get frameBytes(): number {
    return this.spf * 2 * 2;
  }

  /** PCM(s16le 交织) → ALAC escape 帧。输入不足整帧抛错（调用方补齐/丢弃尾帧）。 */
  encodeFrame(pcm: Buffer): Buffer {
    if (pcm.length !== this.frameBytes) {
      throw new AlacError(`输入 ${pcm.length}B ≠ 整帧 ${this.frameBytes}B`);
    }
    const bits: number[] = []; // 简单位池：每元素一个 bit（帧级量级，性能可接受）
    const put = (value: number, n: number): void => {
      for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };

    put(TYPE_CPE, 3);
    put(0, 4); // instance tag
    put(0, 12); // 保留
    put(1, 1); // has_size
    put(0, 2); // extra_bits
    put(1, 1); // 未压缩（escape）—— ffmpeg: is_compressed = !bit ⇒ bit=1 才是未压缩
    put(this.spf, 32); // 样本数（has_size=1 时紧跟压缩标志位之后）
    // 样本：s16le 小端字节对 → 有符号 16bit，按 (i, ch) 交织写入
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < this.spf; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const v = dv.getInt16((i * 2 + ch) * 2, true);
        put(v & 0xffff, 16); // 补码位型直接写
      }
    }
    put(TYPE_END, 3);

    const outBytes = Math.ceil(bits.length / 8);
    const out = Buffer.alloc(outBytes);
    for (let b = 0; b < bits.length; b++) {
      if (bits[b]) out[b >> 3] |= 0x80 >> (b & 7);
    }
    return out;
  }
}
