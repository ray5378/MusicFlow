# MusicFlow · AirPlay 2（专家组 E2~E5）课题立项与实施计划

> 本文是 **独立课题**的立项与执行依据，与「播放链路五项改动」主线的 **AP1 收线**分开管理。
> 主线结论：AP1/RAOP 已可用（真机 HiVi 正常），230 测试床的 ALAC 兼容性作为遗留项归档（见 §2.2），不阻塞本课题。
> 阶段约定：改动一律「本地门禁 → 提交 230 main → 热更新 240 实测」；正式版另行按 CI 全绿后打 tag。

---

## 1. 课题目标与边界

### 1.1 目标（按 D2 拍板的验收深度）

1. **发现层分级**：同时浏览 `_raop._tcp` 与 `_airplay._tcp`，读 TXT（`deviceid`/`features`/`srcvers`/`flags`/`model`/`pk`/`protovers`/`gid`），判定设备是否支持 AirPlay 2。
2. **发送端 AP2 链路**：支持 AP2 的设备走 AP2（配对 + 加密 + 缓冲式推流 + 控制/时钟），否则**回落现有 AP1**。
3. **230 双接收器出声**：AP2 接收器（`ap2-receiver`）与 AP1 接收器（`shairport-sync`）都能收到音并出声。
4. **AP1 零回归**：HiVi H5MKII（纯 AP1）行为与本课题开工前**逐字一致**，并用静态守卫锁死。

### 1.2 非目标

- 不做 AirPlay 2 **接收端**（本课题只做发送端；230 的接收器仅作测试对端）。
- 不做屏幕镜像 / 视频 / 多房间 Audio Sync 组（AirPlay 2 的 multi-room）。
- 不接 HomePod 类需要**设备端输入 PIN** 的配对（无真机、无凭据）；遇到即回落 AP1 并明确报错。
- 不改公共转码管道、不改其它播放器（DLNA / Sendspin / 客户端）既有链路。

### 1.3 硬边界（红线）

1. 新增协议代码**全部**落在 `backend/src/services/airplay/ap2/**`（新子模块）。
2. `services/plugin/renderers/airplay.ts` 只允许加「选 AP1 / 选 AP2」的分支与能力字段，不得把协议细节写进 renderer。
3. **不得改** `services/airplay/raop.ts` 的线上行为；若 AP2 要复用其 ALAC/加密工具，只允许**新增导出**，不改既有导出语义。
4. 公共段（`routes/rest/index.ts` 出流、`services/audio/pipeline.ts`、`services/transcode.ts`）**零改动** —— AP2 仍从既有 `/rest/airplay/stream/:token` 取流。

---

## 2. 现状与前置结论

### 2.1 已有资产（可直接复用）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| RAOP 会话编排（起播/停下/seek/音量/节拍健康度） | `services/airplay/control.ts`（987 行） | AP2 作为**并行策略**接入，不改其分支；新增 `ap2/` 内实现后由 renderer 选择 |
| 子进程宿主（避免主进程掉帧） | `rendererHost` + `airplay/{child,childMain,supervisor,ipcProtocol}.ts` | AP2 推流运行时同样放子进程（与 AP1 同款，不新建 fork） |
| 解码/输出段（44.1k/16bit/stereo） | `services/airplay/decoder.ts` | 直接复用（AP2 音频格式要求一致） |
| ALAC 打包 | `raop.ts::pcmToAlacRaw` | 只**引用**，不改语义（AP2 音频载荷同为 ALAC） |
| 加密原语 | 已有依赖 `@noble/ciphers`（ChaCha20-Poly1305）、`@noble/curves`（Curve25519 / Ed25519）、`@noble/hashes`、`noise-handshake` | **无需新增依赖**，AP2 的 pair-setup / pair-verify / 传输加密都能覆盖 |
| mDNS | `bonjour-service`（`discovery.ts` 现只 browse `raop`） | 增加 `_airplay._tcp` browser；同一 `Service` 归一为一条设备记录 |
| 出流 | `/rest/airplay/stream/:token`（AP1 已在用，豁免清单已含） | AP2 复用同一 token 出流，**不动公共段** |

### 2.2 从主线归档的遗留项（**不阻塞**本课题，但需登记）

**AP1 ↔ shairport-sync 的 ALAC 帧兼容性**：230 测试床上握手已全 200（`v4.6.46` 修掉请求行缺 `RTSP/1.0` 后），服务端 `PLAYING` 正常推流，但 shairport 在解码阶段崩溃：

- 现象：`FIXME: unhandled prediction type on channel 1: N` / `FIXME: Not enough space if the output buffer for audio frame - E2.` → `SEGV` / `ABRT`。
- 已排除：RSA/AES 加密（临时置 `rsa=false` 后现象不变）；RTSP 握手（对端全程 200）；出流（服务端 129+ chunks 持续发送）。
- 已定位：`pcmToAlacRaw` 的帧头按 shairport `alac.c` 的位序解析可正确读出 `hassize=1 / uncompressed_bytes=0 / isnotcompressed=1 / size=352`（用真实导出帧头 `20 00 12 00 00 02 c0 …` 逐位验算）；但**多包序列**下仍有个别包被判成压缩帧。假设：**短包（frames < 352）的零填充与帧尾 tag 位，或 RTP 分包边界**与解码器期望不符。
- 影响面：仅**测试床**（shairport）出声；真机 HiVi 正常。归档为独立课题，与 AP2 **无依赖关系**。

### 2.3 测试床（230，已就绪）

| 对端 | 地址 | 用途 |
|---|---|---|
| `shairport-sync`（AP1，systemd） | `MusicFlow-230-AP1`，:5000 | AP1 回归（当前受 §2.2 阻塞，仅用于握手/时序验证） |
| `ap2-receiver.py`（OpenAirplay） | `MusicFlow-230-AP2r`，:7000，`_airplay._tcp`，`features=0x405f4200,0x1c300` | **AP2 主对端** |
| 自建 shairport（AP2 版） | `MusicFlow-230-AP2`，:7100 | AP2 备选对端 / 特性交叉验证 |
| 真机 HiVi H5MKII | `192.168.10.30:4515`，仅 `_raop._tcp` | AP1 零回归验收 |

> 测试床均输出到 ALSA `snd-aloop`，用 `arecord -D hw:Loopback,1,N` 回采 + 峰值/RMS 判定「真实出声」，不依赖人耳。

---

## 3. 分阶段计划（每阶段独立可验收）

### E2 发现层分级（最小风险，先落地）—— **已完成（2026-10-20，提交 `3024cf2`，版本 4.6.47）**

**改动**：`services/airplay/discovery.ts` 增加 `_airplay._tcp` browser；把同一 `deviceid` 的 raop/airplay 两条 mDNS 记录合并为一条设备，附 `supportsAp2` 与 `features/srcvers/flags/protovers/gid`；`renderers/airplay.ts` 暴露能力字段。

**实际落地的判据（与初稿的差异，已按实测收敛）**：`supportsAp2 = 同时有 _airplay 记录 && protovers ≥ 1.1`，**不引入 features 位判定** —— 位定义无权威来源、凭记忆写死会在真机上分错级；`features/srcvers/protovers/gid/flags` 原样留存给 E3 用。**设备表仍只由 `_raop._tcp` 产生**（纯 AP2-only 广播不入表，避免 AP2 发送端未落地前出现「点了报错」的死设备）。

**验收（全部达成）**：
- 单测：新增 `discoveryAp2.test.ts` 9 例（先到顺序 ×2、纯 AP2-only 不入表、protovers=1.0、缺 deviceid、`_airplay` down 撤能力、stop 清表、deviceid 归一、版本判据）；既有 `discovery` / `airplayDiscoveryTail` 句柄数同步（常驻 2、续期各 1）；airplay 全套 **306 用例全过**。
- 守卫 `check-airplay-ap2-discovery.mjs`（ci.yml 第 24 job，四组 16 条）：设备表唯一来源 / protovers 判据 / down 撤能力 / AP1 零回归；**反向变异 4 项全判红**、还原逐字节一致。
- 240 实测：`MusicFlow-230-AP2` → `supportsAp2=true / protovers=1.1 / features=0x401C4A00,0x5C340`；`HiVi H5MKII`、`MusicFlow-230-AP1` → `false`；纯 AP2-only 的 `MusicFlow-230-AP2r` 按设计不入表；`/v1/peers` 的 AP1 投屏端与队列未变。

### E3 握手与配对（SRP + Curve25519/Ed25519 + ChaCha20-Poly1305）

**改动**（全部新增于 `ap2/`）：`pairing.ts`（pair-setup / pair-verify 状态机）、`crypto.ts`（HKDF 派生、ChaCha20-Poly1305 封装）、`rtsp.ts`（AP2 版 RTSP，复用 AP1 的三段式请求行契约）。

**验收**：
- 单测：状态机各分支（成功 / 设备拒绝 / 超时 / 校验失败）、密钥派生向量（固定输入 → 固定输出）、加解密往返。
- 守卫：**不得**把 AP2 加密原语写进 AP1 路径；AP1 的 `et` 判定与 RSA 分支逐字未变。
- 230 实测：与 `ap2-receiver` 完成 pair-setup → pair-verify，`/info` 可取；失败时回落 AP1 且日志可读。

### E4 音频（SETUP streams + 缓冲式推流）

**改动**：`ap2/streamer.ts` —— `SETUP` 携带 streams 数组；音频为 44.1k/16bit/stereo → ALAC（复用 `pcmToAlacRaw`，必要时**新增**对短包的显式处理）；按 AP2 的缓冲语义推流（`RECORD` / `FLUSHBUFFERED` / `SETRATEANCHORTIME` 按实测对齐）。

**验收**：
- 230 实测：`ap2-receiver` **真实出声**（回采峰值 > 0，连续 ≥ 30s 无爆音/断流）。
- 守卫：AP2 音频参数（44.1k/16bit/stereo、chunk 352）锁定；AP1 出流调用点未改。
- 反向变异：改采样率 / 改 chunk → 红。

### E5 控制与时钟（play/pause/seek/setRate、PTP/NTP、音量）

**改动**：`ap2/control.ts` —— 把现有 `QueueController` 的 play/pause/next/seek/音量指令映射到 AP2 控制消息；时钟按接收器实测选择 PTP（IEEE 1588）或 NTP 回退。

**验收**：
- 230 实测：暂停/恢复/切歌/拖动/音量逐个生效；**主线 T-D 的三条现网缺陷在 AP2 下不得复现**（放完自动下一首 / 不重复起播 / 外部切歌生效）。
- 守卫：控制指令出口单一（与 AP1 的 `reportAirPlayPlaying` 同款「主动上报」契约），`IDLE` 必须带真实落点。
- 真机：HiVi 走 AP1，全链路回归。

---

## 4. 顺序与依赖

```
E2 发现分级 ──► E3 配对/加密 ──► E4 音频出声 ──► E5 控制/时钟 ──► 真机 AP1 回归
   （可先落，无外部依赖）        （依赖 E3 的会话密钥）   （依赖 E4 出声）
```

- **E2 可立即开工**，不依赖任何外部结论。
- E3 起需要 `ap2-receiver` 的握手日志可读（230 上 `--debug` 已在跑）；若对端不支持某种配对模式，**先改对端配置**而不是改我方协议，避免把测试床的偏差固化进实现。
- E4 完成后才能验 E5；E5 的时钟若与 `ap2-receiver` 不兼容，允许先做 NTP 回退并明确记录，不阻塞其它项。

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 开源 **AP2 发送端**参考实现稀缺（多为接收端） | 协议细节需逆向验证，进度不可控 | 以 `ap2-receiver` 为唯一权威对端，**每步实测对齐**；不确定处先写探针脚本验证，再落代码 |
| 配对模式差异（transient vs PIN） | 部分设备无法配对 | 无 PIN 能力 → 明确回落 AP1 + 可读错误，不静默失败 |
| PTP 时钟实现复杂 | 音画/节拍不同步 | 先 NTP 回退跑通，PTP 作为增量；用「reanchors / maxGap」指标判定是否可接受 |
| 与 AP1 代码交叉污染 | 真机回归 | 目录隔离 + 守卫（E2 起每阶段都加「AP1 分支逐字未变」的反向断言） |
| ALAC 短包处理（§2.2） | AP2 也可能踩同一坑 | E4 前先在 `ap2/` 内做**独立的帧构造自测**（固定 PCM → 帧 → 逐位验算），不假设 AP1 的实现正确 |

---

## 6. 每阶段的通用落地流程（沿用项目既定约定）

1. 落地前**方向审查**（独立复核边界与回落逻辑）。
2. 改代码 + 补单测 + 补静态守卫（`check-*.mjs` 并挂 `ci.yml`）+ **反向变异验证**（改坏必红、还原后逐字节一致）。
3. 落地后**全面审查**。
4. 本地门禁：230 上 `npx tsc --noEmit`、全部 `node backend/scripts/check-*.mjs`、相关 `npx vitest run`。
5. 提交 230 main → 热更新 240 → 实测（回采判定出声）。
6. 记入 `CHANGELOG.md` 对应版本条目。

---

## 7. 本课题的完成定义（DoD）

1. `/v1/peers` 能区分 AP2/AP1 设备，且 AP1-only 设备（HiVi）路径**零回归**。
2. 230 上 `ap2-receiver` 由 MusicFlow 推流**真实出声**（回采可证），可暂停/切歌/拖动/调音量。
3. 三条 T-D 缺陷在 AP2 下不复现。
4. E2~E5 各自的静态守卫 + 反向变异全绿；两仓 CI 全绿。
5. CHANGELOG 有独立版本小节；今日待办/本文档回填证据。
