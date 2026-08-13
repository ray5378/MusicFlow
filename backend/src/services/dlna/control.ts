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
import { discoverDlnaDevices, fetchDeviceAtLocation, onSsdpEvent, DlnaDevice } from "./discovery.js";
import { getEventManager } from "./eventing.js";
import { PlaybackState, type ProtocolPlayer, type PlayerState, type QueueItem } from "../player/types.js";
import { sqlite } from "../../db/index.js";

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

/**
 * 主机名是否为「局域网可达」地址——即 DLNA 设备能在同一 LAN 内解析回连的地址。
 * 覆盖:私有 IPv4(10/172.16-31/192.168/169.254)、IPv6 ULA/链路本地(fc/fd/fe8)、
 * 以及 .local mDNS 主机名。公网域名(如 music.example.com)返回 false。
 * 这是「通过公网域名访问时仍推局域网地址给 DLNA 设备」的关键判定。
 */
export function isPrivateLanHostname(hostname: string): boolean {
  if (!hostname) return false;
  const h = hostname.replace(/^\[/, "").replace(/\]$/, "").trim().toLowerCase();
  if (!h || LOOPBACK_RE.test(h)) return false;
  // 私有 IPv4 段
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // 私有/链路本地 IPv6
  if (/^(fc|fd|fe[89ab])/.test(h)) return true;
  // mDNS 本地主机名
  if (h.endsWith(".local")) return true;
  return false;
}

/** 记录最近一次由 HTTP 请求(Host 头)推导出的 base URL,供内部 cast 复用。 */
let lastSeenBaseUrl: string | undefined;
export function recordBaseUrl(baseUrl: string): void {
  if (!baseUrl) return;
  const hostname = baseUrl.replace(/^https?:\/\//i, "").split(":")[0];
  // 只缓存「局域网可达」地址(私有 IP / .local)。公网域名与回环地址设备拉不到流,
  // 丢弃不记,让内部 cast 走自动探测的 LAN IP;否则公网域名会被缓存进 lastSeenBaseUrl,
  // 毒害后续自动切歌/卡死重试等内部投屏(设备收到公网域名永远拉不到流)。
  if (!isPrivateLanHostname(hostname)) return;
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
  const discovered = await discoverDlnaDevices(timeoutMs);
  lastDiscovery = Date.now();
  const live = new Set(discovered.map(d => d.id));
  // Upsert discovered devices into the cache + DB (online).
  for (const d of discovered) {
    const idx = cachedDevices.findIndex(x => x.id === d.id);
    if (idx >= 0) {
      cachedDevices[idx] = { ...cachedDevices[idx], ...d, available: true };
      upsertDeviceRow(cachedDevices[idx]);
    } else {
      cachedDevices.push({ ...d, available: true });
      upsertDeviceRow(cachedDevices[cachedDevices.length - 1]);
    }
  }
  // Devices that vanished → keep them listed but mark unavailable (offline).
  // Offline devices stay visible so the user can manage (rename/delete) them.
  for (const d of cachedDevices) {
    if (!live.has(d.id) && d.available) {
      d.available = false;
      markDeviceOfflineInDb(d.id);
    }
  }
  // Prune per-device runtime state for devices that are no longer in the
  // discovered list, so the in-memory `runtimes` map doesn't grow without
  // bound on long-running servers. Unconditional id-based sweep (no size
  // comparison): a device that went offline while another came online keeps
  // the count equal but must still be evicted.
  for (const [deviceId] of runtimes) {
    if (!live.has(deviceId)) runtimes.delete(deviceId);
  }
  // Notify subscribers (WS layer) that the device list may have changed.
  getEventManager().emitDeviceListChanged(cachedDevices.length);
  return cachedDevices;
}

// ==================== 设备持久化(dlna_devices) ====================
// 设备记录持久化到 DB:离线设备不删除,供「播放器」页管理(重命名/删除)。
// alias 由用户设置;发现流程只更新原始字段,不覆盖 alias / first_seen。

function isoNow(): string { return new Date().toISOString(); }

function upsertDeviceRow(d: DlnaDevice): void {
  const now = isoNow();
  const existing = sqlite.prepare("SELECT alias, first_seen, disabled FROM dlna_devices WHERE id = ?").get(d.id) as any;
  const alias = existing?.alias || d.alias || "";
  const firstSeen = existing?.first_seen || now;
  sqlite.prepare(`
    INSERT INTO dlna_devices (id, name, alias, manufacturer, model, first_seen, last_seen, available, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      manufacturer = excluded.manufacturer,
      model = excluded.model,
      last_seen = excluded.last_seen,
      available = 1,
      updated_at = excluded.updated_at
  `).run(d.id, d.name, alias, d.manufacturer || "", d.model || "", firstSeen, now, now);
  // Re-attach the preserved alias + disabled flag to the in-memory device.
  // 发现流程永不覆盖 disabled(用户手动禁用的设备,SSDP 重发现/重启后依然禁用)。
  d.alias = alias || undefined;
  d.disabled = !!existing?.disabled;
}

function markDeviceOfflineInDb(deviceId: string): void {
  sqlite.prepare("UPDATE dlna_devices SET available = 0, updated_at = ? WHERE id = ?").run(isoNow(), deviceId);
}

// 设置用户自定义显示名(alias)。空串 = 恢复使用原始名。同步 DB + 内存缓存,
// 并通过 device_list_changed 广播触发 peer reconcile(播放控件/HA 卡片显示名更新)。
// 返回更新后的设备(找不到返回 undefined)。
export function setDeviceAlias(deviceId: string, alias: string): DlnaDevice | undefined {
  if (!cachedDevices.some(d => d.id === deviceId) &&
      !sqlite.prepare("SELECT 1 FROM dlna_devices WHERE id = ?").get(deviceId)) return undefined;
  sqlite.prepare("UPDATE dlna_devices SET alias = ?, updated_at = ? WHERE id = ?")
    .run(alias, isoNow(), deviceId);
  const dev = cachedDevices.find(d => d.id === deviceId);
  if (dev) dev.alias = alias || undefined;
  getEventManager().emitDeviceListChanged(cachedDevices.length);
  return dev;
}

// 禁用/启用 DLNA 设备:写 DB + 内存缓存,并通过 device_list_changed 广播触发
// peer reconcile(禁用 → 移除 peer,启用 → 重新注册)。返回更新后的设备(找不到返回 undefined)。
// 注意:禁用只负责状态与广播;停止播放/清队列/移除群组成员由路由层(setDisabled 端点)处理。
export function setDeviceDisabled(deviceId: string, disabled: boolean): DlnaDevice | undefined {
  if (!cachedDevices.some(d => d.id === deviceId) &&
      !sqlite.prepare("SELECT 1 FROM dlna_devices WHERE id = ?").get(deviceId)) return undefined;
  const now = isoNow();
  // UPSERT:DB 已有行只改 disabled/updated_at(不动 name/alias 等);无行则补一行
  // (边界:设备仅在内存缓存、尚未被发现流程持久化时,禁用动作也必须落库)。
  sqlite.prepare(`
    INSERT INTO dlna_devices (id, name, alias, manufacturer, model, first_seen, last_seen, available, disabled, updated_at)
    VALUES (?, '', '', '', '', ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET disabled = excluded.disabled, updated_at = excluded.updated_at
  `).run(deviceId, now, now, disabled ? 1 : 0, now);
  const dev = cachedDevices.find(d => d.id === deviceId);
  if (dev) dev.disabled = disabled;
  getEventManager().emitDeviceListChanged(cachedDevices.length);
  return dev;
}

// 设备是否被禁用(内存缓存优先,DB 兜底——用于 cast/控制链路的防绕过校验)。
export function isDeviceDisabled(deviceId: string): boolean {
  const dev = cachedDevices.find(d => d.id === deviceId);
  if (dev) return !!dev.disabled;
  const row = sqlite.prepare("SELECT disabled FROM dlna_devices WHERE id = ?").get(deviceId) as any;
  return !!row?.disabled;
}

// 彻底删除设备:DB 行 + 内存缓存 + runtimes。队列/peer/群组成员由路由层处理。
// 返回设备之前是否存在。
export function deleteDeviceRecord(deviceId: string): boolean {
  const existed = cachedDevices.some(d => d.id === deviceId) ||
    !!sqlite.prepare("SELECT 1 FROM dlna_devices WHERE id = ?").get(deviceId);
  const idx = cachedDevices.findIndex(d => d.id === deviceId);
  if (idx >= 0) cachedDevices.splice(idx, 1);
  runtimes.delete(deviceId);
  sqlite.prepare("DELETE FROM dlna_devices WHERE id = ?").run(deviceId);
  return existed;
}

// 启动时从 DB 恢复持久化设备(离线设备也在列表中,用户可手动管理)。
// 注意:恢复的设备没有 description 缓存(无 location/control URL),无法立即播放,
// 因此一律按离线处理;等首次 M-SEARCH 扫描或 SSDP alive 到达后再置为在线。
export function loadPersistedDevices(): void {
  const rows = sqlite.prepare(
    "SELECT id, name, alias, manufacturer, model, last_seen, disabled FROM dlna_devices"
  ).all() as any[];
  for (const r of rows) {
    if (cachedDevices.some(d => d.id === r.id)) continue;
    cachedDevices.push({
      id: r.id,
      name: r.name || "未知设备",
      alias: r.alias || undefined,
      location: "",
      manufacturer: r.manufacturer || undefined,
      model: r.model || undefined,
      lastSeen: r.last_seen ? Date.parse(r.last_seen) || 0 : 0,
      available: false,
      disabled: !!r.disabled,
    });
  }
}

// 设备显示名:alias || name(播放控件 / HA 卡片 / 群组页统一用它)。
export function deviceDisplayName(d: DlnaDevice): string {
  return (d.alias || d.name || d.id).trim();
}

export function getCachedDevices(): DlnaDevice[] {
  return cachedDevices;
}

// ==================== Real-time SSDP wiring ====================
// The passive SSDP listener (discovery.ts) sees ssdp:alive / ssdp:byebye the
// moment a device comes online / goes offline. Without this wiring those
// announcements only landed in the listener's internal map and the cache was
// refreshed solely by the 5-min M-SEARCH sweep — so a device that had just
// powered on stayed invisible to clients (Web/App/HA card) for minutes.
// Here we: fetch its description immediately, upsert the cache, and emit
// device_list_changed → peer reconcile → WS peer_registered/peer_available →
// the HA card / Web switcher show (or dim) the device in real time.
let ssdpRealtimeWired = false;
export function wireSsdpRealtime(): void {
  if (ssdpRealtimeWired) return;
  ssdpRealtimeWired = true;
  onSsdpEvent(async (e) => {
    try {
      if (e.type === "alive") {
        const d = await fetchDeviceAtLocation(e.location);
        if (!d) return;
        const idx = cachedDevices.findIndex((x) => x.id === d.id);
        const wasAvailable = idx >= 0 ? cachedDevices[idx].available : false;
        if (idx >= 0) {
          cachedDevices[idx] = { ...cachedDevices[idx], ...d, available: true };
          upsertDeviceRow(cachedDevices[idx]);
        } else {
          cachedDevices.push(d);
          upsertDeviceRow(d);
        }
        // 只在「新设备」或「离线→上线」时广播,避免周期性通告反复刷屏。
        if (idx < 0 || !wasAvailable) getEventManager().emitDeviceListChanged(cachedDevices.length);
      } else {
        // byebye:设备明确下线——标记离线并保留在列表/DB(供「播放器」页管理),
        // 不再从缓存移除。USN 首段即 UDN,与设备 id 一致。
        const dev = cachedDevices.find((x) => x.id === e.udn);
        if (dev && dev.available) {
          dev.available = false;
          markDeviceOfflineInDb(dev.id);
          getEventManager().emitDeviceListChanged(cachedDevices.length);
        }
      }
    } catch { /* realtime update failures are non-fatal */ }
  });
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
  // 禁用设备不可投屏(防绕过:不仅是 UI 不可见,直接调 API 也拒绝)。
  if (isDeviceDisabled(opts.deviceId)) throw new Error("设备已禁用");
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
  // 起播信号:让 HA 卡片等客户端立即强制拉取最新状态(不依赖 GENA 事件/轮询周期)。
  getEventManager().emit("player_refresh", opts.deviceId, { reason: "play_started" });
  // 新歌开始即清空位置基线(与上面 songId 检测双保险),确保 position 从 0 起算,
  // 不会把上一首的进度带进新歌。
  positionEstimates.delete(opts.deviceId);

  // Best-effort: subscribe to GENA events so we get push updates. If it
  // fails we silently fall back to polling (forcePoll stays true).
  getEventManager().subscribe(device).catch(() => {});
  console.log(`[cast] ${opts.deviceId}: END songId=${opts.songId}`);
  return { mediaUri: streamUrl };
}

/** 在设备上直接播放任意外部 URL(不经过 cast session / 曲库)。
 *
 *  castToDevice 强绑 songId —— 它要先 createCastSession 换一个本地流地址。
 *  播报(TTS)放的是 HA 生成的外链,库里没有对应歌曲,所以单开这条路径。
 *  刻意不写 runtimeOf().currentMedia:播报是瞬时插播,不该污染"正在播放"的
 *  曲目信息,否则播报期间 HA/前端会把 TTS 显示成当前歌曲。 */
export async function playUriOnDevice(
  deviceId: string,
  uri: string,
  opts: { title?: string; mime?: string } = {},
): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到或不可用");
  const metadata = buildDidlLite({
    title: opts.title || "Announcement",
    uri,
    mime: opts.mime || "audio/mpeg",
  });
  try { await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" }); } catch {}
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "SetAVTransportURI", {
    InstanceID: "0",
    CurrentURI: uri,
    CurrentURIMetaData: metadata,
  });
  await waitForCanPlay(device);
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Play", { InstanceID: "0", Speed: "1" });
  markOk(deviceId);
}

/** 轮询设备传输状态,直到不再处于 PLAYING/TRANSITIONING(即播完)或超时。
 *  播报时长未知(TTS 长度取决于文本),所以只能轮询收敛。 */
export async function waitUntilStopped(deviceId: string, budgetMs = 300000): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) return;
  const deadline = Date.now() + budgetMs;
  // 起播本身要时间,先给 1.5s 缓冲再开始判定,否则会立刻读到尚未变成 PLAYING
  // 的旧状态,误判成"已经播完"。
  await new Promise(r => setTimeout(r, 1500));
  while (Date.now() < deadline) {
    try {
      const xml = await soapCall(device.avTransportUrl, AV_TRANSPORT, "GetTransportInfo", { InstanceID: "0" });
      const st = xml.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i)?.[1].trim();
      if (st && st !== "PLAYING" && st !== "TRANSITIONING") return;
    } catch {
      return; // 设备失联,别把调用方永远吊着
    }
    await new Promise(r => setTimeout(r, 1000));
  }
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
    // 立刻把新传输状态写进事件缓存并推 WS,HA 侧无需等轮询即可同步(双向同步)。
    getEventManager().setTransportState(deviceId, "PLAYING");
  } catch (e: any) { markFailed(deviceId, "Play", e); throw e; }
}

export async function pauseDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Pause", { InstanceID: "0" });
    markOk(deviceId);
    // 立刻把新传输状态写进事件缓存并推 WS,HA 侧无需等轮询即可同步(双向同步)。
    getEventManager().setTransportState(deviceId, "PAUSED_PLAYBACK");
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
    // 立刻把新传输状态写进事件缓存并推 WS,HA 侧无需等轮询即可同步(双向同步)。
    getEventManager().setTransportState(deviceId, "STOPPED");
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
    // 立刻把新进度写进事件缓存并推 WS,HA 侧无需等轮询即可同步(双向同步)。
    getEventManager().setPosition(deviceId, seconds);
  } catch (e: any) { markFailed(deviceId, "Seek", e); throw e; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AlignOpts {
  tries?: number;
  intervalMs?: number;
  toleranceSec?: number;
  settleTries?: number;
  settleIntervalMs?: number;
  /** 每次 seek 前取实时目标位置(默认用固定 targetSec)。加入对齐时传 leader 的实时位置,
   *  避免 settle 等待期间 leader 继续前进导致目标过期。 */
  getTargetSec?: () => number | Promise<number>;
}

// 一次性"校准 seek":部分渲染器在 SetAVTransportURI/Play 后立刻接收 Seek 会静默失效
// (实测 HiVi:cast→立即 seek 不生效,已进入稳定 PLAYING 后手动 seek 正常)。于是先等设备
// 进入"正在播放且位置前进"的稳定态(默认最多 ~10s),再 seek+轮询设备位置收敛到目标。
// 仅在"新成员加入对齐 / 离线恢复续播"这类一次性对齐场景使用(纯 MA 忠实,无周期校正)。
export async function alignDeviceToPosition(
  deviceId: string,
  targetSec: number,
  opts?: AlignOpts,
): Promise<number> {
  const tries = opts?.tries ?? 3;
  const intervalMs = opts?.intervalMs ?? 1000;
  const toleranceSec = opts?.toleranceSec ?? 3;
  // 等设备进入稳定 PLAYING(位置开始前进)再 seek;超过 settle 上限也继续(尽力而为)。
  const settleTries = opts?.settleTries ?? 10;
  const settleIntervalMs = opts?.settleIntervalMs ?? 1000;
  for (let i = 0; i < settleTries; i++) {
    try {
      const s = await getDeviceStatus(deviceId);
      if (s.state === "PLAYING" && (s.position ?? 0) > 0) break;
    } catch {}
    await sleep(settleIntervalMs);
  }
  let lastPos = 0;
  for (let i = 0; i < tries; i++) {
    const target = opts?.getTargetSec ? await opts.getTargetSec() : targetSec;
    try {
      await seekDevice(deviceId, target);
      await sleep(intervalMs);
      const s = await getDeviceStatus(deviceId);
      lastPos = s.position ?? 0;
      if (Math.abs(lastPos - target) <= toleranceSec) break;
    } catch {
      // 设备偶发抖动(如 seek 期间 transport 被重置),继续重试。
    }
  }
  const finalTarget = opts?.getTargetSec ? await opts.getTargetSec() : targetSec;
  if (Math.abs(lastPos - finalTarget) > toleranceSec) {
    console.warn(`[align] ${deviceId} 目标 ${Math.round(finalTarget)}s,校准后仍在 ${lastPos}s(设备可能不支持 seek)`);
  }
  return lastPos;
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
    // 立刻把新音量写进事件缓存并推 WS,HA 侧无需等轮询即可同步(双向同步)。
    getEventManager().setVolume(deviceId, vol);
  } catch (e: any) { markFailed(deviceId, "SetVolume", e); throw e; }
}

/** 静音开关(RenderingControl SetMute)。与音量相互独立:静音不改变 Volume 值,
 *  取消静音后设备恢复原音量,所以不能用 "音量设 0" 来冒充静音。 */
export async function setDeviceMute(deviceId: string, muted: boolean): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.renderingControlUrl) throw new Error("设备不支持静音控制");
  try {
    await soapCall(device.renderingControlUrl, RENDERING_CONTROL, "SetMute", {
      InstanceID: "0",
      Channel: "Master",
      DesiredMute: muted ? "1" : "0",
    });
    markOk(deviceId);
    getEventManager().setMuted(deviceId, muted);
  } catch (e: any) { markFailed(deviceId, "SetMute", e); throw e; }
}

export interface DeviceStatus {
  state: string;      // PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING / NO_MEDIA_PRESENT
  position: number;   // seconds
  duration: number;   // seconds
  volume: number;     // 0-100
  muted: boolean;     // RenderingControl Mute
  media?: CurrentMedia; // currently loaded track (set by castToDevice)
  trackUri?: string;   // 当前 TrackURI(来自 GetPositionInfo),供 poll 路径 track_changed 检测
  updatedAt: number;  // ms epoch,本次 position 采样的时刻(供 HA 插值对齐)
}

// Monotonic position estimate per device. Some DLNA renderers don't report
// RelTime on every GetPositionInfo (or return 0 / "NOT_IMPLEMENTED"), which
// would make the Web/HA progress bar snap back to 0 on each 2s poll. We cache
// the last credible SOAP sample and, while PLAYING, advance it by wall-clock
// elapsed so the reported position keeps increasing smoothly between polls.
const positionEstimates = new Map<string, { pos: number; at: number; dur: number; trackUri?: string }>();
const POSITION_ESTIMATE_MAX_AGE_MS = 30_000; // 超过此时长不再外推,避免暂停久后跳变

// 记录每台设备"当前已加载曲目"的 songId,用于在不依赖 TrackURI 的情况下检测换歌,
// 从而重置上面的单调位置基线(某些 DLNA 设备 GetPositionInfo 不回传 TrackURI,
// 导致下面的 TrackURI 分支永不触发,position 会跨歌累加)。currentMedia 在
// castToDevice 加载新歌时即更新,对比上一首即可精准重置。
const positionEstimateSong = new Map<string, string | undefined>();

// Query current transport state + position + volume via SOAP.
// Returns a default STOPPED status when the device is not in cache (e.g.
// right after a server restart, before background discovery repopulates it)
// instead of throwing — the frontend polls this every few seconds and a 500
// would spam the logs and break the cast UI.
export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
  const device = getDevice(deviceId);
  const sampledAt = Date.now();
  if (!device?.avTransportUrl) return { state: "STOPPED", position: 0, duration: 0, volume: 0, muted: false, media: getCurrentMedia(deviceId), updatedAt: sampledAt };
  const state: DeviceStatus = { state: "STOPPED", position: 0, duration: 0, volume: 0, muted: false, media: getCurrentMedia(deviceId), updatedAt: sampledAt };

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
    // GetMute —— 单独一次调用。部分设备实现了 GetVolume 却没实现 GetMute,
    // 所以独立 try,失败只当作"未静音",不影响音量读数。
    try {
      const xml = await soapCall(device.renderingControlUrl, RENDERING_CONTROL, "GetMute", { InstanceID: "0", Channel: "Master" });
      const mm = xml.match(/<CurrentMute>([^<]*)<\/CurrentMute>/i);
      if (mm) {
        const v = mm[1].trim().toLowerCase();
        state.muted = v === "1" || v === "true" || v === "yes";
      }
    } catch {}
  }

  // ---- 换歌检测:用 currentMedia.songId 兜底重置位置基线 ----
  // 比 TrackURI 更可靠——部分设备 GetPositionInfo 不回传 TrackURI,导致下面的
  // TrackURI 分支永不触发,position 会跨歌累加。currentMedia 在 castToDevice
  // 加载新歌时即更新,这里对比上一首即可精准重置(详见 positionEstimateSong)。
  const curSong = getCurrentMedia(deviceId)?.songId;
  const lastSong = positionEstimateSong.get(deviceId);
  if (curSong && lastSong && curSong !== lastSong) {
    positionEstimates.delete(deviceId);
  }
  positionEstimateSong.set(deviceId, curSong);

  // ---- 单调位置估计(修 DLNA 进度不前进) ----
  // 切歌(TrackURI 变化)则重置基线,避免用上一首的进度外推。
  const cachedBaseline = positionEstimates.get(deviceId);
  if (cachedBaseline && state.trackUri && cachedBaseline.trackUri && cachedBaseline.trackUri !== state.trackUri) {
    positionEstimates.delete(deviceId);
  }
  const base = positionEstimates.get(deviceId);
  if (state.state === "PLAYING") {
    if (state.position > 0) {
      // 本次 SOAP 采样可信 -> 作为新基线(顺带记下 duration 用于封顶/兜底)。
      positionEstimates.set(deviceId, { pos: state.position, at: sampledAt, dur: state.duration, trackUri: state.trackUri });
    } else {
      // 设备本次未上报 position(返回 0/未实现) -> 用上次基线 + 墙上时钟外推。
      if (base && base.pos > 0 && Date.now() - base.at < POSITION_ESTIMATE_MAX_AGE_MS) {
        let adv = base.pos + (Date.now() - base.at) / 1000;
        if (base.dur > 0) adv = Math.min(adv, base.dur);
        state.position = adv;
        // 刷新基线时间戳,让外推持续前进(下一次若仍 0 继续接力)。
        positionEstimates.set(deviceId, { pos: adv, at: Date.now(), dur: base.dur, trackUri: base.trackUri });
      }
      // 否则从未拿到过可信 position -> 保持 0
    }
    // duration 缺失(设备不报 TrackDuration)时用基线里记住的 duration 兜底,
    // 否则前端 tickTimer 因 duration<=0 不本地插值,进度只能靠 2s 轮询跳进。
    if (state.duration <= 0 && base && base.dur > 0) state.duration = base.dur;
  } else {
    // 非播放态不外推,清掉基线,下次播放从 0 重新起算。
    positionEstimates.delete(deviceId);
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
