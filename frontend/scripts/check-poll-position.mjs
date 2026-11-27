#!/usr/bin/env node
/**
 * WEB 投屏轮询回写「单向防抖」守卫 —— 防止 0.1s 上报精度造成的进度条轻微后跳被改回去。
 *
 * 双重校验（与客户端 policy 单测 / HA 卡片守卫同款语义）：
 *   1. 行为：用 esbuild 把 src/utils/pollPosition.ts 转译后 import 真源码，逐条断言
 *      （小回退吞掉 / 前进采纳 / 大回退采纳 / 换歌采纳 / 容差可调）——不复刻逻辑。
 *   2. 接线：player.ts 的 castPoll 回写必须经过 adoptPolledPosition，不能直写外推值。
 *
 * 用法：node scripts/check-poll-position.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const utilsPath = join(root, "src", "utils", "pollPosition.ts");
const playerPath = join(root, "src", "stores", "player.ts");

const results = [];
const check = (name, pass, why) => results.push({ name, pass, why });

// ---- 1. 行为断言：转译真源码 ----
const { code } = await esbuild.transform(readFileSync(utilsPath, "utf8"), {
  loader: "ts", format: "esm", target: "node22",
});
const tmp = mkdtempSync(join(tmpdir(), "pollpos-"));
const modPath = join(tmp, "pollPosition.mjs");
try {
  writeFileSync(modPath, code, "utf8");
  const { adoptPolledPosition: adopt } = await import(pathToFileURL(modPath).href);
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  check("同曲小回退(≤0.5s) → 保留本地值，吞掉 0.1s 精度抖动",
    near(adopt(10.0, 10.3), 10.3) && near(adopt(10.2, 10.5), 10.5) && near(adopt(10.0, 10.5), 10.5),
    "0.1s 精度 + 网络往返让外推值比本地 tick 小一点，写回即进度条后跳");
  check("前进(projected ≥ local) → 采纳服务端值，不影响真前进",
    near(adopt(10.5, 10.0), 10.5) && near(adopt(10.0, 10.0), 10.0),
    "单向：只挡往回小跳，前进一律采纳");
  check("大回退(>0.5s) → 采纳服务端值，真 seek 不被吞",
    near(adopt(9.0, 10.0), 9.0) && near(adopt(0.0, 10.0), 0.0),
    "真 seek 不能被防抖吞掉");
  check("非同一首歌 → 一律采纳，换歌起点不被吞",
    near(adopt(0.0, 0.3, false), 0.0) && near(adopt(2.0, 200.0, false), 2.0),
    "换歌新曲起点原样采纳，切歌极快时旧歌进度尚<0.5s 也不误吞");
  check("容差可调",
    near(adopt(10.0, 10.4, true, 0.3), 10.0),
    "自定义容差按入参判定");
  check("刚超出容差(0.6s) → 采纳，防抖不是无界吞并",
    near(adopt(10.0, 10.6), 10.0),
    "回退超过 0.5s 必须纠正，否则本地时钟会持续领先");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- 2. 接线断言：player.ts castPoll 回写经过防抖 ----
const player = readFileSync(playerPath, "utf8");
check("player.ts 已 import adoptPolledPosition",
  /import\s*\{[^}]*adoptPolledPosition[^}]*\}\s*from\s*["']@\/utils\/pollPosition["']/.test(player),
  "防抖函数必须被 castPoll 引用");
check("castPoll 回写 currentTime 经过 adoptPolledPosition（不是直写外推值）",
  /st\.currentTime\s*=\s*adoptPolledPosition\(projected,\s*st\.currentTime/.test(player),
  "直写 projectPeerPosition 结果 = 0.1s 精度抖动会重新写回进度条");
check("同曲判据存在（songId 比对）",
  /incomingSongId\s*===\s*localSongId/.test(player) && /sameSong/.test(player),
  "换歌那一拍必须原样采纳新曲起点");

// ---- 输出 ----
let failed = 0;
for (const r of results) {
  if (r.pass) console.log(`PASS  ${r.name}`);
  else { console.log(`FAIL  ${r.name}\n      原因：${r.why}`); failed++; }
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
