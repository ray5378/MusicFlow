// ==================== Core plugin: 搜索兜底(core-search-fallback) ====================
// 服务端内置行为插件(端侧零改动,可随时开关),config-only——与 core-stream-fallback 同模式:
// 兜底代码本身留在核心(services/source/online/searchFallback.ts),本插件只提供配置面:
//
// 解决的问题:换源兜底(play 链)只覆盖「原链失效」;**搜索层此前没有任何跨插件兜底** ——
//   POST /v1/online/:providerId/search 只调主插件一次,主插件软失败(空结果/报错)就返空,
//   明明别处还有启用着的源插件可用。本插件让「搜索回来是空的/报错」也能自动改用另一个
//   已启用、且声明了 search + stream 能力的源插件再试一次(排除本尊,避免自我重试)。
//
// 与「插件内音源轮切」(如 lx-source 的 withFallback)是**不同层**:插件内轮切是插件自己的
// 私有策略,本插件是核心统一兜底 —— 插件没轮切、插件整体不可用、插件只声明了单一上游服务
// (如 go-music-dl 的单服务聚合拓扑)时,这一层兜底仍然生效;插件层自己有轮切时两者叠加,
// 各管一段,不冲突。
import type { PluginManifest } from "../../../plugins/types.js";

export const SEARCH_FALLBACK_PLUGIN_ID = "core-search-fallback";

export const searchFallbackManifest: PluginManifest = {
  id: SEARCH_FALLBACK_PLUGIN_ID,
  name: "搜索兜底",
  version: "1.0.0",
  type: "core",
  description:
    "某个在线源插件搜索返回空或报错时,核心自动改用另一个已启用、且具备搜索与出链能力的源插件再试一次,并把「结果来自哪个插件 / 回退轨迹」回传前端。本插件提供兜底开关与预算/候选数,兜底逻辑本身在核心。",
  capabilities: ["searchFallback"],
  defaultEnabled: true,
  configSchema: [
    { key: "enabled", label: "搜索兜底", type: "switch", default: true, help: "开启后,搜索某插件返回空结果或报错时,自动改用其它已启用源插件再试(排除本尊)。关闭即退回「只调一次主插件」的原有行为" },
    { key: "maxCandidates", label: "最多改用几个插件", type: "number", default: 2, help: "主插件失败后最多再试几个其它源插件。范围 0-5,0 = 不兜底(等同关闭)。默认 2" },
    { key: "budgetMs", label: "兜底总预算(毫秒)", type: "number", default: 6000, help: "兜底尝试的总时间上限,超时即停手(已发出的尝试不中断),防慢源把搜索请求拖死。范围 500-60000,默认 6000" },
    { key: "fallbackOnEmpty", label: "空结果时兜底", type: "switch", default: true, help: "开启后,主插件搜索返回空结果(无歌曲)即改用其它插件再试;关闭后只有报错才兜底" },
    { key: "fallbackOnError", label: "报错时兜底", type: "switch", default: true, help: "开启后,主插件搜索抛错(网络异常/上游 5xx)即改用其它插件再试;关闭后报错直接返回错误" },
  ],
  i18n: {
    en: {
      name: "Search fallback",
      description:
        "When an online source plugin returns no results or fails, the core automatically retries with another enabled source plugin that can search and build stream URLs, and reports which plugin answered plus the fallback trace. This plugin provides the switch and the budget/candidate limits; the fallback logic itself lives in the core.",
      fields: {
        enabled: {
          label: "Search fallback",
          help: "When on, a search that returns nothing or fails on one plugin is retried on another enabled source plugin (the original one is never retried). When off, only the primary plugin is called.",
        },
        maxCandidates: {
          label: "Max plugins to try",
          help: "How many other source plugins to try after the primary fails. Range 0-5, 0 = no fallback (same as off). Default 2.",
        },
        budgetMs: {
          label: "Fallback budget (ms)",
          help: "Total time allowed for fallback attempts; it stops as soon as the budget is used up (in-flight attempts are not cancelled), so a slow source cannot hang a search. Range 500-60000, default 6000.",
        },
        fallbackOnEmpty: {
          label: "Fallback on empty result",
          help: "When on, an empty result from the primary plugin triggers a retry on another plugin; when off, only failures do.",
        },
        fallbackOnError: {
          label: "Fallback on error",
          help: "When on, an exception from the primary plugin (network error / upstream 5xx) triggers a retry on another plugin; when off, the error is returned as-is.",
        },
      },
    },
  },
  documentation: `### 搜索兜底(服务端内置)
某次搜索的主插件返回**空结果**或**抛错**时,核心自动改用另一个「已启用 + 声明了 search 与 stream 能力」的源插件再试(排除本尊,不自我重试),首个有结果的插件直接返回,并把「结果来自哪个插件」(fallbackFrom)与逐插件回退轨迹(trace)一起回传给前端。

- 开关「搜索兜底」可整体停用(退回只调一次主插件),另可按场景只关「空结果兜底」或只关「报错兜底」;
- 「最多改用几个插件」(默认 2)与「兜底总预算」(默认 6000ms)是双闸门:候选再多也最多试 N 个,预算耗尽即停手,避免慢源把搜索请求拖死;
- **报错不等于没源**:上游 5xx / 超时只做短期退避语义 —— 候选失败原因是网络/超时时不把它写成永久结论,仍会正常返回(搜索本身不做负缓存,下一次请求会重新尝试);
- 与换源兜底(core-stream-fallback)**并列**:一个是「搜索层换插件找结果」,一个是「播放层换替代源出链」,互不干扰,可各自开关。`,
};

export const searchFallbackPlugin = {
  // 纯配置插件:行为由 searchFallback.ts 实现,读取本插件配置。
  id: SEARCH_FALLBACK_PLUGIN_ID,
};
