// Host API 三处接线一致性检查(CI 强制,防「新 host 方法只接了一处」):
//   1. sandboxWorker.ts makeWorkerEnv 的 env.<group>.* 方法键
//   2. sandbox.ts  — SandboxHostEnv <group> 类型声明 + QuickJS setProp 接线
//   3. discovery.ts — 直连宿主(direct host)env.<group> 实现
//
// 两级键分发(level-1 = 能力组,level-2 = 组内方法键),覆盖两种组形态:
//   A. 内联对象组(songs):三处各自内联实现 —— worker 键集必须与 sandbox 类型 /
//      sandbox 接线 / discovery 直连三方一致(worker ⊆ 直连 = 全量),新增 host.songs
//      方法漏接任一处即红。
//   B. 共享实现组(crypto):唯一实现源 = pluginCrypto.ts 的 createPluginCrypto();
//      discovery / sandboxWorker 直接 `crypto: createPluginCrypto()`,sandbox.ts 只声明
//      类型 + 逐方法 setProp 转发。此组从 pluginCrypto 的**契约接口**取全量键,再做
//      **双向**校验(sandbox 接线键集 == 契约键集,不多不少)+ 静态导入 / tripwire。
//
// 背景:host.songs.match(v2.3.9,插件统一库内匹配器)接入时曾三处分散修改漏接一处,
// 本测试把「通用能力必须全通道可达」固化为回归门禁;host.crypto 密码学原语化
// (pluginCrypto,支持 QQ/网易云插件侧加密)沿用同一门禁,尤其防止三处实现漂移。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const srcDir = join(fileURLToPath(new URL(import.meta.url)), "..", "..", "..", "src", "plugins");
const sandboxSrc = readFileSync(join(srcDir, "sandbox.ts"), "utf-8");
const discoverySrc = readFileSync(join(srcDir, "discovery.ts"), "utf-8");
const workerSrc = readFileSync(join(srcDir, "sandboxWorker.ts"), "utf-8");
const pluginCryptoSrc = readFileSync(join(srcDir, "pluginCrypto.ts"), "utf-8");

/** 从 sandboxWorker.ts makeWorkerEnv 里提取内联 `env.<group>: { ... }` 的方法键。 */
function workerEnvKeys(group: string): string[] {
  const re = new RegExp(group + ":\\s*\\{([\\s\\S]*?)\\n    \\},");
  const m = workerSrc.match(re);
  expect(m, "sandboxWorker.ts 应包含内联 env." + group + " 块").toBeTruthy();
  const keys: string[] = [];
  for (const km of (m![1] || "").matchAll(/^\s+([a-zA-Z]\w*):\s*\(/gm)) keys.push(km[1]);
  return keys;
}

/** 从 pluginCrypto.ts 的 `interface PluginCrypto { ... }` 提取契约方法全集(共享组真源)。 */
function pluginCryptoContractKeys(): string[] {
  const m = pluginCryptoSrc.match(/interface PluginCrypto \{([\s\S]*?)\n\}/);
  expect(m, "pluginCrypto.ts 应声明 interface PluginCrypto").toBeTruthy();
  const keys: string[] = [];
  for (const km of (m![1] || "").matchAll(/^\s+([a-zA-Z]\w*)\(/gm)) keys.push(km[1]);
  return keys;
}

/** 从 sandbox.ts 提取 `c.setProp(<objVar>, "<key>"` 的键(用于反向校验接线不多不少)。 */
function sandboxSetPropKeys(objVar: string): string[] {
  const re = new RegExp("c\\.setProp\\(" + objVar + ',\\s*"([a-zA-Z]\\w*)"', "g");
  const keys: string[] = [];
  for (const m of sandboxSrc.matchAll(re)) keys.push(m[1]);
  return keys;
}

describe("host API 三处接线一致性 · 两级键分发", () => {
  // ==================== 组 A:内联对象组 songs(三处各自内联)====================
  describe("组 songs(内联三处一致)", () => {
    const keys = workerEnvKeys("songs");

    it("worker env.songs 应包含已知方法全集", () => {
      expect(new Set(keys)).toEqual(new Set(["list", "search", "getById", "match"]));
    });

    for (const key of keys) {
      it(`songs.${key} 三处接线齐全`, () => {
        // sandbox.ts:类型声明 + QuickJS 对象接线
        expect(sandboxSrc, `sandbox.ts 类型缺 songs.${key}`).toMatch(
          new RegExp("songs:\\s*\\{[\\s\\S]*?\\n\\s*" + key + "\\(")
        );
        expect(sandboxSrc, `sandbox.ts 接线缺 songs.${key}`).toContain(
          `c.setProp(songsObj, "${key}"`
        );
        // discovery.ts:直连宿主实现
        expect(discoverySrc, `discovery.ts 直连宿主缺 songs.${key}`).toMatch(
          new RegExp("\\n\\s+" + key + ":\\s*async")
        );
        // worker env:后台批量任务通道
        expect(workerSrc, `sandboxWorker.ts env 缺 songs.${key}`).toContain(key + ": ");
      });
    }
  });

  // ============ 组 B:共享实现组 crypto(唯一实现源 = pluginCrypto.ts)============
  describe("组 crypto(唯一实现源 pluginCrypto.ts)", () => {
    const keys = pluginCryptoContractKeys();

    it("pluginCrypto 契约恰好包含 7 个原语", () => {
      expect(new Set(keys)).toEqual(
        new Set(["md5", "sha1", "sha256", "randomBytes", "aesEncrypt", "aesDecrypt", "rsaEncrypt"])
      );
    });

    it("直连宿主(discovery.ts)与 worker(sandboxWorker.ts)均注入 createPluginCrypto()", () => {
      expect(discoverySrc, "discovery.ts 未用 createPluginCrypto() 注入 crypto").toMatch(
        /crypto:\s*createPluginCrypto\(\),/
      );
      expect(workerSrc, "sandboxWorker.ts 未用 createPluginCrypto() 注入 crypto").toMatch(
        /crypto:\s*createPluginCrypto\(\),/
      );
    });

    it("discovery.ts 静态导入 createPluginCrypto(主进程走 tsx/vite,可 .js→.ts 重映射)", () => {
      expect(discoverySrc, "discovery.ts 缺 createPluginCrypto 静态导入").toMatch(
        /import\s*\{\s*createPluginCrypto\s*\}\s*from\s*"\.\/pluginCrypto\.js"/
      );
    });

    it("sandboxWorker.ts 运行时解析 pluginCrypto 入口(dev 下 .js→.ts)", () => {
      // worker 以原生 ESM(dev:Node 类型剥离)加载本文件,静态 "./pluginCrypto.js"
      // 不会被重映射 → 必须 existsSync 探测 .js/.ts + 动态 import(与 sandbox 同理)。
      expect(workerSrc, "sandboxWorker.ts 缺 pluginCrypto 入口运行时解析").toMatch(
        /existsSync\(join\(HERE, "pluginCrypto\.js"\)\)[\s\S]*?pluginCrypto\.ts/
      );
      expect(workerSrc, "sandboxWorker.ts 缺动态 import createPluginCrypto").toMatch(
        /await import\(pathToFileURL\(cryptoEntry\)\.href\)[\s\S]*?createPluginCrypto/
      );
    });

    // tripwire(worker 专属):静态 import "./pluginCrypto.js" 会在 dev 下
    // ERR_MODULE_NOT_FOUND(本仓实测踩坑),必须走运行时解析。
    it("tripwire:sandboxWorker.ts 不得静态 import ./pluginCrypto.js", () => {
      expect(
        workerSrc,
        "sandboxWorker.ts 静态 import pluginCrypto 会在 dev 下炸(.js 不被重映射为 .ts)"
      ).not.toMatch(/^import[\s\S]{0,120}?from\s+["']\.\/pluginCrypto\.js["']/m);
    });

    // tripwire:sandbox.ts 会被 worker 以原生 ESM 动态加载,必须保持零新依赖——
    // 绝不能从 pluginCrypto 导入(转发式接线,实现由 env.crypto 注入)。
    it("tripwire:sandbox.ts 不得从 pluginCrypto 导入(保持零新依赖)", () => {
      expect(
        sandboxSrc,
        "sandbox.ts 不得 import pluginCrypto(会破坏 worker 原生 ESM 加载路径)"
      ).not.toMatch(/from\s+["']\.\/pluginCrypto(\.js)?["']/);
    });

    for (const key of keys) {
      it(`crypto.${key} 类型声明 + 转发接线齐全`, () => {
        // sandbox.ts 类型声明
        expect(sandboxSrc, `sandbox.ts 类型缺 crypto.${key}`).toMatch(
          new RegExp("crypto:\\s*\\{[\\s\\S]*?\\n\\s*" + key + "\\(")
        );
        // sandbox.ts QuickJS 转发接线
        expect(sandboxSrc, `sandbox.ts 接线缺 crypto.${key}`).toContain(
          `c.setProp(cryptoObj, "${key}"`
        );
      });
    }

    // 反向:接线键集必须与契约双向一致(多接 / 少接都红)。
    it("sandbox.ts 的 crypto 接线键集与 pluginCrypto 契约双向一致", () => {
      const wired = sandboxSetPropKeys("cryptoObj");
      expect(new Set(wired), "sandbox.ts crypto 接线键集 ≠ pluginCrypto 契约").toEqual(new Set(keys));
    });
  });
});
