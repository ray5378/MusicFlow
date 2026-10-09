import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAMING_CONFIG,
  buildRelativePath,
  renderTemplate,
  resolveConflict,
  sanitizeSegment,
} from "../../src/services/fetch/naming.js";
import type { NamingConfig, NamingCtx } from "../../src/services/fetch/naming.js";

function cfgOf(over: Partial<NamingConfig> = {}): NamingConfig {
  return { ...DEFAULT_NAMING_CONFIG, ...over };
}

/** 路径的 UTF-8 字节数。 */
function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

describe("buildRelativePath 默认模板", () => {
  it("默认模板产出 歌手/专辑名/歌曲 - 歌手.mp3", () => {
    const ctx: NamingCtx = { title: "爱在西元前", artist: "周杰伦", album: "范特西" };
    expect(buildRelativePath(ctx, DEFAULT_NAMING_CONFIG, "mp3")).toBe("周杰伦/范特西/爱在西元前 - 周杰伦.mp3");
  });

  it("缺 albumArtist 回落 artist", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手", album: "专辑" };
    expect(buildRelativePath(ctx, DEFAULT_NAMING_CONFIG, "flac")).toBe("歌手/专辑/歌 - 歌手.flac");
  });

  it("缺 album 回落 Unknown Album", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手" };
    expect(buildRelativePath(ctx, DEFAULT_NAMING_CONFIG, "mp3")).toBe("歌手/Unknown Album/歌 - 歌手.mp3");
  });

  it("缺 artist 时文件名的悬挂分隔符被消去", () => {
    const ctx: NamingCtx = { title: "歌", album: "专辑" };
    expect(buildRelativePath(ctx, DEFAULT_NAMING_CONFIG, "mp3")).toBe("Unknown Artist/专辑/歌.mp3");
  });

  it("extFromContainer 为真时以 ctx.source 的容器为准", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手", album: "专辑", source: "flac" };
    expect(buildRelativePath(ctx, cfgOf({ extFromContainer: true }), "mp3")).toBe("歌手/专辑/歌 - 歌手.flac");
  });

  it("extFromContainer 为假时用传入的扩展名", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手", album: "专辑", source: "flac" };
    expect(buildRelativePath(ctx, cfgOf({ extFromContainer: false }), "mp3")).toBe("歌手/专辑/歌 - 歌手.mp3");
  });
});

describe("renderTemplate 空段消除", () => {
  it("year 缺失时 '({year})' 整段消去,不留 '()'", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手", album: "专辑" };
    const out = renderTemplate("{albumArtist}/{album} ({year})", ctx, DEFAULT_NAMING_CONFIG);
    expect(out).toBe("歌手/专辑");
    expect(out).not.toContain("()");
  });

  it("year 存在时正常渲染", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手", album: "专辑", year: 2001 };
    expect(renderTemplate("{albumArtist}/{album} ({year})", ctx, DEFAULT_NAMING_CONFIG)).toBe("歌手/专辑 (2001)");
  });

  it("连续缺失 token 不留空目录层级 / 连续斜杠", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手" };
    const out = renderTemplate("{albumArtist}/{year}/{album}", ctx, DEFAULT_NAMING_CONFIG);
    expect(out).toBe("歌手/Unknown Album");
    expect(out).not.toContain("//");
  });

  it("{track:02d} 按 padTrackNumber 补零", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手", track: 3 };
    expect(renderTemplate("{track:02d} {title}", ctx, DEFAULT_NAMING_CONFIG)).toBe("03 歌");
  });

  it("padTrackNumber = 0 时不输出曲目号", () => {
    const ctx: NamingCtx = { title: "歌", artist: "歌手", track: 3 };
    expect(renderTemplate("{track:02d} {title}", ctx, cfgOf({ padTrackNumber: 0 }))).toBe("歌");
  });

  it("{quality} / {sampleRateKHz} / {bitDepth} 短标签", () => {
    const ctx: NamingCtx = { title: "歌", sampleRateHz: 44100, bitrateKbps: 320 };
    expect(renderTemplate("{quality}", ctx, DEFAULT_NAMING_CONFIG)).toBe("320K");
    expect(renderTemplate("{sampleRateKHz}", ctx, DEFAULT_NAMING_CONFIG)).toBe("44.1");
    const lossless: NamingCtx = { title: "歌", sampleRateHz: 96000, bitDepth: 24 };
    expect(renderTemplate("{quality}", lossless, DEFAULT_NAMING_CONFIG)).toBe("HiRes");
    expect(renderTemplate("{bitDepth}", lossless, DEFAULT_NAMING_CONFIG)).toBe("24");
  });
});

describe("sanitizeSegment", () => {
  const raw = "a/b:c*d?e";

  it("replace:非法字符替换为 '_'", () => {
    expect(sanitizeSegment(raw, cfgOf({ illegalCharPolicy: "replace" }))).toBe("a_b_c_d_e");
  });

  it("remove:非法字符直接删除", () => {
    expect(sanitizeSegment(raw, cfgOf({ illegalCharPolicy: "remove" }))).toBe("abcde");
  });

  it("transliterate:全角转半角后替换", () => {
    expect(sanitizeSegment(raw, cfgOf({ illegalCharPolicy: "transliterate" }))).toBe("a_b_c_d_e");
    expect(sanitizeSegment("ａ：ｂ", cfgOf({ illegalCharPolicy: "transliterate" }))).toBe("a_b");
  });

  it("末尾的点与空格被裁剪", () => {
    expect(sanitizeSegment("专辑名. . ", DEFAULT_NAMING_CONFIG)).toBe("专辑名");
  });

  it("trimTrailingDots 关闭时保留末尾点", () => {
    expect(sanitizeSegment("专辑名.", cfgOf({ trimTrailingDots: false }))).toBe("专辑名.");
  });
});

describe("buildRelativePath 超长路径", () => {
  it("按 UTF-8 字节截断 + 追加 8 位 hash,且扩展名保留", () => {
    const ctx: NamingCtx = { title: "很长很长的歌名".repeat(30), artist: "歌手", album: "专辑" };
    const p = buildRelativePath(ctx, DEFAULT_NAMING_CONFIG, "mp3");
    expect(p.endsWith(".mp3")).toBe(true);
    expect(bytes(p)).toBeLessThanOrEqual(DEFAULT_NAMING_CONFIG.maxPathBytes);
    expect(p).toMatch(/-[0-9a-f]{8}\.mp3$/);
  });

  it("短路径不会被截断", () => {
    const ctx: NamingCtx = { title: "短歌", artist: "歌手", album: "专辑" };
    expect(buildRelativePath(ctx, DEFAULT_NAMING_CONFIG, "mp3")).toBe("歌手/专辑/短歌 - 歌手.mp3");
  });
});

describe("buildRelativePath 多碟策略", () => {
  const ctx: NamingCtx = { title: "歌", artist: "人", album: "专", disc: 2, track: 3 };

  it("prefix:文件名加 '碟号-曲目号' 前缀", () => {
    expect(buildRelativePath(ctx, cfgOf({ multiDiscStrategy: "prefix" }), "mp3")).toBe("人/专/2-03 歌 - 人.mp3");
  });

  it("subdir:目录追加 'Disc N'", () => {
    expect(buildRelativePath(ctx, cfgOf({ multiDiscStrategy: "subdir" }), "mp3")).toBe("人/专/Disc 2/歌 - 人.mp3");
  });

  it("merge:忽略碟号", () => {
    expect(buildRelativePath(ctx, cfgOf({ multiDiscStrategy: "merge" }), "mp3")).toBe("人/专/歌 - 人.mp3");
  });
});

describe("buildRelativePath 合辑集中目录", () => {
  it("albumArtist 等于 vaAlbumArtist 时前置 vaRootFolder", () => {
    const ctx: NamingCtx = { title: "歌", artist: "人", album: "合辑一", albumArtist: "Various Artists" };
    expect(buildRelativePath(ctx, cfgOf({ vaRootFolder: "合辑" }), "mp3")).toBe(
      "合辑/Various Artists/合辑一/歌 - 人.mp3",
    );
  });

  it("普通专辑不加 vaRootFolder", () => {
    const ctx: NamingCtx = { title: "歌", artist: "人", album: "专辑", albumArtist: "人" };
    expect(buildRelativePath(ctx, cfgOf({ vaRootFolder: "合辑" }), "mp3")).toBe("人/专辑/歌 - 人.mp3");
  });
});

describe("resolveConflict", () => {
  it("不存在 → 直接写入", () => {
    expect(resolveConflict({ exists: false, policy: "skip" })).toEqual({ action: "write" });
  });

  it("skip:存在则跳过", () => {
    expect(resolveConflict({ exists: true, policy: "skip" })).toEqual({ action: "skip" });
  });

  it("overwrite:存在仍写入", () => {
    expect(resolveConflict({ exists: true, policy: "overwrite" }).action).toBe("write");
  });

  it("rename:追加 (1),已占用则递增到 (2)", () => {
    const r1 = resolveConflict({ exists: true, policy: "rename", name: "歌.mp3" });
    expect(r1).toEqual({ action: "write", finalName: "歌 (1).mp3" });
    const r2 = resolveConflict({
      exists: true,
      policy: "rename",
      name: "歌.mp3",
      usedNames: new Set(["歌 (1).mp3"]),
    });
    expect(r2.finalName).toBe("歌 (2).mp3");
    const r3 = resolveConflict({
      exists: true,
      policy: "rename",
      name: "歌.mp3",
      usedNames: new Set(["歌 (1).mp3", "歌 (2).mp3"]),
    });
    expect(r3.finalName).toBe("歌 (3).mp3");
  });

  it("keepBetter:新的更好才写,否则保留旧文件", () => {
    expect(resolveConflict({ exists: true, policy: "keepBetter", newIsBetter: true }).action).toBe("write");
    expect(resolveConflict({ exists: true, policy: "keepBetter", newIsBetter: false }).action).toBe("keep");
    expect(resolveConflict({ exists: true, policy: "keepBetter" }).action).toBe("keep");
  });
});
