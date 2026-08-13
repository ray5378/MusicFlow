// WebSocket endpoint: pushes DLNA player state changes to HA (and any other
// long-lived client) in real time, mirroring MA's `/websocket` JSON-RPC
// channel. The HA integration subscribes here instead of polling
// /api/v1/dlna/devices/:id/status.
//
// Message protocol (JSON, one per frame):
//   { type: "snapshot", devices: { <deviceId>: <DeviceStatus+media+name>, ... } }
//   { type: "player_state_changed", device_id, state: <DeviceEventState> }
//   { type: "media_changed",        device_id, media: <CurrentMedia> }
//   { type: "queue_changed",        device_id, queue: <QueueSnapshot> }
//   { type: "device_list_changed",  deviceCount: number }
//
// Peer events (unified player switcher):
//   { type: "peer_snapshot",        peers: <PeerWithQueue[]> }
//   { type: "peer_registered",      peer: <Peer> }
//   { type: "peer_available",       peer: <Peer> }
//   { type: "peer_unavailable",     peer: <Peer> }
//   { type: "peer_queue_changed",   peer_id, queue: <QueueSnapshot> }
//   { type: "peer_queue_cleared",   peer_id }
//
// Auth: ?token=<apiKey|jwt> on the upgrade URL. The same Bearer logic as
// auth.ts (JWT first, then API key) applies, so HA integrations present the
// user's long-lived apiKey here.
//
// Mounting: index.ts attaches the upgrade handler to the underlying
// http.Server from @hono/node-server (see initWebSocketServer).
import { WebSocketServer, WebSocket } from "ws";
import { getEventManager } from "../dlna/eventing.js";
import { getQueueManager } from "../dlna/queue.js";
import {
  getCachedDevices,
  getDeviceStatus,
  getCurrentMedia,
} from "../dlna/control.js";
import { getPeerManager } from "../peer.js";
import { getGroupManager } from "../group/index.js";
import { authenticateWsToken } from "./auth.js";

let wss: WebSocketServer | null = null;

export function initWebSocketServer(server: import("http").Server): void {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") return; // other upgrades handled elsewhere
    const token = url.searchParams.get("token") || "";
    const user = authenticateWsToken(token);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    // Initial snapshot so the client has full state before any delta events.
    sendSnapshot(ws).catch(() => {});
    sendPeerSnapshot(ws);
    const unsub = subscribeAndForward(ws);
    ws.on("close", unsub);
    ws.on("error", unsub);
    // App-level keepalive: clients (HA card) send {"type":"ping"} every 25s to
    // keep the WS busy so proxies/firewalls don't kill it for idleness when no
    // DLNA device is playing (no events flowing). Reply with a pong.
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg && msg.type === "ping") send(ws, { type: "pong" });
      } catch { /* ignore malformed frames */ }
    });
  });
}

// Build + send the initial full-state snapshot once per new connection.
async function sendSnapshot(ws: WebSocket): Promise<void> {
  const devices: Record<string, any> = {};
  for (const d of getCachedDevices()) {
    if (!d.available) continue;
    if (d.disabled) continue; // 禁用设备不推送给任何客户端(卡片/Web)
    try {
      const status = await getDeviceStatus(d.id);
      devices[d.id] = { ...status, name: d.name, available: d.available };
    } catch {
      devices[d.id] = { name: d.name, available: false };
    }
  }
  send(ws, { type: "snapshot", devices });
}

// Send the current peer list (with queue snapshots) so a freshly connected
// client can populate the player switcher immediately.
function sendPeerSnapshot(ws: WebSocket): void {
  send(ws, { type: "peer_snapshot", peers: getPeerManager().listWithQueues().map(p => ({ ...p, queue: summarizeQueue(p.queue) })) });
}

// 大队列摘要:items 超过阈值时 WS 只推元数据(total/currentIndex/playMode),
// 客户端(卡片/Web)按需走 /v1/peers/:peerId/queue?offset=&size= 分块拉取。
// 阈值与卡片 CHUNK 一致;小队列保持全量推送(兼容旧客户端)。所有模式都带 total,
// 客户端统一用 total ?? items.length。
const QUEUE_WS_CAP = 200;
function summarizeQueue(q: any): any {
  if (!q || !Array.isArray(q.items)) return q;
  const total = q.items.length;
  if (total <= QUEUE_WS_CAP) return { ...q, total };
  return { ...q, total, items: [] };
}

// Subscribe to all relevant event emitters and forward as WS messages.
function subscribeAndForward(ws: WebSocket): () => void {
  const em = getEventManager();
  const qm = getQueueManager();
  const pm = getPeerManager();
  const gm = getGroupManager();
  const unsubs: Array<() => void> = [];

  const onState = (deviceId: string, st: any) => {
    const media = getCurrentMedia(deviceId);
    send(ws, { type: "player_state_changed", device_id: deviceId, state: { ...st, media } });
  };
  const onMedia = (deviceId: string, media: any) => {
    send(ws, { type: "media_changed", device_id: deviceId, media });
  };
  const onQueue = (deviceId: string, queue: any) => {
    send(ws, { type: "queue_changed", device_id: deviceId, queue: summarizeQueue(queue) });
  };
  const onDeviceList = (deviceCount: number) => {
    send(ws, { type: "device_list_changed", deviceCount });
  };

  // Peer events: forward registration/availability/queue changes so the Web
  // client's player switcher stays live without polling /v1/peers.
  const onPeerRegistered = (peer: any) => send(ws, { type: "peer_registered", peer });
  const onPeerAvailable = (peer: any) => send(ws, { type: "peer_available", peer });
  const onPeerUnavailable = (peer: any) => send(ws, { type: "peer_unavailable", peer });
  const onPeerQueue = (peerId: string, queue: any) => send(ws, { type: "peer_queue_changed", peer_id: peerId, queue: summarizeQueue(queue) });
  const onPeerQueueCleared = (peerId: string) => send(ws, { type: "peer_queue_cleared", peer_id: peerId });

  // Group events: 组创建/改名/成员变更 → 前端群组页刷新;组删除 → 移除条目。
  const onGroupChanged = (group: any) => send(ws, { type: "group_changed", group });
  const onGroupDeleted = (id: string) => send(ws, { type: "group_deleted", id });

  em.on("state_changed", onState);
  em.on("media_changed", onMedia);
  em.on("device_list_changed", onDeviceList);
  qm.on("queue_changed", onQueue);
  pm.on("peer_registered", onPeerRegistered);
  pm.on("peer_available", onPeerAvailable);
  pm.on("peer_unavailable", onPeerUnavailable);
  pm.on("peer_queue_changed", onPeerQueue);
  pm.on("peer_queue_cleared", onPeerQueueCleared);
  gm.on("group_created", onGroupChanged);
  gm.on("group_updated", onGroupChanged);
  gm.on("group_deleted", onGroupDeleted);

  unsubs.push(() => em.off("state_changed", onState));
  unsubs.push(() => em.off("media_changed", onMedia));
  unsubs.push(() => em.off("device_list_changed", onDeviceList));
  unsubs.push(() => qm.off("queue_changed", onQueue));
  unsubs.push(() => pm.off("peer_registered", onPeerRegistered));
  unsubs.push(() => pm.off("peer_available", onPeerAvailable));
  unsubs.push(() => pm.off("peer_unavailable", onPeerUnavailable));
  unsubs.push(() => pm.off("peer_queue_changed", onPeerQueue));
  unsubs.push(() => pm.off("peer_queue_cleared", onPeerQueueCleared));
  unsubs.push(() => gm.off("group_created", onGroupChanged));
  unsubs.push(() => gm.off("group_updated", onGroupChanged));
  unsubs.push(() => gm.off("group_deleted", onGroupDeleted));

  return () => unsubs.forEach((u) => u());
}

function send(ws: WebSocket, msg: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
