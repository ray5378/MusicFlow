// 自动生成 —— 由 index.ts 物理拆分而来（flows 域，6 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  DEFAULT_DEFINITION,
  PERM,
  apiError,
  assertOwnToken,
  createFlow,
  deleteFlow,
  executeFlow,
  flowOwner,
  flowWithWebhook,
  getDlnaBaseUrl,
  getFlow,
  getPlayerWebhookTokenById,
  isFlowRunning,
  listFlows,
  permMiddleware,
  resolveDefaultTokenId,
  updateFlow,
} from "./shared.js";

export function registerFlows(app: Hono): void {
app.get("/v1/flows", permMiddleware(PERM.FLOW_MANAGE), (c) => {
  const items = listFlows(flowOwner(c)).map(flowWithWebhook);
  return c.json({ total: items.length, items });
});

app.get("/v1/flows/:id", permMiddleware(PERM.FLOW_MANAGE), (c) => {
  const flow = getFlow(c.req.param("id")!, flowOwner(c));
  if (!flow) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.flow.notExist"), 404);
  return c.json({ flow: flowWithWebhook(flow) });
});

app.post("/v1/flows", permMiddleware(PERM.FLOW_MANAGE), async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.flow.nameRequired"), 400);
  const user = c.get("user")!;
  // 绑定渠道 token:校验 body.tokenId 存在且(非管理员)归属本人;缺省自动绑定自己的启用渠道 token。
  let tokenId = "";
  if (body.tokenId) {
    const t = getPlayerWebhookTokenById(String(body.tokenId));
    if (!t) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.flow.tokenNotFound"), 400);
    if (!assertOwnToken(c, t.id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.flow.tokenOwnership"), 403);
    tokenId = t.id;
  } else {
    tokenId = resolveDefaultTokenId(user.isAdmin ? undefined : user.id);
  }
  const flow = createFlow(user.id, name, body.definition || { ...DEFAULT_DEFINITION }, tokenId);
  return c.json({ flow: flowWithWebhook(flow) });
});

app.put("/v1/flows/:id", permMiddleware(PERM.FLOW_MANAGE), async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const upd: any = {
    name: typeof body.name === "string" ? body.name : undefined,
    definition: body.definition,
    enabled: body.enabled === undefined ? undefined : !!body.enabled,
  };
  // 音流对外链接可改绑渠道 token(非管理员只能改绑自己的)。
  if (typeof body.tokenId === "string") {
    if (body.tokenId) {
      const t = getPlayerWebhookTokenById(body.tokenId);
      if (!t) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.flow.tokenNotFound"), 400);
      if (!assertOwnToken(c, t.id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.flow.tokenOwnership"), 403);
      upd.tokenId = t.id;
    } else {
      upd.tokenId = "";
    }
  }
  const flow = updateFlow(c.req.param("id")!, flowOwner(c), upd);
  if (!flow) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.flow.notExist"), 404);
  return c.json({ flow: flowWithWebhook(flow) });
});

app.delete("/v1/flows/:id", permMiddleware(PERM.FLOW_MANAGE), (c) => {
  const ok = deleteFlow(c.req.param("id")!, flowOwner(c));
  if (!ok) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.flow.notExist"), 404);
  return c.json({ success: true });
});

// UI 手动触发(异步执行,返回当前运行状态)。

app.post("/v1/flows/:id/run", permMiddleware(PERM.FLOW_MANAGE), async (c) => {
  const flow = getFlow(c.req.param("id")!, flowOwner(c));
  if (!flow) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.flow.notExist"), 404);
  if (!flow.enabled) return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.flow.disabledFlow"), 409);
  const started = await executeFlow(flow.id, getDlnaBaseUrl(c));
  return c.json({ success: true, started: started === "started", running: isFlowRunning(flow.id) });
});

// ==================== 通用播放器控制渠道 token(独立管理,可多条) ====================
// 每条渠道 token 可独立启用/停用/删除;「我喜欢」收藏归属各自 owner(创建者)。
// 免鉴权端点 /webhook/player 凭任一启用的 token 执行。与音流(flow)流程完全解耦。
}
