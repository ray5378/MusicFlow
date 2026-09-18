// ==================== AirPlay 专属子进程入口 ====================
//
// 由 supervisor.ts fork(prod: dist/services/airplay/child.js;dev: src/child.ts,
// tsx loader 经 fork 继承)。常驻而非一次性,启动序列:
//
//   致命异常兜底 → 装配 AirplaySessionRuntime(RAOP 协议 + ffmpeg 解码,无 DB)
//     → mainReady(主进程 supervisor 解除等待)
//     → 消息循环:cast / stopSession / pause / resume / seek / setVolumeDb
//
// **不需要数据层 bootstrap**:本进程只跑纯协议推流 —— 设备解析、DLNA 双协议互斥、
// token 化 streamUrl、peer 注册、队列编排全在主线程序(control.ts)。所以这里不注册
// 插件、不碰 SQLite(符合 SPEC「每进程一个 SQLite 连接」:子进程压根不新开)。
//
// 事件回流:sessionEnded → 主进程上报 IDLE(队列自动续播)。
// 状态镜像:脏触发 + 1s 兜底扫推 state(会话态),主进程同步读。
// 日志:stdio inherit → 与主进程同汇 docker logs。崩溃退出 → supervisor 退避重启。
import {
  createProcessSend,
  installChildFatalHandlers,
  installChildMessageLoop,
  exitChildSoon,
} from "../rendererHost/childBootstrap.js";
import { createLogger } from "../../utils/logger.js";
import type { ParentToAirplayChild, AirplayChildToParent } from "./ipcProtocol.js";
import type { AirplayChildController } from "./childMain.js";

const LOG_NAME = "airplay-child";
const LABEL = "airplay 子进程";
const log = createLogger(LOG_NAME);

const send = createProcessSend<AirplayChildToParent>();

let controller: AirplayChildController | null = null;

async function main(): Promise<void> {
  const { AirplayChildController } = await import("./childMain.js");
  controller = new AirplayChildController(send);
  send({ t: "mainReady", pid: process.pid });
  controller.markReady();
  log.info(`airplay 推流运行时已就绪: pid=${process.pid}`);
}

installChildFatalHandlers(LOG_NAME, LABEL);

// 消息循环先注册:提前到达的消息交给 controller(未就绪时为 null,安全丢弃)。
installChildMessageLoop<ParentToAirplayChild>(LOG_NAME, LABEL, async (raw) => {
  await controller?.handleMessage(raw);
  if (raw.t === "stop") {
    // stopRuntime 已在 req 处理内完成(会话全停);给消息一拍冲刷时间后自杀。
    exitChildSoon(200);
  }
});

main().catch((e: any) => {
  log.error(`${LABEL}启动失败,退出等重启: ${e?.message || e}`);
  process.exit(1);
});
