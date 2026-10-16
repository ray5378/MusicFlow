// 内置标签插件 tag-provider 单测：用**真实抓取的 QQ 响应样本**锁定字段抽取口径。
//
// 重点回归（产品定调 2026-10-17）：
//   1. 风格 genre 必须取自**与 track_info 同级的 info 块** —— `info.genre.content[].value`
//      是可读名（实测「告白气球」= "R&B"、「晴天」= "Pop"）；`track_info.genre` 只是
//      数字码（实测「告白气球」= 33，与分类 id 42 对不上），**一律不采用**。
//      旧实现只读 track_info，故恒判「QQ 无风格名」而省略 genre（已在生产实测发现）。
//   2. 碟号 disc **不再返回**：成品音频不留 DISCNUMBER/DISCTOTAL（见 tagWriter【碟号纪律】）。
//   3. 时长闸门按**秒**比对（旧实现误当毫秒，恒失败 → 元数据补全恒空）。
import { describe, expect, it } from "vitest";
import { tagProviderPlugin } from "../../src/services/plugin/tagProvider.js";
import type { LyricSongInput } from "../../src/plugins/types.js";

/** 真实抓取的 QQ smartbox 搜索响应（素材：告白气球 / 周杰伦；裁剪为单条命中）。 */
const SMARTSBOX = {
  code: 0,
  data: {
    song: {
      count: 4,
      itemlist: [
        { docid: "107192078", id: "107192078", mid: "003OUlho2HcRHC", name: "告白气球", singer: "周杰伦" },
      ],
    },
  },
};

/** 真实抓取的 QQ 歌曲详情响应（素材：告白气球；裁剪保留 info.genre 与 track_info 关键字段）。
 *  注意 `info` 与 `track_info` 是**同级兄弟节点**：风格可读名只在 info 块里。 */
function detailJson(opts: { withInfoGenre: boolean }): unknown {
  return {
    code: 0,
    req: {
      code: 0,
      data: {
        info: opts.withInfoGenre
          ? { genre: { title: "歌曲流派", content: [{ id: 42, value: "R&B" }] } }
          : {},
        track_info: {
          mid: "003OUlho2HcRHC",
          name: "告白气球",
          singer: [{ id: 4558, mid: "0025NhlN2yWrP4", name: "周杰伦" }],
          album: {
            id: 8220,
            mid: "000MkMni19ClKG",
            name: "周杰伦的床边故事",
            time_public: "2016-06-24",
          },
          interval: 215,
          // 数字码：绝不可当作风格名使用
          genre: 33,
          index_cd: 0,
          index_album: 8,
          time_public: "2016-06-24",
        },
      },
    },
  };
}

const LYRIC_JSON = { code: 0, lyric: "[ti:告白气球]\n[ar:周杰伦]\n[00:00.00]告白气球" };

/** 假 host：按 URL 分派 canned JSON（与插件实际调用的三个端点一一对应）。 */
function makeHost(opts: { withInfoGenre?: boolean } = {}): any {
  return {
    http: async (url: string) => ({
      ok: true,
      text: async () => {
        if (url.includes("smartbox_new.fcg")) return JSON.stringify(SMARTSBOX);
        if (url.includes("musicu.fcg")) {
          return JSON.stringify(detailJson({ withInfoGenre: opts.withInfoGenre !== false }));
        }
        if (url.includes("lyric")) return JSON.stringify(LYRIC_JSON);
        return JSON.stringify({});
      },
    }),
  };
}

const SONG: LyricSongInput = { title: "告白气球", artist: "周杰伦", duration: 215 };

describe("tag-provider — searchMetadata", () => {
  it("风格取自 info.genre.content(可读名),轨号/年份/专辑/时长齐全,且不返回碟号", async () => {
    const meta = await tagProviderPlugin.searchMetadata(makeHost(), SONG);
    expect(meta?.genre).toBe("R&B");
    expect(meta?.track).toBe(8);
    expect(meta?.year).toBe(2016);
    expect(meta?.album).toBe("周杰伦的床边故事");
    expect(meta?.artist).toBe("周杰伦");
    expect(meta?.duration).toBe(215);
    // 碟号纪律：核心不再消费，插件也不再返回
    expect(meta?.disc).toBeUndefined();
    expect(meta?.discTotal).toBeUndefined();
  });

  it("info 块无 genre 时不得回落 track_info.genre(数字码),genre 应为空", async () => {
    const meta = await tagProviderPlugin.searchMetadata(makeHost({ withInfoGenre: false }), SONG);
    expect(meta).not.toBeNull();
    expect(meta?.genre).toBeUndefined();
  });

  it("时长偏差超出 ±5s(版本不同)→ 不匹配,返回 null", async () => {
    const meta = await tagProviderPlugin.searchMetadata(makeHost(), {
      title: "告白气球",
      artist: "周杰伦",
      duration: 100,
    });
    expect(meta).toBeNull();
  });
});

describe("tag-provider — searchCover / searchLyrics", () => {
  it("封面由专辑 mid 拼 QQ CDN", async () => {
    const r = await tagProviderPlugin.searchCover(makeHost(), SONG);
    expect(r?.url).toContain("000MkMni19ClKG");
  });

  it("歌词返回 LRC 文本", async () => {
    const r = await tagProviderPlugin.searchLyrics(makeHost(), SONG);
    expect(r?.lrc).toContain("[ti:告白气球]");
  });
});
