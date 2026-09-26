// 自动生成 —— 由 index.ts 物理拆分而来（recommend 域，8 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  PERM,
  RECOMMEND_CACHE_TTL_MS,
  adminMiddleware,
  and,
  apiError,
  comboApi,
  count,
  dailyApi,
  dailyRecommendHomeCount,
  findLocalRemotePlaylist,
  firstEnabledByCapability,
  getEnabledByCapability,
  getPlugin,
  getPluginConfig,
  listHomeCardPlugins,
  localApi,
  log,
  or,
  permMiddleware,
  playlists,
  plugins,
  recommendCache,
  runPluginJob,
  songs,
  sqlite,
  startAsyncTask,
  touch,
} from "./shared.js";

export function registerRecommend(app: Hono): void {
app.use("/v1/recommend", permMiddleware(PERM.RECOMMEND_VIEW));

app.use("/v1/local-recommend", permMiddleware(PERM.RECOMMEND_VIEW));

app.use("/v1/home/playlist-count", permMiddleware(PERM.RECOMMEND_VIEW));

app.get("/v1/recommend", async (c) => {
  // ==================== 统一推荐聚合 ====================
  // 1) 调用主推荐插件(具备 recommend 能力,如 go-music-dl)获取频道
  // 2) 调用所有推荐歌单插件(具备 recommendPlaylist 能力,如 QQ/酷狗/网易云榜单)
  // 3) 合并所有频道,按 sortOrder 升序排列
  // 这样每个插件都是独立平等的,不依赖 go-music-dl 内部合并。
  // ====================================================
  const rp = firstEnabledByCapability("recommend");
  const providerId = rp?.manifest.id || "";

  // 缓存 key 包含所有 recommendPlaylist 插件 ID,避免缓存错乱
  const rpList = getEnabledByCapability("recommendPlaylist");
  const rpSigs = rpList.map((p: any) => p.manifest.id).sort().join(",");
  const cacheKey = providerId + "|" + rpSigs;
  const cached = recommendCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < RECOMMEND_CACHE_TTL_MS) {
    return c.json({ success: true, channels: cached.channels, providerId });
  }

  const allChannels: any[] = [];
  let primaryError: string | undefined;

  // ---- 1. 主推荐插件(如 go-music-dl) ----
  if (rp && typeof rp.impl?.recommend === "function") {
    const config = getPluginConfig(providerId) || {};
    try {
      const result = await rp.impl.recommend(config);
      const baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
      const channels = (Array.isArray(result?.channels) ? result.channels : []).map((ch: any) => ({
        source: ch.source || "",
        name: ch.name || ch.source || "",
        count: ch.count || 0,
        sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
        _pluginId: providerId,
        playlists: (Array.isArray(ch.playlists) ? ch.playlists : []).map((pl: any) => {
          const source = pl.source || ch.source || "";
          const local = findLocalRemotePlaylist(pl.id, source, pl.name || "");
          return {
            id: pl.id,
            source,
            name: pl.name || "",
            creator: pl.creator || "",
            cover: pl.cover && !/^https?:\/\//i.test(String(pl.cover))
              ? `${baseUrl}${String(pl.cover).startsWith("/") ? "" : "/"}${pl.cover}`
              : (pl.cover || ""),
            trackCount: local ? String(local.songCount ?? "") : "",
            link: pl.link || "",
            imported: !!local,
          };
        }),
      }));
      for (const ch of channels) allChannels.push(ch);
    } catch (e: any) {
      console.warn(`[RECOMMEND] ${providerId} recommend() failed:`, e?.message || e);
      primaryError = String(e?.message || e);
      // 主推荐插件失败不阻断其他插件
    }
  }

  console.log(`[RECOMMEND] 找到 ${rpList.length} 个 recommendPlaylist 插件:`, rpList.map((p: any) => p.manifest.id).join(","));

  // ---- 2. 推荐歌单插件(具备 recommendPlaylist 能力,如榜单插件) ----
  // 并行聚合:各插件的 recommend() 各自看门狗/长耗时预算,互不阻塞。串行会累加
  // 墙钟(go-music-dl + 三个榜单),冷缓存下一次聚合轻松超过前端默认 15s 超时,导致
  // 首页整单(含 go-music-dl)被中止。并行 + 后端缓存后,首次即显著加快,后续秒开。
  // 每个插件独立 try/catch,单个失败不影响其它插件频道。
  const rpTasks = rpList
    .filter((p: any) => p.manifest.id !== providerId && typeof p.impl?.recommend === "function")
    .map((p: any) =>
      (async () => {
        const pConfig = getPluginConfig(p.manifest.id) || {};
        try {
          const result = await p.impl.recommend(pConfig);
          const channels = Array.isArray(result?.channels) ? result.channels : [];
          for (const ch of channels) {
            const playlists = (Array.isArray(ch.playlists) ? ch.playlists : []).map((pl: any) => {
              // 检查该歌单是否已入库(由 runDailyJob 同步)
              const local = findLocalRemotePlaylist(pl.id, ch.source || "", pl.name || "");
              return {
                id: pl.id,
                source: ch.source || "",
                name: pl.name || "",
                creator: pl.creator || "",
                cover: pl.cover || "",
                trackCount: local ? String(local.songCount ?? "") : "",
                link: pl.link || "",
                imported: !!local,
              };
            });
            allChannels.push({
              source: ch.source || "",
              name: ch.name || ch.source || "",
              count: ch.count || 0,
              sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
              _pluginId: p.manifest.id,
              playlists,
            });
          }
        } catch (e: any) {
          console.warn(`[RECOMMEND] ${p.manifest.id} recommend() failed:`, e?.message || e);
        }
      })()
    );
  await Promise.all(rpTasks);

  // ---- 3. 按 sortOrder 升序排列(数值越小越靠前) ----
  allChannels.sort((a: any, b: any) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : 99;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : 99;
    return sa - sb;
  });

  recommendCache.set(cacheKey, { ts: Date.now(), channels: allChannels });
  const resp: any = { success: true, channels: allChannels, providerId };
  if (primaryError) resp.error = primaryError;
  return c.json(resp);
});

// ==================== 首页「本地随机(按平台)」(能力驱动,不写死插件名) ====================
// 由启用的 `localPlatformRecommend` 插件(如内置 local-random-recommend)提供:
// 从本地库按平台分组随机取已入库歌单,供三端(Web/客户端/HA)统一展示动态刷新的
// 平台歌单——不依赖上游固定精选。核心只按能力遍历调用并透传数据。

app.get("/v1/local-recommend", async (c) => {
  // 遍历所有具备该能力的插件,合并多插件的 channels(支持多提供方共存)。
  const providers = getEnabledByCapability("localPlatformRecommend");
  const allChannels: any[] = [];
  for (const p of providers) {
    if (typeof p.impl?.recommendLocal !== "function") continue;
    try {
      const result = await p.impl.recommendLocal(getPluginConfig(p.manifest.id) || {});
      const channels = Array.isArray(result?.channels) ? result.channels : [];
      for (const ch of channels) {
        allChannels.push({
          source: ch.source || "",
          name: ch.name || ch.source || "",
          count: ch.count || 0,
          sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
          // 可选展示文案(由提供方决定;缺省时前端回落为「本地随机」默认表述):
          //   subtag  → 分区标题后缀(如「每日更新」),缺省用「本地随机」
          //   tagline → 分区副标题说明,缺省用「从你的 X 歌单里随机(每次刷新不同)」
          subtag: typeof ch.subtag === "string" ? ch.subtag : undefined,
          tagline: typeof ch.tagline === "string" ? ch.tagline : undefined,
          // 本地歌单:直接透传 DB 字段(coverArt 为本地封面 ref,三端用各自 cover 工具拼 URL)。
          playlists: (Array.isArray(ch.playlists) ? ch.playlists : []).map((pl: any) => ({
            id: pl.id ?? "",
            name: pl.name ?? "",
            coverArt: pl.coverArt ?? null,
            songCount: pl.songCount ?? 0,
            imported: true,
          })),
        });
      }
    } catch (e: any) {
      console.warn(`[LOCAL-RECOMMEND] ${p.manifest.id} recommendLocal() failed:`, e?.message || e);
    }
  }
  // 按 sortOrder 升序排列(数值越小越靠前)
  allChannels.sort((a, b) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : 99;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : 99;
    return sa - sb;
  });
  return c.json({ success: true, channels: allChannels });
});

// 首页顶部「每日推荐 + 本地推荐 + 随机歌单」展示张数(含两张固定推荐)。
// 由每日推荐插件的 homeCount 配置控制(默认 8),核心经能力门面读取,不写死插件名。

app.get("/v1/home/playlist-count", (c) => {
  return c.json({ success: true, count: dailyRecommendHomeCount() });
});

// ==================== 首页固定卡(推荐插件自治) ====================
// 哪些推荐歌单固定在首页顶部、按什么位次排,由各插件自己的配置决定:
//   manifest.configSchema 声明 showOnHome(switch) / homePosition(number);
//   manifest.homePlaylistId 声明首页对应的固定歌单 id。
// 核心按能力收集(不写死插件名),位次冲突在保存插件配置时校验。

app.get("/v1/recommend/home-cards", (c) => {
  // ?all=1 返回全部固定推荐歌单(含未开启「在首页显示」的),供音流等场景
  // 选择固定引用;默认只返回 showOnHome(首页展示)。
  const all = c.req.query("all") === "1";
  const plugins = listHomeCardPlugins().filter((p) => p.showOnHome || all);
  // 位次排序:0(未固定)排最后,固定位次升序。
  const sorted = [...plugins].sort((a, b) => {
    const pa = a.position || Number.MAX_SAFE_INTEGER;
    const pb = b.position || Number.MAX_SAFE_INTEGER;
    return pa - pb || a.pluginId.localeCompare(b.pluginId);
  });
  const cards = sorted.map((p) => {
    const pl = sqlite.prepare("SELECT id, name, song_count, cover_art FROM playlists WHERE id = ?").get(p.playlistId) as any;
    return {
      pluginId: p.pluginId,
      name: p.name,
      playlistId: p.playlistId,
      position: p.position,
      capabilities: p.capabilities,
      isCombo: p.capabilities.includes("comboPlaylist"),
      // 歌单信息(前端按 songCount > 30 门槛展示)
      playlistName: pl?.name || "",
      songCount: pl?.song_count || 0,
      // 统一返回标准逻辑 ref pl-<id>(getCoverArt 按 pl- 前缀查歌单行解析;
      // 直接返回 cover_art 原始值(如 pl-pl-daily-today.jpg)会被当成 playlistId
      // 查表失败 → 首页卡片无封面)。
      coverArt: pl ? `pl-${p.playlistId}` : null,
    };
  });
  return c.json({ success: true, cards });
});

// ==================== 网络代理(管理员,仅插件拉取链路) ====================
// 系统设置里的「网络代理」:http://ip:port、https://ip:port 或 socks5://ip:port,
// 用于插件市场拉取 GitHub 等源(registry / plugin.json / 安装包)。仅影响插件拉取,
// 其它后端网络直连。

app.post("/v1/recommend/refresh", adminMiddleware, async (c) => {
  touch(); // 标记活动:推荐歌单刷新
  const body = await c.req.json().catch(() => ({}));

  // 单插件手动刷新:任意声明 dailyPlaylist / localPlaylist / comboPlaylist /
  // recommendPlaylist / localPlatformRecommend / playlistCleanup 能力的插件
  // (内置或外置)都可经此入口强制重跑。传 force 绕过插件自身的间隔闸门。
  // **异步任务通道**:任务在后台跑(沙箱用 manifest.longRunning
  // 长预算),立即返回,前端轮询 GET /v1/plugins/:id/job 看结果——不再被沙箱 15s
  // 或前端 axios 15s 卡死。
  const pluginId = body?.pluginId;
  if (pluginId) {
    const reg = getPlugin(pluginId);
    if (!reg) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.plugin.notFound"), 404);
    const caps: string[] = reg.manifest.capabilities || [];
    const isDaily =
      caps.includes("dailyPlaylist") ||
      caps.includes("localPlaylist") ||
      caps.includes("comboPlaylist") ||
      caps.includes("recommendPlaylist") ||
      caps.includes("localPlatformRecommend") ||
      caps.includes("playlistCleanup");
    if (!isDaily) {
      return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.plugin.noRefresh"), 400);
    }
    // 未启用(或尚无 DB 行)视为不可用。
    if (getPluginConfig(pluginId) === null) {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.plugin.notEnabled"), 503);
    }
    const impl = reg.impl;
    if (typeof impl?.runDailyJob !== "function") {
      return c.json(apiError(BusinessErrorCode.INTERNAL, "errors.plugin.noDailyJob"), 500);
    }
    const { started, alreadyRunning } = runPluginJob(pluginId, "runDailyJob", { force: true, keywordOnly: !!body?.keywordOnly });
    if (alreadyRunning) {
      return c.json({ success: true, pluginId, alreadyRunning: true, message: "该插件刷新任务已在后台运行中" }, 200);
    }
    if (!started) {
      return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, "errors.task.startFailed"), 500);
    }
    return c.json({ success: true, pluginId, started: true, message: "已开始后台刷新,可通过 GET /v1/plugins/:id/job 查询进度" }, 202);
  }

  const targets = Array.isArray(body?.targets) ? body.targets : ["daily", "local", "roam"];
  // 同步前置校验:能力不存在直接 503(契约保留)。实际生成在一次性批量子进程内跑
  // (recommend-refresh,方案3),峰值内存随子进程退出归还;前端 202 后轮询
  // GET /v1/tasks/:taskId 取结果(task.result = { success, seedSalt, results })。
  if (targets.includes("daily") && !dailyApi()) return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.common.dailyRecommendDisabled"), 503);
  if (targets.includes("local") && (!localApi() || typeof localApi().generateLocalDailyPlaylist !== "function")) {
    return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.common.localRecommendDisabled"), 503);
  }
  if (targets.includes("roam") && (!comboApi() || typeof comboApi().generateComboPlaylist !== "function")) {
    return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.common.roamRecommendDisabled"), 503);
  }
  const seedSalt = Math.floor(Math.random() * 1_000_000);
  const started = startAsyncTask("recommend-refresh", `targets:${targets.join(",")}`, {
    kind: "recommend-refresh",
    args: { targets, seedSalt },
  });
  if (!started.started) {
    return c.json({
      success: true, started: false, alreadyRunning: true, taskId: started.taskId, seedSalt,
      message: "刷新任务已在后台运行中,可通过 GET /v1/tasks/:taskId 查询进度",
    }, 202);
  }
  return c.json({
    success: true, started: true, taskId: started.taskId, seedSalt,
    message: "已开始后台刷新,可通过 GET /v1/tasks/:taskId 查询进度",
  }, 202);
});

// ==================== User recommend pool ====================
// A user can click "加入每日推荐池" on any playlist (or on "我喜欢的音乐")
// to add that source to the pool. Each daily-recommend run picks up to 50
// random playable songs from every pool member and merges them into the
// day's combined "每日推荐" playlist.

// List all pool members (for an admin management page if desired).
}
