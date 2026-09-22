# ESPHome Sendspin 真机联调手册(抓日志 + 抓包 + 速查)

> 实战沉淀(2026-09-17,ESP32-S3 `esp32-player-meet` `192.168.10.245` × MusicFlow sendspin server)。
> **2026-09-22 复测修正**:于 `esp32-player2` `192.168.10.246`(ESPHome 2026.9.0,客户端 `C4:9E:7E:08:75:64`)
> 逐行比对出声基准,修正了「已知的坑位」第 4 条(「FLAC 是唯一能出声的 codec」已不成立)、
> 第 10 条(连接方向那条过于绝对)、以及 §4.1(「三件套只在首次打印」对 end→start 切歌不成立)。
> 模拟器(aioesendspin)是 lenient 实现,真机(sendspin-cpp)是 strict 实现:
> 模拟器上全通不代表真机能通,反之亦然。出问题先看设备端日志,再看线。

## 1. 看设备日志(三种方法)

### 方法一:原生 API 订阅日志(推荐,可脚本化)

设备 `api:` 开了加密时,用 ESPHome Native API(6053 端口)+ Noise PSK 订阅:

```bash
pip install --break-system-packages aioesphomeapi
```

```python
import asyncio, re
from aioesphomeapi import APIClient
from aioesphomeapi.model import LogLevel

ANSI = re.compile(rb'\x1b\[[0-9;]*m')

async def main():
    api = APIClient("192.168.10.245", 6053, None,
                    noise_psk="<yaml 里 api.encryption.key 的值>")
    await api.connect(login=True)
    def on_log(entry):
        msg = entry.message if isinstance(entry.message, bytes) else entry.message.encode()
        print(ANSI.sub(b'', msg).decode('utf8', 'replace'), flush=True)
    # dump_config=True 是钥匙:不带它经常一条日志都收不到;
    # log_level=DEBUG 才能看到 sendspin [D] 行;message 可能是 bytes,先脱 ANSI 色。
    # log_level=VERBOSE 能看到 sendspin.client 更细的行(如 `Failed to send audio chunk`)。
    api.subscribe_logs(on_log, log_level=LogLevel.LOG_LEVEL_DEBUG, dump_config=True)
    await asyncio.sleep(60)
    # ⚠️ dump_config=True 时**每次订阅都会先整段 dump 设备配置**(实测约 80 行:logger/psram/
    #    speaker_mixer/resampler/i2s_audio/wifi/api/sendspin.hub…),真正的运行段日志**在其后**。
    #    实测抓 34s 只够看到配置段,一条运行段都没有 —— 抓取窗口留 ≥50s,或干脆先把配置段滤掉。

asyncio.run(main())
```

同接口还能查实体状态(播放器是否真在播,比日志更准):

```python
ents = await api.list_entities_services()  # 找 MediaPlayerInfo(object_id=speaker_media_player)
api.subscribe_states(lambda s: print(s.key, getattr(s, 'state', None)))
# state: 0=NONE,1=IDLE,2=PLAYING,3=PAUSED
```

### 方法二:ESPHome Dashboard → 设备 → LOGS(无线)

最省事,适合人眼盯。注意窗口期:拨号后 30~50 秒、播放起止前后是关键段。

### 方法三:设备 Web 页面 `http://<ip>/events`(SSE,慎用)

实测只下发 `ping`(但 ping 里 `"log":true` 表示服务端支持),`log` 事件没下来。
结论:该通道目前看不到日志,别在这上面烧时间。用方法一/二。

## 2. 抓包(服务端侧)

```bash
tcpdump -i any -U -w esphome.pcap "host 192.168.10.245"
```

关键消息速查(全是明文 JSON,TEXT 帧;`client/hello` 先行即 legacy 明文模式):

| 方向 | 消息 | 要看的点 |
|---|---|---|
| C→S | `client/hello` | `supported_formats` 顺序(flac/opus/pcm)、`supported_roles` |
| S→C | `server/hello` | **五字段必须齐**:`server_id/name/version/active_roles/connection_reason`;`connection_reason` 只能是 `discovery`/`playback`(见 sendspin-cpp `connection_reason_from_string`),其他值整条 hello 作废 |
| S→C | `server/activate` | `{activities:["playback"],active_roles}`;真机这一版直接 `Unhandled`(忽略),不指望它推进状态 |
| S→C | `group/update` | `{playback_state,group_id,group_name}`;spec 要求首次 activate 后立即发 |
| S→C | `stream/start` | `{player:{codec,sample_rate,channels,bit_depth,codec_header?}}`;**FLAC 必须带 `codec_header`(STREAMINFO 的 base64),否则整条作废+之后每块音频全灭**;**PCM 路径不带 `codec_header`**(2026-09-22 实测 payload 只有 4 字段:`{"codec":"pcm","sample_rate":48000,"channels":2,"bit_depth":16}`) |
| S→C | 音频帧 | 二进制;opus 约 20ms/包,flac 看 ffmpeg 脸色(见§4);**pcm 恒 25ms/帧**(2026-09-22 实测帧长固定 = 9B 头 + 4800B 载荷,即 48kHz×2ch×16bit×25ms) |
| S→C | `stream/end` | 曲终/停止必须发,否则设备永远卡 PLAYING |
| C→S | `client/goodbye` | `reason` 语义:`another_server`=切到别的 server(**服务端 SHOULD NOT 自动重拨**);`restart` 才可重拨 |
| C→S | `client/time`/`client/state` | 心跳与状态(`state:synchronized` + 音量/静音表示会话健康参与中) |

30 秒红线:连接进 nursery(`Admitting new connection into the nursery`)后,
握手 30 秒内完不成(`HELLO_SENT` 卡住)即被 drop:
`Nursery connection stalled at HELLO_SENT (>30 s), dropping`。
此前每次"准时 30 秒离开"都是这个原因,不是对端有另一个 server。

## 3. mDNS 速查

| 主体 | 服务类型 | 端口 | 说明 |
|---|---|---|---|
| 设备(播放器) | `_sendspin._tcp` | 8928(txt `path=/sendspin`) | 服务端发现设备→主动拨号 |
| 服务端 | `_sendspin-server._tcp` | 38927(txt `path=/sendspin`) | 设备发现服务端→自己拨号 |

node 单行浏览(仓库自带 `bonjour-service`):

```js
import { Bonjour } from "/workspace/MusicFlow/backend/node_modules/bonjour-service/dist/index.js";
new Bonjour().find({ type: "sendspin-server" },
  (s) => console.log("FOUND:", s.name, s.host, s.port, JSON.stringify(s.txt)));
setTimeout(() => process.exit(0), 10000);
```

## 4. 已知的坑位(别再踩)

1. **server/hello 五字段**:缺一或枚举非法 → 整条作废 → 30s 被踢。不要加 spec 之外的字段。
2. **legacy 无 activate 推进**:真机直接 `Unhandled server message type: server/activate`,
   靠 hello 完成握手;`group/update` 照常处理。
   ⚠️ **不要在 `dialPlayerInner` 里等设备回 `server/activate` 才认为激活成功** —— 真机永不回,
   会 15s activation timeout 后自杀连接,表现为「每 5~6 分钟重拨一次」的假重连循环
   (2026-09-17 实锤:设备侧 `Connection closed callback` 与我们 timeout 时刻精确对齐)。
3. **FLAC 要 codec_header**:base64(`fLaC`+0x80+u24(34)+34B STREAMINFO)。
   后端 `flacCodecHeaderB64()` 定值合成。
   ⚠️ **STREAMINFO 的 min/max block size 必须 = 4096**(实测 ffmpeg 48kHz 输出值),
   写 4608 会让严格解码器逐帧拒收:设备建好 19200 解码环形区后**永不启动 speaker**
   (`speaker_mixer`/`i2s_audio.speaker` 一直不 `Starting`,也没有 96000 的 speaker_task ring buffer)
   —— 链路全绿但无声,这是 2026-09-17 前长期「无声音」的真根因。断言见 `encoding.test.ts`。
   > 本条**仅适用 FLAC 路径**。PCM 路径既没有 `codec_header` 也没有 STREAMINFO 可约束
   > (`decode_audio_chunk()` 只是一条 `std::memcpy`),因此不存在这个坑。
4. **PCM 是默认首选,FLAC 同样能出声**(2026-09-22 复测修正;原文「FLAC 是唯一能出声的 codec」已不成立)。
   协商顺序由插件配置 `preferred_codec` 决定 —— `server.ts` `negotiateCodec()` 里
   `order = preferred === "flac" ? ["flac","pcm"] : ["pcm","flac"]`,而 `preferred` **缺省 `pcm`**
   (`index.ts` `preferredCodec`;`normalizeCodecPreference()` 把非法/缺失值一律回落 `pcm`)。
   只有客户端**两种都没声明**时才落到 `flac`(带 codec_header,严格客户端唯一稳妥解)。
   - 实测 2026-09-22(`esp32-player2` `C4:9E:7E:08:75:64`,ESPHome 2026.9.0):`codec=pcm` 下
     `Processed new codec header: pcm, 48000 Hz, 2 ch, 16-bit`,**出声三件套齐全、零报错**。
   - 选 PCM 的理由(ESP32 端压倒性优势):FLAC 每 85ms 解一个 4096 样本帧、服务端 libFLAC 也要攒满 4096
     才吐,25ms 喂料 / 85ms 吐块天然错位,时间线极易失步;PCM 走 `CHUNK_TYPE_PCM_DUMMY_HEADER` +
     `decode_dummy_header`,`decode_audio_chunk()` 只是一条 `std::memcpy`。代价只有带宽
     (48k/2ch/16bit = 1.536 Mbps),局域网内完全可接受。
   - opus 被这类客户端拒收(9.x 明说 "only PCM and FLAC are supported"),永远不要协商到 opus。
   - 键名兼容 `player@v1_support`(9.x 别名)与 `player_support`(老版)。
   - **FLAC 路径补充**:⚠️ **ffmpeg flac 管道输出只在 EOF flush,逐帧 encode 全是空包** —— 所以不能指望「单条持续 ffmpeg 流」实时出声,
   必须改**分段 FLAC**(每段独立 `fLaC`+STREAMINFO,输入 EOF 即 flush 整段)。MA 金标准也是每 ~10s 一段 stream。
   当前 `pushFrame` 已过滤空包(空包上 wire 会被严格客户端判 Invalid data)。
   > 📌 被本条修正作废的原文**逐字保留**在文末 §4.3(以免以后重走弯路)。
5. **曲终必须 `stream/end` + `group/update(stopped)`**,否则设备卡 PLAYING。
6. **并发拨号必死**:同一目标单飞(`pendingDials`),否则设备仲裁踢掉一个。
7. **`another_server` 不自动重拨**(spec),手动 dial 清除抑制;`restart` 才重拨。
8. **先有音频再谈记住**:设备 `Persisted last played server` 只认真正播过的 server;
   靠"连上"混不成记住,不配对就用播放把它拿下。
9. **冷起播必须走 `playMedia`,不能只 `pump.resume()`**:`POST /peers/:id/play` →
   `QueueController.transport(play)` → `player.resume()`。sendspin 的 `resume()` 若只调
   `pumpFor(...).resume()`,在「队列 isActive=true 但从未起播」时是**空操作**
   (`resumePlayback()` 见 `q.isActive` 直接早退)→ 无 playMedia/无 stream/start/无 pump = 静默。
   对照 DLNA:它的 `resume() = playDevice()`(重发 SetAVTransportURI)= 真起播,所以 DLNA 不暴露此缺口。
   修法:`protocolPlayer.resume()` 判 `pump.active` —— 在跑就原地 resume,没跑就走 `playMedia` 冷起播
   (需 `QueueController.resolveItem` 公开,补全 songId-only 的 item 元数据)。
10. **失效的 dial 目标要删干净**:`MUSICFLOW_DATA_DIR/sendspin/dial_targets.json` 存的是服务端
   **主动补拨**的设备地址(每 60s 一轮,`dialRemembered()`;连接上还活着就跳过,同一目标单飞)。
   设 DHCP 后旧地址残留会让服务端每 60s 无脑重拨、线上刷 `EHOSTUNREACH`(2026-09-21 真机:
   .245→.246 后实测 44 次),而且**每次失败都要等一整个 connect 超时,把同轮里真正在线的那台也拖慢**。
   现已由 `isStaleAddressError()` + `STALE_DIAL_FAILS` 连续判据自动淘汰(只从 dial_targets 移除,
   非破坏性;设备换 IP 后 `discover.ts` 经 mDNS 重新发现并记住新地址)。
   > ⚠️ **原文末句「正常方向是设备拨入 38927,不是服务端拨设备」已作废**(与 §3 表格自相矛盾)。
   > 两条路径都是 spec 允许且实测可用:①设备经 mDNS 发现服务端后拨入 `38927`(Client-Initiated);
   > ②服务端经 mDNS 发现设备后主动拨 `8928`(Server-Initiated,`server.ts` `dialPlayer()`)。
   > 2026-09-22 实测走的就是 ②:`240:43372 → 246:8928` 主动拨号,**设备正常出声**。
   > 真正会被设备踢的是**同一目标的并发拨号**(见上文第 6 条 `pendingDials` 单飞)。
   > 📌 被本条修正作废的原文**逐字保留**在文末 §4.3(以免以后重走弯路)。

### 4.1 正确出声的完整设备侧序列(基准比对)

**A. 首次起播(2026-09-17,`esp32-player-meet` `3C:0F:02:F9:69:E4`)**

```
Group update - state: playing, id: 3C:0F:02:F9:69:E4
Stream Started
Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit   ← codec 名随协商变化,见本章第 4 条
sendspin_id: current
State changed to PLAYING
Created ring buffer with size 19200              ← 解码环形区
speaker_mixer:369 Starting                        ← 输出链路起来(关键标志)
i2s_audio.speaker:070 Starting                    ← I2S 输出起来(关键标志)
Created ring buffer with size 96000 [speaker_task] ← 输出环形区(关键标志)
```

**B. 切歌(完整 `stream/end` → `stream/start`;2026-09-22 实测,`esp32-player2` `C4:9E:7E:08:75:64`)**

服务端侧对应消息(pcap 实证):
```
stream/end {}
group/update {"playback_state":"stopped","group_id":"C4:9E:7E:08:75:64","group_name":"C4:9E:7E:08:75:64"}
group/update {"playback_state":"playing","group_id":"C4:9E:7E:08:75:64","group_name":"C4:9E:7E:08:75:64"}
stream/start {"player":{"codec":"pcm","sample_rate":48000,"channels":2,"bit_depth":16}}
```

设备侧:
```
Stream ended - player:1 artwork:1 visualizer:1
Persisted last played server hash: 0x8927DFCB                   ← 切歌时新增
Persisted last played server: Ru0wsx9_pCLBTdYHJP0bZb0FYcyLRfPRsRMk0stywUc (hash: 0x8927DFCB)
Group update - state: playing, id: C4:9E:7E:08:75:64, name: C4:9E:7E:08:75:64
State changed to IDLE
speaker_mixer:387 Stopped                                        ← 扬声器**会拆**
i2s_audio.speaker:095 Stopped                                    ← I2S 也 Stopped
Stream Started
Processed new codec header: pcm, 48000 Hz, 2 ch, 16-bit
sendspin_id: current
State changed to PLAYING
Created ring buffer with size 19200
speaker_mixer:369 Starting                                       ← 三件套**重新打印**
i2s_audio.speaker:070 Starting                                   ← 同上
Created ring buffer with size 96000 [speaker_task]               ← 同上
```
> ⚠️ **修正 2026-09-17 的旧结论**:原文称「`speaker_mixer Starting` / `i2s_audio.speaker Starting` /
> `96000 ring_buffer` **只在首次出现一次**,后续切歌不再打印」—— **对完整 `stream/end`→`stream/start`
> 的切歌不成立**。2026-09-22 实测:切歌会先 `speaker_mixer:387 Stopped` + `i2s_audio.speaker:095 Stopped`
> 拆掉输出链路,再在 `Stream Started` 后重新 `Starting`,**三件套每次重新起播都会打印**。
> 判「有没有掉链」不能只看三件套是否重复出现,要看 **`Stopped` 之后有没有迟迟不 `Starting`**,
> 以及实体状态是否回到 `PLAYING`。
> 📌 被本修正作废的原文**逐字保留**在文末 §4.3(以免以后重走弯路)。

### 4.2 出声基准逐行比对表(2026-09-17 vs 2026-09-22)

| # | 2026-09-17 基准逐行 | 2026-09-22 实测逐行 | 判定 |
|---|---|---|---|
| 1 | `Group update - state: playing, id: 3C:0F:02:F9:69:E4` | `Group update - state: playing, id: C4:9E:7E:08:75:64, name: C4:9E:7E:08:75:64` | ⚠️ 实测多 `name:` 字段(与 id 同值) |
| 2 | `Stream Started` | `Stream Started` | ✅ 一致 |
| 3 | `Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit` | `Processed new codec header: pcm, 48000 Hz, 2 ch, 16-bit` | ⚠️ **codec 名随协商结果变化**,不是基准必需品 |
| 4 | `sendspin_id: current` | `sendspin_id: current` | ✅ 一致 |
| 5 | `State changed to PLAYING` | `State changed to PLAYING` | ✅ 一致 |
| 6 | `Created ring buffer with size 19200` | `Created ring buffer with size 19200` | ✅ 一致 |
| 7 | `speaker_mixer:369 Starting` | `speaker_mixer:369 Starting` | ✅ 一致 |
| 8 | `i2s_audio.speaker:070 Starting` | `i2s_audio.speaker:070 Starting` | ✅ 一致 |
| 9 | `Created ring buffer with size 96000 [speaker_task]` | `Created ring buffer with size 96000 [speaker_task]` | ✅ 一致 |
| 10 | (基准未列) | `Persisted last played server hash` + `Persisted last played server: …` | ➕ 切歌时必现,建议纳入判据 |
| 11 | (基准未列) | `speaker_mixer:387 Stopped` + `i2s_audio.speaker:095 Stopped` | ➕ end→start 切歌必现(见 §4.1 B 段) |

**健康硬指标(2026-09-22 实测)**
- `Failed to send audio chunk` = **0 次**
- 实体 `speaker_media_player2` = `MediaPlayerState.PLAYING`
- 服务端 `[PlayerController][report] … PLAYING pos=<n> dur=<n>` 每 5s 精确 +5s(1:1 推进)
- 抓包(240→246)载荷零字节占比 **0.4%**(<1% 即非静音)

**故障态对照(同一份服务端产物、同一设备,仅设备重启前后之差)**
实体 `IDLE`;`Failed to send audio chunk` **2144 次**(≈40/s,正好 25ms 帧节拍);
`Stream Started` 后仅 151ms 就 `Stream ended` 死循环;三件套一条不出现。
⇒ 判为 **设备 sendspin 组件假死**,重启设备即恢复(2026-09-22 实锤),
**与服务端产物无关**(同产物重启前无声、重启后正常出声)。


---

### 4.3 2026-09-17 原文备查(已被 §4.1/§4.2/第 4 条/第 10 条 修正,逐字保留)

> **为什么要留着**:下面这些结论当年都是「真机实锤」,而且**每一条都对应过一段真实的排查弯路**。
> 将来若再遇到相似症状(没声音 / `another_server` 风暴 / 切歌掉链),先读这段 ——
> 当年的**错因本身**往往比现在的结论更能指路:它告诉你在什么条件下会被误导。
> 读的时候请连着上方修正一起看,**不要单独引用本节任何一句**。

#### 4.3.1 原文 · 第 4 条(「FLAC 是唯一能出声的 codec」)

```
4. **FLAC 是唯一能出声的 codec(2026-09-17 真机实锤)**:协商顺序 = **flac 优先 → pcm 次选 → 默认 flac**。
   opus 被这类客户端拒收(9.x 明说 "only PCM and FLAC are supported"),永远不要协商到 opus。
   代码见 `server.ts` `negotiateCodec()`;键名兼容 `player@v1_support`(9.x 别名)与 `player_support`(老版)。
```

> 保留价值:「退回 FLAC 需要哪些前置」的线索索引 —— 9B 帧头 / 时间线按实产推进 / 绝对时刻调度,
> 以及 FLAC 的 `codec_header` STREAMINFO block size 必须 = 4096(见第 3 条)。
> 若将来某固件在 PCM 上出问题,这条是「改回 FLAC 首选」时的检查清单起点。
> 事实错误在两处:①**「唯一能出声」不成立**(2026-09-22 `codec=pcm` 实测出声三件套齐全);
> ②**「默认 flac」不成立**(`preferred` 缺省 `pcm`,见上方修正)。

#### 4.3.2 原文 · 第 10 条(连接方向)

```
10. **不存在的 dial 目标要删干净**:`MUSICFLOW_DATA_DIR/sendspin/dial_targets.json` 里若留着
   设备自身端口(如 `192.168.10.245:8928`),服务端每 60s 拨过去会被设备判为「竞争第二个 server」
   而 `goodbye: another_server` 踢回,并触发 `noAutoRedial` 永久抑制。
   正常方向是**设备经 mDNS 发现服务端后自己拨入 38927**(Client-Initiated),不是服务端拨设备。
```

> 保留价值:前半段「服务端 60s 补拨旧地址 → 被踢 + `noAutoRedial` 永久抑制」仍是真实风险面。
> 排 `another_server` 风暴时先看这条,再去核 `dial_targets.json` 与 `srv.noAutoRedial`。
> 事实错误在末句:把 server-initiated 拨 `8928` 说成非正常路径 —— 它与 §3 表格自相矛盾,
> 且 2026-09-22 实测正是走这条路正常出声。

#### 4.3.3 原文 · §4.1 切歌段(「扬声器不拆」)

原小节标题:`### 4.1 正确出声的完整设备侧序列(2026-09-17 验证,可作基准比对)`

原引导句:`切歌时(扬声器**不拆**):`

```
Stream ended - player:1 artwork:1 visualizer:1
Group update - state: playing
State changed to IDLE
Stream Started
Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit
sendspin_id: current
State changed to PLAYING
Created ring buffer with size 19200
```

```
> `speaker_mixer Starting` / `i2s_audio.speaker Starting` / `96000 ring_buffer` **只在首次出现一次**,
> 后续切歌不再打印 —— 这是正常的,不代表掉链。判「有没有掉」看有没有 `stopped`。
```

> 保留价值:它描述了**扬声器不拆**的那种切歌。若哪天观测到切歌时**确实没有** `Stopped`/`Starting` 对,
> 说明走的是另一条路径(例如服务端在同一 stream 内换源、不发 `stream/end`),
> **别当成异常去查**。反之若看到 `Stopped` 后迟迟不 `Starting`,才是真的掉链。
> 事实错误在结论:对完整 `stream/end`→`stream/start` 的切歌,三件套**每次重新起播都会打印**
> (2026-09-22 实测,见 §4.1 B 段)。
