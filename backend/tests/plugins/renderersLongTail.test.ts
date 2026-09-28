// ==================== plugins/renderers 编排层长尾 ====================
// 既有 renderersPlugin.test.ts 测的是 dlna/airplay 适配器本身;这里测的是
// plugins/renderers.ts 的**编排**(遍历已启用 renderer 插件 + 健康记录 + 错误收口):
//   - discoverRenderers:某插件 discover 抛错 → recordFailure 并跳过,不拖垮其它插件;
//   - castToRenderer:底层 cast 抛错 → recordFailure 后重抛;
//   - controlRenderer:插件未实现 control → 抛「不支持控制操作」。
import "./_env.js";

import { describe, it, expect, afterEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import {
  discoverRenderers,
  castToRenderer,
  controlRenderer,
} from "../../src/plugins/renderers.js";

const U = Math.random().toString(36).slice(2, 8);
const pid = (s: string) => `lt4rend-${s}-${U}`;

/** 注册 + 置 enabled=1 —— getEnabledByCapability 会同时要求「代码已注册」与「DB 已启用」。 */
function enable(id: string, impl: any) {
  registerPlugin(
    { id, name: id, version: "1.0.0", type: "renderer", capabilities: ["renderer"] } as any,
    impl,
  );
  sqlite
    .prepare(
      `INSERT INTO plugins (id, name, enabled, config) VALUES (?, ?, 1, '{}')
       ON CONFLICT(id) DO UPDATE SET enabled = 1`,
    )
    .run(`row-${id}`, id);
}

function cleanup(id: string) {
  unregisterPlugin(id);
  sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(id);
  try {
    sqlite.prepare("DELETE FROM plugin_health WHERE plugin_id = ?").run(id);
  } catch {
    /* plugin_health 尚未建表(本文件还没触发过任何健康记录)→ 无需清理 */
  }
}

const registered: string[] = [];
afterEach(() => {
  while (registered.length) cleanup(registered.pop()!);
});

describe("discoverRenderers", () => {
  it("聚合各插件设备；某插件 discover 抛错 → 记录失败并继续,不冒泡", async () => {
    const okId = pid("ok");
    const badId = pid("bad");
    enable(okId, { discover: async () => [{ id: "d1", name: "设备1", type: "custom", available: true }] });
    enable(badId, { discover: async () => { throw new Error("SSDP 超时"); } });
    registered.push(okId, badId);

    const out = await discoverRenderers();
    // 好插件的设备带 pluginId 归属
    expect(out.find((d) => d.id === "d1")?.pluginId).toBe(okId);
    // 坏插件不产出设备,但异常被收口(recordFailure 写入健康记录)
    const health = sqlite
      .prepare("SELECT failures, last_error FROM plugin_health WHERE plugin_id = ?")
      .get(badId) as any;
    expect(health?.failures).toBeGreaterThanOrEqual(1);
    expect(String(health?.last_error)).toContain("SSDP 超时");
  });

  it("impl 没有 discover 的插件被静默跳过", async () => {
    const id = pid("nodiscover");
    enable(id, {});
    registered.push(id);
    await expect(discoverRenderers()).resolves.toEqual(
      expect.not.arrayContaining([expect.objectContaining({ pluginId: id })]),
    );
  });
});

describe("castToRenderer", () => {
  it("底层 cast 抛错 → 记录失败后原样重抛", async () => {
    const id = pid("castfail");
    enable(id, { cast: async () => { throw new Error("SOAP 500"); } });
    registered.push(id);
    await expect(castToRenderer(id, "d1", "s1")).rejects.toThrow("SOAP 500");
    const health = sqlite
      .prepare("SELECT failures FROM plugin_health WHERE plugin_id = ?").get(id) as any;
    expect(health?.failures).toBeGreaterThanOrEqual(1);
  });

  it("插件未注册/未实现 cast → 抛「未找到可用的渲染器插件」", async () => {
    await expect(castToRenderer(pid("ghost"), "d1", "s1")).rejects.toThrow(/未找到可用的渲染器插件/);
  });
});

describe("controlRenderer", () => {
  it("插件未实现 control → 抛「不支持控制操作」", async () => {
    const id = pid("noctrl");
    enable(id, { discover: async () => [] });
    registered.push(id);
    await expect(controlRenderer(id, "d1", "play")).rejects.toThrow(/不支持控制操作/);
  });

  it("实现了 control → 转发并返回结果", async () => {
    const id = pid("ctrl");
    enable(id, { control: async (_h: any, _d: string, action: string) => `did:${action}` });
    registered.push(id);
    await expect(controlRenderer(id, "d1", "pause")).resolves.toBe("did:pause");
  });
});
