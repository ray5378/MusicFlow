# Music Assistant 源码参考（只读，勿改、勿提交）

- **来源**：https://github.com/music-assistant/server
- **分支**：`dev`（仓库默认分支）
- **快照 commit**：`76c2fcbe28858a410c07a189eae07eaa4b4d8a86`
- **快照时间**：2026-09-19T13:55:57Z（commit: *Serve the app on the first-time setup page (#6403)*）
- **获取方式**：`codeload.github.com/.../tar.gz/refs/heads/dev`，解压到本目录
- **用途**：MusicFlow 音频流水线对齐 MA 时的**唯一权威参照**。方案文档 `docs/audio-pipeline-plan.md` 中每一条 MA 行为断言都应能在本目录里找到出处。
- **本目录已纳入 git 版本管理**（供开发交接对照，勿修改其中文件）。
- **裁剪说明**：原始 dev tarball 为 **106MB / 2931 文件**，已删除与本流水线无关的部分 —— `tests/`（22MB）、`scripts/`、`music_assistant/translations/`、`providers/spotify*` **（含 51MB librespot 二进制）**、以及约 90 个无关 provider（Apple/YouTube/Qobuz/Tidal 等音乐源）。现为 **18MB / 667 文件**，六段流水线相关代码全部保留。
- **保留的 provider**：`smart_fades`、`loudness_analysis`、`dlna`、`airplay`、`sendspin`、`snapcast`、`squeezelite`、`chromecast`、`sonos`、`universal_group`、`sync_group`、文件系统类、`opensubsonic`、`builtin`、`ai_radio`。
- **恢复全量 / 升级版本**（如需查看被裁剪部分或跟进 MA 更新）：
  ```
  curl -sSL https://codeload.github.com/music-assistant/server/tar.gz/refs/heads/dev -o /tmp/ma.tar.gz
  tar -xzf /tmp/ma.tar.gz -C <本目录> --strip-components=1
  ```

---

## 关键文件地图（按六段流水线排列）

### ① Input 解码
| 文件 | 看点 |
|---|---|
| `music_assistant/helpers/audio.py` | `get_ffmpeg_args` 相关；内部格式常量 `ContentType.PCM_F32LE`（约 812–816 行，含 8-bit 源也请求 F32 的处理） |
| `music_assistant/helpers/ffmpeg.py` | `get_ffmpeg_args()`、`get_ffmpeg_channel_args()`：统一的 ffmpeg 参数拼装 |

### ② Processing 响度标准化
| 文件 | 看点 |
|---|---|
| `music_assistant/controllers/streams/audio.py` | **核心**：约 1753–1782 行，三种归一化模式 `DYNAMIC` / `FIXED_GAIN` / `MEASUREMENT_ONLY` 的实际滤镜拼装 |
| `music_assistant/constants.py` | `CONF_ENTRY_VOLUME_NORMALIZATION_TARGET`（约 460 行，`default_value=-14`）、`CONF_VOLUME_NORMALIZATION_*` 系列 key |
| `music_assistant/helpers/audio.py` | `parse_loudnorm()`（约 881 行）：解析 ffmpeg loudnorm 的 JSON 输出 |
| `music_assistant/providers/ai_radio/rendering.py` | loudnorm + alimiter 组合的实际用例（约 177、420 行） |

### ③ Processing DSP
| 文件 | 看点 |
|---|---|
| `music_assistant/helpers/dsp.py` | **核心**：`filter_to_ffmpeg_params()`，所有 filter 类型 → ffmpeg 滤镜的映射（biquad 参量 EQ、3 段 ToneControl、Gain、Balance、Transpose、SafetyLimiter、Compressor、HighLowPass、StereoWidth、Crossfeed） |
| `music_assistant/helpers/ffmpeg.py` | `get_ffmpeg_resample_filter()`（约 490–517 行）：重采样 + dither，含 loudnorm 与 libsoxr 冲突的规避 |

### ④ Processing Smart Fades
| 文件 | 看点 |
|---|---|
| `music_assistant/controllers/streams/smart_fades/` | **核心**：`fades.py`（`SmartCrossFade` / `SmartFade` / `StandardCrossFade`）、`planner.py`、`renderer.py`、`filters.py`（`StreamingCrossfadeFilter`）、`models.py`（`TransitionPlan`）、`helpers.py`（`SMART_CROSSFADE_DURATION = 45`） |
| `music_assistant/providers/smart_fades/` | 分析 provider（**ML 管线**）：`feature_extractor.py`（Log-Mel，22050 Hz）、`dbn_postprocessor.py`（madmom DBN downbeat）、`resources/skey_model.py`（ChromaNet 调性）、`vocal_activity.py`（FireRed 人声活动） |
| `music_assistant/models/audio_analysis.py` | `AudioAnalysisData` 数据结构：loudness / bpm / beats / downbeats / key / rms_energy / spectral_centroid / energy … |
| `music_assistant/controllers/streams/audio.py` | `MIN_CROSSFADE_DURATION = 3`（约 184 行）、`CROSSFADE_HANDOFF_WAIT = 30.0`（约 196 行）、`CrossfadeHandover`（约 220 行） |

### ⑤ Output 限制器
| 文件 | 看点 |
|---|---|
| `music_assistant/helpers/dsp.py` | 约 218–223 行：`alimiter=limit={ceiling}dB:level=false:asc=true:latency=true`（`SafetyLimiterFilter`） |

### ⑥ Output 编码与传输
| 文件 | 看点 |
|---|---|
| `music_assistant/helpers/ffmpeg.py` | `get_ffmpeg_resample_filter()`：`osr=` 采样率收敛、`osf=s16:dither_method=triangular_hp`（仅当输入位深 > 16 且输出 16-bit） |
| `music_assistant/controllers/streams/` | `audio.py`（流主控）、`audio_buffer.py`、`audio_processing.py`、`ogg_handler.py` |
| `music_assistant/providers/*/` | 各播放器 provider 的输出能力声明（Sendspin / AirPlay / DLNA / Snapcast / Squeezelite / Chromecast / Sonos …） |

---

## 阅读建议

1. 先看 `controllers/streams/audio.py` 的 1700–1800 行 —— 这是「一首歌从流详情到 ffmpeg 参数」的主干，六段在这里串起来。
2. 再看 `helpers/dsp.py` 的 `filter_to_ffmpeg_params()` —— 它定义了所有 DSP 的 ffmpeg 写法，我们照抄映射即可。
3. 最后看 `helpers/ffmpeg.py` 的 `get_ffmpeg_args()` / `get_ffmpeg_resample_filter()` —— 决定输出段的编码、重采样与 dither。
