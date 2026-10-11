// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "./_env.js";

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ==================== 热重载:插件运行期写入(files/)不得触发全量重载 ====================
//
// 背景(接 lx-source 沙箱 teardown 风暴复盘):`<pluginDir>/files` 是 host.fs 的可写根
// (discovery.ts makeFsApi),插件会在里面落磁盘缓存/会话态。热重载递归监听整个
// data/plugins,若不过滤这些运行期写入,链路是:
//
//   插件写自己的缓存 files/x.js
//     → watch 命中 → 全量热重载 → dispose 所有外置插件沙箱(含 jsenv 子环境)
//     → 取链 pipeline 无退避重试,重建后又踩一遍 teardown
//
// 一次磁盘写被放大成一轮沙箱 teardown 风暴。本文件守住「写 files/ 不重载、改 index.js 照常重载」。

// hotReload 只从 discovery.js 取 discoverExternalPlugins + 常量 PLUGIN_FILES_DIR。
// 这里把它整个替身掉:既不真跑一次全量发现(会碰 DB),又能直接观测到「有没有被调度」。
const { reloadMock } = vi.hoisted(() => ({ reloadMock: vi.fn(async () => 1) }));
vi.mock("../../src/plugins/discovery.js", () => ({
  PLUGIN_FILES_DIR: "files",
  discoverExternalPlugins: reloadMock,
}));

const { startPluginHotReload, stopPluginHotReload, isPluginPrivateWrite } =
  await import("../../src/plugins/hotReload.js");

/** 重载 debounce 800ms + 文件系统事件投递抖动 —— 每个阶段都留够余量再看结果。 */
const PHASE_WAIT_MS = 1600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRoot(): { root: string; pluginDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-hotreload-"));
  const pluginDir = path.join(root, "demo-plugin");
  fs.mkdirSync(path.join(pluginDir, "files", "cache"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.js"), "// v0\n");
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), "{}");
  fs.writeFileSync(path.join(pluginDir, "files", "index-cache.js"), "// v0\n");
  return {
    root,
    pluginDir,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

describe("插件运行期写入(files/)不触发热重载", () => {
  const roots: Array<() => void> = [];

  afterEach(() => {
    stopPluginHotReload();
    delete process.env.MF_HOTRELOAD_NO_FILES_FILTER;
    reloadMock.mockClear();
    for (const c of roots.splice(0)) { try { c(); } catch { /* ignore */ } }
  });

  // ---------- A. 判定精度(纯函数,不依赖文件系统) ----------
  it("A1 isPluginPrivateWrite 只认 <id>/files/ 之下的路径", () => {
    const root = path.join(path.sep, "data", "plugins");
    // 该过滤的:私有目录内的任意层级
    expect(isPluginPrivateWrite(root, "lx-source/files/a.js")).toBe(true);
    expect(isPluginPrivateWrite(root, "lx-source/files/cache/deep.bin")).toBe(true);
    expect(isPluginPrivateWrite(root, "lx-source\\files\\a.js")).toBe(true); // Windows 形态
    expect(isPluginPrivateWrite(root, path.join(root, "lx-source", "files", "a.js"))).toBe(true); // 绝对路径
    // 不该过滤的:插件根下的代码与配置必须照常触发重载
    expect(isPluginPrivateWrite(root, "lx-source/index.js")).toBe(false);
    expect(isPluginPrivateWrite(root, "lx-source/plugin.json")).toBe(false);
    expect(isPluginPrivateWrite(root, "lx-source/package.json")).toBe(false);
    expect(isPluginPrivateWrite(root, "lx-source/src/util.js")).toBe(false);
    expect(isPluginPrivateWrite(root, "lx-source/files.json")).toBe(false); // 同名文件 ≠ 同名目录
    expect(isPluginPrivateWrite(root, "index.js")).toBe(false);
    expect(isPluginPrivateWrite(root, "")).toBe(false);
    // 插件 id 恰好叫 files 时,它的根目录仍是代码区
    expect(isPluginPrivateWrite(root, "files/index.js")).toBe(false);
    // 监听根之外的路径不该被我们判定
    expect(isPluginPrivateWrite(root, path.join(path.sep, "other", "files", "a.js"))).toBe(false);
  });

  // ---------- B. 真实 watch:写 files/ 不重载,改 index.js 照常重载 ----------
  it(
    "B1 写 <id>/files/ 下文件不触发重载;随后改插件根 index.js 仍触发重载",
    async () => {
      const { root, cleanup } = makeRoot();
      roots.push(cleanup);
      startPluginHotReload(root);

      // 阶段 1:运行期写入私有目录 → 期望零次重载
      await sleep(150); // 让 watch 就绪
      fs.writeFileSync(path.join(root, "demo-plugin", "files", "cache", "src.js"), "// v1\n");
      fs.writeFileSync(path.join(root, "demo-plugin", "files", "session.json"), '{"v":1}');
      await sleep(PHASE_WAIT_MS);
      expect(reloadMock).not.toHaveBeenCalled();

      // 阶段 2:真改代码 → 必须重载(证明 watch 本身是活的、上面不是「全都没触发」的假绿)
      reloadMock.mockClear();
      fs.writeFileSync(path.join(root, "demo-plugin", "index.js"), "// v1\n");
      await sleep(PHASE_WAIT_MS);
      expect(reloadMock).toHaveBeenCalled();

      // 阶段 3:改配置同样要重载
      reloadMock.mockClear();
      fs.writeFileSync(path.join(root, "demo-plugin", "plugin.json"), '{"v":1}');
      await sleep(PHASE_WAIT_MS);
      expect(reloadMock).toHaveBeenCalled();
    },
    30000,
  );

  // ---------- C. 双向变异:短路过滤后,写 files/ 必须重新触发重载 ----------
  it(
    "C1 反差(灵敏度校准):短路 files/ 过滤后,同一操作必须重新触发重载",
    async () => {
      process.env.MF_HOTRELOAD_NO_FILES_FILTER = "1";
      const { root, cleanup } = makeRoot();
      roots.push(cleanup);
      startPluginHotReload(root);

      await sleep(150);
      fs.writeFileSync(path.join(root, "demo-plugin", "files", "cache", "src.js"), "// v1\n");
      await sleep(PHASE_WAIT_MS);

      // 这条若变绿(写 files/ 也不再触发),说明 B1 的第一段断言已经失去判别力。
      expect(reloadMock).toHaveBeenCalled();
    },
    30000,
  );
});
