// DLNA/UPnP device discovery via SSDP (Simple Service Discovery Protocol).
//
// Two complementary mechanisms, mirroring Music Assistant's SsdpListener:
//   1. M-SEARCH multicast — actively query for MediaRenderers on demand.
//   2. Continuous NOTIFY listener — passively receive device announcements
//      (ssdp:alive / ssdp:byebye / ssdp:update) so we learn about devices
//      coming online or going offline without re-sending M-SEARCH.
//
// Each device's `lastSeen` timestamp is updated on every message; devices
// not heard from within the staleness window are marked unavailable so the
// UI can grey them out and the poller can skip them.
//
// Uses Node's native `dgram` module — zero external dependencies.
import dgram from "dgram";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const MR_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";
const STALENESS_MS = 10 * 60 * 1000; // 10 min without any SSDP message → unavailable

export interface DlnaServiceInfo {
  serviceType: string;
  controlUrl: string;   // absolute URL
}

export interface DlnaDevice {
  id: string;            // UDN (uuid)
  name: string;          // friendlyName
  alias?: string;        // 用户自定义显示名(持久化于 dlna_devices.alias),空则用 name
  location: string;      // description.xml URL
  manufacturer?: string;
  model?: string;
  avTransportUrl?: string;
  renderingControlUrl?: string;
  lastSeen: number;      // ms epoch — updated on every SSDP message from this device
  available: boolean;    // false when byebye received or staleness exceeded
  disabled?: boolean;    // 用户手动禁用(持久化于 dlna_devices.disabled):不出现在任何流转播放的入口,不可投屏
}

// Make a relative control URL absolute against the description base.
function toAbsolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// Fetch + parse description.xml, extract friendlyName / UDN / service URLs.
async function fetchDescription(location: string): Promise<DlnaDevice | null> {
  try {
    const resp = await fetch(location, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const xml = await resp.text();
    // Lightweight regex extraction — avoids pulling in a full XML parser
    // dependency. UPnP description XML is simple and well-structured.
    const pick = (tag: string): string => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
      return m ? m[1].trim() : "";
    };
    const friendlyName = pick("friendlyName") || "未知设备";
    const udn = pick("UDN");
    const manufacturer = pick("manufacturer");
    const model = pick("modelName");
    const id = udn.replace(/^uuid:/i, "") || location;

    // Parse service list — find AVTransport + RenderingControl control URLs.
    let avTransportUrl: string | undefined;
    let renderingControlUrl: string | undefined;
    const serviceRegex = /<service\b[^>]*>([\s\S]*?)<\/service>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = serviceRegex.exec(xml)) !== null) {
      const block = sm[1];
      const st = block.match(/<serviceType[^>]*>([^<]*)<\/serviceType>/i)?.[1].trim() || "";
      const cu = block.match(/<controlURL[^>]*>([^<]*)<\/controlURL>/i)?.[1].trim() || "";
      if (/AVTransport/i.test(st) && cu) {
        avTransportUrl = toAbsolute(cu, location);
      } else if (/RenderingControl/i.test(st) && cu) {
        renderingControlUrl = toAbsolute(cu, location);
      }
    }
    // A device without AVTransport can't be cast to — skip it.
    if (!avTransportUrl) return null;
    return { id, name: friendlyName, location, manufacturer, model, avTransportUrl, renderingControlUrl, lastSeen: Date.now(), available: true };
  } catch {
    return null;
  }
}

/** 上一轮 M-SEARCH 扫描是否因 socket 错误**提前结束**（结果不可信）。
 *
 * `discoverDlnaDevices` 的 socket `error` 分支会立刻 `finish()`，此时 `locations`
 * 还是空集 —— 若把这个空集当成「权威答案」，一次瞬时 socket 错误就能把**全网设备**
 * 一次性判成离线（静默退化：错误被吞、现象是全端设备消失）。所以这里留一个标记，
 * 由 `refreshDevices` 跳过该轮的离线判定。
 */
let lastScanErrored = false;
/** 上一轮扫描结果是否不可信（见 `lastScanErrored`）。 */
export function lastScanWasErrored(): boolean { return lastScanErrored; }

// ==================== Continuous SSDP listener ====================
// A long-lived UDP socket that joins the SSDP multicast group and listens for
// NOTIFY messages from devices. MA's SsdpListener does the same. We keep a
// registry of all announced devices (by USN/UDN) so the active M-SEARCH
// result can be merged with passively-discovered ones.
let listenerSocket: dgram.Socket | null = null;
const announced = new Map<string, { location: string; lastSeen: number; usn: string }>();

// ==================== Real-time SSDP events ====================
// Subscribers (control.ts) are fired the moment a device (re)announces itself
// (ssdp:alive/update) or goes offline (ssdp:byebye), so the device cache +
// peer registry + WS push update in real time instead of waiting for the
// next 5-minute M-SEARCH sweep.
export type SsdpEvent =
  | { type: "alive"; location: string }
  | { type: "byebye"; udn: string };
const ssdpEventCbs = new Set<(e: SsdpEvent) => void>();
export function onSsdpEvent(cb: (e: SsdpEvent) => void): void { ssdpEventCbs.add(cb); }
function emitSsdpEvent(e: SsdpEvent): void {
  for (const cb of ssdpEventCbs) { try { cb(e); } catch { /* subscriber errors are non-fatal */ } }
}
// A device re-announces itself periodically; debounce "alive" per location so
// we only treat it as a (re)appearance once per minute.
const lastAliveEmitAt = new Map<string, number>();
const ALIVE_EMIT_DEBOUNCE_MS = 60 * 1000;

/** 实时 alive 处理（含重试）最终失败 → 放开去抖，让后续通告 / 扫描立刻接管。
 *
 * 去抖窗口在 emit 时「先占位」——真实设备一次上电会连发多条 NT（同一 LOCATION，
 * 毫秒级），只需处理其中一条。但**处理失败必须把它放开**：设备刚上电 / 刚被第三方
 * App（音流等）拉起时，它的 SSDP 栈往往先于内嵌 HTTP 服务就绪，此刻抓 description
 * 必然失败；旧实现提前消耗去抖 + 失败静默丢弃（`if (!d) return`）⇒ 这次上线窗口被
 * 彻底浪费，用户要等下一轮主动扫描（旧 5 分钟）才在列表里看到设备
 * （真机实测：HTTP 恢复后还要 85s 才可见）。 */
export function clearAliveEmit(location: string): void {
  lastAliveEmitAt.delete(location);
}

/** Fetch a single device's description by its SSDP location URL. */
export function fetchDeviceAtLocation(location: string): Promise<DlnaDevice | null> {
  return fetchDescription(location);
}

/** 处理一条 NOTIFY 报文的副作用（登记通告 / 触发 alive / byebye）。
 *
 * 从 socket 回调里抽出来是为了**可单测**：alive 去抖窗口何时被消耗、失败后又如何
 * 被放开，正是「设备上电后迟迟不出现」的根因所在（见 `clearAliveEmit` 注释）。 */
export function handleNotifyText(text: string): void {
  const isNotify = /^NOTIFY \* HTTP\/1\.1/i.test(text);
  if (!isNotify) return;
  const loc = text.match(/^LOCATION:\s*(.+)$/im)?.[1].trim();
  const nts = text.match(/^NTS:\s*(.+)$/im)?.[1].trim();
  const usn = text.match(/^USN:\s*(.+)$/im)?.[1].trim() || "";
  if (!loc) return;
  // ssdp:byebye → device is going offline
  if (nts === "ssdp:byebye") {
    announced.delete(usn);
    const m = usn.match(/uuid:([^:]+)/i);
    if (m) emitSsdpEvent({ type: "byebye", udn: m[1] });
    return;
  }
  // ssdp:alive / ssdp:update → device is (re)announcing itself
  if (nts === "ssdp:alive" || nts === "ssdp:update") {
    announced.set(usn, { location: loc, lastSeen: Date.now(), usn });
    const last = lastAliveEmitAt.get(loc) || 0;
    if (Date.now() - last > ALIVE_EMIT_DEBOUNCE_MS) {
      // 先占位：真实设备一次上电会连发多条 NT（同一 LOCATION，毫秒级），
      // 这样只触发**一条**处理链；该链重试全失败时由 clearAliveEmit 放开，
      // 让设备后续的通告立刻能再触发一次。
      lastAliveEmitAt.set(loc, Date.now());
      emitSsdpEvent({ type: "alive", location: loc });
    }
  }
}

function startListener() {
  if (listenerSocket) return;
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("error", () => {}); // never crash on socket errors
  sock.on("message", (msg) => handleNotifyText(msg.toString()));
  sock.bind(SSDP_PORT, () => {
    try { sock.addMembership(SSDP_ADDR); } catch {}
  });
  listenerSocket = sock;
}

// Merge actively discovered devices (from M-SEARCH responses) with passively
// announced ones (from the NOTIFY listener) and refresh lastSeen. Also prune
// announced entries not heard from within the staleness window — a device that
// powered off without sending byebye must not linger in the registry forever.
async function mergeAndFetch(searchLocations: string[]): Promise<DlnaDevice[]> {
  const allLocations = new Set<string>(searchLocations);
  const now = Date.now();
  for (const [usn, info] of announced) {
    if (now - info.lastSeen < STALENESS_MS) {
      allLocations.add(info.location);
    } else {
      announced.delete(usn);
    }
  }
  // 顺带清掉已不在活动集合中的 alive 去抖记录(key=location 只增不删,设备去留累积)。
  for (const loc of lastAliveEmitAt.keys()) if (!allLocations.has(loc)) lastAliveEmitAt.delete(loc);
  const devices = await Promise.all(Array.from(allLocations).map(fetchDescription));
  // Deduplicate by id (a device may appear via both M-SEARCH and NOTIFY).
  const byId = new Map<string, DlnaDevice>();
  for (const d of devices) {
    if (!d) continue;
    const existing = byId.get(d.id);
    if (!existing || d.lastSeen > existing.lastSeen) byId.set(d.id, d);
  }
  return Array.from(byId.values());
}

// Discover MediaRenderer devices on the LAN via SSDP M-SEARCH, merged with
// any devices the passive listener has seen. Waits up to `timeoutMs` for
// M-SEARCH responses, then resolves the de-duplicated list.
export function discoverDlnaDevices(timeoutMs = 4000): Promise<DlnaDevice[]> {
  // Ensure the passive listener is running so we catch NOTIFY announcements.
  startListener();
  return new Promise((resolve) => {
    const locations = new Set<string>();
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    lastScanErrored = false;   // 新一轮开始，先认为结果可信

    const finish = async () => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      // Merge M-SEARCH results with passively-announced devices, fetch all
      // descriptions in parallel.
      const devices = await mergeAndFetch(Array.from(locations));
      resolve(devices);
    };

    socket.on("error", () => {
      // 早退：此轮结果不可信（空集 ≠「全网都没设备」），标记后由 refreshDevices 跳过离线判定。
      lastScanErrored = true;
      if (!settled) finish();
    });

    socket.on("message", (msg) => {
      const text = msg.toString();
      // Parse the HTTP response headers.
      const locMatch = text.match(/^LOCATION:\s*(.+)$/im);
      if (!locMatch) return;
      const location = locMatch[1].trim();
      locations.add(location);
    });

    // Bind first (required to receive on some platforms), then send M-SEARCH.
    socket.bind(() => {
      const req = [
        "M-SEARCH * HTTP/1.1",
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        "MX: 3",
        `ST: ${MR_ST}`,
        "",
        "",
      ].join("\r\n");
      const buf = Buffer.from(req);
      socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR);
    });

    setTimeout(finish, timeoutMs);
  });
}

// Mark a device unavailable if it hasn't been heard from in a while. Called
// by the device-list endpoint to keep the cached list fresh (devices that
// went quiet without a byebye are still listed but flagged offline).
export function markStaleDevices(devices: DlnaDevice[]): DlnaDevice[] {
  const now = Date.now();
  for (const d of devices) {
    if (now - d.lastSeen > STALENESS_MS) d.available = false;
  }
  return devices;
}
