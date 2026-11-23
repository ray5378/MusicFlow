// WebDAV I/O 层单测（纯 URL/协议行为，不碰真实网络）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  wdavCtxOfConfig,
  wdavPathParts,
  wdavUrlOf,
  wdavPut,
  wdavGetRange,
  wdavGetWhole,
  wdavDelete,
  wdavSize,
  wdavTmpNameFor,
  wdavProbeTags,
  wdavList,
  wdavMoveOverwrite,
  wdavReplaceFile,
  wdavCanonicalDir,
  wdavCtxOfSource,
} from "../../src/services/fetch/wdavIO.js";

const ctx = wdavCtxOfConfig({
  url: "http://nas:5444/dav/%E5%85%B1%E4%BA%AB",
  username: "u",
  password: "p",
});

function res(body: unknown, init: { status?: number; text?: string; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => init.text ?? "",
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body ?? {})).buffer,
    headers: new Headers(init.headers ?? {}),
  } as unknown as Response;
}

describe("wdavIO — 路径与 URL", () => {
  it("wdavPathParts 拆出 sourceId 与 filePath（w:<id>:<path>）", () => {
    expect(wdavPathParts("w:src-1:/dav/共享/音乐/a.flac")).toEqual({
      sourceId: "src-1",
      filePath: "/dav/共享/音乐/a.flac",
    });
    expect(wdavPathParts("l:/music/a.flac")).toBeNull();
  });

  it("wdavUrlOf 剥掉重复的 base 路径并逐段编码", () => {
    const u = wdavUrlOf(ctx, "/dav/共享/音乐/周杰伦 - 晴天.flac");
    expect(u).toContain("/dav/");
    expect(u).not.toContain("/dav/dav/");
    expect(u).toContain(encodeURIComponent("周杰伦 - 晴天.flac"));
  });

  it("wdavTmpNameFor 每次生成不同临时名（覆盖同名隐藏文件会被网关 405）", () => {
    const a = wdavTmpNameFor("/dir/x.flac", "sid");
    const b = wdavTmpNameFor("/dir/x.flac", "sid");
    expect(a).not.toBe(b);
    expect(a.startsWith("/dir/.mf-up-sid-")).toBe(true);
    expect(a.endsWith("-x.flac")).toBe(true);
  });
});

describe("wdavIO — 读写", () => {
  const orig = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("PUT 成功返回状态码，失败抛错（含状态码）", async () => {
    globalThis.fetch = vi.fn(async () => res({}, { status: 201 })) as never;
    await expect(wdavPut(ctx, "/d/a.bin", Buffer.alloc(4))).resolves.toBe(201);

    globalThis.fetch = vi.fn(async () => res({}, { status: 405 })) as never;
    await expect(wdavPut(ctx, "/d/a.bin", Buffer.alloc(4))).rejects.toThrow(/405/);
  });

  it("GET Range 返回 Buffer；整文件读取走同一路径", async () => {
    globalThis.fetch = vi.fn(async () => res(null)) as never;
    const r = await wdavGetRange(ctx, "/d/a.bin", 0, 99);
    expect(Buffer.isBuffer(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
    await expect(wdavGetWhole(ctx, "/d/a.bin")).resolves.toBeInstanceOf(Buffer);
  });

  it("DELETE 成功不返回内容；404 视作已不存在不抛", async () => {
    globalThis.fetch = vi.fn(async () => res({}, { status: 204 })) as never;
    await expect(wdavDelete(ctx, "/d/a.bin")).resolves.toBeUndefined();
    globalThis.fetch = vi.fn(async () => res({}, { status: 404 })) as never;
    await expect(wdavDelete(ctx, "/d/a.bin")).resolves.toBeUndefined();
  });

  it("wdavSize 读 content-length；失败返回 null", async () => {
    globalThis.fetch = vi.fn(async () => res({}, { status: 200, headers: { "content-length": "1234" } })) as never;
    await expect(wdavSize(ctx, "/d/a.bin")).resolves.toBe(1234);

    globalThis.fetch = vi.fn(async () => res({}, { status: 500 })) as never;
    await expect(wdavSize(ctx, "/d/a.bin")).resolves.toBeNull();
  });

  it("wdavProbeTags 用 Range 只取头部（不整文件）", async () => {
    const spy = vi.fn(async () => res(null));
    globalThis.fetch = spy as never;
    const head = await wdavProbeTags(ctx, "/d/a.flac", "flac");
    expect(Buffer.isBuffer(head)).toBe(true);
    const headers = (spy.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(String(headers.headers.Range)).toMatch(/^bytes=0-/);
  });
});

describe("wdavIO — 列表/替换/移动", () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("wdavList 解析 PROPFIND 的 href，并隐藏 . 开头的临时文件", async () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/%E9%9F%B3%E4%B9%90/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      <D:response><D:href>/dav/%E9%9F%B3%E4%B9%90/a.flac</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>123</D:getcontentlength></D:prop></D:propstat></D:response>
      <D:response><D:href>/dav/%E9%9F%B3%E4%B9%90/.mf-up-x.flac</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response>
    </D:multistatus>`;
    globalThis.fetch = vi.fn(async () => res({}, { status: 207, text: xml })) as never;
    const entries = await wdavList(ctx, "/dav/音乐");
    const names = entries.map((e) => e.name);
    expect(names).toContain("a.flac");
    expect(names.some((n) => n.startsWith(".mf-up"))).toBe(false);
  });

  it("wdavReplaceFile：目标已存在且 MOVE 失败时，走删后改名", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${String(url).split("/").pop()}`);
      if (init.method === "MOVE") return res({}, { status: 500 });
      return res({}, { status: 204 });
    }) as never;
    await wdavReplaceFile(ctx, "/d/.mf-up-a.flac", "/d/a.flac", Buffer.from("x"));
    expect(calls.some((c) => c.startsWith("MOVE"))).toBe(true);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(true);
  });

  it("wdavCanonicalDir 归一尾斜杠（保留源 base 前缀）", () => {
    const withSlash = wdavCanonicalDir(ctx, "/音乐/");
    expect(withSlash.endsWith("/音乐")).toBe(true);
    expect(withSlash.endsWith("//")).toBe(false);
    expect(wdavCanonicalDir(ctx, "/")).toBeTruthy();
  });

  it("wdavCtxOfSource 未配置的源返回 null", () => {
    expect(wdavCtxOfSource("不存在的源")).toBeNull();
  });
});

describe("wdavIO — 移动与探测失败", () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("wdavMoveOverwrite 发 MOVE 且带 Overwrite: T", async () => {
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([String(url), init]);
      return res({}, { status: 201 });
    }) as never;
    await wdavMoveOverwrite(ctx, "/d/tmp.flac", "/d/a.flac");
    const method = String(calls[0][1].method);
    const headers = calls[0][1].headers as Record<string, string>;
    expect(method).toBe("MOVE");
    expect(headers.Overwrite || headers.overwrite || "").toContain("T");
  });

  it("wdavProbeTags 非 2xx ⇒ 抛错（调用方按读头失败处理）", async () => {
    globalThis.fetch = vi.fn(async () => res({}, { status: 404 })) as never;
    await expect(wdavProbeTags(ctx, "/d/a.flac", "flac")).rejects.toThrow();
  });
});
