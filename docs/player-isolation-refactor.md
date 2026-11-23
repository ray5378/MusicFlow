# 播放器隔离改造方案（对齐 Music Assistant）

> 目标：**每台播放器一个隔离子进程**，一台卡死不拖累其他；覆盖所有可入组协议、所有组形态
> （纯 AirPlay 组 / 纯 Sendspin 组 / AirPlay+Sendspin 混合组）。
> 依据源码：MA `music_assistant/providers/airplay/stream.py`（在 230 `/workspace/ma-ref`）。

---

## 1. MA 的真实做法（源码证据）

| 事实 | 证据 |
|---|---|
| **每台 AirPlay 播放器一个 `cliairplay` 子进程** | `providers/airplay/stream.py:327` `self._cli_proc = AsyncProcess(args, stdin=True, stdout=True, stderr=True, name="cliairplay")`；文件头注释：`unified binary. Audio is fed via stdin, commands via a named pipe, status is reported on stderr in normalized [STATUS] format` |
| 音频走 **stdin 管道**，控制走 **命名管道**，状态走 **stderr** | 同上 + `helpers/named_pipe.py` |
| PTP 时钟守护是**全 provider 共享一个**进程 | `providers/airplay/provider.py:837` `cliairplay --ptp-daemon` |
| 组内多播放器 = 多个 `cliairplay` 进程 + 一个同步引擎 | `providers/sendspin/{playback,player,provider}.py` 负责组时间线与分发 |
| MA **没有**「一个进程承载所有播放器」的桥 | `providers/airplay` 全目录无多 player 共享的播放进程 |

结论：MA 的隔离粒度是「**播放器 × 进程**」，同步引擎与播放进程之间只传音频与控制命令。

---

## 2. 我们现在的模型与已暴露的问题

```
PID 1   node dist/index.js                    主进程（组编排/队列/DB）
PID 28  node dist/services/sendspin/child.js  唯一的 sendspin 子进程
PID 46  node dist/services/airplay/child.js   唯一的 airplay 子进程
          └─ BridgeSessionManager（Map<token, BridgeSession>）  ← 所有设备都在这一个进程里
               内容 ring 按**组**共享（recentByGroup）+ 每设备一个投递水位（bridgeWatermarks）
```

实测故障（2026-11-23，同一组同一时刻）：

```
contentFrontier(内容前沿) = now + 48.9s   ← 两台共用同一条环

HiVi   wmVsNow = +45.5s   deliverableMs=3425    → 游标追到前沿 ⇒ 听众侧「突然跳进度」
iEAST  wmVsNow = -7.2s    deliverableMs=35000   → 喂过去的内容 ⇒ late 1.05 万、inQueueMs 恒 0
                                                 ⇒ 静音垫片连垫 19 分钟、秒级卡顿
```

根因不是某个参数：**同一进程同一事件循环里，一个设备的积压/停滞会通过共享环和共享循环
影响另一个设备**；而每设备只有一个水位，落后之后没有独立的重基通道。

---

## 3. 目标架构

```
                  ┌───────────────────────────────────────────┐
                  │ 主进程（组编排）                          │
                  │  groups / queue / anchor / 延迟补偿       │
                  └───────────────┬───────────────────────────┘
                                  │ 控制（JSON-RPC）
                  ┌───────────────▼───────────────────────────┐
                  │ 组内容源（唯一解码点，保持现状的泵）      │
                  │  产出一份带组时间戳的 PCM 流              │
                  └───┬───────────┬───────────┬───────────────┘
        PCM 帧(带 ts) │           │           │
             ┌────────▼──┐  ┌─────▼─────┐  ┌──▼──────────┐
             │ player-1  │  │ player-2  │  │ sendspin-N  │  ← 每个播放器一个子进程
             │ child     │  │ child     │  │ (远端设备)  │
             │ ring+水位 │  │ ring+水位 │  │  网络直发   │
             │ RAOP/AP2  │  │ RAOP/AP2  │  │             │
             └───────────┘  └───────────┘  └─────────────┘
```

要点：

1. **播放器进程只做一件事**：收 PCM（带 ts）→ 自己的 ring/水位/对齐 → 自己的协议发送。
   完全照搬 MA「stdin 喂音频 + 命名管道收命令 + stderr 报状态」的三通道模型。
2. **组内容源仍是单点**（解码一次），保证「同刻同内容」；分发不再是共享 ring，
   而是**每个播放器进程各自的入站队列**（IPC 背压独立）。
3. **隔离效果**：设备 A 卡住 → 只阻塞 A 的管道；A 的子进程有看门狗，超时/崩溃即时重启，
   B 不受影响。
4. **混合组**：Sendspin 属于远端设备，服务端本来就只是 socket 写；它也走同样的
   「每播放器一个投递句柄（进程或任务）+ 独立背压」，与 AirPlay 子进程并列。

---

## 4. IPC 协议草案（airplay 播放器子进程）

复用现有 `rendererHost/childBootstrap` + `supervisor` 的 fork/心跳/退避重启骨架。

父 → 子

| 消息 | 说明 |
|---|---|
| `prepare { deviceId, token, rate, latencyFrames, anchorUs, shiftUs, socketPath }` | 建 RAOP/AP2 会话并用给定锚点起流 |
| `pcm { seq, tsUs, nFrames, data }` | 内容帧（`data` 走共享内存段或 socket 流，不进 JSON） |
| `anchor { anchorUs }` | 换代/重锚 |
| `shift { shiftUs }` | 成员延迟变更（原地 retime） |
| `volume { db }` / `mute { on }` | 音量 |
| `flush { gen }` / `stop` | 切歌/停播 |

子 → 父

| 消息 | 说明 |
|---|---|
| `ready { pid }` | 会话就绪 |
| `status { gen, queueMs, inQueueMs, underruns, late, watermarkUs, state }` | 2s 一次（替代现在的 tick 日志口径） |
| `underrun { ms, reason }` | 饿死事件（父进程据此给该设备单独加 lead，不动别人） |
| `ended { reason }` / `fatal { err }` | 会话结束/崩溃 → 父进程只重建这一台 |

PCM 传输：优先 `cmsg`/共享内存（Node 侧可用 `SharedArrayBuffer` + 环形队列），
兜底走 socket 流 + 固定头（`seq|tsUs|len`），单设备约 3.5 MB/s（48k f32 立体声），可接受。

---

## 5. 分期落地（每期都可单独上线、可回滚）

| 期 | 内容 | 验收 |
|---|---|---|
| **P0** | 抽取 `PlayerHost` 骨架：`playerHost/{supervisor,childBootstrap,ipcProtocol}.ts`，先用假播放器跑通「进程隔离 + 心跳 + 重启」 | 单测：杀掉一个子进程，另一个不受影响；父进程无阻塞 |
| **P1** | AirPlay 播放器迁到**每设备一子进程**（复用 `BridgeSession` 类，ring/水位/对齐全部搬进子进程）；主进程只做组编排与分发 | 2 设备 × 5 首：无跳进度、无静音；杀掉一台的子进程，另一台继续正常 |
| **P2** | 混合组：Sendspin 投递句柄同样独立（远端设备 + 独立背压），AirPlay 子进程与 Sendspin 并列为同层「播放器」 | 纯 AP 组 / 纯 Sendspin 组 / 混合组 各 5 首通过 |
| **P3** | 移除旧的「单 airplay child 承载所有桥」路径与共享 ring 残留 | 全量测试 + 19 条桥守卫 + D4~D9 全部重写为面向新模型 |

回滚：全程用开关 `MF_PLAYER_ISOLATION=1`（默认关 → 打齐 P1 后再翻默认），
旧路径保留到 P3 删除。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| IPC 传输 PCM 引入抖动 | 固定 352 帧块 + 每设备独立缓冲；P0 先压测 8 设备 24h 的丢帧/延迟 |
| 进程数上升（N 设备 = N 进程） | 单进程常驻内存实测约 40~60MB；空闲回收沿用现有 `idleReclaim` |
| 同步精度退化 | 组锚点仍单点计算，子进程只做「按 ts 落位」；保留现有 `check-airplay-bridge` 不变量并新增「每设备水位必须落在 ±lead 内」断言 |
| 现有守卫大量失效 | P3 统一改写，期间旧守卫加 `# legacy` 标注，避免误红 |
| 调试困难 | 每个子进程日志带 `dev=` 前缀；父进程保留 `bridge-window` 等价诊断（per-device 水位/回放） |

---

## 7. 与当前线上问题的关系

今天的两处症状（HiVi 跳进度、iEAST 静音+秒卡）都是「共享环 + 单水位」的下游表现。
P1 完成后，这类互相污染在架构上不再可能：一台设备的落后只影响它自己的管道。

在 P1 上线前，线上继续用已部署的护栏（`bridge-watermark-jump`：水位落后墙钟 >1.5s 直接跳到现在）。
