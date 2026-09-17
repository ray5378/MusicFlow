// ==================== Sendspin 推流引擎(组时间线泵) ====================
//
// 真实音频链路:解析歌曲可播流 → ffmpeg 解码为 F32/48k 立体声 → 按组时间线切帧 →
// SendspinGroup.pushFrame(对每个成员独立编码 opus/flac/pcm 后下发)。同步维护
// group.positionMs 与 group.current,供 QueueController 的 pollState/自动切歌判定。
//
// 事件调度:按真实时间推进(每 ~100ms 一帧)。这是服务器权威播放的关键 ——
//   - pollAllDevices(QueueController 每 5s)上报 PLAYING/position,PlaybackTracker
//     据此记录 lastPlaying 并关闭乐观窗口;
//   - 帧推完(自然结束)时置空 group.current → 下一次 poll 上报 IDLE →
//     PlaybackTracker 看到 lastPlaying(PLAYING)→IDLE 判定"自然结束" → auto-advance。
//   - 若不按真实时间推进而是瞬间推完,首帧 poll 很可能先于乐观窗口(5s)错过
//     PLAYING,idle 又无 lastPlaying → 既不 advance 也不 stalled,队列卡死。
//     (DLNA 靠设备 GENA 秒级确认,无需此节奏;Sendspin 无设备回调,靠本节奏自洽。)
//
// 通过 SENDSPIN_PUSH_SPEED(>0)可加快推流节奏(纯测试/演示用,默认 1 = 实时)。
//
// 通过 overridePumpSource 可注入测试音源(真实本地 WAV),默认走
// ensurePlayableStream 解析真实网络曲源。

import { SAMPLE_RATE, CHANNELS, decodeToF32 } from "./encoding.js";
import type { SendspinServer, SendspinGroup } from "./server.js";

export interface GroupAudio {
  pcm: Float32Array;
  durationMs: number;
}

/** 解析某首歌的可播字节(默认真实);测试可注入。 */
export type PumpSource = (songId: string) => Promise<GroupAudio>;

let injectedSource: PumpSource | null = null;
/** 测试注入音源;传 null 恢复默认真实解析。 */
export function overridePumpSource(fn: PumpSource | null): void {
  injectedSource = fn;
}

export const FRAME_MS = 100;

/** 默认音源:统一裁决(resolvePlayableRow,与 /rest/stream 同口径) → 取字节 → 解码。
 *  整个文件解码为内存 F32(功能性实现;长曲适度占用,见引擎头部说明)。 */
async function defaultSource(songId: string): Promise<GroupAudio> {
  const tS = Date.now();
  const { resolvePlayableRow, fetchRowBytes } = await import("../source/resolveAudio.js");
  const r = await resolvePlayableRow(songId);
  console.log(`[streamEngine][src] t=${Date.now()} ${songId}: resolve ms=${Date.now() - tS} -> ${r.row ? r.row.id : "null"} (${r.reason})`);
  if (!r.row) throw new Error(`no playable stream for ${songId} (${r.reason})`);
  const bytes = await fetchRowBytes(r.row);
  if (!bytes) throw new Error(`fetch bytes failed for ${songId} (${r.reason})`);
  const d0 = Date.now();
  const pcm = await decodeToF32(bytes);
  console.log(`[streamEngine][src] t=${Date.now()} ${songId}: decode ms=${Date.now() - d0}`);
  const durationMs = bufferDurationMs(pcm);
  return { pcm, durationMs };
}

function bufferDurationMs(pcm: Float32Array): number {
  const perSec = SAMPLE_RATE * CHANNELS; // interleaved frames per second
  return Math.round((pcm.length / perSec) * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 对某个组驱动连续推流。同一组同时只允许一个 active pump。
 *
 * 状态机:
 *   - running = 当前是否持有已加载曲目并处于推流主循环;
 *   - paused  = 暂停标志(推流主循环挂起不推进,position 冻结);
 *   - epoch   = 每次 play 自增,使旧的推流循环失效(避免重叠)。
 *
 * 支持 pause/resume/seek(seek 直接改写 positionMs,主循环按 position 取帧)。
 */
export class GroupPump {
  private group: SendspinGroup;
  private server: SendspinServer;
  /** 推流节奏倍速(>1 加速,演示/测试用);默认 1 = 实时。 */
  private speed: number;

  private running = false;
  private paused = false;
  private epoch = 0;
  private pcm: Float32Array | null = null;
  private durationMs = 0;
  private songId = "";
  // 暂停时被唤醒的等待器。
  private resumeWaiter: (() => void) | null = null;
  // 上一首是否已"自然播完"(用于结束时置空 current 触发 auto-advance)。
  private endedNaturally = false;

  constructor(server: SendspinServer, group: SendspinGroup) {
    this.server = server;
    this.group = group;
    const s = Number(process.env.SENDSPIN_PUSH_SPEED);
    this.speed = Number.isFinite(s) && s > 0 ? s : 1;
  }

  get active(): boolean {
    return this.running;
  }

  /** 播放一个音频缓冲:按组时间线切帧推送,推进 positionMs。 */
  async play(songId: string): Promise<void> {
    const source = injectedSource ?? defaultSource;
    const { pcm, durationMs } = await source(songId);
    const myEpoch = ++this.epoch;
    this.running = true;
    this.paused = false;
    this.pcm = pcm;
    this.durationMs = durationMs;
    this.songId = songId;
    this.endedNaturally = false;
    this.group.current = { songId, durationMs, title: this.group.current?.title, artist: this.group.current?.artist, album: this.group.current?.album, coverArt: this.group.current?.coverArt };
    this.group.positionMs = 0;
    this.resumeWaiter = null;
    // 主循环不阻塞调用方(playMedia 需尽快返回,由 pollState 反映进度)。
    void this.pushLoop(myEpoch);
  }

  private async pushLoop(myEpoch: number): Promise<void> {
    const pcm = this.pcm;
    if (!pcm) { this.running = false; return; }
    const frameSamples = Math.floor((SAMPLE_RATE * CHANNELS * FRAME_MS) / 1000);
    const total = Math.ceil(pcm.length / frameSamples);
    const baseTs = this.group.timelineBaseUs;
    // 内容耗尽(任一边界)即自然结束:解码长度与元数据时长常差几十 ms,
    // 两个方向都会卡死(偏长→同一尾帧无限重推,因 clamp 锁住下标;偏短→
    // positionMs 到不了 durationMs,endedNaturally 恒 false)。统一按耗尽判定,
    // 中断(pushFrame 抛错)则保持未结束(断线恢复用)。
    let contentEnded = false;
    try {
      while (this.running && this.epoch === myEpoch) {
        // 暂停时挂起,等待 resume。
        if (this.paused) {
          await new Promise<void>((r) => { this.resumeWaiter = r; });
          continue;
        }
        const i = Math.floor(this.group.positionMs / FRAME_MS);
        if (i >= total) { contentEnded = true; break; } // 解码耗尽
        const lo = i * frameSamples;
        const hi = Math.min(lo + frameSamples, pcm.length);
        try {
          await this.group.pushFrame(baseTs + BigInt(Math.round(i * FRAME_MS * 1000)), pcm.subarray(lo, hi));
        } catch {
          break; // 连接断开等:停止推流(状态由 QueueController 处理)。
        }
        this.group.positionMs = Math.min(this.durationMs, i * FRAME_MS + FRAME_MS);
        // 按真实时间推进: 每推一帧 sleep 一帧的真实墙钟时长(倍速压缩)。
        // ⚠️ 此前 `sleep((i+1)*FRAME_MS/speed - min(duration/speed, ...))` 对所有
        // start<duration 的帧算出 sleep(0) → 整个音频瞬间推完 → poll 先于乐观窗口
        // 错过 PLAYING → 5s 后 stalled 重播当前首,队列永不自动切歌(见引擎头部说明)。
        // 正确节奏 = FRAME_MS 一帧,总墙钟 ≈ durationMs/speed,PLAYING 在结束前可观测。
        const perFrameMs = FRAME_MS / this.speed;
        await sleep(perFrameMs);
        // 元数据时长与实际解码长度常差几十 ms:解码偏长时 i 永远到不了 total,
        // positionMs 又被 clamp 在 durationMs → 同一尾帧无限重推、永不结束。
        // 到达元数据时长即视为播完(退出后 endedNaturally 照常置空 current 触发切歌)。
        // 注意 break 必须在 sleep 之后(保持旧 pacing):提前跳过末帧 sleep 会打乱
        // 乐观窗口/自然结束的时序判定,导致切歌变重播(见 queueModes 回归)。
        if (this.durationMs > 0 && this.group.positionMs >= this.durationMs) { contentEnded = true; break; }
      }
      if (this.epoch === myEpoch) {
        this.running = false;
        this.endedNaturally = contentEnded;
        // 自然播完 → 置空 current,让 pollState 上报 IDLE → PlaybackTracker auto-advance。
        // 同时宣告流结束:缺 stream/end + group/update(stopped),客户端永远卡 PLAYING。
        if (this.endedNaturally) {
          this.group.current = null;
          this.group.finishPlayback();
        }
        // 整首 PCM 到此无用,立即释放(长曲上百 MB),不等下一首覆盖。
        this.pcm = null;
      }
    } catch {
      this.running = false;
    }
  }

  /** 软停止(当前帧后不再推;置空 current,供 stop/切歌打断)。 */
  stop(): void {
    this.epoch++;
    this.running = false;
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    // 旧曲 PCM 立即释放(切歌瞬间,不等新解码覆盖)。
    this.pcm = null;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  /** 跳转(秒)。改写 positionMs 即可:主循环按 position 取帧。 */
  seek(seconds: number): void {
    const targetMs = Math.max(0, Math.min(this.durationMs, Math.round(seconds * 1000)));
    this.group.positionMs = targetMs;
    if (this.running) {
      this.resume();
    }
  }
}

// ---- 单组 pump 池(server:group 生命周期内复用) ----
const pumpByGroup = new WeakMap<SendspinGroup, GroupPump>();

/** 取(或建)该组的 pump。 */
export function pumpFor(server: SendspinServer, group: SendspinGroup): GroupPump {
  let p = pumpByGroup.get(group);
  if (!p) {
    p = new GroupPump(server, group);
    pumpByGroup.set(group, p);
  }
  return p;
}

/** 停掉某组的 pump 并摘除(组空/断开清理用)。停后重播走 pumpFor 重建。
 *  注意只停音频生产,不碰队列(重连恢复靠队列,见 QueueController)。 */
export function stopGroupPump(group: SendspinGroup): void {
  const p = pumpByGroup.get(group);
  if (p) {
    try { p.stop(); } catch { /* ignore */ }
    pumpByGroup.delete(group);
  }
}