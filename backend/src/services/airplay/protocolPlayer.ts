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
    async playMedia(item: QueueItem, baseUrl: string) {
      const streamUrl = createAirPlaySession(item.songId, deviceId, baseUrl).streamUrl;
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
        updatedAt: s.updatedAt,
      };
    },
  };
}
