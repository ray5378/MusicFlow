# 沙箱限制全景审计 + 插件能力增强完整方案

> 状态：**待实施**（2026-08-14 用户拍板方向，先记录）
> 触发背景：go-music-dl 私人歌单同步 / ListenBrainz 推荐生成在生产环境反复「15s 超时」失败（`timeout of 15000ms exceeded`），定位为沙箱单次调用配额与前端 axios 超时双重限制叠加，且部分平台走非国内网络（joox/bilibili/apple/ListenBrainz/MusicBrainz）单请求极慢。

---

## 一、问题链回顾（为什么要做）

1. 沙箱 `INVOKE_TIMEOUT_MS=15000`（`backend/src/plugins/sandbox.ts:23`）对**所有方法**一刀切：`search`/`searchLyrics` 与 `runDailyJob`（批量同步几十个歌单）共用同一预算。
2. 批量任务本质分钟级，15s 只够同步 ~15 个优化过的歌单或完成 ~4 次在线补全 → 被强杀，且**在途 await 一并中断**，插件必须靠持久化游标抢救进度。
3. 前端 axios 全局 `timeout: 15000`（`frontend/src/api/index.ts:5`）→ 即使后端压线返回，HTTP 请求也已断开，用户看到 `timeout of 15000ms exceeded`。
4. 插件侧已做的兜底（go-music-dl v1.2.8 分批滚动 + 后台 auto-match；listenbrainz v1.5.4 补全预算闸）**能用但慢**：一次刷新只能推进一批，全量需多次点击或等 3~5 天。

结论：**不是插件的问题，是沙箱把「交互时延看门狗」误用成了「任务预算」，且调度/并发/数据接口有多处同类错配。**

---

## 二、沙箱限制全景清单

> 已逐一核对 `sandbox.ts` / `discovery.ts` / `host.ts` / `storage.ts` / `scrobblers.ts` / `index.ts` / `frontend/src/api/index.ts`。
> 不合理度：🔴高（直接影响功能实现）/ 🟡中（影响规模/体验）/ 🟢低（契约合理，仅需文档化）。

### A. 调用预算类

| # | 限制 | 现状 | 影响 | 度 |
|---|---|---|---|---|
| A1 | 单次调用超时 | `INVOKE_TIMEOUT_MS=15000` 全方法一刀切（sandbox.ts:23） | 批量任务（同步/生成歌单）差一个数量级；交互调用其实够用 | 🔴 |
| A2 | 超时杀死模型 | 墙钟到点即中断**在途 await**（evalAsync 循环 `Date.now()-t0 < INVOKE_TIMEOUT_MS`），不区分 CPU 空转与等网络 | 插件「等慢请求」也被判死刑，被迫游标持久化 | 🔴 |
| A3 | 同步方法 | `invokeSync`（streamUrl/lyricUrl/canHandle/canHandleFile）同 15s 且必须纯同步 | 契约合理（URL 构造不应等网络） | 🟢 |
| A4 | MB 限流兼容 | 沙箱无 setTimeout → 插件只能用忙等 sleep（listenbrainz `mbSleep` 1.1s spin） | 忙等 CPU 空转仍占预算且浪费 CPU | 🟡 |

### B. 资源限额类

| # | 限制 | 现状 | 影响 | 度 |
|---|---|---|---|---|
| B1 | 内存 | `MEMORY_LIMIT=256MB`/插件 VM | 大响应 `host.http res.text()` 全量读入 + 大数组桥接（2000 条 upsert）可能逼近；合理但需文档化 | 🟡 |
| B2 | 栈 | `STACK_LIMIT=1MB` | 深递归插件爆栈；合理 | 🟢 |
| B3 | 在途 host 调用 | `MAX_DEFERS=64`（超过即拒：「并发 host 调用过多」） | **并发硬上限**：插件 `Promise.all` 并行 >64 个 host 调用被拒；并行抓取/匹配只能串行或 ≤64 并发 | 🔴 |
| B4 | HTTP 响应体积 | 无上限，`res.text()` 全量入内存 | 超大页面（歌单页 500 首 HTML）或异常响应可打爆内存 | 🟡 |
| B5 | HTTP 超时上限 | 无上限（插件可传任意值，默认 20s；discovery.ts:479） | 加了 longRunning 后需配套 cap，防插件把任务拖到无界 | 🟡 |

### C. 数据接口限额类

| # | 限制 | 现状 | 影响 | 度 |
|---|---|---|---|---|
| C1 | `host.songs.list` | limit 上限 **500**（discovery.ts:500） | 插件拉本地曲库池需分页（go-music-dl ≤5000 首 = 10 次调用 + 桥接转换） | 🟡 |
| C2 | `host.songs.search` | limit 上限 **200**（discovery.ts:507） | 模糊匹配返回集偏小，大库易漏 | 🟡 |
| C3 | `host.storage` | JSON KV 无大小配额（SQLite） | 合理；大缓存（几 MB 池）占 DB，建议文档化 | 🟢 |
| C4 | `host.command.exec` | 默认超时 30s、maxBuffer 16MB | 合理；文档化 | 🟢 |
| C5 | `host.playlists.upsert` | 全量 DELETE+INSERT，entries 数组桥接 | 2000 条目级单次调用桥接 + 写库可达 1~3s，占预算 | 🟡 |

### D. 网络类

| # | 限制 | 现状 | 影响 | 度 |
|---|---|---|---|---|
| D1 | 非国内平台慢 | 单请求 10s+ 常见（joox/bilibili/apple/LB/MB） | 叠加 A1 + 前端 15s 双重卡死（本次事故直接动因） | 🔴 |
| D2 | 代理 | `proxyFetch` 支持系统代理/直连开关（1.7.38+） | 已解决；插件按配置切换 | 🟢 |

### E. 调度/任务类

| # | 限制 | 现状 | 影响 | 度 |
|---|---|---|---|---|
| E1 | 调度节律 | 仅两档：每日 `runDailyJobs`（含 boot 补跑）+ 6h 维护循环（只调 `playlistSync` 能力） | 无 per-plugin 节律；批量任务只能挤每日档 | 🔴 |
| E2 | `playlistSync` 单例陷阱 | `playlistSyncApi()` = `getEnabledByCapability("playlistSync")[0]?.impl`（pluginAccess.ts:108） | go-music-dl 声明该能力会劫持「导入歌单」路由 → 不敢用 6h 通道 | 🔴 |
| E3 | 无异步任务通道 | refresh 路由 `await impl.runDailyJob()`，HTTP 内阻塞 | 前端 axios 15s 必断（本次事故另一动因） | 🔴 |
| E4 | 任务并发无锁 | 仅 auto-match 有 per-playlist 锁 | 手动+每日+6h 可撞车重复全量 | 🟡 |
| E5 | 插件无法自调度 | invoke 返回后沙箱闲置，只能被调度器调用 | 无主动后台任务能力（设计如此） | 🟢 |

### F. 运行模型类

| # | 限制 | 现状 | 影响 | 度 |
|---|---|---|---|---|
| F1 | 跨调用无状态 | 只有 `host.storage` KV | 契约合理；大中间态需自己存 | 🟢 |
| F2 | comm 消息回调 | evalCode 注入 + 异常不外扩 + dispose 清理 | 合理 | 🟢 |
| F3 | 热重载 | 文件变更自动重发现/重种子 | 合理（已验证） | 🟢 |
| F4 | scrobble 派发 | `notifyScrobble(...).catch(()=>{})` fire-and-forget（routes/rest/index.ts:972） | 不阻塞播放 ✅；但慢上报（LB 外网）会被 15s 砍 → 静默失败 | 🟡 |

### G. 前端联动类

| # | 限制 | 现状 | 影响 | 度 |
|---|---|---|---|---|
| G1 | axios 全局超时 | `timeout: 15000`（api/index.ts:5） | 任何慢接口（刷新/浏览远程歌单）15s 断 | 🔴 |
| G2 | 路由内 await 插件方法 | refresh、playlistSongs 浏览、导入等 | 同步阻塞 HTTP | 🟡 |

---

## 三、完整方案（分阶段落地）

### P0 — 立即实施（方向已拍板）：方法级长耗时预算 + 异步任务通道

**契约：插件 manifest 声明 `longRunning`**
```js
// go-music-dl
longRunning: { runDailyJob: 240000, playlistSongs: 60000 }
// listenbrainz
longRunning: { runDailyJob: 120000 }
```
- 语义：声明的沙箱方法调用使用该预算（默认 15s，**上限 300000ms**，低于 Node 默认 `requestTimeout` 5min）；未声明的方法一律维持 15s 看门狗。
- 插件作者最清楚哪些操作拉平台/外网 → 声明粒度精确，不误伤、不漏。

**改动清单（主项目）**
| 文件 | 改动 |
|---|---|
| `backend/src/plugins/types.ts` | `PluginManifest` 加可选 `longRunning?: Record<string, number>` |
| `backend/src/plugins/sandbox.ts` | `invoke(method)` 按 `manifest.longRunning?.[method]` 取预算（cap 300000）；`evalAsync` 循环与 `this.deadline` 同步使用该预算；`invokeSync` 维持 15s |
| `backend/src/services/plugin/jobRunner.ts` | **新增**：per-plugin 串行锁（同插件同时只跑一个任务）+ 最近结果记录（status/summary/error/startedAt/finishedAt）；错误捕获不崩溃 |
| `backend/src/routes/api/index.ts` | `POST /v1/recommend/refresh?pluginId=` 改**异步启动**：未在跑 → kick off 并返回 `{success, started:true}`；在跑 → `{success, alreadyRunning:true}`。新增 `GET /v1/plugins/:id/job` 返回 `{running, last}` |
| `backend/src/index.ts` | 每日 `runDailyJobs()` 与 6h 维护循环改走 jobRunner（共用串行锁） |
| check-core（主项目） | 校验 `longRunning`：方法必须存在、值 1000~300000 |
| `frontend/src/views/admin/Plugins/index.vue` | 刷新改「POST 启动 → 立即显示后台刷新中 → 2s 轮询 GET job 状态 → 展示结果」 |
| `frontend/src/views/Home/index.vue` | 同上（今日漫游刷新） |
| `frontend` 远程歌单浏览 | `playlistSongs` 相关调用点 axios 覆盖 `timeout: 60000`（同步浏览，不能异步） |

**改动清单（插件仓）**
| 插件 | 版本 | 改动 |
|---|---|---|
| `go-music-dl` | v1.2.9 | manifest 加 `longRunning`；`SYNC_WINDOW_MS` 11000→200000、`MAX_PLAYLISTS_PER_RUN` 15→100（游标与预算闸保留防挂起）；minAppVersion 提到新版后端；`playlistSongs` 内部 HTTP 超时 12s→30s（配合 60s 方法预算） |
| `listenbrainz` | v1.5.5 | manifest 加 `longRunning`；`COMPLETE_BUDGET_MS` 10000→90000；minAppVersion 提升 |

**效果**：点一次「手动刷新」≈ 全量同步（~40 歌单约 1~2 分钟），HTTP 不阻塞、进度可查、无 axios 超时；交互调用看门狗完全不变。

#### P0-4 沙箱限制错误可辨识化（报错必须说人话）

**目标**：任何因**沙箱限制**导致的失败（超时/权限/并发/内存/栈），报错必须全链路可辨识——带稳定错误码、中文说明、可行动修复提示；禁止再出现「timeout of 15000ms exceeded」「HTTP undefined」这类让用户无从排查的裸报错。

| 限制类型 | 错误码 | 示例文案（含修复提示） |
|---|---|---|
| 单次调用超时 | `SANDBOX_TIMEOUT` | 「沙箱限制：单次调用超时（配额 15s）。该操作可能需拉取平台/外网数据，可在插件 manifest 的 `longRunning` 中为该方法声明更长预算后更新插件」 |
| 权限缺失 | `SANDBOX_PERMISSION` | 「沙箱限制：权限不足（缺少 `net`）。请确认插件 manifest 已声明所需权限」 |
| 并发超限 | `SANDBOX_CONCURRENCY` | 「沙箱限制：并发宿主调用过多（在途 N > 上限 64）。插件应降低并行度或分批串行」 |
| VM 资源/加载 | `SANDBOX_VM` | 「沙箱限制：虚拟机执行失败（内存/栈/语法，原因: …）」 |

**实现点**
- `sandbox.ts` 新增结构化错误 `sandboxError(code, message, hint)`；在 4 类限制点 throw/封装：evalAsync 超时分支、`hasPerm` 拒绝点（hostAsync/hostSync）、MAX_DEFERS 拒绝点、init/evalCode 的 error dump 分支；
- `invoke()` 抛出的 Error 携带 `sandboxCode` / `hint` 字段，信封透传；
- 路由层：各插件调用点 catch 后 `c.json({ success:false, error, sandboxCode, hint })`；
- `jobRunner`（P0 新增）：`last.error` 同样记录 code+hint，状态端点透出；
- 前端：`api` 拦截器/调用点识别 `sandboxCode`，ElMessage 展示「错误码 + 说明 + 修复提示」；axios 自身超时错误（非沙箱产生）也映射为「请求超时：后端处理过慢或服务不可达」而非裸英文；
- 插件侧业务错误不受影响，仅沙箱限制类错误被标记。

**验收**：模拟超时/缺权限/并发超限，前端看到的是带「沙箱限制：」前缀 + 修复提示的可行动文案，日志中可 grep 错误码。

### P1 — 短期（并发 / 数据接口 / 网络卫生）

| 项 | 改动 | 收益 |
|---|---|---|
| P1-1 `MAX_DEFERS` 64→256（或按 manifest 可配） | sandbox.ts 常量提升 | 插件可 ≥64 并发 host 调用（并行抓取/匹配） |
| P1-2 `host.songs.list` limit 500→2000 | discovery.ts | 本地池加载调用次数减半，桥接开销下降 |
| P1-3 `host.http` 加 `maxResponseBytes`（如 20MB） | discovery.ts http 实现 | 防超大响应打爆 256MB VM 内存 |
| P1-4 软中断（job 方法有在途 await 时不判超时） | sandbox.ts evalAsync | 等网络合法；**注意**：需防「连环 host 调用永不死」（见风险） |
| P1-5 修 `playlistSync` 单例陷阱 | pluginAccess.ts 按插件 id 取 impl | go-music-dl 等可安全声明 playlistSync 用 6h 档 |

### P2 — 中期（调度 / 运行模型）

| 项 | 改动 | 收益 |
|---|---|---|
| P2-1 manifest 声明任务节律（如 `jobs: [{method, intervalMs}]`） | jobRunner 支持定时 | 插件自定刷新频率（如 go-music-dl 6h、LB 12h），替代硬编码两档 |
| P2-2 大 upsert 分块/流式 | discovery.ts upsertPluginPlaylist 分批写 | 2000+ 条目不再单次桥接+写库 1~3s |
| P2-3 job 进度事件（WS 推送 `job_progress`） | ws 服务 + 前端订阅 | 刷新过程实时可见（可选） |

### P3 — 长期（可选）

- 插件市场 UI 展示 `longRunning` 能力标签（「长任务」徽标）；
- 任务失败自动重试（指数退避）；
- 沙箱替换为可长驻的 worker 进程（彻底解耦 CPU/网络等待，工程量最大）。

---

## 四、版本计划与发版

| 阶段 | 主项目 | 插件 | 验证 |
|---|---|---|---|
| P0 | 1.7.38 → **1.7.39** | go-music-dl v1.2.9 / listenbrainz v1.5.5 | 单测：sandbox 按方法预算；jobRunner 串行锁/状态；仿真：慢源全量一次完成；`npx tsc --noEmit`；check-core |
| P1 | 1.7.40 | — | 并发/数据接口回归 |
| P2 | 1.8.x | — | 调度回归 |

- 主项目发版流程照常：CI（check-core + 测试）→ tag → Release（addon 同步需用户明确授权）。
- 插件发版照常：`scripts/check.mjs` → `pack.sh` → commit + tag + gitee/GitHub 双端推送。

## 五、风险与回退

| 风险 | 说明 | 对策 |
|---|---|---|
| 长任务占沙箱 | 恶意/异常插件可长占 VM | `longRunning` 上限 300s + jobRunner per-plugin 串行锁 + 仅对声明方法生效 |
| 软中断（P1-4） | 连环 host 调用可能让墙钟失效 | 保守实现：仅在「有在途 await 且是 job 方法」时续期，且续期总上限=预算；CPU 空转仍按预算杀 |
| jobRunner 状态膨胀 | 内存 Map 存结果 | 只存最近 1 条（或 TTL 清理，复用 matchJobs 的 30min sweep 模式） |
| 插件 minAppVersion 门控 | 老后端忽略 longRunning → 退化 15s | 插件 bump minAppVersion，老后端明确拒绝加载（而非静默退化） |
| 回退 | 任意阶段可回退 | P0 各改动独立可逆；前端轮询失败降级为「启动成功，请稍后查看」 |

---

## 六、待办（执行时按此顺序）

1. [ ] 主项目：types.ts + sandbox.ts（方法级预算）→ 单测
2. [ ] 主项目：jobRunner.ts + routes（异步启动 + 状态端点）→ 集成测试
3. [ ] 主项目：index.ts 调度走 runner；check-core 校验
4. [ ] **主项目：沙箱限制错误可辨识化（P0-4：sandboxError 分类 + 路由/前端透传）**
5. [ ] 主项目：前端轮询改造（Plugins/Home）+ playlistSongs 调用点超时覆盖
6. [ ] 插件：go-music-dl v1.2.9 / listenbrainz v1.5.5（longRunning + 预算放宽 + minAppVersion）
7. [ ] 主项目版本 1.7.39 发版（CI/tag/Release；addon 待授权）
8. [ ] 插件仓发版（check/pack/commit/tag/双端推送）
9. [ ] P1/P2 按需排期
