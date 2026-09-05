// ==================== 后端 i18n(中英双语,默认 zh-CN) ====================
//
// 语言通过请求头传递(前端在 API 请求上带 `Accept-Language` 或 `x-mf-lang`)。
// 每个请求进入时由入口中间件解析出语言并写入 AsyncLocalStorage,业务层可经
// getLocale() 在当前请求上下文内读到;apiError 等统一据此渲染错误文案。
//
// 约定:
//   - catalog key 用稳定英文点分名(如 "errors.forbidden.operation")。
//   - tools translate(key) : catalog 中存在该 key → 渲染成当前语言;不存在 → 原样返回。
//     这样"已迁移"的错误走翻译,"未迁移"的历史中文 message 仍可原样透传(zho 正确),
//     后端可渐进式迁移而不破坏兼容。
import { AsyncLocalStorage } from "node:async_hooks";

export type BackendLocale = "zh-CN" | "en-US";
export const DEFAULT_LOCALE: BackendLocale = "zh-CN";
const SUPPORTED = new Set<BackendLocale>(["zh-CN", "en-US"]);

type Catalog = Record<string, string>;
const CATALOG: Record<BackendLocale, Catalog> = {
  "zh-CN": {
    "errors.forbidden.operation": "无权执行该操作",
    "errors.forbidden.renderer": "无权控制该播放器",
    "errors.flow.notFound": "音流不存在",
    "errors.flow.disabled": "该音流已停用",
    "errors.flow.tokenMismatch": "该渠道 token 与音流不匹配",
    "errors.token.required": "缺少 token 参数",
    "errors.token.invalid": "无效的 token",
    "errors.token.disabled": "该渠道 token 已停用",

    "errors.auth.notLoggedIn": "未登录",
    "errors.user.notFound": "用户不存在",
    "errors.user.changePasswordForbidden": "无权修改该用户密码",
    "errors.user.changeNameForbidden": "无权修改该用户名",
    "errors.apikey.viewForbidden": "无权查看该用户的 API Key",
    "errors.apikey.issueForbidden": "无权签发该用户的 API Key",
    "errors.apikey.revokeForbidden": "无权撤销该用户的 API Key",

    "errors.playlist.notFound": "歌单不存在",
    "errors.playlist.modifyForbidden": "无权修改该歌单",
    "errors.playlist.syncForbidden": "无权同步该歌单",
    "errors.playlist.syncNotEnabled": "歌单同步插件未启用",
    "errors.playlist.alreadyLocal": "该歌单已是本地歌单,无需转换",
    "errors.playlist.importDup": "相同歌单刚导入过,请稍候再试",
    "errors.playlist.linkOrFileRequired": "请输入歌单链接或选择歌单文件",
    "errors.playlist.idRequired": "缺少歌单 id",
    "errors.playlist.refRequired": "缺少歌单 source/id",

    "errors.renderer.operationForbidden": "无权操作该播放器",
    "errors.renderer.controlForbidden": "无权控制该播放器",
    "errors.airplay.disabled": "AirPlay 播放器已关闭(插件管理页开启后可用)",

    "errors.source.notFound": "媒体源不存在",
    "errors.source.disabled": "媒体源已禁用",
    "errors.source.unsupportedType": "不支持的媒体源类型",
    "errors.source.connectFailed": "连接失败",
    "errors.scanner.busy": "扫描正在进行中",
    "errors.scanner.notRunning": "没有正在运行的扫描",
    "errors.scanner.failed": "扫描失败",
    "errors.discovery.deviceFailed": "发现设备失败",
    "errors.scraper.busy": "刮削正在进行中",
    "errors.scraper.failed": "刮削失败",

    "errors.artist.notFound": "未找到歌手信息(QQ 和网易云均无结果)",
    "errors.artist.nameRequired": "缺少艺术家名称",

    "errors.plugin.notFound": "插件不存在",
    "errors.plugin.idRequired": "缺少插件 id",
    "errors.plugin.noTask": "该插件尚无任务记录",
    "errors.plugin.noRefresh": "该插件不支持手动刷新(无推荐歌单能力)",
    "errors.plugin.notEnabled": "插件未启用",
    "errors.plugin.noDailyJob": "插件未实现 runDailyJob",
    "errors.plugin.songIdsRequired": "缺少 songIds",
    "errors.plugin.noAlbumPlaylistSongs": "插件缺少 playlistSongs 能力(无法拉取专辑歌曲)",
    "errors.plugin.noPlaylistSongs": "插件缺少 playlistSongs 能力(无法拉取歌单歌曲)",
    "errors.plugin.noSongSearch": "插件缺少 songSearch 能力(无法拉取歌手歌曲)",
    "errors.plugin.fetchFailed": "拉取失败",

    "errors.plugin.registryFetchFailed": "拉取插件市场失败",
    "errors.plugin.addFailed": "添加失败",
    "errors.plugin.installFailed": "安装失败",

    "errors.task.notFound": "任务不存在",
    "errors.task.startFailed": "任务启动失败",
    "errors.task.jobIdRequired": "缺少 jobId",
    "errors.task.batchIdRequired": "缺少 batchId",

    "errors.online.providerIdRequired": "缺少在线源 id",
    "errors.online.unknownProvider": "未知的在线源: {providerId}",
    "errors.online.notConfigured": "在线源未启用或未配置",
    "errors.online.matchFailed": "匹配失败",
    "errors.online.entryIdRequired": "缺少条目 id",
    "errors.online.entryNotFound": "条目不存在",
    "errors.online.noRecommend": "在线源不支持推荐歌单",
    "errors.online.fetchRecommendFailed": "获取推荐歌单失败",
    "errors.online.recommendRefRequired": "缺少推荐歌单 source/id",
    "errors.online.importRecommendFailed": "导入推荐歌单失败",
    "errors.online.syncBusy": "同步任务进行中,请稍候",
    "errors.online.noSyncRecord": "尚无同步记录",
    "errors.online.purgeFailed": "清理失败",

    "errors.search.queryRequired": "请输入搜索关键词",
    "errors.search.failed": "搜索失败",
    "errors.search.queryFailed": "查询失败",
    "errors.search.noPlugin": "未找到已启用的搜索插件",
    "errors.search.noPlaylistPlugin": "未找到已启用的歌单搜索插件",
    "errors.search.songsRequired": "缺少 songs 列表",
    "errors.album.refRequired": "缺少专辑 source/id",

    "errors.import.noSongs": "没有可导入的歌曲",
    "errors.import.failed": "导入失败",
    "errors.common.paramsRequired": "缺少参数",

    "errors.cast.screenFailed": "投屏失败",
    "errors.cast.preloadFailed": "预加载失败",
    "errors.cast.airplayFailed": "投放失败",
    "errors.group.muteUnsupported": "组内设备均不支持静音",
    "errors.group.createFailed": "创建组失败",
    "errors.group.updateFailed": "更新组失败",
    "errors.player.playFailed": "播放失败",
    "errors.recommend.genFailed": "每日推荐生成失败",

    "errors.common.proxyFormat": "代理地址格式应为 http://ip:port、https://ip:port 或 socks5://ip:port",
    "errors.common.paceFormat": "档位必须为 slow | standard | full",
    "errors.common.builtinPluginProtected": "内置核心插件不可删除",
    "errors.common.registryUrlRequired": "需要 registry URL",
    "errors.common.downloadUrlRequired": "需要 downloadUrl",
    "errors.common.timeHHMM": "time 必须是 HH:MM 格式(如 03:30)",
    "errors.common.hourRange": "hour 必须是 0-23 的整数",
    "errors.common.candidatesArray": "candidates 必须是数组",
    "errors.common.candidatesEmpty": "候选池不能为空,且每项需要 platform + url",
    "errors.common.dailyRecommendDisabled": "每日推荐插件未启用",
    "errors.common.localRecommendDisabled": "本地推荐插件未启用",
    "errors.common.roamRecommendDisabled": "今日漫游插件未启用",
    "errors.common.nameTooLong": "名称不能超过 50 字符",
    "errors.common.urlRequired": "需要 url",
    "errors.common.needPeerTypeId": "需要 peerId / type / id",

    "errors.source.pathMissing": "路径 {path} 不存在",

    "errors.song.notFound": "歌曲不存在",

    "errors.renderer.invalidPeerId": "无效的 peerId",
    "errors.renderer.castPeerOnly": "该操作仅对投屏/群组设备生效",
    "errors.renderer.invalidDuration": "无效的定时时长",
    "errors.renderer.needsSecondsOrPosition": "需要 seconds 或 position",
    "errors.renderer.needsVolume": "需要 volume",
    "errors.renderer.needsMuted": "需要 muted(boolean)",
    "errors.renderer.needsItemsArray": "需要 items 数组",
    "errors.renderer.needsSongIdAndDeviceId": "需要 songId 和 deviceId",
    "errors.renderer.invalidIndex": "无效的 index",
    "errors.renderer.invalidMode": "无效的 mode",
    "errors.renderer.deviceNotFound": "设备不存在",
    "errors.renderer.deviceDisabled": "设备已禁用",
    "errors.renderer.songIdRequired": "需要 songId",
    "errors.renderer.peerIdRequired": "缺少 peerId",
    "errors.renderer.needIntegerIndex": "需要整数 index",
    "errors.renderer.needIntegerFromTo": "需要整数 from/to",
    "errors.renderer.needIndex": "需要 index",
    "errors.renderer.localPeerOnly": "仅 local peer 支持",
    "errors.renderer.announcing": "该播放器正在播报中",
    "errors.renderer.invalidTypeId": "无效的 {type} id",
    "errors.renderer.noPlayableSongs": "「{name}」没有可播放的歌曲",

    "errors.group.notFound": "组不存在",
    "errors.group.notFoundOrNoPerm": "组不存在或无权限",
    "errors.group.empty": "组内无成员",

    "errors.flow.notExist": "流程不存在",
    "errors.flow.nameRequired": "需要 name",
    "errors.flow.disabledFlow": "流程已停用",
    "errors.flow.tokenNotFound": "指定的渠道 token 不存在",
    "errors.flow.tokenOwnership": "只能绑定属于自己的渠道 token",

    "errors.token.notExist": "token 不存在",

    "errors.user.passwordEmpty": "新密码不能为空",
    "errors.user.nameEmpty": "用户名不能为空",
    "errors.user.nameTaken": "用户名已被占用",
    "errors.user.selfDelete": "不能删除当前登录账号",
    "errors.user.exportForbidden": "无权导出该歌单",
    "errors.user.deleteForbidden": "无权删除该歌单",

    "errors.playlist.fixedNotDeleteable": "固定推荐歌单(今日/本地/漫游)由插件每日重建,不可删除",
  },
  "en-US": {
    "errors.forbidden.operation": "Operation not permitted",
    "errors.forbidden.renderer": "Not authorized to control this player",
    "errors.flow.notFound": "Flow not found",
    "errors.flow.disabled": "This flow is disabled",
    "errors.flow.tokenMismatch": "The channel token does not match this flow",
    "errors.token.required": "Missing token parameter",
    "errors.token.invalid": "Invalid token",
    "errors.token.disabled": "This channel token is disabled",

    "errors.auth.notLoggedIn": "Not logged in",
    "errors.user.notFound": "User not found",
    "errors.user.changePasswordForbidden": "Not allowed to change this user's password",
    "errors.user.changeNameForbidden": "Not allowed to change this user's name",
    "errors.apikey.viewForbidden": "Not allowed to view this user's API keys",
    "errors.apikey.issueForbidden": "Not allowed to issue an API key for this user",
    "errors.apikey.revokeForbidden": "Not allowed to revoke this user's API key",

    "errors.playlist.notFound": "Playlist not found",
    "errors.playlist.modifyForbidden": "Not allowed to modify this playlist",
    "errors.playlist.syncForbidden": "Not allowed to sync this playlist",
    "errors.playlist.syncNotEnabled": "Playlist sync plugin is not enabled",
    "errors.playlist.alreadyLocal": "This playlist is already local; nothing to convert",
    "errors.playlist.importDup": "This playlist was just imported; please try again later",
    "errors.playlist.linkOrFileRequired": "Please provide a playlist link or choose a playlist file",
    "errors.playlist.idRequired": "Missing playlist id",
    "errors.playlist.refRequired": "Missing playlist source/id",

    "errors.renderer.operationForbidden": "Not allowed to operate this player",
    "errors.renderer.controlForbidden": "Not allowed to control this player",
    "errors.airplay.disabled": "AirPlay player is disabled (enable it from the plugin management page)",

    "errors.source.notFound": "Media source not found",
    "errors.source.disabled": "Media source is disabled",
    "errors.source.unsupportedType": "Unsupported media source type",
    "errors.source.connectFailed": "Connection failed",
    "errors.scanner.busy": "A scan is already running",
    "errors.scanner.notRunning": "No scan is currently running",
    "errors.scanner.failed": "Scan failed",
    "errors.discovery.deviceFailed": "Device discovery failed",
    "errors.scraper.busy": "A scrape is already in progress",
    "errors.scraper.failed": "Scrape failed",

    "errors.artist.notFound": "No artist info found (no result from any online source)",
    "errors.artist.nameRequired": "Artist name required",

    "errors.plugin.notFound": "Plugin not found",
    "errors.plugin.idRequired": "Missing plugin id",
    "errors.plugin.noTask": "No task record for this plugin",
    "errors.plugin.noRefresh": "This plugin does not support manual refresh (no playlist recommendation capability)",
    "errors.plugin.notEnabled": "Plugin is not enabled",
    "errors.plugin.noDailyJob": "Plugin has not implemented runDailyJob",
    "errors.plugin.songIdsRequired": "Missing songIds",
    "errors.plugin.noAlbumPlaylistSongs": "Plugin lacks the playlistSongs capability (cannot fetch album songs)",
    "errors.plugin.noPlaylistSongs": "Plugin lacks the playlistSongs capability (cannot fetch playlist songs)",
    "errors.plugin.noSongSearch": "Plugin lacks the songSearch capability (cannot fetch artist songs)",
    "errors.plugin.fetchFailed": "Fetch failed",
    "errors.plugin.registryFetchFailed": "Failed to fetch plugin marketplace",
    "errors.plugin.addFailed": "Add failed",
    "errors.plugin.installFailed": "Install failed",

    "errors.task.notFound": "Task not found",
    "errors.task.startFailed": "Failed to start task",
    "errors.task.jobIdRequired": "Missing jobId",
    "errors.task.batchIdRequired": "Missing batchId",

    "errors.online.providerIdRequired": "Missing online source id",
    "errors.online.unknownProvider": "Unknown online source: {providerId}",
    "errors.online.notConfigured": "Online source is not enabled or configured",
    "errors.online.matchFailed": "Match failed",
    "errors.online.entryIdRequired": "Missing entry id",
    "errors.online.entryNotFound": "Entry not found",
    "errors.online.noRecommend": "Online source does not support recommended playlists",
    "errors.online.fetchRecommendFailed": "Failed to fetch recommended playlists",
    "errors.online.recommendRefRequired": "Missing recommended playlist source/id",
    "errors.online.importRecommendFailed": "Failed to import recommended playlist",
    "errors.online.syncBusy": "A sync task is already running; please wait",
    "errors.online.noSyncRecord": "No sync record yet",
    "errors.online.purgeFailed": "Cleanup failed",

    "errors.search.queryRequired": "Please enter a search keyword",
    "errors.search.failed": "Search failed",
    "errors.search.queryFailed": "Query failed",
    "errors.search.noPlugin": "No enabled search plugin found",
    "errors.search.noPlaylistPlugin": "No enabled playlist search plugin found",
    "errors.search.songsRequired": "Missing songs list",
    "errors.album.refRequired": "Missing album source/id",

    "errors.import.noSongs": "No songs available to import",
    "errors.import.failed": "Import failed",
    "errors.common.paramsRequired": "Missing parameters",
    "errors.cast.screenFailed": "Cast failed",
    "errors.cast.preloadFailed": "Preload failed",
    "errors.cast.airplayFailed": "AirPlay cast failed",
    "errors.group.muteUnsupported": "No device in the group supports mute",
    "errors.group.createFailed": "Failed to create group",
    "errors.group.updateFailed": "Failed to update group",
    "errors.player.playFailed": "Playback failed",
    "errors.recommend.genFailed": "Failed to generate daily recommendation",

    // ======== i18n keys migrated via apiError in routes/api/index.ts ========
    "errors.common.proxyFormat": "Proxy address must be http://ip:port, https://ip:port, or socks5://ip:port",
    "errors.common.paceFormat": "Pace must be slow | standard | full",
    "errors.common.builtinPluginProtected": "Built-in core plugins cannot be deleted",
    "errors.common.registryUrlRequired": "Registry URL is required",
    "errors.common.downloadUrlRequired": "downloadUrl is required",
    "errors.common.timeHHMM": "time must be in HH:MM format (e.g. 03:30)",
    "errors.common.hourRange": "hour must be an integer from 0 to 23",
    "errors.common.candidatesArray": "candidates must be an array",
    "errors.common.candidatesEmpty": "Candidate pool cannot be empty, and each item needs platform + url",
    "errors.common.dailyRecommendDisabled": "Daily recommendation plugin is not enabled",
    "errors.common.localRecommendDisabled": "Local recommendation plugin is not enabled",
    "errors.common.roamRecommendDisabled": "Today's roam recommendation plugin is not enabled",
    "errors.common.nameTooLong": "Name must not exceed 50 characters",
    "errors.common.urlRequired": "Need url",
    "errors.common.needPeerTypeId": "Need peerId / type / id",

    "errors.source.pathMissing": "Path {path} does not exist",

    "errors.song.notFound": "Song not found",

    "errors.renderer.invalidPeerId": "Invalid peerId",
    "errors.renderer.castPeerOnly": "This operation only applies to cast/group devices",
    "errors.renderer.invalidDuration": "Invalid sleep timer duration",
    "errors.renderer.needsSecondsOrPosition": "Need seconds or position",
    "errors.renderer.needsVolume": "Need volume",
    "errors.renderer.needsMuted": "Need muted (boolean)",
    "errors.renderer.needsItemsArray": "Need an items array",
    "errors.renderer.needsSongIdAndDeviceId": "Need songId and deviceId",
    "errors.renderer.invalidIndex": "Invalid index",
    "errors.renderer.invalidMode": "Invalid mode",
    "errors.renderer.deviceNotFound": "Device not found",
    "errors.renderer.deviceDisabled": "Device is disabled",
    "errors.renderer.songIdRequired": "Need songId",
    "errors.renderer.peerIdRequired": "Missing peerId",
    "errors.renderer.needIntegerIndex": "Need an integer index",
    "errors.renderer.needIntegerFromTo": "Need integer from/to",
    "errors.renderer.needIndex": "Need index",
    "errors.renderer.localPeerOnly": "Only local peers are supported",
    "errors.renderer.announcing": "This player is currently announcing",
    "errors.renderer.invalidTypeId": "Invalid {type} id",
    "errors.renderer.noPlayableSongs": "{name} has no playable songs",

    "errors.group.notFound": "Group not found",
    "errors.group.notFoundOrNoPerm": "Group not found or no permission",
    "errors.group.empty": "Group has no members",

    "errors.flow.notExist": "Flow does not exist",
    "errors.flow.nameRequired": "Need name",
    "errors.flow.disabledFlow": "Flow is disabled",
    "errors.flow.tokenNotFound": "The specified channel token does not exist",
    "errors.flow.tokenOwnership": "You can only bind your own channel token",

    "errors.token.notExist": "Token does not exist",

    "errors.user.passwordEmpty": "The new password must not be empty",
    "errors.user.nameEmpty": "The username must not be empty",
    "errors.user.nameTaken": "Username already taken",
    "errors.user.selfDelete": "Cannot delete the current logged-in account",
    "errors.user.exportForbidden": "Not allowed to export this playlist",
    "errors.user.deleteForbidden": "Not allowed to delete this playlist",

    "errors.playlist.fixedNotDeleteable": "Fixed recommendation playlists (today/local/roam) are rebuilt daily by plugins and cannot be deleted",
  },
};

const localeStore = new AsyncLocalStorage<string>();

/** 把请求封装进某语言上下文(入口中间件调用)。 */
export function runWithLocale<T>(locale: BackendLocale, fn: () => T): T {
  return localeStore.run(locale, fn);
}

/** 当前请求语言(中间件设置的 context;默认 zh-CN)。 */
export function getLocale(): BackendLocale {
  const v = localeStore.getStore();
  return v && (SUPPORTED as Set<string>).has(v) ? (v as BackendLocale) : DEFAULT_LOCALE;
}

/** 从请求头解析语言:仅识别 en*,其余(含缺失/zh)一律 zh-CN。 */
export function parseLocale(header?: string): BackendLocale {
  if (!header) return DEFAULT_LOCALE;
  const first = String(header).split(",")[0]?.trim().toLowerCase() ?? "";
  if (first === "en" || first === "en-us" || first.startsWith("en-")) return "en-US";
  return DEFAULT_LOCALE;
}

/** 翻译器:key 命中 catalog → 渲染(可选 {占位符} 替换);未命中 → 原样返回 key。 */
export function translate(key: string, params?: Record<string, string | number>): string {
  const dict = CATALOG[getLocale()] ?? CATALOG[DEFAULT_LOCALE];
  let tmpl = dict[key];
  if (tmpl === undefined) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      tmpl = tmpl.replaceAll(`{${k}}`, String(v));
    }
  }
  return tmpl;
}