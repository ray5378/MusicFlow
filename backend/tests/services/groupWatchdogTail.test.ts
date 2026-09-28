// 覆盖率长尾补充:services/group/watchdog.ts 的启停生命周期。
// 该定时器**没有 unref**:一旦重复 start 就会积累多个 10s 定时器,
// 同一组被多个巡检同时续播 → 重复 cast。故幂等性(第二个 if(timer) return)
// 与 stop 的清理必须锁住。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, afterEach, vi } from "vitest";
import { startGroupWatchdog, stopGroupWatchdog, resetGroupWatchdogForTest } from "../../src/services/group/watchdog.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  stopGroupWatchdog(); // 兜底:任何用例失败都不把定时器留给下一个文件/用例
  resetGroupWatchdogForTest();
});

describe("group watchdog 启停", () => {
  it("start 只注册一个定时器(重复调用幂等),stop 清理且幂等", () => {
    vi.useFakeTimers();
    // 假定时器必须先装,才能在 spy 里观察到 watchdog 注册的那一个 setInterval。
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    startGroupWatchdog();
    expect(setSpy).toHaveBeenCalledTimes(1);
    // 二次 start 不能再注册:否则巡检频率翻倍,同组会被重复续播(重复 cast)。
    startGroupWatchdog();
    expect(setSpy).toHaveBeenCalledTimes(1);

    stopGroupWatchdog();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // stop 幂等:没有定时器时不能对 null 调 clearInterval(也不能重复清理)。
    stopGroupWatchdog();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("stop 之后可再次 start(重新注册),且只有一份", () => {
    vi.useFakeTimers();
    startGroupWatchdog();
    stopGroupWatchdog();

    const setSpy = vi.spyOn(globalThis, "setInterval");
    startGroupWatchdog();
    // timer 已被 stop 置 null ⇒ 重新注册恰好一份。
    expect(setSpy).toHaveBeenCalledTimes(1);
    stopGroupWatchdog();
  });
});
