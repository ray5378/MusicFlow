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
import {
  stopGroupPump,
  normalizePrefillBufferMs,
  PREFILL_BUFFER_DEFAULT_MS,
} from "./streamEngine.js";
import { advertiseSendspinServer, unadvertiseSendspinServer } from "./advertise.js";
import { startPlayerDiscovery, stopPlayerDiscovery, refreshPlayerDiscoveryNow } from "./discover.js";
import {
  esphomeBridge,
  type EsphomeWriteResult,
} from "./esphomeBridge.js";
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
  // ESPHome 6053 桥接:IP 从 Sendspin 连接自动派生(见 server.ts normalizeRemoteHost),
  // 密钥按 **clientId** 从库里读 —— 每台设备各自一把,host 会被 DHCP 换掉而
  // clientId 不会。没填密钥 ⇒ syncDevice 不建连接(等于这台不启用 6053)。
  try {
    const { getDeviceEsphome } = await import("./deviceState.js");
    const creds = getDeviceEsphome(conn.clientId);
    esphomeBridge.syncDevice(conn.remoteHost, creds.psk, creds.port);
  } catch { /* 读凭据失败按「不连」处理,不阻断设备上线 */ }
  // key = 裸 clientId,与 registerDlnaDevice(裸 deviceId)一致。
  qc.registerSendspinDevice(conn.clientId, displayName);
  // 同步到 peer 层(sendspin:<clientId>)—— 前端切换器 / /v1/peers / /v1/play 才能发现并投送。
  // 被用户禁用的设备**不注册为 peer**(与 DLNA reconcileDlnaPeers 同语义):
  // 禁用设备不出现在任何流转播放入口;解除禁用后重连即自动回来。
  let disabled = false;
  try {
    const { getDeviceDisabled, saveDeviceHost } = await import("./deviceState.js");
    // 记下这台设备这次的 host:拨号守卫靠它拦「被禁用的设备又被自动发现拨回来」
    // (发现那条路只有 host:port,拿不到 clientId —— 见 isHostOfDisabledDevice)。
    saveDeviceHost(conn.clientId, conn.remoteHost);
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
  // 上线回组:组在播时把本设备接回组 pump 的直播沿(见 rejoinActiveGroups)。
  await rejoinActiveGroups(conn.clientId);
}

/** 设备上线后自动「回组」:若它属于某个**正在播**的用户组,按「加入群组」的同一流程
 *  把它接回组 pump 的直播沿(灌组音量 → joinGroupCore),不必等用户再切一次歌。
 *
 *  为什么必须做:组 pump 的成员是 `SendspinGroup.members` 里的 **conn 对象**,而断开时
 *  `onConnectionClosed` 会 `g.remove(conn)`;重连产生的是**新 conn**,不在任何组里 ——
 *  只有下一次 `playGroupCore`(切歌/重新 cast)才会 `g.add(conn)`。夹在中间这段
 *  「已连接但未入组」的窗口里,设备拿不到 `pendingAnnounces` 兑现的 `stream/start`,
 *  表现为**「TCP 上数据正常、设备却无声」,直到切歌才响**(2026-09-25 真机:硬断电
 *  重连后必须切下一首才开始播放)。
 *
 *  与 `alignGroupMembers` 的 sendspin 新增分支同源(volume → join);幂等 ——
 *  joinGroupCore 对已在组内的 conn 直接返回。 */
async function rejoinActiveGroups(clientId: string): Promise<void> {
  if (!clientId || clientId.startsWith("ug:")) return; // ug: 是组名,不是设备 id
  const qc = qcSingleton;
  if (!qc) return; // 控制器未就绪:不影响设备注册本身
  try {
    const { getGroupManager } = await import("../group/index.js");
    const { sendspinGroupName } = await import("./playerCore.js");
    const gm = getGroupManager();
    for (const groupId of gm.groupsOfDevice(clientId)) {
      // 只回**正在播**的组:组空闲时 joinGroupCore 仅登记成员、没有可接的流,
      // 反而是替「没在播的组」凭空建立成员关系。
      let active = false;
      try { active = !!qc.snapshot(groupId).isActive; } catch { /* 无该组队列 = 未播 */ }
      if (!active) continue;
      const groupName = sendspinGroupName(groupId);
      // 回组前灌组音量(ug 组懒创建缺省 100):与 playMedia/alignGroupMembers 同源。
      try { await sendspinGroupTransport(groupName, "volume", gm.getVolume(groupId)); }
      catch { /* 音量回填失败不挡入组 */ }
      const r = await sendspinGroupJoin(groupName, clientId);
      // pump 活性一并留痕:live=true 但 pump=false 说明「组在播却无推流」,
      // 属看门狗(resumeActive)的职责范围,真机排障时一眼可见。
      const pumpActive = await sendspinGroupPumpActive(groupName).catch(() => false);
      log.info(`sendspin 设备上线自动回组 ${groupId}: ${clientId} joined=${r.joined} live=${r.live} pump=${pumpActive}`);
    }
  } catch (e: any) {
    log.warn("sendspin 设备上线回组失败", { client: clientId, err: e?.message || e });
  }
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
  streamSource: boolean;
  prefillBufferMs: number;
} {
  const fallback = {
    allowLegacyClients: true,
    port: WS_PORT,
    autoDiscover: true,
    preferredCodec: "pcm" as SendspinCodecPreference,
    streamSource: true,
    prefillBufferMs: PREFILL_BUFFER_DEFAULT_MS,
  };
  try {
    const row = sqlite
      .prepare("SELECT config FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'")
      .get() as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    const port = Number(cfg?.port);
    return {
      allowLegacyClients: cfg?.allow_legacy_clients !== false,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : WS_PORT,
      autoDiscover: cfg?.auto_discover !== false,
      // 只认 pcm / flac 两个值,非法或缺省一律 pcm(2026-09-17 ESP32 真机实测最优)。
      preferredCodec: normalizeCodecPreference(cfg?.preferred_codec),
      // 注:ESPHome 6053 的开关/密钥/端口**已从这里移除** —— 它们是每台设备各自的,
      // 存在 sendspin_device_state(clientId → psk/port),见 deviceState.ts。
      // 流式解码:默认开(3.0.36 灰度验证稳定后转正);只有**显式 false** 才关
      // (老用户此前手关闭仍保持关)。缺省/非布尔一律按默认开。
      streamSource: cfg?.stream_source !== false,
      // 预填充缓冲(设备侧抗抖动窗口,毫秒)。插件配置页**随时可改**,推流循环
      // 以 PREFILL_CACHE_MS 的粒度重读(见 streamEngine),无需重启、不中断当前播放。
      prefillBufferMs: normalizePrefillBufferMs(cfg?.prefill_buffer_ms),
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
  // ESPHome 6053:不再有全局开关/密钥。连接是**每台设备**上线时按 clientId 查到
  // 自己的密钥才建立(见 registerServerPlayer 的 syncDevice),启动时无事可做。
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
  // 记住的拨号目标:启动即为每个目标**开一个重试窗口**(首拨立即发出),之后由 1s
  // 节拍的状态机推进(2s×30 → 10s×24,5 分钟停手)。
  if (dialTargetsLoadedFor !== identityDir) await loadDialTargets();
  for (const t of dialTargets.map((x) => ({ ...x }))) {
    await armDialTarget(t.host, t.port, "boot");
  }
  if (redialTimer) clearInterval(redialTimer);
  redialTimer = setInterval(() => {
    try {
      redialTick();
    } catch (e: any) {
      log.warn("redial tick failed", { err: e?.message || e });
    }
  }, RETRY_TICK_MS);
  redialTimer.unref?.();
  // 播放器自动发现:浏览 _sendspin._tcp,新设备出现即入册开窗(只发现不自动播)。
  // 与记忆重拨互补:没拨过的设备靠这个首次出现;它也是「不设兜底」方案**唯一**的
  // 重新开窗信号源(每 60s 重建 browser),两者必须同时成立。
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
  retryStates.clear();
  retryInFlight.clear();
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
      // 上线回组(与 in-proc registerServerPlayer 尾部同构,见 rejoinActiveGroups)。
      void rejoinActiveGroups(clientId);
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

/** ESPHome 6053 桥接状态(fork 走 RPC,in-proc 直读桥接单例)。
 *
 *  已无「全局开关 / 全局密钥」—— 每台设备各连各的,是否启用与端口挂在单设备
 *  快照的 `pskConfigured` / `port` 上(⚠️ PSK 本身永不回显)。
 *  只有填了密钥且已建连的设备才会出现在 devices 里。 */
export async function sendspinEsphomeStatus(): Promise<{
  devices: unknown[];
}> {
  if (isForkMode()) {
    const { proxyEsphomeStatus } = await import("./proxy.js");
    const r = (await proxyEsphomeStatus()) as any;
    return { devices: r?.devices ?? [] };
  }
  const srv = getServer();
  return { devices: srv ? esphomeBridge.snapshot() : [] };
}

/** 按 clientId 找该设备当前的对端 IP(6053 的连接目标)。
 *  前端只认 clientId —— host 是连接派生的、会被 DHCP 换掉,不该由前端持有。 */
export function resolveEsphomeHost(clientId: string): string {
  if (!clientId) return "";
  try {
    const front = getSendspinFront() as any;
    const clients = front?.clients;
    if (clients && typeof clients.values === "function") {
      for (const conn of clients.values()) {
        if (conn?.clientId === clientId && conn?.remoteHost) return String(conn.remoteHost);
      }
    }
  } catch { /* 取不到就当离线处理 */ }
  return "";
}

/** 保存某台设备的 ESPHome 6053 凭据(**每台设备各自一把**,不是全局)。
 *
 *  - 落库按 clientId(host 会变,clientId 不会);
 *  - 设备当前在线 ⇒ 立即让桥生效(填了就连 / 清空就断);
 *  - 离线 ⇒ 只落库,等设备重连时由 registerServerPlayer 的 syncDevice 自动带上。
 *  返回实际作用到的 host(空串 = 设备当前离线)。 */
export async function sendspinSaveEsphomeCreds(
  clientId: string,
  psk: string,
  port = 0,
): Promise<{ ok: boolean; host: string }> {
  if (!clientId) return { ok: false, host: "" };
  const { saveDeviceEsphome } = await import("./deviceState.js");
  saveDeviceEsphome(clientId, psk, port);
  const host = resolveEsphomeHost(clientId);
  if (!host) return { ok: true, host: "" };
  if (isForkMode()) {
    try {
      await sendspinSupervisor.rpc("esphomeSync", { host, psk: String(psk ?? ""), port });
    } catch (e: any) {
      log.warn(`esphomeSync 下发失败(子进程未运行?设备重连时会补上): ${e?.message || e}`);
    }
  } else {
    esphomeBridge.syncDevice(host, psk, port);
  }
  return { ok: true, host };
}

/** 设**设备自身**音量(0..100 → 0..1),走 6053 的 speaker 硬件输出,
 *  与音乐采样增益(Sendspin group volume)是两个旋钮,实际响度 = 两者相乘。 */
export async function sendspinSetEsphomeVolume(
  clientId: string,
  volume: number,
): Promise<EsphomeWriteResult> {
  const host = resolveEsphomeHost(clientId);
  if (!host) return { ok: false, code: "no-bridge", sent: 0 };
  if (isForkMode()) {
    try {
      const r = (await sendspinSupervisor.rpc("esphomeVolume", { host, volume })) as EsphomeWriteResult;
      return r ?? { ok: false, code: "send-failed", sent: 0 };
    } catch {
      return { ok: false, code: "send-failed", sent: 0 };
    }
  }
  return esphomeBridge.setVolume(host, volume / 100);
}

/** 设**设备自身**静音(同上)。 */
export async function sendspinSetEsphomeMuted(
  clientId: string,
  muted: boolean,
): Promise<EsphomeWriteResult> {
  const host = resolveEsphomeHost(clientId);
  if (!host) return { ok: false, code: "no-bridge", sent: 0 };
  if (isForkMode()) {
    try {
      const r = (await sendspinSupervisor.rpc("esphomeMute", { host, muted })) as EsphomeWriteResult;
      return r ?? { ok: false, code: "send-failed", sent: 0 };
    } catch {
      return { ok: false, code: "send-failed", sent: 0 };
    }
  }
  return esphomeBridge.setMuted(host, muted);
}

/** 读某台设备镜像到的自身音量(0..100)与静音态;没连上返回 null。
 *  这是**设备侧真值**(外部判据),不是服务端记的采样增益。 */
export async function sendspinGetEsphomeVolume(
  clientId: string,
): Promise<{ volume: number; muted: boolean } | null> {
  const host = resolveEsphomeHost(clientId);
  if (!host) return null;
  if (isForkMode()) {
    try {
      const r = (await sendspinSupervisor.rpc("esphomeReadVolume", { host })) as any;
      return r ?? null;
    } catch {
      return null;
    }
  }
  const v = esphomeBridge.mirroredVolume(host);
  return v ? { volume: Math.round(v.volume * 100), muted: v.muted } : null;
}

/** 插件配置热更新:preferredCodec / allowLegacyClients,一条路径覆盖
 *  in-proc 与 fork(fork 经 RPC 让子进程自应用)。端口变更不在此 —— 需重启监听,
 *  由路由层走 stop/start(杀子进程重建)。
 *  注:ESPHome 6053 已无全局配置,每台设备的连断由 syncDevice 各自管理。 */
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
  // 6053 不再有全局配置可应用:每台设备的连断由 syncDevice 各自管理。
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
      // 6053 桥是按 **host** 登记的:连接还在时先把它解挂,否则库里密钥已删、
      // 桥却仍攥着旧密钥连着设备(音量按钮显示"已连接",与"已清掉"自相矛盾)。
      try { esphomeBridge.syncDevice(conn.remoteHost, "", 0); } catch { /* ignore */ }
      try { conn.close(); } catch { /* ignore */ }
    }
  }
  // 解绑 = 这台设备从没被配置过:状态行(音量/静音/禁用/6053 密钥)+ 改名 + 隐藏
  // 一并清掉。连接保持在线,所以不动播放队列与群组成员(见 purgeDeviceArtifacts)。
  try {
    const { purgeDeviceArtifacts } = await import("./deviceState.js");
    purgeDeviceArtifacts(clientId);
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

// ── 重试状态机(2026-09-25 重写,节奏由用户指定)──────────────────────────────
//
// 目标:设备**硬断电**再上电后自动连回来。旧实现是「60s 一轮、整轮只拨一次」,
// 且 `dial_targets` 只在**拨号成功后**才写 —— 首次就失败(开机瞬间 :8928 还没 listen)
// 的设备永远进不了名单,轮询遍历不到它 ⇒ **一次失败 = 永久失联**。
//
// 节奏:阶段 1 每 2s 一次、共 30 次(前 60s);阶段 2 每 10s 一次、共 24 次(后 240s)。
// 合计 54 发 / 300s 后**停手**。
//
// ⚠️ **不设兜底轮询**:5 分钟走完后不再慢速重试,而是等**新的发现信号**
// (discover.ts 每 60s 重建 browser → 在线设备重新 emit `up`)重新开窗。
// 因此本机制**必须**与 discover 的周期信号同时成立 —— 单独用会退化成「5 分钟即永久放弃」。
const RETRY_TICK_MS = 1_000;
const RETRY_FAST_INTERVAL_MS = 2_000;
const RETRY_FAST_WINDOW_MS = 60_000;
const RETRY_SLOW_INTERVAL_MS = 10_000;
const RETRY_WINDOW_MS = 300_000;
/** 单次拨号的 connect+activate 超时。局域网握手 <1s;真失效的地址毫秒级就
 *  `EHOSTUNREACH`,故此值只对「在但慢」的目标生效,不会拖慢 2s 节奏。 */
const RETRY_CONNECT_TIMEOUT_MS = 5_000;

interface RetryState {
  /** 窗口起点(ms)。**窗口内不因新信号重置** —— 否则每 60s 一次的发现信号会让窗口
   *  一直停在「前 60s 的 2s 阶段」,10s 阶段永远到不了(等效无限 2s 拨号)。 */
  t0: number;
  attempts: number;
  nextAt: number;
  /** 迄今是否**每次**失败都是地址级不可达。窗口走完据此决定是否淘汰记忆目标。 */
  addressLevelOnly: boolean;
  /** 是否已把「进入慢速阶段」打过 info(避免每发都刷屏)。 */
  loggedSlow: boolean;
}

/** "host:port" → 重试窗口状态。窗口结束(成功 / 淘汰 / 停手)即删除。 */
const retryStates = new Map<string, RetryState>();
/** 已有一发拨号在飞的 "host:port"(避免 1s tick 叠发)。 */
const retryInFlight = new Set<string>();
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
  // 明确遗忘 = 停止对它的重试(否则状态机还会继续拨满一个 5 分钟窗口)。
  cancelRetry(host, port);
  const before = dialTargets.length;
  dialTargets = dialTargets.filter((t) => !(t.host === host && t.port === port));
  if (dialTargets.length === before) return false;
  await saveDialTargets();
  const srv = getServer();
  if (srv) {
    for (const conn of [...srv.clients.values()]) {
      if (conn.dialed && conn.dialHost === host && conn.dialPort === port) {
        if (conn.clientId) {
          // 6053 桥按 host 登记,先解挂再清库(与 sendspinUnpair 同款,理由见那里)。
          try { esphomeBridge.syncDevice(conn.remoteHost, "", 0); } catch { /* ignore */ }
          try {
            const { purgeDeviceArtifacts } = await import("./deviceState.js");
            purgeDeviceArtifacts(conn.clientId);
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

/** 为一个目标开重试窗口(「发现即写」的唯一入口)。
 *
 *  返回 true = 新开窗(调用方不必再自己拨:状态机会立刻首发并持续重试);
 *  false = 无需动作(已在线 / 抑制期内 / 已有窗口在跑(窗口内不重置) / 服务未运行)。
 *
 *  只在 sendspin 子进程内被调用(discover 循环跑在 in-proc 装配里),故不走 RPC。 */
export async function armDialTarget(host: string, port: number, src = "signal"): Promise<boolean> {
  const srv = getServer();
  if (!srv) {
    log.warn(`armDialTarget: sendspin 服务未运行,忽略 ${host}:${port} (${src})`);
    return false;
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  // 守卫:该 host 属于**被用户禁用**的设备 → 不拨(禁用 = 别再自动连它)。
  // 拦在这里是因为**所有拨号来源都过这个函数**:自动发现 / 音流名单补枪 / 手工 dial。
  try {
    const { isHostOfDisabledDevice } = await import("./deviceState.js");
    if (isHostOfDisabledDevice(host)) {
      log.debug(`armDialTarget: ${host}:${port} 属于已禁用设备,跳过 (${src})`);
      return false;
    }
  } catch { /* 读不到禁用态 → 按未禁用处理,不阻断拨号 */ }
  const key = `${host}:${port}`;
  if (srv.isRedialSuppressed(host, port)) return false;
  if (srv.isConnectedTo(host, port)) {
    cancelRetry(host, port);
    return false;
  }
  // ① 先记住、再拨:即便这一发失败,设备也已进 dial_targets。旧实现写在**成功之后**
  //    (discover.ts),失败即中断 ⇒ 名单里永远没有它 ⇒ 一次失败 = 永久失联。
  await rememberDialTarget(host, port);
  if (retryStates.has(key)) return false; // 窗口内不重置进度
  retryStates.set(key, { t0: Date.now(), attempts: 0, nextAt: Date.now(), addressLevelOnly: true, loggedSlow: false });
  log.info(`sendspin 重试窗口开启(${src}): ${key} —— 2s×30 → 10s×24,共 ${Math.round(RETRY_WINDOW_MS / 1000)}s`);
  redialTick(); // 立即首拨,不等下一个 tick
  return true;
}

/** wakeSendspinDiscovery() 的结果。 */
export interface WakeResult {
  /** 本次真的重发了 `_sendspin._tcp` PTR 查询(false = 被节流 / 发现未启动)。 */
  rescanned: boolean;
  /** 本次新开重试窗口的目标(key 形如 `host:port`)。 */
  rearmed: string[];
}

/** 唤醒自动发现的**实际执行体**。
 *
 *  ⚠️ **必须在持有 sendspin 运行时的进程内调用**(fork 下的 sendspin 子进程 / in-proc
 *  装配 / 单测)。本包内 `refreshPlayerDiscoveryNow` 读的是 discover 模块内的 `serving`,
 *  `armDialTarget` 读的是 `runtime.getServer()` —— 两者都是**进程内单例**,只在
 *  startPlayerDiscovery() 执行过的那个进程里有值。主进程在 fork 模式下两者皆空 ⇒
 *  直调只会**静默空转**(前者返回 false 且不打日志,后者打一行 warn)。
 *  外部调用方一律走 wakeSendspinDiscovery(),不要直接调本函数。 */
export async function wakeDiscoveryCore(): Promise<WakeResult> {
  const srv = getServer();
  if (!srv) return { rescanned: false, rearmed: [] };
  // ① 立刻重建 browser(= 马上重发一次 `_sendspin._tcp` PTR 查询,默认 5s 节流)。
  //    覆盖「设备开机只广播一次、而我们恰好错过了那一次」:新 browser 的 _services
  //    为空 ⇒ 在线设备会重新 emit up ⇒ discover.onPlayerSeen 重新入册 + 开窗。
  let rescanned = false;
  try { rescanned = refreshPlayerDiscoveryNow(); } catch { /* 发现未启动 → 视为没重扫 */ }
  // ② 名单补枪:对 dial_targets.json 里「已知但当前不在线」的目标补开一个重试窗口。
  //    覆盖「设备在线、但 mDNS 长期静默」的边缘 —— 名单里存着 host,不必等发现。
  const rearmed: string[] = [];
  for (const t of await listDialTargets()) {
    try {
      if (srv.isConnectedTo(t.host, t.port)) continue;
      if (await armDialTarget(t.host, t.port, "flow")) rearmed.push(`${t.host}:${t.port}`);
    } catch { /* 单台失败不拖累其余 */ }
  }
  return { rescanned, rearmed };
}

/** 唤醒自动发现的**唯一对外入口**(音流等待阶段调用)。
 *
 *  分派:fork 模式 → RPC 到 sendspin 子进程执行(发现循环与重试状态机都活在那里);
 *  in-proc 模式(单测 / MUSICFLOW_SENDSPIN_INPROC=1)→ 当前进程直跑。
 *
 *  🔴 2026-09-25 实测教训:音流引擎跑在**主进程**,最初直调 refreshPlayerDiscoveryNow
 *  + armDialTarget,在生产(fork)下 **100% 空转** —— 日志里只有
 *  `armDialTarget: sendspin 服务未运行`(且返回 false,导致音流侧连「重扫」记录都攒不出),
 *  而 refreshPlayerDiscoveryNow 连日志都不打,更难发现。凡是操作 sendspin 运行时状态的
 *  命令,都必须像本函数这样按 isForkMode() 分派(与 esphomeSync / disconnect 同惯例)。
 *
 *  守卫(插件启用 / autoDiscover)收在这里:poll 式调用方再多也不会绕过配置。 */
export async function wakeSendspinDiscovery(): Promise<WakeResult> {
  try {
    if (!isSendspinEnabled()) return { rescanned: false, rearmed: [] };
    if (!readSendspinPluginConfig().autoDiscover) return { rescanned: false, rearmed: [] };
  } catch { return { rescanned: false, rearmed: [] }; }
  if (isForkMode()) {
    if (!sendspinSupervisor.isRunning()) return { rescanned: false, rearmed: [] };
    return await sendspinSupervisor.rpc<WakeResult>("wakeDiscovery", {}, 20_000);
  }
  return wakeDiscoveryCore();
}

/** 取消某目标的重试窗口(手动 forget / 已连上时用)。 */
function cancelRetry(host: string, port: number): void {
  const key = `${host}:${port}`;
  retryStates.delete(key);
  retryInFlight.delete(key);
}

/** 重试状态机的一拍。**同步**执行:拨号 fire-and-forget,单飞靠 retryInFlight
 *  + `dialPlayer` 自身的 pendingDials 双保险 —— 故不存在「上一拍没跑完」的重叠问题。 */
function redialTick(): void {
  const srv = getServer();
  if (!srv) return;
  const now = Date.now();
  for (const [key, st] of [...retryStates]) {
    const sep = key.lastIndexOf(":");
    const host = key.slice(0, sep);
    const port = Number(key.slice(sep + 1));
    // 唯一成功出口:连上了。
    if (srv.isConnectedTo(host, port)) {
      cancelRetry(host, port);
      continue;
    }
    // 手动 dial 清除了抑制 / 设备 goodbye 拉黑:立刻收工,不再骚扰。
    if (srv.isRedialSuppressed(host, port)) {
      cancelRetry(host, port);
      continue;
    }
    // 窗口走完:停手(不设兜底轮询,等下一轮发现信号重新开窗,见 RETRY_WINDOW_MS 注释)。
    // 若还有一发在飞,先等它落地再判 —— 否则会把「其实刚连上」的设备误判成失败。
    if (now - st.t0 >= RETRY_WINDOW_MS) {
      if (retryInFlight.has(key)) continue;
      retryStates.delete(key);
      if (st.addressLevelOnly) {
        void evictStaleTarget(key, host, port, st.attempts);
      } else {
        log.info(`sendspin 重试窗口结束(未连上,保留记忆目标): ${key} 共尝试 ${st.attempts} 次`);
      }
      continue;
    }
    if (now < st.nextAt) continue;
    if (retryInFlight.has(key)) continue;
    const fast = now - st.t0 < RETRY_FAST_WINDOW_MS;
    if (!fast && !st.loggedSlow) {
      st.loggedSlow = true;
      log.info(`sendspin 重试进入慢速阶段(每 10s 一次,至第 ${Math.round(RETRY_WINDOW_MS / 1000)}s): ${key} 已尝试 ${st.attempts} 次`);
    }
    st.attempts += 1;
    st.nextAt = now + (fast ? RETRY_FAST_INTERVAL_MS : RETRY_SLOW_INTERVAL_MS);
    retryInFlight.add(key);
    srv
      .dialPlayer(`ws://${host}:${port}/sendspin`, RETRY_CONNECT_TIMEOUT_MS)
      .then(() => {
        retryInFlight.delete(key);
        retryStates.delete(key);
        log.info(`sendspin 重拨成功: ${key}`);
      })
      .catch((e: any) => {
        retryInFlight.delete(key);
        const msg = String(e?.message || e);
        if (!isStaleAddressError(msg)) st.addressLevelOnly = false;
        // 首发失败打 info(这是「设备刚开机还没就绪」的关键证据),之后降为 debug
        // 免得一台离线设备在 5 分钟里刷 54 行。阶段切换 / 收尾另有 info。
        const line = `sendspin 重拨失败(第 ${st.attempts} 次): ${key} ${msg}`;
        if (st.attempts === 1) log.info(line);
        else log.debug(line);
      });
  }
}

/** 淘汰记忆目标 —— **非破坏性**:只从 dial_targets 移除,不 purge 设备档案(音量 / 6053 密钥)。
 *
 *  判据从「连续 N 次失败」改为「**整个重试窗口内每次失败都是地址级不可达**」:
 *  旧判据(连续 3 次)在 2s 节奏下第 6 秒就会把设备踢出名单,与「重试到成功」正面矛盾
 *  (2026-09-25 定位)。语义上这仍然安全:设备一旦重新被 mDNS 看到(discover 每 60s
 *  重查一遍),会以新地址重新入册。 */
async function evictStaleTarget(key: string, host: string, port: number, attempts: number): Promise<void> {
  const before = dialTargets.length;
  dialTargets = dialTargets.filter((t) => !(t.host === host && t.port === port));
  if (dialTargets.length === before) return;
  await saveDialTargets();
  log.warn(
    `sendspin 拨号目标已失效(${attempts} 次尝试全程地址不可达),移除记忆目标 ${key}`
    + ` —— 设备换 IP 后会经 mDNS 自动重新发现并记住`,
  );
}

/** 错误文案是否属于「地址层面已失效」(该地址上不再是这台设备)。
 *  仅这些才允许淘汰记忆目标 —— ECONNREFUSED / ETIMEDOUT 是"在但暂时不应答"
 *  (设备重启/忙),淘汰会让正常设备失去重连档案,不在此列。 */
function isStaleAddressError(msg: string): boolean {
  return /EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|EAI_AGAIN|ENETDOWN/.test(msg);
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
