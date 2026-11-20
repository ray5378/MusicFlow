// 系统级一次性提醒:登录后前端拉取一次,服务端按「每次启动一次」消费。
import type { Hono } from "hono";
import { adminMiddleware } from "../../middleware/auth.js";
import { takeBootNotices } from "../../services/system/bootNotices.js";
import { isRestartAvailable, requestRestart } from "../../services/system/restartControl.js";
import { apiError, BusinessErrorCode } from "../../utils/errors.js";

export function registerSystem(app: Hono): void {
  app.get("/v1/system/boot-notices", adminMiddleware, (c) => {
    return c.json({ success: true, notices: takeBootNotices() });
  });

  // ---------------------------------------------------------------
  // 服务端自我重启（2026-11-20）：客户端「设置 → 维护」用。
  //
  // 语义：换完 dist 后让进程体面退出，容器 restart=always 重新拉起，
  //       起来后自动续播刚才那首（gracefulShutdown 里 retainActiveQueues 保住的）。
  // 为什么 GET 和 POST 同路径：客户端先用 GET 探测"我这个账号有没有这个能力"，
  //       只有管理员能拿到 200；进而在设置页决定是否显示「维护」模块。
  // ---------------------------------------------------------------
  app.get("/v1/system/restart", adminMiddleware, (c) => {
    return c.json({ success: true, allowed: true, available: isRestartAvailable() });
  });

  app.post("/v1/system/restart", adminMiddleware, (c) => {
    const user = c.get("user");
    const accepted = requestRestart(`api:${user?.username ?? "-"}`);
    if (!accepted) {
      // 没有注册处理器（例如被当作库引入）：明确告诉客户端"这次没重启"，别让它傻等。
      // 错误体必须走 apiError —— routes 下禁止手搓错误响应体
      // （守卫 tests/routes/apiSearchOnlineErrorContract.test.ts 逐行扫、钉死 0 处）。
      return c.json(
        apiError(BusinessErrorCode.UNAVAILABLE, "errors.system.restartUnavailable"),
        503,
      );
    }
    // 202：已受理，进程会在约 1.3s 内退出并重启。客户端据此进入"等待恢复"轮询。
    return c.json({ success: true, restarting: true }, 202);
  });
}
