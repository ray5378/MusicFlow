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
    const unsub = subscribeAndForward(ws);
    ws.on("close", unsub);
    ws.on("error", unsub);
  });
}

// Build + send the initial full-state snapshot once per new connection.
async function sendSnapshot(ws: WebSocket): Promise<void> {
  const devices: Record<string, any> = {};
  for (const d of getCachedDevices()) {
    if (!d.available) continue;
    try {
      const status = await getDeviceStatus(d.id);
      devices[d.id] = { ...status, name: d.name, available: d.available };
    } catch {
      devices[d.id] = { name: d.name, available: false };
    }
  }
  send(ws, { type: "snapshot", devices });
}

// Subscribe to all relevant event emitters and forward as WS messages.
function subscribeAndForward(ws: WebSocket): () => void {
  const em = getEventManager();
  const qm = getQueueManager();
  const unsubs: Array<() => void> = [];

  const onState = (deviceId: string, st: any) => {
    const media = getCurrentMedia(deviceId);
    send(ws, { type: "player_state_changed", device_id: deviceId, state: { ...st, media } });
  };
  const onMedia = (deviceId: string, media: any) => {
    send(ws, { type: "media_changed", device_id: deviceId, media });
  };
  const onQueue = (deviceId: string, queue: any) => {
    send(ws, { type: "queue_changed", device_id: deviceId, queue });
  };
  const onDeviceList = (deviceCount: number) => {
    send(ws, { type: "device_list_changed", deviceCount });
  };

  em.on("state_changed", onState);
  em.on("media_changed", onMedia);
  em.on("device_list_changed", onDeviceList);
  qm.on("queue_changed", onQueue);

  unsubs.push(() => em.off("state_changed", onState));
  unsubs.push(() => em.off("media_changed", onMedia));
  unsubs.push(() => em.off("device_list_changed", onDeviceList));
  unsubs.push(() => qm.off("queue_changed", onQueue));

  return () => unsubs.forEach((u) => u());
}

function send(ws: WebSocket, msg: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
