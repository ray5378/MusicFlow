// seek 落位保护窗的**纯判定函数**(无 SOAP / 无全局状态,供 CI 单测直接锁死)。
//
// 为什么要抽出来:`getDeviceStatus` 里的这段判定是「拖动后进度条跳回原位」的
// 服务端唯一防线 —— 一旦有人手滑改宽松(或改错方向),表现只会是"偶发跳回"
// 这种最难复现的形态,靠手测极难发现。抽成纯函数后,CI 用标准库级别的
// 用例把它钉死(与 hass-musicflow 的 `seek_utils.py` 同一思路)。
//
// 病根回顾:DLNA Seek 是"尽力而为"的异步命令,设备接受后不会立刻改
// GetPositionInfo 的读数(实测 MUZO/HiVi 类固件要 1s 以上)。若把这段窗口内
// 的读数当作可信采样写进外推基线,设备随后报 0(播转码 chunked 流时恒如此)时
// 就会从**seek 前的位置**继续外推 → 前端进度条被拽回拖动前。

/** 保护窗时长(ms):覆盖 DLNA Seek 生效延迟 + 一次 5s 采样周期。 */
export const SEEK_GUARD_MS = 6000;

/** 读数可信容差(秒):设备落位精度 + 采样抖动 + 时间基准漂移的合计余量。 */
export const SEEK_SETTLE_TOLERANCE_SEC = 2.5;

export interface SeekGuard {
  /** 用户下发的目标位置(秒)。 */
  target: number;
  /** 下发时刻(ms epoch)。 */
  at: number;
}

/** 保护窗是否已过期(过期即解除,恢复正常采纳设备读数)。
 *
 *  边界取 `>=`:与 hass-musicflow `seek_utils.seek_guard_active`
 *  (`now < guard_until` 才算有效)同语义 —— 三仓对"6s 护栏"的边界必须一致,
 *  否则同一时刻服务端还挡着、集成已放开,会拼出"偶尔跳回"这种最难查的组合。 */
export function seekGuardExpired(guard: SeekGuard, sampledAt: number, windowMs = SEEK_GUARD_MS): boolean {
  return sampledAt - guard.at >= windowMs;
}

/**
 * 该采样时刻设备**应当**处于的位置(秒)。
 *
 * 播放态按墙钟外推(设备落位后应随时间前进);暂停/缓冲/停止态不推进
 * (停在目标上等用户继续)——后者若也外推,会把暂停中的拖动判成"陈旧",
 * 反而拒掉唯一正确的读数。
 */
export function seekExpectedPosition(guard: SeekGuard, sampledAt: number, playing: boolean): number {
  const elapsed = Math.max(0, sampledAt - guard.at) / 1000;
  return guard.target + (playing ? elapsed : 0);
}

/**
 * 本次读数是否属于「seek 之前的陈旧采样」(是 → 应丢弃,用预期值回填)。
 *
 * 双向判定:向前拖时陈旧读数**小于**预期,向后拖时陈旧读数**远大于**预期 ——
 * 只判单方向的实现会在"往回拖"时漏掉(实测就是这么漏的)。
 * `reported <= 0` 交给调用方按"设备不报位置"处理(走外推),不在此判定。
 */
export function isSeekReadingStale(
  guard: SeekGuard,
  sampledAt: number,
  reported: number,
  playing: boolean,
  toleranceSec = SEEK_SETTLE_TOLERANCE_SEC,
): boolean {
  if (reported <= 0) return false;
  return Math.abs(reported - seekExpectedPosition(guard, sampledAt, playing)) > toleranceSec;
}
