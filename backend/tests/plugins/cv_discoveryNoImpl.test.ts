// ==================== 覆盖率 C 类缺口:外置插件 create() 未返回 impl 的跳过路径 ====================
//
// 目标:src/plugins/discovery.ts 633-637 —— loadSandboxedPlugin 返回的 impl 为
// undefined / null / 非对象时:sandbox.dispose() 被调用 + 跳过该插件 + continue
// 加载目录里的下一个插件。
//
// mock 策略:整体 mock ../sandbox.js 的 loadSandboxedPlugin(保留其余真实导出,
// 免得其它模块的具名导入变 undefined):按真实沙箱契约——eval 插件 index.js 得到
// globalThis.__mfPlugin,再调用其 create() 取 impl;sandbox 暴露 manifest 与
// dispose()。dispose 用计数数组观察(行为断言:dispose 恰好一次、且好插件不被
// dispose、被跳过插件的沙箱不进 pluginSandboxes、好插件照常注册加载)。
// ⚠️ readdirSync 的顺序跨平台不保证字母序,所有断言均不依赖扫描顺序:
// 3 个插件、2 个被跳过 ⇒ 无论顺序如何,634-637 的 dispose + continue 路径必然执行,
// 且 zzz-good 在同一次扫描内仍被加载(continue 断言「好插件仍被加载」,不断言「下一个」)。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const M = vi.hoisted(() => ({
  disposes: [] as string[],
  loaded: [] as string[],
}));

vi.mock("../../src/plugins/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/plugins/sandbox.js")>();
  return {
    ...actual,
    loadSandboxedPlugin: async (id: string, code: string) => {
      const g = globalThis as any;
      g.__mfPlugin = undefined;
      new Function(code)();
      const plugin = g.__mfPlugin;
      // 真实沙箱里 create() 是同步调用(插件代码均为同步 create)
      const impl = typeof plugin?.create === "function" ? plugin.create() : undefined;
      M.loaded.push(id);
      return {
        sandbox: {
          manifest: plugin.manifest,
          dispose: () => {
            M.disposes.push(id);
          },
        },
        impl,
      };
    },
    // makeJsenvApi 只在插件实际用到 host.jsenv 时才需要模块,测试用例不触达
    getSandboxModule: async () => ({}),
  };
});

import { discoverExternalPlugins, pluginSandboxes } from "../../src/plugins/discovery.js";
import { getPlugin } from "../../src/plugins/registry.js";

const tmp = path.join(os.tmpdir(), `mf-cv-noimpl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

function writePlugin(id: string, createReturn: string): void {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `globalThis.__mfPlugin = {
      manifest: {
        id: "${id}",
        name: "CV ${id}",
        version: "1.0.0",
        type: "importer",
        description: "cv noimpl test plugin",
        capabilities: ["playlistImport"],
        configSchema: [],
      },
      create() { return ${createReturn}; },
    };`,
    "utf8",
  );
}

let scanned = 0;

beforeAll(async () => {
  fs.mkdirSync(tmp, { recursive: true });
  writePlugin("aaa-noimpl", "undefined"); // !impl → 634 dispose + 635 warn + 636 continue
  writePlugin("bbb-numimpl", "42"); // typeof impl !== "object" → 同一分支
  writePlugin("zzz-good", "{ canHandle: () => false, fetchPlaylist: async () => ({}) }");
  scanned = await discoverExternalPlugins("1.0.0", tmp);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("discoverExternalPlugins:create() 未返回 impl 对象的插件被跳过", () => {
  it("非 impl 插件不注册,同一次扫描内后续/先前的正常插件仍被加载(continue 路径)", () => {
    expect(scanned).toBe(1); // 只有 zzz-good 成功
    expect(getPlugin("zzz-good")).toBeDefined();
    expect(getPlugin("aaa-noimpl")).toBeUndefined();
    expect(getPlugin("bbb-numimpl")).toBeUndefined();
  });

  it("被跳过插件的沙箱恰好 dispose 一次且不进 pluginSandboxes;好插件沙箱正常持有", () => {
    // 三个插件的沙箱都被创建,但只有好插件没被 dispose(顺序无关)
    expect(M.loaded).toHaveLength(3);
    expect(new Set(M.loaded)).toEqual(new Set(["aaa-noimpl", "bbb-numimpl", "zzz-good"]));
    expect(M.disposes).toHaveLength(2);
    expect(new Set(M.disposes)).toEqual(new Set(["aaa-noimpl", "bbb-numimpl"]));
    expect(M.disposes).not.toContain("zzz-good");
    expect(pluginSandboxes.has("aaa-noimpl")).toBe(false);
    expect(pluginSandboxes.has("bbb-numimpl")).toBe(false);
    expect(pluginSandboxes.has("zzz-good")).toBe(true);
  });
});
