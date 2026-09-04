// ==================== Core plugin: 播放优选(play-preference) ====================
// 服务端内置行为插件(端侧零改动,可随时开关):
// - 开启:「首选 Local,失败回退平台」——web 歌曲组内有 local/WebDAV 主源时
//   自动切主源流播;主源(local/WebDAV)不可用时自动回退组内 web 源;
// - 关闭:按原源播放(不优选、不回退)。
// 同时作为 /v1/play(投屏/队列)与 /rest/stream(流播)两条路径的统一策略源。
import type { PluginManifest } from "../../../plugins/types.js";
import type { PluginHost } from "../../../plugins/host.js";
import { getPluginConfig, isCapabilityEnabled } from "../../../plugins/registry.js";

export const PLAY_PREFERENCE_PLUGIN_ID = "core-play-preference";

export const playPreferenceManifest: PluginManifest = {
  id: PLAY_PREFERENCE_PLUGIN_ID,
  name: "播放优选(首选Local)",
  version: "1.0.0",
  type: "core",
  description:
    "「首选 Local,失败回退平台」:多源组歌曲播放时自动选组内 local/WebDAV 核心曲库源(无损优先);核心曲库源不可用(文件缺失/WebDAV 拉不到)时自动回退组内平台源。关闭后按原源播放。",
  capabilities: ["playPreference"],
  defaultEnabled: true,
  configSchema: [
    { key: "preferLocal", label: "首选 Local", type: "switch", default: true, help: "web 歌曲所在组有 local/WebDAV 源时自动切主源流播" },
    { key: "fallbackToWeb", label: "Local 失败回退平台", type: "switch", default: true, help: "local/WebDAV 主源不可用(文件缺失等)时自动回退组内 web 源,保证可播" },
  ],
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Play Preference (prefer Local)",
      description:
        "When streaming a multi-source song group, auto-select the local/WebDAV source (lossless first); fall back to the platform source when the local source is unavailable. Disable to stream from the original source.",
      fields: {
        preferLocal: {
          label: "Prefer Local",
          help: "Automatically switch to the local/WebDAV source for streaming when the song's group has one",
        },
        fallbackToWeb: {
          label: "Fallback to platform on Local failure",
          help: "Automatically fall back to the group's web source when the local/WebDAV source is unavailable (e.g. missing file)",
        },
      },
    },
  },
  documentation: `### 播放优选(服务端内置)
多源组歌曲的播放策略,端侧零改动:

- **首选 Local**:web 歌曲所在组有 local / WebDAV 核心曲库源时,流播自动切换到核心曲库源(本地无损优先);
- **失败回退平台**:核心曲库源不可用(本地文件缺失 / WebDAV 拉取失败,失败记忆 5 分钟)时,自动回退组内平台(web)源,保证歌曲始终可播;
- 作用于 \`/rest/stream\`(客户端 / 媒体面板流播)与 \`/v1/play\`(HA 集成 / 投屏 / 队列)两条路径;
- 关闭后按原源播放(不优选、不回退)。`,
};

/** 是否应执行 web→local 优选(首选 Local)。 */
export function shouldPreferLocal(host: PluginHost): boolean {
  return host.config?.preferLocal !== false;
}

/** 是否应执行 local 不可用→web 回退。 */
export function shouldFallbackToWeb(host: PluginHost): boolean {
  return host.config?.fallbackToWeb !== false;
}

/** 插件总开关:播放优选是否启用(端侧零改动,流播/播放路径靠此门面读取)。 */
export function playPreferenceActive(): boolean {
  return isCapabilityEnabled("playPreference");
}

/** 无 host 快捷读取:web→local 优选子开关(默认开;插件未启用时返回 false)。 */
export function preferLocalEnabled(): boolean {
  const cfg = getPluginConfig(PLAY_PREFERENCE_PLUGIN_ID);
  return cfg ? cfg.preferLocal !== false : false;
}

/** 无 host 快捷读取:local 不可用→web 回退子开关(默认开;插件未启用时返回 false)。 */
export function fallbackToWebEnabled(): boolean {
  const cfg = getPluginConfig(PLAY_PREFERENCE_PLUGIN_ID);
  return cfg ? cfg.fallbackToWeb !== false : false;
}

export const playPreferencePlugin = {
  shouldPreferLocal,
  shouldFallbackToWeb,
};
