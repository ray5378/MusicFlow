import { test, expect, type Page } from "@playwright/test";

// 默认管理员(后端 seed:admin/admin)。mustChangePassword 在测试环境强制跳过,
// 避免被重定向到改密页而遍历不到 admin 路由。
const ADMIN = { username: "admin", password: "admin" };

// 需检查移动端自适应的路由(列表/管理页)。详情页单独用 API 拿 id 后检查。
const ROUTES = [
  "/",
  "/playlists",
  "/albums",
  "/artists",
  "/music",
  "/genres",
  "/history",
  "/favorites",
  "/groups",
  "/flows",
  "/admin/plugins",
  "/admin/settings",
  "/admin/sources",
  "/admin/users",
  "/admin/wish",
];

async function loginAsAdmin(page: Page) {
  const resp = await page.request.post("/rest/api/v1/auth/login", { data: ADMIN });
  expect(resp.ok(), "登录接口应成功(admin/admin)").toBeTruthy();
  const data = await resp.json();
  // 每次导航前写入 localStorage,使 app 以 admin 身份启动且不跳改密页。
  await page.addInitScript((d) => {
    localStorage.setItem("token", d.token);
    localStorage.setItem("username", d.username);
    localStorage.setItem("isAdmin", String(d.isAdmin));
    localStorage.setItem("userSalt", d.subsonicSalt || d.subsonicToken || "");
    localStorage.setItem("userId", String(d.id));
    localStorage.setItem("mustChangePassword", "false");
  }, data);
}

// 返回页面级 + 各 el-table 内部横向溢出的像素(>1 即视为非自适应)。
// el-table 外层 .el-table 会 overflow:hidden 裁剪,需同时量内部 <table> 与滚动容器
// .el-table__body-wrapper,才能发现"表格内部横向滚动"这一典型非自适应症状。
async function measureOverflow(page: Page) {
  return page.evaluate(() => {
    const pageOverflow =
      document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const tables = [
      ...Array.from(document.querySelectorAll(".el-table table")).map(
        (t) => (t as HTMLElement).scrollWidth - (t as HTMLElement).clientWidth
      ),
      ...Array.from(document.querySelectorAll(".el-table__body-wrapper")).map(
        (w) => (w as HTMLElement).scrollWidth - (w as HTMLElement).clientWidth
      ),
    ];
    return { pageOverflow, tables };
  });
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test("手机端(390px)各页面不应横向溢出", async ({ page }) => {
  const failures: string[] = [];
  for (const route of ROUTES) {
    await page.goto(route, { waitUntil: "load" });
    // 等布局/表格渲染稳定。
    await page.waitForTimeout(400);
    const { pageOverflow, tables } = await measureOverflow(page);
    if (pageOverflow > 1) failures.push(`${route} 页面横向溢出 ${pageOverflow}px`);
    tables.forEach((t, i) => {
      if (t > 1) failures.push(`${route} 表格#${i} 横向滚动 ${t}px(未做移动端卡片化)`);
    });
  }
  expect(failures, "以下页面在手机端未自适应:\n" + failures.join("\n")).toEqual([]);
});

test("插件配置/详情弹窗在手机端不超出视口宽度", async ({ page }) => {
  await page.goto("/admin/plugins", { waitUntil: "load" });
  await page.waitForTimeout(400);
  // 已安装面板的「配置/详情」按钮:桌面端在 el-table、移动端在卡片,两种形态都要能打开弹窗。
  // 不限定容器(兼容卡片态),用可见性等待确保插件列表已渲染。
  const openBtn = page.getByRole("button", { name: /配置|详情/ }).first();
  await openBtn.waitFor({ state: "visible", timeout: 10_000 });
  await openBtn.click();
  const dialog = page.locator(".el-dialog").first();
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const box = await dialog.boundingBox();
  expect(box, "弹窗未渲染").not.toBeNull();
  // 弹窗不得超出视口(左/右越界即视为非自适应)。
  expect(box!.width, `配置弹窗宽度 ${Math.round(box!.width)}px 超出 390 视口`).toBeLessThanOrEqual(
    390 + 1
  );
  expect(box!.x, `配置弹窗左缘 ${Math.round(box!.x)}px 越界`).toBeGreaterThanOrEqual(-1);
});

test("插件配置/详情弹窗不被播放控件遮挡(层级回归守卫)", async ({ page }) => {
  // 回归守卫:弹窗(el-dialog)若未 append-to-body,会渲染在页面滚动容器
  // (.main-scroll,z-index:1 的 stacking context)内,其自身 z-index 2000+ 被困在
  // 该上下文里,对外等效 z-index 1 → 被底部播放条(桌面 50 / 移动 520)或全屏
  // 播放模式(300/700)盖住。此断言用 elementFromPoint 模拟真实交互命中:
  // 弹窗内最后一个可见按钮(保存/确定)的中心点必须命中弹窗内部。
  await page.goto("/admin/plugins", { waitUntil: "load" });
  await page.waitForTimeout(400);
  const openBtn = page.getByRole("button", { name: /配置|详情/ }).first();
  await openBtn.waitFor({ state: "visible", timeout: 10_000 });
  await openBtn.click();
  const dialog = page.locator(".el-dialog").first();
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const hit = await page.evaluate(() => {
    const dlg = document.querySelector(".el-dialog");
    if (!dlg) return "no-dialog";
    const probe = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      const el = document.elementFromPoint(x, y);
      let node: HTMLElement | null = el as HTMLElement | null;
      while (node && node !== document.body) {
        if (node.closest && (node.closest(".el-dialog") || node.closest(".el-overlay"))) return true;
        node = node.parentElement;
      }
      return false;
    };
    const r = dlg.getBoundingClientRect();
    // 1) 弹窗中心点必须命中弹窗内部(被播放条/全屏控件覆盖则 false)
    if (!probe(r.left + r.width / 2, r.top + r.height / 2)) return "center-covered";
    // 2) 弹窗内视口可见的最后一个按钮(保存/确定/关闭)也必须命中
    //    (弹窗可能高于视口,footer 按钮可能被滚出视口,只取视口内的)
    const btns = Array.from(dlg.querySelectorAll("button"))
      .map((b) => b.getBoundingClientRect())
      .filter(
        (br) =>
          br.width > 0 &&
          br.height > 0 &&
          br.top >= 0 &&
          br.top + br.height <= window.innerHeight &&
          br.left >= 0 &&
          br.left + br.width <= window.innerWidth
      );
    const last = btns[btns.length - 1];
    if (last && !probe(last.left + last.width / 2, last.top + last.height / 2)) return "btn-covered";
    return "dialog-hit";
  });
  expect(
    hit,
    `配置弹窗被播放控件遮挡(修复:el-dialog 需 append-to-body 脱离页面滚动容器 stacking context):${hit}`
  ).toBe("dialog-hit");
});

test("歌单详情页在手机端不应横向溢出", async ({ page }) => {
  const res = await page.request.get("/rest/api/v1/playlists?page=1&pageSize=1");
  if (!res.ok()) return; // 无数据则跳过(空态由列表测试覆盖)
  const body = await res.json();
  const id = body?.items?.[0]?.id;
  if (!id) return;
  await page.goto(`/playlists/${id}`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  const { pageOverflow, tables } = await measureOverflow(page);
  expect(
    pageOverflow,
    `/playlists/${id} 详情页横向溢出 ${pageOverflow}px`
  ).toBeLessThanOrEqual(1);
  tables.forEach((t, i) =>
    expect(t, `/playlists/${id} 详情页表格#${i} 横向滚动 ${t}px`).toBeLessThanOrEqual(1)
  );
});
