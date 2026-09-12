// Sendspin ProtocolPlayer — 把每个 Sendspin 客户端(或客户端组)接入统一队列/传输
// 机制(UniversalPlayer + QueueController),与 DLNA 设备完全同构。音频由
// services/sendspin/server.ts 的 SendspinGroup 一次性解码→逐客户端编码→同一时间线
// 推流驱动;本文件只把 ProtocolPlayer 契约映射到 SendspinServer 的组/连接状态上。
//
// 与 DLNA 一样,报给上游的 mediaUri 复用 createCastSession 的 token 流地址(供
// PlayerController 检测曲目切换),真正音频走内部推流,不依赖设备回连拉流。
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createCastSession } from "../dlna/control.js";
import { getServer } from "./runtime.js";

/** 单个 sendspin 客户端抽象成一个 ProtocolPlayer。 */
export function createSendspinProtocolPlayer(clientId: string): ProtocolPlayer {
  const playerId = `sendspin:${clientId}`;
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const srv = getServer();
      if (!srv) throw new Error(`sendspin server not running: ${clientId}`);
      const conn = srv.clients.get(clientId);
      // 同一时间线推流:组 = 以 clientId 命名的组(多客户端场景由注册层归并)。
      const g = srv.group(clientId);
      g.positionMs = 0;
      g.current = { songId: item.songId, title: item.title, artist: item.artist, durationMs: (item.duration ?? 0) * 1000 };
      // mediaUri:token 流地址,仅供 track_changed 检测;音频走内部推流。
      const streamUrl = createCastSession(item.songId, clientId, baseUrl).streamUrl;
      if (conn) conn.group = g;
      return { mediaUri: streamUrl };
    },
    async stop() {
      const g = groupOf(clientId);
      g.positionMs = 0;
      g.current = null;
    },
    async pause() {},
    async resume() {},
    async seek(seconds: number) {
      const g = groupOf(clientId);
      g.positionMs = Math.max(0, seconds * 1000);
    },
    async setVolume(vol: number) {
      const srv = getServer();
      const conn = srv?.clients.get(clientId);
      if (conn) conn.volume = Math.min(100, Math.max(0, vol));
      groupOf(clientId).volume = Math.min(100, Math.max(0, vol));
    },
    async pollState(): Promise<PlayerState> {
      const g = groupOf(clientId);
      // 逻辑播放状态以「组当前曲」为准(已注册播放器在投/续播即视为播放中);
      // 连接就绪与否只影响推流可达性,不改变 QueueController 的切歌/恢复判定。
      const playing = !!g.current;
      return {
        playerId,
        playbackState: playing ? PlaybackState.PLAYING : PlaybackState.IDLE,
        position: g.positionMs / 1000,
        duration: (g.current?.durationMs ?? 0) / 1000,
        updatedAt: Date.now(),
      };
    },
  };
}

/** 取 clientId 对应组;服务端未运行则返回内存假组(供未连接时的幂等控制)。 */
function groupOf(clientId: string): SendspinGroupLike {
  const srv = getServer();
  if (!srv) return ephemeralGroup(clientId);
  return srv.group(clientId);
}

// 内存假组:服务未跑但在做 URI 兜底/状态构造时安全返回。
interface SendspinGroupLike {
  positionMs: number;
  volume: number;
  current: { songId: string; title?: string; artist?: string; durationMs: number } | null;
}
const ephemeralMap = new Map<string, SendspinGroupLike>();
function ephemeralGroup(clientId: string): SendspinGroupLike {
  let g = ephemeralMap.get(clientId);
  if (!g) {
    g = { positionMs: 0, volume: 100, current: null };
    ephemeralMap.set(clientId, g);
  }
  return g;
}