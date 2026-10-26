# MusicFlow AirPlay 1/2 × Sendspin 桥接：最终实施方案（开发执行版）

## 文档关系（先读这一块）

> **本文件的角色**：**历史方案（Phase 计划），不是事实来源**。它记录的是「为什么这样设计 + 分阶段怎么实施」，以及六轮复核 / 两轮 red-team 终审推翻与修正的索引。**落地与否一律以文首「落地状态总表」和三份权威文档为准**；本文的 Phase 条目、行号、字段名可能已过期。

**5 份相关文档（都在 `docs/`，链接可直接点开）**

| 文档 | 角色 | 一句话用途 |
|---|---|---|
| [airplay-权威方案文档.md](./airplay-权威方案文档.md) | 权威现状 | AirPlay/RAOP 协议正确做法、airplay 子进程、桥接环（帧格式/锚点/stats）与 AirPlay 侧守卫 |
| [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) | 权威现状 | Sendspin 协议链路、FLAC 链路、ESPHome 设备端配置、多房间组与组泵 |
| [group-权威方案文档.md](./group-权威方案文档.md) | 权威现状 | 群组数据模型与生命周期、选歌硬约束、出流双路、组成员、延迟补偿 |
| [AirPlay1-2与Sendspin桥接-最终实施方案.md](./AirPlay1-2与Sendspin桥接-最终实施方案.md) | **历史方案（Phase 计划）** | 桥接的开发执行版：决策定案、四条「为什么」、阶段落地表、AP2 契约 |
| [AirPlay1-2与Sendspin桥接落地方案.md](./AirPlay1-2与Sendspin桥接落地方案.md) | **历史方案** | 桥接的调研与落地方案：MA 精要、MusicFlow 现状盘点、三条病根 |

**硬口径**：**历史方案文档不再作为事实来源；任何冲突以三份权威文档为准。** 历史方案文档只保留「为什么这样设计」与「当时踩了什么坑 / 推翻了什么」两类价值 —— 其中的 Phase 条目、行号、字段名一律可能过期。

**三份权威文档的分工边界（排障时先按这张表定位文档）**

| 问题域 | 归属文档 |
|---|---|
| 协议（RTSP / RAOP / AP2 报文、Sendspin 帧与握手配对）、airplay 子进程模型、桥接环（28B 帧 / 锚点公式 / `stats` 判据） | [airplay-权威方案文档.md](./airplay-权威方案文档.md) |
| 设备协议（Sendspin 连接 / 编码协商 / 预填充水位 / pacing / 音量）与组泵（`SendspinGroup.pushFrame`、`pcm:100` 编码组、晚加入回填） | [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) |
| 组成员与命名空间、生命周期状态机、选歌推进硬约束、出流双路（组泵 / AirPlay 桥）、延迟补偿、组验收判据与失败速查 | [group-权威方案文档.md](./group-权威方案文档.md) |

---

## 落地状态总表（群组 / 组播 / 混合组 / 组成员 / 延迟补偿）

> 判定时间 **2026-10-26**，基线 `6c13bd6`（含 v4.6.77 = `0ed0892`、群组守卫 = 本批）。三态口径：`✅ 已落地`（有代码或提交可指）／`⏳ 待排期`（缺口明确、尚未实现）／`⊘ 已裁定例外`（原文前提不成立，或已明确决定不做）。判定方式：能看代码就看代码，不看记忆；权威现状见 [group-权威方案文档.md](./group-权威方案文档.md)。

| 条目 | 状态 | 证据 |
|---|---|---|
| 路由快照：`bridge` / `legacy-cast` 二选一，流内不切 | ✅ 已落地 | `group/protocolPlayer.ts:313-343`（`playMedia` 内快照 + `activeBridgeRoutes.set`） |
| 混合组（在线 sendspin>0 且在线 AirPlay>0）走桥；纯 AirPlay 走逐设备 cast | ✅ 已落地 | `group/protocolPlayer.ts:324`（`spinOnline.length > 0 ? prepareBridgeRoute(apOnline) : null`）+ `:339-343` |
| 桥 `prepare` 单设备失败 ⇒ 该设备本流回落 solo cast（`soloFallback`） | ✅ 已落地 | `group/protocolPlayer.ts:296-308`（逐设备 try/catch → `soloFallback.push`） |
| 全成员 cast 失败 ⇒ **先拆桥路由再抛**（原「孤儿桥/设备被占只能重启」缺陷） | ✅ 已修复（本批） | `group/protocolPlayer.ts:346-361`（洞 D1：`:354` 先 `teardownBridgeRoute()`、回收失败只 warn，`:360` 再抛原始错误） |
| 流内成员变化：加入 `bridgeJoinMember`（泵侧 sync 失败回滚半挂 route）/ 摘除 `bridgeLeaveMember` | ✅ 已落地 | `group/protocolPlayer.ts:38`（泵侧 sync 失败回滚 `:56-67`）、`:74 bridgeLeaveMember`；`activeBridgeRoutes` 为单一事实源 |
| 组成员准入校验（拒 `dlna:`+裸 id+`group:`+`local:`+重复+非字符串） | ✅ 已落地 | `group/index.ts:361-385` `assertMembersAvailable`（`:366` 重复判定、`:382-383` dlna 抛错），`setMembers` 与 `applyMemberDelta` 两入口都调用。**准入只作用于「相对现有成员新加入」的部分**（`setMembers` 校验 `newOnes` `:227-228`、`applyMemberDelta` 校验 `added` `:251-260`；`createGroup` 仍全量 `:167`）——**历史成员不拖累本次提交**，否则组里剩 ≥1 个历史 DLNA 成员时加减任何成员都 400、≥2 个时逐个删也清不干净 ⇒ 组被永久锁死；提交列表本身的结构/重复校验改由入口显式做（`setMembers:221-226`） |
| 「`setMembers` 不校验 kind / allowlist 尚未加」 | ⊘ 已裁定例外（**前提不成立**） | 同上一行：两入口都在准入前先做差集（`newOnes`/`added`），校验确实生效，不需要额外 allowlist；差集是本意（见上一行的「否则组被锁死」） |
| 摘组不留孤儿桥成员（`detachFromActiveGroups` 补 airplay 分支） | ✅ 已落地 | `routes/api/shared.ts:651-665`（`:654` 已允许 `airplay`） |
| 桥占用设备与 native cast 互斥（owner=bridge）、`stopAirPlaySessionsForHost` 不误杀桥 | ✅ 已落地 | `airplay/control.ts:274-290`（`bridgeOwners`）、`:373-381`、`:836-839` |
| 状态派生：桥路由下位置/时长/播放态一律从泵派生（leader 是 AirPlay 也不读 solo 会话） | ✅ 已落地 | `group/protocolPlayer.ts:397+` `pollState` |
| 虚拟 `pcm:100` 组：只有桥、没有真实 pcm 成员时仍产出并推进 `deliveredPeak` | ✅ 已落地 | `sendspin/server.ts:1452-1467`（组内时间戳基线注释 + `deliveredByGroup` 打戳） |
| 组内单泵、无第二条选歌路径 | ✅ 已落地 | 见 [group-权威方案文档.md](./group-权威方案文档.md) §3.5 |
| 混合组起播 lead 从 500ms 抬到 1.75s（否则每首歌丢开头 ~1s） | ✅ 已落地 | commit `1b2a57b`；契约反转见 [group-权威方案文档.md](./group-权威方案文档.md) §7.1 |
| 组 A/V 延迟补偿：两值 `airplay_delay_ms` / `sendspin_delay_ms`，±30000ms、步进 10ms、正数=该侧更晚出声 | ✅ 已落地（v4.6.77） | commit `0ed0892`；常量 `services/group/delayCalib.ts:20-23`；接口 `GET/PUT /v1/groups/:id/delays`（`routes/api/groups.ts:107-160`）；AirPlay 侧改值必须重建该组桥（~1–2s 静音），Sendspin 侧帧级实时。详见 [group-权威方案文档.md](./group-权威方案文档.md) §6 |
| 延迟补偿范围口径「±2000ms」 | ⊘ 已裁定例外（**该数值是 `bridgeCalib` 全局位移的范围**，不是按组补偿） | 按组：`GROUP_DELAY_MIN_MS/MAX_MS = ∓30000`（`delayCalib.ts:20-21`；文件头 `:3` 与 `clampGroupDelayMs` docstring `:41` 现均写 ±30000，历史「±2000」过期注释已于 2026-10-26 随 O2 修复清除）；全局兜底 `bridge.avShiftMs` 才是 ±2000（`airplay/bridgeCalib.ts:21-22`） |
| 桥会话音量路由（桥占用设备的 `setVolumeDb` 落空） | ✅ 已修复（本批） | `airplay/childMain.ts:119-130`：native `runtime.setVolumeDb` 未命中 ⇒ 回落 `bridgeSessions.setVolumeDb` ⇒ `bridgeSession.ts:773-778` |
| 每首歌无条件拆建桥路由（同流内重复付建桥成本） | ⏳ 待排期 | `group/protocolPlayer.ts:320-324`（`playMedia` 开头无条件 `teardownBridgeRoute()` 再 `prepareBridgeRoute`） |
| `/rest/airplay/stream/:token` 无首字节上界 | ⏳ 待排期 | 取流 handler 未设「首字节超时」（token 签发 `services/airplay/session.ts`，消费端 `serveCastStream`） |
| `sessionRuntime.seek` 无 deadline | ⏳ 待排期 | `services/airplay/sessionRuntime.ts:339-360`（`prepareSeek` + 等旧循环，无超时上限） |
| 成员前缀常量散落 ≥8 处未收敛 | ⏳ 待排期 | `sendspin/peer.ts:664`、`QueueController.ts:34-37`、`playTarget.ts:74` 各自独立解析 `airplay:` / `sendspin:` |
| 「组播（multicast）」作为出流方式 | ⊘ 已裁定例外 | 本仓**没有**组播出流：组内 = sendspin 组泵逐成员 WS 下发 + AirPlay 桥逐设备 RAOP，不存在「一包多收」路径 |
| 群组不变量静态守卫 `check-group-invariants.mjs`（G1~G12 + G12b，35 条断言 + 4 项 TODO 缺口登记） | ✅ 已落地**并已挂 CI** | `backend/scripts/check-group-invariants.mjs`；`.github/workflows/ci.yml` job `group-invariants-guard`（第 26 个 job，`ci.yml:356`；step `ci.yml:362` 直接 `node backend/scripts/check-group-invariants.mjs`，位于 `workflow-paths-guard` 之后、`audio-output-format-guard` 之前）。**不需要**往 `backend/package.json` 加 npm script |
| AP2 发送端（`airplay/ap2/`） | ⏳ 未接入生产链路 | **15 文件 3067 行：已实现并有 7 个协议级 QA 用例直接覆盖**（`tests/airplay/ap2Session|ap2Transport|ap2HapPairing|ap2HapCredentials|ap2Trace|ap2Audio|ap2Contract.qa*.test.ts`），但 `control.ts` / `childMain.ts` 无任何静态引用、也无 flag 入口 ⇒ AP2 设备仍走 `raop`。**不是「空目录」，也不要当成可删死代码** |

---

## 0. 已被证伪的旧设计（不得再按旧稿实现）

| 旧设计 | 被什么推翻 | 现在的做法 |
|---|---|---|
| `sender.start(anchorUnixMs)`（Unix 毫秒锚点） | RAOP 的 `ntpNow()` 用 `performance.now()`（子进程单调 ms），Sendspin 的 `nowUs()` 用 `hrtime`（单调 µs），两者都不是 Unix 时间 | 统一 host-monotonic µs（`utils/hostClock.ts`），`ntpNow = ntpFromHostUs(nowUs())`；锚点链禁 `Date.now`/Unix |
| `latencyFrames` 归零（「去掉双层延迟」） | 它是**接收端播放保持深度**，RECORD 回 `Audio-Latency` 还会抬高，并进 SYNC 包（`headTs − latencyFrames`） | 保留，纳入公式 `startNtp = NTP(A − L)`，且记住「**`A − L` 是唯一补偿点**」 |
| `D4 = scalePcm 数据缩放`（PCM 上做音量） | `offloadsVolume()` 恒 true、`appliedGain()` 恒 100，PCM 本来就是 unity（`server.ts:724`/`:737`） | 音量走设备输出级：`setAirPlayVolume` / `setAirPlayMuted` |
| `members: Set<SendspinConnection>` 改成 `Set<GroupSink>` | 真实使用面还有 `clientWantsStream`/`sendJson`/`sendPlayerCommand`/`legacy`/`muted`/`sinkHealth`/`lastBufferedAmount`/`announceStream`，且 `broadcastGroupState` 会把桥成员当组员下发 | `members` 原样不动；新增并行 `bridges: Map<deviceId, AirPlayBridgeMember>`，只在 `pcm:100` 编码组投递 |
| 三进程里由 sendspin 子进程 `start()` 并 await ack | RAOP 会话与锚点都在 airplay 子进程，跨进程无法 await 同一对象 | airplay 子进程持有 bridge session，收首帧自行定锚；sendspin 只送 PCM 与边界帧 |
| 帧格式 `[u32 len][i64 tsUs][payload]` | 缺版本/类型/代次/序号，seek 后旧帧会污染新流 | 28 字节头（magic/version/type/flags/generation/sequence/tsUs/payloadLen） |
| `sendAudio()` 返回 false 就「暂停该成员投递」 | `sendAudio` 是同步 `void`，无法暂停 `pushFrame`，组泵不能为单个桥停摆 | 每桥独立有界队列 + 独立 drain；溢出断连重连，**禁止丢最旧帧** |
| Phase 5「先 NTP，PTP 以后再说」覆盖 AP2 buffered | buffered（type 103）依赖 PTP；NTP 只适用 realtime（type **96**） | Phase 6 只做 realtime+NTP；buffered+PTP 单列 Phase 7 |
| 桥 lead 并进 `commonSendAheadUs()` | 帧头不含 `send_ahead`，设备按自己的 800ms 判过期 ⇒ 全组 `delta` 恒 +3.7s | lead 只进 `streamEngine.anchorLead`（见 §2.3） |
| 代次只取 `timelineReseed` 或只取 `epoch` | `timelineReseed` 只在 `rehost()` 自增（`:1291`），seek 走 `stop()/play()` 只动 `epoch` ⇒ 单用任一个都会漏 | 二元组 `epoch * 1_000_003 + timelineReseed`（见 §2.4） |

---

## 1. 决策定案

| # | 决策 | 定案 | 推翻条件 |
|---|---|---|---|
| D1a | AP1 采样率 | 强制 44100；airplay 子进程内 48k→44.1k 有理数多相 FIR（L=147/M=160，群延迟 0.3627ms） | 有 AP1 设备实测接受 48k 且证明未内部重采样 |
| D1b | AP2 采样率 | 以 SETUP 协商为准；48k 优先，失败回落 44.1k。不得把「AP2 必 48k」写死 | 接收端 `/info` 与 SETUP 能力矩阵实测推翻 |
| D2 | 时钟与时间戳 | **host-monotonic µs 是唯一内容时间轴**。Sendspin `tsUs` = 首样本应可听时刻。RAOP NTP 由同一 host 时钟构造 | 跨机播放（非本方案范围） |
| D3 | 数据面与所有权 | 三进程：主进程只编排；sendspin 子进程产 PCM；airplay 子进程持有 bridge session、重采样、对齐、节流、RAOP 输出。PCM 不经主进程 | 管道吞吐实测不足 |
| D4 | 延迟分层 | 启动 lead、持续缓冲、接收端 latency **三层分离**：cold 4500ms / warm 2500ms 只进 anchorLead；`minBufferMs=1000` 进 `commonSendAheadUs`；`latencyFrames` 保留并进锚点公式 | 接收端实测要求不同 lead，按设备矩阵调整常量 |
| D5 | 音量 | 设备输出级音量，PCM unity。复用 `setAirPlayVolume` / `setAirPlayMuted` | 用户要求 PCM 独立增益（会与设备音量相乘，需另设计） |
| D6 | 分派与生命周期 | 每个「播放流」开始时快照路由：在线 Sendspin >0 且在线 AirPlay >0 ⇒ 桥；纯 AirPlay ⇒ 旧逐设备 cast。流内不切路由 | 实测需要无缝热切换 |
| D7 | AP2 | 后置且拆分：realtime+NTP 先做；buffered+PTP 单列。AP2-only 发现需同步改 discovery/测试/守卫 | 有必须 buffered 的设备 |
| D8 | 锚点「ack」 | 自研 RAOP 无设备级 START ack。**禁止伪造 ack**。字段名 `scheduledAnchorUs`，不叫 `acked` | 引入可读取设备确认的协议路径 |
| D9 | 灰度 | `MUSICFLOW_AIRPLAY_BRIDGE=1` 默认关；flag 关 = 完整旧路径（运行中改 flag **不拆**已建桥，需等下一首/重启） | 无 |

---

## 2. 四条不可省的推导（其余实现细节见权威文档）

> 本节是本文相对三份权威文档的**唯一增量**：权威文档给结论，这里给「为什么结论是这样」。实现级坐标见
> [airplay-权威方案文档.md](./airplay-权威方案文档.md) §10（桥接环）、§9.3（`bridgeSession`）、§9.2（`raop`）。

### 2.1 为什么是 `startNtp = NTP(A − L)` 而不是 `NTP(A)`

- `sendSync()` 的公式是 `ntp = startNtp + (headTs − startTs)/rate`（`raop.ts:731-733`）。
- 接收端把这条 SYNC 当作「**当前播放头**的 RTP/NTP 对」，并在 RTP 头再减一个 `latencyFrames`（`raop.ts:727`，offset 4 = `headTs − latencyFrames`）。
- 于是首包 `headTs` 的可听时刻 = `ntp(headTs) + L = (A − L) + L = A`。
- 写成 `NTP(A)` ⇒ 恒定晚一个 `L`（约 1s）；把 `latencyFrames` 归零 ⇒ 接收端保持深度被破坏 ⇒ 欠载/抖动。

**成立前提（缺一不可）**：① `baseTs` 与 `startTs` 同域同值；② 四个锚点在同一 32 位模域；③ RECORD 的
`headTs -= headTs % CHUNK_LEN` 向下对齐（`raop.ts:600`）会带来 0~7.98ms 偏斜，而 `startNtp` 取的是**对齐前**
的 `ntp0`（`:603`）⇒ 覆盖锚点时四字段要按同一套算术重算。

> ⚠️ 未实测项：「接收端把 SYNC offset4 解释为当前播放头 RTP」目前只有推导。唯一证伪手段是与
> `cliairplay` 同源 A/B（它不做 `A−L` 补偿，若我们错一整个 `L`，A/B 会暴露 ≈1s 差）。

### 2.2 四个锚点必须一起写（漏 `baseTs` 静默出错）

`raop.ts:272-284` 有 **四个**字段；进度是 `positionSec = ts2ms((headTs − baseTs) >>> 0) / 1000`（`:694-695`）。
只改 `startTs` 而把 `baseTs` 留在 RECORD 值 ⇒ `(headTs − baseTs)` 指向错误内容位置 ⇒ 进度/曲末判断全乱，**且不报错**。

同时两条硬约束：

1. **顺序写死**：先 `>>> 0` 再 `% CHUNK_LEN`（先对齐后截断会残 32：`2^32 % 352 = 224`）；只能用 `>>> 0`（`& 0xFFFFFFFF` 在 `0xFFFFFFFF` 处得 `-1`，负余数破坏 352 对齐）。`ntp2ts` 本身不做截断（`raop.ts:93-95`），44.1k 下 `2^32/44100 ≈ 27.05h` 即越界。
2. **桥路径禁触发 RAOP 位置重锚**：`RaopPlayer` 上**没有** `seek()` 方法（守卫不要写成 `raop.seek()`）。真实入口三个：`prepareSeek()`（`:842`，调用者 `control.ts:1015`）、`setStartPosition()`（`:868`，调用者 `control.ts:456`/`sessionRuntime.ts:161`）、`sessionRuntime.cast()` 的 `seekSec`。三者都把 `startTs` 重锚而 `startNtp` 不动 ⇒ 映射当场崩 —— 这是 2026-10-21「拖动进度后彻底无声」的成因（原始日志在 `raop.ts:274-283`：`31.08 seconds ahead` / `crazy time interval of -30.08 seconds`）。

### 2.3 为什么启动 lead 绝不能并进 `commonSendAheadUs()`（+3.7s 事故）

1. **帧头里没有 `send_ahead`**：`sendAudio` 头是 9 字节（1B type + 8B µs 时间戳），`server.ts:2380-2382` 注释原文记着「曾经多塞 4B ⇒ 设备把其当 FLAC 前 4 字节 ⇒ 全无声」。设备判过期用**它自己**的默认 800ms（`server.ts:1271-1272`）。
2. 并进去 ⇒ 全组时间戳推后 4.5s、设备仍按 800ms 判 ⇒ `delta = (ts − 800ms) − now` 恒 **+3.7s**。`commonSendAheadUs()` 的注释（`server.ts:813-814`）明确要求它与帧头值同源，否则「设备立刻判已过期 → underrun」。**照旧稿实现会把一台正常工作的 ESP32 打坏。**
3. `computeCommonSendAhead` 把两个语义合并成一个数（`group.ts:76-92`：`lead = max(minBuffer, requiredLead)`）⇒ 并入 4500 后「热启 2500 / 持续 1000」永远不出现，D4 三层分离自动失效。

定案：`computeCommonSendAhead` 保持原样，桥只上报 `minBufferMs=1000`；启动 lead 走
`bridgeStartLeadUs()`（任一台冷启 ⇒ 整组 4500ms，warm 事实由 airplay 侧 `CONFIG` 回执的 `warm:boolean`
下发，未收到回执一律按 cold），并且 **`streamEngine.pushLoop` 的预填充钳制必须按桥分流**，否则 4500 会被
`ANCHOR_SAFE_LEAD_US = 800_000`（`streamEngine.ts:136`）截成 800ms —— 这是旧方案「上报即获得冷启动窗口」不成立的原因。

> `ANCHOR_SAFE_LEAD_US` 三个消费点已核验：`:846` 是真钳制（必须绕过）、`:1028` 是预填充使能门（不动）、
> `:1082` 是曲末排空量（**副作用**：lead 4.5s 时曲末等待从 ~3s 变 ~3.7s，已接受）。
> 回归判据：纯 sendspin 组 + 1 台桥同时在线，真实设备侧 `delta` 不得出现常数 +3.7s。

### 2.4 代次 = `(epoch, timelineReseed)` 二元组，且 `rehost()` 绝不能加 `epoch++`

- `timelineReseed` 全仓**只有一处自增**：`streamEngine.ts:1291`，在 `rehost()` 内。
- `seek()`（`:1213-1234`）只写 `positionMs`/`reportedFloorMs`/`pendingSeekMs`，**从不碰** `timelineReseed`；seek 走 `seekCore → playGroupCore`（`playerCore.ts:649-712`）完整重建 ⇒ `pump.stop()`+`play()` 各 +1 `epoch`。
- `rehost()`（`:1270-1299`）**完全不自增 `epoch`**、不调 `stop()`，只做 `prev.timelineBaseUs=0n → this.group=next → timelineReseed++`。
- ⇒ 单用任一分量都会漏：只用 `timelineReseed` 漏 seek，只用 `epoch` 漏 rehost（借流移交后旧锚点配新基线 ⇒ 永久错位）。

定案：`get generation() { return this.epoch * 1_000_003 + this.timelineReseed; }`（乘法混合防两个分量交替自增撞出同一个和），钩子只挂 `streamEngine.ts:813` 的现有重锚分支（一行判断都不改），`bridgeMember` 只在**投递路径**比对，不用定时器。

> **🔴 禁止给 `rehost()` 加 `this.epoch++`**：`:759` 的推流循环是 `while (this.running && this.epoch === myEpoch)`，自增会让它立刻退出，把「移交」变成「停播」。
> **BOUNDARY 只做两件事**：清队列 + 换代次，**绝不 TEARDOWN** RAOP 会话。

### 2.5 28B 帧与背压（两个都只能照抄）

```
offset size field
0      4    magic = "MFAB"
4      1    version = 1
5      1    type: 1=AUDIO 2=BOUNDARY 3=CONFIG 4=HEARTBEAT 5=STATS
6      2    flags
8      4    generation (u32)
12     4    sequence (u32)
16     8    tsUs (i64，仅 AUDIO)
24     4    payloadLen (u32，上限 1 MiB)
```

- `AUDIO` payload = `s16le/48000/2ch`；`CONFIG` = `{deviceId,protocol,rate,channels,format,sessionToken,warm}`；`BOUNDARY` = `{reason:"track"|"seek"|"stop"|"rehost"}`；`HEARTBEAT` 收端 2s 无帧即 stalled。非法 magic/version/长度立即断连（防错位后继续解析垃圾）。
- **socket 路径必须短**：`sun_path` 上限 108B，超了是「每台桥都建不起来」的全量故障。用 `<tmpdir>/mfab/<11 位 sha1 前段>.sock`，`deviceId`/`token` 只进 `CONFIG` payload，`bridgePrepare` 前断言 `byteLength < 100`。
- **背压**：`sendAudio()` 同步入队立即返回；高水位 2s 只告警，硬上限 8s 关 socket → `live→stalled→connecting→live`，5s/30s 退避（±20% 抖动，防 N 台同时掉的同步重连）。阈值按「秒」不按字节（两侧口径必须同为 48k 输入：8s = 1,536,000B；用 44.1k 口径会比发送侧早 124KB 断连）。**禁止丢最旧帧继续播** —— 时间戳连续但内容有洞 ⇒ 对齐逻辑当空洞补静音 ⇒ 听感随机静音，比明确断开更难查。
- 投递侧窗口（FLOOR 1.5s / HORIZON 2.5s / tick 250ms / 回填封顶 6s）与代次戳判据见 [airplay-权威方案文档.md](./airplay-权威方案文档.md) §10.4。

---

## 3. 🔴 硬性约束：切歌预取/完整性判定语义不变（用户锁定，不可协商）

桥接群组的选歌与推进路径必须与现有 sendspin 群组**完全一致**：

- **第一首**：直接起播（现行 head-wait/TTFB 行为不变）。
- **第二首起每首**：必须预下载进内存并经 `prefetchCache.judgePrefetchedBuffer` 完整性判定；不完整 ⇒ `markUnplayable`（TTL 5min）⇒ 跳过 / 组内换源（上限 3）。
- **桥（AirPlay 成员）只是组泵 PCM 的旁路接收者**：预取、判完整、跳过、换源全部发生在上游（`streamEngine`/`prefetchCache`），桥不得参与、更不得引入绕过这些逻辑的第二条选歌路径。
- 落点：`pushFrame` 的桥接投递是纯数据面；出口判据见 §4 P3 行「切歌预取语义不变」。权威口径见 [group-权威方案文档.md](./group-权威方案文档.md) §3.5/§3.6。

---

## 4. 阶段落地表（P0~P8）

> 每阶段出口：单测 + 守卫 + 日志证据，守卫与源码同 commit。无法运行的验收明确标 BLOCKED，不得写成已通过。
> 已落地阶段的原始工期与逐条清单不再保留（在 git 历史里），这里只列**现状 + 残余缺口**。

| 阶段 | 状态 | 落地证据 / 一句话出口判据 |
|---|---|---|
| **P0 验收链**（门禁） | ✅ | 240 容器实测：假 Sendspin 收流 `[first] ts=742556162177 dur=25000 bytes=4800 fmt=PCM/48000/16/2`、落盘 peak 26131 / RMS −17.1 dBFS / nonzero 99.98%；AP1 真抓 `arecord -f S32_LE` peak −39.56 dBFS、nonzero 1.0；`cc_align.py` 三项自检通过；端到端 Δ=−7461.4ms 在 20/30/45s 三窗口一致。**P0 仍欠两项**：宽带源/正弦源各一份（BLK-03）、对 1kHz 源跑一次「拒绝出 Δ」。 |
| **P1 时钟+重采样+纯函数** | ✅ | `hostClock.ts`/`rates.ts`/`resampler.ts`/`bridgeMath.ts` 均在；出口＝`ntpNow` 与 `nowUs` 差 <100µs、160000 帧→147000 帧零漂移、1kHz≤0.5% / 23kHz≥40dB、脉冲落 `A+0.3627ms`、`sec=100_000` 下 `positionSec` 仍正确 |
| **P2 通道 + bridge session** | ✅ | 28B 编解码 + unix socket + 有界队列在；出口＝10 万帧往返字节一致、kill 任一端 ≤6s 重连、192KB/s×3 跑 10min RSS<10MB |
| **P3 组泵出声** | ✅ | 虚拟 `pcm:100` 组在 `sendspin/server.ts:1452-1467`；路由快照 `group/protocolPlayer.ts:313-343`。出口＝`members=∅`+1 桥时 `pushFrame` 返回 >0 且桥收到字节（BLK-01 正向用例）；**切歌预取语义不变**（连播 3 首，第二首起出现判完整/`markUnplayable` 日志，与纯 sendspin 组同源同数据行为一致）；纯 sendspin + 1 桥时 `delta` 无 +3.7s；同一 deviceId 的 airplay 会话计数恒 1 |
| **P4 锚点/对齐/无 ack** | ✅ | 锚点 `firstFrameTsUs + anchorShiftUs`（`bridgeSession.ts:209`）；`ev:"anchor"` 报 `scheduledAnchorUs` 而非 acked。出口＝宽带源互相关 `|Δ|≤20ms` 且 `quality≥0.2`；`p95(|delta|)≤20ms` 且斜率 ≤1ms/10s；`latePackets=0`；AP1 落盘基频 ±0.5% |
| **P5 生命周期/背压/热复用** | ✅（**跨曲复用 ⏳**） | 背压 `bridgeSource.ts:163-180`；warm lead `rates.ts:36`。出口＝连续 seek 3 次每次都出新 generation + 新 `scheduledAnchorUs` 且旧代次丢弃 >0、`bridges.size` 不变；rehost 一次也必须出新代次（R1 专项）；队列压爆状态机 `live→stalled→connecting→live`。**缺口**：同一流内每首歌仍无条件拆建桥（`protocolPlayer.ts:320-324`） |
| **P6a AP2 凭据契约** | ✅ 已实现（未接线） | `hap_credentials`（`db/index.ts:469`，192hex = 64 LTPK + **128** LTSK，切分唯一出处 `ap2/hapCredentials.ts`）；写入时机＝pair-setup M1-M4 成功、verify 失败不写；出口＝重启进程后免 PIN 重连 |
| **P6b AP2 realtime + NTP** | ✅ 已实现（未接线） | 15 文件 3067 行 + 7 个 QA 用例；`AP2_REALTIME_STREAM_TYPE = 96`（`ap2/ap2Stream.ts:38`）。出口见 §5 口径表 |
| **P7 AP2 buffered + PTP** | ⏳ 待排期 | 见 §5 |
| **P8 守卫与收尾** | ✅ | `check-airplay-bridge.mjs` 已挂 CI（17 组 / 运行时 69 条，冻结口径见 [airplay-权威方案文档.md](./airplay-权威方案文档.md) §7.7）；群组守卫 `check-group-invariants.mjs` 已挂第 26 job |

---

## 5. AP2（未落地部分，保留完整口径）

### 5.1 为什么拆成 6a / 6b / 7

凭据契约（6a）曾被写成「待定义」却要求出口「配对全跑通」，而「只在内存里的配对成功」重启即失、A/B 无法复现 ⇒ 6a 门禁化。
realtime（type 96，RTP/UDP，NTP）与 buffered（type 103，RTP/TCP，**依赖 PTP**）是两套工程，**不能把「先 NTP、PTP 以后再说」套到 buffered 上**。

### 5.2 AP2 测量口径（唯一可用判据；旧口径已作废）

| 项 | 现行口径 | 为什么（旧口径的错法） |
|---|---|---|
| 锚点 | **SETUP(stream) 响应到达时刻** | 原用 RECORD：床侧 `SETUP(stream)` 开销 461.8–465.7ms 占该区间 **98.4%**，测不出我方 |
| 量 | 首包到达 | — |
| 判据①严格（排程保真） | `|slope−1| ≤ 5e-5`、回归残差 RMS ≤1ms、三段窗截距极差 ≤1ms、零丢乱序 | 2026-10-25 实测全 PASS（残差 0.32–0.53ms） |
| 判据②宽松（起播对齐） | `|Δ| ≤ 20ms` | 实测 **Δ=−13.16ms**；`≤5ms` 只适用于斜率/线性度，**不适用于绝对起播时刻**（我方 lead 自带 ±30ms 方差） |
| 采样 | 抓 UDP 明文 RTP 头 `(arrival, rtp_ts)`，各自以锚点归一，比**同一 `rtp_ts` 偏移**的到达差 | 「首包到达时刻差」测的是「谁先开始发首包」：cli 的 `SETUP响应→首包` 随 `START_OFFSET_MS` 整体平移（0→47.9ms、1500→939.9/945.9ms、3000→2433.3ms） |
| 禁止 | **禁用床 `out.pcm` 做互相关** | 该文件已过床的 `AudioResampler(48000)`，帧数膨胀 12/11（+9.09%，数据率同时变 48k，时长守恒）⇒ 只产生 −0.22% 表观偏移，且带恒定 384 帧补帧造成的 125Hz 边带 |
| 时钟就绪 | **不用** `clock_ready`/`exchanges` 作判据 | cliairplay 在 `timing=ntp`+realtime 下**结构性不发 NTP 探测**（`[CLOCK] host clock realtime`），`state=cold exchanges=0` 是设计 |
| 存在性 | cliairplay `[STATUS] playing` 且床侧落盘帧数 ≥ 期望时长 95% | — |
| A−L 假设 | 已被反证排除 | 若错一整个 L≈1000ms，截距会整体平移 1000ms 级；实测 slope 1.000000、残差 0.32–0.53ms |

> 待办（协议保真，非阻塞）：cli 每场首包 `marker=1`，我方 `marker=0`，建议在 `ap2/rtpAudio.ts` 对齐。

### 5.3 Phase 7 清单（buffered + PTP，未开始）

- buffered stream type 103、RTP/TCP、PTP 时钟；共享 PTP daemon，**组内绝不混 NTP/PTP**；spawn 窗口未就绪不能简单降级 NTP（桥 lead 已固定，等待会把锚点推过已调度音频）。
- PTP 需特权端口 UDP 319/320。
- AP2-only 设备发现：现在 discovery 只允许 `_raop` 创建设备、`_airplay` 仅补能力；要支持 AP2-only 必须同步改 `discovery.ts` + 测试 + 守卫。
- Apple 接收端「NTP realtime 无声」需建矩阵：设备型号 × 协议 × 计时源 × 结果。
- 出口：buffered 单设备 A/B、组内 `clock=PTP` 计数一致（任一 `clock=NTP` 即 FAIL）。

---

## 6. 验收判据索引（数值 = 已跑出来的实测结果；判据定义见 §4 阶段表的「出口」列）

| # | 场景 | 实测结果 | 状态 |
|---|---|---|---|
| 1 | 假设备真实收流（240） | `[first] ts=742556162177 dur=25000 bytes=4800 fmt=PCM/48000/16/2`、peak 26131 / RMS −17.1 dBFS / nonzero 99.98% | P0 ✅ |
| 2 | AP1 接收端真抓 | `arecord -f S32_LE` peak −39.56 dBFS、nonzero 1.0、分段 RMS 起伏 12.3 dB（`-f S16_LE` 得全 0） | P0 ✅ |
| 3 | Δ 测量链端到端 | 同歌并行投 sendspin + AP1：Δ=−7461.4ms 在 20/30/45s 三窗口完全一致（桥接后应收敛到 ≤20ms） | P0 ✅ |
| 4 | 测试源（BLK-03） | 宽带源 + 1k/15k/23k 正弦各一份；对 1kHz 源必须报「源不适用」 | P0 ⬜ |
| 5 | 与 cliairplay A/B（AP2） | 排程保真 slope 1.000000±5e-5 / 残差 0.32–0.53ms / 三段窗极差 ≤0.7ms / 0 丢 0 乱；起播对齐 **Δ=−13.16ms** | P4 ✅ |
| 6 | 跨协议同步 | `|Δ|≤20ms`、`quality≥0.2`、`p95(|delta|)≤20ms`、斜率 ≤1ms/10s | P4 ✅ |
| 7 | 多桥并发 | AP1×1+AP2×2+假 Sendspin×1 同组 30min：RSS <20MB、每桥 `maxQueueMs<2000`、`late=0` | P5 ✅ |
| 8 | AP2 凭据 | 重启进程后免 PIN 重连（判据本身即出口） | P6a ✅（未接线） |

> 其余判据（`members=∅`+1 桥、纯 sendspin+1 桥无 +3.7s、seek/rehost 出新代次、队列溢出状态机、切歌预取语义不变、纯 AirPlay 组报文 diff 为空）**定义在 §4 阶段表的「出口」列**，不在此重复。

守卫清单与断言口径**不在本文维护**：[airplay-权威方案文档.md](./airplay-权威方案文档.md) §7（7 个脚本，272 个 `check()` 调用点 ⇒ 运行时 280 条）。

## 7. 风险与回退（按真实发生过的概率排序）

1. **时钟域**：任何 `Date.now`/`performance.now` 进入锚点链 ⇒ 跨进程偏移（守卫① + 单测）。
2. **`commonSendAheadUs` 被污染**（§2.3）⇒ 真实 sendspin 设备恒偏 +3.7s（守卫⑧）。
3. **代次错源**（§2.4）⇒ seek 不换代；把清桥挂 `stopGroupCore` 会整条桥丢掉。守卫⑩⑪。
4. **latency 双重计入**：`A − L` 是唯一补偿点，`send_ahead` 只影响发送/启动，不再减第二次。守卫②。
5. **`baseTs` 漏写**（§2.2）⇒ `positionSec` 变垃圾且不报错，最难发现。守卫⑫。
6. **32 位模域**：uptime >27h 后 `ntp2ts` 越界，现靠模运算侥幸自洽。守卫⑫ + `sec=100_000` 单测。
7. **双会话**：native cast 与 bridge 抢同一设备。owner token（`control.ts:274-290`）+ `detachFromActiveGroups` 纳入 airplay + `stopAirPlaySessionsForHost` 排除桥。
8. **验收链自身是风险源**（BLK-03/04）：正弦测 Δ、发送端落盘算 Δ —— 两者都「看起来通过了」，比实现 bug 更危险。
9. **回退**：`MUSICFLOW_AIRPLAY_BRIDGE=0` 即完整旧路径；P1~P5 不改 DB schema；AP2 凭据复用 `hap_credentials`。**已知缺口**：运行中把 flag 从 1 改 0 不拆已建桥，需重启或等下一首（写进 CHANGELOG，不要宣称「改 env 即时生效」）。
10. **AP2 不可低估**：HAP、加密 RTSP、ALAC+ChaCha20、PTP 都是独立工程；6a 是 6b 的门禁。

---

## 8. 事实核对纪律

1. 涉及常量/行号/协议能力/进程归属，必须附一次命令输出或文件行；拿不到证据写「待验证」。
2. 修正前先复验，不能以一次 grep 失败作为「不存在」的证据（`_cli_writer` 误判教训）。
3. 文档说「已改」必须同时检查实机文件（fake 44100→48000 教训）。
4. 验收脚本必须能运行：依赖先安装、算法先自检、速率先统一、lag 符号先验证。
5. 不能用「概念上对齐 MA」替代「在 MusicFlow 三进程里调用链闭合」。

> 原始终审/复验/开工前验证报告已归档：`docs/archive/`（索引见 `docs/archive/README.md`）。
