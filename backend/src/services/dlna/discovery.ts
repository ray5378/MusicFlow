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
  location: string;      // description.xml URL
  manufacturer?: string;
  model?: string;
  avTransportUrl?: string;
  renderingControlUrl?: string;
  lastSeen: number;      // ms epoch — updated on every SSDP message from this device
  available: boolean;    // false when byebye received or staleness exceeded
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

// ==================== Continuous SSDP listener ====================
// A long-lived UDP socket that joins the SSDP multicast group and listens for
// NOTIFY messages from devices. MA's SsdpListener does the same. We keep a
// registry of all announced devices (by USN/UDN) so the active M-SEARCH
// result can be merged with passively-discovered ones.
let listenerSocket: dgram.Socket | null = null;
const announced = new Map<string, { location: string; lastSeen: number; usn: string }>();

function startListener() {
  if (listenerSocket) return;
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("error", () => {}); // never crash on socket errors
  sock.on("message", (msg) => {
    const text = msg.toString();
    const isNotify = /^NOTIFY \* HTTP\/1\.1/i.test(text);
    if (!isNotify) return;
    const loc = text.match(/^LOCATION:\s*(.+)$/im)?.[1].trim();
    const nts = text.match(/^NTS:\s*(.+)$/im)?.[1].trim();
    const usn = text.match(/^USN:\s*(.+)$/im)?.[1].trim() || "";
    if (!loc) return;
    // ssdp:byebye → device is going offline
    if (nts === "ssdp:byebye") {
      announced.delete(usn);
      return;
    }
    // ssdp:alive / ssdp:update → device is (re)announcing itself
    if (nts === "ssdp:alive" || nts === "ssdp:update") {
      announced.set(usn, { location: loc, lastSeen: Date.now(), usn });
    }
  });
  sock.bind(SSDP_PORT, () => {
    try { sock.addMembership(SSDP_ADDR); } catch {}
  });
  listenerSocket = sock;
}

// Merge actively discovered devices (from M-SEARCH responses) with passively
// announced ones (from the NOTIFY listener) and refresh lastSeen.
async function mergeAndFetch(searchLocations: string[]): Promise<DlnaDevice[]> {
  const allLocations = new Set<string>(searchLocations);
  const now = Date.now();
  for (const [, info] of announced) {
    if (now - info.lastSeen < STALENESS_MS) allLocations.add(info.location);
  }
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
// by the background poller to keep the cached list fresh.
export function markStaleDevices(devices: DlnaDevice[]): DlnaDevice[] {
  const now = Date.now();
  for (const d of devices) {
    if (now - d.lastSeen > STALENESS_MS) d.available = false;
  }
  return devices;
}
