import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  DEFAULT_INSPECT_TIMEOUT_MS,
  DEFAULT_INSPECT_TOP_N,
  DEFAULT_MAX_CANDIDATES_PER_SONG,
  collectCandidates,
  declaredFromExtra,
  dedupeCandidates,
  nextCandidate,
} from "../../src/services/fetch/candidates.js";
import type { CandidateSource, FetchTarget } from "../../src/services/fetch/candidates.js";
import { rankCandidates } from "../../src/services/fetch/quality.js";
import { DEFAULT_QUALITY_CONFIG } from "../../src/services/fetch/types.js";
import type { Candidate, QualityConfig } from "../../src/services/fetch/types.js";

// 说明：单测**不真的调用外置插件**（沙箱不好构造），改为在 `sources` 注入点塞桩
// provider。这样 collectCandidates 内部两分支的分支选择/容错逻辑都走真实代码路径。

const PRIORITY = ["lx-source:kw", "lx-source:kg", "go-music-dl"];

function src(pluginId: string, capabilities: string[], provider: any): CandidateSource {
  return { pluginId, capabilities, provider, config: {} };
}

/** 分支 A 桩：search → 多条搜索结果，streamUrl 同步拼一个按平台区分的直链。 */
function searchStub(
  songs: Array<Partial<{ id: string; source: string; name: string; bitrate: string; size: string }>>,
): any {
  return {
    async search(_cfg: any, _params: any) {
      return {
        songs: songs.map((s) => ({
          id: s.id ?? "1",
          source: s.source ?? "qq",
          name: s.name ?? "歌",
          artist: "歌手",
          album: "专辑",
          duration: 240,
          cover: "",
          sortBitrate: s.bitrate,
          sortSize: s.size,
        })),
      };
    },
    streamUrl(_cfg: any, song: any) {
      return `https://cdn.example.com/${song.source}/${song.id}.mp3`;
    },
  };
}

/** 分支 B 桩：resolveStream → 裸 URL。 */
function resolveStub(url: string | (() => Promise<string>)): any {
  return {
    async resolveStream(_cfg: any, _song: any) {
      return typeof url === "function" ? await url() : url;
    },
  };
}

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    id: "p:qq:1",
    pluginId: "p",
    platform: "qq",
    url: "https://cdn.example.com/a.mp3",
    sourceRank: 0,
    ...over,
  };
}

const target: FetchTarget = {
  id: "song-1",
  title: "爱在西元前",
  artist: "周杰伦",
  album: "范特西",
  durationSec: 240,
  sourceData: JSON.stringify({ source: "kw", remoteId: "5566" }),
};

describe("collectCandidates 多源聚合", () => {
  it("多个源都返回候选 → 全部聚合，sourceRank 按 sourcePriority", async () => {
    const sources = [
      src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/5566.flac")),
      src("go-music-dl", ["stream", "search"], searchStub([
        { id: "100", source: "qq" },
        { id: "200", source: "kugou" },
      ])),
    ];
    const out = await collectCandidates({ target, sourcePriority: PRIORITY, sources });
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.pluginId).sort()).toEqual(["go-music-dl", "go-music-dl", "lx-source"]);
    // lx-source:kw 排第 0；go-music-dl 在 priority 里排第 2。
    expect(out[0].pluginId).toBe("lx-source");
    expect(out[0].sourceRank).toBe(0);
    expect(out[0].platform).toBe("kw");
    expect(out[1].sourceRank).toBe(2);
    expect(out[2].sourceRank).toBe(2);
  });

  it("未列入 sourcePriority 的源排在最后", async () => {
    const sources = [
      src("zz-plugin", ["stream"], resolveStub("https://cdn.example.com/z.mp3")),
      src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/5566.flac")),
    ];
    const out = await collectCandidates({ target, sourcePriority: PRIORITY, sources });
    expect(out[0].pluginId).toBe("lx-source");
    expect(out[0].sourceRank).toBe(0);
    expect(out[1].pluginId).toBe("zz-plugin");
    expect(out[1].sourceRank).toBe(PRIORITY.length);
  });

  it("某个源抛错 → 其它源的候选照常返回（容错守卫）", async () => {
    const sources = [
      src("bad-plugin", ["stream", "search"], {
        search() {
          throw new Error("boom");
        },
        streamUrl: () => "https://cdn.example.com/x.mp3",
      }),
      src("go-music-dl", ["stream", "search"], searchStub([{ id: "100", source: "qq" }])),
      src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/5566.flac")),
    ];
    const out = await collectCandidates({ target, sourcePriority: PRIORITY, sources });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.pluginId).sort()).toEqual(["go-music-dl", "lx-source"]);
    expect(out.some((c) => c.url.includes("/x.mp3"))).toBe(false);
  });

  it("resolveStream 抛错（分支 B 内部异常）不阻塞其它源", async () => {
    const sources = [
      src("lx-source", ["stream"], {
        resolveStream() {
          throw new Error("plugin inner error");
        },
      }),
      src("go-music-dl", ["stream", "search"], searchStub([{ id: "100", source: "qq" }])),
    ];
    const out = await collectCandidates({ target, sources });
    expect(out).toHaveLength(1);
    expect(out[0].pluginId).toBe("go-music-dl");
  });

  it("某个源超时 → 不阻塞整体（其余源照常返回）", async () => {
    const sources = [
      src("slow-plugin", ["stream"], {
        resolveStream: () => new Promise<string>(() => {}), // 永不 settle
      }),
      src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/5566.flac")),
    ];
    const started = Date.now();
    const out = await collectCandidates({ target, candidateTimeoutMs: 50, sources });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out).toHaveLength(1);
    expect(out[0].pluginId).toBe("lx-source");
  });

  it("sourceData 缺失 → 分支 B 不参与（无平台 ID 不盲查）", async () => {
    const noData: FetchTarget = { id: "s", title: "歌", artist: "人" };
    const sources = [src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/1.flac"))];
    const out = await collectCandidates({ target: noData, sources });
    expect(out).toEqual([]);
  });

  it("零候选 → 返回空数组且不抛异常", async () => {
    const sources = [
      src("lx-source", ["stream"], resolveStub("")),
      src("go-music-dl", ["stream", "search"], searchStub([])),
    ];
    await expect(collectCandidates({ target, sources })).resolves.toEqual([]);
  });

  it("target 无标题 → 直接返回空数组（无法取链）", async () => {
    await expect(
      collectCandidates({ target: { id: "s", title: "" }, sources: [] }),
    ).resolves.toEqual([]);
  });

  it("把信源声明填入 declared，缺失字段留 undefined", async () => {
    const sources = [
      src("go-music-dl", ["stream", "search"], searchStub([{ id: "100", source: "qq", bitrate: "320kbps", size: "12.5MB" }])),
    ];
    const out = await collectCandidates({ target, sources });
    expect(out[0].declared).toEqual({
      container: "mp3",
      bitrateKbps: 320,
      bytes: 12.5 * 1024 * 1024,
      durationSec: 240,
    });
    // 分支 B 只给裸 URL → declared 不臆造。
    const b = await collectCandidates({
      target,
      sources: [src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/5566.flac"))],
    });
    expect(b[0].declared).toBeUndefined();
  });

  it("maxCandidatesPerSong 截断生效", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), source: "qq" }));
    const sources = [src("go-music-dl", ["stream", "search"], searchStub(many))];
    const out = await collectCandidates({ target, sources, maxCandidatesPerSong: 3 });
    expect(out).toHaveLength(3);
    const all = await collectCandidates({ target, sources });
    expect(all).toHaveLength(DEFAULT_MAX_CANDIDATES_PER_SONG);
  });

  it("默认预算常量对齐需求（15s / 6 条）", () => {
    expect(DEFAULT_CANDIDATE_TIMEOUT_MS).toBe(15000);
    expect(DEFAULT_MAX_CANDIDATES_PER_SONG).toBe(6);
  });

  it("信源 extra 声明 genre/style → 抽到候选 genre；没有就不臆造", async () => {
    const source = src("go-music-dl", ["stream", "search"], {
      async search() {
        return {
          songs: [
            { id: "1", source: "netease", name: "歌", artist: "人", album: "专", duration: 200, cover: "", extra: { Genre: "摇滚" } },
            { id: "2", source: "netease", name: "歌2", artist: "人", album: "专", duration: 200, cover: "", extra: { style: "民谣" } },
            { id: "3", source: "netease", name: "歌3", artist: "人", album: "专", duration: 200, cover: "", extra: {} },
          ],
        };
      },
      streamUrl(_c: any, s: any) {
        return `https://cdn.example.com/${s.id}.mp3`;
      },
    });
    const out = await collectCandidates({ target, sources: [source] });
    const byId = new Map(out.map((c) => [c.id, c]));
    expect(byId.get("go-music-dl:wy:1")?.genre).toBe("摇滚"); // 键大小写不敏感
    expect(byId.get("go-music-dl:wy:2")?.genre).toBe("民谣"); // style 兜底键
    expect(byId.get("go-music-dl:wy:3")?.genre).toBeUndefined(); // 拿不到不臆造
  });
});

describe("dedupeCandidates", () => {
  it("同一 URL 的两条合并为一条", () => {
    const a = cand({ id: "p:qq:1", title: "歌" });
    const b = cand({ id: "q:qq:2", title: "歌" });
    const out = dedupeCandidates([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("p:qq:1");
  });

  it("同 (pluginId+platform+平台歌曲ID) 但 URL 不同 → 合并，保留信息更全的一条", () => {
    const thin = cand({ id: "p:qq:1", url: "https://cdn.example.com/thin.mp3" });
    const rich = cand({
      id: "p:qq:1",
      url: "https://cdn.example.com/rich.mp3",
      title: "歌",
      artist: "人",
      album: "专辑",
      declared: { container: "flac", bitrateKbps: 999, sampleRateHz: 48000, bitDepth: 24, durationSec: 240, bytes: 100 },
    });
    const out = dedupeCandidates([thin, rich]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("歌");
    expect(out[0].declared?.bitrateKbps).toBe(999);
    expect(out[0].declared?.bitDepth).toBe(24);
  });

  it("合并时用另一条补齐 base 缺失的字段", () => {
    const a = cand({ id: "p:qq:1", url: "https://cdn.example.com/a.mp3", title: "歌", declared: { container: "mp3" } });
    const b = cand({ id: "p:qq:1", url: "https://cdn.example.com/b.mp3", title: "歌", declared: { bitrateKbps: 320 } });
    const out = dedupeCandidates([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].declared?.container).toBe("mp3");
    expect(out[0].declared?.bitrateKbps).toBe(320);
  });

  it("不同 pluginId / 平台 ID 不合并；无直链的候选被丢弃", () => {
    const a = cand({ id: "p:qq:1", url: "https://cdn.example.com/a.mp3" });
    const b = cand({ id: "r:qq:1", pluginId: "r", url: "https://cdn.example.com/b.mp3" });
    const c = cand({ id: "p:qq:2", url: "https://cdn.example.com/c.mp3" });
    const bad = cand({ id: "p:qq:3", url: "" });
    const out = dedupeCandidates([a, b, c, bad]);
    expect(out.map((x) => x.id)).toEqual(["p:qq:1", "r:qq:1", "p:qq:2"]);
  });

  it("id 为 URL 哈希（无平台歌曲 ID）时按 id 本身做身份去重", () => {
    const a = cand({ id: "p:qq:h1", url: "https://cdn.example.com/a.mp3" });
    const b = cand({ id: "p:qq:h1", url: "https://cdn.example.com/b.mp3" });
    const c = cand({ id: "p:qq:h2", url: "https://cdn.example.com/c.mp3" });
    expect(dedupeCandidates([a, b])).toHaveLength(1); // 哈希相同 → 合并
    expect(dedupeCandidates([a, c])).toHaveLength(2); // 不同直链 → 不同哈希 → 不合并
  });
});

describe("nextCandidate", () => {
  const c1 = cand({ id: "p:qq:1" });
  const c2 = cand({ id: "p:qq:2" });
  const c3 = cand({ id: "p:qq:3" });

  it("返回第一个未失败的候选", () => {
    expect(nextCandidate([c1, c2, c3], new Set())?.id).toBe("p:qq:1");
    expect(nextCandidate([c1, c2, c3], new Set(["p:qq:1"]))?.id).toBe("p:qq:2");
    expect(nextCandidate([c1, c2, c3], new Set(["p:qq:1", "p:qq:2"]))?.id).toBe("p:qq:3");
  });

  it("全部失败 → undefined", () => {
    expect(nextCandidate([c1, c2], new Set(["p:qq:1", "p:qq:2"]))).toBeUndefined();
    expect(nextCandidate([], new Set())).toBeUndefined();
  });
});

// ==================== extra 阶梯：declaredFromExtra（零网络纯函数） ====================

/** 240 生产实测的酷狗真实 extra（晴天/周杰伦，privilege=10 官方歌，完整阶梯）。 */
const KUGOU_FULL: Record<string, string> = {
  album_audio_id: "32100650",
  album_id: "966846",
  audio_id: "20505418",
  file_hash: "B3A52A7A958BF0AED0EBFBA2E9A818B7",
  hash: "B3A52A7A958BF0AED0EBFBA2E9A818B7",
  hq_hash: "1B56126A8A03924F1DD066259C095CBC",
  mv_hash: "92B86DA2E11C3C84DE3A944ED12D97F1",
  ogg_128_hash: "D6E0229D1BCD4453981743F6B53F9D75",
  ogg_320_hash: "6BB59E9DAFACFE4332E07F9E9841E912",
  privilege: "10",
  res_hash: "D667BC5EE93F201126697CB3BA745009",
  sq_hash: "0A69169202DE95AAF24A9944CCF0730D",
};

/** 只有 128k 可给的那种歌：高阶 hash 全空串、privilege=0。 */
const KUGOU_128_ONLY: Record<string, string> = {
  ...KUGOU_FULL,
  sq_hash: "",
  hq_hash: "",
  res_hash: "",
  ogg_320_hash: "",
  privilege: "0",
};

describe("declaredFromExtra", () => {
  it("酷狗完整阶梯（有 sq_hash）→ 无损 flac", () => {
    const q = declaredFromExtra("kugou", KUGOU_FULL);
    expect(q).toEqual({ container: "flac" });
  });

  it("酷狗只有 128（高阶 hash 空串、privilege=0）→ mp3 / 128kbps", () => {
    const q = declaredFromExtra("kugou", KUGOU_128_ONLY);
    expect(q).toEqual({ container: "mp3", bitrateKbps: 128 });
  });

  it("酷狗 privilege=0 但高阶 hash 还在 → 阶梯封顶 128（不靠乐观阶梯抢位）", () => {
    const q = declaredFromExtra("kugou", { ...KUGOU_FULL, privilege: "0" });
    expect(q).toEqual({ container: "mp3", bitrateKbps: 128 });
  });

  it("酷狗无任何 hash → undefined（不给信息就不猜）", () => {
    expect(declaredFromExtra("kugou", { privilege: "10" })).toBeUndefined();
    expect(declaredFromExtra("kugou", {})).toBeUndefined();
  });

  it("migu：ZQ→hires(flac/24bit) / SQ→lossless(flac/16bit) / HQ→320 / 其它→128", () => {
    expect(declaredFromExtra("migu", { format_type: "ZQ" })).toEqual({ container: "flac", bitDepth: 24 });
    expect(declaredFromExtra("migu", { format_type: "SQ" })).toEqual({ container: "flac", bitDepth: 16 });
    expect(declaredFromExtra("migu", { format_type: "HQ" })).toEqual({ container: "mp3", bitrateKbps: 320 });
    expect(declaredFromExtra("migu", { format_type: "X" })).toEqual({ container: "mp3", bitrateKbps: 128 });
    expect(declaredFromExtra("migu", {})).toBeUndefined();
  });

  it("短码别名（kg/mg）同样认", () => {
    expect(declaredFromExtra("kg", KUGOU_FULL)).toEqual({ container: "flac" });
    expect(declaredFromExtra("mg", { format_type: "SQ" })).toEqual({ container: "flac", bitDepth: 16 });
  });

  it("按键形状识别：平台名未知/为空也认（载荷契约比平台名稳，聚合源改口不失灵）", () => {
    expect(declaredFromExtra("", { format_type: "SQ" })).toEqual({ container: "flac", bitDepth: 16 });
    expect(declaredFromExtra("some-unknown-aggregator", KUGOU_FULL)).toEqual({ container: "flac" });
  });

  it("无音质信息的平台（netease/qq/kuwo）与空 extra → undefined", () => {
    expect(declaredFromExtra("netease", { song_id: "2668397359" })).toBeUndefined();
    expect(declaredFromExtra("qq", { song_id: "1", songmid: "2" })).toBeUndefined();
    expect(declaredFromExtra("kuwo", { rid: "3" })).toBeUndefined();
    expect(declaredFromExtra("kugou", undefined)).toBeUndefined();
    expect(declaredFromExtra("kugou", null)).toBeUndefined();
  });
});

// ==================== inspect 预探：真实码率驱动排序 ====================

/** 240 实测的真实码率（migu ZQ 1749 / 高品 320 / 标准 128）。 */
const INSPECT_KBPS: Record<string, number> = { hi: 1749, mid: 320, low: 128 };

/** 门槛宽松到「全部过闸」，专测排序本身（含 tolerateUnknown 的预筛口径）。 */
function looseCfg(): QualityConfig {
  return {
    ...DEFAULT_QUALITY_CONFIG,
    qualityFloor: "any",
    minBitrateKbps: 128,
    preferLossless: false,
    rejectFakeLossless: false,
  };
}

/** 一个 search 返回 3 条 migu 结果、并实现 inspectSong 的 go-music-dl 桩。 */
function inspectStub(inspectImpl: (song: any) => any): CandidateSource {
  return src("go-music-dl", ["stream", "search"], {
    async search() {
      return {
        songs: Object.keys(INSPECT_KBPS).map((id) => ({
          id,
          source: "migu",
          name: "歌",
          artist: "人",
          album: "专",
          duration: 269,
          cover: "",
        })),
      };
    },
    streamUrl(_cfg: any, s: any) {
      return `https://cdn.example.com/${s.id}.mp3`;
    },
    inspectSong(_cfg: any, song: any) {
      return inspectImpl(song);
    },
  });
}

describe("inspect 预探（真实码率驱动排序）", () => {
  it("inspect 给出 1749/320/128 → declared.bitrateKbps 落盘，rankCandidates 严格按音质降序", async () => {
    const source = inspectStub((song) => {
      const kbps = INSPECT_KBPS[song.id];
      return {
        valid: true,
        url: "https://cdn.example.com/x.mp3",
        bitrateKbps: kbps,
        bytes: Math.round((kbps * 1000 * song.duration) / 8),
      };
    });
    const out = await collectCandidates({ target, sources: [source] });
    const byId = new Map(out.map((c) => [c.id, c]));
    expect(byId.get("go-music-dl:mg:hi")?.declared?.bitrateKbps).toBe(1749);
    expect(byId.get("go-music-dl:mg:mid")?.declared?.bitrateKbps).toBe(320);
    expect(byId.get("go-music-dl:mg:low")?.declared?.bitrateKbps).toBe(128);

    const ranked = rankCandidates(out, looseCfg(), { durationSec: 269 });
    expect(ranked.map((c) => c.id)).toEqual([
      "go-music-dl:mg:hi",
      "go-music-dl:mg:mid",
      "go-music-dl:mg:low",
    ]);
  });

  it("inspectSong 全部返回 null（网络失败语义）→ 候选不受影响、不抛，静默降级", async () => {
    const source = inspectStub(() => null);
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.inspectUnavailable !== true)).toBe(true);
  });

  it("provider 未实现 inspectSong → 跳过 inspect 阶段，取链结果照常", async () => {
    const source = src("go-music-dl", ["stream", "search"], {
      async search() {
        return { songs: [{ id: "1", source: "netease", name: "歌", artist: "人", album: "专", duration: 200, cover: "" }] };
      },
      streamUrl: (_c: any, s: any) => `https://cdn.example.com/${s.id}.mp3`,
    });
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(1);
    expect(out[0].declared?.bitrateKbps).toBeUndefined(); // 没有 inspect，就没真实码率
  });

  it("全部候选都返回 valid:false（服务端明确取不到地址）→ 仍保留、不抛、排最后", async () => {
    const source = inspectStub(() => ({ valid: false }));
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(3); // 不静默丢弃
    expect(out.every((c) => c.inspectUnavailable === true)).toBe(true);
    expect(rankCandidates(out, looseCfg(), { durationSec: 269 })).toHaveLength(3);
  });

  it("valid:false 是正常业务响应：该候选排到最后，可用候选在前（酷狗 privilege=10 场景）", async () => {
    const source = inspectStub((song) =>
      song.id === "hi"
        ? { valid: false } // 服务端说这一档取不到地址
        : {
            valid: true,
            url: "https://cdn.example.com/x.mp3",
            bitrateKbps: INSPECT_KBPS[song.id],
            bytes: Math.round((INSPECT_KBPS[song.id] * 1000 * song.duration) / 8),
          },
    );
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(3);
    expect(out[out.length - 1].id).toBe("go-music-dl:mg:hi"); // 排最后
    const un = out.find((c) => c.id === "go-music-dl:mg:hi")!;
    expect(un.inspectUnavailable).toBe(true);
    expect(un.declared).toBeUndefined(); // 清空乐观声明，不抢最优位

    const ranked = rankCandidates(out, looseCfg(), { durationSec: 269 });
    expect(ranked[ranked.length - 1].id).toBe("go-music-dl:mg:hi");
    expect(ranked[0].id).toBe("go-music-dl:mg:mid");
  });

  it("inspect 请求超时 → 按 null 处理，不影响候选与其它候选", async () => {
    const source = inspectStub((song) =>
      song.id === "hi"
        ? new Promise(() => {}) // 永不 settle
        : { valid: true, bitrateKbps: INSPECT_KBPS[song.id] },
    );
    const out = await collectCandidates({ target, sources: [source], inspectTimeoutMs: 40 });
    expect(out).toHaveLength(3);
    const byId = new Map(out.map((c) => [c.id, c]));
    expect(byId.get("go-music-dl:mg:mid")?.declared?.bitrateKbps).toBe(320);
    expect(byId.get("go-music-dl:mg:low")?.declared?.bitrateKbps).toBe(128);
    expect(byId.get("go-music-dl:mg:hi")?.declared?.bitrateKbps).toBeUndefined();
  });

  it("inspectCandidates=false → 完全不做 inspect", async () => {
    let called = 0;
    const source = inspectStub(() => {
      called++;
      return { valid: true, bitrateKbps: 1749 };
    });
    const out = await collectCandidates({ target, sources: [source], inspectCandidates: false });
    expect(called).toBe(0);
    expect(out).toHaveLength(3);
  });

  it("inspect 默认预算常量对齐需求（8s / 前 6 个）", () => {
    expect(DEFAULT_INSPECT_TIMEOUT_MS).toBe(8000);
    expect(DEFAULT_INSPECT_TOP_N).toBe(6);
  });

  it("PATCH20：inspect 有界并行（3 路）—— 6 个候选各耗 60ms，总耗时远低于串行 360ms，且结果不变", async () => {
    // 回归守卫：旧实现逐候选串行，6×8s 上限 = 48s 全挂在每首歌的关键路径上（240 实测每首 ~100s）。
    const ids = ["a", "b", "c", "d", "e", "f"];
    const source = src("go-music-dl", ["stream", "search"], {
      async search() {
        return {
          songs: ids.map((id) => ({
            id,
            source: "migu",
            name: "歌",
            artist: "人",
            album: "专",
            duration: 269,
            cover: "",
          })),
        };
      },
      streamUrl(_cfg: any, s: any) {
        return `https://cdn.example.com/${s.id}.mp3`;
      },
      inspectSong(_cfg: any, song: any) {
        return new Promise((r) => setTimeout(() => r({ valid: true, bitrateKbps: 700 }), 60));
      },
    });
    const t0 = Date.now();
    const out = await collectCandidates({ target, sources: [source], inspectTopN: 6 });
    const elapsed = Date.now() - t0;
    expect(out).toHaveLength(6);
    // 每个候选都拿到了 inspect 结果 → 并行不改变语义
    expect(out.every((c) => c.declared?.bitrateKbps === 700)).toBe(true);
    // 串行需 ≥360ms；3 路并行 ≈120ms。给足裕量（CI 负载抖动）仍必须显著低于串行。
    expect(elapsed).toBeLessThan(300);
  });
});

// ==================== extra 透传 ====================

describe("Candidate.extra 透传", () => {
  it("搜索结果 extra 原样进 Candidate.extra，并驱动 extra 阶梯声明档位", async () => {
    const source = src("go-music-dl", ["stream", "search"], {
      async search() {
        return {
          songs: [
            { id: "1", source: "kugou", name: "晴天", artist: "周杰伦", album: "叶惠美", duration: 269, cover: "", extra: KUGOU_FULL },
          ],
        };
      },
      streamUrl: (_c: any, s: any) => `https://cdn.example.com/${s.id}.mp3`,
    });
    const out = await collectCandidates({ target, sources: [source] });
    expect(out[0].extra).toEqual(KUGOU_FULL); // 原始阶梯一字不动
    // URL 后缀是 .mp3（代理 URL 不可信），但 sq_hash 声明无损 → container 取 flac
    expect(out[0].declared?.container).toBe("flac");
    expect(out[0].declared?.durationSec).toBe(269);
  });
});

// ==================== 分支 C：跨源桥接（songId 交接） ====================

const bridgeTarget: FetchTarget = {
  id: "song-2",
  title: "爱在西元前",
  artist: "周杰伦",
  album: "范特西",
  durationSec: 240,
  // 注意：无 sourceData —— 分支 B 不适用，走分支 C。
};

function bridgeSearchStub(
  hits: Array<{ id: string; source: string; name: string; artist: string }>,
): any {
  return {
    async search(_cfg: any, _p: any) {
      return {
        songs: hits.map((h) => ({ ...h, album: "专辑", duration: 240, cover: "" })),
      };
    },
    streamUrl(_cfg: any, song: any) {
      return "https://cdn.example.com/" + song.source + "/" + song.id + ".mp3";
    },
  };
}

describe("collectCandidates 分支 C：跨源桥接", () => {
  it("纯 stream 源无 sourceData → 桥接搜索定位 songId 后按 ID 取链", async () => {
    const seen: any[] = [];
    const lx = src("lx-source", ["stream"], {
      async resolveStream(_cfg: any, song: any) {
        seen.push(song);
        return "https://cdn.example.com/lx/flac/1323099451.flac";
      },
    });
    const gmdl = src("go-music-dl", ["stream", "search"], bridgeSearchStub([
      { id: "1323099451", source: "netease", name: "爱在西元前", artist: "周杰伦" },
    ]));
    const out = await collectCandidates({
      target: bridgeTarget,
      sourcePriority: ["lx-source", "go-music-dl"],
      sources: [gmdl, lx],
    });
    // gmdl 分支 A 1 条 + lx 桥接 1 条
    expect(out.map((c) => c.pluginId).sort()).toEqual(["go-music-dl", "lx-source"]);
    const lxC = out.find((c) => c.pluginId === "lx-source")!;
    expect(lxC.platform).toBe("wy");
    expect(lxC.id).toBe("lx-source:wy:1323099451");
    // songId 交接契约：sourceData 带 source+remoteId，绝不传 MusicFlow UUID
    expect(seen).toHaveLength(1);
    const sd = JSON.parse(seen[0].sourceData);
    expect(sd).toEqual({ source: "wy", remoteId: "1323099451" });
  });

  it("标题/歌手不匹配的搜索命中不桥接（宁缺毋滥）", async () => {
    const lx = src("lx-source", ["stream"], {
      async resolveStream() {
        return "https://x/y.flac";
      },
    });
    const gmdl = src("go-music-dl", ["stream", "search"], bridgeSearchStub([
      { id: "1", source: "netease", name: "爱在西元前 (DJ版)", artist: "别人" },
    ]));
    const out = await collectCandidates({ target: bridgeTarget, sources: [gmdl, lx] });
    expect(out.every((c) => c.pluginId !== "lx-source")).toBe(true);
  });

  it("桥接 resolveStream 失败 → 回落桥接源自身直链候选", async () => {
    const lx = src("lx-source", ["stream"], {
      async resolveStream() {
        return "";
      },
    });
    const gmdl = src("go-music-dl", ["stream", "search"], bridgeSearchStub([
      { id: "1", source: "netease", name: "爱在西元前", artist: "周杰伦" },
    ]));
    const out = await collectCandidates({ target: bridgeTarget, sources: [gmdl, lx] });
    expect(out).toHaveLength(1);
    expect(out[0].pluginId).toBe("go-music-dl");
  });

  it("有 sourceData 的 target 仍走分支 B，不触发桥接", async () => {
    let resolveCalls = 0;
    const lx = src("lx-source", ["stream"], {
      async resolveStream(_cfg: any, song: any) {
        resolveCalls++;
        // 分支 B 收到的是 target.sourceData（kw:5566），不是桥接命中的 netease:999
        expect(String(song.sourceData)).toContain('"remoteId":"5566"');
        return "https://cdn.example.com/kw/5566.flac";
      },
    });
    const gmdl = src("go-music-dl", ["stream", "search"], bridgeSearchStub([
      { id: "999", source: "netease", name: "爱在西元前", artist: "周杰伦" },
    ]));
    const out = await collectCandidates({ target, sources: [gmdl, lx] }); // target 有 sourceData kw:5566
    const lxC = out.find((c) => c.pluginId === "lx-source")!;
    expect(lxC.url).toBe("https://cdn.example.com/kw/5566.flac");
    expect(resolveCalls).toBe(1); // 只有分支 B 那一次，桥接未发生
  });
});

// ==================== 覆盖率补充：解析/归一化与合并边界 ====================

/** 一个只实现 search+streamUrl、可自定义直链的 go-music-dl 桩（用于驱动 URL 解析分支）。 */
function rawSearchStub(songs: any[], urlOf: (s: any) => string): CandidateSource {
  return src("go-music-dl", ["stream", "search"], {
    async search() {
      return { songs };
    },
    streamUrl(_cfg: any, s: any) {
      return urlOf(s);
    },
  });
}

/** 一条最小的 search 结果（字段可覆盖）。 */
function songOf(over: Record<string, any> = {}): Record<string, any> {
  return { id: "1", source: "qq", name: "歌", artist: "人", album: "专", duration: 200, cover: "", ...over };
}

describe("collectCandidates 边界分支补充", () => {
  it("无可用音源 → 直接返回空数组", async () => {
    await expect(collectCandidates({ target, sources: [] })).resolves.toEqual([]);
  });

  it("无有效直链（非空但非法 URL）的候选被丢弃", () => {
    const bad = cand({ id: "p:qq:9", url: "not a url" });
    expect(dedupeCandidates([bad])).toEqual([]);
  });

  it("搜索结果缺 id → 用 URL 哈希兜底生成候选 id;cover 透传", async () => {
    const source = rawSearchStub(
      [{ source: "qq", name: "歌", artist: "人", album: "专", duration: 200, cover: "https://img.example.com/c.jpg" }],
      () => "https://cdn.example.com/qq/x.mp3",
    );
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toMatch(/^go-music-dl:qq:[0-9a-f]{12}$/); // shortHash 兜底
    expect(out[0].coverUrl).toBe("https://img.example.com/c.jpg");
  });

  it("直链无音频后缀（.php / 末尾点）→ 容器未知,不误判", async () => {
    const php = rawSearchStub([songOf({ id: "1", source: "kugou" })], () => "https://xxx.kugou.com/yy/index.php?cmd=1");
    const outA = await collectCandidates({ target, sources: [php] });
    expect(outA[0].declared?.container).toBeUndefined();

    const dots = rawSearchStub([songOf({ id: "2", source: "kugou" })], () => "https://cdn.example.com/a.");
    const outB = await collectCandidates({ target, sources: [dots] });
    expect(outB[0].declared?.container).toBeUndefined();
  });

  it("码率/体积解析:数字、无单位、0、Mbps、GB 等边界", async () => {
    const cases: Array<[any, any, any]> = [
      [320, 104857600, { bitrateKbps: 320, bytes: 104857600 }], // 数字直接采用
      ["256", "8", { bitrateKbps: 256, bytes: 8 }], // 无单位字符串
      ["512k", "512kb", { bitrateKbps: 512, bytes: 512 * 1024 }], // k / kb
      ["1.5Mbps", "2GB", { bitrateKbps: 1500, bytes: 2 * 1024 ** 3 }], // Mbps / GB
      ["0k", "0", { bitrateKbps: undefined, bytes: undefined }], // 0 值不采用
      ["xx", "abc", { bitrateKbps: undefined, bytes: undefined }], // 不可解析
    ];
    for (const [bitrate, size, expected] of cases) {
      const out = await collectCandidates({
        target,
        sources: [src("go-music-dl", ["stream", "search"], searchStub([{ id: "1", source: "qq", bitrate, size }]))],
      });
      expect(out[0].declared?.bitrateKbps).toBe(expected.bitrateKbps);
      expect(out[0].declared?.bytes).toBe(expected.bytes);
    }
  });

  it("sourceData 非法/非对象 → 分支 B 不参与", async () => {
    for (const sd of ["not-json", "[1,2]", "null", "123"]) {
      const t: FetchTarget = { id: "s", title: "歌", artist: "人", sourceData: sd };
      const out = await collectCandidates({
        target: t,
        sources: [src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/1.flac"))],
      });
      expect(out).toEqual([]);
    }
  });

  it("sourceData 的键别名与类型兜底（remoteSource/platformId/provider/id）", async () => {
    const lx = src("lx-source", ["stream"], resolveStub("https://cdn.example.com/kw/1.flac"));
    const t1: FetchTarget = { id: "s", title: "歌", sourceData: JSON.stringify({ remoteSource: "kw", platformId: "77" }) };
    const o1 = await collectCandidates({ target: t1, sources: [lx] });
    expect(o1).toHaveLength(1);
    expect(o1[0].id.endsWith(":77")).toBe(true);

    const t2: FetchTarget = { id: "s", title: "歌", sourceData: JSON.stringify({ provider: "kw", id: 99 }) };
    const o2 = await collectCandidates({ target: t2, sources: [lx] });
    expect(o2).toHaveLength(1);
    expect(o2[0].id.endsWith(":99")).toBe(true);

    const t3: FetchTarget = { id: "s", title: "歌", sourceData: JSON.stringify({ remoteSource: 123, platformId: null }) };
    const o3 = await collectCandidates({ target: t3, sources: [lx] });
    expect(o3).toEqual([]);
  });

  it("streamUrl 抛错 → 跳过该搜索结果,不阻塞整源", async () => {
    const source = src("go-music-dl", ["stream", "search"], {
      async search() {
        return { songs: [songOf({ id: "1" }), songOf({ id: "2" })] };
      },
      streamUrl(_c: any, s: any) {
        if (s.id === "1") throw new Error("boom");
        return `https://cdn.example.com/${s.id}.mp3`;
      },
    });
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("go-music-dl:qq:2");
  });

  it("多个 search 源参与桥接排序（分支 C 选最靠前的桥接源）", async () => {
    const lx = src("lx-source", ["stream"], resolveStub("https://cdn.example.com/lx/1.flac"));
    const gmdlA = src("go-music-dl", ["stream", "search"], bridgeSearchStub([
      { id: "1", source: "netease", name: "爱在西元前", artist: "周杰伦" },
    ]));
    const gmdlB = src("go-music-dl-b", ["stream", "search"], bridgeSearchStub([
      { id: "2", source: "netease", name: "爱在西元前", artist: "周杰伦" },
    ]));
    const out = await collectCandidates({
      target: bridgeTarget,
      sourcePriority: ["go-music-dl-b", "go-music-dl"],
      sources: [gmdlA, gmdlB, lx],
    });
    expect(out.some((c) => c.pluginId === "lx-source" && c.id === "lx-source:wy:2")).toBe(true);
  });
});

describe("分支 C 桥接命中过滤与失败边界", () => {
  it("桥接命中:无标题 / 名称不符 被过滤,命中无歌手时标题对上即放行", async () => {
    const lx = src("lx-source", ["stream"], resolveStub("https://cdn.example.com/lx/1.flac"));
    const gmdl = src("go-music-dl", ["stream", "search"], {
      async search() {
        return {
          songs: [
            { id: "1", source: "netease", name: "", artist: "周杰伦", album: "专", duration: 240, cover: "" }, // 无标题
            { id: "2", source: "netease", name: "完全不同的歌", artist: "周杰伦", album: "专", duration: 240, cover: "" }, // 名称不符
            { id: "3", source: "netease", name: "爱在西元前", artist: "", album: "专", duration: 240, cover: "" }, // 无歌手
          ],
        };
      },
      streamUrl(_cfg: any, s: any) {
        return `https://cdn.example.com/${s.id}.mp3`;
      },
    });
    const out = await collectCandidates({ target: bridgeTarget, sources: [gmdl, lx] });
    const lxOut = out.filter((c) => c.pluginId === "lx-source");
    expect(lxOut).toHaveLength(1);
    expect(lxOut[0].id).toBe("lx-source:wy:3");
  });

  it("桥接搜索抛错 → 分支 C 本源跳过,不抛异常", async () => {
    const lx = src("lx-source", ["stream"], resolveStub("https://cdn.example.com/lx/1.flac"));
    const gmdl = src("go-music-dl", ["stream", "search"], {
      async search() {
        throw new Error("bridge boom");
      },
      streamUrl(_c: any) {
        return "https://cdn.example.com/x.mp3";
      },
    });
    await expect(collectCandidates({ target: bridgeTarget, sources: [gmdl, lx] })).resolves.toEqual([]);
  });

  it("桥接命中缺平台 ID → 跳过该命中（不传空 ID）", async () => {
    const lx = src("lx-source", ["stream"], resolveStub("https://cdn.example.com/lx/1.flac"));
    const gmdl = src("go-music-dl", ["stream", "search"], {
      async search() {
        return { songs: [{ source: "netease", name: "爱在西元前", artist: "周杰伦", album: "专", duration: 240, cover: "" }] };
      },
      streamUrl(_c: any) {
        return "https://cdn.example.com/x.mp3";
      },
    });
    const out = await collectCandidates({ target: bridgeTarget, sources: [gmdl, lx] });
    expect(out.some((c) => c.pluginId === "lx-source")).toBe(false);
  });

  it("桥接 resolveStream 抛错 → 单命中失败,不影响桥接源自身候选", async () => {
    const lx = src("lx-source", ["stream"], {
      async resolveStream() {
        throw new Error("resolve boom");
      },
    });
    const gmdl = src("go-music-dl", ["stream", "search"], bridgeSearchStub([
      { id: "1", source: "netease", name: "爱在西元前", artist: "周杰伦" },
    ]));
    const out = await collectCandidates({ target: bridgeTarget, sources: [gmdl, lx] });
    expect(out.every((c) => c.pluginId !== "lx-source")).toBe(true);
  });

  it("桥接搜索返回非数组 songs → 视为无命中", async () => {
    const lx = src("lx-source", ["stream"], resolveStub("https://cdn.example.com/lx/1.flac"));
    const gmdl = src("go-music-dl", ["stream", "search"], {
      async search() {
        return { songs: null };
      },
      streamUrl(_c: any) {
        return "https://cdn.example.com/x.mp3";
      },
    });
    const out = await collectCandidates({ target: bridgeTarget, sources: [gmdl, lx] });
    expect(out.some((c) => c.pluginId === "lx-source")).toBe(false);
  });
});

describe("listCandidateSources（注册表枚举）", () => {
  it("只保留声明 stream 且能拿到 provider 的插件", async () => {
    vi.resetModules();
    vi.doMock("../../src/plugins/registry.js", () => ({
      getEnabledSourcePlugins: () => [
        { manifest: { id: "no-stream", capabilities: ["search"] } },
        { manifest: { id: "stream-no-provider", capabilities: ["stream"] } },
        { manifest: { id: "ok", capabilities: ["stream"] } },
      ],
    }));
    vi.doMock("../../src/services/source/online/index.js", () => ({
      getConfiguredProvider: (id: string) =>
        id === "ok" ? { provider: { resolveStream() {} }, config: { a: 1 } } : null,
    }));
    const mod = await import("../../src/services/fetch/candidates.js");
    const list = mod.listCandidateSources();
    expect(list.map((s) => s.pluginId)).toEqual(["ok"]);
    expect(list[0].config).toEqual({ a: 1 });
    // 不传 sources 时由注册表枚举兜底（走 listCandidateSources）
    await expect(mod.collectCandidates({ target })).resolves.toEqual([]);
    vi.doUnmock("../../src/plugins/registry.js");
    vi.doUnmock("../../src/services/source/online/index.js");
    vi.resetModules();
  });
});

describe("nextCandidate / 合并边界补充", () => {
  it("候选数组含空元素时跳过", () => {
    const c = cand({ id: "p:qq:1" });
    expect(nextCandidate([null as any, c], new Set())?.id).toBe("p:qq:1");
  });

  it("id 非本模块格式 / 缺平台歌曲 ID / pluginId 不符 时不参与身份合并", () => {
    const noColon = cand({ id: "plainid", pluginId: "p", platform: "qq", url: "https://cdn.example.com/a.mp3" });
    const emptySong = cand({ id: "p:qq:", pluginId: "p", platform: "qq", url: "https://cdn.example.com/b.mp3" });
    const mismatch = cand({ id: "x:qq:1", pluginId: "p", platform: "qq", url: "https://cdn.example.com/c.mp3" });
    const out = dedupeCandidates([noColon, emptySong, mismatch]);
    expect(out.map((x) => x.id).sort()).toEqual(["p:qq:", "plainid", "x:qq:1"]);
  });

  it("合并时用另一条补齐 base 全部缺失字段（含 encoder）", () => {
    // base 先入池：信息完整度与 rich 并列，但缺 title/artist/album/genre/extra/cover/lyric
    const base = cand({
      id: "p:qq:1",
      url: "https://cdn.example.com/a.mp3",
      sourceRank: 5,
      probed: true,
      declared: {
        container: "mp3",
        bitrateKbps: 320,
        sampleRateHz: 44100,
        bitDepth: 16,
        channels: 2,
        durationSec: 240,
        bytes: 1000000,
      },
    });
    const rich = cand({
      id: "p:qq:1",
      url: "https://cdn.example.com/b.mp3",
      sourceRank: 1,
      title: "歌",
      artist: "人",
      album: "专辑",
      genre: "摇滚",
      extra: { k: "v" },
      coverUrl: "https://img.example.com/c.jpg",
      lyricUrl: "https://lrc.example.com/l.lrc",
      headers: { "User-Agent": "x" },
      declared: { encoder: "reference" },
    });
    const out = dedupeCandidates([base, rich]);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.title).toBe("歌");
    expect(m.artist).toBe("人");
    expect(m.album).toBe("专辑");
    expect(m.genre).toBe("摇滚");
    expect(m.extra).toEqual({ k: "v" });
    expect(m.coverUrl).toBe("https://img.example.com/c.jpg");
    expect(m.lyricUrl).toBe("https://lrc.example.com/l.lrc");
    expect(m.sourceRank).toBe(1);
    expect(m.declared?.container).toBe("mp3");
    expect(m.declared?.encoder).toBe("reference");
  });

  it("inspectUnavailable 的候选绝不做 base（合并时让位给可用候选）", () => {
    const good = cand({ id: "p:qq:1", url: "https://cdn.example.com/g.mp3", title: "可用" });
    const un = cand({
      id: "p:qq:1",
      url: "https://cdn.example.com/u.mp3",
      inspectUnavailable: true,
      declared: { bitrateKbps: 999 },
    });
    const out = dedupeCandidates([un, good]);
    expect(out).toHaveLength(1);
    expect(out[0].inspectUnavailable).not.toBe(true);
    expect(out[0].title).toBe("可用");
  });
});

describe("覆盖率补充:inspect/排序/身份边界", () => {
  it("inspect 只返回 bitrateKbps(无 bytes) → 只采纳码率", async () => {
    const source = inspectStub(() => ({ valid: true, bitrateKbps: 700 }));
    const out = await collectCandidates({ target, sources: [source] });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.declared?.bitrateKbps === 700)).toBe(true);
    expect(out.every((c) => c.declared?.bytes === undefined)).toBe(true);
  });

  it("候选无任何声明(缺 duration)时 hintRank 归 unknown,排序不抛", async () => {
    const source = src("go-music-dl", ["stream", "search"], {
      async search() {
        return { songs: [{ id: "1", source: "qq", name: "歌", artist: "人", album: "专", cover: "" }] }; // 无 duration
      },
      streamUrl(_c: any) {
        return "https://cdn.example.com/1.mp3";
      },
      inspectSong: async () => ({ valid: true, bitrateKbps: 500 }),
    });
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(1);
    expect(out[0].declared?.bitrateKbps).toBe(500);
  });

  it("直链无音频后缀且无曲目时长 → 声明质量整体为空(compactQuality → undefined)", async () => {
    const source = rawSearchStub(
      [{ id: "1", source: "qq", name: "歌", artist: "人", album: "专", cover: "" }], // 无 duration
      () => "https://cdn.example.com/dl/stream",
    );
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(1);
    expect(out[0].declared).toBeUndefined();
  });

  it("extra 的 genre 为空串 → 不臆造 genre", async () => {
    const source = rawSearchStub([songOf({ extra: { genre: "" } })], () => "https://cdn.example.com/1.mp3");
    const out = await collectCandidates({ target, sources: [source] });
    expect(out[0].genre).toBeUndefined();
  });

  it("streamUrl 返回非法 URL → 该搜索结果被跳过", async () => {
    const source = src("go-music-dl", ["stream", "search"], {
      async search() {
        return { songs: [songOf({ id: "1" }), songOf({ id: "2" })] };
      },
      streamUrl(_c: any, s: any) {
        return s.id === "1" ? "not-a-url" : "https://cdn.example.com/2.mp3";
      },
    });
    const out = await collectCandidates({ target, sources: [source] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("go-music-dl:qq:2");
  });

  it("合并时双方 sourceRank 都缺失 → 按 0 处理且不误判", () => {
    const a = cand({ id: "p:qq:1", url: "https://cdn.example.com/a.mp3", sourceRank: undefined as any });
    const b = cand({ id: "p:qq:1", url: "https://cdn.example.com/b.mp3", sourceRank: undefined as any });
    const out = dedupeCandidates([a, b]);
    expect(out).toHaveLength(1);
  });

  it("候选 id 缺失时不参与身份键合并", () => {
    const a = { ...cand({ url: "https://cdn.example.com/a.mp3" }), id: undefined as any };
    const b = cand({ id: "p:qq:1", url: "https://cdn.example.com/b.mp3" });
    const out = dedupeCandidates([a, b]);
    expect(out).toHaveLength(2);
  });
});
