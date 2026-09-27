// 封面存储解析层(services/playlistCover.ts)的完整面。
//
// 既有 tests/services/coverDedup.test.ts 只走 importOnlineSongs → copyOnlineCoverToRef
// 这一条端到端路径。本文件把**存储与解析本身**照住:
//   ① resolveCoverFile 的双目录探测(平台封面优先 → 本地 legacy 兜底)、
//      **目录内校验**(拒绝 ../ 与绝对路径,堵死经 getCoverArt 裸 id 的任意文件读取)、
//      进程内解析缓存(命中不回源、写后失效、容量上限 2000 逐出);
//   ② cacheRemoteCover 的 TTL / force / 非 http / 非 200 / 过小响应 / 网络异常;
//   ③ 拷贝与删除:copyCoverToFile / copyOnlineCoverToRef / deleteSongCover /
//      clearPlaylistCoverCache;
//   ④ 封面源图 id 锁(playlist_cover_claims):syncCoverClaim / pickDailyRotatedCover
//      的按天轮换、TTL 清理、被其它歌单占用时**返回 null 而不是撞车**;
//   ⑤ getPlaylistCover 的扩展名门控与 mime 映射。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { getDataDir } from "../../src/utils/env.js";
import {
  platformCoverPath,
  resolveCoverFile,
  invalidateCoverResolve,
  copyOnlineCoverToRef,
  clearCoverResolveCache,
  cacheRemoteCover,
  copyCoverToFile,
  deleteSongCover,
  clearPlaylistCoverCache,
  listPlayableCoverRefs,
  firstPlayableCoverFile,
  resetDailyCoverClaims,
  syncCoverClaim,
  pickDailyRotatedCover,
  getPlaylistCover,
} from "../../src/services/playlistCover.js";

const NOW = "2026-09-27T00:00:00.000Z";
const COVERS = () => path.join(getDataDir(), "covers");
const ONLINE = () => path.join(getDataDir(), "online-covers");
const BYTES = Buffer.from(Array(256).fill(0xaa));
const realFetch = globalThis.fetch;
let owner = "";

function write(dir: string, name: string, content: string | Buffer = "x") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function seedPlaylist(id: string, coverArt: string | null = null) {
  sqlite
    .prepare(
      "INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, created_at, updated_at) VALUES (?,?,?,1,'',?,?,?)",
    )
    .run(id, id, owner, coverArt, NOW, NOW);
}

function seedSong(id: string, opts: { coverArt?: string | null; albumId?: string | null } = {}) {
  sqlite
    .prepare(
      "INSERT INTO songs (id, title, artist, album, album_id, duration, path, suffix, type, cover_art, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, id, "A", "Al", opts.albumId ?? null, 100, `l:src:/tmp/${id}.mp3`, "mp3", "local", opts.coverArt ?? null, NOW);
}

function seedAlbum(id: string, coverArt: string | null) {
  sqlite.prepare("INSERT INTO albums (id, name, cover_art, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, id, coverArt, NOW, NOW);
}

function addPlaylistSong(playlistId: string, songId: string, position: number, playable = 1) {
  sqlite
    .prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,?,?)")
    .run(playlistId, songId, position, playable, NOW);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
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
  sqlite.prepare("DELETE FROM albums").run();
  sqlite.prepare("DELETE FROM playlist_cover_claims").run();
  clearCoverResolveCache();
  fs.rmSync(COVERS(), { recursive: true, force: true });
  fs.rmSync(ONLINE(), { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("resolveCoverFile:双目录探测 + 目录内校验 + 缓存", () => {
  it("平台封面目录优先于本地 legacy 目录", () => {
    write(ONLINE(), "a.jpg");
    write(COVERS(), "a.jpg");
    expect(resolveCoverFile("a.jpg")).toBe(path.join(ONLINE(), "a.jpg"));
  });

  it("平台目录没有时回落本地 legacy 目录(data/covers)", () => {
    write(COVERS(), "legacy.jpg");
    expect(resolveCoverFile("legacy.jpg")).toBe(path.join(COVERS(), "legacy.jpg"));
  });

  it("两个目录都没有 → null;空 ref → null", () => {
    expect(resolveCoverFile("nope.jpg")).toBeNull();
    expect(resolveCoverFile("")).toBeNull();
  });

  it("路径穿越被拒:../ 与绝对路径都不会被解析出去", () => {
    write(getDataDir(), "outside.jpg");
    expect(resolveCoverFile("../outside.jpg")).toBeNull();
    expect(resolveCoverFile("/etc/passwd")).toBeNull();
  });

  it("解析结果被缓存:文件在缓存后被删,仍然返回旧结果(直到 invalidate)", () => {
    write(ONLINE(), "c1.jpg");
    expect(resolveCoverFile("c1.jpg")).toBeTruthy();
    fs.unlinkSync(path.join(ONLINE(), "c1.jpg"));
    expect(resolveCoverFile("c1.jpg")).toBeTruthy(); // 命中缓存
    invalidateCoverResolve("c1.jpg");
    expect(resolveCoverFile("c1.jpg")).toBeNull(); // 缓存失效后才反映真实情况
  });

  it("miss 也进缓存(同一 ref 只探测一次)", () => {
    expect(resolveCoverFile("later.jpg")).toBeNull();
    write(ONLINE(), "later.jpg");
    expect(resolveCoverFile("later.jpg")).toBeNull(); // 仍命中 miss 缓存
    invalidateCoverResolve("later.jpg");
    expect(resolveCoverFile("later.jpg")).toBeTruthy();
  });

  it("缓存容量上限 2000:超出后逐出最老条目(不再无限增长)", () => {
    for (let i = 0; i < 2100; i++) resolveCoverFile(`bulk-${i}.jpg`);
    write(ONLINE(), "bulk-0.jpg");
    // 第 0 条已被逐出 → 重新探测能看见新文件
    expect(resolveCoverFile("bulk-0.jpg")).toBeTruthy();
    // 最后一条仍在缓存里
    expect(resolveCoverFile("bulk-2099.jpg")).toBeNull();
  });

  it("clearCoverResolveCache 清空全部条目", () => {
    write(ONLINE(), "d1.jpg");
    expect(resolveCoverFile("d1.jpg")).toBeTruthy();
    clearCoverResolveCache();
    fs.unlinkSync(path.join(ONLINE(), "d1.jpg"));
    expect(resolveCoverFile("d1.jpg")).toBeNull();
  });

  it("platformCoverPath 落在平台封面目录内(可独立挂卷)", () => {
    expect(platformCoverPath("x.jpg")).toBe(path.join(ONLINE(), "x.jpg"));
  });
});

describe("cacheRemoteCover:下载入库", () => {
  it("非 http(s) URL → 不下载直接 null", async () => {
    expect(await cacheRemoteCover("", "r1")).toBeNull();
    expect(await cacheRemoteCover("ftp://x/a.jpg", "r1")).toBeNull();
    expect(await cacheRemoteCover("/local/a.jpg", "r1")).toBeNull();
  });

  it(".png URL → 落 .png;否则落 .jpg", async () => {
    globalThis.fetch = (async () => ({ ok: true, arrayBuffer: async () => BYTES })) as any;
    expect(await cacheRemoteCover("https://e.com/a.png", "png1")).toBe("png1.png");
    expect(await cacheRemoteCover("https://e.com/a.jpg", "jpg1")).toBe("jpg1.jpg");
  });

  it("TTL 内已存在且 force=false → 直接复用,不再发起网络请求", async () => {
    write(ONLINE(), "cached.jpg");
    const f = vi.fn();
    globalThis.fetch = f as any;
    expect(await cacheRemoteCover("https://e.com/a.jpg", "cached")).toBe("cached.jpg");
    expect(f).not.toHaveBeenCalled();
  });

  it("force=true → 忽略 TTL 重新下载并覆盖", async () => {
    write(ONLINE(), "stale.jpg", Buffer.from("old"));
    const f = vi.fn(async () => ({ ok: true, arrayBuffer: async () => BYTES }));
    globalThis.fetch = f as any;
    expect(await cacheRemoteCover("https://e.com/a.jpg", "stale", true)).toBe("stale.jpg");
    expect(f).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(ONLINE(), "stale.jpg")).equals(BYTES)).toBe(true);
  });

  it("响应非 2xx → null,不写文件", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 404, arrayBuffer: async () => BYTES })) as any;
    expect(await cacheRemoteCover("https://e.com/a.jpg", "bad")).toBeNull();
    expect(fs.existsSync(path.join(ONLINE(), "bad.jpg"))).toBe(false);
  });

  it("响应体过小(<100 字节,通常是错误页)→ null,不写文件", async () => {
    globalThis.fetch = (async () => ({ ok: true, arrayBuffer: async () => Buffer.from("tiny") })) as any;
    expect(await cacheRemoteCover("https://e.com/a.jpg", "small")).toBeNull();
    expect(fs.existsSync(path.join(ONLINE(), "small.jpg"))).toBe(false);
  });

  it("网络异常 → null(不抛到调用方)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as any;
    expect(await cacheRemoteCover("https://e.com/a.jpg", "boom")).toBeNull();
  });

  it("写盘后解析缓存被失效(新下载立刻可见)", async () => {
    expect(resolveCoverFile("fresh.jpg")).toBeNull(); // 先占住 miss 缓存
    globalThis.fetch = (async () => ({ ok: true, arrayBuffer: async () => BYTES })) as any;
    expect(await cacheRemoteCover("https://e.com/a.jpg", "fresh")).toBe("fresh.jpg");
    expect(resolveCoverFile("fresh.jpg")).toBeTruthy();
  });
});

describe("拷贝与删除", () => {
  it("copyOnlineCoverToRef:源不存在 → null;成功则按目标歌 id + 同扩展名复制", () => {
    expect(copyOnlineCoverToRef("no-src.jpg", "destSong")).toBeNull();
    write(ONLINE(), "src.png", BYTES);
    expect(copyOnlineCoverToRef("src.png", "destSong")).toBe("destSong.png");
    expect(fs.readFileSync(path.join(ONLINE(), "destSong.png")).equals(BYTES)).toBe(true);
  });

  it("copyOnlineCoverToRef:源解析到的是目录(不是文件)→ 复制失败返回 null,不抛错", () => {
    fs.mkdirSync(path.join(ONLINE(), "dir-as-cover.jpg"), { recursive: true });
    expect(copyOnlineCoverToRef("dir-as-cover.jpg", "dest2")).toBeNull();
  });

  it("copyCoverToFile:空 src → null;源不存在 → null;成功写进**本地封面**目录", () => {
    expect(copyCoverToFile("d.jpg", "")).toBeNull();
    expect(copyCoverToFile("d.jpg", "missing.jpg")).toBeNull();
    write(ONLINE(), "srcAlbum.jpg", BYTES);
    expect(copyCoverToFile("pl-self.jpg", "srcAlbum.jpg")).toBe("pl-self.jpg");
    expect(fs.readFileSync(path.join(COVERS(), "pl-self.jpg")).equals(BYTES)).toBe(true);
  });

  it("deleteSongCover:空 id → 0;按 jpg/png/gif 在两个目录里清", () => {
    expect(deleteSongCover("")).toBe(0);
    write(ONLINE(), "sg.jpg");
    write(ONLINE(), "sg.png");
    write(COVERS(), "sg.gif");
    expect(deleteSongCover("sg")).toBe(3);
    expect(fs.existsSync(path.join(ONLINE(), "sg.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(COVERS(), "sg.gif"))).toBe(false);
    expect(deleteSongCover("sg")).toBe(0); // 已经没了
  });

  it("clearPlaylistCoverCache:删 pl-<id>.jpg 并把 playlists.cover_art 置空", () => {
    seedPlaylist("pl-c", "pl-pl-c.jpg");
    write(ONLINE(), "pl-pl-c.jpg");
    clearPlaylistCoverCache("pl-c");
    expect(fs.existsSync(path.join(ONLINE(), "pl-pl-c.jpg"))).toBe(false);
    expect((sqlite.prepare("SELECT cover_art FROM playlists WHERE id = ?").get("pl-c") as any).cover_art).toBeNull();
  });
});

describe("listPlayableCoverRefs / firstPlayableCoverFile", () => {
  it("按 position 顺序取可播条目中「真实存在」的封面,去重", () => {
    seedPlaylist("pl-1");
    write(ONLINE(), "cv-a.jpg");
    write(ONLINE(), "cv-b.jpg");
    seedSong("s1", { coverArt: "cv-a.jpg" });
    seedSong("s2", { coverArt: "cv-a.jpg" }); // 重复 → 去重
    seedSong("s3", { coverArt: "cv-b.jpg" });
    seedSong("s4", { coverArt: "ghost.jpg" }); // 文件不存在 → 跳过
    addPlaylistSong("pl-1", "s1", 0);
    addPlaylistSong("pl-1", "s2", 1);
    addPlaylistSong("pl-1", "s3", 2);
    addPlaylistSong("pl-1", "s4", 3);
    expect(listPlayableCoverRefs("pl-1")).toEqual(["cv-a.jpg", "cv-b.jpg"]);
  });

  it("歌曲自身无封面时回落所属专辑封面", () => {
    seedPlaylist("pl-2");
    write(ONLINE(), "al-1.jpg");
    seedAlbum("AL1", "al-1.jpg");
    seedSong("s1", { albumId: "AL1" });
    addPlaylistSong("pl-2", "s1", 0);
    expect(listPlayableCoverRefs("pl-2")).toEqual(["al-1.jpg"]);
  });

  it("不可播条目(playable=0)不参与", () => {
    seedPlaylist("pl-3");
    write(ONLINE(), "cv-x.jpg");
    seedSong("s1", { coverArt: "cv-x.jpg" });
    addPlaylistSong("pl-3", "s1", 0, 0);
    expect(listPlayableCoverRefs("pl-3")).toEqual([]);
  });

  it("preferSongId 指定的封面排最前(歌曲封面优先于专辑封面)", () => {
    seedPlaylist("pl-4");
    write(ONLINE(), "cv-p.jpg");
    write(ONLINE(), "cv-other.jpg");
    seedSong("s1", { coverArt: "cv-other.jpg" });
    seedSong("s9", { coverArt: "cv-p.jpg" });
    addPlaylistSong("pl-4", "s1", 0);
    expect(listPlayableCoverRefs("pl-4", { preferSongId: "s9" })).toEqual(["cv-p.jpg", "cv-other.jpg"]);

    // prefer 歌自身无封面但专辑有 → 用专辑封面领跑
    seedAlbum("AL9", "cv-other.jpg");
    seedSong("s8", { albumId: "AL9" });
    expect(listPlayableCoverRefs("pl-4", { preferSongId: "s8" })[0]).toBe("cv-other.jpg");
  });

  it("excludeRefs 把指定封面完全排除(供多卡封面互斥)", () => {
    seedPlaylist("pl-5");
    write(ONLINE(), "cv-1.jpg");
    write(ONLINE(), "cv-2.jpg");
    seedSong("s1", { coverArt: "cv-1.jpg" });
    seedSong("s2", { coverArt: "cv-2.jpg" });
    addPlaylistSong("pl-5", "s1", 0);
    addPlaylistSong("pl-5", "s2", 1);
    expect(listPlayableCoverRefs("pl-5", { excludeRefs: ["cv-1.jpg"] })).toEqual(["cv-2.jpg"]);
  });

  it("firstPlayableCoverFile 取首项;没有则 null", () => {
    seedPlaylist("pl-6");
    expect(firstPlayableCoverFile("pl-6")).toBeNull();
    write(ONLINE(), "cv-f.jpg");
    seedSong("s1", { coverArt: "cv-f.jpg" });
    addPlaylistSong("pl-6", "s1", 0);
    expect(firstPlayableCoverFile("pl-6")).toBe("cv-f.jpg");
  });
});

describe("封面源图锁:syncCoverClaim / pickDailyRotatedCover", () => {
  const refsOf = () =>
    sqlite.prepare("SELECT date_key, playlist_id, cover_ref FROM playlist_cover_claims ORDER BY playlist_id").all() as any[];

  it("syncCoverClaim:dateKey 为空 → 完全不动;有 ref 则记账;ref 为空只清自己", () => {
    syncCoverClaim("pl-a", "", "cv.jpg");
    expect(refsOf()).toEqual([]);

    syncCoverClaim("pl-a", "2026-09-27", "cv.jpg");
    expect(refsOf()).toEqual([{ date_key: "2026-09-27", playlist_id: "pl-a", cover_ref: "cv.jpg" }]);

    syncCoverClaim("pl-a", "2026-09-27", null);
    expect(refsOf()).toEqual([]);
  });

  it("resetDailyCoverClaims 清空锁表", () => {
    syncCoverClaim("pl-a", "2026-09-27", "cv.jpg");
    resetDailyCoverClaims();
    expect(refsOf()).toEqual([]);
  });

  it("候选全被其它歌单占用 → 返回 null,绝不撞车共用同一张源图", () => {
    seedPlaylist("pl-a");
    write(ONLINE(), "cv-only.jpg");
    seedSong("s1", { coverArt: "cv-only.jpg" });
    addPlaylistSong("pl-a", "s1", 0);
    syncCoverClaim("pl-other", "2026-09-27", "cv-only.jpg");
    expect(pickDailyRotatedCover("pl-a", { dateStr: "2026-09-27" })).toBeNull();
    expect(refsOf().some((r) => r.playlist_id === "pl-a")).toBe(false);
  });

  it("无可解析封面 → null,且不写锁", () => {
    seedPlaylist("pl-bare");
    expect(pickDailyRotatedCover("pl-bare", { dateStr: "2026-09-27" })).toBeNull();
    expect(refsOf()).toEqual([]);
  });

  it("选中后写入当天锁,并清掉超过 7 天的旧锁", () => {
    seedPlaylist("pl-b");
    write(ONLINE(), "cv-b.jpg");
    seedSong("s1", { coverArt: "cv-b.jpg" });
    addPlaylistSong("pl-b", "s1", 0);
    syncCoverClaim("pl-old", "2026-01-01", "cv-ancient.jpg");

    const picked = pickDailyRotatedCover("pl-b", { dateStr: "2026-09-27" });
    expect(picked).toBe("cv-b.jpg");
    const rows = refsOf();
    expect(rows.some((r) => r.playlist_id === "pl-b" && r.cover_ref === "cv-b.jpg")).toBe(true);
    expect(rows.some((r) => r.date_key === "2026-01-01")).toBe(false); // 过期锁被清
  });

  it("按天轮换:同一天结果固定;候选多张时不同日期取到不同源图", () => {
    seedPlaylist("pl-rot");
    write(ONLINE(), "cv-1.jpg");
    write(ONLINE(), "cv-2.jpg");
    write(ONLINE(), "cv-3.jpg");
    seedSong("s1", { coverArt: "cv-1.jpg" });
    seedSong("s2", { coverArt: "cv-2.jpg" });
    seedSong("s3", { coverArt: "cv-3.jpg" });
    addPlaylistSong("pl-rot", "s1", 0);
    addPlaylistSong("pl-rot", "s2", 1);
    addPlaylistSong("pl-rot", "s3", 2);

    const d1a = pickDailyRotatedCover("pl-rot", { dateStr: "2026-09-27" });
    // 已有当天锁 → 再取一次会更新锁,但同一天同一候选序列,结果不变
    const d1b = pickDailyRotatedCover("pl-rot", { dateStr: "2026-09-27" });
    expect(d1b).toBe(d1a);

    const seen = new Set<string | null>();
    for (let i = 0; i < 30; i++) {
      const day = new Date(Date.UTC(2026, 8, 27 + i)).toISOString().slice(0, 10);
      resetDailyCoverClaims();
      seen.add(pickDailyRotatedCover("pl-rot", { dateStr: day }));
    }
    expect(seen.size).toBeGreaterThan(1); // 跨天确实在轮换
  });

  it("不传 dateStr 时用系统当天(结果仍落在候选集合内)", () => {
    seedPlaylist("pl-now");
    write(ONLINE(), "cv-now.jpg");
    seedSong("s1", { coverArt: "cv-now.jpg" });
    addPlaylistSong("pl-now", "s1", 0);
    expect(pickDailyRotatedCover("pl-now")).toBe("cv-now.jpg");
  });

  it("excludeRefs 可额外禁用指定源图", () => {
    seedPlaylist("pl-ex");
    write(ONLINE(), "cv-ex1.jpg");
    write(ONLINE(), "cv-ex2.jpg");
    seedSong("s1", { coverArt: "cv-ex1.jpg" });
    seedSong("s2", { coverArt: "cv-ex2.jpg" });
    addPlaylistSong("pl-ex", "s1", 0);
    addPlaylistSong("pl-ex", "s2", 1);
    expect(pickDailyRotatedCover("pl-ex", { dateStr: "2026-09-27", excludeRefs: ["cv-ex1.jpg"] })).toBe("cv-ex2.jpg");
  });
});

describe("getPlaylistCover:扩展名门控与 mime", () => {
  it("歌单不存在 → null", () => {
    expect(getPlaylistCover("nope")).toBeNull();
  });

  it("cover_art 不是图片扩展名 / 文件缺失 → null(前端回落占位符)", () => {
    seedPlaylist("pl-nofile", "pl-pl-nofile.jpg");
    expect(getPlaylistCover("pl-nofile")).toBeNull();
    seedPlaylist("pl-weird", "just-a-word");
    write(ONLINE(), "just-a-word");
    expect(getPlaylistCover("pl-weird")).toBeNull();
  });

  it("按扩展名返回正确 mime(jpg / png / gif)", () => {
    seedPlaylist("pl-jpg", "c.jpg");
    seedPlaylist("pl-png", "c.png");
    seedPlaylist("pl-gif", "c.gif");
    write(ONLINE(), "c.jpg");
    write(ONLINE(), "c.png");
    write(ONLINE(), "c.gif");
    expect(getPlaylistCover("pl-jpg")).toEqual({ file: "c.jpg", mime: "image/jpeg" });
    expect(getPlaylistCover("pl-png")).toEqual({ file: "c.png", mime: "image/png" });
    expect(getPlaylistCover("pl-gif")).toEqual({ file: "c.gif", mime: "image/gif" });
  });
});
