// GroupPump 流式窗口路径:自然结束 / stop 释放窗口＋进程 / 窗口内 seek 继续。
// 音源经 overridePumpSource 注入(PcmWindow 直连 lavfi 合成音,无 DB、无固件);
// 20 倍速跑,不断言整包路径(见 pumpEnd.test.ts)。
import { describe, it, expect, afterEach } from "vitest";
import { GroupPump, overridePumpSource, type GroupAudio } from "./streamEngine.js";
import { PcmWindow } from "./streamSource.js";

const SPEED = "20";
let oldSpeed: string | undefined;
const opened: PcmWindow[] = [];

function stubGroup() {
  const frames: bigint[] = [];
  const group: any = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: { songId: "s", durationMs: 0 } as any,
    commonSendAheadUs: () => 800_000,
    async pushFrame(ts: bigint, pcm: Float32Array) {
      frames.push(ts);
      return Math.floor(pcm.length / 2);
    },
  };
  return { group, frames };
}

function injectSine(seconds: number): GroupAudio {
  const w = new PcmWindow({
    input: `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
    inputFormat: "lavfi",
  });
  opened.push(w);
  return { pcm: new Float32Array(0), durationMs: seconds * 1000, stream: w };
}

/** 无限正弦源(lavfi 不设 duration):ffmpeg 永不主动退出,pid 在 stop 前恒定存活。
 *  有限时长源会瞬间解完退出,"播中 pid 必存在"的前提不成立(见本文件 stop 用例)。
 *  durationMs 照填 1 小时(元数据时长缺失会钳死 position,见 streamEngine 注释);
 *  反正 stop 远早于播完,播完判定走不到。 */
function injectInfiniteSine(): GroupAudio {
  const w = new PcmWindow({
    input: "sine=frequency=440:sample_rate=48000",
    inputFormat: "lavfi",
  });
  opened.push(w);
  return { pcm: new Float32Array(0), durationMs: 3600 * 1000, stream: w };
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function pidDead(pid: number, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function speedOn(): void {
  oldSpeed = process.env.SENDSPIN_PUSH_SPEED;
  process.env.SENDSPIN_PUSH_SPEED = SPEED;
}

afterEach(() => {
  overridePumpSource(null);
  if (oldSpeed === undefined) delete process.env.SENDSPIN_PUSH_SPEED;
  else process.env.SENDSPIN_PUSH_SPEED = oldSpeed;
  for (const w of opened.splice(0)) {
    try { w.close(); } catch { /* ignore */ }
  }
});

describe("GroupPump 流式窗口", () => {
  it("10s 正弦自然播完:置空 current,时间戳单调", async () => {
    speedOn();
    overridePumpSource(async () => injectSine(10));
    const { group, frames } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("stream-natural");
    await waitInactive(pump, 20_000, "流式自然结束");
    expect(group.current).toBeNull();
    expect(frames.length).toBeGreaterThan(10);
    for (let i = 1; i < frames.length; i++) expect(frames[i] > frames[i - 1]).toBe(true);
    expect((pump as any).window).toBeNull(); // 播完关窗口
  }, 30_000);

  it("stop 关窗口杀进程,无残留", async () => {
    speedOn();
    let win: PcmWindow | null = null;
    overridePumpSource(async () => {
      const a = injectInfiniteSine();
      win = a.stream as PcmWindow;
      return a;
    });
    const { group } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("stream-stop");
    // 等出声且进程句柄就绪:高负载下 spawn 回执可能晚于首包,轮询同步;
    // 窗口若自行失败/EOF 直接报原因,不空等。
    const t0 = Date.now();
    for (;;) {
      const failed = (win as any)?.failedReason as string | null;
      if (failed) throw new Error(`窗口意外失败: ${failed}`);
      if (group.positionMs > 0 && win!.pid !== undefined) break;
      if (!pump.active) throw new Error("pump 未起播就停了");
      if (Date.now() - t0 > 10_000) {
        throw new Error(`等出声超时 pid=${win!.pid} failed=${(win as any)?.failedReason ?? "-"}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pump.active).toBe(true); // 必须在播中停,停播完的 pump 证明不了杀进程
    const pid = win!.pid;
    expect(pid).toBeDefined();
    pump.stop();
    expect((pump as any).window).toBeNull();
    expect(await pidDead(pid!, 8000)).toBe(true);
  }, 30_000);

  it("窗口内 seek 后继续播到完", async () => {
    speedOn();
    overridePumpSource(async () => injectSine(30));
    const { group, frames } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("stream-seek");
    const t0 = Date.now();
    for (;;) {
      if (group.positionMs > 500) break;
      if (Date.now() - t0 > 10_000) throw new Error("一直没出声");
      await new Promise((r) => setTimeout(r, 50));
    }
    pump.seek(5); // 5s 处必在 60s 窗口内:纯改下标,不断流
    expect(group.positionMs).toBe(5000);
    await waitInactive(pump, 20_000, "seek 后自然结束");
    expect(group.current).toBeNull();
    expect(frames.length).toBeGreaterThan(10);
  }, 30_000);
});
