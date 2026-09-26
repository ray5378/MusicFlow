// 自动生成 —— 由 index.ts 物理拆分而来（webhook 域，4 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  apiError,
  createPlayerWebhookToken,
  deletePlayerWebhookToken,
  getEffectiveBaseUrl,
  listPlayerWebhookTokens,
  resolvePlayerWebhookOwnerName,
  setPlayerWebhookTokenEnabled,
  tokenOfUser,
} from "./shared.js";

export function registerWebhook(app: Hono): void {
app.get("/v1/player-webhook/tokens", (c) => {
  const user = c.get("user")!;
  // 按用户划分:普通用户仅见自己创建的渠道 token(避免泄露他人 token 值)。
  const all = listPlayerWebhookTokens();
  const scoped = user.isAdmin ? all : all.filter(t => t.ownerUserId === user.id);
  const items = scoped.map(t => ({
    id: t.id, name: t.name, token: t.token, enabled: t.enabled,
    ownerName: resolvePlayerWebhookOwnerName(t.ownerUserId),
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }));
  return c.json({ items, templateUrl: `${getEffectiveBaseUrl()}/webhook/player` });
});

app.post("/v1/player-webhook/tokens", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const name = (body && typeof body.name === "string" && body.name.trim()) || "渠道 " + (listPlayerWebhookTokens().length + 1);
  const token = createPlayerWebhookToken(c.get("user")!.id, name);
  return c.json({ token, name });
});

// 非管理员仅能操作自己创建的 token(他人 token 视为不存在)。

app.put("/v1/player-webhook/tokens/:id", async (c) => {
  const id = c.req.param("id")!;
  if (!tokenOfUser(c, id)) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.token.notExist"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const enabled = !!(body && body.enabled);
  const ok = setPlayerWebhookTokenEnabled(id, enabled);
  if (!ok) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.token.notExist"), 404);
  return c.json({ success: true });
});

app.delete("/v1/player-webhook/tokens/:id", (c) => {
  const id = c.req.param("id")!;
  if (!tokenOfUser(c, id)) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.token.notExist"), 404);
  const ok = deletePlayerWebhookToken(id);
  if (!ok) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.token.notExist"), 404);
  return c.json({ success: true });
});
}
