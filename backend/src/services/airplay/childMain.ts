// ==================== AirPlay 子进程控制器(RPC 分发 + 快照推送) ====================
//
// child.ts(fork 入口)把消息交给本类;独立成文件是为了可单测(不 fork 也能用真实
// 的会话运行时驱动同一套 handler,保证测试路径 = 生产路径)。
//
// 通用部分(心跳 / 快照节流 / req→res 回包 / stop 生命周期)在
// `../rendererHost/childHost.js`;本文件只做 AirPlay 的 op 表:
//   cast / stopSession / stopAll / pause / resume / seek / setVolumeDb
//   + Phase 3 桥接:bridgePrepare / bridgeStop / bridgeStatus(§6.2;PCM 不走 JSON IPC)。
//     桥会话 = BridgeSession(BridgeServer listener + 48k→44.1k 重采样 + RAOP 旧墙钟出声);
//     与 native cast 互斥:cast 到桥占用设备直接拒绝,bridgePrepare 先停同设备 native 会话。
import { ChildRpcHost } from "../rendererHost/childHost.js";
import { AirplaySessionRuntime } from "./sessionRuntime.js";
import { BridgeSessionManager } from "./bridgeSession.js";
import { cleanupStaleBridgeSockets } from "./bridgeChannel.js";
import type {
  AirplayChildToParent,
  AirplaySnapshot,
  AirplayStateEnvelope,
  AirplayCastArgs,
  BridgePrepareArgs,
  BridgePreparedResult,
} from "./ipcProtocol.js";

/** 子进程对主进程的发送通道(child.ts 注入 process.send 的安全包装;测试注入数组)。 */
export type ChildSend = (msg: AirplayChildToParent) => void;

export class AirplayChildController extends ChildRpcHost<AirplayChildToParent, AirplaySnapshot> {
  readonly runtime: AirplaySessionRuntime;

  /** Phase 3 桥会话表,按 sessionToken 索引(bridgePrepare/bridgeStop 管理)。 */
  private readonly bridgeSessions = new BridgeSessionManager();

  constructor(send: ChildSend) {
    // hooks 里的 onChanged 要回调到本控制器(触发快照),而 super() 之前还不能用 this
    // → 用一个后置填充的持有者,真正调用发生在会话起停时(那时已构造完毕)。
    const holder: { ctl: AirplayChildController | null } = { ctl: null };
    const runtime = new AirplaySessionRuntime({
      // 会话结束 → 通知主进程上报 IDLE(等价 DLNA 的 GENA,让队列无需等 5s 轮询)。
      // 一并带上「落点 + 是否仍是当前会话」:被新起播/stop 取代的旧会话(current=false)
      // 由主进程抑制其过期 IDLE,避免把刚建立的新曲判成"已结束"。
      // 附解码器 stderr(P0-4 解析 loudnorm 用;被杀/失败时无 JSON,主进程侧即 false)。
      onSessionEnded: (deviceId, info) =>
        send({
          t: "sessionEnded",
          deviceId,
          current: info.current,
          positionSec: info.positionSec,
          durationSec: info.durationSec,
          ...(info.loudnessStderr ? { loudnessStderr: info.loudnessStderr } : {}),
        }),
      onChanged: () => holder.ctl?.requestSnapshot(),
    });
    super({
      send,
      buildState: () => this.buildState(),
      dispatch: (op, payload) => this.dispatch(op, payload),
      onStop: () => {
        void this.bridgeSessions.stopAll();
        runtime.stopAll();
      },
    });
    this.runtime = runtime;
    holder.ctl = this;
    // Phase 5(§5.2):子进程启动即清扫无 listener 的陈旧 mfab socket
    // (fire-and-forget;探针连接被拒才删,绝不影响将要 listen 的路径 ——
    // BridgeServer.listen 自身仍会先 unlink 自己的路径)。
    void cleanupStaleBridgeSockets().catch(() => { /* 清理失败不拖垮启动 */ });
  }

  buildState(): AirplayStateEnvelope {
    // 会话态就是镜像的全部内容(设备发现/DB/peer/lastCast 都留主进程)。
    return { t: "state", ...this.runtime.snapshot() };
  }

  private async dispatch(op: string, p: any): Promise<unknown> {
    switch (op) {
      case "cast": {
        // Phase 3 互斥(MAJ-06):native cast 与桥会话互斥 —— 桥占用的设备拒绝 native。
        if (this.bridgeSessions.has(String(p?.deviceId ?? ""))) {
          throw new Error("该设备由桥接会话占用(owner=bridge),native cast 与 bridge 互斥");
        }
        await this.runtime.cast(p as AirplayCastArgs);
        this.requestSnapshot(true);
        return null;
      }
      case "stopSession": {
        // 不带 deviceId 视为全停(主进程关闭 AirPlay 服务时用)。
        const deviceId = String(p?.deviceId ?? "");
        if (deviceId) await this.runtime.stop(deviceId);
        else await this.runtime.stopAll();
        this.requestSnapshot(true);
        return null;
      }
      case "stopAll": {
        await this.runtime.stopAll();
        this.requestSnapshot(true);
        return null;
      }
      case "hasSession":
        return this.runtime.has(String(p.deviceId));
      case "pause": {
        const ok = this.runtime.pause(String(p.deviceId));
        this.requestSnapshot(true);
        return ok;
      }
      case "resume": {
        // false = 没有可恢复的会话,主进程据此回落到「重播上一首」。
        const ok = this.runtime.resume(String(p.deviceId));
        this.requestSnapshot(true);
        return ok;
      }
      case "seek": {
        // false = 无会话可原地 seek,主进程据此回落到「带 seekSec 重投」。
        const inPlace = await this.runtime.seek(String(p.deviceId), Number(p.seconds) || 0);
        this.requestSnapshot(true);
        return inPlace;
      }
      case "setVolumeDb": {
        // dB 由主进程算好(DLNA 转发失败时的回落通道)。
        this.runtime.setVolumeDb(String(p.deviceId), Number(p.db) || -144);
        return null;
      }
      case "bridgePrepare": {
        // Phase 3:桥会话 = listener + 重采样 + RAOP 旧墙钟出声(host 缺省 = dry)。
        const result: BridgePreparedResult = await this.prepareBridge(p as BridgePrepareArgs);
        return result;
      }
      case "bridgeStop": {
        // 按 sessionToken 停对应桥会话;未知 token 幂等返回。
        await this.bridgeSessions.stop(String(p?.token ?? ""));
        return null;
      }
      case "bridgeStatus": {
        // 桥会话状态(诊断/soak):deviceId/token/socket/streaming/统计。
        return this.bridgeSessions.list();
      }
      default:
        throw new Error(`未知 airplay rpc op: ${op}`);
    }
  }

  // ------------------------- Phase 3:桥会话管理 -------------------------

  private async prepareBridge(args: BridgePrepareArgs): Promise<BridgePreparedResult> {
    const { deviceId, socketPath, token, protocol, host, port, pk, et } = args;
    if (!deviceId || !socketPath || !token) {
      throw new Error("bridgePrepare: deviceId/socketPath/token 必填");
    }
    // native → bridge 接管:先停同设备的 native 会话(反向互斥由 cast 分支保证)。
    if (this.runtime.has(deviceId)) await this.runtime.stop(deviceId);
    // MFAB_DUMP_PATH 仍生效于 dry/无 consumer 场景(BridgeSession 自带 onAudio,
    // 落盘由 dry 模式 + 无 RAOP 的 BridgeServer dumpPath 承担 —— 桥出声时落盘关闭)。
    const prepared = await this.bridgeSessions.prepare({
      deviceId,
      token,
      protocol,
      socketPath,
      host,
      port,
      pk,
      et,
      dry: !host,
    });
    this.requestSnapshot(true);
    return { listening: true, socketPath: prepared.socketPath };
  }
}
