// 歌词归属校验（lrcBelongsToSong）的单测：错词是 2026-11-21 真机问题。
import { describe, expect, it } from "vitest";
import { lrcBelongsToSong } from "../../src/services/lyrics.js";

const SONG = { title: "狂信者", artist: "黄立行", duration: 221 };

describe("lrcBelongsToSong", () => {
  it("标题行是另一首歌（同歌手）→ 不是这首歌的歌词", () => {
    const lrc = "[00:00.27]刘若英、黄立行 - 分开旅行\n[00:30.32]男：我选择去洛杉矶";
    expect(lrcBelongsToSong(lrc, SONG)).toBe(false);
  });

  it("标题行就是这首歌 → 放行", () => {
    const lrc = "[00:00.00]狂信者 - 黄立行 Huang Stanley\n[00:06.31]词：黄立行/崔惟楷";
    expect(lrcBelongsToSong(lrc, SONG)).toBe(true);
  });

  it("艺人在前、歌名在后也能认（A - B 两种顺序）", () => {
    const lrc = "[00:00.00]黄立行 - 狂信者\n[00:06.00]正文";
    expect(lrcBelongsToSong(lrc, SONG)).toBe(true);
  });

  it("没有标题行（纯时间轴）→ 无从判断，放行", () => {
    const lrc = "[00:12.00]第一句\n[00:15.00]第二句";
    expect(lrcBelongsToSong(lrc, SONG)).toBe(true);
  });

  it("繁简差异不算不匹配", () => {
    const lrc = "[00:00.00]癡心換情深 - 周慧敏\n[00:05.00]正文";
    expect(lrcBelongsToSong(lrc, { title: "痴心换情深", duration: 260 })).toBe(true);
  });

  it("逐字行（一字一个时间戳）不会被当成标题行", () => {
    const lrc = "[00:00.63]天[00:00.89]地[00:01.35]龙";
    expect(lrcBelongsToSong(lrc, { title: "天地龙鳞", duration: 240 })).toBe(true);
  });

  it("末行时间戳比歌曲时长长 30s 以上 → 不是同一首", () => {
    const lrc = "[00:00.00]狂信者 - 黄立行\n[05:30.00]尾巴";
    expect(lrcBelongsToSong(lrc, SONG)).toBe(false);
  });

  it("空内容直接不通过", () => {
    expect(lrcBelongsToSong("", SONG)).toBe(false);
  });
});

describe("lrcBelongsToSong 不误杀", () => {
  it("歌词正文带连字符、歌手也没出现 → 放行（正文不是标题行）", () => {
    const lrc = "[00:00.00]a-only lyric";
    expect(lrcBelongsToSong(lrc, { title: "A Only", artist: "A", duration: 100 })).toBe(true);
  });

  it("标题对不上但同一行出现了歌手 → 否决（同歌手另一首）", () => {
    const lrc = "[00:00.00]刘若英、黄立行 - 分开旅行";
    expect(lrcBelongsToSong(lrc, { title: "狂信者", artist: "黄立行", duration: 221 })).toBe(false);
  });
});

describe("lrcBelongsToSong 标题顺序与连字符", () => {
  it("歌名 - 艺人（我们自己的命名规则）→ 认", () => {
    expect(
      lrcBelongsToSong("[00:00.00]狂信者 - 黄立行", { title: "狂信者", artist: "黄立行", duration: 221 }),
    ).toBe(true);
  });

  it("艺人 - 歌名 → 同样认（顺序无关）", () => {
    expect(
      lrcBelongsToSong("[00:00.00]黄立行 - 狂信者", { title: "狂信者", artist: "黄立行", duration: 221 }),
    ).toBe(true);
  });

  it("歌名本身带连字符（A-B）→ 整行比对仍认得出", () => {
    expect(
      lrcBelongsToSong("[00:00.00]A-B - 歌手", { title: "A-B", artist: "歌手", duration: 200 }),
    ).toBe(true);
  });
});
