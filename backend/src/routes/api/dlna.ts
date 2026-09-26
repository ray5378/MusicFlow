// 自动生成 —— 由 index.ts 物理拆分而来（dlna 域，26 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  PERM,
  and,
  apiError,
  canUseRenderer,
  castToDevice,
  createCastSession,
  db,
  deleteDeviceRecord,
  deviceQueues,
  enqueueNextTrack,
  ensurePlayableStream,
  eq,
  fs,
  getCachedDevices,
  getCurrentMedia,
  getDeviceStatus,
  getDlnaBaseUrl,
  getEventManager,
  getGroupManager,
  getPeerManager,
  getQueueController,
  getQueueManager,
  isDeviceDisabled,
  like,
  markStaleDevices,
  or,
  path,
  pauseDevice,
  permMiddleware,
  playDevice,
  probeLocalSourceOk,
  refreshDevices,
  rendererGrantParamMiddleware,
  seekDevice,
  serializeDlnaDevices,
  setDeviceAlias,
  setDeviceDisabled,
  setDeviceMute,
  setDeviceVolume,
  shouldRefreshDevices,
  songs,
  stopDevice,
} from "./shared.js";

export function registerDlna(app: Hono): void {
app.use("/v1/dlna/devices/:deviceId/*", rendererGrantParamMiddleware("dlna"));

app.get("/v1/dlna/devices", async (c) => {
  if (shouldRefreshDevices() || getCachedDevices().length === 0) {
    await refreshDevices();
  }
  const user = c.get("user");
  // 返回设备(在线 + 离线)。离线设备保留在列表,供「播放器」页管理(改名/删除)。
  let devices = serializeDlnaDevices(markStaleDevices(getCachedDevices()));
  if (user && !user.isAdmin) {
    devices = devices.filter((d) => !d.disabled && canUseRenderer(user.id, false, `dlna:${d.id}`));
  }
  return c.json({ devices });
});

// Force a fresh SSDP discovery scan.(需 renderer.use —— 普通用户被授予播放器能力后可扫描)

app.post("/v1/dlna/scan", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const user = c.get("user");
  let devices = serializeDlnaDevices(await refreshDevices());
  if (user && !user.isAdmin) {
    devices = devices.filter((d) => !d.disabled && canUseRenderer(user.id, false, `dlna:${d.id}`));
  }
  return c.json({ devices });
});

// 重命名 DLNA 设备(自定义显示名 alias)。Body: { alias } — 空串恢复原始名。
// alias 会同步到播放控件/HA 卡片显示(peer.name = alias || name)。
// 管理播放器能力:renderer.manage。

app.put("/v1/dlna/devices/:deviceId", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (alias.length > 50) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.nameTooLong"), 400);
  const dev = setDeviceAlias(deviceId, alias);
  if (!dev) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.deviceNotFound"), 404);
  // 立即触发 peer reconcile,让播放控件/HA 卡片显示新名字(不等 60s tick)。
  getPeerManager().reconcileDlnaPeers();
  return c.json({
    success: true,
    device: {
      id: dev.id, name: dev.name, alias: dev.alias || "",
      displayName: dev.alias || dev.name,
      manufacturer: dev.manufacturer, model: dev.model,
      hasVolumeControl: !!dev.renderingControlUrl,
      available: dev.available,
    },
  });
});

// 删除 DLNA 设备(通常删除离线的)。同时清理:群组成员、设备队列、peer、DB 记录。
// 管理播放器能力:renderer.manage。

app.delete("/v1/dlna/devices/:deviceId", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const deviceId = c.req.param("deviceId")!;
  // 1. 从所有播放器群组中移除该成员。
  getGroupManager().removeDeviceFromAllGroups(deviceId);
  // 2. 停止并清空设备队列(如果有),并删除持久化队列行。
  try { getQueueController().clear(deviceId); } catch { /* ignore */ }
  db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
  // 3. 移除 peer(播放控件/HA 卡片不再出现)。
  getPeerManager().removeDlnaPeer(deviceId);
  // 4. 删除缓存 + runtimes + DB 记录。
  const existed = deleteDeviceRecord(deviceId);
  if (!existed) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.deviceNotFound"), 404);
  // 5. 广播设备列表变化(WS → 卡片/Web 刷新)。
  getEventManager().emitDeviceListChanged(getCachedDevices().length);
  return c.json({ success: true });
});

// 禁用/启用 DLNA 设备。禁用后:从所有流转播放的入口消失(peer 移除 + WS 不推送)、
// 停止播放并清空队列、从所有播放器群组移除、不可投屏(castToDevice 校验);启用则恢复。
// 管理播放器能力:renderer.manage。

app.put("/v1/dlna/devices/:deviceId/disabled", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const disabled = !!body.disabled;
  if (disabled) {
    // 1. 从所有播放器群组中移除该成员。
    getGroupManager().removeDeviceFromAllGroups(deviceId);
    // 2. 停止并清空设备队列(如果有),并删除持久化队列行。
    try { getQueueController().clear(deviceId); } catch { /* ignore */ }
    db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
  }
  const dev = setDeviceDisabled(deviceId, disabled);
  if (!dev) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.deviceNotFound"), 404);
  // 3. 立即同步 peer 列表(禁用→移除 peer 并推 peer_unavailable;启用→重新注册)。
  getPeerManager().reconcileDlnaPeers();
  // 4. 广播设备列表变化(WS → 卡片/Web 刷新)。
  getEventManager().emitDeviceListChanged(getCachedDevices().length);
  return c.json({
    success: true, disabled,
    device: {
      id: dev.id, name: dev.name, alias: dev.alias || "",
      displayName: dev.alias || dev.name,
      manufacturer: dev.manufacturer, model: dev.model,
      hasVolumeControl: !!dev.renderingControlUrl,
      available: dev.available,
      disabled: !!dev.disabled,
    },
  });
});

// Cast a song to a DLNA renderer.
// 为客户端投屏入口生成“无鉴权”流 URL 的一次性 token。
// 部分渲染器(如 OpenWrt 上的 GMediaRender)拉流时无法携带 Subsonic 的 u/t/s 鉴权
// 参数,只能拉纯 URL 的流 —— 客户端直接下发 /rest/stream?u&t&s 会因鉴权解析失败无声。
// 这里先用 songId 注册一个临时 cast session,服务端以 /rest/dlna/stream/:token
// 免鉴权回源;客户端用**自身的公网 baseUrl** 拼出最终 URL(服务端这里只回相对路径,
// 避免把 LAN IP 推给设备)。token 短期有效(6h),且该端点本身受 authMiddleware 保护。

app.post("/v1/dlna/stream-url", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const songId = body.songId;
  if (!songId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.songIdRequired"), 400);
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.song.notFound"), 404);
  // 投前预检(P1-2):签发 token 前确认这首歌当前真的有可用音源,全类型覆盖 ——
  //  - web 行(在线插件源):有本地缓存文件即可播;否则 ensurePlayableStream 做
  //    Range 探测 + 多源换源(失败会回写可用链,命中即缓存,后续投播零成本);
  //  - local/webdav 行:probeLocalSourceOk(本地 existsSync 零成本 / WebDAV HEAD
  //    带 5 分钟失败记忆);主源不可用但组内有 web 备选时放行 —— 流播时会经
  //    resolvePreferredSong 自动切换,预检不越权替它做决定。
  // 验不过 → 409「无可用音源」:客户端收到后直接跳下一首,设备不再吃死链干等。
  {
    const fs = await import("fs");
    let playable = false;
    if ((song.type || "local") === "web") {
      if (song.cachePath && fs.existsSync(song.cachePath)) {
        playable = true;
      } else if (song.pluginEntry) {
        playable = !!(await ensurePlayableStream(song as any));
      } else {
        playable = !!song.url;
      }
    } else if (await probeLocalSourceOk(song as any)) {
      playable = true;
    } else if (song.groupId) {
      playable = !!db
        .select({ id: songs.id })
        .from(songs)
        .where(and(eq(songs.groupId, song.groupId), eq(songs.type, "web")))
        .limit(1)
        .get();
    }
    if (!playable) {
      return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, "errors.song.noPlayableSource"), 409);
    }
  }
  const deviceId = typeof body.deviceId === "string" && body.deviceId ? body.deviceId : "client-cast";
  const { token, expiresAt } = createCastSession(songId, deviceId, getDlnaBaseUrl(c));
  return c.json({ token, streamUrl: `/rest/dlna/stream/${token}`, expiresAt });
});

app.post("/v1/dlna/cast", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body;
  if (!songId || !deviceId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsSongIdAndDeviceId"), 400);
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.song.notFound"), 404);
  const { resolveDlnaOutput } = await import("../../services/audio/pipeline.js");
  const mime = resolveDlnaOutput(song.suffix).mime;
  try {
    await castToDevice({
      songId, deviceId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime,
      baseUrl: getDlnaBaseUrl(c),
      coverArt: song.coverArt || undefined,
    });
    return c.json({ success: true, message: `已投屏到设备` });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.cast.screenFailed"), 500);
  }
});

// Preload the next track on the device for gapless playback (SetNextAVTransportURI).
// The frontend calls this after a successful cast, and again whenever the
// device finishes a track, so the next song is ready before the current one ends.

app.post("/v1/dlna/enqueue", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body;
  if (!songId || !deviceId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsSongIdAndDeviceId"), 400);
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.song.notFound"), 404);
  const { resolveDlnaOutput } = await import("../../services/audio/pipeline.js");
  const mime = resolveDlnaOutput(song.suffix).mime;
  try {
    const supported = await enqueueNextTrack({
      songId, deviceId,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime,
      baseUrl: getDlnaBaseUrl(c),
      coverArt: song.coverArt || undefined,
    });
    return c.json({ success: true, enqueueSupported: supported });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.cast.preloadFailed"), 500);
  }
});

// Transport controls.

app.post("/v1/dlna/devices/:deviceId/play", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  if (isDeviceDisabled(deviceId)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.deviceDisabled"), 403);
  try { await playDevice(deviceId); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/v1/dlna/devices/:deviceId/pause", async (c) => {
  try { await pauseDevice(c.req.param("deviceId")); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/v1/dlna/devices/:deviceId/stop", async (c) => {
  try { await stopDevice(c.req.param("deviceId")); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/v1/dlna/devices/:deviceId/seek", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Accept either `seconds` (frontend) or `position` (HA integration) for
  // the seek target, in seconds.
  const seconds = typeof body.seconds === "number" ? body.seconds : body.position;
  if (typeof seconds !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsSecondsOrPosition"), 400);
  try { await seekDevice(c.req.param("deviceId"), seconds); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/v1/dlna/devices/:deviceId/volume", async (c) => {
  const { volume } = await c.req.json().catch(() => ({}));
  if (typeof volume !== "number") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsVolume"), 400);
  try { await setDeviceVolume(c.req.param("deviceId"), volume); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/v1/dlna/devices/:deviceId/mute", async (c) => {
  const { muted } = await c.req.json().catch(() => ({}));
  if (typeof muted !== "boolean") return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsMuted"), 400);
  try { await setDeviceMute(c.req.param("deviceId"), muted); return c.json({ success: true }); }
  catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Query device status (state / position / duration / volume).
// Merges the freshest GENA event state (if any) with a live SOAP snapshot so
// the frontend gets low-latency updates from event push + a periodic SOAP
// ground-truth to correct any drift.

app.get("/v1/dlna/devices/:deviceId/status", async (c) => {
  try {
    const deviceId = c.req.param("deviceId");
    const status = await getDeviceStatus(deviceId);
    const evt = getEventManager().getEventState(deviceId);
    if (evt) {
      // Event state is fresher for the fields it carries; prefer it over SOAP
      // when available, but keep SOAP as the fallback (events may lag).
      if (evt.state) status.state = evt.state;
      if (typeof evt.position === "number" && evt.position > 0) status.position = evt.position;
      if (typeof evt.duration === "number" && evt.duration > 0) status.duration = evt.duration;
      if (typeof evt.volume === "number") status.volume = evt.volume;
      if (typeof evt.muted === "boolean") status.muted = evt.muted;
    }
    return c.json(status);
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ==================== Queue management ====================
// Per-device playback queue. Used by the HA integration's play_media (album /
// playlist) and next/prev track commands. baseUrl is resolved from the
// request host so DLNA renderers can pull the stream back from this server.

app.get("/v1/dlna/devices/:deviceId/queue", (c) => {
  const deviceId = c.req.param("deviceId")!;
  // 新 QueueSnapshot 不再带 currentMedia(改为 ended);路由层补回以保持前端/HA 响应形状兼容。
  return c.json({ ...getQueueManager().snapshot(deviceId), currentMedia: getCurrentMedia(deviceId) });
});

// Replace the queue and start playing from `startIndex` (default 0).
// Body: { items: QueueItem[], startIndex?: number }

app.post("/v1/dlna/devices/:deviceId/queue/play", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const { items, startIndex } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsItemsArray"), 400);
  try {
    await getQueueManager().playFrom(deviceId, items, startIndex || 0, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Append items to the queue without switching playback.
// Body: { items: QueueItem[] }

app.post("/v1/dlna/devices/:deviceId/queue/enqueue", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const { items } = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(items)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsItemsArray"), 400);
  try {
    await getQueueManager().enqueue(deviceId, items, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/v1/dlna/devices/:deviceId/next", async (c) => {
  try {
    await getQueueManager().next(c.req.param("deviceId")!, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/v1/dlna/devices/:deviceId/prev", async (c) => {
  try {
    await getQueueManager().prev(c.req.param("deviceId")!, getDlnaBaseUrl(c));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.delete("/v1/dlna/devices/:deviceId/queue", (c) => {
  getQueueManager().clear(c.req.param("deviceId")!);
  return c.json({ success: true });
});

// List all devices that currently have an active queue. The Web frontend
// calls this on load to restore the cast state (which device was playing,
// what queue, what index) after the tab was closed or the backend restarted.

app.get("/v1/dlna/active", (c) => {
  // 每个 snapshot 补 currentMedia,保持原响应形状(新 QueueSnapshot 改用 ended)。
  const active = getQueueManager().activeDevices().map((a) => ({
    deviceId: a.deviceId,
    snapshot: { ...a.snapshot, currentMedia: getCurrentMedia(a.deviceId) },
  }));
  return c.json({ active });
});

// ==================== AirPlay (RAOP) renderer ====================
// Discovered via mDNS (_raop._tcp); each device also appears as an
// "airplay:<deviceId>" peer in /v1/peers, so the Web switcher + HA treat them
// exactly like DLNA renderers. These routes mirror the DLNA ones for tooling
// that talks to the renderer kind directly.

// AirPlay 插件未启用(默认关闭)时,全部 airplay 管理端点拒绝(防绕过)。

app.post("/v1/dlna/devices/:deviceId/play-mode", async (c) => {
  const { mode } = await c.req.json().catch(() => ({} as any));
  if (!["order", "one", "all", "shuffle"].includes(mode)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidMode"), 400);
  }
  getQueueManager().setPlayMode(c.req.param("deviceId")!, mode);
  return c.json({ success: true });
});

// Remove a single item from the queue by index. Playback stays coherent:
// if the removed item was current, the next one starts playing.

app.delete("/v1/dlna/devices/:deviceId/queue/:index", async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const index = parseInt(c.req.param("index")!, 10);
  if (Number.isNaN(index)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.invalidIndex"), 400);
  getQueueManager().removeAt(deviceId, index, getDlnaBaseUrl(c));
  return c.json({ success: true });
});

// Mark a device's queue inactive without clearing it (used when the user
// stops cast from the Web client — the queue stays in DB for reuse, but the
// device is no longer considered "actively casting" for restore purposes).

app.post("/v1/dlna/devices/:deviceId/deactivate", (c) => {
  getQueueManager().deactivate(c.req.param("deviceId")!);
  return c.json({ success: true });
});

// ==================== Unified peer API ====================
//
// One API surface for both local (Web client) and DLNA peers. The peerId
// encodes the kind: "local:<userId>" or "dlna:<deviceId>". The colon in the
// path segment is URL-safe; clients send it encoded (encodeURIComponent) and
// we decode here so handlers always see the canonical form.
//
// For local peers the backend only stores queue metadata (audio runs on the
// Web client). Transport controls (play/pause/next/prev/seek/volume) are
// accepted but are no-ops server-side — the Web client owns Howl and reports
// state changes back via /queue/index and /play-mode.
//
// For dlna peers every call delegates to the existing queue manager + control
// layer, so HA and Web share the exact same queue + auto-advance logic.
}
