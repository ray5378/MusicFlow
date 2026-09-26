// DLNA 设备「可用性判定」契约测试 —— 锁死一条纪律:
//   **「本轮 M-SEARCH 没看到它」≠「它离线了」**。
//
// 用户报的现象(230 模拟器 100% 复现, 见 .workbuddy/mfc/dlna-bug/):
//   音流刚把设备拉起来、正在放歌, Web / HA 卡片 / App 的播放器列表里却**没有这台设备**
//   (三端都 `.filter(p => p.available)` 一剪, 设备直接从列表消失)。
//   根因: `refreshDevices` 用「本轮扫描响应集合 `live`」这一**单一快照**决定离线,
//   设备某轮没回 M-SEARCH(固件播放中变忙 / 刚上电 / description 拉取超时)即被判离线。
//
// 修复后判离线必须过三道闸(任一不过即保持在线), 外加一道消毒:
//   ① 出流活跃豁免 —— 设备正在拉我们的流(字节在走), 这是比 SSDP 更硬的存活证据;
//   ② 抖动宽限 —— 距上次成功发现不足 OFFLINE_GRACE_MS 时本轮不判离线;
//   ③ 定向补探 —— location 已知就直接 GET description.xml, 不依赖 SSDP;
//   ④ 扫描 socket 出错(提前返回空集)时整轮跳过离线判定, 空集不当权威答案。
//
// 同时**保住反向语义**: 真的离线(三闸全不过)必须仍能判离线, 否则设备永久僵在列表里。
import { describe, it, expect, beforeEach, vi } from "vitest";

// 只 mock 两个外部边界: 发现层(SSDP/description 网络)与事件总线。
// DB 走真实测试库(tests/setup.ts 已建全量 schema), 让 upsert / 标离线落库路径也真跑。
const h = vi.hoisted(() => ({
  discover: vi.fn(),
  fetchAtLocation: vi.fn(),
  scanErrored: vi.fn(),
}));

vi.mock("../../src/services/dlna/discovery.js", () => ({
  discoverDlnaDevices: (...a: any[]) => h.discover(...a),
  fetchDeviceAtLocation: (...a: any[]) => h.fetchAtLocation(...a),
  lastScanWasErrored: () => h.scanErrored(),
  onSsdpEvent: () => {},
}));

vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({ emitDeviceListChanged: () => {} }),
}));

import { refreshDevices, getCachedDevices, notePeerActivity, peerActiveWithin } from "../../src/services/dlna/control.js";

/** 距上次成功发现很久(稳超 OFFLINE_GRACE_MS=90s), 会被三道闸逐一审视。 */
const STALE = () => Date.now() - 5 * 60 * 1000;
/** 刚刚看到过(在宽限窗内)。 */
const FRESH = () => Date.now();

const LOC = "http://192.168.10.30:49152/description.xml";

/** 只造判定要用的字段, 其余与本测试无关。 */
function makeDev(over: Record<string, any> = {}): any {
  return {
    id: "d1",
    name: "主卧",
    location: LOC,
    lastSeen: STALE(),
    available: true,
    ...over,
  };
}

/** 重置为「缓存里恰好一台设备」的状态。 */
function seed(dev: any): void {
  const cache = getCachedDevices();
  cache.length = 0;
  cache.push(dev);
}

const cacheDev = (id: string) => getCachedDevices().find((d) => d.id === id);

beforeEach(() => {
  h.discover.mockReset().mockResolvedValue([]);
  h.fetchAtLocation.mockReset().mockResolvedValue(null);
  h.scanErrored.mockReset().mockReturnValue(false);
  getCachedDevices().length = 0;
});

describe("refreshDevices 判离线必须过三道闸(设备在放歌却消失的根因)", () => {
  it("① 出流活跃豁免: 本轮没回 M-SEARCH, 但正在拉我们的流 → 保持在线", async () => {
    seed(makeDev({ id: "d1", location: undefined }));
    notePeerActivity("dlna:d1");
    h.discover.mockResolvedValue([]); // 本轮一个响应都没有

    await refreshDevices();

    expect(cacheDev("d1")!.available).toBe(true);
    // 豁免的同时续了 lastSeen(否则下一轮宽限窗立刻过期又会被审)。
    expect(Date.now() - cacheDev("d1")!.lastSeen).toBeLessThan(5000);
  });

  it("② 抖动宽限: 最近刚看到过它, 单轮漏报不判离线", async () => {
    seed(makeDev({ id: "d2", location: undefined, lastSeen: FRESH() }));
    h.discover.mockResolvedValue([]);

    await refreshDevices();

    expect(cacheDev("d2")!.available).toBe(true);
  });

  it("宽限窗之外的设备仍会被审视(不是无脑保活)", async () => {
    // 对照组: 同样单轮漏报, 只是 lastSeen 很旧 → 三闸全不过 → 判离线。
    seed(makeDev({ id: "d3", location: undefined, lastSeen: STALE() }));
    h.discover.mockResolvedValue([]);

    await refreshDevices();

    expect(cacheDev("d3")!.available).toBe(false);
  });

  it("③ 定向补探: SSDP 无回应但 description.xml 拉得到 → 保持在线", async () => {
    seed(makeDev({ id: "d4", lastSeen: STALE() }));
    h.discover.mockResolvedValue([]);
    h.fetchAtLocation.mockResolvedValue({
      id: "d4",
      name: "主卧",
      location: LOC,
      avTransportUrl: "http://192.168.10.30:49152/upnp/control/AVTransport",
      lastSeen: Date.now(),
    });

    await refreshDevices();

    expect(h.fetchAtLocation).toHaveBeenCalledWith(LOC);
    expect(cacheDev("d4")!.available).toBe(true);
    expect(cacheDev("d4")!.avTransportUrl).toContain("AVTransport");
  });

  it("④ 扫描 socket 出错(空集不可信) → 整轮跳过离线判定", async () => {
    seed(makeDev({ id: "d5", location: undefined, lastSeen: STALE() }));
    h.discover.mockResolvedValue([]);
    h.scanErrored.mockReturnValue(true);

    await refreshDevices();

    expect(cacheDev("d5")!.available).toBe(true);
    // 既然跳过判定, 就不该去发补探请求。
    expect(h.fetchAtLocation).not.toHaveBeenCalled();
  });

  it("反向语义: 三闸全不过(无出流 + 超宽限 + 补探失败) → 仍必须判离线", async () => {
    seed(makeDev({ id: "d6", lastSeen: STALE() }));
    h.discover.mockResolvedValue([]);
    h.fetchAtLocation.mockResolvedValue(null); // 补探也拉不到

    await refreshDevices();

    expect(cacheDev("d6")!.available).toBe(false);
  });

  it("对照组: 本轮正常发现的设备一律在线", async () => {
    seed(makeDev({ id: "d7", lastSeen: STALE(), available: false }));
    h.discover.mockResolvedValue([{ id: "d7", name: "主卧", location: LOC, lastSeen: Date.now() }]);

    await refreshDevices();

    expect(cacheDev("d7")!.available).toBe(true);
  });
});

describe("出流活跃登记的清理(不随设备删除无限增长)", () => {
  it("设备已不在缓存 → 其活跃登记被清掉", async () => {
    seed(makeDev({ id: "d8", location: undefined }));
    notePeerActivity("dlna:d8");
    expect(peerActiveWithin("dlna:d8", 60_000)).toBe(true);

    // 设备被删除/禁用(缓存里没有了)后再刷新一轮。
    getCachedDevices().length = 0;
    h.discover.mockResolvedValue([]);
    await refreshDevices();

    expect(peerActiveWithin("dlna:d8", 60_000)).toBe(false);
  });
});
