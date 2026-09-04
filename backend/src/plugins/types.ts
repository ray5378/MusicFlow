// ==================== Unified Plugin Manifest Types ====================
//
// These types describe every plugin kind MusicFlow can load, not just the
// online "source" plugins. The core only ever reasons about capabilities
// (declared in the manifest) — it never references a concrete plugin by name.
//
// A plugin receives a `host` context (see host.ts) instead of importing the
// backend. Provider-style plugins (lyrics/cover/renderer/scrobbler) take that
// context as their first argument so they can log, read config, use storage,
// and talk to other plugins — all through the controlled surface.

import type { PluginHost } from "./host.js";

export type PluginType =
  | "source"      // online music source (search/stream/...)
  | "importer"    // playlist import (URL or file)
  | "recommender" // builds/refreshes recommendation playlists
  | "sync"        // re-syncs imported playlists
  | "lyrics"      // supplies lyrics (lyricProvider)
  | "cover"       // supplies cover art (coverProvider)
  | "renderer"    // casts audio to a device (DLNA / Chromecast / ...)
  | "scrobbler"   // reports plays to an external service (Last.fm / ListenBrainz)
  | "artist"      // fetches artist info (bio / avatar) from a data source
  | "core";       // 服务端内置行为插件(多源组 / 播放优选等,端侧零改动,可开关)

/** Optional abilities a plugin may declare. The core only calls the matching
 *  method when the capability is present. */
export type PluginCapability =
  // ---- source plugins ----
  | "search" // online search
  | "playlistSearch" // search remote playlists (aggregated across the plugin's platforms)
  | "songSearch" // search remote songs (aggregated across the plugin's platforms)
  | "artistSearch" // search remote artists
  | "albumSearch" // search remote albums
  | "recommend" // daily-recommend playlists
  | "playlistSongs" // fetch songs of a single remote playlist
  | "stream" // build an audio stream URL
  | "lyrics" // online lyrics (legacy: a source plugin that also serves lyrics)
  | "webRotation" // expire unreferenced web songs (daily-recommend rotation)
  // ---- importer plugins ----
  | "playlistImport" // parse a share URL -> remote playlist track list
  | "playlistFile" // parse an uploaded playlist file (native export, m3u, ...)
  // ---- recommender plugins ----
  | "dailyPlaylist" // build/refresh a scheduled recommendation playlist
  | "localPlaylist" // contribute local-library recommendations
  // 本地随机歌单(按平台分组):供首页「本地随机(按平台)」区块调 /v1/local-recommend
  // 动态展示本地库里各平台已入库歌单的随机刷新结果。独立于此前的 recommend(上游)。
  | "localPlatformRecommend"
  | "comboPlaylist" // merge other recommenders' playlists into a combined one
  | "recommendPlaylist" // 通用推荐歌单插件:生成/刷新自身歌单(第三方,如 ListenBrainz)
  // ---- sync plugins ----
  | "playlistSync" // re-fetch an imported playlist and rebuild its entries
  | "autoMatch" // match unmatched playlist entries against an online source
  // ---- cleanup plugins ----
  | "playlistCleanup" // 歌单清理:删除低歌曲数的歌单
  // ---- provider plugins ----
  | "lyricProvider" // supplies lyrics via searchLyrics()
  | "coverProvider" // supplies cover art via searchCover()
  | "renderer" // casts audio to a device via discover/cast/control
  | "scrobbler" // reports playback events via onPlay/onScrobble
  // ---- artist plugins ----
  | "artistInfo" // fetches artist bio/avatar via fetchArtistInfo()
  // ---- core plugins(服务端内置行为开关,端侧零改动) ----
  | "songGroup" // 同曲多源组:匹配/写入 group_id + 序列化输出 groupId/sources
  | "playPreference"; // 播放优选:首选 Local + local 失败回退平台

export interface ConfigField {
  key: string;
  label: string;
  // playlist-multi:参考歌单多选(本地 + 平台导入歌单,前端渲染为可搜索下拉多选)。
  // candidate-list:推荐榜单列表(每项 {platform,url,name}),前端渲染为可增删替换的编辑行。
  type: "text" | "url" | "number" | "select" | "multiselect" | "radio" | "switch" | "playlist-multi" | "candidate-list";
  required?: boolean;
  default?: unknown;
  options?: { label: string; value: string }[];
  help?: string;
  /** 配置分组标识,前端按此字段将配置项圈入带标题的功能模块框。如 "backend","recommend","keyword","frontend"。 */
  group?: string;
}

/** 插件配置字段的单语 i18n 文案(按字段 key 覆盖 manifest 默认文案)。 */
export interface PluginConfigFieldI18n {
  label?: string;
  help?: string;
  /** 选项文案:option value → 本地化 label。缺词时保留 manifest 默认。 */
  options?: Record<string, string>;
}

/** 插件单语 i18n 文案。 */
export interface PluginI18nText {
  name?: string;
  description?: string;
  /** 英文/多语 documentation(详情弹窗「处理逻辑」Markdown);缺省时回退 manifest.documentation。 */
  documentation?: string;
  platformLabels?: Record<string, string>;
  /** 配置分组 key → 标题(优先级高于核心内置分组文案;缺词时回退核心翻译/分组名)。 */
  groups?: Record<string, string>;
  /** 配置项 key → 文案。 */
  fields?: Record<string, PluginConfigFieldI18n>;
}

/** 插件 manifest 内联 i18n 字典(zh / en)。缺词(未声明语言或未声明某 key)自动回退
 *  manifest 默认文案;默认文案即为中文,故 zh 字典可省略、只补 en 即可。 */
export interface PluginI18n {
  zh?: PluginI18nText;
  en?: PluginI18nText;
}

export interface PluginManifest {
  id: string; // unique, e.g. "go-music-dl"
  name: string; // display name
  version: string;
  type: PluginType;
  description?: string;
  capabilities: PluginCapability[];
  /** Source plugins only: supported platform slugs (netease, qq, ...). */
  platforms?: string[];
  /** Source plugins only: 平台 slug → 展示名 映射(核心展示层读取,不写死平台词典)。
   *  如 { netease: "网易云", qq: "QQ 音乐" }。缺失时回退到 slug 本身。 */
  platformLabels?: Record<string, string>;
  /** Source plugins only: 流兜底搜索的源偏好顺序(数组,越靠前越优先)。
   *  缺失时按插件返回的原始顺序。 */
  sourcePreference?: string[];
  /** recommender 插件专用:每日推荐歌单的标识(TAG),OpenSubsonic 等据此识别
   *  「每日推荐」歌单(原核心直连 DAILY_TAG 常量,现已声明化)。 */
  dailyTag?: string;
  /** recommender 插件专用:该插件在首页展示时对应的固定歌单 id
   *  (如「今日漫游」= pl-daily-roam)。核心按 homePlaylistId 聚合首页固定卡,
   *  不写死任何歌单 id。 */
  homePlaylistId?: string;
  /** Source plugins only: prefix used to tag daily-recommend imported playlists. */
  recommendPrefix?: string;
  minAppVersion?: string;
  /** 方法级长耗时预算(毫秒):声明的方法在沙箱调用时使用该预算而非默认 15s。
   *  用于拉取平台/外网歌单等慢网络操作(如 go-music-dl 的 runDailyJob/playlistSongs)。
   *  上限 600000(10 分钟),未声明的方法一律维持 INVOKE_TIMEOUT_MS 看门狗。 */
  longRunning?: Record<string, number>;
  /** Declared permissions (see host.KNOWN_PERMISSIONS). Unknown perms are
   *  rejected at manifest-validation time. */
  permissions?: string[];
  /** Metadata (for the admin UI / marketplace). All optional. */
  author?: string;
  homepage?: string;
  license?: string;
  icon?: string; // URL or data-uri
  updateUrl?: string; // self-update source (zip or manifest URL)
  downloadUrl?: string; // canonical download location
  /** Markdown 文档:功能介绍 + 处理逻辑。内置插件随服务端编写;外置插件在
   *  plugin.json 里可选携带。前端插件详情页渲染(无则按能力自动生成说明)。 */
  documentation?: string;
  /** Whether the plugin is enabled the first time its row is seeded.
   *
   *  Source plugins default to OFF (they need a baseUrl before they do anything
   *  useful). Built-in importer/recommender/sync plugins default to ON, because
   *  they are the code paths that used to be hardcoded in the core — seeding
   *  them disabled would silently turn off playlist import / daily recommend. */
  defaultEnabled?: boolean;
  /** Importer plugins only: URL patterns this importer claims (documentation +
   *  admin UI hint; actual routing uses the impl's canHandle()). */
  urlPatterns?: string[];
  /** Drives the admin config form (no more hardcoded baseUrl/sources fields). */
  configSchema: ConfigField[];
  /** 插件侧 i18n 字典(zh/en):覆盖 name/description/platformLabels/groups 与
   *  configSchema 各字段的 label/help/options 文案。缺词回退默认(中文)文案。
   *  内置与 plugin.json 外置插件皆可声明;前端在渲染配置表单前按当前语言取用。 */
  i18n?: PluginI18n;
  /** 插件自身声明的定时任务能力(由插件 manifest / plugin.json 声明,宿主尊重)。
   *
   *  取值:
   *    - `true`:  声明全部参与 → configSchema 注入 scheduleEnabled + runOnBoot 两个开关;
   *    - `false`: 声明不参与 → 不注入任何开关,调度器也不门控此插件;
   *    - 对象:  按需逐项声明,只有显式标 `true` 的项才会出现在配置页:
   *         { scheduleEnabled: true }               → 只显示「参与每日定时同步」开关;
   *         { runOnBoot: true }                     → 只显示「容器启动时拉取一次」开关;
   *         { scheduleEnabled: true, runOnBoot: true } → 两项都显示;
   *    - 缺省:  宿主按 capabilities 自动推断(声明了 SCHEDULED_CAPS 里的能力就全部注入)。
   *
   *  外置插件在 plugin.json 里设 "schedules": true 即可主动让配置页出现定时开关,
   *  无需依赖宿主硬编码的能力清单;也可按需只开一项。 */
  schedules?: boolean | {
    /** 是否在配置页显示「参与每日定时同步」开关 */
    scheduleEnabled?: boolean;
    /** 是否在配置页显示「容器启动时拉取一次」开关 */
    runOnBoot?: boolean;
  };
}

// ==================== Capability-specific impl contracts ====================

/** A track parsed from a remote playlist (mirrors services/plugin/playlistImport). */
export interface ImportedTrackShape {
  externalId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

export interface ImportedPlaylistShape {
  name: string;
  platform: string;
  coverUrl?: string;
  tracks: ImportedTrackShape[];
}

/** Implemented by `importer` plugins that declare the "playlistImport" capability. */
export interface ImporterPlugin {
  manifest: PluginManifest;
  /** True if this importer recognizes the share URL. */
  canHandle(url: string): boolean;
  /** Fetch and parse the remote playlist. */
  fetchPlaylist(url: string): Promise<ImportedPlaylistShape>;
}

/** A remote playlist found via a source plugin's "playlistSearch" capability.
 *  Field shape mirrors the playlist cards produced by go-music-dl
 *  (/music/search?type=playlist and /music/recommend) with zero conversion. */
export interface RemotePlaylistShape {
  id: string;
  source: string; // platform slug (netease, qq, kugou, ...)
  name: string;
  creator?: string;
  cover?: string;
  trackCount?: number | string;
  link?: string;
}

/** Implemented by `source` plugins that declare "playlistSearch".
 *  Aggregated remote-playlist search across the plugin's supported platforms. */
export interface PlaylistSearchPlugin {
  manifest: PluginManifest;
  /** Search remote playlists. `sources` is the platform subset requested by
   *  the caller; empty/absent means search all declared platforms. */
  searchPlaylists(
    config: Record<string, unknown>,
    params: { query: string; sources?: string[] },
  ): Promise<{ playlists: RemotePlaylistShape[] }>;
}

/** A remote song found via a source plugin's "songSearch" capability.
 *  Field shape aligns with OnlineSongResult (services/source/online/types.ts)
 *  so search results can be imported into the library as playable web songs. */
export interface RemoteSongShape {
  id: string;
  source: string; // platform slug (netease, qq, kugou, ...)
  name: string;
  artist: string;
  album?: string;
  duration?: number; // seconds
  cover?: string;
  extra?: Record<string, string> | null;
}

/** A remote artist found via a source plugin's "artistSearch" capability. */
export interface RemoteArtistShape {
  id: string;
  source: string; // platform slug
  name: string;
  avatar?: string; // avatar / cover URL
  link?: string;
  albumCount?: number | string;
  songCount?: number | string;
}

/** A remote album found via a source plugin's "albumSearch" capability. */
export interface RemoteAlbumShape {
  id: string;
  source: string; // platform slug
  name: string;
  artist?: string;
  cover?: string;
  trackCount?: number | string;
  year?: number | string;
  link?: string;
}

/** Implemented by `source` plugins that declare "songSearch". */
export interface SongSearchPlugin {
  manifest: PluginManifest;
  searchSongs(
    config: Record<string, unknown>,
    params: { query: string; sources?: string[] },
  ): Promise<{ songs: RemoteSongShape[] }>;
}

/** Implemented by plugins that declare "artistSearch". */
export interface ArtistSearchPlugin {
  manifest: PluginManifest;
  searchArtists(
    config: Record<string, unknown>,
    params: { query: string; sources?: string[] },
  ): Promise<{ artists: RemoteArtistShape[] }>;
}

/** Implemented by plugins that declare "albumSearch". */
export interface AlbumSearchPlugin {
  manifest: PluginManifest;
  searchAlbums(
    config: Record<string, unknown>,
    params: { query: string; sources?: string[] },
  ): Promise<{ albums: RemoteAlbumShape[] }>;
}

/** Implemented by `importer` plugins that declare the "playlistFile" capability
 *  (parsing an uploaded playlist file rather than a share URL). */
export interface PlaylistFilePlugin {
  manifest: PluginManifest;
  /** True if this importer recognizes the parsed file payload. */
  canHandleFile(raw: unknown): boolean;
  /** Parse the payload into one or more playlists. */
  parseFile(raw: unknown): ImportedPlaylistShape[];
}

/** Implemented by `recommender` plugins that declare "dailyPlaylist". */
export interface RecommenderPlugin {
  manifest: PluginManifest;
  /** Build/refresh this recommender's playlist. Returns a short summary line
   *  for the scheduler log, or null when nothing was done. */
  runDailyJob(): Promise<string | null>;
  // ---- 可选:候选池/生成等参数化能力(路由经 registry 门面调用,核心不直连插件文件) ----
  loadCandidates?(): any[];
  saveCandidates?(candidates: any[]): void;
  pickDailyCandidate?(date?: Date): any;
  /** force=true 跳过当天幂等强制重建;seedSalt 混入随机种子,让同一天重跑内容不同。 */
  generateDailyPlaylist?(date?: Date, opts?: { force?: boolean; seedSalt?: number }): Promise<any>;
  isCandidateBlocked?(c: any): boolean;
  listRecommendPool?(): any[];
  addToRecommendPool?(sourceType: string, sourceId: string, sourceName: string, userId: string): boolean;
  removeFromRecommendPool?(sourceType: string, sourceId: string): boolean;
  isInRecommendPool?(sourceType: string, sourceId: string): boolean;
  /** 首页顶部「每日推荐 + 本地推荐 + 随机歌单」展示张数(由插件配置 homeCount 控制)。 */
  getHomeCount?(): number;
}

/** Implemented by `recommender` plugins that declare "comboPlaylist".
 *  Merges the playlists produced by other recommenders into one combined
 *  playlist (e.g. 今日漫游 = 每日推荐 + 本地推荐, deduped). */
export interface ComboPlaylistPlugin {
  manifest: PluginManifest;
  /** Rebuild the combined playlist from its source playlists. */
  runDailyJob(): Promise<string | null>;
  /** force=true 跳过当天幂等强制重建(供手动刷新)。 */
  generateComboPlaylist?(opts?: { force?: boolean }): Promise<any>;
}

/** Implemented by `sync` plugins that declare "playlistSync". Called by the
 *  maintenance loop; must never throw (return a summary or null instead). */
export interface SyncPlugin {
  manifest: PluginManifest;
  /** Re-sync everything this plugin owns. Returns a short summary line for the
   *  scheduler log, or null when nothing was done. */
  runSyncJob(): Promise<string | null>;
  // ---- 可选:参数化同步能力(路由经 registry 门面调用,核心不直连插件文件) ----
  syncPlaylist?(playlistId: string, opts?: any): Promise<any>;
  rebuildPlaylistEntries?(playlistId: string, imported: any, opts?: any): Promise<any>;
  refreshPlaylistCounts?(playlistId: string): void;
  exportPlaylistEntries?(playlistId: string): { name: string; tracks: any[] };
  checkImportCooldown?(userId: string, url: string): boolean;
}

/** Implemented by `recommender` plugins that declare "localPlaylist".
 *  Contributes a date-seeded set of local-library song ids to the daily mix. */
export interface LocalRecommendPlugin {
  manifest: PluginManifest;
  /** Return playable local song ids for today's daily playlist. */
  pickSongs(date?: Date): Promise<{ songIds: string[]; sourceUsers: number; fallback: boolean }>;
  /** 独立生成「每日推荐」歌单(本地口味)。返回一行摘要,或 null(未生成)。 */
  runDailyJob?(): Promise<string | null>;
  /** force=true 跳过当天幂等强制重建;seedSalt 混入随机种子(供手动刷新)。 */
  generateLocalDailyPlaylist?(date?: Date, opts?: { force?: boolean; seedSalt?: number }): Promise<any>;
}

/** Implemented by `lyrics` plugins that declare "lyricProvider".
 *  First-match-wins across all enabled lyric providers. */
export interface LyricProviderPlugin {
  manifest: PluginManifest;
  /** Return LRC/plain lyrics for a song, or null if this provider can't. */
  searchLyrics(host: PluginHost, song: LyricSongInput): Promise<{ lrc?: string; text?: string } | null>;
}

/** Implemented by `cover` plugins that declare "coverProvider".
 *  First-match-wins across all enabled cover providers. */
export interface CoverProviderPlugin {
  manifest: PluginManifest;
  /** Return a cover URL for a song, or null if this provider can't. */
  searchCover(host: PluginHost, song: LyricSongInput): Promise<{ url?: string } | null>;
}

/** A discovered / controllable playback device (renderer). */
export interface RendererDevice {
  id: string;
  name: string;
  type: string; // "dlna" | "chromecast" | ...
  available: boolean;
  /** Optional vendor metadata (manufacturer, model, volume support, ...). */
  meta?: Record<string, any>;
}

/** Implemented by `renderer` plugins that declare "renderer". */
export interface RendererPlugin {
  manifest: PluginManifest;
  /** Enumerate currently available devices. */
  discover(): Promise<RendererDevice[]>;
  /** Cast a song (by songId) to a device. Returns a session token/handle. */
  cast(deviceId: string, songId: string): Promise<{ mediaUri: string }>;
  /** Optional transport control (play/pause/stop/seek/volume/next/prev). */
  control?(deviceId: string, action: string, payload?: any): Promise<any>;
}

/** Implemented by `scrobbler` plugins that declare "scrobbler". */
export interface ScrobblerPlugin {
  manifest: PluginManifest;
  /** Called when a track starts playing. */
  onPlay?(host: PluginHost, event: ScrobbleEvent): Promise<void>;
  /** Called when a track has been played past the scrobble threshold. */
  onScrobble?(host: PluginHost, event: ScrobbleEvent): Promise<void>;
}

/** Playback event passed to scrobblers. */
export interface ScrobbleEvent {
  songId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  playedAt: string; // ISO timestamp
}

/** Minimal song shape the lyrics/cover subsystems need from a DB song row. */
export interface LyricSongInput {
  url?: string | null;
  duration?: number | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  source?: string | null;
  extra?: Record<string, any> | null;
}
