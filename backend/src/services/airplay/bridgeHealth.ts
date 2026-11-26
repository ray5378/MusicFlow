/** 桥侧缓冲水位（主进程共享单例）。
 *
 *  来源：airplay 子进程每 2s 推送一条 `bridgeStats` 事件。为什么不走 RPC：
 *  `airplaySupervisor.rpc("bridgeStatus")` 会因 supervisor.running 与真实子进程状态
 *  不同步而误报「子进程未运行」（240 2026-11-19 实测：桥 tick 一直在打、音频一直在播，
 *  RPC 却全拒）。
 *
 *  消费方：streamEngine 低缓冲自愈。inQueueMs 是设备侧真实缓冲（正常 5000~6000、
 *  被追发抽干时 0~175），sendspin 侧算不出 —— `depthMs` 含 30s 未投递量、
 *  `queuedMs` 健康时本就小，两者都已证伪。
 */
export interface BridgeHealthRow {
  inQueueMs: number;
  /** [S8 复核④]如实命名:入向 ring 积压(ms,同 inQueueMs 口径)—— sendspin 逐设备
   *  投递窗口(ceil = max(now+2s, now+backlog+500ms))的数据源。 */
  backlogMs: number;
  /** [方案A 2026-11-26]设备侧「已收未播」时长(ms),= bridgeSession tick 的 `deltaUs/1000`
   *  (见 bridgeSession 顶部 §10.5:`deltaUs` 才是「设备提前拿到多久的音频」)。
   *  `backlogMs` 只覆盖「尚未写进 RAOP 的垫子」,不含已发出但设备还没播完的那段;
   *  两者相加才是「泵一停投,桥还能撑多久」的完整口径 —— 曲末续静音量的判据用它。 */
  deviceLeadMs: number;
  at: number;
}

const rows = new Map<string, BridgeHealthRow>();

/** 超过该时长未更新视为陈旧（tick 2s 一次，给 3 个周期余量）。 */
const STALE_MS = 6_000;

/** 注意：必须挂 globalThis —— tsc 的 ESM 解析在 supervisor 与 streamEngine 之间
 *  曾出现同一模块被加载成两个实例（240 实测：supervisor 收到 inQueue=5525，
 *  streamEngine 读到的 min() 恒为 Infinity）。挂全局对象是唯一可靠的跨模块共享。 */
const GKEY = "__mf_bridgeHealth_v1";
type Health = {
  record(deviceId: string, inQueueMs: number, backlogMs?: number, deviceLeadMs?: number): void;
  min(): number;
  /** [S8 任务 2]全部有效设备的积压快照(key=deviceId)—— 转发 sendspin 用。 */
  backlogs(): Record<string, number>;
  /** [方案A 2026-11-26]全部有效设备的「已收未播」快照(key=deviceId)—— 与 backlogs
   *  同链上行,泵侧据此算「桥链路真实余量」。 */
  deviceLeads(): Record<string, number>;
  reset(): void;
};
const existing = (globalThis as unknown as Record<string, Health | undefined>)[GKEY];
export const bridgeHealth: Health = existing ?? {
  record(deviceId: string, inQueueMs: number, backlogMs?: number, deviceLeadMs?: number): void {
    if (!Number.isFinite(inQueueMs)) return;
    const prev = rows.get(deviceId);
    rows.set(deviceId, {
      inQueueMs,
      backlogMs: Number.isFinite(backlogMs) ? (backlogMs as number) : (prev?.backlogMs ?? 0),
      deviceLeadMs: Number.isFinite(deviceLeadMs)
        ? (deviceLeadMs as number)
        : (prev?.deviceLeadMs ?? 0),
      at: Date.now(),
    });
  },

  /** 最薄那座桥的缓冲（ms）；无有效条目返回 Infinity（判据不成立）。 */
  min(): number {
    const now = Date.now();
    let m = Number.POSITIVE_INFINITY;
    for (const v of rows.values()) {
      if (now - v.at > STALE_MS) continue;
      if (v.inQueueMs < m) m = v.inQueueMs;
    }
    return m;
  },

  backlogs(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [id, v] of rows.entries()) {
      if (now - v.at > STALE_MS) continue;
      out[id] = v.backlogMs;
    }
    return out;
  },

  deviceLeads(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [id, v] of rows.entries()) {
      if (now - v.at > STALE_MS) continue;
      out[id] = v.deviceLeadMs;
    }
    return out;
  },

  reset(): void {
    rows.clear();
  },
};
(globalThis as unknown as Record<string, Health>)[GKEY] = bridgeHealth;
