import { describe, it, expect } from "vitest";
import { normalizePlatform, declaredFromExtra } from "../../src/services/plugin/sourcePlatforms.js";

// 聚合源平台字典：纯函数，只按 extra 键形状/平台名推档位，不猜、不联网。
describe("normalizePlatform（长名→短码）", () => {
  it("已知平台映射", () => {
    expect(normalizePlatform("netease")).toBe("wy");
    expect(normalizePlatform("qq")).toBe("qq");
    expect(normalizePlatform("kugou")).toBe("kg");
    expect(normalizePlatform("kuwo")).toBe("kw");
    expect(normalizePlatform("migu")).toBe("mg");
    expect(normalizePlatform("bilibili")).toBe("bili");
    expect(normalizePlatform("ximalaya")).toBe("xmly");
  });
  it("大小写/空白归一，未知平台原样小写返回", () => {
    expect(normalizePlatform("  NETEASE ")).toBe("wy");
    expect(normalizePlatform("UnknownSrc")).toBe("unknownsrc");
    expect(normalizePlatform(undefined)).toBe("");
    expect(normalizePlatform(null)).toBe("");
    expect(normalizePlatform("  ")).toBe("");
  });
});

describe("declaredFromExtra（从 extra 推可得档位）", () => {
  it("无 extra / 非对象 → undefined（不给信息不猜）", () => {
    expect(declaredFromExtra("qq")).toBeUndefined();
    expect(declaredFromExtra("qq", null)).toBeUndefined();
    expect(declaredFromExtra("qq", "x" as any)).toBeUndefined();
  });

  it("format_type 档位：ZQ/SQ/HQ/其它", () => {
    expect(declaredFromExtra("migu", { format_type: "ZQ" })).toEqual({ container: "flac", bitDepth: 24 });
    expect(declaredFromExtra("migu", { format_type: "SQ" })).toEqual({ container: "flac", bitDepth: 16 });
    expect(declaredFromExtra("migu", { format_type: "hq" })).toEqual({ container: "mp3", bitrateKbps: 320 });
    expect(declaredFromExtra("migu", { format_type: "standard" })).toEqual({ container: "mp3", bitrateKbps: 128 });
  });

  it("hash 阶梯：sq>320>128，容器按证据（ogg_*_hash 才判 ogg）", () => {
    expect(declaredFromExtra("kugou", { sq_hash: "x" })).toEqual({ container: "flac" });
    expect(declaredFromExtra("kugou", { hq_hash: "x" })).toEqual({ container: "mp3", bitrateKbps: 320 });
    expect(declaredFromExtra("kugou", { ogg_320_hash: "x" })).toEqual({ container: "ogg", bitrateKbps: 320 });
    expect(declaredFromExtra("kugou", { hash: "x" })).toEqual({ container: "mp3", bitrateKbps: 128 });
    expect(declaredFromExtra("kugou", { ogg_128_hash: "x" })).toEqual({ container: "ogg", bitrateKbps: 128 });
  });

  it("privilege=0 版权受限 → 高档位封顶到 128 mp3", () => {
    expect(declaredFromExtra("kugou", { sq_hash: "x", privilege: "0" })).toEqual({ container: "mp3", bitrateKbps: 128 });
    expect(declaredFromExtra("kugou", { hq_hash: "x", privilege: "0" })).toEqual({ container: "mp3", bitrateKbps: 128 });
  });

  it("键名大小写不敏感、忽略空白值；数字值接受", () => {
    expect(declaredFromExtra("migu", { FORMAT_TYPE: "SQ" })).toEqual({ container: "flac", bitDepth: 16 });
    expect(declaredFromExtra("kugou", { sq_hash: "   " })).toBeUndefined();
    expect(declaredFromExtra("migu", { format_type: "HQ", n: 1 })).toEqual({ container: "mp3", bitrateKbps: 320 });
  });

  it("派发优先按 extra 键形状，平台名仅兜底", () => {
    // 有 format_type 键 → 走 format 阶梯，即使平台名是 kugou
    expect(declaredFromExtra("kugou", { format_type: "ZQ" })).toEqual({ container: "flac", bitDepth: 24 });
    // 无特征键，平台名兜底：kugou 走 hash 阶梯（全空 → undefined）
    expect(declaredFromExtra("kugou", {})).toBeUndefined();
    expect(declaredFromExtra("unknown", { hash: "x" })).toBeUndefined();
  });
});
