// ==================== 重启后「HA 音量回放」守卫(服务端兜底) ====================
//
// 现场(2026-10-21,240 容器 v4.6.55):
//   容器启动 07:10:21Z,`airplay_device_state` 行却在 07:10:52Z 被写成 20 ——
//   服务端自身**不会在启动时写音量**,这笔写入只可能来自外部请求;临时探针抓到
//   UA = `HomeAssistant/2026.10.2 aiohttp/3.14.5`。完整链路:
//     后端重启 → `/v1/peers` 瞬时缺 peer → HA 集成立刻剪掉实体 → peer 回归后
//     实体重建 → HA 在实体注册时回放该 entity 上次的 `volume_level`(旧快照 20)
//     → `POST /v1/peers/<airplay:id>/volume {volume:20}`。
//   即使服务端已把音量落库(4.6.54),这笔"回放"仍会覆盖持久值,于是每次重启
//   都回到 20。HA 集成侧已加 120s 剪枝恢复窗口(v2.1.2),但用户未升级集成时
//   服务端仍需一层兜底。
//
// 守护策略:
//   - 进程启动后的 `BOOT_VOLUME_GUARD_MS` 内;
//   - 写方 UA 以 `HomeAssistant/` 开头(HA 的 aiohttp 客户端,可精确识别);
//   - 每个 peer 的 volume / mute **各只拦第一笔** —— 之后用户在 HA 里手动调音量
//     不受影响(实体的回放只会发生一次)。
//   命中即忽略(仍回 200,避免 HA 侧报错),打 warn,状态继续用持久值回吐。
//
// 为什么按 UA 而不是按值(20/80):值没有语义 —— 用户完全可能就是想设 20;
// 而「HA 在启动窗口内的第一笔写入」正是实体注册回放的稳定特征。
export const BOOT_VOLUME_GUARD_MS = 120_000;

/** HA 集成走 aiohttp,UA 形如 `HomeAssistant/2026.10.2 aiohttp/3.14.5 Python/3.14`。 */
export const HA_UA_PREFIX = /^HomeAssistant\//i;

/** 该笔音量/静音写入是否应被忽略(启动期 HA 实体回放)。
 *  纯函数:时钟、启动时刻、UA、已拦集合全部由调用方注入,便于单测覆盖边界。 */
export function shouldIgnoreBootVolumeEcho(opts: {
  now: number;
  bootAt: number;
  ua: string;
  peerId: string;
  op: "volume" | "mute";
  /** 进程级的"已拦过"集合(volume / mute 各按 peer 独立)。 */
  seen: Set<string>;
}): boolean {
  if (!Number.isFinite(opts.bootAt) || opts.now - opts.bootAt > BOOT_VOLUME_GUARD_MS) return false;
  if (!HA_UA_PREFIX.test(opts.ua || "")) return false;
  const key = `${opts.op}:${opts.peerId}`;
  if (opts.seen.has(key)) return false; // 只拦第一笔:后续视为用户真实操作
  opts.seen.add(key);
  return true;
}
