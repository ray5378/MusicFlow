# MusicFlow × Sendspin 渲染器插件 —— 任务交接文档

- 日期：2026-09-13
- 分支：`dev`（本交接基于当前工作分支 `trae/agent-qcz6Nv` 的已提交代码创建）
- 仓库：`github.com/ray5378/MusicFlow`
- 关联设计：`docs/superpowers/specs/2026-09-12-sendspin-renderer-design.md`、`docs/superpowers/plans/2026-09-12-sendspin-renderer.md`

> 本文档是**任务进度交接**，不是最终交付报告。它如实记录：目标、已完成的验证、现行代码与真实
> aiosendspin 协议之间的**剩余差距**、下一步该做什么、以及每一步的**验证方式**。接收人据此可直接继续。

---

## 0. 进度更新（每个阶段性任务完成后追加最新一条，勿覆盖历史）

- **2026-09-13 — peer 接口补齐 + musicflow-client 切换器接入（已完成并把客户端改动推送到 GitHub）**
  - 后端：`PeerKind` 加 `sendspin`；`peer.ts` 新增 `registerSendspin/removeSendspinPeer(s)`、`parse` 支持 `sendspin:`、
    `KIND_RANK` 与 dlna/airplay 同级；`access.ts::peerToDeviceKey`、`api/index.ts::isCastPeer` 支持 sendspin；
    `/v1/peers/:id` 的 play/pause/stop/seek/volume 加 sendspin 分支。
  - sendspin 播放器注册时同步 `registerSendspin` peer，断开/停服时移除 → 前端切换器与 `/v1/play` 可发现并投送。
  - **关键补齐**：`/v1/peers/:id/status` 原对 sendspin 落到队列快照（无 state/position/duration）→ 新增
    `QueueController.getPlayerState()` + `/status` sendspin 分支（由推流引擎驱动 position/duration）。客户端 `_tick` 进度条恢复。
  - 客户端（`ray5378/MusicFlow-client`，遥控模式本已 kind 无关）：`PeerInfo.kindLabel` 加 `'sendspin' => 'Sendspin'`；
    切换器徽章 `_DlnaBadge`（写死「DLNA」）改为 `_PeerBadge(label: peer.kindLabel)`，顺带修掉 airplay/group 被误标 DLNA。
  - 客户端改动已提交 `ffc7c4b` 并 push `origin/main`（`dd16253..ffc7c4b`）。
  - 回归：`tsc --noEmit` ✅ 0 错误；`vitest run tests/sendspin` ✅ 13/13。注：沙箱无 Flutter SDK，客户端未跑 `flutter analyze`。

- **2026-09-13 — 真实主进程全链路（npm run dev 走插件启用→发现→播放）**
  - `npm run dev` 起真实 MusicFlow :46400；`PUT /plugins/sendspin-renderer/toggle` 联动拉起 8927 sendspin 监听器。
  - 4 台真实 aiosendspin 玩家直连：handshake OK → server/hello → server/activate(player@v1)，各注册为 QueueController 播放器；
    `/v1/peers` 返回 4 个 `kind=sendspin, available=true`。
  - `POST /v1/play` 投送 → 客户端实测收到 **300 帧 opus（0.24MB，0→2.98s，整首 3s）**，进程内 @discordjs/opus 逐帧编码 + 真实时间推流。

- **2026-09-13（交接前已达成）**：P0 重写 `server.ts` 为 WebSocket 监听器（明文 TEXT `client/init`→`server/init`，
  服务端做 Noise initiator，加密 transport 收发框架+分片）；post-handshake（`server/hello`→`client/hello`→`server/activate`）；
  P1 推流接通（`streamEngine` 解码→PCM→@discordjs/opus 逐帧编码→`group.pushFrame`，真实时间推进驱动 auto-advance）；
  队列全模式单元级复测（`tests/sendspin/queueModes` 及 `protocolPlayer.test.ts`）。

---

## 1. 目标（原始需求）

1. 启动**真实的 MusicFlow** 并加载 Sendspin 插件，而不只是跑单元测试。
2. 集成**外置 go-music-dl 插件**的真实音乐歌单。
3. 向 **4 台真实 Sendspin 接收播放器**（用真实 aiosendspin SDK 启动）**真实推流**，端到端验证功能。
4. Sendspin 插件必须与 DLNA 播放器一样**服务端权威**：全部播放队列模式、自动换源/回退/跳过、暂停/恢复/拖动都要做好。
5. 修好所有问题后再汇报，而不是半成品。

---

## 2. 架构与职责（服务端权威模型）

核心模型：**服务端权威播放**。`UniversalPlayer / QueueController / PlaybackTracker` 管理队列、播放状态、
自动下一曲、换源/回退/跳过；renderer 插件只做**协议专属操作**。

```
QueueController ── registerSendspinDevice(clientId, clientId)
      │  ProtocolPlayer(play/pause/resume/seek/setVolume/pollState)
      ▼
sendspin/protocolPlayer.ts  ── 组/客户端协议操作
      ▼
sendspin/server.ts  ── WebSocket 服务端 + 握手
      ▼
sendspin/streamEngine.ts ── 解码→PCM→按真实时间推帧(GROUP 同步 positionMs/current)
      ▼
真实 aiosendspin 接收播放器（本机 4 台，Python SDK）
```

对照基准（做法可复制）：`services/player/` 的 `QueueController`、`PlayerController`、`UniversalPlayer`，
以及 DLNA `registerDlnaDevice` / `createDlnaProtocolPlayer`、AirPlay 的同类用法。

关键挂接点：`backend/src/services/sendspin/index.ts#registerServerPlayer`（把就绪连接注册为
QueueController 服务器权威播放器）。该文件当前仍按「主动拨号」模型写的（见第 4 节待办）。

---

## 3. 已完成的工作（含已通过的验证）

`services/sendspin/` 已实现并通过单测，约 4457 追加行（相对 `origin/main`）：

| 模块 | 文件 | 状态 |
|---|---|---|
| Noise_KKpsk2 握手（initiator+responder、双 suite） | `handshake.ts` | ✅ 已实现，且**与真实 Python `noise` 库逐字节互操作通过**（见 3.1） |
| 静态身份 X25519 持久化(0600) | `identity.ts` | ✅ + 单测 `identity.test.ts` |
| base64url / hex 助手 | `util.ts` | ✅ + 单测 |
| 加密后帧封装、二进制/JSON、分片 | `framing.ts` | ✅ + 单测；音频帧=类型字节 0x04 + 8 字节大端时间戳 + 数据 |
| 组模型、成员、公共 send-ahead、组音量 | `group.ts` | ✅ |
| 消息类型、role 路由 | `messages.ts` | ✅ |
| role 注册表(registry)/player/controller/source/metadata/artwork/color/visualizer base | `roles/` | ✅ 骨架 + 部分单测 |
| 流引擎（解码→PCM→推帧→自然结束触发 auto-advance） | `stream.ts`、`streamEngine.ts`、`streamCommand.ts` | ✅ 已实现真实时间推进 |
| 时钟 | `clock.ts`(含于 runtime 关联) / `server/time` | ⚠️ 部分 |
| 配对(三法)/PSK | `pairing.ts` | ⚠️ 骨架 |
| ProtocolPlayer 实现 | `protocolPlayer.ts` | ✅ 接口 + 单测 `tests/sendspin/protocolPlayer.test.ts` |
| 生命周期装配 | `index.ts`、`runtime.ts` | ⚠️ 仍是拨号模型，需改监听模型 |

### 3.1 关键里程碑：TS 握手与真实 Python 库逐字节互操作 ✅

已用**真实 `aiosendspin` SDK 的 `noise/session.py`（底层是官方 Python `noise` 库）** 做了 TS initiator ↔
Python responder 的握手互操作验证。结论：**两边手握手哈希完全一致**。

- 验证结果（本次会话实测）：
  ```
  PY_MSG1_PAYLOAD        {"psk_id":"GFsV9tLaSQm9HcFWpKsgYQOr7wFTvNUtkmFwuVz3zoo"}
  TS_PAYLOAD_MSG2        {}                      # 与 aiosendspin NoiseMsg2Payload 空对象一致
  TS_HANDSHAKE_HASH_HEX  d82092b4e771...        # = PY_HANDSHAKE_HASH_HEX
  PY_HANDSHAKE_HASH_HEX  d82092b4e771...
  ```

- 确认的协议要点（已逐条核对 `aiosendspin` 源码）：
  - 握手 suite：`Noise_KKpsk2_25519_ChaChaPoly_SHA256` / cipher `25519_ChaChaPoly_SHA256`。
  - KKpsk2 pattern：消息1 `[e, es, ss]`；消息2 `[e, ee, se, psk]`。
  - PSK 模式「e 令牌」额外 `MixKey(e.pub)`；`psk` 令牌 `MixKeyAndHash(psk)`——与 Python `noise` 库一致。
  - 前消息（pre-messages）哈希顺序固定为 **initiator static 先、responder static 后**（与角色无关）。
  - 秘钥轮换非随机化 nonce：8 字节计数器写在该 12 字节 nonce 的**偏移 4**。
  - `SENTINEL_PSK = sha256("sendspin-sentinel-psk-v1")`；`psk_id = base64url(sha256("sendspin-psk-id-v1" + psk))`。
    现有 `constants.ts` 里的硬编码十六进制已核对正确（`psk=e5…` 派生一致），`psk_id` b64url=`GFsV9tLa…`。
  - 音频帧字节格式：`0x04` + 8 字节**大端有符号** `timestamp_us` + 编码后音频数据（`AudioChunk.packed`）。

---

## 4. 待办（已按进度勾选完成项；未勾者为剩余任务）

> 当前 `server.ts` 已按监听器模型运行，进度见第 0 节；以下为剩余待办。

- [x] **【P0】重写 `server.ts` 为 WebSocket 监听器**（`ws` 的 `WebSocketServer`，监听 `:8927/sendspin`）。
- [x] **【P0】post-handshake 应用协议**（`server/hello`→`client/hello`→`server/activate`、`client/state`、`server/time`）。
- [x] **【P1】接通推流**（`streamEngine` 解码→PCM→@discordjs/opus 逐帧编码→推给 4 台玩家；`group.positionMs` 驱动真实 auto-advance；
  `protocolPlayer.pause/resume/seek` 接 GroupPump）。
- [x] **【P1】端到端真测试**（4 台真实 aiosendspin 玩家：握手 / server-hello→client/hello→activate / 收真实音频帧）。
- [x] **【P1】构建/启动真实 MusicFlow**（sendspin 插件）验证注册与播放（`npm run dev` 插件启用→发现→`/v1/play`→真实推流 300 帧）。
- [x] **额外 — peer 接口 + 客户端切换器接入**（后端 peer 补齐 + `/status`；`MusicFlow-client` `kindLabel`/徽章支持 sendspin，已 push `ffc7c4b`）。
- [ ] **【P1】服务端权威队列全模式复测（真实设备端到端）**：自动下一曲/切歌跟随、换源回退、跳过、暂停/恢复/拖动、断连重连。
- [ ] **【P2】go-music-dl 外置服务**配真实歌单并联网验证。
- [ ] **回归与收尾**：`tsc` build + `vitest` 全部通过；输出最终报告（含客户端推送记录）。

---

## 5. 验证方式（每个里程碑怎么证明）

### 5.1 握手互操作（已通过，可复跑）
TS initiator ↔ Python responder，固定密钥，比对 `handshake_hash`。
- 先由 Python 生成固定密钥并写死到脚本；TS 写消息1 → Python 读消息1 并以 responder 回消息2 → TS 读消息2。
- 命中断言：`TS_HANDSHAKE_HASH_HEX == PY_HANDSHAKE_HASH_HEX` 且 TS 明文消息2 == `{}`。
- TS 运行：`npx tsx <initiator脚本>`（from `backend/`）；Python：`/tmp/aiosendspin/.venv/bin/python <responder脚本>`。

### 5.2 单元测试
- `cd backend && npx tsc --noEmit`（类型全绿）
- `cd backend && npx vitest run`（sendspin 相关：`handshake`、`framing`、`group`、`identity`、`messages`、
  `roles/registry`、`roles/controller`、`stream`、`util`、`tests/sendspin/protocolPlayer`）

### 5.3 端到端（P1 完成后跑）
- `startSendspinService()` 后本机 4 台 aiosendspin player 连接 →
  断言各台都完成 handshake、收到 client/hello 处理、收到连续音频帧（时间戳单调递增）、
  播放主进程切歌时各台跟随跳帧/停流。

---

## 6. 环境与依赖

- 在线沙箱（非交互，`CI=true`），工作目录 `/workspace`，后端在 `backend/`。
- 后端为 `musicflow-backend`（`backend/package.json`）：`ws@8`、`@noble/*`、`ffmpeg-static`、`tsx`、`vitest`。
- 真实 sendspin 参考实现（只读，勿提交）：
  - `/tmp/aiosendspin/.venv/lib/python3.12/site-packages/aiosendspin`（已装 `aiosendspin[server]`）
  - `/tmp/aiosendspin/aiosendspin`（源码 clone）
- 已安装依赖：`ffmpeg-static`（解码），`noise-handshake`（npm，暂未用——本实现用 `@noble` 自写）。

---

## 7. 关键文件速查

| 文件 | 职责 |
|---|---|
| `backend/src/services/sendspin/server.ts` | ⚠️ 需重写为 listener；当前是拨号模型 |
| `backend/src/services/sendspin/handshake.ts` | ✅ 已与真实库互操作通过的核心 |
| `backend/src/services/sendspin/framing.ts` | 加密帧/分片/音频帧打包（`0x04`+BE ts） |
| `backend/src/services/sendspin/streamEngine.ts` | 解码→PCM→真实时间推帧 + 自然结束触发 auto-advance |
| `backend/src/services/sendspin/protocolPlayer.ts` | ProtocolPlayer（pause/resume/seek 待接 GroupPump） |
| `backend/src/services/sendspin/roles/registry.ts` + `roles/*` | 角色注册/激活/消息路由 |
| `backend/src/services/sendspin/constants.ts` | 常量；`SENTINEL_PSK`/`psk_id` 已核对正确 |
| `backend/src/services/sendspin/index.ts` | 生命周期装配；注册 QueueController 播放器（需改监听模型） |
| `docs/superpowers/specs/2026-09-12-sendspin-renderer-design.md` | 完整设计 |

---

## 8. 风险与注意点

1. **对接真实 aiosendspin 玩家最难的其实是握手之后的明文/加密帧字节对齐与消息序列**，而**握手本身已攻破**
   （通过互操作验证）。继续优先做「监听器 + server/hello→client/hello→activate」。
2. `noise-handshake`（npm 包）当前**未使用**，代码用 `@noble` 自写并已验证；不要重复引入两套，避免歧义。
3. 音频格式：真实 aiosendspin 玩家期望的编码（PCM s16le vs 协商 codec）需在 P1 推流时实测确认，
   以参考实现 `server/roles/player/v1.py#on_audio_chunk`、`server/audio*.py`、`push_stream.py` 为准。
4. mDNS 通报 `_sendspin-server._tcp.local.`(8927) 本机起 4 玩家时可不依赖（玩家直连 127.0.0.1:8927），
   但要提供给真硬件客户端。
5. 沙箱插件（外置 go-music-dl）无 Node 能力，不能承载协议；sendspin 必须是内置插件（同 DLNA/AirPlay）。

---

## 9. 交接结论

- **核心协议风险已化解**：TS 的 Noise_KKpsk2 握手与真实 aiosendspin 逐字节互通（哈希一致）。
- **当前最大二跳**：把 `server.ts` 从「拨号客户端模型」重写为「监听器 + 服务端 initiator + TEXT 明文交换」，
  再补齐 post-handshake 推送，用真实 aiosendspin 4 台玩家端到端验证。
- 其余（队列权威、go-music-dl、全量回归）为标准化收尾，见第 4 节待办。