// 首页「本地随机」封面链路:firstPlayableCoverRef 快速路径 + 封面快照(P0-3b)。
//
// 回归背景(240 生产实测,2026-11-14):
//   首页 /v1/local-recommend 串行 8 次 5.22/2.18/1.19/1.19/1.89/0.81/0.94/0.91s,
//   并发 3 个时 /ping 被同步阻塞到 1.48s(点其它标题栏页面卡住的直接原因)。
//   定位:868 个带平台歌单里,798 个 resolveCoverFile 共 285ms、260 个
//   listPlayableCoverRefs 共 4344ms(单歌单 16.7ms) —— 后者是主 SQL(3ms)的千倍。
//
// 本文件钉住三条不能回退的行为:
//   ① firstPlayableCoverRef 命中即返回(不再为 1 张封面扫 50 行 + 逐行 fs 探测);
//   ② 封面快照**独立于候选池**:dropPlatformPool(空闲回收)不得清掉它;
//   ③ 快照落库后进程重启可直接复用,不重新探测封面文件。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  clearCoverResolveCache,
  firstPlayableCoverRef,
  listPlayableCoverRefs,
} from "../../src/services/playlistCover.js";
import {
  recommendLocalPlatforms,
  dropPlatformPool,
  clearCoverSnapshot,
  LOCAL_PLATFORM_REC_PLUGIN_ID,
} from "../../src/services/plugin/localPlatformRecommend.js";

const NOW = "2026-11-14T00:00:00.000Z";
const SNAPSHOT_KEY = "localrec:cover-snapshot:v1";
let owner = "";

function coversDir(): string {
  return path.join(process.env.DATA_DIR as string, "covers");
}

/** 写一个真实存在的封面文件(resolveCoverFile 会 stat 校验)。 */
function writeCover(name: string) {
  fs.mkdirSync(coversDir(), { recursive: true });
  fs.writeFileSync(path.join(coversDir(), name), "x");
}

function seedPlaylist(
  id: string,
  platform: string | null,
  opts: { coverArt?: string | null } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, song_count, duration,
                              sync_enabled, source_platform, created_at, updated_at)
       VALUES (?,?,?,1,'',?,0,0,0,?,?,?)`,
    )
    .run(id, id, owner, opts.coverArt ?? null, platform, NOW, NOW);
}

/** 给歌单塞一首歌;position 递增保证排序稳定。 */
function seedSong(playlistId: string, songId: string, position: number, coverRef: string | null) {
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, cover_art, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(songId, songId, "A", "Al", 100, `l:src:/tmp/${songId}.mp3`, "mp3", "local", coverRef, NOW);
  sqlite
    .prepare(
      `INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,1,?)`,
    )
    .run(playlistId, songId, position, NOW);
}

function bySource(channels: any[]): Record<string, any> {
  const m: Record<string, any> = {};
  for (const c of channels) m[c.source] = c;
  return m;
}

function writeSnapshot(obj: Record<string, [string | null, number]>) {
  sqlite
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(SNAPSHOT_KEY, JSON.stringify(obj), NOW);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  registerBuiltinPlugins();
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  if (admin) {
    owner = admin.id;
  } else {
    sqlite
      .prepare(
        "INSERT INTO users (id, username, password, salt, subsonic_salt, pass_enc, is_admin, is_active, email, created_at, updated_at) VALUES ('u1','admin','','s','ss','',1,1,'a@b.c',?,?)",
      )
      .run(NOW, NOW);
    owner = "u1";
  }
});

beforeEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs").run();
  sqlite.prepare("DELETE FROM playlists").run();
  sqlite.prepare("DELETE FROM songs").run();
  clearCoverResolveCache();
  dropPlatformPool();
  // 快照独立于池,跨用例必须显式清(含落库行),否则上一用例的 ref 会串到下一用例。
  clearCoverSnapshot();
  sqlite
    .prepare("UPDATE plugins SET config = ?, enabled = 1 WHERE name = ?")
    .run("{}", LOCAL_PLATFORM_REC_PLUGIN_ID);
});

describe("firstPlayableCoverRef:只取第一张可用封面", () => {
  it("跳过头部无封面/封面文件缺失的行,返回第一张真实存在的那张", () => {
    writeCover("cv-real.jpg");
    seedPlaylist("p1", "qq");
    seedSong("p1", "s1", 0, null); // 无封面
    seedSong("p1", "s2", 1, "cv-missing.jpg"); // 有 ref 但文件不存在
    seedSong("p1", "s3", 2, "cv-real.jpg"); // 命中

    expect(firstPlayableCoverRef("p1")).toBe("cv-real.jpg");
  });

  it("头部 maxProbe 内全无可用封面 → null(不再深扫 50 行)", () => {
    seedPlaylist("p2", "qq");
    seedSong("p2", "s1", 0, null);
    seedSong("p2", "s2", 1, null);

    expect(firstPlayableCoverRef("p2")).toBeNull();
    // maxProbe 收窄到 1 时,即便第二行有封面也取不到 —— 证明探测确有上界。
    writeCover("cv-late.jpg");
    seedPlaylist("p3", "qq");
    seedSong("p3", "s3", 0, null);
    seedSong("p3", "s4", 1, "cv-late.jpg");
    expect(firstPlayableCoverRef("p3", 1)).toBeNull();
    expect(firstPlayableCoverRef("p3", 8)).toBe("cv-late.jpg");
  });

  it("歌单为空 → null", () => {
    seedPlaylist("p4", "qq");
    expect(firstPlayableCoverRef("p4")).toBeNull();
    expect(listPlayableCoverRefs("p4")).toEqual([]);
  });
});

describe("封面快照独立于候选池(P0-3b 回归点)", () => {
  it("dropPlatformPool(空闲回收)不清快照:封面文件消失后仍返回原 ref", () => {
    writeCover("pl-p-keep.jpg");
    seedPlaylist("p-keep", "qq", { coverArt: "pl-p-keep.jpg" });

    const first = bySource(recommendLocalPlatforms().channels);
    expect(first.qq.playlists[0].coverArt).toBe("pl-p-keep");

    // 删掉封面文件 + 清文件解析缓存:若封面被重新计算,结果必然是 null。
    fs.rmSync(path.join(coversDir(), "pl-p-keep.jpg"));
    clearCoverResolveCache();
    dropPlatformPool(); // 空闲内存回收(旧实现会连带清掉 coverMemo → 此断言必红)

    const second = bySource(recommendLocalPlatforms().channels);
    expect(second.qq.playlists[0].coverArt).toBe("pl-p-keep");
  });

  it("同一歌单多次请求封面稳定(走快照,不是每次随机抽歌内封面)", () => {
    writeCover("cv-a.jpg");
    writeCover("cv-b.jpg");
    seedPlaylist("p-random", "qq");
    seedSong("p-random", "s1", 0, "cv-a.jpg");
    seedSong("p-random", "s2", 1, "cv-b.jpg");

    const refs = new Set<string>();
    for (let i = 0; i < 12; i++) {
      dropPlatformPool(); // 每次重建池,模拟 TTL 过期
      refs.add(bySource(recommendLocalPlatforms().channels).qq.playlists[0].coverArt);
    }
    expect(refs.size).toBe(1); // 旧实现每次洗牌 + 随机抽,会散成两个值
  });

  it("快照落库后「进程重启」可直接复用,不再探测封面文件", () => {
    seedPlaylist("p-restart", "qq", { coverArt: "gone.jpg" }); // 文件并不存在
    writeSnapshot({ "p-restart": ["pl-p-restart", Date.now()] });
    clearCoverSnapshot(false); // 只清内存 = 模拟进程重启、库里的快照还在
    dropPlatformPool();

    const ch = bySource(recommendLocalPlatforms().channels);
    expect(ch.qq.playlists[0].coverArt).toBe("pl-p-restart");
  });

  it("快照过期(>30min)仍用旧值服务请求,不回退占位符", () => {
    seedPlaylist("p-stale", "qq");
    writeSnapshot({ "p-stale": ["pl-p-stale", Date.now() - 31 * 60_000] });
    clearCoverSnapshot(false);
    dropPlatformPool();

    const ch = bySource(recommendLocalPlatforms().channels);
    expect(ch.qq.playlists[0].coverArt).toBe("pl-p-stale");
  });

  it("封面解算结果会写入快照(下一轮不再依赖文件系统)", () => {
    writeCover("cv-persist.jpg");
    seedPlaylist("p-persist", "qq");
    seedSong("p-persist", "s1", 0, "cv-persist.jpg");

    expect(bySource(recommendLocalPlatforms().channels).qq.playlists[0].coverArt).toBe(
      "cv-persist.jpg",
    );
    // 落盘是 3s 去抖,这里直接验证内存快照已建立:清文件 + 清解析缓存 + 重建池仍不变。
    fs.rmSync(path.join(coversDir(), "cv-persist.jpg"));
    clearCoverResolveCache();
    dropPlatformPool();
    expect(bySource(recommendLocalPlatforms().channels).qq.playlists[0].coverArt).toBe(
      "cv-persist.jpg",
    );
  });
});

describe("封面快照落盘去抖", () => {
  it("落盘后 settings 里出现快照行,内容为 [ref, ts] 紧凑格式", () => {
    vi.useFakeTimers();
    try {
      writeCover("pl-p-save.jpg");
      seedPlaylist("p-save", "qq", { coverArt: "pl-p-save.jpg" });
      recommendLocalPlatforms(); // 写入内存快照 + 排一个 3s 落盘定时器
      vi.advanceTimersByTime(3_100);

      const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(SNAPSHOT_KEY) as
        | { value: string }
        | undefined;
      expect(row).toBeTruthy();
      const parsed = JSON.parse(row!.value) as Record<string, [string | null, number]>;
      expect(Array.isArray(parsed["p-save"])).toBe(true);
      expect(parsed["p-save"][0]).toBe("pl-p-save");
      expect(typeof parsed["p-save"][1]).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });
});
