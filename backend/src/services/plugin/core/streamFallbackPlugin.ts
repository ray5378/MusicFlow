// ==================== Core plugin: 换源兜底(core-stream-fallback) ====================
// 服务端内置行为插件(端侧零改动,可随时开关),config-only——与 core-import-gate 同模式:
// 兜底代码本身留在核心(services/source/online/streamFallback.ts,播放可靠性契约),
// 本插件只提供配置面:
// - enabled(默认开):换源兜底总开关。关闭后原链失效的歌不再搜索替代源(直接播放失败);
// - durationTolerance(默认 0 = 不覆写):兜底候选的时长容差覆写(秒)。0/空 = 沿用
//   core-import-gate 的时长容差;>0 时以本值为准(兜底比导入稍宽松的场景用,如现场版
//   时长略有出入)。专辑一致/歌手/标题维度始终沿用 core-import-gate 配置,不可放宽。
// 纯配置插件:无运行时 impl 行为。
import type { PluginManifest } from "../../../plugins/types.js";

export const STREAM_FALLBACK_PLUGIN_ID = "core-stream-fallback";

export const streamFallbackManifest: PluginManifest = {
  id: STREAM_FALLBACK_PLUGIN_ID,
  name: "换源兜底",
  version: "1.0.0",
  type: "core",
  description:
    "播放原链失效(403/404/5xx)时自动在其它平台搜索同名同歌手的替代源并换链播放;候选与导入同套门禁核实(标题+歌手+专辑+时长)。本插件提供兜底开关与时长容差覆写,兜底逻辑本身在核心。",
  capabilities: ["streamFallback"],
  defaultEnabled: true,
  configSchema: [
    { key: "enabled", label: "换源兜底", type: "switch", default: true, help: "开启后,播放时原链失效的歌曲自动搜索其它平台的替代源换链播放(候选过导入门禁)。关闭后原链失效即播放失败" },
    { key: "durationTolerance", label: "时长容差覆写(秒)", type: "number", default: 0, help: "兜底候选的时长差上限覆写(秒)。0 = 沿用「导入命中门禁」的时长容差;>0 时以本值为准(可比导入稍宽松)。标题/歌手/专辑维度始终与导入门禁一致,不可放宽" },
  ],
  i18n: {
    en: {
      name: "Stream Fallback",
      description:
        "When the original stream URL fails (403/404/5xx), automatically searches other platforms for an alternative of the same song and re-links it; candidates are verified by the same gate as imports (title + artist + album + duration). This plugin provides the fallback switch and a duration-tolerance override; the fallback logic itself lives in the core.",
      fields: {
        enabled: {
          label: "Stream fallback",
          help: "When on, songs whose original URL fails during playback are automatically re-linked to an alternative on another platform (candidates pass the import gate). When off, a failed original URL means playback failure.",
        },
        durationTolerance: {
          label: "Duration tolerance override (seconds)",
          help: "Overrides the maximum duration difference allowed for fallback candidates (seconds). 0 = use the Import Match Gate tolerance; >0 uses this value (may be looser than import). Title/artist/album always follow the import gate and cannot be relaxed.",
        },
      },
    },
  },
  documentation: `### 换源兜底(服务端内置)
播放链路(REST stream / DLNA / stream probe / 播放队列)探得 web 歌曲原链失效时,自动用该歌曲的源插件在其它平台搜索替代版本:候选必须通过与导入完全同套的门禁断言(v2.3.4 起)——规范化标题 + 歌手(强制)+ 专辑一致 + 时长容差,全命中且探测可播才换链,并把替代 URL 持久化写回 songs.url。

- 开关「换源兜底」可整体停用(原链失效即播放失败,不再搜索);
- 「时长容差覆写」>0 时替换导入门禁的时长容差(默认 0 = 沿用);标题/歌手/专辑不可放宽;
- 换源兜底是与导入并列的独立代码路径,门禁维度固化于核心,SPEC §1.6.2「换源兜底道」。`,
};

export const streamFallbackPlugin = {
  // 纯配置插件:行为由 streamFallback.ts 实现,读取本插件配置。
  id: STREAM_FALLBACK_PLUGIN_ID,
};
