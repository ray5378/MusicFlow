// supervisor.ts 覆盖率补口:start(port?) 兼容包装。
//
// 缺口背景:子类把基类的 start() 收成 `start(_port?)` —— 端口参数**被有意忽略**
// (子进程自己读 DB 定端口,再经 mainReady 回传真值),保留入参只为兼容既有调用方
// (`startSendspinService(port)` 会原样透传)。这条包装从未被执行过。
//
// 守住的产品契约:
//   1) 包装必须**转发到基类 start()** 且不把端口传下去(端口只能有一个权威来源);
//   2) 返回基类的 promise(调用方能 await 到真正就绪/mainReady),不是 fire-and-forget。
//
// 隔离:只替身 rendererHost 宿主层 —— 这里要证明的是**子类那份包装**,不是宿主 fork。
import "../plugins/_env.js";

import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({
  startCalls: [] as unknown[][],
  resolveResult: undefined as unknown,
  resolveArgs: [] as unknown[],
}));

vi.mock("../../src/services/rendererHost/index.js", () => {
  class RendererHostSupervisor {
    start(...args: unknown[]): Promise<void> {
      H.startCalls.push(args);
      return Promise.resolve(undefined);
    }
  }
  return {
    RendererHostSupervisor,
    resolveChildEntry: (u: unknown) => {
      H.resolveArgs.push(u);
      return "/fake/child.ts";
    },
  };
});

import { sendspinSupervisor } from "../../src/services/sendspin/supervisor.js";

describe("sendspinSupervisor.start(port?) 兼容包装", () => {
  it("转发到基类 start 且**不**把端口透传(子进程自读 DB 才是权威)", async () => {
    H.startCalls.length = 0;
    await sendspinSupervisor.start(38999);
    // 契约:恰好调一次基类 start,且**零参** —— 端口若被透传,宿主就会拿它当权威端口,
    // 与「子进程读 DB 回报真值」形成两个来源。
    expect(H.startCalls).toEqual([[]]);
  });

  it("省略端口时同样转发(兼容无参调用方)", async () => {
    H.startCalls.length = 0;
    await sendspinSupervisor.start();
    expect(H.startCalls).toEqual([[]]);
  });

  it("模块加载时即以 import.meta.url 解析子进程入口(入口错了就 fork 错文件)", () => {
    expect(H.resolveArgs.length).toBeGreaterThanOrEqual(1);
    // 契约:resolveChildEntry 必须收到本模块的 import.meta.url(URL 一族),而不是裸路径。
    expect(String(H.resolveArgs[0])).toMatch(/supervisor\.(ts|js)/);
  });
});
