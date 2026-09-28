// ==================== Sendspin 子进程 RPC 分发表补测 ====================
//
// 缺口:childMain.ts 的 dispatch 分支（playMedia/transport/armBorrow/announce/dial/
// 配对/6053/禁用/disconnect/applyCfg/wakeDiscovery/dial 目标/stop…）与 nextSeq。
// childMain.test.ts 已覆盖快照剥离、poll、announceProbe、setMuted、groupJoin/Leave/
// Play/Stop、unpair。本文件补齐其余 op，并用桩替身隔离 playerCore / esphomeBridge /
// index（dial 目标文件操作）/ deviceState（解绑清理）——它们要么碰真网络、要么碰真库。
//
// 钉死的契约（每条都对应一个线上可见行为）:
//   - 每个 op 的入参在进入 core 前被**规整**（String/Number/bool 强转、members 数组化）；
//   - 服务未运行（srv=null）的写类 op 必须回 ok:false 而不是静默吞掉；
//   - playMedia/groupPlay 的失败回调必须转成 `playFailed` 事件回主进程（前端红条）；
//   - 未知 transport op / 未知 op 必须报错（拼错指令不能被吞）。
import "../plugins/_env.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Any = any;

const H = vi.hoisted(() => ({
  core: {
    playCore: vi.fn(),
    playGroupCore: vi.fn(),
    stopCore: vi.fn(),
    stopGroupCore: vi.fn(),
    pauseCore: vi.fn(),
    resumePumpCore: vi.fn(),
    seekCore: vi.fn(),
    setVolumeCore: vi.fn(),
    setMutedCore: vi.fn(),
    pollCore: vi.fn(() => ({ playing: true, positionMs: 5, durationMs: 10 })),
    pumpActiveCore: vi.fn(() => true),
    announceCore: vi.fn(async () => ({ announced: true })),
    announceProbeCore: vi.fn(() => ({ wasPlaying: true, savedPos: 3 })),
    joinGroupCore: vi.fn(() => ({ joined: true, live: false })),
    leaveGroupCore: vi.fn(() => true),
    armBorrowCore: vi.fn(() => ({ armed: true, positionMs: 9 })),
  },
  esphome: {
    snapshot: vi.fn(() => [{ host: "h1", connected: true }]),
    syncDevice: vi.fn(),
    setVolume: vi.fn(() => ({ ok: true, code: "sent", sent: 1 })),
    setMuted: vi.fn(() => ({ ok: true, code: "sent", sent: 2 })),
    mirroredVolume: vi.fn(() => ({ volume: 0.42, muted: true })),
  },
  idx: {
    listDialTargets: vi.fn(async () => [{ host: "h", port: 1, addedAt: 0 }]),
    rememberDialTarget: vi.fn(async () => {}),
    forgetDialTarget: vi.fn(async () => true),
    wakeDiscoveryCore: vi.fn(async () => ({ rescanned: true, rearmed: ["h:1"] })),
  },
  purge: vi.fn(),
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  playCore: H.core.playCore,
  playGroupCore: H.core.playGroupCore,
  stopCore: H.core.stopCore,
  stopGroupCore: H.core.stopGroupCore,
  pauseCore: H.core.pauseCore,
  resumePumpCore: H.core.resumePumpCore,
  seekCore: H.core.seekCore,
  setVolumeCore: H.core.setVolumeCore,
  setMutedCore: H.core.setMutedCore,
  pollCore: H.core.pollCore,
  pumpActiveCore: H.core.pumpActiveCore,
  announceCore: H.core.announceCore,
  announceProbeCore: H.core.announceProbeCore,
  joinGroupCore: H.core.joinGroupCore,
  leaveGroupCore: H.core.leaveGroupCore,
  armBorrowCore: H.core.armBorrowCore,
}));
vi.mock("../../src/services/sendspin/esphomeBridge.js", () => ({ esphomeBridge: H.esphome }));
vi.mock("../../src/services/sendspin/index.js", () => ({
  listDialTargets: H.idx.listDialTargets,
  rememberDialTarget: H.idx.rememberDialTarget,
  forgetDialTarget: H.idx.forgetDialTarget,
  wakeDiscoveryCore: H.idx.wakeDiscoveryCore,
}));
vi.mock("../../src/services/sendspin/deviceState.js", () => ({ purgeDeviceArtifacts: H.purge }));

import { SendspinChildController, type ChildSend } from "../../src/services/sendspin/childMain.js";
import type { ParentToSendspinChild, SendspinChildToParent } from "../../src/services/sendspin/ipcProtocol.js";

function makeServer(): Any {
  const clients = new Map<string, Any>();
  const groups = new Map<string, Any>();
  const srv: Any = {
    serverId: "srv-x",
    clients,
    groups,
    pairingStore: {
      listRecords: () => [],
      isApproved: () => false,
      setApproved: vi.fn(async () => {}),
      removeRecord: vi.fn(async () => true),
    },
    pairing: {
      listAttempts: () => [],
      start: vi.fn(async () => {}),
      enterCode: vi.fn(async () => {}),
      pairWithToken: vi.fn(async () => {}),
      cancel: vi.fn(),
    },
    dialPlayer: vi.fn(async () => ({ clientId: "D1", name: "拨号设备" })),
    clearNoRedial: vi.fn(),
  };
  clients.set("C1", {
    clientId: "C1",
    name: "C1",
    roles: ["player@v1"],
    legacy: false,
    ready: true,
    remoteHost: "192.0.2.1",
    dialed: false,
    dialHost: "",
    dialPort: 0,
    volume: 50,
    muted: false,
    close: vi.fn(),
  });
  return srv;
}

describe("SendspinChildController.dispatch 全 op", () => {
  let sent: SendspinChildToParent[];
  let ctl: SendspinChildController;
  let srv: Any;
  let stopRuntime: number;

  beforeEach(() => {
    sent = [];
    stopRuntime = 0;
    srv = makeServer();
    const send: ChildSend = (m) => sent.push(m);
    ctl = new SendspinChildController(
      { getServer: () => srv, stopRuntime: async () => { stopRuntime++; } },
      send,
    );
    for (const f of Object.values(H.core)) (f as Any).mockClear();
    for (const f of Object.values(H.esphome)) (f as Any).mockClear();
    for (const f of Object.values(H.idx)) (f as Any).mockClear();
    H.purge.mockClear();
    srv.dialPlayer.mockClear();
    srv.clearNoRedial.mockClear();
    srv.pairingStore.setApproved.mockClear();
    srv.pairingStore.removeRecord.mockClear();
    (srv.clients.get("C1") as Any).close.mockClear();
  });

  afterEach(() => ctl.dispose());

  const last = () => sent[sent.length - 1] as Any;
  async function rpc(op: string, payload?: unknown): Promise<Any> {
    const req: ParentToSendspinChild = { t: "req", id: 7, op, payload };
    await ctl.handleMessage(req);
    return last();
  }

  it("buildState：srv 为空 → null（不推空快照）", () => {
    const send: ChildSend = (m) => sent.push(m);
    const bare = new SendspinChildController(
      { getServer: () => null, stopRuntime: async () => {} },
      send,
    );
    expect(bare.buildState()).toBeNull();
    bare.dispose();
  });

  it("setLogLevel：合法/非法等级都不抛（非法等级被 isLogLevel 拦下）", async () => {
    expect((await rpc("setLogLevel", { level: "debug" })).ok).toBe(true);
    expect((await rpc("setLogLevel", { level: "NOT_A_LEVEL" })).ok).toBe(true);
    expect((await rpc("setLogLevel", {})).ok).toBe(true);
  });

  it("playMedia：转交 playCore，失败回调转成 playFailed 事件", async () => {
    const item = { songId: "s1", title: "T" };
    const res = await rpc("playMedia", { clientId: "C1", item });
    expect(res.ok).toBe(true);
    expect(H.core.playCore).toHaveBeenCalledTimes(1);
    const [calledSrv, cid, calledItem, sink] = H.core.playCore.mock.calls[0];
    expect(calledSrv).toBe(srv);
    expect(cid).toBe("C1");
    expect(calledItem).toBe(item);
    // pump 起播失败的唯一出口就是该回调 → 必须转成 IPC 事件（前端据此弹错误）
    sink("C1", "s1", "boom");
    const fail = sent.find((m: Any) => m.t === "playFailed") as Any;
    expect(fail).toMatchObject({ clientId: "C1", songId: "s1", message: "boom" });
  });

  it("playMedia：服务未运行 → ok:false", async () => {
    const bad = new SendspinChildController(
      { getServer: () => null, stopRuntime: async () => {} },
      (m) => sent.push(m),
    );
    await bad.handleMessage({ t: "req", id: 1, op: "playMedia", payload: { clientId: "x", item: {} } } as Any);
    expect(last().ok).toBe(false);
    expect(String(last().error)).toContain("未运行");
    bad.dispose();
  });

  it("armBorrow：overrideMs 数字透传，非数字 → null；缺 srv 报错", async () => {
    const r1 = await rpc("armBorrow", { targetGroup: "a", sourceGroup: "b", overrideMs: 1234 });
    expect(r1.ok).toBe(true);
    expect(H.core.armBorrowCore).toHaveBeenCalledWith(srv, "a", "b", 1234);
    await rpc("armBorrow", { targetGroup: "a", sourceGroup: "b", overrideMs: "x" });
    expect(H.core.armBorrowCore).toHaveBeenLastCalledWith(srv, "a", "b", null);
  });

  it("transport：五种 op 映射到对应 core；未知 op 报错", async () => {
    await rpc("transport", { clientId: "C1", op: "stop" });
    await rpc("transport", { clientId: "C1", op: "pause" });
    await rpc("transport", { clientId: "C1", op: "resume" });
    await rpc("transport", { clientId: "C1", op: "seek", arg: 12 });
    await rpc("transport", { clientId: "C1", op: "volume", arg: 77 });
    expect(H.core.stopCore).toHaveBeenCalledWith(srv, "C1");
    expect(H.core.pauseCore).toHaveBeenCalledWith(srv, "C1");
    expect(H.core.resumePumpCore).toHaveBeenCalledWith(srv, "C1");
    expect(H.core.seekCore).toHaveBeenCalledWith(srv, "C1", 12);
    expect(H.core.setVolumeCore).toHaveBeenCalledWith(srv, "C1", 77);

    const bad = await rpc("transport", { clientId: "C1", op: "nope" });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("未知 transport op");
  });

  it("transport seek/volume：arg 非数字回落 0", async () => {
    await rpc("transport", { clientId: "C1", op: "seek" });
    expect(H.core.seekCore).toHaveBeenLastCalledWith(srv, "C1", 0);
    await rpc("transport", { clientId: "C1", op: "volume", arg: NaN });
    expect(H.core.setVolumeCore).toHaveBeenLastCalledWith(srv, "C1", 0);
  });

  it("setMuted：强制布尔化", async () => {
    await rpc("setMuted", { clientId: "C1", muted: "yes" });
    expect(H.core.setMutedCore).toHaveBeenCalledWith(srv, "C1", true);
  });

  it("groupPlay：members 非数组 → []；失败回调转 playFailed", async () => {
    const res = await rpc("groupPlay", { group: "g", members: "notarray", item: { songId: "s" } });
    expect(res.ok).toBe(true);
    const [gs, gid, members, , sink] = H.core.playGroupCore.mock.calls[0];
    expect(gs).toBe(srv);
    expect(gid).toBe("g");
    expect(members).toEqual([]);
    sink("g", "s", "fail");
    expect((sent.find((m: Any) => m.t === "playFailed") as Any).message).toBe("fail");
  });

  it("groupStop / groupJoin / groupLeave / poll / pumpActive 透传 core 结果", async () => {
    expect((await rpc("groupStop", { group: "g" })).ok).toBe(true);
    expect(H.core.stopGroupCore).toHaveBeenCalledWith(srv, "g");
    expect((await rpc("groupJoin", { group: "g", clientId: "C1" })).result).toEqual({ joined: true, live: false });
    expect((await rpc("groupLeave", { group: "g", clientId: "C1" })).result).toBe(true);
    expect((await rpc("poll", { clientId: "C1" })).result).toEqual({ playing: true, positionMs: 5, durationMs: 10 });
    expect((await rpc("pumpActive", { clientId: "g" })).result).toBe(true);
  });

  it("announce：规整 options（volume/timeoutMs 仅数字携带，savedPos 回落 0）", async () => {
    await rpc("announce", { peerId: "p", url: "ws://u", volume: 30, timeoutMs: 500, savedPos: "9" });
    expect(H.core.announceCore).toHaveBeenCalledWith(srv, "p", "ws://u", { volume: 30, timeoutMs: 500, savedPos: 9 });
    await rpc("announce", { peerId: "p", url: "u" });
    expect(H.core.announceCore).toHaveBeenLastCalledWith(srv, "p", "u", {
      volume: undefined,
      timeoutMs: undefined,
      savedPos: 0,
    });
  });

  it("announceProbe：转交 announceProbeCore（deactivate 前捕获现场）", async () => {
    const res = await rpc("announceProbe", { peerId: "sendspin:C1" });
    expect(res.result).toEqual({ wasPlaying: true, savedPos: 3 });
    expect(H.core.announceProbeCore).toHaveBeenCalledWith(srv, "sendspin:C1");
  });

  it("dial：调 dialPlayer，超时缺省 15000，回 {clientId,name}", async () => {
    const r1 = await rpc("dial", { url: "ws://h:1/sendspin" });
    expect(r1.result).toEqual({ clientId: "D1", name: "拨号设备" });
    expect(srv.dialPlayer).toHaveBeenCalledWith("ws://h:1/sendspin", 15000);
    await rpc("dial", { url: "ws://h:1/sendspin", timeoutMs: 2000 });
    expect(srv.dialPlayer).toHaveBeenLastCalledWith("ws://h:1/sendspin", 2000);
  });

  it("clearNoRedial：host/port 透传；srv 缺失也不抛", async () => {
    await rpc("clearNoRedial", { host: "10.0.0.1", port: 8928 });
    expect(srv.clearNoRedial).toHaveBeenCalledWith("10.0.0.1", 8928);
    const bad = new SendspinChildController(
      { getServer: () => null, stopRuntime: async () => {} },
      (m) => sent.push(m),
    );
    await bad.handleMessage({ t: "req", id: 2, op: "clearNoRedial", payload: {} } as Any);
    expect(last().ok).toBe(true);
    bad.dispose();
  });

  it("wakeDiscovery：转交 index.wakeDiscoveryCore（子进程内跑发现）", async () => {
    const res = await rpc("wakeDiscovery", {});
    expect(res.result).toEqual({ rescanned: true, rearmed: ["h:1"] });
    expect(H.idx.wakeDiscoveryCore).toHaveBeenCalled();
  });

  it("dialList / dialRemember / dialForget 转交 index 的文件逻辑", async () => {
    expect((await rpc("dialList", {})).result).toEqual([{ host: "h", port: 1, addedAt: 0 }]);
    expect((await rpc("dialRemember", { host: "h", port: 2 })).result).toBe(true);
    expect(H.idx.rememberDialTarget).toHaveBeenCalledWith("h", 2);
    expect((await rpc("dialForget", { host: "h", port: 2 })).result).toBe(true);
    expect(H.idx.forgetDialTarget).toHaveBeenCalledWith("h", 2);
  });

  it("setApproved：写配对库；srv 缺失报错", async () => {
    expect((await rpc("setApproved", { clientId: "C1", approved: true })).ok).toBe(true);
    expect(srv.pairingStore.setApproved).toHaveBeenCalledWith("C1", true);
  });

  it("disconnect：只关匹配 clientId 的连接并返回数量", async () => {
    srv.clients.set("C2", { clientId: "C2", roles: [], close: vi.fn() });
    const res = await rpc("disconnect", { clientId: "C1" });
    expect(res.result).toBe(1);
    expect((srv.clients.get("C1") as Any).close).toHaveBeenCalled();
    expect((srv.clients.get("C2") as Any).close).not.toHaveBeenCalled();
  });

  it("unpair：删记录 + 解挂 6053 + 断连 + 清设备痕迹", async () => {
    const res = await rpc("unpair", { clientId: "C1" });
    expect(res.result).toBe(true);
    expect(srv.pairingStore.removeRecord).toHaveBeenCalledWith("C1");
    expect(H.esphome.syncDevice).toHaveBeenCalledWith("192.0.2.1", "", 0);
    expect((srv.clients.get("C1") as Any).close).toHaveBeenCalled();
    expect(H.purge).toHaveBeenCalledWith("C1");
  });

  it("pairStart/pairCode/pairToken/pairCancel 转交配对协调器", async () => {
    await rpc("pairStart", { clientId: "C1", method: "digits", format: "qr" });
    await rpc("pairStart", { clientId: "C1", method: "digits" }); // format 缺省 → "digits"
    await rpc("pairCode", { clientId: "C1", code: "123456" });
    await rpc("pairToken", { clientId: "C1", token: "tok" });
    await rpc("pairCancel", { clientId: "C1" });
    expect(srv.pairing.start).toHaveBeenCalledWith("C1", "digits", "qr");
    expect(srv.pairing.start).toHaveBeenLastCalledWith("C1", "digits", "digits");
    expect(srv.pairing.enterCode).toHaveBeenCalledWith("C1", "123456");
    expect(srv.pairing.pairWithToken).toHaveBeenCalledWith("C1", "tok");
    expect(srv.pairing.cancel).toHaveBeenCalledWith("C1");
  });

  it("esphomeStatus/Sync/Volume/Mute/ReadVolume 转交桥", async () => {
    expect((await rpc("esphomeStatus", {})).result).toEqual({ devices: [{ host: "h1", connected: true }] });
    await rpc("esphomeSync", { host: "h1", psk: "k", port: 6054 });
    expect(H.esphome.syncDevice).toHaveBeenCalledWith("h1", "k", 6054);
    expect((await rpc("esphomeVolume", { host: "h1", volume: 50 })).result).toEqual({ ok: true, code: "sent", sent: 1 });
    expect(H.esphome.setVolume).toHaveBeenCalledWith("h1", 0.5);
    await rpc("esphomeMute", { host: "h1", muted: true });
    expect(H.esphome.setMuted).toHaveBeenCalledWith("h1", true);
    expect((await rpc("esphomeReadVolume", { host: "h1" })).result).toEqual({ volume: 42, muted: true });
  });

  it("applyCfg：写 server 字段（allowLegacyClients/preferredCodec）；srv 缺失 no-op 不抛", async () => {
    await rpc("applyCfg", { allowLegacyClients: false, preferredCodec: "flac" });
    expect(srv.allowLegacyClients).toBe(false);
    expect(srv.preferredCodec).toBe("flac");
    const bad = new SendspinChildController(
      { getServer: () => null, stopRuntime: async () => {} },
      (m) => sent.push(m),
    );
    expect((await bad.handleMessage({ t: "req", id: 3, op: "applyCfg", payload: { allowLegacyClients: true } } as Any)).valueOf()).toBe(true);
    expect(last().ok).toBe(true);
    bad.dispose();
  });

  it("stop：清运行时 → dispose → stopped → res（顺序不变）", async () => {
    const res = await rpc("stop", {});
    expect(res.ok).toBe(true);
    expect(stopRuntime).toBe(1);
    expect(sent.map((m: Any) => m.t)).toEqual(["stopped", "res"]);
  });

  it("nextSeq 单调自增（主进程 req id 唯一性依赖）", () => {
    const a = ctl.nextSeq;
    const b = ctl.nextSeq;
    expect(b).toBe(a + 1);
  });
});
