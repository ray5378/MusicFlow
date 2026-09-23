// ==================== Sendspin renderer plugin ====================
//
// Wraps the Sendspin server (services/sendspin/*) as a `renderer` plugin so the
// core can treat Sendspin clients (Xbox / Android cast speakers etc.) as
// controllable playback devices. The heavy lifting — Noise KKpsk2 handshake,
// mDNS broadcast, push-stream engine, per-client opus/flac/pcm encoding, group
// volume distribution — lives in the sendspin package; this plugin is a thin,
// capability-shaped adapter matching the DLNA / AirPlay renderer plugin pattern.
//
// Sendspin is a server role: clients connect to MusicFlow and play back the
// library, so `cast()` is not normally used (clients drive playback after
// pairing). The discover/cast/control surface is still exposed for symmetry
// with the other renderers and for future controller-based explicit casting.

import type { RendererPlugin, PluginManifest } from "../../../plugins/types.js";
import {
  listSendspinPlayers,
  castSendspin,
  controlSendspin,
} from "../../../services/sendspin/control.js";

export const SENDSPIN_RENDERER_ID = "sendspin-renderer";

export const sendspinRendererManifest: PluginManifest = {
  id: SENDSPIN_RENDERER_ID,
  name: "Sendspin 播放器",
  version: "1.0.0",
  type: "renderer",
  description: "将 MusicFlow 作为 Sendspin Server,让 Xbox/Android 音箱等 Sendspin 客户端直接播放曲库",
  capabilities: ["renderer"],
  // 默认关闭:Sendspin 服务端需要常驻监听 38927 端口 + mDNS 广播(CPU/端口开销),
  // 与 AirPlay 同样按需开启;关闭时零常驻资源。
  defaultEnabled: false,
  configSchema: [
    {
      key: "port",
      label: "监听端口",
      type: "number",
      default: 38927,
      help: "Sendspin 服务端 WebSocket 监听端口(默认 38927,避开 Music Assistant 的 8927)。修改后自动重启服务生效,已连客户端会断开重连。",
    },
    {
      key: "allow_legacy_clients",
      label: "允许 legacy 明文客户端",
      type: "switch",
      default: true,
      help: "兼容前加密时代客户端(如 ESPHome/sendspin-cpp、aiosendspin<7):它们发明文 client/hello、无 Noise 加密。开启后这类设备可直连播(配对不可用,流量明文);关闭则仅合规加密客户端可连。对照 MA 的 allow_legacy_clients(默认开)。",
    },
    {
      key: "preferred_codec",
      label: "默认音频编码",
      type: "select",
      default: "pcm",
      options: [
        { label: "PCM(推荐,零延迟)", value: "pcm" },
        { label: "FLAC(省带宽)", value: "flac" },
      ],
      help: "推流优先使用的编码。PCM:服务端不编码、设备侧 memcpy 直接播,延迟最低、ESP32 实测零卡顿,代价是带宽约 1.5 Mbps/设备;FLAC:带宽仅约 1/3,但设备每 85ms 要解一个 4096 样本帧,低端 ESP32 可能失步卡顿。若所选编码设备不支持会自动退到另一种;切换后重新投一次歌曲生效(当前正在播的不中断)。",
    },
    {
      key: "auto_discover",
      label: "自动发现播放器",
      type: "switch",
      default: true,
      help: "浏览局域网 _sendspin._tcp,新设备出现即自动拨号接入(只发现、不自动播放)。关闭则只靠手工拨号与记忆重拨。",
    },
    {
      key: "stream_source",
      label: "流式解码(省内存)",
      type: "switch",
      default: true,
      help: "推流解码走滑动窗口:边解边播,子进程只驻留约 300 秒音频(~115MB,与 MA AudioBuffer BALANCED 对齐),与曲长无关。关闭后整曲一次解完进内存(320 秒约 122MB,切歌瞬间翻倍,超长单曲可能顶爆内存)。开启后下一首生效(正在播的不中断);seek 回跳超出窗口时会重建解码(约 1 秒空窗)。**默认开启**(3.0.36 灰度验证稳定后转正);如需排障可临时关闭。",
    },
    // ⚠️ 这里**没有** ESPHome(6053)的开关/密钥输入框,是刻意的 ——
    // ESPHome 每台设备的 api.encryption.key 是各自生成的,一把全局密钥只能连上
    // 一台;而且早期版本「测试连接」取的是「任意一台已连设备的 IP」,填 A 的密钥
    // 却拿 B 的门去试,必然 auth 失败。现改为**每台设备各自配置**:
    // 播放器页 Sendspin 设备行上填自己的密钥 + 测试连接 + 设备音量,
    // 存 sendspin_device_state(clientId → psk/port),见 services/sendspin/deviceState.ts。
  ],
  i18n: {
    en: {
      name: "Sendspin Player",
      description:
        "Turn MusicFlow into a Sendspin Server so Sendspin clients (Xbox, Android speakers, ...) can play the library directly",
      documentation: `### Features
Makes MusicFlow a **Sendspin Server** (port 38927) that Sendspin clients — Xbox, Android cast speakers, etc. — discover over mDNS and connect to for multi-room synchronized playback.

### How it works
1. When enabled, starts the Sendspin WebSocket server (port 38927) and advertises it via mDNS as a \`sendspin-server\`;
2. Sendspin clients connect and pair (PSK / dynamic code / static code);
3. MusicFlow decodes tracks with ffmpeg → PCM and re-encodes for each client (opus / flac / pcm) with sample-accurate multi-room sync;
4. Playback state and group volume are managed per client group.

### Notes
- **Disabled by default**: the server holds a listening port + mDNS. Enable it in the plugin page;
- Legacy (pre-encryption) clients such as ESPHome/sendspin-cpp are accepted by default (\`allow_legacy_clients\`, mirroring Music Assistant): they play as-is over cleartext, pairing is unavailable for them and LAN traffic can be intercepted;
- Encrypted spec-compliant clients stream after pairing (pairing flows landing progressively).`,
      fields: {
        preferred_codec: {
          label: "Default audio codec",
          help: "Preferred codec for streaming. PCM: no server-side encoding and a plain memcpy on the device — lowest latency, verified stutter-free on ESP32, costs ~1.5 Mbps per player. FLAC: ~1/3 the bandwidth, but the device must decode a 4096-sample frame every 85 ms, which can desync low-end ESP32 boards. Falls back to the other codec if the device does not support the selected one; takes effect on the next track you cast (the stream currently playing is untouched).",
          options: {
            pcm: "PCM (recommended, zero latency)",
            flac: "FLAC (saves bandwidth)",
          },
        },
        stream_source: {
          label: "Streaming decode (save memory)",
          help: "Decode while streaming through a sliding window: the child process only holds ~300s of audio (~115MB, matching MA's AudioBuffer BALANCED) regardless of track length. When off, each track is fully decoded into memory at once (~122MB for a 320s track, doubled briefly at track changes, and extra-long tracks may exhaust memory). Takes effect on the next track (the one currently playing is untouched); seeking back beyond the window rebuilds the decoder (~1s gap). On by default; turn it off only for troubleshooting.",
        },
      },
    },
  },
  documentation: `### 功能介绍
把 MusicFlow 变成 **Sendspin 服务端**(端口 38927),让 Xbox、Android 音箱等 Sendspin 客户端通过 mDNS 发现并连接,直接播放曲库,支持多房同步。

### 处理逻辑
1. 启用后启动 Sendspin WebSocket 服务(端口 38927),并以 \`sendspin-server\` 类型经 mDNS 广播;
2. Sendspin 客户端连入并按三种配对方式之一完成配对(配对码 / 动态码 / 静态码);
3. 由系统 ffmpeg 解码任意音源 → PCM,再按每个客户端支持的格式独立编码(opus / flac / pcm),按组公共时钟做样本级多房同步;
4. 播放状态与组音量按客户端分组统一管理。

### 说明
- **默认关闭**:服务端常驻占用监听端口与 mDNS,与 AirPlay 一致按需开启,关闭时零常驻资源;
- 前加密时代客户端(如 ESPHome/sendspin-cpp)默认允许直连(\`allow_legacy_clients\`,对齐 Music Assistant):明文播放,配对不可用,局域网流量可被截获;
- 合规加密客户端需配对后拉流(配对流程分批落地)。`,
};

export const sendspinRendererPlugin: RendererPlugin = {
  manifest: sendspinRendererManifest,
  async discover() {
    return listSendspinPlayers();
  },
  async cast(deviceId: string, songId: string) {
    return castSendspin(deviceId, songId);
  },
  async control(deviceId: string, action: string, payload?: unknown) {
    return controlSendspin(deviceId, action, payload);
  },
};