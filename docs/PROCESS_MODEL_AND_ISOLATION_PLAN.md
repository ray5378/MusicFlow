# MusicFlow 进程模型与隔离规划

> 2026-09-19 起草。基于对 `backend/src` 的全量实测（`spawn`/`fork`/`execFile` 调用点、
> 各服务的事件循环占用、原生 addon 使用点），不是凭印象推演。
>
> 相关文档：`docs/sandbox-limits-and-plan.md`（插件沙箱限制与 P3 规划）、
> `SPEC.md` §1.3（批量任务子进程红线）。

---

## 0. 结论速览

| 处置 | 项目 | 一句话理由 |
|---|---|---|
| **保持**（已进程化） | Sendspin 运行时（常驻 fork） | 25ms 硬实时节拍，已隔离 |
| **保持**（已进程化） | 批量任务（一次性 fork） | 内存峰值＋不可信插件代码 |
| **保持**（已进程化） | ffmpeg 解码/转码子进程 | CPU 天然出进程 |
| **应进程化 P1** | **AirPlay RAOP 推流** | 7.98ms 节拍＋进程内加密，与 Sendspin 同构却仍在主进程 |
| **应下沉 P2** | 封面渲染（sharp） | 原生 addon 在主进程，一次段错误全站挂 |
| **暂缓 P3** | 插件沙箱进程化 | 已被批量子进程削弱，缺实测数据触发 |
| **保留现状** | HTTP/WS 路由、QC/PM 编排、调度器、<br>转码编排、DLNA 拉流、插件交互调用 | 状态密集或 I/O 密集，IPC 化是净损失 |

**一句话**：现在的边界**大体正确**，唯一的真错位是 **AirPlay** —— 它是 Sendspin 的同类负载，
却被留在了主进程里。

---

## 1. 现行进程清单（实测）

```
主进程 node/Hono
├─ HTTP API + WebSocket             I/O 密集
├─ QueueController / PlayerManager  状态密集（编排权威）
├─ dailyScheduler                   仅 setTimeout 重排下一次
├─ 插件沙箱 QuickJS WASM            主线程常驻，内存硬上限 256MB
├─ worker 线程（仅 longRunning）     线程隔离，非进程
├─ **AirPlay RAOP 推流**            ⚠️ 墙钟节拍 + 进程内 ALAC/加密
├─ sharp 封面渲染                    ⚠️ 原生 addon 在主进程
├─ transcode.ts 编排                 ffmpeg 子进程（≤4 并发闸）
│
├─ fork ─→ sendspin 专属常驻子进程
│           ├─ WS 38927 / mDNS / 拨号重拨 / ESPHome 6053 桥
│           ├─ 解码/FLAC/opus 编码/推流（25ms 硬实时）
│           └─ spawn ─→ ffmpeg（每次 seek 重启 / 单次解码）
│
└─ fork ─→ 批量一次性子进程（fork → run → exit，全局 FIFO 只跑 1 个）
            scan / daily-jobs / boot-sync / maintenance
            plugin-job（插件 longRunning 方法实际执行体）
```

关键代码位置：

| 机制 | 位置 |
|---|---|
| Sendspin 常驻 fork | `services/sendspin/supervisor.ts:161`、入口 `child.ts` |
| 模式判定 | `services/sendspin/mode.ts::isForkMode()`（leaf，零依赖） |
| 批量子进程 | `batch/runner.ts`；调用方 `index.ts:279/294/319`、`plugin/jobRunner.ts:38`、`plugin/asyncTasks.ts:43`、`routes/api/index.ts` 扫描入口 |
| AirPlay ffmpeg + 节拍 | `services/airplay/control.ts:117`（spawn）、`raop.ts:616`（`while` 节拍循环）、`raop.ts:584`（sync `setInterval`） |
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

**A1. Sendspin 常驻子进程**（`supervisor.ts` + `child.ts` + `proxy.ts` + `ipcProtocol.ts`）

命中 G1（25ms 节拍）＋ G3（`libflacjs` WASM、`@discordjs/opus` 原生 addon 都在子进程内跑）。
状态经快照镜像（150ms 节流 + 1s 兜底扫）、命令走 RPC —— 满足 G4。
**结论：不动。** 注意 `CHANGELOG [3.0.34]` 写的「强制独立子进程」是准确描述。

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

### B. 应进程化

**B1. AirPlay RAOP 推流（P1，最高优先级）**

| 项 | 事实 |
|---|---|
| 节拍 | `raop.ts:616` `while (this.streaming && !this.destroying)`，每 chunk 352 帧 ≈ **7.98ms** |
| 每 chunk 的工作 | JS 手写 ALAC 位打包（`pcm_to_alac_raw` 移植）＋ `createCipheriv("aes-128-cbc")` ＋ RTP 包封装 ＋ socket 发送 |
| 位置 | **主进程**。ffmpeg 是子进程，但节拍循环、编码、加密、发送全在主进程 |
| 已有的自证 | `raop.ts` 自己维护 `stats.reanchors`（「跟不上墙钟、立即追赶」的次数）与 `maxGapMs`，并在结束时打日志 |

这是**与 Sendspin 完全同类的负载**（G1 甚至更紧：7.98ms vs 25ms），却留在主进程。
Web API 的一次长阻塞、一次 sharp 缩图、一次批量任务排队，都会直接体现为
`reanchors++` / 真机断音。多设备同时投屏时是 N 条这样的循环并行。

**建议**：进程化，且**复用 Sendspin 已经验证的那套宿主模式**（见 §4），不要另起一套。
RPC 面比 Sendspin 小得多：cast / stop / pause / resume / seek / volume / mute / probe。
DLNA 的 `createCastSession()` 只在**建会话时**需要（拿到 token 化 streamUrl 后传进子进程），
不需要子进程碰 DB。

**触发条件（满足任一即立项）**：
1. 多设备同时 AirPlay 投屏时，`raop` 日志出现 `reanchors` 持续非零或 `maxGap` 抬升；
2. AirPlay 投屏期间 Web API P95 延迟明显抬升（前端可感知的卡顿）；
3. 投屏期间跑批量任务（扫描/推荐）会引发可复现的断音。

**B2. 封面渲染（sharp）（P2）**

`coverImage.ts:29` 在主进程 `import("sharp")`。sharp 是原生 addon（libvips）：
命中 G3（一次段错误会带走整个主进程 —— 而封面渲染是**非核心**功能，为它赔上全站可用性不划算）。

但要注意：libvips 内部自带线程池，**它对事件循环的占用（G1/K3）其实很小**，
所以这里的诉求**只是崩溃隔离**，不是节拍隔离。
**建议**：优先下沉到 **worker 线程**（成本低得多，libvips 线程池照常工作）；
只有当「worker 里跑原生 addon 仍会带走进程」被实测证实时，才升级为进程。
另需保留现有降级路径（`sharp` 缺失 → 回退原始字节），别把降级逻辑弄丢。

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
Sendspin 已经把 `supervisor.ts` / `proxy.ts` / `ipcProtocol.ts` / `playerCore.ts` 这套写完了。

**如果 AirPlay 直接复制一遍，就等于把最难维护的一块（IPC 契约 + 看门狗 + 退避重启）复制成两份
且开始各自漂移。** 建议顺序：

1. 先把 Sendspin 那套**抽出通用层**（建议 `services/rendererHost/`）：
   - `supervisor`：fork / mainReady 握手 / 心跳看门狗 / 退避重启 / 优雅 stop；
   - `proxy`：`getXxxFront()` 的镜像代理 + 类型哨兵（`AssertServerLike` 的思路可直接复用）；
   - `ipcProtocol`：`req/res` 按 id 回填 + 快照节流推送的**通用信封**，业务载荷各自定义。
2. 让 Sendspin **先切到通用层**（行为不变，靠现有测试守住：`childMain.test.ts` 8 例等）。
3. 再把 AirPlay 接上去。

**顺序不能颠倒**：先抽象再迁移，比先复制再合并便宜得多（后者要同时改两处已验证的行为）。

---

## 5. 路线图

| 阶段 | 内容 | 触发条件 | 前置 |
|---|---|---|---|
| **P0**（已完成） | Sendspin fork 隔离；批量子进程；转码并发槽 | — | — |
| **P1** | 抽通用渲染器子进程宿主 + Sendspin 迁移 | 可随时做（纯重构，收益是后续成本） | 现有 sendspin 测试全绿 |
| **P1'** | AirPlay 接入宿主 | §3 B1 三条触发条件任一命中 | P1 |
| **P2** | sharp 下沉 worker 线程 | 出现一次 sharp 相关崩溃即做 | 无 |
| **P2'** | sharp 升级为进程 | worker 中崩溃仍带走进程（实测） | P2 |
| **P3** | 插件沙箱进程化 | §3 B3 三条触发条件任一命中 | 有实测数据 |

**顺手可做的低成本项**（不依赖上述任何阶段）：

- 把 AirPlay 的 `reanchors` / `maxGapMs` 从「结束才打一行日志」提升为**可观测指标**
  （或至少在超过阈值时 warn）。P1' 的触发条件要靠它，现在只有事后日志拿不到趋势。
- 补 `supervisor` 冒烟测试（见 §7）—— 目前 fork 路径零覆盖。

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
| 7 | **门禁全绿**：`tsc` / `check-i18n` / 7 项静态检查 / 全量 vitest / 前端 build |

---

## 7. 门禁补齐建议（承接 2026-09-19 全量核查）

现状：对 7 个 `check-*.mts|mjs` + 8 个 workflow 搜
`spawn|child_process|独立进程|子进程|转码|解码|transcode|ffmpeg|decode` → **0 命中**。
即：**「重活落独立进程」目前是惯例，CI 一行都不拦。**

建议分两步，先做低误报的那个：

**① 给 Sendspin 的 fork 路径补冒烟测试（零误报，立刻可做）**

现有 `childMain.test.ts` 8 例跑的是 in-proc 控制器，且 `mode.ts` 见到 `VITEST` 直接
`return false` —— **测试永远不可能真的 fork**，「生产是否真 fork」只有注释和 CHANGELOG 背书。
补一个真 fork 的用例：起 supervisor → 断言 `mainReady` 收到且子进程存活 →
`kill -9` → 断言按退避重启 → `stop` → 断言退出。

**② 新增 `check-process-isolation.mts`（静态，需配合豁免机制）**

只扫**渲染器/推流链路**目录，规则定向到 G1 的**形态特征**而非关键词：

- 命中信号：`setTimeout` 递归自排 + `performance.now()` 差值裁决 + 固定 chunk 常量
  （如 `CHUNK_LEN`/`FRAME`）出现在同一函数内 → 判定为 deadline-driven 循环；
- 命中后要求：该模块**要么已由 `rendererHost` 托管**，要么带显式豁免注释
  （沿用本仓既有的 `// allow-process-isolation-exempt: <理由>` 风格）。

纯关键词扫描（扫 `ffmpeg`/`transcode`）误报会偏高 —— 因为 `command` 权限本就允许外部命令，
而且 DLNA/AirPlay/转码**都合法地**调用 ffmpeg。所以必须先有①，再加②。

---

## 附：本次核查的证据清单

| 断言 | 证据 |
|---|---|
| 主进程侧只有 2 条 fork 线 | `grep -rn "fork(" backend/src` → 仅 `sendspin/supervisor.ts:161`；批量在 `batch/runner.ts` |
| AirPlay 节拍在主进程 | `airplay/raop.ts:616` `while` 循环 + `:584` sync `setInterval` + `:117` spawn |
| AirPlay 进程内加密/ALAC | `raop.ts:91`（`pcm_to_alac_raw` 移植）、`:199` `createCipheriv` |
| Sendspin 原生/WASM 在子进程 | `sendspin/encoding.ts:20`（`@discordjs/opus`）、`server.ts:160`（libFLAC） |
| sharp 在主进程 | `coverImage.ts:29` `await import("sharp")` |
| DLNA 无重活 | `routes/rest/index.ts:1755`（Range 字节代理） |
| 批量任务全覆盖 | `index.ts:279/294/319`、`plugin/jobRunner.ts:38`、`plugin/asyncTasks.ts:43`、扫描路由 `runBatchJob("scan", …)` |
| 无进程相关门禁 | 7 个 check 脚本 + 8 个 workflow 关键词扫描 0 命中 |
