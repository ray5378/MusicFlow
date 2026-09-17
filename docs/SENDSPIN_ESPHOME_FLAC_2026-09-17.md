# Sendspin 专项修复记录 —— ESP32 真机出声(FLAC 推流实测)

> 日期:2026-09-17
> 目标:让 MusicFlow 内置 sendspin 服务在 ESPHome 真机 `esp32-player-meet`(192.168.10.245,esphome 2026.9.0 内置 sendspin client)上**真正出声**。
> 参照系(金标准):Music Assistant(mass 容器,host 网络,独占 8927)用 FLAC 推流可让该设备进 PLAYING 出声。
> 当前状态:**已进 PLAYING、协议链路完全打通,speaker mixer/ring buffer 已启动,但暂无确定的声音输出**(见「下一步排查方向」)。

---

## 一、背景与目标

MusicFlow 的 sendspin **内置服务**(非 market 插件,代码是 `backend/src/services/sendspin/*` 编译进镜像的 `dist/*.js`)是 Sendspin 协议的**服务端 + Noise initiator**。ESPHome 设备(endspin-cpp / aiosendspin 风格)作为客户端,经 mDNS 发现服务端后主动连入、legacy 明文直连或在握手后加密。

此前 MUSIC 一直无法让 `esp32-player-meet` 进 PLAYING 出声:音频协商选了 opus/PCM,设备拒收或始终停在非 PLAYING 状态。

金标准实证(MA 推流时的设备日志 `devstate.out`):

```
Group update - state: playing, id: 7d71c3fa-..., name: 3C:0F:02:F9:69:E4
Stream Started
Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit
speaker_mixer Starting / i2s_audio.speaker Starting / ring_buffer created
State changed to PLAYING
```

**结论:设备期望 FLAC 48000/2ch/16bit,且必须先进组(playing)再开 stream/start。**

---

## 二、已落地的源码改动(本次实测使用的版本)

运行时代码修改后需重新 `tsc` 编译并在容器内 `docker cp` 覆盖 `dist/*.js`。

### 1. 端口:8927 → 38927(避开 MA 独占的 8927)

- `backend/src/services/sendspin/constants.ts`: `WS_PORT = 38927`(监听 `ws://:38927/sendspin`)
- `backend/src/services/plugin/renderers/sendspin.ts`: `configSchema[port]` default/help、zh/en `documentation` 全部 8927→38927;“MA 的 8927”字样保留为说明
- `frontend/src/views/Groups/index.vue`: `sendspinPort` ref 8927→38927(dial 端口 8928 保留)
- `backend/src/services/sendspin/pluginConfig.test.ts`: 默认/非法回退断言 8927→38927(独立 legacy.test.ts 用 18927 保留)
- 注释/脚本/文档同步:server.ts、index.ts、advertise.ts、queueModes.test.ts、5 份 docs 等全部 8927→38927(设备侧 8928、测试 18927 保留)

> 端口运行时来源:`index.ts`(sendspin)读插件 `cfg.port`,无则回落 `WS_PORT`。**DB 里 `sendspin-renderer` 的 config 仅 `{"allow_legacy_clients":true}`,无 port 持久化** → 直接走新默认 38927,无需改 DB。

### 2. 音频协商:强制 FLAC(默认 flac,对齐 MA 金标准)

`backend/src/services/sendspin/server.ts` `negotiateCodec(payload)`:

```ts
// 只从 PCM/FLAC 里选,flac 优先、默认 flac(裸 opus 常被这类客户端拒收)。
if (!Array.isArray(list)) return "flac";
const have = new Set(list.map(f => String(f?.codec||"").toLowerCase()));
if (have.has("flac")) return "flac";
if (have.has("pcm")) return "pcm";
return "flac";
```

键名兼容 `player@v1_support`(9.x 别名)与 `player_support`(老版本)。
管线恒定 48kHz/立体声/16bit(`encoding.ts` SAMPLE_RATE/CHANNELS)。

### 3. 音频二进制帧头:9B → 13B(`>BqI`,对齐 aiosendspin 金标准)

`backend/src/services/sendspin/framing.ts`:

```ts
// 1B msg_type(0x04) + 8B 大端微秒时间戳 + 4B 大端 send_ahead(ms)
export const packAudioChunk = (timestampUs, data, sendAheadMs = 0) => {
  const head = Buffer.allocUnsafe(13);
  head[0] = 0x04;                      // BIN_PLAYER_AUDIO
  head.writeBigInt64BE(timestampUs, 1);
  head.writeUInt32BE(sendAheadMs, 9);  // send_ahead
  return new Uint8Array(Buffer.concat([head, Buffer.from(data)]));
};
```

`parseAudioChunk` 同步改为 `subarray(13)`,返回含 `sendAheadMs`。
> 此前 9B 头缺 send_ahead 4B,严格客户端按帧长/SEND 校验不符。

### 4. `sendAudio` 填充 send_ahead

`server.ts` `sendAudio(tsUs, codecData)`:

```ts
const ahead = this.group
  ? computeCommonSendAhead([...this.group.members].map(m => ({ latencyFuncMs: m.latencyFuncMs })))
  : 0;
const pkt = packAudioChunk(tsUs, codecData, ahead);
```

`computeCommonSendAhead`(已 import,`group.ts`)基于成员 `latencyFuncMs`(默认 30ms)算公共值。
send_ahead 单位推断为毫秒(与 stream/start、server/state 的 send_ahead 同源),实测中校正。

### 5. 推流帧空包跳过 + FLAC 空缓冲

`server.ts pushFrame`:`if (!data || data.length === 0) return;` —— ffmpeg flac 在 EOF 前常吐空缓冲,空包上 wire 会被严格客户端判 `Invalid data`。

---

## 三、部署方式(容器无代码卷挂载,代码打进镜像)

1. 本地 `cd backend && npm run build`(tsc → `dist/*.js`)
2. 挑 4 个改动文件:`dist/services/sendspin/{constants,server,framing}.js` + `dist/services/plugin/renderers/sendspin.js`
3. scp 到宿主(192.168.10.240),解压到 `/root/mf_distpatch/...`(保持相对路径)
4. `docker cp <补丁文件> $CID:/app/backend/dist/<同路径>` 逐文件覆盖(容器实例基于镜像,代码在容器盘;docker cp 对停止/运行容器均有效)
5. `docker start musicflow`

> 注意:容器启动脚本是 `entrypoint.sh → su-exec musicflow node dist/index.js`,**跑的是编译后 dist**,src 不会实时生效。sendspin 不是市场插件(preloaded-plugins 里只有 go-music-dl)。

---

## 四、已验证结果(本次实测,设备日志 devstate.out)

设备已成功连到 MusicFlow Sendspin,并走完 FLAC 播放链路:

```
Connected to server MusicFlow Sendspin with id Ru0wsx9... (reason: discovery)
Group update - state: playing, id: 3C:0F:02:F9:69:E4
Stream Started
Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit
speaker_source_media_player State changed to PLAYING
speaker_mixer Starting / i2s_audio.session Starting / ring_buffer created (96000)
State changed to PLAYING
```

- MusicFlow 视角:设备持续 `PLAYING`,pos 连续推进(`pos=26.3→31.2→…`),一曲结束后 `playCurrent idx=280` 自动续播下一首(pos 归 0 dur=263 再推进)。
- 说明:**协议层、组状态、stream 生命周期、FLAC codec_header 全部被设备接受** —— 相比改动前只停在 init/idle 已是根本性突破。
- 设备日志中曾出现一次 `sendspin.player: Failed to send audio chunk`(见风险点)。

---

## 五、仍未正确出声 —— 下一步排查方向

尽管已进 PLAYING、speaker 链路启动,**常规听感无声音输出**,最可能原因按优先级:

### A.(最高怀疑)FLAC 实时编码只出不完整 / ffmpeg flac EOF 前零输出

`encoding.ts` `FfmpegPcmEncoder` 用**单一持续 ffmpeg flac 子进程**,文档注释已自证:

> ffmpeg 的 pipe:1 输出只在输入 EOF(flush)时整块吐出——用 `-flush_packets` 亦无法强制其逐帧提前写出;实测 pcm/opus/flac 在 stdin 结束前均零输出。

当前 `encode()` 带 60ms 有界兜底 `ENCODE_FLUSH_MS`,**每次可能返回空包**;真正的完整编码字节只在 `flush()`(曲终/组关闭)一次性吐出。设备在流播放的过程中收不到完整可解码的 FLAC 帧 → 只有 PLAYING 状态、ring buffer 空转 → 无声。

**排查/解决候选:**
1. 抓 8927/38927 的音频帧字节是否确实到达设备(之前抓包只有 127.0.0.1 MA 回环,没抓到设备流量;需在设备发声时抓设备侧连接,非 MA 内部无音频流量)。
2. 将 `FfmpegPcmEncoder` 的 flac 改成**分段 FLAC**:每 N 秒(如 1~2s)启动一个 ffmpeg flac(带 fLaC 头+STREAMINFO),输入 EOF 即 flush 出这一段完整 FLAC,再发下一段;或改用能流式输出的编码库(见 D)。
3. 或先直接验证:对一段已知音频跑一次完整 `flush()`(非流式),若设备能出声则证明帧头/协商没问题,问题锁定在流式编码。

### B. `send_ahead` 单位/取值错误

目前按毫秒填(默认 30ms)。若设备端把 send_ahead 当微秒/其他粒度,或对超前量目视/丢弃,会静音或卡顿。**金标准抓包(MA→设备,端口 8927)里应有 send_ahead 的真实值**,逐一比对确认单位。

### C. 设备 `sendspin.player: Failed to send audio chunk`

出现过一次,方向是设备向服务端回音(连回公网双通道),可能不影响下行播放,但需确认不是协商到了设备不支持的期望(如期望 server 端 ICMP/上行端口)。低优先级。

### D. 换 FLAC 编码实现(若 ffmpeg 分段仍不干净)

- sendspin 官方/MA 用 `libFLAC` 逐帧输出;若容器无该能力,可调研是否可用纯 JS 或 child 分段 FFmpeg 且不破坏 FLAC 连续性(每段独立 STREAMINFO,接收端 sendspin client 对多段是否逐段重置)。
- 备选:退而求其次改回 **PCM(s16le)** 验证设备是否出声——若 PCM 出声则 FLAC 非硬性,只是 MA 恰好用 FLAC。但 2026-09-17 实测 pcm 未进 PLAYING,故 FLAC 是更优先方向。

---

## 六、风险点与注意事项

1. **ffmpeg flac 流式输出缺失**(见五·A)是最大风险,是“无声”最可能根因。此风险在会话中已被预判(`FfmpegPcmEncoder` 结构 `f32→持续 ffmpeg→60ms 兜底`),需改造后重测。
2. **容器部署无代码卷挂载**:每次改代码要 `tsc` + `docker cp` 覆盖,易漏文件/路径。建议记录当前部署的 dist 文件集,或日后改回代码卷映射以便热更。
3. **端口 38927 与 MA 8927 共存**:设备同一时刻连到哪个 sendspin server 由 mDNS/`last played server` 决定;设备日志出现 `Persisted last played server hash`,若反复横跳需确认 MA 是否仍在广播。
4. **DB 持久化**:sendspin-renderer 的 `port` 若未来被写入 plugins.config,会覆盖新默认;当前未持久化 port,仅 `allow_legacy_clients`。
5. **版本同步**:改完代码记得 `backend/package.json` + `CHANGELOG.md` 升版并打 tag,镜像 CI 才产新版本;文档(PLUGIN_DEV/ARCHITECTURE/README)同步。
6. **测试无法本地跑**:本机 node_modules/better-sqlite3 原生模块 `NODE_MODULE_VERSION` 127 ≠ 本机 Node 137,预先存在的环境问题,未擅自 npm rebuild;本次未在本地跑测试。
7. **real test 与模拟器差异**:本地脚本(sendspin-sim-*.py/mjs)为协议自洽而设计,可能未模拟 ESPHome 的严格校验(帧长/FLAC 段/编解码),真机验证仍以上述设备日志为准。

---

## 七、环境速查

- 宿主:192.168.10.240,`ssh -i E:\SSH私钥\mykey\mykey -p 35320 root@192.168.10.240`
- 容器:`docker ps -aq --filter name=musicflow`(镜像 `ray5378/musicflow:latest`;启动 `entrypoint.sh→ node dist/index.js`)
- 数据卷:`/vol1/1000/SSD/docker/musicflow/data`(含 `musicflow.db`、`sendspin/{identity.key,dial_targets.json,pairing_store.json}`)
- 设备:192.168.10.245,`esp32-player-meet`(3C:0F:02:F9:69:E4),esphome 2026.9.0,设备 ws `ws://192.168.10.245:8928/sendspin`(dial 端口)
- 设备日志采集:240 上 `bash /root/devstate_run.sh`(aioesphomeapi 订阅 media_player 状态+verbose,写 `/root/devstate.out`)
- MA 金标准:mass 容器 host 网络,独占 8927/web 8095,账号 xyz5378(见 MA web)——只做金标准,不改其配置