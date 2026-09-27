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
//   STUB_BOOT_SLOW=1       永不握手(不发 mainReady),用于断言 start() 启动超时
//   STUB_MUTE=1            握手后不再发心跳,用于断言心跳看门狗强杀重启
//   STUB_DEATH_LOOP=1      每次握手后立刻自尽,用于断言"重启反复失败 ⇒ 置 running=false"
// 注意:本文件是 .mjs(ESM),`require` 在这里**根本不存在**。
// 早期版本在 try/catch 里用 require("fs") 写标记文件,异常被静默吞掉 ⇒
// "死亡环第二轮"永远退化成正常握手,用例看着像绿其实是没测到。
import { existsSync, writeFileSync } from "fs";

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
      case "emit":
        // 业务事件(非信封判别字段),用于断言宿主把它交给 onEvent + hooks。
        send({ t: "activated", note: String(payload?.note ?? "default") });
        send({ t: "res", id, ok: true, result: "emitted" });
        return;
      case "dieNow":
        // 故意**不回 res** 就猝死:用于断言"挂起 RPC 随子进程退出一起被 reject"。
        setTimeout(() => process.exit(1), 5);
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
const MUTE_HEARTBEAT = process.env.STUB_MUTE === "1";
const NEVER_HANDSHAKE = process.env.STUB_BOOT_SLOW === "1";
const DEATH_LOOP = process.env.STUB_DEATH_LOOP === "1";

// 死亡环标记文件:**每 fork 一个新进程都会重新走到这里**,所以父进程不必关心「第几次重启」。
// 第一次遇到 ⇒ 只登记 pid,正常握手;之后遇到 ⇒ 在握手**之前**就 exit(3),
// 于是宿主的 spawnAndWait 走的是 onExitOnce 失败分支 ⇒ 真正打进"重启失败"的 catch。
const DEATH_MARK = "/tmp/stub-death-loop-seen";
if (DEATH_LOOP) {
  const seen = existsSync(DEATH_MARK);
  writeFileSync(DEATH_MARK, String(process.pid));
  if (seen) process.exit(3);
}

if (process.env.STUB_EXIT_ON_BOOT === "1") {
  process.exit(3);
}

setTimeout(() => {
  if (!NEVER_HANDSHAKE) {
    send({ t: "mainReady", ready: true, port: Number(process.env.STUB_PORT ?? 0) });
    send({ t: "state", n: counter });
    if (!MUTE_HEARTBEAT) {
      const hb = setInterval(() => send({ t: "heartbeat", pid: process.pid }), 500);
      hb.unref?.();
    }
  }
  if (process.env.STUB_DIE_AFTER_READY === "1") {
    setTimeout(() => process.exit(1), 100);
  }
  if (DEATH_LOOP) {
    // 只会在握手后活 50ms:重启必然反复失败 ⇒ 宿主应把它降级成 running=false。
    setTimeout(() => process.exit(1), 50);
  }
}, 20);
