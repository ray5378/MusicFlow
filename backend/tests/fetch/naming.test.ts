import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAMING_CONFIG,
  buildRelativePath,
  renderTemplate,
  resolveConflict,
  sanitizeSegment,
} from "../../src/services/fetch/naming.js";
import type { ConflictPolicy, NamingConfig, NamingCtx } from "../../src/services/fetch/naming.js";

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

// ==================== 覆盖率补充：纯函数边界分支 ====================

describe("sanitizeSegment 全角转半角边界", () => {
  it("transliterate:全角空格(U+3000)转为半角空格", () => {
    expect(sanitizeSegment("a\u3000b", cfgOf({ illegalCharPolicy: "transliterate" }))).toBe("a b");
  });

  it("transliterate:非全角字符原样保留", () => {
    expect(sanitizeSegment("歌\u4e2d", cfgOf({ illegalCharPolicy: "transliterate" }))).toBe("歌\u4e2d");
  });
});

describe("renderTemplate 其余 token 取值", () => {
  it("{artists} 多艺术家用分隔符拼接;无 artists 时回落 artist", () => {
    expect(renderTemplate("{artists}", { title: "歌", artists: ["甲", "乙"] }, DEFAULT_NAMING_CONFIG)).toBe("甲、乙");
    expect(renderTemplate("{artists}", { title: "歌", artist: "丙" }, DEFAULT_NAMING_CONFIG)).toBe("丙");
  });

  it("{disc} / {source} / {ext} 取值与回落", () => {
    expect(renderTemplate("{disc}", { title: "歌", disc: 2 }, DEFAULT_NAMING_CONFIG)).toBe("2");
    expect(renderTemplate("{source}", { title: "歌", source: "flac" }, DEFAULT_NAMING_CONFIG)).toBe("flac");
    expect(renderTemplate("{ext}", { title: "歌", source: ".FLAC" }, DEFAULT_NAMING_CONFIG)).toBe("flac");
    expect(renderTemplate("{ext}", { title: "歌", source: "unknown-container" }, DEFAULT_NAMING_CONFIG)).toBe("");
  });

  it("未知 token 渲染为空并被整段消去", () => {
    expect(renderTemplate("{foo} {title}", { title: "歌" }, DEFAULT_NAMING_CONFIG)).toBe("歌");
  });

  it("artists 为空数组时回落 albumArtist/artist(含全部缺失)", () => {
    expect(renderTemplate("{albumArtist}", { title: "歌", artists: [] }, DEFAULT_NAMING_CONFIG)).toBe("Unknown Artist");
    expect(renderTemplate("{artist}", { title: "歌", artists: [] }, DEFAULT_NAMING_CONFIG)).toBe("");
  });
});

describe("quality 短标签边界", () => {
  it("bitDepth=16 → FLAC 短标签", () => {
    expect(renderTemplate("{quality}", { title: "歌", bitDepth: 16 }, DEFAULT_NAMING_CONFIG)).toBe("FLAC");
  });

  it("无任何音质信息 → 渲染为空并整段消去", () => {
    expect(renderTemplate("{quality}", { title: "歌" }, DEFAULT_NAMING_CONFIG)).toBe("");
  });

  it("码率非 32 倍数时上取整到 32 的倍数", () => {
    expect(renderTemplate("{quality}", { title: "歌", bitrateKbps: 100 }, DEFAULT_NAMING_CONFIG)).toBe("96K");
  });
});

describe("formatTrack 边界", () => {
  it("宽度 <= 0(字面量 :00d)不输出曲目号", () => {
    expect(renderTemplate("{track:00d} {title}", { title: "歌", track: 5 }, DEFAULT_NAMING_CONFIG)).toBe("歌");
  });

  it("track 缺失或非正 → 不输出曲目号", () => {
    expect(renderTemplate("{track} {title}", { title: "歌" }, DEFAULT_NAMING_CONFIG)).toBe("歌");
    expect(renderTemplate("{track} {title}", { title: "歌", track: 0 }, DEFAULT_NAMING_CONFIG)).toBe("歌");
  });

  it("字面量 spec 不合规(:2x)时回落 padTrackNumber", () => {
    expect(renderTemplate("{track:2x} {title}", { title: "歌", track: 5 }, DEFAULT_NAMING_CONFIG)).toBe("05 歌");
  });
});

describe("buildRelativePath 截断/空目录边界", () => {
  it("目录模板渲染为空时不产生目录段(空数组字节数=0)", () => {
    const ctx: NamingCtx = { title: "歌", artist: "人" };
    expect(buildRelativePath(ctx, cfgOf({ dirTemplate: "{year}" }), "mp3")).toBe("歌 - 人.mp3");
  });

  it("超长目录段触发整体收缩(shrinkSegments)且不超预算", () => {
    const ctx: NamingCtx = { title: "歌", artist: "人", album: "长".repeat(40) };
    const p = buildRelativePath(ctx, cfgOf({ maxPathBytes: 60 }), "mp3");
    expect(p.endsWith(".mp3")).toBe(true);
    expect(bytes(p)).toBeLessThanOrEqual(60);
  });

  it("预算极小时文件名按字节截断(keep<8 不追加哈希)", () => {
    const ctx: NamingCtx = { title: "很长很长的歌名".repeat(20), artist: "人" };
    const p = buildRelativePath(ctx, cfgOf({ dirTemplate: "{year}", maxPathBytes: 20 }), "mp3");
    expect(p.endsWith(".mp3")).toBe(true);
    expect(bytes(p)).toBeLessThanOrEqual(20);
  });

  it("prefix 策略但无曲目号时前缀只留 '碟号-'", () => {
    const ctx: NamingCtx = { title: "歌", artist: "人", album: "专", disc: 2 };
    expect(buildRelativePath(ctx, cfgOf({ multiDiscStrategy: "prefix" }), "mp3")).toBe("人/专/2- 歌 - 人.mp3");
  });
});

describe("resolveConflict 边缘分支", () => {
  it("rename 未传 name → 退化为直接写入", () => {
    expect(resolveConflict({ exists: true, policy: "rename" })).toEqual({ action: "write" });
  });

  it("rename 文件名无扩展名 → base=name、ext 为空", () => {
    expect(resolveConflict({ exists: true, policy: "rename", name: "无扩展名" })).toEqual({
      action: "write",
      finalName: "无扩展名 (1)",
    });
  });

  it("未知策略 → 默认直接写入", () => {
    expect(resolveConflict({ exists: true, policy: "bogus" as ConflictPolicy })).toEqual({ action: "write" });
  });
});

describe("覆盖率补充:更多 token 与截断分支", () => {
  it("{artist}/{albumArtist} 在 artists 非空时用分隔符拼接", () => {
    expect(renderTemplate("{artist}", { title: "歌", artists: ["甲", "乙"] }, DEFAULT_NAMING_CONFIG)).toBe("甲、乙");
    expect(renderTemplate("{albumArtist}", { title: "歌", artists: ["甲", "乙"] }, DEFAULT_NAMING_CONFIG)).toBe("甲、乙");
  });

  it("{disc}/{source}/{bitDepth}/{sampleRateKHz} 缺省时渲染为空", () => {
    const ctx: NamingCtx = { title: "歌" };
    expect(renderTemplate("{disc} {source} {bitDepth} {sampleRateKHz} {title}", ctx, DEFAULT_NAMING_CONFIG)).toBe("歌");
  });

  it("模板为 undefined 时按空串处理", () => {
    expect(renderTemplate(undefined as any, { title: "歌" }, DEFAULT_NAMING_CONFIG)).toBe("");
  });

  it("扩展名为 undefined 且不从容器推断时按空串处理", () => {
    const ctx: NamingCtx = { title: "歌", artist: "人" };
    expect(buildRelativePath(ctx, cfgOf({ extFromContainer: false }), undefined as any)).toBe(
      "人/Unknown Album/歌 - 人.",
    );
  });

  it("最长目录段在中间时收缩仍取到最长段", () => {
    const ctx: NamingCtx = { title: "歌", artist: "人", album: "长".repeat(40) };
    const p = buildRelativePath(ctx, cfgOf({ dirTemplate: "{album}/{albumArtist}", maxPathBytes: 60 }), "mp3");
    expect(p.endsWith(".mp3")).toBe(true);
    expect(bytes(p)).toBeLessThanOrEqual(60);
  });
});
