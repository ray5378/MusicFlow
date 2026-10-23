// ==================== 群组 × AirPlay 桥接编排(主进程侧)====================
//
// 分工:
//   - **主进程**(本文件):解析组成员、拿设备连接参数(host/port/pk/et 来自 discovery)、
//     经 supervisor RPC 让 airplay 子进程起/停桥接会话、把桥接端口交给 sendspin;
//   - **airplay 子进程**:RAOP 握手 + `BridgeRing`(按墙钟取内容)+ 7.98ms 推流;
//   - **sendspin 子进程**:pump 产出 PCM → `AirPlayBridgeSink` → 本地 TCP → airplay 子进程。
//
// 为什么桥接端口从子进程上报:端口由内核随机分配(每次重启可能变),主进程只在
// mainReady 时拿到一次(mirror.bridgePort),不能硬编码。
import { getGroupManager, splitMemberId } from "./index.js";
import { getAirPlayDevice } from "../airplay/discovery.js";
import { planCliRoute } from "../airplay/cliParams.js";
import { airplaySupervisor } from "../airplay/supervisor.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("group");

/** 桥接 send_ahead 的安全余量(微秒),见 GroupBridgeInfo.minSendAheadUs。 */
const BRIDGE_AHEAD_MARGIN_US = 200_000;

/** 交给 sendspin pump 的桥接目标(纯数据,随 groupPlay RPC 下发)。 */
export interface GroupBridgeInfo {
  devices: string[];
  host: string;
  port: number;
  /** pump 的 send_ahead **下限**(微秒)= 桥接设备最大播放延迟 + 安全余量。
   *
   *  来由(2026-10-23 真机实锤):桥接设备不是 sendspin WS 成员,pump 默认只按
   *  sendspin 成员协商提前量(默认 800ms);而 RAOP 设备缓冲恒 >= 1s。于是桥接侧
   *  「此刻该送出的内容」= now + 1000ms,超前于 pump 已生产内容 200ms ⇒ 每包欠载
   *  ⇒ 两台 AP 全程静音(实测 PCM maxAbs=0)。抬到设备延迟之上后 99%+ 帧有声。 */
  minSendAheadUs?: number;
}

/** 组内 airplay 成员(裸 deviceId,含离线)。 */
export function getGroupAirPlayMemberIds(groupId: string): string[] {
  const g = getGroupManager().get(groupId);
  if (!g) return [];
  return g.memberIds
    .map((m) => splitMemberId(m))
    .filter((s): s is { kind: "airplay"; id: string } => !!s && s.kind === "airplay")
    .map((s) => s.id);
}

/** 当前桥接端口(airplay 子进程未就绪/未启用桥接时返回 null)。 */
export function getAirPlayBridgePort(): number | null {
  if (!airplaySupervisor.isRunning()) return null;
  const port = airplaySupervisor.mirror.bridgePort;
  return typeof port === "number" && port > 0 ? port : null;
}

/**
 * 为组内的 airplay 成员建立桥接会话(RAOP 握手 + 环形缓冲)。
 *
 * 返回 `null` 的三种情况(都会记日志,不抛错 —— 组里可能只有 sendspin 成员):
 *   1. 组内没有 airplay 成员;
 *   2. airplay 运行在 in-proc 模式(桥接需要子进程承载 PCM 接收端);
 *   3. 没有任何一台 airplay 设备握手成功。
 */
export async function startGroupAirPlayBridge(groupId: string): Promise<GroupBridgeInfo | null> {
  const devices = getGroupAirPlayMemberIds(groupId);
  if (devices.length === 0) return null;

  if (!airplaySupervisor.isRunning()) {
    log.warn(`[airplay-bridge] 组 ${groupId} 含 airplay 成员,但 airplay 未以子进程运行(桥接需要 fork 模式),本次跳过`);
    return null;
  }
  const port = getAirPlayBridgePort();
  if (!port) {
    log.warn(`[airplay-bridge] airplay 子进程未上报桥接端口,本次跳过(group=${groupId})`);
    return null;
  }

  /** 单台设备握手成功后的实测参数。 */
  interface CastOk {
    deviceId: string;
    frames: number;
    rate: number;
    route: string;
    host: string;
    port: number;
    ms: number;
  }

  // 凭据在 DB(airplay_devices.hap_credentials):动态 import 避免 group 层反向拖入
  // control.ts 的 DB/DLNA/peer 依赖(本模块此前对 control 只有这一处运行时依赖)。
  const { getAirPlayCredentials } = await import("../airplay/control.js");

  const castOne = async (deviceId: string): Promise<CastOk | null> => {
    const dev = getAirPlayDevice(deviceId);
    if (!dev) {
      log.warn(`[airplay-bridge] 设备 ${deviceId} 不在设备表,跳过`);
      return null;
    }
    if (!dev.available) {
      log.warn(`[airplay-bridge] 设备 ${deviceId}(${dev.name}) 当前离线,跳过`);
      return null;
    }
    const t0 = Date.now();
    try {
      // 通道/端口/TXT 统一装配:cli(AP2 走 7000 / AP1 走 5000)或自研 RAOP 兜底。
      const plan = planCliRoute(dev, { creds: getAirPlayCredentials(deviceId) });
      const cast = await airplaySupervisor.rpc(
        "bridgeCast",
        {
          deviceId,
          host: plan.host,
          port: plan.port,
          pk: dev.pk,
          et: dev.et,
          route: plan.route,
          cli: plan.cli,
        },
        45_000,
      ) as { latencyFrames?: number; sampleRate?: number } | null;
      const frames = Number(cast?.latencyFrames) || 0;
      const rate = Number(cast?.sampleRate) || 44100;
      log.info(`[airplay-bridge] 桥接会话已建立 device=${deviceId}(${dev.alias || dev.name}) ${plan.route}://${plan.host}:${plan.port} 握手=${Date.now() - t0}ms`);
      return { deviceId, frames, rate, route: plan.route, host: plan.host, port: plan.port, ms: Date.now() - t0 };
    } catch (e) {
      log.warn(`[airplay-bridge] 设备 ${deviceId} 桥接握手失败(${Date.now() - t0}ms): ${(e as Error)?.message || e}`);
      return null;
    }
  };

  // ★ 并行握手(2026-10-24 真机实锤,不可回退成串行):
  //   串行时第 2 台必须等第 1 台握手完 —— 实测 3832ms + 2772ms,两台会话的
  //   RECORD 延迟测量与 `START_UNIX_MS` 锚点落在**不同时刻**,成员之间出现
  //   约 0.8s 的真实音频错位(230/231 两台 AP2 接收端 PCM 包络互相关实测:
  //   峰 corr=0.779 @ +0.80s,而 lag=0 时只有 0.464)。并行握手让两台在同一时刻
  //   完成握手、同一时刻开播,错位随之收敛;顺带把组起播从 7~16s 压到一次握手的时间。
  const settled = await Promise.all(devices.map((d) => castOne(d)));
  const usable: string[] = [];
  const okList = settled.filter((x): x is CastOk => !!x);
  // 失败的再给一次机会:实测存在 FIFO 被并发拆除导致的偶发握手失败(ENOENT),
  // 单次重试代价约 1 次握手,但能把「整场静音」救回来。
  const failed = devices.filter((d) => !okList.some((x) => x.deviceId === d));
  if (failed.length > 0) {
    log.warn(`[airplay-bridge] ${failed.length} 台成员首轮握手失败,重试一次: ${failed.join(",")}`);
    const retried = await Promise.all(failed.map((d) => castOne(d)));
    for (const r of retried) if (r) okList.push(r);
  }

  let maxLatencyFrames = 0;
  let maxLatencyRate = 44100;
  for (const c of okList) {
    if (c.frames > maxLatencyFrames) {
      maxLatencyFrames = c.frames;
      maxLatencyRate = c.rate || 44100;
    }
    usable.push(c.deviceId);
  }

  if (usable.length === 0) return null;
  // 余量 200ms:探针实测「提前量 = 延迟 + 200ms」时 underrun 仅 2.4k/238k 帧(99%+ 有声),
  // 而「提前量 = 延迟 - 200ms」时 100% 静音。余量同时吸收 pump 首帧的启动抖动。
  const minSendAheadUs =
    maxLatencyFrames > 0
      ? Math.round((maxLatencyFrames / maxLatencyRate) * 1_000_000) + BRIDGE_AHEAD_MARGIN_US
      : undefined;
  if (minSendAheadUs) {
    log.info(`[airplay-bridge] pump send_ahead 下限 = ${minSendAheadUs}us(设备最大延迟 ${maxLatencyFrames} 帧 @${maxLatencyRate}Hz + 余量 ${BRIDGE_AHEAD_MARGIN_US}us)`);
  }
  return { devices: usable, host: "127.0.0.1", port, ...(minSendAheadUs ? { minSendAheadUs } : {}) };
}

/** 拆除组内 airplay 成员的桥接会话(幂等)。 */
export async function stopGroupAirPlayBridge(groupId: string, reason = ""): Promise<void> {
  const devices = getGroupAirPlayMemberIds(groupId);
  if (devices.length === 0 || !airplaySupervisor.isRunning()) return;
  for (const deviceId of devices) {
    try {
      await airplaySupervisor.rpc("stopSession", { deviceId }, 10_000);
    } catch (e) {
      log.debug(`[airplay-bridge] 停止 ${deviceId} 失败${reason ? `(${reason})` : ""}: ${(e as Error)?.message || e}`);
    }
  }
}

/** 单台设备的桥接会话拆除。
 *
 *  ⚠️ 与 `stopGroupAirPlayBridge` 的区别:后者遍历**当前组内**的 airplay 成员,
 *  所以"成员从组里摘除"这一动作发生时,被摘掉的设备已经不在列表里、不会被清到 ——
 *  必须用本函数按 deviceId 单独收口,否则它的 RAOP 会话会一直挂着(设备侧表现为
 *  "连接还在但没声音",直到超时)。
 */
export async function stopAirPlayMemberBridge(deviceId: string, reason = ""): Promise<void> {
  if (!airplaySupervisor.isRunning()) return;
  try {
    await airplaySupervisor.rpc("stopSession", { deviceId }, 10_000);
    log.info(`[airplay-bridge] 成员 ${deviceId} 的桥接会话已拆除${reason ? `(${reason})` : ""}`);
  } catch (e) {
    log.debug(`[airplay-bridge] 停止 ${deviceId} 失败${reason ? `(${reason})` : ""}: ${(e as Error)?.message || e}`);
  }
}

/** 组 seek:让 airplay 侧 RAOP FLUSH + 清空环形缓冲(内容推进由 pump 负责)。 */
export async function seekGroupAirPlayBridge(groupId: string, seconds: number): Promise<void> {
  const devices = getGroupAirPlayMemberIds(groupId);
  if (devices.length === 0 || !airplaySupervisor.isRunning()) return;
  for (const deviceId of devices) {
    try {
      await airplaySupervisor.rpc("bridgeSeek", { deviceId, seconds }, 10_000);
    } catch (e) {
      log.debug(`[airplay-bridge] ${deviceId} seek 失败: ${(e as Error)?.message || e}`);
    }
  }
}

/** 组音量 → 各 airplay 设备音量(走既有 DLNA 转发回落的统一通道)。 */
export async function setGroupAirPlayVolume(groupId: string, volume: number): Promise<void> {
  const devices = getGroupAirPlayMemberIds(groupId);
  if (devices.length === 0) return;
  const vol = Math.min(100, Math.max(0, Math.round(volume)));
  const { setAirPlayVolume } = await import("../airplay/control.js");
  for (const deviceId of devices) {
    try {
      await setAirPlayVolume(deviceId, vol);
    } catch (e) {
      log.debug(`[airplay-bridge] ${deviceId} 音量下发失败: ${(e as Error)?.message || e}`);
    }
  }
}
