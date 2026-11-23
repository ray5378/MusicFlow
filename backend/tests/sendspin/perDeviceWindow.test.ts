// ==================== S8 任务 2:逐设备投递窗口(holdDepth 余量)====================
//
// 审计依据:MA 设备稳态持有 ~1s(min_buffer 自报),窗口 2s 量级没错,错在
// 「下限贴 0 无抖动余量」。修复:广播 tick 的投递上沿(原 horizon 写死 2s)改为
// 逐设备 max(2s, holdDepthMs + 500ms)——holdDepthMs 由主进程 bridgeStats →
// supervisor → bridgeHealth rpc 转发进组对象(setBridgeHoldDepth)。
//
// 本文件钉死三件事:
//   ① 无 holdDepth ⇒ 缺省 2s 窗口(行为不变);
//   ② holdDepth=4s ⇒ 窗口 4.5s:+4s 帧照常投出(修复点)、+9s 仍不投(上限兜底);
//   ③ contentDemand.deliverWindow 的 per-device lookahead 入参(缺省 2s 不变)。
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
vi.hoisted(() => {
  process.env.MF_PLAYER_ISOLATION = "1";
  process.env.MF_PLAYER_BROADCAST = "1";
});
import "../plugins/_env.js";
import { initDatabase } from "../../src/db/index.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { nowUs } from "../../src/services/sendspin/clock.js";
import { deliverWindow } from "../../src/services/sendspin/contentDemand.js";

const liveGroups: SendspinGroup[] = [];

/** server 桩:承载 bridgeHoldDepthMs(与生产 SendspinServer 同接口)。
 *  真实归属:S8 后 holdDepth 放在 server 级(bridgeHealth rpc 只拿得到 server 引用),
 *  组 tick 经 this.server 读取。 */
function makeServerStub() {
  const map = new Map<string, number>();
  return {
    log() {},
    bridgeHoldDepthMs: map,
    setBridgeHoldDepth(m: Record<string, number>) {
      map.clear();
      for (const [k, v] of Object.entries(m)) {
        if (Number.isFinite(v) && v >= 0) map.set(k, v);
      }
    },
  };
}

function groupWith(bridges: string[]): { g: SendspinGroup; srv: ReturnType<typeof makeServerStub> } {
  const srv = makeServerStub();
  const g = new SendspinGroup("g-perdev-window", srv as any);
  for (const id of bridges) {
    const pushed: { data: Uint8Array; ts: bigint }[] = [];
    g.bridges.set(id, {
      deviceId: id,
      pushed,
      pushAudio(data: Uint8Array, ts: bigint) { pushed.push({ data: Uint8Array.from(data), ts }); },
      sendBoundary() {},
    } as any);
  }
  liveGroups.push(g);
  return { g, srv };
}

function addRingFrame(g: SendspinGroup, tsUs: bigint, durUs = 25_000): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).ringFor(key).push({ tsUs, durUs, data: new Uint8Array(2400), ep: (g as any).bridgeContentEpoch });
}

function seedEpoch(g: SendspinGroup): void {
  const key = (g as any).encoderKey("pcm", 100);
  (g as any).bcEpoch.set(key, (g as any).bridgeContentEpoch);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

describe("逐设备投递窗口 — broadcast tick(修复点)", () => {
  it("无 holdDepth ⇒ 缺省窗口:前沿 +9s 的帧不投(与旧行为一致)", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const now = nowUs();
    seedEpoch(g);
    addRingFrame(g, now + 9_000_000n);
    srv.setBridgeHoldDepth({}); // 无数据
    const b = g.bridges.get("dev-a") as any;
    (g as any).bridgeBroadcastTick(now);
    // 9s 远超缺省 2s(+ahead)窗口 ⇒ 不投
    expect(b.pushed.length).toBe(0);
  });

  it("holdDepth=4s ⇒ 窗口 4.5s:+4s 帧照常投出(修复点:下限不再贴 0)", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const now = nowUs();
    seedEpoch(g);
    addRingFrame(g, now + 4_000_000n);
    srv.setBridgeHoldDepth({ "dev-a": 4000 });
    const b = g.bridges.get("dev-a") as any;
    (g as any).bridgeBroadcastTick(now);
    // max(2s, 4s+500ms) = 4.5s ⇒ +4s 帧落窗内 ⇒ 投出(缺省 2s 窗口下会被 break)
    expect(b.pushed.length).toBeGreaterThan(0);
    // 游标推进到该帧(S6 语义)
    expect((g as any).bcCursor.get("dev-a")).toBe(now + 4_000_000n);
  });

  it("holdDepth 超大(60s)⇒ 上沿跟着放大,但游标超前护栏用同值(不白放宽)", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const now = nowUs();
    seedEpoch(g);
    addRingFrame(g, now + 30_000_000n);
    srv.setBridgeHoldDepth({ "dev-a": 60_000 });
    const b = g.bridges.get("dev-a") as any;
    (g as any).bridgeBroadcastTick(now);
    // 上沿 = now+60.5s ⇒ +30s 帧投出;若护栏仍用 2s 旧值,+30s 游标早被跳回 = 白放宽
    expect(b.pushed.length).toBeGreaterThan(0);
  });

  it("holdDepth 小(100ms)⇒ max(2s, 600ms) = 2s:行为与缺省一致", () => {
    const { g, srv } = groupWith(["dev-a"]);
    const now = nowUs();
    seedEpoch(g);
    addRingFrame(g, now + 9_000_000n);
    srv.setBridgeHoldDepth({ "dev-a": 100 });
    const b = g.bridges.get("dev-a") as any;
    (g as any).bridgeBroadcastTick(now);
    expect(b.pushed.length).toBe(0);
  });
});

describe("deliverWindow — per-device lookahead 入参(缺省不变)", () => {
  it("缺省(不传)⇒ hiUs = now + 2s(行为不变)", () => {
    const now = Number(nowUs());
    const w = deliverWindow({ nowUs: now, cursorUs: now, tailUs: 0, minDeviceTsUs: 0 });
    expect(w.hiUs).toBe(now + 2_000_000);
  });

  it("传入 hiLookaheadUs=4.5s ⇒ hiUs = now + 4.5s(逐设备余量)", () => {
    const now = Number(nowUs());
    const w = deliverWindow({ nowUs: now, cursorUs: now, tailUs: 0, minDeviceTsUs: 0 }, 4_500_000);
    expect(w.hiUs).toBe(now + 4_500_000);
    // lo/jump 语义不受 hi 覆盖影响
    expect(w.loUs).toBe(now);
    expect(w.jumpToUs).toBe(null);
  });
});
