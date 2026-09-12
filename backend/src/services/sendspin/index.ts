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
  // key = 裸 clientId,与 registerDlnaDevice(裸 deviceId)一致。
  getQueueController().registerSendspinDevice(conn.clientId, conn.clientId);
}

/** 启动 Sendspin server(幂等):身份 → 实例 → 拨号已登记设备 → 注册播放器。 */
export async function startSendspinService(): Promise<SendspinRuntime> {
  const cur = getServer();
  if (cur) {
    return { server: cur, identity: cur.identity };
  }
  const identity = await loadOrCreateIdentity(path.join(identityDir));
  const srv = await SendspinServer.create({ pairkeys: identity, identityDir, serverName: "MusicFlow Sendspin" });
  setServer(srv);

  // 拨号当前已登记设备;就绪后注册播放器。拨号失败/离线不影响服务启动。
  await srv.dialAll().catch((e) => log.warn(`sendspin dialAll: ${e?.message || e}`));
  for (const conn of srv.clients.values()) {
    if (conn.ready) await registerServerPlayer(srv, conn);
  }
  log.info(`sendspin server started: ${srv.serverId}`);
  return { server: srv, identity };
}

/** 停止 Sendspin server(幂等):反注册全部 sendspin 播放器 + 关闭连接/组。 */
export async function stopSendspinService(): Promise<void> {
  const srv = getServer();
  if (!srv) return;
  const { getQueueController } = await import("../player/index.js");
  getQueueController().unregisterSendspinDevices();
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