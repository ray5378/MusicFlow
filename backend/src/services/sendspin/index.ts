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
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { SendspinServer, type SendspinConnection } from "./server.js";
import { WS_PORT } from "./constants.js";
import { PairingStore } from "./pairingStore.js";
import { PairingCoordinator } from "./pairServer.js";
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
 *  player/index 动态 import:避免 sendspin/index 在 builtins 初始化期被静态拉入
 *  player/index → QueueController → sendspin 的模块环(TDZ on `registered`)。 */
async function registerServerPlayer(srv: SendspinServer, conn: SendspinConnection): Promise<void> {
  const { getQueueController } = await import("../player/index.js");
  if (!conn.clientId) return; // activate 前不会有 clientId;防御
  // 显示名用客户端上报的 name(如 ESPHome 的 "Speaker Media Player"),无则回退 clientId。
  const displayName = conn.name || conn.clientId;
  // key = 裸 clientId,与 registerDlnaDevice(裸 deviceId)一致。
  getQueueController().registerSendspinDevice(conn.clientId, displayName);
  // 同步到 peer 层(sendspin:<clientId>)—— 前端切换器 / /v1/peers / /v1/play 才能发现并投送。
  // legacy 明文客户端标记 unencrypted(配对不可用,前端可据此提示)。
  try {
    const { getPeerManager } = await import("../peer.js");
    getPeerManager().registerSendspin(conn.clientId, displayName, true, conn.legacy);
  } catch { /* peer 层未就绪时忽略(播放器注册不受影响) */ }
}

/** 读 sendspin-renderer 插件配置(plugins 表 config JSON)。缺省全开(MA 对齐)。 */
function readSendspinPluginConfig(): { allowLegacyClients: boolean } {
  try {
    const row = sqlite
      .prepare("SELECT config FROM plugins WHERE id = 'sendspin-renderer' OR name = 'sendspin-renderer'")
      .get() as any;
    const cfg = row?.config ? JSON.parse(row.config) : {};
    return { allowLegacyClients: cfg?.allow_legacy_clients !== false };
  } catch {
    return { allowLegacyClients: true };
  }
}

/** 启动 Sendspin server(幂等):身份 → 实例 → 监听 :8927/sendspin。每个客户端
 *  完成 handshake+activate 后经 onActivated 回调注册为 QueueController 播放器。
 *  port 仅测试覆盖(默认 8927,避免多套件并行抢端口)。 */
export async function startSendspinService(port?: number): Promise<SendspinRuntime> {
  const cur = getServer();
  if (cur) {
    return { server: cur, identity: cur.identity };
  }
  const identity = await loadOrCreateIdentity(path.join(identityDir));
  const pluginCfg = readSendspinPluginConfig();
  const pairingStore = await PairingStore.open(identityDir);
  const srv = await SendspinServer.create({
    pairkeys: identity,
    identityDir,
    serverName: "MusicFlow Sendspin",
    allowLegacyClients: pluginCfg.allowLegacyClients,
    onActivated: (conn) => void registerServerPlayer(srv, conn),
    onClosed: async (conn) => {
      // 客户端断开:撤下其 sendspin peer(留播放器与队列,便于重连恢复)。
      if (!conn.clientId) return;
      try {
        const { getPeerManager } = await import("../peer.js");
        getPeerManager().removeSendspinPeer(conn.clientId);
      } catch { /* peer 层未就绪时忽略 */ }
    },
  });
  setServer(srv);
  srv.pairingStore = pairingStore;
  srv.pairing = new PairingCoordinator(srv, pairingStore);
  await srv.listen(port ?? WS_PORT); // 监听 ws://0.0.0.0:8927/sendspin(客户端拨入)
  log.info(`sendspin server started: ${srv.serverId}`);
  return { server: srv, identity };
}

/** 停止 Sendspin server(幂等):反注册全部 sendspin 播放器 + 关闭连接/组。 */
export async function stopSendspinService(): Promise<void> {
  const srv = getServer();
  if (!srv) return;
  const { getQueueController } = await import("../player/index.js");
  getQueueController().unregisterSendspinDevices();
  try {
    const { getPeerManager } = await import("../peer.js");
    getPeerManager().removeSendspinPeers();
  } catch { /* peer 层未就绪时忽略 */ }
  srv.stop();
  setServer(null);
  log.info("sendspin server stopped");
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