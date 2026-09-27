// POST /v1/stream/probe 补测（src/routes/api/stream.ts）。
//
// 「探测」决定前端把它显示的那一首歌按什么姿态呈现：可播 / 本地 / 无源 / 网络抖动。
// 这里最要紧的一条是**别把网络抖动当死链**——源码那两行注释就是为此写的：
// ensurePlayableStream 返 null 时必须再分「全平台无源」与「探测未定」，
// 因为把后者当死链跳掉,用户只会看到「这首歌播不了」,而重试一次往往就好了。
//
// 「转 transient」而非直接判死,也同理:探测失败 ≠ 这首歌没了。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const f = vi.hoisted(() => ({
  ensurePlayableStream: vi.fn(),
  getCachedPlayability: vi.fn(),
}));

// 注意路径要按**测试文件所在目录**数:这里在 tests/routes/ 下,所以是三层 ../。
vi.mock("../../src/services/source/online/streamFallback.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  ensurePlayableStream: f.ensurePlayableStream,
  getCachedPlayability: f.getCachedPlayability,
}));

import { db, initDatabase } from "../../src/db/index.js";
import { users, songs } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { generateToken } from "../../src/utils/auth.js";
// MAX_PROBE_BATCH 由 stream.ts 从 shared.js 引入,但并不重新导出,所以从源头拿。
import { MAX_PROBE_BATCH } from "../../src/routes/api/shared.js";
import { registerStream } from "../../src/routes/api/stream.js";

const app = new Hono();
app.use("/v1/*", authMiddleware);
registerStream(app);

const PROBE = "/v1/stream/probe";

const adminHeaders = () => ({
  Authorization: `Bearer ${generateToken("u-probe-admin", "admin", true)}`,
  "content-type": "application/json",
});

function post(body: unknown, headers: Record<string, string> = adminHeaders()) {
  return app.request(PROBE, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function seedSong(id: string, extra: any = {}) {
  db.insert(songs)
    .values({
      id,
      title: `t-${id}`,
      // path 在 schema 里是 NOT NULL(本地文件才有,线上行是空串)。
      path: "",
      artistId: null,
      albumId: null,
      type: "local",
      url: null,
      cachePath: null,
      ...extra,
    })
    .run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users)
    .values({
      id: "u-probe-admin",
      username: "probe-admin",
      password: "",
      salt: "s",
      subsonicSalt: "ss",
      passEnc: "",
      isAdmin: 1,
      isActive: 1,
      email: "",
    })
    .run();
});

beforeEach(() => {
  f.ensurePlayableStream.mockReset();
  f.getCachedPlayability.mockReset();
});

/** 取第一个 result,顺手断言信封形状。 */
async function firstResult(res: Response) {
  expect(res.status).toBe(200);
  const env = await res.json();
  expect(env.success).toBe(true);
  expect(Array.isArray(env.results)).toBe(true);
  return env.results[0];
}

// ------------------------------------------------------------------ 入参校验

describe("probe: 入参", () => {
  it("缺 songIds → 400(不是静默返回空数组)", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_PARAM");
  });

  it("songIds 不是数组 → 按空数组处理 → 400", async () => {
    for (const bad of [null, "abc", 42, {}]) {
      const res = await post({ songIds: bad });
      expect(res.status).toBe(400);
    }
  });

  it("body 不是合法 JSON → 当作空 body(不 500)", async () => {
    const res = await post("{not json", { ...adminHeaders(), "content-type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("非字符串的 songId 被滤掉([1, null, 'x'])", async () => {
    seedSong("s-str");
    const res = await post({ songIds: [1, null, "s-str", {}] });
    const env = await res.json();
    expect(env.results).toHaveLength(1);
    expect(env.results[0].songId).toBe("s-str");
  });

  it(`超过 MAX_PROBE_BATCH(${MAX_PROBE_BATCH}) 时被截断`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROBE_BATCH + 7; i++) {
      const id = `s-bulk-${i}`;
      ids.push(id);
      seedSong(id);
    }
    const res = await post({ songIds: ids });
    const env = await res.json();
    expect(env.results).toHaveLength(MAX_PROBE_BATCH);
    expect(env.results[0].songId).toBe("s-bulk-0");
  });

  it("空数组 → 400(不允许「探测个寂寞」) ", async () => {
    const res = await post({ songIds: [] });
    expect(res.status).toBe(400);
  });

  it("没有凭据 → 401", async () => {
    const res = await post({ songIds: ["s-str"] }, { "content-type": "application/json" });
    expect(res.status).toBe(401);
  });
});

// ------------------------------------------------------------ 直达 / 落库分支

describe("probe: 无需探测的直达分支", () => {
  it("库里没有这首歌 → unplayable / 歌曲不存在(不调上游)", async () => {
    const r = await firstResult(await post({ songIds: ["s-nope"] }));
    expect(r).toMatchObject({
      songId: "s-nope", ok: false, local: false,
      verdict: "unplayable", reason: "歌曲不存在",
    });
    expect(f.ensurePlayableStream).not.toHaveBeenCalled();
  });

  it("type=local → 直接判可播,且**不**去解析音源", async () => {
    seedSong("s-local", { type: "local" });
    const r = await firstResult(await post({ songIds: ["s-local"] }));
    expect(r).toMatchObject({ songId: "s-local", ok: true, local: true, verdict: "playable" });
    expect(f.ensurePlayableStream).not.toHaveBeenCalled();
  });

  it("type 字段缺失时按 local 兜底(老行没写死 type)", async () => {
    seedSong("s-notype", { type: null });
    f.ensurePlayableStream.mockResolvedValueOnce("http://never");
    const r = await firstResult(await post({ songIds: ["s-notype"] }));
    expect(r).toMatchObject({ ok: true, local: true, verdict: "playable" });
    expect(f.ensurePlayableStream).not.toHaveBeenCalled();
  });

  it("type=web 但本地已有缓存 → 也算本地,不用联网", async () => {
    seedSong("s-cached", { type: "web", url: "http://origin/1.mp3", cachePath: "/tmp/cache/1.mp3" });
    const r = await firstResult(await post({ songIds: ["s-cached"] }));
    expect(r).toMatchObject({ ok: true, local: true, verdict: "playable" });
    expect(f.ensurePlayableStream).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ 解析分支

describe("probe: web 歌的音源解析", () => {
  it("解析出的 URL 与原直链相同 → fallback=false", async () => {
    seedSong("s-web", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockResolvedValueOnce("http://origin/a.mp3");
    const r = await firstResult(await post({ songIds: ["s-web"] }));
    expect(r).toMatchObject({
      ok: true, local: false, verdict: "playable", fallback: false,
    });
  });

  it("换到别的源 → fallback=true(前端据此提示「已换源」)", async () => {
    seedSong("s-web2", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockResolvedValueOnce("http://mirror/a.mp3");
    const r = await firstResult(await post({ songIds: ["s-web2"] }));
    expect(r).toMatchObject({ ok: true, local: false, verdict: "playable", fallback: true });
  });

  it("解析失败且缓存无记录 → unknown(「未知」,绝不比成死链)", async () => {
    seedSong("s-web3", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockResolvedValueOnce(null);
    f.getCachedPlayability.mockReturnValue("unknown");
    const r = await firstResult(await post({ songIds: ["s-web3"] }));
    expect(r).toMatchObject({
      songId: "s-web3", ok: false, local: false, verdict: "unknown",
      reason: "探测未定(网络异常,不据此跳过)",
    });
  });

  it("缓存判死 → unplayable「无可用音源」(这条才允许前端标记死链)", async () => {
    seedSong("s-web4", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockResolvedValueOnce(null);
    f.getCachedPlayability.mockReturnValue("unplayable");
    const r = await firstResult(await post({ songIds: ["s-web4"] }));
    expect(r).toMatchObject({
      ok: false, local: false, verdict: "unplayable", reason: "无可用音源",
    });
  });

  it("缓存判好但仍拿不到直链 → playable,但 ok=false(不假装可播)", async () => {
    seedSong("s-web5", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockResolvedValueOnce(null);
    f.getCachedPlayability.mockReturnValue("playable");
    const r = await firstResult(await post({ songIds: ["s-web5"] }));
    expect(r).toMatchObject({
      ok: false, local: false, verdict: "playable", reason: "探测未定(网络异常,不据此跳过)",
    });
  });

  it("缓存判瞬时故障 → verdict=transient(重试即可)", async () => {
    seedSong("s-web6", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockResolvedValueOnce(null);
    f.getCachedPlayability.mockReturnValue("transient");
    const r = await firstResult(await post({ songIds: ["s-web6"] }));
    expect(r).toMatchObject({
      ok: false, local: false, verdict: "transient", reason: "探测未定(网络异常,不据此跳过)",
    });
  });

  it("解析过程抛错 → transient,并把原始原因带上(截断到 120 字)", async () => {
    seedSong("s-web7", { type: "web", url: "http://origin/a.mp3" });
    const long = "E".repeat(300);
    f.ensurePlayableStream.mockRejectedValueOnce(new Error(long));
    const r = await firstResult(await post({ songIds: ["s-web7"] }));
    expect(r).toMatchObject({ ok: false, local: false, verdict: "transient" });
    expect(r.reason).toBe(long.slice(0, 120));
    expect((r.reason as string).length).toBe(120);
  });

  it("抛出的不是 Error 实例也能出 reason(String(e?.message || e))", async () => {
    seedSong("s-web8", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockRejectedValueOnce("plain-string-throw");
    const r = await firstResult(await post({ songIds: ["s-web8"] }));
    expect(r.verdict).toBe("transient");
    expect(r.reason).toBe("plain-string-throw");
  });

  it("【现状】抛出的 Error 的 message 为空串时,reason 退化成 String(e) 即 \"Error\"", async () => {
    seedSong("s-web9", { type: "web", url: "http://origin/a.mp3" });
    f.ensurePlayableStream.mockRejectedValueOnce(new Error(""));
    const r = await firstResult(await post({ songIds: ["s-web9"] }));
    // `String(e?.message || e)` 里 message 是空串(假值),于是整个表达式落到 e 身上。
    expect(r.verdict).toBe("transient");
    expect(r.reason).toBe("Error");
  });
});

// -------------------------------------------------------------------- 并发行

describe("probe: 多条一起探测", () => {
  it("多条 songId 并行返回,各自 verdict 独立", async () => {
    seedSong("s-a", { type: "local" });
    seedSong("s-b", { type: "web", url: "http://origin/b.mp3" });
    seedSong("s-c", { type: "web", url: "http://origin/c.mp3" });
    // s-b 命中直链,s-c 解析不到但缓存判死。Promise.all 的调用顺序不保证,
    // 所以按「集合」断言,不按位置。
    f.ensurePlayableStream.mockImplementation(async (s: any) =>
      s.id === "s-b" ? "http://mirror/b.mp3" : null);
    f.getCachedPlayability.mockImplementation((id: string) =>
      id === "s-c" ? "unplayable" : "unknown");

    const res = await post({ songIds: ["s-a", "s-b", "s-c"] });
    const env = await res.json();
    expect(env.results).toHaveLength(3);
    expect(env.results[0]).toMatchObject({ songId: "s-a", local: true, verdict: "playable" });
    const web = env.results.filter((r: any) => !r.local);
    expect(web).toHaveLength(2);
    expect(web.map((r: any) => r.verdict).sort())
      .toEqual(["playable", "unplayable"]);
  });
});
