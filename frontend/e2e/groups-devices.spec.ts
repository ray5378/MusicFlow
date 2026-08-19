import { test, expect, type Page } from "@playwright/test";

// 播放器页(Groups)设备操作按钮的手机端守卫:
//  1. 完整交互链路:设备初始启用 → 点击「禁用」(popconfirm 确认) → 后端状态翻转 →
//     页面重载 → 按钮变「恢复」(离线设备还出现「删除」)——全程在 390px 下断言
//     设备行不横向溢出、按钮不重叠、不遮住相邻内容。
//  2. 用 route mock 驱动状态机(GET 返回当前列表,PUT /disabled 翻转 disabled),
//     不依赖真实局域网设备即可覆盖"禁用后按钮变多"的最坏布局组合。

const ADMIN = { username: "admin", password: "admin" };

// 状态机:初始为「启用」态,PUT /disabled 翻转,GET 返回当前列表。
// 设备2 初始离线 → 禁用后出现 恢复/重命名/删除 三按钮(最宽组合)。
let state = {
  devices: [
    {
      id: "dlna-dev-online",
      name: "HI-VI H5MKII 客厅蓝牙音箱 (WiFi)",
      displayName: "HI-VI H5MKII 客厅蓝牙音箱 (WiFi)",
      alias: "客厅主音箱",
      available: true,
      disabled: false,
      manufacturer: "Linkplay",
      model: "H5MKII",
    },
    {
      id: "dlna-dev-offline",
      name: "书房音箱 A300-长名字超长版本用于测试挤压",
      displayName: "书房音箱 A300-长名字超长版本用于测试挤压",
      alias: "旧书房音箱",
      available: false,
      disabled: false,
      manufacturer: "Linkplay",
      model: "A300",
    },
  ],
};

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

/** 在页面内测量设备行布局问题,返回问题描述数组(空 = 干净)。 */
async function measureRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const pageOverflow =
      document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (pageOverflow > 1) out.push(`页面横向溢出 ${pageOverflow}px`);
    const rows = Array.from(document.querySelectorAll(".device-row"));
    rows.forEach((row, ri) => {
      const rb = (row as HTMLElement).getBoundingClientRect();
      if (rb.right > window.innerWidth + 1)
        out.push(`设备行#${ri} 右缘 ${Math.round(rb.right)}px 越出视口`);
      if (rb.bottom > window.innerHeight + 1)
        out.push(`设备行#${ri} 下缘 ${Math.round(rb.bottom)}px 越出视口(底部被遮)`);
      const btns = Array.from(row.querySelectorAll("button")).map((b) =>
        b.getBoundingClientRect()
      );
      for (let i = 0; i < btns.length; i++) {
        if (btns[i].right > rb.right + 1)
          out.push(`设备行#${ri} 按钮#${i} 越出设备行右缘 ${Math.round(btns[i].right - rb.right)}px`);
        for (let j = i + 1; j < btns.length; j++) {
          const a = btns[i], b = btns[j];
          const overlap =
            a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
          if (overlap) out.push(`设备行#${ri} 按钮#${i} 与 #${j} 重叠`);
        }
      }
      const next = (row as HTMLElement).nextElementSibling as HTMLElement | null;
      if (next && next.classList.contains("device-row")) {
        const nb = next.getBoundingClientRect();
        if (nb.top < rb.bottom - 1)
          out.push(`设备行#${ri} 与 #${ri + 1} 重叠(${Math.round(rb.bottom - nb.top)}px)`);
      }
      const info = row.querySelector(".device-row-info") as HTMLElement | null;
      const actions = row.querySelector(".device-row-actions") as HTMLElement | null;
      if (info && actions) {
        const ib = info.getBoundingClientRect();
        const ab = actions.getBoundingClientRect();
        // 仅当二者在垂直方向也重叠(即同一行)时才算遮挡——窄屏下操作按钮整行
        // 换行到信息区下方属正常布局,不能用纯水平位置误报。
        const verticallyOverlap = ab.top < ib.bottom - 1 && ab.bottom > ib.top + 1;
        if (verticallyOverlap && ab.left < ib.right - 1)
          out.push(`设备行#${ri} 操作按钮与信息区重叠(${Math.round(ib.right - ab.left)}px)`);
      }
    });
    return out;
  });
}

test("播放器页设备禁用交互链路:手机端(390px)不溢出且不遮挡相邻内容", async ({ page }) => {
  await loginAsAdmin(page);

  // mock:GET 返回当前状态;PUT /disabled 翻转对应设备并回包。
  await page.route("**/rest/api/v1/dlna/devices", (route) => {
    route.fulfill({ json: state });
  });
  await page.route("**/rest/api/v1/dlna/devices/*/disabled", async (route) => {
    const url = route.request().url();
    const id = decodeURIComponent(url.match(/dlna\/devices\/([^/]+)\/disabled/)?.[1] || "");
    const body = route.request().postDataJSON() || {};
    state = {
      devices: state.devices.map((d) =>
        d.id === id ? { ...d, disabled: !!body.disabled } : d
      ),
    };
    await route.fulfill({ json: { success: true } });
  });
  await page.route("**/rest/api/v1/airplay/devices", (route) =>
    route.fulfill({ json: { devices: [] } })
  );

  await page.goto("/groups", { waitUntil: "load" });
  // 用更窄的 360px 视口模拟小屏手机(390 默认之外的最坏情况)。
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator(".device-row").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(300);

  const all = (await measureRows(page)).slice();
  const stage = (name: string) => `[${name}]`;

  // 阶段 1:启用态(按钮=禁用/重命名)
  expect(
    (await measureRows(page)).join("\n"),
    `${stage("启用态")} 设备行存在溢出/遮挡`
  ).toBe("");

  // 阶段 2:禁用「离线设备」(最宽组合 → 恢复/重命名/删除)
  const offlineRow = page.locator(".device-row").nth(1);
  await offlineRow.getByRole("button", { name: "禁用" }).click();
  await page.locator(".el-popconfirm__action").getByRole("button", { name: "禁用" }).click();
  await page.waitForTimeout(400); // PUT → 重载列表 → 重新渲染
  expect(
    (await measureRows(page)).join("\n"),
    `${stage("禁用离线设备后")} 设备行存在溢出/遮挡(恢复/重命名/删除组合)`
  ).toBe("");

  // 阶段 3:再禁用「在线设备」(恢复/重命名组合)
  const onlineRow = page.locator(".device-row").first();
  await onlineRow.getByRole("button", { name: "禁用" }).click();
  await page.locator(".el-popconfirm__action").getByRole("button", { name: "禁用" }).click();
  await page.waitForTimeout(400);
  expect(
    (await measureRows(page)).join("\n"),
    `${stage("禁用在线设备后")} 设备行存在溢出/遮挡`
  ).toBe("");

  // 阶段 4:恢复(反向链路)第一个设备 → 布局仍干净
  await page.locator(".device-row").first().getByRole("button", { name: "恢复" }).click();
  await page.locator(".el-popconfirm__action").getByRole("button", { name: "恢复" }).click();
  await page.waitForTimeout(400);
  expect(
    (await measureRows(page)).join("\n"),
    `${stage("恢复设备后")} 设备行存在溢出/遮挡`
  ).toBe("");

  // 截图留档(失败时随报告上传)
  await page.screenshot({ path: "test-results/groups-devices-mobile.png", fullPage: true });
  expect(all).toEqual([]); // 占位保持类型
});
