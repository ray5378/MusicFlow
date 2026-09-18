# Sendspin 真多房间组 + 流式解码方案

> 状态：方案（未开工）。目标版本待定。
> 产品目标：**多 ESP32 真多房间组、设备可中途加入**；Flutter 客户端可随时加减播放器。
> 约束：时间线/编码器/IPC 不动；3.0.28→3.0.35 的 Sendspin 链路只保不改行为。

---

## 一、背景与现状（3.0.35）

### 1.1 内存现状（240 实测，播放中）

- 主进程：~220MB，平稳。
- 子进程（sendspin 推流）：~300MB 基线、切歌尖峰 ~570MB，锯齿回落，无单调泄漏。
- 回收机制有且在工作：播完/切歌/停止即 `pcm = null`（`streamEngine.ts:319/335`），
  断连/空组走 `stopGroupPump`＋`reclaimSendspinOrphans`，`reclaim.test.ts` 锁语义。

### 1.2 内存高的根因：整曲缓冲是设计如此

`defaultSource`（`streamEngine.ts:67-76`）把整曲一次解成内存 F32：

- 320 秒歌曲 ≈ 320×48000×2声道×4B ≈ **122MB PCM**＋源字节＋ffmpeg 瞬时；
- 切歌时新旧缓冲重叠 → ~570MB 尖峰，随后 GC 收走；
- 风险：子进程继承 `--max-old-space-size=256`，超长单曲（如 1 小时 set ≈ 700MB）
  会顶爆堆（supervisor 会重启自愈但断流）。

### 1.3 组现状

- 组是隐式的"一客户端一组"（`SendspinGroup` 按 clientId 建，`pumpFor` 按组复用 pump）。
- 用户侧已有协议无关的壳：`/v1/groups`（建组/全量换成员/owner 权限/WS 事件）＋
  `group:<id>` peer（播放/音量/静音/状态扇出）＋前端群组页。
- DLNA 组的"后加入成员 cast 当前曲＋seek 到 leader 进度"（`rejoinMembers`），
  与 sendspin"直播沿加入"是同一产品语义。

---

## 二、上游调研：Music Assistant 最新版 sendspin 是流式

来源：`music-assistant/server@dev`，`providers/sendspin/playback.py`
（`SendspinPlaybackSession`，依赖 `aiosendspin`）。

### 2.1 上游管线

生产者/消费者＋有界队列，边播边解：

- 生产者从 MA 核心音频流（`streams.get_stream`，本身是 ffmpeg 流式管道）拉 PCM，
  按 **100ms 切片**（`_PRODUCER_SLICE_US`）塞进有界队列（`maxsize=64`，约 6.4 秒）；
- 消费者出队 → 编码 → `commit_audio` 下发，并调
  `sleep_to_limit_buffer(30秒)` 做背压——缓冲超 30 秒就睡，生产者被队列憋住；
- 另保留 **1 秒已提交历史**（`_HISTORY_KEEP_PAST_US`）供中途入组成员回填；
- 每成员 DSP（EQ/混音）是独立 ffmpeg processor，逐片喂（`_transform_member_chunk`），同样流式。

### 2.2 上游内存上限

有界队列 6.4 秒＋背压 30 秒＋历史 1 秒 ≈ **37 秒 F32 立体声 ≈ 14MB**，
和曲长无关。1 小时 set 也是这个数。

### 2.3 对照表

| | MusicFlow（3.0.35） | Music Assistant 上游 |
|---|---|---|
| 解码 | 整曲一次解完进内存 F32 | ffmpeg 常驻管道，100ms 切片流 |
| 内存 | ~122MB/320秒歌，随曲长线性涨，切歌重叠 ×2 | ~14MB 封顶，和曲长无关 |
| 起播延迟 | 等整曲解完（实测可达 7 秒） | 预缓冲几秒即播 |
| seek | 改 `positionMs` 下标，零成本 | 重建管道，秒级空窗 |
| 回填 | 无 | 1 秒历史＋join-catchup（服务 per-member DSP 预热） |
| 实现复杂度 | 简单，不易错 | 生产/消费/背压/晚加入回填状态机 |

### 2.4 回填取舍：不抄 MA 式回填

MA 的回填（历史重放＋promotion 状态机）解决的是它的独有问题：
**每成员独立 DSP 链预热**——新设备进来要把历史音频重跑一遍它的 EQ/filter 链，
追上直播沿才能无缝接管。我们没有这笔债：

- **时间戳绝对**：`pushFrame` 给所有成员广播同一 `tsUs`，新成员首块 ts 即
  "现在＋send_ahead"，按 ts 排播天然对齐，无"追赶"概念；
- **FLAC 帧独立可解**：新成员拿 fresh STREAMINFO（现有 `announceStream`）
  从直播沿收帧，和正常开播同一条路（新编码器攒满 4096 样本出首帧 ≈ 85ms＋250ms 提前量）；
- 唯一的"中途加入"先例（announce 临时 `g.add`）已是直播沿入流，线上正常。

结论：正确性不需要历史重放。回填只在"按房间独立 DSP"出现时才需要，
届时用 C 节的 5 秒历史环做预热（见 §五）。

---

## 三、方案总览

| 模块 | 内容 | 碰链 |
|---|---|---|
| A. 流式解码 | `PcmWindow` 滑动窗口，子进程压到 ~120MB | 只换 `GroupPump` 取数层 |
| B. 组管理 API | 复用 `/v1/groups`＋peers，成员 id 命名空间化，加增量口 | 加法分支，DLNA 老路径不动 |
| C. 短历史环 | pump 内保留最近 5 秒已提交 PCM（~2MB），为将来 DSP 留地基 | 新增 ~20 行 |
| D. 组级播报 | 按组播报（一次推帧全成员收），后续版本 | — |
| E. Flutter 接口 | 增量成员口＋现成 peers/groups/WS/鉴权 | B 的一部分 |

时间线/锚点/pacing、`pushFrame`/编码器、supervisor/IPC、announce 一律不动。

---

## 四、A. 流式解码设计

### 4.1 新增 `streamSource.ts`：`PcmWindow` 类

- **生产者**：每首歌一个长命 ffmpeg
  （`ffmpeg -ss <offset> -i <url> -ar 48000 -ac 2 -f f32le pipe:1`），
  后台 reader 持续排入窗口。水位：低 20 秒 / 高 60 秒；满则停读
  （ffmpeg 被管道憋住，天然背压，无需额外协议），低于低水位续读。
- **内存上限**：窗口 60 秒 ≈ 23MB ＋ ffmpeg 常驻 ~15MB ＋ libFLAC 堆（固定）。
- announce 的 TTS 短包（0.5 秒级）保持整包 `decodeToF32`，不动。

### 4.2 `pushLoop` 最小改动（约 60 行）

取数从 `pcm.subarray(lo,hi)` 改成 `window.slice(absLo,absHi)`：

- 命中窗口 → 直接喂编码器（热路径与现在逐字节一致）；
- 未命中但未 EOF → 等（带超时，超时走现有 `STALL_GRACE` 降级语义）；
- EOF 且窗口耗尽 → 结束（替代 `i >= total`）。
- `durationMs` 改用元数据时长（`resolvePlayableRow` 的 row 自带 duration；
  即使偏差几十 ms，"播完即 `current=null` 触发切歌"逻辑不变，EOF＋耗尽是第二道兜底）。
- `seek`：目标在窗口内（±10 秒占绝大多数）→ 只改 `positionMs`，零成本不变；
  窗口外 → 杀 ffmpeg 按 `-ss` 重起，空窗 ~1 秒。
- `stop()`：杀 ffmpeg＋清窗口（对应现在 `pcm=null`，`reclaim.test.ts`
  "停后释放"语义保留，释放对象从 buffer 换成窗口＋进程）。

### 4.3 接口兼容

- 保留 `PumpSource`/`GroupAudio` 整包接口，`GroupAudio` 加可选 `stream?: PcmWindow`；
  有 `stream` 走窗口路径，否则走老路径。
- 现有注入测试（`overridePumpSource`、`pumpEnd`、`reclaim`、`pumpFallback`）**零改动**。

### 4.4 失败模式（对齐现有语义）

- ffmpeg 中途崩 → 等同"解码失败"：warn＋停 pump，QC 按现有逻辑切下一首
  （只是发生时机从"开播前"变"播中"）。
- 窗口饥饿（网络抖动）→ 已有 stall 降级保流逝，恢复后自动跟上。
- epoch 作废（快速连切）→ 旧 ffmpeg 必杀（句柄登记＋`stop()`/`play()` 双保险），防僵尸进程。

---

## 五、B. 组管理 API：壳复用、核分流

不另起 `/v1/sendspin/groups`（平行系统必腐化：权限/WS/前端/QC 全 duplicat，
SPEC §1.6.3 点名的"复制品腐化"问题；且用户要理解两套"群组"是实现泄漏）。

### 5.1 改动清单（全加法）

1. `memberIds` 命名空间化：`dlna:<id>` / `sendspin:<clientId>`，
   裸 id 继续沿用 DLNA（存量组零迁移）。
2. `GroupManager` 三处按前缀分流：`assertMembersAvailable`（DLNA 查缓存 /
   sendspin 查在线 clients）、`resolveMembers`（名称＋可用性）、事件 payload 不变。
3. `PUT` diff 出新增成员：dlna 走现有 `rejoinMembers`（cast＋seek）；
   sendspin 走**直播沿加入**（`joinGroup`，见 §五 5.4）。
4. `group:<id>` 扇出补 sendspin 分支：现状组静音是
   `members.map(setDeviceMute)`，sendspin 成员会全失败，改为按 kind 分发
   （单播 sendspin 逻辑已存在，直接复用）。
5. 前端群组页成员选择器加 sendspin 在线播放器（`sendspin:<id>` peer 注册现成）。
6. 服务端映射（与 API 选择无关、两种方案都要做）：用户组 id → 一个多成员
   `SendspinGroup`＋一个 pump（现在组按 clientId 隐式建，这是唯一的真新逻辑）。

### 5.2 增量成员口（Flutter 用）

- 新端点 `POST /v1/groups/:id/members`，Body `{ add?: string[], remove?: string[] }`，
  一次调用可同时加减，原子执行，返回更新后 group（含成员详情，免二次 GET）。
- **PUT 内部改调同一个 `applyMemberDelta`**
  （PUT ＝ remove 不在新列表的 ＋ add 新增的），"新增→加入对齐"钩子只存在一份，
  Web 和 Flutter 语义不可能漂移。
- 为手机场景而设：单成员幂等（add 已存在＝no-op），无 read-modify-write，
  两台手机同时加不同设备不丢成员；弱网重试安全。权限/owner 校验复用 PUT 同一套；
  WS 照常广播 `group_updated`。

### 5.3 Flutter 流程

`GET /v1/peers` 选设备 → `POST members {add:[...]}` → 收 WS `group_updated` 刷新。
播放/音量/静音走 `group:<id>` peer 口。鉴权沿用 Bearer token＋`RENDERER_USE`。

### 5.4 直播沿加入路径（sendspin 版 rejoin）

`stream/start`（codec_header＋格式）→ `members.add` → 从直播 cursor 收帧；
摘除：`members.delete`＋`stream/end`。编码器按 `(clientId:codec)` 本来就隔离，
PCM＋FLAC 混编可并存。加测试锁"同一批帧所有成员收到相同 ts"，把隐式对齐变显式契约。

---

## 六、C. 短历史环（~20 行，为将来 DSP 留地基）

`GroupPump` 保留最近 5 秒已提交 PCM（≈2MB 常驻），只记不播。
现在唯一消费者是"将来"：按房间 EQ 上线时，新成员 DSP 链用这 5 秒预热后切直播沿，
到时候再写 warmup 状态机。现在不写 promotion 窗口/超时/快照任务——
没有 per-member DSP 就没有 promotion 问题。

---

## 七、分阶段 rollout（每步可独立回滚）

1. `streamSource.ts`＋单测：本地 WAV 全曲流播对拍（逐片与整包解码二进制一致）
   ＋seek 窗口内外＋EOF＋杀进程无残留。
2. `GroupPump` 接流式，开关 `SENDSPIN_STREAM_SOURCE=1`（默认关）；CI 全绿。
3. 组管理 API（命名空间＋增量口＋直播沿加入＋同 ts 断言测试）。
4. 5 秒历史环。
5. 240 soak：内存曲线（预期基线 ~120MB、无尖峰）＋双 ESP32 加减成员演练
   ＋切歌/seek/断连演练。
6. 默认开 → 观察一个版本 → 删老路径（`decodeToF32` 整包调用点；函数保留给 announce）。

## 八、风险

- 最大风险是 seek 窗口外重建延迟和 ffmpeg 长命进程管理——MA 已趟过，
  我们只取生产/消费＋背压子集，不抄回填复杂度。
- D（组级播报：announce 现按 `sendspin:<clientId>` 单播，多房间组需按组播报）
  放后续，不 block A–C。
