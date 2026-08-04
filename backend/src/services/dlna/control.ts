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
import { discoverDlnaDevices, DlnaDevice } from "./discovery.js";
import { getEventManager } from "./eventing.js";

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

// Wait until the device's AVTransport is no longer TRANSITIONING, i.e. the
// SetAVTransportURI has been accepted and the transport is ready to Play.
// MA calls this wait_for_can_play and gives it a 10s budget; we use a tighter
// 3s since most devices settle within a few hundred milliseconds.
async function waitForCanPlay(device: DlnaDevice, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const xml = await soapCall(device.avTransportUrl!, AV_TRANSPORT, "GetTransportInfo", { InstanceID: "0" });
      const st = xml.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i)?.[1].trim() || "";
      if (st !== "TRANSITIONING") return;
    } catch { return; }
    await new Promise(r => setTimeout(r, 150));
  }
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
export async function castToDevice(opts: CastOptions): Promise<void> {
  const device = getDevice(opts.deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到或不可用");
  const { token, streamUrl } = createCastSession(opts.songId, opts.deviceId, opts.baseUrl);
  const albumArtUri = opts.coverArt ? `${opts.baseUrl}/rest/getCoverArt?id=${encodeURIComponent(opts.coverArt)}&size=500` : undefined;
  const metadata = buildDidlLite({ title: opts.title, artist: opts.artist, album: opts.album, uri: streamUrl, mime: opts.mime, albumArtUri });

  // Reset the "next enqueued" flag — a fresh SetAVTransportURI clears the device's next slot.
  runtimeOf(opts.deviceId).nextEnqueued = false;

  // Step 1: Stop (tolerate "transport not playing" errors).
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" });
  } catch (e: any) {
    // Ignore — device may have no active transport, returns a SOAP fault.
  }

  // Step 2: SetAVTransportURI.
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "SetAVTransportURI", {
    InstanceID: "0",
    CurrentURI: streamUrl,
    CurrentURIMetaData: metadata,
  });

  // Step 3: wait_for_can_play — avoid 705 "transport locked" on Play.
  await waitForCanPlay(device);

  // Step 4: Play.
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Play", { InstanceID: "0", Speed: "1" });
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
  rt.suppressAutoNext = false;
  getEventManager().emit("media_changed", opts.deviceId, rt.currentMedia);

  // Best-effort: subscribe to GENA events so we get push updates. If it
  // fails we silently fall back to polling (forcePoll stays true).
  getEventManager().subscribe(device).catch(() => {});
}

/** Read the media currently loaded on a device (set by castToDevice). */
export function getCurrentMedia(deviceId: string): CurrentMedia | undefined {
  return runtimes.get(deviceId)?.currentMedia;
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
  // Suppress queue auto-advance — this Stop came from an explicit user action,
  // not a natural track end.
  rt.suppressAutoNext = true;
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
}

// Query current transport state + position + volume via SOAP.
// Returns a default STOPPED status when the device is not in cache (e.g.
// right after a server restart, before background discovery repopulates it)
// instead of throwing — the frontend polls this every few seconds and a 500
// would spam the logs and break the cast UI.
export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) return { state: "STOPPED", position: 0, duration: 0, volume: 0 };
  const state = { state: "STOPPED", position: 0, duration: 0, volume: 0 };

  // GetTransportInfo — state.
  try {
    const xml = await soapCall(device.avTransportUrl, AV_TRANSPORT, "GetTransportInfo", { InstanceID: "0" });
    const sm = xml.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i);
    if (sm) state.state = sm[1].trim();
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "GetTransportInfo", e); }

  // GetPositionInfo — position + duration.
  try {
    const xml = await soapCall(device.avTransportUrl, AV_TRANSPORT, "GetPositionInfo", { InstanceID: "0" });
    const relTime = xml.match(/<RelTime>([^<]*)<\/RelTime>/i)?.[1].trim();
    const trackDur = xml.match(/<TrackDuration>([^<]*)<\/TrackDuration>/i)?.[1].trim();
    if (relTime && relTime !== "NOT_IMPLEMENTED") state.position = parseHms(relTime);
    if (trackDur && trackDur !== "NOT_IMPLEMENTED") state.duration = parseHms(trackDur);
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
