// ==================== Sendspin 子进程管理器(主进程侧) ====================
//
// 把 sendspin 运行时(WS 38927 + 解码/编码/推流 + mDNS + 拨号 + 6053 桥)fork 到
// **专属常驻子进程**,彻底隔离主进程事件循环被前端/后台任务阻塞对推流节奏的干扰。
//
// 宿主的通用部分(fork / mainReady 握手 / 心跳看门狗 / 退避重启 / 优雅 stop / rpc /
// 镜像容器 / 事件分发)已抽到 `../rendererHost`,本文件只声明 sendspin 的业务接线:
//   - 子进程入口 child.ts;fork 时注入 MUSICFLOW_SENDSPIN_CHILD=1(子进程据此走 in-proc 装配);
//   - 镜像字段 SendspinMirror 的落镜方式;
//   - 业务事件 activated / closed / playFailed → SupervisorHooks。
//
// 通信面(协议见 ipcProtocol.ts):
//   - 状态读:child 周期/脏触发推 `state` 快照 → 镜像,主进程同步读;
//   - 命令写:rpc(req/res 按 id 回填);
//   - 事件:activated/closed/playFailed → 转给 index.ts 的注册/注销逻辑。
// 子进程日志走 stdio inherit → 与主进程同汇 docker logs,排障路径不变。
import { RendererHostSupervisor, resolveChildEntry } from "../rendererHost/index.js";
import type {
  SendspinSnapshot,
  SendspinReadyInfo,
  SendspinChildEvent,
  ClientMirrorMsg,
  GroupMirrorMsg,
  PairRecordMirrorMsg,
} from "./ipcProtocol.js";

const CHILD_ENTRY = resolveChildEntry(import.meta.url);

export interface SendspinMirror {
  serverId: string;
  port: number;
  clients: Map<string, ClientMirrorMsg>;
  groups: Map<string, GroupMirrorMsg>;
  records: Map<string, PairRecordMirrorMsg>;
  attempts: unknown[];
}

export interface SupervisorHooks {
  /** 客户端激活(主进程据此注册 QC/PM 播放器,与 in-proc registerServerPlayer 同构)。 */
  onActivated?: (clientId: string, name: string, legacy: boolean) => void;
  onClosed?: (clientId: string) => void;
  onPlayFailed?: (clientId: string, songId: string, message: string) => void;
}

class SendspinSupervisor extends RendererHostSupervisor<
  SendspinMirror,
  SendspinReadyInfo,
  SendspinSnapshot,
  SendspinChildEvent,
  SupervisorHooks
> {
  constructor() {
    super({
      name: "sendspin",
      logName: "Sendspin-supervisor",
      childEntry: CHILD_ENTRY,
      // 标记自身是 sendspin 子进程:内部 index.ts 走 in-proc 装配(不递归 fork)。
      childEnv: { MUSICFLOW_SENDSPIN_CHILD: "1" },
      initialMirror: {
        serverId: "",
        port: 0,
        clients: new Map(),
        groups: new Map(),
        records: new Map(),
        attempts: [],
      },
      describeMirror: (m) => `port=${m.port}`,
      applyReady: (m, info) => {
        m.serverId = info.serverId;
        m.port = info.port;
      },
      applyState: (m, s) => {
        m.clients = new Map(s.clients.map((c) => [c.clientId, c]));
        m.groups = new Map(s.groups.map((g) => [g.name, g]));
        m.records = new Map(s.records.map((r) => [r.clientId, r]));
        m.attempts = s.attempts;
      },
      onEvent: (ev, hooks) => {
        switch (ev.t) {
          case "activated":
            try { hooks.onActivated?.(ev.clientId, ev.name, ev.legacy); } catch { /* 注册失败不拖垮桥 */ }
            return;
          case "closed":
            try { hooks.onClosed?.(ev.clientId); } catch { /* ignore */ }
            return;
          case "playFailed":
            try { hooks.onPlayFailed?.(ev.clientId, ev.songId, ev.message); } catch { /* ignore */ }
            return;
          default:
            return;
        }
      },
    });
  }

  /** 兼容既有调用方:端口只用于日志/配置意图,子进程自己读 DB 定端口并在 mainReady 回报真值。 */
  async start(_port?: number): Promise<void> {
    await super.start();
  }
}

export const sendspinSupervisor = new SendspinSupervisor();
