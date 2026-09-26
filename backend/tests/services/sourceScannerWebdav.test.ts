/**
 * source/scanner.ts —— WebDAV 通道:连通性探测 + 流式扫描(目录 PROPFIND / 文件分级取头)。
 *
 * 全部走 global.fetch 桩:PROPFIND 返回手写 multistatus XML,GET 返回内存里的
 * WAV 字节。不碰真实网络、不依赖外网。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { testWebDAVConnection, scanWebDAVSource, upsertSong } from "../../src/services/source/scanner.js";
import { sqlite } from "../../src/db/index.js";

interface FakeResp {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function textResp(body: string, status = 207): FakeResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

function binResp(buf: Buffer, status = 206): FakeResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

function propfindXml(
  items: { href: string; collection?: boolean; size?: number; mtime?: string; etag?: string }[],
): string {
  const blocks = items
    .map((e) =>
      e.collection
        ? `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`
        : `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop><D:resourcetype/>` +
          `<D:getcontentlength>${e.size ?? 0}</D:getcontentlength>` +
          (e.mtime ? `<D:getlastmodified>${e.mtime}</D:getlastmodified>` : "") +
          (e.etag ? `<D:getetag>${e.etag}</D:getetag>` : "") +
          `</D:prop></D:propstat></D:response>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${blocks}</D:multistatus>`;
}

/** 与 scanner 内部一致的最小 WAV(44 字节头 + 静音 data)。 */
function buildWav(seconds: number): Buffer {
  const sampleRate = 8000, channels = 1, bits = 8;
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataLen = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const WAV = buildWav(1);

let fetchCalls: { url: string; method: string; headers: Record<string, string> }[] = [];
let handler: (url: string, init: any) => FakeResp | Promise<FakeResp>;

function installFetch() {
  fetchCalls = [];
  vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
    fetchCalls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {} });
    return handler(String(url), init);
  });
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("testWebDAVConnection", () => {
  it("HTTP 200 视为连接成功", async () => {
    handler = () => textResp("", 200);
    await expect(testWebDAVConnection("http://dav.local/music")).resolves.toEqual({
      success: true,
      message: "连接成功 (HTTP 200)",
    });
  });

  it("207 Multi-Status 也视为成功(WebDAV 的常态)", async () => {
    handler = () => textResp("", 207);
    const r = await testWebDAVConnection("http://dav.local/music");
    expect(r.success).toBe(true);
    expect(r.message).toContain("207");
  });

  it("非 2xx 返回失败并带上状态码", async () => {
    handler = () => textResp("", 404);
    const r = await testWebDAVConnection("http://dav.local/music");
    expect(r).toEqual({ success: false, error: "服务器返回 HTTP 404" });
  });

  it("网络异常返回失败并透出错误信息", async () => {
    handler = () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await testWebDAVConnection("http://dav.local/music");
    expect(r).toEqual({ success: false, error: "ECONNREFUSED" });
  });

  it("AbortError 映射为超时文案", async () => {
    handler = () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const r = await testWebDAVConnection("http://dav.local/music");
    expect(r).toEqual({ success: false, error: "连接超时（10秒）" });
  });

  it("无 message 的异常回落到「无法连接」", async () => {
    handler = () => {
      throw { name: "TypeError" };
    };
    const r = await testWebDAVConnection("http://dav.local/music");
    expect(r).toEqual({ success: false, error: "无法连接" });
  });

  it("提供账号密码时带 Basic 认证;rootPath 拼到 URL 上且去掉尾部斜杠", async () => {
    handler = () => textResp("", 200);
    await testWebDAVConnection("http://dav.local/music/", "u1", "p1", "/sub/");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://dav.local/music/sub");
    expect(fetchCalls[0].method).toBe("PROPFIND");
    expect(fetchCalls[0].headers.Authorization).toBe(
      "Basic " + Buffer.from("u1:p1").toString("base64"),
    );
    expect(fetchCalls[0].headers.Depth).toBe("0");
  });

  it("只给用户名不给密码时不发认证头(避免半截凭据)", async () => {
    handler = () => textResp("", 200);
    await testWebDAVConnection("http://dav.local/music", "u1");
    expect(fetchCalls[0].headers.Authorization).toBeUndefined();
  });
});

describe("scanWebDAVSource / 正常扫描", () => {
  const BASE = "http://dav.local/music";
  const FILE = "/music/a.wav";

  function happyHandler() {
    return (url: string, init: any): FakeResp => {
      if (init.method === "PROPFIND") {
        if (url.endsWith("/music/sub/")) return textResp(propfindXml([]), 207);
        return textResp(
          propfindXml([
            { href: "/music/", collection: true },
            { href: "/music/sub/", collection: true },
            { href: "/music/note.txt" },
            { href: FILE, size: WAV.length, mtime: "Wed, 01 Jan 2025 00:00:00 GMT", etag: "\"e1\"" },
          ]),
          207,
        );
      }
      return binResp(WAV, 206);
    };
  }

  it("递归遍历 + 只收音频扩展名 + 入库 1 首,进度收敛到 done", async () => {
    handler = happyHandler();
    const seen: string[] = [];
    const res = await scanWebDAVSource("w1", { url: BASE }, "full", (p) => seen.push(p.phase));

    expect(res).toMatchObject({ added: 1, updated: 0, removed: 0, skipped: 0 });
    expect(seen[0]).toBe("traverse");
    expect(seen[seen.length - 1]).toBe("done");

    const rows = sqlite.prepare("SELECT path, title, duration FROM songs WHERE path LIKE 'w:w1:%'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(`w:w1:${FILE}`);
    expect(rows[0].title).toBe("a");
    expect(rows[0].duration).toBe(1);
  });

  it("取头请求带 Range=bytes=0-262143 与 Authorization", async () => {
    handler = happyHandler();
    await scanWebDAVSource("w2", { url: BASE, username: "u", password: "p" }, "full");

    const get = fetchCalls.find((c) => c.method !== "PROPFIND")!;
    expect(get.url).toBe("http://dav.local/music/a.wav");
    expect(get.headers.Range).toBe("bytes=0-262143");
    expect(get.headers.Authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
  });

  it("二次 full 扫描 -> updated;incremental 首轮 added 并写指纹、次轮 skip", async () => {
    handler = happyHandler();
    await scanWebDAVSource("w3", { url: BASE }, "full");
    const second = await scanWebDAVSource("w3", { url: BASE }, "full");
    expect(second).toMatchObject({ added: 0, updated: 1, skipped: 0 });

    const inc1 = await scanWebDAVSource("w4", { url: BASE }, "incremental");
    expect(inc1).toMatchObject({ added: 1, updated: 0, skipped: 0 });
    const inc2 = await scanWebDAVSource("w4", { url: BASE }, "incremental");
    expect(inc2).toMatchObject({ added: 0, updated: 0, skipped: 1 });

    const row = sqlite.prepare("SELECT fingerprint FROM songs WHERE path = ?").get(`w:w4:${FILE}`) as any;
    expect(row.fingerprint).toBe(`${WAV.length}|Wed, 01 Jan 2025 00:00:00 GMT|"e1"`);
  });

  it("文件在源上消失 -> 回收歌曲行并清理孤儿", async () => {
    handler = happyHandler();
    await scanWebDAVSource("w5", { url: BASE }, "full");

    handler = (url, init) =>
      init.method === "PROPFIND" ? textResp(propfindXml([{ href: "/music/", collection: true }]), 207) : binResp(WAV, 206);
    const res = await scanWebDAVSource("w5", { url: BASE }, "full");

    expect(res).toMatchObject({ added: 0, removed: 1 });
    expect(sqlite.prepare("SELECT id FROM songs WHERE path LIKE 'w:w5:%'").all()).toHaveLength(0);
  });

  it("预先 aborted 的 signal:直接返回 aborted,不遍历不删除", async () => {
    handler = happyHandler();
    const ac = new AbortController();
    ac.abort();
    const res = await scanWebDAVSource("w6", { url: BASE }, "full", undefined, ac.signal);

    expect(res).toEqual({ added: 0, updated: 0, removed: 0, skipped: 0, aborted: true });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("scanWebDAVSource / 降级与容错", () => {
  const BASE = "http://dav.local/music";

  /**
   * [D3 回归] 本意就是「256KB 解析不完整 → 升档 1MB → 4MB」。修复前 music-metadata
   * 对截断/垃圾字节是宽容的(不抛错、只给空 common),而 extractMetadataHeader 只在
   * catch 里标 incomplete —— 升档判据永不成立,只取一次头就把标题退化成文件名。
   * 现在宽容解析路径也会标 incomplete,升档链路真正生效。
   */
  it("[D3] 头部解析不出标签 -> 升档到顶:发 3 次取头请求,再退化成文件名", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const junk = Buffer.from("this is not audio at all");
    handler = (url, init) => {
      if (init.method === "PROPFIND") {
        return textResp(propfindXml([{ href: "/music/", collection: true }, { href: "/music/bad.mp3", size: 9 }]), 207);
      }
      return binResp(junk, 206);
    };
    const res = await scanWebDAVSource("w7", { url: BASE }, "full");

    const ranges = fetchCalls.filter((c) => c.method !== "PROPFIND").map((c) => c.headers.Range);
    expect(ranges).toEqual(["bytes=0-262143", "bytes=0-1048575", "bytes=0-4194303"]);
    expect(res.added).toBe(1);
    expect((sqlite.prepare("SELECT title FROM songs WHERE path = ?").get(`w:w7:/music/bad.mp3`) as any).title).toBe("bad");
    // 升到顶仍解析不出标签 -> 必须留一条可检索的 warn(修复前此处完全静默)
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("仍解析不出标签");
  });

  /**
   * [D3 回归] .wav 天生只有 PCM 头、没有标签块,升档重取更大区间也拿不到东西,
   * 必须豁免 —— 否则每个 WAV 都要白取 3 次头,全库取头流量翻 3 倍。
   */
  it("[D3] WAV 解析不出标签**不**升档:仍只发 1 次取头请求、且不告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const junk = Buffer.from("not really a wav at all");
    handler = (url, init) => {
      if (init.method === "PROPFIND") {
        return textResp(propfindXml([{ href: "/music/", collection: true }, { href: "/music/plain.wav", size: 9 }]), 207);
      }
      return binResp(junk, 206);
    };
    const res = await scanWebDAVSource("w7b", { url: BASE }, "full");

    const ranges = fetchCalls.filter((c) => c.method !== "PROPFIND").map((c) => c.headers.Range);
    expect(ranges).toEqual(["bytes=0-262143"]);
    expect(res.added).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("音频文件下载失败(404)计入 skipped,不入库", async () => {
    handler = (url, init) => {
      if (init.method === "PROPFIND") {
        return textResp(propfindXml([{ href: "/music/", collection: true }, { href: "/music/x.wav", size: 9 }]), 207);
      }
      return textResp("nope", 404);
    };
    const res = await scanWebDAVSource("w8", { url: BASE }, "full");
    expect(res).toMatchObject({ added: 0, skipped: 1 });
    expect(sqlite.prepare("SELECT id FROM songs WHERE path LIKE 'w:w8:%'").all()).toHaveLength(0);
  });

  it("目录列举持续失败:重试到上限后放弃;零目录可达时保留测量回写、只删歌曲行", async () => {
    // 预置一首该源下的旧歌,验证「源不可达不抹回写」的 P0-6 分支
    upsertSong(
      "w:w9:/music/gone.mp3",
      {
        title: "Gone", artist: "A", album: "AL", duration: 1, bitRate: 1, genre: "", year: 0,
        track: 0, discNumber: 1, contentType: "audio/mpeg", suffix: "mp3", size: 1,
        albumArtist: "", composer: "", comment: "",
      } as any,
      "w9",
    );
    handler = () => textResp("boom", 404);

    const res = await scanWebDAVSource("w9", { url: BASE }, "full");

    expect(res).toMatchObject({ added: 0, removed: 1 });
    expect(sqlite.prepare("SELECT id FROM songs WHERE path LIKE 'w:w9:%'").all()).toHaveLength(0);
    // 目录重试上限 4 次(初次 + 3 次重排)
    expect(fetchCalls.length).toBeGreaterThanOrEqual(4);
  }, 20000);

  it("子目录不在 baseUrlPath 下时被忽略(不越界抓取兄弟目录)", async () => {
    handler = (url, init) => {
      if (init.method === "PROPFIND") {
        return textResp(
          propfindXml([
            { href: "/music/", collection: true },
            { href: "/other/", collection: true },
            { href: "/music/ok.wav", size: WAV.length },
          ]),
          207,
        );
      }
      return binResp(WAV, 206);
    };
    const res = await scanWebDAVSource("w10", { url: BASE }, "full");

    expect(res.added).toBe(1);
    const propfindUrls = fetchCalls.filter((c) => c.method === "PROPFIND").map((c) => c.url);
    expect(propfindUrls).toEqual(["http://dav.local/music/"]);
    expect(propfindUrls.some((u) => u.includes("/other/"))).toBe(false);
  });

  it("文件名含转义字符时按 URL 解码后作为 path 后缀", async () => {
    handler = (url, init) => {
      if (init.method === "PROPFIND") {
        return textResp(propfindXml([{ href: "/music/", collection: true }, { href: "/music/a%20b.wav", size: WAV.length }]), 207);
      }
      return binResp(WAV, 206);
    };
    await scanWebDAVSource("w11", { url: BASE }, "full");
    const rows = sqlite.prepare("SELECT path FROM songs WHERE path LIKE 'w:w11:%'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("w:w11:/music/a b.wav");
  });
});
