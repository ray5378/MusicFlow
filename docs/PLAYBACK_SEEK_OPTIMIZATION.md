# 所有播放链路跳转进度优化方案

> **建立日期：2026-09-22**（真机数据同日在 240 生产实例采集：天翼网盘 WebDAV 曲库 × ESP32 `esp32-player2`
> `C4:9E:7E:08:75:64`；四条链路调研于同日 22:30~22:45 补入）
>
> **本文是「所有播放链路 · 跳转进度（seek）性能优化」的单一真相源**，覆盖五条链路：
> **Sendspin**（服务端推流给 ESP32 音箱）、**DLNA**（服务端投屏 + 设备拉流）、
> **客户端自己播放**（Flutter/安卓/Windows）、**Web 播放**、**AirPlay**。
> seek 的**语义与正确性**（世代竞态、钳制、源行复用契约）仍归 `docs/PLAYBACK_SEEK_MA_REWORK.md`；
> 本文只管**性能**：拖一次进度条要多久才出声、以及怎么把它降下来。

## 0. 一句话

用户报「很多歌曲跳转进度后要十几秒才出声」。定位到**三段互相独立的开销**：

| 段 | 内容 | 量级 | 影响链路 | 状态 |
|---|---|---|---|---|
| ① | 每次 seek 重建都重跑一遍「播放优选」（`resolvePlayableRow`） | **1.85~2.53s** | Sendspin | ✅ **已修（A 项 `1bcd473`）** |
| ② | ffmpeg 对**无 SEEKTABLE** 的网盘 FLAC 做输入 `-ss` 时发 9 次**开放式 Range**，每次一个上游往返 | **4~13s** | **全部五条** | 🚧 本轮在做（B 项 §6） |
| ③ | 四条链路每次 seek 也重跑 `resolvePreferredSong` → 真的去 HEAD 探测 WebDAV 候选 | **1.0~2.9s** | DLNA / 客户端 / Web / AirPlay | ⬜ 未开工（F 项 §7） |

**②才是大头**，且它是**五条链路共有的**。本文把六项候选（A~F）的取舍、**优化方法**、实测数据与状态固化下来。

## 1. 症状与用户口径

- **症状**：拖动进度条后 10 几秒才出声。位置**发布是对的**（UI 上进度条立刻到目标值），
  但音频迟迟不来；期间设备侧无报错，服务端只在等音源。
- **用户口径（原话）**：
  > 网络源 / WebDAV 源跳转进度时应该**自动复用正在播放的地址**，不应该回退到「查找播放源」这一步。

  这一条直接催生了 A 项（源行复用）。
- **补充口径（2026-09-22 晚）**：
  > 服务端推 DLNA、客户端自己播放、Web 播放、AirPlay 播放的链路，在跳转进度时你看看能不能也用 A 这个优化加速。

  → 由此补出 §7（F 项）。

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
- **③的机理（F 项要治的那段）**：见 §7.2 —— 与①同源（结果恒定却每次重算），但发生在**另外四条链路**上，
  且那四条是**无状态 HTTP 重拉**、调用方没有「上一次用了哪一行」的记忆。

## 4. 候选清单（A~F）

| 项 | 做法 | 预期收益 | 风险 / 代价 | 状态 |
|---|---|---|---|---|
| **A** | **复用当前生效源行**（详见 §5） | 省 1.85~2.53s | 复用命中却出不了流 → 清记账 + 回退完整裁决一次 | ✅ **已完成** `1bcd473` |
| **B** | **让 ffmpeg 拿到可随机访问的输入**（回环节点区间缓存 + 按块预读；可选本地文件路径）（详见 §6） | 省 4~13s（**收益最大**） | 内存/磁盘定额、缓存键必须含 url 指纹、异常必须回退透传 | 🚧 **本轮在做** |
| **C** | **窗口内 seek 走零成本路径**：`PcmWindow.seekTo()` 已有命中窗口的快速分支（只挪消费水位），但 `seekCore` 总走「完整起播重建」⇒ 每次拖动都重起一条 ffmpeg | 省一次 ffmpeg spawn + 预缓冲 | 需与「起播窗口内 seek 世代竞态」（`1937f80`）的语义对齐，别把已修好的竞态重新引回来 | ⬜ 未开工 |
| **D** | **前端拖拽预热**：拖动过程中（`onChange` 节流）预取目标附近字节，落热到 B 的缓存 | 让 B 的首个 miss 也提前发生 | 与现有 250ms trailing 去抖的关系要理清；别把请求放大 | ⬜ 未开工 |
| **E** | **`-noaccurate_seek` 输入粗定位**（`-ss` 前追加，须在 `-i` 前） | 孤立 ffmpeg 上量到 **-29%**（请求数不变） | 真实 seek 重建路径上**无法确认收益**；同期出现的取流超时经取证另有根因（起播窗口内 seek 世代竞态）。**按用户决定摘除**，原文保留在 §11.1 | ⛔ **已撤回** |
| **F** | **「WebDAV 可播」结论做成短 TTL 记忆**（详见 §7） | 四条链路每次 seek 省 **1.0~2.9s** | 只缓存 webdav 分支（本地行仍实时 `existsSync`）、TTL 与失败记忆对称、出流失败逐出 | ⬜ **未开工** |

**取舍结论**：A 已解决①（✅）；**B 解决②**（收益最大，且**五条链路通吃**）；
**F 解决③**（四条链路的同类开销，改动最小）。C/D 作为后续候选保留；E 不再单独做（它治的是
「请求数不变、每请求更快」，与 B 的「请求数归并」正交 —— B 落地后 E 的更小收益更不值得）。

## 5. A 项 · 复用当前生效源行【✅ 已完成 · `1bcd473`】

> commit：`1bcd473 perf(seek): seek 重建复用生效源行,省掉每次 1.85~2.53s 的播放优选`
>
> ⚠️ **适用范围**：本项只覆盖**主动维护记账的调用方** —— sendspin pump 与 `QueueController.judgePlayable`。
> 另外四条链路**不适用**（它们是无状态 HTTP 重拉，见 §7.1），那部分由 **F 项**覆盖。

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

### 6.5 覆盖链路（重要）

`audio/pipeline.ts:72-73`：`timeOffsetSec > 0` ⇒ `args.push("-ss", String(timeOffsetSec))`，落在 `-i` **之前**。
**五条链路的 seek 都走这一段**（Sendspin 的 `PcmWindow.spawn` 与 `/rest/stream`、`serveCastStream` 的
`servePipelinedSong` 共用 `buildPipelineCommand`）⇒ **B 的收益不是 sendspin 专属，全部五条链路通吃**。

## 7. 其它四条链路的同一问题（DLNA / 客户端 / Web / AirPlay）【2026-09-22 调研 · F 项未开工】

> 本节回答用户问题：「服务端推 DLNA、客户端自己播放、Web 播放、AirPlay 播放，跳转进度时能不能也用 A 这个优化？」

### 7.1 结论：能，但**别照搬 A 的形态**

| 链路 | seek 走法 | 每次重跑的解析 | 是否跑 `resolvePlayableRow` |
|---|---|---|---|
| **Web 播放** | 客户端带 `timeOffset` 重拉 `/rest/stream` | `resolvePreferredSong()`（`routes/rest/index.ts:1686`） | ❌ |
| **客户端自己播放**（Flutter/安卓/Windows） | 同上（**同一条路**） | 同上 | ❌ |
| **服务端推 DLNA** | `reseekByRecast`（`dlna/control.ts:1018`）→ `castToDevice` → 设备重拉 `/rest/dlna/stream/:token` → `serveCastStream` | `resolvePreferredSong()`（`:1881`） | ❌ |
| **AirPlay** | 原地换 decoder 重拉 `/rest/airplay/stream/:token` → 同上 `serveCastStream` | 同上 | ❌ |
| （附）**DLNA 切歌判定** | `QueueController.judgePlayable`（`:735`） | `resolvePlayableRow()` ← **A 原本治的就是它** | ✅ |

**出流入口只有两个**：`/rest/stream` 与 `serveCastStream` —— 两者**都只调 `resolvePreferredSong`，
不调 `resolvePlayableRow`**。⇒ A（`preferRowId`）那套「调用方记账」只对 **sendspin pump** 与 **`judgePlayable`** 成立。

**为什么这四条链路不能照搬 A**：它们是**无状态 HTTP 重拉** —— 浏览器 / 客户端 / 音箱 / 本地 ffmpeg
都不知道「上一轮用的是哪一行」，**没有可记账的调用方**。若硬要按 A 的形态做，得给
`CastSession`（`dlna/control.ts:199`，现只有 `{token, songId, deviceId, createdAt, expiresAt}`）加 rowId、
再给 `/rest/stream` 按 peerId 另建一套记账 —— 改动面远大于收益，**不划算**。

### 7.2 但它们确实在重复付同一笔钱（实测）

`resolvePreferredSong` 的方向 1（web 行 → 组内 local/WebDAV 优选）每次都真去探测候选：

| 事实（240 容器内实测，2026-09-22） | 值 |
|---|---|
| `songs` 总数 | 123324 |
| `type` 分布 | `web` 71080 / `local` 52244 |
| **`path` 前缀分布** | **`web` 71080 / `w` 52244** |
| ⇒ **本地行 100% 是 WebDAV**（`w:` 前缀） | 探测**永远走网络**，命中不了 `existsSync` 快路径 |
| `probeLocalSourceOk`（WebDAV） | **1036 / 1068 / 1181 / 2925 ms** |
| `resolvePlayableRow`（web 行） | **1985 / 2026 / 2248 ms**（`reason=preferred-swap`） |
| 有「web 行 + 组内 WebDAV 兄弟」可优选的歌 | **5665 首** |

**生产铁证**：同一首 `2d57525c` 的 `播放优选:web 歌曲切换到核心曲库源` 在 2 分钟内出现 **9 次**，
其中成对相隔 **1.77~2.10s**（`14:02:30.248`/`14:02:32.119`、`14:03:15.752`/`14:03:17.798`、`14:03:32.549`/`14:03:34.645`）
—— 同一动作触发**两次**解析（judge 一次 + 出流一次），每次都重跑 WebDAV 探测。

**顺带的双重浪费**：一次 web 行 `resolvePlayableRow` 会对**同一个候选文件探测两次** ——
`resolvePreferredSong` 内部的 `probeLocalSourceOk(alt)` 一次、`verifyRow(alt)` 又一次；
而 `utils/localSourceProbe.ts` **只缓存失败（5 分钟）、成功不缓存** ⇒ 两次都是真网络往返。

### 7.3 F 项 · 把「WebDAV 可播」这个结论做成短 TTL 记忆【未开工】

**落点**：`backend/src/utils/localSourceProbe.ts` —— 与现有的 `localFailCache`（失败记忆 5 分钟）对称，
补一个**成功记忆**：

```ts
const localFailCache = new Map<string, number>(); // 现状：只记失败（TTL 5min）
// F 项：给 webdav 分支补一个成功记忆
const webdavOkCache  = new Map<string, number>(); // songId -> 成功时间戳（TTL 同量级）
```

| 要点 | 说明 |
|---|---|
| **只缓存 WebDAV 分支** | 本地 `l:` 路径是 `existsSync`（零成本）→ **缓存它零收益、只引入「文件删了还返回死行」的风险**，因此不缓存 |
| **TTL 与失败记忆对称** | 现状「失败判死」5 分钟内不重试（文件恢复了也仍判死）⇒ 成功记忆取同量级是自洽的 |
| **兜底** | 出流失败（404 / 上游 5xx）时逐出该条；并对外暴露一个 `evictProbeOk(songId)` 供调用方主动清 |
| **零链路改动** | `resolvePreferredSong` 的 **6 个调用点**（`/rest/stream` / `serveCastStream` / `serveFlowQueue` / `ensurePlayableStream` 探测 / `resolvePlayableRow` ×2）**全部自动受益**，且顺带消掉 7.2 的双重探测 |

**预期收益**：这四条链路每次 seek 省 **1.0~2.9s**；叠加 `verifyRow` 的重复探测，实际更多。

**验收**：240 上对同一首走 WebDAV 优选的歌**连拖 3 次**：
- `播放优选:web 歌曲切换到核心曲库源` 日志只在**首轮**出现；
- 后续轮次 TTFB 不再有 ~2s 台阶；
- `Failed to send audio chunk` = 0、设备出声三件套齐全。

### 7.4 与 B 项的关系（两条都要治）

四条链路 seek 也走 ffmpeg 输入定位（见 §6.5）⇒ **B 的收益（4~13s）大于 F（1~3s）**。
但两者**不重叠**：F 治「选源那一步」，B 治「拿到输入之后那一段」。建议 **F + B 一起上**，
顺序上先做 B（收益大、且五条链路通吃），F 紧随其后。

## 8. 各链路验收方式（出问题要能定位到段）

> **原则**：每条链路都要能在**不看 UI、不靠人耳**的前提下先拿到服务端证据，再用**设备侧硬判据**收口
> （用户规矩：修复必须测试过播放正常）。三段开销（①选源 / ②ffmpeg 输入 seek / ③WebDAV 探测）
> 各有独立可观测信号，**别混着看**。

### 8.1 通用验收（五条链路都要过）

| 判据 | 怎么取 | 通过标准 |
|---|---|---|
| **落点正确** | 服务端 `[pump][seek] want=… target=…` / `[DLNA][seek] … 重投流完成 timeOffset=Ns` | 落点 = 目标值；随后位置 **1:1** 推进（2s 采样 +2s） |
| **真的在出声** | 见 §8.2 各链路「出声判据」 | 出声判据齐全 + 抓包零字节占比 **<1%** |
| **无异常路径** | `docker logs musicflow \| grep -cE "放行切歌\|冻结\|stalled\|提前 EOF\|frozen"` | **= 0** |
| **无重复解析**（F 项验收） | `docker logs musicflow \| grep -c "播放优选:web 歌曲切换到核心曲库源"` | 同一首连拖 3 次，**只在首轮出现** |
| **上游请求数**（B 项验收） | ffmpeg `-v debug` 里 `Range: bytes=` 次数 / raw 路由计数 | **9 → 1** |
| **端到端耗时** | `docker logs -t` 量「开始获取音源 → 音源就绪」 | 对比基线 **5.1/5.1/5.8/9.4/13.1s** |

> ⚠️ 三条硬规矩：
> ① **`docker restart` 会截断 `docker logs`** → 跨版本对比必须**切换前** `docker logs -t > 落盘`；
> ② **在 240 跑 seek 验证脚本前先问用户是否在操作 UI**（用户拖动会往同一 pump 注入 seek，落点观测失效）；
> ③ **别在 240 并发跑多个 ffmpeg 探针**（拖慢 WebDAV → 推流 starving：设备无声但 pos 在走、日志全绿）。

### 8.2 分链路验收

| 链路 | 出声判据（硬） | 落点判据 | 该链路专属观察点 |
|---|---|---|---|
| **Sendspin** | 设备 VERBOSE 日志三件套齐全：`speaker_mixer:369 Starting` + `i2s_audio.speaker:070 Starting` + `Created ring buffer with size 96000 [speaker_task]`；实体 `MediaPlayerState.PLAYING`；`Failed to send audio chunk` = 0 | `[pump][seek] want=N target=N`；之后 `pos` 每 5s 精确 +5s | 抓包 240→246 零字节 **<1%**；WS 帧恒 **4809B**（9B 头 + 4800B 载荷） |
| **DLNA** | 音箱实际出声 —— **这一条只能人耳**；服务端 `[cast] <deviceId>: BEGIN songId=…` 后不得连续 `Stop failed` 重试 | `[DLNA][seek] <deviceId> SOAP Seek 不可靠 → 重投流重建(timeOffset=Ns)` 之后有 `重投流完成 timeOffset=Ns Xms`；`positionEstimates` 锚到 target | **`unreliableSeek` 设备**才走重投；SOAP 可用的设备应看到 `Seek(REL_TIME)` 成功且落位校验通过 |
| **Web 播放** | 浏览器播放器从目标位置**继续**出声（不是从头） | F12 Network：`/rest/stream?id=X&timeOffset=N` 的 N = 目标秒；看响应**首个音频字节**延迟 | 服务端 `[stream] <id> timeOffset=Ns(拖动重拉)peerId=…` 必须出现（证明拖动真到了服务端） |
| **客户端自己播放**（Flutter/安卓/Win） | 客户端 UI 进度条与声音对齐（**同 Web 一条路**） | 同上（同 `/rest/stream`） | 客户端会带 `peerId`（`local:<uuid>`）→ 可据此区分是哪台设备在拉 |
| **AirPlay** | 设备出声（人耳）；同 host 的 DLNA 会话不被 `stopAirPlaySessionsForHost` 误停 | 原地 seek（RTSP 会话不动、只换 decoder）时**位置不回 0**；回落重投时同 DLNA | `[airplay]` seek 分支日志：原地 vs `seekSec` 重投；`RaopPlayer.realtimeStats` 可观测节拍 |

> **为什么 DLNA / AirPlay 的「出声」只能人耳**：这两条链路的音箱是**独立成品设备**，本仓没有它的日志通道
> （不像 ESP32 可由 ESPHome Native API 订阅 VERBOSE）。可用间接证据是**抓包看到设备持续拉流 + 零字节占比低**，
> 但那**不能证明喇叭在响**（设备可能拉流但不放）。⇒ 这两条链路**首次验收必须人耳确认一次**，
> 之后回归可只跑服务端 + 抓包信号。

### 8.3 按「三段开销」定位故障（出问题时先归段）

| 症状 | 落在哪一段 | 先看什么 |
|---|---|---|
| 位置发布了、但音频迟迟不来 | ①选源 / ②输入 seek | `[resolve] … (reason) ms=` 与 `-ss` 那段耗时 |
| 同一首连拖每次都慢一样多（~2s 台阶） | ③WebDAV 探测（F 未做） | `播放优选:web 歌曲切换到核心曲库源` 是否每次都打 |
| `-ss` 越大越慢、上游请求多 | ②输入 seek（B 未做） | `ffmpeg -v debug` 的 `Range: bytes=N-` 次数 |
| 设备无声但服务端 pos 在走、日志全绿 | **推流 starving**（不是 seek 问题） | 是否在 240 并发跑了 ffmpeg 探针 |
| 拖完进度条自己跳回去 | `SEEK_SETTLE_MS=8s` 未生效 | `player/seekSettle.ts` 的 `idle_early` 拦截日志 |

## 9. C / D / E 项（未开工 / 已撤回）

- **C · 窗口内 seek 走零成本路径**：`PcmWindow.seekTo()` 已实现「命中窗口 → 只挪消费水位、不重起 ffmpeg」
  （`backend/src/services/sendspin/streamSource.ts:234` 的快速分支），但 `seekCore` 目前**总走完整起播重建**
  ⇒ 每次拖动都杀一条 ffmpeg 再拉一条。要让落点落在「已解且未淘汰」区间内时走零成本分支。
  ⚠️ 必须先核对与 `1937f80`（起播窗口内 seek 的世代竞态）的语义边界，**不能把那批修复重新引回来**。
- **D · 前端拖拽预热**：拖动过程中节流预取目标附近字节，把 B 的首个 miss 提前消化。
  卡片 `_seek()` 与网页 `castSeek()` 现状是 **250ms trailing 去抖**（客户端只发 1 次），改前先理清节律。
- **E · `-noaccurate_seek`**：孤立 ffmpeg 实测省 29%（请求数不变），真实路径无法确认收益，
  已按用户决定摘除；原文见 §11.1。

## 10. 附注

### 10.1 诊断脚本（本机 `opencode230/patch/`）

`probe_webdav.js`（源站 Range/TTFB）、`probe_chain.js`（链路逐步计时）、`probe_af.js`（af 链对照）、
`probe_loop.js`（回环 vs 直连）、`probe_http.js`（ffmpeg debug 抓 Range 序列）、`probe_perreq.js`
（单请求耗时分离）、`probe_local.js`（本地文件对照）、`probe_E_240.mjs`、
**`probe_B_240.js`（B 项三条对照，本轮新增）**、
**`probe_pref_cost2.mjs`（§7.2 四条链路调研，2026-09-22 新增）**。

### 10.2 三个坑（已并入 `MEMORY.md`）

1. 给 ffmpeg 传 `-headers` 必须用**数组传参**（`execFileSync(FF, [args...])`）—— 走 shell 会把 `\r\n` 截断，
   ffmpeg 直接 `Error opening input`，量出来的耗时全是假的。
2. 临时 raw token 走 **INSERT 进 `raw_stream_tokens`**（注册表在 SQLite，跨进程可见），别用内存 Map。
3. **在 240 测「模块耗时」用独立进程直接 import dist**：
   `docker exec -w /app/backend musicflow node /tmp/x.mjs`。
   ⚠️ 但**抽样口径要看 `pluginEntry` 而不是 `type`** —— `resolvePlayableRow` 用
   `row.pluginEntry` 判「是不是 web 行」，`resolvePreferredSong` 用 `song.type === "web"`，
   两者口径不同；首版抽样按 `type` 取，恰好全落在 no-swap 样本上，**误判「优选免费」**（已修正）。

### 10.3 相关文档

- `docs/PLAYBACK_SEEK_MA_REWORK.md` —— seek 的语义 / 正确性改造（patch1~10、§6.6 世代竞态）
- `SPEC.md` §1.7 / §1.8 —— `preferRowId` 契约、ffmpeg 输入硬契约
- `docs/audio-pipeline-plan.md` §1.3 / §3.6 —— 转码管道与通道能力表
- `docs/SENDSPIN_ESPHOME_DEBUG.md` §4.1 —— 设备侧「出声三件套」验收判据

## 11. 附录

### 11.1 2026-09-22 原文备查 · E 项（`-noaccurate_seek`）

> 逐字保留被撤回的方案原文与实测，以免以后重走弯路。

```
E `-noaccurate_seek`（实测省 29%，请求数不变）

services/audio/pipeline.ts：DecodeRequest.coarseSeek → 在 -ss 之前追加 -noaccurate_seek
  （输入选项，必须在 -i 前，否则 ffmpeg 当输出选项静默无效）。
services/sendspin/streamSource.ts：推流 decodeArgs({...}) 传 coarseSeek: true。

撤回原因：孤立 ffmpeg 上量到 -29%，但真实 seek 重建路径上无法确认收益，
且同期出现的取流超时经取证另有根因（见 docs/PLAYBACK_SEEK_MA_REWORK.md §6.6）。
```

### 11.2 修订记录

| 日期 | 修订 |
|---|---|
| 2026-09-22 | 建立本文（原名「Sendspin 跳转进度优化专项」）。固化 ①A（已完成 `1bcd473`，含完整优化方法与负向矩阵）+ ②B/C/D/E 五项候选；本轮决定实施 B。E 项原文备查见 §10.1。 |
| 2026-09-22 | **改名《所有播放链路跳转进度优化方案》**：范围从 sendspin 扩到全部五条链路。新增 §7（DLNA / 客户端 / Web / AirPlay 的同一问题调研 + **F 项**方案、§7.2 实测数字与生产铁证）、§6.5（B 覆盖五条链路）、§10.2 第 3 条（独立进程量模块耗时的抽样口径坑）；候选清单由 A~E 扩为 **A~F**。 |
| 2026-09-22 | 新增 **§8 各链路验收方式**（通用验收矩阵 + 五条链路分项判据 + 按三段开销定位故障）；其后章节下移（原 §8/§9/§10 → §9/§10/§11）。 |
