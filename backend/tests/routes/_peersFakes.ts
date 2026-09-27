// peers 域专用假体 —— 只在 `tests/routes/peersRoutesContract.test.ts` 里追加到
// `_sharedFakes.overrides` 之上使用(不修改 _sharedFakes,避免影响 dlna/sendspin/playlists)。
//
// 关键约束:peers.ts 同时 import 了**单例** `pm` / `gm`(它们在 shared.ts 里由
// `getPeerManager()` / `getGroupManager()` 在模块求值时生成)与这两个工厂函数。
// 只覆盖工厂不够 —— 已求值的单例仍是真实对象。故这里让
// `pm`/`gm`/`getPeerManager()`/`getGroupManager()` **全部指向同一个稳定假体对象**,
// 这样无论路由走哪条引用路径,看到的都是同一份可断言的状态。
import { vi } from "vitest";

export type Any = any;

/** 稳定的假管理器 —— 用方法级 vi.fn(),测试直接断言行参。 */
export const pm = {
  // 列表 / 注册 / 心跳 / 离线
  listWithQueues: vi.fn(() => [] as Any[]),
  registerLocal: vi.fn(() => ({ peerId: "local:u1:inst" }) as Any),
  heartbeat: vi.fn(() => true),
  markLocalOfflineByClient: vi.fn(),
  reportLocalStatus: vi.fn(() => ({ reportedAt: 1_700_000_000_000 }) as Any),
  // 队列快照 / 本机队列写入
  getQueueSnapshot: vi.fn(() => null as Any),
  localPlayFrom: vi.fn(),
  get: vi.fn(() => null as Any),
  localSetIndex: vi.fn(),
  localEnqueue: vi.fn(),
  localClear: vi.fn(),
  localRemoveAt: vi.fn(),
  localReorder: vi.fn(),
  localSetPlayMode: vi.fn(),
  reshuffleLocal: vi.fn(() => null as Any),
  // 本机状态上报
  clearLocalStatusReport: vi.fn(),
  getLocalStatusReport: vi.fn(() => null as Any),
  resolveMaskedLocalPeerId: vi.fn(() => null as Any),
  // 其它域复用(保持形状,免得被别的域测试间接依赖时炸)
  reconcileDlnaPeers: vi.fn(),
  removeDlnaPeer: vi.fn(),
};

export const gm = {
  setVolume: vi.fn(),
  get: vi.fn(() => null as Any),
  removeDeviceFromAllGroups: vi.fn(),
};

export const queueManager = {
  playFrom: vi.fn(async () => 0),
  jumpTo: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => undefined),
  clear: vi.fn(),
  deactivate: vi.fn(),
  removeAt: vi.fn(),
  reorder: vi.fn(),
  setPlayMode: vi.fn(),
  next: vi.fn(async () => undefined),
  prev: vi.fn(async () => undefined),
  setSleepTimer: vi.fn(),
  sleepTimerRemaining: vi.fn(() => 1_000 as Any),
  clearSleepTimer: vi.fn(),
};

export const queueController = {
  resumePlayback: vi.fn(),
  transport: vi.fn(async () => undefined),
  stopPlayback: vi.fn(),
  clear: vi.fn(),
  getPlayerState: vi.fn(async () => null as Any),
};

export const eventManager = {
  getEventState: vi.fn(() => null as Any),
  emitDeviceListChanged: vi.fn(),
};

/** 可被用例逐个改写的服务入口(出厂 = happy path)。 */
const DEFAULTS = {
  // ---- 设备传输 ----
  playDevice: async () => undefined,
  pauseDevice: async () => undefined,
  stopDevice: async () => undefined,
  seekDevice: async () => undefined,
  setDeviceVolume: async () => undefined,
  setDeviceMute: async () => undefined,
  getDeviceStatus: async () => ({ state: "idle", position: 0, duration: 0, volume: 0, muted: false }) as Any,
  getDlnaBaseUrl: () => "http://127.0.0.1:46400",
  getCurrentMedia: () => null as Any,
  refreshDevices: async () => [] as Any[],
  shouldRefreshDevices: () => false,

  // ---- airplay / group 状态 ----
  setAirPlayMuted: async () => undefined,
  getAirPlayPeerStatus: () => ({ state: "STOPPED", media: null }) as Any,
  getGroupStatus: async () => ({ state: "STOPPED", position: 0, duration: 0, volume: 0, muted: false }) as Any,
  getGroupLeaderDeviceId: () => null as Any,

  // ---- sendspin ----
  getSendspinFront: () => ({ currentMedia: () => null as Any }) as Any,
  getSendspinDeviceVolume: () => ({ volume: 100, muted: false }) as Any,
  setSendspinMemberMuted: async () => undefined,
  broadcastSendspinVolume: () => undefined,

  // ---- 播报 ----
  announceOnPeer: async () => ({ ok: true }) as Any,
  isAnnouncing: () => false,

  // ---- 流转 / 进度对齐 ----
  tryArmSendspinBorrow: async () => ({ armed: false, songId: null, positionSeconds: null }) as Any,
  borrowLandingConfirmed: async () => false,
  readPeerPositionSeconds: async () => null as Any,
  seekPeerToSeconds: async () => true,
  detachFromActiveGroups: async () => undefined,

  // ---- 杂项 ----
  countLiveConnections: () => 1,
  userIdOfLocalPeer: () => "u1" as Any,
  clientIdOfLocalPeer: () => "c1" as Any,
  decoratePeersForClient: () => [] as Any[],
  dispatchPeerCommand: () => ({ success: true, delivered: true }) as Any,
  markSeekIssued: () => undefined,
  localShuffleInfo: () => ({ epoch: 1, order: [] as number[], pos: -1, len: 0 }) as Any,
  canControlPeer: () => true,
  // decodePeerId 的真实实现会做「本机掩码 → 真实行」反查(依赖真实 pm 单例)。
  // 这里退化为直取 URL 参数:测试里用的都是 dlna:/group:/airplay:/sendspin:/local:<uid>
  // 这类直通形态,反查语义另有专项覆盖。
  decodePeerId: (c: Any) => decodeURIComponent(c.req.param("peerId") || ""),
};

type FnName = keyof typeof DEFAULTS;

export const fns = Object.fromEntries(
  Object.entries(DEFAULTS).map(([k, impl]) => [k, vi.fn(impl as Any)]),
) as Record<FnName, ReturnType<typeof vi.fn>>;

/** 管理器方法的出厂实现(与上面的 `pm`/`gm`/`queueManager`/`queueController`/`eventManager` 对应)。 */
const MANAGER_DEFAULTS: Array<[Any, string, Any]> = [
  [pm, "listWithQueues", () => [] as Any[]],
  [pm, "registerLocal", () => ({ peerId: "local:u1:inst" }) as Any],
  [pm, "heartbeat", () => true],
  [pm, "markLocalOfflineByClient", () => undefined],
  [pm, "reportLocalStatus", () => ({ reportedAt: 1_700_000_000_000 }) as Any],
  [pm, "getQueueSnapshot", () => null as Any],
  [pm, "localPlayFrom", () => undefined],
  [pm, "get", () => null as Any],
  [pm, "localSetIndex", () => undefined],
  [pm, "localEnqueue", () => undefined],
  [pm, "localClear", () => undefined],
  [pm, "localRemoveAt", () => undefined],
  [pm, "localReorder", () => undefined],
  [pm, "localSetPlayMode", () => undefined],
  [pm, "reshuffleLocal", () => null as Any],
  [pm, "clearLocalStatusReport", () => undefined],
  [pm, "getLocalStatusReport", () => null as Any],
  [pm, "resolveMaskedLocalPeerId", () => null as Any],
  [gm, "setVolume", () => undefined],
  [gm, "get", () => null as Any],
  [queueManager, "playFrom", async () => 0],
  [queueManager, "jumpTo", async () => undefined],
  [queueManager, "enqueue", async () => undefined],
  [queueManager, "clear", () => undefined],
  [queueManager, "deactivate", () => undefined],
  [queueManager, "removeAt", () => undefined],
  [queueManager, "reorder", () => undefined],
  [queueManager, "setPlayMode", () => undefined],
  [queueManager, "next", async () => undefined],
  [queueManager, "prev", async () => undefined],
  [queueManager, "setSleepTimer", () => undefined],
  [queueManager, "sleepTimerRemaining", () => 1_000 as Any],
  [queueManager, "clearSleepTimer", () => undefined],
  [queueController, "resumePlayback", () => undefined],
  [queueController, "transport", async () => undefined],
  [queueController, "stopPlayback", () => undefined],
  [queueController, "clear", () => undefined],
  [queueController, "getPlayerState", async () => null as Any],
  [eventManager, "getEventState", () => null as Any],
];

export function resetPeersFakes(): void {
  for (const [k, impl] of Object.entries(DEFAULTS)) {
    const f = (fns as Any)[k];
    f.mockReset();
    f.mockImplementation(impl as Any);
  }
  for (const [obj, key, impl] of MANAGER_DEFAULTS) {
    (obj[key] as Any).mockReset();
    (obj[key] as Any).mockImplementation(impl as Any);
  }
}

/** 挂到 shared 假体上(展开在 `_sharedFakes.overrides` **之后**)。 */
export const peersFakes: Record<string, unknown> = {
  ...fns,
  pm,
  gm,
  queueManager,
  queueController,
  eventManager,
  getPeerManager: () => pm,
  getGroupManager: () => gm,
  getQueueManager: () => queueManager,
  getQueueController: () => queueController,
  getEventManager: () => eventManager,
};
