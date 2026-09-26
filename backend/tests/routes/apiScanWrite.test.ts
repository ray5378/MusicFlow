// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
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

async function call(method: string, path: string, body?: any) {
  const res = await app.request("/rest/api" + path + "?" + authQS(), {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

const WRITES: Array<[string, string, any]> = [
  ["PUT", "/v1/users/no-such/password", {}],
  ["PUT", "/v1/users/no-such/username", {}],
  ["PUT", "/v1/users/no-such/access", {}],
  ["DELETE", "/v1/users/no-such", undefined],
  ["PUT", "/v1/sources/no-such", {}],
  ["DELETE", "/v1/sources/no-such", undefined],
  ["POST", "/v1/sources/no-such/scan-stop", {}],
  ["PUT", "/v1/plugins/no-such", {}],
  ["PUT", "/v1/plugins/no-such/toggle", {}],
  ["DELETE", "/v1/plugins/no-such", undefined],
  ["POST", "/v1/plugins/registry", {}],
  ["DELETE", "/v1/plugins/registry/no-such", undefined],
  ["DELETE", "/v1/songs/no-such", undefined],
  ["POST", "/v1/songs/delete", {}],
  ["PUT", "/v1/admin/memory-settings", {}],
  ["PUT", "/v1/admin/log-settings", {}],
  ["PUT", "/v1/playback/settings", {}],
  ["PUT", "/v1/lyrics/settings", {}],
  ["PUT", "/v1/covers/settings", {}],
  ["PUT", "/v1/daily-recommend/config", {}],
  ["PUT", "/v1/daily-recommend/candidates", {}],
  ["POST", "/v1/recommend-pool/playlist/no-such", {}],
  ["DELETE", "/v1/recommend-pool/playlist/no-such", undefined],
  ["POST", "/v1/recommend-pool/favorites", {}],
  ["DELETE", "/v1/recommend-pool/favorites", undefined],
  ["POST", "/v1/playlists/import", {}],
  ["POST", "/v1/playlists/no-such/sync", {}],
  ["PUT", "/v1/playlists/no-such", {}],
  ["POST", "/v1/playlists/no-such/convert-to-local", {}],
  ["POST", "/v1/playlists/no-such/favorite", {}],
  ["DELETE", "/v1/playlist/no-such", undefined],
  ["DELETE", "/v1/history", undefined],
  ["PUT", "/v1/dlna/devices/no-such", {}],
  ["DELETE", "/v1/dlna/devices/no-such", undefined],
  ["PUT", "/v1/dlna/devices/no-such/disabled", {}],
  ["POST", "/v1/dlna/stream-url", {}],
  ["POST", "/v1/dlna/cast", {}],
  ["POST", "/v1/dlna/enqueue", {}],
  ["POST", "/v1/dlna/devices/no-such/seek", {}],
  ["POST", "/v1/dlna/devices/no-such/volume", {}],
  ["POST", "/v1/dlna/devices/no-such/mute", {}],
  ["POST", "/v1/dlna/devices/no-such/queue/play", {}],
  ["POST", "/v1/dlna/devices/no-such/queue/enqueue", {}],
  ["POST", "/v1/dlna/devices/no-such/next", {}],
  ["POST", "/v1/dlna/devices/no-such/prev", {}],
  ["DELETE", "/v1/dlna/devices/no-such/queue", undefined],
  ["POST", "/v1/dlna/devices/no-such/play-mode", {}],
  ["DELETE", "/v1/dlna/devices/no-such/queue/0", undefined],
  ["POST", "/v1/dlna/devices/no-such/deactivate", {}],
  ["PUT", "/v1/airplay/devices/no-such", {}],
  ["DELETE", "/v1/airplay/devices/no-such", undefined],
  ["PUT", "/v1/airplay/devices/no-such/disabled", {}],
  ["POST", "/v1/airplay/cast", {}],
  ["PUT", "/v1/sendspin/devices/no-such/disabled", {}],
  ["PUT", "/v1/sendspin/devices/no-such/esphome", {}],
  ["PUT", "/v1/sendspin/devices/no-such/esphome/volume", {}],
  ["PUT", "/v1/sendspin/devices/no-such/esphome/muted", {}],
  ["POST", "/v1/sendspin/approve", {}],
  ["POST", "/v1/sendspin/dial", {}],
  ["DELETE", "/v1/sendspin/dial-targets", undefined],
  ["POST", "/v1/sendspin/unpair", {}],
  ["PUT", "/v1/player-prefs/hidden", {}],
  ["PUT", "/v1/player-prefs/names", {}],
  ["PUT", "/v1/player-prefs/dsp/no-such", {}],
  ["PUT", "/v1/pipeline/switches", {}],
  ["PUT", "/v1/pipeline/measure", {}],
  ["PUT", "/v1/pipeline/dlna/no-such", {}],
  ["POST", "/v1/pipeline/measure/run", {}],
  ["POST", "/v1/peers/register", {}],
  ["POST", "/v1/peers/no-such/heartbeat", {}],
  ["POST", "/v1/peers/no-such/offline", {}],
  ["POST", "/v1/peers/no-such/local-status", {}],
  ["POST", "/v1/peers/no-such/queue/play", {}],
  ["POST", "/v1/peers/no-such/queue/transfer-from", {}],
  ["POST", "/v1/peers/no-such/queue/jump", {}],
  ["POST", "/v1/peers/no-such/queue/enqueue", {}],
  ["DELETE", "/v1/peers/no-such/queue", undefined],
  ["POST", "/v1/peers/no-such/queue/deactivate", {}],
  ["DELETE", "/v1/peers/no-such/queue/0", undefined],
  ["POST", "/v1/peers/no-such/queue/reorder", {}],
  ["POST", "/v1/peers/no-such/play-mode", {}],
  ["POST", "/v1/peers/no-such/queue/reshuffle", {}],
  ["POST", "/v1/peers/no-such/sleep-timer", {}],
  ["DELETE", "/v1/peers/no-such/sleep-timer", undefined],
  ["POST", "/v1/peers/no-such/queue/index", {}],
  ["POST", "/v1/peers/no-such/play", {}],
  ["POST", "/v1/peers/no-such/pause", {}],
  ["POST", "/v1/peers/no-such/stop", {}],
  ["POST", "/v1/peers/no-such/reset", {}],
  ["POST", "/v1/peers/no-such/next", {}],
  ["POST", "/v1/peers/no-such/prev", {}],
  ["POST", "/v1/peers/no-such/seek", {}],
  ["POST", "/v1/peers/no-such/volume", {}],
  ["POST", "/v1/peers/no-such/mute", {}],
  ["POST", "/v1/groups", {}],
  ["PUT", "/v1/groups/no-such", {}],
  ["POST", "/v1/groups/no-such/members", {}],
  ["DELETE", "/v1/groups/no-such", undefined],
  ["POST", "/v1/play", {}],
  ["POST", "/v1/playlist/no-such/auto-match", {}],
  ["POST", "/v1/flows", {}],
  ["PUT", "/v1/flows/no-such", {}],
  ["DELETE", "/v1/flows/no-such", undefined],
  ["POST", "/v1/flows/no-such/run", {}],
  ["POST", "/v1/player-webhook/tokens", {}],
  ["PUT", "/v1/player-webhook/tokens/no-such", {}],
  ["DELETE", "/v1/player-webhook/tokens/no-such", undefined],
];

const KNOWN: Array<[string, string, number, string]> = [
  ["POST", "/v1/users", 500, "缺 username/password 未校验 -> NOT NULL 约束冒泡成 500"],
  ["POST", "/v1/sources", 500, "缺 name 未校验 -> NOT NULL 约束冒泡成 500"],
  ["POST", "/v1/plugins", 500, "缺 name 未校验 -> NOT NULL 约束冒泡成 500"],
  ["POST", "/v1/wish", 500, "缺 song_title 未校验 -> NOT NULL 约束冒泡成 500"],
  ["POST", "/v1/dlna/devices/no-such/play", 500, "设备未找到应为 404，现被 catch 泛化为 500"],
  ["POST", "/v1/dlna/devices/no-such/pause", 500, "设备未找到应为 404，现被 catch 泛化为 500"],
  ["POST", "/v1/dlna/devices/no-such/stop", 500, "设备未找到应为 404，现被 catch 泛化为 500"],
];

describe("API 已确知缺陷 - characterization(固化现状,修复后需同步更新期望值)", () => {
  for (const [m, p, code, why] of KNOWN) {
    it("[已知缺陷] " + m + " " + p + " 当前 " + code + " (" + why + ")", async () => {
      const r = await call(m, p, {});
      expect(r.status, m + " " + p + " 现状变了,请复核: " + r.text.slice(0, 200)).toBe(code);
    });
  }
});

describe("API 契约扫描 - 空/非法参数写端点不得抛未捕获异常(5xx)", () => {
  for (const [m, p, b] of WRITES) {
    it(m + " " + p + " -> 非 5xx", async () => {
      const r = await call(m, p, b);
      expect(r.status, m + " " + p + " -> " + r.status + " " + r.text.slice(0, 200)).toBeLessThan(500);
    });
  }
});

describe("API 契约扫描 - 错误分支返回体带错误信息", () => {
  it("关键写端点对缺参返回 4xx 且 body 含 error/message 之一", async () => {
    for (const [m, p] of [
      ["PUT", "/v1/playback/settings"],
      ["PUT", "/v1/pipeline/switches"],
      ["PUT", "/v1/player-prefs/hidden"],
      ["POST", "/v1/groups"],
      ["POST", "/v1/flows"],
    ] as Array<[string, string]>) {
      const r = await call(m, p, {});
      expect(r.status, m + " " + p).toBeLessThan(500);
      if (r.status >= 400) {
        const has = r.body && (r.body.error !== undefined || r.body.message !== undefined || r.body.errors !== undefined);
        expect(has, m + " " + p + " body=" + r.text.slice(0, 160)).toBe(true);
      }
    }
  });
});
