// MusicFetch 洗版（无损替换低码率）测试。
//
// 覆盖三条硬语义：
//   1. 门槛分档：压缩无损（flac/alac/ape）≥700kbps、未压缩无损（wav/aiff）≥1400kbps；
//   2. 库行迁移**必须保住旧行 id**（否则 playlist_songs / user_favorite_songs 变死引用）；
//   3. 原件处置（尤其 delete）不可逆 → 每一条安全闸都要锁住「拒绝碰文件」。
//
// 纯函数部分零 IO；库行迁移 / 原件处置走真实 sqlite（tests/setup.ts 已按文件隔离 DATA_DIR
// 并建好全量 schema）；orchestrator 走 deps 注入；路由走 app.request（批量子进程桩化）。
//
// MUST be the first import：与既有路由测试一致，先加载 env 助手（DATA_DIR 隔离已由 setup.ts 统一分配）。
import "../plugins/_env.js";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import md5 from "md5";

import { db, sqlite, encryptPassword } from "../../src/db/index.js";
import { ensureUpgradeAttemptsTable, recordUpgradeAttempts, resetUpgradeAttempts } from "../../src/services/fetch/upgrade.js";
import { songs, albums, playlists, playlistSongs, users, settings } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import { _resetFetchJobsForTest, getFetchJob } from "../../src/services/fetch/jobStore.js";
import { DEFAULT_QUALITY_CONFIG } from "../../src/services/fetch/types.js";
import type { Candidate } from "../../src/services/fetch/types.js";
import { isFakeLossless } from "../../src/services/fetch/quality.js";
import { DEFAULT_LOSSLESS_ROOT, resolveFetchConfig } from "../../src/services/fetch/config.js";
import { runFetchPipeline, type FetchDeps } from "../../src/services/fetch/orchestrator.js";
import {
  LOSSLESS_COMPRESSED_CONTAINERS,
  LOSSLESS_UNCOMPRESSED_CONTAINERS,
  buildUpgradeQuality,
  isBelowUpgradeBar,
  buildUpgradePlan,
  buildUpgradeTargets,
  disposeOriginalFile,
  migrateUpgradedSong,
  upgradeBaselineKbps,
} from "../../src/services/fetch/upgrade.js";

// 批量子进程运行器整体替换成桩，避免真 fork（仅路由组用到）。
const { runBatchJobMock } = vi.hoisted(() => ({
  runBatchJobMock: vi.fn(async () => ({ result: { hasMore: false }, aborted: false, childRss: 0 })),
}));
vi.mock("../../src/batch/runner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runBatchJob: runBatchJobMock };
});

import { registerFetch } from "../../src/routes/api/fetch.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerFetch(api);
app.route("/rest/api", api);

const PLAIN = "hunter2";
const SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;
async function call(method: string, path: string, body?: any) {
  const res = await app.request(`/rest/api${path}${path.includes("?") ? "&" : "?"}${authQS()}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

// ==================== 现场 ====================

let ROOT = "";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  db.insert(users)
    .values({
      id: "u1",
      username: "alice",
      password: "",
      salt: "s",
      subsonicSalt: SALT,
      passEnc: encryptPassword(PLAIN),
      isAdmin: 1,
      isActive: 1,
    })
    .run();
});

beforeEach(() => {
  // 每文件独立 DATA_DIR（setup.ts），本文件内再逐条清库，消除用例顺序耦合。
  db.delete(playlistSongs).run();
  db.delete(playlists).run();
  db.delete(songs).run();
  db.delete(albums).run();
  // 洗版冷却表是新增表,不在上面的 drizzle 清单里 —— 路由用例(POST /upgrade/tasks)
  // 会真实写入,而本文件 sequence.shuffle 打乱用例顺序,不清会随机污染 seedThree 用例。
  ensureUpgradeAttemptsTable(); // 首个用例可能还没人建过表
  sqlite.prepare("DELETE FROM fetch_upgrade_attempts").run();
  db.delete(settings).where(eq(settings.key, "fetch.config")).run();
  _resetSettingsCacheForTest();
  _resetFetchJobsForTest();
  runBatchJobMock.mockClear();
  ROOT = mkdtempSync(join(tmpdir(), "mf-up-root-"));
});

afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

/** 造一个质量探针候选（probed 由「有效比特率 + 时长」反推字节数）。 */
function bytesFor(kbps: number, durationSec: number): number {
  return Math.round((kbps * 1000 * durationSec) / 8);
}
function probedCand(container: string, kbps: number, durationSec = 100): Candidate {
  return {
    id: `c:${container}:${kbps}`,
    pluginId: "gmd",
    platform: "wy",
    url: `https://cdn.example.com/a.${container}`,
    sourceRank: 0,
    title: "歌",
    artist: "歌手",
    probed: { container, bytes: bytesFor(kbps, durationSec), durationSec },
  };
}

/** 往 songs 表塞一行洗版要看的字段。 */
function seedSong(o: {
  id: string;
  path: string;
  suffix: string;
  bitRate: number;
  size?: number;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  albumId?: string | null;
  type?: string;
}) {
  db.insert(songs)
    .values({
      id: o.id,
      title: o.title ?? "歌",
      artist: o.artist ?? "歌手",
      album: o.album ?? "专辑",
      albumId: o.albumId ?? null,
      path: o.path,
      suffix: o.suffix,
      bitRate: o.bitRate,
      size: o.size ?? 1000,
      duration: o.duration ?? 200,
      type: o.type ?? "local",
      contentType: "audio/mpeg",
    })
    .run();
}

// ==================== 1) isBelowUpgradeBar ====================

describe("isBelowUpgradeBar — 洗版门槛分档", () => {
  const upQ = buildUpgradeQuality(DEFAULT_QUALITY_CONFIG);
  const row = (suffix: string, bitRate: number) => ({ suffix, bitRate });

  it("flac 900 ≥ 700 → 达标", () => {
    expect(isBelowUpgradeBar(row("flac", 900), upQ).below).toBe(false);
  });

  it("flac 600 < 700 → 待洗", () => {
    const r = isBelowUpgradeBar(row("flac", 600), upQ);
    expect(r.below).toBe(true);
    expect(r.reason).toContain("600");
  });

  it("wav 1411 ≥ 1400 → 达标", () => {
    expect(isBelowUpgradeBar(row("wav", 1411), upQ).below).toBe(false);
  });

  it("wav 900 < 1400 → 待洗", () => {
    expect(isBelowUpgradeBar(row("wav", 900), upQ).below).toBe(true);
  });

  it("mp3 320 → 有损格式一律待洗", () => {
    const r = isBelowUpgradeBar(row("mp3", 320), upQ);
    expect(r.below).toBe(true);
    expect(r.reason).toContain("有损");
  });

  it("后缀为空 → 待洗（无法确认是无损）", () => {
    expect(isBelowUpgradeBar(row("", 900), upQ).below).toBe(true);
  });

  it("bitRate = 0 → 码率未知一律待洗", () => {
    const r = isBelowUpgradeBar(row("flac", 0), upQ);
    expect(r.below).toBe(true);
    expect(r.reason).toContain("未知");
  });
});

// ==================== 2) buildUpgradeQuality ====================

describe("buildUpgradeQuality — 洗版档派生", () => {
  const upQ = buildUpgradeQuality(DEFAULT_QUALITY_CONFIG);

  it("档位 = lossless + preferLossless + bitrate 检测（无「拒绝假无损」开关）", () => {
    expect(upQ.qualityFloor).toBe("lossless");
    expect(upQ.preferLossless).toBe(true);
    // 开关已删（产品定调 2026-10-11）：flac 只是容器，假无损由档位门槛自然拦下
    expect("rejectFakeLossless" in upQ).toBe(false);
    expect(upQ.fakeLosslessDetect).toBe("bitrate");
  });

  it("允许容器 = 压缩无损 + 未压缩无损（全覆盖）", () => {
    for (const c of [...LOSSLESS_COMPRESSED_CONTAINERS, ...LOSSLESS_UNCOMPRESSED_CONTAINERS]) {
      expect(upQ.allowedContainers).toContain(c);
    }
  });

  it("双档阈值：压缩 700 / 未压缩 1400，且未压缩容器 = wav/aiff", () => {
    expect(upQ.fakeLosslessMinEffBitrate).toBe(700);
    expect(upQ.uncompressedMinKbps).toBe(1400);
    expect(upQ.uncompressedContainers).toEqual(["wav", "aiff"]);
  });

  it("保留 base 的其它旋钮（如 minDurationSec 未被覆盖）", () => {
    const base = { ...DEFAULT_QUALITY_CONFIG, minDurationSec: 55 };
    expect(buildUpgradeQuality(base).minDurationSec).toBe(55);
  });
});

// ==================== 3) isFakeLossless 分档（洗版档集成） ====================

describe("isFakeLossless — 洗版档按容器分档", () => {
  const upQ = buildUpgradeQuality(DEFAULT_QUALITY_CONFIG);

  it("wav 800kbps 判假：未压缩无损（wav/aiff）恒按 1400 下限，与配置无关", () => {
    const r = isFakeLossless(probedCand("wav", 800), DEFAULT_QUALITY_CONFIG);
    expect(r.fake).toBe(true);
    expect(r.reason).toContain("1400");
    expect(r.reason).toContain("未压缩无损下限");
  });

  it("洗版档：wav 800kbps < 1400 → 判假", () => {
    expect(isFakeLossless(probedCand("wav", 800), upQ).fake).toBe(true);
  });

  it("洗版档：wav 1411kbps ≥ 1400 → 不判假", () => {
    expect(isFakeLossless(probedCand("wav", 1411), upQ).fake).toBe(false);
  });

  it("洗版档：flac 800kbps ≥ 700 → 不判假", () => {
    expect(isFakeLossless(probedCand("flac", 800), upQ).fake).toBe(false);
  });

  it("洗版档：flac 600kbps < 700 → 判假", () => {
    expect(isFakeLossless(probedCand("flac", 600), upQ).fake).toBe(true);
  });

  it("洗版档：单声道 wav 705kbps 虽过 700 档，仍因 < 1400 判假", () => {
    expect(isFakeLossless(probedCand("wav", 705), upQ).fake).toBe(true);
  });
});

// ==================== 4) buildUpgradePlan / buildUpgradeTargets ====================

describe("buildUpgradePlan — 只列低于门槛的行", () => {
  const cfg = () => resolveFetchConfig({ downloadRoot: "/MUSIC/DOWNLOAD", cacheRoot: "/MUSIC/DOWNLOADCACHE" });

  function seedThree() {
    // size/duration 必须与 bitRate 自洽（基准码率用 size/duration 现场换算，见 upgradeBaselineKbps）：
    // size = kbps*1000*duration/8，duration 统一 200s。
    // 达标：flac 900（不该出现在计划里）
    seedSong({ id: "s-hi", path: "l:s-up:/dl/hi.flac", suffix: "flac", bitRate: 900, size: 22_500_000, duration: 200 });
    // 待洗：flac 600 / wav 900 / mp3 320
    seedSong({ id: "s-lo1", path: "l:s-up:/dl/lo1.flac", suffix: "flac", bitRate: 600, size: 15_000_000, duration: 200 });
    seedSong({ id: "s-lo2", path: "l:s-up:/dl/lo2.wav", suffix: "wav", bitRate: 900, size: 22_500_000, duration: 200 });
    seedSong({ id: "s-lo3", path: "l:s-up:/dl/lo3.mp3", suffix: "mp3", bitRate: 320, size: 8_000_000, duration: 200 });
    // 另一个源的行，不该被 s-up 范围命中
    seedSong({ id: "s-other", path: "l:s-other:/dl/x.mp3", suffix: "mp3", bitRate: 128, size: 3_200_000, duration: 200 });
  }

  it("只列低于门槛的行，且限定在给定源内", () => {
    seedThree();
    const plan = buildUpgradePlan(["s-up"], cfg());
    expect(plan.total).toBe(4);
    expect(plan.belowBar).toBe(3);
    expect(plan.truncated).toBe(false);
    expect(plan.items.map((i) => i.songId).sort()).toEqual(["s-lo1", "s-lo2", "s-lo3"]);
    expect(plan.items.some((i) => i.songId === "s-hi")).toBe(false);
    expect(plan.items.some((i) => i.songId === "s-other")).toBe(false);
  });

  it("limit 截断 → truncated:true，items 只给前 N", () => {
    seedThree();
    const plan = buildUpgradePlan(["s-up"], cfg(), { limit: 2 });
    expect(plan.belowBar).toBe(3);
    expect(plan.items).toHaveLength(2);
    expect(plan.truncated).toBe(true);
  });

  it("songIds 显式点名 → 只保留点名的行（可含已达标者）", () => {
    seedThree();
    const plan = buildUpgradePlan(["s-up"], cfg(), { songIds: ["s-hi"] });
    expect(plan.items.map((i) => i.songId)).toEqual(["s-hi"]);
  });

  it("空库 / 空源列表 → 空计划且不抛", () => {
    expect(buildUpgradePlan(["s-up"], cfg()).items).toEqual([]);
    expect(buildUpgradePlan([], cfg()).items).toEqual([]);
    expect(buildUpgradePlan(["s-up"], cfg()).total).toBe(0);
  });

  it("buildUpgradeTargets：id 带 upgrade: 前缀，sourceData 把信息包在 upgrade 键下（不触发分支 B 取链）", () => {
    const targets = buildUpgradeTargets([
      { songId: "s-lo1", title: "歌", artist: "歌手", album: "专辑", suffix: "flac", bitrateKbps: 600, durationSec: 200, path: "l:s-up:/dl/lo1.flac", reason: "x" },
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("upgrade:s-lo1");
    const sd = JSON.parse(targets[0].sourceData as string);
    expect(sd.upgrade.songId).toBe("s-lo1");
    expect(sd.upgrade.path).toBe("l:s-up:/dl/lo1.flac");
    // 顶层不得出现 songId / platform —— 否则 candidates.ts 会误当平台歌曲取链。
    expect(sd.songId).toBeUndefined();
    expect(sd.platform).toBeUndefined();
  });
});

// ==================== 5) disposeOriginalFile（不可逆 → 安全闸） ====================

describe("disposeOriginalFile — 安全闸", () => {
  it("闸：新文件不存在 → 不碰原件", () => {
    const orig = join(ROOT, "low.mp3");
    writeFileSync(orig, "x");
    const r = disposeOriginalFile({
      originalPath: orig,
      newPath: join(ROOT, "missing.flac"),
      action: "delete",
      allowedRoots: [ROOT],
    });
    expect(r.action).toBe("skip");
    expect(existsSync(orig)).toBe(true);
    expect(r.warnings.join()).toContain("新文件不存在");
  });

  it("闸：原件不在允许根之下 → 不碰原件", () => {
    const outside = mkdtempSync(join(tmpdir(), "mf-up-out-"));
    const orig = join(outside, "low.mp3");
    writeFileSync(orig, "x");
    const neu = join(ROOT, "n.flac");
    writeFileSync(neu, "y");
    try {
      const r = disposeOriginalFile({ originalPath: orig, newPath: neu, action: "delete", allowedRoots: [ROOT] });
      expect(r.action).toBe("skip");
      expect(existsSync(orig)).toBe(true);
      expect(r.warnings.join()).toContain("不在允许的下载根");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("闸：非音频扩展名 → 不碰原件", () => {
    const orig = join(ROOT, "low.txt");
    writeFileSync(orig, "x");
    const neu = join(ROOT, "n.flac");
    writeFileSync(neu, "y");
    const r = disposeOriginalFile({ originalPath: orig, newPath: neu, action: "delete", allowedRoots: [ROOT] });
    expect(r.action).toBe("skip");
    expect(existsSync(orig)).toBe(true);
    expect(r.warnings.join()).toContain("非音频扩展名");
  });

  it("delete：真删除原件，新文件保留", () => {
    const orig = join(ROOT, "low.mp3");
    writeFileSync(orig, "x");
    const neu = join(ROOT, "n.flac");
    writeFileSync(neu, "y");
    const r = disposeOriginalFile({ originalPath: orig, newPath: neu, action: "delete", allowedRoots: [ROOT] });
    expect(r.action).toBe("delete");
    expect(r.deleted).toBe(true);
    expect(existsSync(orig)).toBe(false);
    expect(existsSync(neu)).toBe(true);
  });

  it("move：移到 backupDir，重名加序号且不覆盖既有备份", () => {
    const backup = join(ROOT, "bak");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "low.mp3"), "old");
    const orig = join(ROOT, "low.mp3");
    writeFileSync(orig, "new");
    const neu = join(ROOT, "n.flac");
    writeFileSync(neu, "y");
    const r = disposeOriginalFile({ originalPath: orig, newPath: neu, action: "move", backupDir: backup, allowedRoots: [ROOT] });
    expect(r.action).toBe("move");
    expect(existsSync(orig)).toBe(false);
    expect(r.movedTo && existsSync(r.movedTo)).toBe(true);
    expect(r.movedTo).not.toBe(join(backup, "low.mp3"));
    expect(readFileSync(join(backup, "low.mp3"), "utf8")).toBe("old"); // 既有备份未被覆盖
  });
});

// ==================== 6) migrateUpgradedSong —— 歌单存活（最重要） ====================

describe("migrateUpgradedSong — 迁移保住旧行 id", () => {
  it("旧行 id 不变、path/metadata 刷新为新文件、新行被删、playlist_songs 仍能 join", async () => {
    db.insert(albums).values({ id: "alb-1", name: "专辑", songCount: 0, duration: 0 }).run();
    seedSong({
      id: "old-1",
      path: "l:s-old:/dl/low.mp3",
      suffix: "mp3",
      bitRate: 320,
      size: 1000,
      title: "旧标题",
      albumId: "alb-1",
    });
    seedSong({
      id: "new-2",
      path: "l:s-new:/lossless/high.flac",
      suffix: "flac",
      bitRate: 900,
      size: 50000,
      title: "新标题",
      albumId: "alb-1",
    });
    db.insert(playlists).values({ id: "pl-1", name: "歌单", ownerId: "u1" }).run();
    db.insert(playlistSongs).values({ playlistId: "pl-1", songId: "old-1", position: 0 }).run();

    const res = await migrateUpgradedSong({ oldSongId: "old-1", newPath: "/lossless/high.flac", newSourceId: "s-new" });
    expect(res.migrated).toBe(true);
    expect(res.removedRowId).toBe("new-2");
    expect(res.warnings).toEqual([]);

    // ① 旧行 id 仍存在，且 path 指向新文件；② metadata 刷新为新行值
    const oldRow = db.select().from(songs).where(eq(songs.id, "old-1")).get()!;
    expect(oldRow).toBeTruthy();
    expect(oldRow.path).toBe("l:s-new:/lossless/high.flac");
    expect(oldRow.suffix).toBe("flac");
    expect(oldRow.bitRate).toBe(900);
    expect(oldRow.size).toBe(50000);
    expect(oldRow.title).toBe("新标题");

    // ③ 新行已被删除
    expect(db.select().from(songs).where(eq(songs.id, "new-2")).get()).toBeUndefined();

    // ④ playlist_songs.song_id 仍能 join 到那行（没有变成死引用）
    const joined = db
      .select()
      .from(playlistSongs)
      .innerJoin(songs, eq(playlistSongs.songId, songs.id))
      .where(eq(playlistSongs.playlistId, "pl-1"))
      .all();
    expect(joined).toHaveLength(1);
    expect((joined[0] as any).songs.id).toBe("old-1");
    expect((joined[0] as any).songs.path).toBe("l:s-new:/lossless/high.flac");
  });

  it("旧行不存在 → migrated:false，不抛", async () => {
    const res = await migrateUpgradedSong({ oldSongId: "nope", newPath: "/x.flac", newSourceId: "s" });
    expect(res.migrated).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("新行未入库且磁盘无该文件 → migrated:false（保留原件由上层决定）", async () => {
    seedSong({ id: "old-1", path: "l:s-old:/dl/low.mp3", suffix: "mp3", bitRate: 320 });
    const res = await migrateUpgradedSong({ oldSongId: "old-1", newPath: "/no/such/high.flac", newSourceId: "s-new" });
    expect(res.migrated).toBe(false);
    expect(res.warnings.join()).toContain("未入库");
  });
});

// ==================== 7) orchestrator — downloadRootOverride ====================

describe("orchestrator — downloadRootOverride（洗版成品根覆盖）", () => {
  it("覆盖 downloadRoot 后：ensureDownloadSource 与 finalizeFile 都看到新根", async () => {
    const DL = mkdtempSync(join(tmpdir(), "mf-up-dl-"));
    const CA = mkdtempSync(join(tmpdir(), "mf-up-ca-"));
    const LS = mkdtempSync(join(tmpdir(), "mf-up-ls-"));
    try {
      const ensure = vi.fn(() => ({ sourceId: "s-loss", created: true, reusedExisting: false, ancestorSourceId: null }));
      const finalize = vi.fn(() => ({ action: "write", finalPath: join(LS, "out.flac"), warnings: [] }));
      const deps = {
        collectCandidates: async () => [
          {
            id: "gmd:wy:1",
            pluginId: "gmd",
            platform: "wy",
            url: "http://h/a.flac",
            sourceRank: 0,
            declared: { container: "flac", bitrateKbps: 900, bitDepth: 16 },
          },
        ],
        downloadToFile: async (o: { destPath: string; url: string }) => {
          mkdirSync(dirname(o.destPath), { recursive: true });
          writeFileSync(o.destPath, "DATA");
          return { bytes: 22_500_000, httpStatus: 200, sha256: "x", rangeSupported: true, finalUrl: o.url, partial: false };
        },
        verifyIntegrity: async () => ({ ok: true, level: "probe", detail: { bytes: 22_500_000 }, warnings: [] }),
        probeFile: async (file: string) => ({
          path: file,
          bytes: 22_500_000,
          container: "flac",
          bitDepth: 16,
          bitrateKbps: 900,
          sampleRateHz: 44100,
          durationSec: 200,
          hasCover: false,
        }),
        writeTags: async (src: string) => ({ ok: true, file: src, bytes: 5000, mtimeMs: Date.now(), warnings: [] }),
        transcodeFile: async (src: string) => ({ ok: true, srcPath: src, dstPath: src, skipped: true, bytes: 5000, warnings: [] }),
        finalizeFile: finalize,
        findExistingPlayable: () => null,
        scanLocalFiles: async () => ({ added: 1, updated: 0, failed: 0, skipped: 0 }),
        ensureDownloadSource: ensure,
        rankCandidates: (c: Candidate[]) => c,
        searchLyrics: async () => null,
        searchCover: async () => null,
      } as unknown as FetchDeps;

      const r = await runFetchPipeline({
        targets: [{ id: "t1", title: "Song", artist: "A", durationSec: 200 }],
        config: { downloadRoot: DL, cacheRoot: CA },
        downloadRootOverride: LS,
        deps,
      });

      expect(r.items[0].status).toBe("done");
      // ensureDownloadSource 收到的是覆盖后的根（洗版源）+ 按根定调的显示名
      expect(ensure).toHaveBeenCalledWith(LS, "已下载流媒体音质");
      expect(finalize).toHaveBeenCalled();
      expect((finalize.mock.calls[0][0] as any).config.downloadRoot).toBe(LS);
    } finally {
      rmSync(DL, { recursive: true, force: true });
      rmSync(CA, { recursive: true, force: true });
      rmSync(LS, { recursive: true, force: true });
    }
  });
});

// ==================== 8) 路由：/v1/fetch/upgrade/* ====================

describe("fetch 路由：洗版端点", () => {
  it("GET /v1/fetch/upgrade/plan 返回计划骨架 + sourceNames", async () => {
    const r = await call("GET", "/v1/fetch/upgrade/plan?sourceId=s-up");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(Array.isArray(r.body.plan.items)).toBe(true);
    expect(r.body.plan.sourceIds).toEqual(["s-up"]);
    expect(typeof r.body.plan.sourceNames).toBe("object");
    expect(r.body.plan.truncated).toBe(false);
  });

  it("POST /v1/fetch/upgrade/tasks：job.config 携带 __upgrade 快照（成品根 / 原件处置）", async () => {
    seedSong({ id: "s-lo1", path: "l:s-up:/dl/lo1.mp3", suffix: "mp3", bitRate: 320 });
    const r = await call("POST", "/v1/fetch/upgrade/tasks", { sourceId: "s-up" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.job.id).toBeTruthy();

    const job = getFetchJob(r.body.job.id)!;
    const cfg = job.config as any;
    expect(cfg.skipIfInLibrary).toBe(false); // 洗版必须能命中库内已有低码率行
    expect(cfg.quality.qualityFloor).toBe("lossless");
    expect(cfg.quality.fakeLosslessMinEffBitrate).toBe(700);
    expect(cfg.quality.uncompressedMinKbps).toBe(1400);
    expect(cfg.__upgrade.downloadRootOverride).toBe(DEFAULT_LOSSLESS_ROOT);
    expect(cfg.__upgrade.originalDisposal.action).toBe("delete"); // 产品定调 2026-10-10：洗版默认删除原版;
    expect(Array.isArray(cfg.__upgrade.originalDisposal.allowedRoots)).toBe(true);

    // 有可洗目标 → 起了批量子进程
    expect(runBatchJobMock).toHaveBeenCalled();
  });

  it("POST /v1/fetch/upgrade/tasks：无目标 → 立即终态 done，不启动批量", async () => {
    const r = await call("POST", "/v1/fetch/upgrade/tasks", { sourceId: "s-empty" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.job.status).toBe("done");
    expect(runBatchJobMock).not.toHaveBeenCalled();
  });

  it("GET /v1/fetch/upgrade/config 暴露双档阈值与成品根", async () => {
    const r = await call("GET", "/v1/fetch/upgrade/config");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.config.compressedMinKbps).toBe(700);
    expect(r.body.config.uncompressedMinKbps).toBe(1400);
    expect(r.body.config.losslessRoot).toBe(DEFAULT_LOSSLESS_ROOT);
  });

  it("PUT /v1/fetch/upgrade/config 增量写覆盖项（originalAction / batchLimit）", async () => {
    const r = await call("PUT", "/v1/fetch/upgrade/config", { originalAction: "delete", batchLimit: 5 });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.config.originalAction).toBe("delete");
    expect(r.body.config.batchLimit).toBe(5);
  });
});

// ==================== 7) upgradeBaselineKbps —— 洗版基准码率 ====================

describe("upgradeBaselineKbps — size/duration 换算优先（240 生产实测守卫）", () => {
  it("size/duration 可信时优先现场换算（库存 bit_rate 对 flac 是垃圾：900kbps 存成 8）", () => {
    // 22,500,000 B / 200s = 900kbps；库存 bit_rate 只有 8
    expect(upgradeBaselineKbps({ size: 22_500_000, durationSec: 200, bitRate: 8 })).toBe(900);
  });

  it("size/duration 缺失时回落 bit_rate 列", () => {
    expect(upgradeBaselineKbps({ size: 0, durationSec: 0, bitRate: 320 })).toBe(320);
    expect(upgradeBaselineKbps({ bitRate: 320 })).toBe(320);
  });

  it("两者都拿不到 → 0（isBelowUpgradeBar 判「码率未知」）", () => {
    expect(upgradeBaselineKbps({})).toBe(0);
    expect(upgradeBaselineKbps({ size: 0, durationSec: 0, bitRate: 0 })).toBe(0);
  });

  it("isBelowUpgradeBar 用基准码率判定：bit_rate=8 但 size/duration 显示 900kbps 的 flac 达标", () => {
    const r = isBelowUpgradeBar(
      {
        id: "x",
        path: "l:s:/a.flac",
        title: "t",
        artist: "a",
        album: "al",
        suffix: "flac",
        bitRate: 8,
        durationSec: 200,
        size: 22_500_000,
      },
      buildUpgradeQuality(DEFAULT_QUALITY_CONFIG),
    );
    expect(r.below).toBe(false);
    expect(r.reason).toContain("900kbps >= 700kbps");
  });

  it("反之：真实只有 600kbps 的 flac 仍判低于门槛", () => {
    const r = isBelowUpgradeBar(
      {
        id: "y",
        path: "l:s:/b.flac",
        title: "t",
        artist: "a",
        album: "al",
        suffix: "flac",
        bitRate: 6,
        durationSec: 200,
        size: 15_000_000,
      },
      buildUpgradeQuality(DEFAULT_QUALITY_CONFIG),
    );
    expect(r.below).toBe(true);
    expect(r.reason).toContain("600kbps < 700kbps");
  });
});

// ==================== 5) 洗版冷却（fetch_upgrade_attempts） ====================

describe("buildUpgradePlan 冷却 — N 天内尝试过就跳过", () => {
  const cfg = () => resolveFetchConfig({ downloadRoot: "/MUSIC/DOWNLOAD", cacheRoot: "/MUSIC/DOWNLOADCACHE" });

  const wipe = () => {
    sqlite.prepare("DELETE FROM fetch_upgrade_attempts").run();
    sqlite.prepare("DELETE FROM songs WHERE path LIKE 'l:s-up:%'").run();
  };
  beforeEach(wipe);
  afterEach(wipe);

  it("冷却期内的歌被跳过并计入 cooled，未尝试的照常入选", () => {
    seedSong({ id: "s-lo1", path: "l:s-up:/dl/lo1.flac", suffix: "flac", bitRate: 600, size: 15_000_000, duration: 200 });
    seedSong({ id: "s-lo2", path: "l:s-up:/dl/lo2.flac", suffix: "flac", bitRate: 600, size: 15_000_000, duration: 200 });
    recordUpgradeAttempts("b1", ["s-lo1"]);
    const plan = buildUpgradePlan(["s-up"], cfg());
    expect(plan.belowBar).toBe(1);
    expect(plan.cooled).toBe(1);
    expect(plan.items.map((i) => i.songId)).toEqual(["s-lo2"]);
  });

  it("超过冷却期后恢复入选", () => {
    seedSong({ id: "s-lo1", path: "l:s-up:/dl/lo1.flac", suffix: "flac", bitRate: 600, size: 15_000_000, duration: 200 });
    recordUpgradeAttempts("b1", ["s-lo1"]);
    sqlite
      .prepare("UPDATE fetch_upgrade_attempts SET attempted_at = ? WHERE song_id = 's-lo1'")
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    const plan = buildUpgradePlan(["s-up"], cfg());
    expect(plan.cooled).toBe(0);
    expect(plan.items.map((i) => i.songId)).toEqual(["s-lo1"]);
  });

  it("显式 songIds 点名重试绕过冷却", () => {
    seedSong({ id: "s-lo1", path: "l:s-up:/dl/lo1.flac", suffix: "flac", bitRate: 600, size: 15_000_000, duration: 200 });
    recordUpgradeAttempts("b1", ["s-lo1"]);
    const plan = buildUpgradePlan(["s-up"], cfg(), { songIds: ["s-lo1"] });
    expect(plan.items.map((i) => i.songId)).toEqual(["s-lo1"]);
  });

  it("resetUpgradeAttempts 清空后全量可触发", () => {
    seedSong({ id: "s-lo1", path: "l:s-up:/dl/lo1.flac", suffix: "flac", bitRate: 600, size: 15_000_000, duration: 200 });
    seedSong({ id: "s-lo2", path: "l:s-up:/dl/lo2.flac", suffix: "flac", bitRate: 600, size: 15_000_000, duration: 200 });
    recordUpgradeAttempts("b1", ["s-lo1", "s-lo2"]);
    expect(resetUpgradeAttempts()).toBe(2);
    const plan = buildUpgradePlan(["s-up"], cfg());
    expect(plan.cooled).toBe(0);
    expect(plan.items).toHaveLength(2);
  });
});
