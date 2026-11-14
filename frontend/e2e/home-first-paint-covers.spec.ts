import { test, expect, type Page } from "@playwright/test";

// 首页首屏封面优先级回归守卫(2026-10-19 首页打开提速;2026-11-10 下半屏改为懒挂载)。
//
// 契约(与 backend/scripts/check-home-perf.mjs 的 R3 静态计数断言同源,这里补行为级验证):
//   - 上半屏「固定推荐卡 + 并排随机歌单」封面:**急切加载**(`:src` 直接赋值,不依赖
//     IntersectionObserver)且 fetchpriority="high" —— 首屏可见的几张先抢到连接;
//   - 下半屏「平台精选 / 本地随机」:**首屏不挂载**(每个分区包 `LazyMount`,滚到视口
//     附近才渲染),因此首屏既没有这些分区、也没有它们的封面请求;
//   - 下半屏挂载后仍保持 `v-lazy-cover` 懒加载 + `fetchpriority="low"`。
//
// 关键点:如果不 stub IntersectionObserver,上半屏即便误用 v-lazy-cover,因卡片本就在
// 首屏视口内,observer 回调也会立刻补上 src —— 「急切 vs 懒加载」根本区分不出来,
// 守卫会退化成空转。故「首屏契约」用例把 IntersectionObserver 换成「只注册、永不回调」
// 的替身:
//   * `:src` 由 Vue 模板直接写入,不经过 observer ⇒ src 必然存在;
//   * `v-lazy-cover` 的 src 只在 observer 回调里写入 ⇒ 永不被赋值;
//   * `LazyMount` 的 observer 永不回调;但它另有 `nearViewport()` 同步判定兜底
//     (2026-11-14 为修「垫占位高度后观察器不补发通知」而加),阈值内的块仍会当场挂载。
//     故第 3 条断言守的是「首屏不全挂」,不是「一个都不挂」。
// 「滚动后」用例使用真实 observer,验证懒挂载可以正常补齐、封面仍为 low。
//
// CI 后端是临时空库,故本用例用 page.route 注入确定性数据,使断言不依赖真实曲库。
// 双向可回归:上半屏改回 v-lazy-cover(high 封面将没有 src)判红;下半屏去掉 LazyMount
// (首屏分区数达到总数)判红;下半屏任一封面改成 `:src`(挂载即带 src)判红。

const ADMIN = { username: "admin", password: "admin" };

/** 把 IntersectionObserver 换成只注册、永不回调的替身(见文件头说明)。 */
async function stubIntersectionObserver(page: Page) {
  await page.addInitScript(() => {
    class NoopIntersectionObserver {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_cb: IntersectionObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    // @ts-ignore 覆盖原生实现,使 lazyCover / LazyMount 走「有 observer 但回调永不触发」分支。
    window.IntersectionObserver = NoopIntersectionObserver;
  });
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

// 8 张「并排随机」歌单(≥30 首才进池):homeCount=8、无固定卡 ⇒ 上半屏恰好 8 张。
const PLAYLISTS = Array.from({ length: 8 }, (_, i) => ({
  id: `pl-${i + 1}`,
  name: `测试歌单 ${i + 1}`,
  songCount: 40,
  coverArt: `cov-${i + 1}`,
}));

// 下半屏注入 4 个分区(各 2 首歌单)。分区数必须明显多于「阈值内会挂载的块数」,
// 否则「首屏不全挂」与「一次性全挂」无法区分:
// 2026-11-14 LazyMount 改为「真实滚动容器 + 600px 阈值 + nearViewport 同步判定」后,
// 手机视口(块矮)会直接挂载阈值内的 2~3 块 —— 挂载本身是期望行为,该守的是「不全挂」。
const LOWER_CHANNELS = ["local", "qq", "netease", "kugou"].map((s, i) => ({
  source: s,
  name: `分区 ${s}`,
  sortOrder: i + 2,
  playlists: [1, 2].map((n) => ({
    id: `${s.toUpperCase()}-${n}`,
    name: `${s} ${n}`,
    coverArt: `lc-${s}-${n}`,
  })),
}));

/** section 总数 = 顶部 1 + 平台精选 1 + 本地随机 N。 */
const TOTAL_SECTIONS = 1 + 1 + LOWER_CHANNELS.length;
/** 下半屏封面总数 = 两个来源分区合计 × 2 首(全挂才等于它)。 */
const TOTAL_LOW_COVERS = (1 + LOWER_CHANNELS.length) * 2;

/** 注入首页所需的确定性数据(仅拦 5 个首页取数端点,其余仍走真实后端)。 */
async function mockHomeData(page: Page) {
  // 首页并排随机池已改走轻量接口(2026-10-20):只回 id/name/songCount,
  // 不含 coverArt(封面由前端按 pl-<id> 派生),故这里按真实响应契约构造假数据。
  await page.route(/\/rest\/api\/v1\/home\/playlist-pool$/, (r) =>
    r.fulfill({
      json: {
        success: true,
        total: PLAYLISTS.length,
        items: PLAYLISTS.map((p) => ({ id: p.id, name: p.name, songCount: p.songCount })),
      },
    }),
  );
  await page.route(/\/rest\/api\/v1\/home\/playlist-count$/, (r) => r.fulfill({ json: { count: 8 } }));
  await page.route(/\/rest\/api\/v1\/recommend\/home-cards$/, (r) => r.fulfill({ json: { cards: [] } }));
  await page.route(/\/rest\/api\/v1\/local-recommend$/, (r) =>
    r.fulfill({ json: { pending: false, channels: LOWER_CHANNELS } }),
  );
  await page.route(/\/rest\/api\/v1\/recommend$/, (r) =>
    r.fulfill({
      json: {
        providerId: "go-music-dl",
        pending: false,
        channels: [
          {
            source: "qq",
            name: "QQ音乐",
            sortOrder: 1,
            playlists: [
              { id: "r1", name: "精选 1", cover: "https://example.invalid/r1.jpg" },
              { id: "r2", name: "精选 2", cover: "https://example.invalid/r2.jpg" },
            ],
          },
        ],
      },
    }),
  );
}

/** 逐段下滚页面主滚动容器(站点用的是自定义滚动容器,不一定是 window)。 */
async function scrollDownSteps(page: Page, steps: number, delta = 1200) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((d) => {
      const els = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
        (e) =>
          e.scrollHeight > e.clientHeight + 80 &&
          ["auto", "scroll"].includes(getComputedStyle(e).overflowY),
      );
      const el = els.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (el) el.scrollTop += d;
    }, delta);
    await page.waitForTimeout(300);
  }
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test("首页首屏:上半屏 high 且急切加载,下半屏分区首屏不全挂载", async ({ page }) => {
  await stubIntersectionObserver(page);
  await mockHomeData(page);
  await page.goto("/", { waitUntil: "load" });

  const high = page.locator('img.card-cover[fetchpriority="high"]');
  const low = page.locator('img.card-cover[fetchpriority="low"]');

  // 1) 上半屏恰好 8 张,且全部 fetchpriority=high。
  await expect.poll(() => high.count(), { timeout: 20_000 }).toBe(8);

  // 2) 上半屏必须「急切加载」:每张都已设置 src(observer 永不回调,故只能来自 :src)。
  for (let i = 0; i < 8; i++) {
    const src = await high.nth(i).getAttribute("src");
    expect(src, `首屏第 ${i + 1} 张封面应已设置 src(急切加载)`).toBeTruthy();
  }

  // 3) 下半屏首屏「不全挂」:阈值外的分区仍等滚动挂载(LazyMount 仍在起作用)。
  //    2026-11-14:LazyMount 增加 nearViewport() 同步判定(修「垫了占位高度后观察器不补
  //    发通知」),所以阈值内的块即使 observer 被打桩也会当场挂载 —— 断言从「恰好 1 个」
  //    改为「少于总数」,既允许阈值内挂载,又能在「去掉 LazyMount 全量渲染」时判红。
  await expect
    .poll(() => page.locator(".home-page section.section").count(), { timeout: 20_000 })
    .toBeLessThan(TOTAL_SECTIONS);
  expect(await low.count(), "首屏不应把下半屏封面全部挂上").toBeLessThan(TOTAL_LOW_COVERS);
});

test("首页滚动后:下半屏分区按需挂载,封面 low 且懒加载", async ({ page }) => {
  await mockHomeData(page);
  await page.goto("/", { waitUntil: "load" });

  const low = page.locator('img.card-cover[fetchpriority="low"]');
  const sections = page.locator(".home-page section.section");

  // 逐段下滚:下半屏分区应被 LazyMount 逐个挂载(注入数据为 2 个分区)。
  await scrollDownSteps(page, 16);
  await expect.poll(() => sections.count(), { timeout: 20_000 }).toBeGreaterThan(1);
  await expect.poll(() => low.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  // 挂载后仍是懒加载:滚到底的过程中封面会被 observer 补上 src(不能永远不加载)。
  await scrollDownSteps(page, 8);
  await expect
    .poll(
      async () => {
        const n = await low.count();
        let loaded = 0;
        for (let i = 0; i < n; i++) {
          if (await low.nth(i).getAttribute("src")) loaded += 1;
        }
        return loaded;
      },
      { timeout: 15_000, message: "下半屏封面滚动进入视口后应被懒加载补上 src" },
    )
    .toBeGreaterThanOrEqual(2);
});
