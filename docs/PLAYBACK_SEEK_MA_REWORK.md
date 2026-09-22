# MusicFlow 播放链路 MA 化专项改造

> 专题：**进度条跳转 / 播放位置 / 播放通道 / 歌词进度** 四条链路按 Music Assistant（MA）语义重做
> 版本基线：后端 `v4.0.5-3-g6789e54`（230 `/workspace/MusicFlow`）· 客户端 `v5.0.21`（230 `/workspace/MusicFlow-client`）
> 编写日期：2026-09-22　状态：**patch 1~8 已落地并热部署到 240；patch9（seek 源行复用）已落地并热补丁部署 240 验证；剩余项见第 6 节**

---

## 0. 一句话结论

MusicFlow 现有 seek 的实现语义是「**在跑着的流里挪指针**」，而 MA 的语义是「**用新起点重建一条流**」。
前者在实时转码管道（本项目的核心音源形态）上物理落不了位 —— 这是 sendspin 卡顿、DLNA 进度虚高、
客户端本机「拖到哪都从头开始」三类故障的**同一个根因**。
本次改造把三条播放链（sendspin / DLNA / AirPlay）+ 客户端本机通道统一到 MA 语义，并顺带根治
ffmpeg 孤儿泄漏与 pacing 墙钟空洞两个放大器。

---

## 1. 真机取证：四类故障与根因

取证环境：240 容器 `musicflow`（真 ESP32 sendspin `esp32-player2`、真 HiVi H5MKII DLNA「主卧」），
`docker logs -t` 双写 + `ps -eo pid,ppid,stat,etime,rss,args` 进程表 + tcpdump 抓 HTTP 请求行。
**结论全部来自真机现场，不是代码推理。**

| # | 现象（用户真机） | 取证 | 根因 | 级别 |
|---|---|---|---|---|
| F1 | sendspin 拖动后**持续卡顿**、听感断断续续 | `[window][seek] 重定位 → 重起 ffmpeg(-ss 43)` 到 `timeline RE-anchored` 相差 **7.4s**；期间设备零音频 | `window.seekTo()` = kill 旧 ffmpeg → 冷起新的，**设备端 5~7.4s 完全断流**，缓冲耗尽后按实时速率补不回来 | P0 |
| F2 | sendspin **进度条比真实时间快** | 实测 3.94s 内 `pos` 涨 8.875s | seek 瞬间写 `paceAnchorWall=now`，但首帧 5~7.4s 后才到 → `dueMs` 全落在过去 → 帧无节制连发，时间线被灌快 | P0 |
| F3 | 客户端**本机播放拖到任何位置都从头开始** | tcpdump：服务端 **0 次 seek、0 次 `/rest/stream` 重拉**，只有起播那一次（无 `timeOffset`） | 客户端 `_seekWithFallback` 漂移兜底只是**重复执行一次 `player.seek()`**，对不可字节 seek 的实时管道永远无效，从不升级为已有的 `_reloadStreamForSeek()` | P0 |
| F4 | DLNA **进度比真实快 + 外推越界提前切歌** | `[DLNA][seek] 成功 …(基线已改锚到 Ns)` 立刻报 `pos=N`；紧接着 `设备恒报 0 → 放弃落位校验` | HiVi/MUZO 固件播实时转码流时 `GetPositionInfo` **恒回 RelTime=0**：SOAP `Seek(REL_TIME)` 静默失效，基线仍锚到目标 → 纯墙钟外推 | P0 |

**放大器（不是根因，但决定故障是否致命）**

- **A1 ffmpeg 孤儿泄漏**：240 现场 10 个 ffmpeg 存活 18~29 分钟、各 65MB RSS、另有 5 个 `Z` 僵尸。
  根因 `streamEngine.ts GroupPump.play()` 的 `this.window = stream ?? null` **直接覆盖**，
  旧 `WindowStream` 从未 `close()`（`releaseAudio()` 才会 `close()`→`killProc()`）。
  → CPU/内存争抢 → `PcmWindow 等数超时(15000ms)` → `decision=idle_early` → 切歌 → 再泄漏，恶性循环。
- **A2 seek 后缓冲过浅**：设备上报 `output_delay/required_lead/min_buffer` **全 0** →
  `computeCommonSendAhead()` 退化成缺省 **800ms**，空窗后补不回来。

---

## 2. 权威契约：MA 是怎么做的

源码在 230 `/workspace/MA`（2026-09-20 版）。改造前必读，三条铁律：

### 铁律 1 —— seek = 重建流，不是在流里挪指针

`controllers/player_queues/controller.py:862`

```python
queue.elapsed_time = position
queue.elapsed_time_last_updated = time.time()
signal_update()                      # ① 先把新位置发布出去，防 UI 拿旧值回跳(snapback)
await play_index(queue_id, current_index, seek_position=position)
# → _load_item(seek_position=…) → 起一条**从新起点开始的新流**
```

对照本项目：sendspin 应映射到 `beginRebuild()` + 帧边界 `applySwap()`；
DLNA 应映射到 `reseekByRecast()`（带 `timeOffset=N` 重投一条新流）；
客户端本机应映射到 `timeOffset` 重拉。**没有任何一条链是「Seek 正在播的那条流」。**

### 铁律 2 —— 位置是「(值, 时间戳)」对，主备来源永不混用

`models/player.py:1521 corrected_elapsed_time`

```python
elapsed + (now - elapsed_time_last_updated)   # 仅 PLAYING 时外推，clamp 非负
_resolve_position(primary, primary_at, fallback, fallback_at)
```

- 位置必须**与其时间戳同源**；非 PLAYING **不得外推**。
- 主（设备上报）/ 备（合成推算）**永不混用** —— 混用就会出现「设备停着但进度条在走」。
- 本项目现状：DLNA 侧 `positionEstimates` 已是 `{pos, at, dur}` 的 MA 式结构 ✅；
  病灶不在结构而在**基线锚错**（锚到请求目标而非设备真实位置）。

### 铁律 3 —— 流幂等：每次播放新建 stream session，起点在起流时传入

参考实现：`providers/sendspin/player.py`、`universal_group/ugp_stream.py`、
`providers/dlna/player.py`、`providers/airplay/`。

---

## 3. 现状架构与结构性缺陷

### 3.1 通道复用（用户明确要求根治：「播放通道区分开，不能复用」）

```
                       ┌──────────────────────────────────────┐
                       │  /rest/dlna/stream/:token?raw=1      │  ← 唯一实时管道
                       │  (dlna/control.ts:552                │     · 对 DLNA 设备忽略 Range
                       │    loopbackRawStreamUrl /            │     · 伪造 12h Content-Length
                       │    createCastSession)                │     · raw=1 才转发 Range 给上游
                       └───────┬──────────────┬───────────────┘
                               │              │
              sendspin ffmpeg ─┘              └── AirPlay ffmpeg (protocolPlayer.ts:7)
              (streamEngine → PcmWindow)          (decoder → RAW-ALAC)
                               │
                     DLNA 渲染器直接拉（SOAP SetAVTransportURI）
```

**后果**：三条链共享同一个 token 语义与同一条 URL 拼装逻辑 →
① 任一链改 URL 参数（如 `timeOffset`）会串到别的链；
② 无法按通道独立控制管线开关 / 音量归一化 / 生命周期；
③ sendspin 的 ffmpeg 实际在拉「给 DLNA 设备用的流」，这也是 `-ss` 行为不稳定的来源之一。

### 3.2 三链 seek 实现对照（改造前）

| 链 | 改造前做法 | 致命点 |
|---|---|---|
| sendspin | `window.seekTo(target)` → kill+spawn ffmpeg | 5~7.4s 断流空窗（F1）+ pacing 不补偿（F2） |
| DLNA | SOAP `Seek(REL_TIME)` + 落位校验 | 设备恒报 0 → 校验必然放弃 → 基线虚锚（F4） |
| AirPlay | 优先子进程内原地 seek（换 decoder，RTSP/RTP 不动）；失败则 `seekSec` 重投 | 语义**最接近 MA** ✅，但音源仍复用 DLNA token（3.1） |
| 客户端本机 | `player.seek()`，漂移兜底再 `seek()` 一次 | 实时管道不可字节 seek → 永远无效（F3） |

---

## 4. 改造总纲（四层，自上而下）

| 层 | 目标 | MA 对应 | 落地情况 |
|---|---|---|---|
| **L1 位置模型** | 位置 = (值, 时间戳)；仅 PLAYING 外推；主备不混 | `corrected_elapsed_time` | DLNA 已有 ✅；sendspin/DLNA 基线修正见 patch6/7 |
| **L2 seek 语义** | 一律「发布位置 → 重建流 → 原子切换」 | `play_index(seek_position=N)` | sendspin ✅ patch6；DLNA ✅ patch7；客户端 ✅ patch2 |
| **L3 资源生命周期** | 一设备一流；谁建谁关；过期重建立即释放 | 每次播放新建 session | ✅ patch1/6（`releaseAudio` + `rebuildGen`） |
| **L4 通道独立** | 每通道独立 session / URL / 位置源 / 管线开关 | per-provider player | ⏳ AirPlay 见 6.1 |

---

## 5. 已落地改造（patch 1~8）

> 编号为本文档统一编号（排查过程中的临时编号不同，以本表为准）。

均在 230 `src/` 修改 → `npx tsc` → 单文件热替换进 240 容器 → `docker restart` 验证。

### patch1 · ffmpeg 孤儿泄漏（P0）
**文件** `backend/src/services/sendspin/streamEngine.ts` · `GroupPump.play()`
**改法**：在 `await source()` **之前**先 `this.releaseAudio()`（先杀旧的再 spawn 新的，把瞬时双进程压到最短）。
**实测**：ffmpeg 10 → 1，僵尸 5 → 0，容器内存 1.35G → 674MB。

### patch2 · 起播跳转不再二次冷起
**文件** 同上 · `play()`
**改法**：`PumpSource` 增加 `startMs` 参数 → `defaultSource`/`streamingSource` 透传给
`new PcmWindow(src, startMs)`（构造本就支持，此前未透传）；删掉 `play()` 里原来的
「建流 → `seekTo()` → 再冷起」。起播即带 `-ss`。

### patch3 · seek 后 pacing 墙钟空洞补偿
**文件** 同上 · `pushLoop()` `reseed` 分支
**改法**：首帧到达时重设 `paceAnchorMs = group.positionMs; paceAnchorWall = Date.now()`。
此前只有 pause→resume 路径做了补偿，seek 路径漏了 → 帧无节制连发（F2）。

### patch4 · seek 后重锚提前量抬到 3s
**文件** 同上 · 新增 `SEEK_RESEED_LEAD_US = 3_000_000`
**改法**：`lead = max(sendAhead, 3s)`（仅 seek 重锚路径；正常起播语义不变）。
理由：A2 —— 设备缓冲参数全 0，send_ahead 退化成 800ms，空窗后补不回来。

### patch5 · 客户端本机：漂移兜底升级为重拉
**文件** `MusicFlow-client/lib/providers/player/player_seek.dart` · `_seekWithFallback()`
**改法**：`drift > 2000ms` 且 `_currentStreamUrl != null` → 不再重复 `player.seek()`，
改调已存在的 `_reloadStreamForSeek()`（带 `timeOffset` 重拉）。**修 F3。**

### patch6 · 客户端：能力判定 fail-open
**文件** `MusicFlow-client/lib/providers/player/player_provider.dart` · `_serverPipelinedHttp()`
**改法**：`serverType`/`serverVersion` 缺失时返回 `true`（这两个字段**只在密码登录时写入一次**，
升级上来的库/复用旧会话进入时为 null → 误判 false → 拖动彻底失效）。
判据：明确识别出非 MusicFlow（Navidrome 等）才返回 false。
代价权衡：误判 true 的代价只是一次重拉；误判 false 的代价是功能全废。**修 F3 的兜底。**

### patch7 · sendspin seek = 后台预建 + 帧边界原子切换（MA 核心）
**文件** `backend/src/services/sendspin/streamEngine.ts`

```
seek(target)
  ├─ ① 立即 this.group.positionMs = target        ← MA: 先发布位置，防 UI snapback
  ├─ ② 未运行 → pendingSeekMs（交由 play() 消费）
  └─ ③ beginRebuild(target)                        ← 后台 source(songId, target) 预建
        · rebuildGen++ → 连续拖动只认最后一次，过期重建立即 close()（防泄漏）
        · 预建失败不影响当前播放（旧流仍在播）
pushLoop 帧边界
  └─ applySwap()：换 window/pcm → 重锚 positionMs + paceAnchorMs/Wall + timelineReseed++
                  → 打日志 → **最后**才 close() 旧流
```

**关键点**：旧流在预建期间**继续播** → 设备端零空窗（根治 F1）；
切换在帧边界原子完成，位置/pacing/时间线三者一次性同源重设（不会漂移）。
日志串：`[pump][rebuild] 新流就绪 …` → `sendspin seek 切换完成: pos=Nms(旧流此刻释放,设备零空窗)`。

### patch8 · DLNA：SOAP Seek 不可靠 → 重投流重建（MA 核心）
**文件** `backend/src/services/dlna/control.ts`（7 处）

| 改动 | 说明 |
|---|---|
| `DeviceRuntime` +3 字段 | `unreliableSeek` / `seekNoReportCount` / `lastCastOptions` |
| `CastOptions.timeOffset` | >0 时编进流 URL `&timeOffset=N`（路由本就支持 `parseTimeOffset`） |
| `castToDevice` | 记住上次投屏参数（剥离 `timeOffset`：它只对这一次起播有效） |
| `reseekByRecast(id, sec)` | 完整 `SetAVTransportURI(Stop→SetURI→waitForCanPlay→Play)` + 位置基线锚到 target |
| `seekDevice` | `unreliableSeek && lastCastOptions && verify!==false` → 走重投；失败回退 SOAP |
| `verifySeekLanding` | `raw<=0` 时 `seekNoReportCount++`，**连续 2 次**即置 `unreliableSeek`；确已落位则清零 |

⚠️ `verify:false` 必须仍走 SOAP —— 那是校验链的单次重发，走重投会递归。
日志串：`[DLNA][seek] … 连续 N 次不报位置 → 判定 SOAP Seek 无效` →
`[DLNA][seek] … SOAP Seek 不可靠 → 重投流重建(timeOffset=N)` → `重投流完成 …`。

### patch9 · seek 后出声延迟（用户报「跳转进度后要十几秒才出声」）

**症状**：seek 后 4~14s 才出声。生产日志 `开始获取音源`→`音源就绪`：67s=6.84 / 129s=**15.34** / 178s=7.03。

**根因两段，互相独立，且与带宽无关**（240 逐层排除：WebDAV 带宽 5.44MB/s、上游 Range 支持 206、
回环响应头正确转发、loudnorm 各变体 200~300ms、HTTP 层 2~4ms、CPU Xeon E-2244G/8 核 load 1.8、
回环 vs 直连单请求耗时 ~340ms vs ~370ms）:

| # | 段 | 实测 | 状态 |
|---|---|---|---|
| ① | `resolvePlayableRow` **每次重跑「播放优选」** | 1.85~2.53s/次，**结果恒定**（web 行恒 `preferred-swap` 到组内核心曲库行） | ✅ 本版已修（源行复用） |
| ② | ffmpeg 对**无 SEEKTABLE 的网盘 FLAC** 的输入 `-ss` 反复发**开放式** Range | 单次 **9 个** `Range: bytes=N-`，4~13s，越往后越慢 | ⬜ 未修，见第 6 节 |

**改动 · 源行复用（本版落地）**
- `source/resolveAudio.ts`：`resolvePlayableRow(songId, { preferRowId })` —— 命中直接返回
  （`reason=reuse-active`，零成本一次主键查找），跳过 `resolvePreferredSong` → 逐候选
  `probeLocalSourceOk` → `verifyRow` 整段。判定放在**快缓存之前**：快缓存回的永远是原始 `songId`
  那行，而实际在播的可能是优选换过的组内兄弟行。
- `sendspin/streamEngine.ts`：`GroupAudio.sourceRowId` 回带**实际出流**的行；pump 记
  `{songId, rowId}`，**仅同曲** seek 重建时作 `preferRowId` 传回；切歌不复用；复用命中却出不了流
  → 清记账 + 回退完整裁决**一次**（回退成功则按新结果重建记账，不会永久退化）。
- 依据用户口径：「如果是网络源/WebDAV 源，在跳转进度时应该**自动复用正在播放的地址**才对，
  不应该回退到查找播放源这一步」。
- **240 实测**：同曲 seek 重建日志 `复用源行=<rowId>` + `[resolve] <A> -> <A> (reuse-active) ms=2`
  （原为 1.85~2.53s 的 `preferred-swap`）。

**未采纳的一版（记录以免重走）：输入粗定位 `-noaccurate_seek`**
该参数曾在 240 容器内**独立** ffmpeg 上量到 10086ms → 7193ms（**-29%**），一度随本 patch 一起落地；
但在**真实 seek 重建路径**上无法确认收益，且热补丁实测期间出现 `PcmWindow 等数超时(15000ms)`。
后续取证（240 日志 12:31 故障链，**E 已回滚仍完整复现**）表明该故障另有根因 ——
`play()` 世代记账与「seek 落在起播窗口」的双路径重复（见 6.6），**故 E 已从本方案撤出**，不在本版内。

**实验否证过的一版（记下来别再走）**：先用容器内独立脚本量到「直连 WebDAV 仅 258ms」，
据此差点绕向 CDN / 回环优化 —— 实为 `-headers` 的值含 `\r\n` 经 shell 被截断成换行、
ffmpeg 报 `No trailing CRLF found` 且**根本没读输入**，量到的是假的快。
**量 ffmpeg 必须用 `execFileSync(bin, [args...])` 数组传参**。

**契约锁**：`tests/services/resolveAudio.test.ts`（4 例）、
`src/services/sendspin/streamPumpRowReuse.test.ts`（4 例，新增）。两组均做过**负向验证**
（变体分别精确变红，失败信息恰好点中所修语义）。

---

## 6. 剩余改造（设计 + 落地步骤）

> **所有播放链路的跳转进度性能优化（A~F 六项）已拆到 `docs/PLAYBACK_SEEK_OPTIMIZATION.md`** ——
> 本文只管 seek 的**语义与正确性**（世代竞态 / 钳制 / 源行复用契约）；
> 那边管「拖一次进度条要多久才出声」（五条链路真机实测、候选取舍、优化方法、**各链路验收方式**）。

### 6.1 AirPlay 通道独立（L4，未开工）
**目标**：AirPlay 不再复用 `dlna/control.ts` 的 `createCastSession()`。
**方案**（代码级）：
1. 新增 `services/airplay/session.ts::createAirPlaySession(songId, deviceId, baseUrl, {timeOffset})`，
   走 `/rest/airplay/stream/:token`（新路由，复用 `parseTimeOffset`），token 命名空间与 DLNA 分离。
2. `protocolPlayer.ts` 改用新函数；`mediaUri` 用新 URL（保持 per-cast，供 `track_changed` 判定）。
3. `services/audio/pipelineSwitches.ts` 已有 `pipeline.airplay` 通道开关 → 新路由按通道取开关，
   不再继承 DLNA 的回退键语义。
4. 保持现有「原地 seek（子进程内换 decoder）+ `seekSec` 重投兜底」—— 它本身就是 MA 语义，不动。
**验收**：AirPlay 起播时 `ps` 里的 ffmpeg 命令行不再出现 `/rest/dlna/stream/`。

### 6.2 DLNA：`unreliableSeek` 持久化 + 首帧即带 offset（未开工）
- 现状 `unreliableSeek` 在内存 `runtimes`，容器重启后重新试错 2 次才降级。
  → 建议落到 `settings`（键 `dlna.seek.unreliable.<deviceId>`），首次即走重投。
- 支持「起播即跳转」：`castToDevice` 已支持 `timeOffset`，上层 `playMedia` 在存在目标位置时直接带。

### 6.3 客户端：patch5/6 发版（待 CI）
改动已在 230 `/workspace/MusicFlow-client`，**尚未 commit**。属于 `v5.0.21 → 下一版`。

### 6.4 歌词进度条对齐（设计已核对，无需大改）
核对结论：`frontend/src/stores/player.ts` 的 `updateLocalLyric()` / `updateCastLyric()`
**已经是取同一个 `currentTime` 做游标推进**（前进摊销 O(1)、后退回扫），
**没有另起 Timer** —— 结构上已符合「同源时钟」。
因此歌词不需要重写，需要保证的是**上游位置本身准确**：
- seek 瞬间必须发布新位置（patch7 ① / patch8 已完成）→ 歌词不会 snapback 回跳；
- 非 PLAYING 不得外推（否则停住时歌词继续滚）→ 随 L1 复核各端 `pollState`。

### 6.5 网页端 / HA 卡片
- 两端 seek 均有 **250ms trailing 去抖**（卡片 `_seek()`、网页 `castSeek()`），客户端只在
  `onChangeEnd` 发 1 次 —— 已是合理节律，**不要改节流**。
- 卡片「分母为 0 不发 seek」是保护逻辑，不是 bug。
- 待复核：卡片/网页读位置时是否遵守「非 PLAYING 不外推」。

---

### 6.6 起播窗口内的 seek 世代竞态（240 实锤，**优先级最高**）

**症状**：切歌后 1s 内拖进度条 → 拖动「生效了但不出声」：位置发布到目标值、随后转 IDLE、
15s 后从 0 重投，再 30s 判 frozen → **放行切歌**（整首歌被跳过）。

**240 日志（12:31，E 已回滚，与输入粗定位无关）**：

```
12:31:48.336 [pump][play] song=47ac4fb2 startMs=0 开始获取音源          ← play#1（切歌后 1s 内）
12:31:49.518 seek 130s → [pump][seek] running=false window=false        ← pump 还没起来
12:31:49.521 [pump][play] song=47ac4fb2 startMs=130000 开始获取音源(seek 重建)  ← play#2
12:31:50.154 play superseded (epoch 8→10),窗口已就地释放
12:31:51.542 流式窗口提前 EOF: lo=12480000 frame=5200 eof=true decoded=12480000
12:31:51.542 pushLoop 退出: contentEnded=true
12:32:13.593 IDLE 持续 15122ms ≥ 15000ms → stalled
12:32:14.433 playCurrent 重投 startMs=0 → 12:33:18 位置冻结 → 放行切歌
```

**机理**：`seekCore` ① `pump.seek()` 在 `running=false`（起播窗口）时**只记 `pendingSeekMs`**，
② 却**无条件**继续走「完整起播路径重建」→ `playCore` → `stop() + armSeek() + play()`，起了**第二个 play**。
两个 play 在 `await source()` 处交错，各自 `++epoch`、回来验世代 → 互相把对方刚建好的窗口掐掉；
存活的那个 pump 拿到 `eof=true / decoded == baseSample` 的**零输出窗口** → 判成播完退出。
`流式窗口提前 EOF` 在 v4.0.12 原生（A/E 均未部署）时期已出现多次，属**存量缺陷**。

**修法（2026-09-22 已落地 · patch10 · 240 实测通过）**

1. `seekCore`：pump 处于起播中（`busy`）时**只记起播位置**，不再起第二个 play（单飞）。
   此前 ② 无条件重建 —— 两个 play 各自 `++epoch`，在 `await source()` 处交错、回来互相掐窗口。
2. `play()`：`await source()` 回来后若 `pendingSeekMs` 与本次起点不符 → 关掉刚建的窗口、
   **带新起点重来一次**（窗口 `baseSample` 必须等于起播位置）。
3. 回归锁：`src/services/sendspin/streamPumpStartupSeek.test.ts`（7 例）；负向矩阵 N1~N5
   每个变体精确变红（含「过度保留」方向）。

**第二批收口（同日 240 复测时暴露，一并修掉）**

| 缺陷 | 现象（240 实测） | 修法 |
|---|---|---|
| 钳制用错时长 | 切歌后拖到 140s：`[pump][seek] want=140000 target=114000 dur=114000` —— `durationMs` 还是**上一首**的（新歌 play 尚未提交），目标被裁短 | `pump.seek(seconds, {clamp})`：`seekCore` 在 `busy` 或 `group.current` 为空时**不钳制**；收口改由本轮 play 用 `srcResult.durationMs`（新歌真实时长）完成，并把钳制结果**回写** `pendingSeekMs` 后再重来 |
| 重来丢失源行 | 自纠重来又跑一遍完整播放优选（`preferred-swap ms=2059`），白等 2s | 自纠分支把**刚拿到的** `sourceRowId` 记账（它就是同一首歌的生效行）→ 重来那轮直接 `reuse-active ms=1` |
| 无限重来风险 | 负向变体 N1（去掉回写）→ 每轮重来都重新取一次音源，**死循环** | `playRetry` 收敛保险：自纠最多 2 次，超限 `warn` + 按当前窗口提交（绝不无限 spawn ffmpeg） |

**240 实测（2026-09-22 13:22，A + patch10 热补丁）**

```
13:22:21.063 [pump][seek] want=60000 target=60000 dur=329000 running=false   ← 不再沿用旧歌时长钳制
13:22:21.063 [seekCore] 起播窗口内 → 只记起播位置,不再起第二个 play
13:22:22.160 起播期间收到新 seek(0→60000ms) → 带新起点重来
13:22:22.160 ...(seek 重建...) 复用源行=5ed2ba54-...                         ← 复用刚拿到的源行
13:22:22.161 [resolve] ... (reuse-active) ms=1                               ← 1ms（改前 preferred-swap 2059ms）
```

- 三轮「切歌 + 250ms 内拖动」全部通过：位置落在目标值（60 / 100 / **140**，此前 140 被裁成 114），
  随后 1:1 推进；`提前 EOF / stalled / 冻结 / 放行切歌` = **0**。
- 抓包（240 → 设备 :8928）：189 KiB/s = 48kHz×2ch×16bit；载荷零字节 **0.4%** → 音频在流且非静音。
## 7. 验收矩阵（改完必跑）

前置：`mf_ctl.sh loglevel debug`；`docker exec musicflow ps -eo pid,ppid,stat,etime,rss,args | grep '[f]fmpeg'`
—— **活跃数必须 == 在播设备数，且无 `Z` 僵尸**。

| 端 | 场景 | 通过判据 | 关键日志 |
|---|---|---|---|
| sendspin | 起播窗口内拖动 | 起播即带 `-ss`，无二次冷起 | `[pump][seek] ⚠️pump 未运行 → 记起播位置` |
| sendspin | 运行中前进/后退拖动 | **零空窗**、不卡、进度 1:1 | `[pump][rebuild] 新流就绪` → `sendspin seek 切换完成` |
| sendspin | 连续快拖 | 只认最后一次，无进程堆积 | `作废过期重建 … 已释放`；ffmpeg 数不涨 |
| DLNA | 拖 2 次后 | 走重投流，位置不再虚高 | `连续 N 次不报位置 → 判定 SOAP Seek 无效` → `重投流重建(timeOffset=N)` |
| DLNA | 拖动后 60s | `pos` 与真实时间 1:1，不提前切歌 | `[DLNA][status] … rawPos= pos=` 单调 |
| AirPlay | 起播 + 拖动 | ffmpeg 命令行**不含** `/rest/dlna/stream/` | （6.1 完成后） |
| 客户端本机 | 拖到任意位置 | 服务端收到**带 `timeOffset` 的 `/rest/stream` 重拉** | tcpdump 抓请求行 |
| 四端 | 收尾 | 无孤儿 ffmpeg、无僵尸、两端都在真播 | `ps` + `pos` 每 30s 递增 |

判定「进度不快不慢」的硬指标：取 `[PlayerController][report] … pos=` 相邻两行，
`Δpos / Δ墙钟 ≈ 1.0`（允许 ±0.15）。

---

## 8. 发布计划

按既有纪律：**per-change commit + push + tag + Release，一律 GitHub CI 构建**（Android 端走 repo
Secrets keystore，禁止本地构建/推送）；三仓 lockstep bump。

1. 后端（230 `/workspace/MusicFlow`）：patch1~4 + patch7 一个 commit（sendspin seek 语义 + 泄漏 + pacing），
   patch8 一个 commit（DLNA 重投流）→ `v4.0.6`
2. 客户端（230 `/workspace/MusicFlow-client`）：patch5、patch6 各一个 commit → `v5.0.22`
3. tag 前先查 tag 可用性（历史上被 hijack 过）
4. CI 四道防线：HACS validation / build / 纯 ASCII + 英文 README / JSON 合法性
5. 发布总览列出各仓版本号与 CI 状态

---

## 9. 回滚方案

- 后端热替换是可逆的：每个 dist 文件替换前都 `docker cp` 出 `.bak` 到 `/root/`；
  回滚 = `docker cp /root/<f>.bak musicflow:/app/backend/dist/<rel>` + `docker restart`。
- 逻辑开关：`reseekByRecast` 只在 `unreliableSeek=true` 时生效 → 删除该设备的运行时标记即回到 SOAP 路径
  （重启容器亦可，因为该标记**未持久化**，见 6.2）。
- patch7 的预建/切换若出问题，症状是「跳转不生效但播放正常」（预建失败被 catch 且旧流继续播），
  不会导致断流 —— 失败模式是安全的。

---

## 10. 附录

### 10.1 文件索引

| 文件 | 职责 | 本次改动 |
|---|---|---|
| `backend/src/services/sendspin/streamEngine.ts` | 组推流引擎（PcmWindow / pacing / 时间线） | patch1,2,3,4,7 |
| `backend/src/services/dlna/control.ts` | DLNA 投屏 + SOAP seek + 位置基线 | patch8 |
| `backend/src/services/airplay/protocolPlayer.ts` | AirPlay 协议适配（**当前复用 DLNA token**） | 6.1 待改 |
| `backend/src/services/airplay/control.ts` | RAOP 会话 / `seekAirPlay`（原地 + 重投） | 未改 |
| `MusicFlow-client/lib/providers/player/player_seek.dart` | 客户端 seek 与兜底 | patch5 |
| `MusicFlow-client/lib/providers/player/player_provider.dart` | 服务端能力判定 | patch6 |
| `frontend/src/stores/player.ts` | 网页端位置 / 歌词游标 / `castSeek` | 未改（已核对同源） |

### 10.2 关键日志速查

```
[pump][seek] group=… want=… target=… running=…          seek 入口
[pump][seek] ⚠️pump 未运行 → 记起播位置 …                起播窗口内拖动
[pump][rebuild] 新流就绪 target=…ms                      预建完成，等待切换
[pump][rebuild] 作废过期重建 …(gen/epoch 已变),已释放      连续拖动只认最后一次
sendspin seek 切换完成: pos=…ms(旧流此刻释放,设备零空窗)   原子切换成功
[DLNA][seek-verify] … 连续 N 次不报位置 → 判定 SOAP Seek 无效
[DLNA][seek] … SOAP Seek 不可靠 → 重投流重建(timeOffset=N)
[DLNA][seek] … 重投流完成 timeOffset=N …ms
[PlayerController][report] …: PLAYING pos=… dur=…        位置 1:1 判据
```

### 10.3 环境事实（复用）

- 后端改动一律在 **230 `/workspace/MusicFlow`**（本机 `MusicFlow` 停在 v3.0.26 且无 origin，**不可用**）。
- 客户端改动一律在 **230 `/workspace/MusicFlow-client`**（本机停在 v5.0.15，落后 6 版）。
- 热部署：`npx tsc` → `rc.py get 230 <dist js>` → `rc.py put 240` → `docker cp` 进容器 → `docker restart`
  → `curl /rest/ping` 必须等到 200（实测 22s 时可能还是 000，**要循环到 40s**）。
- 240 监控 `/root/seek_live.sh`、抓包 `/root/http_sniff.sh` —— **容器重启后必须重新拉起**。
- ⚠️ 经 paramiko→bash→grep 的**中文正则不会匹配**：日志一律 `rc.py get` 拉回本地再用 Python 分析。

---

## 修订记录

### 修订 R2（2026-09-22，v4.0.7）：废弃「后台预建 + 帧边界原子切换」，回归 MA play_index 全流重建

v4.0.6 的 patch6（swap 机制）**在真机上被推翻**，本版按 MA 权威语义重写：

**真机失败证据（FP-TRACE 堆栈钉死）**
- pushLoop 用共享的 `group.positionMs` 反推取帧下标（`Math.floor(positionMs/FRAME_MS)`）；
- seek() 第①步「发布目标位置」写的正是这个共享字段 → 旧循环下一帧直接跳到目标处取帧
  → 旧滑窗给不出数据 → `seg.length===0` 误判 EOF → `contentEnded → finishPlayback`
  → 设备 IDLE、在飞预建被作废。这正是 MA 铁律②「位置绝不能被外部改写而不换流」的教科书式反例。

**v4.0.7 实现（与 MA `controller.seek`@862 逐条对齐）**
1. seek = ①发布位置对（`group.positionMs = targetMs`）+ ②整条流重建（MA
   `play_index(seek_position)` 等价）：`seekCore` 走与正常起播**完全相同**的
   `playCore/playGroupCore` 路径 —— 停旧流 → stream/end 成对 → 全新音源带 `-ss`
   起点起流 → 新时间线锚点（now + send_ahead，MA `_resolve_channel_play_start` auto 模式）。
2. pushLoop 取帧改用**自有游标** `playCursorMs`，共享位置只写不读（MA 推流引擎同样
   从不读 elapsed_time 取帧）。
3. 删除全部自创机制：`beginRebuild` / `applySwap` / `swap*` / `rebuildGen` / `rebuildInFlight`。
4. `playCore`/`playGroupCore` 新增 `seekPositionMs` 通道（armSeek 在 pump.stop() 之后装填）。

**MA 没有帧边界无缝换流**：设备缓冲自然耗尽后接新流，seek 空窗 ≈ 2-3s（resolve(缓存命中)
+ ffmpeg 预缓冲 2s），即 MA 真机行为，可接受。

**真机验证（v4.0.7，240 容器）**
- sendspin(esp32-player2)：seek 30s→31.2s 续播、seek 45s→47.0s 续播，真实节奏推进不断线；
  音量 30/45/80 即时回读一致。
- DLNA(主卧 HiVi H5MKII)：seek 40s→43.0s、seek 70s→73.0s 续播；设备恒报 RelTime=0 时
  自动降级「重投流重建」标记生效；音量 20→40→70 即时生效。

**排查附记（重要环境事实）**
- 测试曲「Ditch」实际音频仅 **30 秒**（476KB AAC 128kbps 试听片段），而库内元数据 131s；
  且插件源（go-music-dl:netease / 天翼云盘）**每次 resolve 可能返回不同版本文件**
  （同一首歌先后解析出 30s AAC 与 320kbps 两种）。seek 超出实际音频末尾 → EOF → 切歌
  的行为与 MA 一致，**不是缺陷**。真机测试前必须先用 ffprobe 确认实际时长。
- ffmpeg `-ss`（input 侧）按 mp3 头声称码率估算 seek 字节偏移，元数据失配的小文件
  会命中上游 416 Range Not Satisfiable → 空流 EOF。

### 修订 R3（2026-09-22，**未发版**）：新增 patch9 —— seek 后出声延迟（源行复用）

用户在 R2 之后报「很多歌曲跳转进度后要十几秒才出声」，本轮把两段独立开销中的 ① 落地：

- **patch9（见 §5）**：源行复用 —— 同曲 seek 重建跳过整段播放优选（1.85~2.53s/次），
  240 实测命中 `reuse-active` 耗时 1~2ms。**已热补丁部署 240 验证可用**。
- **SPEC 同步**：§1.7 `resolvePlayableRow(songId, opts?)` 补 `preferRowId` / `reuse-active`，
  写明「失效兜底归调用方、本函数不自行重试」。
- **E（输入粗定位 `-noaccurate_seek`）已撤出**：孤立 ffmpeg 上量到 -29%，但在真实 seek 重建路径
  无法确认收益，且同期 240 出现取流超时；取证表明故障另有根因（见 6.6），故不在本版引入。
- **落地范围**：`backend/src/services/source/resolveAudio.ts` + `backend/src/services/sendspin/streamEngine.ts`
  + 2 个测试文件。验证：全量回归 **179 文件 / 1510 用例** + `tsc --noEmit` + 8 个门禁脚本全绿。
- **未 tag**：按「每次发版只修一处」节奏，与下一版一起走。
### 修订 R4（2026-09-22，**未发版**）：patch10 —— 起播窗口内 seek 的世代竞态（§6.6）

用户报「切歌后拖进度条不正常」。定位到**存量缺陷**（v4.0.12 原生即有）：seek 落在起播窗口内时，
`seekCore` 与 in-flight `play()` **双路径重复起 play**，两个 play 互掐对方刚建好的窗口 → 存活的 pump
拿到 `eof=true / decoded == baseSample` 的零输出窗口 → `流式窗口提前 EOF` → IDLE → 15s `stalled`
→ 从 0 重投 → `frozen` → **放行切歌**。E（`-noaccurate_seek`）回滚后故障照旧复现，证明与之无关。

- **修复**：seekCore 起播中只记位置（单飞）；`play()` 带新起点自纠重来；钳制改由本轮**新歌时长**
  收口（不再沿用上一首时长裁短目标）；自纠复用**刚拿到的**源行（省 2s 优选）；`playRetry` 收敛保险。
- **落地范围**：`backend/src/services/sendspin/streamEngine.ts` + `playerCore.ts` +
  `streamPumpStartupSeek.test.ts`（7 例）。
- **验证**：负向矩阵 N1~N5 每个变体精确变红（含「过度」方向）；`tsc --noEmit` + 9 个门禁脚本全绿；
  **240 热补丁实测**：三轮「切歌 + 250ms 内拖动」位置落在目标值并 1:1 推进，异常计数 0，
  抓包 189 KiB/s（48kHz/16bit）+ 零字节 0.4%（非静音）。
- **未 tag**：与下一版一起走。
