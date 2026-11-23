// ==================== P0 假播放器运行时 ====================
//
// 作用：在没有真实设备/协议的情况下验证「每播放器一进程」的宿主能力：
//   · 收帧、推进水位、统计投出帧数；
//   · 主动上报状态（父进程据此判活）；
//   · 支持 `MF_FAKE_STALL_MS` 模拟卡死（验证父进程只有该子进程受影响）。
import type { ParentToPlayer, PlayerRuntime, PlayerStatus, PcmFrame } from "./ipcProtocol.js";

type PrepareMsg = Extract<ParentToPlayer, { t: "prepare" }>;

export class FakeRuntime implements PlayerRuntime {
  private gen = 0;
  private state: PlayerStatus["state"] = "idle";
  private watermarkUs = 0;
  private framesOut = 0;
  private underruns = 0;
  private lastUnderrunMs = 0;
  private inQueueFrames = 0;
  private shiftUs = 0;
  private rate = 48_000;
  private baseRate: number | null = null;
  private lastFrameAt = 0;

  prepare(msg: PrepareMsg): void {
    this.rate = msg.rate || 48_000;
    this.baseRate = msg.rate || 48_000;
    this.shiftUs = msg.shiftUs;
    this.state = "live";
    this.gen += 1;
  }

  pcm(frame: PcmFrame): void {
    // 模拟卡死：环境变量指定毫秒数（同步 sleep，父进程心跳会判死）
    const stallMs = Number(process.env.MF_FAKE_STALL_MS ?? 0);
    if (stallMs > 0) {
      const end = Date.now() + stallMs;
      while (Date.now() < end) {
        /* 故意阻塞 */
      }
    }
    this.framesOut += 1;
    this.watermarkUs = frame.tsUs + Math.round((frame.nFrames / this.rate) * 1e6);
    this.lastFrameAt = Date.now();
    this.inQueueFrames = Math.max(0, this.inQueueFrames - 1);
  }

  anchor(anchorUs: number, gen: number): void {
    this.gen = gen;
    this.watermarkUs = anchorUs;
  }

  shift(shiftUs: number): void {
    this.shiftUs = shiftUs;
  }

  volume(): void {
    /* 假运行时忽略音量 */
  }

  mute(): void {
    /* 同上 */
  }

  flush(gen: number): void {
    this.gen = gen;
    this.inQueueFrames = 0;
  }

  stop(): void {
    this.state = "closing";
  }

  status(): PlayerStatus {
    const idleMs = this.lastFrameAt > 0 ? Date.now() - this.lastFrameAt : 0;
    if (this.state === "live" && this.lastFrameAt > 0 && idleMs > 2_000) {
      this.state = "stalled";
      this.underruns += 1;
      this.lastUnderrunMs = idleMs;
    } else if (this.state === "stalled" && idleMs < 500) {
      this.state = "live";
    }
    return {
      t: "status",
      gen: this.gen,
      state: this.state,
      queueMs: 0,
      inQueueMs: Math.round((this.inQueueFrames / this.rate) * 1000),
      underruns: this.underruns,
      lastUnderrunMs: this.lastUnderrunMs,
      watermarkUs: this.watermarkUs,
      framesOut: this.framesOut,
    };
  }
}
