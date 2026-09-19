# 播放端统一化管理与遥控 方案（PLAYER_UNIFICATION）

> 状态：**部分落地（步骤 1 / 3 / 4 已部分实现），方案已收敛**。（2026-09-19 复核：本文「现状 / 缺口」一节已按当前代码校正，**行可见性**的正确口径见 §4.1 / §4.2 / §9。）
> 一句话目标：把**所有能出声的播放端**统一成服务端"认识、可列出、可遥控、可读状态"的同一种对象，
> 并在**播放器页**与**流转播放界面**里同等呈现、同等遥控。
>
> **2026-09-15 方案收敛 —— 不要「Web 播放器」**：浏览器（Web UI）**只作为遥控面（controller）**，
> 可遥控**客户端（安卓 / Windows）**与设备（DLNA 等）；**没有任何"Web 播放器"概念**。
> 后端对外的 peer 列表不再出现 web 实例（self 行除外），指令 / 投放端点拒绝对 web 目标生效，
> 前端已删除 Web 播放器模块与被控代码。最终只保留两种遥控关系：**客户端→客户端**、**Web→客户端**。
>
> 关联文档：`DEVELOPER.md`（整体架构）、`API.md`（接口面）、`PRE_PROBE.md`（预探测）、
> `sendspin-renderer-handoff-2026-09-13.md`（Sendspin 渲染端）。

---

## 1. 术语与角色

| 角色 | 是谁 | 出声 | 参与「本机」判定 | 进模块列表 |
|---|---|---|---|---|
| **播放端 · 设备型** | DLNA / AirPlay / Sendspin / 群组 | ✅ 设备出声 | ❌ | ✅ |
| **播放端 · 本机型** | 安卓 App / Windows App | ✅ 本机出声 | ✅ | ✅ |
| **消费方 · 纯遥控** | **Web（浏览器 UI）/ HA 卡片** | ❌ 只发指令 | ❌ | ❌ |

- 「播放端」= 被服务端管理、可被遥控的出声目标。现仅含：客户端（安卓 / Windows）+ 四类设备。
- 「消费方」= 发起遥控的一端。Web 与 HA 卡片只遥控、本身不出声，**不参与「本机」判定，也不进播放器页模块列表**。
- **Web 不是播放端**：浏览器不播放音频、不在 peer 列表里作为可遥控目标出现；它只是遥控面，用来选中并控制一个客户端或设备。

---

## 2. 现状与缺口（代码事实）

**已受管（现状即目标形态）**
- 类型集合：`PeerKind = local | dlna | group | airplay | sendspin`（`backend/src/services/peer.ts`，约 :53）。
- 统一契约：`ProtocolPlayer`（`backend/src/services/player/types.ts`，约 :67）——
  `playMedia / stop / pause / resume / seek / setVolume / pollState`，DLNA / AirPlay / Sendspin / 群组同形实现。
- 注册：经 `UniversalPlayer.attachProtocol` 注册进 `QueueController`，随即获得**队列 + 自动切歌 + 状态轮询**。
- 本机 peerId 为三段式 `local:<userId>:<clientId>`，唯一权威在 `backend/src/utils/peerId.ts`，
  配套四处消费：`canControlPeer / filterPeersByAccess / pruneOrphans / canSeePeer`。

**缺口（已补 / 已收敛）**
1. **local 现已只指客户端**：音频在客户端（Flutter），服务端只存队列元数据；
  transport 为 no-op（`backend/src/routes/api/index.ts`，约 :3358），status 只有队列快照（约 :3659）。
  **本机真状态经 local-status 回报**已落地（见 §7.1）。
2. **无法被远程遥控** → **客户端已被遥控打通**（指令下发 + 状态回报 + 前端遥控路径）；
  **Web 作为被控端已明确不做**（见 §7.1 收敛记录）。
3. **状态不统一** → WS 已全类型推送 local 实例的状态回报。
4. **控制面重复** → 路由层 6+ 条重复的 `kind → 实现` if 链待收敛（步骤 2，未开始）。
5. **重复工具**：`stripPlayerPrefix` 与 `parsePeerId` 职责重叠，待清理（未开始）。
6. **旁路**：`/v1/dlna/cast`、client-cast stream-url、插件 renderer 的 `control(action)` 第三套控制面待收敛（未开始）。
7. **UI 缺位** → **播放器页已新增「客户端」模块**（按 `platform !== "web"` 列出本机实例）；
  **「Web 播放器」模块已按方案收敛移除**（见 §7.1）。

---

## 3. 统一模型

每个播放端 = 同一对象，具备四要素：

| 要素 | 内容 |
|---|---|
| 身份 · 名字 | `kind` + 稳定 id（本机为 `local:<userId>:<clientId>`）+ 显示名 |
| 能力 | 播放 / 暂停 / 跳转 / 音量 / 静音 / 上下首 / 是否支持 seek |
| 状态 | 曲目、播放态、进度、时长、音量、在线 |
| 队列 | 播放列表、下一首、自动切歌 |

**唯一的差别是"命令往哪送"**：
- **设备型**：音频在设备上，服务端用协议直控（现状）。
- **本机型（客户端）**：音频在客户端（**不搬服务端**），服务端经**信令通道**下发指令，客户端执行后**回报状态**。

Web 不经此模型——它不是播放端。Web 作为遥控面，复用与 DLNA 完全相同的 REST 控制链去驱动一个客户端 / 设备。

其余（队列、自动切歌、预探测、状态聚合、WS 推送、UI）**全部共用一套**。

---

## 4. 界面设计

### 4.1 侧边栏「播放器」页 = 管理页

**五个模块**（同级同款）：**客户端** · DLNA 设备 · AirPlay 设备 · Sendspin 设备 · 群组。

- 「客户端」模块：安卓 App / Windows App 实例，一行一个（`platform !== "web"`，故浏览器实例不出现）。
- 本页不判定本机、不出现「本机」：每行只显示**设备名**（安卓机型 / Windows 电脑名）
  或**用户自定义名**；行能力与 DLNA 行一致（改名 `playerStore.setPeerName` · 隐藏 `setPeerHidden` · 禁用 · 删除）。
- 本页**数据源是页面本地列表**（客户端取 `/v1/peers`、DLNA / AirPlay 取各自发现接口），与「流转播放」用的 store `peers` **不是同一份** —— 后者在设备离线时会被 WS 事件删行（见 §4.2）。
- **离线端保留在列表里并打「离线」标签**（客户端 / DLNA / AirPlay / Sendspin 四个区块同款）：peer 行本身**从不自动删除**（`services/peer.ts` 顶部注明 *A peer entry itself is never auto-removed*），离线只把 `available` 置 false；被回收的只有队列（**6h 未变动 且 该端离线 6h** 双条件）。客户端区块的界面文案即「离线后该行保留并打「离线」标记」（`groups.clientPlayersNote`）。
- **五个模块在所有端都可见**（在 Web 上也能看到安卓 / Windows 实例）——因为它是管理页，与"你在哪看"无关。
- **Web 不在此页**：浏览器无「Web 播放器」模块，也不作为可管理实例出现。

### 4.2 「流转播放」= 选择播放目标的地方

**只出现在"能发起遥控"的端**：Web（浏览器 UI）/ 安卓 App / Windows App。

- **此处才判定本机**：用 `clientId` 比对自己那一行 → 显示「本机」+ 角标 + **置顶**；其余行显示设备名。
- 选中任一端 = **远程遥控**（逻辑与 DLNA 完全相同）。
- 提供 **推流 / 拉流**（见 §5）。
- **HA 卡片不在目标列表**（纯遥控器，见 §9）；**Web 自身「本机」是合法本地目标，但 Web 不作为被其他端遥控的远程目标**。
- **离线的「别的」本机客户端不在选择列表里**（`stores/player.ts` 的 `peersForSwitcher` 剪掉 `kind==="local" && !self && available===false` 的行；**「自己那条」恒在**，它是播放器 UI 的落点）；DLNA / AirPlay / Sendspin / 群组设备离线时由 WS `peer_unavailable` 从 store `peers` 直接删行，也不再出现。若选中后目标才掉线，需明确反馈失败原因。
- **Web 上的「本机」= 浏览器自身 Howler 播放**（保留旧版本机播放链路）：选「本机」即在当前浏览器播自己的队列；其余选项为客户端 / 设备（远程遥控）。其他端的列表里不会出现 Web。

### 4.3 命名规则

| 情况 | 显示名 | 谁看到 |
|---|---|---|
| 用户改过名 | 用户改的名（命中自己时 +「本机」角标） | 所有端一致 |
| 未改名 · 看自己那端 | 「本机」 | 仅自己 |
| 未改名 · 看别人那端 | 设备名（机型 / 电脑名） | 其他端 |
| 取不到任何 | 「本机播放」 | — |

- 判定基准：**`clientId`**（精确到 App 实例，同账号多端各占一条）。Web 标签页不参与 `clientId` 判定、不占 peer 行。
- 改名持久化绑 `clientId`；同名自动加后缀去重。
- **已知边界**：网页清缓存会换 `clientId`，但 Web 不占 peer 行，故无"改名认回"问题。

---

## 5. 推流 / 拉流

| 动作 | 语义 |
|---|---|
| **推流** | 把**当前正在播放**的曲目 / 队列送到选中播放端开始播放 |
| **拉流** | 把**选中播放端正在播放**的曲目 / 队列接过来，在当前端继续 |

- 二者都只搬运"队列 + 播放位置"，不搬运音频；音频始终由目标端自行出声。
- **目标必须是"在线的播放端"**：客户端 / 设备；在 Web 上「本机」即浏览器自身也是合法本地目标；Web / HA 不作为被其他端遥控的远程目标；离线的别的客户端与离线设备已不在选择列表里、无法选中（见上）。
- 客户端目标需经信令通道通知对应客户端接管；设备目标用协议直控。

---

## 6. 接口草案（约定，不含实现）

**设备名片**（播放端统一上报 / 下发）
`id` · `kind` · `platform`（**不含 web**）· `model`（机型 / 电脑名，可空）· `clientId`（本机型）· `displayName`（用户改名，可空）· `online`

**统一状态形状**
`trackId / state(playing|paused|stopped|buffering) / positionMs / durationMs / volume / muted / updatedAt`

**本机型信令指令**（复用现有 WS / 心跳通道，**仅客户端参与**）
下发：`play / pause / resume / stop / seek / setVolume / setMute / next / prev`
回报：状态形状 + 执行回执（成功 / 失败原因）

**选择 / 推流 / 拉流**（流转播放界面）
`selectTarget(peerId)` · `pushTo(peerId)` · `pullFrom(peerId)`

**Web 遥控面**：Web 不接收 `peer_command`、不回报 `local-status`；它只调用上述 REST 控制链去驱动客户端 / 设备。

---

## 7. 分步实施与验收点

| 步骤 | 内容 | 验收点 | 进度 |
|---|---|---|---|
| **1** | 统一状态 + 名字：统一状态形状、本机状态回报、WS 全类型推送、命名链 + `clientId` 判定 | 名字自动命中合理；流转播放里本机正确置顶 + 角标 | 🟢 服务端统一出口 `decoratePeersForClient`、对外 id 收敛、WS 全类型推送、命名链已落地并部署 |
| **2** | 收敛动作表：散落的 `kind → 实现` if 链并成一张表 | 新增一种播放端只需加一个实现；现有行为回归通过 | ⬜ 未开始 |
| **3** | 本机遥控打通（仅客户端）：指令下发 + 执行回执 + 状态回报 + 离线反馈 | 从 Web / 另一客户端遥控安卓 / Windows 生效；离线有明确反馈 | 🟢 指令下发 + 状态回报 + 前端遥控路径 + **播放模式 / 收藏实时同步**已落地并真机验证（2026-09-15）；执行回执 / 离线反馈待补；**Web 作为被控端已明确不做** |
| **4** | 前端接入：播放器页新增**客户端**模块；流转播放界面统一 | 五模块在所有端可见；管理操作与 DLNA 行一致 | 🟡 播放器页「客户端」模块已落地（改名 / 隐藏 / 离线消失）；**「Web 播放器」模块已移除**；「流转播放」界面统一未做 |
| **5** | 推流 / 拉流 | 两端都能推、都能拉，位置正确 | ⬜ 未开始 |
| **6** | 消费方接入：Web / 安卓 / Windows 共用遥控面 | 遥控路径行为一致 | 🟡 **Web→客户端、客户端→客户端**两条遥控路径已通；HA 卡片待接 |

### 7.1 进度记录

**2026-09-15（未发版）— 方案收敛：移除「Web 播放器」**

用户明确：Web 播放器不再作为播放端 / 被控端；只保留 **客户端→客户端** 与 **Web→客户端** 两种遥控关系。
据此拆除此前临时接上的"Web 被控端"整条链路（注：该链路曾真机验证过歌单起播 / 暂停 / 切歌 / seek / 音量 / 清空，
但因方向调整整体撤除，非功能缺陷）：

- **后端双保险收敛**：
  - `services/access.ts → decoratePeersForClient`：循环内
    `if (p.kind === "local" && !self && p.platform === "web") continue;`
    从对外 peer 列表隐藏 web 实例（保留请求方自己的 `self` 行 —— Web 前端仍靠它归一化本机队列）。
  - `routes/api/index.ts → dispatchPeerCommand`：命中 `target.kind === "local" && target.platform === "web"`
    直接返回 `{ success: true, delivered: false }`（防缓存直呼的历史 peerId）。
  - 同文件 `/v1/play` 解析后：`web` 目标返回 `403 operationForbidden`（兜底防缓存直呼）。
- **前端清理**：
  - `stores/player.ts`：删除被控三件套（`pushLocalStatus` / `start/stopLocalStatusReporting` /
    `executeSelfPeerCommand` / `adoptSelfQueue` / `isSelfQueueSnapshotSame` / WS 的 `peer_command` 与
    `peer_queue_changed` 自指跟随分支 / 各播放钩子里的 `void pushLocalStatus()`）。
    **保留**合法的 self 归一化（`ownServerPeerId` / `normSelfPeer` / `normPeerId`）—— Web 前端仍需它把服务端 self 行换回 `local:<userId>`。
  - `views/Groups/index.vue`：删除「Web 播放器」整段模块与 `webPlayers` computed；
    `clientPlayers` 改为 `platform !== "web"` 过滤。
- **测试**：`tests/routes/clientContract.test.ts` 旧契约锁定"web 实例要显示" → 改为 windows 实例并新增
  「web 行在 `/v1/peers` 隐藏、self 行保留」契约；**12/12 通过**。
- **部署**：本地 `tsc` + `vue-tsc` + vite 构建通过、i18n 守卫绿；产物 scp → docker cp 热替换进
  192.168.10.240 容器并重启，`/rest/ping` 健康检查通过。

> 注：此前 §7.1 中"步骤 1 前半 + 步骤 4 的播放器页部分"记述的"前端播放器页新增「客户端」「Web 播放器」两模块"——
> **其中"Web 播放器"模块已在本轮移除**，仅"客户端"模块保留。

**2026-09-15（未发版）— 步骤 3：播放模式 / 收藏实时同步（真机联调暴露并修掉 3 个缺陷）**

用户实测：「Web 端切播放模式（随机 / 顺序 / 循环）客户端不跟着切；点我喜欢客户端也不回显；音量倒是能同步」。
三个成因，性质完全不同：

- **① 播放模式丢失 —— 大队列摘要被整条丢弃**。`summarizeQueue()` 对 `items.length > 200` 的队列只回
  `{...q, items: [], total}`（3217 首的歌单必然命中）。客户端 `_follow()` 此前遇到
  `items.isEmpty && total > 0` 就**整条 return**，把同一份 payload 里的 `playMode` 一起丢掉 →
  模式切换永远到不了客户端。修：改为 `_applyOuterFields()`（只套外层：播放模式 + 同长度时的游标跳转），
  `_sameAsLocal()` 同步支持摘要态（items 空 → 退化为比对外层三件套 total/index/playMode）。
- **② 收藏不回显 —— 队列项根本不带 starred**。红心读的是 `currentSong.starred` 快照，而队列轮询
  只有歌名 / 歌手 / 时长，**永远刷不到收藏位**。修：服务端在 `/star`、`/unstar` 后
  `sendToUser()` 定向推 `song_starred`（**per-user 私有状态，绝不能 broadcast**，否则把 A 的收藏变动
  推给 B）；Web 与客户端各接一份：`favorites.ts → applyExternalStarred()`（幂等、仅在真的变了才 bump
  `revision`，避免自己点的那次被服务端回声触发整页重载）、`player_provider → applyExternalStarred()`。
- **③【本轮引入的缺陷，真机抓出】游标跳转会把整份队列清成一首**。`_applyOuterFields` 里
  `playSong(player.queue[index])` **没有回传 `queue`**，而 `playSong` 的签名是 `queue ?? [song]` ——
  3217 首的队列就地变 1 首；更糟的是 `_watchLocalQueue` 会以 `full: true` 把这「一首歌的队列」镜像回
  服务端，权威队列随之塌成 1 首（实测 `queueLen 3217 → 1`）。修：显式回传
  `playSong(queue[index], queue: player.queue, index: index)`。
- **④ 顺带收敛**：`_follow()` 在「歌曲序列与本机一致」时也走整队 `playQueue` → 切一下随机就把正在播的
  歌从头重启。修：新增 `_sameSongIds()`，序列一致时只套外层（模式 / 游标），不再整队重建。

**验证手段（可复用）**：`diag_remote.cjs`（列 peer + 实测 `delivered`）、`diag_self.cjs`
（带 `x-mf-client-id` 实测 `self` 唯一且正确、`platform/model` 是否下发）、`diag_playmode.cjs`
（像 Web 那样直接改目标实例的权威播放模式）、`diag_star_push.cjs`（独立 WS 连接冒充同账号另一端，
`unstar→star` 还原式取证推送，不污染数据）。实测结论：`delivered: true`；客户端日志出现
`queue truncated (total=3217), apply outer fields only` + `apply authoritative play mode: xxx`；
`song_starred` 两向各推 1 条。
**已知残留**：同一 `peer_queue_changed` 会被处理两次（客户端日志成对出现、`sid` 连续两次自增），
队列坍缩修掉后只剩冗余开销（模式应用是幂等的），不影响正确性。

**2026-09-15（未发版）— 步骤 3 前半：本机遥控链路（服务端 → 客户端 → 前端，仅客户端为被控端）**

链路四环此前全断，本轮逐环补齐（`play/pause` 对 local 是 no-op / 无下行通道 / 客户端无非本机控制台
└无状态回报）。闭环 = **服务端下达指令 → 客户端 WS 接收执行 → 客户端回报状态 → 前端轮询镜像**。
**Web 不在此链路中——它是发起遥控的一方，不是被控端。**

- **① 服务端定向投递**（`services/ws/index.ts`）：新增 `pickInstanceConnections()` / `sendToLocalInstance()`
  / `sendToLocalPeer()`，按 `userId + clientId` **精确匹配连接**。缺 `clientId` 返回空集而**不降级广播**——
  否则同账号的网页标签页会跟着执行别人的指令。
- **② 指令下发**（`routes/api/index.ts`）：`play / pause / stop / next / prev / seek / volume` 七个
  传输接口的 local 分支从 no-op 改为 `dispatchPeerCommand()` → WS 定向发 `peer_command`，返回
  `{success, delivered}`（`delivered` 即「有无连接收到」，是离线反馈的原料）。
- **③ 客户端接收**（`peer_remote_control_provider.dart`）：处理 `peer_command`（传输）与
  `peer_queue_changed`（权威队列跟随）。队列跟随用**内容逐项比对**代替时间戳 / 抑制窗口——自己造成的
  变更比对必一致 → 无操作，真正外部改的才跟随，天然不回环。复用既有 `/ws` 连接（仅补 `clientId` 参数），
  避免双连接导致指令重复执行。
- **④ 状态回报**（新增）：本机播放的传输状态权威在本地 just_audio，服务端只有队列元数据 —— 没有回报，
  对端轮询 `/status` 只能读到队列快照，**进度条恒为 0、按钮恒显示「未播放」，遥控就是盲操**。故新增
  `POST /v1/peers/:peerId/local-status`（state / position / duration / volume / songId，字段级合并，
  进程内存 + 30s TTL），`GET /status` 对 local 合并回吐（**不覆盖 `updatedAt`**，那是队列恢复新鲜度竞速用的）。
  客户端上报节奏 = 播放 / 暂停 / 切歌**事件**立即 + 周期 4s 补报；投屏中如实报 `STOPPED`（本端确实不出声）。
- **⑤ 前端遥控路径**（`stores/player.ts`）：`isRemotePeer` 扩展为含「**别的** local 实例」，
  `switchPeer` 新增 `isOtherLocal` 分支走与 DLNA 完全相同的遥控路径（`ensureRemoteState` +
  `syncCastQueueFromBackend` + `startCastPoll`），全套 REST 控制链零改动复用。
- **⑥ 命名口径统一**（`utils/peerLabel.ts` 新建）：`peerKindLabel()` 收口「**同 id 才显示本机**，
  否则显示所属模块（客户端）」。此前 `MainLayout` 兜底三元、`peerDisplayName` 兜底、
  `currentPeerName` 的 local 分支三处都直接返回「本机」，导致在 Web 上选中另一台客户端后控制栏仍谎报「本机」。
- **验证**：后端新增 `localStatusReport.test.ts` / `wsInstanceTargeting.test.ts` 锁合并 / 定向投递不串号；前端 `vue-tsc` + `vite build` 通过；`check-i18n` 全绿。产物已热替换进 192.168.10.240 容器并重启验证。

**2026-09-15（未发版）— 步骤 1 前半 + 步骤 4 的播放器页部分（仅「客户端」模块保留）**

- **服务端单一出口** `services/access.ts → decoratePeersForClient()`：可见性 → **打码 + self 标记** →
  按用户级隐藏 → 套用显示名，`/v1/peers` 与 WS `peer_snapshot` 共用，杜绝两处顺序再次走偏。
  顺序是硬约束：偏好（hidden / names）以**对外 id** 为键，必须先打码才能套，否则针对本机实例的
  改名 / 隐藏会静默失效（这正是本轮修掉的缺陷）。
- **对外 id 收敛**：`self` 那行恒为规范形式 `local:<userId>`（与前端 `localPeerId` 同键），
  同账号的其它实例为 `local:<userId>:<instanceKey>`；`clientId` 明文仍不出服务端。
- **前端** 播放器页新增「客户端」模块（按 `platform` 分流：`platform !== "web"` → 客户端；
  **Web 播放器模块已移除**）。模块**不判本机**（不置顶、不打角标），名字取「改名 → 设备名片 → 上报名」；
  支持改名与按用户级隐藏；实例离线（idle 超时）后**管理页仍保留该行并打「离线」标签**（与 DLNA 区块一致），重新心跳即恢复可用 —— 只有「流转播放」选择器会剪掉别的离线客户端。
- **验证**：后端 `963 passed / 130 files`（新增契约用例锁死「先打码后套偏好」与 self 规范形式）、
  前端 `vue-tsc` 0 错、`check-i18n` / `check-core` / 前端浮层与插件隔离守卫全绿。

---

## 8. 影响面与风险

- **音频路径不变**：客户端音频仍在本机响；统一的只是"遥控与状态"。**Web 不播放音频**。
- **离线语义**：客户端不在线时必须明确反馈。
- **向后兼容**：先"可列出 + 可看状态"，再"可遥控"，最后消费方接入。
- **协议接口收敛是大动作**：每一步合并后都要完整功能回归。
- **推送开销**：WS 全类型推送会增加消息量，需控频率与去抖。
- **`clientId` 易失**：仅影响客户端实例改名认回；Web 不参与 `clientId` 判定，无此问题。

---

## 9. 已定规则（原开放问题决议）

- **Web 保留自身本机播放，但不作为被控端 / 远程目标**：浏览器用 Howler 播自己的队列（选「本机」即播，保留旧版本机播放链路）；
  但 Web 不向其他端暴露 peer 行、不被指令 / 投放命中、不进播放器页模块与流转播放目标列表，即**不能被其他端遥控**。
  遥控关系仅 **客户端→客户端** 与 **Web→客户端**。
- **HA 卡片只是纯遥控器，不是推流目标**：它不出现在播放器页模块列表，也不出现在流转播放的目标列表中，
  不能被推流 / 拉流。若日后 HA 要作为出声目标，须先以「客户端」身份注册成播放端。
- **离线可见性分两处（2026-09-19 校正）**：
  - **播放器管理页**：客户端 / 设备离线行**保留并打「离线」标签**，不删行（peer 行从不自动移除；被回收的只是队列 —— **6h 未变动 且 该端离线 6h**）。
  - **流转播放选择列表**：**别的**离线本机客户端被剪掉、不可选中（「自己那条」恒在）；DLNA / AirPlay / Sendspin / 群组设备离线后由 WS 删行，同样不在列表。
  服务端内部记录按队列回收策略（6h 双条件）清理，与上面的**行可见性**无关。
