// P4:importer(netease/qq)externalId 带 "source:" 前缀。
// 修复前裸 id(如 "3417947275")写入 external_song_id,后台 auto-match 无法走
// 已知 source:id 直通,只能逐曲重搜;修复后 netease:xxx / qq:xxx 可直接免搜索导入。
import "../../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { buildNeteaseTrack, extractNeteasePlaylistId } from "../../../src/services/plugin/importers/netease.js";
import { parseQQSongs, extractQQPlaylistId, extractQQToplistId } from "../../../src/services/plugin/importers/qq.js";
import { onlineSongFromExternalId } from "../../../src/services/source/online/match.js";

describe("P4 netease importer 前缀", () => {
  it("buildNeteaseTrack 产出 netease:<id>,字段映射正确", () => {
    const t = buildNeteaseTrack({ id: 123456, name: "T", ar: [{ name: "A1" }, { name: "A2" }], al: { name: "AL" }, dt: 200000 });
    expect(t).toEqual({
      externalId: "netease:123456",
      title: "T",
      artist: "A1/A2",
      album: "AL",
      duration: 200000,
    });
  });

  it("无 id 时 externalId 为空(不拼错误前缀)", () => {
    expect(buildNeteaseTrack({ name: "T" }).externalId).toBe("");
    expect(buildNeteaseTrack(null).externalId).toBe("");
  });

  it("前缀 id 能被 P0 onlineSongFromExternalId 直通解析", () => {
    const s = onlineSongFromExternalId({
      externalSongId: "netease:123456",
      externalTitle: "T",
      externalArtist: "A",
    });
    expect(s?.source).toBe("netease");
    expect(s?.id).toBe("123456");
  });
});

describe("P4 qq importer 前缀", () => {
  it("parseQQSongs 用 songmid 产出 qq:<id>", () => {
    const list = parseQQSongs([
      { songmid: "M500abc", songname: "S", singer: [{ name: "X" }], albumname: "B", interval: 210 },
    ]);
    expect(list[0].externalId).toBe("qq:M500abc");
    expect(list[0].duration).toBe(210000); // 秒 → 毫秒
    expect(list[0].artist).toBe("X");
  });

  it("无 songmid 回退 songid", () => {
    const list = parseQQSongs([{ songid: "999", songname: "S2" }]);
    expect(list[0].externalId).toBe("qq:999");
  });

  it("两者皆无时 externalId 为空", () => {
    const list = parseQQSongs([{ songname: "S3" }]);
    expect(list[0].externalId).toBe("");
  });

  it("前缀 id 能被 P0 onlineSongFromExternalId 直通解析", () => {
    const s = onlineSongFromExternalId({
      externalSongId: "qq:M500abc",
      externalTitle: "S",
      externalArtist: "X",
    });
    expect(s?.source).toBe("qq");
    expect(s?.id).toBe("M500abc");
  });
});

describe("P4 URL 解析仍正常(回归)", () => {
  it("netease id 提取", () => {
    expect(extractNeteasePlaylistId("https://music.163.com/playlist?id=111")).toBe("111");
    expect(extractNeteasePlaylistId("https://music.163.com/playlist/222/")).toBe("222");
    expect(extractNeteasePlaylistId("https://example.com/x")).toBeNull();
  });
  it("qq id / 榜单 id 提取", () => {
    expect(extractQQPlaylistId("https://y.qq.com/n/ryqq/playlist/123")).toBe("123");
    expect(extractQQToplistId("https://y.qq.com/n/ryqq/toplist/26")).toBe("26");
  });
});
