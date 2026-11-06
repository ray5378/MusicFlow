// 系统级一次性提醒:登录后前端拉取一次,服务端按「每次启动一次」消费。
import type { Hono } from "hono";
import { adminMiddleware } from "../../middleware/auth.js";
import { takeBootNotices } from "../../services/system/bootNotices.js";

export function registerSystem(app: Hono): void {
  app.get("/v1/system/boot-notices", adminMiddleware, (c) => {
    return c.json({ success: true, notices: takeBootNotices() });
  });
}
