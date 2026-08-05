// DLNA MediaRenderer control + cast-session manager.
//
// Sends SOAP/UPnP actions to a device's AVTransport and RenderingControl
// services. Follows the same flow Music Assistant uses:
//   1. Stop (tolerate errors)   — avoids UPnP error 705 "transport locked"
//   2. SetAVTransportURI          — set the stream URL + DIDL-Lite metadata
//   3. wait_for_can_play          — poll GetTransportInfo until not TRANSITIONING
//   4. Play                       — start playback
//
// Gapless enqueue: if the device advertises SetNextAVTransportURI in its
// AVTransport SCPD, the next track is preloaded via SetNextAVTransportURI so
// the device switches tracks natively without a gap. A state poller (or GENA
// event subscription, see eventing.ts) detects the track change and refills
// the next slot.
//
// The stream URL points at this server's dedicated, token-auth-free
// `/rest/dlna/stream/:token` endpoint so the renderer can pull bytes directly.
import { randomBytes } from "crypto";
import os from "os";
import { discoverDlnaDevices, DlnaDevice } from "./discovery.js";
import { getEventManager } from "./eventing.js";
import { PlaybackState, type ProtocolPlayer, type PlayerState, type QueueItem } from "../player/types.js";

// ==================== base URL resolution (DLNA 拉流地址) ====================
// DLNA 设备需要回连本服务的 /rest/dlna/stream/:token 拉取音频流,因此 streamUrl
// 必须是设备在局域网内可达的地址(不能是 0.0.0.0 / localhost)。
//
// 两条路径产生 cast:
//   1. HTTP 触发(首次投屏 / 手动 next/prev)—— 路由层能从请求 Host 头推导正确地址;
//   2. 内部触发(自动切歌 / 卡死重试 / 重启续播)—— 没有 HTTP 上下文。
//
// 曾经内部路径直接用 `env 或 http://0.0.0.0:${PORT}` 兜底,0.0.0.0 设备无法访问
// → 设备一直收不到流 → 乐观窗口 5s 超时 → stalled 重播当前首 → 死循环(用户看到的
// "自动下一首等待很久且无法播放")。这里统一收敛到同一个解析函数:
//   DLNA_BASE_URL 环境变量 > 最近一次 HTTP 请求推导的地址 > 自动探测本机 LAN IP。

const CURRENT_PORT = "46400";

/** localhost / 0.0.0.0 / 127.x 等设备永远拉不到的主机名。 */
const LOOPBACK_RE = /^(localhost|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;

/** Host 头推导的主机名能否用于 DLNA 拉流:必须可路由(非回环 IP 或带点主机名)。 */
export function isRoutableHostname(hostname: string): boolean {
  if (!hostname) return false;
  const h = hostname.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!h || LOOPBACK_RE.test(h)) return false;
  // 无点号的单标签名(如 "server")DLNA 设备无法保证解析,拒绝。
  if (!h.includes(".")) return false;
  return true;
}

/** 记录最近一次由 HTTP 请求(Host 头)推导出的 base URL,供内部 cast 复用。 */
let lastSeenBaseUrl: string | undefined;
export function recordBaseUrl(baseUrl: string): void {
  if (!baseUrl) return;
  const hostname = baseUrl.replace(/^https?:\/\//i, "").split(":")[0];
  // localhost/0.0.0.0 之类设备不可达,丢弃不记,让内部 cast 走自动探测。
  if (!isRoutableHostname(hostname)) return;
  lastSeenBaseUrl = baseUrl.replace(/\/+$/, "");
}

/** 自动探测本机 LAN IPv4(优先真实网卡,跳过 docker0/br-* 等桥接地址)。 */
function autoDetectBaseUrl(): string {
  const port = process.env.PORT || CURRENT_PORT;
  const candidates: { name: string; addr: string }[] = [];
  for (const [name, ifs] of Object.entries(os.networkInterfaces())) {
    for (const i of ifs || []) {
      if (i.family === "IPv4" && !i.internal) candidates.push({ name, addr: i.address });
    }
  }
  const unroutableIf = /^(lo|docker\d*|br-|veth|virbr|tun|tap|tailscale)/i;
  const pick = candidates.find((c) => !unroutableIf.test(c.name)) || candidates[0];
  if (!pick) return `http://0.0.0.0:${port}`;
  return `http://${pick.addr}:${port}`;
}

/** 内部 cast(handleDecision / stalled 重试 / resumeActive)使用的 LAN base URL。 */
export function getEffectiveBaseUrl(): string {
  const envBase = process.env.DLNA_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/, "");
  if (lastSeenBaseUrl) return lastSeenBaseUrl;
  return autoDetectBaseUrl();
}

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";

// Build a SOAP envelope body for a UPnP action.
function soapEnvelope(service: string, action: string, args: Record<string, string>): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">${inner}</u:${action}></s:Body></s:Envelope>`;
}

// Escape XML text content (used for tag values, not for the whole envelope
// because args may contain pre-built DIDL-Lite metadata).
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

class SoapError extends Error {
  constructor(public action: string, message: string) { super(message); }
}

// Send a SOAP action to a control URL. Returns the raw XML response text.
// Throws SoapError on network failure or UPnP fault so callers can react
// (e.g. mark the device for polling fallback).
async function soapCall(controlUrl: string, service: string, action: string, args: Record<string, string>): Promise<string> {
  const body = soapEnvelope(service, action, args);
  let resp: Response;
  try {
    resp = await fetch(controlUrl, {
      method: "POST",
      headers: {
        "Content-Type": `text/xml; charset="utf-8"`,
        "SOAPAction": `"${service}#${action}"`,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e: any) {
    throw new SoapError(action, e.message || "network error");
  }
  const text = await resp.text();
  // UPnP fault: <s:Fault>...<errorDescription>...</errorDescription>
  if (/<s:Fault[\s\S]*<\/s:Fault>/i.test(text) || /errorCode/i.test(text)) {
    const code = text.match(/<errorCode>([^<]*)<\/errorCode>/i)?.[1].trim();
    const desc = text.match(/<errorDescription>([^<]*)<\/errorDescription>/i)?.[1].trim();
    throw new SoapError(action, `UPnP error ${code || "?"}: ${desc || "fault"}`);
  }
  return text;
}

// Build DIDL-Lite metadata for a single audio track, including album art.
// The albumArtUri is optional and only added when the song has cover art;
// it must be an absolute URL the renderer can fetch without auth (the
// /rest/getCoverArt endpoint is already public — see index.ts middleware).
function buildDidlLite(opts: {
  title: string; artist?: string; album?: string;
  uri: string; mime: string; albumArtUri?: string;
}): string {
  const { title, artist, album, uri, mime, albumArtUri } = opts;
  const protocolInfo = `http-get:*:${mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`;
  return `&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"` +
    ` xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"&gt;` +
    `&lt;item id="1" parentID="0" restricted="1"&gt;` +
    `&lt;dc:title&gt;${escapeXml(title)}&lt;/dc:title&gt;` +
    (artist ? `&lt;dc:creator&gt;${escapeXml(artist)}&lt;/dc:creator&gt;` : "") +
    (album ? `&lt;upnp:album&gt;${escapeXml(album)}&lt;/upnp:album&gt;` : "") +
    (albumArtUri ? `&lt;upnp:albumArtURI&gt;${escapeXml(albumArtUri)}&lt;/upnp:albumArtURI&gt;` : "") +
    `&lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;` +
    `&lt;res protocolInfo="${protocolInfo}"&gt;${escapeXml(uri)}&lt;/res&gt;` +
    `&lt;/item&gt;&lt;/DIDL-Lite&gt;`;
}

// ==================== Cast session ====================

export interface CastSession {
  token: string;          // used in /rest/dlna/stream/:token
  songId: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;      // session validity (ms epoch)
}

// In-memory cast sessions + cached device list.
const sessions = new Map<string, CastSession>();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cachedDevices: DlnaDevice[] = [];
let lastDiscovery = 0;

// Per-device runtime state: whether it supports gapless enqueue, whether the
// next track is already preloaded, and an availability flag used by the
// background poller. Mirrors MA's DLNAPlayer attributes.
export interface CurrentMedia {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  coverArt?: string;
}

interface DeviceRuntime {
  supportsEnqueue?: boolean;   // device advertises SetNextAVTransportURI
  nextEnqueued?: boolean;      // a next track is already set on the device
  available: boolean;          // last SOAP call succeeded
  forcePoll: boolean;          // GENA subscription failed → fall back to polling
  lastSeen: number;            // ms epoch of last successful contact
  currentMedia?: CurrentMedia; // track currently loaded on the device
  suppressAutoNext?: boolean;  // set by stop()/queue.clear to avoid auto-advance
}
const runtimes = new Map<string, DeviceRuntime>();

function runtimeOf(deviceId: string): DeviceRuntime {
  let r = runtimes.get(deviceId);
  if (!r) { r = { available: true, forcePoll: false, lastSeen: Date.now() }; runtimes.set(deviceId, r); }
  return r;
}

// ==================== Public API ====================

export async function refreshDevices(timeoutMs = 4000): Promise<DlnaDevice[]> {
  cachedDevices = await discoverDlnaDevices(timeoutMs);
  lastDiscovery = Date.now();
  // Notify subscribers (WS layer) that the device list may have changed.
  getEventManager().emitDeviceListChanged(cachedDevices.length);
  return cachedDevices;
}

export function getCachedDevices(): DlnaDevice[] {
  return cachedDevices;
}

export function shouldRefreshDevices(): boolean {
  return Date.now() - lastDiscovery > 60_000; // cache for 1 min
}

export function getDevice(deviceId: string): DlnaDevice | undefined {
  return cachedDevices.find(d => d.id === deviceId);
}

// Create a token-auth-free stream URL for DLNA renderer to pull.
// The URL points at this server; the caller passes the server's LAN base URL.
export function createCastSession(songId: string, deviceId: string, baseUrl: string): { token: string; streamUrl: string } {
  const token = randomBytes(16).toString("hex");
  const now = Date.now();
  sessions.set(token, { token, songId, deviceId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  // Clean expired sessions opportunistically.
  if (sessions.size > 50) {
    for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k);
  }
  return { token, streamUrl: `${baseUrl}/rest/dlna/stream/${token}` };
}

export function resolveCastToken(token: string): string | null {
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) {
    if (s) sessions.delete(token);
    return null;
  }
  return s.songId;
}

export interface CastOptions {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  mime: string;
  deviceId: string;
  baseUrl: string;
  coverArt?: string;   // song.coverArt — turned into an absolute albumArtUri
}

// Probe whether a device supports SetNextAVTransportURI by fetching its
// AVTransport SCPD (service description) once and caching the result.
// MA does the same via async_upnp_client's action introspection.
async function probeEnqueueSupport(device: DlnaDevice): Promise<boolean> {
  const rt = runtimeOf(device.id);
  if (rt.supportsEnqueue !== undefined) return rt.supportsEnqueue;
  rt.supportsEnqueue = false; // assume not supported until proven otherwise
  if (!device.avTransportUrl) return false;
  try {
    // The SCPD URL is derived from the service's SCPDURL in description.xml,
    // but we only kept the absolute control URL. Re-fetch description.xml to
    // get the SCPDURL, then fetch the SCPD and look for the action name.
    const descResp = await fetch(device.location, { signal: AbortSignal.timeout(5000) });
    const descXml = await descResp.text();
    // Find the AVTransport <service> block and extract its SCPDURL.
    const serviceRegex = /<service\b[^>]*>([\s\S]*?)<\/service>/gi;
    let sm: RegExpExecArray | null;
    let scpdUrl: string | undefined;
    while ((sm = serviceRegex.exec(descXml)) !== null) {
      const block = sm[1];
      if (/AVTransport/i.test(block.match(/<serviceType[^>]*>([^<]*)<\/serviceType>/i)?.[1] || "")) {
        scpdUrl = block.match(/<SCPDURL[^>]*>([^<]*)<\/SCPDURL>/i)?.[1].trim();
        break;
      }
    }
    if (!scpdUrl) return false;
    const absScpdUrl = new URL(scpdUrl, device.location).href;
    const scpdResp = await fetch(absScpdUrl, { signal: AbortSignal.timeout(5000) });
    const scpdXml = await scpdResp.text();
    rt.supportsEnqueue = /<name>SetNextAVTransportURI<\/name>/i.test(scpdXml);
  } catch {
    rt.supportsEnqueue = false;
  }
  return rt.supportsEnqueue;
}

// Wait until the device's AVTransport is ready to Play.对照 MA async_wait_for_can_play:
// 检查 CurrentTransportActions 含 "play"(而非只 != TRANSITIONING),并主动 poll 兜底。
async function waitForCanPlay(device: DlnaDevice, budgetMs = 10000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const xml = await soapCall(device.avTransportUrl!, AV_TRANSPORT, "GetTransportInfo", { InstanceID: "0" });
      const st = xml.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i)?.[1].trim() || "";
      const actions = xml.match(/<CurrentTransportActions>([^<]*)<\/CurrentTransportActions>/i)?.[1].trim() || "";
      // MA: 检查 CurrentTransportActions 含 "play";空值时乐观返回 true(设备漏报)
      if (st !== "TRANSITIONING" && (actions === "" || /play/i.test(actions))) return;
    } catch { return; }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`[cast] ${device.id}: waitForCanPlay 超时(10s),继续尝试 Play`);
}

// Mark a SOAP failure on the device runtime so the poller knows to keep
// polling (forcePoll) and so we don't repeatedly hammer a dead device.
function markFailed(deviceId: string, action: string, err: Error) {
  const rt = runtimeOf(deviceId);
  rt.forcePoll = true;
  rt.available = false;
  // Suppress noisy logs for the expected "Pause on a stopped transport" fault.
  if (!/70[0-9]|transport/i.test(err.message)) {
    console.error(`[DLNA] ${action} failed on ${deviceId}: ${err.message}`);
  }
}

function markOk(deviceId: string) {
  const rt = runtimeOf(deviceId);
  rt.available = true;
  rt.lastSeen = Date.now();
}

// Cast a song to a DLNA renderer.
// Flow: Stop (tolerate errors) → SetAVTransportURI → wait_for_can_play → Play.
// Also kicks off GENA event subscription (best-effort) so we get push-based
// state updates instead of relying solely on polling.
export async function castToDevice(opts: CastOptions): Promise<{ mediaUri: string }> {
  const device = getDevice(opts.deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到或不可用");
  const { token, streamUrl } = createCastSession(opts.songId, opts.deviceId, opts.baseUrl);
  const albumArtUri = opts.coverArt ? `${opts.baseUrl}/rest/getCoverArt?id=${encodeURIComponent(opts.coverArt)}&size=500` : undefined;
  const metadata = buildDidlLite({ title: opts.title, artist: opts.artist, album: opts.album, uri: streamUrl, mime: opts.mime, albumArtUri });

  console.log(`[cast] ${opts.deviceId}: BEGIN songId=${opts.songId} title="${opts.title}"`);
  // Reset the "next enqueued" flag — a fresh SetAVTransportURI clears the device's next slot.
  runtimeOf(opts.deviceId).nextEnqueued = false;

  // Step 1: Stop (tolerate errors). 对照 MA play_media: always clear queue (by sending stop) first.
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" });
  } catch (e: any) {
    console.log(`[cast] ${opts.deviceId}: Step 1 Stop failed (ignored): ${e?.message || e}`);
  }

  // 注:MA 在 stop 与 SetAVTransportURI 之间无固定 sleep,依赖 wait_for_can_play 等设备就绪。

  // Step 2: SetAVTransportURI.
  console.log(`[cast] ${opts.deviceId}: Step 2 SetAVTransportURI`);
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "SetAVTransportURI", {
    InstanceID: "0",
    CurrentURI: streamUrl,
    CurrentURIMetaData: metadata,
  });
  console.log(`[cast] ${opts.deviceId}: Step 2 SetAVTransportURI OK`);

  // Step 3: wait_for_can_play — 检查 CurrentTransportActions 含 play。对照 MA 10s budget。
  console.log(`[cast] ${opts.deviceId}: Step 3 waitForCanPlay`);
  await waitForCanPlay(device);
  console.log(`[cast] ${opts.deviceId}: Step 3 waitForCanPlay OK`);

  // Step 4: Play.
  console.log(`[cast] ${opts.deviceId}: Step 4 Play`);
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Play", { InstanceID: "0", Speed: "1" });
  console.log(`[cast] ${opts.deviceId}: Step 4 Play OK`);
  markOk(opts.deviceId);

  // Record the currently-loaded media so getDeviceStatus / WS pushes can
  // report title/artist/album/coverArt without a fresh SOAP round-trip.
  const rt = runtimeOf(opts.deviceId);
  rt.currentMedia = {
    songId: opts.songId,
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    coverArt: opts.coverArt,
  };
  getEventManager().emit("media_changed", opts.deviceId, rt.currentMedia);

  // Best-effort: subscribe to GENA events so we get push updates. If it
  // fails we silently fall back to polling (forcePoll stays true).
  getEventManager().subscribe(device).catch(() => {});
  console.log(`[cast] ${opts.deviceId}: END songId=${opts.songId}`);
  return { mediaUri: streamUrl };
}

/** Read the media currently loaded on a device (set by castToDevice). */
export function getCurrentMedia(deviceId: string): CurrentMedia | undefined {
  return runtimes.get(deviceId)?.currentMedia;
}

/** Clear the currently-loaded media (e.g. when the queue is cleared). */
export function clearCurrentMedia(deviceId: string): void {
  const rt = runtimes.get(deviceId);
  if (rt) rt.currentMedia = undefined;
}

// Preload the next track on the device via SetNextAVTransportURI so the
// device can switch to it gaplessly when the current track ends.
// Only call this if probeEnqueueSupport returned true and we haven't already
// enqueued a next track for the current song.
export async function enqueueNextTrack(opts: CastOptions): Promise<boolean> {
  const device = getDevice(opts.deviceId);
  if (!device?.avTransportUrl) return false;
  const rt = runtimeOf(opts.deviceId);
  if (!await probeEnqueueSupport(device)) return false;
  if (rt.nextEnqueued) return true; // already preloaded
  const { token, streamUrl } = createCastSession(opts.songId, opts.deviceId, opts.baseUrl);
  const albumArtUri = opts.coverArt ? `${opts.baseUrl}/rest/getCoverArt?id=${encodeURIComponent(opts.coverArt)}&size=500` : undefined;
  const metadata = buildDidlLite({ title: opts.title, artist: opts.artist, album: opts.album, uri: streamUrl, mime: opts.mime, albumArtUri });
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "SetNextAVTransportURI", {
      InstanceID: "0",
      NextURI: streamUrl,
      NextURIMetaData: metadata,
    });
    rt.nextEnqueued = true;
    markOk(opts.deviceId);
    return true;
  } catch (e: any) {
    rt.supportsEnqueue = false; // device lied or is misbehaving — don't retry
    markFailed(opts.deviceId, "SetNextAVTransportURI", e);
    return false;
  }
}

// Called by the state poller / event handler when the device finishes a
// track (PLAYING → STOPPED with a new TrackURI, or a NextAVTransportURI
// transition). Resets the enqueue flag so the caller can preload the next.
export function notifyTrackChanged(deviceId: string) {
  const rt = runtimeOf(deviceId);
  rt.nextEnqueued = false;
}

export function isDeviceAvailable(deviceId: string): boolean {
  const rt = runtimes.get(deviceId);
  if (!rt) return true; // unknown device → optimistic
  return rt.available;
}

export function shouldPollDevice(deviceId: string): boolean {
  const rt = runtimes.get(deviceId);
  if (!rt) return true;
  // Poll when: no GENA subscription, or subscription failed (forcePoll),
  // or the device went unavailable. MA uses the same logic.
  return rt.forcePoll || !getEventManager().isSubscribed(deviceId);
}

export async function playDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Play", { InstanceID: "0", Speed: "1" });
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "Play", e); throw e; }
}

export async function pauseDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Pause", { InstanceID: "0" });
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "Pause", e); throw e; }
}

export async function stopDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  const rt = runtimeOf(deviceId);
  rt.nextEnqueued = false;
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" });
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "Stop", e); throw e; }
}

// Seek to a position (seconds). Uses REL_TIME format HH:MM:SS.
export async function seekDevice(deviceId: string, seconds: number): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const target = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Seek", { InstanceID: "0", Unit: "REL_TIME", Target: target });
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "Seek", e); throw e; }
}

// Set volume (0-100). Requires RenderingControl service.
export async function setDeviceVolume(deviceId: string, volume: number): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.renderingControlUrl) throw new Error("设备不支持音量控制");
  const vol = Math.max(0, Math.min(100, Math.round(volume)));
  try {
    await soapCall(device.renderingControlUrl, RENDERING_CONTROL, "SetVolume", {
      InstanceID: "0",
      Channel: "Master",
      DesiredVolume: String(vol),
    });
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "SetVolume", e); throw e; }
}

export interface DeviceStatus {
  state: string;      // PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING / NO_MEDIA_PRESENT
  position: number;   // seconds
  duration: number;   // seconds
  volume: number;     // 0-100
  media?: CurrentMedia; // currently loaded track (set by castToDevice)
  trackUri?: string;   // 当前 TrackURI(来自 GetPositionInfo),供 poll 路径 track_changed 检测
}

// Query current transport state + position + volume via SOAP.
// Returns a default STOPPED status when the device is not in cache (e.g.
// right after a server restart, before background discovery repopulates it)
// instead of throwing — the frontend polls this every few seconds and a 500
// would spam the logs and break the cast UI.
export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) return { state: "STOPPED", position: 0, duration: 0, volume: 0, media: getCurrentMedia(deviceId) };
  const state: DeviceStatus = { state: "STOPPED", position: 0, duration: 0, volume: 0, media: getCurrentMedia(deviceId) };

  // GetTransportInfo — state.
  try {
    const xml = await soapCall(device.avTransportUrl, AV_TRANSPORT, "GetTransportInfo", { InstanceID: "0" });
    const sm = xml.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i);
    if (sm) state.state = sm[1].trim();
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "GetTransportInfo", e); }

  // GetPositionInfo — position + duration + TrackURI(供 poll 路径 track_changed 检测)。
  try {
    const xml = await soapCall(device.avTransportUrl, AV_TRANSPORT, "GetPositionInfo", { InstanceID: "0" });
    const relTime = xml.match(/<RelTime>([^<]*)<\/RelTime>/i)?.[1].trim();
    const trackDur = xml.match(/<TrackDuration>([^<]*)<\/TrackDuration>/i)?.[1].trim();
    const trackUri = xml.match(/<TrackURI>([^<]*)<\/TrackURI>/i)?.[1].trim();
    if (relTime && relTime !== "NOT_IMPLEMENTED") state.position = parseHms(relTime);
    if (trackDur && trackDur !== "NOT_IMPLEMENTED") state.duration = parseHms(trackDur);
    if (trackUri && trackUri !== "") state.trackUri = trackUri;
  } catch {}

  // GetVolume — RenderingControl.
  if (device.renderingControlUrl) {
    try {
      const xml = await soapCall(device.renderingControlUrl, RENDERING_CONTROL, "GetVolume", { InstanceID: "0", Channel: "Master" });
      const vm = xml.match(/<CurrentVolume>([^<]*)<\/CurrentVolume>/i);
      if (vm) state.volume = parseInt(vm[1].trim(), 10) || 0;
    } catch {}
  }
  return state;
}

function parseHms(hms: string): number {
  const m = hms.match(/(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

// ==================== ProtocolPlayer 适配(供 UniversalPlayer 绑定)====================

/** 把 DLNA 设备状态映射为 PlayerState(PlaybackState)。对照 MA _get_playback_state。 */
function mapTransportState(state: string): PlaybackState {
  // TRANSITIONING → BUFFERING(屏蔽瞬态,但 PlayerController 乐观窗口已处理)
  if (state === "PLAYING") return PlaybackState.PLAYING;
  if (state === "PAUSED_PLAYBACK") return PlaybackState.PAUSED;
  if (state === "TRANSITIONING") return PlaybackState.BUFFERING;
  return PlaybackState.IDLE; // STOPPED / NO_MEDIA_PRESENT / 其他
}

/** 创建 DLNA 协议 player 适配器(实现 ProtocolPlayer 接口)。 */
export function createDlnaProtocolPlayer(deviceId: string): ProtocolPlayer {
  const playerId = `dlna:${deviceId}`;
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const { mediaUri } = await castToDevice({
        songId: item.songId, title: item.title, artist: item.artist, album: item.album,
        mime: item.mime, deviceId, baseUrl, coverArt: item.coverArt,
      });
      return { mediaUri };
    },
    async stop() { await stopDevice(deviceId); },
    async pause() { await pauseDevice(deviceId); },
    async resume() { await playDevice(deviceId); },
    async seek(s: number) { await seekDevice(deviceId, s); },
    async setVolume(v: number) { await setDeviceVolume(deviceId, v); },
    async pollState(): Promise<PlayerState> {
      const s = await getDeviceStatus(deviceId);
      return {
        playerId,
        playbackState: mapTransportState(s.state),
        position: s.position,
        duration: s.duration,
        mediaUri: s.trackUri, // 来自 GetPositionInfo 的 TrackURI,供 track_changed 检测
        updatedAt: Date.now(),
      };
    },
  };
}
