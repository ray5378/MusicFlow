// tagRepair 测试：标签缺失修复（歌词/封面/专辑）的探缺判定与「拿得到才写」铁律。
//
// 覆盖：
//   1. fsPathOf 解析 `l:<sourceId>:<fsPath>`；
//   2. 范围硬门禁：不在两个下载根内的本地路径直接 skip（绝不碰云盘库）；
//   3. 文件不可解析（parseFile 抛错）→ skip，不写；
//   4. 文件标签其实齐 → skip（不重写、不网络请求）；DB has_lyrics=0 但文件有歌词 → 只对齐 DB；
//   5. 缺封面 + provider 拿到 URL + 下载缓存成功 → writeTags 收到封面本地路径；
//   6. 缺封面但 provider 拿不到 → unobtainable，绝不 writeTags；
//   7. 缺歌词 + searchLyrics 拿到 → writeTags 收到歌词 + DB has_lyrics 置 1；
//   8. 缺专辑 + DB 行有声明值 → 不发任何网络请求，writeTags 直接收 album；
//   9. 队列：入队初始延迟（10min）、失败退避（1h/6h/24h）、3 败弃权、成功出队；
//  10. 单飞：repairing 中再触发返回 busy。
//
// music-metadata / providers / tagWriter / playlistCover 全部 mock（不碰 ffmpeg、
// 不发网络）；settings 与 songs 行用隔离 DATA_DIR 的真实 DB。

import "../plugins/_env.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { db, sqlite } from "../../src/db/index.js";
import { albums, songs } from "../../src/db/schema.js";
import { getDataDir } from "../../src/utils/env.js";
import { _resetSettingsCacheForTest, getSetting } from "../../src/services/settings.js";
import {
  currentFetchConfig,
  saveFetchConfigOverride,
} from "../../src/services/fetch/configStore.js";
import {
  fsPathOf,
  repairSongTags,
  enqueueTagRepairs,
  processTagRepairQueue,
  runTagRepairOnce,
  _resetTagRepairForTest,
  getTagRepairStats,
  getTagRepairProgress,
  getTagRepairRepairedTotal,
} from "../../src/services/fetch/tagRepair.js";
import { markTagRepairDone, isTagRepairMarked, getTagRepairPlatformCounts } from "../../src/services/fetch/tagRepairMarker.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";

// 退避重试测试加速：单元测试无需真等 3s / 6s / 12s（见 tagRepair.ts 的 tagRetryDelaysMs）。
// 必须是 3 个值，与生产退避次数一致（否则重试次数会少于 3 次）。
process.env.MF_TAG_RETRY_DELAYS_MS = "0,0,0";

// ---- mocks（Vitest5：工厂必须带出被依赖方用到的每个导出） --------------------

const parseFileMock = vi.hoisted(() => vi.fn());
vi.mock("music-metadata", () => ({ parseFile: parseFileMock }));

const searchCoverMock = vi.hoisted(() => vi.fn());
const searchLyricsMock = vi.hoisted(() => vi.fn());
const searchMetadataMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/plugins/providers.js", () => ({
  searchCover: searchCoverMock,
  searchLyrics: searchLyricsMock,
  searchMetadata: searchMetadataMock,
}));

const writeTagsMock = vi.hoisted(() => vi.fn());
// FetchTagError：源码 instanceof 判定用，测试直接构造实例（Vitest5 工厂必须带出全部被依赖导出）。
const MockFetchTagError = vi.hoisted(
  () =>
    class MockFetchTagError extends Error {
      constructor(
        readonly code: string,
        message: string,
        readonly file: string,
      ) {
        super(message);
        this.name = "FetchTagError";
      }
    },
);
const applyVariantMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/fetch/tagWriter.js", () => ({
  writeTags: writeTagsMock,
  // tagRepair 在写盘前调用 applyTagsVariant 做中文字形转换；此处透传（no-op），
  // 让断言看到 provider 原文（字形转换本身由 chineseConv 单测覆盖）。
  applyTagsVariant: applyVariantMock,
  FetchTagError: MockFetchTagError,
}));

const cacheRemoteCoverMock = vi.hoisted(() => vi.fn());
const resolveCoverFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/playlistCover.js", () => ({
  cacheRemoteCover: cacheRemoteCoverMock,
  resolveCoverFile: resolveCoverFileMock,
  // 透传执行：与真实现一致（只是没有 2 并发限制）。
  withCoverLimit: (fn: () => Promise<unknown>) => fn(),
}));

// ---- fixtures ----------------------------------------------------------------

let tmpDir: string;
let root: string;

function insertSong(
  id: string,
  fsPath: string,
  opts: { album?: string; albumId?: string; hasLyrics?: number | null } = {},
): void {
  mkdirSync(dirname(fsPath), { recursive: true });
  writeFileSync(fsPath, "fLaC-fake-audio-bytes");
  db.insert(songs)
    .values({
      id,
      title: "测试歌",
      artist: "测试歌手",
      album: opts.album ?? "测试专辑",
      albumId: opts.albumId ?? null,
      path: `l:dl-testsrc:${fsPath}`,
      suffix: "flac",
      bitRate: 900,
      size: 1,
      duration: 200,
      type: "local",
      contentType: "audio/flac",
      hasLyrics: opts.hasLyrics ?? 0,
    })
    .run();
}

function cfg(): FetchConfig {
  saveFetchConfigOverride({ downloadRoot: root, losslessRoot: "" } as Partial<FetchConfig>);
  return currentFetchConfig();
}

function queueState(): Record<string, { count: number; nextAt: number }> {
  return JSON.parse(getSetting("fetch.tagrepair.queue", "{}")) as Record<string, { count: number; nextAt: number }>;
}

/** 构造 parseFile 返回的 common 形状。
 *  探针读的维度：picture/lyrics/album + 专辑艺术家/轨/碟/年/流派（元数据维度）。
 *  默认全部「已存在」，用 over 开关模拟缺失。 */
function probe(over: Partial<{ cover: boolean; lyric: boolean; album: boolean; meta: boolean }> = {}): {
  common: {
    picture: unknown[];
    lyrics: string[];
    album: string;
    title: string;
    artist: string;
    albumartist: string;
    track: { no: number; of: number };
    disk: { no: number; of: number };
    year: number | null;
    genre: string[];
  };
} {
  const metaMissing = over.meta === false;
  return {
    common: {
      picture: over.cover === false ? [] : [{}],
      lyrics: over.lyric === false ? [] : ["[00:01]x"],
      album: over.album === false ? "" : "专辑",
      title: "测试歌",
      artist: "测试歌手",
      albumartist: metaMissing ? "" : "测试专辑艺术家",
      track: { no: metaMissing ? 0 : 3, of: 12 },
      disk: { no: metaMissing ? 0 : 1, of: 2 },
      year: metaMissing ? null : 2024,
      genre: metaMissing ? [] : ["Pop"],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSettingsCacheForTest();
  _resetTagRepairForTest();
  tmpDir = mkdtempSync(join(tmpdir(), "mf-tagrepair-"));
  root = join(tmpDir, "downloads");
  writeFileSync(join(tmpDir, "cover.jpg"), "fake-jpeg-bytes");
  searchCoverMock.mockResolvedValue(null);
  searchLyricsMock.mockResolvedValue(null);
  searchMetadataMock.mockResolvedValue(null);
  writeTagsMock.mockResolvedValue({ ok: true, file: "/x.flac", bytes: 1, mtimeMs: 1, warnings: [] });
  cacheRemoteCoverMock.mockResolvedValue(null);
  resolveCoverFileMock.mockReturnValue(null);
  parseFileMock.mockResolvedValue(probe());
});

afterEach(() => {
  vi.useRealTimers();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  db.delete(songs).run();
  db.delete(albums).run();
  _resetTagRepairForTest();
});

// ---- 1. fsPathOf ---------------------------------------------------------------

describe("fsPathOf", () => {
  it("解析 l:<sourceId>:<fsPath>，非 l: 前缀返回 null", () => {
    expect(fsPathOf("l:dl-abc:/MUSIC/DOWNLOAD/a.flac")).toBe("/MUSIC/DOWNLOAD/a.flac");
    expect(fsPathOf("w:uuid:/dav/a.flac")).toBeNull();
    expect(fsPathOf("web:go-music-dl:qq")).toBeNull();
    expect(fsPathOf("l:badformat")).toBeNull();
  });
});

// ---- 2-8. repairSongTags -------------------------------------------------------

describe("repairSongTags", () => {
  it("范围硬门禁：不在下载根内的路径 skip 且不发任何请求", async () => {
    const outside = join(tmpDir, "elsewhere", "a.flac");
    insertSong("s1", outside);
    const r = await repairSongTags("s1", cfg());
    expect(r.outcome).toBe("skip");
    expect(parseFileMock).not.toHaveBeenCalled();
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("文件不可解析（parseFile 抛错）→ skip 不写", async () => {
    const p = join(root, "a.flac");
    insertSong("s2", p);
    parseFileMock.mockRejectedValueOnce(new Error("boom"));
    const r = await repairSongTags("s2", cfg());
    expect(r.outcome).toBe("skip");
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("标签其实齐 → skip；DB has_lyrics=0 但文件有歌词 → 只对齐 DB", async () => {
    const p = join(root, "a.flac");
    insertSong("s3", p, { hasLyrics: 0 });
    parseFileMock.mockResolvedValueOnce(probe());
    const r = await repairSongTags("s3", cfg());
    expect(r.outcome).toBe("skip");
    expect(writeTagsMock).not.toHaveBeenCalled();
    expect(searchCoverMock).not.toHaveBeenCalled();
    const row = sqlite.prepare("SELECT has_lyrics FROM songs WHERE id='s3'").get() as { has_lyrics: number };
    expect(row.has_lyrics).toBe(1);
  });

  it("缺封面且 provider 拿到 → writeTags 收到封面本地路径", async () => {
    const p = join(root, "b.flac");
    insertSong("s4", p);
    parseFileMock.mockResolvedValueOnce(probe({ cover: false }));
    searchCoverMock.mockResolvedValueOnce("http://img.example/c.jpg");
    cacheRemoteCoverMock.mockResolvedValueOnce("tagfix-s4.jpg");
    const coverLocal = join(tmpDir, "cover.jpg");
    resolveCoverFileMock.mockReturnValueOnce(coverLocal);

    const r = await repairSongTags("s4", cfg());
    expect(r.outcome).toBe("fixed");
    expect(r.cover).toBe(true);
    expect(writeTagsMock).toHaveBeenCalledTimes(1);
    const tags = writeTagsMock.mock.calls[0][1];
    expect(tags.cover).toBe(coverLocal);
    expect(tags.lyric).toBeUndefined();
  });

  it("缺封面但 provider 拿不到 → unobtainable，绝不 writeTags", async () => {
    const p = join(root, "c.flac");
    insertSong("s5", p);
    parseFileMock.mockResolvedValueOnce(probe({ cover: false }));
    searchCoverMock.mockResolvedValueOnce(null);

    const r = await repairSongTags("s5", cfg());
    expect(r.outcome).toBe("unobtainable");
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("缺歌词 + searchLyrics 拿到 → 写歌词并把 DB has_lyrics 置 1", async () => {
    const p = join(root, "d.flac");
    insertSong("s6", p, { hasLyrics: 0 });
    parseFileMock.mockResolvedValueOnce(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValueOnce("[00:01.00]测试歌词");

    const r = await repairSongTags("s6", cfg());
    expect(r.outcome).toBe("fixed");
    expect(r.lyric).toBe(true);
    const tags = writeTagsMock.mock.calls[0][1];
    expect(tags.lyric).toBe("[00:01.00]测试歌词");
    const row = sqlite.prepare("SELECT has_lyrics FROM songs WHERE id='s6'").get() as { has_lyrics: number };
    expect(row.has_lyrics).toBe(1);
  });

  it("缺专辑 + DB 行有声明值 → 不发网络请求直接写 album", async () => {
    const p = join(root, "e.flac");
    insertSong("s7", p, { album: " DB 里的专辑名 " });
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));

    const r = await repairSongTags("s7", cfg());
    expect(r.outcome).toBe("fixed");
    expect(r.album).toBe(true);
    expect(searchCoverMock).not.toHaveBeenCalled();
    expect(searchLyricsMock).not.toHaveBeenCalled();
    const tags = writeTagsMock.mock.calls[0][1];
    expect(tags.album).toBe("DB 里的专辑名");
  });

  // ---- 修正3（2026-10-17）：scanner 占位专辑值不写进文件 ----
  it("修正3：DB 专辑为占位值(Unknown Album) 而文件专辑为空 → 绝不写占位；网络也拿不到时 unobtainable", async () => {
    const p = join(root, "ph1.flac");
    insertSong("s-ph1", p, { album: "Unknown Album" });
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));
    searchMetadataMock.mockResolvedValueOnce(null);

    const r = await repairSongTags("s-ph1", cfg());
    // 占位值视同空 → needAlbum=false（不兜底写入）；needMeta=true 故走网络，但拿不到 → 无写入。
    expect(r.outcome).toBe("unobtainable");
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("修正3：占位专辑不作为兜底，但网络拿到真专辑名时照常写入（不臆造、也不丢失）", async () => {
    const p = join(root, "ph2.flac");
    insertSong("s-ph2", p, { album: "未知专辑" });
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));
    searchMetadataMock.mockResolvedValueOnce({ title: "x", artist: "y", album: "真专辑" });

    const r = await repairSongTags("s-ph2", cfg());
    expect(r.outcome).toBe("fixed");
    expect(r.album).toBe(true);
    const tags = writeTagsMock.mock.calls[0][1];
    expect(tags.album).toBe("真专辑");
  });

  // ---- 修正2（2026-10-17）：文件已内嵌封面而 albums.cover_art 为空 → 落盘并回写 ----
  it("修正2：文件已内嵌封面、专辑行无封面 → 落盘 data/covers/<albumId>.jpg 并回写 albums.cover_art", async () => {
    const p = join(root, "alb.flac");
    // 先建专辑行（songs.album_id 有外键约束），再建歌曲行。
    db.insert(albums).values({ id: "alb1", name: "专辑", coverArt: null, updatedAt: "" }).run();
    insertSong("s-alb", p, { albumId: "alb1", album: "专辑" });
    // 封面/歌词/元数据全齐 → 走「其实齐了」分支，只做对账与专辑封面回写；不重写文件。
    parseFileMock.mockResolvedValue({
      common: {
        picture: [{ format: "image/jpeg", data: Buffer.from("fake-jpeg-bytes") }],
        lyrics: ["[00:01]x"],
        album: "专辑",
        title: "测试歌",
        artist: "测试歌手",
        albumartist: "测试专辑艺术家",
        track: { no: 3, of: 12 },
        year: 2024,
        genre: ["Pop"],
      },
    });

    const r = await repairSongTags("s-alb", cfg());
    expect(r.outcome).toBe("skip");
    expect(writeTagsMock).not.toHaveBeenCalled();
    const alb = sqlite.prepare("SELECT cover_art FROM albums WHERE id='alb1'").get() as { cover_art: string };
    expect(alb.cover_art).toBe("alb1.jpg");
    expect(existsSync(join(getDataDir(), "covers", "alb1.jpg"))).toBe(true);
  });

  it("修正1：真写入后登记完成标记（src=命中的 provider id），下轮扫描可直接跳过", async () => {
    const p = join(root, "mark-after.flac");
    insertSong("s-ma", p, { hasLyrics: 0 });
    parseFileMock.mockResolvedValueOnce(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValueOnce("[00:01.00]测试歌词");

    const r = await repairSongTags("s-ma", cfg());
    expect(r.outcome).toBe("fixed");
    // 真写入 → 标记登记（此前只在下载期标记，修复后无标记导致 tag_repair_done 恒 0 行）
    expect(isTagRepairMarked(p)).toBe(true);
    // 同一进程再跑一次（文件未变）→ 命中标记直接 skip、不探针
    parseFileMock.mockClear();
    const r2 = await repairSongTags("s-ma", cfg());
    expect(r2.outcome).toBe("skip");
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it("修正1：unobtainable（真缺但拿不到）**不**打标记，保留重试机会", async () => {
    const p = join(root, "mark-none.flac");
    insertSong("s-mn", p, { hasLyrics: 0 });
    parseFileMock.mockResolvedValueOnce(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValueOnce(null);

    const r = await repairSongTags("s-mn", cfg());
    expect(r.outcome).toBe("unobtainable");
    expect(isTagRepairMarked(p)).toBe(false);
  });

  it("来源平台透传：searchMetadata 命中 QQ → 完成标记 platform=qq（供来源分布聚合）", async () => {
    const p = join(root, "plat-qq.flac");
    insertSong("s-pq", p);
    parseFileMock.mockResolvedValueOnce(probe({ meta: false }));
    // 模拟真实 providers.searchMetadata：拿到 meta 前先回调 onMatch（providerId=tag-provider）。
    searchMetadataMock.mockImplementationOnce(async (_song: unknown, opts?: { onMatch?: (id: string, b: boolean) => void }) => {
      opts?.onMatch?.("tag-provider", true);
      return { albumArtist: "测试专辑艺术家", track: 3, year: 2024, genre: "Pop", platform: "qq" };
    });

    const r = await repairSongTags("s-pq", cfg());
    expect(r.outcome).toBe("fixed");
    const row = sqlite
      .prepare("SELECT src, platform FROM tag_repair_done WHERE fs_path = ?")
      .get(p) as { src: string; platform: string | null };
    expect(row.src).toBe("tag-provider");
    expect(row.platform).toBe("qq");
  });

  it("来源平台透传：QQ 落空、网易云兜底命中 → 完成标记 platform=netease", async () => {
    const p = join(root, "plat-ns.flac");
    insertSong("s-pns", p);
    parseFileMock.mockResolvedValueOnce(probe({ meta: false }));
    searchMetadataMock.mockImplementationOnce(async (_song: unknown, opts?: { onMatch?: (id: string, b: boolean) => void }) => {
      opts?.onMatch?.("tag-provider", true);
      return { albumArtist: "测试专辑艺术家", platform: "netease" };
    });

    const r = await repairSongTags("s-pns", cfg());
    expect(r.outcome).toBe("fixed");
    const row = sqlite
      .prepare("SELECT platform FROM tag_repair_done WHERE fs_path = ?")
      .get(p) as { platform: string | null };
    expect(row.platform).toBe("netease");
  });

  it("来源平台透传：仅封面修复（无元数据链路）→ platform 为 NULL，归入「历史/未记录来源」", async () => {
    const p = join(root, "plat-null.flac");
    insertSong("s-pn", p);
    parseFileMock.mockResolvedValueOnce(probe({ cover: false }));
    searchCoverMock.mockResolvedValueOnce("http://x/c.jpg");
    cacheRemoteCoverMock.mockResolvedValueOnce("tagfix.jpg");
    resolveCoverFileMock.mockReturnValueOnce(join(tmpDir, "cover.jpg"));

    const r = await repairSongTags("s-pn", cfg());
    expect(r.outcome).toBe("fixed");
    const row = sqlite
      .prepare("SELECT platform FROM tag_repair_done WHERE fs_path = ?")
      .get(p) as { platform: string | null };
    expect(row.platform).toBeNull();
  });

  it("来源平台分布聚合：platform 分 qq/netease/空（历史未记录）三桶", () => {
    const f1 = join(root, "c1.flac");
    const f2 = join(root, "c2.flac");
    const f3 = join(root, "c3.flac");
    for (const f of [f1, f2, f3]) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, "x");
    }
    markTagRepairDone(f1, "tag-provider", "qq");
    markTagRepairDone(f2, "tag-provider", "netease");
    markTagRepairDone(f3, "tag-repair"); // 无平台 → NULL
    const map = Object.fromEntries(getTagRepairPlatformCounts().map((c) => [c.platform, c.count]));
    expect(map["qq"]).toBe(1);
    expect(map["netease"]).toBe(1);
    expect(map[""]).toBe(1);
  });

  it("TAG_FAILED → 指数退避重试，第 2 次成功即修复（吸收 NAS 存储层瞬时抖动）", async () => {
    const p = join(root, "retry.flac");
    insertSong("s-retry", p);
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));
    writeTagsMock.mockRejectedValueOnce(new MockFetchTagError("TAG_FAILED", "transient", p));

    const r = await repairSongTags("s-retry", cfg());
    expect(r.outcome).toBe("fixed");
    expect(writeTagsMock).toHaveBeenCalledTimes(2);
  });

  it("加固：TAG_FAILED 连续失败 → 指数退避重试用尽（共 3 次重试=4 次写入）后上抛", async () => {
    const p = join(root, "retry-exhaust.flac");
    insertSong("s-rex", p);
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));
    // 模拟存储层持续 EACCES（如 /MUSIC/LOSSLESS 实测的 Permission denied）。
    writeTagsMock.mockRejectedValue(new MockFetchTagError("TAG_FAILED", "EACCES", p));

    await expect(repairSongTags("s-rex", cfg())).rejects.toThrow();
    // 首次 + 退避 3 次（3s→6s→12s，测试用 MF_TAG_RETRY_DELAYS_MS=0 置零） = 4 次
    expect(writeTagsMock).toHaveBeenCalledTimes(4);
  });

  it("TIMEOUT 不重试直接上抛（由调用方记异常计数）", async () => {
    const p = join(root, "timeout.flac");
    insertSong("s-timeout", p);
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));
    writeTagsMock.mockRejectedValueOnce(new MockFetchTagError("TIMEOUT", "slow", p));

    await expect(repairSongTags("s-timeout", cfg())).rejects.toThrow();
    expect(writeTagsMock).toHaveBeenCalledTimes(1);
  });

  it("命中下载期完成标记（文件未变）→ 不探针、不联网直接 skip", async () => {
    const p = join(root, "marked.flac");
    insertSong("s-mark", p, { hasLyrics: 0 });
    // 模拟「下载期内置标签来源插件已打好标签并登记标记」。
    expect(markTagRepairDone(p, "tag-provider")).toBe(true);
    // 不额外排 once 假值：用 beforeEach 的默认桩验证「根本没被调用」，避免 once 队列跨用例泄漏。
    const r = await repairSongTags("s-mark", cfg());
    expect(r.outcome).toBe("skip");
    expect(parseFileMock).not.toHaveBeenCalled();
    expect(searchCoverMock).not.toHaveBeenCalled();
    expect(searchLyricsMock).not.toHaveBeenCalled();
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("标记失效：size/mtime 变了 → 自动清标记并正常走修复", async () => {
    const p = join(root, "stale.flac");
    insertSong("s-stale", p);
    markTagRepairDone(p, "tag-provider");
    // 把标记的 size 改掉模拟文件被改写；命中检查应清掉该行、返回未命中。
    sqlite.prepare("UPDATE tag_repair_done SET size = size + 999 WHERE fs_path = ?").run(p);
    expect(isTagRepairMarked(p)).toBe(false);
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM tag_repair_done WHERE fs_path = ?").get(p) as { n: number }).n,
    ).toBe(0);

    parseFileMock.mockResolvedValueOnce(probe({ cover: false }));
    searchCoverMock.mockResolvedValueOnce("http://x/c.jpg");
    cacheRemoteCoverMock.mockResolvedValueOnce("tagfix.jpg");
    resolveCoverFileMock.mockReturnValueOnce(join(tmpDir, "cover.jpg"));
    const r = await repairSongTags("s-stale", cfg());
    expect(r.outcome).toBe("fixed");
  });
});

// ---- 9. 队列 -------------------------------------------------------------------

describe("tagRepair queue", () => {
  it("入队带 10min 初始延迟；到期前 process 不动它", async () => {
    insertSong("s8", join(root, "f.flac"));
    parseFileMock.mockResolvedValue(probe({ cover: false, lyric: false }));
    enqueueTagRepairs(["s8"]);
    // nowMs < nextAt：无到期项
    const r = await processTagRepairQueue(cfg(), Date.now());
    expect(r.checked).toBe(0);
    // 推进 11 分钟：到期处理，provider 拿不到 → 退避（count=1, +1h）
    const r2 = await processTagRepairQueue(cfg(), Date.now() + 11 * 60_000);
    expect(r2.checked).toBe(1);
    expect(r2.unobtainable).toBe(1);
    const q = queueState();
    expect(q["s8"].count).toBe(1);
    expect(q["s8"].nextAt).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("修复成功出队", async () => {
    insertSong("s9", join(root, "g.flac"));
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    searchCoverMock.mockResolvedValue("http://x/c.jpg");
    cacheRemoteCoverMock.mockResolvedValue("ref.jpg");
    resolveCoverFileMock.mockReturnValue(join(tmpDir, "cover.jpg"));
    enqueueTagRepairs(["s9"]);
    await processTagRepairQueue(cfg(), Date.now() + 11 * 60_000);
    expect(queueState()["s9"]).toBeUndefined();
  });

  it("连续 3 次拿不到 → 弃权移出队列", async () => {
    insertSong("s11", join(root, "i.flac"));
    parseFileMock.mockResolvedValue(probe({ cover: false, lyric: false, album: false }));
    // provider 全空 + DB album 也空 → 永远 unobtainable
    db.update(songs).set({ album: "" }).where(eqId("s11")).run();
    searchCoverMock.mockResolvedValue(null);
    searchLyricsMock.mockResolvedValue(null);
    enqueueTagRepairs(["s11"]);
    await processTagRepairQueue(cfg(), Date.now() + 11 * 60_000); // 败1 → +1h
    await processTagRepairQueue(cfg(), Date.now() + 2 * 3_600_000); // 败2 → +6h
    await processTagRepairQueue(cfg(), Date.now() + 8 * 3_600_000); // 败3 → 弃权
    expect(queueState()["s11"]).toBeUndefined();
  });

  it("runTagRepairOnce 单飞：并发第二次调用返回 busy", async () => {
    insertSong("s12", join(root, "j.flac"));
    // 让全量扫描卡住：parseFile 挂起直到放行（所有调用共享同一个 pending promise，
    // 否则第二次调用会重挂 release 导致第一处永不 resolve）。
    let release!: () => void;
    let shared!: Promise<ReturnType<typeof probe>>;
    parseFileMock.mockImplementation(() => {
      if (!shared) {
        shared = new Promise((res) => (release = () => res(probe({ cover: false }))));
      }
      return shared;
    });
    const first = runTagRepairOnce("all", cfg());
    await vi.waitFor(() => expect(parseFileMock).toHaveBeenCalled());
    const second = await runTagRepairOnce("all", cfg());
    expect(second.busy).toBe(true);
    release();
    const done = await first;
    expect(done.busy).toBe(false);
    // 放行后 provider 拿不到封面 → unobtainable（此处只验单飞机制本身）
    expect(done.result?.unobtainable).toBe(1);
  });
});

// ---- 11. 实时统计(已修复/待修复/全部) + 运行中进度 --------------------------------

describe("tagRepair stats/progress", () => {
  it("getTagRepairStats：total=两根内本地歌数，pending=DB 缺标签候选数，repaired=完成标记数", async () => {
    insertSong("t1", join(root, "a.flac"), { hasLyrics: 0 });
    insertSong("t2", join(root, "b.flac"), { hasLyrics: 1, album: "专辑" });
    // t2 补上内嵌封面声明，使其不再计入待修候选（封面判定走 songs.cover_art / albums.cover_art）。
    db.update(songs).set({ coverArt: "x.jpg" }).where(eqId("t2")).run();
    cfg(); // 先把 downloadRoot 覆盖成测试根，统计才落在两根内。
    const s1 = getTagRepairStats();
    expect(s1.total).toBe(2);
    expect(s1.pending).toBe(1);
    expect(s1.repaired).toBe(0);

    // 跑一轮常规修复：t1 缺歌词、provider 给词 → 修复 1 首，真写入即打完成标记 → repaired +1。
    parseFileMock.mockResolvedValue(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValue("[00:01]词");
    const { busy } = await runTagRepairOnce("media", cfg());
    expect(busy).toBe(false);
    expect(getTagRepairRepairedTotal()).toBe(1);
    expect(getTagRepairStats().repaired).toBe(1); // 运行结束已清缓存，重算拿到新值
  });

  it("progress：运行中非空（phase=repair），结束后归 null", async () => {
    insertSong("p1", join(root, "c.flac"), { hasLyrics: 0 });
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    searchCoverMock.mockImplementation(async () => {
      await gate;
      return null;
    });
    const p = runTagRepairOnce("media", cfg());
    await vi.waitFor(() => expect(getTagRepairProgress()).not.toBeNull());
    const live = getTagRepairProgress()!;
    expect(live.mode).toBe("media");
    expect(live.phase).toBe("repair");
    expect(live.total).toBe(1);
    release();
    await p;
    expect(getTagRepairProgress()).toBeNull();
  });

  it("修正5：progress 三档完整拆分 —— 已处理 == 已修复 + 跳过 + 未获取到", async () => {
    // 三首分别对应三条结果路径（按插入顺序被常规扫遍历）：
    //   u1 缺封面且 provider 拿不到 → unobtainable
    //   u2 文件其实齐 → skip
    //   u3 缺歌词且拿到 → fixed（在取词处卡住，以便观察运行中的进度快照）
    const f1 = join(root, "u1.flac");
    const f2 = join(root, "u2.flac");
    const f3 = join(root, "u3.flac");
    insertSong("u1", f1, { hasLyrics: 0 });
    insertSong("u2", f2, { hasLyrics: 0 });
    insertSong("u3", f3, { hasLyrics: 0 });
    parseFileMock.mockImplementation(async (p: string) => {
      if (String(p).includes("u1.flac")) return probe({ cover: false, lyric: true });
      if (String(p).includes("u2.flac")) return probe();
      return probe({ cover: true, lyric: false });
    });
    searchCoverMock.mockResolvedValue(null); // u1 拿不到封面 → unobtainable
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    searchLyricsMock.mockImplementation(async () => {
      await gate;
      return "[00:01]词";
    });

    const p = runTagRepairOnce("media", cfg());
    await vi.waitFor(() => expect(getTagRepairProgress()).not.toBeNull());
    // 等前两首处理完、第三首在途：三档必须已完整归属，且之和 == 已处理。
    // （旧实现只传 fixed/skipped 两个增量，unobtainable 无归属 → 此处 checked(2) ≠ fixed+skipped(1)。）
    await vi.waitFor(() => expect(getTagRepairProgress()!.checked).toBe(2));
    const live = getTagRepairProgress()!;
    expect(live.phase).toBe("repair");
    expect(live.unobtainable).toBe(1);
    expect(live.skipped).toBe(1);
    expect(live.fixed).toBe(0);
    expect(live.checked).toBe(live.fixed + live.skipped + live.unobtainable);
    release();
    const { busy, result } = await p;
    expect(busy).toBe(false);
    // 终态：分项之和 == 已处理，且三条路径各 1 首。
    expect(result?.checked).toBe(
      (result?.fixed ?? 0) + (result?.skipped ?? 0) + (result?.unobtainable ?? 0),
    );
    expect(result?.unobtainable).toBe(1);
    expect(result?.fixed).toBe(1);
    expect(result?.skipped).toBe(1);
  });

  it("「已修复」口径 = 完成标记数（真写入与探针确认齐备都打标记）", async () => {
    // DB 声明缺歌词，但文件实际有歌词 → 走 skip（只对齐 DB），不计 fixed。
    insertSong("pj1", join(root, "k.flac"), { hasLyrics: 0 });
    parseFileMock.mockResolvedValue(probe());
    const { busy, result } = await runTagRepairOnce("media", cfg());
    expect(busy).toBe(false);
    expect(result?.fixed).toBe(0);
    expect(result?.skipped).toBeGreaterThanOrEqual(1);
    // 【2026-10-17 修正 4】「已修复」改为直读完成标记数：探针确认齐备的歌也会登记标记，
    // 故 skipped 的歌同样计入，口径与旧的 fixed+skipped 一致，但**不再依赖整轮跑完**。
    expect(getTagRepairRepairedTotal()).toBe((result?.fixed ?? 0) + (result?.skipped ?? 0));
    expect(getTagRepairStats().repaired).toBe((result?.fixed ?? 0) + (result?.skipped ?? 0));
  });

  it("修正4：repaired 直读标记表 —— 未跑任何一轮修复也实时反映已标记歌数（不复现「一直停旧值」）", async () => {
    insertSong("m1", join(root, "m1.flac"), { hasLyrics: 0 });
    insertSong("m2", join(root, "m2.flac"), { hasLyrics: 0 });
    // 模拟「修复进程中途被杀 / 容器重启」的历史遗留：两首已真实修复并落标记，但没有任何一轮跑完。
    expect(markTagRepairDone(join(root, "m1.flac"), "tag-provider")).toBe(true);
    expect(markTagRepairDone(join(root, "m2.flac"), "tag-repair")).toBe(true);
    // 不调用 runTagRepairOnce：统计仍应立刻给出 2（旧实现此时恒为 0/旧值）。
    expect(getTagRepairRepairedTotal()).toBe(2);
    expect(getTagRepairStats().repaired).toBe(2);
  });
});

// ---- 12. 扫描范围(download / lossless / both) ------------------------------------

describe("tagRepair scope", () => {
  it("download 只扫下载根；lossless 只扫无损根；缺省用已保存 scope(both)", async () => {
    const dl = join(tmpDir, "dl-root");
    const ll = join(tmpDir, "ll-root");
    insertSong("sc-dl", join(dl, "a.flac"), { hasLyrics: 0 });
    insertSong("sc-ll", join(ll, "b.flac"), { hasLyrics: 0 });
    saveFetchConfigOverride({ downloadRoot: dl, losslessRoot: ll } as Partial<FetchConfig>);
    const c = currentFetchConfig();
    parseFileMock.mockResolvedValue(probe({ lyric: false, cover: false }));
    searchLyricsMock.mockResolvedValue("[00:01]词");

    const rBoth = await runTagRepairOnce("media", c); // 缺省 → cfg.tagRepairScope=both
    expect(rBoth.result?.checked).toBe(2);

    // 修正1（2026-10-17）：第一轮真写入修复后会打「标签修复完成标记」，同一测试内后续轮次
    // 命中标记即跳过（不探针/不联网）→ 计入 skipped 而非 checked。故范围断言改用
    // checked + skipped（= 本轮纳入扫描的歌数），仍能证明 scope 过滤生效：
    // download 只纳入下载根那 1 首、lossless 只纳入无损根那 1 首。
    const rDl = await runTagRepairOnce("media", c, "download");
    expect((rDl.result?.checked ?? 0) + (rDl.result?.skipped ?? 0)).toBe(1);

    const rLl = await runTagRepairOnce("media", c, "lossless");
    expect((rLl.result?.checked ?? 0) + (rLl.result?.skipped ?? 0)).toBe(1);
  });
});

// ---- helper --------------------------------------------------------------------

import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(songs.id, id);
}
