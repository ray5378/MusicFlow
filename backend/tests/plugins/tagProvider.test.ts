// 内置标签插件 tag-provider 单测：用**真实抓取的 QQ 响应样本**锁定字段抽取口径。
//
// 重点回归（产品定调 2026-10-17）：
//   1. 风格 genre 必须取自**与 track_info 同级的 info 块** —— `info.genre.content[].value`
//      是可读名（实测「告白气球」= "R&B"、「晴天」= "Pop"）；`track_info.genre` 只是
//      数字码（实测「告白气球」= 33，与分类 id 42 对不上），**一律不采用**。
//      旧实现只读 track_info，故恒判「QQ 无风格名」而省略 genre（已在生产实测发现）。
//   2. 碟号 disc **不再返回**：成品音频不留 DISCNUMBER/DISCTOTAL（见 tagWriter【碟号纪律】）。
//   3. 时长闸门按**秒**比对（旧实现误当毫秒，恒失败 → 元数据补全恒空）。
//   4. **换真搜索接口**（2026-10-17 命中率修复）：候选来自 QQ **真搜索**接口的
//      `data.song.list[]`，归一化字段 `mid/title/singer[]/interval`（秒）；搜索阶段先跑
//      时长预筛，不通过则**不调用详情接口**；`Unknown Artist` 等 scanner 占位当空歌手。
//   5. **同曲多能力往返去重**（2026-10-17 提速·修正 6）：三个能力共享搜索/详情 memo，
//      同一首歌的 QQ 往返 6 → 3；且「只缓存成功响应」——瞬时失败不会被固化成「无候选」。
//   6. **搜索端点固定为 `search_for_qq_cp`**（2026-10-17 端点被挡修复）：原 `client_search_cp`
//      在 240 生产实测**恒 HTTP 500、响应体 0 字节**（代理/直连/Referer/Cookie 四种变体全 500），
//      使 QQ 侧恒 0 候选、「未获取到」占比虚高；同家族 `search_for_qq_cp` 200 且字段同构。
//      本用例锁定端点，防止回退。
//   7. **标题变体闸门**（同上）：DB 标题带「主标题 - 歌手」后缀（scanner 落库形态，全库 11%）
//      时，用「去尾部 ` - xxx`」的变体参与**精确相等**判定（非模糊匹配）。
//   8. **简繁字形归一**（同上）：匹配比较侧统一折算到简体，避免「平台繁体登记 vs DB 简体」
//      造成的恒不匹配；写入侧字形不受影响（仍由 tagWriter 的 applyTagsVariant 决定）。
import { beforeEach, describe, expect, it } from "vitest";
import { __resetTagProviderMemo, tagProviderPlugin } from "../../src/services/plugin/tagProvider.js";
import type { LyricSongInput } from "../../src/plugins/types.js";

// QQ 侧默认限流为「1.2s + 300~800ms 抖动」；测试置 0，避免 14 个用例被逐次拖延
// （限流本身单独用一个用例断言，见文末「QQ 侧请求限流」）。
process.env.MF_QQ_MIN_GAP_MS = "0";

// 【修正 6】插件内新增「同曲多能力往返去重」memo（模块级全局缓存，TTL 180s）。不清理会让
// 后一个用例读到前一个用例的 canned 响应（例如 withInfoGenre:false 的用例会命中上一条
// 缓存而误判 genre 存在）——故每个用例前必须清空。
beforeEach(() => {
  __resetTagProviderMemo();
});

/** 真实抓取的 QQ 搜索响应（素材：告白气球 / 周杰伦；裁剪为两条候选）。
 *  `new_json=1` 时 `singer` 是对象数组（取 `.name`），`interval` 为平台声明时长（秒）。
 *  端点现为 `search_for_qq_cp`（`client_search_cp` 生产实测恒 500，见文件头第 6 条）。 */
const SEARCH = {
  code: 0,
  data: {
    song: {
      list: [
        {
          mid: "003OUlho2HcRHC",
          title: "告白气球",
          singer: [{ mid: "0025NhlN2yWrP4", name: "周杰伦" }],
          album: { mid: "000MkMni19ClKG", name: "周杰伦的床边故事" },
          interval: 215,
        },
        {
          mid: "003other000001",
          title: "告白气球",
          singer: [{ mid: "000other00001", name: "群星" }],
          album: { mid: "000otheralbum1", name: "大合辑" },
          interval: 180,
        },
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

/** 繁体字形候选样本（素材：2026-10-17 生产实测「时间扭曲之路 / 純白P」，DB 为简体、平台为繁体）。
 *  用于验证「简繁字形归一」闸门：不归一则 `純白P`≠`纯白P`、`時間扭曲之路`≠`时间扭曲之路` → 恒不匹配。 */
const SEARCH_TRAD = {
  code: 0,
  data: {
    song: {
      list: [
        {
          mid: "003trad0000001",
          title: "時間扭曲之路",
          singer: [{ mid: "002trad000001", name: "純白P" }],
          album: { mid: "000tradalbum1", name: "專輯" },
          interval: 149,
        },
      ],
    },
  },
};

/** 与 SEARCH_TRAD 配套的详情响应（繁体登记），用于断言「匹配成功」而非「写入字形被改写」。 */
const DETAIL_TRAD = {
  code: 0,
  req: {
    code: 0,
    data: {
      info: { genre: { title: "歌曲流派", content: [{ id: 9, value: "电子" }] } },
      track_info: {
        mid: "003trad0000001",
        name: "時間扭曲之路",
        singer: [{ id: 1, mid: "002trad000001", name: "純白P" }],
        album: { id: 2, mid: "000tradalbum1", name: "專輯", time_public: "2019-05-01" },
        interval: 149,
        index_album: 1,
        time_public: "2019-05-01",
      },
    },
  },
};

const LYRIC_JSON = { code: 0, lyric: "[ti:告白气球]\n[ar:周杰伦]\n[00:00.00]告白气球" };

// ---------- 网易云音乐（QQ 拿不到时的兜底链路）真实响应样本 ----------
// 素材：2026-10-17 在 240 生产容器内经系统代理真机探测（POST /api/search/get）。
// 关键事实：`duration` 是**毫秒**（215666 → 216s）；搜索响应的 `album` **只有 picId、
// 没有 picUrl**，故封面必须二次调 /api/song/detail/ 取 album.picUrl。
const NS_SEARCH = {
  code: 200,
  result: {
    songs: [
      {
        id: 2716020167,
        name: "告白气球",
        artists: [{ id: 6452, name: "周杰伦" }],
        album: {
          id: 275301855,
          name: "周杰伦的床边故事",
          picId: 109951174108738240,
          publishTime: 1451606400000, // 2016-01-01T00:00:00Z
        },
        duration: 215666,
      },
    ],
  },
};

/** 网易云歌曲详情响应：封面直链在 songs[0].album.picUrl（搜索响应里拿不到）。 */
const NS_DETAIL = {
  code: 200,
  songs: [
    {
      id: 2716020167,
      name: "告白气球",
      artists: [{ name: "周杰伦" }],
      album: {
        id: 275301855,
        name: "周杰伦的床边故事",
        picUrl: "https://p1.music.126.net/abc==/109951174108738240.jpg",
      },
      duration: 215666,
    },
  ],
};

/** 网易云歌词响应：歌词在 lrc.lyric（与 QQ 的 `{lyric}` 不同）。 */
const NS_LYRIC = { code: 200, lrc: { lyric: "[00:00.000]告白气球\n[00:01.000]塞纳河畔" } };

/** QQ 搜索“零结果”（data.song.list 为空）→ 触发网易云兜底。 */
const SEARCH_EMPTY = { code: 0, data: { song: { list: [] } } };

/** 假 host：按 URL 分派 canned JSON（与插件实际调用的各端点一一对应），并记录全部请求 URL。
 *  `qqEmpty`：让 QQ 搜索回空列表，用于验证「QQ 拿不到 → 网易云兜底」的两段式；
 *  `detail`：覆盖 musicu 详情响应（默认即「告白气球」，供繁体样本等断言匹配结果用）。 */
function makeHost(opts: { withInfoGenre?: boolean; search?: unknown; qqEmpty?: boolean; detail?: unknown } = {}): any {
  const calls: string[] = [];
  const times: number[] = [];
  return {
    calls,
    times,
    http: async (url: string) => {
      calls.push(url);
      times.push(Date.now());
      return {
        ok: true,
        text: async () => {
          // 网易云端点必须先于 QQ 的 `lyric` 泛匹配判定（`api/song/lyric` 也含 "lyric"）。
          if (url.includes("music.163.com/api/search/get")) return JSON.stringify(NS_SEARCH);
          if (url.includes("music.163.com/api/song/detail")) return JSON.stringify(NS_DETAIL);
          if (url.includes("music.163.com/api/song/lyric")) return JSON.stringify(NS_LYRIC);
          if (url.includes("search_for_qq_cp")) {
            return JSON.stringify(opts.qqEmpty ? SEARCH_EMPTY : (opts.search ?? SEARCH));
          }
          if (url.includes("musicu.fcg")) {
            return JSON.stringify(opts.detail ?? detailJson({ withInfoGenre: opts.withInfoGenre !== false }));
          }
          if (url.includes("lyric")) return JSON.stringify(LYRIC_JSON);
          return JSON.stringify({});
        },
      };
    },
  };
}

/** 旧结构搜索响应：`singer` 是字符串（非 new_json）—— 归一化须兼容。 */
const SEARCH_LEGACY = {
  code: 0,
  data: {
    song: {
      list: [{ mid: "003OUlho2HcRHC", songname: "告白气球", singername: "周杰伦", interval: 215 }],
    },
  },
};

const detailCalls = (host: any): number => host.calls.filter((u: string) => u.includes("musicu.fcg")).length;

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

  it("时长预筛在**搜索阶段**生效：候选时长不合格时**不调用详情接口**", async () => {
    const host = makeHost();
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "告白气球",
      artist: "周杰伦",
      duration: 100, // 与候选 215 差 115s → 预筛拦下
    });
    expect(meta).toBeNull();
    // 关键断言：一次详情请求都没发（省一次网络往返，且旧实现只有详情后才判）
    expect(detailCalls(host)).toBe(0);
    // 搜索接口确被调用，且用真搜索端点（search_for_qq_cp；client_search_cp 生产恒 500）
    expect(host.calls[0]).toContain("search_for_qq_cp");
  });

  it("artist 为 scanner 占位值(Unknown Artist)→ 视同空歌手：关键词只用 title,仍能命中", async () => {
    const host = makeHost();
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "告白气球",
      artist: "Unknown Artist",
      duration: 215,
    });
    // 占位值绝不能拼进搜索关键词（否则恒 0 结果）
    expect(host.calls[0]).not.toContain("Unknown");
    expect(host.calls[0]).not.toContain("Artist");
    // 只用 title 也能命中（标题闸门 + 时长闸门通过 → 详情成功）
    expect(meta?.title).toBe("告白气球");
    expect(meta?.artist).toBe("周杰伦");
  });

  it("兼容旧搜索结构(singer 为字符串, songname/singername)", async () => {
    const host = makeHost({ search: SEARCH_LEGACY });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.artist).toBe("周杰伦");
    expect(meta?.album).toBe("周杰伦的床边故事");
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

// ---------- 两平台：QQ 默认优先，网易云仅在 QQ 拿不到时兜底（产品定调 2026-10-17） ----------
describe("tag-provider — 网易云音乐兜底链路", () => {
  const nsCalled = (host: any): boolean => host.calls.some((u: string) => u.includes("music.163.com"));

  it("QQ 有命中时**不调用**网易云（QQ 是默认来源）", async () => {
    const host = makeHost();
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    // QQ 专有字段（网易云无名可读风格、也不给轨号）
    expect(meta?.genre).toBe("R&B");
    expect(meta?.track).toBe(8);
    expect(meta?.platform).not.toBe("netease");
    expect(nsCalled(host)).toBe(false);
  });

  it("QQ 零候选 → 网易云兜底命中元数据，且**毫秒时长被换算成秒**", async () => {
    const host = makeHost({ qqEmpty: true });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG); // 本地 215s，网易 215666ms→216s，差 1s 通过
    expect(meta?.platform).toBe("netease");
    expect(meta?.title).toBe("告白气球");
    expect(meta?.artist).toBe("周杰伦");
    expect(meta?.album).toBe("周杰伦的床边故事");
    expect(meta?.duration).toBe(216); // 关键：毫秒 215666 → 秒 216
    expect(meta?.year).toBe(2016); // publishTime(ms) → 年份
    expect(meta?.genre).toBeUndefined(); // 网易云无可读风格名 → 绝不臆造
    // 先 QQ 搜索后网易云搜索，顺序即「默认优先 + 兜底」
    expect(host.calls[0]).toContain("search_for_qq_cp");
    expect(host.calls[1]).toContain("music.163.com/api/search/get");
  });

  it("QQ 零候选 → 网易云兜底取封面：必须**二次调详情接口**拿 album.picUrl", async () => {
    const host = makeHost({ qqEmpty: true });
    const r = await tagProviderPlugin.searchCover(host, SONG);
    expect(r?.url).toBe(NS_DETAIL.songs[0].album.picUrl);
    // 搜索响应只有 picId，封面直链只能来自详情接口
    expect(host.calls.some((u: string) => u.includes("api/song/detail"))).toBe(true);
  });

  it("QQ 零候选 → 网易云兜底取歌词：取自 lrc.lyric", async () => {
    const host = makeHost({ qqEmpty: true });
    const r = await tagProviderPlugin.searchLyrics(host, SONG);
    expect(r?.lrc).toContain("[00:00.000]告白气球");
    expect(r?.lrc).toContain("塞纳河畔");
  });

  it("网易云候选时长(毫秒换算后)超出 ±5s → 不命中，且不调详情接口", async () => {
    const host = makeHost({ qqEmpty: true });
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "告白气球",
      artist: "周杰伦",
      duration: 100, // 与网易 216s 差 116s → 预筛拦下
    });
    expect(meta).toBeNull();
    expect(host.calls.some((u: string) => u.includes("api/song/detail"))).toBe(false);
  });

  it("artist 为占位值(Unknown Artist)时，网易云关键词也只用 title（占位值不拼进关键词）", async () => {
    const host = makeHost({ qqEmpty: true });
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "告白气球",
      artist: "Unknown Artist",
      duration: 215,
    });
    const nsUrl = host.calls.find((u: string) => u.includes("music.163.com/api/search/get"))!;
    expect(nsUrl).not.toContain("Unknown");
    expect(nsUrl).not.toContain("Artist");
    expect(meta?.platform).toBe("netease");
  });
});

// ---------- 同曲多能力往返去重（2026-10-17 提速·修正 6）----------
describe("tag-provider — 同曲多能力往返去重", () => {
  it("同一首歌的三个能力共享搜索/详情往返：QQ 请求 6 → 3", async () => {
    const host = makeHost();
    // 核心对同一首歌是**分别**调用三个能力的（顺序即核心实际调用顺序）。
    await tagProviderPlugin.searchCover(host, SONG);
    await tagProviderPlugin.searchLyrics(host, SONG);
    await tagProviderPlugin.searchMetadata(host, SONG);
    const count = (frag: string) => host.calls.filter((u: string) => u.includes(frag)).length;
    // 三次搜索 → 一次；两次详情（封面 + 元数据各一次）→ 一次；歌词本就只有一次。
    expect(count("search_for_qq_cp")).toBe(1);
    expect(detailCalls(host)).toBe(1);
    expect(count("lyric/fcgi-bin")).toBe(1);
    expect(host.calls.length).toBe(3); // 去重前这里会是 6 次 QQ 往返
  });

  it("不同关键词不共享缓存：换歌手（关键词不同）仍各自真实请求", async () => {
    const host = makeHost();
    await tagProviderPlugin.searchMetadata(host, SONG); // 关键词「告白气球 周杰伦」
    await tagProviderPlugin.searchMetadata(host, { title: "告白气球", duration: 215 }); // 关键词「告白气球」
    expect(host.calls.filter((u: string) => u.includes("search_for_qq_cp")).length).toBe(2);
  });
});

// ---------- QQ 侧请求限流（防封 IP，2026-10-17 产品要求）----------
describe("tag-provider — QQ 侧请求限流", () => {
  it("相邻两次 QQ 请求间隔 ≥1.2s（+300~800ms 抖动），跨调用（全局队列）同样生效", async () => {
    const saved = process.env.MF_QQ_MIN_GAP_MS;
    delete process.env.MF_QQ_MIN_GAP_MS; // 恢复默认 1200ms
    try {
      const host = makeHost();
      await tagProviderPlugin.searchMetadata(host, SONG);
      // 第二次调用：**换关键词**（同一首歌但未提供歌手 → 关键词不同），跨调用仍须限速。
      // 【修正 6】不能用「同一首歌连调两次」来测跨调用限速：同曲往返已被 memo 去重，
      // 第二次调用不会产生任何新请求，断言会失真。
      await tagProviderPlugin.searchMetadata(host, { title: "告白气球", duration: 215 });
      const qqTimes = host.times.filter((_: number, i: number) => host.calls[i].includes("qq.com"));
      // 去重后两次核心调用共 3 次 QQ 请求（搜索① → 详情① → 搜索②；详情②与详情①同 mid 被去重）。
      // 其中「详情① → 搜索②」正是**跨调用**边界，仍须满足全局队列的最小间隔。
      expect(qqTimes.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < qqTimes.length; i++) {
        // 1200ms 最小间隔 + 抖动下限 300ms
        expect(qqTimes[i] - qqTimes[i - 1]).toBeGreaterThanOrEqual(1500);
      }
    } finally {
      process.env.MF_QQ_MIN_GAP_MS = saved ?? "0";
    }
  }, 60000);

  it("网易云链路不受 QQ 限流约束（QQ 拿不到后网易云紧随发起，不需再等 1.2s）", async () => {
    const saved = process.env.MF_QQ_MIN_GAP_MS;
    delete process.env.MF_QQ_MIN_GAP_MS;
    try {
      const host = makeHost({ qqEmpty: true });
      await tagProviderPlugin.searchMetadata(host, SONG);
      const qqIdx = host.calls.findIndex((u: string) => u.includes("search_for_qq_cp"));
      const nsIdx = host.calls.findIndex((u: string) => u.includes("music.163.com/api/search/get"));
      expect(qqIdx).toBe(0);
      expect(nsIdx).toBeGreaterThan(0);
      expect(host.times[nsIdx] - host.times[qqIdx]).toBeLessThan(1200);
    } finally {
      process.env.MF_QQ_MIN_GAP_MS = saved ?? "0";
    }
  }, 30000);
});

// ---------- 端点被挡 + 两处闸门误杀修复（2026-10-17，prod 实证）----------
describe("tag-provider — 端点被挡 / 闸门误杀修复", () => {
  it("QQ 搜索固定走 search_for_qq_cp（client_search_cp 生产实测恒 500、响应体 0 字节）", async () => {
    const host = makeHost();
    await tagProviderPlugin.searchMetadata(host, SONG);
    const searchUrl = host.calls.find((u: string) => u.includes("c.y.qq.com/soso/fcgi-bin"))!;
    expect(searchUrl).toContain("search_for_qq_cp");
    expect(searchUrl).not.toContain("client_search_cp");
  });

  it("DB 标题带「 - 歌手」后缀（scanner 落库形态，全库 11%）→ 标题变体闸门命中", async () => {
    const host = makeHost();
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "告白气球 - 周杰伦", // 实测「Fire Is Dead - SCARECROW」即此形态
      artist: "周杰伦",
      duration: 215,
    });
    expect(meta?.title).toBe("告白气球");
    expect(meta?.artist).toBe("周杰伦");
  });

  it("标题变体仍是**精确相等**语义：不做前缀/包含模糊匹配", async () => {
    const host = makeHost();
    // 去尾后得到「告白气球remix」，与候选「告白气球」不相等 → 不得命中（防止放宽判定造成错配）
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "告白气球remix - 周杰伦",
      artist: "周杰伦",
      duration: 215,
    });
    expect(meta).toBeNull();
  });

  it("简繁字形差异（DB 简体 / 平台繁体）→ 匹配侧归一到简体后命中；返回仍是平台原字形", async () => {
    const host = makeHost({ search: SEARCH_TRAD, detail: DETAIL_TRAD });
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "时间扭曲之路", // DB 简体
      artist: "纯白P", // DB 简体；平台登记为繁体「純白P」
      duration: 149,
    });
    // 能走到详情即证明匹配成功；返回的是平台登记字形（写入字形由核心 applyTagsVariant 决定，不在此改写）
    expect(meta?.title).toBe("時間扭曲之路");
    expect(meta?.artist).toBe("純白P");
    expect(meta?.genre).toBe("电子");
  });

  it("简繁归一不放宽判定：歌手确实不同 → 依旧不命中", async () => {
    const host = makeHost({ search: SEARCH_TRAD, detail: DETAIL_TRAD });
    const meta = await tagProviderPlugin.searchMetadata(host, {
      title: "时间扭曲之路",
      artist: "别的歌手",
      duration: 149,
    });
    expect(meta).toBeNull();
  });
});
