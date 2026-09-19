// ==================== supervisor 真 fork 冒烟测试用的最小子进程 ====================
//
// ⚠️ 这是**测试夹具**,不是生产代码。
//
// 为什么需要它:`rendererHost/mode.ts` 见到 `VITEST` 一律返回 false(单测永不真 fork),
// 于是「生产是否真的 fork 起来了」此前只由注释与 CHANGELOG 背书,零断言。本夹具让
// `supervisorFork.test.ts` 能**真的 fork 一个进程**,从而覆盖 fork / 握手 / 看门狗 /
// 退避重启 / RPC / 快照这条路径。
//
// 故意用 `.mjs`(纯 JS):`fork()` 直接跑 node,不需要任何 TS loader,
// 也就与 vitest 的 `process.execArgv` 完全解耦。
//
// 环境开关(测试按需注入):
//   STUB_PORT=38927        经 mainReady 回传的“端口”,用于断言握手载荷真的过了 IPC 边界
//   STUB_EXIT_ON_BOOT=1    立刻退出,用于断言 start() 的失败分支
//   STUB_DIE_AFTER_READY=1 握手后自尽,用于断言退避重启
const send = (msg) => {
  try {
    process.send(msg);
  } catch {
    /* 父进程已走 */
  }
};

let counter = 0;

async function handleReq({ id, op, payload }) {
  try {
    switch (op) {
      case "ping":
        send({ t: "res", id, ok: true, result: { pong: true, pid: process.pid } });
        return;
      case "echo":
        send({ t: "res", id, ok: true, result: payload ?? null });
        return;
      case "bump":
        counter += 1;
        send({ t: "state", n: counter });
        send({ t: "res", id, ok: true, result: { n: counter } });
        return;
      case "boom":
        throw new Error("stub 故意失败");
      case "slow":
        await new Promise((r) => setTimeout(r, Number(payload?.ms ?? 50)));
        send({ t: "res", id, ok: true, result: "slow-done" });
        return;
      case "die":
        send({ t: "res", id, ok: true, result: "dying" });
        setTimeout(() => process.exit(0), 10);
        return;
      case "stop":
        send({ t: "res", id, ok: true, result: "stopping" });
        setTimeout(() => process.exit(0), 10);
        return;
      default:
        send({ t: "res", id, ok: false, error: `未知 op: ${op}` });
    }
  } catch (e) {
    send({ t: "res", id, ok: false, error: String((e && e.message) || e) });
  }
}

process.on("message", (raw) => {
  if (!raw || typeof raw !== "object") return;
  if (raw.t === "req") {
    void handleReq(raw);
  } else if (raw.t === "stop") {
    send({ t: "stopped" });
    setTimeout(() => process.exit(0), 10);
  }
});

// 启动序列:握手 → 首次快照 → 周期心跳。
if (process.env.STUB_EXIT_ON_BOOT === "1") {
  process.exit(3);
}

setTimeout(() => {
  send({ t: "mainReady", ready: true, port: Number(process.env.STUB_PORT ?? 0) });
  send({ t: "state", n: counter });
  const hb = setInterval(() => send({ t: "heartbeat", pid: process.pid }), 500);
  hb.unref?.();
  if (process.env.STUB_DIE_AFTER_READY === "1") {
    setTimeout(() => process.exit(1), 100);
  }
}, 20);
