// ==================== Sendspin 生命周期装配(renderer 插件) ====================
//
// 双运行模式(2026-09-18 起):
//  - **fork 模式(生产默认)**:整个 sendspin 运行时(WS 38927 + 解码/编码/推流 +
//    mDNS + 拨号 + 6053 桥)跑在**专属常驻子进程**,与主进程(前端 API/后台任务/批量)
//    的事件循环彻底隔离 —— 推流 25ms 节奏不再被任何主进程阻塞干扰。主进程通过
//    supervisor(IPC 桥)+ proxy(状态镜像)访问;播放器注册/注销经事件回调在主进程完成。
//  - **in-proc 模式(单测/MUSICFLOW_SENDSPIN_INPROC=1)**:现状装配,QC/PM 直接注册,
//    测试无需 fork。子进程自身(MUSICFLOW_SENDSPIN_CHILD=1)也走本模式 —— 它就是
//    "运行时本体",只是 QC/PM 状态改由 IPC 事件回传主进程。
//
// 插件启用时:
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
import { getSendspinFront as getSendspinFrontImpl } from "./proxy.js";
import { sendspinSupervisor } from "./supervisor.js";
import { isForkMode } from "./mode.js";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin");

// ==================== 运行模式判定(实现在 leaf mode.ts,re-export 保持旧路径) ====================
export { isForkMode };

export interface SendspinRuntime {
  server: SendspinServer;
  identity: Identity;
}

/** 生命周期钩子:child 模式用它把激活/断开事件回传主进程(替代 QC/PM 直注册)。 */
export interface SendspinBootHooks {
  onActivated?: (conn: SendspinConnection) => void;
  onClosed?: (conn: SendspinConnection) => void;
}

/** 数据目录(可被测试覆盖)。 */
let identityDir = process.env.MUSICFLOW_DATA_DIR || "./data";

export function setSendspinIdentityDir(dir: string): void {
  identityDir = dir;
}

/** 真实 server 引用(仅 in-proc/child 模式非空;fork 模式下主进程没有 server 实例)。 */
export function getSendspinServer(): SendspinServer | null {
  return getServer();
}

/** 对每个就绪连接的客户端,注册为 QueueController 服务器权威播放器(幂等)。
 *  用启动期缓存的单例,不再动态 import(见 ensureControllers)。
 *  fork 模式下主进程侧的等价逻辑在 startSendspinService 的 supervisor hooks 里。 */
async function registerServerPlayer(srv: SendspinServer, conn: SendspinConnection): Promise<void> {
  const qc = qcSingleton;
  const pm = pmSingleton;
  if (!qc || !pm) return; // 服务未走完启动,直接忽略(播放器注册不受影响是旧语义,现启动必备)
  if (!conn.clientId) return; // activate 前不会有 clientId;防御
  // 显示名用客户端上报的 name(如 ESPHome 的 "Speaker Media Player"),无则回退 clientId。
  const displayName = conn.name || conn.clientId;
  // ESPHome 6053 **只读桥接**:设备 IP 从 Sendspin 连接里自动派生(见 server.ts
  // normalizeRemoteHost),用户无需手工填 host。这里只负责登记目标,真正的连接
  // 由 esphomeBridge 按插件配置决定是否建立。(child 模式由 child hooks 自行 attach。)
  esphomeBridge.attach(conn.remoteHost);
  // key = 裸 clientId,与 registerDlnaDevice(裸 deviceId)一致。
  qc.registerSendspinDevice(conn.clientId, displayName);
  // 同步到 peer 层(sendspin:<clientId>)—— 前端切换器 / /v1/peers / /v1/play 才能发现并投送。
  // 被用户禁用的设备**不注册为 peer**(与 DLNA reconcileDlnaPeers 同语义):
  // 禁用设备不出现在任何流转播放入口;解除禁用后重连即自动回来。
  let disabled = false;
  try {
    const { getDeviceDisabled } = await import("./deviceState.js");
    disabled = getDeviceDisabled(conn.clientId);
  } catch { /* 读禁用态失败按启用处理,不阻断设备上线 */ }
  if (disabled) {
    try { pm.removeSendspinPeer(conn.clientId); } catch { /* ignore */ }
  } else {
    try {
      pm.registerSendspin(conn.clientId, displayName, true, conn.legacy);
    } catch { /* peer 层未就绪时忽略(播放器注册不受影响) */ }
  }
  // 恢复持久音量(无行则沿用缺省,不发声不断流,见 applyPersistedDeviceVolume)。
  await applyPersistedDeviceVolume(conn.clientId);
}

/** 应用某设备持久音量/静音(重连/重启后无感恢复)。
 *  in-proc 直写内存组;fork 经既有 transport/setMuted RPC 下发子进程。
 *  全程 best-effort:恢复失败不影响设备上线。 */
export async function applyPersistedDeviceVolume(clientId: string): Promise<void> {
  try {
    if (!clientId || clientId.startsWith("ug:")) return;
    const { getDeviceVolumeState } = await import("./deviceState.js");
    const st = getDeviceVolumeState(clientId);
    if (!st) return;
    if (isForkMode()) {
      if (!sendspinSupervisor.isRunning()) return;
      await sendspinSupervisor.rpc("transport", { clientId, op: "volume", arg: st.volume });
      await sendspinSupervisor.rpc("setMuted", { clientId, muted: st.muted });
    } else {
      const { setVolumeCore, setMutedCore } = await import("./playerCore.js");
      const srv = getServer();
      setVolumeCore(srv, clientId, st.volume, false);
      setMutedCore(srv, clientId, st.muted, false);
    }
  } catch { /* 恢复失败不影响上线 */ }
}

/** 读 sendspin-renderer 插件配置(plugins 表 config JSON)。缺省全开(MA 对齐)。
 *  导出供单测覆盖默认/非法回退。主进程与子进程各读各的连接(WAL 多进程安全)。 */
export function readSendspinPluginConfig(): {
  allowLegacyClients: boolean;
  port: number;
  autoDiscover: boolean;
  preferredCodec: SendspinCodecPreference;
  esphomeMirror: boolean;
  esphomePsk: string;
  esphomePort: number;
  streamSource: boolean;
} {
  const fallback = {
    allowLegacyClients: true,
    port: WS_PORT,
    autoDiscover: true,
    preferredCodec: "pcm" as SendspinCodecPreference,
    esphomeMirror: false,
    esphomePsk: "",
    esphomePort: ESPHOME_API_PORT,
    streamSource: true,
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
      // 流式解码:默认开(3.0.36 灰度验证稳定后转正);只有**显式 false** 才关
      // (老用户此前手关闭仍保持关)。缺省/非布尔一律按默认开。
      streamSource: cfg?.stream_source !== false,
    };
  } catch {
    return fallback;
  }
}

/** in-proc 装配(当前实现原样;child 子进程与单测共用这条路径)。
 *  hooks:child 模式传入(激活/断开事件走 IPC);缺省 = 主进程直注册 QC/PM。 */
export async function startSendspinInProcess(port?: number, hooks?: SendspinBootHooks): Promise<SendspinRuntime> {
  const cur = getServer();
  if (cur) {
    return { server: cur, identity: cur.identity };
  }
  const identity = await loadOrCreateIdentity(path.join(identityDir));
  const pluginCfg = readSendspinPluginConfig();
  // 控制器单例启动期一次抓取并 fail-fast:热路径(激活/停止/断开)不再动态 import。
  // child 模式不抓(QC/PM 属主进程,子进程拿了也没用,还引入重依赖图)。
  if (!hooks) await ensureControllers();
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
    onActivated: (conn) => {
      if (hooks?.onActivated) {
        hooks.onActivated(conn);
        return;
      }
      void registerServerPlayer(srv, conn);
    },
    onClosed: async (conn) => {
      if (hooks?.onClosed) {
        hooks.onClosed(conn);
        return;
      }
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
  // 空闲回收兜底:主进程挂到内存回收总线;child 进程自挂周期清扫(无人驱动 reclaim)。
  if (hooks) {
    const t = setInterval(() => {
      try { reclaimSendspinOrphans(); } catch { /* ignore */ }
    }, 600_000);
    t.unref?.();
  } else {
    void ensureCleanerRegistered();
  }
  log.info(`sendspin server started: ${srv.serverId}`);
  return { server: srv, identity };
}

/** in-proc 卸载(关服务/停 mDNS/停桥接/停定时器;QC/PM 反注册仅主进程默认路径)。 */
export async function stopSendspinInProcess(hooks?: SendspinBootHooks): Promise<void> {
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
  if (!hooks) {
    qcSingleton?.unregisterSendspinDevices();
    try {
      pmSingleton?.removeSendspinPeers();
    } catch { /* peer 层未就绪时忽略 */ }
  }
  srv.stop();
  setServer(null);
  log.info("sendspin server stopped");
}

/** 启动 Sendspin 服务(幂等,模式自适应):
 *  fork 模式 = 拉起/复用专属子进程(播放器注册经事件回主进程);
 *  in-proc 模式 = 直装配(单测/子进程自身)。 */
export async function startSendspinService(port?: number): Promise<SendspinRuntime | null> {
  if (!isForkMode()) {
    return startSendspinInProcess(port);
  }
  // ---- fork 模式:主进程侧只管 IPC 桥 ----
  if (sendspinSupervisor.isRunning()) return null;
  const pluginCfg = readSendspinPluginConfig();
  // QC/PM 注册发生在 supervisor 事件回调里,单例必须先就绪。
  await ensureControllers();
  sendspinSupervisor.setHooks({
    onActivated: (clientId, name, legacy) => {
      try { qcSingleton?.registerSendspinDevice(clientId, name); } catch { /* ignore */ }
      try { pmSingleton?.registerSendspin(clientId, name, true, legacy); } catch { /* peer 未就绪忽略 */ }
      // 恢复持久音量(与 in-proc registerServerPlayer 尾部同构,见上)。
      void applyPersistedDeviceVolume(clientId);
    },
    onClosed: (clientId) => {
      try { pmSingleton?.removeSendspinPeer(clientId); } catch { /* ignore */ }
    },
    onPlayFailed: (clientId, songId, message) => {
      log.warn(`sendspin play ${songId} failed(client=${clientId}): ${message}`);
    },
  });
  await sendspinSupervisor.start(port ?? pluginCfg.port);
  return null;
}

/** 停止 Sendspin 服务(幂等):反注册全部 sendspin 播放器 + 关连接/组 + 杀子进程。 */
export async function stopSendspinService(): Promise<void> {
  if (isForkMode()) {
    await sendspinSupervisor.stop();
    qcSingleton?.unregisterSendspinDevices();
    try {
      pmSingleton?.removeSendspinPeers();
    } catch { /* peer 层未就绪时忽略 */ }
    log.info("sendspin 服务已停止(子进程已退出)");
    return;
  }
  await stopSendspinInProcess();
}

/** 主进程侧 sendspin 外观:fork=镜像代理;in-proc=真实 server。未运行返回 null。
 *  ⚠️ 路由/外围代码一律用它,不要用 getSendspinServer()(后者 fork 模式恒 null)。
 *  proxy.ts 静态导入(index → proxy → supervisor → ipcProtocol,无环):模式内部判定,
 *  调用方零分叉,不存在"注册完成前返回 null"的装配竞态。 */
export function getSendspinFront(): import("./proxy.js").SendspinServerLike | null {
  return getSendspinFrontImpl(!isForkMode());
}

/** ESPHome 6053 只读桥接状态(fork 走 RPC,in-proc 直读桥接单例)。 */
export async function sendspinEsphomeStatus(): Promise<{
  enabled: boolean;
  pskConfigured: boolean;
  port: number;
  devices: unknown[];
}> {
  if (isForkMode()) {
    const { proxyEsphomeStatus } = await import("./proxy.js");
    return proxyEsphomeStatus();
  }
  const srv = getServer();
  const cfg = esphomeBridge.currentConfig();
  return {
    enabled: srv ? cfg.enabled : false,
    // ⚠️ 永远不要把 PSK 回显给前端,只回报是否配置。
    pskConfigured: !!cfg.psk,
    port: cfg.port,
    devices: srv ? esphomeBridge.snapshot() : [],
  };
}

/** 插件配置热更新:preferredCodec / allowLegacyClients / 6053 桥接,一条路径覆盖
 *  in-proc 与 fork(fork 经 RPC 让子进程自应用)。端口变更不在此 —— 需重启监听,
 *  由路由层走 stop/start(杀子进程重建)。 */
export async function applySendspinConfigHotUpdate(): Promise<void> {
  const cfg = readSendspinPluginConfig();
  if (isForkMode()) {
    try {
      await sendspinSupervisor.rpc("applyCfg", cfg);
    } catch (e: any) {
      log.warn(`sendspin 配置热更新下发失败(子进程未运行?下次启动读配置): ${e?.message || e}`);
    }
    return;
  }
  const srv = getServer();
  if (srv) {
    srv.allowLegacyClients = cfg.allowLegacyClients;
    srv.preferredCodec = cfg.preferredCodec;
  }
  esphomeBridge.configure({
    enabled: cfg.esphomeMirror,
    psk: cfg.esphomePsk,
    port: cfg.esphomePort,
  });
}

/** 设置某 Sendspin 设备禁用态(对齐 DLNA `setDeviceDisabled` 语义)。
 *
 *  禁用 = 设备级持久偏好:落 sendspin_device_state.disabled,并从 peer 层移除
 *  (不出现在切换器 / Flows / HA 卡片等任何流转播放入口);同时停播 + 清队列 +
 *  断开现有连接 + 移出所有群组。启用只写状态 —— Sendspin 是设备主动拨入,
 *  服务端无法反向叫醒,设备重连时 registerServerPlayer 会按新状态重新注册 peer。
 *
 *  fork 模式下 peer/队列/群组都属主进程,sendspin 子进程只负责连接与播控:
 *  - 状态落库在主进程直写(WAL 多进程安全);
 *  - 断连接经 RPC 下发子进程;
 *  - 返回是否找到该设备(路由层据此判 404)。 */
export async function sendspinSetDisabled(clientId: string, disabled: boolean): Promise<boolean> {
  if (!clientId) return false;
  const { saveDeviceDisabled } = await import("./deviceState.js");
  saveDeviceDisabled(clientId, disabled);

  const pm = pmSingleton;
  const qc = qcSingleton;

  if (disabled) {
    // 1. 立即断开该客户端现存连接(子进程持有连接)。
    try {
      if (isForkMode()) {
        if (sendspinSupervisor.isRunning()) await sendspinSupervisor.rpc("disconnect", { clientId });
      } else {
        const srv = getServer();
        for (const conn of [...(srv?.clients.values() ?? [])]) {
          if (conn.clientId === clientId) { try { conn.close(); } catch { /* ignore */ } }
        }
      }
    } catch { /* 断连失败不影响禁用状态 */ }
    // 2. 移出所有用户组 + 停播清队列(与 DLNA 端点同款)。
    try {
      const { getGroupManager } = await import("../group/index.js");
      getGroupManager().removeDeviceFromAllGroups(clientId);
    } catch { /* 组管理器未就绪时忽略 */ }
    try { qc?.clear(clientId); } catch { /* ignore */ }
  }

  // 3. peer 层同步:禁用 → 移除 peer(推 peer_unavailable,卡片实时消失);
  //    启用 → 等设备重连时 registerServerPlayer 自动注册(此处不凭空造 peer)。
  if (disabled) {
    try { pm?.removeSendspinPeer(clientId); } catch { /* ignore */ }
  }
  return true;
}

/** 解除配对(fork 经 RPC 在子进程执行):删配对记录 + 断开该客户端现存连接
 *  (下次连回落 sentinel,走重新配对/批准 —— 与子进程内 unpair op 同语义)。 */
export async function sendspinUnpair(clientId: string): Promise<boolean> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return false;
    return sendspinSupervisor.rpc<boolean>("unpair", { clientId });
  }
  const srv = getServer();
  if (!srv?.pairingStore) return false;
  const ok = await srv.pairingStore.removeRecord(clientId);
  for (const conn of [...srv.clients.values()]) {
    if (conn.clientId === clientId) {
      try { conn.close(); } catch { /* ignore */ }
    }
  }
  // 解绑即"删除播放器":配对行已删,持久音量行一并清(重连按缺省来)。
  try {
    const { deleteDeviceVolumeState } = await import("./deviceState.js");
    deleteDeviceVolumeState(clientId);
  } catch { /* ignore */ }
  return ok;
}

/** 用户组播放入口(多房间同步):fork 经 RPC 在子进程执行, in-proc 直调 core。
 *  供路由层(成员变更)/组 player(起播)调用;调用方零分叉。
 *  groupName 统一用 playerCore.sendspinGroupName(userGroupId) 映射。 */
export async function sendspinGroupPlay(
  groupName: string,
  memberIds: string[],
  item: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string; duration?: number },
): Promise<void> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) throw new Error("sendspin 服务未运行");
    await sendspinSupervisor.rpc("groupPlay", { group: groupName, members: memberIds, item });
    return;
  }
  const { playGroupCore } = await import("./playerCore.js");
  const srv = getServer();
  if (!srv) throw new Error("sendspin 服务未运行");
  playGroupCore(srv, groupName, memberIds, item as any, (cid, songId, message) => {
    log.warn(`sendspin group play ${songId} failed(group=${cid}): ${message}`);
  });
}

/** 用户组停止(成员保留,下次起播复用)。 */
export async function sendspinGroupStop(groupName: string): Promise<void> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return;
    await sendspinSupervisor.rpc("groupStop", { group: groupName });
    return;
  }
  const { stopGroupCore } = await import("./playerCore.js");
  stopGroupCore(getServer(), groupName);
}

/** 用户组成员加入(播中走直播沿,空闲仅登记)。 */
export async function sendspinGroupJoin(
  groupName: string,
  clientId: string,
): Promise<{ joined: boolean; live: boolean }> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return { joined: false, live: false };
    return sendspinSupervisor.rpc("groupJoin", { group: groupName, clientId });
  }
  const { joinGroupCore } = await import("./playerCore.js");
  return joinGroupCore(getServer(), groupName, clientId);
}

/** 用户组成员摘除(给该成员 stream/end 后移出,不影响其余成员)。 */
export async function sendspinGroupLeave(groupName: string, clientId: string): Promise<boolean> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return false;
    return sendspinSupervisor.rpc<boolean>("groupLeave", { group: groupName, clientId });
  }
  const { leaveGroupCore } = await import("./playerCore.js");
  return leaveGroupCore(getServer(), groupName, clientId);
}

/** 用户组传输指令(stop/pause/resume/seek/volume):core 函数本就 group-name 无关
 *  (经 srv.group(name)),fork 经既有 transport op 下发,子进程零改动。 */
export async function sendspinGroupTransport(
  groupName: string,
  op: "stop" | "pause" | "resume" | "seek" | "volume",
  arg?: number,
): Promise<void> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) throw new Error("sendspin 服务未运行");
    await sendspinSupervisor.rpc("transport", { clientId: groupName, op, arg });
    return;
  }
  const { stopGroupCore, pauseCore, resumePumpCore, seekCore, setVolumeCore } = await import("./playerCore.js");
  const srv = getServer();
  switch (op) {
    case "stop": stopGroupCore(srv, groupName); break;
    case "pause": if (srv) pauseCore(srv, groupName); break;
    case "resume": if (srv) resumePumpCore(srv, groupName); break;
    case "seek": if (srv) seekCore(srv, groupName, Number(arg) || 0); break;
    case "volume": if (srv) setVolumeCore(srv, groupName, Number(arg) || 0); break;
  }
}

/** 用户组轮询(播放在播/位置/时长):供组 player pollState 与组状态派生。 */
export async function sendspinGroupPoll(
  groupName: string,
): Promise<{ playing: boolean; positionMs: number; durationMs: number }> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return { playing: false, positionMs: 0, durationMs: 0 };
    return sendspinSupervisor.rpc("poll", { clientId: groupName });
  }
  const { pollCore } = await import("./playerCore.js");
  return pollCore(getServer(), groupName);
}

/** 用户组静音(组＋成员连接同置,取消恢复原音量;离线重连后组标记仍有效)。 */
export async function sendspinGroupMuted(groupName: string, muted: boolean): Promise<void> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) throw new Error("sendspin 服务未运行");
    await sendspinSupervisor.rpc("setMuted", { clientId: groupName, muted });
    return;
  }
  const { setMutedCore } = await import("./playerCore.js");
  setMutedCore(getServer(), groupName, muted);
}

/** 用户组 pump 是否在推流(供 resume 冷起播/原地恢复判定)。 */
export async function sendspinGroupPumpActive(groupName: string): Promise<boolean> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return false;
    return sendspinSupervisor.rpc<boolean>("pumpActive", { clientId: groupName }).catch(() => false);
  }
  const { pumpActiveCore } = await import("./playerCore.js");
  const srv = getServer();
  return srv ? pumpActiveCore(srv, groupName) : false;
}

/** 记住的拨号目标: dial route 成功即记入,重启/掉线后自动重拨。
 *  存 MUSICFLOW_DATA_DIR/sendspin/dial_targets.json(设备记录,非插件配置)。
 *  fork 模式下文件归子进程所有(重拨循环在子进程),主进程经 RPC 读写。 */
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

/** 列出拨号目标(fork 经 RPC 问子进程 —— 文件所有权在子进程)。 */
export async function listDialTargets(): Promise<DialTarget[]> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return [];
    return sendspinSupervisor.rpc<DialTarget[]>("dialList");
  }
  return dialTargets.map((t) => ({ ...t }));
}

/** 记住拨号目标(幂等,host+port 去重)。 */
export async function rememberDialTarget(host: string, port: number): Promise<void> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return;
    await sendspinSupervisor.rpc("dialRemember", { host, port });
    return;
  }
  if (!dialTargets.some((t) => t.host === host && t.port === port)) {
    dialTargets.push({ host, port, addedAt: Date.now() });
    await saveDialTargets();
  }
}

/**
 * 撤销「添加播放器」(= 前端统一的「解绑」):只撤回服务端对这台设备的**记住**,
 * **不删设备本身** —— 设备仍在线、行仍留在列表里。
 *
 * 具体做三件事:
 *   1. 从 dial_targets 移除 → 重启/掉线后不再自动重拨;
 *   2. 清掉该设备的持久音量/静音 —— 撤销添加即不留档案,重连按缺省来;
 *   3. 抹掉这条连接上的 dialed 标记(前端据此回落「解绑」按钮)。
 *
 * ⚠️ **刻意不断开连接**:Sendspin 的客户端列表是**连接派生**的(`srv.clients`),
 * 一旦 close,这台设备就整个从列表消失 —— 用户想再操作它都没入口。之前这里会
 * close,表现为「一遗忘设备就没了」,与「行要留着」的预期相反(2026-09-19 修正)。
 *
 * 改名由前端一并清除(见 Groups 页 unbindSendspin)。
 */
export async function forgetDialTarget(host: string, port: number): Promise<boolean> {
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return false;
    return sendspinSupervisor.rpc<boolean>("dialForget", { host, port });
  }
  const before = dialTargets.length;
  dialTargets = dialTargets.filter((t) => !(t.host === host && t.port === port));
  if (dialTargets.length === before) return false;
  await saveDialTargets();
  const srv = getServer();
  if (srv) {
    for (const conn of [...srv.clients.values()]) {
      if (conn.dialed && conn.dialHost === host && conn.dialPort === port) {
        if (conn.clientId) {
          try {
            const { deleteDeviceVolumeState } = await import("./deviceState.js");
            deleteDeviceVolumeState(conn.clientId);
          } catch { /* ignore */ }
        }
        // 撤回「已添加」标记,连接保持 —— 行还在,只是不再是记住的拨号目标。
        conn.dialed = false;
        conn.dialHost = "";
        conn.dialPort = 0;
      }
    }
  }
  return true;
}

async function dialRemembered(srv: SendspinServer): Promise<void> {
  for (const t of dialTargets.map((x) => ({ ...x }))) {
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
 *  日常路径由 onConnectionClosed 即时处理;这里只扫异常残留(如 stop 期间的竞态)。
 *  fork 模式下回收在子进程内自治,主进程侧只回报说明。 */
export function reclaimSendspinOrphans(): string {
  if (isForkMode()) return "sendspin:子进程模式(回收自治)";
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
  if (isForkMode()) return [];
  return esphomeBridge.snapshot();
}

/** 兼容别名:热更新统一走 applySendspinConfigHotUpdate。 */
export const reconfigureEsphomeMirror = applySendspinConfigHotUpdate;
