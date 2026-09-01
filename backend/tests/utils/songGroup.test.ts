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
  it("标题+歌手+专辑拼接,大小写不敏感", () => {
    const a = songGroupKey("青花瓷", "周杰伦", "依然范特西");
    const b = songGroupKey(" 青花瓷 ", "周杰伦", "依然范特西 ");
    expect(a).toBe(b);
    expect(songGroupKey("Stay", "The Kid LAROI")).not.toBe(songGroupKey("Stay", "Other"));
    // 专辑不同 → key 不同(版本区分靠专辑)
    expect(songGroupKey("Stay", "Kid LAROI", "A")).not.toBe(songGroupKey("Stay", "Kid LAROI", "B"));
    // 专辑缺失与空串等价(web 导入可能没专辑)
    expect(songGroupKey("Stay", "Kid LAROI")).toBe(songGroupKey("Stay", "Kid LAROI", ""));
  });
});

describe("durationInRange", () => {
  it("±1s 内为 true(秒级)", () => {
    expect(durationInRange(210, 210)).toBe(true);
    expect(durationInRange(210, 211)).toBe(true);
    expect(durationInRange(210, 209)).toBe(true);
  });
  it("超 1s 为 false", () => {
    expect(durationInRange(210, 212)).toBe(false);
    expect(durationInRange(210, 213)).toBe(false);
    expect(durationInRange(210, 208)).toBe(false);
  });
  it("未知时长(0)不参与容差比较", () => {
    expect(durationInRange(0, 0)).toBe(false);
    expect(durationInRange(210, 0)).toBe(false);
    expect(durationInRange(0, 210)).toBe(false);
  });
});

describe("assignSongGroups", () => {
  it("同 key(标题+歌手+专辑)同 duration 归同组", () => {
    const m = assignSongGroups([
      { id: "a", title: "Stay", artist: "Kid LAROI", album: "F*CK LOVE", duration: 210 },
      { id: "b", title: "stay", artist: "kid laroi", album: "f*ck love", duration: 210 },
    ]);
    expect(m.get("a")!.groupId).toBe(m.get("b")!.groupId);
    expect(m.get("a")!.groupKey).toBe(songGroupKey("Stay", "Kid LAROI", "F*CK LOVE"));
  });
  it("同 key 差 1s 归同组(秒级容差内)", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", album: "Z", duration: 210 },
      { id: "b", title: "X", artist: "Y", album: "Z", duration: 211 },
    ]);
    expect(m.get("a")!.groupId).toBe(m.get("b")!.groupId);
  });
  it("同 key 差 2s 不归组(超秒级容差)", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", album: "Z", duration: 210 },
      { id: "b", title: "X", artist: "Y", album: "Z", duration: 212 },
    ]);
    expect(m.get("a")!.groupId).not.toBe(m.get("b")!.groupId);
  });
  it("专辑不同不归组(版本靠专辑区分)", () => {
    const m = assignSongGroups([
      { id: "a", title: "Stay", artist: "Kid LAROI", album: "F*CK LOVE", duration: 210 },
      { id: "b", title: "Stay", artist: "Kid LAROI", album: "F*CK LOVE 3", duration: 210 },
    ]);
    expect(m.get("a")!.groupId).not.toBe(m.get("b")!.groupId);
  });
  it("专辑缺失与空串等价(同一张无专辑记录)", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", album: undefined, duration: 210 },
      { id: "b", title: "X", artist: "Y", album: "", duration: 210 },
    ]);
    expect(m.get("a")!.groupId).toBe(m.get("b")!.groupId);
  });
  it("链式 180/181/182 相邻差≤1 全归一组", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", album: "Z", duration: 180 },
      { id: "b", title: "X", artist: "Y", album: "Z", duration: 181 },
      { id: "c", title: "X", artist: "Y", album: "Z", duration: 182 },
    ]);
    const gid = m.get("a")!.groupId;
    expect(m.get("b")!.groupId).toBe(gid);
    expect(m.get("c")!.groupId).toBe(gid);
  });
  it("不同标题不归组", () => {
    const m = assignSongGroups([
      { id: "a", title: "Stay", artist: "X", album: "Z", duration: 210 },
      { id: "b", title: "Stay (Live)", artist: "X", album: "Z", duration: 210 },
    ]);
    expect(m.get("a")!.groupId).not.toBe(m.get("b")!.groupId);
  });
  it("未知时长(0)同名不合并", () => {
    const m = assignSongGroups([
      { id: "a", title: "X", artist: "Y", album: "Z", duration: 0 },
      { id: "b", title: "X", artist: "Y", album: "Z", duration: 0 },
    ]);
    expect(m.get("a")!.groupId).not.toBe(m.get("b")!.groupId);
  });
  it("单曲独立成组", () => {
    const m = assignSongGroups([{ id: "a", title: "Solo", artist: "A", album: "B", duration: 100 }]);
    expect(m.get("a")!.groupId).toMatch(/^g-/);
  });
  it("无标题/无歌手不参与分组", () => {
    const m = assignSongGroups([{ id: "a", title: "", artist: "", duration: 100 }]);
    expect(m.has("a")).toBe(false);
  });
});

describe("findGroupForSong", () => {
  it("候选组内成员差 ≤1s 返回该组", () => {
    expect(findGroupForSong(
      [{ id: "x", groupId: "g-1", duration: 210 }],
      211,
    )).toBe("g-1");
  });
  it("差超 1s 返回 null", () => {
    expect(findGroupForSong(
      [{ id: "x", groupId: "g-1", duration: 210 }],
      212,
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
