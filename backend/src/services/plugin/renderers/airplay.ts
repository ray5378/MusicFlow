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
  description: "通过 AirPlay (RAOP / AirPlay 2) 协议将音乐投放到局域网内的 AirPlay 音箱、电视等设备",
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
        "Cast music via AirPlay (RAOP / AirPlay 2) to AirPlay speakers, TVs and other devices on the LAN",
      documentation: `### Features
Casts music to AirPlay speakers, TVs and other devices on the LAN as a renderer.
- **AirPlay 1 (RAOP)**: plaintext RTSP signalling, RSA-OAEP key exchange, AES-CBC chunked audio; the server decodes any source with ffmpeg and re-encodes to raw ALAC at 44.1kHz.
- **AirPlay 2 (AP2)**: HAP pairing establishes a long-term key; encrypted RTSP signalling plus ALAC/ChaCha20 audio sent over RTP/UDP, 48kHz passthrough (no resampling).

### How it works
- \`discoverRenderers()\` discovers devices over mDNS: \`_raop._tcp\` provides the RAOP (AP1) instance; a device is only treated as AP2-capable when it also advertises \`_airplay._tcp\` and that record reports \`protovers >= 1.1\` (both services must be present plus the version gate — either check alone is fooled by older devices);
- On cast, \`castToRenderer()\` opens a session per member with that member's own protocol: paired AP2-capable devices use AP2 realtime, everything else falls back to AP1;
- \`controlRenderer()\` forwards play / pause / stop / volume / seek;
- Queue handling is shared with DLNA through the unified \`QueueController\` (persistent queue, auto-advance, resume after restart).

### Group playback
- Mixed groups (AirPlay + Sendspin) share a single content timeline: same song, same position, advanced by the group pump;
- Sample rate follows each member's protocol: AP1 members run at 44.1kHz (resampled), AP2 members get 48kHz passthrough;
- The protocol is chosen per member, not per group — one group may contain both AP1 and AP2 members;
- The AirPlay bridge is a passive consumer of the group pump's PCM: it only encrypts and delivers what the pump produces. It never picks tracks and never advances the queue.

### Latency compensation
- Each group has two independent offsets: \`airplay_delay_ms\` and \`sendspin_delay_ms\`;
- Same semantics on both sides: a positive value means that side plays later, a negative value means it plays earlier;
- Range +-30000ms in 10ms steps;
- Changing the AirPlay side rebuilds the group bridge (the anchor is fixed when the session is created), which means about 1-2 seconds of silence for that group's AirPlay members; the Sendspin side is a per-frame timestamp offset that takes effect in about 0.5-1 second without interrupting playback.

### AirPlay 2 support
- Paired AP2-capable devices use AP2 realtime at 48kHz;
- Unpaired devices automatically fall back to AirPlay 1 at 44.1kHz and still play fine;
- Unpaired devices do not appear in the selectable player list and cannot join a group — a half-usable device would only fail at cast time, so the choice is made up front;
- Pairing is a one-time step: open the device row on the groups / players page, press Pair and type the 4-digit PIN shown on the device screen. The credential is stored in the server-side device profile, so no PIN is needed afterwards;
- AP2 buffered mode (type 103 / PTP timing) is not implemented; such devices are used over AP1.

### Notes
- **Enabled by default**: AirPlay is one of the built-in casting paths, ready out of the box. Disable it on the plugin page and discovery / child process / device registration are all torn down — zero resident resources;
- Devices must support AirPlay 1 (RAOP, RTSP + RSA); most active speakers and soundbars do, but individual implementations differ — if something misbehaves, disable or delete the device on the groups page to isolate it;
- Tested devices are listed in the CHANGELOG; for AP2 it is worth running the latency calibration once, since decoder buffers differ between devices;
- Audio is decoded by the server's ffmpeg and re-encoded, so the device never needs to support the source format.`,
    },
  },
  documentation: `### 功能介绍
通过 AirPlay 把音乐投放到局域网内的 AirPlay 音箱、电视、回音壁等设备（renderer 能力）。
- **AirPlay 1 (RAOP)**:RTSP 明文信令 + RSA-OAEP 密钥交换 + AES-CBC 分块推送音频;由系统 ffmpeg 解码任意音源 → 实时 RAW-ALAC 编码,44.1kHz。
- **AirPlay 2 (AP2)**:HAP 配对建立长期密钥,**加密 RTSP** 信令 + ALAC/ChaCha20 加密音频经 **RTP/UDP** 直送,48kHz 直通(不重采样)。

### 处理逻辑
- \`discoverRenderers()\` 通过 mDNS 发现设备:\`_raop._tcp\` 给出 RAOP(AP1)实例;只有**同时**广播 \`_airplay._tcp\` 且该记录 \`protovers ≥ 1.1\` 才判定为 AP2 能力设备(两个服务同时在册 + 版本门槛,单看任一条都会被老设备骗过);
- 投屏时 \`castToRenderer()\` 按**每个成员各自的协议**建会话:已配对且支持 AP2 → AP2 realtime;其余一律回落 AP1;
- AP1:建立 RTSP 会话(RSA 密钥交换),把加密后的音频分块推给设备;AP2:用配对派生的密钥加密 RTSP 信令与音频包,经 RTP/UDP 发送;
- \`controlRenderer()\` 转发播放 / 暂停 / 停止 / 音量 / 进度 等控制指令;
- 与 DLNA 共用统一队列控制器(\`QueueController\`),支持持久化队列、自动切歌、重启恢复。

### 群组播放
- 混合组(AirPlay + Sendspin)共用**同一条内容时间线**:同一首歌、同一个播放位置,由组泵统一推进;
- 采样率按成员协议各自适配:**AP1 成员 44.1kHz**(经重采样),**AP2 成员 48kHz 直通**;
- 协议是**逐成员**选择的,不是组级设置 —— 同一个组里可以既有走 AP1 的成员,也有走 AP2 的成员;
- AirPlay 桥是组泵 PCM 的**旁路接收者**:只负责把组泵产出的 PCM 加密发给设备,**不参与选歌、不推进队列**;选什么歌、放到哪儿一律以组泵为准。

### 延迟补偿
- 每个组可分别设置 \`airplay_delay_ms\` 与 \`sendspin_delay_ms\`;
- 两侧语义一致:**正数 = 该侧更晚出声,负数 = 该侧更早出声**;
- 取值范围 ±30000ms,步进 10ms;
- 改 AirPlay 侧会**重建该组的桥**(锚点在会话建立时算死),表现为该组 AirPlay 成员约 **1~2 秒静音**;Sendspin 侧是帧级下发戳偏移,约 0.5~1 秒后生效,不中断播放。

### AirPlay 2 支持情况
- 已配对且支持 AP2 的设备走 **AP2 realtime(48kHz)**;
- 未配对的设备**自动回落 AirPlay 1**(44.1kHz),照常能放;
- 但**未配对的设备不会出现在可选播放器列表里,也不能加入群组** —— 半可用的设备只会在投屏那一刻才报错,不如在选择阶段就说清楚;
- 首次使用需在「群组 / 播放器」页对该设备点「配对」,输入**设备屏幕上显示的 4 位 PIN**;配对凭证保存在服务端设备档案里,之后免 PIN;
- **不支持 AP2 buffered 模式**(type 103 / PTP 时基):只实现 realtime,这类设备按 AirPlay 1 使用。

### 说明
- **默认开启**:AirPlay 是内建投屏主链路之一,开箱即用;在插件管理页停用后,发现 / 子进程 / 设备注册全部回收,零常驻资源;
- 设备需支持 AirPlay 1 (RAOP,RTSP + RSA);常见的有源音箱 / 回音壁基本都支持,个别实现存在差异,遇异常可在群组页先禁用 / 删除设备排查;
- 已测设备见 CHANGELOG;AP2 首次使用建议在群组页做一次延迟标定(各设备解码缓冲不一致);
- 音频由服务器端 ffmpeg 解码后转码(无需设备支持音源格式)。`,
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