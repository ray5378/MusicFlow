// Unit tests for services/plugin/libraryMatch.ts matchSongsToLibrary —
// 歌单/专辑搜索「加入库」导入前的库内匹配(方案A:先匹配库、缺了才进)。
//   - 归一化标题精确 + 歌手互含(硬)/时长±5s 专辑一致(软) 的四维评分
//   - 歌手不符 = 同名异曲,绝不绑
//   - 同分并列:本地/WebDAV 优先于 web,再按时长差最小
//   - group_key 为空的存量行不可匹配
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { matchSongsToLibrary } from "../../src/services/plugin/libraryMatch.js";
import { songGroupKey } from "../../src/utils/songGroup.js";

const MARK = "libmatch-test";

function insertSong(o: {
  id: string; title: string; artist: string; album?: string; duration?: number;
  type?: string; groupKey?: string | null;
}) {
  const gk = o.groupKey === undefined ? songGroupKey(o.title, o.artist, o.album || "") : o.groupKey;
  sqlite.prepare(`
    INSERT INTO songs (id, title, artist, album, duration, type, path, group_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `).run(o.id, o.title, o.artist, o.album || "", o.duration || 0, o.type || "local", gk,
    new Date().toISOString(), new Date().toISOString());
  MARK_TRACKER.add(o.id);
}

const MARK_TRACKER = new Set<string>();

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  const del = sqlite.prepare("DELETE FROM songs WHERE id = ?");
  for (const id of MARK_TRACKER) del.run(id);
});

describe("matchSongsToLibrary — 导入前库内匹配", () => {
  it("同歌同歌手(含版本词括号差异)命中已有行", () => {
    insertSong({ id: `${MARK}-1`, title: "甲乙丙丁(你我怎么两清)", artist: "李佳薇", album: "黑马", duration: 275, type: "web" });
    const res = matchSongsToLibrary([
      { name: "甲乙丙丁 (你我怎么两清)", artist: "李佳薇", album: "黑马", duration: 275 },
    ]);
    expect(res[0]).toBe(`${MARK}-1`);
  });

  it("歌手互相包含(G.E.M.邓紫棋 vs 邓紫棋)命中;歌手不符 = 同名异曲拒绑", () => {
    insertSong({ id: `${MARK}-2`, title: "倒数", artist: "邓紫棋", album: "另一个童话", duration: 222 });
    insertSong({ id: `${MARK}-3`, title: "光年之外", artist: "王俊凯", album: "翻唱集", duration: 235 });
    const res = matchSongsToLibrary([
      { name: "倒数", artist: "G.E.M.邓紫棋", album: "另一个童话", duration: 222 },
      { name: "光年之外", artist: "邓紫棋", album: "太空旅客", duration: 235 }, // 歌手不符
    ]);
    expect(res[0]).toBe(`${MARK}-2`);
    expect(res[1]).toBeNull();
  });

  it("同分并列:local 行优先于 web 行;时长差最小再择优", () => {
    insertSong({ id: `${MARK}-4`, title: "优先题", artist: "并列歌手", album: "并列专辑", duration: 200, type: "web" });
    insertSong({ id: `${MARK}-5`, title: "优先题", artist: "并列歌手", album: "并列专辑", duration: 201, type: "local" });
    insertSong({ id: `${MARK}-6`, title: "时长题", artist: "并列歌手", album: "并列专辑", duration: 300, type: "web" });
    insertSong({ id: `${MARK}-7`, title: "时长题", artist: "并列歌手", album: "并列专辑", duration: 302, type: "web" });
    const res = matchSongsToLibrary([
      { name: "优先题", artist: "并列歌手", album: "并列专辑", duration: 200 },
      { name: "时长题", artist: "并列歌手", album: "并列专辑", duration: 302 },
    ]);
    expect(res[0]).toBe(`${MARK}-5`); // local 优先
    expect(res[1]).toBe(`${MARK}-7`); // 时长差最小
  });

  it("group_key 为空的存量行不可匹配(回退原入库行为)", () => {
    insertSong({ id: `${MARK}-8`, title: "无组歌", artist: "无组歌手", album: "无组专辑", duration: 180, groupKey: null });
    const res = matchSongsToLibrary([
      { name: "无组歌", artist: "无组歌手", album: "无组专辑", duration: 180 },
    ]);
    expect(res[0]).toBeNull();
  });

  it("批量返回与入参等长且顺序对齐;无标题歌返回 null", () => {
    insertSong({ id: `${MARK}-9`, title: "批量歌", artist: "批量人", album: "批量专辑", duration: 100 });
    const res = matchSongsToLibrary([
      { name: "批量歌", artist: "批量人", album: "批量专辑", duration: 100 },
      { name: "", artist: "没人", album: "", duration: 0 },
    ]);
    expect(res).toHaveLength(2);
    expect(res[0]).toBe(`${MARK}-9`);
    expect(res[1]).toBeNull();
  });
});
