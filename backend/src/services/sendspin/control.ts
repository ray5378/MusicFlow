// ==================== Sendspin 对外控制面 ====================
//
// renderer 薄壳(sendspin.ts)依赖的控制入口。Sendspin 是服务端角色:客户端主动连入并
// 点播曲库,故：
//   - listSendspinPlayers()  枚举已连接/已登记的客户端,渲染为可投屏设备;
//   - castSendspin()         把一首歌投到指定客户端(组)—— 走 createSendspinProtocolPlayer,
//                            与 DLNA/AirPlay 同一契约,复用 QueueController 的服务器权威逻辑;
//   - controlSendspin()      把 play/pause/stop/seek/volume/mute 映射到 ProtocolPlayer。

import { getSendspinServer, startSendspinService } from "./index.js";
import type { RendererDevice } from "../../plugins/types.js";
import { db } from "../../db/index.js";
import { songs } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { getEffectiveBaseUrl } from "../dlna/control.js";
import type { QueueItem } from "../player/types.js";

/** 枚举当前已连接/已登记的 Sendspin 客户端,渲染为可投屏的"播放器"设备。 */
export async function listSendspinPlayers(): Promise<RendererDevice[]> {
  const srv = getSendspinServer();
  if (!srv) return [];
  const ids = new Set([...srv.clients.keys()]);
  return [...ids].map((clientId) => ({
    id: clientId,
    name: clientId,
    type: "sendspin",
    available: srv.clients.get(clientId)?.ready ?? false,
    meta: {
      manufacturer: "Sendspin",
      model: "Sendspin client",
      hasVolumeControl: true,
    },
  }));
}

/** 将 songId 投放到指定 Sendspin 客户端(组)播放。
 *  Sendspin 是服务端角色,播放应走 QueueController(服务器权威的队列/自动切歌/换源);
 *  这里仅作为 renderer 契约的便捷入口:解析歌曲 → 构造 QueueItem → 经 ProtocolPlayer.playMedia。 */
export async function castSendspin(deviceId: string, songId: string): Promise<{ mediaUri: string }> {
  if (!getSendspinServer()) await startSendspinService();
  const baseUrl = getEffectiveBaseUrl();
  const row: any = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!row) throw new Error("歌曲不存在");
  const item: QueueItem = {
    songId,
    title: row.title || "未知",
    artist: row.artist || undefined,
    album: row.album || undefined,
    mime: "audio/mpeg",
    coverArt: row.coverArt || undefined,
    duration: typeof row.duration === "number" ? row.duration : undefined,
  };
  const p = registeredProtocolPlayer(deviceId);
  if (!p) throw new Error(`Sendspin 客户端未注册: ${deviceId}`);
  return p.playMedia(item, baseUrl);
}

/** 对 Sendspin 客户端(组)下发控制指令。 */
export async function controlSendspin(
  deviceId: string,
  action: string,
  payload?: unknown,
): Promise<unknown> {
  const p = registeredProtocolPlayer(deviceId);
  if (!p) throw new Error(`Sendspin 客户端无协议 player: ${deviceId}`);
  const body = payload as Record<string, any> | undefined;
  switch (action) {
    case "play": return p.resume();
    case "pause": return p.pause();
    case "stop": return p.stop();
    case "seek": return p.seek((body?.seconds as number) ?? 0);
    case "volume": return p.setVolume((body?.volume as number) ?? 0);
    default: throw new Error(`不支持的 Sendspin 操作: ${action}`);
  }
}

function registeredProtocolPlayer(deviceId: string) {
  const { getQueueController } = require("../player/index.js") as typeof import("../player/index.js");
  return getQueueController()["players"].get(deviceId)?.getProtocol() ?? null;
}