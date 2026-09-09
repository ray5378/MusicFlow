// 守卫测试：Web 前端播放链路「失败自动跳下一曲」契约（2026-09-09 拍板）。
//
// 前端没有单测框架（只有 playwright e2e），而 player.ts 的失败跳曲是纯前端
// 行为，后端测试也覆盖不到。这里用**源码契约扫描**钉死决策，防止回归：
//   1. onloaderror / onplayerror 必须接到错误处理器（丢了 = 坏歌卡住不跳）；
//   2. 错误处理器必须调用 localNext()（改成静默 return = 卡住）；
//   3. 不得重新引入死歌名单 / 失败连击停播阈值（长段坏源时中途停住，
//      且会永久误杀「服务端换源已救回」的歌）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../../../frontend/src/stores/player.ts", import.meta.url)),
  "utf8",
);

/** 截取 `function name(` 起、到下一个顶格 `  }` 为止的函数体。 */
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const end = src.indexOf("\n  }", start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

describe("Web 前端播放失败契约", () => {
  it("onloaderror / onplayerror 都接到错误处理器", () => {
    for (const evt of ["onloaderror", "onplayerror"]) {
      const line = src.split("\n").find((l) => l.includes(`${evt}:`));
      expect(line, `player.ts 缺少 ${evt} 处理`).toBeTruthy();
      expect(line, `${evt} 必须接到 localHandlePlaybackError`).toContain("localHandlePlaybackError");
    }
  });

  it("错误处理器必须跳下一曲,且不得停播", () => {
    const body = fnBody("localHandlePlaybackError");
    expect(body, "找不到 localHandlePlaybackError").not.toBe("");
    expect(body, "播放失败必须自动跳下一曲").toContain("localNext()");
    expect(body, "无停播阈值:失败不得把播放态置为停止").not.toContain("localIsPlaying.value = false");
  });

  it("不得重新引入死歌名单或失败连击停播阈值", () => {
    for (const banned of ["deadSongs", "localFailStreak", "LOCAL_MAX_FAIL_STREAK"]) {
      expect(src, `契约回归:${banned} 已整体移除`).not.toContain(banned);
    }
  });
});
