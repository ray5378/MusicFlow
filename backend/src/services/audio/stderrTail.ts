// ==================== ffmpeg stderr 的「尾部保留」缓冲（P0-4） ====================
//
// loudnorm 的 JSON 报告打在 stderr 的**最末尾**，解析侧正是按「从后往前找」实现的：
//   - 本仓 `audio/loudness.ts::parseLoudnorm` 用 lastIndexOf 定位 `input_i`；
//   - MA `music-assistant/server@76c2fcb` `helpers/audio.py:881-901` `parse_loudnorm`
//     用 `stderr_data.rfind("[Parsed_loudnorm_")`，其注释原文：the report is the **last**
//     thing the filter logs, and ffmpeg prints it as a block of its own below the marker line。
//
// 因此任何**带字节上限**的 stderr 累积都必须「丢开头、留末尾」。反例（2026-09-20 审出并修）：
// 写成「length >= 上限就不再追加」会**冻结在流的开头**。实时播放 stderr ≈ 190 B/s
// （上机实测 `-re` 12s → 2275B / 25 次 stats 更新）⇒ AirPlay（64KB）超过约 5.7 分钟、
// Sendspin（128KB）超过约 11.5 分钟的曲目**永远解析不到测量值**，而且**不报错**（静默失败）。
// MA 侧不做上限（`controllers/streams/smart_fades/fades.py:168-174` 逐行 drain 全存），
// 我们为内存保留上限，但方向必须一致：留末尾。
//
// 三处共用（此前各写各的，两处方向写反了）：
//   `sendspin/streamSource.ts`(PcmWindow) · `airplay/decoder.ts`(spawnDecoder)
//   · `audio/offlineMeasure.ts`(captureFfmpegStderr —— 本来就是「留末尾」的对写法，作为基线)。

/** 通用保留上限：64KB（足够放下 loudnorm JSON 报告及其前后文）。 */
export const STDERR_KEEP_BYTES = 64 * 1024;

/** 只保留**最近** `keep` 字节的 stderr 累积器（超限丢开头，末尾永远在）。 */
export class StderrTail {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly keep: number = STDERR_KEEP_BYTES) {
    if (!Number.isFinite(keep) || keep <= 0) throw new Error(`StderrTail 上限非法: ${keep}`);
  }

  /** 追加一块 stderr（字节或字符串）。 */
  push(chunk: Buffer | string): void {
    const d = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (d.length === 0) return;
    // 关键：超限时丢**开头**。subarray 是视图，底层至多比 keep 多一块 chunk，不会无界增长。
    const merged = Buffer.concat([this.buf, d]);
    this.buf = merged.length > this.keep ? merged.subarray(merged.length - this.keep) : merged;
  }

  /** 当前保留的文本（解析 loudnorm JSON 用）。 */
  text(): string {
    return this.buf.toString("utf8");
  }

  /** 当前保留的字节数（测试 / 日志用）。 */
  get length(): number {
    return this.buf.length;
  }

  /** 清空。 */
  clear(): void {
    this.buf = Buffer.alloc(0);
  }
}
