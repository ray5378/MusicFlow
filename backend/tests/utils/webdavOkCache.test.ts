// WebDAV 可播「成功记忆」(F 项)回归。
// 覆盖:命中零往返 / 过期重探 / 出流失败逐出 / 失败不写成功记忆 / 本地分支不参与。
// 每条用例用独立 songId —— 成功/失败记忆是模块级 Map,跨用例会互相污染。
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqlite } from "../../src/db/index.js";
import { probeLocalSourceOk, evictProbeOk } from "../../src/utils/localSourceProbe.js";

const SRC = "src-f-ok-1";

function res(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

/** 每次探测固定返回 HEAD 200(快路径,一次 fetch 即可用)。 */
function stubOk() {
  return vi.fn(async (_u: any, _init: any) => res(200));
}

describe("WebDAV 可播成功记忆(F 项)", () => {
  beforeAll(() => {
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO media_sources (id, name, type, enabled, config) VALUES (?,?,?,?,?)",
      )
      .run(
        SRC,
        "probe-src",
        "webdav",
        1,
        JSON.stringify({ url: "http://dav.local/dav", username: "u", password: "p" }),
      );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("首次未命中 → 探测一次;再次请求命中成功记忆 → 零往返", async () => {
    const fetchImpl = stubOk();
    vi.stubGlobal("fetch", fetchImpl);
    const song = { id: "f-ok-hit", path: `w:${SRC}:/a.flac` };

    expect(await probeLocalSourceOk(song)).toBe(true);
    const after1 = fetchImpl.mock.calls.length;
    expect(after1).toBeGreaterThan(0);

    expect(await probeLocalSourceOk(song)).toBe(true);
    expect(await probeLocalSourceOk(song)).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(after1); // 命中:不再打网盘
  });

  it("超过 TTL → 重新探测(记忆不会永久粘住)", async () => {
    const fetchImpl = stubOk();
    vi.stubGlobal("fetch", fetchImpl);
    const song = { id: "f-ok-expire", path: `w:${SRC}:/b.flac` };

    expect(await probeLocalSourceOk(song)).toBe(true);
    const after1 = fetchImpl.mock.calls.length;

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    expect(await probeLocalSourceOk(song)).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(after1);
    nowSpy.mockRestore();
  });

  it("evictProbeOk 逐出后 → 下次重新探测(出流失败走这条)", async () => {
    const fetchImpl = stubOk();
    vi.stubGlobal("fetch", fetchImpl);
    const song = { id: "f-ok-evict", path: `w:${SRC}:/c.flac` };

    expect(await probeLocalSourceOk(song)).toBe(true);
    const after1 = fetchImpl.mock.calls.length;
    expect(await probeLocalSourceOk(song)).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(after1);

    evictProbeOk(song.id);
    expect(await probeLocalSourceOk(song)).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(after1);
  });

  it("探测失败 → 不写成功记忆,且写失败记忆(后续沿用失败结论、不再重探)", async () => {
    const fetchImpl = vi.fn(async (_u: any, _init: any) => res(404));
    vi.stubGlobal("fetch", fetchImpl);
    const song = { id: "f-ok-fail", path: `w:${SRC}:/missing.flac` };

    expect(await probeLocalSourceOk(song)).toBe(false);
    const after1 = fetchImpl.mock.calls.length;

    expect(await probeLocalSourceOk(song)).toBe(false);
    expect(fetchImpl.mock.calls.length).toBe(after1); // 失败记忆生效,未重探

    // 失败记忆未过期时,即便显式逐出成功记忆也不该变成「可播」。
    evictProbeOk(song.id);
    expect(await probeLocalSourceOk(song)).toBe(false);
  });

  it("本地 l: 分支不写成功记忆(文件删除后立刻重新判定,不粘住旧结论)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-ok-"));
    const file = path.join(dir, "t.flac");
    fs.writeFileSync(file, "x");
    const song = { id: "f-ok-local", path: `l:${SRC}:${file}` };

    expect(await probeLocalSourceOk(song)).toBe(true);
    fs.unlinkSync(file);
    // 若成功记忆误覆盖本地分支,这里会错返回 true(死行)。
    expect(await probeLocalSourceOk(song)).toBe(false);
  });
});
