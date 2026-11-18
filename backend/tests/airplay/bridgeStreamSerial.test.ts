// 桥时间线复位：旧推流循环必须能被中止（2026-11-19 立项）
//
// 现场（240 实机 2026-11-18 15:54）：
//   `timeline-reset(poisoned)` → `newgen-skip 1626ms` → 随后 `pacing rebase(lag)`
//   每秒 +600ms 持续两分钟，`idx` 在 107 / 25788 / 240 / 26075 之间交错 ⇒ **两套
//   streamBridge 循环同时在向同一 RAOP socket 发包**，设备收到两套时间线 ⇒ 欠载静默
//   （起播全程不出声，手动 seek 重建流才恢复）。
//
// 成因：`RaopPlayer.waitUntilUs` 只等 setTimeout、不检查中止标志。`resetTimeline` 的
//   `flush()` 已把 `streaming` 置 false、`streamAborted` 置 true（旧循环 shouldStop 成立），
//   但循环正卡在 `waitUntilUs(sendAt)` 里，最长要等满一个 sendAt 周期（≈2s）才回到主条件
//   —— 这 2 秒里它继续按作废的 startTs 打包发包，与新循环并行。
//
// 本文件锁两件事：
//   ① waitUntilUs 必须每轮检查 streaming/destroying，且轮询粒度 ≤10ms；
//   ② maybeBeginStream **不得**引入 await 等待旧 streamPromise —— 那条 promise 在整首歌
//      期间都不 resolve，await 等于每次换歌硬等超时（草案实测把 6 次 boundary 压成 1 次，
//      bridgePhase5.qa2 直接红），且会破坏起播路径的同步语义。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const raopSrc = fs.readFileSync(path.join(DIR, "raop.ts"), "utf8");
const bsSrc = fs.readFileSync(path.join(DIR, "bridgeSession.ts"), "utf8");

describe("P1: RaopPlayer.waitUntilUs 必须可中止", () => {
  const seg = (() => {
    const i = raopSrc.indexOf("private async waitUntilUs(");
    expect(i, "找不到 waitUntilUs").toBeGreaterThanOrEqual(0);
    const j = raopSrc.indexOf("\n  }\n", i);
    return raopSrc.slice(i, j);
  })();

  it("循环里检查 streaming/destroying（否则 flush 后仍等满 sendAt）", () => {
    expect(seg).toContain("!this.streaming || this.destroying");
  });

  it("中止检查在 setTimeout 之前（每轮轮询都能感知）", () => {
    const checkAt = seg.indexOf("!this.streaming || this.destroying");
    const timerAt = seg.indexOf("setTimeout(");
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(timerAt).toBeGreaterThan(checkAt);
  });

  it("轮询粒度 ≤10ms（复位后最多再发 1 帧旧包）", () => {
    const m = seg.match(/Math\.min\(delayUs \/ 1000, (\d+)\)/);
    expect(m, "找不到轮询粒度").not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(10);
  });
});

describe("P2 已撤回：起播路径不得为旧流引入 await", () => {
  it("maybeBeginStream 里没有 await 旧 streamPromise 的写法", () => {
    // 只允许 streamPromise 被赋值，不允许对它 await / Promise.race
    expect(bsSrc).not.toMatch(/await\s+Promise\.race\(\[\s*this\.streamPromise/);
    expect(bsSrc).not.toMatch(/await\s+this\.streamPromise/);
  });

  it("startStatsTick 之前不出现为等旧流而加的 sleep", () => {
    const i = bsSrc.indexOf("private async maybeBeginStream");
    expect(i).toBeGreaterThanOrEqual(0);
    const j = bsSrc.indexOf("startStatsTick", i);
    const seg = bsSrc.slice(i, j > i ? j : i + 4000);
    expect(seg).not.toMatch(/await new Promise\(\(r\) => setTimeout\(r, \d+\)\)[\s\S]{0,80}streamPromise/);
  });
});
