import { describe, it, expect } from "vitest";
import {
  albumIsPlaceholder,
  containsClose,
  nameCloseMatch,
  artistMatches,
  coverAllowed,
  needLyricByFile,
  normKey,
  writableAlbum,
} from "../../src/services/fetch/tagTrust.js";

describe("tagTrust — 基础归一", () => {
  it("normKey 去空白与标点、忽略大小写", () => {
    expect(normKey("  Hello, World! ")).toBe("helloworld");
    expect(normKey("（清晰版）")).toBe("清晰版");
  });

  it("歌手分词：任一 token 命中即一致；占位歌手不参与否决", () => {
    expect(artistMatches("王麟,新街口组合", "新街口组合/大宝Bles.P")).toBe(true);
    expect(artistMatches("何韵诗", "SNOW THA PRODUCT")).toBe(false);
    expect(artistMatches("Unknown Artist", "周杰伦")).toBe(true); // 占位歌手不否决
  });
});

describe("tagTrust — 专辑占位", () => {
  it("专辑=歌名 ⇒ 占位", () => {
    expect(albumIsPlaceholder("好奇心杀死猫", "好奇心杀死猫")).toBe(true);
    expect(albumIsPlaceholder("Unknown Album", "x")).toBe(true);
    expect(albumIsPlaceholder("", "x")).toBe(true);
    expect(albumIsPlaceholder("床边故事", "告白气球")).toBe(false);
  });

  it("writableAlbum：DB 可信就用 DB，DB 占位退回元数据，都不可用返回 null", () => {
    expect(writableAlbum({ dbAlbum: "床边故事", metaAlbum: "别的", title: "告白气球" })).toBe("床边故事");
    expect(writableAlbum({ dbAlbum: "告白气球", metaAlbum: "床边故事", title: "告白气球" })).toBe("床边故事");
    expect(writableAlbum({ dbAlbum: "告白气球", metaAlbum: "告白气球", title: "告白气球" })).toBeNull();
    expect(writableAlbum({ dbAlbum: "", metaAlbum: "", title: "告白气球" })).toBeNull();
  });
});

describe("tagTrust — 封面归属", () => {
  it("歌手不一致 ⇒ 拒绝（好奇心杀死猫 实例：SNOW THA PRODUCT）", () => {
    const d = coverAllowed({
      title: "好奇心杀死猫",
      artist: "何韵诗",
      dbAlbum: "好奇心杀死猫",
      metaAlbum: "PLAY",
      metaArtist: "SNOW THA PRODUCT",
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("歌手不一致");
  });

  it("歌手一致但专辑不同 ⇒ 拒绝（思念就像一条河流 实例：《追风少年》）", () => {
    const d = coverAllowed({
      title: "思念就像一条河流",
      artist: "吴奇隆",
      dbAlbum: "思念就像一条河流",
      metaAlbum: "追风少年",
      metaArtist: "吴奇隆",
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("专辑");
  });

  it("歌手与专辑都对齐 ⇒ 允许", () => {
    const d = coverAllowed({
      title: "告白气球",
      artist: "周杰伦",
      dbAlbum: "周杰伦的床边故事",
      metaAlbum: "周杰伦的床边故事",
      metaArtist: "周杰伦",
    });
    expect(d.allowed).toBe(true);
  });

  it("本曲专辑未知（空）且元数据专辑是别的专辑 ⇒ 拒绝（无从证明，宁缺勿错）", () => {
    const d = coverAllowed({
      title: "某单曲",
      artist: "某人",
      dbAlbum: "",
      metaAlbum: "某专辑",
      metaArtist: "某人",
    });
    expect(d.allowed).toBe(false);
  });

  it("本曲专辑未知，但元数据与封面同源命中 ⇒ 允许", () => {
    const d = coverAllowed({
      title: "某单曲",
      artist: "某人",
      dbAlbum: "",
      metaAlbum: "某专辑",
      metaArtist: "某人",
      metaProvider: "tag-provider",
      coverProvider: "tag-provider",
    });
    expect(d.allowed).toBe(true);
  });

  it("没有元数据：外置来源拒绝，内置/未上报放行", () => {
    expect(
      coverAllowed({ title: "t", artist: "a", coverProvider: "lx-source", builtinCover: false }).allowed,
    ).toBe(false);
    expect(
      coverAllowed({ title: "t", artist: "a", coverProvider: "tag-provider", builtinCover: true }).allowed,
    ).toBe(true);
    expect(coverAllowed({ title: "t", artist: "a" }).allowed).toBe(true);
  });
});

describe("tagTrust — 歌词判定只看文件", () => {
  it("文件无词 ⇒ 需要补（不看 DB）", () => {
    expect(needLyricByFile(undefined)).toBe(true);
    expect(needLyricByFile("   ")).toBe(true);
    expect(needLyricByFile("[00:01.00]词")).toBe(false);
  });
});

describe("tagTrust — 异体字/人名近似", () => {
  it("同长度只差一个汉字且≥3 字 ⇒ 视为同一人（叶蒨文 vs 叶倩文）", () => {
    expect(nameCloseMatch("叶蒨文", "叶倩文")).toBe(true);
    expect(nameCloseMatch("张国荣", "张国荣")).toBe(true);
  });

  it("两字名差一个字 ⇒ 不认（王菲 vs 王非）", () => {
    expect(nameCloseMatch("王菲", "王非")).toBe(false);
  });

  it("长度不同 / 差两个字 / 含非汉字 ⇒ 不认", () => {
    expect(nameCloseMatch("A-Lin", "黄丽玲")).toBe(false);
    expect(nameCloseMatch("陈百强", "陈百强强")).toBe(false);
    expect(nameCloseMatch("周杰伦", "周杰偷")).toBe(true); // 只差一字，交给其它闸门兜底
  });

  it("containsClose：带括注/英文名也能命中（叶倩文(Sally Yeh) vs 叶蒨文）", () => {
    expect(containsClose("叶倩文sallyyeh", "叶蒨文")).toBe(true);
    expect(containsClose("周杰伦jaychou", "周杰伦")).toBe(true);
    expect(containsClose("卫兰janice", "叶蒨文")).toBe(false);
  });
});
