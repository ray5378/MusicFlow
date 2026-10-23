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
import type { AirplayBridgeServer } from "./bridgeServer.js";
import { ap2RuntimeInfo, cancelAllPairing, ptpDaemon } from "./ap2/index.js";
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
  /** 桥接 PCM 接收端(未启用桥接时为空:in-proc/单测路径)。 */
  private readonly bridge: AirplayBridgeServer | null;

  constructor(send: ChildSend, bridge?: AirplayBridgeServer) {
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
      onStop: async () => {
        await runtime.stopAll();
        await bridge?.stop();
        // 配对会话与 PTP 守护不属于任何"会话":进程整体退出时必须显式收,
        // 否则 cliairplay --pair-setup / --ptp-daemon 会留成孤儿进程(占 319/320)。
        try { cancelAllPairing(); } catch { /* ignore */ }
        try { ptpDaemon.stop(); } catch { /* ignore */ }
      },
    });
    this.runtime = runtime;
    this.bridge = bridge ?? null;
    holder.ctl = this;
  }

  buildState(): AirplayStateEnvelope {
    // 会话态就是镜像的全部内容(设备发现/DB/peer/lastCast 都留主进程)。
    return { t: "state", ...this.runtime.snapshot() };
  }

  /** 桥接端口(供 child.ts 启动时上报;未启用为 0)。 */
  get bridgePort(): number {
    return this.bridge?.listenPort ?? 0;
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
      // ==================== AirPlay×Sendspin 同步群组(桥接会话)====================
      case "bridgeCast": {
        // 桥接会话:设备连接参数由主进程给(discovery 在主进程),PCM 来自 sendspin
        // pump —— 本进程内的 BridgeRing 按墙钟 + 该设备 latencyFrames 取内容。
        if (!this.bridge) throw new Error("airplay 桥接收听端未启动(桥接需要 fork 模式)");
        const deviceId = String(p.deviceId);
        const ring = this.bridge.ringFor(deviceId);
        const port = this.bridge.listenPort;
        const cast = await this.runtime.castBridge({
          deviceId,
          host: String(p.host),
          port: Number(p.port) || 7000,
          pk: p.pk ? String(p.pk) : undefined,
          et: p.et ? String(p.et) : undefined,
          title: p.title ? String(p.title) : undefined,
          artist: p.artist ? String(p.artist) : undefined,
          album: p.album ? String(p.album) : undefined,
          durationSec: Number(p.durationSec) || 0,
          // lead:cli 通道由 sink 自己量(queue depth);raop 通道用 RECORD 应答的
          // audio-latency(缺省 1s)。两种路径单位统一为微秒。
          makeProducer: (player, leadUs) =>
            ring.producer(
              player
                ? () => Math.round((player.latencyFramesUsed / 44100) * 1_000_000)
                : leadUs,
            ),
          // 桥接会话的上报位置走 pump 内容时间线(与组/其他成员同源),不走「会话已过时长」。
          makeContentClock: () => ring.contentSec,
          resetSource: () => ring.reset(),
          route: p.route === "raop" ? "raop" : p.route === "cli" ? "cli" : undefined,
          cli: p.cli,
        });
        this.requestSnapshot(true);
        // latencyFrames 必须回给主进程:pump 的 send_ahead 要抬到它之上,
        // 否则桥接侧每包欠载(BridgeRing producer 取的内容永远超前于已生产内容)。
        return { bridgePort: port, latencyFrames: cast.latencyFrames, sampleRate: cast.sampleRate };
      }
      case "bridgeSeek": {
        // 复用普通 seek 的桥接分支(RAOP FLUSH + 上游缓冲清空)。
        const ok = await this.runtime.seek(String(p.deviceId), Number(p.seconds) || 0);
        this.requestSnapshot(true);
        return ok;
      }
      case "bridgeStats": {
        return this.bridge?.hasRing(String(p.deviceId))
          ? this.bridge.ringFor(String(p.deviceId)).ringStats
          : null;
      }
      // AP2 运行时诊断:二进制路径/版本/可用性。主进程据此在设置页显示「AP2 已就绪」,
      // 也让"为什么某台设备回落到了 RAOP"可被直接观察到。
      case "ap2Info":
        return ap2RuntimeInfo();
      default:
        throw new Error(`未知 airplay rpc op: ${op}`);
    }
  }
}
