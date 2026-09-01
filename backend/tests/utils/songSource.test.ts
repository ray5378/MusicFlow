// songSourceInfo 单测:web 歌曲来源(插件 id + 平台 id)解析。
// 覆盖 sourceData 优先、path 兜底、退化 path(无平台)、本地歌曲返回空来源。
import { describe, it, expect } from "vitest";
import { songSourceInfo } from "../../src/utils/songSource.js";

describe("songSourceInfo", () => {
  it("本地歌曲不输出来源", () => {
    expect(songSourceInfo({ type: "local", path: "l:music:foo.mp3" })).toEqual({
      isWeb: false, sourcePlatform: "", sourcePluginId: "",
    });
  });

  it("web 歌曲从 sourceData.source 解析平台与插件", () => {
    const info = songSourceInfo({
      type: "web",
      pluginEntry: "go-music-dl",
      sourceData: JSON.stringify({ provider: "go-music-dl", source: "netease", remoteId: "123" }),
      path: "web:go-music-dl:netease",
    });
    expect(info).toEqual({ isWeb: true, sourcePlatform: "netease", sourcePluginId: "go-music-dl" });
  });

  it("sourceData 缺失/为空时从 path 兜底解析", () => {
    expect(songSourceInfo({ type: "web", pluginEntry: "go-music-dl", sourceData: "", path: "web:go-music-dl:qq" }))
      .toEqual({ isWeb: true, sourcePlatform: "qq", sourcePluginId: "go-music-dl" });
    expect(songSourceInfo({ type: "web", pluginEntry: "go-music-dl", sourceData: null, path: "web:go-music-dl:kugou" }))
      .toEqual({ isWeb: true, sourcePlatform: "kugou", sourcePluginId: "go-music-dl" });
  });

  it("sourceData 损坏(非法 JSON)时走 path 兜底", () => {
    expect(songSourceInfo({ type: "web", pluginEntry: "go-music-dl", sourceData: "{oops", path: "web:go-music-dl:kuwo" }))
      .toEqual({ isWeb: true, sourcePlatform: "kuwo", sourcePluginId: "go-music-dl" });
  });

  it("退化 path(web:<plugin>,无平台段)返回空平台", () => {
    expect(songSourceInfo({ type: "web", pluginEntry: "go-music-dl", sourceData: "{}", path: "web:go-music-dl" }))
      .toEqual({ isWeb: true, sourcePlatform: "", sourcePluginId: "go-music-dl" });
    // path 平台段与插件 id 相同(历史退化写入)视为无法确定平台
    expect(songSourceInfo({ type: "web", pluginEntry: "go-music-dl", sourceData: "", path: "web:go-music-dl:go-music-dl" }))
      .toEqual({ isWeb: true, sourcePlatform: "", sourcePluginId: "go-music-dl" });
  });

  it("sourceData 优先于 path(两者不一致时以 sourceData 为准)", () => {
    expect(songSourceInfo({
      type: "web", pluginEntry: "go-music-dl",
      sourceData: JSON.stringify({ source: "qq" }),
      path: "web:go-music-dl:netease",
    })).toEqual({ isWeb: true, sourcePlatform: "qq", sourcePluginId: "go-music-dl" });
  });
});
