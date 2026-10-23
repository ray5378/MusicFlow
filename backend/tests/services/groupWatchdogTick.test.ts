// 覆盖率长尾补充:services/group/watchdog.ts 的 runGroupWatchdogTick 主体(44-111)。
// 这是「全组离线 → 保留队列悬挂 → 成员回归自动续播」的核心状态机,依赖 airplay 在线
// 判定 / sendspin / 队列控制器,全部用替身锁死;只验证状态迁移与副作用,不发真网络请求。
//
// ★ 2026-10-23 契约变更:群组成员只有 sendspin / airplay 两类,DLNA 禁止入组 ——
//   旧实现「对每个 DLNA 成员发 SOAP GetTransportInfo 探活 + alignDeviceToPosition
//   逐设备校准」的路径已整体删除。在线判定改为纯事件/发现驱动:
//     - sendspin:front clients ready;
//     - airplay:discovery 的 available。
//   因此本文件不再断言任何 SOAP 探活 / 逐设备 align,只验证悬挂与恢复的状态机。
//
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
  onlineAp: vi.fn(() => [] as string[]),
  onlineSpin: vi.fn(() => [] as string[]),
  groupStatus: vi.fn(async () => ({ state: "STOPPED", position: 1 } as any)),
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
  // 与真实实现同形(见 src/services/group/index.ts:32-43):只认 sendspin:/airplay:,
  // dlna:/裸 id/group:/local: 一律 null。
  splitMemberId: (m: any) => {
    if (typeof m !== "string" || !m) return null;
    if (m.startsWith("sendspin:")) {
      const id = m.slice("sendspin:".length);
      return id ? { kind: "sendspin", id } : null;
    }
    if (m.startsWith("airplay:")) {
      const id = m.slice("airplay:".length);
      return id ? { kind: "airplay", id } : null;
    }
    return null;
  },
}));

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  getOnlineAirPlayIds: (_id: string) => H.onlineAp(),
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
}));

import { runGroupWatchdogTick, resetGroupWatchdogForTest } from "../../src/services/group/watchdog.js";

const G = (id: string, memberIds: string[] = []) => ({ id, name: `name-${id}`, memberIds });

beforeEach(() => {
  resetGroupWatchdogForTest();
  H.groups = [];
  H.snapshot = { isActive: true, currentIndex: 0 };
  H.resetTracker.mockClear();
  H.resumeActive.mockClear();
  H.onlineAp.mockReset().mockReturnValue([]);
  H.onlineSpin.mockReset().mockReturnValue([]);
  H.groupStatus.mockReset().mockResolvedValue({ state: "STOPPED", position: 1 });
  H.spinJoin.mockClear();
  H.spinTransport.mockClear();
  H.volume.mockReturnValue(37);
});

describe("runGroupWatchdogTick:队列未激活", () => {
  it("isActive=false / currentIndex=-1 → 清悬挂状态、不触发任何恢复(54-59)", async () => {
    H.groups = [G("g-inactive")];
    H.snapshot = { isActive: false, currentIndex: -1 };

    await runGroupWatchdogTick();

    // 未激活队列没有续播语义:不得重置 tracker、不得续播。
    expect(H.resetTracker).not.toHaveBeenCalled();
    expect(H.resumeActive).not.toHaveBeenCalled();
  });
});

describe("runGroupWatchdogTick:全员离线 → 悬挂", () => {
  it("airplay + sendspin 全离线 → resetGroupTracker,且只在离线跃变时触发一次(64-79)", async () => {
    H.groups = [G("g1", ["airplay:a1", "sendspin:s1", "dlna:legacy", "weird"])];
    H.onlineAp.mockReturnValue([]);
    H.onlineSpin.mockReturnValue([]);

    await runGroupWatchdogTick();

    // 进入悬挂瞬间清 tracker.lastPlaying,避免回归时被误判 ended 而解散队列。
    expect(H.resetTracker).toHaveBeenCalledTimes(1);
    expect(H.resetTracker).toHaveBeenCalledWith("g1");
    expect(H.resumeActive).not.toHaveBeenCalled();

    // 已在悬挂态:第二次巡检不得重复 reset(否则每 10s 打断一次 tracker)。
    await runGroupWatchdogTick();
    expect(H.resetTracker).toHaveBeenCalledTimes(1);
  });

  it("airplay 离线但 sendspin 仍在线 → 不悬挂、不 reset", async () => {
    H.groups = [G("g1b", ["airplay:a1", "sendspin:s1"])];
    H.onlineAp.mockReturnValue([]);
    H.onlineSpin.mockReturnValue(["s1"]);

    await runGroupWatchdogTick();

    expect(H.resetTracker).not.toHaveBeenCalled();
  });
});

describe("runGroupWatchdogTick:成员回归恢复", () => {
  it("回归时组已在播 → 跳过自动续播(82-92)", async () => {
    H.groups = [G("g2", ["airplay:a2"])];
    H.onlineAp.mockReturnValue([]);
    await runGroupWatchdogTick(); // 先进入悬挂
    expect(H.resetTracker).toHaveBeenCalledTimes(1);

    // 成员回归,但用户已手动恢复播放。
    H.onlineAp.mockReturnValue(["a2"]);
    H.groupStatus.mockResolvedValue({ state: "PLAYING", position: 3 });
    await runGroupWatchdogTick();

    // state=PLAYING ⇒ 不重复 cast(否则双重播放)。
    expect(H.resumeActive).not.toHaveBeenCalled();
  });

  it("回归且 PAUSED_PLAYBACK 也算已在播 → 跳过恢复", async () => {
    H.groups = [G("g2b", ["airplay:a2"])];
    H.onlineAp.mockReturnValue([]);
    await runGroupWatchdogTick();
    H.onlineAp.mockReturnValue(["a2"]);
    H.groupStatus.mockResolvedValue({ state: "PAUSED_PLAYBACK", position: 9 });
    await runGroupWatchdogTick();
    expect(H.resumeActive).not.toHaveBeenCalled();
  });

  it("回归且未在播 → resumeActive + sendspin 重新入组(84-110)", async () => {
    H.groups = [G("g3", ["airplay:a3", "sendspin:c1"])];
    // 1) 正常播放:记录 leader 进度到 lastPosition(106-110)。
    H.onlineAp.mockReturnValue(["a3"]);
    H.onlineSpin.mockReturnValue(["c1"]);
    H.groupStatus.mockResolvedValue({ state: "PLAYING", position: 42.5 });
    await runGroupWatchdogTick();
    // 2) 全员离线 → 悬挂(lastPosition 保留)。
    H.onlineAp.mockReturnValue([]);
    H.onlineSpin.mockReturnValue([]);
    await runGroupWatchdogTick();
    // 3) 成员回归、组并未在播 → 走续播。
    H.onlineAp.mockReturnValue(["a3"]);
    H.onlineSpin.mockReturnValue(["c1"]);
    H.groupStatus.mockResolvedValue({ state: "STOPPED", position: 0 });
    await runGroupWatchdogTick();

    expect(H.resumeActive).toHaveBeenCalledTimes(1);
    expect(H.resumeActive).toHaveBeenCalledWith("g3", "http://base/");
    // 回归的 sendspin 成员:先灌持久音量再入组。
    expect(H.spinTransport).toHaveBeenCalledTimes(1);
    expect(H.spinTransport).toHaveBeenCalledWith("spin:g3", "volume", 37);
    expect(H.spinJoin).toHaveBeenCalledTimes(1);
    expect(H.spinJoin).toHaveBeenCalledWith("spin:g3", "c1");
    // DLNA 已禁入组:不得再有逐设备位置校准。
  });

  it("回归但无最后位置(resumePos=0)→ 仍续播(位置由 pump 裁决)", async () => {
    H.groups = [G("g4", ["airplay:a4"])];
    H.onlineAp.mockReturnValue([]);
    await runGroupWatchdogTick(); // 从未记录进度就悬挂
    H.onlineAp.mockReturnValue(["a4"]);
    await runGroupWatchdogTick();

    expect(H.resumeActive).toHaveBeenCalledTimes(1);
  });
});

describe("runGroupWatchdogTick:残留状态与异常收口", () => {
  it("组被删除 → 清掉悬挂残留(49-50),同名组重建不会被误当回归", async () => {
    H.groups = [G("g5", ["airplay:a5"])];
    H.onlineAp.mockReturnValue([]);
    await runGroupWatchdogTick(); // g5 进入悬挂
    expect(H.resetTracker).toHaveBeenCalledTimes(1);

    // 组从列表消失 → 巡检清 lastPosition/suspended。
    H.groups = [];
    await runGroupWatchdogTick();

    // 重建同名组、成员在线:因悬挂状态已被清,不得走"回归续播"。
    H.groups = [G("g5", ["airplay:a5"])];
    H.onlineAp.mockReturnValue(["a5"]);
    H.resumeActive.mockClear();
    await runGroupWatchdogTick();
    expect(H.resumeActive).not.toHaveBeenCalled();
  });

  it("状态查询抛错 → 整轮巡检不冒泡(84 / 110 catch)", async () => {
    H.groups = [G("g6", ["airplay:a6"])];
    H.onlineAp.mockReturnValue([]);
    H.groupStatus.mockRejectedValue(new Error("status down"));
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
    expect(H.resetTracker).toHaveBeenCalledWith("g6");

    // 成员回归 + getGroupStatus 抛错:88 的 catch 吞掉 ⇒ state 视为未知 ⇒ 照常续播。
    H.onlineAp.mockReturnValue(["a6"]);
    H.resumeActive.mockClear();
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
    expect(H.resumeActive).toHaveBeenCalledTimes(1);

    // 正常态下 getGroupStatus 抛错也必须被吞(110),位置不更新、不冒泡。
    H.groups = [G("g7", ["airplay:a7"])];
    H.onlineAp.mockReturnValue(["a7"]);
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
  });
});
