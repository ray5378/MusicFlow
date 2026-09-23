# 播放卡顿多线程容器监控方法（240 实战沉淀）

> 适用：MusicFlow 单容器（主进程 + sendspin 子进程 + 按需 ffmpeg）在真实设备上播放时的卡顿定位。
> 本文是三支脚本的**方法论手册**：抓什么、怎么判、盲区在哪、复现时按什么顺序看。
> 脚本在 `scripts/`，跑在 **240 本机**（非开发机）。

## 1. 为什么要「多线程 / 多进程」分开盯

容器内同时活着：

| 进程 | 角色 | 卡顿相关性 |
|---|---|---|
| 主进程 `dist/index` | HTTP/WS、队列、决策、poll 上报 | 事件循环堵 → poll 慢、决策慢，**不直接断推流** |
| 子进程 `sendspin/child` | 25ms 推流循环、编码、WS 推帧 | **推流节奏唯一权威**；堵/崩 → 全组同时卡 |
| `ffmpeg`（1..N） | 滑动窗口解码 PCM | 起播/切歌时出现；长驻尖峰 = 窗口在灌 |

单看容器总 CPU 会把三者搅在一起。必须 **分进程 RSS/CPU + 服务端事件 + 位置轨迹** 三条线对齐同一时间轴。

## 2. 三支脚本

| 脚本 | 采样 | 产出 | 用途 |
|---|---|---|---|
| `sendspin-monitor-240.sh` | 5s | `monitor.csv` + `events.log` | **主监控**：资源 + 卡顿指纹 + STALL |
| `sendspin-hires-240.sh` | 1s | `highs.csv` | 瞬时 CPU 尖峰归因（谁烧的） |
| `pull-240-monitor.sh` | 本地循环 | `logs/monitor-240/*` | 开发机拉回结果（gitignored） |

### 2.1 部署与启停（240）

```bash
# 部署（从开发机）
scp -i /root/mykey -P 35320 scripts/sendspin-monitor-240.sh \
  scripts/sendspin-hires-240.sh scripts/pull-240-monitor.sh \
  root@192.168.10.240:/root/sendspin-monitor/

# 常驻
ssh -i /root/mykey -p 35320 root@192.168.10.240
cd /root/sendspin-monitor
nohup ./sendspin-monitor-240.sh >/root/sendspin-monitor/monitor.out 2>&1 &
nohup ./sendspin-hires-240.sh  >/root/sendspin-monitor/hires.out  2>&1 &

# 停止
pkill -f sendspin-monitor-240.sh
pkill -f sendspin-hires-240.sh

# 冒烟
./sendspin-monitor-240.sh --once
```

### 2.2 本地拉回

```bash
./scripts/pull-240-monitor.sh --once          # 拉一次
INTERVAL=120 ./scripts/pull-240-monitor.sh    # 每 2 分钟
```

产物：`logs/monitor-240/{monitor.csv,events.log,deadlink.log}`。

> ⚠️ 远端 monitor 脚本可能带 `LAST_TS` 等热修补丁，与仓库版不完全一致时以 **240 上正在跑的那份** 为准；回传分析后再考虑是否回合仓库。

## 3. 判读：事件类型

### 3.1 ALERT（出现即真问题）

写入 `events.log` 的 `[ALERT][TYPE]` 行：

| TYPE | 含义 | 下一步 |
|---|---|---|
| `STALL` | PLAYING 但 position 连续 3×5s 不动 | 服务端推流/上报停了；查 child 是否堵死 |
| `ENCSTALL` | 连续约 500ms 编码零产出 | 编码/取帧；查窗口 WINEOF、游标 |
| `PUSHBREAK` | pushFrame 中断 | 推流循环异常；看 child 之后是否重启 |
| `CURSORLAG` | 游标落后窗口基准 | seek/窗口赶不上；查 rawStream / -ss |
| `LOOPLAG` / `LOOPDEATH` | 事件循环延迟 / 心跳死 | 主进程或 child 饿死；查同步 IO、看门狗杀进程 |
| `LINKDOWN` | 连续 3 轮拿不到设备状态 | 链路上报断；分不清网络 vs 设备停 |
| `GROUPSPLIT` | 成员被显式脱组/转移 | 不是网络卡，是控制面拆组 |

### 3.2 普通事件（要频率，不单看有无）

| TYPE | 含义 |
|---|---|
| `TRACK` | 正常切歌（pos 回零且 &lt;6s）—— **不要当卡顿** |
| `REWIND` | 播放中位置后退 &gt;5s 且非切歌 → 疑似重缓冲 |
| `STREAMFLAP` | stream/start·end 频率异常升高 |
| `RECONNECT` | hello/goodbye 重连风暴 |
| `PUSHEXIT` | pushLoop 正常或异常退出（对照是否 `contentEnded=true`） |
| `JUDGE_*` / `PUMP_DEADFAIL` / `SLOWRESOLVE` | 坏源链路，切歌空窗变长 |

### 3.3 CSV 列

`monitor.csv`：

```
ts,cpu_pct,mem_mib,main_rss_mb,child_rss_mb,ffmpeg_n,playing,stall
```

- `stall=1`：本采样窗口内有 STALL/指纹/慢 resolve/LINKDOWN。
- `ffmpeg_n=0` 且 `playing≥1`：曲在 300s 窗内、无在跑 ffmpeg **属正常**（窗口已灌满）。
- 切歌瞬间常见：`stall=1` + 短暂 `playing=0` + 随后 `ffmpeg_n≥1`。

`highs.csv`：`ts,main_cpu,child_cpu,ff_cpu,ff_n,cont_cpu` —— 与 monitor 同时刻对齐，看尖峰归属。

## 4. 标准排查顺序（体感卡一下时）

1. **对时间**：记下用户卡的时刻（到分钟即可）。
2. **events.log**：该时刻前后有无 `ALERT`；有 → 按上表进对应链路。
3. **monitor.csv**：该窗口 `stall`、CPU/RSS、`ffmpeg_n`、`playing`。
4. **容器日志**（与 events 对秒）：

```bash
docker logs --since "2026-09-23T21:33:00" --until "2026-09-23T21:34:00" musicflow 2>&1 \
  | grep -E "WARN|ERROR|contentEnded|advance|pushFrame|编码器|慢请求|resolve\]"
```

5. **位置是否线性**：`[QueueController][poll]` 每 5s 是否 `pos` +5。
6. **宿主压力**（容器外）：

```bash
cat /proc/pressure/{io,cpu,memory}; free -m; uptime; cat /proc/net/softnet_stat
```

IO some/avg10 高、`%wa` 高、内存见底 → 公共路径抖动，先隔离 QEMU/限 IO 再怪应用。
7. **仍全绿但体感卡** → 进入盲区，见 §5。

## 5. 已知盲区（监控全绿 ≠ 没卡）

| 盲区 | 原因 | 补手段 |
|---|---|---|
| **position 不等送达** | `positionMs` 按已 push 帧号推进，不等设备 ACK | 设备串口 `Lost sync`/underrun 对时间戳 |
| **STALL 需要 15s 冻** | 连续 3×5s；1–3s 空洞听感卡但 STALL=0 | 缩短 INTERVAL / 看 STREAMFLAP·REWIND |
| **设备侧 underrun** | 只在 ESPHome 串口，不进容器 | 串口日志与 events 时间轴对齐 |
| **WS 发送缓冲** | Node 发成功 ≠ 网卡已送达 | 宿主 softnet drop/time_squeeze；必要时加 `bufferedAmount` 日志 |
| **双台同时卡** | 独立 WiFi 不会同时；公共路径（child 扇出 / 宿主 / 同交换机） | 查 child 单循环、宿主 PSI、同网段丢包 |

**双设备同时卡的优先假设**：同一 child `pushFrame` 扇出停顿，或宿主网络栈/IO 高压，**不是**两台音箱各自 WiFi。

## 6. 与 DLNA 对照

同机同网下 **DLNA 不卡、Sendspin 卡** ⇒ 问题在 Sendspin 独有路径，不在公共网络/设备：

- Sendspin：**服务端实时 push** + 固定 `sendAhead`（缺省 800ms）+ WS；
- DLNA：**设备拉流** + 自身深缓冲，对宿主抖动不敏感。

对照时仍用同一套 monitor + 容器日志，只切换投送协议。

## 7. 最小回归清单（改推流/窗口/切歌后）

1. `sendspin-monitor-240.sh --once` 有输出；
2. 连续听 ≥2 首跨切歌，events 无 `ALERT`；
3. `monitor.csv` 切歌窗 `stall` 可短暂为 1，中段应回 0；
4. `tsc --noEmit` + 相关 vitest + `check-i18n` 绿；
5. 真机体感验收（服务端全绿仍要听一遍）。
