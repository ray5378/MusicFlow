// ==================== Sendspin 子进程控制器(RPC 分发 + 快照推送) ====================
//
// child.ts(fork 入口)把消息交给本模块处理;独立成文件是为了可单测(不 fork 也能
// 用真实 in-proc server 驱动同一套 handler,保证测试路径 = 生产路径)。
//
// 职责:
//  - 处理主进程 RPC:playMedia/transport/poll/pumpActive/announce/dial/配对/静音/6053 状态;
//  - 维护「状态快照」推送:clients/groups(镜像字段)/配对记录(**剥离 pskHex/pskId**)/
//    配对 attempts。脏了立即推(150ms 节流),另有 1s 兜底扫(捕捉 pump 自然结束等无钩子变化);
//  - 生命周期:init(cfg+port)→ 起 in-proc 运行时(index.ts startSendspinInProcess)→
//    mainReady;stop → 清干净 → stopped → 退出由入口执行。
import type {
  ParentToSendspinChild,
  SendspinChildToParent,
  SendspinIpcConfig,
  ClientMirrorMsg,
  GroupMirrorMsg,
  PairRecordMirrorMsg,
} from "./ipcProtocol.js";
import {
  SENDSPIN_SNAPSHOT_THROTTLE_MS,
  SENDSPIN_SNAPSHOT_SWEEP_MS,
  SENDSPIN_HEARTBEAT_MS,
} from "./ipcProtocol.js";
import type { SendspinServer } from "./server.js";
import {
  playCore,
  playGroupCore,
  stopCore,
  stopGroupCore,
  pauseCore,
  resumePumpCore,
  seekCore,
  setVolumeCore,
  setMutedCore,
  pollCore,
  pumpActiveCore,
  announceCore,
  announceProbeCore,
  joinGroupCore,
  leaveGroupCore,
} from "./playerCore.js";
import type { QueueItem } from "../player/types.js";

/** 子进程对主进程的发送通道(child.ts 注入 process.send 的安全包装;测试注入数组)。 */
export type ChildSend = (msg: SendspinChildToParent) => void;

export interface ChildControllerDeps {
  /** 取当前 in-proc server(child 起来后非空)。 */
  getServer: () => SendspinServer | null;
  /** 停止 in-proc 运行时(关服务/停 mDNS/停桥接,不碰主进程 QC/PM)。 */
  stopRuntime: () => Promise<void>;
}

export class SendspinChildController {
  private send: ChildSend;
  private deps: ChildControllerDeps;
  private seq = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotDirty = false;
  private sweep: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  private ready = false;

  constructor(deps: ChildControllerDeps, send: ChildSend) {
    this.deps = deps;
    this.send = send;
    // 兜底扫描:无钩子的状态变化(如 pump 自然结束清 current)1s 内可见。
    this.sweep = setInterval(() => {
      if (this.ready) this.requestSnapshot(true);
    }, SENDSPIN_SNAPSHOT_SWEEP_MS);
    this.sweep.unref?.();
    // 心跳:主进程看门狗据此判断卡死。
    this.heartbeat = setInterval(() => {
      this.send({ t: "heartbeat", pid: process.pid });
    }, SENDSPIN_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  markReady(): void {
    this.ready = true;
    this.requestSnapshot(true);
  }

  dispose(): void {
    clearInterval(this.sweep);
    clearInterval(this.heartbeat);
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /** 请求推送快照:脏标记 + 节流(150ms);force 跳过节流立即推。 */
  requestSnapshot(force = false): void {
    this.snapshotDirty = true;
    if (this.snapshotTimer && !force) return;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (force) {
      this.snapshotDirty = false;
      this.pushSnapshot();
      return;
    }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      if (!this.snapshotDirty) return;
      this.snapshotDirty = false;
      this.pushSnapshot();
    }, SENDSPIN_SNAPSHOT_THROTTLE_MS);
  }

  /** 组装并发送快照。⚠️ 配对记录剥离 pskHex/pskId —— 配对密钥永不出子进程。 */
  pushSnapshot(): void {
    const srv = this.deps.getServer();
    if (!srv) return;
    const clients: ClientMirrorMsg[] = [...srv.clients.values()]
      .filter((c) => !!c.clientId)
      .map((c) => ({
        clientId: c.clientId!,
        name: c.name || c.clientId!,
        roles: [...c.roles],
        legacy: c.legacy,
        ready: c.ready,
        remoteHost: c.remoteHost,
        dialed: c.dialed,
        dialHost: c.dialHost,
        dialPort: c.dialPort,
        volume: c.volume,
        muted: c.muted,
      }));
    const groups: GroupMirrorMsg[] = [...srv.groups.values()].map((g) => ({
      name: g.name,
      volume: g.volume,
      muted: g.muted,
      current: g.current ? { ...g.current } : null,
    }));
    const records: PairRecordMirrorMsg[] = (srv.pairingStore?.listRecords() ?? []).map((r) => ({
      clientId: r.clientId,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      approved: srv.pairingStore?.isApproved(r.clientId) ?? false,
    }));
    const attempts = srv.pairing?.listAttempts() ?? [];
    this.send({ t: "state", clients, groups, records, attempts });
  }

  /** 处理主进程消息;RPC 请求在此分发并回 res。返回 true 表示消息已消费。 */
  async handleMessage(raw: ParentToSendspinChild): Promise<boolean> {
    if (!raw || typeof raw !== "object") return false;
    if (raw.t === "req") {
      await this.handleReq(raw.id, raw.op, raw.payload);
      return true;
    }
    return false;
  }

  private async handleReq(id: number, op: string, payload: any): Promise<void> {
    try {
      const result = await this.dispatch(op, payload);
      this.send({ t: "res", id, ok: true, result: result ?? null });
    } catch (e: any) {
      this.send({ t: "res", id, ok: false, error: String(e?.message || e) });
    }
  }

  private async dispatch(op: string, p: any): Promise<unknown> {
    const srv = this.deps.getServer();
    switch (op) {
      case "playMedia": {
        if (!srv) throw new Error("sendspin server 未运行");
        const clientId = String(p.clientId);
        const item = p.item as QueueItem;
        playCore(srv, clientId, item, (cid, songId, message) => {
          this.send({ t: "playFailed", clientId: cid, songId, message });
        });
        this.requestSnapshot(true); // current 元数据变化立即可见(前端歌词/封面跟随)
        return null; // pump 异步起播,不等待解码
      }
      case "transport": {
        const clientId = String(p.clientId);
        switch (p.op) {
          case "stop":
            stopCore(srv, clientId);
            break;
          case "pause":
            pauseCore(srv, clientId);
            break;
          case "resume":
            resumePumpCore(srv, clientId);
            break;
          case "seek":
            seekCore(srv, clientId, Number(p.arg) || 0);
            break;
          case "volume":
            setVolumeCore(srv, clientId, Number(p.arg) || 0);
            break;
          default:
            throw new Error(`未知 transport op: ${p.op}`);
        }
        this.requestSnapshot(true);
        return null;
      }
      case "setMuted": {
        setMutedCore(srv, String(p.clientId), !!p.muted);
        this.requestSnapshot(true);
        return null;
      }
      case "groupPlay": {
        // 用户组起播:共享组＋单 pump 同一时间线(多房间同步),成员离线自动跳过。
        if (!srv) throw new Error("sendspin server 未运行");
        const members = Array.isArray(p.members) ? p.members.map(String) : [];
        playGroupCore(srv, String(p.group), members, p.item as QueueItem, (cid, songId, message) => {
          this.send({ t: "playFailed", clientId: cid, songId, message });
        });
        this.requestSnapshot(true);
        return null;
      }
      case "groupStop": {
        stopGroupCore(srv, String(p.group));
        this.requestSnapshot(true);
        return null;
      }
      case "groupJoin": {
        // 播中加入走直播沿(无需历史),空闲仅登记。调用方(路由层)据 live 决定提示。
        if (!srv) throw new Error("sendspin server 未运行");
        const r = joinGroupCore(srv, String(p.group), String(p.clientId));
        this.requestSnapshot(true);
        return r;
      }
      case "groupLeave": {
        if (!srv) throw new Error("sendspin server 未运行");
        const removed = leaveGroupCore(srv, String(p.group), String(p.clientId));
        this.requestSnapshot(true);
        return removed;
      }
      case "poll": {
        const st = pollCore(srv, String(p.clientId));
        return st;
      }
      case "pumpActive":
        return pumpActiveCore(srv, String(p.clientId));
      case "announceProbe": {
        if (!srv) throw new Error("sendspin server 未运行");
        // 必须在主进程 qc.deactivate **之前**调用:捕获恢复现场(在播?进度?)。
        return announceProbeCore(srv, String(p.peerId));
      }
      case "announce": {
        if (!srv) throw new Error("sendspin server 未运行");
        const r = await announceCore(srv, String(p.peerId), String(p.url), {
          volume: typeof p.volume === "number" ? p.volume : undefined,
          timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
          savedPos: Number(p.savedPos) || 0,
        });
        this.requestSnapshot(true);
        return r;
      }
      case "dial": {
        if (!srv) throw new Error("sendspin server 未运行");
        const conn = await srv.dialPlayer(String(p.url), Number(p.timeoutMs) || 15000);
        this.requestSnapshot(true);
        return { clientId: conn.clientId, name: conn.name };
      }
      case "clearNoRedial": {
        srv?.clearNoRedial(String(p.host), Number(p.port));
        return null;
      }
      case "dialList":
        return this.dialTargets();
      case "dialRemember":
        return this.remember(p.host, p.port);
      case "dialForget":
        return this.forget(p.host, p.port);
      case "setApproved": {
        if (!srv?.pairingStore) throw new Error("sendspin server 未运行");
        await srv.pairingStore.setApproved(String(p.clientId), !!p.approved);
        this.requestSnapshot(true);
        return null;
      }
      case "disconnect": {
        // 断开某客户端现存连接(不删配对记录):禁用设备时用 —— 配对照旧保留,
        // 设备下次连按禁用态决定是否注册 peer(见 registerServerPlayer)。
        if (!srv) throw new Error("sendspin server 未运行");
        let n = 0;
        for (const conn of [...srv.clients.values()]) {
          if (conn.clientId === String(p.clientId)) {
            try { conn.close(); n++; } catch { /* ignore */ }
          }
        }
        this.requestSnapshot(true);
        return n;
      }
      case "unpair": {
        if (!srv?.pairingStore) throw new Error("sendspin server 未运行");
        const ok = await srv.pairingStore.removeRecord(String(p.clientId));
        // 解绑即断开该客户端现存连接:下次连回落 sentinel,走重新配对/批准。
        const { esphomeBridge } = await import("./esphomeBridge.js");
        for (const conn of [...srv.clients.values()]) {
          if (conn.clientId === String(p.clientId)) {
            // 6053 桥按 host 登记:连接还在时先解挂,免得库里密钥已删、桥仍用旧密钥连着。
            try { esphomeBridge.syncDevice(conn.remoteHost, "", 0); } catch { /* ignore */ }
            try { conn.close(); } catch { /* ignore */ }
          }
        }
        // 解绑 = 这台设备从没被配置过(状态行/6053 密钥/改名/隐藏全清;
        // 连接保持在线,故不动播放队列与群组成员)。与 in-proc sendspinUnpair 同语义。
        try {
          const { purgeDeviceArtifacts } = await import("./deviceState.js");
          purgeDeviceArtifacts(String(p.clientId));
        } catch { /* ignore */ }
        this.requestSnapshot(true);
        return ok;
      }
      case "pairStart": {
        if (!srv?.pairing) throw new Error("sendspin server 未运行");
        await srv.pairing.start(String(p.clientId), String(p.method), p.format ?? "digits");
        this.requestSnapshot(true);
        return null;
      }
      case "pairCode": {
        if (!srv?.pairing) throw new Error("sendspin server 未运行");
        await srv.pairing.enterCode(String(p.clientId), String(p.code));
        this.requestSnapshot(true);
        return null;
      }
      case "pairToken": {
        if (!srv?.pairing) throw new Error("sendspin server 未运行");
        await srv.pairing.pairWithToken(String(p.clientId), String(p.token));
        this.requestSnapshot(true);
        return null;
      }
      case "pairCancel": {
        srv?.pairing?.cancel(String(p.clientId));
        this.requestSnapshot(true);
        return null;
      }
      case "esphomeStatus": {
        // 6053 已无全局配置:只回每台设备各自的快照(pskConfigured/port 在单设备里)。
        const { esphomeBridge } = await import("./esphomeBridge.js");
        return { devices: srv ? esphomeBridge.snapshot() : [] };
      }
      // 单台设备的 6053 凭据变更:填了密钥就连,清空就断。
      case "esphomeSync": {
        const { esphomeBridge } = await import("./esphomeBridge.js");
        esphomeBridge.syncDevice(String(p.host ?? ""), String(p.psk ?? ""), Number(p.port) || 0);
        this.requestSnapshot(true);
        return null;
      }
      case "esphomeVolume": {
        const { esphomeBridge } = await import("./esphomeBridge.js");
        // 入参 0..100(与前端滑杆一致),桥内部按 0..1 发给设备。
        return esphomeBridge.setVolume(String(p.host ?? ""), Number(p.volume) / 100);
      }
      case "esphomeMute": {
        const { esphomeBridge } = await import("./esphomeBridge.js");
        return esphomeBridge.setMuted(String(p.host ?? ""), p.muted === true);
      }
      case "esphomeReadVolume": {
        const { esphomeBridge } = await import("./esphomeBridge.js");
        const v = esphomeBridge.mirroredVolume(String(p.host ?? ""));
        return v ? { volume: Math.round(v.volume * 100), muted: v.muted } : null;
      }
      case "applyCfg": {
        // 配置热更新(主进程 DB 为单一可信源):只管 server 字段。
        const cfg = p as SendspinIpcConfig;
        if (srv) {
          srv.allowLegacyClients = cfg.allowLegacyClients;
          srv.preferredCodec = cfg.preferredCodec;
        }
        this.requestSnapshot(true);
        return null;
      }
      case "stop":
        // 主进程的 stop:清干净 → 回应 → 入口收到 res 后自行退出。
        await this.deps.stopRuntime();
        this.dispose();
        this.send({ t: "stopped" });
        return null;
      default:
        throw new Error(`未知 sendspin rpc op: ${op}`);
    }
  }

  // dial targets 文件操作走 index.ts 的共享逻辑(同 identityDir)。
  private async dialTargets(): Promise<unknown[]> {
    const idx = await import("./index.js");
    return idx.listDialTargets();
  }
  private async remember(host: string, port: number): Promise<boolean> {
    const idx = await import("./index.js");
    await idx.rememberDialTarget(String(host), Number(port));
    return true;
  }
  private async forget(host: string, port: number): Promise<boolean> {
    const idx = await import("./index.js");
    return idx.forgetDialTarget(String(host), Number(port));
  }

  get nextSeq(): number {
    return ++this.seq;
  }
}
