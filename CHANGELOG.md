# 更新日志 (Changelog)

本文件记录各版本的主要变更。版本号遵循语义化版本，仅在打 `vX.Y.Z` tag 时由 CI 构建并发布（产物：Docker 镜像）。

## [4.10.6] - 2026-10-31

### Fix / 曲中(同一首歌内)偶发失声约 2 秒后自愈 —— 重传缓冲覆盖不足

- **根因(真机确证)**：设备侧 WiFi 空口一次丢掉约 240 个连续 RTP 包(≈1.92s 音频)，
  而服务端重传缓冲只保留最近 128 包(≈1.02s)，更早的包补不到时被 `onLoss` 的
  `if (!pkt) continue;` **静默丢弃**(不计数、不告警)；设备播放缓冲仅约 1.0s，
  被抽干 ⇒ 哑音数秒 ⇒ 设备重新同步后自愈。
- **证据**：240 真机 23:29 / 23:36×2 / 00:41 / 00:51 / 01:00 / 01:45 / 01:49×2 / 01:54 / 01:56
  共 10 次爆发，签名高度一致(657 条重传请求 / 240 个连续 seq / ≈1.92s)，全部落在曲中；
  服务端同时刻出口稳定 125 包/秒无塌陷。三条独立链路对账一致。
- **修复**：`raop.ts` 新增 `AUDIO_BACKLOG_MAX_PACKETS = 2048`(≈16.4s)替换硬编码 128；
  并给「补不到」补上计数与窗口聚合日志(`[raop-loss] ... miss=N`)。

### Feature / 重传缓冲档位可配置

- 新增环境变量 **`MF_BRIDGE_RAOP_BACKLOG_PACKETS`**，档位 **512 / 1024 / 2048 / 4096 / 8192**，
  **默认 2048**。不在档位内取「不小于它」的最小档(1000 → 1024)，超过最大档钳到 8192，
  非法值回落默认档。沿用 AirPlay 既有 `MF_BRIDGE_RAOP_*` 开关模式，不引入新配置面。
- 新增只读 getter(不改 `realtimeStats` 对象，避免破坏既有用例)：
  `lossRequestedCount` / `lossResentCount` / `lossMissCount` / `backlogPackets`。

### 观测 / 三个「伪证」陷阱(已写入权威文档)

- ICMP ping 报 0% 丢包、pcap 速率正常 seqHole=0、「我窗口内没看到」——三者**都不能**用来
  否定设备侧丢包。唯一能直接证明设备侧丢包的证据是**设备主动发回的重传请求**。

### Fix / 桥接开局投递量不足 —— 换代后一次性灌满 6s(bulk backfill)

- **问题**：桥接会话建立后只有 250ms 一次的 tick、单 tick 窗口宽仅 1s，接收端
  `inQueue` 水位只能缓慢爬升到 ~1s；而 AirPlay 设备在切歌/重连后有 2~3s 的就绪
  窗口，水位不足时新歌开头会被判为「无数据」而静默跳过。
- **修复**：新增「开局 bulk 投递」。换代后由 `bridgePushTick` 发现本代新料
  ≥ `BRIDGE_BACKFILL_MAX_US`(6s) 时，按 `BRIDGE_PUSH_TICK_MS` 分片一次性灌入，
  片间 `await setImmediate` 让出事件循环，保证发送侧队列始终远低于
  `BRIDGE_QUEUE_HARD_CAP_MS`(8s)；实际投递量由 `bulkBackfillCapUs` 钳到
  `min(6s, 硬上限 − 当前排队 − 余量)`。
- **时序契约**：换代瞬间 ring 必空(新代首帧未产出)，**不能**在
  `notifyBridgeGeneration` 就地投，必须等 tick 观测到新料。
- **配套遥测**：`inQueueMs` / `maxQueueMs` / `queuePeakMs` 进 tick 与 bridge-window
  日志；首填等待加 `hasInFlight` 门控，避免「有数据正在飞但队列已空」被误判为空。

### Fix / 桥接投递窗口上界不跟随水位，与 bulk 形成永久死锁(秒级循环卡顿)

- **现象**：bulk 上线后真机出现**每秒一次**的循环卡顿，比原问题更严重。
- **根因**：`deliverBridgeWindow` 的稳态窗口是 `(watermark, hi]`，其中
  `hi = now + BRIDGE_PUSH_HORIZON_US + ahead − shift` **不随已投递水位移动**。
  bulk 一次性把水位推到 `lo + 6s`(远高于 `hi`)，此后两者都按 1x 前进 ⇒
  差距永久冻结 ⇒ **窗口恒为空** ⇒ bulk 那 6s 吃完即断粮 ⇒ 滞后越过
  `BRIDGE_RESUME_REBASE_US`(2s) 触发 `pacing rebase`(RTP 映射不动) ⇒
  永久落后 2.6s ⇒ 每包都迟 + 设备持续干涸。
- **铁证**：真机 `bridge-bulk durUs=4625000`(04:44:46 UTC) → 4.6s 后
  `pacing rebase +2768574µs idx=580`(04:44:54)，而 `580 × 352 / 44100 = 4.629s`
  恰好吃完 bulk 的量；随后 `inQueueMs` 恒 0、`deltaUs` 恒 −2.59s、
  `late` 以 125/秒 累积、`droppedFrames` 持续增长。
- **修复**：窗口上界改为**跟随水位**并设领先硬上限
  `hiEff = min(max(hi, watermark + BRIDGE_PUSH_TICK_MS), lo + BRIDGE_BACKFILL_MAX_US)`。
  每 tick 恰好补一个 tick 的量，bulk 建立的领先量由稳态 1x 维持(既不重投也不塌陷)；
  `lo + 6s` 是**领先量硬上限**，防止一路追到泵预填充前沿(实测 10.6s)顶穿接收端
  8s 溢出红线。`watermark = 0` 时退化为原窗口，行为不变。
- **验收(240 真机)**：`pacing rebase` 0 次；`queueMs ≈ 200`、`inQueueMs ≈ 1250`、
  `deltaUs` 稳定 +1.06s(抖动 <3ms)、`droppedFrames` 0、`silenceChunks` 0。

### Fix / 成员延迟 PUT 后,投递窗口不得跨锚点基准外扩

- **问题**：成员延迟(按成员存)被 PUT 后 `shift` 变化会平移整个投递窗口，而 Fix D 的
  「跟随水位」用的是**旧基准**下的水位 ⇒ 会把新窗口之外的帧塞进新时间线。
  全量测试实证：`tests/sendspin/bridgePushFrame.test.ts`「每桥读各自成员格」pushed 1→2。
- **修复**：新增 `bridgeShiftAtDelivery`，`shift` 变更的那一拍退回严格窗口，
  下一拍基准一致后 follow 自然恢复 —— 稳态 `shift` 恒定，死锁修复不受影响。

### Feature / 设备保持深度可配置(`MF_BRIDGE_RAOP_HOLD_MS`)

- **背景(本日定论)**：设备侧 hold depth 由 SYNC 包广播的 `rtp_timestamp_latency`
  (= 锚点公式的 `L`)决定。缺省只有 **1.0s**,而空口一次连续丢包实测 **≈240 包 ≈1.92s**
  ⇒ 设备必被抽干 ⇒ 曲中失声约 2s 后自愈。重传缓冲(2048 包≈16.4s)只保证「补得到」,
  不保证「补得及」。
- **新增**：`MF_BRIDGE_RAOP_HOLD_MS`,**缺省 1000 = 历史行为零变化**,可抬高到
  2500~3000 覆盖最坏空口空洞;下限 1000 不可再降(会周期性跑空),上限 8000 纯防御。
  代价:端到端延迟随该值线性增加,组内一致故不破坏同步。
- **真机验收(240)**：`MF_BRIDGE_RAOP_HOLD_MS=2500` ⇒ `leadUs` 1050000 → **2550000**,
  `droppedFrames / silenceChunks / realigned` 恒 0;同形态 `raop-loss` 爆发仍在但**不再失声**。

### 文档 / 抓包取证方法论补「必抓设备请求方向」

- `docs/曲中失声-抓包取证方法论与复盘-2026-10-31.md` 新增 §2.2.1:BPF 精确式
  `udp and src host <设备IP> and udp[1] = 0xd5`、端口兜底式,以及三列判读表
  (`miss=0` / `future < miss` / `miss == future` 各指什么);并记录 `seq0` 是上一个聚合
  窗口的陈旧字段、只能用 `seq1` 与 `cur` 判范围。
- 新增 `docs/今日待办-曲中失声与桥投递-2026-10-31.md`:当天唯一进度看板(根因三次演进、
  改动清单、真机验收、未闭环 P0–P4、验收判据、回退路径)。

## [4.10.5] - 2026-10-30

### Fix / 取证日志不得破坏静态守卫钉死的单行拦截

- v4.10.4 给 `streamFallback.addPlayable` 补取证日志时，把
  `if (isNegativeFresh(songId)) return;` 改写成了花括号块，导致
  `scripts/check-group-invariants.mjs` 的 G16 断言（按字面量钉死该行）失配，
  main 分支 `ci / 群组不变量守卫` 转红（89/90，唯一失败项即此条）。
- 恢复被钉住的单行拦截原文，取证日志前置为独立的 `if` 打日志语句：
  判定条件、返回路径、正/负缓存语义**零变化**，`isNegativeFresh` 为纯读判定，
  重复调用无副作用。
- 线上影响范围：仅 main 分支 CI 红灯，**未触发回滚**（tag `v4.10.4` 的
  `build-and-push` 及四条门禁全 success，镜像 digest 未被回退）。

## [4.10.4] - 2026-10-30

### Chore / streamFallback 补负缓存取证日志(纯增量,零逻辑改动)

- **问题**:`streamFallback.ts` 此前**一条日志都没有**。负缓存(2h 判死 / 45s 网络退避两档)
  由谁写、何时写、是否挡住了正缓存复活,在日志里完全不可查 —— 排查 2026-10-30
  「预热说能播、起播判死跳过」时因此在关键一环失明。
- **改动**:三处 `log.info`,均为低频事件,不改任何判定:
  - `setFallback` 收到 `url=null` 时记一条:曲目、档位(`transient`/`definitive`)、
    实际 `ttlMs`(从缓存读回,不重算表达式)、进程标识;
  - `markUnplayable`(内容判官判死)单独记一条,与"换源穷尽"区分来源;
  - `addPlayable` 因负缓存新鲜而**拒绝写正缓存**时记一条 —— 「复活被挡」的唯一痕迹。
- `who()` 标识写入进程(`main` / `sendspin-child`):同一份代码两边各跑一份、各有各的
  负缓存,不区分就会把跨进程问题误读成「随机」。
- 唯一被"删除"的一行是 `if (isNegativeFresh(songId)) return;` 改写为
  `if (…) { log; return; }`,判定与返回完全一致。净改动 +31/−1。
- 只加日志,不动负缓存机制、不动 10-27 的试听片段护栏、不动判跳逻辑。

## [4.10.3] - 2026-10-30

### Fix / 预览下一首与起播判据对齐——避免预热一首「马上会被跳过」的歌

- **纠正前一条的错误结论**:v4.10.2 曾把「预热打偏」归因为 `playMode=shuffle` 的预览偏差。
  真机日志否掉了这个判断 —— `playCurrent source=auto-advance idx=0 song=0ea5a2da` 说明
  自动切歌选的**正是**预测那首;它被换掉是因为 4 毫秒后被 `judgePlayable` 判死跳过。
- **根因**:`judgePlayable` 第一道闸 `getCachedPlayability(songId)==="unplayable"` 直接返回
  `skip` 且**不打日志**。这条负缓存来自同一首歌更早一次 `ensurePlayableStream` 的换源穷尽
  (TTL 2h);而 `resolvePlayableRow` 的 `reverify-ok` 分支(本行复核通过)**不写正缓存**,
  即便写也会被「负缓存未过期期间拒绝写正缓存」挡掉。同一首歌在两个判据下结论相反 ——
  解析说能播、起播说判死,负缓存赢在起播侧,于是一次预热(4.8s)完全白做,而真正要播的
  那首没预热(`gap-fill` 从 103ms 回落到 3000ms)。
- **修法**:`peekNextSongId` 增加 `skipDead` 选项 —— 取 `peekUpcomingPositions(peek, 4)`,
  跳过 `unplayable` 的曲,返回第一个还活着的。与 `judgePlayable` 第一道闸同一判据。
  默认不传 `skipDead` 时行为逐字节不变;只认 `unplayable`,`unknown`/`transient`/`playable`
  一律照常预热(「不把不知道当成死的」边界不越);判据抛错或全被判死 ⇒ 不预热,绝不抛。
- 新增 7 例定向测试(`tests/player/peekNextSongIdDeadSkip.test.ts`)。
- 未一并修(单列):`reverify-ok` 不写正缓存导致该曲 2 小时内反复被判死;治本需给负缓存
  区分来源,涉及「试听片段」护栏,单独评估。

## [4.10.2] - 2026-10-30

### Fix / resume 补建桥路由(R1) + 曲末预热下推到 sendspin 子进程(换歌取源 3.2s → ~1ms)

- **R1 重启后不起播/不出声**:`activeBridgeRoutes` 是进程内模块级 Map,容器重建后为空,而 `resume()` 只 fanOut DLNA + spinOp 组泵、**假设桥路由还活着** ⇒ 无桥会话 ⇒ 泵只推 WS 客户端 ⇒ AirPlay 成员全程静默,必须切歌才出声。现在 `resume()` 先 `ensureBridgeRouteOnResume()`:桥开关开 + 该组无路由 + 有在线 AirPlay 成员时补建会话并 `sendspinGroupBridgeSync`;补建失败只告警,不阻塞 resume。
- **曲末预热下推到子进程**:主进程 `drainPreheat` 在曲末前 9s 算出的「可播结论」写进主进程 module-local 缓存,而泵跑在 supervisor fork 的 sendspin 子进程里读不到 ⇒ 每首起播都要在子进程内重探一次(实测 `ensure-ok` 2.9~3.9s)。这段时间全靠曲末排空窗口(实测 9760~9786ms)顶着,超窗即可闻静音。现在预热成功后经 IPC `preheat` 下发,子进程在本进程内重算并把结论写进自己的缓存,泵起播命中 `fresh-cache`(真机 3.17s → 1ms,`gap-fill` 2250ms → 103ms)。
- 门控与红线:仅 fork 模式 + supervisor 在跑时下发;子进程按「泵存活计数」判断本进程有没有在用 sendspin 的组(纯 DLNA 播放不白探源);同曲幂等(上限 512 条);下发/预热任一失败自动退回原行为,绝不冒到 tracker。
- 与既有 `songUnplayable`(子→主负缓存回传)构成跨进程缓存的**双向**打通 —— 负结论此前已打通,正结论一直是缺口。
- 新模块 `backend/src/services/sendspin/preheatChild.ts`;`ipcProtocol` 增 `preheat` 消息;`drainPreheat` 增 `setDrainPreheatWarmHook`。新增 11 例定向测试。
- 方案与真机取证见 `docs/换歌取源跨进程预热-方案与取证.md`。

## [4.10.1] - 2026-10-30

### Fix / 容器重建后设备僵死会话自愈:握手失败 TEARDOWN 探测重试(S1)+ boot clear-probe(S3)+ 优雅退出窗口 30s(S2)

- **S1 握手失败自动救回**:容器重建后 MUZO 固件保留对旧容器的半开 RTSP 会话,新握手 ANNOUNCE/SETUP 即 `read ECONNRESET`,旧行为直接回落 solo cast(同一条握手必挂)= 设备静默,唯一救法曾是人工 stop→等 10s→play。现在 prepareBridgeRoute 失败时自动:TEARDOWN 探测(新 RTSP 连接,无 session 也发,设备回 454 无害)→ 退避 5s/15s 两档重试完整握手;probe 不可达立即放弃;救不回才按 MAJ-07 回落 solo cast。仅设备类连接失败(ECONNRESET/ECONNREFUSED/超时)触发;AP2 凭据缺失等语义错误不重试。
- **S3 boot clear-probe**:容器启动 12s(持久化设备清单启动即恢复,不等 mDNS)对每台已知 AirPlay 设备发一次 blind TEARDOWN 探测,把僵死态清在用户起播前;45s 兜底轮只补 mDNS 迟到设备。防误杀:首轮已确认的设备兜底轮不碰;正被桥会话占用(用户已起播)的设备两轮都跳过 —— blind TEARDOWN 无 session 也真杀会话(HiVi 实测回 200)。
- **S2 优雅退出窗口**:compose 显式 `stop_grace_period: 30s`(默认 10s 可能掐断逐会话 TEARDOWN)。gracefulShutdown 的 TEARDOWN 链路已实抓验证(带 session id)。
- 新模块 `airplay/raopProbe.ts` + `raop.ts raopTeardownProbe` + 子进程 `raopProbe` RPC;新增 19+4 例定向测试(tests/airplay/raopProbe.test.ts + GroupProtocolPlayerRoutes S1 集成)。

## [4.10.0] - 2026-10-30

### Fix / 桥会话活性看门狗判据第三次换源(timing 心跳) + 优雅退出补 TEARDOWN + 换歌链路 F1/F2/F3 与排空钳制

- **看门狗判据换 timing 心跳**:v4.9.8 的 ctrl 重传判据被 2026-10-29 10:03–10:48 十连炸证伪(间隔精确 300s 共 10 次,同期 timing 心跳每分钟稳定 17~21 条)——重传请求是丢包驱动信号,流越干净越不发,静默 ≠ 死亡。新判据 = timing(NTP) 心跳停摆 ≥45s(`MF_BRIDGE_RAOP_LIVENESS_MS` 缺省 45000,下限 30000;健康期 20 次/分钟、会话内最大间隔仅 6.0s 的 pcap 实测为据),开关与熔断保留(`MF_BRIDGE_RAOP_LIVENESS_WATCHDOG` 缺省 ON)。
- **优雅退出补 TEARDOWN**:容器重启时子进程 dispatch 无 "stop" 分支 ⇒ 真正停桥会话的 onStop() 从未被调用 ⇒ 设备(MUZO)挂在死会话上,重启后不出声不发 timing(2026-10-29 实证静音 10 分钟、服务端照推 3 条流)。改为退出前走组/端级 transport stop 再退进程。
- **F1 复播注入**:复播后立刻回填当前条目期望时长(`primeExpectedDuration`),消掉复播后 0 时长误判。
- **F2 自适应轮询**:队列轮询改自重排 setTimeout,近曲末 20s 内自动降到 1s(曲末决策延迟最高 5s→1s)。
- **F3 evaluate 快路径**:advance/track_changed/ended 三个决策跳过 250ms+500ms 两层去抖立即派发;idle_early 仍走去抖(测试钉住两侧行为)。
- **streamEngine 排空**:步长钳制 `min(drainStepMs, ceil(left))` 免砍歌尾、有桥成员曲末排空量按桥队列上限钳制(修换歌时 AirPlay 断流 3~7 秒)、排空期给桥续静音保 RTP 节拍(`MF_BRIDGE_DRAIN_SILENCE`)、`ev=bridge-drain-fill` 每首一行可观测日志。
- **文档**:airplay/group 权威文档 v4.10.0 增补(失声根因取证 + B/C/D 方案入档);新增 `docs/AirPlay播放中断-根因排查与已排除方向.md`、`docs/播放监控-多维度监控台使用手册.md`。
- **验证**:定向 5 测试文件 59 例全绿(含新增 `bridgeLivenessBreaker.test.ts` 15 例);`tsc` 0 错;240 热补丁(v499)真机确认换歌不卡、监控台判定 HEALTHY。

## [4.9.8] - 2026-10-29

### Fix / HiVi 长会话播放数小时后整段无声（audio RTP 通道死亡，看门狗换判据自动救活）

- **现象**：v4.9.7 修复后播放正常数小时，15:43 一次换歌后整段无声。服务端数据面全程健康（`deltaUs≈1060ms`、`driftUs=0`、gap-fill 正常、无 reconnect 无掐流），设备 timing 请求每 3s 照答、音量确认已下发、清 DLNA 假会话无效——排查排除 v4.9.6/v4.9.7 全部已知机制。
- **根因（分水岭证据）**：失聪前那首（134s）设备重传请求增量 3315；失聪后那首（292s）**零请求**（正常 ~10/s）。= warm-reuse 长会话（4h+15 次换歌）的 **audio RTP 通道死亡**：control/timing UDP 仍活，音频流进不了设备，固件连重传都停发。整组 stop→play（完整重握手）立即救活——真·假死的活性信号是 **ctrl 重传请求**，不是 timing。
- **修复（看门狗判据换源，v4.9.6 B 的正确姿势）**：新增 `lastCtrlSignalAt`（只在 ctrl 通道重传请求分支刷新），看门狗判据从「设备主动信号停摆」（合流 timing+ctrl，对 MUZO 结构性误报——正常播放就停发 timing，v4.9.7 教训）换成 **ctrl 重传请求停摆**：正常收包 ~10/s 持续活跃不误报；通道死亡归零，5 分钟静默（缺省 `MF_BRIDGE_RAOP_LIVENESS_MS=300000`）自动 `reconnectRaop()` 完整重握手。缺省恢复**开启**（`MF_BRIDGE_RAOP_LIVENESS_WATCHDOG` 缺省 ON）。
- **保留**：v4.9.6 A（gap-fill）、v4.9.7 三修复（重连互斥门/结束原因上报/forceClose 守卫）全部在位；v4.9.8 不是回退——v4.9.7 关看门狗是旧判据误报，v4.9.8 换判据后恢复开启。
- **验证**：tests/airplay 55 文件 / 757 用例全绿（`raopGapFill.test.ts` 断言同步：缺省 ON、阈值 300000）；29 把守卫全绿；240 热补丁实测 dist `return !(v === "0" || v === "false")`。
- **文档**：airplay 权威文档 v4.9.8 增补、KNOWN_ISSUES 新增 MF-007、STALL_MONITORING 判据修正。

## [4.9.7] - 2026-10-29

### Fix / 全屋组 HiVi 播放约 2 分钟后无声、每次换歌后约 36 秒无声（v4.9.6 看门狗误判链）

- **现象**：跟 v4.9.5/v4.9.6 又不同——服务端数据面完全健康（`deltaUs≈1060ms`、`driftUs=0`、包流不断、`silenceChunks` 不涨），但设备**每首歌播到约 120 秒**就没声；换歌后能自己恢复，恢复前有约 36 秒的空白。组内 sendspin 成员（esp32）始终正常。
- **根因（三条缺陷叠加，前一条 v4.9.6 新引入）**：
  1. **B 的判据对主力设备结构性失效**：`lastDeviceSignalAt` 只认设备**主动**发起的包（ctrl 重传请求、NTP timing 请求）。HiVi/MUZO（2017 固件）在**曲目后半段正常播放时就会停发 timing 请求**——240 实证 3s 一次的心跳（20 次/分钟）在 05:31、05:32 两个整分钟完全消失，而同一段该曲 `45739 chunks / 365.1s` 全程健康播完。于是**每首歌播到 120s 必被误判假死一次**。
  2. **`reconnectRaop()` 掐死刚起的新流**：它的 `await player.connect()` 是真实时间窗口（实测 ~320ms），窗口内 `maybeBeginStream` 因 `streamAborted` 被复位而在 **oldPlayer** 上起了新流；connect 返回后无条件 `oldPlayer.forceClose()`，把刚跑 0.3~0.6s 的新流连根掐断。
  3. **`streamBridge().then()` 不区分结束原因**：一律 `scheduleRaopReconnect("stream ended")`，而 `pullChunk()` 返回 null 的条件是 `closed || streamAborted` ⇒ **曲目播完必然等于「断流」**。三者组成闭环：`liveness 触发 → 重连 → 掐死新流 → 再判断流 → 再重连`，实测 6 轮 / 36 秒。
- **修复 A（看门狗缺省关闭）**：`raopBridgeLivenessWatchdogEnabled()` 改为只有 `MF_BRIDGE_RAOP_LIVENESS_WATCHDOG=1|true` 才开。判据在这台设备上误报率 100%，而它想捕获的真·假死可由用户切歌 / 整组 play 恢复（已实证）。代码与纯判据 `livenessWatchdogShouldFire` 全部保留。
- **修复 B（重连互斥门）**：新增 `raopReconnectInFlight`，`reconnectRaop()` 全程置位（含 `await connect()` 窗口），`maybeBeginStream()` 门内直接 return，把起流推迟到下一帧 AUDIO 自然触发；重连重入由同一道门挡掉（内层早退不得复位外层门）；`oldPlayer.forceClose()` 另加 `if (this.player === player)` 守卫。
- **修复 C（结束原因上报）**：`streamBridge()` 返回 `BridgeStreamEndReason`（`producer` / `send` / `destroy` / `stopped`），`.then()` **只在 `send` 时重连**——仅 `sendChunk` 返 false（设备侧真断开）才算断流；`producer`（曲目播完/上层停流）、`destroy`、`stopped` 一律交 onBoundary 换代处置。
- **验证**：新增 `tests/airplay/bridgeReconnectGate.test.ts`（3 条：门内不起流 / 门内重入不新建 player 且不复位外层门 / 门关闭后恢复可起流）；`raopGapFill.test.ts` 同步改为断言看门狗缺省 OFF；tests/airplay 55 文件 / 757 用例全绿；29 把守卫全绿。240 热补丁实测 `WATCHDOG=[]`、liveness 日志 0 条、`deltaUs≈1060ms`、`driftUs=0`、`silenceChunks=0`。
- **保留**：v4.9.6 的 A（垫片窗静音续流）已实证有效（换歌窗 `gap-fill: 282 chunks / 2251ms` 盖满 2.5s），缺省仍 ON，本次不动。
- **文档**：airplay 权威文档 v4.9.7 增补、KNOWN_ISSUES 新增 MF-006、STALL_MONITORING 盲区补充。

## [4.9.6] - 2026-10-29

### Fix / HiVi（MUZO 类固件）播放约 1 小时后接收端假死、永久无声（换歌垫片窗 RTP 断流）

- **现象**：与 v4.9.5 修复的「歌中饿死」不同——服务端数据面全程健康（缓冲 1.05s、首包偏差 5-10ms、每歌 maxGap≈1s 全被覆盖），但设备侧零 timing 回复、零重传请求，`getPlayerStatus` 假播放（`uri=""`、curpos 空走）；组内 sendspin 成员（esp32）始终正常。只有完整重握手（TEARDOWN→ANNOUNCE/SETUP/RECORD）能唤醒，服务端内部换泵无效。
- **根因**：换歌时 `onBoundary(track)` 停旧 stream 后，~2.5-3s 垫片窗（冷垫片 2500ms + TTFB）内 **RTP 完全断流**（静音也不发，实证：若发静音每 gen silenceChunks 应 +375 块，实际只 +4~6）。设备 1.05s 缓冲放完后真饿 ~2s，MUZO 固件「欠载即假死、不自动重缓冲」；每 3-4 分钟一次换歌反复戳，17 首（约 1 小时）后接收端彻底放弃。
- **修复 A（垫片窗静音续流，根治）**：`onBoundary(track/seek/rehost)` 后由会话层按 8ms 节拍续发静音块（seq 连续、时间戳续走旧时间线、无 SYNC），新流 0xE0 重锚语义不变；`maybeBeginStream` 起新流前收尾防交错；8s 封顶。开关 `MF_BRIDGE_RAOP_GAP_FILL`（缺省开）。240 实测换歌窗 `gap-fill: 282 chunks / 2251ms` 恰好盖满，设备 timing 回复全程不断。
- **修复 B（消费停滞看门狗，兜底）**：推流中设备主动信号（NTP timing 请求/重传请求）停摆超阈值 ⇒ 自动完整重握手（新 RECORD）。开关 `MF_BRIDGE_RAOP_LIVENESS_WATCHDOG`（缺省开），阈值 `MF_BRIDGE_RAOP_LIVENESS_MS`（缺省 120s，下限 30s）。
- **验证**：新增 `tests/airplay/raopGapFill.test.ts`（12 条）；tests/airplay 54 文件全绿；本地全量 605 文件 / 8246 用例全绿；29 把守卫全绿。文档同步：airplay/group/sendspin 权威文档 v4.9.6 增补、KNOWN_ISSUES MF-005、STALL_MONITORING 盲区表。

## [4.9.5] - 2026-10-29

### Fix / 群组播放一段时间后 HiVi（MUZO 类固件）永久无声

- **现象**：群组「全屋」里 HiVi（AirPlay 身份）播着播着就没声了，之后**再也不恢复**；切到下一首也只是短暂有声。同组的 sendspin 成员（esp32）一直正常。
- **根因**：桥推流节拍 `sendAt = A′ − L − SAFETY`（`L`=设备接收缓冲，`SAFETY`=50ms，44100 下合计 **1050ms**），而 v4.9.4 的 forceNow（now 锚，为修 MUZO「按秒卡顿」引入）把 `A′ = now + 400ms` —— 该偏移未与 `L+SAFETY` 对齐，于是：
  1. `sendAt(0) = now − 650ms`，**首包的应发时刻落在过去**。实测 `bridge first packet: deviationUs=655862`，吻合。
  2. 这 650ms 是**常量欠账**（后续每包同额落后），且够不着 `BRIDGE_RESUME_REBASE_US`(2s) ⇒ pacing 重锚**永不触发**，整首歌每包都「迟到追发」——实测 `latePackets=34857/34859`（≈100%）、`late` 计数 125/s。
  3. 设备端**有效缓冲被砍到只剩 offset=400ms**（`1050−650`）。实测 `maxGap=1005ms`、切歌饥饿 rebase 2.6~3.0s，一旦空档 >400ms 缓冲见底 ⇒ 固件欠载播静音，且**不自动重缓冲**（RTP 时间线不重锚，设备侧仍自报 `status:play`、`curpos` 正常推进、`mute:0`，就是没声音，并发出 659 次重传请求）。
- **修法**：`planBridgeAnchor` 的 forceNow 分支用上已算好的 `lUs + safetyUs` 做**下限钳制**（`offset = max(配置值, L+SAFETY)`）。`MF_BRIDGE_RAOP_NOW_ANCHOR_OFFSET_MS` 仍可**上调**（想要更深缓冲），**下调被拒**；逃生门是关掉 forceNow 本身（`MF_BRIDGE_RAOP_NOW_ANCHOR=0`）。
- **权衡**：起播首包的可听时刻由 `now+400ms` 后移到 `now+1050ms`（**+650ms**），换取抗抖动缓冲由 400ms 提到 1050ms。
- **240 实测（修复后同一台 HiVi）**：`leadUs` 400000→**1050000**；首包 `deviationUs` 655ms→**41ms**；`late` 增长率 125/s→**6/s**（−95%）；`deltaUs`（内容前沿超前量）330ms→**~1050ms**；`silenceChunks` 归 0。
- 守卫：新增「forceNow 的 `sendAt(0)` 绝不能落到过去」5 例（钉 `commandedLeadUs ≥ L+SAFETY`，覆盖 L=1s/2s、44.1k/48k、env 显式 0/200）；同步 `bridgeSessionForceNow.test.ts` 原有 4 例——此前它们把「`offset<L+SAFETY ⇒ sendAt(0)` 在过去」当**正确行为**钉住了，是本次缺陷长期未暴露的原因。源码注释中「offset 应 `<` L+SAFETY」的方向警告一并改正（落到未来只推迟首包且缓冲满额，落到过去才致命）。

## [4.9.4] - 2026-10-28

### Fix / 主卧 DLNA 流转到全屋后 HiVi 无声（桥占用期抑制 DLNA 源端 reset）

- **根因（240 真机时序实证）**：卡片流转链是 `transferFrom(to, from)` + 成功后 `resetPeer(from)`。`resetPeer(主卧 DLNA)` 会向**同一台物理设备**（HiVi H5MKII 的 DLNA 身份与 AirPlay 身份）下发 SOAP `Stop`，且落在桥会话 `RECORD` 之后 0.1~0.2 秒（`reset` 路由的 `stopDevice` 一次、`queue.clear()` 内 `player.stop()` 又一次）。固件输入仲裁被顶回 DLNA：RTSP/TCP 仍活着、timing reply 照答、RTP 全收 `loss=0`、泵 125 包/秒，但音频不渲染。所有出声实例（群组直接播放、源端是 AirPlay 的流转）在 `RECORD` 之后都没有任何 DLNA 命令。
- **修法**：桥 cold-settle 成功后写「该 DLNA peer 刚被桥接管」标记（TTL 20s / 容量 64 LRU）；`/stop` 与 `/reset` 命中标记时**只做服务端复位**——`stopDevice` 跳过、`queue.clear(peerId, { skipDeviceStop: true })` 跳过 `player.stop()`，不再向设备下发任何 DLNA 命令。应急回滚：`MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE=0`（缺省开启）。
- 守卫：`check-airplay-playback-chain.mjs` 的 reset-clear 断言允许带 `{ skipDeviceStop }` 这一种带参形态；`bridgeSettleMarks` 单测新增 TTL/容量/kill-switch 四例。

### Fix / 群组状态偶发缺歌名与封面（流转后首曲最常见）

- **根因**：泵起播（`streamEngine.play`）把**上一首**的 title/artist/album/coverArt 继承给新 current；上一首为空或恰好换曲时，新 current 只剩 `songId + durationMs`，HA 卡片即显示「未知」且无封面。子进程（泵）拿不到队列，无从补。
- **修法**：主进程 `getGroupStatus` 出口按 songId 从组队列回填缺字段（`enrichGroupCurrentMedia`），命中即补、找不到原样返回。

### Fix / 流转进度丢失与成员被静默摘除

- **进度**：`transfer-from` 的源端进度改为**无条件早读**（在任何 playFrom / detach / 借流之前定格）。此前只有「目标本身是同 host 双身份设备」才早读，目标是群组且源与群内成员同 host 时会被互斥先停掉源、晚读恒 0 → 群组从 0 秒开播。跨设备 DLNA 目标仍保持「先起播再 seek」例外。
- **成员回流**：`detachFromActiveGroups` 的自动摘组会记账（容量 128 LRU）；「设备 → 群组」流转时若目标组正是摘除来源组，自动把成员加回成员表，起播路由随即把它编进桥。手动在群编辑里删的成员没有记录，不会被回流。

### Feature / MUZO/Linkplay 类固件的桥出声与流畅度

- **now 锚 + 400ms 前向偏移**（`MF_BRIDGE_RAOP_NOW_ANCHOR_OFFSET_MS`，缺省 400）：该类固件只认「到包即播」，未来锚永不渲染（无声）；纯 now 锚又因设备抖动缓冲≈0 而每秒饿流。偏移让首包仍立即发、设备手里握 400ms 余量。
- **同 host DLNA settle 三步**：冻结 DLNA 队列 → Stop → 轮询至 STOPPED + 300ms 宽限，冷建桥会话前让音频输入让位（warm-reuse 不等）。
- **起播在线判定容忍 mDNS staleness**：90s 内静默的 AirPlay 设备仍进桥（stale < 10min 容错，≥10min 真离线剔除，全 stale 先 300ms 快刷发现），路由决策单行日志转正。
- 实验余量（缺省全关，A/B 用）：`MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME`、`MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER`、`MF_BRIDGE_RAOP_FIRST_SYNC_NOW`、`MF_BRIDGE_RAOP_CONNECT_PRIME`。

## [4.9.3] - 2026-10-28

### Fix / 流转后群组音量被旧端污染;桥会话初始音量改用群组落库值

- **流转/切端音量污染(前端)**:DLNA 流转到群组后音量变 ~98 的根因——音量单例跨播放端共享,DLNA 设备轮询把设备 0-100 标度音量写进单例,切到群组后该值不被重置,用户一碰滑条就 POST 旧值落库 `player_groups` 并全员扇出。修复:流转/切换播放端后从新目标端**重新拉取真实音量**回填单例,流转动作本身绝不 POST 音量。
- **桥会话初始音量(后端)**:`bridgePrepare` 新增 `initialVolume`(0-100),主进程从 `player_groups` 落库值取好随桥准备下发;`pushInitialVolume` 组上下文优先用之,无组上下文才回落设备落库值(旧行为)——流转/起播绝不把成员设备旧音量带给接收端。

### Feature / 纯 AirPlay 群组强制走 Sendspin 桥 + 同 host 互斥豁免活跃群组桥会话

- **纯 AP 组走桥**:组内无 Sendspin 成员时过去回落直连 solo cast(无组内时间线对齐);现在只要有在线 AirPlay 成员即 `prepareBridgeRoute` 走桥——组泵空成员合法化(带桥规格放行、有桥组不空闲回收),传输/音量 op 与状态派生同步落到组泵,prepare 失败仍按 MAJ-07 逐设备回落 solo cast。
- **互斥豁免(接管语义)**:`bridgeOwners` 升级携带组归属;同 host DLNA cast 的 `stopAirPlaySessionsForHost` 对活跃群组桥会话豁免(组内出声由组桥路由承担),孤儿桥会话(组已解散/设备已移出)照常回收——纯 AP 桥组不再被同 host DLNA cast 杀掉成员会话。

## [4.9.2] - 2026-10-28

### Cleanup / 删除全部数据库迁移代码，CREATE TABLE 升为最终形态

- **删了什么**：`db/index.ts` 全部迁移代码——tag_repair_done 补 platform/outcome、airplay_devices 补 hap_credentials、sendspin_device_state 补 hostname、player_groups 补 member_delays_json / DROP 旧三格列 / DROP track_switch_lead_ms / 补 mixed_anchor_lead_ms 共 6 块，以及 batch49 的 `migrateLegacyRateConfigs()`（player_rate_configs → player_output_configs 一次性数据搬迁，生产库已确认无 legacy 表）。`initDatabase` 现在只有 CREATE TABLE IF NOT EXISTS + 种子数据。
- **新装与已迁移库列级一致**：player_groups 的 member_delays_json / mixed_anchor_lead_ms 已并入 CREATE TABLE；一致性由新增 `tests/db/freshInstallSchema.test.ts` 钉住（新建库四表列集 == 240 生产库 2026-10-28 只读实录）。
- **⚠️ 旧版本 DB 备份恢复前需手工补列**（v4.9.2 起启动不再自动迁移）：player_groups 缺 `member_delays_json TEXT NOT NULL DEFAULT '{}'` / `mixed_anchor_lead_ms INTEGER`，airplay_devices 缺 `hap_credentials TEXT NOT NULL DEFAULT ''`，sendspin_device_state 缺 `hostname TEXT NOT NULL DEFAULT ''`，tag_repair_done 缺 `platform TEXT` / `outcome TEXT`；v4.8.x 之前的库另有旧三格列 / track_switch_lead_ms 需手工 DROP。
- **守卫**：G19-e 改写为「新装一致性钉」——CREATE TABLE 必须含两列 + 全文件禁 `ALTER TABLE` / `PRAGMA table_info`（迁移代码不许回来），总断言数不变（83）。
- **测试**：删 `tests/db/legacyRateMigration.test.ts`（随搬迁代码移除）；mixedAnchorLead 用例改写为新装一致性断言。

## [4.9.1] - 2026-10-28

### Cleanup / 删除切歌垫片组值手动口(trackLeadMs)，垫片动态自动挡不变

- **只删手动口、垫片机制一行不动**:切歌垫片(pendingTrackLeadUs)的冷/暖动态 lead 与逐帧消耗**零改动**;删除的是从没人用过的组值手动覆盖——`player_groups.track_switch_lead_ms` 列(幂等 DROP 迁移)+ `getTrackLeadMs`/`setTrackLeadMs`/`trackSwitchLeadUsOf` + API GET/PUT 收发 `trackLeadMs` + 读视图字段。默认 0 = 自动语义下从未生效,前端零引用。
- **两道防线注释已补**:streamEngine 混合组分支与 server.ts pendingTrackLeadUs 处写清「切歌等待(锚点 lead,窗口里有货可取,全组静默来源,混合组专用、组级可配)」vs「切歌垫片(桥侧接得住,投递时戳后移整形,影响所有带桥的组,动态自动挡)」的分工,**不可互相替代**;恢复手动口前必须真机回归(0xE0 雷区,捷径曾被真机否决)。
- **守卫**:G11 读视图断言与 notifyBridgeGeneration 动态 lead 断言反转为**不存在性**(防复活钉),总断言数不变(83)。
- **测试**:API 负向用例(PUT 带 trackLeadMs → 未知字段忽略、响应不含该字段且不生效)、delayCalib 删垫片组值用例、mixedAnchorLead 改为钉迁移删列、bridgePushFrame 删按组配置用例(动态冷/暖用例保留)。

## [4.9.0] - 2026-10-28

### Feature / 群组切歌等待时间可按组配置（混合组锚点 lead，默认自动 5000ms）

- **是什么**：混合组（AirPlay 桥 + 直连 Sendspin 成员并存）切歌前全组统一静默 ~5s——那是混合组锚点 lead `BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US`（v4.7.6 真机定标：低于 AirPlay 接收端就绪窗口 ≈2~3s 必吞新歌开头，5s 覆盖；代价 = 全组静默 ~5s）。过去是全局常量，无法按组调；本版改为 `player_groups.mixed_anchor_lead_ms` **组级实时可配**，前端群组卡片新增「切歌等待」入口 + 弹窗（0~30000ms，步进 100）。
- **语义**：NULL/0 = **自动**（沿用全局默认 5000ms）；>0 = 用户值。只影响混合组锚点分支——纯桥组深锚（`bridgeStartLeadUs`）与非桥分支（800ms 截断 / reseed）**一行未动**（守卫 G19 钉住）。
- **消费点与实时性**：`streamEngine` 混合组分支 `Math.max(aheadUs, mixedAnchorLeadUsOf(group) ?? BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US)`。子进程读值**绕过 delayCalib cache 直查 db**——cache 懒加载 + 写时更新、无失效广播，子进程结构性陈旧（`trackSwitchLeadUsOf` 同型旧洞，因其 0 默认 + API 隐藏调参口从未咬人）。**PUT 后下一首切歌即生效，无需重建/重启**。
- **接口与存储**：`GET/PUT /v1/groups/:id/delays` 双向收发 `mixedAnchorLeadMs`（响应另带 `mixedAnchorLeadStepMs/MaxMs` 供前端渲染）；`player_groups.mixed_anchor_lead_ms` 可空列 + PRAGMA 幂等迁移。
- **守卫**：`check-group-invariants.mjs` 新增 **G19**（混合组分支唯一表达式组值优先回退常量 / 纯桥深锚与非桥分支原样 / delayCalib 读写口+钳制+常量 / 消费点绕 cache 直查 / API 双向 / 迁移幂等+schema / 前端弹窗 append-to-body），总断言 76 → **83**。
- **测试**：新增 `tests/group/mixedAnchorLead.test.ts`——clamp、组级往返+落库、与 `memberDelays`/`trackLeadMs` 互不干扰、`mixedAnchorLeadUsOf` 四种 null 语义、**直改库复现「主进程写库、子进程 cache 陈旧」**（钉死为什么消费点必须直查）、API GET/PUT/404。

## [4.8.5] - 2026-10-28

### Fix / 试听片段跨进程判死回传 + 起播前完整性预检(第六闸)

- **根因续（《等你飞奔而来》240 生产事故）**：v4.8.4 的五闸全部落在**主进程**，而 Sendspin 流泵跑在 fork 子进程里——`streamEngine` 的 `stream-truncated` 判死 `markUnplayable(songId)` 只写子进程内 `streamFallback` 的 module-local Map，主进程 QueueController 判跳读的是自己那份 ⇒ 子进程 18:28:22 已判死，用户 18:28:46 重播照样播出。且起播决策 `judgePlayable` 在可播性 unknown 时只找「URL 探测能过」的行就 play、不判内容，而预取 `lookahead=1` 覆盖不到「跨过两首死歌后的落点」⇒ **首次必播出**（生产实测首次起播后 100.2s 主进程才知道它死，期间两次播出 60s 试听）。
- **跨进程判死回传**：IPC 事件面新增 `{ t: "songUnplayable"; clientId; songId; reason }`，`GroupPump` 挂 `onUnplayable` 回传口（`pumpFor` 装填，**不传 = 沿用已有**，seek 重建/泵复用/rehost 移交都不丢），判死拍回传主进程 `markSongUnplayableInMain` ⇒ `markUnplayable`。**回传口未装填不得静默**：判死时打告警（每首歌最多一条）——静默 = bug 无声复现。`playCore`/`playGroupCore` 末尾可选参数注入（与 `bridge?` 同款范式），旧调用零变化。
- **起播前完整性预检（第六闸）**：`judgePlayable` 在 `resolvePlayableRow` **之前**补 `precheckIntegrity`——四条保守条件缺一不可（可播性 unknown/transient、网络源、曲库 duration>0 **无基准不杀**、判官开），动作 = 复用预取 single-flight **有界等待** `precheckWaitMs`（默认 3000ms，0=关闸，钳 ≤9000 严格小于 playCurrent 外层 `withTimeout(…,10_000)`），判死 ⇒ skip；**超时 / 预取抛错 / 仍 unknown ⇒ 一律 play**（预检绝不阻断起播，2026-10-21 `playCurrent` 被永久占用的事故防线不破）。
- **预取闸门 0**：`prefetchSong` 同步入口 + `doPrefetch` 权威版双闸——已判死 ⇒ **一个字节都不下**（此前只有「已缓存/在途/并发上限」三道闸，已知死歌每次轮到重下一遍，240 实测 6h 内同一首 972KB 重复 5 次）。
- **守卫**：`check-group-invariants.mjs` 新增 **G18**（回传口三件套 / pumpFor 装填语义 / 未装填告警 / IPC 事件+分发+主进程落地 / childMain 双分支 / 第六闸四条保守条件+有界上界 / 先于换源 / 闸门 0 双闸），总断言 68 → **76**。
- **测试**：新增 8 文件 47 条——实现者 4 文件 27 条 + **QA 独立反证 4 文件 20 条**（用**真** streamFallback 不 mock，断言直接落 `getCachedPlayability === "unplayable"`，补上实现者 mock 掉 streamFallback 后「markUnplayable 写错 key 也照样全绿」的盲区；从排程入口 `prefetchUpcoming` 验证闸门 0 真零字节；预取**抛错**（非 hang）也放行；`precheckWaitMs` 的 settings > env 优先级钉死）。
- **既有 flake（非本次引入）**：`preProbeScheduler.test.ts > 死源被跳过但留在队列`（`expected 3 to be 2`）在满负荷全量下偶发，同 seed 纯基线（stash 掉全部改动）同样 FAIL 同一断言，已对照证明与本次无关。

## [4.8.4] - 2026-10-27

### Fix / 预取完整性四五闸:中段缓冲按真实时长判死 + 正缓存不得盖负缓存

- **根因续（240 生产二次暴露）**：v4.8.3 的两道闸是按**体积**判的——硬下界 32kbps 地板（217s×4KB=868KB）装得下《纵身一跃》972KB（129kbps 的 60s 试听），硬下界不命中 ⇒ 按 `too-small` 弱信号放行，照播 60s。而 240 实例把 `prefetch.settings.minAudioKB` 调到了 2048，绝大多数 mp3 都会落进 too-small 分支——**「太小」的判据值是可调的，跟着它调就会漏掉所有「够小但内容仍不完整」的源**。
- **闸 4（判官中段缓冲兜底）**：too-small 分支内在硬下界之后、落弱信号之前，对 ≥64KB（`PREFETCH_MIN_AUDIO_BYTES`）的缓冲用 `parseBuffer` 解析真实时长——`expectedSec - d > icfg.deltaSec` ⇒ `reason:"preview", via:"metadata"` **判死记负缓存**（与下方主路径同一把尺子，不另立阈值）；解析失败/解不出时长才保守放过。顺序为「硬下界 → 中段兜底 → 弱信号」，颠倒则兜底永不执行。
- **闸 5（正缓存不得盖负缓存，真凶=并发竞态）**：VIP 试听源的直链**能 200/206 正常解析**，错的只是内容只有 60s。于是队列预解析（RESOLVE-AUDIO）在 `await probe()`（网络 I/O，最长 12s）飞行期间，判官在预取侧落下 `markUnplayable(songId)`；等 probe 返回 206 ok，`addPlayable` 又把 1h 正缓存写回去——负缓存当场被盖，`getCachedPlayability` 读正缓存优先 ⇒ 判跳失效。两处修复：`markUnplayable` 立即 `playableCache.delete(songId)`（判死与可播不得并存）；`addPlayable` 写前 `if (isNegativeFresh(songId)) return;`（负缓存未过期一律拒绝写正缓存）。负缓存过期后自动解禁，源恢复即复活，不永久拉黑。
- **守卫**：`check-group-invariants.mjs` 新增 **G16 正缓存不得盖负缓存**（`isNegativeFresh` 单一声明 / `addPlayable` 拦截行 / `markUnplayable` 清正缓存）+ **G17 中段缓冲兜底**（顺序 / 同尺子判死 / catch 保守放行），总断言 62 → **68**。
- **测试**：新增 `tests/source/online/streamFallbackNegativeShadow.test.ts`（5 条，含**用可控 gate 的 fetch 把 probe 悬停**复现并发竞态的用例）；`prefetchMinAudioKB.test.ts`（5 条，seed 用 240 真实值 `minAudioKB=2048`，钉死「调大阈值不许漏判」）。
- **变异验证**：摘掉 `addPlayable` 拦截行 ⇒ 竞态用例精确变红（其余 4 条不假绿）；摘掉 `markUnplayable` 清正缓存行 ⇒ 短路用例精确变红。两处契约都有测试咬住，不是靠注释撑着。
- **生产验证（240）**：自然连播到 idx=198 时日志判死 `reason=preview 实际60s 期望217s ⇒ 记无源负缓存`，`QueueController` 立即「无可用音源,跳过(留在队列)」并直落 idx=199 播放——跳过生效。

## [4.8.3] - 2026-10-27

### Fix / 预取完整性三闸:上游截断对账 + 判官硬算术下界 + 负缓存 TTL 统一 2 小时

- **根因**（《纵身一跃》240 生产事故）：VIP 源（汽水 soda）对部分曲目只吐几十 KB 就提前断流，`bufferedFetch.attemptOnce` 只看 `reader.read()` 返回 `done` 就以 `ok:true` 交回残缺 buffer——全程没有拿响应头 `content-length` 与实收字节对账；判官只能按 `too-small` 弱信号处理（2026-10-21 策略：重试一次、不写负缓存），坏源的「无源」结论永远建立不起来 → 播 60s 断一次、每次重蹈。
- **闸 1（抓取层对账）**：`attemptOnce` 收尾校验 `content-length`——实收 < 90%（`TRUNCATION_TOLERANCE = 0.9`）⇒ 判 `stalled`（上游截断），走重试/换源路径，不再产生假成功。chunked（无 content-length）对不了账，由闸 2 兜底。
- **闸 2（判官硬算术下界）**：`judgePrefetchedBuffer` 的 too-small 档先过 `buf < expectedSec × PREFETCH_HARD_MIN_BYTES_PER_SEC(=4000，32kbps 地板)`——装不下期望时长 ⇒ `too-small-hard` 硬判死记负缓存（不再享受弱信号宽待）；装得下 ⇒ 保持 `too-small` 弱信号（2026-10-21 策略适用面收窄到「只是这次拿少了」）。播放路径（routes/rest）与预取路径同判。
- **TTL 统一（用户拍板）**：`markUnplayable` 废除独立固定 5 分钟，与探测型负缓存读同一份 `negativeTtlMs`（模块默认 **2 小时**，与 `core-pre-probe` 插件 `negativeTtlSeconds` 默认 7200 对齐，插件配置可覆写）——重复播放场景不再每 5 分钟重蹈坏源；平台版权/VIP 恢复后最多 2 小时自动复活。
- **守卫**：`check-group-invariants.mjs` G6 重钉（TTL 统一 3 条）+ 新增 **G15 预取完整性三闸**（截断对账容差/判断/错误串 + 硬下界常量唯一性/判断/判死原因），总断言 57 → **62**。
- **测试**：新增 `tests/source/bufferedFetch.test.ts`（截断对账 3 条）；`integrityOrder.test.ts` 补硬下界贴线边界 2 条；`prefetchCache.test.ts` (e) 改硬判死语义 + 新增 (e2) 弱信号保留；(h) TTL 用例与 `streamFallbackTtl/MarkUnplayable` 同步 2 小时口径；`bufferHeadWait.test.ts` (h) 播放路径按硬判死同步。定向 tests/source 全绿（26 文件 409 用例）。

## [4.8.2] - 2026-10-27

### Docs / 群组·AirPlay·Sendspin 三份权威文档对齐 v4.8.x 现状 + G14 回归守卫 + 覆盖率补齐

- **文档（按现状重写）**：`docs/group-权威方案文档.md` §0.4/§6 延迟补偿从「按协议三格 + 300ms 播种」整体重写为「按成员一格」（`member_delays_json` / 成员级取值口 / PUT `{memberId, ms}` / join 兜底自愈），新增 §4.5 可听前 BUFFERING 瞬态；§1.1 数据模型表、§10.1 守卫清单（G1~G14 / 57 条）、代码地图与附录 B/C 坐标全部同步。`docs/airplay-权威方案文档.md` §11 全节重写（AirPlay 侧链路 = 投递窗口/时戳位移、桥内锚点恒 0 G13-b、重建/join 自愈、验收判据改成员口径），代码地图标定行、索引表同步，附录 C 补 4.7.x / 4.8.0 版本行。`docs/sendspin-权威方案文档.md` §2.8 补可听前 BUFFERING，新增 §5.5 成员级延迟补偿。历史遗留状态修正：group 文档附录 C-8（每首歌无条件拆桥）与 airplay 文档 D-2 标记为已修复（v4.7.x `routeReusable` 暖复用，守卫 G13 已钉）。
- **回归守卫**：`check-group-invariants.mjs` 新增 **G14 可听前 BUFFERING 瞬态**（9 条断言：`SendspinGroup.audibleStarted` 声明唯一 / streamEngine 三处复位 / 推流+排空两处置位 / `pollCore` 返回字段 / playerCore 两处 cast 复位 / sendspin protocolPlayer 三处映射 + 两处兜底 / getGroupStatus 双分支映射 / `sendspinGroupPoll` 签名与 fork 兜底），总断言 48 → **57**；`dev/mutate-guards.mjs` 新增 G14-a/b/c 变异用例，负向验证 **3/3 能被真实违规打红**（基线三守卫全绿）。
- **覆盖率补齐**（v4.8.1 新代码路径）：`delayCalib` 非法 JSON / 非对象 JSON 兜底 2 条（此前 `parseMemberDelays` catch 分支 0 覆盖）；可听前 BUFFERING 映射 6 条 —— sendspin protocolPlayer 组 player / in-proc solo / fork proxy 三处 + `getGroupStatus` sendspin leader 与桥占用 airplay leader 双分支，含「旧子进程缺字段退化 PLAYING」兼容断言。

## [4.8.1] - 2026-10-27

### Fix / 切歌可听前进度「前进~2s 又跳回 0」循环:可听前上报 BUFFERING 瞬态

- **根因**:切歌(混合组锚点 lead 5s + 预填充水位 ~10s,单设备同理)在真正可听前有静默窗口,期间服务端 `pollCore` 已报 `playing:true`(current 已注册)而 `audiblePositionMs` 把位置钳在下界。三端(HA 卡片 / Web 前端 / MusicFlow 客户端)据此每 2s 轮询 + 本地按 PLAYING 插值前进,轮询拿回下界值又拉回 → 进度「前进 ~2s 跳回 0」无限循环。群组与单设备(sendspin)同源。
- **修复**:服务端可听前上报 BUFFERING 瞬态 —— `SendspinGroup.audibleStarted` 标志(play()/seek()/rehost()/cast 起播复位,pushLoop 与曲末排空循环首次越过上报下界置位);`pollCore` 返回新增 `buffering`,四处 pollState/getGroupStatus 映射为 `BUFFERING`(可听前 `playing:true` 但状态非 PLAYING)。
- **三端零改动**:客户端 `playing => state=='PLAYING'`、Web 前端 `statePlaying` 白名单、HA 集成 `STATE_MAP`(早已映射 `BUFFERING`)→ 可听前自动停止本地插值,进度条停在下界(0 / seek 目标)直到真正出声。
- 安全性:PlaybackTracker 把 BUFFERING 当瞬态(不判自然结束 / 不清 lastPlaying / 不计冻结宽限);fork RPC 透传,旧子进程缺字段退化为旧行为;stub 组(undefined)同样退化。

## [4.8.0] - 2026-10-27

### Feature / 延迟补偿从按协议三格改为按组内成员独立设置(每台播放器一格)

- **语义变更**:群组 A/V 延迟补偿的存储粒度从「按协议一刀切」(airplay_delay_ms / airplay2_delay_ms / sendspin_delay_ms 三格,组内同协议成员共用)改为**按成员独立存**(`member_delays_json`,member id → ms 的 JSON map,键与 memberIds 完全同源)。组里同协议的两台音箱现在也能各拿各的补偿值。
- **取值口重构**(delayCalib.ts):`airplayDelayUsOf` / `airplay2DelayUsOf` / `sendspinDelayUsOfGroupName` 退役,新增 `getMemberDelays` / `getMemberDelayMs` / `setMemberDelay`(键 = `airplay:<deviceId>` / `sendspin:<clientId>`)、`bridgeAnchorShiftUsOf(groupName, deviceId)`(按桥设备直传)、`sendspinDelayUsOfClient(groupName, clientId)`(逐客户端下发戳偏移)。补偿落点不变:AirPlay = 投递时戳位移(随桥会话建立锚定,保存后自动重建桥生效,约 1~2s 静音);Sendspin = pushFrame 下发戳偏移(帧级实时)。
- **API 变更**:`GET/PUT /v1/groups/:id/delays` 改成员粒度 —— GET 返回 `{ memberDelays, trackLeadMs, minMs, maxMs, stepMs }`;PUT 收 `{ memberId, ms }`(memberId 必须在本组成员列表,越组写入 400),可选 `trackLeadMs`(切歌垫片隐藏调参口,保留)。仅 AirPlay 成员值变化才触发桥重建。
- **前端**(Groups 页):点击组内播放器名称从「复制设备 ID」改为弹出**该成员的延迟补偿弹窗**(单数值输入 ±30000/步进 10,服务端按设备实际协议与身份取值,用户无需关心 AP1/AP2);chip 上回显非 0 补偿徽标;组级三格弹窗与「延迟补偿」按钮移除。
- **默认值变更(用户裁定)**:取消 AirPlay 内置默认对齐点 300ms(createGroup 播种与一次性迁移删除),新组/新成员默认 0 起步;旧三格数值**不迁移**,升级后全部归零重调;旧列在 initDatabase 幂等迁移中删除。
- 守卫同步:check-group-invariants G10/G11/G13 延迟断言全部改钉成员级取值口/落库/校验(createGroup 禁播种);dev/mutate-guards G13-a~d 变异目标同步。测试:delayCalib / apiGroupDelays / GroupManagerDelayView 按成员语义重写,bridgePushFrame 窗口位移用例改按成员格取值。

## [4.7.6] - 2026-10-27

### Fix / 混合组锚点 lead 定标 5s:消除切歌时 AirPlay 接收端吞新歌开头(真机 100% 复现)

- **根因(真机实锤)**:track 边界桥会话重启(RAOP 新流首包 0xE0 marker)后,接收端(HiVi)的就绪窗口实测 ≈2~3s —— 新歌开头 1~2s 落在窗口内被接收端跳过(表现:SENDSPIN 正常播放,AP1 出声时进度与 SENDSPIN 齐平,开头内容缺失,100% 复现)。诊断:PUSHDIAG 投递探针证实服务端**零丢帧**(7/7 切歌 dropN=0)、桥内锚定 reAnchored=false —— 内容完整送达,丢失发生在接收端对流重启的反应。
- **修复**:混合组锚点 lead 1.75s → **5s**(`BRIDGE_MIXED_GROUP_ANCHOR_LEAD_MS` env 可调),把新歌起播调度点推到接收端就绪窗口之外;真机验证 lead 3s 吞量缩短、5s 不吞。代价 = 切歌全组静默 ≈5s(esp32 一致)。
- 期间两项实验性方案被真机否决并回滚(记录留档):①桥内 aligner 跨空窗续走 —— 空窗被判 2.4s 漂移 skip,1s 正常/1s 无声循环;②排空后不 flush 重启 —— RaopPlayer 发送套接字进入 destroying 态,sendChunk false 无声。**结论:0xE0 流重启是 RAOP 桥在 track 边界的必要动作,lead 必须覆盖接收端就绪窗口**。
- 测试:bridgePumpGeneration 混合组三用例更新为 5s 定标语义;bridgePhase5 穿透用例随方案回滚移除。

## [4.7.5] - 2026-10-27

### Feature / 切歌同步 A+B 对齐 Music Assistant:动态 lead + 桥会话暖复用(切歌零重建零吞音)

- **动态 lead(A)**:垫片不再手设,按桥的**实际启动路径**声明 —— track 冷启(句柄重建,RAOP 握手+设备缓冲)⇒ 2500ms;track 暖复用或 seek/rehost(会话原地续用仅重锚)⇒ 800ms;生效 = max(组值, 动态);env `BRIDGE_TRACK_LEAD_COLD_MS`/`BRIDGE_TRACK_LEAD_WARM_MS` 可调(0=关)。旧固定垫片 BRIDGE_TRACK_SWITCH_LEAD_US 移除(固定值贴下限真机不稳定)。
- **桥会话暖复用(B,对齐 MA _can_reuse_stream_warm)**:playMedia 路由复用判据(上一条路由与在线 AirPlay 成员**同集合且协议一致**)⇒ 不拆桥、token 沿用;BridgeSessionManager.prepare 暖分支(同 token+设备+协议+RAOP 目标+健康)⇒ RAOP 会话跨曲目保活,新曲由 BOUNDARY(track) 驱动重锚(与 seek 同路径);句柄热复用信号(bridgeWarmAttach)回灌 lead 选择。**240 真机验证:切歌连续 7 次 warm-reuse、零 sessions:stop、driftUs=0/realigned=0/latePackets=0**。
- **前端**:移除「切歌垫片」手设项(全自动,无需手动);组值 trackLeadMs 保留为 API 隐藏调参口(PUT 不带即归 0)。
- 测试/守卫:新增 bridgeSessionWarmReuse 用例(⚠️ dry 会话必须显式 `dry: true`);路由暖复用/成员变化冷启用例;bridgePushFrame 动态冷/暖/手动 max 用例(vi.hoisted 钉 env 防默认值漂移);群组守卫 +4 条(动态 lead 声明/复用判据把守拆桥/token 沿用/暖挂载信号);全量 584 文件回归通过。

## [4.7.4] - 2026-10-27

### Feature / 切歌垫片按群组可配(弹窗第四行,默认 0=关闭,下一首歌自动生效)

- 切歌垫片 Δ(v4.7.3 引入,固定 1s)改为**每群组独立设置**:弹窗新增「切歌垫片」一行(0~30000ms,步进 100),持久化 `player_groups.track_switch_lead_ms`(**默认 0=关闭**,用户定调:手动修改后下一首歌自动生效,无需重建/重启)。
- 生效机制:投递时按组动态读(`trackSwitchLeadUsOf`),**下一首切歌即生效**;混合组/单一组各自调各自的值(桥重锚定耗时不同);纯 Sendspin 组设多少都无影响。
- API:`GET/PUT /v1/groups/:id/delays` 增 `trackLeadMs`;读视图 `PlayerGroupWithMembers` 带出(守卫 G11 同步钉四格)。
- 验证:bridgePushFrame 垫片按组用例(ug 组设 1500 ⇒ 时戳 +Δ 随内容消耗归零;未配置组行为与 v4.7.2 逐字节一致)+ delayCalib 四格独立读写/默认 0/0=关闭用例;群组守卫 **44 条**全绿(垫片按组读断言:notifyBridgeGeneration 不得回写常量);tsc=0。
- 教训(测试基建):tests/sendspin 内**严禁改 process.env.DATA_DIR** —— vitest 同 worker 顺序跑多文件,env 泄漏会毒化 group/routes 测试(no such column 扩散,2026-10-27 实锤);delayCalib 的内存缓存(落库失败被 catch)足以支撑本文件用例。

## [4.7.3] - 2026-10-27

### Feature / 切歌垫片:全组统一晚 Δ 起播,消除 AirPlay 桥切歌吞音

- 现象(用户真机):组切歌时 esp32 立即播新曲,HiVi(AP1 桥)重锚定慢约 1s,桥内对齐器为追组时间线**裁掉新曲开头**一段(吞音)—— 与补偿值无关,是组对齐的固有代价。
- 修复:内容代次切换(track/seek/rehost)时组时间线整体前移 **Δ=1s**(常量 `BRIDGE_TRACK_SWITCH_LEAD_US`,env `BRIDGE_TRACK_SWITCH_LEAD_MS` 可调/可关),**随内容推进逐帧消耗归零** —— esp32 下发戳、ring、桥投递、桥内对齐全链以同一 ring ts 为基准,一处加 Δ 全链自动跟随:全组统一晚 Δ 起播,HiVi 在垫片窗口内完成重锚定,对齐器从首帧 0 纯净起步,不再裁音。代价:切歌瞬间全组静默约 1 秒。
- 边界:仅在有桥的组生效(`notifyBridgeGeneration` 开头已对无桥组 early-return),纯 esp32 组零影响;`deliveredByGroup` 计量(样本数口径)不受影响。
- 验证:bridgePushFrame 新增垫片用例(首帧时戳 = ts+Δ−ahead、增量逐帧回落无跳变);tests/sendspin 63 文件全绿;tests/sendspin|group|routes|airplay|player|source 247 文件全绿;tsc=0;群组守卫 43 条、桥守卫 17 条。

## [4.7.2] - 2026-10-27

### Feature / 群组延迟补偿内置默认对齐点 300ms(AP1/AP2 通用)+ 生效语义文档化

- 用户定标(2026-10-27 真机 HiVi H5MKII):AirPlay 链路固有偏差(DAC/缓冲/链路)实测 ≈300ms —— 与 Sendspin 对齐的补偿值。固化为**内置默认对齐点** `DEFAULT_AIRPLAY_ALIGN_MS = 300`,**AP1 与 AP2 两格通用**。
- 生效面:① 新组创建时两格播种 300(`createGroup` 经 `setGroupDelays` 落库,不经 persist —— G11);② 一次性迁移把「从未调过补偿」(三格全 0)的既有组播种到 300,用户调过的组一律不动(settings 键 `group.airplayAlignSeeded` 防重复);③ UI 弹窗补「AirPlay 侧补偿随下一次会话建立生效:保存后建议重启容器(或重新起播该组)」提示。
- 权威文档同步:`docs/group-权威方案文档.md` §0.4 重写为三格权威口径(分格理由/投递时戳唯一落点/双加教训/重建触发与自愈/默认对齐点),数据模型表补 `airplay2_delay_ms`。
- 守卫:G10 新增 `DEFAULT_AIRPLAY_ALIGN_MS=300` 单一声明 pin + createGroup 播种断言(43 条);G13 第 5 条「anchorShiftUs 必须恒 0」防双加回归(v4.7.1 引入)。
- 验证:tests/sendspin|group|routes|airplay|player|source 247 文件 3626+ 用例全绿;tsc=0;群组守卫 43 条、桥守卫 17 条、变异反证 4/4 可打红。

## [4.7.1] - 2026-10-27

### Fix / 群组延迟补偿真机不生效(三重根因:锚点双加/投递窗口不跟随/重建自愈缺失)

- 根因一(锚点双加):投递时戳已携带全部补偿(ts' = ts − send_ahead + shift),而 `bridgePrepareDevice` 仍把组值传给桥内锚点 ⇒ 桥内 anchorUs = 投递时戳 + 锚点平移 = 双份 ⇒ 桥内对齐器把多出的那份判「内容超前」**整段裁掉**(真机听感:切歌被吞 2 秒、净补偿归零)。修复:`anchorShiftUs` 恒 0,投递时戳成为延迟补偿**唯一落点**(对齐器消费的时间线自带补偿,首帧 target=0 纯净起步)。
- 根因二(投递窗口不跟随):窗口 `[now+FLOOR, now+HORIZON]` 只以 now 选帧,锚点位移后帧的桥内可听时刻 = ts + shift ⇒ 窗口改为 `[lo−shift, hi−shift]` 且投递时戳同步加 shift;shift 按成员协议动态读(raop → airplay 格 / ap2-* → airplay2 格),PUT 后下一补投 tick 即生效。
- 根因三(重建自愈缺失):UI 改值必须重建桥会话才生效(中途时戳跳变会被对齐器消化回旧锚定),而 PUT 的重建判据 `isBridgeRouteActive` 依赖内存路由登记 —— **容器重启后 resume-active 恢复的桥没有登记**(真机实锤 PUT `rebuilt:0`)⇒ 重建不触发。修复:`bridgeJoinMember` 对「路由缺失但该设备确有桥会话在跑」现场初始化路由自愈(子进程 prepare 自拆同设备旧会话、泵 sync 停旧句柄起新句柄并回填);PUT 判据加兜底分支逐成员幂等 join。组未在播/设备无桥时保持旧契约 false,不给空闲组挂孤儿桥。
- 顺带:补偿生效面 UI —— 弹窗按组成员实际协议标注「本组没有走 {side} 的成员,这一格调了不生效」;补负方向物理天花板提示(更早出声受设备缓冲限制,提前超过约 1 秒通常无感);渲染器插件「延迟补偿」说明同步三格。
- 守卫:G13 第 5 条改为「anchorShiftUs 必须恒 0」防双加回归;G13-d 变异锚随重建重构更新;新增投递窗口跟随用例(AP1/AP2 分格 + 正负 shift + 投递时戳断言)。验证:tests/sendspin|group|routes|airplay|player|source 247 文件 3626 用例全绿;群组守卫 41 条、桥守卫 17 条、变异 4/4 可打红;tsc=0。

## [4.7.0] - 2026-10-27

### Feature / 群组延迟补偿增加 AirPlay 2 独立一格:AP1 / AP2 / Sendspin 三侧各调

- 入口:群组卡片「延迟补偿」弹窗新增 **AirPlay 2** 一行(原先只有 AirPlay 与 Sendspin);差值提示改为按侧各出一行(都以 Sendspin 为基准),卡片徽章在三者非 0 时分别回显。
- 为什么要拆:AirPlay 1 走 44.1kHz 重采样 + 明文 RTSP,AirPlay 2 走 48kHz 直通 + 加密链路,两条路的抵达延迟不是同一个物理量。原先共用 `airplay_delay_ms`,混合组里调一格会同时动两台设备,等于让用户在 AP1 与 AP2 之间来回凑,谁也调不准。
- 取值是**逐成员**而不是按组:`bridgePrepareDevice` 的 `anchorShiftUs` 按该成员自身的桥协议二选一 —— `isAp2BridgeProtocol(protocol)` 命中读 `airplay2_delay_ms`,否则仍读 `airplay_delay_ms`(AP1 的取值表达式一字未改)。同一混合组里 AP1 成员与 AP2 成员各读各的格子。
- 持久化:新增 `player_groups.airplay2_delay_ms`(幂等 `ALTER TABLE ADD COLUMN`)。**升级时把既有 `airplay_delay_ms` 的非零值复制过来** —— 用户此前标定过的组不会因分格而凭空归零;继承值与 AP2 实际链路有偏差属于预期,之后各调一格即可。全 0 的组不复制,保持三项干净。
- 接口 `GET/PUT /rest/api/v1/groups/:id/delays` 增 `airplay2Ms`;PUT 的重建桥条件由「只判 airplayMs」扩为「airplayMs 或 airplay2Ms 任一变化」—— AP2 的锚点同样在会话建立时算死,不重建就等于「只改 AP2 那一格」调了没反应。
- 验证:`delayCalib` 新增第三格六项用例(三格独立读写 / 只改第三格 / ±30s 钳制 / 落库回读 / 单位换算不串格 / 只设 AP1 时第三格仍 0)+ 路由三项 + 读视图三项;`bridgePrepareAnchorShift` 补 AP2/AP1 分格取值五例(含「同一组两台成员各取各格」与「无组上下文仍回落全局值」);`tests/group|routes|airplay` 59 文件 894 用例全绿;群组守卫 41 条断言全绿(含新增 **G13 AP1/AP2 不得串格** 4 条),变异反证 36/36 条都能被真实违规打红。

### Feature / AirPlay 2 全链路打通:配对 → 准入 → 逐成员选协议 → 出声

- 配对:新增 `POST /rest/api/v1/airplay/devices/:deviceId/pair`(4 位 PIN,HAP 配对凭证入 `airplay_devices.hap_credentials`);`controllerId` 持久化到 settings —— 该 id 一变,库里所有凭证全部失效,因此必须持久化。
- 准入:`selectable` 的**唯一判据**是 `control.ts::isAirPlayMemberSelectable`(支持 AP2 但未配对 ⇒ 不可选、不可入组),前端不持有第二套判据。`GET /v1/airplay/devices` 返回全部设备(含未配对)并带 `ap2Capable/ap2Paired/selectable`,由选择器与群组候选各自过滤。
- 协议逐成员选:`selectAirPlayBridgeProtocol` 按「开关 + 设备 supportsAp2 + 已配对」三重判据,只出 `raop` 或 `ap2-realtime`(**禁用** ap2-compat 与 buffered)。同一混合组里 HiVi(仅支持 AP1)与 AP2 设备并存时按各自能力走,不是组级开关。
- 出声:`BridgeSession` 增与 RAOP 并列的第二个出口 `runAp2Output`(纯驱动,共用唯一的 `planBridgeAnchor` 锚点与唯一的 `BridgeTimelineAligner`;48k 直通不重采样;late-skip 30ms;暂停不拉块;abort/failLink 立即退出)。
- 延迟标定结论:`AP2_EFFECTIVE_LATENCY_FRAMES` 保持 11025 —— 230 测试床实测 pop 侧中位 0.194ms 只是地板值,而 `latencyMin` 是设备要求的最小提前量,低估会 underrun、高估不吃亏。
- 兜底:成员桥断开经 snapshot 降级标志 + 5s 看门狗摘桥并回落 AP1 solo(**不在会话内切协议**);`prepareBridge` 错误按 `ap2-<stage>` 前缀化以复用既有 soloFallback;未配对设备不摘组、回落 AP1、标为需重新配对,只有新加入严格禁止。
- 验证:新增 ap2ControllerId / ap2PairService / groupAp2Gate / airplayPairRoute / ap2ProtocolSelect / bridgeAp2Output / groupAp2Route 七个测试文件。

### Fix / 30-60 秒假歌三处漏网

- 判官顺序:几 KB 的 JSON/HTML 错误页原先先被「<64KB」的弱信号拦下(判成「太小,重试一次」),永远走不到 magic 检测。改为**先 sniffMagic**(不是音频 = 硬结论,10MB 的 HTML 也照样不是音频 → `markUnplayable` → 换源),`too-small` 降级为之后的弱信号。
- 流式窗口提前 EOF:该路径从来没有「已交付时长 vs 声明时长」的比较,所谓「交给播放侧探测」实际交给了不存在的探测器。补上:交付时长与声明时长之差 > 80s ⇒ `markUnplayable` + `ev=stream-truncated`。注:交错样本必须除 `SAMPLE_RATE * CHANNELS`,只除采样率等于把 80s 判死线悄悄放宽到 160s。
- `contentEnded` 与 `endedNaturally` 语义分离:截断时若按 `endedNaturally` 驱动收尾,`current` 不清空 ⇒ 整组卡在 PLAYING。改为按 `contentEnded` 收尾,`endedNaturally` 只回答「算不算自然播完」。
- 单曲循环防死循环:同一 songId 连续判死 2 次 ⇒ 跳下一首(播够 30 秒且未判死才清零)。
- 验证:240 真机复现并修复 —— `ev=stream-truncated song=258298a0 expectedSec=276 deliveredSec=60 missingSec=216` ⇒ 自动跳下一首,不再卡住。

### Fix / 播放器页加载(常卡在「等待播放器」)

- axios 超时 15s→6s;GET 在无响应时自动重试一次(有响应的一律不重试);加载失败**不再伪装成空列表**,保留上次列表并给行内错误条与就地重试;懒加载改为「成功才注销」loader,失败可重入。
- 设备分区的 loading 罩改为「只有首次且列表为空才罩」,避免每次刷新都闪骨架。

### Fix / 群组回归守卫体系带出的两处真缺陷

- 桥会话播放中音量落不到 RAOP;全成员 cast 失败时桥路由泄漏、设备被 owner=bridge 永久占用(此后所有 native cast 被拒)。
- 另修:历史含 DLNA 成员的组被永久锁死(准入改为只校验新加入成员);`getGroupDelays` 返回共享可变默认对象(任一调用方改写会污染全局默认与所有无行组)。
- 体系:群组不变量守卫 G1–G12(35 条)+ 本次新增 G13(4 条);配套变异反证工具用于证明断言不是恒真式,覆盖率棘轮门禁把 airplay 86.2→92.5 / group 76.4→98.8 行覆盖钉住。

### Docs / 文档瘦身 32.6%

- 删已被代码推翻的旧方案正文、跨文档重复表、过程台账与排期噪音;两份历史方案压成「落地状态表 + 决策 + 推导 + 病根」;修正过期口径;4 份旧调研归档到 docs/archive 并加索引。

## [4.6.77] - 2026-10-26

### Feature / 群组延迟补偿(按组 A/V 标定):AirPlay 与 Sendspin 各自可调 ±30s,正数更晚 / 负数更早

- 入口:播放器群组页每个群组卡片的「延迟补偿」按钮 → 弹窗(两个 el-input-number,步进 10ms,范围 ±30s);保存即生效,卡片上直接回显非 0 的值。
- 语义:两侧各自独立存(`player_groups.airplay_delay_ms` / `sendspin_delay_ms`),**正数 = 该侧更晚出声,负数 = 该侧更早出声**;只有差值影响 A/V 同步,分开存是为了纯 AirPlay 组 / 纯 Sendspin 组也能各自微调。
- AirPlay 侧:接进 `bridgePrepareDevice` 的 `anchorShiftUs`(取代原全局 `bridge.avShiftMs`;升级时把旧全局值一次性搬迁到既有组,免得既有补偿凭空归零)。锚点在桥会话建立时算死 ⇒ PUT 后只重建**该组**的桥(`rebuildBridgeRoutes(groupId)`),代价是该组 AirPlay 成员约 1~2 秒静音,Sendspin 成员不受影响。
- Sendspin 侧:`SendspinGroup.pushFrame` 的下发戳偏移(帧级,**真·实时**,约 0.5~1 秒后听到);`seedLateJoin` 回填用同一偏移,否则新成员进场会比老成员早/晚一个偏移、听出跳变。
- 铁律:偏移**只作用于成员下发戳**,ring 里的 `tsUs` 一律不动 —— 它是桥投递窗口 / 水位 / late-join 回填的唯一时间基准,改了会把 AirPlay 侧一起带偏。
- 接口:`GET/PUT /rest/api/v1/groups/:id/delays`(renderer.use + 组 owner/管理员;组不存在 404;越界钳制不报错;GET 回带 min/max/step 供前端渲染)。群组读视图(`listWithMembers*` / `getWithMembers`)附带两侧当前值供回显。
- 持久化:两列落在 `player_groups`(幂等 `ALTER TABLE ADD COLUMN`),弹窗打开时走 GET 回显,重启不丢。
- 验证:新增 `tests/group/delayCalib.test.ts`(钳制 / 落库回读 / 只改一侧 / 单位换算 / `ug:` 解析)+ `tests/routes/apiGroupDelays.test.ts`(默认 0 / 写入回读 / 越界钳制 / 单侧更新 / 组不存在 404);`tests/group|sendspin|airplay` 105 文件 1447 用例全绿;前端浮层守卫通过。

## [4.6.76] - 2026-10-25

### Fix / 客户端丢失配对记录后无法重连(哨兵回退验签恒失败)

- 根因:服务端持有长配对记录但客户端丢失本地记录时,服务端 `trySentinelFallback` 重放 msg1 用 **sentinel 派生的载荷字节**(psk_id/类别重算),而客户端 Noise 对称状态里 hash 的是服务端实际发出的 **lt 载荷字节**——两者不同 ⇒ 握手哈希分叉 ⇒ msg2 永远 `invalid tag`,回退恒失败,设备彻底连不上(只能先在服务端解绑)。
- 修复:回退时逐字节重放 beginHandshake 实际发出的原始 msg1 载荷,仅将密钥侧换成 sentinel(与客户端「解析不到凭证 → mix_psk(SENTINEL) 继续」的 fork 语义对齐)。
- 验证:真客户端 e2e(230→240)——服务端有记录 + 客户端空记录 → 回退成功不踢线 → 自动开配对窗 → 输码重配 → 客户端收到新记录落盘、会话恢复;测试套件将原 `it.fails` 契约翻转为通过,并补「lt/sentinel 双错」负例守住 fail 收口;sendspin 54 文件 763 用例全绿。

## [4.6.75] - 2026-10-25

### Fix / Sendspin 新设备首次配对互锁(服务端与标准客户端协议四连缺陷)

- 根因:未配对(sentinel)会话 hello 后服务端无条件发 `activities:["playback"]`,标准客户端(aiosendspin/ESPHome cpp)按 1.0.0-rc1 语义判 `pairing_required` 立即 goodbye 断开;而 REST `/pairing/start` 又要求客户端已在线——首次配对互锁,新设备本就配不上。
- 修复四连:①未配对会话按凭证状态只发 `activities:["pairing"]` 或空激活(凭证失配最高优先,与 legacy/编排无关),身份照常登记,配对编排自动开窗;②动态码输码后立即开跑验配(与静态码一致,不再等设备重发 pair-init);③配对完成 re-handshake 后按 PSK 类别下发正确消息(lt 直接 playback activate + group/update,不再发 server/hello 致客户端断连);④配对成功后按 supported_roles 重协商,不再出现 paired:true 却 active_roles 为空永远不能播。
- 验证:aiosendspin 10.2.1 真客户端 e2e(假设备→240 生产容器)全流程通过(配对码→输码→落盘→group-update→roles 重协商);tests/sendspin 54 文件 761 用例全绿;backend 全量 529 文件 7449 用例全绿。已知残留:客户端丢失本地配对记录后哨兵握手认证失败(待修,临时解法为服务端解绑后重配)。

## [4.6.74] - 2026-10-24

### Fix / SENDSPIN 流转到 AirPlay 无声(拖一下进度才出声)

- 根因:sendspin 泵自拉流、不经服务端整曲缓冲(membuf);流转到 AirPlay 时回环流冷启动,web 源整曲缓冲单次 deadline 短,冷取流失败后推流全程饥饿——设备 PLAYING 但无数据(推流 378 次 reanchor / 3s 停顿),拖进度重建会话时 membuf 已被后台重试灌热才出声。DLNA 源不受影响:其播放路径经 /rest/stream 已把整曲灌进 membuf,转 AirPlay 热命中秒出声(同曲对比实证)。
- 修复:transfer 目标为 AirPlay 且带起播起点时,先把源曲有界预热(≤8s)进 membuf 再 cast——落地则回环流预取命中秒供流;未落地则回环流搭车在途预取或直通,最坏起播稍慢,不再出现「会话活着但永远没数据」。

### Feature / 群组成员调整:DLNA 禁止入组,AirPlay 允许入组

- 后端成员命名空间新增 `airplay:<deviceId>`;`setMembers`/增量口对 DLNA 成员(含历史裸 id 写法)一律拒收,airplay 校验设备档案存在且未禁用(可用性动态解析,离线仍可建组)。
- 组播放:airplay 成员逐设备独立 cast(与 DLNA 同为自拉流语义,起播即落位由各自 cast 承担);stop/pause/resume/seek/setVolume 同步扇出;组 leader 跨 kind 派生(airplay 可当选),组状态/音量按组标度回显。
- 播放中入组:airplay 成员走 rejoinMembersAirplay——起点编进**本次 cast**(起播即落位,绝不先起播再 seek);摘除断开成员会话。
- 前端群组候选此前已只列 airplay/sendspin,本次后端对齐后全链路闭环;群组列表成员音量条支持 airplay 回显。

## [4.6.73] - 2026-10-24

### Fix / Sendspin 对齐 1.0.0-rc1(ESPHome 2026.10.x 固件)——13B 帧头/配对 sid round/音量命令能力合并

**背景**:esphome 2026.9.1 → 2026.10.1,sendspin 组件升 sendspin-cpp 0.9.3(实现 Sendspin 1.0.0-rc1),
四处协议位移叠加出全链无声/设备身份断裂/播放卡顿/配对失败/音量不下发一组症状。

**修复**:

1. **音频帧头 9B → 13B**(`1B type + 8B ts + 4B send_ahead` 大端 μs)——新固件的规范字段,
   旧 9B 对 2026.10 固件每包 `Error decoding FLAC frame: -2` 整链无声
   (`framing.ts`,保留 `SENDSPIN_AUDIO_HEADER=9` 回退开关)。
2. **配对 PAKE sid 加 round**:新 spec `sid = label‖h‖pairing_index‖round`(均大端 uint32);
   旧口径(无 round)与 2026.10 固件 CPace 校验必 `pairing_code_mismatch`(`pairServer.ts`)。
3. **`supported_commands` 移位合并**:spec 1.0 把它从 hello 的 `player@v1_support` 挪到
   client/state 的 player 对象;服务端在 `applyClientState` 合并,并在首次学到 volume
   能力时立即补发权威音量——修复「前端拖音量条设备不变」与「重连后音量不恢复」(`server.ts`)。
4. **基线回滚 6492b20**(去 cliairplay 同步桥接),保留 hostname+psk 设备身份与批准文案;
   真机 esp32-player2 已完成 static_pairing_code 配对(`paired=True`,记录双端落盘)。

**验证**:真机 esp32-player2(2026.10.0 固件)FLAC 播放正常;配对 paired=True;
音量下发首帧 state 即服务端补发值(修复前恒开机默认 20);tsc 干净;
framing+pairServer 测试 5/5 绿。`docs/sendspin-权威方案文档.md` 已增补 rc1 对照表
并反转坑 A1 结论(见 5bae341)。

## [4.6.72] - 2026-10-24

### Chore / undici 升到 ^8.12.3(`v4.6.71` 的 security 门禁被新披露漏洞打红)

**症状**:`v4.6.71` tag 的 `security` workflow 红(同一份 main 代码 23:45Z 那次还是绿的),
`npm audit --audit-level=high` 退出码 1。

**根因**:`undici 8.0.0 ~ 8.12.1` 在两次构建之间的时间窗里被披露 3 个 high 漏洞
(属时间窗内新披露,与本版代码改动无关),而 `^8.11.2` 的 caret 范围正好把它锁在受影响区间内。

**修复**:`backend/package.json` → `undici: ^8.12.3`(实装 8.12.3);
`package-lock.json` 用 `npm install --package-lock-only --registry=https://registry.npmjs.org`
重写,避免 npmmirror 的 `resolved` 地址污染 lock —— diff 收敛为纯版本升级(4 行)。

**验证**:全仓引用 `undici` 的测试仅 2 个文件 ——
`tests/services/proxyDispatcher.test.ts` + `tests/source/online/streamFallbackTtl.test.ts`,
**2 files / 26 tests 全绿**;`npm ls undici` = 8.12.3。
(230 本地 `npm audit` 走 npmmirror 不可用:`[-/npm/v1/security/* not implemented yet]`,
审计结论以 CI 官方源为准。)

## [4.6.71] - 2026-10-24

### Fix / cast 挂死时回执仍谎报落点(`transfer-from` 回 200 而目标端静默)

**症状**:「组 → 组内最后一台成员」流转,接口 200 且 `position` 给了正确落点(97),
目标端却**一点声音都没有**;客户端按落点把进度条画在 97s,过 30 多秒才突然开始出声。

**实测证据(240 + 230 三台 AP2 模拟接收端,密集采样探针)**:

```
23:21:33.818   [QueueController][cast] …0002 起点 idx=5 song=307bc124 dur=129
23:22:04.089   [QueueController][playCurrent] …0002: cast FAILED: playMedia 超过 30000ms 未返回(cast 挂死)
23:22:04.106   [HTTP] WARN 慢请求 POST …/queue/transfer-from ms=31447
               回执 → {"success": true, "transferred": 6, "startIndex": 5, "position": 97}   ← 谎报
               同期探针采样 → B=STOPPED/0.00 ×14 次(目标端持续没起播)
23:22:24.752   [QueueController][cast] …0002 起点 idx=5(卡死兜底重投)
23:22:42.086   [QueueController][cast] …0002 完成 17335ms       ← 到这里才真正出声,晚 38s
```

**根因**:`castLanding` 是在 `playMedia` **之前**写下的 —— 那时只知道「打算把哪个起点
编进本次 cast」,所以它的 `applied` 语义原本只回答「起点有没有被跳过逻辑丢弃」。
cast 本身失败(30s 超时挂死 / cast 期间目标掉线)时,`abortTimedOutCast` 抛错落进
`playCurrent` 的 catch,但那里**没有**回头作废 landing:`playFrom` 照常返回,
路由读到 `castLandingOf(...).applied === true`,于是把「起播意图」当成「已经落位」回执。
落点本身没错(重投沿用 `lastCastStartMs`,仍是 97),错的是**回执先于事实**。

**修复**:cast 失败分支(含 cast 期间目标掉线的竞态分支)立刻把 landing 改写成
`applied=false`、保留 `requestedMs` 供排查 ⇒ 路由如实回 `position: null`,
客户端不会画出一个并未出声的进度条。重投成功时 `playCurrent` 会重新 `set(applied=true)`,
重投路径的落点不受影响。

**回归防线**:`tests/player/castLandingHonesty.test.ts` 三例 —— cast 挂死 `applied=false`、
cast 成功 `applied=true` 且 `requestedMs` 原样、无起点 `applied=false`。
撤掉修复后第一例变红(实测)。

**未在本条处理**:触发这次挂死的上游出流 TTFB(`GET /rest/airplay/stream/:token`
整曲缓冲 17~30s,`Lavf` 侧等首字节直到 30s cast 硬顶)属于另一条性能议题,
与回执诚实性无关,另行评估。

### Fix / 桥接成员的播放位置改取 pump 内容时间线(成员上报位置超前组 8.4s)

**症状**:同步组播放时,AirPlay 成员的 `/peers/:id/status` position 比组位置明显超前(实测
230-r1 报 57.74s 而组在 48s),同一组的另一台只超前 0.6s —— **每台各偏各的**。副作用是
从该成员发起流转时读到的源进度偏大、落点跟着偏;群组同步的可观测性也被污染(只能靠放宽容差判)。

**实测证据(240 + 230 两台 AP2 接收端,组 TEST-sync-ap2x2)**:
- 该成员的桥接会话建立于 22:24:20.8,而 pump 首帧在 22:24:29.5 —— **空转 8.4s**,与上偏量吻合;
- `[airplay-bridge] stats` 显示两台成员的 `w/m/clock/delta` 逐拍相同 ⇒ **内容本身是齐的**,
  错的只有「上报位置」的 0 点;
- 两台接收端 PCM 尾窗包络互相关 lag=-0.95s / corr=0.418(拿**文件头**做会得到 -2.50s,
  那是各自文件起点不同造成的假象,不能当音频错位证据)。

**根因**:`CliSink.positionSec = baseSec + 本次会话已过时长`。普通 cast 的第一批 PCM 就是
内容起点,两者重合;而桥接的 PCM 来自 sendspin pump,会话可以在 pump 起播前好几秒就建好,
这段空转全被算成已播内容。

**修复**:桥接会话注入 `contentClock`(`BridgeRing.contentSec`,0 点 = pump 首帧),
`positionSec` 改由 pump 时间线决定,与组位置、其他成员同源。未注入(普通 cast)或返回
null(pump 还没送帧)时**行为完全不变**。

**守卫**:`tests/airplay/bridgeContentClock.test.ts`(6 例)锁死该口径;回退修复后
「位置按内容时钟报」一例必红(变异已验)。

### Fix / 群组 AirPlay 成员改为并行握手(成员间真实音频错位 0.80s → 收敛)

**症状**:同步组的两个 AirPlay 成员位置读数一致前进(同为 1.0000×),但**实际出声**相差约
0.8s;组起播要 7~16s,`queue/play` 长时间不返回。

**实测证据(230/231 双机真机)**:两台 AP2 接收端的 PCM 落盘做 50ms 包络互相关 ——
峰 `corr=0.779 @ +0.80s`,而 `lag=0` 时只有 `0.464`,即两路是同一段音频但差了 0.80s。

**根因**:`startGroupAirPlayBridge` 按设备**串行** `await` 握手(实测 3832ms + 2772ms)。
每个会话的播放延迟(lead)在不同时刻测量、`START_UNIX_MS` 锚点也落在不同时刻,
于是两台设备的实际开播时刻相差接近一次握手耗时。

**修复**:

1. 握手改 `Promise.all` 并行:两台在同一时刻完成握手、同一时刻开播,错位随之收敛;
   组起播也从「Σ 各设备握手」压到「一次握手」。
2. 首轮失败再重试一次(只重试失败设备):实测存在 FIFO 被并发拆除导致握手 `ENOENT`
   的偶发失败,单台失败会让该成员整场静音。
3. `AP2 命令管道无读端` 快速失败:`ENOENT` 说明 FIFO 本身已被拆除(不是「读端还没打开」),
   不再把 5s 重试预算烧完 —— 旧实现让单台成员被拖 13s 才放弃,并把整组起播一起拖慢。

**回归防线**:新增 `backend/tests/group/airplayBridge.test.ts`(6 例),用「同时在飞的
`bridgeCast` 最大并发数」钉住并行契约(不依赖墙钟、不 flaky),并覆盖失败重试、
离线成员跳过、`send_ahead` 下限、组内无 airplay 成员五种情形。

### Fix / 流转到群组:落点改为「起播前定格」(实测超前源端 4.9s、且额外 seek 拖到超时)

**症状(全量流转矩阵实测)**:`transfer-from` 目标为群组时——
- `AP1 → group`:源端 47.52s,回执落点 **52.43s**,目标确实从 52s 起播(超前 4.9s);
- `AP2 → group`:回执落点 47.64s 正确,但目标全程 `STOPPED`,观察窗口内没起播。

**根因**:`routes/api/peers.ts` 的落点分支只对 `airplay` 目标「起播前定格位置」,群组落到了
「起播后晚读数 + 补一次 seek」的老口径上。群组起播要建 pump 再逐个成员握手桥接,
即使并行后仍需 4~20s —— 这段耗时被算进落点(late 读数从 47.52s 涨到 52.43s),
而且补 seek 对群组等于**重建一次时间线**,把整格拖到超出观察窗口。

**修复**:新增 `playTarget.freezesPositionBeforeCast(kind)`,把「必须在 cast 前定格」
收口成单一判据(`airplay` / `group` 为真),`peers.ts` 改用它。群组因此也走
`playFrom(..., startMs)`,既不把起播耗时算进落点,也不再补第二次 seek。
`dlna` / `sendspin` / `local` 保持旧口径(起播 1~3s,晚读数更贴近真正出声的时刻)。

**回归防线**:`tests/services/playTarget.test.ts` 增 3 例钉住该判据(含未知 kind 保守不定格)。

### Fix / 流转到「组内最后一台成员」时落点丢失(摘组动作抢在落点定格之前)

**症状**:组正在播放 → 把音乐流转到该组内的成员设备,响应里 `position` 为 `null`,
目标端从那首歌的 0 秒开始播;若目标恰好是组内**最后**一台成员,现象必现。

**实测证据(240 + 230/231 两台 AP2 接收端真机)**:同一组连续两次流转,
「组 → 成员 A」响应 `position: 5`(组里还剩 B,源组仍在播,读得到进度);
「组 → 成员 B」响应 `position: null`(B 是最后一台,B 一被摘出组,组即停播,
之后才去读源端进度,只能读到 0)。组成员表也同步从 2 → 1 → 0。

**根因**:`transfer-from` 里 `detachFromActiveGroups(parsedTo)` 排在「源端落点定格」
之前。摘组本身就会**停掉源端**(目标若正替该组出声,摘组即断流),违反文件里既有的
那条原则 —— 落点必须在**任何会改变源端状态的动作**之前定格(此前只覆盖了「起播」,
漏了「摘组」)。

**修复**:把 `freezesPositionBeforeCast(kind)` 那条定格分支提到 `detachFromActiveGroups`
之前;sendspin/dlna 这类非定格目标仍复用先前算好的 `srcPosEarly`,不额外多读一次。

**回归防线**:`tests/routes/peersRoutesContract.test.ts` 新增两例,用「调用顺序数组」
钉住 `readPeerPositionSeconds` 必须全部早于 `detachFromActiveGroups`(airplay 目标 +
group 目标各一例)。回退修复后两例均变红。

### Fix / `POST /v1/peers/:peerId/play` 的 airplay 分支漏了「先脱离活跃组」

**症状**:组成员正被组桥接驱动时,对其中一台 AirPlay 成员单独点播放 —— 指令落到该成员
自己的 ctrl 上,和组桥接抢同一台设备:表现为「点了播放没反应」,或与组正在播的内容互相打断。

**根因**:`/play` 的 `dlna`、`sendspin` 两个分支都调了 `detachFromActiveGroups`,唯独
`airplay` 分支没有。而 2026-10-23 起 DLNA 已禁止入组,**airplay 反而是最常见的成员 kind**,
这条遗漏的影响面比当初写代码时更大。`shared.ts` 里那句「仅设备型成员(dlna / sendspin)适用」
的注释也是同一批过时信息(函数体实际只接 airplay / sendspin)。

**修复**:airplay 分支补上 `detachFromActiveGroups(parsed)`(与 dlna/sendspin 同口径,
顺序仍是「先摘组、再 resume + transport」),并订正 `shared.ts` 的过时注释。

**回归防线**:新增两例 —— airplay 成员 play 必须按 `detach → resume` 顺序执行;
group 目标 play **不得**摘组(组本身不从属于任何组)。回退修复后前一例变红。

### Fix / 起点被跳过丢弃时,回执仍谎报落点(`/queue/play` 与 `/queue/transfer-from`)

**症状**:带进度起播 / 流转后,客户端把进度条画在 45s,声音却从 0 开始 —— 而且**时好时坏**,
同一条指令一会儿落位一会儿归零,看起来像随机 bug。

**实测证据(240 真机,`--seek 45` 全量矩阵 + 定向探针)**:

```
queue/play  {items, startIndex:0, position:45} → 回执 {"position": 45}
源端实际状态  → state=PLAYING position=2.29 currentIndex=3  (第 0/1/2 首被判「无可用音源」跳过)
容器日志      → [QueueController][playCurrent] bb5c…: song 59ce8891… 无可用音源,跳过(留在队列)
```

**根因**:`playCurrent` 里 `castStartMs = skips > 0 ? undefined : startPositionMs` ——
跳过不可播曲目后起点**必须**丢弃(起点只属于原本那一首,套到别的歌上是错的)。
但 HTTP 层不知道这件事发生了,把 `askPosition` 原样回执 ⇒ 落点在服务端**完全不可见**。
而「无可用音源」的判定要过在线源复核,会抖动,于是同一条指令表现成随机落位/归零。

**修复**:

1. `QueueController` 新增 `castLanding` 记录本次 cast 的「起点是否真的编进去了」,
   并暴露 `castLandingOf(deviceId)`(设备被清理时同步删除)。
2. `/queue/play` 与 `/queue/transfer-from` 的回执改为按它判:被跳过丢弃时回
   `position: null`,不再谎报。
3. 流转侧还额外**禁止回落进「晚读数 + seek」分支**:目标端此刻播的是另一首,
   把旧起点塞进去等于让它跳到不该去的位置 —— 如实回 null,什么也不做。

**回归防线**:`tests/routes/peersRoutesContract.test.ts` 新增两例(起播回执 / 流转回执),
`_peersFakes` 的 `queueController` 补 `castLandingOf` 出厂值(已落位,保持既有用例语义)。
两例在回退修复后均变红。

## [4.6.70] - 2026-10-22

### Feature / AirPlay 改为默认独立子进程（与 Sendspin 对齐）

**背景**：AirPlay 的 7.98ms 墙钟推流节拍此前跑在主进程（`defaultFork: false`）。前端请求 /
批量任务占住事件循环时，RTP 发包被打散（现场 `reanchors=400/5s、maxGap≈2s`），听感卡顿。
Sendspin 早已是独立子进程，AirPlay 却仍与主进程共用事件循环。

**修复（fork 路径三处挂死 + 一处对齐）**：
1. **RTSP 连接关闭必须 reject**：`sendRtsp` 等响应期间对端 close/error 时旧实现只
   `clearTimeout`，Promise 永不 settle ⇒ 子进程 `player.stop()`/`cast()` 永久挂起
   （现场 `airplay rpc 超时: cast (25000ms)`）。现在 close/error 一律 reject 并摘监听器。
2. **子进程收尾硬上限**：`AirplaySessionRuntime.stop()` 用 `STOP_DEADLINE_MS=4s`
   （`AIRPLAY_STOP_DEADLINE_MS` 可覆盖）包住 `player.stop()`；超时 `forceClose()`
   立刻关 socket/RTP 端口，保证 RPC 一定回包。
3. **追赶发包让出事件循环**：每追发 16 包 `setImmediate` 一次，避免微任务把子进程
   IPC/RTSP 响应饿死。
4. **fork 落位与 in-proc 对齐**：子进程 `cast`/`seek` 的偏移编进服务端回环流
   `?timeOffset=N`，`spawnDecoder(url, undefined)`，不对 live FLAC 做 `-ss`。
5. `airplay/mode.ts` 的 `defaultFork` 翻为 **true**；排障可 `MUSICFLOW_AIRPLAY_INPROC=1` 回落。

**真机回归（240 + HiVi H5MKII，fork 默认）**：起播 / seek 60 / 暂停→`/play` 恢复 /
音量 40（转发同 host DLNA）/ 停止 / 主卧→HiVi 流转 + reset 源端 / AP→DL→AP 快速往返，
设备 `getPlayerStatus` 全程 `play` 且 `curpos` 前进；无 `rpc 超时`、无 `RAOP connect 总超时`。
前端负载隔离实测（本地曲，24 并发请求 × 15s）：`chunks` 增量 2381（≈125.3/s），
`reanchors` / `maxGap` / `loss` 增量全部为 0。

**回归守卫**：`check-airplay-playback-chain.mjs` 新增 **R30**（默认 fork / close reject /
forceClose / 收尾上限 / fork 偏移 / 让出事件循环）；新增
`tests/services/airplaySessionRuntime.test.ts` 3 例（偏移、收尾超时、旧会话卡住时新 cast 仍完成）
与 `tests/airplay/raopTransport.test.ts` 1 例（连接关闭必须 reject）。
`tsc --noEmit` 0；AirPlay 相关 3 文件 134 例通过。

## [4.6.69] - 2026-10-22

### Fix / 4.6.68 CI 红:双协议互斥守卫「助手内冻结队列」失明

4.6.68 把 `yieldSiblingDlnaForAirPlay` 的冻结调用改成局部变量
`const qc = getQueueController(); … qc.stopPlayback(...)`，而
`scripts/check-airplay-dlna-mutex.mjs` 的 R1 用**字面字符串**
`getQueueController().stopPlayback(` 钉死「助手内确实冻结队列」⇒ 静态守卫判红
（`ci` 失败；`类型检查 + 全量测试` 本身通过）。

**修复**：快照仍从局部 `qc` 读（可容错），冻结调用恢复为
`getQueueController().stopPlayback(...)` 字面形态，并在代码里注明原因，避免
后续重构再次让守卫失明。

**验证**：`check-airplay-dlna-mutex.mjs` 与 `check-airplay-playback-chain.mjs`
双双全绿；`tests/airplay/controlOrchestration.test.ts` +
`tests/dlna/controlTransportGuards.test.ts` + `tests/airplay/mutex.test.ts`
共 154 例通过。

## [4.6.68] - 2026-10-22

### Fix / 4.6.67 CI 红:冻结 DLNA 队列被「读快照」提前打断

`yieldSiblingDlnaForAirPlay` 在冻结队列前先读 `qc.snapshot(...).isActive`（用于判断是否需要
等停稳）；`tests/airplay/controlOrchestration.test.ts` 的 QueueController 替身只提供
`stopPlayback`，缺 `snapshot` ⇒ 读快照抛 TypeError 被外层 catch 吞掉，`stopPlayback`
根本没执行，3 例断言失败（全量 7404 通过 / 3 失败）。

**修复**：
1. 快照读取单独 try/catch，`snapshot` 缺失/异常一律视为「未激活」，**不得阻断冻结**；
   `stopPlayback` 仍在 SOAP Stop 之前无条件执行（R25/R28 顺序不变）。
2. 测试替身补齐 `snapshot` 与 `getTransportState`，并新增两例：
   - DLNA 确实在播 → 顺序必须是「冻结 → 停 DLNA → 读停稳 → 建会话」；
   - DLNA 没在播 → 不读停稳状态（普通客户端起播不被额外等待拖慢）。
3. R29 守卫强化：host 取 `avTransportUrl`（`location` 可能缺失导致空串静默失效）、
   SOAP Stop 调用点常量断言（4 处，多一处直调即判红）、互斥让位 `stopDevicePlayback`
   必须保持无守卫。

**验证**：`tsc --noEmit` 0；AirPlay + DLNA 守卫 16 文件 / 349 例通过；回环守卫脚本全绿。

## [4.6.67] - 2026-10-22

### Fix / 主卧(DLNA)→HiVi(AirPlay) 流转后「进度在走但设备完全没声」

**根因**：客户端在流转完成后会立刻 `POST /peers/<源端>/reset` 收尾源端。源端是
「主卧」DLNA，而它与 HiVi AirPlay 是**同一台物理设备**（同 host 192.168.10.30）。
`reset → stopPlayback + stopDevice()` 会对设备下发 DLNA `Stop` —— Linkplay/HiVi 固件
的 DLNA Stop 会**连带停掉同一台设备的 AirPlay 输出**：设备 `getPlayerStatus` 立刻变
`stop`，而服务端 AirPlay 会话不知情，位置继续按墙钟前进 ⇒ 用户看到「队列和进度都
流转过来了，但一点声音都没有」；手动拖一下进度会重建会话，此时设备已处于停止态，
反而能出声。

240 现场（2026-10-22）逐秒取证：
```
16:31:09.947 RTSP RECORD 200 → AirPlay 会话建立
16:31:10.167 [DLNA][Stop] 发起（客户端 reset 源端，1.2s 后到达）
16:31:11.180 [ws][state] STOPPED
16:31:11+   服务端 AP=PLAYING pos 持续前进，设备 getPlayerStatus=stop/curpos=0
```

**修复**：
1. `airplay/control.ts` 新增 `hasActiveAirPlaySessionForHost(host)` —— 判定同 host 是否
   仍有活跃 AirPlay 推流会话（in-proc 看 `sessions`，fork 看子进程镜像，复用
   `hasActiveSession`）。
2. `dlna/control.ts` 的 `stopDevice()` 在下发 SOAP `Stop` **之前**做守卫：同 host 有活跃
   AirPlay 会话时**只做本地收尾**（事件态置 STOPPED），不再碰设备传输；判定失败按旧
   口径执行。`stopDevicePlayback()`（AirPlay 起播时的互斥让位）保持原样，确保互斥方向
   不受影响。
3. 同设备 DLNA→AirPlay 起播前新增「等 DLNA 报 STOPPED + 300ms 宽限」再建 RAOP 会话
   （`DLNA_SETTLE_MAX_MS=2500`，`dlna/control.ts` 新增轻量 `getTransportState()`），
   覆盖「SOAP Stop 已返回但固件还在切输入」的时间窗。

**真机验证（240 + HiVi H5MKII）**：直接起播 / seek / 暂停恢复 / 停止 / 主卧→HiVi 流转 +
客户端 reset 源端，全链路设备 `getPlayerStatus` 保持 `play` 且 `curpos` 持续前进；
日志出现 `DLNA][Stop] … 同 host AirPlay 会话在播 → 跳过设备 Stop(防误杀 AirPlay 输出)`。

**回归守卫**：`check-airplay-playback-chain.mjs` R28 增补「DLNA 停稳等待」，新增 **R29**
（反向互斥判定 / `stopDevice` 守卫 / 守卫必须先于 Stop 下发）；新增
`dlna/controlTransportGuards` 守卫用例与 `airplay/mutex` 边界用例（2 文件 22 例通过），
`tsc --noEmit` 0。

## [4.6.66] - 2026-10-22

### Fix / 主卧(DLNA)→HiVi(AirPlay) 流转:队列/进度都对，但设备不出声

**根因**：AirPlay 解码器把起播偏移用 `-ss N` 做**输入定位**，而输入是
`/rest/airplay/stream/:token` 的 **live FLAC 管线**（chunked、不可寻址）。`-ss` 会落在
编码帧中间，解码器拿到的是残帧。240 实测同一 token：
- `-ss 60` 只出 **72B**，stderr `[flac] invalid sync code / decode_frame() failed`；
- `-ss 200` 为 **0B**。
设备端表现正是「队列和进度都流转过来了，但一点声音都没有」；用户再拖一次进度
（重建会话）偶尔能响，取决于新落点是否恰好对齐帧边界。

**修复**：
1. `airplay/control.ts` 新增 `withPlaybackOffset()`：把起播偏移编进**服务端回环流**
   URL（`/rest/airplay/stream/:token?timeOffset=N`），由服务端管道在**可定位的源**
   （本地文件 / WebDAV Range / membuf）上做 `-ss`；解码器从 0 开始吃一条从头就正确的流。
   起播落位与原地 seek 两条路径都改用它，**解码器不再对 live FLAC 做 -ss**。
2. `/rest/airplay/stream`（`serveCastStream` 的 AirPlay 分支）：web 源 + `timeOffset>0`
   也先整曲缓冲 —— 插件直链不支持 Range，服务端 `-ss` 会直接 `Invalid data`（实测
   `timeOffset=60` 0 字节）；缓冲成 membuf 后可定位。DLNA 保持旧口径（seek 直通）。
3. 真机复测（240，主卧 DLNA → HiVi AirPlay）：解码命令已是
   `-i http://127.0.0.1:46400/rest/airplay/stream/<token>?timeOffset=4.158` 且**无 `-ss`**；
   AirPlay 状态 PLAYING、位置持续前进；同一首 web 曲在 `timeOffset=0/60/200/263`
   各出 3s PCM（529200B），不再有残帧错误。

**回归守卫**：`check-airplay-playback-chain.mjs` 新增 **R28**（偏移走 feed URL / 原地 seek
重编 URL / web 源 seek 整曲缓冲），并同步更新原「spawnDecoder(feedUrl, seekSec)」断言；
AirPlay 相关 5 文件 62 例通过、`tsc` 0。

## [4.6.65] - 2026-10-21

### Fix / 4.6.64 CI 红:DLNA 渲染器 manifest 契约仍断言「零配置」

4.6.64 给 `dlna-renderer` 的 `configSchema` 加了「大文件直通」开关，`tests/plugins/renderersPlugin.test.ts` 仍断言 `configSchema === []`，全量测试 1 例失败（其余 7404 例通过；`build-and-push` 因 `ci` 失败未发布）。

- 测试改为断言「configSchema 仅一个 `switch` 字段 `largeFileDirect`，默认 `false`」；
- 无运行时改动，功能与 4.6.64 一致。

## [4.6.64] - 2026-10-21

### Fix / 默认全缓冲 + 播放路径补完整性判官 + DLNA 插件「大文件直通」开关

4.6.63 把「大文件直通」做成了默认 20MB 生效。复核后按用户拍板调整为：

- **默认改为全部整曲缓冲**：`STREAM_BUFFER_SKIP_OVER_MB` 保留 20（建议阈值），但默认不生效（阈值 0）。覆盖范围 0~100MB 网络源；>100MB 的整轨镜像仍受 `fetchWholeSongBuffered` 的 100MB 硬顶保护、照旧直通（预取也不会抓）。
- **播放路径复用预取判官**：整曲缓冲成功后、登记 membuf 前调用 `judgePrefetchedBuffer`（与预取同一套判据）：
  - `preview`（实际时长比曲库短 >15s）/ `not-audio`（HTML/JSON 错误页）⇒ `markUnplayable` + 显式失败（客户端跳下一首）；
  - `too-small`（<64KB）是弱信号（240 实测同曲随后 1.93MB 成功）⇒ 不判死、不写负缓存，回退直通，避免播放路径没有重试/换源兜底时误跳歌；
  - 判官总开关沿用「媒体获取」页的 `prefetch.settings.integrityEnabled`。
- **DLNA 插件详情弹窗新增开关**：`dlna-renderer` 的 `configSchema` 加 `largeFileDirect`（`switch`，默认 `false`，帮助文案说明"仅 DLNA、开启后 >20MB 直通、会错过完整性判定"）。前端插件详情弹窗由 `configSchema` 驱动，**零前端改动**；配置走现有 `PUT /v1/plugins/:id`。
- **作用域严格限定 DLNA**：`resolveTranscodeInput` 新增 `largeFileDirect` 入参，只有 `serveCastStream(kind="dlna")` 传 `true`；HTTP `/rest/stream` 与 AirPlay 始终全缓冲（即便运维 env 给了阈值也不生效）。
- **240 运行时关闭 FLOW 连续流**（`crossfade.mode=disabled`）：换取逐首管道 —— 每首歌都整曲缓冲 + 判官、设备元数据/队列下标准确；失去 1s 交叉淡入，歌间有小接缝。

### 真机复测（240 主卧 DLNA）

- **关闭 FLOW 后逐首管道**：40s 曲 ×3，`currentIndex` 0→1→2，每首独立 cast、全程 PLAYING；歌间有数秒重新投屏接缝（用户已接受，换取完整判定与准确元数据）。
- **默认全缓冲**：88MB WebDAV 曲先尝试整曲缓冲，但 88MB@3.3MB/s 无法在 8s 有界等待内完成 ⇒ 投影早退（1.5s）后回退直通；**插件开关打开后立即直通**（日志 `已知 83.9MB > 20MB 阈值`），关闭后恢复全缓冲。
- **播放路径判官**：网易《琵琶曲》上游本次返回 <64KB（too-small 弱信号）⇒ 按设计回退直通、不记负缓存；`preview`/`not-audio` 判死由单测覆盖。
- **插件配置下发**：`GET /v1/plugins` 的 `configSchema` 已含 `largeFileDirect`（switch，默认 false），插件详情弹窗可直接开关、保存后即时生效。

### 仍待处理/边界

- 默认全缓冲只对「能在 8s 内缓冲完」的 0~100MB 文件保证播放前判官；更大/更慢的文件仍会在投影早退后直通，判官只能靠后台预取（≤100MB）完成。>100MB 的整轨镜像不整曲缓冲、预取也不抓。
- FLOW 关闭是 240 的运行时设置（`crossfade.mode=disabled`），不是代码强制；以后在音频页重新开启 crossfade 会恢复 flow（并失去逐首判官覆盖）。

### 回归守卫/测试

- `check-airplay-playback-chain.mjs` **R27** 更新：默认关闭 + DLNA 开关/链路双条件 + 插件 `configSchema` 开关 + 播放路径判官（preview/not-audio 判死、too-small 直通）。
- `tests/source/bufferHeadWait.test.ts` 新增 (d)(e)(f)(g)(h)：DLNA 开关生效、HTTP 链路不受 env 影响、preview 判死、not-audio 判死、too-small 直通不记负缓存；`tsc` 0。

## [4.6.63] - 2026-10-21

### Fix / 240「一直跳下一首」真正根因:flow 起播前逐首解析整条队列(首字节 12~400s)

4.6.62 的熔断只是止损;本次按用户拍板的三条方案定位到**服务端首字节被自己拖住**:

- **现场抓包**:用设备同款 UA(`NSPlayer/4.1.0.3856`)拉 `/rest/dlna/stream/:token`,**12s 内一个响应头都没有**;容器内 `startFlowSession` 前日志刷出几十条 `播放优选`(web 行逐个做 WebDAV 探测/换链)。
- **根因**:`serveFlowQueue` 在起播前 `for` 循环解析**全部候选**(`FLOW_MAX_ITEMS=200`),每首都要 `resolvePreferredSong`(实测 20s 级)+ `resolveTranscodeInput`(插件换链)。设备 25s 等不到 PLAYING 就重投 → 新会话再从第一首解析 → 会话/转码槽越堆越多,最终 `/status` 8~12s、HA 与客户端超时(用户观感「240 崩溃/连不上」)。**不是固件侧问题**,同一首预取命中也会被这条阻塞挡住。

### 三条方案落地

1. **flow 懒解析 + 起播预热**:只有第一首同步解析(必须成功,否则回退单曲管道);前 3 首并行预热(不阻塞首字节);其余曲目在上一首播放期间按需解析,失败跳过并**先吐出上一曲扣住的过渡尾段**(不静默丢音频)。
2. **大文件跳过整曲缓冲**:已知总字节 > `STREAM_BUFFER_SKIP_OVER_MB`(默认 20MB,env 可调,0=关闭)直接直通;上游一报出 `Content-Length` 超阈值也立即直通 —— 不再先浪费 1.5~8s 等「投影早退」。预取命中路径不受影响(第 ① 步就命中了)。
3. **正/负缓存口径修正**:整曲字节完整拿到 = 可播硬证据 ⇒ 主动失效该曲负缓存(预取成功 + 播放链路 + 本地直读三处);预取遇 `too-small` **不再判死** —— 先换同曲其他源、全失败后再重试一次,重试仍过小也**不写负缓存**(弱信号;240 实测同一首随后播放整曲缓冲 1.93MB 成功),真死假死交给播放侧 probe(404/403 才是硬证据)。一次上游截断不再让队列把整首歌判跳。
4. **flow 连续流实时节流**(复测中新发现):编码器此前以远超实时的速度把整条队列推进 HTTP 流,DLNA 固件贪婪读 ⇒ 真机 27s 时队列已到第 2 首(第 1 首 236s),界面看起来「一直跳下一首」。现按「已发音频秒数 − 墙钟」做背压,只允许领先 `FLOW_REALTIME_LEAD_SEC`(默认 5s,env 可调,0=关闭);解码慢于实时时不额外等待。

### 真机复测(240 主卧 DLNA)

- 20 首混合队列(琵琶曲/老男孩/Letting Go/idle 等历史卡死曲):`queue/play` 1.3s 返回,**3s 内 `PLAYING`**,进度持续前进(修复前永远 `TRANSITIONING/BUFFERING`,25s 一跳)。
- 本地 40s 曲 x3 连续队列:两次自然过渡分别发生在 **36.6s / 77.0s**(40s 曲长 + 1s 过渡),`currentIndex` 0→1→2,全程 `PLAYING`、无 stalled —— 节流后队列下标与实际播放对齐(误差 ≈ 过渡窗口)。
- 5 分钟浸泡:全程 `PLAYING`、`bad=[]`,**`/status` 最慢 12ms**(修复前 8~12s),无「卡死」熔断日志、无 `flow 曲目不可用` 刷屏。

### 回归守卫/测试

- `check-airplay-playback-chain.mjs` 新增 **R27**(首曲同步 + 其余懒解析 + 前 3 预热 + 实时节流 + 跳过先吐 carry + 大文件阈值 + too-small 重试不写负缓存 + 负缓存失效)。
- 新增 `tests/services/flowLazyResolve.test.ts`(懒解析只解析一次/失败跳过仍保留上曲尾段/解析异常不断流);`tests/source/bufferHeadWait.test.ts` 补大文件直通与阈值开关两例;`tests/source/bufferProjection.test.ts` 显式关闭阈值(只测投影);`tsc` 0、相关 3 文件 84 例 + flow 12 例通过。

## [4.6.62] - 2026-10-21

### Fix / 240「一直跳下一首 / HA 卡片与客户端连不上」:慢源连跳熔断 + DLNA 起播窗口

现场：容器**没有退出**（`RestartCount=0`、`OOMKilled=false`），但主卧整段队列的网络源歌曲不可播：每首 cast 后设备停在 `TRANSITIONING`，5s 乐观窗口判 stalled → 重投 → 第 2 次判卡死 → 切下一首，一路跳过 20+ 首。每首都要 `judgePlayable`（10s 上限）+ `resolvePreferredSong`（实测 20s）+ 整曲缓冲，事件循环被拖到 `/status` 8~12s，HA 卡片与客户端全部超时（用户观感 =「容器崩溃、连不上」）。

- **DLNA 起播窗口 5s → 25s**（AirPlay/Sendspin 仍 5s）：投给音箱的是「整曲缓冲后回环」的实时流，网络源/大文件首字节实测 10~20s；5s 会在每次起播都判 stalled，把整队推着走。
- **跨曲连跳熔断**：连续 3 首「卡死→放行切歌」即停止队列（`isActive=false` + `ended=true` + 停设备），不再把整圈走完；确认 PLAYING 时清零计数。
- **真机复测**（240，主卧 idx 69 起）：3 首后输出「连续 3 首卡死,停止推进」，队列停止推进；全程 `/rest/ping` 1~5ms（一次重解析瞬时 4.5s），HA/客户端不再整体超时。
- **回归守卫/测试**：`check-airplay-playback-chain.mjs` 新增 **R26**（DLNA 25s 窗口 + 熔断三要素）；`PlayerController` 新增 DLNA 25s 用例，`queueStall` 新增「连续 3 首卡死即停队列」用例；相关 3 文件 28 例通过、`tsc` 0。
- **仍待处理**：该段队列中的网络源歌曲本身首字节 15s+ 且设备停在 TRANSITIONING（本地核心源不可用 → 回退 web 源），属于源/设备侧问题；熔断保证它不再拖垮服务。

## [4.6.61] - 2026-10-21

### Fix / 主卧(DLNA)播放卡顿反复切歌 + 同一台设备 AirPlay↔DLNA 队列流转

用户升级到 4.6.60 后反馈主卧(DLNA,与 HiVi 同一台设备)播放异常。现场定位到两条相互放大的缺陷:

**① flow 连续流会话不随客户端断开而中止 → 转码槽泄漏(卡顿主因)**

`serveFlowQueue` 只监听 `c.req.raw.signal`,没有像单曲管道那样用 `killOnCancel` 绑定响应取消。DLNA 设备快速切歌后旧 HTTP 请求虽已断开,会话仍在等 flow 转码槽:现场 38 个 ffmpeg、`kind=flow limit=8 queue=22`、出流首字节 150~330s,设备因等不到数据反复 `TRANSITIONING` → 5s 乐观窗口判 stalled → 连卡 2 次放行切歌 → 再产生新会话,形成「越切越卡」的正反馈。

- flow 响应流改为 `killOnCancel(toWeb(session.stream), () => session.abort())`,下游取消即中止会话、释放解码器槽;
- 新增每设备 `activeFlowAborts` 单会话约束:新会话接管时先中止旧的(部分固件切 URI 后旧连接迟迟不关,只靠 cancel 不够)。
- 真机复测:mock DLNA 连续 8 次 next 后 `ffmpeg=2`、转码排队 0、仍 `PLAYING pos=6`(修复前 38/22 且持续卡死)。

**② 同设备双协议流转:落点丢失与互斥反杀**

HiVi(AirPlay)与主卧(DLNA)是同一台设备的两个 peer,流转时目标端起播的互斥会立刻停掉源端,原实现的两处问题导致「转到主卧后从头播 / 0 秒不出声」:

- 流转路由:新增 `isSamePhysicalDevice`(AirPlay host == DLNA location host);**同设备流转的源端进度在任何起播/互斥动作之前定格**(`srcPosEarly`),DLNA 目标也走「起播即落位」;跨设备仍保持原口径。
- DLNA `playMedia` 此前**忽略 startMs**(`_startMs`),流转只能从 0 秒拉流;现按 `timeOffset=N` 编进流 URL,并把设备位置基线初始化为该偏移(设备不报 RelTime 时进度条不再从 0 重爬)。
- 反向互斥(`stopAirPlaySessionsForHost`)补上**先冻结 AirPlay 队列、再停会话**:只停会话时设备回 IDLE 会被 AirPlay 端判成自然结束 → advance → 重新 cast,把刚建立的 DLNA 会话反杀(真机:主卧一直 0 秒,HiVi 又播起来)。
- **真机双向验收**:主卧播到 12.6s → 流转 HiVi 从 13.0s 继续(队列 295/idx 33 不变);HiVi 播到 16.95s → 流转回主卧,设备拉 `?timeOffset=17` 并从 17.0s 播到 25.9s,AirPlay 侧 `STOPPED` 不再反抢。
- **回归守卫**:`check-airplay-playback-chain.mjs` 新增 **R25**(同设备识别/落点定格/DLNA timeOffset/基线偏移/冻结后再停/flow 取消与单会话),并同步更新「transfer 到 AirPlay 落位」的旧断言;`tsc` 0、流转+互斥相关 5 文件 270 例通过。

## [4.6.60] - 2026-10-21

### Fix / 4.6.59 的 CI 红:在线删除用 CONFLICT 而非 INVALID_PARAM 配 409

4.6.59 的 `DELETE /v1/sendspin/devices/:clientId` 在「设备在线」分支写了 `apiError(BusinessErrorCode.INVALID_PARAM, …), 409`,与 D10 源码守卫「一个 code 只对应一个状态码」冲突(INVALID_PARAM=400),`ci` 与 `build-and-push` 因此报红(527 个测试文件中仅 `tests/routes/apiErrorStatus.test.ts` 1 例失败,7394 例通过)。

- 改用 `BusinessErrorCode.CONFLICT`(映射 409),响应仍是「设备当前在线,不能删除…」,对外行为不变(真机实测 409)。
- 复跑:`apiErrorStatus`、`deleteOfflineDevice`、`tsc`、`vue-tsc`、i18n 守卫全绿。

## [4.6.59] - 2026-10-21

### Feat / 离线的 Sendspin 播放器可在前端手动删除

Sendspin 设备断连后按「离线只置位、不摘行」的既有口径一直留在列表里(与 DLNA / AirPlay 一致),但离线行只提供「恢复 / 重连 / 解绑」—— 一台不再使用、又没有配对记录或拨号目标的设备没有入口移除,列表会越积越长。本次补上「删除」:

- **前端**(群组页 → Sendspin 设备区):离线行新增「删除」按钮(需 `renderer.manage`),二次确认气泡说明后果(设备档案、配对记录、改名/隐藏偏好、播放队列、群组成员一并清除,下次需重新发现/配对)。删除成功后刷新设备列表与群组列表。在线行不提供该入口。
- **后端** `DELETE /v1/sendspin/devices/:clientId`(RENDERER_MANAGE):
  - **在线设备一律拒绝(409)** —— 删除不可撤销,设备正在播放时用户应先禁用/断开再删;判据取 main 进程 peer 行的 `available`(fork 模式下子进程注册/断连会同步到主进程);
  - 离线设备:清持久档案(`sendspin_device_state`:音量/静音/禁用/6053 密钥与端口)、配对记录、所有用户的改名/隐藏偏好、播放队列、群组成员关系、peer 占位行;
  - 按 `last_host` 遗忘「记住的拨号目标」—— 否则自动发现下一轮又会把同一台设备拨回来,用户会觉得「删不掉」;
  - 未知设备返回 404(幂等,不凭空删除)。
- **与相邻语义的边界**(代码注释与用例均已钉死):禁用 = 行保留可恢复;解绑 = 设备在线、只清配置、连接与行都保留;删除 = 离线、连同行与拨号记忆一起移除。
- **回归守卫/测试**:新增 `tests/sendspin/deleteOfflineDevice.test.ts` 4 例(在线拒绝且档案不变 / 离线彻底清除含拨号记忆 / 已禁用可删 / 未知 404);`deviceState` 新增 `getDeviceLastHost`;`tsc` 0、相关 5 文件 113 例通过、前端 `vue-tsc` 0、i18n 守卫通过。
- **真机验收(240 热更 + 浏览器)**:构造离线档案 `DELETE-API-TEST` / `DELETE-UI-TEST` → API 删除 200 且行消失、重复删 404、在线 `es客厅` 409、未知 404;网页端在群组页离线行点「删除」弹确认气泡 → 确认后行消失,刷新不再出现;`es客厅` 全程在线、音量 38 不受影响。

## [4.6.58] - 2026-10-21

### Fix / Sendspin 暂停中拖进度会变成「开始播放」(230 模拟播放器 + es客厅真机全量验收)

按 AirPlay 的双端对账方法对 Sendspin 链路做全量验收(230 主机三台模拟播放器:SDK-PCM / SDK-FLAC / sendspin-cpp,加真实设备 `es客厅`),过程中定位到一个真实缺陷:

- **根因**:`seekCore` 在暂停态收到 seek 时,`GroupPump.seek()` 内部为了让旧循环锚定新位置会先 `if (paused) resume()`,紧随其后走完整起播路径的 `playCore()` 又新建一个未暂停的泵 —— **两条路都会把「暂停中拖进度」变成「开始播放」**,与「拖动只改位置、暂停态不变」的用户语义以及 DLNA / AirPlay 的既有行为都不一致。真机四端(PCM / FLAC / C++ / es客厅)全部可复现。
- **修复**:`seekCore` 先快照 `wasPaused = !!g.paused`,在**三个返回点**(无在播曲 / 起播窗口内 / 重建流之后)分别补回 `pauseCore`;重建流日志追加 `(保持暂停)` 标记,便于真机排障。位置落点仍走原有重建流路径,`clamp` 语义不变。
- **回归守卫**:`sendspin-guard.yml` 新增 **P4** —— `wasPaused` 快照必须存在、`if (wasPaused) pauseCore(srv, clientId);` 计数 ≥3(三个返回点漏一处即静默回退)、日志标记在位;`tests/sendspin/playerCoreUnits.test.ts` 新增「暂停中 seek → 重建流后仍保持暂停」1 例。
- **真机全量验收(50 例)**:起播 / 暂停 / 恢复 / seek / 连续快速 seek / 暂停中 seek→恢复 / next / prev / 音量 / 静音 / 自然结束自动下一首 / 停止,在 **PCM、FLAC、C++、es客厅** 四端全部 PASS;组播(es客厅 + PCM + FLAC + C++,seek 后成员进度 spread=0)同一套用例全 PASS。唯一一次 `PCM seek` 报 FAIL,经逐秒采样复测确认是测量窗口造成的假阴性(seek 后首秒写入 13.80s、随后稳定 1.00s/s,position 1:1 前进),不是产品问题。
- **验证环境**:230 模拟播放器经 `ws://192.168.10.240:38927/sendspin` 接入;判据为服务端 `/status` + `/queue` 双端对账,SDK 端另加 PCM 字节增量(192000 B/s)与 RMS(> -60dB);C++ 的 ALSA file 插件持续写/截断文件,只认状态+进度。

## [4.6.57] - 2026-10-21

### Revert / 移除「启动 120s 内忽略第一笔音量」的兜底(用户否决)

4.6.56 为兜住未升级 HA 集成时的音量回放,曾按「启动窗口 + HA UA + 每 peer 第一笔」静默丢弃音量/静音请求。用户明确否决:静默丢弃**合法 API 请求**不合理 —— 用户在容器重启后任何时刻通过 HA 调音量都必须生效;按 UA 匹配也脆弱(HA 版本变化、其它工具复用 UA 都会误判)。

- **移除**:`services/player/bootVolumeGuard.ts` 及其单测、`peers.ts` 里的两处守卫调用;`check-airplay-playback-chain.mjs` 的 R24 改为断言「不存在按来源/时间窗丢弃请求的逻辑」。
- **保留**:音量/静音写入口径统一(五个 kind 分支只解析一次 body)与永久观测日志 `[peer-volume] <peer> <- <值> ua=<UA>`、`[peer-mute] …` —— 这两项与拦截无关,是排障刚需。
- **正确修复仍在**:服务端 `airplay_device_state` 设置即落库、读取用持久值播种;HA 集成 v2.1.2 的实体剪枝恢复窗口(需重启 HA / 重载集成才生效,否则日志里仍会出现 `ua=HomeAssistant` 推 20)。
- **验证口径**:设一个非 20 的音量 → 重启容器 → AirPlay 状态、同 host DLNA 设备实测音量、DB 三者保持一致。

## [4.6.56] - 2026-10-21

### Fix / 重启后音量仍被回放成 20:服务端补「启动期 HA 回放」守卫

用户升级 4.6.55 镜像后重启容器,音量仍回到 20。现场证据:容器 `StartedAt=07:10:21Z`,`airplay_device_state` 行在 `07:10:52Z` 被写成 20 —— 服务端自身不在启动时写音量,这笔写入来自外部;临时探针抓到 UA = `HomeAssistant/2026.10.2 aiohttp/3.14.5`。即:HA 集成未升级(仍会剪实体并回放旧 `volume_level`),回放发生在服务端落库之后,把持久值覆盖成 20。

- **写入口径统一**:`POST /v1/peers/:peerId/volume` 的五个分支(dlna/group/airplay/sendspin/local)此前各解析一次 body,全局策略无法统一注入;现改为**一次解析 + 一条永久观测日志**(`[peer-volume] <peer> <- <值> ua=<UA>`)。
- **启动期回放守卫**(`services/player/bootVolumeGuard.ts`):进程启动 120s 内、UA 以 `HomeAssistant/` 开头、且该 peer 的 volume/mute **第一笔**写入 → 忽略并回 200(仅记 warn),避免 HA 实体重建回放覆盖持久音量;之后的写入(用户主动调)照常生效,非 HA 客户端不受影响。静音路由同款守卫(`[peer-mute]`)。
- **为什么不用「值 == 20/80」判定**:值本身没有语义(用户可能就是想设 20);「HA UA + 启动窗口 + 每 peer 第一笔」才是实体回放的稳定特征。
- **回归守卫/测试**:播放链路守卫扩到 **R24**;新增 `bootVolumeGuard` 6 例(窗口边界 / 非 HA / 每 peer 独立 / volume 与 mute 互不消耗 / UA 前缀);`tsc` 0。
- **配套**:HA 集成 `hass-musicflow` v2.1.2 的实体剪枝恢复窗口仍是根治项 —— 升级后 HA 不再回放,服务端守卫是未升级期间的兜底。

## [4.6.55] - 2026-10-21

### Fix / 4.6.54 的 CI 红:插件 manifest 用例仍按「AirPlay 默认关闭」断言

`tests/plugins/renderersPlugin.test.ts` 的用例把 `defaultEnabled === false` 当成契约,而 4.6.54 已按用户要求改为默认开启,`ci` 与 `build-and-push` 的全量测试门禁因此报红(526 文件中仅此 1 例失败)。

- 用例改为断言 `defaultEnabled === true`,并补充「不存在 toggleable 之类的不可关闭标记」——默认开启 ≠ 不可手动关闭:插件页开关、`PUT /v1/plugins/:id/toggle` 的启停联动均保持不变。
- 复跑:`renderersPlugin`、播放链路守卫(R1~R23)、`tsc`、相关文件全绿。

## [4.6.54] - 2026-10-21

### Feat / AirPlay 插件默认开启 + 音量/静音持久化(重启保留设备自身音量)

用户反馈:容器重启后播放器音量被强制成 20。240 现场加临时探针定位到两条叠加链路:

- **服务端**:AirPlay 的 `volumeState` 只在进程内存,重启后读取点回落到写死缺省(80),任何客户端都能用缺省值覆盖设备自身音量。修复:新增 `airplay_device_state` 表,`setAirPlayVolume` / `setAirPlayMuted` **设置即落库**(先落库再下发,下发失败也不丢设置),`getAirPlayStatus` 无内存值时用持久值播种(无行才用缺省 80);永久删除设备时一并清行。停用插件保持「内存清空 = 缺省值」的旧语义,库值保留供重新启用后恢复。
- **HA 集成**:后端重启时 `/v1/peers` 瞬时缺 peer → 集成立刻剪掉 HA 实体 → peer 回归后实体重建,HA 在实体注册时回放旧 `volume_level`。真机现场 UA 为 `HomeAssistant/2026.10.2 aiohttp/3.14.5`。修复在独立仓库 `hass-musicflow` v2.1.2:实体剪枝加 **120s 恢复窗口**,窗口内不剪、后端不可达时整轮不剪;真正删除的 peer 过窗口仍会剪掉。
- **插件默认开启(仍可手动关闭)**:`airplay-renderer` manifest 的 `defaultEnabled` 由 false 改为 true(新装实例开箱可用);插件管理页的开关保持不变,`PUT /v1/plugins/:id/toggle` 关 → 停会话/停 mDNS/注销 player,开 → 起发现与监听;已存在的插件行保留用户当前开关。默认值只是初始状态,不影响手动关闭能力。停用后 discovery / 子进程 / 设备注册全部回收,零常驻资源。
- **回归守卫/测试**:`check-airplay-playback-chain.mjs` 扩到 **R19~R23**(插件默认开启与停用零残留、两处 RTSP 请求行必须带 `RTSP/1.0`、音量 dB 端点与同 host DLNA 转发、独立取流路由与同 (song,device) token 复用、重启恢复走统一起播路径、设备闸排队可观测、音量落库与持久值播种、**默认开启仍保留手动关闭开关**);新增 `airplay_device_state` 5 例 + 控制层「重启播种」1 例;后端 `tsc` 0、守卫全绿、相关 18 文件 359 例通过;HA 集成全量 293 例通过(覆盖率 97.91%)。
- **部署**:服务端已热更到 240 并重启验证(`RestartCount=0`);HA 集成需更新到 v2.1.2 后,容器重启才完全不再回推音量。

## [4.6.53] - 2026-10-21

### Fix / 4.6.52 的 CI 红:互斥硬上限不改变两个起播入口的调用形态

4.6.52 把「互斥 DLNA 让位」包了一层 `withDeadline(...)`,导致 `check-airplay-dlna-mutex.mjs` 的 R2「两个起播入口各调用一次 `await yieldSiblingDlnaForAirPlay(opts.deviceId)`」计数从 2 变成 1,`ci` 作业因此报红(其余 11 个 workflow 全绿)。

- 修法:把硬上限**移进助手内部**(只包住 `stopDevicePlayback`),in-proc / fork 两个起播入口仍保持原来的直调形态;`R18` 守卫同步改为断言 `withDeadline(stopDevicePlayback`。
- 复跑:互斥守卫、播放链路守卫(R1~R18)、`tsc`、相关 4 文件 150 例全绿;真机单次流转 556ms、落点 3.465s、`PLAYING` 正常前进(行为与 4.6.52 一致,仅调用形态回归守卫约定)。

## [4.6.52] - 2026-10-21

### Fix / HiVi 流转接续失败:起播即落位 + 建会话硬预算(真机实测)

用户实测反馈:拖拽跳转正常,但**流转播放接续经常失败**(HiVi H5MKII,Linkplay 双协议设备)。240 现场日志 + 230 真机复现,定位到三层独立缺陷:

- **① 一次流转会在同一台设备上连开 2~3 条 RTSP 会话**:`transfer` 原本「先 cast、再 seek」,而 AirPlay 的 seek 是**完整重建会话**。HiVi 只认一条会话:第 3 次握手的 `ANNOUNCE/SETUP` 都回 200,`RECORD` 永久不答 → cast 卡满 30s。修复:transfer 到 AirPlay 时把源端进度作为 `playMedia(item, baseUrl, startMs)` 交给**这一次** cast(`seekSec`),不再补 seek;`playFrom` → `playCurrent` → `UniversalPlayer` 全链路透传落点,DLNA/Sendspin/组忽略该参数(行为零变化)。实测单会话 `seek=1.924s` 起播,transfer 1.3~4.0s。
- **② cast 30s 超时的兜底回调在 `setTimeout` 里 `throw`** → **未捕获异常直接杀掉后端进程**(240 容器 RestartCount 持续增长,期间 API `connection refused`,所有设备播放同时中断)。修复:兜底返回 `null`、再在 async 函数内抛错进入既有失败分支;同时 best-effort `player.stop()` 回收半开会话(避免幽灵会话继续占住设备闸)。
- **③ 建会话各步没有总预算**:`bindUdp` 无超时、三步 RTSP 各 10s、`TEARDOWN` 也 10s、互斥 DLNA 让位无上限 —— 任一步挂住都会长期占住 per-device 闸,后续所有流转排队等待。修复:握手总预算 8s(单步按剩余预算收缩,下限 1.5s)、`TEARDOWN/FLUSH` 2.5s、`connect()` 总预算 12s(覆盖 bindUdp/TCP/握手三步)、互斥 DLNA 6s / 旧会话收尾 4s 硬上限;超时快速失败交给既有重投通道。
- **可观测性**:新增 `[AirPlay][cast] 开始建会话`、`互斥:开始`、`RTSP ANNOUNCE|SETUP|RECORD ×ms`、`AirPlay 起播分段耗时(互斥DLNA / 旧会话TEARDOWN / RAOP握手)` 与设备闸排队日志 —— 下次现场一眼看出是哪一步慢。
- **真机验证(230 → 240,HiVi H5MKII)**:DLNA 通道在播 → 流转到 AirPlay 连续 **10/10 成功**(单次 1.6~4.0s),`PLAYING` 且 position 按 1:1 前进;`RTSP RECORD` 全部 200、握手 ~400ms;容器 RestartCount 保持 0(修复前同一场景每次 30s 超时并伴随进程崩溃)。
- **测试/守卫**:`check-airplay-playback-chain.mjs` 扩到 **R1~R18**(R18:cast 超时不得抛到定时器 / 超时回收会话 / 落点全链路透传 / 握手与 connect 预算 / 清理步骤硬上限);新增 `castTimeoutGuard`(超时不杀进程 + 落点透传)、`airplayProtocolPlayer`(`seekSec` 仅 `startMs>0` 时下发)、`raopPure`(`rtspTimeoutFor` 预算收缩)用例;相关 6 文件 251 例全绿。

## [4.6.51] - 2026-10-21

### Chore / 依赖安全升级(修复 security 工作流的 npm audit 硬门禁)

4.6.50 发版后 `security` 工作流在 `npm audit --audit-level=high` 处红:两条生产依赖命中当日 advisory。仅升级依赖,不改业务逻辑。

- **backend `music-metadata` `^11.14.0 → ^11.16.1`**:11.15.0 及以下命中 3 条 moderate(解析畸形文件可致 DoS);升到 11.16.1 仍属同一 major,`parseFile`/`parseBuffer` 调用零改动。
- **backend `vite` `^7.0.0 → ^7.3.7`**(构建/测试工具,不进镜像):7.0.0~7.3.6 命中 3 条 high(`launch-editor` 相关);7.3.7 为 7.x 线内最新修复版,避免跨 8.x 与 `vitest@5.0.3` 的 peer 范围(`^6.4.0 || ^7.0.0 || ^8.0.0`)边界风险。
- **frontend `vite` `^7.3.6 → ^7.3.7`**:同一条 high advisory 的前端命中。
- **frontend `follow-redirects` 锁文件 `1.16.0 → 1.16.1`**(axios 传递依赖):修复跨源重定向时 credential 剥离失效(GHSA-q3jh-wrc6-jgq8,high)。
- **行为变化(读标签更准)**:`music-metadata` 11.16 起把 FLAC 的 `DESCRIPTION`(ffmpeg 写 `comment=` 的落点)映射进 `common.comment`;11.14 读不到、只能得空串。这不是我们的分支逻辑,而是上游修了映射,效果是「下载后写入的 comment 现在能回读」。`sourceScannerMeta` 的字段全量映射用例同步改成断言原值 `A comment`,并在注释里写明版本依据;标签写入/回读链路的 `tagWriter`、`orchestrator.gaps` 用例复跑全绿。
- **复核**:`cd backend && npm audit --audit-level=high` 与 `cd frontend && npm audit --audit-level=high`(官方 registry)均 `found 0 vulnerabilities`;后端 32 个守卫脚本全通过、`tsc --noEmit` 与前端 `vue-tsc --noEmit` 零错、后端全量 `vitest`(524 文件 / 7376 用例)全绿。

## [4.6.50] - 2026-10-21

### Fix / 230 双端实测暴露的四处状态不一致(离线端清不掉、状态词表、mDNS 主机、DLNA 陈旧事件)

验收口径改为「**服务端与播放器两侧实际数据必须对得上**」:230 测试床上跑真实接收端(2× Apple-ALAC 解码的 shairport-sync、Sendspin PCM/FLAC SDK 播放器、sendspin-cpp 宿主、真实拉流的 DLNA mock),每条操作同时校验服务端 `state/position` 与播放器侧真实 PCM 能量 / 拉流字节 / relTime。

- **① `/stop`、`/reset` 对离线播放端回 500 并跳过清队列**:离线设备(播放器未注册)的 `isActive` 队列因此常驻内存,被 tracker / preProbe 每秒推进(实测 `idle_early` 625 次),并干扰同 host 在线设备。改为「本地停止状态先落 → 设备停传输 best-effort → 队列始终 `clear`」,响应 `{success:true, transportError?}`。实测 11 台离线端 reset 全部 200,复核无残留。
- **② 对外状态词表不统一**:AirPlay 回 `PAUSED / IDLE`、组回 `PAUSED`,而客户端 `peer.dart` 只认 `PLAYING / PAUSED_PLAYBACK / TRANSITIONING`(暂停会被显示成未播放)。在 `/v1/peers/:peerId/status` 出口统一归一(拷贝后再改,不污染共享对象)。
- **③ mDNS 记录只有 `.local` 主机名、没有 A 记录时被当成可路由 host**:投播直接 `getaddrinfo ENOTFOUND`(容器内无 mDNS 解析),设备却显示在线。discovery 新增 `hostname → IPv4` 旁路表:同主机任一记录给出的 IP 可回填;拿不到可路由地址的设备**不登记**。实测 AP2 从必失败 → 正常出声(RMS -22 dB)。
- **④ DLNA `/status` 被陈旧 GENA 覆盖**:上次 Stop 写进事件缓存的 `STOPPED` 会盖掉刚读到的 SOAP `PLAYING`(表现为「设备在播、接口说已停」)。加 15s 新鲜度闸;`castToDevice` 成功后同步事件缓存 `PLAYING`。
- **测试/守卫**:`check-airplay-playback-chain.mjs` 扩到 **R1~R17**(R14 离线 stop/reset 容错、R15 状态词表归一(含组)、R16 mDNS 无 A 记录、R17 DLNA 陈旧事件);新增 `peerReset`(离线 cast 端 reset)、`peersRoutesContract`(stop best-effort、PAUSED/IDLE 归一、组归一、陈旧 GENA 不覆盖)、`discovery`(主机名回填/不登记)用例;`vitest` 133 + 127 + 21 全绿,反向变异判红。
- **双端验证结果**:85 项操作(6 端 30 组有序流转 + DLNA 专属 14 组、前/后/归零/近尾拖动、5×250ms 连发 seek、暂停/恢复/停止、音量/静音、近结尾自动续播、分组同步)全部通过;其中 2 项首轮受一次外部容器重启影响,隔离复测后 **85/85**。播放器侧证据:AirPlay RMS −17…−33 dB、Sendspin 字节增量 1:1 实时、C++ 宿主 RMS −22…−30 dB、DLNA mock `relTime` 与服务端 `position` 差 < 0.6s(seek 后 mock `offset` 等于目标秒数)。

## [4.6.49] - 2026-10-21

### Fix / AirPlay 一直卡在同一首歌:客户端「流转播放 + 拖动进度」并发建会话（根因修复）

用户实测:在客户端里**流转播放**的同时**拖动进度**,AirPlay 端(HiVi H5MKII)会彻底卡住 —— 一直重复同一首、点别的歌/切歌接口回 `{"success":true}` 但完全没有动作,直到重启容器。日志确认:该设备的 `QueueController.advancing` 被一次 `playCurrent` 永久占用,而 5s 轮询在 advancing 期间会被整台跳过 → 该设备连状态都不再上报。

- **根因(不是超时问题,是并发交错)**:客户端流转与拖动是**两条并发链** —— `transfer-from → playFrom`(占 `advancing`),紧接着 `seek → transport`(**不占** `advancing`)。两条链各自对同一台设备执行「停旧会话 → 建 RTSP 会话」,设备端因此在极短窗口内收到多份 ANNOUNCE/SETUP/RECORD;HiVi 的会话表错乱后,后续握手再也拿不到 200,`castToAirPlayDevice` 永远停在 connect 上 → `advancing` 永不释放 → 所有切歌被 `if (advancing.has(id)) return` 静默吞掉。
- **修(设备级串行闸,`services/airplay/control.ts`)**:新增 `withDeviceGate(deviceId, fn)` —— 同一设备的 **cast / seek / stop / pause / resume / stopAirPlaySession** 六个会话生命周期入口严格按到达顺序执行,绝不交错。要点:
  - **必须可重入**(`AsyncLocalStorage` 记录"当前调用链已持有哪把闸"):seek 持闸执行 `prepareSeek` 时,收尾路径可能在同一链内再调停播;若二次排队就自己等自己 ⇒ 永久卡死(本次实现的第一版正是这样,被既有用例 20s 超时抓到)。
  - 闸内实现拆成 `castUnlocked` / `seekUnlocked`:内部只调**不加锁**的私有函数,公开入口才加闸 —— 否则 seek 回落到"重投"时会二次排队自锁。守卫 R11 对此有**反向断言**。
  - `stopAirPlaySessionsForHost` / `startAirPlayService` 的 byebye 收尾 / `stopAirPlayService` 也统一走公开入口(同样排队),不绕过闸。
  - fork 模式同样在**主进程**侧排队(子进程本就是单线程事件循环,但主进程的 RPC 会并发)。
- **配套兜底(`services/player/QueueController.ts`)**:给 `playCurrent` 里两个"理论上可能永不返回"的 await 加硬顶 —— 可播性裁决 `judgePlayable` 10s(超时按"未知"照常试播,与既有"不把不知道当成死的"语义一致)、`player.playMedia` 30s(超时走既有 cast 失败分支)。底层无法取消,但**调用方一定继续**,`advancing` 不再可能被永久占用;迟到的 rejection 被就地吞掉,不会变成 unhandledRejection。
- **实测(240 热补丁)**:
  - 修复前:`16:09:04` 一次 idle_early 之后,该设备零 `playCurrent`、零 poll、`next` 全部静默无效(advancing 卡死 30+ 分钟)。
  - 修复后:连续 **8 轮「transfer-from + seek 同时下发」**全部正常返回,casts 严格串行(每轮 1.4~1.6s),无 timeout 告警;并发结束后 `next` 立即生效、`playCurrent` 正常推进。
- **测试/守卫**:`controlOrchestration.test.ts` 新增「设备级串行闸」组 —— 两次并发 cast 的 connect/spawn 严格成对串行、两次并发 seek 的解码器重建不交错、闸内重入不锁死;`check-airplay-playback-chain.mjs` 扩到 **R1~R13**(R11:闸存在 + 可重入 + 六入口齐全 + 闸内不得回调公开入口),反向变异 3 项(去掉 seek 的闸 / 去掉重入判定 / 闸内回调公开 cast)**全部判红**。
- **影响面**:只作用于 AirPlay 设备会话的**时序**;出流地址、编码、RTSP 报文内容、DLNA / Sendspin / 客户端链路**一字未改**。

### Fix / AirPlay 拖动进度后彻底无声（SYNC 时钟锚点被内容位移带跑 + seq 随机重置）

230 测试床（shairport-sync + Apple 官方 ALAC 解码器）实测取证：

- **接收端铁证**：拖动后日志持续出现 `Check packet from buffer … 31.08 seconds ahead` 与 `crazy time interval of -30.08 seconds` —— 音频被标注成「**未来** 30 秒才该播」，播放线程因此一直空转输出静音。
- **根因**：seek 重建会话后 `startTs` 被重锚到 `baseTs + seekSec*rate`（内容位置），而 SYNC 包的 NTP 仍按 `ts2ntp(headTs)` 换算 —— NTP 被内容偏移整体带跑了 `seekSec` 秒。
- **修**：`RaopPlayer` 新增 `startNtp`（内容起点对应的真实墙钟时刻），SYNC 包 NTP = `startNtp + ts2ntp(headTs − startTs)`；`connect()`（RECORD）与 `stream()`（真正起播）各锚一次。
- **配套**：seek 默认走「完整重建会话」（`AIRPLAY_SEEK_INPLACE=1` 保留原地重锚实验路径），重建起播时按目标秒 `setStartPosition` 重锚 RTP 时间线；`prepareSeek` **不再随机重置 16 位 seq**（接收端会判「中间缺一大段包」并持续 NACK）。
- **ALAC 互操作核验**：用 Apple 官方 ALAC 参考解码器（`/tmp/alactest`，与真机同族实现）解码我方 352 帧 raw ALAC —— `Decode status=0`、352 帧、与输入 PCM **逐字节一致**，证明帧格式无误；shairport 的 ffmpeg / hammerton 解码器不支持 RAOP 的 raw（uncompressed escape）帧，属测试床限制，非发送端缺陷。
- **实测（230 + 240 热补丁）**：修复后 shairport `seconds ahead` / `crazy time interval` 计数**归零**；管道 PCM 由 -91 dB（全零）变为真实内容（mean -77.5 dB / max -58.3 dB，受设备音量档位衰减）；AP1 / AP2 的起播 + 前跳 + 回跳全部成功，位置单调推进。
- **测试/守卫**：`raopPlayer.test.ts` 新增三例（起播 NTP ≈ 现在、seek 30s 重建后 NTP 仍 ≈ 现在且 rtptime 落在内容时间线、latency 字段口径）；`check-airplay-playback-chain.mjs` 扩到 **R1~R13**（R12 钉死 NTP 锚点、含「不得再用 `ts2ntp(this.headTs)`」反向断言；R13 钉死 seek 重建与 seq 连续）。

## [4.6.48] - 2026-10-20

### Fix / AirPlay 播到一半「从头开始」或「跳下一首」（HiVi H5MKII 现场实测定位）

用户实测：AirPlay 投到 HiVi H5MKII，一首歌没播完就**从头重来**或**直接切下一首**（曲目 264s，中断点各不相同：54s / 92s / 138s…）。三段独立缺陷叠加，全部由 240 现网日志与受控实验证实：

1. **上游取流被自家「响应头超时」拦腰截断（根因）**
   - `services/dlna/rawStreamCache.ts` 把 `AbortSignal.timeout(openTimeoutMs=15s)` **直接交给 fetch 并挂满全程**。该 signal 在 **body 读取期间**同样会 abort（undici 会中止响应体）——与注释里「建连+响应头超时」的意图相悖。
   - 现场证据：`[BUF-STREAM] buf-start …` → `ffmpeg 出流结束 signal=SIGKILL ms=13372 clientAborted=true` **精确 15.000s** 一对，反复出现；每次都在同一首歌的 13~15s 处断。
   - 修：新增 `fetchHeadersWithTimeout()` —— 只给建连+响应头限时，`fetch` resolve 后立即 `clearTimeout` 解绑；body 阶段的停摆仍由既有的 `readWithStallGuard`（连续 N ms 无字节 ⇒ 显式错误）负责。外部 signal（客户端断开）监听保留。

2. **解码器直连 raw 直通 + 允许 HTTP 重连 ⇒ 断流后从 0 重读**
   - AirPlay 解码器的输入此前经 `resolvePipelineInput` 被包成 raw 直通（`/rest/dlna/stream/:tok?raw=1`），丢掉了整曲内存缓冲与「上游死亡 ⇒ 下游显式错误」契约；且 `decodeArgs` 对 http 输入**无条件**追加 `-reconnect_streamed 1`。
   - 受控实验（230）：模拟「无 Content-Length 的 chunked 流被上游掐断」→ ffmpeg 日志 `Will reconnect … error=End of file` 连续 **19730 次**，每次请求都是 `Range: bytes=0-` ⇒ **从 0 重读**。听感正是「播到一半又从头开始」；若上游以 EOF 收尾则 exit 0 ⇒ 会话在 54s/264s 处报 IDLE ⇒ `idle_early` 切歌。
   - 修：解码器输入改为**本机回环的完整出流管道**（`http://127.0.0.1:<port>/rest/airplay/stream/:token`，只换 origin，token 不变）—— 恢复整曲 membuf 缓冲 + 出流侧 C3 契约；并给 `DecodeRequest` 增加 `reconnect` 开关，**仅 AirPlay 传 false**（其它 http 链路缺省行为逐字不变）。

3. **解码器僵尸进程（每首歌泄漏一个 18MB）**
   - 上述重连风暴中 ffmpeg 阻塞在重连循环，`kill()`（SIGTERM）走不到检查点。实测：对一个已卡住的解码器发 SIGTERM，**20 分钟后仍存活**；容器内累积 12 个。
   - 修：新增 `killDecoder()`（SIGKILL），in-proc 与 airplay 子进程的收尾路径统一走它。

- **测试/守卫**：
  - `tests/services/rawStreamCache.test.ts` 新增「响应头超时只约束头部」组：body 滴流 640ms 而头部超时 200ms ⇒ 内容必须完整（旧实现会被截断）；对照组「响应头迟迟不来」仍必须超时拒绝。反向变异（去掉 `clearTimeout`）判红。
  - `tests/services/pipeline.test.ts` 新增 `reconnect:false` 契约（http 输入不带重连，缺省仍带）。
  - `tests/airplay/controlOrchestration.test.ts` 新增 `toLoopbackAirPlayStreamUrl`（只换 origin / 非 airplay 命名空间不误伤）与 `killDecoder`（SIGKILL / 空句柄不炸）三例；既有 fork/seek 断言同步为「回环管道」形态。
  - `backend/scripts/check-airplay-playback-chain.mjs` 扩到 **R1~R10**：R8 钉死「回环管道 + 禁重连 + fork 同口径」，R9 钉死「一律 SIGKILL、不得残留无参 `.kill()`」，R10 钉死「超时只到响应头、两入口都走 `fetchHeadersWithTimeout`」。反向变异 6 项（去掉 `reconnect:false` / 退回 SIGTERM / 退回 raw 包装 / 无条件重连 / 去掉 clearTimeout / 退回直接 fetch）**全部判红**，还原后全绿。
- **240 实测（热补丁）**：修复前每 15.000s 断一次；修复后连续播放 **150s+ 不断**（两台设备进度单调推进、无 `stream done` / `idle_early`），解码器进程数稳定、不再增长，解码器命令行不再含 `-reconnect` 且输入为 `127.0.0.1` 的 `/rest/airplay/stream/`。
- **影响面**：DLNA 同样受益于第 1 条（它也在用 raw 直通），但**未改变任何字节/响应形态**，只是不再被 15s 硬切；第 2/3 条仅作用于 AirPlay 解码器。

## [4.6.45] - 2026-10-20

### Fix / AirPlay1（RAOP）投屏连不上设备：内部取流被自家鉴权拦成 401

用户实测：AirPlay1 投屏到 **HiVi H5MKII**（`192.168.10.30:4515`，mDNS `00226CFFA0C0@HiVi H5MKII`、`et=0,1` 支持 RSA）始终连不上。**先诊断后改动**，逐段排查后确认**设备侧完全正常**，断点在服务端内部：

- **设备侧取证（全部正常，排除设备/网络嫌疑）**：mDNS 只广播 `_raop._tcp`（端口 `4515`，`cn=1`/`sr=44100`/`ss=16`/`ch=2`，与客户端常量一致），不广播 `_airplay._tcp`（纯 AP1 设备）；`4515` 端口 OPEN 而 `5000/7000` refused；`OPTIONS` → `200 OK`（`Public` 列出 ANNOUNCE/SETUP/RECORD/FLUSH…）；`GET /info` → `200`。**握手通道与 RSA 通告均无问题**。
- **根因（服务端，`backend/src/index.ts`）**：`/rest/*` 全局鉴权门禁的豁免清单只写了 `/dlna/stream/` 与 `/membuf/`，**漏了 `/airplay/stream/`**。AirPlay 本机 ffmpeg 解码器经 `resolvePipelineInput` 把取流地址包装成回环 URL 后拉取，**结构上带不上任何鉴权头**，于是被自家中间件拦成 `401 Unauthorized`。容器日志逐条印证：`[auth] WARN 认证失败 … path=/rest/airplay/stream/<token>` → ffmpeg `exit code=8 … Server returned 401` → `producer stdout end: totalBytes=0 (0.0s audio)` → `[RAOP] stream done: 0 chunks / 0.0s`。**0 字节出流，设备自然收不到 RTP**。
  - 路由 handler 本身是健全的：`restRoutes.get("/airplay/stream/:token")` 内 `resolveAirPlaySession(token)` 自校验、失败 `403`，与 DLNA 端同款 —— 缺的只是外层门禁那一行豁免。
- **修（最小、不改任何出流语义）**：
  - 新增 `backend/src/middleware/restExempt.ts`：把豁免清单抽成**单一真源** `REST_AUTH_EXEMPT_MARKERS`（`/dlna/stream/`、**`/airplay/stream/`**、`/membuf/`）与 `isRestAuthExemptPath()`，判定口径沿用既有 `includes`（不引入更严的前缀匹配，避免同类条目语义分叉）；`/rest/api/*` 的第二道 `authMiddleware` 保持不变，豁免放松**不透穿到 API 面**。
  - `backend/src/index.ts` 的 `/rest/*` 门禁改走 `isRestAuthExemptPath(c.req.path)`，撤掉内联硬编码（避免两套判定并存）。
  - `backend/src/middleware/metrics.ts` 两处出流族分类同步认 AirPlay：慢请求预算表新增 `"GET /rest/airplay/stream/:token": SLOW_MS_STREAM`（与 DLNA 同级，否则出流会按全局 1s 刷告警噪音）；`isStreamRequest()` 认 `/rest/airplay/stream/` 前缀（否则起播/切歌窗口内金丝雀探针仍在抢上游带宽与连接）。
- **影响面**：DLNA 与服务端出流路径**零行为变化**（豁免清单只是多一条、且判定结果对 dlna/membuf 逐字一致）；变化仅限 AirPlay 取流从「被拦 401」变为「照常出流」。

### Fix / AirPlay1 出声后约 1 秒被切走：同 host DLNA 队列自动续播反杀 AirPlay 会话（二阶）

上述 401 修完、AirPlay 已能出声后，真机（HiVi H5MKII）复测又暴露**第二个静默故障**：首轮 AirPlay **仅 129 chunks / 1.0s** 即被打断，容器日志紧接着出现 `双协议互斥:DLNA 播放前停止同 host AirPlay 会话`。

- **根因（服务端，`backend/src/services/airplay/control.ts`）**：HiVi 类 Linkplay 设备**同时**暴露 DLNA 与 AirPlay，音频输入互斥，故两个方向都做了「起播前停同 host 的另一协议」。但 AirPlay 起播侧的互斥**只做了半件事**：只对同 host 的 DLNA renderer 下发 SOAP `Stop`（`stopDevicePlayback`），**没有冻结它所在的 DLNA 队列**。于是 ——
  1. 设备 Stop 后经 GENA 上报 `IDLE`；
  2. DLNA 队列仍 `isActive`，`PlaybackTracker` 把它判成「这首**自然放完**」→ `advance`；
  3. 队列自动续播重新 `castToDevice` → 落到 `services/dlna/control.ts` 的反向互斥 `stopAirPlaySessionsForHost(host)` →
  4. 把**刚建立不到 1 秒**的 AirPlay 会话 TEARDOWN 掉。用户可见症状就是「AirPlay 刚出声就被切走/断开」。
- **修（`backend/src/services/airplay/control.ts`）**：把「同 host DLNA 让出音频输入」收敛成**单一助手** `yieldSiblingDlnaForAirPlay(deviceId)`，同步做两件事、且**顺序锁定**：
  1. **先**冻结该 DLNA 队列的自动推进 —— 动态 import `getQueueController().stopPlayback(\`dlna:<peerId>\`)`（与 `/v1/peers/:dlna/stop` 同款口径）。`stopPlayback` 正是为「已下发 Stop 却不许队列自动 advance」设计的既有机制（其文档即写明这条误判）；**冻结而非 `clear`**：队列内容保留，用户之后投回 DLNA 仍可原地续播，不丢歌单。
  2. **后**下发 SOAP `Stop` + 清内存媒体态（`stopDevicePlayback`）。顺序不能反：SOAP Stop 的 GENA 事件是**异步回投**的，先冻队列（并清 tracker 的 `prev` 状态）才能保证事件到达时不被误判成自然结束。
  - 两个起播入口口径**必须一致**：in-proc 的 `startSession` 与 fork 模式的 `castViaChild` 都改为只调该助手，撤掉两处重复的手写互斥块（避免两条路径再次分叉）。动态 import 避开 `airplay↔player↔dlna` 的静态循环依赖（与同文件既有 `reportAirPlayIdle` / `stopAirPlayService` 同款姿势）。
- **影响面（严格限定同 host 有 DLNA 兄弟设备这一种拓扑）**：非 Linkplay 类纯 AirPlay 设备（无同 host DLNA peer）**完全不受影响**（不冻结、不碰任何队列）；反向互斥（DLNA 起播停同 host AirPlay 会话）**一字未动**。唯一行为变化是「AirPlay 起播时，同 host 的 DLNA 队列从『自动续播反杀』改为『就地冻结、可续播』」。
- **不在本轮范围（记录在案）**：同 host 存在其它活动时推流节拍会变差（实测 `reanchors 12→83`、`maxGap 75→292ms`）有可闻爆音风险，属独立课题。

### Fix / AirPlay 投屏:同一段音频被归一两次(解码侧与出流侧重复响度归一)

排查 AirPlay 出声链路的后续复盘中发现的**静默听感缺陷**:同一段音频被做了**两遍**响度归一。

- **根因(服务端,`backend/src/services/airplay/decoder.ts`)**:出流侧公共链路已在归一 —— `routes/rest/index.ts::resolveRequestAf()` 在渠道开启时调 `resolveLoudnessAf`(cast 通道判定把 `kind==="airplay"` 映射为 `channel="airplay"`);而 AirPlay **解码侧** `buildAirplayAf()` 又独立调了一遍 `resolveLoudnessAf()` 并挂限制器。于是 ①同一段音频归一两次(动态被二次压缩);②顺序与 `pipeline.ts` 注释里的「响度 → DSP → 限幅」契约**相反**(出流侧 DSP 落在归一之后,解码侧归一又落在 DSP 之后)。全程不报错、不崩溃,只是听感偏「平/闷」,手测极易漏判。
- **修(`backend/src/services/airplay/decoder.ts`)**:解码侧只保留 `outputFilters()` 生成的 **RAOP 硬性输出段**(44100Hz / 16bit / stereo,恒定 pin、非过渡),删掉 `resolveLoudnessAf` 调用与其拼装;随之清理已成死码的 `loudness` 选项与 `isChannelEnabled("airplay")` 依赖(**解码侧与渠道开关脱钩**,开关只在出流侧生效)。`rowId` 字段保留仅为兼容既有调用方,解码侧已不参与响度决策。
- **影响面**:响度归一仍**只在音源源头做一遍**(出流侧公共链路),其它播放器与公共段**零改动**;音色 DSP 未丢(`playerDspFilters()` 只在出流侧 `resolveRequestAf` 调用)。
- **已知副作用(记录在案)**:解码侧不再产出 loudnorm 的 stderr 测量报告,故 `control.ts::handleAirplaySessionEnded` 的 P0-4 落点**不再**从 AirPlay 会话拿到新的响度测量值(该值此前取自已归一过的流,参考意义本就有限;DLNA/客户端路径的测量不受影响)。

### Feat / 默认输出编码全局统一为 FLAC(播放链路输出编码目标收敛)

**用户显式要求(拍板 D1)**:源为 mp3 / m4a / aac / ogg / opus / 未知 时,默认输出**一律转码成 FLAC**,统一播放的输出编码目标。

- **改(`backend/src/services/audio/pipeline.ts`)**:`resolveChannelCodec(suffix)` 不再按源族分档(旧:无损→FLAC / mp3→mp3 320 / m4a+aac→aac 256 / ogg+opus→opus 128 / 未知→mp3 320),**一律返回 FLAC**(容器与编码参数沿用既有 flac 分支,不引入新参数);`resolveDlnaOutput` 的「ogg 系 → mp3 320」回退(理由是老固件不认 Ogg/Opus 容器)被「全局统一 FLAC」自然取代,收敛为**与公共决策同源** —— 否则 cast 时 DIDL mime 与实际出流 Content-Type 会不一致。`/rest/stream` 未带 `format` 的默认路径随之变化(本任务唯一允许触达的公共段)。
- **客户端联动(核对结论:判定逻辑无需改,改为锁定契约)**:`shouldUseServerTimeOffsetSeek()` 首行即 `if (serverPipelinedHttp) return true;`,而本服务端(MusicFlow 自报名)一律命中该早返回,故「未带 format 但服务端返回 FLAC」天然走 `timeOffset` 重拉、不做字节 seek、不从头播放;下方格式/码率比对分支只服务**明确识别出的非本服务端**(其直传流仍可字节 seek),不劣化。客户端补 D1 契约注释与行为断言(`transcoded_stream_seek` / `player_stream_source` / `audio_quality`),并核对强制 mp3 名单仍**按源后缀**判断(命中者显式请求 `format=mp3`,显式 format 优先于默认 FLAC)—— 两者不冲突、不重复转码。
- **影响面**:客户端 / DLNA / AirPlay 中间流统一为 FLAC(AirPlay 解码侧因此多一次 FLAC 解码,CPU 略增、功能无影响);Sendspin 直接解码源字节,不消费该编码决策,**不受影响**;显式 `format=mp3|aac` 的转码路径(`decideTranscode` / `serveTranscodedSong`)行为不变。
- **残留问题(记录在案,超出本任务允许改动面)**:`decideTranscode` 的「可复用原始直传」分支仍假设「管道输出 = 源格式」,当 `maxBitRate ≥ 源码率` 时(如高品质 320 遇 192kbps mp3、流量节省 128 遇 128kbps mp3)会落回默认 FLAC,出现「界面显示 320K/128K、实际是无损」的档位标签与实际不符;修它需改 `services/transcode.ts`(属公共段红线),本任务不动,待拍板。

### Fix / 显式音质档位形同虚设:显式 format/maxBitRate 现在一律走显式转码

D1(输出编码全局统一 FLAC)落地后暴露的**功能回退**:`decideTranscode` 仍保留「可复用原始直传」快路径,而「不转码」在 D1 之后已不再等于「直传源文件」—— 默认管道出的是 **FLAC**。后果有两层:

- **显式格式不复现**:客户端显式请求 `format=mp3`、且源本就是 mp3 且码率达标时,快路径判定「无需转码」→ 实际返回 FLAC,与请求格式不符。
- **带宽档位形同虚设**:只传 `maxBitRate`(高品质 320 / 标准 192 / 流量节省 128 三档即此类)且源码率不超上限时,同样落回默认 FLAC —— 用户为**省流量**选「流量节省 128」却拿到无损流,与界面档位**不符**(用户实测反馈)。

- **修(`backend/src/services/transcode.ts::decideTranscode`)**:删除「可复用原始直传」快路径。只要客户端**显式**给出白名单格式(mp3/aac)或码率档位(`maxBitRate>0`)就一律走显式转码 —— 显式格式转该格式、只给码率档位则转 mp3 取该档位(沿用既有码率钳制 mp3≤320 / aac≤512 / 下限 64);两者都不传(「原始音质档」)/ `raw` / 白名单外格式才交默认管道出 FLAC(无损)。
- **为什么不做「对应码率的 FLAC」**(实测否掉的方案):FLAC 是无损格式,**编码器没有可用的目标码率参数** —— 230 上 ffmpeg 6.1.1 实测 `-c:a flac` 分别加 `-b:a 128k / 320k / 900k`,输出字节数**完全相同**;能影响体积的只有压缩级别(level 0→12 约省 30%)与采样率(44100→22050 约省 37%,但砍高频、并非无损)。故「码率档位」只能由**有损编解码**落地,这是本方案回落到 mp3 的原因。
- **影响面**:客户端 / DLNA / AirPlay 的 cast 路径默认**不传** format/maxBitRate → 一律走默认管道出 FLAC,**行为零变化**;只有「显式点档位 / 显式要求格式」的请求行为改变(从「落回 FLAC」变为「真的按档位转码」)。
- **已知代价(记录在案)**:源格式与请求格式一致且码率达标时也会多做一次「同类转码」(如 mp3@320 源 + `format=mp3` + 320 档)。本项目自用、转码量小(见 `transcode.ts` 文件头设计决策:不做客户端透传),换取「界面档位与实际输出一致」是划算的。

### Fix / AirPlay 三条现网缺陷同源:会话建立未主动上报 PLAYING(乐观窗口先超时)

用户实测三条现象:① 当前曲放完**不自动下一首**;② **重复播放同一首**,且**未播完就从头循环**;③ **不接受外部切歌指令**(客户端/网页切歌无效)。三条**同源**。

- **根因(`backend/src/services/airplay/control.ts`)**:AirPlay 的 PLAYING 只可能来自 5s 兜底轮询(`dlna/control.ts::createAirPlayProtocolPlayer.pollState`),而轮询在 `advancing` 期间被整台跳过、cast 返回后与下一次轮询之间又可能跨满一个 5s 周期。于是 `PlayerController.armOptimisticTimeout` 的乐观窗口(只由一条 PLAYING 关闭)**常常先超时**,连锁:① 5s 判 `stalled` → QueueController 重投**当前曲**(从头再来);② 自然结束的 IDLE 被仍开着的窗口吞掉(`窗口内忽略 IDLE`)→ 不 advance;③ 反复重投长期占用 `advancing` 闸 → 外部切歌被静默吞掉。
- **修**:① 新增 `reportAirPlayPlaying()`,在**会话建立**(RTSP RECORD 完成、解码器起、节拍开始)时立即上报 PLAYING,in-proc(`runStream`)与 fork(`castViaChild`)两条路径都主动上报,不再等 5s 轮询;并带上 `mediaUri`(`getAirPlayMediaUri`,与 DLNA `pollState.TrackURI` 对齐)——否则 tracker 的「同为 PLAYING 但 uri 变 = 换歌」判据对 AirPlay **恒不可达**。② `reportAirPlayIdle()` 改为携带**真实落点**(`positionSec`/`durationSec`):旧实现写死 `0`,而 tracker 的结束判据是「位置 ≥ 时长 − 容差」,写死 0 时末次轮询一旦错过就退化成 `idle_early`。③ 会话收尾统一走 `handleAirplaySessionEnded`,并**抑制过期 IDLE**:被新起播/显式 stop 取代的旧会话(`current=false`)上报的 IDLE 属于**上一首**,却与新会话共用同一个 `playerId` `airplay:<deviceId>` —— 照旧上报会把刚建立的新曲判成「已结束」(观感「刚切过去就被切走 / 曲目乱跳」);`stillCurrent` 必须在 `sessions.delete` **之前**判定。④ 撤掉 finalizer 里那条与统一出口重复的内联 IDLE(旧实现一次收尾发两条)。
- **影响面**:严格限定 `services/airplay/**`(含 fork 子进程 `sessionRuntime.ts`、IPC 事件载荷 `ipcProtocol.ts`/`childMain.ts`/`supervisor.ts`、`protocolPlayer.ts`);DLNA / Sendspin / 客户端与公共出流段**零改动**。
- **测试环境说明(记录在案)**:被测代码在「推流 promise 收尾」微任务里发出的动态 import,vitest 的模块运行器不会 flush(实测等 3s 也不到);生产是真实 ESM,不受影响。故 finalizer 用例改断言**可观测**部分(会话移除 / TEARDOWN / 解码器收掉),IDLE 的「上报 + 真实落点」改由**直调统一出口**的用例覆盖。

### Test / 回归守卫与用例

- 新增 `backend/scripts/check-airplay-stream-auth.mjs`（5 组共 16 条断言）并挂 `ci.yml` 新 job `airplay-stream-auth-guard`：R1 豁免清单单一真源且**恰好三条**（增删/改名必红）；R2 `/rest/*` 门禁走 `isRestAuthExemptPath(c.req.path)`、仍 `authMiddleware` 兜底、**旧内联 `includes('/dlna/stream/')` 已彻底移除**、`/rest/api/*` 第二道门禁仍在；R3 `/airplay/stream/:token` handler 必须 `resolveAirPlaySession` 自校验 + 无效即 `403` + 复用 `serveCastStream(kind:"airplay")`（并反向校验 DLNA 对照实现未被改坏）；R4 出流族两处分类同步认 AirPlay 且无 `startsWith("/rest/")` 之类整面误判；R5 行为用例在册。每条断言均做双向变异验证（改坏必红，见下）。
- 新增 `backend/tests/middleware/restExempt.test.ts`（7 条）：清单内容与顺序钉死、三条取流端放行、**AirPlay 回归锚点**、带查询串的真实取流形态、普通业务路径一律不放行（单曲流/封面/下载/登录/API）、裸 `/rest` 与空串不得放行、**前缀必须带尾斜杠**（`/streams` 不被当成 `/stream/`）。
- 扩充 `backend/tests/middleware/metrics.test.ts`：预算表补 AirPlay 出流档断言；新增 `isStreamRequest` 独立 describe（4 条）—— 三条出流端命中、**AirPlay 回归锚点**、非出流请求（含 `/streams` 与 `/rest/api/*`）一律不命中、以及「AirPlay 出流 2000ms 不产生慢请求告警」的端到端行为断言。
- 覆盖：`src/middleware/restExempt.ts` 落在 `vitest.config.ts` 的覆盖率统计范围内（`src/index.ts` 原本就排除），行为用例对其全量分支覆盖。
- 新增 `backend/scripts/check-airplay-dlna-mutex.mjs`（5 组 9 条断言）并挂 `ci.yml` 新 job `airplay-dlna-mutex-guard`：R1 同 host DLNA 互斥只有**单一助手** `yieldSiblingDlnaForAirPlay` 一处实现，助手内**两件事都在**且**冻结先于 SOAP Stop**、且经**动态 import** 取 QueueController；R2 两个起播入口（`startSession` / `castViaChild`）**各调一次、共 2 处**；R3 **常量断言**：助手之外不得再出现任何裸 `stopDevicePlayback(...)`（防手写互斥绕过助手）；R4 反向互斥 `castToDevice → stopAirPlaySessionsForHost` 仍在；R5 `stopAirPlaySessionsForHost` 仍导出。每条断言均做双向变异验证（改坏必红，见下）。
- 扩充 `backend/tests/airplay/controlOrchestration.test.ts`（+5 条，替身补 `getQueueController.stopPlayback` 并纳入 beforeEach 复位）：① 起播前**冻结**同 host DLNA 队列（`stopPlayback("dlna:<peer>")`）；② 冻结**先于** SOAP Stop（`invocationCallOrder` 断言顺序）；③ **fork 路径**同样冻结（两条入口不得分叉）；④ 冻结抛错**不拖垮起播**且不跳过 SOAP Stop；⑤ 同 host 无 DLNA peer 时**不冻结任何队列**。

- 新增 `backend/scripts/check-airplay-decode-af.mjs`(5 组 15 条断言)并挂 `ci.yml` 新 job `airplay-decode-af-guard`:R1 解码侧不引用 `resolveLoudnessAf`/渠道开关、pipeline 导入清单收口;R2 输出段参数锁定(targetRate/16bit/forceRate/stereo/hasLoudnorm=false);R3 **常量断言**:剥注释后解码侧全文不得出现 `loudnorm`/`alimiter`/`volume=`;R4 **反向断言**:出流侧 `resolveRequestAf` 仍调 `resolveLoudnessAf` + `playerDspFilters`,且 cast 判定仍映射 `channel="airplay"`(防「两处都删」);R5 单一实现不复制。三项反向变异(把 loudnorm 加回解码侧 / 摘掉 stereo 的 pin / 真正摘掉出流侧调用点)全部判红,还原后全绿。
- 调整 `backend/tests/airplay/decoderAf.test.ts` 与 `decoderProducer.test.ts`:锁新形态(解码 af **逐字等于**输出段、绝不含 loudnorm/alimiter;`pipeline.airplay` 开关开/关**逐字一致**,证明解码侧与开关脱钩;lavfi 全链跑通时 stderr **不再**产出 `input_i`)。

- 新增 `backend/scripts/check-audio-default-flac.mjs`(15 条断言)并挂 `ci.yml` 新 job `audio-default-flac-guard`:五类源后缀 + 未知兜底一律 FLAC;DLNA 决策与公共决策同源;显式 `format=mp3|aac` 的转码路径仍在(未误删);`decideTranscode` 的直传判定仍在。两项反向变异(改回按源族旧分支 / 恢复 `ogg→mp3`)均判红,还原后逐字节一致。
- 服务端测试:`tests/services/pipeline.test.ts` 补 `resolveChannelCodec` / `resolveDlnaOutput` 两组 9 用例;`tests/rest/dlnaOggFallback.test.ts` 全量改判 FLAC;`tests/routes/streamRemoteFallback.test.ts` 默认出流 mime 改判 `audio/flac`。客户端:`transcoded_stream_seek_test.dart` / `seek_reload_routing_test.dart` 新增「D1:未带 format + 服务端返回 FLAC」组(判定需 timeOffset、重拉地址带 timeOffset 且不带 format、绝不做源内字节 seek)。

- 新增 `backend/scripts/check-airplay-playback-chain.mjs`(R1~R7)并挂 `ci.yml` 新 job `airplay-playback-chain-guard`:会话建立即主动上报 PLAYING(in-proc/fork 两条路径)/ `reportAirPlayIdle` 带 `positionSec`/`durationSec` 参数 / 抑制分支 `endInfo.current === false` 时**不上报**、else 支才上报 / `stillCurrent` 判定**先于** `sessions.delete`(顺序不得倒置)/ fork 侧 `sessionRuntime` + IPC 载荷 + supervisor 同口径 / `pollState` 必带 `mediaUri: getAirPlayMediaUri(deviceId)` 且**不得**为加它而删掉 playbackState/position/duration。反向变异(摘掉 mediaUri / 去掉抑制分支)判红。
- 扩充 `backend/tests/airplay/controlOrchestration.test.ts`:新增「播放链路时序」组(PLAYING 即时上报 in-proc + fork、被取代会话抑制过期 IDLE、IDLE 真实落点、fork 事件载荷带落点与 current、`pollState` 带 `mediaUri` 且与 `peerStatus.trackUri` 同源)。airplay 全套 296 用例全绿。

- 收紧 `backend/tests/services/transcode.test.ts`:两条旧用例(「源即 mp3 且码率达标 → 不转码」「仅 maxBitRate 且源码率不超标 → 原样返回」)改判为「必须转码」,镜像用例表同步更新并**重新定位** —— 该表只描述本服务端(MusicFlow)语义,不再与客户端 `_contractVectors` 逐项等同(后者描述**外部服务端**「源格式相同即可字节直传」的启发式,刻意分道:不为本服务端的 D1 去劣化外服务器的字节 seek)。
- `check-audio-default-flac.mjs` 增补 3 条断言(共 18 条):**常量断言** `canUseOriginal` 不得再加回来、显式 format 分支恒 `should:true`、显式 maxBitRate 分支恒转 mp3;反向变异(把快路径加回去)判红 2 条,还原后全绿。

## [4.6.47] - 2026-10-20

### Feat / AirPlay 2 分级发现（课题 E2：能力识别，不改投屏路径）

AirPlay 2（E2~E5）课题的第一阶段：让服务端能**区分**设备是否具备 AirPlay 2 能力，为后续 AP2 发送端（配对/加密/缓冲式推流/控制时钟）做准备。**本版不改投屏路径** —— 所有设备仍走既有 AP1/RAOP，行为与本版之前逐字一致。

- **设备表来源不变**：`_raop._tcp` 仍是设备表的**唯一**来源；新增的 `_airplay._tcp` 浏览只用于给「已存在的」raop 设备打能力标记 `supportsAp2`。纯 AP2-only 广播**不会**造出设备（AP2 发送端未落地前它投不了，进表只会变成「点了报错」的死设备，还会污染 AP1 设备表）。
- **判据不靠猜**：`supportsAp2 = 同时有 _airplay 记录 && protovers ≥ 1.1`。刻意**不**用某一个 features 位 —— 位定义必须由 230 接收器实测反证。`features/srcvers/protovers/gid/flags` 原样留存，供 E3 的握手/加密读取。
- **deviceid 归一**：`_raop` 把 MAC 放在服务名前缀（`86BC3FFBA308@名字`），`_airplay` 放在 TXT `deviceid` 且常带冒号（`86:bc:3f:fb:a3:08`）—— 归一（去分隔符 + 大写）后两条记录才对齐；无法对齐的 `_airplay` 记录直接忽略（不按名字猜）。
- **能力可撤**：`_airplay` 记录 down ⇒ 能力翻回 `false`，但设备**可用性**仍由 `_raop` 的 up/down 决定；插件关闭（stop）时清空能力表，避免下一轮启动残留旧能力。
- **对外透出**：`GET /v1/airplay/devices` 增加 `supportsAp2` 与 `ap2{features,srcvers,protovers,gid,flags,model}`；renderer 的 `discover()` meta 同步带 `supportsAp2/ap2Protovers`。
- **新增静态守卫** `backend/scripts/check-airplay-ap2-discovery.mjs`（挂 `ci.yml` 第 24 个 job，四组 16 条）：① 设备表唯一来源（`upsertAp2` 体内不得出现 `devices.set(`）；② 判据必须是「能力存在 && protovers ≥ 1.1」（不得写死 `true`）；③ `_airplay` down 必须走 `dropAp2` 撤能力、`_raop` down 仍只标离线；④ AP1 零回归（`cast()` 仍只调 `castToAirPlayDevice`，不得提前分流 AP2）。反向变异 4 项（`_airplay` 造设备 / 判据写死 true / down 不清能力 / dropAp2 不删表）**全部判红**，还原后逐字节一致。
- **测试**：新增 `discoveryAp2.test.ts`（9 例：先到顺序、纯 AP2-only 不入表、protovers=1.0、缺 deviceid、down 撤能力、stop 清表、归一与版本判据）；同步既有 `discovery.test.ts` / `airplayDiscoveryTail.test.ts` 的句柄数（常驻 2 条、30s 续期各 1 条）。airplay 全套 **306 用例全过**。
- **240 实测**：`MusicFlow-230-AP2`（shairport AP2）→ `supportsAp2=true / protovers=1.1 / features=0x401C4A00,0x5C340`；`HiVi H5MKII` 与 `MusicFlow-230-AP1`（纯 AP1）→ `false`；纯 AP2-only 的 `MusicFlow-230-AP2r` 按设计**不入表**。`/v1/peers` 的 AP1 投屏端与队列未受影响。

## [4.6.46] - 2026-10-20

### Fix / AirPlay 投屏到标准合规接收端完全放不出声：RAOP 请求行缺 `RTSP/1.0` 版本段

用 230 上起的 shairport-sync 冒充接收端（E0/E1 测试床）复测 AirPlay 时暴露：投屏建立会话就失败，服务端 `cast FAILED: RTSP ANNOUNCE failed: RTSP/1.0 400 Bad Request`，接收端日志是 `msg_handle_line fail` / `rtsp_read_request can't find an RTSP header`。

- **根因（`backend/src/services/airplay/raop.ts`）**：`sendRtsp()` / `sendRtspNoWait()` 拼的请求行只有两段 —— `METHOD rtsp://host:port/<sid>`，**漏了 RFC 2326 要求的 `RTSP/1.0` 版本段**。所有 RTSP 指令（ANNOUNCE / SETUP / RECORD / FLUSH / TEARDOWN / SET_PARAMETER）都受影响。
- **为什么一直没暴露**：真机 **HiVi H5MKII 对非法请求行是「容错吸收」**的（它照样回 200），所以此前真机投屏能用；换成标准合规的实现就一律 400。既有单测只断言 `toContain("ANNOUNCE ")`，也拦不住缺版本段。
- **A/B 实测（同一份 SDP，对 230 的 shairport-sync:7100）**：
  - 复刻旧写法（`ANNOUNCE rtsp://…`）→ `RTSP/1.0 400 Bad Request`
  - 补上版本段（`ANNOUNCE rtsp://… RTSP/1.0`）→ `200 OK`；继续 SETUP → `200`（`Transport: …;server_port=…`）、RECORD → `200`，整条握手打通。
- **修**：两个发送函数的请求行都改为三段式 `METHOD url RTSP/1.0`（fire-and-forget 分支同样补上，否则音量/FLUSH/TEARDOWN 在合规接收端静默失效）；源码内加契约注释说明真机容错掩盖了该缺陷。
- **新增静态守卫**：`backend/scripts/check-airplay-rtsp-line.mjs`（挂 `ci.yml` 新 job `airplay-rtsp-line-guard`，第 23 条）—— 常量断言「`${this.url} RTSP/1.0` 恰好出现 2 次（两分支各一）」+ 两分支各自体内断言 + **反向**断言不得再出现两段式 `METHOD url` + 单测动态契约（握手三条与 `SET_PARAMETER` 的请求行都必须以 `RTSP/1.0` 收尾）。反向变异：只改一处漏版本 / 两处都漏 / 版本段多一个空格 —— **三项全判红**，还原后逐字节一致。
- **单测**：`raopTransport.test.ts` 新增「三条握手请求行三段式」用例，并在 `SET_PARAMETER`（fire-and-forget）用例里补请求行断言。`raopTransport` + `raopPlayer` 共 **101 用例全过**。
- **影响面**：仅 RAOP 请求行形态。SETUP/RECORD 的头字段与 SDP 内容**一字未动**；HiVi 真机对多出 `RTSP/1.0` 的合法请求行同样接受（本来就应该这么发）。

## [4.6.45] - 2026-10-20

### Fix / 4.6.45 遗留 CI 红：任务 D 的会话收尾断言未同步（全量测试 2 例红）

`e58aeda`（任务 D）把 AirPlay 会话收尾改为**一律**透传 `current` / `positionSec` / `durationSec`（「IDLE 必带真实落点」契约），而 `backend/tests/services/airplaySessionRuntime.test.ts` 里两处旧断言仍按**旧形态**写（推流失败 → `undefined`；自然结束 → 只有 `loudnessStderr`）→ `ci` 与 `build-and-push` 两个 job 的全量测试各红 2 例（同一个根因）。

- **修**：两处断言按新契约收紧 —— 推流失败路径无 loudnorm JSON ⇒ `{ current: true, positionSec: 0, durationSec: 240 }`（**不带** `loudnessStderr`）；自然结束路径在该对象基础上多带 `loudnessStderr`。
- **验证**：本机（230）按 CI 同口径实跑全量 `npx vitest run`：**523 个测试文件全过**、`7346 passed | 1 expected fail`，与 CI 结果一致。

### Fix / Web「播放器」页 AirPlay 设备没有图标、在线态缺「已连接」标志

用户实测反馈：AirPlay 设备行**看不到图标**；并明确要求「AirPlay 设备连上后应和 DLNA 设备一样图标变色、并有已连接的标志」。

- **根因（前端，`frontend/src/components/MfIcon.vue`）**：设备行写的是 `<MfIcon name="Airplay" />`，名字拼写**完全正确**，但 `MfIcon` 的 `ICONS` 注册表里从未注册过 `Airplay`（该图标只在 `lucide-vue-next` 里存在，没有被 import 进注册表）。于是 `resolved()` 返回 `null` → 走 `<slot v-else />` → 页面渲染出一个**空 span**：位置占着、什么都不显示。**破坏是全静默的**：不报错、不崩溃，`vue-tsc` 管不到（name 是任意字符串，解析结果不进类型系统），既有单测也照样绿 —— 只有肉眼看到「那块是空的」才会发现。
  - 同类缺陷在仓库里还查到两处，本次一并补齐：`ChevronUp`（流转编辑页「上移」按钮，`frontend/src/views/Flows/Editor.vue`）、`Pin`（每日推荐「转为本地歌单」，`frontend/src/views/Playlists/Detail.vue` 与 `frontend/src/views/Playlists/index.vue`）。
- **修**：
  - `MfIcon.vue` 的 lucide import 清单与 `ICONS` 注册表补齐 `Airplay` / `ChevronUp` / `Pin`。
  - `frontend/src/views/Groups/index.vue` 的 AirPlay 设备行新增**连接态胶囊**（`device-link-status is-on`：绿点 + 「已连接」），判据 = `dev.available`（mDNS 发现侧的实际可用性，90s 未刷新即判离线）—— 可用时图标转橙（= DLNA 行同款在线高亮）+ 亮出「已连接」；不可用时图标转灰、沿用既有「离线」标签（**与 DLNA 行同口径**）。胶囊的视觉与判据语义复用 Sendspin 行既有的连接态（用户拍板口径）。
  - i18n 新增 `groups.airplayLinkOn` / `groups.airplayLinkOnTitle`（zh-CN + en-US 双侧对齐）。
- **新增静态守卫**：`backend/scripts/check-mficon-registry.mjs`，挂 `ci.yml` 的 `frontend-guards` job（第 22 条）。三条规则：
  1. **R1 注册表自洽**：`ICONS` 每一项都必须有真实的 lucide 组件来源（⊆ import 清单）—— 防「拼错的名字」躺进注册表，那它自己也就成了不出声的失效项；并钉死 `resolved()` 的收尾必须是 `|| null`（若被改成「兜底成某个默认图标」，漏注册就从静默空白变成静默错误图标，更难发现）。
  2. **R2 引用可解析**：`frontend/src` 下所有 `<MfIcon>` 的**静态** name 必须能解析（direct / toPascal / ALIAS 同款四条路径，与运行时 `resolved()` 一致）；比较运算符右侧的字面量（如 `p.kind === 'group' ? 'Box' : 'Monitor'` 里的 `'group'`）按取值条件剔除，不当图标名。
  3. **R3 反向钉死**：当前在用的 `Airplay` / `ChevronUp` / `Pin` 必须在册 —— 否则把注册项删掉后 R2 又会绿（「两处一起坏」的假绿）。
  - 反向变异验证：摘掉 `ICONS` 里的 `Airplay` / 把 `resolved` 收尾改成写死默认图标 / 往 `ICONS` 塞入未 import 的名字 —— 三项**全部判红**，还原后逐字节一致。
- **门禁**：`npx vue-tsc --noEmit`（frontend）0 错误、`npx tsc --noEmit`（backend）0 错误、`node backend/scripts/check-*.mjs` 共 **25 个**守卫全绿。
- **影响面**：仅「播放器」页 AirPlay 区块与图标注册表；DLNA / Sendspin / 组 / 客户端的既有渲染与链路**零改动**（胶囊只是 AirPlay 行新增的一个状态位）。

## [4.6.44] - 2026-10-20

### Perf / 首页提速收尾：聚合缓存冷启动预热 + 首页并排随机池改走全量轻量接口

承接 4.6.42/4.6.43 的首页提速，落地两处「把慢活挪到无人等待窗口」与一处真实缺陷修复。

- **服务端 `backend/src/routes/api/recommend.ts`：聚合缓存「冷启动也预热」+ 分档 re-arm**
  - 4.6.42 只把首轮预热提前到启动后 4s，但预热判定仍要求「该 cacheKey 已有缓存」——进程刚启动时内存与 DB 都没有聚合缓存，首页首开依旧走请求路径冷拉（平台精选要串起 go-music-dl 与各榜单插件的沙箱外呼，实测单插件冷启动 **1.6~16.6s**）。
  - 现提取 `warmRecommendCacheOnce()` 并导出：有缓存且过期 → 后台单飞刷新；**无任何缓存（冷启动）且推荐类插件已就绪 → 也 kick 一轮后台聚合**，首页首开通常直接命中缓存、不再吃 `pending` + 8s×18 轮询。
  - **插件未注册时绝不预热**：`apiRoutes` 早于插件注册挂载，首轮 tick 可能跑在插件就绪前，此时聚合会因无插件返回「空频道且无 primaryError」，被当成稳态结果写进缓存并保留整个 TTL(5min) —— **首页会空 5 分钟**。故未就绪时 `warmRecommendCacheOnce()` 返回 `false`，预热器降到冷档 `RECOMMEND_WARMER_COLD_RETRY_MS = 15s` 短周期重试；就绪后回到 `TTL/2` 稳态档。
  - **冷启动空结果绝不落库（覆盖审查发现）**：上一条只堵住「插件未注册」，但「插件已注册、`recommend()` 返回空且无 `primaryError`」时仍会被照写成稳态缓存 —— 同样把首页空字段锁满整个 TTL。故 `refreshRecommendCacheInBackground` 新增 `opts.cold`：**冷启动(无旧缓存)时空 `channels` 一律记入失败退避、不落库**（保留 `pending` 语义，由前端轮询与预热冷档重试兜住）；非冷启动的过期刷新保持原语义（仅 `primaryError` 才不覆盖，空结果视为「今日无内容」）。
  - 新增测试钩子 `__awaitRecommendWarmerForTest()`（等本轮在途刷新 settle）/ `__resetRecommendWarmerForTest()`（清定时器，供多档时序用例独立驱动）。
- **服务端 `backend/src/routes/api/playlists.ts` + `homePreload.ts`：常驻「最瘦歌单索引」+ `GET /v1/home/playlist-pool`**
  - 首页「并排随机」此前调 `/v1/playlists?pageSize=200` 拉「全量」，而服务端单页上限 **500**、生产库已有 **873** 个歌单 —— 随机池实际只覆盖最新约 **200** 个，其余 **673 个永不出现**（真实缺陷）。
  - 新增进程内常驻索引：每条只留 `id + name + songCount`（封面由前端按 `pl-<id>` 派生，交给既有懒加载），**TTL 60s 懒刷新、不挂歌单变更钩子**、启动后 4s **单发预热一轮**（`unref`，不阻进程退出）。索引内部额外存 `owner/pub` 两列但**不进响应体**，读出时按与 `buildPlaylistsPage` **逐字对齐**的口径过滤（`pub = isPublic===1 || sourceUrl!=null`，管理员全见；普通用户仅见「自己 + 公开 + 导入」），避免向普通用户泄漏他人私密歌单。
  - 新接口 `GET /v1/home/playlist-pool` 挂 `PLAYLIST_VIEW` 权限门，复用 `buildPlaylistPool`，一次返回全量池；**支持 `?refresh=1` 强制跳过索引 TTL 缓存**（供首页「重新生成漫游」后立刻拿到新歌单，避免旧实现直查 DB → 池缓存 60s 的可见回归）。
  - 启动预热改为**单发定时器**而非递归 re-arm：索引重建实测 <2ms（873 行只投影 6 列），周期预热既无收益，又会在每个 import 本模块的测试进程里常驻一个永远待触发的定时器。
- **Web 首页 `frontend/src/views/Home/index.vue`**：`loadPlaylists()` 由 `/rest/api/v1/playlists?pageSize=200` 改为 `/rest/api/v1/home/playlist-pool`，映射为 `{id,name,songCount,coverArt:'pl-'+id}` —— 一次拿到全量 873 并**修掉 pageSize=200 截断**，模板接线（首屏 eager/`fetchpriority="high"`、下半屏 `v-lazy-cover`）零改动。`refreshRoam()` 的手动刷新改调 `loadPlaylists(true)`（带 `?refresh=1`）。

### Test / 回归守卫与用例

- 新增 `backend/tests/qa_perf/playlistPool.test.ts`（9 条）：只投影 `{id,name,songCount}`（不外泄 owner/pub）、管理员全见 / 普通用户仅见「自己+公开+导入」、**与 `buildPlaylistsPage` 逐用户对拍（含未登录 `undefined` 与非 0/1 脏值 `isPublic`，防两套可见性口径漂移）**、**`force=true` 跳过 TTL 缓存**、TTL 内复用缓存、超 TTL 重建后新歌单进池、空库安全返回空池、预热后首个请求直接命中。
- 新增 `backend/tests/qa_perf/recommendWarmerCold.test.ts`（6 条）：覆盖 `warmRecommendCacheOnce` 五条分支（无缓存+未就绪 → false 且不落缓存 / 无缓存+已就绪 → 外呼一次并把**真实频道**写入缓存 / **无缓存+已就绪但聚合为空 → 不落库** / 有新鲜缓存 → 不重复外呼 / 有过期缓存 → 单飞刷新）。
- 扩充 `backend/tests/routes/recommendWarmerBackoff.test.ts`（4 → 7 条）：新增冷档常量与「双档 re-arm」时序用例（插件未注册 → `RECOMMEND_WARMER_COLD_RETRY_MS`；插件已就绪 → `TTL/2` 且幂等），并用 `vi.mock` 把「插件发现」入口换成受控假体，使两档都确定性可测（不依赖真实注册表/DB）。
- `frontend/e2e/home-first-paint-covers.spec.ts`：首页数据 mock 由 `/v1/playlists` 换到 `/v1/home/playlist-pool`（按真实响应契约只回 `{id,name,songCount}`）。
- `backend/scripts/check-home-perf.mjs`：R2 权限门计数 `2 → 3`（新增 playlist-pool 的 `PLAYLIST_VIEW`）；R6 断言随分档改写（钉 `warmRecommendCacheOnce` 导出、冷档常量、`if (!warmRecommendCacheOnce()) nextDelayMs = …` 分档驱动）；**新增 R7**（歌单池索引 9 条：TTL 常量 / `buildPlaylistPool` 导出 / 预热器定义与模块级调用 / 可见性过滤 / **`pub` 判定逐字对齐 SQL** / 只投影三字段 / **`force` 旁路** / **单发预热延迟** / **不得递归 re-arm(`tick()`)**）与 **R8**（接口与前端接线 10 条：路由注册 / 权限门 / 复用 `buildPlaylistPool` / **`refresh` 透传** / Home 改走轻量接口 / 不得再出现 `/rest/api/v1/playlists` 与 `pageSize: 200` / **`?refresh=1` 与 `loadPlaylists(true)`** / 封面按 `pl-<id>` 派生）。共 **76** 条断言。

## [4.6.43] - 2026-10-19

### Fix / CI 覆盖率门禁偶发红修复：QQ 节流队列被假时钟卡死

`ci` 作业的 `fetch-coverage-gate`（下载 + 标签修复覆盖率门禁）随本次推送偶发红，且**只在用例顺序被打乱时**复现：

- **现象**：单文件 `backend/tests/plugins/tagProvider.test.ts` 耗时 **805s（13.4 分钟）**，66 个用例中 38 个各报 `Test timed out in 20000ms`，把 15 分钟的作业拖到红；同 run 的其它 7 项 CI 全绿，`build-and-push` 的全量 vitest 也全绿（同一份用例在别的顺序下能过）。
- **根因**：`tagProvider.ts` 的 QQ 限流队列 `qqTail` 是**模块级全局串行链**。用例「请求超时(10s) → AbortController.abort」用 `vi.useFakeTimers()` 切假时钟；若此时 `qqNextAt` 仍在未来，`qqThrottled` 内部 `await new Promise(r => setTimeout(r, wait))` 排的是**假闹钟**，`vi.useRealTimers()` 一执行就把该闹钟连同 `setTimeout` 一起丢弃 → `run` 永不 settle → `qqTail` 永久 pending → 该文件后续**所有** QQ 请求全部卡死（每个 20s 超时）。触发条件苛刻（仅当限流用例恰排在超时用例之前，概率取决于 `sequence.shuffle` 的随机顺序），故此前多轮 CI 都过、偶发放炮。
- **修**：`tagProvider.ts` 新增测试专用导出 `__resetTagProviderQueue()`（复位 `qqNextAt` 与 `qqTail`）；`tagProvider.test.ts` 的 `beforeEach` 与既有 `__resetTagProviderMemo()` 一并调用。`qqNextAt=0` 后该用例的 `wait` 恒 ≤0，不再排假闹钟；同时彻底消除跨用例共享的队列状态依赖。**不改动任何生产语义**（新增的仅是测试专属导出）。
- **守卫**：`backend/scripts/check-tag-repair.mjs` 新增 **R14**（4 条断言：导出存在 + `qqNextAt` 清零 + `qqTail` 置回已解决 + 单测 `beforeEach` 必须调用），并做 3 种反向变异验证（去 export / 删 `qqTail` 复位行 / 单测去复位调用）均判红。

### Test / 首页打开提速的回归守卫补强（承接 4.6.42）

4.6.42 已落地三端首页提速，本次补齐**行为级**回归守卫（此前只有静态脚本守卫），并做反向变异验证确保守卫非空转。

- **新增 `frontend/e2e/home-first-paint-covers.spec.ts`**（Playwright，随 `frontend-responsive.yml` 的 `npx playwright test` 全量门禁运行）：
  - 用 `page.route` 注入确定性首页数据（8 张随机歌单 + home-cards 空 + 平台/本地渠道各 2 张），断言不依赖真实曲库；
  - **关键在于把 `IntersectionObserver` 换成「只注册、永不回调」的替身**：否则上半屏卡片本就在首屏视口内，即便误用 `v-lazy-cover`，observer 回调也会立刻补 `src`，「急切 vs 懒加载」区分不出来，守卫退化为空转。替换后：`:src` 由模板直接写入（必然有 src）、`v-lazy-cover` 的 src 只在回调里写（永不赋值），二者才可判别；
  - 断言：上半屏 `img.card-cover[fetchpriority="high"]` 恰 8 张且每张 `src` 均已设置（急切加载）；下半屏 `fetchpriority="low"]` ≥2 张且未滚动时**全部**未设置 `src`（懒加载，不预取屏外同源封面）。
  - 三种反向变异均被判红并记录：① 上半屏 `:src` → `v-lazy-cover`；② 下半屏 `fetchpriority="low"` → `high`；③ 下半屏 `v-lazy-cover` → `:src`。
- **扩充 `backend/tests/routes/recommendWarmerBackoff.test.ts`**：新增 `describe("startRecommendCacheWarmer 递归调度时序")` —— 用 `vi.spyOn(globalThis, "setTimeout")` 拦截调度参数，断言首轮延迟恒为 `RECOMMEND_WARMER_INITIAL_MS`(=4s) 且 `< RECOMMEND_CACHE_TTL_MS / 2`（防退回旧的 ≈150s）、重复 `startRecommendCacheWarmer()` 幂等（只挂 1 个定时器）、首次 tick 的 `finally` re-arm 恒为 `RECOMMEND_CACHE_TTL_MS / 2` 且递归稳定（连续两轮仍为 TTL/2）。不真跑定时器、不读写 DB（模块加载期定时器均已 `unref`）。
- 用例总数：该文件 4 → 5 条。

## [4.6.42] - 2026-10-19

### Perf / 首页打开提速（三端一体：服务端预热 + Web 首页 + HA 卡片媒体库首页）

用户反馈：HA 卡片打开媒体库首页很慢、**卡片加载了但封面迟迟不显示**；Web 首页首开也偏慢。对照实现是客户端发现页（即使本地零封面缓存也很快）。三处一起改：

- **服务端（后台预热提前 + 失败退避改指数）**
  - `backend/src/routes/api/recommend.ts`：聚合缓存预热器首轮延迟由 `RECOMMEND_CACHE_TTL_MS / 2`（≈150s）改为 `RECOMMEND_WARMER_INITIAL_MS = 4s` —— 否则进程刚启的一两分钟内，首页首个 `/v1/recommend` 只能走请求路径冷拉（插件外呼 900ms+）。预热周期仍为 `TTL/2`，递归 `setTimeout` 的 finally re-arm 与 unref 语义不变。
  - 后台刷新失败退避由**固定 60s** 改为**指数退避**：`recommendRefreshBackoffMs(failStreak)` 按连续失败次数 `3s → 6s → 12s → 24s → 48s` 翻倍、封顶 60s（`RECOMMEND_REFRESH_BACKOFF_BASE_MS=3000`、`…_MAX_MS=60000`）；`recommendColdFailAt` 由「时刻」改为「时刻 + 连续失败次数」。上游短暂抖动不再被固定退避锁死一分钟，也不会退避窗口无限增长。
- **Web 首页**（`frontend/src/views/Home/index.vue`）：首屏顶部的固定推荐卡与并排随机歌单封面改为**首屏立即加载**并给 `fetchpriority="high"`（原为 `v-lazy-cover` + `low`）；下半屏「平台精选 / 本地随机」分区保持原懒加载与 `low` 优先级不变 —— 让首屏封面先于屏外上百张同源封面抢到连接。
- **HA 卡片**（`hass-musicflow-card` v2.5.1）：`_fetchHomeItems` 由 5 路 `Promise.all` 齐等改为**两阶段** —— 阶段一只 await 快三路（歌单 / 固定卡计数 / 固定卡），顶部固定卡与侧栏随机立即渲染；慢两路（平台精选 / 本地随机，冷启动 2.5s+）另起**非 await** 的 `Promise.all`，在 `.then` 里经 `_appendHomeSections` 追加到列表尾，并复用虚拟滚动「失效首块 + 重载」就地补齐（不白屏、不整页重载）。慢两路回包比对 `level.vSeq` 序号，期间切 agent / 刷新 / 搜索即丢弃旧回包；首屏前 8 行封面 `fetchpriority=high`，其余保持 `loading=lazy`。

### Test / 回归守卫

- **新增 `backend/tests/routes/recommendWarmerBackoff.test.ts`**：断言 `recommendRefreshBackoffMs` 的指数增长与 60s 封顶（`1→3s`、`2→6s`、`3→12s`、`4→24s`、`5→48s`、`≥6→60s`，以及 `≤0` 视为首轮恒为有限值 3s、绝不 NaN/Infinity），并断言 `RECOMMEND_WARMER_INITIAL_MS` 为秒级有限值、退避基准 < 上限。
- **`backend/scripts/check-home-perf.mjs`**：R3 段改为 4 条**精确计数**断言（首屏 `v-lazy-cover` / `fetchpriority` 数量钉死，防退化回「整屏懒加载」）；新增 R6 段钉死 `RECOMMEND_WARMER_INITIAL_MS = 4 * 1000`、`tick(RECOMMEND_CACHE_TTL_MS / 2)` 的 re-arm 形态（禁用旧的一次性 `}, RECOMMEND_CACHE_TTL_MS / 2);` 形态）、`recommendRefreshBackoffMs(` 与退避基准/上限常量，并禁止旧常量 `RECOMMEND_REFRESH_BACKOFF_MS` 复现。
- **`hass-musicflow-card` 的 `tools/guard-card-ui.mjs` 新增 E 组（4 条）**：静态钉住「阶段一 `Promise.all` 不含慢两路 / 慢两路不得被 await 且走 `_appendHomeSections` + `_homeAll` / 回包比对 `vSeq` 不一致即 `return` / 首屏前 N 行封面 `fetchpriority=high`」；src 与 dist **双重校验**，并**已做变异验证**（4 处各自改回旧形态，对应用例逐条转红）。

## [4.6.41] - 2026-10-19

### Fix / Sendspin 自然曲终总时长归零(对齐 MA `freeze_progress`,UI 稳定停在「4:22 / 4:22」)

用户报告(2026-10-19):一首歌自然播完后,播放器当前时间停在 `4:22`、**总时长却变成 `0:00`**(应为 `4:22 / 4:22`)。

- **根因**:v4.6.40 起自然曲终只置空 `group.current`(它是 `pollCore` 的 `playing` 唯一来源,须保留以驱动 auto-advance),而 `pollCore` 的 `durationMs` 取自 `current.durationMs` ⇒ `current` 一清即归 0;`positionMs` 本就保留 ⇒ 呈现「`4:22 / 0:00`」。
- **修复(对齐 MA `metadata_role.freeze_progress()`)**:MA `providers/sendspin/playback.py::_stop_push_stream(snapshot_progress=...)` 只在自然 EOF 前先冻结进度/时长,此后组侧只重发最后一次锚点。MusicFlow 的等价物:
  - **`backend/src/services/sendspin/server.ts`**:`SendspinGroup` 新增 `frozenDurationMs`(自然曲终「冻结时长」)。
  - **`backend/src/services/sendspin/streamEngine.ts`**:自然曲终 / `linkDied` / 异常终止分支在清 `current` **之前**写入 `group.frozenDurationMs = group.current?.durationMs ?? this.durationMs`(位置本就冻结在末尾,只补时长这一个维度)。
  - **`backend/src/services/sendspin/playerCore.ts`**:`pollCore` 的 `durationMs` 兜底改 `current?.durationMs ?? frozenDurationMs ?? 0`;`playCore` / `playGroupCore` 起播失败、`stopCore`、`stopGroupCore`、`handoverCore` 两组收尾等**复位站点**统一清零 `frozenDurationMs`(防陈旧时长串台)。

### Test / 回归守卫

- **新增 `backend/tests/sendspin/naturalEndDurationFreeze.test.ts`**:以**真实 `SendspinGroup`** 驱动 —— 曲终冻结后 `pollCore` 报 `playing=false` 且 `durationMs=262000`(4:22)、位置停末尾;在播中 `current` 屏蔽陈旧冻结值;`stopCore` / `stopGroupCore` 清零;`playCore` / `playGroupCore` 起播失败时 `current` 清空且冻结归零。
- **`backend/tests/sendspin/streamEngineGaps.test.ts` 新增一例**:`durationMs>0` 的曲目自然播完后 `group.frozenDurationMs === durationMs` 且 `current === null`(写入点守卫)。

## [4.6.40] - 2026-10-19

### Fix / Sendspin 自动切歌严格对齐 MA（过渡期不再发 `stream/end` + `stopped`，legacy 档只发 `stream/end`）

v4.6.39 的「新流宣告前补发 `stream/clear`」是**保守兜底**（见该版本条目）。本版按拍板方向**严格对齐 MA / `aiosendspin` 语义**，从根源移除「自动切歌过渡期发 `stopped`」这一病灶，并删除该兜底 clear：

- **权威语义（MA）**：自动切歌 = `cancel(keep_stream=True)` → `PushStream.clear()`（只发 `stream/clear`）+ `stop(keep_stream=True)`（**跳过** `stream/end`），**绝不改 `group/update` 状态**；`stream/end` 与 `group/update(stopped)` 只留给「队列放完 / 用户 stop」（`player.py:1454` "The spec reserves stream/end for queue-empty, not track changes."；`aiosendspin` `server/group.py` 的 `stop()` 是 stopped 的唯一产地）。legacy 档（`playback.py:422-423`，`allow_legacy_clients` 默认 True）强制 `keep_stream=False` ⇒ **只发 `stream/end`、不发 `stream/clear`**。
- **`backend/src/services/sendspin/streamEngine.ts`**：自然曲终 / `linkDied` 分支只置空 `group.current`（保留「poll 报 IDLE ⇒ auto-advance」自愈口径），**不再 `finishPlayback()`**（原先发 `stream/end` + `group/update -> stopped`，正是固件把 stopped 镜像成 IDLE、锁死后续 `stream/start` 的病灶）；异常终止分支改 `finishPlayback({ silentState: true })`。终态收尾（队列放完 / 用户 stop）统一由 `playerCore.stopCore` / `stopGroupCore` 的 `finishPlayback()` 兜底，与 MA `group.stop()` 唯一产地一致。
- **`backend/src/services/sendspin/playerCore.ts`**：`playCore` / `playGroupCore` 过渡分支判据由 `if (g.current && g.canKeepStream())` 改为 `if (g.canKeepStream())`（自动切歌时 `current` 已被 `streamEngine` 置空，旧判据会误走 `stream/end` 档）—— 过门禁即只 `clearPlayback()`，否则（legacy 在场）只 `finishPlayback({ silentState: true })`；后台起播失败回调同改 `silentState`（失败即跳歌属过渡，不报 stopped）。
- **`backend/src/services/sendspin/server.ts`**：`canKeepStream()` 默认口径**翻转为 MA 严格档** —— 组内任一 legacy 成员在场即整组退回 `stream/end` 档；`MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY=1` 仅作临时强制放开阀（默认不设）。**删除 `flushAnnounceFor()` 内 v4.6.39 的兜底 `stream/clear`**（过渡期既不再发 `stream/end` + `stopped`，无需 clear 解 IDLE 闩锁；keep_stream 路径的 clear 由起播侧 `clearPlayback()` 负责）。

### Test / 回归守卫

- **`trackChangeKeepStream.test.ts`**：门禁用例改为「默认 = MA 严格档」（空组 / 含 legacy 一律 false）；原「默认放行」用例改为 `KEEP_STREAM_LEGACY=1` 强制放开；legacy 切歌用例断言改为「只发 `stream/end`、绝不 `stream/clear`」；**删除 P3 兜底用例组**。
- **`trackChangeStoppedSequence.test.ts`**：去掉强制 `KEEP_STREAM_LEGACY=0` 的 env 覆盖（默认即严格档），保留「切歌窗口内不出现 `group/update{stopped}`」断言。
- **`pumpEncoderDeath.test.ts`**：自然曲终不再直接 `finishPlayback` —— 断言改为 `finished === 0`。
- **`pumpErrorState.test.ts`**：异常终止契约改为「只置空 current、不 `finishPlayback`」，断言改 `finishedAt() === 0`。
- **`tests/sendspin/streamEngineGaps.test.ts`**：自然曲终 / `linkDied` / 窗口 EOF 三例断言由 `finished === 1` 改 `0`（外抛 catch 例仍 `1`）。
- **`childMain.test.ts`**：为 `asPlayableGroup` 假组补齐 `canKeepStream() => false`（过渡分支新判据会调用它，假组缺此方法会 TypeError）。
- **`.github/workflows/sendspin-guard.yml`**：P2 判据同步为 `if (g.canKeepStream()) {`；**删除过渡用的 P3 步骤**，新增 **P3「过渡期不得报 stopped」**：钉死 `playerCore` 两处过渡分支走 `finishPlayback({ silentState: true })`、且 `streamEngine` 不得再出现裸 `finishPlayback()`。

## [4.6.39] - 2026-10-19

### Fix / Sendspin 自动切歌起播无声（新流宣告前补发 `stream/clear` 兜底）

真机（esp32-player2，ESPHome 明文 legacy 客户端）报「自动切歌后无声，拖动进度条 seek 才出声」。报文级埋点把判别点钉死：**无声样本的 `group/update->playing` 距 `stream/start` 只有 152 / 199 / 344 / 352 / 1067ms，且前面都发过 `group/update -> stopped`；正常样本则是 3081 / 5070ms；手动 seek 出声那次仅 48ms 且前面没有 stopped。**

根因：上一轮走 `finishPlayback` 的 else 复位分支时发出 `stream/end` + `group/update -> stopped`，真机固件把 stopped 镜像成组播放器 IDLE，约 2s 内不再接受 `stream/start`。而服务端把 `stream/start` 绑在「首个音频帧产出」上，本地快源 0.15~1.0s 就产出首帧 ⇒ start 太早，被固件 `pending_start_` 吞掉 ⇒ 报文链路全绿但**无声**，且坏态**跨曲目持续**，直到一次 `stream/clear` 才解闩锁（这正是拖动 seek 能立刻出声的原因）。

- **`backend/src/services/sendspin/server.ts`**：`SendspinGroup.flushAnnounceFor()` 在 `announceStream()` **之前**补发一条 `stream/clear`。落点刻意选在此处而非起播侧的 `clearPlayback()` —— 那里新连接尚未入组、与 start 的间隔不可控；而真机实测 clear 必须与 start **紧邻**（seek 路径 48ms 即出声）。对 keep_stream / late-join 路径只是多一次无害的重复 clear。诊断日志只落解码调试日志（`recordSendspinDebug`，插件 `debug_log` 开关，默认关），不进常态 console。
- **口径说明（重要）**：这是**保守兜底**，不是 MA / `aiosendspin` 的标准语义 —— 那边过渡期根本不发 `stream/end` + `stopped`（`clear()` 只发 `stream/clear`；`stop(keep_stream=True)` 跳过 `stream/end`；`group/update(stopped)` 只有「自然曲终且未取消」才走）。本版先守住已复现症状的修复；下一步按 MA 方向做「自动切歌 keep_stream 连续化」，届时 `finishPlayback` 的 else 复位分支与本处兜底 clear 一并移除。

### Test / 回归守卫

- **`backend/src/services/sendspin/trackChangeKeepStream.test.ts` 新增 P3 用例组（4 条）**：纯内存断言 `flushAnnounceFor` 的**报文序** —— ①`["stream/clear","stream/start"]` 顺序不可倒置；②重复入队只兑现一次；③设备明确报 `available:false` 时既不 clear 也不 start 且条目留队重试；④成员不在待宣告队列时不得凭空补 clear。
- **既有 P2 用例「legacy 安全阀绝不发 stream/clear」按现场证据修正**：该断言源自 MA `playback.py:405-423` 的保守假设（legacy 客户端「可能」误处理 `stream/clear`），但真机 esp32-player2（`legacy=true`）实测恰相反 —— 它需要一条与 start 紧邻的 `stream/clear` 解固件 IDLE 闩锁；故兜底 clear **对 legacy 成员同样下发**，断言改为「clear 只出现在 `stream/end` 之后、且紧邻 `stream/start` 前」。
- **`.github/workflows/sendspin-guard.yml` 新增 P3 步骤（过渡契约）**：从 `flushAnnounceFor` 函数体内取 `stream/clear` 与 `announceStream()` 的行号，断言 clear 存在且**早于** start（顺序倒置 / 删掉兜底一律判红）。MA 对齐改造落地后本步骤随兜底一并移除。

## [4.6.38] - 2026-10-19

### Feat / 媒体源扫描进度实时化 + 每源每日定时增量扫描

此前扫描进度**只存在于批量子进程 IPC 回调的瞬时载荷里**：手动点按 `POST /v1/sources/:id/scan` 时前端自己起一个「谁发起谁轮询」的轮询赌一把；定时扫描则直接调 `runBatchJob` 且**不传 `onProgress`** —— 既不写进程内状态也无进度。于是「定时或其它标签页触发的扫描」在前端**什么都看不到**，只能在完成后拿到最终态。本版把扫描实体收口到一份可查询的共享状态，并将定时扫描接入同一入口。

- **`backend/src/services/source/scanRunner.ts`（新增）**：把「发起一次扫描 + 记录实时进度 + 收尾」收口到一处，供手动与定时两条路径共用。`scanJobs` Map 保存 `{status, startedAt, finishedAt, progress, result, error, mode, trigger, controller}`；`startSourceScan()` 先置 running 态，再接批量子进程 IPC：`{stage:"scan", ...ScanProgress}` 写入 `job.progress`，`scrape-*` 载荷旁路回调用方（保持既有 `scrapeJobs` 语义逐字不变）；`completed / stopped / failed` 三态收尾（外层 `aborted` 或 signal 已 abort 判 stopped）。扫描计数按 batch 作业的**真实双层载荷**解一层 —— `scanHandler` 返回 `{result, aborted, scrape}`，故取 `result.result` 才是 `{added, updated, removed, skipped, failed}`（少解一层会让前端计数恒为 0、失败告警永不弹）。30min TTL 清扫（`running` 态不清，**TTL 自完成时刻 `finishedAt` 起算而非 `startedAt`** —— 大库扫描常跑超 30min，若按开始时刻计时，任务一收尾就会被下一次清扫立即删除、前端 3s 轮询整段错过终态）；清扫抽成可注入时间的 `sweepScanJobs()` 便于单测；定时器 `unref`。
- **`backend/src/services/source/scanScheduler.ts`**：每日定时增量扫描改走 `startSourceScan(trigger:"auto")` —— 定时扫描的实时进度同样落进共享状态，前端聚合轮询即可读到。新增**让渡语义**：该源已在跑（手动点按 / 上一轮排队）时 `continue` **且不落 `lastRunAt` 标记**，下一 tick 再判，避免「当天定时被一次手动扫描顶掉而静默漏跑」。
- **`backend/src/routes/api/sources.ts`**：`POST /v1/sources/:id/scan` 改走 `startSourceScan`；并发闸改 `isSourceScanRunning(id)`；新增聚合接口 **`GET /v1/sources/scan-status`**（一次返回全部源状态，外发前摘掉 `controller`），前端不再依赖「谁发起谁轮询」；`POST /v1/sources` 补上与 `PUT` 同口径的 `sanitizeScanAuto`（非布尔 / 非法 `HH:mm` 一律删除，防开关回传脏值落库后调度器静默不触发）。
- **`backend/src/routes/api/shared.ts`**：`scanJobs` / `SCAN_JOB_TTL_MS` / `scanJobsSweep` 转出到 `scanRunner.ts`，保持既有引用面不变。
- **`frontend/src/views/admin/Sources/index.vue`**：改为**常驻 3s 轮询**聚合接口（`onMounted` 起、`onUnmounted` 清），任何触发方式的扫描都能实时显示进度；`loadSources()` 重载时保留 `_scanning / _scanProgress / _scanTrigger` 运行态，避免轮询刷新把已显示的进度抹掉而闪烁；新增与编辑对话框各加「定时增量扫描」开关 + `HH:mm` 时间选择器（**仅增量，不提供定时全量** —— 产品定调）；卡片显示定时状态摘要，进度区对 `trigger==="auto"` 显示「定时」来源标签；完成态按 `completed / stopped / failed` 分别弹 toast。
- **`frontend/src/locales/{zh-CN,en-US}.json`**：`admin.sources` 补 7 个键（双语 parity）：`autoScan` / `autoScanHint` / `autoScanOff` / `autoScanOn` / `autoScanTime` / `autoScanTimePlaceholder` / `autoTriggered`。

### Test / 回归守卫

- **`backend/tests/source/scanScheduler.test.ts`（新增，16 用例）**：覆盖类型闸 / 开关闸 / config 非法 / 当日已跑 / 未到点 / 已在跑让渡（不落标记）/ 正常触发（落 `lastRunAt` + `trigger=auto`）/ 异步收尾 completed；`startSourceScan` 覆盖并发让渡、`scan` 与 `scrape-*` 载荷分流、completed / failed / stopped 三态收尾；`sweepScanJobs` 覆盖「跑超 TTL 的长任务收尾后仍按 `finishedAt` 保留满 TTL、`running` 永不删」（若 TTL 退回按 `startedAt` 计时，该用例即变红）。mock 的 `runBatchJob` 按**真实双层载荷**构造（`{result:{result,…},aborted,scrape}`），防止「少解一层」被假绿掩盖。
- **`backend/scripts/check-source-scan.mjs`（新增，39 条断言，零依赖 node）**：正向钉死 `scanRunner` 的进度落点 / 三态收尾 / `result?.result` 解层 / 清扫 TTL 自 `finishedAt` 起算、定时走 `startSourceScan` 且 `trigger:auto`、聚合接口与 `sanitizeScanAuto` 接线、前端常驻轮询与定时配置 UI；反向 `mustNotMatch` 钉死定时与路由不得退回直调 `runBatchJob`、`startProgressPolling` 不得复活；`mustOrderBefore` 钉死「并发让渡判定必须早于 `setSetting`」。**已做双向变异验证**（改坏必红）：抹掉进度落点 / 聚合路由改名 / 轮询间隔改动 / 定时退回 `runBatchJob` / 少解一层 `result` / 让渡与落标记顺序颠倒 / 清扫 TTL 退回 `startedAt`，七项变异均判红，还原后基线 39 条全绿。
- **`.github/workflows/ci.yml`**：新增 `source-scan-guard` 作业（零依赖、秒级）。

## [4.6.37] - 2026-10-19

### Perf / 首页首屏外呼分层（下半屏与流转播放初始化改为「首屏绘制后自动延迟拉」）

承接 4.6.34 的首页提速。浏览器实测首屏会**同时**发出 14 条 XHR，其中真正进关键路径的只有 3 路：歌单（`loadPlaylists`，顶部并排随机卡与占位都直接由它派生）、首页配置（`loadHomeConfig`）、固定推荐卡（`loadHomeCards`）。另外三路全在首屏抢 HTTP/1.1 同源的 6 条连接：流转播放初始化会打**两次全量 `/v1/peers`**（实测单次 809ms / 329KB，之后每 20s 还轮询一次）、平台精选 `/v1/recommend`、本地随机 `/v1/local-recommend`（容器重启后冷启动实测 3.7s，插件沙箱装载）。抢连接的代价就是首屏内容整体往后挤。

- **`frontend/src/views/Home/index.vue`**：`onMounted` 的即时并发收窄为上半屏 3 路；`loadLocalRandom` 与 `loadRecommend` 改由 `scheduleLowerSections()` 排期 —— 上半屏数据到位并 `await nextTick()` 提交一次渲染后，用 **rAF 双帧**（≈等到下一次真实绘制之后）开跑，并加 **1s 兜底定时器**（后台标签页会暂停 rAF，否则永不加载）。刻意不用视口/滚动触发：用户不滚动就永不加载，且滚动那一刻才付冷启动延迟。`onActivated` 在 `lowerStarted` 之前直接返回（keep-alive 首次激活钩子紧随 `onMounted` 触发，抢跑会让「延迟拉」当场失效）；`onDeactivated` 的后台暂停语义、`pending` 轮询自愈（8s×18 / 8s×6）、`loading` 复位全部不变。
- **`frontend/src/layouts/MainLayout.vue`**：流转播放初始化（`restoreCast` → `initLocalPeer`，原两步时序逐字保留）收敛进 `initPlayerPeers()`，由 `schedulePlayerPeers()` 以同样的 rAF 双帧 + 1s 兜底在首屏绘制后触发。功能不变，只是设备列表 / WS 晚约 1s 就绪；`restoreCast` 抢占 `currentPeerId`、`startLocalPeersPoll` 的 20s 轮询、WS `peer_snapshot` 兜底恢复等行为全未改动。
- **未做**：不裁剪 `/v1/peers` 返回体。本轮症状是「首次初始化被抢连接」，把初始化整体挪出首屏即消除；裁 `queue.items` 会连带 WS 侧 `summarizeQueue` 的截断语义一起改，属另一条独立契约，不在本次范围。

### Test / 回归守卫

- **`backend/scripts/check-home-perf.mjs` 新增 R5（31 → 42 条断言）**：正向钉死 `Home.scheduleLowerSections` 存在、首屏即时并发**恰好**是 `Promise.all([loadPlaylists(), loadHomeConfig(), loadHomeCards()])`、rAF 双帧与 `setTimeout(startLowerSections, 1000)` 兜底在位；反向 `mustNotMatch` 钉死 `loadLocalRandom` 不得回到即时并发、`const slow = loadRecommend()` 不得复活；`MainLayout` 侧钉死 `initPlayerPeers` 存在、rAF 双帧入口在位、卸载时 `playerPeersDisposed = true` 的清表在位，且 `await playerStore.restoreCast()` 与 `playerStore.initLocalPeer()` 各**只出现一次**（只能待在延迟入口里）。**已做双向变异验证**：把两处改回「打开即并发」后 R5 报 4 项违规判红，还原后基线 42 条全绿。
- **`.github/workflows/ci.yml`**：`home-perf-guard` 作业名与步骤描述同步补「首屏外呼分层」。

## [4.6.36] - 2026-10-19

### Fix / 下载产物 comment 改为「声明 + 源实测」双口径

音乐文件内嵌的 `comment` 标签此前只记录信源**声明**的音质档位，于是出现「声明 mp3/128kbps、文件却在无损目录」的观感冲突：240 实测《Self Redemption》落入 `/MUSIC/LOSSLESS`，成品 flac 有效码率 817kbps，而 comment 写的是「声明音质:mp3/128kbps」——用户据此以为「128K 的歌被错放进无损目录」。真实成因是平台侧**虚标**（酷狗把无损源声明成 mp3/128，见 `extra` 音质阶梯），下载后内容嗅探判定 flac、有效码率 817，按既有判据（`isLosslessGradeSource` 取**转码前源探针**）正确落无损根。问题不在分流，而在「comment 只写了一个口径，无法自证分流依据」。

- **`backend/src/services/fetch/orchestrator.ts`**：comment 组装由单口径改为双口径 —— `来源:<平台> 声明音质:<cand.declared> 源实测音质:<probed> 取链时间:<ISO>`。
  - 「声明音质」= 信源声明值（平台说给了什么）；「源实测音质」= 下载后对**源文件**的真实探针（我们实际拿到什么），与品质分流判据用的是**同一份** `probed`。
  - 未采用「成品探针」口径：标签在转码前写入源文件、再由 `transcode` 的 `keepTags` 带入成品，若为拿成品口径而在转码后二次 `writeTags`，会多一次 ffmpeg 写标签、多一条 `TAG_FAILED` 失败路径；且转码只做换封装/响度归一，不改变「源站到底给了什么」。
  - 「实测」一词锚定为「源」而非「成品」，避免出现新矛盾：默认配置下（`transcodeEnabled=true`、`transcodeTarget="flac"`、响度归一化默认开启 → `transcode.ts` 的 skip 条件几乎不成立）成品容器恒为 flac，若写「实测音质:mp3/128kbps」会与文件名 `*.flac` 再次对不上。
- **`backend/src/services/fetch/tagWriter.ts`**：`applyTagsVariant` 文档注释同步为「来源/声明音质/源实测音质/取链时间」（comment 仍不参与简繁转换）。
- **兼容性**：仅新写入的文件带双口径；历史文件的单口径 comment 照旧原样保留（无解析方，`songs.comment` 为整串透传）。标签修复路径**不设置** comment，重写时经 `-c copy` 原样继承，双口径不会被修复流程抹掉。

### Test / 回归守卫

- **`backend/scripts/check-tag-repair.mjs` 新增 R13（64 → 67 条断言）**：正向两条（`声明音质:${describeQuality(cand.declared)}` 必须在位；`源实测音质:${describeQuality(probed)}` 必须在位）+ 反向一条（`mustNotMatch` 钉死「只写声明音质」的单口径旧写法），双向锁定防退回。
- **`backend/tests/fetch/orchestrator.gaps.test.ts` 新增 G33**：构造「声明 mp3/128、探针实测 flac/817」的不一致候选，断言写进文件的 comment 同时含 `声明音质:mp3/128kbps` 与 `源实测音质:flac/817kbps`。

## [4.6.35] - 2026-10-18

### Fix / 运行身份（compose 模板不再出现 PUID / PGID）

本版把「应用以 root 运行」从**需要用户手动配置**变为**默认行为**，于是 compose 模板里那两行 `PUID` / `PGID` 得以彻底删掉（它们的默认值本就是 0/0，写在那里只会让人困惑「为什么非得手写一个 PUID=0 才能跑」）。

- **`backend/entrypoint.sh`：默认身份改为「当前进程身份」**（`$(id -u)` / `$(id -g)`，不再回退到镜像内 `musicflow` 用户的 100/101）。镜像不设 `user:` 时 entrypoint 由 root 调用，故默认即 root —— 与历史生产配置（`PUID=0` / `PGID=0`）逐字等价。
  - 绑定挂载错属主探测里的 `chown -R` 追加「当前身份为 root」前置条件：非 root 启动时目标身份即当前身份、既无必要、权限也不足，加条件避免被 `set -e` 打死（预装插件的 `chown -R` 同理）。
  - 末段降权逻辑由「`PUID=0` 不降权 / 否则 `su-exec`」改为「目标身份 == 当前身份则直接 `exec`，仅身份确实不同才走 `su-exec`」——顺带消除非 root 启动下 `su-exec` 的 `setgroups: Operation not permitted` 隐患（music-dl 同款问题的成因）。
- **`docker-compose.yml` / `README.md`**：移除模板中的 `- PUID=${PUID:-0}` / `- PGID=${PGID:-0}` 两行；README「运行身份」小节改写为「默认跟随当前容器身份（默认即 root）；需换身份用 `user: "1000:1000"`；`PUID` / `PGID` 仍可显式覆盖」。
- **向后兼容**：显式传入的 `PUID` / `PGID` 语义与历史完全一致；不传时对「以 root 启动」的既有部署行为不变（仍为 root），对「用非 root 的 `user:` 启动」的部署则由 100/101 变为跟随该身份（更符合直觉，且不再触发 chown / su-exec 报错）。

### Test / 回归守卫

- 新增守卫 `backend/scripts/check-runtime-identity.mjs`（零依赖 node）：钉死 entrypoint 默认值必须是 `$(id -u)` / `$(id -g)`（且不得退回 `echo 100` / `echo 101` 旧回退）、两处 `chown -R` 必须带「当前身份为 root」前置、降权段必须存在「身份一致直接 `exec`」分支、`docker-compose.yml` / `README.md` 模板不得再出现 `PUID` / `PGID` 环境变量行、README 必须给出 `user:` 换身份写法。
- `.github/workflows/ci.yml` 新增 `runtime-identity-guard` 作业（零依赖、秒级）。


## [4.6.34] - 2026-10-18

### Perf / 首页打开速度

本版针对 2026-10-18 首页真实打开实测（`nav.responseEnd 28ms / DCL 91ms / load 93ms / FCP 132ms`）定位到的两处真实卡点做优化：① 浏览器 HTTP/1.1 每域名 6 连接争用（175 个资源中 img **130 张**，同源封面平均 1397ms、最坏 2442ms，第二批 XHR 全部排队到 ~810ms 才拿到连接，q=177~689ms）；② `/v1/local-recommend` 冷缓存时硬等 `LOCAL_PROVIDER_DEADLINE_MS=2500ms` 软截止（生产日志 `[HTTP] WARN 慢请求 route=/rest/api/v1/local-recommend ms=2582/2484/1756/1521/1208`）。服务端本身不慢（封面 39 并发 wall 0.38s / avg 93ms、`getStarred2` ~200ms），故不做无差别加码。

- **#4 `/v1/local-recommend` 冷启动改为后台定时预热**（`backend/src/routes/api/recommend.ts`）：新增 `startLocalProviderWarmer()`（模块加载期启动，幂等、定时器 `unref` 不阻塞进程退出；首轮延迟 4s，此后周期 `min(60s, 最小 TTL/2)`），每轮遍历 `getEnabledByCapability("localPlatformRecommend")` 中**声明了 `recommendCacheTtlSeconds>0`** 的插件，缓存缺失 / 过期时后台 `kickProviderInvoke` 拉取并写入 `providerRecommendCache`。**关键重构**：`kickProviderInvoke` 由 `registerRecommend` 内部提升到模块作用域，与请求路径**共用同一张在途单飞表**——预热与请求、以及前端 8s 轮询 / 多客户端并发，对同一 provider 任意时刻至多一次沙箱调用。请求路径的 2500ms 软截止**保持不变**（预热只是把「每进程首启一次」的确定性冷启动成本挪到无人等待的时间窗口，不放宽请求侧上界）。
- **#3 首页 4 个预热请求合并为 1 个聚合接口**：新增 `GET /rest/api/v1/home/preload`（`backend/src/routes/api/homePreload.ts`，挂 `LIBRARY_BROWSE` + `PLAYLIST_VIEW` 双权限门，响应为最小 ack `{ success: true }` —— 前端本就丢弃这 4 份数据）。服务端逐个触发第一页查询，并**复用**从 `/v1/songs`、`/v1/albums`、`/v1/artists`、`/v1/playlists` 抽出的同一份实现（`buildSongsPage` / `buildAlbumsPage` / `buildArtistsPage` / `buildPlaylistsPage`，原路由退化为薄封装，SQL / 逻辑逐字未改）；单个列表失败仅告警、不影响其它列表与 ack。前端 `frontend/src/stores/preload.ts` 相应改为单条聚合请求。
- **#2 封面懒加载治理**：新增全局指令 `v-lazy-cover`（`frontend/src/directives/lazyCover.ts`，`IntersectionObserver` + `rootMargin:"200px"`），首页 4 处卡片封面改用它——**未靠近视口不设 `src`**，取代原生 `loading="lazy"`（桌面快网阈值过大，实测会把视口附近整屏图片一次性预取，仍是约 130 张）；首页卡片封面尺寸由默认 300 收紧为 `coverUrl(id, 150)`（卡片实际显示约 140~160px；`coverUrl` 的 300 默认值不动，详情页大图不受影响）。
- **收藏加载在途去重**：`frontend/src/stores/favorites.ts` 的 `loadFavorites()` 补闭包级 `inflight` 单飞（保留原 `if (loaded) return`），消除 `MainLayout.vue` 同一处「直接调 + 经 `preloadHome()` 再调」导致的**同一个 `getStarred2`（151KB）并发两次并互相排队**（实测第二次 q≈689ms）。

### 决策 / 审查

- **#1 连接层（启用 HTTP/2 或提高每域名并发）——审查后不做**。结论：浏览器 HTTP/1.1 **每源 6 连接是硬约束**，唯一提升手段是 HTTP/2，而浏览器仅支持 **h2 over TLS**（不支持 h2c 明文）；`h2` 需 HTTPS，会打断已硬编码 `http://192.168.10.240:46400` 的安卓 / Windows 客户端与 HA 集成，属净回归。且 #2 已从**源头**把首屏并发封面请求数从「上屏前一次性 130 张」降到「视口邻近的十几张」，6 条连接即足够、排队不再形成；封面端点本身已具备 `ETag` / `Cache-Control`（revalidate）与端到端背压响应头（`buildCoverPressureHeaders`），无需再加无差别并发。不做即为正确方向，不再提议。

### Test / 回归守卫

- **新增守卫 `backend/scripts/check-home-perf.mjs`（31 条断言，零依赖 node）**：锁定上述四件套的**静默失效契约**——`startLocalProviderWarmer` 必须在模块加载期被调用且定时器 `unref`、`kickProviderInvoke` 只定义一次（预热与请求共用在途单飞表）、预热必须过 `recommendCacheTtlSeconds` 过滤、请求侧 2500ms 软截止保留、`__warmLocalProvidersOnceForTest` 存在、`__resetRecommendRefreshStateForTest` 清 `providerRecommendCache`；`/v1/home/preload` 注册 + 双权限门 + 复用四个 `buildXxxPage`（且 `library.ts` / `playlists.ts` 确有对应导出）；前端 `preload` 不得再逐个请求 `songs/albums/artists/playlists`；`v-lazy-cover` 全局注册、`rootMargin:"200px"`、首页 4 处封面走指令且不得退回 `loading="lazy"` / 默认 300；`loadFavorites` 保留在途单飞。**已做双向变异验证**：预热器不启动 / 封面尺寸退回默认 / 前端退回首屏 4 请求 / 去重被移除 / 少挂一道权限门 / 退回原生 `loading="lazy"` 共 6 组变异全部判红，基线判绿。
- **新增 `backend/tests/routes/homePreloadRoute.test.ts`（3 例）**：鉴权后一次性触发四个列表第一页且四个入参精确（含用户对象透传）、响应体仅 `{ success: true }`、未鉴权不得进入、单列表抛异常仍返回 ack 且不影响其它列表。
- **新增 `backend/tests/qa_perf/localProviderWarmer.test.ts`（6 例）**：声明 TTL 的 provider 预热一次且随后请求命中缓存不再外呼、未声明 TTL 的不预热、缓存仍新鲜不重复预热、TTL 过期后预热重拉、并发两轮预热共享在途单飞（只外呼一次）、预热与请求路径共用单飞表（请求不再额外外呼，且远早于软截止返回非 pending）。
- **`backend/tests/routes/apiScanRead.test.ts`** 将 `/v1/home/preload` 纳入标准只读路由扫描（契约覆盖）。
- **`.github/workflows/ci.yml` 新增 `home-perf-guard` 作业**（零依赖、秒级）。
- 门禁（230 本地复跑，全绿）：`node scripts/check-home-perf.mjs` = 0（31 条）；`node scripts/check-workflow-paths.mjs` = 0；`backend/scripts/check-*.mjs` 全部守卫通过；`npx tsc --noEmit`（backend）= 0；`npx vue-tsc --noEmit`（frontend）= 0；新增用例 **9 例全绿**（`homePreloadRoute` 3 + `localProviderWarmer` 6）。

## [4.6.33] - 2026-10-18

### Test / 回归守卫

- 本版为**纯测试 / 守卫改动**（无运行时变更、源码逻辑不变，故无需热补丁或更新生产镜像），用于给 4.6.32 的「修正 8 续跑进度口径」补上反向守卫与覆盖率证据。
- **`backend/tests/fetch/tagRepair.test.ts` 补 1 例（70 → 71 例）**：新增「续跑·scan 阶段」用例，覆盖 `resumedScan` 分支与 scan 侧的 `progressPhase(preserve=true)` 路径——构造 `phase="scan"` 快照（`pendingIds` 仅留 3 首、库里另有 2 首视作已探完），断言续跑只对快照剩余项做文件头精探（`parseFileMock` 调用数 = 3，另 2 首不重探）、scan 进度分母 = 本段已处理(0) + 本阶段剩余(3) 且未提前冲到 100%、0 候选顺入 repair 收尾后快照被消费清空。
- **续跑用例补「界面待修复」不变量断言**：在「续跑恢复计数」用例中新增 `expect(live.total - live.checked).toBe(1)`，钉死前端「待修复」＝ `total − checked` ＝真实剩余候选数（修正 8 的症状就是该值提前归零）。
- **`backend/scripts/check-tag-repair.mjs` 新增 1 条反向守卫（63 → 64 条）**：`mustNotMatch(/progress\.total = total;/)` —— 与既有 `mustMatch(progress.total = preserve ? progress.checked + total : total;)` 形成**双向锁定**。上一版只在位断言「正确写法存在」，钉不死「别处又冒出一处裸覆盖」（例如另起一条 resuming 分支）时被静默改回旧语义。
- 覆盖率门禁复跑（`npx vitest run --config vitest.coverage.config.ts`，rc=0，阈值全部达标）：`src/services/fetch/**` 语句 96.16 / 分支 88.08 / 函数 98.63 / 行 97.78（上版 95.98 / 88.01 / 98.04 / 97.66）；`tagRepair.ts` 96.13 / 84.64 / 98.59 / 98.63；`tagProvider.ts` 99.02 / 96.98 / 100 / 99.58。
- 门禁：`npx tsc --noEmit`（backend）= 0；`node scripts/check-tag-repair.mjs` = 0（64 条）；`backend/scripts/check-*.mjs` 全部守卫通过；`tests/fetch/tagRepair.test.ts` **71 例全绿**。

## [4.6.32] - 2026-10-18

### Fix

- **续跑进度口径修正（修正 8）**：`progressPhase(phase, total, preserve)` 的 `total` 形参表示的是**本阶段剩余**数，而 `preserve=true`（续跑进入同阶段）时 `progress.checked` 仍保留着「本段已处理」计数。此前实现直接 `progress.total = total` 覆盖，导致续跑时分母小于已处理数 → 管理端进度提前冲到 100%、「待修复」（前端取 `total - checked`）提前归零，而实际仍有大量候选在跑（240 生产实测：分母 14293、已处理 793 时界面已显示 100%/待修复 0）。现改为 `progress.total = preserve ? progress.checked + total : total`，续跑分母 = 本段已处理 + 本阶段剩余，进度与「待修复」与真实剩余一致。非续跑路径（`preserve=false`）行为不变。

### Test / 回归守卫

- **`backend/tests/fetch/tagRepair.test.ts`**：在「续跑恢复计数」用例中新增分母断言 `expect(live.total).toBe(6)`（快照已处理 5 + 剩余候选 1），钉死续跑分母口径（此前无断言 → 覆盖式实现可静默通过）。
- **`backend/scripts/check-tag-repair.mjs`** 新增 1 条 R11 守卫：必须存在 `progress.total = preserve ? progress.checked + total : total;`（62 → **63 条检查**）。
- **CI 全量门禁稳定性**：`backend/vitest.config.ts` 新增 `testTimeout: 20000`。根因是 `tests/plugins/tagProvider.test.ts` 的 QQ 请求限流用例**刻意真实等待** 1.2s + 300~800ms 抖动，在 CI 负载下超出 vitest 默认 5000ms 单测超时被误判失败（同一 commit 的 `ci` 作业同命令全绿、`build-and-push` 作业全红即为佐证，见 v4.6.31 的 tag 构建失败并触发回滚）。仅抬高上限，不改变任何用例的执行语义。

## [4.6.31] - 2026-10-18

### Feat

- **标签修复支持「断点续跑」（容器重启后自动接着当前进度继续）**：新增进行中一轮的运行快照，持久化到 settings 的 `fetch.tagrepair.activeRun`（`version:1`；`mode` / `dirScope` / `phase`（scan|repair）/ `startedAt` / `updatedAt` / `checked` / `fixed` / `skipped` / `unobtainable` / `pendingIds`（当前阶段剩余待处理清单）/ `candidateIds`（scan 阶段累计命中）/ `currentFsPath` / `stopped`）。media / all 两个挡位在跑动过程中按节流落盘（每 100 首或距上次 30s，阶段切换 / 停止 / 正常收尾强制落盘；`pendingIds`/`candidateIds` 容量上限 20000 兜住超大库）。进程被杀 / 容器重启后，`src/index.ts` 启动 `TAG_REPAIR_RESUME_DELAY_MS`（60s）后调用 `resumeInterruptedTagRepair()`：无快照不续、标记 `stopped` 的快照（用户主动停止）清除后不复活、已在跑不重复起，否则从快照剩余候选断点续跑——**不重头计数、不重跑已完成的候选**（repair 阶段直接取快照 `pendingIds`，不再重跑 DB 预筛 / 全量精探）。调度器 tick 在 `hasResumableActiveRun()` 为真时跳过定时兜底，避免首个 15s tick 抢在 60s 续跑前把同一轮重跑。
- **管理端新增「立刻停止」标签修复按钮（协作式停止）**：新增 `POST /v1/fetch/tag-repair/stop`（`adminMiddleware`，未在跑时返回 `stopped:false`，不报错）。`stopTagRepair()` 置停止标志后，sweep 的循环头（探针循环与逐首修复循环）立刻退出——正在处理的**那一首**跑完后不再开始下一首（`tagtmp`→`rename` 原子写保证已写盘的那首不损坏，未写的半成品 `tagtmp` 在停止时按 `currentFsPath` 精确清理）；并把快照落盘标 `stopped=true`（boot 恢复识别为「主动停止」不复活），同时顺延 `fetch.tagrepair.lastRunAt` 一个周期（避免刚停 ≤60s 又被定时常规扫拉起）。`GET /v1/fetch/tag-repair` 新增 `stopping`（停止中）/ `stopped`（快照已标停止）/ `resumable`（存在可续跑快照）/ `activeRun`（进行中快照）四个字段供前端三态展示。
- **前端（admin/Fetch 标签修复卡片）**：状态行改三态标签（修复中 / 停止中… / 已停止）+ 新增「立刻停止」按钮（`v-if` 仅在运行中显示、停止中禁用、带 loading），点击弹**二次确认**（`ElMessageBox.confirm`，逐条说明四条后果：本首跑完后退出、已完成的不重跑、标记为已停止重启不自动续跑、定时常规修复顺延一个周期）；新增 resumable / stopped 提示行；zh-CN / en-US 双语新增 11 个 key（`stopBtn` / `stopConfirm` / `stopConsequence1..4` / `stopRequested` / `stopping` / `stoppedLabel` / `stoppedHint` / `resumableLabel`），简繁统一。

### Test / 回归守卫

- **守卫 `backend/scripts/check-tag-repair.mjs` 新增两组契约断言**：R11「断点续跑」（19 条：快照键与 `version:1` 结构、`saveActiveRun`/`loadActiveRun`/`clearActiveRun`/`checkpoint` 节流、`MAX_SNAPSHOT_IDS` 上限、boot `resumeInterruptedTagRepair` 的「无快照不续 / `stopped` 不复活 / 已在跑不重起」、续跑直接取 `pendingIds` 不重跑预筛、调度器 `hasResumableActiveRun` 防抢跑、`finally` 异常清残留快照不顶住调度器）；R12「立刻停止」（9 条：`stopTagRepair` 非运行时 `requested:false`、置 `stopRequested` + 快照标 `stopped` 并立即落盘、顺延 `lastRunAt`、`cleanupTagTmp(currentFsPath)`、探针与修复两个循环头均检查停止标志、`POST /tag-repair/stop` 接线）。守卫检查数由 25 条升至 **62 条**（只认非注释行，内联计数自检；R12 反断言用 `/export async function stopTagRepair/` 而非泛匹配 `runTagRepairOnce`，避免误报源码里合法存在的续跑调用）。
- **`backend/tests/fetch/tagRepair.test.ts` 新增 `describe("续跑快照 / 立刻停止")` 13 例**（57 → **70 例**）：快照落盘 / 读回、版本不符或 JSON 异常回落 null、boot 续跑从快照剩余候选接续（不重头计数）、`stopped` 快照不复活、已在跑不重复起、正常跑完清快照、进程内异常退出清残留快照（避免永久顶住调度器）、`stopTagRepair` 未运行 / 运行中两分支、停止后未完成候选留在快照 `pendingIds`、续跑剔除已从库中消失的脏 id。
- 门禁：`npx tsc --noEmit`（backend）= 0；`npx vue-tsc --noEmit`（frontend）= 0；`node scripts/check-tag-repair.mjs` = 0（62 条）；`backend/scripts/check-*.mjs` 全部守卫通过；`tests/fetch/tagRepair.test.ts` **70 例全绿**；`npx vitest run --config vitest.coverage.config.ts` 全绿且阈值达标（fetch 95.98 / 88.01 / 98.04 / 97.66，tagProvider 99.02 / 96.98 / 100 / 99.58）。

## [4.6.30] - 2026-10-18

### Test / 回归守卫

- **新增「下载任务取消 / 停止链路」静态守卫（CI 阻断，`backend/scripts/check-fetch-download.mjs`）**：把两套停止语义钉死。取消（排空式）＝停止准入新条目，但在途下载 / 缓存待转码的歌**必须走完并落地**；完全停止（硬终止）＝彻底终止整个流程（含掐断自动续批链）。逐条断言：`jobRunner` 必须同时持有 `hard`（硬停）与 `drain`（排空）两个 `AbortController` 且成对登记（`controllers.set`）；`drain` 触发后不再开新片、本片走完即排空收尾，且 `drain` 信号必须透传子进程（`runBatchJob` 的 `drainSignal` / `{ type: "drain" }`，不得误挂 killTimer）；`hard` 触发即补写 `cancelled` 终态（`"用户完全停止"`）并**掐断自动续批链**（`hardStopped` 传入 `maybeContinue{Upgrade,Library}Job`）；收尾只允许在 `pending`/`running`/`cancelled` 上落 `cancelled`（**绝不把 `done` 降级**）；未出现在 items 的 target 必须补写「任务已取消（未开始）」且 `counts.total` 对齐；boot 恢复延后 60s（`BOOT_RESUME_DELAY_MS`）且跳过本进程已在推进的 job；续批链的「无进展 / 零尝试」保护与**清会话标记**（`setAutoSession`）不得被删；`/cancel→drainFetchJob`、`/force-stop→abortFetchJob` 接线与前端取消 / 完全停止**二次确认弹窗**（i18n `cancelConfirm` / `forceStopConfirm`，zh/en 对齐）逐处钉死。
- **新增「标签写入 / 修复链路」静态守卫（CI 阻断，`backend/scripts/check-tag-repair.mjs`）**：碟号纪律（`buildTagArgs` 必须显式 `-metadata disc=` 清空继承值，且**不得写入任何碟号值**——成品不写也不留 `DISCNUMBER`/`DISCTOTAL`）；修复期 `writeTags(fsPath, tags, { keepSourceCover: true })` **恒开**（补 `genre`/`track` 的重写绝不能静默丢内嵌封面），下载期按 `embedCover` 保留源封面（`-map 0:v?` 可选映射不得删）；简繁字形转换收敛到唯一实现 `applyTagsVariant` 且**下载期与修复期两条写入路径都必须调用**（默认简体）；真缺标签但各来源都拿不到的歌必须落 `outcome='unobtainable'` 标记且带 **30 天 TTL**（`UNOBTAINABLE_TTL_MS`，超期放行重探）；待修 `pending` 必须 = 预筛集合 − 已落标记集合（`getTagRepairMarkedPaths`，纯 DB 不 stat）；容器白名单 + 原子写（`tagtmp`→`rename`，绝不原地覆盖）+ mp3 `-id3v2_version 3`；QQ 搜索必须用 `search_for_qq_cp`（**禁止退回 `client_search_cp`**）、限流 1.2s + 300~800ms 抖动；`genre` 取自 `info.genre.content`（不得用 `track_info.genre` 数字码）；时长单位统一为**秒**（网易云 ms→s `/1000` 换算不得删）。
- 两个守卫均只认**非注释行**（复用 `lib/strip-comments.mjs`，注释里提符号不算接线），且各自做了 **10 处双向变异验证**（改坏对应契约 → 守卫必红）。原因：这两条链的破坏全是**静默失效**——断了不报错、不会让任何既有动态用例变红，只会让任务行永久卡 `running`、把已完成降级成已取消、让自动续批链无限复活，或产出脏碟号 / 静默丢封面 / 候选池永不收敛。
- **新增「下载 + 标签修复」独立覆盖率门禁（CI 阻断）**：新增 `backend/vitest.coverage.config.ts`——只跑本链路测试（`tests/fetch/**` + 内置标签来源测试），对 `src/services/fetch/**` 与 `src/services/plugin/tagProvider.ts` 设**硬阈值**（`fetch`：语句/行 ≥93%、分支 ≥84%、函数 ≥95%；`tagProvider`：语句/行 ≥95%、分支 ≥90%、函数 ≥96%），破了即红。之所以独立成一份配置而不在主配置里加 glob 阈值：主配置被 `sendspin-guard` / `playback-chain-guard` 等**子集**作业复用，glob 阈值会对空集合判 0% 而假红（`enabled: true` 亦显式开启采集——否则 `thresholds` 永不评估、门禁形同虚设）。
- **补齐本链路单元测试抬高覆盖率**：新增 `tests/fetch/jobRunner.test.ts`（42 例，行覆盖 ~53% → **99.4%**、分支 ~43% → **88.2%**）、`tests/fetch/tagRepairMarker.test.ts`（9 例，行 → **94.3%**）、`tests/fetch/config.test.ts`（21 例，行/分支 → **100%**）、`tests/fetch/tagWriter.failure.test.ts`（10 例，mock `node:child_process` 的 spawn，不真跑 ffmpeg）；扩充 `tagRepair.test.ts`（34 → 57 例，行 87% → **99.7%**、分支 72% → **86.9%**）、`tagWriter.test.ts`（11 → 19 例，行 → **100%**、分支 → **96.1%**）、`writable.test.ts`（9 → 13 例，行 56% → **91.2%**）、`deadSongPurge.test.ts`（+4，行 81% → **90%**、分支 57% → **75%**）、`integrity.test.ts`（+9，行 → **91%**、分支 → **81%**）、`finalize.test.ts`（+6，行 → **81%**）、`jobStore.test.ts`（+6，行 → **100%**）。全部 `vi.mock` 打桩、零真实网络 / ffmpeg。
- **第二轮覆盖率补强（把本链路可用覆盖率推到位）**：新增 `tests/fetch/libraryScheduler.test.ts`、`tests/fetch/upgradeScheduler.test.ts`、`tests/fetch/transcode.unit.test.ts`（mock `node:child_process`，不跑真 ffmpeg）、`tests/fetch/orchestrator.gaps.test.ts`、`tests/fetch/sniff.test.ts`，并原地扩充 `naming.test.ts`、`candidates.test.ts`、`importTrigger.test.ts`、`deadSongPurge.test.ts`、`finalize.test.ts`、`tests/plugins/tagProvider.test.ts`（既有用例零删除）。门禁范围内由 **fetch 89.04 / 79.5 / 96.12 / 92.05** 提升至 **fetch 96.43 / 88.42 / 98.77 / 97.87**，**tagProvider 83.81 / 64.52 / 95.45 / 92.94** 提升至 **99.02 / 96.98 / 100 / 99.58**（语句 / 分支 / 函数 / 行），据此把硬阈值上提到上面的档位。单文件看点：`libraryScheduler` 行 74% → **100%**、`upgradeScheduler` 行 70% → **100%**、`transcode` 行 84% → **100%**（分支 99.3%）、`orchestrator` 行 84% → **99.8%**、`importTrigger` 分支 71.7% → **97.8%**、`sniff` 分支 74.4% → **100%**、`tagProvider` 分支 64.5% → **97.0%**。
- **CI**：`ci.yml` 新增 `fetch-download-tag-repair-guard`（跑两个新守卫）与 `fetch-coverage-gate`（跑独立覆盖率门禁）两个 job；文件头补第 13/14/15 条说明。
- 门禁：`npx tsc --noEmit`（backend）= 0；`npx vue-tsc --noEmit`（frontend）= 0；`npx vitest run --config vitest.coverage.config.ts` 全绿且阈值达标；全部 `check-*.mjs` 守卫（含新增 2 个 + 路径元守卫）通过。`package.json` 新增 `test:coverage:fetch` 脚本（本地跑同一门禁）。

## [4.6.29] - 2026-10-18

### Fix

- **管理端「待修复」数字随池子收敛（口径剔除已落标记）**：`GET /v1/fetch/tag-repair` 的 `stats.pending` 取 `selectMediaMissingRows()`（纯 DB 预筛），**不剔除已落完成标记的歌** → 池子实际在收敛（扫描阶段 `isTagRepairMarked` 会跳过已标记的歌），但界面「待修复」随修复 / 标记推进长期停在原位（240 生产实测：`待修复` 恒 3447 不动，而 `终态不可得` 随标记写入上升，两张卡并列时数字自相矛盾）。现改为 `pending` = 预筛集合 **减去**「已落完成标记的 `fs_path`」集合（新增 `getTagRepairMarkedPaths()`，纯 DB 读取、**不 stat**；含 `outcome='fixed'` 与 `'unobtainable'` 两类，与扫描阶段的跳过口径对齐）。失效判定（size / mtime 变化）仍由扫描阶段 `isTagRepairMarked` 负责，故本次**只改展示口径、不动修复行为与写盘逻辑**。

### Docs

- **补齐随仓库分发的运行身份开关（`PUID` / `PGID`）**：`entrypoint.sh` 已支持 `PUID` / `PGID`（容器内运行身份），但 `docker-compose.yml` 与 `README.md` 内嵌的 compose 示例**均未列出这两个变量**。现于两处 `environment:` 段补齐 `- PUID=${PUID:-0}` / `- PGID=${PGID:-0}`——**默认 `0:0`（root）与生产环境一致**，避免「库内条目属主非应用 uid → 写标签报 `ffmpeg 写标签失败(exit=243) Permission denied`」导致的写入失败。README 新增「运行身份（PUID / PGID）」小节简述默认 root 及可用变量覆盖。

### 测试

- `tagRepair.test.ts`（34 例）新增 1 例：某歌 DB 缺歌词 / 封面但已登记完成标记 → `stats.pending` 不计入（`total=1` / `pending=0` / `unobtainableTotal=1`）。
- 门禁：`npx tsc --noEmit`（backend）= 0；`tests/fetch/tagRepair.test.ts` **34 例全绿**；`npx vue-tsc --noEmit`（frontend）= 0；`backend/scripts/check-*.mjs` 全部 14 个守卫通过。

## [4.6.28] - 2026-10-18

### Feat

- **标签「终态不可得」标记（选项 C·候选池收敛）**：真缺标签但各来源都拿不到的歌（`unobtainable`）此前**一律不写标记** → 每轮扫描都把它当候选重探、重扫（生产实测失败率约 96%、候选池永不收敛）。现改为：返回 `unobtainable` 前在 `tag_repair_done` 登记一行，新增 `outcome` 列（`'fixed'` 已达标 / `'unobtainable'` 终态不可得；`ALTER TABLE ADD COLUMN` **幂等**补列，旧库既有行 **回填 `'fixed'`**，`CREATE TABLE IF NOT EXISTS` 对既有表不补列故显式补；drizzle 镜像 `db/schema.ts` 同步加列）。下轮扫描命中该标记即跳过（池子一轮收敛）。**安全阀**：`unobtainable` 标记带 **30 天 TTL**，超期后 `isTagRepairMarked()` 返回 `false` 允许重探（防断网 / 平台抽风把整库永久标记，且可自愈；超期**不删行**，仅在命中判定上放行）。口径同步收紧：`unobtainable` 行**不计入**「已修复」（`getTagRepairMarkedCount()` 排除之），也**不参与**「标签来源分布」聚合（`getTagRepairPlatformCounts()` 排除之）；`TagRepairStats` 新增 `unobtainableTotal`（= `outcome='unobtainable'` 行数），前端标签修复第 4 张卡片由「未获取到（本轮）」改为「**终态不可得**（累计）」。

### Fix

- **定时兜底扫改为触发「第一档·常规修复」**：调度到点原来跑「第二档·全量」（逐首精探文件头，数万首、成本极高），现改为跑「第一档·常规」（仅 DB 预筛、成本低），第二档全量修复改为**仅手动触发**。`lastRunAt` 到点标记的推进条件由 `mode === "all"` 扩展为 `mode === "all" || mode === "media"`（否则到点每分钟 tick 会重复触发常规扫描）。设置项字段名 `tagRepairIntervalHours` **保持不变**（DB 既有键，向后兼容），仅改管理端文案：「全量兜底扫描间隔(小时)」→「常规修复扫描间隔(小时)」，`settingsHint` 同步改口径。
- **管理端标签修复子页移除冗余 / 失真展示**：删除「待修队列」区块（`queueTitle/queueDesc/queueBtn` 与「处理待修队列」按钮，与「开始常规修复」功能重复）及状态栏「待修队列 N 首」文案（取值不实、下方统计卡已覆盖）；删除「上次统计」行（`formatTagRepairResultAt` 与 `resultAt/noResult` 键，展示的 `lastResult` 与实际不符）；`runTagRepairMode` 收敛为双挡位（常规 / 全量），死代码 `queueStarted` 一并清理。

### 测试

- `tagRepair.test.ts`（33 例）改写 / 新增：`unobtainable` → 登记 `outcome='unobtainable'` 且下轮命中标记直接跳过（池子收敛）、`unobtainable` 不计入「已修复」与来源分布聚合、30 天 TTL 超期后允许重探。
- 门禁：`npx tsc --noEmit`（backend）= 0；`tests/fetch/tagRepair.test.ts` **33 例全绿**；`npx vue-tsc --noEmit`（frontend）= 0；`backend/scripts/check-*.mjs` 全部 14 个守卫通过（含 i18n 键对称校验）。

## [4.6.27] - 2026-10-18

### Feat

- **标签来源分布（管理端可见统计）**：新增「已修复歌曲用的是哪个来源平台」的管理端可见统计。后端为 `tag_repair_done` 新增 `platform` 列（`ALTER TABLE ADD COLUMN` **幂等**补列，`CREATE TABLE IF NOT EXISTS` 对既有表不补列，故显式补；**旧库既有行保持 `NULL`，不做回填**），`markTagRepairDone()` 增第三参 `platform`：标签修复**真正写入**（`outcome=fixed`）时，把 `searchMetadata()` 命中的来源平台（`qq` / `netease`）透传落库；仅走封面 / 歌词或 DB 兜底（拿不到平台）时落 `NULL`。stats 端点新增 `platforms` 聚合字段（`SELECT platform, COUNT(*) FROM tag_repair_done GROUP BY platform`），**纯 DB 聚合、无任何实时探测**（实时探测会打爆平台 API 并触发限流）。前端「标签修复」区新增「标签来源分布」区块（水平条形：QQ音乐 / 网易云音乐 / 历史（未记录来源），含数量与占比），按 `count` 降序、`NULL` 归一为「历史（未记录来源）」；i18n（zh / en）同增 5 键。

### 测试

- `tagRepair.test.ts` 新增 5 例：QQ 命中 → 完成标记 `platform=qq`、网易云兜底 → `platform=netease`、仅封面修复（无元数据链路）→ `platform=NULL`、来源分布三桶聚合（qq / netease / 空=历史未记录）。
- 门禁：`npx tsc --noEmit`（backend）= 0；`tests/fetch/tagRepair.test.ts` **32 例全绿**；`npx vue-tsc --noEmit`（frontend）= 0；`backend/scripts/check-*.mjs` 全部 **14** 个守卫通过（含 i18n 键对称校验）。

## [4.6.26] - 2026-10-17

### Fix

- **QQ 音乐搜索端点被挡导致「未获取到」占比虚高（生产实测定位）**：内置 `tag-provider` 原用 `soso/fcgi-bin/client_search_cp`，2026-10-17 在 240 生产实测该端点**恒返回 HTTP 500、响应体 0 字节（text/html）**（代理 / 直连、带 / 不带 `Referer`、带 / 不带 `Cookie` 四种变体全部 500），而同家族的 `soso/fcgi-bin/search_for_qq_cp` **HTTP 200、10 条候选、字段同构**（`data.song.list[]` 的 `mid/title/singer[].name/interval` 完全一致）。后果：QQ 侧恒 0 候选 → 所有歌被迫压到网易云兜底 → 网易云对中文冷门 / 长标题覆盖差 → 「未获取到」占比虚高（抽样 6 首里 4 首三个能力全 null）。现将搜索端点换为 `search_for_qq_cp`；**详情 / 歌词接口未变**（仍 200），故**不是元数据解析问题**。
- **歌手资料抓取（`artist-info`）同款端点一并修复**：`scrapeFromQQ` 用的是同一个已 500 的 `client_search_cp`，导致 QQ 歌手头像恒抓不到、只能退网易云；实测 `search_for_qq_cp` 的 **`singer[].mid` 仍然存在**（「周杰伦」→ `0025NhlN2yWrP4`），故同样换用该端点。
- **标题「主标题 - 歌手」后缀恒被闸门拒（全库 11%）**：scanner 对「文件无标题标签」的落库标题为「主标题 - 歌手」（全库 391/3506 ≈ 11%），而旧闸门要求归一化后**精确相等** → 这类歌恒不命中。新增标题变体：完整标题 + 「去掉尾部 ` - xxx`」的主标题，**仍是精确相等语义**（不做前缀 / 包含等模糊匹配），时长 / 歌手闸门不变，故不会放大错配风险。
- **简繁字形差异导致标题 / 歌手恒不匹配**：平台常用繁体登记、DB 为简体（或反之），如 `純白P` ↔ `纯白P`。现于**匹配比较侧**用 `applyVariant(t, "simplified")` 把两侧统一折算到简体；**仅参与比对**，成品字形仍由写盘侧 `applyTagsVariant` 按用户所选 `chineseVariant` 输出，不受影响。
- **「未获取到」统计维度缺失（三档口径补齐）**：标签修复进度原只有「已修复 / 跳过」，`已处理 ≠ 已修复 + 跳过`。新增 `unobtainable`（真缺但两平台都拿不到）一档，`TagRepairResult` / `TagRepairProgress` 与前端标签修复子页 4 张卡片同步补齐，i18n（zh / en）同增；`已处理 = 已修复 + 跳过 + 未获取到`。判定口径：封面 / 歌词 / 专辑 / 元数据全无产出即 `unobtainable`，且**不写完成标记**（保留重试机会）。

### Perf

- **同曲多能力往返去重（贴近 API 限速上限）**：三个能力（元数据 / 封面 / 歌词）此前各自独立搜一次 QQ → 同一首歌 6 次往返。现共享模块级 memo（`MEMO_TTL_MS=180s`、`MEMO_MAX=2000`），搜索 / 详情命中即返回，**同一首歌的 QQ 往返 6 → 3**；且**只缓存成功响应**（瞬时失败不会被固化成「无候选」）。缓解「修复速度远低于 API 限速」的问题，同时**不增加** CPU / 网络消耗（反而减少）。

### 测试

- `tagProvider.test.ts`（23 例）新增：端点锁（固定 `search_for_qq_cp`，防回退）、标题变体命中、标题变体仍为精确相等（负例）、简繁归一命中与负例；原有端点断言同步更新。
- `tagRepair.test.ts`（28 例）新增「修正 5」三档拆分用例（`已处理 = 已修复 + 跳过 + 未获取到`）。
- 门禁：`npx tsc --noEmit`（backend）= 0；`tests/plugins/tagProvider.test.ts` + `tests/fetch/tagRepair.test.ts` 共 **51 例全绿**；`backend/scripts/check-*.mjs` 全部 14 个守卫通过。

### 实测（真实数据 · 真实链路 · 240 生产容器 musicflow）

- **端点对照（同关键词 / 同 `proxyFetch` 出网通道 / 同 `Referer`）**：`client_search_cp` = 500 / 0 字节 / 0 候选；`search_for_qq_cp` = 200 / 8969 字节 / 10 候选。
- **待修库抽样 6 首逐首真实 API 取证（修复前）**：现网插件 4/6 三个能力全 null（`Fire Is Dead - SCARECROW`、`侠客行 - 虞霞、李小龙`、`时间扭曲之路 / 純白P`、`是我太过迁就所以沦为爱囚 (氛围纯享版)`），仅 2 首经网易云兜底有结果；其中 `是我太过迁就…` 的候选**连旧闸门都能通过**，却因端点 500 拿不到候选 → 证明**解析逻辑无误**。
- **换端点 + 两处闸门修复后（热补丁部署 240 并重启，同 6 首复测）**：**6/6 全部由 QQ 命中**（`platform=qq`），元数据 / 封面 / 歌词三能力齐备（如 `Fire Is Dead` → `artist=SCARECROW / album=Love, Then Life / track=6 / year=2026 / genre=R&B`，歌词 1924 字符）；`純白P` 一首经简繁归一命中；不再回落网易云。
- **落地前后各做一次审查**：确认换端点未改变详情 / 歌词解析口径；标题变体保持精确相等；简繁归一仅作用于比对侧、写入字形链路未触碰。**边界留痕**：`侠客行 - 虞霞、李小龙` 救回的是同日曲的 `TV Version`（224s，与 DB 225s 差 1s），会写入该版本专辑（`武林外传 电视剧原声带`），属「同曲不同版本」的边界情形。

## [4.6.25] - 2026-10-17

### Feat

- **内置标签插件支持网易云音乐（QQ 音乐拿不到时的兜底链路）**：`tag-provider` 由「仅 QQ 音乐」升级为「QQ 音乐（默认来源）+ 网易云音乐（补充链路）」双来源，插件 id 与注册方式不变（仍是同一个内置插件，仍是 `metadataProvider` / `coverProvider` / `lyricProvider` 三类能力）：
  - `searchMetadata` / `searchCover` / `searchLyrics` 三个方法均为**两段式**：先跑 QQ 音乐循环，**仅当 QQ 全部候选都未命中**才跑网易云循环；命中判定的「标题归一化 + 歌手交集 + 时长 ±5s」三闸门抽为共用 helper，两平台口径一致。
  - 网易云 `POST /api/search/get` 的 `duration` 是**毫秒**，统一换算成**秒**后进时长闸门（否则恒不匹配）；搜索响应的 `album` 只有 `picId`、**无 `picUrl`**，封面须**二次调** `/api/song/detail/?ids=[id]` 取 `album.picUrl` 直链；歌词取 `/api/song/lyric` 的 `lrc.lyric`。
  - 网易云不提供可读风格名，`genre` 一律**不填**（绝不臆造）；manifest 的 `platforms` 增补 `netease`、`platformLabels` 与中文 / 英文名称描述同步更新。

- **QQ 音乐 API 访问限流（防封 IP，产品定调 2026-10-17）**：内置插件 `tag-provider` 的全部 QQ 请求（搜索 / 详情 / 歌词）共用**同一条全局串行队列**，相邻请求发起间隔 ≥ **1.2s**，再叠加 **300~800ms** 随机抖动（实际间隔约 1.5~2.0s），防止同一出口 IP 高频访问被风控封禁；网易云链路不受此限。最小间隔可用环境变量 `MF_QQ_MIN_GAP_MS` 覆盖（测试置 0）。

### Fix

- **搜索命中率过低（换真搜索接口）**：原用 QQ 联想接口（`smartbox_new.fcg`），它只回热门联想词 —— 生产库抽样 30 首有 22 首**零候选**（整体命中率仅约 11.6%）。改用 QQ **真搜索** `client_search_cp`（`data.song.list[]` 自带秒级时长）后候选齐全，且**时长预筛前移**到搜索阶段（不合格者不再调用详情接口，省一次网络往返）。
- **scanner 占位歌手值污染搜索关键词**：`Unknown Artist` 等 scanner 对「无歌手标签文件」写入的占位值被拼进关键词 → 恒 0 结果；现占位值一律当空歌手，只用标题匹配。
- **修复真正写入后不补标记**：此前 `markTagRepairDone` 只在**下载期**调用，标签修复改写文件后**不写标记** → 生产库 `tag_repair_done` 实测 0 行，修过的歌下轮仍被当候选重扫。现改为一次修复**真正写入**（`outcome=fixed`）即登记标记，`src` 取命中的来源 provider id（无 provider 命中回落 `tag-repair`）；`unobtainable`（真缺但拿不到）一律**不**标记，保留重试机会（避免断网把整库永久标记）。
- **专辑封面不回写导致待修数恒高**：第一档 DB 预筛按 `songs.cover_art 空 && albums.cover_art 空` 判定缺封面，而修复只刷新 `songs.has_lyrics`、**不刷新 `albums.cover_art`** → 实测 19 首「文件已内嵌封面但专辑行无封面」的歌每轮被重扫。现任何一次修复 / 对账后，若文件有内嵌封面而专辑行为空，则落盘 `data/covers/<albumId>.<ext>`（与 `scanner.saveCoverArt` 同款命名）并回写该列；已有封面不动（幂等）。
- **占位专辑名被写进文件**：DB 的 `album='Unknown Album'`（scanner 对「无专辑标签文件」的占位）此前被当有效值写进文件，把「无专辑」变成假专辑名。现 `Unknown Album` / `未知专辑` 视同空值：既不作 DB 兜底写入，也不作 `needMeta` 的「DB 已有值」依据（转为走网络补全）。

- **「已修复」统计取错数据源（前端一直停在旧值）**：前端「已修复」此前读 settings 的 `repairedTotal`，它只在**一轮跑完**时累加「本轮 fixed+skipped」——全量扫动辄数千首、单轮可跑数小时，期间计数恒定不动；一旦中途容器重启 / 任务被杀，本轮已真实修复的数百首的计数**全部丢失**（实测 `tag_repair_done` 已 **184** 行，前端仍显示 **20**）。现改为直读完成标记行数（`getTagRepairMarkedCount()`）：每首真正修复 / 探针确认齐备即写标记，计数**实时**上升且跨重启保留；并让「探针确认标签齐备」的歌也登记标记（与下载期标记同义），前端不再叠加本轮 progress（避免同一首被计两次）。

- **标签写入瞬时失败重试不足（`/MUSIC/LOSSLESS` 实测 Permission denied）**：生产实测 8 条 `ffmpeg 写标签失败(exit=243) Permission denied`（EACCES），集中在一个 11 分钟短窗内（判为 NAS 存储层瞬时权限抖动）；原策略仅「2s 后重试 1 次」，不足以吸收这类持续数分钟的抖动。现改为**指数退避重试 3 次**（3s → 6s → 12s），仍失败才上抛并打印错误与文件路径（便于区分「瞬时抖动（重试可愈）」与「永久权限问题（需运维介入）」）；`TIMEOUT` 仍不重试，其他错误原样上抛。退避窗口可用环境变量 `MF_TAG_RETRY_DELAYS_MS`（逗号分隔毫秒）覆盖，测试置 0 加速。

- **多身份共享音乐库导致标签修复 `Permission denied`（根治：运行身份可配置化）**：`/MUSIC/LOSSLESS` 实测有 **315 个目录**属主不是应用身份（uid 100），而「写标签」是**同目录建 `.tagtmp` 再 rename**、需要的是**目录写权限** → 报 `ffmpeg 写标签失败(exit=243) … Permission denied`（指数退避重试 3 次仍失败）。先验证 ACL 路线**不可行**：本机 `/vol3` 为 btrfs 且挂载选项含厂商自定义的 `trimacl`，`setfacl` 能写入 xattr、`getfacl` 可回读，但**不参与权限判定**（受控实验：把单个目录 `chown` 给 uid 100 后立刻可写，随后还原；同目录以 100 身份 `touch` 仍 EACCES）。故改为**从结构上消除矛盾**：`backend/entrypoint.sh` 新增 `PUID` / `PGID` 支持 —— 未设置时行为与历史**完全一致**（仍以镜像内 `musicflow` 100:101 运行，保留原有「按需 chown data / plugins」逻辑，向后兼容）；生产 `compose.yaml` 传 `PUID=0` / `PGID=0` 时应用以 **root** 运行。root 可写任意属主条目，chown / cron / ACL 等治标手段**全部不再需要**，此类 `Permission denied` 从此结构性不复现。

### 测试

- `tagProvider.test.ts` 新增网易云兜底用例：QQ 有命中时**不调用**网易云；QQ 零候选时网易云兜底且**毫秒时长换算成秒**；封面走二次详情接口；歌词取 `lrc.lyric`。
- `tagRepair.test.ts` 新增修正 1 / 2 / 3 回归用例：真写入补标记、`unobtainable` 不标记、占位专辑不写（网络也拿不到时 `unobtainable` 且无写入）、专辑封面落盘并回写。
- 门禁：`npx tsc --noEmit`（backend）= 0、`npx vue-tsc --noEmit`（frontend）= 0；`tests/fetch/tagRepair.test.ts`（26 例）、`tests/plugins/tagProvider.test.ts`（16 例）全绿；全量门禁由 CI 复核。
- `tagProvider.test.ts` 新增 QQ 限流用例：相邻两次 QQ 请求间隔 ≥1.5s（跨调用的全局串行队列同样生效）、网易云链路不受限（紧随发起无需再等 1.2s）。
- `tagRepair.test.ts` 新增修正 4 回归用例：`repaired` 直读完成标记表 —— 未跑任何一轮修复也能实时反映已标记歌数（锁定「一直停旧值」不再复现）。

- `tagRepair.test.ts` 新增加固回归用例：`TAG_FAILED` 连续失败 → 退避重试用尽（共 3 次重试 = 4 次写入）后上抛；原「第二次成功即修复」用例更名为「指数退避重试」，覆盖首重试即愈的场景。

### 实测（真实数据 · 真实链路 · 240 生产容器 musicflow）

- **命中率（真实库抽样 30 首）**：QQ 新真搜索接口命中 **21 首**（含可读风格 16 首）；网易云命中 **17 首**，其中**救回 QQ 未命中 3 首**；**合并命中 24/30 = 80%**（余 6 首两平台均无合格候选）。
- **网易云兜底真链路（3 首 QQ 拿不到的真歌，走真实修复入口 `repairSongTags`）**：原内嵌 `year=null`、歌词 0 → 修复后写入网易云值 —— 花之月影（大琴师贰）`year=2014`、Nujabes Tribute `year=2014`、汉宫秋月（古筝）`year=2006`，均补上歌词 1 首；**原有内嵌封面保留**（1 → 1，未被重写丢弃）；登记标记 `src=tag-provider`。
- **网易云封面字节级取证（2 首 QQ 拿不到且文件缺封面的真歌）**：成品内嵌封面与网易云 `album.picUrl` 直链**字节完全一致**（69940 B / sha `0323bc09…`；47044 B / sha `f6b68678…`），证明封面确由网易云兜底链路写入。
- **标记与跳过（修正 1）**：真写入后 `tag_repair_done` 累计 5 行，`size/mtime` 与文件完全一致 → 同批再扫命中标记直接 skip（不探针、不联网）。
- **专辑封面回写（修正 2）**：3 首「文件已内嵌封面、专辑行无封面」的歌落盘 `data/covers/<uuid>.jpg` 并回写 `albums.cover_art`（落盘文件已核验存在），待修数随之下降（3731 → 3728）。
- **占位专辑（修正 3）**：真库现存 60 首 DB `album` 为占位值的歌，其文件内嵌 `album` 已是修复前遗留的占位值（真库中无「文件专辑为空」的样本可做端到端验证），故该项以单测锁定口径：DB 占位值是**不写**的、且会被当作空值走网络补全而非兜底。
- 落地前、落地后各做一次审查（方向正确性 + 改动覆盖性）。
- **QQ 限流真机实测（240 生产容器 · 真实网络）**：一次 `searchMetadata` 内的相邻两次 QQ 往返实测间隔 **3071ms**（≥ 1.2s + 抖动下限；因串行队列在「上一请求完成」后才放行，实际间隔会更长），限流生效；同一次调用命中 `platform=qq`、`genre=R&B`、`track=8`、`year=2016`。
- **「已修复」计数实测（修正 4）**：修正前 DB `tag_repair_done` = **184** 行而前端计数恒为 **20**；修正后 `getTagRepairStats().repaired` 直读标记表 = **184**，并自建一条临时标记后立刻 +1、删除后回退（活性验证通过，全程未触碰任何音乐文件）。

- **标签修复权限根治（PUID/PGID）真机取证（240 生产容器 · 真实链路）**：落地前 PID1 为 `Uid=100/Gid=101`；`compose.yaml` 注入 `PUID=0`/`PGID=0` 并部署新版 entrypoint 后 PID1 变为 `Uid=0/Gid=0`，健康检查 `GET /` → **200**，插件加载 / DLNA 注册 / WS 升级日志均正常。在**原失败目录** `/MUSIC/LOSSLESS/Darius/Romance`（属主 `root:root`、模式 755，改前必然失败）以真实 `ffmpeg-static` 复刻 `tagWriter` 语义（同目录写 `.tagtmp.flac` → `rename`）→ **写入成功 + 改名成功 + 清理成功**；交叉对照以旧身份 `uid 100` 在同一目录 `touch` → **`Permission denied`**（证明差异来自运行身份，而非目录属性被改动）。落地前 / 落地后各做一次审查。

## [4.6.24] - 2026-10-17

### Feat

- **内置在线标签补全插件（`tag-provider`，QQ 音乐）**：新增内置插件，提供 `metadataProvider` / `coverProvider` / `lyricProvider` 三类能力，默认启用。下载 / 洗版写标签时**只补缺失字段**（标题 / 歌手 / 专辑 / 专辑艺术家 / 轨号 / 年份 / 风格 / 封面 / 歌词），已有值一律不覆盖。`providers` 新增 `searchMetadata` 首匹配分发；Plugins 页同步展示 metadata 类型与能力标签。
- **标签修复升级为三挡位 + 独立子页**：`queue`（事件队列，下载终态入队按退避重试）/ `media`（第一挡·按 DB 预筛缺歌词/封面/专辑）/ `all`（第二挡·逐首精探文件头，**补齐全部缺失标签**）。前端 admin/Fetch 独立出「标签修复」子页（自动修复设置 + 两挡位卡片 + 待修队列）；`POST /v1/fetch/tag-repair/run` 收 `{mode, scope}`，`GET` 返回分挡位 `lastResults`。
- **中文简繁字形统一**：新增 `utils/chineseConv`（OpenCC 派生 T2S/S2T 字符 + 词组表）。所有**由 provider 提供的文本**（写入文件的 标题 / 歌手 / 专辑 / 专辑艺术家 / 风格 / 歌词，含在线歌词与批量回填）按 `chineseVariant`（默认 `simplified` 简体）输出，并同步回写成品文件名以保持一致；设置项落在 admin/Fetch，zh/en i18n 同步补齐。

### Fix

- **时长单位错配（核心 bug）**：内置 `tag-provider` 的 `durationOk` 把核心传入的**秒**当**毫秒**除以 1000，与平台秒值差两个数量级 → QQ 的 `searchMetadata` / `searchCover` 恒判不匹配，「元数据全部写不进去」（仅歌词正常）。统一为秒（±5s 容差）。
- **碟号纪律（产品定调）**：成品文件**不写也不留** `DISCNUMBER` / `DISCTOTAL`。ffmpeg 缺省继承源文件全部 metadata，不少源自带碟号甚至垃圾值（实测成品曾出现 `DISCNUMBER="18439392929"`），故 `buildTagArgs` 不但不写 `disc`，还追加 `-metadata disc=` 显式清空（同时删掉 Vorbis 的 DISCNUMBER/DISCTOTAL 与 ID3v2.3 的 TPOS，且不影响其余标签继承；不可改用 `-map_metadata -1`，会破坏修复依赖的继承语义）。同步移除下载期 / 修复期的碟号采集；「内嵌无碟号」不计为缺失、绝不触发修复。
- **风格 / 流派补全**：`tagProvider` 新增 `pickGenre()`，从 QQ `req.data.info.genre.content[].value` 取可读风格名（同级的 `track_info.genre` 只是数字码，不可用），多值以 `/` 连接后写入。
- **标签重写会静默丢弃已有内嵌封面（真实链路实测暴露）**：`buildTagArgs` 恒用 `-map 0:a` 只取音频流，重写标签时把源文件已有封面（FLAC 的 vorbis 图片块 / MP3 的 ID3 APIC）一并丢掉。危险性：库内大量老文件缺 `genre`（本轮之前从不写 genre），一旦跑修复扫描会**批量丢封面**。修复：新增 `keepSourceCover` 开关，无新封面时用 `-map 0:v?` 保留源图 —— 修复路径恒 `true`，下载路径按 `embedCover !== false`（`embedCover=false` 仍明确不保留）。补 2 例单测（含真实 ffmpeg 造「带封面 flac」的回归用例）。
- **标签修复范围与统计口径**：新增 `tagRepairScope`（download / lossless / both，默认 both；手动 run 可按请求覆盖；`inScopeRoots` 硬门禁只碰两个下载目录，绝不碰 WebDAV 云盘库）；统计口径补 `skipped`（已修复·跳过）；`mode=all` 去重计数。
- **标签修复完成标记**：新增 `tag_repair_done` 表 + `tagRepairMarker`。下载期由声明 `manifest.builtinTagSource` 的内置标签来源插件打标的成品，落盘后登记（fs_path + size + mtime）；修复扫描命中且文件未变 → 不探针、不联网直接跳过。外置插件不标记 → 其标签一律仍会被修复补齐。
- **前端配置保存丢字段**：`PUT /v1/fetch/config` 为整体替换语义，原只提交 3 个字段会把字形 / 范围等覆盖项清空回默认；改为提交**完整**配置对象。

### 实测（真实数据 · 真实链路 · 240 生产容器 musicflow）

- **下载自动打标签三条分支 + 洛雪音源（`lx-source`）全覆盖**：分支 A（`go-music-dl` 搜索 + 取链）落 `genre=R&B、track=8、year=2016`；分支 B（纯 stream 源按平台原生 ID 直取，`lx-source`）落 `genre=Pop、track=2、year=2015`；分支 C（桥接 `lx-source` → 兜底 `go-music-dl`）落 `genre=Folk、track=5、year=2013`。全部 `disc=null`、封面 1、歌词 1。
- **洛雪音源探针**：`netease`（wy）脚本链路可用（真实下载成功）；`kugou`（kg，hash）/ `kuwo`（kw，rid）返回 `HTTP_404`，为上游脚本可用性问题（非本项目缺陷）。
- **简繁字形**：简体 / 繁体两条链路成品文件名与内嵌标签同步转换（「后来」/「後來」、「收获」/「收穫」）。
- **标签修复 `mode=all scope=both`**：命中完成标记 6 首跳过（不探针、不联网）、未标记 1 首精确补齐 `genre/track/year` 且**封面保留**（该用例即本轮封面保留修复的回归点）；修复后不新增、不清空碟号。
- **边界语义**：`tag-provider` 关闭时下载的成品无完成标记（仍可被修复补齐）；`embedCover=false` 时成品封面 0（符合用户关闭意图）。
- 落地前后各做一次审查（方向正确性 + 改动覆盖性）：三处 `writeTags` 调用点全部覆盖，无遗漏、无过度改动。

## [4.6.23] - 2026-10-16

### Fix

- **下载 / 洗版（无损替换）域一次性缺陷修复（全量审计 20 项）**：对下载与洗版两条流水线做全量审计（5 路并行子代理 + 逐条核验），修复「洗版统计回退 / 无限空转」「任务僵尸 / 续批链断」「下载音质回退 / 缓存残留」「前端轮询与提示」四类确认缺陷。落地前、落地后各经独立子代理审查（方向正确、无过度 / 漏改）。

#### 洗版统计与冷却（用户核心诉求：待洗版数不再回退）

- **`recordUpgradeAttempts` 用 `INSERT OR IGNORE` → `attempted_at` 永不刷新**：已尝试歌的时间戳冻结在首次尝试时刻，冷却判定（`attempted_at > now - N 天`）随时间单向衰减 → 旧 attempted 过期「解冻」，前端「待洗版数」看似回升；且到期歌重入候选池后仍被 `OR IGNORE` 静默跳过刷新 → 每批重选同一批 → **无限空转**（注释承诺的「未尝试集每批必收缩」不成立）。改为 UPSERT（`ON CONFLICT(song_id) DO UPDATE SET attempted_at / batch_id / status`），重复调用只更新时间、不产生新行，幂等语义不变。
- **「待洗版数」口径与冷却窗口解耦**：原 `belowBar = total - cooled`，成功洗版的歌迁出目标目录后 `total` / `cooled` 同时 -1 → 数字原地不动（洗了半天不降），叠加时间戳衰减还会回升。新口径 **`belowBar = total`**（目标目录全量即待洗版；成功即迁出，天然单调递减、永不回升），冷却只决定「本轮先洗谁」。同步修正 `buildUpgradeContinuation` 的 `remaining`（再减 `cooled`，等价于历史「未尝试集」口径）与前端 `UpgradePlan.belowBar` 注释。
- **重复 `sourceId` 造成快 / 明细两口径不一致（同一目录重复计数）**：`resolveUpgradeSourceIds`（含 API 侧两处入口）与 `collectUpgradeSongs` / `countUpgradePlanStats` 统一去重（`[...new Set()]`）。
- **点名批次（`songIds`）超批量上限被静默截断**：点名路径 `limit = songIds.length`（点名意图明确，不截断）。

#### 任务生命周期（僵尸任务 / 续批链）

- **完全停止（hard abort）非末片 / 未启动时不写终态 → 永久 `running` 僵尸**：循环退出后补写 `cancelled` 终态；并让完全停止**等同取消**地掐断自动续批链（否则任务恰在点击前一刻已落 `done` 时，`maybeContinue*` 仍会在默认开启下再开下一批），同时避免重启时 `collectInterruptedFetchJobIds` 把用户明确「完全停止」的任务复活。
- **全库「无进展停链」不清 autoSession 标记 → 调度器每分钟复活无限续批**：`maybeContinueLibraryJob` 无进展分支补 `setAutoSession("library", false)`（洗版同款分支原本已有，全库漏了）。
- **续批恢复不尊重 `autoContinue` 闸 → 关掉后停不下来**：`resumeUpgradeSession` / `resumeLibrarySession` 开头加 `if (!cfg.*AutoContinue) { 清标记; return false; }`；PUT 关闭 `libraryAutoContinue` / `upgradeAutoContinue` 时同步清续批标记（此前只清 `*AutoEnabled===false`，总闸关掉后让渡空窗里的链仍会被接续）。
- **取消「点名批次」误清整条链的会话标记**：`stopAutoSessionForJob` 与 `maybeContinue*` 清标记前解析 `__upgrade` / `__library.noAutoContinue`，true 则跳过（否则点名重试后取消会把正在跑的全库 / 洗版链一起掐断）。
- **点名 `library` 批次未标记 `noAutoContinue`**：点名批次改 `buildLibraryJobConfig(cfg, { noAutoContinue: true })` 且不置 `setAutoSession("library", true)`，对齐洗版 namedOnly 语义（否则点名批次会被续批链放大到全库）。
- **`startFetchJob` 无重入守卫**：同 `jobId` 并发启动会双循环（`controllers.set` 互相覆盖、进度 / 终态打架）→ 开头 `if (controllers.has(jobId)) return;`。
- **排空收尾 `counts.total` 与 items 不一致**：pending 阶段取消时 items 被补成 N 条 cancelled、但 `counts.total` 仍为 0 → `finalizeDrainedFetchJob` 补写时同步 `{ total: all.length }`。
- **`batch/runner.ts` cleanup 不移除 signal 的 abort 监听**：`{ once: true }` 的监听在 signal 未 abort 时不会被移除，跨片累积（MaxListeners 告警 / abort 时重复回调）→ cleanup 里显式 `removeEventListener`。

#### 下载流水线（音质回退 / 缓存残留 / 完整性）

- **转码闸 `transcodeSem.acquire(signal)` 在 try/finally 之外 → 取消时缓存残留复现**：排队等转码闸时 hard abort，`acquire` 以 AbortError reject → 异常冒到整曲兜底 → 本项被误记 `failed` 且 `cleanup()` / `pruneCacheDir` 未跑 → 已下载 / 已打标的缓存产物永久残留在 cacheRoot（v4.6.22 刚要消灭的残留复现）+ 误记冷却。修复：把 acquire 纳入保护，reject 时 `cleanup()` 并返回新增的 `{ kind: "cancel" }` 结果 → 整曲落 `cancelled`，不换候选、不记失败。
- **断点续传时 sha256 只覆盖新收字节 → 整文件哈希必不符（`INTEGRITY_FAILED`）**：resume 时 `dl.partial = true`，返回的 sha256 仅是本次新增分片，拿它比对整文件哈希必然失败（永久失效，连败还可能触发 `deadSongPurge` 删歌）。修复：`expect.sha256 = dl.partial ? undefined : dl.sha256`（integrity 对缺省 sha256 支持跳过哈希，只比字节数 / 时长）。
- **「已有文件是否更优」只读库内 `bit_rate` 列 → 用更差新文件顶替已有更好文件**：库内 flac 的 `bit_rate` 基本是垃圾值（≈真值 / 202）→ 好无损被误判 unknown / 低档，新的（更差）lossless 跨档通过，即便 `fileConflictPolicy=keepBetter` 也照样 write → **音质回退 + 旧文件被删**。修复：`existing.ts` 的 `ExistingHit` / `ExistingRow` / `SELECT_COLUMNS` / `matchRow` 补 `size` 字段，`better()` 与 orchestrator 既有侧统一改按 `effectiveBitrateKbps(size, durationSec)` 现场换算择优，`bit_rate` 仅作换算不出时的回落。

#### 前端 admin/Fetch

- **标签修复轮询定时器离开页面不清理**：新增 `onUnmounted` 清定时器 + `tagRepairDisposed` 守卫（在途响应落地后不再写状态 / 重建定时器），消除切走后每 5s 一次的后台空转请求。
- **「完全停止」toast 与异步终态不符**：改为「已请求完全停止，数秒内终止」，避免用户因列表仍显示运行中而反复点击。
- **`runTagRepair` 的 busy 分支永不命中**：后端「已有修复在跑」返回 HTTP 409，axios 抛异常被 catch 一律误弹「保存失败」→ 识别 409 走「正在运行」提示。
- **无可重试条目仍弹「重试已开始 -」**：`retryFetchJob` 返回类型收紧为 `string | null`，`null` 时提示「没有可重试的条目」。
- **列表轮询 `pollTick` 绕过 single-flight**：轮询与手动刷新并发同 key 请求、旧响应覆盖新 → 轮询改走 `fetchListOnce()`，与手动刷新共用单飞（`listKey()`）。
- **详情接口失败弹窗空白无提示**：新增 `detailError` 占位文案。

### Internal

- 回归守卫：`upgrade.test.ts`（A1 UPSERT / A3 去重 + `belowBar = total` 口径断言）、`drain-cancel.test.ts`（完全停止终态 / `counts` 对齐）、`existing.test.ts`（有效码率择优）、`upgradeScheduler.test.ts` / `libraryAuto.test.ts`（续批闸）。
- 审计前提勘误（**不做改动**）：原疑似缺陷「Content-Length 未校验导致截断被静默接受」经 Node HTTP 客户端探针实测**不成立** —— 声明 `Content-Length` 却提前断流的响应一律以 `ECONNRESET` 抛错（永不「干净短结束」），本已被解析器拒为 `FETCH_FAILED`，故不新增断言。
- 230 主机本地门禁自检：backend `tsc --noEmit` 0 error、`vitest tests/fetch` 全绿、frontend `vue-tsc --noEmit` 0 error。

## [4.6.22] - 2026-10-16

### Fix

- **转码成功后源文件永久残留在下载缓存目录（240 生产实测 13.9G / 3002 个 mp3）**：`orchestrator.tryCandidate` 转码换封装（`dstPath` 与源不同）后把 `cachePath` 指向产物，源文件却从未删除 —— 每首歌都在 cacheRoot 留下一份残留。修复：转码成功且产物换了路径后即时 `rmSync(源, { force: true })`；`skipped` 与原地转码（`dstPath === 源`，此时 dstPath 就是产物本身）以及 `transcodeKeepOriginal = true` 时**一律不删**。
- **候选未被采纳（`finalize` 返回 `skip` / `keep`）时不清理产物**：原来直接 `return { kind: "keep" }`，跳过了 `cleanup()`，产物同样残留。修复：`skip` / `keep` 分支补 `cleanup()`。
- **缓存目录只删文件、不删目录**：`cleanup()` 此前只 `rmSync` 文件，在 cacheRoot 留下大量空目录（240 实测 7319 个目录中 4238 个空）。修复：文件清光后兜底 `rmdirSync(dir)`（目录非空或已不存在时忽略，不影响主流程）。
- **`transcodeKeepOriginal` 此前是死配置**：orchestrator 从未读取该开关（仅前端有 UI、后端不消费），打开也不生效。本次真正接上（true = 源文件保留在缓存目录、不删除、也不进入音乐库），并修正前端 hint 文案（旧文案「转码后同时保留原文件」语义含糊）。

### Internal

- 新增回归守卫 `backend/tests/fetch/cacheResidue.test.ts`（R1–R6）：覆盖下载与洗版两条流水线的「转码成功删源 / `transcodeKeepOriginal` 保留 / `skipped` 不误删 / `finalize` keep 清产物 / 缓存目录 rmdir」。
- 230 主机本地门禁自检：backend `tsc --noEmit` 0 error、`vitest tests/fetch` 全绿、frontend `vue-tsc --noEmit` 0 error、diff CR 检查通过。

## [4.6.21] - 2026-10-16

### Perf

- **内置「本地随机」候选池冷池加固（消除歌单增删 / 导入 / 同步后首页请求的同步全量扫描）**：v4.6.20 已收口 provider 在途调用单飞与冷启动软截止，但其 Internal 记录的残留项 —— 内置 `local-random-recommend` 候选池的同步慢脚 —— 仍存在：`invalidatePlatformPool()`（歌单增删改 / 导入 / 同步后调用）语义为「置 `null`」，于是**下一个首页请求在请求线程上**同步执行 `getPool()` 冷启动全量 `buildPool`（`playlists` 表扫描 + 封面 memo 重建）。本次把 `invalidatePlatformPool()` 由「置 null」改为**置脏 + 后台单飞重建**：保留旧 warm 池继续服务在途请求，`queueMicrotask` 后台重建后原子替换，**请求路径不再触发同步全量扫描**；新数据在后台重建落地后的下一轮请求即可见（微任务级延迟，等价于原「立即重建」）。多次失效由 `poolRebuildInflight` + `poolDirty` 合并为一次重建；重建失败保持旧池与脏标记、下一轮请求再 kick（不在微任务内自旋重试）。TTL（120s）过期与显式失效两条路径统一收敛到同一 `schedulePoolRebuild()`。

### Fix

- **空闲内存回收不得把刚清掉的候选池又热回来（本次改造连带复查发现）**：`registerCacheCleaner` 中原本调用 `invalidatePlatformPool()`，其语义改变后会**在空闲回收时立刻触发一次后台重建**、把刚释放的内存重新填回。新增 `dropPlatformPool()`（硬清空、不做后台重建）专供回收使用，回收后行为与 v4.6.20 之前一致（下一次请求走冷启动同步建池一次）。

### Internal

- 仅后端，无前端改动：`backend/src/services/plugin/localPlatformRecommend.ts`（新增 `dropPlatformPool()` 与 `schedulePoolRebuild()`；`invalidatePlatformPool()` 语义改为 SWR；`getPool()` 合并「TTL 过期」与「显式失效」两条 SWR 路径）、`backend/src/routes/api/shared.ts`（回收 cleaner 改走 `dropPlatformPool()`）。
- 同步既有 QA 语义：`tests/services/localPlatformRecommend.test.ts`、`tests/qa_perf/randomness.test.ts`、`tests/qa_perf/coverEquivalence.test.ts` —— 「失效后**立即**重建」断言改为 SWR 语义（失效本轮不阻塞、排空微任务后下一轮即见新数据），跨用例重置改用 `dropPlatformPool()` 保证确定性；新增回归用例「`invalidatePlatformPool()` 本轮**不同步查库**」（断言失效后本轮 `FROM playlists` 查询次数为 0）。
- 230 落地前后门禁自检：backend `tsc --noEmit` 0 error；定向 `vitest` 7 文件 / 94 用例全通过；diff 无 CR 行尾（`grep -c` 计数全为 0）；落地前（方案方向 + 语义影响面）与落地后（diff 逐行复核 + 语义等价性）两轮独立审查。按约定不在本版部署生产环境。

- CI 发版门禁误判修复（连带复查发现）：`build.yml` 的全量测试作业在 `7fe604a` 上 **505/505 文件、6832 用例全过**，仅因 `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`（sendspin 测试停服务后的迟到 console 输出经 Vitest 5 的 worker→主进程 RPC 派发）被判 1 个 unhandled error → exit 1 → **误触发 rollback**（`:latest`/`:main` 被回滚到旧 digest）；同一条 `npx vitest run` 本轮在 `ci.yml` 通过，属 `sequence.shuffle` 下的顺序相关偶发。沿用 `backend/vitest.config.ts` 与 `sendspin-guard.yml` 已有的结构性缓解开关 `MUSICFLOW_GUARD_NO_CONSOLE_INTERCEPT=1`，把 console 截获关断覆盖到 `build.yml` / `ci.yml` 两个全量测试作业（`playback-chain-guard.yml` 只跑非 sendspin 子集，不受该竞态影响）；日志仍完整落在 CI 日志与失败 artifact（不走 RPC，竞态从结构上消除）。修复后 `f491b20` 的 8 个 workflow 全绿。

## [4.6.20] - 2026-10-15

### Perf

- **容器重建后「长时间不可用」根治（entrypoint 按需 chown）**：`entrypoint.sh` 原本**无条件**对绑定挂载的 `data` 目录执行 `chown -R`，而该目录实为 20GB / 87895 个条目（其中封面缓存 `covers` 一个目录就占 17.8GB / 87855 项），每次容器重建都要走完整棵树、耗时 **~29s**，是「容器起来后 ~45s 内完全无法服务」的头号原因（docker 创建 12s + entrypoint 29s + 建表与插件沙箱装配 3.5s，2026-10-15 实测）。现改为**按需**：只探 `data` 根与一级子项属主，确有不属于运行时用户（uid 100）的条目时才做全量递归 chown —— 稳态（实测顶层全为 100:101）直接跳过，省掉整段 29s；绑定挂载属主若真配错仍会被探测到并修复。探测失败（`stat` 不可用 / 用户查不到）退化为原行为，不会漏修。
- **重启续跑入库任务延后 60s，避免「刚起来就卡」**：容器启动后原本**立即**续跑上一进程遗留的批量入库任务（`resumeInterruptedFetchJobs` + `libraryScheduler` 的 boot tick），会瞬间拉起批量子进程与 4 路 ffmpeg 转码——生产实测容器 CPU 长期 400%+、宿主负载明显超核、转码闸排队最长 `waitMs=64.7s`，所有依赖转码/入库/插件的操作都排在 2.4 万首待入库队列之后。现将启动恢复统一延后 **60s**（新增 `BOOT_RESUME_DELAY_MS`，`index.ts` 与 `libraryScheduler` 共用同一常量），让 entrypoint 收尾、外置插件装配与首批交互先走完；期间遗留任务行保持 pending/running，调度器的 busy 判定与终态续批语义不变（被推迟的只是「何时开始」，不是「是否续跑」）。

### Fix

- **延后恢复窗口的重复起批风险（复查发现）**：`collectInterruptedFetchJobIds()` 取的是**所有** pending/running 行，而 `startFetchJob()` 注册 AbortController 时**不检查是否已在跑**。原逻辑下 resume 在启动瞬间同步执行（此时尚无任何新任务，安全）；延后 60s 后窗口内其它调度器可能已起了新任务（如 `upgradeScheduler` 的 boot tick 在 15s 恢复洗版链），这些行会被误判为「中断任务」再 `startFetchJob` 一次 —— 同一个 job 被两个批次循环并行推进，并残留两个 AbortController（取消时只 abort 后一个）。现于恢复时跳过本进程已在推进的 job id（`controllers.has(id)` 判定，controller 在 job 终态的 finally 中移除）。
- **首页「本地随机（按平台）」分区偶发卡死根治**：生产实测 `/rest/api/v1/local-recommend` 偶发耗时 **1579–21109ms**（budget 1000ms），最坏远超前端 axios 15s 超时 → 请求被 abort → 前端 `catch` 清空数据且**不再重试**，该分区永久空白直到整页刷新（另经生产日志确认 `/rest/api/v1/recommend` 从未进慢请求榜、插件拉取推荐歌单链路正常，故本次故障点不在该链路）。三处收口：(1) 后端为该路由各 provider 新增**在途调用单飞表**（`providerInvokeInflight` + `kickProviderInvoke`，冷启动竞速与 SWR 后台刷新共用同一张表），杜绝前端 8s 轮询与多客户端并发把同一慢 provider 反复并发外呼；(2) 冷启动（声明了 `recommendCacheTtlSeconds` 且无缓存）由「同步阻塞等待」改为 **2500ms 软截止竞速**，超时不阻塞、返回 `pending:true`，真值由后台同一条在途 promise 回填，provider 本轮失败亦置 `pending`（避免前端当成稳态空而停止重试）；(3) 前端 `Home` 本地随机纳入 **8s×≤6 次轮询自愈**（`pending` 或请求失败均重试，失败不再清空已渲染内容、保留 last-good），补 `onDeactivated/onActivated` 修正 keep-alive（`MainLayout` max=10）下 `onUnmounted` 不触发导致的定时器后台空跑与在途回填续期，并加请求防重入。
- **下载 / 洗版任务「取消」语义修正，并新增「完全停止」**：原「取消」= 立即彻底终止整个任务流程，导致已在下载中与缓存中待转码的歌曲被硬停、目录落地不完整。现拆分两种语义：**取消** = 停止查找新歌曲、不开启新任务，但已在下载中/待转码的歌曲**完整走完**下载 → 转码 → 落地对应目录的全流程（排空式）；新增**完全停止** = 彻底终止整个任务流程（即原「取消」行为）。两个按钮均配置**二次确认弹窗**，完整说明确认后将产生的后果。

### Internal

- 只动后端启动路径与 `entrypoint.sh`，不含前端；在 230 主线落地前完成本地门禁自检（`tsc --noEmit`、`sh -n entrypoint.sh`、定向 `vitest tests/fetch` 31 文件 / 540 用例全通过、diff 无 CR 行尾）。
- 首页卡死修复与下载/洗版语义改造在 230 主线落地前完成本地门禁自检：backend `tsc --noEmit` 0 error；定向 `vitest`（`providerCache` / `recommendRoutesContract` / `chartLocalPlatRoute`）3 文件 54 用例、`tests/fetch` 域 35 文件 600 用例全通过（含新增「冷启动超软截止 → `pending:true`」回归用例）；frontend `vue-tsc --noEmit` 0 error、全部 `check-*.mjs` 守卫通过；diff 无 CR 行尾；并完成落地前后两轮独立审查。
- 宿主资源超卖、容器内单点 DNS 与候选源 15s 超时兜底属外部/后续评估项，不在本版范围；按约定不在本版部署生产环境。
- 已识别但**本版不落地**的残留项：内置 `local-random-recommend` 未声明 `recommendCacheTtlSeconds`，其候选池 `getPool()` 冷时仍走**同步** `buildPool`，而 `setTimeout` 软截止无法抢占同步阻塞；根治需把 `invalidatePlatformPool()` 由「置 null」改为「置脏标记 + 后台重建」（会改变「导入后立即可见」的既有 QA 语义，待评审后另行处理）。

## [4.6.19] - 2026-10-15

### Fix

- **修复 v4.6.17 / v4.6.18 的 CI 全红（`ci` 与 `build-and-push` 双双失败）**：本轮 CI 只有**一个**失败点 —— `tests/qa_perf/randomness.test.ts` 的「TTL 过期(120s)后自动重建」用例仍按旧的**同步重建**语义断言，与 v4.6.17 引入的候选池 **SWR**（过期首轮继续供旧池、后台单飞重建）相冲突（实测 `Set{'p-old'}` ≠ 期望 `Set{'p-old','p-new'}`；504 个测试文件 503 通过、6825 个用例仅此 1 条失败）。用例已改为 SWR 语义：过期首轮仍返回旧池（不阻塞），排空微任务（后台重建落地）后**下一轮**无需 `invalidate` 即见新歌单，原「自动重建」意图不变。

### Perf

- **全站前端页面只读审计后的 8 处「串行卡点」全部并发化**（批次限流，语义与顺序保持不变）：
  - **艺人详情「播放全部」**：逐专辑 `getAlbum` 串行 → 分批并发（每批 6 个），按下标回填以保留「专辑顺序 + 专辑内曲目顺序」；按钮补 `loading` + 禁用，避免拉取期间重复点击。
  - **流派页「加入歌单 / 新建并加入」**：逐首 `updatePlaylist` 串行 → 分批并发（每批 6 个）。
  - **歌单详情「批量移除」**：逐首 `updatePlaylist` 串行 → 分批并发，批量条按钮补 `loading` 防重复点击。
  - **歌单详情「起播前批量匹配」**：逐首 `match-track` 串行 → 分批并发，按下标回填保持未匹配曲目原顺序。
  - **管理端「插件配置 · 参考歌单」选项**：最多 50 页、每页 200 的全量翻页由逐页串行 → **每批并发 5 页**；终止条件沿用原语义（集齐服务端 `total` 或整批无返回即停，兼容后端 pageSize 硬上限的静默截断），单页失败不拖垮整批。
  - **「流转 · 控制」目标下拉**：DLNA / 分组 / AirPlay / Sendspin 四类发现原为串行 4 连发（选择器要等 4 个 RTT）→ 并发一波，合并顺序不变，单接口失败只丢该类。
  - **首页预热**（`stores/preload.ts`）：原先先 `await` 收藏再发 4 个列表请求 → 收藏并入同一批并发（`loadFavorites` 自身吞错，语义不变）。
  - **流派页「加入歌单」对话框**：每次打开都全量重拉 `getPlaylists` → 组件内缓存一次，新建歌单后增量并入缓存。
- 新增 `frontend/src/utils/asyncTask.ts` 的 `runBatched<T>(items, fn, batch=6)`：批内 `Promise.all`、批间串行；批内任一失败即抛出并中止后续批次（与原串行版本「遇错即停」一致）。

### Internal

- **明确不做（评估后不纳入本轮）**：聚合搜索（`composables/useEntitySearch.ts`）慢在后端全插件并发，前端仅 1 个 `/aggregate/search` 请求且已有 15s 超时；`api/index.ts` 的全局超时 / 去重 / 并发上限 / 重试改造面过大且影响全站，均保持不动。
- 本轮 GitHub 推送由 **230 主机中转**完成（代码先落到 230 主线、提交与 push/tag 均在 230 执行），纠正 v4.6.16 记录过的「本机直连」偏离。
- 验证方式：本机无 Node 工具链，改动先在 230 主机执行 `vue-tsc --noEmit` 与后端定向 `vitest` 自检，再由 CI 全量门禁（`ci.yml` / `build.yml` 的类型检查 + 全量测试）复核。按既定约定本轮**不部署生产 240**。

## [4.6.18] - 2026-10-15

### Fix

- **修正 v4.6.17 聚合缓存落库的静默失效（复查发现）**：`routes/api/recommend.ts` 的 write-through 裸 SQL 把列名写成 drizzle 属性名 `updatedAt`，而 `settings` 表的真实列名是 `updated_at`（见 `services/settings.ts`）——INSERT 在 `prepare` 阶段即抛 `no such column`，被同一 `try/catch` 吞掉，表现为「看似落库成功、实则从未写入」，**v4.6.17 的「重启后不再冷」实际未生效**（冷启动非阻塞、单飞、池 SWR 三项不受影响）。现已改用正确列名并加注释警示；同批清理语句同步修正。
- **恢复冷启动失败后的前端诊断提示**：v4.6.17 起冷启动不再阻塞，前端轮询上限（12×8s≈96s）耗尽即静默留空，丢掉了改造前 150s 超时会给出的「请检查 go-music-dl 插件…」提示。现将上限提至 18 次（≈144s，与旧 150s 超时窗口对齐），耗尽仍无内容时置 `recommendError` 给出提示。
- 复查其余改动（三态路由语义、single-flight + 60s 退避、池 SWR、测试 mock 缝适配）未发现新问题；`/v1/recommend/refresh` 不写聚合缓存，无需同步退避表。

## [4.6.17] - 2026-10-15

### Perf

- **首页「各平台精选」全链路零阻塞（冷启动卡顿根治）**：此前 `GET /v1/recommend` 无任何缓存时会**阻塞式**逐个外呼 go-music-dl + 全部榜单插件（前端为此把超时放宽到 150s），且冷启动路径没有 single-flight——并发打开首页会各自外呼一遍；预热器又只预热「已有缓存」的 key，服务端重启后第一炉必然冷。本轮四项把「打开页面时等」改成「后台慢慢搬、搬好自动出现」，**各平台精选区块保留**：
  - **聚合缓存落库持久化**：`routes/api/recommend.ts` 新增 write-through（内存 + `settings` 表 key `recommend.aggCache.<cacheKey>`），内存 miss（reclaim 回收 / 进程重启）从 DB 回灌，DB 行超 7 天清理——重启后不再冷；
  - **冷启动改非阻塞 + 单飞**：无任何缓存时立即返回空频道 + `pending:true`，后台 single-flight 拉取（成功落库，失败 60s 退避，防前端重试打爆故障中的上游）；
  - **预热器补 DB 回灌判断**：内存 miss 回退读 DB——首页被用过就照常预热刷新，从未访问过的 key 仍不做无谓外呼（既有哲学保留）；
  - **本地随机候选池 SWR 化**（`services/plugin/localPlatformRecommend.ts`）：120s 池过期不再同步重建（旧池继续供本轮洗牌 + 后台单飞重建），消除每 2 分钟一次的同步 DB/封面探测慢脚；`invalidatePlatformPool` 显式失效仍同步重建（新歌单立即可见）。
- **前端配套**（`views/Home/index.vue`）：收到 `pending` 显示中性色占位提示（i18n `home.recommendPending`），每 8s 轮询重试（≤12 次 ≈96s），数据到位自动填充；超时从 150s 降回默认（后端已不阻塞）；卸载时清理轮询定时器。渐进渲染分区结构不变，快区块不受影响。

### Test

- 更新 `/v1/recommend` 冷启动相关契约用例为「先 pending 空 → flush 后台拉取 → 二次请求拿数据」时序；新增聚合缓存落库回灌、失败 60s 退避不重复 kick、候选池过期 SWR 三类用例；导出测试钩子 `__resetRecommendRefreshStateForTest()` 供用例间清退避/在途表。

### Internal

- **T01（客户端优先透传 + 排队深度指标）经分析后拍板不做**，设计决策已写入 `services/transcode.ts` 文件头与并发池段注释（自用项目转码量小；透传会绕过网络源试听片段预提取闸门并丢失响度归一）。
- 验证方式：本机无 Node 工具链，类型检查与全量测试由 CI 门禁把关（`build.yml` 失败自动回滚镜像并删除 Release）。
- 按既定约定本轮**不部署生产 240**。

## [4.6.16] - 2026-10-15

### Refactor

- **删除 `proxyFetch` 的 per-request `proxy` 覆盖开关（未完成事项 T02）**：`services/proxy.ts` 的 `ProxyFetchInit.proxy`（true 强制走代理 / false 强制直连）在全仓三个调用方（插件市场拉取、插件沙箱 `host.http`、插件发现）**均未传参**，属零调用点的悬空 API。本次整体删除该类型与三态判定，`proxyFetch(url, init?: RequestInit)` 只按**系统设置**决定走代理或直连，对外语义不变；同步把 `tests/services/proxyDispatcher.test.ts` 的三态用例改为「系统设置两态」覆盖（开启转发 / 关闭直连 / 地址非法降级直连 / 同地址复用 agent / FIFO 淘汰并 close），并更正 `docs/sandbox-limits-and-plan.md` D2 的过时描述。

### Feat

- **HTTP 指标补「真实流量首字节时延」（未完成事项 T03 + T21）**：`middleware/metrics.ts` 新增出流族与封面族的 TTFB 采样与 p95 告警，补齐此前只有「上游→服务端」金丝雀探针（`streamProbe`，只量上游网络那一段）的空白。
  - 出流族 `/rest/stream`（T03）：中间件量的是「请求进入 → 响应可发」，而出流路径 `serveFfmpegPipe` 在回话前会等 ffmpeg 首个输出字节（启动裁决），故该值即**服务端侧端到端首字节**（客户端网络那段服务端量不到，只能到此为止）。
  - 封面族 `/rest/getCoverArt`（T21）：适应度函数「封面时延 ≤2s」此前无落点，现按该上界判定（env `HTTP_COVER_TTFB_WARN_MS`，默认 2000）。
  - 两族各留一份环形样本（env `HTTP_TTFB_SAMPLES`，默认 200），快照 `ttfb.cover / ttfb.stream`（样本数 / p50 / p95 / max / 告警线 / 是否越线）随 `GET /v1/admin/metrics` 一并暴露；告警按 **p95 状态翻转**只在越线、回落各打一条（冷缓存下封面排队 1~3s 是既有水位，逐样本告警只会把真信号淹掉），样本数不足（`HTTP_TTFB_MIN_SAMPLES`，默认 20）不判定。
  - 只对**真产出媒体字节的 200** 计时：Subsonic failed 信封（HTTP 200 + `application/json`）、304 未改、499/中止一律排除 —— 否则 ffmpeg 首字节失败（最长等 15s 才回错）会把 p95 顶起来，制造与在线播放无关的误告警。
  - 采样点复用既有中间件，**不碰出流热路径**（出流响应体仍是原来的 `PassThrough` 直通）。

### Internal

- **T04（第三方 `bonjour-service` 日志噪声）复核结论：不改代码，记为已知可接受噪声**。噪声源是第三方库的名称冲突探测（`registry.js:32`），仅在测试进程收尾的**迟到 console 输出**上触发；生产侧不改，测试侧已由 `backend/vitest.config.ts` 的 `disableConsoleIntercept`（仅 Sendspin Guard 作业置位）从结构上消除竞态。升级 / 替换该依赖风险高于收益（mDNS 发布是 AirPlay / Sendspin 发现的核心链路），故整体不做，理由见本轮报告。
- 验证方式：本轮执行环境无 Node 工具链（node / npm 均不在 PATH，本机未安装），本地**无法执行** `npx tsc --noEmit` 与 `npx vitest run`；改动由 CI 全量门禁把关（`ci.yml` / `build.yml` 的「类型检查 + 全量测试」），且 `build.yml` 在测试失败时自动回滚 :latest/:version 并删除刚建的 Release（发版自愈）。
- 新增 / 改写用例覆盖：`tests/middleware/metrics.test.ts` 的「TTFB 告警线默认值」「快照空样本为 null」「封面 p95 越线只告警一次」「出流采样入快照」「失败信封不计入」；`tests/services/proxyDispatcher.test.ts` 的「系统设置两态」。
- 因构建主机网络故障，本轮 GitHub 推送仍由本地经 `musicflow` 远端直连完成（偏离「经 230 中转」约定，如实记录）。按既定约定本轮**不部署生产 240**。

## [4.6.15] - 2026-10-14

### Perf

- **Web 管理端剩余优化全部落地（把 4.6.14 评估后延后的 4 项一并做完）**：①「插件管理」页由单文件 2086 行拆为 `InstalledTab / MarketTab / MediaTab` 三个子组件（父级 `installedCtx / marketCtx / mediaCtx` 共享状态与动作，首屏仅挂「已安装」页签），`index.vue` 净减 516 行；②「群组」页群组列表补首载 `el-skeleton` 骨架屏（`v-loading` 改为有数据才显示）；③`main.ts` 用 54 个 `element-plus/theme-chalk/el-*.css` **静态按需引入**替换 EP 全量 `dist/index.css`（体积约 357,679B → 213,912B，约 −40%），全部按序排在 `global.scss` 之前以保住主题覆盖顺序，`vite` 双 resolver 设 `importStyle:false` 杜绝运行期动态注入；④「歌单」页 `playlist-search/providers` 增加 60s 模块级缓存（切走再回不重拉）。

### Fix

- **`admin/Fetch`「新建」页签独立 loading**：切到新建页签时才拉入库计划，并以独立 `createLoading` 遮罩包住该面板，不再与整页共用 loading、也不阻塞其它页签。
- **插件能力列表 60s 缓存陈旧窗**：`useEntitySearch` 新增并导出 `invalidateProvidersCache()`，插件启用 / 停用 / 安装 / 卸载成功回调里主动清缓存（3 处调用点），消除 60s TTL 内的陈旧读取。

### Test

- 新增 Playwright 用例 `frontend/e2e/first-paint-requests.spec.ts`：断言「音乐下载」页首屏**不触发** `fetch/upgrade/plan`、`fetch/library/plan` 两个全库扫描端点，切到对应页签才触发，且首屏 REST 请求数 ≤ 20；已接入 `frontend-responsive.yml` 门禁。

### Internal

- 因构建主机网络故障，本轮改为在本地 worktree 完成并验证：`vue-tsc --noEmit` EXIT=0、`npm run build` EXIT=0；构建产物 `index-*.css` 实测含 `.el-overlay / .el-loading-mask / .el-table / .el-tag / .el-dialog / .el-popper / .el-switch / .el-empty` 等关键选择器，未发现未套样式组件。
- 首屏实测（本地 preview）：`/playlists` DCL 362.9 / 378.8ms、load 389.1 / 407.1ms；`/admin/fetch` DCL 372.6 / 381.5ms、load 401.5 / 410.0ms。
- 遗留（不阻塞）：`InstalledTab.vue` 含少量自 `MarketTab` 复制的死 CSS（`.registry-*`），后续清理。后端零改动。按既定约定本轮**不部署生产 240**。

## [4.6.14] - 2026-10-14

### Perf

- **Web 管理端各页面打开速度优化（削减首屏并发请求 + 常驻轮询）**：按全页面打开速度审查结论逐条落地，纯前端、不改后端契约、不改首屏视觉语义。①「插件管理」三个页签补 `el-tab-pane lazy`（非当前页签整块不挂载），媒体设置从首屏移出、由切到媒体页签时再拉（默认的「已安装」页签所需的版本+健康列仍在首屏加载，保证健康状态不错位）；②「播放器/群组」页设备发现分区（本机实例 / DLNA / AirPlay / Sendspin）改为按视口懒加载——进页由 7 个并发 GET 收敛为「群组列表 + 两份偏好 + 屏内可见分区」，屏外分区滚动到附近（提前 200px）才发请求，每区只自动拉一次，无 `IntersectionObserver` 时兜底全量；③「歌单」页 busy 轮询由固定 4s 常驻改为两级（忙 4s 紧跟 / 闲 15s 心跳，保留「别处起任务也能提示」的能力），并在切走页面时停表；`detectDailySource` 与 `loadImportPlatforms` 移出首屏（二者打的是同一个较重的 `/rest/api/v1/plugins`，且各自在真正用到时都会自补）；④「设置」页 6 张配置卡改为进视口才拉（版本 / 代理 / 档位 / 定时 / 内存 / 日志等级），非管理员无日志卡即天然不发请求；⑤ 插件能力列表（`useEntitySearch`）加 60s 模块级共享短缓存，音乐 / 艺术家 / 专辑三页共用 1 次请求；⑥ Sendspin 配对 5s 轮询改为「有配对进行中才跑」（配对表单打开，或服务端仍有 pending attempt），并随页面激活/停用收放。

### Fix

- **keep-alive 下三处常驻轮询切走后仍在跑（缓存页定时器泄漏）**：全站路由视图包在 `<keep-alive max="10">` 中，`onUnmounted` 在切走页面时不会触发 —— Groups 的 20s Sendspin 连接状态轮询、Playlists 的 4s busy 轮询、SendspinPairing 的 5s 配对轮询此前都会一直打到会话结束（原注释「离开页面即停」在缓存下不成立）。三处均补 `onDeactivated` 停表 / `onActivated` 复表（配对轮询同时收敛为条件触发），`onUnmounted` 保留作最终兜底。

### Internal

- 审查结论（含两条对原审查清单的事实修正，均已按代码现状改方案）：原清单「Groups 首屏只拉 `loadGroups`」与模板实际顺序不符（页面顺序为「本机实例 → DLNA → AirPlay → Sendspin → 群组列表」，群组列表在页面末尾），故改为**按视口懒加载**而非颠倒请求优先级；原清单「Plugins 的 `loadHealth` 延后到市场页签」会令默认页签的健康列显示未知，故 `loadHealth` 保留在首屏。
- 本轮**未做**（评估后延后，理由留档）：Plugins 拆 3 个子组件（`lazy` 已使首屏只挂当前页签，拆分对首屏零额外收益、却是 2000+ 行文件的高风险重构）；首屏分区骨架屏（Favorites 与各设备分区已是分区 loading，唯一整块遮罩只等 1 个轻请求）；Element Plus CSS 按需引入（主题优先级回归风险高，需单独立项验证）；Playlists 的 `playlist-search/providers` 缓存（另一端点，keep-alive 下每会话仅 1 次，收益≈0）。
- 验证：230 前端 `vue-tsc --noEmit` 干净、`vite build` 成功（即 CI 镜像阶段前端门禁）；前端仓库无单测基建，故本轮无「请求数断言」自动化用例（记为 follow-up）。后端零改动，CI 全量门禁照常执行。按既定约定本轮**不部署生产 240**。

## [4.6.13] - 2026-10-14

### Fix

- **Web 管理端「关代理」即时生效**（`frontend/src/views/Settings/index.vue`）：代理开关此前只有 `v-model`、没有 `@change`，且 URL/测试/保存整行包在 `v-if="proxyEnabled"` 里——开关拨到关闭的瞬间保存按钮随整行一起消失，于是「关不掉、刷新又看到它自动回到开」。现在：①开关补 `@change="onProxyToggle"`，切换即 `PUT /rest/api/v1/proxy {enabled,url}`（loading 期禁点，成功以服务端返回 `{enabled,url}` 回写，失败回滚并报错），后端 `setSetting` 写库即刷缓存，故**关闭立即生效**、无滞后；②URL/测试/保存行移出 `v-if`，任何状态都有明确的保存按钮。
- **「音乐下载」页打开卡加载（治本 + 治标）**：根因是该页初始化一次性发 8 个请求，其中「洗版计划」「入库计划」两个接口会同步全表扫描（`better-sqlite3` 阻塞事件循环），把整页拖成「卡加载」，切标签还会重复触发。治本——后端 plan 端点新增「只要计数」SQL COUNT 快路径：`buildLibraryPlan` 在 `limit<=0` 且无 songIds 点名时走新增的 `countLibraryPlanStats`（两条 COUNT 出 total/attempted/cooled/pending），`buildUpgradePlan` 新增 `statsOnly`，`GET /v1/fetch/upgrade/plan` 未带 `limit` 时启用（`countUpgradePlanStats`）；两条路都不再把全库/目标目录行 materialize 成 JS 对象。建任务的 `POST /tasks` 仍走明细路径，条目选择与截断语义零改动。治标——前端两个全库统计移出 `onMounted`，改为**首次切到对应标签才拉**（之后由标签内「刷新」按钮手动重拉），两个任务列表面板加 `el-tab-pane lazy` 懒挂载；首屏（默认停在「配置」标签）不再触发任何全库扫描。

### Internal

- 实测（230 开发库 23,719 行）：库池慢路径（8 列 + `ORDER BY rowid` + map，命中 23,717 行）174.5ms → 新 COUNT 21.3ms（约 8×）；240 生产 134,500 行线性外推约 1.0s → 0.12s。`songs(path)` 索引（`idx_songs_path`）本已存在故未新增；短 TTL 缓存未引入（COUNT 后单次已约 0.12s 且不再首屏触发，避免新增失效耦合）。
- 新增等价性用例 5 条：`tests/fetch/library.test.ts` 2 例（`limit=0` 快路径 ↔ `limit=10` 明细路径的 total/attempted/cooled/pending 四项一致 + 冷却窗口外只计 attempted）、`tests/fetch/upgrade.test.ts` 3 例（`statsOnly` 四项与明细一致且 `items=[]`、冷却期外恢复、songIds 点名不吃快路径）。验证：`tsc --noEmit` / `vue-tsc --noEmit` 干净；`tests/fetch` 31 文件 79 用例全绿；全量后端 6817 用例 → 6816 过 + 1 例满负载 flake（`tests/plugins/sandbox.test.ts` 内存自愈用例，隔离复跑 28/28 全绿，与本次改动无关，CI 单进程串行不复现）。
- 按用户 2026-10-14 拍板：**不做**服务端按域名分流（Gitee 直连是期望、现状已直连；GitHub 走代理的现状保持），故本次服务端网络路径零改动。

## [4.6.12] - 2026-10-14

### Feature

- **fetch 转码总闸（设置页「同时转码数上限」，默认 4）**：下载进缓存后立即转码，但转码步骤此前没有任何进程数上限——同时推进几首歌就同时起几个 ffmpeg（响度归一化两遍法时单首 2 次），与洗版任务叠加时更甚；转码是 CPU 重活，全部堆起来会打满机器挤占播放/流转。新增 `maxConcurrentTranscodes`（1..16，默认 4）：同一时刻最多 N 首歌在跑 ffmpeg 转码，超出 FIFO 排队；下载任务与洗版任务走同一条 orchestrator 流水线，一个闸两类都覆盖。`finally` 保证成功/失败/取消三条路都释放闸位；排队等待超 2s 记日志便于调参。config 归一化夹值 + PATCH 路由 clamp + 前端设置页加输入框（zh/en 文案）。

### Internal

- orchestrator 复用 `limiter.Semaphore` 建转码闸（PATCH22）；新增 `tests/fetch/transcodeGate.test.ts`（并发峰值 ≤ 上限且非串行、失败经 finally 释放、配置归一化缺省 4 夹值）；fetch 域回归 31 文件 535 用例全绿、frontend vue-tsc 干净。
- `playerGroup.test.ts` afterAll 停服后排空残留异步日志（setImmediate ×5 + 50ms）：满负载（CI 803s 全量）下 in-proc Sendspin 停止后 pump/ws/编码器最后一拍 console 输出仍在飞，worker 关闭时 `onUserConsoleLog` RPC 未送达 → EnvironmentTeardownError 计为 unhandled error → 门禁 6811 用例全绿仍 exit 1 并触发回滚（2026-10-14 CI 实测）。产品码零改动。

## [4.6.11] - 2026-10-14

### Internal

- **起播 TTFB 探针逐项复核修复（S1/S3/S4/S5/S6/S7）**：① TTFB 定格**提前到 `reader.cancel()` 之前**（原先把断连耗时也计入，指标被系统性抬高）；② 非 2xx 分支显式 `res.body.cancel()` 丢弃响应体（原先不读不弃，undici 连接只能等超时回收）；③ `middleware/metrics.ts` 的 `isStreamRequest` 去掉死的 `method` 形参；④ 删除死代码 `streamProbeSchedulerRunning()`（全仓无引用）；⑤ 收敛「绝不与播放抢上行带宽」的措辞——避让窗是「起播后 `STREAM_PROBE_QUIET_MS`（默认 60s）」，长于 60s 的曲目播放中仍可能被探一次（单次 ≤ 一个 chunk）；⑥ 补 `STREAM_PROBE_SONG_ID` 的 env 说明（原先只在代码里兜底）。经复核**不改**：「skip 不推进探测间隔闸」（见 4.6.9）是「开关/选歌静默生效」的机制本身，改为按间隔收敛会让用户改配置后最长等 1h 才生效。

## [4.6.10] - 2026-10-13

### Internal

- **服务端 WS 增加协议层 keepalive（ping/pong 半开清理）**：`backend/src/services/ws/index.ts` 每 30s 对所有连接 `ws.ping()` 并置活跃位，收到 pong 复位；连续两轮（60s）未回 pong 判为半开并 `terminate()`——触发 close 回调（连接计数归零、标记实例离线、释放 clientId 定向投递坑位）。此前服务端只被动响应客户端应用层 ping，若客户端不发（如 Flutter 客户端）又不回协议 pong，半开连接会一直留在 `wss.clients` 里：`sendToLocalPeer` 看到 `readyState===OPEN` 误判投递成功，实际对端收不到，表现为「能看状态、按不动」。浏览器 / `web_socket_channel` / aiohttp 都会自动回协议 pong，不依赖客户端配合。
- **Web 前端 peer WS 健壮化**：`frontend/src/stores/player.ts` 的 `peerWs` 补齐——每 25s 发 `{"type":"ping"}`、75s 无帧看门狗（半开主动关闭重连）、重连退避由固定 3s 改为 3s→30s 指数退避（连接成功复位），并新增 `onopen` 复位逻辑与重连定时器清理。此前只有「onclose → 固定 3s 重连」，无心跳、无半开检测——与客户端同源的「看得见、按不动」隐患。

## [4.6.9] - 2026-10-13

### Feature

- **起播 TTFB 金丝雀探针（设置页开关，默认关闭）**：新增「插件管理 → 媒体获取 → 起播 TTFB 探针」卡片，用户可随时开关。开启后立即探一次，之后每小时一次：直接打上游 URL（与出流/预取共用同一份 `resolveNetworkInput` 推导，只读首字节即取消，≤64KB/次），量「上游+网络」腿的 TTFB，补真实流量覆盖不到的两块信号 —— 空闲时段心跳（个人实例一天 20h+ 空闲，这是那段时间唯一的连续信号）与源配置静默腐烂检测（WebDAV 密码轮换/插件登录态过期，提前几小时暴露，不用等用户播不了才发现）。三条卫生条件：① 开启必须钉死具体歌曲（UI 选歌对话框，后端 400 双保险 —— 自动选歌会悄悄换测量对象、源死了天天误报）；② 播放中避让（出流族请求进 middleware 即登记，起播后 60s 内不探，绝不与播放抢上行带宽）；③ 失败仅在健康状态翻转时 warn（healthy→failing / failing→healthy，中间态转 debug，防每小时一条噪音）。TTFB 超 `STREAM_PROBE_TTFB_WARN_MS`（默认 10s）即使成功也 warn。卡片状态行展示 health / 上次 TTFB / p50 / p95 / 样本数 / 跳过原因；快照同时挂 `GET /v1/admin/metrics`（运维面板与 UI 同一份真源）。env 旋钮：`STREAM_PROBE_INTERVAL_MS` / `STREAM_PROBE_TTFB_WARN_MS` / `STREAM_PROBE_TIMEOUT_MS` / `STREAM_PROBE_QUIET_MS` / `STREAM_PROBE_SAMPLES` / `STREAM_PROBE_SUMMARY_EVERY`；`STREAM_PROBE_ENABLED=1` 仅在 UI 从没保存过时兜底（与 prefetchConfig 同纪律）。与字面 `/rest/stream?timeOffset=1` 方案的有意偏差：那条路要 Subsonic 鉴权，且会穿过整条缓冲机制（注册 membuf、等头窗、可能顶掉正在播的条目）—— 探针反而可能干扰它要观测的对象；贴近播放体感的全链路分位留待真实流量 tap（独立任务）。

### Internal

- 新增 `services/source/streamProbeConfig.ts`（settings 键 `stream.probe.settings`，读序 settings>env>默认，PUT 合并语义，开启无歌返回 i18n 键 `errors.streamProbe.songRequired`）与 `services/source/streamProbe.ts`（环形缓冲 + nearest-rank 分位、single-flight、30s tick 调度使开关/歌曲改动静默生效、状态机仅翻转告警、skip 不推进探测间隔闸）；`middleware/metrics.ts` 新增 URL 路径级 `isStreamRequest()`（中间件入口即判，不等路由模板 —— 模板要等 next() 跑完才定型，避让登记必须在请求进入时生效）并登记播放活动；`routes/api/settings.ts` 新增 `GET/PUT /v1/playback-sources/probe-settings`（开启即探一次）+ admin/metrics 快照挂载；`i18n.ts` 补 zh/en 双语文案。
- 新增单测：`tests/source/streamProbe.test.ts`（31 例：skip 优先级 / 失败归因 / nearest-rank / 环形缓冲封顶 / 调度与间隔闸 / single-flight / 配置层合并校验与 env 兜底）；`tests/routes/streamProbeSettingsRoute.qa.test.ts`（7 例路由合同：默认关 / 开启无歌 400 / 合并语义 / 落库键隔离 / admin 三态 / metrics 快照，beforeEach 复位保证 shuffle 下自足）。`scripts/pull-240-monitor.sh` 新增 `pull_probe()`（独立游标拉 `[STREAM-PROBE]` 行 → `logs/monitor-240/probe.log`，与 deadlink 游标互不推进）。

## [4.6.8] - 2026-10-13

### Feature

- **起播缓冲阈值自适应（投影早退 + 冷播放搭车）**：整曲内存缓冲的起播有界等待从固定 6s 改为**分档 + 投影感知** —— 总大小已知（上游 Content-Length 有值）时上界 8000ms，给慢源（在线源实测 0.85~2.3MB/s）多 2s 冗余；大小未知（chunked）维持 6000ms。等待期间读 single-flight 循环的取流进度（新增 progress sink，100ms 节流上报），观测 >=1.2s 且 >=256KB 后按「已下字节/耗时」推算整曲总时长，超上界**立即**回退直通 —— 慢源不必傻等到上界（白等 + 逼近反代 ~10s 超时线 502），后台 single-flight 循环照常跑、缓冲落地后下一个请求命中；快源行为不变（上界内落地即 membuf 回环供流，实测 4ms）。另：同一首（解析后 id）有预取正在飞时，冷播放**搭车**等这一份落地（有界），不起第二份下载 —— 带宽是共享资源，双跑只会两边都变慢、还双倍占 membuf；预取失败/判死则落冷路径（此时判官负缓存已写好，选源/跳过行为与今天一致）。env `STREAM_BUFFER_HEAD_WAIT_MS` 覆写钳 <=8000（反代 10s 超时线前的安全余量）。不影响预取完整性判官与「非完整歌曲自动跳过」判定（判官只跑在后台预取的完整 Buffer 上，本改动零触碰）。

### Internal

- `bufferedFetch.ts`：读循环新增 progress sink（`{downloaded, elapsedMs, sizeBytes}`，跨 attempt 重置、100ms 节流上报，纯观测零行为改变）；新增纯函数 `projectedTotalMs()` / `shouldBailEarly()`（最少观察 1200ms + 最少采样 256KB，观测不足一律不早退）与 `retryLoopProgress(key)`；single-flight 循环条目挂 progress 对象。
- `prefetchCache.ts`：新增 `inflightByResolved` 在途登记表与 `prefetchInFlight()` 搭车入口（只在预取真正开跑后登记，排队中/被闸门拦下不算）；判官、五道闸门、候选链、负缓存、双写索引逻辑零改动。
- `routes/rest/index.ts`：`STREAM_BUFFER_HEAD_WAIT_MS` 6000->8000，新增 `STREAM_BUFFER_HEAD_WAIT_UNKNOWN_MS=6000` 与 `headWaitCeilingMs(sizeKnown)`（env 覆写两档统一、钳 <=8000；进度里一拿到 Content-Length 上界即单调放宽到已知档）；`bufferNetworkSource` 的等待改为 `boundedBufferWait`（固定上界分档 + 投影早退双判据）+ 搭车分支，对外语义不变（成功/显式失败/回退直通三态不动）。
- 新增/扩充单测：`tests/source/bufferProjection.test.ts`（纯函数 13 例 + 集成 4 例：快源上界内落地 / 慢源投影早退且后台循环不取消 / 搭车零第二份上游 / 未在途走冷路径）；`tests/source/bufferHeadWait.test.ts` 跨仓契约守卫扩充（分档两档、env 钳位、投影护栏值）。配套客户端 v5.8.4（镜像常量 6000->8000 + `AudioLoadConfiguration` 单一常量源）。
## [4.6.7] - 2026-10-13

### Fix

- **插件 create() 失败路径遗留 QuickJS 句柄**：`SandboxHost.init()` 的 create(host) 抛错分支未先释放 `pluginHandle` 就同步 dispose，残留句柄把对象钉在 `rt->gc_obj_list` 上，`runtime.dispose()` 命中 `list_empty` 断言（日志刷 `Aborted(...)` 并毒化共享 WASM module）。补齐该分支句柄释放，与其余 init 失败分支对齐。回归验证：create 失败用例断言数 1→0，沙箱三件套聚焦跑 4→2（余下 2 处均为设计内灵敏度校准用例）；全量 vitest 回归 500 文件全绿。
## [4.6.6] - 2026-10-13

### Fix

- **整曲缓冲「首字节等待」跨仓契约显式化**：`STREAM_BUFFER_HEAD_WAIT_MS`(默认 6000ms) 由模块内常量改为 `export`，并在注释中写明跨仓不变式 —— 本值必须**严格小于**客户端「平台未接管音源(idle)」档的判死上界（客户端默认 10s），并留 >=1.5s 余量；否则服务端仍在合法缓冲窗口内、客户端已抢先判死，造成无谓 reload/跳歌并拆掉在途请求、让服务端重开重试窗口。本值同时须低于反向代理首字节超时(10s)以免 502。两侧各有一处守卫用例钉死该不变式。配套客户端 v5.8.2。

### Feature

- **封面渲染压力信号（端到端背压）**：新增 `getCoverPressure()` 与 `buildCoverPressureHeaders()`；`/rest/getCoverArt` 的成功响应现在回传 `X-MusicFlow-Cover-Concurrency` / `-Active` / `-Queued`，管线饱和（有排队或渲染槽位占满）时追加 `Retry-After: 1` 与 `X-MusicFlow-Cover-Saturated: 1`，供具备请求头能力的调用方（Web XHR/fetch）对齐自身封面并发并退避。抽成纯函数便于确定性单测。

### Internal

- 新增/扩充单测：`tests/services/coverImage.test.ts`(压力快照与饱和/未饱和两条分支)、`tests/routes/coverBackpressure.test.ts`(端到端:成功取图回传并发上限头)、`tests/source/bufferHeadWait.test.ts`(跨仓契约用例)。
## [4.6.5] - 2026-10-12

### Fix

- **封面慢请求三件套（A/B/C）**：240 容器日志 24 小时内共 104 条 `慢请求 route=/rest/getCoverArt`（ms 1035~3068）。用「到达时刻 = 完成时刻 − 耗时」反推，这 104 个请求挤在 **约 170ms 的窗口**内同时到达（14:25:42.46~42.63），随后约 2s 排空 —— 是**一次性冷缓存并发突发**，不是周期性劣化、也不是缓存泄漏。三处同时对治：
  - **A（别把设计内的慢当告警）**：慢请求阈值从全局硬编码 1s 改为**按路由分级**，默认值全部可用 env 覆盖 —— 全局 `HTTP_SLOW_MS=1000`；`/rest/getCoverArt`（含 `.view` 与 POST 兼容别名）走 `HTTP_SLOW_MS_COVER=5000`；`/rest/stream` 族与 `/rest/dlna/stream/:token` 走 `HTTP_SLOW_MS_STREAM=7000`（**必须**大于出流侧默认 6s 的有界首字节等待，否则每次缓冲超时都刷一条告警）。**未列出的路由一律保持全局底线** —— 分级是"豁免已知的慢"，不是"抬高全局底线"。慢请求日志新增 `budget`（本次适用的预算）与 `client`（`x-mf-client-id` 优先，回落 UA 片段），下次噪音复现能直接钉到来源设备。
  - **B（让渲染链路扛得住突发）**：① **同 ETag 在途单飞** —— 同一张封面常被网格 / 播放器 / 队列同时请求，此前会重复渲染 N 遍，白占 sharp 吞吐（实测天花板约 130 张/秒）；② **渲染并发信号量**（`COVER_RENDER_CONCURRENCY`，默认 4）—— 这不是性能旋钮（实测吞吐与并发基本无关），而是**内存护栏**：每个在途渲染都攥着一张全尺寸解码位图（1200×1200 ≈ 5.8MB 原生内存），上百并发就是数百 MB 的瞬时 native 峰值；③ **缓存上限 env 可调并放宽**：`COVER_RENDER_CACHE_MB` 32→48、`COVER_RENDER_MAX_ENTRIES` 500→1500（原图字节缓存不变：`COVER_CACHE_BUDGET_MB` 64、`COVER_CACHE_IDLE_MINUTES` 5）；④ **编码参数调优**：JPEG 去掉 mozjpeg（体积 +约 25%，吞吐 106→153 张/秒）、webp `effort` 4→1（116→150 张/秒）。冷缓存突发的排空时间从约 2s 降到 1s 以内。
  - **C（前端别让缩略图抢带宽）**：26 处封面 `<img>` 做**取图优先级分级** —— 23 处网格 / 列表 / 队列缩略图加 `fetchpriority="low"`，把带宽让给应用自身资源；只属于"当前播放歌曲"的 3 张单图（桌面播放条 / 移动端播放条 / 全屏播放页唱片）改为 `loading="eager" fetchpriority="high"`（lazy 图上挂 high 会被浏览器直接忽略，故必须同时去掉 lazy）。骨架早已在位（`loading="lazy" decoding="async"` 全量覆盖、`useCardGrid` / `SongTable` 虚拟化、队列封面 `queueCoversReady` 延载、移动端 `coverUrl` 自动降到 150px），本次只补"谁优先"这一层。

### Internal

- `metrics.ts` 新增导出 `slowThresholdMs()` / `clientTag()` 与 `SLOW_MS_COVER` / `SLOW_MS_STREAM`，便于单测与运维核对；`.view` 与 POST 变体是同一条链路的同一入口，预算表一并登记，避免换个写法就漏告警或乱告警。
- `coverImage.ts` 渲染主体抽成 `renderAndCache()`，对外保证**永不抛异常**（失败降级为"原样回传字节"或 `null`），以免单飞 promise 把异常带给多个调用方中的一个；新增导出 `RENDER_CONCURRENCY` / `getActiveRenderCount()` / `getQueuedRenderCount()` 作为并发护栏的可观测面。
- 新增/扩充单测：分级预算表（含 `.view`/POST 别名、方法大小写敏感）、封面 1500ms 不告警与 5000ms 告警、流端点 3000/7000ms 边界、日志 `budget`/`client` 断言、`clientTag` 截断边界；单飞去重（同参数并发返回同一对象、不同 size/格式不串图）、并发护栏不变式（在途数 ≤ 上限、队列结算后归零、损坏图抛错也不泄漏槽位）。
- 新增环境变量：`HTTP_SLOW_MS` / `HTTP_SLOW_MS_COVER` / `HTTP_SLOW_MS_STREAM` / `COVER_RENDER_CACHE_MB` / `COVER_RENDER_MAX_ENTRIES` / `COVER_RENDER_CONCURRENCY`。

## [4.6.4] - 2026-10-12

### Fix

- **容器判定改为「以内容为准」（修洗版 96% 失败的真凶）**：上游聚合源会给候选虚标容器（kugou 的 `sq_hash` → 声明 `flac`），下载侧据此把临时文件命名成 `.flac`，而插件实际回的是 MP3；`music-metadata` 的 `parseFile()` 是**按扩展名挑解析器**的，于是 FLAC 解析器读 MP3 字节抛 `FourCC contains invalid characters: ff fb 90 64`，整首歌被误判成 `INTEGRITY_FAILED`（240 实测 11883 首）。现在探针先做**内容嗅探**：嗅探结果与扩展名不同族时，改用嗅探对应的 MIME 类型显式指定解析器（绕开扩展名），`container` 也以内容为准；同族或嗅探不出时走原路径（零回归），按内容解析失败再回退按扩展名解析。修好后「声明 flac、实为 mp3」会按真实档位走质量闸（`BELOW_BAR`）或直接采用，而不再是一个假的「文件损坏」。
- **失败语义归正（不再把源侧问题算成死链）**：新增 `SOURCE_INVALID`（源站返回的根本不是音频：HTML/JSON 错误页、十几字节的失败文本）与 `DURATION_UNKNOWN`（能解析出音频流但读不出时长 —— 部分 Ogg/Opus 容器不写时长）。两者都**不进** `PERMANENT_FAILURE_CODES`：此前它们一律记 `INTEGRITY_FAILED`，而后者在永久失效白名单里，连续两次就让 `deadSongPurge` 把「歌还在、还能在线播放」的条目移出曲库（用户侧表现为「歌莫名消失」）。

### Internal

- `sniffMagic` / `readHead` / `SNIFF_BYTES` 下沉到 `services/fetch/sniff.ts`：`probe.ts` 也要用它，若反向 import `integrity.ts` 会形成循环依赖；`integrity.ts` 原样再导出，对外函数面不变（取流侧 `prefetchCache.ts` 无需改动）。
- 前端 `ERROR_CODE_KEY` 与 zh-CN / en-US 文案同步新增两个错误码（列表页绝不裸显码）。
- 新增单测：探针「内容与扩展名错配」三例（`tests/fetch/probe.test.ts`）、错误码专测（`tests/fetch/integrityCodes.test.ts`）、编排层 `DURATION_UNKNOWN` / `SOURCE_INVALID` 换候选两例。

## [4.6.3] - 2026-10-12

### Fix

- **洗版「待洗版」口径修复（240 实测：全库 14107 首只洗了 3623 首、待洗版却为 0，无法再开启）**：洗版候选不再用「有效码率 < 洗版目标门槛」做二次筛选——下载目录（`/MUSIC/DOWNLOAD`）本身就是「未达到洗版目标」的落地区，且下载时把有损源转码成 flac 容器会让体积膨胀到 700~1000kbps（看起来像真无损），码率判据失效（实测 10484 首被误判「已达标」永不入选）。改为**目标目录全量入选**（仅排除冷却期内的），待洗版 0 → 10484。
- **洗版后递归清理空目录**：删原件成功后，从文件所在目录向上逐级删除空目录（止于下载根 `/MUSIC/DOWNLOAD`，根目录本身不删；非空即停）。

### Changed

- **洗版设置页精简**：摘除「原件处置」下拉（保留/移动/删除，固定为**删除原件**）、「删除原件不可逆」红色提示、以及点「开始洗版」的二次确认弹窗；后端删除 `upgradeOriginalAction` / `upgradeBackupDir` 配置项。删除前置条件不变：**新文件已落盘 + 库行迁移成功**才动手。
- **洗版目标门槛注释澄清**：`compressedMinKbps`(700) / `uncompressedMinKbps`(1400) 是**洗版目标**（取链要求达到的音质 + 下载分流基准），不是「哪些歌要洗」的筛选条件；代码与设置页 hint 均已写明白。

## [4.6.2] - 2026-10-12


### Feat


- **洗版自动续批（对齐全库下载）**：一批终态后自动开下一批，直到低于门槛的歌曲全部洗完；点名 songIds 的批次不接续。


  - 续批链改用**持久化会话标记**（settings）：容器重启 / 链让渡（有其它任务在跑）后，调度器 60s tick 内立即接上并绕过间隔闸——重启不再干等一个周期；全库下载同享该恢复。


  - 「零尝试」闸：本批一条都没跑上（启动预检失败之类）直接停链，避免系统性故障把整池歌无谓扫进冷却。


  - 取消任务、关闭自动开关即停链（清会话标记）；新增「自动续批」总闸（upgradeAutoContinue，默认开）。





### Fix

- **全库下载「待下载 N 首」卡死与无限续批（240 生产事故闭环）**：
  - 自动续批新增无进展中止：一批 `done=0` 且 `failed=0`（全部跳过/冷却秒跳）时中止续批链，交回定时调度/手动重试，杜绝同一批歌被无限重选（实测修复前每 ~6s 一批空转）。
  - 冷却门「池感知」放行孤儿 done：上次尝试 done 但歌曲行仍在下载池（path 非 `l:`/`w:`，及台账记了成功、实体却没落地）→ 不再被 15 天冷却锁死，照常重试；已真正入库的行不受影响。
  - 查重粗筛排序修复：候选超 LIMIT 时按「本地行优先 + 新行优先」截断，修复新建本地行被 200 条限额切掉导致查重 miss（实测标题「是你」271 行候选）→ 冷却秒跳 → 池子卡死。
- **sendspin 测试 flake**：`serverListenDialGaps` 改用临时端口（`listen(0)` + 回读真实端口），根治 CI `EADDRINUSE` 误红；顺带修 `listen(0)` 后 `this.port` 停留 0 的潜在 bug。

### Changed

- **CI 发版提速**：`build` 不再等待 `test`（非阻塞出镜像），test 失败时 `rollback` job 用 manifest 复制秒级回滚`:latest`/`:main`/版本 tag 并删除误发 Release；纯文档提交（`**/*.md`、`docs/**`）跳过镜像重建与守卫。
- **洗版设置页**：去掉洗版预览（清单/加载预览/勾选），改为三行统计——待洗版 N 首 / 已尝试 N 首 / 全库共 N 首（全库共取本地下载源歌曲数），开始洗版 / 清空记录 / 刷新统计随行；新增「自动续批」开关。



## [4.6.1] - 2026-10-12

### Feat

- **完整性判官（试听片段识别与跳过）**：预取登记前用「整首字节已在手里」的硬事实判定文件完整性——过小（<64KB）、非音频（HTML/JSON 错误页当 200 返回）、实际时长比曲库基准短超 15s（元数据真值）即判死；读不出时长的格式（如 ogg）按「文件大小÷码率」推算，判死线放宽到 80s 防误杀。判死不登记预取，并记「无可用源」负缓存（5 分钟，比网络型负缓存长：判据是完整字节的硬结论，又不锁死——平台版权会变），出流侧走既有跳过链。240 实测：泪海-许茹芸汽水源即 29s 完整 M4A 试听片段（基准 298s），必判死。
- **判官组内换源**：首选源判死时先试同曲多源组内其他网络源（上限 3 个，WebDAV 优先），可用即换源登记（队列行与解析行双写索引，出流无感），每个判死候选都单独标负缓存，全部判死才跳下一首；无组行为不变。
- **预取/判定参数 settings 化并暴露到前端**：新增 `GET/PUT /rest/api/v1/playback-sources/prefetch-settings`（管理员），媒体获取页新增「预取与判定参数」卡片——预取首数/并发数/预算占比/单曲超时/停摆判据/缓存有效期/换源候选数/判官开关/时长判死线/码率推算判死线/最小文件大小全部可调（不写死）；读序 settings>env>内置默认，改后下一首预取即按新值执行，无需重启。

### Test

- **回归守卫与覆盖率补测**：完整性判官/组内换源/预取判定参数新增单测并固化 240 真机场景（mp4 `ftyp` 防误杀闸、15s/80s 判死线精确边界、候选上限截断、双写同 token、settings 非有限数回落、`markUnplayable` 负缓存专项）；音乐下载链「入库即入队」(`importTrigger`) 回归重写为 17 用例纯内存隔离测试（去重/归一化/活跃间隔防抖/下载开关/重启恢复/异常兜底），模块覆盖率 96%。全量后端回归 497 文件 / 6683 用例全绿（含 1 个预期失败）。

## [4.6.0] - 2026-10-12

### Feat

- **播放预取（队列下一首整曲进内存）**：服务端权威队列在播放/切歌/置索引/改播放模式时预取下一首（lookahead=1、串行、预算为整曲缓冲一半、120s 截止）；出流命中预取直接内存回环供流，零上游取流。日志 `[PREFETCH] … 预取完成 …B/…ms → 切过去即零上游`。
- **首字节优先（整曲缓冲有界等待）**：`/rest/stream` 等整曲缓冲最多 6s（env `STREAM_BUFFER_HEAD_WAIT_MS` 可调），超时回退既有直通路径（首字节即发、边下边喂），后台缓冲循环继续，缓冲落地后下一个请求命中即零上游。冷启动 TTFB 从实测 10~26s（撞反代 10s 超时 502，Windows 端永久卡 0:00）降到约 6~9s。

### Fix

- **预取/出流 id 错位**：预取改按「播放优选」解析后的源行 id 登记与查询（此前登记队列 web 行 id、出流查解析后 id —— 组内有 local/WebDAV 兄弟行的歌预取必然 miss、白烧流量）；去重仍按队列行 id 经别名表映射，别名不悬空。
- **调用方断开不再中止共享缓冲循环**：客户端断开 `/rest/stream` 只解除自身等待，single-flight 循环继续把整曲缓冲填完，供后续请求（含客户端重试）命中。
- **lx-source 沙箱崩溃重启风暴**：QuickJS 运行时销毁前安全结算（interrupt deadline / deferred / netQueue / 周期 GC），消除 `Lifetime not alive` 与 `gc_obj_list` 断言崩溃（240 实测重启后 Aborted=0 且取链流量正常）；插件私有文件写入不再触发热重载；`markSandboxModulePoisoned` 拦截坏模块反复重启。

## [4.5.0] - 2026-10-11

### Feat

- **媒体获取·播放来源优先级**：「插件管理 → 媒体获取」新增可调顺序的取源优先级列表，控制播放平台歌曲时按顺序尝试各源插件（严格按列表顺序、本尊插件不享特权；列表为空则维持默认顺序，本尊优先）。仅插件粒度——插件内部使用哪个上游平台由其自身决定。
- **媒体获取·歌词/封面来源优先级**：「歌词获取」「封面获取」两张卡片改为可调顺序的来源列表，优先源拿不到时依次尝试下一个；抽出公共组件 SourcePriorityList 供三处复用。
- **歌曲信息·显示保存路径/来源**：歌曲信息弹窗新增一行——本地/WebDAV 歌曲显示实际保存路径（WebDAV 剥去内部源前缀），平台歌曲显示「平台名（插件名）」如「网易云（go-music-dl）」。

## [4.4.1] - 2026-10-11

### Fix

- **标签修复写盘加固**：`repairSongTags` 对 `TAG_FAILED` 做 2 秒延迟单次重试（`TIMEOUT` 不重试、其他错误原样上抛）——首轮全量扫 40 起写失败集中于同一 11 分钟窗口，实证为 NAS 存储层瞬时抖动（绿联 trimacl 短窗内 EACCES/新建条目不可见/条目闪没，事后同命令复跑全部成功），重试即可吸收；窗口外 181 首正常修复，失败文件由每周兜底扫自动重补。附回归测试 2 例（重试成功路径 2s 实跑验证 + TIMEOUT 不重试）。

## [4.4.0] - 2026-10-11

### Feat

- **MusicFetch 网络音源自动下载整套落地**：多源聚合取链(音质阶梯+直链体积预探改有界 3 路并行预探,每首关键路径 ~48s 压到 ~16s) → 下载 → 完整性校验 → 响度归一(-14LUFS 两遍 linear) → 全字段标签(封面/歌词/风格) → 转码(采样率/位深自适应跟随源) → 原子落盘 → 批量入库全流水线；批量闸四旋钮(任务并行/下载总数/单站点/单任务歌曲数 1..64) + 全库记账条目终态 + boot 僵尸任务自动续跑
- **全库下载 + 洗版**：全库平台音乐手动下载(冷却台账+定时自动+重置尝试记录+单批 500 上限)；洗版无损替换低码率(双档门槛 700/1400kbps,声明无损高于原件的抢救通道下载验证后原地替换,原件处置 keep/move/delete 不可逆二次确认,写权限统一闸自适应修复)
- **死链清理**：网络歌连续 2 轮以「资源不存在类」原因失败自动移出曲库 —— 只动 web 行、先转未匹配回填 external_* 快照再删行(顺序不可颠倒)、单轮删除量上限防源站大面积故障误清曲库
- **永久失效码不进冷却**：NO_CANDIDATE/404/410/451/INTEGRITY_FAILED 不受下载冷却限制, fail_count 可累积到清理阈值；冷却窗口内试过且最近终态非永久失效才跳过
- **入库即入队**：任何入库的网络歌曲(插件歌单/单曲/每日推荐/跨源匹配/发现页)自动过一轮下载流程(注册制钩子+启动挂载+CI 静态守卫 check-import-trigger.mjs),下载总开关关闭时不下载；导入触发 5 分钟活跃防抖 —— 先持久化记录待触发歌曲,静默满 5 分钟合并下发单个任务,大歌单连续导入不重复触发
- **flac 容器识别**：按有效码率(size*8/duration 现场换算)实测分流,flac 只作容器不算真无损；scanner 存量垃圾码率回填脚本

### Fix

- **fetch**: SSRF 守卫支持 IPv4 CIDR 网段白名单(如 192.168.10.0/24 整段内网一次性授权)+可信内网主机放行,修复自建取链源 go-music-dl 被误拦
- **fetch**: 写目录预检自愈+快速失败；桥接候选容器未知(直链无扩展名)时抢救过滤器放宽,仍值得下载验证
- **ci**: 新增死链清理静态守卫 dead-song-purge-guard(白名单纯净性/转未匹配先于删行/web 边界/快照回填/源故障保护/单轮上限/配置同步 七类钉子)；修两处存量 CI 红(scanner mock 补 scanLocalFiles 导出 + 后端 i18n 补 errors.fetch.jobNotFound)
- **fetch-ui**: 下载/洗版任务列表拆两个独立页签+冷却/定时控件,摘除伪开关与 dryRun 预览机制,暴露「单任务并发歌曲数」,i18n 补「永久失效类不受冷却限制」提示

## [4.3.2] - 2026-10-09

### Feat

- plugins: 扫码登录弹窗平台下拉(切换即取消旧会话按新平台重新出码, 选项由插件 status 下发); qrLogin status 方法直达插件配置页常驻绑定状态块
- plugins: 首页固定推荐卡多卡扩展 —— manifest.homePlaylistIds 数组声明多张卡, 每卡独立 showOnHome/homePosition, 位次冲突校验含插件自身多卡; 固定推荐歌单自愈(ensureHomePlaylist)支持多卡
- frontend: 扫码弹窗绑定状态行补平台名前缀

### Fix

- plugins: 多条 Set-Cookie 合并防 undici forEach 覆盖丢 p_skey; pluginHttp 新增 setCookieList(getSetCookie) 逐条数组; 二进制响应 base64 过桥防 NUL 截断
- frontend: 首页固定推荐卡展示门槛 >30 改 >15, 恰 30 首的历史日推卡不再被误杀
- plugins: 插件歌单缺省名中性化(遗留「ListenBrainz 推荐」会误标其它插件新建歌单)

## [4.3.1] - 2026-10-09

### Fix

- **插件系统**：修复能力白名单漏登记 `qrLogin` 的集成缺口（v4.3.0 遗漏）：`discovery.ts` 的 `VALID_CAPS` 补 `qrLogin`、`CAP_PERMISSIONS` 补 `qrLogin: ["net", "storage"]` 权限推导——此前 manifest 声明 `qrLogin` 的插件会被 `validateManifest` 以「含非法能力」拒载，扫码动作端点永远不可达；补 manifest 接受性与权限推导回归测试

## [4.3.0] - 2026-10-09

### Feat

- **沙箱插件**：新增 `host.crypto` 密码学原语共 10 个（md5 / sha1 / sha256 / randomBytes / aesEncrypt / aesDecrypt / rsaEncrypt / base64Encode / base64Decode / utf8Decode），全字符串出入参、失败返 `{error}` 绝不抛，双通道（直连宿主 / 后台 worker）行为一致
- **沙箱插件**：新增零依赖二维码编码器（byte / UTF-8、ECC L/M/Q/H、v1-10 自适应、RS+块交织、BCH 格式信息、8 掩码+惩罚评分、SVG 输出），58 用例分层对拍 segno
- **沙箱插件**：新增通用「扫码动作」能力：`configSchema` 字段 `type: "action"` + 后端 `POST /v1/plugins/:id/action` 端点（method 白名单 + capability 门禁）+ 前端扫码弹窗，url/text 自动归一化为 SVG data URL（ecc M、border 4）
- **沙箱插件**：新增能力 `qrLogin`（`startBind` / `pollBind` / `cancelBind`），经 `CAP_METHODS` 白名单登记
- 新增前端静态守卫 `check-frontend-no-qr.mjs`（禁止前端出现二维码编码逻辑，只认非注释行）

### Fix

- **沙箱插件**：修复 atob 对非 3 倍数字节长度输入末 1~2 字节恒为 0xFF 的缺陷（重写为按位累加器实现，41 例对拍 Buffer 零误差）

## [4.2.5] - 2026-10-08

### Feat

- **feat(audio): 输出位深可配(16/24,自动 = 跟随源位深);「播放器」页新增统一「音频输出」弹窗(采样率 + 位深)**
  - 背景(位深):出流链里有 `loudnorm`,它内部走浮点 ⇒ **不显式指定 `osf` 时编码器恒吃 f32、
    FLAC 恒落 24bit**(230 实测:16bit 源经线上链出参 `s32 (24 bit)`)—— 既没法按设备下调,
    也白白多吃流量。230 同链实测:挂 `osf=s16:dither_method=triangular_hp` → 出参 `s16`,
    **体积减半**。
  - 背景(入口):v4.2.4 的采样率控件只挂在「音频」页的「音色」卡片里,「播放器」页一行都没有,
    按「每台播放器 / 每个群组都该有」去找时找不到。
  - **位深档位**:手动 `16` / `24`;`自动 = 跟随源位深`(16bit 源出 16bit、24bit 源出 24bit)。
    实现 = 把目标位深换算成 `osf=s16:dither_method=triangular_hp` 或 `osf=s32`,挂到出流侧
    那条 `aresample`(与采样率的 `osr` 同一个滤镜,不引入第二次重采样)。降位深走
    **三角高频抖动**而不是直接截断(避免相关失真)。
  - **行为变化(默认档也会变)**:`自动`的兜底以前是「恒 24bit」,现在是「跟随源」——
    16bit 曲库出 16bit FLAC(体积约减半),24bit 曲库不变。想要旧的「恒 24bit」,
    把该设备手动设成 24bit 即可。位深只在无损输出(FLAC / LPCM)有意义,有损编码
    (mp3/aac/opus)无意义。
  - **源位深探测**:新增 `services/source/audioInfo.ts`,用扫描器同一套 `music-metadata`
    只读文件头(`duration:false` + `skipCovers:true`,不解析大封面),按 path + size + mtimeMs
    做进程内缓存(命中后热路径只剩一次 `statSync`)。拿不到(远端源 / 有损格式 / 文件不在 /
    解析失败)一律**不干预**、回落缺省行为;**该路径绝不抛**。
  - **群组**:位深同样取成员最低,但**跳过「自动」档**(自动本身自适应,把组钉死是过约束)。
  - **存储**:表 `player_rate_configs` → `player_output_configs`(加 `manual_bits` 列)。
    本仓没有迁移框架(全仓只有 `CREATE TABLE IF NOT EXISTS`),故在 `initDatabase()` 里做
    一次性**幂等**搬迁:老表在就搬完删掉、不在就跳过;`INSERT OR IGNORE` 保证已存在的新行
    不被覆盖。搬迁失败只告警、不拦启动(老表里最多是自动探测到的采样率,设备重连会写回)。
  - `GET/PUT /rest/api/v1/player-prefs/rate[/:peerId]`:请求体增加 `bits`,响应增加
    `bitsOptions` / `config.manualBits` / `effectiveBits`(null = 自动)。两个键**各自独立**:
    缺席 = 不动、显式 `null` = 清除 ⇒ 只改采样率不会把位深冲掉(反之亦然)。
  - flow 连续流贯通目标位深(多曲混合没有单一「源」可跟随 ⇒ 自动档落 16,与改动前一致;
    显式设 24 才升)。
  - 新增 `tests/services/playerOutputBits.test.ts`(14 例:归一化 / 键独立 / 群组取最低跳过自动 /
    源位深探测现造 16bit+24bit WAV 真读文件头 / `osf` 真的落到链上)+ `ratePerm.test.ts`
    追加 4 例 HTTP 层读写闭环与非法值拦截。

### Fix

- **fix(web): 「播放器」页(DLNA 行 / Sendspin 行 / 群组卡片)新增「音频输出」入口 —— 采样率与位深同一个弹窗**
  - 群组走**整组一键设置**(用户拍板):保存时把这一组值写给组内**每一台**设备,组内必然
    同格式,不会出现「组设置看着改了、实际被成员的低档压住」的心智错位。
  - 只有 `dlna:` / `sendspin:` 给入口 —— AirPlay 锁 44100/16bit、本机客户端不参与裁决,
    给了也是误导。
  - 弹窗内的「当前生效」同时回显采样率与位深(位深为自动时显示「跟随源位深」)。
## [4.2.4] - 2026-10-08

### Feat

- **feat(audio): 目标采样率按设备能力裁决(每设备配置 + Sendspin 自动探测 + 群组取最低),不再写死 48k**
  - 背景:v4.2.3 在 HTTP/DLNA 转码链补的降采样回落把目标率**写死 48k** —— 治好了「loudnorm
    滤波器内部恒上采样 192kHz → 高采样率流直喂设备 → 变速变调」,代价却是把**真支持
    96K/192K 的设备**一并降级(用户花的高解析能力被一刀切砍掉)。
  - 新增 `player_rate_configs`(按 peerId)+ `services/playerRate.ts`:每台播放器一个目标
    采样率,三来源优先级 **手动设置 > 设备 hello 自动宣告 > 缺省 48000**,手动档位白名单
    48000 / 88200 / 96000 / 176400 / 192000。
  - **Sendspin 自动探测**(零障碍):解析 `client/hello` 的
    `player@v1_support.supported_formats` —— 设备**按「编码 × 声道」逐条**上报
    `sample_rate`/`bit_depth`(真机 ESPHome 2026.9.1 报文实录),取最大值落库;设置面板回显
    「设备自动上报」。**DLNA 探测无解**(协议层就没有):`GetProtocolInfo` 只报 mime +
    `DLNA.ORG_PN` 编码档位,不编码采样率(240 真机 H5MKII 实测 20 条 audio 项无一携带 rate)
    ⇒ DLNA 走「手动 + 缺省」。
  - **群组取成员最低值**(木桶原理):组内必须同率,否则同步/连续流会中途变速(设备重新锁相 =
    曲间爆音/顿挫)。
  - 落地:HTTP/DLNA 转码链的 `aresample=osr=`、flow 会话采样率、per-player DSP 锚定率
    (biquad 系数随最终采样率重算)统一改读该配置;缺省值仍 48000 ⇒ **存量设备行为逐字节不变**。
  - 新增 `GET/PUT /rest/api/v1/player-prefs/rate[/:peerId]`:设备级 `canControlPeer` 授权
    (与 per-player 音色同一口径),非法档位 400(不静默当成"清除",免得把"传错了"伪装成
    "设置成功");清手动值**保留**设备自动宣告值。前端「音频」页每设备新增「输出采样率」下拉
    + 「设备自动上报 / 当前生效」回显(中英双语)。
  - 测试:`playerRate` 存取与裁决优先级、群组取最低(成员/组外/多组/裸 id)、hello 格式解析
    (真机报文 fixture + 96K 变体 + 脏数据)、目标率契约(配置真的落到 ffmpeg 命令、成组取最低
    真的落到链上、DSP 锚定率同源)、端点授权与归一化 —— 共 38 例。

## [4.2.3] - 2026-10-08

### Fix

- **fix(pipeline): HTTP/DLNA 转码链 loudnorm 缺降采样回落,高采样率流直喂设备**
  - 根因:loudnorm 滤波器内部恒上采样到 192kHz;本通道无 `-ar` 输出选项,flac/mp3/aac 编码器
    又接受 192k → 图协商不降采样 → 未测量歌曲首播(实时 loudnorm)输出 192kHz 流,部分
    renderer(gmediarender 实锤)变速变调播放、媒体钟错乱(240 GGMM MUSIC 案:位置 0.5x 前进、
    overrun advance、声音异常;重播命中测量走静态 volume 即恢复正常)。
  - 修复:`resolveRequestAf` 链含 loudnorm 时紧随其后插入 `aresample=resampler=swr:osr=48000`
    (锚定 48k 与 DSP_FILTER_RATE 同源;swr 显式声明对齐 ffmpeg ticket 11323 与 ⑥ 段口径),
    限制器保持在链尾浮点域。有 DSP 配置的链路本就自带 aresample=48000 不受影响。
  - 覆盖 /rest/stream、/stream-remote、/rest/dlna/stream/:token 全部管道出口(同一 af 入口)。
  - 实证:复刻事故命令输出 flac 192000Hz → 修复后 48000Hz;airplay/sendspin/flow 三链原本
    就有各自回落,不受影响。

## [4.2.2] - 2026-10-08

### Added

- **sendspin 解码链路调试日志**(插件页「解码调试日志」,默认关):记录 ffmpeg 非正常退出(退出码+stderr 错误尾巴+已解码时长+存活时长)、启动失败/进程错误、一次性解码失败、推帧中断、滑动窗口背压暂停/恢复、开始淘汰、seek 重建、自然 EOF 及起播/结束全生命周期事件,每条含精确时间、原因、**歌曲 ID 与当时的播放位置**(复现定位:哪首歌播到第几秒、怎么挂的)。
- 调试日志**保留 1 天**:文件 `DATA_DIR/logs/sendspin-debug.log`(JSONL,单文件超 16MB 轮转、超 24h 自动清理)+ 内存环形最近 2000 条;新增管理端接口 `GET /rest/sendspin-debug-log` 读取。
- 调试日志开关随插件配置 ≤5 秒生效,无需重启、不中断当前播放;关闭时零开销。
## [4.2.1] - 2026-10-08

### Sendspin 解码窗口上限可配 + 清理整曲解码旧路径

- **解码窗口上限可配**:Sendspin 插件新增「解码窗口上限」配置项(30 秒 ~ 10 分钟共 11 档,缺省 30 秒=最省内存档)。控制服务端每个正在播放的组为每首曲保留多少未消费 PCM(约 0.375MB/秒/组)——30 秒 ≈ 11MB,5 分钟 ≈ 115MB,10 分钟 ≈ 230MB。下一首生效。
- **整曲保留**:歌长 ≤ 窗口上限的曲目自动进入**整曲保留**——不淘汰、不背压,前后拖动 seek 全程命中窗口(零成本、不重起 ffmpeg);歌长 > 上限的曲目走滑动窗口,**照样正常播完**,仅回退/前跳超窗时重建解码(约 1 秒空窗)。
- **退役「流式解码开关」**:旧配置项 `stream_source`(及其 `SENDSPIN_STREAM_SOURCE` 环境变量)连同死代码与全部分支一并删除——流式解码现为**恒开**,与「解码窗口上限」方案重叠,旧开关的「关闭即整曲解码进内存」语义已无必要。
- **清理整曲解码旧路径**:删除 `streamEngine` 的整包解码分支与 `decodeToF32` 引用;整包 `GroupAudio.pcm` 仅保留给 announce(TTS 播报)与测试注入源(`GroupPump` 整包 `pushLoop` 机制不变)。
- **可观测**:起播时新增 `[window] 上限=Xs 整曲保留=bool 歌长=Xs` 日志,便于确认配置已生效。
- **文档/注释订正**:清除 `docs/sendspin-权威方案文档.md` §5.1、`docs/DEVELOPER.md`、插件配置项 help 文案中残留的「`SENDSPIN_STREAM_SOURCE` / 流式解码开关」过期表述。
- **测试**:新增 `tests/sendspin/streamWindow.test.ts`(5 例:整曲保留不淘汰、超窗滑动与背压、超窗 seek 重定位等);`pumpFallback.test.ts` 改为起真 HTTP 源(不再依赖 `SENDSPIN_STREAM_SOURCE=0`);sendspin 全量 100 文件 / 1013 例全绿,`tsc --noEmit` 0。
- **缺省值与文案**:解码窗口上限缺省 **30 秒**(最省内存档,≈11MB/组);「解码窗口上限/设备缓冲深度/默认音频编码」下拉文案去掉「推荐/最抗卡顿」类修饰,统一以「默认」标注缺省档。

## [4.2.0] - 2026-10-08

### 播放抗网络波动 + 群组卡死根治

- **整曲内存缓冲**:网络源(WEBDAV + 插件源)起播即整曲取进内存(瞬时错误 2 次退避 / 10s 停摆硬顶 / 18s 单次硬顶 / 100MB 单曲 / 300MB 全局预算),经 `/rest/membuf` 回环供流——起播后上游断网不影响本首播放,240 真机断网实测通过。
- **取流失败自动重试窗**:新流取流失败不再快速失败,挂起请求自动重试(前 1 分钟每 10 秒 → 之后每 60 秒,总窗口 30 分钟);窗口内源恢复即自动出流,期间不发僵尸响应。
- **僵尸流根治**:出流管道启动裁决(首字节 / 带错退出 / 15s 超时,不再发 0 字节假 200)+ 按退出码收口(中途夭折对客户端显式断开,不再被误读为整曲播完);DLNA 直通链路加 10s 停摆守卫与 15s 建连超时。
- **失败语义分层**:已缓冲整曲与上游死活无关;瞬时失败挂起重试;停摆 / 死链(404 等)立即显式失败,队列自动跳下一首;过大 / 超预算回退直通。
- **群组假在播根源修复**:推流中途死亡(源断 / 编码器死亡)后组状态不再残留——轮询恢复真实 IDLE,队列自动推进,不再出现「进度不动也永不切歌」的永久卡死。
- **整曲内存缓冲主动回收**:整曲缓存新增消费后空闲 120 秒即回收 + 每 60 秒周期清扫(旧机制仅有 10 分钟 TTL 与容量上限的惰性驱逐),连续读取自动续期不误删,播放结束后内存及时归还。
- **测试契约对齐**:同步修正 3 个受根源修复影响的旧契约用例(异常终止状态口径、假在播签名判定),新增「假在播 → 重投自愈」集成守卫(场景3e)。

## [4.1.0] - 2026-10-07

### 性能优化:发现页与库页查询提速 + 推荐缓存永热

- **数据库索引 + 查询下推(rest/index.ts + db/index.ts)**:新增 4 个幂等索引(albums.year / albums.genre / albums.play_count / album_artists.artist);getAlbumList2 全类型排序/过滤/分页下推 SQL——random 改「id 列取样回表」(整行大列不再进排序堆),newest/recent/frequent/highest/byGenre/byYear/starred 逐项语义核对后下推,alphabeticalByName/ByArtist 保留 JS 路径(localeCompare 区域序不可下推);getRandomSongs 同步改 id 取样且无过滤时免 join;getArtists/getIndexes 投影瘦身(bio 等大文本列不再捞回)。合成库(6 万专辑/13 万歌)实测:random 232ms→10.8ms、newest 288ms→3.3ms、byYear/frequent/byGenre/starred 208-221ms→3.0-3.6ms、getRandomSongs 64ms→16.4ms、getArtists 113ms→72ms、getIndexes 101ms→58ms,EXPLAIN QUERY PLAN 全部命中索引。

- **推荐缓存 stale-while-revalidate(api/recommend.ts)**:/v1/recommend 与可缓存 provider 的 /v1/local-recommend 改为「有缓存立即返回(不论新旧),过期触发后台刷新(single-flight 去重),插件聚合失败保留 last-good 不覆盖旧缓存,无缓存才阻塞拉取」;新增周期预热(递归 setTimeout,TTL/2,unref,冷启动不外呼)。用户侧效果:首页插件推荐从「5 分钟过期后下一次 900ms+ 阻塞」变为永远秒回。

- **回归守卫**:新增 recommendSwr(4 例)/ddlIdempotent(2 例)/restPagingRegression(7 例);recommendRoutesContract 1 例按 SWR 新契约订正。全量 432 文件 / 5685 例全绿,tsc --noEmit 干净。
## [4.0.88] - 2026-10-07

### Sendspin 修复:FLAC 编码器死亡自愈,杜绝「中途无声、进度照走、切歌恢复」

- **根因(240 生产实证,2026-10-07)**:群组播放的 FLAC 编码器(libflacjs asm.js)在曲中 `process_interleaved` 返回 false 后,旧实现只 warn 一条「编码器疑似失效」然后**静默放空**;`pushLoop` 的时间线降级推进照常推游标 ⇒ 设备收到合法长度但全零的静音帧 —— **进度条照走、没有声音、切歌(新建编码器)才恢复**。24h 内 3 个爆发窗口共 3.2 万行日志(`@frame=0` 连新编码器首帧都失败=asm 堆楔死 14447 次 / `@frame=638`≈54.5s 处崩 15332 次 / `@frame=2565` 2999 次),与用户听到的无声时段逐帧吻合。孤立复现(12 首×300s 连续编码)跑不挂,触发需生产长寿命进程,故修复设计为**不依赖触发原因的分层自愈**。

- **分层自愈(encoding.ts)**:`process_interleaved` 失败 → ①**原地重建**(删旧实例+重置元数据+重开流)→ **重编同一批**,成功则调用方无感、无缝续流;②重建失败(堆楔死形态)→ **bust require 缓存重载 libflacjs**(全新 asm 堆)再试;③仍失败 → 置 `unhealthy` + 5s 退避放空,不再每帧无谓重建。曲末 `flush()` 的重建统一走同一自愈路径。

- **降级上限兜底(streamEngine.ts)**:`pushLoop` 持续零产出的降级推进加 `MAX_SILENT_DEGRADE` 上限(默认 5s,env `SENDSPIN_MAX_SILENT_DEGRADE_MS` 可覆盖)——超限即**提前按自然播完收场、自动切下一首**。最坏情况从「整首默剧」收敛为「最多约 5 秒无声后自动恢复」,任何编码器死亡都不再可能把整首歌唱成默剧。

- **回归守卫**:新增 `encodingHeal.test.ts`(自愈契约 3 例:重建成功无缝续流 / 模块级重载后恢复 / 持续失败退避)与 `pumpEncoderDeath.test.ts`(降级超限提前收场 1 例);tsc 0 错误,sendspin 子集 50 文件 / 300 用例全绿。
## [4.0.87] - 2026-10-05

### Sendspin sink 自愈:远程重启默认开 + 两道防叠加闸

- **L2 远程重启默认开启(`sinkAutoRestart` 缺省即 true)**:设备侧(`sendspin-cpp`) 2026-10-05 起自带自愈 —— `sendspin.player: Failed to send audio chunk` 1 分钟内 累计到阈值就本地 `App.restart()`(esp32-player2 已实装并实测生效)。本地重启是**唯一能清 `pending_start_` 一锤子锁**的手段,设备自己已经会按 ⇒ 服务端再按一次就是**叠加重启**(刚起回来又被按死)。故本版把默认从「保守关」翻成「默认开」,同时在下发前挂两道前置闸。想退回保守模式:把 `sendspin-renderer` 的`sink_auto_restart` 显式设 false。

- **L2 闸1:本 conn 已断 ⇒ 绝不重复按**:`ws close` → 心跳约 20s 摘牌,此时设备多半已经自己重启过了;对着已断的旧连接再发一次重启就是叠加(刚起回来又被按死)。命中则把 `sinkRecoveryLevel` 钉到 3(不再每 60s 刷同一条告警),等重连后重新评估。判定用 `c.ready === false`:握手前 / 无定义的替身按「还活着」放行,不影响正常路径(真断链时 `readyState` 必为 CLOSED)。

- **L2 闸2:同 host 在 10min 冷却窗内已下发过 ⇒ 换新 conn 也不再按**:设备重连产生的是**新 conn**(`sinkRecoveryLevel` / `sinkLastRecoveryAt` 全是初值),冷却若只记在conn 上会丢 ⇒ 新增 server 层 `lastRestartSentAt: Map<host, ts>` 按 host 记,跨 conn生效。命中时日志会打出剩余冷却秒数。

- **远程重启是「通用」的,不依赖具体按钮名**(承接 4.0.86 的 `esphomeBridge.restartButtonId` 两级匹配):① `object_id` 以 `restart` 结尾且非 safe-mode 变体 → 规范命中,**必须排在兜底之前**(safe-mode 按钮在实体表里常排在真重启前面);② 兜底:`name`/`object_id` 含 `restart` 就按下,并显式 warn「实体命名不规范,按下的是猜测结果」;③ 都没有 → 返回 `{ ok:false, code:"no-entity" }`,只记 warn**不抛**。**换设备不会因命名不一致而失效**,只要设备暴露了 `button: - platform: restart` 且 6053 已连上。

- **回归守卫**:`sinkHealth.test.ts` ④ 段 1 例 → 5 例(显式关 / 默认开真按 / 闸1 断链不按 / 闸2 冷却窗内不按 / 冷却窗过完允许再按)共 26 passed,并钉住 `lastRestartSentAt`常量。`tsc --noEmit` 0 错误,sendspin 子集 97 文件 1061 passed + 1 expected fail。

### Sendspin 音量:统一「直控设备音量」,组音量缺省收到 20

- **事故修复 —— 设备重连后音量突然非常大(2026-10-05 实测复现)**:根因是**两套互不相干的组对象 + 组音量缺省 100**。用户在滑块里写的是按 host 取到的组(`group("C4:9E:…")`,落到 `sendspin_device_state`),而设备上线自动回组的是按 `ug:` 前缀建的**另一个**内存组;新组 `volume` 缺省 100,重连 `add()` 时 `syncVolumeTo` 把满音量刷进**设备输出级**,再叠上设备自身的硬件音量 ⇒ 听感暴涨数倍。(240 取证:`sendspin_device_state` 里 `C4:9E:7E:08:75:64` volume 38 / `3C:0F:02:F9:69:E4` volume 100。)

- **组音量出厂缺省 100 → `DEFAULT_SENDSPIN_VOLUME = 20`**(新增常量,位于 `deviceState.ts`):缺省值本身就是「刚起回来的设备被灌满」的元凶,直接压到安全侧;用户真正设过的值由下面第 4 条从持久库播种回真值。回归守卫:`peerVolume.test.ts` 钉住 `DEFAULT_SENDSPIN_VOLUME < 50`。

- **统一直控设备输出级,服务端不再持有独立音量(不乘算)**:`offloadsVolume()` 恒 `true`、`appliedGain()` 恒 100(unity) —— **不管什么设备(宣告音量与否)、不管是群组还是独立播放器,一律把音量以 `server/command` 直接作用到设备输出级**,采样恒满幅、不烘任何服务端音量。不再保留「按设备能力回退烘 PCM」的分支:两个音量(服务端 × 设备)相乘以及两者各自生效,都是同一个物理旋钮的两次表达,相乘只会互相打架。代价(用户已确认接受):极老固件若完全不吃 `server/command`,其音量将失去作用面 —— 这是「一律直控」的必要代价,不是遗漏。

- **`deviceVolume()` 原样直通、零乘算**(去掉 `× c.volume` 的乘法):组音量多少就下发给设备多少。**群组和独立播放器同口径** —— 都是直接控制设备音量,不再存在「服务端音量 × 设备音量」或「播放器音量 × 设备音量」这类相乘。

- **`seedVolumeFromDevice()`:组对象 `add()` 时按设备持久音量(`sendspin_device_state`)播种一次(`volumeSeeded` 标记)**:修掉上面那两套组对象的歧义 —— 用户滑块设过的值在设备重连后会被播种回来,而不是每次掉回缺省值 20。

- **同一常量收口所有缺省出口**:`sendspin/playerCore.ts` 服务未跑时的内存假组、`sendspin/proxy.ts` 组缺席时的占位视图、`sendspin/peerVolume.ts` 离线回退(顺手清掉残留的 `?? 100` 字面量) 全部换用 `DEFAULT_SENDSPIN_VOLUME`。
- **「缺省」出口全量收口,不留后门**:除上面几处,还清掉了 `deviceState.ts` 里 4 处 upsert 缺省 (`cur?.volume ?? 100` —— 设备从没存过音量时会被写成 100)、以及 `group.ts` 的 `SendspinGroup.volume = 100`。**凡是「不知道就先给」的出口一律 20,不允许再出现满音量缺省**,否则从另一扇门又会回到本次事故。同步更新 `deviceState.test.ts` / `group.test.ts` 的缺省断言与 import。


- **回归守卫**:`serverCore.test.ts` 该用例改为「组音量 42 原样直通(不乘算、不烘 PCM)」;`proxyFront.test.ts` 拆成两条 —— 镜像里**已存在**的组原样透传、`ghost` 缺席时才返回缺省常量;`peerVolume.test.ts` / `playerCoreUnits.test.ts` 的缺省断言全部改常量(后者补上 import)。`tsc --noEmit` 0 错误。

## [4.0.86] - 2026-10-05

### Sendspin 群组「播放中途突然无声」整改(设备侧固件不可改,服务端开环兜底)

- **根因(240 取证坐实)**:sendspin-cpp `pending_start_` 一锤子锁 —— 只在 `sendspin_media_source.cpp:77`(紧邻 `:78 set_state_(PLAYING)`)清零,`:87` / `:175-180` / `:184-187` 都不复位。锁上之后重发 `stream/start` 会被 `if(!pending_start_)` 去重吞掉,设备再也回不到 IDLE;协议内软手段(重发 start / clear / server+activate / 切歌)全部无效,只剩掉电。判活只看 `State changed to PLAYING` —— `Stream Started` 出自网络线程,健康与故障都打,无判别力。
- **新增 sink 开环检测**:唯一可观测信号是 `ws.bufferedAmount`(健康 0~13KB 突发,故障稳定 58585B 平台)。连续 3 窗(≈30s)峰值 > 32KB 判 `stalled`;回落到 < 16KB 清窗重计;建连 10s 宽限、起播预填充窗口豁免、60s 硬回退(设备不取数时 pump 恒停在 fill,不设硬回退就永远 arm 不上检测)。
- **分级自愈(全程不改播放状态:不 pause / 不报 stopped / 不踢出群组)**:判出来 → L0 仅 WARN;满 60s → L1 发 `stream/end` 探针(协议里唯一能让设备回 IDLE 的消息,且不发 `group/update(stopped)`,免得把「无声」伪造成「正常停止」);再满 5min → L2 远程重启。
- **L2 自动重启默认关**:`bufferedAmount` 只是推断,服务端尚订阅不到设备日志流,拿不到设备侧事实;假阳(把正在正常播放的机器按重启)与漏判(继续无声)代价不对称。开关位 `sendspin-renderer.sink_auto_restart`(缺省 false,改插件配置后重启服务生效),关着时降级为 WARN + 设备列表暴露 `streamHealth`,手动路由 `POST /v1/sendspin/devices/:clientId/esphome/restart` 仍可真实按下。
- **修掉自愈阶梯的死代码**:`sampleSinkHealth` 原先在「已 stalled」时直接 return,导致 `escalateSinkRecovery` 全程只被调过一次,L1 / L2 永远发不出去。改为按「已 stall 多久」驱动(按当前所处级别取等待量),设备排空恢复时阶梯归零、下次故障从 L0 重新走;L2 下发后阶梯归零并前推 10min 冷却,设备回来前绝不再按第二遍。
- **设备列表暴露健康态**:`GET /v1/sendspin/clients` 在线行新增 `streamHealth`(`ok` / `degraded` / `stalled`)。
- **esphomeBridge 重启实体挑选**:只认 `object_id` 以 `restart` 结尾且排除 safe-mode 变体,命名不规范时按名字兜底并记 warn;拿不到实体 / 桥未连 / 发送失败一律返回 `ok:false` 不抛。
- **切歌收尾不再误报停止**:`finishPlayback` 增加 `silentState` 选项,置位时只做流级收尾、不广播 `group/update(stopped)`(自愈探针专用)。
- **回归守卫**:`sinkHealth.test.ts` 22 例(三窗计数 / 清窗 / 三档豁免 / 反例:阶梯靠时间推进 / L2 默认关与开启两条路径 / 闸门 / 实体挑选 / 健康聚合 / 阈值常量守卫 / 重启真实成功路径);阈值与节奏常量改为从实现 import,改坏即对应用例转红。

## [4.0.85] - 2026-10-04

### 性能（Web 首页打开慢：240 真机冷态 14.3s → 1.0s、热态 2.0s → 0.47s）

- **根因定位（240 容器内耗时分解实测）**：`/v1/local-recommend` 是首页 5 个数据源里唯一
  「零缓存」且逐歌单做封面 N+1 查询的链路。真瓶颈不是日志里那 5 个榜单外置插件（合计仅
  60~200ms），而是**内置 `local-random-recommend`**（695/857/190ms，占 62~77%）；且封面解析
  对 240 个歌单额外发起 240 次 drizzle 全行查询（主 SQL 已 `SELECT cover_art`，却又逐条调
  `getPlaylistCover()`）。
- **P0-1 provider 遍历并发化**：`backend/src/routes/api/recommend.ts` 的 `local-recommend`
  由串行 `for` 改 `Promise.all`，每个 provider 独立 try/catch，单个失败不影响其余。
- **P0-2 封面解析去 N+1**：`backend/src/services/plugin/localPlatformRecommend.ts` 直接用主
  SQL 已取回的 `r.cover_art` 做「扩展名合法 + `resolveCoverFile` 存在」判定，与
  `getPlaylistCover()` 的判定逐字等价，省掉 240 次多余查询。
- **P0-3 候选池缓存（保留随机语义）**：新增 `platformPoolCache` + `PLATFORM_POOL_TTL_MS=120s`
  + `invalidatePlatformPool()`。TTL 内只固定候选集合与封面解析结果，**每次请求仍然 shuffle**，
  「每次刷新都不一样」的体验不变。
- **P1-1 provider 结果缓存（插件自治，核心不写死插件名）**：核心读插件 manifest 的
  `recommendCacheTtlSeconds`（>0 才缓存，key=pluginId）；`backend/src/plugins/types.ts` 新增
  该可选字段。5 个榜单插件声明 120s（配套插件同步发版，见下）。
- **P1-2 新增轻量宿主 API `host.playlists.getMeta(id)`**：只返回 `playlists` 行，不再跨
  QuickJS/WASM VM 编组整张歌单 entries；权限沿用 `playlists:write`。同步注册 `sandbox.ts`
  进程内表面与 `sandboxWorker.ts` worker 桥。
- **P1-3 前端首页请求解耦**：`frontend/src/views/Home/index.vue` 的 `onMounted` 拆成
  「快路径先就绪、慢路径后到」。注：`loading` ref 当前未被模板消费，故此项为纯结构性解耦，
  视觉收益为 0（如实记录）。

### 修复（沙箱宿主句柄泄漏 + ffmpeg 出流永不回收，均 240 定量证实）

- **沙箱宿主异步句柄泄漏**：`backend/src/plugins/sandbox.ts` 的
  `deferred.resolve(jsToHandle(value))` 中 **`resolve` 不消费传入 handle**，调用方必须自行
  dispose；旧代码三处（并发拒绝分支 / 成功分支 / 错误路径）均未 dispose → QuickJS 引用计数
  不归零 → 堆单调增长（+1454 B/call），teardown 命中
  `Assertion failed: list_empty(&rt->gc_obj_list), at quickjs.c:2036, JS_FreeRuntime`。
  修法：先取句柄 → `resolve` → 在 `!skipHostResultDispose()` 时 `safeDispose`。
  240 实测：60 轮真实 provider 调用后 `external` 21.5→21.5MB（+0）、QuickJS `obj_count`
  4282→4282（+0），两条曲线完全拉平。新增**仅测试用**只读开关
  `SANDBOX_LEAK_HOST_RESULT=1`（默认关，生产恒释放），供回归用例复现泄漏面。
- **ffmpeg DLNA 出流看门狗**：`backend/src/routes/rest/index.ts` 的 `serveFfmpegPipe` 原回收
  仅依赖 `c.req.raw.signal` abort / child exit+error / `stdout.on("close")`；渲染端 socket
  半开时三者都不触发 → 转码进程永久驻留（240 实测 7 个进程存活 3.5–15.2h，回环 TCP 仍
  ESTABLISHED、服务端 tx_queue 堆到 2.5–4MB 而 rx_queue=0）。修法：① `registerFfmpegPipe`
  登记 / exit+error 注销；② `stdout.on("data")` 刷新 `lastDataAt`；③ 周期对账器（`setInterval`
  30s、`.unref()`、幂等）：连续 **90s** 无 stdout 字节 或 存活超硬性 **6h** → SIGKILL + 注销；
  ④ `killOnCancel()` 包响应流，cancel 时立即 `child.kill()`。`backend/src/index.ts` 在
  `startOrphanPruner()` 后启动对账器（不做启动期对账，避免重启瞬间误杀）。
- **显式失效点补齐**：`services/plugin/playlistSync.ts` 与
  `services/source/online/recommendImport.ts` 在 `clearPlaylistCoverCache` 后补调
  `invalidatePlatformPool()`；其余写点靠 120s TTL 自然收敛。注册点放在
  `routes/api/shared.ts`（在模块顶层自注册会触发模块环 TDZ：
  `Cannot access 'cleaners' before initialization`）。

### 测试

- 新增 `backend/tests/plugins/sandboxHostDispose.test.ts`(139)、
  `backend/tests/rest/ffmpegWatchdog.test.ts`(84)、
  `backend/tests/services/localPlatformRecommend.test.ts`(70)，并扩充
  `backend/tests/routes/recommendRoutesContract.test.ts`。
- QA 独立回归守卫 `backend/tests/qa_perf/`（4 文件 580 行）：封面等价性（逐字比对新判定 vs 旧
  `getPlaylistCover`）、随机性守卫（TTL 内仍重洗）、provider 缓存语义、ffmpeg 看门狗边界。
  3 处变异均让守卫变红（有判别力）。
- 240 真机实测（热替换 dist）：串行冷态 **14297.7 → 1044.7ms（−93%）**、
  串行热态 1996.9 → 471.4ms（−76%）、并行热态 797.2 → 250.4ms（−69%）；
  真实 HTTP 热态下限约 133ms。

### 配套插件（MusicFlow-plugins 同步发版）

- 5 个榜单插件（apple-music / huawei-chart / kugou-chart / netease-chart / qq-chart）声明
  `recommendCacheTtlSeconds: 120`。
- 6 处 `host.playlists.get(` 改 `host.playlists.getMeta(`，并做**兼容降级**
  （`host.playlists.getMeta || host.playlists.get`）——不抬高 `minAppVersion`，
  保证旧核心上不因 `getMeta` 缺失而静默丢失该平台榜单分区。
- 版本：apple-music 1.0.4→**1.0.5**、huawei-chart 1.2.0→**1.2.1**、
  kugou-chart 1.7.0→**1.7.1**、netease-chart 1.7.0→**1.7.1**、qq-chart 1.7.0→**1.7.1**
  （由插件仓 CI push master 自动打 tag + Release）。

## [4.0.84] - 2026-10-04

### 修复

- **纯 stream 插件跨插件兜底在架构上不可用(240 生产容器真机实锤)**:宿主沙箱
  `backend/src/plugins/sandbox.ts` 的 `CAP_METHODS` 把 `stream` 能力只映射到
  `["streamUrl"]`,于是插件即便实现了 `resolveStream`,核心拿到的 impl 门面里也永远
  没有它 —— `streamFallback.ts` 的 `typeof provider.resolveStream !== "function"`
  恒真,「本尊重搜+全平台全败后,逐个问纯 stream 插件按平台原生 ID 要直链」这条链**从来
  没有真正跑起来过**(4.0.82 引入、4.0.83 修掉前半段的提前 return,但都被这一层挡住)。
  240 实测证据:停掉 `music-dl` 容器后本尊(gmd)搜索全败、`lx-source` v1.1.1 已加载且
  `enabled=1`、容器内 dist 已含 `searchFailed` 补丁,`findFallbackStream` 仍返回 `null`
  且 playability 落 `unplayable`;容器内直查插件实现确认 `impl` 只有
  `streamUrl/test/health`,`resolveStream` 被白名单挡在门面之外。
- 修法:`stream: ["streamUrl", "resolveStream"]`。`makeImpl` 只在插件**实际实现**该方法
  时才暴露,故未实现 `resolveStream` 的 stream 插件行为完全不变(不误加门面)。

### 测试

- `backend/tests/plugins/discoveryHost.test.ts` 新增 K 段 2 例:① 声明 `stream` 且实现了
  `resolveStream` 的插件,`impl` 必须暴露该方法且能返回直链;② 未实现的插件,`impl` 不得
  凭空多出该方法(反向守卫)。
- 双向变异已验证:把白名单改回 `["streamUrl"]` → ① 立刻变红(`1 failed | 103 passed`),
  还原 → `104 passed` 全绿。

## [4.0.83] - 2026-10-04

### 修复
- **本尊「搜索请求抛错」时提前 return,纯 stream 插件兜底被整段跳过(gmd 一挂就彻底没链)**
  - 现象:240 生产容器真机复验(`docker stop music-dl` 逼本尊全平台失败)——库里的 gmd 歌曲一首都换不出链,洛雪(lx-source v1.1.1)压根没被调用到。
  - 根因:`findFallbackStream` 里本尊重搜的 `provider.search()` 抛异常(上游 down / 网络异常)时,catch 分支按「网络异常不判死,只短期退避」的语义直接 `setFallback(..., {transient:true}); return null` —— 这条 return 排在**纯 stream 插件轮询之前**,于是本尊一崩,洛雪按歌曲 `sourceData` 里的平台原生 ID 直查直链的机会就没了。
  - 为何单测没抓到:既有用例构造的是「搜索成功但空结果 / 候选被导入门禁过滤」,从不构造「本尊 search 本身抛错」;而真机 gmd 停服走的恰恰是抛错分支。
  - 修法:catch 改为只置 `searchFailed` 标记并走 `results = []`,继续走原有候选循环与纯 stream 插件轮询;全无果时末尾统一 `setFallback(songId, null, { transient: sawTransient || searchFailed })`,与原「短期退避不判死」语义完全一致。
  - 真机复核:240 v4.0.83 + lx-source v1.1.1,停掉 gmd 后按库内网易云 ID 直查,直链 host 由 `192.168.10.240:18180` 切到 `m701.music.126.net`,`HTTP 206 audio/mpeg` 可播。

### 测试
- 新增 `tests/services/streamFallbackSearchThrow.test.ts` 2 例:①本尊 search 抛错 → 纯 stream 插件仍按 sourceData 直查并换链成功;②无链时返回 null 但按 transient 退避(不判死)。双向变异(还原旧 `return`)→ 1 failed,还原 → 2 passed。

## [4.0.82] - 2026-10-04

### 新增

- **取链兜底新增「纯 stream 插件跨插件轮询」**:核心换源兜底(`findFallbackStream`)在本尊重搜 + 平台轮换全部失败后,逐个尝试只声明 `stream`、不含 `search` 能力的启用源插件 —— 调其新契约 `resolveStream(config, song)`(按歌曲 `sourceData` 里的平台原生 ID 直查直链,如 lx-source 走洛雪源脚本 musicUrl 多源轮切),探活(206/200 且音频)才换链。kuwo / netease 平台实测真可播;qq / kugou / migu 上游失效时按既有失败语义退避,行为不变。
- **配套**:lx-source 插件收窄为纯取链插件(v1.1.1,capabilities 只留 `stream`),`musicInfo` 按洛雪规范携带 `source` 平台键;搜索/歌单/推荐/歌词/封面等洛雪协议不支持或实测恒空的能力全部移除,搜索兜底候选链不再因洛雪空结果白等。

### 不变量

- 本尊(gmd 等)重搜 + 平台轮换逻辑零改动;纯 stream 轮询只在其全部失败后追加,无纯 stream 插件或全部失败时负缓存/退避语义与原版完全一致。

## [4.0.79] - 2026-10-03

### 功能
- **自动匹配链路接入跨插件兜底（歌单导入 / 播放补齐）**
  - 现象:上次 [4.0.78] 只把兜底做在了 `/api` 搜索路由上,歌单导入与补齐播放这类「自动匹配」链路还是「一个 matcher 一把梭」——`shared.ts` 只用 `firstEnabledByCapability("search")` 取第一个启用的搜索插件,首选空结果或抛错时其它插件不再补位,所以实际观感是「还是只有 go-music-dl 在匹配」。
  - 根因:导入链路上没有候选概念,`matchUnmatchedPlaylistEntries()` 是单 provider 搜索+打分,内部不存在换源;加上插件侧没人声明 `autoMatch` 能力,能力驱动的挑选永远落到 search 分支,只能选出一个。
  - 修法:`services/plugin/shared.ts` 新增 `buildMatchCandidates()`,按 `core-search-fallback` 的配置把首选插件之外其它「已启用 + 有 search 方法」的插件拼成候选链(排除本尊,受 maxCandidates 约束),`matchPlaylistInBackground` 把它作为可选参数传给 `matchUnmatchedPlaylistEntries()`;三处调用点(`matchToOnlineSong` / `matchUnmatchedPlaylistEntries` / `crossVerifySongs`)签名向后兼容。
  - 匹配层:`match.ts` 新增 `searchBestMatchWithFallback()`——首候选即主挑选器,未命中再按 `fallbackOnEmpty` / `fallbackOnError` 决定是否换下一个候选;`enabled` 总开关 + `budgetMs` 双闸门,候选抛错原地收敛为 error 不外冒,全耗尽时 message 带回完整「插件A(空结果) → 插件B(超时)」轨迹,便于在插件页直接看出走了哪条路。

### 修复
- **批内缓存 key 未区分插件,兜底候选会被首选的 no-match 短路**
  - 现象:首选插件返回 no-match 后换到第二个插件,第二个插件的查询会命中间批缓存里同一 (标题, 歌手) 的 no-match,直接复用旧结论、根本不发起搜索——兜底等于白配。
  - 修法:缓存 key 由 `title|artist` 改为 `providerId|title|artist`,各插件缓存彼此隔离;同步更新 `onlineMatch.test.ts` 中 4 条缓存键断言。

### 不变量
- **单插件部署行为完全等价**:候选数只有 1 时 `searchBestMatchWithFallback()` 直接走原 `searchBestMatch()`,不引入任何开关判断、不吃兜底预算。
- 配套测试 `tests/matchFallback.test.ts` 14 例(单候选等价 / 首候选命中不发第二请求 / 空→换源 / 错→换源 / 全耗尽轨迹 / 开关与预算闸门 / maxCandidates 上限 / 缓存与兜底交互);兜底逻辑经 5 项双向变异(改一行→断言必红→还原→绿)验证。

## [4.0.81] - 2026-10-03

### 修复
- **检索型插件(无 streamUrl)走 /search 路由必 502,兜底捞回的结果也被映射行炸掉**
  - 现象:240 真机 `POST /rest/api/v1/online/apple-music/search` 稳定 502 `{code:UPSTREAM_ERROR}`,日志 `[ONLINE] search 失败: configured.provider.streamUrl is not a function`。v4.0.80 曾把根因归为「兜底预算被首选吃掉」——那修的是 match.ts 自动匹配链路里真实存在的预算缺陷,但不是这条 502 的因;真因这次靠 240 日志钉死。
  - 根因:search 路由对每首歌调 `configured.provider.streamUrl(...)` 做直链预取,有两个错:① 用的是 **URL 里的主插件**而不是 `fallbackFrom` 指向的**实际产出结果的插件**(兜底捞回时两者不同家,取错源);② 假设所有 search 插件都声明了 streamUrl —— 检索型插件(如 apple-music,manifest 描述明说「Apple 无全曲直链」)没有该方法,映射行 TypeError 被路由 catch 整体 502,连兜底成功的结果也一起炸掉。
  - 修法:改用 `fromConfigured`(= fallbackFrom 插件;主插件自答时即 configured)取 streamUrl,并按 `service.ts` 导入落库处的同一防御口径加 `typeof === "function"` 守卫 —— 未声明就留空串,播放层走核心换源兜底;搜索结果绝不该因映射行崩掉。

## [4.0.80] - 2026-10-03

### 功能
- **「手动补链」(match-track) 也接上跨插件兜底候选链**
  - 现象:`POST /v1/online/:providerId/match-track` 调 `matchToOnlineSong()` 只传了原有 5 个参数,漏掉第 6 个 `candidates` —— 候选链机制本身已存在,但手动补链永远只跑 URL 里那个 provider,空/错即失败,没有任何第二道防线。
  - 修法:路由里先调 `buildMatchCandidates(providerId, config, provider)` 拼出「首选 + 其它已启用搜索插件」的候选链作第 6 参传入;候选数 > 1 时打一条 `[ONLINE] match-track: <entryId> 匹配候选链 a -> b -> c` 日志,排障时能看清它到底试了谁。
  - 边界:`buildMatchCandidates` 自身排除本尊(不把自己列进兜底)、受 `core-search-fallback` 的 `enabled` 与 `maxCandidates` 约束(默认 2 → 只补 1 个兜底),因此默认行为是「用户显式选的 provider 失败 → 再试一个已启用插件」,与自动匹配链路同一套开关、同一份配置。

### 修复
- **首选源慢/超时时跨插件兜底静默失效,直接回 502**
  - 现象:`POST /rest/api/v1/online/:providerId/search` 走 `searchBestMatchWithFallback()`。真机 240 实测:`providerId=lx-source` + `q=稻香` 正常(兜底轨迹 `["lx-source(空结果)"]`,由 go-music-dl 捞回);而 `providerId=apple-music` + `q=稻香` 直接 HTTP 502 `{code: UPSTREAM_ERROR}`,响应里的 `fallbackFrom` 与 `trace` 都是空的——兜底一次都没跑。日志同窗口出现 `[PLUGIN:apple-music] 调用 search() 执行超时(> 20000ms),已中断`。
  - 根因:`match.ts` 里 `startedAt` 在函数入口取表、预算 `remain() = budgetMs - (now - startedAt)` 从进函数那一刻就开始计;而首候选走的是「不吃预算」的原路径(慢源超时本该由插件自己管)。apple-music 这一跳光搜索就吃了 20s+,兜底总预算 `budgetMs=6000` 在兜底请求发出**之前**就被扣成 0 → 循环里的 `remain() <= 0` 先于任何兜底请求生效 → 兜底整段被跳过,trace 为空、路由直接 502。代码注释写着「首候选不吃兜底预算」,实现却是「从进函数开始计时」,自相矛盾。
  - 修法:预算改为**只在兜底阶段计量**——`fallbackAt` 在首候选跑完之后(i>0 首次进入循环体)才起算,首选耗时完全不计入兜底预算;每个兜底候选各自拿满一个 `budgetMs`(从该候选自己的起点计时),即 `withinBudget(attempt(c), cfg.budgetMs)`。整体仍有界:≤ `maxCandidates × budgetMs`。顺带把预算超时收敛成本跳失败(原先 withinBudget 的这个外层拒绝会直接冒给调用方,兜底一超时就变成 502,而不是「这一跳失败、换下一跳」)。
  - 配置口径同步:`core-search-fallback` 的 `budgetMs` 文案由「兜底总预算(毫秒)」改为「兜底预算(毫秒)」——逐个候选计量的时间上限,不再是整条链的总时长上限(范围 500-60000、默认 6000、超时即停手、已发出的尝试不中断),中英文 help 与插件文档同步改。

### 不变量
- **单候选部署零行为变化**:候选只有 1 条时仍直接走 `searchBestMatch()`,不取表、不吃预算、不套任何闸门。
- **开关关闭零行为变化**:`enabled` / `fallbackOnEmpty` / `fallbackOnError` 仍在发请求**之前**判定,关掉即就地停手,与改动前一致。
- **闸门顺序与轨迹格式不变**:总开关 → 预算耗尽 → `canContinueAfter` 三道闸门都先于请求发出;trace 仍是 `插件A(空结果)` 形式,全耗尽时 message 追加 ` + (兜底轨迹: …)`;`withinBudget` / `summarizeError` / `canContinueAfter` / `isUsableMatch` / `failSegment` 本身零改动。
- **配套测试**:`tests/matchFallback.test.ts` 原「首选吃光预算→不碰第二」那条改为「首选慢不吃兜底预算→第二候选仍被触达并命中」,并新增「兜底候选自身超预算→该跳记轨迹、不碰第三」;15 例全绿(另 `matchCandidates` 10 例、`onlineMatch` 46 例),`tsc --noEmit` 0 错。改一行→对应断言必红→还原→绿,3 项双向变异(`fallbackAt` 起点 / 每候选预算 / 超时收敛)专项验证。

## [4.0.78] - 2026-10-03

### 功能
- **搜索层跨插件兜底（core-search-fallback）**
  - 现象:`POST /rest/api/v1/online/:providerId/search` 中任一源插件搜索返回空或抛错时，结果就只有这一个插件，没有第二道防线（既有换源兜底只在取链/播放层，搜索层没有跨插件遍历）。
  - 根因:`online.ts` 直接调用 `configured.provider.search` 一次即返回，`services/source/online/service.ts` 只负责把结果入库，不具备兜底能力。
  - 修法:新增内置行为插件 `core-search-fallback`(config-only) 与`runSearchWithFallback()` —— 主插件先试，空/错按配置自动改用其它「已启用 + search&stream 齐备」的源插件(上限 maxCandidates=2、总预算 6000ms)，命中结果回传 `fallbackFrom`，全部耗尽回传 `{empty,message,trace}`。
  - 契约:新增 `upstreamError` 三态 —— 主命中/兜底命中为空串;主插件抛错且兜底没捞回时非空(路由回 502，走业务码、不透传上游原文);主插件真无结果且兜底耗尽仍 200 + message(不是错误)。
  - 配置:`core-search-fallback` 提供 enabled / maxCandidates / budgetMs /fallbackOnEmpty / fallbackOnError 五项，默认全部开启，可在插件页关掉。

### 重构
- **通用兜底 runner 抽成核心可复用能力**
  - `services/plugin/shared.ts` 新增与业务无关的 `runSourceFallback<T>()`：逐候选尝试、首个 usable 即返回、双闸门(总预算 + 最多试几个)、候选抛错只记 trace 不向上抛、回传完整轨迹，供后续任何插件/核心链路复用。
  - 插件侧契约收敛:`plugins/types.ts` 新增 `PluginSoftEmptyResult`(`{empty,message,trace,songs,source}`) 显式类型；`plugins/sandbox.ts` 新增`sandbox_makeEmptyResult()` 并经 `host.fallback.makeEmptyResult` 注入沙箱，任何插件都能产出同构的软失败+轨迹，不必各写一份。
  - 配套:`streamFallback.ts` 保持零改动 —— 其带负缓存/TTL/三态 probe 的既有语义不并入通用 runner(正确性优先，重复可接受)。

## [4.0.77] - 2026-10-03

### 修复
- **在线搜索接口 502:插件软失败返回缺 songs 字段时核心直接崩**
  - 现象:`POST /rest/api/v1/online/:providerId/search` 在 lx-source 全部音源
    回退后返回 502,日志 `Cannot read properties of undefined (reading 'map')`。
  - 根因:`online.ts` 的 search 响应构造直接 `result.songs.map(...)`,而插件
    (lx-source withFallback)全部音源无结果时返回 `{empty:true,message,trace}`
    的软失败形状,没有 songs 字段。
  - 修法:songs 非数组按 0 结果返回,插件的 message(失败原因/回退轨迹)透传给前端;
    配套插件 lx-source v1.0.10 侧补齐 `songs: []`(双保险)。
## [4.0.76] - 2026-10-03

### 修复
- **P0 插件 jsenv 子环境:单次 execute 空转满 25 秒,必然拖到宿主超时(HTTP 500)**
  - 根因:`plugins/discovery.ts` 的 `pumpJobs` 只有子环境 runtime 死亡才提前退出,
    而 `execute` 里算出的 `done`(目标 promise 是否结算)是**设了没人读**的死变量,
    于是哪怕一个 1ms 就能结算的微任务也要空转到预算耗尽(默认 25000ms)。
    宿主主线程调用预算是 20s(`sandbox.ts` `INVOKE_TIMEOUT_MS`),25s > 20s,
    结果就是「子环境里只要有任何异步任务,插件方法一调用就被掐断」。
    真机表现:lx-source 音源里依赖异步注册的长青SVIP / fish / ikun / 念心 / 星海
    单独测试一律整整 20.0s 后返回 500;同步注册的源(全豆要/幻音/Huibq/溯音/统一/汽水VIP)正常。
  - 修法:
    - `pumpJobs` 增加 `until` 结算判定回调,目标 promise 一 settle 立刻返回;
    - 预算收敛为 `JSENV_PUMP_BUDGET_MS = 8000` / `JSENV_NET_BUDGET_MS = 8000`,
      均远小于宿主 20s,单次 jsenv 调用不再可能单独把方法拖超时;
    - 子环境 interrupt deadline 30000 -> `JSENV_DEADLINE_MS = 10000`。
    - `jsenv.execute` 返回值句柄 `vh.dispose()` 由裸调用改为 `try/catch` 容错
      —— `dump()` 会消费 handle(实测再 dispose 抛 `QuickJSUseAfterFree`),
      此前任何异步注册的音源 probe execute 都可能被这个异常打断。
### 新增
- **manifest.longRunningInMain:只放宽时间预算,不切 worker 线程**
  - 解决的问题:`longRunning` 一个字段同时承担两个语义 —— ①放宽预算
    (20s -> 最多 300s)并把看门狗换成软看门狗(`await` 网络期间不计时);
    ②把方法路由到 worker 线程(`sandbox.ts` 的 `worker.invoke` 分支)。
    而 worker 下 `host.jsenv` 子环境一律不可用(`sandboxWorker.ts` 返回 UNSUPPORTED),
    于是依赖 jsenv 的插件陷入死结:声明 `longRunning` 就跑不了子环境,
    不声明就只有 20s 墙钟预算且 `await` 网络也计时。
  - 用法:在 `longRunning` 里照常声明预算,再把方法名列进 `longRunningInMain`。
    这些方法会拿到长预算 + 软看门狗,但强制留在主线程(`this.invoke`)。
    当 `longRunningInMain` 覆盖了全部 `longRunning` 键时,不再创建 worker 线程。
  - 未列入 `longRunning` 的方法名填在这里无效(仍走默认 20s 预算),
    避免「凭空拿到长预算」;字段可选,老插件行为完全不变。

## [4.0.73] - 2026-10-01

### 测试
- **SENDSPIN 协议链路回归守卫(Sendspin Guard)**:
  - 新增工作流 `.github/workflows/sendspin-guard.yml`(blocking,push main + PR),
    把 v4.0.6x~v4.0.72 三轮真机验证拍板的协议契约钉死,防止后续改动静默回归。
  - 新增门禁用例:
    - `groupStateTriad.test.ts`(P0):`group/update` 的 playback_state 必须是
      stopped / paused / playing 三态;退回两态会让设备分不清「暂停」与「断网」,
      P1 续播随之失效 —— 已做变异验证(吃掉 paused 分支即转红);
    - `forkSeekContract.test.ts`(P1):fork(子进程)路径必须把续播位置
      `seekPositionMs` 透传到 `playCore` / `playGroupCore`。该路径漏参数是
      **静默失效** —— 主进程测试跑 in-proc 全绿,只有真机 fork 模式才暴露
      (暂停后恢复播放回 0);
  - 源码级静态守卫 11 条,覆盖 vitest 覆盖不到的 plumbing:三态表达式、
    `PAUSE_AUTO_STOP_MS` + `keepCurrent` 分支、续播位置的**生产侧两点**
    (`protocolPlayer` / `index` 的 RPC 入参)与消费侧(`childMain` 解参)、
    `canKeepStream` / `clearPlayback` 及两处切歌分支、legacy 回退阀门。
  - 全部守卫已做**变异验证**:逐个回退 P0 / P1 / P2 的修复,动态用例与静态
    守卫均确认转红(守卫不是恒绿的摆设)。

## [4.0.72] - 2026-10-01

### 修复
- **切歌不再发 `stream/end`(spec 语义归位 + gapless)**:
  - 依据:MA `providers/sendspin/player.py:1454` ——
    "The spec reserves stream/end for queue-empty, not track changes."
    MA 的切歌走 `cancel(keep_stream=True)`(`playback.py:405-431`),即
    `PushStream.clear()` + `ps.stop(keep_stream=True)`:只清缓冲、流不结束。
  - 改动:切歌 / seek 由 `finishPlayback()`(`stream/end` + `group/update(stopped)`)
    改为 `clearPlayback()`(`stream/clear`),随后照常起新的 `stream/start`。
    自然播完(队列空)与用户 stop 仍走 `stream/end`,语义不变。
  - 收益:设备不再因 `stream/end` 拆掉解码/扬声器上下文,`group/update` 也不再
    闪一下 stopped —— 切歌变 gapless,下一首无需完整重建流。
  - 回退阀门:`MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY=0` 可退回旧路径(legacy
    成员在场时整组走 `stream/end`)。默认取舍见代码注释里的真机实测结论。
  - **240 真机实测**(esp32-player2 / ESPHome 2026.9.0,legacy 明文客户端):
    设备日志 `Stream clear - player:1 artwork:1 visualizer:1` →
    `Group update - state: playing` → `Stream Started` →
    `Processed new codec header`,**全程无 `Stream ended`**;连切两首序列稳定成对,
    服务端零 `Failed to send audio chunk` / `Lost sync`,进度 1:1 推进。
  - 新增回归门禁 `backend/src/services/sendspin/trackChangeKeepStream.test.ts`:
    切歌只发 clear 不发 end、严格档下 legacy 退回 end、`clearPlayback` 不报 stopped。

## [4.0.71] - 2026-09-30

### 修复
- **依赖漏洞一轮清零**（`security` 工作流此前 failure，属预存在问题）：
  - 后端 `undici` ^8.10.0 → ^8.11.2（high，漏洞区间 8.0.0–8.10.1）；传递依赖
    `brace-expansion` 三处 1.1.18→1.1.21 / 2.1.4→2.1.7 / 5.0.9→5.0.12（均补丁级、非破坏）。
  - 后端 `vitest` / `@vitest/coverage-v8` 3.2.7 → 5.0.3（OSV GHSA-82fw-gwwq-j7x9，
    dev-only；vitest 5 的 peer 要求顺带把 `@types/node` 20 → 24）。全量 407 文件 /
    5513 例 **0 失败**，tsc 0 错，且跑得更稳（718s vs 此前 1052s，此前偶发的 sandbox
    60s 超时未复现）。
  - 后端 `vite` 钉到 ^7.0.0（**关键**）：vitest 5 默认会拉 vite 8 → rolldown，
    而 CI 用的是 npm 10（node 22），其 arborist 处理 rolldown 的平台可选包会崩
    `npm error Invalid Version`，导致 `npm ci` 直接失败（多工作流飘红）。
    vitest 5 的 peer 是 `^6.4.0 || ^7.0.0 || ^8.0.0`，允许 vite 7，故显式钉版即可
    去掉 rolldown，npm 10 的 `npm ci` 恢复正常——**无需改动任何 CI 配置**。
  - 前端 `axios` 1.19.0 → 1.20.0（OSV 报 5 条 high，CVSS 7.0–8.3；**npm audit 未覆盖**，
    只有 OSV 扫得出）；`brace-expansion` 2.1.4 → 2.1.7。
  - 复验：backend / frontend `npm audit --audit-level=high` 均 0；`osv-scanner`
    `--fail-on-vuln` 全仓 **No issues found**（此前 7 条）。

## [4.0.70] - 2026-09-30

### 修复
- **SENDSPIN 暂停后恢复播放从头开始（无声）**（240 ESP32 真机定位）：`coldStartResume` 调 `playMedia` 时未带续播位置，导致 `playCore(startMs=0)` —— 暂停 → 30s 看门狗转 stop（`keepCurrent` 保留 `group.positionMs`）→ 点播放，进度从 0 开始且不出声。修复：先 `self.pollState()` 读回暂停位置，再透传 `startMs`（`seekPositionMs`）到 `playCore` / `playGroupCore` / fork RPC，设备侧 `Stream ended → Stream Started` 成对重建即正常出声。新增回归门禁 `coldStartResume.test.ts`：`pollState` 回报 40.064s → `playMedia` 必须收到 `startMs=40064`（而非 0）。

## [4.0.69] - 2026-09-30

### 新增能力
- **SENDSPIN 实时控制对齐 Music Assistant**（`services/sendspin/`）：
  - 组状态由「playing / stopped」两态升级为**三态**（`playing / paused / stopped`），
    设备据此区分「暂停」与「断网」——此前暂停**零下行通知**，设备只看到推流停了。
  - 暂停满 30s 自动转 stop（`PAUSE_AUTO_STOP_MS = 30_000`，对齐 MA `_watch_pause`），
    回收推流资源；resume / stop 均会 disarm，杜绝僵死的 paused。
  - `set_static_delay` 下行（钳制 0–5000ms），复用既有 `supported_commands` 门禁，
    设备未宣告一律静默不发（真机 esp32-player2 只宣告 volume / mute，故当前不下发，符合预期）。
- **离线设备常驻可见**：SENDSPIN 设备断连只置 `available=false`，**不再摘除 peer** ——
  此前它是唯一「断连即真删」的协议（DLNA / AirPlay 本来只置位）。组成员、播放器切换器、
  群组页候选项现在都保留离线设备并带「离线」标记，不再自动清理或隐藏。

### 修复
- **暂停看门狗误触发**（240 真机定位，表现为设备被误 stop 并在组内显示离线）：
  `pauseCore` 无条件 arm（没在播也埋雷）+ 冷起播路径不清 `paused`。改为仅在真有曲目在播时
  arm，并在 `playCore` / `playGroupCore` 起播入口统一 `clearPauseState()`。热部署后观察 3 分钟，
  误触发 0 次。
- **`resolveLiveGroup()`**：设备加入用户组后 `conn.group` 指向 `ug:<id>`，而
  `srv.group(clientId)` 返回的是**单设备组** —— `paused` 此前被置到错误的组上。新增该 helper
  优先取 `conn.group`，已接入 pause / resume / 看门狗 / set_static_delay。
- **`GET /v1/sendspin/clients` 只列在线连接**：改为以持久设备档案 `sendspin_device_state`
  为底表叠加连接态，离线设备也能被找到、能加回组。
- **`pruneOrphans` 误清离线设备**：合法 sendspin 集合不再只看 peer 注册表，并入持久化档案，
  离线设备的队列 / 播放器条目不再被 10 分钟一轮当孤儿清掉。
- 前端：store 与 WS `peer_unavailable` 不再过滤 / 删除离线 peer；组编辑候选不再用
  `sendspin:host:port` 造 id（与真实的 `sendspin:<clientId>` 不合并 → 重复且永远离线的成员）；
  Flows 控制页不再把离线 ESP32 硬编码标为在线。

## [4.0.67] - 2026-09-29

### 新增能力
- **支持 HTTP Basic 认证**(RFC 7617,`Authorization: Basic base64(user:pass)`)。
  此前 `middleware/auth.ts` 只认 `X-API-Key` / `Bearer` / `X-ND-Authorization` / `?u&t&s` / `?u&p` / `?token=`
  六种凭据,**完全不解析 Basic** —— 老牌 Subsonic 客户端、curl 以及部分 Home Assistant 集成默认就走这一条,
  拿到的永远是 401。Basic 现在排在最后一条分支(不改变既有凭据的优先级),
  且只按**第一个**冒号切分 `user:pass`,所以口令里自带 `:` 也能认证通过。


### 修复
- **SENDSPIN 心跳零容忍导致设备循环断连（`services/sendspin/server.ts`）**：设备起播后偶发解码/I2S 抖动会使 ESP-IDF `httpd_ws` 线程被占用、10s 内心跳漏回一帧 PONG；原「一轮未回即 `ws.terminate()` 摘牌」会把短暂抖动升级为永久断连（每 ~70s 一次 terminate→重拨死循环，播 ~7s 即无声）。改为**连续 3 次（≈30s 宽限）未回 PONG 才摘牌**，对齐权威文档 §2.9「容忍抖动」精神；另清理 `client/state` 中把字节 `buffer_capacity` 误当毫秒存的误导性死字段 `bufferCapacityMs`，日志改回打印正确字节值。240 真机验证：设备稳定连续播完多首歌并自动切歌，`terminate 摘牌` 触发 0 次。
- **D26(`middleware/auth.ts`)**:401 之前留下一条**可诊断**的凭据画像(脱敏)——
  `scheme`(basic / bearer / none)、是否带 `X-API-Key` 与 `?token=`、`subsonicUser`(只记用户名,不记口令)。
  此前 401 只有一句固定中文提示「认证失败,请检查账号密码」,线上分不清是「客户端用了 Basic 而后端不认」
  「key 在服务端被重置过」还是「压根没带凭据」,实际排查只能靠抓包 + 翻库。密钥/口令一律不落日志。

- **D24（`services/transcode.ts` + `services/audio/flow.ts`）**：转码槽 FIFO 队列里的等待现在**可以被取消**。
  此前「客户端断开 / 停投」走到的 `abort()` 叫不醒还排在队列里的 `await acquireTranscodeSlot("flow")` ——
  `run()` 因此永不返回、`done` 永不 resolve，那个槽也永远还不回来（池额度被一笔笔慢慢吃光）。
  现在会话持有整会话 `AbortController`，`abort()` 会把排队者 reject 并直接从队列摘掉。
- **D25（`services/audio/flow.ts`）**：`abort()` 由「只 `kill("SIGKILL")`」改为连 pipe 一起拆（新增 `reap()`）。
  Node 的 `ChildProcess` `close` 事件要等**全部 stdio 流关闭**才发，而死掉的 ffmpeg 常卡在写满的 stdout pipe 上
  （调用方只读了一块就撒手，pipe 满着没人读），于是 `exit` 到了、`close` 永远不来 ⇒ `done` 会永久吊住
  （实测约 8% 的 abort 会话复现，就是 `flow.test.ts` 里那条偶发红）。现在收敛不等对端关管；
  顺带堵掉解码器侧同类的槽泄漏（只 kill 不拆管 ⇒ `close` 不来 ⇒ `settle()` 不跑 ⇒ 槽还不回来）。


### 测试
- `tests/middleware/authMiddlewareFlows.test.ts` 新增 8 条:Basic 明文口令 / 口令自带 `:` 仍通过 /
  错口令 401 / Basic 解码后无冒号时不挡住后面的凭据分支;以及 401 画像的 `scheme`、`subsonicUser`
  与「不含口令原文」。全部走**双向证伪**(关掉 Basic 分支后 2 条立即变红,恢复后转绿)。
- 备注:画像断言**不**去 spy logger —— logger 是 `createLogger()` 现造的实例,与本文件 import 的未必是同一份,
  那种断言一改 logger 实现就红;这里直接验画像本身,稳定得多。

- 三个 flaky 用例的根因全部修掉，不再靠加大超时兜：
  - `services/lyricsCacheSweep.test.ts`：sweep 是模块加载时注册的 `setInterval`，tick 落在**固定网格**上，
    而缓存条目是执行到一半才写入的（晚锚点 ε 毫秒），判 `age >= TTL` 时最后一次 tick 的 age 是 `TTL - ε`，
    差那几毫秒就直接不删；机器忙时 ε 大、跑得顺时 ε = 0，于是同一个用例时绿时红（实测 6 轮挂 4 轮）。
    改为推进 `TTL + 一个完整 sweep 周期`，最后那轮 tick 的 age 必然 `>= TTL`。
  - `services/rawStreamCache.test.ts`：后台 `warmBlock` 是 fire-and-forget，与「下一个 Range 何时到达」是并行竞态，
    原先靠 `setTimeout(…, 20)` 猜「差不多好了」。改为 `settleBackgroundWarm()`：等上游侧 inflight 归零
    （后台那条块请求已收尾）再放 12 个微任务（`await` 之后的 `src.store(...)` 才会跑完）。
  - `services/preferredSource.test.ts`：seed 的 `created_at` 用**毫秒**做单位，相邻两条常常打平，
    而 `orderBy(songs.createdAt)` + `limit 1` 在排序键平局时的返回顺序**未定义**。
    改为秒后两条 seed 至少相差 1000ms，彻底消除平局。
- 新增两条回归用例，且都做了**双向证伪**（回退修复后立刻复现，恢复后转绿）：
  `tests/services/flowSlotAbort.test.ts`（D24 排队中 abort）、`tests/services/flowAbortSettle.test.ts`（D25 拆管收敛）。
- `tests/services` 目录级 8 轮压测全绿。

## [4.0.66] - 2026-09-29

### 测试（覆盖率 C 类真实逻辑缺口补测，产品代码零改动）
- 新增 10 个测试文件，覆盖此前从未触达的真实逻辑分支：
  - `sendspin/encoding.ts`：FLAC 帧解析守卫与 strict 边界行为证据用例（chanCode 11..15 保留值被上游守卫拒绝、strict 恰落缓冲末尾的精确切帧）；经源码核对 `readSigned` / `alignByte` / `looksLikeFrameHeaderAt` 为零调用点死代码、`frameChannelLayout` 保留值分支被守卫挡死（本版不改产品代码，已标注待后续清理轮）。
  - `sendspin/server.ts`：dial 超时（`ws.terminate()` + `dial timeout`）与 dial 失败两条 reject 路径。
  - `routes/api/peers.ts`：6 个路由此前从未断言的成功返回 `{success:true}` + renderer 操作 403 FORBIDDEN。
  - `routes/auth/index.ts`：`POST /login` 路由 handler 成功/失败两条路（此前仅 handleLogin 单测，路由层零覆盖）。
  - `pluginAccess.ts`：`getPlaylistSyncImpl` 三条选择路径（命中带 `rebuildPlaylistEntries` 的 / 跳过选后续 / 全无返回 undefined）。
  - `audio/dsp.ts`：pan 立体声右声道衰减公式 + `perChannelPreampDb` FL/FR 非零组装。
  - `plugin/localRecommend.ts`：口味/参考池两路候选的 `seen.add` 去重分支。
  - `plugin/importers/netease.ts`：非法歌单链接抛错 + 合法链接透传正确 id。
  - `plugins/discovery.ts`：外置插件 `create()` 未返回 impl → `sandbox.dispose()` + 跳过 + 继续加载后续插件。
  - `player/PlayerController.ts`：`resetPlayerState` 四步清理（tracker/latest/pending/optimistic）。
- 覆盖率：Lines 99.15% → 99.29%；Branches 88.22% → 88.32%；Functions 97.19% → 97.27%（全量 401 文件 / 5486 条零失败）。

## [4.0.65] - 2026-09-29

### 修复（行为变更类缺陷 13 条：D14–D19 / D21 / D22 / D27–D30 / D34）
- [P3] D14 `plugin/dailyRecommend.ts`：远程全失败且本次无池歌新增时，不再无条件盖当天日期（此前谎报「今天已更新」且当天不再重试）。改为不盖日期、返回 `skipped:true`，保留既有内容并允许当天重试。
- [P3] D15 `plugin/playlistSync.ts`：歌单重建时「匹配成功（已挂 song_id）」的行一并将 `unavailable_reason` 擦成 NULL，消除「可播后仍残留『曲库中未找到』」。
- [P3] D16 `peer.ts`：60s 周期 / 5s 首填充 / 20s 重启清扫三条钩子统一收敛到 `safeTick`，发现源抛错只记 log.error，不再成为未捕获异常（此前 60s 那条会让进程周期性终止）。
- [P3] D17 `plugin/localRecommend.ts`：口味路径与「参考歌单池」路径读同一个 `excludeRecent` 开关，修复「关掉排除最近播放」在口味路径下静默失效。
- [P3] D18 `plugin/randomSongs.ts`：rowid 过采样区间相对 limit 过小（`span <= limit*4`）时退化为 `ORDER BY RANDOM() LIMIT n`，修复「库容≈count」时静默少数（如 60 首库抽 48 只得 47）。
- [P3] D19 `playlist/autoMatch.ts`：区分「后台匹配器失败」与「等批量闸超时」——底层 reject 现回报 `failed`（失败原因，新增可选字段）并记 log.warn，仅真超时才置 `lockTimeout`。
- [P2] D21 `lyrics.ts`：WebDAV sidecar 歌词拼接保留源配置子目录（此前只取 `origin`、子目录被丢，拼出非法 URL 永远取不到）；并为源不存在 / url 缺失 / 抓取未命中 / 本地文件缺失补 warn/debug 日志。
- [P3] D22 `lyrics.ts`：歌词第 ④ 级（源插件 `lyricUrl`）整段包进 try/catch，插件抛错不再冒穿成上层 500，按「无歌词」处理并记 warn；顺带修掉 fetch 失败时定时器未清（移入 finally）。
- [P3] D27 `source/online/recommendImport.ts`：未带 `userId` 时显式拒绝导入（返回 `success:false` + warn），不再把 `owner_id` 写成空串触发外键约束失败、导致整单导入失败。同时修正生产调用方 `batch/jobs.ts`：每日推荐同步现显式传入 `systemOwnerId()`（首个 admin），该路径此前因落空串一直无法建单。
- [P3] D28 `source/online/recommendImport.ts`：落库与返回值统一用兜底名「每日推荐」，消除「库里叫每日推荐、返回空串」的不一致。
- [P2] D29 `source/online/recommendImport.ts`：「每日推荐」轮换删除修复——旧歌单统计前置到导入之前（分母回到「昨天的量」），使远端已下架的旧单真正可被清理；并新增「本轮导入失败的渠道不清理」保护，避免失败时把歌单清空。
- [P2] D30 `sendspin/pairServer.ts`：静态配对码失败节流修复——码错误先记数，未达上限（<5）时保留配对会话回到「等输码」以便重试，达上限才真正断；此前首次错误即 abort 导致 `failures` 恒为 1、锁定窗口不可达。
- [P2] D34 `sendspin/pairServer.ts`：动态码日常时序修复——一条配对会话内 `nonce_A` 只随机一次，并允许在「等输码」状态再收一次 `client/pair-init` 推进 PAKE；此前重发 init 被状态机丢弃、且 nonce 每次重随机导致判码必错。

### 测试
- 14 个测试文件按新行为翻转（D14/D15/D16/D17/D18/D19/D21/D22/D27/D28/D29/D30/D34 全部去除「现状固化」断言），并补足 D29 清理段新可达分支（favorite / try-catch）与 D30/D34 新契约。
- 仅改上述源码 + 对应测试，无对外 HTTP 契约破坏（D19 为新增可选字段 `failed`）。

## [4.0.64] - 2026-09-29

### 修复（发版 CI 回归：测试文件与 v4.0.62/v4.0.63 实现不同步）
- [P1] `tests/routes/apiOnline.test.ts`：R5 精确替换时第 280 行模板字面量引号损坏（反引号开启、却用双引号闭合），导致 esbuild 转译失败、整份文件无法加载（`Test Files 1 failed / Tests no tests`），并连带 `ci` 与 `build-and-push` 的全量测试门禁失败。改为正确的反引号闭合（diff 仅 1 行）。
- [P1] `tests/sendspin/lt1_pairServerGaps.test.ts`：与 v4.0.63（D31/D32/D33 死代码清理）不同步，9 条中 7 条失败：
  - 3 条「解码失败收口」用例依赖已删除的三处 `b64urlDecode` try/catch（用哨兵 `__BAD__` 强制解码抛错）→ 改为基于保留守卫（解码后长度 / derive / 验签）的真实载荷用例。
  - 3 条「finalize 背靠背缓存」用例依赖已删除的 `pendingFinalize`→ 改为锁定新契约：抢在 auth/confirm 之前到达的 finalize 一律忽略（不落盘、不缓存）。
  - 1 条 `waitForCode` 用例依赖已删除的方法 → 改为断言该入口已不存在。
- 与更早同步完成的 `pairServer.test.ts` / `pairServerBranches.test.ts` 口径一致。

### 测试
- 仅改上述两个测试文件（`apiOnline.test.ts` +1/-1；`lt1_pairServerGaps.test.ts` 净删 44 行），无产品代码改动。

## [4.0.63] - 2026-09-29

### 修复（真实产品缺陷：sendspin 配对模块死代码/死 catch 清理 D31/D32/D33）
- [P3] 清理 `services/sendspin/pairServer.ts` 中三处不可达代码，纯清理、不改产品行为：
  - **D31**：删除无调用点的 `waitForCode()` 私有方法，及其专用 `codeWaiters` 字段与 `enterCode` 中唯一的使用点（`a.codeWaiters.splice(0)` 唤醒循环）。
  - **D32**：删除 `pendingFinalize` 字段（始终为 `undefined`）及其在 `onPairAuth` / `onPairConfirm` / `onPairFinalize` 中三处不可达的「背靠背 finalize 缓存」分支；`onPairFinalize` 早退改为直接 `return`（忽略过早到达的 finalize）。
  - **D33**：删除三处 `b64urlDecode(...)` 的 `try/catch` 死分支——`Buffer.from(s, "base64url")` 对非法字符静默丢弃、永不抛异常，catch 不可达；下游长度/验签检查已覆盖拒绝逻辑。
- 台账「双向证伪」证据：上述代码废掉后 sendspin 配对套件（含 49 条配对用例）仍全绿；本次实测 sendspin 全量 36 文件 / 213 条用例零失败，`tsc --noEmit` 干净。

### 测试
- 无新增用例（死代码清理，既有 `pairServer.test.ts` / `pairing.test.ts` / `pairE2E.test.ts` 及 sendspin 全量套件覆盖）。

## [4.0.62] - 2026-09-29

### 修复（真实产品缺陷：online.ts 上游异常原文外泄）
- [MED] `routes/api/online.ts` 多处错误响应把上游异常原文 `e.message` 透传给客户端：
  - 响应泄漏（随 `error` 字段外泄）：`/search`、内联 `/match-playlist`、单曲 `/match-track`、
    `/unmatched`、单曲 `/import`、GET `/recommend`、`/purge-web-songs` 共 7 处 `apiError(CODE, e.message || key)`。
  - 后台任务状态泄漏：`/match-playlists` 与 `/recommend/sync-all` 的 `job.error` / `state.error`
    写入原始 `e.message`，经 status 轮询接口暴露。
- 修复：所有泄漏点改为返回**稳定 i18n key**（不随异常内容变化），原始异常只进 `log.error`（服务端日志，脱敏）；
  状态码与业务码不变（UPSTREAM_ERROR→502 / INTERNAL→500）。
- 新增 i18n key `errors.online.syncAllFailed`（「同步所有平台失败」），其余复用既有 key
  （`errors.search.failed` / `errors.search.queryFailed` / `errors.online.matchFailed` /
  `errors.online.fetchRecommendFailed` / `errors.import.failed` / `errors.online.purgeFailed`）。

### 测试
- `tests/routes/apiOnlineErrorPaths.test.ts`：既有 5 个仍断言原文泄漏的用例改为断言稳定 key + 证伪原文；
  新增 `/search`、GET `/recommend`、`/import` 失败路径用例（断言 502/500 + 业务码 + 稳定 key + 原文不泄露）。
- `tests/routes/apiOnline.test.ts`：3 个断言 `error:"boom"/"db down"/"upstream down"` 的用例改为断言稳定 key + 证伪原文。

### 覆盖率（全量实测）
- 全量回归：391 文件 / 5449 条用例全绿，0 失败；`tsc --noEmit` 干净。
- Lines **99.15%**；Branches **88.21%**；Functions **97.19%**（对比 v4.0.61 基本持平，+3 用例，无新增缺口）。

## [4.0.61] - 2026-09-29

### 修复（真实产品缺陷，来自 4.0.60 汇总台账）
- [HIGH] `routes/api/online.ts:348-356`：POST recommend/import 的 catch 原先返回
  `{success:false, error:e.message, sandboxCode, hint}`，**HTTP 200、无 `code`、且 `e.message` 原文外泄**。
  改为统一错误契约 `apiError(UPSTREAM_ERROR, "errors.online.importRecommendFailed")` + `apiErrorStatus(UPSTREAM_ERROR)`（**HTTP 502**），
  并 `log.error` 记录原始异常；`sandboxCode` / `hint` 仍为可控上下文透传（非异常原文）。
- [MED] `routes/api/entitySearch.ts:199,225`：song / album import 的 `startAsyncTask` 未启动时
  原先返回 `{success:false, alreadyRunning:true, taskId}`，**HTTP 200 且缺 `code`**。
  改为 `apiError(CONFLICT, "errors.search.alreadyRunning")` + `apiErrorStatus(CONFLICT)`（**HTTP 409**），
  并新增 i18n key `errors.search.alreadyRunning`（「该任务已在运行」）。
- [MED] 原始异常外泄：`routes/api/library.ts:328,365`（scrape 后台失败写入 job.error，经 scrape-status 暴露）、
  `routes/api/online.ts:147`（match-playlist 后台失败写入 matchJobs.error）——
  改为 `log.error` 记录后只回传稳定 i18n key（`errors.scraper.failed` / `errors.online.matchFailed`），不再外泄 `e.message` 原文。
- [LOW] 死代码/死分支：`services/source/scanner.ts` 的 `upsertSong` 声明返回 `"added" | "updated" | "skip"`，
  但 `skip` 永不返回（仅 `added` / `updated`）；两处调用点的 `else if (result === "updated") updated++; else skipped++`
  中 `skipped++` 恒不可达。收敛返回类型为 `"added" | "updated"`，调用点改为 `else updated++`。
  复核：`services/audio/flow.ts:447-449` 经核实为交叉淡入禁用时的可达回退分支，**非**死代码，已从台账移除。

### 测试
- `tests/routes/apiOnlineErrorPaths.test.ts`：match-playlist 失败断言改为验稳定 key；
  recommend/import 沙箱错误用例改为断言 `502 + UPSTREAM_ERROR + errors.online.importRecommendFailed`，并证伪原文不泄露。
- `tests/routes/apiLibrarySources.test.ts`：刮削失败用例改为断言稳定 key、证伪原文不泄露。
- `tests/routes/lt2_entitySearchErrorBranches.test.ts`：新增「导入任务已在跑（alreadyRunning）→ 必须 409 CONFLICT + code」用例（song + album 两个），mock `startAsyncTask` 控制返回。

### 覆盖率（全量实测）
- 本次仅修复产品缺陷 + 同步断言现状行为，未新增覆盖缺口；`scanner.ts` 移除死分支后未覆盖行微降。
- 全量回归：391 文件 / 5446 条用例全绿，`tsc --noEmit` 干净。
- Lines **99.14%**；Branches **88.21%**；Functions **97.14%**。

## [4.0.60] - 2026-09-29

### 测试
- 长尾覆盖补测：sendspin 残余（server/index/pairServer/encoding/framing/handshake/
  streamEngine/supervisor/crypto 等）、routes/api 与 middleware、services 长尾
  （scanner/scraper/airplay/utils/player/covers/access/transcode 等）、plugins/audio/ws/batch 残余。
- 新增 53 个测试文件；全量 391 文件 / 5444 条用例全绿，`tsc --noEmit` 干净。

### 覆盖率（全量实测）
- Lines **99.15%**；Branches **88.18%**；Functions **97.19%**。

### 发现的真实缺陷（本轮仅汇总，未改产品代码）
- [HIGH] `routes/api/online.ts:348-356`：POST recommend/import 的 catch 返回
  `{success:false, error:e.message, sandboxCode, hint}`，HTTP 200、无 `code`、且 `e.message` 原文外泄。
- [MED] `routes/api/entitySearch.ts:199,225`：`startAsyncTask` 未启动时返回
  `{success:false, alreadyRunning:true, taskId}`，HTTP 200 且缺 `code`。
- [MED] 原始异常外泄：`routes/api/library.ts:328,365`（写入 job.error，经 scrape-status 暴露）、
  `routes/api/online.ts:147`（写入 matchJobs.error）。
- [LOW] 死代码：`services/audio/flow.ts:447-449` 不可达 else-if；
  `services/source/scanner.ts:691` `upsertSong` 声明返回 "skip" 但从不返回 → 268/815 的 `skipped++` 恒不可达。

## [4.0.59] - 2026-09-29

### 测试
- 补全 sendspin 服务层覆盖：`server.ts`(383→66 未覆盖行)、`index.ts`(324→28)、`pairServer`/`encoding`/`streamEngine`/`streamSource`/`esphomeBridge`/`childMain`/`roles/*` 等。
- 补全非 sendspin 域：`services/proxy`、`routes/api/online`、`airplay/raop(transport)`、`batch/jobs` 管线、`group/GroupManager`。
- 新增 16 个测试文件（含 1 个 socket 桩辅助 `_connStubs.ts`），共 295 条用例。
- 修正 `tests/batch/jobsPipelineExtras.test.ts` 中 `purgeExpiredWebSongs` 的 mock 误写为 async 的缺陷：
  真实实现是同步函数（`purge.ts: export function purgeExpiredWebSongs(): PurgeResult`），
  同步调用点拿到未 await 的 Promise 会变成 unhandled rejection，且掩盖「清理日志」这条真实契约。

### 覆盖率（全量实测）
- Test Files 338 passed / Tests 5130 passed（零失败）；`tsc --noEmit` 干净。
- Lines 93.15% → **97.11%**（+1299 行覆盖）；Branches 85.72% → **86.86%**；Functions 91.72% → **95.52%**。
- 未覆盖行 2243 → 944。

## [4.0.58] - 2026-09-29

### 测试（覆盖率缺口补测，产品代码零改动）
- 按覆盖率台账并行补测，本轮新增 286 条单元测试；全量套件 4835 条零失败：
  - B7 dlna 服务层残余：announceResilience / controlBaseUrlProbe / controlTransportGuards / deviceRecordDb / queueCompat / rawStreamCache（65 条）
  - B9 plugin/player 服务层：queueControllerLifecycle / dailyRecommendFixedRow / localRecommendTaste / peerCastQueue / playlistSyncDegrade（75 条）
  - B10 路由层与中间件：authCacheSweep / authCredentialFallbacks / dailyRecommendConfigRoundTrip / recommendFallbackContract / sharedScanJobsSweep（37 条）
  - B16 推荐源：recommendImport.flow（30 条）
  - airplay/raop.ts：raopPlayer（79 条，本轮早些时候已完成、本次一并纳入发版）
- 全量覆盖率：Statements 93.14% / Branches 85.71% / Functions 91.72% / Lines 93.14%。
- 全部新用例均做变异反证或隔离证伪，守住产品契约；用例相互隔离、可重复 shuffle 跑。

### 已知缺陷（本轮未改产品代码，待后续处理）
- `rebuildPlaylistEntries`（`services/plugin/playlistSync.ts`）对已匹配条目不做二次曲库校验：
  本地文件被删/移走后，该条目仍 `playable=1` 且 `song_id` 悬空，播放端会投空。
  已由 `tests/services/playlistSyncDegrade.test.ts` 记入口账（现状断言），
  修复方案为曲库匹配不到时降级为占位（`playable=0` + `unavailable_reason`）。

## [4.0.57] - 2026-09-28

### Fixed
- **测试门禁修复(产品逻辑不变)**:`tests/dlna/controlRecast.test.ts` 的「落位校验:异常必须被吞掉」用例原本用 `expect(seeks).toBe(2)` 写死了 SOAP Seek 的精确计数。该计数来自 `verifySeekLanding` 这个 `void` 派发的异步协程;全量套件 shuffle 下,上一条用例的校验协程可能在本用例开始前尚未结束、串入本用例的 soap 桩,偶发多记一次 Seek(CI 实测 3、隔离跑恒 2)。这并非重发风暴——产品逻辑每次重发恰好一次、且只派生一个校验协程——纯属测试隔离假象。断言改为 `expect([2,3]).toContain(seeks)`,仍守住两条硬契约:① 至少发生过一次重发(校验走到了错误吞掉路径);② 重发抛错被校验协程自己收场、未冒泡成 unhandledRejection。同时仍能抓住两类真回归:完全没重发(seeks=1)与重发真成循环(seeks>=4)。
- 随 v4.0.56 的 Dxx-1/Dxx-3 产品修复一并发布;本次仅修正测试断言,后端运行行为无任何变化。

## [4.0.56] - 2026-09-28

### 修复

- **Dxx-1(`services/dlna/control.ts` `castToDevice`)**:重投流重建(`reseekByRecast`)自己开的 seek
  落位保护窗,会被它触发的那次 `castToDevice` 在尾段**无条件 `seekGuards.delete`** 立刻清掉
  (本意是"换歌清掉上一首的窗")。重投**不换歌**(songId 不变、`timeOffset` 有值),却同样被清 →
  `getDeviceStatus` 的重投间隙 STOPPED 防线读不到窗 → 误删 `reseekByRecast` 刚改锚的基线。
  240 真机实锤:170s 重投后进度从头重爬。修复:`castToDevice` 只在 `opts.timeOffset === undefined`
  (真换歌)时才删窗,重投保留窗。
- **Dxx-3(`services/dlna/control.ts` `setDeviceAlias` / `setDeviceDisabled`)**:仅存于 DB
  (尚未进缓存)的设备,写库成功后返回 `undefined`,调用方(`api/dlna.ts`)按"找不到设备"处置 →
  改名/禁用返回 404。新增 `readDlnaDeviceRow` 辅助,写库后从 DB 读回构造 `DlnaDevice` 返回
  (`dev ?? readDlnaDeviceRow`,缓存命中时短路、无额外 DB 读)。

### 测试

- `backend/tests/dlna/controlRecast.test.ts`:**26 条**(原 24 + 2 覆盖补充 + 1 台账修正),全绿。
  `control.ts` 语句覆盖率 **99.34%**,7(未覆盖行 [642, 643, 1176, 1177, 1178, 1571, 1572])。
- `tsc --noEmit` 通过;dlna 套件 4 轮 shuffle **260 条 × 4 全绿**。

### 纠正缺陷台账误判

- **Dxx-2(`reseekByRecast` `control.ts:1145-1147`)** 原被标成"死代码",重读确认**可达**:
  `castToDevice` 内部在 849/861/867 行有 `shouldAbort()` 检查点,当后续重投推进代际
  (`recastGens` 变大)时,旧重投会在 `castToDevice` 内抛 `SeekSupersededError`,被 1145 的
  `catch` 接住优雅退出;删掉它反而在那种时序下把错误抛给调用方(`seekDevice` 报错)。
  **不动产品代码**,仅把测试台账从"现状断言(死代码)"改为正确契约断言
  (旧重投串行化让位、1145 作为安全网保留)。

### 双向证伪变异(Dxx-1 / Dxx-3 各 1 条,均 KILLED)

- **Dxx-1**:把 `if (opts.timeOffset === undefined)` 改回"无条件删窗" → 重投保护窗测试立即变红
  (设备旧读数 5s 不再被回填成 >=87)。恢复后转绿。
- **Dxx-3**:把 `return dev ?? readDlnaDeviceRow` 改回 `return dev` → DB-only 设备改名测试立即变红
  (返回 undefined)。恢复后转绿。

### 备注

- 1541-1542(换歌删基线)与 618-619(过期 session 清理)仍属未覆盖:前者实际由 `castToDevice:905`
  同步更新 `positionEstimateSong` 兜底、属冗余防御分支,强行覆盖需操纵私有 Map,本轮跳过;
  后者是 `sessions.size>50` 的机会主义清理,低价值,跳过。

## [4.0.55] - 2026-09-28

### 测试

- `backend/tests/dlna/controlRecast.test.ts`(B7 补测):**24 条**,全绿。目标 `src/services/dlna/control.ts` ——
  专啃「SOAP Seek 无效」这条最值钱的产品链路:部分固件(HiVi/MUZO)播实时转码流时
  `GetPositionInfo` 恒回 `RelTime=0`、`Seek(REL_TIME)` **静默失效**(不报错也不跳),
  后端据此**学**出「该设备 seek 不可靠」并改走 `play_index(seek_position)` 语义的**重投流重建**
  (`reseekByRecast`:Stop → SetAVTransportURI(timeOffset=N) → 等可播放 → Play)。
  学习过程必须走满两次观察才落库判定 —— 这条「不许提前降级」的契约此前没有任何用例守着。
- `control.ts` 语句覆盖率 **99.13%**,9 行(未覆盖行号 [618, 619, 1146, 1147, 1148, 1229, 1230, 1541, 1542])。
- `tsc --noEmit` 通过;dlna 套件 4 轮 shuffle **258 条 × 4 全绿**。

### 双向证伪变异:6 条补断言后 6/6 被抓

补测写完**不等于**测住了。第二轮变异跑出 6 条"存活",逐条查下来全是**我的断言口径不对**
(不是变异无效),补强后全部被抓:

- **`waitUntilStopped` 的 1000ms 轮询间隔改成就绪 0ms,照样探 2 次就绿** ——
  数探测次数杀不掉"忙轮询"。补了**墙钟断言**:两次探测之间必须真的退让。
- **`verifySeekLanding` 的 catch 改成 `throw e`,用例照样绿** —— 那条 `void` 派出的协程
  异常无人接收,只有守在 `unhandledRejection` 上才看得见。补了该监听。
- **「暂停冻结」分支、`POSITION_ESTIMATE_MAX_AGE_MS` 重算分支各关掉一条,照样绿** ——
  原因是断言写的是 `frozen + 2` 这种容差,几毫秒的外推被吃掉。改成**精确相等**,
  精确钉住「暂停时长不许算进进度」。
- **`isSeekUnreliable` 的内存优先分支关掉,照样绿** —— 那条分支与它后面的落库查询结果
  恒真,只有**「内存为真、库里为假」**才分得出(运维重置持久化判定之后)。补了该用例。
- **`reseekByRecast` 里 `seekGuards.set` 这一行测了也白测** —— 正常路径上紧接着的
  `castToDevice` 会无条件 `seekGuards.delete`,窗开等于没开;只有让 `castToDevice`
  在删窗**之前**就退出(设备已被禁用),这行才显形。

### 修复

全量回归连跑三轮、红了两轮的**不同**用例,根因是同一类:**断言预算低于被测行为的最坏耗时**。
两处都不是产品缺陷,放宽的都是断言预算,没有动产品侧常量。

- `tests/routes/apiScanRead.test.ts`:`GET /v1/dlna/devices -> 非 5xx` 偶发红
  (`Test timed out in 5000ms`),单独跑该文件 5/5 全绿。根因:这条端点在发现缓存过期时会
  走真实 SSDP 冷扫描(`refreshDevices()` 预算 4000ms,`--reporter=verbose` 实测耗时
  **4003ms**),而 vitest 全局超时 5000ms 只剩 1s 余量,304 个文件一起跑时必然越线。
  本条契约要守的是「不抛 5xx」而非「快」,预算放宽到 20s。
- `tests/plugins/sandbox.test.ts`:`OOM 触顶耗尽 deadline 后重建仍成功` **单独跑就红**
  (32399ms > 自身 30000ms 预算)。用临时诊断脚本分阶段量过:干净进程 **12.7s**
  (load 36ms + leak 触顶与自愈重建 12695ms + ping 2ms),但同文件前面的 leak 用例会在
  **同一个 worker 进程**里留下内存压力(每个循环最多吃到 256MB,堆越满同样的 1MB
  字符串分配越慢),同一场景就此涨到 32.4s。产品侧给 rebuild 的独立预算是
  `REBUILD_TIMEOUT_MS = 30000`,断言预算理应高于它而不是等于它,故提到 60s。
  诊断脚本已删除。

### 已观察(建议后续单开一轮处理,本轮不动)

- OOM 类用例的耗时上限取决于**进程里已堆了多少垃圾**而不是被测代码,属测试隔离问题
  (把 `leak` 系列拆到独立文件即可根治),不是产品缺陷。

### 已知问题(本轮只登记,不改产品行为)

以下三条按「挂起 + 固化」处理:测试里写**现状断言**并标注 `现状记录(缺陷台账 Dxx)`,
本轮不动产品行为。

- **重投自己开的落位保护窗,会被它自己触发的那次投屏立刻清掉**(`control.ts:1141` 开窗 →
  `1143` `castToDevice` → `castToDevice` 在 `914` 无条件 `seekGuards.delete`,本意是"换歌时清窗")。
  重投**不换歌**却同样被清,于是「170s 重投后 STOPPED 样本删锚点 → 进度从头重爬」这条
  真机防线在重投链上等于没有。修复后该断言应改为回填成 `>= 87`。
- **`reseekByRecast` 的「中途被取代」分支不可达**(`control.ts:1145-1147` 是死代码):
  `recastChains` 把同设备的重投排队串行,后到者必须先 `await prevChain`,旧重投还在飞时
  不可能有新的 seek 去推进代际,`recastAborted` 永远为 false、`SeekSupersededError` 永远抛不出。
- **`setDeviceAlias` 对仅存于 DB 的设备写库成功但返回 `undefined`** —— 调用方拿到
  `undefined` 通常按"找不到设备"处置,这条路径上的改名会 404。

### 备注

- 变异脚本新增两项自检:每个变异串**必须恰好命中 1 处**(命中 0 处会假报"存活"),
  以及先跑一次**未变异基线**自证检测器不会把"全绿"误判成"存活"。
  上一轮的检测器正则在全绿时匹配不到任何失败数,把 6 条统统记成了 SURVIVED。

## [4.0.54] - 2026-09-28


### 补齐测试(services/dlna)

**`discovery.ts` 27.0% → 100%**(未覆盖行 119 → 0)。这块是用正则手撸的 UPnP
description 解析器,没有任何外部依赖兜底 —— 改错任何一条都不会报错,只会让部分
DLNA 音箱**静默地从设备列表里消失**:用户看到的是「设备偶发不见了」,日志里什么
都没有,属于最难复现的一类缺陷。

新增 `discoveryDescription.test.ts`(19 条)钉 description.xml 解析契约:相对
controlURL 转绝对地址、多 service 按 serviceType 挑选而不是按位置、缺 AVTransport
判为不可投屏、HTTP 非 2xx 与抓取抛错都返回 null 而不是把整轮扫描带崩、friendlyName /
UDN 的各种兜底。

新增 `discoveryScan.test.ts`(13 条)钉扫描与合并契约:socket 出错必须早退并标记
本轮不可信(否则空集会被当成权威答案,把**全网设备一次性判成离线**)、被动通告与
主动 M-SEARCH 结果合并去重、超过 10 分钟没再听到通告的设备必须剔除、`addMembership`
失败(容器/多网卡下 EADDRNOTAVAIL 是常态)必须被静默吞掉而不是让 SSDP 监听死掉。

**`control.ts` 81.73% → 86.47%**(未覆盖行 189 → 140)。新增
`controlAlignGuard.test.ts`(11 条)钉两条「位置真相」契约:

- `alignDeviceToPosition`(一次性校准 seek):设备没进稳定 PLAYING 前不许 seek、
  进了立刻开校、落位在容差内只发一次、leader 实时目标优先于固定目标、settle 窗
  耗尽仍尽力校准、seek 连续失败只重试不抛出。
- `getDeviceStatus` 里的 seek 保护窗:窗内 STOPPED 不得清基线(240 实锤那条路径)、
  窗过期即视为真停清基线、窗内读到陈旧读数用预期值回填且不被曲长封顶压回、窗外恢复
  采用设备读数。

`announce.ts` 维持 99% 覆盖(余下两行是 500ms 等待,纯 IO 型)。


### 覆盖率数字的陷阱:假 socket 自己就是盲区

`discovery.ts` 最后 1 行未覆盖(`try { sock.addMembership(...) } catch {}`)差点被
「覆盖率 99.4%」蒙混过去 —— 查下去发现**那个 catch 从来没有被执行过**,因为测试里的
假 socket 把 `bind` 写成了单参 `bind(cb)`,而监听端真实调用是 `bind(port, cb)`:
回调在**最后一个参数**,于是监听器的回调被静默丢弃,`addMembership` 一行都跑不到。

覆盖率能到 99.4%,说明「统计口径」没有问题,有问题的是「这一行到底有没有被验证过」。
是变异反证(去掉 catch 后测试竟然还是绿的)把这件事翻出来的。


### 本轮修掉的测试自身缺陷(共 4 条,都不是产品缺陷)

1. **用例间共享可变状态**:`lastAliveEmitAt`(alive 去抖)与 `announced` 都是模块级
   Map,前一个用例用同一 LOCATION 占掉 60s 窗口后,排在后面的用例发 alive 会被直接
   吞掉 —— 表现为「用例顺序一 shuffle 就红」(8 轮里红 4 轮,恰好是 `sequence.shuffle`
   把它排到 alive 用例之后的那些顺序)。修法:每个用例开跑前用官方清理入口
   `clearAliveEmit` 放开窗口,并用一条 byebye 清掉通告登记。
2. **断言依赖绝对时钟(与 v4.0.53 同一根因)**:`markStaleDevices` 边界用例裸写
   `Date.now() - X`,「构造设备」与「判定」之间过去真实毫秒,差 1 毫秒的两条于是随机
   翻红。修法:把造设备**和断言**一起放进冻结时钟 —— 断言必须也在块内,初版把断言留在
   块外,`markStaleDevices` 又跑回真实时钟(12 轮里红 3 次)。
3. **异步协程跨用例污染**:`seekDevice` 会派生 `verifySeekLanding`(sleep 1200ms),
   它「落位不符就重发一次 seek」的那一枪会落进**下一个**用例的调用计数里,seek 次数
   随 shuffle 顺序漂移。修法:让本文件的设备恒不报位置(`NOT_IMPLEMENTED`,即 MUZO
   播转码 chunked 流的真实表现),校验协程随即自行放弃。
4. **测试桩自递归**:覆盖 `soap` 时写了 `soap(a)` 回指刚赋值的那个 lambda,非目标动作
   于是无限自递归。修法:先把基础桩捕获到本地常量。


### 变异反证

10 条变异全部被新断言杀掉:

- discovery:`discovery.ts` 去掉 AVTransport 的 null 兜底 / 相对 controlURL 不转绝对
  / UDN 兜底退化成用 location 当 id / 陈旧通告不剔除 / 过期判定 `>` 改 `>=` / socket
  报错不标记不可信 / 去掉 `addMembership` 的 catch。
- control:align 跳过稳定态等待 / align 单轮异常不再继续重试 / 重投间隙 STOPPED 不清
  基线 / 陈旧读数不再回填。

`discovery.ts` 与 `control.ts` 的新用例改完连跑 12 轮(每轮重新洗牌用例顺序)全绿。

## [4.0.53] - 2026-09-28


### 修复(测试基建:断言不得依赖绝对时钟)

v4.0.52 的 CI 在「类型检查 + 全量测试」上红了两条用例,根因都不是产品缺陷,而是
**断言依赖真实时钟往前走一格** —— 慢机器 / VM 时钟被调整(kvmclock 跳变、NTP 校正)时,
两次读取会落进同一毫秒,`not.toBe` 于是随机翻红。本轮把三条同类断言从根上改写。

- `memoryReclaim.test.ts`(阈值边界用例):原来在真实时钟上拨 `Date.now() - 5*MIN + 1`
  再隔真实毫秒判定 —— 中间过去 ≥1 毫秒就翻成「空闲」。现在把 `Date` 换成假时钟:
  `isIdle()` 只读 `Date.now()`,判定时钟完全静止,「>= 才空闲 / 差 1 毫秒就不算」
  这条边界语义反而被钉得更死,与机器快慢无关。
- `discoveryHost.test.ts`(replaceEntries 刷 updated_at):原来断言「≠ 刷新前的值」,
  等于要求时钟真的走了一格(CI 上两侧同值:2026-09-28T09:29:09.188Z)。现在**钉哨兵 +
  冻时钟** —— 先把 updated_at 写成一个 2000 年的哨兵旧值,再把 Date 冻住:产品照常写
  就写成冻住的 now,漏写则保持哨兵。「有没有写」与「时钟有没有走」彻底脱钩。
- `recommendImportBranches.test.ts`(二次导入刷 updatedAt):同一根因(原来靠
  `await setTimeout(5)` 空等 5 毫秒)。同样改为「钉哨兵 + 冻时钟」,那 5 毫秒空等一并省掉。

范式由此统一:判断「某列有没有被改写」要用**与绝对时钟无关的哨兵比对**,而不是「前后两个
时间戳不相等」。`playlistsRoutesContract` 那条本来就是这么写的,现已作为参照。


### 变异反证(断言没有被绕过)

改完必须自证,否则只是把断言绕开:

- `isIdle()` 的 `>=` 改成 `>` → 2 条立刻翻红。
- `discovery.ts` 里三处 updated_at 写入(main UPDATE / `refreshPluginPlaylistCounts` /
  cover 兜底)全删 → 1 条翻红。
- `recommendImport.ts` 与 `shared.ts` 里的 updated_at 写入全删 → 1 条翻红。

期间还识别出两条**等价变异**并记账:只删掉 `recommendImport` 中 existing 分支那一条
updatedAt 写入时用例不红 —— `replacePlaylistSongs` 末尾的 `refreshPlaylistCounts()`
已经把 updated_at 刷回去了;discovery 侧同理(去掉前两处仍有第三处兜底)。
两者都不是测试缺口,不计为漏测。

回归:类型检查通过;全量 300 文件 / 4480 条全绿;满载(6 路并发占满核)连跑 3 轮共 18 次,
每次都是 170 条全绿、退出码全 0。

## [4.0.52] - 2026-09-28

### 测试

- `backend/tests/airplay/controlOrchestration.test.ts`(B31 补测):**107 条**。目标 `src/services/airplay/control.ts` —— 按「未覆盖行数 × 可测性」联合排序选中,是最后一块整文件未覆盖的服务层文件。分会话生命周期、起播编排、收尾 finalizer、设备持久化、暂停/恢复/停止、seek、音量与静音、状态读取、服务开关九个分组。
- `control.ts` 覆盖率(全量口径):**语句 100% / 行 100% / 函数 100% / 分支 96.96%**,唯一未覆盖分支落在第 28 行的 re-export 上。
- `tsc --noEmit` 通过;全量回归 **300 个文件 / 4480 条全绿**。

### 双向证伪变异(73 条,68 条被抓住)

把 `control.ts` 的 73 条契约逐个改坏后重跑本文件。首轮 53 条立即转红、**20 条存活**;
逐条归因后补掉 15 条真实测试缺口,复跑 15/15 全部转红;剩下 5 条判为等价变异或死代码。
首轮存活暴露出的测试缺口(补断言后均已钉住):

- **`stopSession` 没断言「解码器被 kill」** —— 只看了会话表移除与 `player.stop()`。
- **握手失败分支断言的是「上一次成功那一个」player** —— `startSession` 开头就会 `stopSession` 掉旧会话,
  旧 player 的 `stop` 因此早已被调用,「失败分支自己收没收干净」整条契约被彻底盖住。
- **`finalizer` 不 kill 解码器**同样漏了断言(整首播完之后 ffmpeg 会一直烧 CPU)。
- **seek 的负数夹取只测了结果、没测喂给下游的值** —— 这个值一路喂给 `prepareSeek` 与新 ffmpeg 的 `-ss`。
- **fork 下「原地 seek 成功」只断言 seek rpc 打没打出去** —— 把 `if (inPlace) return` 去掉之后
  seek 和 cast 两个 rpc 都会发出去,断言照样绿。
- **「seek 提前掐断管道」只断言 `kill`** —— 旧 finalizer 的 seekReplace 分支也会 kill 同一把解码器句柄,
  真正只有 `seekAirPlay` 会做的是 `destroy` 管道(旧 producer 就靠这一步解除 `waitData` 阻塞)。
- **seek 重建解码器后喂进去的不是合规后的地址** —— 旧 token 可能过期,必须先 `resolvePipelineInput` 重解。
- **seek 复原暂停态只断言 `toHaveBeenCalled()`** —— 暂停期间 `isPaused` 本就是 true,少调那一次
  状态查询照样给出 PAUSED;改成「恰好两次」才抓得住。
- **`hasActiveSession` 的 fork 分支从未被执行过** —— fork 判活必须只读子进程镜像,
  主进程自己的会话表不算数(本轮新增用例的两条断言就是钉这条的)。
- **`stopAirPlaySessionsForHost` 的 host 判空只测了 `""`** —— 只有传 `undefined` 才会撞上
  `host.toLowerCase()` 抛异常,这条变异在 `""` 下是等价的。
- **大小写不敏感那个用例两边都是小写 IP** —— 大小写敏感与不敏感跑出来完全一样。
- **音量/静音的 DLNA 转发只断言「转发被调用」** —— 转发成功后漏掉那句 `return` 时,会多走一步
  `applyVolumeDb` 把音量覆盖成 SET_PARAMETER 的值;只有会话在场时才看得见。
- **`dlnaPeerOfAirPlay` 的两条判据要特定场景才杀得掉** —— 「不判 host」得配一个解析出空主机名的
  `file:///dev` 设备才能暴露;「非法 URL 也放行」得让非法 URL 与**别的主机**同时出现:
  配对错误比不配对更糟 —— 后者是「没调成」,前者是「调到了不该调的地方」。

### 已知问题(本轮只登记,不改产品行为)

- `D31-3`:`control.ts` 里的 `markAirPlayDeviceOfflineInDb()` 是**死代码** —— 整个 `src/` 只有它的定义,
  既没有调用点也没有导出(grep 已确认)。本轮不为死代码补测试,只在变异阶段记录。
- 20 条存活变异里另外 4 条(`M14` `M18` `M22` `M63`)经分析是**等价变异**,不是测试缺口:
  任何测试都无法把它们与正确实现区分开,理由已写在测试文件对应用例的注释里。

## [4.0.51] - 2026-09-28

### 测试

- `backend/tests/dlna/controlSoap.test.ts`(B30 补测):**70 条**。目标 `src/services/dlna/control.ts` —— 按「未覆盖行数 × 可测性」联合排序选中(未覆盖行数全场第一,但未覆盖行里 dlna/upnp/fetch 等 IO 关键字只占 6.9%,是「缺口最大但最好啃」的一个)。
  `control.ts` 里对设备的每一次调用最终都收口到 `soapCall() → 全局 fetch`,所以只要用一个「按 SOAPAction 分发」的 fetch 桩,就能在不碰真网络的前提下跑通整条控制链路 —— 起播四步、就绪闸门、无缝隙预载、TTS 播报、播放三件套、音量与静音、seek、状态采样与位置外推。
- `control.ts` 未覆盖行数(全量口径)**172**;同一 `tests/dlna` 口径做前后对比,本文件单独贡献 **684 → 189** 行。
- `tsc --noEmit` 通过;全量回归 **299 个文件 / 4373 条全绿**。

### 双向证伪变异(20 条,19 条被抓住)

把 `control.ts` 的 20 条契约逐个改坏后重跑本文件,19 条立即让测试转红。首轮存活 9 条,
补强断言后收敛到 1 条。本轮补掉的真实测试缺口:

- **`soapCall` 的 UPnP fault 判据只覆盖了「fetch 直接抛错」那一条路** —— HTTP 200 + 错误体
  (`<s:Fault>` 包壳 / `<errorCode>` 字段)这一路从未被执行过。现在两条判据分别单独立例。
- **`shouldAbort` 在 `castToDevice` 里被查三次**,原先只测了第一处:变异把第一处改掉时,
  第二三处照样抛错,测试照样绿。改用「第 N 次调用才返回 true」的谓词逐一点名。
- **落位校验是 `void verifySeekLanding(...)` 派出的异步协程(内含 `sleep(1200)`)**,
  原先三条相关断言都跑在协程之前就执行完了,等于什么都没测。补了显式等待窗口。
- **探测缓存只测了「支持」那条结论**:`!== undefined` 的缓存语义对「不支持」同样生效,
  补了反向用例;被拒之后的预载也必须彻底关闭,补了「重复调用不再下发第二次」。
- **`SetMute` 的 catch 吞掉异常时「音量没被改」依然成立**,补了显式的 rejection 断言。

### 已知问题(本轮只登记,不改产品行为)

- 20 条变异里唯一存活的 `M14`(`relTime !== "NOT_IMPLEMENTED"` 判据)经分析是**等价变异**,
  不是测试缺口:`parseHms("NOT_IMPLEMENTED")` 返回 0,而 `state.position` 每次调用都从 0 重建,
  「赋 0」与「跳过赋值」在当前代码结构下不可区分 —— 任何测试都无法区分这两者。
  真要让它可测,得先把 `getDeviceStatus` 的返回态改成跨调用复用,属行为改动,本轮不做。

## [4.0.50] - 2026-09-28

### 测试

- 新增 `backend/tests/plugins/discoveryHost.test.ts`(B29 轮):**100 条用例**,把
  `src/plugins/discovery.ts` 从「只有纯函数被单测」扩到整个插件 host 环境面 ——
  http 的 20MB 体积护栏 / songs 脱敏与分词搜索 / playlists 读写与封面兜底 /
  fs 路径穿越 / command 走 execFile 不经 shell / net 与 ws 本机回环 /
  jsenv 嵌套 QuickJS / manifest 必填字段与 longRunning 预算 / 权限自动补齐 /
  reload 覆盖语义 / 重复 discover 不重复注册。
- **双向证伪**:对 `discovery.ts` 打 **15 个变异点**(放开 20MB 阈值、去掉 content-length
  护栏、exec 退回走 shell、去掉路径越界判断、拿掉 base64 编码、同名复用塞假 pid……),
  **15/15 全部被测试杀掉,0 存活**。
- `discovery.ts` 未覆盖行数 **156 → 47**(76.72% → 约 91%);剩余缺口集中在在线补全(IO 型)。
- `tsc --noEmit` 干净;全量回归 298 文件 / 4282 用例全绿。

### 已知问题(本轮只登记,不改产品行为)

详见 `docs/KNOWN_ISSUES.md`,每条都在测试里固化了**现状断言**(修复后该断言应转红):

- **MF-002** `host.net` 注释声称「数据以 base64 传输(二进制安全)」,实际发送端
  `Buffer.from(String(data))` 做一次 utf8 编码、接收端 `msg.toString("base64")` 再编一层。
  纯 ASCII / UTF-8 文本往返确实无损,但插件按注释「用 base64 传二进制」会拿到双层编码的
  文本,非 UTF8 字节则被 utf8 重编码成乱码(mojibake),永久损坏。
- **MF-003** `host.playlists.replaceEntries` 刷新歌单时只从已有行取 `name`,
  `source_platform` / `source_url` / `external_id` 在 UPDATE 里被无条件写回默认值 ——
  前端平台徽标掉成默认、`findBySource` 去重键被清空,同一个远端歌单会重复建。
- **MF-004** `host.command.start` 同名复用分支 `return { name, running: true }` 
  不带 `pid`,调用方无从区分「新起进程」与「复用旧进程」。

## [4.0.49] - 2026-09-28


### 修复

- **MF-001（`src/plugins/sandbox.ts`）：并发调用触发插件沙箱 OOM 自愈时，QuickJS
  teardown 断言 `list_empty(&rt->gc_obj_list)` 直接 SIGABRT 带走整个进程。
  这是 v4.0.48 记录的「偶发」的真身 —— 它从来不是偶发，**必现（5/5）**，
  只是触发条件苛刻：必须**并发**两个调用同时/相继触顶内存上限。

  根因是四层的：`dispose()` 是**同步**的，而 `evalAsync` 的 `promiseHandle` 在其
  `finally`（**异步**）里释放。单发 OOM 时触发方已经 return、句柄已放，teardown 干净；
  并发时另一条仍在途，同步 teardown 会撞上它钉住的 GC 对象。关键证据是插桩时
  `hasPendingJob()` 已经是 `false` —— 残留的**不是 pending job**，
  所以 v4.0.3 那套「排空 pending jobs」救不了它。

  三处加固：`rebuild()` 的 `dispose()` 之前 `await settleHandlers()`（8 个
  `setImmediate`，给所有在途 `finally` 留出释放时间，**真正消除 abort 的那一条**）；
  `dispose()` 里 `oomCleanup` 去掉 `oomFaulty` 守卫改为无条件先排空；
  `evalAsync` 泵循环在沙箱进入 `rebuilding`/`disposed` 时立刻放手。
  中间试过「`oomFaulty` 消费式清零」与「按 `activeCalls` 计数等待」两版，**实测都无效**
  —— rebuild 触发时发起方那条调用自己早已结算并注销了 `activeCalls`，该等的是
  「还有多少 `evalAsync` 的 `finally` 没跑完」，不是「`activeCalls` 是否为空」。

- **影响面**：并发调用一个泄漏插件时，沙箱自愈路径会把宿主进程一起带走，属**进程级**
  故障而非单次调用失败。插件沙箱本身跑在 worker thread
  （见 `docs/PLUGIN_ARCHITECTURE.md`），生产上的实际降级表现为 worker 崩溃，
  是否波及主进程待线上观察确认。


### 测试

- `tests/plugins/sandbox.test.ts` 新增 1 条：`并发 OOM 自愈：SIGABRT 防线`，
  并发发起两个 `leak()`。修复前该用例转红并 abort（**双向证伪通过**），修复后转绿。
- 探针统计：修复前 5 轮 5 次 abort，修复后 5 轮 0 abort；
  基线模式（单发 OOM / 反复 OOM / 重复 dispose）均无退化。
- 全量回归 **297 文件 / 4201 用例**全绿，`tsc --noEmit` 干净。

- **遗留（不追）**：全量里另有 3 次**确定性** abort，但不在 OOM 路径
  （`加载失败后仍可继续加载其他插件(模块不毒化)`、`SANDBOX_WORKER_DISABLE=1 时回退主线程` ×2），
  且 WASM 层 SIGABRT 之后 **worker 存活、用例通过、退出码 0**。
  试过「dispose 时释放 `this.shared` 里的 `ctx.null`/`hTrue`/`hFalse`」，
  专项连跑 3 轮 abort 数纹丝不动，故该改动已回滚、不留代码。
  已记入 `docs/KNOWN_ISSUES.md` MF-001 遗留观察②。


### 新增文档

- `docs/KNOWN_ISSUES.md`：项目级**已知问题台账**，登记工程/运行时类缺陷
  （UI/UX 类见仓库根 `AUDIT.md`）。首批登记 MF-001 的完整根因链、修复与验证。
## [4.0.48] - 2026-09-28

### 测试

- **补测第十五轮（B28：新增 3 个测试文件 / +59 用例）**，双向证伪 17 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- `src/services/source/online/streamFallback.ts`（行 88.36% → **98.74%**，函数 100%）：
  这个文件决定了「一首 web 歌的直链挂了之后，还能不能换到别的平台」。本轮钉的是
  **三道结构性短路与缓存收尾**：正/负缓存命中必须零搜索、缺标题/总开关关/解析不出
  provider 三处判死的口径（总开关关时**不写**负缓存，否则开关一开仍被误判没源）、
  全候选不可播时 `transient` 与 `unplayable` 的分岔（只有 `sawTransient` 这一个比特
  在区分「上游挂了」和「这首歌没有源」）、`clearFallbackCache` 定向清与全清的边界
  （前者只清换源记忆、后者连可播记忆一起清）、两个 FIFO 上限（2000 / 5000）必须真的生效。

- `src/services/sendspin/handshake.ts`（缺口 28 → **6**，行 98.37%）、
  `src/services/sendspin/supervisor.ts`（缺口 24 → **2**，行 96.08%）：
  见两文件的提交说明。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `source/online/streamFallback.ts` | 行 88.36% → **98.74%** | 函数 100%，止于 2 处死 catch |
| `sendspin/handshake.ts` | 缺口 28 → **6** | 行 98.37% |
| `sendspin/supervisor.ts` | 缺口 24 → **2** | 行 96.08% |

- 本轮自身新增覆盖约 **102 行**；总体 `未覆盖 8030 / 65406 行（87.72%）`。
- 全量回归 `297 个测试文件 / 4200 用例` 全绿，`tsc --noEmit` 0 错误。

- **两条不可证伪，已写明原因而非含糊放过**：`recheckOnlineDirect`(309-310) 与
  `resolvePreferredStreamUrl`(514-515) 的 catch 包着的都是全函数（probe /
  resolvePreferredSong 各自还有一层同款 try），构造上抛不出来。不编假异常刷行覆盖率，
  改为在测试里把「上游不抛」本身钉成断言并留档。

- **两条等价变异已剔除并留档**：`464` 行写回条件里的「≠ 原 URL」判断（去掉后写的仍是
  同一个值，库里逐字节不变）、`defaultStreamProviderId` 行无 pluginEntry 时的启用源插件
  扫描（结果会被 `resolveStreamProvider` 的兜底分支立刻重算，对外 URL 一字不差）。

- **发现（`tests/plugins/sandbox.test.ts`，未改动）**：quickjs 沙箱 OOM 自愈用例偶发
  `Assertion failed: list_empty(&rt->gc_obj_list)`，会直接 abort worker 让整轮全量拿不到
  汇总行。单跑三次挂一次、与被测改动无关（本轮两次全量，一次全绿一次被它带崩）。
  看起来像沙箱在内存压力下 `free` 时的引用计数漏检，属既有问题，留档待议。

## [4.0.47] - 2026-09-28

### 测试

- **补测第十四轮（B26：新增 2 个测试文件 / +36 用例）**，双向证伪 20 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- 本轮改挑「**未覆盖部分全是降级 / 回退 / 兜底路径**」的小文件簇，而不是继续啃
  `streamEngine.ts`（余下 45 行全在 `GroupPump.pushLoop` 内部，要真泵 + 真 WAV 才驱动得动）。
  这类分支正常环境永远走不到，只有「库坏了 / 设备禁用了 / 已被拒绝过 / 浏览器构造失败」
  才生效 —— 最容易被写成「看起来对、真出事时是错的」。

- `src/services/sendspin/discover.ts`（缺口 30 → **0**，行/语句/函数 100%）：
  文件头记着 2026-09-25 真机定位的两个致命缺陷，本文件即修法，现逐条钉住：

  - **发现即写**：设备开机那一瞬（IP 刚拿到、:8928 还没 listen）拨号必然 `EHOSTUNREACH`，
    以前却在「拨成功之后」才记忆 ⇒ 一次失败 = 永久失联（实测 `.245` 开机后 38 分钟无人理它）。
  - **库级永久装聋**：bonjour-service 的 PTR 查询只发一次、`_services` 只增不减、对已知 fqdn
    永久去重，而 ESPHome 设备开机只广播一次 ⇒ 必须自己**周期重建 browser** 造节拍，并提供
    `refreshPlayerDiscoveryNow` 让音流的等待阶段能主动催一次（含 5s 节流）。
  - 重建期间的**迟到回调必须丢弃**（它属于上一个 browser 实例）；四道闸门（端口合法性 /
    已禁用 / 抑制期 / 已在线）逐条验证；入册失败只记 warn、**不冒泡**；`pickIPv4` 的两轮
    扫描顺序（IPv4 字面量优先于排在它前面的主机名）。

- `src/services/airplay/session.ts`（缺口 19 → **0**，行/语句/函数/分支全 100%）：
  注册表**必须**落 SQLite（fork 模式下 token 在主进程 mint、子进程经回环 URL 消费，内存 Map
  跨进程不可见 —— 2026-09-19 事故的同一条教训）；但「必须落库」不等于「库不可用时投屏整体
  失败」。两套状态并存且解析时**先内存后库**，故由单测把库打坏来验证：内存复用与续期、
  过期返回 null、库里已有会话复用（每次投流 mint 新 token 会让设备侧 mediaUri 变化 → 被
  误判成换歌而自动切下一首）、过期行**先删再返回**、库查询抛错吞掉不甩给投屏链路。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/discover.ts` | 30 → **0** | 行/语句/函数 100% |
| `airplay/session.ts` | 19 → **0** | 行/语句/函数/分支 100% |

- 本轮自身覆盖 **49 行**；总体 `未覆盖 4100 → 4103`（87.46% → 87.45%）—— 净变化被
  `dlna/discovery.ts` 的 **+48 行回落**抵消，见下方说明，**不是代码回退**。
- 用例总数 4053 → **4089**（292 个测试文件），全量回归全绿，`tsc --noEmit` 0 错误。

- **发现（未改动，留档）**：`dlna/discovery.ts` 的 `toAbsolute` / `fetchDescription`
  （41–88 等 48 行）只有在**真实局域网 DLNA 设备响应 SSDP** 时才会被执行 —— 本轮两次全量
  覆盖率结果完全一致（62），而此前四轮稳定在 14，差异来自该设备（HiVi，192.168.10.30）
  当前不可达。即：**本地覆盖率数字里约 48 行由真机撑着，CI（无 DLNA 设备）根本不会有**，
  本地与 CI 的覆盖率不可直接比较。是否要把这条路径改成密闭桩（本地 HTTP server 喂
  description.xml）另议，本轮未动。

- 证伪的 20 项分支：browser 的周期重建与停止、主动催的未启动 / 节流两道、`Browser` 构造失败
  留痕、迟到回调丢弃、`pickIPv4` 两轮扫描、四道拨号闸门、入册来源与「已有窗口不重置」、
  入册失败留 warn、内存回退的登记与复用、DB 会话复用、过期判定与过期行删除、库查询抛错兜底。

- **两条不可证伪，已写明原因而非含糊放过**：过期内存 token 的 `delete` 是纯回收（同一分支已
  判过 `expiresAt`，键此后不可能再被命中）⇒ 等价变异；`D2 / D6` 首版是**弱断言导致的假绿**
  —— 前序用例在假时钟下把 `lastOpenAt` 留在「未来」，相对推进几秒追不上，会被节流分支先挡下；
  两轮扫描需 IPv4 排在主机名之后才区分得出。均改成能真正区分的形状后重验通过。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.46] - 2026-09-28

### 测试

- **补测第十三轮（B25：新增 1 个测试文件 / +19 用例）**，双向证伪 22 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- `src/services/sendspin/playerCore.ts`（缺口 47 → **0**，421 行全覆盖）：
  既有 `pumpHandover.test.ts` 是**集成式**的（真起 server + 真泵 + 真 WAV），够得到
  `handoverCore` 本体，却够不到下面这几块 —— 它们全是「登记 / 消费 / 回退 / 还原」这类
  **一次性状态机**分支。新增 `playerCoreUnits.test.ts`，把 `streamEngine`（泵四件套）、
  `deviceState`（落库）、logger 全部换成受控替身，不碰真实 server：

  - **借流登记的一次性与 TTL**：武装 → 起播之间隔一次调用，登记必须**一次性作废**，且
    15s TTL 过期即作废 —— 否则一次失败的武装会污染很久以后的同目标起播，把一条不属于
    本次的流搬过去（落点 / 归属全错）。
  - **歌不同必须在登记层就放弃**：不能指望移交层兜 —— 那层比的是「源端此刻在播什么」，
    源端若也换成本次要播的这首歌就会放行。用例刻意把两层的判定结论做成**相反**，使「登记层
    放弃」与「移交层放行」在行为层可区分。
  - **移交失败一律静默回退完整起播**：只打日志、不抛 —— 否则流转播放断在半路。
  - **起播 / 播报失败后的现场还原**：用户组后台起播失败要清组当前曲并回调上抛（不 throw，
    不阻塞调用方）；播报失败要把临时改过的连接音量 / 组音量还原，并**补发一次音量命令** ——
    还原是绕过 `setVolumeCore` 的直接赋值，不补发设备就永远停在播报音量上。
  - `seekCore` 三条走向：空闲（无在播）只记忆起播位置；**起播窗口内绝不起第二个 play**
    （两个 play 会各自 `++epoch` 后互掐对方刚建好的窗口，存活者拿到零输出窗口被当成播完
    → IDLE → stalled → 从 0 重投）；`ug:` 前缀走用户组完整起播。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/playerCore.ts` | 47 → **0** | 421 行全覆盖 |

- 总体行覆盖率 **87.33% → 87.46%**（未覆盖 4145 → 4100 行，本轮吃掉 45 行）。
- 用例总数 4034 → **4053**（290 个测试文件），全量回归全绿，`tsc --noEmit` 0 错误。

- 证伪的 22 项分支：`ephemeralGroup` 缓存与缺省字段、借流登记的一次性作废与 TTL、歌不同的
  登记层放弃、`playCore` / `playGroupCore` 借流成功的早返回、两处借流放弃日志、用户组成员
  按在线连接过滤、用户组后台起播失败清状态与回调上抛、`stopCore` 停泵与位置归零、
  `seekCore` 空闲 / 起播窗口 / `ug:` 三条走向与无 server 时夹 0、播报失败还原连接音量与组
  音量、补发音量命令、原样上抛。

- **两条不可证伪，已写明原因而非含糊放过**：`stopCore` 的那条 else 兜底（`srv` 为空时
  `srv?.clients` 直接短路、非空时 `group()` 恒返回组 ⇒ 无副作用，断言咬不住）；E5 首版是
  **等价变异**（`handoverCore` 自身也判歌），已改成在行为层可区分的形状重验通过。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.45] - 2026-09-28

### 测试

- **补测第十二轮（B24：新增 1 个测试文件 / +44 用例）**，双向证伪 23 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- `src/services/sendspin/protocolPlayer.ts`（缺口 176 → **0**，266 行全覆盖，行/语句/函数 100%）：
  既有 `protocolPlayer.test.ts` 是**集成式**的（真起 sendspin server），只够得到 in-proc 主路径，
  **fork 模式 / 用户组 player / resume 冷起播三块一行没覆盖**。新增 `protocolPlayerUnits.test.ts`，
  把 index.js、playerCore、supervisor、GroupManager、QueueController 全部换成受控替身，专攻这三块 ——
  而它们恰好是注释里记着三次真机事故的地方：

  - **2026-09-17「点播放没声音」**：`resume()` 只调 `pump.resume()`，没走 `playMedia` ⇒ 没有
    `stream/start`、没有 pump、全链路静默（对照 DLNA：它的 resume 就是 `playDevice()` = 真起播，
    所以 DLNA 从未暴露这个缺口）。现由「冷起播必须走 playMedia」钉死，**in-proc / 用户组 / fork
    三种入口各一条**，另加两条兜底：`pumpActive` 探测本身失败时按「不在推流」处理、队列无当前曲
    时留痕放弃而不是硬闯。
  - **2026-09-21 子进程心跳停摆 95s**：`pollState` 把「探不到」谎报成 IDLE，凭空造出
    PLAYING→IDLE 迁移 ⇒ tracker 判自然结束 ⇒ 位置归零、曲目乱跳。现由「必须标 `unavailable`」
    钉死（**用户组 / proxy 各一条**）—— 标记后由 QueueController 决定不喂 tracker、不计数。
  - **起播上报必须走 `setTimeout(0)`**：同步上报会被 `resetTracker` 清掉 lastPlaying ⇒ 短于轮询
    间隔的曲目永远触发不了自然结束、队列卡死。现断言「同步阶段未上报、宏任务之后才上报」。

- 顺带钉住的判定口径：在线与否一律按**连接派生**判定（client 不在列表 / `ready === false` 即不可用，
  此时 cast 会投进 ephemeral 组——没声音却显示“在播”，是最坏的一种错）；组成员按 `ready` 过滤；
  命名空间写法与裸写法都认作 sendspin、dlna 成员一律排除；组音量先落 `player_groups`（无成员也持久）
  再下发，且**落库失败不挡下发**；起播前先灌持久音量（否则起播瞬间跳回缺省 100）。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/protocolPlayer.ts` | 176 → **0** | 266 行全覆盖；行/语句/函数 100% |

- 总体行覆盖率 **86.81% → 87.33%**（未覆盖 4314 → 4145 行，本轮吃掉 169 行）。
- 用例总数 3990 → **4034**（289 个测试文件），全量回归全绿，`tsc --noEmit` 0 错误。

- 证伪的 23 项分支：模式分派、单设备在线判定、组成员 ready 过滤、组不存在 / 无 sendspin 成员 /
  前端未起三种空返回、无在线成员拦截、起播前灌持久音量、回填失败不挡起播、resume 探测 pump、
  stop / pause 的 opcode、组音量落库失败不挡下发、isAvailable 探测失败回落、组与 proxy 两处
  `unavailable` 标记、组 seek 边界日志、proxy seek 失败留 warn 并抛出、in-proc 冷起播、
  冷起播补全元数据、无当前曲留痕、起播上报 duration。

- **证伪脚本新增多行锚点支持**：`unavailable = true;` 这类短句在组 player 与 proxy 各出现一次，
  单行 stripped 匹配必然撞车 —— 改为按**连续行块**定位，命中次数仍必须恰好为 1。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.44] - 2026-09-28

### 修复

- **D35：ffmpeg 二进制定位三处实现、两种口径 —— AirPlay 侧忽略 `FFMPEG_PATH`（P3，已修）**。
  全仓原本有 3 处 ffmpeg 定位实现：`transcode.ts` `resolveFfmpeg()`、`sendspin/encoding.ts` `ffmpegBin()`、
  `airplay/decoder.ts` `ffmpegBin()`。前两处口径一致（FFMPEG_PATH → ffmpeg-static → PATH），
  **唯独 `airplay/decoder.ts` 是反的**：先 `require("ffmpeg-static")`，取到就直接 return，
  `FFMPEG_PATH` 只在内置取不到时才兜底 —— 且与它自己文件头注释写的顺序相反。

- 后果：运维注入 `FFMPEG_PATH` 后，转码 / Sendspin / 离线测量三条链路都换成注入的 ffmpeg，
  **唯独 AirPlay 投播仍走内置 ffmpeg-static**。而 `dlna/control.ts:644` 的注释指出 ffmpeg-static 是
  **glibc 静态构建，在 Alpine（musl）容器里 NSS/DNS 不可用** —— 也就是说「用环境变量换掉静态构建」
  这个逃生舱，在最需要它的 AirPlay 路径上不生效。

- 修法：删掉 `sendspin/encoding.ts` 与 `airplay/decoder.ts` 里各自重复的 `ffmpegBin()`，连同
  `sendspin/streamSource.ts` 的调用一并改为 import `transcode.ts` 已导出的 `resolveFfmpeg()`，
  口径统一为 **FFMPEG_PATH → ffmpeg-static → PATH**。`decoder.ts` 里只服务于该函数的 `createRequire`
  一并删除（`encoding.ts` 的保留，`@discordjs/opus` 还在用）。**行为变更**：AirPlay 在注入
  `FFMPEG_PATH` 时会从内置切到注入版本（这正是本缺陷要的效果）；未注入时行为不变。

- 统一后由三处用例共同钉住同一份实现（`tests/airplay/decoderProducer.test.ts` /
  `tests/sendspin/encoding.test.ts` / `tests/services/transcode.test.ts`）：改一处，三条链路同时转红。
  双向证伪新增 T1（`FFMPEG_PATH` 不再优先）/ T2（PATH 兜底名被改写）两处变异，均被咬住。

### 测试

- **补测第十一轮（B23：新增 2 个测试文件 + 扩写 1 个，+71 用例）**，双向证伪 20 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。本轮按「逻辑型优先、IO 型降级」挑的两个目标都是
  **纯编码/缓冲逻辑，无网络** —— 而且正是 2026-09-17 三次无声事故的核心代码：

- `src/services/airplay/decoder.ts`（缺口 39 → **0**，行/语句/函数 100%，分支 93.33%）：新增
  `decoderProducer.test.ts`，覆盖此前**一行没测**的 `makeProducer` —— 有界 PCM 环形队列这一层。
  钉住：预填充没攒够时首拉**不返回**（只来一点点数据就立刻吐 chunk 会把发送端饿到，直接表现为卡顿/无声）、
  缓冲到高水位 pause ffmpeg stdout、掉到低水位 resume（背压不丢数据、不跳音频）、预填充 30s
  等不到就放弃且不无限挂住、拉空后再来数据要等一轮而不是立刻返回 null、大块缓冲的压实、
  流结束后把尾部残余吐干净、end 之后 done 闩住。

- `src/services/sendspin/encoding.ts`（缺口 167 → **38**，行 94.20%）：新增 `encodingFrameSplit.test.ts`
  （34 例），**按 RFC 9639 手工位流造真实 FLAC 帧**（不是拿固件糊弄），把 2026-09-17 的决策性分支
  逐条钉死：声道码必须按 4bit 取（按 3bit 截会把立体声读成单声道 —— 那次最致命的一条）、残差方法 2
  （保留值）整帧判废、联合立体声按 2 子帧算、首分区要减掉预测阶数、wasted 吃光位深判废、
  容器头偏移量回填、`codec_header` 置 last-metadata 位、元数据块遍历在 last 处收尾。
  另补 `OpusEncoder`（此前一行没测），`encoding.test.ts` 15 → 33 例。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `airplay/decoder.ts` | 39 → **0** | 行/语句/函数 100%；分支 93.33% |
| `sendspin/encoding.ts` | 167 → **38** | 行 94.20%；剩余为常量与兜底分支 |

- 总体行覆盖率 **86.29% → 86.81%**（未覆盖 4487 → 4314 行，本轮吃掉 173 行）。

- 证伪的 11 项 decoder.ts 分支：音量钳制、0 档静音、通道开关、ffmpeg 非零退出留日志、背压水位、
  低水位 resume、预填充循环、预填充超时返回 null、尾部残余吐出。
- 证伪的 11 项 encoding.ts 分支：首分区减预测阶数、残差方法 2 判废、联合立体声子帧数、声道码 0
  取流缺省、wasted 判废、声道码 4bit、容器头偏移、`codec_header` last 位、元数据块 last 收尾。

- **识别出 4 处不可证伪的变异并说明原因**（不是含糊放过）：A6 是等价变异（`>=` 与 `>` 在该处
  产出同一个 chunk）；E2 是不可达分支（`n < 0`，`firstPartition` 上一行已判过、`perPartition` 是右移
  恒非负，属防御性冗余）；E3 / E4 是我误记的锚点（一处漏了行尾注释、一处源码里根本没有该分支），
  已从证伪集剔除并注明。

## [4.0.43] - 2026-09-27

### 测试

- **补测第十轮（B22：扩写 2 个已有测试文件 / +40 用例，合计 43 例）**，双向证伪 23 处定向变异（10 处 control.ts +
  13 处 deviceState.ts）全部咬住，摘掉被测分支后对应用例立刻变红，恢复后转绿。本轮两个目标都是 Sendspin 的
  「控制面 / 持久化面」—— 播控指令与实际设备状态都经这两处落地：

- `src/services/sendspin/control.ts`（缺口 39 → **0**，行/语句/函数 100%，分支 96.96%）：原文件只有 53 行 3 例，
  只测了 `listSendspinPlayers`，真正掷出声音的 `castSendspin` / `controlSendspin` **一行没覆盖**。补齐后钉住：
  服务未启动时先拉起、曲库查不到直接拦、空标题兜成「未知」、空合作者/封面/时长一律不喂给播放器（脏 duration 不转数字）、
  `mime` 固定 `audio/mpeg`、取不到 player 时不硬闯、`play` 落到 `resume` 而非 `stop`、`seek` 缺省按 0 计、
  未支持的 action 显式抛错（而不是静默返回 null）。

- `src/services/sendspin/deviceState.ts`（缺口 30 → **0**，行/语句/函数 100%）：新增一整组 12 例，钉住模块顶部那句约定
  「读失败一律回退（无行 / null），绝不阻断播控热路径」。把 `sqlite.prepare` 整个打成抛错，逼所有 catch 走一遍，
  确认：读音量失败回 null 且留 warn、列禁用设备失败回空数组、删除设备行的失败不影响后续清理、清改名/隐藏偏好的那一步
  炸了也不能回滚已经删掉的设备行、写失败留下的 warn 带 `[device-state]` 标识（区分「写」与「读」两类失败）、
  读禁用态失败按「未禁用」回落、读凭据失败回空凭据、查禁用 host 失败按放行回落。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/control.ts` | 39 → **0** | 行/语句/函数 100%；分支 96.96% |
| `sendspin/deviceState.ts` | 30 → **0** | 行/语句/函数 100% |

- 证伪的 10 项 control.ts 分支：服务未启动是否拉起、曲库查不到是否拦截、空标题兜底、mime 是否固定、duration 是否做类型
  判定、两处 player 取用是否拦住、`play` 的分派目标、seek 缺省值、未支持 action 是否抛错。
- 证伪的 13 项 deviceState.ts 分支：读音量失败回退、读失败留 warn、列禁用失败回退、列禁用失败留 warn、删行失败留 warn、
  清偏好失败的 warn 标识、读禁用态回退、写音量失败留 warn、读凭据失败回退、查禁用 host 失败回退、写 host 失败留 warn、
  写 ESPHome 失败留 warn、写禁用态失败留 warn。

- `deviceState.ts` 剩余未覆盖分支集中在持久化失败的 catch 侧（65.34% 分支），均已被上面 12 例按「回落 + 留 warn」逐个钉死，
  属 catch 内部的分支差分，非真实缺口。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.42] - 2026-09-27

### 测试

- **补测第九轮（B21：2 个新测试文件 / 56 个新用例）**，双向证伪 23 处定向变异（10 处 childHost + 13 处 reclaim）全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。本轮两个目标都属于「平时不出声、出声就说明有东西坏了」：

- `src/services/rendererHost/childHost.ts`（缺口 24 → **0**，行/语句/函数 100%，分支 92.1%）：
  子进程侧常驻控制器，用 in-proc 驱动同一套 handler（不真 fork），保证测试路径 = 生产路径。钉住：
  快照节流（业务状态可能每帧都脏，但绝不能每条都往主进程推）、force 顶掉已挂起的节流器且不让旧定时器补推、
  dispose 时把还挂着的定时器一起清掉；以及心跳里的**事件循环卡顿自检** —— 240 上实锤过 sendspin 子进程
  65s 零消息后被 SIGKILL，若事件循环根本转不动则事后查无实据，因此心跳迟到超 15s 必须留一条带 mem/rss 的 ERROR，
  而这条日志自己写不出去时也不能连累心跳继续上报。

- `src/services/memory/reclaim.ts`（缺口 20 → **0**，行/语句/函数 100%，分支 94.44%）：钉住空闲判定的四条闸门
  （开关关闭 / 有批量任务 / 阈值边界取 `>=` / 脏值退回默认 5 分钟且按整数算），L2 主动 GC 的 5 分钟节流与
  「只有手动「立即回收」才无视节流」，L3 checkpoint 的 30 分钟节流，注册的清理回调单个抛错不阻断其余，
  以及磁盘只读这类异常下 checkpoint 静默失败、不影响 L1 已经清掉的事实。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `rendererHost/childHost.ts` | 24 → **0** | 行/语句/函数 100%；分支 92.1% |
| `memory/reclaim.ts` | 20 → **0** | 行/语句/函数 100%；分支 94.44% |

- 证伪的 10 项 childHost 分支：兜底扫是否推快照、脏标记是否写入、force 与挂起节流器的关系、dispose 是否清定时器、
  心跳的 `lastBeat` 记账、心跳缺省周期是否取自协议常量、卡顿日志的 catch 兜底、非 Error 抛出的文本规整、
  `ok:true` 应答里空 result 是否写 `null`、`op` 是否规整成字符串。
- 证伪的 13 项 reclaim 分支：回收开关、批量任务短路、空闲边界 `>=`、`v > 0` 的脏值兜底、清理回调的 try/catch、
  回调清单是否留名、vm 探测的脚本内容、GC 节流与记账、checkpoint 节流与记账、`registerCacheCleaner` 的函数校验，
  以及 `manual` 强制跳过节流的实际范围。

- 剩余未覆盖分支经核对为 v8 计数噪声（`finally` 块归属、默认参数与探测记忆的短路侧），非真实缺口。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.41] - 2026-09-27

### 测试

- **补测第八轮（B20：2 个新测试文件 / 41 个新用例）**，同样逐条双向证伪——
  摘掉被测分支后必须立刻变红，恢复后转绿。本轮两个目标都属于「一处写错、波及一片」的共享层：

- `src/services/plugin/importers/http.ts`（**全部导入插件共用**的 HTTP 工具层）：
  `fetchJson` 的非 2xx 抛错、UA 与自定义头的合并、超时中断真的掐断上游；
  `resolveRedirect` 展开重定向后取最终 URL、`res.url` 为空时回落输入、以及**任何失败都不抛**。
  额外钉住一件平时不会暴露的事：`finally` 里的 `clearTimeout` —— 漏掉它用例不会红，
  但每个导入请求都会漏一个常驻计时器。

- `src/routes/api/stream.ts`（`POST /v1/stream/probe`）：入参校验与 `MAX_PROBE_BATCH` 截断、
  无需联网的直达分支（本地 / 已缓存行）、web 歌解析出直链时的 `fallback` 标记，
  以及 `ensurePlayableStream` 返回空时那 **四档 verdict**（unplayable / playable / transient / unknown）。
  其中「别把网络抖动当死链」是断言的重点：探测未定时必须如实报 `transient`，不能判成不可播。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `routes/api/stream.ts` | 24 → **0** | 行/语句/分支/函数均 100% |
| `plugin/importers/http.ts` | 30 → **0** | 行/语句/函数 100%；分支 90.9% |

- `http.ts` 分支那 1 处（10 个分支里 9 个已覆盖）经核对是 v8 对 `finally` 块归属的计数噪声，
  不是真实缺口：真实分支（默认参数两侧、`res.url || url` 的两侧、`catch` 的两条出口）都已覆盖。

- 双向证伪共 10 处变异，全部咬住：type 缺省兜底值、`cachePath` 的本地判定、`fallback` 标记、
  四档 verdict、`reason` 截到 120 字、`MAX_PROBE_BATCH` 截断、非 2xx 抛错、`res.url` 兜底、
  `catch` 回落、以及 `finally` 的 `clearTimeout`。

- 顺带固化一条容易被误读的现状：`String(e?.message || e)` 在 `message` 为空串时会退到 `String(e)`，
  于是探测失败原因显示成 `Error` 而不是空串。不影响可用性，仅备案。

## [4.0.40] - 2026-09-27

### 测试

- **补测第七轮（B16~B19：5 个新测试文件 / 100 个新用例）**，每条用例都做了**双向证伪**——
  摘掉被测分支后必须立刻变红，恢复后转绿，否则不算数。
  本轮继续按 lcov 缺口榜挑**逻辑型**模块，IO 型协议栈（`services/dlna/*`、`services/airplay/*` 的 socket 层、
  `services/sendspin/*` 的流式引擎）维持既有原则**明确降级**，不为了覆盖率数字去 mock 出一批假 IO。

- `services/audio/flow.ts` 的唤醒通道选择 + `services/randomSongs.ts` 配置容错：
  唤醒通道的优先级与「进程级节流」、等待阶段抛错的兜底；配置侧的坏 JSON / 越界数值 / 空白归一 / 年份交换等脏输入
  （`tests/services/flowWakeTargets.test.ts` 13 条 + `tests/services/randomSongsConfig.test.ts` 12 条，25 例）。

- `services/plugin/renderers/supervisor.ts` 渲染器宿主的分支（12 例）+ `routes/api/shared.ts` 共享查询分支（7 例）。

- `src/services/source/online/recommendImport.ts` 每日推荐导入的分支 + `src/services/ws/auth.ts` 握手鉴权，46 例：
  `recommendImport.ts` 用「真实插件 + 真实 SQLite」的姿势（只替换远端封面缓存与批量节流两个副作用面），
  把原本 50 个未覆盖行压到 11；`ws/auth.ts` 打真实 JWT 验签与真实库用户，行/语句/分支/函数**全部 100%**。

- `services/airplay/protocolPlayer.ts` + `services/sendspin/pairServer.ts`（25 例）：
  `protocolPlayer.ts` 此前**从未被任何测试 import 过**（整块 27–75 行零覆盖），本轮直接补到 100%；
  `pairServer.ts` 走真实 CPace 双端对跑（服务端起 PAKE、客户端真 derive/verify），把缺口从 71 行压到 24 行。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `services/ws/auth.ts` | 24 → **0** | 行/语句/分支/函数均 100% |
| `services/airplay/protocolPlayer.ts` | 45 → **0** | 行/语句/分支/函数均 100% |
| `services/plugin/renderers/supervisor.ts` | 38 → **0** | 行覆盖缺口归零 |
| `services/sendspin/pairServer.ts` | 71 → 24 | 剩余 24 行经 9 处变异逐条证伪为**死分支** |
| `services/source/online/recommendImport.ts` | 50 → 11 | 剩余缺口为上游重试的等待段 |

- 剩余 24 行的「死分支」结论不是靠读代码猜的：逐处变异（把恒假的守卫改成恒真、把空转的 `catch` 摘掉、
  把永不成立的写入条件改成成立）后，用例**全部仍然全绿**——这些行无论怎么改都不可能被照到，
  属于协议里本就不存在的路径（见下方 D31~D34）。

### 本轮补测暴露、但**未修**的缺陷（仅记录）

全部已固化成「现状」用例双向锁死，修复计划见 `产品缺陷修复任务-2026-09-27.md`，此处仅备案：

- **D27 / D28（P3）**：「每日推荐」导入未带 `userId` 时 `owner_id` 写空串 ⇒ 撞外键整单失败；
  歌单名为空时**落库兜底成「每日推荐」、返回值却是空串**。
- **D29（P2）**：轮换删除的闸门永假——`old` 列表在导入**之后**才取全表，本次新单被算进 `oldByChannel` 的分母，
  `n >= m + n` 恒假 ⇒ 远端已下架的旧歌单只增不减。副作用是它内部的 `try/catch` 与 favorite 跳过分支在修复前不可达。
- **D30（P2，安全）**：静态配对码「失败 5 次锁定」实质不可达——首次 confirm 不符就 `abort()` 删掉 attempt，
  `failures` 恒为 1 ⇒ `locked()` 恒假 ⇒ 8 位码可被离线无限枚举。
- **D34（P2，协议死锁）**：`dynamic_pairing_code` 的日常时序走不通——`onPairInit` 要求 `await_init` 状态，
  重发的 `client/pair-init` 被直接 return；反过来「先输码再 init」能触发 PAKE，但 `nonce_A` 每次 init 都重新随机，
  服务端比对的码基线失配。
- **D31 / D32 / D33（P3，死代码）**：`waitForCode()` 全仓无调用点；`pendingFinalize` 的写入条件与读取前置条件互斥；
  三处 `b64urlDecode` 的 `catch` 永不触发（`Buffer.from(x, 'base64url')` 不抛错，非法输入由长度检查兜底）。

## [4.0.38] - 2026-09-27

### 测试
- **补测第六轮（B12~B14：11 个新测试文件 / 265 个新用例，全部断言「现状」而非期望契约）**：
  按 lcov 未覆盖行清单优先补「逻辑型」模块 —— IO 型链路（`services/dlna/*`、`services/airplay/*`、
  `services/sendspin/*`）明确降级，不为了数字去 mock 出一堆假 IO。
- 行覆盖率提升（补测前 → 补测后，未覆盖行数）：
  - `services/plugin/renderers/airplay.ts` 43.06% → **100%**（41 → 0）
  - `services/plugin/renderers/dlna.ts` 48.57% → **100%**（36 → 0）
  - `services/source/preferredSource.ts` 50.63% → **100%**（39 → 0）
  - `services/playlist/autoMatch.ts` 64.37% → **100%**（31 → 0）
  - `services/content.ts` 66.67% → **100%**（31 → 0）
  - `services/plugin/randomSongs.ts` 85.58% → **100%**（45 → 0）
  - `services/plugin/localPlatformRecommend.ts` → **100%**（分支 89.65%）
  - `middleware/metrics.ts` → **100%**（分支 83.33%）
  - `services/playlistCover.ts` 80.29% → **98.08%**（41 → 4）
  - `services/backfill.ts` 77.09% → **98.32%**（41 → 3）
  - `services/plugin/localRecommend.ts` 79.85% → **97.79%**（82 → 9）
  - `services/flows/index.ts` 未覆盖行 60 → 41
- 新增测试文件：`plugins/renderersPlugin`、`services/contentUnified`、`services/playlistAutoMatch`、
  `services/preferredSource`、`services/randomSongsEngine`、`services/playlistCoverStore`、
  `services/localRecommendEngine`、`services/backfill`、`services/flowsCrud`、
  `services/localPlatformRecommend`、`middleware/metrics`。

### 修复
- **歌单新建 id 撞主键（P2）**：新建歌单的 id 直接取裸毫秒时间戳（`"pl-" + Date.now()`，共 4 处），
  同一毫秒内建两张歌单就撞 `playlists.id` 主键 → **导入/创建直接抛**
  `SqliteError: UNIQUE constraint failed: playlists.id`。触发面：批量导入多张歌单（导入循环里
  每张一次 insert）、并发导入（自动同步 + 手动同步同时跑）、OpenSubsonic 客户端连点「新建歌单」。
  **本版 CI 的全量测试门禁就是被它打红的**（269 个文件里 `tests/batch/jobsBehavior.test.ts` 的
  「首次导入」用例偶发失败 —— 快机器上 `Date.now()` 连续两次取到同一毫秒太容易了）。
  4 处统一加 4 位 base36 随机后缀（与 `recommendImport.ts` 既有写法完全一致）：
  `batch/jobs.ts`（URL 歌单导入）、`services/plugin/remoteImport.ts`（插件远程导入）、
  `routes/rest/index.ts`（OpenSubsonic `createPlaylist`）、`routes/api/playlists.ts`（歌单文件
  导入的多张循环）。id 仍是 `pl-` 前缀的不透明字符串 —— 已确认全仓没有任何代码/测试解析
  `pl-<数字>`（只按字符串相等或前缀使用），故对外契约零变化。
  回归防线：`tests/batch/jobsBehavior.test.ts` 新增用例，用 `vi.spyOn(Date, "now")` 把两次
  导入钉在同一毫秒；**回滚修复后该用例立刻复现同一条报错，恢复修复后转绿**（双向证伪）。

### 说明
- 补测过程中新发现的 P3 仍**按约定挂起待确认**，只在测试里以 characterization 用例把现状钉住，
  每条都注明「修复后该断言应翻成什么」：`D17` 本地推荐口味路径忽略 `excludeRecent`、
  `D18` 全库随机 rowid 过采样在「库容接近 count」时少 1~2 首、
  `D19` 播放后自动匹配把底层失败回报成 `lockTimeout` 且不留错误日志。

## [4.0.36] - 2026-09-27

### 测试
- **补测第五轮（B5~B11，8 个提交 / 11 个新测试文件 / 454 个新用例）**：全部针对「拆分与重构之后尚无任何测试照到」的模块，
  让这些模块的行为第一次被钉住（而不是为了刷覆盖率数字）：
  - `routes/api/peers.ts`（124 例）+ 可复用 peers 假体、`routes/api/shared.ts` 运行时助手（26 例）；
  - `routes/api/recommend.ts` 与每日推荐路由层（69 例）→ 行 **100%**、分支 82.5%；
  - `services/dlna/announce.ts` 播报编排（29 例）→ 行 60.2% → **100%**、分支 48.7% → **93.33%**；
  - `services/plugin/dailyRecommend.ts`（34 例）→ 行 40.6% → **100%**、分支 89.59%；
  - `services/plugin/playlistSync.ts`（37 例）→ 行 70.2% → **100%**、分支 86.76%；
  - `middleware/auth.ts` 鉴权全通道（33 例）→ 行 60.13% → **96.73%**、分支 **93%**；
  - `services/player/QueueController.ts` 操作面（73 例）→ 行 81.71% → **100%**、分支 85.66%；
  - `services/peer.ts` 清扫与发现面（29 例）→ 行 80.02% → **100%**、分支 89.06%。
- 全量：**258 文件 / 3295 用例全绿**（项目默认 pool 配置），`src/` 行覆盖 81.01% → **83.55%**、
  分支 80.00% → **81.16%**、函数 **84.98%**。

### 已记录待定（均已由测试固化现状，本轮**未改**产品行为）
- **D14** 每日推荐远程全榜单失败时只追加、**不清旧条目**，却照常把当天日期写进 `comment`
  （当天幂等判定为「已生成」，接口仍报 `skipped:false`）—— 两种修法都会改变产品行为，等确认。
- **D15** 歌单重建把占位条目补成可播后，`unavailable_reason` 仍残留「曲库中未找到」
  （同族的自动匹配路径 `match.ts` 会显式置 NULL）—— 潜伏不一致，目前不漏给客户端。
- **D16** `services/peer.ts::startCleanup()` 的三条钩子只有 20s「重启清扫」包了 `try/catch`；
  5s 首次填充与**每 60s 的周期扫描**是裸调 —— 发现源一抛错就是未捕获异常（Node 默认终止进程，且每拍复现）。
- 三条的现象与根因详见 `产品缺陷修复任务-2026-09-27.md`（总览表 D14/D15/D16）。

## [4.0.35] - 2026-09-27

### Changed
- **后端路由层拆分**（`backend/src/routes/api/index.ts`：5048 行 → 71 行装配层）：按业务域拆出
  `peers.ts` / `playlists.ts` / `dlna.ts` / `sendspin.ts` 等模块，`index.ts` 只保留路由挂载装配。
- **CI 静态守卫改为扫目录**：`check-dlna-realtime.mjs`、`check-seek-granularity.mjs`
  与 `playback-chain-guard.yml` 原先直接读 `routes/api/index.ts`；拆分后该文件已成装配层，
  产生 3 处假红、3 处假绿（假绿的三条是负向断言，恒真 —— 永远在保护不存在的东西）。
  现统一改为扫 `routes/api/` 目录。
- **注释剥离器改为字符串感知**（`backend/scripts/lib/strip-comments.mjs`）：原实现用朴素正则
  剥注释，会把路由字符串 `"/v1/airplay/devices/:deviceId/*"` 里的 `/*` 当成块注释起点向右吞；
  改为逐字符扫描并跳过字符串字面量。

### Added
- **路径引用元守卫**（`backend/scripts/check-workflow-paths.mjs`，挂 ci.yml）：静态校验
  `.github/workflows/*.yml` 与 `check-*.mjs` 中引用的仓库内路径必须真实存在，并禁止再把
  装配层文件当作内容来源 —— "文件还在、内容搬走" 是纯存在性检查抓不到的失效形态。
- **`isolatedModules`（`backend/tsconfig.json`）**：禁止类型名从值导出块再导出，从编译期杜绝
  「`tsc` 全绿、运行时却报 does not provide an export named ...」。

### Bug 修复
- **后端起不来（P0）**：`routes/api/shared.ts` 把 5 个纯类型名放进了值导出块，`tsc` 会整条擦除
  而 esbuild / tsx 予以保留 → 启动即 `SyntaxError: ... does not provide an export named 'BatchPace'`。
  已改为 TS 5.5 内联 `type` 导出。同类问题会同时打红 pentest「启动后端实例」与
  frontend-responsive，而跑 `tsc` + 全量测试的 `build-and-push` 一直是绿的 ——
  **类型检查加测试通过，不能证明后端起得来。**
- **内部异常原文外泄**：`apiInternalError` 改为按环境分级脱敏 —— 生产默认只回 `errors.internal`，
  原文写日志；`MF_EXPOSE_ERROR_DETAIL=1|true` 可显式放开。
- **遗留调试代码**：`[TEST]`、`evaluateDBG` 等无条件打印（其中 3 处会带出媒体源 URL 与用户名）
  收编到分级日志，受 `LOG_LEVEL` 控制。
- **错误契约收编**：业务错误码与 HTTP 状态码打架 27 处、裸 `{error}` 响应 51 处、在线源/搜索域
  70 处错误响应，全部走 `apiError` + `apiErrorStatus` 单一真源。
- **WebDAV 源整体不可达时不再清空歌曲行**；「跳过」与「失败」改为分离计数；`enabled` 传布尔值
  不再 500；删除用户时清理 10 张用户私有表（含可用凭据）。

### 测试
- 路由层契约测试三段齐到行覆盖 100%：`routes/api/dlna.ts`（64 用例）、
  `routes/api/sendspin.ts`（58）、`routes/api/playlists.ts`（57）。
- 零覆盖模块补齐：`services/sendspin/ipcProtocol.ts`、`routes/navidrome/index.ts`、
  `services/sendspin/proxy.ts`（行 48% → 100%、分支 14% → 100%）。

## [4.0.34] - 2026-09-26

### Changed
- **DLNA 发现节奏常量收归单一真源**（`dlna/scanPolicy.ts`）：把决定「设备上线后
  多久出现在播放器列表」的两个参数集中到一处，此前它们以字面量散落三层——
  - `DLNA_SCAN_INTERVAL_MS`（90s）由入口常驻定时器消费；
  - `DISCOVERY_CACHE_TTL_MS`（60s）由「拉 `/v1/peers` 时是否后台补扫」消费。

  这两个数一旦改一处漏一处，就会**静默退化**（不报错、不崩溃，只是列表里少一台
  正在放歌的音箱），手测极易误判成网络问题。抽成无副作用的独立模块后，两处统一
  引用同一常量（步骤本身不改行为）。

### Added
- **DLNA 实时发现 CI 守卫**（`backend/scripts/check-dlna-realtime.mjs`，挂 ci.yml）：
  七条规则静态锁死「设备上线即刻入列」的契约——间隔单一真源、入口不写死、拉列表
  即补扫、去抖可放开、alive 分支接线、byebye 反向语义、扫描并发去重。任一条被改回
  旧行为，CI 立刻变红。
- **扫描节奏契约测试**（`backend/tests/dlna/scanCadence.test.ts`）：直接 import
  `scanPolicy` 断言常量取值，不触发 SSDP 绑定。

## [4.0.33] - 2026-09-26

### Fixed
- **普通用户（非管理员）在 Windows / 安卓客户端看不到自己的本机播放器**：
  `POST /v1/peers/register` 对非管理员恒被 403 拦下，导致该账号的本机播放器
  从未在服务端建立——列表里自然既没有自己那行、`self` 标记也无从谈起。

  根因是 Hono 的 `:peerId/*` 通配会吞掉字面量子路径：`/v1/peers/:peerId/*`
  中间件实际命中了 `POST /v1/peers/register` 且把 `peerId` 解析成 `"register"`，
  于是权限判定 `canControlPeer(userId, false, "register")` 恒为 false。管理员因为
  `isAdmin` 短路放行才一直正常，这正是「只有普通账号出问题」的原因。

  修复：中间件显式放行字面量保留段 `register`（精确等值匹配，故
  `dlna:register-xxx` 这类真实 peerId 不受影响，仍走鉴权）。

  验证：240 上普通账号 `POST /v1/peers/register` 由 403 转为 200 并返回
  `self: true`；带该客户端实例标识拉 `/v1/peers`，自己那条以 `self: true` 出现。
  回归测试覆盖 register 放行、self 可认、真实 peerId 不误放三种情形。

## [4.0.32] - 2026-09-26

### Fixed
- **DLNA 设备上线后迟迟不出现在播放器列表**：`/v1/peers` 拉列表时不再完全依赖
  每 5 分钟一次的主动扫描——发现扫描间隔收紧到 90s，且拉取 peers 时按 TTL 补扫
  （并发去重，避免多端同时打开时重复扫描）。
- **alive 通告在设备刚上电时被静默丢弃**：设备 HTTP 服务尚未就绪时 description 抓取
  失败，原实现会白白消耗掉「同一位置 60s 内只处理一次 alive」的去抖窗口，导致此后即使
  设备就绪也要等下一轮扫描。现在失败会放开该窗口，并按 0.8s/2s/5s 退避重试。

真机验证：240 上主卧（HiVi H5MKII）断电后上电，新版在设备 HTTP 就绪后即将其标为
在线；旧版需等到下一轮扫描。离线判定仍正常工作（非无脑保活）。

## [4.0.31] - 2026-09-26

### 修复：逐字(卡拉OK)歌词被逐时间戳重复展开 —— 一行吐出 N 条相同歌词

- **现象**：部分歌曲在**所有端**（HA 卡片 / Web / 客户端）都显示大量重复的歌词行。用户口径：「歌词本身是正常的，是我们的解析出了问题」。
- **根因**：`parseLrc` 的时间戳正则 `\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]` 在一行内会命中**多个**时间戳，而旧实现把整行文字拼成一句、再对每个时间戳各 push 一次。逐字歌词把**每个字**的时间戳都写在同一物理行上（`[00:00.63]天[00:00.89]地[00:01.02]玄…`），于是一行 N 个字就产出 N 条**内容完全相同**的歌词。
- **修法**：按「首个时间戳结束 → 最后一个时间戳开始」之间**有无文字**，把一行分成两种形态分别处理：
  - **分组式**（`[00:10.00][00:20.00]词`：时间戳之间没有文字）→ 正确展开成多条 —— 这是它的本意，保留。
  - **交错式**（`[00:00.63]天[00:00.89]地`：时间戳与文字交错）→ 整行折叠成**一条**，以首个时间戳为起点。
  另加同 `(time, text)` 去重（同一时刻同一文本只留一条），并剥离 enhanced LRC 行内的 `<mm:ss.xx>` 逐字标签。
- **验证**：新增 `backend/tests/services/lyrics.test.ts`（8 项，含真实歌曲的逐字原文样本）；单测全绿 + 变异验证（拆掉分组式/交错式分支即转红）。240 真实曲库新旧对照：单曲 833 条 → 86 条、同 `(time,text)` 重复行 25628 → 0（抽样 2272 个文件，约 80% 曲库受影响）；剩余同文本条目为真实副歌重复，正确保留。

### 修复：DLNA 设备「正在播放」却被判离线、前端不显示其存在

- **现象**：DLNA 设备（如重命名后的「主卧」）已上线并正在播放，三端播放器列表里却看不到它 —— 用户场景是「音流触发 DLNA 设备上线后播放」。用户提示「前两天还是正常的，应该是最近对音流 / sendspin 的发现扫描改动带出来的」。
- **根因**：`control.ts::refreshDevices` 以「**本轮 M-SEARCH 响应集合**」这一个快照判定在线，**零迟滞**：设备某一轮没回 M-SEARCH（刚上电 / 固件播放中变忙 / description 拉取超时）→ `available=false` → peer 离线 → 三端 `.filter(p => p.available !== false)` 直接把它从列表剪掉。实测中设备正在拉流播放、同一时刻却被判离线，约 60~70s 后才翻转。
- **修法**：「**设备正在拉我们的流**」是比 SSDP / SOAP 更硬的存活证据。给离线判定加**四道闸 + 一道消毒**，三道都不过才真判离线：
  1. **出流活跃豁免**：`/rest/dlna/stream/:token` 的响应体每写一块登记一次活动（5s 节流），90s 窗口内有过出流 ⇒ 保持在线；
  2. **抖动宽限**：`last_seen` 距今不足 90s ⇒ 跳过本轮（不因单轮漏报降级）；
  3. **定向补探**：设备 `location` 已知就直连 GET `description.xml`（不经 SSDP 多播）成功即保持在线；
  4. **消毒**：扫描 socket 本轮报错 ⇒ 该轮结果不可信，整轮跳过。
  设备删除 / 禁用时清理活动登记，避免键泄漏。
- **验证**：新增 `backend/tests/dlna/deviceAvailability.test.ts`（8 项，覆盖四道闸 + 消毒 + 清理）；变异验证 5/5 全抓（含「整块还原为修复前逻辑」时 4 条闸测试同时变红）。230 上自建 DLNA 模拟器做同机 A/B（只换 dist）：修复前「单轮漏报 → 立即离线」复现，修复后「保持在线」；且「SSDP + HTTP 全不可达且无出流」仍能正确判离线、「停止出流后再等一个窗口」也判离线（不是无脑保活）—— 12/12 项全过。

### 功能：流转播放 sendspin → sendspin 复用服务端已解码的流（「借流」）

- **目标**：sendspin 之间流转时，目标端**零解码、零 seek、零预缓冲**即出声 —— 源端那条流在服务端本来就是**解码完的**（泵 + PCM 窗口），把它整体接过去即可。
- **修法**：新增「武装 → 起播消费 → 落位确认」三段：
  1. `armBorrowCore` 在 `POST /peers/:id/queue/transfer-from` 的起播**之前**武装（源端必须 active、非 busy、有当前曲），记录源端组 + 落点 + 歌 ID；
  2. 目标端起播那一步 `borrowFor` 取武装，**歌 ID 不符即自动放弃**（源端可能在毫秒级窗口里被停 / 被换歌）；命中的走 `handoverCore` 把源端的泵 + PCM 窗口整体改挂到目标组连接上，否则回退完整起播；
  3. `borrowLandingConfirmed` 回读目标端实时进度与落点比对（容差 1.5s）：**成了才跳过事后 seek** —— 移交没成时目标端还在 0 秒，必须走常规对齐。两种情形的后续处置完全相反，一次读回把不确定性消掉。
- **降级**：任一端不是 sendspin、源端未在播、服务未起、歌不符、RPC 失败 → 一律 `armed=false`，走既有「起播 → 读进度 → seek」链路，行为与改动前一致。
- **测试**：新增 `backend/tests/sendspin/pumpHandover.test.ts`（契约 + 变异验证）。

### 其他

- 本版为 lockstep 发布：HA 卡片 v2.4.13（卡片进度不走双根因修复）、HA 集成 v2.0.6、客户端 v5.0.37 同步 bump 并触发各自 CI。


## [4.0.30] - 2026-09-26

### 功能：流转播放带「进度对齐」——目标端出声即与流转前对齐（秒级）

- **现象**：队列与当前曲都能流转到另一端，但目标端一律从这首的 **0 秒**开始播。用户口径是「流转播放后出声的状态要是秒级对齐流转前的状态」。
- **根因**：起播接口 `playFrom` / `localPlayFrom` 与队列快照 `QueueSnapshot` 里**都没有「起始位置」这个字段**。服务端其实握着读进度的口子（`GET /v1/peers/:id/status`，DLNA 走 SOAP 实时值、本机端取客户端上报）与写进度的口子（`POST /v1/peers/:id/seek`，dlna / group / airplay / sendspin / local 五种 kind 全覆盖），但**起播路径一次都没接上** —— 于是"先起播、再 seek"这条路根本没走通，连"起点"本身都无处安放。
- **修法**：新增统一的 `readPeerPositionSeconds` / `seekPeerToSeconds` 两个辅助（seek 的 kind 分派与 `POST /peers/:id/seek` **完全一致**，保证五种 kind 的手感与既有 seek 没有差别），在三条流转路径上补齐：

  | 路径 | 起点从哪来 | 怎么落位 |
  |---|---|---|
  | `POST /peers/:id/queue/transfer-from`（远端 → 远端） | 服务端**起播之后**回读源端实时进度 | cast 目标由服务端自行 seek；local 目标把起点随当次快照交出去 |
  | `POST /v1/play`（本机 → 远端主通道） | 调用方随 body 传 `position` | cast 目标服务端 seek；local 目标同上 |
  | `POST /peers/:id/queue/play`（兜底整队推送） | 同上 | 同上 |

- **为什么读数放在起播之后**：起播（尤其 DLNA 投递）要花 1~3s，这期间源端仍在播 —— 读得越晚，越贴近目标端真正出声的那一刻。
- **为什么调用方传的 `position` 优先于服务端回读**：本机做源端时，客户端才是那个会话的持有者（它的读数是精确值，且本机此刻已暂停、不再前进），而服务端镜像带着 TTL 与轮询间隔，反而更旧。
- **local 目标为什么不能"直接下令 seek"**：本机端的音频会话活在客户端进程里，服务端只能下令；而此刻客户端**还没起播**（它在等 `peer_queue_changed` 才起播），此时下令必然落空。故起点随 `QueueSnapshot.startPosition` **一次性**下发（广播后立即清除），客户端起播后自行落位。**不落库**是刻意的：落库会让之后每次轮询/重启恢复都带着它，表现为"每次回到同一位置"。
- **降级与兼容**：`position` 全为可选参数。不带 / 为 0 / 源端进度读不到 → 行为与改动前**逐字节一致**（从头播），不引入新的失败模式。
- **测试**：新增 `backend/tests/routes/queueTransferPosition.test.ts`，覆盖"本机源端精确优先""远端源端回读""local 目标随快照下发""读不到则不落位"四条契约；并做过变异验证（摘掉起点传递后相关用例转红）。

## [4.0.29] - 2026-09-26

### 修复：歌单「自动匹配 + 补齐」整条链路此前从未真正生效

- **现象**：歌单里存在「未匹配行」（playable=0、song_id 为空 —— 常见于加导入门禁前误匹配到本地，或在线源后来下架）。用户点「播放全部」/ 投屏起播时这些行会被重新搜一次，命中的应当追加到队尾。但实测**一首都没补进去过** —— 队列始终是起播时的那几首。
- **根因（D1）**：`QueueData.contentContext` 是「这条队列来自哪个内容」的唯一标记，补齐前必须与期望值严格比对以防补错队列。它只在 `QueueController.setQueue()` 里写入，而 `setQueue` 全仓仅由 `playFrom()` 调用 —— **8 处 `playFrom` 一处都没传第 5 个参数**。于是队列上的 contentContext 恒为 `undefined`，比对 `undefined !== "playlist:<id>"` 恒真 ⇒ 永远走到 `context-mismatch`、`appended` 恒为 0。属新字段只接了一半线：当初加了给 `runPlaylistAutoMatch` 传参，漏了给 `playFrom` 补第 5 参。
- **修复**：起播处补传第 5 个参数（type=playlist 时为 `playlist:<id>`）。
- **同步修掉的另外三处**：
  - **投屏双跑（A1）**：WEB 端「播放全部」原本自己发一轮 `match-playlist`，而 `/v1/play` 也会 fire-and-forget 跑一轮 —— 两套 24h 节流（浏览器 / Node）互不知晓 ⇒ 同一歌单同时被在线搜两遍，且两边都往同一队列队尾追加 ⇒ 重复入队。现统一为「谁起播谁补齐」：投屏目标由服务端负责，前端不再自己发；补齐结果经 WS `playlist_appended` 回传，与原前端自建队补齐的刷新与提示保持一致。
  - **端点绕过节流（D2）**：`/v1/playlist/:id/auto-match`（客户端本机播用）直呼底层，24h 节流完全旁路，每次起播都真打一轮在线源。现改为复用 `runPlaylistAutoMatch`，与 `/v1/play` 共用同一份节流。
  - **死等与空跑记账（D4/D6）**：原先无论匹配 2 秒跑完还是卡在批量闸，都一律干等满 5 分钟才补齐；被每歌单并发锁挡下的空跑也照样吃掉 24h 额度。现改为「跑完即走」的竞速等待（用上 `matchPlaylistInBackground` 已有的 `onFinished`），并只在真正拿到锁跑完时才记账。
- **顺带：本地曲库优先短路**：给 `matchUnmatchedPlaylistEntries` 补上与插件榜单同步一致的`matchSongsToLibrary` 前置短路 —— 曲库中已有「归一化标题精确相等 + 歌手互相包含」的行时直接绑定旧行，不消耗在线搜索、不受导入门禁约束。门禁要求标题全串严格相等，带译名/版本后缀的条目（如「... (炽日将烬)(feat. ...)」）永远差一个字符 ⇒ `matched` 恒为 0、补齐链路不可达；短路正是这条链路的兜底。


## [4.0.28] - 2026-09-25

### 修复：群组没有在线成员时疯狂切歌；音流应在有播放器上线后才开始播放

- **现象**：音流（以及其它把内容投给群组的路径）在目标**当前没有任何成员在线**时，会把内容照投进去，
  随后队列被反复推着走 —— 一会儿就切掉几百首（用户视感 = 疯狂切歌），设备一直不出声；等设备真的
  上电回来，队列早就被推到很远的位置了。
- **根因**：两层叠加。
  - **判据失效**：音流用 `peer.available` 判断目标是否上线，而群组行的 `available` **恒 true**
    （2026-09-23 定稿「组是容器不是设备、组恒在线」）⇒ 「组零成员」永远被判为已上线，内容照投不误。
  - **空转自续**：`QueueController.playCurrent` 把投不出去当成普通 cast 失败 ⇒ `castFailStreak++`，
    封顶 `max(2, 2 × 曲数)`（大歌单即数百次），且每一拍都交给 `handleDecision("stalled")` 放行切歌
    ⇒ **边失败边切歌**。真机实测：6 分钟空转 787 次「无在线成员,无法播放」，idx 从 293 被推到 49。
- **修复**：判据单点收口到 `services/playTarget.ts` 的 `checkPlayTarget()`，三层消费同一个函数。
  - 群组：看 `hasOnlineMember`（**不再**看 `available`）；AirPlay：看 `discovery.available`
    （设备档案持久化，设备离线也仍留在列表里）；DLNA / Sendspin / 本地：乐观放行。
  - `QueueController.playCurrent`：起播前先查判据，不可播就**连 cast 都不发**、不推进队列、不计失败
    （队列保持悬挂，等 watchdog / 设备回归自然恢复）；cast 失败后再查一次，兜「起播判据过关、
    cast 期间成员掉光」的竞态，并清掉已累积的失败链。
  - `flows`：换成同一判据判断目标是否就绪；等待阶段每轮主动催 Sendspin / AirPlay 的发现，并尊重
    「Sendspin 插件启用」与「`autoDiscover`」两个开关（配置即意志，不给绕过配置的后门）。
  - Sendspin 侧附带修正：音流原先在主进程直调发现 / 拨号函数，而发现循环与重试状态机活在**子进程**
    里 ⇒ 生产 fork 模式下 100% 静默空转；改走 `wakeSendspinDiscovery()`（按 `isForkMode()` 分派
    RPC / 直跑）。同时给自动发现与名单补枪加上「被用户禁用的设备不再拨回」守卫。
- **测试**：新增 `playTarget`(7) / `playTargetGuard`(5) / `flowWaitGate`(4) 共 16 例；每处修改都做了
  负向验证 —— 破坏后必须精确变红（其中音流消费点原先零覆盖，补 `flowWaitGate` 后破坏即变红）。

### 真机验收（240 + 两台 ESP32-S3 Sendspin 播放器）

- `.245`、`.246` **同时断电**后触发群组音流：webhook **9ms** 返回（等待发生在内部，不占着请求），
  `last_run_status` 恒为 `waiting`，期间 **cast 失败 0 次、已播放 0 次、队列 idx 纹丝不动**
  （修复前同条件：6 分钟 787 次「无在线成员,无法播放」、idx 293 → 49）。
- 任一成员上电：状态直接转 `success`，**无需重新触发 webhook** —— 自动拨号 → 上线自动回组 →
  `[flow] 已播放:sendspin群组` → `timeline anchored`（出声）。用户实听确认两台都在播。

## [4.0.27] - 2026-09-25

### 修复：Sendspin 设备断电重上电后不自动连回，连回后也要切歌才出声

- **现象**：Sendspin 播放器（ESPHome / ESP32）断电再上电后服务端不会自动连回来（设备同网段可 ping 通、
  本身也起好了 WS server）；人工连上后同样不出声 —— 要等到下一次切歌才正常播放。
- **根因**：四层叠加。
  - **发现是一次性的**：设备开机只广播一次 mDNS，而 `bonjour-service` 的 PTR 查询只发起一次、
    对已知 fqdn **永久去重**、`expire()` 从不调用 —— 首次拨号失败（设备网卡刚起、IP 栈未通，
    实测 `EHOSTUNREACH`）之后，这台设备就再也没有第二次机会。
  - **重试不记忆**：旧逻辑是 60s 盲轮询，容器重启后不再尝试，断电设备永不被重新 `arm`。
  - **死链不摘牌**：断连留下的 WS 连接无心跳、未启 `SO_KEEPALIVE`，内核默认 15 分钟才判死，
    期间服务端仍认为「已在线」—— 新广播被在线判据直接跳过，任何重试方案都不会被触发。
  - **新连接不入组**：组推流的成员是 `SendspinGroup.members` 里的 **conn 对象**，断连时
    `onConnectionClosed` 会 `g.remove(conn)`；重连是**新 conn**，不在任何组里，只有下一次切歌的
    `playGroupCore` 才会 `g.add(conn)` —— 夹在中间的窗口拿不到 `stream/start`，
    设备收得到 TCP 数据却无声。
- **修复**（`backend/src/services/sendspin/`）：
  - `discover.ts`：发现即入册（先记后拨）+ **每 60s 重建 mDNS browser**，重新捕获设备广播；
  - `index.ts`：per-target 重试状态机取代 60s 盲轮询 —— `2s × 30 → 10s × 24`（300s 窗口后停手，
    兜底职责交给 mDNS 信号源），拨号显式 5s 超时，窗口内不因新信号重置计时起点；
    **上线自动回组**：连接就绪后对「本组正在播」的组走 `sendspinGroupJoin` ——
    与「加入群组」同一条 `joinGroupCore` 路径（live 沿加入 + `pendingAnnounces` 兑现
    `stream/start` + `seedLateJoin` 回填）；
  - `server.ts`：10s WS 心跳（未回 pong 即 terminate）+ `noAutoRedial` 加 5min TTL +
    在线判据兼顾 inbound 方向。

### 真机验收（240 + ESPHome ESP32-S3，三轮受控复现）

- 断电量 >300s（重试窗口**已过期**、状态机零动作）后上电：mDNS 发现重新触发窗口
  （日志前缀 `(discover)`，区别于容器 boot 的 `(boot)`）→ 首次拨号 `EHOSTUNREACH` →
  **55s 后拨通** → `设备上线自动回组 … joined=true live=true pump=true` →
  `late-join 回填 chunks=288 span=24576ms` → 切歌时与在播成员**成对**收到
  `finishPlayback` + `announceStream ×2`。
- 结论：断电上电后自动连回并**直接出声**，全程零人工干预、无需切歌（用户实听确认）。

## [4.0.26] - 2026-09-25

### 功能：新增歌单自动匹配触发端点（供客户端 / 播放器调用）

- **背景**：`/v1/play` 上的自动匹配只对**投屏**生效 —— 它本来就由服务端在起播同一时刻接管（Flutter 客户端选中远端 peer 时，`playContentOnPeer(type=playlist)` 打的就是它）。但客户端的**本机播放**并不走 `/v1/play`：它自己拉全量曲目、自己 `playQueue`。客户端又拿不到 online `providerId`（本地歌单没有该字段），调不了`/v1/online/:providerId/match-playlist` —— 于是「客户端播歌单永远不补齐」。
- **修复**：新增 `POST /v1/playlist/:id/auto-match`（`PLAYLIST_IMPORT` + 归属校验），内部直接复用 `matchPlaylistInBackground()` 的**能力驱动挑选**：启用谁的匹配能力就用谁，调用方无需指定 provider。
  - 只登记任务即返回（服务端随后还要去抢全局批量闸），**不 await** 匹配本身；
  - 与 `/v1/play` 共用同一把「每歌单锁」与 24h 节流语义，客户端反复点也不会重复消耗在线源配额；
  - 旧服务端没有该端点时调用方请求失败，客户端静默跳过补齐，不影响播放。

## [4.0.25] - 2026-09-25

### 功能：歌单「播放触发」自动匹配与补齐

- **现象**：歌单里「曲库中未找到」的条目（门禁拦下 / 在线源下架 / 加门禁前误匹配到本地）在起播时
  被直接跳过，歌就永远播不到。此前只有手动点「批量匹配」按钮才会重新尝试。
- **修复**：起播成功后**静默**跑一次歌单批量匹配，命中的曲目追加到队尾，之后由既有预探测
  （`core-pre-probe`）提前确认可播，切到它们时零等待。
  - 复用服务端既有的 `matchPlaylistInBackground()`（能力挑选 → 每歌单锁 → 全局批量闸 →
    并发搜索 → 导入门禁 → WS 播进度），另新增 `services/playlist/autoMatch.ts` 负责
    「何时触发、节流、以及跑完后补哪个队列」；
  - **绝不阻塞播放**：整条链路 fire-and-forget；排队等全局批量闸超过 5 分钟即放弃本轮
    （下次起播再试），不影响正在听的那一首；
  - 节流：同一歌单 **24 小时**内自动匹配最多一轮（手动「批量匹配」按钮不受限制），
    避免反复点「播放全部」把在线源打成 429；
  - 覆盖所有播放入口：`POST /v1/play`（投屏 / 群组 / AirPlay / 客户端本机播）在 type=playlist 时
    触发一批；Web 歌单详情页「播放全部」同样触发（前端与后端各有 24h 节流）。

### 改进：队列来源用「内存标记」精确判定，不再靠快照猜

- **背景**：三张队列表（`device_queues` / `group_queues` / `local_queues`）都没有来源字段，
  服务端无法从数据侧确证「这条队列还是刚才那个歌单吗」。原先只能靠「队列长度 + 首曲 id」快照去猜 ——
  用户中途加一首就对不上，两个同长度的歌单还会撞车。
- **修复**：`QueueData` 增加纯内存字段 `contentContext`（如 `playlist:<playlistId>`），
  由起播入口写入、切内容时清空；匹配跑完后**只有标记一致**才允许补齐，进程重启即失效
  （失效 = 放弃补齐，安全语义）。

### 体验：播放触发的匹配不再弹进度对话框

- 「播放全部」触发的自动匹配改为**静默**执行（`runMatchJob({ silent: true })`），
  只在真补齐了曲目时用 toast 提示「已把新匹配的 N 首补齐到播放队列」；
  手动「批量匹配」按钮仍保留完整进度对话框。
- 顺带：所有歌单点「播放全部」都会尝试一次自动匹配（不再要求当前存在未匹配行）——
  历史被门禁拦下的曲目，若后来在线源又有了，下次播放即自愈。

## [4.0.24] - 2026-09-25

### 修复：歌单条目的 external_* 被写入「歌曲自身 UUID」占位，失效后永久卡死

- **现象**：歌单里出现一串 UUID 当歌名（如 `35cd8956-…`），该条目再也匹配不上任何源。
- **根因**：宿主写歌单条目的「已匹配」分支，把 `song_id` 顶进了 `external_song_id` / `external_title`，
  且 `external_artist` 从未写入 —— `plugins/discovery.ts` 的 `upsertPluginPlaylist()`（外置插件
  `host.playlists.upsert`）与 `services/source/online/recommendImport.ts` 的 `replacePlaylistSongs()`。
  这两列本应只在「未匹配占位」时承载平台信息（`netease:<id>` + 歌名 + 歌手）。
  平台 id 直通路径早已废除，未匹配条目一律拿 `external_title` / `external_artist` 去在线搜索并过导入门禁；
  一旦某行因门禁重验不命中而失去 `song_id`，它就会用这串 UUID 当歌名去搜 → 永远搜不到，
  永久卡死，并被歌曲列表原样渲染成 UUID。
- **修复**：
  - `discovery.ts` 命中分支只写 `song_id`，external_* 三列留空；
  - `recommendImport.ts` 不再把歌曲 id 写入 `external_song_id`（保留真实歌名 `external_title`，
    便于该行日后失去链接时仍能按名搜回，自愈）。
- **存量数据**：清理 88361 行占位（其中 57059 行按 `songs` 表回填真歌名/歌手/时长，31302 行只清 id），
  另清掉 5985 行指向已不在库的 UUID 形态 id；真实平台 id（`netease:` / `qq:` / `kugou:` / `apple:` /
  `huawei:` 等 2.3 万行）与 lastfm / listenbrainz 的 MBID 全部保留。

### 修复：歌单「播放全部」大歌单静默漏播尾部（>1000 行只播前 ~1000 首）

- **现象**：歌单详情页点「播放全部」，超过约 1000 行的歌单只会播前 ~1000 首，后面的曲目
  无声无息被丢弃（不报错、不提示）。生产库实测「今日漫游」3137 行、只播前 ~1000 行。
- **根因**：`playAll` 的数据源是 `useInfiniteList` 的**窗口化稀疏数组**（可视区 120 行 + 预取余量 700 行），
  滚出窗口的旧块还会被 `nullSlots()` 置空 —— 数组里根本没有第 1001 行之后的内容。
- **修复**：
  - `composables/usePlayContent.ts` 新增 `fetchPlaylistTracks()`：分页拉取 `/v1/playlists/:id/tracks`
    **全量**（`pageSize` 取上限 200，`position, id` 序），单次返回 `{ playable, unmatched }` 两段；
    先回退一页补齐服务端 `total` 与分页上限不一致的边界。
  - `views/Playlists/Detail.vue` 的 `playAll` 不再读 `list.value`：
    ① 命中可播行 → `setContentOrigin("playlist", id)` + `playQueue(可播队列)` **零等待起播**（顺序正确）；
    ② 存在未匹配行 → 复用后端 `match-playlist` job（并发搜索 + 门禁 + 批量导入，带进度对话框）
    → 跑完 `addToQueue` 把新匹配到的曲目**补齐到队尾**。
  - 同时补上 `playAll` 缺失的 `contentOrigin` 声明 —— 此前切投屏会退化成"整队推送"，
    受公网 WAF 体积闸门限制（约 300 首即 403）；现在投屏走服务端权威队列 + `songId` 身份定位。
- **慢路径边界**：整单一首都不可播时不再"先起播"，直接提示无可播歌曲（保持原行为）。

## [4.0.23] - 2026-09-25

### 修复：封面批量补全的候选口径与执行守卫不一致（界面「可匹配」数量虚高）

- **现象**：管理页「批量匹配封面」始终显示数万条待匹配（线上库实测 49174），跑完一轮几乎不降。
- **根因**：候选数是裸 `COUNT(*) WHERE cover_art IS NULL OR cover_art = ''`，把本地（WebDAV）歌
  全算了进来；而本地歌的封面按设计落在**专辑行**（`songs.cover_art` 恒为空），执行期 `covers.ts`
  的专辑守卫命中后「只返回引用、不写库，保持本地歌数据原样」——这批歌因此**永远不会离开候选集**
  （49174 个候选里 48968 首属此类，且都被计成 ok 而非 skipped）。
- **修复**：把同一条守卫条件下沉进候选 SQL（`services/backfill.ts` 的 `whereClause`）——
  `type='local' AND album_id IS NOT NULL AND 专辑已有 cover_art` → 不算候选。执行期守卫保留作第二道网。
- **效果**：候选 **49174 → 206**（local 173 / web 33），与实际会发起在线搜索的量一致；
  `collectCandidates` 也不必再把 4.9 万行整行 select 进内存空跑。
- **局限**：SQL 无法判断专辑封面文件是否真的存在（那是 `resolveCoverFile` 的职责）。当前库 0 断链，
  够用；万一出现断链，JS 侧守卫仍会兜住、不会误写在线图。

## [4.0.22] - 2026-09-25

### 新增：扫描落库文件头全部标签（年份 / 专辑艺术家 / 作曲家 / 备注 / 原始标签）

- **动机**：本地源（WebDAV / 网盘）此前只落 `title` / `artist` / `album` 等少数字段，
  **扫描时读到的信息全丢**。FLAC 元数据块位于文件最前面（STREAMINFO → VORBIS_COMMENT /
  PICTURE → 音频帧），**只取文件头即可拿到与全量解析逐键一致的标签**。
- **新增列**：`songs.year` / `album_artist` / `composer` / `comment` / `tags`（原始标签 JSON，
  二进制值与 >1000 字符的值只留长度），另加 `has_lyrics`（三态，见下）；
  `albums.genre` 顺带由 `findOrCreateAlbum` 补写。线上库已手工 ALTER，drizzle schema 同步。
- **分级取头**：`HEADER_LADDER = [256KB, 1MB, 4MB]`，由 `MusicMetadata.incomplete` 驱动升档。
  实测曲库 FLAC 元数据块全部落在前 256KB 内，取头流量从固定 4MB 降至约 1/16。
- **歌词提取**：双来源 —— `common.lyrics` + native 原始标签白名单
  （`LYRICS` / `UNSYNCEDLYRICS` / `SYNCEDLYRICS` / `LYRIC` / `USLT` / `SYLT`）兜底，
  带 `[mm:ss]` 时间轴的优先（实测 FLAC 内嵌 LYRICS 多数本身就是 LRC）。
- 新增 `buildTagsJson()`（全量原始标签落库）、`joinTags()`（多值标签折叠）。

### 变更：歌词只标注存在性，不落正文

- `songs.lyrics` 不再承载歌词正文，改为只表示**在线歌词文件引用**（`online-lyrics/<id>.lrc`）；
  新增 `has_lyrics` 三态：**NULL = 未检测 / 0 = 检测过无 / 1 = 有**
  （刻意不设 DEFAULT —— 只有 NULL 才代表"没查过"）。
- `upsertSong` 写入 `hasLyrics`，文件无歌词时**不降级**已有的 1。
- 理由是批量回填只需区分「有和没有」，存正文既撑库又没有出口。

### 修复：批量回填重复劳动 + 网盘请求无限速

- `backfill.ts` 歌词候选加 `COALESCE(has_lyrics,0)=0`（内嵌已带歌词的歌不再被在线重复搜索），
  命中落盘时同步 `has_lyrics=1`；sidecar 命中分支同样标注。
- 封面回填候选过滤掉**已有专辑封面**的行；本地歌已有封面则不再搜索覆盖。
- 回填请求限速重写：全局最小请求间隔 + 429/5xx 退避重试（与 `scanner.fetchWithRetry`
  同语义），并复用系统「限速档位」`batch_pace` 的批间睡眠与并发 —— **网盘必须有间隔**。

### 新增：新落库标签的 API / 前端出口

- `utils/songSource.ts`：`ClientSongRow` / `serializeSongRow` 增
  `year` / `albumArtist` / `composer` / `comment` / `hasLyrics`。
- `routes/rest/index.ts`：`songToChild` 修掉 `year` 硬编码 0（列已落库却永远输出 0），
  增 OpenSubsonic 扩展字段 `displayAlbumArtist` / `displayComposer`；search3 空查询分支的
  手工投影列同步补齐（否则搜索结果这些字段恒空）。
- `routes/api/index.ts`：新增 `GET /v1/songs/:id` 单曲详情（返回 `tags` 原始标签 JSON +
  `lyrics` 概况）。列表接口刻意**不返回** `tags`（0.5~2KB/行，整页投影会撑爆）。
- 前端歌曲信息弹窗：补 年份 / 专辑艺术家 / 作曲家 / 流派 / 音轨 / 备注 行、歌词状态行、
  「原始标签(N)」折叠区；`locales` 的 `globalItem` 新增对应 key（zh / en 同步）。

### 验证

- `npx tsc --noEmit` 通过；前端 `npm run build` 通过。
- CI 守卫全绿：`check-builtins` 18/18、`check-core`、`check-i18n`、`check-seek-granularity`、
  `check-frontend-plugins` / `check-frontend-overlays` / `check-element-overrides` /
  `check-fixed-playlist-ids` / `check-renderer-host`。
- 实测（4 首样本）：仅 256KB 一档即拿到完整标签；`album_artist` / `year` / `comment` /
  歌词（777~1351 字符，3/4 带时间轴）/ `tags` 均落库，两轮 upsert 幂等。
- 本期**不回填历史曲库**（用户决定）：代码路径已就绪，库内已有数据的标签补齐按需再跑。

## [4.0.21] - 2026-09-24

### 修复：成员换组残留双成员 / 双流（对齐 MA `add_client` 的 `ungroup`）

- **现象**：一个 Sendspin 播放器**已属于某组**（用户组 或 它自己的独立播放组）时，
  再被加入另一个组，会同时留在**旧组和新组**的 `members` 里 → 旧组继续往它推音频
  = **双成员 / 双流**（同一首歌卡顿 + 双声叠加）。正是 §8.2 row 13 挂账的 MA 不对齐。
- **根因**：`joinGroupCore` 直接 `conn.group = g; g.add(conn)`，**没有把 conn 从旧组摘掉**。
- **修复**（对齐 MA/aiosendspin `add_client` 首步 `client.ungroup()`）：
  - 入组前先 `old.remove(conn)`，并清掉旧组残留的 `pendingAnnounces`（避免旧组
    `pushFrame` 给已离组 conn 重发 `stream/start` 造成双流）。
  - 旧组若仅此一员（独立播放组的典型形态）→ 停空转 pump + 关编码器 + 从 registry 移除。
  - 顺带让「加入群组中止原独立会话」（选项 A）**自然成立**：独立播放组的 `conn.group`
    就是该客户端专属组，换组时它正是被 `ungroup` 的旧组。
- **验证**：`tsc --noEmit` 通过；新增 2 例回归（独立播放转组不双成员、他组再入新组从旧组
  摘除且旧组其余成员不受影响）→ `playerGroup` 5/5 + `childMain` 13/13 全绿。
- **文档**：`docs/sendspin-权威方案文档.md` §8.2 row 13 `⚠️待修 → ✅已实现`；§11.3 挂账项清零。

### 附：发版前 CI 一处 flaky（非本版本问题）

- `tests/services/flow.test.ts` 的 `abort 幂等且让 done 收敛` 在负载高的 runner 上偶发
  15s 超时（该用例用 30s 输入、依赖 abort 收敛 `done`，属转码流水线测试，与本期
  sendspin 改动**零代码路径关联**——`flow.ts` 不 import `playerCore`/`services/sendspin`）。
  首次触发时该 job 报红，重跑即通过，CI 整体转绿。**未改动 flow 测试代码**。

## [4.0.20] - 2026-09-24

### 修复：播放中加入成员 → 整组一卡一卡（时间线把「并集」当成推进量）

- **现象**：FLAC 链路上，播放中把 Sendspin 播放器加入群组后，**整组**开始一卡一卡。
  指纹：**只有当前这首坏，切到下一首就正常**。
- **根因**：`pushFrame` 给每个成员各建一个编码器，而 libFLAC 是**块编码器** ——
  攒满 4096 样本（≈ 85ms）才吐一帧。各编码器的**块相位由创建时刻决定**，彼此错开；
  而时间线推进用的是「每批各成员产出取 **max**」：

  | 批 | 成员 A | 成员 B | 旧口径推进量 | 真实上网音频 |
  |---|---|---|---|---|
  | k | 吐一帧 4096 | 吐 0 | 4096 | 4096 |
  | k+1 | 吐 0 | 吐一帧 4096 | 4096 | 4096 |
  | 合计 | | | **8192** | **4096** |

  即把 A、B 两批的**并集**当成了本批推进量 → 真机净超速 **1.44×** → 时间戳跑到墙钟
  前面 → 设备排程跟不上 → 反复 `Lost sync` / 插静音。新曲全员同时重建编码器、
  相位重新对齐，所以切歌即恢复。
- **修复**（两处，均对齐 MA/aiosendspin）：
  1. **按 `(codec, gain)` 分组编码** —— 同一份 PCM + 同一 codec + 同一增益编出的字节
     **逐字节相同**，故同组只编一次、字节与时间戳分发给全组。副作用：CPU 降为 1/N
     （libFLAC 是进程内同步 asm.js 编码，直接占事件循环）。对齐 aiosendspin
     `TransformerPool`（按 transform key 共享编码器）。
  2. **时间线改为「max-of-累计」的上包络增量** —— 每个编码组维护累计交付样本，
     推进量取 `max(累计)` 的增量：相位错开相互抵消，长期**严格等于**真实上网的音频量。
     `deliveredPeak` 单调不减，且新编码组以**当前峰值**为基线登记，所以成员增删
     （含播中加入）都不会让时间线倒退或停滞。

### 修复：新加入的设备要等很久才出声（缺 late-join 回填）

- **现象**：播放中把新设备加进组，要等**约 29 秒**才出声。
- **根因**：预填充让组时间线游标**领先墙钟一整个水位**（30 秒档实测 29995ms，见日志
  `预填充水位按设备容量钳制`）。新成员只收得到**未来帧**，首帧时间戳落在 29 秒之后
  → 只能空等到那一刻。不是代码写错，而是**只发了未来、没补齐过去**。
- **修复**：`SendspinGroup.seedLateJoin` —— 对齐 aiosendspin `PushStream.on_role_join`
  （`_send_cached_chunks_to_role`）。组内按**编码组**保留「**尚未播到**」的音频缓存
  （`recentByGroup`；逐出规则 `ts + dur ≤ now − 1s`，对齐 `_prune_role_chunk_cache`），
  新成员加入时把起点 ≥「late-join 目标时刻」的 chunk **立即回放**，之后无缝接实时流：
  - 目标时刻 = `now + send_ahead + LATE_JOIN_MARGIN_US(100ms)`。设备按
    `ts − send_ahead` 决定何时播，故「不在过去」的充要条件是 `ts ≥ now + send_ahead`。
    注意 **late-join 不能自选提前量**（起播锚点才可以）—— 必须贴住既有时间轴，
    否则新老成员就错开一个提前量；
  - **先兑现 `stream/start`（`pendingAnnounces`）再推缓存字节** —— 反过来设备会因缺
    `codec_header` 而丢弃缓存帧；
  - 按设备容量钳制回填总量，不把设备一次性灌满。
- **为何不会撑爆设备缓冲**：回填 29.1s ≈ 2.79MB < `buffer_capacity` 4.8MB；此后
  「收到速率 = 播出速率」，差值恒定为 `29995 − 900 = 29095ms`，稳态不增长。
- **常量**（取值对齐 aiosendspin）：`LATE_JOIN_MARGIN_US = 100_000`
  （`LATE_JOINER_MIN_LEAD_US`）、`LATE_JOIN_KEEP_PAST_US = 1_000_000`
  （`_HISTORY_KEEP_PAST_US`）、`LATE_JOIN_RING_MAX_US = 35_000_000`。

### 真机验收（240，受控复现）

脚本 `/root/lj_test.sh`：移出成员 → 组起播（FLAC）→ 等 45s 灌深水位 → **播中加入** →
观察 75s → `/root/an_latejoin.py` 分析。

| 观测项 | 修复前 | 修复后 |
|---|---|---|
| 新成员出声 | ≈ 29s（空等一个水位） | **≈ 0.1s** |
| 群组播放速率 | **1.44×** | **1.00×** |
| `SYNC LOST` / `Lost sync` | 持续风暴 | **0 / 0** |
| 编码器零产出 / `pushLoop` 退出 | 频发 | **0 / 0** |
| `timeline RE-anchored` | — | **0**（流全程未重启） |

关键日志：`sendspin late-join 回填: chunks=341 span=29099ms target=882706us(ahead of now)`。
`882706 = send_ahead 800000 + margin 100000`；`341 × 85.33ms ≈ 29099ms`（同时反证
libFLAC 块粒度是 85.33ms，不是 25ms）。

### 测试

- 新增 `tests/sendspin/pushFrameGroupEncode.test.ts`（10 例）：钉住按组编码的字节/时间戳
  一致性、`max-of-累计` 的推进量、成员增删不倒退、同批多帧的 ts 递增。
- 新增 `tests/sendspin/lateJoinBackfill.test.ts`（8 例）：钉住回填语义（有缓存→立刻回填、
  首帧不在过去、截止于组游标、刚起播不回填、只剩过期缓存不回填、`available:false`
  不回填、容量钳制、按编码组取字节）。
- `playerGroup.test.ts` 的「播中加入」用例改为覆盖两条**都合法**的路径（有缓存→回填 /
  无缓存→挂 `pendingAnnounces`），共同不变量是 **`stream/start` 绝不早于该成员首块音频**。

## [4.0.19] - 2026-09-24

### 修复：FLAC 链路完全无声（codec_header 的 last-metadata-block 位）

4.0.18 把 `stream/start` 延后到「首块音频就绪」才发，这才**第一次**真正把编码器的
**真实 STREAMINFO** 当作 `codec_header` 送出去，于是暴露了一个字节位的错误。

- **根因**：真实流里 STREAMINFO 之后还跟着 VORBIS_COMMENT / PADDING，libFLAC 因此把
  块头写成 `0x00`（last-metadata-block = 0）—— 对**完整流**这是对的。但 `codec_header`
  是**单独**发给设备初始化解码器的，之后设备直接收裸音频帧：照抄 `last=0` 会让解码器
  读完 STREAMINFO 后继续按「元数据块」格式解析下一段，撞上 FLAC 帧同步码 `0xFF`
  → 块类型字段 = `0x7F`(127) 属**非法类型** → 解码状态机失败。
  表现极具迷惑性：**服务端日志全绿、进度照走、设备零报错，但完全无声。**
- **实证对照**（240 真机，同一台 esp32-player-meet，两组值**仅第 5 字节不同**，
  其余 41 字节完全一致：48k/2ch/16bit/block 4096）：
  - v4.0.17 发 `ZkxhQ4AAACIQ…`（第 5 字节 `0x80`，last=1）→ **有声**；
  - v4.0.18 发 `ZkxhQwAAACIQ…`（第 5 字节 `0x00`，last=0）→ **无声**。
  之所以上一版恒为合成头：v4.0.17 的 `pushFrame` 在 `encode()` **之前**就兑现宣告，
  编码器尚未产出任何东西 → `realFlacHeaderB64` 恒为 `undefined` → 回落合成头（自带 last=1）。
- **修复**：`flacCodecHeaderFromStream()` 把块头的 last 位**强制置 1**（只改这一位，
  其余 41 字节仍逐字节取自实流 —— 保留真实头不会与实流漂移的优点）。
- **测试**：`encoding.test.ts` 新增回归用例，钉住「输入 last=0 → 输出 last=1」且
  「其余 41B 与实流逐字节一致」。

### 修复：进度条／歌词从缓冲深度起跳（预填充的副作用）

- **现象**：预填充设成 10 秒后，所有歌曲一开播进度条和歌词就直接显示 `00:10`，
  而声音明明是从头开始的（其它档位同理，偏移量 = 档位值）。
- **根因**：对外上报的 `group.positionMs` 此前是**已推送位置**。预填充把「已推送」和
  「已听到」拉开了整整一个缓冲深度 —— 服务端抢先灌满缓冲时，设备才刚要出声。
- **修复**：上报改为**可听位置** = 已推送位置 − 当前设备缓冲深度
  （`cursorUs` 与 `nowUs()` 同为 host monotonic 时钟，可直接相减）。取帧仍用
  `playCursorMs`，只有对外上报换口径。曲末排空期间改为分段等待并持续刷新上报位置，
  让进度平滑走到曲末（一次睡到底会让进度停在 `durationMs` 之前，拖后自动切歌判定）。
- **保住 seek 语义**：可听位置带**下界** `reportedFloorMs`（本轮起播位置 / seek 目标）。
  正常起播下界为 0 → 开播即 `00:00`；拖到 40s 时下界为 40s → UI 立刻显示目标值，
  不会被「缓冲还没建立」拉低成 39.2s（MA `controller.py:862` 的 `elapsed_time` 防回跳语义）。
- **测试**：`streamPumpSeek.test.ts` 两处「出帧即断言位置必增」改为轮询等待推进 ——
  起播后有一段锚点提前量（≈0.8s）的静默期，此刻声音未出、进度**理应**停在起点。

### 缓冲深度档位扩充 + **按设备容量自动钳制**（「匹配好」）

Sendspin 插件页「设备缓冲深度（抗卡顿）」下拉新增 **15 / 20 / 25 / 30 秒**四档
（原有 0.8 / 1.5 / 3 / 5 / 10 秒保留）。

**关键：档位从「想填多少就填多少」改为「期望水位」，实际水位还要匹配设备自己宣告的缓冲容量。**

- **容量从哪来**：设备在 `client/hello` 的 `player@v1_support.buffer_capacity` 里宣告
  （真机实测 `1600000`）。单位是**字节** —— ESPHome 源码实锤：
  `components/sendspin/__init__.py` 把 `CONF_BUFFER_SIZE`（`media_source` 里
  `cv.int_range(min=25000)`，明显是字节）塞进 `audio_buffer_capacity`；
  aiosendspin 同名字段作 `BufferTracker(capacity_bytes=...)` 消费。
  协议硬约束：`server sends audio chunks as far ahead as the client's buffer capacity allows`。
  本仓此前**完全没读这个字段**。
- **换算**：`可用字节 = buffer_capacity × 0.6`，除以**实测压缩码率**（推流中累计
  「压缩字节 ÷ 音频秒数」，按首清零）得到设备装得下的最长秒数；
  再与 30 秒时长上限（= aiosendspin `PlayerPersistentState.max_duration_us` 默认
  `30_000_000`）取小。两道尺独立生效，与 aiosendspin 一致。
- **真机 A/B 实证**（esp32-player-meet，`buffer_capacity=1600000B`，FLAC 实测 105052 B/s）：
  - 灌到 **100%**（档位 30s 按容量满额钳到 15230ms）→ 设备在 **PLAYING 后 15.30 秒**
    开始连续 `sendspin.player: Failed to send audio chunk`（= 缓冲满、逐帧拒收），
    并伴随 `Lost sync (85352us off)` 风暴。15.30s 与 `1600000/105052 = 15.23s` 吻合。
  - 留 **0.6 余量**（钳到 9138ms）→ 100 秒全程 `Failed to send audio chunk` = 0、
    `Lost sync` = 0。
  - 三首不同曲目的钳制结果在**字节口径上恒为 60%**（0.96MB / 1.6MB），换算链路自洽。
- **为什么留余量而不是像 aiosendspin 直接用 100%**：aiosendspin 累计的是每个 chunk 的
  **真实压缩字节数**；本仓按时长记账（`depth = cursor − now`，再乘平均码率换算），
  加上每 chunk 协议头开销与最多一帧（25ms）水位过冲，按 100% 算必然踩线。
- **设备未宣告容量时不受影响**：退回 30 秒上限，行为与本版之前**完全一致**（向后兼容旧固件）。
- **想用更深的档位**：请调大 ESPHome 的 `buffer_size`（容量越大，同一比例对应秒数越多），
  而不是期望把比例调高。插件帮助文案已写明此关系与实测数据。

### 修复：`client/state` 取值层级错误（真机 RAW 实测校正）

补协议缺口的同一条日志意外暴露了取值位置错误 —— 真机实发 payload 为：

```json
{"state":"synchronized","player":{"volume":53,"muted":false,"static_delay_ms":0}}
```

- `state` 在**根层**，不在 `player` 里；而 `output_delay_ms` / `required_lead_time_ms` /
  `min_buffer_ms` / `available` / `buffer_capacity` 该固件**一个都不发**。
  也就是说：此前日志里的 `output_delay=0ms required_lead=0ms min_buffer=0ms`
  是**缺省值**，设备从未真正上报过 —— `send_ahead` 一直走保守缺省 800ms。
  本版改为 `state` / `available` / `buffer_capacity` **根层优先、`player` 层回落**，
  两处都读；并额外解析 `player.static_delay_ms`（设备输出链路固有延迟）。
- **失步时间线自有证据**：设备只在状态**翻转**时才发 `client/state`，故新增
  `SYNC LOST (state=error)` / `synchronized` 变化日志 —— 排查「偶发卡顿」以前只能靠
  设备侧 ESPHome 日志，现在服务端可自证。
- **`stream/start` 门控**：spec 要求 `server MUST NOT send stream/start unless the latest
  client/state reports available:true`，此前完全未做。现按「设备**明确上报过**
  `available:false` 才拦，且 3 秒超时兜底」实现：未上报 `available` 的固件（真机即如此）
  行为零变化，绝不因新增门控砸掉旧设备。

### 本版验证

- **单元/集成回归**：`186` 个测试文件、`1581` 个用例全绿；其中新增
  `backend/tests/sendspin/prefillCapacity.test.ts`（17 例）钉死容量解析、
  百分比换算、名义码率回落、下限钳制与「未宣告容量 → 退回 30s」的兼容语义。
- **240 真机**：FLAC 链路出声（设备 `Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit`
  → `State changed to PLAYING`）；进度从 `00:00` 起 1:1 递增；30 秒档按容量钳制后
  100 秒零拒收、零失步。

## [4.0.18] - 2026-09-24

### Sendspin —— 抗卡顿：设备缓冲深度可配（预填充／回补）＋ 推流循环不再饿死事件循环

针对「ESP32 Sendspin 播放时不时卡顿」的服务端两条硬修复，并把它做成 Web 可随时调整的配置项。

- **新增插件配置项「设备缓冲深度（抗卡顿）」**（Sendspin 插件页下拉档位）：
  `0.8 秒（关闭预填充，等同旧行为）` / `1.5 秒` / `3 秒（推荐）` / `5 秒` / `10 秒`。
  改完**立即生效**（推流循环每 5s 重读配置，无需重启、不中断当前播放）。
- **预填充 / 卡顿后自动回补**（`services/sendspin/streamEngine.ts`）：
  此前设备侧缓冲深度**恒等于首帧锚点（800ms）** —— 服务端按实时速率推、设备按实时速率播，
  差值永远填不满，所以「想缓冲 10s」只能靠把锚点抬到 10s，代价是**起播静默 10 秒**。
  现在两者解耦：**锚点固定 800ms（起播延迟不变），缓冲深度由推流循环在首帧后尽快灌满**；
  编码器/音源停顿时缓冲被抽干，恢复后还会**自动补回**目标水位（旧行为补不回来 → 持续卡顿）。
  对齐 MA：producer 领先消费端填充，直到客户端 `buffer_capacity` 上限。
- **推流循环落后时让出宏任务**（B2）：原 `if (delayMs > 0) await sleep(delayMs)` 在落后时
  **没有任何让出点** → 整条 `pushLoop` 退化成微任务自旋，WebSocket 的 I/O 回调（含设备发来的
  `client/time`）排不上队 → 设备侧 `Time message N/8 timed out` → 重同步 → 卡顿。
  现在落后时 `await setImmediate`（对齐 MA `connection.py` 每 50 次迭代 `asyncio.sleep(0)`）。
- **曲末排空**：缓冲变深后，曲末若立刻发 `stream/end`，协议要求客户端**清空缓冲**，
  设备里还没播的音频会被砍掉。现在先等设备播完缓冲再收流（只等超出旧水位 800ms 的那部分，
  尾部截断量与旧行为一致），且排空放在 `running=false` **之前**，避免外部误判「已停却仍在播」。
- **配置读取**：`readSendspinPluginConfig()` 新增 `prefillBufferMs`
  （`normalizePrefillBufferMs` 归一化，区间 100–30000ms，非法回落 3000）。
- **修复：播放中加入群组的新播放器（FLAC 链路）不出声**（`services/sendspin/playerCore.ts`
  + `server.ts`）：播中加入原本**在加入瞬间就发 `stream/start`**，但 FLAC 是块编码器
  （libFLAC 自选块大小 ≈4096 样本 ≈85ms），新成员的编码器要攒满一块才吐首帧 ——
  「先宣告、后等货」留出空窗，设备据此丢弃该流（本文件已记录过的同型事故：收到
  `Stream Started` 却不做 codec header 处理、扬声器不启动 = 无声）。PCM 每批即刻产出，
  所以只有 FLAC 暴露。
  改为与起播路径一致：`stream/start` 挂入 `pendingAnnounces`，由 `pushFrame` 在
  **该成员首块音频就绪时**才兑现（对齐 MA `_pending_stream_start`）。
  附带收益：`codec_header` 此刻必为该成员编码器的**真实 STREAMINFO**，不再回落合成头。
- **测试**：`pluginConfig.test.ts` 新增档位/越界/非法归一化用例；`playerGroup.test.ts` 桩音源
  由 1s 加长到 30s（预填充灌满后仍按实时推，播中加入才收得到直播帧）并新增
  「stream/start 必须延后到首块就绪」断言；`childMain.test.ts` 同步更新该语义；
  `queueModes.test.ts` 桩曲长 300ms → 5s（曲长短于缓冲时整首会被瞬间灌完，
  「按实时播完 → 自动切歌」的仿真前提不成立）。sendspin 36 文件 203 例全绿。

## [4.0.17] - 2026-09-24

### 群组 —— 容器语义恒在线 + 点群组即切 MINI 遥控栏

- **组是「容器」不是设备，可用性恒为在线**（`services/peer.ts::reconcileGroupPeers`）：
  注册组时 `available` 恒 `true`，空组、成员全部离线也显示在线。成员各自的在线状态仍由
  `GroupManager.resolveMemberStates()`（按成员 id 命名空间分派的唯一真相源）推导，
  汇总成 `onlineCount` **只供前端展示「x/y 在线」**，不再反向决定组行可用性。
  历史两版都把「容器在线」误当成「内容物在线」：① 只查 DLNA 设备缓存 ⇒ sendspin 组恒离线、
  被流转选择器按 `available` 剪掉整行；② 改 `some(m => m.available)` ⇒ 空组/成员离线时组又变离线。
- **点群组 = 切换 MINI 遥控栏 + 进入管理模式**（`frontend/src/layouts/MainLayout.vue`）：
  `toggleGroupManage` 内先 `await playerStore.switchPeer(gid)`，把 MINI 播放器栏切到该群组，
  再展开成员勾选（保留弹窗/抽屉，这是与 `onSwitchPeer` 的差异）；移除群组行的 ▶ 按钮
  （与勾选圈职责冲突）；组行状态标注：空组 → `layout.groupEmpty`，有成员 → `layout.groupMembersOnline`。
- **测试**：`tests/services/groupPeerAvailability.test.ts` 重写为 7 例（组恒在线 + `onlineCount`
  汇总，保留旧语义的负向验证，回退即红）。
- **i18n**：新增 `layout.groupEmpty` / `layout.groupMembersOnline`（zh + en）。

### 工程

- `scripts/sendspin-monitor-240.sh`：匹配串 `pollDBG` → `[QueueController][poll]`（poll 日志改
  debug 级后旧串不再出现，脚本此前**静默漏采**）；新增位置回退 >5s 的 `REWIND`、链路不可用连续
  3 轮的 `LINKDOWN`，卡顿指纹（PUSHBREAK / ENCSTALL / WINEOF / CURSORLAG / LOOPLAG / LOOPDEATH）
  统一写带时间戳的 `[ALERT]` 行；新增高采样率变体 `scripts/sendspin-hires-240.sh`。
- **版本号守卫**：新增 `backend/scripts/check-release-version.mjs` + `.github/workflows/version-guard.yml`
  —— 版本号必须是数字（vX.Y.Z），`main` / `master` / `latest` 等分支名一律判红；静态禁止 workflow
  把 `github.ref_name` 当版本号（推分支时它等于 `main`）；监听 `tags: ["*"]` 以便非法 tag 进来就被判红。

### 验证

- `backend tsc --noEmit` 0 错；`frontend vue-tsc --noEmit` 0 错；
  全量 vitest **186 文件 / 1579 例全绿**；7 个 `check-*.mjs` + `check-i18n` 全通过。

## [4.0.16] - 2026-09-23

### 功能 —— 群组音量持久化（空组也落库）+ 默认 20 + 卡顿监控文档

- **组音量落库**（`player_groups.volume`，0–100 整数）：
  - `schema.ts` 与 `db/index.ts` 的 `CREATE TABLE player_groups` 同步加 `volume INTEGER NOT NULL DEFAULT 20`（无 `ALTER TABLE`，老库按约定重建）；
  - `GroupManager`：新建组默认 **20**（用户定稿，替代原 100）；`getVolume` / `setVolume`（钳位 + `persist` + `group_updated`）；`loadFromDb` / `persist` 读写 volume；
  - **无成员也持久**：空组 / 全离线调音量重启后恢复；改成员、改名不覆盖已存音量。
- **写路径**：
  - 路由 `POST /v1/peers/:peerId/volume` group 分支：**先** `gm.setVolume` 落库，再 `transport` 扇出（扇出失败不回滚库值）；
  - `GroupProtocolPlayer.setVolume`、`createSendspinGroupPlayer.setVolume`：先落库再下发。
- **回显**：`getGroupStatus` 音量权威 = GroupManager 持久值（空组/全离线也回显）；sendspin leader 有实时组值则用实时，DLNA leader 覆盖为持久组音量。
- **ug 懒创建回填**（子进程 `SendspinGroup.volume` 缺省 100 的对称修复）：
  - 起播 `playMedia`、成员加入对齐 `alignGroupMembers`、看门狗成员回归：入组/起播前 `sendspinGroupTransport(ug, "volume", gm.getVolume(id))` 灌入持久值。
- **测试**：3 个测试文件内嵌 `CREATE TABLE player_groups` 补 `volume` 列；`GroupManager` 新增 3 例（默认 20 / 空组持久重启恢复 / 钳位与事件 / 改成员改名不丢音量）；GroupPlayback·GroupWatchdog 的 `getGroupManager` stub 补 `getVolume`/`setVolume`。
- **文档**：新增 `docs/STALL_MONITORING.md` —— 多线程容器卡顿监控方法（`sendspin-monitor-240.sh` / `sendspin-hires-240.sh` / `pull-240-monitor.sh` 部署、事件判读、排查顺序、盲区、DLNA 对照）。
- **验证**：`tsc --noEmit` 0；组相关 5 个测试文件 44 用例绿；`check-i18n` 0。

## [4.0.15] - 2026-09-23

### 对齐 MA —— ffmpeg 解码参数（P0）+ 滑动窗口 300s（BALANCED）

- **ffmpeg 参数对齐 MA（P0）**（`audio/pipeline.ts`）：
  - 新增 `INPUT_READ_ARGS`：每输入自带 `protocol_whitelist` + `probesize 8096` + `analyzeduration 500000`（对齐 MA `_INPUT_READ_ARGS`，起播/切歌不再等满 5MB 默认探测）；
  - 新增 `HTTP_RECONNECT_ARGS`：http(s) 输入补 `-reconnect 1 -reconnect_delay_max 10 -reconnect_streamed 1 -reconnect_on_network_error 0 -reconnect_on_http_error 5xx,429`（对齐 MA `get_ffmpeg_args` 重连窗）；
  - 全局补 `-nostats -ignore_unknown`。
- **滑动窗口 30→300 秒**（`sendspin/streamSource.ts`）：`WINDOW_HIGH_SEC=300` / `WINDOW_LOW_SEC=290`（滞回 10s 同宽），对齐 MA `BUFFER_SIZE_MAP[BALANCED]`（240 ≥4GB 落 BALANCED）。未消费前沿 PCM 上限 ~115MB（Buffer 外部内存，不占 V8 老生代）；5 分钟曲内 seek 回跳几乎总能命中窗口。
- **概念分层写清**：300s = 服务端 PCM 解码环；MA `_PRODUCER_BUFFER_LIMIT_US`（30→60s，发送侧推流背压，MA 源码侧已改）是另一层，注释与设计文档 §2.5 已区分。
- **插件 help（中英）与设计文档同步**：30s/11.5MB → 300s/115MB；`SENDSPIN_MULTIROOM_STREAMING_PLAN.md` §2.1/2.2/2.5/§A 重写（60→30→300 演进、水位 290/300、MA 侧 60s ≈26MB）。
- **测试**：pipeline / transcode / streamSource 相关用例同步；`tsc --noEmit` 0；`check-i18n` 0。
- **240 热补丁核验 + CPU 峰值压测**：容器内 grep 全部参数在位、`/ping` ok；12–16×`yes` 忙等使 loadavg 峰值 23.11，期间 `state=PLAYING` 位置线性推进、无 STALL；20:11:44–51 卡顿反馈经 events/docker 日志对齐为**自然切歌**（`contentEnded` → `advance` → dur 170→126），非卡死。

## [4.0.14] - 2026-09-23

### 优化 —— 播放优选：WebDAV 可播「成功记忆」（跳转性能 F 项）

- **问题**：`utils/localSourceProbe.ts` 只记**失败**（`localFailCache` 5 分钟），成功不记。
  而「这首歌的 WebDAV 源可播」这个结论在**每次起播 / 每次 seek** 都被重新探测一遍 ——
  240 实测单次 `probeLocalSourceOk` = 597~1410ms，`resolvePlayableRow` 的 `preferred-swap`
  因此要 1.7~2.0s（judge 一次 + 出流一次，成对出现）。
- **做法**：新增与失败记忆**对称**的成功记忆 `webdavOkCache`（TTL 同为 5 分钟）：
  - **只缓存 WebDAV 分支** —— 本地 `l:` 走 `existsSync` 零成本，缓存它零收益，
    反而会引入「文件已删却仍返回死行」的风险；
  - 对外暴露 `evictProbeOk(songId)`，**出流失败**（源行缺失 / 非 2xx / 取流异常）时逐出，
    接线在 `resolveAudio.ts` 的 `fetchRowBytes`;
  - 缓存条目上限 512，超出先清过期再丢最旧，防无界增长。
- **收益（240 真机）**：同一首 WebDAV 行连测 3 次 `probeLocalSourceOk`：
  831ms → **0ms → 0ms**；`preferred-swap` 裁决 2007/1731/1758ms → **957/810/727ms**（约 -55%）。
  `resolvePreferredSong` 的 6 个调用点自动受益，无需改动任何链路。
- **测试**：新增 `tests/utils/webdavOkCache.test.ts` 5 例（命中 / 过期 / 逐出 / 失败不记 / 本地分支不参与），
  并做负向变体验证守卫会红（破坏命中判定 → 2 红；`evictProbeOk` 置空 → 1 红；还原后 5 绿）。
  全量回归 185 文件 / 1568 用例全绿，`tsc --noEmit` 与 9 个 CI 门禁全 0。

## [4.0.13] - 2026-09-23

### 优化 —— seek 取流：回环 raw 流加 256KB 稀疏块缓存（跳转性能 B 项）

- **问题**：ffmpeg 对**无 SEEKTABLE** 的网盘 FLAC 做输入 `-ss` 时会发 9 次**开放式 Range**
  （每次往前退一点、读到文件尾），每次一个上游往返，累计 **4~13s** 才出声。
  旧的回环 raw 分支是**纯透传**，这些回溯请求一个都省不掉。
- **做法**：新增 `services/dlna/rawStreamCache.ts`，把 `/rest/dlna/stream/:token?raw=1` 从纯透传
  升级为 **256KB 稀疏块缓存代理**（`proxyRawRange`）—— 未命中时透传并顺带镜像、命中时本地供给
  零上游往返；未命中时**并行补「块首 → 请求起点」前缀**，让 ffmpeg 逐步往前退的回溯 Range 能命中。
  五条链路的 seek 都走同一段 `-ss`（`audio/pipeline.ts`）⇒ **Sendspin / DLNA / 客户端 / Web / AirPlay 一起受益**。
- **形态红线（四轮 240 真机事故沉淀，离线单测测不出来）**：
  ① 响应头必须在上游响应头到达后**立刻发出**、数据边下边喂（「先把窗口下完再回话」会把首响应
  拖到几十秒 ⇒ 前奏无声 / 拖动卡住）；② 后台补块**不得带客户端 signal**（ffmpeg 读几百字节就断连，
  会把补块自己掐断，缓存永远补不上）；③ 续接上游必须**一条请求读到完**（逐 chunk 现场开请求 ⇒
  26MB 顺序播放退化成 ~100 次小请求，真机 21 分钟零输出）；④ 续接交给上游后**不得再回头读缓存**
  （上游顺序覆盖 ⇒ 同一段吐两次，总长不变、只有 md5 看得出）。
- **兜底与降级**：上游 5xx 先重试一次，仍失败则让下游看到错误而**不是假 EOF**（静默结束会被
  当成「播完了」自动切歌）；任何异常路径一律回退旧透传 + `[rawStreamCache]` 告警（30s 节流）；
  `RAW_STREAM_CACHE=0` 可整体回到纯透传（A/B 对照用）。
- **效果（240 真机，26MB 天翼网盘 FLAC）**：整曲回环长度与直连一致、**md5 三方全等**（直连×2 + 回环）、
  `upstream=0`；端到端 `ffmpeg -ss` 冷态 **1.3~1.9s**（旧基线 3.4~8.9s）、同曲热态 **31ms**。
  **已知差距**：回溯序列实测 5 次只命中 1 次（补块 TTFB ≈450ms 与回溯间隔同量级），
  「9 → 1~2」属设计目标、真机未达成 —— 收益主要来自**整曲续读走缓存 + 热态重放**。
- **验证**：新增 24 例单测（真 HTTP 上游：分片慢给 / 只发头不发 body / 整块 416 / 5xx 注入）；
  负向矩阵 12 变体（11 条守卫各自精确变红 + V1b 对照组全绿）；全量 184 文件 **1563 用例全绿**；
  9 个 CI 门禁脚本全 0；240 真机四轮实测 + 用户收听验收通过。

## [4.0.12] - 2026-09-22

### 修复 —— 拖拽 seek 打死 sendspin 子进程（整秒契约）+ 取流重建加固

- **根因**：sendspin 流式引擎按 **25ms 帧栅格**取帧（`lo = floor(pos/25) * 2400` 样点），而滑动窗口
  基准是「毫秒 → 样本」换算（`base = floor(pos/1000 * 48000 * 2)`）—— **只有目标为 25ms 整数倍时两者相等**。
  HA 卡片 / 网页把当前播放位置原样下发（31.178s / 30.178s 这类毫秒精度）→ `lo < base` →
  `PcmWindow.slice()` 抛 `WindowEvictedError` → 主循环 `continue` 用**同一个游标**重算 → 再抛 →
  纯微任务自旋（不 await I/O）→ 事件循环彻底饿死 → 心跳与 `poll` RPC 全排不上队（管辖进程记
  `悬挂 RPC 12~15 个` / `最后消息 71s 前`）→ **65s 看门狗 SIGKILL** → 重启 → frozen 兜底重投
  （位置仍是毫秒精度）→ 再挂。现象：拖完进度条播放静默死掉、进度冻住。
  客户端下发 `Duration.inSeconds` 恒为整秒（1000/25 = 40），所以**从来只有 HA 卡片与网页会挂**。
- **三层防御（引擎）**：①新增 `alignFrameMs()` 帧栅格对齐，在 `play()`（源起点 + 游标）、`seek()`
  （发布位置 + 记忆）、`armSeek()`（装填）**四处统一**向下取整到 25ms（代价 ≤24ms，不可闻）；
  ②`PcmWindow.slice()` 亚帧容错 —— 只在请求段与窗口**全无交集**（`hi <= baseSample`）时才抛错，
  `lo < base < hi` 时钳到 base 返回短帧；新增 `get baseMs()`；③pushLoop 淘汰护栏 —— 淘汰分支把
  落后于窗口基准的游标**贴齐**到 `ceil(baseMs / FRAME_MS) * FRAME_MS` 并重锚 pacing（+ warn 取证），
  保证「每轮淘汰必然前进」，机制上杜绝自旋。
- **唯一入口兜底**：`POST /v1/peers/:peerId/seek` 经 `alignSeekSeconds()` 统一向下取整 —— 任何来源
  （HA 卡片 / 网页 / 第三方客户端）都不可能把非整秒目标送进引擎。
- **取流重建加固**：并发 `play` 世代守卫、重建失败告警 + 子进程 loop 自检、音源获取 30s 熔断。

### 门禁

- 新增 `backend/scripts/check-seek-granularity.mjs`（6 条规则：两侧 util 导出、后端路由必须兜底、
  前端每个 `/seek` 下发站点必须对齐、不得有未识别的 `/seek` 字面量、引擎 `alignFrameMs` 应用点 ≥5
  且 `WindowEvictedError` 仍在），挂 `ci.yml` 新 job。
- 新增 `backend/tests/utils/seekGranularity.test.ts`（截断语义 / 整秒恒等 / 25ms 帧栅格不变式 / 非法归 0）。
- 新增 `streamSource.test.ts` 2 例（亚帧钳制返回短帧 / 真淘汰仍抛错）、`streamPumpSeek.test.ts` 3 例。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.12` + `:latest`
- 配套：客户端 **v5.0.28**／HA 卡片 **v2.4.8**／HA 集成 **v2.0.5**（同一批次）

## [4.0.11] - 2026-09-22

### 调试日志补全（seek 全链路）

- AirPlay protocol seek：入口＋结果＋耗时（原裸调，成败靠猜）
- sendspin `seekCore`：请求值／钳制结果／有无在播／重建耗时／ephemeral 回落
- DLNA（cast/seek/guard/status）、group 扇出、transport 入口：既有覆盖不变
- 零行为变更；配套客户端 **v5.0.26**

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.11` + `:latest`

## [4.0.10] - 2026-09-22

### 修复 —— 拖动后切歌／从头重播（240 联调实锤三连）

- **同歌重投误判换歌**：`track_changed` 用全 URI 字符串比较，重投只改 `?timeOffset` 也算"换歌"→自动 advance。比较前剥 query（真换歌 token 必变，不受影响）；回归单测锁定。
- **重投间隙 STOPPED 清基线**：Stop 生效期的瞬态 STOPPED 走 else 分支删掉 seek 锚点，随后 PLAYING rawPos=0 只能就地播种 0 → 进度/歌词从头重爬。保护窗内保留基线并回填预期位置；重投路径补开保护窗。
- **手动 next/prev 归因日志**：`[Peer] 手动切歌`，区分误触与自发切歌（此前 playCurrent 无决策无请求，无法定案）。
- 三链路核查：sendspin（pump 设目标值）／AirPlay（原地 FLUSH 保 position）／group（透传成员）无同类瞬态清锚逻辑，不用动。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.10` + `:latest`

## [4.0.9] - 2026-09-22

### 修复 —— DLNA 重投风暴串行化 + Web 投屏跟手保护

- **重投风暴串行化**：连续拖动产生背靠背完整重投（Stop/SetURI/wait/Play），小设备 HTTP 栈被打死后全 500（240 联调实锤：5 连拖）。同设备重投排队串行＋400ms settle 收敛到最新目标＋世代号后来者胜，旧重投在 Stop/SetURI/wait/Play 检查点退出（`SeekSupersededError`，不记失败）。
- **Web 投屏跟手**：拖拽标志（拖拽中 tick 不推进手指值）＋分母未知不发 seek＋尾部 `duration-0.5s` 钳位＋换歌/停轮询清理 seek 状态（与卡片 seekDragging、客户端因果屏障同构）。
- 配套客户端 **v5.0.25**（看门狗意图作废＋间隙 0 屏蔽）。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.9` + `:latest`

## [4.0.8] - 2026-09-22

### 修复 —— 同歌 seek 重投被 tracker 误判为换歌，自动 advance 切下一首（HA 卡片/客户端同病）

**根因（240 真机日志实锤）**：拖动进度触发「重投流重建」时，`createCastSession`/
`createAirPlaySession` 每次 mint **新 token** → 设备 TrackURI/mediaUri 随之变化。
`PlaybackTracker` 的 native gapless 判据「PLAYING 且 uri 变 = 换歌」
（PlaybackTracker.ts:165）把同歌重投误判成换歌 → `track_changed` → 自动 advance。
4 次拖拽 2 次中招；轮询恰好采到 BUFFERING 瞬态时幸免，故体感「拖到靠近结尾必切下一首」。
HA 卡片与客户端共用后端队列，两边同时中招 —— 与前端无关。

**修复（对齐 MA「同一队列项流 URL 恒定」语义）**：
- `createCastSession`（DLNA + sendspin mediaUri 共用）：同 (songId, deviceId)
  未过期会话**复用 token、仅续期**（6h TTL 内同歌重投 TrackURI 不变）。
- `createAirPlaySession`（AirPlay 独立会话）：同样复用（SQLite 主路径 +
  内存回退路径）。换歌（songId 变化）仍 mint 新 token，真换歌的
  track_changed 判据不受影响。
- 新增回归测试：`tests/dlna/castSessionReuse.test.ts`、
  `tests/airplay/sessionReuse.test.ts`（复用/换歌/跨设备/解析一致性共 8 例）。

## [4.0.7] - 2026-09-22

### 重做 —— sendspin seek 按 Music Assistant 权威语义推倒重来（真机验证通过）

**v4.0.6 的「后台预建 + 帧边界原子切换」方案在真机上失败，本版整体废弃，
改为与 MA `player_queues/controller.py::seek`(@862) 逐条对齐的实现：**

- **seek = 发布位置对 + 整条流重建**（MA `play_index(seek_position)`）：
  - ① 先发布 `group.positionMs = targetMs`（MA `elapsed_time + last_updated`），
    推送循环取帧改用**自有游标**（`playCursorMs`），共享位置只写不读 ——
    v4.0.6 的 swap 前置问题：pushLoop 用共享 positionMs 反推帧下标，
    seek 一发布目标位置旧循环即误判 EOF（真机 FP-TRACE 堆栈钉死）。
  - ② `seekCore` 走与正常起播**完全相同**的 `playCore/playGroupCore` 路径重建流：
    停旧流 → stream/end 成对 → 全新音源带 `-ss` 起点起流 → 新时间线锚点
    （now + send_ahead，MA `_resolve_channel_play_start` auto 模式）。
    MA 没有帧边界换流；设备缓冲自然耗尽后接新流，即 MA 真机行为。
- 删除 v4.0.6 引入的全部自创机制：`beginRebuild` / `applySwap` / `swap*` /
  `rebuildGen` / `rebuildInFlight`。
- `playCore`/`playGroupCore` 新增 `seekPositionMs` 通道（MA seek_position 等价）；
  组状态 `current` 补存 `mime`。
- **真机验证**（240 容器 + 真实音源）：
  - sendspin(esp32-player2)：seek 30s→31.2s 续播、seek 45s→47.0s 续播，
    真实节奏推进不断线；音量 30/45/80 即时回读一致。
  - DLNA(主卧 HiVi H5MKII)：seek 40s→43.0s、seek 70s→73.0s 续播正常；
    设备恒报 RelTime=0 时自动降级「重投流重建」标记生效；音量 20→40→70 即时生效。
- 排查附记：测试曲「Ditch」实际音频仅 30s（试听片段）而元数据 131s，
  seek 超出实际音频末尾的 EOF→切歌行为与 MA 一致，非本版缺陷。

## [4.0.6] - 2026-09-22

### 修复 —— 进度条跳转(sendspin / DLNA)按 Music Assistant 语义重做

根因一句话:此前 seek 的语义是「在跑着的流里挪指针」,而 MA 的语义是
「用新起点重建一条流」(`controllers/player_queues/controller.py:862`)。
前者在实时转码管道上物理落不了位 —— sendspin 卡顿、进度条比真实快、DLNA 进度虚高,
是同一个根因的三种表现。完整方案见 `docs/PLAYBACK_SEEK_MA_REWORK.md`。

- **sendspin 跳转后持续卡顿 + 进度条比真实时间快**:`window.seekTo()` 是 kill 旧 ffmpeg
  再冷起新的,设备端实测 **5~7.4s 完全断流**,缓冲耗尽后按实时速率补不回来;且 seek
  瞬间就写了 pacing 锚点、首帧却晚到数秒,`dueMs` 全部落在过去 → 帧无节制连发
  (实测 3.94s 内 `pos` 涨 8.875s)。现在改为 MA 式**后台预建新流 + 帧边界原子切换**:
  `seek()` 立即发布目标位置(防 UI snapback)→ `beginRebuild()` 后台预建 → 就绪后由
  pushLoop 在帧边界换流 —— **旧流在预建期间继续播,设备端零空窗**;`rebuildGen`
  保证连续拖动只认最后一次,过期的重建立即释放(防泄漏);seek 后重锚提前量抬到 3s
  (设备上报的缓冲参数常常全 0,`send_ahead` 退化成 800ms,太浅)。
- **ffmpeg 孤儿泄漏(P0)**:`GroupPump.play()` 用 `this.window = stream` 直接覆盖,
  旧 `WindowStream` 从未 `close()` → 每次切歌泄漏一个 ffmpeg。240 现场堆积 10 个、
  存活 18~29 分钟、各占 ~65MB RSS,最终触发 `PcmWindow 等数超时(15000ms)` →
  `idle_early` 误判 → 切歌 → 再泄漏,恶性循环。改为 play 前先 `releaseAudio()`。
  部署后实测:ffmpeg 10→1、僵尸 5→0、容器内存 1.35G→674MB。
- **DLNA 进度虚高 + 外推越过时长误判切歌**:HiVi/MUZO 播实时转码流时 `GetPositionInfo`
  **恒回 `RelTime=0`**,SOAP `Seek(REL_TIME)` 静默失效,而位置基线仍被锚到请求目标 →
  纯墙钟外推。现在连续 2 次「设备不报位置」即判定该设备 SOAP Seek 无效(**并落库持久化**,
  重启后首次 seek 就直接走,不必再试错两回),此后 seek 改为**带 `timeOffset=N` 重投一条
  新流**(MA `play_index(seek_position=N)` 在 DLNA 侧的等价实现)。
- **起播跳转不再二次冷起**:`PumpSource` 增加 `startMs`,起播即带 ffmpeg `-ss`,
  省掉「建流 → `seekTo()` → 再冷起」的整段空窗。

### 新增 —— AirPlay 通道独立(播放通道不再复用)

AirPlay 此前与 DLNA、sendspin 共用 `/rest/dlna/stream/:token` **一条**路由,带来三个
结构性问题:① DLNA 音箱兼容头(`contentFeatures` / 12h 假 `Content-Length` / ICY)被
强加给 AirPlay 解码器;② 滤镜通道键恒为 `dlna`,`pipeline.airplay` 开关形同虚设;
③ 任一链改 URL 参数会串到别的链。现在 AirPlay 有自己的 token 命名空间
(`services/airplay/session.ts`,**SQLite 登记** —— AirPlay fork 模式下主进程 mint、
子进程经回环 URL 消费,内存 Map 跨进程不可见)与 `/rest/airplay/stream/:token` 路由;
出流核心抽成 `serveCastStream()` 由两条链共用,按通道取各自的 DSP 查键与管线开关,
不复制 100+ 行出流逻辑。

### 文档
- 新增 `docs/PLAYBACK_SEEK_MA_REWORK.md`:真机取证(F1~F4 + 两个放大器)、MA 权威契约、
  通道复用现状图、四层改造总纲、patch 全表、验收矩阵、发布与回滚方案。

### 构建信息

- Docker 镜像:`ray5378/musicflow:4.0.6` + `:latest`

## [4.0.5] - 2026-09-21

### 修复 —— CI 合规

- **`check-i18n` 阻断「前端插件隔离守卫」**：`c42757a`（拖动进度条四端修复）在
  `frontend/src/stores/player.ts` 的 castPoll seek 护栏里留了一行中文 `console.debug`
  （`丢弃 seek 后偏离读数`），而 `backend/scripts/check-i18n.mjs` 要求前端源码（注释除外）
  不得出现硬编码 CJK —— 于是 v4.0.4 发版提交 64f3e11 上 `ci` 工作流的该步骤变红。
  日志不是用户可见文案、无需走 i18n，改为英文即可；**播放逻辑与产物零变化**。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.5` + `:latest`

## [4.0.4] - 2026-09-21

### 新增

- **日志等级运行时可调**：新增设置键 `log.level` + admin API（`GET/PUT /rest/api/v1/admin/log-settings`），
  设置页新增「日志等级」卡片。此前只能靠启动时的 `LOG_LEVEL` 环境变量定死，排查线上问题要么重启、
  要么零日志。fork 出去的子进程有独立 logger 实例，故新增 `setLogLevel` IPC 显式下发
  （否则推流/解码侧的 debug 明细不出现）。
- **请求级 trace id**：`runWithTrace()` 给 `/rest`、`/api`、`/webhooks` 请求生成短 id 放进
  `AsyncLocalStorage`，debug 日志自动附加 `tid=`。一次「拖动进度条」会级联 HTTP → QueueController
  → DLNA SOAP → sendspin 多层，靠 tid 才能把跨层日志串成一条链。静态资源不生成（纯噪音）。

### 修复 —— 播放链路

- **PLAYING 但位置冻结无看门狗**（用户观感＝「进度条卡住不动」，永不自愈）：实测 sendspin 报
  `PLAYING pos=173.6 dur=280` 三分钟不推进、pump 零日志，而现有的 IDLE 卡死（15s）与结束兜底（8s）
  都够不着。新增 `frozen` 判据（位置**真变化**的墙钟超 30s）→ 就地重投当前首并拉回位置
  （**不切歌**），与 stalled 共用连续计数；seek 冷静期内与复查后撤销。
- **链路不可用却冒充设备状态**：子进程僵死期间 RPC 25s 超时，旧代码 catch 成
  `{playing:false,pos:0}` ＝ 向 tracker 谎报「设备停了」→ 凭空造出 PLAYING→IDLE 迁移 →
  判「自然结束」切歌。新增 `PlayerState.unavailable`：sendspin 三种 player 与 DLNA 的 `pollState`
  在拿不到真实读数时标它，QueueController 读到即不喂 tracker、不计数、登记 linkLost，等真恢复再续播。
- **DLNA 在设备未发现时冒充 STOPPED**：`getDeviceStatus` 的早退分支在设备不在发现缓存时返回
  `STOPPED pos=0`，容器重启 / 重新发现窗口期会被读成「设备真停了」，连续 2 次判卡死后**放行切歌**
  （真机复现：重启后 35s 队列凭空少一首、位置归零，极易被误判成 seek bug）。修法同款：标
  `unavailable` 不冒充。判据用**发现缓存**而非 `runtimes` 的 available 位——后者对未知设备乐观返回 true。
- **「链路恢复」≠「设备回来了」**：fork 模式 sendspin 子进程重启后要重新拨号、设备要重新入组，
  这中间 `poll` 会合法地回 IDLE。盲目 cast 会投进一个不存在的连接（没声音但状态显示在播）→
  30s 后被冻结看门狗判死 → 第 2 次直接放行切歌。新增 `ProtocolPlayer.isAvailable?()` 作为续播前门，
  不在线就**保留** linkLost 等下一拍（5s 后）再试。
- **子进程僵死窗口过长**：心跳看门狗 3×+5s(95s) → 2×+5s(65s)，检查间隔 30s→10s（最坏 125s→75s）；
  超时日志补「最后消息 Xs 前 | 最后 RPC op | 悬挂 RPC 数」，下次能直接看出卡在哪一步。
- **拨号目标过期不重发现**：`dialRemembered()` 只重拨记忆中的 host:port、不做 mDNS 重解析，
  设备 DHCP 换 IP（实测 .245→.246）后旧目标无限 `EHOSTUNREACH`，把子进程拖住并连带所有 RPC 25s 超时。
  现在连续 3 次**地址类**错误（EHOSTUNREACH/ENETUNREACH/EHOSTDOWN/ENOTFOUND/EAI_AGAIN/ENETDOWN）
  即淘汰记忆目标并落盘（非破坏性，mDNS 会重新发现新 IP），并加单飞与 5s 连接超时。

### 修复 —— 拖动进度条（四端）

- **Web 端缺 seek 护栏**：`castPoll` 此前**无条件采纳**设备上报位置，设备实际生效有延迟时轮询读到的
  仍是拖动前的旧位置 → 进度条被拽回。新增每设备 `seekIssued`（时刻+目标）护栏，与卡片
  `_seekIssuedAt`、客户端 `_seekIssuedAtMs`、HA 集成 `seek_guard_until` 同语义，且必须在 POST
  **之前**置位（请求在途期间就可能有一次轮询返回旧位置）。
- **服务端 DLNA `seekGuard`**：拖动后设备把陈旧读数报回来的窗口内，丢弃陈旧值、采纳落位值、到期解除。
  判定抽成纯函数以便 CI 用固定时间轴钉死（失效形态是偶发跳回，手测极难复现）。
- **sendspin 重定位代数化**：「校验失败→重发」此前会让 `seekDevice` 末尾派生新 gen 的新校验 →
  每秒一次的无限风暴；更隐蔽的后果是每次重发都重设护栏 → 位置恒被 `seekExpectedPosition` 顶住 →
  **进度卡住不前进**。现在重发恰好一次（`{verify:false}`），设备恒报 0（HiVi/MUZO 播转码 chunked 流）
  时直接放弃落位校验。
- **起播窗口内拖动**：拖动落在 pump 尚未运行的空档时记下起播位置交由 `play()` 消费，不再丢弃。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.4` + `:latest`

## [4.0.3] - 2026-09-21

### 修复

- **插件沙箱交互型调用超时 30s→20s**：15s 配额过窄，20s 兼顾等待与卡死可杀；重建预算 30s 不变。
- **沙箱 OOM 清理排空 pending jobs**：被 interrupt 打断的 async continuation 残留会钉住 `gc_obj_list`，`dispose` 即触发 QuickJS teardown 断言 abort（WASM 层 SIGABRT，宿主 try/catch 抓不住，直接杀死整个 vitest worker、全量陪葬）。`oomCleanup` 前后各排空一次；`sandbox.test.ts` 连续 3 次 27/27 通过。
- **sendspin `seekCore` 类型修正**：v4.0.2 带入的 TS2345（ephemeral 假组传给 `pumpFor`），改用 `srv.group` 取真组，`tsc` 干净。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.3` + `:latest`

## [4.0.2] - 2026-09-21

### 修复 —— 拖动进度条问题（分播放器逐一修复）

- **sendspin 拖动后无法播放/进度不对**：`seekCore` 只写 `positionMs` 标记，pump 主循环下一帧即按下标覆盖（进度回跳、音频原地），且不钳制 duration（拖到尾直接触发播完→跳歌/停播）。改为走组 pump 跳转（含 clamp＋流式窗口 `-ss` 重起）；暂停态拖动保持暂停（与 DLNA/Web 同语义）。
- **timeOffset 接受 0.1s 粒度小数**：新增 `parseTimeOffset`（4 处替换 `parseInt`，非法/负值归零），ffmpeg `-ss` 前置定位直接支持小数。整秒 floor 时代的系统性 `<1s` 偏小是 Web/客户端「进度定位不对」的来源之一。
- DLNA/AirPlay/group/local 本体核实无害（REL_TIME 整秒是设备规范；AirPlay 有 FLUSH＋换 decoder；group fan-out；local 转发），坏的都在调用侧，已由三端（Web/客户端/HA）配套修复。

### 配套

- Web 前端：seek 越界钳位 `duration-0.5s`、拖动开始快照 autoplay、`localSeekActive` 跟手保护、时长按 `song.duration` 播种、0.1s 粒度 timeOffset。
- 客户端 **v5.0.19**、HA 卡片 **v2.4.3**、HA 集成 **v2.0.2** 同步发版（四端同批）。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.2` + `:latest`

## [4.0.1] - 2026-09-21

### 修复 —— 播放结束判定与卡死兜底

承接 4.0.0 的「出流管道化」：本版不新增能力，只把「一首歌什么时候算放完」「卡住了怎么办」
这两件事的判据补齐到与上游 MA 同口径。

- **卡死兜底 60s → 15s，判据改为墙钟累积**：旧判据是「相邻两次 IDLE 上报间隔 > 60s」，
  但设备采样固定 5s 且每次上报都把 `updatedAt` 刷成当前时刻 → 差值恒为 5s，**生产里永远
  触发不了**；唯一的可达旁路（队列停轮询 / advancing 占用超 60s）触发时，恰好会去重投一个
  **已经播完**的队列。现在改为「进入 IDLE 记时刻、离开即清」的墙钟累积，与采样频率解耦。
  阈值 15s 与 `dlna/control.ts` 的 `TRANSPORT_STATE_CACHE_MS = 15000` 同口径。
- **cast 失败不再静默**：`playCurrent` 的 catch 原先只 `endOptimistic` 就返回 —— 这首既不
  重投也不切歌，队列就此停死（设备瞬时离线时表现为「再也不播了」）。现在接入既有 stalled
  通道（复查 → 每首最多重投一次 → 第 2 次放行切歌），并按「一整圈」（2×曲数）封顶，防止
  整队都投不出去时无界绕圈；到顶即判整队不可播。
- **已结束 / 未激活队列不重投**：卡死阈值降到 15s 后 stalled 路径才**真正可达**，而它原先
  全程不看 `q.isActive` / `q.ended`。加护栏，置于最前、零副作用。
- **乐观窗口拆成两段**：原实现「cast 命令发出前」就起 5s「等设备确认 PLAYING」计时，而那 5s
  会被 `Stop → SetAVTransportURI → Play` 三次 SOAP 往返（单次超时 8s）吃掉，判出的 stalled
  只是「命令还没发出去」。拆为 `beginOptimistic`（阶段 1，仅屏蔽切歌瞬态）与
  `armOptimisticTimeout`（阶段 2，cast 送达后才起计时），对齐 MA `PLAYBACK_START_TIMEOUT = 5.0`
  「命令送达后起算」的语义。

### 配套

- 客户端 **v5.0.18** 同步补齐：直投 DLNA 时 `getTransportInfo` 读失败返回的 `UNKNOWN` 不再与
  真 `STOPPED` 同判，15s 宽限窗口内沿用最近一次成功读数（与服务端 `TRANSPORT_STATE_CACHE_MS`
  同口径）—— 修「时长未知的曲目上一次 SOAP 读失败就被误判放完 → 曲中段切歌」。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.1` + `:latest`

## [4.0.0] - 2026-09-20

### 大版本 —— 音频出流全面管道化

版本号从 3.0.x 跳到 **4.0.0**：本版不是补丁累加，而是把「出流」这件事整体换掉了做法。
原先每条链路各转各的、必要时才转码（存在若干**原样直出旁路**），现在 HTTP / Web / DLNA /
Sendspin / AirPlay 五条链路统一走同一条**六段流水线**：

> ① 解码成 F32 → ② 响度归一化 → ③ DSP（音色）→ ④ 交叉淡入 → ⑤ 限制器 → ⑥ 编码输出

已清掉全部直出旁路（`?raw=1` 直透、`serveWebSongStream`、`serveDlnaWebStream`），
**没有「绕过管道」的路径了**。

### 新增 —— 听得见的能力

- **换歌不再忽大忽小（② 响度归一化）**：每首歌拉到同一目标响度，默认 −14 LUFS，
  可在「音频」页配成 −30…−5（对齐 Music Assistant 的区间）。有离线测量值时走静态增益，
  没有则走实时 loudnorm —— 两种口径共用同一个解析函数，不会互相打架。
- **交叉淡入（④，默认关）**：连续播放时两首歌重叠过渡，时长 1…15 秒（默认 8 秒），
  在「音频」页开启。只在**顺序播放**下生效：洗牌 / 单曲循环 / 列表循环的「下一首」
  不由队列下标决定，拼流会与设备真实顺序打架。
- **每台设备独立音色（③ DSP）**：前级增益 / 三段音色（低中高）/ 左右平衡 / 参量 EQ，
  按设备存、不跟账号走。参量 EQ 是手算 biquad 系数（不用 ffmpeg `equalizer`），
  高/低通可选 12 / 24 / 48 dB/oct 陡度（级联 Butterworth）。全 0 = 不加滤镜、零开销。
- **本地行离线预测量（默认关）**：提前跑一遍响度分析，起播直接走静态增益，省掉实时 loudnorm。

### 新增 —— Web 端「音频」页

侧边栏新增「音频」模块，「音频管道」「设备音色」两张卡片从「设置」页整块搬过来，
并加上「音量归一化」。每张卡片都能单独开关：全局总开关 × 四个通道（HTTP / DLNA /
Sendspin / AirPlay），DLNA 还能**按设备单独回退**（某台老音箱听不了就只给它关掉）。
管理员可见全部，仅被授予播放权限的账号只能看到自己能控的设备的音色。

### 修复 —— 全量代码审核抓出的 5 处缺陷

管道化的错误几乎都是「不报错、只是难听」，所以本版对全部相关代码做了一轮审核：

1. **交叉淡入静默丢掉上一曲尾段**：下一曲首段短于过渡窗口时，那段既没播出也没参与混合，
   最长丢一整个窗口（默认 8 秒）且**完全不报错**。
2. **ffmpeg 日志保留方向反了**：缓冲区到上限就不再追加 ⇒ 冻结在**流的开头**，
   而 loudnorm 的测量报告打在**末尾** ⇒ AirPlay 超过约 5.7 分钟、Sendspin 超过约 11.5 分钟的
   曲目**永远解析不到响度值**（静默失败）。已统一为「超限丢开头、末尾永远在」。
3. **DSP 端点越权**：音色是设备属性，原实现只校验「有播放权限」⇒ 任意可播放账号都能改
   **全服务器每台设备**的 EQ。已补设备级授权（`canControlPeer`）。
4. **高/低通缺了陡度维度**：只有单节（用 Q 值），补上 12 / 24 / 48 dB/oct 级联选项。
5. **残留的向后兼容迁移块**：`audio_analysis` 表的 `PRAGMA` 探列 + 补列已删（本项目的既定约定）。

### 变更 —— 客户端与接口侧需要知道

- **HTTP 流式 seek 改按服务端能力判定**：4.0.0 起所有 HTTP 流都是实时流（无直传旁路），
  字节 Range 失效，seek 改为带 `timeOffset` 重拉。客户端按服务端版本号门控（≥ 3.0.47 即启用，
  4.0.0 满足）；Navidrome 等其他服务端不受影响，沿用旧判定。
- **DLNA 全通道走管道**：cast / enqueue / DIDL 的 MIME 三处同步，音箱兼容头
  （`contentFeatures` + 12 小时假长度）恒定带上。
- **并发转码槽拆成三个独立池**：`quality`（音质转码）/ `pipeline`（实时管道）/ `flow`（交叉淡入），
  互不抢槽，上限按 CPU 核数派生。
- **DB 新增 2 张表**（`audio_analysis`、`player_dsp_configs`）：均为**一次性建表**，
  本版不做旧数据迁移（自用项目的既定约定，升级即重建）。

### 验证

- `tsc --noEmit` 0；7 个静态门禁全 0（`check-i18n` 1347 键中英对齐）。
- 前端 `vue-tsc && vite build` 通过。
- 后端 **139 个测试文件 / 1236 例**全绿；新增的 31 例（设备授权 8 / 陡度 9 / 归一化 14）
  全部做了**负向验证**——先把修复改回旧行为确认测试确实变红，再还原。

## [3.0.46] - 2026-09-20

### 修复 —— judge 正缓存盲信：扫描确认可播、播时已死的歌照推

- 新增共享 `recheckOnlineDirect`（在线直链短超时复核）：judge 在正缓存命中时
  先复核，直链明确已死（404/403/410）则逐出正缓存、找兄弟/远程替代，
  无替代直接跳过（知识非未知，不违"不误杀"边界）；预探测扫描侧改调同一函数。
- 清理 `refs/music-assistant-server/`（18MB 不完整 MA 源码）；音频流水线方案
  文档 MA 引证改为按 commit 拉取核对。

## [3.0.45] - 2026-09-19

### 修复 —— 预探测负缓存 45 秒导致坏源反复重试 + 补扫描可观测

**症状**：sendspin 播放中，持久性坏源（如已下架的酷狗直链 404）每次轮到都重试
约 30 秒（judge 现场探测 17s → 宽容放行 → pump 再探 16s → 失败）才跳过，
6 小时 25 次，体感"偶尔卡顿/断歌"。

**根因**：预探测把死歌标"不可播"只记住 45 秒（`negativeTtlSeconds`），而
lookahead 5 首 ≈ 15–25 分钟跨度——等播到那首时缓存早过期，judge 现场重探，
web 行又永远判不出"确定无源"，宽容尾巴只能放行再失败。

**修法**：`negativeTtlSeconds` 缺省 45→7200（2 小时）、上限 600→86400；
死歌学一次、2 小时内复播直接跳过。源恢复最长延迟该时长（直链下架不复活，
可接受）。附带：预探测每次扫描打一行 info（scanned/collected/deadRun），
此前成功完全静默、无从实证在跑；240 常驻监控脚本 `scripts/sendspin-monitor-240.sh`
（资源＋卡顿指纹＋坏源追踪＋进度停滞）。

**验证**：tsc 0 错；vitest 157 文件 / 1174 用例全绿；核心逻辑单测 hermetic 化
（模块 TTL＋配置行在 beforeEach 钉死，shuffle 乱序不再互串）。

## [3.0.44] - 2026-09-19

### 修复 —— ffmpeg 回环流恒 403（raw-stream 凭证跨进程不可见）

**症状**：v3.0.43 镜像（含 48ad83d 回环架构）上线后，Sendspin 播放仍失败，
ffmpeg 报 `Error opening input: Server returned 403 Forbidden`，输入已是
回环 URL `http://127.0.0.1:<port>/rest/dlna/stream/<token>?raw=1`。

**根因**：回环 token 的 raw-stream 注册表是**主进程内存 Map**，而 Sendspin
生产默认 **fork 模式** —— `streamEngine` 在**子进程**里 mint token、
`/rest/dlna/stream/:token` 路由在**主进程**里 resolve，Map 跨进程不可见，
token 永远查不到 → 恒 403。vitest 恒 in-proc（同进程共享内存），测试无法暴露。

**修法**：注册表落 SQLite `raw_stream_tokens` 表（WAL 多进程安全，与
`sendspin_device_state` 同模式），mint/resolve 全部走 DB，TTL 仍 30 分钟、
mint 顺带清理过期行。新增 `tests/services/rawStreamToken.test.ts` 回归锚点。

**验证**：tsc 0 错；vitest 156 文件 / 1170 用例全绿；240 实例注入修复后实测
Sendspin 音箱（ESP32）连续正常播放（pos 持续推进，403 消失）。

## [3.0.43] - 2026-09-19

### 修复 —— Sendspin / 转码 / 投屏链路带域名直链全部播放失败（ffmpeg DNS）

**症状**：Sendspin 音箱播放 WebDAV/网盘歌曲时，后端 ffmpeg 报
`Failed to resolve hostname xxx: System error`（exit 251）后跳曲；Web 客户端与本地播放（Node 代理链路）
完全正常 —— 因为只有 Sendspin / 转码 / AirPlay 这三条链路真正落到 ffmpeg 子进程。

**根因**：镜像里的 `ffmpeg-static` 是 **glibc 静态构建**（依赖运行时 dlopen glibc 的 NSS 库做域名解析），
而运行镜像是 **Alpine（musl）**——容器里根本没有 glibc 的 NSS 库，静态 ffmpeg 的 DNS 因此**全坏**
（实测对任何域名都报 `System error`，同一个二进制拿到 glibc 宿主机上正常）。此前没暴露，是因为
openlist 当时走本地代理、没有 302 出公网域名；直链一出现即命中。

**修复（Dockerfile）**：runtime 阶段 `apk add ffmpeg`（musl 动态版，实测 8.1.2，含 libopus 编码 /
flac 解码）并设 `ENV FFMPEG_PATH=/usr/bin/ffmpeg`。代码零改动 —— sendspin/encoding.ts、
transcode.ts、airplay/decoder.ts 三处 `ffmpegBin()` 本就优先读 `FFMPEG_PATH`，一条环境变量同时修好
三条链路。

## [3.0.42] - 2026-09-19

### 清理 —— dailyRecommend 的旧表 / 旧设置兼容代码（接续 3.0.41 的「不考虑向后兼容」）

接续上一版定调，把每日推荐里最后一批只为「升级用户」存在的兼容分支删掉：

- **`services/plugin/dailyRecommend.ts`**：删除 `loadCandidatesFromSettings()` / `findPlaylistByName()` /
  `purgeOldDailyPlaylists()` / `DAILY_TAG_LOCAL`；`saveCandidates()` 不再往 settings 表双写候选；
  `ensureDailyPlaylists()` 简化为「缺则建」，移除旧歌单认领与「今日推荐」→「每日推荐」的改名逻辑
  （+12 / −61）。
- **`db/index.ts`**：移除 `daily_recommend_candidates` / `daily_recommend_retention` 两条种子语句（−9）。
  候选与保留期现在只由 `dailyRecommend` 自己的表承载，老库重建即可。

### 文档 —— 全仓文档时效性梳理（25 个文件）

- **校准硬数字**：OpenSubsonic `/rest` **51** 端点、DB **37** 张表、内置插件 **18** 个（source 0，
  go-music-dl 已外置）、`PluginType` **10**、`PluginCapability` **≈25**；文件名统一小驼峰。
- **修正 4 处与实现相反的描述**，含 1 处代码注释：播放器管理页的离线实例并非「自动消失」，而是
  **保留该行并打「离线」标签**（只有队列会被回收、只有流转选择器会剪掉别的离线实例）。
- **回标落地状态**：3 份方案类文档（player-unification / memory-optimization / sandbox-limits）补
  「已落地 / 部分 / 未做」；**8 份带日期的历史文档**顶部加「⏳ 历史快照」横幅（内容不重写）。
- **删除 2 处已失效的发版步骤**：PLUGIN_ARCHITECTURE / sandbox-limits 里指向已删除 addon 仓库的
  同步发布步骤。

### 修正 —— 两处名不副实的 CI 文案 + 一处与实现相反的注释

- `backend/scripts/check-builtins.mts` 头注释与 `ci.yml` 的 step 名原写「校验 7 个内置插件 manifest」，
  而该清单实际只覆盖 18 个内置插件中的 **13 个** → 改为据实描述（**未扩清单**；扩清单需连带改插件
  manifest、能力白名单与权限白名单，属独立改动）。

## [3.0.41] - 2026-09-19

### 清理 —— 删除 DB 字段迁移 / 兼容代码（项目自用，不考虑向后兼容）

定调：本项自用、本地升级即可，**不为老库/老字段保留兼容分支**。据此整段删除两处只为「升级用户」
存在的迁移逻辑（5 文件，+2 / −169）：

- **旧版 Sendspin 全局密钥继承**（`services/sendspin/deviceState.ts`）：6053 密钥从「插件页一把全局」
  改为「每台设备各自一把」时，曾留了一个继承窗口——服务启动后 10 分钟内连上来的设备，把
  `plugins.config` 里的旧全局密钥（`esphome_psk` / `esphome_port`）抄成自己那一行的密钥，以免升级后
  静默失联。现连同 `readLegacyPluginEsphome()` / `inheritLegacyEsphomePsk()` 一并移除；子进程
  （`sendspin/child.ts`）与主进程（`sendspin/index.ts`）两条设备注册路径里的调用同步删掉。
  设备现在**只认自己那一行**的密钥，不再读任何旧字段。
- **`sendspin_device_state` 的 PRAGMA 探测补列**（`db/index.ts`）：老库缺 `disabled` / `esphome_psk` /
  `esphome_port` 时用 `ALTER TABLE ... ADD COLUMN` 幂等补齐的那段循环已删除（新库由 `CREATE TABLE`
  一次到位；老库重建即可）。**今后新增字段直接改进 `CREATE TABLE` 语句，不要再加补列迁移。**

`deviceState.test.ts` 相应删掉 7 个迁移用例（旧字段读取 / 继承落库 / 不覆盖已有密钥 / 端口优先 /
只继承一次 / 窗口期判定 / 无旧密钥与空 clientId），全量回归因此从 155 文件 1172 例变为 155 文件 1165 例。

## [3.0.40] - 2026-09-19

### 测试 —— 补上渲染器子进程 fork 路径的冒烟测试（此前零覆盖）

`mode.ts` 见到 `VITEST` 一律返回 false，业务侧测试**永远不可能真的 fork** —— 于是
「生产里 supervisor 到底有没有 fork 起子进程」此前只由注释与 CHANGELOG 背书，一条断言都没有。
本版绕开 `isRendererForkMode()`，直接构造通用宿主 `RendererHostSupervisor` 并指向一个纯 JS
夹具子进程，真的过一遍这条路径：fork → mainReady 握手（断言载荷真的过了 IPC 边界）→ RPC 往返
（断言响应里的 pid 就是被 fork 的子进程）→ 快照进镜像 → `kill -9` → 退避重启（新 pid 可继续
服务）→ 优雅 `stop` → 「启动即退」的失败分支。整套约 3.5s。

夹具用 `.mjs` 而非 `.ts`（`tests/rendererHost/fixtures/stubRendererChild.mjs`）：`fork()` 直接跑
node，不依赖任何 TS loader，因此与 vitest 的 `process.execArgv` 完全解耦。

### 可观测 —— AirPlay 推流节拍指标 `reanchors` / `maxGapMs` 对外可见

这两个数此前只在 `stream()` 收尾时打一行日志：只能事后归因、拿不到趋势，也无法在播放**过程中**
判断「此刻是不是已经被拖垮」。现在：

- `RaopPlayer.realtimeStats` 暴露 `{ chunks, reanchors, maxGapMs, elapsedMs, lossRequests }`；
- 进会话镜像 → `getAirPlayStatus().stream` 与 `getAirPlayPeerStatus().stream`（HTTP 可直接 curl），
  fork 与 in-proc 两条路径读同一份语义；
- 会话运行期每 15s 打点一行趋势；`reanchors > 0` 或 `maxGap > 50ms` 升级为 warn，便于日志过滤。

至此开启 `MUSICFLOW_AIRPLAY_FORK=1` 的两个前提（架构就位 + 可观测）都已具备。

### 验证

`tsc` + 9 项静态门禁 + 全量回归（155 文件 / 1172 用例，较 3.0.39 新增 1 文件 / 10 用例）全绿。

## [3.0.39] - 2026-09-19

### 重构 —— 抽出「常驻渲染器子进程」通用宿主 `services/rendererHost/`

sendspin 自 3.0.34 起跑通的那套「常驻子进程」模式（fork / mainReady 握手 / 心跳看门狗 /
退避重启 / 优雅 stop / RPC / 状态镜像）此前只有它自己一份实现，AirPlay 要照抄就会变成
两份各自漂移的 IPC 契约。本版把它抽成通用层，业务只声明自己的载荷与 op 表：

- `RendererHostSupervisor`：主进程侧宿主（fork、握手、看门狗、退避重启、`rpc`/`post`、镜像容器、事件分发）；
- `ChildRpcHost`：子进程侧控制器（`req`→`res` 按 id 回填、快照 150ms 节流 + 1s 兜底扫、心跳、stop 生命周期）；
- `ipcProtocol`：通用信封类型与常量。用 `({ t: "state" } & TSnapshot)` 这类交叉类型承载业务载荷，
  所以**消息的运行时形状与重构前完全一致**（仍是 `{ t:"state", clients, groups, … }`）；
- `resolveChildEntry`（prod `.js` / dev `.ts`）、`isRendererForkMode`（三态模式判定，只有默认值不同）、
  `createFrontAccessor`（fork→代理、in-proc→真实实例）、`childBootstrap`（致命异常兜底 / 数据层 / 消息循环）。

**Sendspin 已迁移到通用层，行为不变**：`sendspinSupervisor` 单例、`SendspinChildController(deps, send)`
构造签名、全部公开 API、IPC 消息形状、日志文案都保持原样，由既有 sendspin 测试（39 文件 / 221 用例）守等价。
此后新增渲染器（airplay2、cast、roon…）照 `rendererHost/index.ts` 顶部的六步清单接线即可。

### 新功能 —— AirPlay RAOP 推流会话接入子进程（默认关闭）

AirPlay 的推流是「每 352 帧（≈7.98ms）一个 RTP 包」的墙钟节拍循环，且 ALAC 位打包与
AES-CBC 加密都在 JS 侧 —— 与 sendspin 同构，只是节拍更紧（7.98ms vs 25ms），此前却留在主进程：
一次长阻塞、一次封面缩图、一次后台批量任务都会直接体现为 `reanchors++` 与真机断音。

- 新增 `services/airplay/{sessionRuntime,childMain,child,supervisor,mode,ipcProtocol}.ts`：
  子进程持有 RTSP 会话 + ffmpeg 解码 + 推流节拍；**不碰 DB、不注册插件**（符合 SPEC「每进程一个
  SQLite 连接」——子进程压根不新开）。
- **主进程保留**设备发现（mDNS）、`airplay_devices` 持久化、DLNA 双协议互斥、`createCastSession`
  取 token 化 streamUrl、peer 注册、`volumeState`/`lastCast`：它们要么状态密集要么纯 I/O，搬进去只会多一跳 IPC。
- 状态读走**镜像**（`getAirPlayStatus` 会被 QC 每 5s、DLNA announce 每 500ms 调用，绝不能每次打 IPC），
  命令写走 RPC；会话结束由子进程发 `sessionEnded`，主进程照旧上报 IDLE 让队列自动续播。
- 解码/缓冲层（ffmpeg spawn + 有界 PCM 队列 + 音量 dB 换算）抽到 `services/airplay/decoder.ts`，
  两条路径共用同一份实现。
- **默认仍是 in-proc**：开发机没有 AirPlay 设备，这条路径无法端到端验证，所以先只把能力就位。
  显式 `MUSICFLOW_AIRPLAY_FORK=1` 才启用（`MUSICFLOW_AIRPLAY_INPROC=1` 可临时回落）；
  真机验证无回归后，把 `services/airplay/mode.ts` 的 `defaultFork` 翻成 `true` 即与 sendspin 对齐。

**顺带修掉一处真实缺陷**：`startSession` 里 `makeProducer(ff)` 建了一份却丢弃（变量未使用），
那个 producer 的 stdout `data` 监听器仍在 —— 它会把整首歌的 PCM 再缓存一份且无人消费（内存翻倍），
还会与真正在跑的 producer 争抢 `pause/resume` 背压，表现为间歇性卡顿。现在只建唯一一份。

### 门禁 —— 新增 `check-renderer-host.mjs`（CI: renderer-host-guard）

「重活必须落到独立进程」此前只是惯例：7 个 check 脚本 + 8 个 workflow 关键词扫描 **0 命中**
（SUP 红线和 sendspin 的 fork 都只靠注释与 CHANGELOG 背书）。新增静态守卫，三条规则：

- **R1** `backend/src/services` 下只允许 `rendererHost/supervisor.ts` 出现 `child_process.fork`——
  禁止各业务再自建一套 supervisor；
- **R2** 命中「deadline 循环形态」（墙钟取时 + `setTimeout` 自排 + 定长分块三条全中）的文件，
  必须落在**本业务**`child.ts` 的 import 闭包内，否则要么接宿主、要么显式豁免
  `// allow-main-process-render: <理由>`。
  （按业务归属判定而非「任一闭包」——实测 sendspin 的子进程闭包会跨业务拖进 `airplay/raop.ts`，
  只判「任一闭包」会让谁都没接宿主的情况蒙混过关。）
- **R3** 声明为渲染器业务的目录必须具备 `child.ts` + 用 `RendererHostSupervisor` 的 `supervisor.ts`
  + 用 `isRendererForkMode` 的 `mode.ts`。

**DLNA 不在守卫范围内**，这是有意的：DLNA 的 `/rest/dlna/stream/:token` 是字节代理 + Range，
渲染器自己回连拉流，服务端没有任何节拍循环（实测该目录零 `child_process`、定时器全是等待/续订语义），
进程化纯属浪费。守卫只认「节拍形态」不认目录名 —— 将来谁写下节拍循环就自动被要求接宿主。

### 验证

`tsc` + 9 项静态门禁 + 全量回归（154 文件 / 1162 用例）+ 前端 `vue-tsc && vite build` 全绿。

## [3.0.38] - 2026-09-19

### 新功能 —— ESPHome 6053 密钥独立入口（与设备音量彻底分开）

- 播放器页 Sendspin 设备行原本把「密钥 / 端口 / 测试连接」和设备音量滑杆挤在同一个
  弹窗里，现拆成两个独立弹窗：新增**「ESPHome 密钥」**按钮与独立弹窗，行内两个按钮
  各自反映连接状态。
- 密钥回显分级：`GET /v1/sendspin/devices/:clientId/esphome` 仅对持有
  `renderer.manage` 的账号回明文 `psk`（管理员恒有），其余账号只拿到
  `pskConfigured` 布尔值；**设备列表端点始终不回显** —— 一次列表把所有设备的密钥
  全吐出去毫无必要，弹窗打开时按需单取一台。
- 设备行内「解绑」与「重命名」两个按钮互换位置。

### 新功能 —— AirPlay 主动扫描（与 DLNA 扫描语义对齐）

- 新增 `POST /v1/airplay/scan`（`renderer.use`）：立刻重发一次 mDNS(`_raop._tcp`)
  查询，并把命中的接收端 `upsert`（新增 + 落库 + alive 事件）—— 刚上电、常驻
  browser 还没捞到的接收端，点一下就出来。插件关闭时是**立即 resolve 的 no-op**，
  随后回当前列表。
- `services/airplay/discovery.ts` 抽出 `spinQuery()`：常驻 30 秒续期与主动扫描共用同一条
  「短命新 browser 句柄」通路，避免两套发现逻辑各改各的。

### 优化 —— 四个设备区块头部统一为「扫描」

- 客户端 / DLNA / AirPlay / Sendspin 四个区块头部只保留一个贴右边缘的「扫描」按钮
  （原来 AirPlay / Sendspin 叫「刷新」）。根因：`.section-head` 是
  `justify-content: space-between`，Sendspin 头部有 3 个孩子时中间那个必然被挤离右边缘。
- 「添加播放器」保留不删，从头部移到 Sendspin 列表盒子下方、右对齐。
- 修正客户端区块说明与实现不符：「离线后自动消失」→「离线后该行保留并打「离线」标记」
  （后端对 local peer 只 `markLocalOffline()`，从不删行）。

### 优化 —— 流式解码窗口高水位 60 → 30 秒（与 MA 对齐）

- `WINDOW_HIGH_SEC` 60 → 30：PCM 窗口内存上限 ~23MB → **~11.5MB**（＋5 秒历史环 ~2MB），
  与 MA 的 `sleep_to_limit_buffer(30 秒)` 齐平；`WINDOW_LOW_SEC` 保持 20。
  代价：seek 回跳更可能落出窗口、按 `-ss` 重建解码（约 1 秒空窗），越界频率继续在
  240 soak 观察。插件配置页帮助文案与 `docs/SENDSPIN_MULTIROOM_STREAMING_PLAN.md`
  的内存对照表同步。

### 验证

- `tsc --noEmit` 0；`vue-tsc` + `vite build` 0；`check-i18n` 0；
  `vitest run` **154 文件 / 1162 用例全绿**；7 项门禁
  （frontend-plugins / overlays / element-overrides / fixed-playlist-ids / core / i18n）全 0。
- 新增 `backend/tests/airplay/rescan.test.ts`：守住「插件关闭时扫描立即返回、不卡 loading」。

## [3.0.37] - 2026-09-18

（本节为补记：该版打 tag 时未写 CHANGELOG 条目，内容据 `v3.0.36..v3.0.37` 提交历史整理。）

### 新功能 —— Sendspin 设备音量持久化 + 流式解码开关进配置页

- 设备音量（6053 桥）持久化并全端回显（`sendspin_device_state` + `peerVolume.ts` + WS 广播）。
- 流式解码开关（`stream_source`）进插件配置页，默认开启。
- 文档补解码内存与 MA 的对照结论。

## [3.0.36] - 2026-09-18

### 新功能 —— Sendspin 真多房间组（与 DLNA 组统一语义）

- **流式解码**（默认关，`SENDSPIN_STREAM_SOURCE=1` 开启）：`PcmWindow` 滑动窗口
  （长命 ffmpeg＋60 秒窗口＋真背压），子进程内存预计从 ~300–570MB 降到 ~120MB；
  `GroupPump` 双路径（整包/窗口），时长未知不钳制 position。
- **用户组多房间**：成员 id 命名空间化（`sendspin:`/`dlna:`/裸 id＝DLNA）；
  组内 sendspin 成员共享单 pump 同一时间线（`ug:<组id>` 组），双成员首帧同 ts；
  播中加入走直播沿（无需历史），摘除收 stream/end；离线可建组。
- **组管理 API**：`POST /v1/groups/:id/members` 增量原子口（幂等、无读写竞态，
  供 Flutter 随时加减）；PUT 沿用精确顺序并共用加入对齐钩子；
  mute/volume/status/playback 按 kind 扇出；群组对话框可选 sendspin 设备。
- 全量验证：`tsc`＋`vue-tsc`＋`vitest` 146 文件 / 1080 用例全绿。

## [3.0.35] - 2026-09-18

### Bug 修复 —— Sendspin 链路两处回归 + CI 测试隔离

- **mute 接口 500**(`index.ts`):`getSendspinFront()` 把 `isForkMode()` 误传给形参
  `inProc`，布尔反转导致双模式下恒返回 null，`/v1/peers/:id/mute` 报"服务未运行"。
  改为 `!isForkMode()`，一行恢复（生产 fork 模式的 mute 同 bug 同修）。
- **第二次播报卡死**(`encoding.ts`):`LibFlacEncoder.flush()` 调
  `FLAC__stream_encoder_finish` 终结编码流，而组编码器在多次播报/切歌间复用，
  之后再 `encode` 在 asm 堆内空转永不返回，卡死整进程事件循环（一次 FLAC 播报后
  后续播报/推流全挂）。现 flush 取走尾帧后原地重建新流，对象保持可用，
  `codec_header` 照常重建；音乐推流路径从不 flush，行为不变。
- **测试间 fetch 污染**(6 个测试文件):模块级 `vi.stubGlobal("fetch")` 从不还原，
  同进程串行时 `proxy` 直连测试读到 `"stream-bytes"`、TTS 拉取进 ffmpeg 报错。
  各文件 `afterAll` 加 `vi.unstubAllGlobals()`，生产代码零改动。
- 全量验证：`tsc` + `vitest` 142 文件 / 1060 用例全绿。

## [3.0.34] - 2026-09-18

### 架构 —— Sendspin 强制独立子进程(fork 隔离)

- **动机**:sendspin 推流是 25ms 节奏的硬实时循环(解码 → FLAC 编码 → 逐帧下发),
  与主进程(API 路由 / 后台批量任务 / 前端状态轮询)共享事件循环时,任何长任务都会
  顶住推流节奏,表现为真机端周期性卡顿。现把**整个 sendspin 运行时**(WS 38927 +
  mDNS + 拨号重拨 + 解码/编码/推流 + ESPHome 6053 只读桥)fork 进**专属常驻子进程**,
  事件循环与主进程彻底隔离。
- **通信协议**(`ipcProtocol.ts`):状态读走「快照推送」(脏了立即推,150ms 节流 +
  1s 兜底扫);命令写走 RPC(自增 id 回填,超时 25s / stop 15s / announce 360s);
  心跳 30s,主进程看门狗 3 周期无心跳即判定卡死并退避重启(3s→30s,稳定 5min 复位)。
  `positionMs` 高频字段**不进快照**,走 poll 轮询,防 IPC 风暴。
- **状态镜像 + 命令代理**(`proxy.ts`):主进程不再持有 server 实例 —— 路由/外围代码
  统一经 `getSendspinFront()`:fork 模式返回镜像代理(同步读快照、写走 RPC、mute
  setter 本地即时反馈),in-proc(单测/子进程自身)返回真实 server,调用方**零分叉**。
  类型哨兵 `AssertServerLike` 编译期锁定代理与真实 server 的公共结构。
- **核心下沉**(`playerCore.ts`):推流操作核心(play/stop/pause/seek/volume/poll/
  announce 等)从 protocolPlayer / announce.ts 原样抽取,跟随真实 server 进程运行,
  不 import QueueController/PlayerManager —— 主进程状态(队列冻结/恢复/播放器注册)
  留在主进程。播报现场(在播/进度)拆出 `announceProbeCore`,必须在 `qc.deactivate`
  **之前**捕获(时序坑:deactivate 清 current,之后捕获恒为零)。
- **配对密钥不外泄**:镜像快照**剥离 `pskHex`/`pskId`** —— 配对密钥永不出子进程;
  端口变更等配置热更新经 RPC `applyCfg` 下发,主进程 DB 仍是配置单一可信源。
- **崩溃自愈**:子进程 uncaughtException → exit(1),supervisor 退避重启;`stop` 走
  优雅关停(反注册/关连接/停 mDNS)后退出。单测与子进程共用 `MUSICFLOW_SENDSPIN_INPROC=1`
  装配路径,测试路径 = 生产路径(新增 `childMain.test.ts` 8 例:快照剥离 PSK /
  RPC 回包契约 / announceProbe 时序 / unpair 断连)。
- 文档:`docs/SENDSPIN_FLAC_ROADMAP.md` 标记完成(任务 1 真机基线一次达标:flac +
  codec_header 协商生效,零 Lost sync / 零解码报错 / 零 underrun,任务 2 无需进行)。

## [3.0.33] - 2026-09-18

### 文档

- 新增 **FLAC 链路专项开发任务书** `docs/SENDSPIN_FLAC_ROADMAP.md`:核心矛盾
  (25ms 喂料 vs libFLAC 块攒样脉冲)、真机基线验证步骤、消脉冲方案阶梯
  (compression 0 → 块对齐喂料)、micro-flac `BAD_BLOCK_SIZE` 约束、验收清单;
  链接真相文档与踩坑录,作为后续 FLAC 打磨的唯一起点。

## [3.0.32] - 2026-09-18

### Bug 修复 —— Sendspin 音量「回退」与增益标度

- **音量增益平方根因**:`setVolume` 此前同时写 `conn.volume` 与 `group.volume`,
  而 `appliedGain = conn.volume × group.volume / 100` ⇒ 实际下发增益 **= vol²/100**
  (拖 50 实得 25)。现只写**组音量**(单设备组的权威标度),每连接 trim 保持缺省 100;
  PCM 链路在 `pushFrame` 的 `scalePcm` 里按帧生效。
- **`/status` 音量回读源改为组音量**:原先回读 `conn.volume`(恒 100),会把前端
  刚拖的值顶回去。
- **前端轮询陈旧保护**(插件 `isStaleSample`):无 `reportedAt` 的设备型 peer
  (sendspin / DLNA)在命令下发后 **1.5s 短窗**内一律视为陈旧采样,防止
  「拖 20 → 立刻拖 30」时 2s 轮询把服务端仍停在的 20 顶回 UI;
  下发时刻改为**按设备**记录(切换播放端互不误伤)。窗后恢复同步,
  设备端自己的改动仍能及时镜像。

### 附带

- **ESPHome 6053 只读监控(在 sendspin-renderer 插件内)**:设备 IP 从 Sendspin
  拨入连接自动派生(无需手填);插件配置页新增 `esphome_mirror` 开关、
  `esphome_psk` 密钥(带常显「测试连接」按钮,保存前即可验证,成功回显
  设备名/版本/播放状态,失败给出原因);`GET /v1/sendspin/esphome` 只读查询
  (绝不回显 PSK)。依赖 `esphome-client@^2.0.0`(零第三方依赖)。
- 插件配置页新增 `preferred_codec`(PCM / FLAC 下拉,默认 PCM)。
- 文档:`docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` 重写为验证过的真相版;
  被推翻的旧结论沉淀为 `docs/SENDSPIN_PITFALLS_2026-09-18.md`。

## [3.0.31] - 2026-09-18

> 本条合并了此前**预写但从未发布**的 `[3.0.30]` 与 `[3.0.31]` 两个条目 —— 它们都只写了 CHANGELOG
> 而没打出 tag,远端最新 tag 仍停留在 `v3.0.29`,因此两版内容并未发布到任何用户手上。
> 现两版描述的修复已全部完成,合并为一次发布。
> 权威记录(真相版):`docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`
> 走错的路(踩坑录):`docs/SENDSPIN_PITFALLS_2026-09-18.md`

### Bug 修复 —— ESP32 真机**出声,并且零卡顿**

⚠️ **勘误**:较早版本的 CHANGELOG 曾把「STREAMINFO block size 4096」写成**决定性根因**、
把音频帧头写成「9B → **13B**(带 `send_ahead`)」、把协商顺序写成「flac 优先」——
**这三条均经设备端源码取证推翻**,已从本次记录中删除。真实根因如下(全部真机验证):

- **① 音频二进制帧头必须是 9B(决定性)**:设备 `sendspin-cpp` 只剥 1B type,其
  `player_role.cpp` 常量 `BINARY_TIMESTAMP_SIZE = 8`,8B 时间戳之后**一律当作编码音频**。
  此前多塞的 4B `send_ahead` 落在 payload 头部 → 首字节 `0x00` 而非 FLAC 同步字 `0xFF`
  → 每包 `Serious error decoding FLAC file` → **完全无声**。
  且 `send_ahead` 在整个 sendspin-cpp 源码库中**零出现** ⇒ 它根本不是 wire 字段。
- **② 时间线必须按实际产出推进**:编码器攒样期若按喂入量推进,时间线会超前约 75ms →
  设备报 `Lost sync (75006us off)` → 往音乐里**插静音**补空 → 卡顿。
  改为「无产出不推进」,零产出超 500ms 才降级(避免编码器真失效时时间线冻结)。
- **③ pacing 改为绝对时刻调度**:固定 `sleep(25)` 之外还有 encode/send 开销,实际周期约 26ms
  而时间戳只推 25ms → 每包落后 1~1.8ms 并**单向累积**(实测漂到 −611ms);
  设备 hard sync 阈值仅 **5ms**,越界即插静音 → 听感「一卡一卡」。
  改为 `due = start + i * frameMs / speed`,误差 ±0.5ms 正负自校正。
- **④ 冷起播是空操作**:`POST /peers/:id/play` → `resume()` 在「队列 `isActive` 但从未起播」
  时是空操作 → 无 `playMedia` / 无 `stream/start` = 静默。改为 `pump.active` 则原地 resume,
  否则走 `playMedia` 冷起播。
- **⑤ 脏 dial 目标致 `goodbye: another_server` 死循环**:`dial_targets.json` 残留设备自身端口
  `8928`,服务端每 60s 拨过去被判为竞争第二个 server 并踢回,继而触发 `noAutoRedial` 永久抑制。
  正确方向是**设备经 mDNS 自行拨入 38927**。
- ⑥ **协商顺序改为 PCM 优先、FLAC 兜底**(见下方新功能中的可配置项)。

### 新功能

- **默认音频编码可在插件页切换**:Sendspin 播放器插件新增 `preferred_codec`
  (**PCM(推荐,零延迟)** / **FLAC(省带宽)**),默认 PCM —— 设备侧对 PCM 只是一条 `memcpy`,
  零解码零攒样;FLAC 每 85ms 要解一个 4096 样本帧,低端 ESP32 易失步。
  偏好只决定**优先顺序**,设备不支持会自动退到另一种;切换**不中断当前流**,重新投一次歌即生效。
- **ESPHome 只读监控(6053)**:新增 `esphomeBridge`,对已连设备反向建立 Native API 连接,
  用于**保活**(设备掉网时不会因 `api.reboot_timeout` 看门狗自愈重启)与**只读状态镜像**
  (读回设备侧真实 `state` / `volume`,作为「服务端推的流有没有真的播出去」的外部判据)。
  - 插件页新增 `esphome_mirror` 开关 + `esphome_psk` 密钥;**设备 IP 自动派生,无需填写**。
  - 密钥输入框下方**常显「测试连接」按钮**,保存前即可验证:正确密钥约 2.6s 返回设备名/版本/
    当前播放状态;错误密钥约 **27ms** 即报 `Noise handshake failure`,不用干等超时。
  - 查询出口 `GET /v1/sendspin/esphome`(**不回显 PSK**);测试出口 `POST /v1/sendspin/esphome/test`。
  - ⚠️ 该链路**只做只读与保活**:设备 `featureFlags = 0x12520d` 不含
    `SEEK` / `NEXT_TRACK` / `PREVIOUS_TRACK` / `PLAY`,切歌与进度的权威始终在服务端;
    音量也请继续用 Sendspin 组音量(6053 的是 speaker 硬件音量,两者相乘会语义打架)。

### 文档

- `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` **重写**为真相版,删除上述被推翻的结论。
- 新增 `docs/SENDSPIN_PITFALLS_2026-09-18.md`:11 个踩坑条目 + 共同模式 + 取证顺序清单。

### 实测结果(ESP32-S3 `esp32-player-meet` / ESPHome 2026.9.0)

- 出声三件套齐全:`speaker_mixer Starting` → `i2s_audio.speaker Starting` → `96000 ring_buffer`。
- 设备侧自报 `state=2 (PLAYING) / volume=0.36`;服务端 `Lost sync`、`Regained` 计数均**归零**。
- 播放连续推进、自动切歌正常,长时间无重启。
- 守卫:`tsc` 通过;backend sendspin **27 文件 / 116 用例**通过;`check-i18n` 四项通过;
  前端构建通过。

## [3.0.29] - 2026-09-17

### 变更（Sendspin ESPHome 真机出声联调 — FLAC 推流对齐 MA 金标准）

- **端口与 MA 解耦**：Sendspin 服务端监听端口 8927 → **38927**（避开 Music Assistant 独占的 8927，
  二者可在同一网关共存）。前端、renderer schema 默认、测试、文档全线同步。
- **音频协商对齐金标准**：`negotiateCodec` 改为 **FLAC 优先、默认 FLAC**（原 opus/PCM 被 ESPHome
  sendspin 客户端拒收或进不了 PLAYING）；键名兼容 `player@v1_support` 与 `player_support`。
- **音频帧头补全 send_ahead**：`packAudioChunk` 帧头 9B → **13B**（`>BqI`：1B `0x04` + 8B 大端微秒时间戳
  + 4B send_ahead ms），`sendAudio` 用组公共 `computeCommonSendAhead` 填值，对齐 aiosendspin wire 格式。
- **推流空包跳过**：ffmpeg flac 流式空缓冲不再上 wire，避免严格客户端判 `Invalid data`。

### 实测结果（ESP32-S3 真机 esp32-player-meet）

- 设备成功连入 `MusicFlow Sendspin`（discovery），完整走通 FLAC 48000/2ch/16bit：Group playing →
  Stream Started → codec header flac → speaker_mixer/ring_buffer 启动 → PLAYING；MusicFlow 侧位置持续推进且自动续播。
- **仍无确定声音输出**：主要怀疑 FLAC 实时编码（ffmpeg flac EOF 前零输出，`FfmpegPcmEncoder` 60ms 兜底
  只返回空包）。下一步详见
  `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`（分段 FLAC / send_ahead 单位核对 / PCM 回退验证等）。

### 文档
- 新增 `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`（本次专项：修复过程、排查方案、已验证方案、
  未出声的下一步方向、风险点、环境速查）。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.29`（同步 `ray5378/musicflow:3.0.29`）

## [3.0.28] - 2026-09-17

### 新功能
- **Sendspin 播放器自动发现**：浏览局域网 `_sendspin._tcp`，新设备出现即自动拨号
  接入（只发现、不自动播放），前端播放目标列表自动出现，无需手工 dial。
  与记忆重拨互补：没拨过的设备靠这个首次出现；`another_server` 等拒绝过的不再骚扰；
  同目标 60s 去抖；插件配置加 `auto_discover` 开关（默认开）。
  - 边界：发现逻辑归 `services/sendspin/discover.ts`；mDNS 层只加通用共享实例
    `getSharedBonjour()`（无业务认知）。

### 测试
- 新增 `discover.test.ts`（IPv4 优选/回退、启停幂等）；`pluginConfig.test.ts` 补
  `auto_discover` 缺省与开关；sendspin 相关 71/71 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.28`（同步 `ray5378/musicflow:3.0.28`）

## [3.0.27] - 2026-09-17

### Bug 修复（ESPHome Sendspin 真机联调，全部经 ESP32-S3 真机逐条确认）
- **legacy 握手补 `server/activate` + `group/update`**：此前只发 `server/hello`，
  设备 nursery 30 秒超时、每次准时 `goodbye(another_server)` 离开。
- **`server/hello` 五字段对齐严格校验**：`server_id/name/version/active_roles/
  connection_reason` 缺一或枚举非法即整条作废；`connection_reason` 取 `discovery`
 （对照 sendspin-cpp `protocol.cpp` 源码；多 server 仲裁下不抢占已有 playback 方）。
- **`stream/start` 补 FLAC `codec_header`**：base64(`fLaC`+0x80+u24(34)+34B STREAMINFO)
  定值合成（48k/立体声/16bit，块大小 4608 与 ffmpeg 实际一致）；缺头整条作废、之后每块音频全灭。
- **协商顺序定为 flac 优先 → pcm 次选 → 默认 flac**（2026-09-17 真机实锤：MA 金标准用 FLAC 才进
  PLAYING，opus 被这类客户端拒收）。⚠️ 当时误判为 "opus > pcm > flac"，已更正（见 3.0.30）。
  ffmpeg flac 管道输出只在 EOF flush，实时推流每帧拿空包 → 空包不上 wire，随后改分段 FLAC。
- **曲终/停止/失败补 `stream/end` + `group/update(stopped)`**：此前设备永远卡 PLAYING。
- **`goodbye` 打日志 + `another_server` 等不自动重拨**（spec 语义，手动 dial 解除）；
  同目标拨号单飞（并发双连接触发设备仲裁踢人）。
- **广播 `_sendspin-server._tcp`**（供客户端发现；mDNS 层只加通用 `publishExtraService`，
  业务参数归 sendspin 包内 `advertise.ts`——包边界收敛，无核心改动）。

### 文档
- 新增 `docs/SENDSPIN_ESPHOME_DEBUG.md`：原生 API 看日志 / 抓包速查 / mDNS 速查 / 坑位表。

### 测试
- 新增 `encoding.test.ts`（STREAMINFO 结构锁死）、`legacy.test.ts` 加 activate+group/update
  顺序与 hello 五字段用例；sendspin 相关 69/69 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.27`（同步 `ray5378/musicflow:3.0.27`）

## [3.0.17] - 2026-09-14

### Bug 修复
- **流探测（`probe()`）补 content-type 校验**：200/206 但 content-type 明确非音频
  （`application/json`、`*+json`、`text/*`）改判 `gone`，不再把「HTTP 200 包 JSON 错误体」
  的假活死链当可播。
  - 实锤案例：migu 源挂时 music-dl 透传 `HTTP 200 + {"code":"200002","info":"PE参数格式错误"}`
    （47 字节），原判定判 ok → 设备拉到垃圾后 MUZO 永久卡 BUFFERING（主卧《带我走》卡在前几秒）。
  - 判 `gone` 后 `ensurePlayableStream` 自动走 `findFallbackStream` 跨平台换源并回写 URL，
    死源歌曲下一次投屏即自动落到同曲可用 web 源（无需手工修数据）。
  - 黑名单式校验：content-type 缺失、`audio/*`、`application/octet-stream`、`application/ogg`
    等模糊值保守放行（宁漏杀不错杀）。

### 测试
- `streamFallbackTtl.test.ts` 新增 3 用例（200+JSON → gone / text+json → gone / 缺失与
  octet-stream 放行）；4 个测试文件的 fetch mock 显式音频 content-type（undici 对字符串
  body 自动补 `text/plain;charset=UTF-8`，会被新校验判 gone）。全量 960/960 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.17`（同步 `ray5378/musicflow:3.0.17`）

## [3.0.16] - 2026-09-14

### 行为变更
- **shuffle 起播归属对齐纯 web 前端**：起播位置按「整列表播放 vs 指定居中某首」区分——
  - 整列表播放（未给起点，或 `startIndex ≤ 0`）且 shuffle 且多于 1 首 → 服务端**随机挑首**（不再固定列表第一首；随机只发生在服务端这一处）；
  - 指定居中某首（如音流/HA 投歌单第 N 首，`startIndex > 0`）与恢复断点（`currentIndex` 续播）→ 严格尊重该下标，不随机。
- `/v1/play` 起点定位注释同步更新（整列表起播落在第 1 首时，shuffle 下同样由服务端随机挑首）。

### 文档
- SPEC 新增「shuffle 起播归属」规则与「§1.7 统一音源裁决与取流抽象（`resolveAudio`，所有播放链路强制入口）」契约。

### 测试
- `PlayStartOwnership.test.ts` 契约守卫随新语义收敛（整列表 0 → 随机；指定中间 >0 → 尊重）；`queueModes.test.ts` shuffle 用例首曲断言改为接受任意随机起播。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.16`（同步 `ray5378/musicflow:3.0.16`）

## [2.3.27] - 2026-09-11

### Bug 修复
- 前端预探测调试日志（`console.warn`）含硬编码中文，被 i18n 守卫（源码禁硬编码中文）判红；改为英文。纯日志文案，无功能影响。

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.27`（同步 `ray5378/musicflow:2.3.27`）

> 关联客户端版本：MusicFlow Client **v4.3.45**

## [2.3.26] - 2026-09-11

### 新功能
- **三条链路共用一套服务端预探测**：服务端预探测从「只服务投屏链路」升级为
  Web / 投屏(DLNA) / 本机客户端三条链路共用的"提前找可播源"大脑。
  - 本机链路接入：`PeerManager` 本机队列也会调度预扫描，队列快照附带 `preProbe`。
  - 洗牌序修复：`enqueue` / `setPlayMode` 路径在调度前按需物化 `shuffleOrder`，
    修复「洗牌模式下向前扫描 0 个位置」（此前只有 `playFrom` 路径会扫描）。
  - 调度器多监听者：单回调改为可多订阅，投屏与本机链路并存不互相顶掉。
- `/v1/stream/probe` 新增**四态判定** `verdict`（`playable | unplayable | transient | unknown`，
  与预探测调度器同源判据）；客户端**只应在 `unplayable` 时预跳**，
  `transient`（网络抖动）/ `unknown`（未探过）必须照常播放。`ok` 字段保留向后兼容。

### 优化
- 队列预探测提示（Web 右上角持久轻提示）的文案与可读性打磨：标题改为「预探测已暂停」，标题文字改为主文本色、仅图标保留告警色；加 `aria-live="polite"` 便于读屏播报；`cooldownUntil` 缺失时不渲染倒计时；兜底文案改为「已为你缓存 N 首可继续播放」。（commit `5b23ff9`）

### 文档
- 新增 `docs/PRE_PROBE.md`：统一预探测架构说明（三条链路 / 四态判定 / TTL）。

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.26`（同步 `ray5378/musicflow:2.3.26`）

> 关联客户端版本：MusicFlow Client **v4.3.44**

## [2.3.25] - 2026-09-11

### 新功能
- **队列预探测（Pre-probe）**：在播放 / 投屏前提前扫描后续歌曲的可用音源，让切歌零等待；当连续默认 50 首无可用音源时自动暂停预探测并提示，冷却（默认 90s）后自动重试。无效源只做「留队列 + 短 TTL 跳过」，**绝不写入数据库、不做死歌名单**，源后续变有效即可被重新采用。
- `core-pre-probe` 内置插件（9 项配置：lookaheadSongs / deadRunLimit / exhaustedCooldownSeconds / 各类 TTL / 并发数等）
- `QueueController` 改为留队列跳过 + 绕圈上限（= 队列长度），避免死源误删与无限跳曲
- Web 端右上角持久轻提示（不自动关、手动关闭、按设备去重），**不上 HA 卡片**

### Bug 修复
- 可播性缓存加时间戳与双向 TTL（已缓存可播 1h / 已知不可播 45s / 网络瞬断 5s 退避），修掉「一次网络抖动被永久拉黑」的问题

### 文档
- 移除 HA 加载项（hassio-addons）相关引用，不再发布 HAOS 容器镜像

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.25`（同步 `ray5378/musicflow:2.3.25`）

> 关联客户端版本：MusicFlow Client **v4.3.43**（需配对升级以启用客户端侧四态播放模式与预跳过）
