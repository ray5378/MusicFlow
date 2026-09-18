import { test, expect, type Page } from "@playwright/test";

// 播放器页 Sendspin 设备行「解绑」的语义与手机端布局守卫。
//
// 统一名称:三类设备的「删除」现在都叫**解绑**(不再另设「遗忘」),但解的层不同 ——
//   - 已配对(加密设备)      → 清配对记录;
//   - 被服务端记住的拨号目标 → 撤销「添加播放器」:删拨号目标 + 清改名,
//                             **连接保持、行仍在线**(只是不再自动重拨)。
// 明文直连 legacy 没有配对记录可解,它解的就是后者 —— 修复前这类设备在线时
// 两头不靠:解绑按钮因 !paired 不显示,遗忘按钮只挂在离线分支,只能先禁用让它
// 掉线才有出口,与「解绑后仍保留在这一行」的预期相反。
//
// 本文件用 route mock 驱动,不依赖真实局域网设备:
//   1. legacy + 已拨号 + 在线 → 有「解绑」,点了会 DELETE 拨号目标;
//   2. 解绑后**行仍在**(只撤销记住,不断开连接),且按钮随之回落;
//   3. 每类设备都只有一个解绑按钮(不再并列两个删除入口);
//   4. 全程 390/360px 断言设备行不横向溢出、按钮不重叠。

const ADMIN = { username: "admin", password: "admin" };

interface SpinClient {
  clientId: string;
  name: string;
  roles: string[];
  legacy: boolean;
  paired: boolean;
  approved: boolean;
  disabled: boolean;
  dialed: boolean;
  host: string;
  port: number;
}

let clients: SpinClient[] = [];
/** 记录前端实际发出的「撤销添加」请求,用于断言 host/port 没传错。 */
let forgetCalls: { host: string; port: number }[] = [];

function resetState() {
  clients = [
    // ① 明文直连 legacy,服务端主动拨过去的(ESPHome 典型):修复前在线时无删除入口。
    {
      clientId: "esp32-livingroom-0001",
      name: "客厅 ESP32 明文直连",
      roles: ["player"],
      legacy: true,
      paired: false,
      approved: false,
      disabled: false,
      dialed: true,
      host: "192.168.10.88",
      port: 8928,
    },
    // ② 加密已配对 + 服务端拨过去的:解的是配对那一层。
    {
      clientId: "laptop-study-0002",
      name: "书房笔记本 已配对",
      roles: ["player"],
      legacy: false,
      paired: true,
      approved: true,
      disabled: false,
      dialed: true,
      host: "192.168.10.99",
      port: 8928,
    },
    // ③ 加密已配对但**自己连进来**的(非拨号):只能解配对那一层。
    {
      clientId: "phone-selfdial-0003",
      name: "手机端 自行接入",
      roles: ["player"],
      legacy: false,
      paired: true,
      approved: true,
      disabled: false,
      dialed: false,
      host: "",
      port: 0,
    },
  ];
  forgetCalls = [];
}

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

/**
 * 测量所有设备行的布局问题(返回问题描述数组,空 = 干净)。
 * 刻意不 import groups-devices.spec.ts 的同名函数 —— 从 spec 文件导入会连带执行
 * 它的顶层 test(),造成用例重复注册。
 */
async function measureRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const overflow =
      document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (overflow > 1) out.push(`页面横向溢出 ${overflow}px`);
    Array.from(document.querySelectorAll(".device-row")).forEach((row, ri) => {
      const rb = (row as HTMLElement).getBoundingClientRect();
      if (rb.right > window.innerWidth + 1)
        out.push(`设备行#${ri} 右缘 ${Math.round(rb.right)}px 越出视口`);
      const btns = Array.from(row.querySelectorAll("button")).map((b) =>
        b.getBoundingClientRect()
      );
      for (let i = 0; i < btns.length; i++) {
        if (btns[i].right > rb.right + 1)
          out.push(`设备行#${ri} 按钮#${i} 越出设备行右缘 ${Math.round(btns[i].right - rb.right)}px`);
        for (let j = i + 1; j < btns.length; j++) {
          const a = btns[i], b = btns[j];
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
            out.push(`设备行#${ri} 按钮#${i} 与 #${j} 重叠`);
        }
      }
    });
    return out;
  });
}

/** 按显示名定位某一行(页面里 DLNA 与 Sendspin 行共用 .device-row)。 */
function row(page: Page, name: string) {
  return page.locator(".device-row").filter({ hasText: name });
}

/** 该行的「解绑」按钮(统一名称后只有这一个删除类入口)。 */
function unbindBtn(page: Page, name: string) {
  return row(page, name).getByRole("button", { name: "解绑" });
}

test("Sendspin 解绑:明文直连也要有出口,解完行还在", async ({ page }) => {
  await loginAsAdmin(page);
  resetState();

  await page.route("**/rest/api/v1/sendspin/clients", (route) => {
    route.fulfill({ json: { clients, enabled: true, port: 38927 } });
  });
  // GET / DELETE 同 URL:按 method 分流(Playwright 的 route 按注册顺序匹配,
  // 故先注册 GET 的 fallback,再由后者拦 DELETE)。
  await page.route("**/rest/api/v1/sendspin/dial-targets", async (route) => {
    if (route.request().method() === "DELETE") {
      const body = route.request().postDataJSON() || {};
      forgetCalls.push({ host: body.host, port: body.port });
      // 后端语义:撤销记住 —— 目标从列表移除,**连接保持**(dialed 标记抹掉)。
      clients = clients.map((c) =>
        c.host === body.host && c.port === body.port
          ? { ...c, dialed: false, host: "", port: 0 }
          : c
      );
      await route.fulfill({ json: { success: true } });
      return;
    }
    await route.fulfill({
      json: {
        enabled: true,
        targets: clients
          .filter((c) => c.dialed && c.host)
          .map((c) => ({ host: c.host, port: c.port, online: true })),
      },
    });
  });
  await page.route("**/rest/api/v1/dlna/devices", (route) =>
    route.fulfill({ json: { devices: [] } })
  );
  await page.route("**/rest/api/v1/airplay/devices", (route) =>
    route.fulfill({ json: { devices: [] } })
  );

  await page.goto("/groups", { waitUntil: "load" });
  await page.locator(".device-row").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(400);

  // ① 明文直连 + 已拨号 + 在线 → 必须有解绑。这是本次修复的缺口。
  await expect(
    unbindBtn(page, "客厅 ESP32 明文直连"),
    "legacy 明文直连设备在线时没有解绑入口 —— 它无配对可解,只能撤销「添加」"
  ).toBeVisible();

  // ② 每类设备只有一个解绑入口(已配对又已拨号的也只解配对那一层,一次解一层)。
  await expect(
    unbindBtn(page, "书房笔记本 已配对"),
    "已配对设备应只有一个解绑按钮(配对优先,一次只解一层)"
  ).toHaveCount(1);
  await expect(unbindBtn(page, "手机端 自行接入")).toHaveCount(1);

  // 布局:在线行按钮最多,是最容易撑破的一档。
  expect(
    (await measureRows(page)).join("\n"),
    "Sendspin 设备行存在溢出/重叠"
  ).toBe("");

  // ③ 点解绑:DELETE 正确的 host/port。
  await unbindBtn(page, "客厅 ESP32 明文直连").click();
  // popconfirm 是 teleport 到 body 的浮层,确认按钮文案取 common.confirm(中文=「确定」)。
  await page.locator(".el-popconfirm__action").getByRole("button", { name: "确定" }).click();
  await page.waitForTimeout(600);

  expect(forgetCalls, "解绑(撤销添加)应发出 DELETE /v1/sendspin/dial-targets").toHaveLength(1);
  expect(forgetCalls[0]).toEqual({ host: "192.168.10.88", port: 8928 });

  // ④ 关键语义:行还在(只是不再是记住的拨号目标),解绑按钮随之回落。
  await expect(
    row(page, "客厅 ESP32 明文直连"),
    "解绑只撤销记住,不该把设备从列表删掉"
  ).toHaveCount(1);
  await expect(
    unbindBtn(page, "客厅 ESP32 明文直连"),
    "已无可解的绑定后,解绑按钮应回落(不出现点了没反应的死按钮)"
  ).toHaveCount(0);

  await page.screenshot({ path: "test-results/groups-sendspin-mobile.png", fullPage: true });
});
