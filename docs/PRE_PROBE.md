# 服务端预探测(提前找可播源)

> 目标一句话:**让服务端预探测成为三条播放链路共同的大脑** —— 队列一变,服务端就
> 提前把后面 N 首探一遍:能播的把有效源和判定缓存好(谁播都零等待);不能播的直接
> 标死,客户端切歌时跳过;连续多首探不到就报「大面积无源」并暂停深扫。

## 三条链路如何吃到同一份判定

| 链路 | 谁在播放 | 谁执行「跳过」 | 判定来源 |
|---|---|---|---|
| DLNA / 投屏 / 组 / AirPlay | 服务端 cast 到设备 | **服务端** `QueueController.playCurrent` → `judgePlayable` | `getCachedPlayability(songId)`(预探测缓存) |
| Web 前端(本机) | 浏览器 Howl | **客户端**(按服务端判定预跳 + 播放失败兜底) | `POST /v1/stream/probe` 的 `verdict` |
| Flutter 客户端(本机) | 端侧播放器 | **客户端**(同上) | 同上 |

关键约定:**判定权威只在服务端**,客户端只做执行与兜底。

## 判定写在哪、怎么读

- 判定结果落在 `streamFallback` 的模块级缓存(`playableCache` + `fallbackCache`),
  由 `getCachedPlayability(songId)` 读出四态:
  `playable` / `unplayable` / `transient` / `unknown`。
- **正/负结果都带 TTL**:正结果 1 小时(不刷新 URL,过期由 `/rest/stream` 的上游
  失败自愈),负结果默认 45s(`core-pre-probe.negativeTtlSeconds`)——**源恢复自动复活**。
- `transient`(网络抖动/超时)与 `unknown`(没探过)**绝不等于不可播**。

## 触发时机(谁调 `schedulePreProbe` / `schedule`)

| 触发点 | 玩家键 | 说明 |
|---|---|---|
| `QueueController` 起播 / 切歌 / 增删 / 改序 / 改模式 / 重洗牌 / 恢复 | 裸 `deviceId`/`groupId` | 投屏链路 |
| `PeerManager` 本机队列变动(`localPlayFrom`/`localEnqueue`/`localRemoveAt`/`localReorder`/`localSetPlayMode`/`localSetIndex`) | `local:<userId>` | 本机链路(2026-09-11 接入) |

调度器为多监听(`addOnChange`):投屏走 `queue_changed`,本机走 `peer_queue_changed`,
两者互不顶替。快照里带 `preProbe` 状态位(`ready/scanned/misses/exhausted/cooldownUntil/at`)。

## 洗牌序(shuffle)的物化要求 ⚠️

`peekUpcomingPositions` 的 shuffle 分支依赖 `shuffleOrder`。**若触发预探测时该序列
还是空的,shuffle 模式下 lookahead 会静默扫 0 个位置**。

因此凡「改队列 / 改模式后立即触发预探测」的路径都必须先物化序列(见
`QueueController.ensureShuffleForLookahead`):`enqueue`、`setPlayMode("shuffle")`、
`removeAt` 走惰性重建;`reorder` 显式重建(长度未变但下标→歌曲映射变了)。

> 本机队列**没有服务端洗牌序**(随机顺序由客户端持有,见 SPEC:纯离线队列由客户端
> 洗牌),故本机 shuffle 模式下服务端 peek 取不到位置流 —— 这是有意为之:随机模式由
> **客户端上报候选歌 id** 走 `/v1/stream/probe` 取判定。

## 对外契约:`POST /rest/api/v1/stream/probe`

```
body: { songIds: string[] }   // ≤5
resp: { success: true, results: [{
  songId, ok, local?, fallback?,
  verdict: "playable" | "unplayable" | "transient" | "unknown",
  reason?
}] }
```

- **客户端只应在 `verdict === "unplayable"` 时预跳**;`transient`/`unknown` 照常播放,
  由播放失败兜底。`ok` 字段保留(向后兼容旧客户端)。
- 本机歌曲(或已缓存文件的 web 歌)零开销直返 `playable`;web 歌走
  `ensurePlayableStream`(Range 探测 + 多源换源 + 写回 DB)。

## 代码位置

- 调度器:`backend/src/services/player/preProbeScheduler.ts`(`schedule` / `scan` / `peekUpcomingPositions`)
- 核心接线:`backend/src/services/player/QueueController.ts`(`schedulePreProbe` / `judgePlayable` / `ensureShuffleForLookahead`)
- 本机链路:`backend/src/services/peer.ts`(`localPeekSource` / `scheduleLocalPreProbe`)
- 判定与缓存:`backend/src/services/source/online/streamFallback.ts`(`ensurePlayableStream` / `getCachedPlayability`)
- 插件配置:`backend/src/services/plugin/core/preProbe.ts`(`core-pre-probe`)
- 端侧消费:Web `frontend/src/stores/player.ts`(`probeUpcoming` / `skipKnownUnplayableOrder`);
  Flutter `lib/providers/player/player_playback_helpers.dart`(`_probeUpcoming` / `_skipKnownUnplayable`)

## 测试

- `backend/tests/player/preProbeScheduler.test.ts` — 扫描纯度 / 枯竭判据 / 触底静默 / 绕过圈上限
- `backend/tests/player/localPreProbe.test.ts` — 洗牌序物化 + 本机队列驱动 + 清空作废
- `MusicFlow-client/test/providers/player/playback_mode_test.dart` — 四态 verdict 预跳边界
