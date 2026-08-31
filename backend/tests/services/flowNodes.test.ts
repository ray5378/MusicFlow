// 音流节点引擎测试(executeFlow → runInternal 节点遍历):
//   1. 缺 nodes → error「未配置节点」
//   2. 无 target 节点 → error「未配置目标设备/组节点」
//   3. 多 target 节点 → 目标并集,content 对全部在线目标播放
//   4. 节点顺序执行 + delay 任意位置生效(playFrom 之后有 >=ms 间隔再 volume)
//   5. volume 失败(未确认)→ 中止流程,后续节点不再执行
//   6. trigger 节点无副作用,流程正常完成
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "../../src/db/index.js";
import { flows } from "../../src/db/schema.js";

// 跨 mock 共享单例与调用日志(vi.mock factory 提升,不能引用文件作用域变量)。
const h = vi.hoisted(() => ({
  callLog: [] as string[],
  qm: { setPlayMode: null as any, playFrom: null as any },
  qc: { transport: null as any },
  sdv: null as any,
}));

vi.mock("../../src/services/peer.js", async (importOriginal) => {
  const orig = await importOriginal<any>();
  const available = new Map<string, boolean>();
  return {
    ...orig,
    getPeerManager: () => ({
      get: (pid: string) => (available.get(pid) === false ? undefined : { peerId: pid, name: pid, available: true }),
    }),
    __setAvailable: (pid: string, on: boolean) => available.set(pid, on),
  };
});

vi.mock("../../src/services/dlna/queue.js", async (importOriginal) => {
  const orig = await importOriginal<any>();
  h.qm.setPlayMode = vi.fn();
  h.qm.playFrom = vi.fn(async (id: string) => { h.callLog.push("play:" + id); });
  return { ...orig, getQueueManager: () => h.qm };
});

vi.mock("../../src/services/player/index.js", async (importOriginal) => {
  const orig = await importOriginal<any>();
  h.qc.transport = vi.fn(async () => { h.callLog.push("transport"); });
  return { ...orig, getQueueController: () => h.qc };
});

vi.mock("../../src/services/dlna/control.js", async (importOriginal) => {
  const orig = await importOriginal<any>();
  h.sdv = vi.fn(async (_id: string, v: number) => { h.callLog.push("vol:" + v); });
  return { ...orig, refreshDevices: vi.fn(async () => []), setDeviceVolume: h.sdv };
});

vi.mock("../../src/services/content.js", async (importOriginal) => {
  const orig = await importOriginal<any>();
  return {
    ...orig,
    resolveContentSongs: vi.fn(() => ({ rows: [{ id: "s1", title: "测试曲" }], name: "测试歌单" })),
    songsToQueueItems: vi.fn((rows: any[]) => rows.map((r) => ({ songId: r.id, title: r.title || "t" }))),
  };
});

vi.mock("../../src/services/plugin/fixedRecommend.js", async (importOriginal) => {
  const orig = await importOriginal<any>();
  return {
    ...orig,
    isFixedRecommendPlaylist: vi.fn(() => false),
    ensureHomePlaylist: vi.fn(async () => ({ ok: true })),
  };
});

import { executeFlow } from "../../src/services/flows/index.js";
import { resolveContentSongs } from "../../src/services/content.js";

const U = "u-flow-test";
const DEV_A = "dlna:AAA-111";
const DEV_B = "dlna:BBB-222";

function seedFlow(id: string, definition: any) {
  db.insert(flows).values({
    id, token: "tok-" + id, tokenId: "", ownerUserId: U, name: id,
    definitionJson: JSON.stringify(definition), enabled: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
}

async function waitStatus(id: string, timeoutMs = 10000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = db.select().from(flows).where(eq(flows.id, id)).get();
    if (r && ["success", "error", "timeout"].includes(r.lastRunStatus)) {
      return r.lastRunStatus + ":" + (r.lastRunError || "");
    }
    await new Promise((r2) => setTimeout(r2, 25));
  }
  return "TIMEOUT_unknown";
}

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  db.delete(flows).where(eq(flows.ownerUserId, U)).run();
  vi.clearAllMocks();
  h.callLog.length = 0;
  h.sdv.mockImplementation(async (_id: string, v: number) => { h.callLog.push("vol:" + v); });
});

describe("音流节点引擎", () => {
  it("缺 nodes → error:未配置节点", async () => {
    seedFlow("f-no-nodes", { waitTimeoutSec: 0, scanIntervalSec: 2 });
    await executeFlow("f-no-nodes", "http://test");
    const st = await waitStatus("f-no-nodes");
    expect(st).toContain("error");
    expect(st).toContain("未配置节点");
  });

  it("无 target 节点 → error:未配置目标设备/组节点", async () => {
    seedFlow("f-no-target", { waitTimeoutSec: 0, scanIntervalSec: 2, nodes: [{ type: "trigger", triggerType: "webhook" }, { type: "content", contentType: "playlist", id: "pl-x" }] });
    await executeFlow("f-no-target", "http://test");
    const st = await waitStatus("f-no-target");
    expect(st).toContain("error");
    expect(st).toContain("未配置目标设备/组节点");
  });

  it("多 target 节点 → 目标并集,content 对全部在线目标播放", async () => {
    seedFlow("f-multi", {
      waitTimeoutSec: 0, scanIntervalSec: 2,
      nodes: [
        { type: "trigger", triggerType: "webhook" },
        { type: "target", targets: [DEV_A] },
        { type: "target", targets: [DEV_B] },
        { type: "content", contentType: "playlist", id: "pl-x" },
      ],
    });
    await executeFlow("f-multi", "http://test");
    expect(await waitStatus("f-multi")).toContain("success");
    expect(h.qm.playFrom).toHaveBeenCalledTimes(2);
    const ids = h.qm.playFrom.mock.calls.map((c: any[]) => c[0]).sort();
    expect(ids).toEqual([DEV_A.replace("dlna:", ""), DEV_B.replace("dlna:", "")].sort());
  });

  it("节点顺序执行 + delay 任意位置生效(playFrom 后 >=ms 间隔再 volume)", async () => {
    seedFlow("f-delay", {
      waitTimeoutSec: 0, scanIntervalSec: 2,
      nodes: [
        { type: "trigger", triggerType: "webhook" },
        { type: "target", targets: [DEV_A] },
        { type: "content", contentType: "playlist", id: "pl-x" },
        { type: "delay", ms: 250 },
        { type: "volume", value: 20 },
      ],
    });
    const t0 = Date.now();
    await executeFlow("f-delay", "http://test");
    expect(await waitStatus("f-delay")).toContain("success");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const playIdx = h.callLog.findIndex((x) => x.startsWith("play:"));
    const volIdx = h.callLog.findIndex((x) => x.startsWith("vol:"));
    expect(playIdx).toBeGreaterThanOrEqual(0);
    expect(volIdx).toBeGreaterThan(playIdx);
  });

  it("volume 失败 → 不中止流程,继续执行后续节点", async () => {
    // 目标值 20 恒失败(step1=19 正常),触发 setDeviceVolume 内部对账重发后抛错。
    h.sdv.mockImplementation(async (_id: string, v: number) => {
      if (v === 20) throw new Error("音量对账失败:期望 20,设备回读 80");
      h.callLog.push("vol:" + v);
    });
    seedFlow("f-volfail", {
      waitTimeoutSec: 0, scanIntervalSec: 2,
      nodes: [
        { type: "trigger", triggerType: "webhook" },
        { type: "target", targets: [DEV_A] },
        { type: "content", contentType: "playlist", id: "pl-x" },
        { type: "volume", value: 20 },
        { type: "delay", ms: 100 },
        { type: "volume", value: 30 },
      ],
    });
    await executeFlow("f-volfail", "http://test");
    const st = await waitStatus("f-volfail");
    expect(st).toContain("success");                      // 音量失败不中止,流程照常完成
    expect(h.callLog.some((x) => x === "vol:30")).toBe(true); // 后续 volume(30)节点执行
    expect(h.callLog.some((x) => x === "vol:19")).toBe(true); // 第一台的 step1 也发过
  }, 20000);

  it("trigger 节点无副作用,流程正常完成(手动触发语义)", async () => {
    seedFlow("f-trigger", {
      waitTimeoutSec: 0, scanIntervalSec: 2,
      nodes: [
        { type: "trigger", triggerType: "webhook" },
        { type: "target", targets: [DEV_A] },
        { type: "content", contentType: "playlist", id: "pl-x" },
      ],
    });
    await executeFlow("f-trigger", "http://test");
    expect(await waitStatus("f-trigger")).toContain("success");
    expect(resolveContentSongs).toHaveBeenCalled();
    expect(h.qc.transport).not.toHaveBeenCalled();
  });
});
