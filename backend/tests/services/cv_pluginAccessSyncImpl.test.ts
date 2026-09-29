// ==================== 覆盖率 C 类缺口:playlistSyncApi 的方法驱动分发 ====================
//
// 目标:src/services/pluginAccess.ts 111-117 —— playlistSyncApi() 在 enabled-by-
// capability("playlistSync") 的插件里优先选第一个 impl.rebuildPlaylistEntries 为函数的;
// 都没有实现时回落 enabled[0]?.impl(单例陷阱:只实现 runSyncJob 的外置插件不得劫持
// 核心的导入/重建调用)。
//
// mock 策略:pluginAccess.ts 只依赖 ../plugins/registry.js(无 DB/IO),整体 mock
// registry 三个导出符号,用 hoisted 状态注入 enabled 列表。注意本文件位于
// out/tests/services/,相对深度与 tests/services/ 一致,路径 ../../src/...。
import { describe, it, expect, beforeEach, vi } from "vitest";

const M = vi.hoisted(() => ({
  enabled: [] as any[],
}));

vi.mock("../../src/plugins/registry.js", () => ({
  getEnabledByCapability: (cap: string) => (cap === "playlistSync" ? M.enabled : []),
  getPluginConfig: (_id: string) => null,
  getPluginManifest: (_id: string) => undefined,
}));

import { playlistSyncApi } from "../../src/services/pluginAccess.js";

beforeEach(() => {
  M.enabled = [];
});

describe("playlistSyncApi:方法驱动分发(优先 rebuildPlaylistEntries 实现)", () => {
  it("首位插件没有 rebuildPlaylistEntries → 跳过,选中后面带该方法的 impl", () => {
    const thirdParty = { runSyncJob: async () => ({}) };
    const withRebuild = { rebuildPlaylistEntries: async () => ({}), checkImportCooldown: () => false };
    M.enabled = [
      { manifest: { id: "third-party-sync" }, impl: thirdParty },
      { manifest: { id: "playlist-sync" }, impl: withRebuild },
    ];
    expect(playlistSyncApi()).toBe(withRebuild);
  });

  it("首个插件就实现了 rebuildPlaylistEntries → 直接选中它(不往后找)", () => {
    const first = { rebuildPlaylistEntries: async () => ({}), runSyncJob: async () => ({}) };
    const second = { rebuildPlaylistEntries: async () => ({}) };
    M.enabled = [
      { manifest: { id: "playlist-sync" }, impl: first },
      { manifest: { id: "another" }, impl: second },
    ];
    expect(playlistSyncApi()).toBe(first);
  });

  it("所有启用插件都未实现 rebuildPlaylistEntries → 回落 enabled[0].impl", () => {
    const only = { runSyncJob: async () => ({}) };
    M.enabled = [
      { manifest: { id: "a" }, impl: only },
      { manifest: { id: "b" }, impl: { runSyncJob: async () => ({}) } },
    ];
    expect(playlistSyncApi()).toBe(only);
  });

  it("该能力无启用插件 → undefined(调用方负责给出可读错误)", () => {
    M.enabled = [];
    expect(playlistSyncApi()).toBeUndefined();
  });
});
