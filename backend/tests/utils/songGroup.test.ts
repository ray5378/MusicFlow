import { describe, it, expect } from "vitest";
import {
  normalizeGroupText,
  songGroupKey,
  durationInRange,
  assignSongGroups,
  findGroupForSong,
} from "../../src/utils/songGroup.js";

describe("normalizeGroupText", () => {
  it("大小写、全角空格、折叠空白", () => {
    expect(normalizeGroupText("   Hello  World\u3000 ")).toBe("hello world");
  });
  it("去首尾非字母数字", () => {
    expect(normalizeGroupText("《青花瓷》")).toBe("青花瓷");
    expect(normalizeGroupText(" - Stay - ")).toBe("stay");
  });
  it("保留内部版本词(靠标题差异区分),对称剥装饰符号", () => {
    expect(normalizeGroupText("Stay (Live)")).toBe("stay live");
    expect(normalizeGroupText("Stay [Live]")).toBe("stay live");
    expect(normalizeGroupText("Stay (Remix)")).toBe("stay remix");
    expect(normalizeGroupText("Stay (Live)")).not.toBe(normalizeGroupText("Stay"));
  });
});

describe("songGroupKey", () => {
  it("标题+歌手拼接,大小写不敏感", () => {
    const a = songGroupKey("青花瓷", "周杰伦");
    const b = songGroupKey(" 青花瓷 ", "周杰伦");
    expect(a).toBe(b);
    expect(songGroupKey("Stay", "The Kid LAROI")).not.toBe(songGroupKey("Stay", "Other"));
  });
});

describe("durationInRange", () => {
  it("±3s 内为 true", () => {
    expect(durationInRange(210, 208)).toBe(true);
    expect(durationInRange(210, 213)).toBe(true);
    expect(durationInRange(210, 210)).toBe(true);
  });
  it("超 3s 为 false", () => {
    expect(durationInRange(210, 214)).toBe(false);
    expect(durationInRange(210, 205)).toBe(false);
  });
  it("未知时长(0)不参与容差比较", () => {
    expect(durationInRange(0, 0)).toBe(false);
    expect(durationInRange(210, 0)).toBe(false);
    expect(durationInRange(0, 210)).toBe(false);
  });
});

describe("assignSongGroups", () => {
  it("同 key 同 duration 归同组", () => {
    const m = assignSongGroups([
      { id: "a", title: "Stay", artist: "Kid LAROI", duration: 210 },
      { id: "b", title: "stay", artist: "kid laroi", duration: 210 },
    ]);
    expect(m.get("a")!.groupId).toBe(m.get("b")!.groupId);
    expect(m.get("a")!.groupKey).toBe(songGroupKey("Stay", "Kid LAROI"));
  });
  it("同 key 差 2s 归同组(容差内)", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", duration: 210 },
      { id: "b", title: "X", artist: "Y", duration: 212 },
    ]);
    expect(m.get("a")!.groupId).toBe(m.get("b")!.groupId);
  });
  it("同 key 差 5s 不归组(超容差)", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", duration: 210 },
      { id: "b", title: "X", artist: "Y", duration: 215 },
    ]);
    expect(m.get("a")!.groupId).not.toBe(m.get("b")!.groupId);
  });
  it("链式:180/182/184 两两相邻差≤3 全归一组", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", duration: 180 },
      { id: "b", title: "X", artist: "Y", duration: 182 },
      { id: "c", title: "X", artist: "Y", duration: 184 },
    ]);
    const gid = m.get("a")!.groupId;
    expect(m.get("b")!.groupId).toBe(gid);
    expect(m.get("c")!.groupId).toBe(gid);
  });
  it("不同标题不归组", () => {
    const m = assignSongGroups([
      { id: "a", title: "Stay", artist: "X", duration: 210 },
      { id: "b", title: "Stay (Live)", artist: "X", duration: 210 },
    ]);
    expect(m.get("a")!.groupId).not.toBe(m.get("b")!.groupId);
  });
  it("未知时长(0)同名不合并", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", duration: 0 },
      { id: "b", title: "X", artist: "Y", duration: 0 },
    ]);
    expect(m.get("a")!.groupId).not.toBe(m.get("b")!.groupId);
  });
  it("单曲独立成组", () => {
    const m = assignSongGroups([{ id: "a", title: "Solo", artist: "A", duration: 100 }]);
    expect(m.get("a")!.groupId).toMatch(/^g-/);
  });
  it("无标题/无歌手不参与分组", () => {
    const m = assignSongGroups([{ id: "a", title: "", artist: "", duration: 100 }]);
    expect(m.has("a")).toBe(false);
  });
});

describe("findGroupForSong", () => {
  it("候选组内成员差 ≤3 返回该组", () => {
    expect(findGroupForSong(
      [{ id: "x", groupId: "g-1", duration: 210 }],
      211,
    )).toBe("g-1");
  });
  it("差超限返回 null", () => {
    expect(findGroupForSong(
      [{ id: "x", groupId: "g-1", duration: 210 }],
      215,
    )).toBeNull();
  });
  it("未知时长不并入(保守)", () => {
    expect(findGroupForSong(
      [{ id: "x", groupId: "g-1", duration: 210 }],
      0,
    )).toBeNull();
  });
  it("多候选组取时长最接近者", () => {
    expect(findGroupForSong(
      [
        { id: "a", groupId: "g-1", duration: 200 },
        { id: "b", groupId: "g-2", duration: 212 },
      ],
      211,
    )).toBe("g-2");
  });
});
