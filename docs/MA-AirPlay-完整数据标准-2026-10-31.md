# MA → AirPlay 正常播放 / 手动操作 数据标准（对 HiVi 实测基线）

> 采集对象：Music Assistant 容器 `mass`（host 网络，192.168.10.240）→ HiVi 音箱（192.168.10.30）
> 采集 A（正常播放基线）：2026-10-31 20:26:41 – 21:06:41，2400 s，覆盖 7 首完整曲目
> 采集 B（手动操作）：2026-10-31 21:38:19 – 21:52:24，866 s，覆盖 3 次自动换歌 + 8 次曲目切换 + 9 次曲内跳转
> 用途：以 MA 的实际行为作为 MusicFlow Sendspin 桥 → AirPlay → 播放器链路的对标基准

---

## 1. 拓扑与抓包方法

| 项 | 值 |
| --- | --- |
| 抓包主机 | 240（MA 与 HiVi 同网段，MA 容器为 host 网络） |
| 网卡 | `eno1-ovs` |
| 过滤表达式 | `host 192.168.10.30`（双向） |
| 抓包命令 | `tcpdump -i eno1-ovs -U -n -s 0 -C 300 -w /tmp/mfpc/ma_hivi_<ts>.pcap 'host 192.168.10.30'` |
| 采集 A | 2 个切片合并：395,576 包 / 309 MB |
| 采集 B | `tcpdump ... -C 100 -W 20 -w /tmp/mfop/op_<ts>.pcap`，151,507 包 / 113 MB |
| 会话状态 | 两次抓包都在播放会话已建立后开始（曲中入抓），故无 SETUP / ANNOUNCE / RECORD 请求 |

通道清单（采集 A，`ap_analyze.py` 分类）：

| 通道 | 流向 | 包数 | 平均字节 |
| --- | --- | --- | --- |
| 音频 RTP（PT 96） | 240:37233 → 30:33264 | 300,758 | 918 |
| RAOP sync（PT 84） | 33264 → 33264 | 2,385 | 20 |
| RAOP 重传请求 0xd5 | 30 → 240 | 75 | 8 |
| RAOP 重传响应 0xd6 | 240 → 30 | 235（含同类控制包） | ~1,054 |
| AirPlay 2 时钟（0xd2/0xd3） | 50767 → 50767 | 1,590（每 3 s 一对） | 32 |
| AirPlay 2 控制（RTSP） | 240:60495 → 30:4515 | 522 → 363（双向 206 KB / 40 KB） | — |
| AirPlay 2 事件（POST） | 240 → 30:49152 | 2,247（≈0.94/s） | — |
| mDNS | 5353 | 178 | — |

---

## 2. 数据面标准（音频 RTP）

| 指标 | 实测值 | 结论 |
| --- | --- | --- |
| 编码 | ALAC，每包 **352 帧** | 固定块长 |
| 包间隔 | 352 / 44100 = **7.982 ms** | ≈8 ms |
| 稳态包速 | 300,758 包 / 2,399.0 s = **125.36 pps**；逐曲 125.3 pps；按墙钟秒中位数 125 | 理论 125.8 pps |
| RTP seq | 300,757 次相邻比较，**0 次非 +1** | 跨 7 次自动换歌 + 17 次手动操作严格 +1，从不重置 |
| RTP ts | 每包 **+352**；非 +352 仅出现在手动操作后（见 §5） | 稳态严格线性 |
| 载荷字节 | 149 – 1,376，p50 932，均值 918 | 内容相关，非固定 |
| 到达间隔 | p99 9.0 ms，稳态 max 134.5 ms（唯一一次 seek） | 无抖动问题 |
| SSRC | `0xd3537fa0` | 全程会话不变，重锚后也不变 |
| 重传 | 基线 75 次 / 40 min；操作期间 1302 次 / 80 s | 稳态极低，重锚后成阵发 |

**重传报文格式（实测）**

```
请求（设备 → MA，8 字节）: 80 d5 00 01 | seq(2) | count(2，通常 0001)
响应（MA → 设备，约 1002–1032 字节）: 80 d6 00 01 8060 | seq(2) | ... | ssrc=d3537fa0 | 原音频载荷
```

> 结论：**seq 必须跨曲继续 +1**，ts 在稳态必须严格 +352；曲目切换与手动操作都不允许 seq 重置或换 SSRC。

---

## 3. 时序面标准（RAOP sync / 设备缓冲）

| 指标 | 实测值 |
| --- | --- |
| sync 包 | PT 84，20 字节，**≈1.0 Hz**（采集 A 2,385 个 / 2,400 s，每分钟 59–61 个；采集 B 860 个 / 866 s） |
| 缓冲深度 | `ts_head − ts_player = **88,200 帧 = 2.000 s**`；采集 A 2,385 个、采集 B 860 个，**min = p50 = max 全部精确相等** |
| 缓冲稳定性 | 17 次手动重锚、7 次自动换歌后仍恒为 88,200 帧，**无漂移** |
| NTP 字段 | NTP_hi 直接是 **Unix 纪元秒**（如 1793449601 ↔ 20:26:41），非 1900 纪元偏移 |
| head 与 sync 一致性 | `audio_head_at_sync − ts_player` p50 = **1.992 s**（2 s 缓冲的实际兑现） |

**sync 报文布局（实测）**

```
0x80 0xd4 0x00 0x07   (4B 伪 RTP 头，无 seq、无 SSRC)
ts_player             (4B, RTP 时钟，设备应播放的位置)
NTP_hi                (4B, Unix 秒)
NTP_lo                (4B, 小数部分)
ts_head               (4B, 发送端已发出的最新音频帧位置)
```

**关键判据**：`ts_head − ts_player ≡ 88,200 帧`，且恒定不漂移——这是"发送端领先设备 2 s"的唯一标准。

---

## 4. 正常自动换歌标准

逐曲统计（`bounds` 取自 MA `library.db` playlog：`start = timestamp − seconds_played`）：

| 曲目 | 时长 | 包数 | pps | ≥20ms 中断 | 缓冲 p50 | 起始偏差 | 结束偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 字里行间（胡夏） | 275.0 s | 34,453 | 125.3 | 0 | 2.000 s | 8 ms | 1 ms |
| Crazy Bird（Wild Child） | 231.0 s | 28,940 | 125.3 | 0 | 2.000 s | 8 ms | 5 ms |
| how love sounds（Ku Plag） | 210.0 s | 26,309 | 125.3 | 0 | 2.000 s | 7 ms | 6 ms |
| 如果我说我愿意等呢（苏天伦） | 238.0 s | 29,818 | 125.3 | 0 | 2.000 s | 4 ms | 0 ms |
| 唱起这首歌（刘人语） | 205.0 s | 25,683 | 125.3 | 0 | 2.000 s | 2 ms | 7 ms |
| 冬（好妹妹乐队） | 246.0 s | 30,820 | 125.3 | 0 | 2.000 s | 2 ms | 5 ms |
| One And Only（Adele） | 353.0 s | 44,225 | 125.3 | 0 | 2.000 s | 6 ms | 4 ms |

（另有 3 首为入抓前开播 / 出抓后未播完的片段：Control 143.8 s、有我呢 390.4 s、向阳花 243.3 s，不计入完整样本。）

**正常自动换歌的判定标准**（采集 A 7 首 + 采集 B 3 首，共 10 次全部满足）

1. **零中断**：换歌前后音频到达间隔最大 ≤ 8 ms（首尾偏差 0–8 ms），不出现 ≥20 ms 空档。
2. **零重置**：RTP seq 继续 +1、RTP ts 继续 +352，无任何时间轴改写。
3. **无 FLUSH / RECORD**：自动排队推进时不发 FLUSH，也不重发 RECORD。
4. **元数据先行**：新曲元数据经 4515 `SET_PARAMETER`（DMAP `minm/asar/asal`）下发，相对音频边界 **−0.5 ~ +1.1 s**；随后约 +0.3 s 再发一条 `progress:`。
5. **缓冲不动**：换歌全程 `ts_head − ts_player` 仍为 88,200 帧。

> 这是 MA 与 MusicFlow 最容易做错的一条：**"换歌"不等于"重锚"**。自动切下一曲是纯粹的「内容替换」，时间轴完全连续。

---

## 5. 手动操作标准（下一首 / 上一首 / 进度跳转）

采集 B 的人工触发窗口为 `t = +760.9 ~ +831.6 s`（相对 t0 = 21:38:18.87；即 21:50:59 – 21:52:10，约 71 s 内连续操作）。窗口内共 **17 次 FLUSH、0 次 RECORD**，全部一一对应音频流的一次中断。

### 5.1 逐事件实测（17 次）

`t` 为相对 t0 秒数；「ts 回拨」为恢复首包相对中断前末包的 RTP ts 差值（负值表示时间轴回退）。

| # | t(s) | 类型 | 新曲目（元数据） | 中断(ms) | seq 增量 | ts 回拨(帧) | 回拨(秒) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 761.2 | 曲目切换 | Wild / Monogem | 117.0 | +1 | −71,740 | −1.627 |
| 2 | 766.4 | 曲目切换 | Movin' Me On / Eliane Elias | 156.3 | +1 | −70,017 | −1.588 |
| 3 | 772.2 | 曲目切换 | 过客 / 四熹丸子 | 127.6 | +1 | −71,491 | −1.621 |
| 4 | 776.5 | 曲目切换 | Movin' Me On / Eliane Elias | 54.5 | +1 | −74,496 | −1.689 |
| 5 | 779.8 | 曲目切换 | Wild / Monogem | 62.4 | +1 | −74,166 | −1.682 |
| 6 | 784.9 | 曲目切换 | Movin' Me On / Eliane Elias | 48.3 | +1 | −74,770 | −1.695 |
| 7 | 787.6 | 曲目切换 | 过客 / 四熹丸子 | 63.8 | +1 | −74,098 | −1.680 |
| 8 | 793.3 | 曲目切换 | 怎么爱都爱不够 (DJ何鹏版) | 104.3 | +1 | −72,332 | −1.640 |
| 9 | 799.4 | 曲内跳转 | — | 53.6 | +1 | −74,550 | −1.690 |
| 10 | 803.7 | 曲内跳转 | — | 104.9 | +1 | −72,255 | −1.638 |
| 11 | 806.6 | 曲内跳转 | — | 84.6 | +1 | −73,272 | −1.661 |
| 12 | 809.8 | 曲内跳转 | — | 59.2 | +1 | −74,305 | −1.684 |
| 13 | 812.1 | 曲内跳转 | — | 120.0 | +1 | −71,620 | −1.624 |
| 14 | 819.1 | 曲内跳转 | — | 119.5 | +1 | −71,683 | −1.626 |
| 15 | 826.4 | 曲内跳转 | — | 53.5 | +1 | −74,560 | −1.690 |
| 16 | 829.4 | 曲内跳转 | — | 86.1 | +1 | −73,178 | −1.659 |
| 17 | 831.6 | 曲内跳转 | — | 75.2 | +1 | −73,605 | −1.669 |

汇总：中断 **48.3 – 156.3 ms，p50 ≈ 84.6 ms**；ts 回拨 **70,017 – 74,770 帧（1.588 – 1.695 s），p50 73,272 帧（1.662 s）**；seq 全部 +1；SSRC 不变；sync 水位全程 88,200 帧。

### 5.2 标准签名

**A. 用户触发下一首 / 上一首**

1. 4515 上先发一次 **`FLUSH`**（仅 FLUSH，**不重发 RECORD**、不断 TCP 连接、不换 SSRC）
2. 0 ~ 5 ms 后音频流开始中断，中断时长 **48–160 ms（p50 ≈ 85 ms）**
3. FLUSH 后 0.1–0.2 s 发新曲 `SET_PARAMETER`（DMAP 元数据），再约 +0.3 s 发 `progress:`
4. 恢复后 **seq 继续 +1**（不重置），**ts 回拨约 1.66 s**（1.588–1.695 s）
5. `ts_head − ts_player` 仍为 88,200 帧，缓冲深度不变

**B. 曲内进度跳转（前跳 / 后跳 / 拖动）**

1. 同样一次 **`FLUSH`**，无新曲元数据
2. 中断 **48–160 ms**，seq +1，ts 回拨约 1.66 s
3. 紧随一条 `progress:`（见 5.3）

> **A 与 B 在数据面的签名完全相同**，唯一区别是 A 会在 FLUSH 后追加一条新曲 DMAP 元数据。也就是说：**曲目切换与跳转都靠同一条通路（FLUSH + 同流续传）实现，不存在第二条控制通路**。

### 5.3 `progress:` 三元组

```
progress: A/B/C            （三个 32 位 RTP 时间戳）
实测：C − A = 曲目时长 × 44,100（如 266 s 曲目恒等于 11,730,600 帧）
      B − A = 当前播放位置（正常曲目起点 ≈ 44,100 帧 = 1.000 s）
```

17 次操作 + 10 次自动换歌中，`C − A ≡ 曲目时长` 全部成立；`B − A` 随跳转目标变化（本次 26 s – 247 s 之间摆动）。`A` 是**当前锚点下的曲目起点**，每次重锚会随之平移，不能当作固定常量。

### 5.4 重锚引发的重传风暴

| 窗口 | 重传请求数 |
| --- | --- |
| 稳态（采集 A，40 min） | 75（≈0.03/s） |
| 重锚窗口（采集 B，t=760–830 s / 80 s） | 1,302（≈16/s） |

按 10 s 分桶：184 / 98 / 239 / 76 / 232 / 187 / 201 / 83，与 17 次 FLUSH 高度重合。结论：**每次重锚都会触发设备一段重传请求潮**（设备在补齐被 flush 掉/重排的包），属 MA 的正常表现，不是故障；但 MusicFlow 若在重锚后立刻又重锚，会叠加成更大的重传与中断。

### 5.5 明确禁止的做法（对照实测）

| 做法 | MA 实测 |
| --- | --- |
| 重锚时重置 seq / 换 SSRC | **从不发生**，seq 恒 +1、SSRC 恒 `0xd3537fa0` |
| 重锚时重建会话（TEARDOWN/SETUP/RECORD） | **从不发生**，同一条流续传 |
| 重锚时改变 2 s 缓冲深度 | **从不发生**，88,200 帧恒定 |
| 连续操作时合并为一次重锚 | **不合并**，17 次操作 = 17 次 FLUSH = 17 次中断 |

> 最后一条很重要：MA 不会把用户的连续操作"攒起来"，每次操作各付一次 48–160 ms 的中断。MusicFlow 不必也不应该为了"看起来更平滑"而吞掉用户操作。

---

## 6. 与 MusicFlow（v4.10.7）当前实现的差异

| 维度 | MA 基线（标准） | MusicFlow 4.10.7 现状 | 差距 |
| --- | --- | --- | --- |
| 块长 | 352 帧 / 7.982 ms | `CHUNK_LEN=352` | 一致 |
| 自动换歌 | 不 FLUSH、不 RECORD、seq/ts 连续 | 每个 `track` 边界 `explicitReanchor` → **FLUSH + RECORD** | **P1 偏离（最严重）** |
| 手动操作 | FLUSH + 同流续传（seq +1、ts 回拨 ~1.66 s） | `explicitReanchor` 与自动换歌共用同一路径 | 需拆分语义 |
| 设备缓冲 | `ts_head − ts_player = 2.000 s` 恒定 | `latencyFrames` 默认 1 s（`MF_BRIDGE_RAOP_HOLD_MS=1000`） | **P0 偏离** |
| 投递前瞻 | 稳态 2 s | bulk 回填最多 6 s（`BRIDGE_BACKFILL_MAX_US=6s`），队列硬顶 8 s | **P2 偏离** |
| sync 频率 | 1.0 Hz | `sendSync` 布局一致，频率待实测 | P3 待验 |
| sync 布局 | `80 d4 0007 | ts_player | NTP(unix) | ts_head` | `raop.ts` 偏移 4/8/16 一致 | 一致 |
| 重锚后 seq | +1 | 未知（RECORD 后 seq 通常归零） | 必须实测 |

---

## 7. 对标校正项

| 优先级 | 校正项 | 目标 |
| --- | --- | --- |
| **P0** | `MF_BRIDGE_RAOP_HOLD_MS` 默认 1000 → **2000**，使 `ts_head − ts_player ≡ 88,200 帧` | 与 MA 一致的 2 s 缓冲 |
| **P1** | **自动换歌不得重锚**：`track` 边界只做内容替换，保持 seq/ts 连续、不发 FLUSH/RECORD | 换歌零中断 |
| **P1b** | 重锚只允许用户发起的 seek / next / prev 触发，且 **只发 FLUSH、不重发 RECORD**、不换 SSRC、不重置 seq | 与 MA 签名一致 |
| **P2** | 取消 6 s bulk 灌注，稳态按 **2 s lookahead** 投递；8 s 上限仅作安全阀 | 不超前拉长设备缓冲 |
| **P3** | sync 以 **1.0 Hz** 定量发送，`ts_head − ts_player` 恒定不漂移 | 时序面达标 |

**重锚实现要求**（若保留 FLUSH 路径）：ts 回拨量取 **1.6–1.7 s**（对齐设备缓冲的再填充），中断应落在 **≤160 ms**；重锚后 `ts_head − ts_player` 必须回到 88,200 帧。

---

## 8. 验收判据（抓包可直接量化）

**稳态**

1. `seq non+1 = 0`、`ts non+352 = 0`
2. `ts_head − ts_player`：min = p50 = max = 88,200 帧
3. 音频 gap ≥20 ms 计数 = 0
4. 4515 上 `FLUSH` = 0、`RECORD` = 0

**自动换歌**（同上 1–4 全部保持）

5. 曲目边界音频首尾偏差 ≤ 10 ms
6. 元数据相对音频边界 −0.5 ~ +1.1 s 内到达

**手动操作**

7. 每次操作恰 1 次 `FLUSH`，`FLUSH → 首包` ≤ 160 ms
8. 操作后 seq 继续 +1、SSRC 不变、无 `RECORD`
9. 重锚后 `ts_head − ts_player` 仍 = 88,200 帧
10. 连续 N 次操作 = N 次中断，不被合并、不被吞掉

---

## 附录：采集与分析命令

```sh
# 采集（240）
tcpdump -i eno1-ovs -U -n -s 0 -C 100 -W 20 -w /tmp/mfop/op_<ts>.pcap 'host 192.168.10.30'

# 合并 tcpdump 切片
python3 merge_pcap.py /tmp/full.pcap op_*.pcap00 op_*.pcap01
# 逐曲/逐边界统计（可选 bounds）
python3 ap_boundary.py /tmp/full.pcap /tmp/bounds_full.txt
# 节奏 + sync 水位
python3 ap_timing.py /tmp/full.pcap
# 通道清单
python3 ap_analyze.py /tmp/full.pcap
# 控制面（RTSP 方法 / 元数据 / progress）
python3 ap_ctrl.py /tmp/full.pcap
# 操作事件关联（FLUSH ↔ 中断 ↔ ts 回拨）
python3 ap_ops.py /tmp/full.pcap
# 由 library.db playlog 生成 bounds：<start> <end> <曲名>
python3 make_bounds.py /vol1/1000/SSD/docker/mass/data/library.db
```

---

## 附录 B：MusicFlow 实测（2026-11-01，240 生产容器 → HiVi H5MKII）

场景：单机伪组 `__bridge_solo:00226CFFA0C0`，240 `musicflow` 容器 → HiVi（192.168.10.30，AP1），
195 s 抓包 + 驱动脚本 `val_run.py`（Phase A 自动换歌 ×3、Phase B 手动 next ×5 / prev ×5、Phase C 手动后紧跟自动）。

| 判据（§8） | 实测 | 结论 |
| --- | --- | --- |
| 自动换歌 `FLUSH = 0` / `RECORD = 0` | 3 次真实自动推进（0→1、1→2、2→3）区间内 4515 上 `FLUSH = 0`、`RECORD = 0` | ✅ |
| 手动 next/prev 恰 1 次 `FLUSH` | 每次操作 1 条 `FLUSH`（抓包中同 `cseq` 连发 4 段属 TCP 重传，非重复请求） | ✅ |
| 手动后 ts 回拨 1.588–1.695 s | 日志 8/8 条 `bridge manual rewind: -73216 frames (1.660 s)`；抓包 `dts` 回拨包 −72,864 帧（≈1.652 s） | ✅（两者差 2 包，回拨量按 352 帧对齐） |
| `seq non+1 = 0` / `ts non+352 = 0` | 每个 SSRC 内 `dseq` 全 1；`dts` 主体 352，仅手动回拨处出现一次大负值；无 SEQ GAP、无乱序重传 | ✅ |
| `SSRC` 全会话不变 / 单一会话 | 195 s 内出现 **3 个 SSRC = 3 个 RAOP 会话**（首会话 +50 s 后断开，重建两次） | ❌ |
| 自动换歌曲目边界 ≤10 ms / `gap ≥20 ms = 0` | 未逐边界量化（P2 泵侧预解码未做，`pump.stop()` 仍在换曲瞬间释放音频） | 未测 |

**本轮修掉的根因（P1 结构性）**：`sendspin/server.ts` 的 `canKeepStream()` 在 `members.size === 0` 时恒返回
`false` —— 纯桥组（单机伪组 / 纯 AirPlay 组）没有 sendspin 成员，于是每次换曲都走 `finishPlayback()`
⇒ 桥收到 `BOUNDARY{stop}` ⇒ `RaopPlayer.flush()`。日志形状是 `track(新代次)` 前每条都先来一条
`stop(旧代次)`（同一 generation），实测 `FLUSH = 32`。改为「有桥则按 keep_stream 走 `clear`」后，
同一驱动下 `FLUSH` 降至 13（且自动换歌段为 0），`stop` 边界从日志中完全消失。

**仍未达标（按优先级）**：

1. **会话稳定性**：`+60.8 s` 会话断开，日志链为
   `[raop-loss] req≈100/miss≈100/future≈100/backlog→2048` →
   `[Sendspin] bridge link live→stalled (closed)` → `[AirPlay] bridge session 断开 reason=closed`；
   同期 `[PlayerController][optimistic] 阶段2 超时 → stalled` 与 `[QueueController][idle_early] 复查确认已停,放行切歌`
   反复出现（桥设备无状态回传，乐观起播必然超时）。断开后 44 s 无会话，直到下一次手动 next 才 `prepare` 新会话。
   ⇒ 需单独排查 `raop-loss` 全 future 请求 + 乐观起播判死这两条既有路径（与本次 keep_stream 改动无关：改动前同样 3 会话）。
2. **会话开场多一条 FLUSH**：每个新会话仍为 `ANNOUNCE→SETUP→RECORD→SET_PARAMETER→FLUSH(cseq=5)`，
   `RECORD` 后紧跟一次 `FLUSH`，基线未要求（当前只在「新会话建立」时出现，稳态不出现）。
3. **P2 未做**：`pump.stop()` 仍在换曲瞬间丢弃已解码音频，边界空档与曲目首尾衔接（≤10 ms）无判据支撑。

### 附录 B.2：会话稳定修复后复验（2026-11-01 17:36Z 起）

容器 `StartedAt 2026-10-31T17:36:38Z`（含两处修复）；两段抓包：
`/tmp/p4.pcap`（`val_run.py`：Phase A seek+自动换歌 ×5、Phase B next/prev ×10、Phase C next+自动）与
`/tmp/n1.pcap`（`val_nat.py`：**无 seek** 的自然曲末换歌 ×2）。

根因与修复：

1. **桥路由对账不认识单机伪组**：`group/protocolPlayer.ts` 的 `reconcileBridgeRoutesOnce()` 只以
   `activeBridgeRoutes`（用户组）为事实源；单机伪组 `__bridge_solo:<deviceId>` 的登记在
   `airplay/protocolPlayer.ts` 的 `soloBridgeRoutes`。于是单机桥被判孤儿，宽限
   `BRIDGE_RECONCILE_GRACE_MS = 55 s`（周期 60 s）后每 ~60 s 摘一次**正在播**的会话。
   实测（旧容器）：`17:16:17.336 bridge link live→idle` → `17:16:17.337 对账摘除孤儿句柄
   side=sendspin … detached=true` → `17:16:17.347 bridge session 断开 reason=closed` →
   `sessions: stop token=… sessions=0` → 泵空转 `编码器疑似失效`。修复：导出
   `listSoloBridgeRoutes()` 并并入 `wantedDevices/wantedTokens`。
2. **乐观窗口必然超时**：桥 `pollState()` 直接透传 sendspin 泵的 `BUFFERING`（泵侧
   `audibleStarted` 要越过 lead 4.5 s + sendAhead 800 ms 才置位），`PlayerController.armOptimisticTimeout()`
   5 s 等 `PLAYING` 必超时 ⇒ `stalled` ⇒ `QueueController` 重投/切歌，连续 3 首触发
   `STALL_SKIP_LIMIT` 熔断停流。修复：桥边界把 `BUFFERING` 归一为 `PLAYING`（对齐 MA「推流一起来即 PLAYING」）。

复验结果：

| 判据（§8） | 实测 | 结论 |
| --- | --- | --- |
| 自动换歌 `FLUSH = 0` / `RECORD = 0` | `n1`：自然 0→1→2 全程 `FLUSH = 0`、`RECORD = 0` | ✅ |
| 自动换歌 `seq 连续 +1` / `ts 连续 +352` | `n1`：单 SSRC `10e8fd25`、`dseq` 14,485/14,485 全 +1、`dts` **14,485/14,485 全 +352**、无 SEQ GAP | ✅ |
| 单一会话 | `n1`：`ANNOUNCE=1/SETUP=1/RECORD=1`（`TEARDOWN=1` 来自用例开头 reset，预期） | ✅ |
| 手动 next/prev 恰 1 次 `FLUSH` + ts 回拨 | `p4`：11 次操作 → `FLUSH=11`；回拨包 **−72,864 帧（1.652 s）**，日志 11/11 `-73216 frames (1.660 s)` | ✅ |
| 会话不中断 | 17:36:38 之后 `对账摘除孤儿` / `session 断开` / `sessions: stop` / `阶段2 超时` / `编码器疑似失效` = **0** | ✅ |

**本轮新发现的已知偏差（记入 P2，不在本轮范围）**：

1. `p4` 中「seek 到曲末(189 s) → 自动换歌」后出现 **+2.1–3.0 s 的 ts 前跳**
   （`dts` 事件 +100,556 / +92,000 / +97,892 / +105,252 / +102,698 / +130,302 帧），
   日志伴随 `staleFrames≈276k` 与 `pacing rebase: +2,978,522µs`；**纯自然换歌（`n1`）无此现象**。
   判定为 seek 重锚路径遗留：seek 丢弃 stale 内容后 RTP 映射未同步回拨，到下一次曲目边界才体现为前跳。
2. 重启后首次建桥偶发 `ANNOUNCE 200 → read ECONNRESET`（17:37:58.874），触发一次
   `stall-reinvest`，0.6 s 内重试成功；疑为设备侧残留旧会话（前一次容器被直接重启，未发 TEARDOWN）。

