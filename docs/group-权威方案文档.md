# MusicFlow 群组（Player Group）权威方案文档

## 文档关系（先读这一块）

> **本文件的角色**：**权威现状**。群组维度的**唯一事实来源** —— 组成员与命名空间、生命周期状态机、选歌推进硬约束、出流双路（组泵 / AirPlay 桥）、延迟补偿、组验收判据与失败速查全在这里。

**5 份相关文档（都在 `docs/`，链接可直接点开）**

| 文档 | 角色 | 一句话用途 |
|---|---|---|
| [airplay-权威方案文档.md](./airplay-权威方案文档.md) | 权威现状 | AirPlay/RAOP 协议正确做法、airplay 子进程、桥接环（帧格式/锚点/stats）与 AirPlay 侧守卫 |
| [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) | 权威现状 | Sendspin 协议链路、FLAC 链路、ESPHome 设备端配置、多房间组与组泵 |
| [group-权威方案文档.md](./group-权威方案文档.md) | 权威现状 | 群组数据模型与生命周期、选歌硬约束、出流双路、组成员、延迟补偿 |
| [AirPlay1-2与Sendspin桥接-最终实施方案.md](./AirPlay1-2与Sendspin桥接-最终实施方案.md) | **历史方案（Phase 计划）** | 桥接的开发执行版：Phase 0~8 分阶段实施、接口、守卫矩阵、逐轮审计修正索引 |
| [AirPlay1-2与Sendspin桥接落地方案.md](./AirPlay1-2与Sendspin桥接落地方案.md) | **历史方案** | 桥接的调研与落地方案：MA 精要、MusicFlow 现状盘点、Phase 拆解、230 模拟验收 |

**硬口径**：**历史方案文档不再作为事实来源；任何冲突以三份权威文档为准。** 历史方案文档只保留「为什么这样设计」与「当时踩了什么坑 / 推翻了什么」两类价值 —— 其中的 Phase 条目、行号、字段名一律可能过期。

**三份权威文档的分工边界（排障时先按这张表定位文档）**

| 问题域 | 归属文档 |
|---|---|
| 协议（RTSP / RAOP / AP2 报文、Sendspin 帧与握手配对）、airplay 子进程模型、桥接环（28B 帧 / 锚点公式 / `stats` 判据） | [airplay-权威方案文档.md](./airplay-权威方案文档.md) |
| 设备协议（Sendspin 连接 / 编码协商 / 预填充水位 / pacing / 音量）与组泵（`SendspinGroup.pushFrame`、`pcm:100` 编码组、晚加入回填） | [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) |
| 组成员与命名空间、生命周期状态机、选歌推进硬约束、出流双路（组泵 / AirPlay 桥）、延迟补偿、组验收判据与失败速查 | [group-权威方案文档.md](./group-权威方案文档.md) |

---

> **定位**：群组维度的唯一权威口径。凡涉及「组是什么、成员怎么解析、起播走哪条路、选歌能不能绕、音量/延迟谁说了算、成员掉线怎么办」的问题，以本文为准。
> **代码基线**：`/workspace/MusicFlow`（桥投递窗口化 `1258eb6`、旧语义测试迁移 `34f8074`、组音量扇出修复 `68eedd9` 之后）。行号取自该基线。
> **方法论**：**代码即事实**。每条结论后括注 `文件:行号`；凡设计文档/历史结论与代码冲突，一律以代码为准，并集中列在 **附录 B「文档推断被代码推翻的点」**。
> **写法约定**
> - 路径省略公共前缀 `backend/src/`；前端标 `frontend/src/`，测试标 `backend/tests/`。例：`services/group/index.ts:29`。
> - 只给签名与 ≤5 行关键片段，不整段复制源码。
> - 「组」= 用户组；sendspin 内部还有「组泵/设备组」，出现时写全名。
> **不覆盖**：桥的 RTP/NTP 数学推导与 28B 帧格式（见 [airplay-权威方案文档.md](./airplay-权威方案文档.md) 第十/十一部分）、Sendspin 协议细节与组泵编码分组（见 [sendspin-权威方案文档.md](./sendspin-权威方案文档.md) 第二/五部分）、DLNA 单机播放链、ESPHome 固件侧。

---

## 0 一分钟总纲

### 0.1 群组是什么

**群组是服务端的永久配置，不是客户端的临时状态。** 组存在 `player_groups` 表里（`db/schema.ts:366-381`），进程重启后从库加载进内存 Map（`services/group/index.ts:106-123 loadFromDb`）。组没有自己的进程、没有自己的设备；它只是一个实现 `ProtocolPlayer` 接口的**门面对象**，`playerId = "group:<gid>"`（`services/group/protocolPlayer.ts:224`，`const playerId = \`group:${groupId}\``）。所有播放控制（play/pause/resume/stop/seek/setVolume/pollState）都通过这个门面转派给真正的成员设备或组泵。

### 0.2 有哪两类成员

| kind | id 形态 | 谁出流 | 证据 |
|---|---|---|---|
| airplay | `airplay:<deviceId>` | 两种：①**组泵旁路**（桥接会话吐 PCM）②自己 cast 拉流（legacy） | `services/group/protocolPlayer.ts:326-334`（组泵 job 带 `sockets` 透传）、`:337-343`（`apSolo` 逐设备 cast） |
| sendspin | `sendspin:<clientId>` | 共享组泵（一个 pump 一条时间线） | `protocolPlayer.ts:326-334`（同一个 sendspin 组泵 job） |

**DLNA 不能加入群组**（2026-10-24 起）：DLNA 设备自己拉流、组内没有共享时间线（`services/group/index.ts:24-26`、`:382-383`）。

### 0.3 谁出流

一句话：**有 sendspin 成员的组，声音由 sendspin 组泵出；AirPlay 成员要么被桥接成泵的旁路接收者，要么自己 cast。**

| 路由 | 触发条件 | 声音来源 | 证据 |
|---|---|---|---|
| `bridge` | 桥开关开 且 sendspin 在线成员 > 0 且 AirPlay 在线成员 > 0 且至少一台桥准备成功 | 组泵 PCM → unix socket → AirPlay 桥会话 | `protocolPlayer.ts:292`（开关/无 AP ⇒ null）、`:295-306`（逐台 prepare）、`:307-308`（全失败 null / 成功返回）、`:322-324`（路由快照） |
| `legacy-cast` | 无 sendspin 成员，或有 sendspin 但桥全失败 | 各成员各自 cast 拉流 | `protocolPlayer.ts:322-324`（`bridgeRoute` 为 null ⇒ 全组 legacy） |
| `solo fallback` | 桥路由部分失败 | 失败那台回落普通 cast，成功那台仍走桥 | `protocolPlayer.ts:302-304`（`soloFallback.push`）、`:339-341`（`apSolo` 过滤） |

### 0.4 延迟补偿是什么（v4.8.0 权威口径：按成员一格）

**组里每个播放器（成员）独立一格**：存储 `player_groups.member_delays_json`（命名空间成员 id → ms 的 JSON map，键与 `memberIds` 完全同源：`airplay:<deviceId>` / `sendspin:<clientId>`）。**正数 = 该设备更晚出声**。范围 ±30000ms、步进 10ms（`services/group/delayCalib.ts`，现 178 行）。不再按协议（AP1/AP2/Sendspin）一刀切：同组两台同协议音箱的抵达延迟也可以不同——协议不决定抵达延迟，设备的链路才决定。旧三格列（`airplay_delay_ms` / `airplay2_delay_ms` / `sendspin_delay_ms`）已在 v4.8.0 幂等迁移中**删除，旧值不迁移**（升级后归零重调）；AP1 内置 300ms 播种（createGroup 播种 + 一次性迁移 + settings 键 `group.airplayAlignSeeded`）同批删除，新组/新成员默认 0（用户裁定 2026-10-27）。

**生效机制（按成员协议自然分流）**：
- **AirPlay 成员（桥侧）**：补偿的唯一落点 = **投递窗口/时戳位移**（`sendspin/server.ts:818-820` 与 `:885-887` 窗口 `lo/hi − shift`、`:908` 投递时戳同加 `shift`；`shift = bridgeAnchorShiftUs(deviceId)` **动态读**成员格，PUT 写缓存 ⇒ 下一补投 tick 生效）。桥内锚点 `anchorShiftUs` **恒 0**（守卫 G13-b 钉死）—— 锚点也平移则双加，对齐器把多出的那份判「内容超前」整段裁掉（v4.7.1 前真机实锤：切歌吞 2 秒、净补偿归零）。AirPlay 的可听落点随**桥会话建立**锚定：保存后该成员值变化触发重建/自愈（§6.5）。
- **Sendspin 成员**：帧级下发戳偏移（`c.sendAudio(ts + sendspinDelayUsOfClient(groupName, clientId), data)`，`server.ts:1522`；迟到回填逐客户端 `:1658`），真·实时，约 0.5~1s 内听到（取决于设备 `send_ahead`）。
- **重建触发**：仅 `airplay:` 成员值真的变化时（§6.5）；Sendspin 成员与 `trackLeadMs` 无重建。


---

## 1 数据模型与命名空间

### 1.1 `player_groups`

| 列 | 类型/默认 | 语义 | 证据 |
|---|---|---|---|
| `id` | text PK | 组 id（也是队列宿主 `group:<id>` 的后半段） | `db/schema.ts:367` |
| `ownerUserId` | text | 归属用户 | `db/schema.ts:368` |
| `name` | text | 组名，`trim` 后非空、≤50 字符 | `db/schema.ts:369`、`services/group/index.ts:93`（`GROUP_NAME_MAX = 50`）、`:354-359`（`normalizeName`） |
| `memberIds` | text（JSON 数组） | **存带命名空间的整条成员字符串** | `db/schema.ts:370` |
| `volume` | integer default 20 | 组音量，缺省 `DEFAULT_GROUP_VOLUME = 20`（schema 注释：独立于成员设备音量，空组/全离线也持久） | `db/schema.ts:371-372`、`index.ts:55`（`DEFAULT_GROUP_VOLUME`） |
| `memberDelaysJson` | text notNull default "{}" | **v4.8.0 起（按成员一格）**：命名空间成员 id → ms 的 JSON map（§6.1）。取代旧三格列 `airplay_delay_ms`/`airplay2_delay_ms`/`sendspin_delay_ms`（v4.6.77~v4.7.2，已在幂等迁移中 DROP，**旧值不迁移**） | `db/schema.ts`（`memberDelaysJson`）、`db/index.ts`（幂等迁移：ADD 新列 + DROP 三旧列） |
| `createdAt`/`updatedAt` | text（ISO） | 审计 | `db/schema.ts:379-380` |

> 迁移是**幂等**的（try/catch 逐列，重跑安全）：`member_delays_json` 不存在才 ADD；三旧列存在才 DROP（v4.8.0），**旧值不迁移**。v4.6.77 时代的「一次性继承 `bridge.avShiftMs`」与 v4.7.2 的「300ms 播种」均已随 v4.8.0 删除。

内存侧对外结构 `PlayerGroupWithMembers` 额外带 `members: GroupMemberInfo[]` 与 `delayView`（`services/group/index.ts:79-85`）。

### 1.2 关联表

**`group_queues`**：队列宿主就是组门面的 playerId `group:<gid>`（`protocolPlayer.ts:224`）。注意**列名是 `group_id`，不是 `deviceId`**（`db/schema.ts:384-386`）—— `deviceId` 只是 `QueueController` 侧的参数名，两者是概念映射，不是同名同列。字段：`itemsJson`（`db/schema.ts:386`）、`currentIndex`（`:387`，-1 = 空）、`playMode`（`:388`）、`isActive`（`:389`）、`updatedAt`（`:390`）。

> 推论：组队列与单机队列是**同一张表**、同一套 `QueueController` 代码，只是 `deviceId` 前缀不同。看门狗直接对组用 `qc.resumeActive` / `qc.resetGroupTracker`（`services/group/watchdog.ts:77`（`qc.resetGroupTracker`）、`:94`（`qc.resumeActive`）），不需要第二套实现。

**`sendspin_device_state`**：sendspin 成员的设备档案（`clientId`/`volume`/`muted`/`disabled`/`lastHost`…，`db/schema.ts:518-530`）。组成员离线时，名称/音量/静音回落到这里（取值函数 `getSendspinDeviceVolume`：import 在 `services/group/index.ts:20`，消费点在 `:322-337 resolveSendspinMember`）。

### 1.3 成员命名空间：必须原样透传整条字符串

| 输入 | 解析结果 | 组内合法性 | 证据 |
|---|---|---|---|
| `airplay:<deviceId>` | `{kind:"airplay", id}` | 合法 | `index.ts:38-41` |
| `sendspin:<clientId>` | `{kind:"sendspin", id}` | 合法 | `index.ts:34-37` |
| `dlna:<deviceId>` | `{kind:"dlna", id}` | 仅历史数据可解析，**新提交拒收** | `index.ts:42-45`、`:382-383` |
| 裸 id | `{kind:"dlna", id}` | 同上（历史写法） | `index.ts:49` |
| `group:*` / `local:*` | `null` | 组不能套组、不能含本机 | `index.ts:33` |
| 空/非字符串 | `null` | 拒 | `index.ts:32` |
| 前缀后为空（`sendspin:`/`airplay:`/`dlna:` 后面没内容） | `null` | 拒 | `index.ts:36`、`:40`、`:44` |
| 含冒号但未知命名空间（如 `foo:bar`） | `null` | 拒（**不得**落进裸 id 兜底，否则错报成 DLNA） | `index.ts:46-48` |

**历史 bug（必须写进契约）：客户端提交成员字符串时不允许再剥前缀。** 现状代码的成员比对是**整串精确匹配**：

- 增量删除：`const removeSet = new Set(remove); const kept = g.memberIds.filter(m => !removeSet.has(m));`（`index.ts:247-249`）
- 增量新增：`if (typeof m !== "string" || keptSet.has(m)) continue;`（`index.ts:253`）
- 全量替换直接覆写数组（`index.ts:216-234`，见 §1.4 差集说明）

也就是说，库里存的是 `airplay:AA:BB:CC`，客户端若提交 `AA:BB:CC`（剥了前缀），`applyMemberDelta` 会把它当作「不在组内」⇒ **移除变 no-op、静默成功返回 200**，症状就是「成员删不掉」。前端已按整串提交：候选 id 直接构造为 `airplay:${d.id}` / `sendspin:${c.clientId}`（`frontend/src/views/Groups/index.vue:952-969`），`formMembers` 里存的就是这些整串（`index.vue:817`、`:1817`）。

> **残留风险（附录 C-2）**：`applyMemberDelta` 对「remove 一个不存在的 id」是静默 no-op，没有回执提示。客户端一旦回归剥前缀的旧写法，问题会再次隐身。接口契约上应把「成员串必须带命名空间」写进 API 文档，或让 remove 未命中时返回 warning 字段。

### 1.4 DLNA 不能加入群组：三处过滤

| 层 | 位置 | 行为 | 证据 |
|---|---|---|---|
| 解析层 | `splitMemberId` | 裸 id 视为 DLNA（历史兼容），不做拒绝 | `index.ts:49`（`splitMemberId` 定义 `:31`） |
| 服务端校验层 | `assertMembersAvailable` | 命中 `dlna` 分支**直接抛错**：`DLNA 设备不支持加入群组(请先从成员中移除 ...)` | `index.ts:382-383`（`assertMembersAvailable` 定义 `:361-385`） |
| 前端候选层 | `selectableDevices` | 候选只由 `airplayDevices` + `sendspinClients` 拼出，DLNA 列表不参与 | `frontend/src/views/Groups/index.vue:951-975`（注释：「成员只有两种 kind:airplay / sendspin;DLNA 已禁止入组」） |

DLNA 设备区块仍然渲染在群组页左侧（`index.vue:51-123`，`data-lazy-section="dlna"` 区块），但那只是**单机设备控制**，不是组成员候选。

另外 `assertMembersAvailable` 对 airplay 与 sendspin 的强度不同，这决定了「能否离线建组」：

| kind | 校验 | 是否允许离线成员 | 证据 |
|---|---|---|---|
| sendspin | **仅格式**（前缀 + 非空） | 允许（组可持久化，在线态动态解析） | `index.ts:372-375` |
| airplay | 设备档案存在 + 未被禁用 | 允许（可用性动态解析） | `index.ts:376-381` |
| dlna | — | 不允许 | `index.ts:382-383` |

**准入的作用域：只校验「相对现有成员新出现的那部分」（2026-10-26 修正，洞 O1）。**

| 入口 | 校验对象 | 证据 |
|---|---|---|
| `createGroup` | **全量**成员列表 | `index.ts:167`（`:165` 定义） |
| `setMembers` | 差集 `newOnes = memberIds ∖ g.memberIds` | `:227` 计算 → `:228` 校验（`:216` 定义） |
| `applyMemberDelta` | 差集 `added`（已排除非法入参与重复项） | `:251-257` 构造 → `:260` 校验（`:239` 定义） |

为什么必须改成差集：组里只要还剩 **≥1 个历史 DLNA 成员**（旧版本留下的裸 id / `dlna:` 成员），全量校验就会让「**加减任何成员**都 400」；有 **≥2 个**时，逐个删也清不干净（删第一个就提交剩余列表 ⇒ 又撞上剩下的 DLNA 成员）⇒ **组被永久锁死、用户无法自救**。历史成员是既有事实，不该拖累本次提交。

代价：`assertMembersAvailable` 原本「顺带」做的**提交列表结构/重复校验**会漏（尤其是「已在组内的成员被重复提交」），因此这两条改为入口**显式**做 —— `setMembers` 在提交列表上先扫一遍（非字符串 `:223`、重复 `:224`），`applyMemberDelta` 靠 `keptSet` 天然去重（`:250-257`）。`assertMembersAvailable` 内部对**传入差集**仍保留 `:365-366` 的两条断言，属于「防御性冗余」，不是主检查点。

### 1.5 owner 语义：管理员 `isOwnedBy` 恒真 ⇒ 每个按 id 的路由都要额外判存在

`isOwnedBy(id, userId, isAdmin)` 对管理员**一律返回 true**（`services/group/index.ts:140-145`）。后果：只做权限判断的 id 路由，对「不存在的 id」也会放行，返回 200 + 空数据。

现行做法是**权限判断之后必须再确认组真的存在**：

| 路由 | 存在性检查 | 证据 |
|---|---|---|
| `GET /v1/groups/:id/delays` | `if (!gm.get(id) \|\| !gm.isOwnedBy(...)) → 404`，注释直接写明「管理员 isOwnedBy 恒真 ⇒ 必须先确认组真的存在，否则不存在的 id 会拿到 200/0」 | `routes/api/groups.ts:110-113` |
| `PUT /v1/groups/:id/delays` | `isOwnedBy` 之后 `if (!gm.get(id)) → 404` | `routes/api/groups.ts:127-134` |
| `PUT /v1/groups/:id` | 依赖 `renameGroup`/`setMembers` 返回 `undefined` 才 404；若 body 里既无 name 也无 memberIds，末段 `gm.getWithMembers(id)` 返回 `undefined` ⇒ 404 | `routes/api/groups.ts:55-73` |
| `POST /v1/groups/:id/members` | 依赖 `applyMemberDelta` 返回 `undefined` ⇒ 404 | `routes/api/groups.ts:92-93`、`index.ts:244` |

> 结论（写进 review checklist）：**新增任何 `/v1/groups/:id/*` 路由，必须显式 `gm.get(id)`**，不能只靠 `isOwnedBy`。

---

## 2 生命周期状态机

### 2.1 转换总表

| 转换 | 触发点 | 关键副作用 | 证据 |
|---|---|---|---|
| 建组 | `POST /v1/groups` → `GroupManager.createGroup` | 内存 Map + 落库 + `emit("group_updated")`；**不动设备** | `routes/api/groups.ts:32-46`、`index.ts:165-179` |
| 改名 | `PUT /v1/groups/:id`（body.name）→ `renameGroup` | 落库 + 广播 | `groups.ts:55-58`、`index.ts:199-207` |
| 全量改成员 | `PUT /v1/groups/:id`（body.memberIds）→ `setMembers` + `alignGroupMembers` | 落库 + 设备侧加入/摘除（DLNA rejoin / AirPlay bridgeJoin / sendspin join） | `groups.ts:59-70`、`shared.ts:670` |
| 增量改成员 | `POST /v1/groups/:id/members` → `applyMemberDelta` + `alignGroupMembers` | 同上，语义单源 | `groups.ts:84-101`、`index.ts:239-266` |
| 起播 | `playMedia` | 先拆旧桥路由 → 准备新桥 → 并行起 cast/组泵 | `protocolPlayer.ts:313-368` |
| 暂停 | `pause()` | `fanOut("pause")` + `spinOp(pause)` | `protocolPlayer.ts:376` |
| 恢复 | `resume()` | `fanOut("resume")` + `spinOp(resume)` | `protocolPlayer.ts:377` |
| seek | `seek(seconds)` | DLNA 扇出 + sendspin 组单发（两条独立路径） | `protocolPlayer.ts:378-390` |
| 切歌 | `QueueController` advance → `playCurrent` | 重置 tracker → 重新 `playMedia` | `QueueController.ts:103`、`:535` |
| 摘组（成员级） | `bridgeLeaveMember` / `alignGroupMembers` removed | 桥路由拆该成员；未确认同步时延后 `bridgeStop` | `protocolPlayer.ts:74-94` |
| 删组 | `DELETE /v1/groups/:id` | 删内存 + 删库 + 清延迟缓存 | `groups.ts:158-168`、`index.ts:268-275` |
| 悬挂 | watchdog 全员离线 | 记最后位置、清 tracker、**队列保留 isActive 不变** | `watchdog.ts:71-81` |
| 恢复 | watchdog 成员回归 | `qc.resumeActive(group)` → 位置校准 → sendspin 重入组 | `watchdog.ts:82-112` |

### 2.2 起播：三条路由怎么选

`playMedia(item, baseUrl)` 的执行顺序是硬编码的，不能调换（`protocolPlayer.ts:313-368`）：

1. 取三个在线集合：`getOnlineMemberIds`（DLNA）、`getOnlineAirplayIds`、`getOnlineSendspinIds`；三者皆空 → 抛「组 X 无在线成员,无法播放」（`:314-319`）。
2. **先拆上一条桥路由** `teardownBridgeRoute()`（`:321`），旧 socket 会话随之回收。
3. 有 sendspin 在线成员才尝试建桥 `prepareBridgeRoute(apOnline)`（`:322-324`）。
4. 并行发 job：sendspin 组泵一路（带 `sockets` 透传）、DLNA 逐台、AirPlay **只对桥失败的**设备做 solo cast（`:325-344`）。
5. 桥成功时登记 `activeBridgeRoutes.set(groupId, sockets)`（`:342`）——这是对账器的事实源。
6. 任一 job fulfilled 即算成功；全失败抛「全部成员 cast 失败」（`:344-361`，D1 兜底在 `:346-361`）。

`prepareBridgeRoute` 的降级矩阵（`:289-309`）：

| 情况 | 结果 | 证据 |
|---|---|---|
| 桥开关关 或 无 AirPlay 在线成员 | 返回 `null` ⇒ 全组走 legacy | `:292` |
| 单台 `bridgePrepareDevice` 抛错 | 记入 `soloFallback`，该台本流回落 solo cast | `:302-304` |
| 全部失败（`sockets` 空） | 返回 `null` ⇒ 整组退回 legacy | `:307` |
| 至少一台成功 | 返回 `{sockets, soloFallback}` | `:308` |

> **MAJ-07 不变量**：绝不允许出现「在组里、状态正常、但没有声音」的成员 —— 桥失败必须显式回落 solo cast（`:337-341` 注释）。

### 2.3 「起播即落位」（AirPlay 侧硬约束）

**起点必须编进这一次 cast 的会话建立流程，绝不能「先起播、再 seek」。** AirPlay 的 seek 是**完整重建会话**，连续两次建会话会让 HiVi 这类单会话设备在第二次 RECORD 上永久等待（真机 2026-10-21：流转时第 3 次握手 RECORD 挂死 12s → 流转失败/无声）（`services/airplay/protocolPlayer.ts:33-37`）。

现行实现链路：

| 环节 | 实现 | 证据 |
|---|---|---|
| 起点折算 | `const seekSec = startMs > 0 ? startMs / 1000 : undefined;` 作为 `AirPlayCastOptions.seekSec` 传下去 | `airplay/protocolPlayer.ts:37`、`:48`、`airplay/control.ts:51` |
| 会话建立 | `castToAirPlayDevice(opts)` → `withDeviceGate` → `castUnlocked` → `startSession(opts, opts.seekSec)` | `control.ts:826-845` |
| 源侧起点 | `withPlaybackOffset(streamUrl, seekSec)` 往流 URL 注入 `timeOffset=<秒>`，让**喂给解码器的源**从中途开始 | `control.ts:173-179`、`:515` |
| 时间线起点 | `player.setStartPosition(seekSec)` —— 新会话的 RTP 时间线按目标秒重锚，否则上报位置从 0 起算 | `control.ts:552-556` |
| seek 的两条分支 | **默认走完整重建**（`AIRPLAY_SEEK_INPLACE != 1` ⇒ 带 `seekSec` 重投 `castUnlocked`/`startSession`，代价 ~1.5s 静音；2026-10-21 HiVi 真机原地 FLUSH 会彻底无声）；**原地 FLUSH 换 decoder 只在 `AIRPLAY_SEEK_INPLACE=1` 时启用**（实验开关） | `control.ts:1078 seekUnlocked`（重建分支 `:1084-1094`、原地分支 `:1095+`；`seekAirPlay` 门面 `:1072`） |

### 2.4 暂停 / 恢复 / seek / 切歌

- **暂停/恢复**：`fanOut` 扇给 DLNA + 非桥占用 AirPlay，`spinOp` 单发组泵（`protocolPlayer.ts:376-377`）。桥占用成员被 filter 掉（`:234` `isBridgeOwned` 过滤；`setVolume` 例外 `:239-243`），因为组泵才是它们的时间线主人。
- **seek**：两条独立路径同时下发 —— DLNA 逐台 `fanOut`，sendspin 组泵 `spinOp`。代码里专门打日志「一条成功一条失败时组内成员会停在两个不同时间轴」（`protocolPlayer.ts:378-390`）。
- **切歌**：`QueueController` 收到 advance/track_changed/idle_early 决策后调 `playCurrent`，**切歌后必须重置 tracker**，否则上一首的 PLAYING→IDLE 迁移会再次触发 advance（`QueueController.ts:103`、`:535`、`:1099`、`:1510-1515`）。

### 2.5 摘组与删组

- **摘成员**：`bridgeLeaveMember(groupId, deviceId)` —— 若同步未确认，**延后** `bridgeStop`，避免在时间线未收敛时拆会话（`protocolPlayer.ts:74-94`）。
- **删组**：`deleteGroup` 删内存 + 删库（`index.ts:268-275`），路由层额外 `invalidateGroupDelays(id)` 清延迟缓存，避免 id 复用读到陈旧值（`groups.ts:193`、`delayCalib.ts` 的 `invalidateGroupDelays`）。
- **删设备**：`removeDeviceFromAllGroups(deviceId)` 只清组成员名单（按裸 id 比对，`dlna:X` 与 `X` 都清），不负责拆桥（`index.ts:341-352`）。

### 2.6 watchdog 悬挂 → 恢复（10s 心跳）

`TICK_MS = 10_000`（`watchdog.ts:17`），`runGroupWatchdogTick` 的逻辑（`:44-119`）：

| 阶段 | 行为 | 证据 |
|---|---|---|
| 清理僵尸状态 | 组已删除 → 清 `lastPosition` / `suspended` | `:49-50` |
| 跳过未激活队列 | `!q.isActive \|\| q.currentIndex < 0` → 清悬挂、`continue` | `:53-59` |
| 成员探活 | 只对 **DLNA** 成员逐台 `getDeviceStatus`（刷新 runtime available）；sendspin 不探（SOAP 不适用） | `:60-68` |
| 全员离线 | 进 `suspended`、`qc.resetGroupTracker`（清 lastPlaying，避免回归时被误判 ended）、**队列保留** | `:71-81` |
| 成员回归且已在播 | 读 `getGroupStatus().state`，若 PLAYING / PAUSED_PLAYBACK → **跳过自动恢复** | `:87-92` |
| 成员回归需恢复 | `qc.resumeActive(groupId, baseUrl)`；若 `resumePos > 0` 再逐台 DLNA `alignDeviceToPosition` | `:93-100` |
| sendspin 重入组 | 先灌持久组音量再 `sendspinGroupJoin`（ug 组懒创建缺省 100，不灌会跳档） | `:101-110` |
| 正常播放 | 记录 leader 进度到 `lastPosition`（供「最后成员离线瞬间」用） | `:113-117` |

> 悬挂期间组的 `pollState` 报 **BUFFERING 而不是 IDLE**（`protocolPlayer.ts:397 pollState`；悬挂分支 `:402-404` 直接返回 BUFFERING），注释写明原因：IDLE 会被 PlaybackTracker 当作「曲目自然结束」进而 deactivate 队列，看门狗就无从恢复了。
---

## 3 选歌与推进（硬约束，用户已锁定不可协商）

### 3.1 组与单机走同一条链

组的 `playMedia` 只是把「起播」这件事分派给成员/组泵（`services/group/protocolPlayer.ts:313-368`），**「放哪首、能不能放」完全由 `QueueController` 决定**，与单机播放无任何分叉。组队列的宿主 id 就是 `group:<gid>`（`db/schema.ts:384-386`）。

因此下面这套语义对组 100% 适用，且**不允许**为桥接另开捷径：

> 除第一首直接起播外，**第二首起每首必须预下载进内存并经 `judgePrefetchedBuffer` 完整性判定**；不完整 ⇒ `markUnplayable`（TTL 读 `negativeTtlSeconds` 配置，默认 2 小时）⇒ 跳过 / 组内换源（上限 3）。

### 3.2 预取五道闸门

进预取前逐条查（`services/source/prefetchCache.ts:44-49` 文件头 + 实现）：

| # | 闸门 | 参数 | 证据 |
|---|---|---|---|
| 1 | 同曲去重（已缓存 / 在途） | — | `prefetchCache.ts:45` |
| 2 | 全局并发 1（串行排队） | — | `prefetchCache.ts:46` |
| 3 | 预算：在途 + 预估 > 全局预算 × 0.5 → 放弃 | `PREFETCH_BUDGET_RATIO = 0.5` | `prefetchCache.ts:89`、`:481-486` |
| 4 | 单曲 > `STREAM_BUFFER_MAX_FILE_MB`(100MB) → 跳过 | `prefetchMaxFileBytes()` | `prefetchCache.ts:48`、`:478-480` |
| 5 | 只预取网络源（`w:` 行）；本地磁盘 `l:` 行不走 membuf | — | `prefetchCache.ts:49` |

预估用 `PREFETCH_ASSUMED_BYTES = 30MB`（无 size 信息时的兜底，取自 240 曲库 `w:` 行实测均值，`prefetchCache.ts:90-91`）。索引条目 TTL 10 分钟（`PREFETCH_ENTRY_TTL_MS`，`:97-98`），与 membuf 未消费条目对齐。

### 3.3 完整性判官：四条判死线

`judgePrefetchedBuffer(buf, expectedSec)`（`services/source/prefetchCache.ts:169`）按四档判定（**判据顺序锁**见 `tests/source/integrityOrder.test.ts`；文件头 `:24-33`）：

| 档 | 判据 | 阈值 | 证据 |
|---|---|---|---|
| 1 非音频 | magic/sniff 不认（`sniffMagic`）——**必须先于体积判**（2026-10-27：几 KB 的 JSON/HTML 错误页是硬结论，不能落进 too-small 弱信号被放行） | — | `prefetchCache.ts:191` |
| 2 太小 | 整首字节数 < `PREFETCH_MIN_AUDIO_BYTES = 64 * 1024`；**先过硬算术下界**：`buf < expectedSec × PREFETCH_HARD_MIN_BYTES_PER_SEC(=4000，32kbps 地板)` ⇒ `too-small-hard` 硬判死记负缓存；装得下 ⇒ `too-small` 弱信号 | `prefetchCache.ts:111`、`:115-121` | `prefetchCache.ts:195-205` |
| 3 时长差（metadata 线） | 实际比曲库基准**短超过 15s** | `PREFETCH_INTEGRITY_DELTA_SEC = 15` | `prefetchCache.ts:104-109` |
| 4 时长差（码率推算线） | `duration` 缺失（ogg 等容器）时用 `bytes*8/bitrate` 推算，判死线放宽到 **80s** | `PREFETCH_INTEGRITY_DELTA_SEC_BITRATE = 80` | `prefetchCache.ts:112-119` |

> 抓取层还有一道**上游截断对账**（v4.8.3，《纵身一跃》事故）：`bufferedFetch.ts` 的 `attemptOnce` 收尾拿响应头 `content-length` 与实收字节对账，实收 < 90% ⇒ 判 `stalled`（上游提前 EOF），残缺字节不再以 `ok:true` 交回判官。chunked（无 content-length）对不了账，由档 2 的硬算术下界兜底。

**保守原则（写在代码注释里的红线）**：

- 无基准（曲库 `duration = 0`）**不杀**；magic 认是音频但 metadata 解析失败**不杀**（防冷门容器误杀）（`:32`）。
- `ffmpeg` 全解码档（decodable）**故意不做**：抓不到完整短文件，还每首几秒 CPU（`:33`）。
- `too-small` 是**弱信号**：主链先试完其他源，最后才回来重试一次；重试仍 too-small **也不写负缓存**，交给播放侧 probe 用 404/403 硬判（`:465-474`、`:510-516`）。**适用面（2026-10-27 收窄）**：只有「装得下期望时长（≥ expectedSec×4000）」的过小文件才配得上这份宽待；装不下的直接 `too-small-hard` 判死记负缓存——1KB 装不下 200s 是硬结论，不是「这次拿少了」。

### 3.4 判死之后：先换源，全死才跳下一首

用户 2026-10-12 拍板（`prefetchCache.ts:35-42`、`:93-96`）：

| 步骤 | 行为 | 证据 |
|---|---|---|
| ① 候选链 | 解析后首选行 + 同组其他网络源行（**WebDAV 行优先**于平台 web 行：自有曲库没有试听片段问题） | `prefetchCache.ts:36-37`、`:429-448` |
| ② 上限 | `PREFETCH_MAX_ALT_SOURCES = 3`（0 = 关闭换源回到旧行为） | `prefetchCache.ts:92-96` |
| ③ 逐个抓 + 判 | `attempt(cand)` 返回 `ok / dead / toosmall / skip` | `prefetchCache.ts:476-523` |
| ④ 通过即登记 | `registerMemStream(buf, ..., { songId: resolvedId, prefetched: true })` | `prefetchCache.ts:527` |
| ⑤ **双写索引** | membuf 存的是**内容**，ffmpeg 不关心字节来自组内哪一行 ⇒ 候选 id 与解析后 id 都要能命中 | `prefetchCache.ts:37-39` |
| ⑥ 逐个记负缓存 | 每个判死候选各自 `sf.markUnplayable(cand.id)` | `prefetchCache.ts:517-523` |
| ⑦ 全死才标队列行 | **所有**候选都判死时才把「队列行 id」也标上，否则会变成播 30s 试听片段 | `prefetchCache.ts:40-41` |
| ⑧ 知识不完整不标 | 有候选没被评估（取流失败 / 闸门拦下）时**不**标队列行：「不知道」不等于「死」 | `prefetchCache.ts:42` |

### 3.5 桥接绝不允许存在第二条选歌路径

**AirPlay 桥只是组泵 PCM 的旁路接收者。** 它拿到的是 `pushAudio(data, ts')` 的字节（`services/sendspin/server.ts:808`、`:888`），既不知道歌名、也不参与选源、更没有自己的 `ffmpeg` 取流。任何「桥自己拉流」的实现都属于违反本约束。

反向证据（代码事实）：桥的输入源唯一 —— 组 PCM ring `recentByGroup.get(encoderKey("pcm", 100))`（`server.ts:787`）；桥侧不存在歌曲侧输入。

### 3.6 出流侧的行 id = `resolvePreferredSong()` 换源后的 id

`resolvePreferredSong(song)`（`services/source/preferredSource.ts:34`）决定「这一行最终用哪个源」，**且切换前必须先验活**：本地文件不存在 / WebDAV 不可达就继续试下一个（`preferredSource.ts:8`、`:52-56`）。

出流链用的 id 必须是**换源后的那个 id**，不是队列行 id：

- 预取登记的 membuf 索引以 `resolvedId` 为 key（`prefetchCache.ts:527`）；
- 候选链的 `resolvedId` 与「解析后首选行」绑定（`prefetchCache.ts:434`、`:448`）；
- 双写索引的另一半就是候选 id（`prefetchCache.ts:37-39`）。

> 排障含义：日志里出现「解析到 A 行、实际出流是 B 行」是**正常**的换源行为，不是 bug；反之，若出流用的仍是队列行 id 而未过 `resolvePreferredSong`，就是错的。

### 3.7 跳过的边界

`playCurrent` 的跳过循环有**绕过圈上限 = 队列长度**（`skipLimit = Math.max(1, q.items.length)`，`services/player/QueueController.ts:1004-1008`），触顶则 `reportAllUnplayable` 并停止推进（`:1023-1027`）。为什么必须有这个上限：2026-09-11 改成「留队列不摘除」后，旧实现的隐式终止条件（队列越绕越短）消失，整队死源 + all/shuffle 会无限循环（`:1004-1007`）。

单首判定的超时是 10s，超时按「未知」处理 = 照常试播（`QueueController.ts:1012-1020`）；cast 超时 30s（见 §7）。

---

## 4 出流双路

### 4.1 数据流图（同源同拍）

```
                    ┌──────────────────── 同一份 PCM、同一个 tsUs 时间轴 ────────────────────┐
                    │                                                                        │
 [曲库/网络源] → resolvePreferredSong → membuf(预取) / ffmpeg → 解码 → PCM 48k s16le 2ch
                    │
                    ▼
        ┌───────────────────────┐
        │ sendspin 组泵 pushFrame│  ring: recentByGroup["pcm:100"]   ← 唯一内容源
        └───────────┬───────────┘   entries: {tsUs, data, durUs, ep}
                    │
        ┌───────────┴────────────────────────────┐
        │ 路 A: sendspin 直连成员                 │ 路 B: AirPlay 桥（旁路）
        ▼                                        ▼
 c.sendAudio(ts + dspDelayUs, data)     250ms bridgePushTick
 （逐拍、逐成员，server.ts:1479）         → deliverBridgeWindow: ts' = ts − commonSendAheadUs
        │                                   → b.pushAudio(data, ts')
        ▼                                        │
 ESP32/sendspin 客户端                            ▼
 （按自己的 send_ahead 缓冲排程）          MFAB 28B 帧 → unix socket
                                          <tmpdir>/mfab/<hash>.sock
                                                 │
                                                 ▼
                                        airplay 子进程 BridgeSession
                                        （planBridgeAnchor → startNtp 一次性算死）
                                                 │
                                                 ▼
                                        RAOP SETUP/RECORD → 按墙钟 pullChunk → RTP
                                                 │
                                                 ▼
                                        AirPlay 接收端（HiVi 等）
```

### 4.2 路 A：sendspin 组泵

| 环节 | 实现 | 证据 |
|---|---|---|
| 主循环 | `pushLoop`：按真实墙钟节奏取 PCM 段 → 编码 → 下发，时间戳按**实测样本数**推进 | `services/sendspin/streamEngine.ts:699-700` |
| 下发 | `for (const c of g.members) c.sendAudio(ts + dspDelayUs, data)` | `services/sendspin/server.ts:1479` |
| 迟到成员回填 | `seedLateJoin` 用**同一偏移**补历史，否则新成员会比老成员早/晚 `dspDelayUs` | `server.ts:1607-1610` |
| 时间轴原点 | 组泵首帧即 0 点，此后 tsUs 只增不减；时间线游标 `cursorUs` 与 `nowUs()` 同源 | `streamEngine.ts:684-696` |
| 位置上报 | `audiblePositionMs(pushedMs, cursorUs, floorMs)`：`深度 = cursorUs − nowUs()`，`可听 = pushedMs − 深度`，再夹到 `[floorMs, pushedMs]` | `streamEngine.ts:692-697` |

`dspDelayUs` 就是 §6 的 sendspin 侧延迟补偿，**只加在下发时间戳上，不进 ring**（`server.ts:1425` 注释明确 ring 的 tsUs 不被污染）。

### 4.3 路 B：AirPlay 桥

| 环节 | 实现 | 证据 |
|---|---|---|
| 内容源 | 同一个 `recentByGroup["pcm:100"]` ring | `server.ts:787`、`:852` |
| 投递节奏 | 每 250ms 一次 `bridgePushTick`（组级单一定时器，`unref` 不阻进程退出） | `server.ts:825-838`、`:842-860`；`constants.ts:79` |
| 窗口 | 原始 ts 域 `[now + 1.5s + ahead, now + 2.5s + ahead]`；交付时 `ts' = ts − ahead` | `server.ts:854-857`、`constants.ts:85`、`:88` |
| 帧协议 | MFAB 28 字节小端头 + payload；`magic "MFAB" / version 1 / type / flags / generation / sequence / tsUs(i64) / payloadLen(u32)` | `services/airplay/bridgeChannel.ts:1-16`、`:30-51` |
| 帧类型 | `AUDIO=1 / BOUNDARY=2 / CONFIG=3 / HEARTBEAT=4 / STATS=5` | `bridgeChannel.ts:36` |
| 帧上限 | payload ≤ 1 MiB，超限立即抛错（调用方必须断连，不得错位续读） | `bridgeChannel.ts:33-34`、`:7-8` |
| 会合路径 | `<tmpdir>/mfab/<sha1(deviceId:token) 前 11 位 base36>.sock`；路径必须 <100 字节（`sun_path` 上限 108 留余量）；Windows 走命名管道 | `bridgeChannel.ts:13-15` |
| 起播锚点 | `planBridgeAnchor({firstFrameTsUs, latencyFrames, rate, resampled, nowUs, anchorShiftUs})` | `bridgeSession.ts:505-512` |
| 建流 | `player.streamBridge(pullChunk, session, {baseTs, startTs, headTs, startNtp, ...})` | `bridgeSession.ts:522-532` |
| 取内容 | `pullChunk` 凑满 352 帧 chunk（输出速率 s16le/2ch = 1408B）；欠料等待 `waitDataMs`，超时**补静音**（保持 RTP 时钟连续，宁出静音不断流） | `bridgeSession.ts:661-663` |

### 4.4 「同源同拍」的四条硬约束

| # | 约束 | 为什么 | 证据 |
|---|---|---|---|
| 1 | 两条路必须吃**同一个 ring 的同一批 entry** | 否则内容不同步（不同源的歌听起来是「两首歌」） | `server.ts:787`、`:852` |
| 2 | tsUs **只在一个地方**被偏移：sendspin 侧 `+dspDelayUs`，桥侧 `−sendAhead` | 偏移写两处必然互相吃掉 | `server.ts:1425`（ring 不偏移）、`:1479`、`:888` |
| 3 | 桥的投递是**窗口制**，不是「来了就推」 | 直推会把 cursor 域的「未来 10s」灌进桥队列，撞 8s 硬上限 → 重连风暴 | `server.ts:780-782`、`:790-795` |
| 4 | 桥只能**旁路接收** PCM，不得自己取流 | 见 §3.5 | `server.ts:808` |
---

### 4.5 可听前状态上报：BUFFERING 瞬态（v4.8.1）

**问题**：切歌（混合组锚点 lead 5s + 预填充水位 ~10s，单设备同理）在真正可听前有静默窗口，期间 `pollCore` 报 `playing:true`（current 已注册）而位置钳在下界 ⇒ 三端（HA 卡片 / Web 前端 / MusicFlow 客户端）各自「2s 轮询 + 本地 PLAYING 插值」互相打架，进度「前进 ~2s 又跳回 0」无限循环。

**修复**：可听前上报 BUFFERING 瞬态——
- `SendspinGroup.audibleStarted` 标志：play()/seek()/rehost()/cast 起播**复位**；pushLoop 与曲末排空循环首次越过上报下界（严格大于 `floorMs`）**置位**。时间线重锚分支**不**复位（防 mid-play 重锚误报）。
- `pollCore` 返回新增 `buffering`（stub 组 undefined 退化 false）；四处映射为 `BUFFERING`：`sendspin/protocolPlayer.ts` 组 / 单设备 in-proc / fork proxy 三处 + `group/protocolPlayer.ts::getGroupStatus` 两处 sendspin 分支。
- **三端零改动**：客户端 `playing => state=='PLAYING'`、Web 前端 `statePlaying` 白名单、HA 集成 `STATE_MAP` 早已映射 `BUFFERING` ⇒ 可听前自动停止本地插值，进度停在下界直到真正出声。
- 安全性：PlaybackTracker 把 BUFFERING 当瞬态（不判自然结束 / 不清 lastPlaying / 不计冻结宽限）；fork RPC 透传，旧子进程缺字段退化旧行为。

---

## 5 时间基准与同步（排障第一原则）

### 5.1 三个时钟，别跨域相减

| 时钟 | 定义 | 用途 | 证据 |
|---|---|---|---|
| host 单调钟 | 服务器 `nowUs()`（monotonic µs） | 所有超时/窗口/深度计算 | `sendspin/streamEngine.ts:684-696` |
| **组内时间戳基线** | 每个组**自身累计交付的内容位置** + 本批游标相对批前峰值的跳变（`deliveredByGroup` + `jumpUs`）。**不能**用共享游标 `tsUs` 直接打戳 | sendspin 下发戳、ring 条目 | `sendspin/server.ts:1454-1467` |
| 桥首帧 `firstFrameTsUs` | 桥侧**首个有效 AUDIO 帧的 tsUs**，即锚点候选 A | 桥锚点唯一输入 | `airplay/bridgeSession.ts:301-302`（声明）、`:402-403`（捕获）、`:199` |
| RTP/NTP | 子进程本地 RTP 戳 + `startNtp = ntpFromHostUs(A′ − L)` | 只用于设备侧排程 | `bridgeSession.ts:621-659`、`bridgeMath.ts:76+` |

> 三套时钟的完整对照（谁能被墙钟带歪、`tsUs` 生产规则）见 [airplay-权威方案文档.md](./airplay-权威方案文档.md) §10.1/§10.2 —— 本节只保留**组维度**的判据。

> **术语纠偏（重要）**：全仓 grep `contentClock` / `contentSec` / `contentEpoch` **零命中** —— 这三个词是**旧称，代码中不存在**（早期设计文档的概念名）。落到真实符号上必须写：**桥侧首帧 = `firstFrameTsUs`**（`bridgeSession.ts:301-302`、`:402-403`），**锚点 = `firstFrameTsUs + anchorShiftUs`**（`:209`），**组内时间戳基线 = 各组 `deliveredByGroup` 累计交付位置**（`sendspin/server.ts:1454-1467`）。凡本文旧称「内容时间线 0 点」的地方，一律按这三个真实符号理解。

**排障第一原则：跨域相减 = 作废证据。** 组内时间戳基线（`deliveredByGroup` 累计交付位置）比墙钟超前一个预填深度（240 实测约 10.584s）；桥侧的「可听域」又比它落后一个 `commonSendAheadUs()`。拿一个域的数值去减另一个域的 `now`，得到的差值毫无意义 —— 这正是桥投递窗口化之前 10.584s 指令超前 / 8s 硬上限重连风暴的根因（`server.ts:780-782` 的注释复盘）。

### 5.2 成员位置基准必须取内容时间线，不能取「会话已过时长」

**不能把「已推送量」当进度报。** 服务端是按快于实时的速度把缓冲灌满、设备仍按实时播 —— 于是 `framePosMs` 一开局就已经是 10s，而扬声器才刚要出第一个字节；直接上报的表现就是「10s 档开播瞬间进度条和歌词都显示 00:10」，声音却从头开始（真机 2026-09-24，`streamEngine.ts:680-683` 注释原文）。

正确公式（`streamEngine.ts:692-697`）：

```
depthMs  = (cursorUs − nowUs()) / 1000        // 设备侧当前缓冲深度
audible  = pushedMs − depthMs                 // 可听位置
audible  = min(audible, pushedMs)             // 缓冲被抽干时不得超前
audible  = max(audible, floorMs)              // 本轮目标（起播/seek）为下界
```

`floorMs` 同时满足两个语义：正常起播 `floor = 0`（「开播显示 00:00」的修复效果）与拖动后立刻显示目标值（`streamEngine.ts:687-689`）。

### 5.3 锚点 `startNtp` 一次性算死

`maybeBeginStream()` 是桥从「收到首帧」到「开始吐 RTP」的唯一入口（`airplay/bridgeSession.ts:496-532`），关键五行：

| 行 | 行为 |
|---|---|
| `:402-403` | 捕获首帧：`if (this.firstFrameTsUs === null && a.tsUs !== 0n) this.firstFrameTsUs = a.tsUs;` 并立即 `void this.maybeBeginStream()` |
| `:498` | **幂等闸门**：`if (this.aligner !== null) return;` —— 建过就永不重建 |
| `:504` | `latencyFrames = max(1, player.negotiatedLatencyFrames)`（L 不得归零，与 SYNC 用同一值） |
| `:505-512` | `planBridgeAnchor(...)` 一次算出 `anchorUs`/`commandedLeadUs`/`anchors`（含 `startNtp`）；`:513-515` 的 `reAnchored` 打 `anchor unreachable … → re-anchor`（设计内路径，非故障） |
| `:209` | 锚点公式：`anchorUs = firstFrameTsUs + BigInt(anchorShiftUs ?? 0)` —— 组延迟补偿的唯一乘法点 |

逐行表（`:497` 前置条件 / `:519` aligner 建立 / `:522-532` 交给 `streamBridge` 的字段）见
[airplay-权威方案文档.md](./airplay-权威方案文档.md) §10.5。

**推论（写进产品预期）：** 会话建立后改 AirPlay 延迟、改设备、改 resample 状态，都不会影响已建立的锚点 —— 只能拆会话重建（见 §6.5）。

### 5.4 `stats` 是内容同步的权威判据

每设备一行 JSON，默认 2s 一次（`statsIntervalMs` 默认 2000，`bridgeSession.ts:253`；发射点 `:621-659`）。**字段全表在
[airplay-权威方案文档.md](./airplay-权威方案文档.md) §10.6**，这里只列组维度判读要用的 6 个：

| 字段 | 判读 |
|---|---|
| `gen` | 内容代次。**变化 = 重锚/重投一代内容**；某台落后 ⇒ 它重建过会话（成员不同步） |
| `state` / `clock` | `live` 才在真正推流（`state` 全程 `live` 而 `queueMs` 只有 4-12ms 是**正常形态**，极易误判成「桥没在播」，`bridgeSession.ts:148` 注释）；`clock` 恒 `"local-rtp-ntp"`，出现别的值 = 时钟域已被改坏 |
| `deltaUs` | 已写入 RAOP 的内容前沿相对 `A′` 的超前量（≈ L + 队列 + 在途）。**锚点错 X ⇒ 恒偏 X**，与 `driftUs`/`late` 可区分（`:630-634`） |
| `deltaP95Us` / `samples` | 近 25 个 `deltaUs` 的 p95 / 样本数。判稳定性，峰值比均值更可信 |
| `queueMs` / `maxQueueMs` | 桥内待发队列深度。长期贴上限 = 投递过猛（旧实现症状） |
| `late` / `realigned` / `driftUs` | lead 不足次数 / 重锚次数 / 对齐残差。`late` 持续涨 = 锚点太近；`driftUs` 稳态应 ≈0 |

**判据（不依赖人耳）**：两台成员**逐拍**比对 `gen / clock / deltaUs / deltaP95Us / queueMs`。同 `gen`、`clock` 一致、`deltaUs` 差在噪声级（数百 µs）、`deltaP95Us` 形状相近 ⇒ 出流齐。

**另一条日志线：锚点事件 `ev:"anchor"`**（`bridgeSession.ts:596-612`），**只在建流那一刻打一次**，是「这个会话到底按什么锚点走」的唯一凭据：

| 字段 | 判读 |
|---|---|
| `scheduledAnchorUs` | 计划锚点 `firstFrameTsUs + anchorShiftUs`（已含组延迟补偿）；`shiftedAnchorUs` 是重采样路径下含群延迟的平移值 |
| `commandedLeadUs` | 指令超前量（应与 `tick.leadUs` 一致；不一致说明中间重锚过） |
| `latePackets` / `mapping` | `latePackets` 恒 `0`、`mapping` 恒 `"local-rtp-ntp"`；**诚实语义：只上报 scheduled anchor，绝不假装收到设备播放确认**（`:595` 注释） |
| `latencyFrames` / `baseTs` / `rate` / `resampled` / `reAnchored` | RECORD 协商值与 RTP 基戳 / 是否经重采样（决定 `A′ = A + 群延迟` 是否生效） / 是否走了「锚点不可达 → 热启重锚」 |

> 排障用法：`tick.anchorUs` 与 `anchor.scheduledAnchorUs` 对比 —— 相等 ⇒ 会话锚点没变；不等 ⇒ 中途重锚（内容被丢弃一部分）。

### 5.5 PCM 互相关必须用尾窗

这是**测量方法论**而非代码（代码里没有互相关实现）：

- 用**文件头**对齐：量到的是「两次会话的**起始时刻差**」，与用户听到的稳态 A/V 偏差无关 —— 属于假证据。
- 用**尾窗**（稳定播放若干秒后的一段）：量到的才是稳态相位差，与 `stats` 的 `deltaUs` 应一致。
- 交叉校验要求：尾窗互相关结果 ≈ `stats.deltaUs` 之差的量级；两者矛盾时以 `stats` 为准（`stats` 是设备侧排程前的内容前沿，互相关还叠加了设备 DAC/功放链路）。

---

## 6 延迟补偿（v4.8.0 按成员，必须写细）

### 6.1 语义与存储

**语义（所有成员一致）：正数 = 该设备更晚出声，负数 = 该设备更早出声。单位 ms。**

| 项 | 值 | 证据 |
|---|---|---|
| 存储 | `player_groups.member_delays_json`（text, notNull, default "{}"）：命名空间成员 id → ms 的 JSON map | `db/schema.ts`（`memberDelaysJson`） |
| 键 | `airplay:<deviceId>` / `sendspin:<clientId>`，与 `player_groups.memberIds` 完全同源 | `delayCalib.ts:7-12` |
| 类型 | `MemberDelays = Record<string, number>`（已钳制） | `delayCalib.ts:33-34` |
| 范围 | `GROUP_DELAY_MIN_MS = -30000` / `GROUP_DELAY_MAX_MS = 30000` | `delayCalib.ts:23-24` |
| 步进（前端） | `GROUP_DELAY_STEP_MS = 10` | `delayCalib.ts:26` |
| 钳制 | `clampGroupDelayMs`：非有限值 → 0，其余 `round` 后夹到 ±30000 | `delayCalib.ts:51-55` |
| 解析 | `parseMemberDelays`：非法/缺失/非对象 → `{}`，逐项钳制 | `delayCalib.ts:58-73` |

**历史口径（v4.6.77~v4.7.2，已被 v4.8.0 取代）**：按协议三格（`airplay_delay_ms` / `airplay2_delay_ms` / `sendspin_delay_ms`），三格互相独立、AP1 与 AP2 分格（44.1k 重采样+明文 RTSP vs 48k 直通+加密链路）。v4.8.0 起**按成员存**：协议差异被「每台设备一格」天然覆盖。旧三格列在 initDatabase 幂等迁移中 DROP（try/catch 逐列），**旧值不迁移**；`DEFAULT_AIRPLAY_ALIGN_MS = 300` 播种机制同批删除（`createGroup` 不再播种，无一次性迁移）。

### 6.2 读口与写口（`delayCalib.ts`，178 行）

| 导出 | 语义 | 证据 |
|---|---|---|
| `getMemberDelays(groupId)` | 读整表（懒加载 + 缓存）；返回**新建对象**（缓存命中也另拷一份），调用方改写不污染缓存 | `delayCalib.ts:77-94` |
| `getMemberDelayMs(groupId, memberId)` | 读单成员；没设过/组缺失 → 0 | `delayCalib.ts:97-100` |
| `setMemberDelay(groupId, memberId, ms)` | 写单成员：**内存先更新（立即生效），再落库**（`member_delays_json` 整表回写）；返回实际生效值（已钳制） | `delayCalib.ts:113+` |
| `getTrackLeadMs` / `setTrackLeadMs` | 切歌垫片组值（ms，**0 = 完全自动**：生效 lead = max(组值, 冷/暖动态)，动态口径见 `sendspin/constants.ts` 的 `BRIDGE_TRACK_LEAD_COLD/WARM_US`）；API 隐藏调参口，前端弹窗已移除 | `delayCalib.ts:28-31`、`:102-109` |
| `invalidateGroupDelays(groupId)` | 组删除时清缓存（防 id 复用读到陈旧值） | `groups.ts:193` |

缓存策略：懒加载 + 写时更新（无 TTL）；延迟值只经 `setMemberDelay`/`setTrackLeadMs` 变更，不需要失效轮询。

### 6.3 AirPlay 成员生效链路（投递窗口/时戳位移，动态读）

```
member_delays_json["airplay:<deviceId>"]
   ↓ bridgeAnchorShiftUsOf(groupName, deviceId)        (delayCalib.ts；动态读缓存)
   ↓ SendspinGroup.bridgeAnchorShiftUs(deviceId)        (server.ts:947-949)
   ├→ 补投窗口: lo/hi = now + FLOOR/HORIZON + ahead − shift   (server.ts:818-820 / 885-887)
   └→ 投递时戳: 与窗口同一取值,ts' 同加 shift                  (server.ts:908)
```

**铁律不变：桥内锚点 `anchorShiftUs` 恒 0（G13-b）**。补偿若写进锚点，对齐器把多出的位移判「内容超前」整段裁掉（v4.7.1 前真机实锤：切歌吞 2 秒、净补偿归零）。`ring` 的 `tsUs` 一律不动（§5）。

**动态读的含义**：PUT 写缓存 ⇒ 下一补投 tick 即按新值算窗口/戳，无需任何通知链；但 AirPlay 的可听落点随**桥会话建立**锚定，要对已建会话立即生效必须重建/自愈该成员桥（§6.5）。

### 6.4 Sendspin 成员生效链路（帧级、真·实时）

```
member_delays_json["sendspin:<clientId>"]
   ↓ sendspinDelayUsOfClient(groupName, clientId)       (delayCalib.ts；动态读缓存)
   ↓ SendspinGroup.sendspinDelayUsOf(clientId)           (server.ts:1428)
   ├→ 逐拍下发: c.sendAudio(ts + sendspinDelayUsOf(...), data)   (server.ts:1522)
   └→ 迟到回填: 每客户端各自偏移                           (server.ts:1658)
```

**`ring` 的 `tsUs` 绝不能被污染。** ring 里的时间戳是内容时间线的真相；偏移只在下发那一刻加。若把偏移写进 ring：① 改延迟后历史条目的戳就错了，回填会把老内容塞到错位置；② 桥的投递窗口判定（读同一 ring）跟着漂。下一次 `pushFrame`（约 0.5~1s，等于设备 `send_ahead`）即按新值打戳——无会话重建。

### 6.5 重建/自愈（仅 `airplay:` 成员值变化时）

现行处置（`routes/api/groups.ts:129-188`）：

| 条件 | 处置 | 代价 |
|---|---|---|
| `airplay:` 成员值变了 且 `isBridgeRouteActive(id)` | `rebuildBridgeRoutes(id)` 重建该组桥 | 该组 AirPlay 成员约 1~2s 静音 |
| `airplay:` 成员值变了 但路由登记缺失而桥在播 | **join 兜底自愈（2026-10-27）**：逐 airplay 成员 `bridgeJoinMember`（幂等）—— 现场初始化路由 + prepare 新会话（子进程自拆同设备旧会话）+ 泵 sync 停旧句柄起新句柄并回填 | 同上；新值随新会话锚定立即生效 |
| 只改 `sendspin:` 成员 / `trackLeadMs` | 不重建 | 无感（下一拍生效） |
| 重建/自愈失败 | 保存仍成功 | 下次会话按新值建立 |

### 6.6 接口

| 方法/路径 | 请求 | 响应 | 证据 |
|---|---|---|---|
| `GET /v1/groups/:id/delays` | — | `{memberDelays, trackLeadMs, minMs, maxMs, stepMs}` | `routes/api/groups.ts:113-127` |
| `PUT /v1/groups/:id/delays` | `{memberId, ms?, trackLeadMs?}` | 同上 + `rebuilt` | `groups.ts:129-188` |

PUT 语义：`memberId` 必须是本组成员（命名空间 id **原样整条**），越组写入 400 `errors.group.memberNotInGroup`（i18n zh+en）；`ms` 经钳制后生效；`trackLeadMs` 可选独立写。两路由都要求 `PERM.RENDERER_USE` + 存在性/owner 双判（§1.5）。写入顺序**内存先更新、再落库**（播放正确性优先）。

### 6.7 持久化与迁移

| 项 | 说明 |
|---|---|
| 列 | `member_delays_json`（text, notNull, default "{}"；v4.8.0 新增） |
| 旧列 | `airplay_delay_ms` / `airplay2_delay_ms` / `sendspin_delay_ms` 在 initDatabase 幂等迁移中 DROP（try/catch 逐列），**旧值不迁移** |
| 兜底 | 无组上下文（设备直连/单测桩）一律 0；全局桥标定仍由 `airplay/bridgeCalib`（`bridge.avShiftMs`，±2000ms）管，不归本文件 |
| 缓存失效 | `invalidateGroupDelays`（组删除时调，`groups.ts:193`） |

### 6.8 前端入口

| 元素 | 说明（`frontend/src/views/Groups/index.vue`） |
|---|---|
| 成员 chip 点击 | 弹出**该成员的延迟补偿弹窗**（单数值输入 ±30000/步进 10；服务端按成员 id 与实际协议取值，用户无需关心 AP1/AP2/Sendspin） |
| chip 徽标 | 该成员非 0 补偿回显（`member-delay-badge`） |
| 已删除（v4.8.0 裁定） | 组级双 slider 弹窗、「延迟补偿」组级按钮、「复制设备 ID」交互 |


## 7 容量与预算

### 7.1 组起播 lead = 1.75s（不是 500ms，也不是 4.5s）

三档并存，由「有没有桥」「有没有直连成员」决定（`services/sendspin/streamEngine.ts:886-893`）：

| 组形态 | lead 取值 | 数值 | 证据 |
|---|---|---|---|
| 纯桥组（无直连成员） | `bridgeStartLeadUs([{warm:false}])` 深锚（与 `aheadUs` 取 max） | 深锚（秒级，见 `bridgeMath.ts:132`） | `streamEngine.ts:888` |
| **混合组**（既有直连 sendspin 又有桥） | `max(aheadUs, BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US)` | `1.5s + 250ms = 1.75s` | `streamEngine.ts:889`、`sendspin/constants.ts:96` |
| 无桥组 | 预填开 → `min(aheadUs, ANCHOR_SAFE_LEAD_US)`；否则 `reseedLead`/`aheadUs` | 亚秒级 | `streamEngine.ts:890-892` |
| 硬下限 | `lead = max(anchorLead, FIRST_FRAME_LEAD_US)` | — | `streamEngine.ts:893` |

**契约反转的历史（必读）**：原实现让混合组回落 800ms 截断 ⇒ `lead = min(sendAhead 500ms, 800ms) = 500ms`，而桥投递窗口下沿是 1.5s ⇒ 组开播就把「桥来不及排程」的前 1s 内容推过去，桥只能从窗口下沿接（水位推过）⇒ **用户实测「SENDSPIN 已出声、AirPlay 还没声、整首开头丢」**（真机 2026-10-26，`streamEngine.ts:879-885` 注释原文）。抬到「下沿 + 一个补投周期」后首帧即落窗内 ⇒ 开头零丢失；代价是每首歌起播多等 ~1.25s（全组一致，**仍不是** cold 深锚 4.5s，避免直连 esp32 承受秒级跳变）。

### 7.2 cast 与判定超时

| 项 | 值 | 证据 |
|---|---|---|
| cast 超时 | 30s（测试接缝 `MF_CAST_TIMEOUT_MS` 可缩短） | `services/player/QueueController.ts:1079-1095` |
| 单首可播性判定超时 | 10s，超时按「未知」= 照常试播 | `QueueController.ts:1015-1020` |
| 跳过圈上限 | `max(1, q.items.length)` | `QueueController.ts:1008`、`:1023-1027` |
| 组 watchdog 周期 | 10s | `services/group/watchdog.ts:17` |
| 桥路由对账周期 | 60s，孤儿宽限 55s（连续两轮才动手） | `protocolPlayer.ts:481`、`:484` |
| 桥补投周期 | 250ms | `sendspin/constants.ts:79` |

### 7.3 `send_ahead` 缓冲

| 项 | 值/规则 | 证据 |
|---|---|---|
| 缺省 `min_buffer` | 800ms（老版本硬编码值，ESP32 类实测够用） | `services/sendspin/group.ts:41-47` |
| 组公共 `send_ahead` | **全部成员取最大值**（MA 的 `_min_send_ahead_us` 语义：名 min 实为「所有活跃 audio role 的最大值」，余量必须满足最慢的那个） | `group.ts:71-89` |
| 空成员 | 返回**缺省 800ms 而非 0**（0 = 「本块应立即输出」= underrun 成因） | `group.ts:74-77` |
| 设备报 0 的处理 | 0/负数/非有限 → 视作「未提供」，回落缺省。理由：ESPHome 固件把 `output_delay/required_lead/min_buffer` **全报 0**，那是表达能力缺失，不是真实诉求 | `group.ts:59-69` |

> 这条缺省的取舍被写在注释里：**宁可多留余量导致起播稍慢，也不能少留导致断流**（`group.ts:41`）。

### 7.4 首包等待与 TTL 表

| 项 | 值 | 证据 |
|---|---|---|
| 出流首包等待 | `STREAM_BUFFER_HEAD_WAIT_MS = 8000`；env 同名可覆盖，但**钳 ≤ 8000** | `routes/rest/index.ts:2104`、`:2092`、`:2116` |
| 可播（正）缓存 | 1 小时 | `services/source/online/streamFallback.ts:58` |
| 负结果（探测无源） | **默认 2 小时**后重探（源恢复即自动复活；`core-pre-probe` 插件 `negativeTtlSeconds` 可覆写，2026-10-27 与插件默认 7200 对齐） | `streamFallback.ts:59` |
| 网络异常退避 | 5 秒（**不判不可播**：网络抖动 ≠ 没源） | `streamFallback.ts:60` |
| 内容型判死 `markUnplayable` | **同一份可配置 TTL（默认 2 小时）**——2026-10-27 统一，原独立固定 5min 废除 | `streamFallback.ts:539` |
| 预取索引条目 | 10 分钟（与 membuf 未消费条目对齐） | `prefetchCache.ts:97-98` |
| 探测超时 | 12 秒（预探测路径可传更短） | `streamFallback.ts:64-65` |

> 为什么负缓存统一 2 小时（2026-10-27 用户拍板）：内容问题是「这串字节本身不完整」，短期内重试没意义；原 5 分钟过期太快，重复播放场景每 5 分钟重蹈一次坏源。平台版权/VIP/试听策略会变，2 小时过期自动复活重探——开通 VIP 后最多 2 小时即恢复，不会被永久挡住。
---

## 8 失败模式速查（现象 → 根因 → 处置）

> 判读顺序建议：先看 `[group]` 日志路由（bridge / legacy / solo），再看 `[airplay-bridge] {"ev":"tick"}` 的 `gen/deltaUs/queueMs/late`，最后看 `[group][seek]` / `[group][cast]` 的成员级明细。

### 8.1 组起播即 IDLE 连跳

| 项 | 内容 |
|---|---|
| **现象** | 点播放，一两秒内直接跳到下一首，连续多首；客户端显示「播放中→空闲」反复 |
| **根因** | 组 `pollState` 报 `IDLE` ⇒ `PlaybackTracker` 把它当作「曲目**自然**结束」⇒ 触发 advance 切歌，并可能 deactivate 队列 |
| **代码事实** | 全员离线时组**故意**报 `BUFFERING` 而非 `IDLE`（`services/group/protocolPlayer.ts:397 pollState`，悬挂分支 `:402-404`），注释写明「报 IDLE 会被当作曲目自然结束从而 deactivate 队列，看门狗就无法悬挂/恢复」 |
| **处置** | ① 确认 leader 解析：`getGroupLeader` 为空才是这条路径（`protocolPlayer.ts:164-187`）；② 若 leader 有值但仍 IDLE，检查 leader 那条路的 `pollState` 派生分支（sendspin / 桥占用 airplay / solo airplay 三分支，`:373-406`）；③ 切歌后必须 `resetGroupTracker`，否则上一首的 PLAYING→IDLE 迁移会**再次**触发 advance（`QueueController.ts:1099`、`:1510-1515`） |

### 8.2 整首开头丢（SENDSPIN 有声 / AirPlay 无声）

| 项 | 内容 |
|---|---|
| **现象** | 每首歌开头约 1s 只有 esp32 出声，AirPlay 成员静音；1s 后两者齐 |
| **根因** | 混合组 lead 太浅：`lead = min(sendAhead 500ms, 800ms) = 500ms` < 桥投递窗口下沿 1.5s ⇒ 组开播就把「桥来不及排程」的前 1s 内容推过去，桥只能从窗口下沿接（水位推过） |
| **代码事实** | `BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US = 1.5s + 250ms = 1.75s`（`sendspin/constants.ts:96`）在 `streamEngine.ts:886-889` 生效；注释原文记录了真机 2026-10-26 的这次事故（`:879-885`） |
| **处置** | ① 确认是混合组（`hasBridges() && hasDirectMembers()`）走了 1.75s 分支；② 若仍是纯桥组深锚/无桥分支，检查 `aheadUs` 是否被设备上报值压小（`group.ts:76-89`）；③ 查 `[airplay-bridge] tick` 的 `leadUs` 与 `late`：`late` 持续增长 = lead 不足 |

### 8.3 组音量丢失（滑到 0 / 拉不动 / 只有一台变）

| 项 | 内容 |
|---|---|
| **现象** | 真机 HiVi（在组里、被桥占用）音量 slider 无反应；日志 `[group][setVolume] <gid>: 无在线 DLNA/AirPlay 成员,跳过扇出` |
| **根因** | `fanOut` 为传输类指令（stop/pause/resume/seek）过滤掉 bridge-owned 成员，**把 setVolume 也一起过滤了**；而组泵不承担音量、桥会话只在建立时收到一次 initial volume ⇒ 没有任何人给它发音量 |
| **代码事实** | 过滤语句保留守卫钉定形态（`protocolPlayer.ts:216`），setVolume 例外以追加循环实现（`:217-225`），调试日志在 `:227` |
| **处置** | ① 确认走的是 `setAirPlayVolume`（先落库 → 同 host 优先 DLNA RenderingControl → 回落 RAOP `SET_PARAMETER`，`airplay/control.ts:1177`）；② 该链**纯控制**、不触 RTP/时间线，与泵不互踩（`protocolPlayer.ts:217-220` 注释）；③ 期望日志：桥会话 `SET_PARAMETER volume=`（真机 240 已见 `volume=-29.70 (no-wait)`）；④ sendspin 直连成员音量走独立路径 `spinOp(p => p.setVolume(vol))`（`protocolPlayer.ts:362`），不受此影响；⑤ 组音量权威始终是库值（`protocolPlayer.ts:358-361`、`getGroupStatus` `:414-415`、`:468`）；⑥ **播放中**改音量走另一条链（fork 模式下）：主进程 `control.ts:1226 applyVolumeDb` → 子进程 `setVolumeDb` → `runtime.setVolumeDb` 返回 `false`（native 未命中）时回落 `bridgeSessions.setVolumeDb`（`childMain.ts:127-128` → `bridgeSession.ts:833-838` → `:773-778`），详见 C-10 |

### 8.4 孤儿 bridge session

| 项 | 内容 |
|---|---|
| **现象** | 设备已经不在播、组也停了，但 `[airplay-bridge] tick` 仍在每 2s 刷（时间线继续泵）；新组播**不替换**旧会话；`/stop` 拆不掉；`stats` 里内容前沿持续增长 |
| **根因** | 路由登记（`activeBridgeRoutes`）与侧上会话（sendspin 泵句柄 / airplay 会话）不一致。历史来源写在注释里：摘除吞错拆 sock、空组回收不清桥、fork 组停不清桥（`protocolPlayer.ts:471-476`） |
| **代码事实** | 对账器 60s 一轮、**只摘不建**；孤儿宽限 55s（连续两轮仍在才动手），避开 `bridgePrepare 成功 → route.push` 与 `rebuildBridgeRoutes` 重锚定中的瞬态窗口（`protocolPlayer.ts:471-484`、`:511-560`、`:562-572`）；两侧对账口径不同：泵侧按 `deviceId`，airplay 侧按 `deviceId:token`（同设备换 token 的旧会话也算孤儿，`:538`） |
| **处置** | ① 查 `[group][bridge] 对账摘除孤儿句柄/会话` 日志（`protocolPlayer.ts:566`（句柄）、`:584`（会话），都在 `reconcileBridgeRoutesOnce` `:544` 内）；② 若反复出现，核对 `teardownBridgeRoute` 是否真的执行（`protocolPlayer.ts:278-283`）与 `bridgeLeaveMember` 的延后 stop（`:74-94`，延后判定在 `:86-92`）；③ 桥侧自证：`stats.gen` 长时间不变 + `deltaUs` 持续增长 = 泵在空转 |

### 8.5 组位置恒 0 / 握手 30s

| 项 | 内容 |
|---|---|
| **现象 A** | 组在播、有声音，但 `/status` 的 `position` 恒 0 或恒不变 |
| **根因 A** | 桥播放期间该 AirPlay 设备的 **solo 会话视图恒空**（solo 会话根本没建立），若从会话读位置就恒 0/STOPPED |
| **代码事实 A** | `pollState` 在 `isBridgeOwned(leader.id) && spin.length > 0` 时改从 sendspin 组泵派生（`protocolPlayer.ts:379-406`）；`getGroupStatus` 同款分支（`:437-452`），注释写明「否则全程恒报 STOPPED」 |
| **现象 B** | 起播握手卡满 30s 后失败，设备无声 |
| **根因 B** | cast 被 30s 硬顶掐断；常见于单会话设备（HiVi）在**第二次 RECORD** 上永久等待 |
| **代码事实 B** | cast 超时 30s（`QueueController.ts:1079-1095`）；「起播即落位」禁止「先起播再 seek」，因为 AirPlay seek = 完整重建会话（`airplay/protocolPlayer.ts:33-37`） |
| **环境因素（历史实测，非代码缺陷）** | 230 接收端每会话会泄漏一个忙转子进程，堆积后表现为握手变慢/失败 —— 属运行环境，需在该机 `ps` 侧核查，服务端抓不到 |

### 8.6 成员删不掉（前缀被剥）

| 项 | 内容 |
|---|---|
| **现象** | 前端点「移除成员」返回成功，刷新后成员还在 |
| **根因** | 客户端提交的是裸 id（`AA:BB:CC`），库里存的是 `airplay:AA:BB:CC`；`applyMemberDelta` 用 Set 精确匹配，裸 id 匹配不到 ⇒ 静默 no-op |
| **代码事实** | `index.ts:247-249`（删除集合）与 `:253`（新增去重）都是整串比较；前端候选 id 是整串（`Groups/index.vue:952-969`）、`formMembers` 存整串（`:1817`） |
| **处置** | ① 用抓包/DOM 校验请求体里 `remove[]` 是否带命名空间；② 服务端无幻觉余量：`splitMemberId` 只用于**解析**，不用于成员比对；③ 详见附录 C-2 的残留风险 |

### 8.7 `duration=0` 裸条目导致立刻 advance

| 项 | 内容 |
|---|---|
| **现象** | 某首刚播就跳；或进度条长度恒 0 |
| **根因** | 队列条目/曲库行 `duration` 为 0，且代码**不采信设备自报时长**（有设备恒 0 或乱报）⇒ 上报 `duration=0`，推进逻辑按「已到末尾」处理 |
| **代码事实** | 时长解析只认队列/曲库值且有 `> 0` 闸门（`QueueController.ts:1138-1143` 注释「只用曲库/队列项的值，不采信设备自报 duration」） |
| **处置** | ① 修数据（曲库 duration）而不是改播放器；② 判官侧的同类「无基准不杀」原则见 §3.3（`prefetchCache.ts:32`） |

### 8.8 其它高频现象对照表

| 现象 | 最可能位置 | 证据 |
|---|---|---|
| `[group][seek] ... DLNA 2/3 ... sendspin=1` 后成员不同步 | seek 两条独立路径一成一败 | `protocolPlayer.ts:378-390` |
| 组里某台「状态正常但没声」 | 桥失败但没回落 solo cast（违反 MAJ-07） | `protocolPlayer.ts:337-341` |
| 起播很慢（+1.25s） | 混合组 1.75s lead 的**设计代价** | `streamEngine.ts:884-885` |
| 改延迟后 AirPlay 短暂静音 1-2s | 桥重建的**设计代价**，响应里 `rebuilt>0` 可确认 | `groups.ts:152-188` |
| 改了 sendspin 延迟要等半秒多才听出来 | 帧级生效，受设备 `send_ahead` 影响 | `delayCalib.ts:10-12` |
| 群里两台 AirPlay 差几百 ms | 检查各自 `stats.deltaUs`；`gen` 不同 = 有一台重建过 | `bridgeSession.ts:642-658` |
| 组播完一首后再播没声，重启才好 | 查孤儿桥会话（§8.4）与 `activeBridgeRoutes` | `protocolPlayer.ts:471-560` |
| 4G 弱网下整队被跳空 | 死源整队 + skipLimit 触顶 `reportAllUnplayable` | `QueueController.ts:1004-1027` |

---

## 9 验收判据（不依赖人耳）

### 9.1 双端对账（首选判据）

| # | 判据 | 通过标准 | 依据 |
|---|---|---|---|
| A1 | 同一时刻两端 `audible position` 差 | ≤ TOL（建议 150ms；组内同步目标） | 位置派生自内容时间线（`streamEngine.ts:692-697`） |
| A2 | `stats` 逐拍比对 | 同 `gen`、同 `clock`、`deltaUs` 差在噪声级 | `bridgeSession.ts:642-658` |
| A3 | 正数 `late` / `realigned` | 稳态 `late` 不增、`realigned` 不增 | 同上 |
| A4 | `queueMs` 不贴上限 | 稳态远低于上限 | 旧实现贴 8s 硬上限是重连根因（`server.ts:780-782`） |

### 9.2 相对量判据（单端可判，不需要人耳也不需要第二台设备）

| # | 判据 | 通过标准 | 依据 |
|---|---|---|---|
| B1 | 响应落点 ≈ 源端定格值 | 源端在 T 秒定格（pause），目标端恢复后位置 ≈ T | `floorMs` 语义保证拖动/恢复后立刻显示目标值（`streamEngine.ts:687-689`） |
| B2 | 响应非 `null` ⇒ 目标端在落点附近起播 | `pos ≥ 定格值 − TOL` 且 `state=PLAYING` | 起播即落位：起点编进本次 cast（`airplay/protocolPlayer.ts:31-53`） |
| B3 | 播放中位置单调 | 不倒退（时间轴只增） | `streamEngine.ts:894-900` 注释明确「回跳只换内容，时间轴永不倒退」 |

### 9.3 判据的失效条件（避免拿假证据下结论）

| 反模式 | 为什么错 | 正确做法 |
|---|---|---|
| 拿「文件头」做 PCM 互相关 | 量到的是会话起始时刻差，不是稳态 A/V 差 | 取尾窗（§5.5） |
| 拿 cursor 域 ts 直接和 `now` 相减 | 差值是预填深度（240 实测 10.584s），不是延迟 | 先按域归类再相减（§5.1） |
| 用 `queueMs` 小判定「桥没在播」 | `state=live` + `queueMs 4-12ms` 是正常形态 | 看 `gen/deltaUs/late`（`bridgeSession.ts:148`） |
| 用单次 `tick` 下结论 | 2s 一次采样，单点噪声大 | 连看 ≥5 拍，或看 `deltaP95Us` |

---

## 10 回归守卫清单

### 10.1 现状：群组守卫已落地（`check-group-invariants.mjs`，G1~G13，48 条断言）

`backend/scripts/check-group-invariants.mjs`（2026-10-26 新增并挂 CI；v4.8.0 起 G10/G11 改钉成员级、新增 G13）。实测运行结果（`node backend/scripts/check-group-invariants.mjs`）：

```
[群组不变量守卫] 62 条断言全部通过;4 项 TODO 缺口已登记(不阻断 CI,见上);1 项已裁定例外(2026-10-26 裁定,勿当 bug 修)
```

| 类别 | 内容 |
|---|---|
| **已通过（G1~G15）** | G1 成员命名空间原样透传 / G2 DLNA 不得入组（后端 kind 校验 + 前端候选过滤）/ G3 起播即落位 / G4 位置基准取真实内容时间线 / G5 单泵（桥侧不得自建选歌）/ G6 换源上限 3 + 负缓存 TTL 统一（`markUnplayable` 读 `negativeTtlSeconds` 配置，默认 2 小时）/ G7 延迟补偿不进 ring 的 `tsUs` / G8 watchdog 走 `qc.resumeActive` / G9 tick 埋点字段仍在 / G10 延迟参数域 ±30s·步进 10·单一源（**v4.8.0 改钉成员级取值口**）/ G11 延迟写路径只走 `delayCalib`（**createGroup 禁播种，成员级默认 0**，不经 `PlayerGroup` 实体与 `persist`）/ G12 重复成员：全量口 `throw`、增量口 `no-op`（语义刻意分叉）/ **G12b** `setMembers` 必须自带重复判定且早于差集过滤（变异 32 条）/ **G13 延迟补偿按成员（v4.8.0）**：取值口按成员 id 查表不串格（`bridgeAnchorShiftUsOf(groupName, deviceId)` / `sendspinDelayUsOfClient`）、select 必须列 `member_delays_json`、写路径落库、**桥内锚点恒 0（G13-b）**、PUT 重建条件覆盖、`trackLeadMs` 隐藏口 / **G14 可听前 BUFFERING 瞬态（v4.8.1）**：`audibleStarted` 声明/复位/置位 + `pollCore.buffering` + 四处映射 + fork 兜底（9 条）/ **G15 预取完整性三闸（v4.8.3）**：`attemptOnce` 上游截断对账（`TRUNCATION_TOLERANCE = 0.9`，实收 < 90% ⇒ stalled）+ 判官硬算术下界（`PREFETCH_HARD_MIN_BYTES_PER_SEC = 4000`，装不下期望时长 ⇒ `too-small-hard`） |
| **TODO 缺口（4，不阻断 CI）** | G1「`airplay:`/`sendspin:`/`dlna:` 前缀常量只有一处定义」、G3「`castLanding.applied` 语义」的命名、G4「位置基准必须取 `contentClock`」、G9「`stats` 的 `w=`/`m=`/`clock=`/`delta` 四字段」。**四条的共同点：都是旧文档口径与现状不符**（这三个名字在代码里不存在，见 §5.1 术语纠偏与附录 B-1/B-3）；守卫的处置是「登记缺口、要求产品侧确认后再改埋点，不由守卫凭空造」 |
| **已裁定例外（1）** | G3：**DLNA 路径**的「先起播再校准 seek」属既定例外；AirPlay 路径仍必须把起点经 `startMs`/`seekSec` 一次编入 |

> ✅ **已挂 CI（2026-10-26）**：守卫不再是「只能手动跑」。`.github/workflows/ci.yml` 里新增了 **`group-invariants-guard`（第 26 个 job）**，位置在 `workflow-paths-guard`（`ci.yml:345`）之后、`audio-output-format-guard`（`ci.yml:372`）之前，step 体就一句 `node backend/scripts/check-group-invariants.mjs`（`ci.yml:362`，仓库根为 cwd，零依赖 node 脚本、只剥注释读源码文本）。文件头守卫清单已补到第 26 条（`ci.yml:110`），第 25 条桥接守卫同步从 14 条更新为 **17 条（⑮⑯⑰）**（`ci.yml:95`、`:107`）。
>
> **不要**再往 `backend/package.json` 加 npm script：CI 直接 `node` 调用，多一层包装只会多一处可能与守卫文件路径脱钩的入口；本地复跑同一句命令即可。`backend/package.json:18` 的 `test:coverage:airplay` 覆盖 `tests/airplay` + `tests/group`，那是**用例覆盖**，不是静态守卫；两者不能互相替代（一处断代码契约、一处断测试覆盖）。

### 10.2 清单底稿（G1~G9）：设计意图与破坏后果

> 本节写于守卫落地前，「现状保护」列当时的取值多为「无守卫」；**实际状态一律以 §10.1 为准**。本表保留价值在「为什么需要这条守卫 / 破坏后会怎样」。

| ID | 不变量 | 钉法建议 | 现状保护（落地前口径） | 破坏后果 |
|---|---|---|---|---|
| **G1** | 成员命名空间**原样透传**：提交、存储、比对三处都必须是整串 | 断言 `applyMemberDelta` 内存在 `removeSet` 精确比较且**不得**出现 `splitMemberId(...).id` 参与成员比对 | 无守卫；仅前端构造正确（`index.vue:952-969`） | 成员删不掉（§8.6） |
| **G2** | DLNA **不得**入组：`assertMembersAvailable` 的 dlna 分支必须 `throw` | 断言该函数内 `kind === "dlna"` 后紧跟 `throw`（正则钉 `DLNA 设备不支持加入群组`） | 无守卫 | 组内出现无共享时间线的成员 |
| **G3** | **起播即落位**：`playMedia` 里起点必须经 `seekSec` 进 cast，不得出现「先 cast 后 seek」 | 断言 `airplay/protocolPlayer.ts` 的 `playMedia` 内不含 `seekAirPlay(` 调用 | 无守卫 | HiVi 第二次 RECORD 挂死（真机 12s） |
| **G4** | 组位置基准取**内容时间线**：`audiblePositionMs` 必须是 `pushed − (cursor − now)` 形态并有 floor/pushed 双向夹取 | 钉 `streamEngine.ts` 该函数的三处边界 | 无守卫 | 开播显示 00:10、位置漂移 |
| **G5** | **单泵、无第二条选歌路径**：桥侧不得出现取流/选源调用 | 断言 `airplay/bridgeSession.ts` + `bridgeChannel.ts` 不含 `fetchWholeSong\|resolvePreferredSong\|spawnDecoder` | 无守卫 | 绕过预取/判完整/跳过 |
| **G6** | 组内换源**上限 3** + 负缓存 TTL 统一（`markUnplayable` 读 `negativeTtlSeconds` 配置、默认 2 小时，`MARK_UNPLAYABLE_TTL_MS` 废除） | 钉 `PREFETCH_MAX_ALT_SOURCES === 3`、`NEGATIVE_TTL_DEFAULT_MS === 2h`、`markUnplayable` 走 `negativeTtlMs`、`MARK_UNPLAYABLE_TTL_MS` 全仓 0 处 | G6（check-group-invariants，5 条） | 无限换源 / 两套 TTL 再度分叉 |
| **G7** | **ring 的 tsUs 不被偏移污染**：`dspDelayUs` 只能出现在 `sendAudio(ts + dspDelayUs, ...)`，不得写进 ring 条目 | 断言 `pushFrame` 入 ring 的 `tsUs` 表达式不含 `dspDelayUs` | 无守卫 | 改延迟后回填错位、桥窗口漂 |
| **G8** | watchdog 恢复走**统一起播路径**：必须 `qc.resumeActive(groupId, baseUrl)`，不得自己拼 cast | 钉 `watchdog.ts` 内存在 `resumeActive(` 且不含 `castToAirPlayDevice(` | 无守卫 | 恢复路径与正常路径语义分叉 |
| **G9** | `airplay-bridge` `stats` **字段保留**：`ev/dev/gen/state/clock/queueMs/late/realigned/driftUs/deltaUs/deltaP95Us/samples/anchorUs/leadUs` 不得删改 | 钉 `bridgeSession.ts` 的 `emitStatsTick` 字段集（字段被删会让排障判据集体失效） | 无守卫 | §9 的判据全部不可用 |

**优先级建议**：G3、G5、G7 是「静默错」（不报错但听感/时间线错），应先钉；G1、G2 是边界拒收，风险中等；G4、G8、G9 属结构性保护。

---

## 11 踩坑录（被推翻的旧结论）

### 11.1 「DLNA Stop 会误杀同 host 的 AirPlay 输出」

- **旧结论**：DLNA 与 AirPlay 是同一台物理设备的两个身份，可以随便分别控制。
- **现实**：同 host 下对 DLNA 下 Stop / 音量会连带影响该 host 的 AirPlay 输出。现行缓解：① AirPlay 音量优先走**同 host 的 DLNA RenderingControl 转发**，避免两条控制链互相打架（`airplay/control.ts:543-545` 的 `dlnaPeerOfAirPlay` 分支 + `setAirPlayVolume` `:1177`）；② 桥占用设备与 native cast **互斥**，owner=bridge 时直接拒绝 native cast（`control.ts:836-839`）。
- **教训**：控制链的「同一台设备两个身份」必须先判定身份归属，再选控制通道。

### 11.2 「桥恒晚 sendAhead」

- **旧结论**：桥收到的 tsUs 可以直接当可听时刻用。
- **现实**：ring 的 tsUs 是**内容时间线**，比墙钟超前一个预填深度（240 实测 10.584s）；直接把 cursor 域 ts 投给桥 ⇒ 指令超前 10.584s ⇒ 桥队列撞 8s 硬上限 ⇒ 重连风暴。
- **现行口径**：交付时 `ts' = ts − commonSendAheadUs()`，且投递窗口按**原始 ts 域** `[now + FLOOR + ahead, now + HORIZON + ahead]` 判定（等价于换算后域整体 +ahead）—— 注释特别写明「若窗口仍按原始 ts 判定、交付时再减 sendAhead，首帧 ts' 会落到 now+1.0s < RAOP 可达线 now+1.05s ⇒ 必然 self-anchor 2.5s」（`server.ts:790-795`）。
- **教训**：域变换只能做一次，且要在同一次判断里完成。

### 11.3 混组 anchor lead：从 `min(sendAhead, 800ms)` 抬到 1.75s（契约反转）

- **旧契约**：混合组为了「直连成员时间线零跳变」，让 lead 回落 800ms 截断。
- **新契约**：混合组必须抬到「桥投递下沿 + 一个补投周期」= 1.75s，否则每首歌开头丢 1s（真机 2026-10-26）。
- **代价被显式接受**：每首歌起播多等 ~1.25s，全组一致；**仍不是** cold 深锚 4.5s，因为直连 esp32 不承受秒级跳变（`streamEngine.ts:879-885`）。
- **教训**：这里两个目标（直连零跳变 / 桥不丢头）本质冲突，最终选择了「等得起，不能丢」—— 这类取舍必须写进文档，否则下一个人会「优化」回去。

### 11.4 跨口径对比作废

- **旧做法**：拿「会话起始时刻差」「首包时间差」当 A/V 偏差证据。
- **结论**：全部作废。有效的只有：同一域内的差值（`deltaUs`）、尾窗互相关、以及 `pos ≥ 定格值 − TOL` 这类相对量判据（§9.3 反模式表）。
- **教训**：先声明「这个数值属于哪个时钟域」，再决定能不能相减。

### 11.5 顺带记两条「注释与代码不一致」的历史残留

| 残留 | 现状 | 证据 |
|---|---|---|
| 延迟范围注释写 ±2000，常量是 ±30000 | ✅ 已修复（注释已改成 ±30000）；口径始终以常量为准 | `delayCalib.ts:3`、`:41` vs `:20-21` |
| 旧文档里的 `resync` / `clamped` 字段名 | 现行 `stats` 用 `realigned` / `late`，没有 `clamped` | `bridgeSession.ts:642-658` |

---

## 12 代码地图

### 12.1 行为 → 文件:函数（≈行号）

> 行号为 **2026-10-27 基线 v4.8.1（`191c19b`）实测**（`index.ts` / `protocolPlayer.ts` / `delayCalib.ts` 178 行——v4.8.0 重写为按成员）。函数体长短会随修复变化，**函数名是稳定锚点，行号是快照**——对不上时以函数名为准，顺手更新本节。函数体长短会随修复变化，**函数名是稳定锚点，行号是快照**——对不上时以函数名为准，顺手更新本节。

| 要查的行为 | 位置 |
|---|---|
| 组成员模型 / 增删 / 持久化 | `services/group/index.ts:GroupManager`（`:98` Map、`:165` createGroup、`:216` setMembers、`:239` applyMemberDelta、`:268` deleteGroup、`:387` persist） |
| 成员 id 解析（命名空间） | `services/group/index.ts:31 splitMemberId`（`:49` 裸 id ⇒ dlna） |
| 成员在线判定（单一真相源） | `services/group/index.ts:299 resolveMemberStates` → `:303 resolveMembers` → `:322 resolveSendspinMember` |
| 成员合法性校验（DLNA 拒收，**只作用于新加入的差集**） | `services/group/index.ts:361-385 assertMembersAvailable`（`:366` 重复判定、`:382-383` dlna 抛错）；调用点 `:167` 全量、`:228` 只校验 `newOnes`、`:260` 只校验 `added` |
| owner 权限（admin 恒真） | `services/group/index.ts:140 isOwnedBy` |
| 组起播路由决策 | `services/group/protocolPlayer.ts:313 playMedia`（路由快照 `:322-324`、`activeBridgeRoutes.set` `:342`） |
| 桥路由准备/拆除/登记 | `services/group/protocolPlayer.ts:289 prepareBridgeRoute`、`:278 teardownBridgeRoute`、`:25 activeBridgeRoutes` |
| 桥成员加入/摘除 | `services/group/protocolPlayer.ts:38 bridgeJoinMember`（泵侧 sync 失败回滚 `:56-67`，throw `:66`）、`:74 bridgeLeaveMember`、`:99 rebuildBridgeRoutes` |
| 传输指令扇出（含 setVolume 例外） | `services/group/protocolPlayer.ts:226 fanOut`（桥占用过滤 `:234`、setVolume 例外 `:235-243`）、`:265 spinOp` |
| 桥路由泄漏兜底（D1） | `services/group/protocolPlayer.ts:346-361`（全成员 cast 失败 ⇒ `:354` 先 `teardownBridgeRoute()`、异常只 warn，`:360` 再抛原始错误） |
| 组成员分组（dlna/airplay/spin） | `services/group/protocolPlayer.ts:138 splitGroupMembers` |
| 在线集合 | `protocolPlayer.ts:155 getOnlineSendspinIds`、`:168 getOnlineAirplayIds`、`:207 getOnlineMemberIds` |
| leader | `protocolPlayer.ts:182 getGroupLeader`、`:219 getGroupLeaderDeviceId` |
| 组状态派生 | `protocolPlayer.ts:397 pollState`、`:443 getGroupStatus` |
| 桥孤儿对账 | `protocolPlayer.ts:517 startBridgeRouteReconciler`、`:544 reconcileBridgeRoutesOnce`、`:596 reapOrphan`（调用点 `:564`/`:582`） |
| 悬挂/恢复 | `services/group/watchdog.ts:44-119 runGroupWatchdogTick`（悬挂 `:71-81`、恢复 `:82-112`） |
| 延迟读写/缓存/映射（v4.8.0 按成员） | `services/group/delayCalib.ts`（178 行）：`:77 getMemberDelays`（返回新建对象）、`:97 getMemberDelayMs`、`:113 setMemberDelay`（内存先更新再落库）、`:102 getTrackLeadMs`、`:51 clampGroupDelayMs`、`:58 parseMemberDelays` |
| HTTP 接口 | `routes/api/groups.ts`（`:24` GET 列表、`:32` POST、`:47` PUT、`:84` 增量成员、`:107` GET delays、`:124` PUT delays、`:158` DELETE） |
| 设备侧成员对齐 | `routes/api/shared.ts:670 alignGroupMembers` |
| 组 PCM 生产 | `services/sendspin/streamEngine.ts:699 pushLoop`、`:692 audiblePositionMs`、`:886-893` 起播 lead |
| 组公共 send_ahead | `services/sendspin/group.ts:76 computeCommonSendAhead`、`:47 DEFAULT_MIN_BUFFER_MS` |
| sendspin 下发（含组延迟） | `services/sendspin/server.ts:1479`（逐拍）、`:1607-1610`（迟到回填）、`:433 groupDelayUs`、`:1387 sendspinDelayUs` |
| 桥投递（窗口化） | `services/sendspin/server.ts:784 backfillBridge`、`:826 ensureBridgePushTimer`、`:842 bridgePushTick`、`:868 deliverBridgeWindow`、`:899 onBridgeHandleRemoved`、`:905 onBridgesCleared` |
| 桥投递参数 | `services/sendspin/constants.ts:79/85/88/96/98` |
| 桥帧协议 / socket | `services/airplay/bridgeChannel.ts`（头 `:1-16`、`FRAME_TYPE` `:36`、`encodeFrame` `:58`） |
| 桥会话（锚点/推流/统计） | `services/airplay/bridgeSession.ts:496 maybeBeginStream`、`:198 planBridgeAnchor`、`:622 emitStatsTick` |
| 桥锚点数学 | `services/airplay/bridgeMath.ts:76 computeBridgeAnchors`、`:132 bridgeStartLeadUs`、`:37(rates) BRIDGE_WARM_START_LEAD_US` |
| 桥准备（含组延迟注入） | `services/airplay/control.ts:296 bridgePrepareDevice`、`:319 anchorShiftUs` |
| 起播即落位 | `services/airplay/protocolPlayer.ts:31 playMedia`、`control.ts:173 withPlaybackOffset`、`:554 setStartPosition`、`:826 castToAirPlayDevice` |
| 音量控制链 | `services/airplay/control.ts:1177 setAirPlayVolume` |
| 队列推进/跳过 | `services/player/QueueController.ts:962 playCurrent`、`:854 judgePlayable`、`:417 resumeActive`、`:1138` 时长解析 |
| 预取与判官 | `services/source/prefetchCache.ts:166 judgePrefetchedBuffer`、`:477 attempt`、`:605 listPrefetchCandidates` |
| 换源验活 | `services/source/preferredSource.ts:34 resolvePreferredSong` |
| 负缓存 TTL | `services/source/online/streamFallback.ts:58-65`、`:537 markUnplayable` |
| 前端群组页 | `frontend/src/views/Groups/index.vue`（候选 `:940-975`、延迟 UI `:454`/`:490`/`:714`/`:1051`/`:1062`/`:1085`） |

### 12.2 表 → 代码

`player_groups` `db/schema.ts:366-382` · `group_queues` `:384-396` · `sendspin_device_state` `:518-530` · 延迟列迁移 `db/index.ts:790-808`。

---

## 附录 A 常量速查

| 常量 | 值 | 位置 |
|---|---|---|
| `DEFAULT_GROUP_VOLUME` | 20 | `services/group/index.ts:50` |
| `GROUP_NAME_MAX` | 50 | `services/group/index.ts:88` |
| `GROUP_DELAY_MIN_MS` / `MAX` | -30000 / 30000 | `services/group/delayCalib.ts:23-24` |
| `GROUP_DELAY_STEP_MS` | 10 | `delayCalib.ts:26` |
| watchdog `TICK_MS` | 10_000 | `services/group/watchdog.ts:17` |
| `BRIDGE_RECONCILE_GRACE_MS` | 55_000 | `protocolPlayer.ts:481` |
| 对账间隔 | 60_000 | `protocolPlayer.ts:484` |
| `BRIDGE_PUSH_TICK_MS` | 250 | `sendspin/constants.ts:79` |
| `BRIDGE_PUSH_HORIZON_US` | 2_500 * 1000 | `sendspin/constants.ts:85` |
| `BRIDGE_PUSH_FLOOR_US` | 1_500_000 | `sendspin/constants.ts:88` |
| `BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US` | 1_750_000 | `sendspin/constants.ts:96` |
| `BRIDGE_BACKFILL_MAX_US` | 6_000_000 | `sendspin/constants.ts:98` |
| `DEFAULT_MIN_BUFFER_MS` | 800 | `sendspin/group.ts:47` |
| `BRIDGE_WARM_START_LEAD_US` | 2_500_000 | `airplay/rates.ts:37` |
| `FRAME_HEADER_SIZE` / `MAX_PAYLOAD_BYTES` | 28 / 1 MiB | `airplay/bridgeChannel.ts:32-34` |
| `STREAM_BUFFER_HEAD_WAIT_MS` | 8000（env 覆盖上限同值） | `routes/rest/index.ts:2104`、`:2116` |
| `PLAYABLE_TTL_DEFAULT_MS` | 1h | `streamFallback.ts:58` |
| `NEGATIVE_TTL_DEFAULT_MS` | 2h（2026-10-27 统一，原 45s；`negativeTtlSeconds` 插件配置可覆写） | `streamFallback.ts:59` |
| `TRANSIENT_BACKOFF_DEFAULT_MS` | 5s | `streamFallback.ts:60` |
| `TRUNCATION_TOLERANCE` | 0.9（上游截断对账容差，实收 < cl×0.9 ⇒ stalled） | `bufferedFetch.ts` |
| `PREFETCH_HARD_MIN_BYTES_PER_SEC` | 4000（32kbps 地板，判官硬算术下界） | `prefetchCache.ts` |
| `PREFETCH_MAX_ALT_SOURCES` | 3 | `prefetchCache.ts:96` |
| `PREFETCH_ENTRY_TTL_MS` | 10min | `prefetchCache.ts:98` |
| `PREFETCH_INTEGRITY_DELTA_SEC` | 15 | `prefetchCache.ts:109` |
| `PREFETCH_INTEGRITY_DELTA_SEC_BITRATE` | 80 | `prefetchCache.ts:119` |
| `PREFETCH_MIN_AUDIO_BYTES` | 64 KiB | `prefetchCache.ts:111` |
| `PREFETCH_BUDGET_RATIO` | 0.5 | `prefetchCache.ts:89` |
| `PREFETCH_ASSUMED_BYTES` | 30 MB | `prefetchCache.ts:91` |
| cast 超时 | 30s | `QueueController.ts:1079-1095` |
| 判可播超时 | 10s | `QueueController.ts:1015-1020` |

---

## 附录 B 文档推断被代码推翻的点

> 本表记录「设计文档/口头约定/历史报告里的说法」与当前代码不符之处。**一律以代码为准。**

| # | 文档/旧结论的说法 | 代码事实 | 结论 |
|---|---|---|---|
| B-1 | 组泵有一条叫 `contentClock` 的对象，成员位置基准取 `contentClock`（旧称，代码中不存在） | 全仓 grep `contentClock` / `contentSec` / `contentEpoch` **零命中**。实际符号：桥侧首帧 `firstFrameTsUs`（`bridgeSession.ts:301-302`、`:402-403`）、锚点 `firstFrameTsUs + anchorShiftUs`（`:209`）、组内时间戳基线 `deliveredByGroup + jumpUs`（`sendspin/server.ts:1454-1467`）、位置深度 `cursorUs − nowUs()`（`streamEngine.ts:692-697`） | 「取 contentClock」的正确落地 = 取**组内时间戳基线**而非会话时长；代码里没有这个名字，写文档必须双写真实符号（见 §5.1 术语纠偏） |
| B-2 | 桥侧有一个类叫 `BridgeRing` | 仓库内**不存在** `BridgeRing`。等价物是组泵的 ring 容器 `recentByGroup`，键为 `encoderKey("pcm", 100)` | 谈「桥读 ring」时指 `server.ts:787` 的 `recentByGroup` |
| B-3 | cast 结果里有 `castLanding.applied` 字段，语义 = 起点真编进这次 cast 且 cast 成功（旧称，代码中不存在） | 仓库内**不存在** `castLanding`。现行实现：`seekSec` 进 `AirPlayCastOptions` → `withPlaybackOffset` 注入 `timeOffset` → `player.setStartPosition(seekSec)`；`castToAirPlayDevice` 返回 `{mediaUri}`，**不返回落位标志** | 判「落位是否生效」只能靠：①请求里 `seekSec` 存在 ②`[AirPlay][cast] ... seek=Ns` 日志 ③起播后位置 ≈ 目标值（`control.ts:492`、`:515`、`:554-556`、`:826-845`） |
| B-4 | 组状态在桥播放期间恒 STOPPED/位置 0 是「组不支持」，需专门字段 | 已在代码中修掉：桥占用且组内有 sendspin 时从组泵派生（`protocolPlayer.ts:379-406`、`:437-452`） | 该问题**已关闭**，不要按旧文档判断 |
| B-5 | 延迟补偿范围 ±2000ms | 常量是 ±30000ms；早期 ±2000 只出现在过时注释里，**注释已于 2026-10-26 改为 ±30000**（`delayCalib.ts` 文件头与 `clampGroupDelayMs` docstring） | 以 ±30000 为准 |
| B-6 | 桥 `stats` 有 `resync` / `clamped` 字段 | 现行字段：`late`（=`bridgeLateCount`）、`realigned`、`driftUs`、`deltaUs`、`deltaP95Us`、`samples`、`anchorUs`、`leadUs`、`queueMs`、`maxQueueMs`、`state`、`gen`、`clock`。**没有** `resync`，**没有** `clamped` | 排障按 `bridgeSession.ts:642-658` 的字段集 |
| B-7 | 组成员可以包含 DLNA | 2026-10-24 起禁止：`assertMembersAvailable` 直接抛错（`index.ts:382-383`），DLNA 仅历史数据可解析；2026-10-26 起该检查**只作用于新加入的差集**（历史 DLNA 成员不再让整组锁死，见 §1.4） | 见 §1.4 |
| B-8 | 客户端可以只传裸 deviceId，服务端会自动补前缀 | 不补。成员比对是整串精确匹配（`index.ts:247-249`、`:253`），裸 id 的 remove 是静默 no-op | 见 §1.3、§8.6 |
| B-9 | 混合组 lead 可以沿用 800ms 截断（「为了直连零跳变」） | 已被推翻：混合组固定 1.75s（`streamEngine.ts:886-889`），因为 800ms < 桥窗口下沿 1.5s ⇒ 每首开头丢 1s | 见 §7.1、§11.3 |

---

## 附录 C 发现的代码缺陷 / 口径不一致（逐行状态列为准）

| # | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| C-1 | `services/group/delayCalib.ts` vs `GroupManager.persist` | `setMemberDelay` 直接 `db.update(player_groups)` 写 `member_delays_json`，绕过 `GroupManager.persist` | ✅ **已随 v4.8.0 消除**：`PlayerGroup` 实体上的延迟字段已删除（只剩 JSON 列），不存在第二个可读脏值的内存镜像；读路径全部走 `delayCalib` 缓存 | 无 |
| C-2 | `services/group/index.ts:227-237` | `applyMemberDelta` 对「remove 一个不在组内的 id」静默 no-op（不报错、不回执），`add` 已在组内同样静默 | 客户端若剥前缀，移除会**静默失败**，与历史 bug 同症状 | 返回 `ignored: string[]`；或 remove 未命中时 warn 日志 |
| C-3 | `services/group/delayCalib.ts:3`、`:41` | 注释写「范围 ±2000 / 钳制到 ±2000ms」，常量实际 ±30000（`:20-21`） | 注释误导，易被当真相引用 | ✅ **已修复（2026-10-26）**：`:3` 与 `:41` 均已改为 ±30000 |
| C-4 | `services/group/watchdog.ts:89` vs `services/group/protocolPlayer.ts:427`/`:445`/`:455-456` | watchdog 判「已在播则跳过恢复」用的是 `state === "PLAYING" \|\| state === "PAUSED_PLAYBACK"`，而 `getGroupStatus` 只产出 `PLAYING` / `PAUSED` / `STOPPED`（`PAUSED_PLAYBACK` 是 DLNA 设备口径，不是组口径） | **`PAUSED` 分支永不命中**：用户手动暂停后成员回归，恢复流程仍会跑 `resumeActive` + `alignDeviceToPosition`，可能与用户的暂停意图冲突 | 组口径统一为 `PAUSED`；或在 `getGroupStatus` 里对 DLNA leader 保留 `PAUSED_PLAYBACK` 并同步两处 |
| C-5 | `services/sendspin/server.ts:852-853` | `bridgePushTick` 的 per-bridge 循环内，拿到空 ring 时用 `return`（应是 `continue`） | 语义上等价（ring 对所有桥相同），但会让「后续桥」在本轮被跳过；也与「单桥失败不连累其他桥」的注释风格不一致 | 改 `continue`，或把 ring 取到循环外但仍留在 try 内 |
| C-6 | `routes/api/groups.ts` | ~~PUT 先读库再判存在~~ | ✅ **已随 v4.8.0 消除**：现行 PUT（`:129-188`）先判 `gm.get(id)` 存在（404），再 `getMemberDelays(id)[memberId]` 取 before | 无（已落地） |
| C-7 | `backend/scripts/check-group-invariants.mjs` | ~~群组维度零守卫~~ | **已关闭（2026-10-26）**：`check-group-invariants.mjs` 覆盖 G1~G13（含 G12b）共 48 条断言（v4.8.0 起 G10/G11 改钉成员级 + 新增 G13） + 4 项 TODO 缺口登记，已挂 `ci.yml` 第 26 个 job（`group-invariants-guard`，`ci.yml:356/362`）。剩余的 4 项命名类缺口见 §10.1「TODO 缺口」行，属产品侧确认后再改埋点 | 无（已落地）；新增群组不变量请在该脚本里加 G 编号，不要另起脚本 |
| C-8（✅ **已修复（v4.7.x 暖复用）**） | `services/group/protocolPlayer.ts:320-324` | **每首歌无条件拆建桥路由**：`playMedia` 里先 `await teardownBridgeRoute()`（`:321`）再 `prepareBridgeRoute(apOnline)`（`:324`）—— 切歌并不改变成员构成，但每次都要 TEARDOWN + 新 SETUP | ①切歌时多一次桥会话重建（AirPlay 侧听感为一次重锚/短暂静默）；②新会话必然走一次 `pushInitialVolume(player, deviceId)`（`bridgeSession.ts:374`）**重推音量**；③放大单会话设备（HiVi）二次 RECORD 挂死风险 | 建议：成员集合与桥参数未变时复用既有桥路由，仅在「成员变化 / 延迟变化 / 锚点不可达 / 健康检查失败」时重建。**已修复（v4.7.x）**：`routeReusable` 判据（`group/protocolPlayer.ts:437-443`）—— spinOnline>0 且既有路由与目标一致时沿用旧路由与 token，不再每首拆建；守卫 G13「桥路由暖复用」两条断言钉死。保留本行记录历史根因 |
| C-9（待排期） | 全仓 | 成员命名空间前缀字面量**散落 30+ 处**（`services/playerRate.ts:296/316/317`、`services/player/QueueController.ts:34/36/37`、`services/playTarget.ts:74`、`services/dlna/announce.ts:51/74/78`、`services/peer.ts:664-667`、`services/sendspin/playerCore.ts:71`、`routes/api/peers.ts:309` …），没有单一常量源 | 改前缀/加 kind 时要逐处改，漏一处就是静默不匹配（历史 bug 同族） | 建议抽 `MEMBER_NAMESPACE` 常量并全量替换；因涉及 player/airplay/dlna/peer 四层且部分串被守卫正则钉定，需独立 change-set + 守卫同步更新，不宜与本次群组改动混做 |
| C-10（**已修复（commit 前）**） | `services/airplay/childMain.ts:119-130` | **修复前**：子进程 `setVolumeDb` 只调 `runtime.setVolumeDb(deviceId, db)`，作用面是 **native runtime**（`sessionRuntime` 的会话表）；桥占用设备的会话在 `BridgeSessions` 里、**不在** runtime 表中 ⇒ 播放中改音量对桥设备恒落空 | **修复后回落链（现行代码）**：主进程 `control.ts:1226 applyVolumeDb` → `rpcFireAndForget(supervisor,"setVolumeDb",{deviceId,db})`（`control.ts:1228`）→ 子进程 `childMain.ts:119-130`：先 `runtime.setVolumeDb(...)`（`sessionRuntime.ts:372` 返回 **boolean**）取 `ok`（`:127`），`ok===false` 时 `bridgeSessions.setVolumeDb(deviceId, db)`（`:128`）→ `BridgeSessions.setVolumeDb`（`bridgeSession.ts:833-838`，遍历会话 `s.setVolumeDb(db)` `:836`）→ `BridgeSession.setVolumeDb`（`bridgeSession.ts:773-778`）→ `this.player?.setVolumeDb(db)`（`:775`） | **状态**：播放中音量变更已能落到桥 player；设计说明见 `bridgeSession.ts:770` 的注释。桥侧仍只在会话建立时 `pushInitialVolume`（`:374`，重连路径另一次 `:586`）拿初始音量 —— 那只是「建会话时对齐一次」，不再限制播放中变更 |

---

## 附录 D 一分钟排障决策树

```
组播不出声
├─ 有 sendspin 成员吗？
│   ├─ 有 → 看 [airplay-bridge] tick 是否存在
│   │        ├─ 不存在 → 桥没建起来：查 [group][bridge] prepare 失败 → 该台应回落 solo cast
│   │        │            若「状态正常但没声」= MAJ-07 被破坏（protocolPlayer.ts:337-341）
│   │        └─ 存在 → 看 gen / deltaUs / late / queueMs
│   │                 ├─ late 持续涨 → lead 不足（§7.1）
│   │                 ├─ queueMs 贴上限 → 投递过猛（回退到窗口化逻辑）
│   │                 └─ 都正常但 AirPlay 无声 → 查 initial volume / setVolume 扇出（§8.3）
│   └─ 没有 → 纯 cast 路径：查每台 [AirPlay][cast] seek=? / 30s 超时
└─ 组状态不对（位置 0 / 恒 IDLE / 恒 STOPPED）
    ├─ 恒 IDLE 且连跳 → 是否走了 BUFFERING 之外的路径（§8.1）
    ├─ 位置 0 → leader kind 是什么？桥占用 airplay 必须从泵派生（§8.5-A）
    └─ 恒 STOPPED → 同上；再查 activeBridgeRoutes 是否登记（对账器会摘孤儿）
```

---

*（本文档为纯文档产出，未修改任何代码。事实基线见文首「代码基线」；如代码变动，请以 `文件:行号` 重新核对后更新本文。）*
