// resolveRowInput:sendspin 流式窗口的输入解析(与 fetchRowBytes 同构,只给 ffmpeg
// 直读的「文件/URL＋头」,不读字节)。
//
// 为何单独测:流式解码(stream_source)默认开启后,网络曲源不再经 fetch 取字节,
// 而是把 URL 直接交给 ffmpeg 子进程 —— 源鉴权(WebDAV Basic)必须靠这里的
// `headers` 转成 ffmpeg `-headers` 才不丢。取字节路径由 pumpFallback 覆盖,
// 本文件补流式输入解析,两者分支必须一一对应(改一处须对另一处)。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sqlite } from "../../src/db/index.js";
import { resolveRowInput } from "../../src/services/source/resolveAudio.js";
import type { SongRow } from "../../src/services/source/resolveAudio.js";

/** 构造最小行(只填被读取的字段)。 */
const row = (o: Record<string, unknown>): SongRow => o as unknown as SongRow;

describe("resolveRowInput(流式窗口输入解析)", () => {
  let tmpDir: string;
  let cacheFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rowinput-"));
    cacheFile = path.join(tmpDir, "cached.wav");
    fs.writeFileSync(cacheFile, Buffer.from("RIFF0000WAVE"));
    sqlite
      .prepare(
        "INSERT INTO media_sources (id, name, type, config) VALUES " +
          "('davsrc','dav','webdav','{\"url\":\"http://127.0.0.1:18777/dav\",\"username\":\"u\",\"password\":\"p\"}')," +
          "('davnoauth','dav2','webdav','{\"url\":\"http://127.0.0.1:18777/pub\"}') " +
          "ON CONFLICT(id) DO NOTHING",
      )
      .run();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("web 行:url + stream_headers 原样透传", () => {
    const r = resolveRowInput(
      row({ type: "web", url: "http://h/a.mp3", stream_headers: '{"Referer":"http://h/"}' }),
    );
    expect(r).toEqual({ input: "http://h/a.mp3", headers: { Referer: "http://h/" } });
  });

  it("web 行:stream_headers 非法 JSON 时按空头处理", () => {
    const r = resolveRowInput(row({ type: "web", url: "http://h/a.mp3", stream_headers: "{oops" }));
    expect(r).toEqual({ input: "http://h/a.mp3", headers: {} });
  });

  it("web 行:cachePath 存在时优先于 url(且不带头)", () => {
    const r = resolveRowInput(row({ type: "web", url: "http://h/a.mp3", cachePath: cacheFile }));
    expect(r).toEqual({ input: cacheFile });
  });

  it("web 行:cachePath 不存在时回退 url", () => {
    const r = resolveRowInput(
      row({ type: "web", url: "http://h/a.mp3", cachePath: path.join(tmpDir, "nope.wav") }),
    );
    expect(r).toEqual({ input: "http://h/a.mp3", headers: {} });
  });

  it("web 行:无 url 且无 cachePath → null", () => {
    expect(resolveRowInput(row({ type: "web", url: "" }))).toBeNull();
  });

  it("本地行:l: 前缀直取文件路径", () => {
    const r = resolveRowInput(row({ type: "local", path: `l:src:${cacheFile}` }));
    expect(r).toEqual({ input: cacheFile });
  });

  it("WebDAV 行:拼 origin+filePath 并带 Basic 源鉴权头", () => {
    const r = resolveRowInput(row({ type: "local", path: "w:davsrc:/dav/t.wav" }));
    expect(r).toEqual({
      input: "http://127.0.0.1:18777/dav/t.wav",
      headers: { Authorization: "Basic " + Buffer.from("u:p").toString("base64") },
    });
  });

  it("WebDAV 行:源无凭据时不带 Authorization(仍给空头对象)", () => {
    const r = resolveRowInput(row({ type: "local", path: "w:davnoauth:/x.mp3" }));
    expect(r).toEqual({ input: "http://127.0.0.1:18777/x.mp3", headers: {} });
  });

  it("WebDAV 行:媒体源不存在 → null", () => {
    expect(resolveRowInput(row({ type: "local", path: "w:ghost:/x.mp3" }))).toBeNull();
  });

  it("路径解析不出 → null(与 probeLocalSourceOk 的宽容语义区分)", () => {
    expect(resolveRowInput(row({ type: "local", path: "no-colon-here" }))).toBeNull();
  });

  it("空行 → null", () => {
    expect(resolveRowInput(null as unknown as SongRow)).toBeNull();
  });
});
