import { test, expect, type Page, type Request } from "@playwright/test";

// T20:前端「首屏请求数」自动化断言防回归。
//
// 背景:打开速度优化(2026-10-14)把「音乐下载页」首屏的两次全曲库扫描
// (/fetch/upgrade/plan、/fetch/library/plan)改为**切到对应页签才拉**,并把默认
// 页签停在「配置」页。本用例用已有 Playwright e2e 基建(真实后端 + preview)守住这条红线:
//   1) 首屏(默认「配置」页签)绝不触发这两个全库扫描端点;
//   2) 首屏 REST 请求总数受控(宽松上界,防止「初始化并发一堆重请求」回潮);
//   3) 切到「洗版」/「新建任务」页签时,对应端点必须被触发(证明懒加载仍可到达)。
//
// 断言只用「端点出现/缺席」+ 宽松计数上界,不依赖具体数据量,避免 CI 抖动。

const ADMIN = { username: "admin", password: "admin" };
const UPGRADE_PLAN = "/rest/api/v1/fetch/upgrade/plan";
const LIBRARY_PLAN = "/rest/api/v1/fetch/library/plan";
// 首屏 REST 请求数宽松上界(实测约 4-6 个;给足余量,只拦「并发一堆」式回潮)。
const FIRST_PAINT_BUDGET = 20;

async function loginAsAdmin(page: Page) {
  const resp = await page.request.post("/rest/api/v1/auth/login", { data: ADMIN });
  expect(resp.ok(), "登录接口应成功(admin/admin)").toBeTruthy();
  const data = await resp.json();
  await page.addInitScript((d) => {
    localStorage.setItem("token", d.token);
    localStorage.setItem("username", d.username);
    localStorage.setItem("isAdmin", String(d.isAdmin));
    localStorage.setItem("userSalt", d.subsonicSalt || d.subsonicToken || "");
    localStorage.setItem("userId", String(d.id));
    localStorage.setItem("mustChangePassword", "false");
  }, data);
}

/** 记录页面发起的 REST 请求路径(去掉查询串),按到达顺序入栈。 */
function trackRest(page: Page, sink: string[]) {
  page.on("request", (req: Request) => {
    const u = new URL(req.url());
    if (u.pathname.startsWith("/rest/api/v1/")) sink.push(u.pathname);
  });
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test("下载页首屏不触发全库扫描端点,切页签才触发(T20)", async ({ page }) => {
  const seen: string[] = [];
  trackRest(page, seen);

  // 以「配置」端点响应作为首屏加载完成的锚点,避免纯 timeout 判定的抖动。
  const configLoaded = page.waitForResponse((r) => r.url().includes("/rest/api/v1/fetch/config"));
  await page.goto("/admin/fetch", { waitUntil: "load" });
  await configLoaded;
  await page.waitForTimeout(300);

  // 1) 首屏(默认「配置」页签)不应发起两个全库扫描端点。
  expect(seen, `首屏不应请求 ${UPGRADE_PLAN}`).not.toContain(UPGRADE_PLAN);
  expect(seen, `首屏不应请求 ${LIBRARY_PLAN}`).not.toContain(LIBRARY_PLAN);

  // 2) 首屏 REST 请求数受控。
  expect(seen.length, "首屏 REST 请求数应在预算内").toBeLessThanOrEqual(FIRST_PAINT_BUDGET);

  // 3) 切到「洗版」页签 → 触发 upgrade/plan。
  await page.click("#tab-upgrade");
  await expect.poll(() => seen.includes(UPGRADE_PLAN), { timeout: 10_000 }).toBeTruthy();

  // 4) 切到「新建任务」页签 → 触发 library/plan。
  await page.click("#tab-create");
  await expect.poll(() => seen.includes(LIBRARY_PLAN), { timeout: 10_000 }).toBeTruthy();
});
