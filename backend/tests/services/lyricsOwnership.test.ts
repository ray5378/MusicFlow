// 歌词归属校验（lrcBelongsToSong）的单测：错词是 2026-11-21 真机问题。
import { describe, expect, it } from "vitest";
import { lrcBelongsToSong } from "../../src/services/lyrics.js";
// 2026-11-22:内容可用性闸门要求 ≥5 行，身份类用例的假歌词统一补足。
const L5 = (s: string) => s + "\n[00:40.00]l4\n[00:50.00]l5\n[01:00.00]l6\n[01:10.00]l7";

const SONG = { title: "狂信者", artist: "黄立行", duration: 221 };

describe("lrcBelongsToSong", () => {
  it("标题行是另一首歌（同歌手）→ 不是这首歌的歌词", () => {
    const lrc = L5("[00:00.27]刘若英、黄立行 - 分开旅行\n[00:30.32]男：我选择去洛杉矶");
    expect(lrcBelongsToSong(lrc, SONG)).toBe(false);
  });

  it("标题行就是这首歌 → 放行", () => {
    const lrc = L5("[00:00.00]狂信者 - 黄立行 Huang Stanley\n[00:06.31]词：黄立行/崔惟楷\n[00:20.00]第二句正文\n[00:30.00]第三句正文");
    expect(lrcBelongsToSong(lrc, SONG)).toBe(true);
  });

  it("艺人在前、歌名在后也能认（A - B 两种顺序）", () => {
    const lrc = L5("[00:00.00]黄立行 - 狂信者\n[00:06.00]正文\n[00:20.00]第二句正文\n[00:30.00]第三句正文");
    expect(lrcBelongsToSong(lrc, SONG)).toBe(true);
  });

  it("没有标题行（纯时间轴）→ 无从判断，放行", () => {
    const lrc = L5("[00:12.00]第一句\n[00:15.00]第二句\n[00:18.00]第三句");
    expect(lrcBelongsToSong(lrc, SONG)).toBe(true);
  });

  it("繁简差异不算不匹配", () => {
    const lrc = L5("[00:00.00]癡心換情深 - 周慧敏\n[00:05.00]正文\n[00:20.00]第二句正文\n[00:30.00]第三句正文");
    expect(lrcBelongsToSong(lrc, { title: "痴心换情深", duration: 260 })).toBe(true);
  });

  it("逐字行（一字一个时间戳）不会被当成标题行", () => {
    const lrc =
      L5("[00:00.63]天[00:00.89]地[00:01.35]龙\n[00:04.00]第一句正文\n[00:08.00]第二句正文");
    expect(lrcBelongsToSong(lrc, { title: "天地龙鳞", duration: 240 })).toBe(true);
  });

  it("末行时间戳比歌曲时长长 30s 以上 → 不是同一首", () => {
    const lrc = L5("[00:00.00]狂信者 - 黄立行\n[05:30.00]尾巴");
    expect(lrcBelongsToSong(lrc, SONG)).toBe(false);
  });

  it("空内容直接不通过", () => {
    expect(lrcBelongsToSong("", SONG)).toBe(false);
  });
});

describe("lrcBelongsToSong 不误杀", () => {
  it("歌词正文带连字符、歌手也没出现 → 放行（正文不是标题行）", () => {
    const lrc = L5("[00:00.00]a-only lyric\n[00:20.00]第二句正文\n[00:30.00]第三句正文");
    expect(lrcBelongsToSong(lrc, { title: "A Only", artist: "A", duration: 100 })).toBe(true);
  });

  it("标题对不上但同一行出现了歌手 → 否决（同歌手另一首）", () => {
    const lrc = L5("[00:00.00]刘若英、黄立行 - 分开旅行");
    expect(lrcBelongsToSong(lrc, { title: "狂信者", artist: "黄立行", duration: 221 })).toBe(false);
  });
});

describe("lrcBelongsToSong 标题顺序与连字符", () => {
  it("歌名 - 艺人（我们自己的命名规则）→ 认", () => {
    const lrc = L5("[00:00.00]狂信者 - 黄立行\n[00:10.00]第二句正文\n[00:20.00]第三句正文");
    expect(lrcBelongsToSong(lrc, { title: "狂信者", artist: "黄立行", duration: 221 })).toBe(true);
  });

  it("艺人 - 歌名 → 同样认（顺序无关）", () => {
    const lrc = L5("[00:00.00]黄立行 - 狂信者\n[00:10.00]第二句正文\n[00:20.00]第三句正文");
    expect(lrcBelongsToSong(lrc, { title: "狂信者", artist: "黄立行", duration: 221 })).toBe(true);
  });

  it("歌名本身带连字符（A-B）→ 整行比对仍认得出", () => {
    const lrc = L5("[00:00.00]A-B - 歌手\n[00:10.00]第二句正文\n[00:20.00]第三句正文");
    expect(lrcBelongsToSong(lrc, { title: "A-B", artist: "歌手", duration: 200 })).toBe(true);
  });
});

describe("lrcBelongsToSong 内容可用性（非歌词文本）", () => {
  const SONG = { title: "该死的温柔", artist: "马天宇,斯琴高丽", duration: 225 };

  it("只有一行的作者简介/版权声明 → 不是歌词", () => {
    const lrc =
      "[01:43.00]四川音乐学院毕业，学习钢琴、小提琴、作曲。自己编写的谱子，亲自演奏，希望大家喜欢！ 未经许可,不得翻唱或使用";
    expect(lrcBelongsToSong(lrc, SONG)).toBe(false);
  });

  it("「纯音乐，请欣赏」占位 → 不是歌词", () => {
    expect(lrcBelongsToSong("[00:01.58]纯音乐，请欣赏", SONG)).toBe(false);
  });

  it("只有 [ti:]/[ar:] 头部、没有正文 → 不是歌词", () => {
    expect(lrcBelongsToSong("[ti:该死的温柔]\n[ar:马天宇]", SONG)).toBe(false);
  });

  it("多行正文（无时间轴）→ 是歌词", () => {
    const lrc =
      "想要光着脚丫 在树上唱歌\n你说的每个笑话我都笑了\n是你变幽默还是我变快乐\n好久不见你说什么\n我一直在想";
    expect(lrcBelongsToSong(lrc, { title: "在树上唱歌", duration: 250 })).toBe(true);
  });
});

describe("lrcBelongsToSong 多歌手分词（2026-11-22 大宝剑实例）", () => {
  it("标题行是专辑同名曲（只出现其中一个歌手）→ 否决", () => {
    const lrc =
      "[00:00.00]From Boys to Men - 新街口组合/大宝Bles.P\n[00:10.00]词：某人\n[00:20.00]第一句正文\n[00:30.00]第二句正文\n[00:40.00]第三句正文";
    expect(
      lrcBelongsToSong(lrc, { title: "大宝剑", artist: "王麟,新街口组合", duration: 254 }),
    ).toBe(false);
  });

  it("标题行含全部歌手 → 放行（同一首的常见写法）", () => {
    const lrc =
      "[00:00.00]大宝剑 - 王麟/新街口组合\n[00:10.00]第一句正文\n[00:20.00]第二句正文\n[00:30.00]第三句正文\n[00:40.00]第四句正文";
    expect(
      lrcBelongsToSong(lrc, { title: "大宝剑", artist: "王麟,新街口组合", duration: 254 }),
    ).toBe(true);
  });
});
