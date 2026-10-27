// 上游截断对账单测(2026-10-27,《纵身一跃》事故防线,G15):
// 响应头 content-length 与实收字节不一致时,fetchWholeSongBuffered 不得以 ok:true
// 交回残缺 Buffer —— 上游提前 EOF(连接被代理/源中途掐断)必须显式失败(stalled),
// 走重试/换源路径,判官与负缓存才能拿到「坏源」的硬证据。
// 240 实测:汽水 VIP 源答应 972KB 实收 <64KB,旧代码当成功 → 判官只能按 too-small
// 弱信号放行 → 播 60s 断一次,每次重蹈。
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWholeSongBuffered } from "../../src/services/source/bufferedFetch.js";

const CFG = { retries: 0, stallMs: 5_000, deadlineMs: 10_000 } as const;

function stubFetch(body: Buffer, headers: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(body), { status: 200, headers })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWholeSongBuffered 上游截断对账(G15)", () => {
  it("实收 < content-length×90% ⇒ ok:false kind=stalled(err=upstream truncated)", async () => {
    stubFetch(Buffer.alloc(1_000, 0x1f), {
      "content-type": "audio/mpeg",
      "content-length": String(100_000),
    });
    const r = await fetchWholeSongBuffered("http://upstream/song.mp3", {}, CFG);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("stalled");
      expect(r.err || "").toContain("upstream truncated");
      expect(r.err || "").toContain("content-length=100000");
      expect(r.err || "").toContain("received=1000");
    }
  });

  it("实收 ≥ content-length×90% ⇒ ok:true(容差内不误杀,打包差异不拦真音频)", async () => {
    stubFetch(Buffer.alloc(95_000, 0x1f), {
      "content-type": "audio/mpeg",
      "content-length": String(100_000),
    });
    const r = await fetchWholeSongBuffered("http://upstream/song.mp3", {}, CFG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes).toBe(95_000);
  });

  it("无 content-length(chunked)不对账 ⇒ 语义不变 ok:true,完整性交给判官硬下界", async () => {
    stubFetch(Buffer.alloc(1_000, 0x1f), { "content-type": "audio/mpeg" });
    const r = await fetchWholeSongBuffered("http://upstream/song.mp3", {}, CFG);
    expect(r.ok).toBe(true);
  });
});
