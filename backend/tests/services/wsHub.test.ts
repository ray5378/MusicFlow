// WebSocket 集线器契约测试(HA 卡片 / Web / 客户端的实时通道):
//   - upgrade 鉴权(无效 token 必须 401,非 /ws 路径不得接管)
//   - 首帧快照(snapshot / peer_snapshot)
//   - 权限过滤(非 admin 且未授权的设备状态不得外泄)
//   - 定向推送(用户级 / 实例级 / peer 级)与广播
//   - 大队列摘要(items 超阈值只推元数据)
// 这里的任何一条错了,表现都是「卡片点不动 / 状态不刷新 / 别人的播放器出现在我的列表里」。
//
// 注意:vitest 开了 sequence.shuffle,测试之间**不能**有顺序依赖 —— 长连接一律在
// beforeAll 建立,各用例只做断言。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import { WebSocket } from "ws";

const h = vi.hoisted(() => ({
  user: null as null | { id: string; isAdmin: boolean },
  devices: [] as Array<{ id: string; name: string; available: boolean; disabled?: boolean }>,
  statuses: new Map<string, any>(),
  media: new Map<string, any>(),
  canSeeDevice: true,
  peerVisible: true,
}));

vi.mock("../../src/services/ws/auth.js", () => ({
  authenticateWsToken: (token: string) => (token === "good" ? h.user : null),
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  getCachedDevices: () => h.devices,
  getDeviceStatus: async (id: string) => h.statuses.get(id) ?? { state: "stopped", position: 0 },
  getCurrentMedia: (id: string) => h.media.get(id) ?? null,
  getEffectiveBaseUrl: () => "http://127.0.0.1:1",
}));

vi.mock("../../src/services/access.js", () => ({
  canUseRenderer: (_uid: string, _admin: boolean, _peer: string) => h.canSeeDevice,
  peerVisibleTo: (_uid: string, _admin: boolean, _peer: string, _clientId: string | null) => h.peerVisible,
  decoratePeersForClient: (peers: any[]) => peers,
}));

vi.mock("../../src/services/plugin/randomSongs.js", async (imp) => {
  // 保留真实导出(别的模块还要 randomSongsManifest / randomSongsPlugin),
  // 只把事件总线换成桩:测试里不需要真跑惰性刷新定时器。
  const real: any = await imp();
  return { ...real, randomSongsEvents: { on: () => () => {} } };
});

import {
  initWebSocketServer,
  broadcastToClients,
  sendToUser,
  sendToLocalInstance,
  sendToLocalPeer,
  countLiveConnections,
} from "../../src/services/ws/index.js";
import { getEventManager } from "../../src/services/dlna/eventing.js";
import { getQueueManager } from "../../src/services/dlna/queue.js";
import { getPeerManager } from "../../src/services/peer.js";
import { getGroupManager } from "../../src/services/group/index.js";
import { buildLocalPeerId } from "../../src/utils/peerId.js";

const USER = "u-ws-test";
const CLIENT = "c-ws-test";

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
    ws.on("message", (d) => {
      try {
        msgs.push(JSON.parse(String(d)));
      } catch {
        /* ignore malformed */
      }
    });
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("error", reject);
  });
}

beforeAll(async () => {
  h.user = { id: USER, isAdmin: true };
  h.canSeeDevice = true;
  h.peerVisible = true;
  h.devices = [
    { id: "d-on", name: "客厅", available: true },
    { id: "d-off", name: "卧室", available: false },
    { id: "d-disabled", name: "禁用设备", available: true, disabled: true },
  ];
  h.statuses.set("d-on", { state: "playing", position: 12, duration: 200 });
  h.media.set("d-on", { title: "测试曲", artist: "测试歌手" });

  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
  initWebSocketServer(server);

  const conn = await connect("good", CLIENT);
  admin = conn.ws;
  adminMsgs = conn.msgs;
  await waitFor(() => adminMsgs.find((m) => m.type === "snapshot"), 5000, "首帧 snapshot");
});

afterAll(async () => {
  try {
    admin?.close();
  } catch {
    /* ignore */
  }
  try {
    (server as any).closeAllConnections?.();
  } catch {
    /* ignore */
  }
  await Promise.race([
    new Promise<void>((r) => server.close(() => r())),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
});

describe("WS upgrade 鉴权与首帧快照", () => {
  it("无效 token → 连接被拒(401),不得建立会话", async () => {
    await expect(connect("bad")).rejects.toBeTruthy();
  });

  it("非 /ws 路径的 upgrade 不被接管(交给其它端点)", async () => {
    const raw = new WebSocket(`ws://127.0.0.1:${port}/other?token=good`);
    raw.on("error", () => {}); // 未被接管的 upgrade 最终会被 terminate,避免 unhandled error
    const opened = await Promise.race([
      new Promise<boolean>((res) => raw.on("open", () => res(true))),
      new Promise<boolean>((res) => setTimeout(() => res(false), 1500)),
    ]);
    try {
      raw.terminate();
    } catch {
      /* ignore */
    }
    expect(opened).toBe(false);
  });

  it("首帧 snapshot 只含在线且未禁用的设备", () => {
    const snapshot = adminMsgs.find((m) => m.type === "snapshot");
    expect(Object.keys(snapshot.devices)).toContain("d-on");
    expect(Object.keys(snapshot.devices)).not.toContain("d-off");
    expect(Object.keys(snapshot.devices)).not.toContain("d-disabled");
    expect(snapshot.devices["d-on"]).toMatchObject({ name: "客厅", available: true, state: "playing" });
  });

  it("首帧同时推送 peer_snapshot(播放器切换器据此初始化)", async () => {
    await waitFor(() => adminMsgs.find((m) => m.type === "peer_snapshot"), 3000, "peer_snapshot");
  });

  it("ping → pong(卡片每 25s 探活,断了就是代理掐连接)", async () => {
    admin.send(JSON.stringify({ type: "ping" }));
    const pong = await waitFor(() => adminMsgs.find((m) => m.type === "pong"), 3000, "pong");
    expect(pong.type).toBe("pong");
  });

  it("畸形帧不导致连接中断(后续仍能正常收发)", async () => {
    const before = adminMsgs.filter((m) => m.type === "pong").length;
    admin.send("not-json");
    admin.send(JSON.stringify({ type: "ping" }));
    await waitFor(
      () => adminMsgs.filter((m) => m.type === "pong").length > before,
      3000,
      "第二个 pong",
    );
  });
});

describe("WS 事件转发与权限过滤", () => {
  it("设备状态变化 → player_state_changed(带当前媒体)", async () => {
    const before = adminMsgs.filter((m) => m.type === "player_state_changed").length;
    getEventManager().emit("state_changed", "d-on", { state: "playing", position: 30, duration: 200 });
    await waitFor(
      () => adminMsgs.filter((m) => m.type === "player_state_changed").length > before,
      3000,
      "player_state_changed",
    );
    const msg = adminMsgs.filter((m) => m.type === "player_state_changed").pop();
    expect(msg.device_id).toBe("d-on");
    expect(msg.state.media).toMatchObject({ title: "测试曲" });
  });

  it("队列变化 → queue_changed;超过 200 条只推元数据(total 保留,items 清空)", async () => {
    const before = adminMsgs.filter((m) => m.type === "queue_changed").length;
    const big = { items: Array.from({ length: 250 }, (_, i) => ({ songId: `s${i}` })), currentIndex: 0 };
    getQueueManager().emit("queue_changed", "d-on", big);
    await waitFor(
      () => adminMsgs.filter((m) => m.type === "queue_changed").length > before,
      3000,
      "queue_changed",
    );
    const msg = adminMsgs.filter((m) => m.type === "queue_changed").pop();
    expect(msg.queue.total).toBe(250);
    expect(msg.queue.items).toEqual([]);
  });

  it("设备列表变化推给 admin;peer 事件的 peerId 必须打码", async () => {
    const beforeDev = adminMsgs.filter((m) => m.type === "device_list_changed").length;
    getEventManager().emit("device_list_changed", 3);
    await waitFor(
      () => adminMsgs.filter((m) => m.type === "device_list_changed").length > beforeDev,
      3000,
      "device_list_changed",
    );

    const peerId = buildLocalPeerId(USER, CLIENT);
    const beforeReg = adminMsgs.filter((m) => m.type === "peer_registered").length;
    getPeerManager().emit("peer_registered", { peerId });
    await waitFor(
      () => adminMsgs.filter((m) => m.type === "peer_registered").length > beforeReg,
      3000,
      "peer_registered",
    );
    const reg = adminMsgs.filter((m) => m.type === "peer_registered").pop();
    // 临时端 ID 绝不出服务端
    expect(reg.peer.peerId).not.toBe(peerId);

    const beforeCleared = adminMsgs.filter((m) => m.type === "peer_queue_cleared").length;
    getPeerManager().emit("peer_queue_cleared", peerId);
    await waitFor(
      () => adminMsgs.filter((m) => m.type === "peer_queue_cleared").length > beforeCleared,
      3000,
      "peer_queue_cleared",
    );
  });

  it("群组事件同样转发(前端群组页据此刷新)", async () => {
    const before = adminMsgs.filter((m) => m.type === "group_changed").length;
    getGroupManager().emit("group_created", { id: "g-1", name: "全屋" });
    await waitFor(
      () => adminMsgs.filter((m) => m.type === "group_changed").length > before,
      3000,
      "group_changed",
    );
    expect(adminMsgs.filter((m) => m.type === "group_changed").pop().group.name).toBe("全屋");
  });

  it("未授权的非 admin 连接收不到设备事件(别人的播放器状态不外泄)", async () => {
    h.user = { id: "u-other", isAdmin: false };
    h.canSeeDevice = false;
    const { ws, msgs } = await connect("good", "c-other");
    try {
      await waitFor(() => msgs.find((m) => m.type === "snapshot"), 3000, "other snapshot");
      const before = msgs.filter((m) => m.type === "player_state_changed").length;
      getEventManager().emit("state_changed", "d-on", { state: "playing" });
      await new Promise((r) => setTimeout(r, 300));
      expect(msgs.filter((m) => m.type === "player_state_changed").length).toBe(before);
      const snapshot = msgs.find((m) => m.type === "snapshot");
      expect(Object.keys(snapshot?.devices ?? {})).toHaveLength(0);
    } finally {
      ws.close();
      h.user = { id: USER, isAdmin: true };
      h.canSeeDevice = true;
    }
  });
});

describe("WS 定向推送与连接计数", () => {
  it("countLiveConnections 按 userId + clientId 精确计数", () => {
    expect(countLiveConnections(USER, CLIENT)).toBe(1);
    expect(countLiveConnections(USER, "no-such-client")).toBe(0);
  });

  it("broadcastToClients / sendToUser / sendToLocalInstance / sendToLocalPeer 都能投递", async () => {
    const mark = (via: string) => adminMsgs.some((m) => m.type === "probe" && m.via === via);

    broadcastToClients({ type: "probe", via: "broadcast" });
    await waitFor(() => mark("broadcast"), 3000, "broadcast");

    expect(sendToUser(USER, { type: "probe", via: "user" })).toBeGreaterThan(0);
    await waitFor(() => mark("user"), 3000, "sendToUser");

    expect(sendToLocalInstance(USER, CLIENT, { type: "probe", via: "instance" })).toBe(1);
    await waitFor(() => mark("instance"), 3000, "sendToLocalInstance");

    // clientId 缺失必须拒绝投递:宁可不下发,也不能误送给同账号的其它端
    expect(sendToLocalInstance(USER, null, { type: "probe", via: "none" })).toBe(0);

    expect(sendToLocalPeer(buildLocalPeerId(USER, CLIENT), { type: "probe", via: "peer" })).toBe(1);
    await waitFor(() => mark("peer"), 3000, "sendToLocalPeer");

    // 非 local: 前缀一律不投递
    expect(sendToLocalPeer("dlna:d-on", { type: "probe", via: "dlna" })).toBe(0);
  });

  it("sendToUser 不投递给别的用户(收藏红心不能串台)", () => {
    expect(sendToUser("u-nobody", { type: "probe", via: "nobody" })).toBe(0);
  });

  it("连接关闭后计数归零(切换器里不能残留已关闭的端)", async () => {
    const { ws } = await connect("good", "c-closing");
    await waitFor(() => countLiveConnections(USER, "c-closing") === 1, 3000, "conn up");
    await new Promise<void>((r) => {
      ws.on("close", () => r());
      ws.close();
    });
    await waitFor(() => countLiveConnections(USER, "c-closing") === 0, 3000, "conn down");
  });
});
