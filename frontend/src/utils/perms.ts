// 前端权限常量(与后端 services/access.ts 的 PERM 一一对应)。
// 后端为最终仲裁,这里只用于菜单 / 路由 / 按钮的可见性控制。
export const PERM = {
  LIBRARY_BROWSE: "library.browse", // 浏览曲库(歌曲/专辑/艺术家/风格)
  LIBRARY_SEARCH: "library.search", // 搜索(本地 + 在线/插件)
  LIBRARY_STREAM: "library.stream", // 播放 / 试听 / 下载音频流
  PLAYLIST_VIEW: "playlist.view", // 查看歌单
  PLAYLIST_MANAGE: "playlist.manage", // 创建 / 编辑 / 删除歌单
  PLAYLIST_IMPORT: "playlist.import", // 导入 / 导出 / 同步歌单
  FAVORITES_MANAGE: "favorites.manage", // 我喜欢(收藏 / 查看)
  HISTORY_MANAGE: "history.manage", // 播放历史(查看 / 清空)
  LYRICS_VIEW: "lyrics.view", // 歌词
  COVER_VIEW: "cover.view", // 封面
  RECOMMEND_VIEW: "recommend.view", // 每日推荐 / 首页精选 / 推荐池
  WISH_VIEW: "wish.view", // 点歌台(愿望单)
  RENDERER_USE: "renderer.use", // 使用播放器(DLNA/AirPlay/群组,需设备授权)
  RENDERER_MANAGE: "renderer.manage", // 管理播放器
  FLOW_MANAGE: "flow.manage", // 音流(自动化流程)
  SETTINGS_MANAGE: "settings.manage", // 系统设置
  USER_MANAGE: "user.manage", // 用户管理
} as const;

export type PermKey = (typeof PERM)[keyof typeof PERM];

/** 菜单/路由所需的权限分组(值 → 权限 key;undefined 表示无权限要求)。 */
export const ROUTE_PERM: Record<string, PermKey | undefined> = {
  "/": undefined,
  "/playlists": PERM.PLAYLIST_VIEW,
  "/songs": PERM.LIBRARY_BROWSE,
  "/artists": PERM.LIBRARY_BROWSE,
  "/albums": PERM.LIBRARY_BROWSE,
  "/favorites": PERM.FAVORITES_MANAGE,
  "/genres": PERM.LIBRARY_BROWSE,
  "/history": PERM.HISTORY_MANAGE,
  "/groups": undefined, // 管理页仍按 requiresAdmin
  "/flows": PERM.FLOW_MANAGE,
};
