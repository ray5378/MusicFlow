// 端到端集成测试:模拟 DLNA 设备状态机,验证 MA 式链路完整工作。
//
// 链路:GENA/模拟状态上报 → PlayerController(双层去抖 + 乐观窗口)→
//       PlaybackTracker(状态迁移判断)→ onDecision → QueueController(切歌)。
//
// 不依赖真实 SOAP/SSDP,用 FakeDlnaDevice 状态机模拟设备行为。
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState, type PlayerState, type QueueItem, type ProtocolPlayer } from "../../src/services/player/types.js";
import { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";
import { sqlite } from "../../src/db/index.js";

beforeAll(() => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS device_queues (
      device_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT -1,
      play_mode TEXT NOT NULL DEFAULT 'order',
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

/** 模拟 DLNA 设备状态机。
 *  - playMedia(item): 模拟 castToDevice 真实时序:Stop→GENA STOPPED→
 *    SetAVTransportURI→GENA TRANSITIONING→Play→GENA PLAYING。
 *    关键:GENA 事件在 playMedia 返回前就上报给 PlayerController(模拟真实设备)。
 *  - 自然结束:device.finishTrack() 把状态置为 STOPPED(IDLE),模拟歌曲播完
 *  - pollState(): 返回当前状态 */
class FakeDlnaDevice {
  state: PlaybackState = PlaybackState.IDLE;
  mediaUri: string | undefined;
  position = 0;
  duration = 100;
  readonly playerId: string;
  playMediaCalls: QueueItem[] = [];
  /** cast 期间 GENA 事件上报回调(由 setup 注入 PlayerController.reportState)。 */
  onGenaEvent: ((state: PlayerState) => void) | null = null;

  constructor(public readonly deviceId: string) {
    // 必须在构造函数里赋值:ES2022+ target 下类字段初始化早于参数属性赋值,
    // 若用字段初始化器 `playerId = `dlna:${this.deviceId}``,此时 this.deviceId 还是 undefined。
    this.playerId = `dlna:${deviceId}`;
  }

  /** 模拟 castToDevice:Stop→GENA STOPPED→SetAVTransportURI→GENA TRANSITIONING→
   *  Play→GENA PLAYING。GENA 事件在返回前就上报(模拟真实设备行为)。 */
  async playMedia(item: QueueItem, _baseUrl: string): Promise<{ mediaUri: string }> {
    this.playMediaCalls.push(item);
    const uri = `http://base/stream/${item.songId}`;

    // Step 1: Stop → 设备 GENA 上报 STOPPED(IDLE)
    this.state = PlaybackState.IDLE;
    this.emitGena();

    // Step 2: SetAVTransportURI → 设备 GENA 上报 TRANSITIONING(BUFFERING)
    this.state = PlaybackState.BUFFERING;
    this.mediaUri = uri;
    this.emitGena();

    // Step 3: Play → 设备 GENA 上报 PLAYING
    this.state = PlaybackState.PLAYING;
    this.position = 0;
    this.duration = item.duration || 100;
    this.emitGena();

    return { mediaUri: uri };
  }

  /** 模拟 GENA 事件上报给 PlayerController。 */
  private emitGena(): void {
    if (this.onGenaEvent) {
      this.onGenaEvent({
        playerId: this.playerId,
        playbackState: this.state,
        position: this.position,
        duration: this.duration,
        mediaUri: this.mediaUri,
        updatedAt: Date.now(),
      });
    }
  }

  async stop() { this.state = PlaybackState.IDLE; }
  async pause() { this.state = PlaybackState.PAUSED; }
  async resume() { this.state = PlaybackState.PLAYING; }
  async seek(_s: number) {}
  async setVolume(_v: number) {}

  async pollState(): Promise<PlayerState> {
    return {
      playerId: this.playerId,
      playbackState: this.state,
      position: this.position,
      duration: this.duration,
      mediaUri: this.mediaUri,
      updatedAt: Date.now(),
    };
  }

  /** 模拟 GENA 事件:歌曲自然播完(PLAYING → STOPPED)。 */
  finishTrack(): void {
    this.state = PlaybackState.IDLE;
    this.position = this.duration;
  }

  /** 模拟 GENA 事件:设备上报当前状态(供 reportState 调用)。 */
  snapshot(): PlayerState {
    return {
      playerId: this.playerId,
      playbackState: this.state,
      position: this.position,
      duration: this.duration,
      mediaUri: this.mediaUri,
      updatedAt: Date.now(),
    };
  }
}

function makeItems(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({
    songId: `s${i + 1}`,
    title: `track${i + 1}`,
    mime: "audio/mpeg",
    duration: 100,
  }));
}

/** 组装完整链路:PlayerController ↔ QueueController + 注册 fake 设备。 */
function setup(deviceId = "d1") {
  const pc = new PlayerController();
  const qc = new QueueController();
  const device = new FakeDlnaDevice(deviceId);

  // 接线:PlayerController 决策 → QueueController 切歌(对照 wirePlayerQueueControllers)
  pc.onDecision = (decision, playerId) => {
    qc.handleDecision(decision, playerId).catch(() => {});
  };

  // 注入 GENA 回调:cast 期间设备 GENA 事件直接上报 PlayerController(模拟真实 eventing.ts)
  device.onGenaEvent = (state) => pc.reportState(state);

  // 注册:UniversalPlayer 包裹 fake device(实现 ProtocolPlayer)
  const up = new UniversalPlayer(device.playerId, "fake");
  up.attachProtocol(device as unknown as ProtocolPlayer);
  qc.registerPlayer(deviceId, up, pc);

  return { pc, qc, device };
}

describe("MA 式链路集成测试", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  // ============ 场景 1:自然结束 → 自动切下一首 ============
  it("场景1:歌曲自然播完(GENA PLAYING→IDLE)→ 自动推进到下一首", async () => {
    const { pc, qc, device } = setup();
    qc.setQueue("d1", makeItems(3), 0, "http://base");

    // 手动触发首次播放(playFrom 模拟路由调用)
    await qc.playFrom("d1", makeItems(3), 0, "http://base");
    expect(device.playMediaCalls.length).toBe(1);
    expect(device.playMediaCalls[0].songId).toBe("s1");
    // playFrom 调 beginOptimistic,需关闭乐观窗口让后续 GENA 上报生效
    pc.endOptimistic("dlna:d1");

    // 设备已处于 PLAYING(s1)。模拟 GENA 上报 PLAYING
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000); // 双层去抖(250+500=750)充分触发

    // 模拟歌曲自然播完:GENA 上报 IDLE
    device.finishTrack();
    pc.reportState(device.snapshot());
    expect(device.playMediaCalls.length).toBe(1); // 去抖期间还未切歌

    await vi.advanceTimersByTimeAsync(1000); // 双层去抖充分触发 + flush microtask
    expect(device.playMediaCalls.length).toBe(2); // 已切到 s2
    expect(device.playMediaCalls[1].songId).toBe("s2");
    expect(qc.snapshot("d1").currentIndex).toBe(1);
  });

  // ============ 场景 2:瞬态 STOPPED 被乐观窗口屏蔽 ============
  it("场景2:切歌期间设备短暂报 IDLE(瞬态)→ 乐观窗口屏蔽,不误切", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(3), 0, "http://base");
    // playFrom 已触发 beginOptimistic("dlna:d1", "http://base/stream/s1")
    expect(device.playMediaCalls.length).toBe(1);

    // 设备在切歌瞬间报 IDLE(瞬态 STOPPED)—— 应被乐观窗口屏蔽
    device.state = PlaybackState.IDLE;
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(800);
    // 不应触发切歌(playMedia 调用数不变)
    expect(device.playMediaCalls.length).toBe(1);

    // 设备最终报 PLAYING(新 uri 一致),确认切歌成功
    device.state = PlaybackState.PLAYING;
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(800);
    expect(device.playMediaCalls.length).toBe(1); // 仍只有首播,无误切
  });

  // ============ 场景 3:5s play 超时 → stalled 兜底重试 ============
  it("场景3:乐观窗口 5s 超时未确认 PLAYING → stalled → 重试当前首", async () => {
    const { pc, qc, device } = setup();
    // 模拟卡死设备:Play 命令成功但设备实际不播,playMedia 期间不发 PLAYING(只发 IDLE/BUFFERING)
    const origPlayMedia = device.playMedia.bind(device);
    device.playMedia = async (item, _baseUrl) => {
      device.playMediaCalls.push(item);
      // Stop → IDLE(GENA 上报)
      device.state = PlaybackState.IDLE;
      device.onGenaEvent?.(device.snapshot());
      // SetAV → BUFFERING(GENA 上报),但不发 PLAYING(设备卡死)
      device.state = PlaybackState.BUFFERING;
      device.mediaUri = `http://base/stream/${item.songId}`;
      device.onGenaEvent?.(device.snapshot());
      return { mediaUri: `http://base/stream/${item.songId}` };
    };
    await qc.playFrom("d1", makeItems(2), 0, "http://base");
    expect(device.playMediaCalls.length).toBe(1);

    // 乐观窗口已开启(cast 前),IDLE/BUFFERING 被屏蔽,5s 内未收到 PLAYING
    await vi.advanceTimersByTimeAsync(800); // 乐观窗口内,忽略

    // 超过 5s play 超时 → 触发 stalled → QueueController 重试当前首
    await vi.advanceTimersByTimeAsync(5000);
    expect(device.playMediaCalls.length).toBe(2); // 重试 s1
    expect(device.playMediaCalls[1].songId).toBe("s1");
    // 恢复原始 playMedia(后续断言不受影响)
    device.playMedia = origPlayMedia;
  });

  // ============ 场景 3b:PLAYING 上报(mediaUri 为空/不匹配)也能关闭乐观窗口 ============
  //   回归测试:修复 GENA/poll 上报 PLAYING 但 mediaUri=undefined 时乐观窗口
  //   永远无法关闭 → 5s 超时 → stalled → 重复 cast 同一首的死循环。
  it("场景3b:PLAYING 上报(mediaUri=undefined)关闭乐观窗口,不触发 stalled 死循环", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(2), 0, "http://base");
    // playFrom 已触发 beginOptimistic("dlna:d1", "http://base/stream/s1")
    expect(device.playMediaCalls.length).toBe(1);

    // 模拟 GENA LastChange 不含 CurrentTrackURI → mediaUri=undefined
    // (或 poll 路径 GetPositionInfo 未返回 TrackURI)
    device.state = PlaybackState.PLAYING;
    const playingNoUri: PlayerState = {
      playerId: "dlna:d1",
      playbackState: PlaybackState.PLAYING,
      position: 0,
      duration: 100,
      mediaUri: undefined, // ← 关键:URI 为空,模拟真实 GENA/poll 上报
      updatedAt: Date.now(),
    };
    pc.reportState(playingNoUri);
    await vi.advanceTimersByTimeAsync(1000);

    // 乐观窗口应已关闭(PLAYING 即确认成功,不要求 URI 匹配)
    // 推进 5s+,若乐观窗口未关闭会触发 stalled → playMediaCalls 增至 2
    await vi.advanceTimersByTimeAsync(6000);
    expect(device.playMediaCalls.length).toBe(1); // 无 stalled 重试,无死循环
  });

  // ============ 场景 3c:切歌后 tracker 重置,切歌瞬态 IDLE 不再触发 advance ============
  //   回归测试:修复"歌曲自然结束 → 切到下一首 → 切歌瞬态又报 IDLE →
  //   tracker.prev 仍是上一首 PLAYING → 误判 advance → 重复 cast 同一首"死循环。
  //   对照 MA:play_index 后清空 prev_state,切歌瞬态的 IDLE 不会触发再次切歌。
  it("场景3c:自然结束切歌后,切歌瞬态 IDLE 不再触发 advance(无死循环)", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(3), 0, "http://base");
    pc.endOptimistic("dlna:d1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(1); // s1

    // 上报 PLAYING(s1)建立 tracker.prev=PLAYING/s1
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);

    // 自然结束:s1 播完 → IDLE → advance → 切到 s2
    device.finishTrack();
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(2); // 已切到 s2
    expect(device.playMediaCalls[1].songId).toBe("s2");

    // 关键:切到 s2 后设备状态变为 PLAYING(s2),但紧接着设备在
    // Stop→SetAVTransportURI→Play 过程中会短暂报 IDLE(切歌瞬态)。
    // playCurrent 已 resetTracker,故 tracker.prev=null,IDLE 不会触发 advance。
    device.state = PlaybackState.IDLE; // 切歌瞬态
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(2); // 不再切歌,无死循环

    // 随后设备报 PLAYING(s2),正常播放
    device.state = PlaybackState.PLAYING;
    device.mediaUri = "http://base/stream/s2";
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(2); // 仍只有 2 次(s1 + s2)
  });

  // ============ 场景 4:手动 next 与自动 advance 不并发竞争 ============
  it("场景4:手动 next 期间 GENA 触发 advance → advancing 守卫阻止重复切歌", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(3), 0, "http://base");
    pc.endOptimistic("dlna:d1");
    expect(device.playMediaCalls.length).toBe(1);

    // 模拟手动 next:占住 advancing
    const nextPromise = qc.next("d1", "http://base");
    // 在 next 进行中(advancing 已占),GENA 上报自然结束
    device.finishTrack();
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000); // 双层去抖 + 决策
    await nextPromise;

    // 手动 next 切到 s2(1 次),自动 advance 被守卫阻止(不额外切)
    expect(device.playMediaCalls.length).toBe(2);
    expect(device.playMediaCalls[1].songId).toBe("s2");
    expect(qc.snapshot("d1").currentIndex).toBe(1);
  });

  // ============ 场景 5:最后一首自然结束 → markEnded,不再切 ============
  it("场景5:最后一首自然播完 → 标记 ended,不继续切歌", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(1), 0, "http://base"); // 只有 1 首
    pc.endOptimistic("dlna:d1");
    expect(device.playMediaCalls.length).toBe(1);

    // 上报 PLAYING 确认
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);

    // 自然播完
    device.finishTrack();
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);

    expect(qc.snapshot("d1").ended).toBe(true);
    expect(qc.snapshot("d1").isActive).toBe(false);
    expect(device.playMediaCalls.length).toBe(1); // 没有继续切
  });

  // ============ 场景 6:poll 兜底路径(SOAP poll → reportState → 决策)============
  it("场景6:poll 兜底路径 —— pollState 上报 → 状态迁移 → 自动切歌", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(2), 0, "http://base");
    pc.endOptimistic("dlna:d1");
    await vi.advanceTimersByTimeAsync(1000);

    // 模拟 poll 兜底:device.pollState() 返回当前 PLAYING,上报给 PlayerController
    const playingState = await device.pollState();
    pc.reportState(playingState);
    await vi.advanceTimersByTimeAsync(1000);

    // poll 发现设备已自然结束(IDLE)
    device.finishTrack();
    const idleState = await device.pollState();
    pc.reportState(idleState);
    await vi.advanceTimersByTimeAsync(1000);

    // poll 兜底也应触发自动切歌
    expect(device.playMediaCalls.length).toBe(2);
    expect(device.playMediaCalls[1].songId).toBe("s2");
  });

  // ============ 场景 7:原生 gapless(track_changed)—— 同为 PLAYING 但 uri 变化 ============
  it("场景7:原生 gapless 切歌(PLAYING→PLAYING,uri 变化)→ track_changed 决策", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(3), 0, "http://base");
    pc.endOptimistic("dlna:d1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(1);
    expect(device.mediaUri).toBe("http://base/stream/s1");

    // 先上报 PLAYING(s1 uri),让 tracker 记住 prev=PLAYING/s1
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);

    // 模拟原生 gapless:设备自行切到下一首,状态保持 PLAYING 但 uri 变化
    device.mediaUri = "http://base/stream/s2";
    pc.reportState(device.snapshot()); // PLAYING + 新 uri → tracker 判 track_changed
    await vi.advanceTimersByTimeAsync(1000);

    // track_changed 决策 → QueueController 同步 currentIndex 到 1
    expect(qc.snapshot("d1").currentIndex).toBe(1);
  });

  // ============ 场景 8:pause/resume 不触发误切 ============
  it("场景8:pause 后 resume,状态迁移不触发切歌", async () => {
    const { pc, qc, device } = setup();
    await qc.playFrom("d1", makeItems(2), 0, "http://base");
    pc.endOptimistic("dlna:d1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(1);

    // 暂停:PLAYING → PAUSED
    device.state = PlaybackState.PAUSED;
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(1); // 不切歌

    // 恢复:PAUSED → PLAYING
    device.state = PlaybackState.PLAYING;
    pc.reportState(device.snapshot());
    await vi.advanceTimersByTimeAsync(1000);
    expect(device.playMediaCalls.length).toBe(1); // 仍不切歌
  });
});
