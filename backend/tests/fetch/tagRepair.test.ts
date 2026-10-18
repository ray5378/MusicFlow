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
//  11. 修正6（选项 C）：unobtainable → 登记 outcome='unobtainable' 标记（带 30 天 TTL），池子一轮收敛；
//      终态不可得行不计入「已修复」、不参与来源分布聚合。
//  12. 修正7：pending 口径剔除已落完成标记的歌（有标记 = 不再重扫 = 不计入「待修复」）。
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
import { _resetSettingsCacheForTest, getSetting, setSetting } from "../../src/services/settings.js";
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
  getTagRepairLastResult,
  getTagRepairLastResults,
  getTagRepairQueueSize,
  isTagRepairRunning,
  startTagRepairScheduler,
  ACTIVE_RUN_KEY,
  TAG_REPAIR_RESUME_DELAY_MS,
  getTagRepairActiveRun,
  hasResumableActiveRun,
  isTagRepairStopping,
  stopTagRepair,
  resumeInterruptedTagRepair,
} from "../../src/services/fetch/tagRepair.js";
import type { TagRepairRunSnapshot } from "../../src/services/fetch/tagRepair.js";
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
  // stopTagRepair/resumeInterruptedTagRepair 会调 cleanupTagTmp 拼临时文件路径；
  // 这里给出等价实现（测试不必真造 tagtmp 文件），让停止/续跑路径不因缺导出报错。
  tmpPathFor: (target: string, marker: string) => `${target}.${marker}`,
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

  it("修正6（选项C）：unobtainable（真缺但拿不到）→ 登记 outcome='unobtainable' 标记，池子一轮收敛", async () => {
    const p = join(root, "mark-none.flac");
    insertSong("s-mn", p, { hasLyrics: 0 });
    parseFileMock.mockResolvedValueOnce(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValueOnce(null);

    const r = await repairSongTags("s-mn", cfg());
    expect(r.outcome).toBe("unobtainable");
    const row = sqlite
      .prepare("SELECT outcome, src FROM tag_repair_done WHERE fs_path = ?")
      .get(p) as { outcome: string; src: string };
    expect(row.outcome).toBe("unobtainable");
    // 已登记 → 命中标记：下轮扫描直接跳过（不再无限重探/重扫，池子收敛）
    expect(isTagRepairMarked(p)).toBe(true);
    expect(getTagRepairStats().unobtainableTotal).toBe(1);
    // 该行不计入「已修复」
    expect(getTagRepairRepairedTotal()).toBe(0);
    parseFileMock.mockClear();
    const r2 = await repairSongTags("s-mn", cfg());
    expect(r2.outcome).toBe("skip");
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it("修正6：unobtainable 标记带 30 天 TTL —— 超期后允许重探（自愈窗口；防断网把整库永久标记）", async () => {
    const p = join(root, "ttl.flac");
    insertSong("s-ttl", p, { hasLyrics: 0 });
    parseFileMock.mockResolvedValueOnce(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValueOnce(null);
    await repairSongTags("s-ttl", cfg());
    expect(isTagRepairMarked(p)).toBe(true);
    // 把标记时间回拨 31 天 → 超期，命中检查返回 false，允许重新进入候选
    sqlite
      .prepare("UPDATE tag_repair_done SET at = ? WHERE fs_path = ?")
      .run(new Date(Date.now() - 31 * 24 * 3_600_000).toISOString(), p);
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
    // 修正6：终态不可得（outcome='unobtainable'）不参与来源分布聚合，qq 桶仍为 1。
    const f4 = join(root, "c4.flac");
    writeFileSync(f4, "x");
    markTagRepairDone(f4, "tag-provider", "qq", "unobtainable");
    const map2 = Object.fromEntries(getTagRepairPlatformCounts().map((c) => [c.platform, c.count]));
    expect(map2["qq"]).toBe(1);
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

  it("修正7：pending 口径剔除已落完成标记的歌（不再重扫 → 不再计入待修复）", () => {
    const p = join(root, "pend-mk.flac");
    insertSong("s-pmk", p, { hasLyrics: 0, albumId: null });
    cfg();
    // 直接登记一行完成标记：stats 口径为纯 DB 判定，不要求文件真实存在、不 stat。
    sqlite
      .prepare(
        "INSERT INTO tag_repair_done (fs_path, size, mtime_ms, src, platform, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(p, 1, 1, "tag-repair", "qq", "unobtainable", new Date().toISOString());
    // beforeEach 已清 statsCache → 首次计算即为最新值（无缓存干扰）。
    const s = getTagRepairStats();
    expect(s.total).toBe(1);
    expect(s.pending).toBe(0); // 该歌 DB 缺歌词/封面，但已落标记 → 不计入待修
    expect(s.unobtainableTotal).toBe(1);
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

// ---- 13. 状态存取 / 容错分支 -----------------------------------------------------

describe("tagRepair 状态存取与容错", () => {
  it("getTagRepairQueueSize：队列为空串/坏 JSON 均安全回落 0", () => {
    setSetting("fetch.tagrepair.queue", "");
    expect(getTagRepairQueueSize()).toBe(0);
    setSetting("fetch.tagrepair.queue", "{不是合法 JSON");
    expect(getTagRepairQueueSize()).toBe(0);
  });

  it("getTagRepairLastResult/LastResults：未存/坏 JSON 返回空；跑一轮 queue 后可读回", async () => {
    // 未存 → null
    expect(getTagRepairLastResult()).toBeNull();
    // 坏 JSON → catch 回落 null
    setSetting("fetch.tagrepair.lastResult", "{坏");
    expect(getTagRepairLastResult()).toBeNull();
    // 分挡位结果坏 JSON → {}
    setSetting("fetch.tagrepair.lastResults", "{坏");
    expect(getTagRepairLastResults()).toEqual({});

    // 空队列跑一轮 queue → 写入 lastResult/lastResults（覆盖 queue 挡位分支）
    const { busy, result } = await runTagRepairOnce("queue", cfg());
    expect(busy).toBe(false);
    expect(result?.checked).toBe(0);
    const last = getTagRepairLastResult();
    expect(last?.mode).toBe("queue");
    expect(getTagRepairLastResults().queue?.mode).toBe("queue");
  });

  it("enqueueTagRepairs：非数组/空数组返回 0；空 id 跳过、重复 id 不重复入队", () => {
    expect(enqueueTagRepairs([])).toBe(0);
    expect(enqueueTagRepairs(undefined as unknown as string[])).toBe(0);
    // 空串 id 被跳过，合法 id 入队
    expect(enqueueTagRepairs(["", "s-a"])).toBe(1);
    expect(getTagRepairQueueSize()).toBe(1);
    // 已存在 → 不再入队
    expect(enqueueTagRepairs(["s-a"])).toBe(0);
    expect(enqueueTagRepairs(["s-b", "s-c", "s-a"])).toBe(2);
    expect(getTagRepairQueueSize()).toBe(3);
  });

  it("dbStats 5s 短缓存：连续两次 getTagRepairStats 复用同一次整表扫描", () => {
    insertSong("cache1", join(root, "cache.flac"), { hasLyrics: 0 });
    cfg();
    const s1 = getTagRepairStats();
    const s2 = getTagRepairStats(); // 5s 内 → 命中缓存分支
    expect(s2).toEqual(s1);
  });
});

// ---- 14. repairSongTags 探缺异常/补写缺口 ----------------------------------------

describe("repairSongTags 异常与补写缺口", () => {
  it("songId 不存在 → skip（loadRow 为 null，不探针）", async () => {
    const r = await repairSongTags("no-such-id", cfg());
    expect(r.outcome).toBe("skip");
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it("封面探测抛错 → 只告警，退回 unobtainable（不写文件）", async () => {
    const p = join(root, "cov-err.flac");
    insertSong("s-cerr", p);
    parseFileMock.mockResolvedValueOnce(probe({ cover: false }));
    searchCoverMock.mockRejectedValueOnce(new Error("net down"));
    const r = await repairSongTags("s-cerr", cfg());
    expect(r.outcome).toBe("unobtainable");
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("歌词探测抛错 → 只告警，退回 unobtainable", async () => {
    const p = join(root, "lyr-err.flac");
    insertSong("s-lerr", p);
    parseFileMock.mockResolvedValueOnce(probe({ lyric: false }));
    searchLyricsMock.mockRejectedValueOnce(new Error("net down"));
    const r = await repairSongTags("s-lerr", cfg());
    expect(r.outcome).toBe("unobtainable");
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("元数据补全抛错 → 只告警，退回 unobtainable", async () => {
    const p = join(root, "meta-err.flac");
    insertSong("s-merr", p);
    parseFileMock.mockResolvedValueOnce(probe({ meta: false }));
    searchMetadataMock.mockRejectedValueOnce(new Error("net down"));
    const r = await repairSongTags("s-merr", cfg());
    expect(r.outcome).toBe("unobtainable");
    expect(writeTagsMock).not.toHaveBeenCalled();
  });

  it("内嵌缺 title/artist 时用元数据补写（不覆盖已有值）", async () => {
    const p = join(root, "ta.flac");
    insertSong("s-ta", p);
    parseFileMock.mockResolvedValueOnce({
      common: {
        picture: [{}],
        lyrics: ["[00:01]x"],
        album: "专辑",
        title: "",
        artist: "",
        albumartist: "",
        track: { no: 0, of: 0 },
        year: null,
        genre: [],
      },
    });
    searchMetadataMock.mockResolvedValueOnce({
      title: "标题T",
      artist: "歌手A",
      albumArtist: "AA",
      track: 3,
      year: 2024,
      genre: "Pop",
    });
    const r = await repairSongTags("s-ta", cfg());
    expect(r.outcome).toBe("fixed");
    const tags = writeTagsMock.mock.calls[0][1];
    expect(tags.title).toBe("标题T");
    expect(tags.artist).toBe("歌手A");
  });

  it("默认退避档（未设 MF_TAG_RETRY_DELAYS_MS）：TAG_FAILED 后按默认 3s 重试并成功", async () => {
    const saved = process.env.MF_TAG_RETRY_DELAYS_MS;
    delete process.env.MF_TAG_RETRY_DELAYS_MS;
    try {
      const p = join(root, "retry-default.flac");
      insertSong("s-rd", p);
      parseFileMock.mockResolvedValueOnce(probe({ album: false }));
      writeTagsMock.mockRejectedValueOnce(new MockFetchTagError("TAG_FAILED", "transient", p));
      const r = await repairSongTags("s-rd", cfg());
      expect(r.outcome).toBe("fixed");
      expect(writeTagsMock).toHaveBeenCalledTimes(2);
    } finally {
      process.env.MF_TAG_RETRY_DELAYS_MS = saved;
    }
  }, 20_000);
});

// ---- 15. 专辑封面回写（内嵌封面 → albums.cover_art）各早退分支 ---------------------

describe("syncAlbumCoverFromEmbedded 各早退分支", () => {
  it("专辑行已有封面 → 不动（不读文件内嵌封面）", async () => {
    db.insert(albums).values({ id: "alb-has", name: "A", coverArt: "x.jpg", updatedAt: "" }).run();
    insertSong("s-albhas", join(root, "alb-has.flac"), { albumId: "alb-has", album: "A" });
    parseFileMock.mockResolvedValue(probe());
    const r = await repairSongTags("s-albhas", cfg());
    expect(r.outcome).toBe("skip");
    expect(
      (sqlite.prepare("SELECT cover_art FROM albums WHERE id='alb-has'").get() as { cover_art: string })
        .cover_art,
    ).toBe("x.jpg");
  });

  it("songs.album_id 指向不存在的专辑行 → 不臆造（提前返回）", async () => {
    // songs.album_id 有外键约束，无法直接插入悬空引用；临时关闭外键写入后再恢复。
    insertSong("s-ghost", join(root, "alb-ghost.flac"), { album: "A" });
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.prepare("UPDATE songs SET album_id = ? WHERE id = ?").run("ghost-alb", "s-ghost");
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
    parseFileMock.mockResolvedValue(probe());
    const r = await repairSongTags("s-ghost", cfg());
    expect(r.outcome).toBe("skip");
  });

  it("专辑行无封面且文件内嵌封面为空 → 不回写（返回 null 不臆造）", async () => {
    db.insert(albums).values({ id: "alb-none", name: "A", coverArt: null, updatedAt: "" }).run();
    insertSong("s-albnone", join(root, "alb-none.flac"), { albumId: "alb-none", album: "A" });
    // 探针（第 1 次 parseFile）全齐 → 走 skip 路径；readEmbeddedCover（第 2 次）返回无封面
    parseFileMock.mockResolvedValueOnce(probe());
    parseFileMock.mockResolvedValueOnce({ common: { picture: [] } });
    const r = await repairSongTags("s-albnone", cfg());
    expect(r.outcome).toBe("skip");
    expect(
      (sqlite.prepare("SELECT cover_art FROM albums WHERE id='alb-none'").get() as {
        cover_art: string | null;
      }).cover_art,
    ).toBeNull();
  });

  it("readEmbeddedCover 解析抛错 → 静默返回，不回写专辑封面", async () => {
    db.insert(albums).values({ id: "alb-err", name: "A", coverArt: null, updatedAt: "" }).run();
    insertSong("s-alberr", join(root, "alb-err.flac"), { albumId: "alb-err", album: "A" });
    parseFileMock.mockResolvedValueOnce(probe());
    parseFileMock.mockRejectedValueOnce(new Error("bad file"));
    const r = await repairSongTags("s-alberr", cfg());
    expect(r.outcome).toBe("skip");
  });

  it("内嵌封面落盘失败（albumId 含路径分隔）→ 静默跳过，不改专辑列（PNG 分支）", async () => {
    db.insert(albums).values({ id: "bad/dir", name: "A", coverArt: null, updatedAt: "" }).run();
    insertSong("s-badpath", join(root, "alb-badpath.flac"), { albumId: "bad/dir", album: "A" });
    parseFileMock.mockResolvedValue({
      common: {
        picture: [{ format: "image/png", data: Buffer.from("png-bytes") }],
        lyrics: ["[00:01]x"],
        album: "专辑",
        title: "测试歌",
        artist: "测试歌手",
        albumartist: "AA",
        track: { no: 3, of: 12 },
        year: 2024,
        genre: ["Pop"],
      },
    });
    const r = await repairSongTags("s-badpath", cfg());
    expect(r.outcome).toBe("skip");
    expect(
      (sqlite.prepare("SELECT cover_art FROM albums WHERE id='bad/dir'").get() as {
        cover_art: string | null;
      }).cover_art,
    ).toBeNull();
  });

  it("专辑封面回写遇到 DB 异常 → 只告警不抛（外层 catch，GIF 分支）", async () => {
    db.insert(albums).values({ id: "alb-db", name: "A", coverArt: null, updatedAt: "" }).run();
    insertSong("s-albdb", join(root, "alb-db.flac"), { albumId: "alb-db", album: "A" });
    parseFileMock.mockResolvedValue({
      common: {
        picture: [{ format: "image/gif", data: Buffer.from("gif-bytes") }],
        lyrics: ["[00:01]x"],
        album: "专辑",
        title: "测试歌",
        artist: "测试歌手",
        albumartist: "AA",
        track: { no: 3, of: 12 },
        year: 2024,
        genre: ["Pop"],
      },
    });
    const orig = sqlite.prepare.bind(sqlite);
    const spy = vi
      .spyOn(sqlite as unknown as { prepare: (sql: string) => unknown }, "prepare")
      .mockImplementation(((sql: string) => {
        if (String(sql).includes("SELECT cover_art FROM albums")) throw new Error("db boom");
        return orig(sql);
      }) as unknown as typeof sqlite.prepare);
    try {
      const r = await repairSongTags("s-albdb", cfg());
      expect(r.outcome).toBe("skip");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---- 16. 队列/全量扫异常与弃权分支 ------------------------------------------------

describe("tagRepair 队列与全量扫的异常分支", () => {
  it("队列修复中 repairSongTags 抛错 → 记 unobtainable 并按退避重排", async () => {
    const p = join(root, "q-throw.flac");
    insertSong("s-qth", p);
    parseFileMock.mockResolvedValue(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValue("[00:01]词");
    // 非 TAG_FAILED（TIMEOUT）→ 直接上抛 → 被队列 catch 兜住
    writeTagsMock.mockRejectedValueOnce(new MockFetchTagError("TIMEOUT", "slow", p));
    enqueueTagRepairs(["s-qth"]);
    const r = await processTagRepairQueue(cfg(), Date.now() + 11 * 60_000);
    expect(r.checked).toBe(1);
    expect(r.unobtainable).toBe(1);
    expect(queueState()["s-qth"].count).toBe(1);
  });

  it("连续 3 次拿不到（每次文件变更使标记失效）→ 弃权移出队列", async () => {
    const p = join(root, "q-abandon.flac");
    insertSong("s-qab", p, { hasLyrics: 0 });
    db.update(songs).set({ album: "" }).where(eqId("s-qab")).run();
    parseFileMock.mockResolvedValue(probe({ cover: false, lyric: false, album: false, meta: false }));
    searchCoverMock.mockResolvedValue(null);
    searchLyricsMock.mockResolvedValue(null);
    searchMetadataMock.mockResolvedValue(null);
    enqueueTagRepairs(["s-qab"]);
    await processTagRepairQueue(cfg(), Date.now() + 11 * 60_000); // 败1 → +1h
    writeFileSync(p, "changed-1-longer-bytes"); // 文件变更 → 失效标记，下轮重探
    await processTagRepairQueue(cfg(), Date.now() + 2 * 3_600_000); // 败2 → +6h
    writeFileSync(p, "changed-2-even-longer-bytes"); // 再失效
    await processTagRepairQueue(cfg(), Date.now() + 8 * 3_600_000); // 败3 → 弃权
    expect(queueState()["s-qab"]).toBeUndefined();
  });

  it("全量扫：命中完成标记 → 计入 skipped，不探针", async () => {
    const p = join(root, "all-marked.flac");
    insertSong("s-allmk", p, { hasLyrics: 0 });
    cfg();
    markTagRepairDone(p, "tag-provider");
    parseFileMock.mockClear();
    const { result } = await runTagRepairOnce("all", cfg());
    expect(parseFileMock).not.toHaveBeenCalled();
    expect(result?.skipped).toBeGreaterThanOrEqual(1);
  });

  it("全量扫：修复阶段 repairSongTags 抛错 → 记 unobtainable（异常兜底）", async () => {
    const p = join(root, "all-throw.flac");
    insertSong("s-allth", p);
    parseFileMock.mockResolvedValue(probe({ lyric: false }));
    searchLyricsMock.mockResolvedValue("[00:01]词");
    writeTagsMock.mockRejectedValueOnce(new MockFetchTagError("TIMEOUT", "slow", p));
    const { result } = await runTagRepairOnce("all", cfg());
    expect(result?.unobtainable).toBe(1);
  });

  it("全量扫：探针进度每 1000 首打点（probed%1000 分支）", async () => {
    cfg();
    db.transaction((tx) => {
      for (let i = 0; i < 1000; i++) {
        tx.insert(songs)
          .values({
            id: `bulk${i}`,
            title: "t",
            artist: "a",
            album: "专辑",
            albumId: null,
            path: `l:dl-testsrc:${join(root, `bulk${i}.flac`)}`,
            suffix: "flac",
            bitRate: 900,
            size: 1,
            duration: 200,
            type: "local",
            contentType: "audio/flac",
            hasLyrics: 1,
          })
          .run();
      }
    });
    parseFileMock.mockResolvedValue(probe()); // 全齐 → 无候选
    const { result } = await runTagRepairOnce("all", cfg());
    expect(result?.checked).toBe(0);
  }, 30_000);
});

// ---- 17. 运行中标志与调度器 ------------------------------------------------------

describe("tagRepair 运行中标志与调度器", () => {
  it("isTagRepairRunning：运行中 true，结束后 false", async () => {
    insertSong("s-run", join(root, "run.flac"), { hasLyrics: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    parseFileMock.mockImplementation(async () => {
      await gate;
      return probe({ cover: false });
    });
    expect(isTagRepairRunning()).toBe(false);
    const p = runTagRepairOnce("media", cfg());
    await vi.waitFor(() => expect(getTagRepairProgress()).not.toBeNull());
    expect(isTagRepairRunning()).toBe(true);
    release();
    await p;
    expect(isTagRepairRunning()).toBe(false);
  });

  it("startTagRepairScheduler：boot tick 处理队列并推进到点常规扫（lastRunAt 被刷新）", async () => {
    vi.useFakeTimers();
    insertSong("s-sched", join(root, "sched.flac"), { hasLyrics: 0 });
    saveFetchConfigOverride({
      downloadRoot: root,
      losslessRoot: "",
      tagRepairEnabled: true,
      tagRepairIntervalHours: 1,
    } as Partial<FetchConfig>);
    _resetTagRepairForTest(); // lastRunAt 归 0 → tick 会到点跑常规扫
    parseFileMock.mockResolvedValue(probe());
    startTagRepairScheduler();
    await vi.advanceTimersByTimeAsync(15_000); // BOOT_DELAY_MS
    expect(Number(getSetting("fetch.tagrepair.lastRunAt", "0"))).toBeGreaterThan(0);
  });
});

// ---- helper --------------------------------------------------------------------

import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(songs.id, id);
}

// ---- 18. 续跑快照 / 立刻停止 ------------------------------------------------------
//
// 覆盖 tagRepair.ts 的「断点续跑 + 立刻停止」能力：ACTIVE_RUN_KEY 快照持久化、
// getTagRepairActiveRun / hasResumableActiveRun 判定、stopTagRepair 协作式停止、
// resumeInterruptedTagRepair boot 续跑。
// 复用本文件既有 mock：parseFileMock（文件头探针）、searchCover/searchLyrics/searchMetadataMock
// （provider）、settings 真实读写（setSetting/getSetting）与隔离 DATA_DIR 的真实 DB。

describe("续跑快照 / 立刻停止", () => {
  /** 构造一份运行快照（默认 all/repair），用于手工落盘或作为 resume 入参。 */
  function makeSnapshot(over: Partial<TagRepairRunSnapshot> = {}): TagRepairRunSnapshot {
    const now = Date.now();
    return {
      version: 1,
      mode: "all",
      dirScope: "both",
      phase: "repair",
      startedAt: now,
      updatedAt: now,
      checked: 0,
      fixed: 0,
      skipped: 0,
      unobtainable: 0,
      pendingIds: [],
      candidateIds: [],
      currentFsPath: null,
      stopped: false,
      ...over,
    };
  }

  it("全新一轮 media：过程中 ACTIVE_RUN_KEY 写入合法快照，正常结束后被清空", async () => {
    // 验证：media 一轮运行中快照被持久化（version/mode/dirScope/phase 正确）；正常跑完后清空。
    insertSong("snap-media", join(root, "snap-media.flac"), { hasLyrics: 0 });
    parseFileMock.mockResolvedValue(probe({ cover: false })); // 缺封面 → repair 阶段会走 provider
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    searchCoverMock.mockImplementation(async () => {
      await gate;
      return null;
    });
    const p = runTagRepairOnce("media", cfg());
    await vi.waitFor(() => expect(getSetting(ACTIVE_RUN_KEY, "")).not.toBe(""));
    const parsed = JSON.parse(String(getSetting(ACTIVE_RUN_KEY, ""))) as TagRepairRunSnapshot;
    expect(parsed.version).toBe(1);
    expect(parsed.mode).toBe("media");
    expect(parsed.dirScope).toBe("both"); // cfg() 未覆盖 tagRepairScope → 默认 both
    expect(parsed.phase).toBe("repair");
    release();
    expect((await p).busy).toBe(false);
    // 正常跑完 → clearActiveRun：settings 该 key 为空串，读取回落 null
    expect(getSetting(ACTIVE_RUN_KEY, "")).toBe("");
    expect(getTagRepairActiveRun()).toBeNull();
  });

  it("全新一轮 all：过程中快照 phase=repair，正常结束后被清空", async () => {
    // 验证：all 全量扫在 scan 结束进入 repair 前落盘候选，期间快照合法；结束后清空。
    insertSong("snap-all", join(root, "snap-all.flac"), { hasLyrics: 0 });
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    searchCoverMock.mockImplementation(async () => {
      await gate;
      return null;
    });
    const p = runTagRepairOnce("all", cfg());
    await vi.waitFor(() => expect(getSetting(ACTIVE_RUN_KEY, "")).not.toBe(""));
    const parsed = JSON.parse(String(getSetting(ACTIVE_RUN_KEY, ""))) as TagRepairRunSnapshot;
    expect(parsed.version).toBe(1);
    expect(parsed.mode).toBe("all");
    expect(parsed.dirScope).toBe("both");
    expect(parsed.phase).toBe("repair");
    release();
    await p;
    expect(getSetting(ACTIVE_RUN_KEY, "")).toBe("");
    expect(getTagRepairActiveRun()).toBeNull();
  });

  it("getTagRepairActiveRun / hasResumableActiveRun 语义：无→null/false，未停止→快照/true，已停止→false", () => {
    // 验证：空闲时从持久化快照读取；stopped 的快照不可续跑但仍可读。
    expect(getTagRepairActiveRun()).toBeNull();
    expect(hasResumableActiveRun()).toBe(false);

    const live = makeSnapshot({ mode: "media", dirScope: "download", phase: "scan", checked: 2, pendingIds: ["a"] });
    setSetting(ACTIVE_RUN_KEY, JSON.stringify(live));
    expect(hasResumableActiveRun()).toBe(true);
    const got = getTagRepairActiveRun();
    expect(got).not.toBeNull();
    expect(got!.mode).toBe("media");
    expect(got!.pendingIds).toEqual(["a"]);

    setSetting(ACTIVE_RUN_KEY, JSON.stringify(makeSnapshot({ stopped: true })));
    expect(hasResumableActiveRun()).toBe(false); // 主动停止的快照不自动复活
    expect(getTagRepairActiveRun()).not.toBeNull(); // 但快照本身仍可读（尚未被清除）
  });

  it("stopTagRepair 未运行：返回 {requested:false,running:false} 且无副作用", () => {
    // 验证：无进行中一轮时停止是 no-op，不推进 lastRunAt、不置停止标志。
    expect(isTagRepairRunning()).toBe(false);
    expect(stopTagRepair()).toEqual({ requested: false, running: false });
    expect(isTagRepairStopping()).toBe(false);
    expect(getSetting("fetch.tagrepair.lastRunAt", "0")).toBe("0");
  });

  it("stopTagRepair 运行中：置停止标志、快照 stopped=true 落盘、推进 lastRunAt；本轮结束后标志复位", async () => {
    // 验证：运行中停止返回 {requested:true,running:true}；isTagRepairStopping=true；
    //      持久化快照被标 stopped=true；D2 语义顺延 lastRunAt；本轮 finally 复位停止标志。
    insertSong("s-stop", join(root, "stop.flac"), { hasLyrics: 0 });
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    searchCoverMock.mockImplementation(async () => {
      await gate;
      return null;
    });
    const p = runTagRepairOnce("media", cfg());
    await vi.waitFor(() => expect(getSetting(ACTIVE_RUN_KEY, "")).not.toBe(""));

    expect(stopTagRepair()).toEqual({ requested: true, running: true });
    expect(isTagRepairStopping()).toBe(true);
    const persisted = JSON.parse(String(getSetting(ACTIVE_RUN_KEY, ""))) as TagRepairRunSnapshot;
    expect(persisted.stopped).toBe(true);
    expect(Number(getSetting("fetch.tagrepair.lastRunAt", "0"))).toBeGreaterThan(0);

    release();
    const { busy, stopped } = await p;
    expect(busy).toBe(false);
    expect(stopped).toBe(true); // 走 runTagRepairOnce 的停止分支
    expect(isTagRepairStopping()).toBe(false); // finally 复位
  });

  it("协作式停止中断 sweep：provider 回调里触发停止 → 本轮提前结束、返回 stopped:true、不写 lastResult", async () => {
    // 验证：多首候选中途停止 → 只处理到触发点那一首；返回 stopped:true；半轮不写 lastResult。
    insertSong("s-c1", join(root, "c1.flac"), { hasLyrics: 0 });
    insertSong("s-c2", join(root, "c2.flac"), { hasLyrics: 0 });
    insertSong("s-c3", join(root, "c3.flac"), { hasLyrics: 0 });
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    // 首个候选的 provider 回调里触发停止：sweep 循环头随即拦下后续候选。
    searchCoverMock.mockImplementation(async () => {
      stopTagRepair();
      return null;
    });
    const { busy, result, stopped } = await runTagRepairOnce("media", cfg());
    expect(busy).toBe(false);
    expect(stopped).toBe(true);
    expect(result?.checked).toBe(1); // 仅第一首被处理，其余提前终止
    expect(result?.checked).toBeLessThan(3);
    expect(getSetting("fetch.tagrepair.lastResult", "")).toBe(""); // 停止分支不写 lastResult
  });

  it("停止轮不再因正常完成推进 lastRunAt（停止时已推一次，完成后不应再推）", async () => {
    // 验证（按真实实现 D2 语义）：stopTagRepair 本身会推进 lastRunAt；停止分支在 runTagRepairOnce
    // 里提前 return（不写 lastResult / 不再次 setSetting lastRunAt）。故完成时刻 == 停止时刻。
    insertSong("s-adv", join(root, "adv.flac"), { hasLyrics: 0 });
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    let atStop = 0;
    searchCoverMock.mockImplementation(async () => {
      stopTagRepair();
      atStop = Number(getSetting("fetch.tagrepair.lastRunAt", "0"));
      // 拖过数十毫秒：若「正常完成」路径又推一次，时间戳必然不同（毫秒级）。
      await new Promise((r) => setTimeout(r, 30));
      return null;
    });
    const { stopped } = await runTagRepairOnce("media", cfg());
    expect(stopped).toBe(true);
    expect(atStop).toBeGreaterThan(0);
    expect(Number(getSetting("fetch.tagrepair.lastRunAt", "0"))).toBe(atStop);
  });

  it("续跑恢复计数：从快照 checked/fixed 起步（不清零），只处理 pendingIds、不重跑全量精探", async () => {
    // 验证：phase=repair 快照续跑时，progress/result 以快照计数为起点；候选只取 pendingIds。
    insertSong("r1", join(root, "r1.flac"), { hasLyrics: 0 });
    insertSong("r2", join(root, "r2.flac"), { hasLyrics: 0 });
    insertSong("r3", join(root, "r3.flac"), { hasLyrics: 0 });
    cfg();
    const base = makeSnapshot({
      mode: "all",
      dirScope: "both",
      phase: "repair",
      checked: 5,
      fixed: 3,
      skipped: 1,
      unobtainable: 1,
      pendingIds: ["r1"],
      candidateIds: [],
    });
    parseFileMock.mockClear();
    parseFileMock.mockResolvedValue(probe({ lyric: false }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    searchLyricsMock.mockImplementation(async () => {
      await gate;
      return "[00:01]词";
    });
    const p = runTagRepairOnce("all", undefined, "both", base);
    await vi.waitFor(() => expect(getTagRepairProgress()).not.toBeNull());
    const live = getTagRepairProgress()!;
    expect(live.phase).toBe("repair");
    expect(live.checked).toBe(5); // 从快照起步，而非 0
    expect(live.fixed).toBe(3);
    release();
    const { result } = await p;
    expect(result?.checked).toBe(6); // 快照 5 + 本首 1
    expect(result?.fixed).toBe(4); // 快照 3 + 本首真写入 1
    // 未重跑全量精探：仅 pending 那首被文件头探针一次（库里另有 r2/r3，未被扫）
    expect(parseFileMock.mock.calls.length).toBe(1);
  });

  it("resumeInterruptedTagRepair：无快照 → {resumed:false}", () => {
    // 验证：无遗留快照时不续跑。
    expect(getSetting(ACTIVE_RUN_KEY, "")).toBe("");
    expect(resumeInterruptedTagRepair()).toEqual({ resumed: false });
  });

  it("resumeInterruptedTagRepair：stopped:true 的快照 → 不复活且清除快照", () => {
    // 验证：用户主动停止留下的快照被消费清除，不自动复活。
    setSetting(ACTIVE_RUN_KEY, JSON.stringify(makeSnapshot({ mode: "all", stopped: true, pendingIds: ["x"] })));
    expect(resumeInterruptedTagRepair()).toEqual({ resumed: false });
    expect(getSetting(ACTIVE_RUN_KEY, "")).toBe(""); // 快照已被清除
  });

  it("resumeInterruptedTagRepair：未停止快照 → {resumed:true,mode} 并异步续跑（快照终被消费）", async () => {
    // 验证：未停止快照返回 resumed:true 且 mode 正确；fire-and-forget 续跑本轮真正结束、快照清空。
    insertSong("s-res", join(root, "res.flac"), { hasLyrics: 0 });
    cfg();
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    searchCoverMock.mockImplementation(async () => {
      await gate;
      return null;
    });
    setSetting(
      ACTIVE_RUN_KEY,
      JSON.stringify(makeSnapshot({ mode: "media", dirScope: "both", phase: "repair", pendingIds: ["s-res"] })),
    );
    expect(resumeInterruptedTagRepair()).toEqual({ resumed: true, mode: "media" });
    // 异步续跑：等本轮起来（progress 非空）后再放行，避免测试间泄漏
    await vi.waitFor(() => expect(getTagRepairProgress()).not.toBeNull());
    expect(isTagRepairRunning()).toBe(true);
    release();
    await vi.waitFor(() => expect(isTagRepairRunning()).toBe(false));
    expect(getSetting(ACTIVE_RUN_KEY, "")).toBe(""); // 正常跑完 → 快照被消费
  });

  it("boot 防抢跑判定（降级）：hasResumableActiveRun 快照存在 true / 清除后 false", () => {
    // 调度器 tick 以 hasResumableActiveRun() 决定「跳过定时兜底」。
    // 降级原因：startTagRepairScheduler 内部的 started 是一次性模块级标志，_resetTagRepairForTest
    // 未复位它，且本文件上方「运行中标志与调度器」用例已挂载过一次 → 此处无法低成本复现 tick，
    // 故直接断言该判定函数语义（与 tick 中的用法一致）。
    // 常量健壮性顺带校验：boot 恢复延迟为 60s。
    expect(TAG_REPAIR_RESUME_DELAY_MS).toBe(60_000);
    expect(hasResumableActiveRun()).toBe(false);
    setSetting(ACTIVE_RUN_KEY, JSON.stringify(makeSnapshot({ mode: "media", stopped: false })));
    expect(hasResumableActiveRun()).toBe(true); // tick 据此跳过定时兜底，不抢跑续跑
    setSetting(ACTIVE_RUN_KEY, "");
    expect(hasResumableActiveRun()).toBe(false); // 快照清除后恢复定时兜底
  });

  it("进程内抛异常：残留快照被清掉（避免永久阻塞调度器）", async () => {
    // 验证：一轮因「进程内异常」中断退出（非正常完成、非主动停止）时，finally 会清掉残留的
    // 未停止快照，使其不再顶住调度器 tick 的 hasResumableActiveRun() 判定（否则定时常规修复
    // 会被无限期跳过，直到容器重启）。对照：正常跑完一轮同样不可续跑。
    insertSong("boom", join(root, "boom.flac"), { hasLyrics: 0 });
    cfg();
    // 预置一份「boot 恢复用」的持久化快照（未停止、phase=repair、含待处理 id）模拟重启遗留，
    // 并以同一快照作为 resume 传入（等价 resumeInterruptedTagRepair 的续跑入参）。
    const leftover = makeSnapshot({ mode: "media", dirScope: "both", phase: "repair", pendingIds: ["boom"] });
    setSetting(ACTIVE_RUN_KEY, JSON.stringify(leftover));
    expect(getSetting(ACTIVE_RUN_KEY, "")).not.toBe(""); // 残留快照确实存在

    // 让续跑的候选查找（loadRow 的 `FROM songs WHERE id =` 查询）抛错 → sweep 抛出 → 本轮异常退出。
    const orig = sqlite.prepare.bind(sqlite);
    const spy = vi
      .spyOn(sqlite as unknown as { prepare: (sql: string) => unknown }, "prepare")
      .mockImplementation(((sql: string) => {
        if (String(sql).includes("FROM songs WHERE id =")) throw new Error("db boom");
        return orig(sql);
      }) as unknown as typeof sqlite.prepare);
    try {
      await expect(runTagRepairOnce("media", undefined, "both", leftover)).rejects.toThrow("db boom");
    } finally {
      spy.mockRestore();
    }

    // 异常退出后：内存态与持久化残留均被 clearActiveRun 清掉，不再可续跑。
    expect(getTagRepairActiveRun()).toBeNull();
    expect(hasResumableActiveRun()).toBe(false);
    expect(getSetting(ACTIVE_RUN_KEY, "")).toBe("");

    // 对照：正常跑完一轮后同样不可续跑（殊途同归）。
    parseFileMock.mockResolvedValue(probe({ cover: false }));
    searchCoverMock.mockResolvedValue(null);
    const { busy } = await runTagRepairOnce("media", cfg());
    expect(busy).toBe(false);
    expect(hasResumableActiveRun()).toBe(false);
    expect(getSetting(ACTIVE_RUN_KEY, "")).toBe("");
  });
});
