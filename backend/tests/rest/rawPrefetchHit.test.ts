// raw 回环取源命中预取 membuf 的回归锁(2026-11-18)
//
// 背景:sendspin 泵跑在 fork 子进程,`streamingSource → loopbackRawStreamUrl` 生成的
// 回环 URL 由**主进程** `/rest/dlna/stream/:token?raw=1` 处理,过去一律走
// `proxyRawRange` 回源。天翼网盘 FLAC 实测回源 6.4s ⇒ AirPlay 桥补 1.555s 静音
// (`realigned insert=68589`) + `pacing rebase(lag)` 把落后永久固化(240 实测
// deltaUs +2.06s → -0.16s、inQueueMs 1.7s → 3.8s)。
// 修法:回环 URL 追加 `sid`(预取命中提示),raw 分支按 sid 现查主进程 prefetchCache
// 的 membuf;命中则整曲字节内存直出,未命中回退 proxyRawRange(行为与改前一致)。
//
// 本文件钉三件事(顺序锁,不是"存在即可"):
//   ① 带 songId 时 URL 出现 `&sid=`(百分号编码);不带时与旧实现逐字节一致;
//   ② 命中检查必须**在 proxyRawRange 之前**,且必须落在 resolveCastSession 之前
//      (P2-6 结构锁只从 cast 分支之后开始扫);
//   ③ 两条消费路径共用 serveMemStreamResponse(Accept-Ranges 只定义一次)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC_DIR, rel), "utf8");

describe("raw 回环取源:预取命中提示(sid)契约", () => {
  it("带 songId ⇒ 追加 &sid= 且百分号编码;token 仍可回解原 url", async () => {
    const { loopbackRawStreamUrl, resolveRawStreamToken } = await import(
      "../../src/services/dlna/control.js"
    );
    const url = loopbackRawStreamUrl("https://cdn.example.com/a.flac", { A: "b" }, "song/id 1");
    expect(url).toContain("?raw=1&sid=song%2Fid%201");
    const token = url.split("/rest/dlna/stream/")[1].split("?")[0];
    const back = resolveRawStreamToken(token);
    expect(back?.url).toBe("https://cdn.example.com/a.flac");
    expect(back?.headers).toEqual({ A: "b" });
  });

  it("不带 songId ⇒ URL 与旧实现逐字节一致(不出现 sid)", async () => {
    const { loopbackRawStreamUrl } = await import("../../src/services/dlna/control.js");
    const url = loopbackRawStreamUrl("https://cdn.example.com/a.flac");
    expect(url).not.toContain("sid=");
    expect(url).toMatch(/\/rest\/dlna\/stream\/[0-9a-f]{32}\?raw=1$/);
  });

  it("空字符串 songId 视为未提供(不产生悬空 sid=)", async () => {
    const { loopbackRawStreamUrl } = await import("../../src/services/dlna/control.js");
    const url = loopbackRawStreamUrl("https://cdn.example.com/a.flac", {}, "");
    expect(url).not.toContain("sid=");
  });
});

describe("raw 分支顺序锁:命中检查必须在回源之前", () => {
  const src = readSrc("routes/rest/index.ts");
  const seg = src.slice(
    src.indexOf('restRoutes.get("/dlna/stream/:token"'),
    src.indexOf('restRoutes.get("/download"'),
  );

  it("raw 分支内出现 resolveRawStreamToken + prefetchToken(sid)", () => {
    expect(seg).toContain("resolveRawStreamToken(token)");
    expect(seg).toContain("prefetchToken(sid)");
  });

  it("命中出流(serveMemStreamResponse)出现在 proxyRawRange 之前", () => {
    const hitAt = seg.indexOf("serveMemStreamResponse(c, memEntry)");
    const proxyAt = seg.indexOf("proxyRawRange(");
    expect(hitAt).toBeGreaterThanOrEqual(0);
    expect(proxyAt).toBeGreaterThanOrEqual(0);
    expect(hitAt).toBeLessThan(proxyAt);
  });

  it("命中检查落在 resolveCastSession 之前(不碰 cast 分支的干净性锁)", () => {
    const hitAt = seg.indexOf("prefetchToken(sid)");
    const castAt = seg.indexOf("resolveCastSession(token)");
    expect(hitAt).toBeGreaterThanOrEqual(0);
    expect(castAt).toBeGreaterThan(hitAt);
  });

  it("命中失败必须能落到回源分支(不是提前 return null)", () => {
    // memEntry 为空时不能 return,控制流要继续到 proxyRawRange
    expect(seg).toContain("if (memEntry) {");
  });
});

describe("membuf 出流单一真源", () => {
  it("/rest/membuf 与 raw 命中共用 serveMemStreamResponse", () => {
    const src = readSrc("routes/rest/index.ts");
    const membufSeg = src.slice(
      src.indexOf('restRoutes.get("/membuf/:token"'),
      src.indexOf("// ==================== SMB 回环出流"),
    );
    expect(membufSeg).toContain("serveMemStreamResponse(c, entry)");
    // 响应头只保留在共享函数里一处(路由体不再自建响应;注释里提到该字样不算)
    expect(membufSeg.match(/"Accept-Ranges": "bytes"/g)?.length).toBe(1);
    expect(membufSeg).toContain("async function serveMemStreamResponse(");
  });
});
