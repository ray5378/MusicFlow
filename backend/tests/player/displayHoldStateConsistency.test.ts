import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

/**
 * 可听显示延迟(hold)必须「进度与状态同源」。
 *
 * 2026-11-27 240 实测:曲末交接窗口泵已换代,poll 出来是 IDLE/BUFFERING,而 hold
 * 正把进度按住旧曲(旧曲 tail 还在响)。只覆盖 position/duration 而不覆盖 state
 * ⇒ 客户端拿到「暂停 + 旧曲进度」:显示暂停、进度因非 playing 停止外推而冻结,
 * hold 结束后一次性跳到真实位置(《淘汰》4:16 冻住 → 约 7 秒后 4:22)。
 *
 * 这条守卫钉住「凡用 hold.position 覆盖进度的地方,同一处必须把 state 也改成
 * PLAYING」,防止将来新增状态出口时又漏掉。
 */
const FILES = [
  "src/services/ws/index.ts",
  "src/routes/api/peers.ts",
  "src/routes/api/dlna.ts",
];

describe("hold 覆盖进度时必须同步 state=PLAYING", () => {
  it.each(FILES)("%s 每个 hold.position 覆盖点都带 PLAYING", (rel) => {
    const src = readFileSync(resolve(root, rel), "utf8");
    const hits: number[] = [];
    let from = 0;
    for (;;) {
      const i = src.indexOf("displayHoldState", from);
      if (i < 0) break;
      hits.push(i);
      from = i + 1;
    }
    expect(hits.length).toBeGreaterThan(0);

    const offenders: number[] = [];
    for (const i of hits) {
      // 窗口按「读 hold → 覆盖字段」的实际跨度取:最长的 sendspin 出口(state 三元表达式
      // 在前面、position 在后面)约 700 字符,留 900 余量。
      const win = src.slice(Math.max(0, i - 900), i + 900);
      if (!win.includes("hold.position")) continue; // 只改 media 的出口不涉及进度
      if (!win.includes("PLAYING")) offenders.push(src.slice(0, i).split("\n").length);
    }

    expect(
      offenders,
      `${rel} 第 ${offenders.join(",")} 行附近覆盖了进度却没把 state 改成 PLAYING`,
    ).toEqual([]);
  });
});
