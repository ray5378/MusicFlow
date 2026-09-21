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
//   { type: "peer_volume_changed",  peer_id, volume, muted }
//     —— sendspin 设备音量/静音变化(用户在 Web/HA/客户端改音量后即时同步到
//        其它端的音量条,不必等下一次 /status 轮询)。非 sendspin 设备不广播。
//   { type: "peer_command",         peer_id, action, payload }
//     —— **定向**消息(只发给 peer_id 对应的那个本机实例,见 sendToLocalPeer),
//        Web/HA 遥控安卓/Windows 客户端的通道:action ∈ play|pause|stop|next|prev|seek|volume。
//        接收端按自身实例身份执行;权威队列变更另由 peer_queue_changed 广播 + updatedAt 仲裁。
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
import { sanitizeClientId, maskLocalPeerId, buildLocalPeerId, clientIdOfLocalPeer, userIdOfLocalPeer } from "../../utils/peerId.js";
import {
  canUseRenderer,
  peerVisibleTo,
  decoratePeersForClient,
} from "../access.js";
import { isPeerHidden } from "../playerPrefs.js";
import { createLogger } from "../../utils/logger.js";
import {
  randomSongsEvents,
  RANDOM_SONGS_CHANGED_EVENT,
} from "../plugin/randomSongs.js";

// 模块级 logger:WS 事件的转发回调(subscribeAndForward)在顶层函数里,
// 拿不到 initWebSocketServer 内部的局部 logger,故统一提到模块级。
const log = createLogger("ws");

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
    if (url.pathname !== "/ws") {
      log.info(`upgrade ignored path=${url.pathname} from=${req.socket.remoteAddress}`);
      return; // other upgrades handled elsewhere
    }
    const token = url.searchParams.get("token") || "";
    const user = authenticateWsToken(token);
    if (!user) {
      log.warn(`upgrade 401 from=${req.socket.remoteAddress} tokenLen=${token.length} q=${url.searchParams.toString().slice(0, 120)}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // 客户端实例的临时端 ID(?clientId=)—— 与 /v1/peers 同款,本机 peer 快照
    // 只回给发起连接的这个实例,同账号其它标签页/客户端互不可见。
    const clientId = sanitizeClientId(url.searchParams.get("clientId"));
    log.info(`upgrade ok from=${req.socket.remoteAddress} clientId=${clientId ?? "-"} raw=${url.searchParams.get("clientId") ?? "-"}`);
    wss!.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).__user = user;
      (ws as any).__clientId = clientId;
      wss!.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    // 连接身份快照:遥控本机实例靠 (userId, clientId) 定向投递,新连接没带上
    // clientId 就永远收不到指令 —— 出现「能看状态、按钮无反应」时先看这行。
    log.info(`ws open user=${(ws as any).__user?.id ?? "-"} clientId=${(ws as any).__clientId ?? "-"} total=${wss!.clients.size}`);
    ws.on("close", () => {
      log.info(`ws close clientId=${(ws as any).__clientId ?? "-"} total=${wss!.clients.size}`);
      // 该实例的**最后一条**连接关闭 → 立即标离线(不等心跳空闲扫描)。
      // 否则客户端切换器里会残留一条已关闭的 Web 播放器/客户端。同一 clientId
      // 的其它连接(同浏览器多标签页共享 clientId)还在时不算离线。
      const u = (ws as any).__user;
      const cid = (ws as any).__clientId;
      if (u?.id && cid && countLiveConnections(u.id, cid, ws) === 0) {
        getPeerManager().markLocalOfflineByClient(u.id, cid);
      }
    });
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
  const clientId: string | null = (ws as any).__clientId ?? null;
  const raw = getPeerManager().listWithQueues().map(p => ({ ...p, queue: summarizeQueue(p.queue) }));
  // 与 /v1/peers 走**同一个出口函数**(顺序:可见性 → 打码/self → 按用户级隐藏 → 改名),
  // 避免两处各写一遍先后顺序而再度错位。
  const peers = decoratePeersForClient(raw, user?.id ?? "", !!user?.isAdmin, clientId);
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

  // 设备状态/队列事件:管理员全量;非 admin 只收到被授权设备(dlna:/airplay:/sendspin: 授权)
  // 的事件,其余不推送(避免泄漏别人播放器的状态)。
  const canSeeDevice = (deviceId: string) =>
    !user || user.isAdmin
    || canUseRenderer(user.id, false, `dlna:${deviceId}`)
    || canUseRenderer(user.id, false, `airplay:${deviceId}`)
    || canUseRenderer(user.id, false, `sendspin:${deviceId}`);
  const onState = (deviceId: string, st: any) => {
    if (!canSeeDevice(deviceId)) return;
    const media = getCurrentMedia(deviceId);
    // debug:推给前端的最终状态 —— 进度条「拖动后跳回」是前端渲染 vs 服务端权威值
    // 的分歧,而服务端权威值就是以这一行为准(前端进度条按 pos/dur 渲染)。
    // 拖动瞬间若看到 pos 从目标值掉回旧值,说明回退发生在服务端外推/上报侧,
    // 而不是前端 UI 层;反之则前端没接受这个值。
    log.debug(`[ws][state] ${deviceId} state=${st?.state ?? "-"} pos=${Math.round(st?.position ?? 0)} dur=${Math.round(st?.duration ?? 0)} track=${media?.title ?? "-"}`);
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
  // 权限:转发「同账号的全部本机实例 + 被授权的设备/群组」事件 —— 与 /v1/peers
  // 同一口径(peerVisibleTo)。「播放器」页要按「客户端」/「Web 播放器」把同账号
  // 多个端各列一行,状态必须能实时跟到;别账号的本机播放器仍不转发。
  // 事件里的 peerId 同样要打码(maskLocalPeerId),临时端 ID 不出服务端。
  const clientId: string | null = (ws as any).__clientId ?? null;
  const canSeePeer = (peerId?: string) =>
    !isPeerHidden(user?.id ?? "", peerId || "")
    && peerVisibleTo(user?.id ?? "", !!user?.isAdmin, peerId || "", clientId);
  const masked = (peer: any) => (peer ? { ...peer, peerId: maskLocalPeerId(peer.peerId) } : peer);
  const onPeerRegistered = (peer: any) => { if (canSeePeer(peer?.peerId)) send(ws, { type: "peer_registered", peer: masked(peer) }); };
  const onPeerAvailable = (peer: any) => { if (canSeePeer(peer?.peerId)) send(ws, { type: "peer_available", peer: masked(peer) }); };
  const onPeerUnavailable = (peer: any) => { if (canSeePeer(peer?.peerId)) send(ws, { type: "peer_unavailable", peer: masked(peer) }); };
  const onPeerQueue = (peerId: string, queue: any) => { if (canSeePeer(peerId)) send(ws, { type: "peer_queue_changed", peer_id: maskLocalPeerId(peerId), queue: summarizeQueue(queue) }); };
  const onPeerQueueCleared = (peerId: string) => { if (canSeePeer(peerId)) send(ws, { type: "peer_queue_cleared", peer_id: maskLocalPeerId(peerId) }); };
  // 音量/静音变化:与队列事件同口径(可见性过滤 + 打码),让同账号其它端的
  // 音量条实时跟随,无需等 /status 轮询。非 sendspin 设备不发此事件。
  const onPeerVolume = (peerId: string, volume: number, muted: boolean) => {
    if (canSeePeer(peerId)) send(ws, { type: "peer_volume_changed", peer_id: maskLocalPeerId(peerId), volume, muted });
  };

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
  pm.on("peer_volume_changed", onPeerVolume);
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
  unsubs.push(() => pm.off("peer_volume_changed", onPeerVolume));
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

/**
 * 统计某个本机实例(userId + clientId)当前还活着几条 WS 连接。
 *
 * 为什么需要它:`mf_client_id` 存在 localStorage,同浏览器**多个标签页共用同一个
 * clientId**,因此「关掉一个标签页」≠「这个端下线」——必须按连接数引用计数,
 * 归零才算真走。WS close 回调与 `POST /v1/peers/:peerId/offline` 共用这一个
 * 判定,避免两处各写一套导致口径不一致。
 *
 * @param exclude 排除某条连接(WS close 回调里要排掉**正在关闭的那条自己**;
 *                HTTP 下线端点没有 WS 身份,传 undefined 即可)。
 */
export function countLiveConnections(userId: string, clientId: string, exclude?: unknown): number {
  if (!wss || !userId || !clientId) return 0;
  let n = 0;
  for (const c of wss.clients as Iterable<any>) {
    if (exclude !== undefined && c === exclude) continue;
    if (c.readyState !== WebSocket.OPEN) continue;
    if (c.__user?.id === userId && c.__clientId === clientId) n++;
  }
  return n;
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

/**
 * 向「某个用户的所有连接」推送 —— 用于**用户私有**状态的跨端同步。
 *
 * 典型场景:收藏(我喜欢)是 per-user 的(userFavoriteSongs),用户在 Web 端点红心后,
 * 同账号的其它播放端(Windows / 安卓客户端、其它标签页)的那颗红心也该亮起来。
 * 这类消息绝不能 broadcastToClients —— 那会把 A 的收藏变动推给 B 的连接。
 *
 * @returns 实际投递到的连接数
 */
export function sendToUser(userId: string, msg: unknown): number {
  if (!wss || !userId) return 0;
  let n = 0;
  for (const client of wss.clients as Iterable<any>) {
    if (client.__user?.id !== userId) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    send(client, msg);
    n++;
  }
  return n;
}

/**
 * 向「某个本机实例」定向推送 —— 按 userId + clientId 精确匹配连接。
 *
 * 用途:Web / HA 遥控另一台客户端(安卓 / Windows)时,把指令或权威状态推给
 * **目标实例自己**,而不是广播。广播会把指令也送回 Web 端自己,形成
 * 「服务端→客户端→客户端上报→服务端再广播」的回环。
 *
 * clientId 必须**精确匹配**:缺失时一律不投递(peerId 是旧格式 `local:<uid>`、
 * 或旧客户端从未上报 clientId)。宁可下发失败,也不能把指定给某台客户端的指令
 * 误送给同账号的其它连接(网页标签页也在同一账号下)。
 *
 * @returns 实际投递到的连接数;0 = 目标离线,调用方据此回 delivered:false
 */
export function sendToLocalInstance(userId: string, clientId: string | null, msg: unknown): number {
  if (!wss || !userId || !clientId) return 0;
  const targets = pickInstanceConnections(wss.clients as Iterable<any>, userId, clientId);
  for (const ws of targets) send(ws, msg);
  return targets.length;
}

/**
 * 从连接集合里挑出「指定用户的指定实例」的连接 —— 纯函数,便于单测。
 * 匹配规则见 sendToLocalInstance 注释:userId 与 clientId 都必须精确相等,
 * clientId 为空直接返回空集(不做「发全部连接」的降级)。
 */
export function pickInstanceConnections<T extends { __user?: WsUser; __clientId?: string | null }>(
  clients: Iterable<T>,
  userId: string,
  clientId: string | null,
): T[] {
  if (!userId || !clientId) return [];
  const out: T[] = [];
  for (const c of clients) {
    const u = c.__user;
    if (!u || u.id !== userId) continue;
    if ((c.__clientId ?? null) !== clientId) continue;
    out.push(c);
  }
  return out;
}

/** 按 peerId(内部规范形式 `local:<uid>[:<clientId>]`)定向下发。0 = 目标离线。 */
export function sendToLocalPeer(peerId: string, msg: unknown): number {
  if (!peerId || !peerId.startsWith("local:")) return 0;
  return sendToLocalInstance(userIdOfLocalPeer(peerId) ?? "", clientIdOfLocalPeer(peerId), msg);
}
