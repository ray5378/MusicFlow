// ==================== services/coverCache 长尾:LRU 预算 + 空闲清扫 ====================
// coverCache 的两个内存安全机制此前未被覆盖:
//   - 字节预算硬上限(超过 COVER_CACHE_BUDGET_BYTES 时淘汰最久未访问项);
//   - 空闲清扫定时器(INACTIVE_TIMEOUT_MS 内无人请求封面 → 整表释放)。
// 二者都靠「模块加载时读 env 常量」,故用 vi.resetModules + 动态 import 注入阈值。
import "../plugins/_env.js";

import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lt4-covercache-"));

function writeBin(name: string, bytes: number, fill: number): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, fill));
  return p;
}

afterAll(() => {
  vi.useRealTimers();
  delete process.env.COVER_CACHE_BUDGET_MB;
  delete process.env.COVER_CACHE_IDLE_MINUTES;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("coverCache 字节预算淘汰(LRU)", () => {
  it("预算置 0:插入第二条即淘汰最旧的,持有字节不随条目数无界增长", async () => {
    // 为什么:硬预算缺失会让一次长浏览把几百 MB 封面钉在内存里(进程被 OOM 杀)。
    process.env.COVER_CACHE_BUDGET_MB = "0";
    vi.resetModules();
    const mod = await import("../../src/services/coverCache.js");

    const a = writeBin("a.bin", 1000, 1);
    const b = writeBin("b.bin", 1000, 2);
    await mod.readCoverFile(a);
    expect(mod.getCoverCacheBytes()).toBe(1000);
    await mod.readCoverFile(b);
    // 预算=0 且已有 2 条 → 淘汰最旧的 a,只剩 b 的 1000 字节(未淘汰则为 2000)
    expect(mod.getCoverCacheBytes()).toBe(1000);

    mod.clearCoverCache();
    expect(mod.getCoverCacheBytes()).toBe(0);
  });
});

describe("coverCache 空闲清扫", () => {
  it("空闲阈值置 0:一个清扫周期后整表释放", async () => {
    // 为什么:前端 tab 关掉后没人再请求封面,内存必须在超时后被回收。
    process.env.COVER_CACHE_BUDGET_MB = "64";
    process.env.COVER_CACHE_IDLE_MINUTES = "0";
    vi.resetModules();
    const mod = await import("../../src/services/coverCache.js");

    vi.useFakeTimers();
    const a = writeBin("sweep.bin", 2048, 3);
    await mod.readCoverFile(a);
    expect(mod.getCoverCacheBytes()).toBe(2048);

    // SWEEP_INTERVAL_MS = 60s;sweepTimer.unref() 不影响 fake timers 触发
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mod.getCoverCacheBytes()).toBe(0);
    vi.useRealTimers();
  });
});
