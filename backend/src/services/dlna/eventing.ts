// DLNA GENA (General Event Notification Architecture) event subscription.
//
// Subscribes to a device's AVTransport + RenderingControl services so the
// device pushes state changes (play/pause/stop/seek/volume) to us instead of
// us polling every few seconds. This is the "correct" UPnP way to track device
// state and is what Music Assistant / async_upnp_client do.
//
// Flow:
//   1. POST a SUBSCRIBE request to the service's eventSubURL with a CALLBACK
//      header pointing at our /rest/dlna/event/:deviceId/:service endpoint.
//   2. The device sends NOTIFY requests to that URL whenever state changes,
//      with a <LastChange> XML payload describing the new state.
//   3. We parse LastChange, update the device status cache, and notify the
//      control layer (which forwards to the frontend's poll response).
//   4. We re-subscribe (SUBSCRIBE with SID) before the timeout expires.
//
// If subscription fails for any reason, control.ts's shouldPollDevice() will
// keep returning true and the frontend falls back to SOAP polling — exactly
// the resilience MA has (force_poll=True on UpnpError).
import http from "http";
import { EventEmitter } from "events";
import { DlnaDevice } from "./discovery.js";
import { notifyTrackChanged } from "./control.js";

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";
const SUBSCRIBE_TIMEOUT_SEC = 300; // 5 min; many devices cap at 1800
const RENEW_MARGIN_MS = 30_000;    // renew 30s before expiry

// Extracted eventSubURL: we didn't parse it in discovery, so derive it from
// the control URL (same path prefix, usually the device serves GENA on the
// same or adjacent path). We try the control URL itself first — most devices
// accept SUBSCRIBE on the control URL.
function deriveEventUrl(device: DlnaDevice, service: string): string | undefined {
  // Heuristic: many devices use the control URL for both SOAP and GENA.
  // If the description.xml exposed an eventSubURL we'd prefer it, but since
  // we only stored the control URL, fall back to it. This works on the
  // majority of renderers (Bose, Sonos, VLC, BubbleUPnP, etc.).
  return service === AV_TRANSPORT ? device.avTransportUrl : device.renderingControlUrl;
}

export interface DeviceEventState {
  state?: string;       // PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING
  position?: number;
  duration?: number;
  volume?: number;
  updatedAt: number;
}

interface Subscription {
  deviceId: string;
  service: string;
  sid: string;          // subscription id assigned by device
  expiresAt: number;    // ms epoch
  renewTimer?: ReturnType<typeof setTimeout>;
}

class EventManager extends EventEmitter {
  private subs = new Map<string, Subscription>(); // key: deviceId|service
  private states = new Map<string, DeviceEventState>(); // key: deviceId
  private server?: http.Server;
  private listenPort = 0;
  private callbackBase = "";

  constructor() {
    super();
    // WS clients + queue manager + control layer may all subscribe; avoid
    // Node's default 10-listener warning.
    this.setMaxListeners(50);
  }

  /** Emit a device_list_changed event (called by control.ts refreshDevices). */
  emitDeviceListChanged(deviceCount: number): void {
    this.emit("device_list_changed", deviceCount);
  }

  // Lazily start the HTTP server that receives NOTIFY messages. Bound to the
  // same port as the Hono app would be ideal, but to keep this self-contained
  // we use a separate lightweight server on a dynamic port. The device
  // connects back to us, so the port must be reachable from the LAN.
  private async ensureServer(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleNotify(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "0.0.0.0", () => {
        const addr = this.server!.address();
        this.listenPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
    // Determine our LAN callback base. We let the device call back to the
    // same host it sees for SOAP (its control URL host is our server), plus
    // this dynamic port. Fall back to DLNA_EVENT_PORT env if set.
    this.callbackBase = process.env.DLNA_EVENT_BASE_URL || "";
  }

  private handleNotify(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "NOTIFY") { res.statusCode = 405; res.end(); return; }
    const url = req.url || "";
    // /rest/dlna/event/:deviceId/:serviceIndex  (0=AVTransport,1=RenderingControl)
    const parts = url.split("/");
    const deviceId = parts[parts.length - 2];
    const svcIdx = parts[parts.length - 1];
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", () => {
      res.statusCode = 200;
      res.end();
      this.parseLastChange(deviceId, svcIdx, body);
    });
  }

  // Parse the <LastChange> payload and update cached state. AVTransport events
  // carry transport state + position; RenderingControl events carry volume.
  private parseLastChange(deviceId: string, svcIdx: string, body: string) {
    try {
      // The NOTIFY body is a propertyset: <e:propertyset><e:property><LastChange>
      //   &lt;Event xmlns=&quot;...&quot;&gt;&lt;InstanceID&gt;...&lt;/InstanceID&gt;&lt;/Event&gt;
      // </LastChange></e:property></e:propertyset>
      // LastChange content is XML-escaped, so we unescape it first.
      const lcMatch = body.match(/<LastChange>([\s\S]*?)<\/LastChange>/i);
      if (!lcMatch) return;
      const inner = lcMatch[1]
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      const prev = this.states.get(deviceId) || { updatedAt: 0 };
      const st: DeviceEventState = { ...prev, updatedAt: Date.now() };
      if (svcIdx === "0") {
        // AVTransport
        const transportState = inner.match(/<TransportState[^>]*value="([^"]*)"/i)?.[1];
        const relTime = inner.match(/<RelTime[^>]*value="([^"]*)"/i)?.[1];
        const trackDur = inner.match(/<TrackDuration[^>]*value="([^"]*)"/i)?.[1];
        const currentTrack = inner.match(/<CurrentTrackURI[^>]*value="([^"]*)"/i)?.[1];
        if (transportState) st.state = transportState;
        if (relTime && relTime !== "NOT_IMPLEMENTED") st.position = parseHms(relTime);
        if (trackDur && trackDur !== "NOT_IMPLEMENTED") st.duration = parseHms(trackDur);
        // Detect a track change → reset the enqueue flag in control.ts so it
        // can preload the next track again.
        if (currentTrack && currentTrack !== this.lastTrackUri.get(deviceId)) {
          this.lastTrackUri.set(deviceId, currentTrack);
          notifyTrackChanged(deviceId);
        }
      } else {
        // RenderingControl
        const vol = inner.match(/<Volume[^>]*value="([^"]*)"[^>]*channel="Master"/i)?.[1]
          || inner.match(/<Volume[^>]*channel="Master"[^>]*value="([^"]*)"/i)?.[1];
        if (vol) st.volume = parseInt(vol, 10) || 0;
      }
      this.states.set(deviceId, st);
      // Notify subscribers (WebSocket layer) of the new state.
      const prevState = prev.state;
      this.emit("state_changed", deviceId, st);
      // Detect a natural track end: transport transitioned to STOPPED from
      // PLAYING (not from PAUSED, which would be a user pause). The queue
      // manager subscribes to advance to the next track in this case.
      if (st.state === "STOPPED" && prevState === "PLAYING") {
        console.log(`[gena][track_ended] ${deviceId}: PLAYING→STOPPED detected via GENA event → emitting track_ended`);
        this.emit("track_ended", deviceId, st);
      }
    } catch {
      // Malformed NOTIFY — ignore, we'll get the next one.
    }
  }

  private lastTrackUri = new Map<string, string>();

  // Subscribe to both AVTransport and RenderingControl events for a device.
  // Best-effort: any failure is swallowed and shouldPollDevice() will keep
  // returning true, so the frontend polls as a fallback.
  async subscribe(device: DlnaDevice): Promise<void> {
    await this.ensureServer();
    if (!this.callbackBase) {
      // Derive callback base from the device's own location (same host as us).
      try {
        const u = new URL(device.location);
        this.callbackBase = `http://${u.hostname}:${this.listenPort}`;
      } catch { return; }
    }
    const services = [
      { service: AV_TRANSPORT, idx: "0", url: deriveEventUrl(device, AV_TRANSPORT) },
      { service: RENDERING_CONTROL, idx: "1", url: deriveEventUrl(device, RENDERING_CONTROL) },
    ];
    for (const s of services) {
      if (!s.url) continue;
      const key = `${device.id}|${s.service}`;
      if (this.subs.has(key)) continue; // already subscribed or in progress
      try {
        await this.sendSubscribe(s.url, device.id, s.idx);
      } catch {
        // Subscription failed — control.ts's forcePoll stays true and polling continues.
      }
    }
  }

  private async sendSubscribe(eventUrl: string, deviceId: string, svcIdx: string): Promise<void> {
    const callback = `<${this.callbackBase}/rest/dlna/event/${deviceId}/${svcIdx}>`;
    const resp = await fetch(eventUrl, {
      method: "SUBSCRIBE",
      headers: {
        "CALLBACK": callback,
        "NT": "upnp:event",
        "TIMEOUT": `Second-${SUBSCRIBE_TIMEOUT_SEC}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`SUBSCRIBE failed: ${resp.status}`);
    const sid = resp.headers.get("sid") || "";
    if (!sid) throw new Error("no SID in response");
    const timeoutHeader = resp.headers.get("timeout") || "";
    const secMatch = timeoutHeader.match(/Second-(\d+)/i);
    const ttlSec = secMatch ? parseInt(secMatch[1], 10) : SUBSCRIBE_TIMEOUT_SEC;
    const key = `${deviceId}|${svcIdx === "0" ? AV_TRANSPORT : RENDERING_CONTROL}`;
    const expiresAt = Date.now() + ttlSec * 1000;
    const existing = this.subs.get(key);
    if (existing?.renewTimer) clearTimeout(existing.renewTimer);
    const sub: Subscription = { deviceId, service: key.split("|")[1], sid, expiresAt };
    // Schedule a renewal before expiry.
    const renewDelay = Math.max(ttlSec * 1000 - RENEW_MARGIN_MS, 30_000);
    sub.renewTimer = setTimeout(() => this.renew(eventUrl, deviceId, svcIdx).catch(() => {}), renewDelay);
    this.subs.set(key, sub);
  }

  private async renew(eventUrl: string, deviceId: string, svcIdx: string): Promise<void> {
    const key = `${deviceId}|${svcIdx === "0" ? AV_TRANSPORT : RENDERING_CONTROL}`;
    const sub = this.subs.get(key);
    if (!sub) return;
    try {
      const resp = await fetch(eventUrl, {
        method: "SUBSCRIBE",
        headers: { "SID": sub.sid, "TIMEOUT": `Second-${SUBSCRIBE_TIMEOUT_SEC}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`renew failed: ${resp.status}`);
      const timeoutHeader = resp.headers.get("timeout") || "";
      const secMatch = timeoutHeader.match(/Second-(\d+)/i);
      const ttlSec = secMatch ? parseInt(secMatch[1], 10) : SUBSCRIBE_TIMEOUT_SEC;
      sub.expiresAt = Date.now() + ttlSec * 1000;
      const renewDelay = Math.max(ttlSec * 1000 - RENEW_MARGIN_MS, 30_000);
      if (sub.renewTimer) clearTimeout(sub.renewTimer);
      sub.renewTimer = setTimeout(() => this.renew(eventUrl, deviceId, svcIdx).catch(() => {}), renewDelay);
    } catch {
      // Renewal failed — drop the sub so shouldPollDevice() returns true and
      // we fall back to polling. A future castToDevice will try to re-subscribe.
      this.subs.delete(key);
    }
  }

  isSubscribed(deviceId: string): boolean {
    const key = `${deviceId}|${AV_TRANSPORT}`;
    const sub = this.subs.get(key);
    return !!sub && sub.expiresAt > Date.now();
  }

  // Merge cached event state into a status snapshot. Called by getDeviceStatus
  // so the frontend gets fresher-than-poll data when events are flowing.
  getEventState(deviceId: string): DeviceEventState | undefined {
    return this.states.get(deviceId);
  }

  unsubscribeAll(deviceId: string) {
    for (const key of Array.from(this.subs.keys())) {
      if (key.startsWith(deviceId + "|")) {
        const sub = this.subs.get(key)!;
        if (sub.renewTimer) clearTimeout(sub.renewTimer);
        // Best-effort UNSUBSCRIBE
        const eventUrl = ""; // we don't store the URL; device will time out the sub
        this.subs.delete(key);
        void eventUrl;
      }
    }
  }
}

let instance: EventManager | null = null;
export function getEventManager(): EventManager {
  if (!instance) instance = new EventManager();
  return instance;
}

function parseHms(hms: string): number {
  const m = hms.match(/(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}
