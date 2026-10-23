import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { sqlite } from "../../src/db/index.js";

// 预探测在纯队列测试里一律关闭:vitest 共 worker 时插件内存注册表可能带着
// 其它文件注册的 core 插件(preProbeActive() 变 true),异步扫描会污染
// snapshot 断言。partial mock:只把 preProbeActive/readPreProbeConfig 换成
// disabled,其余导出(manifest 等)保持原样。
const PRE_PROBE_DISABLED_CFG = {
  enabled: false, lookaheadSongs: 3, deadRunLimit: 50, exhaustedCooldownSeconds: 90,
  probeTimeoutMs: 5000, probeCooldownSeconds: 60, windowMinutes: 8,
  negativeTtlSeconds: 45, concurrency: 3,
};
vi.mock(import("../../src/services/plugin/core/preProbe.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    preProbeActive: () => false,
    readPreProbeConfig: () => ({ ...PRE_PROBE_DISABLED_CFG }),
  };
});

// 测试环境不会调 initDatabase(),手动建 device_queues 表以让 persist 可写。
beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS device_queues (
      device_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

// Mock UniversalPlayer
function makeMockPlayer(): UniversalPlayer & { calls: string[] } {
  const calls: string[] = [];
  const proto = {
    playerId: "dlna:d1",
    async playMedia() { calls.push("playMedia"); return { mediaUri: "u-new" }; },
    async stop() { calls.push("stop"); },
    async pause() { calls.push("pause"); },
    async resume() { calls.push("resume"); },
    async seek() { calls.push("seek"); },
    async setVolume() { calls.push("setVolume"); },
    async pollState() { calls.push("pollState"); return { playerId: "dlna:d1", playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() }; },
  };
  const up = {
    playerId: "dlna:d1",
    name: "test",
    attachProtocol: () => {},
    getProtocol: () => proto,
    playMedia: proto.playMedia,
    stop: proto.stop,
    pause: proto.pause,
    resume: proto.resume,
    seek: proto.seek,
    setVolume: proto.setVolume,
    pollState: proto.pollState,
    calls,
  } as unknown as UniversalPlayer & { calls: string[] };
  return up;
}

describe("QueueController", () => {
  let qc: QueueController;
  let mockPlayer: ReturnType<typeof makeMockPlayer>;
  let mockCtrl: { beginOptimistic: ReturnType<typeof vi.fn>; endOptimistic: ReturnType<typeof vi.fn>; reportState: ReturnType<typeof vi.fn>; resetTracker: ReturnType<typeof vi.fn>; setExpectedDuration: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPlayer = makeMockPlayer();
    mockCtrl = {
      beginOptimistic: vi.fn(),
      endOptimistic: vi.fn(),
      reportState: vi.fn(),
      resetTracker: vi.fn(),
      setExpectedDuration: vi.fn(),
    };
    qc = new QueueController();
    // QueueController 内部用裸 deviceId 作 key(与路由/DB 一致);
    // PlayerController 用 "dlna:<deviceId>" 作 playerId。
    qc.registerPlayer("d1", mockPlayer, mockCtrl as any);
    // 填入队列(setQueue 不触发播放,仅设数据)
    qc.setQueue("d1", [
      { songId: "s1", title: "t1", mime: "audio/mpeg" },
      { songId: "s2", title: "t2", mime: "audio/mpeg" },
    ], 0, "http://base");
  });

  it("onDecision('advance'): 推进到下一首并 cast", async () => {
    await qc.handleDecision("advance", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
    // 乐观窗口在 cast 之前开启(对照 MA 乐观设态),mediaUri 为 "pending";
    // cast 后调 resetTracker 清上一首状态。窗口保持开启等 PLAYING 确认。
    expect(mockCtrl.beginOptimistic).toHaveBeenCalledWith("dlna:d1", "pending");
    expect(mockCtrl.resetTracker).toHaveBeenCalledWith("dlna:d1");
  });

  it("onDecision('ended'): 无下一首,标记结束,不 cast", async () => {
    qc.setQueue("d1", [{ songId: "s1", title: "t1", mime: "audio/mpeg" }], 0, "http://base");
    await qc.handleDecision("ended", "dlna:d1");
    expect(mockPlayer.calls).not.toContain("playMedia");
  });

  it("onDecision('stalled'): 卡死,重试当前首一次", async () => {
    await qc.handleDecision("stalled", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
  });

  it("playMode=one: advance 时重播当前首", async () => {
    qc.setPlayMode("d1", "one");
    await qc.handleDecision("advance", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
  });

  it("clear: 清空队列同时 best-effort stop 设备播放", () => {
    qc.clear("d1");
    expect(mockPlayer.calls).toContain("stop");
    const snap = qc.snapshot("d1");
    expect(snap.items).toHaveLength(0);
    expect(snap.currentIndex).toBe(-1);
    expect(snap.isActive).toBe(false);
    expect(snap.ended).toBe(false);
  });

  it("clear: stop 失败(设备离线)静默,不影响清空", () => {
    const bad = makeMockPlayer();
    bad.stop = async () => { throw new Error("device offline"); };
    qc.registerPlayer("d2", bad, mockCtrl as any);
    qc.setQueue("d2", [{ songId: "s1", title: "t1", mime: "audio/mpeg" }], 0, "http://base");
    expect(() => qc.clear("d2")).not.toThrow();
    expect(qc.snapshot("d2").items).toHaveLength(0);
  });

  it("clear: emit queue_changed(空快照)", () => {
    const listener = vi.fn();
    qc.on("queue_changed", listener);
    qc.clear("d1");
    // 空快照含权威洗牌序列字段(客户端镜像用,见 PlayStartOwnership.test.ts)。
    // preProbe:预探测状态位(2026-09-11)—— clear 时一并清空,前端提示随之消失。
    expect(listener).toHaveBeenCalledWith("d1", {
      items: [], currentIndex: -1, playMode: "shuffle", isActive: false, ended: false,
      shuffleOrder: [], shufflePos: -1,
      preProbe: { ready: 0, scanned: 0, misses: 0, exhausted: false, cooldownUntil: null, at: 0 },
    });
  });

  describe("起播即落位:stalled 重投不丢落点(2026-10-24 流转矩阵首格真机)", () => {
    /** 复现:transfer-from 回执落点 47.5s → 目标端 cast 之后一路正常,
     *  随后 stalled 通道重投(链路抖动/乐观窗口超时都走这里)。
     *  旧实现重投不带位置 ⇒ 目标端从 0 起涨,而回执仍写 47.5(落点永久丢失)。
     *  这里直接驱动 stalled 通道 —— 正是真机上那条「cast 抛错 → setTimeout(handleDecision
     *  ('stalled'))」的落点。 */
    it("stalled 重投必须按本次 cast 的原起点重投", async () => {
      const starts: (number | undefined)[] = [];
      const p = makeMockPlayer();
      p.playMedia = (async (_item: unknown, _base: unknown, startMs?: number) => {
        starts.push(startMs);
        return { mediaUri: "u-ok" };
      }) as typeof p.playMedia;
      qc.registerPlayer("d3", p, mockCtrl as any);
      const items = [
        { songId: "s1", title: "t1", mime: "audio/mpeg" } as any,
        { songId: "s2", title: "t2", mime: "audio/mpeg" } as any,
      ];
      qc.setQueue("d3", items, 0, "http://base");

      // 起播即落位:47.5s 交给这次 cast
      await qc.playFrom("d3", items, 0, "http://base", undefined, 47500);
      expect(starts).toEqual([47500]);

      // 链路抖动 → stalled 通道重投当前首
      await qc.handleDecision("stalled", "dlna:d3");
      expect(starts.length).toBe(2);
      expect(starts[1]).toBe(47500);   // 重投仍是同一落点(不是 undefined/0)
    });

    it("从头起播(起点 0)时重投依旧是 undefined,不凭空造出偏移", async () => {
      const starts: (number | undefined)[] = [];
      const p = makeMockPlayer();
      p.playMedia = (async (_item: unknown, _base: unknown, startMs?: number) => {
        starts.push(startMs);
        return { mediaUri: "u-ok" };
      }) as typeof p.playMedia;
      qc.registerPlayer("d4", p, mockCtrl as any);
      const items = [{ songId: "s1", title: "t1", mime: "audio/mpeg" } as any];
      qc.setQueue("d4", items, 0, "http://base");

      await qc.playFrom("d4", items, 0, "http://base");
      expect(starts).toEqual([undefined]);

      await qc.handleDecision("stalled", "dlna:d4");
      expect(starts.length).toBe(2);
      expect(starts[1]).toBeUndefined();
    });

    it("换曲后不套用上一首的落点(跨曲 lastPos 必须重置)", async () => {
      const starts: (number | undefined)[] = [];
      const p = makeMockPlayer();
      p.playMedia = (async (_item: unknown, _base: unknown, startMs?: number) => {
        starts.push(startMs);
        return { mediaUri: "u-ok" };
      }) as typeof p.playMedia;
      qc.registerPlayer("d5", p, mockCtrl as any);
      const a = [{ songId: "sA", title: "A", mime: "audio/mpeg" } as any];
      const b = [{ songId: "sB", title: "B", mime: "audio/mpeg" } as any];

      // 上一首带落点起播(200s)→ 记下起播意图与 lastPos 基线
      await qc.playFrom("d5", a, 0, "http://base", undefined, 200000);
      // 换曲从头播(真实场景:自动切歌 / 用户点别的歌)
      await qc.playFrom("d5", b, 0, "http://base");
      expect(starts).toEqual([200000, undefined]);

      // 新曲刚起播就卡死 → 重投必须还是"从头",不能继承上一首的 200s
      await qc.handleDecision("stalled", "dlna:d5");
      expect(starts.length).toBe(3);
      expect(starts[2]).toBeUndefined();
    });

    it("播到中段卡死 → 从设备上报的位置续,而不是回退到起播点", async () => {
      const starts: (number | undefined)[] = [];
      const p = makeMockPlayer();
      p.playMedia = (async (_item: unknown, _base: unknown, startMs?: number) => {
        starts.push(startMs);
        return { mediaUri: "u-ok" };
      }) as typeof p.playMedia;
      // 设备已经播到 120s(IDLE 卡死前的最后读数)
      p.pollState = (async () => ({
        playerId: "dlna:d6", playbackState: PlaybackState.IDLE,
        position: 120, duration: 300, updatedAt: Date.now(),
      })) as typeof p.pollState;
      qc.registerPlayer("d6", p, mockCtrl as any);
      const items = [{ songId: "s1", title: "t1", mime: "audio/mpeg" } as any];

      await qc.playFrom("d6", items, 0, "http://base", undefined, 45000);
      // 5s 兜底轮询把设备真实位置记进 lastPos(私有方法:驱动的正是生产那条路径)
      await (qc as any).pollAllDevices(() => "http://base");

      await qc.handleDecision("stalled", "dlna:d6");
      expect(starts.length).toBe(2);
      expect(starts[1]).toBe(120000);
    });

    it("frozen 就地恢复走「起播即落位」:cast 带起点,不再补 seek", async () => {
      const starts: (number | undefined)[] = [];
      const p = makeMockPlayer();
      p.playMedia = (async (_item: unknown, _base: unknown, startMs?: number) => {
        starts.push(startMs);
        return { mediaUri: "u-ok" };
      }) as typeof p.playMedia;
      // PLAYING 但位置停在起播点(冻结)
      p.pollState = (async () => ({
        playerId: "dlna:d7", playbackState: PlaybackState.PLAYING,
        position: 45, duration: 300, mediaUri: "u-ok", updatedAt: Date.now(),
      })) as typeof p.pollState;
      qc.registerPlayer("d7", p, mockCtrl as any);
      const items = [{ songId: "s1", title: "t1", mime: "audio/mpeg" } as any];

      await qc.playFrom("d7", items, 0, "http://base", undefined, 45000);
      await qc.handleDecision("frozen", "dlna:d7");

      expect(starts.length).toBe(2);
      expect(starts[1]).toBe(45000);          // 起点进 cast
      expect(p.calls).not.toContain("seek");  // 绝不再补一次会话重建
    });
  });

  describe("shuffle 上一首稳定性(v1.7.52 修复:当前曲固定在序列头,pos 可回退)", () => {
    beforeEach(() => {
      qc.setQueue("d1", [
        { songId: "s1", title: "t1", mime: "audio/mpeg" },
        { songId: "s2", title: "t2", mime: "audio/mpeg" },
        { songId: "s3", title: "t3", mime: "audio/mpeg" },
      ], 0, "http://base");
      qc.setPlayMode("d1", "shuffle");
    });

    it("next 后 prev 回到起播曲", async () => {
      // setQueue(startIndex=0) → 起播曲 s0 固定在序列头(order[0]=0,pos=0)
      await qc.next("d1", "http://base");
      const mid = qc.snapshot("d1").currentIndex;
      expect(mid).not.toBe(0); // 下一首不是起播曲
      await qc.prev("d1", "http://base");
      expect(qc.snapshot("d1").currentIndex).toBe(0); // 回到起播曲
    });

    it("跳播(jumpTo)后 next 再 prev 回到跳播曲", async () => {
      await qc.jumpTo("d1", 2, "http://base");
      await qc.next("d1", "http://base");
      expect(qc.snapshot("d1").currentIndex).not.toBe(2);
      await qc.prev("d1", "http://base");
      expect(qc.snapshot("d1").currentIndex).toBe(2);
    });

    it("prev 在序列头部不绕回(保持当前曲)", async () => {
      await qc.prev("d1", "http://base"); // pos=0
      expect(qc.snapshot("d1").currentIndex).toBe(0);
    });

    it("一轮播完自动重洗后 next 不立刻重播当前曲", async () => {
      // 2 首歌:序列 [0,1],pos=0;next→1;再 next 一轮播完→重建→当前曲入头→取第 2 位
      qc.setQueue("d1", [
        { songId: "s1", title: "t1", mime: "audio/mpeg" },
        { songId: "s2", title: "t2", mime: "audio/mpeg" },
      ], 0, "http://base");
      await qc.next("d1", "http://base");
      const second = qc.snapshot("d1").currentIndex;
      await qc.next("d1", "http://base"); // 一轮播完 → 重建
      const third = qc.snapshot("d1").currentIndex;
      expect(second).not.toBe(0);
      expect(third).not.toBe(second); // 新轮次:换成另一首(不立刻重播当前曲)
    });
  });
});
