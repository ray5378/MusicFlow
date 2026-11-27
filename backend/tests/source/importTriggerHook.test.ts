import { describe, it, expect, vi, afterEach } from "vitest";
import {
  setImportedSongsListener,
  hasImportedSongsListener,
  emitImportedSongs,
} from "../../src/services/source/online/importTriggerHook.js";

// 入库钩子（注册制）：未挂载即空实现；空列表不触发；监听器抛错绝不带崩导入。
describe("importTriggerHook（入库事件广播）", () => {
  afterEach(() => setImportedSongsListener(null));

  it("初始未挂载 → has=false，emit 为 no-op", () => {
    expect(hasImportedSongsListener()).toBe(false);
    expect(() => emitImportedSongs(["s1"], { providerId: "qq" })).not.toThrow();
  });

  it("挂载后 has=true，emit 把本轮新入库 id 与 ctx 原样传给监听器", () => {
    const fn = vi.fn();
    setImportedSongsListener(fn);
    expect(hasImportedSongsListener()).toBe(true);
    emitImportedSongs(["s1", "s2"], { providerId: "netease" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(["s1", "s2"], { providerId: "netease" });
  });

  it("空列表不触发监听器", () => {
    const fn = vi.fn();
    setImportedSongsListener(fn);
    emitImportedSongs([], { providerId: "qq" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("非数组入参不触发（防御）", () => {
    const fn = vi.fn();
    setImportedSongsListener(fn);
    emitImportedSongs("s1" as any, { providerId: "qq" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("监听器抛错被吞掉，不影响导入流程", () => {
    setImportedSongsListener(() => { throw new Error("boom"); });
    expect(() => emitImportedSongs(["s1"], { providerId: "qq" })).not.toThrow();
  });

  it("卸载后回到未挂载", () => {
    setImportedSongsListener(vi.fn());
    setImportedSongsListener(null);
    expect(hasImportedSongsListener()).toBe(false);
  });
});
