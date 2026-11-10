// ==================== 停播空闲回收:插件层按需加载的收尾 ====================
//
// 按需加载只省下「开机 → 第一次播放」这段;播过之后模块图常驻(Node 卸不掉 import)。
// 真正的回收只能是换进程:子进程只判定「连续 N 秒没有任何组在播」并上报,
// 主进程 supervisor.recycle 做 stop→start。本文件钉死判定逻辑与事件分发:
//   ① 忙过就重新计时,绝不打断播放/暂停;
//   ② 阈值到了只报一次(不会每 15s 反复请主进程重启);
//   ③ 插件层没加载过就不计时(本来就很轻,不值得为它断一次设备连接);
//   ④ 事件分发:无 hook 不抛、hook 抛错不拖垮事件桥、与既有事件互不影响。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  IdleReclaimTracker,
  startIdleReclaim,
  IDLE_RECLAIM_AFTER_MS,
} from "../../src/services/rendererHost/idleReclaim.js";
import { dispatchSendspinChildEvent } from "../../src/services/sendspin/supervisor.js";
import type { SupervisorHooks } from "../../src/services/sendspin/supervisor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("IdleReclaimTracker", () => {
  it("空闲累计到阈值才上报一次,并带上空闲时长", () => {
    let busy = false;
    const fired: number[] = [];
    const t = new IdleReclaimTracker({ afterMs: 10_000, isBusy: () => busy, onIdle: (ms) => fired.push(ms) });

    expect(t.tick(0)).toBe(false);       // 第一个 tick 只记起点
    expect(t.tick(5_000)).toBe(false);   // 未到阈值
    expect(fired).toEqual([]);
    expect(t.tick(10_000)).toBe(true);   // 到阈值 → 触发
    expect(fired).toEqual([10_000]);
    expect(t.tick(60_000)).toBe(false);  // 已触发,不再重复
    expect(fired).toEqual([10_000]);
  });

  it("中途忙过就重新计时,不打断播放/暂停", () => {
    let busy = false;
    const fired: number[] = [];
    const t = new IdleReclaimTracker({ afterMs: 10_000, isBusy: () => busy, onIdle: (ms) => fired.push(ms) });

    t.tick(0);
    busy = true;
    expect(t.tick(9_000)).toBe(false);
    busy = false;
    expect(t.tick(12_000)).toBe(false);  // 从 12s 重新起算
    expect(t.tick(21_000)).toBe(false);
    expect(t.tick(22_000)).toBe(true);
    expect(fired).toEqual([10_000]);
  });

  it("默认阈值是 2 分钟(跨曲间隙 < 10s,余量充足)", () => {
    expect(IDLE_RECLAIM_AFTER_MS).toBe(120_000);
  });
});

describe("startIdleReclaim", () => {
  it("插件层未加载时不计时;加载后从下一拍开始累计", () => {
    vi.useFakeTimers();
    let loaded = false;
    const fired: number[] = [];
    const stop = startIdleReclaim({
      afterMs: 3_000,
      tickMs: 1_000,
      pluginLayerLoaded: () => loaded,
      isBusy: () => false,
      onIdle: (ms) => fired.push(ms),
    });

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);           // 没加载过 → 一直不计

    loaded = true;
    vi.advanceTimersByTime(2_000);
    expect(fired).toEqual([]);           // 刚起算
    vi.advanceTimersByTime(2_000);
    expect(fired.length).toBe(1);        // 阈值到 → 上报
    stop();
  });

  it("stop() 之后不再上报", () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    const stop = startIdleReclaim({
      afterMs: 1_000,
      tickMs: 500,
      pluginLayerLoaded: () => true,
      isBusy: () => false,
      onIdle: (ms) => fired.push(ms),
    });
    stop();
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });
});

describe("idleReclaim 事件分发", () => {
  it("转给 onIdleReclaim(idleMs)", () => {
    const got: number[] = [];
    const hooks: SupervisorHooks = { onIdleReclaim: (ms) => got.push(ms) };
    dispatchSendspinChildEvent({ t: "idleReclaim", idleMs: 123_456 }, hooks);
    expect(got).toEqual([123_456]);
  });

  it("无 hook 不抛;hook 抛错不拖垮事件桥", () => {
    expect(() => dispatchSendspinChildEvent({ t: "idleReclaim", idleMs: 1 }, {})).not.toThrow();
    expect(() =>
      dispatchSendspinChildEvent(
        { t: "idleReclaim", idleMs: 1 },
        { onIdleReclaim: () => { throw new Error("boom"); } },
      ),
    ).not.toThrow();
  });

  it("既有事件不受影响(closed 仍照常分发)", () => {
    const closed: string[] = [];
    dispatchSendspinChildEvent({ t: "closed", clientId: "c1" }, { onClosed: (id) => closed.push(id) });
    expect(closed).toEqual(["c1"]);
  });
});
