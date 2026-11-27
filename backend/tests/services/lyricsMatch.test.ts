import { describe, it, expect } from "vitest";
import { lrcBelongsToSong, MIN_LYRIC_LINES } from "../../src/services/lyricsMatch.js";

// 歌词匹配判据：纯函数。占位文本/String 逐字歌词、标题行比对、时长上界、歌手严格模式。
const song = { title: "狂信者", artist: "黄立行", album: "狂信者", duration: 240 };

function lrc(titleLine: string, extra = ""): string {
  return `[00:00.00]${titleLine}\n` +
    `[00:10.00}line1\n[00:20.00]line2\n[00:30.00]line3\n[00:40.00]line4\n[00:50.00]line5\n${extra}`;
}

describe("lrcBelongsToSong（歌词归属判据）", () => {
  it("MIN_LYRIC_LINES=5", () => {
    expect(MIN_LYRIC_LINES).toBe(5);
  });

  it("空内容 → false", () => {
    expect(lrcBelongsToSong("", song)).toBe(false);
  });

  it("占位文本（行数 < 5）→ false", () => {
    expect(lrcBelongsToSong("[00:01.58]纯音乐，请欣赏", song)).toBe(false);
    expect(lrcBelongsToSong("此歌曲为没有填词的纯音乐，请您欣赏", song)).toBe(false);
  });

  it("逐字歌词（一行到底但时间戳 ≥5）不被误杀", () => {
    const karaoke = "[00:01.00]我[00:01.50]爱[00:02.00]你[00:02.50]的[00:03.00]歌[00:03.50]声";
    // 无标题行 → 无从判断歌名，放行；时间戳 6 个 ≥5 → 不是占位文本
    expect(lrcBelongsToSong(karaoke, { title: "任意歌", artist: "", duration: 240 })).toBe(true);
  });

  it("标题行歌名匹配 → true", () => {
    const content = lrc("黄立行 - 狂信者");
    expect(lrcBelongsToSong(content, song)).toBe(true);
  });

  it("标题行歌名完全不符（另一首歌整篇）→ false", () => {
    const content = lrc("黄立行 - 分开旅行");
    expect(lrcBelongsToSong(content, song)).toBe(false);
  });

  it("繁简 / 去括号 / 大小写归一后匹配 → true", () => {
    const content = lrc("黃立行 - 狂信者（Live版）");
    expect(lrcBelongsToSong(content, song)).toBe(true);
  });

  it("末行时间戳超过歌曲时长 30s 以上 → false", () => {
    const content = lrc("黄立行 - 狂信者", "[99:00.00]最后一行\n");
    expect(lrcBelongsToSong(content, song)).toBe(false);
  });

  it("无标题行的纯时间轴歌词 → 放行", () => {
    const content = "[00:10.00]line1\n[00:20.00]line2\n[00:30.00]line3\n[00:40.00]line4\n[00:50.00]line5";
    expect(lrcBelongsToSong(content, song)).toBe(true);
  });
});
