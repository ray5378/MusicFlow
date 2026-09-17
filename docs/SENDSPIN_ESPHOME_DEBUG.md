# ESPHome Sendspin 真机联调手册(抓日志 + 抓包 + 速查)

> 实战沉淀(2026-09-17,ESP32-S3 `esp32-player-meet` × MusicFlow sendspin server)。
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
    api.subscribe_logs(on_log, log_level=LogLevel.LOG_LEVEL_DEBUG, dump_config=True)
    await asyncio.sleep(60)

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
| S→C | `stream/start` | `{player:{codec,sample_rate,channels,bit_depth,codec_header?}}`;**FLAC 必须带 `codec_header`(STREAMINFO 的 base64),否则整条作废+之后每块音频全灭** |
| S→C | 音频帧 | 二进制;opus 约 20ms/包,flac 看 ffmpeg 脸色(见§4) |
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
| 服务端 | `_sendspin-server._tcp` | 8927(txt `path=/sendspin`) | 设备发现服务端→自己拨号 |

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
3. **FLAC 要 codec_header**:base64(`fLaC`+0x80+u24(34)+34B STREAMINFO);
   后端 `flacCodecHeaderB64()` 定值合成(48k/立体声/16bit,块大小 4608 与 ffmpeg 实际一致)。
4. **FLAC 实时流已死**:ffmpeg flac 管道输出只在 EOF flush,逐帧 encode 全是空包。
   后端协商顺序已改为 opus > pcm > flac;空包不上 wire(`pushFrame` 过滤)。
5. **曲终必须 `stream/end` + `group/update(stopped)`**,否则设备卡 PLAYING。
6. **并发拨号必死**:同一目标单飞(`pendingDials`),否则设备仲裁踢掉一个。
7. **`another_server` 不自动重拨**(spec),手动 dial 清除抑制;`restart` 才重拨。
8. **先有音频再谈记住**:设备 `Persisted last played server` 只认真正播过的 server;
   靠"连上"混不成记住,不配对就用播放把它拿下。
