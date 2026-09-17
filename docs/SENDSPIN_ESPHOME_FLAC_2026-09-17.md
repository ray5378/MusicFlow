# Sendspin × ESPHome 真机排障与修复(ESP32-S3 / esp32-player-meet)

> 最后更新:2026-09-18
> 目标设备:`esp32-player-meet`(ESP32-S3, MAC `3C:0F:02:F9:69:E4`, IP `192.168.10.245`, ESPHome **2026.9.0**)
> 当前状态:**出声 ✅ 且零卡顿 ✅**(用户亲耳验证 + 设备侧自报 `state=2 (PLAYING)` 双重确认)
> ⚠️ 本文件于 2026-09-18 **重写**。此前版本记载的「13B 帧头」「STREAMINFO block size 是决定性根因」
> 「用固定 `-frame_size` 对齐 MA」「MA 靠连 6053 才不重启」等结论均经设备端源码取证**推翻**,已删除。
>
> 📌 **踩坑录(错误判断与教训)另见 [`SENDSPIN_PITFALLS_2026-09-18.md`](./SENDSPIN_PITFALLS_2026-09-18.md)**
> —— 走错的路记在那里,本文件只保留验证过的真相。改这套链路前建议先看一眼。

---

## 一、角色与端口分工(先把这事钉死)

| 端口 | 归属 | 作用 |
|---|---|---|
| **38927** | **MusicFlow 的 Sendspin server** | 控制 + 音频**共用一条 WebSocket**(刻意避开 MA 的 8927) |
| 8927 | Music Assistant 的 Sendspin server | 同上(MA 用) |
| 8928 | Sendspin client(每台设备自监听) | 服务端主动拨设备时连这里 |
| **6053** | ESPHome **Native API** | 控制面(实体/状态/服务)。**只有 HA、ESPHome Dashboard 连它**;音乐流完全不走这里 |
| 8095 / 8097 | MA Web API / MA Stream Server | 与 Sendspin 无关 |

**38927 与 6053 是互不相干的两套协议。** 别指望 6053 能管音频,也别指望 sendspin 能读设备实体。

---

## 二、四个真正的根因(全部真机取证,按发现顺序)

### ① 音频二进制帧头**必须是 9B** —— 决定性根因,曾导致完全无声

设备 `sendspin-cpp` 的处理链:

```
client.cpp:process_binary_message()   只剥 1B type
player_role.cpp:26   static constexpr size_t BINARY_TIMESTAMP_SIZE = 8;
player_role.cpp:244  send_audio_chunk(data + 8, len - 8, timestamp, CHUNK_TYPE_ENCODED_AUDIO);
```

即:**8 字节时间戳之后,设备一律当作编码音频**。

此前实现按「对齐 aiosendspin」在时间戳后又塞了 4 字节 `send_ahead`(共 13B),这 4 字节
于是落在 payload 头部 —— 首字节 `0x00` 而不是 FLAC 同步字 `0xFF`,每包都被判坏:

```
Serious error decoding FLAC file → Failed to decode audio chunk → 无声
```

**`send_ahead` 根本不是 wire 字段** —— 整个 sendspin-cpp 源码库中 `send_ahead` **零出现**。
它只应参与**时间线锚点**的计算(服务端内部),不下发给设备。

### ② 时间线必须**按实际产出**推进(不能按喂入量)

编码器攒样期(libFLAC 要攒满一块才吐帧)若把"喂进去但没吐出来"的量算成已播出,
时间线会超前约 75ms → 设备报 `Lost sync (75006us off)` → 往音乐里**插静音**补空 → 听感卡顿。

```
produced > 0 ? 按产出推进 : 不推进
```

零产出超过 `STALL_GRACE_US`(500ms)才降级为按喂入量推进,避免编码器真坏时时间线冻结。

### ③ pacing 必须**绝对时刻调度**(固定 sleep 会累积漂移)

`await sleep(25)` 之外还有 encode/send 开销,实际周期约 26ms 而时间戳只推 25ms →
每包落后 1~1.8ms 并**单向累积**(实测跑到 −611ms)。设备 hard sync 阈值只有 **5ms**
(`sync_task.cpp:36 HARD_SYNC_THRESHOLD_US = 5000`),越界就插静音 → 「一卡一卡」。

```
dueMs = paceWallMs0 + (i * FRAME_MS) / speed;
await sleep(dueMs - Date.now());   // 自校正,±0.5ms 振荡
```

### ④ codec **PCM 优先,FLAC 兜底**

- **FLAC**:服务端 libFLAC 要攒满 4096 样本才吐帧(85ms),而喂料是 25ms 粒度 —— 天然错位;
  设备端还要每 85ms 用 micro-flac 解一帧。
- **PCM**:设备走 `CHUNK_TYPE_PCM_DUMMY_HEADER`,`decode_audio_chunk()` 里只是一条 `std::memcpy`
  —— 零解码、零攒样。代价只有带宽(48k/2ch/16bit ≈ 1.536 Mbps),局域网完全可接受。

FLAC 链路在上述 ①②③ 修复后同样可用,作为「设备不支持 PCM」时的兜底。
默认偏好已做成**插件配置项 `preferred_codec`**,可在 Sendspin 播放器插件页切换。

---

## 三、仍然成立的事实(这些是真机量出来的,别再重新试错)

**ffmpeg 链路**
- 容器内 ffmpeg = `/app/backend/node_modules/ffmpeg-static/ffmpeg`(**无系统 ffmpeg**,7.0.2-static)。
- flac 编码器 sample_fmt 支持 `s16 s32`;必须带 `-sample_fmt s16`(否则 f32le 默认编 s32 → 24bit)。
- 常驻 ffmpeg 输出带容器头:`fLaC` + STREAMINFO(4+34) + VORBIS_COMMENT + 8KB PADDING = **8288B**,
  首帧 sync 在偏移 8288,必须剥掉。
- 首帧前有 **~1.1s lookahead 零输出**,`-flush_packets 1` 无效 → 短音频(≤1.1s)必须 `flush()` 逼尾帧。
- STREAMINFO 应**从真实流提取**,不要硬编码。
- ffmpeg 48kHz 自选 block size = **4608**;libFLAC 默认 = 4096(compression≥1)。两者不同源,别混为一谈。

**时间戳模型**
- `ts = 锚点 + 累计实际样本数 / SR`(样本精确,**绝不按调度粒度**)。
- 锚点 = `nowUs() + SendspinGroup.commonSendAheadUs()`。
- `commonSendAheadUs()` 是**唯一出口**:`sendAudio` 与锚点都必须用它。曾有版本误把 MA 的
  `DEFAULT_INITIAL_DELAY_US=250ms` 当独立常量 → 锚点 250ms vs send_ahead 800ms → `delta` 恒 −550ms
  → 设备收首块即判「已过期」→ 立即吐字节 → underrun → **日志全绿但无声**。
- 设备上报 `output_delay/required_lead/min_buffer` 为 0 时必须视为「未提供」回落缺省 800ms
  (ESPHome 实测恒报 0,是表达能力缺失,不是真的不需要 buffer)。

**不要等设备回 `server/activate`** —— 真机明确 `Unhandled server message type: server/activate`,
永不回;等它 = 15s activation timeout 自杀连接。

**服务端不要拨设备自身端口(8928)** —— 被判竞争第二个 server,回 `goodbye: another_server`
并被永久抑制重拨。正确方向是**设备经 mDNS 自行拨入 38927**。

---

## 四、出声判据(设备侧)

| 层 | 判据 |
|---|---|
| 协议 | `Processed new codec header: <codec>, 48000 Hz, 2 ch, 16-bit` |
| 播放器 | `State changed to PLAYING` |
| **出声三件套** | `speaker_mixer Starting` → `i2s_audio.speaker Starting` → `96000 ring_buffer [speaker_task]` |
| **6053 只读面** | `media_player state=2 (PLAYING)`(见第六节) |

注意 `speaker_mixer Starting` 只在**首次**打印;`19200 ring_buffer` 早于三件套出现。

---

## 五、ffmpeg 端坑:接口原则

- 鉴权失败会**静默返回空 result**(不抛错)→ 手动为空要当失败处理,并显式审计Mock。
- 不要信任 `result[0]`,用 `result.find(...)` 按 `"xxx"` 精确定位。
- 付费/会员歌曲缺源是正常的,**不要重试也不要递归调用**;判空/判 `"xxx"` 直接返回 null。
- 接口返回的结构务必**先看真实响应再写代码**,别靠猜字段名。

---

## 六、ESPHome 只读监控(6053)—— 新增能力

**设备没有被当做 FLAC 这条路为了让服务端能自证「推的流真的在播」,反向建立一条 6053 只读连接。**

配置:插件页 `Sendspin 播放器` → `ESPHome 只读监控(6053)` 开关 + `ESPHome API 加密密钥`。
设备 IP **自动派生**(取自 Sendspin 连接的对端地址),无需填写。

实测出来的能力边界(`featureFlags = 0x12520d`):

| 能做 | 不能做 |
|---|---|
| 读 `state`(`NONE/IDLE/PLAYING/PAUSED/...`) | ❌ `SEEK` —— 设备未宣告 |
| 读 `volume`(speaker 硬件输出音量) | ❌ `NEXT_TRACK` / `PREVIOUS_TRACK` |
| PAUSE / STOP | ❌ `PLAY` —— **只能停不能起** |
| 保活(喂 `reboot_timeout` 计时) | ❌ 音量不建议在这里设(与 Sendspin group volume 相乘会打架) |

根因:6053 上能看到的实体是 `platform: speaker_source` 的 `Speaker Media Player`
(yaml 里 `platform: sendspin` 那个没写 `name`,ESPHome **不会暴露无 name 的实体**),
它面前只有一条 PCM 流,**没有曲目和队列的概念**。切歌与进度的权威天然在服务端。

查询出口:`GET /v1/sendspin/esphome`(**不回显 PSK**),或在服务端日志看 `[Esphome] 6053 已连接 ...`。

**设备周期性重启的真凶**(曾每 15 分钟 `No clients; rebooting`):
`api.reboot_timeout` 默认 15min,只认 6053 上的连接。修法是固件 `api: reboot_timeout: 0s`
(`0s` = 关闭,**`60s` 是反方向**会变成每分钟重启),或由 HA 的 ESPHome 集成常驻。
⚠️ 调过这部分的话注意:**调试脚本自己连着 6053 时就是一个 client,会掩盖这个问题。**

---

## 七、部署方式(容器无代码卷挂载)

```bash
# 本机
cd backend && npx tsc
scp -P 35320 -i "E:\SSH私钥\mykey\mykey" dist/... root@192.168.10.240:/root/
# 服务器
docker cp /root/xxx.js musicflow:/app/backend/xxx.js
docker exec musicflow chown -R musicflow:musicflow /app/backend
docker restart musicflow
```

⚠️ **只能用 `docker restart`** —— `docker compose up --force-recreate` 会抹掉 docker cp 的补丁。

---

## 八、环境速查

- 宿主:`192.168.10.240`,`ssh -i "E:\SSH私钥\mykey\mykey" -p 35320 root@192.168.10.240`
- 容器:`musicflow`(镜像 `ray5378/musicflow:latest`,`entrypoint.sh → node dist/index.js`)
- 数据卷:`/vol1/1000/SSD/docker/musicflow/data`(`musicflow.db`、`sendspin/{identity.key,dial_targets.json,pairing_store.json}`)
- 设备 Native API PSK:`esp32-player-meet` yaml 中 `api: encryption: key` 的值
- 设备日志采集:`aioesphomeapi` 连 6053 订阅 VERBOSE

---

## 九、已知遗留

- `stream/end` 之后缺「丢弃已过期音频」的守卫(对应 MA `_stream_started`)。
- 切歌时 `finishPlayback` 会被调用两次。
- `broadcastGroupState` 是死代码(`PlayerStatePayload` 是 client → server 方向)。
- FLAC 优先模式在本轮修复后**尚未**重跑完整真机流畅度验证(默认已是 PCM)。
