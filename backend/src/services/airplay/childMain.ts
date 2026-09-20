// ==================== AirPlay 子进程控制器(RPC 分发 + 快照推送) ====================
//
// child.ts(fork 入口)把消息交给本类;独立成文件是为了可单测(不 fork 也能用真实
// 的会话运行时驱动同一套 handler,保证测试路径 = 生产路径)。
//
// 通用部分(心跳 / 快照节流 / req→res 回包 / stop 生命周期)在
// `../rendererHost/childHost.js`;本文件只做 AirPlay 的 op 表:
//   cast / stopSession / stopAll / pause / resume / seek / setVolumeDb。
import { ChildRpcHost } from "../rendererHost/childHost.js";
import { AirplaySessionRuntime } from "./sessionRuntime.js";
import type {
  AirplayChildToParent,
  AirplaySnapshot,
  AirplayStateEnvelope,
  AirplayCastArgs,
} from "./ipcProtocol.js";

/** 子进程对主进程的发送通道(child.ts 注入 process.send 的安全包装;测试注入数组)。 */
export type ChildSend = (msg: AirplayChildToParent) => void;

export class AirplayChildController extends ChildRpcHost<AirplayChildToParent, AirplaySnapshot> {
  readonly runtime: AirplaySessionRuntime;

  constructor(send: ChildSend) {
    // hooks 里的 onChanged 要回调到本控制器(触发快照),而 super() 之前还不能用 this
    // → 用一个后置填充的持有者,真正调用发生在会话起停时(那时已构造完毕)。
    const holder: { ctl: AirplayChildController | null } = { ctl: null };
    const runtime = new AirplaySessionRuntime({
      // 会话结束 → 通知主进程上报 IDLE(等价 DLNA 的 GENA,让队列无需等 5s 轮询)。
      // 附解码器 stderr(P0-4 解析 loudnorm 用;被杀/失败时无 JSON,主进程侧即 false)。
      onSessionEnded: (deviceId, info) =>
        send(info?.loudnessStderr
          ? { t: "sessionEnded", deviceId, loudnessStderr: info.loudnessStderr }
          : { t: "sessionEnded", deviceId }),
      onChanged: () => holder.ctl?.requestSnapshot(),
    });
    super({
      send,
      buildState: () => this.buildState(),
      dispatch: (op, payload) => this.dispatch(op, payload),
      onStop: () => runtime.stopAll(),
    });
    this.runtime = runtime;
    holder.ctl = this;
  }

  buildState(): AirplayStateEnvelope {
    // 会话态就是镜像的全部内容(设备发现/DB/peer/lastCast 都留主进程)。
    return { t: "state", ...this.runtime.snapshot() };
  }

  private async dispatch(op: string, p: any): Promise<unknown> {
    switch (op) {
      case "cast": {
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
      default:
        throw new Error(`未知 airplay rpc op: ${op}`);
    }
  }
}
