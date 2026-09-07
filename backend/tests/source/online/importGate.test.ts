// Unit tests for services/source/online/importGate.ts — 导入命中门禁纯逻辑。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase } from "../../../src/db/index.js";
import {
  passesImportGate,
  getImportGateConfig,
  type ImportGateWant,
  type ImportGateCandidate,
} from "../../../src/services/source/online/importGate.js";

beforeAll(() => {
  initDatabase();
});

const want: ImportGateWant = {
  title: "我们的歌",
  artist: "王力宏",
  album: "改变自己",
  duration: 247,
};

function cand(over: Partial<ImportGateCandidate> = {}): ImportGateCandidate {
  return { name: "我们的歌", artist: "王力宏", album: "改变自己", duration: 247, ...over };
}

describe("passesImportGate — 维度语义", () => {
  it("四维全命中 → ok", () => {
    expect(passesImportGate(want, cand()).ok).toBe(true);
  });

  it("标题不一致 → 拒(含括号后缀差异)", () => {
    expect(passesImportGate(want, cand({ name: "我们的歌(Live)" })).reason).toBe("title");
    expect(passesImportGate(want, cand({ name: "我们的歌 " })).ok).toBe(true); // 仅空白差异
  });

  it("歌手不一致 → 拒;合并歌手兼容(A、B 含 A);大小写/括号归一", () => {
    expect(passesImportGate(want, cand({ artist: "王力宏、群星" })).ok).toBe(true);
    expect(passesImportGate(want, cand({ artist: "王力宏" })).ok).toBe(true);
    expect(passesImportGate(want, cand({ artist: "力宏Wang" })).reason).toBe("artist");
    expect(passesImportGate({ ...want, artist: "Alan Walker" }, cand({ artist: "alan walker" })).ok).toBe(true);
  });

  it("专辑不一致(合辑冒名)→ 拒;候选无专辑=无法核实 → 拒;空白/括号写法差异归一", () => {
    expect(passesImportGate(want, cand({ album: "K情歌 5" })).reason).toBe("album");
    expect(passesImportGate(want, cand({ album: "" })).reason).toBe("album");
    // 带多余副标题的专辑视为不同专辑(严格):期望「改变自己」≠「改变自己 (Change Me)」
    expect(passesImportGate(want, cand({ album: "改变自己 (Change Me)" })).ok).toBe(false);
    // 仅空白/全半角写法差异 → 归一后相等
    expect(passesImportGate(want, cand({ album: "改 变 自 己" })).ok).toBe(true);
    expect(passesImportGate({ ...want, album: "改变自己(Change Me)" }, cand({ album: "改变自己 (Change Me)" })).ok).toBe(true);
  });

  it("时长超容差 → 拒;候选无时长 → 拒;容差内差异 → ok", () => {
    expect(passesImportGate(want, cand({ duration: 300 })).reason).toBe("duration");
    expect(passesImportGate(want, cand({ duration: 0 })).reason).toBe("duration");
    expect(passesImportGate(want, cand({ duration: 247.5 })).ok).toBe(true);
  });

  it("期望侧缺字段:无专辑/无歌手/无时长 → 对应维度跳过", () => {
    expect(passesImportGate({ title: "我们的歌" }, cand({ artist: "随便谁", album: "随便专辑", duration: 99 })).ok).toBe(true);
  });

  it("配置覆盖:albumRequired=false 时专辑不一致也放行(时长仍拦)", () => {
    const cfg = { albumRequired: false, durationTolerance: 1 };
    expect(passesImportGate(want, cand({ album: "K情歌 5" }), cfg).ok).toBe(true);
    expect(passesImportGate(want, cand({ duration: 300 }), cfg).reason).toBe("duration");
  });

  it("配置覆盖:放宽时长容差后放行", () => {
    const cfg = { albumRequired: true, durationTolerance: 60 };
    expect(passesImportGate(want, cand({ duration: 300 }), cfg).ok).toBe(true);
  });
});

describe("passesImportGate — 归一化盲区(假名/谚文/纯符号原文回退)", () => {
  // 假名/谚文/纯符号标题 normalizeTitleStrict 后是空串:旧行为下门禁要么永远
  // 拒绝合法的假名歌(!nt → 拒),要么任意假名歌互判相等。strictNormEquals
  // 原文回退后:原文全等才放行,不等照拒。
  const jpWant: ImportGateWant = {
    title: "ドラえもんのうた",
    artist: "やなぎなぎ",
    album: "サントラ盤",
    duration: 180,
  };
  const jpCand = { name: "ドラえもんのうた", artist: "やなぎなぎ", album: "サントラ盤", duration: 180 };

  it("假名标题原文全等 → ok(旧逻辑误拒)", () => {
    expect(passesImportGate(jpWant, jpCand).ok).toBe(true);
  });

  it("假名标题不同 → 原文回退不等 → 拒(旧逻辑误判相等)", () => {
    expect(passesImportGate(jpWant, { ...jpCand, name: "ドラえもんマーチ" }).reason).toBe("title");
  });

  it("假名标题 vs 中文标题 → 拒", () => {
    expect(passesImportGate(jpWant, { ...jpCand, name: "我们的歌" }).reason).toBe("title");
  });

  it("假名歌手:token 原文回退,一致 ok(空白差异容忍)/不一致拒", () => {
    expect(passesImportGate(jpWant, { ...jpCand, artist: "やなぎ なぎ" }).ok).toBe(true);
    expect(passesImportGate(jpWant, { ...jpCand, artist: "米津玄師" }).reason).toBe("artist");
  });

  it("假名专辑:原文回退一致 ok / 不同专辑拒 / 候选无专辑拒", () => {
    expect(passesImportGate(jpWant, { ...jpCand, album: "サントラ盤 " }).ok).toBe(true);
    expect(passesImportGate(jpWant, { ...jpCand, album: "ベスト盤" }).reason).toBe("album");
    expect(passesImportGate(jpWant, { ...jpCand, album: "" }).reason).toBe("album");
  });

  it("纯符号标题:两侧归一皆空 → 原文全等判等", () => {
    expect(passesImportGate({ title: "☾", artist: "" }, { name: "☾" }).ok).toBe(true);
    expect(passesImportGate({ title: "☾", artist: "" }, { name: "★" }).reason).toBe("title");
  });

  it("谚文标题原文全等 → ok;不同谚文 → 拒", () => {
    const ko = { title: "사랑의 인사", artist: "아이유", duration: 200 };
    expect(passesImportGate(ko, { name: "사랑의 인사", artist: "아이유", duration: 200 }).ok).toBe(true);
    expect(passesImportGate(ko, { name: "이별의 인사", artist: "아이유", duration: 200 }).reason).toBe("title");
  });
});

describe("getImportGateConfig — 默认值", () => {
  it("默认:专辑一致开 + 容差 1 秒", () => {
    const cfg = getImportGateConfig();
    expect(cfg.albumRequired).toBe(true);
    expect(cfg.durationTolerance).toBe(1);
  });
});
