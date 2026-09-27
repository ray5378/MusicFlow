// 可复用的 `routes/api/shared.ts` 测试假体。
//
// 为什么需要它:`index.ts` 拆分后,每个域的路由模块(routes/api/*.ts)都从 shared.ts
// 这一个中枢导入全部依赖。若不替换,想覆盖「服务层抛错 → 路由 catch → 500」
// 这条分支就真的要让真实 DLNA 设备掉线、真实 ffmpeg 失败 —— 做不到,于是这些
// catch 分支长期零覆盖(而它们正是错误契约的落点)。
//
// 用法(每个测试文件顶部):
//
//   vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
//     const actual = await importOriginal<Record<string, unknown>>();
//     const { overrides } = await import("./_sharedFakes.js");
//     return { ...actual, ...overrides };
//   });
//
// 即以**真实模块为底**(枚举 / apiError / db / schema / 工具函数全部保真),
// 只把「服务层入口」换成 vi.fn()。测试里用 fns.xxx.mockResolvedValueOnce(...) 精确
// 指定这一次的行为,用 resetFakes() 在 beforeEach 复位。
import { vi } from "vitest";

export type Any = any;

/** 每个 fn 的出厂实现 = 「最普通的成功路径」,让路由走 happy path。 */
const DEFAULTS = {
  // ---- dlna / 设备缓存 ----
  getCachedDevices: () => [] as Any[],
  refreshDevices: async () => [] as Any[],
  shouldRefreshDevices: () => false,
  markStaleDevices: (l: Any) => l,
  serializeDlnaDevices: (l: Any) => l,
  canUseRenderer: () => true,
  setDeviceAlias: () => null as Any,
  setDeviceDisabled: () => null as Any,
  deleteDeviceRecord: () => false,
  isDeviceDisabled: () => false,

  // ---- dlna 传输控制 ----
  playDevice: async () => undefined,
  pauseDevice: async () => undefined,
  stopDevice: async () => undefined,
  seekDevice: async () => undefined,
  setDeviceVolume: async () => undefined,
  setDeviceMute: async () => undefined,
  castToDevice: async () => undefined,
  enqueueNextTrack: async () => true,
  createCastSession: () => ({ token: "cast-token", expiresAt: 1_700_000_000_000 }),
  getDlnaBaseUrl: () => "http://127.0.0.1:46400",
  getDeviceStatus: async () => ({ state: "idle", position: 0, duration: 0, volume: 0, muted: false }),
  probeLocalSourceOk: async () => false,
  ensurePlayableStream: async () => null,
  getCurrentMedia: () => null as Any,

  // ---- 管理器 ----
  getGroupManager: () => ({ removeDeviceFromAllGroups: vi.fn() }),
  getQueueController: () => ({ clear: vi.fn() }),
  getPeerManager: () => ({ reconcileDlnaPeers: vi.fn(), removeDlnaPeer: vi.fn() }),
  getEventManager: () => ({ getEventState: () => null as Any, emitDeviceListChanged: vi.fn() }),
  getQueueManager: () => ({
    snapshot: () => ({}) as Any,
    playFrom: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    prev: vi.fn(async () => undefined),
    clear: vi.fn(),
    activeDevices: () => [] as Any[],
    setPlayMode: vi.fn(),
    removeAt: vi.fn(),
    deactivate: vi.fn(),
    index: vi.fn(async () => undefined),
  }),

  // ---- sendspin / 权限 ----
  sendspinServerOr404: () => null as Any,
  hasPerm: () => true,
};

type FnName = keyof typeof DEFAULTS;

/** 受控服务入口(每次 resetFakes 后回到 DEFAULTS)。 */
export const fns = Object.fromEntries(
  Object.entries(DEFAULTS).map(([k, impl]) => [k, vi.fn(impl as Any)]),
) as Record<FnName, ReturnType<typeof vi.fn>>;

/** 复位到出厂实现,并清空调用记录 —— 在 beforeEach 里调用。 */
export function resetFakes(): void {
  for (const [k, impl] of Object.entries(DEFAULTS)) {
    const f = (fns as Any)[k];
    f.mockReset();
    f.mockImplementation(impl as Any);
  }
}

/** 放行中间件(不鉴权、不判权):让用例专注路由处理器自身的分支。 */
const mw = async (_c: Any, next: Any) => {
  await next();
};

/** 合并进真实 shared 模块的覆盖项。 */
export const overrides: Record<string, unknown> = {
  ...fns,
  // permMiddleware / rendererGrantParamMiddleware 是**工厂**,返回中间件;
  // adminMiddleware 本身即中间件。
  permMiddleware: () => mw,
  rendererGrantParamMiddleware: () => mw,
  adminMiddleware: mw,
};
