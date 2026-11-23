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
//
// ===== 对标 MA =====
// MA 位置：music_assistant/providers/airplay/stream.py:327（每播放器一个 cliairplay
//          子进程：AsyncProcess(args, stdin=True, stdout=True, stderr=True)）、
//          stream.py:93-99（_STDIN_DRAIN_TIMEOUT=2s 注释：写缓冲高水位 64KiB
//          ≈ 1/3s PCM，stdin 排空超时 ⇒ 读端卡死 ⇒ 冷重启回退）、
//          stream.py:443-449（write_audio 直接 await write，写满即阻塞生产者）。
// MA 语义：音频经 stdin 写入**每播放器专属**的子进程，写入自带背压 —— 生产者
//          被某台设备拖慢只影响它自己；MA **不丢帧**（宁可阻塞/冷重启/FLUSH 排空）。
// 我们：GroupBroadcaster = 「一次解码 → N 路独立投递」的唯一分发点，等价
//          MA「每播放器一条 stdin」的缓冲隔离面，但投递策略**必须不同**：
//          我们的生产者是全组共享的解码泵，一个慢设备阻塞它 = 全组停摆，
//          所以 broadcast 永不阻塞、积压只在各自队列、超上限丢最旧；
//          设备卡死的处置改为「设备侧背压(queuedMs>4s 拒收) + 游标跳转重锚」，
//          不走 MA 的冷重启回退（那是进程级故障域的事，见 host.ts）。

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

  /**
   * 把一个内容帧广播给所有 sink（O(N) 入队，永不阻塞）。
   *
   * 对标 MA：stream.py:443-449 `write_audio` 直接 `await self._cli_proc.write(data)`
   * —— 写满 stdin（高水位 64KiB ≈ 1/3s PCM）就阻塞生产者。我们不能照抄：
   * MA 的生产者是单播放器专属，阻塞它无伤；我们的生产者是**共享解码泵**，
   * 阻塞它 = 全组停摆。所以这里只入队 + 丢最旧，背压被推迟到 flush/push。
   */
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
        if (!ok) {
          // 背压：留到下一拍，**不丢**（只有超上限才丢）。
          // 对标 MA：MA 遇写入停滞走 stdin 排空 + 冷重启（stream.py:96-99、
          // flush 的 stdin_quiesced），从不丢已写内容；我们选择丢最旧 ——
          // 「共享泵不被单设备拖死」的代价，宁可有缺口也不追历史（见文件头纪律）。
          break;
        }
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
