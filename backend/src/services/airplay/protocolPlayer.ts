// AirPlay (RAOP) ProtocolPlayer — adapter that plugs AirPlay receivers into the
// unified queue/transport machinery (UniversalPlayer + QueueController) exactly
// like DLNA devices do. Audio is driven by services/airplay/control.ts; this
// file only maps the ProtocolPlayer contract onto it.
//
// Channel independence (L4): AirPlay used to *reuse* DLNA's createCastSession() and
// pull /rest/dlna/stream/:token — one route serving three protocols, which forced
// DLNA-only headers onto the AirPlay decoder and pinned the filter channel to `dlna`.
// It now mints its own token (services/airplay/session.ts) and pulls
// /rest/airplay/stream/:token; the streaming core stays shared (serveCastStream).
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createAirPlaySession } from "./session.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AirPlay");
import {
  castToAirPlayDevice,
  getAirPlayMediaUri,
  getAirPlayStatus,
  pauseAirPlay,
  resumeAirPlay,
  seekAirPlay,
  setAirPlayVolume,
  stopAirPlay,
} from "./control.js";

export function createAirPlayProtocolPlayer(deviceId: string): ProtocolPlayer {
  const playerId = `airplay:${deviceId}`;
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string, startMs = 0) {
      const streamUrl = createAirPlaySession(item.songId, deviceId, baseUrl).streamUrl;
      // ★ 起播即落位(流转/带进度起播):起点交给**这一次** ANNOUNCE/SETUP/RECORD,
      //   绝不再「先起播、再 seek」—— AirPlay 的 seek 是完整重建会话,连续两次建会话
      //   会让 HiVi 这类单会话设备在第二次 RECORD 上永久等待(2026-10-21 真机:
      //   流转时第 3 次握手 RECORD 挂死 12s → 流转失败/无声)。
      const seekSec = startMs > 0 ? startMs / 1000 : undefined;
      await castToAirPlayDevice({
        deviceId,
        songId: item.songId,
        title: item.title,
        artist: item.artist,
        album: item.album,
        coverArt: item.coverArt,
        durationSec: item.duration,
        baseUrl,
        streamUrl,
        ...(seekSec !== undefined ? { seekSec } : {}),
      });
      // mediaUri identifies the current track for PlayerController's
      // track_changed detection — the token stream URL is per-cast.
      return { mediaUri: streamUrl };
    },
    async stop() { await stopAirPlay(deviceId); },
    async pause() { await pauseAirPlay(deviceId); },
    async resume() { await resumeAirPlay(deviceId); },
    async seek(seconds: number) {
      // 入口+结果留痕:AirPlay seek 是"原地 FLUSH 换 decoder"还是"带 seekSec 重投",
      // 成败只看这一行(内部分支见 control.ts seekAirPlay)。
      const t0 = Date.now();
      log.debug(`[AirPlay][seek] ${deviceId} 目标=${seconds.toFixed(2)}s → 下发`);
      try {
        await seekAirPlay(deviceId, seconds);
        log.debug(`[AirPlay][seek] ${deviceId} 完成 ${Date.now() - t0}ms`);
      } catch (e: any) {
        log.debug(`[AirPlay][seek] ${deviceId} 失败 ${Date.now() - t0}ms err=${e?.message || e}`);
        throw e;
      }
    },
    async setVolume(vol: number) { await setAirPlayVolume(deviceId, vol); },
    async pollState(): Promise<PlayerState> {
      const s = getAirPlayStatus(deviceId);
      return {
        playerId,
        playbackState: s.playbackState as PlaybackState,
        position: s.position,
        duration: s.duration,
        // 与 DLNA 对齐(dlna/control.ts 的 pollState 带 GetPositionInfo.TrackURI):
        // PLAYING 期间必须带 mediaUri,否则 tracker 的「同为 PLAYING 但 uri 变 = 换歌」
        // 判据对 AirPlay **恒不可达**(设备侧真换歌检测形同虚设)。
        // 取 lastCast 的 token 化地址 —— 同一 (songId, deviceId) 复用 token(见 session.ts),
        // 同曲 seek 重投地址不变,不会误判 track_changed;真换歌 token 必变。
        mediaUri: getAirPlayMediaUri(deviceId),
        updatedAt: s.updatedAt,
      };
    },
  };
}
