// ==================== Sendspin 生命周期装配(renderer 插件) ====================
//
// 把 SendspinServer(services/sendspin/*)装配成核心可用的单例:插件启用时
//  1. 加载/创建静态身份(数据目录 0600);
//  2. 实例化 SendspinServer(initiator,主动拨号已配对/登记的 responder);
//  3. 连接就绪后,把每个客户端注册为 QueueController 里的服务器权威播放器,
//     完全对照 DLNA registerDlnaDevice / AirPlay registerAirPlayDevice 的做法,
//     使队列/自动切歌/换源/恢复全部走统一 QueueController。
//
// 关闭时反注册 player(idempotent)、关闭全部连接/组,零常驻资源。
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { SendspinServer, type SendspinConnection, type SendspinCodecPreference, normalizeCodecPreference } from "./server.js";
import { WS_PORT } from "./constants.js";
import { PairingStore } from "./pairingStore.js";
import { PairingCoordinator } from "./pairServer.js";
import { stopGroupPump } from "./streamEngine.js";
import { advertiseSendspinServer, unadvertiseSendspinServer } from "./advertise.js";
import { startPlayerDiscovery, stopPlayerDiscovery } from "./discover.js";
import { esphomeBridge, ESPHOME_API_PORT, type EsphomeDeviceMirror } from "./esphomeBridge.js";
// 类型-only 导入(编译期擦除,零运行时边):缓存单例的类型推导,
// 避开 player/index ↔ sendspin 的模块环(TDZ,见下 ensureControllers 注释)。
import type * as PlayerIndex from "../player/index.js";
import type * as PeerModule from "../peer.js";

type QC = ReturnType<typeof PlayerIndex.getQueueController>;
type PM = ReturnType<typeof PeerModule.getPeerManager>;
let qcSingleton: QC | null = null;
let pmSingleton: PM | null = null;

/** 启动期一次抓取控制器单例并 fail-fast:激活/停止/断开等热路径不再动态
 *  import(关闭期动态 import 在特定求值时序下可挂起,见 reclaim.test.ts 排查)。
 *  此处仍是动态 import(不新增静态边),只是提前到启动时 await。 */
async function ensureControllers(): Promise<void> {
  if (!qcSingleton) {
    const { getQueueController } = await import("../player/index.js");
    qcSingleton = getQueueController();
  }
  if (!pmSingleton) {
    const { getPeerManager } = await import("../peer.js");
    pmSingleton = getPeerManager();
  }
}
import { setServer, getServer } from "./runtime.js";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin");

export interface SendspinRuntime {
  server: SendspinServer;
  identity: Identity;
}

/** 数据目录(可被测试覆盖)。 */
let identityDir = process.env.MUSICFLOW_DATA_DIR || "./data";

export function setSendspinIdentityDir(dir: string): void {
  identityDir = dir;
}

export function getSendspinServer(): SendspinServer | null {
  return getServer();
}

/** 对每个就绪连接的客户端,注册为 QueueController 服务器权威播放器(幂等)。
 *  用启动期缓存的单例,不再动态 import(见 ensureControllers)。 */
async function registerServerPlayer(srv: SendspinServer, conn: SendspinConnection): Promise<void> {
  const qc = qcSingleton;
  const pm = pmSingleton;
  if (!qc || !pm) return; // 服务未走完启动,直接忽略(播放器注册不受影响是旧语义,现启动必备)
  if (!conn.clientId) return; // activate 前不会有 clientId;防御
  // 显示名用客户端上报的 name(如 ESPHome 的 "Speaker Media Player"),无则回退 clientId。
  const displayName = conn.name || conn.clientId;
  // ESPHome 6053 **只读桥接**:设备 IP 从 Sendspin 连接里自动派生(见 server.ts
  // normalizeRemoteHost),用户无需手工填 host。这里只负责登记目标,真正的连接
  // 由 esphomeBridge 按插件配置决定是否建立。
  esphomeBridge.attach(conn.remoteHost);
  // key = 裸 clientId,与 registerDlnaDevice(裸 deviceId)一致。
  qc.registerSendspinDevice(conn.clientId, displayName);
  // 同步到 peer 层(sendspin:<clientId>)—— 前端切换器 / /v1/peers / /v1/play 才能发现并投送。
  try {
    pm.registerSendspin(conn.clientId, displayName, true, conn.legacy);
  } catch { /* peer 层未就绪时忽略(播放器注册不受影响) */ }
}

/** 读 sendspin-renderer 插件配置(plugins 表 config JSON)。缺省全开(MA 对齐)。
 *  导出供单测覆盖默认/非法回退。 */
export function readSendspinPluginConfig(): {
  allowLegacyClients: boolean;
  port: number;
  autoDiscover: boolean;
  preferredCodec: SendspinCodecPreference;
  esphomeMirror: boolean;
  esphomePsk: string;
  esphomePort: number;
} {
  const fallback = {
    allowLegacyClients: true,
    port: WS_PORT,
    autoDiscover: true,
    preferredCodec: "pcm" as SendspinCodecPreference,
    esphomeMirror: false,
    esphomePsk: "",
    esphomePort: ESPHOME_API_PORT,
  };
  try {
    const row = sqlite
      .prepare("SELECT config FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'")
      .get() as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const port = Number(cfg?.port);
    const apiPort = Number(cfg?.esphome_port);
    return {
      allowLegacyClients: cfg?.allow_legacy_clients !== false,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : WS_PORT,
      autoDiscover: cfg?.auto_discover !== false,
      // 只认 pcm / flac 两个值,非法或缺省一律 pcm(2026-09-17 ESP32 真机实测最优)。
      preferredCodec: normalizeCodecPreference(cfg?.preferred_codec),
      // ESPHome 6053 只读桥接:默认关闭(需要设备 api.encryption.key 才能工作)。
      esphomeMirror: cfg?.esphome_mirror === true,
      esphomePsk: typeof cfg?.esphome_psk === "string" ? cfg.esphome_psk.trim() : "",
      esphomePort: Number.isInteger(apiPort) && apiPort >= 1 && apiPort <= 65535 ? apiPort : ESPHOME_API_PORT,
    };
  } catch {
    return fallback;
  }
}

/** 启动 Sendspin server(幂等):身份 → 实例 → 监听 :38927/sendspin。每个客户端
 *  完成 handshake+activate 后经 onActivated 回调注册为 QueueController 播放器。
 *  port 仅测试覆盖(默认读插件配置 port,缺省 WS_PORT=38927,避免多套件并行抢端口)。 */
export async function startSendspinService(port?: number): Promise<SendspinRuntime> {
  const cur = getServer();
  if (cur) {
    return { server: cur, identity: cur.identity };
  }
  const identity = await loadOrCreateIdentity(path.join(identityDir));
  const pluginCfg = readSendspinPluginConfig();
  // 控制器单例启动期一次抓取并 fail-fast:热路径(激活/停止/断开)不再动态 import。
  await ensureControllers();
  const pairingStore = await PairingStore.open(identityDir);
  // ESPHome 6053 只读桥接:按插件配置决定是否常驻 Native API 客户端(保活 + 状态镜像)。
  // 必须在 listen 之前:设备上线时 attach 才能立即建连接。
  esphomeBridge.configure({
    enabled: pluginCfg.esphomeMirror,
    psk: pluginCfg.esphomePsk,
    port: pluginCfg.esphomePort,
  });
  const srv = await SendspinServer.create({
    pairkeys: identity,
    identityDir,
    serverName: "MusicFlow Sendspin",
    allowLegacyClients: pluginCfg.allowLegacyClients,
    preferredCodec: pluginCfg.preferredCodec,
    onActivated: (conn) => void registerServerPlayer(srv, conn),
    onClosed: async (conn) => {
      // 客户端断开:撤下其 sendspin peer(留播放器与队列,便于重连恢复)。
      if (!conn.clientId) return;
      try {
        pmSingleton?.removeSendspinPeer(conn.clientId);
      } catch { /* peer 层未就绪时忽略 */ }
    },
  });
  setServer(srv);
  srv.pairingStore = pairingStore;
  srv.pairing = new PairingCoordinator(srv, pairingStore);
  await srv.listen(port ?? pluginCfg.port); // 监听 ws://0.0.0.0:38927/sendspin(客户端拨入)
  // spec Client Initiated:广播 _sendspin-server._tcp,客户端经 mDNS 发现本服务端。
  // (此前只广播 _musicflow._tcp,ESPHome 真机永远发现不了 server。)
  advertiseSendspinServer(port ?? pluginCfg.port, "MusicFlow Sendspin");
  // 记住的拨号目标:启动即拨 + 每 60s 补拨掉线的。
  if (dialTargetsLoadedFor !== identityDir) await loadDialTargets();
  void dialRemembered(srv);
  if (redialTimer) clearInterval(redialTimer);
  redialTimer = setInterval(() => {
    const s = getServer();
    if (s) void dialRemembered(s);
  }, REDIAL_INTERVAL_MS);
  // 播放器自动发现:浏览 _sendspin._tcp,新设备出现即拨号(只发现不自动播)。
  // 与记忆重拨互补:没拨过的设备靠这个首次出现。
  if (pluginCfg.autoDiscover) startPlayerDiscovery(srv);
  // 空闲回收兜底(进程级去重注册):清无成员组。
  void ensureCleanerRegistered();
  log.info(`sendspin server started: ${srv.serverId}`);
  return { server: srv, identity };
}

/** 停止 Sendspin server(幂等):反注册全部 sendspin 播放器 + 关闭连接/组。 */
export async function stopSendspinService(): Promise<void> {
  if (redialTimer) {
    clearInterval(redialTimer);
    redialTimer = null;
  }
  stopPlayerDiscovery();
  // 插件停用 → 断开全部 6053 只读连接,零常驻资源(与 socket/mDNS 一致)。
  esphomeBridge.stop();
  const srv = getServer();
  if (!srv) return;
  unadvertiseSendspinServer();
  qcSingleton?.unregisterSendspinDevices();
  try {
    pmSingleton?.removeSendspinPeers();
  } catch { /* peer 层未就绪时忽略 */ }
  srv.stop();
  setServer(null);
  log.info("sendspin server stopped");
}

/** 记住的拨号目标: dial route 成功即记入,重启/掉线后自动重拨。
 *  存 MUSICFLOW_DATA_DIR/sendspin/dial_targets.json(设备记录,非插件配置)。 */
export interface DialTarget {
  host: string;
  port: number;
  addedAt: number;
}

let dialTargets: DialTarget[] = [];
let dialTargetsLoadedFor: string | null = null;
let redialTimer: ReturnType<typeof setInterval> | null = null;
const REDIAL_INTERVAL_MS = 60_000;
let cleanerRegistered = false;

function dialTargetsFile(): string {
  return path.join(identityDir, "sendspin", "dial_targets.json");
}

async function loadDialTargets(): Promise<void> {
  dialTargets = [];
  dialTargetsLoadedFor = identityDir;
  try {
    await fs.mkdir(path.join(identityDir, "sendspin"), { recursive: true });
    const raw = JSON.parse(await fs.readFile(dialTargetsFile(), "utf8")) as any;
    const list = Array.isArray(raw) ? raw : raw?.targets;
    if (Array.isArray(list)) {
      for (const t of list) {
        if (t && typeof t.host === "string" && t.host && Number.isInteger(t.port)) {
          dialTargets.push({ host: t.host, port: t.port, addedAt: typeof t.addedAt === "number" ? t.addedAt : Date.now() });
        }
      }
    }
  } catch { /* 缺文件即空 */ }
}

async function saveDialTargets(): Promise<void> {
  try {
    await fs.mkdir(path.join(identityDir, "sendspin"), { recursive: true });
    await fs.writeFile(dialTargetsFile(), JSON.stringify(dialTargets, null, 2), { mode: 0o600 });
  } catch { /* 忽略落盘失败 */ }
}

export function listDialTargets(): DialTarget[] {
  return dialTargets.map((t) => ({ ...t }));
}

/** 记住拨号目标(幂等,host+port 去重)。 */
export async function rememberDialTarget(host: string, port: number): Promise<void> {
  if (!dialTargets.some((t) => t.host === host && t.port === port)) {
    dialTargets.push({ host, port, addedAt: Date.now() });
    await saveDialTargets();
  }
}

/** 忘记拨号目标;若在线(本服务拨出的)则一并断开,不再重拨。 */
export async function forgetDialTarget(host: string, port: number): Promise<boolean> {
  const before = dialTargets.length;
  dialTargets = dialTargets.filter((t) => !(t.host === host && t.port === port));
  if (dialTargets.length === before) return false;
  await saveDialTargets();
  const srv = getServer();
  if (srv) {
    for (const conn of [...srv.clients.values()]) {
      if (conn.dialed && conn.dialHost === host && conn.dialPort === port) {
        try { conn.close(); } catch { /* ignore */ }
      }
    }
  }
  return true;
}

async function dialRemembered(srv: SendspinServer): Promise<void> {
  for (const t of listDialTargets()) {
    const online = [...srv.clients.values()].some(
      (c) => c.dialed && c.dialHost === t.host && c.dialPort === t.port,
    );
    if (online) continue;
    // spec:设备明确拒绝重连的 reason(another_server 等)不再自动骚扰,手动 dial 恢复。
    const suppressed = srv.noAutoRedial.get(`${t.host}:${t.port}`);
    if (suppressed) {
      log.info(`sendspin 跳过重拨(设备已拒绝:${suppressed}): ${t.host}:${t.port}`);
      continue;
    }
    try {
      await srv.dialPlayer(`ws://${t.host}:${t.port}/sendspin`, 10_000);
      log.info(`sendspin 重拨成功: ${t.host}:${t.port}`);
    } catch (e: any) {
      log.info(`sendspin 重拨失败(60s 后重试): ${t.host}:${t.port} ${e?.message || e}`);
    }
  }
}

/** 空闲回收兜底:清掉无成员的组(pump 已停+编码器已关,双重保险)并上报。
 *  日常路径由 onConnectionClosed 即时处理;这里只扫异常残留(如 stop 期间的竞态)。 */
export function reclaimSendspinOrphans(): string {
  const srv = getServer();
  if (!srv) return "sendspin:未运行";
  let groups = 0;
  let encoders = 0;
  for (const g of [...srv.groups.values()]) {
    if (g.members.size > 0) continue;
    stopGroupPump(g);
    encoders += g.close();
    srv.groups.delete(g.name);
    groups++;
  }
  return `sendspin:清${groups}空组/${encoders}编码器`;
}

async function ensureCleanerRegistered(): Promise<void> {
  if (cleanerRegistered) return;
  cleanerRegistered = true;
  // 动态导入:reclaim 侧依赖重,不进 sendspin 的静态图。
  const { registerCacheCleaner } = await import("../memory/reclaim.js");
  registerCacheCleaner(() => {
    try {
      log.info(`[sendspin] idle 回收:${reclaimSendspinOrphans()}`);
    } catch { /* ignore */ }
  });
}
/** 插件是否已启用:读 plugins 表 sendspin-renderer 行(enabled==1)。 */
export function isSendspinEnabled(): boolean {
  try {
    const row = sqlite.prepare("SELECT enabled FROM plugins WHERE name = 'sendspin-renderer'").get() as any;
    return !!row?.enabled;
  } catch {
    return false;
  }
}

/** ESPHome 6053 只读桥接状态快照(供 /v1/sendspin/esphome 与排障日志消费)。 */
export function listEsphomeMirror(): EsphomeDeviceMirror[] {
  return esphomeBridge.snapshot();
}

/** 插件配置保存后的热更新入口:重读配置并重配 6053 桥接。PSK/端口变化会重建连接。 */
export function reconfigureEsphomeMirror(): void {
  const cfg = readSendspinPluginConfig();
  esphomeBridge.configure({
    enabled: cfg.esphomeMirror,
    psk: cfg.esphomePsk,
    port: cfg.esphomePort,
  });
}