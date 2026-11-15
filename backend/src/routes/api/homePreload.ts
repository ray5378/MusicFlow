// ==================== 首页数据接口 ====================
// 曾在此提供 GET /v1/home/preload:登录后一次性触发 songs/albums/artists/playlists
// 四个列表的第一页查询做「预热」。实测该接口在服务端**同步串行**执行 4 次列表查询,
// 单次请求阻塞 Node 事件循环 370–490ms,导致首页所有同源请求(封面 / getStarred2 /
// playlist-pool / peers)排队到它之后才返回(2026-11-09 CDP 实测:这些请求齐刷刷在
// 1.2s 同时完成,FCP 1088ms、LCP 4052ms)。预热收益远小于阻塞代价,已整体移除;
// 列表首访由各页面自身的请求完成。
//
// 2026-11-15 新增两个「首页分区」端点(纯计算在 homeRecommendSection.ts):
//   GET /v1/home/recommend-section  固定卡(零门槛) + 随机补位(**快照冻结随机位**)
//   GET /v1/home/recent-playlists   最近更新(**无随机位 → 不做快照**,如实反映当前数据)
import type { Hono } from "hono";
import {
  PERM,
  dailyRecommendHomeCount,
  listHomeCardPlugins,
  log,
  permMiddleware,
  sqlite,
} from "./shared.js";
import { buildPlaylistPool } from "./playlists.js";
import {
  buildRecommendSection,
  buildSectionSeed,
  hourBucketOf,
  type FixedCardCandidate,
} from "./homeRecommendSection.js";
import { clampRecentLimit, selectRecentPlaylists } from "./homeRecentPlaylists.js";

/** 固定卡失效的告警去重桶(同一小时内只喊一次,避免每请求刷屏)。
 *  注意:这**不是**结果缓存——section 每次都现算或读快照,这里只记「上次已告警的 hourBucket」。 */
let degradedWarnedBucket = -1;

/** 缺行逐卡告警的去重:每张卡每小时最多一条(长期坏卡不再每请求刷一条)。
 *  集合大小上界 = 该小时内坏卡的张数,跨小时自动清空,不会无界增长。 */
let missingWarnedBucket = -1;
const missingWarnedCards = new Set<string>();

/** 固定卡歌单行缺失的告警(playlistId + hourBucket 去重)。 */
function warnMissingCardOnce(playlistId: string, pluginId: string, hourBucket: number): void {
  if (missingWarnedBucket !== hourBucket) {
    missingWarnedBucket = hourBucket;
    missingWarnedCards.clear();
  }
  if (missingWarnedCards.has(playlistId)) return;
  missingWarnedCards.add(playlistId);
  log.warn(
    `[recommend-section] 固定卡歌单行缺失: playlistId=${playlistId} pluginId=${pluginId}` +
      `(仍返回该卡并标 missing;本小时仅告警一次)`,
  );
}

// ==================== 随机位快照(settings 表,每用户 1 行,零清理) ====================
// 为什么只冻结随机位:固定卡由插件配置决定、recent 由 updated_at 决定,两者本身没有随机性,
// 数据不变则结果必然相同;只有随机补位需要冻结,否则一小时内的重复请求会跳。
// 用现有 settings 表(不建新表:改 schema 要同步 CREATE TABLE + schema.ts + freshInstall
// 硬编码列清单)。列名必须是真实列 `updated_at`——写成 drizzle 属性名 `updatedAt` 会在
// prepare 阶段抛 no such column 并被 catch 静默吞掉,表现为「看似落库、实则从未写入」
// (2026-10-15 踩过的坑)。
const SECTION_SNAPSHOT_PREFIX = "home.section.";

/** 快照 key:每用户 1 行(无用户上下文时归到 anon)。 */
function sectionSnapshotKey(userId: string | undefined): string {
  return SECTION_SNAPSHOT_PREFIX + (userId ?? "anon");
}

/** 读快照:只有 hourBucket 完全匹配才认(跨整点必须换一批)。任何异常都当作无快照。 */
function readSectionSnapshot(userId: string | undefined, hourBucket: number): string[] | undefined {
  try {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(sectionSnapshotKey(userId)) as any;
    if (!row?.value) return undefined;
    const parsed = JSON.parse(String(row.value));
    if (!parsed || parsed.hourBucket !== hourBucket || !Array.isArray(parsed.randomIds)) return undefined;
    return parsed.randomIds.map((id: any) => String(id));
  } catch (e: any) {
    log.warn(`[recommend-section] 快照读取失败(按无快照处理): ${e?.message || e}`);
    return undefined;
  }
}

/** 写快照(UPSERT 覆盖,每用户永远 1 行)。落库失败只 warn,绝不影响请求。 */
function writeSectionSnapshot(userId: string | undefined, hourBucket: number, randomIds: string[]): void {
  try {
    const now = new Date().toISOString();
    const value = JSON.stringify({ hourBucket, randomIds, computedAt: now });
    sqlite
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(sectionSnapshotKey(userId), value, now);
  } catch (e: any) {
    log.warn(`[recommend-section] 快照落库失败(不影响响应): ${e?.message || e}`);
  }
}

/**
 * 读取 showOnHome 的固定卡并逐卡补齐 playlists 行(名字 / 曲目数 / 封面)。
 *
 * 固定卡**不做任何曲目数门槛**(2026-11-15 用户定调:固定卡就该一直显示),
 * 因此歌单行缺失时也照样返回这条卡,只标 missing:true —— 让前端能区分
 * 「插件今天还没生成 / 歌单被删 / manifest id 配错」,而不是静默变 0 首消失。
 */
function loadHomeFixedCandidates(hourBucket: number): FixedCardCandidate[] {
  const stmt = sqlite.prepare("SELECT id, name, song_count, cover_art FROM playlists WHERE id = ?");
  const out: FixedCardCandidate[] = [];
  for (const p of listHomeCardPlugins()) {
    if (!p.showOnHome) continue;
    const row = stmt.get(p.playlistId) as any;
    if (!row) warnMissingCardOnce(p.playlistId, p.pluginId, hourBucket);
    out.push({
      pluginId: p.pluginId,
      playlistId: p.playlistId,
      name: p.name,
      playlistName: row?.name || "",
      position: p.position,
      songCount: row?.song_count || 0,
      // 与 GET /v1/recommend/home-cards 同一口径:只在歌单行存在时给 pl-<id>。
      coverArt: row ? `pl-${p.playlistId}` : null,
      isCombo: (p.capabilities || []).includes("comboPlaylist"),
      missing: !row,
    });
  }
  return out;
}

export function registerHomePreload(app: Hono): void {
  // 首页「并排随机」用的全量歌单池(最小投影,2026-10-20)。
  // 权限与 /v1/playlists 一致(PLAYLIST_VIEW);一次返回全量 id+name+songCount(+changed),
  // 首页不再 pageSize=200 分页(生产 873 个歌单,分页会把随机池截到最新约 200 个)。
  // 封面由前端按 pl-<id> 派生懒加载,故响应体刻意不带 coverArt(省带宽/序列化)。
  // changed = updated_at(2026-11-15 新增,纯增字段):供「最近更新」分区倒序取前 20。
  app.use("/v1/home/playlist-pool", permMiddleware(PERM.PLAYLIST_VIEW));
  app.get("/v1/home/playlist-pool", (c) => {
    const user = c.get("user");
    // ?refresh=1 跳过索引 TTL 缓存强制重建:首页「重新生成漫游」后需要立刻看到新歌单,
    // 否则新建的歌单最迟要等 TTL(60s)过期才进并排随机池(旧实现直查 DB,无此延迟)。
    const force = c.req.query("refresh") === "1";
    const { total, items } = buildPlaylistPool(user, { force });
    return c.json({ success: true, total, items });
  });

  // ==================== 首页「为你推荐」聚合(服务端确定性组装,2026-11-15) ====================
  // 把「最终展示哪 12 张卡片」的组装从三端(Web / Flutter 音流 / HA 卡片)各自本地计算,
  // 收敛为服务端单一真源:
  //   - 固定卡:listHomeCardPlugins() 里 showOnHome 的卡,**零门槛**全返回,位次升序
  //     (位次相同按 pluginId 字典序,与 /v1/recommend/home-cards 完全一致);
  //     歌单行查不到的卡标 missing:true 仍然返回(不静默吞卡);
  //   - 随机补位:可见性过滤后的歌单池(buildPlaylistPool)去掉固定卡占用的 id、
  //     只留 songCount >= 30,按 md5(`<userId>|<hourBucket>|<id>`) 前 8 位十六进制升序,
  //     取前 max(0, homeCount - fixed.length) 条;
  //   - 随机位写 settings 快照(key = home.section.<userId|anon>,每用户 1 行),
  //     同 hourBucket 内复用快照 → 一小时内的重复请求 random 不跳;跨整点自动重算。
  //     快照里的 id 若已不可见/已变成固定卡 → 校验失败,重算(绝不返回死链)。
  //   - ?refresh=1:跳过快照 + 强制重建歌单池(buildPlaylistPool force),重算后覆盖快照。
  //     给「重新生成漫游」后的手动刷新用。
  // 老的 /v1/recommend/home-cards 与 /v1/home/playlist-count 行为完全不变(老客户端在用)。
  app.use("/v1/home/recommend-section", permMiddleware(PERM.PLAYLIST_VIEW));
  app.get("/v1/home/recommend-section", (c) => {
    const user = c.get("user");
    const refresh = c.req.query("refresh") === "1";
    const hourBucket = hourBucketOf(Date.now());
    const fixedCandidates = loadHomeFixedCandidates(hourBucket);
    // 手动刷新:不读快照,连歌单池索引也强制重建(新建的歌单立刻可参与补位)。
    const frozenRandomIds = refresh ? undefined : readSectionSnapshot(user?.id, hourBucket);
    const section = buildRecommendSection({
      fixedCandidates,
      pool: buildPlaylistPool(user, refresh ? { force: true } : undefined).items,
      homeCount: dailyRecommendHomeCount(),
      hourBucket,
      seed: buildSectionSeed(user?.id, hourBucket),
      frozenRandomIds,
    });
    // 只在本轮**重算**时落库(frozen=快照命中就不要每请求重写一遍)。
    if (!section.frozen) writeSectionSnapshot(user?.id, hourBucket, section.randomIds);
    // 有固定卡指向的歌单已不存在 = 固定卡失效(degraded):前端只会看到「某张卡空着/缺封面」,
    // 后端若不喊一声就完全无法归因。逐卡那条 warn 在 loadHomeFixedCandidates 里已打,
    // 这里补一条按小时去重的汇总,避免每请求刷屏。
    if (section.degraded && degradedWarnedBucket !== hourBucket) {
      degradedWarnedBucket = hourBucket;
      const missingIds = section.fixed.filter((f) => f.missing).map((f) => f.playlistId);
      log.warn(
        `[recommend-section] 固定卡失效:showOnHome 共 ${fixedCandidates.length} 张,` +
          `其中 ${missingIds.length} 张指向不存在的歌单(${missingIds.join(",")})(hourBucket=${hourBucket})`,
      );
    }
    // randomIds / frozen 是给路由层落快照用的内部字段,不对外暴露(响应体保持既有契约)。
    return c.json({
      success: section.success,
      hourBucket: section.hourBucket,
      homeCount: section.homeCount,
      degraded: section.degraded,
      fixed: section.fixed,
      random: section.random,
    });
  });

  // ==================== 最近更新的歌单(2026-11-15) ====================
  // 与「为你推荐」拆开:这个分区**没有随机位** —— updated_at 排出来就是确定的,
  // 所以刻意不做快照(冻结反而会让「最近更新」失真)。数据源同样是 buildPlaylistPool,
  // 因此复用同一套可见性口径(kind='music' + 自己/公开),study 等非 music 歌单天然不进。
  app.use("/v1/home/recent-playlists", permMiddleware(PERM.PLAYLIST_VIEW));
  app.get("/v1/home/recent-playlists", (c) => {
    const user = c.get("user");
    // ?limit 必须 clamp:防 ?limit=99999 把 871 条整包吐出去。
    // NaN(abc)→ 20;0 → 1;999 → 100(见 clampRecentLimit 注释)。
    const limit = clampRecentLimit(c.req.query("limit"));
    const items = selectRecentPlaylists(buildPlaylistPool(user).items, limit);
    // total 刻意不返回:playlist-pool 的 total 是「池子总数」,同名字段会误导消费方。
    return c.json({ success: true, limit, items });
  });
}
