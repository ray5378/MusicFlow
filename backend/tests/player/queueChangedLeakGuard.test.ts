// queue_changed 外发守卫(客户端实例链路)。
//
// 锁定的契约:`QueueController` 构造时向**全局**预探测调度器注册的 onChange 回调,
// 只允许为本控制器持有的队列(裸 deviceId / groupId)重发 `queue_changed`。
//
// 背景(2026-09-15 实测):预探测调度器是全局的,本机(local)链路也用它,而本机
// 队列按**完整 peerId**(`local:<userId>:<clientId>`)调度。没有这道守卫时,本机
// 预探测状态一变就会从这里发出 `queue_changed`,把带**明文 clientId** 的完整
// peerId 塞进 WS 的 `device_id` —— 既违反「clientId 永不出服务端」的设计约束,
// 语义也是错的(本机队列的状态通道是 PeerManager 的 `peer_queue_changed`)。
//
// 这类回归不会让任何既有测试变红(WS 里的 device_id 被前端忽略),属于典型的
// 「静默外泄」,只能靠这里钉死。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { sqlite } from "../../src/db/index.js";

// vi.hoisted:让 mock 工厂(会被提升到文件顶部)也能拿到这个数组。
const { captured } = vi.hoisted(() => ({
  captured: [] as ((id: string) => void)[],
}));

// 只替换 getPreProbeScheduler,捕获 QueueController 注册的 onChange 回调,
// 其余导出保持原样(partial mock,与 QueueController.test.ts 同款写法)。
vi.mock(import("../../src/services/player/preProbeScheduler.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getPreProbeScheduler: () => ({
      addOnChange: (cb: (id: string) => void) => {
        captured.push(cb);
      },
      status: () => ({ active: false, pending: 0 }),
      schedule: () => {},
      clear: () => {},
    }),
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
    async pollState() {
      calls.push("pollState");
      return { playerId: "dlna:d1", playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() };
    },
  };
  return {
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
}

describe("QueueController 预探测转发守卫", () => {
  let qc: QueueController;

  beforeEach(() => {
    // 每个用例只保留**这一个**控制器注册的回调,避免跨用例互相触发。
    captured.length = 0;
    qc = new QueueController();
    // QueueController 用裸 deviceId 作 key(与路由/DB 一致)。
    qc.registerPlayer("d1", makeMockPlayer(), {
      beginOptimistic: () => {},
      endOptimistic: () => {},
      reportState: () => {},
      resetTracker: () => {},
      setExpectedDuration: () => {},
    } as any);
    qc.setQueue(
      "d1",
      [
        { songId: "s1", title: "t1", mime: "audio/mpeg" },
        { songId: "s2", title: "t2", mime: "audio/mpeg" },
      ],
      0,
      "http://base",
    );
    expect(captured.length).toBeGreaterThan(0);
  });

  it("本控制器持有的队列 id:预探测变化照常重发 queue_changed", () => {
    const seen: string[] = [];
    qc.on("queue_changed", (id: string) => seen.push(id));

    captured.forEach((cb) => cb("d1"));

    expect(seen).toEqual(["d1"]);
  });

  it("完整 local peerId(含明文 clientId):不得经 queue_changed 外发", () => {
    const seen: string[] = [];
    qc.on("queue_changed", (id: string) => seen.push(id));

    // 本机(local)链路就是按这种完整 peerId 调预探测的。
    captured.forEach((cb) => cb("local:u1:7f3c9a2e1b4d0e8f6a2b3c4d"));

    expect(seen).toEqual([]);
  });

  it("任何未注册队列的 id 都不得外发(不只 local)", () => {
    const seen: string[] = [];
    qc.on("queue_changed", (id: string) => seen.push(id));

    captured.forEach((cb) => cb("group:ghost"));
    captured.forEach((cb) => cb("sendspin:unknown"));

    expect(seen).toEqual([]);
  });
});
