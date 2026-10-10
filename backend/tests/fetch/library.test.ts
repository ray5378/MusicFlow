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

import { db } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { resolveFetchConfig } from "../../src/services/fetch/config.js";
import {
  LIBRARY_TARGET_PREFIX,
  buildLibraryJobConfig,
  buildLibraryPlan,
  buildLibraryTargets,
  collectAttemptedSongIds,
  collectLibrarySongs,
  ensureLibraryAttemptsTable,
  recordLibraryAttempts,
  resetLibraryAttempts,
} from "../../src/services/fetch/library.js";
import { migrateUpgradedSong } from "../../src/services/fetch/upgrade.js";

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

  it("job config 带 __library.migrateRowOnly=true，dryRun 透传", () => {
    const cfg = resolveFetchConfig();
    const withDry = buildLibraryJobConfig(cfg, true) as Record<string, any>;
    expect(withDry.__library).toEqual({ migrateRowOnly: true });
    expect(withDry.dryRun).toBe(true);
    expect(withDry.libraryBatchLimit).toBe(cfg.libraryBatchLimit);

    const withoutDry = buildLibraryJobConfig(cfg) as Record<string, any>;
    expect(withoutDry.__library).toEqual({ migrateRowOnly: true });
    expect("dryRun" in withoutDry).toBe(false);
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
