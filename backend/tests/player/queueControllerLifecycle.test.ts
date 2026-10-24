// ==================== QueueController 生命周期面(注册注销 / 冻结复活 / 追加 / 链路恢复) ====================
//
// 与既有两个文件的分工:
//   · QueueController.test.ts —— 决策面主路径(advance / ended / stalled / shuffle 回退);
//   · queueControllerOps.test.ts —— 操作面(注册、transport、CRUD、flow、sleep timer、判源、落库)。
//
// 本文件补的是**生命周期语义**这条缝:一个队列从「起播 → 被按停 → 再点播放」、
// 「关掉某类协议就零残留」、「追加队列不打断当前播放」、「链路断了回来就地续播」。
// 这些是用户每天都会撞到的状态机边界;每个用例自建 QueueController 与假体,
// 彼此不共享可变状态,可在 shuffle 下任意顺序重复跑。
//
// 外部副作用面(协议 player 创建、组管理、播放目标判据、预探测调度器、在线源判定)
// 全部换成假体 —— 不触网、不碰真设备、不落真实曲库。
// MUST be the first import:把 DATA_DIR 指到本文件专属的隔离目录。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

type Any = any;

const H = vi.hoisted(() => ({
  // ---- 播放目标判据 ----
  playable: true,
  // ---- 协议 player 可用性(resumeAfterLinkRecovery 会先问一句"设备回来了吗") ----
  isAvailable: true,
  // ---- PlayerController 替身(register* 会取它当 ctrl) ----
  pc: null as Any,
  // ---- 调用轨迹 ----
  log: [] as string[],
}));

// 协议 player 的创建全部换成假体:真货会去建 DLNA SOAP / RAOP / sendspin 会话。
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
      return { playerId: pid, playbackState: "IDLE", position: 0, duration: 0, updatedAt: Date.now() };
    },
    isAvailable: async () => H.isAvailable,
  };
}

vi.mock("../../src/services/dlna/control.js", () => ({
  createDlnaProtocolPlayer: (deviceId: string) => mkProto(`dlna:${deviceId}`),
  getEffectiveBaseUrl: () => "http://eff",
  clearCurrentMedia: (id: string) => { H.log.push(`clearMedia:${id}`); },
  getDevice: () => undefined,
  alignDeviceToPosition: async () => 0,
}));

vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({ get: () => undefined, groupsOfDevice: () => [], list: () => [], resolveMemberStates: () => [] }),
}));

vi.mock("../../src/services/group/protocolPlayer.js", () => ({
  createGroupProtocolPlayer: (groupId: string) => mkProto(`group:${groupId}`),
  getGroupStatus: async () => ({ position: 0, state: "STOPPED" }),
  hasOnlineMember: () => true,
}));

vi.mock("../../src/services/airplay/protocolPlayer.js", () => ({
  createAirPlayProtocolPlayer: (deviceId: string) => mkProto(`airplay:${deviceId}`),
}));

vi.mock("../../src/services/sendspin/protocolPlayer.js", () => ({
  createSendspinProtocolPlayer: (clientId: string) => mkProto(`sendspin:${clientId}`),
}));

vi.mock("../../src/services/playTarget.js", () => ({
  checkPlayTarget: () => (H.playable ? { playable: true } : { playable: false, reason: "不可播" }),
}));

vi.mock("../../src/services/player/preProbeScheduler.js", () => ({
  getPreProbeScheduler: () => ({
    addOnChange: () => {},
    schedule: () => {},
    clear: () => {},
    clearCooldown: () => {},
    markAllUnplayable: () => {},
    status: () => ({ ready: 0, scanned: 0, misses: 0, exhausted: false, cooldownUntil: null, at: 0 }),
  }),
}));

vi.mock("../../src/services/player/index.js", () => ({
  getPlayerController: () => H.pc,
  getQueueController: () => H.pc,
  wirePlayerQueueControllers: () => {},
}));

vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  getCachedPlayability: () => null,
  recheckOnlineDirect: async () => "ok",
  evictStreamFallbackCache: () => {},
  ensurePlayableStream: async () => true,
}));

vi.mock("../../src/services/source/resolveAudio.js", () => ({
  resolvePlayableRow: async () => ({ row: { id: "x" }, definitive: false, reason: "" }),
}));

import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import { initDatabase } from "../../src/db/index.js";
import { clearSeekSettle } from "../../src/services/player/seekSettle.js";

/** UniversalPlayer 替身:只暴露 QueueController 真正读到的面。 */
function mkPlayer(pid: string, over: Any = {}): Any {
  return {
    playerId: pid,
    name: "p",
    playMedia: vi.fn(async (item: Any) => { H.log.push(`playMedia:${pid}:${item.songId}`); return { mediaUri: `uri:${pid}` }; }),
    stop: vi.fn(async () => { H.log.push(`stop:${pid}`); }),
    pause: vi.fn(async () => { H.log.push(`pause:${pid}`); }),
    resume: vi.fn(async () => { H.log.push(`resume:${pid}`); }),
    seek: vi.fn(async (s: number) => { H.log.push(`seek:${pid}:${s}`); }),
    setVolume: vi.fn(async (v: number) => { H.log.push(`volume:${pid}:${v}`); }),
    pollState: vi.fn(async () => ({
      playerId: pid, playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now(),
    })),
    getProtocol: () => ({ isAvailable: async () => H.isAvailable }),
    ...over,
  };
}

function mkCtrl(): Any {
  return {
    beginOptimistic: vi.fn(),
    armOptimisticTimeout: vi.fn(),
    endOptimistic: vi.fn(),
    reportState: vi.fn(),
    resetTracker: vi.fn(),
    setExpectedDuration: vi.fn(),
  };
}

interface Opts {
  pid?: string;
  items?: Any[] | null;
  currentIndex?: number;
  playMode?: string;
  isActive?: boolean;
  ended?: boolean;
}

/** 每个用例一个全新 QueueController —— 内存账本零残留,用例之间互不影响。 */
function mkQC(dev = "d1", opts: Opts = {}) {
  const qc = new QueueController();
  const any = qc as Any;
  const pid = opts.pid ?? `dlna:${dev}`;
  const player = mkPlayer(pid);
  const ctrl = mkCtrl();
  H.pc = ctrl;
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
    });
  }
  // 判源 / 落库 / 预探测与生命周期语义无关,一律绕开(需要时用例自行覆盖)。
  any.isMemberOfActiveGroup = () => false;
  any.judgePlayable = async () => "play";
  any.persist = () => {};
  any.schedulePreProbe = () => {};
  return { qc, any, player, ctrl, pid };
}

/** 把挂起的微/宏任务跑完(resumeAfterLinkRecovery 是 void 调用的)。 */
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  H.log = [];
  H.playable = true;
  H.isAvailable = true;
  H.pc = null;
  // seekSettle 是模块级全局账本,跨用例必须清干净(否则 idle_early 会被陈旧标记压住)。
  for (const id of ["d1", "d2", "c1", "ap1"]) clearSeekSettle(id);
});

afterEach(() => {
  vi.useRealTimers();
});

// ==================== Sendspin 客户端的注册与注销 ====================

describe("Sendspin 客户端注册与注销(插件关闭零残留)", () => {
  it("registerSendspinDevice:裸 clientId 作 key,playerId 带 sendspin: 前缀并绑上协议", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerSendspinDevice("c1", "客厅小音箱");
    const up = any.players.get("c1");
    // 契约:QueueController 内部一律用裸 id 作 key(与路由/DB 一致),
    // 而 UniversalPlayer 自己持有带命名空间前缀的 playerId(与 PlayerController 一致)。
    expect(up.playerId).toBe("sendspin:c1");
    expect(up.name).toBe("客厅小音箱");
    expect(any.ctrls.get("c1")).toBeTruthy();
  });

  it("registerSendspinDevice:重复注册幂等(不覆盖已建立的连接)", () => {
    const { any } = mkQC("unused", { items: null });
    any.registerSendspinDevice("c1", "A");
    const first = any.players.get("c1");
    any.registerSendspinDevice("c1", "B");
    // 客户端重连不应把已注册的 player 换掉 —— 换掉会让正在播的会话失去句柄。
    expect(any.players.get("c1")).toBe(first);
    expect(first.name).toBe("A");
  });

  it("unregisterSendspinDevices:只摘 sendspin,DLNA/AirPlay 与它们的队列原样保留", () => {
    const { qc, any } = mkQC("d1");
    any.registerSendspinDevice("c1", "sv1");
    any.registerAirPlayDevice("ap1", "ap");
    qc.setQueue("c1", [{ songId: "x1", title: "t", mime: "audio/mpeg" }], 0, "http://eff");
    qc.setQueue("d1", [{ songId: "x2", title: "t", mime: "audio/mpeg" }], 0, "http://eff");

    qc.unregisterSendspinDevices();

    expect(any.players.has("c1")).toBe(false);
    expect(any.ctrls.has("c1")).toBe(false);
    expect(qc.snapshot("c1").items).toHaveLength(0);
    // 其它协议的播放器与队列不受影响(插件互相独立关闭)。
    expect(any.players.has("d1")).toBe(true);
    expect(any.players.has("ap1")).toBe(true);
    expect(qc.snapshot("d1").items).toHaveLength(1);
  });

  it("unregisterSendspinDevices:顺带取消该端的休眠定时(不留悬挂定时器)", () => {
    const { qc, any } = mkQC("unused", { items: null });
    any.registerSendspinDevice("c1", "sv1");
    qc.setQueue("c1", [{ songId: "x1", title: "t", mime: "audio/mpeg" }], 0, "http://eff");
    qc.setSleepTimer("c1", 60_000);
    expect(qc.sleepTimerRemaining("c1")).not.toBeNull();

    qc.unregisterSendspinDevices();
    // 播放器都没了还留着到点暂停的定时器 = 悬挂句柄,进程会被拖住。
    expect(qc.sleepTimerRemaining("c1")).toBeNull();
  });
});

// ==================== 停 / 复活 ====================

describe("deactivate —— 停用但保留队列", () => {
  it("只置 isActive=false,items 与游标原样保留(用户还能看见刚才听的列表)", () => {
    const { qc } = mkQC("d1", { currentIndex: 1 });
    qc.setFlowOwned("d1", true);
    const listener = vi.fn();
    qc.on("queue_changed", listener);

    qc.deactivate("d1");

    const snap = qc.snapshot("d1");
    expect(snap.isActive).toBe(false);
    expect(snap.items).toHaveLength(3);
    expect(snap.currentIndex).toBe(1);
    // 停投 → 进行中的 flow 会话作废(它的曲目列表已经不再被消费)。
    expect(qc.isFlowOwned("d1")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("未注册的播放器调 deactivate 不抛(路由可能对已下线的设备发指令)", () => {
    const { qc } = mkQC("unused", { items: null });
    expect(() => qc.deactivate("nope")).not.toThrow();
  });
});

describe("stopPlayback / resumePlayback —— 用户按停后原地续上", () => {
  it("stopPlayback:冻结推进但 ended 保持 false,并复位 tracker", () => {
    const { qc, ctrl } = mkQC("d1", { currentIndex: 1 });
    qc.stopPlayback("d1");
    const snap = qc.snapshot("d1");
    expect(snap.isActive).toBe(false);
    // 与「播完」的关键差别:ended=false ⇒ 这首是被按停的,不是放完的,
    // 随后 resumePlayback() 才能原地续上。
    expect(snap.ended).toBe(false);
    expect(snap.currentIndex).toBe(1);
    // resetTracker 用带前缀的完整 playerId(PlayerController 的 key 口径)。
    expect(ctrl.resetTracker).toHaveBeenCalledWith("dlna:d1");
  });

  it("stopPlayback:队列本来就没激活也要复位 tracker(清掉残留迁移,避免下次起播立刻 advance)", () => {
    const { qc, ctrl } = mkQC("d1", { isActive: false });
    qc.stopPlayback("d1");
    expect(ctrl.resetTracker).toHaveBeenCalledWith("dlna:d1");
    expect(qc.snapshot("d1").isActive).toBe(false);
  });

  it("resumePlayback:被按停的队列复活(同一首,游标不动)", () => {
    const { qc, player } = mkQC("d1", { currentIndex: 1 });
    qc.stopPlayback("d1");
    const before = qc.snapshot("d1");
    qc.resumePlayback("d1");
    const after = qc.snapshot("d1");
    expect(after.isActive).toBe(true);
    // 复活只是解冻自动推进,不重新投屏 —— 由下一拍决策/用户操作触发。
    expect(after.currentIndex).toBe(before.currentIndex);
    expect(player.playMedia).not.toHaveBeenCalled();
  });

  it("resumePlayback:自然播完(ended)的队列不复活", () => {
    const { qc, any } = mkQC("d1", { ended: true, isActive: false });
    qc.resumePlayback("d1");
    expect(any.queues.get("d1").isActive).toBe(false);
  });

  it("resumePlayback:空队列 / 无当前曲 不复活(没有可续的东西)", () => {
    const { qc, any } = mkQC("d1", { items: [], currentIndex: -1, isActive: false });
    qc.resumePlayback("d1");
    expect(any.queues.get("d1").isActive).toBe(false);
  });

  it("resumePlayback:已经激活的队列是 no-op(不重复广播)", () => {
    const { qc } = mkQC("d1", { isActive: true });
    const listener = vi.fn();
    qc.on("queue_changed", listener);
    qc.resumePlayback("d1");
    expect(listener).not.toHaveBeenCalled();
  });
});

// ==================== enqueue ====================

describe("enqueue —— 追加不打断", () => {
  it("空队列追加后自动起播第一首(队列从无到有,不需要再点一次播放)", async () => {
    const { qc, player } = mkQC("d1", { items: [], currentIndex: -1, isActive: false });
    await qc.enqueue("d1", [{ songId: "n1", title: "t", mime: "audio/mpeg" }], "http://eff");
    expect(player.playMedia).toHaveBeenCalledTimes(1);
    const snap = qc.snapshot("d1");
    expect(snap.currentIndex).toBe(0);
    expect(snap.isActive).toBe(true);
  });

  it("非空队列追加:只加在队尾,当前播放不受打扰", async () => {
    const { qc, player, any } = mkQC("d1", { currentIndex: 1 });
    await qc.enqueue("d1", [{ songId: "n1", title: "t", mime: "audio/mpeg" }], "http://eff");
    // 追加不能重投:正在播的那首不能被打断(听感 = 每次加歌都从头播)。
    expect(player.playMedia).not.toHaveBeenCalled();
    expect(any.queues.get("d1").items).toHaveLength(4);
    expect(qc.snapshot("d1").currentIndex).toBe(1);
  });
});

// ==================== next / setQueue 的边界 ====================

describe("next 与 setQueue 的边界", () => {
  it("next:order 模式播到末尾 → 标记结束而不是绕回开头", async () => {
    const { qc, player } = mkQC("d1", { currentIndex: 2, playMode: "order" });
    await qc.next("d1", "http://eff");
    // 顺序播放的队尾就是终点:绕回开头会让「播完了」的歌单永远停不下来。
    expect(player.playMedia).not.toHaveBeenCalled();
    expect(qc.snapshot("d1").ended).toBe(true);
    expect(qc.snapshot("d1").isActive).toBe(false);
  });

  it("setQueue:startIndex 越界被钳制到合法区间(不会把游标指到空处)", () => {
    const { qc } = mkQC("unused", { items: null });
    const items = [
      { songId: "a", title: "t", mime: "audio/mpeg" },
      { songId: "b", title: "t", mime: "audio/mpeg" },
    ];
    qc.setQueue("d1", items, 99, "http://eff");
    expect(qc.snapshot("d1").currentIndex).toBe(1);
    qc.setQueue("d1", items, -5, "http://eff");
    expect(qc.snapshot("d1").currentIndex).toBe(-1);
  });

  it("setQueue:contentContext 可写入、可读取、可清空", () => {
    const { qc } = mkQC("unused", { items: null });
    const items = [{ songId: "a", title: "t", mime: "audio/mpeg" }];
    // 来源标记决定「后台自动匹配跑完后能不能把新曲补进这条队列」;
    // 补错队列比不补更糟,故必须能在点播单曲时显式清空。
    qc.setQueue("d1", items, 0, "http://eff", "playlist:pl-1");
    expect(qc.getContentContext("d1")).toBe("playlist:pl-1");
    expect(qc.getContentContext("dlna:d1")).toBe("playlist:pl-1");
    qc.setQueue("d1", items, 0, "http://eff");
    expect(qc.getContentContext("d1")).toBeUndefined();
  });
});

// ==================== 轮询:链路丢失后回归就地续播 ====================

describe("pollAllDevices —— 链路从丢到通,就地续播当前首", () => {
  const st = (over: Any) => ({
    playerId: "dlna:d1", playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now(), ...over,
  });

  it("不可用的读数不入 tracker;恢复后把位置拉回离开处,而不是从头播", async () => {
    const { qc, any, player, ctrl } = mkQC("d1", { currentIndex: 0, playMode: "order" });

    // ① 正常一拍:记住设备上报的位置(这是「用户离开的地方」的唯一真相来源)。
    player.pollState = vi.fn(async () => st({ position: 30, duration: 200 }));
    await any.pollAllDevices(() => "");
    expect(ctrl.reportState).toHaveBeenCalledTimes(1);
    expect(any.lastPos.get("d1")).toBe(30);

    // ② 链路不可用(子进程僵死 / RPC 超时):只登记,绝不喂给 tracker,也不切歌。
    player.pollState = vi.fn(async () => st({ unavailable: true }));
    await any.pollAllDevices(() => "");
    expect(ctrl.reportState).toHaveBeenCalledTimes(1);
    expect(any.linkLost.get("d1").pos).toBe(30);
    expect(player.playMedia).not.toHaveBeenCalled();

    // ③ 链路恢复:这一拍的真实读数照常上报,并触发就地续播。
    player.pollState = vi.fn(async () => st({ position: 35, duration: 200 }));
    await any.pollAllDevices(() => "");
    expect(ctrl.reportState).toHaveBeenCalledTimes(2);
    await flush();

    // 续播围绕**当前这首**做:重投 s1,并把位置拉回离开处(减 1s 抵消 cast 启动开销)。
    expect(H.log).toContain("playMedia:dlna:d1:s1");
    expect(H.log).toContain("seek:dlna:d1:29");
    // 恢复后不再挂着「链路丢失」记录,否则下一拍会重复续播。
    expect(any.linkLost.has("d1")).toBe(false);
  });

  it("链路恢复时设备还没回来 → 保留记录,等下一拍(不投进不存在的连接)", async () => {
    const { qc, any, player } = mkQC("d1", { currentIndex: 0, playMode: "order" });
    player.pollState = vi.fn(async () => st({ position: 30, duration: 200 }));
    await any.pollAllDevices(() => "");
    player.pollState = vi.fn(async () => st({ unavailable: true }));
    await any.pollAllDevices(() => "");

    H.isAvailable = false; // 子进程刚起来,设备还没重新拨号入组
    player.pollState = vi.fn(async () => st({ position: 35, duration: 200 }));
    await any.pollAllDevices(() => "");
    await flush();

    expect(any.linkLost.has("d1")).toBe(true);
    expect(H.log).not.toContain("playMedia:dlna:d1:s1");
  });
});
