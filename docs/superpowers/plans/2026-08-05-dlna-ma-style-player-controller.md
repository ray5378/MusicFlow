# DLNA MA 式上层 Player Controller 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DLNA 的"播放结束自动下一首"决策从 player 层上移到独立的 Queue Controller,移植 Music Assistant 的可靠性机制(双层去抖、状态迁移判断、瞬态屏蔽、乐观设态、卡死兜底、play 超时),解决"播 1 秒停/进度不动/级联误切"问题。

**Architecture:** 参考 MA 的三层结构 —— `PlayerController`(状态管理 + 0.25s 去抖转发)、`QueueController`(队列 + 切歌决策,带 0.5s 二次去抖)、`PlaybackTracker`(prev/new 状态迁移判断 + 60s 卡死兜底)。DLNA `control.ts` 变成瘦协议端点:只上报状态 + 执行命令,不再内联切歌决策。`eventing.ts` 的 GENA 事件改为上报状态给 PlayerController,不再直接 emit `track_ended` 触发 queue。预留 `UniversalPlayer` 接口(未来 Cast/AirPlay 聚合)。本机播放暂不动,保留前端自治。

**Tech Stack:** TypeScript (ESM), Hono, better-sqlite3, drizzle-orm, vitest(新增,仅用于核心决策逻辑单测)

---

## 调研依据(关键 MA 机制)

来自 MA 调研:
1. **切歌决策不在 player 里**:MA 的 `player_queues` 控制器负责,player 只上报状态。
2. **双层去抖**:`trigger_player_update`(0.25s)+ `call_later(0.5s)` 转发到 queue。
3. **状态迁移判断**:`_handle_playback_progress_report(prev, new)` 比较前后状态。
4. **TRANSITIONING → PLAYING 映射**:切换过渡态不当结束。
5. **乐观设态**:命令发出前先把状态设为 PLAYING,屏蔽切换瞬态 STOPPED。
6. **60s 卡死兜底**:`elapsed_time_last_updated > 60s` 视为异常。
7. **5s play 超时**:`PLAYBACK_START_TIMEOUT=5.0`,play 后等最多 5s 确认 PLAYING。
8. **wait_for_can_play 检查 `CurrentTransportActions` 含 "play"**,而非只检查 `!= TRANSITIONING`。

本地现状问题(对照):
- GENA 主路径([eventing.ts:156-159](file:///workspace/backend/src/services/dlna/eventing.ts#L156-L159))无瞬态过滤,任何 `PLAYING→STOPPED` 立即 emit `track_ended`,比 poll 兜底路径([queue.ts:108-114](file:///workspace/backend/src/services/dlna/queue.ts#L108-L114))更脆弱。
- `next()`/`prev()`/`playFrom()` 无 `advancing` 守卫,与 GENA 触发的 auto-advance 并发竞争。
- `waitForCanPlay`([control.ts:239-249](file:///workspace/backend/src/services/dlna/control.ts#L239-L249))只检查 `!= TRANSITIONING`,可能在设备未就绪时发 Play。
- poll 间隔 3s 过激进,且无 TRANSITIONING→PLAYING 映射。

---

## 文件结构

**新建:**
- `backend/src/services/player/types.ts` — 共享类型:`PlaybackState`、`PlayerState`、`CompareState`、`PlayerEvent`
- `backend/src/services/player/PlaybackTracker.ts` — 状态迁移判断(prev/new compare)+ 60s 卡死兜底
- `backend/src/services/player/PlayerController.ts` — player 状态管理 + 0.25s 去抖 + 转发到 QueueController(0.5s 二次去抖)
- `backend/src/services/player/QueueController.ts` — 队列数据管理 + 切歌决策(`onPlayerUpdate` → `playIndex`);接管原 `dlna/queue.ts` 的决策职责
- `backend/src/services/player/UniversalPlayer.ts` — 协议聚合壳(预留接口,queue 挂这层,转发给协议 player;当前只接 DLNA)
- `backend/src/services/player/index.ts` — 单例导出
- `backend/tests/player/PlaybackTracker.test.ts` — 状态迁移判断单测
- `backend/tests/player/QueueController.test.ts` — 切歌决策单测
- `backend/vitest.config.ts` — vitest 配置

**修改:**
- `backend/src/services/dlna/control.ts` — `castToDevice` 加乐观设态 + `waitForCanPlay` 增强(检查 `CurrentTransportActions`);新增 `reportState()` 上报;移除 `consumeAutoAdvanceFlag`(决策上移)
- `backend/src/services/dlna/eventing.ts` — GENA 状态变化改为调 `PlayerController.reportState()`,不再 emit `track_ended` 触发 queue
- `backend/src/services/dlna/queue.ts` — 简化为纯数据层(CRUD + `playCurrent` 执行 cast),移除 `onTrackEnded`/`pollAllDevices` 决策逻辑(上移到 QueueController)
- `backend/src/index.ts` — 接线:`track_ended` 不再直接调 `onTrackEnded`;启动 PlayerController/QueueController
- `backend/src/routes/api/index.ts` — 路由从 `getQueueManager()` 切到 `getQueueController()`(保持 API 形状兼容)
- `backend/package.json` — 加 vitest 依赖 + `test` script

---

## Task 1: 搭建 vitest 测试框架

**Files:**
- Modify: `backend/package.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/tests/.gitkeep`

- [ ] **Step 1: 安装 vitest**

Run (in `backend/`):
```bash
npm install -D vitest@^1.6.0
```
Expected: `added vitest` 出现在输出,`package.json` devDependencies 出现 vitest。

- [ ] **Step 2: 创建 vitest 配置**

Create `backend/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
```

- [ ] **Step 3: 加 test script 到 package.json**

Modify `backend/package.json` 的 `scripts` 块,在 `"db:push"` 后加一行:
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 4: 验证 vitest 可运行**

Run (in `backend/`):
```bash
npx vitest run --passWithNoTests
```
Expected: 输出 `No test files found` 但退出码 0。

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/vitest.config.ts backend/tests/.gitkeep
git commit -m "test: 搭建 vitest 测试框架用于 player 决策逻辑单测"
```

---

## Task 2: 定义共享类型 (player/types.ts)

**Files:**
- Create: `backend/src/services/player/types.ts`

- [ ] **Step 1: 创建类型文件**

Create `backend/src/services/player/types.ts`:
```typescript
// MA 式 player 状态类型。对照 MA 的 PlaybackState + PlayerState + CompareState。

/** 播放状态机。对照 MA PlaybackState。 */
export enum PlaybackState {
  IDLE = "IDLE",            // 设备 STOPPED / NO_MEDIA_PRESENT
  PLAYING = "PLAYING",
  PAUSED = "PAUSED",
  BUFFERING = "BUFFERING",  // TRANSITIONING 映射到这里(屏蔽瞬态,见 PlaybackTracker)
}

/** Player 当前状态快照。对照 MA PlayerState(精简版)。 */
export interface PlayerState {
  playerId: string;          // dlna:<deviceId> (未来 universal:<id>)
  playbackState: PlaybackState;
  position: number;          // 秒
  duration: number;          // 秒
  mediaUri?: string;         // 当前流 URL,用于检测曲目切换
  updatedAt: number;         // ms epoch,状态最后一次刷新
}

/** 状态迁移比较快照。对照 MA CompareState。PlaybackTracker 据此判断。 */
export interface CompareState {
  playbackState: PlaybackState;
  mediaUri?: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export function toCompareState(s: PlayerState): CompareState {
  return {
    playbackState: s.playbackState,
    mediaUri: s.mediaUri,
    position: s.position,
    duration: s.duration,
    updatedAt: s.updatedAt,
  };
}

/** 队列播放模式。对照本地原有 PlayMode(order/one/all/shuffle)。 */
export type PlayMode = "order" | "one" | "all" | "shuffle";

export interface QueueItem {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  mime: string;
  coverArt?: string;
  duration?: number;
}

/** 协议端点接口:DLNA / 未来 Cast 都实现这个。对照 MA 协议 player 契约。 */
export interface ProtocolPlayer {
  playerId: string;
  /** 执行播放一首(Stop→Set→wait→Play)。返回上报用的 mediaUri。 */
  playMedia(item: QueueItem, baseUrl: string): Promise<{ mediaUri: string }>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(vol: number): Promise<void>;
  /** 主动查询设备状态(SOAP poll)。GENA 事件路径不依赖此方法。 */
  pollState(): Promise<PlayerState>;
}
```

- [ ] **Step 2: 类型检查**

Run (in `backend/`):
```bash
npx tsc --noEmit
```
Expected: 无错误(新文件类型自洽)。

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/player/types.ts
git commit -m "feat(player): 定义 MA 式 player/queue 共享类型"
```

---

## Task 3: 实现 PlaybackTracker + 单测

这是整个重构的核心可靠性逻辑。对照 MA `playback_tracker.py` 的 `_handle_playback_progress_report`。

**Files:**
- Create: `backend/src/services/player/PlaybackTracker.ts`
- Create: `backend/tests/player/PlaybackTracker.test.ts`

- [ ] **Step 1: 写失败测试**

Create `backend/tests/player/PlaybackTracker.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlaybackTracker } from "../../src/services/player/PlaybackTracker.js";
import { PlaybackState, toCompareState, type PlayerState } from "../../src/services/player/types.js";

function st(state: PlaybackState, uri = "u1", pos = 0, dur = 100): PlayerState {
  return { playerId: "dlna:d1", playbackState: state, position: pos, duration: dur, mediaUri: uri, updatedAt: Date.now() };
}

describe("PlaybackTracker", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("PLAYING→IDLE 有下一首: 返回 advance", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("advance");
  });

  it("PLAYING→IDLE 无下一首: 返回 ended", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("ended");
  });

  it("TRANSITIONING(BUFFERING)→IDLE: 不当作结束(屏蔽瞬态)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    // 切歌期间设备短暂 STOPPED,但乐观设态把状态报为 PLAYING,所以 prev 仍是 PLAYING
    const r = t.update(toCompareState(st(PlaybackState.PLAYING, "u2", 0)));
    expect(r).toBe("none"); // 同为 PLAYING,只是 uri 变了 → track_changed,不 advance
  });

  it("IDLE 持续超过 60s: 返回 stalled(卡死兜底)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.IDLE)));
    vi.advanceTimersByTime(61_000);
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("stalled");
  });

  it("IDLE 未超 60s: 返回 none(等待设备恢复)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.IDLE)));
    vi.advanceTimersByTime(10_000);
    const r = t.update(toCompareState(st(PlaybackState.IDLE)));
    expect(r).toBe("none");
  });

  it("首次 update: 返回 none(仅 seed 状态)", () => {
    const t = new PlaybackTracker();
    const r = t.update(toCompareState(st(PlaybackState.PLAYING)));
    expect(r).toBe("none");
  });

  it("同状态同 uri: 返回 none(无变化)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING)));
    const r = t.update(toCompareState(st(PlaybackState.PLAYING)));
    expect(r).toBe("none");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run (in `backend/`):
```bash
npx vitest run tests/player/PlaybackTracker.test.ts
```
Expected: FAIL,`Cannot find module '../../src/services/player/PlaybackTracker.js'`。

- [ ] **Step 3: 实现 PlaybackTracker**

Create `backend/src/services/player/PlaybackTracker.ts`:
```typescript
// 状态迁移判断 + 卡死兜底。对照 MA playback_tracker.py 的
// _handle_playback_progress_report(prev_state, new_state)。
//
// 返回值:
//   "advance"      — 自然结束(PLAYING→IDLE),应推进下一首
//   "ended"        — 整队列播完(PLAYING→IDLE 且无下一首,由 QueueController 判断后传入)
//   "stalled"      — IDLE 卡死超 60s,异常兜底
//   "track_changed"— 同为 PLAYING 但 uri 变了(设备 native gapless 切歌)
//   "none"         — 无需动作
//
// 关键:不在此处判断"有无下一首",由 QueueController 在调用前注入 hasNext。
// 这里只做纯状态迁移判断,便于单测。
import { CompareState, PlaybackState } from "./types.js";

const STALL_TIMEOUT_MS = 60_000; // 对照 MA: elapsed_time_last_updated > 60s

export type TrackDecision =
  | "advance"
  | "ended"
  | "stalled"
  | "track_changed"
  | "none";

export class PlaybackTracker {
  private prev: CompareState | null = null;

  /** 注入式:调用方告诉 tracker 是否还有下一首,决定 IDLE 是 advance 还是 ended。 */
  update(neww: CompareState, hasNext = true): TrackDecision {
    let decision: TrackDecision = "none";
    if (this.prev) {
      const prev = this.prev;
      const cur = neww.playbackState;
      const psv = prev.playbackState;

      // 自然结束:PLAYING → IDLE
      if (psv === PlaybackState.PLAYING && cur === PlaybackState.IDLE) {
        decision = hasNext ? "advance" : "ended";
      }
      // native gapless:同为 PLAYING 但 uri 变了
      else if (psv === PlaybackState.PLAYING && cur === PlaybackState.PLAYING
               && prev.mediaUri && neww.mediaUri && prev.mediaUri !== neww.mediaUri) {
        decision = "track_changed";
      }
      // 卡死兜底:IDLE 持续超 60s
      else if (psv === PlaybackState.IDLE && cur === PlaybackState.IDLE
               && (neww.updatedAt - prev.updatedAt) > STALL_TIMEOUT_MS) {
        decision = "stalled";
      }
      // TRANSITIONING(BUFFERING)→ 任何:不当结束(瞬态屏蔽,由乐观设态保证 prev 仍是 PLAYING)
    }
    this.prev = neww;
    return decision;
  }

  reset(): void {
    this.prev = null;
  }

  getPrev(): CompareState | null {
    return this.prev;
  }
}
```

- [ ] **Step 4: 修正测试期望(track_changed 用例)**

第 3 个测试用例描述的是"瞬态屏蔽",但实际返回 `track_changed`。修正该测试,新增一个明确瞬态场景:乐观设态下 prev=PLAYING(旧 uri),new=PLAYING(新 uri) → `track_changed`。同时新增"乐观设态屏蔽 STOPPED 瞬态"测试:

在 `backend/tests/player/PlaybackTracker.test.ts` 替换第 3 个 `it`:
```typescript
  it("PLAYING(旧uri)→PLAYING(新uri): 返回 track_changed(native gapless)", () => {
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1")));
    const r = t.update(toCompareState(st(PlaybackState.PLAYING, "u2")));
    expect(r).toBe("track_changed");
  });

  it("瞬态屏蔽:乐观设态使 prev=PLAYING,设备短暂 IDLE 不触发 advance", () => {
    // 乐观设态由 PlayerController 注入:切歌期间强制 prev=PLAYING,
    // 即使设备短暂报 IDLE,只要紧接着回到 PLAYING(新 uri),就是 track_changed 而非 advance。
    const t = new PlaybackTracker();
    t.update(toCompareState(st(PlaybackState.PLAYING, "u1")));
    // 模拟乐观设态:切歌时强制把 prev 设为 PLAYING(新 uri, position=0)
    t.update(toCompareState(st(PlaybackState.PLAYING, "u2", 0)));
    // 设备短暂报 IDLE(瞬态)→ 因 prev=PLAYING(u2) 会触发 advance?
    // 不:乐观设态期间 PlayerController 应跳过上报,这里验证 tracker 本身行为:
    const r = t.update(toCompareState(st(PlaybackState.IDLE, "u2")));
    expect(r).toBe("advance"); // 纯 tracker 视角:PLAYING→IDLE 确实 advance
    // 注:瞬态屏蔽的真正实现由 PlayerController 的"乐观窗口"完成,见 PlayerController 测试。
  });
```

- [ ] **Step 5: 运行测试确认通过**

Run (in `backend/`):
```bash
npx vitest run tests/player/PlaybackTracker.test.ts
```
Expected: 7 个测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/player/PlaybackTracker.ts backend/tests/player/PlaybackTracker.test.ts
git commit -m "feat(player): 实现 PlaybackTracker 状态迁移判断 + 卡死兜底"
```

---

## Task 4: 实现 PlayerController(去抖转发 + 乐观窗口)

对照 MA `players/controller.py` 的 `trigger_player_update`(0.25s 去抖)+ `call_later(0.5s)` 转发到 queue。增加"乐观窗口":cast 期间忽略 IDLE 上报,屏蔽瞬态。

**Files:**
- Create: `backend/src/services/player/PlayerController.ts`
- Create: `backend/tests/player/PlayerController.test.ts`

- [ ] **Step 1: 写失败测试**

Create `backend/tests/player/PlayerController.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlayerController } from "../../src/services/player/PlayerController.js";
import { PlaybackState, type PlayerState } from "../../src/services/player/types.js";

function st(state: PlaybackState, uri = "u1", pos = 0): PlayerState {
  return { playerId: "dlna:d1", playbackState: state, position: pos, duration: 100, mediaUri: uri, updatedAt: Date.now() };
}

describe("PlayerController", () => {
  let onDecision: ReturnType<typeof vi.fn>;
  let ctrl: PlayerController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    onDecision = vi.fn();
    ctrl = new PlayerController();
    ctrl.onDecision = onDecision; // 注入回调(由 QueueController 设置)
  });
  afterEach(() => { vi.useRealTimers(); });

  it("reportState 后 0.25s 去抖,再 0.5s 转发决策", () => {
    ctrl.reportState(st(PlaybackState.PLAYING));
    ctrl.reportState(st(PlaybackState.IDLE)); // 自然结束
    expect(onDecision).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250); // 第一层去抖
    expect(onDecision).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500); // 第二层去抖
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0][0]).toBe("advance");
  });

  it("乐观窗口期间忽略 IDLE 上报(屏蔽瞬态)", () => {
    ctrl.reportState(st(PlaybackState.PLAYING, "u1"));
    vi.advanceTimersByTime(800); // 让第一次上报落地
    ctrl.beginOptimistic("dlna:d1", "u2"); // 开始切歌
    // 设备短暂报 IDLE(瞬态)
    ctrl.reportState(st(PlaybackState.IDLE, "u2"));
    vi.advanceTimersByTime(800);
    expect(onDecision).not.toHaveBeenCalled(); // 乐观窗口屏蔽
    // 设备报 PLAYING(新 uri)
    ctrl.reportState(st(PlaybackState.PLAYING, "u2", 1));
    vi.advanceTimersByTime(800);
    expect(onDecision).toHaveBeenCalledWith("track_changed");
  });

  it("5s play 超时:乐观窗口超时后若仍 IDLE,触发 stalled", () => {
    ctrl.reportState(st(PlaybackState.PLAYING, "u1"));
    vi.advanceTimersByTime(800);
    ctrl.beginOptimistic("dlna:d1", "u2");
    ctrl.reportState(st(PlaybackState.IDLE, "u2"));
    vi.advanceTimersByTime(800); // 乐观窗口内,忽略
    expect(onDecision).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000); // 超出 5s play 超时
    expect(onDecision).toHaveBeenCalledWith("stalled");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
npx vitest run tests/player/PlayerController.test.ts
```
Expected: FAIL,module not found。

- [ ] **Step 3: 实现 PlayerController**

Create `backend/src/services/player/PlayerController.ts`:
```typescript
// Player 状态管理 + 双层去抖转发 + 乐观窗口。对照 MA:
//   - players/controller.py trigger_player_update (0.25s 去抖)
//   - call_later(0.5s) 转发到 player_queues.on_player_update
//
// 乐观窗口:cast 期间(beginOptimistic)忽略 IDLE 上报,屏蔽切歌瞬态。
//   对照 MA 乐观设态:命令发出前先把 _attr_playback_state = PLAYING。
// 5s play 超时:对照 MA PLAYBACK_START_TIMEOUT=5.0。
import { PlaybackTracker, type TrackDecision } from "./PlaybackTracker.js";
import { PlaybackState, PlayerState, toCompareState } from "./types.js";

const DEBOUNCE_LAYER1_MS = 250;  // player 层去抖
const DEBOUNCE_LAYER2_MS = 500;  // → queue 层去抖
const PLAY_TIMEOUT_MS = 5000;    // 乐观窗口上限

type DecisionFn = (decision: TrackDecision, playerId: string) => void;

interface OptimisticState {
  mediaUri: string;
  startedAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

export class PlayerController {
  private trackers = new Map<string, PlaybackTracker>();
  private latest = new Map<string, PlayerState>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private forwardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private optimistic = new Map<string, OptimisticState>();
  /** 由 QueueController 注入。 */
  onDecision: DecisionFn = () => {};

  private trackerOf(playerId: string): PlaybackTracker {
    let t = this.trackers.get(playerId);
    if (!t) { t = new PlaybackTracker(); this.trackers.set(playerId, t); }
    return t;
  }

  /** 协议端点上报状态。0.25s 去抖后转发。 */
  reportState(state: PlayerState): void {
    this.latest.set(state.playerId, state);
    // 乐观窗口:若该 player 正在切歌,忽略 IDLE/异常上报,只接受 PLAYING(确认成功)
    const opt = this.optimistic.get(state.playerId);
    if (opt) {
      if (state.playbackState === PlaybackState.PLAYING && state.mediaUri === opt.mediaUri) {
        // 切歌成功,关闭乐观窗口
        this.clearOptimistic(state.playerId);
        // 让 tracker 看到一次"新 uri 的 PLAYING",这样下一次 IDLE 才会被识别为自然结束
        this.trackerOf(state.playerId).update(toCompareState(state));
      } else {
        // 乐观窗口内忽略非 PLAYING 上报(屏蔽瞬态 STOPPED)
        return;
      }
    }
    // 第一层去抖:250ms 内多次上报合并
    const playerId = state.playerId;
    const existing = this.debounceTimers.get(playerId);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(playerId, setTimeout(() => {
      this.debounceTimers.delete(playerId);
      this.scheduleForward(playerId);
    }, DEBOUNCE_LAYER1_MS));
  }

  private scheduleForward(playerId: string): void {
    // 第二层去抖:再等 500ms 后做决策
    const existing = this.forwardTimers.get(playerId);
    if (existing) clearTimeout(existing);
    this.forwardTimers.set(playerId, setTimeout(() => {
      this.forwardTimers.delete(playerId);
      this.evaluate(playerId);
    }, DEBOUNCE_LAYER2_MS));
  }

  private evaluate(playerId: string): void {
    const state = this.latest.get(playerId);
    if (!state) return;
    // hasNext 由 QueueController 通过 setHasNext 注入;这里默认 true,
    // QueueController 在 onDecision 回调里再用真实 hasNext 修正 ended vs advance。
    const decision = this.trackerOf(playerId).update(toCompareState(state));
    if (decision !== "none") {
      this.onDecision(decision, playerId);
    }
  }

  /** 开始乐观窗口:cast 命令发出前调用。屏蔽此期间的 IDLE 上报。 */
  beginOptimistic(playerId: string, mediaUri: string): void {
    this.clearOptimistic(playerId);
    const timeoutTimer = setTimeout(() => {
      // 5s 内未确认 PLAYING → 视为卡死
      this.optimistic.delete(playerId);
      this.onDecision("stalled", playerId);
    }, PLAY_TIMEOUT_MS);
    this.optimistic.set(playerId, { mediaUri, startedAt: Date.now(), timeoutTimer });
  }

  private clearOptimistic(playerId: string): void {
    const opt = this.optimistic.get(playerId);
    if (opt) { clearTimeout(opt.timeoutTimer); this.optimistic.delete(playerId); }
  }

  /** 显式结束乐观窗口(cast 成功/失败都调)。 */
  endOptimistic(playerId: string): void {
    this.clearOptimistic(playerId);
  }

  getLatest(playerId: string): PlayerState | undefined {
    return this.latest.get(playerId);
  }

  reset(playerId: string): void {
    this.trackerOf(playerId).reset();
    this.latest.delete(playerId);
    this.clearOptimistic(playerId);
    const d = this.debounceTimers.get(playerId); if (d) { clearTimeout(d); this.debounceTimers.delete(playerId); }
    const f = this.forwardTimers.get(playerId); if (f) { clearTimeout(f); this.forwardTimers.delete(playerId); }
  }
}
```

- [ ] **Step 4: 运行测试,修正乐观窗口逻辑**

Run:
```bash
npx vitest run tests/player/PlayerController.test.ts
```

注意:第 1 个测试"自然结束"场景里,`reportState(PLAYING)` 后立即 `reportState(IDLE)`,乐观窗口未开启,应正常转发 advance。但 `beginOptimistic` 没调,所以 evaluate 时 tracker.prev 是 PLAYING → IDLE = advance。验证通过。

第 2 个测试:先 reportState(PLAYING) → 等 800ms 落地(tracker.prev=PLAYING u1)。beginOptimistic → reportState(IDLE u2) 被乐观窗口忽略 → 等 800ms 无决策。reportState(PLAYING u2) → 乐观窗口确认成功,关闭,tracker.update(PLAYING u2)。然后 800ms 后 evaluate:tracker.prev=PLAYING u2(刚 update),new=PLAYING u2 → none。但测试期望 `track_changed`。

问题:乐观窗口确认时直接 `tracker.update(PLAYING u2)`,但 prev 是 u1(上次 evaluate 前 tracker 状态)。需要修正:乐观窗口确认时,应让 tracker 看到 u1→u2 的迁移。

修正 `reportState` 乐观窗口分支:确认成功时,先不直接 update tracker,而是走正常去抖流程,让 evaluate 时 tracker 自己看到 prev=u1 → new=u2(PLAYING) = track_changed。但乐观窗口期间 prev 仍是 u1(因为 IDLE 被忽略,tracker 没 update)。所以确认成功时关闭乐观窗口,让正常流程跑即可。

替换 `reportState` 中乐观窗口 PLAYING 分支:
```typescript
      if (state.playbackState === PlaybackState.PLAYING && state.mediaUri === opt.mediaUri) {
        // 切歌成功,关闭乐观窗口,让正常去抖流程处理(u1→u2 = track_changed)
        this.clearOptimistic(state.playerId);
        // 落入下方正常去抖逻辑(不 return)
      } else {
        return; // 乐观窗口内忽略非 PLAYING 上报
      }
```
即删掉 `this.trackerOf(state.playerId).update(toCompareState(state));` 那行,让代码继续往下走去抖。

- [ ] **Step 5: 再次运行测试确认通过**

Run:
```bash
npx vitest run tests/player/PlayerController.test.ts
```
Expected: 3 个测试 PASS。若第 2 个测试仍失败,检查:确认成功后乐观窗口关闭,reportState 继续走去抖 → 250ms+500ms 后 evaluate,tracker.prev=PLAYING u1(首次落地时 set),new=PLAYING u2 → track_changed。✓

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/player/PlayerController.ts backend/tests/player/PlayerController.test.ts
git commit -m "feat(player): 实现 PlayerController 双层去抖 + 乐观窗口 + play 超时"
```

---

## Task 5: 实现 UniversalPlayer(协议聚合壳,预留)

对照 MA UniversalPlayer:自身无 queue/play_media,只转发命令 + 聚合状态。当前只接 DLNA,为未来 Cast/AirPlay 预留接口。queue 实际挂在 UniversalPlayer 上(由 QueueController 管理)。

**Files:**
- Create: `backend/src/services/player/UniversalPlayer.ts`

- [ ] **Step 1: 创建 UniversalPlayer**

Create `backend/src/services/player/UniversalPlayer.ts`:
```typescript
// 协议聚合壳。对照 MA UniversalPlayer:
//   - 自身无 play_media,转发给底层协议 player
//   - 状态聚合自协议 player
//   - queue 挂在 UniversalPlayer 上(由 QueueController 持有)
//
// 当前只接 DLNA 协议 player。未来加 Cast/AirPlay 时,在此层做协议选择。
import { ProtocolPlayer, QueueItem, PlayerState, PlaybackState } from "./types.js";

export class UniversalPlayer {
  constructor(
    public readonly playerId: string,   // "universal:<id>" 或直接复用 "dlna:<deviceId>"
    public readonly name: string,
  ) {}

  private protocol: ProtocolPlayer | null = null;

  /** 绑定底层协议 player(DLNA / 未来 Cast)。 */
  attachProtocol(player: ProtocolPlayer): void {
    this.protocol = player;
  }

  getProtocol(): ProtocolPlayer | null {
    return this.protocol;
  }

  async playMedia(item: QueueItem, baseUrl: string): Promise<{ mediaUri: string }> {
    if (!this.protocol) throw new Error(`UniversalPlayer ${this.playerId} 无协议 player`);
    return this.protocol.playMedia(item, baseUrl);
  }

  async stop(): Promise<void> { await this.protocol?.stop(); }
  async pause(): Promise<void> { await this.protocol?.pause(); }
  async resume(): Promise<void> { await this.protocol?.resume(); }
  async seek(s: number): Promise<void> { await this.protocol?.seek(s); }
  async setVolume(v: number): Promise<void> { await this.protocol?.setVolume(v); }

  async pollState(): Promise<PlayerState> {
    if (!this.protocol) {
      return { playerId: this.playerId, playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() };
    }
    return this.protocol.pollState();
  }
}
```

- [ ] **Step 2: 类型检查**

Run (in `backend/`):
```bash
npx tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/player/UniversalPlayer.ts
git commit -m "feat(player): 预留 UniversalPlayer 协议聚合壳"
```

---

## Task 6: 实现 QueueController(队列 + 切歌决策)

接管原 `dlna/queue.ts` 的决策职责。对照 MA `player_queues/controller.py` 的 `on_player_update` + `play_index`。

**Files:**
- Create: `backend/src/services/player/QueueController.ts`
- Create: `backend/tests/player/QueueController.test.ts`

- [ ] **Step 1: 写失败测试**

Create `backend/tests/player/QueueController.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";
import { PlaybackState } from "../../src/services/player/types.js";
import type { UniversalPlayer } from "../../src/services/player/UniversalPlayer.js";

// Mock UniversalPlayer
function makeMockPlayer(): UniversalPlayer & { calls: string[] } {
  const calls: string[] = [];
  const proto = {
    playerId: "dlna:d1",
    async playMedia() { calls.push("playMedia"); return { mediaUri: "u-new" }; },
    async stop() { calls.push("stop"); },
    async pause() { calls.push("pause"); },
    async resume() { calls.push("resume"); },
    async seek() { calls.push("seek"); },
    async setVolume() { calls.push("setVolume"); },
    async pollState() { calls.push("pollState"); return { playerId: "dlna:d1", playbackState: PlaybackState.IDLE, position: 0, duration: 0, updatedAt: Date.now() }; },
  };
  const up = {
    playerId: "dlna:d1",
    name: "test",
    attachProtocol: () => {},
    getProtocol: () => proto,
    playMedia: proto.playMedia,
    stop: proto.stop,
    pause: proto.pause,
    resume: proto.resume,
    seek: proto.seek,
    setVolume: proto.setVolume,
    pollState: proto.pollState,
    calls,
  } as unknown as UniversalPlayer & { calls: string[] };
  return up;
}

describe("QueueController", () => {
  let qc: QueueController;
  let mockPlayer: ReturnType<typeof makeMockPlayer>;
  let mockCtrl: { beginOptimistic: ReturnType<typeof vi.fn>; endOptimistic: ReturnType<typeof vi.fn>; reportState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPlayer = makeMockPlayer();
    mockCtrl = {
      beginOptimistic: vi.fn(),
      endOptimistic: vi.fn(),
      reportState: vi.fn(),
    };
    qc = new QueueController();
    qc.registerPlayer("dlna:d1", mockPlayer, mockCtrl as any);
    // 填入队列
    qc.setQueue("dlna:d1", [
      { songId: "s1", title: "t1", mime: "audio/mpeg" },
      { songId: "s2", title: "t2", mime: "audio/mpeg" },
    ], 0, "http://base");
  });

  it("onDecision('advance'): 推进到下一首并 cast", async () => {
    await qc.handleDecision("advance", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
    expect(mockCtrl.beginOptimistic).toHaveBeenCalledWith("dlna:d1", "u-new");
  });

  it("onDecision('ended'): 无下一首,标记结束,不 cast", async () => {
    qc.setQueue("dlna:d1", [{ songId: "s1", title: "t1", mime: "audio/mpeg" }], 0, "http://base");
    await qc.handleDecision("ended", "dlna:d1");
    expect(mockPlayer.calls).not.toContain("playMedia");
  });

  it("onDecision('stalled'): 卡死,重试当前首一次", async () => {
    await qc.handleDecision("stalled", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
  });

  it("playMode=one: advance 时重播当前首", async () => {
    qc.setPlayMode("dlna:d1", "one");
    await qc.handleDecision("advance", "dlna:d1");
    expect(mockPlayer.calls).toContain("playMedia");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
npx vitest run tests/player/QueueController.test.ts
```
Expected: FAIL,module not found。

- [ ] **Step 3: 实现 QueueController**

Create `backend/src/services/player/QueueController.ts`:
```typescript
// 队列管理 + 切歌决策。对照 MA player_queues/controller.py:
//   - on_player_update → _handle_playback_progress_report → play_index
//   - mark_ended(保留 items)
//
// 接管原 dlna/queue.ts 的决策职责。原 dlna/queue.ts 降级为纯数据层。
import { EventEmitter } from "events";
import { db } from "../../db/index.js";
import { deviceQueues } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { PlayMode, QueueItem } from "./types.js";
import { UniversalPlayer } from "./UniversalPlayer.js";
import type { TrackDecision } from "./PlaybackTracker.js";
import { getEventManager } from "../dlna/eventing.js";

interface QueueData {
  items: QueueItem[];
  currentIndex: number;
  playMode: PlayMode;
  isActive: boolean;
  ended: boolean;  // 对照 MA mark_ended
}

interface PlayerControllerLike {
  beginOptimistic(playerId: string, mediaUri: string): void;
  endOptimistic(playerId: string): void;
  reportState(state: any): void;
}

export class QueueController extends EventEmitter {
  private queues = new Map<string, QueueData>();
  private players = new Map<string, UniversalPlayer>();
  private ctrls = new Map<string, PlayerControllerLike>();
  private advancing = new Set<string>();

  constructor() { super(); this.setMaxListeners(50); }

  registerPlayer(playerId: string, player: UniversalPlayer, ctrl: PlayerControllerLike): void {
    this.players.set(playerId, player);
    this.ctrls.set(playerId, ctrl);
  }

  /** 由 PlayerController.onDecision 调用。 */
  async handleDecision(decision: TrackDecision, playerId: string): Promise<void> {
    const baseUrl = process.env.DLNA_BASE_URL || `http://0.0.0.0:${process.env.PORT || 3000}`;
    const q = this.queues.get(playerId);
    if (!q) return;

    if (decision === "advance" || decision === "track_changed") {
      if (this.advancing.has(playerId)) return;
      this.advancing.add(playerId);
      try {
        const nextIdx = this.pickNext(q, decision === "track_changed");
        if (nextIdx === -1) {
          this.markEnded(playerId);
          return;
        }
        q.currentIndex = nextIdx;
        q.ended = false;
        await this.playCurrent(playerId, baseUrl);
        this.persist(playerId);
        this.emit("queue_changed", playerId, this.snapshot(playerId));
      } finally {
        this.advancing.delete(playerId);
      }
      return;
    }
    if (decision === "ended") {
      this.markEnded(playerId);
      return;
    }
    if (decision === "stalled") {
      // 卡死兜底:重试当前首一次
      if (this.advancing.has(playerId)) return;
      this.advancing.add(playerId);
      try {
        await this.playCurrent(playerId, baseUrl);
      } finally {
        this.advancing.delete(playerId);
      }
      return;
    }
  }

  private markEnded(playerId: string): void {
    const q = this.queues.get(playerId);
    if (!q) return;
    q.ended = true;
    q.isActive = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  private pickNext(q: QueueData, nativeGapless: boolean): number {
    const n = q.items.length;
    if (n === 0) return -1;
    if (q.playMode === "one") return q.currentIndex;
    if (q.playMode === "shuffle") return this.randomIndex(q);
    if (q.playMode === "all") {
      if (q.currentIndex + 1 < n) return q.currentIndex + 1;
      return 0;
    }
    // order
    if (q.currentIndex + 1 < n) return q.currentIndex + 1;
    return -1;
  }

  private randomIndex(q: QueueData): number {
    const n = q.items.length;
    if (n <= 1) return q.currentIndex;
    let idx = q.currentIndex;
    while (idx === q.currentIndex) idx = Math.floor(Math.random() * n);
    return idx;
  }

  private async playCurrent(playerId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(playerId);
    const player = this.players.get(playerId);
    const ctrl = this.ctrls.get(playerId);
    if (!q || !player || !ctrl) return;
    const item = q.currentIndex >= 0 ? q.items[q.currentIndex] : undefined;
    if (!item) return;
    console.log(`[QueueController][playCurrent] ${playerId}: idx=${q.currentIndex} songId=${item.songId}`);
    try {
      const { mediaUri } = await player.playMedia(item, baseUrl);
      // 乐观窗口:cast 命令已发出,屏蔽瞬态
      ctrl.beginOptimistic(playerId, mediaUri);
    } catch (e: any) {
      console.warn(`[QueueController][playCurrent] ${playerId}: cast FAILED:`, e?.message || e);
      ctrl.endOptimistic(playerId);
    }
  }

  // ==================== 公共 API(供路由调用,保持原 QueueManager 形状)====================
  setQueue(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): void {
    let q = this.queues.get(playerId);
    if (!q) { q = { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false }; this.queues.set(playerId, q); }
    q.items = items;
    q.currentIndex = Math.max(-1, Math.min(items.length - 1, startIndex));
    q.isActive = true;
    q.ended = false;
    this.playCurrent(playerId, baseUrl).catch(() => {});
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  async playFrom(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): Promise<void> {
    this.setQueue(playerId, items, startIndex, baseUrl);
  }

  setPlayMode(playerId: string, mode: PlayMode): void {
    const q = this.queues.get(playerId); if (!q) return;
    q.playMode = mode;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  async next(playerId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(playerId); if (!q) return;
    const idx = this.pickNext(q, false);
    if (idx === -1) { this.markEnded(playerId); return; }
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try { q.currentIndex = idx; q.ended = false; await this.playCurrent(playerId, baseUrl); this.persist(playerId); this.emit("queue_changed", playerId, this.snapshot(playerId)); }
    finally { this.advancing.delete(playerId); }
  }

  async prev(playerId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(playerId); if (!q) return;
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try {
      if (q.playMode === "one") { await this.playCurrent(playerId, baseUrl); }
      else if (q.playMode === "shuffle") { q.currentIndex = this.randomIndex(q); await this.playCurrent(playerId, baseUrl); }
      else if (q.currentIndex > 0) { q.currentIndex--; await this.playCurrent(playerId, baseUrl); }
      else if (q.playMode === "all") { q.currentIndex = q.items.length - 1; await this.playCurrent(playerId, baseUrl); }
      this.persist(playerId); this.emit("queue_changed", playerId, this.snapshot(playerId));
    } finally { this.advancing.delete(playerId); }
  }

  clear(playerId: string): void {
    const q = this.queues.get(playerId); if (!q) return;
    q.items = []; q.currentIndex = -1; q.isActive = false; q.ended = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  snapshot(playerId: string) {
    const q = this.queues.get(playerId);
    return {
      items: q?.items || [],
      currentIndex: q?.currentIndex ?? -1,
      playMode: q?.playMode || "order",
      isActive: q?.isActive || false,
      ended: q?.ended || false,
    };
  }

  private persist(playerId: string): void {
    const q = this.queues.get(playerId); if (!q) return;
    db.insert(deviceQueues).values({
      deviceId: playerId,
      itemsJson: JSON.stringify(q.items),
      currentIndex: q.currentIndex,
      playMode: q.playMode,
      isActive: q.isActive ? 1 : 0,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: deviceQueues.deviceId,
      set: {
        itemsJson: JSON.stringify(q.items),
        currentIndex: q.currentIndex,
        playMode: q.playMode,
        isActive: q.isActive ? 1 : 0,
        updatedAt: new Date().toISOString(),
      },
    }).run();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
npx vitest run tests/player/QueueController.test.ts
```
Expected: 4 个测试 PASS。若 `setQueue` 在 beforeEach 触发了 playCurrent(因为 setQueue 内部调 playCurrent),可能导致 advance 测试里 calls 已含 playMedia。修正 beforeEach:`setQueue` 改用直接设数据,不触发播放。在 QueueController.setQueue 里移除自动 playCurrent 调用,改由 playFrom 显式触发。

替换 `setQueue` 末尾(去掉 `this.playCurrent(...).catch(() => {})`):
```typescript
  setQueue(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): void {
    let q = this.queues.get(playerId);
    if (!q) { q = { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false }; this.queues.set(playerId, q); }
    q.items = items;
    q.currentIndex = Math.max(-1, Math.min(items.length - 1, startIndex));
    q.isActive = true;
    q.ended = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }
```
然后 `playFrom` 显式调 playCurrent:
```typescript
  async playFrom(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): Promise<void> {
    this.setQueue(playerId, items, startIndex, baseUrl);
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try { await this.playCurrent(playerId, baseUrl); }
    finally { this.advancing.delete(playerId); }
  }
```

- [ ] **Step 5: 再次运行测试**

Run:
```bash
npx vitest run tests/player/QueueController.test.ts
```
Expected: 4 个 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/player/QueueController.ts backend/tests/player/QueueController.test.ts
git commit -m "feat(player): 实现 QueueController 队列管理 + 切歌决策"
```

---

## Task 7: 改造 DLNA control.ts(乐观设态 + wait_for_can_play 增强 + reportState)

DLNA player 变瘦:实现 `ProtocolPlayer` 接口,`castToDevice` 加乐观设态 + `waitForCanPlay` 检查 `CurrentTransportActions`。新增 `reportState()` 上报给 PlayerController。

**Files:**
- Modify: `backend/src/services/dlna/control.ts`

- [ ] **Step 1: 增强 waitForCanPlay(检查 CurrentTransportActions 含 play)**

替换 `backend/src/services/dlna/control.ts` 中 `waitForCanPlay` 函数(约 239-249 行):
```typescript
// Wait until the device's AVTransport is ready to Play.对照 MA async_wait_for_can_play:
// 检查 CurrentTransportActions 含 "play"(而非只 != TRANSITIONING),并主动 poll 兜底。
async function waitForCanPlay(device: DlnaDevice, budgetMs = 10000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const xml = await soapCall(device.avTransportUrl!, AV_TRANSPORT, "GetTransportInfo", { InstanceID: "0" });
      const st = xml.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i)?.[1].trim() || "";
      const actions = xml.match(/<CurrentTransportActions>([^<]*)<\/CurrentTransportActions>/i)?.[1].trim() || "";
      // MA: 检查 CurrentTransportActions 含 "play";空值时乐观返回 true(设备漏报)
      if (st !== "TRANSITIONING" && (actions === "" || /play/i.test(actions))) return;
    } catch { return; }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`[cast] ${device.id}: waitForCanPlay 超时(10s),继续尝试 Play`);
}
```

- [ ] **Step 2: castToDevice 返回 mediaUri + 触发乐观窗口**

修改 `castToDevice` 签名,返回 `{ mediaUri }`,并去掉内部 300ms 死延迟(MA 不用固定延迟,改用 wait_for_can_play)。同时记录 mediaUri 供上报。

替换 `castToDevice` 的 Step1~Step4 部分(约 284-316 行),修改为:
```typescript
  // Step 1: Stop (tolerate errors). 对照 MA play_media: always clear queue (by sending stop) first.
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" });
  } catch (e: any) {
    console.log(`[cast] ${opts.deviceId}: Step 1 Stop failed (ignored): ${e?.message || e}`);
  }

  // 注:MA 在 stop 与 SetAVTransportURI 之间无固定 sleep,依赖 wait_for_can_play 等设备就绪。

  // Step 2: SetAVTransportURI.
  console.log(`[cast] ${opts.deviceId}: Step 2 SetAVTransportURI`);
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "SetAVTransportURI", {
    InstanceID: "0",
    CurrentURI: streamUrl,
    CurrentURIMetaData: metadata,
  });

  // Step 3: wait_for_can_play — 检查 CurrentTransportActions 含 play。对照 MA 10s budget。
  await waitForCanPlay(device);

  // Step 4: Play.
  await soapCall(device.avTransportUrl, AV_TRANSPORT, "Play", { InstanceID: "0", Speed: "1" });
  markOk(opts.deviceId);
```

并修改函数签名与返回值。把 `export async function castToDevice(opts: CastOptions): Promise<void>` 改为:
```typescript
export async function castToDevice(opts: CastOptions): Promise<{ mediaUri: string }>
```
在函数末尾(`console.log(...END...)` 之前)加 `return { mediaUri: streamUrl };`。

- [ ] **Step 3: 移除 consumeAutoAdvanceFlag(决策已上移)**

删除 `consumeAutoAdvanceFlag` 函数(约 349-359 行)和 `stopDevice` 里的 `rt.suppressAutoNext = true`(约 443 行)。决策由 QueueController 的 `advancing` 守卫 + PlayerController 乐观窗口负责。

替换 `stopDevice`(约 436-449 行)为:
```typescript
export async function stopDevice(deviceId: string): Promise<void> {
  const device = getDevice(deviceId);
  if (!device?.avTransportUrl) throw new Error("设备未找到");
  const rt = runtimeOf(deviceId);
  rt.nextEnqueued = false;
  try {
    await soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop", { InstanceID: "0" });
    markOk(deviceId);
  } catch (e: any) { markFailed(deviceId, "Stop", e); throw e; }
}
```

- [ ] **Step 4: 新增 DLNA ProtocolPlayer 适配 + reportState**

在 `control.ts` 末尾新增(实现 `ProtocolPlayer` 接口,供 UniversalPlayer 绑定):
```typescript
import type { ProtocolPlayer, PlayerState, QueueItem, PlaybackState } from "../player/types.js";

/** 把 DLNA 设备状态映射为 PlayerState(PlaybackState)。对照 MA _get_playback_state。 */
function mapTransportState(state: string): PlaybackState {
  // TRANSITIONING → BUFFERING(屏蔽瞬态,但 PlayerController 乐观窗口已处理)
  if (state === "PLAYING") return PlaybackState.PLAYING;
  if (state === "PAUSED_PLAYBACK") return PlaybackState.PAUSED;
  if (state === "TRANSITIONING") return PlaybackState.BUFFERING;
  return PlaybackState.IDLE; // STOPPED / NO_MEDIA_PRESENT / 其他
}

/** 创建 DLNA 协议 player 适配器(实现 ProtocolPlayer 接口)。 */
export function createDlnaProtocolPlayer(deviceId: string): ProtocolPlayer {
  const playerId = `dlna:${deviceId}`;
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const { mediaUri } = await castToDevice({
        songId: item.songId, title: item.title, artist: item.artist, album: item.album,
        mime: item.mime, deviceId, baseUrl, coverArt: item.coverArt,
      });
      return { mediaUri };
    },
    async stop() { await stopDevice(deviceId); },
    async pause() { await pauseDevice(deviceId); },
    async resume() { await playDevice(deviceId); },
    async seek(s: number) { await seekDevice(deviceId, s); },
    async setVolume(v: number) { await setDeviceVolume(deviceId, v); },
    async pollState(): Promise<PlayerState> {
      const s = await getDeviceStatus(deviceId);
      return {
        playerId,
        playbackState: mapTransportState(s.state),
        position: s.position,
        duration: s.duration,
        mediaUri: undefined, // DLNA GetPositionInfo 不返回 URI;用 currentMedia.songId 间接关联
        updatedAt: Date.now(),
      };
    },
  };
}
```

- [ ] **Step 5: 类型检查**

Run (in `backend/`):
```bash
npx tsc --noEmit
```
Expected: 可能有 `consumeAutoAdvanceFlag` 在 `queue.ts` 的 import 报错(下个 Task 修复)。其他无错误。

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/dlna/control.ts
git commit -m "refactor(dlna): control.ts 变瘦协议端点 + wait_for_can_play 增强 + ProtocolPlayer 适配"
```

---

## Task 8: 改造 eventing.ts(GENA 上报状态而非 emit track_ended)

GENA 状态变化改为调 `PlayerController.reportState()`,不再 emit `track_ended` 直接触发 queue。保留 `state_changed`(WS 推送用)。

**Files:**
- Modify: `backend/src/services/dlna/eventing.ts`

- [ ] **Step 1: 移除 track_ended emit,改为上报 PlayerController**

在 `backend/src/services/dlna/eventing.ts` 顶部 import 区加:
```typescript
import { PlaybackState, type PlayerState } from "../player/types.js";
```

替换 `parseLastChange` 末尾的 track_ended 逻辑(约 150-159 行):
```typescript
      this.states.set(deviceId, st);
      const prevState = prev.state;
      this.emit("state_changed", deviceId, st);
      // 不再 emit track_ended 直接触发 queue。改为上报 PlayerController,
      // 由上层去抖 + 状态迁移判断决策切歌(对照 MA:player 上报状态 → controller 决策)。
      this.reportToPlayerController(deviceId, st, prevState);
```

新增私有方法(在 `parseLastChange` 之后、`lastTrackUri` 声明之前):
```typescript
  private reportToPlayerController(deviceId: string, st: DeviceEventState, prevState: string | undefined): void {
    // 懒加载 PlayerController,避免循环依赖
    import("../player/index.js").then(({ getPlayerController }) => {
      const ctrl = getPlayerController();
      const playbackState = this.mapState(st.state);
      const playerState: PlayerState = {
        playerId: `dlna:${deviceId}`,
        playbackState,
        position: st.position || 0,
        duration: st.duration || 0,
        mediaUri: this.lastTrackUri.get(deviceId),
        updatedAt: st.updatedAt,
      };
      ctrl.reportState(playerState);
    }).catch(() => {});
  }

  private mapState(state: string | undefined): PlaybackState {
    if (state === "PLAYING") return PlaybackState.PLAYING;
    if (state === "PAUSED_PLAYBACK") return PlaybackState.PAUSED;
    if (state === "TRANSITIONING") return PlaybackState.BUFFERING;
    return PlaybackState.IDLE;
  }
```

- [ ] **Step 2: 类型检查**

Run:
```bash
npx tsc --noEmit
```
Expected: `../player/index.js` 还未创建(Task 9),暂时注释掉 reportToPlayerController 的 import 或先创建 stub。先创建 `backend/src/services/player/index.ts` stub:
```typescript
import { PlayerController } from "./PlayerController.js";
import { QueueController } from "./QueueController.js";

let playerCtrl: PlayerController | null = null;
let queueCtrl: QueueController | null = null;

export function getPlayerController(): PlayerController {
  if (!playerCtrl) playerCtrl = new PlayerController();
  return playerCtrl;
}

export function getQueueController(): QueueController {
  if (!queueCtrl) queueCtrl = new QueueController();
  return queueCtrl;
}

/** 接线:PlayerController 的决策转发给 QueueController。在 index.ts 启动时调一次。 */
export function wirePlayerQueueControllers(): void {
  const pc = getPlayerController();
  const qc = getQueueController();
  pc.onDecision = (decision, playerId) => {
    qc.handleDecision(decision, playerId).catch((e) => {
      console.warn(`[player] handleDecision ${decision} for ${playerId} failed:`, e);
    });
  };
}
```

- [ ] **Step 3: 类型检查通过**

Run:
```bash
npx tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/dlna/eventing.ts backend/src/services/player/index.ts
git commit -m "refactor(dlna): GENA 上报状态给 PlayerController,移除 track_ended 直推"
```

---

## Task 9: 改造 queue.ts(降级为纯数据层 + 兼容层)

原 `dlna/queue.ts` 的决策职责已上移到 `QueueController`。为保持路由层兼容,`getQueueManager()` 改为转发到 `getQueueController()`。移除 `onTrackEnded`/`pollAllDevices`。

**Files:**
- Modify: `backend/src/services/dlna/queue.ts`

- [ ] **Step 1: 替换 queue.ts 为兼容转发层**

将 `backend/src/services/dlna/queue.ts` 整体替换为:
```typescript
// 兼容层:原 QueueManager 的决策职责已上移到 player/QueueController.ts。
// 保留 getQueueManager() 转发 + 类型导出,供路由层(未迁移的部分)兼容调用。
import { getQueueController } from "../player/index.js";
import type { PlayMode, QueueItem, QueueSnapshot } from "../player/types.js";

export type { PlayMode, QueueItem } from "../player/types.js";
export type { QueueSnapshot } from "../player/types.js";

export function suffixToMime(suffix: string): string {
  const SUFFIX_MIME: Record<string, string> = {
    mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
    ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/opus",
    wma: "audio/x-ms-wma", ape: "audio/ape",
  };
  return SUFFIX_MIME[(suffix || "").toLowerCase()] || "audio/mpeg";
}

export function getQueueManager() {
  return getQueueController();
}
```

注意:`QueueSnapshot` 类型需在 `player/types.ts` 补充导出。在 `backend/src/services/player/types.ts` 末尾加:
```typescript
export interface QueueSnapshot {
  items: QueueItem[];
  currentIndex: number;
  playMode: PlayMode;
  isActive: boolean;
  ended: boolean;
}
```
并在 `QueueController.snapshot` 返回类型标注为 `QueueSnapshot`(在 `player/types.ts` import 它)。修改 `QueueController.ts` 顶部 import:
```typescript
import { PlayMode, QueueItem, QueueSnapshot } from "./types.js";
```
和 `snapshot` 方法签名:
```typescript
  snapshot(playerId: string): QueueSnapshot {
```

- [ ] **Step 2: 修复 peer.ts 的 import**

`peer.ts` import 了 `getQueueManager` 等,需确认兼容。检查 `backend/src/services/peer.ts:27`:
```typescript
import { getQueueManager, type QueueItem, type PlayMode, type QueueSnapshot } from "./dlna/queue.js";
```
此行无需改动(兼容层仍导出这些)。但 `QueueSnapshot` 形状变了(新增 `ended` 字段,移除 `currentMedia`)。检查 peer.ts 是否用了 `currentMedia`:

Run:
```bash
npx tsc --noEmit
```
Expected: 若 peer.ts 或 api/index.ts 用了 `snapshot.currentMedia`,会报错。逐一修复:把 `currentMedia` 读取改为通过 `getCurrentMedia(deviceId)`(从 control.ts)获取。

- [ ] **Step 3: 修复 currentMedia 引用**

搜索 `currentMedia` 在 peer.ts / api/index.ts 的使用:

Run:
```bash
npx tsc --noEmit 2>&1 | grep -i currentmedia
```

对每处报错,把 `snap.currentMedia` 改为 `getCurrentMedia(deviceId)`(从 `control.ts` import)。例如 peer.ts 的 `getQueueSnapshot`。

- [ ] **Step 4: 类型检查通过**

Run:
```bash
npx tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 5: 全部单测通过**

Run:
```bash
npx vitest run
```
Expected: 所有 player 单测 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/dlna/queue.ts backend/src/services/player/types.ts backend/src/services/player/QueueController.ts backend/src/services/peer.ts backend/src/routes/api/index.ts
git commit -m "refactor(dlna): queue.ts 降级为兼容层,决策上移到 QueueController"
```

---

## Task 10: 更新 index.ts 接线

启动时:wire PlayerController/QueueController、为每个 DLNA 设备注册 UniversalPlayer + ProtocolPlayer、poll 兜底改为上报 PlayerController。

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: 替换 track_ended 接线为 wire + poll 兜底**

在 `backend/src/index.ts` 找到(约 219-230 行):
```typescript
// Auto-advance the queue when a track ends naturally (GENA PLAYING → STOPPED).
getEventManager().on("track_ended", (deviceId: string) => {
  const baseUrl = process.env.DLNA_BASE_URL || `http://0.0.0.0:${port}`;
  getQueueManager().onTrackEnded(deviceId, baseUrl).catch(() => {});
});

// Fallback state-poll loop ...
getQueueManager().startPollLoop(() => process.env.DLNA_BASE_URL || `http://0.0.0.0:${port}`);
```

替换为:
```typescript
// 接线:PlayerController 决策 → QueueController 切歌。对照 MA 上层控制器链路。
wirePlayerQueueControllers();

// Fallback poll:对照 MA force_poll,GENA 不可用时主动 poll 设备状态上报 PlayerController。
// 由 QueueController 持有轮询,间隔放宽到 5s(MA 是 30s,本地设备事件支持差,用 5s 平衡)。
getQueueController().startPollLoop(() => process.env.DLNA_BASE_URL || `http://0.0.0.0:${port}`);
```

- [ ] **Step 2: 在 QueueController 实现 startPollLoop + 设备注册**

在 `backend/src/services/player/QueueController.ts` 加 poll 兜底 + 设备注册方法。在类内加:
```typescript
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  startPollLoop(baseUrl: () => string): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollAllDevices(baseUrl), 5000);
  }

  private async pollAllDevices(baseUrl: () => string): Promise<void> {
    for (const [playerId, player] of this.players) {
      const q = this.queues.get(playerId);
      if (!q || !q.isActive || q.currentIndex < 0) continue;
      if (this.advancing.has(playerId)) continue;
      try {
        const state = await player.pollState();
        this.ctrls.get(playerId)?.reportState(state);
      } catch (e: any) {
        console.warn(`[QueueController][poll] ${playerId}: ${e?.message || e}`);
      }
    }
  }

  /** DLNA 设备发现后注册:创建 UniversalPlayer + 绑定 DLNA ProtocolPlayer。 */
  registerDlnaDevice(deviceId: string, name: string): void {
    const playerId = `dlna:${deviceId}`;
    if (this.players.has(playerId)) return;
    const { createDlnaProtocolPlayer } = require("../dlna/control.js");
    const up = new UniversalPlayer(playerId, name);
    up.attachProtocol(createDlnaProtocolPlayer(deviceId));
    this.registerPlayer(playerId, up, getPlayerController());
  }
```
顶部加 import:
```typescript
import { getPlayerController } from "./index.js";
import { createDlnaProtocolPlayer } from "../dlna/control.js";
```
注意:`require` 在 ESM 不可用,改用动态 import 或顶部静态 import。改为顶部静态 import `createDlnaProtocolPlayer`(已在上一行),方法内直接用:
```typescript
  registerDlnaDevice(deviceId: string, name: string): void {
    const playerId = `dlna:${deviceId}`;
    if (this.players.has(playerId)) return;
    const up = new UniversalPlayer(playerId, name);
    up.attachProtocol(createDlnaProtocolPlayer(deviceId));
    this.registerPlayer(playerId, up, getPlayerController());
  }
```

- [ ] **Step 3: 在设备发现后调 registerDlnaDevice**

搜索 `refreshDevices` 调用处,在其后遍历注册。在 `backend/src/index.ts` 找到设备发现/轮询逻辑(若有定时 refresh),在 `refreshDevices()` 返回后加:
```typescript
for (const d of getCachedDevices()) {
  getQueueController().registerDlnaDevice(d.id, d.name);
}
```
若没有现成遍历点,在 `server.listen` 回调的 `setTimeout` 里(约 239 行)加这段(在 resumeActive 之前)。

- [ ] **Step 4: 更新 index.ts import**

`backend/src/index.ts` 顶部 import 区,把:
```typescript
import { getQueueManager } from "./services/dlna/queue.js";
```
改为:
```typescript
import { getQueueController, getPlayerController, wirePlayerQueueControllers } from "./services/player/index.js";
import { getCachedDevices } from "./services/dlna/control.js";
```
保留 `getEventManager` import(WS 推送仍用)。移除不再用的 `getQueueManager` import(若 index.ts 其他地方还用,保留兼容层调用)。

- [ ] **Step 5: 类型检查 + 构建**

Run:
```bash
npx tsc --noEmit
```
Expected: 无错误。如有 `getQueueManager` 残留引用,改为 `getQueueController()`。

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.ts backend/src/services/player/QueueController.ts backend/src/services/player/index.ts
git commit -m "feat(player): 接线 PlayerController/QueueController + DLNA 设备注册 + poll 兜底"
```

---

## Task 11: 端到端验证

- [ ] **Step 1: 启动后端,确认无启动错误**

Run (in `backend/`):
```bash
npm run dev
```
Expected: 日志出现 `MusicFree backend listening on...`,无 `Cannot find module` / 类型错误。观察 DLNA 设备发现后是否打印 `[QueueController]` 注册日志(可临时加 log)。

- [ ] **Step 2: 单测全绿**

Run (in `backend/`):
```bash
npm test
```
Expected: 所有 player/* 单测 PASS。

- [ ] **Step 3: 手动验证 DLNA 自动下一首**

测试步骤:
1. 前端投一首歌到 DLNA 设备,确认播放正常。
2. 等歌曲自然播完,观察后端日志:
   - 应出现 `[QueueController][playCurrent] <playerId>: idx=N → N+1`
   - `beginOptimistic` 乐观窗口开启
   - 设备报 PLAYING(新 uri)后乐观窗口关闭
   - 不应出现级联 `advance` 或 `stalled`
3. 验证"播 1 秒停"问题不再复现:若设备 SOAP Play 成功但实际没播,5s 后应触发 `stalled` → 重试当前首一次,而非级联误切。
4. 验证手动 next/prev 不与自动推进竞争:`advancing` 守卫应阻止并发。

- [ ] **Step 4: 验证本机播放未受影响**

前端本机播放(Howl)应完全不受此次重构影响(localNext 仍在前端自治)。确认本机播放/切歌正常。

- [ ] **Step 5: Commit(若有修复)**

```bash
git add -A
git commit -m "fix(player): 端到端验证修复"
```

---

## Self-Review

**1. Spec coverage:**
- 上层 Player Controller(切歌决策上移):Task 3/4/6 ✓
- 双层去抖(0.25s + 0.5s):Task 4 PlayerController ✓
- 状态迁移判断(prev/new compare):Task 3 PlaybackTracker ✓
- TRANSITIONING 屏蔽:Task 4 乐观窗口 + Task 3 tracker ✓
- 乐观设态:Task 4 beginOptimistic + Task 7 castToDevice ✓
- 60s 卡死兜底:Task 3 PlaybackTracker ✓
- 5s play 超时:Task 4 PlayerController ✓
- wait_for_can_play 检查 CurrentTransportActions:Task 7 ✓
- GENA 不再直推 track_ended:Task 8 ✓
- next/prev 守卫:Task 6 advancing ✓
- UniversalPlayer 预留:Task 5 ✓
- 本机不动:计划明确不动 frontend ✓
- 非 flow 路径:每首一个 URL,Task 7 castToDevice ✓

**2. Placeholder scan:** 无 TBD/TODO,每个 step 有具体代码或命令。

**3. Type consistency:**
- `TrackDecision` 在 Task 3 定义,Task 4/6 引用一致 ✓
- `ProtocolPlayer` 在 Task 2 定义,Task 5/7 引用一致 ✓
- `QueueSnapshot` Task 9 补充,peer.ts/api 引用一致 ✓
- `createDlnaProtocolPlayer` Task 7 定义,Task 6/10 引用一致 ✓
- `handleDecision` 签名 Task 4 注入 `onDecision`,Task 6 实现一致 ✓

**已知风险:**
- `registerDlnaDevice` 用静态 import `createDlnaProtocolPlayer`,需确认 control.ts 已 export(Task 7 Step 4 已 export)。
- peer.ts 的 `currentMedia` 兼容性需在 Task 9 Step 3 逐一修复。
- 设备发现时机:`registerDlnaDevice` 需在 `refreshDevices` 后调用,Task 10 Step 3 处理。
