import { defineConfig } from "@playwright/test";

// 响应式守卫:在手机视口(390×844)下启动真实前后端,遍历所有路由,
// 断言页面与表格不出现横向溢出、插件配置弹窗不超出视口宽度。
// 任何非自适应页面都会让本测试失败 → CI 红,迫使修复(见 MusicFlow 发版流程)。

const BACKEND_PORT = 46400;
const FRONTEND_PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    viewport: { width: 390, height: 844 },
    actionTimeout: 10_000,
    // 本地校验可设 PW_CHANNEL=chrome 复用系统浏览器,跳过 chromium 下载;CI 不设则用自带 chromium。
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    {
      // 手机视口(390×844)。isMobile/touch 不影响 CSS 断点判断,故不强制 isMobile
      // (避免与系统 chrome channel 冲突);响应式判定只看视口宽度。
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
  webServer: [
    {
      // 后端:临时 DATA_DIR 自动 seed 默认管理员 admin/admin。
      command: `cd ../backend && DATA_DIR="$(mktemp -d)" npx tsx src/index.ts`,
      port: BACKEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npm run preview -- --port ${FRONTEND_PORT} --strictPort`,
      port: FRONTEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
