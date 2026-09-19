# MusicFlow 进程模型与隔离规划

> 2026-09-19 起草。基于对 `backend/src` 的全量实测（`spawn`/`fork`/`execFile` 调用点、
> 各服务的事件循环占用、原生 addon 使用点），不是凭印象推演。
>
> 相关文档：`docs/sandbox-limits-and-plan.md`（插件沙箱限制与 P3 规划）、
> `SPEC.md` §1.3（批量任务子进程红线）。
>
> **落地状态（2026-09-19，随 v3.0.39 发布）**：
> - §4 的两步主干已落地 —— 通用层 `backend/src/services/rendererHost/` 就位，Sendspin 已迁移
>   （行为不变，靠既有 39 文件 / 221 用例守），AirPlay 已接入同一宿主；
> - §3 B1（AirPlay 进程化）**代码就位但默认关闭**：开发机无 AirPlay 设备可端到端验证，
>   故先只把能力接上，显式 `MUSICFLOW_AIRPLAY_FORK=1` 才启用；真机验证后可把
>   `services/airplay/mode.ts` 的 `defaultFork` 翻成 `true`，与 sendspin 对齐；
> - §7 两项（fork 冒烟测试 / 静态守卫）**均已落地**；守卫为
>   `backend/scripts/check-renderer-host.mjs`（CI job `renderer-host-guard`）；
> - §5 的两项低成本项（`reanchors`/`maxGapMs` 可观测化、supervisor 冒烟测试）**均已完成**；
> - **部署不在本规划范围**（用户 2026-09-19 明确「以后都不用管部署」），本文档不涉及
>   主实例的发布/部署步骤；
> - §0/§1/§3/§4 的**代码行号已于 2026-09-19 随重构校正**（附录保留起草时的快照，刻意不改）；
> - 逐条状态见 §5 路线图。

---

## 0. 结论速览

| 处置 | 项目 | 一句话理由 |
|---|---|---|
| **保持**（已进程化） | Sendspin 运行时（常驻 fork） | 25ms 硬实时节拍，已隔离 |
| **保持**（已进程化） | 批量任务（一次性 fork） | 内存峰值＋不可信插件代码 |
| **保持**（已进程化） | ffmpeg 解码/转码子进程 | CPU 天然出进程 |
| **已接宿主，待启用** | **AirPlay RAOP 推流** | 7.98ms 节拍＋进程内加密；v3.0.39 起接入 `rendererHost`，默认 in-proc，真机验证后启用 |
| **应下沉 P2** | 封面渲染（sharp） | 原生 addon 在主进程，一次段错误全站挂 |
| **暂缓 P3** | 插件沙箱进程化 | 已被批量子进程削弱，缺实测数据触发 |
| **保留现状** | HTTP/WS 路由、QC/PM 编排、调度器、<br>转码编排、DLNA 拉流、插件交互调用 | 状态密集或 I/O 密集，IPC 化是净损失 |

**一句话**：边界**大体正确**。起草时唯一的真错位是 **AirPlay**（Sendspin 的同类负载却留在主进程），
该错位已于 v3.0.39 接入通用宿主、默认关闭等待真机验证 —— **当前没有「应该动手但没动」的项**，
剩下的 P2/P3 全部带触发条件（等信号）。

---

## 1. 现行进程清单（实测）

```
主进程 node/Hono
├─ HTTP API + WebSocket             I/O 密集
├─ QueueController / PlayerManager  状态密集（编排权威）
├─ dailyScheduler                   仅 setTimeout 重排下一次
├─ 插件沙箱 QuickJS WASM            主线程常驻，内存硬上限 256MB
├─ worker 线程（仅 longRunning）     线程隔离，非进程
├─ **AirPlay RAOP 推流**            ⚠️ 默认在进程内；`MUSICFLOW_AIRPLAY_FORK=1` 时改走子进程
│                                    墙钟节拍 + 进程内 ALAC/加密
├─ sharp 封面渲染                    ⚠️ 原生 addon 在主进程
├─ transcode.ts 编排                 ffmpeg 子进程（≤4 并发闸）
│
├─ fork ─→ 渲染器专属常驻子进程（统一由 rendererHost 托管）
│           ├─ sendspin：WS 38927 / mDNS / 拨号重拨 / ESPHome 6053 桥
│           │            解码 / FLAC·opus 编码 / 推流（25ms 硬实时）
│           └─ airplay：RAOP 推流（7.98ms 节拍）—— 仅当 fork 开关打开
│          （两者的 ffmpeg 均由各自 spawn：每次 seek 重启 / 单次解码）
│
└─ fork ─→ 批量一次性子进程（fork → run → exit，全局 FIFO 只跑 1 个）
            scan / daily-jobs / boot-sync / maintenance
            plugin-job（插件 longRunning 方法实际执行体）
```

关键代码位置：

| 机制 | 位置 |
|---|---|
| 通用渲染器宿主（fork / 握手 / 看门狗 / 退避重启） | `services/rendererHost/supervisor.ts:178`（`fork()` 调用点；import 在 `:21`） |
| 常驻 fork 的业务入口 | `services/sendspin/child.ts`、`services/airplay/child.ts` |
| 模式判定 | 通用 `services/rendererHost/mode.ts::isRendererForkMode()`；业务壳 `sendspin/mode.ts::isForkMode()`、`airplay/mode.ts::isAirPlayForkMode()`（均 leaf，零依赖） |
| AirPlay 宿主接线 | `services/airplay/supervisor.ts`、`childMain.ts`、`sessionRuntime.ts`（纯推流运行时，零主进程态） |
| 批量子进程 | `src/batch/runner.ts`；调用方 `index.ts:279/294/319`、`plugin/jobRunner.ts:38`、`plugin/asyncTasks.ts:43`、`routes/api/index.ts:798`（扫描入口） |
| AirPlay ffmpeg + 节拍 | `services/airplay/decoder.ts:52`（spawn）、`raop.ts:650`（`while` 节拍循环）、`raop.ts:618`（sync `setInterval`） |
| DLNA 拉流 | `routes/rest/index.ts:1755`（字节代理 + Range，无重活） |
| 转码 | `services/transcode.ts`（ffmpeg 子进程 + 并发槽） |
| 封面 | `services/coverImage.ts:29`（`import("sharp")`，32MB 渲染缓存） |

---

## 2. 判定标准

判断「该不该独立进程」，只看四条**收益信号**和四条**成本信号**。命中收益信号 → 进程化；
命中成本信号 → 保留。两边都命中时，看哪边是**不可恢复**的那一类（硬实时掉帧、崩溃带走主进程
= 不可恢复；多一次 IPC = 可恢复）。

### 该进程化（收益信号）

| # | 信号 | 说明 |
|---|---|---|
| G1 | **deadline-driven 循环** | 每 N 毫秒必须完成一次动作，由墙钟裁决；事件循环被占 = 立即掉帧/断音 |
| G2 | **CPU 长时占用 / 内存峰值** | 峰值需归还 OS，或把主进程常驻 RSS 顶上去了 |
| G3 | **不可信或易崩代码** | WASM trap、原生 addon 段错误、第三方二进制 —— 崩溃可隔离、可重启 |
| G4 | **长期常驻且状态可镜像** | 状态能用快照推 + RPC 写表达，不需要主进程高频同步读 |

### 该保留（成本信号）

| # | 信号 | 说明 |
|---|---|---|
| K1 | **状态密集、需要强一致** | 队列语义、播放器注册、DB 事务 —— 拆出去就要分布式一致性 |
| K2 | **高频细粒度交互** | 每首歌数十次调用（插件 search/streamUrl）；IPC 会放大成数量级开销 |
| K3 | **纯 I/O 等待** | fetch/DB/网络，天然异步，占不住事件循环 |
| K4 | **短生命周期 / 低频** | 收益小于 fork 冷启动＋重载引擎的成本 |

### 反模式（明确禁止）

- **为了「统一」而进程化**：把所有插件都塞进进程会同时丢掉 K2 和 K1。
- **用 worker 线程冒充进程隔离**：线程共享进程内存，G2/G3 一条都不满足。
- **进程化后仍让子进程直连 DB**：`SPEC` 已明确「每进程一个 SQLite 连接」，
  Sendspin 子进程刻意复用主进程的配置来源、只在子进程内建表回填，不要反向扩大。

---

## 3. 分类处置

### A. 已进程化且判断正确 —— 保持

**A1. Sendspin 常驻子进程**（业务侧 `child.ts` + `childMain.ts` + `proxy.ts` + `ipcProtocol.ts`；
宿主为 `services/rendererHost/`）

命中 G1（25ms 节拍）＋ G3（`libflacjs` WASM、`@discordjs/opus` 原生 addon 都在子进程内跑）。
状态经快照镜像（150ms 节流 + 1s 兜底扫）、命令走 RPC —— 满足 G4。
**结论：不动。** 注意 `CHANGELOG [3.0.34]` 写的「强制独立子进程」是准确描述。
v3.0.39 已迁到通用宿主，行为不变（sendspin 全套 39 文件 / 221 用例零改动通过）。

**A2. 批量任务一次性子进程**（`batch/runner.ts`）

命中 G2（推荐/扫描/导入的峰值内存随退出归还）＋ G3（外置插件代码不可信）。
满足 K4 的反面：任务本来就长，fork 冷启动可忽略。
**结论：不动。** 这是 `SPEC` §1.3 红线，且是本项目**唯一真正被文档固定下来的**隔离约定。

**A3. ffmpeg 子进程**

ffmpeg 本身就是独立二进制，解码/转码的 CPU 天然在进程外。
**结论：不动。** 主进程侧只剩管道编排（K3）。

> **顺带一个一致性问题**：G1 的真正判据是「deadline-driven」，A2 的批量任务其实**不满足 G1**
> （它是一次性长任务，不是节拍循环）。它进程化靠的是 G2+G3。规划里要把这两类分开表述，
> 否则容易推出「所有长任务都要常驻进程」的错误结论。

---

### B. 进程化候选（B1 已实施、待启用；B2/B3 待触发）

**B1. AirPlay RAOP 推流（P1 —— ✅ 已接入宿主，⏸ 默认关闭）**

| 项 | 事实 |
|---|---|
| 节拍 | `raop.ts:650` `while (this.streaming && !this.destroying)`，每 chunk `CHUNK_LEN`=352 帧（`raop.ts:28`）≈ **7.98ms** |
| 每 chunk 的工作 | JS 手写 ALAC 位打包（`pcm_to_alac_raw` 移植，`raop.ts:105`）＋ `createCipheriv("aes-128-cbc")`（`:213`）＋ RTP 包封装 ＋ socket 发送 |
| 位置 | **默认仍在主进程**；`MUSICFLOW_AIRPLAY_FORK=1` 时整条运行时（节拍 / 编码 / 加密 / 发送）在专属子进程 |
| 已有的自证 | `RaopPlayer.realtimeStats` 暴露 `{chunks, reanchors, maxGapMs, elapsedMs, lossRequests}`；15s 周期打点，`reanchors > 0` 或 `maxGap > 50ms` 升级 `warn` |

这是**与 Sendspin 完全同类的负载**（G1 甚至更紧：7.98ms vs 25ms），起草时留在主进程。
Web API 的一次长阻塞、一次 sharp 缩图、一次批量任务排队，都会直接体现为
`reanchors++` / 真机断音。多设备同时投屏时是 N 条这样的循环并行。

**已实施（v3.0.39）**：复用 §4 抽出的通用宿主，未另起一套。AirPlay 的 RPC 面比 Sendspin 小：
`cast` / `stop` / `stopAll` / `pause` / `resume` / `seek` / `setVolumeDb` / `snapshot`。
DLNA 的 `createCastSession()` 只在**建会话时**由主进程调用（拿到 token 化 streamUrl 后传进子进程），
子进程不碰 DB（`airplay/child.ts` 刻意**不做**数据层 bootstrap —— 它是纯协议推流）。

**为什么默认关闭**：开发机没有 AirPlay 真机。`defaultFork` 若为 `true`，等于把一条**无法端到端
验证**的路径直接推上生产。故与 Sendspin（`defaultFork: true`）不同，AirPlay 走显式开关；
真机验证通过后把 `services/airplay/mode.ts` 的 `defaultFork` 翻成 `true` 即与 Sendspin 对齐。

**启用触发条件（满足任一 → 把 `airplay/mode.ts` 的 `defaultFork` 翻 `true`）**：
1. 多设备同时 AirPlay 投屏时，日志出现 `reanchors` 持续非零或 `maxGap` 抬升；
2. AirPlay 投屏期间 Web API P95 延迟明显抬升（前端可感知的卡顿）；
3. 投屏期间跑批量任务（扫描/推荐）会引发可复现的断音。

（注：这三条原本是「**要不要立项做**进程化」的判据；进程化代码既已就位，现转为
「**要不要默认启用**」的判据 —— 前两条现在可直接从 `realtimeStats` 的 15s 打点里读。）

**B2. 封面渲染（sharp）（P2）**

`coverImage.ts:29` 在主进程 `import("sharp")`。sharp 是原生 addon（libvips）：
命中 G3（一次段错误会带走整个主进程 —— 而封面渲染是**非核心**功能，为它赔上全站可用性不划算）。

但要注意：libvips 内部自带线程池，**它对事件循环的占用（G1/K3）其实很小**，
所以这里的诉求**只是崩溃隔离**，不是节拍隔离。

**⚠️ 一个必须说清的边界**：**worker 线程挡不住段错误** —— 它与主线程共享同一进程、
同一地址空间（这正是 §2 反模式「用 worker 线程冒充进程隔离」所指）。
worker 能真正隔离的只有 **V8 堆**（独立 isolate + 独立 heap 上限）和**事件循环争抢**。
所以本项的收益要如实描述：**下沉 worker ≠ 满足 G3**，它只是让 sharp 的解码内存不再进主 V8 堆；
**要满足 G3（崩溃隔离）必须进程化。**

**建议**：先做 worker（成本低、收益确定：堆隔离 + 事件循环解耦），但**不要把「已下沉 worker」
当成崩溃隔离已解决** —— 一旦真出现段错误，直接跳到 P2' 进程化，不要在 worker 这层反复试。
另需保留现有降级路径（`sharp` 缺失 → 回退原始字节），别把降级逻辑弄丢。
顺带说明现有容错的边界：`coverImage.ts::getSharp()` 的 `try/catch` 只覆盖「**加载失败**」
（`.node` 与运行时 ABI 不匹配等），**覆盖不了「跑起来之后崩」** —— 后者才是真风险。

**B3. 插件沙箱进程化（P3，暂缓）**

已在 `docs/sandbox-limits-and-plan.md` 待办第 11 项记录，原文：
「沙箱替换为可长驻的 worker 进程（彻底解耦 CPU/网络等待，工程量最大）」。

现状评估（2026-09-19）：**不建议现在做**。3 条理由：
1. worker 那层（`SandboxedPluginRemote`）要解决的是 **event loop 阻塞**，线程足够，已解决；
2. 内存隔离已双保险 —— QuickJS WASM 线性内存 `setMemoryLimit(256MB)` 硬上限涨不到宿主堆，
   而「峰值内存归还 OS」的需求已由 A2 批量子进程覆盖；
3. 真要付的代价不小：跨进程 IPC 放大高频 host 调用开销、WASM module 无法共享、
   fork 冷启动要重载 Node + 引擎、每进程一个 SQLite 连接。

**触发条件（满足任一才做）**：
1. 需要 native 崩溃隔离（native addon 段错误 / WASM trap 当前会带走整个进程）；
2. longRunning 批量的峰值内存**实测**顶高主进程 RSS 且降不下来；
3. 跨插件并行要吃到更多核。

---

### C. 保留现状 —— 不动

| 项目 | 命中成本信号 | 说明 |
|---|---|---|
| HTTP API / WS 路由 | K3 | 纯 I/O；拆出去只会多一跳 |
| QueueController / PlayerManager | K1 | 队列语义的**单一权威**，拆了就要分布式一致性 |
| dailyScheduler | K4 | 只是 `setTimeout` 重排下一次，零 CPU |
| transcode.ts（`/rest/stream`） | K3 | CPU 已在 ffmpeg 子进程，主进程只做管道与并发槽 |
| DLNA 拉流（`/rest/dlna/stream/:token`） | K3 | 字节代理 + Range，渲染器自己回连拉；无转码默认路径 |
| 插件交互型调用（search/streamUrl/lyricUrl） | K2 | 每首歌数十次调用，IPC 会放大成数量级开销 |
| 插件 worker 线程（longRunning） | K2/K4 | 目标（不占主线程）已达成，升级为进程是纯成本 |

---

### D. 明确不做

1. **不把「所有渲染器」无差别进程化** —— 只有 G1 命中（Sendspin/AirPlay）才值得。
   DLNA 把字节拉流交给渲染器自己做，天然不占服务端节拍，进程化纯属浪费。
2. **不把 DB（better-sqlite3）拆出去** —— 同步 API + 事务语义，拆出去等于自造分布式事务。
3. **不为「假扫描」造接口式的工作造子进程** —— 无意义负载不加进程。
4. **不在没有实测数据时做 P3** —— 见 B3。

---

## 4. 最关键的一条：抽象通用「常驻渲染器子进程」宿主

B1 和 A1 是**同构**的：都是「常驻子进程 + 快照镜像 + RPC 命令 + 崩溃退避重启 + 心跳看门狗」。
Sendspin 早已把 `supervisor.ts` / `proxy.ts` / `ipcProtocol.ts` 这套写完了。

**如果 AirPlay 直接复制一遍，就等于把最难维护的一块（IPC 契约 + 看门狗 + 退避重启）复制成两份
且开始各自漂移。** 实施顺序（**已于 v3.0.39 完成，见 §5 的 P1 / P1'**）：

1. ✅ 先把 Sendspin 那套**抽出通用层** `services/rendererHost/`（8 个文件）：
   - `supervisor`：fork / mainReady 握手 / 心跳看门狗 / 退避重启 / 优雅 stop；
   - `childHost`：子进程侧的 `req→res` 按 id 回填 + 快照节流 + 心跳 + stop 生命周期；
   - `ipcProtocol`：**通用信封** + 常量（业务载荷用交叉类型承载，消息运行时形状与重构前完全一致）；
   - `mode`：三态 `isRendererForkMode`（child / in-proc / fork，只有默认值不同）；
   - `front`：`createFrontAccessor`（fork→代理、in-proc→真实实例）+ `AssertImplements` 类型哨兵
     + `rpcFireAndForget`；
   - `childBootstrap` / `paths`：子进程数据层装配、子进程入口路径解析（prod `.js` / dev `.ts`）；
   - `index.ts` 顶部写明「**新接渲染器六步清单**」（为 airplay2 / cast / roon 铺路）。
     注：起草时提到的 `playerCore.ts` **并未进通用层** —— 它是 sendspin 的业务实现，不属于宿主。
2. ✅ 让 Sendspin **先切到通用层**（行为不变，靠现有测试守住：`childMain.test.ts` 8 例等）。
3. ✅ 再把 AirPlay 接上去。

**顺序不能颠倒**：先抽象再迁移，比先复制再合并便宜得多（后者要同时改两处已验证的行为）。
实测这条判断成立 —— 迁移 Sendspin 时全套 39 文件 / 221 用例**零改动**通过，等价性有据可依。

---

## 5. 路线图

| 阶段 | 内容 | 触发条件 | 前置 |
|---|---|---|---|
| **P0**（✅ 已完成） | Sendspin fork 隔离；批量子进程；转码并发槽 | — | — |
| **P1**（✅ 已完成，v3.0.39） | 抽通用渲染器子进程宿主 `services/rendererHost/` + Sendspin 迁移 | 已做（纯重构，行为不变） | — |
| **P1'**（✅ 代码就位，⏸ 默认关闭） | AirPlay 接入宿主 | 代码已落地；生产启用需 `MUSICFLOW_AIRPLAY_FORK=1`，真机验证后把 `airplay/mode.ts` 的 `defaultFork` 翻 `true` | P1 |
| **P2** | sharp 下沉 worker 线程（只解耦堆与事件循环，**不满足 G3** —— 见 §3 B2） | 出现一次 sharp 相关崩溃即做 | 无 |
| **P2'** | sharp 升级为进程 | worker 中崩溃仍带走进程（实测） | P2 |
| **P3** | 插件沙箱进程化 | §3 B3 三条触发条件任一命中 | 有实测数据 |

**顺手可做的低成本项**（两项均已于 2026-09-19 第二轮补完）：

- ✅ 把 AirPlay 的 `reanchors` / `maxGapMs` 从「结束才打一行日志」提升为**可观测指标**：
  `RaopPlayer.realtimeStats`（`raop.ts`）→ 进会话镜像 `AirplaySessionMirrorRow.stream`
  → `getAirPlayStatus().stream` 与 `getAirPlayPeerStatus().stream`（HTTP 可直接 curl）；
  另有 15s 周期打点，`reanchors > 0` 或 `maxGap > 50ms` 时升级为 `warn`，趋势在播放过程中
  就可见，不必等收尾。
- ✅ 补 `supervisor` 真 fork 冒烟测试（见 §7）：`tests/rendererHost/supervisorFork.test.ts`（10 例）
  + 夹具 `tests/rendererHost/fixtures/stubRendererChild.mjs`。启用
  `MUSICFLOW_AIRPLAY_FORK=1` 前的两个前提（架构 + 可观测）现在都齐了。

---

## 6. 验收标准

任何一项进程化落地后，必须同时满足：

| # | 标准 |
|---|---|
| 1 | **行为等价**：功能与进程化前逐项对齐（新增/改动的用例写明对照点） |
| 2 | **崩溃可自愈**：kill -9 子进程后，退避重启并在 N 秒内恢复服务（有测试） |
| 3 | **降级可用**：子进程起不来时，要么主进程内降级、要么明确报错，不允许静默半死 |
| 4 | **内存可归**：长跑后子进程退出，峰值 RSS 归还 OS（G2 的核心诉求） |
| 5 | **无 DB 反向依赖**：子进程不新开 SQLite 连接 |
| 6 | **日志同汇**：stdio 继承，`docker logs` 排障路径不变 |
| 7 | **门禁全绿**：`tsc` / 8 项静态检查（含 `check-renderer-host.mjs`）/ 全量 vitest / 前端 build |

---

## 7. 门禁与覆盖补齐（两项均已落地）

起草时的现状：对 7 个 `check-*.mts|mjs` + 8 个 workflow 搜
`spawn|child_process|独立进程|子进程|转码|解码|transcode|ffmpeg|decode` → **0 命中**，
即「重活落独立进程」只是惯例，CI 一行都不拦。两项补齐均已完成（现共 **8 个 check 脚本**，
加 `check-renderer-host.mjs`）：

**① ✅ fork 路径冒烟测试**

`tests/rendererHost/supervisorFork.test.ts`（10 例）+ 夹具
`tests/rendererHost/fixtures/stubRendererChild.mjs`。

关键点：`mode.ts` 见到 `VITEST` 一律 `return false`，所以业务侧测试**永远不可能真 fork** ——
本用例因此**绕开 `isRendererForkMode()`，直接构造 `RendererHostSupervisor` 并指向一个
纯 JS 夹具子进程**。夹具故意用 `.mjs`：`fork()` 直接跑 node，不依赖任何 TS loader，
与 vitest 的 `process.execArgv` 解耦（实测 vitest worker 里 `execArgv` 为
`["--conditions","node","--conditions","development"]`，对 `.mjs` 无害）。
覆盖链：fork → mainReady 握手（断言载荷真的过了 IPC 边界）→ RPC 往返（断言响应里的 pid
就是被 fork 的子进程）→ 快照进镜像 → `kill -9` → 退避重启（新 pid 可继续服务）→ 优雅 `stop`
→ 「启动即退」的失败分支。整套约 3.5s。

**② ✅ 静态守卫 `check-renderer-host.mjs`（CI job `renderer-host-guard`）**

取代了原计划中的 `check-process-isolation.mts`，规则定向到 G1 的**形态特征**而非关键词：

- **R1** `backend/src/services` 下只允许 `rendererHost/supervisor.ts` 出现 `child_process.fork`；
- **R2** 命中「墙钟取时 + `setTimeout` 自排 + 定长分块（`CHUNK`/`FRAME`/`SAMPLE`）」三条全中的
  文件，必须落在**本业务** `child.ts` 的 import 闭包内。判定按
  `backend/src/services/<biz>/` 目录归属做（`bizOf`），不能只判「任一闭包包含」——
  实测 sendspin 的 child 闭包会跨业务拖进 `airplay/raop.ts`，共 135 个文件，
  只判「任一闭包」会让「airplay 谁都没接宿主」蒙混过关；
- **R3** 声明为渲染器业务的目录必须具备 `child.ts` + 使用 `RendererHostSupervisor` 的
  `supervisor.ts` + 使用 `isRendererForkMode` 的 `mode.ts`。

纯关键词扫描（扫 `ffmpeg`/`transcode`）误报偏高 —— `command` 权限本就允许外部命令，
且 DLNA/AirPlay/转码**都合法地**调用 ffmpeg。所以守卫只认「节拍形态」不认目录名；
**DLNA 有意豁免**：字节代理 + Range，渲染器自己回连拉流，实测无节拍循环。

---

## 附：本次核查的证据清单（**起草时快照 —— 行号刻意不随重构校正**）

> ⚠️ 下表记录的是 2026-09-19 起草时的实测位置，用途是保留「当时是怎么核出来的」这层证据，
> 所以**不随后续重构更新**。要看现行位置请查 §1 的「关键代码位置」表；
> 右列仅作对照，方便理解重构把哪些东西搬到了哪里。

| 断言 | 证据（起草时） | 现行位置（对照） |
|---|---|---|
| 主进程侧只有 2 条 fork 线 | `grep -rn "fork(" backend/src` → 仅 `sendspin/supervisor.ts:161`；批量在 `batch/runner.ts` | `rendererHost/supervisor.ts:178`；`src/batch/runner.ts` |
| AirPlay 节拍在主进程 | `airplay/raop.ts:616` `while` 循环 + `:584` sync `setInterval` + `:117` spawn | `raop.ts:650` / `raop.ts:618` / `decoder.ts:52` |
| AirPlay 进程内加密/ALAC | `raop.ts:91`（`pcm_to_alac_raw` 移植）、`:199` `createCipheriv` | `raop.ts:105` / `raop.ts:213` |
| Sendspin 原生/WASM 在子进程 | `sendspin/encoding.ts:20`（`@discordjs/opus`）、`server.ts:160`（libFLAC） | `encoding.ts:20`（未变）/ `server.ts:158`（预热调用点） |
| sharp 在主进程 | `coverImage.ts:29` `await import("sharp")` | 未变 |
| DLNA 无重活 | `routes/rest/index.ts:1755`（Range 字节代理） | 未变 |
| 批量任务全覆盖 | `index.ts:279/294/319`、`plugin/jobRunner.ts:38`、`plugin/asyncTasks.ts:43`、扫描路由 `runBatchJob("scan", …)` | 同上；扫描入口 = `routes/api/index.ts:798` |
| 无进程相关门禁（起草时） | 7 个 check 脚本 + 8 个 workflow 关键词扫描 0 命中；**v3.0.39 起已由 `check-renderer-host.mjs` 兜住**（见 §7） | 现共 8 个 check 脚本 |
