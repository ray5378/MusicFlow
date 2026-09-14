// 定期孤儿清理测试:验证各模块 pruneOrphans 按合法 key 集合删除残留孤儿,
// 且空集合时不动(防误删)。
import { describe, it, expect, beforeAll } from "vitest";
import { getEventManager } from "../../src/services/dlna/eventing.js";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import { pruneOrphansOnce } from "../../src/services/memory/pruneOrphans.js";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
  // 清空设备/组表,保证 pruneOrphansOnce 冒烟用例的合法集合为空
  sqlite.prepare("DELETE FROM dlna_devices").run();
  sqlite.prepare("DELETE FROM player_groups").run();
});

describe("eventing.pruneOrphans", () => {
  it("删除不在合法设备集合中的事件状态缓存", () => {
    const em = getEventManager();
    const ghost = "ghost-device-" + Date.now();
    em.setVolume(ghost, 50); // 注入 states
    expect(em.getEventState(ghost)).toBeDefined();
    em.pruneOrphans(new Set(["real-device"]));
    expect(em.getEventState(ghost)).toBeUndefined();
  });
});

describe("QueueController.pruneOrphans", () => {
  it("删除已不在设备/组表中的注册播放器,空集合不动", () => {
    const qc = new QueueController();
    const mockPlayer = { playerId: "d1" } as any;
    const mockCtrl = { beginOptimistic: () => {}, endOptimistic: () => {}, reportState: () => {}, resetTracker: () => {} };

    qc.registerPlayer("d1", mockPlayer, mockCtrl);
    expect((qc as any).players.has("d1")).toBe(true);

    // 合法集合包含 d1 → 不动
    qc.pruneOrphans(new Set(["d1"]), new Set());
    expect((qc as any).players.has("d1")).toBe(true);

    // d1 已不在合法集合 → 删除(连带 ctrls/queues/skipCounters)
    qc.pruneOrphans(new Set(["d2"]), new Set());
    expect((qc as any).players.has("d1")).toBe(false);
    expect((qc as any).ctrls.has("d1")).toBe(false);
    expect((qc as any).queues.has("d1")).toBe(false);

    // 空合法集合 → 不动(防误删)
    qc.registerPlayer("d3", mockPlayer, mockCtrl);
    qc.pruneOrphans(new Set(), new Set());
    expect((qc as any).players.has("d3")).toBe(true);
  });
});

describe("PlayerController.pruneOrphans", () => {
  it("删除不在合法 playerId 集合中的最新状态", () => {
    const ctrl = new PlayerController();
    const ghost = "dlna:ghost-" + Date.now();
    ctrl.reportState({ playerId: ghost, playbackState: PlaybackState.PLAYING, position: 0, duration: 100, mediaUri: "u", updatedAt: Date.now() });
    expect(ctrl.getLatest(ghost)).toBeDefined();
    ctrl.pruneOrphans(new Set(["dlna:real", "local:u1"]));
    expect(ctrl.getLatest(ghost)).toBeUndefined();
  });
});

describe("pruneOrphansOnce 冒烟", () => {
  it("空库(无设备/无组/无用户)下调用不抛错", () => {
    expect(() => pruneOrphansOnce()).not.toThrow();
  });
});

describe("pruneOrphansOnce 回归:sendspin 客户端不得被当孤儿", () => {
  // 线上事故:每 10 分钟一轮的清理把播着的 sendspin 播放器 + 队列 + tracker
  // 整个删掉(合法集合只认 DLNA/AirPlay/组/用户),表现为"播完一首就停、队列清空"。
  it("在线 sendspin peer 的播放器/队列/状态在清理后保留", async () => {
    const { getPeerManager } = await import("../../src/services/peer.js");
    const { getQueueController } = await import("../../src/services/player/index.js");
    const { getPlayerController } = await import("../../src/services/player/index.js");
    const pm = getPeerManager();
    const qc = getQueueController();
    const pc = getPlayerController();
    const cid = "e2e-prune-test-" + Date.now();
    const peerId = `sendspin:${cid}`;
    const mockPlayer = { playerId: peerId } as any;
    const mockCtrl = { beginOptimistic: () => {}, endOptimistic: () => {}, reportState: () => {}, resetTracker: () => {} };

    pm.registerSendspin(cid, "Prune Test", true);
    qc.registerPlayer(cid, mockPlayer, mockCtrl);
    (qc as any).queues.set(cid, { items: [{ songId: "s1" }], currentIndex: 0, playMode: "order", isActive: true, ended: false });
    pc.reportState({ playerId: peerId, playbackState: PlaybackState.PLAYING, position: 1, duration: 100, mediaUri: "u", updatedAt: Date.now() });

    pruneOrphansOnce();

    expect(pm.get(peerId)).toBeDefined();
    expect((qc as any).players.has(cid)).toBe(true);
    expect((qc as any).queues.get(cid)?.items).toHaveLength(1);
    expect(pc.getLatest(peerId)).toBeDefined();

    // 清理:不污染同文件其他用例
    pm.removeSendspinPeer(cid);
    qc.pruneOrphans(new Set(["__cleanup__"]), new Set());
    pc.pruneOrphans(new Set(["__cleanup__"]));
    expect((qc as any).players.has(cid)).toBe(false);
    expect(pc.getLatest(peerId)).toBeUndefined();
  });
});
