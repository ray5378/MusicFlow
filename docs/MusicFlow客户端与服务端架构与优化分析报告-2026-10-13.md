# MusicFlow 客户端与服务端架构与优化分析报告

> 版本基线：客户端 **v5.8.1**（HEAD `c8f590a`）、服务端 **v4.6.5**（HEAD `b631661`）
> 报告日期：2026-10-13　｜　分析类型：只读代码审计（架构 / 性能 / 体验 / 链路）
> 事实源：230 主机 `192.168.10.230:/workspace` 的 `MusicFlow-client`（客户端）与 `MusicFlow/backend`（服务端），审计时镜像至本地只读副本。

## 目录

- [1. 概述](#1-概述)
- [2. 架构与分析方法](#2-架构与分析方法)
- [3. 客户端分析](#3-客户端分析)
- [4. 服务端分析](#4-服务端分析)
- [5. 客户端—服务端链路对照与优化](#5-客户端服务端链路对照与优化)
- [6. 架构决策记录（ADR）](#6-架构决策记录adr)
- [7. 适应度函数（Fitness Functions）](#7-适应度函数fitness-functions)
- [8. 风险登记表](#8-风险登记表)
- [9. 优化建议总清单](#9-优化建议总清单)
- [10. 结论与后续](#10-结论与后续)
- [Sources](#sources)

---

## 1. 概述

### 1.1 分析范围

| 维度 | 客户端 | 服务端 |
| --- | --- | --- |
| 仓库 | `MusicFlow-client` | `MusicFlow/backend`（仓库 `MusicFlow`） |
| 版本 | v5.8.1（`c8f590a`） | v4.6.5（`b631661`，backend 包版本 4.0.73） |
| 技术栈 | Flutter + flutter_riverpod + just_audio(+media_kit) + dio + drift + go_router | Node + Hono + TypeScript |
| 源码规模 | `lib/` 296 个 `.dart`（约 4.0 MB）；`test/` 479 个 `.dart` | `backend/src/` 约 4.6 MB |
| 关键目录 | `core/ data/ features/ providers/ widgets/ utils/ l10n/` | `routes/ services/ middleware/ db/ plugins/ batch/ utils/` |

### 1.2 分析目标

1. 整体架构是否需要优化；
2. 是否存在不合理、需要重构的模块或代码；
3. 可优化的性能点；
4. 可优化的整体体验点；
5. 必要时对照服务端源码给出**播放链路端到端优化建议**。

### 1.3 分析结论（执行摘要）

| 结论 | 说明 |
| --- | --- |
| 架构方向总体健康 | 客户端分层（core/data/features/providers/widgets）依赖方向清晰；服务端「统一代理 + 单端点」的源回退设计边界干净，客户端不持有「一歌多源」模型是**正确决策**。 |
| 主要问题是「巨型文件 / 上帝对象」 | `player_provider.dart`（2634 行）、`cast_peer_provider.dart`（2235 行）等承担过多职责，是维护与性能隔离的主要风险。 |
| 最严重单点：凭据明文落库 | Subsonic/媒体库 `password` 与 `apiKey` 直接写入 drift SQLite，与 `pubspec.yaml` 注释声明的安全存储相矛盾（P1）。 |
| 链路已有较强兜底 | 三档看门狗、服务端 6s 头等待回退、预取缓存、封面单飞与并发护栏均已落地；**未发现 P0 级缺陷**。 |
| 协同优化空间 | 客户端封面并发闸门（6）与服务端封面并发护栏（渲染 4 / 取源 2）存在**背压不对齐**，是下一步最值得做的链路优化。 |

---

## 2. 架构与分析方法

### 2.1 方法

采用「只读多子系统并行审计 + 关键文件人工复核 + 服务端链路对照」三步法：

1. 锁定权威版本（避免分析陈旧副本），镜像到本地只读工作副本；
2. 按子系统并行深挖（播放内核 / 投屏 DLNA / 数据网络离线 / UI 封面 / 服务端链路 / 工程健康度）；
3. 对高信号结论逐条人工复核并采集 `file:line` 一手证据；
4. 用架构决策框架（forces → alternatives → consequences → reversibility）收敛建议，并给出可执行的适应度函数。

> 运维说明：客户端与服务端仓库均以 `github.com/ray5378/*` 为 origin；按约定，访问 GitHub 的流量经 230 主机中转（`192.168.10.230`）。生产运行体位于 `192.168.10.240:35320`（root，私钥 `230:/root/mykey`），本报告为静态代码分析，未在生产容器内做运行时采样。

### 2.2 系统图（数据流 / 依赖 / 信任边界 / 责任）

```text
┌──────────────────────────── 客户端 (Flutter) ────────────────────────────┐
│  features/*  ──>  providers/*  ──>  data/* (drift / api clients)          │
│      │                 │                    │                             │
│      │                 │                    └─> core/network (dio 拦截器)  │
│      └─> widgets/*, core/design/*                                         │
│                                                                           │
│  播放内核 providers/player/*  ──> just_audio / just_audio_media_kit(libmpv)│
│  投屏    providers/cast/*, core/dlna/* ──> SSDP / UPnP(SOAP) / 局域网设备  │
└───────────────┬───────────────────────────────────────────────────────────┘
                │  HTTPS (rest/stream, rest/getCoverArt, api/v1/...)
                │  信任边界①：客户端↔服务端；凭据随请求携带
┌───────────────▼──────────────────── 服务端 (Node+Hono) ───────────────────┐
│  routes/rest/index.ts  ── /rest/stream（Range/timeOffset/转码/flow）       │
│  services/source/*     ── 源解析/整曲缓冲(bufferedFetch)/预取(prefetch)    │
│  services/coverImage.ts + coverCache.ts ── 封面渲染/单飞/缓存              │
│  services/dlna, peer, airplay, sendspin ── 播放目标与设备群                │
└───────────────┬───────────────────────────────────────────────────────────┘
                │  信任边界②：服务端↔上游音源/网盘；信任边界③：服务端↔DLNA 设备
        ┌───────▼────────┐        ┌──────────────────┐
        │ 上游音源/网盘  │        │ 局域网 DLNA 设备 │
        └────────────────┘        └──────────────────┘
```

### 2.3 限界上下文映射（Bounded-Context Map）

| 上下文 | 责任 | 模型/语言 | 上游 | 下游 | 关系模式 | 翻译面 |
| --- | --- | --- | --- | --- | --- | --- |
| 播放内核（客户端） | 播放状态机、队列、seek、看门狗 | `PlayerState`/`AudioPlayer` | 数据层 URL | 播放器后端(libmpv) | Customer/Supplier | URL 构建、timeOffset 语义转换 |
| 投屏 DLNA（客户端） | 设备发现、直投会话 | 设备/AVTransport | 服务端 token | DLNA 设备 | Conformist(UPnP) | DIDL-Lite 元数据、http 基址重写 |
| 数据/网络（客户端） | 数据源、离线缓存、线路回退 | Library/Song | 服务端 REST | 播放内核 | Customer/Supplier | Subsonic/网盘参数映射 |
| 渲染与封面（服务端） | 封面渲染、缓存、限流 | 封面字节/ETag | 存储/上游 | 客户端 | Partnership | ETag 单飞、尺寸预算 |
| 流服务（服务端） | 流式出流、转码、预取、换源 | 音频流 | 上游音源 | 客户端/DLNA | Customer/Supplier | Range→timeOffset、格式协商 |
| 设备群/Peer（服务端） | 本机 peer、流转播放、队列 | Peer/Queue | 客户端注册 | DLNA/AirPlay | Shared Kernel | 队列推进协议 |

---

## 3. 客户端分析

### 3.1 播放内核

播放内核是客户端最复杂、也最关键的子系统，核心在 `providers/player/`。

**问题清单**

| 级别 | 问题 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2 | `player_provider.dart` 上帝对象 | [player_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L60-L79)（2634 行，`PlayerNotifier` 含播放/队列/音量/看门狗/持久化全部职责） | 变更影响面大、可测性差、并行开发冲突 | 继续沿已开始的 mixin 拆分（如 `PlayerPositionPollingInternals`）把「看门狗、音量、持久化、队列」独立为协作者 |
| P2 | 采用遗留 `StateNotifier` 而非 Riverpod `Notifier` | [player_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L60) `StateNotifierProvider<PlayerNotifier, PlayerState>` | 无法用 Riverpod 2.x 的 `ref` 生命周期/自动 dispose，样板多 | 迁移到 `NotifierProvider`/`AsyncNotifierProvider`（可分阶段） |
| P2 | 位置轮询常驻 2Hz | [player_position_polling.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_position_polling.dart#L11) `Timer.periodic(500ms)` | 后台/不可见时仍空转，持续触发 UI 状态更新 | 结合 `appVisibilityProvider` 在不可见时降频或暂停轮询 |
| P3 | 起播缓冲窗口偏保守 | [player_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L538-L539) `bufferForPlaybackDuration: 5s` / `AfterRebuffer: 10s` | 弱网起播体验偏慢 | 按后端（media_kit vs ExoPlayer）分别标定，A/B 验证 |
| P3 | seek 采用「重建流 + 固定延迟」 | [player_seek.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_seek.dart#L184-L272)（220/120ms 延迟、15s settle） | seek 体感延迟、魔法数分散 | 抽为可配置常量并纳入回归用例 |

**架构评价**：三档看门狗（idle 停滞 10s、loading 零前进上限、30min 兜底）设计成熟，是对 libmpv `network-timeout=0` 这一平台缺陷的正确补偿，[player_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L177-L205) 中「在途加载标记 + generation 守卫」避免了慢请求收尾误清新加载，属高质量工程实践。真正的问题不是逻辑正确性，而是**单文件承载过多**：2634 行使看门狗、队列、音量、持久化耦合在同一状态机，任何改动都要通读全文件。建议的优化不是「重写」，而是**按职责切分协作者**，保持对外 `PlayerState` 契约不变。

### 3.2 投屏 / DLNA

**问题清单**

| 级别 | 问题 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2 | `cast_peer_provider.dart` 上帝对象（2235 行） | [cast_peer_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/cast/cast_peer_provider.dart#L1) | 设备发现/peer 注册/心跳/队列/流转混于一体 | 拆为发现、会话、队列三段 |
| P3 | 直投状态轮询 2s 常驻 | [dlna_manager.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/dlna_manager.dart#L347-L385)（`_playCurrentTrack` + 轮询） | 长时投屏有少量网络与唤醒开销 | 空闲/已暂停时降频 |

**架构评价**：SSDP 发现实现规范，`listen()` 在 `finally` 中取消订阅并关闭 socket，且包含 Windows IOCP 事件驱动收包修复（[ssdp_discovery.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/ssdp_discovery.dart#L100-L218)）；设备描述与 SOAP 控制均在 `finally` 关闭 `HttpClient`（[device_description.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/device_description.dart#L11-L34)、[soap_control.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/soap_control.dart#L43-L88)）——**历史问题「HttpClient.close 不在 finally」已修复**。直投链路过往「无投前预探测」的缺口，已在客户端与服务端两侧修复（409 + 客户端 `probeSong` 钩子，见 §5），当前主要遗留是可维护性。

### 3.3 数据 / 网络 / 离线 / 鉴权

**问题清单**

| 级别 | 问题 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| **P1** | Subsonic/媒体库凭据**明文落库** | [library_repository.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/data/repositories/library_repository.dart#L51-L64)、[同文件更新路径](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/data/repositories/library_repository.dart#L90-L111) 直接写 `password`/`apiKey` 到 drift | 本机数据库可被读取即泄露账号；与 [pubspec.yaml](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/pubspec.yaml#L64-L67) 注释声明的 secure storage 相矛盾 | 凭据迁入 `flutter_secure_storage`，DB 仅存引用键；旧数据做一次性迁移 |
| P2 | 线路回退失败计数为共享可变状态 | [fallback_interceptor.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/network/fallback_interceptor.dart#L14-L63) `_consecutiveFailures` | 并发请求下计数竞态，可能提前/滞后切线路 | 改为每请求作用域计数或加串行化 |
| P2 | 健康检查未串行化 | [health_checker.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/network/health_checker.dart#L18) `Timer.periodic(30s, (_) => _check())` 未 await | 探测慢于 30s 时任务重叠 | 用「上一轮未完成则跳过/取消」的互斥 |
| P3 | 命中无 TTL 的播放性缓存 | 客户端文档记录 `streamFallback` 缓存已按「失败即逐出」修复（服务端侧） | 参见 §4 | 保持，纳入回归 |
| — | 离线缓存原子写/初始化扫描 | [offline_cache_manager.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/offline/offline_cache_manager.dart#L112-L140) | 需进一步核验是否已加原子写与目录扫描 `[unverified]` | 补写临时文件 + rename；`init` 扫目录对齐索引 |

**历史问题复核结论**

| # | 历史问题 | 结论 |
| --- | --- | --- |
| 1 | Subsonic 凭据明文落库（注释误导） | **仍成立**（P1） |
| 2 | device_description `HttpClient.close` 不在 finally | **已修复**（finally 已存在） |
| 3 | offline_cache_manager 非原子写 + init 不扫目录 | **部分成立**（[j3]）：索引写**已原子化**（`.part` + `rename`，[offline_cache_manager.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/core/offline/offline_cache_manager.dart#L276-L289)，拷贝同法 #L387）；`init()` 仅读 `index.json` **不扫描** 各 kind 目录（#L187-L200），索引损坏即 `clear` 重建（#L217-L221）⇒ 未被索引的数据文件成孤儿（轻度磁盘泄漏，非安全问题） |
| 4 | aggregate_search_results 在 build 里 new Future | **不成立（假阳性）**（[j3]）：`SearchRequest` 实现 `==`/`hashCode`（[search.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/data/models/search.dart#L347-L358) 按 kind/mode/query/providerId 值相等），组件内 `ref.watch(searchResultsProvider(request))` 的 family key 每次 build **相等** ⇒ 不会重复建/丢 Future；且被 4 个页面 import，**非死代码** |
| 5 | fallback_interceptor 共享可变失败计数竞态 | **仍成立**（P2）→ 已修（[i3]） |
| 6 | health_checker `_check` 不 await | **仍成立**（P2）→ 已修（[i3]） |
| 7 | 死代码（StoragePermissionService 等） | **成立**（[j3]）→ **已清理（[k1]）**：文件 `lib/core/services/storage_permission_service.dart` 已删除（全仓除定义外 **0 引用**，删除后复扫无残留）；**修正**——`permission_handler` 实测**仍被** [notification_permission_service.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/core/services/notification_permission_service.dart#L2) 使用，**不随死代码一并移除** |
| 8 | pubspec 未使用依赖（cached_network_image 等） | **cached_network_image 成立**（[j3]）→ **已清理（[k1]）**：`lib/`、`test/` 零引用（含 `CachedNetworkImage`/`flutter_cache_manager`），已从 [pubspec.yaml](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/pubspec.yaml#L64-L75) 移除；`flutter pub get` 连带移除其 3 个传递包（`cached_network_image_platform_interface`/`_web`/`octo_image`）；其余依赖未逐项核验 |

**架构评价**：数据层采用 Repository 模式，`providers/api` → `data/sources` → `core/network` 的依赖方向正确，dio 拦截器统一处理基址归一化与线路回退（[fallback_interceptor.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/network/fallback_interceptor.dart#L19-L32) 对 baseUrl 去尾斜杠的防御很关键，避免了 `//rest/...` 拼出 SPA HTML 导致的静默全挂）。突出短板在**安全边界**：可用 `flutter_secure_storage` 却仍在业务表存明文，是当前最应优先处理的项。

### 3.4 UI / 封面 / 设计系统

**问题清单**

| 级别 | 问题 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2 | 大页面/大组件 | [full_player_page.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/features/player/pages/full_player_page.dart#L1)（1505 行）、[discover_page.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/features/discover/pages/discover_page.dart#L1)（1263 行）、[mini_player.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/widgets/mini_player.dart#L1)（1079 行） | build 树庞大，重入成本高 | 按区块抽子组件，配合 `const` 与局部化 `watch` |
| P3 | 封面切换缺 `gaplessPlayback` | [cover_art_image.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/widgets/cover_art_image.dart#L252-L333)（`Image.network` 未见 `gaplessPlayback`） | 换图瞬间可能出现占位闪烁 | 加 `gaplessPlayback: true` |
| P3 | 封面并发闸门固定 6 | [cover_art_image.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/widgets/cover_art_image.dart#L16-L49) `_CoverRequestGate(maxConcurrent=6)` | 与服务端渲染并发（4/2）不完全对齐 | 见 §5 背压对齐 |

**封面加载链路评价**：`cover_art_image.dart` 已具备完整治理——全局并发闸门（默认 6）限制同时在途网络封面、未获槽位先渲染同尺寸骨架、`dispose` 释放槽位、`cacheWidth/cacheHeight` 做尺寸预算、失败重试与离线回退（[cover_art_image.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/widgets/cover_art_image.dart#L117-L249)）。配套 `subsonic_api_client` 复用会话内 token/salt，避免封面 URL 频繁变化触发 `Image.network` 反复重载（[subsonic_api_client.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/data/sources/subsonic_api_client.dart#L18-L22)）——这正是历史上「播放时封面闪烁」的正确修法。内存侧 `imageCache` 固定 128MB / 64 条（[main.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/main.dart#L15-L30)）。整体结论：封面链路已从「历史根因」演进为「治理良好」，剩余为局部调优。

**设计系统一致性评价**：自研设计系统位于 `core/design/*`（`music_flow_*`），并被 `app.dart` 的主题装配引用（[app.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/app.dart#L7)、[app.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/app.dart#L94-L99)）；桌面端自适应缩放在 `App.build` 的 `builder` 内统一处理。风险点在于大页面各自维护较多局部样式常量，建议把这部分常量沉淀回设计系统。

### 3.5 工程健康度与度量

最大文件（按行数，含生成物）：

| 排名 | 文件 | 行数 | 性质 |
| --- | --- | --- | --- |
| 1 | `l10n/generated/app_localizations.dart` | 4829 | 生成 |
| 2 | `data/sources/database/app_database.g.dart` | 3494 | 生成 |
| 3 | `providers/player/player_provider.dart` | 2634 | 手写（**重点**） |
| 4 | `l10n/generated/app_localizations_en.dart` | 2400 | 生成 |
| 5 | `providers/cast/cast_peer_provider.dart` | 2235 | 手写（**重点**） |
| 6 | `l10n/generated/app_localizations_zh.dart` | 2234 | 生成 |
| 7 | `features/player/pages/full_player_page.dart` | 1505 | 手写 |
| 8 | `features/discover/pages/discover_page.dart` | 1263 | 手写 |
| 9 | `core/dlna/dlna_manager.dart` | 1217 | 手写 |
| 10 | `features/player/widgets/mini_player.dart` | 1079 | 手写 |

**入口与初始化评价**：`main.dart` 在 `runApp` 前**刻意不 await** 平台存储，规避桌面端插件未注册导致的永久挂起（[main.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/main.dart#L32-L41)），并在 `runApp` 后异步修复损坏的 SharedPreferences（[main.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/main.dart#L78-L82)），属经验沉淀后的正确做法。路由侧 `routerProvider` 监听认证状态并驱动跳转（[app.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/app.dart#L171-L201)）。

---

## 4. 服务端分析

### 4.1 播放链路端到端时序

```text
客户端 playSong
  └─ GET /rest/stream?id=..&timeOffset=0|N&format=..&maxBitRate=..&peerId=..
        │  routes/rest/index.ts:2101 起（解析 timeOffset/format/maxBitRate/peerId）
        ├─ timeOffset>0 → 走「直通/缓存」路径（seek 重拉）
        ├─ 决定是否转码（decideTranscode；ffmpeg 并发上限 4）
        └─ 网络源 → bufferedFetch 整曲缓冲
              │  头等待上限 STREAM_BUFFER_HEAD_WAIT_MS（默认 6000ms，env 可调）
              │  routes/rest/index.ts:2011-2017
              ├─ 6s 内拿到头部 → 缓冲出流
              └─ 超时 → 回退「直通」（既有通道，避免 502）
        └─ 源优选/换源：resolvePreferredSong → serveWebSongStream → findFallbackStream
        └─ 播放前探测：ensurePlayableStream（Range 探测 + 换源 + 回写 DB）
客户端 DLNA 直投 / 服务端投 DLNA → /rest/dlna/stream/:token（服务端签发，6h，逐曲重换）
```

关键事实与证据：

| 事实 | 证据 |
| --- | --- |
| 头等待上限默认 6000ms，env 可覆盖 | [rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L2010-L2017) |
| `timeOffset` 解析与日志（seek 重拉） | [rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L235-L240)、[rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L2109-L2120) |
| Range 一律按全流 200，客户端改走 timeOffset | [rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L1772)、[rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L2145) |
| 预取缓存针对大文件在线源 | [prefetchCache.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/source/prefetchCache.ts#L3-L51) |
| 预取常量（前瞻/截止/停顿/并发/预算比/换源上限） | [prefetchCache.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/source/prefetchCache.ts#L75-L120) |
| 整曲缓冲参数（大小/预算/停顿/总超时/退避） | [bufferedFetch.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/source/bufferedFetch.ts#L13-L59) |

**历史结论复核**：`STREAM_BUFFER_HEAD_WAIT_MS=6000` 超时回退直通、`timeOffset>0` 走直通、预取缓存——**均仍成立**；历史「封面上限≈130 张/秒、缓存 500 条/32MB」**已过期**（见 §4.3）。

### 4.2 服务端瓶颈与客户端可协同优化点

| 级别 | 环节 | 证据 | 影响 | 协同建议 |
| --- | --- | --- | --- | --- |
| P2 | 网络源整曲缓冲的头等待窗口（6s）与客户端「loading 零前进」看门狗阈值需对齐 | [rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L2010-L2017) / 客户端看门狗 | 阈值错配会导致客户端过早判死或长时间无响应 | **已核验对齐并加守卫（[j1]）**：服务端 6s < 客户端 idle 判死 10s（余量 4s）、loading 档 30s；两侧各一处契约用例钉死不变式 |
| P2 | 转码（ffmpeg）并发上限 4，重负载下排队 | [rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L1478-L1502)（转码路径） | 高并发 seek/换格式时排队延迟 | 客户端避免不必要的转码请求（优先透传格式）；对排队加指标 |
| P3 | Range 语义为「全流 200」 | [rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L1772) | 客户端若按字节 Range 预期行为会失配 | 客户端统一用 `timeOffset` 表达 seek（现状已如此），写入契约测试 |
| P3 | 预取与播放路径的单飞/超时边界 | [prefetchCache.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/source/prefetchCache.ts#L3-L51)（明确「不共用播放路径 single-flight／不动播放路径超时」红线） | 设计约束需长期保持 | ✅ 已纳入适应度函数（§7「路径隔离」行，[l6]） |

### 4.3 封面链路

当前生效参数（**已较历史口径收窄**）：

| 参数 | 当前值 | 证据 |
| --- | --- | --- |
| 封面字节缓存预算 | `COVER_CACHE_BUDGET_MB` 默认 **64MB** | [coverCache.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverCache.ts#L26) |
| 无请求后清空窗口 | `COVER_CACHE_IDLE_MINUTES` 默认 **5min**，60s 扫一次 | [coverCache.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverCache.ts#L24-L44) |
| 渲染缓存条目上限 | `COVER_RENDER_MAX_ENTRIES` 默认 **1500** | [coverImage.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverImage.ts#L66) |
| 渲染并发 | `COVER_RENDER_CONCURRENCY` 默认 **4** | [coverImage.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverImage.ts#L75) |
| 同 ETag 单飞 | `inflight` Map 按 ETag 去重 | [coverImage.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverImage.ts#L79)、[coverImage.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverImage.ts#L141-L177) |
| 取源并发护栏 | `COVER_CONCURRENCY_LIMIT = 2` | [covers.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/covers.ts#L43-L48) |

**协同分析**：客户端单机并发闸门为 **6**，而服务端「渲染 4 + 取源 2」两级护栏使**单请求侧的有效并发更低**。多客户端场景下，闸门 6 × N 客户端可能超出服务端渲染队列承载，表现为封面慢请求堆积。建议以「服务端护栏值」为基准反推客户端闸门，或让服务端在排队时返回可感知的退避信号（如 `Retry-After`）供客户端自适应。

---

## 5. 客户端—服务端链路对照与优化

### 5.1 四条播放链路的兜底对照

| 链路 | 播放端点 | 投/播前预探测 | 失败感知 | 全失效兜底 | 连跳停止阈值 |
| --- | --- | --- | --- | --- | --- |
| 客户端本机 | `/rest/stream`、`/rest/stream-remote` | upcoming 3 首批量 probe（当前首不探） | just_audio error 即时 | 转码重试 → 记死歌 → `next()` | 5 |
| 客户端直投 DLNA | `/rest/dlna/stream/:token` | 已补：服务端 409 + 客户端 `probeSong` 钩子 | 2s 轮询 TransportState，stall×2 | 跳下一首 | 8 |
| 服务端投 DLNA | `/rest/dlna/stream/:token`（服务端签发） | 投前 `ensurePlayableStream` | GENA + 轮询 + stalled 重播 | 移出队列跳下一首 | 3 |
| Web 前端 | `/rest/stream` | upcoming 3 首 probe + 远程格式探测 | onloaderror/onplayerror 即时 | 跳下一曲 | 5 |

（来源：客户端自带审计文档 [playback_chain_audit.md](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/docs/playback_chain_audit.md#L9-L128) 与本次代码复核。）

> ⚠ **上表「连跳停止阈值」列的 5/8/3/5 取自该审计文档的历史快照，与当前代码不符（已过时）**。现状复核与更正见 §11 [i5]：客户端本机、服务端投 DLNA、Web 前端均为**无停止阈值（不可播逐曲移除、无限跳）**；客户端离线分支为 **2**（达 2 次落 `pause()`，D-058）；客户端直投 DLNA 的 `2` 是**曲中段异常停止（stall）计数**，非「连跳停止」。该契约由 CI 静态守卫钉死，不得回归。

### 5.2 链路优化决策表

| 候选优化 | 收益 | 成本 | 风险 | 建议 |
| --- | --- | --- | --- | --- |
| 封面端到端背压对齐（客户端闸门 ↔ 服务端护栏） | 高（减少慢请求堆积） | 低 | 低 | **建议优先做** |
| 统一「连跳停止阈值」为单一配置并提示用户 | — | — | **高** | **已否决**（2026-10-13）：与 2026-09-09 拍板、CI 钉死的「无停播阈值、无限跳」契约直接冲突（`playback-chain-guard.yml#L54-L66`）。**仅落地契约兼容的「合并提示」**，见 §11 [i5] |
| 服务端排队时返回 `Retry-After` 供客户端退避 | 中 | 中 | 低 | 建议做，与背压对齐配套 |
| `/rest/stream?timeOffset=1` 作为 TTFB 探针接入监控 | 中（可观测性） | 低 | 无 | ✅ 已完成（[l7]：v4.6.9 上游直采探针，设置页开关默认关） |
| 客户端引入「歌词/封面」本地二次缓存 | 低-中 | 中 | 中 | 需要时再评估 |

---

## 6. 架构决策记录（ADR）

### ADR-1：保持「服务端统一代理 + 单端点」，不在客户端引入多源模型

- **状态**：接受（现状）
- **上下文（forces）**：多音源回退逻辑集中在服务端，客户端仅持单一端点；已实现源优选、拉流换源、播放前探测三层兜底；客户端再引入源模型会与服务端职责重叠（＞2 个力：职责单一、失败域收敛）。
- **决策**：客户端不持有「一歌多源」结构，多源回退完全由服务端透明完成。
- **备选**：① 客户端多源模型；② 端侧预取整曲。
- **否决理由**：① 重复服务端换源逻辑、状态面翻倍；② 端侧存储与带宽成本高且与离线缓存职责冲突。
- **后果**：正面——边界清晰、客户端轻；负面——客户端对源健康不可见，依赖服务端返回正确错误码。
- **可逆性成本**：高（一旦引入客户端源模型需重构播放内核）。
- **重新评估触发**：服务端换源失败率持续高于阈值，或出现客户端离线多源需求。

### ADR-2：将巨型 `StateNotifier` 拆分为协作者并迁移 Riverpod `Notifier`

- **状态**：**大部实施**（2026-10-14 更新）——阶段 1 纯策略外提 [i7] ✅；阶段 2a cast 域纯策略外提 [l16] ✅；阶段 2b 协作者抽取 [l17]/[l18] ✅（2b-3 音量经评估不抽、批次收口，见 [l19]）；阶段 3a-1 三小 provider 迁 `NotifierProvider` [l19] ✅。**剩余**：阶段 3b——`playerProvider` 主迁移与 cast 域迁移（`ref.invalidate` 重建语义差异需先设计，前置真机回归条件，见 [l19]）。
- **上下文（forces）**：`player_provider.dart` 2875 行、`cast_peer_provider.dart` 2367 行（含本次 [i2]~[i7] 增量）；已通过 mixin 部分拆分，但其成员为**库私有**、单测不可达；Riverpod 2.x 提供生命周期与自动 dispose（≥2 个力：可维护性、可测性）。
- **决策**：按职责（看门狗/队列/音量/持久化/发现会话）拆分协作者，保持对外状态契约；分阶段迁移到 `NotifierProvider`。
- **备选**：① 维持现状；② 一次性重写。
- **否决理由**：① 维护成本持续累积；② 高风险、回归面大。
- **后果**：正面——可测性与并行开发改善；负面——短期改动面扩大，需回归用例护航。
- **可逆性成本**：中（分阶段可回退）。
- **重新评估触发**：任一 provider 文件再次显著超过 1500 行。

### ADR-3：凭据迁移至 `flutter_secure_storage`

- **状态**：**已实施**（2026-10-13，见 §11 [i2]）
- **上下文（forces）**：业务表存明文 `password`/`apiKey`；依赖中已含 `flutter_secure_storage`；注释与实现不一致（≥2 个力：安全、一致性）。
- **决策**：DB 仅存引用键，凭据置入安全存储；提供一次性迁移。
- **备选**：① 维持明文；② 自研加密。
- **否决理由**：① 安全面不可接受；② 重复造轮子且密钥管理自相矛盾。
- **后果**：正面——消除明文泄露面；负面——迁移逻辑需处理失败回滚。
- **可逆性成本**：中。
- **重新评估触发**：任何凭据相关安全事故或合规要求。

### ADR-4：封面链路端到端背压对齐

- **状态**：**已实施**（2026-10-13，见 §11 [i4]）
- **上下文（forces）**：客户端闸门 6 与服务端护栏（渲染 4 / 取源 2）不匹配；服务端已有单飞与缓存（≥2 个力：性能、稳定性）。
- **决策**：以服务端护栏为基准标定客户端并发，并让服务端在排队时给出退避提示。
- **备选**：① 仅调服务端护栏；② 客户端自适应探测。
- **否决理由**：① 多客户端下仍会过载；② 无信号可依。
- **后果**：正面——慢请求堆积下降；负面——多一个需同步的配置面。
- **可逆性成本**：低。
- **重新评估触发**：封面 p95 TTFB 超预算。

---

## 7. 适应度函数（Fitness Functions）

| 属性 | 指标 | 阈值/规则 | 测量源 | 节奏 | 失败响应 | 本地检查路径 |
| --- | --- | --- | --- | --- | --- | --- |
| 依赖方向 | 反向依赖数 | `features→providers→data/core` 无反向/循环 | 静态分析/依赖图 | 每次合并 | 阻断合并 | CI lint + 依赖图脚本 |
| 公共契约 | `/rest/stream` 返回语义 | 一律 200 全流；seek 用 `timeOffset` | 契约测试 | 每次合并 | 阻断合并 | `test/` 契约用例 |
| 路径隔离 | 预取与播放的 single-flight/超时边界 | 预取零共享循环键；播放默认 stall/deadline=10s/18s 不被改写；预取 120s/30s 仅以单次覆写生效 | 守卫测试（行为 ③ + 适应度 ⑩） | 每次合并 | 阻断合并 | `backend/tests/source/prefetchCache.test.ts`（③⑩） |
| 起播时延 | 流 TTFB p95 | ≤ 头等待窗口（6s）+ 余量 | 探针（上游直采 `resolveNetworkInput`，[l7]） | 每小时 | 告警 | 媒体获取页探针卡 + `scripts/pull-240-monitor.sh` |
| 跨仓阈值对齐 | 服务端首字节等待 vs 客户端 idle 判死上界 | 服务端 6s 严格小于客户端 10s，且余量 ≥ 1.5s | 双端单测（客户端 `b50g`、服务端 `bufferHeadWait`） | 每次合并 | 阻断合并 | `test/` 两侧契约用例（[j1]） |
| 封面时延 | 封面 TTFB p95 | ≤ 2s | 服务端指标 | 每小时 | 告警 | 监控面板 |
| 爆炸半径 | 手写单文件行数 | < 1500 | 行数统计 | 每次合并 | 告警/评审 | 行数统计脚本 |
| 内存上界 | 封面缓存 | 服务端 ≤ 64MB；客户端 imageCache ≤ 128MB | 运行指标/配置 | 每日 | 告警 | 配置校验 |
| 播放健壮性 | 看门狗兜底覆盖 | idle/loading/兜底三档均在 | 回归用例 | 每次合并 | 阻断合并 | `test/` 看门狗用例 |
| 安全 | 明文凭据条目 | 业务表明文凭据数 = 0 | 静态扫描 | 每次合并 | 阻断合并 | DB schema/扫描脚本 |

---

## 8. 风险登记表

| ID | 风险 | 可能性 | 影响 | 等级 | 缓解措施 | 触发信号 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 凭据明文落库导致账号泄露 | 中 | 高 | 高 | 迁 secure storage（ADR-3） | 数据库被读取/合规审计 |
| R2 | 巨型 provider 变更引入回归 | 高 | 中 | 高 | 分阶段拆分（ADR-2）+ 回归用例 | 单文件持续膨胀 |
| R3 | 弱网/上游慢导致起播卡顿 | 中 | 中 | 中 | 头等待与看门狗阈值对齐 | TTFB 探针超阈 |
| R4 | 封面慢请求堆积 | 中 | 中 | 中 | 背压对齐（ADR-4） | 封面 p95 超阈 |
| R5 | 线路回退计数竞态误切线路 | 低 | 中 | 中 | 计数作用域化 | 切线路现象异常 |
| R6 | 多客户端并发超出服务端渲染能力 | 中 | 中 | 中 | 服务端退避信号 | 并发连接/队列长度上升 |

---

## 9. 优化建议总清单

**P1（优先）**

1. ✅ 凭据迁移 `flutter_secure_storage`，DB 仅存引用键 + 一次性迁移（[library_repository.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/data/repositories/library_repository.dart#L51-L111)）。→ [i2]

**P2（计划）**

2. ⚠️ 拆分 `player_provider.dart` / `cast_peer_provider.dart` 为协作者并迁移 `Notifier`（ADR-2）。→ 阶段 1 [i7] ✅；阶段 2a [l16] ✅、2b [l17]/[l18] ✅、3a-1 [l19] ✅；仅剩阶段 3b 主迁移（前置条件见 [l19]）
3. ✅ 消除 `FallbackInterceptor._consecutiveFailures` 竞态（[fallback_interceptor.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/network/fallback_interceptor.dart#L14-L63)）。→ [i3]
4. ✅ `HealthChecker` 串行化（[health_checker.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/network/health_checker.dart#L18)）。→ [i3]
5. ✅ 封面端到端背压对齐（ADR-4）。→ [i4]
6. ⚠️ 统一四条链路的「连跳停止阈值」并给用户明确提示。→ 「统一阈值」**否决**（违反 CI 钉死契约），仅落地「合并提示」[i5]

**P3（优化/打磨）**

7. ✅ 位置轮询在窗口不可见时降频（[player_position_polling.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_position_polling.dart#L11)）。→ [i6]
8. ✅ `CoverArtImage` 增加 `gaplessPlayback: true`。→ [i6]
9. ✅ 按后端标定起播缓冲窗口（[player_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L538-L539)）。**已完成**（v5.8.4：实测首字节后 13~21MB/s 瞬间填满，评估后维持 5s/10s 两档；镜像服务端新上界 8000 并提取 `AudioLoadConfiguration` 单一常量源，b50g 跨仓契约钉死）
10. ✅ 大页面按区块抽子组件（`full_player_page` / `discover_page` / `mini_player`）。→ [l1]
11. ✅ 把散落的 UI 样式常量沉淀回 `core/design`。→ [l2]
12. ✅ 核验历史死代码与未使用依赖（见 §3.3 表中的 `[unverified]` 项）。→ [j3]（核验）→ [k1]（**清理已完成**：删除 0 引用的 `StoragePermissionService`；pubspec 移除未使用的 `cached_network_image`；`permission_handler` 经核验仍被通知权限服务引用，**保留**）

### 9.1 未完成清单（截至 2026-10-14）

> 用户显式要求的 **P1 / P2 / P3 / ADR-2~4 / 模拟测试 / 逐项登记** 已闭环；下方为**剩余**条目（已做/已核验者标 ✅ 并附记录号）。

| 来源 | 条目 | 状态 | 说明 |
| --- | --- | --- | --- |
| §9 #2 | ADR-2 阶段 2a：`cast_peer_provider.dart` 同类纯策略外提 | ✅ 已完成 | [l16]（v5.8.11）：`cast_peer_policy.dart` 外提（提交 `f65191b`，3 文件 +649/−81，纯测 30 例），投屏/流转状态判定改顶层纯函数、`CastPeerController` 改委托 |
| §9 #2 | ADR-2 阶段 2b：文件结构级拆分（协作者对象） | ✅ 已完成 | [l17]（`615ad9b`：`player_session_persister.dart` 会话落盘/恢复 + `PlaybackSessionPersisterHost` 窄接口）/ [l18]（`d9caad1`：`player_position_polling.dart` 位置轮询 + 三道看门狗驱动，27 成员窄接口）；2b-3（音量 ~50 行、内聚紧耦合）经评估**不抽**、批次收口，见 [l19] |
| §9 #2 | ADR-2 阶段 3：`StateNotifierProvider` → `NotifierProvider` | ⏸ 3a 已完成 / 3b 延期 | [l19]（`f5d9a25`）：音质 / 淡入淡出 / 定时停止三 provider 已迁 `NotifierProvider`（阶段 3a-1）；**主迁移 `playerProvider` + cast 域（151 处 fake）延期至阶段 3b**——riverpod 2.6.1 下 `ref.invalidate(playerProvider)` 在 `NotifierProvider` 保留**同实例仅重跑 `build()`**（`StateNotifierProvider` 为整体重建），且 lib 存在 4 处 `invalidate` 调用点，需先设计重建语义 + 真机回归条件（3a-2 补丁已完整实施后按「万无一失」回滚） |
| §9 #9 | 按后端标定起播缓冲窗口（5s / 10s） | ✅ 已完成 | v5.8.4：真机实测首字节后 13~21MB/s 瞬间填满、非起播瓶颈，评估后维持两档阈值；镜像服务端新上界 8000（`kServerStreamBufferHeadWaitMs`，契约余量 1500→2000ms）+ `AudioLoadConfiguration` 单一常量源；b50g 跨仓契约组钉死 |
| §9 #10 | 大页面按区块抽子组件 | ✅ 已完成 | [l1]：三页 1590/1314/1164 行抽至 681/505/449 行 + 14 个子组件文件（player 8 / discover 6）；纯搬运零行为变更；`dart analyze lib/features` 0 error 0 warning，`flutter test test/features` 622 全绿；commit `5e891e8` 只推 main 不打 tag（重构先例 c51dc98） |
| §9 #11 | UI 样式常量沉淀回 `core/design` | ✅ 已完成 | [l2]：手术后重核——间距/圆角早已 token 化（0 字面量），裸 `Colors.*` 仅 13 处且全为 `Colors.transparent`（无语义色按既定决策保留）；4 处 fontSize 字面量按仓内「token 派生」先例（457-465 行）路由到 `MusicFlowTypography`（值等价）；顺带清 2 处历史 unused import |
| §9 #12 | 历史死代码 / 未使用依赖**清理** | ✅ 已完成 | [k1]：已删 `lib/core/services/storage_permission_service.dart`（0 引用）；pubspec 已去 `cached_network_image`（`pub get` 连带移除 `cached_network_image_platform_interface`/`_web`/`octo_image` 共 4 项），`permission_handler` 因仍被 `notification_permission_service.dart` 使用而**保留** |
| §4.2 P2 | 头等待窗口（6s）↔ 客户端「loading 零前进」看门狗阈值对齐 | ✅ 已完成 | [j1]：确认不变式（服务端 6s < 客户端 idle 判死 10s，余量 4s）；两侧加契约注释 + 各一处守卫用例；**未改常量值**。回归见 [j4]（客户端播放内核 522 过 / 1 既有 flaky、服务端 CI 守卫 72 例全绿） |
| §4.2 P2 | `/rest/stream?timeOffset=1` 作 TTFB 探针接入监控 | ✅ 已完成 | [l7]：v4.6.9 金丝雀探针（设置页开关默认关、选歌后每小时一次、仅读首字节即取消）；与字面 `?timeOffset=1` 的偏差见 §11 [l7] |
| §4.2 P2 | 转码（ffmpeg）并发 4 排队 → 客户端优先透传 + 排队指标 | **未做**（服务端已就绪） | 服务端转码总闸 `maxConcurrentTranscodes`（默认 4、超限 FIFO 排队、`finally` 释放）已随 **v4.6.12** 落地（`config.ts` / `orchestrator.ts` PATCH22）；剩余「客户端优先透传 + 排队指标」待做（排队深度尚未见诸 `/v1/admin/metrics`） |
| §4.2 P3 | Range「全流 200」写入契约测试 | ✅ 已完成 | [l5]：`pipelineContract.test.ts` 追加「P2-1 Range 契约」describe 5 例（bytes=0- / 中段 100-200 / 后缀 -500 / Range+timeOffset 组合 / 结构锁禁 Range 解析），钉死「带 Range 头请求 /rest/stream 一律全流 200（非 206、无 Content-Range、body 不截断）」；pipelineContract 19/19、rest 目录 11 文件 115/115 全绿；纯测试加固只推 main 不打 tag |
| §4.2 P3 | 预取/播放路径单飞红线纳入适应度函数（§7） | ✅ 已完成 | [l6]：`prefetchCache.test.ts` 追加 ⑩ 组（源码锁×2 + 常量锁 + 方向锁 + 单次覆写行为锁，详见 §11）；§7 表新增「路径隔离」行 |
| §5.2 | 客户端消费 `Retry-After` 退避信号 | ✅ 已完成 | [l3]（v5.8.5）：方案 B——`HttpOverrides.global` 透明包装 `HttpClient` **只 tap 封面 URL 响应头**，不换 `Image.network` 管线（原缓做前提被实测推翻，见 [j2] 改写）；饱和窗口骨架占位（TTL 30s，过期最坏 500ms 重建放行）+ 失败重试 max(指数退避, Retry-After)；b50h 16 例（纯逻辑/闸门 widget/loopback 端到端），7 个既有注入缝文件零改动全绿 |

---

## 10. 结论与后续

整体判断：**架构方向正确、链路兜底完善、未发现 P0 级缺陷**；核心矛盾是「功能复杂度已超出单文件承载能力」与「一处安全配置（凭据）与声明不一致」。优化按 ADR-3（安全）→ ADR-2（可维护性）→ ADR-4（链路背压）推进。

**执行状态（2026-10-14 更新）**：ADR-3 / ADR-4 均已实施；ADR-2 阶段 1 / 2a / 2b / 3a 已落地（[i7] / [l16] / [l17] / [l18] / [l19]，随客户端 v5.8.11 发布 [l20]），仅剩阶段 3b 主迁移；P1 / P2 全部落地，P3 落地 2 项（见 §9 状态标记）。**尚未完成的条目已逐条列于 §9.1**。

**后续动作**

1. ✅ 落地 ADR-3：凭据安全存储迁移 + 迁移用例（含失败回滚）。→ [i2]
2. ✅ 落地 ADR-4 与「阈值对齐」：封面背压对齐 ✅（[i4]）；头等待/看门狗阈值对齐 ✅（[j1]）；TTFB 探针接入监控 ✅（[l7]）（见 §9.1）。
3. 建议下一轮优先处理 §9.1 中「头等待阈值对齐」与「`Retry-After` 端侧消费」两项（均已成对出现、改动小、收益直接）。

---

## 11. 改造实施记录（Implementation Log）

> 权威代码仓库：客户端 `/workspace/MusicFlow-client`（230 主机，基线 `c8f590a` / v5.8.1）；服务端 `/workspace/MusicFlow`（基线 `b631661`）。本记录随改造逐项追加；除特别说明外均**未做 git 提交**（用户未要求）。

### [i2] P1 / ADR-3：媒体库凭据迁移至系统钥匙串 ✅

**背景**：drift(SQLite) 的 `music_libraries.password` / `api_key` 曾以**明文**落库，且表/模型注释误标为 "Encrypted"，与「已加密」声明不一致。

**改动（客户端）**

- [library_repository.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/data/repositories/library_repository.dart)
  - 写入路径 `addLibrary` / `updateLibrary`：凭据改经 `CredentialsStore.writeAll(scopeLibrary, id, {password, apiKey})` 进系统钥匙串（Windows DPAPI / Android Keystore）；drift 两列写 NULL（update 显式清空）。
  - 读取路径 `_mapLibrary`（改为 `async`）：凭据优先从钥匙串回填，drift 列仅作历史明文兜底。
  - 新增 `migrateLegacyCredentials()`：一次性把历史明文搬进钥匙串并清空列；**回读校验**确认落库成功才清空——钥匙串不可用（插件未注册 / Linux 缺 libsecret）时保留明文兜底，**宁可留旧明文也不丢凭据**；幂等、无明文时零开销。
  - `watchLibraries()` 改为 `async*`：订阅前自动执行一次迁移（避免在 `watch` 的 asyncMap 内写库引发二次发射）。
  - `deleteLibrary`：连带清除钥匙串凭据，杜绝孤儿凭据。
- [music_library.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/data/models/music_library.dart)、[music_libraries_table.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/data/sources/database/tables/music_libraries_table.dart)：修正误导性注释（不再宣称列内为密文）。
- 复用既有 `CredentialsStore`（`lib/core/services/credentials_store.dart`）与 `LocalStorage.saveServerConfig` 的既有范式，未新增存储设施。

**测试**

- 新增 [b50a_library_credentials_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/data/repositories/b50a_library_credentials_test.dart)（8 例）：明文不落库、钥匙串回填、update/delete 覆盖、历史明文迁移、订阅端到端自动迁移、迁移幂等、钥匙串不可用兜底。
- 更新 [b29b_library_repo_cov_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/data/repositories/b29b_library_repo_cov_test.dart)（13 例）：以内存 Map 假扮 `flutter_secure_storage` 平台通道（`plugins.it_nomads.com/flutter_secure_storage`）。

**验证**

- `flutter analyze`（改动文件）无 issue。
- 凭据相关回归区域（`test/data/repositories` + local_storage + providers + features/library + features/auth + features/settings + app_drawer + app 路由）共 **2128 例通过**；唯一失败 `b29a_crossfade_cov_test` 为**既有 flaky**（单跑 2 次均通过），与本次改动无关。

### [i3] P2：网络层竞态修复（FallbackInterceptor 重入护栏 + HealthChecker 串行化）✅

**背景**：两处共享可变状态在并发下可被同时驱动，导致重复的线路切换。二者都在「单线程事件循环 + `await` 让出」的模式下暴露竞态。

**改动（客户端）**

- [fallback_interceptor.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/core/network/fallback_interceptor.dart)
  - 缺陷：`_consecutiveFailures` 达阈值（≥2）后执行「markFailed → 切换 → 重试 → Toast」是一条**含 await 的长链**；多条在途请求并发失败时，各自都会进入该分支 → 重复切换、可能切到刚切走的线路、弹多条提示。
  - 修复：新增 `_failoverInFlight` 重入护栏。进入切换分支前置位、`finally` 复位；在途期间的并发连接错误在护栏处**直接上抛**，不再进入切换。切换后重试再失败时，其回流 `onError` 也被同一护栏短路（`_dio.fetch` 的 retry 不再复现递归）。
- [health_checker.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/core/network/health_checker.dart)
  - 缺陷：`Timer.periodic(30s, (_) => _check())` 不 await；慢网下单轮探测/切换（最坏 10s+）与下一轮 tick 重叠 → 并发 `probeAll` / `switchTo`。
  - 修复：新增 `_checking` 护栏，上一轮未结束则跳过本 tick；`_check` 主体包 `try/finally` 保证状态复位；周期回调与首轮统一 `unawaited`。

**测试**

- 新增 [b50b_health_checker_serial_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/core/network/b50b_health_checker_serial_test.dart)（2 例）：首轮挂起（`Completer` 门控）期间两个周期 tick 被跳过；一轮结束后下一周期恢复执行。
- 新增 [b50c_fallback_race_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/core/network/b50c_fallback_race_test.dart)（3 例）：三条并发连接失败**只切换一次**；切换后重试仍失败**不递归、无请求风暴、仅切换一次**；单次失败不切换（阈值语义未变）。用真 `Dio` + StubAdapter + `AddressPool` 子类计数 `switchTo`。

**验证**

- `flutter analyze`（4 个改动文件）无 issue。
- `flutter test test/core/network/` 全绿：**71 例通过**（含既有 66 例回归）。

### [i4] P2 / ADR-4：封面链路端到端背压对齐（客户端闸门 ↔ 服务端护栏 + 退避信号）✅

**背景**：客户端单机封面并发闸门上限为 6，而服务端封面渲染并发护栏 `COVER_RENDER_CONCURRENCY` 默认为 4；两端不对齐时，「冷缓存一屏封面」会在服务端渲染队列里堆积成慢请求，且多客户端叠加会进一步放大。ADR-4 的决策是「以服务端护栏为基准标定客户端并发，并让服务端在排队时给出退避提示」。

**改动（服务端）**

- [coverImage.ts](file:///c:/Users/ray5378/WorkBuddy/_stage/srv_coverImage.ts)
  - 新增压力快照 `getCoverPressure(): CoverPressure`（`active` / `queued` / `limit` / `saturated`）——把渲染管线（`activeRenders` / `renderWaiters` / `RENDER_CONCURRENCY`）的实时压力对外暴露。
  - 新增纯函数 `buildCoverPressureHeaders(pressure)`：**始终**回传 `X-MusicFlow-Cover-Concurrency`（并发上限）、`X-MusicFlow-Cover-Active`、`X-MusicFlow-Cover-Queued`；**饱和时**追加 `Retry-After: 1` 与 `X-MusicFlow-Cover-Saturated: 1`。抽成纯函数以便确定性单测（无需真把管线压饱和）。
- [routes/rest/index.ts](file:///c:/Users/ray5378/WorkBuddy/_stage/srv_rest_index.ts)
  - `/rest/getCoverArt` 在「解析到文件 → 渲染成功」分支的响应头（200 与 304 共用）上 `Object.assign` 压力头。**成功取图**的调用方（Web `fetch`/XHR）据此对齐自身封面并发并在饱和时退避。

**改动（客户端）**

- [cover_art_image.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/widgets/cover_art_image.dart)
  - 全局并发闸门上限 **6 → 4**，与 `COVER_RENDER_CONCURRENCY` 默认值对齐；补充注释说明对齐依据与「`Image.network` 读不到响应头、端侧暂不消费退避信号」的现状与后续改造方向（改为经 dio 拉字节再解码）。

**测试**

- 服务端新增 [coverImage.test.ts](file:///c:/Users/ray5378/WorkBuddy/_stage/srv_coverImage.test.ts) 内「封面端到端背压」4 例（空闲快照 / 未饱和头 / 饱和带 `Retry-After` / 占满无排队仍退避）。
- 服务端新增 [coverBackpressure.test.ts](file:///c:/Users/ray5378/WorkBuddy/_stage/srv_coverBackpressure.test.ts)（1 例）：造真实封面文件，经 `/rest/getCoverArt` 取图，断言响应头回传 `X-MusicFlow-Cover-Concurrency == RENDER_CONCURRENCY`、未饱和时无 `Retry-After`。
- 客户端更新 [b34c_cover_art_image_gate_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/widgets/b34c_cover_art_image_gate_test.dart)（8 封面 → 4 持槽/4 骨架）、[b38c2_cover_art_frames_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/widgets/b38c2_cover_art_frames_test.dart)（在途请求封顶 4）以匹配新上限。

**验证**

- 服务端 `npx vitest run tests/services/coverImage.test.ts tests/routes/coverBackpressure.test.ts`：**23 例通过**（2 文件）。
- 客户端 `flutter analyze`（3 个改动文件）无 issue；`flutter test test/widgets`：**172 例全绿**（含闸门相关既有回归）。

### [i5] P2：「统一连跳停止阈值」→ **评估后否决**（违反钉死契约），改落地契约兼容的「合并提示」 ✅

**结论先行**：§5.2 候选「统一『连跳停止阈值』为单一配置并提示用户」**不予实施**——与 2026-09-09 拍板、并在 CI **静态守卫**中钉死的播放链路契约正面冲突。「提示用户」这半可做且已做，故本项按「否决 + 落地兼容半」记录。

**证据（一手代码/守卫）**

- [playback-chain-guard.yml](file:///c:/Users/ray5378/WorkBuddy/MusicFlow/.github/workflows/playback-chain-guard.yml#L54-L66)：`Guard - no stop threshold in QueueController` 用 `grep` 断言 `backend/src/services/player/QueueController.ts` **不得**出现 `skipCounters|连续 .* 首不可播,停止`，且 `frontend/src/stores/player.ts` **不得**出现 `deadSongs|localFailStreak|LOCAL_MAX_FAIL_STREAK`；注释明写「2026-09-09 拍板:不可播逐曲移除,无限跳」。**任何回归即 CI 失败**。
- 客户端本机同契约：[player_provider.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_provider.dart#L1541-L1543) `_handlePlaybackError` 注释「**无停播阈值，无限跳**（用户拍板，2026-09-09）」。
- 四条链路**实况复核**（与 §5.1 表格的历史数值 5/8/3/5 不符）：

  | 链路 | 计数器 | 阈值 | 到阈动作 |
  | --- | --- | --- | --- |
  | 客户端本机（在线） | `_consecutiveFailSkips` | **无** | 仅作连跳节流：≥2 时给 `setUrl` 加 300ms 节流（[player_seek.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_seek.dart#L393-L399)） |
  | 客户端离线分支 | `_offlineFailSkips` | **2** | `pause()` 落暂停（D-058：离线时连跳节流闸不可达，单独保护）——**离线专属**，不涉被守卫覆盖的两处 |
  | 客户端直投 DLNA | `_stallCount` | **2** | 曲中段连续异常停止 → 跳下一首（stall 判定，**非**「连跳停止」） |
  | 服务端投 DLNA / Web 前端 | — | **无** | 不可播逐曲移除、队列自然排空；CI 守卫禁止阈值 |

**决策**：**否决**「统一停止阈值」。保留各链路经用户拍板的语义差异，不引入任何形式的新停播阈值。

**落地（契约兼容的一半）**

- [player_playback_helpers.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_playback_helpers.dart#L11-L25)：新增 `kFailSkipNotifyThreshold = 3` 与纯函数 `shouldNotifyFailSkipStreak({consecutiveFailSkips})`（**恰好**到阈值命中一次）。
- [player_provider.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_provider.dart#L1551-L1566)：`_handlePlaybackError` 在连跳达阈值时发**一条** warning Toast（新增 l10n `provider_playback_skipped_many`）——**只提示、不停止**：不停播、不落暂停态、跳过语义与既有契约完全不变。
- l10n：`app_zh.arb` / `app_en.arb` 新增键并 `flutter gen-l10n` 重生成（zh「已自动跳过 {count} 首无法播放的歌曲」/ en「Auto-skipped {count} unplayable tracks」）。

**测试**

- 新增 [b50f_fail_skip_notify_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/providers/player/b50f_fail_skip_notify_test.dart)：3 例（阈值前 0/1/2 静默、恰好 3 命中、超阈 4/10 不重复）。不重复性由「计数器仅在成功播放后清零」保证。

**验证**

- `flutter analyze`（3 个改动文件）：仅**既有** `info`（`annotate_overrides` / `prefer_interpolation_to_compose_strings` / `use_super_parameters`），无 error。
- `flutter test test/providers/player/b50f… test/providers/player/b29a_playback_helpers_cov_test.dart`：**24 例通过**。
- `flutter test test/providers/player`（播放内核全量回归）：**494 例全绿**。

### [i6] P3：封面换图平滑（gaplessPlayback）+ 位置轮询按窗口可见性降频 ✅

**背景**：两项体验/开销打磨。(1) `CoverArtImage` 换图（骨架→真图、离线缓存命中→解码完成）瞬间会闪一帧占位；(2) 位置轮询以固定 2Hz 常驻，窗口不可见（最小化 / 隐藏到托盘）时仍全速空转（§3.1 P2「位置轮询常驻 2Hz」）。

**改动（客户端）**

- [cover_art_image.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/widgets/cover_art_image.dart)：`Image.network` 与 `Image.file` 均加 `gaplessPlayback: true`，换图时保留上一帧，消除占位闪烁。
- [player_position_polling.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_position_polling.dart)
  - 新增可见性降频：回调开头读 `isRenderingActiveProvider`（前台激活 **且** 未隐藏到托盘）；**不可见**时每 `kHiddenPollDecimation`(=4) 个物理 tick 才做一次完整轮询（有效周期 = `kPositionPollBaseInterval` 500ms × 4 = 2s），其余物理 tick **直接返回**——不读 `player.position`、不写回 `state`，省掉后台的无谓重建。
  - **关键：抽稀 ≠ 停摆**。完整轮询按 `tickWeight` 加权累计（不可见 = 4、可见 = 1），使停滞 / 0 秒卡死 / 近末尾三道看门狗仍按**墙钟**阈值触发——后台播放遇卡死照常自愈，不会因降频被成倍拖慢。
  - `_ref.read` 包 `try/catch`：读取失败按**可见**处理（宁可按原 500ms 轮询，也不因一次读取失败拖慢看门狗）。
- [player_provider.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_provider.dart)：新增 `_hiddenPollCounter` 字段（降频抽稀计数）；新增 `app_visibility_provider.dart` import。

**测试**

- 新增 [b50e_pospoll_visibility_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/providers/player/b50e_pospoll_visibility_test.dart)（2 例）：① 降频契约（500ms × 4 = 2s）；② **不可见态仍保留看门狗**——0 秒卡死看门狗仍在墙钟阈值内触发重载（实测约 6s；若加权失效需 ~24s，本用例 12s 预算会失败，构成变异验证）。用例刻意不测「不可见时 UI 位置写回次数减少」，因 UI 位置实时推进由 `player.positionStream` 独立驱动，与轮询降频无因果关系。
- [b34c_cover_art_image_gate_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/widgets/b34c_cover_art_image_gate_test.dart) 新增 1 例：断言 `Image.network` 的 `gaplessPlayback == true`。

**验证**

- `flutter analyze`（3 个改动文件）：仅 6 条**既有** `info`（`prefer_interpolation_to_compose_strings` / `unnecessary_this` / `use_super_parameters` / `annotate_overrides`），均非本次引入。
- `flutter test test/widgets/b34c_cover_art_image_gate_test.dart`：**7 例通过**。
- `flutter test test/providers/player/b50e_pospoll_visibility_test.dart`：**2 例通过**（含 6s 计时用例）。
- `flutter test test/providers/player`（播放内核全量回归）：**491 例全绿**。（首次运行出现的 `b29a_crossfade_cov_test`「淡入途中再切歌」失败为**既有 flaky**——并行负载下计时敏感，单跑通过、复跑全绿。）

### [i7] ADR-2 阶段 1：巨型 provider 的「看门狗 / 队列」纯策略外提 ✅（ADR-2 阶段 1 落地；后续 2a/2b/3a 见 [l16]/[l17]/[l18]/[l19]）

**背景**：`player_provider.dart` 2875 行、`cast_peer_provider.dart` 2367 行。二者已按职责拆成一批 `part` mixin（`player_position_polling` / `player_playback_session` / `player_shuffle_queue` …），但 mixin 成员是**库私有**（`part of 'player_provider.dart'`），单测无法直达——复杂的看门狗阈值与队列落点逻辑只能靠重型的 provider 集成用例间接覆盖，回归慢、定位难。这正是 ADR-2「拆分为协作者、提升可测性」要解的痛点。

**为什么本阶段只做「纯策略外提」（决策与推迟理由）**

- 播放内核的**最大风险面是多平台真机行为差异**（Windows libmpv vs Android ExoPlayer；见 `player_position_polling.dart` 内多处平台专项注释与 2026-09/10 两次真机事故）。**当前无设备级回归条件**，贸然做「文件结构级重排 + 迁移 `NotifierProvider`」属高风险大改，其回归只能在真机上暴露。
- 故本阶段取**零行为变更**的一半：把内联在 mixin 里的**判定**逐字搬运为顶层**纯函数**（无副作用、无宿主依赖），mixin 只保留「读状态 → 调用纯函数 → 写字段 / 记日志 / 触发动作」。收益（可直接单测、职责边界显式）与风险（趋近于零）不对称地划算；风险大的结构重排留给有设备护航时再做。

**改动（客户端）**

- 新增 [player_watchdog_policy.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_watchdog_policy.dart)（看门狗协作者，纯函数）：
  - `classifyStreamLoadStuck(...)`（`StreamLoadStuckLevel` 三档归一：`idleNeverTookSource` / `loadingNoProgress` / `none`）+ `streamLoadStuckCeilingMs(...)`（三档上界选择：idle 10s > loading 30s > 兜底 30min）——把「流加载在途」的档位与上界判定从 `if` 嵌套里抽净。
  - `isInNearEndWindow(...)` / `isNearEndCompletionEngaged(...)`（末段窗口与「已应结束」）。
  - `nextStartupStuckTicks / nextStagnantTicks / nextNearEndStuckTicks(...)`（三道看门狗的计数转移，含 `tickWeight` 加权与 150ms 前进容差）。
  - `hasLeftStartup(...)`；常量 `kPositionProgressEpsilonMs=150` / `kStartupProgressResetThresholdMs=1500`。
- 新增 [player_queue_policy.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_queue_policy.dart)（队列协作者）：`resolveRestoredQueueIndex(...)`（恢复会话落点解析）、`isSameQueueBySongId(...)`（队列同一性）。
- [player_position_polling.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_position_polling.dart)：三处计数转移、近末尾窗口/结束判定、流加载卡死三档判定**全部改为委托**上表纯函数；字段、`_playDbg`、看门狗动作仍留在宿主。
- [player_playback_session.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_playback_session.dart)、[player_shuffle_queue.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_shuffle_queue.dart)：对应私有方法改为**一行委托**。
- [player_provider.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_provider.dart)：新增两个 policy `import`（`part` 文件不能自带 import，故落在库根）。

**行为等价性论证**

- 纯函数是原内联逻辑的**逐字搬运**（含 150ms/1500ms 阈值、`tickWeight` 加权、各清零分支），仅把「读私有字段」改为「入参」。
- 唯一可察的差异：`nextStartupStuckTicks` 的 `_shouldPreserveSeekPosition()` 由**短路求值**（`wantsPlaying` 为 false 时不调用）变为**无条件调用**。该方法为纯读取（[player_seek.dart#L487](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_seek.dart#L487-L495)），且在同一 tick 更早处（`player_position_polling.dart` 循环开头）已被调用作早退判断——**无副作用、结果不变**。

**测试**

- 新增 [b50g_watchdog_queue_policy_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/providers/player/b50g_watchdog_queue_policy_test.dart)（**24 例**，零成本纯测）：三档归一（含 idle 档「duration 必须为零」与 loading 档「刻意不看 duration」两条契约、1.5s 起点门限边界）、三档上界、末段窗口边界（剩余 2.5s / 2.501s、总时长 3s）、结束判定（在播 / 位置达末尾 / 窗口外）、三处计数转移（逐项否定 → 清零、加权累加、150ms 容差）、队列落点解析（空队列 / 命中 / 未命中夹取 / 无 id）、队列同一性。

**验证**

- `flutter analyze`（6 个改动文件）：**无 error**（仅既有 `info`：`annotate_overrides` / `unnecessary_this` / `prefer_interpolation_to_compose_strings` / `use_super_parameters` / `prefer_function_declarations_over_variables`，均非本次引入）。
- `flutter test test/providers/player/b50g_watchdog_queue_policy_test.dart`：**24 例通过**。
- `flutter test test/providers/player`（播放内核全量回归）：**518 例全绿**（= 既有 494 + 新增 24），证明三处 mixin 的委托改造**行为等价**。

**剩余阶段（推迟实施，附触发条件）**

1. **`cast_peer_provider.dart` 的同类纯策略外提**（SSDP/描述解析、会话选举判定）——低风险、可复制本阶段手法；触发：DR 会话/发现逻辑再次改动时顺手做。
2. **文件结构级拆分**（把 watchdog / 队列 / 音量 / 持久化从 `PlayerNotifierImpl` 抽成真正的协作者对象，而非 mixin）——触发：**建立多平台真机回归门槛**（至少 Windows + Android 各一套冒烟）后。
3. **`StateNotifierProvider` → `NotifierProvider` 迁移**——触发：上述结构调整落地时一并进行（Riverpod 生命周期/自动 dispose 价值随结构重排一并兑现）。

### [i8] 全量回归（客户端 `flutter test` + 服务端 `vitest run`）✅

**背景**：对本次全部改造项（[i2]~[i7]）做端到端回归——客户端与服务端**各自全量**跑一遍，并给出唯一失败项的**基线对照归因**。

**客户端（`/workspace/MusicFlow-client`：HEAD `c8f590a` + 本次未提交改动）**

- 命令：`flutter test`（全量）。
- 结果：**4086 通过 / 1 失败**（共 4087）。唯一失败为**既有 flaky**（下节给出基线对照），非本次改动引入。
- 播放内核专项（`flutter test test/providers/player`，含本次新增 `b50e`/`b50f`/`b50g` 共 29 例）：**518 例全绿**。

**既有 flaky 的基线对照归因（关键）**

- 现象：全量跑的**唯一**失败随批次漂移——一次是 [b36c_offline_cache_settings_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/providers/offline/b36c_offline_cache_settings_test.dart)「构造时读取默认设置并同步到管理器」，另一次是 [b29a_crossfade_cov_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/providers/player/b29a_crossfade_cov_test.dart)「淡入途中再切歌 → 定时器自 cancel + 音量恢复」。二者**单跑均通过**。
- 基线对照：用 `git worktree` 检出 **HEAD（不含本次任何改动）**，在同机对 `b29a_crossfade_cov_test.dart` 反复单跑——冷启动 **16 次 2 败**、warm 复跑 **12 次 6 败**；改动树同法为 **15 次 6 败 / 10 次 4 败**。**同一失败分布**（≈50% warm）。
- 根因：该用例的判定是「`playCount≥1` 后清空音量序列 → `Future.delayed(40ms)` → 至少 2 档半坡值」；而 `fadeMs=500` ⇒ 25 步 ⇒ 步进**恰为 20ms** ⇒ 40ms 窗口期望刚好 2 个 tick、**余量为 0**，任一 timer 合并/漂移即失败。**属测试自身设计过紧**（零余量），与本次改动无关。
- 附加对照（排除法）：本次唯一可能影响事件循环的新增动作是 [player_position_polling.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_position_polling.dart) 里每 500ms 一次的 `_ref.read(isRenderingActiveProvider)`。把它**临时改为常量**后复跑 10 次（6 通过/4 失败），**失败率未变** → 排除本次改动为诱因。（实验后已还原，`grep` 确认现场干净。）

**服务端（`/workspace/MusicFlow/backend`：含 [i4] 未提交改动）**

- 命令：`npx vitest run`（全量）。
- 结果：**500 个测试文件全部通过；6739 通过 + 1 个 expected fail（共 6740）；0 失败**。耗时 **923.58s（≈15.4 min）**。

**收尾一致性核验（远端 ↔ 本地镜像）**

- 对 [i7] 涉及的 7 个文件（`player_watchdog_policy.dart` / `player_queue_policy.dart` / `player_position_polling.dart` / `player_playback_session.dart` / `player_shuffle_queue.dart` / `player_provider.dart` / `b50g_watchdog_queue_policy_test.dart`）在远端 `md5sum`，与本地镜像逐一比对：**7/7 完全一致**（`7a9d508a…` / `99a58d01…` / `5ce9b3c3…` / `13d0306f…` / `e16db504…` / `1b5d173e…` / `d8c4023b…`），确认报告中引用的行号/内容与远端权威代码吻合。
- 现场洁净性：`grep -rn "TEMP-EXPERIMENT"` 命中 **0**；`git worktree list` 仅剩 `/workspace/MusicFlow-client c8f590a [main]`；临时物 `/tmp/mf-base`、`/tmp/remchk`、`/tmp/pp_i7.bak` 均已清除。
- 改动清点：`git status --short` 显示 19 个已跟踪文件 `M` + 8 个新增未跟踪文件（`player_watchdog_policy.dart`、`player_queue_policy.dart`、`b50a_library_credentials_test.dart`、`b50b_health_checker_serial_test.dart`、`b50c_fallback_race_test.dart`、`b50e_pospoll_visibility_test.dart`、`b50f_fail_skip_notify_test.dart`、`b50g_watchdog_queue_policy_test.dart`），与 [i2]~[i7] 登记内容一一对应。

**说明**：本次所有改动**均未 `git commit`**（用户未要求）。

### [j1] §4.2 P2：整曲缓冲「首字节等待」↔ 客户端看门狗判死上界 → **已对齐 + 加契约守卫** ✅

**结论先行**：核验后确认**两侧本就对齐**（服务端 6s **严格小于** 客户端 idle 判死 10s，余量 4s），因此**未改动任何常量值**；本轮把这条隐式关系显式化并加双向守卫，防止后续单侧调参造成「服务端还在合法缓冲、客户端已抢先判死」。

**证据链**

- 服务端：`STREAM_BUFFER_HEAD_WAIT_MS = 6000`（[rest/index.ts](file:///c:/Users/ray5378/WorkBuddy/_stage/srv_rest_index.ts#L2020)，env 可覆盖）；其取值理由在源码注释中已写死——**须低于反向代理首字节超时 10s**，否则 502。
- 客户端三档「流加载在途」上界（[player_provider.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_provider.dart#L192-L225)）：idle=**10s** / loading=**30s** / 兜底=**30min**。
- 另有「0 秒卡死」看门狗阈值 6s（12 tick × 500ms，[player_position_polling.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_position_polling.dart#L4)），但它有**在途加载守卫**——网络流 `setUrl` 未返回期间不介入并清零计数，故与「服务端 6s 头等待」不构成冲突；真正承载判死的是上述三档上界。

**改动**

- 客户端 [player_watchdog_policy.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_watchdog_policy.dart#L72-L98)：新增 5 个命名常量（`kServerStreamBufferHeadWaitMs` / `kStreamLoadIdleCeilingMs` / `kStreamLoadNoProgressCeilingMs` / `kStreamLoadFallbackCeilingMs` / `kStreamLoadHeadWaitAlignmentMarginMs`）并写明跨仓契约。
- 客户端 [player_provider.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/providers/player/player_provider.dart#L192)：三处 debug 字段默认值由字面量改为引用常量（**值不变，行为等价**），另在 idle 档注释补跨仓约束。
- 客户端 [b50g_watchdog_queue_policy_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/providers/player/b50g_watchdog_queue_policy_test.dart#L479-L545)：新增「六、跨仓契约」5 例（余量下界 / 严格小于 / loading 档远大于 / 兜底最宽 / 三档选择自洽）。
- 服务端 [rest/index.ts](file:///c:/Users/ray5378/WorkBuddy/_stage/srv_rest_index.ts#L2012-L2020)：该常量的文档注释补「跨仓契约」段，并把常量 `export` 出来供守卫用例引用。
- 服务端 [bufferHeadWait.test.ts](file:///c:/Users/ray5378/WorkBuddy/_stage/srv_bufferHeadWait.test.ts#L175-L193)：新增 1 例——断言默认 head-wait 严格低于客户端 idle 判死上界且留 ≥1500ms 余量。

**验证**

- 客户端 `flutter analyze`（3 个改动文件）：**0 error**（4 条既有 `info`，均非本次引入）。
- 客户端 `flutter test test/providers/player/b50g_watchdog_queue_policy_test.dart`：**29 例通过**（原 24 + 新 5）。
- 客户端 `flutter test test/providers/player`（播放内核全量）：**522 通过 / 1 失败**——唯一失败为**既有 flaky** `b29a_crossfade_cov_test`，详见 [j4] 与 [i8] 基线对照，**非本次改动引入**。
- 服务端 `npx vitest run tests/source/bufferHeadWait.test.ts`：**4 例通过**（原 3 + 新 1）。

**为什么不动常量值**：6s 是「低于反代 10s 超时」的既有拍板值；10s/30s 是在 libmpv 位置采样粗糙前提下刻意留出的余量。无真机回归条件时改动任一侧都属产品行为变更（或更早判死、或更久无响应），故只落地「文档 + 不变式 + 双侧守卫」，把调参权留给有回归条件时的人。

### [j2] §5.2：客户端消费 `Retry-After` 退避信号 → **已实施（方案 B）** ✅

**结论翻转**：本条原判「缓做」，前提是「`Image.network` 读不到响应头、必须换 dio 字节解码管线」。2026-10-13 一手实测**推翻该前提**：

- `HttpClient()` 工厂确实走 `HttpOverrides.global`（探针脚本实证：安装后工厂被拦截）；
- Flutter SDK 源码核实：`NetworkImage` 的 client 是 `static final HttpClient()`（懒初始化共享，非「每次请求 new」），且 `debugNetworkImageHttpClientProvider` 仅在 assert 模式生效——**在 `runApp` 前安装全局 `HttpOverrides` 即可拦截全部网络图片流量，测试注入缝零影响**。
- 服务端信号在**成功响应头**（200/304 附 `X-MusicFlow-Cover-Saturated` / `Retry-After`，`routes/rest/index.ts:2762` 附近），渲染队列满时排队出图、不回 503——客户端「靠加载失败感知饱和」不存在，必须读响应头。

**实施（[l3]，客户端 v5.8.5）**：新增 `lib/core/network/cover_pressure_observer.dart`——`HttpOverrides.global` 透明包装 `HttpClient`（main.dart 在 runApp 前安装），全接口编译期委派、**只 tap 封面 URL（path 以 `/getCoverArt` 结尾）的响应头**，其余流量零行为改变；`Image.network` 管线不动。`CoverArtImage` 两处消费：① 饱和窗口内 `acquire` 前直接拦下（骨架占位、不占槽不入队，信号 TTL 30s、过期最坏 500ms 重建放行）；② `_scheduleRetry` 延时取 `max(指数退避 1s/2s, Retry-After)`。测试 `test/core/network/b50h_cover_pressure_test.dart` 16 例：头解析纯逻辑（大小写/非法值/TTL 过期）、闸门 widget（饱和零请求/过期恢复 4 并发/max 退避）、本地 `HttpServer` loopback 端到端（真响应头→信号；非封面流量不记录）。7 个既有 `debugNetworkImageHttpClientProvider` 注入缝文件零改动全绿。

**环境事实（本机 Dart 3.13 实测，SDK 仅发 .dill 无源码，接口以编译器/探针为准）**：`HttpClientRequest` 无 `response` getter 与 `contentType` setter（响应统一由 `close()` 返回）；`HttpOverrides.global` 与 `HttpClient` 的 `authenticate`/`badCertificateCallback`/`keyLog`/`findProxy`/`connectionFactory` 均为 **set-only**（有 setter 无 getter）；`HttpHeaders.forEach` 的 value 为 `List<String>`。

### [j3] §3.3 四处 `[unverified]` 核验（只读） ✅

核验结论已逐条写入 §3.3「历史问题复核结论」表（#3/#4/#7/#8），摘要：

- **#3 offline_cache_manager**：**部分成立** —— 索引写**已原子化**（`.part` + `rename`；拷贝同法），但 `init()` **不扫描**各 kind 目录，索引损坏即清空重建 ⇒ 未被索引的文件成孤儿（轻度磁盘泄漏，非安全问题）。
- **#4 aggregate_search_results 在 build 里 new Future**：**不成立（假阳性）** —— `SearchRequest` 有值相等（`==`/`hashCode`），family key 每次 build 相等，不会重复建/丢 Future；且被 4 个页面 import，非死代码。
- **#7 StoragePermissionService 死代码**：**成立** —— 全仓（dart/xml/plist/gradle/kt/java）除定义文件外 **0 引用**。
- **#8 pubspec 未使用依赖**：**cached_network_image 成立** —— `lib/`、`test/` 零引用而 pubspec 仍列 `^3.4.1`；其余依赖未逐项核验。

**清理（已由 [k1] 执行）**：删除 `StoragePermissionService`（1 文件、0 引用）；从 pubspec 移除 `cached_network_image`（并 `flutter pub get` 同步 lockfile）。**修正**：`permission_handler` 经核验**仍被** `notification_permission_service.dart` 使用，**保留**（未随死代码移除）。

### [j4] 收尾回归：客户端播放内核全量 + 服务端播放链路 CI 守卫 ✅

**背景**：对 [j1] 改动做定向回归（不重跑全量；全量结论见 [i8]）。

**客户端（`/workspace/MusicFlow-client`）**

- 命令：`flutter test test/providers/player`（播放内核全量，含本次新增 `b50g` 5 例）。
- 结果：**522 通过 / 1 失败**。
- 唯一失败：`b29a_crossfade_cov_test.dart`「_fadeIn · 会话变更中止（源码 90-95） 淡入途中再切歌 → 定时器自 cancel + 音量恢复」。**既有 flaky**：单文件复跑 5 次得 **3 过 / 2 败**，与 [i8] 用 `git worktree` 检出的 HEAD 基线（冷启动 16:2、warm 12:6）**同一失败分布（≈50% warm）**；根因是 `fadeMs=500 ÷ 25 步 = 20ms` 恰等于 `Future.delayed(40ms)` 窗口、**余量为 0** 的测试设计过紧，与 [j1] 无关。

**服务端（`/workspace/MusicFlow/backend`）**

- 命令：**播放链路 CI 守卫用例集**（与 [playback-chain-guard.yml](file:///c:/Users/ray5378/WorkBuddy/_stage/playback-chain-guard.yml#L47-L52) 的 `Run playback chain guard tests` 步骤**逐字对齐**，11 个文件）：
  `npx vitest run tests/routes/dlnaStreamUrlGuard.test.ts tests/routes/streamRemoteFallback.test.ts tests/source/online/streamFallback.test.ts tests/source/online/streamFallbackEvict.test.ts tests/player/QueueController.test.ts tests/player/queueChangedLeakGuard.test.ts tests/rest/scrobbleMethodGuard.test.ts tests/routes/queueTransfer.test.ts tests/frontend/playerContract.test.ts tests/frontend/playContentContract.test.ts tests/services/contentOrder.test.ts`
- 结果：**11 文件 / 72 例全通过**，`GUARD_EXIT=0`（Duration 12.68s）。
- 静态守卫（与 yml 同款 `grep` 断言，本机复跑）：`backend/src/services/player/QueueController.ts` 无 `skipCounters`/「连续…首不可播,停止」→ **OK**；`frontend/src/stores/player.ts` 无 `deadSongs`/`localFailStreak`/`LOCAL_MAX_FAIL_STREAK` → **OK**。即 2026-09-09 拍板的播放链路三契约（**无停播阈值、不可播逐曲移除、无限跳**）未被 [j1] 破坏。

**核验（远端 ↔ 报告引用一致性）**

- 把 [player_watchdog_policy.dart](file:///c:/Users/ray5378/WorkBuddy/_stage/client_player_watchdog_policy.dart#L72-L98) 与 [playback-chain-guard.yml](file:///c:/Users/ray5378/WorkBuddy/_stage/playback-chain-guard.yml) 从远端 `get` 到本地 `_stage` 复核：常量段位于 **L72-L98**（与报告中 [j1] 的链接一致），守卫用例清单与服务端实际执行集逐字吻合。

**说明**：本轮全部改动**均未 `git commit`**（用户未要求）。

### [k1] §9 #12：历史死代码 / 未使用依赖清理（用户批准后执行）✅

**背景**：承接 [j3] 的只读核验结论，在用户批准后执行删除。**动手前先在现行远端代码上复核一遍**（核验与执行之间代码可能已变），以免误删。

**复核 → 执行（远端 `/workspace/MusicFlow-client`，HEAD `c8f590a`）**

- `StoragePermissionService`：全仓（`dart`/`kt`/`java`/`xml`/`plist`/`gradle`，排除 `.git` 与 `build`）**仅** `lib/core/services/storage_permission_service.dart` 定义处命中，**0 外部引用** ⇒ 执行 `rm lib/core/services/storage_permission_service.dart`；删除后对 `lib test android ios` 复扫，**无残留引用**。
- `cached_network_image`：`lib/`、`test/` 对 `cached_network_image` / `CachedNetworkImage` / `flutter_cache_manager` **零引用** ⇒ 从 `pubspec.yaml` 删除该依赖行。
- **`permission_handler` 予以保留（关键修正）**：核验时曾记「若仅由死代码引用则可一并移除」，实测它**仍被** [notification_permission_service.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/lib/core/services/notification_permission_service.dart#L2) 引用，且 [b38b3_notification_permission_cov_test.dart](file:///c:/Users/ray5378/WorkBuddy/mf-client-dbg/test/core/services/b38b3_notification_permission_cov_test.dart#L5) 覆盖其平台通道 ⇒ **不可移除**。这正是 [j3] 中「视其唯一用途评估」的落地结论。

**验证**

- `flutter pub get`：**EXIT=0**；输出 `Changed 4 dependencies!`，移除了 `cached_network_image 3.4.1` + `cached_network_image_platform_interface 4.1.1` + `cached_network_image_web 1.3.1` + `octo_image 2.1.2`。
- `flutter analyze`（全仓）：**0 error**（67 warning + 281 info，均为**既有 lint 债**——含 `test/`、`tool/` 目录；逐条检查**无一条**指向被删文件或被移除依赖）。
- `flutter test test/core`：**570 例通过**，`EXIT=0`。
- 残留检查：`pubspec.yaml` / `pubspec.lock` / `lib` / `test` 中 `cached_network_image`、`octo_image` **零残留**。

**镜像同步**：本地镜像 `mf-client-dbg` 已同步——删除 `lib/core/services/storage_permission_service.dart`，并刷新 `pubspec.yaml` / `pubspec.lock`（与远端一致）。

**说明**：本轮全部改动**均未 `git commit`**（用户未要求）——随后已由 [m1] 全部落库发版。

### [m1] 正式发版记录：客户端 v5.8.2 / 服务端 v4.6.6 ✅

**背景**：用户指示「提交到 230 主线后通过 230 提交 GitHub 并发正式版本」。按两侧 `docs/RELEASE_POLICY.md`（`vX.Y.Z`、patch 随时可发、只认 tag 触发）执行；版本定位 patch（改动集以修复/重构/清理/内部改进为主，无新用户可见功能）。

**客户端 MusicFlow-client · v5.8.2**

- commit `7ca126f`（31 文件，+2239/−309），main `c8f590a → 7ca126f`，tag `v5.8.2`；CHANGELOG 插入 `[5.8.2]` 条目（LF 校验通过）。
- 发版前全量 `flutter test`：**All tests passed（4092 用例，0 失败）**。
- CI：**8/8 workflow 全绿**（Test Suite / Build Client / Version Guard / Boot Latency / Desktop Lyric / GPU Render / Peer Order / UI Guard），Release v5.8.2 已产出。
- 内容：P1 媒体库凭据治理（Subsonic 密码改入系统钥匙串 + 幂等迁移）、回退失败计数竞态/健康检查串行修复、封面并发对齐（6→4）、位置轮询可见性降频、ADR-2 阶段 1 纯策略外提、跨仓阈值契约、死代码与依赖清理（[k1]）。

**服务端 MusicFlow · v4.6.6**

- commit `9a8691b`（6 文件，+218/−3），main `b631661 → 9a8691b`，tag `v4.6.6`；CHANGELOG 插入 `[4.6.6]` 条目（CRLF 校验通过）。
- 发版前全量 `npx vitest run`：**500 文件 / 6740 用例通过 + 1 expected fail（0 失败）**，Duration 767s。该 `1 expected fail` = `tests/sendspin/connectionHandshake.test.ts:236` 的 `it.fails(...)` **哨兵标注**（Sentinel Fallback 已知问题，故意标 fails、不参与门禁），非新增失败。
- CI：tag v4.6.6 **5/5 全绿**（build-and-push / contract-gate / Version Guard / security / sync-to-gitee），版本镜像已产出，Release v4.6.6 已发布。
- 提交时显式排除未跟踪杂物：`backend/.ci56*.py`、`backend/.cov-main*/`、`交接工作不可以提交.md`。

**说明**

- 本条即 [j1]–[k1] 全部改动的落库动作（此前各节「未 git commit」的标注已随发版全部提交）。
- **240 生产容器升级未执行**（pull → compose up -d → /ping）：属生产变更，待运维窗口/用户显式批准后单独执行。

### [m2] B 项根治：QuickJS `gc_obj_list` 断言归因与修复（v4.6.7）✅

**背景**：用户选定 B 项（测试输出中的 `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c,2036,JS_FreeRuntime)` 与 `1 expected fail`）并批准「补 dispose() 清理」根治。

**归因（三件套聚焦跑实测 4 处断言）**

| # | 出处 | 性质 |
|---|------|------|
| 1 | `sandboxHostDispose.test.ts`「反差(灵敏度校准)」 | **设计内**：故意泄漏，证明捕获有判别力 |
| 2 | `jsenvTeardown.test.ts`「② 反差(灵敏度校准)」 | **设计内**：同上（P0 守卫的灵敏度自检） |
| 3 | `sandbox.test.ts`「并发 OOM 自愈:SIGABRT 防线」 | **设计内**（时序依赖，非必然复现）：用例本身即证明 abort 不带走 worker |
| 4 | `sandbox.test.ts`「加载失败后仍可继续加载其他插件(模块不毒化)」 | **附带残留（唯一非设计内）**：单测隔离可稳定复现 1 条 |

**根因**：`SandboxHost.init()` 的 create(host) 抛错分支（`implResult.error`）在 `this.dispose()` 前**未释放 `pluginHandle`**——其余四个 init 失败分支均先行释放。残句柄把对象引用计数钉在 gc_obj_list 上，`runtime.dispose()` 命中 `list_empty` 断言 → emscripten abort（被 catch 后 `markModulePoisoned()` 毒化共享 WASM module，下一次加载经 `getQuickJS()` 重建全新 module，故用例仍绿、噪声只在日志）。

**修复**：该分支补一行 `pluginHandle.dispose()`（与其余失败分支对齐）。

**验证**

- 隔离跑「加载失败」用例：断言数 **1 → 0**，用例通过。
- 三件套聚焦跑：断言数 **4 → 2**（余下 2 处均为设计内校准用例），3 文件全通过。
- 全量 `npx vitest run` 回归：**500 文件全过 / 6740 passed + 1 expected fail / 0 失败**，Duration 771.72s；全量日志 `Aborted` 计数 = **2**（两处设计内校准用例，附带残留已消失）。

**附带说明**

- `1 expected fail` 为 `it.fails` 哨兵（见 [m1]），不属异常。
- 全量另报 1 条 vitest worker teardown 竞态噪声（`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`，源自 `src/services/sendspin/trackChangeKeepStream.test.ts`）：文件跑完后仍有挂起 console 输出所致，与本次改动无关、不影响结果，属既有基建噪声（时序性、非每次复现）。

**发版**：门禁通过后按既定流程发 **v4.6.7**（patch）：commit `3f3b847`（2 文件，+6/−0），main `9a8691b → 3f3b847`，tag `v4.6.7`；CHANGELOG 增补 `[4.6.7]` 条目（CRLF）。CI **5/5 全绿**（contract-gate / Version Guard / security / sync-to-gitee / build-and-push 版本镜像），Release v4.6.7 已发布；main `3f3b847` 的 build-and-push（含全量测试门禁）亦全绿。

### [m3] 本报告入库 230 文档库（交接用）✅

- 按用户要求：本报告**仅提交到 230 文档库用于交接**，**不 push GitHub、不跟随发版**。
- 位置：`/workspace/MusicFlow/docs/MusicFlow客户端与服务端架构与优化分析报告-2026-10-13.md`，**保持 untracked**（与 `交接工作不可以提交.md` 同一原则——防止随任何后续 push 带上 GitHub 公开仓库）。

### [m4] 新发现并已根治：main「全量测试门禁」间歇失败——根因为 JUNK 随机样本被伪解析（方案 A）✅

**现象**：push 9a8691b 后 main 的 `build-and-push` 中「全量测试门禁 (vitest, 非阻塞/失败回滚)」job 失败（run 38323997705），触发「回滚发版」job 成功执行——`:latest` 镜像未被 9a8691b 更新（回滚保护生效）。**tag v4.6.6 同一 commit 的 build-and-push 全绿、版本镜像与 Release 正常**，正式发版链路不受影响。

**失败用例（2 例，均在 `tests/fetch/probe.test.ts`）**：「无法解析的垃圾文件 → 抛 FetchProbeError(INTEGRITY_FAILED)」与「requireAudio:false 时不因无音频流抛错」——断言 `rejects`，实测 `promise resolved`，且 resolved 结果含 `"path": ".../junk.bin", "sampleRateHz": 8000`。

**根因（深挖修正，推翻初判）**：初判「runner ffprobe 版本漂移」**有误**——`probeFile`（`backend/src/services/fetch/probe.ts`）全程使用 `music-metadata`（^11.14.0，纯 JS 实现），根本不调用 ffprobe/ffmpeg，pin ffmpeg 无的放矢。**真因**：JUNK 样本用 `randomBytes(4096)` 生成，属**非确定性**随机字节，偶发被 music-metadata 伪解析成功——CI 日志实证随机内容 resolved 出 `sampleRateHz: 8000`，「必解析失败」的前提不再成立，断言落空。间歇性由此而来：同一代码 230 本地多次全绿、紧随其后的 `3f3b847` push 门禁全绿，均因随机内容恰好未踩中。样本预期语义（垃圾文件必抛错）本身有效，问题仅出在样本的非确定性。

**证据链**：230 本地实测候选样本各 30 次——全零 `Buffer.alloc(4096)` 30/30 稳定抛 `INTEGRITY_FAILED`；`ff_fill`（全 0xFF）会 RESOLVED（不可用）；随机 8192B×60 次未复现恰证偶发性。CI 侧两例失败 run 均见 resolved sr=8000。

**处置（方案 A，用户已批准，已实施）**：`tests/fetch/probe.test.ts` 中 JUNK 样本由 `randomBytes(4096)` 改为**确定性全零** `Buffer.alloc(4096)`，并移除仅剩此用的 `randomBytes` import；两例用例断言语义不变，另留注释记录「纯文本→随机→全零」的样本演化教训。commit `3509714`（`fix(test): probe JUNK 样本改确定性全零,消除随机字节伪解析成功导致的门禁间歇翻车`），纯测试改动：**不 tag、不发版、CHANGELOG 不动**。单文件验证通过（1 file passed）后 push main（`3f3b847..3509714`），由 CI 全量门禁兜底。

**CI 结果（已确证）**：main push `3509714` 触发的 9 条工作流**全部 success**——`build-and-push`（含全量测试门禁，run [38329446804](https://github.com/ray5378/MusicFlow/actions/runs/38329446804)）completed/success，另 Version Guard、Sendspin Guard、Playback Chain Guard、pentest、frontend-responsive、security、sync-to-gitee 及 `ci` 均绿。门禁间歇翻车源已消除，回滚保护不再被误触发。

---

### [l1] §9 #10：大页面按区块抽子组件（纯搬运零行为变更）✅

**范围**：`full_player_page.dart`（1590 行）→ 681 行、`discover_page.dart`（1314 行）→ 505 行、`mini_player.dart`（1164 行）→ 449 行；新增 14 个子组件文件（`lib/features/player/widgets/` 8 个 + `lib/features/discover/discover_page_support.dart` + `lib/features/discover/widgets/` 5 个），私有 widget 类按 build 边界搬入 `widgets/` 子文件，provider 逻辑零改动。

**关键手法**：行区间手术脚本（本地 UTF-8 编写 → put 到 230 执行，避免 heredoc 中文二次解析）；230 工作区为 LF（传输副本的 CRLF 是通道引入的假象，`git ls-files --eol` 核实），手术全程保 LF；`discover_page.dart` 加 export 兼容层，历史测试 import 无缝；lib 内仅 `FullPlayerPage` 跨文件引用（留在原文件）。

**验证**：`dart analyze lib/features` 0 error 0 warning；`flutter test test/features/player test/features/discover` **622 全绿**；`git status` 干净（3 M + 14 ??）。commit `5e891e8` 只推 main 不打 tag（重构零行为变更，沿 c51dc98 先例）。

### [l2] §9 #11：UI 样式常量沉淀回 `core/design` ✅

**反直觉核实**：手术前统计的「~53 处 Colors.\* 直用」系 grep 模式误匹配 `MusicFlowColors.*` 子串所致。手术后逐文件词边界重核：间距/圆角**早已 token 化**（0 字面量）；裸 `Colors.*` 仅 13 处且**全为 `Colors.transparent`**（无语义色，按既定决策保留原样）。真实债务仅 **4 处 fontSize 字面量**。

**动作（值等价、零视觉变化）**：`full_player_page.dart` 的 24（层级外值，display 26 −2 派生）与 15（→ `typography.title.fontSize`）；`player_lyrics_pane.dart` 的 15（同上）与 13（→ `typography.body.fontSize`）——沿用仓内 457-465 行既有的「token 派生 + fallback」模式。顺带清除 `add_to_playlist_sheet.dart` 2 处历史 unused import（k1 清理 `cached_network_image` 后的遗留 warning）。

**验证**：`flutter test test/features/player` **343 全绿**（视觉断言未破）；analyze 0 error 0 warning。

### [l3] §5.2：客户端消费 `Retry-After` 退避信号（方案 B，v5.8.5）✅

详见 [j2] 改写段。要点：`HttpOverrides.global` 透明包装只 tap 封面 URL 响应头（不换 `Image.network` 管线）；`cover_art_image.dart` 饱和窗口拦 acquire（骨架占位 + 500ms 观察定时器）+ 重试 `max(指数, Retry-After)`；b50h 16 例全绿；7 个既有注入缝文件零改动全绿。commit `6e30d4a` + annotated tag `v5.8.5`（tag 组 8 workflow：UI Guard / Test Suite / Boot Latency / GPU Render / Build Client / Peer Order / Version Guard / Desktop Lyric Guard）。

### [l4] 发现页启动加速：屏外预取推迟到首屏就绪后（v5.8.6）✅

**用户反馈**：发现页应按「不同客户端自行编辑后的模块」的可视窗口严格从上到下加载，不显示的位置的封面根据视口懒加载——现状没实现。

**根因定位**：模块顺序与显隐本就完备（`home_section_layout_provider` + `home_section_registry` 的 `applyHomeSectionLayout` / `hoistClientOwnedSection`，用户编辑优先、隐藏模块零请求）；分区 widget 数据均为「build → watch provider」视口驱动；分区内横向列表 8 处已 `cacheExtent: 0`（只构建视口内项、封面随构建懒加载）。唯一破坏点是 batch44 引入的 `_scheduleSectionPrefetch`：首帧后即按排版序 ×100ms 把全部屏外分区（recent-playlists / home-recommend / local-recommend / platform-recommend）的 provider future read 触发——冷启动 ~500ms 内所有模块请求全发，与首屏抢连接池与带宽，拖慢启动显示。

**实施方案（预取保留、时机后移）**：`_scheduleSectionPrefetch` 首帧后改为只 await 已进入构建范围的分区（itemBuilder 登记的 `_builtSectionKeys`，对其 `ref.read` 幂等空转、不重复请求），屏外分区不进等待集合、绝不提前触发；首屏 future 全部完成（失败也放行，不阻塞）后才按排版序错开补齐。慢网络下等待更久、首屏永远优先，冷启动带宽全部让给首屏模块。等待期吞错误用 `.then((_) {}, onError: ...)` 归一 `Future<void>`（闭包真实返回 `Future<List<...>>`，`catchError` 的 onError 返 null 会撞 ArgumentError——`discover_page_test` 实证）。

**验证**：b44 重写 5 例全绿（新增「首屏 2s 慢加载 → 屏外零发起，就绪后才补齐」钉死新语义）；`flutter test test/features/discover/` **280 全绿**；`flutter test test/features/` **1391 全绿**；`dart analyze lib/` 142 存量、零新增（门禁 `--no-fatal-warnings` 同基线）。commit `edd0168` + annotated tag `v5.8.6`。

### [l5] §4.2 P3：Range「全流 200」契约测试固化 ✅

**背景**：报告 §9.1 最后一项代码内未做项——`/rest/stream` 的 Range 语义（P2-1：实时管道流没有字节总量可供续传，一律忽略 Range 走全流 200，seek 走 timeOffset 重拉）**现状已正确但缺契约用例固化**，无锁防回归。

**动作**（`backend/tests/rest/pipelineContract.test.ts`，+67 行，零 src 改动）：头注释契约清单补 ⑤；尾部追加 `describe("P2-1 Range 契约")` 5 例——① `Range: bytes=0-` → 200（非 206）、无 Content-Range / Content-Length / Accept-Ranges、body 完整 fLaC；② 中段 `bytes=100-200` → 仍 200 全流（不从第 100 字节起、不截断）；③ 后缀 `bytes=-500` → 仍 200；④ Range + timeOffset 组合 → Range 被忽略不影响 timeOffset 定位语义；⑤ 结构锁：/stream handler 段不得出现任何 Range 头解析（`c.req.header("range")` / `headers.get("range")` / `parseRange` / `Accept-Ranges`）。复用文件既有真实链路 harness（真 Hono app + 真 DB + ffmpeg fixture），与结构锁 ③（无 Range 旁路）形成「结构 + 行为」双锁——防的是未来有人给管道流补 Range 支持（Web Howler / Flutter just_audio 按标准 Range 语义解析，206 会把音频碎片当整曲解码 → 播放位置错乱）。

**验证**：pipelineContract 19/19 全绿（原 14 + 新 5）；`npx vitest run tests/rest` 11 文件 115/115 全绿。commit 纯测试加固、零行为变更 → 只推 main 不打 tag（c51dc98 先例）。

### [l6] §4.2 P3：预取/播放路径单飞红线纳入适应度函数（§7「路径隔离」行）✅

**背景**：§9.1 中代码内可做的项已清零——`prefetchCache.ts` 文件头三条红线的前两条（①不共用播放路径 single-flight；②不动播放路径超时）虽是「违反即事故」级约束，但仅红线 1 有行为锁（③ 组：预取后 `retryLoops` 为空），红线 2 无任何锁，§7 适应度函数表也未登记该行——设计约束仅靠注释维系，没有失败响应。

**动作**（`backend/tests/source/prefetchCache.test.ts`，零 src 改动）：文件头守卫清单补 ⑩；追加 `describe("⑩ 适应度函数:预取/播放路径边界")` 五例——(a) 源码锁：`prefetchCache.ts` 非注释代码不得出现 `fetchSongWithRetryWindow`（正向断言只走 `fetchWholeSongBuffered`）；(b) 源码锁：非注释代码不得写播放路径超时 env/常量（`process.env.STREAM_BUFFER_*=` / 常量赋值——写 env = 全局放宽播放路径，是红线 2 唯一真实的违背姿势；预取要更耐心只能传单次覆写）；(c) 常量锁：播放默认 `STREAM_BUFFER_STALL_MS=10_000` / `STREAM_BUFFER_TOTAL_TIMEOUT_MS=18_000` 改值即红；(d) 方向锁：预取默认 120s/30s 严格宽于播放路径（后台可以更耐心，播放保持紧）；(e) 行为锁：spyOn `fetchWholeSongBuffered` 断言预取以单次覆写传自己的 deadline/stall（120s/30s，非播放默认 18s/10s）、`retries:0`、且共享循环表保持为空。§7 表新增「路径隔离」行（测量源=守卫测试 ③+⑩，节奏=每次合并，失败响应=阻断合并，本地检查路径=该测试文件）。

**验证**：`prefetchCache.test.ts` 58/58 全绿（原 53 + 新 5）；报告 §4.2 P3 建议列 / §9.1 状态同步改 ✅。纯测试加固、零行为变更 → 只推 main 不打 tag（c51dc98 先例）。

### [l7] §4.2 P2：起播 TTFB 金丝雀探针（设置页开关，默认关闭）✅

**背景**：§7「起播时延」行长期只有目标没有测量源——流 TTFB p95 无人采集，源配置静默腐烂（酷狗/QQ 换签名、网易云 Cookie 过期）只能等用户投诉「没声音」才发现。§9.1 原设想用字面 `/rest/stream?timeOffset=1`（Subsonic 鉴权、穿出流管道）接入监控；评估后改为**上游直采探针**——与出流/预取共用同一份 `resolveNetworkInput` 推导直接打上游 URL，只读首字节即取消（≤64KB/次）。

**动作**（v4.6.9，服务端 + 前端 + 运维脚本）：

- 新增 `backend/src/services/source/streamProbeConfig.ts`：settings 键 `stream.probe.settings`，读序 settings > env > 默认；默认 `{enabled:false, songId:""}`（全关）；`enabled=true` 无 songId → 400 拒绝（本地歌没有上游可测）。
- 新增 `backend/src/services/source/streamProbe.ts`：金丝雀定位 = 空闲心跳 + 源配置静默腐烂检测。三卫生条件：① 钉死具体 songId（库内不存在 / 非网络源直接 skip）② 播放中避让（metrics 中间件 URL 路径级登记出流族请求，60s 静默窗）③ 失败仅状态翻转时 warn（healthy→failing / failing→healthy，中间态 debug）。skip 优先级链：disabled → no-song → recent-playback → song-missing → not-network → no-source → in-flight（single-flight）。nearest rank 分位（48 样本环形缓冲），每 24 次尝试打 p50/p95/max 汇总。env 旋钮：`STREAM_PROBE_INTERVAL_MS`(1h) / `TTFB_WARN_MS`(10s) / `TIMEOUT_MS`(30s) / `QUIET_MS`(60s) / `SAMPLES`(48) / `SUMMARY_EVERY`(24)。
- 后端接线：`metrics.ts` 入口 URL 路径级 `isStreamRequest()` 登记避让（慢请求预算的 route 计算保持 next() 后，规避 Hono routePath 中间件时序坑）；`routes/api/settings.ts` 新增 `GET/PUT /v1/playback-sources/probe-settings`（admin），开启即探一次不等整点；`shared.ts` re-export；`index.ts` 启动调度器（30s tick，enabled 且距上次 ≥1h 才探，开关/歌曲改动静默生效）；i18n zh/en 补 `errors.streamProbe.songRequired`。
- 前端「媒体获取」页（`frontend/src/views/admin/Plugins/index.vue`）新增「起播 TTFB 探针」卡：switch（默认关）+ 选歌 dialog（搜索/分页/行点击）+ 状态行（health tag / 跳过原因 / TTFB 最近·p50·p95 / ok·fail·skip 计数）；zh-CN/en-US 补 ~37 键。
- 运维：`scripts/pull-240-monitor.sh` 支持第三类日志 `[STREAM-PROBE]`（独立游标 `.cursor.probe`，不推进 deadlink 游标）。

**与字面 `/rest/stream?timeOffset=1` 的偏差**：原设想穿出流管道 + Subsonic 鉴权，评估发现三问题——① 会注册 membuf、等 6s 头窗，可能顶掉真实播放的预取缓冲；② 需要凭据；③ 播放态请求污染 metrics 统计。改上游直采后探测成本 ≤64KB/次、零播放态副作用；代价是探的是「上游→服务端」一段而非「服务端→客户端」端到端，后者待真实流量 tap（另立任务）。

**验证**：`streamProbe.test.ts` 31/31 + `streamProbeSettingsRoute.qa.test.ts` 7/7（beforeEach 复位抗 sequence.shuffle）；metrics 回归 14/14；全量 vitest 503 文件 6808 passed + 1 expected fail 全绿；vue-tsc EXIT=0 + vite build ✓。

### [l8] 版本—仓库—GitHub 三方一致性核对（截至 2026-10-13 22:43 CST）✅

**目的**：核验「报告记录的最新版本」「230 工作树实际 HEAD」「GitHub 远端现状」三者是否闭环，补齐报告未记录的提交。

**客户端（`MusicFlow-client`）**：

- 报告最新记录 = [l4] `v5.8.6`；230 工作树 HEAD = `edd0168`（= tag `v5.8.6`）；GitHub `main` = `edd0168`；GitHub tag/release `v5.8.6`（资产 APK + Windows setup）均存在。**三者一致，无未记录提交**（v5.8.6 之后无新 commit）。
- CI：`edd0168` 上 20 条 workflow run **全部 success**（Test Suite / Build Client / UI Guard / Playback Chain Guard / Boot Latency Guard / GPU Render Guard / Cover Display Guard / Transcode Chain Guard / Desktop Lyric Guard / Peer Order Guard / Offline Cache Guard / server-contract / Version Guard 等）。
- 版本轨迹：报告记录的 v5.8.2（[m1]）之后，仓库已推进 v5.8.3 → v5.8.4 → v5.8.5 → v5.8.6（对应 [l1]–[l4]）。

**服务端（`MusicFlow`）**：

- 报告最新记录 = [l7] `v4.6.9`（tag `2882976`）；GitHub tag/release `v4.6.9` 一致。
- **发现 1 处报告未记录的提交**：`v4.6.9` 之后有一未打 tag 提交 `8c62a79`（`fix(frontend): 探针选歌弹窗补 :append-to-body="true"——修复前端浮层遮挡守卫R1违规(v4.6.9新增弹窗会被播放控件遮挡)`），仅改 `frontend/src/views/admin/Plugins/index.vue` 1 行——把 [l7] 新增选歌 dialog 挂到 body 上，避免被播放控件遮挡而违反前端浮层守卫 R1。**本条目予以补记**（此前 §11 未收录）。属纯前端缺陷修复，无版本语义变更，未单独打 tag（符合「纯 bugfix 只推 main」先例）。
- 230 工作树 HEAD = `8c62a79` = GitHub `main`；`build-and-push`（含全量测试门禁）completed/success，`frontend-responsive` / `security` / `sync-to-gitee` / `Sendspin Guard` / `Version Guard` / `Playback Chain Guard` / `pentest` 均 success（核对时点 `ci` 工作流仍 in_progress）。
- 版本轨迹：报告记录的 v4.6.6（[m1]）/ v4.6.7（[m2]）之后，仓库已推进 v4.6.8（起播缓冲阈值自适应，[j1] 落地）→ v4.6.9（TTFB 探针，[l7]）→ `8c62a79`（本条补记）。

**同步性**：

- 双仓 230 工作树与 GitHub `origin/main` 均为 `ahead=0 / behind=0`（无未推送、无未拉取）。
- 本报告文件位于 `/workspace/MusicFlow/docs/`，保持 **untracked**（不 push GitHub、不随发版，见 [m3]）。

**结论**：报告与仓库/GitHub 基本闭环，唯一缺口为服务端未打 tag 的前端修复 `8c62a79`——已在本条目补齐。§9.1 待办中仍标记「未做」的仅剩「§4.2 P2 转码（ffmpeg）并发 4 排队 → 客户端优先透传 + 排队指标（需服务端指标先行）」一项。

### [l9] 遥控失灵根治：客户端 WS 应用层心跳 + 半开看门狗 + 前台/网络恢复重连（v5.8.7）+ 服务端协议层 keepalive（v4.6.10）✅

**现象**：Windows 客户端 HomePC 处于「正在播放」态时，管理员 `xyz5378` 从 V30 与 Web 前端均可在对端/设备列表看到 HomePC（含曲目与进度），但任意遥控指令（播放/暂停/切歌/音量）按下无反应；重启 HomePC 客户端后立即恢复——典型「看得见、按不动」。

**证据链**（生产 240；容器 2026-10-13T14:36:27Z / 22:36 CST 重建）：

- 容器重建即断开既有 WS；HomePC 侧 `clientId=app-4a39fb47ff45` 其后约 24h 内**无任何 `ws open` 日志**——客户端未重建连接，却仍显示在线。
- 状态仍「可见」的原因：客户端在线状态走 HTTP（`/peers/register` + 30s 心跳 + `/local-status`），与 WS 无关；服务端 `peer.ts` 心跳兜底要 2 分钟才置离线，故「看得见」。
- 定向投递链 `sendToLocalPeer → sendToLocalInstance(userId, clientId)` 要求 `clientId` 精确匹配；半开连接上 `readyState===OPEN` 被误判为可投递，实际数据写入死连接 → `delivered:false` 静默丢弃（客户端亦未消费 `delivered`）。
- 重启后复现恢复：日志出现 `[ws] upgrade ok ... clientId=app-4a39fb47ff45` → `ws open ... total=5`，且无后续 close。

**根因**（三层，缺一即复发）：

1. 客户端 WS **无应用层心跳、无存活看门狗**：容器/网络断连若未送达 FIN，`onDone`/`onError` 均不触发，客户端误以为仍连接（半开 TCP）。
2. `_connect()` 存在 `if (url == _activeUrl && _channel != null) return;` 短路，把「半开假象」当成已连接，吞掉重连尝试。
3. 服务端无主动 keepalive，不清理半开连接，导致其把死连接误判为投递成功。

**处置**（三方落地）：

- **客户端（根因，`MusicFlow-client`）**——`lib/providers/library/random_songs_push_provider.dart`（+101）：新增 25s 应用层 `{"type":"ping"}` + 75s 存活看门狗（`_lastFrameAt` 记录每帧时间，超时即 `_forceReconnect()`）；`appVisibilityProvider` 前台恢复触发 `_resumeIfStale()`、`connectivityMonitorProvider` 网络恢复触发 `_forceReconnect()`；`_clearChannel`/`_disconnect`/`dispose` 均清理心跳与订阅；保留 2s→30s 退避不变。commit `cacdf13`，tag `v5.8.7`。
- **服务端（兜底）**——`backend/src/services/ws/index.ts`（+28）：新增 30s 周期 keepalive（`WS_PING_INTERVAL_MS`）——`__isAlive=false` 未回 `pong` 即 `terminate()` 清理半开，否则置 false 并发 `ws.ping()`；`connection` 内初始化 `__isAlive=true` 并监听 `pong` 复位；定时器 `unref()`。随 commit `831df48`，tag `v4.6.10`。
- **Web 前端（同源隐患）**——`frontend/src/stores/player.ts`（+46/-1）：`peerWs` 新增 25s ping + 75s 看门狗 + 3s→30s 指数退避重连；`onmessage` 记录 `peerWsLastMsgAt`，`onopen` 复位退避并启动 ping，`onclose` 走退避；`disconnectPeerWs` 清理 ping/重连定时器。随 commit `831df48`。
- **HA 集成（排查，无需改动）**——`/workspace/hass-musicflow`（`WS_HEARTBEAT=30`、重连退避 5→120s、proxy `_ping_loop` 25s）与 `/workspace/hass-musicflow-card/src/backend-client.js`（25s ping + 指数退避 + 握手超时）已具备等价健壮性。

**验证**：客户端 `dart analyze` 无问题 + player 相关 17 用例全绿；服务端 `tsc --noEmit` 通过 + `wsHub`/`wsInstanceTargeting`/`sharedHelpers` 46 用例全绿；前端 `vue-tsc --noEmit` EXIT=0。

**CI**（全绿，2026-10-13 23:45 CST）：客户端 `v5.8.7` 全部 success——Version Guard / UI Guard / Desktop Lyric Guard / GPU Render Guard / Boot Latency Guard / Peer Order Guard 及 **Build Client**（DLNA Feature Tests + Android APK 7m41s + Windows Installer，已产出 APK 与 Windows 安装包）；服务端 `v4.6.10` 与 `main` 均全部 success——contract-gate / Version Guard / Playback Chain Guard / Sendspin Guard / **build-and-push**（镜像已推送）/ security / pentest / ci。

**待办**：生产 240 部署**需用户批准**后执行（服务端镜像重建 + 客户端装机）。旁路观察：期间出现 `/peers/register` 鉴权失败日志，与本故障无因果关系，另行跟进。

### [l10] 外部提交代码全面复核 + 修复分支逐项落地（服务端 S1/S3–S7 · 客户端 C1–C7/C9；S2/S8/C10/C8 复核判定不改）✅

**背景**：对 2026-10-14「非本机完成」的提交做全面质量审查——服务端 `5e5ae9b3..8c62a79`、客户端 `c1105443..edd0168`，产出缺陷清单后**逐项开修复分支落地**。遵用户要求，每项**实现前先复核方向、实现后再复核回归**（「做之前再审一遍、做完再审一遍」）。

**分支与提交**：

- 服务端 `fix/probe-audit-20261014`（基于 `831df48`，7 提交）：`d3407bc`(S1) → `9c694ab`(S4) → `5ca7bd0`(S3) → `4cf79d8`(S5) → `c7861fb`(S6) → `2a0f318`(S7) → `d2d4305`(CHANGELOG 4.6.11)。4 文件 +26/−13。
- 客户端 `fix/cover-bp-audit-20261014`（基于 `cacdf13`，14 提交）：`0249c7c`(C1) → `90b433f`(C7) → `4c2ed10`(C4) → `687b8ea`(C3) → `25a9dda`(C2) → `ce9ea6c`(C5) → `94e1c5c`(C6) → `09a5fd6`(C8 初版) → `436d149`(C9+b50h 适配) → `163b72c`(CHANGELOG 5.8.8) → `86af118`(C8 回退) → `4346afa`(CHANGELOG) → `151d66d`(C1 加固) → `dda2da4`(CHANGELOG)。6 文件 +70/−16。

**逐项落地**：

| # | 位置 | 改动 | 方向复核要点 |
|---|---|---|---|
| S1 | `backend/src/services/source/streamProbe.ts` | TTFB 定格**移到 `reader.cancel()` 之前** | 原顺序把断连耗时计进 TTFB，指标被系统性抬高；单测 31 例全绿 |
| S4 | 同上 | 非 2xx 分支显式 `res.body?.cancel()` | 原先不读不弃，undici 连接只能等超时回收 |
| S3 | 同上 + `middleware/metrics.ts` | 收敛「绝不与播放抢上行带宽」措辞 | 避让窗 = 起播后 `QUIET_MS`(60s)，长曲仍可能被探一次（≤1 chunk）；属文档漂移 |
| S5 | `middleware/metrics.ts` | `isStreamRequest` 去掉死的 `method` 形参 | 形参在函数体内从未使用；`tsc` 通过即证明调用点已同步 |
| S6 | `streamProbe.ts` | 删死代码 `streamProbeSchedulerRunning()` | 全仓零引用 |
| S7 | `streamProbeConfig.ts` | 补 `STREAM_PROBE_SONG_ID` env 说明 | 代码早有此兜底，仅注释缺失 |
| C1 | `lib/core/network/cover_pressure_observer.dart` | 信号生效时长 `_hold` 由固定 30s → **按 `Retry-After`**（只能缩短） | 服务端只建议 1s，客户端却压制 30s；部署后再加**上限**（见下） |
| C2 | `lib/features/discover/pages/discover_page.dart` | `Future.wait(pending)` 加 15s 超时兜底 | 首屏某请求悬挂不得无限期拖住屏外补齐；b44 5 例不受影响 |
| C3 | `lib/widgets/cover_art_image.dart` | 饱和观察定时器按剩余时长**精确到期**（去 500ms 轮询） | 原 `min(remaining,500)` 在 `remaining==0` 边界多等一个周期 |
| C4 | `cover_pressure_observer.dart` | `install()` 保留并委派既有 `HttpOverrides.current`，补 `findProxyFromEnvironment` | 同 dart:io `_HttpOverridesScope`；不再顶掉别处已装覆盖 |
| C5 | `lib/features/player/widgets/mini_player_controls.dart` | 手机端流转按钮补 `iconSize: 20` | 与同排播放/暂停一致 |
| C6 | `lib/providers/player/player_provider.dart` | 注释默认值 6s → 8s | v5.8.4 已标定 8000，注释未同步 |
| C7 | `cover_pressure_observer.dart` | 饱和标记改**白名单**（`1`/`true`） | 原「非 0 且非空即饱和」会把 `false` 误判 |
| C9 | `test/core/network/b50h_cover_pressure_test.dart` | B 组补 `debugNetworkImageHttpClientProvider` 的 `addTearDown` | 用例中途失败不再泄漏注入口 |

**POST-REVIEW 发现并纠正的方向错误 / 残留（关键）**：

1. **C8 判定不改（已回退）**：将 `b29a` 的 `waitUntil` 轮询耗尽由静默放过改为 `fail()`，实测 **8 个用例由绿转红**——该助手本就是刻意的最尽力等待（真定时器负载下允许放弃），轮询耗尽并非「前置条件失败」的可靠信号。已 `86af118` 回退并移出清单。**这正是「做完再审一遍」的价值**。
2. **C1 加固**：独立子代理复核指出 `_hold` 无上限——异常大的 `Retry-After`（misconfig / 上游注入）会把封面压制远超旧 30s 天花板。补上限：`_hold = min(Retry-After, 30s)`（**只能缩短、不能放大**，`151d66d`）。
3. **C3 残留（已核为可接受）**：精确计时器在「饱和信号在途期间被更短的 `Retry-After` 刷新」时会延迟恢复；但核服务端 `backend/src/services/coverImage.ts:303-304`——饱和头恒与 `Retry-After: 1` **成对下发**（无 `Retry-After` 的饱和信号在生产不可能出现），故该路径现网不可达，保留现设计。
4. **C7 多值头**：`close()` 把同名多值头（如重复的饱和头）拼成 `'1,1'` 时白名单判为**不**饱和（旧逻辑判饱和）。方向偏保守（不压制、不误伤），无正确性风险，保留并记录。

**复核判定不改（设计取舍/文档项，改动收益低于回归风险）**：S2（skip 不推进探测间隔闸——4.6.9 CHANGELOG 已明确的设计行为，改按间隔收敛会让用户改配置后最长等 1h 才生效）、S8、C10、C8（见上）。

**验证**：

- 服务端：`npx tsc --noEmit` EXIT=0；`vitest run streamProbe metrics` → **4 文件 73 例全绿**（`streamProbe` 31 / `metrics` 14 / `apiStreamProbe` 21 / `streamProbeSettingsRoute.qa` 7）。
- 客户端：`flutter analyze lib` **142 存量、零新增**（同 [l4] 基线）；`flutter test` → b50h+b44 **21 全绿**、b29a **11 全绿**（回退后）、`test/widgets/*cover*` **18 全绿**、mini-player 系列 **40 全绿**、`test/features/discover/` **280 全绿**。

**发版（用户批准「都发正式版」，2026-10-14）**：

- 两个修复分支以 **fast-forward** 合入各自 `main` 并推送（服务端 `831df48..d2d4305`、客户端 `cacdf13..dda2da4`），随后打并推送 annotated tag；全程经 **230 主机中转 GitHub**（`git push`/`gh` 均在 230 执行）。
- 服务端 **v4.6.11**：`build-and-push` tag 作业 **success（15m45s）**；Release 已发布 https://github.com/ray5378/MusicFlow/releases/tag/v4.6.11 —— 全量 vitest 门禁通过，**未触发自动回滚**。
- 客户端 **v5.8.8**：`Build Client` 作业 **success（13m40s）**；Release 已发布 https://github.com/ray5378/MusicFlow-client/releases/tag/v5.8.8，产物 `MusicFlow-v588-android.apk` + `MusicFlow-v588-windows-setup.exe`。

**发布前门禁预跑（在 230 按 CI 原命令全量复现）**：

- 服务端：`npx tsc --noEmit`=0；全量 `vitest run` = **6809 例中 3 例未过**——`PlayStartOwnership`（shuffle 随机挑首，超时）、`rawStreamCache`（Range 命中断言）、`sandbox`（OOM 重建超时）。三者均**与本次改动无关**（改动仅触及 streamProbe/metrics/config），且发生在「服务端 vitest 与客户端 flutter 测试并发抢核」的负载下；**逐一单独隔离复跑全部全绿**（sandbox 24/24、rawStreamCache 全绿、PlayStartOwnership 通过）→ 判定为 **230 本机资源竞争的偶发**，非回归。CI 侧 `main` 的「类型检查 + 全量测试」作业 **11m29s success** 佐证（干净 runner 上不复现）。
- 客户端：`flutter analyze --no-fatal-infos --no-fatal-warnings`=0（347 存量）；`check-version-guard`、`check-boot-latency`(15/15)、`check-peer-order`(5/5) 全绿；cover-display 守卫 `discover_page_test.dart` 全绿；offline-cache 守卫 **109 例全绿**。

**未部署生产 240**（按约定，生产部署需另行批准）。

### [l11] 流转播放接收端「总是从头播放」根因修复（Windows 接收端；Android 正常）✅

**用户报告**（2026-10-14）：Windows 客户端作为流转播放的**接收端**时，无论流转队列从哪里来，都从 0:00 起播，而非从对应进度续播；Android 端正常。

**结论：接收链路上两条「重载 / 重取」路径丢弃了流转起点，二者叠加表现为「总是从头播」**：

1. **0 秒卡死看门狗重载不保位（Windows 显形，主因）**。流转 `/queue` 起播经 `playSong(initialPosition=N)` → 服务端 `/rest/stream?...&timeOffset=N` 交付从第 N 秒起的音频；客户端解码 timeline 自 0 起、以 `_sourcePositionOffset=N` 把 source 位置换算为逻辑进度（D-063）。Windows(media_kit/libmpv) 冷启动首字节实测 5-8s、`processing` 判定偏粗（常停在 `buffering` 而非 `loading`），期间 source 位置恒在 0；**0 秒卡死看门狗**（12 tick×500ms=6s）在**偏移首载路径上未被 seek 落位宽限保护**（`_reloadStreamForSeek` 设 15s、首载未设，属不对称），遂误判为卡死并 reload 当前曲；而 reload 分支 `playSong(stuckSong, queue:, index:)` **不传 initialPosition** → 落回 `timeOffset=0` → **从头出声**。Android(ExoPlayer) 起播快、loading 期 `_shouldPreserveSeekPosition()` 保留 pendingSeek 使看门狗停摆，故不显形 —— 与用户「安卓端正常」一致。
2. **大队列接管丢广播起点（两平台共有的确定性缺陷）**。服务端 `localPlayFrom()` 把起点写入 `pendingStartPosition`，随 `peer_queue_changed` 广播一次性带出 `startPosition`，**广播后立即删除**（刻意不落库）；而接收端 `_handleQueueChanged → _follow` 在「WS 摘要态（`QUEUE_WS_CAP=200`，>200 首 `items` 被 `summarizeQueue` 清空）+ `total != 本机镜像队列长度`」时走 `_adoptRemoteQueue`，其重新 `GET /api/v1/peers/{id}/queue` 拿到的快照**必无** `startPosition` → `playQueue(initialPosition: null)` → **从 0 播**。
3. **伴生：偏移首载缺 seek 落位宽限**（同 1；修 1 后若不补此宽限，慢起播触发的 reload 仍可能连累 `_startupReloadStreak` 判死歌并跳歌）。

**修复**（分支 `fix/transfer-receive-position`，基于 `dda2da4`，5 提交）：

- `08edf3d` **(A) 看门狗重载保位**：[player_position_polling.dart](file:///workspace/MusicFlow-client/lib/providers/player/player_position_polling.dart#L333-L348) reload 分支把当次 tick 换算出的**逻辑进度** `playerPos` 作为 `initialPosition` 交回（**仅 `_sourcePositionOffset > Duration.zero` 时**保位，普通曲目卡死的 v5.8.1 重载语义逐字不变）。
- `86a3a1f` **(A2) 偏移首载落位宽限**：[player_provider.dart](file:///workspace/MusicFlow-client/lib/providers/player/player_provider.dart#L1154-L1164) `playSong` D-063 分支在 `resumeOffset > 0` 时设 `_seekSettleUntil = now+15s`，与 `_reloadStreamForSeek` 对称。
- `37bbd6c` **(B) 大队列接管保留广播起点**：[peer_remote_control_provider.dart](file:///workspace/MusicFlow-client/lib/providers/cast/peer_remote_control_provider.dart#L298-L345) `_adoptRemoteQueue(int expectedTotal, [Duration? broadcastStartPosition])`，`initialPosition = broadcastStartPosition ?? _startPositionOf(snap)`（广播起点优先，拉回快照仅兜底）。
- `f820e5f` **回归测试**：新增 2 例（拉回快照无起点 → 沿用广播起点起播；两端都无起点 → null 从头播），并修正原 `_adoptRemoteQueue` 用例对服务端「快照仍带 startPosition」的错误假设。
- `687f535` CHANGELOG v5.8.9。

**判为不修（复核排除）**：`_playWithTranscoding` 降级路径不传 `timeOffset/initialPosition`，但 offset 落回 0 后 `pendingSeek(原 initialPosition) != offset` → `playerStateStream` 在 `ready/completed` 回调 `_applyPendingSeekIfNeeded()` 走重拉 → **位置可自愈**（仅多一次 churn），非「从头播」根因。

**服务端无改动**：`GET /queue` 持续返回一次性 `startPosition` 会误导其它端的显示/跟随，故保持「广播即删」，改由客户端在接管时沿用广播值。

**验证**：`flutter analyze --no-fatal-infos --no-fatal-warnings`=**0**（347 存量；三改文件仅存量 info，零新增）；定向用例 `cast_transfer_position` / `peer_remote_control_cov` / `b29a_pospoll_cov` / `b34a_pospoll_settle` / `b50g_watchdog_queue_policy` / `player_seek_internals_cov` **108 全绿**，含新增 2 例后 `cast_transfer_position`+`peer_remote_control_cov` 复跑 **54 全绿**。

**全量 `flutter test`：4113 通过 / 5 失败**——5 例均与本次改动无关且**已证非回归**：① `widget_test.dart`「App smoke test」（pending timer）在 **`main` 上同样失败**（环境既有，与改动无关）；② `b50h_cover_pressure`、③ `b36c_offline_cache_settings`、④⑤ `b29a_pospoll_cov`×2 隔离复跑**全绿**（230 本机资源竞争偶发，同 [l10] 现象；b29a 隔离 **11/11 通过**）。

**发布相关门禁预跑（在 230 按 CI 命令复现）**：`check-version-guard` / `check-boot-latency` / `check-peer-order` / `check-l10n --gate-cjk` / `check_interaction_feedback` / `handoff_chain_scan` / `handoff_e2e_scan` 及 `boot_latency_guard` / `peer_display_order` / `cast_peer_provider` / `cast_transfer_queue` / `cast_remote_progress_guard` / `cast_transfer_position` / `client_link_guard` / `playback_mode` / `player_scrubber` / `dlna_auto_next_sim` / `source_failure_chain` / `discover_page` 系列**全绿**；`dart analyze lib/` 为 **0 error / 2 warning / 140 info**，与 `main` **逐字一致**（既有基线，CI 侧自 v5.8.8 起即通过）。

**发布**（用户「修复好之后提交发版」）：`fix/transfer-receive-position` 以 **fast-forward** 合入 `main`（`dda2da4..687f535`，5 文件 +70/−4）并推送；打并推送 annotated tag **`v5.8.9`**；全程经 **230 主机中转 GitHub**（`git push` / `gh` 均在 230 执行）。CI 6 个作业**全部 success**（`Version Guard` 37s / `Peer Order Guard` 2m19s / `UI Guard` 3m14s / `GPU Render Guard` 1m20s / `Test Suite` 13m53s / **`Build Client` 9m45s**）；**Release 已发布** https://github.com/ray5378/MusicFlow-client/releases/tag/v5.8.9 —— 产物 `MusicFlow-v589-android.apk` + `MusicFlow-v589-windows-setup.exe`，构建提交 `687f535`。**未部署生产 240**（按约定需另行批准）。

### [l12] Sendspin Guard「测试全过却 exit 1」根因修复（Vitest teardown 竞态）✅

**用户报告**（2026-10-14）：修复服务端发版 CI 报错。

**现象**（run `38437720013`，main@`d2d4305`，44s）：**Sendspin Guard** 作业 failure，但汇总行是 `Test Files 7 passed (7)` / `Tests 98 passed (98)`，只多出一行 `Errors 1 error`：

```
⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯
EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending
This error originated in "src/services/sendspin/trackChangeKeepStream.test.ts" test file.
```

同一 HEAD（`d2d4305`）下**只有该作业红**：`ci` 10m16s / `build-and-push` 11m29s / `Playback Chain Guard` / `Version Guard`（main + v4.6.11）/ `contract-gate` / `security` / `pentest` / `frontend-responsive` **全绿** —— 即非契约、版本或构建问题，而是该作业独有的**测试收尾竞态**。

**根因：测试文件 `afterAll` 停服务后，仍有异步收尾的 console 输出迟到到 worker teardown 之后。**失败日志里 `✓ trackChangeKeepStream.test.ts (6 tests) 530ms`（该文件已跑完）之后只剩三条迟到输出（`verbatim`）：

1. `[sendspin] group TC-OK 空了,关 1 个编码器` —— `stop()` 里同步 `g.close()` 触发**异步** ws 关闭 → `onConnectionClosed` 在下一个 tick 才打日志；
2. `[sendspin] sendspin pushLoop 退出: … song=tl-2` —— `GroupPump.pushLoop` 是 **fire-and-forget** 主循环（`void this.pushLoop(myEpoch)`），`running=false` 后要等下一个 `await sleep()` 边界才退出并打日志；
3. `Error: Service name is already in use on the network`（`node_modules/bonjour-service/dist/lib/registry.js:32`）—— **第三方** mDNS 名称冲突探测，收到冲突响应即 `console.log`。

Vitest 5 的 `onUserConsoleLog` 是 **worker→主进程 RPC**：worker teardown 时若仍有 pending，就抛 `EnvironmentTeardownError` 并记为 **1 个 unhandled error** —— 于是「98/98 全过」也 exit 1。前两条是本仓自有通道（均经 `logSafe → server.log`），第 3 条在 `bonjour-service` 内部，**我们改不到**。

**方向复核（落地前）——为何否决「生产侧静音」**：先尝试过在 `SendspinServer.stop()` 末尾把 `this.log` 换成静默函数（并在 `listen()` 还原 `rawLog`）。它只能消掉第 1、2 条，消不掉第 3 条；且 `src/services/sendspin/` 下还有**绕开 `server.log` 的裸 `console.warn`**（[protocolPlayer.ts](file:///workspace/MusicFlow/backend/src/services/sendspin/protocolPlayer.ts#L124) / `#L348`、`encoding.ts` 的 FLAC 编码退避、`server.ts#L1618` 心跳摘牌），同样可能迟到。**迟到输出横跨自有代码与第三方，逐一静音不可穷尽**；且「停机后不产日志」会牺牲生产排障需要的关机日志。故**弃用生产侧改动**（已还原，工作树对 `server.ts` 零改动），改在**测试夹具层**从结构上消除竞态。

**修复**（提交 `0a63fa3`，直接落 `main`）：本作业**关闭 Vitest console 截获**——`console` 不再经 worker→主进程 RPC，日志直接写进程 stdout，pending RPC 这一竞态从结构上不可能再发生；日志仍完整落在 CI 输出与失败 artifact `/tmp/sendspin-guard.log`。

- [vitest.config.ts](file:///workspace/MusicFlow/backend/vitest.config.ts#L8-L18) 新增 `test.disableConsoleIntercept: process.env.MUSICFLOW_GUARD_NO_CONSOLE_INTERCEPT === "1"`（**未置位时行为与原先逐字一致**，`ci.yml` 等其它作业不受影响）；
- [sendspin-guard.yml](file:///workspace/MusicFlow/.github/workflows/sendspin-guard.yml#L57-L64)「Run sendspin guard tests」步骤加 `env: MUSICFLOW_GUARD_NO_CONSOLE_INTERCEPT: "1"`。

**落地前验证（230 按 CI 同命令）**：

- `npx tsc --noEmit` = **0**；
- 置位 env 连跑 **5 次**：**5/5 exit 0**、`Tests 98 passed`、`Unhandled|EnvironmentTeardownError` 计数 **0**；
- **A/B 对照证明开关确实生效**：未置位时输出带 Vitest 截获头（`\x1b[90mstdout\x1b[2m | src/...`），置位后**截获头全部消失**（日志裸写进程 stdout）——即 RPC 通道确已关闭。

**CI 复核（落地后）**：推送 `d2d4305..0a63fa3`（`git push origin main`，经 230 中转）→ **Sendspin Guard run `38452834601` = success（52s）**，五步守卫（P0 三态 / P1 keepCurrent / P1 fork seek 透传 / P2 clear-never-end）全 ✓。至此 `d2d4305` 上唯一的红被打掉。

### [l13] 客户端全量测试归零修复与 v5.8.10 发版 ✅

**用户要求**（2026-10-14）：把客户端失败的测试也做处理，全部修复好之后提交发版。

**四项根因修复**（提交 `e9de00a`，落 230 main，5 文件 +71/−16）：

1. **[discover_page.dart](file:///workspace/MusicFlow-client/lib/features/discover/pages/discover_page.dart) 残留定时器**（widget_test「Timer is still pending」根因）：首屏就绪等待用 `Future.timeout(15s)`，其内部定时器在 `State.dispose` 时**不可撤销**，首屏分区请求悬挂时定时器残留到测试结束。改为可取消 `Timer + Completer + Future.any`，dispose 时 cancel 定时器并放行挂起等待（续体按 `mounted==false` 早退）。
2. **[offline_cache_settings_provider.dart](file:///workspace/MusicFlow-client/lib/providers/offline/offline_cache_settings_provider.dart) 异步续体读已销毁容器**：`_load`/`setSize`/`disable` 各 `await` 之后补 `if (!mounted) return;`（b36c 用例失败根因，riverpod 2.6.1 容器 dispose 会调 notifier.dispose）。
3. **[b29a_pospoll_cov_test.dart](file:///workspace/MusicFlow-client/test/providers/player/b29a_pospoll_cov_test.dart) 固定预算假红**：连续两轮 0 秒卡死需约 2×12 tick（各 6s），满负载下固定 30×500ms=15s 预算不够；改 `waitUntil(条件, ticks:3500)` 轮询（文件既有约定 #203-D）。
4. **[b50h_cover_pressure_test.dart](file:///workspace/MusicFlow-client/test/core/network/b50h_cover_pressure_test.dart) 真实时钟 vs 假时钟竞态**：饱和窗口按观测器内部 `DateTime.now`（真实墙钟）计时，而 `tester.pump` 只推进假时钟；原用例给 `Retry-After=1` 把窗口压成 1s 真实时长，全量满负载下从注入信号到建图（8 封面）真实耗时 >1s 即判过期、闸门放行 → 4 个封面拿到槽位并发 Image → 偶发假红（隔离跑真实耗时极小不复现）。改为不携带 Retry-After（回落 30s TTL 缺省）。**受控 A/B 证实**：注入 1.5s 真实延迟，旧写法必红（Found 4 Image）、新写法必绿。

**验证**：全量三轮 `flutter test`：4113/5 → 4117/1 → 4115/3 —— 前两轮的 5 个失败全部根因修复且复跑稳定通过；末轮剩余 3 例（dlna_manager_cov / b29a 近末尾 / b39a_helpers_seek）为满负载轮转 flake（与修复前失败集合完全不重叠），隔离复跑 **66/66 全绿**确认非回归；全量 flutter test 在 CI test-suite.yml 中本就是非阻断观察流水线，发版门禁由 tag 触发的 Build Client 承担。`flutter analyze` 改动文件零新增问题。

**发布**：经 230 中转 push main（`687f535..e9de00a`）+ annotated tag **`v5.8.10`**；CI **8 作业全部 success**（Version Guard / Peer Order Guard / UI Guard / GPU Render Guard / Boot Latency Guard / Desktop Lyric Guard / Test Suite / **Build Client**）；**Release 已发布**（`MusicFlow-v5810-android.apk` + `MusicFlow-v5810-windows-setup.exe`）。未部署生产 240（按约定需另行批准）。

### [l14] 服务端 PATCH22 转码总闸 + CI 门禁修复 ✅

**用户要求**（2026-10-14）：下载进缓存后立即转码但没有总转码进程限制，可能全部同时转码；要求新增可配置的转码进程数上限，对下载任务和洗版任务都生效，然后提交发版（默认值用户拍板为 4）。

**现状结论**（调研）：手动下载与定时洗版走同一条 orchestrator 单曲流水线（取链→下载进缓存→写标签→转码→重探→落成品）；既有 4 个并发旋钮（maxConcurrentDownloads / maxConcurrentPerHost / maxConcurrentTargets≤64 / maxConcurrentJobs）全都不覆盖转码步骤，同时推进几首歌就同时起几个 ffmpeg（PATCH20 提并发上限时只管了"流水线重叠度"），默认 2×3=6 个转码进程、配置拉满理论上百个；转码含响度归一化两遍法时单首跑 2 次 ffmpeg。

**PATCH22 实现**（提交 `fc6c092`，8 文件 +235）：
- 新配置 `maxConcurrentTranscodes`（1..16，默认 **4**，用户拍板）：同一时刻最多 N 首歌跑 ffmpeg 转码，超出 FIFO 排队；下载与洗版共用 orchestrator，一个闸两类都覆盖
- orchestrator 复用 `limiter.ts` 现成 `Semaphore` 建闸包住转码步骤，`finally` 保证成功/失败/取消三条路都释放；排队等待超 2s 记日志便于调参
- config.ts 归一化夹值 + `routes/api/fetch.ts` PATCH clamp；前端设置页加输入框（zh/en 文案）、`src/api/fetch.ts` FetchConfig 补字段

**验证**：backend tsc 干净；fetch 域回归 **31 文件 535 用例全绿**；新增 `tests/fetch/transcodeGate.test.ts` 3 例（并发峰值≤上限且能到 2 非串行、失败经 finally 释放、归一化缺省 4 夹值）；frontend vue-tsc 干净。

**顺带调研（用户问）缓存生命周期**：缓存目录 `/MUSIC/DOWNLOADCACHE` 是 volume 挂载，容器重启不清；但 [index.ts:419-424] boot 时**主动整目录清空**上次遗留的下载子目录/.part 半成品（不碰成品目录）；任务级由 jobStore PATCH19 启动恢复——DB 里 pending/running 任务重新入队**从头走**（重新下载→重新转码），故重启后不会残留未转码文件、也不会丢任务。

**CI 门禁修复**（提交 `061656a`）：首跑 `build-and-push` 失败并触发自动回滚——**6811 用例全绿但 vitest 抓到 1 个 EnvironmentTeardownError**（`playerGroup.test.ts` 满负载 803s 下，in-proc Sendspin 停止后 pump/ws/编码器最后一拍 console 输出在飞，worker 关闭时 `onUserConsoleLog` RPC 未送达）。修复：afterAll 停服后 setImmediate×5 + 50ms 排空再清理，产品码零改动；playerGroup 三连跑全绿、sendspin 目录 51 文件 724 用例全绿。

**发版 ✅**：CI（061656a）**8 作业全绿**（全量测试门禁排空修复生效，未再触发回滚）→ CHANGELOG v4.6.12 提交（`bc5da5a`）→ tag **`v4.6.12`** 推送 → tag 构建 **4 作业全 success**（contract-gate / security / Version Guard / build-and-push）→ **Release published**（2026-10-14 04:34 UTC，正式版非草稿），Docker 镜像随 build-and-push 推送。未部署生产 240（按约定需另行批准）。

### [l15] 客户端 P3 与冷启动鉴权失败修复 ✅

**用户要求**（2026-10-14）：把「鉴权失败」也一并处理；并先把**不需要真机验证**的几条做完、在 230 做提交，真机验证项（ADR-2 2b/3）留到之后。

**P3 — DLNA 直投状态轮询降频**（提交 `4874d78`，`perf(dlna): 用户暂停期间状态轮询降频，长时投屏不再每 2s 空转`）：
- **现状**：DLNA 投屏期间以 **2s 固定周期**轮询 transportInfo，即使用户已暂停/空闲也照跑，长时间投屏白耗请求与日志。
- **改法**：[dlna_manager.dart](file:///workspace/MusicFlow-client/lib/core/dlna/dlna_manager.dart) 把轮询节拍抽成常量 `_pollTickSeconds = 2` + `_idlePollEveryNTicks = 7`，新增 `_pollTicksSinceLast` 计数；`_startStatusPolling()` 改 `Timer.periodic(_pollTickSeconds, _onStatusPollTick)`，`_onStatusPollTick()` 按 `_userPaused ? _idlePollEveryNTicks : 1` 抽稀（**用户暂停时 2s×7 = 14s 才探一次**），恢复播放立即回到每拍轮询。
- **用例**：`_FakeDlnaServer.transportInfoCalls` 计数守卫「暂停 5s 不新增、resume 后 ≥atPause+2」；230 上 dlna 域 **54/54 全绿**，analyze 改动文件零新增。

**冷启动鉴权失败 — `/peers/register` 首发 401**（提交 `76bef59`，`fix(cast): /peers/register 冷启动鉴权失败，首发前先等凭证就绪并抑制真 401 重试`）：
- **根因**（对应本文第 915 行「旁路观察：…`/peers/register` 鉴权失败…另行跟进」）：注册挂在 auth 状态翻转上**立刻**触发，而此刻 `subsonicApiClientProvider` 尚未随活跃库重建、token 还没注入（`client.setLibrary(activeLib)`），**首发必然 401**；旧实现靠固定 900ms 盲等重试一次兜底（见 [startup-connect-latency.md](file:///workspace/MusicFlow-client/docs/startup-connect-latency.md) 3.2 节，即启动耗时主因之一）。
- **方向校订（避免误诊）**：一度怀疑服务端 `peers.ts` 的 `c.get("user")!` 非空断言会因授权中间件放行而为 null —— 实为[peers.ts](file:///workspace/MusicFlow/backend/src/routes/api/peers.ts) 第 100 行对非 GET 直接 `next()`，且 `authMiddleware`（`index.ts` 里 `app.use("/rest/api/*")` 先于 `app.route("/rest/api")`）已完整覆盖 `/rest/api/v1/peers/register`，故 register 必然带 user。**服务端无 bug**，401 源于客户端无凭据 → 修复锁定客户端侧。
- **改法一（Opt-2，仓库自带方案）**：`_registerSelf` **首发前**先 `await _waitForApiCredentialsReady()`，把首发竞态从「必然 401 + 900ms 重试」改为「先就绪再注册」；测试钩子 `CastPeerController.debugAwaitCredentials` + `apiCredentialsReadyProvider` override 验证「凭证未就绪前不发出注册」。
- **改法二（401 重试一次再抑制，落地后审查修订）**：新增 `_noteAuthRejected()` 记时间戳并进入 `kAuthRejectedCooldown = 5min` 抑制窗；`startHeartbeat()` periodic 回调首行 `if (_authRejectedActive) return;` 抑制 30s 心跳刷屏；`registerAndHeartbeat()` 首行清标记 → **重新登录即恢复注册**。401 经 `_statusCodeOf(e)`（`e is DioException ? e.response?.statusCode`，因 `dioProvider` 未覆写 validateStatus，401 会抛 `DioException`）判定。**修订**（详见 [l16]）：初版让「真 401 一律不重试」，落地后全量域回归发现与 Boot Latency Guard Fix-2 契约冲突 —— 首发前等待有 **2s 预算超时放行**，凭证迟到（慢盘读库等）时首发仍会 401，「凭证就绪即重试」正是 peerId 落地的关键路径，一律不重试会让注册卡死到抑制窗过期。最终语义：**401 首拒仍按 Fix-2 重试一次；重试仍被拒（token 真过期/密钥轮换）才进入抑制窗** —— 防刷屏目标不变（每轮最多多一次注定失败的请求）。
- **用例**：「首发注册前先等『凭证就绪』信号（Opt-2）」「401 首拒按 Fix-2 重试一次、重试仍拒抑制心跳」「重新登录 `registerAndHeartbeat` 解除抑制恢复注册」；同步适配 `boot_latency_guard_test.dart` Fix-2 守卫（Opt-2 首发等待 + 零等待重试使「首拍同步发出」断言演进为「flush 微任务后首发+重试即完成」）。

**状态**：两项均已落 230 `main`，工作树干净。ADR-2 阶段 2a（纯策略外提，不需真机）继续；2b/3（结构级拆分 / NotifierProvider 迁移）与真机验证待续。

### [l16] ADR-2 阶段 2a：cast 域纯策略外提 + 401 语义对齐 Fix-2 守卫 ✅

**用户要求**（2026-10-14）：「先把其他几个做完在230做提交，之后再做需要真机验证的」——阶段 2a 属不需真机项。

**2a 实现**（提交 `f65191b`，`refactor(cast): ADR-2 阶段2a 投屏状态判定纯策略外提 cast_peer_policy.dart，控制器改委托`，3 文件 +649/−81）：

- 新建 [cast_peer_policy.dart](file:///workspace/MusicFlow-client/lib/providers/cast/cast_peer_policy.dart)：把 `CastPeerController` 内联的**库私有判定**逐字搬运为顶层纯函数（时间/平台等外部输入由调用方注入，可确定性测试）：`projectPolledPosition`（采样外推夹紧：非播放态原样、无 reportedAt 原样、age≤0 或 >30s 原样、duration 夹紧）、`isStaleSample`（命令影子窗口判定，常量 `kCommandShadowWindowMs` 一并迁入）、`applyVolumeShadow` / `applyTransportShadow`（滞后采样叠加本地乐观 volume/muted 或 state/active）、`nextSmoothPosition`（插值递增 + duration 封顶）、`resolveProgressTickMs`（桌面三平台 500ms / 其余 250ms）、`visiblePeers` + `selectAutoSelectCandidates`（启动自动选中的可见过滤与「类别序→名称」选举排序，复用 `peerKindRank`）。
- 控制器 7 处成员改一行委托（`_projectPolledPosition` / `_isStaleSample` / `_applyVolumeShadow` / `_applyTransportShadow` / `_advanceSmooth` / `_progressTickMs` / `_maybeAutoSelectPlayingTarget` 候选段），「读状态→调纯函数→写字段/记日志」编排留在宿主；与 [i7] 阶段 1 手法同源。
- 新建纯测 [cast_peer_policy_test.dart](file:///workspace/MusicFlow-client/test/providers/cast/cast_peer_policy_test.dart) **30 例**（边界全覆盖：age 边界恰 30s 仍外推、窗口边界 at==command 不算陈旧、影子合并字段取舍得当、选举排序契约 本机>群组>独立 再按名称等），零宿主依赖。
- 回归：`cast_peer_policy_test + cast_peer_cov_test + cast_peer_provider_test` **145 例全绿**；`flutter analyze` 改动 3 文件 **No issues found**。

**401 语义对齐 Fix-2 守卫**（提交 `f039bde`，`fix(cast): 401 首拒保留 Fix-2「凭证就绪即重试」，重试仍拒才冷却抑制；Boot Latency Guard 适配 Opt-2 首发等待`，3 文件 +29/−30）：

- **发现**（落地后全量域回归 `test/providers + test/core/dlna`）：`boot_latency_guard_test.dart` Fix-2 用例红。两层原因：① 表层 —— Opt-2 首发前的 `await` 使「首拍同步发出」断言失效（测试环境零等待但仍异步，首拍计数 0）；② 实质 —— `_waitForApiCredentialsReady` 有 **2s 预算超时放行**，凭证迟到时首发仍会 401，76bef59 初版「真 401 一律不重试」会让注册卡死到抑制窗过期，**回归了 Fix-2 的延迟契约**（该守卫正是防「900ms 盲等」类退化的行为锁）。
- **修正**：catch 块重排为「先按 Fix-2 重试（401 亦然）→ 重试仍 401 才 `_noteAuthRejected()`」；`cast_peer_cov_test` ②③ 改到新语义（401 两拒后抑制心跳 / 重新登录解除，重试成功路径一并覆盖）；守卫 Fix-2 用例适配为「flush 微任务后首发+重试即完成 `tries==2`」—— 零等待重试使两拍合一，此断言对「900ms 盲等」回归更灵敏（定时器未到点即判红）。
- **验证**：analyze 3 文件 No issues found；全量域回归两轮（1398/1 → 1397/2），仅存失败均可解释（守卫断言中间态 + `b36c` 满负载轮转 flake）；隔离复跑 `boot_latency_guard + b36c + cast 三件` **163 例全绿**（b36c 与 e9de00a 修复时同性质 flake，非回归）。

**状态**：阶段 2a 完成、230 `main` 工作树干净。剩余：阶段 2b（文件结构级拆分）、阶段 3（`NotifierProvider` 迁移）与真机验证（本机 Debug 构建冒烟，Android 与 Windows 同源不单独验证）。

### [l17] ADR-2 阶段 2b-1：会话落盘/恢复抽协作者 player_session_persister.dart ✅

**用户要求**（2026-10-14）：按排序继续推进「需真机验证」批次（2b/3）；真机冒烟随发版前验证一并做。

**2b-1 选型与落地前审查**：
- 2b 定义（§600）：把 watchdog/队列/音量/持久化从 `part of` mixin 抽成**真协作者对象**（独立 Dart 库 + 窄接口，可独立构造测试），而非继续堆 mixin。首批选**持久化**：~440 行最大、边界最清晰（出入只在 state setter/_init/_finishSessionTeardown/dispose/persistPlaybackStateNow 五个生命周期点）、测试护航最全（b38 系列 + session_teardown 族）。
- 影响面收敛验证：其余 6 个 part 文件对持久化成员**零调用**（调用点全在主文件）；测试钩子（debugBeforePersistWrite/debugBeforeRestoreResume/debugRestoreAbortCount）走宿主转发，10 个既有测试文件访问面不变；接口实现允许命名参数超集（playSong 的 autoPlay/initialPosition 等）。

**实现**（提交 `615ad9b`，`refactor(player): ADR-2 阶段2b 会话落盘/恢复抽协作者 player_session_persister.dart`，4 文件 +969/−507）：
- 新建 [player_session_persister.dart](file:///workspace/MusicFlow-client/lib/providers/player/player_session_persister.dart)：窄接口 `PlaybackSessionPersisterHost`（8 成员：state/mounted/payloadEncoder/queueOrigin/fetchLocalQueueForRestore/syncLocalQueueNow/playSong/setPlaybackMode）——**刻意不含 Ref**，cast/queueOrigin 依赖经宿主转发，断开循环 import 且独立可测；`PlaybackSessionPersister` 协作者逻辑自 mixin **逐字搬运只改接线**（state→host.state、_ref.read→host.xxx 转发），常量随迁（防抖 5s/写租约 15s/恢复租约 20s），租约制、脏标记补写、代际守卫、恢复新鲜度竞速全部原样保留。
- 主文件 [player_provider.dart](file:///workspace/MusicFlow-client/lib/providers/player/player_provider.dart) 15 处编辑：删 `part` 声明与 7 个持久化抽象签名；`PlayerNotifier implements PlaybackSessionPersisterHost`；构造函数首行 `sessionPersister = PlaybackSessionPersister(this)`；调用点改走协作者（state setter→schedulePersist / _init 尾→restorePlaybackSession / _finishSessionTeardown→bumpSessionGeneration+immediate / dispose→cancelPersistTimer+persistPlaybackSession / persistPlaybackStateNow→cancel+awaitInFlight+persist / _resolvePreviewSongForPlayback 2 处恢复租约检查）；@visibleForTesting 转发门面保住既有测试访问面。
- 删除 [player_playback_session.dart]（mixin 搬空 381 行；git 识别为 rename，相似度 51%）。
- 新建独立测试 [b51a_session_persister_test.dart](file:///workspace/MusicFlow-client/test/providers/player/b51a_session_persister_test.dart)：`_FakeHost`（几十行实现窄接口）+ `_WriteProbe`（debugBeforePersistWrite 计数/门控），证明协作者可脱离 Riverpod/播放器/part 体系独立构造；用例矩阵 B1（真异步并发写合并 + 落盘回读必须是最新状态）、C1/C2（恢复竞速：本地源带 initialPosition + 队列镜像 / 服务端胜出不回推但恢复播放模式）、C3（代际守卫作废 + finally 立即补写）、A1/A2（fakeAsync 防抖契约：5s 到点、重复调度不叠加 Timer、immediate 取消防抖）。

**三轮验证迭代与真根因**（重要教训，已沉淀 Lessons Learned）：
- 第一轮：persister 漏 `queue_origin_provider.dart` import（QueueOrigin 未定义×3）→ 推修正版；b51a 编译错逐个修正。
- 第二轮：analyze 干净，但 B1 Expected 2/Actual 1（脏标记补写轮未触发）、C1/C3 30s 超时。怀疑 LocalStorage 挂起 → 写最小复现实验（zz_probe_localstorage_test，5 用例覆盖 writeString/savePlaybackSession/getPlaybackSession/getAutoPlayOnLaunch/setPlayerVolume 全 API）全过——**LocalStorage 假设推翻**。
- **真根因**：`JsonFileStore.writeString` 对同键写做队列串行化（`_writeQueues[key]` 链式 Future），而 **fakeAsync 虚拟时钟内发起的真实文件写永不完成**（IO 事件不由虚拟时钟推进）——A1/A2（fakeAsync 用例）遗留的挂死写占住队列，卡死**后续所有**落盘用例（B1/C1/C3 集体超时；C2 主链只读、写为 unawaited 不 await 所以幸存）。**修复：fakeAsync 用例必须排在文件最末**（附注释说明），遗留写在 fakeAsync zone 退出后由真实事件循环自然完成/落空；重排后 b51a **7/7 全绿**。临时实验文件 zz_probe 验证后删除。

**回归**：`flutter analyze lib/providers/player + test/providers/player`：新文件零 lint，player_provider.dart 仍为存量 4 info（2458/2644/2842，行号与改动前一致），全目录 92 issues 均存量 info/warning、零 error；全量 `test/providers/player` 域回归 **534/534 全绿**（约 2min40s）。

**落地后审查**：变更集恰为 4 文件无意外改动；persister 与原 mixin 逐段比对逻辑零差异（租约/防抖/脏补写/代际守卫/竞速/解析 helper/awaitInFlightPersist 的 Future.any+Timer.cancel 全一致），仅接线替换；宿主转发门面签名与原钩子访问面一致。

**状态**：2b-1 落 230 `main`（提交 `615ad9b`），工作树干净。剩余：2b 后续批次（队列/音量/看门狗驱动，范式已验证）、阶段 3（`NotifierProvider` 迁移）、真机验证与发版。

**教训**（fakeAsync × 真实 IO × 同键写队列串行化）：「跨用例污染」极具迷惑性（表现像 LocalStorage 挂死），最小复现实验（隔离 probe）是排除错误假设的最快手段；fakeAsync 用例若内部触发真实 IO，必须隔离到文件末尾或独立文件。

### [l18] ADR-2 阶段 2b-2：位置轮询/看门狗驱动抽独立协作者库 player_position_polling.dart ✅

**2b-2 选型与落地前审查**：
- 抽 **position_polling**（411 行，最大 part mixin）：位置轮询 + 三道看门狗（停滞 / 0 秒卡死 / 近末尾）驱动。**shuffle_queue 判定不抽**：~40 个调用点横跨全部切歌流程，抽离需巨大接口面、违背窄接口原则。
- 符号引用盘点：8 个纯轮询字段（_positionPollTimer/_lastPolledPlayerPosition/_stagnantPositionTicks/_hiddenPollCounter/_startupStuckTicks/_nearEndStuckTicks/_startupReloadStreak/_startupStuckSongId）仅主文件声明 + polling 使用，可整体内聚进 mixin；6 个跨流程字段留宿主（_seekSettleUntil/_expectingAutoplay/_streamLoadInFlight*×3/_isHandlingCompletion+_completionHandlingSongId）；3 个 public debug*CeilingMs 字段自动满足接口 getter；测试形态确认 b29a（749 行）/b50e（415 行）均经公开 API 驱动真实 notifier，行为零改动即绿。
- Dart mixin 关键语法结论：`class C with M(on T) implements T` 不合法（with 先于 implements 应用，on 约束必须由**超类接口**提供）→ 经基类 `abstract class B implements T {}` + `class C extends B with M`。

**实现**（提交 `d9caad1`，`refactor(player): ADR-2 阶段2b-2 位置轮询/看门狗驱动抽独立协作者库 player_position_polling.dart`，3 文件 +1115/−468）：
- 新建 [player_position_polling.dart](file:///workspace/MusicFlow-client/lib/providers/player/player_position_polling.dart)：part 改独立库；6 个阈值常量迁入并 export show（kPositionPollBaseInterval/kHiddenPollDecimation 保 b50e import 兼容）；窄接口 `PlaybackPositionPollingHost`（27 成员：state/mounted/readIsRenderingActive/logicalPlayerPosition/shouldPreserveSeekPosition/seekSettleUntil/expectingAutoplay/streamLoadInFlight*×3/sourcePositionOffset/markCompletionHandling/playDbg/seekDbg/onSongCompleted/handlePlaybackError/playSong/next + 3 个 debug*CeilingMs）——**刻意不含 Ref**，渲染可见性经宿主 `readIsRenderingActive()` 转发（try/catch 容器未就绪按可见）；`PlaybackPositionPollingDriver` mixin 轮询体**逐字搬运只改接线**（_ref.read→readIsRenderingActive、_playDbg→playDbg、_onSongCompleted→onSongCompleted、completion 双标记置位→markCompletionHandling(doneSongId)）。
- 主文件 [player_provider.dart](file:///workspace/MusicFlow-client/lib/providers/player/player_provider.dart) 14 处补丁：删 part 声明、加 import/export show、删 8 字段 + 3 轮询入口、with 链改 `PlaybackPositionPollingDriver`、implements 加 Host、`cacheAuthoritativeStarred` 后插 15 个 @override 转发块；3 个轮询入口在 abstract PlayerNotifier 补抽象声明（mixin 挂载点经具体类 `_PlayerNotifierImpl extends PlayerNotifier with ...` 生效）。
- 新建独立接线测试 [b52a_position_driver_test.dart](file:///workspace/MusicFlow-client/test/providers/player/b52a_position_driver_test.dart)：最小 fake host（实现 27 成员窄接口，with Driver）+ fake just_audio platform（b50e 精简版 + startAutoEmit 钉位），5 用例：可见 tick 写回换算 / pendingSeek 保护期整体早退 / settle 窗内 0 秒卡死豁免（7.5s 静默）/ 停滞 10 tick→next 出口 / stop 后静默。证明驱动可脱离 Riverpod/part/主文件体系独立构造。

**测试迭代与关键教训（just_audio 订阅时序）**：
- v1 编译错（mixin on 约束）、v2 运行错（fake platform 未显式 init）先后修正后暴露用例设计错：事件先于订阅丢失需 autoEmit、停滞累计需真实 ready 态（setUrl+play）、`seekSettleUntil` 只豁免 0 秒卡死与近末尾看门狗（不豁免停滞），tick 头部早退的实为 `shouldPreserveSeekPosition`。
- v3 后仍单点失败「可见 tick 写回」，诊断（fakeHasListener=false + 恒 idle@0）定位**真根因**：just_audio 的 platform 事件流订阅发生在**首次 setUrl（_setPlatformActive，just_audio.dart L1365）**，`AudioPlayer()` 构造不订阅——未激活前 position 恒 0。用例 4/5 的绿是假象（4 靠 setUrl 本地状态转移、5 的 _waitUntil 无断言）。修复：用例 1/2/5 统一补 `readyPlaying()`（setUrl+play 激活链路）并给用例 5 补断言；playing 态 position 按真实时间外推（autoEmit 100ms 周期内 ~0-100ms 漂移），写回值断言放宽至 150ms 容差后 **5/5 全绿**。

**回归**：b52a 5/5 + 三测试族（b52a+b29a+b50e）18 绿 + `test/providers/player` 域全量 **539/539 全绿**（基线 534 + 新增 5，约 2min40s）；`flutter analyze lib/providers/player` **61→59**（净消除 part 模式 annotate_overrides ×1 + unnecessary_this ×1），新库零 lint。

**落地后审查**：sha256 三文件（新库/主文件/b52a）230 落地版与本地工作副本逐一比对**完全一致**；变更面 2 M + 1 ?? 与计划吻合；阈值常量与看门狗判定行抽验零漂移（10/12/2/500ms/4、drift≥250、三条触发条件行）；4 条「疑似新增 info」（prefer_interpolation_to_compose_strings ×3 / use_super_parameters ×1）经 stash 基线**规则计数法**验证为行号漂移的存量噪音（基线 3+1 = 改造后 3+1），非本次引入。

**状态**：2b-2 落 230 `main`（提交 `d9caad1`），工作树干净。剩余：2b-3（音量，体量小可评估并入）或直接阶段 3（`NotifierProvider` 迁移，需先调研消费面）→ 全量回归 → 真机冒烟 → 发版。

**教训**（just_audio 测试替身）：fake platform 的显式 init 只解决「拿到 fake 引用」，**事件链路要等首次 setUrl 才建立**（_setPlatformActive 内订阅）——凡断言依赖 position/processingState 的用例必须先 setUrl 激活；反向教训：等待型断言（_waitUntil）返回值必须显式 expect，否则静默失败伪装成「通过」；lint 噪音归属判定用**规则名计数法**比对基线（行号在重构后必然漂移，按行号 grep 会误判新增）。

### [l19] ADR-2 阶段 2b 收口 + 阶段 3（NotifierProvider 迁移）：3a-1 落地、主迁移判定延期 ✅/⏸

**2b-3（音量）判定：不抽**。主文件内音量逻辑仅 ~50 行（setVolume/setVolumeLive/1s 防抖持久化/恢复/dispose 清理），且与 crossfade part 的 setVolume 调用及 dispose 生命周期紧耦合；抽库需窄接口 ~4 成员而收益不足，违背 2b「体量与内聚并重」的准入线。ADR-2 代码抽取批次就此收口（2a + 2b-1/2b-2 三库落地，shuffle_queue/音量两项判定不抽）。

**阶段 3 落地前调研**（全仓事实）：
- 锁定 riverpod/flutter_riverpod **2.6.1**（pubspec ^2.6.1 一致；曾因 grep 上下文错位误读 4.9.3，经 pubspec.lock 与 pub 缓存双向核实）。
- 全仓 14 处 `StateNotifierProvider`；**零** `.state`/`.stream` 子提供者用法、零 `updateShouldNotify`/`addListener`（notifier 面）依赖——两大经典兼容雷区不存在。
- 消费面：playerProvider 142 处 lib 引用 + 139 处测试 `overrideWith`（121 文件）；`extends PlayerNotifier` 测试 fake **0** 个（TestPlayerNotifier 走 `extends StateNotifier implements PlayerNotifier` + noSuchMethod，构造签名保持即可零改调用点）；cast 域 fake 151 处（CastPeerController 88 + DlnaCastNotifier 63）为后续迁移大头。
- riverpod 2.6.1 源码级 API 确认：`Notifier`/`NotifierProvider` 存在；**NotifierBase 无 `mounted`**（StateNotifier 有）——需自定义标志 + `ref.onDispose` 仿真；`NotifierProvider.overrideWith` 收**零参工厂** `NotifierT Function()`（与 StateNotifierProvider 的 `(Ref ref) =>` 不同，本次实测踩坑后修正）；`fireImmediately` 在 Ref.listen 面存疑→用 read-once + listen 等价替换。

**3a-1（三个小 provider）已落地**（提交 `f5d9a25`，8 文件 +52/−47）：audio_quality（build 里 `_load()`+返回常量）、crossfade（`_mounted` 仿真注释内联）、sleep_timer（`dispose()` override → `build()` 内 `ref.onDispose` 取消 Timer，`_ref`→内置 `ref`）；测试适配 5 文件：3× `_RecSleepTimer` 删 `(super.ref)` 构造（继承真实 build）、2× `_FakeCrossfade` 改构造注入初始值 + `build()` 覆写（**Notifier 未 attach 前写 state 会 LateInitializationError**，原 `overrideWith` 回调内的 pre-attachment `state=` 写入全部改造）、b29a 注释同步。回归：定向 5 文件 38 绿 + `test/providers/player` 域全量 **555/555** + analyze 域口径 59=基线（b29a 5 条 warning/info 经 diff 比对确认为存量）。

**3a-2（playerProvider 主迁移）尝试后回滚，判定延期至阶段 3b**：
- 迁移补丁已完整实施（provider 声明→`NotifierProvider(_PlayerNotifierImpl.new)`、构造体四步迁入 `build()`、41 处 `_ref`→`ref`、TestPlayerNotifier 保参名改造、137 处 overrideWith 签名批改），分析器零 error。
- **残留检查暴露致命语义差异**：lib 存在 4 处 `ref.invalidate(playerProvider)`（app_drawer:297 服务器切换、edit_library_page:423/476 地址变更、app_settings_page:597）。riverpod 2.6.1 `NotifierProviderElement.create()` 源码（`_notifierNotifier.result ??=`）证实 **invalidate 保留同一 notifier 实例仅重跑 build()**，而 StateNotifierProvider 是整体重建（旧实例 dispose→mounted=false 消音旧异步链，新实例构造重跑）。
- 同实例重跑 build() 的后果：①`late final sessionPersister` 重赋值抛 LateInitializationError；②`_init()` 重跑产生**第二套 AudioPlayer/SMTC/事件流订阅**，旧订阅的 `if (mounted)` 守卫因实例共享而失效（mounted 恒真）→ 幽灵播放器双写 state。正确修复需在播放核心引入全新「逐 run 资源追踪 + 清理」生命周期逻辑（~30 行新逻辑于最敏感文件），超出「逐字迁移」边界且回归只能真机暴露。
- **决策**：按「万无一失」标准回滚全部 3a-2 工作区改动（`git checkout -- .`，工作树回到 `f5d9a25` 干净态）；playerProvider 主迁移与 cast 域迁移合并记为**阶段 3b**，前置条件=先设计 invalidate 重建语义（资源清理策略）+ 真机回归条件，届时连同 cast 域 151 处 fake 一次性规划。

**状态**：阶段 3a 完成（3 个小 provider 落 `f5d9a25`），主迁移延期 3b（阻塞项已记录在案）。ADR-2 代码结构改造（2a/2b）与阶段 3a 全部落 230 `main`，工作树干净。剩余：全量回归 → 真机冒烟 → 发版 v5.8.11。

**教训**（NotifierProvider 迁移三坑）：①2.6.1 的 `overrideWith` 收零参工厂，`(ref) =>` 全部要改；②Notifier 未 attach（build 未跑）前读写 state 抛 LateInitializationError，测试替身不能再用「构造时写 state」模式，初始值必须走 `build()` 返回；③**invalidate 语义是 StateNotifierProvider→NotifierProvider 迁移的最大隐藏分水岭**——实例保留 vs 整体重建，凡 notifier 构造期建立资源（AudioPlayer/Timer/订阅）且存在 `ref.invalidate` 调用点的，必须先审计重建语义再动手；行尾纪律：Windows 本地产出的文件经 sftp 上传带 CRLF，写入 LF 仓库文件会造成全文件 diff 噪音（b29a 反向同理），put 前先核对目标文件行尾。

### [l20] 全量回归 + v5.8.11 发版 + Playback Chain Guard 路径失配修复 ✅

**全量回归**：`flutter analyze lib/providers/player` **59 = 基线**（域口径）；全量 `flutter test` **+4163 All tests passed**、退出码 0（230 分离执行，日志 `/tmp/verify_full.log`）。过程中发现两组 `flutter test` 并发（上一轮遗留任务未清），互相争 CPU 使 load 达 11、进度停滞——清掉重复进程组、保留写日志的一组后独占跑完，属环境调度问题而非代码问题。

**发版 v5.8.11**：230 `main` 推送（`e9de00a..f546c48`，7 个功能提交 + 1 个 changelog），tag `v5.8.11`（消息：DLNA 暂停轮询降频 + 投屏冷启动鉴权加固 + 播放内核 ADR-2 结构化拆分 2a/2b/2b-2/3a-1）。tag 侧 8 个作业**全绿**（含 Build Client 9m50s），Release「MusicFlow Client v5.8.11」于 09:59:37Z 自动发布（非 draft / 非 prerelease）。

**CI 报错定位与修复（Playback Chain Guard）**：main 推送除 tag 侧 8 作业外，额外触发主分支专用守卫（`Playback Chain Guard` / `Transcode` / `Offline Cache` / `Cover Display`），其中 `Playback Chain Guard` 以**退出码 2** 失败：`目标文件不存在: lib/providers/player/player_playback_session.dart`。根因两层：①ADR-2 阶段 2b 提交 `615ad9b` 已将 `player_playback_session.dart` 并入 `player_session_persister.dart`（内容含 `readSessionQueueOrigin(session!)`），而结构守卫脚本 `tool/handoff_chain_scan.dart:181` 仍**硬编码旧路径**；②该守卫「恢复侧回填 `queueOriginProvider`」的正则原要求**读与写在同文件**，2b 拆分后写回动作随宿主窄接口迁至 `player_provider.dart` 的 `queueOrigin` setter（`set queueOrigin => _ref.read(queueOriginProvider.notifier).state = origin`），同一文件内的正则已不可能匹配。
修法（提交 `68fc30b`，1 文件 +18/−7，零运行时影响）：扫描目标改指协作者 `player_session_persister.dart`，并新增宿主 `player_provider.dart` 为扫描对象；断言拆成**三环各自钉死**——persister 读 `readSessionQueueOrigin(session!?)`、persister `host.queueOrigin = ` 交回宿主、宿主 `queueOriginProvider.notifier).state =` 落 provider，任一环缺失即 CI 红；失败消息中的旧文件名同步更新。本地 `dart run tool/handoff_chain_scan.dart` → `OK: 接续搬移契约完整`（exit 0 分支）；推送后 main **11 作业全绿**（Playback Chain Guard 3m20s 全步骤跑通、Test Suite 13m38s success）。

**是否补版**：**不重打 tag**。App 代码与 `v5.8.11` tag 完全一致（该守卫仅 `on: push branches main / pull_request`，不参与 tag 发版门禁），Release 已发布且由 tag CI 全绿背书；本次仅在主分支补一个 CI 工具修复提交。

**真机冒烟说明**：本机无 flutter/dart 工具链（此前 `mfc` 目录仅为散文件暂存），**无法自主执行 Windows 真机冒烟**，改以「tag/主分支 CI 构建门禁（Build Client）+ 全量测试 4163 绿」替代；Android（ADR2）与 Windows 同源，未单独验证。

**生产部署**：240 环境**未部署**，按约束等待用户另行批准。

**教训**（结构扫描守卫的隐蔽失效）：把「目标文件名 + 单文件内读写」写死的结构扫描，一旦重构搬移文件就**静默失效**——①本地全量测试不红（契约未被行为测试覆盖，正是当初引入扫描的理由）；②tag 门禁也不覆盖（守卫只在 main/PR 触发），**只有 main 推送才暴露**。ADR-2 类抽取只要改文件名或拆文件，就必须同步 `tool/**` 的扫描目标与断言位置，并把断言**按链路各环分别落点**（读写跨文件时不能停留在「同一文件里搜正则」）；发版后仍需回头确认 main 分支守卫集全绿。

### [l21] 服务端网络代理现状与优化方案 + Web 管理端「音乐下载」页打开卡加载根因（分析 → 落地见 [l22]）✅

（两部分均为静态代码审计结论；除下方标注 230 开发库的实测耗时外，未在 240 生产容器内做运行时测量。）

**A. 服务端「网络代理」现状**（对应用户两点抱怨：Gitee 不走代理、关闭无保存按钮 / 刷新回弹）

- **落点**：[proxy.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/proxy.ts#L24-L193)（`getProxyConfig` / `normalizeProxyUrl` / `proxyFetch` / `testProxyConnection`）、[api/proxy.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/api/proxy.ts#L17-L43)（GET/PUT `/v1/proxy`、POST `/v1/proxy/test`）、[Settings/index.vue](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/Settings/index.vue#L47-L54)（Web 管理端 UI）。
- **存储与生效**：settings 表 `proxy_enabled` / `proxy_url`；仅当 `enabled && url` 非空时 `proxyFetch` 才注入 dispatcher；`normalizeProxyUrl` 仅接受 `http(s)://|socks[45]://host:port`，非法/空 → 视同直连。agent 池按地址缓存、FIFO 上限 32、地址变更自然重建；**全程未调用 `setGlobalDispatcher`**（proxy.ts L10 注释明示），故不污染其它后端网络。
- **生效范围只有两条链路**：①插件市场拉取（registry.json / plugin.json / 安装包 tar.gz）②插件沙箱 `host.http`。DLNA 轮询、封面/歌词、Web 自身请求等**一律直连**。
- **无按域名分流**：`proxyFetch` 只读全局开关，不区分 `*.gitee.com` 与 `github.com`——**服务端对 Gitee 与 GitHub 完全同待遇**。`ProxyFetchInit.proxy?: boolean`（true 强走 / false 强直连 / 缺省跟随开关）已实现但全仓**零调用点**。
- **结论**：用户所说「Gitee 不管开关都不走代理」**并非服务端代码决定**——最可能是代理软件自身分流规则把 gitee.com 判为 DIRECT；次可能是开关未真正生效（url 空/非法 → 全局直连落空）。
- **前端缺陷（同一 root cause 解释「无保存按钮」+「刷新回弹」）**：
  - [Settings/index.vue:47](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/Settings/index.vue#L47) 的 `el-switch` 只 `v-model`，**没有 `@change`**（对比同文件 :23 / :84 的开关都带 `@change`）→ 关闭开关只改本地 ref，**不落盘**。
  - [:49](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/Settings/index.vue#L49) 的 `v-if="proxyEnabled"` 把 URL 行（含 :53「测试」、:54「保存」按钮）**一起隐藏** → 关闭时页面上根本没有保存按钮。
  - 后果：关闭仅改前端变量，服务端 `proxy_enabled` 仍为 true；[:405](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/Settings/index.vue#L405) 挂载即调 `loadProxy()`（:207，:210 回写 enabled），于是刷新又「回弹」为开。
  - 另 [:228-231](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/Settings/index.vue#L228-L231) `testProxy()` 先隐式 `PUT` 保存再测，url 为空点保存会触发后端 400（api/proxy.ts:26-27），前端无预校验。
- **优化方案**（前端为主，后端可选）：a. 开关补 `@change` 即时 PUT（乐观更新 + 失败回滚 + loading），与 :23 / :84 一致；b. 把 URL / 测试 / 保存行移出 `v-if`（关闭时置灰只读），保证「关闭」也有明确的落盘动作；c. 保存成功后用服务端返回的 `{enabled,url}` 回写本地，避免前后端状态漂移；d. `testProxy()` 不再隐式保存，改传参临时测试；e. 后端可选：`/v1/proxy/test` 接受 `{enabled,url}` 覆盖参数、不落盘；f. 后端可选（若要服务端显式分流）：新增按域名策略（`proxy_mode: auto|always|off` 或 `proxy_bypass_hosts`，默认 `*.gitee.com` + 内网段），在 `proxyFetch` 按 host 决策；g. 测试补 Gitee 探测点（现仅 probe GitHub registry + 中立站点）。
- **待确认 3 点**：①「Gitee 不走代理」是**实测**还是**期望**？②是否要服务端显式按域名分流？③「关闭代理」是否要求**即时生效**？

**B. Web 管理端「音乐下载」页打开卡加载**（`admin/Fetch`）

- **归属确认**：`frontend/src/locales/zh-CN.json` 中 `"fetchManage": "音乐下载"` / `"title": "音乐下载"` → 即 [admin/Fetch/index.vue](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/admin/Fetch/index.vue#L1)。
- **根因**：页面 [onMounted:841-848](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/admin/Fetch/index.vue#L841-L848) 一次性并发 **8 个**管理端请求（config / sources / upgradeConfig / upgradeStats / libraryPlan / tagRepairStatus + 两个 `JobListPanel` 各自自拉）。其中两个是**全表扫描**，且在 Node **单线程**上以 **better-sqlite3 同步**执行，直接**阻塞事件循环**：
  - [GET /v1/fetch/upgrade/plan](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/api/fetch.ts#L452) → [buildUpgradePlan:227](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/upgrade.ts#L227) → [collectUpgradeSongs:169](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/upgrade.ts#L169)（`type='local' AND path LIKE 'l:<sid>:%'` 逐源扫）；
  - [GET /v1/fetch/library/plan](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/api/fetch.ts#L552) → [buildLibraryPlan:156](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/library.ts#L156) → [collectLibrarySongs:75](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/library.ts#L75)（`path NOT LIKE 'l:%' AND path NOT LIKE 'w:%'`）。
- **实测（230 开发库 `data/musicflow.db`，23,719 行）**：两条扫描 `EXPLAIN QUERY PLAN` 均为 `SCAN songs`（**无可用索引**）；`collectLibrarySongs` 谓词命中 **23,717 行**、耗时 **120ms**、并把 23,717 行 materialize 成 JS 对象（**97.6ms**）；`collectUpgradeSongs` 本次仅 2 行（开发库几乎全 web 行）≈28ms。生产 240 `songs` 表为 **134,500 行**，线性放大约 **0.7s/次**。
- **为什么体感是「卡在加载」而非「慢」**：Node 事件循环被同步扫描占满时，**所有**在途请求一起排队——当前可见的「配置」tab 的 `v-loading`（[:11](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/admin/Fetch/index.vue#L11)）要等 `getFetchConfig` 排到才解，于是整页 spinner 卡住；且 [watch(activeTab):851-854](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/admin/Fetch/index.vue#L851-L854) 每次切到「下载 / 洗版」会**再次**触发同款全表扫描，反复卡顿。
- **优化方案**：
  - 后端（治本，去阻塞）：1) 「只要计数」快路径——`buildLibraryPlan` / `buildUpgradePlan` 在 `limit<=0`（UI 实际只看 `pending/attempted/total`）时用 `SELECT COUNT(*)` 出统计，**不再 materialize 全部行**，仅在真要枚举条目时才拉明细；2) 结果加**短 TTL 缓存 + 库变更失效**（库 / 下载区变更频率低，可把每次打开的 0.7s 降为内存命中）；3) 给 `songs(path)` 补索引——`LIKE 'l:<sid>:%'`（前缀型）可走索引，负向 `NOT LIKE` 无法命中，只能靠 (1) count 化或 (2) 缓存。
  - 前端（减请求、拆 loading）：4) **按 tab 懒加载**——`loadUpgradeStats` / `loadLibraryPlan` 只在首次切到对应 tab 时调（现 mount 与 watch 双触发，去掉 mount 那次）；5) 两个 `JobListPanel` 用 `el-tab-pane lazy` **懒挂载**，避免打开页面就同时自拉 + 轮询；6) 每个 tab 独立 loading，别让单个 spinner 覆盖全页。
- **体感预期**：改完后打开页面只发 1-2 个轻请求、不再全表扫描，首屏 spinner 基本瞬开；切 tab 不再二次全表扫描。

**遗留（已闭环 2026-10-14）**：230 上 `gh run list --commit 0ddeee8…` 复查服务端 `build-and-push` 最终结论失败（`error connecting to api.github.com`）系 230 当时 GitHub 出口不可达所致。网络恢复后复查：该提交全部 7 个作业（Version Guard / Playback Chain Guard / Sendspin Guard / frontend-responsive / pentest / ci / security / build-and-push）均 `completed / success`，`build-and-push` 14m28s。**该项关闭**。

**教训**：①管理端「仪表盘型」页面把 N 个聚合统计请求一起 `onMounted` 触发，是「打开卡加载」的高发模式——尤其当后端用**同步 SQLite** 且统计走**全表扫描**时，代价被整个事件循环放大（一个慢请求拖死全部在途请求）；②前端开关类控件「`v-model` 但漏 `@change`」会造成「改了没存」+「刷新回弹」这类看似玄学的现象，同一文件里已有正确样例（:23 / :84）对照即可发现；③「按域名分流代理」不能靠端点归属推断——`proxyFetch` 只看全局开关，Gitee / GitHub 同待遇，用户体感的分流差异大概率来自代理软件规则，需先问「实测还是期望」再决定是否落到服务端。

### [l22] 关代理即时生效 + 「音乐下载」页打开卡加载治本落地（分析见 [l21]）✅

**用户拍板（2026-10-14，原话）**：「1，是期望，如果现在默认不走代理那就不管它。2，不管了，3关代理是要立即生效的。」→ ①「Gitee 不走代理」属**期望**语义，现状（仅插件市场 + 沙箱联网走代理、其余直连）已满足，**服务端不做按域名分流**；②[l21] 方案 f/g（服务端 `proxy_mode` / `bypass_hosts`、Gitee 探测点）**不实施**；③**关闭代理必须立即生效**，落地前端修复。

**落地 1（代理即时生效，前端最小改动）** —— [Settings/index.vue](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/Settings/index.vue#L47-L54)

- :47 `el-switch` 补 `@change="onProxyToggle"` + `:loading="proxySaving"`；拨动即 `PUT /rest/api/v1/proxy {enabled,url}`，**乐观更新 + 失败回滚**（catch 里把 `proxyEnabled` 还原为 `!next`）+ 用服务端返回的 `{enabled,url}` 回写本地，消除前后端漂移。
- :49 `v-if="proxyEnabled"` **移除** → URL / 「测试」/「保存」行常驻，关闭态也有明确的落盘动作（原「无保存按钮」根因即此行被一起隐藏）。
- 后端无需改动：`setSetting()` 写库**同时 `cache.set` 刷新内存缓存**（[settings.ts:26-30](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/settings.ts#L26-L30)），故 PUT 后下一次 `getProxyConfig` 立刻读到新值 → **即时生效**（无 5s 读缓存滞后）。
- 保留 `saveProxy` / `testProxy` 原语义（最小改动）；`testProxy` 的隐式 PUT 未按 [l21] 方案 d 改造，避免牵连后端 `/v1/proxy/test` 签名。

**落地 2（「音乐下载」页卡加载：治本去阻塞 + 治标减请求）**

- 治本（后端 COUNT 快路径，**不再 materialize 全表**）：
  - [library.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/library.ts#L156) 新增 `countLibraryPlanStats(cfg)`：`SELECT COUNT(*) FROM songs WHERE path NOT LIKE 'l:%' AND path NOT LIKE 'w:%'` 取 total；`JOIN` 出 attempted；`SUM(CASE WHEN a.attempted_at > ? THEN 1 ELSE 0 END)`（`attempted_at` 为定宽 `toISOString()`，**字符串比较等价时间比较**）出 cooled；`pending = max(0, total - cooled)`。口径与慢路径**逐项等价**。`buildLibraryPlan` 在 `limit<=0`（UI 只看统计）时**早退**直接返回该统计。
  - [upgrade.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/upgrade.ts#L221) 新增 `countUpgradePlanStats(sourceIds, cfg)`：逐源 `SELECT COUNT(*) ... WHERE type='local' AND path LIKE ?` 累加 total（保留「重复源重复计入」语义），OR 组合 + `JOIN` 出 attempted/cooled，`belowBar = max(0, total - cooled)`。`buildUpgradePlan` 增 `opts.statsOnly`，无 `songIds` 点名时早退。
  - [fetch.ts:463](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/api/fetch.ts#L463) `GET /v1/fetch/upgrade/plan` 判 `hasLimit = Number.isFinite(limitRaw) && limitRaw > 0`，**无 limit 时才走 `statsOnly`**（点名 `songIds` / 要明细的调用不受影响）。
- 治标（前端减请求、拆加载，[admin/Fetch/index.vue](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/admin/Fetch/index.vue#L841-L866)）：
  - `onMounted` 移除 `loadUpgradeStats()` / `loadLibraryPlan()`；新增 `libraryPlanLoaded` / `upgradeStatsLoaded` ref，`watch(activeTab)` **只在首次切到** `create` / `upgrade` tab 时各自拉一次（去掉 mount 那次双触发）。
  - 两个 `JobListPanel` 页签加 `lazy`（`name="jobs"` / `name="upgradeJobs"`），避免打开页面即自拉 + 轮询。

**实测（230 开发库 `data/musicflow.db`，23,719 行，命中 23,717 行）**

| 路径 | 旧（materialize 全表） | 新（COUNT 快路径） | 收益 |
| --- | --- | --- | --- |
| 库池统计 `buildLibraryPlan` | 174.5ms（8 列 + `ORDER BY rowid` + JS map） | 21.3ms | ≈8× |
| 生产 240 外推（`songs` 134,500 行） | ≈1.0s | ≈0.12s | ≈8× |

- 判定 [l21] 方案 3（`songs(path)` 索引）**无需实施**：`idx_songs_path ON songs(path)` 已存在（[db/index.ts:426](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/db/index.ts#L426)）；负向 `NOT LIKE` 本就无法命中索引，故靠 COUNT 化解决。
- 判定 [l21] 方案 2（短 TTL 缓存）**未引入**：COUNT 后单次已 ≈0.12s，且统计已不再随首屏触发，避免新增缓存失效耦合（库/下载区变更时的一致性成本 > 收益）。

**验证（落地前审查 + 落地后复审）**

- 新增回归用例：`backend/tests/fetch/library.test.ts`（「limit=0 快路径与明细路径统计等价」2 例：四项统计与 `limit=10` 明细一致 + 冷却窗口外只计 attempted）、`backend/tests/fetch/upgrade.test.ts`（「statsOnly 快路径与明细口径等价」3 例：`items=[]` + 四项一致 + 冷却期外恢复 + `songIds` 点名不吃快路径），均通过。
- `npx vue-tsc --noEmit` 通过（`el-switch@change` 载荷为 `string | number | boolean`，`onProxyToggle(val: string | number | boolean)` + `Boolean(val)`）。
- **后端全量 suite**：504 文件 / 6817 用例 → **1 failed**；失败项 `tests/plugins/sandbox.test.ts > 沙箱内存自愈 > 内存超限错误可被 SandboxLimitError 类型识别`，隔离复跑 **28/28 全绿**，判定为满负载（504 并行 worker + load ~5）**flake**，与本次改动无关（CI 为单进程串行 ≈803s，不复现）。

**发布**（230 main，经 230 中转推 GitHub）

- `7677063 fix(fetch,web): 关代理即时生效 + 下载页统计去全表 materialize，消除打开卡加载`（7 files，+292 / −20）
- `0326d1c chore(release): CHANGELOG v4.6.13`（1 file，+13）；tag `v4.6.13` 打在该提交上
- `git push origin main`（`0ddeee8..0326d1c`）与 `git push origin v4.6.13`（tag 对象 `21d37a19801658a6ebbeed83c5433183cfbe3ed7`）均成功
- CI：tag 触发的 `build-and-push`（`.github/workflows/build.yml`，`push: tags: ["v*"]`）自动发版，含全量 vitest 门禁 + 非阻塞镜像构建；Release + `ghcr.io/…/musicflow:4.6.13` 由该作业产出

**遗留**

- **生产 240 未部署**（按约束须另行批准）。
- 服务端按域名分流**不做**（用户拍板②）；`ProxyFetchInit.proxy` 仍为零调用点。
- 「Gitee 不走代理」若后续要求服务端强制，需另立 [l23] 方案。
- 下载页可选「每 tab 独立 loading」未做（当前首屏已只发 1-2 个轻请求，体感达标）。

**教训**：①「统计接口」必须区分「只要计数」与「要枚举明细」——把两者混在同一条全表 materialize 路径上，是同步 SQLite 项目里最容易被忽视的事件循环杀手；`COUNT(*)` + `JOIN` + `SUM(CASE)` 可在**不改变口径**的前提下把统计降一个数量级。②代理开关这类「状态即配置」控件，`v-model` 必须配 `@change` **即时落盘**，且落盘控件本身不能包在受该开关控制的 `v-if` 里——否则「关」这个动作没有保存入口，「刷新回弹」是必然而非玄学。③用户拍板要落成**可追溯的决策记录**（本条即），避免下一轮把「期望语义」误当「缺陷」重复开工。

### [l23] 前端全页面「打开速度」代码审查（26 视图 + 构建配置，2026-10-14）✅（已落地，见 [l24]；本节保留审查原貌）

**审查范围**：`frontend/src/views/**` 全部 26 个 `.vue`（含 `admin/*`、业务页与子组件）、`router/index.ts`（**23 处 `() => import()` 路由级懒加载**）、`vite.config.ts`（Element Plus 引入方式）、`main.ts`、`layouts/MainLayout.vue`。方法：逐页统计 `onMounted/onActivated` 内首屏请求数、`el-tab-pane` 是否 `lazy`、是否有常驻 `setInterval`、是否重复拉全站通用配置。

**结论总览（大白话）**

1. **底子已经是好的**——路由级代码分割齐全（23/23 懒加载）；`Home` 首页是「渐进渲染」样板（快请求 `Promise.all` 先复位 loading、慢的推荐聚合独立并行不阻塞）；`admin/Fetch` 上一轮已治（全表扫描统计改 COUNT + 任务面板 `lazy`）；`Flows/index`、`Playlists/index` 用了 `keep-alive` + `onActivated` 复用。**本轮未发现「打开即卡死」级新问题**，剩余均为「首屏请求偏多 / 常驻轮询 / 可懒加载」的中小项。
2. **最该动的 4 个页面**（按收益排序）：
   - **`admin/Plugins/index.vue`（2086 行，全站最大单文件）**：一进页面同时拉 `loadPlugins + loadHealth + loadMediaSettings` 三个接口，且 **3 个 `el-tab-pane` 全部未加 `lazy`** → 「已安装 / 插件市场 / 媒体库」三页签内容在打开瞬间一次性挂载 + 渲染。建议：3 页签补 `lazy`（只挂当前页签）、`loadHealth`（较重）改「切到市场页签才拉」、并按页签拆成 3 个子组件（打开速度 + 可维护性同改善，做法同 [l1]）。
   - **`Groups/index.vue`（1850 行）**：一进页面并发 **8 个请求**（`loadGroups / loadDlnaDevices / loadAirPlayDevices / loadSendspinClients / loadHiddenPrefs / loadNamePrefs / loadLocalPlayers` + `startSendspinPolling`），其中 DLNA / AirPlay 属网络发现类探测、通常较慢，会拖住首屏。建议：首屏只拉 `loadGroups`，设备发现 / 本机实例 / 配对状态放可折叠分区或独立页签，展开或切换时才拉，轮询一并收进去。
   - **`Playlists/index.vue`（1285 行）**：一进页面 4 个请求（`detectDailySource / loadImportPlatforms / loadSearchProviders / pollBusy`），且挂了一个**每 4 秒永久执行的后台轮询 `busyTimer`**——页面开着就一直在打后端（不管有无任务）。建议：`busyTimer` 改为「有进行中任务才开、空闲即 `clearInterval`」；`loadImportPlatforms`（导入平台列表，变化极少）延后 / 缓存。
   - **`Settings/index.vue`**：一进页面 **6 个 GET**（`loadVersion / loadProxy / loadBatchPace / loadMemorySettings / loadDailyConfig` + 管理员 `loadLogLevel`），均为「读配置」小请求。建议：后端加 `GET /v1/settings/summary` 一次返回（1 RTT 替代 5~6），或按卡片懒加载。
3. **全站通用配置被重复拉取**：`loadSearchProviders()`（音乐搜索平台列表，几乎不变）在 `Albums / Artists / Music / Playlists / admin/Fetch` 等多页各拉一遍。建议**启动时拉一次入 store**、各页读缓存 → 每次进页少一个 RTT。
4. **常驻轮询收紧**：① `Playlists/index` 的 4s `busyTimer`（见上）；② `Settings/SendspinPairing.vue` 的 5s 轮询——配对完成即应停表，改为「仅正在配对时轮询」。（`admin/Sources` 进度轮询、`Audio` 测量轮询、`Artists` 抓取状态轮询均已是「有操作才轮询」，OK。）
5. **构建 / 加载层（小项，高风险）**：Element Plus 走 `unplugin-vue-components` **JS 按需**，但 **CSS 仍是全量 `element-plus/dist/index.css`**（注释显示为刻意的主题优先级取舍）→ 首屏样式表偏大。若后续继续压首屏，可评估「按需 CSS + 手动保序关键样式」，但**回归风险高，建议单独立项**、不与本轮同动。
6. **列表页 loading 粒度**：多数列表页用**整页 `v-loading` 遮罩**，会被最慢的那个请求拖住观感；`Home` 已示范分区骨架。建议首屏重页（Plugins / Groups / Favorites）改分区骨架，谁的数据先到谁先出。

**建议优先级**：P1 = 插件页 `lazy` + 拆子组件、Groups 设备发现懒加载、Playlists `busyTimer` 收紧；P2 = Settings 合并接口、`loadSearchProviders` 全局缓存、SendspinPairing 轮询收紧；P3 = 分区骨架 loading、Element Plus CSS 按需（高风险，单独立项）。

**验证 / 遗留**：本轮**仅审查出方案、未改任何前端代码**（落地结果见 [l24]）；每条落地前须走「落地前审查 → 落地 → 落地后复审」并补 `vue-tsc` / 单测。本轮为**静态代码审查**（未做浏览器 / 真机实测首屏耗时）。

**教训**：审查「页面打开速度」要分两层——**「首屏请求数 × 单请求阻塞度」**（前端 + 接口层）与 **「路由/组件是否已分割、页签是否 `lazy`」**（打包挂载层）。本项目路由分割与首页渐进渲染已做对，故增量收益集中在「**没 `lazy` 的页签**」「**并发过多的首屏请求**」「**永不停表的轮询**」三类，而非大改构建。

### [l24] 前端「打开速度」优化落地（6 文件，2026-10-14）✅ 已发版 v4.6.14

**落地范围**（功能提交 `7dc399b perf(frontend): 各页面打开速度优化——削减首屏并发请求与常驻轮询`，6 文件 +186/−43；纯前端、后端零改动）

| 项 | 文件 | 做法 |
|---|---|---|
| P1① 页签懒挂载 | `admin/Plugins/index.vue` | 3 个 `el-tab-pane` 补 `lazy`（非当前页签整块不挂载）；`loadMediaSettings` 从 `onMounted` 移出（切到媒体页签时 `onTabChange` 已拉）；「已安装」页签所需的 `loadPlugins + loadHealth` 保留首屏 |
| P1② 分区按视口懒加载 | `Groups/index.vue` | 4 个设备发现分区打 `data-lazy-section`，`onMounted` 用 `IntersectionObserver`（rootMargin 200px、以本页根节点 `querySelectorAll` 限定作用域）在分区进视口时才发该分区请求，每区只自动拉一次；无 IO 时兜底一次性全拉；`loading*` 初值置 `true` 避免首帧「无设备」闪烁 |
| P1③ 轮询收紧 + 首屏减量 | `Playlists/index.vue` | `busyTimer` 由固定 4s 常驻改两级（忙 4s / 闲 15s，首次立即查一次，保留「别处起任务也能提示」）；`detectDailySource` 与 `loadImportPlatforms` 移出首屏（二者打的是同一个较重的 `/rest/api/v1/plugins`，且各自在真正用到时都会自补）→ 进页请求 4 → 2 |
| P2④ 配置卡懒加载 | `Settings/index.vue` | 6 张卡打 `data-settings-load`，进视口才拉；非管理员无日志卡 → 天然不发请求（与原 `if (authStore.isAdmin)` 等效） |
| P2⑤ 跨页共享短缓存 | `composables/useEntitySearch.ts` | 插件能力列表加模块级 60s TTL 缓存（新增 `force` 形参），音乐 / 艺术家 / 专辑三页共用 1 次请求 |
| P2⑥ 配对轮询条件化 | `Settings/SendspinPairing.vue` | 5s 轮询改为「配对表单打开 或 服务端仍有 pending attempt 才跑」，`beginPair/beginToken` 主动开表、到终态自动停表 |
| Fix 轮询泄漏 | Groups / Playlists / SendspinPairing | 全站路由视图包在 `<keep-alive max="10">` 中，切走页面 `onUnmounted` 不触发 → 三处常驻轮询（20s / 4s / 5s）此前会一直打到会话结束（原注释「离开页面即停」在缓存下不成立）；均补 `onDeactivated` 停表 + `onActivated` 复表，`onUnmounted` 保留兜底 |

**对 [l23] 的两条事实修正（按代码现状改方案）**
1. [l23] 说「Groups 首屏只拉 `loadGroups`」——模板实际顺序为「本机实例 → DLNA → AirPlay → Sendspin → 群组列表」，群组列表在**页面末尾**，首屏可见的恰是设备发现区 → 改为**按视口懒加载**，而非颠倒请求优先级。
2. [l23] 说「Plugins 的 `loadHealth` 改切到市场页签才拉」——健康列在**默认的「已安装」**页签上，延后会使其显示未知 → `loadHealth` 保留首屏加载。

**明确未做（评估后延后，理由留档）**
1. Plugins 拆 3 个子组件：`lazy` 已使首屏只挂当前页签，拆分对首屏零额外收益，却是 2086 行文件的高风险重构。
2. 首屏分区骨架屏（P3⑦）：Favorites 与各设备分区已是分区 `v-loading`，唯一整块遮罩（Groups 群组列表）只等 1 个轻请求 → 收益不足。
3. Element Plus CSS 按需（P3⑧）：主题优先级回归风险高，[l23] 本身建议单独立项，本轮不并入。
4. Playlists 的 `playlist-search/providers` 缓存：另一端点，keep-alive 下每会话仅 1 次，收益≈0。

**验证**
- 230 前端 `npx vue-tsc --noEmit` → 0 error；`npx vite build` → `✓ built in 31.13s`（即 CI 镜像阶段内的前端门禁）。
- 流程：改动前二次审查 → 逐条落地 → 改动后复审 + `agent-pr-review`（无 blocker，3 条 follow-up：无「请求数断言」自动化用例、providers 60s 陈旧窗、上述延后项）→ release 双审查（`release-build-reproducibility` / `production-readiness-review`，均 clean）。commit / release 两个 receipt 已写入 230 仓 `.git/staff-engineer-mode/receipts/`。
- 前端仓库无单测基建，故无自动化请求数断言（follow-up）；后端零改动，CI 全量门禁照常。
- CI：`chore(release): CHANGELOG v4.6.14` → annotated tag `v4.6.14` → 经 230 `git push origin main` / `git push origin v4.6.14`；全量门禁与镜像结果见下方【CI 追记】。

**【CI 追记】已全绿（2026-10-14 21:32，SHA `73c5780`）**：`build-and-push`（`全量测试门禁 vitest` = success、`构建并推送镜像` = success、`容器镜像漏洞扫描 Trivy image` = success、`回滚发版(test 失败时)` = **skipped**，即门禁未触发回滚）；main 侧 `Version Guard / ci / security / pentest / Playback Chain Guard` 全 success；tag `v4.6.14` 侧 `Version Guard / build-and-push / contract-gate(播放端契约冒烟) / security(npm audit+OSV、Trivy 整仓、License、gitleaks、CodeQL)` 全 success。**Release `v4.6.14`** 已发布（`draft=false`、`pre=false`、发布时刻 `2026-10-14T13:32:24Z`、目标 main）；**镜像 `ghcr.io/ray5378/musicflow:4.6.14`（digest `sha256:0086ac62…cb39`）** 已被 Trivy 步骤实际拉取校验通过（`latest` 同标签同步）。

**发版**：`v4.6.14` 已发布到 GitHub（`ghcr.io` 镜像同名）。**按既定约定不部署生产 240**，240 仍运行 v4.6.13 镜像，部署待用户另行批准。

**教训**：①「页面打开速度」的杠杆排序是**挂载层（页签 `lazy`）> 请求层（首屏并发数）> 轮询层（常驻定时器）**，实现都只值几十行，但前提是先分清「哪些内容真正在首屏可见」——本轮两条事实修正都源于审查清单把页面区块顺序想当然了。②全局 `<keep-alive>` 视图下，「离开页面就停表」不能靠 `onBeforeUnmount`（切走不触发），必须 `onDeactivated`；这类泄漏功能测试看不见，只有把「常驻定时器清单」逐条对一遍才暴露。③「延后加载」必须配套「用到时自补」，否则等于删功能；本轮四处延后全部核对了自补路径（页签 `onTabChange`、`syncDailyAll` 内 `if (!dailySourceId) await detectDailySource()`、导入弹窗打开时 `loadImportPlatforms`、以及卡片元素存在性）。

## Sources

以下为本次分析直接引用的一手代码文件（`file:///` 绝对路径 + 行号；对应远端权威路径见 §1.1）。

**客户端（`MusicFlow-client` v5.8.1）**

- [lib/main.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/main.dart#L15-L82)
- [lib/app.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/app.dart#L87-L201)
- [lib/providers/player/player_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L60-L79)、[#L177-L205](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L177-L205)、[#L538-L539](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_provider.dart#L538-L539)
- [lib/providers/player/player_position_polling.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_position_polling.dart#L11)
- [lib/providers/player/player_seek.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/player/player_seek.dart#L184-L272)
- [lib/providers/cast/cast_peer_provider.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/providers/cast/cast_peer_provider.dart#L1)
- [lib/core/dlna/ssdp_discovery.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/ssdp_discovery.dart#L100-L218)
- [lib/core/dlna/device_description.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/device_description.dart#L11-L34)
- [lib/core/dlna/soap_control.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/soap_control.dart#L43-L88)
- [lib/core/dlna/dlna_manager.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/dlna/dlna_manager.dart#L347-L385)
- [lib/core/network/fallback_interceptor.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/network/fallback_interceptor.dart#L14-L63)
- [lib/core/network/health_checker.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/network/health_checker.dart#L14-L19)
- [lib/core/offline/offline_cache_manager.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/core/offline/offline_cache_manager.dart#L112-L140)
- [lib/data/repositories/library_repository.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/data/repositories/library_repository.dart#L51-L111)
- [lib/data/sources/subsonic_api_client.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/data/sources/subsonic_api_client.dart#L18-L22)
- [lib/widgets/cover_art_image.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/widgets/cover_art_image.dart#L14-L333)
- [lib/features/player/pages/full_player_page.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/features/player/pages/full_player_page.dart#L1)
- [lib/features/discover/pages/discover_page.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/features/discover/pages/discover_page.dart#L1)
- [lib/widgets/mini_player.dart](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/lib/widgets/mini_player.dart#L1)
- [pubspec.yaml](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/pubspec.yaml#L64-L67)
- [docs/playback_chain_audit.md](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow-client/docs/playback_chain_audit.md#L1-L150)

**服务端（`MusicFlow` v4.6.5）**

- [backend/src/routes/rest/index.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L1772)、[#L2010-L2017](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L2010-L2017)、[#L2101-L2120](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/rest/index.ts#L2101-L2120)
- [backend/src/services/source/prefetchCache.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/source/prefetchCache.ts#L3-L120)
- [backend/src/services/source/bufferedFetch.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/source/bufferedFetch.ts#L13-L59)
- [backend/src/services/coverCache.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverCache.ts#L24-L44)
- [backend/src/services/coverImage.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/coverImage.ts#L66-L177)
- [backend/src/services/covers.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/covers.ts#L43-L48)

**[l21] 新增引用（服务端代理 + Web 音乐下载页）**

- [backend/src/services/proxy.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/proxy.ts#L24-L193)
- [backend/src/routes/api/proxy.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/api/proxy.ts#L17-L43)
- [backend/src/routes/api/fetch.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/routes/api/fetch.ts#L452-L643)
- [backend/src/services/fetch/library.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/library.ts#L75-L160)
- [backend/src/services/fetch/upgrade.ts](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/backend/src/services/fetch/upgrade.ts#L169-L240)
- [frontend/src/views/Settings/index.vue](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/Settings/index.vue#L47-L54)
- [frontend/src/views/admin/Fetch/index.vue](file:///c:/Users/ray5378/AppData/Local/Temp/mf-src/MusicFlow/frontend/src/views/admin/Fetch/index.vue#L841-L854)

> 说明：本报告为静态代码审计结论，未在生产容器（`192.168.10.240:35320`）内做运行时测量；标注 `[unverified]` 的条目需以运行时采样或进一步代码核查确认。所有行号对应当前镜像版本。