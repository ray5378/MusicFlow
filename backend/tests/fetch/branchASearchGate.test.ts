// 分支 A(插件自带 search + streamUrl)的身份闸门：2026-11-21 补。
// 背景：此前 search 返回什么就逐条转候选，同歌手、时长相近的另一首能一路下到落盘。
import { describe, expect, it } from "vitest";
import { collectCandidates } from "../../src/services/fetch/candidates.js";

function sourceReturning(songs: any[]): any {
  return {
    pluginId: "fake-search-source",
    capabilities: ["stream", "search"],
    config: {},
    provider: {
      async search() {
        return { songs };
      },
      streamUrl(_cfg: any, s: any) {
        return "https://cdn.example.com/" + s.id + ".mp3";
      },
    },
  };
}

const TARGET: any = { id: "s1", title: "狂信者", artist: "黄立行", durationSec: 221 };

describe("分支 A 搜索结果身份闸门", () => {
  it("同歌手、时长相近但歌名不同 → 不进候选", async () => {
    const out = await collectCandidates({
      target: TARGET,
      sources: [sourceReturning([
        { id: "1", source: "qq", name: "分开旅行", artist: "刘若英、黄立行", duration: 229, cover: "" },
      ])],
    });
    expect(out).toHaveLength(0);
  });

  it("歌名对得上(含括号/版本后缀互含) → 保留", async () => {
    const out = await collectCandidates({
      target: TARGET,
      sources: [sourceReturning([
        { id: "1", source: "qq", name: "狂信者", artist: "黄立行", duration: 221, cover: "" },
        { id: "2", source: "qq", name: "狂信者 (Live)", artist: "黄立行", duration: 221, cover: "" },
      ])],
    });
    expect(out.length).toBe(2);
  });

  it("歌手为空时只看歌名", async () => {
    const out = await collectCandidates({
      target: { id: "s2", title: "狂信者", durationSec: 221 } as any,
      sources: [sourceReturning([
        { id: "1", source: "qq", name: "狂信者", artist: "别人", duration: 221, cover: "" },
      ])],
    });
    expect(out).toHaveLength(1);
  });
});
