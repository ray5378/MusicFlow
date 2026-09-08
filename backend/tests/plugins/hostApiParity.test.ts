// Host API 三处接线一致性检查(CI 强制,防「新 host 方法只接了一处」):
//   1. sandboxWorker.ts makeWorkerEnv 的 env.songs.* 方法键
//   2. sandbox.ts  — SandboxHostEnv songs 类型声明 + QuickJS setProp 接线
//   3. discovery.ts — 直连宿主(direct host)env.songs 实现
// 三处集合必须一致(worker ⊆ 直连 = 全量;新增 host.songs 方法漏接任一处即红)。
// 背景:host.songs.match(v2.3.9,插件统一库内匹配器)接入时曾三处分散修改,
// 本测试把「通用能力必须全通道可达」固化为回归门禁。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const srcDir = join(fileURLToPath(new URL(import.meta.url)), "..", "..", "..", "src", "plugins");
const workerSrc = readFileSync(join(srcDir, "sandboxWorker.ts"), "utf-8");
const sandboxSrc = readFileSync(join(srcDir, "sandbox.ts"), "utf-8");
const discoverySrc = readFileSync(join(srcDir, "discovery.ts"), "utf-8");

/** 从 sandboxWorker.ts makeWorkerEnv 里提取 env.<group> 的方法键。 */
function workerEnvKeys(group: string): string[] {
  const re = new RegExp(group + ":\\s*\\{([\\s\\S]*?)\\n    \\},");
  const m = workerSrc.match(re);
  expect(m, "sandboxWorker.ts 应包含 env." + group + " 块").toBeTruthy();
  const keys: string[] = [];
  for (const km of (m![1] || "").matchAll(/^\s+([a-zA-Z]\w*):\s*\(/gm)) keys.push(km[1]);
  return keys;
}

describe("host API 三处接线一致性(songs)", () => {
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
