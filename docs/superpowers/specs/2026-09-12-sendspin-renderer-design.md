# Sendspin 渲染器插件设计（完整版）

日期：2026-09-12
状态：设计待复核
范围：**P1+P2+P3 全部一次规划**——完整对齐 Music Assistant 的 Sendspin Server（全角色 / 三配对法 / 多房同步 / 每客户端独立编码 / 每播放器 DSP 音量）。
关联：`docs/superpowers/plans/2026-08-05-dlna-ma-style-player-controller.md`（MA 式 player 控制器的既有基准）。

## 1. 背景与目标

Sendspin Audio Protocol（Open Home Foundation / Music Assistant 原生协议）是基于 WebSocket 的多房
同步音频协议。本插件让 MusicFlow 扮演**完整对齐 MA 的 Sendspin Server**（`ws://:8927` + mDNS），
让 Xbox、Android App、硬件音箱等 Sendspin 客户端直接发现并点播 MusicFlow 曲库，并回报播放/音量/进度。

蓝本：Music Assistant `providers/sendspin`（内部 `aiosendspin` 服务端库）+ MA Core 的 Player/Queue/Group 层。
协议规范：`/tmp/sendspin-spec`（clone 自 Sendspin/spec）；MA 实现：`/tmp/ma-server/music_assistant/providers/sendspin/`。

## 2. 形态与边界（含依据）

**形态**：仿 **AirPlay** 插件的"平行子系统 + 薄 renderer 适配器"结构——`services/sendspin/` 自含服务端
（协议+流引擎+组/时钟+配对），`services/plugin/renderers/sendspin.ts` 是把它暴露成 `renderer` 能力的薄壳。
**理由**：AirPlay 已是"服务端推送"模型并跑自有服务器；Sendspin 同样服务端推送，结构对齐最省且已被验证。

| 模块 | 分类 | 依据 / 落点 |
|---|---|---|
| 队列 / 播放状态机 / 自动切歌 | **复用** | `services/player/QueueController.ts`、`PlayerController.ts`、`UniversalPlayer.ts`、`PlaybackTracker.ts`。与 DLNA/AirPlay/Group 同一套（见 `registerAirPlayDevices`、`createAirPlayProtocolPlayer` 的用法） |
| ProtocolPlayer 契约 | **复用** | `services/player/types.ts` 的 `ProtocolPlayer` 接口，sendspin 提供 `services/sendspin/protocolPlayer.ts` 的 `createSendspinProtocolPlayer(clientId|groupId)` 实现它（对照 `airplay/protocolPlayer.ts`） |
| 帧/流 URL 生成 | **复用（基础）** | `dlna/control.ts#createCastSession`（token 流地址）可作报给上游的 mediaUri 占位；sendspin 真正走内部推流 |
| WebSocket 服务端原语 | **复用** | `ws` v8 依赖；Sendspin WS 监听 8927 为独立 TCP 监听器，不挂主 HTTP 服务 |
| mDNS | **复用** | `services/discovery/mdns.ts`（bonjour-service）：通报 `_sendspin-server._tcp.local.`(8927) 供客户端发起；监听 `_sendspin._tcp`(8928) 供服务端发起 |
| 曲库 / 封面 / 元数据 | **复用** | `db`、artwork 端点（metadata/artwork 角色需拉取） |
| 加密原语 / 身份 | **复用(Node crypto)** | X25519/HKDF/ChaChaPoly/AES-GCM/SHA-256/base64url，Node `crypto` 直接可做 |
| 解码→PCM | **新增管线** | 现有 `transcode.ts#decideTranscode/spawnTranscoder` 仅 mp3/aac。sendspin 需 ffmpeg 解码 → PCM(F32/48k) + opus/flac 编码之独立管线（可复刻 `airplay/control.ts` 的 ffmpeg→RAW 编码推流写法） |
| Sendspin 服务端/协议层 | **新增** | `services/sendspin/*`：握手(Noise_KKpsk2)、角色层、消息路由、时钟、组同步、配对 |
| 多房样本级同步 | **新增** | **不**用通用 `services/group/protocolPlayer.ts` 的扇出（它只触发各成员各自拉流，非样本对齐）。sendspin 组由流引擎"一次性解码→逐客户端编码→同一时间线推送"实现同步 |
| 外置沙箱插件承载协议 | **不可行** | 沙箱插件无 Node 能力，不能绑 TCP/WS 监听、不能 Node crypto、不能跑 Sound 引擎；故 renderer 必须是内置插件（同 DLNA/AirPlay） |

## 3. 架构组件（services/sendspin/ 文件树）

```
backend/src/services/sendspin/
├── index.ts             # 装配/生命周期:启动 WS+mdns+配对存储;stop 关闭全部
├── server.ts            # SendspinServer:bind 8927、连接生命周期、明文期流程、re-handshake
├── identity.ts          # 静态身份密钥(crypto randomBytes) 持久化/加载(数据目录 0600)
├── handshake.ts         # Noise_KKpsk2 initiator 双 suite;Sentinel;配对后 re-handshake
├── framing.ts           # 加密后帧封装;分片(type1);二进制/JSON 编解码
├── messages.ts          # type0 JSON 收发 + 事件派发(全角色)
├── roles/
│   ├── registry.ts      # <role>@v1 注册表、按客户端激活、bin id 区间映射
│   ├── player.ts        # format 协商、流声明、音量/静音/输出延迟、state 收敛态
│   ├── source.ts        # 音频上行(type12-15)
│   ├── controller.ts    # 命令→ 映射到 QueueController 的 play/pause/seek/volume/switch
│   ├── metadata.ts / artwork.ts / visualizer.ts / color.ts  # 下行展示
├── clock.ts             # server 时间戳服务;client/time→server/time 应答
├── group.ts             # 组模型、成员、公共 send-ahead、组音量/mute 算法
├── stream.ts            # 流引擎:ffmpeg→PCM→逐客户端编码→按组公共时钟分块推
├── encoding.ts          # opus/flac/pcm 编码器包装(ffmpeg 主;可选 @discordjs/opus)
├── pairing.ts           # 三配对法 + PSK store + unpaired_access + SP: token 编解码
└── protocolPlayer.ts    # createSendspinProtocolPlayer(clientId|groupId): ProtocolPlayer —— 对接复用层
```

依赖新增：`noise-js` 或 `@noble/curves`+`@noble/hashes`（握手）；`ffmpeg-static`（流/编解码）；
`@discordjs/opus`（可选）。base32/base64url 自写或 Node。

## 4. 连接与握手数据流

```
WS text 明文期:
  C→S client/init {client_id, version:1, suite}
  S→C server/init {server_id, version:1}
  S→C noise/handshake {data: b64url(msg1)}        # Server 恒为 initiator
  C→S noise/handshake {data: b64url(msg2)}
   → prologue = 线上 client/init 原文 ‖ server/init 原文(不含WS帧)
切换到 Noise transport; WS binary 帧 = Noise AEAD 密文
  S→C server/hello {name}
  C→S client/hello {name, device_info?, supported_roles, @v1_support, pair_methods, unpaired_access}
  S→C server/activate {activities:[playback|pairing], active_roles?, pairing?}
  → 此后发业务数据
```

加密后明文首字节 = `type`：0=JSON、1=分片、4=player 音频块 `[4][ts_i64_be][send_ahead_u32_be][data]`。
大负载 >65518 字节走 type1 分片。seek/跳曲只发 `stream/clear`（绝不 `stream/end`）；track 切换只
`stream/start` 更新（gapless）；真正结束才 `stream/end`。

## 5. 音频与编码

- 会话统一解码为 PCM F32 / 48kHz（仿 MA `_select_session_pcm_formats`：leader 偏好、lossy 上限 48k）。
- 逐客户端按 `client/hello.player.supported_formats` + `client/state.player.format`（可动态改）选
  opus/flac/pcm。opus=单 RFC6716 包；flac 出 `codec_header`(fLaC+STREAMINFO)；pcm 小端有符号 24bit=3 字节。
- 流时序参与量：`required_lead_time_ms`（启动导时）、`min_buffer_ms`、`output_delay_ms`(0-5000，持久化)、
  `buffer_capacity`(字节上限)。组内以公共 send-ahead 调度（=各 player 最大值，成员变化重算）。

## 6. 时钟同步

- 周期 `client/time` → `server/time{client_transmitted, server_received, server_transmitted}`。
- 2D Kalman(offset+drift) 在客户端计算；服务端只提供时间戳并测到达/发送时刻。
- 收敛前客户端不报 `available:true`。稳态 ±0.5~±1ms；漂移修正节制（dead band ~100µs，整帧删/插）。

## 7. 组与队列（对接复用层）

- **队列/切歌/状态**走复用层：`services/sendspin/protocolPlayer.ts` 把每个客户端(或客户端组)实现为
  `ProtocolPlayer` 挂进 `UniversalPlayer`；`PlayerController` 把 `pollState()` 映射为
  `PLAYING_PAUSED/IDLE`；流引擎报告自然结束(对照 `airplay/control.ts` 的 IDLE 上报)→ `QueueController` 自动切歌。
- 新增 `services/player/QueueController.ts#registerSendspinPlayer(clientId|groupId)`（对照 `registerAirPlayDevices`）。
- **组同步**：sendspin 组 = 流引擎一次解码、逐客户端编码、同一时间线推送（样本对齐），作为一个
  ProtocolPlayer 暴露；**不复用**通用 group 扇出做音频同步（其非样本对齐）。
- 组音量：`delta=请求−组均音量`，逐 player 加后 clamp 0-100，被 clamp 丢弃部分等分给未 clamp 者迭代；
  mute=全成员支持才 true；组音量=成员均值。`switch`/`client/leave` → solo + `available:false`。

## 8. 配对（三法全量）

1. **Pairing PSK**：token `SP:0` + base32(client_key(32B)‖paring_psk(32B)，`2`↔`9` 转写)，直配无 PAKE。
2. **Dynamic Code**：Sentinel 连 + CPACE-X25519-SHA512 PAKE；6 位数字/QR（QR=前 24B digest）；
   PSK 以 `wrapped_psk` 在 CPace 输出下 seal；20 轮后 hold。
3. **Static Code**：固定 8 位码 + PAKE；配对窗口（手势打开，建议 5min，5 次失败关闭）。
- 配对后带内 re-handshake 升长期 PSK；`unpaired_access` 需操作员按 client_id 显式批准
  （复刻 MA `set_trusted_unpaired` 同意流）。服务端静态身份持久化于数据目录（0600）。

## 9. source / visualizer / color（全角色）

- **source**：接收客户端上行音频(type12-15)，可转发给其它角色/桥接（本地输入 Aux/唱机/蓝牙等）。
- **visualizer**：从流中提取 `loudness/beat/f_peak/spectrum/peak` 特征下行（复刻 MA
  `SynchronizerRole`/`VisualizerFeatureExtractor` 思路，可用音频分析或轻量 DSP）。
- **color**：从音频衍生颜色下行。二者在 P3 一并落地。

## 10. 错误处理与测试

- **错误**：`server/error{reason}`(unsupported_version/suite/malformed) 后关连；其余静默关闭；
  重放计数器错乱→AEAD 失败→断连；配对 20 轮/静态码 5 次锁定窗口。
- **单元测试**：帧/分片编解码、组音量算法、base32/PSK 派生、时间戳格式化（用 spec 与 aiosendspin 向量）。
- **握手兼容矩阵**：以 aiosendspin（Python）为互操作对端跑双 suite 握手；含分片、re-handshake。
- **集成**：与 `Sendspin/spec` 参考客户端 / 真实 Xbox / Android App 端到端播放、seek、音量、多房。

## 11. 落地清单（全量，里程碑不拆交付）

1. 服务骨架：`index/server/identity`，bind 8927 + mdns；明文期 + Noise 握手（双 suite + Sentinel）。
2. 角色/消息/路由层：`roles/* + messages + framing`；player+controller 先通，其余随后。
3. 流引擎 + 编码：`stream + encoding`（ffmpeg→PCM→opus/flac/pcm），时间戳块 + 组公共 send-ahead。
4. 对接复用层：`protocolPlayer` + `QueueController#registerSendspinPlayer`；自动切歌闭环。
5. 体验面：`stream/clear`(seek/跳曲)、metadata/artwork、时钟 Kalman ±1ms、音量/静音持久化。
6. 多房：`group`（公共时钟推送、组音量/mute、switch/leave）。
7. 配对三法 + `unpaired_access` + re-handshake；服务端发起连接(`_sendspin._tcp`)。
8. source/visualizer/color +（可选）WebRTC 桥。

## 12. 风险

- Noise KKpsk2 无现成 TS 封装，token/DH/分片/re-handshake 最易错 → 以 aiosendspin 为蓝本做字节级单测。
- 时钟 ±1ms 与编码矩阵（opus/flac/pcm × 采样率）需真实客户端验证。
- 多房样本级同步与本项目现有 group 扇出不同，需独立实现并对真机校准。