// Sendspin ProtocolPlayer 单元测试(补 protocolPlayer.ts 的 176 行缺口)。
//
// 与既有 protocolPlayer.test.ts 的分工:那份是**集成式**(真起 sendspin server,走
// in-proc 主路径);这里把全部协作方 mock 掉,专攻它够不到的部分 ——
//   - fork 模式的 proxy player(生产主进程那条路,集成测试永远走不到)
//   - 用户组 player(createSendspinGroupPlayer)
//   - resume 的冷起播(coldStartResume)
//   - sendspinClientAvailable / onlineSendspinMembers 的判定口径
//
// 这几处正是注释里记着三次真机事故的地方:
//   2026-09-17 resume 只调 pump.resume() → 「点播放没声音」;
//   2026-09-21 子进程心跳停摆 95s,pollState 撒谎报 IDLE → 位置归零、曲目乱跳。
// 所以这里的断言不是凑覆盖率,是给这些事故钉回归。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  fork: false,

  // ---- sendspin/index.js(源码里是动态 import,vi.mock 一样拦得住)----
  front: undefined as any,
  frontThrows: false,
  groupPlay: vi.fn(async () => {}),
  groupTransport: vi.fn(async () => {}),
  groupPumpActive: vi.fn(async () => false),
  groupPoll: vi.fn(async () => ({ playing: true, positionMs: 12_000, durationMs: 180_000 })),

  // ---- group manager ----
  group: null as null | { memberIds: string[] },
  groupVolume: 100,
  gmSetVolume: vi.fn(),
  gmSetVolumeThrows: false,

  // ---- server / playerCore ----
  srv: { log: vi.fn() } as any,
  playCore: vi.fn(),
  stopCore: vi.fn(),
  pauseCore: vi.fn(),
  resumePumpCore: vi.fn(),
  seekCore: vi.fn(),
  setVolumeCore: vi.fn(),
  pollCore: vi.fn(() => ({ playing: false, positionMs: 0, durationMs: 0 })),
  pumpActiveCore: vi.fn(() => false),

  // ---- supervisor rpc ----
  rpc: vi.fn(),

  // ---- player/queue controller ----
  reportState: vi.fn(),
  emit: vi.fn(),
  snapshot: { currentIndex: -1, items: [] as any[] },
  resolveItem: vi.fn(async (i: any) => i),

  // ---- logger ----
  dbg: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/services/sendspin/mode.js", () => ({ isForkMode: () => h.fork }));

vi.mock("../../src/services/sendspin/index.js", () => ({
  getSendspinFront: () => {
    if (h.frontThrows) throw new Error("index 模块炸了");
    return h.front;
  },
  sendspinGroupPlay: h.groupPlay,
  sendspinGroupTransport: h.groupTransport,
  sendspinGroupPumpActive: h.groupPumpActive,
  sendspinGroupPoll: h.groupPoll,
}));

vi.mock("../../src/services/sendspin/runtime.js", () => ({ getServer: () => h.srv }));

vi.mock("../../src/services/sendspin/playerCore.js", async (io) => {
  const real: any = await io();
  return {
    ...real, // sendspinGroupName / ephemeralGroup 用真实的
    playCore: h.playCore,
    stopCore: h.stopCore,
    pauseCore: h.pauseCore,
    resumePumpCore: h.resumePumpCore,
    seekCore: h.seekCore,
    setVolumeCore: h.setVolumeCore,
    pollCore: h.pollCore,
    pumpActiveCore: h.pumpActiveCore,
  };
});

vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: { rpc: h.rpc },
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  createCastSession: (songId: string, who: string) => ({
    streamUrl: `http://eff/rest/dlna/stream/${songId}?who=${encodeURIComponent(who)}`,
  }),
  getEffectiveBaseUrl: () => "http://eff",
}));

vi.mock("../../src/services/player/index.js", () => ({
  getPlayerController: () => ({ reportState: h.reportState }),
  getQueueController: () => ({
    snapshot: () => h.snapshot,
    resolveItem: h.resolveItem,
    emit: h.emit,
  }),
}));

vi.mock("../../src/services/group/index.js", async (io) => {
  const real: any = await io(); // splitMemberId 用真实的:本文件就是要验它的口径
  return {
    ...real,
    getGroupManager: () => ({
      get: () => h.group,
      getVolume: () => h.groupVolume,
      setVolume: (id: string, v: number) => {
        if (h.gmSetVolumeThrows) throw new Error("player_groups 写失败");
        h.gmSetVolume(id, v);
      },
    }),
  };
});

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({ debug: h.dbg, warn: h.warn, info: vi.fn(), error: vi.fn() }),
}));

import {
  createSendspinProtocolPlayer,
  createSendspinGroupPlayer,
} from "../../src/services/sendspin/protocolPlayer.js";
import { sendspinGroupName } from "../../src/services/sendspin/playerCore.js";
import { PlaybackState } from "../../src/services/player/types.js";

function item(o: any = {}) {
  return {
    songId: "s1",
    title: "T",
    artist: "A",
    album: "Al",
    coverArt: "c",
    mime: "audio/opus",
    duration: 180,
    ...o,
  };
}

/** 让 rpc 按 op 分派:值可以是常量、函数(收 payload)或 Error(抛出)。 */
function rpcFor(map: Record<string, any>) {
  h.rpc.mockImplementation(async (op: string, payload: any) => {
    const v = map[op];
    if (v instanceof Error) throw v;
    if (typeof v === "function") return v(payload);
    return v;
  });
}

/** onlineSendspinMembers 依赖的「已连接客户端表」。 */
function frontWith(clients: Record<string, any>) {
  return { clients: new Map(Object.entries(clients)) };
}

beforeEach(() => {
  h.fork = false;
  h.front = undefined;
  h.frontThrows = false;
  h.group = null;
  h.groupVolume = 100;
  h.gmSetVolumeThrows = false;
  h.gmSetVolume.mockClear();
  h.groupPlay.mockClear();
  h.groupTransport.mockClear();
  h.groupPumpActive.mockClear().mockResolvedValue(false);
  h.groupPoll.mockClear().mockResolvedValue({ playing: true, positionMs: 12_000, durationMs: 180_000 });
  h.srv = { log: vi.fn() };
  h.playCore.mockClear();
  h.stopCore.mockClear();
  h.pauseCore.mockClear();
  h.resumePumpCore.mockClear();
  h.seekCore.mockClear();
  h.setVolumeCore.mockClear();
  h.pollCore.mockClear().mockReturnValue({ playing: false, positionMs: 0, durationMs: 0 });
  h.pumpActiveCore.mockClear().mockReturnValue(false);
  h.rpc.mockReset();
  h.reportState.mockClear();
  h.emit.mockClear();
  h.snapshot = { currentIndex: -1, items: [] };
  h.resolveItem.mockClear().mockImplementation(async (i: any) => i);
  h.dbg.mockClear();
  h.warn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ==================== isAvailable / 在线判定口径 ====================

describe("isAvailable:以「连接派生」判定,不靠猜", () => {
  it("客户端在线且 ready 未置 false → 可用", async () => {
    h.front = frontWith({ c1: { ready: true } });
    expect(await createSendspinProtocolPlayer("c1").isAvailable()).toBe(true);
  });

  it("客户端不在列表 → 不可用(此时 cast 会投进 ephemeral 组:没声音却显示\"在播\",最坏)", async () => {
    h.front = frontWith({ other: { ready: true } });
    expect(await createSendspinProtocolPlayer("c1").isAvailable()).toBe(false);
  });

  it("ready === false → 不可用", async () => {
    h.front = frontWith({ c1: { ready: false } });
    expect(await createSendspinProtocolPlayer("c1").isAvailable()).toBe(false);
  });

  it("getSendspinFront() 返回空 → 不可用(不抛)", async () => {
    h.front = undefined;
    expect(await createSendspinProtocolPlayer("c1").isAvailable()).toBe(false);
  });

  it("动态 import 炸了 → 吞掉并按不可用回落,绝不把异常抛给播控", async () => {
    h.frontThrows = true;
    await expect(createSendspinProtocolPlayer("c1").isAvailable()).resolves.toBe(false);
  });
});

// ==================== 用户组 player ====================

describe("createSendspinGroupPlayer:组内 sendspin 成员共用一个 pump", () => {
  const GID = "ug1";
  const GNAME = sendspinGroupName(GID);

  it("playerId 固定为 `group:<id>`", () => {
    expect(createSendspinGroupPlayer(GID).playerId).toBe(`group:${GID}`);
  });

  describe("playMedia", () => {
    it("无在线成员 → 直接抛错(不允许投进空组)", async () => {
      h.group = { memberIds: ["dlna:d1"] };
      h.front = frontWith({});
      await expect(createSendspinGroupPlayer(GID).playMedia(item(), "http://eff")).rejects.toThrow(/无在线 sendspin 成员/);
      expect(h.groupPlay).not.toHaveBeenCalled();
    });

    it("组不存在 → 同样按无成员处理", async () => {
      h.group = null;
      await expect(createSendspinGroupPlayer(GID).playMedia(item(), "http://eff")).rejects.toThrow(/无在线 sendspin 成员/);
    });

    it("组有成员但 sendspin 前端还没起来(front 为空)→ 按无在线成员处理", async () => {
      h.group = { memberIds: ["sendspin:c1"] };
      h.front = undefined;
      await expect(createSendspinGroupPlayer(GID).playMedia(item(), "http://eff")).rejects.toThrow(/无在线 sendspin 成员/);
    });

    it("正常起播:先灌持久音量,再下发 play,返回 token 流地址", async () => {
      h.group = { memberIds: ["sendspin:c1", "sendspin:c2"] };
      h.front = frontWith({ c1: { ready: true }, c2: { ready: true } });
      h.groupVolume = 42;
      const r = await createSendspinGroupPlayer(GID).playMedia(item({ songId: "sg1" }), "http://eff");
      expect(r.mediaUri).toContain("sg1");
      // 音量回填必须**先于** play:否则起播瞬间音量是缺省 100,听感上"自己跳回去"。
      expect(h.groupTransport.mock.calls[0]).toEqual([GNAME, "volume", 42]);
      expect(h.groupPlay).toHaveBeenCalledTimes(1);
      expect(h.groupPlay.mock.calls[0][1]).toEqual(["c1", "c2"]);
    });

    it("【兜底】音量回填失败(子进程不在)→ 不挡起播", async () => {
      h.group = { memberIds: ["sendspin:c1"] };
      h.front = frontWith({ c1: { ready: true } });
      h.groupTransport.mockRejectedValueOnce(new Error("子进程重启中"));
      const r = await createSendspinGroupPlayer(GID).playMedia(item(), "http://eff");
      expect(r.mediaUri).toBeTruthy();
      expect(h.groupPlay).toHaveBeenCalledTimes(1);
    });

    it("只认就绪成员:ready=false 的不进组", async () => {
      h.group = { memberIds: ["sendspin:c1", "sendspin:c2"] };
      h.front = frontWith({ c1: { ready: true }, c2: { ready: false } });
      await createSendspinGroupPlayer(GID).playMedia(item(), "http://eff");
      expect(h.groupPlay.mock.calls[0][1]).toEqual(["c1"]);
    });

    it("命名空间写法与裸写法都认作 sendspin,dlna 成员被排除", async () => {
      h.group = { memberIds: ["sendspin:c1", "dlna:d9"] };
      h.front = frontWith({ c1: { ready: true }, d9: { ready: true } });
      await createSendspinGroupPlayer(GID).playMedia(item(), "http://eff");
      expect(h.groupPlay.mock.calls[0][1]).toEqual(["c1"]);
    });

    it("起播即异步上报 PLAYING(不能同步:会被 resetTracker 清掉)", async () => {
      h.group = { memberIds: ["sendspin:c1"] };
      h.front = frontWith({ c1: { ready: true } });
      // 先排空前面用例遗留的 setTimeout(0) 上报,否则计数会串味(每次 playMedia 都调度一个)。
      await new Promise((r) => setTimeout(r, 0));
      h.reportState.mockClear();
      const p = createSendspinGroupPlayer(GID);
      await p.playMedia(item({ duration: 7 }), "http://eff");
      // 同步阶段还没上报 —— 这是刻意的(setTimeout 0 是宏任务,晚于 resetTracker)。
      expect(h.reportState).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.reportState).toHaveBeenCalledTimes(1);
      expect(h.reportState.mock.calls[0][0]).toMatchObject({
        playerId: `group:${GID}`,
        playbackState: PlaybackState.PLAYING,
        position: 0,
        duration: 7,
      });
    });
  });

  it("stop / pause → 转发 transport", async () => {
    const p = createSendspinGroupPlayer(GID);
    await p.stop();
    await p.pause();
    expect(h.groupTransport.mock.calls).toEqual([[GNAME, "stop"], [GNAME, "pause"]]);
  });

  describe("resume", () => {
    it("pump 还活着(暂停中)→ 原地 resume,不重发起播", async () => {
      h.groupPumpActive.mockResolvedValue(true);
      await createSendspinGroupPlayer(GID).resume();
      expect(h.groupTransport).toHaveBeenCalledWith(GNAME, "resume");
      expect(h.resolveItem).not.toHaveBeenCalled();
    });

    it("【2026-09-17 事故】pump 不在(冷起播)→ 必须走 playMedia,不能只调 resume", async () => {
      h.groupPumpActive.mockResolvedValue(false);
      h.snapshot = { currentIndex: 0, items: [item({ songId: "sg9" })] };
      h.group = { memberIds: ["sendspin:c1"] };
      h.front = frontWith({ c1: { ready: true } });
      await createSendspinGroupPlayer(GID).resume();
      // 关键:走了 playMedia(否则没 stream/start、没 pump → 全链路静默)。
      expect(h.groupPlay).toHaveBeenCalledTimes(1);
      expect(h.groupPlay.mock.calls[0][2].songId).toBe("sg9");
      expect(h.groupTransport).not.toHaveBeenCalledWith(GNAME, "resume");
    });

    it("冷起播但队列无当前曲 → warn 后放弃,不炸", async () => {
      h.groupPumpActive.mockResolvedValue(false);
      h.snapshot = { currentIndex: -1, items: [] };
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await createSendspinGroupPlayer(GID).resume();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("无当前曲");
      expect(h.groupPlay).not.toHaveBeenCalled();
    });

    it("pumpActive 探测本身抛错 → 按「不在推流」处理,走冷起播", async () => {
      h.groupPumpActive.mockRejectedValue(new Error("RPC 超时"));
      h.snapshot = { currentIndex: 0, items: [item({ songId: "sg10" })] };
      h.group = { memberIds: ["sendspin:c1"] };
      h.front = frontWith({ c1: { ready: true } });
      await createSendspinGroupPlayer(GID).resume();
      expect(h.groupPlay).toHaveBeenCalledTimes(1);
    });
  });

  it("seek → 转发 transport,并在协议层留「目标秒数 + 耗时」边界日志", async () => {
    await createSendspinGroupPlayer(GID).seek(31.5);
    expect(h.groupTransport).toHaveBeenCalledWith(GNAME, "seek", 31.5);
    const msgs = h.dbg.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("[seek]") && m.includes("31.50"))).toBe(true);
    // 下发前后各一条:拖动后无声时先靠这两行确认「指令到没到协议层」。
    expect(msgs.filter((m) => m.includes("[seek]")).length).toBe(2);
  });

  describe("setVolume", () => {
    it("组音量先落 player_groups(无成员也持久),再下发", async () => {
      await createSendspinGroupPlayer(GID).setVolume(77);
      expect(h.gmSetVolume).toHaveBeenCalledWith(GID, 77);
      expect(h.groupTransport).toHaveBeenCalledWith(GNAME, "volume", 77);
    });

    it("【兜底】落库失败不挡下发", async () => {
      h.gmSetVolumeThrows = true;
      await createSendspinGroupPlayer(GID).setVolume(55);
      expect(h.groupTransport).toHaveBeenCalledWith(GNAME, "volume", 55);
    });
  });

  it("isAvailable:组内至少一个就绪 sendspin 成员即可;探测失败回落 false", async () => {
    h.group = { memberIds: ["sendspin:c1"] };
    h.front = frontWith({ c1: { ready: true } });
    expect(await createSendspinGroupPlayer(GID).isAvailable()).toBe(true);
    h.frontThrows = true;
    expect(await createSendspinGroupPlayer(GID).isAvailable()).toBe(false);
  });

  describe("pollState", () => {
    it("playing / position / duration 按秒换算上报", async () => {
      h.groupPoll.mockResolvedValue({ playing: true, positionMs: 12_000, durationMs: 180_000 });
      const st = await createSendspinGroupPlayer(GID).pollState();
      expect(st.playerId).toBe(`group:${GID}`);
      expect(st.playbackState).toBe(PlaybackState.PLAYING);
      expect(st.position).toBe(12);
      expect(st.duration).toBe(180);
      expect(st.unavailable).toBe(false);
    });

    it("【2026-09-21 事故】探不到 → 必须标 unavailable,不能冒充 IDLE", async () => {
      h.groupPoll.mockRejectedValue(new Error("子进程心跳停摆"));
      const st = await createSendspinGroupPlayer(GID).pollState();
      // 冒充 IDLE 会让 tracker 判「自然结束」→ 凭空切歌;标记后由 QC 决定不喂 tracker。
      expect(st.unavailable).toBe(true);
      expect(st.playbackState).toBe(PlaybackState.IDLE);
      expect(st.position).toBe(0);
    });
  });
});

// ==================== fork 模式:主进程 proxy ====================

describe("createSendspinProxyPlayer(fork 模式:命令 RPC → 子进程)", () => {
  beforeEach(() => {
    h.fork = true;
  });

  it("playerId 与 in-proc 一致(上游按 id 寻址,两种模式对外同构)", () => {
    expect(createSendspinProtocolPlayer("c1").playerId).toBe("sendspin:c1");
  });

  it("playMedia:token 流地址在本侧生成,再 RPC 交给子进程推流", async () => {
    rpcFor({ playMedia: undefined });
    const r = await createSendspinProtocolPlayer("c1").playMedia(item({ songId: "sp1" }), "http://eff");
    expect(r.mediaUri).toContain("sp1");
    const call = h.rpc.mock.calls.find((c) => c[0] === "playMedia")!;
    expect(call[1].clientId).toBe("c1");
    expect(call[1].item.songId).toBe("sp1");
    expect(call[1].streamUrl).toBe(r.mediaUri);
  });

  it("stop / pause / setVolume → 一律转成 transport RPC", async () => {
    rpcFor({ transport: undefined });
    const p = createSendspinProtocolPlayer("c1");
    await p.stop();
    await p.pause();
    await p.setVolume(33);
    expect(h.rpc.mock.calls).toEqual([
      ["transport", { clientId: "c1", op: "stop", arg: undefined }],
      ["transport", { clientId: "c1", op: "pause", arg: undefined }],
      ["transport", { clientId: "c1", op: "volume", arg: 33 }],
    ]);
  });

  it("resume:pumpActive 为真 → 原地 resume", async () => {
    rpcFor({ pumpActive: true, transport: undefined });
    await createSendspinProtocolPlayer("c1").resume();
    expect(h.rpc.mock.calls.some((c) => c[0] === "transport" && c[1].op === "resume")).toBe(true);
  });

  it("【2026-09-17 事故】resume 且 pump 不在 → 冷起播走 playMedia", async () => {
    rpcFor({ pumpActive: false, playMedia: undefined });
    h.snapshot = { currentIndex: 0, items: [item({ songId: "sp9" })] };
    await createSendspinProtocolPlayer("c1").resume();
    const call = h.rpc.mock.calls.find((c) => c[0] === "playMedia")!;
    expect(call[1].item.songId).toBe("sp9");
  });

  it("pumpActive RPC 本身失败 → 按「不在推流」走冷起播", async () => {
    rpcFor({ pumpActive: new Error("子进程不在"), playMedia: undefined });
    h.snapshot = { currentIndex: 0, items: [item({ songId: "sp11" })] };
    await createSendspinProtocolPlayer("c1").resume();
    expect(h.rpc.mock.calls.some((c) => c[0] === "playMedia")).toBe(true);
  });

  it("冷起播但队列空 → console.warn 后放弃", async () => {
    rpcFor({ pumpActive: false });
    h.snapshot = { currentIndex: -1, items: [] };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createSendspinProtocolPlayer("c1").resume();
    expect(String(spy.mock.calls[0][0])).toContain("[Sendspin]");
  });

  it("seek 正常:RPC 前后各留一条边界日志", async () => {
    rpcFor({ transport: undefined });
    await createSendspinProtocolPlayer("c1").seek(12.25);
    const msgs = h.dbg.mock.calls.map((c) => String(c[0]));
    expect(msgs.filter((m) => m.includes("[seek]")).length).toBe(2);
    expect(msgs.some((m) => m.includes("12.25"))).toBe(true);
  });

  it("【可读性】seek RPC 失败 → 留一条带耗时的 warn 再抛出(不静默吞掉)", async () => {
    rpcFor({ transport: new Error("RPC 25s 超时") });
    await expect(createSendspinProtocolPlayer("c1").seek(9)).rejects.toThrow("RPC 25s 超时");
    const msg = String(h.warn.mock.calls[0][0]);
    expect(msg).toContain("[seek]");
    expect(msg).toContain("RPC 失败");
    expect(msg).toMatch(/9\.00s/);
  });

  it("pollState 正常 → 按秒换算,不带 unavailable", async () => {
    rpcFor({ poll: { playing: true, positionMs: 5_000, durationMs: 200_000 } });
    const st = await createSendspinProtocolPlayer("c1").pollState();
    expect(st.playbackState).toBe(PlaybackState.PLAYING);
    expect(st.position).toBe(5);
    expect(st.duration).toBe(200);
    expect(st.unavailable).toBe(false);
  });

  it("【2026-09-21 事故】子进程不在 → 标 unavailable,绝不冒充 IDLE", async () => {
    rpcFor({ poll: new Error("子进程崩溃重启窗口") });
    const st = await createSendspinProtocolPlayer("c1").pollState();
    expect(st.unavailable).toBe(true);
    expect(st.playbackState).toBe(PlaybackState.IDLE);
  });

  it("isAvailable 与 in-proc 同口径(走 getSendspinFront,不看模式)", async () => {
    h.front = frontWith({ c1: { ready: true } });
    expect(await createSendspinProtocolPlayer("c1").isAvailable()).toBe(true);
    h.front = frontWith({ c1: { ready: false } });
    expect(await createSendspinProtocolPlayer("c1").isAvailable()).toBe(false);
  });
});

// ==================== in-proc 模式的冷起播分支 ====================

describe("in-proc player:resume 的两种走向", () => {
  it("stop / pause → 直接落到 playerCore,不经过 RPC", async () => {
    const p = createSendspinProtocolPlayer("c1");
    await p.stop();
    await p.pause();
    expect(h.stopCore).toHaveBeenCalledTimes(1);
    expect(h.stopCore.mock.calls[0][1]).toBe("c1");
    expect(h.pauseCore).toHaveBeenCalledTimes(1);
    expect(h.pauseCore.mock.calls[0][1]).toBe("c1");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("pump 活着(暂停中)→ resumePumpCore,不动流", async () => {
    h.pumpActiveCore.mockReturnValue(true);
    await createSendspinProtocolPlayer("c1").resume();
    expect(h.resumePumpCore).toHaveBeenCalledTimes(1);
    expect(h.playCore).not.toHaveBeenCalled();
  });

  it("【2026-09-17 事故】pump 不在 → 冷起播,必须走 playMedia", async () => {
    h.pumpActiveCore.mockReturnValue(false);
    h.snapshot = { currentIndex: 0, items: [item({ songId: "si9" })] };
    await createSendspinProtocolPlayer("c1").resume();
    expect(h.playCore).toHaveBeenCalledTimes(1);
    expect(h.playCore.mock.calls[0][2].songId).toBe("si9");
    expect(h.resumePumpCore).not.toHaveBeenCalled();
  });

  it("冷起播前先 resolveItem 补全元数据(否则组状态缺 coverArt/mime)", async () => {
    h.pumpActiveCore.mockReturnValue(false);
    h.snapshot = { currentIndex: 0, items: [{ songId: "si10" }] };
    h.resolveItem.mockResolvedValue(item({ songId: "si10", coverArt: "full" }));
    await createSendspinProtocolPlayer("c1").resume();
    expect(h.resolveItem).toHaveBeenCalledTimes(1);
    expect(h.playCore.mock.calls[0][2].coverArt).toBe("full");
  });

  it("队列无当前曲 → 走 srv.log 留痕并放弃(不炸)", async () => {
    h.pumpActiveCore.mockReturnValue(false);
    h.snapshot = { currentIndex: -1, items: [] };
    await createSendspinProtocolPlayer("c1").resume();
    expect(h.srv.log).toHaveBeenCalledTimes(1);
    expect(h.srv.log.mock.calls[0][0]).toBe("warn");
    expect(String(h.srv.log.mock.calls[0][1])).toContain("无当前曲");
    expect(h.playCore).not.toHaveBeenCalled();
  });
});

describe("media_changed 事件(起播即推,HA 卡片不必等轮询)", () => {
  it("in-proc playMedia 带上完整元数据", async () => {
    await createSendspinProtocolPlayer("c1").playMedia(item({ songId: "sm1", title: "标题" }), "http://eff");
    await new Promise((r) => setTimeout(r, 0)); // emitMediaChanged 是动态 import + 微任务
    const evt = h.emit.mock.calls.find((c) => c[0] === "media_changed");
    expect(evt).toBeTruthy();
    expect(evt![1]).toBe("c1");
    expect(evt![2]).toMatchObject({ songId: "sm1", title: "标题" });
  });

  it("控制器未就绪(emit 抛错)→ 吞掉,不影响起播", async () => {
    h.emit.mockImplementation(() => {
      throw new Error("控制器未就绪");
    });
    const r = await createSendspinProtocolPlayer("c1").playMedia(item(), "http://eff");
    expect(r.mediaUri).toBeTruthy();
  });
});
