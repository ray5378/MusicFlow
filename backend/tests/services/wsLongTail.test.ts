// ==================== services/ws/index 长尾 ====================
// 既有 wsHub.test.ts 覆盖鉴权/快照/队列摘要/定向推送。这里补四条此前未覆盖的分支:
//   - sendSnapshot:某设备状态查询抛错 → 该设备降级为 available:false,不整帧失败;
//   - media_changed 事件转发;
//   - player_refresh 事件转发(起播信号,客户端据此强制拉最新状态);
//   - peer_volume_changed 事件转发(音量/静音跨端同步,含 peerId 打码);
//   - 「随机歌曲」歌单变动事件 → 广播给所有客户端。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import { WebSocket } from "ws";

const h = vi.hoisted(() => {
  const listeners: Record<string, Function[]> = {};
  return {
    user: { id: "u-lt4-ws", isAdmin: true } as any,
    devices: [{ id: "d-err", name: "坏设备", available: true }] as any[],
    statusThrows: true,
    status: { state: "stopped", position: 0 } as any,
    media: null as any,
    events: {
      on: (n: string, f: Function) => { (listeners[n] ||= []).push(f); return () => {}; },
      emit: (n: string, ...a: any[]) => { for (const f of listeners[n] || []) f(...a); },
    },
  };
});

vi.mock("../../src/services/ws/auth.js", () => ({
  authenticateWsToken: (token: string) => (token === "good" ? h.user : null),
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => h.devices,
  getDeviceStatus: async () => { if (h.statusThrows) throw new Error("device unreachable"); return h.status; },
  getCurrentMedia: () => h.media,
  getEffectiveBaseUrl: () => "http://127.0.0.1:1",
}));

vi.mock("../../src/services/access.js", () => ({
  canUseRenderer: () => true,
  peerVisibleTo: () => true,
  decoratePeersForClient: (peers: any[]) => peers,
}));

vi.mock("../../src/services/playerPrefs.js", () => ({ isPeerHidden: () => false }));

vi.mock("../../src/services/plugin/randomSongs.js", async (imp) => {
  const real: any = await imp();
  // 保留真实导出(其它模块还要 manifest/plugin),只把事件总线换成桩
  return { ...real, randomSongsEvents: h.events };
});

import { initWebSocketServer } from "../../src/services/ws/index.js";
import { getEventManager } from "../../src/services/dlna/eventing.js";
import { getPeerManager } from "../../src/services/peer.js";
import { RANDOM_SONGS_CHANGED_EVENT } from "../../src/services/plugin/randomSongs.js";
import { buildLocalPeerId } from "../../src/utils/peerId.js";

const USER = "u-lt4-ws";
let server: http.Server;
let port = 0;
let admin: WebSocket;
let adminMsgs: any[] = [];

async function waitFor<T>(fn: () => T | undefined, ms = 3000, label = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`waitFor 超时: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function connect(token: string, clientId?: string): Promise<{ ws: WebSocket; msgs: any[] }> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws?token=${token}${clientId ? `&clientId=${clientId}` : ""}`;
    const ws = new WebSocket(url);
    const msgs: any[] = [];
    ws.on("message", (d) => { try { msgs.push(JSON.parse(String(d))); } catch { /* ignore */ } });
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("error", reject);
  });
}

beforeAll(async () => {
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
  initWebSocketServer(server);
  const conn = await connect("good", "c-lt4");
  admin = conn.ws;
  adminMsgs = conn.msgs;
  await waitFor(() => adminMsgs.find((m) => m.type === "snapshot"), 5000, "首帧 snapshot");
});

afterAll(async () => {
  try { admin?.close(); } catch { /* ignore */ }
  try { (server as any).closeAllConnections?.(); } catch { /* ignore */ }
  await Promise.race([
    new Promise<void>((r) => server.close(() => r())),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
});

describe("WS 快照降级", () => {
  it("某设备状态查询抛错 → 该设备 available:false,快照仍完整发出", () => {
    // 为什么:单个设备离线/超时不能让整帧 snapshot 失败,否则客户端拿不到任何设备。
    const snapshot = adminMsgs.find((m) => m.type === "snapshot");
    expect(snapshot).toBeTruthy();
    expect(snapshot.devices["d-err"]).toEqual({ name: "坏设备", available: false });
  });
});

describe("WS 事件转发长尾", () => {
  it("media_changed → 转发 media_changed(设备可见)", async () => {
    const before = adminMsgs.filter((m) => m.type === "media_changed").length;
    getEventManager().emit("media_changed", "d-err", { title: "曲目", artist: "艺人" });
    await waitFor(() => adminMsgs.filter((m) => m.type === "media_changed").length > before, 3000, "media_changed");
    const msg = adminMsgs.filter((m) => m.type === "media_changed").pop();
    expect(msg.device_id).toBe("d-err");
    expect(msg.media).toMatchObject({ title: "曲目" });
  });

  it("player_refresh → 转发 player_refresh + reason(起播信号)", async () => {
    const before = adminMsgs.filter((m) => m.type === "player_refresh").length;
    getEventManager().emit("player_refresh", "d-err", { reason: "started" });
    await waitFor(() => adminMsgs.filter((m) => m.type === "player_refresh").length > before, 3000, "player_refresh");
    const msg = adminMsgs.filter((m) => m.type === "player_refresh").pop();
    expect(msg).toMatchObject({ device_id: "d-err", reason: "started" });
  });

  it("peer_volume_changed → 转发 peer_id(打码)/volume/muted", async () => {
    // 为什么:音量跨端同步错发/漏发都会让其它端的音量条与真实不一致。
    const rawPeerId = buildLocalPeerId(USER, "c-lt4");
    const before = adminMsgs.filter((m) => m.type === "peer_volume_changed").length;
    getPeerManager().emit("peer_volume_changed", rawPeerId, 0.42, true);
    await waitFor(() => adminMsgs.filter((m) => m.type === "peer_volume_changed").length > before, 3000, "peer_volume_changed");
    const msg = adminMsgs.filter((m) => m.type === "peer_volume_changed").pop();
    expect(msg.volume).toBe(0.42);
    expect(msg.muted).toBe(true);
    // 临时端 ID 绝不出服务端:这里应是不透明实例键(≠ 原始 peerId,且不含 clientId)
    expect(msg.peer_id).not.toBe(rawPeerId);
    expect(msg.peer_id).not.toContain("c-lt4");
    // 打码后形态:`local:<uid>:<不透明实例键>`
    expect(msg.peer_id).toMatch(new RegExp(`^local:${USER}:[0-9a-f]{12}$`));
  });

  it("随机歌曲歌单变动事件 → 广播给所有客户端(免轮询)", async () => {
    const before = adminMsgs.filter((m) => m.type === RANDOM_SONGS_CHANGED_EVENT).length;
    h.events.emit(RANDOM_SONGS_CHANGED_EVENT, "pl-lt4");
    await waitFor(() => adminMsgs.filter((m) => m.type === RANDOM_SONGS_CHANGED_EVENT).length > before, 3000, "random_songs_changed");
    const msg = adminMsgs.filter((m) => m.type === RANDOM_SONGS_CHANGED_EVENT).pop();
    expect(msg.playlistId).toBe("pl-lt4");
  });
});
