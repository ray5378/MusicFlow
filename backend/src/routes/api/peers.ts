// 自动生成 —— 由 index.ts 物理拆分而来（peers 域，35 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  LocalPlaybackReport,
  PEER_PATH_RESERVED,
  PlaybackState,
  alignSeekSeconds,
  and,
  announceOnPeer,
  apiError,
  borrowLandingConfirmed,
  broadcastSendspinVolume,
  canControlPeer,
  clientIdOf,
  clientIdOfLocalPeer,
  countLiveConnections,
  decodePeerId,
  decoratePeersForClient,
  detachFromActiveGroups,
  dispatchPeerCommand,
  finiteNumOrUndefined,
  getAirPlayPeerStatus,
  getCurrentMedia,
  getDeviceStatus,
  getDlnaBaseUrl,
  getEventManager,
  getGroupLeaderDeviceId,
  getGroupStatus,
  getPeerManager,
  getQueueController,
  getQueueManager,
  getSendspinDeviceVolume,
  getSendspinFront,
  gm,
  isAnnouncing,
  isCastPeer,
  localShuffleInfo,
  log,
  markSeekIssued,
  maskLocalPeerId,
  parsePeerId,
  pauseDevice,
  playDevice,
  pm,
  readPeerPositionSeconds,
  refreshDevices,
  resolveBodyPeerId,
  resolveLocalPeerId,
  sanitizeClientId,
  sanitizeLabel,
  seekDevice,
  seekLog,
  seekPeerToSeconds,
  setAirPlayMuted,
  setDeviceMute,
  setDeviceVolume,
  setSendspinMemberMuted,
  shouldRefreshDevices,
  splitMemberId,
  stopDevice,
  tryArmSendspinBorrow,
  userIdOfLocalPeer,
} from "./shared.js";

export function registerPeers(app: Hono): void {
app.get("/v1/peers", (c) => {
  const user = c.get("user");
  // 客户端来拉列表 = 「用户正盯着设备列表」：距上次发现超过 60s 就后台补扫一轮
  // （fire-and-forget，不阻塞本次响应）。设备不发通告时，这一步让「打开 / 刷新列表」
  // 本身就能把刚上线的设备带出来，而不必干等周期扫描。并发由 refreshDevices 自身去重。
  if (shouldRefreshDevices()) void refreshDevices().catch(() => {});
  // 单一出口(与 WS peer_snapshot 共用):可见性 → 打码/self → 按用户级隐藏 → 改名。
  // 本机播放器的临时端 ID 由客户端以 X-MF-Client-Id 头 / ?clientId= 上报,缺省退回旧格式。
  //
  // ?includeHidden=1:侧边栏·播放器**管理页**专用 —— 隐藏的 peer 不剪掉,改打 hidden 标记。
  // 管理页的每一行都必须恒在(与 DLNA 设备行同构),否则用户拨了「隐藏」开关后行就从
  // 列表消失,再无落点取消隐藏,强刷也恢复不了(隐藏行本就不在默认响应里)。
  // 切换器 / 选择器不带该参数,行为与从前完全一致(隐藏即不出现在可选目标里)。
  const includeHidden = c.req.query("includeHidden") === "1";
  const peers = decoratePeersForClient(pm.listWithQueues(), user?.id ?? "", !!user?.isAdmin, clientIdOf(c), includeHidden);
  return c.json({ peers });
});

// ===== 播放器「按用户级隐藏」偏好 =====
// 每个用户可对某台设备/群组设置「不显示在我自己的播放器切换弹窗」。独立于
// 播放器授权,管理员同样受自己的隐藏影响。登录即可设置(user 恒有,故不用额外的权限门禁)。
// GET:返回我隐藏的 peerId 列表(供「播放器」页渲染开关状态)。

app.use("/v1/peers/:peerId/*", async (c, next) => {
  const peerId = c.req.param("peerId") || "";
  if (PEER_PATH_RESERVED.has(peerId)) return next();
  const user = c.get("user");
  if (canControlPeer(user?.id ?? "", !!user?.isAdmin, peerId)) return next();
  return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
});

app.use("/v1/peers/:peerId", async (c, next) => {
  if (c.req.method !== "GET") return next(); // 只拦 GET 详情/状态查询;register/heartbeat 等走各自校验
  const peerId = c.req.param("peerId") || "";
  if (PEER_PATH_RESERVED.has(peerId)) return next();
  const user = c.get("user");
  return canControlPeer(user?.id ?? "", !!user?.isAdmin, peerId)
    ? next()
    : c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.operationForbidden"), 403);
});

// Register/refresh the calling client's local peer. Body: { name?: string }.
// name defaults to the username so the switcher shows a friendly label.
// 调用方的临时端 ID(clientId)由客户端以 X-MF-Client-Id 头 / ?clientId= 上报(也接受
// body.clientId):每个客户端实例因此各占一条独立队列,同账号多个标签页/客户端同时
// 登录互不覆盖。它只在服务端内部使用 —— 响应里的 peerId 一律打码回 local:<userId>。

app.post("/v1/peers/register", async (c) => {
  const user = c.get("user")!;
  const body = (await c.req.json().catch(() => ({}))) as any;
  const name = (body && typeof body.name === "string" && body.name) || user.username;
  const clientId = sanitizeClientId(body?.clientId) ?? clientIdOf(c);
  // 设备名片(可选):平台 + 机型/电脑名,供「播放器」页把本机实例分进
  // 「客户端」/「Web 播放器」模块并按视角显示名字。网页拿不到电脑名属正常。
  const platform = sanitizeLabel(body?.platform, 32);
  const model = sanitizeLabel(body?.model, 64);
  const peer = pm.registerLocal(user.id, name, clientId, platform, model);
  // 注册的这条必然是自己 → self 恒 true。
  return c.json({ peer: { ...peer, peerId: maskLocalPeerId(peer.peerId), self: true } });
});

// Heartbeat: keep a local peer alive. Called periodically by the Web client.

app.post("/v1/peers/:peerId/heartbeat", (c) => {
  const peerId = decodePeerId(c);
  const ok = pm.heartbeat(peerId);
  return c.json({ success: ok });
});

// 页面主动告别:关标签页时用 `fetch(..., { keepalive: true })` 通知服务端
// 「这个实例没人听了」。
//
// 它与 WS close 是**互补**的两条路,不是替代:
//   - 正常关标签页 → WS close 引用计数归零 → 秒级标离线(services/ws/index.ts);
//   - 来不及发 FIN(浏览器被强杀 / 断网)→ 本端点在 pagehide 时抢在连接拆除前发到。
//
// 为什么不早退就误伤:`mf_client_id` 存 localStorage,**同浏览器多个标签页共用同一个
// clientId**。所以「关掉一个标签页」≠「这个端下线」,必须按连接数引用计数:
// 还剩 ≥2 条活连接时直接跳过(本次告别者自己的那条可能还没断)。
//
// 只做内存态清理(在线标记 + 预探测),**队列一律不动** —— local_queues 是服务端
// 权威数据,关页面只是「没人听了」,重开靠稳定的 clientId 认领回同一条队列。

app.post("/v1/peers/:peerId/offline", (c) => {
  const peerId = decodePeerId(c);
  const uid = userIdOfLocalPeer(peerId);
  const cid = clientIdOfLocalPeer(peerId);
  // 旧格式 local:<userId>(无 clientId)或非本机 peer:没有实例维度可判,忽略。
  if (!uid || !cid) return c.json({ ok: false, offline: false, reason: "not-local-instance" }, 400);
  const live = countLiveConnections(uid, cid);
  if (live > 1) return c.json({ ok: true, offline: false, reason: "other-connections-alive", live });
  pm.markLocalOfflineByClient(uid, cid);
  return c.json({ ok: true, offline: true, live });
});

/** 只把有限数字收下,其余(undefined / NaN / 字符串)→ undefined(字段级合并时沿用旧值)。 */

app.post("/v1/peers/:peerId/local-status", async (c) => {
  const peerId = decodePeerId(c);
  const body = (await c.req.json().catch(() => ({}))) as any;
  const rawState = typeof body?.state === "string" ? body.state.toUpperCase() : "";
  const state = rawState === "PLAYING" || rawState === "PAUSED_PLAYBACK" || rawState === "STOPPED"
    ? (rawState as LocalPlaybackReport["state"])
    : undefined;
  const rep = pm.reportLocalStatus(peerId, {
    state,
    position: finiteNumOrUndefined(body?.position),
    duration: finiteNumOrUndefined(body?.duration),
    volume: finiteNumOrUndefined(body?.volume),
    songId: typeof body?.songId === "string" && body.songId ? body.songId : undefined,
  });
  if (!rep) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  return c.json({ success: true, reportedAt: rep.reportedAt });
});

// Get a peer's queue snapshot (local: from local_queues; dlna/group: from queue manager).
// offset/size 分页:items 只含当前页,total 为完整队列长度(currentIndex 恒为绝对下标)。
// 缺省 offset/size 返回全量(向后兼容)。

app.get("/v1/peers/:peerId/queue", (c) => {
  const peerId = decodePeerId(c);
  const snap = pm.getQueueSnapshot(peerId);
  if (!snap) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  // dlna peer:补 currentMedia(原 QueueSnapshot 字段,新 snapshot 改用 ended)。
  const parsed = parsePeerId(peerId);
  const currentMedia = parsed
    ? parsed.kind === "dlna"
      ? getCurrentMedia(parsed.id)
      : parsed.kind === "airplay"
        ? getAirPlayPeerStatus(parsed.id).media
        : parsed.kind === "sendspin"
          ? getSendspinFront()?.currentMedia(parsed.id)
          : undefined
    : undefined;
  const items = Array.isArray(snap.items) ? snap.items : [];
  const total = items.length;
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10) || 0);
  const size = parseInt(c.req.query("size") || "0", 10) || 0;
  const pagedItems = size > 0 ? items.slice(offset, offset + size) : items;
  return c.json({ ...snap, items: pagedItems, total, currentMedia });
});

// Replace the queue and (for dlna/group) start playing from startIndex.
// For local peers this just persists the queue; the Web client starts Howl.
// Body: { items: QueueItem[], startIndex?: number }

app.post("/v1/peers/:peerId/queue/play", async (c) => {
  const peerId = decodePeerId(c);
  const { items, startIndex, position } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsItemsArray"), 400);
  const start = typeof startIndex === "number" ? startIndex : 0;
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  // 起始位置(流转场景:整队推送时把源端进度一起带过来)。
  const askPosition = typeof position === "number" && Number.isFinite(position) ? Math.max(0, position) : null;
  if (isCastPeer(parsed)) {
    // 成员被显式指派播放 → 先脱离活跃组再独立播(MA ensure_player_ungrouped)。
    await detachFromActiveGroups(parsed);
    try {
      await getQueueManager().playFrom(parsed.id, items, start, getDlnaBaseUrl(c));
    } catch (e: any) { return c.json({ error: e.message }, 500); }
    let landed: number | null = null;
    if (askPosition !== null && await seekPeerToSeconds(peerId, askPosition)) landed = askPosition;
    return c.json({ success: true, position: landed });
  }
  // local:起点随起播交出去(见 seekPeerToSeconds 上方注释)。
  pm.localPlayFrom(peerId, c.get("user")!.id, items, start, askPosition ?? undefined);
  return c.json({ success: true, position: askPosition });
});

// 队列流转:把**另一个播放端**的队列整体搬到目标端,并从同一位置起播。
//
// 与 /queue/play 的区别:那条是「客户端把队列交给我」,这条是「服务端自己从别人那儿取」。
// 请求体**不收 items** —— 队列实体本就由服务端持有(device_queues / local_queues 的
// items_json),所以零上传、任意规模队列(几千首)都是一次请求搞定,也不存在公网入口
// 对大队列 JSON 的体积闸门问题。
//
// 目标端的写入分派与 /queue/play **完全一致**(cast → playFrom / local → localPlayFrom),
// 播放模式也随队列一起带过去,保证流转后行为与原端一致。
//
// 源端停止**不在这里做**:由客户端在成功后复用 POST /peers/:id/stop —— 与既有的
// pullPeerToLocal(读队列 → 停源 → 目标起播)同款两步语义,避免在此重写各 kind 的停止分支。
//
// Body: { from: string }  from = 源端完整对外 peerId

app.post("/v1/peers/:peerId/queue/transfer-from", async (c) => {
  const toPeerId = decodePeerId(c);
  const { from, position: requestedPosition } = await c.req.json().catch(() => ({} as any));
  // 调用方显式给的起始位置(秒)。本机做源端时客户端的读数是**本地精确值**,且本机
  // 此刻已暂停、不再前进,比服务端镜像更新鲜,故优先用它;没传才回落到服务端读数。
  const askPosition = typeof requestedPosition === "number" && Number.isFinite(requestedPosition)
    ? Math.max(0, requestedPosition)
    : null;
  if (typeof from !== "string" || !from.trim()) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  }
  // from 是 **body 里的 peerId**,必须与 URL 参数走同一套解析(见 resolveBodyPeerId 注释):
  // 不解析就把对外掩码当真实键,查不到任何队列。
  const fromPeerId = resolveBodyPeerId(c, from.trim());
  if (fromPeerId === toPeerId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);

  // 源端**必须真实存在**。
  // 注意:resolveLocalPeerId 对「实例键反查不到」的情况会退回「本次请求的 clientId」
  // —— 那会让一个不存在的实例静默变成「调用方自己那条」,造成自我覆盖。故这里显式再判一次:
  // local 看 PeerManager 是否持有该实例;cast 端看 QueueController 是否有它的快照
  // (getQueueSnapshot 对未注册的 cast 端返回 undefined,但对 local 会返回空快照,不能当判据)。
  const srcSnap = pm.getQueueSnapshot(fromPeerId);
  const srcIsLocal = parsePeerId(fromPeerId)?.kind === "local";
  const srcExists = srcIsLocal ? !!pm.get(fromPeerId) : !!srcSnap;
  if (!srcExists) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);

  const src = srcSnap!;
  const items = Array.isArray(src.items) ? src.items : [];
  // 源端没内容:不算错误(与「搬了个空队列」等价),回 0 让调用方自行处理提示。
  if (items.length === 0) return c.json({ success: true, transferred: 0 });

  const start = typeof src.currentIndex === "number" && src.currentIndex >= 0 && src.currentIndex < items.length
    ? src.currentIndex
    : 0;

  const parsedTo = parsePeerId(toPeerId);
  if (!parsedTo) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  // ── 进度对齐:目标端出声的位置与流转前对齐(秒级) ────────────────────────
  // 读数**放在起播之后**:起播(尤其 DLNA 投递)要花 1~3s,这期间源端仍在播,
  // 读得越晚越贴近目标端真正出声的那一刻。
  let landedPosition: number | null = null;
  if (isCastPeer(parsedTo)) {
    // 流转目标是被托管成员 → 先脱离活跃组(MA ensure_player_ungrouped)。
    await detachFromActiveGroups(parsedTo);
    // ★ sendspin → sendspin:源端那条流在服务端是**现成解码好**的(泵 + PCM 窗口),
    //   把泵整体交给目标端即可立刻出声 —— 不重启 ffmpeg、不 seek、不预缓冲。
    //   武装必须在起播**之前**:起播那一步的 playCore 会消费它。
    const borrow = await tryArmSendspinBorrow(fromPeerId, toPeerId, askPosition);
    let startedIdx: number | null = null;
    try {
      startedIdx = await getQueueManager().playFrom(parsedTo.id, items, start, getDlnaBaseUrl(c));
    } catch (e: any) { return c.json({ error: e.message }, 500); }
    // 移交只在「目标端真的起播了源端那一首」且**确实落位**时才成立。任一不成立都走
    // 常规对齐 —— 且必须走:移交没发生就意味着目标端还在 0 秒。
    const playedSongId = items[startedIdx ?? start]?.songId;
    const handedOver =
      borrow.armed &&
      !!borrow.songId &&
      playedSongId === borrow.songId &&
      await borrowLandingConfirmed(toPeerId, borrow.positionSeconds);
    if (handedOver) {
      landedPosition = borrow.positionSeconds ?? null;
    } else {
      const pos = askPosition ?? await readPeerPositionSeconds(fromPeerId);
      if (pos !== null && pos > 0 && await seekPeerToSeconds(toPeerId, pos)) landedPosition = pos;
    }
  } else {
    // local 目标:起点必须**随起播**交出去(见 seekPeerToSeconds 上方注释)。
    const pos = askPosition ?? await readPeerPositionSeconds(fromPeerId);
    const at = pos !== null && pos > 0 ? pos : undefined;
    if (at !== undefined) landedPosition = at;
    pm.localPlayFrom(toPeerId, c.get("user")!.id, items, start, at);
  }

  // 播放模式随队列流转(队列换了模式却留在原端会显得"没搬全")。
  // 失败不影响流转本身 —— 队列与起播已经完成。
  const srcMode = typeof src.playMode === "string" ? src.playMode : null;
  if (srcMode && ["order", "one", "all", "shuffle"].includes(srcMode)) {
    try {
      if (isCastPeer(parsedTo)) getQueueManager().setPlayMode(parsedTo.id, srcMode as any);
      else pm.localSetPlayMode(toPeerId, srcMode as any);
    } catch { /* best-effort */ }
  }

  return c.json({ success: true, transferred: items.length, startIndex: start, position: landedPosition });
});

// 跳播到指定索引并立即播放。即使随机模式也尊重 index(随机仅作用于后续自动续播)。
// Body: { index: number }

app.post("/v1/peers/:peerId/queue/jump", async (c) => {
  const peerId = decodePeerId(c);
  const { index } = await c.req.json().catch(() => ({} as any));
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needIntegerIndex"), 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    // 成员被显式跳播 → 先脱离活跃组(MA ensure_player_ungrouped)。
    await detachFromActiveGroups(parsed);
    try {
      await getQueueManager().jumpTo(parsed.id, index, getDlnaBaseUrl(c));
      return c.json({ success: true });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  // local: 直接设当前索引,Web 客户端 Howl 跟进播放
  pm.localSetIndex(peerId, index);
  return c.json({ success: true });
});

// Append items to the queue without switching playback.
// Body: { items: QueueItem[] }

app.post("/v1/peers/:peerId/queue/enqueue", async (c) => {
  const peerId = decodePeerId(c);
  const { items } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsItemsArray"), 400);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    try {
      await getQueueManager().enqueue(parsed.id, items, getDlnaBaseUrl(c));
      return c.json({ success: true });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  pm.localEnqueue(peerId, c.get("user")!.id, items);
  return c.json({ success: true });
});

// Clear the queue.

app.delete("/v1/peers/:peerId/queue", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    getQueueManager().clear(parsed.id);
  } else {
    pm.localClear(peerId);
  }
  return c.json({ success: true });
});

// Mark a cast peer's queue inactive without clearing it (Web client stops cast:
// playback stops, the queue stays in DB for later reuse / restore skipping).

app.post("/v1/peers/:peerId/queue/deactivate", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) getQueueManager().deactivate(parsed.id);
  return c.json({ success: true });
});

// Remove a single item by index.

app.delete("/v1/peers/:peerId/queue/:index", async (c) => {
  const peerId = decodePeerId(c);
  const index = parseInt(c.req.param("index")!, 10);
  if (Number.isNaN(index)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidIndex"), 400);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    getQueueManager().removeAt(parsed.id, index, getDlnaBaseUrl(c));
  } else {
    pm.localRemoveAt(peerId, index);
  }
  return c.json({ success: true });
});

// Reorder a queue item (drag & drop). Body: { from: number, to: number }

app.post("/v1/peers/:peerId/queue/reorder", async (c) => {
  const peerId = decodePeerId(c);
  const body = await c.req.json().catch(() => ({} as any));
  const { from, to } = body;
  if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needIntegerFromTo"), 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    getQueueManager().reorder(parsed.id, from, to);
  } else {
    pm.localReorder(peerId, from, to);
  }
  return c.json({ success: true });
});

// Set the play mode (order | one | all | shuffle).
// Body: { mode: PlayMode }

app.post("/v1/peers/:peerId/play-mode", async (c) => {
  const peerId = decodePeerId(c);
  const { mode } = await c.req.json().catch(() => ({} as any));
  if (!["order", "one", "all", "shuffle"].includes(mode)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidMode"), 400);
  }
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    getQueueManager().setPlayMode(parsed.id, mode);
  } else {
    pm.localSetPlayMode(peerId, mode);
  }
  return c.json({ success: true });
});

// 本机洗牌序列(轻量端点:只回序列与游标,不拖全队列 items)。
// SPEC(player/types.ts):洗牌序列唯一权威在服务端,客户端只做镜像;
// 客户端 shuffle 推进前 GET 一次,epoch 变了就重新定位当前曲位置。

app.get("/v1/peers/:peerId/queue/shuffle", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed || isCastPeer(parsed)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  }
  const snap = pm.getQueueSnapshot(peerId);
  if (!snap) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  return c.json(localShuffleInfo(snap));
});

// 显式重洗本机队列的洗牌序列(客户端在序列尾回绕时调用,自动重洗语义)。
// 返回新序列(轻量形状,epoch +1 供客户端换版检测)。投屏/群组队列的重洗由
// QueueController 在切歌时自管,不走这里。

app.post("/v1/peers/:peerId/queue/reshuffle", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed || isCastPeer(parsed)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  }
  const snap = pm.reshuffleLocal(peerId);
  if (!snap) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  return c.json(localShuffleInfo(snap));
});

// 服务器端定时暂停（sleep timer）。仅对投屏/群组(链路 A)生效:播放由服务器
// 进行,只有服务器自己计时才可靠(客户端 App 关闭/掉线后定时仍生效)。
// 本机/客户端 DLNA 直投的定时由客户端本地倒计时实现,此处返回不支持。
// Body: { durationSeconds: number }
// 设 0 / 无 body 无效;DELETE 取消。

app.post("/v1/peers/:peerId/sleep-timer", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed || !isCastPeer(parsed)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.castPeerOnly"), 400);
  }
  const body = await c.req.json().catch(() => ({} as any));
  const seconds = Math.floor(Number(body?.durationSeconds));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidDuration"), 400);
  }
  getQueueManager().setSleepTimer(parsed.id, seconds * 1000);
  return c.json({ success: true, remainingMs: getQueueManager().sleepTimerRemaining(parsed.id) });
});

app.delete("/v1/peers/:peerId/sleep-timer", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (parsed && isCastPeer(parsed)) getQueueManager().clearSleepTimer(parsed.id);
  return c.json({ success: true });
});

app.get("/v1/peers/:peerId/sleep-timer", (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed || !isCastPeer(parsed)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.castPeerOnly"), 400);
  }
  const remaining = getQueueManager().sleepTimerRemaining(parsed.id);
  return c.json(remaining == null ? { active: false } : { active: true, remainingMs: remaining });
});

// Report the current track index for a local peer (Web client → backend).
// Body: { index: number }

app.post("/v1/peers/:peerId/queue/index", async (c) => {
  const peerId = decodePeerId(c);
  const { index } = await c.req.json().catch(() => ({} as any));
  if (typeof index !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needIndex"), 400);
  const parsed = parsePeerId(peerId);
  if (!parsed || parsed.kind !== "local") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.localPeerOnly"), 400);
  pm.localSetIndex(peerId, index);
  return c.json({ success: true });
});

// ==================== Peer transport controls ====================
// 对 dlna / airplay / sendspin / group:直接命令设备。
// 对 local(安卓 / Windows / 浏览器的本机实例):**定向下发**给目标实例自己的 WS
// 连接,由它执行 —— 此处曾经是 no-op(旧假设「Web 客户端自己持有音频」,只为了让
// HA 复用同一套 URL 形状);本机实例接入播放器体系后改为真下发。
// 返回 delivered:目标离线(无 WS 连接)时为 false —— 前端据此给「设备离线」反馈,
// 而不是假装成功。队列类操作(点歌/加歌/清空/切歌)不走这里:它们直接写服务端权威
// 队列,由 peer_queue_changed 广播 + updatedAt 仲裁让目标实例跟随。
// ==================== 播放进度对齐(流转 / 带进度起播) ====================
//
// 起播接口(playFrom / localPlayFrom)**没有「起始位置」参数**,队列快照里也没有
// position 字段 —— 所以进度只能**两段式**带过去:先按既有链路起播,再把目标端
// 落到源端的进度上。
//
// 两种目标的收尾方式不同,不能混:
//   - cast(dlna / group / airplay / sendspin):起播已 await 完成,设备或推流引擎
//     已接管 ⇒ 服务端**自己 seek**,一定落在正在播的那一首上;
//   - local:音频会话活在客户端进程里,服务端只能下令;而客户端此刻**还没起播**
//     (它是收到 peer_queue_changed 之后才起播的),此时下令必然落空 ⇒ 改为在
//     localPlayFrom 时把起点塞进当次快照(startPosition),客户端起播后自行落位。
//
// seek 的分派与 POST /v1/peers/:peerId/seek **完全一致**(同一套 kind 分支),
// 保证五种 kind 的手感与既有 seek 没有任何差别。

/** 读某个播放端此刻的实时进度(秒)。读不到(未知 kind / 离线 / 无上报)→ null。 */

app.post("/v1/peers/:peerId/play", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (parsed.kind === "dlna") {
    try {
      await detachFromActiveGroups(parsed);
      getQueueController().resumePlayback(parsed.id);
      await playDevice(parsed.id);
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try {
      getQueueController().resumePlayback(parsed.id);
      await getQueueController().transport(parsed.id, "play");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    try {
      getQueueController().resumePlayback(parsed.id);
      await getQueueController().transport(parsed.id, "play");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "sendspin") {
    try {
      await detachFromActiveGroups(parsed);
      getQueueController().resumePlayback(parsed.id);
      await getQueueController().transport(parsed.id, "play");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "local") return c.json(dispatchPeerCommand(peerId, "play"));
  return c.json({ success: true });
});

app.post("/v1/peers/:peerId/pause", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (parsed.kind === "dlna") {
    try { await pauseDevice(parsed.id); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try { await getQueueController().transport(parsed.id, "pause"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    try { await getQueueController().transport(parsed.id, "pause"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "sendspin") {
    try { await getQueueController().transport(parsed.id, "pause"); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "local") return c.json(dispatchPeerCommand(peerId, "pause"));
  return c.json({ success: true });
});

app.post("/v1/peers/:peerId/stop", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (parsed.kind === "dlna") {
    try {
      getQueueController().stopPlayback(parsed.id);
      await stopDevice(parsed.id);
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try {
      getQueueController().stopPlayback(parsed.id);
      await getQueueController().transport(parsed.id, "stop");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    try {
      getQueueController().stopPlayback(parsed.id);
      await getQueueController().transport(parsed.id, "stop");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "sendspin") {
    try {
      getQueueController().stopPlayback(parsed.id);
      await getQueueController().transport(parsed.id, "stop");
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "local") return c.json(dispatchPeerCommand(peerId, "stop"));
  return c.json({ success: true });
});

// 彻底重置一个播放端的播放状态(流转播放「搬走」/ 回收站「销毁」的源端收尾)。
//
// 与 DELETE /queue 的区别:那条只清队列实体,**运行态各留各的** ——
//   - cast 端:设备传输本身、设备端媒体缓存、洗牌序列、定时暂停、预探测;
//   - local 端:本机实例的 /local-status 上报(state / position / volume / songId)。
// 于是「队列已空」却在 GET /status 里仍被报成在播 —— 这正是流转后源端残留的来源。
// 本端点一次做完「停止 + 清空 + 清运行态」,语义 = 「这个端现在什么都没在播」。
//
// **刻意保留**:peer 注册(列表里还在,不会消失)、playMode(用户设定,
// 不该被一次搬移或销毁带走)。

app.post("/v1/peers/:peerId/reset", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);

  if (isCastPeer(parsed)) {
    // 先停传输(与 /stop 同款分支),再 clear —— clear 内部还会清 items / 游标 /
    // isActive / ended / 洗牌序列 / 设备端 currentMedia / 预探测 / 定时暂停,
    // 并广播 media_changed 让所有客户端立刻清掉封面与歌词,不必等下一轮轮询。
    try {
      if (parsed.kind === "dlna") {
        getQueueController().stopPlayback(parsed.id);
        await stopDevice(parsed.id);
      } else {
        getQueueController().stopPlayback(parsed.id);
        await getQueueController().transport(parsed.id, "stop");
      }
      getQueueController().clear(parsed.id);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
    return c.json({ success: true });
  }

  // local:清队列元数据 + 丢弃该端的状态上报(否则 /status 仍叠加旧 state / songId)。
  pm.localClear(peerId);
  pm.clearLocalStatusReport(peerId);
  return c.json({ success: true });
});

app.post("/v1/peers/:peerId/next", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    try { await detachFromActiveGroups(parsed); seekLog.info(`[Peer] 手动切歌 next peerId=${peerId}`); await getQueueManager().next(parsed.id, getDlnaBaseUrl(c)); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "local") return c.json(dispatchPeerCommand(peerId, "next"));
  return c.json({ success: true });
});

app.post("/v1/peers/:peerId/prev", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (isCastPeer(parsed)) {
    try { await detachFromActiveGroups(parsed); seekLog.info(`[Peer] 手动切歌 prev peerId=${peerId}`); await getQueueManager().prev(parsed.id, getDlnaBaseUrl(c)); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "local") return c.json(dispatchPeerCommand(peerId, "prev"));
  return c.json({ success: true });
});

app.post("/v1/peers/:peerId/seek", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  // 五种 kind 的入参契约完全一致(seconds 优先,兼容 position),先统一解析再分派 ——
  // 这样日志能一次带齐 target,不必在各分支重复打。
  const body = await c.req.json().catch(() => ({} as any));
  const rawSeconds = typeof body?.seconds === "number" ? body.seconds : body?.position;
  if (typeof rawSeconds !== "number" || !Number.isFinite(rawSeconds)) {
    seekLog.debug(`[seek] 拒绝 peerId=${peerId} kind=${parsed.kind} 缺 seconds/position body=${JSON.stringify(body)?.slice(0, 120)}`);
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsSecondsOrPosition"), 400);
  }
  // ★ 精度守卫(最小粒度 1 秒):本路由是所有客户端(网页/卡片/客户端/HA 集成)seek 的
  //   唯一入口,只有在这里兜底才能保证「任何来源都不可能把非整秒目标送进流式引擎」。
  //   非整秒目标会让子进程按 25ms 帧栅格取帧时与窗口的毫秒基准错位 → 纯微任务自旋 →
  //   事件循环饿死 → 心跳超时被 65s 看门狗 SIGKILL(见 utils/seekGranularity.ts 的硬约束)。
  //   客户端本就下发 Duration.inSeconds(整秒),故此处对它是恒等变换。
  //   注:不走 HTTP 的内部路径(QueueController → player.seek)不受本层约束,
  //   由 streamEngine 的帧栅格对齐(alignFrameMs)+ 亚帧容错兜底。
  const seconds = alignSeekSeconds(rawSeconds);
  // debug:seek 请求入口。前端有 250ms 防抖,但"连拖/多点"仍可能并发打到后端 ——
  // 同一 tid 的多条 = 同一个请求链;不同 tid 短时间扎堆(且 target 各异)= 前端没收敛住的重投风暴。
  // 同时打印对齐前后:事后可区分「前端根本没对齐」与「后端按粒度抹掉了零头」。
  seekLog.debug(
    `[seek] 收到 peerId=${peerId} kind=${parsed.kind} target=${rawSeconds.toFixed(2)}s→${seconds}s`
      + (rawSeconds === seconds ? "" : "(已按最小粒度 1s 对齐)"),
  );
  // seek 冷静期打标:本路由是所有客户端(网页/卡片/客户端/HA 集成)seek 的唯一入口,
  // 在这里打标才能覆盖 DLNA 那条**不经 transport()**的直连路径。
  // 用途:seek 重定位期间设备必然短暂非 PLAYING,此窗口内的 IDLE 不得被判成"真结束"
  // 而放行切歌 —— 否则表现就是「拖动后进度条归零」(见 services/player/seekSettle.ts)。
  markSeekIssued(parsed.id);
  const t0 = Date.now();
  if (parsed.kind === "dlna") {
    try { await seekDevice(parsed.id, seconds); }
    catch (e: any) { seekLog.warn(`[seek] dlna ${parsed.id} → ${seconds.toFixed(2)}s 失败 ${Date.now() - t0}ms: ${e?.message || e}`); return c.json({ error: e.message }, 500); }
  } else if (parsed.kind === "group" || parsed.kind === "airplay" || parsed.kind === "sendspin") {
    try { await getQueueController().transport(parsed.id, "seek", seconds); }
    catch (e: any) { seekLog.warn(`[seek] ${parsed.kind} ${parsed.id} → ${seconds.toFixed(2)}s 失败 ${Date.now() - t0}ms: ${e?.message || e}`); return c.json({ error: e.message }, 500); }
  } else if (parsed.kind === "local") {
    const res = dispatchPeerCommand(peerId, "seek", { seconds }) as { success: boolean; delivered?: boolean };
    // delivered=false = 目标实例没有 WS 连接(离线)或是不再被控的 web 端 ——
    // 「拖了没反应」在服务端侧最常见的根因就是这一条,必须显式打出来。
    seekLog.debug(`[seek] local ${peerId} → ${seconds.toFixed(2)}s delivered=${res?.delivered} ${Date.now() - t0}ms`);
    return c.json(res);
  }
  seekLog.debug(`[seek] 完成 peerId=${peerId} target=${seconds.toFixed(2)}s ${Date.now() - t0}ms`);
  return c.json({ success: true });
});

/** sendspin 音量/静音写成功后广播 WS peer_volume_changed(其它端音量条即时同步)。
 *  载荷 = 当前快照 + 本次 patch:fork 模式下主进程镜像可能尚未随 RPC 刷新,
 *  以本次写入值为准可避免广播出旧值。非 sendspin / 解析失败静默跳过。 */

app.post("/v1/peers/:peerId/volume", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (parsed.kind === "dlna") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsVolume"), 400);
    try { await setDeviceVolume(parsed.id, volume); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsVolume"), 400);
    try {
      // 组音量**先落库**(无成员也持久,重启恢复);再扇出到在线成员。
      // 扇出失败不回滚库值 —— 成员全离线时仍要保住用户的调节结果。
      gm.setVolume(parsed.id, volume);
      await getQueueController().transport(parsed.id, "volume", volume);
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsVolume"), 400);
    try { await getQueueController().transport(parsed.id, "volume", volume); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "sendspin") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsVolume"), 400);
    try {
      await getQueueController().transport(parsed.id, "volume", volume);
      // 落库在 setVolumeCore(播控唯一咽喉)内完成;这里只管写成功后的回显广播。
      broadcastSendspinVolume(peerId, { volume });
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "local") {
    const { volume } = await c.req.json().catch(() => ({} as any));
    if (typeof volume !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsVolume"), 400);
    return c.json(dispatchPeerCommand(peerId, "volume", { volume }));
  }
  return c.json({ success: true });
});

// 播报(TTS)。Body: { url: string, volume?: number, blocking?: boolean }
// 打断当前播放放一段外链音频,播完自动回到原曲原进度(详见 dlna/announce.ts)。
// 默认非阻塞:立刻 202 返回,播报在后台跑完 —— HA 的 play_media 调用不该被一段
// 30 秒的语音卡在那里。blocking=true 时才等播报全程结束再响应。

app.post("/v1/peers/:peerId/announce", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  const body = await c.req.json().catch(() => ({} as any));
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.urlRequired"), 400);
  const volume = typeof body.volume === "number" ? body.volume : undefined;

  if (body.blocking === true) {
    try {
      const r = await announceOnPeer({ peerId, url, volume });
      return c.json({ success: true, ...r });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (isAnnouncing(peerId)) return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.renderer.announcing"), 409);
  announceOnPeer({ peerId, url, volume }).catch((e: any) => {
    log.warn(`[announce] ${peerId}: ${e?.message || e}`);
  });
  return c.json({ success: true, accepted: true }, 202);
});

// 静音开关。Body: { muted: boolean }
// 与音量是两条独立的 RenderingControl 状态量:静音不动 Volume,取消静音后设备
// 自己恢复原音量。因此不能用"音量设 0 / 存旧值再还原"来模拟——那样设备侧物理
// 调音量时会把我们存的旧值弄脏。

app.post("/v1/peers/:peerId/mute", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  const { muted } = await c.req.json().catch(() => ({} as any));
  if (typeof muted !== "boolean") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsMuted"), 400);
  if (parsed.kind === "dlna") {
    try { await setDeviceMute(parsed.id, muted); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    // 组没有自己的渲染器,静音要逐台成员下发。个别成员不支持静音时不应连累
    // 其余设备,所以全部并发执行后再汇总——只有全员失败才算失败。
    // 成员按 kind 分流:dlna 走 RenderingControl,sendspin 走组/连接双置位。
    const members = gm.get(parsed.id)?.memberIds || [];
    if (members.length === 0) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.group.empty"), 400);
    const results = await Promise.allSettled(members.map(m => {
      const s = splitMemberId(m);
      if (s?.kind === "sendspin") return setSendspinMemberMuted(s.id, muted);
      return setDeviceMute(s?.id ?? m, muted);
    }));
    const ok = results.filter(r => r.status === "fulfilled").length;
    if (ok === 0) {
      const reason = results[0].status === "rejected" ? (results[0] as PromiseRejectedResult).reason : null;
      return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, reason?.message || "errors.group.muteUnsupported"), 500);
    }
    return c.json({ success: true, applied: ok, total: members.length });
  }
  if (parsed.kind === "airplay") {
    try { await setAirPlayMuted(parsed.id, muted); return c.json({ success: true }); }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "sendspin") {
    // 与 DLNA RenderingControl SetMute 同语义:独立于音量的开关,取消恢复原音量。
    // 组即该客户端专属组(见 protocolPlayer),两处都置位;离线重连后组标记仍有效。
    try {
      await setSendspinMemberMuted(parsed.id, muted);
      return c.json({ success: true });
    }
    catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  return c.json({ success: true });
});

// sendspin 单成员静音(组/连接双置位,见上;用户组成员与单设备共用语义):
// 组 mute 即设备级 mute(对照 DLNA setDeviceMute 逐台下发)。
// 落库与 setMutedCore 同(路由 in-proc 直接置位不经过 core,在此补持久化)。

app.get("/v1/peers/:peerId", (c) => {
  const peerId = decodePeerId(c);
  const p = getPeerManager().get(peerId);
  if (!p) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  return c.json({ peer: { ...p, queue: getPeerManager().getQueueSnapshot(peerId) } });
});

app.get("/v1/peers/:peerId/status", async (c) => {
  const peerId = decodePeerId(c);
  const parsed = parsePeerId(peerId);
  if (!parsed) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 400);
  if (parsed.kind === "dlna") {
    try {
      const deviceId = parsed.id;
      const status = await getDeviceStatus(deviceId);
      const evt = getEventManager().getEventState(deviceId);
      if (evt) {
        if (evt.state) status.state = evt.state;
        // NOTE: position/duration 一律用 SOAP 实时值(status 已含)。GENA 事件在播放中
        // 不会持续上报 RelTime,evt.position 会停在上次 seek/切歌的旧值;用它覆盖 SOAP 的真实
        // 递增 position 会把前端进度每轮询周期打回旧值,表现为进度不前进。故此处不覆盖 position/duration。
        if (typeof evt.volume === "number") status.volume = evt.volume;
        if (typeof evt.muted === "boolean") status.muted = evt.muted;
        // 事件驱动下 position 是 GENA 推送时的采样,updatedAt(EventState)比 SOAP 轮询时刻更贴近。
        if (typeof evt.updatedAt === "number" && evt.updatedAt > 0) status.updatedAt = evt.updatedAt;
      }
      return c.json(status);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "group") {
    try {
      const status = await getGroupStatus(parsed.id);
      const evt = getEventManager().getEventState(getGroupLeaderDeviceId(parsed.id) || "");
      if (evt) {
        if (evt.state) status.state = evt.state;
        // NOTE: position/duration 一律用 SOAP 实时值(status 已含)。GENA 事件在播放中
        // 不会持续上报 RelTime,evt.position 会停在上次 seek/切歌的旧值;用它覆盖 SOAP 的真实
        // 递增 position 会把前端进度每轮询周期打回旧值,表现为进度不前进。故此处不覆盖 position/duration。
        if (typeof evt.volume === "number") status.volume = evt.volume;
        if (typeof evt.muted === "boolean") status.muted = evt.muted;
        if (typeof evt.updatedAt === "number" && evt.updatedAt > 0) status.updatedAt = evt.updatedAt;
      }
      return c.json(status);
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  if (parsed.kind === "airplay") {
    return c.json(getAirPlayPeerStatus(parsed.id));
  }
  // sendspin:进程内播放器的实时状态(Position/Duration 由推流引擎驱动)。
  if (parsed.kind === "sendspin") {
    try {
      const st = await getQueueController().getPlayerState(parsed.id);
      if (!st) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidPeerId"), 404);
      const srv = getSendspinFront();
      // 音量权威 = 组音量(setVolume 只写组;conn.volume 是每连接 trim,恒 100)。
      // 离线(组缺席 / 服务未跑)回退持久库值 —— 已离线端也看得到上次音量,
      // 无行则 100/false(与「首次上线缺省 100」一致)。取值口径与 peer 列表回显同源。
      const vol = getSendspinDeviceVolume(parsed.id);
      return c.json({
        state: st.playbackState === PlaybackState.PLAYING ? "PLAYING"
          : st.playbackState === PlaybackState.PAUSED ? "PAUSED_PLAYBACK"
          : st.playbackState === PlaybackState.BUFFERING ? "BUFFERING"
          : "STOPPED",
        position: st.position,
        duration: st.duration,
        updatedAt: st.updatedAt,
        volume: vol.volume,
        muted: vol.muted,
        // 当前曲:各端靠 media.songId 变化刷新歌词/封面,缺了切歌后还挂第一首。
        media: srv?.currentMedia(parsed.id),
      });
    } catch (e: any) { return c.json({ error: e.message }, 500); }
  }
  // local:队列快照(权威队列)+ 本机实例上报的传输状态(state / position / duration /
  // volume)。上报是**附加**字段:对端轮询时据此镜像进度条与播放按钮;无上报(该端
  // 旧版本 / 已离线)则只得队列,前端退回「未播放」——队列镜像与恢复不受影响。
  // 注意 updatedAt 保持队列行的值(客户端用它做恢复新鲜度竞速,不能被上报时间盖掉)。
  const localSnap = pm.getQueueSnapshot(peerId);
  if (!localSnap) return c.json({});
  const rep = pm.getLocalStatusReport(peerId);
  if (!rep) return c.json(localSnap);
  return c.json({
    ...localSnap,
    state: rep.state,
    position: rep.position,
    duration: rep.duration,
    ...(typeof rep.volume === "number" ? { volume: rep.volume } : {}),
    reportedAt: rep.reportedAt,
    // 对端靠 media.songId 变化刷新歌词/封面(与 dlna/sendspin 同构)。
    ...(rep.songId ? { media: { songId: rep.songId } } : {}),
  });
});

// ==================== 播放器群组 API ====================
// 一个组聚合多台设备(组持队列,播放时向成员投递同一首歌,
// 仿 MA Sync Group / Universal Group)。成员勾选提交全量 memberIds(PUT),
// 移动端随时加减走增量口(POST members)。成员 id 命名空间化:
// `sendspin:<clientId>` / `dlna:<deviceId>` / 裸 id(历史数据＝DLNA)。
// 组播放控制复用 peer API:peerId = "group:<groupId>"。
}
