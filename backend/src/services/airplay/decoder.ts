// ==================== AirPlay 解码/缓冲层(纯,无主进程依赖) ====================
//
// 从 control.ts 抽出的「ffmpeg 解码 → 有界 PCM 环形队列」这一段:它既被主进程
// (in-proc 会话)使用,也被 airplay 子进程(sessionRuntime)使用 —— 抽成独立模块后,
// 子进程那条路径就不必再经由 control.ts 拖进 DB / DLNA / peer 等主进程态。
//
// Jitter buffer(Music Assistant 风格):ffmpeg 以最快速度解码进缓冲,由 RAOP 发送端
// 按真实时钟拉取**定速** chunk。prefill 保证发送端领先接收端几秒音频,短时解码/网络
// 抖动(云盘 WebDAV、ffmpeg 启动)就不会饿到接收端 ~250ms 的 RAOP 缓冲。
//
// 背压:缓冲超过 MAX_BUFFER_BYTES 就 pause ffmpeg stdout(它随即阻塞在管道写入),
// 掉到低水位再 resume —— 不丢数据、不跳音频,内存被钉在 ~10s 而不是整首歌。
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createRequire } from "module";
import { PCM_BYTES_PER_CHUNK, SAMPLE_RATE } from "./raop.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AIRPLAY");

const PREFILL_MS = 1500; // target decoded-audio lead before the first packet
export const PREFILL_BYTES = Math.round((PREFILL_MS / 1000) * SAMPLE_RATE * 2 * 2); // 44100×16bit stereo

// Cap ≈ 10s of audio (176.4KB/s) —— 足够扛长停顿,又不至于把整首歌驻留内存。
const MAX_BUFFER_MS = 10_000;
export const MAX_BUFFER_BYTES = Math.round((MAX_BUFFER_MS / 1000) * SAMPLE_RATE * 2 * 2);
export const RESUME_BUFFER_BYTES = Math.round(MAX_BUFFER_BYTES / 2);

/** 音量百分比(0-100) → RAOP SET_PARAMETER 的 dB(0→-30dB … 100→0dB)。 */
export function degreesToDb(volume: number): number {
  const v = Math.max(0, Math.min(100, volume));
  if (v <= 0) return -144;
  return -30 + (v / 100) * 30;
}

const require_ = createRequire(import.meta.url);

export function ffmpegBin(): string {
  try {
    const p = require_("ffmpeg-static") as string | undefined;
    if (p) return p;
  } catch {
    /* not installed — fall back to PATH */
  }
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Spawn ffmpeg decoding `url` to raw stereo s16le 44100 PCM on stdout. */
export function spawnDecoder(url: string, seekSec?: number): ChildProcessWithoutNullStreams {
  const args = ["-loglevel", "error", "-hide_banner"];
  if (seekSec && seekSec > 0) args.push("-ss", String(seekSec));
  args.push("-i", url, "-f", "s16le", "-ac", "2", "-ar", String(SAMPLE_RATE), "pipe:1");
  const ff = spawn(ffmpegBin(), args);
  let errBuf = "";
  ff.stderr.on("data", (d: Buffer) => {
    errBuf += d.toString();
    if (errBuf.length > 4096) errBuf = errBuf.slice(-4096);
  });
  ff.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      log.info(`ffmpeg exit code=${code} signal=${signal} stderr=${errBuf.slice(0, 800)}`);
    }
  });
  return ff;
}

/** Build a buffered PCM producer around an ffmpeg decoder.
 *
 *  The producer is *not* paced: it decodes as fast as ffmpeg can and returns a
 *  1408-byte chunk as soon as one is available (resolving on the next stdout
 *  data event, not an 8ms poll). Real-time pacing happens in RaopPlayer.stream()
 *  against the wall clock; the `PREFILL_MS` lead is what absorbs jitter.
 *
 *  Buffering uses an efficient chunk queue: stdout is sliced into fixed
 *  1408-byte chunks right away (O(1) subarray + one small copy each) and pulled
 *  from the front. A single growing `Buffer.concat` accumulator would re-copy
 *  the entire buffered PCM on *every* data event — once decode blasts ahead of
 *  realtime (a fast cloud source decodes a whole track in seconds) that turns
 *  into dozens of MB of copies per second and multi-hundred-ms GC pauses that
 *  stall the sender and make the receiver stutter. */
export function makeProducer(ff: ChildProcessWithoutNullStreams): () => Promise<Buffer | null> {
  const ready: Buffer[] = [];
  let carry = Buffer.alloc(0); // <1408B remainder awaiting the next data event
  let readIdx = 0;
  let ended = false;
  let done = false;
  let prefilled = false;
  let wake: (() => void) | null = null;
  let totalBytes = 0;

  const bufferedBytes = (): number =>
    (ready.length - readIdx) * PCM_BYTES_PER_CHUNK + carry.length;

  ff.stdout.on("data", (d0: Buffer) => {
    totalBytes += d0.length;
    let d = d0;
    if (carry.length) {
      const need = PCM_BYTES_PER_CHUNK - carry.length;
      if (d.length >= need) {
        ready.push(Buffer.from(Buffer.concat([carry, d.subarray(0, need)])));
        d = d.subarray(need);
        carry = Buffer.alloc(0);
      } else {
        carry = Buffer.concat([carry, d]);
        d = Buffer.alloc(0);
      }
    }
    while (d.length >= PCM_BYTES_PER_CHUNK) {
      ready.push(Buffer.from(d.subarray(0, PCM_BYTES_PER_CHUNK)));
      d = d.subarray(PCM_BYTES_PER_CHUNK);
    }
    if ((d as Buffer).length) carry = Buffer.from(d as Buffer);
    if (wake) { const w = wake; wake = null; w(); }
    // Backpressure: stop pulling from ffmpeg before the buffered PCM grows past
    // MAX_BUFFER_BYTES. pause() stops our 'data' events, the pipe fills up and
    // ffmpeg blocks on its write — zero data lost, no audio skipped, and memory
    // stays bounded to ~10s instead of an entire track.
    if (!ended && bufferedBytes() >= MAX_BUFFER_BYTES) ff.stdout.pause();
  });
  ff.stdout.on("end", () => { ended = true; log.info(`producer stdout end: totalBytes=${totalBytes} (${(totalBytes / (SAMPLE_RATE * 4)).toFixed(1)}s audio)`); if (wake) { const w = wake; wake = null; w(); } });
  ff.on("exit", (code, signal) => { ended = true; log.info(`producer ffmpeg exit code=${code} signal=${signal} totalBytes=${totalBytes}`); if (wake) { const w = wake; wake = null; w(); } });

  const waitData = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      // Only resolve on the next stdout chunk (or stream end). Early-resolving
      // on buffer fullness here would busy-spin the prefill loop (every call
      // returns immediately once ≥1 chunk is buffered, before ffmpeg's data
      // events ever get a chance to run → 100% CPU stall).
      if (ended) return resolve(true);
      const t = setTimeout(() => { wake = null; resolve(false); }, timeoutMs);
      wake = () => { clearTimeout(t); resolve(true); };
    });

  const nextChunk = (): Buffer | null => {
    if (readIdx < ready.length) {
      const c = ready[readIdx];
      ready[readIdx] = (null as unknown) as Buffer;
      readIdx++;
      // Compact the consumed head periodically to avoid an ever-growing array.
      if (readIdx > 2048 && readIdx * 2 > ready.length) {
        ready.splice(0, readIdx);
        readIdx = 0;
      }
      return c;
    }
    // consume the partial tail only when the stream has ended
    if (ended && carry.length) {
      const tail = carry;
      carry = Buffer.alloc(0);
      return tail;
    }
    return null;
  };

  // Resume ffmpeg once the buffered PCM has drained below the low-water mark
  // (half the cap). Called on every pull so backpressure never dead-locks: pause
  // only kicks in while the queue is at/above the cap, and every consumed chunk
  // is an opportunity to restart the pipe.
  const maybeResume = (): void => {
    if (ff.stdout.isPaused() && bufferedBytes() <= RESUME_BUFFER_BYTES) ff.stdout.resume();
  };

  return async (): Promise<Buffer | null> => {
    if (done) return null;
    maybeResume();
    if (!prefilled) {
      // First pull: wait until enough decoded audio is buffered to ride out
      // short stalls (decode start, WebDAV hiccup) without an audible gap.
      while (!ended && bufferedBytes() < PREFILL_BYTES) {
        const ok = await waitData(30000);
        if (!ok) { done = true; return null; }
      }
      prefilled = true;
    }
    const c = nextChunk();
    if (c) return c;
    if (!ended) {
      if (!(await waitData(30000))) { done = true; return null; }
      maybeResume();
      const c2 = nextChunk();
      if (c2) return c2;
    }
    done = true;
    return null;
  };
}
