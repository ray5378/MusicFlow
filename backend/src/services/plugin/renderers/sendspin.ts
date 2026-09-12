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
  // 默认关闭:Sendspin 服务端需要常驻监听 8927 端口 + mDNS 广播(CPU/端口开销),
  // 与 AirPlay 同样按需开启;关闭时零常驻资源。
  defaultEnabled: false,
  configSchema: [],
  i18n: {
    en: {
      name: "Sendspin Player",
      description:
        "Turn MusicFlow into a Sendspin Server so Sendspin clients (Xbox, Android speakers, ...) can play the library directly",
      documentation: `### Features
Makes MusicFlow a **Sendspin Server** (port 8927) that Sendspin clients — Xbox, Android cast speakers, etc. — discover over mDNS and connect to for multi-room synchronized playback.

### How it works
1. When enabled, starts the Sendspin WebSocket server (port 8927) and advertises it via mDNS as a \`sendspin-server\`;
2. Sendspin clients connect and pair (PSK / dynamic code / static code);
3. MusicFlow decodes tracks with ffmpeg → PCM and re-encodes for each client (opus / flac / pcm) with sample-accurate multi-room sync;
4. Playback state and group volume are managed per client group.

### Notes
- **Disabled by default**: the server holds a listening port + mDNS. Enable it in the plugin page;
- Clients must be paired before they can stream (three pairing methods supported).`,
    },
  },
  documentation: `### 功能介绍
把 MusicFlow 变成 **Sendspin 服务端**(端口 8927),让 Xbox、Android 音箱等 Sendspin 客户端通过 mDNS 发现并连接,直接播放曲库,支持多房同步。

### 处理逻辑
1. 启用后启动 Sendspin WebSocket 服务(端口 8927),并以 \`sendspin-server\` 类型经 mDNS 广播;
2. Sendspin 客户端连入并按三种配对方式之一完成配对(配对码 / 动态码 / 静态码);
3. 由系统 ffmpeg 解码任意音源 → PCM,再按每个客户端支持的格式独立编码(opus / flac / pcm),按组公共时钟做样本级多房同步;
4. 播放状态与组音量按客户端分组统一管理。

### 说明
- **默认关闭**:服务端常驻占用监听端口与 mDNS,与 AirPlay 一致按需开启,关闭时零常驻资源;
- 客户端需绑定配对才可拉流。`,
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