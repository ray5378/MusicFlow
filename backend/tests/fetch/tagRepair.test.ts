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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { db, sqlite } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
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
} from "../../src/services/fetch/tagRepair.js";
import type { FetchConfig } from "../../src/services/fetch/config.js";

// ---- mocks（Vitest5：工厂必须带出被依赖方用到的每个导出） --------------------

const parseFileMock = vi.hoisted(() => vi.fn());
vi.mock("music-metadata", () => ({ parseFile: parseFileMock }));

const searchCoverMock = vi.hoisted(() => vi.fn());
const searchLyricsMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/plugins/providers.js", () => ({
  searchCover: searchCoverMock,
  searchLyrics: searchLyricsMock,
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
vi.mock("../../src/services/fetch/tagWriter.js", () => ({
  writeTags: writeTagsMock,
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

function insertSong(id: string, fsPath: string, opts: { album?: string; hasLyrics?: number | null } = {}): void {
  mkdirSync(dirname(fsPath), { recursive: true });
  writeFileSync(fsPath, "fLaC-fake-audio-bytes");
  db.insert(songs)
    .values({
      id,
      title: "测试歌",
      artist: "测试歌手",
      album: opts.album ?? "测试专辑",
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

/** 构造 parseFile 返回的 common 形状（探针读 picture/lyrics/album 三个原始字段）。 */
function probe(over: Partial<{ cover: boolean; lyric: boolean; album: boolean }> = {}): {
  common: { picture: unknown[]; lyrics: string[]; album: string };
} {
  return {
    common: {
      picture: over.cover === false ? [] : [{}],
      lyrics: over.lyric === false ? [] : ["[00:01]x"],
      album: over.album === false ? "" : "专辑",
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

  it("TAG_FAILED → 2s 后重试一次，第二次成功即修复（吸收 NAS 存储层瞬时抖动）", async () => {
    const p = join(root, "retry.flac");
    insertSong("s-retry", p);
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));
    writeTagsMock.mockRejectedValueOnce(new MockFetchTagError("TAG_FAILED", "transient", p));

    const r = await repairSongTags("s-retry", cfg());
    expect(r.outcome).toBe("fixed");
    expect(writeTagsMock).toHaveBeenCalledTimes(2);
  });

  it("TIMEOUT 不重试直接上抛（由调用方记异常计数）", async () => {
    const p = join(root, "timeout.flac");
    insertSong("s-timeout", p);
    parseFileMock.mockResolvedValueOnce(probe({ album: false }));
    writeTagsMock.mockRejectedValue(new MockFetchTagError("TIMEOUT", "slow", p));

    await expect(repairSongTags("s-timeout", cfg())).rejects.toThrow();
    expect(writeTagsMock).toHaveBeenCalledTimes(1);
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
    let shared!: Promise<{ common: { picture: unknown[]; lyrics: string[]; album: string } }>;
    parseFileMock.mockImplementation(() => {
      if (!shared) {
        shared = new Promise((res) => (release = () => res(probe({ cover: false }))));
      }
      return shared;
    });
    const first = runTagRepairOnce("full", cfg());
    await vi.waitFor(() => expect(parseFileMock).toHaveBeenCalled());
    const second = await runTagRepairOnce("full", cfg());
    expect(second.busy).toBe(true);
    release();
    const done = await first;
    expect(done.busy).toBe(false);
    // 放行后 provider 拿不到封面 → unobtainable（此处只验单飞机制本身）
    expect(done.result?.unobtainable).toBe(1);
  });
});

// ---- helper --------------------------------------------------------------------

import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(songs.id, id);
}
