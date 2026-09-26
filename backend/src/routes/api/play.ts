// 自动生成 —— 由 index.ts 物理拆分而来（play 域，1 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  and,
  apiError,
  canControlPeer,
  decodePeerId,
  getDlnaBaseUrl,
  getQueueManager,
  isCastPeer,
  maskLocalPeerId,
  parsePeerId,
  pm,
  resolveBodyPeerId,
  resolveContentSongs,
  runPlaylistAutoMatch,
  seekPeerToSeconds,
  songsToQueueItems,
} from "./shared.js";

export function registerPlay(app: Hono): void {
app.post("/v1/play", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { peerId: rawPeerId, type, id, songId, startIndex, playMode, enqueue, position } = body || {};
  if (typeof rawPeerId !== "string" || typeof type !== "string" || typeof id !== "string") {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.needPeerTypeId"), 400);
  }
  const user = c.get("user");
  // body 里的本机 peerId 可能是**对外掩码形式**(`local:<userId>:<instanceKey>`)——调用方
  // 只会看到这个形式。必须与路径端点(`decodePeerId`)走同一套解析,否则掩码形式会被当成
  // **真实键**原样落库 → 给该实例凭空多出一条僵尸队列行,而目标实例读的是自己那条真行,
  // 于是「Web 端点歌单让某台客户端播 → 客户端毫无反应、队列看起来被吞了」(2026-09-15 实测)。
  const peerId = resolveBodyPeerId(c, rawPeerId);
  // 细粒度播放器授权:非 admin 只能投放到被授权的 peer(含自己的 local)。
  if (!canControlPeer(user?.id ?? "", !!user?.isAdmin, peerId)) {
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  // 方案收敛:Web 播放器不再是被控端,拒绝向其投放内容(列表已隐藏,这里兜底防缓存直呼)。
  if (parsed.kind === "local") {
    const target = pm.get(peerId);
    if (target?.platform === "web") {
      return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
    }
  }
  const resolved = await resolveContentSongs(type, id);
  if (!resolved) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.invalidTypeId", { type }), 404);
  const items = songsToQueueItems(resolved.rows);
  if (items.length === 0) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.noPlayableSongs", { name: resolved.name }), 422);
  // 起点定位：优先按 songId 身份查找（与两侧排序无关）；找不到或未传时才回落
  // startIndex 行号。songId 传了但队列里没有 → 视为调用方所指的歌不在该内容中，
  // 明确返 404 而不是静默从头播（历史上 startIndex 越界静默归 0 掩盖了大量错位）。
  //
  // `start` 为 null 表示**调用方未指定起点** → 交给 QueueController.playFrom 在
  // shuffle 模式下随机挑首（随机只发生在服务端这一处，客户端不再自行洗牌）。
  //
  // 2026-09-14 起：`songId`/`startIndex` 命中**居中的具体某首（>0）**仍在 playFrom
  // 内严格尊重；命中**第 1 首（=0）**的"整列表播放"在 shuffle 下也会被服务端随机
  // 挑首（见 playFrom 的 listStart 判定），与纯 web 前端整列表 shuffle 行为对齐。
  let start: number | null = null;
  if (typeof songId === "string" && songId.length > 0) {
    const idx = items.findIndex((it) => it.songId === songId);
    if (idx < 0) {
      return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.songNotInContent", { songId, type }), 404);
    }
    start = idx;
  } else if (typeof startIndex === "number" && startIndex >= 0 && startIndex < items.length) {
    start = Math.floor(startIndex);
  }
  const baseUrl = getDlnaBaseUrl(c);
  // 回执要给出**实际起播**位置：`start` 为 null 时由 playFrom 在 shuffle 下随机决定，
  // 故用其返回值（playFrom 内部随机后把真实下标回传），避免客户端拿到 null 无从对齐。
  let effectiveStart = start ?? 0;
  // 起始位置(流转场景:客户端把本机此刻的进度一并带过来)。
  // 调用方是本机会话的持有者,它的读数即权威 —— 这里**不**再回读服务端镜像
  // (本机上报有 TTL 与轮询间隔,反而更旧)。
  const askPosition = typeof position === "number" && Number.isFinite(position) ? Math.max(0, position) : null;
  let landedPosition: number | null = null;
  if (isCastPeer(parsed)) {
    try {
      if (enqueue) { await getQueueManager().enqueue(parsed.id, items, baseUrl); effectiveStart = 0; }
      // 第 5 参 contentContext 必须传:它是 QueueData 上唯一的「这条队列来自哪个内容」
      // 标记,runPlaylistAutoMatch 靠它与 opts.contentContext 严格比对来确认队列没被换掉。
      // 漏传 => 队列上 contentContext 恒 undefined => 比对恒失败 => 补齐永远不执行。
      else effectiveStart = await getQueueManager()
        .playFrom(parsed.id, items, start, baseUrl, type === "playlist" ? `playlist:${id}` : undefined);
    } catch (e: any) { return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.player.playFailed"), 500); }
    if (!enqueue && askPosition !== null && await seekPeerToSeconds(peerId, askPosition)) landedPosition = askPosition;
  } else {
    if (enqueue) { pm.localEnqueue(peerId, c.get("user")?.id, items); effectiveStart = 0; }
    else {
      // local 目标:起点随起播交出去(见 seekPeerToSeconds 上方注释)。
      const at = askPosition !== null && askPosition > 0 ? askPosition : undefined;
      if (at !== undefined) landedPosition = at;
      pm.localPlayFrom(peerId, c.get("user")?.id, items, effectiveStart, at);
    }
  }
  if (typeof playMode === "string" && ["order", "one", "all", "shuffle"].includes(playMode)) {
    const mode = playMode as "order" | "one" | "all" | "shuffle";
    if (isCastPeer(parsed)) getQueueManager().setPlayMode(parsed.id, mode);
    else pm.localSetPlayMode(peerId, mode);
  }
  const snap = isCastPeer(parsed) ? getQueueManager().snapshot(parsed.id) : null;
  // 起播成功后再 fire-and-forget 做一次「歌单自动匹配 + 补齐」:
  // 播歌单时,此前匹配不上(门禁拦下/在线源下架)的条目会被重新搜一次,命中的追加到队尾。
  // 刻意 **不等** —— 它会去抢全局批量闸(可能被全库扫描占住),而播放已经开始,
  // 补不补都影响不到正在听的那一首(2026-09-25 收敛)。
  if (type === "playlist") {
    void runPlaylistAutoMatch(id, {
      playerId: isCastPeer(parsed) ? parsed.id : peerId,
      contentContext: `playlist:${id}`,
      baseUrl,
    }).catch((e: any) => console.warn(`[auto-match] ${id} 触发失败: ${e?.message || e}`));
  }
  return c.json({
    // 回执里的 peerId 必须是**对外形式**:local 的真实行带着 clientId,直接回显会把它
    // 泄给调用方(设计约束:clientId 永不出服务端)。cast peer 的 id 无此问题,原样返回。
    success: true, peerId: parsed.kind === "local" ? maskLocalPeerId(peerId) : peerId,
    type, id, name: resolved.name,
    queued: items.length,
    startIndex: enqueue ? undefined : effectiveStart,
    songId: enqueue ? undefined : items[effectiveStart]?.songId,
    // 实际落到的起始位置(秒):null = 未要求/未落上。客户端据此判断是否要对旧服务端兜底。
    position: landedPosition,
    // 权威洗牌序列(客户端镜像用,免一次额外请求)。非 cast peer(local)不适用。
    shuffleOrder: enqueue ? undefined : snap?.shuffleOrder,
    shufflePos: enqueue ? undefined : snap?.shufflePos,
  });
});

// ==================== 歌单自动匹配(播放器/客户端显式触发入口) ====================
// /v1/play 内建的自动匹配只对投屏(服务端内容点播)生效:客户端**本机播放**并不走
// /v1/play,而客户端无法预知 online providerId(本地歌单没有该字段),调不了
// /v1/online/:providerId/match-playlist。故开一个 providerId 无关的入口:复用
// matchPlaylistInBackground 的「能力驱动挑选」(插件启了谁就用谁),调用方无需知道
// 源是谁。响应即时返回(只登记任务),进度由调用方重新拉歌单自行观察,不占连接。
}
