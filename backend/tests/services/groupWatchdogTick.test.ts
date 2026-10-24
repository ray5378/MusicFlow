// 覆盖率长尾补充:services/group/watchdog.ts 的 runGroupWatchdogTick 主体(44-119)。
// 这是「全组离线 → 保留队列悬挂 → 成员回归自动续播」的核心状态机,依赖 DLNA / sendspin
// / 队列控制器,全部用替身锁死;只验证状态迁移与副作用,不发真网络请求。
// 状态(lastPosition / suspended)是模块级 Map,故每个用例都从 resetGroupWatchdogForTest()
// 起步,再用「多次 tick」在同一用例内构造迁移,避免依赖用例执行顺序。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  groups: [] as any[],
  snapshot: { isActive: true, currentIndex: 0 } as any,
  resetTracker: vi.fn(),
  resumeActive: vi.fn(async () => {}),
  deviceStatus: vi.fn(async () => ({})),
  onlineMembers: vi.fn(() => [] as string[]),
  onlineSpin: vi.fn(() => [] as string[]),
  groupStatus: vi.fn(async () => ({ state: "STOPPED", position: 1 } as any)),
  align: vi.fn(async () => {}),
  spinJoin: vi.fn(async () => {}),
  spinTransport: vi.fn(async () => {}),
  spinName: vi.fn((id: string) => `spin:${id}`),
  baseUrl: vi.fn(() => "http://base/"),
  volume: vi.fn(() => 37),
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    list: () => H.groups,
    getVolume: (_id: string) => H.volume(),
  }),
  // 与真实实现同形:仅解析 "dlna:<id>" / "sendspin:<id>" 这类成员 id。
  splitMemberId: (m: string) => {
    const i = m.indexOf(":");
    if (i <= 0) return null;
    return { kind: m.slice(0, i), id: m.slice(i + 1) };
  },
}));

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  getOnlineMemberIds: (_id: string) => H.onlineMembers(),
  getOnlineSendspinIds: (_id: string) => H.onlineSpin(),
  getGroupStatus: (_id: string) => H.groupStatus(),
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  sendspinGroupJoin: (name: string, cid: string) => H.spinJoin(name, cid),
  sendspinGroupTransport: (...args: unknown[]) => H.spinTransport(...args),
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (id: string) => H.spinName(id),
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({
    snapshot: (_id: string) => H.snapshot,
    resetGroupTracker: (id: string) => H.resetTracker(id),
    resumeActive: (id: string, base: string) => H.resumeActive(id, base),
  }),
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getEffectiveBaseUrl: () => H.baseUrl(),
  alignDeviceToPosition: (d: string, pos: number) => H.align(d, pos),
  getDeviceStatus: (id: string) => H.deviceStatus(id),
}));

import { runGroupWatchdogTick, resetGroupWatchdogForTest } from "../../src/services/group/watchdog.js";

const G = (id: string, memberIds: string[] = []) => ({ id, name: `name-${id}`, memberIds });

beforeEach(() => {
  resetGroupWatchdogForTest();
  H.groups = [];
  H.snapshot = { isActive: true, currentIndex: 0 };
  H.resetTracker.mockClear();
  H.resumeActive.mockClear();
  H.deviceStatus.mockClear().mockResolvedValue({});
  H.onlineMembers.mockReset().mockReturnValue([]);
  H.onlineSpin.mockReset().mockReturnValue([]);
  H.groupStatus.mockReset().mockResolvedValue({ state: "STOPPED", position: 1 });
  H.align.mockClear().mockResolvedValue(undefined);
  H.spinJoin.mockClear();
  H.spinTransport.mockClear();
  H.volume.mockReturnValue(37);
});

describe("runGroupWatchdogTick:队列未激活", () => {
  it("isActive=false / currentIndex=-1 → 清悬挂状态、不触发任何恢复(54-59)", async () => {
    H.groups = [G("g-inactive")];
    H.snapshot = { isActive: false, currentIndex: -1 };

    await runGroupWatchdogTick();

    // 未激活队列没有续播语义:不得重置 tracker、不得续播、也不探活设备。
    expect(H.resetTracker).not.toHaveBeenCalled();
    expect(H.resumeActive).not.toHaveBeenCalled();
    expect(H.deviceStatus).not.toHaveBeenCalled();
  });
});

describe("runGroupWatchdogTick:全员离线 → 悬挂", () => {
  it("DLNA 成员全离线 → 探活 + resetGroupTracker,且只在离线跃变时触发一次(64-79)", async () => {
    H.groups = [G("g1", ["dlna:d1", "sendspin:s1", "weird"])];
    H.onlineMembers.mockReturnValue([]);
    H.onlineSpin.mockReturnValue([]);

    await runGroupWatchdogTick();

    // 只对 dlna 成员探活(sendspin 走 front ready 判定、非法 id 跳过)。
    expect(H.deviceStatus).toHaveBeenCalledTimes(1);
    expect(H.deviceStatus).toHaveBeenCalledWith("d1");
    // 进入悬挂瞬间清 tracker.lastPlaying,避免回归时被误判 ended 而解散队列。
    expect(H.resetTracker).toHaveBeenCalledTimes(1);
    expect(H.resetTracker).toHaveBeenCalledWith("g1");
    expect(H.resumeActive).not.toHaveBeenCalled();

    // 已在悬挂态:第二次巡检不得重复 reset(否则每 10s 打断一次 tracker)。
    await runGroupWatchdogTick();
    expect(H.resetTracker).toHaveBeenCalledTimes(1);
  });
});

describe("runGroupWatchdogTick:成员回归恢复", () => {
  it("回归时设备已在播 → 跳过自动续播(82-92)", async () => {
    H.groups = [G("g2", ["dlna:d2"])];
    H.onlineMembers.mockReturnValue([]);
    await runGroupWatchdogTick(); // 先进入悬挂
    expect(H.resetTracker).toHaveBeenCalledTimes(1);

    // 成员回归,但用户已手动恢复播放。
    H.onlineMembers.mockReturnValue(["d2"]);
    H.groupStatus.mockResolvedValue({ state: "PLAYING", position: 3 });
    await runGroupWatchdogTick();

    // state=PLAYING ⇒ 不重复 cast(否则双重播放)。
    expect(H.resumeActive).not.toHaveBeenCalled();
    expect(H.align).not.toHaveBeenCalled();
  });

  it("回归且未在播 → resumeActive + 按最后位置校准 + sendspin 重新入组(84-110)", async () => {
    H.groups = [G("g3", ["dlna:d3"])];
    // 1) 正常播放:记录 leader 进度到 lastPosition(114-116)。
    H.onlineMembers.mockReturnValue(["d3"]);
    H.groupStatus.mockResolvedValue({ state: "PLAYING", position: 42.5 });
    await runGroupWatchdogTick();
    // 2) 全员离线 → 悬挂(lastPosition 保留)。
    H.onlineMembers.mockReturnValue([]);
    await runGroupWatchdogTick();
    // 3) 成员回归、设备并未在播 → 走续播。
    H.onlineMembers.mockReturnValue(["d3"]);
    H.onlineSpin.mockReturnValue(["c1"]);
    H.groupStatus.mockResolvedValue({ state: "STOPPED", position: 0 });
    await runGroupWatchdogTick();

    expect(H.resumeActive).toHaveBeenCalledTimes(1);
    expect(H.resumeActive).toHaveBeenCalledWith("g3", "http://base/");
    // resumePos>0 ⇒ 对每个在线成员做校准 seek。
    expect(H.align).toHaveBeenCalledTimes(1);
    expect(H.align).toHaveBeenCalledWith("d3", 42.5);
    // 回归的 sendspin 成员:先灌持久音量再入组。
    expect(H.spinTransport).toHaveBeenCalledTimes(1);
    expect(H.spinTransport).toHaveBeenCalledWith("spin:g3", "volume", 37);
    expect(H.spinJoin).toHaveBeenCalledTimes(1);
    expect(H.spinJoin).toHaveBeenCalledWith("spin:g3", "c1");
  });

  it("回归但无最后位置(resumePos=0)→ 续播但不校准 seek(95 假分支)", async () => {
    H.groups = [G("g4", ["dlna:d4"])];
    H.onlineMembers.mockReturnValue([]);
    await runGroupWatchdogTick(); // 从未记录进度就悬挂
    H.onlineMembers.mockReturnValue(["d4"]);
    await runGroupWatchdogTick();

    expect(H.resumeActive).toHaveBeenCalledTimes(1);
    // 没有已知位置 ⇒ 不做校准 seek。
    expect(H.align).not.toHaveBeenCalled();
  });
});

describe("runGroupWatchdogTick:残留状态与异常收口", () => {
  it("组被删除 → 清掉悬挂残留(49-50),同名组重建不会被误当回归", async () => {
    H.groups = [G("g5", ["dlna:d5"])];
    H.onlineMembers.mockReturnValue([]);
    await runGroupWatchdogTick(); // g5 进入悬挂
    expect(H.resetTracker).toHaveBeenCalledTimes(1);

    // 组从列表消失 → 巡检清 lastPosition/suspended。
    H.groups = [];
    await runGroupWatchdogTick();

    // 重建同名组、成员在线:因悬挂状态已被清,不得走"回归续播"。
    H.groups = [G("g5", ["dlna:d5"])];
    H.onlineMembers.mockReturnValue(["d5"]);
    H.resumeActive.mockClear();
    await runGroupWatchdogTick();
    expect(H.resumeActive).not.toHaveBeenCalled();
  });

  it("探活/状态查询抛错 → 整轮巡检不冒泡(67 / 88 / 117 catch)", async () => {
    H.groups = [G("g6", ["dlna:d6"])];
    H.deviceStatus.mockRejectedValue(new Error("soap down"));
    H.onlineMembers.mockReturnValue([]);
    H.groupStatus.mockRejectedValue(new Error("status down"));
    // 全离线且探活失败:67 的 catch 吞掉,整轮仍 resolve。
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
    expect(H.resetTracker).toHaveBeenCalledWith("g6");

    // 成员回归 + getGroupStatus 抛错:88 的 catch 吞掉 ⇒ state 视为未知 ⇒ 照常续播。
    H.onlineMembers.mockReturnValue(["d6"]);
    H.resumeActive.mockClear();
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
    expect(H.resumeActive).toHaveBeenCalledTimes(1);

    // 正常态下 getGroupStatus 抛错也必须被吞(117),位置不更新、不冒泡。
    H.groups = [G("g7", ["dlna:d7"])];
    H.onlineMembers.mockReturnValue(["d7"]);
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
  });
});
