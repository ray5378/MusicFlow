// WebSocket endpoint: pushes DLNA player state changes to HA (and any other
// long-lived client) in real time, mirroring MA's `/websocket` JSON-RPC
// channel. The HA integration subscribes here instead of polling
// /api/v1/dlna/devices/:id/status.
//
// Message protocol (JSON, one per frame):
//   { type: "snapshot", devices: { <deviceId>: <DeviceStatus+media+name>, ... } }
//   { type: "player_state_changed", device_id, state: <DeviceEventState> }
//   { type: "media_changed",        device_id, media: <CurrentMedia> }
//   { type: "player_refresh",       device_id, reason: <string> }  // 起播信号,客户端应强制拉取最新状态
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
import { authenticateWsToken, WsUser } from "./auth.js";
import {
  canUseRenderer,
  canControlPeer,
  filterPeersByAccess,
} from "../access.js";
import {
  getHiddenPeerIds,
  getNameOverrides,
  isPeerHidden,
} from "../playerPrefs.js";
import {
  randomSongsEvents,
  RANDOM_SONGS_CHANGED_EVENT,
} from "../plugin/randomSongs.js";

let wss: WebSocketServer | null = null;

export function initWebSocketServer(server: import("http").Server): void {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true });

  // 「随机歌曲」歌单变动广播:插件(后台定时 / 惰性刷新)重建歌单后 emit,
  // 此处转发给所有已连接客户端,客户端收到后按需重拉歌单,不再轮询。
  randomSongsEvents.on(RANDOM_SONGS_CHANGED_EVENT, (playlistId: unknown) => {
    broadcastToClients({ type: RANDOM_SONGS_CHANGED_EVENT, playlistId });
  });

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
      (ws as any).__user = user;
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
// 权限:非 admin 只推送被授权设备(dlna:<id>)的状态;无授权则空快照。
async function sendSnapshot(ws: WebSocket): Promise<void> {
  const user: WsUser | undefined = (ws as any).__user;
  const devices: Record<string, any> = {};
  for (const d of getCachedDevices()) {
    if (!d.available) continue;
    if (d.disabled) continue; // 禁用设备不推送给任何客户端(卡片/Web)
    if (user && !user.isAdmin && !canUseRenderer(user.id, false, `dlna:${d.id}`)) continue;
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
// 权限:管理员全量;非 admin 只看到自己的本机播放器 + 被授权的设备/群组
// (与 /v1/peers 一致,filterPeersByAccess)。
function sendPeerSnapshot(ws: WebSocket): void {
  const user: WsUser | undefined = (ws as any).__user;
  let peers = getPeerManager().listWithQueues().map(p => ({ ...p, queue: summarizeQueue(p.queue) }));
  peers = filterPeersByAccess(user?.id ?? "", !!user?.isAdmin, peers);
  // 与 /v1/peers 完全对齐:剪掉该用户隐藏的 peer,并套用其显示名覆盖。
  const hidden = getHiddenPeerIds(user?.id ?? "");
  if (hidden.size > 0) peers = peers.filter((p) => !hidden.has(p.peerId));
  const nameOverrides = getNameOverrides(user?.id ?? "");
  if (nameOverrides.size > 0) {
    peers = peers.map((p) => {
      const override = nameOverrides.get(p.peerId);
      return override ? { ...p, name: override } : p;
    });
  }
  send(ws, { type: "peer_snapshot", peers });
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
  const user: WsUser | undefined = (ws as any).__user;

  // 设备状态/队列事件:管理员全量;非 admin 只收到被授权设备(dlna:/airplay: 授权)
  // 的事件,其余不推送(避免泄漏别人播放器的状态)。
  const canSeeDevice = (deviceId: string) =>
    !user || user.isAdmin
    || canUseRenderer(user.id, false, `dlna:${deviceId}`)
    || canUseRenderer(user.id, false, `airplay:${deviceId}`);
  const onState = (deviceId: string, st: any) => {
    if (!canSeeDevice(deviceId)) return;
    const media = getCurrentMedia(deviceId);
    send(ws, { type: "player_state_changed", device_id: deviceId, state: { ...st, media } });
  };
  const onMedia = (deviceId: string, media: any) => {
    if (!canSeeDevice(deviceId)) return;
    send(ws, { type: "media_changed", device_id: deviceId, media });
  };
  const onPlayerRefresh = (deviceId: string, info: any) => {
    if (!canSeeDevice(deviceId)) return;
    send(ws, { type: "player_refresh", device_id: deviceId, reason: info?.reason });
  };
  const onQueue = (deviceId: string, queue: any) => {
    if (!canSeeDevice(deviceId)) return;
    send(ws, { type: "queue_changed", device_id: deviceId, queue: summarizeQueue(queue) });
  };
  const onDeviceList = (deviceCount: number) => {
    // 设备列表变化属播放器管理信息,非 admin 不推送。
    if (!user || user.isAdmin) send(ws, { type: "device_list_changed", deviceCount });
  };

  // Peer events: forward registration/availability/queue changes so the Web
  // client's player switcher stays live without polling /v1/peers.
  // 权限:非 admin 只转发「自己的本机 peer + 被授权的设备/群组」事件(canControlPeer)。
  const canSeePeer = (peerId?: string) =>
    !isPeerHidden(user?.id ?? "", peerId || "")
    && canControlPeer(user?.id ?? "", !!user?.isAdmin, peerId || "");
  const onPeerRegistered = (peer: any) => { if (canSeePeer(peer?.peerId)) send(ws, { type: "peer_registered", peer }); };
  const onPeerAvailable = (peer: any) => { if (canSeePeer(peer?.peerId)) send(ws, { type: "peer_available", peer }); };
  const onPeerUnavailable = (peer: any) => { if (canSeePeer(peer?.peerId)) send(ws, { type: "peer_unavailable", peer }); };
  const onPeerQueue = (peerId: string, queue: any) => { if (canSeePeer(peerId)) send(ws, { type: "peer_queue_changed", peer_id: peerId, queue: summarizeQueue(queue) }); };
  const onPeerQueueCleared = (peerId: string) => { if (canSeePeer(peerId)) send(ws, { type: "peer_queue_cleared", peer_id: peerId }); };

  // Group events: 组创建/改名/成员变更 → 前端群组页刷新;组删除 → 移除条目。
  // 权限:群组属于播放器管理,非 admin 不转发。
  const onGroupChanged = (group: any) => { if (!user || user.isAdmin) send(ws, { type: "group_changed", group }); };
  const onGroupDeleted = (id: string) => { if (!user || user.isAdmin) send(ws, { type: "group_deleted", id }); };

  em.on("state_changed", onState);
  em.on("media_changed", onMedia);
  em.on("player_refresh", onPlayerRefresh);
  em.on("device_list_changed", onDeviceList);
  qm.on("queue_changed", onQueue);
  qm.on("media_changed", onMedia);
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
  unsubs.push(() => em.off("player_refresh", onPlayerRefresh));
  unsubs.push(() => em.off("device_list_changed", onDeviceList));
  unsubs.push(() => qm.off("queue_changed", onQueue));
  unsubs.push(() => qm.off("media_changed", onMedia));
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

/** 向所有已连接客户端广播(供后台任务进度等全局事件推送,如匹配进度)。 */
export function broadcastToClients(msg: any): void {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }
}
