// ==================== 播放器子进程入口 ====================
//
// ===== 对标 MA =====
// MA 位置：music_assistant/providers/airplay/stream.py:4-6（文件头契约：
//          「Audio is fed via stdin, commands via a named pipe, status is
//          reported on stderr in normalized [STATUS] format」）。
// MA 语义：三条传输通道按**负载类型物理分离** —— 音频（高吞吐）走 stdin、
//          命令（低延迟）走命名管道、状态走 stderr [STATUS] 行；这样音频洪峰
//          不会顶住命令通道，状态由子进程主动推送（不等父进程轮询）。
// 我们：单一 Node IPC 通道（fork 'ipc'）承载全部消息，**按消息类型逻辑分离**
//          （ipcProtocol.ts：下行 pcm/anchor/shift/volume/mute/flush，
//          上行 status/underrun/fatal/ended）。差异原因：MA 两端是「MA 进程 ↔
//          黑盒二进制」，必须跨进程边界用 stdin/管道/stderr 分通道；我们两端
//          都是自己的代码，单 IPC 足够，还省去命名管道生命周期管理。
//          保留的等价性：① 音频帧(pcm)与控制(anchor/shift)仍是不同消息类型，
//          不混用；② 状态由子进程**主动定时上报**（statusTimer，等价 MA 的
//          [STATUS] 主动推送），父进程从不轮询状态内容。
import type { ParentToPlayer, PlayerRuntime, PlayerToParent } from "./ipcProtocol.js";

const send = (msg: PlayerToParent): void => {
  if (process.send) process.send(msg);
};

let runtime: PlayerRuntime | null = null;
let statusTimer: NodeJS.Timeout | null = null;

async function makeRuntime(): Promise<PlayerRuntime> {
  const kind = process.env.MF_PLAYER_RUNTIME ?? "fake";
  if (kind === "fake") {
    const { FakeRuntime } = await import("./fakeRuntime.js");
    return new FakeRuntime();
  }
  // P1：airplay 适配层（把 BridgeSession 包成 PlayerRuntime）。
  // 对标 MA（每进程自有缓冲 / 到达节拍）：MA 每个 cliairplay 进程有自己的
  // stdin 输入环，进程内自行消化上行流量（stream.py:1195「Audio is fed
  // continuously on the process stdin; the binary reads it into …」）；适配层
  // 的等价职责 = 把父进程广播来的帧喂进 BridgeSession 的隔离模式**到达节拍
  // 缓冲**（每设备一份、互不共享），缓冲水位与节拍由 BridgeSession 隔离模式
  // 自理（见 bridgeSession.ts，对标 MA 桥 min_buffer_ms=1s 的固定 send-ahead）。
  throw new Error(`未知播放器运行时: ${kind}`);
}

async function main(): Promise<void> {
  runtime = await makeRuntime();

  process.on("message", (raw: unknown) => {
    const msg = raw as ParentToPlayer;
    if (!runtime) return;
    try {
      switch (msg.t) {
        case "prepare":
          void Promise.resolve(runtime.prepare(msg)).catch((e) =>
            send({ t: "fatal", error: (e as Error).message }),
          );
          break;
        case "pcm":
          runtime.pcm(msg.frame);
          break;
        case "anchor":
          runtime.anchor(msg.anchorUs, msg.gen);
          break;
        case "shift":
          runtime.shift(msg.shiftUs);
          break;
        case "volume":
          runtime.volume(msg.db);
          break;
        case "mute":
          runtime.mute(msg.on);
          break;
        case "flush":
          runtime.flush(msg.gen);
          break;
        case "ping":
          send({ t: "pong", at: msg.at });
          break;
        case "stop":
          void Promise.resolve(runtime.stop()).finally(() => {
            send({ t: "ended", reason: "stop" });
            process.exit(0);
          });
          break;
        default:
          break;
      }
    } catch (e) {
      send({ t: "fatal", error: (e as Error).message });
    }
  });

  statusTimer = setInterval(() => {
    if (!runtime) return;
    try {
      send(runtime.status());
    } catch {
      /* 状态上报失败不致命 */
    }
  }, 1_000);
  statusTimer.unref?.();

  process.on("uncaughtException", (e) => {
    send({ t: "fatal", error: e.message });
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    send({ t: "fatal", error: String(e) });
    process.exit(1);
  });

  send({ t: "ready", pid: process.pid });
}

void main();
