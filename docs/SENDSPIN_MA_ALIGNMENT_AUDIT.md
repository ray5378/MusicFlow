# MusicFlow ↔ MA (aiosendspin) 播放链路全面对齐审计

> 日期:2026-09-17
> 结论前置:**逐字段对照完 MA 后,我们的播放链路在「编码器生命周期」与「时间线/超前量」两处是
> 结构性错位,不是参数微调能修好的。** 本文给出完整对照表与逐项修复方案。
>
> ⚠️ 本文不代表已出声。是否出声**只以用户耳朵验收为准**,在用户确认前任何文档不得写"已出声"。
>
> **⏳ 历史快照（2026-09-19 标注）**：本审计写于 **2026-09-17**，当时**尚未出声**。它指出的两处结构性错位（编码器生命周期、时间线 / 超前量）**已修复并经真机验收** —— 结论与证据见 `SENDSPIN_ESPHOME_FLAC_2026-09-17.md` 与 `CHANGELOG.md` 的 `[3.0.31]`。保留为 MA 对齐对照表存档。

---

## 0. 为什么必须先做全面对齐

此前几轮都是「发现一个参数不对 → 改一个」,结果反复出现「日志全绿但无声」。
根本原因:我们与 MA 在**架构层面**就不同构,所以单点参数对齐永远差一个。

关键证据(本轮实测):

```
我们每 0.5s 分段重起 ffmpeg,每段都是一个独立完整 FLAC 文件:
  段1 前16B: 664c6143000000221000100000000000   ← "fLaC" + STREAMINFO
  段2 前16B: 664c6143000000221000100000000000   ← 又来一次 "fLaC" + STREAMINFO
```

而 MA 是**一个长生命周期编码器**,`stream/start` 已经把 STREAMINFO 通过 `codec_header`
给过设备了,之后只下发**裸 FLAC 帧**(无文件头)。

设备(esp32 micro-flac)拿到 `codec_header` 后按「连续帧流」解析;我们每 0.5s 塞一个
`fLaC` magic + STREAMINFO 元数据块进去 → 解码器在期待 frame sync 的位置遇到文件头 →
**整帧作废、静默、零报错**。

---

## 1. 完整对照表(逐项)

| # | 环节 | MA (aiosendspin) | MusicFlow 现状 | 判定 |
|---|---|---|---|---|
| **1** | **编码器生命周期** | **单实例长驻**(`av.AudioCodecContext.create("flac","w")` 一次创建,反复 `encode(frame)`) | **每 0.5s 重起 ffmpeg 子进程**,每段独立完整 FLAC 文件 | ❌ **结构性错位** |
| **2** | **下发字节形态** | **裸 FLAC 帧**(无 `fLaC`/STREAMINFO;头已由 `stream/start` 给过) | **完整 FLAC 文件**(每段自带 `fLaC`+STREAMINFO) | ❌ **无声根因** |
| **3** | **STREAMINFO 来源** | `encoder.extradata` → `b"fLaC\x80"+u24(len)+extradata`,**只发一次**在 `stream/start` | 手工合成 + 首段实流自校验(`verifyHeaderOnce`) | ⚠️ 值已对,但**重复内嵌在每段** |
| **4** | **块大小** | 让 FLAC 自选(`self._chunk_samples = encoder.frame_size`) | 强制 `-frame_size 4096` | ✅ 已对齐(设备要 4096) |
| **5** | **位深** | `encoder.format = resolve_av_format(16)` → `"s16"` | `-sample_fmt s16` | ✅ 已对齐 |
| **6** | **chunk 时长** | `chunk_duration_us = 25_000`(25ms),或按 `encoder.frame_size` 反推 | `FRAME_MS = 100`(100ms)+ 0.5s 分段 | ⚠️ 粒度粗 4× |
| **7** | **`stream/start` 时机** | 推迟到首块音频(`_pending_stream_start` → `on_audio_chunk` 内发) | 已改为 `pendingAnnounce`,首帧前发 | ✅ 已对齐 |
| **8** | **`stream/end` 时机** | `on_stream_end()` 置 `_stream_started=False`,之后音频**全部丢弃**直到新 start | `finishPlayback()` 发 `stream/end` + `group/update` | ⚠️ 无「丢音频」守卫 |
| **9** | **`send_ahead` 单位** | **微秒**(`_role_send_ahead_us`,`DEFAULT_INITIAL_DELAY_US = 250_000`) | 已从毫秒改为微秒(`(SEND_AHEAD_MS + lat) * 1000`) | ✅ 已对齐 |
| **10** | **`send_ahead` 取值** | `max(min_buffer, required_lead) + output_delay`(设备上报驱动) | 硬编码 800ms + latencyFunc | ⚠️ 未消费设备上报 |
| **11** | **设备上报参数** | 消费 `client/state` 的 `output_delay_ms` / `required_lead_time_ms` / `min_buffer_ms` | **完全未解析**(无 `client/state` 处理分支) | ❌ 缺失 |
| **12** | **时间戳分配** | `_channel_timing` 单调推进 + `_advance_channel_timing`(sample 精确,无漂移) | `baseTs + i*FRAME_MS*1000`(帧计数) | ⚠️ 有 residue 漂移风险 |
| **13** | **二进制帧头** | `>BqI` 13B(1B type + 8B μs ts + 4B send_ahead) | 同 | ✅ 一致 |
| **14** | **空包处理** | 不产生空包 | 已跳过空包 | ✅ 一致 |
| **15** | **`server/state`** | 用于 metadata/controller/color 角色 | `broadcastGroupState()` 定义但**从未调用** | ⚠️ 死代码(player 非必需) |
| **16** | **时钟同步** | `_clock.now_us()` + 客户端 time_sync | `nowUs()` + `timelineBaseUs` | ⚠️ 未与设备对齐时钟 |

---

## 2. 根因定位(按优先级)

### P0 — 每段重复内嵌 `fLaC`+STREAMINFO(无声直接根因)

**现象**:日志全绿、PLAYING、进度推进、设备 `speaker_mixer Starting` + `ring_buffer 96000`,
但**完全无声,零报错**。

**机理**:
1. `stream/start` 携带 `codec_header`(STREAMINFO)→ 设备据此初始化 micro-flac 解码器。
2. 设备进入「连续帧流」解析模式,期待每个 chunk 是 FLAC frame(以 frame sync code 开头)。
3. 我们下发的是**完整 FLAC 文件**:`fLaC`(4B)+ metadata block header(4B)+ STREAMINFO(34B)+ 帧…
4. 设备在每个段边界(每 0.5s)遇到 `66 4c 61 43` 而非 frame sync → 解码失败。
5. micro-flac 对损坏帧**静默丢弃**(不 log、不 error)→ 全程无声。

**MA 做法**:`FlacEncoder._encode_chunk()` 只返回 `encoder.encode(frame)` 的裸 packet,
没有任何容器头。STREAMINFO 已通过 `stream/start.codec_header` 单独给过。

**修复方向**:把「每 0.5s 重起 ffmpeg」改为「**单个长生命周期 ffmpeg 进程**,
持续 `pipe:0` 喂 PCM、`pipe:1` 读**增量帧**」,并**剥掉首段的 `fLaC`+STREAMINFO**
(只用于填充 `stream/start`),之后所有输出原样下发。

等效 ffmpeg 命令需产出「裸帧流」:用 `-f flac` 写 pipe 时 ffmpeg 仍会写一次容器头,
需在 Node 侧**按字节剥头**(跳过 `fLaC` + metadata blocks,至首个 frame sync `0xFFF8`)。

### P1 — 未消费设备上报的延迟参数

MA 的 `send_ahead` 由设备上报驱动:

```
_role_send_ahead_us = max(min_buffer_us, required_lead_time_us) + output_delay_us
                     (live 流则不含 required_lead)
```

我们硬编码 800ms,且**完全没有解析 `client/state`**。
`required_lead_time_ms` 的定义是「server 发 stream/start 到首个 audio chunk 的 timestamp
之间所需的启动超前」—— 正是我们此前踩坑的那个「10.8s 解码延迟」的协议化表达。

**修复方向**:解析 `client/state`,存 `output_delay_ms` / `required_lead_time_ms` / `min_buffer_ms`,
用 MA 同款公式算 `send_ahead`。

### P2 — chunk 粒度 100ms vs MA 25ms

MA 默认 `chunk_duration_us = 25_000`。我们用 100ms。粒度粗会让设备侧 jitter buffer
更难填满、启动更易 underrun。建议对齐到 ~25ms(或按 `encoder.frame_size` 反推)。

### P3 — 时间戳 residue 漂移

MA 用 `_advance_channel_timing` 以**样本数**精确推进并保留余数(`_dur_residue`),
避免整数除法累积漂移。我们用 `i * FRAME_MS * 1000`,帧边界恒定但无 residue 概念。

---

## 3. 修复方案(分阶段)

### 阶段 1:P0 编码器改造(必须,预期解除无声)

1. `FfmpegPcmEncoder` 的 flac 分支改为**单进程常驻**:
   - 构造时起一次 ffmpeg(`-f f32le -i pipe:0 -c:a flac -sample_fmt s16 -frame_size 4096 -f flac pipe:1`)。
   - `encode()` 写 stdin,从 stdout **持续读**增量字节。
   - 需处理「stdout 数据到达时机不可控」——改为 **stdout 事件驱动 + 内部 buffer**,
     每次 `encode()` 返回自上次以来的新帧(去掉容器头后的部分)。
2. **剥头逻辑**:首个 `fLaC` magic 起跳过 metadata blocks,定位到首个 frame sync(`0xFF F8`),
   该点之后的字节即裸帧流;`codec_header` 从被剥掉的 STREAMINFO 取。
3. `flush()` 用 ffmpeg EOF 收尾。

> ⚠️ 风险:ffmpeg 的 flac muxer 会写一次容器头,剥头后帧流是合法的(FLAC 帧自描述)。
> 需实测验证设备接受。

### 阶段 2:P1 消费设备参数

1. 在 `server.ts` 消息分发里加 `client/state` 分支,解析 `payload.player.{output_delay_ms,
   required_lead_time_ms,min_buffer_ms}` 并存入 connection。
2. `computeCommonSendAhead` 改为 MA 公式。

### 阶段 3:P2/P3 粒度与时间戳

1. chunk 粒度对齐 25ms。
2. 时间戳改用样本精确推进 + residue。

---

## 4. 验证清单(每阶段)

- [ ] 服务端:无 `encode failed` / `pushFrame 中断`
- [ ] 段字节:第 2 段起**不再含 `fLaC` magic**(`od -A d -t x1 -N 4` != `66 4c 61 43`)
- [ ] 设备:`Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit`
- [ ] 设备:`speaker_mixer Starting` / `i2s_audio.speaker Starting` / `ring_buffer 96000`
- [ ] 设备:**无** underrun / decode error
- [ ] **用户耳朵验收出声** ← 唯一有效判据

---

## 5. 当前状态

**仍未出声。** 已确认并修复的协议项:块大小(4096)、位深(16)、`stream/start` 延迟宣告、
`send_ahead` 单位(微秒)。**发现但未修的结构性错位:P0 编码器生命周期 / P1 设备参数消费。**

MA 可在同一台设备正常出声 → 硬件/I2S/DAC/喇叭全部正常,问题纯在服务端 wire 行为。
