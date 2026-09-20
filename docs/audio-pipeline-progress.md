# 音频流水线改造 · 总任务清单（唯一权威）

> **本文件是整个改造的唯一任务真相源** —— 任务状态、交付物、验收口径一律以本文件为准，**不另设分阶段文档**。
> **规格（怎么做、为什么这么做）的真相源是 [`docs/audio-pipeline-plan.md`](audio-pipeline-plan.md)**：
> 六段流水线设计、决策点 D1–D10、MA 源码实证、风险表。两者冲突时以 plan 为准，本文件随之更新。

**最终目标**：把 **客户端 / Web / DLNA / Sendspin / AirPlay** 五条链路统一走服务端实时管道
（解码 F32 → 响度标准化 → DSP → 交叉淡入 → 限制器 → 通道编码），**响度标准化全覆盖、不留任何直传旁路**（D9）。

创建：2026-09-20 ｜ 最后更新：**2026-09-20（P5-3 完成 → 可选优化层落地，36/39）** ｜ 截至本轮开工 main 位置 `3a57f62`（P0–P4 各阶段提交均在 230 本地已提交、**未 push**，见 §10）

---

## 0. 这份文档怎么用（强制执行）

1. **每完成一小项，立刻回来标 ✅、填 commit 短 SHA 与完成日期** —— 不允许攒着批量补记，也不允许「代码写了但没测通就标完成」。
2. 每打一次勾，必须同步三处：**该阶段小节的 `完成度 x/y`**、**§2.1 总览表对应行**、**§2.2 总体进度数字**。三者不一致即视为文档失效。
3. 「完成」的判定 = **代码已合入 main + tsc 通过 + 相关单测通过**；仅本地验证未提交标 🟡。
4. 遇到阻塞 → 标 ⏸ 并写进 **§10 阻塞登记**（含发现日期与绕过方案），不许静默卡住。
5. 阶段誊绿后必须回填 **验收结果**（实测数据 / 结论 / 日期），不能只写「已完成」。
6. 调整任务本身（合并 / 拆分 / 取消）时，本文件与 **plan §6** 同步修订，保持编号一一对应。

**状态图例**：⬜ 未开始 ｜ 🟡 进行中 ｜ ✅ 已完成 ｜ ⏸ 阻塞 ｜ ⏭ 远期（本轮不做） ｜ ❌ 已取消

**开工前必读的两条红线**：

| 编号 | 红线 | 违反后果 |
|---|---|---|
| **D9** | **不保留任何直传 / 直透旁路** —— 关闭开关只等于「滤镜链为空」，**不代表绕过管道** | 某条链路又回到无标准化状态，等于白改 |
| **D10 / SPEC §1.8** | 解码段喂给 ffmpeg 的输入**只允许回环 token URL 或本地文件路径**，不能是上游直链 | 踩回两个老坑：Alpine 静态 ffmpeg DNS 全坏（`System error`）、跟随 302 把 `Authorization` 头带给 CDN（天翼 OBS `400 InvalidAuthType`） |

---

## 1. 六段流水线与五条链路（一图定位）

```
              ┌────────────── 全通道共用（服务端） ──────────────┐
  源 → ① 解码 F32 → ② 响度标准化 → ③ DSP → ④ 交叉淡入 → ⑤ 限制器 → ⑥ 通道编码 → 设备
              └─────────────────────────────────────────┘
                                                     ↑ 只在 ⑥ 分叉
   ⑥ 的分叉：客户端/Web（HTTP）｜ DLNA（HTTP）｜ Sendspin（FLAC/opus/PCM）｜ AirPlay（RAOP）
```

**为什么必须先动最后那条**：现在客户端 / Web 拿到的就是源文件的原始字节（零 CPU、保 Range），压根不经过 ②⑤ —— 这是「有的链路有标准音、有的没有」的根因。

---

## 2. 总览仪表盘

### 2.1 阶段进度

| 阶段 | 主题 | 完成度 | 状态 | DoD 一句话 |
|---|---|---|---|---|
| **P0** | 数据层与响度核心 | 6 / 7 | 🟡 | P0-4 入口就绪待 P1 管道喂 stderr，其余全绿 |
| **P1** | 管道骨架 + Sendspin / AirPlay | 7 / 7 | ✅ | ESP32 / AirPlay 首播即被归一化，回录曲目间差 ≤ 1 LU |
| **P2** | HTTP 通道实时管道化 | 8 / 8 | ✅ | 客户端 / Web / DLNA 走管道，**客户端 + Web 拖动进度可用**，删净直传分支（含搜索即播的 `/stream-remote`） |
| **P3** | Smart Fades L0 | 8 / 8 | ✅ | flow 会话（两路解码并存 + F32 逐片加权混合）+ 队列静默推进，开关缺省关 |
| **P4** | DSP | 4 / 4 | ✅ | 四个常用滤镜可用，空配置零开销 |
| **P5** | 收尾与远期 | 3 / 5 | 🟡 | 开关 UI + 可选优化层齐备（P5-1/5-2/5-3）；P5-5 文档转正待做，P5-4 远期不做 |
| **合计** | | **36 / 39** | 🟡 P5 进行中 | 验收总口径见 plan §8 |

### 2.2 总体进度

**36 / 39（92%）**

### 2.3 当前焦点

**P5-3 收官（可选优化层）**：实时 `loudnorm` 是主路径，但**自持源**（local 行）的文件今天明天都一样，可以把这次分析提前做掉、以后走静态增益。新增 `services/audio/offlineMeasure.ts`（**默认关**）：只选 `l:` 前缀的 local 行、只选**还没测过**的（重复触发幂等），跑一次 `loudnorm … print_format=json -f null -` 把集成响度/真峰值经 `saveAnalysis()` 落进 `audio_analysis` —— 用的是**实时路径同一个解析器** `parseLoudnorm()`，两条路的测量口径因此按构造成对。串行执行（模块级 `running` 闸门=唯一并发闸门，不占 playback 池），手动触发为异步 + 前端轮询进度。**「热点曲目输出缓存」按 plan §2 决策不做**（缓存命中即绕过 ②–⑤，且改一次目标响度/DSP 就整库失效）。**下一步 P5-5**（文档转正 + 结项标记；P5-4 标 ⏭ 远期不做）。

### 2.4 阶段依赖

```
P0（数据层，可独立上线）
 └── P1（管道骨架）── P2（HTTP 三通道）── P3（交叉淡入，依赖 P1 的 flow 能力）
                                     └── P4（DSP，挂在 P1 的出流 -af 链上）
                                           └── P5（收尾）
```

---

## 3. P0 · 数据层与响度核心 — 6 / 7 🟡

**为什么先做它**
当前没有任何响度元数据字段（`db/schema.ts` 全表零命中），于是：① 曲库响度参差不齐但服务端无从得知差值；② 需要在「静态 `volume`」与「实时 `loudnorm`」之间决策却没有依据。先把数据层与三个纯函数做掉，后续管道才能直接取用；本阶段不动播放路径，风险最低、可单独上线。

**成功标准**
1. `parseLoudnorm()` 行为与 MA `parse_loudnorm` 一致：`-inf`（数字静音）返回 `null`、JSON 解析失败返回 `null`、正常取 `input_i` / `input_tp`。
2. `chooseMode()` 的 6 个分支全覆盖（含 `FALLBACK_DYNAMIC` 走实时 loudnorm 的支路）。
3. 三个纯函数不依赖 DB / 网络；`computeGainDb()` 增益限幅 ±12 dB。
4. **网络源播放后 `audio_analysis` 表无新增行**（D8：网络源一律不回写，永远走实时 loudnorm）。
5. **人为让源不可达后触发扫描，既有回写一条不少**（P0-6：差集清理仅在源探测成功后执行）。
6. **行级绑定**：删除 local/webdav 行后其回写归零；换源行取对应行的值，不得错配。
7. 本阶段结束时不改动任何播放行为。

**任务清单**

| 状态 | # | 任务 | 落点 | commit | 完成日期 | 备注 |
|---|---|---|---|---|---|---|
| ✅ | P0-1 | 建表对齐 MA `AudioAnalysisData`：`loudness_integrated` / `loudness_album` / `loudness_range` / `true_peak` / `bpm` / `beats` / `downbeats` / `beats_per_bar` / `key` / `mode` / `rms_energy` / `spectral_centroid` / `energy` + `measured_at`，行级 + drizzle 迁移 | `backend/src/db/schema.ts` | （建表时已合入） | 2026-09-20 | 表已存在，逐字段核对齐；DB 表 38 → **39**，SPEC §2.1 已同步。**回查补漏（对照本地 MA 源码）**：首版漏了 10 个高层描述子＋`extra_data`，已补；存量库 PRAGMA 探列补加 |
| ✅ | P0-2 | `parseLoudnorm()`：解析 ffmpeg stderr 的 loudnorm JSON（照 `helpers/audio.py:881-901`） | 新增 `services/audio/loudness.ts` | （已合入） | 2026-09-20 | 纯函数之一 |
| ✅ | P0-3 | `chooseMode()` 模式决策 + `computeGainDb()` 增益计算 | 同上 | （已合入） | 2026-09-20 | 纯函数，必须可单测；判定顺序与 MA `get_normalization_mode` 逐项一致（含后补的 `isSoundEffect→disabled`）；增益**不限幅**（全面对齐 MA：裸差值 round 2 位，削波由⑤限制器兜底）；`prefer_album_loudness` 暂不支持（字段已存，待用） |
| 🟡 | P0-4 | 边播边测回写：**仅 `local` / `webdav` 行**按 `row.id` 入库；网络源行解析后丢弃（D8） | `analysisStore.reportPlaybackLoudness(rowId, stderr)` + 播放结束钩子 | — | — | **入口＋单测已就绪；sendspin 自然播完已接入（P1-2），其余通道待 P2/P3 管道 stderr 落点** |
| ✅ | P0-5 | 单测：JSON 解析（含 -inf / 解析失败）、模式选择全分支、增益限幅、行级绑定 | 新增 `tests/services/loudness.test.ts` | （已合入） | 2026-09-20 | 24 用例全绿，分支覆盖见文件 |
| ✅ | P0-6 | 回写清理联动：删行同事务删回写；扫描差集删除仅在源探测成功后执行，失败跳过并记 warning | 源清理 / 扫描逻辑 + `loudness.ts` | （本轮） | 2026-09-20 | 5 处落点：webdav 差集（visited>0 门）/local 差集（走完即算可达）/源删除/单曲删除；purge 只删 web 行，按 D8 永无回写故不碰。顺序一律**先回写后歌曲行**（FK 无 CASCADE，反了直接抛错——外键把顺序 bug 变成了 loud error）。`Statements` 类型顺手修（`ReturnType<typeof prepare>` 命中单参数重载） |
| ✅ | P0-7 | 单测：网络源不回写（断言 DB 无记录）、源不可达时清理不执行、行删除后回写归零 | `tests/services/loudness.test.ts` 扩展 | （本轮） | 2026-09-20 | 新文件 `tests/services/analysisStore.test.ts` 5 例全绿：入库门 3 例＋删行联动 1 例＋本地扫描 E2E 1 例（真 mp3＋真扫描：删文件重扫行/回写双清、源目录消失抛错回写保留） |

**验收结果**：`reportPlaybackLoudness`：local 行有效报告入库（-9.54）、web 行丢弃、垃圾/-inf/无行均 false 且无记录；`deleteSongDb` 删单曲回写归零；本地扫描 E2E：文件删→重扫行/回写双清，源目录消失→抛错且回写保留（-6.0）。全量 159 文件 / 1204 用例绿（2026-09-20）。

---

## 4. P1 · 管道骨架 + Sendspin / AirPlay（①②⑤⑥）— 7 / 7 ✅

**为什么做**
Sendspin 现在硬编码 `-ar 48000 -ac 2`、AirPlay 硬编码 44100 s16le，都不做响度处理；P0 只产出数据与增益值，需要一条真实的管道把它们吃进去。这两条链路本来就跑 ffmpeg（只是多一条 `-af`），改造成本最低、见效最快。

**成功标准**
1. ESP32-S3 与 AirPlay 各连播 **10 首网络源**曲目（未做任何预测量），回录 integrated LUFS **曲目间差异 ≤ 1 LU**，true peak ≤ −1 dBTP。
2. **首次播放即生效** —— 不需要先播一遍攒测量值（依赖 P0 的 `FALLBACK_DYNAMIC` 实时 loudnorm）。
3. 解码段输入严格遵守 SPEC §1.8，并有契约测试锁死。
4. 采样率 **snap-down**（≤ 源速率，绝不升采样）；F32 仅在「跑处理」时使用。
5. 输出段 dither 为 `osf=s16:dither_method=triangular_hp`（仅 >16bit→16bit 时）。
6. 链中有 loudnorm 时重采样降级 `swr`（规避 ffmpeg ticket 11323），单测断言。

**任务清单**

| 状态 | # | 任务 | 落点 | commit | 完成日期 | 备注 |
|---|---|---|---|---|---|---|
| ✅ | P1-1 | 新增 `AudioPipeline`：**两段式**（① 解码 → PCM `AudioBuffer`；② 出流 ffmpeg 吃 stdin PCM + `-af` 链 + 输出格式） | 新增 `services/audio/pipeline.ts` + `audio/buffer.ts` | （本轮） | 2026-09-20 | 本轮只做纯参数拼装（decode/loudness/limiter/output/codec）＋哑容器 AudioBuffer，零进程零副作用；`decodeArgs` 无 `-ar/-ac`（跟随源）；dither 仅 >16→16 加 `triangular_hp`；loudnorm 在链时重采样降级 `swr` |
| ✅ | P1-1b | 解码段输入必须遵守 **SPEC §1.8**（回环 token URL / 本地文件路径），并加契约测试锁死 | `pipeline.ts` + `tests/sendspin/ffmpegInputContract.test.ts` | （本轮） | 2026-09-20 | 合规门下沉到 audio 层 `resolvePipelineInput`（`streamEngine` 旧函数改走别名，调用方零改动；audio 不反向依赖 sendspin）；锁死 IP 字面量＋鉴权头包回环、大写 scheme、空输入早抛、相对路径放行 |
| ✅ | P1-2 | Sendspin 接入（替换 `ffmpegArgs()` 的硬编码 48k 解码） | `sendspin/streamSource.ts` | （本轮） | 2026-09-20 | `resolveSendspinAf()`：逃生舱/单源关→空链（与旧命令逐字节一致）；缺省 D2 实时 loudnorm＋限制器，有测量走静态 volume；48k 立体声由 forceRate/Channels 保证（P1-4 再拿掉）；`decodeArgs` 补 headers/inputFormat/af 透传；loudnorm 在链时 loglevel 提 info（否则 JSON 被过滤，P0-4 实测抓到的坑）；stderr 全量保留＋`stderrText()`；自然播完调 `reportPlaybackLoudness`（P0-4 sendspin 落点，stop/异常无 JSON 即 false） |
| ✅ | P1-3 | AirPlay 接入 | `airplay/decoder.ts` | （本轮） | 2026-09-20 | `buildAirplayAf`（响度＋限制器＋44100 pin＋triangular_hp，44.1k/16bit/stereo 是 RAOP 协议硬性要求、非过渡）；输入合规门（非回环 http 直接抛）＋调用点回环包装（fork 在主进程包，子进程信任回环）；stderr 全量＋`stderrText`；P0-4 双模式：in-proc 会话结束直调、fork 经 sessionEnded 事件带 stderr（子进程不碰 DB，主进程按 lastCast 落库）；`handleAirplaySessionEnded` 导出可测 |
| ✅ | P1-4 | 输出段 dither `triangular_hp`（仅 >16bit→16bit）；确认 Sendspin 编码层对非 48k 输入的处理 | `sendspin/encoding.ts` | （本轮） | 2026-09-20 | 确认结论：Opus 帧常量/libFLAC 实例率/时间线数学全是 48k 硬编码，真跟随源要重写三处，不划算 → sendspin 输出**恒 48k 立体声**（ESP32 固定 I2S），但重采样点从输出选项挪进 af 链（loudnorm 跑在源采样率，单次重采样）；`outputFilters` 加 `forceChannels`（aformat）；44.1k→48k 实测长度比正确；对拍（swr 直通透明）仍过 |
| ✅ | P1-5 | 客户端/Web 已选音质档位时并入同一次转码，**不额外起进程** | `services/transcode.ts` `spawnTranscoder()` | （本轮） | 2026-09-20 | `transcodeArgs()` 纯函数：经统一管道装配（输入段＋af＋编码），无 af 与旧命令一致；stderr 常开排空（防 64KB 憋住）；单测锁 mp3/aac 命令形态 |
| ✅ | P1-6 | 单测：参数拼装、模式切换、限制器/dither 随位深开关、loudnorm 时重采样降级 `swr` | `tests/sendspin/ffmpegInputContract.test.ts` 扩展 | （本轮） | 2026-09-20 | `resolveLoudnessAf` 模式切换＋整命令段序单测落 `pipeline.test.ts`；另对照本地 MA 源码回查：aresample 合并为单个（分开写跑两遍）；增益不限幅（全面对齐）；`isSoundEffect→disabled` 补齐；描述子字段补齐见 P0-1 注 |

**依赖与注意**
- 依赖 P0 —— 未完成则管道无法产出自适应增益。
- **两段式不是可选优化**：解码 → PCM `AudioBuffer` → 第二条 ffmpeg 吃 stdin。图省事退化成单条 `-af`，后面 P3 的 flow / 交叉淡入直接做不了。
- `dlna/control.ts` 的 `?raw=1` 直透分支**本阶段先保留** —— 它是给 ffmpeg 喂料的输入端点，删除要等 P2-2。

**验收结果**：*待填（回录 LUFS / true peak 实测值 / 日期）*

---

## 5. P2 · HTTP 通道实时管道化 — 8 / 8 ✅

**为什么做**
现在客户端 / Web 拿到源文件的原始字节，完全绕开响度标准化段；DLNA 侧还有一条 `?raw=1` 直透分支。要让「五条链路全覆盖」成立，这三条必须全部改道。

**成功标准**
1. 客户端与 DLNA 各连播 10 首网络源曲目，回录 LUFS **曲目间差异 ≤ 1 LU**。
2. **客户端拖动进度实测通过**（本阶段最容易漏的一项）。
3. 首字节 < 500 ms。
4. `/rest/stream` 与 `/rest/dlna/stream` **不再有任何原样直出路径**，且该断言写进契约测试回归锁住（D9）。
5. 响应带 `X-MusicFlow-Transcoded: 1`；MIME 按实际输出格式给出（DLNA 拒 FLAC 回退 MP3 320）。
6. HTTP 出流响应头四项齐备：`Content-Type` 随实际格式、`contentFeatures.dlna.org` realtime 标记、ICY 仅当设备请求 `Icy-MetaData:1` 时给、`http_profile`（默认 `forced_content_length` 给 12 小时假长度）。

**任务清单**

| 状态 | # | 任务 | 落点 | commit | 完成日期 | 备注 |
|---|---|---|---|---|---|---|
| ✅ | P2-1 | `/rest/stream` 走管道；**删除原样拉流分支**；响应加 `X-MusicFlow-Transcoded: 1` 头（D9） | `backend/src/routes/rest/index.ts` | （本轮） | 2026-09-20 | 新增 `servePipelinedSong`（解码→af→按源族编码单进程）＋`serveFfmpegPipe` 公用出流（并发槽/abort/stderr/P0-4）；`serveTranscodedSong` 改走 `transcodeArgs`＋af 透传；D4 跟随源族（wav→FLAC 等，`resolveChannelCodec`）；Range 一律全流 200（P2-3 接）；缺文件仍 404；P0-4 双路径自然播完上报 |
| ✅ | P2-2 | `/rest/dlna/stream/:token` 走管道；**删除 `?raw=1` 直透分支**（D9）；MIME 同步 | 同上 + `plugin/renderers/dlna.ts` + `dlna/control.ts` | （本轮） | 2026-09-20 | web/webdav/本地统一 `servePipelinedSong`（codecOverride=`resolveDlnaOutput`：ogg 系→mp3 320，其余跟随源族）；旧嗅探/探测/`serveDlnaWebStream` 整段删除（上游错标由 ffmpeg 自适应）；cast/enqueue/DIDL mime 共用 `resolveDlnaOutput`（三处 `DLNA_MIME` 表删除）；tier 转码分支补 songId（P0-4）。全量 161/1251 绿 |
| ✅ | P2-2b | HTTP 出流响应头四项（照 MA `streams/controller.py:1296-1318`） | `routes/rest/index.ts` + `dlna/control.ts` | （本轮） | 2026-09-20 | `contentFeatures.dlna.org`＋12h 假 Content-Length 恒带（flac 按 1411k 估）；ICY 仅设备请求时给（`icy-metaint: 16384`＋`TransformStream` 空元数据装帧，零块步长 16385）；`serveFfmpegPipe` 新增 `extraHeaders`/`icyMetaint` |
| ✅ | P2-3 | **客户端 seek 判定改造（必做）**：改为按响应头 / 服务端能力判定 | MusicFlow-client：`lib/providers/player/transcoded_stream_seek.dart` + `player_playback_helpers.dart` | （本轮） | 2026-09-20 | `shouldUseServerTimeOffsetSeek` 新增 `serverPipelinedHttp` 开关（true 无条件 timeOffset 重拉）；`serverPipesAllHttpStreams` 版本门控（MusicFlow ≥ 3.0.47，Navidrome/老版/未知保守 false）；三处调用点叠加；预览/离线不受影响；共享契约表默认行为不变。客户端仓库已推 main，本机无 Flutter SDK，`flutter test` 待客户端 CI |
| ✅ | P2-4 | Web 端 seek 适配：无 Range 时按 `timeOffset` 重建 URL，进度用 offset 补偿 | `frontend/src/stores/player.ts` + 新增 `frontend/src/utils/transcodedSeek.ts` | （本轮） | 2026-09-20 | `localSeek` 改为带 `timeOffset` 重拉（服务端 `-ss` 前置定位），**250ms trailing debounce**（el-slider `@input` 每帧触发，不防抖一次拖拽会起几十个 ffmpeg）；`localStreamOffset` 补偿进度 / 时长 / 歌词（`toLogicalPosition`，时长按 `howl.duration()+offset` 还原全曲）；同一整秒内的微调不重拉；暂停态拖动只重建不自动播；seek 重建不重复 scrobble；纯函数 `utils/transcodedSeek.ts` + 12 单测。`vue-tsc --noEmit` 0。**真机拖动进度待人工验收** |
| ✅ | P2-5 | 并发池上调 + 归一化独立并发，不抢音质转码的槽 | `services/transcode.ts`（＋`routes/rest/index.ts` 接线） | （本轮） | 2026-09-20 | 单池 4 槽 → **两个独立池**：`quality`（客户端显式要 format/maxBitRate 的音质转码，上限 `TRANSCODE_MAX_CONCURRENT`，默认**核数**、下限 4 上限 8）／`pipeline`（默认实时管道，上限 `TRANSCODE_PIPELINE_MAX_CONCURRENT`，默认**核数 ×2**、下限 6）——8 核机即 8 / 16，均照 MA `constants.py:211` 的按核数派生方式。acquire 改**租约制**（返回释放函数、幂等）以防分池后释放落错池；`serveFfmpegPipe` 的 `slot` 必填（音质转码传 quality、默认管道传 pipeline），避免默认值把音质请求静默降级；实际排队时记一次日志（首字节延迟可观测）。单测重写 6 例（派生公式 / env 覆盖与非法值回退 / 幂等 / 池内排队 / **两池互不抢槽** / 合计计数） |
| ✅ | P2-6 | 契约测试：开关开/关、换源行增益变化、MIME 随格式变化、响应头存在、DLNA 拒 FLAC 回退、**断言两个路由都不再有原样直出路径** | 新增 `tests/rest/pipelineContract.test.ts`（＋`resolveRequestAf` 导出） | （本轮） | 2026-09-20 | 8 例：①**结构锁**（D9 回归锁）—— 按文本标记切出两个 handler 源码段，断言段内无 `createReadStream` / `Accept-Ranges` / `getParam(c,"raw")`，DLNA 段**只从 `resolveCastToken` 之后**断言（回环 `raw` 分支是 ffmpeg 取源通道，SPEC §1.8，必须留）；`X-MusicFlow-Transcoded` 全文件只定义一次 ⇒ 所有出流同一出口；`serveDlnaWebStream` 不许复活。②**开关**：`pipeline.http=0` → `resolveRequestAf` 空链，且两个路由**仍**返回管道出流（X 头 + FLAC 容器 + 无 Content-Length + 音箱兼容头）⇒「关开关 ≠ 绕过管道」。③**换源行增益**：同曲两行各写测量 → `volume=6dB` / `volume=-6dB`，换到无测量行回 loudnorm 且 DB 无记录。MIME 随格式 / 响应头 / DLNA 拒 FLAC 回退已由 `transcodeStream.test.ts`、`dlnaOggFallback.test.ts`、`services/pipeline.test.ts` 覆盖，本文件不重复。顺带修 2 处与实现不符的注释（DLNA 路由「走原样拉流，行为不变」、`transcodedSeek.ts` 谎称 `/stream-remote` 已走管道） |
| ✅ | P2-7 | **新发现（文档外补充）：`/rest/stream-remote` 走管道，删 `serveWebSongStream` 直出** —— 搜索即播的未入库远程歌仍是原样代理上游字节（`c.body(upstream.body)`＋`Accept-Ranges`＋上游 Content-Length），**无响度标准化**，是 D9 之后残留的第三处直出 | `backend/src/routes/rest/index.ts`（唯一调用点）、`frontend/src/stores/player.ts`（`probeRemoteFormat`） | （本轮） | 2026-09-20 | ① **出流改管道**：`serveWebSongStream` 整段删除（含 `cachePath` 死分支），`/stream-remote` 与 `/rest/stream` 共用 `servePipelinedSong`＋`resolveRequestAf(null)`（无 DB 行 → 无测量 → 实时 loudnorm）；补 `timeOffset` 透传（管道流无字节 Range，不补则搜索即播拖不动）。② **换源前移**（关键，文档原先没写）：URL 交 ffmpeg 后主进程再没换源机会，故新增 `resolveRemoteStreamUrl()`（`streamFallback.ts`）在出流前用**一次轻量 probe**（`Range: bytes=0-20000`，带 TTL 正缓存）裁决 —— ok→原链、gone→多源换源、gone 且换不到→**null → 404**（不再起注定失败的空管道）、transient→原链（网络抖动绝不判死；这是与 `ensurePlayableStream` 的有意分歧）。③ **前端联动**：`probeRemoteFormat`＋`remoteFmtCache`＋`playbackSeq` 整段删除 —— 那条 `Range: bytes=0-0` 的 GET 在管道化后会把 body 丢着不读、**常驻烧一个转码槽**；改为 `isRemoteSong(song) ? "mp3"` 直接定格式，`useEntitySearch` 的 `_suffixKnown` 随之作废删除。④ **决策：输出固定 mp3 320** —— 该路由的"源格式"只有插件的 `suffix` 提示（现无内置插件给出），不可靠，而 Howler 必须**起播前**知道 format；固定值免掉跨语言格式协商（代价：上游无损源不再按 flac 直出，见 §9 后续项）。⑤ 结构锁扩到第三个路由 + 前端源码锁（不再出现 `probeRemoteFormat` / `Range: bytes=0-0`）；`streamRemoteFallback.test.ts` 重写为**真 HTTP 上游**（stub 的 fetch 拦不住 ffmpeg 子进程）

**依赖与注意**
- 依赖 P1 —— 三条链路复用同一套 `AudioPipeline` 与响度决策。
- **P2-3 漏做 = 客户端拖动进度直接失败**：客户端现有判定依据是「是否支持 Range」，实时流不再给字节 Range，必须改按响应头判定。还要跨仓库改 MusicFlow-client。
- **P2-4 Web 端同源问题**：Howler 的 `howl.seek(t)` 同样依赖字节 Range → 已改为带 `timeOffset` 重拉。因前端资源随镜像发布、与后端同版本，**无需 P2-3 那样的版本门控**；但 `el-slider @input` 每帧触发，**必须 250ms 防抖**，否则一次拖拽会起几十个 ffmpeg。
- DLNA 的 `REL_TIME` seek 退化是**已接受代价（D5）** —— UI 进度走服务端状态 / WS 推送不受影响；保留单设备回退开关（P5-2）。
- **并发池归属别弄反（P2-5）**：`quality` 池＝「客户端显式要了 `format` / `maxBitRate`」，`pipeline` 池＝「默认实时管道（含 DLNA 按设备能力选输出）」。判据是**谁决定的输出格式**，不是「是否真的在编码」。P3-6 给交叉淡入预留槽位时只调 `pipeline` 池上限，**不要**把交叉淡入记进 `quality` 池 —— 那会把用户显式点的高码率请求挡在队列里（正是拆池要避免的事）。
- **P2-7 收口记录**：`/rest/stream-remote` 是「搜索即播」的唯一入口（Web 搜索结果 `useEntitySearch` 与 HA 卡片都把 `streamUrl` 指向它），不做则「五条链路全覆盖」不成立 —— 未入库远程歌永远绕过响度标准化，而这类歌（在线源、未预测量）恰恰最需要归一化。两条踩过的坑已固化：**①换源必须前移到出流前**（ffmpeg 只会报错退出，主进程再无机会换源）；**②旧的 `Range: bytes=0-0` 格式探测必须删**（管道流拉起的是真 ffmpeg，body 不读 = 常驻烧一个转码槽），输出格式改为服务端定死、前端直接采用。
- **有意取舍（备查，非本轮任务）**：搜索即播的输出固定 mp3 320，上游若是无损源（go-music-dl flac 等）不再按源族直出无损耗。理由是「源格式」在该路由上只有插件的 `suffix` 提示、且**现无任何内置插件给出**，按它定格式等于猜；真要跟随，需要一条「服务端定格式 → 前端起播前可知」的协商通道，收益不确定，故不做。

**验收结果**：`/rest/stream`＋`/rest/dlna/stream/:token`＋`/rest/stream-remote` 三个出流路由全部走 `servePipelinedSong`／`serveFfmpegPipe`（`X-MusicFlow-Transcoded: 1` 全文件只定义一次）；`pipeline.http=0` 时两路由仍返回管道出流 ⇒「关开关 ≠ 绕过管道」。`tests/rest/pipelineContract.test.ts` 10 例（含三路由结构锁 + 前端源码锁）、`tests/routes/streamRemoteFallback.test.ts` 5 例（真 HTTP 上游 + 真 ffmpeg：原链可播走管道、404→严格换源、无一致候选→404、Live 后缀严格对齐）全绿。全量 **163 文件 / 1278 用例**绿。**客户端 / Web 真机拖动进度仍待人工验收**。

---

## 6. P3 · Smart Fades L0（标准交叉淡入）— 8 / 8 ✅

**为什么做**
这是六段里的第 ④ 段，也是用户最能直接感知的一层：连播从「一首结束 → 短暂静默 → 下一首开始」变成平滑过渡。MA 是把多条 ffmpeg 流在时序上拼接、对重叠窗口做加权混合；我们能落的最小可行版本就是 L0 标准交叉淡入，**不做 ML 智能混音**。

**成功标准**
1. 连播**无间隙、无爆音**；过渡窗口内回录 LUFS 波动 ≤ 1 LU。
2. 混合时长可配（默认 8s，下限 3s 对齐 MA），权重曲线连续。
3. **过渡期间增益不跳变** —— 必须实现 `normalization_override` pin 住两首歌各自的归一化模式（照 MA `streams/audio.py:1683`、1749）。
4. 重叠长度必须**按帧对齐**：`crossfade_size = bytes // frame_size * frame_size`（照 `fades.py:389-394`），否则混合器**静默不出声**且无任何报错。
5. 曲尾静音不计入过渡窗口（静音剥离有效）。
6. DLNA 侧过渡期间能拿到曲目边界信息（ICY 元数据注入）。
7. 关闭开关回到逐首播放 —— **但仍走管道**（D9）。

**任务清单**

| 状态 | # | 任务 | 落点 | commit | 完成日期 | 备注 |
|---|---|---|---|---|---|---|
| ✅ | P3-1 | **flow mode**：把队列连续曲目拼成一条不间断流（两路解码并存） | 新增 `services/audio/flow.ts`＋`services/audio/flowSource.ts` | （本轮） | 2026-09-20 | 引擎：一条编码 ffmpeg + 每曲一条解码 ffmpeg（**懒预取**：距本曲结束「过渡窗口 + 2s」时拉起下一路）；`pumpHoldBack()` 扣住尾部过渡窗口字节，等下一曲首段到齐再混。接线：`flowSource.selectFlowCandidates()` 从**服务端权威队列**（`QueueController.snapshot`）取「当前首起、顺序连续」的曲目；`serveFlowQueue()`（`routes/rest/index.ts`）逐首解析输入 + af 并起会话。**HTTP 侧必须显式 opt-in**（`flow=1`＋`peerId=`）—— HTTP 客户端的"下一首"由客户端自己推进，服务端替它拼流会两边各推进一次 → 跳歌；**DLNA 侧**队列本就由服务端持有（`cast token` 带 `deviceId`，新增 `resolveCastSession()`），故可默认接管。内存仍封顶（两路解码 × F32 交错，会话级不缓存整曲） |
| ✅ | P3-2 | **标准交叉淡入**：F32 逐片加权混合，时长可配 | 新增 `services/audio/fades.ts` | （本轮） | 2026-09-20 | `mixCrossfade()` 逐帧 `outgoing×w_out + incoming×w_in`；权重曲线 `equal_power`（cos/sin，`w_out²+w_in²≡1`，缺省）/ `linear`；时长缺省 8s、**下限 3s**（对齐 MA `MIN_CROSSFADE_DURATION = 3`）。**不用 ffmpeg `acrossfade`**：它要求两个输入预对齐且长度已知，而两路是流式、长度未知（plan §3.4-2） |
| ✅ | P3-3 | **静音剥离**：曲尾静音不计入过渡窗口 | `fades.ts`（`trailingSilenceFrames` / `effectiveFadeFrames`） | （本轮） | 2026-09-20 | 阈值缺省 −60 dBFS（`FADE_DEFAULT_SILENCE_DB`）；逐帧判「**所有**声道都低于阈值」才算静音（单声道有声即非静音）。有效窗口 = `min(配置, 可用) − 静音`，且不为负 ⇒ 整段静音时窗口归零（宁可不混，也不要淡一段静音）。会话里实测：尾部 3s 静音 ⇒ `crossfades=0` 且静音被丢弃（不再"淡出完还在放静音"） |
| ✅ | P3-4 | **`normalization_override`**：过渡期间 pin 住两首歌各自的归一化模式 | `flow.ts` + `routes/rest/index.ts`（`resolveFlowAf`） | （本轮） | 2026-09-20 | 做法比 MA 更彻底：**每曲的 af 链在会话启动前一次算定**（`FlowItem.af` 必填），会话内部只读不重算 —— flow.ts **不 import** 任何响度/分析/设置模块（结构锁断言），过渡途中不可能因重解析而改增益。限幅器**不**进每曲的 af（`resolveLoudnessAf({includeLimiter:false})`）：两路相加后才可能超 0 dBFS，限幅必须在混合之后（⑤ 在 ④ 之后） |
| ✅ | P3-5 | DLNA 侧 flow mode + ICY 元数据注入 | `dlna/control.ts`（`resolveCastSession`）＋`routes/rest/index.ts` | （本轮） | 2026-09-20 | cast token 一直在会话表里带 `deviceId`，只是没往外暴露；`resolveCastSession()` 暴露后 DLNA 路由即可取该设备队列。`icyFrameStream()` 增加**动态元数据提供者**：每个 `icy-metaint`（16384）间隔现读一次「当前曲目」→ 发真实 `StreamTitle='Artist - Title';` 块（长度字节 = 16 字节分片数，块 = `1 + N×16`）；无提供者时逐字节等价 P2-2 的 1 字节 `0x00`。`timeOffset > 0` 一律不走 flow（连续流没有稳定的"第 N 秒"语义） |
| ✅ | P3-6 | 并发池预留额外槽位（过渡期 CPU 翻倍） | `services/transcode.ts` | （本轮） | 2026-09-20 | 新增**第三个池 `flow`**（上限 `TRANSCODE_FLOW_MAX_CONCURRENT`，缺省 `max(4, 核数)`），计费单位 = **存活解码器数**（稳态 1 / 过渡期 2）⇒ 8 核可同时有 4 个会话处在过渡期。交叉淡入**不占 `pipeline` 池**：不这么做则过渡瞬间的额外一路会去抢普通出流的槽（plan §3.4-7） |
| ✅ | P3-7 | 单测：混合权重曲线、静音剥离、增益不跳变、开关关闭行为 | 新增 `tests/services/fades.test.ts`＋`tests/services/flow.test.ts`＋`tests/services/flowSource.test.ts` | （本轮） | 2026-09-20 | 三层各锁一段：**数学层** 26 例（帧对齐取整 / 曲线起止点与单调性 / 等功率功率守恒 / 静音剥离 / 不等长与未帧对齐抛错 / 配置归一化）；**会话层** 8 例（真 ffmpeg：两路解码并存 `decoders=2`、5s+5s−3s=7s、关开关=10s 直通、尾静音不成过渡、单曲同实现、abort 幂等且 `done` 收敛、命令组装、**结构锁**）；**接线层** 13 例（开关缺省全关 / 队列选曲只在顺序播放 / ICY 块格式与分片数） |
| ✅ | P3-8 | 重叠长度**按帧对齐取整**（照 `fades.py:389-394`） | `fades.ts`（`alignToFrame` / `crossfadeSamples`） | （本轮） | 2026-09-20 | `crossfade_size = bytes // frame_size * frame_size`；`frameBytesOf(ch) = ch × 4`（F32）。窗口按整帧算 ⇒ 采样数必为声道数整数倍；`mixCrossfade()` 对未帧对齐/不等长**直接抛错**（不"容错"——静默错位的声场比报错难查得多）。单测专门盯「采样数 % channels === 0」这条契约 |

**依赖与注意**
- 依赖 P1（flow 需要两段式 `AudioBuffer`）；DLNA ICY 注入依赖 P2 的基础设施（可降级自带最小注入）。
- **P3-4 与 P3-8 两个必做都别跳** —— 前者对应增益跳变，后者对应「静默不出声」，后者尤其阴险（无报错）。
- L1 beat-aligned / L2 智能混音属远期（P5-4）：MA 侧依赖 torch 栈、`MIN_RAM_GB=4.0`，不可复刻。
- **开关缺省关（重要，别误判"交叉淡入没生效"）**：`crossfade.mode` 缺省 `disabled`（`pipeline.flow` 只是"允许"）。plan 的 D7 只定"本轮做 L0"，没定"缺省打开"；自用场景下先手动开。开关 UI 在 P5-1，`flowSource.resolveFlowSettings()` 就是它未来的读取口。
- **队列推进必须"静默"**：flow 会话驱动的设备拉的是**一条多曲流**，设备侧上报的 position/duration 不再对应单曲 —— tracker 必然算出"该切歌"，但那条流自己会接着播下一首。所以 `QueueController.handleDecision` 在 `flowOwned` 时吞掉 `advance`/`track_changed`，队列位置改由出流侧在曲目边界调 `flowAdvance()` 静默推进（重投 `SetAVTransportURI` 会打断正在播的流，听感 = 每次切歌都断一次）。`ended` **不吞**（流自然结束仍要走 `markEnded`）。
- **`playMode` 必须是 `order` 才拼流**：`shuffle` 的下一首由洗牌序决定、`one`/`all` 会回卷，都不是"队列下标 +1"，会话内推进必然与设备真实顺序打架。队列默认 `playMode` 就是 `shuffle` ⇒ 不改模式时不会拼流。
- **EPIPE 必须吃掉**：客户端断开 → 我们 SIGKILL 编码器 → 正在飞行中的那次 `stdin.write()` 会异步回 EPIPE，`writeOut` 里的可写性检查拦不住；Node 对没有 `'error'` 监听的流会抛未捕获异常（生产里是进程级崩溃）。已在编码器 stdin / 解码器 stdout 上各挂一个空 `error` 监听。

**验收结果**：引擎与接线全绿 —— `tests/services/fades.test.ts` 26 例、`tests/services/flow.test.ts` 8 例（真 ffmpeg：5s+5s−3s=7s、`decoders=2`、`crossfades=1`；关开关 10s 直通；尾静音 3s ⇒ `crossfades=0`；单曲同实现；abort 幂等且 `done` 收敛）、`tests/services/flowSource.test.ts` 13 例、`tests/services/transcode.test.ts` 40 例（含 flow 池独立不抢管道）。契约锁扩到第四个出口：`serveFlowQueue` 也是**管道出口**（六段全在会话内完成），`X-MusicFlow-Transcoded` 从"只定义一次"改为"只在两个管道出口各定义一次"，并断言 flow 只由开关把关、只作为回退链一环（不许出现第三条出流）。tsc 0、7 个静态门禁 0。全量 **166 文件 / 1326 用例**绿。**真机连播听感（无间隙/无爆音）与回录 LUFS ≤ 1 LU 仍待人工验收** —— 需先打开 `crossfade.mode=standard`。

---

## 7. P4 · DSP — 4 / 4 ✅

**为什么做**
② 段负责「每首歌一样响」，③ 段负责「按口味调音色」—— 两者职责不同、不可互换。UI 里的音量滑块是**用户偏好**，不属于流水线；音色塑形必须在服务端做，才能对所有链路（含音箱类 DLNA / Sendspin 设备）生效。这是六段里偏「可选项」的一段，但对有固定听音口味的用户价值最高。

**成功标准**
1. `buildFilterChain()` 按 D6 支持四种滤镜：**Gain**、**3 段 ToneControl**、**多段参量 EQ（biquad）**、**Balance（只衰减）**。
2. 滤镜串接顺序正确（preamp → filters → output gain）；空配置**不向 ffmpeg 链里加任何滤镜**（零开销）。
3. per-player 配置可持久化并暴露设置 API；多设备分组成组时按 MA 规则禁用 DSP。
4. Web 设置页与客户端都有入口，改配置后下一次起播生效。
5. 单测覆盖：滤镜顺序、空配置、分组禁用规则。

**任务清单**

| 状态 | # | 任务 | 落点 | commit | 完成日期 | 备注 |
|---|---|---|---|---|---|---|
| ✅ | P4-1 | `buildFilterChain()`：照抄 MA 的滤镜映射 | 新增 `services/audio/dsp.ts` | （本轮） | 2026-09-20 | D6 首期四项：Gain（preamp / 分声道 / 输出增益）、3 段 ToneControl、六种参量 EQ（biquad 手算）、Balance（只衰减）。**纯函数层**：零进程/零 IO/零 DB。MA 取证 `music-assistant/server@76c2fcb` `helpers/dsp.py`，三处**与 plan §3.3 表格不同**的按源码改正（见「依赖与注意」） |
| ✅ | P4-2 | per-player 配置存储 + 设置 API | **落点偏离**：新增 `services/playerDsp.ts`（非 `services/settings.ts`）＋ `player_dsp_configs` 表 ＋ `/v1/player-prefs/dsp` 三个端点 | （本轮） | 2026-09-20 | 见「依赖与注意」的落点说明。键 = `peerId`（按设备全局，不跟账号走）。读路径**永不抛**（在出流热路径上）、写路径**必须抛**（设置面板要能回 500）。归一化后「没活可干」→ 删行，库里不留空配置行 |
| ✅ | P4-3 | Web 设置页面板 + 客户端设置入口 | `frontend/src/views/Settings/index.vue`（＋`locales/{zh-CN,en-US}.json`） | （本轮） | 2026-09-20 | Web 侧「音色（每台设备）」卡片：设备下拉（来自 `playerStore.peers`）＋ preamp / 三段音色 / 平衡 / 输出增益 / 参量 EQ 段列表（可增删、可选声道）+ 保存 / 清除。**保存后一律用响应里的 `config` 回写表单** —— 归一化的真相在服务端。**客户端（Flutter）入口本轮未做**：客户端是独立仓库，本机与 230 上都没有它的检出，见下 |
| ✅ | P4-4 | 单测：滤镜串接顺序、空配置不加滤镜、分组成组按 MA 规则禁用 | 新增 `tests/services/dsp.test.ts`（20 例）＋ `tests/services/playerDsp.test.ts`（12 例） | （本轮） | 2026-09-20 | 分两层锁：**纯函数层**锁零开销 / 顺序 / 六种 biquad 系数**逐字符 golden**（golden 由 MA 公式在 Python 里独立复算，两份实现互证，不是照实现抄期望值）/ Balance 只衰减且系数恒 ≤ 1 / 越界钳位 / 单声道 pan 变体 / 分组禁用；**存取层**锁归一化（字符串数字接受、NaN 与未知段丢弃）、空配置删行、批量读取只回非空、`playerDspFilters` 的三种返回形态 |

**依赖与注意**
- 依赖 P1（DSP 挂在第二段 ffmpeg 的 `-af` 链上，没有出流管道就无处落点）。
- **落点偏离（P4-2）**：任务表原写 `services/settings.ts`，实际新开 `services/playerDsp.ts`。理由：`settings.ts` 是**全局单键** KV（`key → value`），per-player 配置塞进去要么拼 key 前缀（`"dsp:dlna:xxx"`）要么改它的语义；仓里已有 `playerPrefs.ts` 这个「per-player 设置」先例，故新开同层文件，职责更单一。**DB 表数 38 → 39**（`player_dsp_configs`）；全仓 `grep` 过没有「N 张表」这类硬数字，故无需同步 SPEC。
- 参量 EQ 在 MA 侧是用 `biquad` 手算系数（照 `helpers/dsp.py` 的 slope / width_type=h 处理），别用 ffmpeg 的 `equalizer` 草草代替，否则 Q 值与 MA 不一致。
- **Balance 必须只衰减不提升**，否则会把已归一化的信号重新推出 headroom。⚠️ 代码里这一项是**线性系数**（`(100-|b|)/100`），**不是 dB** —— 套 `dbToGain()` 会得到 `1*FL`（0.7 dB ≈ 1.08）反而成了正增益，与「只衰减」完全相反。单测专门断言系数恒 ≤ 1。
- 本项目用户拥有 HiVi H5 MKII 有源音箱 + ESP32-S3 Sendspin 终端，per-device 配置实用价值最高 —— API 设计要考虑单设备与设备组两种粒度。
- **锚定采样率（不是近似，是精确）**：biquad 系数与采样率绑定（`alpha = sin(2πf/fs)/(2Q)`）。MA 拿**每首歌真实的** `AudioFormat` 现算系数；我们没有「起播前已知实际格式」的通道（webdav/本地/在线源的真实采样率要么得 ffprobe 一次、要么由 ffmpeg 自己发现），故固定锚定值 `DSP_FILTER_RATE = 48000`，并在链首补 `aresample=48000` + `aformat=channel_layouts=stereo`（非 flow 路径）⇒ 系数与信号同源，结果精确。**flow 会话不补这两条**（解码段本来就 `-ar 48000 -ac 2`），见 `playerDspFilters(peerId, {flow:true})`。
- **MA 三处与 plan §3.3 表格不同（以源码为准）**：① ToneControl 三段的 width 是 200 / **1800** / **18000**（表格只给了低段的 200）；② 任何一段电平为 0 → **该段不加滤镜**（不是加个 `gain=0`）；③ Balance 在**单声道源**上另有一套写法（`pan=stereo|FL=…*c0`，mono 没有 FL/FR 可 pan）。
- **成组的成员设备自动禁用**：`buildFilterChain(cfg, fmt, { grouped: true })` 整体返回空（照 MA / plan §3.3 的 ⚠️）—— 成组后音色由组的输出统一决定，成员各自染一遍会 N 次叠加。API **不拦保存**（用户可能先存后组，拦了反而丢配置）。
- **客户端入口未做（P4-3 的一半）**：`lib/features/settings/` 在独立仓库 `MusicFlow-client`，本机与 230 上都没有它的检出 ⇒ 本轮只落了 Web 面板。客户端开工时补即可，**API 已就绪**（`GET/PUT /v1/player-prefs/dsp[/:peerId]`，三个端点，需 `renderer.use`）。

**验收结果**
- **纯函数层**：`tests/services/dsp.test.ts` **20 例**全绿 —— 零开销（`null`/`undefined`/`{}`/全 0 一律 `[]`）、片段顺序（preamp → 音色 → 参量 EQ → Balance → 输出增益）、三段音色常量照 MA、六种 biquad **逐字符 golden**（PEAK/低架/高架/陷波/高通/低通，含 `:c=FL` 变体）、Balance 只衰减（含越界钳位与单声道变体）、分组禁用、`fmtNum` 数字文本稳定。
- **存取层**：`tests/services/playerDsp.test.ts` **12 例**全绿 —— 往返只留非 0 字段、重复写是覆盖不是插行、字符串数字接受而 NaN/未知段丢弃、落库 JSON 与归一化结果逐字段一致、全 0 与「只有 disabled 段」都删行、批量读取只回非空、`playerDspFilters` 三种形态（无配置 `[]` / 单曲带 `aresample`+`aformat` 前缀 / flow 不带）。
- **接线层**：三处出流入口全部带上 peerId —— `resolveRequestAf(song, peerId)`（`/rest/stream` 用 `peerId` 参数、`/stream-remote` 同、DLNA 用 `dlna:<deviceId>` 从 cast token 推）、`resolveFlowAf(song, dspPeerId)`（flow 每曲 af）、`serveFlowQueue()` 新增 `dspPeerId` 透传。**插在响度之后、限制器之前**（②→③→⑤）由 `pipeline.resolveLoudnessAf({extraFilters})` 单点负责，避免某个调用点接反。
- **Web 面板**：设置页「音色（每台设备）」卡片（P4-3 的 Web 半边），`vue-tsc && vite build` 通过。
- **门禁**：`tsc --noEmit` 0；7 个静态检查脚本全 0（含 `check-i18n`：前端 1308 键对齐、后端 catalog 145 键对齐、源码无硬编码中文）。
- **全量回归**：**168 文件 / 1358 用例**中 1357 通过；`tests/services/flow.test.ts` 的「abort 幂等且让 `done` 收敛」在**满载全量跑**时超时一次（15s 墙钟），单跑 859ms 通过、干净 HEAD worktree 全量跑（166 文件）也通过、8 核满载压测连跑 2 次均通过 ⇒ 判定为**满载下的偶发**（该用例断言的是真实子进程被 SIGKILL 后 `close` 的收敛时间，属墙钟敏感），**非 P4 引入**（P4 未触碰 `flow.ts`）。**第二次全量复跑 168 文件 / 1358 用例全绿**，确认偶发。⚠️ 该用例仍是满载下最先被拖垮的一个，将来在 CI 上再见到它超时，先看是不是并发/磁盘，别先怀疑 flow 会话本身。

---

## 8. P5 · 收尾与远期 — 3 / 5 🟡

**为什么做**
管道生效后，用户需要一处能「关掉」的地方 —— 特别是 DLNA：某些设备（电视、老旧音箱）不接受实时流，必须能单独降级。另外 plan 目前是「方案」口吻，落地后要转正，避免半年后有人误以为它仍是未决事项。

**成功标准**
1. 全局 + 每通道开关可用；关闭 = 滤镜链为空，**不回到绕过管道**（D9）。
2. DLNA 单设备回退开关可用：某台设备不接受实时流时可单独关闭。
3. 可选优化层到位但**默认关闭**（热点曲目输出缓存 / 本地行离线预测量）。
4. 远期边界写清：L1 / L2 标为「本轮不做」，写明理由（MA 侧依赖 torch 栈、`MIN_RAM_GB=4.0`，不可复刻）与「分析字段已预留」。
5. 文档转正：plan 去掉方案口吻，CHANGELOG 按实际发版写入，本文件标记结项。

**任务清单**

| 状态 | # | 任务 | 落点 | commit | 完成日期 | 备注 |
|---|---|---|---|---|---|---|
| ✅ | P5-1 | 全局 + 每通道开关 UI（服务端 / Web / 客户端） | 新增 `services/audio/pipelineSwitches.ts` + 四出口接线 + `routes/api/index.ts` 两个端点 + Web 设置页 | （本轮） | 2026-09-20 | **落点偏离**：原写 `services/settings.ts`，实际新开 `audio/pipelineSwitches.ts`（`settings.ts` 是纯 KV，判定逻辑不该塞进读写层）。两层：全局 `pipeline.enabled` × 每通道 `pipeline.{http,dlna,sendspin,airplay}`；判定入口唯一 `isChannelEnabled()`。四个出口＝ HTTP/Web（`resolveRequestAf`/`resolveFlowAf` 新增 `channel` 形参，**`null` 有意义**＝该次出流不带滤镜）、DLNA、Sendspin（`resolveSendspinAf`）、AirPlay（`buildAirplayAf`）。**关闭 = 滤镜链为空、仍走管道**（D9）。Web「音频管道」卡片含总开关 / 四通道 / 连续流 / 交叉淡入模式+时长。**客户端（Flutter）入口本轮未做** —— 独立仓库、本机与 230 都无检出；API 已就绪 |
| ✅ | P5-2 | DLNA 单设备回退开关 | `services/audio/pipelineSwitches.ts` + `/v1/pipeline/dlna/:deviceId` + Web 设置页 | （本轮） | 2026-09-20 | D5 配套兜底。键 `pipeline.dlna.fallback.<deviceId>`（设备数个位数，不单开表，与 `pipeline.*` 同族同类缓存）。判定 `isDlnaEffectsEnabled(deviceId)` = **通道开 且 未被单独回退**（两层相乘，不是替代）。DLNA 路由用 cast token 里的 `deviceId` 算 `dlnaChannel`，故同一台设备其它行为（音量/队列/解绑）完全不受影响。面板里逐设备一个开关，失败时把开关拨回去 |
| ✅ | P5-3 | 可选优化层（**默认关**）：热点曲目输出缓存 / 本地行离线预测量 | 新增 `services/audio/offlineMeasure.ts` + `routes/api/index.ts` 三个端点 + Web 设置页 | （本轮） | 2026-09-20 | **只做了「本地行离线预测量」，「热点曲目输出缓存」按 plan §2 决策不做**（plan 原文：不做「预渲染缓存」这类旁路，MA 没有这一层；缓存命中即绕过 ②–⑤，且改一次目标响度/DSP 就整库失效）—— 已在 plan §6 P5 条写明。实现要点：只选 `l:` 前缀 local 行 + 只选未测量的（幂等），`loudnorm … print_format=json -f null -`（不出音频）→ 复用实时路径同一个 `parseLoudnorm()` 落库；串行执行、`running` 是唯一并发闸门、**不占 playback 池**（否则一次批量会把客户端音质转码顶到队尾）；触发走异步 + 轮询（同步等会撞前端 15s 超时）。Web 侧只加了开关 + 「开始测量」+ 进度文案 |
| ⏭ | P5-4 | **远期，本轮不做**：Smart Fades L1 beat-aligned / L2 智能混音 | — | — | — | MA 侧是 torch 栈，门槛 `MIN_RAM_GB=4.0`，不可复刻；字段已预留，将来接不改表 |
| ⬜ | P5-5 | 文档：plan 转正 + CHANGELOG + 本文件结项标记 | `docs/`、`CHANGELOG.md`、本文件 | — | — | 项目约定：**未发版不提前写 CHANGELOG** |

**验收结果**
- **服务端**：新增 `services/audio/pipelineSwitches.ts`（唯一判定入口）+ 3 个 admin 端点（`GET/PUT /v1/pipeline/switches`、`PUT /v1/pipeline/dlna/:deviceId`）+ 四出口接线（HTTP/Web、DLNA、Sendspin、AirPlay）。语义照 D9：关闭 = 滤镜链为空、仍走管道（`channel = null` 时 `resolveRequestAf` / `resolveFlowAf` 返回空链，但路由**仍出管道流**）。DLNA 通道值由 cast token 里的 `deviceId` 推出，再叠一层单设备回退。
- **单测**：`tests/services/pipelineSwitches.test.ts` **12 例**（缺省全开 / 全局关覆盖每通道 / 部分更新忽略非法值 / DLNA 单设备回退「通道开 且 未回退」两层相乘 / 键前缀）+ `tests/services/flowSource.test.ts` **+1 例**（`effectsOn:false` 否决 flow）+ `tests/rest/pipelineContract.test.ts` **+2 例**（P5-1 通道开关、P5-2 `channel=null`）；该文件既有 12 例契约锁全绿。
- **Web 面板**：设置页「音频管道」卡片（P5-1/P5-2 的 Web 半边）—— 总开关 / 四通道开关（总开关关闭时置灰）/ 连续流 / 交叉淡入模式与时长（时长下限 3s 对齐 MA）/ DLNA 逐设备回退；保存 250ms 去抖并按响应回写，回退失败把开关拨回。`vue-tsc --noEmit` 0、`vite build` 通过。
- **门禁**：`tsc --noEmit` 0；7 个静态检查脚本全 0（`check-i18n`：前端 1331 键对齐、后端 catalog 145 键对齐、源码无硬编码中文）。
- **全量回归**：**170 文件 / 1385 用例逐个通过**（P4 基线 168/1358 → 累计 +2 文件 / +27 例：P5-1/5-2 的 +1 文件/+15 例，P5-3 的 +1 文件/+12 例）。
  ⚠️ **230 这台机只有 2.9 GB 内存**：`tests/plugins/sandbox.test.ts` 单文件 fork 峰值 RSS ≈ 2.5 GB，整包（甚至某个大批）跑会被内核 OOM 杀掉（`dmesg` 见 `Out of memory: Killed process (node (vitest 1))`），症状是 `ERR_IPC_CHANNEL_CLOSED` 且**不打印任何 pass/fail 汇总** —— **看着像失败，其实没跑到结论**。故本轮按目录分段跑（段间 `rm -rf /tmp/mf-test-data` + `drop_caches`）：`sandbox` 单跑 **1 文件/27 例**、`airplay~rendererHost` **25/168**、`plugins`（去 sandbox）**22/200**、`services` **36/386**；余下 `rest/routes/sendspin/source/utils` 与 `src/services/sendspin` 的 **86 文件/604 例** 在一次 122 文件大批里全过（该批唯一的失败是 `flow.test.ts`，见下条；而它在 `services` 段里已全绿）。合计 **170/1385**。将来在 230 上跑全量若再见 `ERR_IPC_CHANNEL_CLOSED`，先按「内存不够 → 分段跑」处理，别怀疑代码。
  ⚠️ 另一条老熟人：`tests/services/flow.test.ts` 的「abort 幂等且让 `done` 收敛」在**大批**里超时（`expected 'timeout' to be 'done'`）。它断言的是真子进程被 SIGKILL 后 `done` 在 **15s** 内收敛，属**墙钟敏感**：单跑 **8/8** 通过、36 文件的 `tests/services` 批也全过，只在 122 文件的大批里挂 ⇒ 与机器压力相关，**非本轮引入**（P5-3 未触碰 `flow.ts`；P4 的验收记录里已有同一现象）。

**P5-3 · 可选优化层（默认关）**
- **服务端**：新增 `services/audio/offlineMeasure.ts` + 3 个 admin 端点（`GET/PUT /v1/pipeline/measure`、`POST /v1/pipeline/measure/run`）。候选集只含 `l:` 前缀 local 行、只含**未测量**的行（重复触发幂等）；命令 `loudnorm … print_format=json -f null -`（**只分析不出音频**）；结果经**实时路径同一个** `parseLoudnorm()` 解析后 `saveAnalysis()` 落库 —— 离线值与实时值同口径。串行执行 + `running` 是唯一并发闸门（**不占 playback 池**）；单曲 5 min 墙钟上限，超时 SIGKILL 判 failed；触发走异步 + 前端 1s 轮询。
- **明确不做的部分（按 plan 决策）**：「热点曲目输出缓存」**不做** —— plan §2 核心原则写着「不做『预渲染缓存』这类旁路：MA 没有这一层」（缓存命中即绕过 ②–⑤，且改一次目标响度/DSP 就得整库失效）。已在 plan §6 P5 条写明，**不是漏做**。
- **单测**：`tests/services/offlineMeasure.test.ts` **12 例全绿** —— 命令形态（null muxer、无 `pipe:1`、复用 `LOUDNORM_ARGS`）、`limit` 归一化（非法回落 / 超限钳位 / 取整）、可测路径只认 `l:`、默认关 + 开关往返、候选集只含 local 且未测量（web / webdav / 相对路径全排除）、`saveAnalysis` 对 web 行拒绝（D8 双保险）、**真 ffmpeg 端到端**（生成 -20 dB 正弦 → 实测值落在合理区间且落库）、文件不存在计 failed 不抛、`running` 闸门第二次触发被拒（busy）。
- **Web 面板**：管道卡片末尾加一行 —— 开关 + 「开始测量」+ 「已测 N / 共 M」（跑动时切「测量中 N/M…」并 1s 轮询，跑完自动停）。

---

## 9. 阻塞登记

| 日期 | 涉及任务 | 阻塞内容 | 状态 | 绕过 / 解法 |
|---|---|---|---|---|
| — | — | *当前无阻塞* | — | — |

---

## 10. 变更日志

| 日期 | commit | 变更内容 |
|---|---|---|
| 2026-09-20 | — | 本文件建立。任务自 plan §6 拆出 38 项并整合六个阶段的「为什么做 / 成功标准 / 依赖 / 注意」于一篇。前序：`3257606` D9/D10 与两段式修正、`8781b6e` MA 源码逐行复核、`ba2dcac` 行号收紧。**尚未开工，全部 ⬜** |
| 2026-09-20 | （本轮） | P0 收尾：P0-1/2/3/5 核对完成（表/纯函数/24 单测均已在仓）；新增 `reportPlaybackLoudness` 入口（P0-4 待 P1 管道 stderr）；P0-6 五处删行联动（顺序先回写后行，FK 强制）；P0-7 新 `analysisStore.test.ts` 5 例。全量 159/1204 绿。P0-4 标 🟡 待 P1。 |
| 2026-09-20 | （本轮） | P1-1/1b/2/3：参数骨架＋输入合规门＋Sendspin/AirPlay 接入 af 链（P0-4 双模式落点）。P1-4：输出段收尾，sendspin 输出恒 48k 立体声（编码层硬编码确认），重采样点挪进 af 链。全量 161/1239 绿。总值 11/38。 |
| 2026-09-20 | （本轮） | P1-5/6：转码走管道装配（同进程编码＋af，stderr 排空）＋单测补齐；对照本地 MA 源码回查：aresample 合并单滤镜、增益去限幅、`isSoundEffect`、描述子字段补齐（存量库 PRAGMA 补列）。P1 收官 7/7。全量 161/1244 绿。总值 13/38。 |
| 2026-09-20 | （本轮） | P2-1：`/rest/stream` 默认走管道（D4 跟随源族＋af＋X 头，Range 全流 200，缺文件 404 保留）；`serveTranscodedSong` 改走统一组装＋af/P0-4。原样拉流分支删除（D9）。全量 161/1246 绿。总值 14/38。 |
| 2026-09-20 | （本轮） | P2-2/2b：`/rest/dlna/stream/:token` 全通道走管道（web/webdav/本地统一 `servePipelinedSong`＋`resolveDlnaOutput`；旧嗅探/探测/`serveDlnaWebStream`/`?raw=1` 直透删除；cast/enqueue/DIDL mime 三处同步；tier 转码补 songId）；音箱兼容头（contentFeatures＋12h 假长度恒带，ICY 按需＋空元数据装帧）。`dlnaOggFallback` 重写 7 例＋`dlnaStreamPrefer` 更新＋`resolveDlnaOutput` 3 单测。全量 161/1251 绿。总值 16/38。 |
| 2026-09-20 | （本轮） | P2-3（客户端仓库 `81eda97`，已推 main）：seek 判定改按服务端能力（`serverPipelinedHttp` 直通 + `serverPipesAllHttpStreams` 版本门控 ≥3.0.47，Navidrome/老版/未知保守 false）。P2-4：Web 端 Howler 无字节 Range → 改带 `timeOffset` 重拉；新增纯函数 `frontend/src/utils/transcodedSeek.ts`（`seekTargetFromLogical` / `toLogicalPosition` / `withTimeOffset`）＋`player.ts` 250ms 防抖重建＋进度/时长/歌词 offset 补偿＋跨包单测 `tests/services/transcodedSeek.test.ts` 12 例。`vue-tsc --noEmit` 0。总值 18/38。 |
| 2026-09-20 | （本轮） | P2-5：并发槽由单池 4 槽拆为**两个独立池**——`quality`（客户端显式要 format/maxBitRate，上限按核数派生、下限 4 上限 8）／`pipeline`（默认实时管道，核数 ×2、下限 6），8 核机即 8 / 16；派生方式照 MA `constants.py:211`。acquire 改**租约制**（返回释放函数 + 幂等 `released` 标志，防分池后释放落错池 / 一次出流还三次额度）；`serveFfmpegPipe` 的 `slot` 必填（音质转码 quality、默认管道 pipeline），避免默认值静默降级；实际排队时记一次日志（首字节延迟可观测）。单测重写为 6 例（派生公式 / env 覆盖与非法值回退 / 幂等 / 池内排队 / 两池互不抢槽 / 合计计数）。`docs/audio-pipeline-plan.md` §1.3 与 §6 P2 表、`docs/DEVELOPER.md` 环境变量表同步。全量 162/1267 绿。总值 19/38。 |
| 2026-09-20 | （本轮） | P2-6：新增契约锁 `tests/rest/pipelineContract.test.ts` 8 例 —— 结构锁（两 handler 段内无 `createReadStream`/`Accept-Ranges`/`raw` 用户分支，DLNA 仅从 `resolveCastToken` 后断言以保住回环取源分支；X 头全文件只定义一次）+ 开关开/关（关掉 `pipeline.http` 两路由仍走管道）+ 换源行增益按 `row.id`。为此导出 `resolveRequestAf`。**本轮新发现第三处直出**：`/rest/stream-remote` 仍原样代理上游字节（`serveWebSongStream`，唯一调用点），搜索即播路径无响度标准化 → **新增任务 P2-7**（含前端 `probeRemoteFormat` 联动），总数 38 → 39。顺带修 2 处与实现不符的注释。tsc 0；本文件 8/8 绿。总值 20/39。 |
| 2026-09-20 | （本轮） | P2-7：`/rest/stream-remote`（搜索即播·未入库远程歌）改走 `servePipelinedSong`，`serveWebSongStream` 整段删除（D9 第三处直出清除）；补 `timeOffset` 透传；**换源前移**为出流前的 `resolveRemoteStreamUrl`（probe 三态：ok→原链 / gone→多源换源 / gone 且无替代→404 / transient→原链不判死）；前端删 `probeRemoteFormat`＋`remoteFmtCache`＋`playbackSeq`、`useEntitySearch` 的 `_suffixKnown` 一并删除，远程歌固定按 mp3 起播（避免探测拉起常驻 ffmpeg 烧槽）。结构锁扩到第三个路由 + 前端源码锁；`streamRemoteFallback.test.ts` 重写为真 HTTP 上游 + 真 ffmpeg（fetch stub 拦不住子进程）。文档同步：`PLUGIN_DEV.md` §5 格式契约（两条路径对 `suffix` 的用法不同）、`SOURCE_SWAP.md` 换源发生点、`plan §6` P2 表。全量 163/1278 绿。总值 **21/39**，P2 收官 8/8。 |
| 2026-09-20 | （本轮） | P3-1~P3-8：**Smart Fades L0（标准交叉淡入）收官 8/8**。新增三层：数学层 `services/audio/fades.ts`（帧对齐取整 P3-8 / 等功率·线性权重曲线 / 静音剥离 P3-3 / F32 逐片加权混合，未帧对齐或不等长**直接抛错**）、进程编排 `services/audio/flow.ts`（一条编码 + 每曲一条解码，**懒预取**下一路 + `pumpHoldBack()` 扣住过渡窗口字节，稳态 1 路 / 过渡期 2 路）、接线层 `services/audio/flowSource.ts`（开关缺省**关** / 从权威队列选曲 / ICY 元数据块）。**P3-4 用"一次算定"替代 MA 的运行时 pin**：每曲 af 在会话启动前算定且 `flow.ts` 不 import 任何响度模块（结构锁），限幅器只落在混合之后（⑤ 在 ④ 之后）。**P3-5**：`resolveCastSession()` 暴露 cast token 里的 `deviceId` → DLNA 可默认接管队列；`icyFrameStream()` 增加动态元数据提供者（每 16384 字节发真实 `StreamTitle`）。**P3-6**：并发池加第三池 `flow`（上限 `max(4,核数)`，按存活解码器计费），交叉淡入不抢 `pipeline` 池。**队列静默推进**：`QueueController.flowOwned` + `flowAdvance()`，flow 期间吞掉 `advance`/`track_changed`（重投传输指令会打断连续流），`ended` 不吞。**EPIPE 吃掉**（客户端断开后飞行中的 stdin 写会异步 EPIPE，无监听则进程级崩溃）。出口接线：DLNA 默认接管、HTTP 必须 `flow=1&peerId=` 显式 opt-in（HTTP 客户端的"下一首"由客户端推进，替它拼流会两边各推一次 → 跳歌）。契约锁扩到第四个出口（`serveFlowQueue` 也是管道出口）。新增 `fades.test.ts` 26 例 / `flow.test.ts` 8 例（真 ffmpeg）/ `flowSource.test.ts` 13 例 / `transcode.test.ts` +1 例（flow 池不抢管道）；tsc 0、7 门禁 0。总值 **29/39**，P3 收官 8/8。 |
| 2026-09-20 | （本轮） | P4-1~P4-4：**DSP 收官 4/4**。纯函数层 `services/audio/dsp.ts`（`buildFilterChain()` 照 MA `helpers/dsp.py`：Gain preamp/分声道/输出增益、3 段 ToneControl、六种参量 EQ（biquad 手算，**不用** ffmpeg `equalizer`）、Balance **只衰减**（线性系数非 dB）；锚定 `DSP_FILTER_RATE=48000`，非 flow 路径链首补 `aresample`+`aformat`）+ 存取层 `services/playerDsp.ts`（新表 `player_dsp_configs`，键 `peerId`；读路径永不抛、写路径必须抛；归一化后无活干即删行）+ 接线层（`resolveLoudnessAf({extraFilters})` 单点插在 ②→③→⑤，三处出流入口带 peerId）+ Web「音色（每台设备）」卡片（保存后按响应 `config` 回写）。**MA 与 plan §3.3 表格三处不同，按源码改正**：音色三段 width = 200/1800/18000、某段电平为 0 则该段不加滤镜、单声道源 Balance 走 `pan=stereo\|FL=…*c0`。新增 `dsp.test.ts` 20 例（六种 biquad **逐字符 golden**，golden 由 MA 公式在 Python 里独立复算）+ `playerDsp.test.ts` 12 例。DB 38 → 39 表。tsc 0、7 门禁 0、全量 168/1358 绿（`flow.test.ts` 一条墙钟敏感用例在满载下偶发超时一次，干净 HEAD worktree 与二次复跑均绿 ⇒ 判定偶发、非回归）。总值 **33/39**。 |
| 2026-09-20 | （本轮） | P5-1/P5-2：**开关 UI 落地（2/5 🟡）**。新增 `services/audio/pipelineSwitches.ts` 作**唯一判定入口** —— 全局 `pipeline.enabled` × 每通道 `pipeline.{http,dlna,sendspin,airplay}`（`isChannelEnabled()`）；DLNA 另叠**单设备回退**（键 `pipeline.dlna.fallback.<deviceId>`，`isDlnaEffectsEnabled()` = 通道开 **且** 未回退，两层相乘）。四个出口接线：HTTP/Web（`resolveRequestAf` / `resolveFlowAf` 新增 `channel` 形参，**`null` 是有意义的值**＝该次出流不带滤镜 —— 用 `??` 会把它吃掉）、DLNA（按 cast token 里的 `deviceId` 算通道）、Sendspin（`resolveSendspinAf`）、AirPlay（`buildAirplayAf`）。**语义照 D9：关闭 = 滤镜链为空、仍走管道**。3 个 admin 端点（`GET/PUT /v1/pipeline/switches` 一次给全 / 部分更新、`PUT /v1/pipeline/dlna/:deviceId`）+ Web「音频管道」卡片（250ms 去抖、响应回写、逐设备回退失败回拨）。新增 `pipelineSwitches.test.ts` 12 例，`flowSource.test.ts` +1 例、`pipelineContract.test.ts` +2 例。`docs/API.md` 补 3 行。tsc 0、前端 `vue-tsc && vite build` 通过、`check-i18n` 1331 键对齐。全量 169/1373 绿（分两段跑，见 §8 验收结果的内存说明）。总值 **35/39**。 |
| 2026-09-20 | （本轮） | P5-3：**可选优化层落地（默认关）**。新增 `services/audio/offlineMeasure.ts`：对 **local 行**预跑一遍响度分析落进 `audio_analysis`，之后起播走静态增益（P0 起就通的 `fixed_gain` 分支），省掉实时 loudnorm。三条硬约束写在文件头：①**默认关**（plan §3.2：预测量是可选优化、不是前置条件）；②**只测 local**（web 源字节不保证一致，D8 —— 候选集不选 web，`saveAnalysis` 再兜一道）；③**不占 playback 池**（串行 + `running` 单一闸门，占池会把客户端音质转码顶到队尾）。命令用 `loudnorm … print_format=json -f null -` **只分析不出音频**，且**复用实时路径同一个 `parseLoudnorm()`** ⇒ 离线值与实时值同口径（不另写 ebur128 文本解析器）。3 个 admin 端点（GET/PUT 状态与开关、POST 异步触发）+ Web 面板一行（开关 / 开始测量 / 已测 N 共 M，跑动时 1s 轮询）。**「热点曲目输出缓存」按 plan §2 决策不做**（不做「预渲染缓存」这类旁路），已在 plan §6 P5 条写明。新增 `offlineMeasure.test.ts` 12 例（含真 ffmpeg 端到端）；tsc 0、7 门禁 0（`check-i18n` 1339 键）、前端 `vue-tsc && vite build` 通过。全量 **170 文件/1385 例逐个通过**（按目录分段跑，见 §8 的内存说明）。总值 **36/39**。 |

---

## 11. 与 plan 的分工

| 文件 | 角色 | 什么时候改 |
|---|---|---|
| `docs/audio-pipeline-plan.md` | **规格**：为什么这么做、MA 实证、决策点 D1–D10、风险表 | 设计结论变了才改（例如推翻某个决策） |
| `docs/audio-pipeline-progress.md`（本文件） | **任务清单 + 进度**：做到哪了、卡在哪、验收实测 | **每完成一小项立刻改**（§0 更新规则） |
