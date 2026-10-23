// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// `routes/api/shared.ts` 里「流转/组对齐」三处运行时的残余未覆盖分支补测:
//   tryArmSendspinBorrow  557-561(reason 回执 + armed 回执)/ 566-568(武装异常吞掉)
//   detachFromActiveGroups 593-599(显式操控→自动脱离组:成功 + 失败)
//   alignGroupMembers     airplay 加入对齐失败 / airplay 摘除单设备收口 /
//                         sendspin 加入失败 / sendspin 摘除失败
//
// 为什么用叶子 mock 而不是打 HTTP:这三段的调用方是"设备/服务层",真实触发需要两台
// sendspin 设备 + AirPlay 设备同时在线。这里锁的是**失败语义**:借流没成必须退回常规对齐、
// 单个成员对齐失败必须被吞掉且不影响其余成员 —— 这些正是零覆盖的 catch 分支。
//
// 手法参照 sharedHelpers.test.ts:**以真实模块为底,只换叶子**;gm / 队列控制器单例
// 换成受控假体,断言打在"对外可见的副作用"上(调用参数),而不是内部实现。
import { beforeEach, describe, expect, it, vi } from "vitest";

type Any = any;

const leaf = vi.hoisted(() => ({
  sendspinArmBorrow: vi.fn(),
  sendspinGroupNameForPeer: vi.fn(),
  sendspinGroupJoin: vi.fn(),
  sendspinGroupLeave: vi.fn(),
  sendspinGroupTransport: vi.fn(),
  gmGet: vi.fn(),
  gmApplyMemberDelta: vi.fn(),
  gmGetVolume: vi.fn(),
  activeGroupOfDevice: vi.fn(),
  rejoinMembers: vi.fn(),
  stopAirPlayMemberBridge: vi.fn(),
}));

vi.mock("../../src/services/sendspin/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  sendspinArmBorrow: leaf.sendspinArmBorrow,
  sendspinGroupNameForPeer: leaf.sendspinGroupNameForPeer,
  sendspinGroupJoin: leaf.sendspinGroupJoin,
  sendspinGroupLeave: leaf.sendspinGroupLeave,
  sendspinGroupTransport: leaf.sendspinGroupTransport,
}));

vi.mock("../../src/services/group/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getGroupManager: () => ({
    get: leaf.gmGet,
    applyMemberDelta: leaf.gmApplyMemberDelta,
    getVolume: leaf.gmGetVolume,
  }),
}));

vi.mock("../../src/services/player/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getQueueController: () => ({
    activeGroupOfDevice: leaf.activeGroupOfDevice,
    rejoinMembers: leaf.rejoinMembers,
  }),
}));

// alignGroupMembers 对 airplay 摘除走动态 import 的单设备拆桥接口:
// 组级拆除只遍历当前成员,被摘掉的设备已不在列表里,漏掉会让 RAOP 会话一直挂着。
vi.mock("../../src/services/group/airplayBridge.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  stopAirPlayMemberBridge: leaf.stopAirPlayMemberBridge,
}));

import {
  tryArmSendspinBorrow,
  detachFromActiveGroups,
  alignGroupMembers,
} from "../../src/routes/api/shared.js";

const MISS = { armed: false, positionSeconds: null, songId: null };

beforeEach(() => {
  for (const f of Object.values(leaf)) (f as Any).mockReset();
  leaf.sendspinGroupJoin.mockResolvedValue(undefined);
  leaf.sendspinGroupLeave.mockResolvedValue(undefined);
  leaf.sendspinGroupTransport.mockResolvedValue(undefined);
  leaf.rejoinMembers.mockResolvedValue(undefined);
  leaf.stopAirPlayMemberBridge.mockResolvedValue(undefined);
  leaf.gmApplyMemberDelta.mockReturnValue(undefined);
  leaf.gmGetVolume.mockReturnValue(100);
});

describe("tryArmSendspinBorrow", () => {
  it("有一端不是 sendspin → 未武装(没有可移交的流对象)", async () => {
    leaf.sendspinGroupNameForPeer.mockReturnValueOnce(null).mockReturnValueOnce("to");
    await expect(tryArmSendspinBorrow("dlna:d1", "sendspin:c1", 5)).resolves.toEqual(MISS);
  });

  it("武装被拒且有 reason → 返回未武装(退回常规对齐),不抛", async () => {
    leaf.sendspinGroupNameForPeer.mockReturnValue("grp");
    leaf.sendspinArmBorrow.mockResolvedValueOnce({ armed: false, reason: "encoder busy" });
    await expect(tryArmSendspinBorrow("sendspin:a", "sendspin:b", 5)).resolves.toEqual(MISS);
  });

  it("武装成功 → 落点 ms 换算成秒、songId 透传", async () => {
    leaf.sendspinGroupNameForPeer.mockImplementation((p: string) => p.slice("sendspin:".length));
    leaf.sendspinArmBorrow.mockResolvedValueOnce({ armed: true, positionMs: 12500, songId: "sg1" });
    await expect(tryArmSendspinBorrow("sendspin:a", "sendspin:b", 5)).resolves.toEqual({
      armed: true, positionSeconds: 12.5, songId: "sg1",
    });
    // 传入的问询位置(秒)要按 ms 交给服务层,单位错位会让落点漂 1000 倍
    expect(leaf.sendspinArmBorrow).toHaveBeenCalledWith("b", "a", 5000);
  });

  it("武装过程抛异常 → 吞掉并返回未武装(借流失败不该让流转失败)", async () => {
    leaf.sendspinGroupNameForPeer.mockReturnValue("grp");
    leaf.sendspinArmBorrow.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(tryArmSendspinBorrow("sendspin:a", "sendspin:b", null)).resolves.toEqual(MISS);
  });
});

describe("detachFromActiveGroups", () => {
  it("设备不属于任何活跃组 → 直接返回(不触碰组状态)", async () => {
    leaf.activeGroupOfDevice.mockReturnValue(undefined);
    await expect(detachFromActiveGroups({ kind: "sendspin", id: "c1" })).resolves.toBeUndefined();
    expect(leaf.gmApplyMemberDelta).not.toHaveBeenCalled();
  });

  it("活跃组里找不到该成员的原样写法 → 直接返回(不误删别人)", async () => {
    leaf.activeGroupOfDevice.mockReturnValue("g-1");
    leaf.gmGet.mockReturnValue({ memberIds: ["dlna:other"] });
    await expect(detachFromActiveGroups({ kind: "sendspin", id: "c1" })).resolves.toBeUndefined();
    expect(leaf.gmApplyMemberDelta).not.toHaveBeenCalled();
  });

  it("命中成员 → 从组里摘除并做对齐(按原样写法删)", async () => {
    leaf.activeGroupOfDevice.mockReturnValue("g-1");
    leaf.gmGet.mockReturnValue({ memberIds: ["sendspin:c1", "sendspin:c2"] });
    await expect(detachFromActiveGroups({ kind: "sendspin", id: "c1" })).resolves.toBeUndefined();
    expect(leaf.gmApplyMemberDelta).toHaveBeenCalledWith("g-1", { remove: ["sendspin:c1"] });
    // 摘除后对 sendspin 成员断流对齐
    expect(leaf.sendspinGroupLeave).toHaveBeenCalledWith("ug:g-1", "c1");
  });

  it("脱离过程中抛错 → 记日志吞掉(不能把用户的播放指令打回)", async () => {
    leaf.activeGroupOfDevice.mockReturnValue("g-1");
    leaf.gmGet.mockReturnValue({ memberIds: ["sendspin:c1"] });
    leaf.gmApplyMemberDelta.mockImplementationOnce(() => { throw new Error("库里没有这个组"); });
    await expect(detachFromActiveGroups({ kind: "sendspin", id: "c1" })).resolves.toBeUndefined();
  });
});

describe("alignGroupMembers", () => {
  // 组成员只有 sendspin / airplay 两类,两者挂在同一条 pump 上:
  //   airplay 新增 → 重建整组时间线(桥接设备列表固化在 HELLO 帧,运行中新增收不到 PCM)
  //   airplay 摘除 → 单独停该设备 RAOP 会话(组级拆除看不到已摘掉的成员)
  it("airplay 成员加入失败 → 吞掉,不影响接口成功", async () => {
    leaf.rejoinMembers.mockRejectedValueOnce(new Error("重建时间线失败"));
    await expect(alignGroupMembers("g-1", ["airplay:dev1"], [])).resolves.toBeUndefined();
    // 裸 id 回传给重建入口(组成员 id 不带命名空间前缀)
    expect(leaf.rejoinMembers).toHaveBeenCalledWith("g-1", ["dev1"]);
  });

  it("airplay 成员加入 → 重建时间线是 fire-and-forget(不等重建完才回接口)", async () => {
    let release: (() => void) | undefined;
    leaf.rejoinMembers.mockImplementationOnce(() => new Promise<void>((res) => { release = res; }));
    // rejoinMembers 挂起时接口仍然返回:重建要等新泵起播,不能把 PUT 卡在那儿。
    await expect(alignGroupMembers("g-1", ["airplay:dev1"], [])).resolves.toBeUndefined();
    expect(leaf.rejoinMembers).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.resolve();
  });

  it("airplay 成员摘除 → 逐设备停 RAOP 会话(不依赖组级拆除)", async () => {
    await expect(alignGroupMembers("g-1", [], ["airplay:dev1", "airplay:dev2"])).resolves.toBeUndefined();
    expect(leaf.stopAirPlayMemberBridge).toHaveBeenCalledWith("dev1", "成员摘除");
    expect(leaf.stopAirPlayMemberBridge).toHaveBeenCalledWith("dev2", "成员摘除");
    expect(leaf.stopAirPlayMemberBridge).toHaveBeenCalledTimes(2);
  });

  it("airplay 成员摘除时拆桥接失败 → 不影响其余成员与接口成功", async () => {
    leaf.stopAirPlayMemberBridge.mockRejectedValueOnce(new Error("RPC 超时"));
    await expect(alignGroupMembers("g-1", [], ["airplay:dev1", "airplay:dev2"])).resolves.toBeUndefined();
  });

  it("解析不出 kind 的脏成员(裸 id / dlna: / group:)被整条跳过", async () => {
    await alignGroupMembers("g-1", ["dev1", "dlna:d2", "group:g9"], ["dlna:d3"]);
    expect(leaf.rejoinMembers).not.toHaveBeenCalled();
    expect(leaf.stopAirPlayMemberBridge).not.toHaveBeenCalled();
    expect(leaf.sendspinGroupJoin).not.toHaveBeenCalled();
  });

  it("sendspin 成员加入:先灌音量再加入;加入失败被吞掉", async () => {
    leaf.sendspinGroupJoin.mockRejectedValueOnce(new Error("未连上"));
    await expect(alignGroupMembers("g-1", ["sendspin:c1"], [])).resolves.toBeUndefined();
    // 入组前把 GroupManager 持久音量灌给 sendspin 组(与起播 playMedia 同源)
    expect(leaf.sendspinGroupTransport).toHaveBeenCalledWith("ug:g-1", "volume", 100);
    expect(leaf.sendspinGroupJoin).toHaveBeenCalledWith("ug:g-1", "c1");
  });

  it("sendspin 成员摘除失败 → 吞掉,其余成员不受影响", async () => {
    leaf.sendspinGroupLeave.mockRejectedValueOnce(new Error("断流超时"));
    await expect(alignGroupMembers("g-1", [], ["sendspin:c2"])).resolves.toBeUndefined();
    expect(leaf.sendspinGroupLeave).toHaveBeenCalledWith("ug:g-1", "c2");
  });

  it("空增删是 no-op(不触碰任何服务层)", async () => {
    await alignGroupMembers("g-1", [], []);
    expect(leaf.rejoinMembers).not.toHaveBeenCalled();
    expect(leaf.stopAirPlayMemberBridge).not.toHaveBeenCalled();
    expect(leaf.sendspinGroupJoin).not.toHaveBeenCalled();
    expect(leaf.sendspinGroupLeave).not.toHaveBeenCalled();
  });
});
