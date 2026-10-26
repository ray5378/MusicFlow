// group/watchdog.ts 定向单测:巡检定时器 + 全员离线悬挂 + 成员回归恢复路径。
//
// 基线 85.71% 行但**函数覆盖只有 50%**(startGroupWatchdog/stopGroupWatchdog 完全没跑),
// 且成员回归分支里 sendspin 重新入组(灌持久音量 + join)与「已在播则跳过」两条
// 早退分支没有断言。这里补的是:
//   ① 定时器幂等启停(重复 start 不能挂两个 interval —— 会让巡检频率翻倍);
//   ② 悬挂只在「离线 → 上线」跳变时触发一次恢复,恢复走 resumeActive 统一起播路径;
//   ③ 恢复后按最后已知位置对每个在线 DLNA 成员做校准 seek(cast 让成员从头播)。
// 全部 mock:队列控制器 / 在线判定 / 设备状态都不碰真实设备与 DB。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const groups = new Map<string, { id: string; name: string; memberIds: string[] }>();
  const state = {
    active: true,
    currentIndex: 0,
    onlineDlna: [] as string[],
    onlineSpin: [] as string[],
    position: 30 as number | undefined,
    groupState: "STOPPED",
    statusThrows: false,
    deviceStatusThrows: false,
  };
  const calls = {
    resetTracker: [] as string[],
    resumeActive: [] as Array<[string, string]>,
    align: [] as Array<[string, number]>,
    deviceStatus: [] as string[],
    spinTransport: [] as Array<[string, string, number]>,
    spinJoin: [] as Array<[string, string]>,
    snapshot: [] as string[],
  };
  const gm = {
    get: (id: string) => groups.get(id),
    list: () => Array.from(groups.values()),
    getVolume: () => 20,
  };
  const qc = {
    snapshot: (id: string) => {
      calls.snapshot.push(id);
      return { isActive: state.active, currentIndex: state.currentIndex };
    },
    resetGroupTracker: (id: string) => { calls.resetTracker.push(id); },
    resumeActive: async (id: string, baseUrl: string) => { calls.resumeActive.push([id, baseUrl]); },
  };
  return { groups, state, calls, gm, qc };
});

vi.mock("../../src/services/group/index.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { getGroupManager: () => h.gm, splitMemberId: actual.splitMemberId };
});

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  getOnlineMemberIds: () => h.state.onlineDlna,
  getOnlineSendspinIds: () => h.state.onlineSpin,
  getGroupStatus: async () => {
    if (h.state.statusThrows) throw new Error("status boom");
    return { state: h.state.groupState, position: h.state.position };
  },
}));

vi.mock("../../src/services/sendspin/index.js", () => ({
  sendspinGroupJoin: async (gname: string, clientId: string) => { h.calls.spinJoin.push([gname, clientId]); return true; },
  sendspinGroupTransport: async (gname: string, kind: string, value: any) => {
    h.calls.spinTransport.push([gname, kind, value]);
    return true;
  },
}));

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => h.qc,
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getEffectiveBaseUrl: () => "http://base",
  alignDeviceToPosition: async (deviceId: string, targetSec: number) => {
    h.calls.align.push([deviceId, targetSec]);
    return targetSec;
  },
  getDeviceStatus: async (deviceId: string) => {
    h.calls.deviceStatus.push(deviceId);
    if (h.state.deviceStatusThrows) throw new Error("soap boom");
    return { state: "PLAYING", position: 30, duration: 100, volume: 0, muted: false };
  },
}));

import {
  runGroupWatchdogTick,
  resetGroupWatchdogForTest,
  startGroupWatchdog,
  stopGroupWatchdog,
} from "../../src/services/group/watchdog.js";

function setGroup(memberIds: string[], id = "g1"): void {
  h.groups.set(id, { id, name: "组", memberIds });
}

beforeEach(() => {
  h.groups.clear();
  h.state.active = true;
  h.state.currentIndex = 0;
  h.state.onlineDlna = [];
  h.state.onlineSpin = [];
  h.state.position = 30;
  h.state.groupState = "STOPPED";
  h.state.statusThrows = false;
  h.state.deviceStatusThrows = false;
  for (const v of Object.values(h.calls)) (v as any[]).length = 0;
  resetGroupWatchdogForTest();
  stopGroupWatchdog();
  vi.clearAllMocks();
});

afterEach(() => {
  stopGroupWatchdog();
  resetGroupWatchdogForTest();
  vi.useRealTimers();
});

describe("巡检定时器", () => {
  it("start 幂等:重复 start 只挂一个 interval(否则巡检频率翻倍)", async () => {
    vi.useFakeTimers();
    setGroup(["d1"]);
    startGroupWatchdog();
    startGroupWatchdog();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls.snapshot).toHaveLength(3); // 10s/tick × 3
  });

  it("stop 后不再巡检;未启动时 stop 不抛(服务关停路径幂等)", async () => {
    vi.useFakeTimers();
    setGroup(["d1"]);
    startGroupWatchdog();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls.snapshot).toHaveLength(1);
    stopGroupWatchdog();
    stopGroupWatchdog();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls.snapshot).toHaveLength(1);
  });

  it("巡检时对每个 DLNA 成员做一次轻量状态查询(非 leader 成员离线才能被发现)", async () => {
    setGroup(["d1", "airplay:a1", "sendspin:sp1"]);
    await runGroupWatchdogTick();
    expect(h.calls.deviceStatus).toEqual(["d1"]); // 只探 DLNA,不探 airplay/sendspin
  });

  it("成员状态查询抛错被吞(单台不可达不影响整轮巡检)", async () => {
    setGroup(["d1"]);
    h.state.deviceStatusThrows = true;
    h.state.onlineDlna = ["d1"];
    await expect(runGroupWatchdogTick()).resolves.toBeUndefined();
    expect(h.calls.deviceStatus).toEqual(["d1"]);
  });
});

describe("悬挂(全员离线)", () => {
  it("队列未激活 → 不悬挂(没有续播语义),也不清 tracker", async () => {
    setGroup(["d1"]);
    h.state.active = false;
    await runGroupWatchdogTick();
    expect(h.calls.resetTracker).toEqual([]);
    // 之后成员上线也不应触发恢复
    h.state.onlineDlna = ["d1"];
    await runGroupWatchdogTick();
    expect(h.calls.resumeActive).toEqual([]);
  });

  it("currentIndex < 0(已停止/清空)→ 同样不悬挂", async () => {
    setGroup(["d1"]);
    h.state.currentIndex = -1;
    await runGroupWatchdogTick();
    expect(h.calls.resetTracker).toEqual([]);
  });

  it("全员离线 → 悬挂一次(清 leader lastPlaying),重复 tick 不重复悬挂", async () => {
    setGroup(["d1", "sendspin:sp1"]);
    await runGroupWatchdogTick();
    await runGroupWatchdogTick();
    await runGroupWatchdogTick();
    expect(h.calls.resetTracker).toEqual(["g1"]);
    expect(h.calls.resumeActive).toEqual([]);
  });
});

describe("成员回归(恢复走统一起播路径)", () => {
  it("回归 → resumeActive + 按最后已知位置校准每个在线 DLNA 成员", async () => {
    setGroup(["d1", "d2"]);
    h.state.onlineDlna = ["d1"]; // 在线:记录 leader 进度 30
    await runGroupWatchdogTick();

    h.state.onlineDlna = []; // 全员离线 → 悬挂
    await runGroupWatchdogTick();

    h.state.onlineDlna = ["d1", "d2"]; // 回归
    await runGroupWatchdogTick();

    expect(h.calls.resumeActive).toEqual([["g1", "http://base"]]);
    expect(h.calls.align).toEqual([["d1", 30], ["d2", 30]]);
  });

  it("设备已自行恢复(PLAYING)→ 跳过自动恢复(不双重 cast)", async () => {
    setGroup(["d1"]);
    h.state.onlineDlna = ["d1"];
    await runGroupWatchdogTick();
    h.state.onlineDlna = [];
    await runGroupWatchdogTick(); // 悬挂

    h.state.onlineDlna = ["d1"];
    h.state.groupState = "PLAYING";
    await runGroupWatchdogTick();
    expect(h.calls.resumeActive).toEqual([]);
  });

  it("暂停中回归(PAUSED_PLAYBACK)同样跳过自动恢复", async () => {
    setGroup(["d1"]);
    h.state.onlineDlna = ["d1"];
    await runGroupWatchdogTick();
    h.state.onlineDlna = [];
    await runGroupWatchdogTick();

    h.state.onlineDlna = ["d1"];
    h.state.groupState = "PAUSED_PLAYBACK";
    await runGroupWatchdogTick();
    expect(h.calls.resumeActive).toEqual([]);
  });

  it("状态查询抛错时仍续播(不因读不到状态而永久悬挂)", async () => {
    setGroup(["d1"]);
    h.state.onlineDlna = ["d1"];
    await runGroupWatchdogTick();
    h.state.onlineDlna = [];
    await runGroupWatchdogTick(); // 悬挂

    h.state.onlineDlna = ["d1"];
    h.state.statusThrows = true; // 回归轮读状态失败
    await runGroupWatchdogTick();
    expect(h.calls.resumeActive).toEqual([["g1", "http://base"]]);
  });

  it("没有记录到最后位置(从未在播)→ 只 resumeActive,不做校准 seek", async () => {
    setGroup(["d1"]);
    h.state.position = undefined;
    h.state.onlineDlna = [];
    await runGroupWatchdogTick(); // 直接全员离线 → 悬挂(无 lastPosition)
    h.state.onlineDlna = ["d1"];
    await runGroupWatchdogTick();
    expect(h.calls.resumeActive).toEqual([["g1", "http://base"]]);
    expect(h.calls.align).toEqual([]);
  });

  it("回归的 sendspin 成员:先灌持久组音量再入组(ug 懒创建缺省 100 的坑)", async () => {
    setGroup(["d1", "sendspin:sp1"]);
    await runGroupWatchdogTick(); // 全员离线 → 悬挂
    h.state.onlineDlna = ["d1"];
    h.state.onlineSpin = ["sp1"];
    await runGroupWatchdogTick();

    expect(h.calls.spinTransport).toEqual([["ug:g1", "volume", 20]]);
    expect(h.calls.spinJoin).toEqual([["ug:g1", "sp1"]]);
  });
});

describe("组删除后的残留状态", () => {
  it("组被删除 → 残留悬挂/位置状态被清理,不误恢复", async () => {
    setGroup(["d1"]);
    h.state.onlineDlna = ["d1"];
    await runGroupWatchdogTick(); // 记录位置 30
    h.state.onlineDlna = [];
    await runGroupWatchdogTick(); // 悬挂

    h.groups.clear(); // 组删除
    await runGroupWatchdogTick();
    expect(h.calls.resumeActive).toEqual([]);

    // 同名 id 重新建组(仍在播)时不应带着旧位置立刻触发恢复
    setGroup(["d1"]);
    h.state.onlineDlna = ["d1"];
    await runGroupWatchdogTick();
    expect(h.calls.resumeActive).toEqual([]);
  });
});
