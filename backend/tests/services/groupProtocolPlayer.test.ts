// ==================== group/protocolPlayer 行为测试 ====================
// 目标:覆盖 src/services/group/protocolPlayer.ts 的成员分流 / 在线判定 / leader 派生 /
//       组播放扇出(dlna 逐成员 cast + sendspin 组单发)/ 状态派生。
// 手法:整体替换 group/index(getGroupManager + splitMemberId)、dlna/control、
//       sendspin 的 index/protocolPlayer/playerCore 与 logger —— 本文件不碰真实
//       DB / 网络 / 设备。splitMemberId 的替身按 src/services/group/index.ts:26-37
//       的真实语义照抄(裸 id ≡ dlna、group:/local: 前缀 → null)。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const h: any = {
    groups: new Map<string, any>(),
    // DLNA 可达性:集合为准;availSeq 用于「同一成员先后给出不同答案」
    // (leader 派生时可达、pollState 复查时又不可达)。
    dlnaAvailable: new Set<string>(),
    availSeq: new Map<string, boolean[]>(),
    dlnaCalls: [] as Array<{ id: string; fn: string; args: any[] }>,
    dlnaBehavior: new Map<string, (fn: string, args: any[]) => any>(),
    deviceStatus: new Map<string, any>(),
    deviceStatusThrows: new Set<string>(),
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
  // 照抄 src/services/group/index.ts:26-37
  splitMemberId: (m: any) => {
    if (typeof m !== "string" || !m) return null;
    if (m.startsWith("group:") || m.startsWith("local:")) return null;
    if (m.startsWith("sendspin:")) {
      const id = m.slice("sendspin:".length);
      return id ? { kind: "sendspin", id } : null;
    }
    if (m.startsWith("dlna:")) {
      const id = m.slice("dlna:".length);
      return id ? { kind: "dlna", id } : null;
    }
    return { kind: "dlna", id: m };
  },
}));

vi.mock("../../src/services/dlna/control.js", () => {
  const rec = async (id: string, fn: string, args: any[]) => {
    H.dlnaCalls.push({ id, fn, args });
    const custom = H.dlnaBehavior.get(id);
    if (custom) {
      const r = custom(fn, args);
      if (r instanceof Error) throw r;
      return r;
    }
    if (fn === "pollState") {
      if (H.deviceStatusThrows.has(id)) throw new Error("SOAP 炸了");
      return H.deviceStatus.get(id) ?? { playerId: `dlna:${id}`, playbackState: "STOPPED", position: 0, duration: 0, updatedAt: 0 };
    }
    return { mediaUri: `http://cast/${id}` };
  };
  return {
    createDlnaProtocolPlayer: (id: string) => ({
      playerId: `dlna:${id}`,
      playMedia: (item: any, baseUrl: string) => rec(id, "playMedia", [item, baseUrl]),
      stop: () => rec(id, "stop", []),
      pause: () => rec(id, "pause", []),
      resume: () => rec(id, "resume", []),
      seek: (s: number) => rec(id, "seek", [s]),
      setVolume: (v: number) => rec(id, "setVolume", [v]),
      pollState: () => rec(id, "pollState", []),
    }),
    getDevice: (id: string) => ({ id, name: `dev-${id}` }),
    getDeviceStatus: async (id: string) => {
      if (H.deviceStatusThrows.has(id)) throw new Error("device status 炸了");
      return H.deviceStatus.get(id) ?? { state: "STOPPED", position: 0, duration: 0, volume: 30, muted: false };
    },
    isDeviceAvailable: (id: string) => {
      const q = H.availSeq.get(id);
      if (q && q.length) return q.shift()!;
      return H.dlnaAvailable.has(id);
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
      playMedia: (item: any, baseUrl: string) => rec(gid, "playMedia", [item, baseUrl]),
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
  hasOnlineMember,
  getGroupLeader,
  getOnlineMemberIds,
  getGroupLeaderDeviceId,
  createGroupProtocolPlayer,
  getGroupStatus,
} from "../../src/services/group/protocolPlayer.js";

function reset() {
  H.groups.clear();
  H.dlnaAvailable.clear();
  H.availSeq.clear();
  H.dlnaCalls.length = 0;
  H.dlnaBehavior.clear();
  H.deviceStatus.clear();
  H.deviceStatusThrows.clear();
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
const warns = () => H.logLines.filter((l) => l.level === "warn").map((l) => l.msg);

// ---------------- 成员分流 ----------------
describe("splitGroupMembers:按 kind 拆成员", () => {
  it("组不存在 → 两个空数组", () => {
    expect(splitGroupMembers("g-x")).toEqual({ dlna: [], spin: [] });
  });

  it("裸 id / dlna: / sendspin: 三类各归其位,group: 与 local: 前缀被丢弃", () => {
    mkGroup("g1", ["bare1", "dlna:d2", "sendspin:c3", "group:g9", "local:u1"]);
    expect(splitGroupMembers("g1")).toEqual({ dlna: ["bare1", "d2"], spin: ["c3"] });
  });

  it("空前缀(只有 'sendspin:' 没有 id)→ splitMemberId 返回 null → 该成员被跳过", () => {
    mkGroup("g1", ["sendspin:", "dlna:", "", "dlna:ok"]);
    expect(splitGroupMembers("g1")).toEqual({ dlna: ["ok"], spin: [] });
  });
});

// ---------------- sendspin 在线判定 ----------------
describe("getOnlineSendspinIds:走 front.clients 的 ready 判定", () => {
  it("组内没有 sendspin 成员 → [] 且不去取 front", () => {
    mkGroup("g1", ["d1"]);
    expect(getOnlineSendspinIds("g1")).toEqual([]);
  });

  it("front 尚未建立 → []", () => {
    mkGroup("g1", ["sendspin:c1"]);
    H.spinFront = null;
    expect(getOnlineSendspinIds("g1")).toEqual([]);
  });

  it("ready!==false 视为在线;ready:false 与 client 缺失都剔除;返回裸 clientId", () => {
    mkGroup("g1", ["sendspin:c1", "sendspin:c2", "sendspin:c3", "d1"]);
    front([["c1", { ready: true }], ["c2", { ready: false }]]);
    expect(getOnlineSendspinIds("g1")).toEqual(["c1"]);
  });

  it("client 存在但无 ready 字段 → 视为在线(仅显式 false 才算离线)", () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { volume: 10 }]]);
    expect(getOnlineSendspinIds("g1")).toEqual(["c1"]);
  });
});

describe("hasOnlineMember:DLNA 在线 或 sendspin 在线", () => {
  it("仅 DLNA 在线 → true", () => {
    mkGroup("g1", ["d1"]);
    H.dlnaAvailable.add("d1");
    expect(hasOnlineMember("g1")).toBe(true);
  });

  it("DLNA 离线但 sendspin 在线 → true", () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    front([["c1", { ready: true }]]);
    expect(hasOnlineMember("g1")).toBe(true);
  });

  it("两者都离线 → false", () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    front([["c1", { ready: false }]]);
    expect(hasOnlineMember("g1")).toBe(false);
  });
});

// ---------------- leader 派生 ----------------
describe("getGroupLeader:固定顺序首个在线成员(跨 kind)", () => {
  it("组不存在 → undefined", () => {
    expect(getGroupLeader("nope")).toBeUndefined();
  });

  it("首个成员是离线 DLNA、其后是在线 sendspin → 取 sendspin", () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    front([["c1", { ready: true }]]);
    expect(getGroupLeader("g1")).toEqual({ kind: "sendspin", id: "c1" });
  });

  it("首个在线成员是 DLNA → 取 DLNA(kind=dlna,返回裸 deviceId)", () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    H.dlnaAvailable.add("d1");
    front([["c1", { ready: true }]]);
    expect(getGroupLeader("g1")).toEqual({ kind: "dlna", id: "d1" });
  });

  it("无法解析的成员(group:/local:)被跳过,不影响后续成员当选", () => {
    mkGroup("g1", ["group:gx", "local:u1", "d1"]);
    H.dlnaAvailable.add("d1");
    expect(getGroupLeader("g1")).toEqual({ kind: "dlna", id: "d1" });
  });

  it("全部离线 → undefined", () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    front([["c1", { ready: false }]]);
    expect(getGroupLeader("g1")).toBeUndefined();
  });

  it("sendspin 成员不在线时不会回落到后面那个 DLNA 之前就返回(顺序即优先级)", () => {
    mkGroup("g1", ["sendspin:c1", "dlna:d1"]);
    H.dlnaAvailable.add("d1");
    front([]); // c1 缺 client → 离线
    expect(getGroupLeader("g1")).toEqual({ kind: "dlna", id: "d1" });
  });
});

describe("getOnlineMemberIds / getGroupLeaderDeviceId:仅 DLNA 口径", () => {
  it("组不存在 → [] / undefined", () => {
    expect(getOnlineMemberIds("nope")).toEqual([]);
    expect(getGroupLeaderDeviceId("nope")).toBeUndefined();
  });

  it("只保留 kind=dlna 且当前可达的成员(裸 id 与 dlna: 都还原成裸 deviceId)", () => {
    mkGroup("g1", ["d1", "dlna:d2", "sendspin:c1"]);
    H.dlnaAvailable.add("d1");
    H.dlnaAvailable.add("c1"); // 即便 c1 这个 id 可达,它也不是 dlna 成员
    expect(getOnlineMemberIds("g1")).toEqual(["d1"]);
  });

  it("getGroupLeaderDeviceId 取在线 DLNA 成员里的第一个", () => {
    mkGroup("g1", ["d1", "d2"]);
    H.dlnaAvailable.add("d2");
    expect(getGroupLeaderDeviceId("g1")).toBe("d2");
  });
});

// ---------------- fanOut:DLNA 逐成员扇出 ----------------
describe("fanOut:无在线成员早返回 / 逐成员失败只告警不中断", () => {
  it("组无在线 DLNA 成员 → 不调用任何 dlna player,仅打 debug", async () => {
    mkGroup("g1", ["dlna:d1"]);
    const p = createGroupProtocolPlayer("g1");
    await p.stop();
    expect(H.dlnaCalls).toEqual([]);
    expect(H.logLines.filter((l) => l.level === "debug").map((l) => l.msg).join()).toContain("无在线 DLNA 成员,跳过扇出");
  });

  it("部分成员 reject → warn 里带出失败成员 id 与原因,其余成员照常下发", async () => {
    mkGroup("g1", ["d1", "d2", "d3"]);
    ["d1", "d2", "d3"].forEach((d) => H.dlnaAvailable.add(d));
    H.dlnaBehavior.set("d2", () => new Error("连接被拒"));
    const p = createGroupProtocolPlayer("g1");
    await p.stop();
    expect(H.dlnaCalls.filter((c) => c.fn === "stop").map((c) => c.id)).toEqual(["d1", "d2", "d3"]);
    const w = warns().join("\n");
    expect(w).toContain("1/3 成员失败");
    expect(w).toContain("d2(连接被拒)");
  });

  it("全部成功 → 不产生 warn", async () => {
    mkGroup("g1", ["d1", "d2"]);
    ["d1", "d2"].forEach((d) => H.dlnaAvailable.add(d));
    await createGroupProtocolPlayer("g1").pause();
    expect(warns()).toEqual([]);
  });

  it("pause / resume 走同一扇出,参数原样下发给每个成员", async () => {
    mkGroup("g1", ["d1"]);
    H.dlnaAvailable.add("d1");
    const p = createGroupProtocolPlayer("g1");
    await p.pause();
    await p.resume();
    expect(H.dlnaCalls.map((c) => c.fn)).toEqual(["pause", "resume"]);
  });

  it("playerId = group:<groupId>", () => {
    expect(createGroupProtocolPlayer("g-abc").playerId).toBe("group:g-abc");
  });
});

// ---------------- spinOp:sendspin 子集单发 ----------------
describe("spinOp:sendspin 子集走一个共享组 player(非逐成员)", () => {
  it("组内无 sendspin 成员 → 完全不加载 sendspin 组 player", async () => {
    mkGroup("g1", ["d1"]);
    H.dlnaAvailable.add("d1");
    await createGroupProtocolPlayer("g1").stop();
    expect(H.spinCalls).toEqual([]);
  });

  it("有 sendspin 成员 → 只发一次组指令(与其在线与否无关)", async () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1", "sendspin:c2"]);
    H.dlnaAvailable.add("d1");
    await createGroupProtocolPlayer("g1").stop();
    expect(H.spinCalls.map((c) => c.fn)).toEqual(["stop"]);
  });

  it("无在线 DLNA 成员时 sendspin 组指令仍照发", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    await createGroupProtocolPlayer("g1").pause();
    expect(H.spinCalls.map((c) => c.fn)).toEqual(["pause"]);
  });
});

// ---------------- playMedia ----------------
describe("playMedia:dlna 扇出 + sendspin 组播,取首个成功的 mediaUri", () => {
  it("无任何在线成员(DLNA 与 sendspin 皆无)→ 抛『无在线成员,无法播放』", async () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    front([["c1", { ready: false }]]);
    await expect(createGroupProtocolPlayer("g1").playMedia({ id: "q1" } as any, "http://base"))
      .rejects.toThrow("组 g1 无在线成员,无法播放");
  });

  it("sendspin 在线 + DLNA 在线 → sendspin 组播一次 + 每个在线 DLNA 各 cast 一次", async () => {
    mkGroup("g1", ["sendspin:c1", "dlna:d1", "d2"]);
    front([["c1", { ready: true }]]);
    H.dlnaAvailable.add("d1");
    H.dlnaAvailable.add("d2");
    const r = await createGroupProtocolPlayer("g1").playMedia({ id: "q1" } as any, "http://base");
    expect(H.spinCalls.filter((c) => c.fn === "playMedia").length).toBe(1);
    expect(H.dlnaCalls.filter((c) => c.fn === "playMedia").map((c) => c.id).sort()).toEqual(["d1", "d2"]);
    expect(r.mediaUri).toBe("http://spin/group"); // sendspin 先入 jobs,故首个成功者是它
  });

  it("item 与 baseUrl 原样透传给 sendspin 组 player 与该 URL 的 dlna 成员", async () => {
    mkGroup("g1", ["sendspin:c1", "d1"]);
    front([["c1", { ready: true }]]);
    H.dlnaAvailable.add("d1");
    await createGroupProtocolPlayer("g1").playMedia({ id: "q9", title: "T" } as any, "http://b9");
    const dlna = H.dlnaCalls.find((c) => c.fn === "playMedia")!;
    expect(dlna.args[0]).toEqual({ id: "q9", title: "T" });
    expect(dlna.args[1]).toBe("http://b9");
    expect(H.spinCalls.find((c) => c.fn === "playMedia")!.args).toEqual([{ id: "q9", title: "T" }, "http://b9"]);
  });

  it("全部 cast 失败 → 抛『全部成员 cast 失败』", async () => {
    mkGroup("g1", ["d1", "d2"]);
    H.dlnaAvailable.add("d1");
    H.dlnaAvailable.add("d2");
    H.dlnaBehavior.set("d1", () => new Error("x"));
    H.dlnaBehavior.set("d2", () => new Error("y"));
    await expect(createGroupProtocolPlayer("g1").playMedia({} as any, "http://base"))
      .rejects.toThrow("组 g1 全部成员 cast 失败");
  });

  it("部分成员失败 → 仍返回成功者的 mediaUri,并 warn 失败路数", async () => {
    mkGroup("g1", ["d1", "d2"]);
    H.dlnaAvailable.add("d1");
    H.dlnaAvailable.add("d2");
    H.dlnaBehavior.set("d1", () => new Error("x"));
    const r = await createGroupProtocolPlayer("g1").playMedia({} as any, "http://base");
    expect(r).toEqual({ mediaUri: "http://cast/d2" });
    expect(warns().join()).toContain("1/2 路播放失败");
  });
});

// ---------------- seek / setVolume ----------------
describe("seek:DLNA 扇出与 sendspin 组播两条路径分别记账", () => {
  it("两路都下发,秒数原样透传,debug 汇总里带出目标秒数与两路计数", async () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    H.dlnaAvailable.add("d1");
    await createGroupProtocolPlayer("g1").seek(12.345);
    expect(H.dlnaCalls.find((c) => c.fn === "seek")!.args).toEqual([12.345]);
    expect(H.spinCalls.find((c) => c.fn === "seek")!.args).toEqual([12.345]);
    const d = H.logLines.filter((l) => l.level === "debug").map((l) => l.msg).join("\n");
    expect(d).toContain("目标=12.35s");
    expect(d).toContain("DLNA 1/1");
    expect(d).toContain("sendspin=1");
  });

  it("DLNA 成员全部失败时 seek 仍 resolve(不抛),汇总里的分母如实报 0 成功", async () => {
    mkGroup("g1", ["d1"]);
    H.dlnaAvailable.add("d1");
    H.dlnaBehavior.set("d1", () => new Error("no"));
    await expect(createGroupProtocolPlayer("g1").seek(1)).resolves.toBeUndefined();
    expect(H.logLines.filter((l) => l.level === "debug").map((l) => l.msg).join()).toContain("DLNA 0/1");
  });
});

describe("setVolume:先落库再扇出(库写失败不挡下发)", () => {
  it("先写 GroupManager 再下发,值原样透传", async () => {
    mkGroup("g1", ["dlna:d1", "sendspin:c1"]);
    H.dlnaAvailable.add("d1");
    await createGroupProtocolPlayer("g1").setVolume(55);
    expect(H.volumeWrites).toEqual([["g1", 55]]);
    expect(H.dlnaCalls.find((c) => c.fn === "setVolume")!.args).toEqual([55]);
    expect(H.spinCalls.find((c) => c.fn === "setVolume")!.args).toEqual([55]);
  });

  it("GroupManager.setVolume 抛错被吞掉,扇出照常进行", async () => {
    mkGroup("g1", ["d1"]);
    H.dlnaAvailable.add("d1");
    H.volumeSetThrows = true;
    await expect(createGroupProtocolPlayer("g1").setVolume(9)).resolves.toBeUndefined();
    expect(H.dlnaCalls.find((c) => c.fn === "setVolume")!.args).toEqual([9]);
  });
});

// ---------------- pollState ----------------
describe("pollState:leader 派生 + 离线不报 IDLE(报 BUFFERING 瞬态)", () => {
  it("无 leader → BUFFERING(position/duration 归零)", async () => {
    mkGroup("g1", ["dlna:d1"]);
    const st = await createGroupProtocolPlayer("g1").pollState();
    expect(st).toEqual({ playerId: "group:g1", playbackState: "BUFFERING", position: 0, duration: 0, updatedAt: expect.any(Number) });
  });

  it("leader 是 sendspin 成员 → 从共享组 pump 派生并改写 playerId", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]]);
    const st = await createGroupProtocolPlayer("g1").pollState();
    expect(st).toEqual({ playerId: "group:g1", playbackState: "PLAYING", position: 42, duration: 100, updatedAt: 0 });
    expect(H.spinCalls.map((c) => c.fn)).toEqual(["pollState"]);
  });

  it("leader 是 DLNA 成员 → 用该设备的 pollState,并覆写 playerId", async () => {
    mkGroup("g1", ["d1"]);
    H.dlnaAvailable.add("d1");
    H.deviceStatus.set("d1", { playerId: "dlna:d1", playbackState: "PAUSED", position: 5, duration: 60, updatedAt: 11 });
    const st = await createGroupProtocolPlayer("g1").pollState();
    expect(st).toEqual({ playerId: "group:g1", playbackState: "PAUSED", position: 5, duration: 60, updatedAt: 11 });
  });

  it("leader 在派生后又变成不可达 → 走 BUFFERING 防御分支(device pollState 不被调用)", async () => {
    mkGroup("g1", ["d1"]);
    H.availSeq.set("d1", [true, false]); // 第一次(选 leader)可达,第二次(复查)不可达
    const st = await createGroupProtocolPlayer("g1").pollState();
    expect(st.playbackState).toBe("BUFFERING");
    expect(H.dlnaCalls.filter((c) => c.fn === "pollState")).toEqual([]);
  });
});

// ---------------- getGroupStatus ----------------
describe("getGroupStatus:音量权威 = GroupManager 持久值", () => {
  it("无 leader → STOPPED + 持久音量(muted=false)", async () => {
    mkGroup("g1", ["dlna:d1"]);
    const st = await getGroupStatus("g1");
    expect(st).toEqual({ state: "STOPPED", position: 0, duration: 0, volume: 7, muted: false, updatedAt: expect.any(Number) });
  });

  it("leader 是 sendspin:组 pump 在播 → PLAYING,秒值向下取整,音量取实时组值", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], [["ug:g1", { volume: 33, muted: true, current: { title: "T" } }]]);
    H.groupPollImpl = async () => ({ playing: true, positionMs: 12345, durationMs: 200000 });
    const st = await getGroupStatus("g1");
    expect(st).toEqual({ state: "PLAYING", position: 12, duration: 200, volume: 33, muted: true, media: { title: "T" }, updatedAt: expect.any(Number) });
  });

  it("leader 是 sendspin:pump 未在播 → STOPPED", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], [["ug:g1", {}]]);
    H.groupPollImpl = async () => ({ playing: false, positionMs: 0, durationMs: 0 });
    expect((await getGroupStatus("g1")).state).toBe("STOPPED");
  });

  it("leader 是 sendspin:sendspinGroupPoll reject → 回落『未在播』而不是把异常抛出", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], [["ug:g1", {}]]);
    H.groupPollImpl = async () => { throw new Error("pump 掉线"); };
    const st = await getGroupStatus("g1");
    expect(st.state).toBe("STOPPED");
    expect(st.position).toBe(0);
  });

  it("leader 是 sendspin:实时组尚未建立 → 音量回落持久库值,muted=false,media 为 undefined", async () => {
    mkGroup("g1", ["sendspin:c1"]);
    front([["c1", { ready: true }]], []); // front.groups 里没有 ug:g1
    H.groupPollImpl = async () => ({ playing: true, positionMs: 1000, durationMs: 1000 });
    const st = await getGroupStatus("g1");
    expect(st.volume).toBe(7);
    expect(st.muted).toBe(false);
    expect(st.media).toBeUndefined();
  });

  it("leader 是 DLNA → 设备状态 + 用 GroupManager 音量覆盖设备音量(组标度优先)", async () => {
    mkGroup("g1", ["d1"]);
    H.dlnaAvailable.add("d1");
    H.deviceStatus.set("d1", { state: "PLAYING", position: 8, duration: 90, volume: 99, muted: true });
    H.groupVolume = 21;
    expect(await getGroupStatus("g1")).toEqual({ state: "PLAYING", position: 8, duration: 90, volume: 21, muted: true });
  });
});
