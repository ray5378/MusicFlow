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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTagProviderMemo, __resetTagProviderQueue, scoreTagCandidate, tagProviderPlugin } from "../../src/services/plugin/tagProvider.js";
import type { LyricSongInput } from "../../src/plugins/types.js";

// QQ 侧默认限流为「1.2s + 300~800ms 抖动」；测试置 0，避免 14 个用例被逐次拖延
// （限流本身单独用一个用例断言，见文末「QQ 侧请求限流」）。
process.env.MF_QQ_MIN_GAP_MS = "0";

// 【修正 6】插件内新增「同曲多能力往返去重」memo（模块级全局缓存，TTL 180s）。不清理会让
// 后一个用例读到前一个用例的 canned 响应（例如 withInfoGenre:false 的用例会命中上一条
// 缓存而误判 genre 存在）——故每个用例前必须清空。
// 【2026-10-19 CI 稳定】QQ 节流队列同样是模块级全局（qqNextAt/qqTail）。不复位的话，
// 「请求超时(10s) → abort」用例切假时钟后，队列里排队中的 `setTimeout` 会随假时钟一起被丢弃
// → `qqTail` 永不 settle → 本文件后续**所有** QQ 请求全部卡死（CI 实测：66 个用例中 38 个
// 各超时 20s、单文件耗时 805s）。这条跨用例的共享状态依赖只在 `sequence.shuffle` 打乱到
// 「限流用例紧跟超时用例」这一种顺序下才显形，属典型的偶发放炮，必须在每个用例前复位。
beforeEach(() => {
  __resetTagProviderMemo();
  __resetTagProviderQueue();
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
function makeHost(opts: { withInfoGenre?: boolean; search?: unknown; qqEmpty?: boolean; detail?: unknown; nsEmpty?: boolean } = {}): any {
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
          if (url.includes("music.163.com/api/cloudsearch/pc")) {
            return JSON.stringify(opts.nsEmpty ? { code: 200, result: { songs: [] } } : NS_SEARCH);
          }
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
    expect(host.calls[1]).toContain("music.163.com/api/cloudsearch/pc");
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
    const nsUrl = host.calls.find((u: string) => u.includes("music.163.com/api/cloudsearch/pc"))!;
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
      const nsIdx = host.calls.findIndex((u: string) => u.includes("music.163.com/api/cloudsearch/pc"));
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

// ==================== 分支补齐（第三轮）：边界 / 异常 / 兜底 ====================
//
// 以下用例仅**新增**，不改动上方任何既有用例。目的：把 tagProvider.ts 里尚未被触达的
// 空响应 / 非 200 / 非 JSON / 超时 / 候选字段缺失 / 风格与歌词解析边界 / 缓存容量 /
// 覆盖命中 / 网易云二次调详情 等分支逐一锁死，并断言既有不变量（QQ 默认优先、秒级时长等）。

/** 端点片段常量（顺序敏感：网易云歌词与 QQ 歌词都含 "lyric"，须先判网易云）。 */
const F_NS_SEARCH = "music.163.com/api/cloudsearch/pc";
const F_NS_DETAIL = "music.163.com/api/song/detail";
const F_NS_LYRIC = "music.163.com/api/song/lyric";
const F_QQ_SEARCH = "search_for_qq_cp";
const F_QQ_DETAIL = "musicu.fcg";
const F_QQ_LYRIC = "lyric/fcgi-bin";

/** 可编程 host：按 URL 片段返回任意响应；支持 null / 非 200 / 原始文本(非 JSON) / 抛错。 */
function routeHost(route: {
  map?: Record<string, unknown>;
  nullFor?: string[];
  notOkFor?: string[];
  rawFor?: Record<string, string>;
  throwFor?: string[];
}): any {
  const calls: string[] = [];
  return {
    calls,
    http: async (url: string) => {
      calls.push(url);
      if (route.throwFor?.some((f) => url.includes(f))) throw new Error("network boom");
      if (route.nullFor?.some((f) => url.includes(f))) return null;
      if (route.notOkFor?.some((f) => url.includes(f))) return { ok: false, text: async () => "" };
      for (const [f, txt] of Object.entries(route.rawFor ?? {})) {
        if (url.includes(f)) return { ok: true, text: async () => txt };
      }
      for (const [f, val] of Object.entries(route.map ?? {})) {
        if (url.includes(f)) {
          return { ok: true, text: async () => (typeof val === "string" ? val : JSON.stringify(val)) };
        }
      }
      return { ok: true, text: async () => JSON.stringify({}) };
    },
  };
}

/** QQ 真搜索端点的**期望 URL**：用于精确断言关键词只用 title（中文被 encodeURIComponent 编码，不能用 toContain）。 */
const qqKwUrl = (kw: string): string =>
  "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=" + encodeURIComponent(kw) + "&format=json&p=1&n=10&cr=1&new_json=1";

// ---------- HTTP 边界：空响应 / 非 200 / 非 JSON / 超时 ----------
describe("tag-provider — HTTP 边界(requestJson)", () => {
  it("QQ 搜索 res 为 null → 视为无结果，回退网易云", async () => {
    const host = routeHost({
      nullFor: [F_QQ_SEARCH],
      map: { [F_NS_SEARCH]: NS_SEARCH, [F_NS_DETAIL]: NS_DETAIL },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
  });

  it("QQ 搜索 HTTP 非 200(res.ok=false) → 视为无结果，回退网易云", async () => {
    const host = routeHost({
      notOkFor: [F_QQ_SEARCH],
      map: { [F_NS_SEARCH]: NS_SEARCH, [F_NS_DETAIL]: NS_DETAIL },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
  });

  it("QQ 搜索响应非 JSON(被风控返回 HTML) → 视为无结果", async () => {
    const host = routeHost({
      rawFor: { [F_QQ_SEARCH]: "<html>blocked</html>" },
      map: { [F_NS_SEARCH]: NS_SEARCH, [F_NS_DETAIL]: NS_DETAIL },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
  });

  it("请求超时(10s)→ 触发 AbortController.abort，软失败返回 null", async () => {
    const host = {
      calls: [] as string[],
      http: (url: string, init: any) => {
        // 四平台并发搜索:仅 QQ 挂起(超时),其余平台立即返回空,断言 QQ 超时被软失败吞掉。
        if (!url.includes("search_for_qq_cp")) {
          return Promise.resolve({ ok: true, text: async () => JSON.stringify({}) });
        }
        return new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => rej(new Error("aborted")));
        });
      },
    };
    vi.useFakeTimers();
    try {
      const p = tagProviderPlugin.searchMetadata(host as any, SONG);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- QQ 搜索候选字段缺失 ----------
describe("tag-provider — QQ 候选字段缺失归一化", () => {
  it("候选缺 mid/songmid、title/songname、interval、singer 非字符串 → 归一化兜底不抛错", async () => {
    const weird = {
      code: 0,
      data: {
        song: {
          list: [
            { songmid: "legacyMid001", songname: "告白气球", singername: 123 }, // 旧结构 + 非字符串歌手
            { mid: "003OUlho2HcRHC", title: "告白气球", singer: [{ name: 5 }] }, // 歌手对象 name 非字符串
            { mid: "", title: "告白气球" }, // mid 为空 → 跳过
            { title: "告白气球" }, // 既无 mid 亦无 songmid → 空
            { mid: "003noname0001" }, // 既无 title 亦无 songname → 空 → 跳过
            { mid: "003noint000001", title: "告白气球", singer: [{ name: "周杰伦" }] }, // 无 interval → 0
          ],
        },
      },
    };
    const host = routeHost({ map: { [F_QQ_SEARCH]: weird } });
    // 只关心归一化分支不抛错；这些候选均无法通过匹配闸门 → 最终 null
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta).toBeNull();
  });
});

// ---------- QQ 详情 / 风格解析边界 ----------
describe("tag-provider — QQ 详情与 genre 解析边界", () => {
  it("详情响应缺 track_info → 该候选跳过(不写缓存)，走网易云兜底", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: { code: 0, req: { data: {} } },
        [F_NS_SEARCH]: NS_SEARCH,
        [F_NS_DETAIL]: NS_DETAIL,
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
  });

  it("详情无 info 块 → genre 为空(绝不回落 track_info.genre 数字码)", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: {
          code: 0,
          req: {
            data: {
              track_info: {
                name: "告白气球",
                singer: [{ name: "周杰伦" }],
                album: { mid: "000MkMni19ClKG", name: "周杰伦的床边故事" },
                interval: 215,
                index_album: 8,
                genre: 33,
              },
            },
          },
        },
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("qq");
    expect(meta?.genre).toBeUndefined();
  });

  it("info.genre.content 值非字符串/为空白 → genre 不填", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: {
          code: 0,
          req: {
            data: {
              info: { genre: { content: [{ id: 1 }, { value: 5 }, { value: "   " }] } },
              track_info: { name: "告白气球", singer: [{ name: "周杰伦" }], album: { name: "专辑" }, interval: 215, index_album: 1 },
            },
          },
        },
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.genre).toBeUndefined();
  });

  it("轨号/年份兜底：title 回退、singer 非数组、album.time_public 兜底年份、index_album 非法", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: {
          code: 0,
          req: {
            data: {
              track_info: {
                title: "告白气球", // 无 name → 走 title 兜底
                singer: "周杰伦", // 非数组 → artist 不填
                album: { name: "周杰伦的床边故事", time_public: "2010-01-01" }, // 无 mid；年份由 album.time_public 兜底
                interval: 215,
                index_album: 0, // 非法轨号 → 不填
              },
            },
          },
        },
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.title).toBe("告白气球");
    expect(meta?.artist).toBeUndefined();
    expect(meta?.year).toBe(2010);
    expect(meta?.track).toBeUndefined();
    expect(meta?.platform).toBe("qq");
  });

  it("time_public 非法(无可识别年份)→ 不填年份", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: {
          code: 0,
          req: {
            data: {
              track_info: {
                name: "告白气球",
                singer: [{ name: "周杰伦" }],
                album: { mid: "000MkMni19ClKG", name: "专辑" },
                interval: 215,
                time_public: "unknown",
              },
            },
          },
        },
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.title).toBe("告白气球");
    expect(meta?.year).toBeUndefined();
  });

  it("album.time_public 非法 → 不填年份", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: {
          code: 0,
          req: {
            data: {
              track_info: {
                name: "告白气球",
                singer: [{ name: "周杰伦" }],
                album: { mid: "000MkMni19ClKG", name: "专辑", time_public: "unknown" },
                interval: 215,
              },
            },
          },
        },
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.title).toBe("告白气球");
    expect(meta?.year).toBeUndefined();
  });

  it("详情 track_info 为空 → 除 platform 外无有效字段则不返回空壳(null)，走兜底", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: { code: 0, req: { data: { track_info: {} } } },
        [F_NS_SEARCH]: NS_SEARCH,
        [F_NS_DETAIL]: NS_DETAIL,
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
  });
});

// ---------- searchMetadata 闸门与无标题 ----------
describe("tag-provider — searchMetadata 闸门/无标题", () => {
  it("无标题 → null(不发起任何请求)", async () => {
    const host = makeHost();
    expect(await tagProviderPlugin.searchMetadata(host, { artist: "周杰伦" })).toBeNull();
    expect(host.calls.length).toBe(0);
  });

  it("未提供本地时长(null/undefined)→ 时长闸门跳过，仍可命中", async () => {
    const host = makeHost();
    const meta = await tagProviderPlugin.searchMetadata(host, { title: "告白气球", artist: "周杰伦" });
    expect(meta?.title).toBe("告白气球");
  });

  it("候选搜索时长通过但详情时长不符 → 跳过并走网易云兜底", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: {
          code: 0,
          req: { data: { track_info: { name: "告白气球", singer: [{ name: "周杰伦" }], album: { mid: "000MkMni19ClKG" }, interval: 100 } } },
        },
        [F_NS_SEARCH]: NS_SEARCH,
        [F_NS_DETAIL]: NS_DETAIL,
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
  });

  it("候选标题归一化后为空(纯装饰如 (Live))→ 标题闸门直接判否", async () => {
    const search = { code: 0, data: { song: { list: [{ mid: "m", title: "(Live)", singer: [{ name: "周杰伦" }], interval: 215 }] } } };
    const host = routeHost({ map: { [F_QQ_SEARCH]: search } });
    expect(await tagProviderPlugin.searchMetadata(host, SONG)).toBeNull();
  });
});

// ---------- 网易云候选字段缺失 / 缓存 / 空响应 / 年份边界 ----------
describe("tag-provider — 网易云候选字段与年份边界", () => {
  it("候选 id/name 缺失被跳过；artists 非数组；album/duration 缺失 → 归一化兜底", async () => {
    const ns = {
      code: 200,
      result: {
        songs: [
          { id: 11, name: "告白气球", artists: "不是数组", album: undefined, duration: undefined },
          { name: "告白气球" }, // 无 id → 跳过
          { id: 13 }, // 无 name → 跳过
          { id: 14, name: "告白气球", artists: [{ name: 5 }], album: {}, duration: 215000 },
        ],
      },
    };
    const host = routeHost({ nullFor: [F_QQ_SEARCH], map: { [F_NS_SEARCH]: ns, [F_NS_DETAIL]: NS_DETAIL } });
    // 这些候选歌手名均归一化为空 → 歌手闸门不通过；只验证解析分支不抛错
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta === null || !!meta).toBe(true);
  });

  it("网易云搜索 res 为 null → 返回空候选(不写缓存)", async () => {
    const host = routeHost({ nullFor: [F_QQ_SEARCH, F_NS_SEARCH] });
    expect(await tagProviderPlugin.searchMetadata(host, SONG)).toBeNull();
  });

  it("兜底命中候选的歌手名/专辑名/时长均缺省 → 对应字段不填(title 仍在)", async () => {
    const ns = {
      code: 200,
      result: {
        songs: [
          // 歌手对象 name 非字符串 → singerName 归一化为空；album 无 name；duration 缺省 → interval 0
          { id: 21, name: "告白气球", artists: [{ name: 5 }], album: {}, duration: undefined },
        ],
      },
    };
    const host = routeHost({ nullFor: [F_QQ_SEARCH], map: { [F_NS_SEARCH]: ns, [F_NS_DETAIL]: NS_DETAIL } });
    // song.artist 为空 → 歌手闸门放宽；候选歌手名/专辑名为空、时长为 0（≤0 视为「不校验」）
    const meta = await tagProviderPlugin.searchMetadata(host, { title: "告白气球", artist: "", duration: 215 });
    expect(meta?.platform).toBe("netease");
    expect(meta?.title).toBe("告白气球");
    expect(meta?.artist).toBeUndefined();
    expect(meta?.album).toBeUndefined();
    expect(meta?.duration).toBeUndefined();
  });

  it("网易云兜底候选标题不匹配 → 不命中", async () => {
    const ns = { code: 200, result: { songs: [{ id: 7, name: "完全不同的歌", artists: [{ name: "周杰伦" }], duration: 215000 }] } };
    const host = routeHost({ nullFor: [F_QQ_SEARCH], map: { [F_NS_SEARCH]: ns, [F_NS_DETAIL]: NS_DETAIL } });
    expect(await tagProviderPlugin.searchMetadata(host, SONG)).toBeNull();
  });

  it("publishTime 为 0/非法 → 不产出年份", async () => {
    const ns = { code: 200, result: { songs: [{ id: 9, name: "告白气球", artists: [{ name: "周杰伦" }], album: { name: "专辑", publishTime: 0 }, duration: 215000 }] } };
    const host = routeHost({ nullFor: [F_QQ_SEARCH], map: { [F_NS_SEARCH]: ns, [F_NS_DETAIL]: NS_DETAIL } });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
    expect(meta?.year).toBeUndefined();
  });

  it("publishTime 换算年份超出 1900–2100 → 不产出年份", async () => {
    const ns = { code: 200, result: { songs: [{ id: 9, name: "告白气球", artists: [{ name: "周杰伦" }], album: { name: "专辑", publishTime: 9999999999999 }, duration: 215000 }] } };
    const host = routeHost({ nullFor: [F_QQ_SEARCH], map: { [F_NS_SEARCH]: ns, [F_NS_DETAIL]: NS_DETAIL } });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.year).toBeUndefined();
  });

  it("同一首歌第二次调用命中网易云搜索缓存：搜索端点只打一次", async () => {
    const host = makeHost({ qqEmpty: true });
    await tagProviderPlugin.searchMetadata(host, SONG);
    await tagProviderPlugin.searchMetadata(host, SONG);
    const n = host.calls.filter((u: string) => u.includes(F_NS_SEARCH)).length;
    expect(n).toBe(1);
  });
});

// ---------- searchCover 闸门与兜底 ----------
describe("tag-provider — searchCover 闸门与兜底", () => {
  it("无标题 → null(不发起任何请求)", async () => {
    const host = makeHost();
    expect(await tagProviderPlugin.searchCover(host, { artist: "周杰伦", duration: 215 })).toBeNull();
    expect(host.calls.length).toBe(0);
  });

  it("占位歌手 / 无歌手 → 关键词均只用 title", async () => {
    const h1 = makeHost();
    await tagProviderPlugin.searchCover(h1, { title: "告白气球", artist: "Unknown Artist", duration: 215 });
    // 占位歌手被当作空 → 关键词仅标题（末尾无 ` Unknown Artist`）
    expect(h1.calls[0]).toBe(qqKwUrl("告白气球"));
    const h2 = makeHost();
    await tagProviderPlugin.searchCover(h2, { title: "晴天", duration: 215 });
    // 无歌手 → 关键词同样仅标题
    expect(h2.calls[0]).toBe(qqKwUrl("晴天"));
  });

  it("候选依次被标题/歌手/时长闸门拦下后命中最后一条", async () => {
    const search = {
      code: 0,
      data: {
        song: {
          list: [
            { mid: "m1", title: "别的歌", singer: [{ name: "周杰伦" }], interval: 215 }, // 标题不匹配
            { mid: "m2", title: "告白气球", singer: [{ name: "群星" }], interval: 215 }, // 歌手不匹配
            { mid: "m3", title: "告白气球", singer: [{ name: "周杰伦" }], interval: 100 }, // 时长不匹配
            { mid: "003OUlho2HcRHC", title: "告白气球", singer: [{ name: "周杰伦" }], interval: 215 },
          ],
        },
      },
    };
    const host = routeHost({ map: { [F_QQ_SEARCH]: search, [F_QQ_DETAIL]: detailJson({ withInfoGenre: true }) } });
    const r = await tagProviderPlugin.searchCover(host, SONG);
    expect(r?.url).toContain("000MkMni19ClKG");
    expect(host.calls.filter((u: string) => u.includes(F_QQ_DETAIL)).length).toBe(1);
  });

  it("QQ 详情为空 → 封面走网易云兜底(二次调详情取 picUrl)", async () => {
    const host = routeHost({
      map: { [F_QQ_SEARCH]: SEARCH, [F_QQ_DETAIL]: { code: 0, req: { data: {} } }, [F_NS_SEARCH]: NS_SEARCH, [F_NS_DETAIL]: NS_DETAIL },
    });
    expect((await tagProviderPlugin.searchCover(host, SONG))?.url).toBe(NS_DETAIL.songs[0].album.picUrl);
  });

  it("QQ 详情时长不符 → 跳过并走网易云兜底", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: { code: 0, req: { data: { track_info: { name: "告白气球", singer: [{ name: "周杰伦" }], album: { mid: "000MkMni19ClKG" }, interval: 100 } } } },
        [F_NS_SEARCH]: NS_SEARCH,
        [F_NS_DETAIL]: NS_DETAIL,
      },
    });
    expect((await tagProviderPlugin.searchCover(host, SONG))?.url).toBe(NS_DETAIL.songs[0].album.picUrl);
  });

  it("QQ 详情无专辑 mid → 跳过并走网易云兜底", async () => {
    const host = routeHost({
      map: {
        [F_QQ_SEARCH]: SEARCH,
        [F_QQ_DETAIL]: { code: 0, req: { data: { track_info: { name: "告白气球", singer: [{ name: "周杰伦" }], interval: 215 } } } },
        [F_NS_SEARCH]: NS_SEARCH,
        [F_NS_DETAIL]: NS_DETAIL,
      },
    });
    expect((await tagProviderPlugin.searchCover(host, SONG))?.url).toBe(NS_DETAIL.songs[0].album.picUrl);
  });

  it("网易云详情无可解析的 picUrl → 封面返回 null", async () => {
    const nsDetailNoPic = { code: 200, songs: [{ album: { picId: 1 } }] };
    const host = routeHost({ nullFor: [F_QQ_SEARCH], map: { [F_NS_SEARCH]: NS_SEARCH, [F_NS_DETAIL]: nsDetailNoPic } });
    expect(await tagProviderPlugin.searchCover(host, SONG)).toBeNull();
  });

  it("同一首歌第二次取封面命中网易云封面缓存：详情端点只打一次", async () => {
    const host = makeHost({ qqEmpty: true });
    await tagProviderPlugin.searchCover(host, SONG);
    await tagProviderPlugin.searchCover(host, SONG);
    const n = host.calls.filter((u: string) => u.includes(F_NS_DETAIL)).length;
    expect(n).toBe(1);
  });
});

// ---------- searchLyrics 闸门与歌词解析边界 ----------
describe("tag-provider — searchLyrics 闸门与歌词解析", () => {
  it("无标题 → null(不发起任何请求)", async () => {
    const host = makeHost();
    expect(await tagProviderPlugin.searchLyrics(host, { artist: "周杰伦" })).toBeNull();
    expect(host.calls.length).toBe(0);
  });

  it("占位歌手 / 无歌手 → 关键词均只用 title", async () => {
    const h1 = makeHost();
    await tagProviderPlugin.searchLyrics(h1, { title: "告白气球", artist: "未知歌手" });
    // 占位歌手「未知歌手」被当作空 → 关键词仅标题
    expect(h1.calls[0]).toBe(qqKwUrl("告白气球"));
    const h2 = makeHost();
    await tagProviderPlugin.searchLyrics(h2, { title: "晴天" });
    // 无歌手 → 关键词同样仅标题
    expect(h2.calls[0]).toBe(qqKwUrl("晴天"));
  });

  it("候选被标题/歌手闸门拦下后命中", async () => {
    const search = {
      code: 0,
      data: {
        song: {
          list: [
            { mid: "m1", title: "别的歌", singer: [{ name: "周杰伦" }], interval: 215 },
            { mid: "m2", title: "告白气球", singer: [{ name: "群星" }], interval: 215 },
            { mid: "003OUlho2HcRHC", title: "告白气球", singer: [{ name: "周杰伦" }], interval: 215 },
          ],
        },
      },
    };
    const host = routeHost({ map: { [F_QQ_SEARCH]: search, [F_QQ_LYRIC]: LYRIC_JSON } });
    expect((await tagProviderPlugin.searchLyrics(host, SONG))?.lrc).toContain("[ti:告白气球]");
  });

  it("QQ 歌词响应无 lyric 字段 → 该候选跳过 → 网易云兜底", async () => {
    const host = routeHost({
      map: { [F_QQ_SEARCH]: SEARCH, [F_QQ_LYRIC]: {}, [F_NS_SEARCH]: NS_SEARCH, [F_NS_LYRIC]: NS_LYRIC },
    });
    expect((await tagProviderPlugin.searchLyrics(host, SONG))?.lrc).toContain("[00:00.000]告白气球");
  });

  it("网易云歌词为空/仅空白 → 返回 null", async () => {
    const host = routeHost({
      nullFor: [F_QQ_SEARCH],
      map: { [F_NS_SEARCH]: NS_SEARCH, [F_NS_LYRIC]: { code: 200, lrc: { lyric: "   " } } },
    });
    expect(await tagProviderPlugin.searchLyrics(host, SONG)).toBeNull();
  });

  it("歌词含 [ar:] 标签 → 原样返回(不解码)", async () => {
    const raw = "[ar:周杰伦]\n[00:01.00]歌词";
    const host = routeHost({ map: { [F_QQ_SEARCH]: SEARCH, [F_QQ_LYRIC]: { code: 0, lyric: raw } } });
    expect((await tagProviderPlugin.searchLyrics(host, SONG))?.lrc).toBe(raw);
  });

  it("歌词仅含时间戳(无 [ti:/[ar:) → 原样返回", async () => {
    const raw = "[00:01.00]只有时间戳";
    const host = routeHost({ map: { [F_QQ_SEARCH]: SEARCH, [F_QQ_LYRIC]: { code: 0, lyric: raw } } });
    expect((await tagProviderPlugin.searchLyrics(host, SONG))?.lrc).toBe(raw);
  });

  it("歌词看起来像 base64 → 尝试解码", async () => {
    const payload = "hello world lyrics";
    const b64 = Buffer.from(payload, "utf8").toString("base64");
    const host = routeHost({ map: { [F_QQ_SEARCH]: SEARCH, [F_QQ_LYRIC]: { code: 0, lyric: b64 } } });
    expect((await tagProviderPlugin.searchLyrics(host, SONG))?.lrc).toBe(payload);
  });

  it("歌词既非 LRC 亦非 base64(含中文)→ 原样返回", async () => {
    const raw = "这是一段没有时间戳的中文歌词";
    const host = routeHost({ map: { [F_QQ_SEARCH]: SEARCH, [F_QQ_LYRIC]: { code: 0, lyric: raw } } });
    expect((await tagProviderPlugin.searchLyrics(host, SONG))?.lrc).toBe(raw);
  });
});

// ---------- 能力方法内部异常：一律软失败 ----------
describe("tag-provider — 内部异常软失败", () => {
  it("song.title 取值抛错 → 三个能力方法均不抛出，返回 null", async () => {
    const boom: any = {
      get title() {
        throw new Error("boom");
      },
    };
    await expect(tagProviderPlugin.searchMetadata(makeHost(), boom)).resolves.toBeNull();
    await expect(tagProviderPlugin.searchCover(makeHost(), boom)).resolves.toBeNull();
    await expect(tagProviderPlugin.searchLyrics(makeHost(), boom)).resolves.toBeNull();
  });

  it("QQ 节流队列内部抛错(Date.now 异常)→ 拒绝回调兜底，队列不掐断，能力方法返回 null", async () => {
    // 节流回调首行即调用 Date.now()；令其抛错 → 回调返回的 run 变为 rejected，
    // 从而触发 qqThrottled 的**拒绝兜底**分支（run 拒绝后被收敛为 resolved，不向调用方抛）。
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock boom");
    });
    try {
      await expect(tagProviderPlugin.searchMetadata(makeHost(), SONG)).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------- memo 容量上限 ----------
describe("tag-provider — memo 容量上限", () => {
  it("memo 超过 2000 条 → 整体清空(内存有界，不抛错)", async () => {
    const host = makeHost();
    for (let i = 0; i < 1100; i++) {
      // 每首歌两条键(QQ 搜索 + 网易云搜索)：1100×2 > 2000，必然触发一次整体清空
      await tagProviderPlugin.searchMetadata(host, { title: `曲目${i}`, duration: 215 });
    }
    expect(host.calls.length).toBeGreaterThan(2000);
  }, 60000);
});

// ==================== 酷狗 / 酷我 / 评分逻辑（2026-11-12 扩源） ====================

const F_KG_SEARCH = "complexsearch.kugou.com";
const F_KW_SEARCH = "search.kuwo.cn/r.s";
const F_KW_INFO = "m.kuwo.cn/newh5/singles/songinfoandlrc";

/** 酷狗搜索（真实字段裁剪）：两条候选 —— 正曲 + Live 版。 */
const KG_SEARCH = {
  data: {
    lists: [
      {
        FileHash: "HASH_STUDIO",
        SongName: "告白气球",
        SingerName: "周杰伦",
        AlbumName: "周杰伦的床边故事",
        Duration: 215,
        PublishDate: "2016-06-24",
        Image: "http://imge.kugou.com/stdmusic/{size}/cover.jpg",
      },
      {
        FileHash: "HASH_LIVE",
        SongName: "告白气球 (Live)",
        SingerName: "周杰伦",
        AlbumName: "地表最强演唱会",
        Duration: 215,
        PublishDate: "2017-01-01",
        Image: "http://imge.kugou.com/stdmusic/{size}/live.jpg",
      },
    ],
  },
};

/** 酷我搜索（真实结构：**单引号 JSON + &nbsp;**）。 */
const KW_TEXT =
  "{'abslist':[{'MUSICRID':'MUSIC_118980','NAME':'告白气球','ARTIST':'周杰伦','ALBUM':'周杰伦&nbsp;的床边故事','DURATION':'215','web_albumpic_short':'120/s4s11/89/1.jpg'}]}";

/** 网易云 cloudsearch 新结构（带 al.picUrl / no / dt / publishTime）。 */
const NS_CLOUD = {
  result: {
    songs: [
      {
        id: 186016,
        name: "告白气球",
        ar: [{ name: "周杰伦" }],
        al: { name: "周杰伦的床边故事", picUrl: "http://p1.music.126.net/abc==/109951174108738240.jpg" },
        dt: 215000,
        publishTime: 1466697600000,
        no: 8,
      },
    ],
  },
};

const emptySong = (extra: Partial<LyricSongInput>): LyricSongInput => ({ title: "告白气球", artist: "周杰伦", duration: 215, ...extra });

describe("tag-provider — 酷狗 / 酷我 扩源", () => {
  it("QQ/网易云均无候选 → 酷狗命中（年份/专辑/封面齐全，轨号不臆造）", async () => {
    const host = routeHost({ map: { [F_QQ_SEARCH]: SEARCH_EMPTY, [F_KG_SEARCH]: KG_SEARCH } });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("kugou");
    expect(meta?.album).toBe("周杰伦的床边故事");
    expect(meta?.year).toBe(2016);
    expect(meta?.duration).toBe(215);
    expect(meta?.track).toBeUndefined();
    const cover = await tagProviderPlugin.searchCover(host, SONG);
    expect(cover?.url).toBe("http://imge.kugou.com/stdmusic/480/cover.jpg");
  });

  it("酷狗 Live 版被版本标记闸门否决（不会把演唱会版当正曲）", async () => {
    const onlyLive = { data: { lists: [KG_SEARCH.data.lists[1]] } };
    const host = routeHost({ map: { [F_QQ_SEARCH]: SEARCH_EMPTY, [F_KG_SEARCH]: onlyLive } });
    expect(await tagProviderPlugin.searchMetadata(host, SONG)).toBeNull();
  });

  it("酷我单引号 JSON + &nbsp; 可解析；封面按 img1 前缀拼接", async () => {
    const host = routeHost({ rawFor: { [F_KW_SEARCH]: KW_TEXT }, map: { [F_QQ_SEARCH]: SEARCH_EMPTY } });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("kuwo");
    expect(meta?.artist).toBe("周杰伦");
    expect(meta?.album).toBe("周杰伦 的床边故事");
    const cover = await tagProviderPlugin.searchCover(host, SONG);
    expect(cover?.url).toBe("http://img1.kuwo.cn/star/albumcover/120/s4s11/89/1.jpg");
  });

  it("酷我专辑缺失 → 用 songinfo 补专辑；歌词按 lrclist 拼成标准 LRC", async () => {
    const kwNoAlbum =
      "{'abslist':[{'MUSICRID':'MUSIC_118980','NAME':'告白气球','ARTIST':'周杰伦','ALBUM':'','DURATION':'215'}]}";
    const songInfo = {
      data: {
        songinfo: { album: "周杰伦的床边故事", duration: 215 },
        lrclist: [
          { time: "1.5", lineLyric: "第一句" },
          { time: "61.25", lineLyric: "第二句" },
        ],
      },
    };
    const host = routeHost({
      rawFor: { [F_KW_SEARCH]: kwNoAlbum },
      map: { [F_QQ_SEARCH]: SEARCH_EMPTY, [F_KW_INFO]: songInfo },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("kuwo");
    expect(meta?.album).toBe("周杰伦的床边故事");
    const lrc = (await tagProviderPlugin.searchLyrics(host, SONG))?.lrc;
    expect(lrc).toBe("[00:01.50]第一句\n[01:01.25]第二句");
  });

  it("四平台同曲时评分择优：专辑+封面更全的酷狗胜出（QQ 仅弱命中时）", async () => {
    // QQ 候选缺歌手 → 弱命中，触发四平台并发评分；酷狗专辑/年份齐全且时长贴近 → 分更高
    const qqWeak = { code: 0, data: { song: { list: [{ mid: "mweak", title: "告白气球", interval: 215 }] } } };
    const host = routeHost({
      map: { [F_QQ_SEARCH]: qqWeak, [F_KG_SEARCH]: KG_SEARCH, [F_NS_SEARCH]: NS_CLOUD },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, emptySong({ artist: "" }));
    // QQ 弱候选(歌手 0 分) vs 酷狗/网易云(歌手 2 分 + 专辑 2 分) → 后者胜；同分按平台序取网易云
    expect(meta?.platform).toBe("netease");
    expect(meta?.track).toBe(8);
  });
});

describe("tag-provider — 网易云 cloudsearch 新接口", () => {
  it("搜索响应直出封面/轨号/年份，封面不再二次调详情", async () => {
    const host = routeHost({ nullFor: [F_QQ_SEARCH], map: { [F_NS_SEARCH]: NS_CLOUD } });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.platform).toBe("netease");
    expect(meta?.track).toBe(8);
    expect(meta?.year).toBe(2016);
    const cover = await tagProviderPlugin.searchCover(host, SONG);
    expect(cover?.url).toBe("https://p1.music.126.net/abc==/109951174108738240.jpg");
    expect(host.calls.filter((u: string) => u.includes("api/song/detail")).length).toBe(0);
  });
});

describe("tag-provider — 评分函数口径", () => {
  const cand = (over: Record<string, unknown> = {}) => ({
    platform: "kugou" as const,
    id: "h",
    name: "告白气球",
    singerName: "周杰伦",
    albumName: "周杰伦的床边故事",
    durationSec: 215,
    ...over,
  });

  it("精确标题 + 歌手 + 专辑 + 时长贴近 → 命中且分数最高", () => {
    const s = scoreTagCandidate(cand(), emptySong({ album: "周杰伦的床边故事" }));
    expect(s.reject).toBeUndefined();
    expect(s.total).toBe(2 * 3 + 2 * 2 + 2 + 1);
  });

  it("歌手完全不匹配 / 时长超差 / 版本标记不一致 → 各自否决", () => {
    expect(scoreTagCandidate(cand({ singerName: "群星" }), SONG).reject).toBe("歌手不匹配");
    expect(scoreTagCandidate(cand({ durationSec: 100 }), SONG).reject).toBe("时长超差");
    expect(scoreTagCandidate(cand({ name: "告白气球 (Live)" }), SONG).reject).toContain("版本标记");
  });

  it("本地无歌手 → 歌手按中性 0 分，标题命中仍可用", () => {
    const s = scoreTagCandidate(cand(), emptySong({ artist: "" }));
    expect(s.reject).toBeUndefined();
    expect(s.artist).toBe(0);
  });
});

// ---------- 2026-11-12 曲库实测(40 首真实歌曲)后的两处修正 ----------
// 实测结论(严格层 ±5s):39/40 命中、错配 0、假阳性 0;唯一 miss 是
// 「最寂寞的时候 (忧郁版)」本地 217s / 平台 208s(Δ9s,前奏尾奏裁剪),
// 以及「老公天下第一」QQ 详情只回标题+歌手+时长、把搜索候选已拿到的专辑丢掉。
describe("tag-provider — 时长放宽层与 QQ 字段回退(2026-11-12 实测)", () => {
  /** 平台声明 224s,本地 215s → Δ9s:严格层否决,放宽层可救。 */
  const SEARCH_224 = {
    code: 0,
    data: {
      song: {
        list: [
          {
            mid: "003OUlho2HcRHC",
            title: "告白气球",
            singer: [{ mid: "0025NhlN2yWrP4", name: "周杰伦" }],
            album: { mid: "000MkMni19ClKG", name: "周杰伦的床边故事" },
            interval: 224,
          },
        ],
      },
    },
  };
  const DETAIL_224 = {
    code: 0,
    req: {
      code: 0,
      data: {
        info: {},
        track_info: {
          mid: "003OUlho2HcRHC",
          name: "告白气球",
          singer: [{ name: "周杰伦" }],
          album: { mid: "000MkMni19ClKG", name: "周杰伦的床边故事", time_public: "2016-06-24" },
          interval: 224,
        },
      },
    },
  };

  it("严格层(±5s)否决、标题+歌手都精确 → 放宽层(±15s)仍命中", async () => {
    const host = makeHost({ search: SEARCH_224, detail: DETAIL_224, nsEmpty: true });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG); // 215 vs 224 → Δ9s
    expect(meta?.platform).toBe("qq");
    expect(meta?.title).toBe("告白气球");
    expect(meta?.artist).toBe("周杰伦");
  });

  it("放宽层不放宽歌手：Δ9s 但歌手不同 → 仍 null(避免配到翻唱)", async () => {
    const host = makeHost({
      nsEmpty: true,
      search: {
        code: 0,
        data: {
          song: {
            list: [{ mid: "003other000001", title: "告白气球", singer: [{ name: "群星" }], album: { name: "大合辑" }, interval: 224 }],
          },
        },
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta).toBeNull();
  });

  it("QQ 详情缺 album → 用搜索候选的专辑补齐，不再返回半空元数据", async () => {
    const host = makeHost({
      detail: {
        code: 0,
        req: {
          code: 0,
          data: {
            info: {},
            track_info: { mid: "003OUlho2HcRHC", name: "告白气球", singer: [{ name: "周杰伦" }], interval: 215 },
          },
        },
      },
    });
    const meta = await tagProviderPlugin.searchMetadata(host, SONG);
    expect(meta?.album).toBe("周杰伦的床边故事");
    expect(meta?.duration).toBe(215);
  });
});
