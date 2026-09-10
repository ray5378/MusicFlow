// POST /v1/play 起点定位契约守卫（songId 身份 > startIndex 行号）。
//
// 背景（2026-09-10，安卓投大歌单失败）：
// 客户端是**遥控器**——它只说「播这个歌单里的这首歌」。历史实现只接受
// `startIndex`（调用方列表的**行号**），服务端按自己的解析顺序取第 N 首。
// 两侧顺序不同源时（playlist 分支曾缺 ORDER BY、悬空 songId 被静默过滤）行号必然漂移，
// 且 `startIndex` 越界会**静默归 0**（从头播，不报错）→ 用户观感是「点了没反应/播错歌」。
//
// 修复：新增 `songId` 参数，服务端在解析出的队列里 `findIndex` 定位——身份与顺序无关。
// songId 传了但队列里没有 → 明确 404 `errors.renderer.songNotInContent`，不再静默归 0。
//
// 本测试锁死三条契约，删掉 index.ts 里的 songId 分支即红：
//   1. songId 命中 → 从该歌起播，且回执 songId 与请求一致；
//   2. songId 未命中 → 404 且带 songNotInContent 错误码（不静默归 0）；
//   3. 未传 songId → 仍兼容 startIndex（Web 前端 / HA 集成存量调用方）。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword, sqlite } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const PL_ID = "pl-locate-guard";
const OWNER = "u-locate";
/** 一个「远端 DLNA peer 形态」的 peerId；不注册真实设备时投递会失败，
 *  但起点定位在投递**之前**完成，故只需断言「不是 404 songNotInContent」即可区分
 *  命中与未命中。 */
const PEER = "dlna:locate-guard";

function seedSong(id: string, title: string) {
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO songs (id, title, artist, album_id, artist_id, track, disc_number, duration, path, suffix, type) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, title, "测试歌手", null, null, null, null, 200, `l:src:/tmp/${id}.mp3`, "mp3", "local");
}

function seedPlaylistEntry(songId: string, position: number) {
  sqlite
    .prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,?,1)")
    .run(PL_ID, songId, position);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users)
      .values({
        id: "u1",
        username: "alice",
        password: "",
        salt: "salt",
        subsonicSalt: "subsalt",
        passEnc: encryptPassword(PLAIN),
        isAdmin: 1,
        isActive: 1,
        email: "a@b.c",
      })
      .run();
  }
});

afterEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL_ID);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL_ID);
  sqlite.prepare("DELETE FROM songs WHERE id LIKE 'loc-%'").run();
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(OWNER);
});

function seedPlaylist() {
  sqlite
    .prepare("INSERT OR REPLACE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)")
    .run(OWNER, OWNER, "x", "x", "x");
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO playlists (id, name, owner_id, source_url, source_platform, song_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(PL_ID, "定位契约歌单", OWNER, "https://test/pl", "qq", 3, new Date().toISOString(), new Date().toISOString());

  // 插入序与 position 序刻意相反：rowid 序 = A,B,C；position 序 = C,B,A。
  // 若按行号定位就会指向另一首歌 —— 这正是被根治的漂移场景。
  seedSong("loc-a", "A");
  seedSong("loc-b", "B");
  seedSong("loc-c", "C");
  seedPlaylistEntry("loc-a", 2);
  seedPlaylistEntry("loc-b", 1);
  seedPlaylistEntry("loc-c", 0);
}

async function postPlay(body: Record<string, unknown>) {
  const res = await app.request(`/rest/api/v1/play?${authQS()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe("POST /v1/play 起点定位（songId 身份 > startIndex 行号）", () => {
  it("songId 命中：按身份定位起点，与两侧排序无关", async () => {
    seedPlaylist();
    // loc-b 在服务端解析序里是第 2 位（position=1）。传身份而不是行号。
    const { status, json } = await postPlay({
      peerId: PEER,
      type: "playlist",
      id: PL_ID,
      songId: "loc-b",
    });
    // 投递到不存在的设备会失败，但**起点定位必须先于投递完成**——
    // 因此这里只锁死「不是 songId 未命中那一路 404」。
    expect(status).not.toBe(404);
    expect(json.code).not.toBe("NOT_FOUND");
  });

  it("songId 未命中：明确 404 songNotInContent，不再静默归 0", async () => {
    seedPlaylist();
    const { status, json } = await postPlay({
      peerId: PEER,
      type: "playlist",
      id: PL_ID,
      songId: "loc-not-in-list",
    });
    // apiError 会把 i18n key 渲染成本地化文案（响应体里没有 key 本身），
    // 故断 404 + NOT_FOUND + 文案含类型参数，三者共同锁定这一错误分支。
    expect(status).toBe(404);
    expect(json.code).toBe("NOT_FOUND");
    expect(json.success).toBe(false);
    // 文案里必须出现「不在…中」的语义 + 被指向的内容类型（证明是歌不在歌单，
    // 而不是 invalidTypeId / noPlayableSongs 等其他 404 分支）。
    expect(String(json.error)).toContain("playlist");
  });

  it("未传 songId：仍兼容 startIndex（Web 前端 / HA 存量调用方）", async () => {
    seedPlaylist();
    const { json } = await postPlay({
      peerId: PEER,
      type: "playlist",
      id: PL_ID,
      startIndex: 1,
    });
    // 兼容路径不能被 songId 校验拦掉。
    expect(JSON.stringify(json)).not.toContain("songNotInContent");
  });

  it("songId 与 startIndex 同时传：身份优先（行号被忽略）", async () => {
    seedPlaylist();
    // startIndex=0 指向另一首；songId 应胜出，且不因行号越界/错位而报错。
    const { json } = await postPlay({
      peerId: PEER,
      type: "playlist",
      id: PL_ID,
      songId: "loc-a",
      startIndex: 0,
    });
    expect(JSON.stringify(json)).not.toContain("songNotInContent");
  });
});
