// 本机链路接入服务端预探测 + 洗牌序物化(2026-09-11)。
//
// 锁三件事:
//   A. shuffle 模式下 enqueue 也**物化**洗牌序 —— 否则 peekUpcomingPositions 拿空序列
//      扫 0 个位置(`queue/play` 与 `queue/enqueue` 的差异根因);
//   B. 本机(Web/Flutter)队列变动也驱动服务端预探测调度器,且快照带 preProbe;
//   C. 清空本机队列 → 预探测状态一并作废(不留说谎的告警)。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../src/db/index.js";
import { songs, localQueues, users } from "../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { clearStreamFallbackCache } from "../../src/services/source/online/streamFallback.js";
import { getPreProbeScheduler } from "../../src/services/player/preProbeScheduler.js";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { getPeerManager } from "../../src/services/peer.js";

// 原链一律 206 → 每首歌都是"可播",不触发换源搜索。
vi.stubGlobal("fetch", async () => new Response("bytes", { status: 206 }));

const PROVIDER = "lp-test";
const manifestOf = {
  id: PROVIDER, name: PROVIDER, version: "1.0.0", type: "source",
  capabilities: ["search", "stream"], platforms: ["netease"],
  configSchema: [], permissions: ["net"], sourcePreference: ["netease"],
} as const;
const provider = {
  id: PROVIDER,
  manifest: manifestOf,
  search: async () => ({ songs: [] }),
  streamUrl: () => "http://gm/alive.mp3",
};

/** 声明 preProbe 能力 → isCapabilityEnabled("preProbe") 为 true(内存注册表)。 */
const gateManifest = {
  id: "lp-gate", name: "lp-gate", version: "1.0.0", type: "sync",
  capabilities: ["preProbe", "streamFallback"], configSchema: [], permissions: [],
} as const;

beforeAll(() => {
  initDatabase();
  registerPlugin(manifestOf as any, provider);
  registerPlugin(gateManifest as any, {});
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest, config = '{}'
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), new Date().toISOString(), new Date().toISOString());
});

beforeEach(() => {
  clearStreamFallbackCache();
  db.delete(localQueues).run();
  db.delete(songs).run();
  db.delete(users).run();
  // local_queues.user_id 有外键 → 本机队列必须先有对应用户行。
  for (const u of ["u1", "u2", "u3"]) {
    db.insert(users).values({
      id: u, username: u, password: "", salt: "s", subsonicSalt: "ss",
      isAdmin: 1, isActive: 1, email: "",
    }).run();
  }
  const s = getPreProbeScheduler();
  s.resetForTest();
  s.onScanComplete = null;
  unregisterPlugin("lp-gate");
  registerPlugin(gateManifest as any, {});
});

/** 存一首 web 歌(pluginEntry 齐备 → 预探测会真的走 ensurePlayableStream)。 */
function seed(id: string) {
  db.insert(songs).values({
    id, title: `t-${id}`, artist: "a", album: "al", duration: 100,
    path: `web:${PROVIDER}:netease`, contentType: "audio/mpeg", suffix: "mp3",
    type: "web", url: `http://orig/${id}.mp3`, pluginEntry: PROVIDER,
    sourceData: JSON.stringify({ title: `t-${id}`, artist: "a", source: "netease" }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
}

/** 在触发队列变动**之前**挂好扫描完成回调,避免竞态挂死。 */
function scanOnce(): Promise<void> {
  return new Promise<void>(res => { getPreProbeScheduler().onScanComplete = () => res(); });
}

function makePlayer(id: string): UniversalPlayer & { calls: string[] } {
  const calls: string[] = [];
  return {
    playerId: `dlna:${id}`,
    name: id,
    attachProtocol: () => {},
    getProtocol: () => { throw new Error("unused"); },
    playMedia: async () => { calls.push("playMedia"); return { mediaUri: "u" }; },
    stop: async () => { calls.push("stop"); },
    pause: async () => {}, resume: async () => {}, seek: async () => {}, setVolume: async () => {},
    pollState: async () => ({ playerId: `dlna:${id}`, playbackState: PlaybackState.PLAYING, position: 0, duration: 0, updatedAt: Date.now() }),
    calls,
  } as unknown as UniversalPlayer & { calls: string[] };
}
const ctrl = {
  beginOptimistic: () => {}, endOptimistic: () => {},
  reportState: () => {}, resetTracker: () => {},
};

// ==================== A. shuffle 模式下 enqueue 也要物化洗牌序 ====================
describe("shuffleOrder 物化(修 lookahead 扫 0)", () => {
  it("enqueue 到空 shuffle 队列:序列长度 = 队列长度,且预探测真的扫到位置", async () => {
    for (const id of ["a1", "a2", "a3", "a4"]) seed(id);
    const qc = new QueueController();
    qc.registerPlayer("dd", makePlayer("dd"), ctrl as any);

    const done = scanOnce();
    await qc.enqueue("dd", ["a1", "a2", "a3", "a4"].map(id => ({ songId: id, title: id, mime: "audio/mpeg" })), "http://base");
    await done;

    const snap = qc.snapshot("dd");
    expect(snap.playMode).toBe("shuffle");
    // 修复点:此前 enqueue 从不 rebuildShuffle → 这里会是 0。
    expect(snap.shuffleOrder?.length).toBe(4);
    // 序列物化后,peekUpcomingPositions 在 shuffle 分支才能取到位置 → scanned > 0。
    expect(snap.preProbe?.scanned ?? 0).toBeGreaterThan(0);
    expect(snap.preProbe?.ready ?? 0).toBeGreaterThan(0);
  }, 20000);

  it("setPlayMode('shuffle') 后同样物化(切模式路径也不该扫 0)", async () => {
    for (const id of ["b1", "b2", "b3", "b4"]) seed(id);
    const qc = new QueueController();
    qc.registerPlayer("ee", makePlayer("ee"), ctrl as any);
    qc.setQueue("ee", ["b1", "b2", "b3", "b4"].map(id => ({ songId: id, title: id, mime: "audio/mpeg" })), 0, "http://base");
    qc.setPlayMode("ee", "order");
    const done = scanOnce();
    qc.setPlayMode("ee", "shuffle");
    await done;

    const snap = qc.snapshot("ee");
    expect(snap.playMode).toBe("shuffle");
    expect(snap.shuffleOrder?.length).toBe(4);
  }, 20000);
});

// ==================== B. 本机队列驱动服务端预探测 ====================
describe("本机(local)队列接入服务端预探测", () => {
  it("localPlayFrom 触发扫描,快照带 preProbe 且已判活", async () => {
    for (const id of ["l1", "l2", "l3", "l4"]) seed(id);
    const pm = getPeerManager();
    const done = scanOnce();
    pm.localPlayFrom("local:u1", "u1", ["l1", "l2", "l3", "l4"].map(id => ({ songId: id, title: id })), 0);
    await done;

    const snap = pm.getQueueSnapshot("local:u1")!;
    expect(snap.items).toHaveLength(4);
    expect(snap.preProbe).toBeTruthy();
    // 本机队列 playMode = order → 按下标预扫,与投屏链路同一套判定。
    expect(snap.preProbe!.scanned).toBeGreaterThan(0);
    expect(snap.preProbe!.ready).toBeGreaterThan(0);
  }, 20000);

  it("localSetIndex(切歌)后重新扫描窗口", async () => {
    for (const id of ["m1", "m2", "m3", "m4"]) seed(id);
    const pm = getPeerManager();
    await (async () => { const d = scanOnce(); pm.localPlayFrom("local:u2", "u2", ["m1", "m2", "m3", "m4"].map(id => ({ songId: id, title: id })), 0); await d; })();
    const first = pm.getQueueSnapshot("local:u2")!.preProbe!;
    const done = scanOnce();
    pm.localSetIndex("local:u2", 2);
    await done;
    const after = pm.getQueueSnapshot("local:u2")!.preProbe!;
    expect(after.at).toBeGreaterThanOrEqual(first.at); // 状态被刷新
  }, 20000);

  it("清空本机队列 → 预探测状态一并作废", async () => {
    for (const id of ["n1", "n2", "n3"]) seed(id);
    const pm = getPeerManager();
    const done = scanOnce();
    pm.localPlayFrom("local:u3", "u3", ["n1", "n2", "n3"].map(id => ({ songId: id, title: id })), 0);
    await done;
    expect(pm.getQueueSnapshot("local:u3")!.preProbe!.scanned).toBeGreaterThan(0);

    pm.localClear("local:u3");
    const snap = pm.getQueueSnapshot("local:u3")!;
    expect(snap.items).toHaveLength(0);
    expect(snap.preProbe!.scanned).toBe(0); // clear() 已把状态抹掉
    expect(snap.preProbe!.exhausted).toBe(false);
  }, 20000);
});
