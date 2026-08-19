// ==================== AirPlay (RAOP) renderer plugin ====================
//
// Wraps the built-in RAOP renderer (services/airplay/*) as a `renderer` plugin,
// exactly like the DLNA renderer plugin wraps services/dlna/*. The heavy lifting
// (mDNS discovery, RTSP+RSA-encrypted transport, ffmpeg>RAW-ALAC streaming, queue
// persistence, auto-advance) lives in the airplay package + the unified
// QueueController; this plugin is a thin, capability-shaped adapter so the core
// can cast to AirPlay receivers through the same discover/cast/control surface.
//
// DLNA is untouched — this is a fully parallel subsystem sharing only the exports
// record layer of dlna/control.ts (createCastSession for stream URLs).

import { getEffectiveBaseUrl } from "../../../services/dlna/control.js";
import { listAirPlayDevices, castToAirPlayDevice } from "../../../services/airplay/control.js";
import { db } from "../../../db/index.js";
import { songs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import type { RendererPlugin, PluginManifest } from "../../../plugins/types.js";

export const AIRPLAY_RENDERER_ID = "airplay-renderer";

export const airplayRendererManifest: PluginManifest = {
  id: AIRPLAY_RENDERER_ID,
  name: "AirPlay 渲染器",
  version: "1.0.0",
  type: "renderer",
  description: "通过 AirPlay (RAOP) 协议将音乐投放到局域网内的 AirPlay 音箱、电视等设备",
  capabilities: ["renderer"],
  defaultEnabled: true,
  configSchema: [],
  documentation: `### 功能介绍
通过 AirPlay 1 (RAOP) 协议把音乐投放到局域网内的 AirPlay 音箱、电视、回音壁等设备（renderer 能力）。协议要求 RSA-OAEP 加密 + AES-CBC 分块推送,由系统 ffmpeg 解码任意音源 → 实时 RAW-ALAC 编码后推流。

### 处理逻辑
1. \`discoverRenderers()\` 通过 mDNS(\`_raop._tcp\`)在局域网发现 AirPlay 设备,随设备上下线自动增删;
2. 投屏时 \`castToRenderer()\` 建立 RTSP 会话(RSA 密钥交换),将专辑流加密推送到设备(设备自行解缓存并播放);
3. \`controlRenderer()\` 转发播放 / 暂停 / 停止 / 音量 / 进度 等控制指令;
4. 与 DLNA 共用统一队列控制器(\`QueueController\`),支持持久化队列、自动切歌、重启恢复。

### 说明
- 当前仅在「阿音 WR320」上验证通过(投屏/控制/音量/进度均正常),**其他设备不保证兼容**;
- 设备需支持 AirPlay 1 (RAOP,RTSP + RSA)——当前常见的有源音箱/回音壁基本都支持,但个别实现存在差异,如遇异常可在群组页先禁用/删除设备排查;
- 音频由服务器端 ffmpeg 解码后转码(无需设备支持格式);
- 不支持 AirPlay 2:开发与验证环境没有 AirPlay 2 真机(HomePod / Apple TV / 纯 AP2 音箱等),协议差异较大,暂不提供 AirPlay 2 支持。`,
};

export const airplayRendererPlugin: RendererPlugin = {
  manifest: airplayRendererManifest,
  async discover() {
    return listAirPlayDevices().map((d) => ({
      id: d.id,
      name: d.name,
      type: "airplay",
      available: d.available,
      meta: {
        manufacturer: d.am || "AirPlay",
        model: d.am || "RAOP",
        hasVolumeControl: true,
        supportsRsa: d.supportsRsa,
      },
    }));
  },
  async cast(deviceId: string, songId: string) {
    const baseUrl = getEffectiveBaseUrl();
    if (!baseUrl) throw new Error("未确定流地址(请先进行一次投屏或设置 DLNA_BASE_URL)");
    const song: any = db.select().from(songs).where(eq(songs.id, songId)).get();
    if (!song) throw new Error("歌曲不存在");
    await castToAirPlayDevice({
      deviceId,
      songId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      durationSec: typeof song.duration === "number" ? song.duration : undefined,
      baseUrl,
    });
    return { mediaUri: "" };
  },
  async control(deviceId: string, action: string, payload?: any) {
    const {
      pauseAirPlay, resumeAirPlay, stopAirPlay, seekAirPlay, setAirPlayVolume, setAirPlayMuted,
    } = await import("../../../services/airplay/control.js");
    switch (action) {
      case "play": return resumeAirPlay(deviceId);
      case "pause": return pauseAirPlay(deviceId);
      case "stop": return stopAirPlay(deviceId);
      case "seek": return seekAirPlay(deviceId, payload?.seconds ?? 0);
      case "volume": return setAirPlayVolume(deviceId, payload?.volume ?? 0);
      case "mute": return setAirPlayMuted(deviceId, !!payload?.muted);
      default: throw new Error(`不支持的渲染器操作: ${action}`);
    }
  },
};