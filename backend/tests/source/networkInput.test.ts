// 出流「源解析」的共享推导(services/source/networkInput.ts)回归守卫。
//
// 存在意义(2026-10-12 预缓冲改造):`resolveTranscodeInput` 原本是 routes/rest/index.ts 的
// 模块私有函数,后台预取在别的模块拿不到它的 URL 推导。现在两边共用同一份,这份测试守的
// 就是那份「共用」:
//   - 分支映射与抽离前逐条一致(web / w: / l: / 空直链 / 缺 media_source);
//   - `resolveLocalFilePath` 与 `resolveNetworkInput` **互斥**(对同一行最多一个非 null)
//     —— 出流侧正是靠「先本地、再网络」这条顺序判定,两者一旦同时非 null 或同时为 null,
//     出流的分支语义就变了。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqlite } from "../../src/db/index.js";
import {
  getWebDAVUrl,
  isNetworkSong,
  resolveLocalFilePath,
  resolveNetworkInput,
} from "../../src/services/source/networkInput.js";

// 空直链 web 行的兜底解析(内部动态 import):固定成一个可断言的 URL,不碰真实插件/网络。
vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  resolveEmptyUrlStream: vi.fn(async () => "http://resolved.example/empty.mp3"),
}));

const DAV_ORIGIN = "http://127.0.0.1:18777";

/** 天翼网盘那类行的库内形态:type=local + path 前缀 `w:`。 */
const L_ROW = { id: "ni-l", type: "local", path: "l:localdisk:/MUSIC/a.flac" };
const W_ROW = { id: "ni-w", type: "local", path: "w:davsrc:/dav/共享/a.flac" };
const W_NO_SRC = { id: "ni-w2", type: "local", path: "w:nosuchsrc:/dav/a.flac" };
const BAD_PATH = { id: "ni-bad", type: "local", path: "nocolonhere" };
const WEB_ROW = {
  id: "ni-web",
  type: "web",
  path: "web:plugin:x",
  url: "http://up.example/1.mp3",
  streamHeaders: '{"Referer":"http://ref.example/"}',
};
const WEB_EMPTY_URL = { id: "ni-webe", type: "web", path: "web:plugin:x", url: "" };
let WEB_CACHE_ROW: Record<string, unknown>;
let tmpFile = "";

const ALL: Array<Record<string, unknown>> = [];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netinput-"));
  tmpFile = path.join(dir, "cached.flac");
  fs.writeFileSync(tmpFile, Buffer.from("fLaC0000"));
  WEB_CACHE_ROW = {
    id: "ni-webc",
    type: "web",
    path: "web:plugin:x",
    url: "http://up.example/2.mp3",
    cachePath: tmpFile,
  };
  ALL.push(L_ROW, W_ROW, W_NO_SRC, BAD_PATH, WEB_ROW, WEB_EMPTY_URL, WEB_CACHE_ROW);

  sqlite
    .prepare(
      "INSERT INTO media_sources (id, name, type, config) VALUES (?,?,?,?) " +
        "ON CONFLICT(id) DO NOTHING",
    )
    .run(
      "davsrc",
      "dav",
      "webdav",
      JSON.stringify({ url: DAV_ORIGIN + "/dav", username: "u", password: "p" }),
    );
  // 无鉴权的 WebDAV 源:不该凭空冒出 Authorization 头。
  sqlite
    .prepare(
      "INSERT INTO media_sources (id, name, type, config) VALUES (?,?,?,?) " +
        "ON CONFLICT(id) DO NOTHING",
    )
    .run("davnoauth", "dav2", "webdav", JSON.stringify({ url: DAV_ORIGIN + "/pub" }));
});

afterAll(() => {
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("networkInput:本地直读 vs 网络源(出流与预取共用)", () => {
  it("l: 本地磁盘行 → 本地直读路径,不是网络源", async () => {
    expect(await resolveLocalFilePath(L_ROW)).toBe("/MUSIC/a.flac");
    expect(await resolveNetworkInput(L_ROW)).toBeNull();
    expect(await isNetworkSong(L_ROW)).toBe(false);
  });

  it("w: WebDAV 行 → 网络源,url = origin+相对路径,带 Basic 鉴权头", async () => {
    const net = await resolveNetworkInput(W_ROW);
    expect(net).not.toBeNull();
    expect(net!.url).toBe(DAV_ORIGIN + "/dav/共享/a.flac");
    expect(net!.headers).toEqual({
      Authorization: "Basic " + Buffer.from("u:p").toString("base64"),
    });
    expect(await resolveLocalFilePath(W_ROW)).toBeNull();
    expect(await isNetworkSong(W_ROW)).toBe(true);
  });

  it("w: 行但 media_sources 里没有该源 → 无可用源(null)", async () => {
    expect(await resolveNetworkInput(W_NO_SRC)).toBeNull();
    expect(await resolveLocalFilePath(W_NO_SRC)).toBeNull();
  });

  it("无鉴权 WebDAV 源:不产出 Authorization 头", async () => {
    const net = await resolveNetworkInput({ id: "x", type: "local", path: "w:davnoauth:/dav/a.flac" });
    expect(net!.url).toBe(DAV_ORIGIN + "/dav/a.flac");
    expect(net!.headers).toEqual({});
  });

  it("web 行 → 直链 + streamHeaders 解析出的请求头", async () => {
    const net = await resolveNetworkInput(WEB_ROW);
    expect(net).toEqual({
      url: "http://up.example/1.mp3",
      headers: { Referer: "http://ref.example/" },
    });
    expect(await resolveLocalFilePath(WEB_ROW)).toBeNull();
    expect(await isNetworkSong(WEB_ROW)).toBe(true);
  });

  it("web 行已缓存到本地且文件在盘 → 本地直读,不是网络源", async () => {
    expect(await resolveLocalFilePath(WEB_CACHE_ROW)).toBe(tmpFile);
    expect(await resolveNetworkInput(WEB_CACHE_ROW)).toBeNull();
    expect(await isNetworkSong(WEB_CACHE_ROW)).toBe(false);
  });

  it("web 行有 cachePath 但文件已不在 → 回落到网络直链(不误判为本地)", async () => {
    const gone = { id: "ni-webg", type: "web", path: "web:plugin:x", url: "http://up.example/3.mp3", cachePath: "/definitely/not/here.flac" };
    expect(await resolveLocalFilePath(gone)).toBeNull();
    expect(await resolveNetworkInput(gone)).toEqual({ url: "http://up.example/3.mp3", headers: {} });
  });

  it("空直链 web 行 → 走 resolveEmptyUrlStream 兜底解析", async () => {
    const net = await resolveNetworkInput(WEB_EMPTY_URL);
    expect(net).toEqual({ url: "http://resolved.example/empty.mp3", headers: {} });
  });

  it("path 解析不出(sourceId 缺失)→ 两边都 null(与抽离前一致:出流 return null)", async () => {
    expect(await resolveLocalFilePath(BAD_PATH)).toBeNull();
    expect(await resolveNetworkInput(BAD_PATH)).toBeNull();
  });

  it("互斥性:对任意一行,本地直读与网络源最多一个非 null", async () => {
    for (const row of ALL) {
      const local = await resolveLocalFilePath(row);
      const net = await resolveNetworkInput(row);
      expect(
        !(local && net),
        `行 ${String(row.id)} 同时给出本地路径(${String(local)})与网络源(${net?.url}) —— 出流分支语义被破坏`,
      ).toBe(true);
    }
  });

  it("getWebDAVUrl:只取 origin(源 url 上的子路径不参与拼接)", () => {
    expect(getWebDAVUrl({ url: "http://h:8080/dav/sub" }, "/dav/a.flac")).toBe("http://h:8080/dav/a.flac");
  });
});
