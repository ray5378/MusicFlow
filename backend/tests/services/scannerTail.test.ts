// 覆盖率长尾补充:services/source/scanner.ts 的残余分支。
//   - fetchWithRetry:429/5xx 重试(45-47)、网络异常重试(51-53)、重试耗尽后抛出(55)
//   - 非 aborted 的 AbortSignal 注册 abort 监听(213-214)
//   - buildTagsJson:common.lyrics 为 **字符串数组** 时的 textLength 形态(521)
//   - saveCoverArt 成功写入与写入失败回退 null(556 / 564-566)
//   - extractMetadataLocal:mp3 无 duration 时按码率估算(599-600)、解析抛错回落文件名(615-623)
//   - findOrCreateAlbum 给**存量无封面专辑**补写封面(654-656)
//   - resolveLocalGroup:SQL 抛错时的兜底(687-688)
// music-metadata 整体替身(可控返回),WebDAV 走 global.fetch 桩,不真联网。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { db, sqlite } from "../../src/db/index.js";
import { songs, albums, artists } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const H = vi.hoisted(() => ({
  parse: async (_b: any, _o: any) => ({ common: {}, format: {}, native: {} }) as any,
}));

vi.mock("music-metadata", () => ({
  parseBuffer: (b: any, o: any) => H.parse(b, o),
}));

import { scanWebDAVSource, scanLocalSource, upsertSong, extractMetadataHeader, resolveLocalGroup } from "../../src/services/source/scanner.js";

// ---------- WebDAV fetch 桩 ----------
type FakeResp = { ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> };

function textResp(body: string, status = 207): FakeResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}
function binResp(buf: Buffer, status = 206): FakeResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}
function propfindXml(items: { href: string; collection?: boolean; size?: number }[]): string {
  const blocks = items
    .map((e) =>
      e.collection
        ? `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`
        : `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>${e.size ?? 0}</D:getcontentlength></D:prop></D:propstat></D:response>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${blocks}</D:multistatus>`;
}

const BASE = "http://dav.local/music";
/** 一份「有标签」的解析结果:complete ⇒ 不触发分级升档。 */
const RICH = { common: { title: "Rich", artist: "A", album: "AL" }, format: { duration: 12, bitrate: 128000 }, native: {} };

let tmpRoot = "";
beforeEach(() => {
  H.parse = async () => RICH as any;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scan-tail-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("scanner: fetchWithRetry 重试与抛出", () => {
  it("取头遇 5xx 会重试,成功后正常入库(45-47)", async () => {
    let getCalls = 0;
    vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
      if (init.method === "PROPFIND") {
        return textResp(propfindXml([{ href: "/music/", collection: true }, { href: "/music/retry.mp3", size: 3 }]), 207);
      }
      getCalls += 1;
      // 前两次 500(触发重试),第三次成功 —— 断言重试真的发生且最终救回来。
      if (getCalls <= 2) return textResp("boom", 500);
      return binResp(Buffer.from([1, 2, 3]), 206);
    });

    const res = await scanWebDAVSource("tail-w-retry", { url: BASE }, "full");
    expect(res.added).toBe(1);
    expect(getCalls).toBe(3);
  }, 20_000);

  it("网络异常重试耗尽 → 抛错被 processFile 收口为 failed(51-53 / 55)", async () => {
    let getCalls = 0;
    vi.stubGlobal("fetch", async (_url: any, init: any = {}) => {
      if (init.method === "PROPFIND") {
        return textResp(propfindXml([{ href: "/music/", collection: true }, { href: "/music/throw.mp3", size: 3 }]), 207);
      }
      getCalls += 1;
      throw new Error("ECONNRESET");
    });

    const res = await scanWebDAVSource("tail-w-throw", { url: BASE }, "full");
    expect(res.failed).toBe(1);
    expect(res.added).toBe(0);
    // 初次 + MAX_RETRIES(3) = 4 次尝试后才抛出。
    expect(getCalls).toBe(4);
  }, 30_000);

  it("传入未 abort 的 signal → 注册 abort 监听并正常完成(213-214)", async () => {
    vi.stubGlobal("fetch", async (_url: any, init: any = {}) => {
      if (init.method === "PROPFIND") {
        return textResp(propfindXml([{ href: "/music/", collection: true }, { href: "/music/sig.mp3", size: 3 }]), 207);
      }
      return binResp(Buffer.from([1, 2, 3]), 206);
    });

    const ac = new AbortController();
    const res = await scanWebDAVSource("tail-w-sig", { url: BASE }, "full", undefined, ac.signal);
    expect(res.added).toBe(1);
    // 未 abort ⇒ 不能返回 aborted(信号只是被挂上监听等后续取消)。
    expect((res as any).aborted).toBeUndefined();
  });
});

describe("scanner: buildTagsJson 的歌词形态", () => {
  it("common.lyrics 为字符串数组 → 只留 textLength(521)", async () => {
    H.parse = async () =>
      ({
        common: { lyrics: ["[00:01.00] a plain lyric line", { text: "timed body", contentType: "text/plain" }] },
        format: { duration: 5 },
        native: {},
      }) as any;

    const meta = await extractMetadataHeader(Buffer.from("x"), "l.mp3", 10);
    const tags = JSON.parse(meta.tags!);
    // 歌词正文不落库,只留长度 —— 字符串与对象两种形态都要归一。
    expect(tags.lyrics[0]).toEqual({ textLength: "[00:01.00] a plain lyric line".length });
    expect(tags.lyrics[1]).toMatchObject({ contentType: "text/plain", textLength: "timed body".length });
  });
});

describe("scanner: saveCoverArt", () => {
  it("新专辑带内嵌封面 → 写出 covers/<albumId>.<ext> 并在 songs.cover_art 关联", async () => {
    const meta: any = {
      title: "Pic", artist: "TailPicArtist", album: "Tail Album Pic", duration: 1, bitRate: 1,
      genre: "", year: 0, track: 0, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 1,
      albumArtist: "", composer: "", comment: "", picture: { format: "image/png", data: Buffer.from("png-bytes") },
    };
    expect(upsertSong("l:tailpic:/a.mp3", meta, "tailpic")).toBe("added");

    const alb = db.select().from(albums).where(eq(albums.name, "Tail Album Pic")).get() as any;
    expect(alb?.coverArt).toMatch(/\.png$/);
    const file = path.join(process.env.DATA_DIR as string, "covers", alb.coverArt);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("写封面落盘失败 → 吞掉异常、返回 null(封面缺失不阻断入库)(564-566)", async () => {
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    const meta: any = {
      title: "PicFail", artist: "TailPicArtist", album: "Tail Album Pic Fail", duration: 1, bitRate: 1,
      genre: "", year: 0, track: 0, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 1,
      albumArtist: "", composer: "", comment: "", picture: { format: "image/jpeg", data: Buffer.from([1, 2, 3]) },
    };
    let r: string | undefined;
    try {
      r = upsertSong("l:tailpicf:/a.mp3", meta, "tailpicf");
    } finally {
      spy.mockRestore();
    }
    expect(r).toBe("added"); // 入库照常成功
    const alb = db.select().from(albums).where(eq(albums.name, "Tail Album Pic Fail")).get() as any;
    expect(alb?.coverArt).toBeNull(); // 封面写失败 ⇒ 引用为空,不是死引用
  });

  it("存量专辑缺封面 → 扫描时补写封面(654-656)", async () => {
    const now = new Date().toISOString();
    db.insert(artists).values({ id: "art-tail-bf", name: "TailPicArtist", albumCount: 0, createdAt: now, updatedAt: now }).run();
    db.insert(albums)
      .values({ id: "alb-tail-bf", name: "Tail Album Backfill", artistId: "art-tail-bf", artist: "TailPicArtist", year: 0, genre: "", coverArt: null, songCount: 0, duration: 0, createdAt: now, updatedAt: now })
      .run();

    const meta: any = {
      title: "BF", artist: "TailPicArtist", album: "Tail Album Backfill", duration: 1, bitRate: 1,
      genre: "", year: 0, track: 0, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 1,
      albumArtist: "", composer: "", comment: "", picture: { format: "image/jpeg", data: Buffer.from([9, 9]) },
    };
    upsertSong("l:tailbf:/a.mp3", meta, "tailbf");

    const alb = db.select().from(albums).where(eq(albums.id, "alb-tail-bf")).get() as any;
    expect(alb?.coverArt).toMatch(/^alb-tail-bf\.jpg$/);
  });
});

describe("scanner: scanLocalSource 元数据边界", () => {
  it("mp3 无 duration 但有码率 → 按文件大小估算(599-600)", async () => {
    const file = path.join(tmpRoot, "estimate.mp3");
    fs.writeFileSync(file, Buffer.alloc(200_000));
    // duration=0 + bitrate=128000bps(→128kbps) ⇒ duration = size*8/(128*1000)。
    H.parse = async () => ({ common: {}, format: { duration: 0, bitrate: 128000 }, native: {} }) as any;

    const res = await scanLocalSource("tail-l-est", { path: tmpRoot }, "full");
    expect(res.added).toBe(1);
    const row = sqlite.prepare("SELECT duration FROM songs WHERE path LIKE 'l:tail-l-est:%'").get() as any;
    expect(row.duration).toBe(Math.round((200_000 * 8) / (128 * 1000)));
  });

  it("解析抛错 → 回落「歌手 - 标题」文件名推断(615-623)", async () => {
    const file = path.join(tmpRoot, "Some Artist - Some Title.mp3");
    fs.writeFileSync(file, Buffer.alloc(64));
    H.parse = async () => {
      throw new Error("corrupt container");
    };

    const res = await scanLocalSource("tail-l-fb", { path: tmpRoot }, "full");
    expect(res.added).toBe(1);
    const row = sqlite.prepare("SELECT title, artist, duration FROM songs WHERE path LIKE 'l:tail-l-fb:%'").get() as any;
    expect(row.title).toBe("Some Title");
    expect(row.artist).toBe("Some Artist");
    expect(row.duration).toBe(0);
  });
});

describe("scanner: resolveLocalGroup 兜底", () => {
  it("归组 SQL 抛错 → 仍返回一个新组(NOT NULL 约束不被破坏)(687-688)", () => {
    // 只让「候选组查询」这条 SQL 抛错:groupKeyForConfig 内部也会用 sqlite.prepare
    // 读插件配置,若一并拦掉就会在 try 之外抛出,测不到兜底分支。
    const realPrepare = sqlite.prepare.bind(sqlite);
    const spy = vi.spyOn(sqlite, "prepare").mockImplementation(((sql: any) => {
      if (String(sql).includes("group_key = ?")) throw new Error("db locked");
      return realPrepare(sql);
    }) as any);
    let r: any;
    try {
      r = resolveLocalGroup({ title: "Tail Group", artist: "Tail GA", album: "Tail GAL", duration: 10 } as any);
    } finally {
      spy.mockRestore();
    }
    expect(r).not.toBeNull();
    expect(typeof r.groupId).toBe("string");
    expect(r.groupId.length).toBeGreaterThan(0);
  });
});
