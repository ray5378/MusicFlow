// AirPlay device discovery via mDNS — mirrors how Music Assistant finds
// RAOP endpoints (`_raop._tcp.local.`). Zero new dependencies: we browse with
// the same `bonjour-service` package the backend already ships.
//
// Notes:
//   - **设备表主要来源是 `_raop._tcp`**,但 cli 通道(cliairplay)可用后,**只有
//     `_airplay._tcp` 的 AP2-only 设备也会入表**(`ap2Only: true`)。二进制不可用
//     (`MUSICFLOW_AP2_CLI=0` 或未安装)时这条路径关闭,行为与改造前逐字一致。
//   - AP2 判定不靠记忆里的某一个 features 位:以「同时广播 `_airplay._tcp` 且
//     `protovers ≥ 1.1`」为准,并把 `features/srcvers/protovers/gid/flags/pi` 与
//     **完整 TXT** 原样留存给 cli 的路由自动选择使用。位定义由 230 接收器实测反证。
//   - 唯一键:`pi`(HomeKit pairing identifier)优先于 `deviceid`。同网卡多实例
//     (测试床)的 `deviceid` 完全相同,只有 `pi` 不同 —— 用 deviceid 会合并成一台。
//   - TXT fields we care about: `et` (encryption types, `1` = RSA supported),
//     `pk` (device RSA public key, base64), `am` (model name), `flags`, `vv`;
//     AP2 侧:`deviceid`(对齐键)/ `pi`(唯一键)/ `features` / `srcvers` /
//     `protovers` / `gid`。
import { Bonjour, Service, Browser } from "bonjour-service";
import { createLogger } from "../../utils/logger.js";
import { isAp2StreamingAvailable } from "./ap2/binary.js";

const log = createLogger("AIRPLAY");

/** AP2 侧 TXT 能力快照(仅在设备同时广播 `_airplay._tcp` 时存在)。 */
export interface AirPlayAp2Info {
  features?: string;   // TXT features — 64 位能力位图(「0x低,0x高」)
  srcvers?: string;    // TXT srcvers — 设备固件版本
  protovers?: string;  // TXT protovers — 协议版本(≥ 1.1 才按 AP2 处理)
  flags?: string;
  gid?: string;        // TXT gid — 分组 id(AirPlay 2 多房间用,本课题不用)
  model?: string;
  /** TXT pi — HomeKit pairing identifier。**同网卡多实例测试床靠它区分**
   *  (那些实例的 `deviceid` 完全相同,只有 `pi` 不同);真实设备上它也是唯一稳定键。 */
  pi?: string;
  /** 完整 TXT 快照:原样透传给 `cliairplay --txt`,驱动它的路由自动选择
   *  (RAOP / AP2 native / AP2 compat、PTP vs NTP)。缺了它二进制只能按缺省猜。 */
  raw?: Record<string, string>;
  /** **AP2 服务的 SRV 端口**(通常 7000)。必须单独记:同一台设备同时广播
   *  `_raop`(5000)与 `_airplay`(7000)时,`AirPlayDevice.port` 存的是 **raop 端口**,
   *  而 cli 走 AP2 native 必须拨 7000 —— 拿错端口会连不上(握手超时)。 */
  port?: number;
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
  /** TXT cn — codec types(`0,1` 常见,`1` = ALAC)。AP1 的 cli 参数要原样透传:
   *  缺了它二进制按"只发 ALAC 压缩"握手,部分接收端会拒流或静音。 */
  cn?: string;
  /** TXT md — metadata types(`0,1,2` 常见)。 */
  md?: string;
  flags?: string;
  supportsRsa: boolean;// et contains "1"
  /** 该设备是否具备 AirPlay 2 能力(= 同时广播 `_airplay._tcp` 且 protovers ≥ 1.1)。 */
  supportsAp2: boolean;
  /** 该设备是否**只有** `_airplay._tcp`、没有 `_raop._tcp`(HomePod / AP2-only 接收端)。
   *  这类设备以前进不了设备表(表只由 _raop 产生);cli 通道可用后放开。 */
  ap2Only?: boolean;
  /** AP2 能力表的键(`pi` 优先,否则归一化 deviceid)。同一台设备的能力据此对齐。 */
  ap2Key?: string;
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
/** AP2 能力表。键 = `pi`(优先)或归一化 deviceid。
 *
 *  ⚠️ 为什么不能只用 deviceid:同网卡跑多个接收端实例时(测试床)它们的 `deviceid`
 *  **完全相同**(都取自网卡),只有 `pi`(HomeKit pairing identifier)不同 —— 用
 *  deviceid 做键会把三台合并成一台。
 *  与 devices 分表的原因不变:能力可以**先于** `_raop` 记录到达。 */
const ap2Caps = new Map<string, AirPlayAp2Info>();
/** 归一化 deviceid(MAC)→ 能力表键(pi)。`_raop` 记录只带 MAC,靠它换算出能力。 */
const macToAp2Key = new Map<string, string>();

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

/** 取某设备当前生效的 AP2 能力:先按 `ap2Key`(pi)直查,再用 MAC→pi 映射回查,
 *  最后按 MAC 本身兜底(只有 `_airplay` 没带 pi 的设备)。 */
function ap2InfoOf(dev: AirPlayDevice): AirPlayAp2Info | undefined {
  if (dev.ap2Key) {
    const v = ap2Caps.get(dev.ap2Key);
    if (v) return v;
  }
  const mac = normalizeAp2DeviceId(dev.id);
  const mapped = macToAp2Key.get(mac);
  if (mapped) {
    const v = ap2Caps.get(mapped);
    if (v) return v;
  }
  return ap2Caps.get(mac);
}

/** 把 AP2 能力挂到设备上(唯一写 `supportsAp2` 的地方)。 */
function applyAp2(dev: AirPlayDevice): void {
  const info = ap2InfoOf(dev);
  dev.ap2 = info;
  if (info?.pi) dev.ap2Key = info.pi;
  dev.supportsAp2 = !!info && protoversAtLeast(info.protovers, AP2_MIN_PROTOVERS);
}

function findDeviceByNormalizedId(id: string): AirPlayDevice | undefined {
  const target = normalizeAp2DeviceId(id);
  for (const d of devices.values()) if (normalizeAp2DeviceId(d.id) === target) return d;
  return undefined;
}

/** 解析 `_airplay._tcp` 的唯一键。
 *
 *  `pi`(HomeKit pairing identifier)优先于 `deviceid`,因为**同网卡多实例**的
 *  deviceid 完全一样(取自网卡),只有 pi 不同。同时把 MAC→pi 记进旁路表,
 *  供只有 MAC 的 `_raop` 记录换算能力。 */
function ap2KeyOf(txt: Record<string, string>): { key: string; mac: string; pi: string } | null {
  const pi = (txt.pi || "").trim();
  const mac = normalizeAp2DeviceId(txt.deviceid || txt.deviceId || "");
  if (!pi && !mac) return null;
  if (pi && mac) macToAp2Key.set(mac, pi);
  return { key: pi || mac, mac, pi };
}

/** AP2-only 设备入表(HomePod / 只广播 `_airplay._tcp` 的接收端)。
 *
 *  gating:`cliairplay` 不可用(**或** `MUSICFLOW_AP2_CLI=0`)时**不入表** ——
 *  进来了也投不了,只会变成 UI 里"点了就报错"的死设备。这条 gating 是「删掉二进制
 *  后行为与改造前逐字一致」的保证。 */
function upsertAp2Only(svc: Service, txt: Record<string, string>, key: string): void {
  if (!isAp2StreamingAvailable()) return;
  if (!protoversAtLeast(txt.protovers, AP2_MIN_PROTOVERS)) return;
  const ip = ipv4Of(svc);
  const hostKey = String(svc.host || "").toLowerCase().replace(/\.$/, "");
  if (ip && hostKey) hostIps.set(hostKey, ip);
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(String(svc.host || ""));
  const addr = ip || hostIps.get(hostKey) || (isIp ? String(svc.host) : "");
  // 与 `upsert` 同一条铁律:没有可路由地址就不登记(否则投播必 ENOTFOUND)。
  if (!addr || !svc.port) return;

  // id 一律用 `pi`(绝对唯一)。**不用 MAC**:同模板克隆出来的虚拟机会拿到同一张
  // 网卡 MAC(230/231 实测都是 86:bc:3f:fb:a3:08),用 MAC 会把两台机器的实例合并。
  // 真实设备在这条记录之后还会来一条 `_raop`(同 MAC),由 `upsert` 把它并成 mac id。
  const id = key;
  const existing = devices.get(id);
  const dev: AirPlayDevice = {
    id,
    name: friendlyNameOf(svc),
    host: addr,
    port: svc.port,
    supportsRsa: false,
    supportsAp2: true,
    ap2Only: true,
    ap2Key: key,
    flags: txt.flags !== undefined ? txt.flags : undefined,
    lastSeen: Date.now(),
    available: true,
  };
  applyAp2(dev);
  // ⚠️ AP2-only 条目**不持久化**:它的 id(pi)会在 `_raop` 记录到达时被换成 MAC,
  // 落库就会留下一条永远离线的僵尸行。别名/禁用对 AP2-only 设备暂不保留(留 TODO)。
  devices.set(id, dev);
  if (!existing || !existing.available) emit({ type: "alive", device: dev });
}

/** 处理一条 `_airplay._tcp` 记录:更新能力表;已有对应设备就刷能力,
 *  没有对应设备且 `_raop` 也不存在时按 AP2-only 入表(见上面 gating)。 */
function upsertAp2(svc: Service): void {
  const txt = txtOf(svc);
  const id = ap2KeyOf(txt);
  if (!id) return; // 没有 deviceid 也没有 pi:无法唯一识别,忽略(不猜)
  ap2Caps.set(id.key, {
    features: txt.features,
    srcvers: txt.srcvers,
    protovers: txt.protovers,
    flags: txt.flags,
    gid: txt.gid,
    model: txt.model,
    pi: id.pi || undefined,
    raw: txt,
    port: svc.port || undefined,
    lastSeen: Date.now(),
  });
  // 找"同一设备":先按键(pi),再按 MAC —— 但 MAC 命中时还要求能力键一致,
  // 否则那是同网卡的另一个实例(它必须自成一台北设备)。
  let dev = devices.get(id.key);
  if (!dev && id.mac) {
    const byMac = devices.get(id.mac) ?? findDeviceByNormalizedId(id.mac);
    if (byMac && (!byMac.ap2Key || byMac.ap2Key === id.key)) dev = byMac;
  }
  if (!dev) {
    upsertAp2Only(svc, txt, id.key);
    return;
  }
  const before = dev.supportsAp2;
  applyAp2(dev);
  dev.lastSeen = Date.now();
  dev.available = true;
  if (before !== dev.supportsAp2) emit({ type: "alive", device: dev });
}

/** `_airplay._tcp` 记录下线:清掉能力并让已存在设备翻回 supportsAp2=false。
 *  AP2-only 设备没有 `_raop` 记录来标记 available=false,只能整台摘掉。 */
function dropAp2(svc: Service): void {
  const txt = txtOf(svc);
  const pi = (txt.pi || "").trim();
  const mac = normalizeAp2DeviceId(txt.deviceid || txt.deviceId || "");
  const key = pi || mac;
  if (!key) return;
  ap2Caps.delete(key);
  if (pi && mac && macToAp2Key.get(mac) === pi) macToAp2Key.delete(mac);
  const dev = devices.get(key) ?? (mac ? (devices.get(mac) ?? findDeviceByNormalizedId(mac)) : undefined);
  if (!dev) return;
  if (dev.ap2Only) {
    devices.delete(dev.id);
    emit({ type: "byebye", id: dev.id });
    return;
  }
  const before = dev.supportsAp2;
  applyAp2(dev);
  if (before !== dev.supportsAp2) emit({ type: "alive", device: dev });
}

/**
 * mDNS 主机名 → IPv4 的旁路表。
 *
 * 为什么需要:bonjour 偶尔只给出 SRV 的 `host`(形如 `xxx.local`)而 **A 记录为空**
 * (230 实测:同一台主机上两台 shairport,AP1 的记录带 IP、AP2 只带主机名)。
 * 直接把 hostname 当 `host` 存下去 → 投播时 `getaddrinfo` 在容器里解析不了 `.local`
 * (musl/Node 不查 mDNS)→ `cast FAILED: getaddrinfo ENOTFOUND`。
 * 这里用「同主机任一记录给出的 IPv4」回填,既拿到可路由地址,也不必在容器里装 nss-mdns。
 */
const hostIps = new Map<string, string>();

function ipv4Of(svc: Service): string {
  return svc.addresses?.find((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || "";
}

function upsert(svc: Service, available = true): void {
  const txt: Record<string, string> = {};
  for (const k of Object.keys(svc.txt || {})) txt[k] = String(svc.txt[k]);
  const ip = ipv4Of(svc);
  const hostKey = String(svc.host || "").toLowerCase().replace(/\.$/, "");
  if (ip && hostKey) hostIps.set(hostKey, ip);
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(String(svc.host || ""));
  const addr = ip || hostIps.get(hostKey) || (isIp ? String(svc.host) : "");
  // 没有可路由地址(只有解不了的 `.local`)→ 不登记:宁可等 A 记录,
  // 也不要让一台「看起来在线、投播必 ENOTFOUND」的设备进列表。
  if (!addr || !svc.port) return;
  // id 统一走归一化(大写 12 位 hex):`_raop` 的服务名前缀与 `_airplay` 的 TXT
  // `deviceid` 是同一个 MAC,只差大小写/冒号。不归一 → 两条记录各建一条设备,
  // 同名同 IP 的两台"设备"在 UI 里并存,AP2 能力也永远标不到 raop 那条上。
  const id = normalizeAp2DeviceId(deviceIdOf(svc)) || deviceIdOf(svc);
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
    cn: txt.cn || undefined,
    md: txt.md || undefined,
    flags: txt.flags !== undefined ? txt.flags : undefined,
    supportsRsa: et.includes("1"),
    supportsAp2: false, // 由 applyAp2 填(取决于是否有 `_airplay._tcp` 能力)
    // 这条 `_raop` 记录说明它不是 AP2-only:清掉标记,否则 `_airplay` 下线时会被
    // 当成"整台设备消失"摘掉(它其实还活着,只是丢了 AP2 能力)。
    ap2Only: false,
    ap2Key: existing?.ap2Key,
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
  // 合并幽灵条目:`_airplay` 先到时我们建过一条 id=pi 的 AP2-only 设备,现在同 MAC
  // 的 `_raop` 记录到了 —— 摘掉它,别让 UI 里出现"同一台设备两条"。
  const ghostKey = macToAp2Key.get(normalizeAp2DeviceId(id));
  if (ghostKey && ghostKey !== id) {
    const ghost = devices.get(ghostKey);
    if (ghost?.ap2Only) {
      devices.delete(ghostKey);
      if (ghost.alias) dev.alias = dev.alias || ghost.alias;
      if (ghost.disabled != null) dev.disabled = dev.disabled ?? ghost.disabled;
      log.info(`AP2-only 条目 ${ghostKey} 已并入 raop 设备 ${id}`);
      emit({ type: "byebye", id: ghostKey });
    }
  }
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