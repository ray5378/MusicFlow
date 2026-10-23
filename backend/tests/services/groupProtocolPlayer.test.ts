// ==================== group/protocolPlayer 行为测试 ====================
// 目标:覆盖 src/services/group/protocolPlayer.ts 的成员分流 / 在线判定 / leader 派生 /
//       组播放(统一 pump 时间线)/ 状态派生。
//
// ★ 2026-10-23 契约变更:群组成员只允许 `sendspin:` / `airplay:` 两种 kind,
//   **DLNA 禁止入组**(无共享时间线,做不了同步);DLNA 的逐成员扇出路径已整体删除,
//   组内音频统一由 `ug:<groupId>` 这一条 pump 产出:
//     - sendspin 成员是 pump 的原生客户端;
//     - airplay 成员是 pump 的旁路 sink(经 airplayBridge 建立 RAOP 桥接会话)。
//
// 手法:整体替换 group/index(getGroupManager + splitMemberId)、airplay/discovery、
//       group/airplayBridge、sendspin 的 index/protocolPlayer/playerCore 与 logger
//       —— 本文件不碰真实 DB / 网络 / 设备。
// splitMemberId 的替身按 src/services/group/index.ts:32-43 的真实语义照抄
// (只认 sendspin:/airplay:;dlna:/裸 id/group:/local: 一律 null)。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const h: any = {
    groups: new Map<string, any>(),
    // airplay 设备表:deviceId → 档案;不在表里 = 设备不存在。
    apDevices: new Map<string, any>(),
    apAvailable: new Set<string>(),
    // 桥接编排调用流水:start/stop/seek/volume。
    bridgeCalls: [] as Array<{ fn: string; args: any[] }>,
    bridgeStartResult: null as any,
    bridgeStartThrows: null as any,
    bridgeStopThrows: null as any,
    bridgeSeekThrows: null as any,
    apDeviceThrows: false,
    spinFront: null as any,
    spinCalls: [] as Array<{ fn: string; args: any[] }>,
    spinBehavior: null as any,
    groupVolume: 7,
    volumeWrites: [] as Array<[string, number]>,
    volumeSetThrows: false,
    logLines: [] as Array<{ level: string; msg: string }>,
    groupPollImpl: null as any,
  };
  return h;
});

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    get: (id: string) => H.groups.get(id),
    setVolume: (id: string, v: number) => {
      if (H.volumeSetThrows) throw new Error("库写失败");
      H.volumeWrites.push([id, v]);
      H.groupVolume = v;
    },
    getVolume: (_id: string) => H.groupVolume,
  }),
  // 照抄 src/services/group/index.ts:32-43
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

vi.mock("../../src/services/airplay/discovery.js", () => ({
  getAirPlayDevice: (id: string) => {
    if (H.apDeviceThrows) throw new Error("设备表损坏");
    const d = H.apDevices.get(id);
    if (!d) return undefined;
    return { ...d, available: H.apAvailable.has(id) };
  },
}));

vi.mock("../../src/services/group/airplayBridge.js", () => {
  const rec = (fn: string, args: any[]) => {
    H.bridgeCalls.push({ fn, args });
  };
  return {
    startGroupAirPlayBridge: async (groupId: string) => {
      rec("start", [groupId]);
      if (H.bridgeStartThrows) throw H.bridgeStartThrows;
      return H.bridgeStartResult;
    },
    stopGroupAirPlayBridge: async (groupId: string, reason?: string) => {
      rec("stop", [groupId, reason]);
      if (H.bridgeStopThrows) throw H.bridgeStopThrows;
    },
    seekGroupAirPlayBridge: async (groupId: string, seconds: number) => {
      rec("seek", [groupId, seconds]);
      if (H.bridgeSeekThrows) throw H.bridgeSeekThrows;
    },
    setGroupAirPlayVolume: async (groupId: string, volume: number) => {
      rec("volume", [groupId, volume]);
    },
  };
});

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => H.spinFront,
  sendspinGroupPoll: async (gname: string) => {
    if (!H.groupPollImpl) throw new Error("no poll impl");
    return H.groupPollImpl(gname);
  },
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => {
  const rec = async (gid: string, fn: string, args: any[]) => {
    H.spinCalls.push({ fn, args });
    if (H.spinBehavior) {
      const r = H.spinBehavior(fn, args);
      if (r instanceof Error) throw r;
      if (r !== undefined) return r;
    }
    return fn === "pollState" ? { playerId: `sendspin:${gid}`, playbackState: "PLAYING", position: 42, duration: 100, updatedAt: 0 } : { mediaUri: "http://spin/group" };
  };
  return {
    createSendspinGroupPlayer: (gid: string) => ({
      playerId: `sendspin:${gid}`,
      playMedia: (item: any, baseUrl: string, startMs?: number, bridge?: any) => rec(gid, "playMedia", [item, baseUrl, startMs, bridge]),
      stop: () => rec(gid, "stop", []),
      pause: () => rec(gid, "pause", []),
      resume: () => rec(gid, "resume", []),
      seek: (s: number) => rec(gid, "seek", [s]),
      setVolume: (v: number) => rec(gid, "setVolume", [v]),
      pollState: () => rec(gid, "pollState", []),
    }),
  };
});

vi.mock("../../src/services/sendspin/playerCore.js", () => ({
  sendspinGroupName: (gid: string) => `ug:${gid}`,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    debug: (m: string) => H.logLines.push({ level: "debug", msg: m }),
    info: (m: string) => H.logLines.push({ level: "info", msg: m }),
    warn: (m: string) => H.logLines.push({ level: "warn", msg: m }),
    error: (m: string) => H.logLines.push({ level: "error", msg: m }),
  }),
}));

import {
  splitGroupMembers,
  getOnlineSendspinIds,
  getOnlineAirPlayIds,
  hasOnlineMember,
  getGroupLeader,
  getGroupLeaderDeviceId,
  createGroupProtocolPlayer,
  getGroupStatus,
} from "../../src/services/group/protocolPlayer.js";

function reset() {
  H.groups.clear();
  H.apDevices.clear();
  H.apAvailable.clear();
  H.bridgeCalls.length = 0;
  H.bridgeStartResult = null;
  H.bridgeStartThrows = null;
  H.bridgeStopThrows = null;
  H.bridgeSeekThrows = null;
  H.apDeviceThrows = false;
  H.spinFront = null;
  H.spinCalls.length = 0;
  H.spinBehavior = null;
  H.groupVolume = 7;
  H.volumeWrites.length = 0;
  H.volumeSetThrows = false;
  H.logLines.length = 0;
  H.groupPollImpl = null;
}

beforeEach(reset);

function mkGroup(id: string, memberIds: string[], extra: any = {}) {
  H.groups.set(id, { id, name: id, memberIds, ...extra });
}
function front(clients: Array<[string, any]>, groups: Array<[string, any]> = []) {
  H.spinFront = { clients: new Map(clients), groups: new Map(groups) };
}
/** 登记一台 airplay 设备(默认在线)。 */
function apDevice(id: string, available = true) {
  H.apDevices.set(id, { id, name: `ap-${id}`, host: "10.0.0.9", port: 7000, pk: "pk", et: "0,1" });
  if (available) H.apAvailable.add(id);
}
const warns = () => H.logLines.filter((l) => l.level === "warn").map((l) => l.msg);

// ---------------- 成员分流 ----------------
describe("splitGroupMembers:按 kind 拆成员", () => {
  it("组不存在 → 两个空数组", () => {
    expect(splitGroupMembers("g-x")).toEqual({ spin: [], airplay: [] });
  });

  it("sendspin: / airplay: 各归其位", () => {
    apDevice("d2");
    mkGroup("g1", ["sendspin:c3", "airplay:d2"]);
    expect(splitGroupMembers("g1")).toEqual({ spin: ["c3"], airplay: ["d2"] });
  });

  it("dlna: / 裸 id / group: / local: 一律丢弃(DLNA 已禁止入组)", () => {
    mkGroup("g1", ["bare1", "dlna:d2", "group:g9", "local:u1", "sendspin:c3", "airplay:d4"]);
    expect(splitGroupMembers("g1")).toEqual({ spin: ["c3"], airplay: ["d4"] });
  });

  it("空前缀(只有 'sendspin:' 没有 id)→ splitMemberId 返回 null → 该成员被跳过", () => {
    mkGroup("g1", ["sendspin:", "airplay:", "", "airplay:ok"]);
    expect(splitGroupMembers("g1")).toEqual({ spin: [], airplay: ["ok"] });
  });
});

// ---------------- 在线判定 ----------------
describe("getOnlineSendspinIds:走 front.clients 的 ready 判定", () => {
  it("组内没有 sendspin 成员 → [] 且不去取 front", () => {
    mkGroup("g1", ["airplay:d1"]);
    expect(getOnlineSendspinIds("g1")).toEqual([]);
  });

  it("front 尚未建立 → []", () => {
    mkGroup("g1", ["sendspin:c1"]);
    H.spinFront = null;
    expect(getOnlineSendspinIds("g1")).toEqual([]);
  });

  it("ready!==false 视为在线;ready:false 与 client 缺失都剔除;返回裸 clientId", () => {
    mkGroup("g1", ["sendspin:c1", "sendspin:c2", "sendspin:c3", "airplay:d1"]);
    front([["c1", { ready: true }], ["c2", { ready: false }]]);
    expect(getOnlineSendspinIds("g1")).toEqual(["c1"]);
  });

  it("client 存在但无 ready 字段 → 视为在线(仅显式 false 才算离线)", () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { volume: 10 }]]);
    expect(getOnlineSendspinIds("g1")).toEqual(["c1"]);
  });
});

describe("getOnlineAirPlayIds:mDNS available 判定", () => {
  it("组内没有 airplay 成员 → []", () => {
    mkGroup("g1", ["sendspin:c1"]);
    expect(getOnlineAirPlayIds("g1")).toEqual([]);
  });

  it("设备档案存在且 available → 在线;离线或档案缺失 → 剔除", () => {
    apDevice("d1", true);
    apDevice("d2", false);
    mkGroup("g1", ["airplay:d1", "airplay:d2", "airplay:d3"]);
    expect(getOnlineAirPlayIds("g1")).toEqual(["d1"]);
  });

  it("getAirPlayDevice 抛错当作离线(不把异常抛给调用方)", () => {
    mkGroup("g1", ["airplay:d1"]);
    H.apDeviceThrows = true;
    expect(getOnlineAirPlayIds("g1")).toEqual([]);
  });
});

describe("hasOnlineMember:airplay 在线 或 sendspin 在线", () => {
  it("仅 airplay 在线 → true", () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    expect(hasOnlineMember("g1")).toBe(true);
  });

  it("airplay 离线但 sendspin 在线 → true", () => {
    apDevice("d1", false);
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    front([["c1", { ready: true }]]);
    expect(hasOnlineMember("g1")).toBe(true);
  });

  it("两者都离线 → false", () => {
    apDevice("d1", false);
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    front([["c1", { ready: false }]]);
    expect(hasOnlineMember("g1")).toBe(false);
  });

  it("空组 → false", () => {
    mkGroup("g1", []);
    expect(hasOnlineMember("g1")).toBe(false);
  });
});

// ---------------- leader 派生 ----------------
describe("getGroupLeader:固定顺序首个在线成员(跨 kind)", () => {
  it("组不存在 → undefined", () => {
    expect(getGroupLeader("nope")).toBeUndefined();
  });

  it("首个成员是离线 airplay、其后是在线 sendspin → 取 sendspin", () => {
    apDevice("d1", false);
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    front([["c1", { ready: true }]]);
    expect(getGroupLeader("g1")).toEqual({ kind: "sendspin", id: "c1" });
  });

  it("首个在线成员是 airplay → 取 airplay(kind=airplay,返回裸 deviceId)", () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    front([["c1", { ready: true }]]);
    expect(getGroupLeader("g1")).toEqual({ kind: "airplay", id: "d1" });
  });

  it("无法解析的成员(dlna:/group:/local:)被跳过,不影响后续成员当选", () => {
    apDevice("d1");
    mkGroup("g1", ["dlna:dx", "group:gx", "local:u1", "airplay:d1"]);
    expect(getGroupLeader("g1")).toEqual({ kind: "airplay", id: "d1" });
  });

  it("全部离线 → undefined", () => {
    apDevice("d1", false);
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    front([["c1", { ready: false }]]);
    expect(getGroupLeader("g1")).toBeUndefined();
  });

  it("getGroupLeaderDeviceId 取 leader 裸 id", () => {
    apDevice("d2");
    mkGroup("g1", ["airplay:d1", "airplay:d2"]);
    expect(getGroupLeaderDeviceId("g1")).toBe("d2");
  });
});

// ---------------- playMedia ----------------
describe("playMedia:先建 airplay 桥接,再起统一 pump", () => {
  it("无任何在线成员 → 抛『无在线成员,无法播放』,且不碰桥接", async () => {
    apDevice("d1", false);
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    front([["c1", { ready: false }]]);
    await expect(createGroupProtocolPlayer("g1").playMedia({ id: "q1" } as any, "http://base"))
      .rejects.toThrow("组 g1 无在线成员,无法播放");
    expect(H.bridgeCalls).toEqual([]);
  });

  it("sendspin 在线 + airplay 在线 → 桥接一次,再把 bridgeInfo 交给 pump", async () => {
    apDevice("d1");
    mkGroup("g1", ["sendspin:c1", "airplay:d1"]);
    front([["c1", { ready: true }]]);
    H.bridgeStartResult = { devices: ["d1"], host: "127.0.0.1", port: 43823, minSendAheadUs: 1200000 };
    const r = await createGroupProtocolPlayer("g1").playMedia({ id: "q1" } as any, "http://base");
    expect(H.bridgeCalls.map((c) => c.fn)).toEqual(["start"]);
    const pm = H.spinCalls.find((c) => c.fn === "playMedia")!;
    expect(pm.args[2]).toBe(0); // startMs 缺省 0
    expect(pm.args[3]).toEqual({ devices: ["d1"], host: "127.0.0.1", port: 43823, minSendAheadUs: 1200000 });
    expect(r.mediaUri).toBe("http://spin/group");
  });

  it("纯 airplay 组(零 sendspin 成员)→ 桥接信息为 null 也照常起 pump", async () => {
    apDevice("d1");
    apDevice("d2");
    mkGroup("g1", ["airplay:d1", "airplay:d2"]);
    H.bridgeStartResult = { devices: ["d1", "d2"], host: "127.0.0.1", port: 40001 };
    await createGroupProtocolPlayer("g1").playMedia({ id: "q1" } as any, "http://base", 5000);
    const pm = H.spinCalls.find((c) => c.fn === "playMedia")!;
    expect(pm.args[2]).toBe(5000);
    expect(pm.args[3]).toEqual({ devices: ["d1", "d2"], host: "127.0.0.1", port: 40001 });
  });

  it("桥接返回 null(无 airplay 成员 / 无子进程)→ pump 收到 undefined", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]]);
    H.bridgeStartResult = null;
    await createGroupProtocolPlayer("g1").playMedia({ id: "q1" } as any, "http://base");
    expect(H.spinCalls.find((c) => c.fn === "playMedia")!.args[3]).toBeUndefined();
  });

  it("起播失败 → 立刻拆桥接会话(不留静音会话在设备上)并把原错误抛出", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    H.bridgeStartResult = { devices: ["d1"], host: "127.0.0.1", port: 1 };
    H.spinBehavior = (fn: string) => (fn === "playMedia" ? new Error("泵起不来") : undefined);
    await expect(createGroupProtocolPlayer("g1").playMedia({} as any, "http://base")).rejects.toThrow("泵起不来");
    expect(H.bridgeCalls.filter((c) => c.fn === "stop").map((c) => c.args[1])).toEqual(["起播失败回滚"]);
  });

  it("起播失败 + 回滚也失败 → 仍抛原错误(回滚异常不掩盖根因)", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    H.bridgeStartResult = { devices: ["d1"], host: "127.0.0.1", port: 1 };
    H.spinBehavior = (fn: string) => (fn === "playMedia" ? new Error("泵起不来") : undefined);
    H.bridgeStopThrows = new Error("拆不掉");
    await expect(createGroupProtocolPlayer("g1").playMedia({} as any, "http://base")).rejects.toThrow("泵起不来");
  });
});

// ---------------- stop / pause / resume ----------------
describe("stop:先停 pump 再拆桥接;pause/resume 只动 pump", () => {
  it("stop 顺序 = pump stop → 桥接 stop(避免设备收到半截音频)", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    H.bridgeStartResult = { devices: ["d1"], host: "127.0.0.1", port: 1 };
    const p = createGroupProtocolPlayer("g1");
    await p.playMedia({} as any, "http://base");
    H.spinCalls.length = 0;
    H.bridgeCalls.length = 0;
    await p.stop();
    expect(H.spinCalls.map((c) => c.fn)).toEqual(["stop"]);
    expect(H.bridgeCalls.map((c) => c.fn)).toEqual(["stop"]);
    expect(H.bridgeCalls[0].args[1]).toBe("组停止");
  });

  it("pump stop 抛错被吞掉,桥接仍然拆", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    H.spinBehavior = (fn: string) => (fn === "stop" ? new Error("泵已死") : undefined);
    await expect(createGroupProtocolPlayer("g1").stop()).resolves.toBeUndefined();
    expect(H.bridgeCalls.filter((c) => c.fn === "stop").length).toBe(1);
  });

  it("pause / resume 只下发 pump,不碰 RAOP 会话", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    const p = createGroupProtocolPlayer("g1");
    await p.pause();
    await p.resume();
    expect(H.spinCalls.map((c) => c.fn)).toEqual(["pause", "resume"]);
    expect(H.bridgeCalls).toEqual([]);
  });

  it("playerId = group:<groupId>", () => {
    expect(createGroupProtocolPlayer("g-abc").playerId).toBe("group:g-abc");
  });
});

// ---------------- seek / setVolume ----------------
describe("seek:pump 重建时间线 + RAOP FLUSH", () => {
  it("两路都下发,秒数原样透传", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    await createGroupProtocolPlayer("g1").seek(12.345);
    expect(H.spinCalls.find((c) => c.fn === "seek")!.args).toEqual([12.345]);
    expect(H.bridgeCalls.find((c) => c.fn === "seek")!.args).toEqual(["g1", 12.345]);
  });

  it("桥接 seek 失败只 warn,不影响整体(seek 仍 resolve)", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    H.bridgeSeekThrows = new Error("RAOP FLUSH 失败");
    await expect(createGroupProtocolPlayer("g1").seek(3)).resolves.toBeUndefined();
    expect(warns().join()).toContain("airplay 桥接 seek 失败");
  });
});

describe("setVolume:先落库,再 pump + airplay 设备", () => {
  it("三路都走到,值原样透传", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    await createGroupProtocolPlayer("g1").setVolume(55);
    expect(H.volumeWrites).toEqual([["g1", 55]]);
    expect(H.spinCalls.find((c) => c.fn === "setVolume")!.args).toEqual([55]);
    expect(H.bridgeCalls.find((c) => c.fn === "volume")!.args).toEqual(["g1", 55]);
  });

  it("GroupManager.setVolume 抛错被吞掉,两路下发照常", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    H.volumeSetThrows = true;
    await expect(createGroupProtocolPlayer("g1").setVolume(9)).resolves.toBeUndefined();
    expect(H.bridgeCalls.find((c) => c.fn === "volume")!.args).toEqual(["g1", 9]);
  });

  it("pump 与 airplay 音量下发失败都不影响 resolve", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1", "sendspin:c1"]);
    H.spinBehavior = (fn: string) => (fn === "setVolume" ? new Error("泵音量失败") : undefined);
    await expect(createGroupProtocolPlayer("g1").setVolume(30)).resolves.toBeUndefined();
  });
});

// ---------------- pollState ----------------
describe("pollState:声音都在共享 pump 上,状态一律从 pump 派生", () => {
  it("无在线成员 → BUFFERING(不报 IDLE,否则 tracker 误判曲目结束)", async () => {
    apDevice("d1", false);
    mkGroup("g1", ["airplay:d1"]);
    const st = await createGroupProtocolPlayer("g1").pollState();
    expect(st).toEqual({ playerId: "group:g1", playbackState: "BUFFERING", position: 0, duration: 0, updatedAt: expect.any(Number) });
  });

  it("airplay 成员在线 → 从 pump 派生(即使零 sendspin 成员)", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    H.groupPollImpl = async () => ({ playing: true, paused: false, positionMs: 42000, durationMs: 100000 });
    const st = await createGroupProtocolPlayer("g1").pollState();
    expect(st).toEqual({ playerId: "group:g1", playbackState: "PLAYING", position: 42, duration: 100, updatedAt: expect.any(Number), unavailable: false });
  });

  it("paused → PAUSED;pump 查不到 → IDLE 且 unavailable=true", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]]);
    H.groupPollImpl = async () => ({ playing: false, paused: true, positionMs: 1000, durationMs: 5000 });
    expect((await createGroupProtocolPlayer("g1").pollState()).playbackState).toBe("PAUSED");

    H.groupPollImpl = async () => { throw new Error("pump 掉线"); };
    const st = await createGroupProtocolPlayer("g1").pollState();
    expect(st.playbackState).toBe("IDLE");
    expect(st.unavailable).toBe(true);
  });

  it("isAvailable 与 hasOnlineMember 同源", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    const p = createGroupProtocolPlayer("g1");
    await expect(p.isAvailable()).resolves.toBe(true);
    H.apAvailable.clear();
    await expect(p.isAvailable()).resolves.toBe(false);
  });
});

// ---------------- getGroupStatus ----------------
describe("getGroupStatus:音量权威 = GroupManager 持久值", () => {
  it("无 leader → STOPPED + 持久音量(muted=false)", async () => {
    apDevice("d1", false);
    mkGroup("g1", ["airplay:d1"]);
    const st = await getGroupStatus("g1");
    expect(st).toEqual({ state: "STOPPED", position: 0, duration: 0, volume: 7, muted: false, updatedAt: expect.any(Number) });
  });

  it("leader 在 → 从 pump 派生,秒值向下取整,音量取实时组值", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], [["ug:g1", { volume: 33, muted: true, current: { title: "T" } }]]);
    H.groupPollImpl = async () => ({ playing: true, positionMs: 12345, durationMs: 200000 });
    const st = await getGroupStatus("g1");
    expect(st).toEqual({ state: "PLAYING", position: 12, duration: 200, volume: 33, muted: true, media: { title: "T" }, updatedAt: expect.any(Number) });
  });

  it("pump 未在播 → STOPPED", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], [["ug:g1", {}]]);
    H.groupPollImpl = async () => ({ playing: false, paused: false, positionMs: 0, durationMs: 0 });
    expect((await getGroupStatus("g1")).state).toBe("STOPPED");
  });

  it("sendspinGroupPoll reject → 回落『未在播』而不是把异常抛出", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], [["ug:g1", {}]]);
    H.groupPollImpl = async () => { throw new Error("pump 掉线"); };
    const st = await getGroupStatus("g1");
    expect(st.state).toBe("STOPPED");
    expect(st.position).toBe(0);
  });

  it("实时组尚未建立 → 音量回落持久库值,muted=false,media 为 undefined", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], []);
    H.groupPollImpl = async () => ({ playing: true, positionMs: 1000, durationMs: 1000 });
    const st = await getGroupStatus("g1");
    expect(st.volume).toBe(7);
    expect(st.muted).toBe(false);
    expect(st.media).toBeUndefined();
  });

  it("leader 是 airplay 成员 → 同样从 pump 派生(不查设备)", async () => {
    apDevice("d1");
    mkGroup("g1", ["airplay:d1"]);
    front([], [["ug:g1", { volume: 21, muted: true }]]);
    H.groupPollImpl = async () => ({ playing: true, positionMs: 8000, durationMs: 90000 });
    expect(await getGroupStatus("g1")).toEqual({ state: "PLAYING", position: 8, duration: 90, volume: 21, muted: true, media: undefined, updatedAt: expect.any(Number) });
  });
});
