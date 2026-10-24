// ==================== QueueController 操作面(注册 / 传输 / 队列 CRUD / flow / 定时 / 落库) ====================
//
// 决策面护栏(advance · idle_early · frozen · stalled · 不可播目标)已由
//   QueueController.test.ts · queueStall.test.ts · linkUnavailable.test.ts ·
//   playTargetGuard.test.ts
// 四个文件钉死,本文件**不重复**它们。这里补的是 QueueController 其余的公开面:
//   · 设备/组注册与注销、孤儿清理;
//   · transport / getPlayerState / startPollLoop / pollAllDevices 的异常与跳过分枝;
//   · 链路恢复的三条早退(traces 326-328 / 337-339 / 340);
//   · idle_early 与 frozen 的 seek 冷静期与复查异常分支;
//   · 队列增删改(removeAt / reorder / prev 的 all 绕回);
//   · flow 会话(setFlowOwned / isFlowOwned / flowAdvance);
//   · 服务器端定时暂停(sleep timer);
//   · 组重入对齐(rejoinMembers)的三条失败分支;
//   · 判源(judgePlayable)的「正缓存 + 直链已死」与读库异常分支;
//   · 队列落库(persist)、启动加载(loadFromDb)、activeDevices、预探测回调守卫。
//
// 所有外部副作用面(协议 player 创建、组管理、播放目标判据、预探测调度器、在线源判定)
// 一律 mock —— 只验证 QueueController 自身的行为,不触网、不落真实曲库。
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

type Any = any;

const H = vi.hoisted(() => ({
  // ---- dlna/control ----
  isAvailable: true,
  alignResult: 0,
  devices: new Map<string, Any>(),
  /** 让 createDlnaProtocolPlayer 对这些设备抛错(模拟设备拒连)。 */
  badDevices: new Set<string>(),
  clearedMedia: [] as string[],
  alignTargets: [] as Array<{ deviceId: string; position: number }>,
  // ---- group ----
  groups: new Map<string, Any>(),
  groupOnline: new Map<string, boolean>(),
  deviceGroups: new Map<string, string[]>(),
  groupStatus: { position: 0, state: "STOPPED" } as Any,
  groupStatusThrows: false,
  memberStates: [] as Any[],
  groupList: [] as Any[],
  // ---- playTarget ----
  playable: true,
  playReason: "不可播",
  // ---- preProbeScheduler ----
  probeCleared: [] as string[],
  probeCooldownCleared: [] as string[],
  probeScheduled: [] as string[],
  probeMarked: [] as string[],
  onChange: [] as Array<(id: string) => void>,
  // ---- player/index(PlayerController 替身) ----
  pc: {} as Any,
  // ---- source/online ----
  cachedPlayability: null as null | "playable" | "unplayable",
  recheck: "ok" as string,
  ensureStream: true,
  evicted: [] as string[],
  resolvedRow: null as Any,
  // ---- 调用轨迹 ----
  log: [] as string[],
}));

// dlna/control:协议 player 的创建、设备可达性、媒体缓存清除、位置对齐全部换成假体。
vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (deviceId: string) => {
    if (H.badDevices.has(deviceId)) throw new Error(`设备 ${deviceId} 拒连`);
    const o = mkProto(`dlna:${deviceId}`);
    o.playMedia = async (item: Any) => { H.log.push(`playMedia:dlna:${deviceId}:${item.songId}`); return { mediaUri: `uri:${deviceId}` }; };
    return o;
  },
  getEffectiveBaseUrl: () => "http://eff",
  clearCurrentMedia: (id: string) => { H.clearedMedia.push(id); },
  getDevice: (id: string) => H.devices.get(id),
  alignDeviceToPosition: async (deviceId: string, position: number, opts?: Any) => {
    H.alignTargets.push({ deviceId, position });
    H.log.push(`align:${deviceId}:${position}`);
    // 真实现会先等设备稳定 PLAYING,再以 leader 的「实时」位置收敛 ——
    // 这里把回调走一遍,保证 QueueController 里那段 getTargetSec 也被执行。
    if (opts?.getTargetSec) await opts.getTargetSec();
    return H.alignResult;
  },
}));

// 组:组管理器的读接口 + 组协议 player(扇出)+ 在线成员判据 + 组状态。
vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({
    get: (id: string) => H.groups.get(id),
    groupsOfDevice: (deviceId: string) => H.deviceGroups.get(deviceId) ?? [],
    list: () => H.groupList,
    resolveMemberStates: () => H.memberStates,
  }),
}));

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  createGroupProtocolPlayer: (groupId: string) => mkProto(`group:${groupId}`),
  getGroupStatus: async () => {
    if (H.groupStatusThrows) throw new Error("组状态查询失败");
    return H.groupStatus;
  },
  hasOnlineMember: (groupId: string) => !!H.groupOnline.get(groupId),
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayProtocolPlayer: (deviceId: string) => mkProto(`airplay:${deviceId}`),
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinProtocolPlayer: (clientId: string) => mkProto(`sendspin:${clientId}`),
}));

// 播放目标判据由用例驱动(判据本身语义见 playTarget.test.ts)。
vi.mock("../../src/services/playTarget.js", () => ({
  checkPlayTarget: () => (H.playable ? { playable: true } : { playable: false, reason: H.playReason }),
}));

// 预探测调度器:只记录「谁被调度/清空/标记」,不真的扫描。
vi.mock("../../src/services/player/preProbeScheduler.js", () => ({
  getPreProbeScheduler: () => ({
    addOnChange: (cb: (id: string) => void) => { H.onChange.push(cb); },
    schedule: (id: string) => { H.probeScheduled.push(id); },
    clear: (id: string) => { H.probeCleared.push(id); },
    clearCooldown: (id: string) => { H.probeCooldownCleared.push(id); },
    markAllUnplayable: (id: string) => { H.probeMarked.push(id); },
    status: () => ({ ready: 0, scanned: 0, misses: 0, exhausted: false, cooldownUntil: null, at: 0 }),
  }),
}));

// PlayerController 单例换成替身(registerDlnaDevice 等会取它当 ctrl)。
vi.mock("../../src/services/player/index.js", () => ({
  getPlayerController: () => H.pc,
  getQueueController: () => H.pc,
  wirePlayerQueueControllers: () => {},
}));

// 在线源判定:缓存读数 + 直链复核 + 替代源,全部由用例驱动。
vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  getCachedPlayability: () => H.cachedPlayability,
  recheckOnlineDirect: async () => H.recheck,
  evictStreamFallbackCache: (id: string) => { H.evicted.push(id); },
  ensurePlayableStream: async () => {
    if (!H.ensureStream) throw new Error("无替代源");
    return true;
  },
}));

vi.mock("../../src/services/source/resolveAudio.js", () => ({
  resolvePlayableRow: async () => H.resolvedRow,
}));

import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import { clearSeekSettle, withinSeekSettle } from "../../src/services/player/seekSettle.js";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { albums, songs } from "../../src/db/schema.js";

/** 协议 player 假体(playerId 带命名空间前缀,与真实现一致)。 */
function mkProto(pid: string): Any {
  return {
    playerId: pid,
    async playMedia(item: Any) { H.log.push(`playMedia:${pid}:${item.songId}`); return { mediaUri: `uri:${pid}` }; },
    async stop() { H.log.push(`stop:${pid}`); },
    async pause() { H.log.push(`pause:${pid}`); },
    async resume() { H.log.push(`resume:${pid}`); },
    async seek(s: number) { H.log.push(`seek:${pid}:${s}`); },
    async setVolume(v: number) { H.log.push(`volume:${pid}:${v}`); },
    async pollState() {
      H.log.push(`poll:${pid}`);
      return { playerId: pid, playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() };
    },
    isAvailable: async () => H.isAvailable,
  };
}

/** UniversalPlayer 替身(QueueController 只看 playMedia/pollState/playerId/getProtocol)。 */
function mkPlayer(pid: string, over: Any = {}): Any {
  return {
    playerId: pid,
    playMedia: vi.fn(async (item: Any) => { H.log.push(`playMedia:${pid}:${item.songId}`); return { mediaUri: `uri:${pid}` }; }),
    stop: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    pollState: vi.fn(async () => ({
      playerId: pid, playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now(),
    })),
    getProtocol: () => ({ isAvailable: async () => H.isAvailable }),
    ...over,
  };
}

function mkCtrl(over: Any = {}): Any {
  return {
    beginOptimistic: vi.fn(), armOptimisticTimeout: vi.fn(), endOptimistic: vi.fn(),
    reportState: vi.fn(), resetTracker: vi.fn(), setExpectedDuration: vi.fn(),
    ...over,
  };
}

interface Opts {
  pid?: string;
  player?: Any;
  ctrl?: Any;
  items?: Any[] | null;
  currentIndex?: number;
  playMode?: string;
  isActive?: boolean;
  ended?: boolean;
  extra?: Any;
  /** true = 不装默认桩(判源/落库/预探测走真实实现)。 */
  raw?: boolean;
}

function mkQC(dev = "d1", opts: Opts = {}) {
  const qc = new QueueController();
  const any = qc as Any;
  const pid = opts.pid ?? `dlna:${dev}`;
  const player = opts.player ?? mkPlayer(pid);
  const ctrl = opts.ctrl ?? mkCtrl();
  any.players.set(dev, player);
  any.ctrls.set(dev, ctrl);
  if (opts.items !== null) {
    any.queues.set(dev, {
      items: opts.items ?? [
        { songId: "s1", title: "t1", mime: "audio/mpeg", duration: 200 },
        { songId: "s2", title: "t2", mime: "audio/mpeg", duration: 200 },
        { songId: "s3", title: "t3", mime: "audio/mpeg", duration: 200 },
      ],
      currentIndex: opts.currentIndex ?? 0,
      playMode: opts.playMode ?? "order",
      isActive: opts.isActive ?? true,
      ended: opts.ended ?? false,
      ...(opts.extra ?? {}),
    });
  }
  if (!opts.raw) {
    // 绕开判源 / 落库 / 预探测 —— 与本文件要验证的操作面无关,需要时用例自己覆盖。
    any.isMemberOfActiveGroup = () => false;
    any.judgePlayable = async () => "play";
    any.persist = () => {};
    any.schedulePreProbe = () => {};
  }
  return { qc, any, player, ctrl, pid };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function seedSong(id: string, over: Any = {}) {
  db.insert(songs)
    .values({ id, title: `t-${id}`, path: `l:t:/music/${id}.mp3`, suffix: "mp3", duration: 120, ...over })
    .run();
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  // 模块级状态与假体账本跨用例必须清干净。
  H.log = [];
  H.clearedMedia = [];
  H.alignTargets = [];
  H.evicted = [];
  H.probeCleared = [];
  H.probeCooldownCleared = [];
  H.probeScheduled = [];
  H.probeMarked = [];
  H.onChange = [];
  H.devices = new Map();
  H.badDevices = new Set();
  H.groups = new Map();
  H.groupOnline = new Map();
  H.deviceGroups = new Map();
  H.groupStatus = { position: 0, state: "STOPPED" };
  H.groupStatusThrows = false;
  H.groupList = [];
  H.memberStates = [];
  H.playable = true;
  H.cachedPlayability = null;
  H.recheck = "ok";
  H.ensureStream = true;
  H.resolvedRow = null;
  H.pc = mkCtrl();
  clearSeekSettle("d1");
  clearSeekSettle("g1");
  clearSeekSettle("devA");
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("注册与注销", () => {
  it("registerDlnaDevice:建 UniversalPlayer(dlna:<id>)+ 绑 DLNA 协议 + 用 PlayerController 当 ctrl", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerDlnaDevice("devA", "客厅音箱");
    const up = any.players.get("devA");
    expect(up.playerId).toBe("dlna:devA");
    expect(up.name).toBe("客厅音箱");
    // 协议 player 已挂上,且 pollState 可读
    expect(up.getProtocol().playerId).toBe("dlna:devA");
    expect(any.ctrls.get("devA")).toBe(H.pc);
  });

  it("registerDlnaDevice:重复注册是幂等的(不覆盖已有实例)", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerDlnaDevice("devA", "客厅音箱");
    const first = any.players.get("devA");
    any.registerDlnaDevice("devA", "换个名字");
    expect(any.players.get("devA")).toBe(first);
    expect(any.players.get("devA").name).toBe("客厅音箱");
  });

  it("registerGroupPlayer:建 UniversalPlayer(group:<id>)+ 绑组协议", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerGroupPlayer("g1", "我家组");
    const up = any.players.get("g1");
    expect(up.playerId).toBe("group:g1");
    expect(up.getProtocol().playerId).toBe("group:g1");
    expect(any.ctrls.get("g1")).toBe(H.pc);
  });

  it("registerGroupPlayer:重复注册幂等", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerGroupPlayer("g1", "我家组");
    const first = any.players.get("g1");
    any.registerGroupPlayer("g1", "别的名字");
    expect(any.players.get("g1")).toBe(first);
  });

  it("registerAirPlayDevice:建 UniversalPlayer(airplay:<id>)+ 绑 AirPlay 协议", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerAirPlayDevice("ap1", "卧室 HomePod");
    const up = any.players.get("ap1");
    expect(up.playerId).toBe("airplay:ap1");
    expect(up.getProtocol().playerId).toBe("airplay:ap1");
    expect(any.ctrls.get("ap1")).toBe(H.pc);
  });

  it("unregisterAirPlayDevices:只摘 AirPlay(含队列与休眠定时),DLNA 原样保留", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerAirPlayDevice("ap1", "HomePod");
    any.registerAirPlayDevice("ap2", "HomePod 2");
    any.registerDlnaDevice("devA", "音箱");
    any.queues.set("ap1", { items: [{ songId: "s1" }], currentIndex: 0, playMode: "order", isActive: true, ended: false });
    any.sleepTimers.set("ap1", { timer: setTimeout(() => {}, 10_000), deadline: Date.now() + 10_000 });

    any.unregisterAirPlayDevices();

    expect(any.players.has("ap1")).toBe(false);
    expect(any.ctrls.has("ap1")).toBe(false);
    expect(any.queues.has("ap1")).toBe(false);
    expect(any.sleepTimers.has("ap1")).toBe(false);   // 休眠定时一并清掉,不留悬空 timer
    expect(any.players.has("ap2")).toBe(false);
    expect(any.players.has("devA")).toBe(true);       // 非 AirPlay 不受影响
  });

  it("pruneOrphans:合法集合为空时不动(防误删)", () => {
    const { any } = mkQC("devA");
    any.pruneOrphans(new Set(), new Set());
    expect(any.players.has("devA")).toBe(true);
    expect(any.queues.has("devA")).toBe(true);
  });

  it("pruneOrphans:清掉不在合法集合里的播放器与全部内存账本", () => {
    const { any } = mkQC("ghost");
    any.stallCounters.set("ghost", { songId: "s1", count: 1 });
    any.castFailStreak.set("ghost", 3);
    any.linkLost.set("ghost", { pos: 10, at: Date.now(), reason: "x" });
    any.lastPos.set("ghost", 10);
    any.sleepTimers.set("ghost", { timer: setTimeout(() => {}, 10_000), deadline: Date.now() + 10_000 });

    any.pruneOrphans(new Set(["keep"]), new Set());

    expect(any.players.has("ghost")).toBe(false);
    expect(any.ctrls.has("ghost")).toBe(false);
    expect(any.queues.has("ghost")).toBe(false);
    expect(any.stallCounters.has("ghost")).toBe(false);
    expect(any.castFailStreak.has("ghost")).toBe(false);
    expect(any.linkLost.has("ghost")).toBe(false);
    expect(any.lastPos.has("ghost")).toBe(false);
    expect(any.sleepTimers.has("ghost")).toBe(false);
  });
});

describe("传输控制与状态读取", () => {
  it("transport:五种 op 各自转发,且 playerId 的前缀被剥掉", async () => {
    const { qc, player } = mkQC("d1");
    await qc.transport("dlna:d1", "play");
    await qc.transport("dlna:d1", "pause");
    await qc.transport("dlna:d1", "stop");
    await qc.transport("dlna:d1", "seek", 30);
    await qc.transport("dlna:d1", "volume", 55);
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(player.seek).toHaveBeenCalledWith(30);
    expect(player.setVolume).toHaveBeenCalledWith(55);
  });

  it("transport:未注册的播放器 → 抛错", async () => {
    const { qc } = mkQC("d1");
    await expect(qc.transport("dlna:nobody", "play")).rejects.toThrow(/未注册的播放器/);
  });

  it("transport:播放器抛错 → 原样抛出(不吞)", async () => {
    const player = mkPlayer("dlna:d1", { resume: vi.fn(async () => { throw new Error("设备拒绝"); }) });
    const { qc } = mkQC("d1", { player });
    await expect(qc.transport("dlna:d1", "play")).rejects.toThrow("设备拒绝");
  });

  it("transport:seek 打标冷静期;stop/play 清掉旧标记", async () => {
    const { qc } = mkQC("d1");
    await qc.transport("dlna:d1", "seek", 10);
    expect(withinSeekSettle("d1")).toBe(true);
    await qc.transport("dlna:d1", "stop");
    expect(withinSeekSettle("d1")).toBe(false);
    await qc.transport("dlna:d1", "seek", 20);
    await qc.transport("dlna:d1", "play");
    expect(withinSeekSettle("d1")).toBe(false);
  });

  it("getPlayerState:未注册 → undefined;注册 → pollState 结果(前缀被剥)", async () => {
    const { qc, player } = mkQC("d1");
    await expect(qc.getPlayerState("dlna:nobody")).resolves.toBeUndefined();
    const st = await qc.getPlayerState("group:d1");
    expect(player.pollState).toHaveBeenCalledTimes(1);
    expect(st?.playerId).toBe("dlna:d1");
  });

  it("startPollLoop:重复调用只留一个定时器,到点扫描一次", async () => {
    vi.useFakeTimers();
    const { qc, any } = mkQC("d1");
    const poll = vi.fn(async () => {});
    any.pollAllDevices = poll;
    qc.startPollLoop(() => "http://b");
    qc.startPollLoop(() => "http://b");   // 幂等:不再起第二个
    const first = any.pollTimer;
    expect(first).toBeTruthy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(1);
    clearInterval(any.pollTimer);
    any.pollTimer = null;
  });
});

describe("轮询与链路恢复", () => {
  it("pollAllDevices:未注册 / 无队列 / 未激活 / 索引为负 / 正在推进 一律跳过", async () => {
    const { any, player } = mkQC("d1");
    const noQ = mkQC("d2", { items: null });
    const idle = mkQC("d3", { isActive: false });
    const neg = mkQC("d4", { currentIndex: -1 });
    const busy = mkQC("d5");
    busy.any.advancing.add("d5");

    for (const q of [any, noQ.any, idle.any, neg.any, busy.any]) await q.pollAllDevices(() => "http://b");

    expect(player.pollState).toHaveBeenCalledTimes(1);
    expect(noQ.player.pollState).not.toHaveBeenCalled();
    expect(idle.player.pollState).not.toHaveBeenCalled();
    expect(neg.player.pollState).not.toHaveBeenCalled();
    expect(busy.player.pollState).not.toHaveBeenCalled();
  });

  it("pollAllDevices:上报真实状态;position=0 不写入 lastPos", async () => {
    const { any, ctrl, player } = mkQC("d1");
    player.pollState.mockResolvedValue({ playerId: "dlna:d1", playbackState: PlaybackState.PLAYING, position: 0, duration: 200, updatedAt: Date.now() });
    await any.pollAllDevices(() => "http://b");
    expect(ctrl.reportState).toHaveBeenCalledTimes(1);
    expect(any.lastPos.has("d1")).toBe(false);   // 0 不算「最后位置」
  });

  it("pollAllDevices:pollState 抛错 → 只记日志,不影响其它设备", async () => {
    const { any, player } = mkQC("d1");
    player.pollState.mockRejectedValue(new Error("RPC 超时"));
    await expect(any.pollAllDevices(() => "http://b")).resolves.toBeUndefined();
  });

  it("resumeAfterLinkRecovery:队列没了 → 直接清掉记录", async () => {
    const { any } = mkQC("d1", { items: null });
    any.linkLost.set("d1", { pos: 30, at: Date.now(), reason: "x" });
    await any.resumeAfterLinkRecovery("d1");
    expect(any.linkLost.has("d1")).toBe(false);
  });

  it("resumeAfterLinkRecovery:设备还没回来 → 保留记录,等下一拍", async () => {
    const { any } = mkQC("d1");
    any.linkLost.set("d1", { pos: 30, at: Date.now(), reason: "子进程重启" });
    H.isAvailable = false;
    await any.resumeAfterLinkRecovery("d1");
    expect(any.linkLost.has("d1")).toBe(true);
    expect(H.log).not.toContain("playMedia:dlna:d1:s1");
  });

  it("resumeActive:未激活 / 设备未注册 / 正在推进 一律不动作", async () => {
    const a = mkQC("d1", { isActive: false });
    const b = mkQC("d1", { isActive: false, ended: true });   // 播完后 isActive 必然为 false
    const c = mkQC("d1");
    c.any.players.delete("d1");
    const d = mkQC("d1");
    d.any.advancing.add("d1");
    for (const h of [a, b, c, d]) await h.qc.resumeActive("dlna:d1", "http://b");
    expect(H.log.filter((l) => l.startsWith("playMedia"))).toEqual([]);
  });

  it("resumeActive:正常 → 重投当前首并重算预探测窗口", async () => {
    const { qc, any } = mkQC("d1");
    const probe = vi.fn();
    any.schedulePreProbe = probe;
    await qc.resumeActive("dlna:d1", "http://b");
    expect(H.log).toContain("playMedia:dlna:d1:s1");
    expect(probe).toHaveBeenCalledWith("d1");
    expect(any.advancing.has("d1")).toBe(false);
  });
});

describe("idle_early / frozen 的复查分支", () => {
  it("idle_early 落在 seek 冷静期内 → 按重定位真空撤销", async () => {
    const { qc, ctrl, any } = mkQC("d1");
    await qc.transport("dlna:d1", "seek", 30);      // 打标冷静期
    await qc.handleDecision("idle_early", "dlna:d1");
    expect(ctrl.resetTracker).toHaveBeenCalledWith("dlna:d1");
    expect(any.queues.get("d1").currentIndex).toBe(0);   // 没切歌
  });

  it("idle_early 复查到 PLAYING → 误报,撤销且不切歌", async () => {
    const { qc, player, ctrl } = mkQC("d1");
    player.pollState.mockResolvedValue({ playerId: "dlna:d1", playbackState: PlaybackState.PLAYING, position: 12, duration: 200, updatedAt: Date.now() });
    await qc.handleDecision("idle_early", "dlna:d1");
    expect(ctrl.resetTracker).toHaveBeenCalledWith("dlna:d1");
    expect(H.log.filter((l) => l.startsWith("playMedia"))).toEqual([]);
  });

  it("idle_early 复查抛错 → 按真结束处理(放行切歌)", async () => {
    const { qc, player, any } = mkQC("d1");
    player.pollState.mockRejectedValue(new Error("RPC 超时"));
    await qc.handleDecision("idle_early", "dlna:d1");
    expect(any.queues.get("d1").currentIndex).toBe(1);
    expect(H.log).toContain("playMedia:dlna:d1:s2");
  });

  it("frozen 复查抛错 → 落到就地重投(恢复第 1 次)", async () => {
    const { qc, player, any } = mkQC("d1");
    any.lastPos.set("d1", 100);
    player.pollState.mockRejectedValue(new Error("RPC 超时"));
    player.seek.mockRejectedValue(new Error("设备不支持 seek"));
    await qc.handleDecision("frozen", "dlna:d1");
    // 位置拉回失败不阻断:至少重投当前首
    expect(H.log).toContain("playMedia:dlna:d1:s1");
    expect(any.queues.get("d1").currentIndex).toBe(0);
  });

  it("stalled 复查抛错 → 不中断,继续走重投/切歌", async () => {
    const { qc, player, any } = mkQC("d1");
    player.pollState.mockRejectedValue(new Error("RPC 超时"));
    await qc.handleDecision("stalled", "dlna:d1");
    // 复查失败不构成「确认在播」→ 落到连续卡死计数并重投当前首
    expect(any.stallCounters.get("d1")).toEqual({ songId: "s1", count: 1 });
    expect(H.log).toContain("playMedia:dlna:d1:s1");
  });

  it("recoverInPlace:位置在开头 → 重投但无需校准 seek", async () => {
    const { any, player } = mkQC("d1");
    await any.recoverInPlace("d1", 0);
    expect(H.log).toContain("playMedia:dlna:d1:s1");
    expect(player.seek).not.toHaveBeenCalled();
  });
});

describe("队列推进的边角(next / prev / removeAt / reorder)", () => {
  it("prev:order 模式游标 > 0 → 上一首", async () => {
    const { qc, any } = mkQC("d1", { currentIndex: 2 });
    await qc.prev("dlna:d1", "http://b");
    expect(any.queues.get("d1").currentIndex).toBe(1);
  });

  it("prev:all 模式在首曲 → 绕回末曲", async () => {
    const { qc, any } = mkQC("d1", { currentIndex: 0, playMode: "all" });
    await qc.prev("dlna:d1", "http://b");
    expect(any.queues.get("d1").currentIndex).toBe(2);
    expect(H.log).toContain("playMedia:dlna:d1:s3");
  });

  it("removeAt:删当前项 → 续播同下标的下一首", async () => {
    const { qc, any } = mkQC("d1");
    qc.removeAt("dlna:d1", 0, "http://b");
    await flush();
    const q = any.queues.get("d1");
    expect(q.items.map((i: Any) => i.songId)).toEqual(["s2", "s3"]);
    expect(q.currentIndex).toBe(0);
    expect(H.log).toContain("playMedia:dlna:d1:s2");
  });

  it("removeAt:删当前项且下标越界 → 游标收到末位", async () => {
    const { qc, any } = mkQC("d1", { currentIndex: 2 });
    qc.removeAt("dlna:d1", 2, "http://b");
    await flush();
    expect(any.queues.get("d1").currentIndex).toBe(1);
  });

  it("removeAt:删当前项且删空 → 队列结束", async () => {
    const { qc, any } = mkQC("d1", { items: [{ songId: "s1", title: "t", mime: "audio/mpeg" }] });
    qc.removeAt("dlna:d1", 0, "http://b");
    await flush();
    const q = any.queues.get("d1");
    expect(q.items).toEqual([]);
    expect(q.currentIndex).toBe(-1);
    expect(q.isActive).toBe(false);
    expect(q.ended).toBe(true);
  });

  it("removeAt:删当前项之前的项 → 游标左移一位", async () => {
    const { qc, any } = mkQC("d1", { currentIndex: 2 });
    qc.removeAt("dlna:d1", 0, "http://b");
    await flush();
    expect(any.queues.get("d1").currentIndex).toBe(1);
  });

  it("removeAt:删当前项之后的项 → 游标不动", async () => {
    const { qc, any } = mkQC("d1");
    qc.removeAt("dlna:d1", 2, "http://b");
    await flush();
    expect(any.queues.get("d1").currentIndex).toBe(0);
    expect(any.queues.get("d1").items).toHaveLength(2);
  });

  it("reorder:搬移后当前曲下标跟随到新位置", async () => {
    const { qc, any } = mkQC("d1", { currentIndex: 0 });
    qc.reorder("dlna:d1", 0, 2);
    const q = any.queues.get("d1");
    expect(q.items.map((i: Any) => i.songId)).toEqual(["s2", "s3", "s1"]);
    expect(q.currentIndex).toBe(2);
  });

  it("reorder:越界 / 原地 一律 no-op", async () => {
    const { qc, any } = mkQC("d1");
    const before = any.queues.get("d1").items.map((i: Any) => i.songId);
    qc.reorder("dlna:d1", 5, 0);
    qc.reorder("dlna:d1", 0, 5);
    qc.reorder("dlna:d1", -1, 0);
    qc.reorder("dlna:d1", 1, 1);
    expect(any.queues.get("d1").items.map((i: Any) => i.songId)).toEqual(before);
  });

  it("reorder:shuffle 模式下显式重建序列", async () => {
    const { qc, any } = mkQC("d1", { playMode: "shuffle" });
    qc.reorder("dlna:d1", 2, 0);
    const q = any.queues.get("d1");
    expect(q.shuffleLen).toBe(3);
    expect(q.shuffleOrder).toHaveLength(3);
    expect(q.shufflePos).toBe(0);            // 当前曲固定在序列头
  });
});

describe("flow 会话(连续流)", () => {
  it("setFlowOwned / isFlowOwned:含前缀剥离", () => {
    const { qc } = mkQC("d1");
    expect(qc.isFlowOwned("dlna:d1")).toBe(false);
    qc.setFlowOwned("group:d1", true);
    expect(qc.isFlowOwned("d1")).toBe(true);
    expect(qc.isFlowOwned("group:d1")).toBe(true);
    qc.setFlowOwned("d1", false);
    expect(qc.isFlowOwned("d1")).toBe(false);
  });

  it("flowAdvance:越界忽略,同下标且未结束忽略", () => {
    const { qc, any } = mkQC("d1");
    const seen: Any[] = [];
    qc.on("queue_changed", (id: string) => seen.push(id));
    any.schedulePreProbe = vi.fn();
    qc.flowAdvance("dlna:d1", 9);              // 越界 → 忽略
    qc.flowAdvance("dlna:d1", -1);             // 越界 → 忽略
    qc.flowAdvance("dlna:d1", 0);              // 同下标且未结束 → 忽略
    expect(seen).toEqual([]);
    qc.flowAdvance("dlna:d1", 2);              // 静默推进
    expect(any.queues.get("d1").currentIndex).toBe(2);
    expect(seen).toEqual(["d1"]);
    expect(any.schedulePreProbe).toHaveBeenCalledWith("d1");
  });

  it("flowAdvance:队列不存在的目标一律忽略", () => {
    const { qc, any } = mkQC("d1", { items: null });
    expect(() => qc.flowAdvance("dlna:d1", 0)).not.toThrow();
    expect(any.queues.has("d1")).toBe(false);
  });

  it("handleDecision:flow 驱动下吞掉 advance/track_changed/idle_early,但仍处理 ended", async () => {
    const { qc, any } = mkQC("d1");
    qc.setFlowOwned("d1", true);
    await qc.handleDecision("advance", "dlna:d1");
    await qc.handleDecision("track_changed", "dlna:d1");
    await qc.handleDecision("idle_early", "dlna:d1");
    expect(H.log.filter((l) => l.startsWith("playMedia"))).toEqual([]);
    expect(any.queues.get("d1").currentIndex).toBe(0);
    // ended 不吞:流自然结束仍要标记播放结束,否则 UI 永远停在「播放中」
    await qc.handleDecision("ended", "dlna:d1");
    expect(any.queues.get("d1").ended).toBe(true);
    expect(any.queues.get("d1").isActive).toBe(false);
  });
});

describe("服务器端定时暂停(sleep timer)", () => {
  it("setSleepTimer:到点暂停;remaining 递减;clear 取消", async () => {
    vi.useFakeTimers();
    const { qc, player } = mkQC("d1");
    qc.setSleepTimer("dlna:d1", 60_000);
    expect(qc.sleepTimerRemaining("dlna:d1")).toBeCloseTo(60_000, -2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(qc.sleepTimerRemaining("dlna:d1")).toBeNull();   // 到点后记录自清
  });

  it("setSleepTimer:重复调用重置为新时长;clear 后不再触发", async () => {
    vi.useFakeTimers();
    const { qc, player } = mkQC("d1");
    qc.setSleepTimer("dlna:d1", 60_000);
    qc.setSleepTimer("dlna:d1", 120_000);     // 旧的被清掉,换成新时长
    qc.clearSleepTimer("dlna:d1");
    await vi.advanceTimersByTimeAsync(200_000);
    expect(player.pause).not.toHaveBeenCalled();
    expect(qc.sleepTimerRemaining("dlna:d1")).toBeNull();
  });

  it("sleepTimerRemaining:未设置 → null;pause 失败只记日志", async () => {
    vi.useFakeTimers();
    const player = mkPlayer("dlna:d1", { pause: vi.fn(async () => { throw new Error("设备离线"); }) });
    const { qc } = mkQC("d1", { player });
    expect(qc.sleepTimerRemaining("dlna:nobody")).toBeNull();
    qc.setSleepTimer("dlna:d1", 1000);
    await vi.advanceTimersByTimeAsync(1000);   // 不抛
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it("clearSleepTimer:从未设置也不抛", () => {
    const { qc } = mkQC("d1");
    expect(() => qc.clearSleepTimer("dlna:d1")).not.toThrow();
  });
});

describe("组:追踪重置 / 结束抑制 / 组归属 / 成员重入", () => {
  it("resetGroupTracker:按裸 id 找到 ctrl 并用 group:<id> 复位", () => {
    const { qc, ctrl } = mkQC("g1");
    qc.resetGroupTracker("group:g1");
    expect(ctrl.resetTracker).toHaveBeenCalledWith("group:g1");
  });

  it("resetGroupTracker:未注册的组 → 不抛", () => {
    const { qc } = mkQC("g1", { items: null });
    expect(() => qc.resetGroupTracker("group:nope")).not.toThrow();
  });

  it("activeGroupOfDevice:取第一个「队列处于激活态」的所属组", () => {
    const { qc, any } = mkQC("devA", { items: null });
    H.deviceGroups.set("devA", ["g-idle", "g-live"]);
    H.groups.set("g-idle", { id: "g-idle" });
    H.groups.set("g-live", { id: "g-live" });
    any.queues.set("g-idle", { items: [], currentIndex: -1, playMode: "shuffle", isActive: false, ended: false });
    any.queues.set("g-live", { items: [], currentIndex: -1, playMode: "shuffle", isActive: true, ended: false });
    expect(qc.activeGroupOfDevice("devA")).toBe("g-live");
  });

  it("handleDecision:组内还有在线成员 → 正常标记结束", async () => {
    const { qc, any } = mkQC("g1");
    H.groups.set("g1", { id: "g1" });
    H.groupOnline.set("g1", true);
    await qc.handleDecision("ended", "group:g1");
    expect(any.queues.get("g1").ended).toBe(true);
  });

  it("handleDecision:组内成员全离线 → 抑制结束(保留队列给看门狗)", async () => {
    const { qc, any } = mkQC("g1");
    H.groups.set("g1", { id: "g1" });
    H.groupOnline.set("g1", false);
    await qc.handleDecision("ended", "group:g1");
    expect(any.queues.get("g1").ended).toBe(false);
    expect(any.queues.get("g1").isActive).toBe(true);
  });

  it("rejoinMembers:组队列未激活 / 无当前曲 → 静默", async () => {
    const a = mkQC("g1", { isActive: false });
    const b = mkQC("g1", { currentIndex: -1 });
    await a.qc.rejoinMembers("group:g1", ["devA"]);
    await b.qc.rejoinMembers("group:g1", ["devA"]);
    expect(H.log).toEqual([]);
  });

  it("rejoinMembers:无在线新成员 → 静默", async () => {
    const { qc } = mkQC("g1");
    H.devices.set("devA", { id: "devA", available: false });
    await qc.rejoinMembers("group:g1", ["devA"]);
    expect(H.alignTargets).toEqual([]);
  });

  it("rejoinMembers:新成员对齐到 leader 进度,并在组暂停时同步暂停", async () => {
    const { qc, any } = mkQC("g1");
    H.devices.set("devA", { id: "devA", available: true });
    H.groupStatus = { position: 42, state: "PAUSED_PLAYBACK" };
    H.alignResult = 41;
    any.queues.set("devA", { items: [{ songId: "x", title: "x", mime: "audio/mpeg" }], currentIndex: 0, playMode: "order", isActive: true, ended: false });
    const changed: Any[] = [];
    qc.on("queue_changed", (id: string) => changed.push(id));

    await qc.rejoinMembers("group:g1", ["devA"]);

    // 对齐时用的是 leader 的实时位置(经 getTargetSec 回调取到)
    expect(H.alignTargets).toEqual([{ deviceId: "devA", position: 42 }]);
    expect(H.log).toContain("playMedia:dlna:devA:s1");
    expect(H.log).toContain("pause:dlna:devA");
    // 组激活期间成员的个人队列被标记为不激活(保留 items)
    expect(any.queues.get("devA").isActive).toBe(false);
    expect(changed).toContain("devA");
  });

  it("rejoinMembers:组状态查询失败 → 回退 position=0 继续对齐", async () => {
    const { qc } = mkQC("g1");
    H.devices.set("devA", { id: "devA", available: true });
    H.groupStatusThrows = true;
    await qc.rejoinMembers("group:g1", ["devA"]);
    expect(H.log).toContain("playMedia:dlna:devA:s1");
    expect(H.alignTargets).toEqual([]);   // position=0 → 不需要校准 seek
  });

  it("rejoinMembers:单个成员对齐失败被吞掉,不影响其它成员", async () => {
    const { qc } = mkQC("g1");
    H.devices.set("bad", { id: "bad", available: true });
    H.devices.set("good", { id: "good", available: true });
    H.groupStatus = { position: 30, state: "PLAYING" };
    H.badDevices.add("bad");

    await expect(qc.rejoinMembers("group:g1", ["bad", "good"])).resolves.toBeUndefined();

    expect(H.log).toContain("playMedia:dlna:good:s1");
    expect(H.log).toContain("align:good:30");
    expect(H.log.some((l) => l.includes("dlna:bad"))).toBe(false);
  });
});

describe("判源(judgePlayable)", () => {
  it("负缓存 → 直接跳过(零成本热路径)", async () => {
    const { any } = mkQC("d1", { raw: true });
    H.cachedPlayability = "unplayable";
    await expect(any.judgePlayable({ songId: "s1" })).resolves.toBe("skip");
  });

  it("正缓存 + 直链复核未死 → 照常播", async () => {
    const { any } = mkQC("d1", { raw: true });
    H.cachedPlayability = "playable";
    H.recheck = "ok";
    await expect(any.judgePlayable({ songId: "s1" })).resolves.toBe("play");
  });

  it("正缓存 + 直链已死 + 有替代源 → 逐出缓存后照常播", async () => {
    const { any } = mkQC("d1", { raw: true });
    H.cachedPlayability = "playable";
    H.recheck = "gone";
    H.ensureStream = true;
    await expect(any.judgePlayable({ songId: "s1" })).resolves.toBe("play");
    expect(H.evicted).toEqual(["s1"]);
  });

  it("正缓存 + 直链已死 + 无替代源 → 跳过(知识而非猜测)", async () => {
    const { any } = mkQC("d1", { raw: true });
    H.cachedPlayability = "playable";
    H.recheck = "gone";
    H.ensureStream = false;
    await expect(any.judgePlayable({ songId: "s1" })).resolves.toBe("skip");
    expect(H.evicted).toEqual(["s1"]);
  });

  it("无缓存 + 曲库无此行 → 放行(不把「不知道」当「死的」)", async () => {
    const { any } = mkQC("d1", { raw: true });
    H.cachedPlayability = null;
    await expect(any.judgePlayable({ songId: "no-such-song" })).resolves.toBe("play");
  });

  it("无缓存 + 统一裁决给出可播行 → 放行", async () => {
    const { any } = mkQC("d1", { raw: true });
    seedSong("judge-a");
    H.resolvedRow = { id: "judge-a" };
    await expect(any.judgePlayable({ songId: "judge-a" })).resolves.toBe("play");
  });

  it("无缓存 + 裁决确定为无源(definitive)→ 跳过", async () => {
    const { any } = mkQC("d1", { raw: true });
    seedSong("judge-b");
    H.resolvedRow = { row: null, definitive: true, reason: "本地文件已删" };
    await expect(any.judgePlayable({ songId: "judge-b" })).resolves.toBe("skip");
  });

  it("无缓存 + 裁决不确定 + 缓存转为不可播 → 跳过;否则进宽容尾巴放行", async () => {
    const { any } = mkQC("d1", { raw: true });
    seedSong("judge-c");
    H.resolvedRow = { row: null, definitive: false, reason: "网络抖动" };
    H.cachedPlayability = "unplayable";
    await expect(any.judgePlayable({ songId: "judge-c" })).resolves.toBe("skip");
    H.cachedPlayability = null;
    await expect(any.judgePlayable({ songId: "judge-c" })).resolves.toBe("play");
  });

  it("读库异常 → 放行(判源失败绝不把歌判死)", async () => {
    const { any } = mkQC("d1", { raw: true });
    H.cachedPlayability = null;
    vi.spyOn(db, "select").mockImplementation(() => { throw new Error("db down"); });
    await expect(any.judgePlayable({ songId: "s1" })).resolves.toBe("play");
  });

  it("playCurrent 整队无源 → 报告枯竭且停在原处(不摘除、不空转)", async () => {
    const { any } = mkQC("d1");
    any.judgePlayable = async () => "skip";
    any.reportAllUnplayable = vi.fn();
    await any.playCurrent("d1", "http://b");
    expect(any.reportAllUnplayable).toHaveBeenCalledWith("d1");
    expect(any.queues.get("d1").items).toHaveLength(3);   // 留队列
  });
});

describe("队列项元数据补全与落库", () => {
  it("resolveItem:只带 songId 的项 → 补全 title/mime/专辑信息", async () => {
    const { qc } = mkQC("d1", { items: null, raw: true });
    db.insert(albums).values({ id: "alb-1", name: "专辑", artist: "专辑艺术家", year: 1999, genre: "Rock" }).run();
    seedSong("ri-1", { albumId: "alb-1", artist: "曲目艺术家", track: 3, discNumber: 1 });
    const full = await qc.resolveItem({ songId: "ri-1" });
    expect(full.title).toBe("t-ri-1");
    expect(full.mime).toBe("audio/mpeg");
    expect(full.artist).toBe("曲目艺术家");
    expect(full.albumArtist).toBe("专辑艺术家");
    expect(full.year).toBe(1999);
    expect(full.duration).toBe(120);
  });

  it("resolveItem:已有 title+mime → 原样返回(不查库)", async () => {
    const { qc } = mkQC("d1", { items: null, raw: true });
    const it = { songId: "x", title: "t", mime: "audio/mpeg" };
    await expect(qc.resolveItem(it)).resolves.toBe(it);
  });

  it("resolveItem:读库异常 → 原样返回(起播不能被元数据补全卡死)", async () => {
    const { qc } = mkQC("d1", { items: null, raw: true });
    const it = { songId: "x" };
    vi.spyOn(db, "select").mockImplementation(() => { throw new Error("db down"); });
    await expect(qc.resolveItem(it)).resolves.toBe(it);
  });

  it("persist:组队列写 group_queues,设备队列写 device_queues", () => {
    const { qc, any } = mkQC("g1", { raw: true });
    H.groups.set("g1", { id: "g1" });
    qc.setPlayMode("g1", "all");
    const gRow = sqlite.prepare("SELECT * FROM group_queues WHERE group_id = ?").get("g1") as Any;
    expect(gRow).toBeTruthy();
    expect(gRow.play_mode).toBe("all");
    expect(JSON.parse(gRow.items_json)).toHaveLength(3);

    const dev = mkQC("d9", { raw: true });
    dev.qc.setPlayMode("d9", "one");
    const dRow = sqlite.prepare("SELECT * FROM device_queues WHERE device_id = ?").get("d9") as Any;
    expect(dRow).toBeTruthy();
    expect(dRow.play_mode).toBe("one");
    void any;
  });

  it("loadFromDb:设备/组队列都按裸 id 装入,坏 JSON 行跳过", () => {
    sqlite.prepare("INSERT OR REPLACE INTO device_queues (device_id, items_json, current_index, play_mode, is_active) VALUES (?,?,?,?,?)")
      .run("ld-d1", JSON.stringify([{ songId: "a" }, { songId: "b" }]), 1, "all", 1);
    sqlite.prepare("INSERT OR REPLACE INTO device_queues (device_id, items_json, current_index, play_mode, is_active) VALUES (?,?,?,?,?)")
      .run("ld-bad", "{ 不是 JSON", 0, "order", 1);
    sqlite.prepare("INSERT OR REPLACE INTO group_queues (group_id, items_json, current_index, play_mode, is_active) VALUES (?,?,?,?,?)")
      .run("ld-g1", JSON.stringify([{ songId: "g" }]), 0, "shuffle", 0);

    const qc = new QueueController();
    qc.loadFromDb();

    expect(qc.snapshot("ld-d1")).toMatchObject({ currentIndex: 1, playMode: "all", isActive: true });
    expect(qc.snapshot("ld-d1").items).toHaveLength(2);
    expect(qc.snapshot("ld-bad").items).toEqual([]);          // 坏行被跳过,不抛
    expect(qc.snapshot("ld-g1")).toMatchObject({ playMode: "shuffle", isActive: false });
    expect(qc.snapshot("ld-g1").ended).toBe(false);           // 旧表无此列,默认 false
  });

  it("activeDevices:只列「激活且非空」的队列", () => {
    const { qc, any } = mkQC("d1");
    any.queues.set("d2", { items: [{ songId: "x" }], currentIndex: 0, playMode: "order", isActive: false, ended: true });
    any.queues.set("d3", { items: [], currentIndex: -1, playMode: "order", isActive: true, ended: false });
    const list = qc.activeDevices();
    expect(list.map((x) => x.deviceId)).toEqual(["d1"]);
    expect(list[0].snapshot.items).toHaveLength(3);
  });
});

describe("预探测回调守卫", () => {
  it("预探测状态变化:只为本控制器持有的队列广播 queue_changed", () => {
    const qc = new QueueController();
    const any = qc as Any;
    any.players.set("d1", mkPlayer("dlna:d1"));
    any.queues.set("d1", { items: [{ songId: "s1" }], currentIndex: 0, playMode: "order", isActive: true, ended: false });
    const seen: Any[] = [];
    qc.on("queue_changed", (id: string) => seen.push(id));

    expect(H.onChange).toHaveLength(1);
    const cb = H.onChange[0];
    cb("d1");                                        // 本控制器持有 → 广播
    cb("local:u1:tab-abc");                          // 本机链路 → 绝不从这里发(clientId 不出服务端)
    expect(seen).toEqual(["d1"]);
  });
});
