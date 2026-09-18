// 撤销「添加播放器」(= 前端统一的「解绑」)的语义回归锁。
//
// 2026-09-19 修正前,`forgetDialTarget` 会 `conn.close()`:设备是服务端拨过去的,
// 一撤销就断连,而 Sendspin 的客户端列表是**连接派生**的(`srv.clients`),于是
// 这台设备整个从列表消失 —— 与「解绑后仍保留在这一行」的预期完全相反,用户想再
// 操作它都没入口。
//
// 现在锁定的契约:
//   1. 撤销 = 从 dial_targets 移除(不再自动重拨);
//   2. **连接保持** —— 设备仍在线、行仍在(只抹掉这条连接的 dialed 标记);
//   3. 重复撤销返回 false(不报错、不误删);
//   4. 记住/撤销会落盘(重启后不再自动重拨这件事必须持久)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initDatabase, db, sqlite, encryptPassword } from "../../src/db/index.js";
import { users, playerNameOverrides } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  getDeviceVolumeState,
  getDeviceEsphome,
  saveDeviceVolumeState,
  saveDeviceEsphome,
} from "../../src/services/sendspin/deviceState.js";
import {
  setSendspinIdentityDir,
  startSendspinService,
  stopSendspinService,
  getSendspinServer,
  rememberDialTarget,
  forgetDialTarget,
  listDialTargets,
} from "../../src/services/sendspin/index.js";

const PORT = 18941;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const CID = "FORGET-E2E-1";
// 假拨号目标(TEST-NET-3,保证不会真去拨任何东西)。
const HOST = "203.0.113.7";
const PORT_T = 8928;

let tmpDir = "";
let ws: WebSocket | null = null;

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-forget-"));
  setSendspinIdentityDir(tmpDir);
  await startSendspinService(PORT);
  // 直连一个 legacy 客户端拿到真实 conn(与 sendspinMute 同款:只需 client/hello)。
  const sock = new WebSocket(URL);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no server/hello")), 5000);
    sock.on("open", () =>
      sock.send(
        JSON.stringify({
          type: "client/hello",
          payload: { client_id: CID, name: "forget-test", version: 1, supported_roles: ["player@v1"] },
        })
      )
    );
    sock.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        if (JSON.parse(data.toString("utf8"))?.type === "server/hello") { clearTimeout(timer); resolve(); }
      } catch { /* ignore */ }
    });
    sock.on("error", reject);
  });
  ws = sock;
  await waitFor(() => !!getSendspinServer()?.clients.get(CID), 5000, "legacy conn");
}, 60000);

afterAll(async () => {
  try { ws?.terminate(); } catch { /* ignore */ }
  await stopSendspinService();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 把真实 conn 伪装成「服务端拨出去的」(dialed 只在真拨号时置位,测试里直接打标)。 */
function markAsDialed(): void {
  const conn = getSendspinServer()!.clients.get(CID)!;
  conn.dialed = true;
  conn.dialHost = HOST;
  conn.dialPort = PORT_T;
}

describe("forgetDialTarget = 解绑(撤销添加)", () => {
  it("记住 → 撤销:目标从列表移除", async () => {
    await rememberDialTarget(HOST, PORT_T);
    expect(await listDialTargets()).toContainEqual(
      expect.objectContaining({ host: HOST, port: PORT_T })
    );
    expect(await forgetDialTarget(HOST, PORT_T)).toBe(true);
    expect(await listDialTargets()).not.toContainEqual(
      expect.objectContaining({ host: HOST, port: PORT_T })
    );
  });

  it("撤销**不断开连接**:设备仍在线、只是不再是记住的拨号目标", async () => {
    markAsDialed();
    await rememberDialTarget(HOST, PORT_T);
    const srv = getSendspinServer()!;

    expect(await forgetDialTarget(HOST, PORT_T)).toBe(true);

    // 1) 连接还在 —— 这是本次修正的核心(旧行为会 close,设备整个消失)。
    expect(ws!.readyState, "解绑不该断开连接").toBe(WebSocket.OPEN);
    await waitFor(() => !!srv.clients.get(CID), 3000, "conn 仍在 srv.clients");
    // 2) dialed 标记被抹掉 → 前端据此回落「解绑」按钮。
    const conn = srv.clients.get(CID)!;
    expect(conn.dialed).toBe(false);
    expect(conn.dialHost).toBe("");
    expect(conn.dialPort).toBe(0);
  });

  it("重复撤销返回 false(幂等,不误删)", async () => {
    // 上一条已撤销过,再撤销应返回 false 而不是抛错。
    expect(await forgetDialTarget(HOST, PORT_T)).toBe(false);
    // 记住另一个再撤销,确认 flow 仍正常。
    await rememberDialTarget("198.51.100.9", 8928);
    expect(await forgetDialTarget("198.51.100.9", 8928)).toBe(true);
    expect(await forgetDialTarget("198.51.100.9", 8928)).toBe(false);
  });

  it("落盘:撤销后目标文件里也没有它(重启不再自动重拨)", async () => {
    await rememberDialTarget("198.51.100.10", 8928);
    const file = path.join(tmpDir, "sendspin", "dial_targets.json");
    await waitFor(() => fs.existsSync(file), 3000, "dial_targets.json 落盘");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ host: "198.51.100.10", port: 8928 })])
    );
    await forgetDialTarget("198.51.100.10", 8928);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ host: "198.51.100.10", port: 8928 })])
    );
  });

  // 解绑 = 这台设备从没被配置过。端到端锁这条:状态行(音量/静音/禁用/6053 密钥)
  // 与**改名覆盖**都必须一起消失 —— 只删状态行而留下改名,设备会带着旧名字"复活"。
  it("解绑顺带清掉该设备保存过的一切:状态行 + 6053 密钥 + 改名覆盖", async () => {
    const uid = "forget-owner-1";
    const peerId = `sendspin:${CID}`;
    sqlite.prepare("DELETE FROM users WHERE id = ?").run(uid);
    db.insert(users).values({
      id: uid,
      username: `forget-owner-${Date.now()}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: 0,
      isActive: 1,
      email: "",
    }).run();
    // 铺满「保存过的配置」。
    saveDeviceVolumeState(CID, { volume: 42, muted: true });
    saveDeviceEsphome(CID, "forget-key", 6054);
    db.insert(playerNameOverrides)
      .values({ ownerUserId: uid, peerId, displayName: "我的音箱", updatedAt: new Date().toISOString() })
      .run();
    // 前一个用例可能已把目标撤掉,这里重新铺一遍再解绑。
    markAsDialed();
    await rememberDialTarget(HOST, PORT_T);

    expect(await forgetDialTarget(HOST, PORT_T)).toBe(true);

    expect(getDeviceVolumeState(CID)).toBeNull();
    expect(getDeviceEsphome(CID)).toEqual({ psk: "", port: 0 });
    expect(db.select().from(playerNameOverrides).where(eq(playerNameOverrides.peerId, peerId)).all()).toEqual([]);
    // 连接仍保持(解绑不断开) —— 与第 2 个用例同一条契约。
    expect(ws!.readyState).toBe(WebSocket.OPEN);

    sqlite.prepare("DELETE FROM users WHERE id = ?").run(uid);
  });
});
