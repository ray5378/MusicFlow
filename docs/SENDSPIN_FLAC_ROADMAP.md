# Sendspin FLAC 链路专项开发任务书

> 定位:把 FLAC 从「兜底 codec」打磨成**零卡顿的一等公民路径**。
> 当前默认仍是 **PCM**(`preferred_codec` 缺省 pcm,见插件配置页);FLAC 修复完成的
> 验收标准是:插件页切到 `preferred_codec=flac` 后,真机长时间播放**零 `Lost sync`、
> 零解码报错、出声三件套齐全、听感与 PCM 无差异**。
>
> 必读前置(别重新试错):
> - 真相版(已验证事实):[`docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`](./SENDSPIN_ESPHOME_FLAC_2026-09-17.md)
> - 踩坑录(被推翻的旧结论与共同模式):[`docs/SENDSPIN_PITFALLS_2026-09-18.md`](./SENDSPIN_PITFALLS_2026-09-18.md)
> - 根因修复归档:`CHANGELOG.md` `[3.0.31]`(9B 帧头 / 时间线按实产推进 / 绝对时刻调度)

---

## 一、当前状态(动手前先知道这些已经是对的)

| 项 | 现状 | 位置 |
|---|---|---|
| 9B 音频帧头 | ✅ 已修,回归锁在 `framing.test.ts` | `framing.ts` |
| 时间线按**实际产出**推进 | ✅ 已修(零产出 ≥500ms 才降级推进) | `streamEngine.ts` `STALL_GRACE_US` |
| pacing 绝对时刻调度 | ✅ 已修(`dueMs = paceWallMs0 + i*FRAME_MS/speed`) | `streamEngine.ts` |
| codec 协商 | ✅ 偏好可配(`negotiateCodec(payload, preferred)`,插件页下拉) | `server.ts` |
| FLAC 编码器 | libflacjs **asm.js 变体**(`factory("release")`,WASM 在 Node 下崩) | `encoding.ts` `LibFlacEncoder` |
| block size | 传 0 = **编码器自选**(libFLAC compression≥1 → **4096**;compression 0 → 1152) | `encoding.ts` |
| codec_header | **从编码器真实元数据流提取**(fLaC+STREAMINFO 42B → base64),不硬编码 | `encoding.ts` `realHeaderB64` |
| 设备端 | micro-flac 0.2.0;sendspin-cpp 0.7.2;`BAD_BLOCK_SIZE` 校验在 `frame_header.cpp:88` | ESP Component Registry |

**三处通用修复(帧头/时间线/调度)对 FLAC 同样生效** —— FLAC 曾能出声(有卡顿),
所以本专项的敌人不是「无声」,而是**攒样粒度导致的节奏抖动**。

---

## 二、核心矛盾:喂料粒度 vs FLAC 块大小

PCM 是「喂多少吐多少」(零攒样);libFLAC 是「**攒满一个 block 才吐一帧**」:

```
喂料节奏:每 25ms 喂 1200 样本(FRAME_MS / FRAME_SAMPLES)
FLAC 块:  4096 样本 ≈ 85.3ms ≈ 3.41 次喂料
实际产出:喂 4 次(100ms)后吐 1 帧 4096 样本 ⇒ 产出是「每 85~100ms 一大块」
```

时间线已改为按实际产出推进 ⇒ 时间轴不会漂;**但设备端 ring buffer 的进料是脉冲式的**
(85ms 一大块,块间零进料)。设备 hard-sync 阈值仅 5ms(`sync_task.cpp:36`
`HARD_SYNC_THRESHOLD_US = 5000`),超阈值会**插静音补空** —— 这就是 FLAC 曾「一卡一卡」
的形态学解释。

### 任务 1:真机基线验证(先测再改)

1. 插件页切 `preferred_codec=flac` → 重投一首歌。
2. 采设备日志(出声三件套 + `Lost sync` / `Regained` 计数)+ 服务端 `SENDSPIN_JITTER=1` 的 diff 序列。
3. **判读**:若 `Lost sync: 0` 且听感无卡顿 → FLAC 其实已被三处通用修复治好,本专项只收尾;
   若有周期性插静音(周期 ≈ 85ms 或其倍数)→ 进入任务 2。

### 任务 2:消除攒样脉冲(若任务 1 不达标)

按**代价从小到大**依次试,每步真机回归:

- **方案 A(首选,零风险):`FLAC_COMPRESSION_LEVEL` 降为 0**。
  libFLAC compression 0 自选块 **1152** = 24ms < 25ms 喂料 ⇒ **每次喂料必吐一帧**,
  产出节奏与 PCM 同构,脉冲消失。代价:码率升高(~1.1× PCM 之前先量一下),
  但仍远低于 PCM 的 1.536 Mbps;且压缩 0 对局域网 ARM 设备解码反而更省(子帧多为 FIXED)。
- **方案 B:喂料单位改为块大小整数分块**。把 25ms 粒度改为按 4096 样本(85.3ms)整块喂,
  喂多少出多少、块大小恒定 —— 注意这会改变 `pushFrame` 的调度粒度,与绝对时刻调度
  (`i * FRAME_MS`)强耦合,改动面大,仅当 A 不达标再做。
- **方案 C(不建议)**:保持 4096 + 提高设备端缓冲容忍 —— 需要改设备固件,超出本仓边界。

### 任务 3:边界与约束(改代码前自查)

- **micro-flac `BAD_BLOCK_SIZE`**:实际帧块大小**不得大于** STREAMINFO 声明的 `max_block`
  (设备按它分配解码缓冲)。方案 A 改 1152 后,真实元数据流提取的 STREAMINFO 自然是 1152,
  无冲突;任何「合成 header」路径都要保证两者一致。
- **`-frame_size` 不是 flac 的 AVOption**(是编码器通用参数,勿再当 ffmpeg 对齐手段;
  详见踩坑录坑 3)。
- **短音频尾帧**:libFLAC 常驻编码器是同步回调,无 ffmpeg 那种 ~1.1s lookahead;
  但 `stream/end` 时要 `finish()`/`flush()` 逼尾帧,否则最后一截(不足一块)丢失。
- **不改设备固件、不做 opus**(裸 opus 被客户端拒收,9.x 明确 only PCM and FLAC)。

### 任务 4:带宽与场景定位(收尾)

- 量化 FLAC(compression 0 / 5)实测码率 vs PCM 1.536 Mbps,写进本文件,
  给 `preferred_codec` 的插件页帮助文案提供数据支撑。
- 明确推荐语:局域网 → PCM(零解码);跨网段/带宽敏感 → FLAC。

---

## 三、验收清单(全部满足才算完成)

- [ ] `preferred_codec=flac` 真机连播 ≥ 30 分钟:`Lost sync: 0`、错误计数 0
- [ ] 出声三件套齐全(`speaker_mixer Starting` / `i2s_audio.speaker Starting` / `96000 ring_buffer`)
- [ ] 6053 只读面交叉验证:`media_player state=2 (PLAYING)` 持续(见真相文档第六节)
- [ ] `SENDSPIN_JITTER=1` diff 序列 ±0.5ms 振荡自校正,无单向漂移
- [ ] 短音频(< 5s)播放完整不缺尾
- [ ] `preferred_codec=pcm` 回归:原路径零变化
- [ ] `npx tsc --noEmit` / `vitest run src/services/sendspin/` / `check-i18n.mjs` 全绿
- [ ] 插件页 `preferred_codec` 两个选项都实测过,帮助文案与实测数据一致
