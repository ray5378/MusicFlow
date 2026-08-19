// AirPlay (RAOP) device discovery via mDNS — mirrors how Music Assistant finds
// RAOP endpoints (`_raop._tcp.local.`). Zero new dependencies: we browse with
// the same `bonjour-service` package the backend already ships.
//
// Notes:
//   - We only browse `_raop._tcp` (AirPlay 1). AirPlay 2 (`_airplay._tcp`) is
//     NOT supported: it needs a different protocol (HAP pairing / encrypted
//     RTSP / ALAC realtime) and there are no AP2 test devices on hand, so pure
//     AP2-only receivers simply stay undiscovered.
//   - TXT fields we care about: `et` (encryption types, `1` = RSA supported),
//     `pk` (device RSA public key, base64), `am` (model name), `flags`, `vv`.
import { Bonjour, Service, Browser } from "bonjour-service";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AIRPLAY");

export interface AirPlayDevice {
  id: string;          // stable id (service-name token before `@`, else fqdn)
  name: string;        // friendly name from mDNS (@ 之后部分,剥离 ID 前缀)
  alias?: string;      // 用户自定义显示名(持久化于 airplay_devices.alias),空则用 name
  disabled?: boolean;  // 用户手动禁用(持久化于 airplay_devices.disabled):不出现在任何选择播放器的地方
  host: string;        // routable host/IP
  port: number;        // RTSP port (4515 on LinkPlay devices, 5000 classic)
  pk?: string;         // TXT pk — device RSA public key (base64)
  et?: string;         // TXT et — "0,1" typical (1 = RSA-encrypted RAOP)
  am?: string;         // TXT am — model name
  flags?: string;
  supportsRsa: boolean;// et contains "1"
  lastSeen: number;    // ms epoch
  available: boolean;
}

const STALENESS_MS = 90 * 1000; // no mDNS refresh in 90s → mark unavailable

let bonjour: Bonjour | null = null;
let browser: Browser | null = null;
const devices = new Map<string, AirPlayDevice>();

export type AirPlayEvent =
  | { type: "alive"; device: AirPlayDevice }
  | { type: "byebye"; id: string };
const listeners = new Set<(e: AirPlayEvent) => void>();
export function onAirPlayEvent(cb: (e: AirPlayEvent) => void): void {
  listeners.add(cb);
}
function emit(e: AirPlayEvent): void {
  for (const cb of listeners) {
    try { cb(e); } catch (err) { log.warn("airplay 事件订阅者异常", { err: (err as Error)?.message || err }); }
  }
}

/** Persistence hook, wired by control.ts (keeps discovery UI-free). Called with
 *  a discovered/offline device so its row is upserted (alias/disabled preserved).
 *  Returning a device lets discovery re-apply persisted alias/disabled. */
type PersistFn = (d: AirPlayDevice, online: boolean) => AirPlayDevice;
let persist: PersistFn | null = null;
export function setAirPlayPersist(fn: PersistFn | null): void {
  persist = fn;
}

function deviceIdOf(svc: Service): string {
  const name = svc.name || "";
  const at = name.indexOf("@");
  if (at > 0) return name.slice(0, at);
  return svc.fqdn || svc.host || `${svc.host}:${svc.port}`;
}

/** Friendly name from mDNS: strip the leading "<id>@" token, keep the rest
 *  ("00226CFFA0C0@HiVi H5MKII" → "HiVi H5MKII"). Falls back to the raw name
 *  when there is no "@" delimiter. */
function friendlyNameOf(svc: Service): string {
  const name = svc.name || "";
  const at = name.indexOf("@");
  if (at >= 0) return name.slice(at + 1).trim() || name;
  return name || deviceIdOf(svc);
}

function upsert(svc: Service, available = true): void {
  const txt: Record<string, string> = {};
  for (const k of Object.keys(svc.txt || {})) txt[k] = String(svc.txt[k]);
  const addr = svc.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.host || "";
  if (!addr || !svc.port) return;
  const id = deviceIdOf(svc);
  const et = txt.et || txt["et"] || "";
  const existing = devices.get(id);
  const dev: AirPlayDevice = {
    id,
    name: friendlyNameOf(svc),
    host: addr,
    port: svc.port,
    pk: txt.pk || undefined,
    et: et || undefined,
    am: txt.am || txt["am"] || undefined,
    flags: txt.flags !== undefined ? txt.flags : undefined,
    supportsRsa: et.includes("1"),
    lastSeen: Date.now(),
    available,
  };
  // Re-apply persisted alias/disabled (survive restart + re-discovery).
  if (persist) {
    const merged = persist(dev, available);
    if (merged) {
      dev.alias = merged.alias;
      dev.disabled = merged.disabled;
    }
  }
  const first = !existing;
  devices.set(id, dev);
  if (first || !existing!.available || existing!.available !== available) {
    emit({ type: "alive", device: dev });
  }
}

/** Start continuous mDNS browsing for AirPlay receivers. Idempotent. */
export function startAirPlayDiscovery(): void {
  if (browser) return;
  try {
    bonjour = new Bonjour();
  } catch (e: any) {
    log.warn("mDNS unavailable", { err: e?.message });
    return;
  }
  browser = bonjour.find({ type: "raop" }, (svc: Service) => {
    upsert(svc, true);
  }) as Browser;
  browser.on("up", (svc: Service) => upsert(svc, true));
  browser.on("down", (svc: Service) => {
    const id = deviceIdOf(svc);
    const dev = devices.get(id);
    if (dev) {
      dev.available = false;
      emit({ type: "byebye", id });
    }
  });
  browser.on("txt-update", (svc: Service) => upsert(svc, true));
  browser.on("srv-update", (svc: Service) => upsert(svc, true));
  // Some receivers (e.g. HiVi H5MKII) answer a brand-new PTR/SRV query but
  // silently ignore `browser.update()` re-queries on the same handle, so the
  // 90s staleness would mark them unavailable even though they are still on
  // the LAN. Work around it by periodically spinning a short-lived fresh
  // browser that only refreshes lastSeen (its query also reaches the
  // persistent browser, which handles alive/up/down events as usual).
  const tick = setInterval(() => {
    try {
      const refresh = bonjour?.find({ type: "raop" }, (svc: Service) => {
        const dev = devices.get(deviceIdOf(svc));
        if (dev) {
          dev.lastSeen = Date.now();
          dev.available = true;
        }
      }) as Browser | undefined;
      const stop = setTimeout(() => { try { refresh?.stop(); } catch { /* ignore */ } }, 3000);
      stop.unref?.();
    } catch { /* ignore */ }
  }, 30_000);
  tick.unref?.();
  log.info("mDNS discovery started (_raop._tcp)");
}

/** Current device list (with staleness applied at read time). */
export function getAirPlayDevices(): AirPlayDevice[] {
  const now = Date.now();
  for (const d of devices.values()) {
    if (now - d.lastSeen > STALENESS_MS) d.available = false;
  }
  return Array.from(devices.values());
}

export function getAirPlayDevice(id: string): AirPlayDevice | undefined {
  const d = devices.get(id);
  if (d && Date.now() - d.lastSeen > STALENESS_MS) d.available = false;
  return d;
}

/** Insert a device restored from DB (offline until mDNS rediscovers it). */
export function addPersistedAirPlayDevice(dev: AirPlayDevice): void {
  devices.set(dev.id, dev);
}

/** Remove a device (permanent user delete). */
export function removeAirPlayDevice(id: string): void {
  devices.delete(id);
}