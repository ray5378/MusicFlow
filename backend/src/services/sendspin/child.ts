// ==================== Sendspin 专属子进程入口 ====================
//
// 由 supervisor.ts fork(prod: dist/services/sendspin/child.js;dev: src/child.ts,
// tsx loader 经 fork 继承)。常驻而非一次性,启动序列:
//
//   致命异常兜底 + 数据层 bootstrap(插件注册 + DB 建表/回填 + 外置插件发现,音源解析要用)
//     → startSendspinInProcess(hooks)(WS 38927 + mDNS + 拨号 + 6053 桥 + 推流引擎)
//     → mainReady(主进程 supervisor 解除等待)
//     → 消息循环:RPC(playMedia/transport/poll/配对/拨号/6053…)+ cfg 热更新 + stop
//
// 事件回流:设备激活/断开/起播失败 → IPC → 主进程注册/注销 QC/PM 播放器。
// 状态镜像:周期+脏触发推 state(150ms 节流 / 1s 兜底扫),主进程同步读。
// 日志:stdio inherit → 与主进程同汇 docker logs。崩溃退出 → supervisor 退避重启。
//
// 骨架(异常兜底 / 数据层 / 消息循环 / process.send 包装)来自 rendererHost/childBootstrap,
// 与 airplay 等其它常驻渲染器子进程共用;本文件只写 sendspin 自己的接线。
//
// ⚠️ 本进程**不 import** ../player/*(QueueController/PlayerController 属主进程);
//    播放操作一律走 playerCore(纯 server 内存对象),队列语义由主进程编排后下指令。

import {
  createProcessSend,
  installChildFatalHandlers,
  installChildMessageLoop,
  bootstrapChildDataLayer,
  exitChildSoon,
} from "../rendererHost/childBootstrap.js";
import { getServer, setServer } from "./runtime.js";
import type { ParentToSendspinChild, SendspinChildToParent } from "./ipcProtocol.js";
import type { SendspinChildController } from "./childMain.js";

const LOG_NAME = "sendspin-child";
const LABEL = "sendspin 子进程";

const send = createProcessSend<SendspinChildToParent>();

let controller: SendspinChildController | null = null;

async function main(): Promise<void> {
  const { startSendspinInProcess, stopSendspinInProcess } = await import("./index.js");
  const { esphomeBridge } = await import("./esphomeBridge.js");
  const { getDeviceEsphome, inheritLegacyEsphomePsk } = await import("./deviceState.js");
  const { SendspinChildController } = await import("./childMain.js");

  controller = new SendspinChildController(
    {
      getServer: () => getServer(),
      stopRuntime: () => stopSendspinInProcess(childHooks),
    },
    send,
  );

  const childHooks = {
    onActivated: (conn: any) => {
      // 6053:设备 IP 从 Sendspin 连接自动派生,密钥按 clientId 逐台读 ——
      // 每台设备各自一把,没填就不连(与主进程 registerServerPlayer 同款)。
      // 含升级迁移:启动窗口内把旧版插件页全局密钥继承成这台自己的(见 deviceState)。
      const creds = (() => {
        if (!conn.clientId) return { psk: "", port: 0 };
        inheritLegacyEsphomePsk(conn.clientId);
        return getDeviceEsphome(conn.clientId);
      })();
      esphomeBridge.syncDevice(conn.remoteHost, creds.psk, creds.port);
      if (conn.clientId) {
        send({
          t: "activated",
          clientId: conn.clientId,
          name: conn.name || conn.clientId,
          legacy: conn.legacy,
        });
      }
      controller?.requestSnapshot(true);
    },
    onClosed: (conn: any) => {
      if (!conn.clientId) return;
      send({ t: "closed", clientId: conn.clientId });
      controller?.requestSnapshot(true);
    },
  };

  // 起 in-proc 运行时(端口/codec/6053 配置自读 DB —— WAL 多进程安全)。
  await startSendspinInProcess(undefined, childHooks);
  const srv = getServer();
  send({ t: "mainReady", serverId: srv?.serverId ?? "", port: srv?.port ?? 0 });
  controller.markReady();
}

// ---- bootstrap(与 batch/child.ts 一致;音源解析/换源探测需要插件与库结构) ----
installChildFatalHandlers(LOG_NAME, LABEL);

// 消息循环先注册:提前到达的消息交给 controller(未就绪时 controller 为 null,安全丢弃)。
installChildMessageLoop<ParentToSendspinChild>(LOG_NAME, LABEL, async (raw) => {
  if (raw.t === "cfg") {
    // 兼容旧路径:配置热更新统一走 RPC applyCfg;这里保留直发通道(免等 RPC 应答)。
    await controller?.handleMessage({ t: "req", id: -1, op: "applyCfg", payload: raw.cfg });
    return;
  }
  await controller?.handleMessage(raw);
  if (raw.t === "stop") {
    // stopRuntime 已在 req 处理内完成;给消息一拍冲刷时间后自杀(supervisor 兜底强杀)。
    exitChildSoon(200);
  }
});

bootstrapChildDataLayer({ logName: LOG_NAME, label: LABEL })
  .then(() => main())
  .catch(() => process.exit(1));

// setServer 引用保持(运行时装配在 index.ts 内完成;此处仅确保模块图完整)。
void setServer;
