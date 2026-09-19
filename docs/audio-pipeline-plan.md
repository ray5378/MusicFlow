# MusicFlow 音频流水线对齐 Music Assistant · 实施方案

> 状态：**D2 / D5 / D7 已定，D1 / D3 / D4 / D6 采纳推荐值（见 §5）**，可进入开发交接
> 取证对象一：`ray5378/MusicFlow`（服务端 / Web 前端，main 快照 2026-09-20）+ `MusicFlow-client`（Flutter，当前工作区）—— 我们的现状
> 取证对象二：`music-assistant/server` **dev 分支 commit `76c2fcb`（2026-09-19）**，源码已下载到 **`refs/music-assistant-server/`**（索引见其 `REF-INDEX.md`）—— MA 的真实实现
> 目标：把我们现有的每条输出通道，改造成与 MA 同构的 **六段流水线**。
> **本轮改造的核心价值：实时生效。曲库以网络歌曲为主、无法预先测量，所以响度标准化必须在播放时当场生效，而不是等离线回填。**
> 本文件是播放链路音频处理的**唯一标准**；`docs/` 下其它文档中与之冲突的断言一律以本文件为准（§9 列出被取代的旧断言）。
> 文中所有 MA 行为都标注了 **`文件:行`**，可在 `refs/music-assistant-server/` 中直接核对。

---

## 0. 目标骨架：六段流水线

| # | 段 | MA 的真实行为（源码实证） | 我们要达到的状态 |
|---|---|---|---|
| 1 | **Input 解码** | FFmpeg 解码为 **F32 PCM**（`ContentType.PCM_F32LE`，`helpers/audio.py:815`），采样率与声道**跟随源** | 全通道统一服务端解码为 F32，不再硬编码 48k / 44.1k |
| 2 | **Processing 响度标准化** | 模式选择由 `get_normalization_mode()` 决定（`helpers/audio.py:902-967`）：**无测量值 → `FALLBACK_DYNAMIC` → 实时 `loudnorm`**；有测量值 → `MEASUREMENT_ONLY` → 静态 `volume=XdB`；目标默认 **−14 LUFS**（`constants.py:464`） | **默认走实时 loudnorm，首播即生效**；仅**本地 / WebDAV 行**测过后降级为静态增益（网络源不回写，永远走实时） |
| 3 | **Processing DSP** | 段式链路：各类 filter → ffmpeg 滤镜，见 `helpers/dsp.py:70-260` | 每播放器可配，滤镜映射照抄 MA |
| 4 | **Processing Smart Fades** | `CrossfadeMode.DISABLED / STANDARD_CROSSFADE / SMART_CROSSFADE`；混音控制器 `streams/smart_fades/`（planner/renderer/filters），分析层是 **ML provider** | **本轮做 L0 = `STANDARD_CROSSFADE`**：flow mode + 固定时长 PCM 混合（不做 ML 分析） |
| 5 | **Output 限制器** | `alimiter=limit={ceiling}dB:level=false:asc=true:latency=true`（`helpers/dsp.py:222`） | 全通道统一，dB 单位、`level=false` |
| 6 | **Output 传输** | 按播放器能力编码；重采样 + dither 只在需要时加：`osf=s16:dither_method=triangular_hp`（`helpers/ffmpeg.py:490-517`） | 按通道编码表统一，MIME 随实际格式同步 |

**关键认知：前四段对所有输出通道完全共用，差异只发生在第 5、6 段。**
这就是为什么必须先把 HTTP 链路（客户端 / Web / DLNA）从「原样直出」改造成服务端实时管道 —— 否则它们根本不经过第 1–5 段，谈不上对齐。

---

## 1. 现状取证：我们的代码

### 1.1 一句话结论

**现有通道全部是「源文件原样直出」，从解码到输出没有任何一级做响度 / DSP / 电平处理，也没有交叉淡入。**
歌曲之间的音量差 = 母带本身的音量差；同一首歌换源行后音量还可能再变一次。

### 1.2 逐通道证据

| 通道 | 出流方式 | 代码位置 | 经过流水线第几段 |
|---|---|---|---|
| **Flutter 客户端** | `just_audio` 拉 `/rest/stream?id=`，默认 `original`（不传 `maxBitRate`/`format`）→ 服务端**原样返回文件字节** | `backend/src/routes/rest/index.ts` `/rest/stream`：`decideTranscode()` 判否后进「原样拉流」分支；客户端 `lib/data/models/audio_quality.dart`（`original => null`） | **0 段** |
| **Web 前端** | Howler 播同一个 `/rest/stream?id=`（远程曲走 `/rest/stream-remote`） | `frontend/src/stores/player.ts`（`volume` 默认 0.8） | **0 段**（只有 UI 音量 0–1） |
| **Sendspin（ESP32-S3）** | 服务端 ffmpeg 解码 → **F32 / 48k / stereo** → 编码 flac/opus/pcm(s16le) → WebSocket | `sendspin/streamSource.ts` `ffmpegArgs()`：`-i <源> -ar 48000 -ac 2 -f f32le pipe:1`；`sendspin/encoding.ts`（`SAMPLE_RATE=48000`） | **仅 1 + 6 段** |
| **DLNA / UPnP** | 设备自拉 `/rest/dlna/stream/:token`，路由注释原文：「DLNA 渲染器默认不带 format/maxBitRate → 走原样拉流」 | `dlna/control.ts` `createCastSession()` → `${baseUrl}/rest/dlna/stream/${token}` | **0 段**（仅有 ogg/opus/webm → 兜底 192k mp3 的格式兼容转码） |
| **AirPlay（顺带确认存在）** | 服务端 ffmpeg 解码 → **s16le / 44100** → RAOP | `airplay/decoder.ts` `spawnDecoder()`；`degreesToDb()` 是**设备端衰减**，非增益 | **仅 1 + 6 段** |

### 1.3 服务端转码能力现状（`services/transcode.ts`）

- 只在两种情况下转码：显式 `format=mp3/aac`，或 `maxBitRate` 低于源码率；白名单**仅 mp3 / aac**。
- `spawnTranscoder()` 的 ffmpeg 参数只有 `-c:a libmp3lame/aac -b:a …`，**没有任何音频滤镜**（无 volume / loudnorm / alimiter / dither）。
- ffmpeg 解析顺序 `FFMPEG_PATH` → `ffmpeg-static` → `PATH`（`resolveFfmpeg()`）。
- 并发上限 `TRANSCODE_MAX_CONCURRENT=4`；代码注释已写明：**转码流无法按字节 Range 续传**，seek 只能靠 `timeOffset` 重拉。

### 1.4 数据层现状（`db/schema.ts`）

`songs` 表只有 `duration / bitRate / suffix / path / url …`：
- ❌ 无响度字段（`loudness` / `replayGain` / `peak`）
- ❌ 无分析字段（`bpm` / `key` / `energy`）

→ 建表时**直接对齐 MA 的 `AudioAnalysisData`**（`models/audio_analysis.py:42-116`），避免将来加 Smart Fades 时二次改表（见 P0-1）。

### 1.5 三个必须在设计里处理的坑

1. **测量与分析数据必须绑定到「行 row」，不是「歌 songId」**
   `services/source/resolveAudio.ts` 的 `resolvePlayableRow()` 在本行不可播时会换到兄弟行（local ↔ web ↔ webdav），不同行编码与响度不同 → 键一律用**实际出流的那一行 `row.id`**。网络源尤其重要：同一首歌的 web 行与本地行响度可能不同。
2. **DLNA 的 seek 是 `REL_TIME`**（`dlna/control.ts` `seekDevice()` → SOAP `Seek Unit=REL_TIME`），设备端最终靠字节偏移实现。实时流没有 `Content-Length` → 设备端自带操作拖动会失效（MA flow mode 的同类已知代价）。
   另：`DIDL-Lite` 的 MIME 目前按 `song.suffix` 推断（`plugin/renderers/dlna.ts` `DLNA_MIME`），输出格式一变**MIME 必须同步**，否则设备拒播。
3. **客户端的 timeOffset seek 判定是纯客户端侧的**：`lib/providers/player/transcoded_stream_seek.dart` 的 `shouldUseServerTimeOffsetSeek()` 只看自己请求里的 format/maxBitRate，看不到服务端实际做了什么 → 服务端悄悄转码时它返回 `false` → 走字节 Range seek → **直接失败**。已单列 P2-3 必做项（现有 `player_playback_helpers.dart` 的 `_seekByReloadStream` 可复用，改造面小）。

---

## 2. 目标架构

```
              ┌──── 测量/回写层（对齐 MA AudioAnalysisData，行级） ────┐
              │ 适用范围：仅 local / webdav 行                         │
              │   · 预测量（可选优化：秒级读 REPLAYGAIN 或 ebur128）   │
              │   · 边播边测：loudnorm 播完回写 input_i / input_tp     │
              │ web / 网络源行：一律不回写（每次都走实时 loudnorm）    │
              │ 行被清理 → 同事务删除回写（且仅在源有效时执行）        │
              └───────────────────────┬───────────────────────────────┘
                            │ 有测量值(仅本地/WebDAV)？→ 静态增益 : 实时 loudnorm
     ┌────────────────────────────────▼───────────────────────────────────────┐
     │                    服务端统一管道 AudioPipeline                          │
     │ ① 解码       ffmpeg → F32 PCM（采样率/声道跟随源）                       │
     │ ② 响度       默认 loudnorm=I=-14:TP=-2.0（实时生效）；已测→volume=XdB    │
     │ ③ DSP        preamp → EQ/Balance/… → output gain（D6 采纳推荐值）       │
     │ ④ Smart Fades L0：flow mode 连续流 + 固定时长 PCM 交叉混合（本轮）      │
     │ ⑤ 限制器     alimiter=limit=-1dB:level=false:asc=true:latency=true      │
     └──────┬──────────────┬──────────────┬──────────────┬────────────────────┘
            │ ⑥ 传输（按通道编码 + 重采样 + dither）
     ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐
     │ HTTP 客户端 │ │ HTTP DLNA  │ │ Sendspin   │ │ AirPlay    │
     │ /Web        │ │ 按设备能力 │ │ FLAC 优先  │ │ ALAC/PCM   │
     │ 源族编码    │ │ MIME+ICY   │ │ +dither    │ │ 44.1k/16b  │
     │ seek:offset │ │ 拖动退化   │ │ WebSocket  │ │ RAOP       │
     └─────────────┘ └────────────┘ └────────────┘ └────────────┘
```

**核心原则：与 MA 同构 —— 服务端实时管道出流，四条通道共用 ①–⑤，只在 ⑥ 分叉。**
不做「预渲染缓存」这类旁路：MA 没有这一层（若将来实测 CPU 不可接受，再作为**默认关闭**的可选优化层评估）。

---

## 3. 六段逐段设计（含 MA 源码实证）

### 3.1 ① Input 解码

| 项 | 内容 |
|---|---|
| **MA 实证** | 内部统一为 **32-bit float PCM**：`content_type=ContentType.PCM_F32LE`（`helpers/audio.py:815`，注释明确说明 8-bit 源也请求 F32 以保证后续处理的精度与 headroom）；采样率与声道跟随源，重采样下沉到输出段 |
| **我们现状** | Sendspin 硬编码 `-ar 48000 -ac 2`；AirPlay 硬编码 `-ar 44100` s16le；HTTP 两条链路**根本不解码** |
| **目标** | 解码段只负责解码：输出 F32，不加 `-ar`/`-ac`（跟随源），重采样与位深收敛全部下沉到 ⑥ |

```
ffmpeg -hide_banner -loglevel error [-ss <timeOffset>] -i <rowInput> \
  -vn -sn -dn -map 0:a:0 -f f32le pipe:1
```

- `-ss` 放在 `-i` **之前**（输入定位快）；timeOffset seek 复用客户端现有的重拉机制。
- 输入源由 `resolveRowInput(row)` 统一给出，**必须是 `resolvePlayableRow()` 之后实际出流的那一行**。网络源走远程 URL / `cachePath`，与本地行同一入口。
- ④ 交叉淡入时是**两路解码并存**，解码段要能同时开两条（见 §3.4 的 CPU 风险）。

**落点**：新增 `backend/src/services/audio/pipeline.ts`（`decodeArgs()`），`sendspin/streamSource.ts`、`airplay/decoder.ts` 复用。

> ⚠️ Sendspin 现在解码即 48k，`encoding.ts` 的 `SAMPLE_RATE=48000` 可能与解码段耦合。改造时先确认编码层接受非 48k 输入并重采样，否则「跟随源」先在 HTTP 通道落地（列为 P1-4 确认项）。

### 3.2 ② Processing 响度标准化（**本轮核心**）

**MA 实证 —— 模式选择是一个专门的决策函数（`helpers/audio.py:902-967`）**，这正是为「没有预测量」准备的：

```python
def get_normalization_mode(preference, enabled, streamdetails, source_normalized):
    if not enabled:                                   return DISABLED
    if media_type == AUDIO_SOURCE:                    return DISABLED   # 直播流：上游负责
    if source_normalized:                             return SOURCE     # 源已归一化，别二次归一
    if media_type == SOUND_EFFECT:                    return DISABLED
    if target_loudness is None:                       return DISABLED
    if loudness is None and preference == FALLBACK_DYNAMIC:      return DYNAMIC      # ← 无测量 → 实时 loudnorm
    if loudness is None and preference == MEASUREMENT_ONLY:      return DISABLED
    if loudness is None and preference == FALLBACK_FIXED_GAIN:   return FIXED_GAIN
    if loudness is not None and preference not in (...):         return MEASUREMENT_ONLY
    return preference
```

对应到滤镜（`controllers/streams/audio.py:1753-1782`）：

| 模式 | 滤镜 | 说明 |
|---|---|---|
| `DYNAMIC` | `loudnorm=I={target}:TP=-2.0:LRA=10.0:offset=0.0:print_format=json` | **实时动态归一化，不需要任何预先测量** |
| `FIXED_GAIN` | `volume={gain}dB` | 用户设定的固定增益，track / radio 两个配置值 |
| `MEASUREMENT_ONLY` | `volume={target − loudness}dB` | 用**已测量**的响度算静态增益；`prefer_album_loudness` 时用 album 响度 |

- 目标响度默认 **−14 LUFS**：`constants.py:464` `CONF_ENTRY_VOLUME_NORMALIZATION_TARGET default_value=-14`。
- `MEASUREMENT_ONLY` 是**纯差值、不做 true peak 钳制** —— MA 把防削波交给 ⑤ 的限制器与 loudnorm 自带的 `TP=-2.0`，不在这一段做保守处理。

**我们的决策（D2 已定）：默认 `FALLBACK_DYNAMIC` —— 实时 loudnorm 为主路径。**

```
if 该通道关闭归一化               → 不加滤镜
else if 源已归一化(source_normalized) → 不加滤镜（防二次归一化）
else if 该 row 已有测量值         → volume = clamp(target − LUFS, ±12dB) dB   // 静态，省 CPU、无压缩
else                             → loudnorm=I=-14:TP=-2.0:LRA=10.0:offset=0.0:print_format=json
```

> 💡 **为什么这是本轮的价值所在**：曲库以网络歌曲为主，**根本没有预先测量的机会**。MA 面对 Spotify / 网络电台是同样的处境，它的答案就是 `FALLBACK_DYNAMIC` —— 播放时当场归一化，**首播即生效**，不依赖任何离线回填。

**边播边测（自学习）—— 只写本地 / WebDAV 源，网络源一律不写**（D8 已定）：

`loudnorm` 带 `print_format=json` 时，ffmpeg 会在结束时把实测值打到 stderr。MA 用 `parse_loudnorm()`（`helpers/audio.py:881-901`）解析 `input_i`（integrated LUFS），并对 `-inf`（数字静音）返回 `None`。解析照做，**但回写范围收紧**：

| 源类型 | 是否回写 | 理由 |
|---|---|---|
| `local`（本地文件行） | ✅ 回写 | 文件稳定、可复现，测一次长期有效 |
| `webdav` | ✅ 回写 | 同上，文件由可信存储托管，内容与 URL 稳定 |
| `web` / 网络源 / 在线平台行 | ❌ **一律不写** | URL 有时效、可能换 CDN / 换源，同一首歌多次解析到的码率与母带都可能不同 → 写入的 LUFS 与实际出流**错配**，反而比不写更糟。这类源本来每次都走实时 loudnorm（首播即生效），**不需要缓存值** |

1. 播完（或流结束时）解析 `input_i` / `input_tp`；
2. **仅当该 row 的源类型为 `local` / `webdav`** 时按 **`row.id`** 回写入库；网络源行解析完**直接丢弃**（不入库、不报错、不影响播放）；
3. 本地 / WebDAV 行第二次播放即自动走静态 `volume=XdB` —— 音质更好（无动态压缩）、CPU 更低；
4. 网络源**每次都走实时 loudnorm**，这是它的常态路径，不是"还没测完"的临时态。

> 本地 / WebDAV 行仍可做**离线批量预测量**（`ebur128=peak=true`，或读 REPLAYGAIN 标签秒级换算），但它只是**可选优化**，不是前置条件 —— 不能让"没测完就没效果"阻塞本轮价值。

**回写记录的生命周期 —— 必须随源清理联动（硬要求）**：

回写值依附于「行」而非「歌」。行没了值必须跟着没，否则残留的 LUFS 会变成幽灵数据（将来重新导入同一文件时被复用，而文件可能已换版本）。

- **唯一清理入口**：删除 / 失效一条 `local` / `webdav` 行（文件删除、源移除、重扫描后行消失、缓存清理）。
- **前置校验（不可省）**：执行清理前必须先确认该行所属 local / webdav 源**当前有效可达**（源在线、凭据可用、路径可列）。只有在源有效前提下做的清理，才说明"这首歌真的没了"；**若源本身不可达（临时断网、凭据过期、WebDAV 挂了），一律不动回写数据** —— 否则一次源抖动就会把整库测量结果抹掉。
- **实现要求**：删除行与删除其回写记录必须在**同一事务**内完成（`DELETE FROM audio_analysis WHERE row_id = ?`，或级联外键）。扫描器重建行集合时，用「当前行集合」与「已有回写集合」做差集删除，**且该差集删除只在源探测成功后才执行**；探测失败则跳过本轮清理并记一条 warning 日志。
- 网络源行从不产生回写记录，因此不存在清理问题（天然自洁）。

**实时 loudnorm 的代价（必须显式接受）**：

| 代价 | 说明 | 缓解 |
|---|---|---|
| 动态压缩 | 动态模式（默认 `linear=false`）会压缩响度波动，极端曲目可能有"泵感"；`LRA=10` 限制其幅度 | MA 同样接受；测过之后自动转静态增益即消失 |
| CPU | 高于 `volume` 滤镜（仍远低于任何视频转码） | 独立并发池；测过转静态后归零 |
| 与 libsoxr 冲突 | 链中有 loudnorm 时重采样必须降级 `swr`（`helpers/ffmpeg.py:506` 引 ffmpeg ticket 11323） | 照 MA 处理 |
| 首帧缓冲 | loudnorm 内部有 lookahead 缓冲 | 首字节目标仍按 < 500 ms 验收，实测再调 |

**防二次归一化（照 MA 做）**：若某个上游源本身已按目标响度输出（如部分平台已归一化、或我们已经输出过归一化副本），标记 `source_normalized` → 跳过 ②，否则会"归一化两次"。

**落点**：新增 `backend/src/services/audio/loudness.ts`（`parseLoudnorm()` / `computeGainDb()` / `chooseMode()` 三个纯函数 + 回写入库）；`db/schema.ts` 加字段 + 迁移。

### 3.3 ③ Processing DSP

**MA 实证（`helpers/dsp.py:70-260` `filter_to_ffmpeg_params()`）—— 照抄映射即可：**

| DSP 项 | MA 的 ffmpeg 写法 | 备注 |
|---|---|---|
| 参量 EQ（多段） | `biquad=b0=…:b1=…:a1=…:a2=…`（自算系数） | 含 PEAK / HIGH_PASS / LOW_PASS / NOTCH 各类 |
| 3 段 ToneControl | `equalizer=frequency=100:width=200:width_type=h:gain=X`（100 / 900 / 9000 Hz） | 低/中/高三段 |
| Gain | `volume={gain}dB` | 链路级增益 |
| Balance | `pan=stereo\|FL={att}*FL\|FR=FR` | **只衰减一侧、不做正增益**（源码注释：避免削波风险） |
| Transpose | `rubberband=pitch=…:formant=preserved:pitchq=quality:window=long` | 变调 |
| High/Low Pass | Butterworth biquad 级联，`slope//6` 阶 | 12/24/48 dB per octave |
| StereoWidth | `extrastereo=m={width}:c=0` | `c=0` 关掉内部硬削波（源码注释明确） |
| Compressor | `acompressor=threshold=…:ratio=…:knee=10**(N/20):makeup=…` | knee 由 dB 换算线性因子 |
| Crossfeed | （同文件后续分支） | 耳机交叉馈送 |

**我们现状**：完全没有。

**落点**：新增 `backend/src/services/audio/dsp.ts`（`buildFilterChain(dspConfig) → string[]`）；配置**按播放器**存；Web 设置页 + 客户端设置入口。

> ⚠️ 与 MA 一致的限制：**播放器成组后，多数协议的 per-player DSP 会被禁用**。将来做分组功能必须遵守。

### 3.4 ④ Processing Smart Fades —— **本轮做 L0（标准交叉淡入）**

**D7 已定：本轮实现 `STANDARD_CROSSFADE`，不做 ML 智能混音。**

**MA 实证（本轮要对齐的部分）：**

| 项 | MA 的实现 | 位置 |
|---|---|---|
| 模式枚举 | `CrossfadeMode.DISABLED / STANDARD_CROSSFADE / SMART_CROSSFADE` | `streams/audio.py`（`CrossfadeHandover.crossfade_mode`，约 220-232 行） |
| 时长下限 | `MIN_CROSSFADE_DURATION = 3`（秒） | `streams/audio.py:184` |
| 交接等待 | `CROSSFADE_HANDOFF_WAIT = 30.0` | `streams/audio.py:196` |
| 标准淡入淡出 | `StandardCrossFade`：固定时长重叠 + **静音剥离**（silence stripping） | `streams/smart_fades/fades.py` |
| 混音方式 | **Python 侧流式 PCM 逐片混合**（`helpers.audio.iter_pcm_slices`），不是 ffmpeg 滤镜 | `streams/smart_fades/filters.py` `StreamingCrossfadeFilter` |
| 智能部分 | `SmartCrossFadePlanner` + `TransitionRenderer`，`SMART_CROSSFADE_DURATION = 45` | `streams/smart_fades/`（**本轮不做**） |

**我们现状**：全仓 grep `crossfade` / `fade` **零命中**；且没有 flow mode（DLNA 是单曲 `SetAVTransportURI`，播完一首再投下一首）。

**L0 的实现要点：**

1. **前提：flow mode（连续流）** —— 服务端把队列里的连续曲目拼成**一条不间断流**，两首歌之间才有重叠区可混合。新增 `services/audio/flow.ts`。这是 L0 的真正工作量所在。
2. **混合**：在 F32 域按片做加权混合（`outgoing × w1 + incoming × w2`，权重按线性/等功率曲线）。我们的 Node 侧用 Buffer 逐片处理，等价于 MA 的 `iter_pcm_slices`；**不要用 ffmpeg `acrossfade`**（它要求两个输入已对齐，而我们的两路是流式、长度未知）。
3. **配置项**：`crossfade_mode`（`disabled` / `standard`）、`crossfade_duration`（默认建议 **8 秒**，下限对齐 MA 的 3 秒）。
4. **静音剥离**：照 MA 的 `StandardCrossFade`，曲尾静音段不计入过渡窗口，否则会出现"淡出完还在放静音"。
5. **⚠️ 与 ② 的耦合（最易漏）**：MA 在交叉淡入期间用 `normalization_override` **pin 住** intro/body 的归一化模式（`streams/audio.py:1683`、1749），因为 capacity reselection 会返回**重新解析过的** streamdetails。**我们必须照做**：过渡期间两首歌保持各自已确定的增益，不能因重解析而跳变 —— 否则过渡瞬间音量会突然变。
6. **与 ⑥**：DLNA 侧需 flow mode + **ICY 元数据**注入（连续流里设备拿不到曲目边界）；客户端/Web 的进度用 offset 补偿（客户端已有 `addPlaybackPositionOffset`）。
7. **CPU**：过渡期间是**两路解码同时跑**，并发池必须为交叉淡入预留额外槽位，否则切歌瞬间卡顿。

**验收**：连播时两曲之间无间隙、无爆音；过渡期间响度不跳变（回录 LUFS 在过渡窗口内波动 ≤ 1 LU）；关闭开关后回到"播完再播下一首"。

### 3.5 ⑤ Output 限制器

**MA 实证（`helpers/dsp.py:218-223`）**：

```
alimiter=limit={ceiling}dB:level=false:asc=true:latency=true
```

- `limit` **直接用 dB 表达**（不是线性值）；`level=false` = 不做自动电平补偿、保持纯天花板语义；`asc=true` 抗削波；`latency=true` 重对齐 lookahead 缓冲。
- 它是 **`SafetyLimiterFilter`，由用户放置的 DSP filter**，不是无条件硬编码在链尾。
- 参考用例 `providers/ai_radio/rendering.py:177` 同样用这个写法。

**我们现状**：**无任何削波保护**（现在不削波只是因为从不加增益）。

**目标**：全通道统一，作为 `-af` 链最后一环（编码前），默认 `limit=-1dB`（见 D5）。注意 loudnorm 自带 `TP=-2.0` 已做一层真峰值收敛，限制器是 DSP 叠加增益后的兜底；对 16-bit 目标（Sendspin / AirPlay）尤其重要。

**落点**：`services/audio/pipeline.ts` 链尾统一注入，阈值走全局设置。

### 3.6 ⑥ Output 传输（编码 + 协议）

**MA 实证（`helpers/ffmpeg.py:490-517 get_ffmpeg_resample_filter()`）**：

- 重采样/dither **只在需要时加**：采样率不同，或 `输入位深 > 16 且输出位深 == 16`。
- 采样器：有 libsoxr 且链中没有 loudnorm → `aresample=resampler=soxr:precision=30`；否则 `resample=swr`（loudnorm 冲突，ffmpeg ticket 11323）。
- dither：`osf=s16:dither_method=triangular_hp`（**是 `triangular_hp`，不是 `triangular`**）。

**按通道的编码目标：**

| 通道 | 协议 | 目标编码 | 采样率 / 位深 | 现状 → 目标 |
|---|---|---|---|---|
| **Sendspin（ESP32-S3）** | WebSocket | **FLAC 优先**（协议要求服务端支持 flac/opus/pcm） | 48k / 16-bit（MA 的 Sendspin 实现目前也是 16-bit） | 补增益 + 限制器 + dither |
| **AirPlay（RAOP）** | RAOP（非 HTTP） | 无损 PCM，可选 ALAC | **44.1k / 16-bit 硬上限** | 同上 |
| **HTTP · 客户端 / Web** | HTTP | **跟随源族**：无损源 → FLAC；有损源 → 同族高码率（mp3 320 / aac 256） | 跟随源 | 「原样直出」→ 实时管道出流 |
| **HTTP · DLNA** | HTTP | 按设备能力：FLAC 优先，不吃则回退 mp3 320（复用现有 ogg→mp3 兜底） | 跟随源 | 同上；**MIME 必须随实际格式同步**，flow mode 下加 ICY |

**HTTP 通道的三件配套**（实时化必须补，照 MA 做法）：

| # | 问题 | MA 的做法 | 我们要做的 |
|---|---|---|---|
| 1 | seek：实时流没有字节 Range | flow mode 按时间定位；DLNA 上接受代价 | 客户端已有 timeOffset 重拉（**判定要改**，P2-3）；Web 端 Howler 补 offset 重建 URL；DLNA 接受设备端拖动退化 |
| 2 | 时长/元数据：无 `Content-Length` | ICY 注入曲目信息 | 我们的 UI 进度来自服务端状态 / WS 推送（DLNA 有 `GetPositionInfo` + eventing），**UI 不受影响**；只有音箱/电视自带屏显缺时长 —— 与 MA 同类 |
| 3 | CPU / 首字节 / 并发 | 每播放器一条常驻 ffmpeg 管道 | `TRANSCODE_MAX_CONCURRENT=4` 上调；归一化管道设**独立并发池**，不与用户主动选的音质转码互抢槽；交叉淡入再预留槽位；首字节目标 < 500 ms |

---

## 4. 统一管道的实现

新增 `backend/src/services/audio/pipeline.ts`，把六段串成**一条 ffmpeg 参数**；四条通道都只是「取行输入 → 走管道 → 按通道编码 → 按协议下发」：

```ts
interface PipelineRequest {
  row: RowInput;            // resolvePlayableRow() 之后实际出流的那一行
  timeOffsetSec?: number;   // seek
  channel: "http" | "sendspin" | "airplay" | "dlna";
  target: ChannelTarget;    // codec / sampleRate / bitDepth / mime
  loudness: LoudnessRow | null;   // ② 已测量的值（null → 走 loudnorm 实时）
  sourceNormalized?: boolean;     // 源已归一化 → 跳过 ②
  dsp?: DspConfig;          // ③
  fade?: FadeConfig;        // ④ L0：crossfade_duration / 静音剥离
}

buildArgs(req): string[] {
  // ① 解码
  args.push("-ss", t, "-i", row.input, "-vn", "-sn", "-dn", "-map", "0:a:0");
  // ② 响度（有测量 → volume；无测量 → loudnorm；源已归一化 → 跳过）
  // ③ DSP（preamp → filters → output gain）
  // ⑤ 限制器（链尾）
  // ⑥ 重采样 + dither（按需）→ 编码
  const af = [...].filter(Boolean).join(",");
  args.push("-af", af);
  args.push(...codecArgs(target));
}
```

- **Sendspin / AirPlay**：管道输出 F32 交给既有编码层，只多一条 `-af`，几乎零额外成本 → **最先见效**。
- **客户端 / Web / DLNA**：管道输出直接作为 HTTP 响应体流式下发，替代「原样拉流」分支。
- ④ 在管道**之上**（两路管道 → 混合器 → 单路输出），不是 `-af` 链内的一环。
- 开关：全局 + 每通道独立（落 `services/settings.ts`）。关闭 = 回到今天的行为。

---

## 5. 决策点（✅ = 已定，⏳ = 采纳推荐值，可一句话推翻）

| # | 问题 | 结论 |
|---|---|---|
| **D1** | 目标响度 | ⏳ **−14 LUFS**（对齐 MA 默认 `constants.py:464`） |
| **D2** | 无测量曲怎么办 | ✅ **走 `FALLBACK_DYNAMIC`：实时 `loudnorm`，首播即生效**。曲库以网络源为主，无法预测量 —— 这正是本轮改造的价值所在 |
| **D3** | 是否做 true peak 钳制 | ⏳ **不钳制**：loudnorm 自带 `TP=-2.0`，静态路径靠 ⑤ 限制器兜底（对齐 MA） |
| **D4** | HTTP 通道输出编码 | ⏳ **跟随源族**（无损→FLAC，有损→同族高码率；DLNA 不吃 FLAC 回退 mp3 320） |
| **D5** | DLNA 是否默认开启 + 限制器阈值 | ✅ **DLNA 与其它通道一致默认开启**，显式接受「设备端自带操作拖动进度退化 / 屏显时长缺失」（MA flow mode 同类代价），并保留**单设备回退开关**；限制器 **−1 dB** |
| **D6** | DSP 首期范围 | ⏳ **Gain + 3 段 ToneControl + 多段参量 EQ + Balance**（MA filter 集合中最常用的四个） |
| **D7** | Smart Fades 本轮做不做 | ✅ **本轮做 L0 = `STANDARD_CROSSFADE`**（flow mode + 固定时长 PCM 混合 + 静音剥离）；**不做** ML 智能混音（L1/L2） |
| **D8** | 边播边测的回写范围 | ✅ **只写 `local` / `webdav` 源**；**网络源一律不写**（URL 有时效/换源风险，缓存值会错配）。回写随行删除**同事务清理**，且**仅在该源探测有效时**才执行清理 |

---

## 6. 任务清单（交接用）

### P0 · 数据层与响度核心（无播放行为改动，可独立上线）

| # | 任务 | 落点 |
|---|---|---|
| P0-1 | 建表**对齐 MA `AudioAnalysisData`**：`loudness_integrated` / `loudness_album` / `loudness_range` / `true_peak` / `bpm` / `beats` / `downbeats` / `beats_per_bar` / `key` / `mode` / `rms_energy` / `spectral_centroid` / `energy` + `measured_at`，行级 + drizzle 迁移 | `backend/src/db/schema.ts` |
| P0-2 | `parseLoudnorm()`：解析 ffmpeg stderr 的 loudnorm JSON，取 `input_i` / `input_tp`，`-inf`（数字静音）返回 null（照 `helpers/audio.py:881-901`） | 新增 `backend/src/services/audio/loudness.ts` |
| P0-3 | `chooseMode()` 模式决策 + `computeGainDb()` 增益计算（三个纯函数，必须可单测） | 同上 |
| P0-4 | 边播边测回写：**仅 `local` / `webdav` 行**在流结束时按 `row.id` 入库；网络源行解析后丢弃（D8） | 同上 + 播放结束钩子 |
| P0-5 | 单测：JSON 解析（含 -inf / 解析失败）、模式选择全分支、增益 ±12dB 限幅、**行级绑定**（换源行取对应行值） | 新增 `backend/tests/services/loudness.test.ts` |
| P0-6 | **回写清理联动**：删除 local/webdav 行时同事务删除其回写；扫描差集删除**仅在源探测成功后**执行，探测失败跳过并记 warning | 源清理 / 扫描逻辑 + `loudness.ts` |
| P0-7 | 单测：**网络源行不回写**（断言 DB 无记录）、**源不可达时清理不执行**（回写仍在）、行删除后回写归零 | `backend/tests/services/loudness.test.ts` 扩展 |

**验收**：loudnorm JSON 解析与 MA `parse_loudnorm` 行为一致（含数字静音返回 null）；模式选择 6 个分支全覆盖；**网络源播放后 `audio_analysis` 表无新增行**；**源不可达触发的扫描不会清空既有回写**。

### P1 · 管道骨架 + Sendspin / AirPlay（①②⑤⑥）

| # | 任务 | 落点 |
|---|---|---|
| P1-1 | 新增 `AudioPipeline`：解码 F32（跟随源）+ `-af` 链 + 编码 | 新增 `backend/src/services/audio/pipeline.ts` |
| P1-2 | Sendspin 接入（替换 `ffmpegArgs()` 的硬编码 48k 解码） | `sendspin/streamSource.ts` |
| P1-3 | AirPlay 接入 | `airplay/decoder.ts` |
| P1-4 | 输出段：`osf=s16:dither_method=triangular_hp`（仅 >16bit→16bit）；确认 Sendspin 编码层对非 48k 输入的处理 | `sendspin/encoding.ts` |
| P1-5 | 客户端/Web 已选音质档位时并入同一次转码，**不额外起进程** | `services/transcode.ts` `spawnTranscoder()` |
| P1-6 | 单测：参数拼装、模式切换、限制器/dither 随位深开关、**loudnorm 时重采样降级 `swr`** | `backend/tests/sendspin/ffmpegInputContract.test.ts` 扩展 |

**验收**：ESP32-S3 与 AirPlay 连播 10 首**网络源**曲目（未预测量），回录 LUFS **曲目间差异 ≤ 1 LU**，true peak ≤ −1 dBTP；**首次播放即生效**。

### P2 · HTTP 通道实时管道化（客户端 / Web / DLNA）

| # | 任务 | 落点 |
|---|---|---|
| P2-1 | `/rest/stream` 走管道；响应加 **`X-MusicFlow-Transcoded: 1`** 头 | `backend/src/routes/rest/index.ts` |
| P2-2 | `/rest/dlna/stream/:token` 走管道；**MIME 同步**（`DLNA_MIME` 与 `buildDidlLite()` 按实际输出格式给） | 同上 + `plugin/renderers/dlna.ts` + `dlna/control.ts` |
| P2-3 | **客户端 seek 判定改造（必做）**：改为按响应头 / 服务端能力判定 | `lib/providers/player/transcoded_stream_seek.dart` + `player_playback_helpers.dart` |
| P2-4 | Web 端 seek 适配：Howler 无 Range 时按 `timeOffset` 重建 URL，进度用 offset 补偿 | `frontend/src/stores/player.ts` |
| P2-5 | 并发池：上调 + 归一化独立并发，不抢音质转码的槽 | `services/transcode.ts` |
| P2-6 | 契约测试：开关开/关、换源行后增益变化、MIME 随格式变化、响应头存在、DLNA 拒 FLAC 回退 | 新增 `backend/tests/services/pipeline.test.ts` |

**验收**：客户端与 DLNA 连播 10 首网络源差异 ≤ 1 LU；**客户端拖动进度实测通过**；首字节 < 500 ms。

### P3 · ④ Smart Fades L0（本轮做）

| # | 任务 | 落点 |
|---|---|---|
| P3-1 | **flow mode**：服务端把队列连续曲目拼成一条不间断流（两路解码并存） | 新增 `backend/src/services/audio/flow.ts` |
| P3-2 | **标准交叉淡入**：F32 逐片加权混合，时长可配（默认 8s，下限 3s 对齐 MA） | 新增 `backend/src/services/audio/fades.ts` |
| P3-3 | **静音剥离**：曲尾静音不计入过渡窗口 | `fades.ts` |
| P3-4 | **`normalization_override`**：过渡期间 pin 住两首歌各自的归一化模式，防增益跳变（照 `streams/audio.py:1683`、1749） | `flow.ts` + `loudness.ts` |
| P3-5 | DLNA 侧 flow mode + **ICY 元数据**注入 | `dlna/control.ts` |
| P3-6 | 并发池为交叉淡入预留额外槽位（过渡期 CPU 翻倍） | `services/transcode.ts` |
| P3-7 | 单测：混合权重曲线、静音剥离、**过渡期间增益不跳变**、开关关闭回到逐首播放 | 新增 `backend/tests/services/fades.test.ts` |

**验收**：连播无间隙、无爆音；过渡窗口内回录 LUFS 波动 ≤ 1 LU；关闭开关回到现状行为。

### P4 · ③ DSP

| # | 任务 | 落点 |
|---|---|---|
| P4-1 | `buildFilterChain()`：照抄 MA 的滤镜映射（Gain / ToneControl / 参量 EQ biquad / Balance 只衰减） | 新增 `backend/src/services/audio/dsp.ts` |
| P4-2 | per-player 配置存储 + 设置 API | `services/settings.ts` + 新增表 |
| P4-3 | Web 设置页面板 + 客户端设置入口 | `frontend/src/`、`lib/features/settings/` |
| P4-4 | 单测：滤镜串接顺序、空配置不加滤镜、分组成组时按 MA 规则禁用 | 新增 `backend/tests/services/dsp.test.ts` |

### P5 · 收尾与远期

- 全局 + 每通道开关 UI（服务端 `settings.ts` + Web 设置页 + 客户端入口）
- DLNA 单设备回退开关（某台设备不接受实时流时单独关闭）
- **可选优化层（默认关）**：热点曲目输出缓存 / 本地行离线预测量
- **远期，本轮不做**：Smart Fades L1 beat-aligned、L2 智能混音（MA 用 torch + Beat This + madmom DBN + ChromaNet + FireRed，推荐 6 GB RAM，**不可复刻**）。分析字段已按 `AudioAnalysisData` 预留，将来要接也不改表
- 文档：本文件转正 + CHANGELOG

---

## 7. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| 实时流破坏 DLNA 的 `REL_TIME` seek | 设备端自带操作拖动失败 | **已接受的代价（D5）**，与 MA flow mode 同类；UI 进度走服务端状态/WS 推送不受影响；留单设备回退开关 |
| 客户端按旧判定走字节 Range seek | 拖动进度直接失败（**最易漏**） | P2-3 必做：改 `shouldUseServerTimeOffsetSeek()` 按响应头判定 |
| `loudnorm` 与 libsoxr 冲突（ffmpeg ticket 11323） | 采样率转换异常 / 报错 | 照 MA 处理：链中有 loudnorm 时重采样降级 `swr` |
| loudnorm 动态压缩导致"泵感" | 极端动态曲目听感变化 | 测过之后自动转静态 `volume`；`LRA=10` 限制幅度 |
| **过渡期增益跳变** | 交叉淡入瞬间音量突变 | P3-4 必做：pin 住 `normalization_override` |
| 交叉淡入期 CPU 翻倍 | 切歌瞬间卡顿 | P3-6：并发池预留槽位 |
| CPU / 并发打满 | 多设备同时播排队卡顿 | 独立并发池 + 并发上限上调；测过转静态后 CPU 归零；必要时降级 mp3 320 |
| 首字节延迟 | 点播到出声变慢 | 目标 < 500 ms；可提前起进程预热 |
| 换源行导致增益错配 | 增益与实际出流不符 | 测量键与回写键一律 **row.id**；网络源换源后重新走 loudnorm |
| 网络源回写值失效（换 CDN / 换码率 / URL 过期） | 缓存的 LUFS 与实际出流不符，**比不写更糟** | **网络源一律不回写**（D8），每次走实时 loudnorm |
| 源抖动（断网 / 凭据过期）导致扫描误删回写 | 整库测量结果被抹掉 | 差集清理**仅在源探测成功后**执行；探测失败跳过 + warning（P0-6） |
| 行删除后回写残留 | 幽灵 LUFS 被复用 | 同事务删除 / 级联外键（P0-6） |
| loudnorm JSON 解析失败 / 数字静音 | 回写异常值 | 照 MA：`-inf` 与解析失败一律返回 null（不入库），绝不中断播放 |
| 源已归一化却被二次归一化 | 响度被抬两次、可能削波 | 照 MA：标记 `source_normalized` 时跳过 ② |
| 解码改为跟随源采样率 | Sendspin 编码层可能假设 48k | P1-4 明确确认；必要时 HTTP 通道先行 |

**回退**：全局开关一键关闭即回到今天的行为（全通道原样直出 + 逐首播放）。P0 只加字段与纯函数，不改变任何播放行为。

---

## 8. 验收总口径

1. **实时生效（本轮核心）**：10 首响度差异大的**网络源**曲目（**未做任何预测量**），在 **客户端 / Web / Sendspin / DLNA / AirPlay** 上首次播放即生效，回录 integrated LUFS，**曲目间差异 ≤ 1 LU**。
2. **无削波**：所有通道 true peak ≤ −1 dBTP。
3. **六段齐备且顺序正确**：解码 F32 → 响度 →（DSP）→ 交叉淡入 L0 → 限制器 → 编码传输；任一通道不得跳过 ②⑤。
4. **交叉淡入**：连播无间隙、无爆音；过渡窗口内 LUFS 波动 ≤ 1 LU（P3 完成后验收）。
5. **自学习（仅本地 / WebDAV）**：同一首**本地或 WebDAV** 曲第二次播放走静态 `volume`（可查日志/DB 确认 `loudness_integrated` 已回写且模式为 MEASUREMENT_ONLY）；**网络源第二次播放仍走实时 loudnorm**，且 `audio_analysis` 表**不得**新增记录。
6. **回写自洁**：删除一条本地 / WebDAV 行后其回写记录归零；**人为让源不可达后触发扫描，既有回写必须一条不少**。
7. **功能无回归**：暂停/继续、切歌、换源行、离线缓存保持现状；**客户端与 Web 拖动进度必须实测通过**；DLNA 接受设备端拖动退化，但播放/切歌/暂停必须正常。
8. **性能**：每条 HTTP 通道常驻一条 ffmpeg 管道，首字节 < 500 ms；交叉淡入期两路解码不超时；Sendspin/AirPlay 仅多一条 `-af`，增量可忽略。

---

## 9. 附：本文档取代的旧断言

| 旧断言 | 新标准（本文件） |
|---|---|
| 「HTTP 链路保持原样直出（零 CPU / 保 Range）是设计选择」 | 是**现状**，不是设计目标；目标为服务端实时管道（§2、§3.6） |
| 「响度归一化走预渲染缓存 / 离线副本」 | 取消；MA 没有这一层，六段全部实时（§2） |
| 「DLNA 不做实时转码」 | 改为与其它通道一致走实时管道，代价显式接受（§3.6、D5） |
| 「音量由客户端/前端 UI 音量控制即可」 | UI 音量是**用户偏好**，不属于流水线；标准化只在服务端 ② 段（§3.2） |
| 「转码只用于音质档位（mp3/aac）」 | 转码层升级为统一管道，输出格式由 ⑥ 通道能力表决定（§3.6） |
| 「采样率统一 48k / 44.1k」 | 解码段跟随源，重采样下沉到 ⑥（§3.1、§3.6） |
| 「无削波保护不是问题（因为从不加增益）」 | 加增益后必须有限制器 ⑤（§3.5） |
| 「限制器用线性 limit 值 / dither 用 triangular」 | MA 源码实证：dB 单位 + `level=false:asc=true:latency=true`；dither 是 `triangular_hp`（§3.5、§3.6） |
| 「未测量的曲维持 0 dB 原样播放」 | ✅ 已定：走 `FALLBACK_DYNAMIC` 实时 loudnorm，**首播即生效**（§3.2、D2） |
| 「先做离线批量测量，测完才有效果」 | 反了：预测量降为**可选优化**，实时 loudnorm 是主路径（§3.2、P0） |
| 「交叉淡入属远期，本轮不做」 | ✅ 已定：**本轮做 L0 标准交叉淡入**（§3.4、P3） |
| 「边播边测对所有源都回写（听过一次即固化）」 | 收窄：**仅 `local` / `webdav` 行回写**；网络源一律不写，永远走实时 loudnorm（§3.2、D8） |
| 「回写值随歌曲长期保留」 | 回写依附于**行**：行删除即同事务删除，且仅在源探测有效时才执行差集清理（§3.2、P0-6） |
