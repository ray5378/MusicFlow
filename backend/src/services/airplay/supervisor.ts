// ==================== AirPlay 子进程管理器(主进程侧) ====================
//
// 把 **RAOP 推流会话**(RTSP 握手 + 7.98ms 墙钟节拍 + 进程内 ALAC 打包 + AES-CBC 加密)
// fork 到专属常驻子进程 —— 这是与 sendspin 完全同构的负载(节拍甚至更紧:7.98ms vs 25ms),
// 留在主进程时,一次长阻塞/封面缩图/批量任务都会直接体现为 reanchors++ 与真机断音。
//
// **留主进程的**:设备发现(mDNS)、DB(airplay_devices)、DLNA 双协议互斥、
// createCastSession 取 token 化 streamUrl、peer 注册、volumeState/lastCast —— 它们要么
// 是状态密集(K1)、要么是纯 I/O(K3),搬进子进程只会多一跳 IPC;子进程也就不用碰 DB。
//
// 宿主的通用部分(fork / 握手 / 看门狗 / 退避重启 / 优雅 stop / rpc / 镜像 / 事件分发)
// 在 `../rendererHost`;本文件只声明 AirPlay 的业务接线。
//
// 开关见 mode.ts:20 `defaultFork: true`(默认 fork;MUSICFLOW_AIRPLAY_INPROC=1 才回落 in-proc)。
import { RendererHostSupervisor, resolveChildEntry } from "../rendererHost/index.js";
import { createLogger } from "../../utils/logger.js";
import type {
  AirplaySnapshot,
  AirplayReadyInfo,
  AirplayChildEvent,
  AirplaySessionMirrorRow,
  AirplaySessionEndInfo,
} from "./ipcProtocol.js";
import { bridgeHealth } from "./bridgeHealth.js";
import { playerIsolationEnabled } from "../playerHost/isolationFlag.js";

const CHILD_ENTRY = resolveChildEntry(import.meta.url);

export interface AirplayMirror {
  sessions: Map<string, AirplaySessionMirrorRow>;
}

export interface AirplayHostHooks {
  /** 会话结束(整首播完 / 失败 / 被停):主进程据此上报 IDLE,让队列自动续播。
   *  info 携带落点 + `current`(是否仍是该设备的当前会话);current=false 时
   *  主进程必须**抑制**这条过期 IDLE —— 它属于上一首,会污染新曲的 tracker。 */
  onSessionEnded?: (deviceId: string, info?: AirplaySessionEndInfo) => void;
  /** Phase 5(§5.2):airplay 子进程崩溃退避重启完成 —— 主进程据此重建桥路由
   *  (原 token 重发 bridgePrepare,泵侧 BridgeMember 退避重连自动接上)。 */
  onBridgeChildRestarted?: () => void;
  /** 停播空闲回收:子进程连续 N 分钟无 native/桥会话 → 主进程停掉它(下次投屏懒启动)。 */
  onIdleReclaim?: (idleMs: number) => void;
}

/** 本模块日志（与基类私有 log 分离：基类 log 不可见）。 */
const log = createLogger("airplay-supervisor");

class AirplaySupervisor extends RendererHostSupervisor<
  AirplayMirror,
  AirplayReadyInfo,
  AirplaySnapshot,
  AirplayChildEvent,
  AirplayHostHooks
> {
  constructor() {
    super({
      name: "airplay",
      logName: "Airplay-supervisor",
      childEntry: CHILD_ENTRY,
      childEnv: { MUSICFLOW_AIRPLAY_CHILD: "1" },
      initialMirror: { sessions: new Map() },
      describeMirror: (m) => `sessions=${m.sessions.size}`,
      // mainReady 载荷只有 pid,无需落镜。
      applyState: (m, s) => {
        m.sessions = new Map(s.sessions.map((r) => [r.deviceId, r]));
      },
      // Phase 5:子进程崩溃退避重启成功(respawn=true)→ 业务钩子重建桥路由。
      onChildReady: ({ respawn }) => {
        if (!respawn) return;
        try { this.hooks?.onBridgeChildRestarted?.(); } catch { /* 重建失败不拖垮宿主 */ }
      },
      onEvent: (ev, hooks) => {
        if (ev.t === "sessionEnded") {
          // ev 本身就是 AirplaySessionEndInfo 的形状(current/positionSec/durationSec/
          // loudnessStderr),原样交给主进程,不再只挑 loudnessStderr 传。
          try { hooks.onSessionEnded?.(ev.deviceId, ev); } catch { /* 上报失败不拖垮桥 */ }
          return;
        }
        if (ev.t === "bridgePaceBump") {
          // 指令式：桥侧已判断「缓冲被抽干」，这里只做转发，sendspin 子进程纯执行。
          // 失败必须留痕 —— 240 实测曾因静默 catch 导致「指令发了 3 次、泵一次没执行」，
          // 现场完全看不出断在哪（rendererHost/supervisor.ts 的 running 标志问题同样会
          // 让 rpc 直接 reject）。
          void import("../sendspin/supervisor.js")
            .then((m) => m.sendspinSupervisor.rpc("paceBump", { ms: ev.ms, deficitMs: ev.deficitMs }))
            .then(() => {
              // 常规路径：debug 级（需要时 LOG_LEVEL=debug 打开）
              log.debug(`[airplay] pace-bump 已转发 ms=${ev.ms}`);
            })
            .catch((e: unknown) => {
              // 异常路径：warn 级常驻 —— 240 实测曾因静默 catch 导致
              // 「指令发了 3 次、泵一次没执行」而现场完全看不出断点。
              log.warn(
                `[airplay] pace-bump 转发失败 ms=${ev.ms}: ${(e as Error)?.message ?? String(e)}`,
              );
            });
          return;
        }
        if (ev.t === "bridgeStats") {
          bridgeHealth.record(ev.deviceId, ev.inQueueMs);
          // 转发给 sendspin 子进程（泵在那里，判据要用）：桥水位与泵分属两个子进程，
          // 必须经主进程中转。动态 import 避免 airplay ↔ sendspin 的静态循环依赖。
          const min = bridgeHealth.min();
          if (Number.isFinite(min)) {
            void import("../sendspin/supervisor.js")
              .then((m) => m.sendspinSupervisor.rpc("bridgeHealth", { minInQueueMs: min }))
              .catch(() => {
                /* sendspin 子进程未起（无播放）：丢弃即可，下一次 tick 再来 */
              });
          }
          return;
        }
        if (ev.t === "idleReclaim") {
          try { hooks.onIdleReclaim?.(ev.idleMs); } catch { /* 回收失败不影响子进程 */ }
        }
      },
    });
  }
}

/** 建一台 airplay 子进程宿主（每台播放器一台，见下方 router）。 */
export function createAirplaySupervisor(): AirplaySupervisor {
  return new AirplaySupervisor();
}

/**
 * 子进程路由（2026-11-23 播放器隔离改造 S4）。
 *
 * MA 的做法是「每播放器一个 cliairplay 进程」（providers/airplay/stream.py:327）。
 * 我们此前是**一个** airplay 子进程承载所有桥会话 —— 一台设备的协议层卡顿/长阻塞
 * 会占满同一个事件循环，连带影响其他设备。
 *
 * 这里把单例改成按 deviceId 路由：`MF_PLAYER_ISOLATION=1` 时每台设备独立子进程，
 * 关闭时全部落到同一个 ``_legacy`` 宿主（与改造前行为完全一致，便于 A/B 回滚）。
 *
 * 调用点无需改动：仍然只看到 `airplaySupervisor.rpc(method, params)`，
 * deviceId 从 params 里取（token 类调用走 bridgePrepare 时登记的映射）。
 */
export class AirplaySupervisorRouter {
  private readonly hosts = new Map<string, AirplaySupervisor>();
  private readonly tokenDev = new Map<string, string>();
  private hooks: AirplayHostHooks | null = null;
  private mergedMirror: AirplayMirror = { sessions: new Map() };

  private isolated(): boolean {
    return playerIsolationEnabled();
  }

  private keyOf(params: unknown): string {
    if (!this.isolated()) return "_legacy";
    const p = (params ?? {}) as { deviceId?: unknown; token?: unknown };
    const dev =
      typeof p.deviceId === "string" && p.deviceId
        ? p.deviceId
        : typeof p.token === "string"
          ? this.tokenDev.get(p.token)
          : undefined;
    return dev || "_legacy";
  }

  /** 合并视图：调用点读 .mirror.sessions（主进程判定「该设备是否有会话」）。 */
  get mirror(): AirplayMirror {
    if (!this.isolated()) return this.hosts.get("_legacy")?.mirror ?? this.mergedMirror;
    const sessions = new Map<string, AirplaySessionMirrorRow>();
    for (const h of this.hosts.values()) {
      for (const [k, v] of h.mirror.sessions) sessions.set(k, v);
    }
    this.mergedMirror = { sessions };
    return this.mergedMirror;
  }

  setHooks(hooks: AirplayHostHooks): void {
    this.hooks = hooks;
    for (const h of this.hosts.values()) h.setHooks(hooks);
  }

  isRunning(): boolean {
    if (!this.isolated()) return this.hosts.get("_legacy")?.isRunning() ?? false;
    for (const h of this.hosts.values()) if (h.isRunning()) return true;
    return false;
  }

  /** 隔离模式下不预热（子进程按设备懒启动）；非隔离模式与旧行为一致。 */
  async start(): Promise<void> {
    if (!this.isolated()) await this.ensure("_legacy");
  }

  async stop(): Promise<void> {
    const all = [...this.hosts.values()];
    this.hosts.clear();
    this.tokenDev.clear();
    await Promise.all(all.map((h) => h.stop().catch(() => undefined)));
  }

  private async ensure(key: string): Promise<AirplaySupervisor> {
    let host = this.hosts.get(key);
    if (!host) {
      host = createAirplaySupervisor();
      if (this.hooks) host.setHooks(this.hooks);
      this.hosts.set(key, host);
    }
    if (!host.isRunning()) await host.start();
    return host;
  }

  async rpc<R = unknown>(method: string, params?: unknown): Promise<R> {
    const p = (params ?? {}) as { deviceId?: string; token?: string };
    // bridgePrepare 建立 token → device 的映射（stop/manual 这类只带 token）
    if (method === "bridgePrepare" && typeof p.token === "string" && typeof p.deviceId === "string") {
      this.tokenDev.set(p.token, p.deviceId);
    }
    if (method === "bridgeStop" && typeof p.token === "string") {
      const dev = this.tokenDev.get(p.token);
      const host = await this.ensure(this.keyOf(params));
      const r = await host.rpc<R>(method, params);
      if (dev) this.tokenDev.delete(p.token);
      return r;
    }
    const host = await this.ensure(this.keyOf(params));
    return host.rpc<R>(method, params);
  }
}

export const airplaySupervisor = new AirplaySupervisorRouter();
