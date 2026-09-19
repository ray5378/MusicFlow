// ==================== PCM AudioBuffer(管道两段式中间件) ====================
//
// 两段式管道(见 pipeline.ts/P1-1)的中间件:① 解码段把 ffmpeg 吐出的 F32 交错
// PCM 往里追加;② 出流段按绝对样本下标取片喂第二个 ffmpeg 的 stdin。
// 口径与 sendspin PcmWindow 一致(曲首起算的绝对交错样本),但本类是**哑容器**:
// 不起进程、不做背压策略(由持有方按水位停读/淘汰),只保证下标数学正确。
// 将来 PcmWindow 可收敛到它,现阶段不动热链,只给新管道用。
export class AudioBuffer {
  /** chunks[0][0] 对应的绝对交错样本下标。 */
  private baseSample = 0;
  private chunks: Float32Array[] = [];
  private bufferedSamples = 0;

  /** 已解出总量(绝对下标,== baseSample ＋ 块内样本数)。 */
  get decodedSamples(): number {
    return this.baseSample + this.bufferedSamples;
  }

  /** 当前窗口内样本数。 */
  get buffered(): number {
    return this.bufferedSamples;
  }

  /** 窗口起始绝对下标(淘汰后前移)。 */
  get base(): number {
    return this.baseSample;
  }

  /** 追加一块 F32 交错 PCM(调用方保证与之前同声道数/采样率)。空块忽略。 */
  append(chunk: Float32Array): void {
    if (!chunk || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bufferedSamples += chunk.length;
  }

  /**
   * 取 [lo, hi) 绝对下标(拷贝返回)。超出已解范围按 EOF 语义截断(可能短片/空);
   * lo 已被淘汰则抛 RangeError(调用方 seekTo 重定位,见 PcmWindow 同构语义)。
   */
  slice(lo: number, hi: number): Float32Array {
    if (hi <= lo) return new Float32Array(0);
    if (lo < this.baseSample) {
      throw new RangeError(
        `AudioBuffer.slice 越界:lo=${lo} 已被淘汰(base=${this.baseSample})`,
      );
    }
    const end = Math.min(hi, this.decodedSamples);
    if (end <= lo) return new Float32Array(0);
    const out = new Float32Array(end - lo);
    let at = 0;
    let cursor = this.baseSample;
    for (const c of this.chunks) {
      const cEnd = cursor + c.length;
      if (cEnd <= lo || cursor >= end) {
        cursor = cEnd;
        continue;
      }
      const from = Math.max(lo, cursor) - cursor;
      const to = Math.min(end, cEnd) - cursor;
      out.set(c.subarray(from, to), at);
      at += to - from;
      cursor = cEnd;
      if (at >= out.length) break;
    }
    return out.subarray(0, at);
  }

  /**
   * 淘汰到 keepFrom 之前的块(调用方按"已消费 - 历史保留"算 keepFrom)。
   * 只从头删,复杂度与淘汰块数成正比,与总量无关。
   */
  evictBefore(keepFrom: number): void {
    while (this.chunks.length > 0) {
      const first = this.chunks[0];
      if (this.baseSample + first.length > keepFrom) break;
      this.chunks.shift();
      this.baseSample += first.length;
      this.bufferedSamples -= first.length;
    }
  }

  /** 清空(切歌/停播)。 */
  clear(): void {
    this.chunks = [];
    this.bufferedSamples = 0;
    // baseSample 保留:调用方若复用同一 buffer 播下一首,应先 reset()。
  }

  /** 重置基址(新曲从 0 开始时调,与 clear 配合)。 */
  reset(): void {
    this.clear();
    this.baseSample = 0;
  }
}
