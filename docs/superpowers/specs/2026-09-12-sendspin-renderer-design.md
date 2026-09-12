# Sendspin 渲染器插件设计

日期：2026-09-12
状态：设计待复核
关联：`docs/superpowers/plans/2026-08-05-dlna-ma-style-player-controller.md`（MA 式 player 控制器的既有对齐基准）

## 1. 背景与目标

Sendspin Audio Protocol（Open Home Foundation / Music Assistant 原生协议）是基于 WebSocket 的
多房同步音频协议。音乐服务器可作为 **Sendspin Server**（`ws://:8927` + mDNS），让 Xbox、Android App、
硬件音箱等 **Sendspin 客户端**（player/controller 角色）直接发现并点播 MusicFlow 曲库。

本插件的目标：让 MusicFlow 扮演一个**完整对齐 MA 的 Sendspin Server**——多房同步、每客户端独立
opus/flac/pcm 编码、每播放器 DSP 音量、全角色（player/source/controller/metadata/artwork/
visualizer/color）、三配对法。对比蓝本是 Music Assistant 的 `providers/sendspin`（内部用 `aiosendspin`
服务端库）+ MA Core 的 Player/Queue/Group 层。

## 2. 形态与边界

**形态**：内置 `renderer` 插件（`backend/src/services/plugin/renderers/sendspin.ts`）+ 自包含协议服务
（`backend/src/services/sendspin/`）。

**为什么不能复用 DLNA 薄适配**：DLNA 的 `ProtocolPlayer`（`services/player/types.ts`）是"按首曲投送、
设备拉 URL"模型；Sendspin 是"服务端持续推带时间戳连续流、服务端队列为真理源"模型。模型不同 → 插件
必须自建流引擎与组/队列逻辑，不做成 DLNA renderer 式的透传。

### 边界内（插件自建）
| 模块 | 职责 |
|---|---|
| Sendspin Server | 绑定 8927 WS 服务端；mDNS `_sendspin-server._tcp.local.`（`bonjour-service`）；可监听 `_sendspin._tcp`（8928）做服务端发起连接 |
| 身份与握手 | Noise_KKpsk2（**Server 恒为 initiator**），ChaChaPoly + AESGCM 双套件；静态身份密钥长久持久化；Sentinel PSK 常量 |
| 角色层 | 全角色注册与激活 `<role>@v1`；将 role 支持的格式/方向收敛为能力表 |
| 消息路由 | 明文 text 期（init/noise/handshake/error）；加密 binary 期（type0=JSON、type1=分片、type4=音频块） |
| 流引擎 | ffmpeg 解码→PCM(F32/48k)，按每客户端声明的 format 偏好独立编码 opus/flac/pcm；FLAC 出 `codec_header`(fLaC+STREAMINFO)；块带时间戳 + send-ahead |
| 时钟同步 | server 应答 `client/time`→`server/time`(三时间戳)；2D Kalman（客户端侧，收敛前不得 `available:true`），稳态 ≤±1ms |
| 组/队列 | 服务端权威播放队列；组 public send-ahead（=各 player 最大值，成员变化重算）；组音量算法；mute 聚合；switch/leave → solo |
| 配对 | Pairing PSK / Dynamic Code(CPace-X25519-SHA512) / Static Code 三法；PSK store；`unpaired_access`；配对后带内 re-handshake 升长期 PSK |
| capability 入口 | 以内置 renderer 插件把连接中的客户端暴露为投送目标，提供 cast/control |

### 边界外（复用 core，不改它）
| 能力 | 出处 |
|---|---|
| WebSocket 服务端原语 | `ws` v8（依赖已具备） |
| mDNS 广播 | `services/discovery/mdns.ts` |
| 曲库 / 封面 / 元数据 | db、artwork 端点 |
| 加密原语 | Node `crypto`（X25519/HKDF/AEAD/base64url/base32） |
| ffmpeg | `ffmpeg-static`（sendspin 自建 opus/FLAC/PCM 管线，**不动**现有 transcode 的 mp3/aac） |
| 内置插件注册 | `plugins/builtins.ts` 的 `BUILTIN_RENDERER_PLUGINS` |

## 3. 架构组件

```
backend/src/services/sendspin/
├── index.ts             # 服务装配(index 号)
├── server.ts            # SendspinServer:WS 8927 监听、连接生命周期、明文期流程
├── identity.ts          # 静态身份密钥 生成/持久化/加载(Node crypto)
├── handshake.ts         # Noise_KKpsk2 initiator(双 suite)、Sentinel、re-handshake
├── framing.ts           # 分片 type1 / 加密后帧封装
├── roles/
│   ├── registry.ts      # <role>@v1 注册表、激活、bin id 区间映射
│   ├── player.ts        # 音频下行:format 协商、流声明、音量/静音/输出延迟
│   ├── source.ts        # 音频上行接收(type12-15)
│   ├── controller.ts    # 命令解析(play/pause/seek/volume/switch/…)
│   ├── metadata.ts / artwork.ts / visualizer.ts / color.ts  # 下行展示
├── messages.ts          # type0 JSON 消息收发 + 事件派发
├── clock.ts             # server 侧时间戳服务、server/time 应答
├── group.ts             # 组模型、公共 send-ahead、组音量/mute 算法
├── stream.ts            # 流引擎:ffmpeg→PCM→逐客户端编码→分块发送
├── encoding.ts          # opus/flac/pcm 编码器包装(ffmpeg / 可选 @discordjs/opus)
└── pairing.ts           # 三配对法 + PSK store + unpaired_access

backend/src/services/plugin/renderers/sendspin.ts   # 内置 renderer 插件(capability 面)
```

依赖（新增）：
- 握手：`noise-js`（校验其 KKpsk2/psk2、默认 initiator 支持）或 `@noble/curves`+`@noble/hashes` 手写 X25519/HKDF/ChaChaPoly/AESGCM。以 `aiosendspin/server` 源码为字节级蓝本。
- 编解码：`ffmpeg-static`（主）；可选 `@discordjs/opus`（opus 包级，省 dispatch）。
- base32（配对令牌）：自写 RFC4648（`2`↔`9` 转写）即可，不引依赖。

## 4. 连接与握手数据流

```
WS text 明文期:
  C→S client/init {client_id, version:1, suite}
  S→C server/init {server_id, version:1}
  S→C noise/handshake {data: b64url(msg1)}
  C→S noise/handshake {data: b64url(msg2)}
   → prologue = 线上 client/init 原文 ‖ server/init 原文(不含WS帧)
切换到 Noise transport;此后 WS binary 帧 = Noise AEAD 密文
  S→C server/hello {name}
  C→S client/hello {name, device_info?, supported_roles, @v1_support…, pair methods, unpaired_access}
  S→C server/activate {activities:[playback|pairing], active_roles?, pairing?}
  → 此后可发业务数据
```

帧格式：
- 加密后明文首字节 = `type`：0=JSON(UTF-8)、1=分片、4=player 音频。
- 音频块：`[4][ts_i64_be][send_ahead_u32_be][data]`；`ts`=server 时钟 µs（MUST）。
- 分片：`[1]flags[orig_type][data]` / `[1]flags[data]`；大负载 >65518 字节时。

seek / 跳曲：只发 `stream/clear`（清缓冲继续来块），**绝不** `stream/end`；track 切换只 `stream/start`
更新配置（gapless）。真正结束才 `stream/end`。

## 5. 音频与编码

- 会话格式：服务端统一解码为 PCM F32/48kHz（仿 MA `_select_session_pcm_formats`，leader 偏好、lossy 上限 48k）。
- 逐客户端：按 `client/hello.player.supported_formats` + `client/state.player.format`（可动态改）选
  opus/flac/pcm；每块一个完整编码单元（opus=单 RFC6716 包、flac 需 v1 STREAMINFO、pcm 小端有符号 24bit=3 字节）。
- 发送时机：以组公共 send-ahead 调度；`required_lead_time_ms`/`min_buffer_ms`/`output_delay_ms`(0-5000，
  持久化)/`buffer_capacity` 参与。

## 6. 时钟同步

- 周期 `client/time` → `server/time{client_transmitted, server_received, server_transmitted}`。
- 2D Kalman（offset+drift）在客户端计算；服务端只提供时间戳并测量到达/发送时刻。
- 收敛前客户端不报 `available:true`。稳态误差目标 ±0.5~±1ms；漂移修正节制（dead band ~100µs）。

## 7. 组与队列

- 每客户端恰属一组；组`group_id`/成员/volume/mute/`playback_state(playing|stopped)`。
- 服务端权威队列（与现有 `/v1/dlna/cast` 无关，独立于 device_queues）。P1 先单播放器，P3 多房。
- 组音量：`delta=请求−组均值`，逐 player 加后 clamp 0-100，被 clamp 丢弃量等分给未 clamp 者迭代；mute=全支持才 true。

## 8. 配对

- Pairing PSK（token `SP:0`+base32(client_key‖paring_psk)）：握手直接携带，无 PAKE。
- Dynamic Code / Static Code：Sentinel 连 + CPACE-X25519-SHA512 PAKE（可后置）。
- 配对后带内 re-handshake 升长期 PSK。`unpaired_access` 需操作员按 client_id 显式批准（复刻 MA
  `set_trusted_unpaired` 同意流）。
- 服务端静态身份持久化于数据目录（仿 MA `identity.key`，0600）。

## 9. 落地节奏（完整对齐 MA 的阶段性交付）

- **P1 联通**：身份+Noise 握手+WS+mDNS `_sendspin-server`、player+controller、单客户端/单组、Pairing PK、
  ffmpeg→opus/pcm、基础时间戳。目标：Xbox/Android App 发现并播放。**独立可交付里程碑。**
- **P2 体验**：`stream/clear`(seek/跳曲不 end)、metadata+artwork 角色、时钟 Kalman ±1ms、音量/静音。
- **P3 完整**：多房同步组+组公共 send-ahead、source/visualizer/color、Dynamic/Static Code+unpaired_access、
  服务端发起连接(`_sendspin._tcp`)，可选 WebRTC 桥。

## 10. 错误处理与测试

- **错误**：`server/error{reason}`（unsupported_version/suite/malformed）；其余静默关闭；重放计数器错乱→AEAD 失败→断连。配对 20 轮限制、静态码 5 次失败锁定窗口。
- **单元测试**：帧编解码、分片、组音量算法、base32/PSK 派生、时间戳格式化（用 spec 向量 + aiosendspin 向量）。
- **集成测试**：与 `Sendspin/spec` 提供的参考客户端（或 aiosendspin 客户端/真实 Xbox/App）端到端握手与播放。
- **握手兼容**：以 aiosendspin 为互操作对端跑握手矩阵（双 suite）。

## 11. 风险

- Noise KKpsk2 的 TS 侧无现成封装，token/DH 序列/分片/re-handshake 最易错 → 以 aiosendspin 源码为蓝本做字节级单测。
- 时钟 ±1ms 与编码矩阵（opus/flac/pcm × 采样率）需真实客户端验证。
- 体量大：P1 独立里程碑，勿与 P2/P3 混淆交付。