// MusicFetch「全库平台音乐下载」测试。
//
// 覆盖：
//   1. collector 只认「本地无实体文件」的行（path 非 l:/w:）；
//   2. 「已尝试」表驱动 pending 推进（失败项不会永远卡在同一批）；
//   3. limit 截断 + truncated 标志；
//   4. targets 形状（`library:` 前缀 + `sourceData.library` 包层）；
//   5. attempts INSERT OR IGNORE 幂等 + reset；
//   6. job config 带 `__library.migrateRowOnly`；
//   7. migrateUpgradedSong 把 `type` 从 web 迁成 local（全库下载场景的真 bug）。
//
// 库行操作走真实 sqlite（tests/setup.ts 已按文件隔离 DATA_DIR 并建好全量 schema）。
// MUST be the first import。
import "../plugins/_env.js";

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, sqlite } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { resolveFetchConfig } from "../../src/services/fetch/config.js";
import {
  LIBRARY_TARGET_PREFIX,
  buildLibraryContinuation,
  buildLibraryJobConfig,
  buildLibraryPlan,
  buildLibraryTargets,
  collectAttemptedSongIds,
  collectLibrarySongs,
  ensureLibraryAttemptsTable,
  libraryBatchProgressed,
  recordLibraryAttempts,
  resetLibraryAttempts,
} from "../../src/services/fetch/library.js";
import { migrateUpgradedSong } from "../../src/services/fetch/upgrade.js";
import { updateFetchJobStatus } from "../../src/services/fetch/jobStore.js";

function seedSong(o: {
  id: string;
  path: string;
  title?: string;
  artist?: string;
  album?: string;
  suffix?: string;
  bitRate?: number;
  size?: number;
  duration?: number;
  type?: string;
}) {
  db.insert(songs)
    .values({
      id: o.id,
      title: o.title ?? "歌",
      artist: o.artist ?? "歌手",
      album: o.album ?? "专辑",
      albumId: null,
      path: o.path,
      suffix: o.suffix ?? "mp3",
      bitRate: o.bitRate ?? 128,
      size: o.size ?? 1000,
      duration: o.duration ?? 200,
      type: o.type ?? "local",
      contentType: "audio/mpeg",
    })
    .run();
}

beforeEach(() => {
  db.delete(songs).run();
  ensureLibraryAttemptsTable();
  resetLibraryAttempts();
});

// ==================== 1) collectLibrarySongs ====================

describe("collectLibrarySongs — 只认本地无实体文件的行", () => {
  it("l: / w: 的行一律排除，其余（web）保留", () => {
    seedSong({ id: "s-l", path: "l:src-a:/dl/a.mp3", type: "local" });
    seedSong({ id: "s-w", path: "w:src-b:/webdav/b.flac", type: "local" });
    seedSong({ id: "s-web", path: "web:netease:123", type: "web" });
    seedSong({ id: "s-web2", path: "web:qq:456", type: "web" });

    const rows = collectLibrarySongs();
    expect(rows.map((r) => r.songId).sort()).toEqual(["s-web", "s-web2"]);
  });

  it("按 rowid 升序（稳定顺序，保证「下一批」可推进）", () => {
    seedSong({ id: "w1", path: "web:a:1", type: "web" });
    seedSong({ id: "w2", path: "web:a:2", type: "web" });
    seedSong({ id: "w3", path: "web:a:3", type: "web" });
    expect(collectLibrarySongs().map((r) => r.songId)).toEqual(["w1", "w2", "w3"]);
  });
});

// ==================== 2) 已尝试驱动 pending 推进 ====================

describe("buildLibraryPlan — attempted 排除与 pending 推进", () => {
  it("已尝试的行不再进 pending（失败项不会卡住按钮）", () => {
    seedSong({ id: "a1", path: "web:a:1", type: "web" });
    seedSong({ id: "a2", path: "web:a:2", type: "web" });
    seedSong({ id: "a3", path: "web:a:3", type: "web" });
    recordLibraryAttempts("batch-1", ["a1"]);

    const plan = buildLibraryPlan(resolveFetchConfig(), { limit: 10 });
    expect(plan.total).toBe(3);
    expect(plan.attempted).toBe(1);
    expect(plan.pending).toBe(2);
    expect(plan.items.map((i) => i.songId)).toEqual(["a2", "a3"]);
  });

  it("limit 截断 + truncated；limit=0 只回统计", () => {
    seedSong({ id: "b1", path: "web:b:1", type: "web" });
    seedSong({ id: "b2", path: "web:b:2", type: "web" });
    seedSong({ id: "b3", path: "web:b:3", type: "web" });

    const cut = buildLibraryPlan(resolveFetchConfig(), { limit: 2 });
    expect(cut.willEnqueue).toBe(2);
    expect(cut.truncated).toBe(true);
    expect(cut.pending).toBe(3);

    const stats = buildLibraryPlan(resolveFetchConfig(), { limit: 0 });
    expect(stats.items).toEqual([]);
    expect(stats.pending).toBe(3);

    const exact = buildLibraryPlan(resolveFetchConfig(), { limit: 3 });
    expect(exact.truncated).toBe(false);
    expect(exact.willEnqueue).toBe(3);
  });

  it("songIds 白名单：只从指定 id 里取", () => {
    seedSong({ id: "c1", path: "web:c:1", type: "web" });
    seedSong({ id: "c2", path: "web:c:2", type: "web" });
    seedSong({ id: "c3", path: "web:c:3", type: "web" });

    const plan = buildLibraryPlan(resolveFetchConfig(), { limit: 10, songIds: ["c2", "c3"] });
    expect(plan.items.map((i) => i.songId).sort()).toEqual(["c2", "c3"]);
    expect(plan.pending).toBe(2);
  });
});

// ==================== 2b) 统计快路径（SQL COUNT）与明细口径必须等价 ====================
// UI「只读统计」走 limit=0 → 命中 countLibraryPlanStats 快路径。这里锁死它与明细路径的四项统计一致，
// 防止今后改动让两条路径悄悄分叉（快路径省掉全库 materialize，是下载页不卡加载的关键）。

describe("buildLibraryPlan — limit=0 快路径与明细路径统计等价", () => {
  it("四项统计完全一致，且绝对口径正确", () => {
    seedSong({ id: "q1", path: "web:q:1", type: "web" });
    seedSong({ id: "q2", path: "web:q:2", type: "web" });
    seedSong({ id: "q3", path: "web:q:3", type: "web" });
    // 迁移成 l: / w: 的行不进池
    seedSong({ id: "q-local", path: "l:src-a:/dl/a.mp3", type: "local" });
    seedSong({ id: "q-webdav", path: "w:src-b:/b.flac", type: "local" });
    recordLibraryAttempts("batch-q", ["q1"]);

    const fast = buildLibraryPlan(resolveFetchConfig(), { limit: 0 });
    const slow = buildLibraryPlan(resolveFetchConfig(), { limit: 10 });

    expect(fast.items).toEqual([]);
    expect(fast.total).toBe(slow.total);
    expect(fast.attempted).toBe(slow.attempted);
    expect(fast.cooled).toBe(slow.cooled);
    expect(fast.pending).toBe(slow.pending);
    // 池 = 3（l:/w: 排除）；1 首在冷却期内 → attempted=1、cooled=1、pending=2
    expect(fast.total).toBe(3);
    expect(fast.attempted).toBe(1);
    expect(fast.cooled).toBe(1);
    expect(fast.pending).toBe(2);
  });

  it("冷却窗口外只计 attempted、不计 cooled", () => {
    seedSong({ id: "q-old", path: "web:q:old", type: "web" });
    seedSong({ id: "q-new", path: "web:q:new", type: "web" });
    recordLibraryAttempts("b-old", ["q-old"]);
    recordLibraryAttempts("b-new", ["q-new"]);
    sqlite
      .prepare("UPDATE fetch_library_attempts SET attempted_at = ? WHERE song_id = 'q-old'")
      .run(new Date(Date.now() - 400 * 86_400_000).toISOString());

    const fast = buildLibraryPlan(resolveFetchConfig(), { limit: 0 });
    const slow = buildLibraryPlan(resolveFetchConfig(), { limit: 10 });

    // 400 天前远超冷却窗口（默认 30 天）→ 只有 q-new 仍冷却
    expect(fast.cooled).toBe(1);
    expect(fast.cooled).toBe(slow.cooled);
    expect(fast.attempted).toBe(2);
    expect(fast.attempted).toBe(slow.attempted);
    expect(fast.pending).toBe(1);
    expect(fast.pending).toBe(slow.pending);
  });
});

// ==================== 3) attempts 幂等 / reset ====================

describe("recordLibraryAttempts / resetLibraryAttempts", () => {
  it("INSERT OR IGNORE 幂等：重复记不膨胀", () => {
    seedSong({ id: "d1", path: "web:d:1", type: "web" });
    recordLibraryAttempts("b1", ["d1"]);
    recordLibraryAttempts("b2", ["d1"]);
    expect(collectAttemptedSongIds()).toEqual(new Set(["d1"]));
  });

  it("reset 清空并返回行数", () => {
    seedSong({ id: "e1", path: "web:e:1", type: "web" });
    seedSong({ id: "e2", path: "web:e:2", type: "web" });
    recordLibraryAttempts("b1", ["e1", "e2"]);
    expect(resetLibraryAttempts()).toBe(2);
    expect(collectAttemptedSongIds().size).toBe(0);
    // 再 reset 一次仍是 0（不抛）
    expect(resetLibraryAttempts()).toBe(0);
  });
});

// ==================== 4) targets / job config ====================

describe("buildLibraryTargets / buildLibraryJobConfig", () => {
  it("targets 带 library: 前缀，sourceData.library 包层可解析且不含平台 id", () => {
    const targets = buildLibraryTargets([
      {
        songId: "song-1",
        path: "web:netease:999",
        title: "歌名",
        artist: "歌手",
        album: "专辑",
        durationSec: 200,
        suffix: "web",
        bitRate: 0,
      },
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe(`${LIBRARY_TARGET_PREFIX}song-1`);
    expect(targets[0]!.title).toBe("歌名");
    expect(targets[0]!.artist).toBe("歌手");
    expect(targets[0]!.durationSec).toBe(200);

    const parsed = JSON.parse(targets[0]!.sourceData ?? "{}") as {
      library?: { songId?: string; path?: string };
    };
    expect(parsed.library?.songId).toBe("song-1");
    expect(parsed.library?.path).toBe("web:netease:999");
    // 顶层没有其它键被误当成平台歌曲 id
    expect(Object.keys(parsed)).toEqual(["library"]);
  });

  it("durationSec<=0 不输出该键", () => {
    const targets = buildLibraryTargets([
      {
        songId: "s",
        path: "web:x:1",
        title: "t",
        artist: "",
        album: "",
        durationSec: 0,
        suffix: "",
        bitRate: 0,
      },
    ]);
    expect(targets[0]!.durationSec).toBeUndefined();
    expect(targets[0]!.artist).toBeUndefined();
  });

  it("job config 带 __library.migrateRowOnly=true；导入触发批次另带 noAutoContinue", () => {
    const cfg = resolveFetchConfig();

    // 全库下载（手动 / 自动续批）：只迁移库行，且**允许**终态后自动续批。
    const plain = buildLibraryJobConfig(cfg) as Record<string, any>;
    expect(plain.__library).toEqual({ migrateRowOnly: true });
    expect(plain.libraryBatchLimit).toBe(cfg.libraryBatchLimit);
    expect("dryRun" in plain).toBe(false);

    // 导入触发批次：语义是「把这批刚入库的歌下完」，必须关掉全库自动续批，
    // 否则会被放大成「开始全库下载」。
    const imported = buildLibraryJobConfig(cfg, { noAutoContinue: true }) as Record<string, any>;
    expect(imported.__library).toEqual({ migrateRowOnly: true, noAutoContinue: true });
  });

  it("libraryBatchLimit 缺省 500", () => {
    expect(resolveFetchConfig().libraryBatchLimit).toBe(500);
  });
});

// ==================== 5) migrateUpgradedSong 的 type 迁移 ====================

describe("migrateUpgradedSong — type 跟随新行（全库下载场景）", () => {
  it("旧行 type='web' 迁移后变成 'local'（否则 type='local' 查询永远漏掉它）", async () => {
    seedSong({
      id: "old-web",
      path: "web:netease:1",
      type: "web",
      suffix: "web",
      title: "旧标题",
    });
    seedSong({
      id: "new-row",
      path: "l:s-dl:/dl/歌-歌手.mp3",
      type: "local",
      suffix: "mp3",
      bitRate: 320,
      size: 5000,
      title: "新标题",
    });

    const res = await migrateUpgradedSong({
      oldSongId: "old-web",
      newPath: "/dl/歌-歌手.mp3",
      newSourceId: "s-dl",
    });
    expect(res.migrated).toBe(true);
    expect(res.removedRowId).toBe("new-row");

    const row = db.select().from(songs).where(eq(songs.id, "old-web")).get()!;
    expect(row).toBeTruthy();
    expect(row.type).toBe("local");
    expect(row.path).toBe("l:s-dl:/dl/歌-歌手.mp3");
    expect(row.title).toBe("新标题");
  });

  it("洗版场景（旧行本就是 local）行为不变：type 仍是 local", async () => {
    seedSong({
      id: "old-loc",
      path: "l:s-old:/dl/low.mp3",
      type: "local",
      suffix: "mp3",
      bitRate: 128,
    });
    seedSong({
      id: "new-hi",
      path: "l:s-old:/lossless/high.flac",
      type: "local",
      suffix: "flac",
      bitRate: 900,
      size: 50000,
    });

    const res = await migrateUpgradedSong({
      oldSongId: "old-loc",
      newPath: "/lossless/high.flac",
      newSourceId: "s-old",
    });
    expect(res.migrated).toBe(true);
    const row = db.select().from(songs).where(eq(songs.id, "old-loc")).get()!;
    expect(row.type).toBe("local");
    expect(row.path).toBe("l:s-old:/lossless/high.flac");
  });
});

describe("buildLibraryContinuation 自动续批", () => {
  it("有待下项且开启 → 组装下一批任务（PATCH19：记账移到终态，创建时不落 attempts）（不启动）", () => {
    ensureLibraryAttemptsTable();
    resetLibraryAttempts();
    seedSong({ id: "ac1", path: "web:cont:1", type: "web", title: "续批一" });
    seedSong({ id: "ac2", path: "web:cont:2", type: "web", title: "续批二" });
    const cfg = resolveFetchConfig({ libraryAutoContinue: true, libraryBatchLimit: 500 });
    const r = buildLibraryContinuation(cfg);
    expect(r.job).not.toBeNull();
    expect(r.enqueued).toBe(2);
    expect(r.remaining).toBe(0);
    expect(collectAttemptedSongIds().has("ac1")).toBe(false);
    expect(collectAttemptedSongIds().has("ac2")).toBe(false);
    const cfgj = (r.job as any)?.config as Record<string, unknown>;
    expect(cfgj.__library).toBeTruthy();
    updateFetchJobStatus((r.job as any).id, "cancelled");
  });

  it("关闭开关 → 不组装", () => {
    ensureLibraryAttemptsTable();
    resetLibraryAttempts();
    seedSong({ id: "ac3", path: "web:cont:3", type: "web", title: "续批三" });
    const cfg = resolveFetchConfig({ libraryAutoContinue: false });
    const r = buildLibraryContinuation(cfg);
    expect(r.job).toBeNull();
    expect(collectAttemptedSongIds().has("ac3")).toBe(false);
  });

  it("无待下项 → job null 且 remaining 0", () => {
    ensureLibraryAttemptsTable();
    resetLibraryAttempts();
    const cfg = resolveFetchConfig({ libraryAutoContinue: true });
    const r = buildLibraryContinuation(cfg);
    expect(r.job).toBeNull();
    expect(r.remaining).toBe(0);
  });
});

// ==================== libraryBatchProgressed — 自动续批无进展保护 ====================
// 2026-10-12 修 240「下载任务列表一直循环重复最后 26 首」:全部 skipped(下载冷却期
// COOLDOWN_SKIPPED 且不记账)→ 未尝试集不收缩 → 必须中止自动续批,否则无限重选同一批。
describe("libraryBatchProgressed — 无进展即中止自动续批", () => {
  it("有 done → 有进展(迁移成 l: 离开曲库池),应继续", () => {
    expect(libraryBatchProgressed({ done: 1, failed: 0, skipped: 25 })).toBe(true);
  });

  it("有 failed → 有进展(记账进冷却),应继续", () => {
    expect(libraryBatchProgressed({ done: 0, failed: 3, skipped: 0 })).toBe(true);
  });

  it("done=0 且 failed=0(全部 skipped/冷却秒跳)→ 无进展,必须中止续批", () => {
    expect(libraryBatchProgressed({ done: 0, failed: 0, skipped: 26 })).toBe(false);
  });

  it("空批次(全 0)也视为无进展", () => {
    expect(libraryBatchProgressed({ done: 0, failed: 0, skipped: 0 })).toBe(false);
  });

  it("counts 缺失/为 null 视为无进展(保守中止,绝不无限续批)", () => {
    expect(libraryBatchProgressed(undefined)).toBe(false);
    expect(libraryBatchProgressed(null)).toBe(false);
  });

  it("字符串数字也正确 coerced(done 为字符串 '2' → 有进展)", () => {
    expect(libraryBatchProgressed({ done: "2" as unknown as number, failed: 0, skipped: 0 })).toBe(true);
  });
});
