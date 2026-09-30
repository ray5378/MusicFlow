// P1 门禁:fork(子进程)路径必须把续播位置透传到底层 playCore / playGroupCore。
//
// 为什么必须钉死:暂停后恢复播放曾「从头开始」(v4.0.70 修复)。修复有两个落点:
//   1. in-proc 路径:`protocolPlayer.coldStartResume` 读回暂停位置 → playMedia(item, url, startMs);
//   2. fork 路径:`sendspinSupervisor.rpc("playMedia", { ..., seekPositionMs })`
//      → 子进程 `childMain.dispatch` → `playCore(..., seekPositionMs)`。
//
// (2) 是**静默失效高危区**:主进程测试跑的是 in-proc,子进程 RPC 参数漏传时
// 既有测试全绿,只有真机 fork 模式才暴露(续播回 0)。本协议层断言把两条路径
// 一起钉死 —— 契约是「参数必须到达 playerCore」,与走哪条通道无关。
//
// 做法:mock `./playerCore.js`(只验参数透传,不起真 pump),用假 server 驱动
// 真实的 SendspinChildController(与 child.ts 跑的是同一套 handler)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: Array<[string, any[]]> = [];
  return { calls };
});

vi.mock("./playerCore.js", () => ({
  playCore: (...a: any[]) => { h.calls.push(["playCore", a]); },
  playGroupCore: (...a: any[]) => { h.calls.push(["playGroupCore", a]); },
  stopCore: vi.fn(),
  stopGroupCore: vi.fn(),
  pauseCore: vi.fn(),
  resumePumpCore: vi.fn(),
  seekCore: vi.fn(),
  setVolumeCore: vi.fn(),
  setMutedCore: vi.fn(),
  pollCore: vi.fn(),
  pumpActiveCore: vi.fn(),
  announceCore: vi.fn(),
  announceProbeCore: vi.fn(),
  joinGroupCore: vi.fn(),
  leaveGroupCore: vi.fn(),
}));

import { SendspinChildController } from "./childMain.js";

/** 最小假 server:够 buildState / dispatch 走通即可(不起真服务)。 */
function fakeServer(): any {
  return {
    serverId: "srv-guard",
    clients: new Map<string, any>(),
    groups: new Map<string, any>(),
    pairing: { listAttempts: () => [] },
    pairingStore: undefined,
  };
}

function makeController() {
  const sent: any[] = [];
  const srv = fakeServer();
  const c = new SendspinChildController(
    { getServer: () => srv, stopRuntime: async () => {} },
    (m: any) => { sent.push(m); },
  );
  return { c, sent, srv };
}

const ITEM = { songId: "s1", title: "T", durationMs: 120000 } as any;

describe("sendspin fork 路径续播位置透传(P1:seekPositionMs 必须到达 playerCore)", () => {
  beforeEach(() => { h.calls.length = 0; });

  it("playMedia:续播位置经 RPC 落到 playCore 第 5 参", async () => {
    const { c } = makeController();
    await (c as any).dispatch("playMedia", { clientId: "dev1", item: ITEM, seekPositionMs: 40064 });
    const call = h.calls.find((x) => x[0] === "playCore");
    expect(call, "playCore 必须被调用").toBeTruthy();
    // playCore(srv, clientId, item, onFail, seekPositionMs?)
    expect(call![1][1]).toBe("dev1");
    expect(call![1][4]).toBe(40064);
  });

  it("groupPlay:续播位置经 RPC 落到 playGroupCore 第 6 参", async () => {
    const { c } = makeController();
    await (c as any).dispatch("groupPlay", {
      group: "ug:1", members: ["dev1", "dev2"], item: ITEM, seekPositionMs: 127500,
    });
    const call = h.calls.find((x) => x[0] === "playGroupCore");
    expect(call, "playGroupCore 必须被调用").toBeTruthy();
    // playGroupCore(srv, groupName, members, item, onFail, seekPositionMs?)
    expect(call![1][1]).toBe("ug:1");
    expect(call![1][5]).toBe(127500);
  });

  it("未带 seekPositionMs 时传 undefined(不得用 0 覆盖底层默认值)", async () => {
    const { c } = makeController();
    await (c as any).dispatch("playMedia", { clientId: "dev1", item: ITEM });
    const call = h.calls.find((x) => x[0] === "playCore");
    expect(call![1][4]).toBeUndefined();
  });

  it("0 是合法续播位置(从头起播),必须原样透传而非被当成缺省", async () => {
    const { c } = makeController();
    await (c as any).dispatch("playMedia", { clientId: "dev1", item: ITEM, seekPositionMs: 0 });
    const call = h.calls.find((x) => x[0] === "playCore");
    expect(call![1][4]).toBe(0);
  });
});
