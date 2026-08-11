// ==================== DLNA renderer plugin ====================
//
// Wraps the existing DLNA adapter (services/dlna/*) as a `renderer` plugin so
// the core can treat device-casting as a capability rather than a hardcoded
// subsystem. The heavy lifting (SSDP discovery, UPnP AV control, queue
// persistence) stays in the dlna package; this plugin is a thin, capability-
// shaped adapter. A Chromecast / AirPlay / Kodi renderer could be added later
// as a separate plugin implementing the same RendererPlugin interface — no core
// change required.
//
// NOTE: the proven /v1/dlna/cast endpoint still calls castToDevice() directly
// (it needs the request-derived LAN base URL for the stream). castToRenderer()
// in plugins/renderers.ts exposes the same capability through the unified host
// layer for future callers / alternate renderers.

import {
  getCachedDevices,
  castToDevice,
  getEffectiveBaseUrl,
  deviceDisplayName,
} from "../../../services/dlna/control.js";
import { markStaleDevices } from "../../../services/dlna/discovery.js";
import { db } from "../../../db/index.js";
import { songs } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import type { RendererPlugin, RendererDevice, PluginManifest } from "../../../plugins/types.js";

const DLNA_MIME: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
  ogg: "audio/ogg", m4a: "audio/mp4", wma: "audio/x-ms-wma", ape: "audio/ape",
  aiff: "audio/aiff", opus: "audio/opus",
};

export const DLNA_RENDERER_ID = "dlna-renderer";

export const dlnaRendererManifest: PluginManifest = {
  id: DLNA_RENDERER_ID,
  name: "DLNA 渲染器",
  version: "1.0.0",
  type: "renderer",
  description: "通过 DLNA/UPnP 将音乐投屏到局域网内的音箱、电视等播放设备",
  capabilities: ["renderer"],
  defaultEnabled: true,
  configSchema: [],
};

export const dlnaRendererPlugin: RendererPlugin = {
  manifest: dlnaRendererManifest,
  async discover() {
    return markStaleDevices(getCachedDevices()).map((d) => ({
      id: d.id,
      name: deviceDisplayName(d),
      type: "dlna",
      available: d.available,
      meta: {
        manufacturer: d.manufacturer,
        model: d.model,
        hasVolumeControl: !!d.renderingControlUrl,
        alias: d.alias || "",
      },
    }));
  },
  async cast(deviceId: string, songId: string) {
    const baseUrl = getEffectiveBaseUrl();
    if (!baseUrl) throw new Error("未确定 DLNA 流地址(请先进行一次投屏或设置 DLNA_BASE_URL)");
    const song: any = db.select().from(songs).where(eq(songs.id, songId)).get();
    if (!song) throw new Error("歌曲不存在");
    return castToDevice({
      deviceId,
      songId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime: DLNA_MIME[song.suffix || ""] || "audio/mpeg",
      baseUrl,
      coverArt: song.coverArt || undefined,
    });
  },
  async control(deviceId: string, action: string, payload?: any) {
    const { playDevice, pauseDevice, stopDevice, seekDevice, setDeviceVolume } = await import("../../../services/dlna/control.js");
    switch (action) {
      case "play": return playDevice(deviceId);
      case "pause": return pauseDevice(deviceId);
      case "stop": return stopDevice(deviceId);
      case "seek": return seekDevice(deviceId, payload?.seconds ?? 0);
      case "volume": return setDeviceVolume(deviceId, payload?.volume ?? 0);
      default: throw new Error(`不支持的渲染器操作: ${action}`);
    }
  },
};
