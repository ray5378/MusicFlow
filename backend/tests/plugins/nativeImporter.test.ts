import { describe, it, expect } from "vitest";
import {
  NATIVE_IMPORTER_ID,
  NATIVE_APP,
  isNativePlaylistFile,
  parseNativePlaylists,
  parseNativePlaylist,
} from "../../src/services/plugin/importers/native.js";

// MusicFlow 原生歌单文件导入：识别 app 标记、解析单/多歌单、曲目字段归一。
describe("native importer", () => {
  const single = {
    app: NATIVE_APP,
    name: "我的歌单",
    tracks: [
      { externalId: "s:1", title: " 歌A ", artist: " artistA ", album: " alb ", duration: 200 },
      { title: "   " }, // 空标题 → 过滤
      { title: "歌B", duration: -5 }, // 非法时长 → undefined
    ],
  };

  it("常量：ID 与 app 标记", () => {
    expect(NATIVE_IMPORTER_ID).toBe("musicflow-file-importer");
    expect(NATIVE_APP).toBe("MusicFlow");
  });

  it("isNativePlaylistFile 只认 app===MusicFlow 的对象", () => {
    expect(isNativePlaylistFile(single)).toBe(true);
    expect(isNativePlaylistFile({ app: "Other" })).toBe(false);
    expect(isNativePlaylistFile(null)).toBe(false);
    expect(isNativePlaylistFile("MusicFlow")).toBe(false);
    expect(isNativePlaylistFile({})).toBe(false);
  });

  it("非原生文件 parse 抛错", () => {
    expect(() => parseNativePlaylists({ app: "Other" })).toThrow();
  });

  it("单歌单文件解析：字段 trim、时长非法回落、空标题过滤", () => {
    const out = parseNativePlaylists(single);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe("我的歌单");
    expect(out[0].platform).toBe("local");
    expect(out[0].tracks.length).toBe(2);
    // 注意：源码只 trim title，artist/album 原样保留（去空白是下游 rebuild 的事）
    expect(out[0].tracks[0]).toEqual({
      externalId: "s:1", title: "歌A", artist: " artistA ", album: " alb ", duration: 200,
    });
    expect(out[0].tracks[1].duration).toBeUndefined();
  });

  it("多歌单 envelope（playlists[]）逐块解析", () => {
    const envelope = {
      app: NATIVE_APP,
      playlists: [
        { name: "P1", tracks: [{ title: "t1" }] },
        { name: "P2", tracks: [{ title: "t2" }, { title: "t3" }] },
      ],
    };
    const out = parseNativePlaylists(envelope);
    expect(out.map((p) => p.name)).toEqual(["P1", "P2"]);
    expect(out.map((p) => p.tracks.length)).toEqual([1, 2]);
  });

  it("空 playlists[] 回落为单块解析", () => {
    const out = parseNativePlaylists({ ...single, playlists: [] });
    expect(out.length).toBe(1);
    expect(out[0].name).toBe("我的歌单");
  });

  it("无可用曲目（全空标题）抛错", () => {
    expect(() => parseNativePlaylists({ app: NATIVE_APP, tracks: [{ title: "" }] })).toThrow(/没有可用曲目/);
  });

  it("歌单名为空时回落为「导入歌单」", () => {
    const out = parseNativePlaylists({ app: NATIVE_APP, name: "   ", tracks: [{ title: "t" }] });
    expect(out[0].name).toBe("导入歌单");
  });

  it("parseNativePlaylist 是单歌单便捷封装", () => {
    expect(parseNativePlaylist(single)).toEqual(parseNativePlaylists(single)[0]);
  });
});
