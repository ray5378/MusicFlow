// ==================== 播放器子进程 IPC（每播放器一进程）====================
//
// 对齐 Music Assistant：`providers/airplay/stream.py:327` 每台播放器一个 cliairplay
// 子进程 —— 音频走 stdin、命令走命名管道、状态走 stderr。这里用 Node 的 child_process
// 通道等价实现三件事：
//   · 父 → 子：帧数据(pcm) + 控制(prepare/anchor/shift/volume/stop)
//   · 子 → 父：状态(status) + 饥荒(underrun) + 结束/崩溃(fatal)
//
// 关键纪律：**一个播放器的任何阻塞都只能影响它自己的管道**。父进程侧对每个子进程
// 单独做心跳与重启，绝不因为某个子进程卡住而停摆。

/** 内容帧（P0 走 IPC 序列化；P1 换共享内存段，字段保持不变） */
export interface PcmFrame {
  /** 单调序号，用于丢帧检测 */
  seq: number;
  /** 组时间线上该帧首样本的可听时刻（host µs） */
  tsUs: number;
  /** 帧数（每帧 2ch f32 → 8 字节） */
  nFrames: number;
  /** 采样率 */
  rate: number;
  /** PCM 原始字节（s16le / f32le 由 prepare 指定） */
  data: Uint8Array;
}

export type ParentToPlayer =
  | {
      t: "prepare";
      deviceId: string;
      token: string;
      protocol: "raop" | "ap2";
      rate: number;
      /** 采样格式，如 s16le-2ch / f32le-2ch */
      format: string;
      /** 设备侧缓冲（帧） */
      latencyFrames: number;
      /** 组时间线锚点（host µs） */
      anchorUs: number;
      /** 成员延迟补偿（µs，正=更晚出声） */
      shiftUs: number;
      socketPath: string;
    }
  | { t: "anchor"; anchorUs: number; gen: number }
  | { t: "shift"; shiftUs: number }
  | { t: "volume"; db: number }
  | { t: "mute"; on: boolean }
  | { t: "flush"; gen: number }
  | { t: "stop" }
  | { t: "ping"; at: number }
  | { t: "pcm"; frame: PcmFrame };

export interface PlayerStatus {
  t: "status";
  gen: number;
  state: "idle" | "live" | "stalled" | "closing";
  /** 设备侧排队（ms） */
  queueMs: number;
  /** 本进程入站缓冲（ms） */
  inQueueMs: number;
  /** 累计饥荒次数 / 最近一次饥荒时长 */
  underruns: number;
  lastUnderrunMs: number;
  /** 已消费到的内容时刻（host µs，用于和组前沿比对） */
  watermarkUs: number;
  /** 累计投出帧数 */
  framesOut: number;
}

export type PlayerToParent =
  | { t: "ready"; pid: number }
  | PlayerStatus
  | { t: "underrun"; ms: number; reason: string }
  | { t: "ended"; reason: string }
  | { t: "fatal"; error: string }
  | { t: "pong"; at: number };

/** 播放器运行时接口：子进程内实现（P0=Fake，P1=AirPlay BridgeSession 适配层）。 */
export interface PlayerRuntime {
  prepare(msg: Extract<ParentToPlayer, { t: "prepare" }>): Promise<void> | void;
  pcm(frame: PcmFrame): void;
  anchor(anchorUs: number, gen: number): void;
  shift(shiftUs: number): void;
  volume(db: number): void;
  mute(on: boolean): void;
  flush(gen: number): void;
  stop(): Promise<void> | void;
  status(): PlayerStatus;
}
