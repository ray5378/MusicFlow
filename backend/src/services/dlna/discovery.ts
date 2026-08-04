// DLNA/UPnP device discovery via SSDP (Simple Service Discovery Protocol).
//
// Uses Node's native `dgram` module — zero external dependencies. Sends an
// M-SEARCH multicast for MediaRenderer devices, collects responses, then fetches
// each device's description.xml to extract friendly name, UDN and service
// control URLs (AVTransport + RenderingControl).
//
// Reference: Music Assistant's DLNA provider uses the same flow (SSDP →
// description.xml → SCPD parsing) but via Python's async_upnp_client.
import dgram from "dgram";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const MR_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";

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
    return { id, name: friendlyName, location, manufacturer, model, avTransportUrl, renderingControlUrl };
  } catch {
    return null;
  }
}

// Discover MediaRenderer devices on the LAN via SSDP M-SEARCH.
// Waits up to `timeoutMs` for responses, then resolves the de-duplicated list.
export function discoverDlnaDevices(timeoutMs = 4000): Promise<DlnaDevice[]> {
  return new Promise((resolve) => {
    const locations = new Map<string, string>(); // location → (for dedup)
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;

    const finish = async () => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      // Fetch descriptions for all discovered locations in parallel.
      const uniq = Array.from(locations.keys());
      const devices = await Promise.all(uniq.map(fetchDescription));
      resolve(devices.filter(Boolean) as DlnaDevice[]);
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
      if (!locations.has(location)) locations.set(location, location);
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
