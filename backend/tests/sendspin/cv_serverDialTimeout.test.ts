// server.ts 覆盖率补口(dial 阶段一:建连收口)。
//
// 目标行:src/services/sendspin/server.ts 271-280(dialPlayerInner 的建连 Promise)
//   - 271-272:等 open 的 setTimeout 到点 → ws.terminate() + reject("dial timeout");
//   - 278-280:ws 'error' → clearTimeout + 原样 reject(Error)。
//
// 手法沿用 lt1_serverListenDialGaps.test.ts 的 dial 桩 —— 真起本地 TCP:
//   1) 超时支:对端 accept 后**永不回 HTTP upgrade** → ws 'open' 永不触发 → 短超时到点;
//   2) 失败支:先起再关一个端口 → ECONNREFUSED → 走 'error' 支(不等满超时)。
//
// 注:用真实短超时(300ms)而非 fake timers —— ws/net 的建连计时走全局定时器,
// 整体 fake 会把 libuv 建连过程一并冻结;既有 lt1 dial 测试即用真实 150ms,同口径。
import "../plugins/_env.js";

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { makeServer } from "./_connStubs.js";

const LIVE: Array<{ stop: () => void }> = [];
const TCP: net.Server[] = [];

afterEach(() => {
  for (const s of LIVE.splice(0)) {
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
  for (const s of TCP.splice(0)) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
});

/** 起一个 127.0.0.1 随机高位端口的原始 TCP 服务。handler 缺省 = accept 后挂住不回。 */
function listenRaw(handler?: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((socket) => {
      socket.on("error", () => {}); // 客户端 terminate 触发的 ECONNRESET 不许冒泡
      handler?.(socket);
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

describe("dialPlayer 建连阶段收口", () => {
  it("对端 accept 后不回 upgrade → 到点 terminate + reject dial timeout,单飞表清空", async () => {
    const hold = await listenRaw(); // 永不写回 → 'open' 永不触发
    TCP.push(hold);
    const port = (hold.address() as net.AddressInfo).port;
    const b = makeServer();
    LIVE.push(b.srv);
    await expect(
      b.srv.dialPlayer(`ws://127.0.0.1:${port}/sendspin`, 300),
    ).rejects.toThrow("dial timeout");
    // 契约:失败后单飞表必须清空 —— 否则同目标重拨被误判成"已有在飞"。
    expect((b.srv as any).pendingDials.size).toBe(0);
  });

  it("目标端口拒绝连接(ECONNREFUSED)→ clearTimeout + 立即 reject,不等满超时", async () => {
    const dead = await listenRaw();
    const port = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    TCP.push(dead); // 已 close;afterEach 再 close 一次会抛 ERR_SERVER_NOT_RUNNING,已被 try/catch 吞掉
    const b = makeServer();
    LIVE.push(b.srv);
    const t0 = Date.now();
    await expect(
      b.srv.dialPlayer(`ws://127.0.0.1:${port}/sendspin`, 5000),
    ).rejects.toThrow(/ECONNREFUSED/);
    // 走的是 'error' 支(计时器被清),不是挂满 5s 超时。
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((b.srv as any).pendingDials.size).toBe(0);
  });
});
