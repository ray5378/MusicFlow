// DLNA MediaRenderer control + cast-session manager.
//
// Sends SOAP/UPnP actions to a device's AVTransport and RenderingControl
// services. Follows the same flow Music Assistant uses:
//   1. Stop (tolerate errors)   — avoids UPnP error 705 "transport locked"
//   2. SetAVTransportURI          — set the stream URL + DIDL-Lite metadata
//   3. Play                       — start playback
//
// The stream URL points at this server's dedicated, token-auth-free
// `/rest/dlna/stream/:token` endpoint so the renderer can pull bytes directly.
import { randomBytes } from "crypto";
import { discoverDlnaDevices, DlnaDevice } from "./discovery.js";

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";

// Build a SOAP envelope body for a UPnP action.
function soapEnvelope(service: string, action: string, args: Record<string, string>): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">${inner}</u:${action}></s:Body></s:Envelope>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Send a SOAP action to a control URL. Returns the raw XML response text.
async function soapCall(controlUrl: string, service: string, action: string, args: Record<string, string>): Promise<string> {
  const body = soapEnvelope(service, action, args);
  const resp = await fetch(controlUrl, {
    method: "POST",
    headers: {
      "Content-Type": `text/xml; charset="utf-8"`,
      "SOAPAction": `"${service}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  return resp.text();
}

// Build DIDL-Lite metadata for a single audio track.
function buildDidlLite(opts: { title: string; artist?: string; album?: string; uri: string; mime: string }): string {
  const { title, artist, album, uri, mime } = opts;
  const protocolInfo = `http-get:*:${mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`;
  return `&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"` +
    ` xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"&gt;` +
    `&lt;item id="1" parentID="0" restricted="1"&gt;` +
    `&lt;dc:title&gt;${escapeXml(title)}&lt;/dc:title&gt;` +
    (artist ? `&lt;dc:creator&gt;${escapeXml(artist)}&lt;/dc:creator&gt;` : "") +
    (album ? `&lt;upnp:album&gt;${escapeXml(album)}&lt;/upnp:album&gt;` : "") +
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

// ==================== Public API ====================

export async function refreshDevices(timeoutMs = 4000): Promise<DlnaDevice[]> {
  cachedDevices = await discoverDlnaDevices(timeoutMs);
  lastDiscovery = Date.now();
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
}

// Cast a song to a DLNA renderer.
// Flow: Stop (tolerate errors) → SetAVTransportURI → Play.
export async function castToDevice(opts: CastOptions): Promise<void> {
  const device = getDevice(opts.deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到或不可用");
  const { token, streamUrl } = createCastSession(opts.songId, opts.deviceId, opts.baseUrl);
  const metadata = buildDidlLite({ title: opts.title, artist: opts.artist, album: opts.album, uri: streamUrl, mime: opts.mime });

  // Step 1: Stop (tolerate "transport not playing" errors).
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" });
  } catch {
    // Ignore — device may have no active transport, returns a SOAP fault.
  }

  // Step 2: SetAVTransportURI.
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "SetAVTransportURI", {
    InstanceID: "0",
    CurrentURI: streamUrl,
    CurrentURIMetaData: metadata,
  });

  // Step 3: Play.
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Play", { InstanceID: "0", Speed: "1" });
}

export async function playDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Play", { InstanceID: "0", Speed: "1" });
}

export async function pauseDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Pause", { InstanceID: "0" });
}

export async function stopDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" });
}

// Seek to a position (seconds). Uses REL_TIME format HH:MM:SS.
export async function seekDevice(deviceId: string, seconds: number): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const target = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Seek", { InstanceID: "0", Unit: "REL_TIME", Target: target });
}

// Set volume (0-100). Requires RenderingControl service.
export async function setDeviceVolume(deviceId: string, volume: number): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.renderingControlUrl) throw new Error("设备不支持音量控制");
  const vol = Math.max(0, Math.min(100, Math.round(volume)));
  await soapCall(device.renderingControlUrl, RENDERING_CONTROL, "SetVolume", {
    InstanceID: "0",
    Channel: "Master",
    DesiredVolume: String(vol),
  });
}

export interface DeviceStatus {
  state: string;      // PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING / NO_MEDIA_PRESENT
  position: number;   // seconds
  duration: number;   // seconds
  volume: number;     // 0-100
}

// Query current transport state + position + volume via SOAP.
export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  const state = { state: "STOPPED", position: 0, duration: 0, volume: 0 };

  // GetTransportInfo — state.
  try {
    const xml = await soapCall(device.avTransportUrl, AV_TRANSPORT, "GetTransportInfo", { InstanceID: "0" });
    const sm = xml.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i);
    if (sm) state.state = sm[1].trim();
  } catch {}

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
