// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { db, initDatabase } from "../../src/db/index.js";
import { users, songs, albums, artists } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  getDlnaBaseUrl,
  serializeDlnaDevices,
  sendspinServerOr404,
  localShuffleInfo,
  readPeerPositionSeconds,
  seekPeerToSeconds,
  dispatchPeerCommand,
  broadcastSendspinVolume,
  setSendspinMemberMuted,
  tryArmSendspinBorrow,
  borrowLandingConfirmed,
  detachFromActiveGroups,
  alignGroupMembers,
  isBuiltinRow,
  isCoreRow,
  deleteSongDb,
  idToCoverArt,
  albumCoverRef,
  genreIdFor,
  buildArtistList,
  normalizePlaylistName,
  assertKeyAccess,
} from "../../src/routes/api/shared.js";
import { getPeerManager } from "../../src/services/peer.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "s", subsonicSalt: "ss", passEnc: "", isAdmin: 1, isActive: 1 }).run();
});

describe("shared: 基础工具", () => {
  it("normalizePlaylistName 去空白/省略号/小写", () => {
    expect(normalizePlaylistName("  精选…  ")).toBe("精选");
    expect(normalizePlaylistName(null)).toBe("");
  });

  it("assertKeyAccess:本人或管理员放行,他人拒绝", () => {
    const mk = (user: any) => ({ get: () => user }) as any;
    // 返回的是 `id === user.id || user.isAdmin` 的原始值(0/1 或 boolean),只判真假。
    expect(assertKeyAccess(mk({ id: "u1", isAdmin: 0 }), "u1")).toBeTruthy();
    expect(assertKeyAccess(mk({ id: "u2", isAdmin: 0 }), "u1")).toBeFalsy();
    expect(assertKeyAccess(mk({ id: "u9", isAdmin: 1 }), "u1")).toBeTruthy();
  });

  it("isBuiltinRow / isCoreRow 按 manifest 判定", () => {
    expect(isBuiltinRow({ id: "definitely-not-builtin" })).toBe(false);
    expect(isCoreRow({ name: "definitely-not-a-plugin" })).toBe(false);
    // manifest 非法 JSON 走 catch 分支 → 空对象 → 非 core
    expect(isCoreRow({ name: "x", manifest: "{not json" })).toBe(false);
  });
});

describe("shared: DLNA 基础地址", () => {
  it("有 DLNA_BASE_URL 环境变量时直接复用并去尾斜杠", () => {
    const prev = process.env.DLNA_BASE_URL;
    process.env.DLNA_BASE_URL = "http://192.168.10.9:9999/";
    try {
      expect(getDlnaBaseUrl({ req: { header: () => "example.com:443" } })).toBe("http://192.168.10.9:9999");
    } finally {
      if (prev === undefined) delete process.env.DLNA_BASE_URL;
      else process.env.DLNA_BASE_URL = prev;
    }
  });

  it("无环境变量 + 私有 IP host → 直连复用 host", () => {
    const prev = process.env.DLNA_BASE_URL;
    delete process.env.DLNA_BASE_URL;
    const prevPort = process.env.PORT;
    process.env.PORT = "46400";
    try {
      expect(getDlnaBaseUrl({ req: { header: () => "192.168.10.240:46400" } })).toBe("http://192.168.10.240:46400");
    } finally {
      if (prev !== undefined) process.env.DLNA_BASE_URL = prev;
      if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
    }
  });

  it("无环境变量 + 公网域名 host → 不用域名,回退自动探测的 LAN 地址", () => {
    const prev = process.env.DLNA_BASE_URL;
    delete process.env.DLNA_BASE_URL;
    try {
      const u = getDlnaBaseUrl({ req: { header: () => "music.example.com:443" } });
      expect(u.startsWith("http://")).toBe(true);
      expect(u).not.toContain("music.example.com");
    } finally {
      if (prev !== undefined) process.env.DLNA_BASE_URL = prev;
    }
  });

  it("serializeDlnaDevices 输出对外字段形态", () => {
    const out = serializeDlnaDevices([
      { id: "d1", name: "N", alias: "主卧", manufacturer: "M", model: "X", renderingControlUrl: "http://x", available: true, disabled: false } as any,
      { id: "d2", name: "N2", alias: "", available: false } as any,
    ]);
    expect(out[0]).toMatchObject({ id: "d1", displayName: "主卧", hasVolumeControl: true, disabled: false });
    expect(out[1]).toMatchObject({ id: "d2", displayName: "N2", hasVolumeControl: false });
  });

  it("sendspinServerOr404 服务未起时返回 null", () => {
    expect(sendspinServerOr404({})).toBeNull();
  });
});

describe("shared: 队列/进度工具", () => {
  it("localShuffleInfo 空快照给出安全缺省", () => {
    expect(localShuffleInfo(null)).toEqual({
      currentIndex: -1, playMode: "order", isActive: false,
      shuffleOrder: [], shufflePos: -1, shuffleEpoch: 0,
    });
    expect(localShuffleInfo({ currentIndex: 2, shuffleOrder: [1, 0], shufflePos: 1, shuffleEpoch: 3, isActive: true, playMode: "shuffle" }))
      .toMatchObject({ currentIndex: 2, shufflePos: 1, shuffleEpoch: 3, isActive: true, playMode: "shuffle" });
  });

  it("readPeerPositionSeconds:无法解析的 peerId → null", async () => {
    await expect(readPeerPositionSeconds("nonsense")).resolves.toBeNull();
  });

  it("readPeerPositionSeconds:local 取客户端上报的进度", async () => {
    const pm = getPeerManager();
    pm.reportLocalStatus("local:u1:wp1", { state: "PLAYING", position: 12.5, duration: 100 });
    await expect(readPeerPositionSeconds("local:u1:wp1")).resolves.toBe(12.5);
  });

  it("seekPeerToSeconds:非法秒数/无法解析 → false", async () => {
    await expect(seekPeerToSeconds("nonsense", 10)).resolves.toBe(false);
    await expect(seekPeerToSeconds("local:u1:wp1", 0)).resolves.toBe(false);
    await expect(seekPeerToSeconds("local:u1:wp1", Number.NaN)).resolves.toBe(false);
  });

  it("seekPeerToSeconds:local 走指令下发(无客户端连接也判定成功)", async () => {
    await expect(seekPeerToSeconds("local:u1:wp1", 30)).resolves.toBe(true);
  });

  it("dispatchPeerCommand:未知 peer 下发 0 条连通连接", () => {
    expect(dispatchPeerCommand("nonsense", "seek", { seconds: 1 })).toEqual({ success: true, delivered: false });
  });

  it("borrowLandingConfirmed:落点为空/非正 → false", async () => {
    await expect(borrowLandingConfirmed("local:u1:wp1", null)).resolves.toBe(false);
    await expect(borrowLandingConfirmed("local:u1:wp1", 0)).resolves.toBe(false);
  });

  it("tryArmSendspinBorrow:非 sendspin 两端 → 未武装", async () => {
    await expect(tryArmSendspinBorrow("dlna:d1", "local:u1:web", 5)).resolves.toEqual({
      armed: false, positionSeconds: null, songId: null,
    });
  });

  it("detachFromActiveGroups:非设备型 kind → 直接返回", async () => {
    await expect(detachFromActiveGroups({ kind: "local", id: "u1:wp1" })).resolves.toBeUndefined();
    await expect(detachFromActiveGroups({ kind: "group", id: "g1" })).resolves.toBeUndefined();
  });

  it("alignGroupMembers:空增删为 no-op", async () => {
    await expect(alignGroupMembers("no-such-group", [], [])).resolves.toBeUndefined();
  });

  it("alignGroupMembers:sendspin 成员加入/摘除在服务未起时被吞掉", async () => {
    // sendspinGroupJoin/Leave 会抛「服务未运行」,期望内部 catch 后正常返回。
    await expect(alignGroupMembers("no-such-group", ["sendspin:c1"], ["sendspin:c2"])).resolves.toBeUndefined();
  });

  it("broadcastSendspinVolume:非 sendspin peerId → 静默 no-op", () => {
    expect(() => broadcastSendspinVolume("dlna:d1", { volume: 12 })).not.toThrow();
    expect(() => broadcastSendspinVolume("nonsense", { volume: 12 })).not.toThrow();
  });

  it("setSendspinMemberMuted:服务未起 → 抛错", async () => {
    await expect(setSendspinMemberMuted("c1", true)).rejects.toThrow();
  });
});

describe("shared: 曲库工具", () => {
  it("genreIdFor 已存在走查表,不存在则补建", () => {
    const existing = genreIdFor("Rock");
    expect(existing).toBeTruthy();
    expect(genreIdFor("Rock")).toBe(existing);
    const fresh = genreIdFor("Vaporwave-" + Date.now());
    expect(fresh).toBeTruthy();
  });

  it("idToCoverArt / albumCoverRef 处理封面回退", () => {
    db.insert(albums).values({ id: "al-cov", name: "A", coverArt: "covers/al.jpg" }).run();
    db.insert(albums).values({ id: "al-nocov", name: "B" }).run();
    db.insert(songs).values({ id: "s-cov", title: "T", albumId: "al-nocov", coverArt: "covers/s.jpg", path: "l:src:/x.mp3" }).run();
    expect(idToCoverArt(null, "al")).toBeUndefined();
    expect(idToCoverArt("al-cov", "al")).toBe("al-al-cov");
    expect(idToCoverArt("al-nocov", "al")).toBeUndefined();
    expect(albumCoverRef({ id: "al-cov", coverArt: "covers/al.jpg" })).toBe("al-al-cov");
    // 专辑行无封面 → 回退到首张带封面的曲目
    expect(albumCoverRef({ id: "al-nocov" })).toBe("so-s-cov");
    expect(albumCoverRef({ id: "al-missing" })).toBeUndefined();
  });

  it("deleteSongDb:删除曲目并清关联,未知 id 返回 false", () => {
    db.insert(songs).values({ id: "s-del", title: "D", path: "l:src:/d.mp3" }).run();
    expect(deleteSongDb("s-del")).toBe(true);
    expect(db.select().from(songs).where(eq(songs.id, "s-del")).get()).toBeUndefined();
    expect(deleteSongDb("s-del")).toBe(false);
  });

  it("buildArtistList:带 query 走模糊匹配,不带则全量并按名排序", () => {
    db.insert(artists).values({ id: "ar-z", name: "Zeta" }).run();
    db.insert(artists).values({ id: "ar-a", name: "Alpha" }).run();
    const all = buildArtistList("k-all", "");
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((a) => a.name)).toEqual([...all.map((a) => a.name)].sort((x, y) => x.localeCompare(y)));
    const q = buildArtistList("k-q", "Alph");
    expect(q.some((a) => a.name === "Alpha")).toBe(true);
    expect(q.some((a) => a.name === "Zeta")).toBe(false);
  });
});
