// ==================== plugins/health 长尾 ====================
// 既有 health.test.ts 覆盖状态流转 / pingPlugin / pingAllHealth 常规分支。这里补:
//   - load() 从 plugin_health 表读回一行(内存缓存未命中时的持久化恢复路径);
//   - pingAllHealth 对「自检超时」的收口(withTimeout 超时 → status=down,message=自检超时)。
import "./_env.js";

import { describe, it, expect, afterEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { getHealth, allHealth, pingAllHealth } from "../../src/plugins/health.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";

const U = Math.random().toString(36).slice(2, 8);
const pid = (s: string) => `lt4hp-${s}-${U}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("health 持久化读回(缓存未命中)", () => {
  it("内存无记录但表里有一行 → 返回该行的真实状态/计数/错误", () => {
    // 为什么:进程重启后内存 cache 清空,健康状态必须能从表恢复(否则 UI 显示 unknown)。
    const id = pid("fromdb");
    allHealth(); // ensureTable():确保 plugin_health 已建
    sqlite
      .prepare(
        `INSERT INTO plugin_health
           (plugin_id, status, successes, failures, consecutive_failures, last_error, last_check, updated_at)
         VALUES (?, 'red', 7, 3, 3, 'boom', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
         ON CONFLICT(plugin_id) DO UPDATE SET
           status=excluded.status, successes=excluded.successes, failures=excluded.failures,
           consecutive_failures=excluded.consecutive_failures, last_error=excluded.last_error,
           last_check=excluded.last_check`,
      )
      .run(id);

    const rec = getHealth(id);
    expect(rec.status).toBe("red");
    expect(rec.successes).toBe(7);
    expect(rec.failures).toBe(3);
    expect(rec.consecutiveFailures).toBe(3);
    expect(rec.lastError).toBe("boom");
    expect(rec.lastCheck).toBe("2020-01-01T00:00:00.000Z");

    sqlite.prepare("DELETE FROM plugin_health WHERE plugin_id = ?").run(id);
  });
});

describe("pingAllHealth 超时收口", () => {
  it("health() 挂起超过 PING_TIMEOUT → status=down / message=自检超时", async () => {
    // 为什么:一个卡死的自检不能让 /v1/plugins/health 永久悬挂(前端页面打不开)。
    const id = pid("hang");
    registerPlugin(
      { id, name: id, version: "1.0.0", type: "source", capabilities: ["search"] } as any,
      { health: () => new Promise(() => { /* 永不 resolve */ }) },
    );
    try {
      vi.useFakeTimers();
      const p = pingAllHealth();
      // 推进超过 5s 单插件超时
      await vi.advanceTimersByTimeAsync(6000);
      const items = await p;
      const mine = items.find((i) => i.pluginId === id);
      expect(mine).toMatchObject({ status: "down", message: "自检超时", source: "ping" });
    } finally {
      unregisterPlugin(id);
    }
  });
});
