// 自动生成 —— 由 index.ts 物理拆分而来（groups 域，5 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  apiErrorStatus,
  PERM,
  alignGroupMembers,
  apiError,
  gm,
  permMiddleware,
  resolveContentSongs,
} from "./shared.js";
import {
  GROUP_DELAY_MAX_MS,
  GROUP_DELAY_MIN_MS,
  GROUP_DELAY_STEP_MS,
  getGroupDelays,
  invalidateGroupDelays,
  setGroupDelays,
} from "../../services/group/delayCalib.js";
import { isBridgeRouteActive, rebuildBridgeRoutes } from "../../services/group/protocolPlayer.js";

export function registerGroups(app: Hono): void {
app.get("/v1/groups", (c) => {
  const user = c.get("user");
  const groups = user?.isAdmin ? gm.listWithMembers() : gm.listWithMembersForOwner(user?.id ?? "");
  return c.json({ groups });
});

// 新建组。Body: { name: string, memberIds?: string[] }。需要 renderer.use(普通用户可建自组)。

app.post("/v1/groups", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => ({} as any));
  const name = typeof body.name === "string" ? body.name : "";
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
  try {
    const g = gm.createGroup(name, memberIds, user?.id ?? "");
    return c.json({ group: gm.getWithMembers(g.id) }, 201);
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, e.message || "errors.group.createFailed"), apiErrorStatus(BusinessErrorCode.INVALID_PARAM));
  }
});

// 更新组:只允许组 owner(或管理员)。改名(name)和/或全量替换成员(memberIds)。Body: { name?, memberIds? }

app.put("/v1/groups/:id", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id")!;
  if (!gm.isOwnedBy(id, user?.id ?? "", !!user?.isAdmin)) {
    return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFoundOrNoPerm"), 404);
  }
  const body = await c.req.json().catch(() => ({} as any));
  try {
    if (typeof body.name === "string") {
      const renamed = gm.renameGroup(id, body.name);
      if (!renamed) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFound"), 404);
    }
    if (Array.isArray(body.memberIds)) {
      const before = gm.get(id)?.memberIds || [];
      const updated = gm.setMembers(id, body.memberIds);
      if (!updated) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFound"), 404);
      const after = gm.get(id)?.memberIds || [];
      const added = after.filter(d => !before.includes(d));
      const removed = before.filter(d => !after.includes(d));
      // 新增→加入对齐 / 摘除→断开:与增量口共用 alignGroupMembers(语义单源)。
      if (added.length > 0 || removed.length > 0) {
        void alignGroupMembers(id, added, removed);
      }
    }
    const g = gm.getWithMembers(id);
    if (!g) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFound"), 404);
    return c.json({ group: g });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, e.message || "errors.group.updateFailed"), apiErrorStatus(BusinessErrorCode.INVALID_PARAM));
  }
});

// 增量变更成员(移动端随时加减)。Body: { add?: string[], remove?: string[] }。
// 单成员幂等(add 已在组内/remove 不在组内均为 no-op),无 read-modify-write,
// 两台手机同时加不同设备不丢成员;弱网重试安全。先删后加,原子执行一次,
// 返回更新后 group(含成员详情,免二次 GET)。同样走 alignGroupMembers 对齐。

app.post("/v1/groups/:id/members", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id")!;
  if (!gm.isOwnedBy(id, user?.id ?? "", !!user?.isAdmin)) {
    return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFoundOrNoPerm"), 404);
  }
  const body = await c.req.json().catch(() => ({} as any));
  try {
    const r = gm.applyMemberDelta(id, { add: body.add, remove: body.remove });
    if (!r) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFound"), 404);
    if (r.added.length > 0 || r.removed.length > 0) {
      void alignGroupMembers(id, r.added, r.removed);
    }
    return c.json({ group: gm.getWithMembers(id), added: r.added, removed: r.removed });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, e.message || "errors.group.updateFailed"), apiErrorStatus(BusinessErrorCode.INVALID_PARAM));
  }
});

// 群组 A/V 延迟补偿(ms)。**语义:正数 = 该侧更晚出声,负数 = 该侧更早出声**。
// 两侧各自独立存,但只有「差值」影响 A/V 同步 —— 分开是为了纯 AirPlay 组 /
// 纯 Sendspin 组也能各自微调。范围 ±30s(用户定稿),步进 10ms。

app.get("/v1/groups/:id/delays", permMiddleware(PERM.RENDERER_USE), (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id")!;
  // 管理员 isOwnedBy 恒真 ⇒ 必须先确认组真的存在,否则不存在的 id 会拿到 200/0。
  if (!gm.get(id) || !gm.isOwnedBy(id, user?.id ?? "", !!user?.isAdmin)) {
    return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFoundOrNoPerm"), 404);
  }
  const d = getGroupDelays(id);
  return c.json({
    airplayMs: d.airplayMs,
    airplay2Ms: d.airplay2Ms,
    sendspinMs: d.sendspinMs,
    minMs: GROUP_DELAY_MIN_MS,
    maxMs: GROUP_DELAY_MAX_MS,
    stepMs: GROUP_DELAY_STEP_MS,
  });
});

app.put("/v1/groups/:id/delays", permMiddleware(PERM.RENDERER_USE), async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id")!;
  if (!gm.isOwnedBy(id, user?.id ?? "", !!user?.isAdmin)) {
    return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFoundOrNoPerm"), 404);
  }
  const body = await c.req.json().catch(() => ({} as any));
  const before = getGroupDelays(id);
  if (!gm.get(id)) {
    return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFound"), 404);
  }
  // 内存值先更新(落库在后):Sendspin 侧下一次 pushFrame 立刻按新值打戳 = 真·实时。
  const next = setGroupDelays(id, {
    airplayMs: body.airplayMs,
    airplay2Ms: body.airplay2Ms,
    sendspinMs: body.sendspinMs,
  });
  // AirPlay 侧的锚点(startNtp)在桥会话建立时就算死了,中途改 anchorShiftUs 不生效。
  // 因此只有「AirPlay 值真的变了且该组桥在跑」时,才重建该组桥换立即生效
  // (代价:该组 AirPlay 成员约 1~2s 静音;Sendspin 成员不受影响)。
  let rebuilt = 0;
  // AP1 与 AP2 走的是同一个 anchorShiftUs,同样在会话建立时算死 ⇒ 两格任一变化都要重建。
  if (
    (next.airplayMs !== before.airplayMs || next.airplay2Ms !== before.airplay2Ms) &&
    isBridgeRouteActive(id)
  ) {
    try {
      rebuilt = await rebuildBridgeRoutes(id);
    } catch { /* 重建失败不影响保存结果:下次会话按新值建立 */ }
  }
  return c.json({
    airplayMs: next.airplayMs,
    airplay2Ms: next.airplay2Ms,
    sendspinMs: next.sendspinMs,
    minMs: GROUP_DELAY_MIN_MS,
    maxMs: GROUP_DELAY_MAX_MS,
    stepMs: GROUP_DELAY_STEP_MS,
    rebuilt,
  });
});

// 删除组(组队列随之删除,成员设备恢复单独控制)。仅组 owner(或管理员)。需要 renderer.use。

app.delete("/v1/groups/:id", permMiddleware(PERM.RENDERER_USE), (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id")!;
  if (!gm.isOwnedBy(id, user?.id ?? "", !!user?.isAdmin)) {
    return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFoundOrNoPerm"), 404);
  }
  const ok = gm.deleteGroup(id);
  if (!ok) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.group.notFound"), 404);
  invalidateGroupDelays(id); // 组没了:清掉延迟缓存,避免 id 复用时读到陈旧值
  return c.json({ success: true });
});

// ==================== 统一内容点播(webhook / 外部 API) ====================
// POST /v1/play { peerId, type: song|playlist|artist|album|genre, id, songId?, startIndex?, playMode?, enqueue? }
// 服务器端把内容 ID 解析成歌曲队列并投递到指定播放器:
//   - dlna / group → 直接开始播放(后端控制音频,无需浏览器)
//   - local → 注入队列(音频仍由 Web 客户端 Howl 驱动)
//
// **起点定位：优先 songId，其次 startIndex**（遥控器语义）。
// 调用方（客户端/HA 集成）只需告诉我们「播这个歌单里的这首歌」，不必先知道歌单
// 里有哪些歌、更不该自己算行号：
//   - songId 是**身份**，服务端在解析出的队列里 findIndex 定位，与两侧顺序无关；
//   - startIndex 是**行号**，只有两侧顺序严格同源时才等价于身份。历史上
//     resolveContentSongs('playlist') 缺 ORDER BY、以及悬空 songId 被静默过滤，
//     都会让行号漂移 → 静默播错歌；且 startIndex 越界会静默归 0，不给任何提示。
// 故新调用方一律传 songId；startIndex 保留给 Web 前端与 HA 集成的存量调用方。
}
