// server.ts 覆盖率补口(网络面):listen 失败收口 + libFLAC 预热失败告警 + 拨号激活超时。
//
// 这三处都必须真起/真连一个本地 socket 才能触发(它们就在"网络失败"这条路上):
//   1) listen() 绑定失败(端口被占)→ 必须把 listening 置空后**重新抛出**。不置空的话
//      后续每一次重试都会直接返回那个已失败的 promise —— 端口释放了也永远起不来;
//   2) libFLAC 预热超时 → 必须**显式告警**(flac 不可用但 opus/pcm 照常),不许静默降级;
//   3) dialPlayer 对端**接受了 TCP 但从不激活** → 必须在超时后 terminate + 抛
//      "activation timeout",否则重拨状态机永远卡在一个假在飞的连接上。
//
// 端口固定选高位(39xxx),并在 afterEach 关掉,避免与其它套件抢端口。
import "../plugins/_env.js";

import { describe, it, expect, vi, afterEach } from "vitest";

// 只覆写 waitFlacEncoderReady:构造"预热失败"这一平台故障态,其余编码器 API 保持真实。
vi.mock("../../src/services/sendspin/encoding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/sendspin/encoding.js")>();
  return { ...actual, waitFlacEncoderReady: async () => false };
});

import { makeServer, logsContain } from "./_connStubs.js";

const LIVE: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const s of LIVE.splice(0)) {
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
});

describe("server.listen 网络失败收口", () => {
  it("端口被占用 → reject 且 listening 复位(端口释放后可以重试)", async () => {
    const a = makeServer();
    LIVE.push(a.srv);
    await a.srv.listen(39271);
    expect(logsContain(a.logs, "listening ws://")).toBe(true);

    const b = makeServer();
    LIVE.push(b.srv);
    // 契约:同一端口二次绑定必须失败得干净(EADDRINUSE 不能变成未处理异常)。
    await expect(b.srv.listen(39271)).rejects.toBeTruthy();
    // 契约:失败后 listening 必须复位 —— 否则"重试"只会拿到同一个已 reject 的 promise。
    expect((b.srv as any).listening).toBeNull();
  });

  it("libFLAC 预热超时 → 打告警但仍继续监听(opus/pcm 不受影响)", async () => {
    const a = makeServer();
    LIVE.push(a.srv);
    // 契约:flac 不可用必须明说;静默降级会让"选了 flac 却全程无声"无从排障。
    await a.srv.listen(39272);
    expect(logsContain(a.logs, "libFLAC 预热超时")).toBe(true);
    expect(logsContain(a.logs, "listening ws://")).toBe(true);
  });
});

describe("server.dialPlayer 激活超时", () => {
  it("对端接受连接但从不激活 → 超时 terminate + 抛 activation timeout", async () => {
    const a = makeServer();
    LIVE.push(a.srv);
    await a.srv.listen(39273);

    const b = makeServer();
    LIVE.push(b.srv);
    // 150ms 超时:短到不拖慢套件,又足够让 TCP 建连成功(触发"在但不应答"这一支)。
    await expect(
      b.srv.dialPlayer("ws://127.0.0.1:39273/sendspin", 150),
    ).rejects.toThrow("activation timeout");
    // 契约:超时后单飞表必须被清理(否则同目标后续重拨会被当成"已有在飞")。
    expect((b.srv as any).pendingDials.size).toBe(0);
  });
});
