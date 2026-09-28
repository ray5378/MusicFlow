// ==================== 统一音源裁决:取流与兜底分支 补测 ====================
//
// 本模块是所有播放链路(DLNA 拉流 / 本机出流 / sendspin pump / 切歌前 judge)的
// **唯一真相源**。既有 `tests/services/resolveAudio.test.ts` 是集成式的(真 SQLite +
// 真文件 + 打桩 fetch),够得到优选换行的主路径,但下面几条**只有环境坏了才走得到**:
//
//   ① 库查询本身炸了 —— 必须回 `definitive:false`,让调用方**宽容放行**;
//      判成「确定无源」会把一首只是库抖了的歌直接 skip 掉。
//   ② `verifyRow` 抛错必须被吞 —— 它只是「这一行能不能播」的探询,抛错等于
//      「不知道」,不是「不能播」;让它冒泡会把整条裁决打断。
//   ③ `fetchRowBytes` 的 web 分支:缓存命中 / 缓存读失败回落 url / 无 url /
//      非 2xx / 非法 stream_headers —— 每一条都直接决定「有声还是无声」。
//   ④ 取字节失败必须逐出该曲的 WebDAV 成功记忆(成功记忆只代表「探测当时可播」)。
//
// 这里把 db / streamFallback / preferredSource / localSourceProbe 全部换成受控替身,
// 不碰真实库与真实文件(除缓存命中那条要读一个真实临时文件)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const h = vi.hoisted(() => ({
  row: null as any,
  dbThrow: false,
  cached: undefined as unknown,
  ensure: vi.fn(async () => false),
  probe: vi.fn(async () => "ok" as string),
  preferred: vi.fn(async () => null as any),
  localOk: vi.fn(async () => false),
  parsed: undefined as any,
  parseThrow: false,
  evictThrow: false,
  evicted: [] as string[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ info: h.log.info, warn: h.log.warn, error: h.log.error, debug: h.log.debug }),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(() => {
            if (h.dbThrow) throw new Error("disk I/O error");
            return h.row;
          }),
        })),
      })),
    })),
  },
}));

vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  ensurePlayableStream: (...a: any[]) => h.ensure(...a),
  getCachedPlayability: () => h.cached,
  probeStream: (...a: any[]) => h.probe(...a),
}));

vi.mock("../../src/services/source/preferredSource.js", () => ({
  resolvePreferredSong: (...a: any[]) => h.preferred(...a),
}));

vi.mock("../../src/utils/localSourceProbe.js", () => ({
  probeLocalSourceOk: (...a: any[]) => h.localOk(...a),
  parseSongPath: (p: string) => {
    if (h.parseThrow) throw new Error("path 解析炸了");
    return h.parsed ?? (p ? { type: "l", filePath: p } : null);
  },
  evictProbeOk: (id: string) => {
    if (h.evictThrow) throw new Error("evict boom");
    h.evicted.push(id);
  },
}));

import {
  resolvePlayableRow,
  fetchRowBytes,
  resolveRowInput,
} from "../../src/services/source/resolveAudio.js";

const localRow = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: "t",
    artist: "a",
    type: "local",
    url: "",
    path: `l:src:/tmp/${id}.wav`,
    pluginEntry: null,
    ...over,
  }) as any;

const webRow = (id: string, url: string, over: Record<string, unknown> = {}) =>
  ({ id, title: "t", artist: "a", type: "web", url, path: "", pluginEntry: "go-music-dl", ...over }) as any;

beforeEach(() => {
  h.row = null;
  h.dbThrow = false;
  h.cached = undefined;
  h.ensure.mockReset();
  h.ensure.mockResolvedValue(false);
  h.probe.mockReset();
  h.probe.mockResolvedValue("ok");
  h.preferred.mockReset();
  h.preferred.mockResolvedValue(null);
  h.localOk.mockReset();
  h.localOk.mockResolvedValue(false);
  h.parsed = undefined;
  h.parseThrow = false;
  h.evictThrow = false;
  h.evicted.length = 0;
  h.log.info.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================
describe("resolvePlayableRow:库炸了 ≠ 确定无源", () => {
  it("库查询抛错 → 回 db-error 且 definitive=false(调用方须宽容放行)", async () => {
    h.dbThrow = true;
    const r = await resolvePlayableRow("s-db");
    expect(r.row).toBeNull();
    expect(r.reason).toMatch(/^db-error:/);
    // 库抖了不代表这首歌没源:判成 definitive 会被直接 skip。
    expect(r.definitive).toBe(false);
  });
});

// ============================================================
describe("resolvePlayableRow:本地行的优选换行与探测容错", () => {
  it("本地行探失败 + 组内 web 兄弟可用 → preferred-swap", async () => {
    h.row = localRow("L1");
    h.localOk.mockResolvedValue(false);
    h.preferred.mockResolvedValue(webRow("W1", "http://a/b.mp3"));
    h.probe.mockResolvedValue("ok");

    const r = await resolvePlayableRow("L1");
    expect(r.row?.id).toBe("W1");
    expect(r.reason).toBe("preferred-swap");
    expect(r.definitive).toBe(false);
    expect(h.probe).toHaveBeenCalledWith("http://a/b.mp3", 5000);
  });

  it("verifyRow 抛错被吞(探询失败 = 不知道,不是不能播)", async () => {
    h.row = localRow("L2");
    // 直探抛错 → 196-198 的 catch 吞掉,继续换行。
    h.localOk.mockImplementation(async () => {
      throw new Error("probe boom");
    });
    h.preferred.mockResolvedValue(localRow("L2b")); // 兄弟行探询同样抛错 → verifyRow 走 catch

    const r = await resolvePlayableRow("L2");
    expect(r.row).toBeNull();
    // 本地行探失败且无可用兄弟 = 文件确死,这时才可判 definitive。
    expect(r.reason).toBe("local-probe-fail");
    expect(r.definitive).toBe(true);
  });

  it("web 行:ensurePlayableStream 抛错被吞 → 复核本行仍可播就放行", async () => {
    h.row = webRow("W2", "http://a/b.mp3");
    // ensure 抛错 = 换行环节坏了,不等于这首歌没源 → 190 的 catch 吞掉后仍要复核一次。
    h.ensure.mockImplementation(async () => {
      throw new Error("换源炸了");
    });
    h.localOk.mockResolvedValue(true);

    const r = await resolvePlayableRow("W2");
    expect(r.row?.id).toBe("W2");
    expect(r.reason).toBe("reverify-ok");
    expect(r.definitive).toBe(false);
  });

  it("本地行:优选换行环节整体抛错 → 吞掉,按「本行确死」判 skip", async () => {
    h.row = localRow("L4");
    h.localOk.mockResolvedValue(false);
    // preferredSource 内部库查询炸了。它抛错 ≠ 兄弟行不可用,但本地行直探已失败,
    // 此时只有「确定无源」才是诚实的结论 —— 含糊放行会让泵下次取字节时才发现死链。
    h.preferred.mockImplementation(async () => {
      throw new Error("preferred 库炸了");
    });

    const r = await resolvePlayableRow("L4");
    expect(r.row).toBeNull();
    expect(r.reason).toBe("local-probe-fail");
    expect(r.definitive).toBe(true);
  });

  it("复核那层的 catch 是构造上够不到的:verifyRow 本身不抛", async () => {
    // resolvePlayableRow 第 4 步包着 verifyRow 的 try/catch 是**防御性**的:
    // verifyRow 自己的 try 已经把 probeLocalSourceOk / probeStream 的异常全吞成
    // false,而它对 row.type / row.url 的读取不可能同步抛 —— 所以这个 catch 永不触发。
    // 与其编一个假异常去刷行覆盖率,不如把「verifyRow 是全函数」这件事钉死,
    // 顺便说明:它返回 false 只有两种含义(探询失败 / 确认不可播),没有「不知道」。
    h.row = localRow("L5");
    h.cached = undefined;
    h.localOk.mockImplementation(async () => {
      throw new Error("底层探测炸了");
    });
    const r = await resolvePlayableRow("L5");
    expect(r.row).toBeNull();
    // 走到 4) 之前就已因本地直探失败判了 local-probe-fail,不会因为异常冒泡而变 all-failed。
    expect(r.reason).toBe("local-probe-fail");
  });

  it("兄弟行 url 为空 → verifyRow 直接否,不发起探测", async () => {
    h.row = localRow("L3");
    h.localOk.mockResolvedValue(false);
    h.preferred.mockResolvedValue(webRow("W3", ""));

    const r = await resolvePlayableRow("L3");
    expect(h.probe).not.toHaveBeenCalled();
    expect(r.reason).toBe("local-probe-fail");
  });

  it("快缓存命中 → 零成本直返本行", async () => {
    h.row = webRow("W4", "http://a/b.mp3");
    h.cached = "playable";
    const r = await resolvePlayableRow("W4");
    expect(r.reason).toBe("fresh-cache");
    expect(h.preferred).not.toHaveBeenCalled();
  });
});

// ============================================================
describe("fetchRowBytes:web 行的取字节分支", () => {
  it("缓存命中 → 直读缓存文件,不再发起网络请求", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-cache-"));
    const p = path.join(dir, "c.bin");
    fs.writeFileSync(p, Buffer.from("CACHED"));
    try {
      const fetchSpy = vi.fn(async () => new Response("NET", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      const bytes = await fetchRowBytes(webRow("W", "http://a/b.mp3", { cachePath: p }));
      expect(bytes?.toString()).toBe("CACHED");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缓存读失败(路径存在但读不了)→ 回落 url,不静默返回 null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-dir-"));
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("FROM-NET", { status: 200 })) as any);
      // 目录:existsSync true,但 readFileSync 抛 EISDIR → 落到 url 分支。
      const bytes = await fetchRowBytes(webRow("W", "http://a/b.mp3", { cachePath: dir }));
      expect(bytes?.toString()).toBe("FROM-NET");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无 url 且无缓存 → null(不发起请求)", async () => {
    const fetchSpy = vi.fn(async () => new Response("x", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchRowBytes(webRow("W", ""))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("非 2xx → null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })) as any);
    expect(await fetchRowBytes(webRow("W", "http://a/b.mp3"))).toBeNull();
  });

  it("stream_headers 非法 JSON → 按空头发请求,不因解析失败放弃取流", async () => {
    const spy = vi.fn(async () => new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const bytes = await fetchRowBytes(
      webRow("W", "http://a/b.mp3", { stream_headers: "{ 不是 JSON" }),
    );
    expect(bytes?.toString()).toBe("OK");
    expect(spy.mock.calls[0][1]?.headers).toEqual({});
  });

  it("stream_headers 合法 → 原样带出", async () => {
    const spy = vi.fn(async () => new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await fetchRowBytes(webRow("W", "http://a/b.mp3", { stream_headers: '{"X-T":"1"}' }));
    expect(spy.mock.calls[0][1]?.headers).toEqual({ "X-T": "1" });
  });

  it("取字节过程抛错 → 逐出该曲的成功记忆后返回 null", async () => {
    h.parseThrow = true;
    const bytes = await fetchRowBytes(localRow("L9"));
    expect(bytes).toBeNull();
    // 成功记忆只代表「探测当时可播」,取流失败必须让它失效,否则下次仍按可播放行。
    expect(h.evicted).toEqual(["L9"]);
  });

  it("逐出本身也抛错 → 不影响返回语义(仍 null,不抛)", async () => {
    h.parseThrow = true;
    h.evictThrow = true;
    await expect(fetchRowBytes(localRow("L10"))).resolves.toBeNull();
  });
});

// ============================================================
describe("fetchRowBytes:WebDAV 出流分支", () => {
  const src = (cfg: Record<string, unknown>) => ({ config: JSON.stringify(cfg) }) as any;

  function webdavRow(id: string) {
    h.parsed = { type: "w", sourceId: "src-1", filePath: "/music/x.mp3" };
    return localRow(id, { path: "w:src-1:/music/x.mp3" });
  }

  it("源存在 → 按 origin + filePath 取,带 Basic 鉴权", async () => {
    h.row = src({ url: "http://wd.example/dav/", username: "u", password: "p" });
    const spy = vi.fn(async () => new Response("WD", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const bytes = await fetchRowBytes(webdavRow("D1"));
    expect(bytes?.toString()).toBe("WD");
    expect(String(spy.mock.calls[0][0])).toBe("http://wd.example/music/x.mp3");
    expect(spy.mock.calls[0][1]?.headers?.Authorization).toBe(
      "Basic " + Buffer.from("u:p").toString("base64"),
    );
  });

  it("源没配账号密码 → 不带 Authorization(不要把空串 basic 头发出去)", async () => {
    h.row = src({ url: "http://wd.example/dav/" });
    const spy = vi.fn(async () => new Response("WD", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await fetchRowBytes(webdavRow("D2"));
    expect(spy.mock.calls[0][1]?.headers?.Authorization).toBeUndefined();
  });

  it("本地文件行 → 直读文件字节,不碰媒体源表", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mfb-"));
    const fp = path.join(dir, "a.wav");
    fs.writeFileSync(fp, Buffer.from("RIF"));
    // parseSongPath 替身被显式钉成「本地文件行」:type 不是 w,不该走到 WebDAV 那支。
    h.parsed = { type: "l", filePath: fp } as any;

    const bytes = await fetchRowBytes(localRow("L9") as any);
    expect(bytes?.toString("utf8")).toBe("RIF");
    // 本地读失败不该被当成「换源失败」,所以那条链路上不逐出成功记忆。
    expect(h.evicted).toEqual([]);
  });

  it("本地文件不在了 → null 且不逐出(不是 WebDAV 出流失败)", async () => {
    h.parsed = { type: "l", filePath: "/tmp/definitely-absent-9d2c.wav" } as any;
    const bytes = await fetchRowBytes(localRow("L10") as any);
    expect(bytes).toBeNull();
    expect(h.evicted).toEqual([]);
  });

  it("源行已删 → 逐出成功记忆并返回 null", async () => {
    h.row = null;
    const spy = vi.fn(async () => new Response("WD", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    expect(await fetchRowBytes(webdavRow("D3"))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(h.evicted).toEqual(["D3"]);
  });

  it("WebDAV 返回非 2xx → 逐出成功记忆并返回 null", async () => {
    h.row = src({ url: "http://wd.example/dav/" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })) as any);

    expect(await fetchRowBytes(webdavRow("D4"))).toBeNull();
    // 「探测当时可播」的记忆必须失效,否则下次还会选中这条已经取不到流的源。
    expect(h.evicted).toEqual(["D4"]);
  });
});

// ============================================================
describe("resolveRowInput:与 fetchRowBytes 同构的取输入", () => {
  it("路径解析炸了 → null(不抛给流式窗口)", () => {
    h.parseThrow = true;
    expect(resolveRowInput(localRow("L11"))).toBeNull();
  });

  it("web 行有缓存 → 直接把缓存文件路径交给 ffmpeg", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ri-cache-"));
    try {
      expect(resolveRowInput(webRow("W", "http://a/b.mp3", { cachePath: dir }))).toEqual({
        input: dir,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("本地行 → 交解析出的文件路径", () => {
    h.parsed = { type: "l", filePath: "/music/x.wav" };
    expect(resolveRowInput(localRow("L12"))).toEqual({ input: "/music/x.wav" });
  });
});
