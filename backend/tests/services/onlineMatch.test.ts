// ==================== 在线匹配(match.ts)行为测试 ====================
// 目标:覆盖 src/services/source/online/match.ts 的
//   searchBestMatch(查询构造/打分排序/门禁/批内缓存) /
//   matchToOnlineSong(单首搜索→导入→链接条目) /
//   matchUnmatchedPlaylistEntries(阶段0 库内短路 + 阶段1 并发搜索 + 阶段2 批量导入与
//   分块事务链接 + 进度回调 + 节流) / crossVerifySongs(上游整单交叉比对)。
//
// 手法:mock 掉在线导入 service、libraryMatch(库内短路)、batchPacer(并发/节流)、
//       covers(封面回填)与 shared.refreshPlaylistCounts;DB 用真实 SQLite
//       (每文件独立 DATA_DIR,见 tests/setup.ts),_env 必须在最前。
//       **passesImportGate 走真实实现** —— 门禁语义是被测契约的一部分,不 mock。
//   注:mock 路径按【本测试文件】的相对路径解析(踩过坑:写错路径 → mock 静默不生效,
//       用例会走真实实现而"恰好通过")。因此这里对关键 mock 都补了「确被以预期参数调用」
//       的断言,例如 refreshPlaylistCounts / importOnlineSongs 的入参。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";

const H = vi.hoisted(() => ({
  importOnlineSong: vi.fn(async () => ({ success: true, songId: "s-new", deduped: false }) as any),
  importOnlineSongs: vi.fn(async () => ({ added: 0, deduped: 0, failed: 0, songs: [] as any[] }) as any),
  matchSongsToLibrary: vi.fn((): (string | null)[] => []),
  batchConcurrency: vi.fn(() => 1),
  sleepBetweenBatch: vi.fn(async () => {}),
  runCoverBackfill: vi.fn(async () => ({}) as any),
  refreshPlaylistCounts: vi.fn(),
}));

vi.mock("../../src/services/source/online/service.js", async (io) => ({
  ...(await io<any>()),
  importOnlineSong: H.importOnlineSong,
  importOnlineSongs: H.importOnlineSongs,
}));
vi.mock("../../src/services/plugin/libraryMatch.js", async (io) => ({
  ...(await io<any>()),
  matchSongsToLibrary: H.matchSongsToLibrary,
}));
vi.mock("../../src/services/plugin/batchPacer.js", async (io) => ({
  ...(await io<any>()),
  batchConcurrency: H.batchConcurrency,
  sleepBetweenBatch: H.sleepBetweenBatch,
}));
vi.mock("../../src/services/covers.js", async (io) => ({
  ...(await io<any>()),
  runCoverBackfill: H.runCoverBackfill,
}));
// shared.js 导出众多(依赖链里还有别人在读它的其它导出)→ 必须 importOriginal 展开,
// 只覆盖 refreshPlaylistCounts;strictNormEquals 保留真实实现(打分/门禁判等要靠它)。
vi.mock("../../src/services/plugin/shared.js", async (io) => ({
  ...(await io<any>()),
  refreshPlaylistCounts: H.refreshPlaylistCounts,
}));

import {
  searchBestMatch,
  matchToOnlineSong,
  matchUnmatchedPlaylistEntries,
  crossVerifySongs,
} from "../../src/services/source/online/match.js";

// ---------------- seed 助手(外键顺序:users → playlists → songs → playlist_songs) ----------------
const iso = () => new Date().toISOString();
let seq = 0;

function nextPid() {
  return `pl-b15-${++seq}`;
}
function seedPlaylist(id: string) {
  const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  sqlite
    .prepare("INSERT INTO playlists (id, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(id, `歌单-${id}`, owner.id, iso(), iso());
}
function seedSongRow(id: string) {
  // OR IGNORE:同一文件的多个用例会复用同一个 songId(DB 是**每文件**一份,不是每用例一份)。
  sqlite.prepare("INSERT OR IGNORE INTO songs (id, title, path) VALUES (?,?,?)").run(id, `T-${id}`, `l:${id}.mp3`);
}
function addEntry(playlistId: string, over: Record<string, any> = {}) {
  const r = sqlite
    .prepare(
      `INSERT INTO playlist_songs
         (playlist_id, song_id, position, playable, external_title, external_artist, external_album, external_duration)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      playlistId,
      over.songId ?? null,
      over.position ?? 0,
      over.playable ?? 0,
      over.externalTitle ?? null,
      over.externalArtist ?? null,
      over.externalAlbum ?? null,
      over.externalDuration ?? null,
    );
  return Number(r.lastInsertRowid);
}
function entryRow(id: number) {
  return sqlite.prepare("SELECT * FROM playlist_songs WHERE id = ?").get(id) as any;
}

/** 一条在线候选(默认:标题「歌」/歌手「歌手」/专辑「专辑」/200 秒)。 */
function cand(over: Record<string, any> = {}) {
  return { id: "c1", source: "qq", name: "歌", artist: "歌手", album: "专辑", duration: 200, cover: "", ...over };
}
function prov(songs: any[], searchImpl?: any) {
  return { search: vi.fn(searchImpl ?? (async () => ({ songs }))) };
}
function provByQuery(map: Record<string, any[]>) {
  return { search: vi.fn(async (_c: any, p: any) => ({ songs: map[p.query] ?? [] })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.importOnlineSong.mockImplementation(async () => ({ success: true, songId: "s-new", deduped: false }));
  H.importOnlineSongs.mockImplementation(async () => ({ added: 0, deduped: 0, failed: 0, songs: [] }));
  H.matchSongsToLibrary.mockImplementation(() => []);
  H.batchConcurrency.mockImplementation(() => 1);
  H.sleepBetweenBatch.mockImplementation(async () => {});
  H.runCoverBackfill.mockImplementation(async () => ({}));
});

// ==================== searchBestMatch ====================
describe("searchBestMatch:查询构造 / 打分排序 / 门禁 / 批内缓存", () => {
  it("标题与歌手都为空 → no-match『缺少歌曲标题』,不发起搜索", async () => {
    const p = prov([cand()]);
    const r = await searchBestMatch("prov", {}, p, { entryId: 7, title: "", artist: "" }, undefined);
    expect(r.status).toBe("no-match");
    expect(r.message).toBe("缺少歌曲标题");
    expect(r.best).toBeUndefined();
    expect(p.search).not.toHaveBeenCalled();
  });

  it("provider 没有 search 方法 → error『provider 不支持搜索』", async () => {
    const r = await searchBestMatch("prov", {}, {} as any, { entryId: 7, title: "歌", artist: "歌手" }, undefined);
    expect(r).toEqual({ entryId: 7, title: "歌", status: "error", message: "provider 不支持搜索" });
  });

  it("搜索结果为空数组 → no-match『未搜索到结果』", async () => {
    const r = await searchBestMatch("prov", {}, prov([]), { entryId: 7, title: "歌", artist: "歌手" }, undefined);
    expect(r.status).toBe("no-match");
    expect(r.message).toBe("未搜索到结果");
  });

  it("查询串 = 标题 + 空格 + 歌手,config 原样透传给 provider.search", async () => {
    const cfg = { baseUrl: "http://x" };
    const p = prov([cand()]);
    await searchBestMatch("prov", cfg, p, { entryId: 1, title: "歌", artist: "歌手" }, undefined);
    expect(p.search).toHaveBeenCalledWith(cfg, { query: "歌 歌手" });
  });

  it("标题/歌手/专辑/时长四维全中 → matched,score=44(20+8+10+6)", async () => {
    const best = cand();
    const r = await searchBestMatch(
      "prov", {}, prov([best]),
      { entryId: 1, title: "歌", artist: "歌手", album: "专辑", duration: 200000 },
      undefined,
    );
    expect(r.status).toBe("matched");
    expect(r.best).toBe(best);
    expect(r.score).toBe(44);
  });

  it("多候选按分数取最高:专辑一致者压过专辑不一致者", async () => {
    const wrong = cand({ id: "c-wrong", album: "别的" }); // 20+8+10 = 38
    const right = cand({ id: "c-right", album: "专辑" }); // 20+8+10+6 = 44
    const r = await searchBestMatch(
      "prov", {}, prov([wrong, right]),
      { entryId: 1, title: "歌", artist: "歌手", album: "专辑", duration: 200000 },
      undefined,
    );
    expect(r.best!.id).toBe("c-right");
    expect(r.score).toBe(44);
  });

  it("最佳候选标题不一致 → 门禁拦下,message 带出 reason 与最佳候选名", async () => {
    const r = await searchBestMatch(
      "prov", {}, prov([cand({ name: "别的歌" })]),
      { entryId: 1, title: "歌", artist: "歌手" },
      undefined,
    );
    expect(r.status).toBe("no-match");
    expect(r.message).toContain("未通过导入门禁[title]");
    expect(r.message).toContain("最佳候选:别的歌");
  });

  it("最佳候选歌手不一致 → reason=artist", async () => {
    const r = await searchBestMatch(
      "prov", {}, prov([cand({ artist: "别人" })]),
      { entryId: 1, title: "歌", artist: "歌手" },
      undefined,
    );
    expect(r.message).toContain("[artist]");
  });

  it("期望侧有专辑但候选无专辑 → 『候选无专辑,无法核实』", async () => {
    const r = await searchBestMatch(
      "prov", {}, prov([cand({ album: "" })]),
      { entryId: 1, title: "歌", artist: "歌手", album: "专辑" },
      undefined,
    );
    expect(r.message).toContain("[album]");
    expect(r.message).toContain("候选无专辑,无法核实");
  });

  it("时长差 20s(超默认容差 1s)→ reason=duration", async () => {
    const r = await searchBestMatch(
      "prov", {}, prov([cand({ duration: 220 })]),
      { entryId: 1, title: "歌", artist: "歌手", duration: 200000 },
      undefined,
    );
    expect(r.message).toContain("[duration]");
    expect(r.message).toContain("时长超容差");
  });

  it("时长差 6s(打分只给 +5、但门禁仍拦)→ 说明分值与放行是两套口径", async () => {
    const r = await searchBestMatch(
      "prov", {}, prov([cand({ duration: 206 })]),
      { entryId: 1, title: "歌", artist: "歌手", duration: 200000 },
      undefined,
    );
    expect(r.status).toBe("no-match");
    expect(r.message).toContain("[duration]");
  });

  it("期望侧无专辑、无时长 → 只校验标题 + 歌手,score=28", async () => {
    const r = await searchBestMatch(
      "prov", {}, prov([cand()]),
      { entryId: 1, title: "歌", artist: "歌手" },
      undefined,
    );
    expect(r.status).toBe("matched");
    expect(r.score).toBe(28);
  });

  it("期望侧无歌手 → 歌手维度跳过(不因候选歌手不同而失分)", async () => {
    const r = await searchBestMatch(
      "prov", {}, prov([cand({ artist: "谁都不认识" })]),
      { entryId: 1, title: "歌", artist: "" },
      undefined,
    );
    expect(r.status).toBe("matched");
    expect(r.score).toBe(20);
  });

  it("批内缓存命中 → 直接复用首次结果,不再发起任何搜索", async () => {
    const best = cand();
    const cache = new Map<string, any>([["歌|歌手", { status: "matched", best, score: 44 }]]);
    const p = prov([cand({ name: "别的" })]);
    const r = await searchBestMatch("prov", {}, p, { entryId: 3, title: " 歌 ", artist: " 歌手 " }, cache);
    expect(r.status).toBe("matched");
    expect(r.best).toBe(best);
    expect(r.score).toBe(44);
    expect(p.search).not.toHaveBeenCalled();
  });

  it("缓存键用原文 trim+lowercase(不归一化)→ 假名标题不会与别的歌共用键", async () => {
    const cache = new Map<string, any>();
    await searchBestMatch("prov", {}, prov([cand({ name: "ソラ" })]), { entryId: 1, title: "ソラ", artist: "" }, cache);
    expect([...cache.keys()]).toEqual(["ソラ|"]);
  });

  it("命中时写入缓存 matched(带 best 与 score)", async () => {
    const cache = new Map<string, any>();
    const best = cand();
    await searchBestMatch("prov", {}, prov([best]), { entryId: 1, title: "歌", artist: "歌手" }, cache);
    expect(cache.get("歌|歌手")).toMatchObject({ status: "matched", score: 28, best });
  });

  it("门禁失败时写入缓存 no-match(带 message)", async () => {
    const cache = new Map<string, any>();
    await searchBestMatch("prov", {}, prov([cand({ name: "别的" })]), { entryId: 1, title: "歌", artist: "歌手" }, cache);
    const hit = cache.get("歌|歌手");
    expect(hit.status).toBe("no-match");
    expect(hit.message).toContain("未通过导入门禁[title]");
    expect(hit.best).toBeUndefined();
  });

  it("不传 cache → 同一目标两次调用各发起一次真实搜索(单首实况匹配保持原行为)", async () => {
    const p = prov([cand()]);
    const want = { entryId: 1, title: "歌", artist: "歌手" };
    await searchBestMatch("prov", {}, p, want, undefined);
    await searchBestMatch("prov", {}, p, want, undefined);
    expect(p.search).toHaveBeenCalledTimes(2);
  });
});

// ==================== matchToOnlineSong ====================
describe("matchToOnlineSong:搜索 → 导入 → 链接歌单条目", () => {
  it("命中且导入成功 → 条目落 song_id/playable=1/清空不可用原因 + 刷计数 + 回填封面", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    seedSongRow("s-new");
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });

    const r = await matchToOnlineSong("prov", {}, prov([cand()]), pid, { entryId: e, title: "歌", artist: "歌手" });

    expect(r).toEqual({
      entryId: e, title: "歌", status: "matched", songId: "s-new",
      matchedSource: "qq", matchedName: "歌", message: "已导入",
    });
    const row = entryRow(e);
    expect(row.song_id).toBe("s-new");
    expect(row.playable).toBe(1);
    expect(row.unavailable_reason).toBeNull();
    // 关键 mock 的入参校验(防「mock 没生效、走了真实实现」的假绿)
    expect(H.refreshPlaylistCounts).toHaveBeenCalledWith(pid);
    expect(H.runCoverBackfill).toHaveBeenCalledWith(["s-new"]);
    expect(H.importOnlineSong.mock.calls[0][0]).toBe("prov");
    expect(H.importOnlineSong.mock.calls[0][2]).toEqual({ gate: "verified" });
  });

  it("导入结果为去重 → message『已导入(去重)』", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    seedSongRow("s-dup");
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    H.importOnlineSong.mockImplementation(async () => ({ success: true, songId: "s-dup", deduped: true }));
    const r = await matchToOnlineSong("prov", {}, prov([cand()]), pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r.message).toBe("已导入(去重)");
    expect(r.songId).toBe("s-dup");
  });

  it("搜索 no-match → 不导入、不链接,状态原样透传", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    const r = await matchToOnlineSong("prov", {}, prov([]), pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r).toEqual({ entryId: e, title: "歌", status: "no-match", message: "未搜索到结果" });
    expect(H.importOnlineSong).not.toHaveBeenCalled();
    expect(entryRow(e).song_id).toBeNull();
  });

  it("门禁未通过也是 no-match(不会误绑),message 带 reason", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    const r = await matchToOnlineSong("prov", {}, prov([cand({ artist: "别人" })]), pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r.status).toBe("no-match");
    expect(r.message).toContain("[artist]");
    expect(H.importOnlineSong).not.toHaveBeenCalled();
  });

  it("导入失败带 error → status=error 且 message 用导入侧原因", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    H.importOnlineSong.mockImplementation(async () => ({ success: false, error: "磁盘满了" }));
    const r = await matchToOnlineSong("prov", {}, prov([cand()]), pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r.status).toBe("error");
    expect(r.message).toBe("磁盘满了");
    expect(entryRow(e).song_id).toBeNull();
  });

  it("导入未成功且未给原因 → 回落『导入失败』", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    H.importOnlineSong.mockImplementation(async () => ({ success: true })); // 无 songId
    const r = await matchToOnlineSong("prov", {}, prov([cand()]), pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r.status).toBe("error");
    expect(r.message).toBe("导入失败");
  });

  it("导入抛错 → 捕获成 error(不冒给调用方),message 取异常 message", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    H.importOnlineSong.mockImplementation(async () => { throw new Error("DB 锁了"); });
    const r = await matchToOnlineSong("prov", {}, prov([cand()]), pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r).toEqual({ entryId: e, title: "歌", status: "error", message: "DB 锁了" });
  });

  it("抛出的不是 Error(没有 message)→ 回落『匹配失败』", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    const p = { search: vi.fn(async () => { throw { code: 42 }; }) };
    const r = await matchToOnlineSong("prov", {}, p, pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r.status).toBe("error");
    expect(r.message).toBe("匹配失败");
  });

  it("provider.search 抛错 → 同样被收敛成 error 结果", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    const p = { search: vi.fn(async () => { throw new Error("上游 502"); }) };
    const r = await matchToOnlineSong("prov", {}, p, pid, { entryId: e, title: "歌", artist: "歌手" });
    expect(r.message).toBe("上游 502");
  });
});

// ==================== matchUnmatchedPlaylistEntries ====================
describe("matchUnmatchedPlaylistEntries:条目筛选", () => {
  it("已可播 / 已绑定 songId / 标题空白的条目一律不在范围内 → total=0", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    seedSongRow("s-bound");
    addEntry(pid, { externalTitle: "已可播", playable: 1 });
    addEntry(pid, { externalTitle: "已绑定", songId: "s-bound" });
    addEntry(pid, { externalTitle: "   " });
    addEntry(pid, { externalTitle: null });

    const p = prov([cand()]);
    const r = await matchUnmatchedPlaylistEntries("prov", {}, p, pid);

    expect(r).toEqual({ total: 0, matched: 0, noMatch: 0, error: 0, results: [] });
    expect(p.search).not.toHaveBeenCalled();
    expect(H.matchSongsToLibrary).toHaveBeenCalledWith([]);
    // 即便全被过滤,也兜底刷新一次歌单计数
    expect(H.refreshPlaylistCounts).toHaveBeenCalledWith(pid);
  });
});

describe("matchUnmatchedPlaylistEntries:阶段0 库内短路", () => {
  it("库内已有同名同歌手 → 直接绑旧行,完全不消耗在线搜索", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    seedSongRow("s-local");
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手", externalAlbum: "专辑", externalDuration: 200000 });
    H.matchSongsToLibrary.mockImplementation(() => ["s-local"]);

    const p = prov([cand()]);
    const progress: any[] = [];
    const r = await matchUnmatchedPlaylistEntries("prov", {}, p, pid, (d, t, o) => progress.push([d, t, o.status, o.songId]));

    expect(r.total).toBe(1);
    expect(r.matched).toBe(1);
    // 现状(缺陷台账 D21):阶段0 写下的 message「库内已有,直接绑定(不进在线搜索)」会被
    // 阶段1 的同一条命中**无条件覆盖**成「库内已有,直接绑定」—— 阶段0 那句文案到不了调用方。
    expect(r.results[0]).toMatchObject({
      entryId: e, status: "matched", songId: "s-local", message: "库内已有,直接绑定",
    });
    expect(p.search).not.toHaveBeenCalled();
    expect(H.importOnlineSongs).not.toHaveBeenCalled();
    const row = entryRow(e);
    expect(row.song_id).toBe("s-local");
    expect(row.playable).toBe(1);
    expect(row.unavailable_reason).toBeNull();
    expect(progress).toEqual([[1, 1, "matched", "s-local"]]);
    // 传给库内匹配的入参口径:毫秒 → 秒取整;专辑缺省 undefined
    expect(H.matchSongsToLibrary.mock.calls[0][0]).toEqual([
      { title: "歌", artist: "歌手", album: "专辑", duration: 200 },
    ]);
  });

  it("没有 externalDuration → 传给库内匹配的 duration 是 null(不是 0)", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    H.matchSongsToLibrary.mockImplementation(() => [null]);
    await matchUnmatchedPlaylistEntries("prov", {}, prov([]), pid);
    expect(H.matchSongsToLibrary.mock.calls[0][0]).toEqual([
      { title: "歌", artist: "歌手", album: undefined, duration: null },
    ]);
    expect(e).toBeGreaterThan(0);
  });
});

describe("matchUnmatchedPlaylistEntries:阶段1 搜索 + 阶段2 批量导入链接", () => {
  it("在线命中 → 批量导入后按指纹链接条目,results 回填『已导入』,matched 计数", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    seedSongRow("s-web1");
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    H.importOnlineSongs.mockImplementation(async () => ({
      added: 1, deduped: 0, failed: 0, songs: [{ id: "s-web1", title: "歌", fingerprint: "prov:qq:c1" }],
    }));

    const progress: any[] = [];
    const r = await matchUnmatchedPlaylistEntries("prov", {}, prov([cand()]), pid, (d, t, o) => progress.push([d, t, o.status]));

    expect(r.total).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.noMatch).toBe(0);
    expect(r.error).toBe(0);
    expect(r.results[0]).toMatchObject({
      entryId: e, status: "matched", songId: "s-web1", matchedSource: "qq", matchedName: "歌", message: "已导入",
    });
    expect(entryRow(e).song_id).toBe("s-web1");
    expect(entryRow(e).playable).toBe(1);
    // 阶段1 的进度回调先把「待导入」抛出来,阶段2 才回填 songId
    expect(progress).toEqual([[1, 1, "matched"]]);
    expect(H.importOnlineSongs.mock.calls[0][0]).toBe("prov");
    expect(H.importOnlineSongs.mock.calls[0][2]).toEqual({ gate: "verified" });
    expect(H.refreshPlaylistCounts).toHaveBeenCalledWith(pid);
  });

  it("阶段2 指纹对不上(批量导入没产出该首)→ 该条改报 error『批量导入失败』并计入 error", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    H.importOnlineSongs.mockImplementation(async () => ({ added: 0, deduped: 0, failed: 1, songs: [] }));

    const r = await matchUnmatchedPlaylistEntries("prov", {}, prov([cand()]), pid);

    expect(r.matched).toBe(0);
    expect(r.error).toBe(1);
    expect(r.results[0]).toEqual({ entryId: e, title: "歌", status: "error", message: "批量导入失败" });
    expect(entryRow(e).song_id).toBeNull();
  });

  it("阶段1 搜索侧报错(provider 不支持搜索)→ 计入 error 而不是 noMatch", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e = addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });

    const r = await matchUnmatchedPlaylistEntries("prov", {}, {} as any, pid);

    expect(r.error).toBe(1);
    expect(r.noMatch).toBe(0);
    expect(r.matched).toBe(0);
    expect(r.results[0]).toEqual({ entryId: e, title: "歌", status: "error", message: "provider 不支持搜索" });
    expect(H.importOnlineSongs).not.toHaveBeenCalled();
  });

  it("搜索无结果 → 计入 noMatch(与 error 分开)", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    addEntry(pid, { externalTitle: "歌", externalArtist: "歌手" });
    const r = await matchUnmatchedPlaylistEntries("prov", {}, prov([]), pid);
    expect(r).toMatchObject({ total: 1, matched: 0, noMatch: 1, error: 0 });
  });

  it("库内短路与在线命中混跑:两条都算 matched,各自保留自己的结果口径", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    seedSongRow("s-local");
    seedSongRow("s-web");
    const eLocal = addEntry(pid, { externalTitle: "库内歌", externalArtist: "甲" });
    const eWeb = addEntry(pid, { externalTitle: "在线歌", externalArtist: "乙" });
    H.matchSongsToLibrary.mockImplementation(() => ["s-local", null]);
    H.importOnlineSongs.mockImplementation(async () => ({
      added: 1, deduped: 0, failed: 0, songs: [{ id: "s-web", title: "在线歌", fingerprint: "prov:qq:c-online" }],
    }));
    const p = provByQuery({ "在线歌 乙": [cand({ id: "c-online", name: "在线歌", artist: "乙" })] });

    const r = await matchUnmatchedPlaylistEntries("prov", {}, p, pid);

    expect(r.matched).toBe(2);
    expect(r.total).toBe(2);
    expect(r.results[0]).toMatchObject({ entryId: eLocal, songId: "s-local", message: "库内已有,直接绑定" });
    expect(r.results[1]).toMatchObject({ entryId: eWeb, songId: "s-web", message: "已导入" });
    expect(entryRow(eLocal).song_id).toBe("s-local");
    expect(entryRow(eWeb).song_id).toBe("s-web");
    // 库内短路那条不该浪费一次在线搜索
    expect(p.search).toHaveBeenCalledTimes(1);
  });

  it("批内缓存:同一 (标题,歌手) 重复 10 条 → 只发 1 次搜索;第 10 条触发一次节流让行", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    seedSongRow("s-same");
    for (let i = 0; i < 10; i++) addEntry(pid, { externalTitle: "同一首", externalArtist: "同一人" });
    H.importOnlineSongs.mockImplementation(async () => ({
      added: 1, deduped: 9, failed: 0, songs: [{ id: "s-same", title: "同一首", fingerprint: "prov:qq:c-same" }],
    }));
    const p = prov([cand({ id: "c-same", name: "同一首", artist: "同一人" })]);

    const r = await matchUnmatchedPlaylistEntries("prov", {}, p, pid);

    expect(p.search).toHaveBeenCalledTimes(1);
    expect(H.sleepBetweenBatch).toHaveBeenCalledTimes(1);
    expect(r.total).toBe(10);
    expect(r.matched).toBe(10);
    expect(r.results.every((x) => x.status === "matched" && x.songId === "s-same")).toBe(true);
  });

  it("并发档位由 batchPacer 决定,且所有条目都会被处理完", async () => {
    const pid = nextPid();
    seedPlaylist(pid);
    const e1 = addEntry(pid, { externalTitle: "一", externalArtist: "人" });
    const e2 = addEntry(pid, { externalTitle: "二", externalArtist: "人" });
    const e3 = addEntry(pid, { externalTitle: "三", externalArtist: "人" });
    H.batchConcurrency.mockImplementation(() => 3);
    const p = provByQuery({
      "一 人": [cand({ id: "a", name: "一", artist: "人" })],
      "二 人": [cand({ id: "b", name: "二", artist: "人" })],
      "三 人": [cand({ id: "c", name: "三", artist: "人" })],
    });
    H.importOnlineSongs.mockImplementation(async (_p: any, list: any[]) => ({
      added: list.length, deduped: 0, failed: 0,
      songs: list.map((s) => ({ id: `s-${s.id}`, title: s.name, fingerprint: `prov:qq:${s.id}` })),
    }));
    ["s-a", "s-b", "s-c"].forEach(seedSongRow);

    const r = await matchUnmatchedPlaylistEntries("prov", {}, p, pid);

    expect(r.total).toBe(3);
    expect(r.matched).toBe(3);
    expect(new Set(r.results.map((x) => x.entryId))).toEqual(new Set([e1, e2, e3]));
    expect(H.batchConcurrency).toHaveBeenCalled();
  });
});

// ==================== crossVerifySongs ====================
describe("crossVerifySongs:上游整单导入的交叉比对", () => {
  it("空数组 → 直接返回空结果,不发起任何搜索", async () => {
    const p = prov([cand()]);
    const r = await crossVerifySongs("prov", {}, p, []);
    expect(r).toEqual({ verified: [], rejected: 0 });
    expect(p.search).not.toHaveBeenCalled();
  });

  it("搜到全命中候选 → 收进 verified(用搜索验证过的候选替换上游对象)", async () => {
    const verified = cand({ id: "good", name: "好", artist: "人" });
    const p = provByQuery({ "好 人": [verified] });
    const upstream = cand({ id: "up", name: "好", artist: "人" });
    const r = await crossVerifySongs("prov", {}, p, [upstream]);
    expect(r.rejected).toBe(0);
    expect(r.verified).toEqual([verified]);
    expect(r.verified[0]).toBe(verified);
  });

  it("搜到候选但门禁不过 → 计入 rejected,不带进 verified", async () => {
    // 歌手刻意取「无包含关系」的两个名字:「张三」与「李四」——
    // 门禁的歌手判等是「相等或互为包含」,若用「人 / 别人」这种子串关系会被判成命中。
    const p = provByQuery({ "坏 张三": [cand({ id: "bad", name: "坏", artist: "李四" })] });
    const r = await crossVerifySongs("prov", {}, p, [cand({ id: "up", name: "坏", artist: "张三" })]);
    expect(r.verified).toEqual([]);
    expect(r.rejected).toBe(1);
  });

  it("上游时长按秒构造期望值(秒 → 毫秒)→ 候选时长一致时可过门禁", async () => {
    const p = provByQuery({ "好 人": [cand({ id: "good", name: "好", artist: "人", duration: 200 })] });
    const r = await crossVerifySongs("prov", {}, p, [cand({ id: "up", name: "好", artist: "人", duration: 200 })]);
    expect(r.verified.length).toBe(1);
  });

  it("候选时长明显不符 → duration 维度拒绝", async () => {
    const p = provByQuery({ "好 人": [cand({ id: "good", name: "好", artist: "人", duration: 260 })] });
    const r = await crossVerifySongs("prov", {}, p, [cand({ id: "up", name: "好", artist: "人", duration: 200 })]);
    expect(r.rejected).toBe(1);
  });

  it("非交互式(后台批量)→ 每首之后都让行一次", async () => {
    const p = provByQuery({
      "一 人": [cand({ id: "a", name: "一", artist: "人" })],
      "二 人": [cand({ id: "b", name: "二", artist: "人" })],
    });
    await crossVerifySongs("prov", {}, p, [cand({ id: "u1", name: "一", artist: "人" }), cand({ id: "u2", name: "二", artist: "人" })]);
    expect(H.sleepBetweenBatch).toHaveBeenCalledTimes(2);
  });

  it("交互式(搜索加入库)→ 全速,不让行", async () => {
    const p = provByQuery({ "一 人": [cand({ id: "a", name: "一", artist: "人" })] });
    await crossVerifySongs("prov", {}, p, [cand({ id: "u1", name: "一", artist: "人" })], { interactive: true });
    expect(H.sleepBetweenBatch).not.toHaveBeenCalled();
  });

  it("批内缓存:同 (标题,歌手) 两首只真实搜索一次,但两首都进 verified", async () => {
    const p = provByQuery({ "好 人": [cand({ id: "good", name: "好", artist: "人" })] });
    const r = await crossVerifySongs("prov", {}, p, [
      cand({ id: "u1", name: "好", artist: "人" }),
      cand({ id: "u2", name: "好", artist: "人" }),
    ], { interactive: true });
    expect(p.search).toHaveBeenCalledTimes(1);
    expect(r.verified.length).toBe(2);
  });

  it("搜索关键字由上游的 标题 + 歌手 拼成", async () => {
    const p = provByQuery({ "好 人": [cand({ id: "good", name: "好", artist: "人" })] });
    await crossVerifySongs("prov", {}, p, [cand({ id: "u1", name: "好", artist: "人" })], { interactive: true });
    expect(p.search.mock.calls[0][1]).toEqual({ query: "好 人" });
  });
});
