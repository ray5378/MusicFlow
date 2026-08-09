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
import { PlaybackState, type PlayerState } from "../player/types.js";

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
        // AVTransport —— 传输状态/进度/曲目。
        // UPnP 标准里这些标签用 `val="..."`(同 RenderingControl 的音量),
        // 但部分设备用 `value=`,两种写法都兼容(优先匹配 val=)。
        const pick = (tag: string): string | undefined => {
          const m = inner.match(new RegExp(`<${tag}\\b[^>]*?(?:val|value)="([^"]*)"`, "i"));
          return m?.[1];
        };
        const transportState = pick("TransportState");
        const relTime = pick("RelTime");
        const trackDur = pick("TrackDuration");
        const currentTrack = pick("CurrentTrackURI");
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
        // RenderingControl —— 音量。
        // UPnP 标准用 `val="50"`(RenderingControl LastChange),但部分设备用 `value="50"`,
        // 且 `channel` 可能出现在 `val` 前或后,也可能省略。这里两种写法、两种顺序都兼容,
        // 优先匹配 channel="Master",否则取第一个 Volume 标签。
        let volMatch =
          inner.match(/<Volume\b[^>]*?\bchannel="Master"[^>]*?(?:val|value)="(\d+)"/i) ||
          inner.match(/<Volume\b[^>]*?(?:val|value)="(\d+)"[^>]*?\bchannel="Master"/i);
        if (!volMatch) {
          volMatch = inner.match(/<Volume\b[^>]*?(?:val|value)="(\d+)"/i);
        }
        if (volMatch) st.volume = parseInt(volMatch[1], 10) || 0;
      }
      this.states.set(deviceId, st);
      const prevState = prev.state;
      this.emit("state_changed", deviceId, st);
      // 不再 emit track_ended 直接触发 queue。改为上报 PlayerController,
      // 由上层去抖 + 状态迁移判断决策切歌(对照 MA:player 上报状态 → controller 决策)。
      this.reportToPlayerController(deviceId, st);
    } catch {
      // Malformed NOTIFY — ignore, we'll get the next one.
    }
  }

  private reportToPlayerController(deviceId: string, st: DeviceEventState): void {
    // 懒加载 PlayerController,避免循环依赖(eventing ↔ player 互引)
    import("../player/index.js").then(({ getPlayerController }) => {
      const ctrl = getPlayerController();
      const playerState: PlayerState = {
        playerId: `dlna:${deviceId}`,
        playbackState: this.mapState(st.state),
        position: st.position || 0,
        duration: st.duration || 0,
        mediaUri: this.lastTrackUri.get(deviceId),
        updatedAt: st.updatedAt,
      };
      ctrl.reportState(playerState);
    }).catch(() => {});
  }

  private mapState(state: string | undefined): PlaybackState {
    if (state === "PLAYING") return PlaybackState.PLAYING;
    if (state === "PAUSED_PLAYBACK") return PlaybackState.PAUSED;
    if (state === "TRANSITIONING") return PlaybackState.BUFFERING;
    return PlaybackState.IDLE;
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

  /** 后端主动设音量后(HA→MusicFlow 方向),更新缓存并立刻发 WS 推送,
   * 让集成侧即时同步,不必等下一轮轮询。device 侧物理调音量由 GENA 事件驱动,
   * 走的是 parseLastChange 同一条路径。 */
  setVolume(deviceId: string, volume: number): void {
    const prev = this.states.get(deviceId) || { updatedAt: 0 };
    const st: DeviceEventState = { ...prev, volume, updatedAt: Date.now() };
    this.states.set(deviceId, st);
    this.emit("state_changed", deviceId, st);
  }

  /** 后端主动下发传输控制(play/pause/stop/seek,HA→MusicFlow 方向)后,
   * 立刻更新缓存并推 WS,让集成零延迟同步(与 setVolume 同机制,双向同步)。
   * state 取值与 GENA/UPnP 一致: PLAYING / PAUSED_PLAYBACK / STOPPED 等。 */
  setTransportState(deviceId: string, state: string): void {
    const prev = this.states.get(deviceId) || { updatedAt: 0 };
    const st: DeviceEventState = { ...prev, state, updatedAt: Date.now() };
    this.states.set(deviceId, st);
    this.emit("state_changed", deviceId, st);
  }

  /** 定位进度即时推送(seek 后)。 */
  setPosition(deviceId: string, position: number): void {
    const prev = this.states.get(deviceId) || { updatedAt: 0 };
    const st: DeviceEventState = { ...prev, position, updatedAt: Date.now() };
    this.states.set(deviceId, st);
    this.emit("state_changed", deviceId, st);
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
