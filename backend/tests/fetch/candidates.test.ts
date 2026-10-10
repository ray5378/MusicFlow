import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  DEFAULT_MAX_CANDIDATES_PER_SONG,
  collectCandidates,
  dedupeCandidates,
  nextCandidate,
} from "../../src/services/fetch/candidates.js";
import type { CandidateSource, FetchTarget } from "../../src/services/fetch/candidates.js";
import type { Candidate } from "../../src/services/fetch/types.js";

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
