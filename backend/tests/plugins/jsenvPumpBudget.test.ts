// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "./_env.js";

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import { makeJsenvApi } from "../../src/plugins/discovery.js";

/**
 * P0 回归守卫:jsenv pumpJobs 空转满预算(真机表现 = 插件方法被宿主 20s 预算掐断 -> HTTP 500)。
 *
 * 历史缺陷:execute() 算出了 `done`(目标 promise 是否已 settle)却从未传给 pumpJobs,
 * pumpJobs 只能无条件 `while (Date.now() - t0 < budgetMs)` 空转 —— 于是哪怕子环境里
 * 只有一个 1ms 就能结算的微任务,一次 jsenv.execute 也要吃满预算。而预算(25s)大于
 * 宿主主线程 INVOKE_TIMEOUT_MS(20s, sandbox.ts),结果必然是插件调用超时。
 *
 * 实测现场:lx-source 里凡是异步注册的音源(长青SVIP / fish / ikun / 念心 / 星海)
 * 单独测试都是整整 20.0s 后 500;同步注册的音源 0.0s 成功。
 *
 * 本文件锁住四件事:
 *   1) 快结算的 pending job -> execute 立即返回(until 提前退出有效),且结果不丢;
 *   2) 永不结算的 pending job -> execute 也必须在预算量级内返回(硬上限必须 < 20s);
 *   3) 预算常量必须小于宿主主线程调用预算 20s(源码级静态守卫);
 *   4) promise handle 的 dispose 必须容错(源码级静态守卫,见 discovery.ts execute 末尾)。
 * 双向变异验证见文件末尾注释(改 until / 改预算常量,前两条必须分别失败)。
 */

/** 正常路径:1ms 级就能 settle 的任务,整次 execute 必须远快于预算。留足 CI 抖动余量。 */
const FAST_SETTLE_MAX_MS = 3000;
/** 硬上限:永不 settle 的任务,execute 最多跑到预算量级(8s)+ 抖动,绝不能到 20s/25s。 */
const HARD_BUDGET_MAX_MS = 12000;
/** 单测超时必须大于上面的硬上限,否则 vitest 默认 5s 会先掐断测试本身。 */
const CASE_TIMEOUT_MS = 60000;

const SRC_PATH = new URL("../../src/plugins/discovery.ts", import.meta.url);

describe("makeJsenvApi pumpJobs 预算(P0 回归守卫)", () => {
  const api = makeJsenvApi();
  const opened: string[] = [];

  async function open(name: string, initCode?: string): Promise<string> {
    opened.push(name);
    await api.create(name, initCode);
    return name;
  }

  afterAll(async () => {
    for (const n of opened) {
      try { await api.destroy(n); } catch { /* ignore */ }
    }
  });

  it(
    "pending job 很快 settle 时 execute 立即返回(不空转满预算),且异步结果没有丢",
    async () => {
      // 只靠微任务结算(子环境里没有 setTimeout),模拟洛雪音源「异步注册」那一类脚本。
      const name = await open("pump-fast-settle");
      const code =
        "(async function(){ await Promise.resolve(); await Promise.resolve(); " +
        "globalThis.__pumpFast = 'SETTLED'; return 42; })()";

      const t0 = Date.now();
      const r: any = await api.execute(name, code);
      const elapsed = Date.now() - t0;

      // ① 结果契约不能被「提前退出」破坏:execute 必须正常 resolve 且拿到已结算的值。
      expect(r.ok).toBe(true);
      expect(r.result).toBeDefined();
      expect(r.result).not.toMatchObject({ type: "pending" });
      // ② 墙钟:修复后为毫秒级;缺陷态会空转满预算(>= 8s),远超阈值。
      expect(elapsed).toBeLessThan(FAST_SETTLE_MAX_MS);
      // ③ 异步副作用必须真的跑完了:提前退出不能把结果吞掉。
      const probe: any = await api.execute(name, "globalThis.__pumpFast === 'SETTLED'");
      expect(probe.result).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "pending job 永不 settle 时 execute 也必须在预算硬上限内返回(不能跑满 20s/25s)",
    async () => {
      const name = await open("pump-never-settle");
      // 注意:必须是「先挂一个真实 job、再 await 一个永不结算的 promise」的写法。
      // 直接用 `await new Promise(function(){})` 时 hasPendingJob() 为 false,
      // execute 会整段跳过 pumpJobs,测不出预算(缺陷态也会「假通过」)。
      const code =
        "(async function(){ await Promise.resolve().then(function(){ " +
        "return new Promise(function(){}); }); return 1; })()";

      const t0 = Date.now();
      const r: any = await api.execute(name, code);
      const elapsed = Date.now() - t0;

      expect(r.ok).toBe(true);
      // 修复后 = JSENV_PUMP_BUDGET_MS(8s)量级;缺陷态(25s)必然超阈值。
      expect(elapsed).toBeLessThan(HARD_BUDGET_MAX_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "预算常量必须小于宿主主线程调用预算 INVOKE_TIMEOUT_MS(20s)",
    async () => {
      // 不跑时间,只锁常量关系:任何把预算调回 >= 20s 的改动都必须在这里被拦下。
      const src = await fs.promises.readFile(SRC_PATH, "utf8");
      const budgets = [...src.matchAll(/JSENV_(?:NET|PUMP)_BUDGET_MS\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
      expect(budgets.length).toBe(2);
      for (const b of budgets) expect(b).toBeLessThan(20000);
      // 中断 deadline 必须大于 pump 预算,否则 pump 还没到预算就被 interrupt 干掉。
      const deadline = [...src.matchAll(/JSENV_DEADLINE_MS\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
      expect(deadline.length).toBe(1);
      expect(deadline[0]).toBeGreaterThan(Math.max(...budgets));
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "promise handle 的 dispose 必须容错(dump 会消费 handle,裸 dispose 会抛 QuickJSUseAfterFree)",
    async () => {
      const src = await fs.promises.readFile(SRC_PATH, "utf8");
      // 静态守卫:execute 末尾不得再出现裸的 `vh.dispose();`
      expect(/\n\s*vh\.dispose\(\);\s*\n/.test(src)).toBe(false);
      expect(/try\s*\{\s*vh\.dispose\(\);\s*\}\s*catch/.test(src)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 双向变异验证(手动执行,已验证):
//  A) 注释掉 pumpJobs 里的 `if (until && until()) return;`
//     -> 第 1 条失败:expected < 3000,实际 ~8000ms(空转满预算)
//  B) 把 JSENV_PUMP_BUDGET_MS 改回 25000
//     -> 第 2 条失败:expected < 12000,实际 ~25000ms
// 还原后四条全绿。
// ---------------------------------------------------------------------------
