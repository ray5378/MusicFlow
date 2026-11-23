// ==================== 组内容广播器（一次解码，N 路独立投递）====================
//
// 定位：替代「组共享 ring + 每设备一个水位」的**唯一分发点**。
//
// 旧模型的问题（2026-11-23 实测）：
//   所有播放器共用一条 ring，各自只有一个 watermark；两个游标在同一环上漂走后
//   互相污染 —— HiVi wm=now+45.5s（追前沿，听众侧跳进度）、
//   iEAST wm=now−7.2s（喂过期内容，全判 late、队列 0、静音 19 分钟）。
//
// 新模型（对齐 MA 的每播放器进程）：
//   内容只解码一次 ⇒ 广播给每个 sink（= 一台播放器的投递句柄/子进程）；
//   每个 sink 有**自己的**队列、自己的积压上限、自己的丢弃计数；
//   一个 sink 卡住只让它自己的队列溢出丢帧，**绝不阻塞、也绝不改别人的游标**。
//
// 纪律：
//   · 广播永不 await（不因慢 sink 阻塞生产者）；
//   · 队列超上限 ⇒ 丢**最旧**（保实时，宁可缺口也不追历史）；
//   · 每个 sink 的统计（入队/投出/丢弃/积压）用于逐设备排障。

export interface BroadcastFrame {
  tsUs: number;
  nFrames: number;
  data: Uint8Array;
}

export interface SinkStats {
  enqueued: number;
  delivered: number;
  dropped: number;
  /** 当前积压（帧） */
  queued: number;
  lastTsUs: number;
}

export interface Sink {
  /** 投递一帧；返回 false 表示本拍投不进去（背压），队列会继续积压 */
  push(frame: BroadcastFrame): boolean;
  /** 队列上限（帧数）；超出丢最旧 */
  maxQueue?: number;
}

interface SinkState {
  sink: Sink;
  queue: BroadcastFrame[];
  stats: SinkStats;
}

export class GroupBroadcaster {
  private readonly sinks = new Map<string, SinkState>();

  addSink(id: string, sink: Sink): void {
    this.sinks.set(id, {
      sink,
      queue: [],
      stats: { enqueued: 0, delivered: 0, dropped: 0, queued: 0, lastTsUs: 0 },
    });
  }

  removeSink(id: string): void {
    this.sinks.delete(id);
  }

  has(id: string): boolean {
    return this.sinks.has(id);
  }

  sinkIds(): string[] {
    return [...this.sinks.keys()];
  }

  /** 把一个内容帧广播给所有 sink（O(N) 入队，永不阻塞）。 */
  broadcast(frame: BroadcastFrame): void {
    for (const st of this.sinks.values()) {
      const cap = st.sink.maxQueue ?? 500;
      st.queue.push(frame);
      st.stats.enqueued += 1;
      while (st.queue.length > cap) {
        st.queue.shift();
        st.stats.dropped += 1;
      }
    }
  }

  /**
   * 驱动每个 sink 尝试投递（由本进程的定时器调用）。
   * 每个 sink 独立消化自己的队列：投不进去就保留，下拍再来。
   */
  flush(maxPerSink = 50): void {
    for (const st of this.sinks.values()) {
      let n = 0;
      while (st.queue.length > 0 && n < maxPerSink) {
        const frame = st.queue[0];
        let ok = false;
        try {
          ok = st.sink.push(frame);
        } catch {
          ok = false;
        }
        if (!ok) break; // 背压：留到下一拍，**不丢**（只有超上限才丢）
        st.queue.shift();
        st.stats.delivered += 1;
        st.stats.lastTsUs = frame.tsUs;
        n += 1;
      }
      st.stats.queued = st.queue.length;
    }
  }

  stats(): Record<string, SinkStats> {
    const out: Record<string, SinkStats> = {};
    for (const [id, st] of this.sinks) out[id] = { ...st.stats, queued: st.queue.length };
    return out;
  }

  /** 换代：清空所有队列（内容时间线整体重锚，旧内容不再投）。 */
  resetAll(): void {
    for (const st of this.sinks.values()) {
      st.queue.length = 0;
      st.stats.queued = 0;
    }
  }
}
