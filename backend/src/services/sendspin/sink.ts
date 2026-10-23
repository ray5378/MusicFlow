// ==================== Sendspin pump 旁路 sink(非 sendspin 协议出口)====================
//
// 背景(2026-10-23 AirPlay×Sendspin 同步群组课题):
//   用户组 `ug:<groupId>` 的共享 pump 只把 PCM 编码后发给 sendspin 客户端,**没有**
//   旁路出口。于是 AirPlay 设备要么独立 RAOP 推流(与 sendspin 各走各的时间线,
//   只"roughly 同时起播"),要么根本进不了组。要做采样级同步,唯一办法是让
//   AirPlay 变成 pump 的一个**音频 sink**:与 sendspin 客户端吃同一帧、同一个
//   `tsUs` 时间戳,同步由 pump 的时间线统一裁决(与 MA 的 BridgePlayerRole 同构)。
//
// 设计要点:
//   - pump 每 FRAME_MS(25ms)产出一帧 Float32 交错 PCM(48k / 2ch),在
//     `SendspinGroup.pushFrame` 里同步分发给全部已注册 sink;
//   - **onFrame 必须同步、不得抛错、不得长时间阻塞**:它在 pushLoop 的关键路径上,
//     抛错会打断整组推流,阻塞会把 25ms 节拍打散(设备 Lost sync);
//   - 传进来的 `pcm` 是 pump 复用的帧缓冲,**要留存的 sink 必须立刻拷贝**
//     (airplay 桥接实现就是同步转 s16 拷走);
//   - 返回该帧**单声道样本数**:零 sendspin 成员(纯 AirPlay 组)时 pump 没有编码
//     产出,时间线会走「编码器疑似失效」降级分支;有了这个返回值,pump 可以按
//     sink 真实消费量推进,纯 AirPlay 组不必再假造 sendspin 成员。
import { CHANNELS } from "./encoding.js";

/** pump 旁路 sink(实现方:AirPlay 桥接、将来的其它协议出口)。 */
export interface PumpSink {
  /** 组内唯一 id(同一组重复注册会替换旧的)。 */
  readonly id: string;
  /** 收到一帧交错 Float32 PCM(SAMPLE_RATE / CHANNELS,见 encoding.ts)。
   *  ⚠️ pcm 为 pump 复用缓冲:留存前必须拷贝。必须同步返回,异常会被 hub 吞掉并计数。 */
  onFrame(tsUs: bigint, pcm: Float32Array): void;
  /** 时间线重置(切歌 / seek / 重新锚定):丢弃残留缓冲,等下一帧重新对齐。
   *  `positionMs` 为重置后的内容位置(seek 时给出,切歌为 0)。 */
  onReset?(positionMs?: number): void;
  /** 停止(组停止 / 成员变更 / pump 收尾):释放连接与缓冲。 */
  onStop?(): void;
}

/** 按「pump 组名」索引的 sink 注册表。
 *
 *  进程内单例:生产 fork 模式下 sendspin 子进程持有 pump,注册表也就只在该进程内有意义
 *  (主进程那份永远是空的,不参与分发)。 */
export class PumpSinkHub {
  private readonly byGroup = new Map<string, PumpSink[]>();
  /** 分发异常计数(仅用于日志节流,不阻断推流)。 */
  private errorCount = 0;

  /** 注册 sink(同 id 视为替换,幂等 —— 组重建/重连不会叠加出两份)。 */
  register(group: string, sink: PumpSink): void {
    const list = this.byGroup.get(group) ?? [];
    const idx = list.findIndex((s) => s.id === sink.id);
    if (idx >= 0) list[idx] = sink;
    else list.push(sink);
    this.byGroup.set(group, list);
  }

  /** 摘除指定 sink(找不到即无操作)。 */
  unregister(group: string, id: string): void {
    const list = this.byGroup.get(group);
    if (!list) return;
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return;
    if (next.length === 0) this.byGroup.delete(group);
    else this.byGroup.set(group, next);
  }

  /** 当前已注册的 sink(只读快照:分发期间允许 sink 自行摘除)。 */
  list(group: string): PumpSink[] {
    const list = this.byGroup.get(group);
    return list ? list.slice() : [];
  }

  has(group: string): boolean {
    return (this.byGroup.get(group)?.length ?? 0) > 0;
  }

  /** 分发一帧。返回该帧的**单声道样本数**(0 表示没有 sink 消费)。
   *
   *  异常吞掉而非上抛:旁路 sink 坏掉不该连带整组 sendspin 静音(与 pushFrame 里
   *  「单成员编码失败不影响其它组」同一个原则)。 */
  dispatch(group: string, tsUs: bigint, pcm: Float32Array): number {
    const list = this.byGroup.get(group);
    if (!list || list.length === 0) return 0;
    let delivered = 0;
    for (const sink of list) {
      try {
        sink.onFrame(tsUs, pcm);
        delivered++;
      } catch (e) {
        this.errorCount++;
        // 只在首次与前 5 次打日志:一条持续抛错的 sink 不该把日志刷爆。
        if (this.errorCount <= 5) {
          try {
            console.warn(`[pump-sink] ${group}/${sink.id} onFrame 失败: ${(e as Error)?.message || e}`);
          } catch { /* ignore */ }
        }
      }
    }
    return delivered > 0 ? Math.floor(pcm.length / CHANNELS) : 0;
  }

  /** 时间线重置(切歌 / seek)。逐 sink 调用 onReset,异常吞掉。 */
  reset(group: string, positionMs?: number): void {
    for (const sink of this.list(group)) {
      try {
        sink.onReset?.(positionMs);
      } catch { /* sink 自身问题不阻断 pump */ }
    }
  }

  /** 停止并摘除该组全部 sink(组停止 / 组销毁)。 */
  stopAll(group: string): void {
    const list = this.byGroup.get(group);
    if (!list) return;
    this.byGroup.delete(group);
    for (const sink of list) {
      try {
        sink.onStop?.();
      } catch { /* ignore */ }
    }
  }

  /** 仅供测试:清空全部注册。 */
  clear(): void {
    this.byGroup.clear();
    this.errorCount = 0;
  }
}

/** 进程内单例。 */
export const pumpSinks = new PumpSinkHub();
