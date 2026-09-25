// 音流「等待闸门」:目标没有在线播放器 ⇒ **继续等待,不投放进队列**。
//
// 这是 2026-09-25 定稿需求的一半(另一半在播放层,见 tests/player/playTargetGuard.test.ts):
//   - 音流收到 webhook 就**立即返回**(不在请求里等-player),等待发生在 runInternal 内部;
//   - 但只要目标不可播(组零在线成员 / AirPlay 设备离线),就**不进入播放阶段** —— 宁可
//     一直等(waitTimeoutSec=0 时无限等),也不把内容投进投不出去的目标。
//
// 🔴 为什么必须锁在单测里:不可播的目标只要被放行进 QueueController,后果不是「静默
//   不播」,而是反复 cast 失败 → castFailStreak++ → handleDecision("stalled") 自我续 loop
//   → **边失败边切歌**(真机 6 分钟空转 787 次、idx 293→49)。播放层那道守卫是最后一道
//   保险,本闸门是第一道 —— 两道都得在,缺一道就退化成「靠亿万 Domino 兜底」。
//
// 本文件把判据 mock 成可控开关(判据语义本身由 tests/services/playTarget.test.ts 钉死),
// 只验证执行引擎对判据的**反应**:等待 / 放行 / 超时。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

// vi.hoisted 保证 mock 工厂里拿到的对象在 hoisting 之后仍可用(直接引用 let 会落进 TDZ)。
const st = vi.hoisted(() => ({
  ready: true,                 // checkPlayTarget 的答复
  reason: "" as string | undefined,
  played: [] as { id: string; start: number; n: number }[],
}));

vi.mock("../../src/services/playTarget.js", () => ({
  checkPlayTarget: () => ({ playable: st.ready, reason: st.reason }),
}));
// 外部世界全部换成最小替身:本文件只关心执行引擎的决策节奏。
vi.mock("../../src/services/peer.js", () => ({
  parsePeerId: (v: string) => {
    const i = String(v).indexOf(":");
    if (i < 0) return null;
    const kind = v.slice(0, i);
    if (!["dlna", "group", "airplay", "sendspin", "local"].includes(kind)) return null;
    return { kind, id: v.slice(i + 1), peerId: v };
  },
  getPeerManager: () => ({
    // 音流用它把 local:<userId> 解析成真实 peerId;测试里目标已经是最终形态,原样返回。
    resolveVisiblePeerId: (p: string) => p,
    get: (p: string) => ({ name: p, available: true }),
  }),
}));
vi.mock("../../src/services/dlna/control.js", () => ({
  refreshDevices: async () => {},
  setDeviceVolume: async () => {},
}));
vi.mock("../../src/services/dlna/queue.js", () => ({
  getQueueManager: () => ({
    playFrom: async (_id: string, items: any[], start: number) => {
      st.played.push({ id: _id, start, n: items.length });
    },
    setPlayMode: () => {},
  }),
}));
vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({ transport: async () => {} }),
}));
vi.mock("../../src/services/content.js", () => ({
  resolveContentSongs: async () => ({ name: "测试歌单", rows: [{ id: "s1", title: "t1", duration: 100 }] }),
  songsToQueueItems: (rows: any[]) => rows.map((r) => ({ songId: r.id, title: r.title, mime: "audio/mpeg", duration: r.duration })),
}));
vi.mock("../../src/services/plugin/fixedRecommend.js", () => ({
  isFixedRecommendPlaylist: () => false,
  ensureHomePlaylist: async () => ({ ok: true }),
}));
vi.mock("../../src/services/sendspin/index.js", () => ({
  wakeSendspinDiscovery: async () => ({ rescanned: false, rearmed: [] }),
  isSendspinEnabled: () => false,
  readSendspinPluginConfig: () => ({ autoDiscover: false }),
}));
vi.mock("../../src/services/airplay/discovery.js", () => ({ rescanAirPlayDevices: async () => {} }));
vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({ get: () => undefined }),
  splitMemberId: () => null,
}));

import { executeFlow, getFlow, isFlowRunning } from "../../src/services/flows/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  // 与 src/db/index.ts initDatabase 的 flows 表保持一致(测试库不跑完整初始化)。
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      token_id TEXT DEFAULT '',
      owner_user_id TEXT DEFAULT '',
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT DEFAULT '',
      last_run_status TEXT DEFAULT '',
      last_run_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

/** 落一条「等待:group:g1 + 播放某歌单」的音流。 */
function seed(id: string, waitTimeoutSec: number, scanIntervalSec = 2) {
  sqlite.prepare("DELETE FROM flows").run();
  sqlite
    .prepare(
      `INSERT INTO flows (id, token, token_id, owner_user_id, name, definition_json, enabled,
                          last_run_at, last_run_status, last_run_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      `tok-${id}`,
      "",
      "",
      "等待闸门测试",
      JSON.stringify({
        nodes: [
          { type: "trigger", triggerType: "webhook" },
          { type: "target", targets: ["group:g1"] },
          { type: "content", contentType: "playlist", id: "pl-x", name: "测试歌单" },
        ],
        waitTimeoutSec,
        scanIntervalSec,
      }),
      1,
      "",
      "",
      "",
      "",
      "",
    );
}

beforeEach(() => {
  st.played.length = 0;
  st.ready = true;
  st.reason = undefined;
});

describe("音流等待闸门:目标没在线播放器就继续等待,不投播", () => {
  it("目标不可播 ⇒ 挂着等待,多轮扫描都不发 playlist 播放;成员回归后自动开播", async () => {
    st.ready = false;
    st.reason = "组内没有在线成员";
    seed("f-wait", 0);

    // webhook 视角:触发必须**立即返回**(等待发生在内部,不占着请求)。
    const t0 = Date.now();
    const ret = await executeFlow("f-wait", "http://base");
    expect(ret).toBe("started");
    expect(Date.now() - t0).toBeLessThan(1000);

    // 跨过至少两轮扫描间隔(2s/轮):期间绝不能起播。
    await sleep(4500);
    expect(st.played).toEqual([]);
    expect(isFlowRunning("f-wait")).toBe(true);
    expect(getFlow("f-wait")?.lastRunStatus).toBe("waiting");

    // 设备回归(判据转可播)⇒ 不用重新触发,下一轮自己接着播。
    st.ready = true;
    await sleep(3000);
    expect(st.played.length).toBe(1);
    expect(st.played[0].id).toBe("g1");       // 队列按裸 id 起播
    expect(getFlow("f-wait")?.lastRunStatus).toBe("success");
    expect(isFlowRunning("f-wait")).toBe(false);
  }, 20000);

  it("目标已可播 ⇒ 首轮直接放行,不必白等一个扫描间隔", async () => {
    st.ready = true;
    seed("f-ready", 0);

    await executeFlow("f-ready", "http://base");
    await sleep(1200);

    expect(st.played.length).toBe(1);
    expect(getFlow("f-ready")?.lastRunStatus).toBe("success");
  }, 20000);

  it("目标不可播 + 有超时 ⇒ 走 timeout 状态(不是 error、更不是强行投播)", async () => {
    st.ready = false;
    st.reason = "组内没有在线成员";
    seed("f-timeout", 3);

    await executeFlow("f-timeout", "http://base");
    await sleep(6000);

    expect(st.played).toEqual([]);
    const row = getFlow("f-timeout");
    expect(row?.lastRunStatus).toBe("timeout");
    expect(isFlowRunning("f-timeout")).toBe(false);
  }, 20000);

  it("同一音流重复触发 ⇒ 第二次直接跳过(不叠加第二个执行体)", async () => {
    st.ready = false;
    st.reason = "组内没有在线成员";
    seed("f-dup", 0);

    expect(await executeFlow("f-dup", "http://base")).toBe("started");
    expect(await executeFlow("f-dup", "http://base")).toBe("already-running");

    // 只可能有一个执行体在跑:判据转可播后仍然只播一次。
    st.ready = true;
    await sleep(3500);
    expect(st.played.length).toBe(1);
  }, 20000);
});
