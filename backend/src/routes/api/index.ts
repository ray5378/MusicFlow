// 自动生成 —— 路由装配层。业务路由按域拆分到同目录各模块，此处只负责注册顺序。
// 注册顺序严格沿用拆分前的原始行号顺序（权限门禁必须先于子路由处理器执行）。
import { Hono } from "hono";
import { onlineRoutes } from "./online.js";
import { playlistSearchRoutes } from "./playlistSearch.js";
import { entitySearchRoutes } from "./entitySearch.js";
import { registerRecommend } from "./recommend.js";
import { registerRecommendPool } from "./recommendPool.js";
import { registerLibrary } from "./library.js";
import { registerStream } from "./stream.js";
import { registerPlaylists } from "./playlists.js";
import { registerProxy } from "./proxy.js";
import { registerUsers } from "./users.js";
import { registerSources } from "./sources.js";
import { registerPlugins } from "./plugins.js";
import { registerWish } from "./wish.js";
import { registerSettings } from "./settings.js";
import { registerDailyRecommend } from "./dailyRecommend.js";
import { registerTasks } from "./tasks.js";
import { registerHistory } from "./history.js";
import { registerDlna } from "./dlna.js";
import { registerAirplay } from "./airplay.js";
import { registerSendspin } from "./sendspin.js";
import { registerPeers } from "./peers.js";
import { registerPlayerPrefs } from "./playerPrefs.js";
import { registerPipeline } from "./pipeline.js";
import { registerGroups } from "./groups.js";
import { registerPlay } from "./play.js";
import { registerFlows } from "./flows.js";
import { registerWebhook } from "./webhook.js";

export const apiRoutes = new Hono();

// ==================== 细粒度功能权限门禁(前缀 → 权限 key) ====================
// 管理员恒通过(permMiddleware → hasPerm 短路);普通用户按用户权限判定,
// 被管理员显式撤销的库功能一律 403。默认放行的功能(浏览/搜索/播放/推荐等)
// 仅在管理员撤销后生效,对既有用户零影响。
// 歌单(子权限)与历史/愿望单/音流等在各自路由上单独挂载。
// 注意:必须注册在子路由(route)之前,才能先于子路由处理器执行。

registerRecommend(apiRoutes);
registerRecommendPool(apiRoutes);
registerLibrary(apiRoutes);
registerStream(apiRoutes);
registerPlaylists(apiRoutes);
apiRoutes.route("/", onlineRoutes);
apiRoutes.route("/", playlistSearchRoutes);
apiRoutes.route("/", entitySearchRoutes);
registerProxy(apiRoutes);
registerUsers(apiRoutes);
registerSources(apiRoutes);
registerPlugins(apiRoutes);
registerWish(apiRoutes);
registerSettings(apiRoutes);
registerDailyRecommend(apiRoutes);
registerTasks(apiRoutes);
registerHistory(apiRoutes);
registerDlna(apiRoutes);
registerAirplay(apiRoutes);
registerSendspin(apiRoutes);
registerPeers(apiRoutes);
registerPlayerPrefs(apiRoutes);
registerPipeline(apiRoutes);
registerGroups(apiRoutes);
registerPlay(apiRoutes);
registerFlows(apiRoutes);
registerWebhook(apiRoutes);

// 对外契约保持与拆分前一致
export { clearRecommendCache, deleteSongDb, getDlnaBaseUrl } from "./shared.js";
