// AirPlay device discovery via mDNS — mirrors how Music Assistant finds
// RAOP endpoints (`_raop._tcp.local.`). Zero new dependencies: we browse with
// the same `bonjour-service` package the backend already ships.
//
// Notes:
//   - **设备表仍只由 `_raop._tcp` 产生**(AP1 链路的行为基线,逐字不变)。
//     `_airplay._tcp` 只用来给**已存在的** raop 设备打能力标记(`supportsAp2`),
//     纯 AP2-only 设备不会因此进入设备表 —— 在 AP2 发送端(E3~E5)落地前进来也投不了,
//     只会在 UI 里变成一个「点了报错」的死设备。
//   - AP2 判定不靠记忆里的某一个 features 位:以「同时广播 `_airplay._tcp` 且
//     `protovers ≥ 1.1`」为准,并把 `features/srcvers/protovers/gid/flags` 原样留存
//     给 E3 的握手/加密使用。位定义由 230 接收器实测反证,不凭猜。
//   - TXT fields we care about: `et` (encryption types, `1` = RSA supported),
//     `pk` (device RSA public key, base64), `am` (model name), `flags`, `vv`;
//     AP2 侧:`deviceid`(对齐键)/ `features` / `srcvers` / `protovers` / `gid`。
import { Bonjour, Service, Browser } from "bonjour-service";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AIRPLAY");

/** AP2 侧 TXT 能力快照(仅在设备同时广播 `_airplay._tcp` 时存在)。 */
export interface AirPlayAp2Info {
  features?: string;   // TXT features — 64 位能力位图(「0x低,0x高」)
  srcvers?: string;    // TXT srcvers — 设备固件版本
  protovers?: string;  // TXT protovers — 协议版本(≥ 1.1 才按 AP2 处理)
  flags?: string;
  gid?: string;        // TXT gid — 分组 id(AirPlay 2 多房间用,本课题不用)
  model?: string;
  lastSeen: number;    // ms epoch
}

export interface AirPlayDevice {
  id: string;          // stable id (service-name token before `@`, else fqdn)
  name: string;        // friendly name from mDNS (@ 之后部分,剥离 ID 前缀)
  alias?: string;      // 用户自定义显示名(持久化于 airplay_devices.alias),空则用 name
  disabled?: boolean;  // 用户手动禁用(持久化于 airplay_devices.disabled):不出现在任何流转播放的入口
  host: string;        // routable host/IP
  port: number;        // RTSP port (4515 on LinkPlay devices, 5000 classic)
  pk?: string;         // TXT pk — device RSA public key (base64)
  et?: string;         // TXT et — "0,1" typical (1 = RSA-encrypted RAOP)
  am?: string;         // TXT am — model name
  flags?: string;
  supportsRsa: boolean;// et contains "1"
  /** 该设备是否具备 AirPlay 2 能力(= 同时广播 `_airplay._tcp` 且 protovers ≥ 1.1)。
   *  **只是能力标记**:投屏仍走 AP1,直到 E3~E5 的发送端落地后才由 renderer 分流。 */
  supportsAp2: boolean;
  /** AP2 TXT 原始能力(没有 `_airplay._tcp` 记录时缺省)。 */
  ap2?: AirPlayAp2Info;
  lastSeen: number;    // ms epoch
  available: boolean;
}

const STALENESS_MS = 90 * 1000; // no mDNS refresh in 90s → mark unavailable

/** AP2 协议版本下限:低于 1.1 的 `_airplay._tcp` 广播不具备 AP2 会话语义。 */
const AP2_MIN_PROTOVERS: [number, number] = [1, 1];

let bonjour: Bonjour | null = null;
let browser: Browser | null = null;       // `_raop._tcp` — 设备表唯一来源
let ap2Browser: Browser | null = null;    // `_airplay._tcp` — 只提供能力标记
let tick: ReturnType<typeof setInterval> | null = null;
const devices = new Map<string, AirPlayDevice>();
/** deviceid(归一后)→ AP2 能力。与 devices 分表:能力可以**先于** raop 记录到达。 */
const ap2Caps = new Map<string, AirPlayAp2Info>();

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

/** 归一 mDNS 里的设备标识:`86:bc:3f:fb:a3:08` / `86BC3FFBA308` / `86-bc-…` → 同一键。
 *  `_raop` 记录把 MAC 写在服务名前缀(`<MAC>@<名字>`),`_airplay` 记录把它放在 TXT
 *  `deviceid` 里且**常带冒号** —— 不归一会导致两条记录永远对不上、AP2 能力标不上。 */
export function normalizeAp2DeviceId(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  const hex = t.replace(/[^0-9a-fA-F]/g, "");
  // 只在「整串就是 12 位十六进制(可带 : - 分隔)」时归一;fqdn 之类的 id 保持原样。
  return hex.length === 12 && /^[0-9a-fA-F:\-\s]+$/.test(t) ? hex.toUpperCase() : t;
}

/** `protovers ≥ min`(缺省 / 解析不出 → false:宁可不认 AP2,也不要误判后投屏失败)。 */
export function protoversAtLeast(v: string | undefined, min: [number, number]): boolean {
  if (!v) return false;
  const m = /(\d+)\s*\.\s*(\d+)/.exec(v);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

function txtOf(svc: Service): Record<string, string> {
  const txt: Record<string, string> = {};
  for (const k of Object.keys(svc.txt || {})) txt[k] = String(svc.txt[k]);
  return txt;
}

/** 把 AP2 能力挂到设备上(唯一写 `supportsAp2` 的地方)。 */
function applyAp2(dev: AirPlayDevice): void {
  const info = ap2Caps.get(normalizeAp2DeviceId(dev.id));
  dev.ap2 = info;
  dev.supportsAp2 = !!info && protoversAtLeast(info.protovers, AP2_MIN_PROTOVERS);
}

function findDeviceByNormalizedId(id: string): AirPlayDevice | undefined {
  const target = normalizeAp2DeviceId(id);
  for (const d of devices.values()) if (normalizeAp2DeviceId(d.id) === target) return d;
  return undefined;
}

/** 处理一条 `_airplay._tcp` 记录:只更新能力表(必要时刷新已存在设备的能力),
 *  **不建设备** —— 设备表唯一来源仍是 `_raop._tcp`(见文件头)。 */
function upsertAp2(svc: Service): void {
  const txt = txtOf(svc);
  const rawId = txt.deviceid || txt.deviceId || "";
  const id = normalizeAp2DeviceId(rawId);
  if (!id) return; // 没有 deviceid 无法与 raop 记录对齐,忽略(不猜)
  ap2Caps.set(id, {
    features: txt.features,
    srcvers: txt.srcvers,
    protovers: txt.protovers,
    flags: txt.flags,
    gid: txt.gid,
    model: txt.model,
    lastSeen: Date.now(),
  });
  const dev = devices.get(id) || findDeviceByNormalizedId(id);
  if (!dev) return; // 纯 AP2 广播:等它的 `_raop` 记录到了再标
  const before = dev.supportsAp2;
  applyAp2(dev);
  if (before !== dev.supportsAp2) emit({ type: "alive", device: dev });
}

/** `_airplay._tcp` 记录下线:清掉能力并让已存在设备翻回 supportsAp2=false。
 *  设备本身是否可用仍由 `_raop` 的 up/down 决定,这里不动 available。 */
function dropAp2(svc: Service): void {
  const txt = txtOf(svc);
  const id = normalizeAp2DeviceId(txt.deviceid || txt.deviceId || "");
  if (!id) return;
  ap2Caps.delete(id);
  const dev = devices.get(id) || findDeviceByNormalizedId(id);
  if (!dev) return;
  const before = dev.supportsAp2;
  applyAp2(dev);
  if (before !== dev.supportsAp2) emit({ type: "alive", device: dev });
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
    supportsAp2: false, // 由 applyAp2 填(取决于是否有 `_airplay._tcp` 能力)
    lastSeen: Date.now(),
    available,
  };
  applyAp2(dev);
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
  // 第二条 browser 只认 `_airplay._tcp`:给已发现的 raop 设备补 AP2 能力标记。
  // 独立句柄(而不是合并成一次 find)是因为 bonjour-service 的 find 只接受单个 type。
  ap2Browser = bonjour.find({ type: "airplay" }, (svc: Service) => upsertAp2(svc)) as Browser;
  ap2Browser.on("up", (svc: Service) => upsertAp2(svc));
  ap2Browser.on("txt-update", (svc: Service) => upsertAp2(svc));
  ap2Browser.on("srv-update", (svc: Service) => upsertAp2(svc));
  // `_airplay` 记录消失 ⇒ 该设备不再具备 AP2 能力(但设备本身是否在线由 raop 决定)。
  ap2Browser.on("down", (svc: Service) => dropAp2(svc));
  // Some receivers (e.g. HiVi H5MKII) answer a brand-new PTR/SRV query but
  // silently ignore `browser.update()` re-queries on the same handle, so the
  // 90s staleness would mark them unavailable even though they are still on
  // the LAN. Work around it by periodically spinning a short-lived fresh
  // browser that only refreshes lastSeen (its query also reaches the
  // persistent browser, which handles alive/up/down events as usual).
  tick = setInterval(() => {
    spinQuery(3000, (svc: Service) => {
      const dev = devices.get(deviceIdOf(svc));
      if (dev) {
        dev.lastSeen = Date.now();
        dev.available = true;
      }
    });
    // AP2 能力同样需要续期:部分接收端的 `_airplay` 记录不会主动重发 TXT。
    spinQuery(3000, (svc: Service) => upsertAp2(svc), "airplay");
  }, 30_000);
  tick.unref?.();
  log.info("mDNS discovery started (_raop._tcp 设备表 + _airplay._tcp AP2 能力)");
}

/** 停止 mDNS 浏览:销毁 browser + bonjour + 周期刷新定时器,释放网络 socket 与 CPU。
 *  关闭 AirPlay 插件时调用(零常驻资源)。幂等。设备内存列表由调用方负责清空。 */
export function stopAirPlayDiscovery(): void {
  if (tick) { clearInterval(tick); tick = null; }
  try { browser?.stop(); } catch { /* ignore */ }
  try { ap2Browser?.stop(); } catch { /* ignore */ }
  try { bonjour?.destroy(); } catch { /* ignore */ }
  browser = null;
  ap2Browser = null;
  bonjour = null;
  ap2Caps.clear(); // 能力是 mDNS 的派生物:停掉发现就没有意义了(避免下次启动残留旧能力)
  log.info("mDNS discovery stopped (_raop._tcp + _airplay._tcp)");
}

/** 开一个**短命的新** browser 句柄发一次 PTR/SRV 查询,`lifeMs` 后收掉(见上面 tick 的注释:
 *  常驻句柄上的 `update()` 重查会被部分接收端忽略,所以每次「刷新」都得换新句柄)。
 *  `onHit` 决定命中后的处理:
 *    - 30s 续期只续 `lastSeen`(alive/up/down 仍由常驻 browser 负责);
 *    - 手动重扫走 upsert,刚上电、常驻 browser 还没捞到的接收端因此立刻出现。 */
function spinQuery(lifeMs: number, onHit: (svc: Service) => void, type: "raop" | "airplay" = "raop"): void {
  try {
    const b = bonjour?.find({ type }, onHit) as Browser | undefined;
    const stop = setTimeout(() => { try { b?.stop(); } catch { /* ignore */ } }, lifeMs);
    stop.unref?.();
  } catch { /* ignore */ }
}

/** 手动重扫:立刻再发一次 mDNS(_raop._tcp) 查询,收集 `windowMs` 后收掉句柄再 resolve。
 *
 *  与 30s 续期走同一条通路,区别只在命中后走 upsert(新增设备 + 落库 + 发 alive 事件),
 *  所以点完「扫描」马上能看到刚上电的接收端 —— 语义与 DLNA 的 `POST /v1/dlna/scan` 一致。
 *  discovery 未运行(插件关闭 / mDNS 不可用)时直接 resolve,由调用方回当前列表。 */
export function rescanAirPlayDevices(windowMs = 2500): Promise<void> {
  const bj = bonjour;
  if (!bj) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    let refresh: Browser;
    let refreshAp2: Browser | undefined;
    try {
      refresh = bj.find({ type: "raop" }, (svc: Service) => upsert(svc, true)) as Browser;
      // 手动重扫同样要重查 AP2 能力:设备可能刚升级/刚开启 AirPlay 2。
      refreshAp2 = bj.find({ type: "airplay" }, (svc: Service) => upsertAp2(svc)) as Browser;
    } catch (e: any) {
      log.warn("mDNS 重扫失败", { err: e?.message });
      finish();
      return;
    }
    // 这里刻意**不** unref:调用方就是在等这个窗口把本轮应答收完。
    setTimeout(() => {
      try { refresh.stop(); } catch { /* ignore */ }
      try { refreshAp2?.stop(); } catch { /* ignore */ }
      finish();
    }, windowMs);
  });
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
  // 持久化行不含能力:统一交给 applyAp2 依当前能力表(通常为空)判定,避免两处各写一遍。
  applyAp2(dev);
  devices.set(dev.id, dev);
}

/** Remove a device (permanent user delete). */
export function removeAirPlayDevice(id: string): void {
  devices.delete(id);
}