# MusicFlow 播放链路 MA 化专项改造

> 专题：**进度条跳转 / 播放位置 / 播放通道 / 歌词进度** 四条链路按 Music Assistant（MA）语义重做
> 版本基线：后端 `v4.0.5-3-g6789e54`（230 `/workspace/MusicFlow`）· 客户端 `v5.0.21`（230 `/workspace/MusicFlow-client`）
> 编写日期：2026-09-22　状态：**patch 1~7 已落地并热部署到 240；剩余项见第 6 节**

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

---

## 6. 剩余改造（设计 + 落地步骤）

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
