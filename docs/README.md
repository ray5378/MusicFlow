# MusicFlow 文档库导航（先读这一篇）

> 用途：对全库文档做一句话精简总结 + 场景路由，让后续开发能快速定位「该查哪篇」。
> 覆盖：`docs/` 下全部 65 篇（含 `archive/` 归档 16 篇、`superpowers/` 旧计划 1 篇）+ 仓库根 5 篇，共 70 篇。
> 更新：新增/重命名权威文档时同步改这里的路由表与清单。

## 一、场景路由（按你要干的事直接定位）

| 场景 | 先读 | 再读 |
|---|---|---|
| 想理解系统整体架构 / 目录结构 / 数据库 | `DEVELOPER.md` | `README.md`（根）、`SPEC.md` |
| 改播放、队列、投屏代码前（不可协商的硬约束） | `播放链路与队列流转权威文档-20261114.md` | `airplay-权威方案文档.md`、`sendspin-权威方案文档.md`、`group-权威方案文档.md` |
| 群组切歌 / 组播 / 延迟补偿 | `group-权威方案文档.md` | `群组切歌等待自适应-调研与方案-2026-11-02.md` |
| AirPlay 桥接实现 / 走桥语义 | `airplay-权威方案文档.md` | `AirPlay1-2与Sendspin桥接-最终实施方案.md`、`AirPlay全量强制走桥-对齐方案-2026-10-31.md` |
| Sendspin 设备 / 协议 / 真机联调 | `sendspin-权威方案文档.md` | `播放器链路调试与模拟播放器验收手册.md` |
| 进度跳转 / 位置回跳 / 换源 | `PLAYBACK_SEEK_MA_REWORK.md` | `PLAYBACK_SEEK_OPTIMIZATION.md`、`SOURCE_SWAP.md`、`PRE_PROBE.md` |
| 曲中失声 / 静音 / 曲末空洞（判定与取证） | `曲中静音与曲末空洞-判定全流程-20261126.md` | `播放链路排障与采样手册.md`、`曲中失声-抓包取证方法论与复盘-2026-10-31.md` |
| 现场排障、采样、看判据 | `播放链路排障与采样手册.md` | `播放基线-基准值与判读-20261126.md`、`播放监控-多维度监控台使用手册.md` |
| 容器 CPU / 内存 / 卡顿 | `容器排查采样方法手册.md` | `STALL_MONITORING.md`、`memory-optimization-plan.md` |
| 写插件 / 沙箱能力 / 能力白名单 | `PLUGIN_DEV.md` | `PLUGIN_ARCHITECTURE.md`、`sandbox-limits-and-plan.md` |
| 发版（全系列仓库） | `RELEASE_POLICY.md` | 根 `CHANGELOG.md`、各仓 CHANGELOG |
| 已知工程缺陷台账 | `KNOWN_ISSUES.md` | 根 `AUDIT.md`（UI/UX 类） |
| 查历史方案「当时为什么这么判断」 | `archive/README.md` | `archive/` 对应文件（内容一律可能过期，不作事实来源） |
| 看 AI 会话记录 | `OPENCODE_SESSION_HOWTO.md` | — |

## 二、权威文档（事实来源，改代码前必读）

| 文档 | 一句话总结 |
|---|---|
| `播放链路与队列流转权威文档-20261114.md` | 全链路总入口 / 唯一事实源：三条时间轴、队列数据模型、逐链路流转矩阵、失败自愈、对外接口与验收口径。 |
| `airplay-权威方案文档.md` | AirPlay(RAOP) 方案与验收：模块/进程模型、状态归属排障第一原则、发现→RTSP→推送全链路、桥接最终口径。 |
| `sendspin-权威方案文档.md` | Sendspin 权威模型：服务端职责、端口分工、握手/字节级事实、时钟同步、组与队列、配对与 1.0.0-rc1 结论反转。 |
| `group-权威方案文档.md` | 群组方案：数据模型、状态机、选歌硬约束（用户锁定）、出流双路、时间基准、按成员延迟补偿。 |
| `DEVELOPER.md` | 架构与开发指南：技术栈、后端/前端目录、关键数据流、37 张表、鉴权体系、常见任务速查、环境变量。 |
| `API.md` | API 参考：四种鉴权、原生 `/rest/api/v1/*`、OpenSubsonic `/rest/*`、WebSocket `/ws`、调用示例。 |
| `SPEC.md`（根） | 工程规范总集：编码/日志格式铁律（等级前置 `[LEVEL] [PREFIX]`）、catch 分级、测试与守卫纪律。 |

## 三、排障与采样方法论

| 文档 | 一句话总结 |
|---|---|
| `播放链路排障与采样手册.md` | ★总手册：一分钟决策树、三条采样面与工具、断粮三步定位、接续四级判据、故障指纹、口径铁律、已证伪方向。 |
| `播放基线-基准值与判读-20261126.md` | A 层播放侧基线：三条命令、基准指标集、阈值推导、三版本对照、判读流程（部署后必跑 baseline_guard）。 |
| `播放监控-多维度监控台使用手册.md` | 九维度互不重叠采集 + 判定码表 + 四个典型剧本，纠正「单一信号当判据」的误判。 |
| `容器排查采样方法手册.md` | 240 容器实战：CPU 尖峰定位、长周期两粒度采样、在线 profile、产物归档与排查纪律。 |
| `STALL_MONITORING.md` | 卡顿多线程容器监控：多进程分开盯、三支脚本、事件判读、标准排查顺序、盲区（全绿≠没卡）。 |
| `曲中失声-抓包取证方法论与复盘-2026-10-31.md` | pcap 取证方法论：误判时间线（五个假说的生灭）、工具箱、伪证陷阱、关键数字、验收判据。 |
| `曲中静音与曲末空洞-判定全流程-20261126.md` | ★★ 同一听感五个独立缺陷（D1/D2/D3/D5）分开判分开修、观测口径、可复现采集、十条硬判据、误判清单。 |
| `MA-AirPlay-完整数据标准-2026-10-31.md` | 对 HiVi 实测的 MA→AirPlay 数据标准：拓扑抓包、RTP 数据面、时序面、自动换歌/手动操作、可量化验收判据。 |
| `播放器链路调试与模拟播放器验收手册.md` | 两代测试床（230 协议模拟器 / 240 AP2 床）+ 双端对账，证明设备真出声（服务端 `/status` 不作数）。 |
| `examples/start_capture.example.sh` | 脱敏的常驻环形 pcap 启动模板（start/stop/status），配合排障手册 §1.5 使用，非常驻服务。 |
| `examples/baseline_sampler.example.py` | 脱敏的基线状态采样器示例，配合播放基线判读文档使用。 |

## 四、播放链路 / 队列专题

| 文档 | 一句话总结 |
|---|---|
| `PLAYBACK_SEEK_MA_REWORK.md` | seek MA 化：四类真机故障同根因（在流里挪指针 vs 用新起点重建流）、四层改造、已落地 patch 1~8、验收矩阵。 |
| `PLAYBACK_SEEK_OPTIMIZATION.md` | 跳转进度优化：三段独立开销实测、候选 A~F、A/B 已落地，DLNA/Web/客户端/AirPlay 四链路对照。 |
| `SOURCE_SWAP.md` | 换源匹配规则：触发条件、歌名严格全串对齐、歌手规则、候选排序与探测、代码位置与测试。 |
| `PRE_PROBE.md` | 服务端预探测：三链路共用判定、写入/读取点、触发时机、洗牌序物化要求、`/stream/probe` 契约。 |
| `播放与队列接口复核报告-20261108.md` | 新旧栈接口族复核：POST /play、队列读写、播放模式、preProbe 差异、补测与未测项。 |

## 五、桥接 / AirPlay / Sendspin 方案与复盘

| 文档 | 一句话总结 |
|---|---|
| `桥投递窗口水位死锁-根因与修复-2026-10-31.md` | 曲中失声总根因：投递窗口水位死锁的证据链、根因、v4.10.7 修复、验收判据与未闭环。 |
| `桥时间线复位-旧流并行与pacing错位-方案-2026-11-19.md` | 旧流/新流并行导致 pacing 错位：现场数据、v4.14.13 修法、真机验证、二次否决记录（已闭环）。 |
| `AirPlay1-2与Sendspin桥接-最终实施方案.md` | 开发执行版：决策定案、四条不可省推导、切歌预取硬约束、P0~P8 阶段表、验收判据索引。 |
| `AirPlay1-2与Sendspin桥接落地方案.md` | 落地调研版：调研来源、MA 侧参照、三条病根、失败排查路径、风险遗留、权威坐标索引。 |
| `AirPlay全量强制走桥-对齐方案-2026-10-31.md` | 全设备强制走 cliairplay+桥：范围钉死、现状盘点、单一出口目标架构、逐项对齐 MA、分期实施与回退。 |
| `AirPlay排障总手册-监控与取证-2026-10-31.md` | AirPlay 排障总入口：文档路由表、六步标准流程、实战回放、铁律速查、判据状态指针。 |
| `AirPlay播放中断-根因排查与已排除方向.md` | 中断根因台账：症状分层、逐轮排查、被真机否决方向（勿再试）、6 条硬标准、信号可信度分级。 |
| `群组切歌等待自适应-调研与方案-2026-11-02.md` | 群组中下一首等待时长自适应：现状取证、候选方案、推荐路线、实验矩阵、开关回滚、P3 实测结论。 |
| `按容量投递-设计方案-20261125.md` | 对齐 aiosendspin BufferTracker：按设备宣告容量门控投递，解除倍速 30s 锁死，硬约束与验收判据。 |
| `倍速无缝切换-设计方案-20261125.md` | 桥/Sendspin/群组倍速真无缝：目标语义、核心设计、`-ss` 口径修正、修改点、v4.15.6 已发版验收。 |
| `换歌取源跨进程预热-方案与取证.md` | 自动切歌静音根因=跨进程缓存断层：9.78s 阈值推导、预热下推子进程、负缓存取证日志。 |
| `今日待办-曲中失声与桥投递-2026-10-31.md` | 攻坚当日快照：根因三次演进、当天改动、真机验收时间线、未闭环与验收判据（历史，非现状）。 |

## 六、架构 / 进程 / 性能 / 客户端

| 文档 | 一句话总结 |
|---|---|
| `PROCESS_MODEL_AND_ISOLATION_PLAN.md` | 进程模型实测清单、分类处置标准、通用常驻渲染器子进程宿主、路线图、门禁覆盖（行号快照刻意不校正）。 |
| `player-isolation-refactor.md` | 每台播放器一个隔离子进程（对齐 MA）：MA 源码证据、目标架构、IPC 协议草案、分期落地。 |
| `player-unification-plan.md` | 播放端统一化管理与遥控：术语角色、现状缺口、统一模型、界面设计、推拉流、接口草案、已定规则。 |
| `audio-pipeline-plan.md` | 六段音频流水线对齐 MA 规格：MA 源码实证、逐段设计、决策点、任务清单、验收总口径。 |
| `audio-pipeline-progress.md` | 音频流水线改造唯一权威任务清单：P0~P5 逐项状态、目标（五链路统一实时管道、不留直传旁路）。 |
| `MusicFlow客户端与服务端架构与优化分析报告-2026-10-13.md` | 客户端 v5.8.1 基线架构分析报告：双端分析、链路对照优化、ADR、适应度函数、风险登记。 |
| `memory-optimization-plan.md` | 内存三轮分析收敛结论：前端 RemoteState 离线回收必做、matchJobs 清理与 SongTable 虚拟滚动可选。 |
| `今日待办-HA卡片流转页与拖拽自动滚动-2026-10-22.md` | HA 卡片流转播放页/首页单行切换/拖拽自动滚动需求与完成记录（历史待办快照）。 |

## 七、插件 / 沙箱

| 文档 | 一句话总结 |
|---|---|
| `PLUGIN_DEV.md` | 外置插件开发指南：放置位置、QuickJS 纯 JS、Manifest 字段、能力白名单、格式契约、`host.*` 桥接、安全边界。 |
| `PLUGIN_ARCHITECTURE.md` | 插件化架构：耦合点清单、统一框架、数据模型、统一契约、Phase 0/1 解耦映射、验证方式。 |
| `sandbox-limits-and-plan.md` | 沙箱限制全景审计：capabilities→impl 白名单、限制清单、完整增强方案、版本计划、待办顺序。 |
| `RESEARCH-songloft-plugin-inspiration.md` | songloft 插件架构调研：核心要点、现状 gap、行动清单、不适合照搬项、落地路线。 |

## 八、工程规范 / 台账 / 工具

| 文档 | 一句话总结 |
|---|---|
| `RELEASE_POLICY.md`（根） | 全系列仓库发版规范：版本号格式与上限、升级语义与节奏、各仓发版 checklist。 |
| `KNOWN_ISSUES.md` | 工程/运行时缺陷台账（MF-001~008），格式=ID/状态/现象/复现率/影响/根因/修复/验证。 |
| `AUDIT.md`（根） | UI/UX 类缺陷台账（与 KNOWN_ISSUES 的工程类分工）。 |
| `CONTRIBUTING.md`（根） | 仓库贡献约定。 |
| `CHANGELOG.md`（根） | 服务端版本变更历史（发版事实源）。 |
| `README.md`（根） | 项目总入口与快速上手。 |
| `OPENCODE_SESSION_HOWTO.md` | 查看 opencode 会话正文：直接读 SQLite 的 `part` 表（不在 `message` 表）、表结构、踩坑清单。 |

## 九、归档与旧计划（追溯用，不作事实来源）

**注意：以下全部内容已被权威文档吸收，行号/字段/结论一律可能过期，查现状回第二节的权威文档。**

| 归档文档 | 一句话总结（历史快照） |
|---|---|
| `archive/README.md` | 归档索引：列出每份归档在权威文档中的落点。 |
| `archive/审查报告-AirPlay桥接终审-2026-10-25.md` | 桥接方案 Red Team 终审：34 条事实核验、问题清单、可立即开工/有 Blocker 的分阶段判定。 |
| `archive/审查报告-AirPlay桥接终审-复验-2026-10-25.md` | 终审修订复验：7 处修法逐条判 PASS/部分成立/FAIL + 3 项判定，未引入新 Blocker。 |
| `archive/AirPlay桥接-240开工前验证报告-2026-10-25.md` | 开工前 240 环境/门禁验证：结果明细、新发现、可复现命令、证据文件清单。 |
| `archive/MusicFlow-AirPlay2(E2~E5)课题立项与实施计划-2026-10-20.md` | AP2 课题立项：发现层分级、AP2/AP1 回落、双接收器出声的分阶段计划与 DoD。 |
| `archive/sendspin/README.md` | Sendspin 归档索引：10 份历史文档在权威文档中的落点。 |
| `archive/sendspin/SENDSPIN_MA_ALIGNMENT_AUDIT.md` | 与 MA 播放链路全面对齐审计：逐项对照表、按优先级根因、分阶段修复与验证清单。 |
| `archive/sendspin/SENDSPIN_MULTIROOM_STREAMING_PLAN.md` | 真多房间组 + 流式解码方案：滑动窗口/背压、组管理 API、短历史环、分阶段 rollout。 |
| `archive/sendspin/SENDSPIN_PITFALLS_2026-09-18.md` | ESPHome 踩坑录：`send_ahead` 非 wire 字段等错误清单、共同模式、最低成本取证顺序。 |
| `archive/sendspin/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` | ESPHome 真机排障：四个根因、仍成立的事实、出声判据、ffmpeg 接口原则、遗留。 |
| `archive/sendspin/SENDSPIN_ESPHOME_DEBUG.md` | ESPHome 联调手册：设备日志三种方法、服务端抓包、mDNS 速查、坑位。 |
| `archive/sendspin/SENDSPIN_FLAC_ROADMAP.md` | FLAC 链路专项任务书：喂料粒度 vs FLAC 块大小矛盾、当前状态、验收清单。 |
| `archive/sendspin/2026-09-12-sendspin-renderer-design.md` | 渲染器插件设计完整版：架构组件、握手/音频/时钟/组/配对全角色设计。 |
| `archive/sendspin/2026-09-12-sendspin-renderer.md` | 渲染器实施计划：framing/身份/时钟协议等 Task 1~7 拆解。 |
| `archive/sendspin/sendspin-renderer-handoff-2026-09-13.md` | 渲染器任务交接：进度更新、已完成与待办、里程碑验证、关键文件速查。 |
| `archive/sendspin/sendspin-sim-player.md` | 模拟播放器使用说明：拨入/监听两模式、联调对照表、常见问题。 |
| `superpowers/plans/2026-08-05-dlna-ma-style-player-controller.md` | 旧 DLNA PlayerController 重构计划（8 任务拆解），已由后续方案取代。 |

## 十、目录速查

```
docs/
├── README.md                 ← 本文件（导航入口）
├── *-权威方案文档.md          ← 事实来源（airplay / sendspin / group / 播放链路队列流转）
├── 播放链路排障与采样手册.md   ← 排障总入口
├── 播放基线-基准值与判读-*.md  ← 判据与基准值
├── examples/                  ← 脱敏脚本（抓包 / 基线采样）
├── archive/                   ← 历史归档（不作事实来源）
└── superpowers/plans/         ← 旧实施计划
```
