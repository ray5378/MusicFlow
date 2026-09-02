import { describe, it, expect, vi } from "vitest";
import { probeWebDAV } from "../../src/utils/localSourceProbe.js";

/** 构造最小 Response(只保留 status)。 */
function res(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe("probeWebDAV", () => {
  it("HEAD 200 即可用(快路径,不发 GET)", async () => {
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      expect(init.method).toBe("HEAD");
      return res(200);
    });
    expect(await probeWebDAV(fetchImpl as any, "http://x/file.flac", {})).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("HEAD 206 即可用", async () => {
    const fetchImpl = vi.fn(async (_u: any, init: any) => res(init.method === "HEAD" ? 206 : 200));
    expect(await probeWebDAV(fetchImpl as any, "http://x/file.flac", {})).toBe(true);
  });

  it("HEAD 403(网关不认 HEAD 直链签名) + GET Range 206 → 可用(核心回归场景)", async () => {
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      if (init.method === "HEAD") return res(403);
      expect(init.headers.Range).toBe("bytes=0-0");
      return res(206);
    });
    expect(await probeWebDAV(fetchImpl as any, "http://x/file.flac", { Authorization: "Basic x" })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("HEAD 网络异常 + GET 206 → 可用", async () => {
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      if (init.method === "HEAD") throw new Error("network down");
      return res(206);
    });
    expect(await probeWebDAV(fetchImpl as any, "http://x/file.flac", {})).toBe(true);
  });

  it("HEAD 403 + GET 404 → 不可用(真缺失)", async () => {
    const fetchImpl = vi.fn(async (_u: any, init: any) => res(init.method === "HEAD" ? 403 : 404));
    expect(await probeWebDAV(fetchImpl as any, "http://x/missing.flac", {})).toBe(false);
  });

  it("HEAD 与 GET 双双网络异常 → 不可用", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("unreachable"); });
    expect(await probeWebDAV(fetchImpl as any, "http://x/file.flac", {})).toBe(false);
  });
});
