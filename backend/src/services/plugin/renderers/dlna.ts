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
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "DLNA Renderer",
      description:
        "Cast music via DLNA/UPnP to speakers, TVs and other playback devices on the LAN",
      documentation: `### Features
Casts music via DLNA/UPnP to speakers, TVs and other playback devices on the LAN.

### How it works
1. Enables the DLNA media server / renderer endpoints (\`/dlna\` etc.) so DLNA devices can discover MusicFlow as a renderer;
2. Cast requests (from the client / HA integration / queue) are forwarded to the selected DLNA device for playback;
3. Playback state (playing / paused / position / volume) is synced back to the server.

### Notes
- No configuration needed (empty \`configSchema\`), enabled by default;
- Devices appear in the client's cast list once they respond on the LAN.`,
    },
  },
  documentation: `### 功能介绍
通过 DLNA/UPnP 把音乐投屏到局域网内的音箱、电视、功放等播放设备（renderer 能力）。

### 处理逻辑
1. \`discoverRenderers()\` 通过 SSDP 多播在局域网发现 DLNA 设备，随设备上下线自动增删（Web/HA 里离线设备不显示，重上线自动找回）；
2. 投屏时 \`castToRenderer()\` 把音频流地址 + 曲目元数据用 SOAP 控制指令发给设备，由设备自行拉流播放；
3. \`controlRenderer()\` 转发播放 / 暂停 / 音量 / 进度等控制指令；
4. 后端持有每台设备的持久化队列（\`device_queues\`），后端重启或浏览器断开后设备仍可继续播放，重启后可恢复续播。

### 说明
- 需要 host 网络（SSDP 多播要求）；Docker Desktop（macOS/Windows）上多播不可用；
- 多网卡场景设备拉流地址探测错误时，在系统设置填 \`DLNA_BASE_URL\` 覆盖。`,
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
