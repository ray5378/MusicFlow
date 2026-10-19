import { test, expect, type Page } from "@playwright/test";

// 首页首屏封面优先级回归守卫(2026-10-19 首页打开提速)。
//
// 契约(与 backend/scripts/check-home-perf.mjs 的 R3 静态计数断言同源,这里补行为级验证):
//   - 上半屏「固定推荐卡 + 并排随机歌单」封面:**急切加载**(`:src` 直接赋值,不依赖
//     IntersectionObserver)且 fetchpriority="high" —— 首屏可见的几张先抢到连接;
//   - 下半屏「平台精选 / 本地随机」封面:保持 v-lazy-cover 懒加载(未滚动时**不设置
//     src**)且 fetchpriority="low" —— 不把屏外上百张同源封面一次排进队列。
//
// 关键点:如果不 stub IntersectionObserver,上半屏即便误用 v-lazy-cover,因卡片本就在
// 首屏视口内,observer 回调也会立刻补上 src —— 「急切 vs 懒加载」根本区分不出来,
// 守卫会退化成空转。故这里把 IntersectionObserver 换成「只注册、永不回调」的替身:
//   * `:src` 由 Vue 模板直接写入,不经过 observer ⇒ src 必然存在;
//   * `v-lazy-cover` 的 src 只在 observer 回调里写入 ⇒ 永不被赋值。
// 于是「上半屏有 src / 下半屏无 src」成为可判别断言。
//
// CI 后端是临时空库,故本用例用 page.route 注入确定性数据,使断言不依赖真实曲库。
// 双向可回归:上半屏改回 v-lazy-cover(high 封面将没有 src)判红;下半屏任一改成 `:src`
// (low 封面将立刻有 src)判红。

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
    // @ts-ignore 覆盖原生实现,使 lazyCover 走「有 observer 但回调永不触发」分支。
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

/** 注入首页所需的确定性数据(仅拦 5 个首页取数端点,其余仍走真实后端)。 */
async function mockHomeData(page: Page) {
  await page.route(/\/rest\/api\/v1\/playlists(\?|$)/, (r) =>
    r.fulfill({ json: { items: PLAYLISTS, total: PLAYLISTS.length } }),
  );
  await page.route(/\/rest\/api\/v1\/home\/playlist-count$/, (r) => r.fulfill({ json: { count: 8 } }));
  await page.route(/\/rest\/api\/v1\/recommend\/home-cards$/, (r) => r.fulfill({ json: { cards: [] } }));
  await page.route(/\/rest\/api\/v1\/local-recommend$/, (r) =>
    r.fulfill({
      json: {
        pending: false,
        channels: [
          {
            source: "local",
            name: "本地音乐",
            sortOrder: 2,
            playlists: [
              { id: "L1", name: "本地随机 1", coverArt: "lc-1" },
              { id: "L2", name: "本地随机 2", coverArt: "lc-2" },
            ],
          },
        ],
      },
    }),
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

test.beforeEach(async ({ page }) => {
  await stubIntersectionObserver(page);
  await loginAsAdmin(page);
});

test("首页首屏封面优先:上半屏 high 且急切加载,下半屏 low 且懒加载不预取", async ({ page }) => {
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

  // 3) 下半屏(平台精选 + 本地随机,注入 2+2 张)到达后为 low 优先级。
  await expect.poll(() => low.count(), { timeout: 25_000 }).toBeGreaterThanOrEqual(2);

  // 4) 下半屏必须仍是「懒加载」:未滚动时,全部 low 封面都**未设置 src**
  //    (任一改成 :src 都会立刻有 src → 返回 -1 → 判红)。
  await expect
    .poll(
      async () => {
        const n = await low.count();
        if (n === 0) return -1; // 数据未就绪,继续轮询
        let empty = 0;
        for (let i = 0; i < n; i++) {
          if (!(await low.nth(i).getAttribute("src"))) empty += 1;
        }
        // 全部懒加载 ⇒ 返回张数 n(>=2);否则返回 -1 使断言之失败。
        return empty === n ? n : -1;
      },
      { timeout: 10_000, message: "未滚动时下半屏封面应全部未设置 src(懒加载)" },
    )
    .toBeGreaterThanOrEqual(2);
});
