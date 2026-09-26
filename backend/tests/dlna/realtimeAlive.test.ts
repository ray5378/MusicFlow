// DLNA「设备上线要**立刻**出现在播放器列表」契约测试（实时通道一侧）。
//
// 现象（用户报的）：设备已经被第三方 App（音流）拉起来在播了，播放器列表里却要等很久
// 才出现。230 模拟器 100% 复现、240 真机同构：
//   设备刚上电时它的 SSDP 栈往往**先于**内嵌 HTTP 服务就绪 → 此刻抓 description 必然失败。
//   旧实现单次失败即静默放弃(`if (!d) return`)，且 emit 前就把 60s 去抖用掉，
//   于是这次「上线」窗口被彻底浪费，只能等主动扫描（旧 5 分钟）——
//   实测：HTTP 恢复后设备还要 85s 才重新可见。
//
// 修复后锁死三条纪律：
//   ① alive 抓取失败必须**退避重试**，不能一次就放弃；
//   ② 重试全部失败 → 调 clearAliveEmit 放开去抖，让后续通告/扫描立刻接管；
//   ③ 重试成功 → 设备进缓存(available=true) + 广播 device_list_changed（三端即时可见），
//      且**只在「新设备」或「离线→上线」时**广播，避免周期通告反复刷 WS。
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetchAtLocation: vi.fn(),
  clearAliveEmit: vi.fn(),
  emitDeviceListChanged: vi.fn(),
  ssdpCb: null as null | ((e: any) => void),
}));

// 只 mock 外部边界：描述抓取（网络）与事件总线；发现层其余函数走真实实现。
vi.mock("../../src/services/dlna/discovery.js", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    fetchDeviceAtLocation: (...a: any[]) => h.fetchAtLocation(...a),
    clearAliveEmit: (...a: any[]) => h.clearAliveEmit(...a),
    onSsdpEvent: (cb: any) => {
      h.ssdpCb = cb;
    },
  };
});

vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({
    emitDeviceListChanged: (...a: any[]) => h.emitDeviceListChanged(...a),
    on: () => {},
    off: () => {},
    emit: () => {},
  }),
}));

import { wireSsdpRealtime, getCachedDevices } from "../../src/services/dlna/control.js";

const LOC = "http://192.168.10.30:49152/description.xml";

const DEV = () => ({
  id: "hv",
  name: "主卧",
  location: LOC,
  lastSeen: Date.now(),
  available: true,
  avTransportUrl: "http://192.168.10.30:49152/upnp/control/avt",
});

const cached = (id: string) => getCachedDevices().find((d) => d.id === id);

/** 触发 SSDP 事件回调（wireSsdpRealtime 只接线一次，回调需跨用例复用）。 */
const fire = (e: any) => {
  if (typeof h.ssdpCb !== "function") throw new Error("SSDP 回调未接线：wireSsdpRealtime 未生效");
  return h.ssdpCb(e);
};

beforeEach(() => {
  h.fetchAtLocation.mockReset();
  h.clearAliveEmit.mockReset();
  h.emitDeviceListChanged.mockReset();
  getCachedDevices().length = 0;
  // wireSsdpRealtime 有模块级幂等标记：只在第一次真正接线，回调此后保持不变。
  if (typeof h.ssdpCb !== "function") wireSsdpRealtime();
});

describe("实时 SSDP alive → 立刻进设备列表", () => {
  it(
    "首抓失败、重试成功 → 设备进列表 + 广播（不再一次失败就放弃）",
    async () => {
      h.fetchAtLocation.mockResolvedValueOnce(null).mockResolvedValueOnce(DEV());

      await fire({ type: "alive", location: LOC });

      expect(h.fetchAtLocation).toHaveBeenCalledTimes(2); // 首次 + 1 次重试
      expect(h.clearAliveEmit).not.toHaveBeenCalled();
      expect(h.emitDeviceListChanged).toHaveBeenCalledTimes(1);
      expect(cached("hv")?.available).toBe(true);
      expect(cached("hv")?.name).toBe("主卧");
    },
    20000,
  );

  it(
    "重试全部失败 → 放开去抖（clearAliveEmit）且不广播",
    async () => {
      h.fetchAtLocation.mockResolvedValue(null);

      await fire({ type: "alive", location: LOC });

      expect(h.fetchAtLocation).toHaveBeenCalledTimes(4); // 首次 + 0.8s/2s/5s 三次重试
      expect(h.clearAliveEmit).toHaveBeenCalledWith(LOC);
      expect(h.emitDeviceListChanged).not.toHaveBeenCalled();
      expect(cached("hv")).toBeUndefined();
    },
    20000, // 重试链含 0.8s/2s/5s 退避，默认 5s 超时不够
  );

  it("设备已在线时再次通告 → 不重复广播（避免 WS 刷屏）", async () => {
    h.fetchAtLocation.mockResolvedValue(DEV());

    await fire({ type: "alive", location: LOC });
    expect(h.emitDeviceListChanged).toHaveBeenCalledTimes(1);

    await fire({ type: "alive", location: LOC });
    expect(h.emitDeviceListChanged).toHaveBeenCalledTimes(1);
  });

  it("byebye → 标离线并广播（反向语义不能被破坏）", async () => {
    h.fetchAtLocation.mockResolvedValue(DEV());
    await fire({ type: "alive", location: LOC });
    expect(cached("hv")?.available).toBe(true);

    h.emitDeviceListChanged.mockReset();
    await fire({ type: "byebye", udn: "hv" });

    expect(cached("hv")?.available).toBe(false);
    expect(h.emitDeviceListChanged).toHaveBeenCalledTimes(1);
  });
});
