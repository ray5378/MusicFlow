# Sendspin 跳转进度优化专项

> **建立日期：2026-09-22**（真机数据同日在 240 生产实例采集：天翼网盘 WebDAV 曲库 × ESP32 `esp32-player2`
> `C4:9E:7E:08:75:64`）
>
> **本文是「sendspin 跳转进度（seek）性能优化」的单一真相源。**
> seek 的**语义与正确性**（世代竞态、钳制、源行复用契约）仍归 `docs/PLAYBACK_SEEK_MA_REWORK.md`；
> 本文只管**性能**：拖一次进度条要多久才出声、以及怎么把它降下来。

## 0. 一句话

用户报「很多歌曲跳转进度后要十几秒才出声」。定位到**两段互相独立的开销**：

| 段 | 内容 | 量级 | 状态 |
|---|---|---|---|
| ① | 每次 seek 重建都重跑一遍「播放优选」（`resolvePlayableRow`） | **1.85~2.53s** | ✅ **已修（A 项 `1bcd473`）** |
| ② | ffmpeg 对**无 SEEKTABLE** 的网盘 FLAC 做输入 `-ss` 时发 9 次**开放式 Range**，每次一个上游往返 | **4~13s** | 🚧 本轮在做（B 项） |

②才是大头。本文把五项候选（A~E）的取舍、**优化方法**、实测数据与状态固化下来。

## 1. 症状与用户口径

- **症状**：拖动进度条后 10 几秒才出声。位置**发布是对的**（UI 上进度条立刻到目标值），
  但音频迟迟不来；期间设备侧无报错，服务端只在等音源。
- **用户口径（原话）**：
  > 网络源 / WebDAV 源跳转进度时应该**自动复用正在播放的地址**，不应该回退到「查找播放源」这一步。

  这一条直接催生了 A 项（源行复用）。

## 2. 真机实测（240 生产实例，2026-09-22）

### 2.1 逐层排除（每一步的初判都被实测推翻过一次）

1. **网络 / Range → 排除**：源站 web 源 206、整首 4.29MB / 1.03s；WebDAV 任意位置 Range 均 206 / ~271ms。
2. **ffmpeg / loudnorm → 排除（但先踩了一个假数据的坑）**：起初直连 WebDAV `-ss 67` 测出「258ms」——
   那是**假数据**：`-headers` 里的 `\r\n` 经 shell 截断成换行 ⇒ ffmpeg 报 `No trailing CRLF found` +
   `Error opening input`，**根本没打开输入**。改用 `execFileSync(FF, [args...])` 数组传参复测，
   loudnorm 各变体均 200~300ms。
3. **复现链路（独立脚本逐步计时）**：`resolvePlayableRow` = **1925ms**（`preferred-swap`），
   其余 `resolveRowInput` / mint token / `isStreamSource` 全 ≤2ms。
4. **回环 token URL（生产真实输入）**：`-ss 67`=**4493ms**、`-ss 129`=**14344ms**、`-ss 178`=**3741ms**
   —— 与生产日志逐个吻合（6.84 / 15.34 / 7.03s）。直连 vs 回环**单请求耗时相近**（~340 vs ~370ms）
   ⇒ **回环转发不是主因**。
5. **`ffmpeg -v debug` 抓机制**：**9 次 `Range: bytes=N-`（全部开放式）**，后半截在几百字节内逐帧回溯同步：
   `7923532- → 7360604- → 7294107- → 7287723- → 7288901-`。

### 2.2 端到端口径补测（同日夜间，带 `-t` 时间戳）

| 口径 | 实测 |
|---|---|
| seek 重建「开始获取音源 → 音源就绪」 | **5.1 / 5.1 / 5.8 / 9.4 / 13.1s** |
| 首播同口径 · v4.0.12 原版 | 2.5 / 4.6 / 3.3s |
| 首播同口径 · 补丁版（A + 竞态修复） | 0.65 / 1.46 / 2.67s ⇒ **无回归** |
| A 项生效证据 | 同曲 seek `(reuse-active) ms=1~15`（原 `preferred-swap` 1850~2530ms） |

> ⚠️ **跨版本比耗时必须在切换版本前落盘**：`docker restart` 会截断 `docker logs`（只留到最近一次重启），
> 这次先切了版本，v4.0.12 的 **seek** 耗时样本一并丢失，只能拿首播做 A/B。

## 3. 机理

- **曲库形态**：本实例曲库**全是天翼网盘 WebDAV**（`w:<sourceId>:` 前缀，31MB FLAC，**无 SEEKTABLE**）。
- **FLAC 无 SEEKTABLE** ⇒ demuxer 拿不到帧索引，只能按码率**估算**目标字节位置，`avio_seek` 过去、
  扫帧头校验，不中则回溯重试；**每一次 `avio_seek` 在 HTTP 输入上就是一次新的带 `Range: bytes=N-` 的请求**。
- **链路**：`PcmWindow.spawn()` → `decodeArgs({ timeOffsetSec })`（`backend/src/services/audio/pipeline.ts:66`）
  → `-ss <秒>` 落在 `-i` **之前** → ffmpeg 走「输入 seek」。
- **输入是回环 token URL**（`/rest/dlna/stream/<token>?raw=1`，SPEC §1.8 硬契约），
  而该路由是**纯透传代理**（`routes/rest/index.ts` 的 `restRoutes.get("/dlna/stream/:token")` raw 分支：
  `fetch(upstream, { Range })` → `c.body(upstream.body)`）
  ⇒ **ffmpeg 的每一次 Range 都是一次完整的上游往返（~340ms）**。
  9 次 ≈ 3s 起步，叠加传输与回溯，落到 4~13s。
- **位置相关性**：`-ss` 越大，估算点越远、回溯链越长 ⇒ 通常越慢（但受上游波动影响，非严格单调：
  实测 `-ss 129`=14.3s 而 `-ss 178`=3.7s）。
- **①的机理（A 项要治的那段）**：`PumpSource(songId, startMs)` **只带 songId、不带「当前正在用的行」**，
  于是同一首歌内反复拖进度条也每次重解析 —— 快缓存 `getCachedPlayability` 只记「可播/不可播」、
  **不记换到了哪一行**；而本实例每条 web 歌都会**恒定**换到组内「核心曲库」行（天翼网盘行），
  即「结果恒定却每次重算」。

## 4. 候选清单（A~E）

| 项 | 做法 | 预期收益 | 风险 / 代价 | 状态 |
|---|---|---|---|---|
| **A** | **复用当前生效源行**（详见 §5） | 省 1.85~2.53s | 复用命中却出不了流 → 清记账 + 回退完整裁决一次 | ✅ **已完成** `1bcd473` |
| **B** | **让 ffmpeg 拿到可随机访问的输入**（回环节点区间缓存 + 按块预读；可选本地文件路径）（详见 §6） | 省 4~13s（**收益最大**） | 内存/磁盘定额、缓存键必须含 url 指纹、异常必须回退透传 | 🚧 **本轮在做** |
| **C** | **窗口内 seek 走零成本路径**：`PcmWindow.seekTo()` 已有命中窗口的快速分支（只挪消费水位），但 `seekCore` 总走「完整起播重建」⇒ 每次拖动都重起一条 ffmpeg | 省一次 ffmpeg spawn + 预缓冲 | 需与「起播窗口内 seek 世代竞态」（`1937f80`）的语义对齐，别把已修好的竞态重新引回来 | ⬜ 未开工 |
| **D** | **前端拖拽预热**：拖动过程中（`onChange` 节流）预取目标附近字节，落热到 B 的缓存 | 让 B 的首个 miss 也提前发生 | 与现有 250ms trailing 去抖的关系要理清；别把请求放大 | ⬜ 未开工 |
| **E** | **`-noaccurate_seek` 输入粗定位**（`-ss` 前追加，须在 `-i` 前） | 孤立 ffmpeg 上量到 **-29%**（请求数不变） | 真实 seek 重建路径上**无法确认收益**；同期出现的取流超时经取证另有根因（起播窗口内 seek 世代竞态）。**按用户决定摘除**，原文保留在 §9.1 | ⛔ **已撤回** |

**取舍结论**：A 已解决①（✅），**本轮做 B 解决②**。C/D 作为后续候选保留；E 不再单独做（它治的是
「请求数不变、每请求更快」，与 B 的「请求数归并」正交 —— B 落地后 E 的更小收益更不值得）。

## 5. A 项 · 复用当前生效源行【✅ 已完成 · `1bcd473`】

> commit：`1bcd473 perf(seek): seek 重建复用生效源行,省掉每次 1.85~2.53s 的播放优选`

### 5.1 要治什么

`resolvePlayableRow(songId)` 每次调用都重跑一遍「播放优选」：web 行先 `resolvePreferredSong` 换行、
再 `ensurePlayableStream`、再 `verifyRow` 逐候选探测 —— 实测 **1.85~2.53s/次**，
而本实例的结果**恒定**（总能换到组内「核心曲库」的天翼网盘行）。

根因是**上下文没传下来**：seek 重建走 `PumpSource(songId, startMs)`，**只带 songId、不带「当前正在用的行」**；
快缓存 `getCachedPlayability` 只记 playable、**不记换到了哪一行**。于是同一首歌内每次拖动都白跑一遍。

### 5.2 优化方法（4 个文件）

| 文件 | 改动 |
|---|---|
| `services/source/resolveAudio.ts` | `resolvePlayableRow(songId, opts?)` 新增 `opts.preferRowId` —— **命中即零成本直返**（`reason=reuse-active`），整段优选跳过。判定**放在快缓存之前**（关键：快缓存回的永远是**原始 songId** 那一行，而实际在播的可能是优选换过的**组内兄弟行**） |
| `services/sendspin/streamEngine.ts` | ① `GroupAudio` 增加 `sourceRowId`（回带当前生效行）；② `PumpSource` 加第三参 `opts`；③ `GroupPump` 记 `{ songId, rowId }`，**仅同曲** seek 重建时传回 |
| 同上 | 复用命中却出不了流 → **清记账 + 回退完整裁决一次**（回退成功按新结果**重建记账**，不会永久退化） |
| 同上 | **切歌不复用**（songId 不一致直接丢弃记账） |

设计依据就是用户口径：「网络源 / WebDAV 源跳转进度时应该自动复用正在播放的地址，不应该回退到查找播放源这一步」。

### 5.3 实测收益

| 指标 | 改前 | 改后 |
|---|---|---|
| 同曲 seek 重建的解析耗时 | `preferred-swap` **1850~2530ms** | `(reuse-active)` **1~15ms** |
| 切歌 | `preferred-swap` ~2s | ~1.9~2.1s（**设计如此**：切歌不复用） |

240 热补丁实测日志：`复用源行=<rowId>` + `[resolve] <A> -> <A> (reuse-active) ms=2`。

### 5.4 测试与负向验证

新增/补充 **8 个用例**：

- `tests/services/resolveAudio.test.ts`（4）：命中直返 / 命中兄弟行 / 行不存在回退 / 不传不变
- `src/services/sendspin/streamPumpRowReuse.test.ts`（4，新增）：同曲复用 / 切歌不复用 /
  失败回退一次并重建记账 / 无 `sourceRowId` 不复用

**负向验证矩阵（5 变体，每个精确变红，失败信息恰好点中所修语义）**：

| 变体 | 破坏点 | 红了几例 |
|---|---|---|
| A | 去掉 resolveAudio 的复用分支 | 2（两条「命中」用例） |
| B | streamEngine 不透传 `preferRowId` | 2（同曲复用 / 失败回退） |
| C | 去掉 `-noaccurate_seek` 追加 | 1（有 `-ss` 才加） |
| C2 | 改成「只要带 `-ss` 就无条件加」 | 1（不传则保持精确） |
| C3 | 把粗定位提到 `-ss` 分支之外 | 1（无 `-ss` 不加） |

> 经验（已并入 `MEMORY.md`）：**一个修复含「方向相反」的守卫时，要分别造「移除」与「过度开启」两类变体** ——
> 只破坏一处的话，另一条断言可能从没红过。

230 验证：`tsc --noEmit` 通过；受影响 3 文件 **37 用例全绿**。

### 5.5 文档回标

`SPEC.md` §1.7（`preferRowId` / `reuse-active`）+ §1.8 新增「输入 seek 的粒度契约」；
`docs/PLAYBACK_SEEK_MA_REWORK.md` 状态行 1~7→1~8、§5 新增 **patch9**、修订记录 **R3**。

## 6. B 项 · 让 ffmpeg 拿到可随机访问的输入【🚧 本轮在做】

### 6.1 硬约束

- **SPEC §1.8**：ffmpeg 子进程的输入**只允许两类** —— 回环 token URL（`/rest/dlna/stream/<token>?raw=1`）
  或**本地文件路径**。B 的两个落点都在契约内，**不新增第三类输入**。
- 不改「取源」语义：仍由 Node 侧做鉴权 / 302 / 播放优选；**不恢复任何直出旁路**。
- 上游请求数要**降**（不是把 9 次小请求变成 9 次大请求）。

### 6.2 两个落点

1. **回环节点区间缓存**（主方案，对 ffmpeg 透明）
   把 `/rest/dlna/stream/:token?raw=1` 从「纯透传」升级为「**本地稀疏字节缓存 + 按块预读**」：
   - 首个 miss → 按**对齐块**（初定 4MB）向上游拉一次，落本地缓存；
   - ffmpeg 后续那 8 次开放式 Range **全部命中缓存** ⇒ 上游往返 **9 → 1**；
   - 缓存落 `DATA_DIR/cache/raw/`，键含 **url 指纹 + size**（web 行换源后 url 会变，不能只按 rowId/歌名），LRU 定额。
2. **本地文件路径输入**（可选加速）
   当整曲已在本地缓存（如用户反复拖动同一首）时，`resolvePipelineInput` 直接回**本地路径**，
   `-ss` 完全无网络、只有本地读 + 帧扫描。

### 6.3 收益预期（待实测）

- 上游往返 **9 → 1**：RTT 340ms × 9 ≈ **3s 应基本消失**；
- 剩余只有「本地读 + 帧扫描」（本地 I/O，毫秒级）；
- 目标：`-ss 129` 从 **14344ms** 降到 **亚秒**。
- **验证脚本**：`patch/probe_B_240.js` 三条对照 —— A 现状（回环透传）/ B 本地文件（收益上界）/
  C 本地 HTTP + 4MB 预读缓存（拟实现），并统计缓存层的上游请求数。

### 6.4 验收

- 240 实测 seek 重建端到端从 **5.1/5.1/5.8/9.4/13.1s** 降到目标值，且**设备侧出声三件套齐全**
  （`speaker_mixer:369 Starting` / `i2s_audio.speaker:070 Starting` / `96000 [speaker_task]`），
  `Failed to send audio chunk` = 0；
- 上游请求数下降有日志/计数证据；
- 异常路径（缓存写失败 / 上游 5xx / 磁盘满）必须**回退透传**，不得 5xx、不得让「拖动即静音」变更糟。

## 7. C / D / E 项（未开工 / 已撤回）

- **C · 窗口内 seek 走零成本路径**：`PcmWindow.seekTo()` 已实现「命中窗口 → 只挪消费水位、不重起 ffmpeg」
  （`backend/src/services/sendspin/streamSource.ts:234` 的快速分支），但 `seekCore` 目前**总走完整起播重建**
  ⇒ 每次拖动都杀一条 ffmpeg 再拉一条。要让落点落在「已解且未淘汰」区间内时走零成本分支。
  ⚠️ 必须先核对与 `1937f80`（起播窗口内 seek 的世代竞态）的语义边界，**不能把那批修复重新引回来**。
- **D · 前端拖拽预热**：拖动过程中节流预取目标附近字节，把 B 的首个 miss 提前消化。
  卡片 `_seek()` 与网页 `castSeek()` 现状是 **250ms trailing 去抖**（客户端只发 1 次），改前先理清节律。
- **E · `-noaccurate_seek`**：孤立 ffmpeg 实测省 29%（请求数不变），真实路径无法确认收益，
  已按用户决定摘除；原文见 §9.1。

## 8. 附注

### 8.1 诊断脚本（本机 `opencode230/patch/`）

`probe_webdav.js`（源站 Range/TTFB）、`probe_chain.js`（链路逐步计时）、`probe_af.js`（af 链对照）、
`probe_loop.js`（回环 vs 直连）、`probe_http.js`（ffmpeg debug 抓 Range 序列）、`probe_perreq.js`
（单请求耗时分离）、`probe_local.js`（本地文件对照）、`probe_E_240.mjs`、
**`probe_B_240.js`（B 项三条对照，本轮新增）**。

### 8.2 两个坑（已并入 `MEMORY.md`）

1. 给 ffmpeg 传 `-headers` 必须用**数组传参**（`execFileSync(FF, [args...])`）—— 走 shell 会把 `\r\n` 截断，
   ffmpeg 直接 `Error opening input`，量出来的耗时全是假的。
2. 临时 raw token 走 **INSERT 进 `raw_stream_tokens`**（注册表在 SQLite，跨进程可见），别用内存 Map。

### 8.3 相关文档

- `docs/PLAYBACK_SEEK_MA_REWORK.md` —— seek 的语义 / 正确性改造（patch1~10、§6.6 世代竞态）
- `SPEC.md` §1.7 / §1.8 —— `preferRowId` 契约、ffmpeg 输入硬契约
- `docs/audio-pipeline-plan.md` §1.3 / §3.6 —— 转码管道与通道能力表

## 9. 附录

### 9.1 2026-09-22 原文备查 · E 项（`-noaccurate_seek`）

> 逐字保留被撤回的方案原文与实测，以免以后重走弯路。

```
E `-noaccurate_seek`（实测省 29%，请求数不变）

services/audio/pipeline.ts：DecodeRequest.coarseSeek → 在 -ss 之前追加 -noaccurate_seek
  （输入选项，必须在 -i 前，否则 ffmpeg 当输出选项静默无效）。
services/sendspin/streamSource.ts：推流 decodeArgs({...}) 传 coarseSeek: true。

撤回原因：孤立 ffmpeg 上量到 -29%，但真实 seek 重建路径上无法确认收益，
且同期出现的取流超时经取证另有根因（见 docs/PLAYBACK_SEEK_MA_REWORK.md §6.6）。
```

### 9.2 修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-22 | 建立本文。固化 ①A（已完成 `1bcd473`，含完整优化方法与负向矩阵）+ ②B/C/D/E 五项候选；本轮决定实施 B。E 项原文备查见 §9.1。 |
