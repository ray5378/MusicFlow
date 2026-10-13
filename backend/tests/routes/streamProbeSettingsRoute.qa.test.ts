// ==================== QA 独立回归:起播 TTFB 探针设置端点(HTTP 合同) ====================
//
// 验证点(2026-10-13 用户拍板「设置里加个探针开关,默认关闭,可随时开关」后的 UI 通道):
//   ① GET|PUT /rest/api/v1/playback-sources/probe-settings 真正注册且返回约定结构
//     (enabled/songId + snapshot 运行快照);
//   ② 默认关闭;PUT 开启但没选歌 → 400(INVALID_PARAM + i18n 文案),不落库;
//   ③ PUT 开启(带歌)→ 200 即时生效,GET 回读一致;合并语义(只改带上来的字段);
//   ④ 落库键为 stream.probe.settings(与 prefetch.settings 等其它设置键隔离);
//   ⑤ admin 端点受保护:非 admin → 403,无凭据 → 非 200;
//   ⑥ GET /v1/admin/metrics 附带 streamProbe 快照(运维面板与 UI 状态行同一份真源)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { getSetting } from "../../src/services/settings.js";
import {
  resetStreamProbeSettings,
  STREAM_PROBE_SETTINGS_KEY,
} from "../../src/services/source/streamProbeConfig.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const ADMIN_PASS = "hunter2";
const USER_PASS = "bobpass";
const CLIENT_SALT = "clientsalt123";
const qs = (u: string, plain: string) => `u=${u}&t=${md5(plain + CLIENT_SALT)}&s=${CLIENT_SALT}`;

async function req(method: string, path: string, opts: { qs?: string; body?: any } = {}) {
  const res = await app.request(`/rest/api/v1${path}?${opts.qs ?? qs("alice", ADMIN_PASS)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  const mk = (id: string, name: string, plain: string, isAdmin: number) => {
    if (!db.select().from(users).where(eq(users.username, name)).get()) {
      db.insert(users).values({
        id, username: name, password: "", salt: "salt", subsonicSalt: "subsalt",
        passEnc: encryptPassword(plain), isAdmin, isActive: 1, email: `${name}@b.c`,
      }).run();
    }
  };
  mk("u1", "alice", ADMIN_PASS, 1);
  mk("u2", "bob", USER_PASS, 0);
});

// vitest 配置 sequence.shuffle=true(刻意打乱文件内顺序,逼出隐藏的顺序依赖):
// 每个用例必须自足 —— 探针设置复位到「默认关、无歌」,不吃上一个用例的写入。
beforeEach(() => {
  resetStreamProbeSettings();
});

describe("QA:playback-sources/probe-settings 路由合同", () => {
  it("R1 管理员 GET → 200,默认关闭 + 全量字段 + snapshot", async () => {
    const { status, body } = await req("GET", "/playback-sources/probe-settings");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enabled).toBe(false); // 默认关闭(用户拍板)
    expect(body.songId).toBe("");
    for (const k of ["health", "lastTtfbMs", "lastError", "lastSkipReason",
      "samples", "p50Ms", "p95Ms", "counts", "schedulerRunning",
      "intervalMs", "quietMs", "timeoutMs", "ttfbWarnMs", "recent"]) {
      expect(body.snapshot?.[k], k).toBeDefined();
    }
    expect(body.snapshot.health).toBe("unknown");
  });

  it("R2 PUT 开启但没选歌 → 400 INVALID_PARAM + i18n 文案,且不落库", async () => {
    const put = await req("PUT", "/playback-sources/probe-settings", { body: { enabled: true } });
    expect(put.status).toBe(400);
    expect(put.body.success).toBe(false);
    expect(put.body.code).toBe("INVALID_PARAM");
    expect(String(put.body.error)).toContain("选定");
    // 没有钉死的测量对象,探针只是噪声源:拒绝写入,现状保持关闭。
    const get = await req("GET", "/playback-sources/probe-settings");
    expect(get.body.enabled).toBe(false);
    expect(get.body.songId).toBe("");
  });

  it("R3 PUT 开启(带歌)→ 200 即时生效,GET 回读一致;合并语义", async () => {
    const put = await req("PUT", "/playback-sources/probe-settings", {
      body: { enabled: true, songId: "probe-song-1" },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ success: true, enabled: true, songId: "probe-song-1" });
    expect(put.body.snapshot.enabled).toBe(true);

    const get = await req("GET", "/playback-sources/probe-settings");
    expect(get.body.enabled).toBe(true);
    expect(get.body.songId).toBe("probe-song-1");

    // 合并语义:第二次只带 enabled,songId 不被冲掉
    const put2 = await req("PUT", "/playback-sources/probe-settings", { body: { enabled: false } });
    expect(put2.body.enabled).toBe(false);
    expect(put2.body.songId).toBe("probe-song-1");
    const get2 = await req("GET", "/playback-sources/probe-settings");
    expect(get2.body.enabled).toBe(false);
    expect(get2.body.songId).toBe("probe-song-1");
  });

  it("R4 落库键为 stream.probe.settings(与 prefetch.settings 隔离)", async () => {
    await req("PUT", "/playback-sources/probe-settings", { body: { songId: "probe-song-2" } });
    const raw = getSetting(STREAM_PROBE_SETTINGS_KEY, "MISSING");
    expect(raw).not.toBe("MISSING");
    expect(JSON.parse(raw).songId).toBe("probe-song-2");
    expect(JSON.parse(raw).enabled).toBe(false); // 合并后保持现值
  });

  it("R5 端点受 admin 保护:非 admin → 403;无凭据 → 非 200", async () => {
    const bob = await req("GET", "/playback-sources/probe-settings", { qs: qs("bob", USER_PASS) });
    expect(bob.status).toBe(403);

    const anon = await req("GET", "/playback-sources/probe-settings", { qs: "u=&t=&s=" });
    expect(anon.status).not.toBe(200);

    const bobPut = await req("PUT", "/playback-sources/probe-settings", {
      qs: qs("bob", USER_PASS), body: { enabled: true, songId: "x" },
    });
    expect(bobPut.status).toBe(403);
  });

  it("R6 admin/metrics 附带 streamProbe 快照(运维面板与 UI 同一份真源)", async () => {
    // 自足:自己写一份状态再断言(不依赖 R4 的写入,shuffle 下顺序不保证)。
    await req("PUT", "/playback-sources/probe-settings", { body: { enabled: true, songId: "metrics-song" } });
    const { status, body } = await req("GET", "/admin/metrics");
    expect(status).toBe(200);
    expect(body.streamProbe).toBeDefined();
    expect(body.streamProbe.songId).toBe("metrics-song");
    expect(body.streamProbe.enabled).toBe(true);
    expect(typeof body.streamProbe.health).toBe("string");
  });

  it("R7 snapshot.song:库内没有这行 → null(UI 提示换歌,不报错)", async () => {
    await req("PUT", "/playback-sources/probe-settings", { body: { songId: "ghost-song" } });
    const get = await req("GET", "/playback-sources/probe-settings");
    expect(get.body.songId).toBe("ghost-song");
    expect(get.body.snapshot.song).toBeNull();
  });
});
