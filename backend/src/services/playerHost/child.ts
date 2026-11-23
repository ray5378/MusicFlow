// ==================== 播放器子进程入口 ====================
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
  // P1：airplay 适配层（把 BridgeSession 包成 PlayerRuntime）
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
