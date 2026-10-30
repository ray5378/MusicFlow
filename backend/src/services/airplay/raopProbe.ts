// ==================== RAOP TEARDOWN 探测(S1/S3) ====================
//
// 背景(2026-10-30 全屋 HiVi 无声事故):容器重建后,MUZO 固件保留对旧容器的
// 半开 RTSP 会话;新容器对同一设备的 ANNOUNCE/SETUP 直接 `read ECONNRESET`。
// 旧行为:prepareBridgeRoute 失败 → 该设备回落 solo cast(同一条握手必挂)→
// 「在组里但无声且状态正常」,唯一救法是人工 stop→等 10s→play(现场实证一次成功)。
//
// 本模块把该人工步骤自动化:
//  - S1:握手失败 → 先发一次显式 TEARDOWN 探测(新 RTSP 连接,无 session 也发,
//    设备回 454 无害)→ 退避 5s/15s 两档重试完整握手;probe 不可达(设备真离线)
//    立即放弃,不空耗 20s。
//  - S3:容器启动 60s 后(设备清单已由 mDNS 回填)对每台已知 AirPlay 设备各发
//    一次 blind TEARDOWN 探测,把僵死态在用户起播前清掉。
//
// 分层:RTSP 探测的本体(raopTeardownProbe)在 raop.ts(纯协议,子进程执行,
// 无状态可单测);本文件是主进程编排(RPC + 重试梯 + boot 挂钩)。
import { airplaySupervisor } from "./supervisor.js";
import { getAirPlayDevice, getAirPlayDevices } from "./discovery.js";
import { isBridgeOwned } from "./control.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("airplay-raopProbe");

/** 探测结果。reachable=false 时 optionsStatus/teardownStatus 恒 null。 */
export interface RaopProbeResult {
  reachable: boolean;
  /** OPTIONS 响应状态码(null = 无响应/连接失败)。 */
  optionsStatus: number | null;
  /** TEARDOWN 响应状态码(454 = 设备无此会话,无害;null = 未答,可能直接断开)。 */
  teardownStatus: number | null;
  detail: string;
}

/** S1 退避梯:两档,单位 ms。导出供测试钉值。 */
export const BRIDGE_PREPARE_RETRY_BACKOFF_MS = [5_000, 15_000] as const;

/** 握手阶段「设备类」失败判据:ECONNRESET(半开会话最典型)/拒连/超时/RTSP 步骤被掐。
 *  有意排除语义性错误(AP2 凭据缺失 `ap2-` 前缀、设备不存在)——那些重试必复现。 */
const HANDSHAKE_DEVICE_ERROR_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EPIPE|socket hang up|RTSP connect timeout|connect 总超时|RTSP (ANNOUNCE|SETUP|RECORD) failed/i;

export function isBridgeHandshakeDeviceError(msg: string): boolean {
  return HANDSHAKE_DEVICE_ERROR_RE.test(msg);
}

/** 对一台设备发 TEARDOWN 探测(子进程执行;子进程没跑/设备不存在都按不可达回落)。
 *  ⚠️ host/port 必须主进程查好随载荷下发 —— 子进程的 discovery 注册表恒空,
 *  不能按 deviceId 反查(与 bridgePrepareDevice 同一契约)。 */
export async function raopProbeDevice(deviceId: string, timeoutMs = 6_000): Promise<RaopProbeResult> {
  const dev = getAirPlayDevice(deviceId);
  if (!dev) return { reachable: false, optionsStatus: null, teardownStatus: null, detail: `设备不存在: ${deviceId}` };
  if (!airplaySupervisor.isRunning()) {
    return { reachable: false, optionsStatus: null, teardownStatus: null, detail: "airplay 子进程未运行" };
  }
  try {
    return await airplaySupervisor.rpc<RaopProbeResult>("raopProbe", { host: dev.host, port: dev.port, timeoutMs });
  } catch (e) {
    return { reachable: false, optionsStatus: null, teardownStatus: null, detail: `probe rpc 失败: ${(e as Error)?.message || e}` };
  }
}

export interface BridgePrepareRetryDeps {
  /** 首次失败的错误消息(判据入口;非设备类失败时调用方应直接跳过本函数)。 */
  reason: string;
  /** TEARDOWN 探测(每次重试前各发一次)。 */
  probe: () => Promise<RaopProbeResult>;
  /** 完整握手(= 原 bridgePrepareDevice 调用闭包)。 */
  attempt: () => Promise<unknown>;
  onRetry?: (n: number, probe: RaopProbeResult, backoffMs: number) => void;
  onGiveUp?: (n: number, probe: RaopProbeResult) => void;
  onFail?: (n: number, err: unknown) => void;
  onRecovered?: (n: number) => void;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** 测试钩子:替换重试梯的退避睡眠(与 setBridgeRoutesForTest 同风格)。
 *  生产路径不设置 → 走真实 setTimeout;置 null 恢复。 */
let sleepForTest: ((ms: number) => Promise<void>) | null = null;
export function setBridgePrepareRetrySleepForTest(fn: ((ms: number) => Promise<void>) | null): void {
  sleepForTest = fn;
}

/** S1 重试梯:probe → 退避 → 重试握手;probe 不可达立即放弃。
 *  返回是否救回。n 从 1 计(日志口径 retry#1/retry#2)。 */
export async function retryBridgePrepareWithProbe(deps: BridgePrepareRetryDeps): Promise<boolean> {
  if (!isBridgeHandshakeDeviceError(deps.reason)) return false;
  const backoff = deps.backoffMs ?? BRIDGE_PREPARE_RETRY_BACKOFF_MS;
  const sleep = deps.sleep ?? sleepForTest ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let n = 1; n <= backoff.length; n++) {
    const probe = await deps.probe();
    if (!probe.reachable) {
      deps.onGiveUp?.(n, probe);
      return false;
    }
    deps.onRetry?.(n, probe, backoff[n - 1]);
    await sleep(backoff[n - 1]);
    try {
      await deps.attempt();
      deps.onRecovered?.(n);
      return true;
    } catch (err) {
      deps.onFail?.(n, err);
    }
  }
  return false;
}

/** 首轮已确认处理完的设备(成功 probe / 被占用检查跳过):兜底轮绝不再碰。
 *  ⚠️ blind TEARDOWN 无 session 也**真杀会话**(HiVi 实测回 200)—— 用户 12s 后
 *  立刻起播建立的合法桥会话,绝不能被 45s 兜底轮清掉。 */
const bootProbedDevices = new Set<string>();

/** S3:对已知 AirPlay 设备发 blind TEARDOWN 探测(幂等,454 无害)。
 *  @param onlyUnprobed true = 只探测首轮没确认过的设备(兜底轮语义)。
 *  两类设备一律跳过:
 *  ① isBridgeOwned(正被合法桥会话占用 —— 用户可能已起播,blind TEARDOWN 会杀掉它);
 *  ② 兜底轮里首轮已确认过的设备。
 *  设备清单为空(mDNS 发现未完成)时直接跳过本轮。 */
export async function runBootClearProbes(onlyUnprobed = false): Promise<void> {
  const devices = getAirPlayDevices();
  if (devices.length === 0) {
    log.info("[boot-probe] 设备清单为空(发现未完成),跳过本轮");
    return;
  }
  log.info(`[boot-probe] 启动后清理探测:${devices.length} 台 AirPlay 设备${onlyUnprobed ? "(兜底轮,只补首轮未确认的)" : ""}`);
  for (const d of devices) {
    if (isBridgeOwned(d.id)) {
      bootProbedDevices.add(d.id);
      log.info(`[boot-probe] device=${d.id} 正被桥会话占用(用户已起播)→ 跳过`);
      continue;
    }
    if (onlyUnprobed && bootProbedDevices.has(d.id)) continue;
    bootProbedDevices.add(d.id);
    const r = await raopProbeDevice(d.id);
    log.info(`[boot-probe] device=${d.id} host=${d.host}:${d.port} reachable=${r.reachable} options=${r.optionsStatus ?? "-"} teardown=${r.teardownStatus ?? "-"} ${r.detail}`);
    // 逐台间隔 300ms:探测是低风险操作,但别对同网段固件瞬间连开多连接。
    await new Promise((r2) => setTimeout(r2, 300));
  }
}

/** S3 boot 挂钩:12s 首轮 + 45s 兜底轮(只补首轮未确认的设备)。
 *  提前依据:loadPersistedAirPlayDevices() 启动即恢复持久化清单,不等 mDNS;
 *  子进程 fork + 握手 ~3s。12s 首轮赶在用户起播前;45s 兜底覆盖 mDNS 迟到的
 *  设备 —— 已确认过的设备(含用户已起播的)绝不重复探测。 */
export function scheduleBootClearProbes(): void {
  const t1 = setTimeout(() => { void runBootClearProbes(false).catch((e) => log.error(`[boot-probe] 首轮失败: ${(e as Error)?.message || e}`)); }, 12_000);
  t1.unref?.();
  const t2 = setTimeout(() => { void runBootClearProbes(true).catch((e) => log.error(`[boot-probe] 兜底轮失败: ${(e as Error)?.message || e}`)); }, 45_000);
  t2.unref?.();
}

/** 测试钩子:清空 bootProbedDevices(模块级状态,跨用例必须重置)。 */
export function resetBootProbeStateForTest(): void {
  bootProbedDevices.clear();
}
