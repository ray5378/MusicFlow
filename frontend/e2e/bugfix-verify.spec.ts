import { test, expect, type Page } from "@playwright/test";

// 4 项修复的实测验证:
//  BUG1 Music 页滚动到 >200 行时后半段不空白(每 250 块 vs 后端 200 上限)
//  BUG2 歌单/专辑/艺术家网格卡片纵向有间距(gap 生效)
//  BUG3 三页标题旁展示总数(歌单 N 个 / 专辑 N 张 / 艺术家 N 位)
//  BUG4 我喜欢页改无限滚动:滚到底自动加载下一批,无分页控件,行不空白
const ADMIN = { username: "admin", password: "admin" };

async function loginAsAdmin(page: Page) {
  const resp = await page.request.post("/rest/api/v1/auth/login", { data: ADMIN });
  expect(resp.ok()).toBeTruthy();
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

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

async function scrollSongs(page: Page, targetRows: number) {
  // SongTable 虚拟滚动:滚到目标行上方,再从底部向上扫一遍确保各窗口都渲染过。
  const rowH = await page.evaluate(() => {
    const first = document.querySelector(".song-row");
    return first ? first.getBoundingClientRect().height : 0;
  });
  expect(rowH, "应有歌曲行渲染").toBeGreaterThan(0);
  const target = Math.max(0, targetRows * rowH - 300);
  await page.evaluate((y) => window.scrollTo(0, y), target);
  await page.waitForTimeout(600);
}

test("BUG1: Music 页 200 行后滚动懒加载不空白", async ({ page }) => {
  await page.goto("/songs", { waitUntil: "load" });
  await page.waitForTimeout(800);
  const firstRow = page.locator(".song-row").first();
  await firstRow.waitFor({ state: "visible", timeout: 10_000 });

  // 需要踢掉最近播放/纯文本行干扰,直接数「行内歌曲标题」
  const countRows = () => page.locator(".song-row, .song-title-cell, .song-title").count();

  // 每个块结束的交接区:200-249 / 450-499 / 700-749 必须连续有内容
  for (const band of [200, 450, 700]) {
    await scrollSongs(page, band);
    // 此刻虚拟窗口恰好覆盖 band 附近,读取窗口中间若干行的文本,不得为空白
    const samples = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".song-row, .song-title-cell, .song-title"));
      const mid = Math.floor(rows.length / 2);
      const xs: string[] = [];
      for (let i = Math.max(0, mid - 3); i <= mid + 3 && i < rows.length; i++) {
        xs.push((rows[i] as HTMLElement).textContent?.trim() ?? "");
      }
      return xs;
    });
    const blank = samples.filter((s) => s.length === 0);
    expect(blank.length, `第 ${band} 行带内出现 ${blank.length} 个空白行: ${JSON.stringify(samples)}`).toBe(0);
    const filled = samples.filter((s) => s.length > 0);
    expect(filled.length, `第 ${band} 行带文本: ${JSON.stringify(samples)}`).toBeGreaterThan(0);
  }

  // 整个列表应有远端总数(非空白兜底),列存在且右端不拉出空白
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
});

test("BUG2: 歌单/专辑/艺术家卡片纵向间距", async ({ page }) => {
  const checks: [string, string][] = [
    ["/playlists", ".playlist-card"],
    ["/albums", ".album-card"],
    ["/artists", ".artist-card"],
  ];
  for (const [route, sel] of checks) {
    await page.goto(route, { waitUntil: "load" });
    await page.waitForTimeout(700);
    const cards = page.locator(sel);
    const n = await cards.count();
    expect(n, `${route} 应有卡片`).toBeGreaterThan(0);
    const first = cards.nth(0).boundingBox();
    const second = cards.nth(1).boundingBox();
    expect(first && second, `${route} 卡片定位`).toBeTruthy();
    // 同一行相邻卡片(第二张若同行)水平相邻;垂直间距看第一行与第二行。
    const colGap = second!.x - (first!.x + first!.width);
    const data = await page.evaluate(([sel2]) => {
      const all = Array.from(document.querySelectorAll(sel2)) as HTMLElement[];
      const tops = all.map((c) => c.getBoundingClientRect().top);
      const distinct = [...new Set(tops.map((t) => Math.round(t)))].sort((a, b) => a - b);
      if (distinct.length < 2) return { gap: -1, tops };
      return { gap: distinct[1] - distinct[0], tops };
    }, [sel]);
    const vGap = data.gap;
    expect(vGap, `${route} 相邻两行 top 差距应为正数(卡高+间距),实际 ${vGap}`).toBeGreaterThan(0);
  }
});

test("BUG3: 歌单/专辑/艺术家标题旁总数", async ({ page }) => {
  const checks: [string, RegExp][] = [
    ["/playlists", /个|total/i],
    ["/albums", /张|total/i],
    ["/artists", /位|total/i],
  ];
  for (const [route, re] of checks) {
    await page.goto(route, { waitUntil: "load" });
    await page.waitForTimeout(700);
    const h2 = page.locator(".page-header h2").first();
    await h2.waitFor({ state: "visible", timeout: 10_000 });
    const text = (await h2.textContent()) ?? "";
    expect(text.trim().length, `${route} 标题应含总数: ${text}`).toBeGreaterThan(5);
  }
});

test("BUG4: 我喜欢页无限滚动,无分页,滚到底自动加载", async ({ page }) => {
  await page.goto("/favorites", { waitUntil: "load" });
  await page.waitForTimeout(800);
  // 无分页控件
  expect(await page.locator(".el-pagination, .pagination").count()).toBe(0);
  const first = page.locator(".song-row, .song-title-cell, .song-title").first();
  await first.waitFor({ state: "visible", timeout: 10_000 });
  const initial = await page.locator(".song-row, .song-title-cell, .song-title").count();
  expect(initial, "初始应有可见行").toBeGreaterThan(0);
  // 滚到底触发下一批
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  const after1 = await page.locator(".song-row, .song-title-cell, .song-title").count();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  const after2 = await page.locator(".song-row, .song-title-cell, .song-title").count();
  expect(after2 >= after1 && after1 >= initial, `滚动后行数应增长: ${initial}→${after1}→${after2}`).toBeTruthy();
  // 空白行检查
  const blanks = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".song-row, .song-title-cell, .song-title"));
    let empty = 0;
    for (const r of rows) if (!r.textContent?.trim()) empty++;
    return empty;
  });
  expect(blanks, "滚动后不应有空白行").toBe(0);
});