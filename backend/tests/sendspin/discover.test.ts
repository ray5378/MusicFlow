// ==================== Sendspin 播放器自动发现 补测 ====================
//
// 文件头记着 2026-09-25 真机定位的两个致命缺陷,本文件即修法:
//   ① 发现即写 —— 设备开机那一瞬拨号必然 EHOSTUNREACH,以前却在「拨成功之后」
//      才记忆 ⇒ 一次失败 = 永久失联(实测 .245 开机后 38 分钟无人理它)。
//   ② 库级永久装聋 —— bonjour-service 的 PTR 查询只发一次、`_services` 只增不减、
//      对已知 fqdn 永久去重,而 ESPHome 开机只广播一次 ⇒ 错过就永远没有第二次。
//      故本文件自己**周期重建 browser** 造节拍,并提供 refreshPlayerDiscoveryNow
//      让音流的等待阶段能主动催一次。
//
// 这两条修法都在「状态 + 回调」里,跑起来不抛异常、不打错误日志,只能靠断言圈住。
// 协作方(共享 Bonjour / deviceState 的禁用判定 / index 的拨号状态机)全部换成替身,
// onPlayerSeen 未导出 —— 经 find() 捕获的回调驱动,走的就是生产那条路。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ info: log.info, warn: log.warn, error: log.error, debug: log.debug }),
}));

const bonjour = vi.hoisted(() => {
  const calls: any[] = [];
  return {
    calls,
    find: vi.fn((type: any, cb: any) => {
      const inst = { stop: vi.fn() };
      calls.push({ type, cb, inst });
      return inst;
    }),
    last: () => calls[calls.length - 1],
  };
});
vi.mock("../../src/services/discovery/mdns.js", () => ({
  getSharedBonjour: () => bonjour,
}));

const ds = vi.hoisted(() => ({ disabled: vi.fn(() => false) }));
vi.mock("../../src/services/sendspin/deviceState.js", () => ({
  isHostOfDisabledDevice: (host: string) => ds.disabled(host),
}));

const idx = vi.hoisted(() => ({ arm: vi.fn(async () => true) }));
vi.mock("../../src/services/sendspin/index.js", () => ({
  armDialTarget: (...a: any[]) => idx.arm(...a),
}));

import {
  startPlayerDiscovery,
  stopPlayerDiscovery,
  refreshPlayerDiscoveryNow,
  pickIPv4,
} from "../../src/services/sendspin/discover.js";

function makeSrv(over: Record<string, unknown> = {}) {
  return {
    isRedialSuppressed: vi.fn(() => false),
    isConnectedTo: vi.fn(() => false),
    ...over,
  };
}

/** 让 onPlayerSeen 那段 `void ... .catch(...)` 的微任务跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  stopPlayerDiscovery();
  bonjour.find.mockClear();
  bonjour.calls.length = 0;
  ds.disabled.mockClear();
  ds.disabled.mockReturnValue(false);
  idx.arm.mockClear();
  idx.arm.mockResolvedValue(true);
  log.info.mockClear();
  log.warn.mockClear();
});

afterEach(() => {
  stopPlayerDiscovery();
  vi.useRealTimers();
});

// ============================================================
describe("browser 的生命周期:起 / 停 / 周期重建", () => {
  it("启动即开一个 browser,查询类型是 sendspin", () => {
    startPlayerDiscovery(makeSrv() as any);
    expect(bonjour.find).toHaveBeenCalledTimes(1);
    expect(bonjour.last().type).toEqual({ type: "sendspin" });
  });

  it("幂等:二次启动会先停掉旧实例(旧实例 _services 非空,不停 = 永远等不到 up)", () => {
    startPlayerDiscovery(makeSrv() as any);
    const first = bonjour.last().inst;
    startPlayerDiscovery(makeSrv() as any);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(bonjour.find).toHaveBeenCalledTimes(2);
  });

  it("周期重建:60s 一到就换一个新实例(设备只广播一次,必须自己造节拍)", () => {
    vi.useFakeTimers();
    startPlayerDiscovery(makeSrv() as any);
    const first = bonjour.last().inst;
    vi.advanceTimersByTime(60_000);
    expect(bonjour.find).toHaveBeenCalledTimes(2);
    expect(first.stop).toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(bonjour.find).toHaveBeenCalledTimes(3);
  });

  it("停止后不再重建,且清掉定时器与实例", () => {
    vi.useFakeTimers();
    startPlayerDiscovery(makeSrv() as any);
    const inst = bonjour.last().inst;
    stopPlayerDiscovery();
    expect(inst.stop).toHaveBeenCalled();
    vi.advanceTimersByTime(180_000);
    expect(bonjour.find).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
describe("refreshPlayerDiscoveryNow:音流等待阶段的主动催", () => {
  it("发现未启动 → false", () => {
    // 必须把时钟推到 lastOpenAt 之后足够远:前面的用例在假时钟下开局,可能把
    // lastOpenAt 留在「未来」,相对推进几秒会被节流分支先挡下 —— 那样就测不到
    // 「未启动」这一条本身。故用绝对推进(1 小时)盖掉任何残留。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    expect(refreshPlayerDiscoveryNow()).toBe(false);
    expect(bonjour.find).not.toHaveBeenCalled();
  });

  it("距上次不足 minGapMs → 节流返回 false(太密的查询白占 mDNS 带宽)", () => {
    startPlayerDiscovery(makeSrv() as any);
    expect(refreshPlayerDiscoveryNow()).toBe(false);
    expect(bonjour.find).toHaveBeenCalledTimes(1);
  });

  it("过了节流窗口 → 立刻重建一次,不等 60s 周期", () => {
    vi.useFakeTimers();
    startPlayerDiscovery(makeSrv() as any);
    vi.advanceTimersByTime(6_000);
    expect(refreshPlayerDiscoveryNow()).toBe(true);
    expect(bonjour.find).toHaveBeenCalledTimes(2);
  });

  it("Browser 构造失败 → 记 warn、实例置空、不抛", () => {
    bonjour.find.mockImplementationOnce(() => {
      throw new Error("mDNS 不可用");
    });
    expect(() => startPlayerDiscovery(makeSrv() as any)).not.toThrow();
    expect(log.warn.mock.calls.some((c) => String(c[1]?.err ?? "").includes("mDNS 不可用"))).toBe(true);
  });
});

// ============================================================
describe("回调分发:重建期间的迟到回调必须丢弃", () => {
  it("停止后到达的回调不再入册(它属于上一个 browser 实例)", async () => {
    startPlayerDiscovery(makeSrv() as any);
    const cb = bonjour.last().cb;
    stopPlayerDiscovery();

    cb({ addresses: ["192.168.1.9"], port: 8928 });
    await flush();
    expect(idx.arm).not.toHaveBeenCalled();
  });

  it("在任期间的回调正常入册(发现即写,不靠拨号成功)", async () => {
    startPlayerDiscovery(makeSrv() as any);
    bonjour.last().cb({ addresses: ["192.168.1.9"], port: 8928 });
    await flush();
    expect(idx.arm).toHaveBeenCalledWith("192.168.1.9", 8928, "discover");
    expect(log.info.mock.calls.some((c) => String(c[0]).includes("已入册并开重试窗口"))).toBe(true);
  });

  it("入册失败(状态机不可用)→ 记 warn,不冒泡", async () => {
    idx.arm.mockRejectedValueOnce(new Error("状态机未起"));
    startPlayerDiscovery(makeSrv() as any);
    bonjour.last().cb({ addresses: ["192.168.1.9"], port: 8928 });
    await flush();
    expect(log.warn.mock.calls.some((c) => String(c[1]?.err ?? "").includes("状态机未起"))).toBe(true);
  });

  it("已有重试窗口在跑(arm 返回 false)→ 不重复记日志", async () => {
    idx.arm.mockResolvedValueOnce(false);
    startPlayerDiscovery(makeSrv() as any);
    bonjour.last().cb({ addresses: ["192.168.1.9"], port: 8928 });
    await flush();
    expect(log.info.mock.calls.some((c) => String(c[0]).includes("已入册"))).toBe(false);
  });
});

// ============================================================
describe("onPlayerSeen 的四道闸门", () => {
  async function seen(srv: any, svc: any) {
    startPlayerDiscovery(srv);
    bonjour.last().cb(svc);
    await flush();
  }

  it("端口不是 1..65535 的整数 → 不拨", async () => {
    // 注:`Number("8928")` 是合法端口 —— 字符串形态照样认,不在此列。
    for (const port of [0, 70000, -1, 89.28, "abc", undefined, null]) {
      idx.arm.mockClear();
      await seen(makeSrv(), { addresses: ["192.168.1.9"], port });
      expect(idx.arm).not.toHaveBeenCalled();
    }
  });

  it("取不到 host → 不拨", async () => {
    await seen(makeSrv(), { port: 8928 });
    expect(idx.arm).not.toHaveBeenCalled();
  });

  it("已禁用设备 → 不拨(判定按最近一次已知 host)", async () => {
    ds.disabled.mockReturnValue(true);
    await seen(makeSrv(), { addresses: ["192.168.1.9"], port: 8928 });
    expect(idx.arm).not.toHaveBeenCalled();
    expect(ds.disabled).toHaveBeenCalledWith("192.168.1.9");
  });

  it("设备明确拒绝过且仍在抑制期 → 不骚扰(与手工 dial 同口径)", async () => {
    const srv = makeSrv({ isRedialSuppressed: vi.fn(() => true) });
    await seen(srv, { addresses: ["192.168.1.9"], port: 8928 });
    expect(srv.isRedialSuppressed).toHaveBeenCalledWith("192.168.1.9", 8928);
    expect(idx.arm).not.toHaveBeenCalled();
  });

  it("已在线(拨出按 host:port / 拨入按 host)→ 不重复拨", async () => {
    const srv = makeSrv({ isConnectedTo: vi.fn(() => true) });
    await seen(srv, { addresses: ["192.168.1.9"], port: 8928 });
    expect(srv.isConnectedTo).toHaveBeenCalledWith("192.168.1.9", 8928);
    expect(idx.arm).not.toHaveBeenCalled();
  });
});

// ============================================================
describe("pickIPv4:mDNS 服务对象的取址口径", () => {
  it("addresses 里的 IPv4 字面量优先(IPv6 混在后面也要挑出来)", () => {
    expect(pickIPv4({ addresses: ["fe80::1", "192.168.1.9"] })).toBe("192.168.1.9");
  });

  it("IPv4 字面量优先于排在它前面的主机名(两轮扫描的顺序就是优先级)", () => {
    expect(pickIPv4({ addresses: ["esp-home", "192.168.1.9"] })).toBe("192.168.1.9");
  });

  it("单个字符串形式(addresses 非数组)同样认", () => {
    expect(pickIPv4({ addresses: "10.0.0.5" })).toBe("10.0.0.5");
  });

  it("referer.address 兜底", () => {
    expect(pickIPv4({ referer: { address: "10.0.0.7" } })).toBe("10.0.0.7");
  });

  it("只有 IPv6 → 退 host(上层直连 .local 名)", () => {
    expect(pickIPv4({ addresses: ["fe80::1"], host: "esp.local" })).toBe("esp.local");
  });

  it("无冒号的非 IPv4 字面量(主机名)也能用作地址", () => {
    expect(pickIPv4({ addresses: ["esp-home"], host: "ignored" })).toBe("esp-home");
  });

  it("什么都没有 → 空串(调用方据此判无效)", () => {
    expect(pickIPv4({})).toBe("");
    expect(pickIPv4(null)).toBe("");
  });
});
