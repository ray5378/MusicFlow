// ==================== 在线歌曲来源解析(songSourceInfo) ====================
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { songSourceInfo } from "../../src/utils/songSource.js";

describe("songSourceInfo", () => {
  it("非 web 类型一律返回空来源(前端不显示徽标)", () => {
    expect(songSourceInfo({ type: "local", path: "/a/b.mp3" })).toEqual({
      isWeb: false,
      sourcePlatform: "",
      sourcePluginId: "",
    });
    expect(songSourceInfo({ type: "webdav", path: "webdav:/x.mp3", pluginEntry: "p" }).isWeb).toBe(false);
    expect(songSourceInfo({}).isWeb).toBe(false);
  });

  it("web 类型:从 source_data.source 取平台", () => {
    const r = songSourceInfo({
      type: "web",
      pluginEntry: "go-music-dl",
      sourceData: JSON.stringify({ source: "netease", id: "1" }),
    });
    expect(r).toEqual({ isWeb: true, sourcePlatform: "netease", sourcePluginId: "go-music-dl" });
  });

  it("extra.streamSource 优先(换源出流平台覆盖登记值)", () => {
    const r = songSourceInfo({
      type: "web",
      pluginEntry: "p",
      sourceData: JSON.stringify({ source: "netease", extra: { streamSource: "qq" } }),
    });
    expect(r.sourcePlatform).toBe("qq");
  });

  it("extra.streamSource 为空串时不覆盖", () => {
    const r = songSourceInfo({
      type: "web",
      sourceData: JSON.stringify({ source: "netease", extra: { streamSource: "" } }),
    });
    expect(r.sourcePlatform).toBe("netease");
  });

  it("source_data 损坏(JSON 解析失败)→ 走 path 兜底,不抛错", () => {
    const r = songSourceInfo({ type: "web", pluginEntry: "p", sourceData: "{not-json", path: "web:p:kugou" });
    expect(r.sourcePlatform).toBe("kugou");
    expect(r.sourcePluginId).toBe("p");
  });

  it("无 source 时按 path 约定 'web:<plugin>:<source>' 兜底", () => {
    expect(songSourceInfo({ type: "web", path: "web:plugin-x:qq" }).sourcePlatform).toBe("qq");
  });

  it("早期 path 缺 source('web:<plugin>')→ 平台落空串", () => {
    expect(songSourceInfo({ type: "web", path: "web:plugin-x" }).sourcePlatform).toBe("");
  });

  it("path 兜底时 cand === plugin 视为无平台", () => {
    expect(songSourceInfo({ type: "web", path: "web:same:same" }).sourcePlatform).toBe("");
  });

  it("既无 source 也无 path → 平台空串但 isWeb 仍为 true", () => {
    const r = songSourceInfo({ type: "web", pluginEntry: "p" });
    expect(r.isWeb).toBe(true);
    expect(r.sourcePlatform).toBe("");
    expect(r.sourcePluginId).toBe("p");
  });

  it("pluginEntry 缺失 → sourcePluginId 空串", () => {
    expect(songSourceInfo({ type: "web", sourceData: JSON.stringify({ source: "qq" }) }).sourcePluginId).toBe("");
  });
});
