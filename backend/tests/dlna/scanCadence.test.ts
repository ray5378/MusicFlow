// DLNA「发现节奏」契约测试 —— 锁死两条纪律，任何一条被改回都会让
// 「设备上线了却不出现在播放器列表」这个 bug 原地复活。
//
// 纪律一（周期扫描间隔）：主动扫描是「设备不发任何 SSDP 通告」时的唯一兜底 —— 典型
//   场景就是第三方 App（音流等）把**已开机**的 DLNA 设备直接拉起来播放，设备自己不会
//   再广播 ssdp:alive。旧值 5 分钟意味着最坏要空等一整轮（230 模拟器实测：HTTP 恢复后
//   还要 85s 才可见）。现为 90s。
// 纪律二（拉取列表的补扫 TTL）：客户端来拉 `/v1/peers` = 「用户正盯着设备列表」，此时
//   距上次发现超过 TTL 就后台补扫一轮（fire-and-forget）。这是「打开/刷新列表」本身就能
//   带出刚上线设备的路径，不必干等周期扫描。
//
// 常量取自 `services/dlna/scanPolicy.ts` 的单一真源 —— 若各自写死字面量，改一处漏一处
// 就会悄悄退化，所以这里连「值」一起钉。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 只 mock 发现层的网络边界；DB / 事件总线走真实实现（与 deviceAvailability.test.ts 同范式）。
const h = vi.hoisted(() => ({ discover: vi.fn(), scanErrored: vi.fn() }));

vi.mock("../../src/services/dlna/discovery.js", () => ({
  discoverDlnaDevices: (...a: any[]) => h.discover(...a),
  lastScanWasErrored: () => h.scanErrored(),
  onSsdpEvent: () => {},
}));

import { refreshDevices, shouldRefreshDevices } from "../../src/services/dlna/control.js";
import { DLNA_SCAN_INTERVAL_MS, DISCOVERY_CACHE_TTL_MS } from "../../src/services/dlna/scanPolicy.js";

/** 固定基准时刻：只 fake Date，不 fake 计时器，避免干扰 async 等待。 */
const BASE = new Date("2026-09-26T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE);
  h.discover.mockReset().mockResolvedValue([]);
  h.scanErrored.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

/** 完成一轮「什么都没发现」的扫描，把 lastDiscovery 推到当下。 */
const scanOnce = () => refreshDevices();

describe("发现节奏常量（被改回旧值 = bug 复活）", () => {
  it("周期扫描间隔必须是 90s，不能是旧的 5 分钟", () => {
    expect(DLNA_SCAN_INTERVAL_MS).toBe(90_000);
    expect(DLNA_SCAN_INTERVAL_MS).toBeLessThan(5 * 60 * 1000);
  });

  it("拉取列表的补扫 TTL 必须短于周期扫描间隔", () => {
    expect(DISCOVERY_CACHE_TTL_MS).toBe(60_000);
    expect(DISCOVERY_CACHE_TTL_MS).toBeLessThan(DLNA_SCAN_INTERVAL_MS);
  });
});

describe("shouldRefreshDevices：拉列表时要不要顺带补扫", () => {
  it("从未扫过（进程刚启动）→ 必须立刻扫一轮", async () => {
    await scanOnce();
    expect(shouldRefreshDevices()).toBe(false); // 刚刚扫过，TTL 内不重复扫
  });

  it("TTL 内不重复补扫，超过 TTL 才补", async () => {
    await scanOnce();
    expect(shouldRefreshDevices()).toBe(false);

    vi.setSystemTime(BASE.getTime() + DISCOVERY_CACHE_TTL_MS - 1_000);
    expect(shouldRefreshDevices()).toBe(false); // 还差 1 秒，不补

    vi.setSystemTime(BASE.getTime() + DISCOVERY_CACHE_TTL_MS + 1_000);
    expect(shouldRefreshDevices()).toBe(true); // 过期了，补
  });

  it("扫描跑完即抑制补扫（多端同时拉列表不会反复扫）", async () => {
    h.scanErrored.mockReturnValue(true); // 即便这轮扫描 socket 出错，节奏上仍先压住
    await scanOnce();
    expect(shouldRefreshDevices()).toBe(false);

    vi.setSystemTime(BASE.getTime() + DISCOVERY_CACHE_TTL_MS + 1_000);
    expect(shouldRefreshDevices()).toBe(true);
  });
});

describe("refreshDevices 并发去重", () => {
  it("并发触发共享同一轮扫描，不会重复发 M-SEARCH", async () => {
    h.discover.mockClear();
    const a = refreshDevices();
    const b = refreshDevices();

    // 注意：refreshDevices 是 async 函数，两次调用返回的是各自的外层 Promise
    // （值相同但实例不同），所以这里钉的是「只发一轮 M-SEARCH」而不是 promise 同一性。
    expect(a).toEqual(b);
    await Promise.all([a, b]);
    expect(h.discover).toHaveBeenCalledTimes(1);
  });

  it("上一轮结束后新的触发照常开新的一轮", async () => {
    await scanOnce();
    h.discover.mockClear();
    await refreshDevices();
    expect(h.discover).toHaveBeenCalledTimes(1);
  });
});
