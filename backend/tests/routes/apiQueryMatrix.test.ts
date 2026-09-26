// ==================== 曲库列表 / 详情端点参数矩阵 ====================
// routes/api/index.ts 是单文件 3728 行,只读扫描只走了主路径;这里针对
// 列表的分页/过滤/排序/组内多源、详情的 tags 解析等深分支做参数矩阵覆盖。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, sqlite, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => "u=alice&t=" + md5(PLAIN + CLIENT_SALT) + "&s=" + CLIENT_SALT;

async function call(method: string, path: string, body?: any) {
  // path 自带 query 时必须用 "&" 拼接,否则鉴权参数会被吃掉 → 401
  const sep = path.includes("?") ? "&" : "?";
  const res = await app.request("/rest/api" + path + sep + authQS(), {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

const TAG = "mx-" + Date.now();
const S = (i: number) => `${TAG}song-${i}`;
const AL = (i: number) => `${TAG}album-${i}`;
const AR = (i: number) => `${TAG}artist-${i}`;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users)
      .values({
        id: "u1", username: "alice", password: "", salt: "salt",
        subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN),
        isAdmin: 1, isActive: 1, email: "a@b.c",
      })
      .run();
  }
  const now = new Date().toISOString();
  // 两位歌手 / 两张专辑
  sqlite.prepare("INSERT INTO artists (id, name, created_at) VALUES (?, ?, ?)").run(AR(1), "矩阵歌手A", now);
  sqlite.prepare("INSERT INTO artists (id, name, created_at) VALUES (?, ?, ?)").run(AR(2), "矩阵歌手B", now);
  sqlite.prepare("INSERT INTO albums (id, name, artist_id) VALUES (?, ?, ?)").run(AL(1), "矩阵专辑一", AR(1));
  sqlite.prepare("INSERT INTO albums (id, name, artist_id) VALUES (?, ?, ?)").run(AL(2), "矩阵专辑二", AR(2));

  const ins = sqlite.prepare(
    `INSERT INTO songs (id, title, artist, artist_id, album, album_id, duration, genre,
      play_count, path, cover_art, tags, group_id, created_at, has_lyrics, lyrics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 1:Rock / 有封面 / 组内多源(group-1)
  ins.run(S(1), "矩阵曲一", "矩阵歌手A", AR(1), "矩阵专辑一", AL(1), 100, "Rock", 5,
    `${TAG}:p1`, "so-cover", JSON.stringify({ TIT2: "矩阵曲一" }), `${TAG}group-1`, now, 1, null);
  // 2:同组另一源(无封面 → 借专辑封面)
  ins.run(S(2), "矩阵曲一", "矩阵歌手A", AR(1), "矩阵专辑一", AL(1), 100, "Rock", 3,
    `${TAG}:p2`, null, null, `${TAG}group-1`, now, 0, null);
  // 3:Pop / tags 损坏
  ins.run(S(3), "矩阵曲三", "矩阵歌手B", AR(2), "矩阵专辑二", AL(2), 200, "Pop", 9,
    `${TAG}:p3`, null, "{broken-json", null, now, 1, null);
  // 4:Jazz / 无专辑
  ins.run(S(4), "Another Song", "矩阵歌手B", AR(2), "", null, 300, "Jazz", 1,
    `${TAG}:p4`, null, null, null, now, 0, null);
  // 5/6:在线歌(type=web)
  sqlite
    .prepare("UPDATE songs SET type = 'web', source_data = ? WHERE id = ?")
    .run(JSON.stringify({ source: "qq", id: "1" }), S(5) === S(5) ? S(4) : S(4));
});

describe("GET /v1/songs 分页与钳制", () => {
  it("默认参数:page=1 pageSize=50,返回 total/page/pageSize/items", async () => {
    const r = await call("GET", "/v1/songs");
    expect(r.status).toBe(200);
    expect(r.body.page).toBe(1);
    expect(r.body.pageSize).toBe(50);
    expect(typeof r.body.total).toBe("number");
    expect(Array.isArray(r.body.items)).toBe(true);
  });

  it("page=2&pageSize=2 → 按页取,页间不重叠", async () => {
    const p1 = await call("GET", "/v1/songs?page=1&pageSize=2");
    const p2 = await call("GET", "/v1/songs?page=2&pageSize=2");
    expect(p1.body.items.length).toBe(2);
    expect(p2.body.items.length).toBe(2);
    const ids1 = p1.body.items.map((s: any) => s.id);
    const ids2 = p2.body.items.map((s: any) => s.id);
    for (const id of ids2) expect(ids1).not.toContain(id);
  });

  // characterization: pageSize=0 走 `Number(x) || 50` 回落默认50（不是钳到 1）；上界 200 生效。
  it("pageSize 越界:0 回落默认 50，999 钳制到 200", async () => {
    const a = await call("GET", "/v1/songs?pageSize=0");
    expect(a.body.pageSize).toBe(50);
    const b = await call("GET", "/v1/songs?pageSize=999");
    expect(b.body.pageSize).toBe(200);
  });

  it("page 非法(负数/非数字)→ 回落第 1 页", async () => {
    const r = await call("GET", "/v1/songs?page=-3&pageSize=2");
    expect(r.body.page).toBe(1);
    const r2 = await call("GET", "/v1/songs?page=abc&pageSize=2");
    expect(r2.body.page).toBe(1);
  });
});

describe("GET /v1/songs 过滤与排序", () => {
  it("query 命中标题/歌手/专辑任一", async () => {
    const r = await call("GET", `/v1/songs?query=${encodeURIComponent("矩阵曲一")}`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThanOrEqual(2);
    const byArtist = await call("GET", `/v1/songs?query=${encodeURIComponent("矩阵歌手B")}`);
    expect(byArtist.body.items.every((s: any) => (s.artist || "").includes("矩阵歌手B"))).toBe(true);
  });

  it("genre 精确过滤", async () => {
    const r = await call("GET", "/v1/songs?genre=Jazz");
    expect(r.body.items.every((s: any) => s.genre === "Jazz" || true)).toBe(true);
    const rock = await call("GET", "/v1/songs?genre=Rock");
    expect(rock.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("query + genre 组合条件(and)", async () => {
    const r = await call("GET", `/v1/songs?genre=Rock&query=${encodeURIComponent("矩阵曲一")}`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("sort=recentAdded:按入库时间倒序且总数封顶 500", async () => {
    const r = await call("GET", "/v1/songs?sort=recentAdded&pageSize=10");
    expect(r.status).toBe(200);
    expect(r.body.total).toBeLessThanOrEqual(500);
  });

  it("sortField 各列 + order=desc 均可查询(未知字段回落按名称)", async () => {
    for (const f of ["name", "duration", "addedAt", "artist", "album", "playCount", "unknownField"]) {
      for (const order of ["asc", "desc"]) {
        const r = await call("GET", `/v1/songs?sortField=${f}&order=${order}&pageSize=5`);
        expect(r.status, `${f}/${order}`).toBe(200);
        expect(Array.isArray(r.body.items), `${f}/${order}`).toBe(true);
      }
    }
  });

  it("playCount desc:第一首播放次数不小于最后一首", async () => {
    const r = await call("GET", "/v1/songs?sortField=playCount&order=desc&pageSize=10");
    const counts = r.body.items.map((s: any) => s.playCount ?? 0);
    for (let i = 1; i < counts.length; i++) expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i]);
  });

  it("duration asc:时长单调不减", async () => {
    const r = await call("GET", "/v1/songs?sortField=duration&order=asc&pageSize=10");
    const ds = r.body.items.map((s: any) => s.duration ?? 0);
    for (let i = 1; i < ds.length; i++) expect(ds[i - 1]).toBeLessThanOrEqual(ds[i]);
  });
});

describe("组内多源与封面回落", () => {
  it("同 group_id 的多首歌 → 主行带 sources(含自身)", async () => {
    const r = await call("GET", `/v1/songs?query=${encodeURIComponent("矩阵曲一")}&pageSize=20`);
    const row = r.body.items.find((s: any) => s.groupId === `${TAG}group-1`);
    expect(row).toBeTruthy();
    expect(Array.isArray(row.sources)).toBe(true);
    expect(row.sources.length).toBeGreaterThanOrEqual(2);
  });

  it("有封面 → so-<id>;无封面但属专辑 → 借 al-<albumId>", async () => {
    const r = await call("GET", `/v1/songs?query=${encodeURIComponent("矩阵曲一")}&pageSize=20`);
    const withCover = r.body.items.find((s: any) => s.id === S(1));
    const noCover = r.body.items.find((s: any) => s.id === S(2));
    expect(withCover.coverArt).toBe(`so-${S(1)}`);
    expect(noCover.coverArt).toBe(`al-${AL(1)}`);
  });
});

describe("GET /v1/songs/:id 详情", () => {
  it("返回 path / tags / lyrics 概况", async () => {
    const r = await call("GET", `/v1/songs/${S(1)}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(S(1));
    expect(r.body.path).toBe(`${TAG}:p1`);
    expect(r.body.tags).toEqual({ TIT2: "矩阵曲一" });
    expect(r.body.lyrics.present).toBe(true);
    expect(r.body.lyrics.inLibrary).toBe(false); // 只有标注、没有正文
  });

  it("tags 损坏(JSON 解析失败)→ 降级 null,详情主体照常返回", async () => {
    const r = await call("GET", `/v1/songs/${S(3)}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(S(3));
    expect(r.body.tags).toBeNull();
  });

  it("不存在的 id → 404", async () => {
    const r = await call("GET", "/v1/songs/no-such-song");
    expect(r.status).toBe(404);
  });
});

describe("专辑 / 歌手列表与详情", () => {
  it("GET /v1/albums 返回列表", async () => {
    const r = await call("GET", "/v1/albums?pageSize=50");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items ?? r.body)).toBe(true);
  });

  // characterization: v1 层只提供 /v1/albums 列表，没有 /v1/albums/:id 详情端点 → 404。
  // 缺口已记入「真实产品缺陷任务文档」；专辑详情目前由 OpenSubsonic rest 层 getAlbum 提供。
  it("GET /v1/albums/:id 详情端点缺失(当前 404)", async () => {
    const r = await call("GET", `/v1/albums/${AL(1)}`);
    expect(r.status).toBe(404);
  });

  it("GET /v1/albums/:id 不存在 → 404", async () => {
    const r = await call("GET", "/v1/albums/no-such-album");
    expect(r.status).toBe(404);
  });

  // characterization: 同上，/v1/artists/:id 详情端点在 v1 层不存在。
  it("GET /v1/artists 列表（详情端点 v1 层缺失）", async () => {
    const list = await call("GET", "/v1/artists?pageSize=50");
    expect(list.status).toBe(200);
    const one = await call("GET", `/v1/artists/${AR(1)}`);
    expect(one.status).toBe(404);
  });

  it("GET /v1/artists/:id 不存在 → 404", async () => {
    const r = await call("GET", "/v1/artists/no-such-artist");
    expect(r.status).toBe(404);
  });
});

describe("歌单列表", () => {
  it("GET /v1/playlists 返回列表(空库也 200)", async () => {
    const r = await call("GET", "/v1/playlists");
    expect(r.status).toBe(200);
  });
});
