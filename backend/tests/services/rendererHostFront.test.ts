// ==================== services/rendererHost/front 外观工厂 ====================
// createFrontAccessor 是「fork 模式(代理) / in-proc(真实实例)」两种模式
// 对上层的统一出口;rpcFireAndForget 是幂等写的 fire-and-forget 姿势。
// 两者此前完全未被覆盖,而选错模式会让主进程拿到子进程没就绪的代理。
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";
import { createFrontAccessor, rpcFireAndForget } from "../../src/services/rendererHost/front.js";

describe("createFrontAccessor", () => {
  it("in-proc 模式直接返回真实实例,不建代理", () => {
    const real = { id: "real" };
    const createProxy = vi.fn(() => ({ id: "proxy" }));
    const get = createFrontAccessor({
      isFork: () => false, isRunning: () => false, createProxy, getInProc: () => real,
    });
    expect(get()).toBe(real);
    expect(createProxy).not.toHaveBeenCalled();
  });

  it("fork 但子进程未运行 → 返回 null(不建代理)", () => {
    // 为什么:子进程没起来时不能把「死代理」给上层,否则调用会静默丢命令。
    const createProxy = vi.fn(() => ({ id: "proxy" }));
    const get = createFrontAccessor({
      isFork: () => true, isRunning: () => false, createProxy, getInProc: () => ({ id: "real" }),
    });
    expect(get()).toBeNull();
    expect(createProxy).not.toHaveBeenCalled();
  });

  it("fork 且运行 → 懒建代理且只建一次", () => {
    const createProxy = vi.fn(() => ({ id: "proxy" }));
    const get = createFrontAccessor({
      isFork: () => true, isRunning: () => true, createProxy, getInProc: () => null,
    });
    const g1 = get();
    const g2 = get();
    expect(g1).toBe(g2);
    expect(g1?.id).toBe("proxy");
    expect(createProxy).toHaveBeenCalledTimes(1);
  });

  it("isFork 动态翻转:先前 in-proc 不影响之后 fork 的代理建立", () => {
    let fork = false;
    const real = { id: "real" };
    const createProxy = vi.fn(() => ({ id: "proxy" }));
    const get = createFrontAccessor({
      isFork: () => fork, isRunning: () => true, createProxy, getInProc: () => real,
    });
    expect(get()).toBe(real);
    fork = true;
    expect(get()?.id).toBe("proxy");
  });
});

describe("rpcFireAndForget", () => {
  it("把 op/payload 透传给 host.rpc", () => {
    const rpc = vi.fn(async () => "ok");
    rpcFireAndForget({ rpc } as any, "setVolume", { v: 3 });
    expect(rpc).toHaveBeenCalledWith("setVolume", { v: 3 });
  });

  it("rpc 拒绝也不抛(交给下一轮快照校正),不产生 unhandled rejection", async () => {
    // 为什么:子进程瞬时失败时若冒泡,会在事件回调里变成未捕获异常。
    const rpc = vi.fn(async () => { throw new Error("child down"); });
    expect(() => rpcFireAndForget({ rpc } as any, "setMuted", true)).not.toThrow();
    expect(rpc).toHaveBeenCalledWith("setMuted", true);
    // 让被 catch 掉的 rejection 走完微任务;若没有 .catch,这里会以 unhandled rejection 爆掉
    await new Promise((r) => setTimeout(r, 10));
  });
});
