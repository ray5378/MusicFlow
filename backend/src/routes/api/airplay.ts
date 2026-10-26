// 自动生成 —— 由 index.ts 物理拆分而来（airplay 域，9 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  apiErrorStatus,
  PERM,
  adminMiddleware,
  apiError,
  canUseRenderer,
  castToAirPlayDevice,
  db,
  deleteAirPlayDeviceRecord,
  deviceQueues,
  eq,
  getAirPlayPeerStatus,
  getDlnaBaseUrl,
  getEventManager,
  getPeerManager,
  getQueueController,
  getQueueManager,
  isAirPlayEnabled,
  listAirPlayDevices,
  permMiddleware,
  rendererGrantParamMiddleware,
  rescanAirPlayDevices,
  setAirPlayAlias,
  setAirPlayDisabled,
  stopAirPlaySession,
} from "./shared.js";
// AP2 PIN 配对:直接引服务模块(shared.ts 只做转发,新出口不必再绕一层)。
import {
  isValidAirPlayPin,
  pairAirPlayDevice,
  type AirPlayPairErrorCode,
} from "../../services/airplay/control.js";

/** 配对失败码 → HTTP 状态(用户可读懂的分类:入参/超时/落库/上游)。 */
const AP2_PAIR_HTTP_STATUS: Record<AirPlayPairErrorCode, 400 | 500 | 502 | 504> = {
  "ap2-unsupported": 400, // 设备不支持 AP2(或设备不存在):重试无用,属入参/前置条件错误
  "ap2-pin": 400,         // PIN 错:让用户重新输入
  "ap2-timeout": 504,     // 设备没进配对态 / 不响应:超时
  "ap2-persist": 500,     // 配对通过但凭据写库失败:服务端存储问题
  "ap2-fail": 502,        // 协议/网络失败(上游设备)
};

/** 配对失败码 → 统一错误体里的业务码。 */
const AP2_PAIR_BODY_CODE: Record<AirPlayPairErrorCode, BusinessErrorCode> = {
  "ap2-unsupported": BusinessErrorCode.INVALID_PARAM,
  "ap2-pin": BusinessErrorCode.INVALID_PARAM,
  "ap2-timeout": BusinessErrorCode.UNAVAILABLE,
  "ap2-persist": BusinessErrorCode.INTERNAL,
  "ap2-fail": BusinessErrorCode.UPSTREAM_ERROR,
};

export function registerAirplay(app: Hono): void {
app.use("/v1/airplay/devices/:deviceId/*", rendererGrantParamMiddleware("airplay"));

// List discovered DLNA renderers (refreshes cache if stale).
// 设备列表按用户授权过滤:管理员返回全部(管理/授权 UI 需要);普通用户只见
// 自己「可控制的设备」(renderer.use + dlna:<id> 授权),避免播放器页泄露全部
// 设备。与 /v1/peers 的 filterPeersByAccess 语义一致。

app.use("/v1/airplay/*", async (c, next) => {
  if (!isAirPlayEnabled()) {
    return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.airplay.disabled"), 409);
  }
  await next();
});

app.get("/v1/airplay/devices", (c) => {
  const user = c.get("user");
  // 与 DLNA 一致:管理员返回全部;普通用户只见自己授权可控的设备(airplay:<id>)。
  // **刻意不拆端点**:未配对的 AP2 设备也出现在同一份列表里(带 ap2Capable=false /
  // ap2Paired=false),否则用户在播放器页看不到设备、也就无从发起配对。
  // ⚠️ 前端「可选择播放器」下拉与群组成员候选**必须**过滤 `selectable === true`
  // (未配对的 AP2 设备可显示但不可选);判据唯一出处 = control.ts::selectableOf。
  let devices = listAirPlayDevices();
  if (user && !user.isAdmin) {
    devices = devices.filter((d) => !d.disabled && canUseRenderer(user.id, false, `airplay:${d.id}`));
  }
  return c.json({ devices });
});

// 主动重扫 AirPlay 设备:立刻重发一次 mDNS(_raop._tcp) 查询,把刚上电、常驻 browser
// 还没捞到的接收端捞进来。与 `POST /v1/dlna/scan` 对齐 —— 两个区块的「扫描」按钮因此
// 语义一致(都真的去发现设备,而不是只重拉一次列表)。
// 播放控制能力:renderer.use。

app.post("/v1/airplay/scan", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const user = c.get("user");
  await rescanAirPlayDevices();
  let devices = listAirPlayDevices();
  if (user && !user.isAdmin) {
    devices = devices.filter((d) => !d.disabled && canUseRenderer(user.id, false, `airplay:${d.id}`));
  }
  return c.json({ devices });
});

// 重命名 AirPlay 设备(自定义显示名 alias)。Body: { alias } — 空串恢复原始名。
// alias 会同步到播放控件 / HA 卡片显示(peer.name = alias || name)。
// 管理播放器能力:renderer.manage。

app.put("/v1/airplay/devices/:deviceId", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (alias.length > 50) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.nameTooLong"), 400);
  const dev = setAirPlayAlias(deviceId, alias);
  if (!dev) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.deviceNotFound"), 404);
  return c.json({ success: true, device: { id: dev.id, alias: dev.alias || "" } });
});

// 删除 AirPlay 设备(通常删除离线的)。同时清理:设备队列、peer、DB 记录。
// 管理播放器能力:renderer.manage。

app.delete("/v1/airplay/devices/:deviceId", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const deviceId = c.req.param("deviceId")!;
  // 1. 停止并清空设备队列(如果有),并删除持久化队列行。
  try { getQueueController().clear(deviceId); } catch { /* ignore */ }
  db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
  // 2. 移除 peer(播放控件 / HA 卡片不再出现)。
  getPeerManager().removeAirPlayPeer(deviceId);
  // 3. 停止活动会话。
  try { await stopAirPlaySession(deviceId); } catch { /* ignore */ }
  // 4. 删除缓存 + DB 记录。
  const existed = deleteAirPlayDeviceRecord(deviceId);
  if (!existed) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.deviceNotFound"), 404);
  return c.json({ success: true });
});

// 禁用/启用 AirPlay 设备。禁用后:从所有流转播放的入口消失(peer 移除)、
// 停止播放并清空队列、不可投屏;启用则恢复。
// 管理播放器能力:renderer.manage。

app.put("/v1/airplay/devices/:deviceId/disabled", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({}));
  const disabled = !!body.disabled;
  if (disabled) {
    // 1. 停止并清空设备队列(如果有),并删除持久化队列行。
    try { getQueueController().clear(deviceId); } catch { /* ignore */ }
    db.delete(deviceQueues).where(eq(deviceQueues.deviceId, deviceId)).run();
    // 2. 停止活动会话。
    try { await stopAirPlaySession(deviceId); } catch { /* ignore */ }
  }
  const dev = setAirPlayDisabled(deviceId, disabled);
  if (!dev) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.renderer.deviceNotFound"), 404);
  // 3. 立即同步 AirPlay peer 列表(与 DLNA 禁用一致:禁用→移除 peer 并推
  //    peer_unavailable;启用→重新注册),否则隐藏的设备会一直留在 HA 卡片/切换器。
  getPeerManager().reconcileAirPlayPeers();
  // 4. 广播设备列表变化(WS → 卡片/Web 刷新)。
  getEventManager().emitDeviceListChanged(listAirPlayDevices().length);
  return c.json({ success: true, disabled, device: { id: dev.id, disabled: !!dev.disabled } });
});

// AP2 PIN 配对(播放器页「配对」按钮的唯一后端入口)。
//
// 为什么需要它:未配对的 AP2 设备**不得进组、不得出现在可选择播放器**(用户规则 1),
// 但设备本身仍留在设备列表里(带 ap2Paired=false),用户在这里输入设备屏幕上显示的
// 4 位码完成 HAP pair-setup,凭据落库后该设备才变 selectable。
//
// 权限:与重命名/禁用/删除一致 —— 管理播放器能力 renderer.manage(配对属设备管理动作)。
// body: { pin: "1234" } —— 非 4 位数字直接 400,不进入配对流程。
// 失败映射:ap2-unsupported/ap2-pin → 400、ap2-timeout → 504、ap2-persist → 500、
//           ap2-fail → 502;文案可直接展示(见 AP2_PAIR_MESSAGES)。
// 失败体额外带 `ap2Code: <AirPlayPairErrorCode>`(见下方 return 处注释)。
// 成功:200 { ok:true, ap2Paired:true } —— **不自动起播**。

app.post("/v1/airplay/devices/:deviceId/pair", permMiddleware(PERM.RENDERER_MANAGE), async (c) => {
  const deviceId = c.req.param("deviceId")!;
  const body = await c.req.json().catch(() => ({} as any));
  const rawPin = (body as any)?.pin;
  // 兼容前端直接传数字(1234):统一成字符串再校验,避免「能看见但填不进去」。
  const pin = typeof rawPin === "string" ? rawPin.trim() : typeof rawPin === "number" ? String(rawPin) : "";
  if (!isValidAirPlayPin(pin)) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "PIN 必须是设备屏幕上显示的 4 位数字"), 400);
  }
  const result = await pairAirPlayDevice(deviceId, pin);
  if (result.ok) {
    return c.json({ ok: true, ap2Paired: true }, 200);
  }
  // `ap2Code` 是**纯增量**字段(不改 HTTP 状态映射、不改 error 文案):
  //   - `code` 只有 INVALID_PARAM 一档同时覆盖 ap2-pin 与 ap2-unsupported,前端
  //     光看它分不清「验证码填错(可重试)」和「这台设备根本不支持 AP2(重试无用)」;
  //   - `error` 文案由 apiError 按请求语言(x-mf-lang)本地化,前端不能拿它做分支。
  // 前端读 `body.ap2Code` 决定交互(重新输入 PIN / 隐藏配对入口 / 提示稍后重试)。
  return c.json(
    { ...apiError(AP2_PAIR_BODY_CODE[result.code], result.message), ap2Code: result.code },
    AP2_PAIR_HTTP_STATUS[result.code],
  );
});

app.get("/v1/airplay/active", (c) => {
  const active = getQueueManager().activeDevices().map((a) => ({
    deviceId: a.deviceId,
    snapshot: { ...a.snapshot, currentMedia: getAirPlayPeerStatus(a.deviceId).media },
  }));
  return c.json({ active });
});

app.post("/v1/airplay/cast", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const { songId, deviceId } = body as any;
  if (!songId || !deviceId) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.renderer.needsSongIdAndDeviceId"), 400);
  if (!canUseRenderer(user?.id ?? "", !!user?.isAdmin, `airplay:${deviceId}`)) {
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.renderer.controlForbidden"), 403);
  }
  try {
    await castToAirPlayDevice({
      songId, deviceId,
      baseUrl: getDlnaBaseUrl(c),
    });
    return c.json({ success: true, message: "已投放到 AirPlay 设备" });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.cast.airplayFailed"), apiErrorStatus(BusinessErrorCode.UPSTREAM_ERROR));
  }
});

// ==================== Sendspin 客户端与配对管理 ====================
//
// - clients:在线连接一览(配对态/批准态/legacy 标记,供前端设备页)
// - pairing/*:三种配对法的服务端编排(static/dynamic 码输入、pairing token、取消)
// - approve/unpair:未配对批准管理与配对解除
// 配对与审批属管理操作,统一 adminMiddleware;clients 列表沿用全局登录鉴权。
}
