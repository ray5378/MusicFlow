// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import WebSocket from "ws";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "../../src/services/sendspin/index.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const PLAIN = "hunter2";
const CLIENT_SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + CLIENT_SALT)}&s=${CLIENT_SALT}`;

const PORT = 18934;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const CID = "MUTE-E2E-1";

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("sendspin mute", () => {
  let tmpDir: string;

  beforeAll(async () => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    initDatabase();
    if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
      db.insert(users).values({ id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt", passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c" }).run();
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-mute-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    // 直连一个 legacy 客户端,拿到真实 conn(验证 conn 级静音标记)
    const ws = new WebSocket(URL);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no hello")), 5000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "client/hello", payload: { client_id: CID, name: "mute-test", version: 1, supported_roles: ["player@v1"] } })));
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        try {
          if (JSON.parse(data.toString("utf8"))?.type === "server/hello") { clearTimeout(timer); resolve(); }
        } catch { /* ignore */ }
      });
      ws.on("error", reject);
    });
    (globalThis as any).__muteWs = ws;
    const srv = getSendspinServer()!;
    await waitFor(() => !!srv.clients.get(CID), 5000, "legacy conn");
  }, 60000);

  afterAll(async () => {
    try { ((globalThis as any).__muteWs as WebSocket)?.terminate(); } catch { /* ignore */ }
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function mute(peerId: string, muted: boolean) {
    const res = await app.request(`/rest/api/v1/peers/${encodeURIComponent(peerId)}/mute?${authQS()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it("静音/取消静音置位 conn + 组标记,增益归零/恢复", async () => {
    const srv = getSendspinServer()!;
    const conn = srv.clients.get(CID)!;
    expect(conn.muted).toBe(false);

    const r1 = await mute(`sendspin:${CID}`, true);
    expect(r1.status).toBe(200);
    expect(conn.muted).toBe(true);
    expect(srv.group(CID).muted).toBe(true);
    expect(srv.group(CID).appliedGain(conn)).toBe(0);

    const r2 = await mute(`sendspin:${CID}`, false);
    expect(r2.status).toBe(200);
    expect(conn.muted).toBe(false);
    expect(srv.group(CID).muted).toBe(false);
    expect(srv.group(CID).appliedGain(conn)).toBe(100);
  });

  it("离线客户端(无 conn)静音落在组标记上,重连后仍有效", async () => {
    const srv = getSendspinServer()!;
    const r = await mute("sendspin:OFFLINE-XYZ", true);
    expect(r.status).toBe(200);
    expect(srv.group("OFFLINE-XYZ").muted).toBe(true);
    await mute("sendspin:OFFLINE-XYZ", false);
    expect(srv.group("OFFLINE-XYZ").muted).toBe(false);
  });

  it("muted 非布尔值 400", async () => {
    const res = await app.request(`/rest/api/v1/peers/${encodeURIComponent(`sendspin:${CID}`)}/mute?${authQS()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});
