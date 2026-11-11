// MUST be the first import: 把 DATA_DIR 指到隔离临时目录(与其它插件测试一致)。
import "./_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import {
  discoverExternalPlugins,
  pluginSandboxes,
  sweepIdlePlugins,
  PLUGIN_IDLE_EVICT_MS,
} from "../../src/plugins/discovery.js";
import { getPluginImpl } from "../../src/plugins/registry.js";
import { TMP_DATA_DIR } from "./_env.js";

const ROOT = path.join(TMP_DATA_DIR, "lazy-idle-evict");
const LAZY_ID = "lazy-demo";
const SYNC_ID = "sync-demo";

const LAZY_MANIFEST = {
  id: LAZY_ID,
  name: "Lazy Demo",
  version: "1.0.0",
  type: "recommender",
  capabilities: ["dailyPlaylist"],
  configSchema: [],
  permissions: [] as string[],
};

const SYNC_MANIFEST = {
  id: SYNC_ID,
  name: "Sync Demo",
  version: "1.0.0",
  type: "source",
  capabilities: ["stream"],
  configSchema: [],
  permissions: ["net"],
};

function writePlugin(id: string, manifest: any, body: string) {
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(dir, "index.js"), body, "utf8");
}

beforeAll(async () => {
  writePlugin(
    LAZY_ID,
    LAZY_MANIFEST,
    `globalThis.__mfPlugin = {
  manifest: ${JSON.stringify(LAZY_MANIFEST)},
  create() { return { runDailyJob: async () => "lazy-ok" }; },
};`,
  );
  writePlugin(
    SYNC_ID,
    SYNC_MANIFEST,
    `globalThis.__mfPlugin = {
  manifest: ${JSON.stringify(SYNC_MANIFEST)},
  create() { return { search: async () => [], streamUrl: () => "http://example/x.mp3" }; },
};`,
  );
  await discoverExternalPlugins("9.0.0", ROOT, { lazy: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("外置插件懒加载 + 空闲驱逐", () => {
  // 用例顺序会被 vitest 打乱(仓库开启了 sequence.shuffle),因此把「发现 → 首调 →
  // 驱逐 → 重建」这条有状态链路放进同一个用例,避免互相污染。
  it("发现阶段不建沙箱;首次调用建沙箱;闲置超阈值被驱逐;旧门面引用仍可用并自动重建", async () => {
    expect(getPluginImpl(LAZY_ID)).toBeTruthy();
    expect(pluginSandboxes.has(LAZY_ID)).toBe(false);
    // streamUrl 是同步契约 → 必须开机就绪,否则核心同步取值会拿到 undefined。
    expect(pluginSandboxes.has(SYNC_ID)).toBe(true);

    const facade = getPluginImpl(LAZY_ID);
    expect(await facade.runDailyJob()).toBe("lazy-ok");
    expect(pluginSandboxes.has(LAZY_ID)).toBe(true);

    // 未到阈值:不驱逐。
    expect(sweepIdlePlugins(Date.now())).not.toContain(LAZY_ID);

    // 超过阈值:驱逐沙箱,但注册表里的门面引用保持不变。
    const evicted = sweepIdlePlugins(Date.now() + PLUGIN_IDLE_EVICT_MS + 1000);
    expect(evicted).toContain(LAZY_ID);
    expect(pluginSandboxes.has(LAZY_ID)).toBe(false);
    expect(getPluginImpl(LAZY_ID)).toBe(facade);

    // 再次调用:门面自动重建沙箱并返回结果。
    expect(await facade.runDailyJob()).toBe("lazy-ok");
    expect(pluginSandboxes.has(LAZY_ID)).toBe(true);
  });

  it("同步契约插件永远不会被空闲驱逐", () => {
    const evicted = sweepIdlePlugins(Date.now() + PLUGIN_IDLE_EVICT_MS * 100);
    expect(evicted).not.toContain(SYNC_ID);
    expect(pluginSandboxes.has(SYNC_ID)).toBe(true);
  });

  it("驱逐是幂等的:没有可驱逐对象时返回空数组", () => {
    const now = Date.now() + PLUGIN_IDLE_EVICT_MS * 100;
    sweepIdlePlugins(now);
    expect(sweepIdlePlugins(now)).toEqual([]);
  });
});
