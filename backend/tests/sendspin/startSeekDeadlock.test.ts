// ==================== P0 回归:start-seek 游标死锁(2026-11-24 21:14 事故)====================
//
// 事故:cursor delete 后 `?? 0n` ⇒ 游标被当作内容绝对 0(与 uptime≈296907s 相减得
// -296907s);环内当前代次内容整体在 now+15s,视界只有 now+5.5s ⇒ 每拍 cand=0、
// 游标不推进 = 永久静音(bridge-window-dead reason=content-beyond-horizon)。
//
// 本文件钉死修复的三条语义:
//   ① 游标缺失 ≠ 内容 0:缺失时给有效种子(环内最早当前代次帧 / 过期或越视界则 now);
//   ② 死锁兜底:连续 2 拍 cand=0 且 tail>horizon ⇒ 环时间线整体前移回可投范围 +
//     BOUNDARY{seek} 重锚 + 独立日志 bridge-start-seek-deadlock,禁止空转;
//   ③ start-seek 不再 delete 游标(种子化),按代次记账(重播不复发)。
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { nowUs } from "../../src/services/sendspin/clock.js";

const liveGroups: SendspinGroup[] = [];

function makeServerStub() {
  const map = new Map<string, number>();
  const logs: string[] = [];
  return {
    log(level: string, msg: string) { logs.push(`${level}|${msg}`); },
    logs,
    bridgeBacklogMs: map,
    setBridgeBacklog(m: Record<string, number>) {
      map.clear();
      for (const [k, v] of Object.entries(m)) map.set(k, v);
    },
  };
}

function groupWith(bridges: string[]) {
  const srv = makeServerStub();
  const g = new SendspinGroup("g-start-seek", srv as any);
  const handles: Record<string, { pushed: { ts: bigint }[]; boundaries: string[] }> = {};
  for (const id of bridges) {
    const pushed: { ts: bigint }[] = [];
    const boundaries: string[] = [];
    handles[id] = { pushed, boundaries };
    g.bridges.set(id, {
      deviceId: id,
      pushed,
      pushAudio(_data: Uint8Array, ts: bigint) { pushed.push({ ts }); },
      sendBoundary(reason: string) { boundaries.push(reason); },
    } as any);
  }
  liveGroups.push(g);
  return { g, srv, handles };
}

/** 往 pcm:100 组环里塞一帧当前代次内容。 */
function addRingFrame(g: SendspinGroup, tsUs: bigint, ep: number, durUs = 25_000): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).ringFor(key).push({ tsUs, durUs, data: new Uint8Array(2400), ep });
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

describe("start-seek 死锁修复(P0)", () => {
  it("环内当前代次内容整体在 now+15s 且 bcCursor 缺失 ⇒ 2 拍后显式重锚,第 3 拍恢复投递(不再 content-beyond-horizon)", () => {
    const { g, srv, handles } = groupWith(["dev-a", "dev-b"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch); // 代次已登记(不触发换代复位,直达死锁场景)
    // 40 帧全部落在 now+15s 之后(复刻事故:环头 +15.3s、视界 5.5s)
    for (let i = 0; i < 40; i++) addRingFrame(g, now + 15_000_000n + BigInt(i) * 25_000n, epoch);

    // 第 1 拍:游标缺失 ⇒ 种子 = now(绝不是 0);cand=0 ⇒ 记 1 拍死锁
    (g as any).bridgeBroadcastTick(now);
    const cursor1 = (g as any).bcCursor.get("dev-a");
    expect(cursor1).toBe(now); // 缺失语义修复:不是 0n
    expect(handles["dev-a"].pushed.length).toBe(0); // 本代内容全在视界外,投不出

    // 第 2 拍:连续 2 拍 ⇒ 兜底重锚(环时间线整体前移 + BOUNDARY{seek})
    (g as any).bridgeBroadcastTick(now + 250_000n);
    expect(handles["dev-a"].boundaries).toContain("seek");
    expect(handles["dev-b"].boundaries).toContain("seek"); // 两台都重锚(共享同一条环)
    const deadLog = srv.logs.find((l) => l.includes("bridge-start-seek-deadlock"));
    expect(deadLog).toBeDefined();

    // 第 3 拍:环已推回可投范围 ⇒ 恢复投递,游标推进(不再空转)
    (g as any).bridgeBroadcastTick(now + 500_000n);
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(0);
    expect((g as any).bcCursor.get("dev-a")).toBeGreaterThan(now);
    // 死锁计数已清(不是无限 content-beyond-horizon)
    expect((g as any).bridgeDeadTicks.size).toBe(0);
  });

  it("环内最早帧在视界内 ⇒ 种子 = 该帧(两台从同一内容点起投),首拍即投出", () => {
    const { g, handles } = groupWith(["dev-a"]);
    const now = nowUs();
    const epoch = (g as any).bridgeContentEpoch;
    const key = (g as any).encoderKey("pcm", 100);
    (g as any).bcEpoch.set(key, epoch);
    const head = now + 2_000_000n; // 视界 (now+5s+ahead) 内
    for (let i = 0; i < 10; i++) addRingFrame(g, head + BigInt(i) * 25_000n, epoch);

    (g as any).bridgeBroadcastTick(now);
    // 种子=环内最早可投帧 ⇒ 首拍就投得出(1 个 pump tick 内恢复)
    expect((g as any).bcCursor.get("dev-a")).not.toBe(0n);
    expect(handles["dev-a"].pushed.length).toBeGreaterThan(0);
    expect((g as any).bridgeDeadTicks.size).toBe(0);
  });
});
