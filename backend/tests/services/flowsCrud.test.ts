// 音流「非执行面」+ 引擎边角(services/flows/index.ts)。
//
// 既有两个测试只覆盖**执行面**的两条主干:
//   - tests/services/flowNodes.test.ts   → runInternal 的节点遍历(缺节点/多 target/delay/volume/trigger)
//   - tests/services/flowWaitGate.test.ts → 等待闸门 / already-running
// 而路由层(src/routes/api/shared.ts)真正依赖的是 listFlows / createFlow / updateFlow /
// deleteFlow / getFlow / getFlowByToken / setFlowEnabled —— 这些函数**此前一行未跑**。
// 本文件补齐两块:
//   ① CRUD 与定义解析(断言的是**当前实现语义**,即 characterization),尤其
//      `updateFlow` 的「undefined = 保持原值」约定、`parseDef` 对坏 JSON / 非法节点的
//      **静默兜底**(不抛错)、`createFlow` 的 token 形状(32 位 hex 无连字符);
//   ② 引擎边角:playmode 节点、group 目标的音量扇出、固定推荐歌单未就绪 / 内容为空 /
//      内容解析抛错 / 依赖构造抛错各自写回哪个 status。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

// 执行面依赖全部换最小替身:本文件只关心读写面与少量分支判定。
const st = vi.hoisted(() => ({
  ready: true,
  fixedIds: [] as string[],
  ensure: { ok: true } as { ok: boolean; reason?: string },
  contentRows: [{ id: "s1" }] as any[],
  contentThrow: false,
  qcThrow: false,
  log: [] as string[],
}));

vi.mock("../../src/services/playTarget.js", () => ({
  checkPlayTarget: () => ({ playable: st.ready, reason: st.ready ? undefined : "未就绪" }),
}));
vi.mock("../../src/services/peer.js", () => ({
  parsePeerId: (v: string) => {
    const i = String(v).indexOf(":");
    if (i < 0) return null;
    const kind = String(v).slice(0, i);
    if (!["dlna", "group", "airplay", "sendspin", "local"].includes(kind)) return null;
    return { kind, id: String(v).slice(i + 1), peerId: v };
  },
  getPeerManager: () => ({
    resolveVisiblePeerId: (p: string) => p,
    get: (p: string) => ({ name: p, available: true }),
  }),
}));
vi.mock("../../src/services/dlna/control.js", () => ({
  refreshDevices: async () => {},
  setDeviceVolume: async (_id: string, v: number) => {
    st.log.push(`sdv:${_id}:${v}`);
  },
}));
vi.mock("../../src/services/dlna/queue.js", () => ({
  getQueueManager: () => ({
    playFrom: async (id: string) => {
      st.log.push(`play:${id}`);
    },
    setPlayMode: (id: string, mode: string) => {
      st.log.push(`mode:${id}:${mode}`);
    },
  }),
}));
vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => {
    if (st.qcThrow) throw new Error("qc 构造失败");
    return {
      transport: async (id: string, op: string, value: number) => {
        st.log.push(`transport:${id}:${op}:${value}`);
      },
    };
  },
}));
vi.mock("../../src/services/content.js", () => ({
  resolveContentSongs: async () => {
    if (st.contentThrow) throw new Error("内容解析炸了");
    return { name: "测试歌单", rows: st.contentRows };
  },
  songsToQueueItems: (rows: any[]) => rows.map((r) => ({ songId: r.id })),
}));
vi.mock("../../src/services/plugin/fixedRecommend.js", () => ({
  isFixedRecommendPlaylist: (id: string) => st.fixedIds.includes(id),
  ensureHomePlaylist: async () => st.ensure,
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

import {
  listFlows,
  getFlow,
  getFlowByToken,
  createFlow,
  updateFlow,
  deleteFlow,
  setFlowEnabled,
  isFlowRunning,
  executeFlow,
} from "../../src/services/flows/index.js";

/** 与 src/db/index.ts 的 flows 表定义一致(与 flowWaitGate.test.ts 用同一份 DDL)。 */
const DDL = `
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
  );`;

const INS = `INSERT INTO flows (id, token, token_id, owner_user_id, name, definition_json, enabled,
                last_run_at, last_run_status, last_run_error, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

function seedRow(
  id: string,
  opts: {
    owner?: string;
    name?: string;
    defJson?: string;
    enabled?: number;
    token?: string;
    tokenId?: string | null;
  } = {},
) {
  sqlite
    .prepare(INS)
    .run(
      id,
      opts.token ?? `tok-${id}`,
      opts.tokenId === undefined ? "" : opts.tokenId,
      opts.owner ?? "u-fc",
      opts.name ?? id,
      opts.defJson ?? "{}",
      opts.enabled ?? 1,
      "",
      "",
      "",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
}

const DEF_BASIC = {
  nodes: [{ type: "target", targets: ["dlna:d1"] }],
  waitTimeoutSec: 0,
  scanIntervalSec: 5,
};

/** 起一条可立即放行的音流(目标 dlna:d1 视为在线可播)。 */
async function runFlow(id: string, nodes: any[], base = "http://base") {
  seedRow(id, { defJson: JSON.stringify({ nodes, waitTimeoutSec: 0, scanIntervalSec: 2 }) });
  await executeFlow(id, base);
  const t0 = Date.now();
  while (isFlowRunning(id) && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return getFlow(id)!;
}

beforeAll(() => {
  sqlite.exec(DDL);
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM flows").run();
  st.ready = true;
  st.fixedIds = [];
  st.ensure = { ok: true };
  st.contentRows = [{ id: "s1" }];
  st.contentThrow = false;
  st.qcThrow = false;
  st.log.length = 0;
});

describe("flows CRUD:列表 / 读取 / token 查询", () => {
  it("listFlows() 返回全部;listFlows(owner) 只返回该属主的", () => {
    seedRow("f-a", { owner: "u1" });
    seedRow("f-b", { owner: "u1" });
    seedRow("f-c", { owner: "u2" });

    expect(listFlows().map((f) => f.id).sort()).toEqual(["f-a", "f-b", "f-c"]);
    expect(listFlows("u1").map((f) => f.id).sort()).toEqual(["f-a", "f-b"]);
    expect(listFlows("nobody")).toEqual([]);
  });

  it("getFlow(id) 拿到;getFlow(id, 别人的 owner) 拿不到(归属即隔离)", () => {
    seedRow("f-own", { owner: "u1" });
    expect(getFlow("f-own")?.id).toBe("f-own");
    expect(getFlow("f-own", "u1")?.id).toBe("f-own");
    expect(getFlow("f-own", "u2")).toBeUndefined();
    expect(getFlow("f-missing")).toBeUndefined();
  });

  it("getFlowByToken 按 token 命中;不存在返回 undefined", () => {
    seedRow("f-tok", { token: "deadbeef" });
    expect(getFlowByToken("deadbeef")?.id).toBe("f-tok");
    expect(getFlowByToken("nope")).toBeUndefined();
  });
});

describe("parseDef / rowToFlow:坏数据一律静默兜底,绝不抛错", () => {
  it("坏 JSON → 空节点 + 默认超时(0)与默认扫描间隔(5)", () => {
    seedRow("f-badjson", { defJson: "not-json{{{" });
    const f = getFlow("f-badjson")!;
    expect(f.definition.nodes).toEqual([]);
    expect(f.definition.waitTimeoutSec).toBe(0);
    expect(f.definition.scanIntervalSec).toBe(5);
  });

  it("nodes 不是数组 → 空数组", () => {
    seedRow("f-nodesnotarray", { defJson: JSON.stringify({ nodes: { nope: 1 } }) });
    expect(getFlow("f-nodesnotarray")!.definition.nodes).toEqual([]);
  });

  it("waitTimeoutSec / scanIntervalSec 非数字 → 回落默认值(不留下 NaN)", () => {
    seedRow("f-badsec", {
      defJson: JSON.stringify({ nodes: [], waitTimeoutSec: "30", scanIntervalSec: null }),
    });
    const f = getFlow("f-badsec")!;
    expect(f.definition.waitTimeoutSec).toBe(0);
    expect(f.definition.scanIntervalSec).toBe(5);
  });

  it("isValidNode:六种节点全通过;非法/未知节点被静默剔除", () => {
    const good = [
      { type: "trigger", triggerType: "webhook" },
      { type: "target", targets: ["dlna:d1"] },
      { type: "content", contentType: "playlist", id: "pl-x" },
      { type: "playmode", mode: "shuffle" },
      { type: "volume", value: 42 },
      { type: "delay", ms: 100 },
    ];
    const bad = [
      null,
      "string-node",
      42,
      { type: "trigger", triggerType: "cron" }, // 触发类型只认 webhook
      { type: "target" }, // 缺 targets
      { type: "target", targets: "dlna:d1" }, // targets 不是数组
      { type: "content", contentType: "podcast", id: "x" },
      { type: "content", contentType: "album" }, // 缺 id
      { type: "content", contentType: "album", id: 7 }, // id 不是字符串
      { type: "playmode", mode: "random" },
      { type: "volume", value: "50" },
      { type: "delay" },
      { type: "nope" },
    ];
    seedRow("f-nodes", { defJson: JSON.stringify({ nodes: [...good, ...bad] }) });
    const nodes = getFlow("f-nodes")!.definition.nodes;
    expect(nodes).toHaveLength(good.length);
    expect(nodes.map((n: any) => n.type)).toEqual(good.map((n) => n.type));
  });

  it("rowToFlow:可空列全部回落空串,enabled 0 → false", () => {
    sqlite
      .prepare(
        `INSERT INTO flows (id, token, token_id, owner_user_id, name, definition_json, enabled,
                            last_run_at, last_run_status, last_run_error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run("f-null", "tok-null", null, null, "n", "{}", 0, null, null, null, null, null);

    const f = getFlow("f-null")!;
    expect(f.tokenId).toBe("");
    expect(f.ownerUserId).toBe("");
    expect(f.enabled).toBe(false);
    expect(f.lastRunAt).toBe("");
    expect(f.lastRunStatus).toBe("");
    expect(f.lastRunError).toBe("");
    expect(f.createdAt).toBe("");
    expect(f.updatedAt).toBe("");
  });

  it("enabled=1 → true(取行时做了 === 1 归一化,不是直接透传整数)", () => {
    seedRow("f-on", { enabled: 1 });
    expect(getFlow("f-on")!.enabled).toBe(true);
  });
});

describe("createFlow / updateFlow / deleteFlow / setFlowEnabled", () => {
  it("createFlow:落库 + 生成 32 位无连字符 hex token + 默认 enabled", () => {
    const f = createFlow("u-c", "新音流", DEF_BASIC as any, "tk-1");
    expect(f.id.startsWith("flow-")).toBe(true);
    expect(f.name).toBe("新音流");
    expect(f.ownerUserId).toBe("u-c");
    expect(f.tokenId).toBe("tk-1");
    expect(f.enabled).toBe(true);
    // uuid v4 去掉连字符 = 32 位小写 hex
    expect(f.token).toMatch(/^[0-9a-f]{32}$/);
    expect(f.definition.nodes).toHaveLength(1);
    expect(f.createdAt).not.toBe("");
    // 已持久化,且能按 id / token 反查
    expect(getFlow(f.id)?.id).toBe(f.id);
    expect(getFlowByToken(f.token)?.id).toBe(f.id);
    expect(listFlows("u-c").map((x) => x.id)).toEqual([f.id]);
  });

  it("createFlow:未传 tokenId 时落空串(链接默认未绑定)", () => {
    const f = createFlow("u-c", "无渠道", DEF_BASIC as any);
    expect(f.tokenId).toBe("");
  });

  it("updateFlow:找不到(含 owner 不匹配)返回 undefined 且不改任何行", () => {
    seedRow("f-u1", { owner: "u1", name: "原名" });
    expect(updateFlow("f-missing", undefined, { name: "X" })).toBeUndefined();
    expect(updateFlow("f-u1", "u2", { name: "X" })).toBeUndefined();
    expect(getFlow("f-u1")!.name).toBe("原名");
  });

  it("updateFlow:只给 name 时,definition / tokenId / enabled 全部保持原值", () => {
    seedRow("f-u2", {
      owner: "u1",
      name: "旧名",
      enabled: 0,
      tokenId: "tk-keep",
      defJson: JSON.stringify(DEF_BASIC),
    });
    const r = updateFlow("f-u2", "u1", { name: "新名" })!;
    expect(r.name).toBe("新名");
    expect(r.tokenId).toBe("tk-keep");
    expect(r.enabled).toBe(false);
    expect(r.definition.nodes).toHaveLength(1);
    expect(r.definition.scanIntervalSec).toBe(5);
  });

  it("updateFlow:tokenId 传 undefined = 保持;传空串 = 显式清空", () => {
    seedRow("f-u3", { tokenId: "tk-1" });
    expect(updateFlow("f-u3", undefined, { tokenId: undefined })!.tokenId).toBe("tk-1");
    expect(updateFlow("f-u3", undefined, { tokenId: "" })!.tokenId).toBe("");
  });

  it("updateFlow:definition / enabled 可分别改写", () => {
    seedRow("f-u4", {
      defJson: JSON.stringify({ nodes: [], waitTimeoutSec: 0, scanIntervalSec: 5 }),
    });
    const def2 = { nodes: [{ type: "delay", ms: 10 }], waitTimeoutSec: 7, scanIntervalSec: 3 };
    const a = updateFlow("f-u4", undefined, { definition: def2 as any })!;
    expect(a.definition.waitTimeoutSec).toBe(7);
    expect(a.definition.nodes).toHaveLength(1);

    expect(updateFlow("f-u4", undefined, { enabled: false })!.enabled).toBe(false);
    expect(updateFlow("f-u4", undefined, { enabled: true })!.enabled).toBe(true);
  });

  it("deleteFlow:存在 → true 且真删;不存在 → false", () => {
    seedRow("f-del", { owner: "u1" });
    expect(deleteFlow("f-del")).toBe(true);
    expect(getFlow("f-del")).toBeUndefined();
    expect(deleteFlow("f-del")).toBe(false);
    // owner 不匹配同样算找不到
    seedRow("f-del2", { owner: "u1" });
    expect(deleteFlow("f-del2", "u2")).toBe(false);
    expect(getFlow("f-del2")).toBeDefined();
  });

  it("setFlowEnabled:存在则开/关;不存在是静默 no-op(不抛错)", () => {
    seedRow("f-en", { enabled: 1 });
    setFlowEnabled("f-en", undefined, false);
    expect(getFlow("f-en")!.enabled).toBe(false);
    setFlowEnabled("f-en", undefined, true);
    expect(getFlow("f-en")!.enabled).toBe(true);

    expect(() => setFlowEnabled("f-nope", undefined, false)).not.toThrow();
    expect(() => setFlowEnabled("f-en", "someone-else", false)).not.toThrow();
    expect(getFlow("f-en")!.enabled).toBe(true); // owner 不匹配时不该改
  });
});

describe("executeFlow 的门控:不存在 / 已在运行", () => {
  it("isFlowRunning:未跑过 → false", () => {
    expect(isFlowRunning("f-never")).toBe(false);
  });

  it("executeFlow:音流不存在 → 直接返回 started,不抛错也不占用 running 集合", async () => {
    await expect(executeFlow("f-ghost", "http://base")).resolves.toBe("started");
    await new Promise((r) => setTimeout(r, 50));
    expect(isFlowRunning("f-ghost")).toBe(false);
  });

  it("executeFlow:同一音流第二次触发 → already-running(不叠加执行体)", async () => {
    st.ready = false; // 目标不可播 → 卡在等待阶段,执行体一直挂着
    seedRow("f-run", {
      owner: "u-run",
      defJson: JSON.stringify({
        nodes: [
          { type: "target", targets: ["dlna:d1"] },
          { type: "content", contentType: "playlist", id: "pl-x" },
        ],
        waitTimeoutSec: 0,
        scanIntervalSec: 2,
      }),
    });

    expect(await executeFlow("f-run", "http://base")).toBe("started");
    expect(isFlowRunning("f-run")).toBe(true);
    expect(await executeFlow("f-run", "http://base")).toBe("already-running");

    // 放行后执行体收尾 → running 集合必须被清空(否则这条音流永远触发不了)
    st.ready = true;
    const t0 = Date.now();
    while (isFlowRunning("f-run") && Date.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(isFlowRunning("f-run")).toBe(false);
    expect(getFlow("f-run")!.lastRunStatus).toBe("success");
  }, 20000);
});

describe("引擎边角:playmode / group 音量扇出 / 各种失败写回哪个 status", () => {
  it("playmode 节点对全部在线目标设置播放模式", async () => {
    const row = await runFlow("f-mode", [
      { type: "target", targets: ["dlna:d1"] },
      { type: "content", contentType: "playlist", id: "pl-x" },
      { type: "playmode", mode: "shuffle" },
    ]);
    expect(row.lastRunStatus).toBe("success");
    expect(st.log).toContain("mode:d1:shuffle");
  });

  it("volume 节点:dlna 走 setDeviceVolume,group 走 qc.transport(两条链路各一次)", async () => {
    const row = await runFlow("f-vol", [
      { type: "target", targets: ["dlna:d1", "group:g1"] },
      { type: "content", contentType: "playlist", id: "pl-x" },
      { type: "volume", value: 33 },
    ]);
    expect(row.lastRunStatus).toBe("success");
    expect(st.log).toContain("sdv:d1:33"); // dlna → 设备音量
    expect(st.log).toContain("transport:g1:volume:33"); // group → 组内扇出
  });

  it("音量值被夹在 0..100 并取整(150 → 100)", async () => {
    const row = await runFlow("f-volclamp", [
      { type: "target", targets: ["dlna:d1"] },
      { type: "volume", value: 150.6 },
    ]);
    expect(row.lastRunStatus).toBe("success");
    expect(st.log).toContain("sdv:d1:100");
  });

  it("固定推荐歌单未就绪 → 中止为 error,且不投播", async () => {
    st.fixedIds = ["pl-random-songs"];
    st.ensure = { ok: false, reason: "生成失败" };
    const row = await runFlow("f-fixed", [
      { type: "target", targets: ["dlna:d1"] },
      { type: "content", contentType: "playlist", id: "pl-random-songs", name: "随机歌曲" },
    ]);
    expect(row.lastRunStatus).toBe("error");
    expect(row.lastRunError).toContain("未就绪");
    expect(st.log.filter((x) => x.startsWith("play:"))).toEqual([]);
  });

  it("内容为空可播歌曲 → error「无可播放歌曲」,不投播", async () => {
    st.contentRows = [];
    const row = await runFlow("f-empty", [
      { type: "target", targets: ["dlna:d1"] },
      { type: "content", contentType: "playlist", id: "pl-x", name: "空歌单" },
    ]);
    expect(row.lastRunStatus).toBe("error");
    expect(row.lastRunError).toContain("无可播放歌曲");
    expect(st.log.filter((x) => x.startsWith("play:"))).toEqual([]);
  });

  it("内容解析抛错 → 整个流程中止为 error(异常被收进 lastRunError,不外泄)", async () => {
    st.contentThrow = true;
    const row = await runFlow("f-throw", [
      { type: "target", targets: ["dlna:d1"] },
      { type: "content", contentType: "playlist", id: "pl-x" },
    ]);
    expect(row.lastRunStatus).toBe("error");
    expect(row.lastRunError).toContain("内容解析炸了");
  });

  it("依赖构造阶段抛错(runInternal 之外)→ executeFlow 兜底写 error 并释放 running", async () => {
    st.qcThrow = true;
    seedRow("f-qcboom", {
      defJson: JSON.stringify({
        nodes: [
          { type: "target", targets: ["dlna:d1"] },
          { type: "content", contentType: "playlist", id: "pl-x" },
        ],
        waitTimeoutSec: 0,
        scanIntervalSec: 2,
      }),
    });
    await executeFlow("f-qcboom", "http://base");
    const t0 = Date.now();
    while (isFlowRunning("f-qcboom") && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(isFlowRunning("f-qcboom")).toBe(false);
    const row = getFlow("f-qcboom")!;
    expect(row.lastRunStatus).toBe("error");
    expect(row.lastRunError).toContain("qc 构造失败");
  }, 20000);

  it("trigger 节点只作声明:不产生任何副作用就继续后续节点", async () => {
    const row = await runFlow("f-trig", [
      { type: "trigger", triggerType: "webhook" },
      { type: "target", targets: ["dlna:d1"] },
      { type: "content", contentType: "playlist", id: "pl-x" },
    ]);
    expect(row.lastRunStatus).toBe("success");
    expect(st.log).toEqual(["play:d1"]);
  });
});
