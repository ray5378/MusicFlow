# 音频流水线改造 · 总任务清单（唯一权威）

> **本文件是整个改造的唯一任务真相源** —— 任务状态、交付物、验收口径一律以本文件为准，**不另设分阶段文档**。
> **规格（怎么做、为什么这么做）的真相源是 [`docs/audio-pipeline-plan.md`](audio-pipeline-plan.md)**：
> 六段流水线设计、决策点 D1–D10、MA 源码实证、风险表。两者冲突时以 plan 为准，本文件随之更新。

**最终目标**：把 **客户端 / Web / DLNA / Sendspin / AirPlay** 五条链路统一走服务端实时管道
（解码 F32 → 响度标准化 → DSP → 交叉淡入 → 限制器 → 通道编码），**响度标准化全覆盖、不留任何直传旁路**（D9）。

创建：2026-09-20 ｜ 最后更新：**2026-09-20（文档建立，尚未开工）** ｜ main 位置 `ba2dcac`（plan 与 SPEC 已对齐 MA 源码，CI 7/7 绿）

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
| **P0** | 数据层与响度核心 | 0 / 7 | ⬜ | 三个纯函数可单测，**不改任何播放行为**，可独立上线 |
| **P1** | 管道骨架 + Sendspin / AirPlay | 0 / 7 | ⬜ | ESP32 / AirPlay 首播即被归一化，回录曲目间差 ≤ 1 LU |
| **P2** | HTTP 通道实时管道化 | 0 / 7 | ⬜ | 客户端 / Web / DLNA 走管道，**客户端拖动进度实测通过**，删净直传分支 |
| **P3** | Smart Fades L0 | 0 / 8 | ⬜ | 连播无间隙无爆音，过渡窗口增益不跳变 |
| **P4** | DSP | 0 / 4 | ⬜ | 四个常用滤镜可用，空配置零开销 |
| **P5** | 收尾与远期 | 0 / 5 | ⬜ | 开关 UI 齐备、文档转正 |
| **合计** | | **0 / 38** | ⬜ 尚未开工 | 验收总口径见 plan §8 |

### 2.2 总体进度

**0 / 38（0%）**

### 2.3 当前焦点

**尚未开工。** 下一步从 **P0-1** 起手：建表对齐 MA `AudioAnalysisData`（`backend/src/db/schema.ts`）。
纯数据层改动、不动播放路径、风险最低，且后续所有阶段都要吃它的数据。

### 2.4 阶段依赖

```
P0（数据层，可独立上线）
 └── P1（管道骨架）── P2（HTTP 三通道）── P3（交叉淡入，依赖 P1 的 flow 能力）
                                     └── P4（DSP，挂在 P1 的出流 -af 链上）
                                           └── P5（收尾）
```

---

## 3. P0 · 数据层与响度核心 — 0 / 7 ⬜

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
| ⬜ | P0-1 | 建表对齐 MA `AudioAnalysisData`：`loudness_integrated` / `loudness_album` / `loudness_range` / `true_peak` / `bpm` / `beats` / `downbeats` / `beats_per_bar` / `key` / `mode` / `rms_energy` / `spectral_centroid` / `energy` + `measured_at`，行级 + drizzle 迁移 | `backend/src/db/schema.ts` | — | — | DB 表 38 → **39**，同步改 SPEC §2.1 表清单数字 |
| ⬜ | P0-2 | `parseLoudnorm()`：解析 ffmpeg stderr 的 loudnorm JSON（照 `helpers/audio.py:881-901`） | 新增 `services/audio/loudness.ts` | — | — | 纯函数之一 |
| ⬜ | P0-3 | `chooseMode()` 模式决策 + `computeGainDb()` 增益计算 | 同上 | — | — | 纯函数，必须可单测 |
| ⬜ | P0-4 | 边播边测回写：**仅 `local` / `webdav` 行**按 `row.id` 入库；网络源行解析后丢弃（D8） | 同上 + 播放结束钩子 | — | — | 键必须是 **row.id**，不能用 songId |
| ⬜ | P0-5 | 单测：JSON 解析（含 -inf / 解析失败）、模式选择全分支、增益限幅、行级绑定 | 新增 `tests/services/loudness.test.ts` | — | — | 阶段主力测试 |
| ⬜ | P0-6 | 回写清理联动：删行同事务删回写；扫描差集删除仅在源探测成功后执行，失败跳过并记 warning | 源清理 / 扫描逻辑 + `loudness.ts` | — | — | 防一次源抖动抹掉整库测量值 |
| ⬜ | P0-7 | 单测：网络源不回写（断言 DB 无记录）、源不可达时清理不执行、行删除后回写归零 | `tests/services/loudness.test.ts` 扩展 | — | — | 成功标准 4–6 的断言在这 |

**验收结果**：*待填（实测数据 / 结论 / 日期）*

---

## 4. P1 · 管道骨架 + Sendspin / AirPlay（①②⑤⑥）— 0 / 7 ⬜

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
| ⬜ | P1-1 | 新增 `AudioPipeline`：**两段式**（① 解码 → PCM `AudioBuffer`；② 出流 ffmpeg 吃 stdin PCM + `-af` 链 + 输出格式） | 新增 `services/audio/pipeline.ts` + `audio/buffer.ts` | — | — | 两段式是 flow / 交叉淡入 / 边播边测的前提 |
| ⬜ | P1-1b | 解码段输入必须遵守 **SPEC §1.8**（回环 token URL / 本地文件路径），并加契约测试锁死 | `pipeline.ts` + `tests/sendspin/ffmpegInputContract.test.ts` | — | — | 契约锁住两个老坑回归：Alpine DNS 全坏 / 302 带 Authorization 头给 CDN |
| ⬜ | P1-2 | Sendspin 接入（替换 `ffmpegArgs()` 的硬编码 48k 解码） | `sendspin/streamSource.ts` | — | — | |
| ⬜ | P1-3 | AirPlay 接入 | `airplay/decoder.ts` | — | — | 原为硬编码 44100 s16le |
| ⬜ | P1-4 | 输出段 dither `triangular_hp`（仅 >16bit→16bit）；确认 Sendspin 编码层对非 48k 输入的处理 | `sendspin/encoding.ts` | — | — | dither 是 `triangular_hp`，**不是** `triangular` |
| ⬜ | P1-5 | 客户端/Web 已选音质档位时并入同一次转码，**不额外起进程** | `services/transcode.ts` `spawnTranscoder()` | — | — | |
| ⬜ | P1-6 | 单测：参数拼装、模式切换、限制器/dither 随位深开关、loudnorm 时重采样降级 `swr` | `tests/sendspin/ffmpegInputContract.test.ts` 扩展 | — | — | `swr` 降级是 ffmpeg ticket 11323 的规避 |

**依赖与注意**
- 依赖 P0 —— 未完成则管道无法产出自适应增益。
- **两段式不是可选优化**：解码 → PCM `AudioBuffer` → 第二条 ffmpeg 吃 stdin。图省事退化成单条 `-af`，后面 P3 的 flow / 交叉淡入直接做不了。
- `dlna/control.ts` 的 `?raw=1` 直透分支**本阶段先保留** —— 它是给 ffmpeg 喂料的输入端点，删除要等 P2-2。

**验收结果**：*待填（回录 LUFS / true peak 实测值 / 日期）*

---

## 5. P2 · HTTP 通道实时管道化 — 0 / 7 ⬜

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
| ⬜ | P2-1 | `/rest/stream` 走管道；**删除原样拉流分支**；响应加 `X-MusicFlow-Transcoded: 1` 头（D9） | `backend/src/routes/rest/index.ts` | — | — | SPEC §1.8 已注明输出侧不再「原样直出」 |
| ⬜ | P2-2 | `/rest/dlna/stream/:token` 走管道；**删除 `?raw=1` 直透分支**（D9）；MIME 同步 | 同上 + `plugin/renderers/dlna.ts` + `dlna/control.ts` | — | — | 「直透原始字节」旧断言已作废 |
| ⬜ | P2-2b | HTTP 出流响应头四项（照 MA `streams/controller.py:1296-1318`） | `routes/rest/index.ts` + `dlna/control.ts` | — | — | 比「只能接受无 Content-Length 退化」更优 |
| ⬜ | P2-3 | **客户端 seek 判定改造（必做）**：改为按响应头 / 服务端能力判定 | MusicFlow-client：`lib/providers/player/transcoded_stream_seek.dart` + `player_playback_helpers.dart` | — | — | 跨仓库；判据是存在 `X-MusicFlow-Transcoded` → 走 timeOffset 重拉 |
| ⬜ | P2-4 | Web 端 seek 适配：无 Range 时按 `timeOffset` 重建 URL，进度用 offset 补偿 | `frontend/src/stores/player.ts` | — | — | |
| ⬜ | P2-5 | 并发池上调 + 归一化独立并发，不抢音质转码的槽 | `services/transcode.ts` | — | — | |
| ⬜ | P2-6 | 契约测试：开关开/关、换源行增益变化、MIME 随格式变化、响应头存在、DLNA 拒 FLAC 回退、**断言两个路由都不再有原样直出路径** | 新增 `tests/services/pipeline.test.ts` | — | — | 最后一条是 D9 的回归锁 |

**依赖与注意**
- 依赖 P1 —— 三条链路复用同一套 `AudioPipeline` 与响度决策。
- **P2-3 漏做 = 客户端拖动进度直接失败**：客户端现有判定依据是「是否支持 Range」，实时流不再给字节 Range，必须改按响应头判定。还要跨仓库改 MusicFlow-client。
- DLNA 的 `REL_TIME` seek 退化是**已接受代价（D5）** —— UI 进度走服务端状态 / WS 推送不受影响；保留单设备回退开关（P5-2）。

**验收结果**：*待填（含客户端拖动进度的实测结论）*

---

## 6. P3 · Smart Fades L0（标准交叉淡入）— 0 / 8 ⬜

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
| ⬜ | P3-1 | **flow mode**：把队列连续曲目拼成一条不间断流（两路解码并存） | 新增 `services/audio/flow.ts` | — | — | 内存约 2×11.5 MB + 2 个 ffmpeg，仍封顶 |
| ⬜ | P3-2 | **标准交叉淡入**：F32 逐片加权混合，时长可配 | 新增 `services/audio/fades.ts` | — | — | 不做 ML 智能混音（L1/L2 属远期） |
| ⬜ | P3-3 | **静音剥离**：曲尾静音不计入过渡窗口 | `fades.ts` | — | — | |
| ⬜ | P3-4 | **`normalization_override`**：过渡期间 pin 住两首歌各自的归一化模式 | `flow.ts` + `loudness.ts` | — | — | 风险表「过渡期增益跳变」的唯一解 |
| ⬜ | P3-5 | DLNA 侧 flow mode + ICY 元数据注入 | `dlna/control.ts` | — | — | 连续流里设备拿不到曲目边界 |
| ⬜ | P3-6 | 并发池预留额外槽位（过渡期 CPU 翻倍） | `services/transcode.ts` | — | — | |
| ⬜ | P3-7 | 单测：混合权重曲线、静音剥离、增益不跳变、开关关闭行为 | 新增 `tests/services/fades.test.ts` | — | — | |
| ⬜ | P3-8 | 重叠长度**按帧对齐取整**（照 `fades.py:389-394`） | `fades.ts` | — | — | 否则混合器静默不出声，不读源码想不到 |

**依赖与注意**
- 依赖 P1（flow 需要两段式 `AudioBuffer`）；DLNA ICY 注入依赖 P2 的基础设施（可降级自带最小注入）。
- **P3-4 与 P3-8 两个必做都别跳** —— 前者对应增益跳变，后者对应「静默不出声」，后者尤其阴险（无报错）。
- L1 beat-aligned / L2 智能混音属远期（P5-4）：MA 侧依赖 torch 栈、`MIN_RAM_GB=4.0`，不可复刻。

**验收结果**：*待填*

---

## 7. P4 · DSP — 0 / 4 ⬜

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
| ⬜ | P4-1 | `buildFilterChain()`：照抄 MA 的滤镜映射 | 新增 `services/audio/dsp.ts` | — | — | D6 首期四项 |
| ⬜ | P4-2 | per-player 配置存储 + 设置 API | `services/settings.ts` + 新增表 | — | — | DB 表数再 +1，同步 SPEC §2.1 |
| ⬜ | P4-3 | Web 设置页面板 + 客户端设置入口 | `frontend/src/`、`lib/features/settings/` | — | — | 客户端仓库联动 |
| ⬜ | P4-4 | 单测：滤镜串接顺序、空配置不加滤镜、分组成组按 MA 规则禁用 | 新增 `tests/services/dsp.test.ts` | — | — | |

**依赖与注意**
- 依赖 P1（DSP 挂在第二段 ffmpeg 的 `-af` 链上，没有出流管道就无处落点）。
- 参量 EQ 在 MA 侧是用 `biquad` 手算系数（照 `helpers/dsp.py` 的 slope / width_type=h 处理），别用 ffmpeg 的 `equalizer` 草草代替，否则 Q 值与 MA 不一致。
- **Balance 必须只衰减不提升**，否则会把已归一化的信号重新推出 headroom。
- 本项目用户拥有 HiVi H5 MKII 有源音箱 + ESP32-S3 Sendspin 终端，per-device 配置实用价值最高 —— API 设计要考虑单设备与设备组两种粒度。

**验收结果**：*待填*

---

## 8. P5 · 收尾与远期 — 0 / 5 ⬜

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
| ⬜ | P5-1 | 全局 + 每通道开关 UI（服务端 / Web / 客户端） | `services/settings.ts` + 前端 + 客户端 | — | — | 关闭 = 滤镜链为空，不等于绕过管道（D9） |
| ⬜ | P5-2 | DLNA 单设备回退开关 | `dlna/control.ts` + 设置项 | — | — | D5 配套的兜底 |
| ⬜ | P5-3 | 可选优化层（**默认关**）：热点曲目输出缓存 / 本地行离线预测量 | 新增模块 | — | — | 预测量是优化不是主路径 |
| ⏭ | P5-4 | **远期，本轮不做**：Smart Fades L1 beat-aligned / L2 智能混音 | — | — | — | MA 侧是 torch 栈，门槛 `MIN_RAM_GB=4.0`，不可复刻；字段已预留，将来接不改表 |
| ⬜ | P5-5 | 文档：plan 转正 + CHANGELOG + 本文件结项标记 | `docs/`、`CHANGELOG.md`、本文件 | — | — | 项目约定：**未发版不提前写 CHANGELOG** |

**验收结果**：*待填*

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

---

## 11. 与 plan 的分工

| 文件 | 角色 | 什么时候改 |
|---|---|---|
| `docs/audio-pipeline-plan.md` | **规格**：为什么这么做、MA 实证、决策点 D1–D10、风险表 | 设计结论变了才改（例如推翻某个决策） |
| `docs/audio-pipeline-progress.md`（本文件） | **任务清单 + 进度**：做到哪了、卡在哪、验收实测 | **每完成一小项立刻改**（§0 更新规则） |
