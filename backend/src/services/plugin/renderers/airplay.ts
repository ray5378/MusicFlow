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
  version: "1.0.1",
  type: "renderer",
  description: "把音乐投放到局域网内的 AirPlay 音箱、电视等设备，支持 AirPlay 1（RAOP）与 AirPlay 2",
  capabilities: ["renderer"],
  // 默认开启(2026-10-21 用户拍板):AirPlay 是内建投屏主链路之一,开箱即用。
  // 关闭仍可在插件管理页操作:停用后 discovery / 子进程 / 设备注册全部回收,
  // 零常驻资源(与「默认关闭」时期的资源语义完全一致,只是初始值反过来)。
  defaultEnabled: true,
  configSchema: [],
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "AirPlay Renderer",
      description:
        "Cast music to AirPlay speakers, TVs and other devices on the LAN (AirPlay 1 RAOP and AirPlay 2)",
      documentation: `### Features
Casts music to AirPlay devices on the LAN (speakers, TVs, soundbars, Apple TV etc. — renderer capability). **Both AirPlay 1 (RAOP) and AirPlay 2 devices are supported**: mDNS listens on both \`_raop._tcp\` and \`_airplay._tcp\` and routes automatically by the capabilities each device reports. Audio is decoded by server-side ffmpeg and streamed in real time (RAW-ALAC) — the device does not need to support the source format.

### Transport
- Default engine is the built-in cliairplay runner (cli channel): AP2 devices pick the protocol automatically, AP1 devices use raop mode. Unicast and multicast links share one parameter assembly; multicast is used for multi-device synced playback from a single source.
- The self-implemented RAOP stack (RTSP + RSA-OAEP + AES-CBC) serves as the fallback channel and takes over automatically when the engine is unavailable.

### How it works
1. \`discoverRenderers()\` discovers AirPlay devices via mDNS, adding/removing them as they come and go, and merges \`_airplay._tcp\` records to flag AirPlay 2 capability;
2. Casting starts the session and streams audio with **start-at-position**: when starting with progress or transferring between devices, the start offset is encoded into that same session, so the reported position and resume point stay correct;
3. \`controlRenderer()\` forwards play / pause / stop / volume / mute / position / seek;
4. Shares the unified QueueController with DLNA / Sendspin: persistent queue, auto-advance, restart recovery and cross-device transfer.

### Notes
- Devices must be reachable via mDNS; a few implementations differ (command pipe without a read end, restricted reverse channel) — the link retries or falls back to the RAOP channel automatically. If something misbehaves, disable/remove the device on the Groups page to troubleshoot;
- **Enabled by default** (one of the built-in casting paths, ready out of the box): you can disable it on this page; discovery / child process / device registration all stop when disabled — zero resident resources.`,
    },
  },
  documentation: `### 功能介绍
把音乐投放到局域网内的 AirPlay 设备（音箱、电视、回音壁、Apple TV 等，renderer 能力）。**同时支持 AirPlay 1（RAOP）与 AirPlay 2 设备**：mDNS 同时监听 \`_raop._tcp\` 与 \`_airplay._tcp\`，按设备上报的能力自动路由。音频由服务器端 ffmpeg 解码后实时转码推流（RAW-ALAC），无需设备支持音源格式。

### 传输通道
- 默认走内置 cliairplay 引擎（cli 通道）：AP2 设备自动选择协议，AP1 设备走 raop 模式。单播与组播两条链路共用同一套参数装配，组播用于多设备同源同步播放。
- 自研 RAOP 实现（RTSP + RSA-OAEP + AES-CBC 分块推送）作为兜底通道，引擎不可用时自动接管。

### 处理逻辑
1. \`discoverRenderers()\` 通过 mDNS 在局域网发现 AirPlay 设备,随设备上下线自动增删,并合并 \`_airplay._tcp\` 记录标记 AirPlay 2 能力;
2. 投屏时建立会话并推流,支持**起播即落位**——带进度起播 / 跨设备流转时,起点编进同一次会话,进度条与续播位置不丢;
3. \`controlRenderer()\` 转发播放 / 暂停 / 停止 / 音量 / 静音 / 进度 / seek 指令;
4. 与 DLNA / Sendspin 共用统一队列控制器(\`QueueController\`),支持持久化队列、自动切歌、重启恢复与跨设备流转。

### 说明
- 设备需 mDNS 可达;个别实现存在差异(如命令管道无读端、反向通道受限),链路会自动重试或回退兜底通道,如遇异常可在群组页先禁用/删除设备排查;
- **默认开启**(内建投屏主链路之一,开箱即用):可在本页停用;停用后 discovery / 子进程 / 设备注册全部回收,零常驻资源。`,
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
        // E2:能力分级。**只上报能力,不改投屏路径** —— E3~E5 的 AP2 发送端落地前,
        // 所有设备仍走 AP1(见 cast() 的调用点未变)。
        supportsAp2: d.supportsAp2,
        ap2Protovers: d.ap2?.protovers,
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