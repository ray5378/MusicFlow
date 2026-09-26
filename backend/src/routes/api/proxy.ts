// 自动生成 —— 由 index.ts 物理拆分而来（proxy 域，5 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BatchPace,
  BusinessErrorCode,
  adminMiddleware,
  apiError,
  currentPace,
  getProxyConfig,
  normalizeProxyUrl,
  setPace,
  setSetting,
  testProxyConnection,
} from "./shared.js";

export function registerProxy(app: Hono): void {
app.get("/v1/proxy", adminMiddleware, (c) => {
  const { enabled, url } = getProxyConfig();
  return c.json({ success: true, enabled, url });
});

app.put("/v1/proxy", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const enabled = !!body.enabled;
  const url = normalizeProxyUrl(String(body.url || ""));
  if (enabled && !url)
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.proxyFormat"), 400);
  setSetting("proxy_enabled", enabled ? "true" : "false");
  setSetting("proxy_url", url);
  return c.json({ success: true, enabled, url });
});

// 测试连接:验证代理通道能否出网(解耦单一 GitHub 域名,区分「代理坏」与「仅 GitHub 被挡」)。
// 返回 { success, message, githubReachable, probes }。

app.post("/v1/proxy/test", adminMiddleware, async (c) => {
  const result = await testProxyConnection();
  return c.json(result);
});

// ==================== 后台任务限速档位 ====================
// 批量任务(歌单同步/在线匹配/推荐补全)的 CPU 节流档位:slow|standard|full。
// 存 settings.batch_pace,batchPacer 运行时读取(无需重启)。

app.get("/v1/batch-pace", adminMiddleware, (c) => {
  return c.json({ success: true, pace: currentPace() });
});

app.put("/v1/batch-pace", adminMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pace = String(body.pace || "standard");
  if (pace !== "slow" && pace !== "standard" && pace !== "full") {
    return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.common.paceFormat"), 400);
  }
  setPace(pace as BatchPace);
  return c.json({ success: true, pace });
});

// ==================== Users ====================
}
