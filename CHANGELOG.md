# 更新日志 (Changelog)

本文件记录各版本的主要变更。版本号遵循语义化版本，仅在打 `vX.Y.Z` tag 时由 CI 构建并发布（产物：Docker 镜像）。

## [4.2.1] - 2026-10-08

### Sendspin 解码窗口上限可配 + 清理整曲解码旧路径

- **解码窗口上限可配**:Sendspin 插件新增「解码窗口上限」配置项(30 秒 ~ 10 分钟共 11 档,缺省 30 秒=最省内存档)。控制服务端每个正在播放的组为每首曲保留多少未消费 PCM(约 0.375MB/秒/组)——30 秒 ≈ 11MB,5 分钟 ≈ 115MB,10 分钟 ≈ 230MB。下一首生效。
- **整曲保留**:歌长 ≤ 窗口上限的曲目自动进入**整曲保留**——不淘汰、不背压,前后拖动 seek 全程命中窗口(零成本、不重起 ffmpeg);歌长 > 上限的曲目走滑动窗口,**照样正常播完**,仅回退/前跳超窗时重建解码(约 1 秒空窗)。
- **退役「流式解码开关」**:旧配置项 `stream_source`(及其 `SENDSPIN_STREAM_SOURCE` 环境变量)连同死代码与全部分支一并删除——流式解码现为**恒开**,与「解码窗口上限」方案重叠,旧开关的「关闭即整曲解码进内存」语义已无必要。
- **清理整曲解码旧路径**:删除 `streamEngine` 的整包解码分支与 `decodeToF32` 引用;整包 `GroupAudio.pcm` 仅保留给 announce(TTS 播报)与测试注入源(`GroupPump` 整包 `pushLoop` 机制不变)。
- **可观测**:起播时新增 `[window] 上限=Xs 整曲保留=bool 歌长=Xs` 日志,便于确认配置已生效。
- **文档/注释订正**:清除 `docs/sendspin-权威方案文档.md` §5.1、`docs/DEVELOPER.md`、插件配置项 help 文案中残留的「`SENDSPIN_STREAM_SOURCE` / 流式解码开关」过期表述。
- **测试**:新增 `tests/sendspin/streamWindow.test.ts`(5 例:整曲保留不淘汰、超窗滑动与背压、超窗 seek 重定位等);`pumpFallback.test.ts` 改为起真 HTTP 源(不再依赖 `SENDSPIN_STREAM_SOURCE=0`);sendspin 全量 100 文件 / 1013 例全绿,`tsc --noEmit` 0。
- **缺省值与文案**:解码窗口上限缺省 **30 秒**(最省内存档,≈11MB/组);「解码窗口上限/设备缓冲深度/默认音频编码」下拉文案去掉「推荐/最抗卡顿」类修饰,统一以「默认」标注缺省档。

## [4.2.0] - 2026-10-08

### 播放抗网络波动 + 群组卡死根治

- **整曲内存缓冲**:网络源(WEBDAV + 插件源)起播即整曲取进内存(瞬时错误 2 次退避 / 10s 停摆硬顶 / 18s 单次硬顶 / 100MB 单曲 / 300MB 全局预算),经 `/rest/membuf` 回环供流——起播后上游断网不影响本首播放,240 真机断网实测通过。
- **取流失败自动重试窗**:新流取流失败不再快速失败,挂起请求自动重试(前 1 分钟每 10 秒 → 之后每 60 秒,总窗口 30 分钟);窗口内源恢复即自动出流,期间不发僵尸响应。
- **僵尸流根治**:出流管道启动裁决(首字节 / 带错退出 / 15s 超时,不再发 0 字节假 200)+ 按退出码收口(中途夭折对客户端显式断开,不再被误读为整曲播完);DLNA 直通链路加 10s 停摆守卫与 15s 建连超时。
- **失败语义分层**:已缓冲整曲与上游死活无关;瞬时失败挂起重试;停摆 / 死链(404 等)立即显式失败,队列自动跳下一首;过大 / 超预算回退直通。
- **群组假在播根源修复**:推流中途死亡(源断 / 编码器死亡)后组状态不再残留——轮询恢复真实 IDLE,队列自动推进,不再出现「进度不动也永不切歌」的永久卡死。
- **整曲内存缓冲主动回收**:整曲缓存新增消费后空闲 120 秒即回收 + 每 60 秒周期清扫(旧机制仅有 10 分钟 TTL 与容量上限的惰性驱逐),连续读取自动续期不误删,播放结束后内存及时归还。
- **测试契约对齐**:同步修正 3 个受根源修复影响的旧契约用例(异常终止状态口径、假在播签名判定),新增「假在播 → 重投自愈」集成守卫(场景3e)。

## [4.1.0] - 2026-10-07

### 性能优化:发现页与库页查询提速 + 推荐缓存永热

- **数据库索引 + 查询下推(rest/index.ts + db/index.ts)**:新增 4 个幂等索引(albums.year / albums.genre / albums.play_count / album_artists.artist);getAlbumList2 全类型排序/过滤/分页下推 SQL——random 改「id 列取样回表」(整行大列不再进排序堆),newest/recent/frequent/highest/byGenre/byYear/starred 逐项语义核对后下推,alphabeticalByName/ByArtist 保留 JS 路径(localeCompare 区域序不可下推);getRandomSongs 同步改 id 取样且无过滤时免 join;getArtists/getIndexes 投影瘦身(bio 等大文本列不再捞回)。合成库(6 万专辑/13 万歌)实测:random 232ms→10.8ms、newest 288ms→3.3ms、byYear/frequent/byGenre/starred 208-221ms→3.0-3.6ms、getRandomSongs 64ms→16.4ms、getArtists 113ms→72ms、getIndexes 101ms→58ms,EXPLAIN QUERY PLAN 全部命中索引。

- **推荐缓存 stale-while-revalidate(api/recommend.ts)**:/v1/recommend 与可缓存 provider 的 /v1/local-recommend 改为「有缓存立即返回(不论新旧),过期触发后台刷新(single-flight 去重),插件聚合失败保留 last-good 不覆盖旧缓存,无缓存才阻塞拉取」;新增周期预热(递归 setTimeout,TTL/2,unref,冷启动不外呼)。用户侧效果:首页插件推荐从「5 分钟过期后下一次 900ms+ 阻塞」变为永远秒回。

- **回归守卫**:新增 recommendSwr(4 例)/ddlIdempotent(2 例)/restPagingRegression(7 例);recommendRoutesContract 1 例按 SWR 新契约订正。全量 432 文件 / 5685 例全绿,tsc --noEmit 干净。
## [4.0.88] - 2026-10-07

### Sendspin 修复:FLAC 编码器死亡自愈,杜绝「中途无声、进度照走、切歌恢复」

- **根因(240 生产实证,2026-10-07)**:群组播放的 FLAC 编码器(libflacjs asm.js)在曲中 `process_interleaved` 返回 false 后,旧实现只 warn 一条「编码器疑似失效」然后**静默放空**;`pushLoop` 的时间线降级推进照常推游标 ⇒ 设备收到合法长度但全零的静音帧 —— **进度条照走、没有声音、切歌(新建编码器)才恢复**。24h 内 3 个爆发窗口共 3.2 万行日志(`@frame=0` 连新编码器首帧都失败=asm 堆楔死 14447 次 / `@frame=638`≈54.5s 处崩 15332 次 / `@frame=2565` 2999 次),与用户听到的无声时段逐帧吻合。孤立复现(12 首×300s 连续编码)跑不挂,触发需生产长寿命进程,故修复设计为**不依赖触发原因的分层自愈**。

- **分层自愈(encoding.ts)**:`process_interleaved` 失败 → ①**原地重建**(删旧实例+重置元数据+重开流)→ **重编同一批**,成功则调用方无感、无缝续流;②重建失败(堆楔死形态)→ **bust require 缓存重载 libflacjs**(全新 asm 堆)再试;③仍失败 → 置 `unhealthy` + 5s 退避放空,不再每帧无谓重建。曲末 `flush()` 的重建统一走同一自愈路径。

- **降级上限兜底(streamEngine.ts)**:`pushLoop` 持续零产出的降级推进加 `MAX_SILENT_DEGRADE` 上限(默认 5s,env `SENDSPIN_MAX_SILENT_DEGRADE_MS` 可覆盖)——超限即**提前按自然播完收场、自动切下一首**。最坏情况从「整首默剧」收敛为「最多约 5 秒无声后自动恢复」,任何编码器死亡都不再可能把整首歌唱成默剧。

- **回归守卫**:新增 `encodingHeal.test.ts`(自愈契约 3 例:重建成功无缝续流 / 模块级重载后恢复 / 持续失败退避)与 `pumpEncoderDeath.test.ts`(降级超限提前收场 1 例);tsc 0 错误,sendspin 子集 50 文件 / 300 用例全绿。
## [4.0.87] - 2026-10-05

### Sendspin sink 自愈:远程重启默认开 + 两道防叠加闸

- **L2 远程重启默认开启(`sinkAutoRestart` 缺省即 true)**:设备侧(`sendspin-cpp`) 2026-10-05 起自带自愈 —— `sendspin.player: Failed to send audio chunk` 1 分钟内 累计到阈值就本地 `App.restart()`(esp32-player2 已实装并实测生效)。本地重启是**唯一能清 `pending_start_` 一锤子锁**的手段,设备自己已经会按 ⇒ 服务端再按一次就是**叠加重启**(刚起回来又被按死)。故本版把默认从「保守关」翻成「默认开」,同时在下发前挂两道前置闸。想退回保守模式:把 `sendspin-renderer` 的`sink_auto_restart` 显式设 false。

- **L2 闸1:本 conn 已断 ⇒ 绝不重复按**:`ws close` → 心跳约 20s 摘牌,此时设备多半已经自己重启过了;对着已断的旧连接再发一次重启就是叠加(刚起回来又被按死)。命中则把 `sinkRecoveryLevel` 钉到 3(不再每 60s 刷同一条告警),等重连后重新评估。判定用 `c.ready === false`:握手前 / 无定义的替身按「还活着」放行,不影响正常路径(真断链时 `readyState` 必为 CLOSED)。

- **L2 闸2:同 host 在 10min 冷却窗内已下发过 ⇒ 换新 conn 也不再按**:设备重连产生的是**新 conn**(`sinkRecoveryLevel` / `sinkLastRecoveryAt` 全是初值),冷却若只记在conn 上会丢 ⇒ 新增 server 层 `lastRestartSentAt: Map<host, ts>` 按 host 记,跨 conn生效。命中时日志会打出剩余冷却秒数。

- **远程重启是「通用」的,不依赖具体按钮名**(承接 4.0.86 的 `esphomeBridge.restartButtonId` 两级匹配):① `object_id` 以 `restart` 结尾且非 safe-mode 变体 → 规范命中,**必须排在兜底之前**(safe-mode 按钮在实体表里常排在真重启前面);② 兜底:`name`/`object_id` 含 `restart` 就按下,并显式 warn「实体命名不规范,按下的是猜测结果」;③ 都没有 → 返回 `{ ok:false, code:"no-entity" }`,只记 warn**不抛**。**换设备不会因命名不一致而失效**,只要设备暴露了 `button: - platform: restart` 且 6053 已连上。

- **回归守卫**:`sinkHealth.test.ts` ④ 段 1 例 → 5 例(显式关 / 默认开真按 / 闸1 断链不按 / 闸2 冷却窗内不按 / 冷却窗过完允许再按)共 26 passed,并钉住 `lastRestartSentAt`常量。`tsc --noEmit` 0 错误,sendspin 子集 97 文件 1061 passed + 1 expected fail。

### Sendspin 音量:统一「直控设备音量」,组音量缺省收到 20

- **事故修复 —— 设备重连后音量突然非常大(2026-10-05 实测复现)**:根因是**两套互不相干的组对象 + 组音量缺省 100**。用户在滑块里写的是按 host 取到的组(`group("C4:9E:…")`,落到 `sendspin_device_state`),而设备上线自动回组的是按 `ug:` 前缀建的**另一个**内存组;新组 `volume` 缺省 100,重连 `add()` 时 `syncVolumeTo` 把满音量刷进**设备输出级**,再叠上设备自身的硬件音量 ⇒ 听感暴涨数倍。(240 取证:`sendspin_device_state` 里 `C4:9E:7E:08:75:64` volume 38 / `3C:0F:02:F9:69:E4` volume 100。)

- **组音量出厂缺省 100 → `DEFAULT_SENDSPIN_VOLUME = 20`**(新增常量,位于 `deviceState.ts`):缺省值本身就是「刚起回来的设备被灌满」的元凶,直接压到安全侧;用户真正设过的值由下面第 4 条从持久库播种回真值。回归守卫:`peerVolume.test.ts` 钉住 `DEFAULT_SENDSPIN_VOLUME < 50`。

- **统一直控设备输出级,服务端不再持有独立音量(不乘算)**:`offloadsVolume()` 恒 `true`、`appliedGain()` 恒 100(unity) —— **不管什么设备(宣告音量与否)、不管是群组还是独立播放器,一律把音量以 `server/command` 直接作用到设备输出级**,采样恒满幅、不烘任何服务端音量。不再保留「按设备能力回退烘 PCM」的分支:两个音量(服务端 × 设备)相乘以及两者各自生效,都是同一个物理旋钮的两次表达,相乘只会互相打架。代价(用户已确认接受):极老固件若完全不吃 `server/command`,其音量将失去作用面 —— 这是「一律直控」的必要代价,不是遗漏。

- **`deviceVolume()` 原样直通、零乘算**(去掉 `× c.volume` 的乘法):组音量多少就下发给设备多少。**群组和独立播放器同口径** —— 都是直接控制设备音量,不再存在「服务端音量 × 设备音量」或「播放器音量 × 设备音量」这类相乘。

- **`seedVolumeFromDevice()`:组对象 `add()` 时按设备持久音量(`sendspin_device_state`)播种一次(`volumeSeeded` 标记)**:修掉上面那两套组对象的歧义 —— 用户滑块设过的值在设备重连后会被播种回来,而不是每次掉回缺省值 20。

- **同一常量收口所有缺省出口**:`sendspin/playerCore.ts` 服务未跑时的内存假组、`sendspin/proxy.ts` 组缺席时的占位视图、`sendspin/peerVolume.ts` 离线回退(顺手清掉残留的 `?? 100` 字面量) 全部换用 `DEFAULT_SENDSPIN_VOLUME`。
- **「缺省」出口全量收口,不留后门**:除上面几处,还清掉了 `deviceState.ts` 里 4 处 upsert 缺省 (`cur?.volume ?? 100` —— 设备从没存过音量时会被写成 100)、以及 `group.ts` 的 `SendspinGroup.volume = 100`。**凡是「不知道就先给」的出口一律 20,不允许再出现满音量缺省**,否则从另一扇门又会回到本次事故。同步更新 `deviceState.test.ts` / `group.test.ts` 的缺省断言与 import。


- **回归守卫**:`serverCore.test.ts` 该用例改为「组音量 42 原样直通(不乘算、不烘 PCM)」;`proxyFront.test.ts` 拆成两条 —— 镜像里**已存在**的组原样透传、`ghost` 缺席时才返回缺省常量;`peerVolume.test.ts` / `playerCoreUnits.test.ts` 的缺省断言全部改常量(后者补上 import)。`tsc --noEmit` 0 错误。

## [4.0.86] - 2026-10-05

### Sendspin 群组「播放中途突然无声」整改(设备侧固件不可改,服务端开环兜底)

- **根因(240 取证坐实)**:sendspin-cpp `pending_start_` 一锤子锁 —— 只在 `sendspin_media_source.cpp:77`(紧邻 `:78 set_state_(PLAYING)`)清零,`:87` / `:175-180` / `:184-187` 都不复位。锁上之后重发 `stream/start` 会被 `if(!pending_start_)` 去重吞掉,设备再也回不到 IDLE;协议内软手段(重发 start / clear / server+activate / 切歌)全部无效,只剩掉电。判活只看 `State changed to PLAYING` —— `Stream Started` 出自网络线程,健康与故障都打,无判别力。
- **新增 sink 开环检测**:唯一可观测信号是 `ws.bufferedAmount`(健康 0~13KB 突发,故障稳定 58585B 平台)。连续 3 窗(≈30s)峰值 > 32KB 判 `stalled`;回落到 < 16KB 清窗重计;建连 10s 宽限、起播预填充窗口豁免、60s 硬回退(设备不取数时 pump 恒停在 fill,不设硬回退就永远 arm 不上检测)。
- **分级自愈(全程不改播放状态:不 pause / 不报 stopped / 不踢出群组)**:判出来 → L0 仅 WARN;满 60s → L1 发 `stream/end` 探针(协议里唯一能让设备回 IDLE 的消息,且不发 `group/update(stopped)`,免得把「无声」伪造成「正常停止」);再满 5min → L2 远程重启。
- **L2 自动重启默认关**:`bufferedAmount` 只是推断,服务端尚订阅不到设备日志流,拿不到设备侧事实;假阳(把正在正常播放的机器按重启)与漏判(继续无声)代价不对称。开关位 `sendspin-renderer.sink_auto_restart`(缺省 false,改插件配置后重启服务生效),关着时降级为 WARN + 设备列表暴露 `streamHealth`,手动路由 `POST /v1/sendspin/devices/:clientId/esphome/restart` 仍可真实按下。
- **修掉自愈阶梯的死代码**:`sampleSinkHealth` 原先在「已 stalled」时直接 return,导致 `escalateSinkRecovery` 全程只被调过一次,L1 / L2 永远发不出去。改为按「已 stall 多久」驱动(按当前所处级别取等待量),设备排空恢复时阶梯归零、下次故障从 L0 重新走;L2 下发后阶梯归零并前推 10min 冷却,设备回来前绝不再按第二遍。
- **设备列表暴露健康态**:`GET /v1/sendspin/clients` 在线行新增 `streamHealth`(`ok` / `degraded` / `stalled`)。
- **esphomeBridge 重启实体挑选**:只认 `object_id` 以 `restart` 结尾且排除 safe-mode 变体,命名不规范时按名字兜底并记 warn;拿不到实体 / 桥未连 / 发送失败一律返回 `ok:false` 不抛。
- **切歌收尾不再误报停止**:`finishPlayback` 增加 `silentState` 选项,置位时只做流级收尾、不广播 `group/update(stopped)`(自愈探针专用)。
- **回归守卫**:`sinkHealth.test.ts` 22 例(三窗计数 / 清窗 / 三档豁免 / 反例:阶梯靠时间推进 / L2 默认关与开启两条路径 / 闸门 / 实体挑选 / 健康聚合 / 阈值常量守卫 / 重启真实成功路径);阈值与节奏常量改为从实现 import,改坏即对应用例转红。

## [4.0.85] - 2026-10-04

### 性能（Web 首页打开慢：240 真机冷态 14.3s → 1.0s、热态 2.0s → 0.47s）

- **根因定位（240 容器内耗时分解实测）**：`/v1/local-recommend` 是首页 5 个数据源里唯一
  「零缓存」且逐歌单做封面 N+1 查询的链路。真瓶颈不是日志里那 5 个榜单外置插件（合计仅
  60~200ms），而是**内置 `local-random-recommend`**（695/857/190ms，占 62~77%）；且封面解析
  对 240 个歌单额外发起 240 次 drizzle 全行查询（主 SQL 已 `SELECT cover_art`，却又逐条调
  `getPlaylistCover()`）。
- **P0-1 provider 遍历并发化**：`backend/src/routes/api/recommend.ts` 的 `local-recommend`
  由串行 `for` 改 `Promise.all`，每个 provider 独立 try/catch，单个失败不影响其余。
- **P0-2 封面解析去 N+1**：`backend/src/services/plugin/localPlatformRecommend.ts` 直接用主
  SQL 已取回的 `r.cover_art` 做「扩展名合法 + `resolveCoverFile` 存在」判定，与
  `getPlaylistCover()` 的判定逐字等价，省掉 240 次多余查询。
- **P0-3 候选池缓存（保留随机语义）**：新增 `platformPoolCache` + `PLATFORM_POOL_TTL_MS=120s`
  + `invalidatePlatformPool()`。TTL 内只固定候选集合与封面解析结果，**每次请求仍然 shuffle**，
  「每次刷新都不一样」的体验不变。
- **P1-1 provider 结果缓存（插件自治，核心不写死插件名）**：核心读插件 manifest 的
  `recommendCacheTtlSeconds`（>0 才缓存，key=pluginId）；`backend/src/plugins/types.ts` 新增
  该可选字段。5 个榜单插件声明 120s（配套插件同步发版，见下）。
- **P1-2 新增轻量宿主 API `host.playlists.getMeta(id)`**：只返回 `playlists` 行，不再跨
  QuickJS/WASM VM 编组整张歌单 entries；权限沿用 `playlists:write`。同步注册 `sandbox.ts`
  进程内表面与 `sandboxWorker.ts` worker 桥。
- **P1-3 前端首页请求解耦**：`frontend/src/views/Home/index.vue` 的 `onMounted` 拆成
  「快路径先就绪、慢路径后到」。注：`loading` ref 当前未被模板消费，故此项为纯结构性解耦，
  视觉收益为 0（如实记录）。

### 修复（沙箱宿主句柄泄漏 + ffmpeg 出流永不回收，均 240 定量证实）

- **沙箱宿主异步句柄泄漏**：`backend/src/plugins/sandbox.ts` 的
  `deferred.resolve(jsToHandle(value))` 中 **`resolve` 不消费传入 handle**，调用方必须自行
  dispose；旧代码三处（并发拒绝分支 / 成功分支 / 错误路径）均未 dispose → QuickJS 引用计数
  不归零 → 堆单调增长（+1454 B/call），teardown 命中
  `Assertion failed: list_empty(&rt->gc_obj_list), at quickjs.c:2036, JS_FreeRuntime`。
  修法：先取句柄 → `resolve` → 在 `!skipHostResultDispose()` 时 `safeDispose`。
  240 实测：60 轮真实 provider 调用后 `external` 21.5→21.5MB（+0）、QuickJS `obj_count`
  4282→4282（+0），两条曲线完全拉平。新增**仅测试用**只读开关
  `SANDBOX_LEAK_HOST_RESULT=1`（默认关，生产恒释放），供回归用例复现泄漏面。
- **ffmpeg DLNA 出流看门狗**：`backend/src/routes/rest/index.ts` 的 `serveFfmpegPipe` 原回收
  仅依赖 `c.req.raw.signal` abort / child exit+error / `stdout.on("close")`；渲染端 socket
  半开时三者都不触发 → 转码进程永久驻留（240 实测 7 个进程存活 3.5–15.2h，回环 TCP 仍
  ESTABLISHED、服务端 tx_queue 堆到 2.5–4MB 而 rx_queue=0）。修法：① `registerFfmpegPipe`
  登记 / exit+error 注销；② `stdout.on("data")` 刷新 `lastDataAt`；③ 周期对账器（`setInterval`
  30s、`.unref()`、幂等）：连续 **90s** 无 stdout 字节 或 存活超硬性 **6h** → SIGKILL + 注销；
  ④ `killOnCancel()` 包响应流，cancel 时立即 `child.kill()`。`backend/src/index.ts` 在
  `startOrphanPruner()` 后启动对账器（不做启动期对账，避免重启瞬间误杀）。
- **显式失效点补齐**：`services/plugin/playlistSync.ts` 与
  `services/source/online/recommendImport.ts` 在 `clearPlaylistCoverCache` 后补调
  `invalidatePlatformPool()`；其余写点靠 120s TTL 自然收敛。注册点放在
  `routes/api/shared.ts`（在模块顶层自注册会触发模块环 TDZ：
  `Cannot access 'cleaners' before initialization`）。

### 测试

- 新增 `backend/tests/plugins/sandboxHostDispose.test.ts`(139)、
  `backend/tests/rest/ffmpegWatchdog.test.ts`(84)、
  `backend/tests/services/localPlatformRecommend.test.ts`(70)，并扩充
  `backend/tests/routes/recommendRoutesContract.test.ts`。
- QA 独立回归守卫 `backend/tests/qa_perf/`（4 文件 580 行）：封面等价性（逐字比对新判定 vs 旧
  `getPlaylistCover`）、随机性守卫（TTL 内仍重洗）、provider 缓存语义、ffmpeg 看门狗边界。
  3 处变异均让守卫变红（有判别力）。
- 240 真机实测（热替换 dist）：串行冷态 **14297.7 → 1044.7ms（−93%）**、
  串行热态 1996.9 → 471.4ms（−76%）、并行热态 797.2 → 250.4ms（−69%）；
  真实 HTTP 热态下限约 133ms。

### 配套插件（MusicFlow-plugins 同步发版）

- 5 个榜单插件（apple-music / huawei-chart / kugou-chart / netease-chart / qq-chart）声明
  `recommendCacheTtlSeconds: 120`。
- 6 处 `host.playlists.get(` 改 `host.playlists.getMeta(`，并做**兼容降级**
  （`host.playlists.getMeta || host.playlists.get`）——不抬高 `minAppVersion`，
  保证旧核心上不因 `getMeta` 缺失而静默丢失该平台榜单分区。
- 版本：apple-music 1.0.4→**1.0.5**、huawei-chart 1.2.0→**1.2.1**、
  kugou-chart 1.7.0→**1.7.1**、netease-chart 1.7.0→**1.7.1**、qq-chart 1.7.0→**1.7.1**
  （由插件仓 CI push master 自动打 tag + Release）。

## [4.0.84] - 2026-10-04

### 修复

- **纯 stream 插件跨插件兜底在架构上不可用(240 生产容器真机实锤)**:宿主沙箱
  `backend/src/plugins/sandbox.ts` 的 `CAP_METHODS` 把 `stream` 能力只映射到
  `["streamUrl"]`,于是插件即便实现了 `resolveStream`,核心拿到的 impl 门面里也永远
  没有它 —— `streamFallback.ts` 的 `typeof provider.resolveStream !== "function"`
  恒真,「本尊重搜+全平台全败后,逐个问纯 stream 插件按平台原生 ID 要直链」这条链**从来
  没有真正跑起来过**(4.0.82 引入、4.0.83 修掉前半段的提前 return,但都被这一层挡住)。
  240 实测证据:停掉 `music-dl` 容器后本尊(gmd)搜索全败、`lx-source` v1.1.1 已加载且
  `enabled=1`、容器内 dist 已含 `searchFailed` 补丁,`findFallbackStream` 仍返回 `null`
  且 playability 落 `unplayable`;容器内直查插件实现确认 `impl` 只有
  `streamUrl/test/health`,`resolveStream` 被白名单挡在门面之外。
- 修法:`stream: ["streamUrl", "resolveStream"]`。`makeImpl` 只在插件**实际实现**该方法
  时才暴露,故未实现 `resolveStream` 的 stream 插件行为完全不变(不误加门面)。

### 测试

- `backend/tests/plugins/discoveryHost.test.ts` 新增 K 段 2 例:① 声明 `stream` 且实现了
  `resolveStream` 的插件,`impl` 必须暴露该方法且能返回直链;② 未实现的插件,`impl` 不得
  凭空多出该方法(反向守卫)。
- 双向变异已验证:把白名单改回 `["streamUrl"]` → ① 立刻变红(`1 failed | 103 passed`),
  还原 → `104 passed` 全绿。

## [4.0.83] - 2026-10-04

### 修复
- **本尊「搜索请求抛错」时提前 return,纯 stream 插件兜底被整段跳过(gmd 一挂就彻底没链)**
  - 现象:240 生产容器真机复验(`docker stop music-dl` 逼本尊全平台失败)——库里的 gmd 歌曲一首都换不出链,洛雪(lx-source v1.1.1)压根没被调用到。
  - 根因:`findFallbackStream` 里本尊重搜的 `provider.search()` 抛异常(上游 down / 网络异常)时,catch 分支按「网络异常不判死,只短期退避」的语义直接 `setFallback(..., {transient:true}); return null` —— 这条 return 排在**纯 stream 插件轮询之前**,于是本尊一崩,洛雪按歌曲 `sourceData` 里的平台原生 ID 直查直链的机会就没了。
  - 为何单测没抓到:既有用例构造的是「搜索成功但空结果 / 候选被导入门禁过滤」,从不构造「本尊 search 本身抛错」;而真机 gmd 停服走的恰恰是抛错分支。
  - 修法:catch 改为只置 `searchFailed` 标记并走 `results = []`,继续走原有候选循环与纯 stream 插件轮询;全无果时末尾统一 `setFallback(songId, null, { transient: sawTransient || searchFailed })`,与原「短期退避不判死」语义完全一致。
  - 真机复核:240 v4.0.83 + lx-source v1.1.1,停掉 gmd 后按库内网易云 ID 直查,直链 host 由 `192.168.10.240:18180` 切到 `m701.music.126.net`,`HTTP 206 audio/mpeg` 可播。

### 测试
- 新增 `tests/services/streamFallbackSearchThrow.test.ts` 2 例:①本尊 search 抛错 → 纯 stream 插件仍按 sourceData 直查并换链成功;②无链时返回 null 但按 transient 退避(不判死)。双向变异(还原旧 `return`)→ 1 failed,还原 → 2 passed。

## [4.0.82] - 2026-10-04

### 新增

- **取链兜底新增「纯 stream 插件跨插件轮询」**:核心换源兜底(`findFallbackStream`)在本尊重搜 + 平台轮换全部失败后,逐个尝试只声明 `stream`、不含 `search` 能力的启用源插件 —— 调其新契约 `resolveStream(config, song)`(按歌曲 `sourceData` 里的平台原生 ID 直查直链,如 lx-source 走洛雪源脚本 musicUrl 多源轮切),探活(206/200 且音频)才换链。kuwo / netease 平台实测真可播;qq / kugou / migu 上游失效时按既有失败语义退避,行为不变。
- **配套**:lx-source 插件收窄为纯取链插件(v1.1.1,capabilities 只留 `stream`),`musicInfo` 按洛雪规范携带 `source` 平台键;搜索/歌单/推荐/歌词/封面等洛雪协议不支持或实测恒空的能力全部移除,搜索兜底候选链不再因洛雪空结果白等。

### 不变量

- 本尊(gmd 等)重搜 + 平台轮换逻辑零改动;纯 stream 轮询只在其全部失败后追加,无纯 stream 插件或全部失败时负缓存/退避语义与原版完全一致。

## [4.0.79] - 2026-10-03

### 功能
- **自动匹配链路接入跨插件兜底（歌单导入 / 播放补齐）**
  - 现象:上次 [4.0.78] 只把兜底做在了 `/api` 搜索路由上,歌单导入与补齐播放这类「自动匹配」链路还是「一个 matcher 一把梭」——`shared.ts` 只用 `firstEnabledByCapability("search")` 取第一个启用的搜索插件,首选空结果或抛错时其它插件不再补位,所以实际观感是「还是只有 go-music-dl 在匹配」。
  - 根因:导入链路上没有候选概念,`matchUnmatchedPlaylistEntries()` 是单 provider 搜索+打分,内部不存在换源;加上插件侧没人声明 `autoMatch` 能力,能力驱动的挑选永远落到 search 分支,只能选出一个。
  - 修法:`services/plugin/shared.ts` 新增 `buildMatchCandidates()`,按 `core-search-fallback` 的配置把首选插件之外其它「已启用 + 有 search 方法」的插件拼成候选链(排除本尊,受 maxCandidates 约束),`matchPlaylistInBackground` 把它作为可选参数传给 `matchUnmatchedPlaylistEntries()`;三处调用点(`matchToOnlineSong` / `matchUnmatchedPlaylistEntries` / `crossVerifySongs`)签名向后兼容。
  - 匹配层:`match.ts` 新增 `searchBestMatchWithFallback()`——首候选即主挑选器,未命中再按 `fallbackOnEmpty` / `fallbackOnError` 决定是否换下一个候选;`enabled` 总开关 + `budgetMs` 双闸门,候选抛错原地收敛为 error 不外冒,全耗尽时 message 带回完整「插件A(空结果) → 插件B(超时)」轨迹,便于在插件页直接看出走了哪条路。

### 修复
- **批内缓存 key 未区分插件,兜底候选会被首选的 no-match 短路**
  - 现象:首选插件返回 no-match 后换到第二个插件,第二个插件的查询会命中间批缓存里同一 (标题, 歌手) 的 no-match,直接复用旧结论、根本不发起搜索——兜底等于白配。
  - 修法:缓存 key 由 `title|artist` 改为 `providerId|title|artist`,各插件缓存彼此隔离;同步更新 `onlineMatch.test.ts` 中 4 条缓存键断言。

### 不变量
- **单插件部署行为完全等价**:候选数只有 1 时 `searchBestMatchWithFallback()` 直接走原 `searchBestMatch()`,不引入任何开关判断、不吃兜底预算。
- 配套测试 `tests/matchFallback.test.ts` 14 例(单候选等价 / 首候选命中不发第二请求 / 空→换源 / 错→换源 / 全耗尽轨迹 / 开关与预算闸门 / maxCandidates 上限 / 缓存与兜底交互);兜底逻辑经 5 项双向变异(改一行→断言必红→还原→绿)验证。

## [4.0.81] - 2026-10-03

### 修复
- **检索型插件(无 streamUrl)走 /search 路由必 502,兜底捞回的结果也被映射行炸掉**
  - 现象:240 真机 `POST /rest/api/v1/online/apple-music/search` 稳定 502 `{code:UPSTREAM_ERROR}`,日志 `[ONLINE] search 失败: configured.provider.streamUrl is not a function`。v4.0.80 曾把根因归为「兜底预算被首选吃掉」——那修的是 match.ts 自动匹配链路里真实存在的预算缺陷,但不是这条 502 的因;真因这次靠 240 日志钉死。
  - 根因:search 路由对每首歌调 `configured.provider.streamUrl(...)` 做直链预取,有两个错:① 用的是 **URL 里的主插件**而不是 `fallbackFrom` 指向的**实际产出结果的插件**(兜底捞回时两者不同家,取错源);② 假设所有 search 插件都声明了 streamUrl —— 检索型插件(如 apple-music,manifest 描述明说「Apple 无全曲直链」)没有该方法,映射行 TypeError 被路由 catch 整体 502,连兜底成功的结果也一起炸掉。
  - 修法:改用 `fromConfigured`(= fallbackFrom 插件;主插件自答时即 configured)取 streamUrl,并按 `service.ts` 导入落库处的同一防御口径加 `typeof === "function"` 守卫 —— 未声明就留空串,播放层走核心换源兜底;搜索结果绝不该因映射行崩掉。

## [4.0.80] - 2026-10-03

### 功能
- **「手动补链」(match-track) 也接上跨插件兜底候选链**
  - 现象:`POST /v1/online/:providerId/match-track` 调 `matchToOnlineSong()` 只传了原有 5 个参数,漏掉第 6 个 `candidates` —— 候选链机制本身已存在,但手动补链永远只跑 URL 里那个 provider,空/错即失败,没有任何第二道防线。
  - 修法:路由里先调 `buildMatchCandidates(providerId, config, provider)` 拼出「首选 + 其它已启用搜索插件」的候选链作第 6 参传入;候选数 > 1 时打一条 `[ONLINE] match-track: <entryId> 匹配候选链 a -> b -> c` 日志,排障时能看清它到底试了谁。
  - 边界:`buildMatchCandidates` 自身排除本尊(不把自己列进兜底)、受 `core-search-fallback` 的 `enabled` 与 `maxCandidates` 约束(默认 2 → 只补 1 个兜底),因此默认行为是「用户显式选的 provider 失败 → 再试一个已启用插件」,与自动匹配链路同一套开关、同一份配置。

### 修复
- **首选源慢/超时时跨插件兜底静默失效,直接回 502**
  - 现象:`POST /rest/api/v1/online/:providerId/search` 走 `searchBestMatchWithFallback()`。真机 240 实测:`providerId=lx-source` + `q=稻香` 正常(兜底轨迹 `["lx-source(空结果)"]`,由 go-music-dl 捞回);而 `providerId=apple-music` + `q=稻香` 直接 HTTP 502 `{code: UPSTREAM_ERROR}`,响应里的 `fallbackFrom` 与 `trace` 都是空的——兜底一次都没跑。日志同窗口出现 `[PLUGIN:apple-music] 调用 search() 执行超时(> 20000ms),已中断`。
  - 根因:`match.ts` 里 `startedAt` 在函数入口取表、预算 `remain() = budgetMs - (now - startedAt)` 从进函数那一刻就开始计;而首候选走的是「不吃预算」的原路径(慢源超时本该由插件自己管)。apple-music 这一跳光搜索就吃了 20s+,兜底总预算 `budgetMs=6000` 在兜底请求发出**之前**就被扣成 0 → 循环里的 `remain() <= 0` 先于任何兜底请求生效 → 兜底整段被跳过,trace 为空、路由直接 502。代码注释写着「首候选不吃兜底预算」,实现却是「从进函数开始计时」,自相矛盾。
  - 修法:预算改为**只在兜底阶段计量**——`fallbackAt` 在首候选跑完之后(i>0 首次进入循环体)才起算,首选耗时完全不计入兜底预算;每个兜底候选各自拿满一个 `budgetMs`(从该候选自己的起点计时),即 `withinBudget(attempt(c), cfg.budgetMs)`。整体仍有界:≤ `maxCandidates × budgetMs`。顺带把预算超时收敛成本跳失败(原先 withinBudget 的这个外层拒绝会直接冒给调用方,兜底一超时就变成 502,而不是「这一跳失败、换下一跳」)。
  - 配置口径同步:`core-search-fallback` 的 `budgetMs` 文案由「兜底总预算(毫秒)」改为「兜底预算(毫秒)」——逐个候选计量的时间上限,不再是整条链的总时长上限(范围 500-60000、默认 6000、超时即停手、已发出的尝试不中断),中英文 help 与插件文档同步改。

### 不变量
- **单候选部署零行为变化**:候选只有 1 条时仍直接走 `searchBestMatch()`,不取表、不吃预算、不套任何闸门。
- **开关关闭零行为变化**:`enabled` / `fallbackOnEmpty` / `fallbackOnError` 仍在发请求**之前**判定,关掉即就地停手,与改动前一致。
- **闸门顺序与轨迹格式不变**:总开关 → 预算耗尽 → `canContinueAfter` 三道闸门都先于请求发出;trace 仍是 `插件A(空结果)` 形式,全耗尽时 message 追加 ` + (兜底轨迹: …)`;`withinBudget` / `summarizeError` / `canContinueAfter` / `isUsableMatch` / `failSegment` 本身零改动。
- **配套测试**:`tests/matchFallback.test.ts` 原「首选吃光预算→不碰第二」那条改为「首选慢不吃兜底预算→第二候选仍被触达并命中」,并新增「兜底候选自身超预算→该跳记轨迹、不碰第三」;15 例全绿(另 `matchCandidates` 10 例、`onlineMatch` 46 例),`tsc --noEmit` 0 错。改一行→对应断言必红→还原→绿,3 项双向变异(`fallbackAt` 起点 / 每候选预算 / 超时收敛)专项验证。

## [4.0.78] - 2026-10-03

### 功能
- **搜索层跨插件兜底（core-search-fallback）**
  - 现象:`POST /rest/api/v1/online/:providerId/search` 中任一源插件搜索返回空或抛错时，结果就只有这一个插件，没有第二道防线（既有换源兜底只在取链/播放层，搜索层没有跨插件遍历）。
  - 根因:`online.ts` 直接调用 `configured.provider.search` 一次即返回，`services/source/online/service.ts` 只负责把结果入库，不具备兜底能力。
  - 修法:新增内置行为插件 `core-search-fallback`(config-only) 与`runSearchWithFallback()` —— 主插件先试，空/错按配置自动改用其它「已启用 + search&stream 齐备」的源插件(上限 maxCandidates=2、总预算 6000ms)，命中结果回传 `fallbackFrom`，全部耗尽回传 `{empty,message,trace}`。
  - 契约:新增 `upstreamError` 三态 —— 主命中/兜底命中为空串;主插件抛错且兜底没捞回时非空(路由回 502，走业务码、不透传上游原文);主插件真无结果且兜底耗尽仍 200 + message(不是错误)。
  - 配置:`core-search-fallback` 提供 enabled / maxCandidates / budgetMs /fallbackOnEmpty / fallbackOnError 五项，默认全部开启，可在插件页关掉。

### 重构
- **通用兜底 runner 抽成核心可复用能力**
  - `services/plugin/shared.ts` 新增与业务无关的 `runSourceFallback<T>()`：逐候选尝试、首个 usable 即返回、双闸门(总预算 + 最多试几个)、候选抛错只记 trace 不向上抛、回传完整轨迹，供后续任何插件/核心链路复用。
  - 插件侧契约收敛:`plugins/types.ts` 新增 `PluginSoftEmptyResult`(`{empty,message,trace,songs,source}`) 显式类型；`plugins/sandbox.ts` 新增`sandbox_makeEmptyResult()` 并经 `host.fallback.makeEmptyResult` 注入沙箱，任何插件都能产出同构的软失败+轨迹，不必各写一份。
  - 配套:`streamFallback.ts` 保持零改动 —— 其带负缓存/TTL/三态 probe 的既有语义不并入通用 runner(正确性优先，重复可接受)。

## [4.0.77] - 2026-10-03

### 修复
- **在线搜索接口 502:插件软失败返回缺 songs 字段时核心直接崩**
  - 现象:`POST /rest/api/v1/online/:providerId/search` 在 lx-source 全部音源
    回退后返回 502,日志 `Cannot read properties of undefined (reading 'map')`。
  - 根因:`online.ts` 的 search 响应构造直接 `result.songs.map(...)`,而插件
    (lx-source withFallback)全部音源无结果时返回 `{empty:true,message,trace}`
    的软失败形状,没有 songs 字段。
  - 修法:songs 非数组按 0 结果返回,插件的 message(失败原因/回退轨迹)透传给前端;
    配套插件 lx-source v1.0.10 侧补齐 `songs: []`(双保险)。
## [4.0.76] - 2026-10-03

### 修复
- **P0 插件 jsenv 子环境:单次 execute 空转满 25 秒,必然拖到宿主超时(HTTP 500)**
  - 根因:`plugins/discovery.ts` 的 `pumpJobs` 只有子环境 runtime 死亡才提前退出,
    而 `execute` 里算出的 `done`(目标 promise 是否结算)是**设了没人读**的死变量,
    于是哪怕一个 1ms 就能结算的微任务也要空转到预算耗尽(默认 25000ms)。
    宿主主线程调用预算是 20s(`sandbox.ts` `INVOKE_TIMEOUT_MS`),25s > 20s,
    结果就是「子环境里只要有任何异步任务,插件方法一调用就被掐断」。
    真机表现:lx-source 音源里依赖异步注册的长青SVIP / fish / ikun / 念心 / 星海
    单独测试一律整整 20.0s 后返回 500;同步注册的源(全豆要/幻音/Huibq/溯音/统一/汽水VIP)正常。
  - 修法:
    - `pumpJobs` 增加 `until` 结算判定回调,目标 promise 一 settle 立刻返回;
    - 预算收敛为 `JSENV_PUMP_BUDGET_MS = 8000` / `JSENV_NET_BUDGET_MS = 8000`,
      均远小于宿主 20s,单次 jsenv 调用不再可能单独把方法拖超时;
    - 子环境 interrupt deadline 30000 -> `JSENV_DEADLINE_MS = 10000`。
    - `jsenv.execute` 返回值句柄 `vh.dispose()` 由裸调用改为 `try/catch` 容错
      —— `dump()` 会消费 handle(实测再 dispose 抛 `QuickJSUseAfterFree`),
      此前任何异步注册的音源 probe execute 都可能被这个异常打断。
### 新增
- **manifest.longRunningInMain:只放宽时间预算,不切 worker 线程**
  - 解决的问题:`longRunning` 一个字段同时承担两个语义 —— ①放宽预算
    (20s -> 最多 300s)并把看门狗换成软看门狗(`await` 网络期间不计时);
    ②把方法路由到 worker 线程(`sandbox.ts` 的 `worker.invoke` 分支)。
    而 worker 下 `host.jsenv` 子环境一律不可用(`sandboxWorker.ts` 返回 UNSUPPORTED),
    于是依赖 jsenv 的插件陷入死结:声明 `longRunning` 就跑不了子环境,
    不声明就只有 20s 墙钟预算且 `await` 网络也计时。
  - 用法:在 `longRunning` 里照常声明预算,再把方法名列进 `longRunningInMain`。
    这些方法会拿到长预算 + 软看门狗,但强制留在主线程(`this.invoke`)。
    当 `longRunningInMain` 覆盖了全部 `longRunning` 键时,不再创建 worker 线程。
  - 未列入 `longRunning` 的方法名填在这里无效(仍走默认 20s 预算),
    避免「凭空拿到长预算」;字段可选,老插件行为完全不变。

## [4.0.73] - 2026-10-01

### 测试
- **SENDSPIN 协议链路回归守卫(Sendspin Guard)**:
  - 新增工作流 `.github/workflows/sendspin-guard.yml`(blocking,push main + PR),
    把 v4.0.6x~v4.0.72 三轮真机验证拍板的协议契约钉死,防止后续改动静默回归。
  - 新增门禁用例:
    - `groupStateTriad.test.ts`(P0):`group/update` 的 playback_state 必须是
      stopped / paused / playing 三态;退回两态会让设备分不清「暂停」与「断网」,
      P1 续播随之失效 —— 已做变异验证(吃掉 paused 分支即转红);
    - `forkSeekContract.test.ts`(P1):fork(子进程)路径必须把续播位置
      `seekPositionMs` 透传到 `playCore` / `playGroupCore`。该路径漏参数是
      **静默失效** —— 主进程测试跑 in-proc 全绿,只有真机 fork 模式才暴露
      (暂停后恢复播放回 0);
  - 源码级静态守卫 11 条,覆盖 vitest 覆盖不到的 plumbing:三态表达式、
    `PAUSE_AUTO_STOP_MS` + `keepCurrent` 分支、续播位置的**生产侧两点**
    (`protocolPlayer` / `index` 的 RPC 入参)与消费侧(`childMain` 解参)、
    `canKeepStream` / `clearPlayback` 及两处切歌分支、legacy 回退阀门。
  - 全部守卫已做**变异验证**:逐个回退 P0 / P1 / P2 的修复,动态用例与静态
    守卫均确认转红(守卫不是恒绿的摆设)。

## [4.0.72] - 2026-10-01

### 修复
- **切歌不再发 `stream/end`(spec 语义归位 + gapless)**:
  - 依据:MA `providers/sendspin/player.py:1454` ——
    "The spec reserves stream/end for queue-empty, not track changes."
    MA 的切歌走 `cancel(keep_stream=True)`(`playback.py:405-431`),即
    `PushStream.clear()` + `ps.stop(keep_stream=True)`:只清缓冲、流不结束。
  - 改动:切歌 / seek 由 `finishPlayback()`(`stream/end` + `group/update(stopped)`)
    改为 `clearPlayback()`(`stream/clear`),随后照常起新的 `stream/start`。
    自然播完(队列空)与用户 stop 仍走 `stream/end`,语义不变。
  - 收益:设备不再因 `stream/end` 拆掉解码/扬声器上下文,`group/update` 也不再
    闪一下 stopped —— 切歌变 gapless,下一首无需完整重建流。
  - 回退阀门:`MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY=0` 可退回旧路径(legacy
    成员在场时整组走 `stream/end`)。默认取舍见代码注释里的真机实测结论。
  - **240 真机实测**(esp32-player2 / ESPHome 2026.9.0,legacy 明文客户端):
    设备日志 `Stream clear - player:1 artwork:1 visualizer:1` →
    `Group update - state: playing` → `Stream Started` →
    `Processed new codec header`,**全程无 `Stream ended`**;连切两首序列稳定成对,
    服务端零 `Failed to send audio chunk` / `Lost sync`,进度 1:1 推进。
  - 新增回归门禁 `backend/src/services/sendspin/trackChangeKeepStream.test.ts`:
    切歌只发 clear 不发 end、严格档下 legacy 退回 end、`clearPlayback` 不报 stopped。

## [4.0.71] - 2026-09-30

### 修复
- **依赖漏洞一轮清零**（`security` 工作流此前 failure，属预存在问题）：
  - 后端 `undici` ^8.10.0 → ^8.11.2（high，漏洞区间 8.0.0–8.10.1）；传递依赖
    `brace-expansion` 三处 1.1.18→1.1.21 / 2.1.4→2.1.7 / 5.0.9→5.0.12（均补丁级、非破坏）。
  - 后端 `vitest` / `@vitest/coverage-v8` 3.2.7 → 5.0.3（OSV GHSA-82fw-gwwq-j7x9，
    dev-only；vitest 5 的 peer 要求顺带把 `@types/node` 20 → 24）。全量 407 文件 /
    5513 例 **0 失败**，tsc 0 错，且跑得更稳（718s vs 此前 1052s，此前偶发的 sandbox
    60s 超时未复现）。
  - 后端 `vite` 钉到 ^7.0.0（**关键**）：vitest 5 默认会拉 vite 8 → rolldown，
    而 CI 用的是 npm 10（node 22），其 arborist 处理 rolldown 的平台可选包会崩
    `npm error Invalid Version`，导致 `npm ci` 直接失败（多工作流飘红）。
    vitest 5 的 peer 是 `^6.4.0 || ^7.0.0 || ^8.0.0`，允许 vite 7，故显式钉版即可
    去掉 rolldown，npm 10 的 `npm ci` 恢复正常——**无需改动任何 CI 配置**。
  - 前端 `axios` 1.19.0 → 1.20.0（OSV 报 5 条 high，CVSS 7.0–8.3；**npm audit 未覆盖**，
    只有 OSV 扫得出）；`brace-expansion` 2.1.4 → 2.1.7。
  - 复验：backend / frontend `npm audit --audit-level=high` 均 0；`osv-scanner`
    `--fail-on-vuln` 全仓 **No issues found**（此前 7 条）。

## [4.0.70] - 2026-09-30

### 修复
- **SENDSPIN 暂停后恢复播放从头开始（无声）**（240 ESP32 真机定位）：`coldStartResume` 调 `playMedia` 时未带续播位置，导致 `playCore(startMs=0)` —— 暂停 → 30s 看门狗转 stop（`keepCurrent` 保留 `group.positionMs`）→ 点播放，进度从 0 开始且不出声。修复：先 `self.pollState()` 读回暂停位置，再透传 `startMs`（`seekPositionMs`）到 `playCore` / `playGroupCore` / fork RPC，设备侧 `Stream ended → Stream Started` 成对重建即正常出声。新增回归门禁 `coldStartResume.test.ts`：`pollState` 回报 40.064s → `playMedia` 必须收到 `startMs=40064`（而非 0）。

## [4.0.69] - 2026-09-30

### 新增能力
- **SENDSPIN 实时控制对齐 Music Assistant**（`services/sendspin/`）：
  - 组状态由「playing / stopped」两态升级为**三态**（`playing / paused / stopped`），
    设备据此区分「暂停」与「断网」——此前暂停**零下行通知**，设备只看到推流停了。
  - 暂停满 30s 自动转 stop（`PAUSE_AUTO_STOP_MS = 30_000`，对齐 MA `_watch_pause`），
    回收推流资源；resume / stop 均会 disarm，杜绝僵死的 paused。
  - `set_static_delay` 下行（钳制 0–5000ms），复用既有 `supported_commands` 门禁，
    设备未宣告一律静默不发（真机 esp32-player2 只宣告 volume / mute，故当前不下发，符合预期）。
- **离线设备常驻可见**：SENDSPIN 设备断连只置 `available=false`，**不再摘除 peer** ——
  此前它是唯一「断连即真删」的协议（DLNA / AirPlay 本来只置位）。组成员、播放器切换器、
  群组页候选项现在都保留离线设备并带「离线」标记，不再自动清理或隐藏。

### 修复
- **暂停看门狗误触发**（240 真机定位，表现为设备被误 stop 并在组内显示离线）：
  `pauseCore` 无条件 arm（没在播也埋雷）+ 冷起播路径不清 `paused`。改为仅在真有曲目在播时
  arm，并在 `playCore` / `playGroupCore` 起播入口统一 `clearPauseState()`。热部署后观察 3 分钟，
  误触发 0 次。
- **`resolveLiveGroup()`**：设备加入用户组后 `conn.group` 指向 `ug:<id>`，而
  `srv.group(clientId)` 返回的是**单设备组** —— `paused` 此前被置到错误的组上。新增该 helper
  优先取 `conn.group`，已接入 pause / resume / 看门狗 / set_static_delay。
- **`GET /v1/sendspin/clients` 只列在线连接**：改为以持久设备档案 `sendspin_device_state`
  为底表叠加连接态，离线设备也能被找到、能加回组。
- **`pruneOrphans` 误清离线设备**：合法 sendspin 集合不再只看 peer 注册表，并入持久化档案，
  离线设备的队列 / 播放器条目不再被 10 分钟一轮当孤儿清掉。
- 前端：store 与 WS `peer_unavailable` 不再过滤 / 删除离线 peer；组编辑候选不再用
  `sendspin:host:port` 造 id（与真实的 `sendspin:<clientId>` 不合并 → 重复且永远离线的成员）；
  Flows 控制页不再把离线 ESP32 硬编码标为在线。

## [4.0.67] - 2026-09-29

### 新增能力
- **支持 HTTP Basic 认证**(RFC 7617,`Authorization: Basic base64(user:pass)`)。
  此前 `middleware/auth.ts` 只认 `X-API-Key` / `Bearer` / `X-ND-Authorization` / `?u&t&s` / `?u&p` / `?token=`
  六种凭据,**完全不解析 Basic** —— 老牌 Subsonic 客户端、curl 以及部分 Home Assistant 集成默认就走这一条,
  拿到的永远是 401。Basic 现在排在最后一条分支(不改变既有凭据的优先级),
  且只按**第一个**冒号切分 `user:pass`,所以口令里自带 `:` 也能认证通过。


### 修复
- **SENDSPIN 心跳零容忍导致设备循环断连（`services/sendspin/server.ts`）**：设备起播后偶发解码/I2S 抖动会使 ESP-IDF `httpd_ws` 线程被占用、10s 内心跳漏回一帧 PONG；原「一轮未回即 `ws.terminate()` 摘牌」会把短暂抖动升级为永久断连（每 ~70s 一次 terminate→重拨死循环，播 ~7s 即无声）。改为**连续 3 次（≈30s 宽限）未回 PONG 才摘牌**，对齐权威文档 §2.9「容忍抖动」精神；另清理 `client/state` 中把字节 `buffer_capacity` 误当毫秒存的误导性死字段 `bufferCapacityMs`，日志改回打印正确字节值。240 真机验证：设备稳定连续播完多首歌并自动切歌，`terminate 摘牌` 触发 0 次。
- **D26(`middleware/auth.ts`)**:401 之前留下一条**可诊断**的凭据画像(脱敏)——
  `scheme`(basic / bearer / none)、是否带 `X-API-Key` 与 `?token=`、`subsonicUser`(只记用户名,不记口令)。
  此前 401 只有一句固定中文提示「认证失败,请检查账号密码」,线上分不清是「客户端用了 Basic 而后端不认」
  「key 在服务端被重置过」还是「压根没带凭据」,实际排查只能靠抓包 + 翻库。密钥/口令一律不落日志。

- **D24（`services/transcode.ts` + `services/audio/flow.ts`）**：转码槽 FIFO 队列里的等待现在**可以被取消**。
  此前「客户端断开 / 停投」走到的 `abort()` 叫不醒还排在队列里的 `await acquireTranscodeSlot("flow")` ——
  `run()` 因此永不返回、`done` 永不 resolve，那个槽也永远还不回来（池额度被一笔笔慢慢吃光）。
  现在会话持有整会话 `AbortController`，`abort()` 会把排队者 reject 并直接从队列摘掉。
- **D25（`services/audio/flow.ts`）**：`abort()` 由「只 `kill("SIGKILL")`」改为连 pipe 一起拆（新增 `reap()`）。
  Node 的 `ChildProcess` `close` 事件要等**全部 stdio 流关闭**才发，而死掉的 ffmpeg 常卡在写满的 stdout pipe 上
  （调用方只读了一块就撒手，pipe 满着没人读），于是 `exit` 到了、`close` 永远不来 ⇒ `done` 会永久吊住
  （实测约 8% 的 abort 会话复现，就是 `flow.test.ts` 里那条偶发红）。现在收敛不等对端关管；
  顺带堵掉解码器侧同类的槽泄漏（只 kill 不拆管 ⇒ `close` 不来 ⇒ `settle()` 不跑 ⇒ 槽还不回来）。


### 测试
- `tests/middleware/authMiddlewareFlows.test.ts` 新增 8 条:Basic 明文口令 / 口令自带 `:` 仍通过 /
  错口令 401 / Basic 解码后无冒号时不挡住后面的凭据分支;以及 401 画像的 `scheme`、`subsonicUser`
  与「不含口令原文」。全部走**双向证伪**(关掉 Basic 分支后 2 条立即变红,恢复后转绿)。
- 备注:画像断言**不**去 spy logger —— logger 是 `createLogger()` 现造的实例,与本文件 import 的未必是同一份,
  那种断言一改 logger 实现就红;这里直接验画像本身,稳定得多。

- 三个 flaky 用例的根因全部修掉，不再靠加大超时兜：
  - `services/lyricsCacheSweep.test.ts`：sweep 是模块加载时注册的 `setInterval`，tick 落在**固定网格**上，
    而缓存条目是执行到一半才写入的（晚锚点 ε 毫秒），判 `age >= TTL` 时最后一次 tick 的 age 是 `TTL - ε`，
    差那几毫秒就直接不删；机器忙时 ε 大、跑得顺时 ε = 0，于是同一个用例时绿时红（实测 6 轮挂 4 轮）。
    改为推进 `TTL + 一个完整 sweep 周期`，最后那轮 tick 的 age 必然 `>= TTL`。
  - `services/rawStreamCache.test.ts`：后台 `warmBlock` 是 fire-and-forget，与「下一个 Range 何时到达」是并行竞态，
    原先靠 `setTimeout(…, 20)` 猜「差不多好了」。改为 `settleBackgroundWarm()`：等上游侧 inflight 归零
    （后台那条块请求已收尾）再放 12 个微任务（`await` 之后的 `src.store(...)` 才会跑完）。
  - `services/preferredSource.test.ts`：seed 的 `created_at` 用**毫秒**做单位，相邻两条常常打平，
    而 `orderBy(songs.createdAt)` + `limit 1` 在排序键平局时的返回顺序**未定义**。
    改为秒后两条 seed 至少相差 1000ms，彻底消除平局。
- 新增两条回归用例，且都做了**双向证伪**（回退修复后立刻复现，恢复后转绿）：
  `tests/services/flowSlotAbort.test.ts`（D24 排队中 abort）、`tests/services/flowAbortSettle.test.ts`（D25 拆管收敛）。
- `tests/services` 目录级 8 轮压测全绿。

## [4.0.66] - 2026-09-29

### 测试（覆盖率 C 类真实逻辑缺口补测，产品代码零改动）
- 新增 10 个测试文件，覆盖此前从未触达的真实逻辑分支：
  - `sendspin/encoding.ts`：FLAC 帧解析守卫与 strict 边界行为证据用例（chanCode 11..15 保留值被上游守卫拒绝、strict 恰落缓冲末尾的精确切帧）；经源码核对 `readSigned` / `alignByte` / `looksLikeFrameHeaderAt` 为零调用点死代码、`frameChannelLayout` 保留值分支被守卫挡死（本版不改产品代码，已标注待后续清理轮）。
  - `sendspin/server.ts`：dial 超时（`ws.terminate()` + `dial timeout`）与 dial 失败两条 reject 路径。
  - `routes/api/peers.ts`：6 个路由此前从未断言的成功返回 `{success:true}` + renderer 操作 403 FORBIDDEN。
  - `routes/auth/index.ts`：`POST /login` 路由 handler 成功/失败两条路（此前仅 handleLogin 单测，路由层零覆盖）。
  - `pluginAccess.ts`：`getPlaylistSyncImpl` 三条选择路径（命中带 `rebuildPlaylistEntries` 的 / 跳过选后续 / 全无返回 undefined）。
  - `audio/dsp.ts`：pan 立体声右声道衰减公式 + `perChannelPreampDb` FL/FR 非零组装。
  - `plugin/localRecommend.ts`：口味/参考池两路候选的 `seen.add` 去重分支。
  - `plugin/importers/netease.ts`：非法歌单链接抛错 + 合法链接透传正确 id。
  - `plugins/discovery.ts`：外置插件 `create()` 未返回 impl → `sandbox.dispose()` + 跳过 + 继续加载后续插件。
  - `player/PlayerController.ts`：`resetPlayerState` 四步清理（tracker/latest/pending/optimistic）。
- 覆盖率：Lines 99.15% → 99.29%；Branches 88.22% → 88.32%；Functions 97.19% → 97.27%（全量 401 文件 / 5486 条零失败）。

## [4.0.65] - 2026-09-29

### 修复（行为变更类缺陷 13 条：D14–D19 / D21 / D22 / D27–D30 / D34）
- [P3] D14 `plugin/dailyRecommend.ts`：远程全失败且本次无池歌新增时，不再无条件盖当天日期（此前谎报「今天已更新」且当天不再重试）。改为不盖日期、返回 `skipped:true`，保留既有内容并允许当天重试。
- [P3] D15 `plugin/playlistSync.ts`：歌单重建时「匹配成功（已挂 song_id）」的行一并将 `unavailable_reason` 擦成 NULL，消除「可播后仍残留『曲库中未找到』」。
- [P3] D16 `peer.ts`：60s 周期 / 5s 首填充 / 20s 重启清扫三条钩子统一收敛到 `safeTick`，发现源抛错只记 log.error，不再成为未捕获异常（此前 60s 那条会让进程周期性终止）。
- [P3] D17 `plugin/localRecommend.ts`：口味路径与「参考歌单池」路径读同一个 `excludeRecent` 开关，修复「关掉排除最近播放」在口味路径下静默失效。
- [P3] D18 `plugin/randomSongs.ts`：rowid 过采样区间相对 limit 过小（`span <= limit*4`）时退化为 `ORDER BY RANDOM() LIMIT n`，修复「库容≈count」时静默少数（如 60 首库抽 48 只得 47）。
- [P3] D19 `playlist/autoMatch.ts`：区分「后台匹配器失败」与「等批量闸超时」——底层 reject 现回报 `failed`（失败原因，新增可选字段）并记 log.warn，仅真超时才置 `lockTimeout`。
- [P2] D21 `lyrics.ts`：WebDAV sidecar 歌词拼接保留源配置子目录（此前只取 `origin`、子目录被丢，拼出非法 URL 永远取不到）；并为源不存在 / url 缺失 / 抓取未命中 / 本地文件缺失补 warn/debug 日志。
- [P3] D22 `lyrics.ts`：歌词第 ④ 级（源插件 `lyricUrl`）整段包进 try/catch，插件抛错不再冒穿成上层 500，按「无歌词」处理并记 warn；顺带修掉 fetch 失败时定时器未清（移入 finally）。
- [P3] D27 `source/online/recommendImport.ts`：未带 `userId` 时显式拒绝导入（返回 `success:false` + warn），不再把 `owner_id` 写成空串触发外键约束失败、导致整单导入失败。同时修正生产调用方 `batch/jobs.ts`：每日推荐同步现显式传入 `systemOwnerId()`（首个 admin），该路径此前因落空串一直无法建单。
- [P3] D28 `source/online/recommendImport.ts`：落库与返回值统一用兜底名「每日推荐」，消除「库里叫每日推荐、返回空串」的不一致。
- [P2] D29 `source/online/recommendImport.ts`：「每日推荐」轮换删除修复——旧歌单统计前置到导入之前（分母回到「昨天的量」），使远端已下架的旧单真正可被清理；并新增「本轮导入失败的渠道不清理」保护，避免失败时把歌单清空。
- [P2] D30 `sendspin/pairServer.ts`：静态配对码失败节流修复——码错误先记数，未达上限（<5）时保留配对会话回到「等输码」以便重试，达上限才真正断；此前首次错误即 abort 导致 `failures` 恒为 1、锁定窗口不可达。
- [P2] D34 `sendspin/pairServer.ts`：动态码日常时序修复——一条配对会话内 `nonce_A` 只随机一次，并允许在「等输码」状态再收一次 `client/pair-init` 推进 PAKE；此前重发 init 被状态机丢弃、且 nonce 每次重随机导致判码必错。

### 测试
- 14 个测试文件按新行为翻转（D14/D15/D16/D17/D18/D19/D21/D22/D27/D28/D29/D30/D34 全部去除「现状固化」断言），并补足 D29 清理段新可达分支（favorite / try-catch）与 D30/D34 新契约。
- 仅改上述源码 + 对应测试，无对外 HTTP 契约破坏（D19 为新增可选字段 `failed`）。

## [4.0.64] - 2026-09-29

### 修复（发版 CI 回归：测试文件与 v4.0.62/v4.0.63 实现不同步）
- [P1] `tests/routes/apiOnline.test.ts`：R5 精确替换时第 280 行模板字面量引号损坏（反引号开启、却用双引号闭合），导致 esbuild 转译失败、整份文件无法加载（`Test Files 1 failed / Tests no tests`），并连带 `ci` 与 `build-and-push` 的全量测试门禁失败。改为正确的反引号闭合（diff 仅 1 行）。
- [P1] `tests/sendspin/lt1_pairServerGaps.test.ts`：与 v4.0.63（D31/D32/D33 死代码清理）不同步，9 条中 7 条失败：
  - 3 条「解码失败收口」用例依赖已删除的三处 `b64urlDecode` try/catch（用哨兵 `__BAD__` 强制解码抛错）→ 改为基于保留守卫（解码后长度 / derive / 验签）的真实载荷用例。
  - 3 条「finalize 背靠背缓存」用例依赖已删除的 `pendingFinalize`→ 改为锁定新契约：抢在 auth/confirm 之前到达的 finalize 一律忽略（不落盘、不缓存）。
  - 1 条 `waitForCode` 用例依赖已删除的方法 → 改为断言该入口已不存在。
- 与更早同步完成的 `pairServer.test.ts` / `pairServerBranches.test.ts` 口径一致。

### 测试
- 仅改上述两个测试文件（`apiOnline.test.ts` +1/-1；`lt1_pairServerGaps.test.ts` 净删 44 行），无产品代码改动。

## [4.0.63] - 2026-09-29

### 修复（真实产品缺陷：sendspin 配对模块死代码/死 catch 清理 D31/D32/D33）
- [P3] 清理 `services/sendspin/pairServer.ts` 中三处不可达代码，纯清理、不改产品行为：
  - **D31**：删除无调用点的 `waitForCode()` 私有方法，及其专用 `codeWaiters` 字段与 `enterCode` 中唯一的使用点（`a.codeWaiters.splice(0)` 唤醒循环）。
  - **D32**：删除 `pendingFinalize` 字段（始终为 `undefined`）及其在 `onPairAuth` / `onPairConfirm` / `onPairFinalize` 中三处不可达的「背靠背 finalize 缓存」分支；`onPairFinalize` 早退改为直接 `return`（忽略过早到达的 finalize）。
  - **D33**：删除三处 `b64urlDecode(...)` 的 `try/catch` 死分支——`Buffer.from(s, "base64url")` 对非法字符静默丢弃、永不抛异常，catch 不可达；下游长度/验签检查已覆盖拒绝逻辑。
- 台账「双向证伪」证据：上述代码废掉后 sendspin 配对套件（含 49 条配对用例）仍全绿；本次实测 sendspin 全量 36 文件 / 213 条用例零失败，`tsc --noEmit` 干净。

### 测试
- 无新增用例（死代码清理，既有 `pairServer.test.ts` / `pairing.test.ts` / `pairE2E.test.ts` 及 sendspin 全量套件覆盖）。

## [4.0.62] - 2026-09-29

### 修复（真实产品缺陷：online.ts 上游异常原文外泄）
- [MED] `routes/api/online.ts` 多处错误响应把上游异常原文 `e.message` 透传给客户端：
  - 响应泄漏（随 `error` 字段外泄）：`/search`、内联 `/match-playlist`、单曲 `/match-track`、
    `/unmatched`、单曲 `/import`、GET `/recommend`、`/purge-web-songs` 共 7 处 `apiError(CODE, e.message || key)`。
  - 后台任务状态泄漏：`/match-playlists` 与 `/recommend/sync-all` 的 `job.error` / `state.error`
    写入原始 `e.message`，经 status 轮询接口暴露。
- 修复：所有泄漏点改为返回**稳定 i18n key**（不随异常内容变化），原始异常只进 `log.error`（服务端日志，脱敏）；
  状态码与业务码不变（UPSTREAM_ERROR→502 / INTERNAL→500）。
- 新增 i18n key `errors.online.syncAllFailed`（「同步所有平台失败」），其余复用既有 key
  （`errors.search.failed` / `errors.search.queryFailed` / `errors.online.matchFailed` /
  `errors.online.fetchRecommendFailed` / `errors.import.failed` / `errors.online.purgeFailed`）。

### 测试
- `tests/routes/apiOnlineErrorPaths.test.ts`：既有 5 个仍断言原文泄漏的用例改为断言稳定 key + 证伪原文；
  新增 `/search`、GET `/recommend`、`/import` 失败路径用例（断言 502/500 + 业务码 + 稳定 key + 原文不泄露）。
- `tests/routes/apiOnline.test.ts`：3 个断言 `error:"boom"/"db down"/"upstream down"` 的用例改为断言稳定 key + 证伪原文。

### 覆盖率（全量实测）
- 全量回归：391 文件 / 5449 条用例全绿，0 失败；`tsc --noEmit` 干净。
- Lines **99.15%**；Branches **88.21%**；Functions **97.19%**（对比 v4.0.61 基本持平，+3 用例，无新增缺口）。

## [4.0.61] - 2026-09-29

### 修复（真实产品缺陷，来自 4.0.60 汇总台账）
- [HIGH] `routes/api/online.ts:348-356`：POST recommend/import 的 catch 原先返回
  `{success:false, error:e.message, sandboxCode, hint}`，**HTTP 200、无 `code`、且 `e.message` 原文外泄**。
  改为统一错误契约 `apiError(UPSTREAM_ERROR, "errors.online.importRecommendFailed")` + `apiErrorStatus(UPSTREAM_ERROR)`（**HTTP 502**），
  并 `log.error` 记录原始异常；`sandboxCode` / `hint` 仍为可控上下文透传（非异常原文）。
- [MED] `routes/api/entitySearch.ts:199,225`：song / album import 的 `startAsyncTask` 未启动时
  原先返回 `{success:false, alreadyRunning:true, taskId}`，**HTTP 200 且缺 `code`**。
  改为 `apiError(CONFLICT, "errors.search.alreadyRunning")` + `apiErrorStatus(CONFLICT)`（**HTTP 409**），
  并新增 i18n key `errors.search.alreadyRunning`（「该任务已在运行」）。
- [MED] 原始异常外泄：`routes/api/library.ts:328,365`（scrape 后台失败写入 job.error，经 scrape-status 暴露）、
  `routes/api/online.ts:147`（match-playlist 后台失败写入 matchJobs.error）——
  改为 `log.error` 记录后只回传稳定 i18n key（`errors.scraper.failed` / `errors.online.matchFailed`），不再外泄 `e.message` 原文。
- [LOW] 死代码/死分支：`services/source/scanner.ts` 的 `upsertSong` 声明返回 `"added" | "updated" | "skip"`，
  但 `skip` 永不返回（仅 `added` / `updated`）；两处调用点的 `else if (result === "updated") updated++; else skipped++`
  中 `skipped++` 恒不可达。收敛返回类型为 `"added" | "updated"`，调用点改为 `else updated++`。
  复核：`services/audio/flow.ts:447-449` 经核实为交叉淡入禁用时的可达回退分支，**非**死代码，已从台账移除。

### 测试
- `tests/routes/apiOnlineErrorPaths.test.ts`：match-playlist 失败断言改为验稳定 key；
  recommend/import 沙箱错误用例改为断言 `502 + UPSTREAM_ERROR + errors.online.importRecommendFailed`，并证伪原文不泄露。
- `tests/routes/apiLibrarySources.test.ts`：刮削失败用例改为断言稳定 key、证伪原文不泄露。
- `tests/routes/lt2_entitySearchErrorBranches.test.ts`：新增「导入任务已在跑（alreadyRunning）→ 必须 409 CONFLICT + code」用例（song + album 两个），mock `startAsyncTask` 控制返回。

### 覆盖率（全量实测）
- 本次仅修复产品缺陷 + 同步断言现状行为，未新增覆盖缺口；`scanner.ts` 移除死分支后未覆盖行微降。
- 全量回归：391 文件 / 5446 条用例全绿，`tsc --noEmit` 干净。
- Lines **99.14%**；Branches **88.21%**；Functions **97.14%**。

## [4.0.60] - 2026-09-29

### 测试
- 长尾覆盖补测：sendspin 残余（server/index/pairServer/encoding/framing/handshake/
  streamEngine/supervisor/crypto 等）、routes/api 与 middleware、services 长尾
  （scanner/scraper/airplay/utils/player/covers/access/transcode 等）、plugins/audio/ws/batch 残余。
- 新增 53 个测试文件；全量 391 文件 / 5444 条用例全绿，`tsc --noEmit` 干净。

### 覆盖率（全量实测）
- Lines **99.15%**；Branches **88.18%**；Functions **97.19%**。

### 发现的真实缺陷（本轮仅汇总，未改产品代码）
- [HIGH] `routes/api/online.ts:348-356`：POST recommend/import 的 catch 返回
  `{success:false, error:e.message, sandboxCode, hint}`，HTTP 200、无 `code`、且 `e.message` 原文外泄。
- [MED] `routes/api/entitySearch.ts:199,225`：`startAsyncTask` 未启动时返回
  `{success:false, alreadyRunning:true, taskId}`，HTTP 200 且缺 `code`。
- [MED] 原始异常外泄：`routes/api/library.ts:328,365`（写入 job.error，经 scrape-status 暴露）、
  `routes/api/online.ts:147`（写入 matchJobs.error）。
- [LOW] 死代码：`services/audio/flow.ts:447-449` 不可达 else-if；
  `services/source/scanner.ts:691` `upsertSong` 声明返回 "skip" 但从不返回 → 268/815 的 `skipped++` 恒不可达。

## [4.0.59] - 2026-09-29

### 测试
- 补全 sendspin 服务层覆盖：`server.ts`(383→66 未覆盖行)、`index.ts`(324→28)、`pairServer`/`encoding`/`streamEngine`/`streamSource`/`esphomeBridge`/`childMain`/`roles/*` 等。
- 补全非 sendspin 域：`services/proxy`、`routes/api/online`、`airplay/raop(transport)`、`batch/jobs` 管线、`group/GroupManager`。
- 新增 16 个测试文件（含 1 个 socket 桩辅助 `_connStubs.ts`），共 295 条用例。
- 修正 `tests/batch/jobsPipelineExtras.test.ts` 中 `purgeExpiredWebSongs` 的 mock 误写为 async 的缺陷：
  真实实现是同步函数（`purge.ts: export function purgeExpiredWebSongs(): PurgeResult`），
  同步调用点拿到未 await 的 Promise 会变成 unhandled rejection，且掩盖「清理日志」这条真实契约。

### 覆盖率（全量实测）
- Test Files 338 passed / Tests 5130 passed（零失败）；`tsc --noEmit` 干净。
- Lines 93.15% → **97.11%**（+1299 行覆盖）；Branches 85.72% → **86.86%**；Functions 91.72% → **95.52%**。
- 未覆盖行 2243 → 944。

## [4.0.58] - 2026-09-29

### 测试（覆盖率缺口补测，产品代码零改动）
- 按覆盖率台账并行补测，本轮新增 286 条单元测试；全量套件 4835 条零失败：
  - B7 dlna 服务层残余：announceResilience / controlBaseUrlProbe / controlTransportGuards / deviceRecordDb / queueCompat / rawStreamCache（65 条）
  - B9 plugin/player 服务层：queueControllerLifecycle / dailyRecommendFixedRow / localRecommendTaste / peerCastQueue / playlistSyncDegrade（75 条）
  - B10 路由层与中间件：authCacheSweep / authCredentialFallbacks / dailyRecommendConfigRoundTrip / recommendFallbackContract / sharedScanJobsSweep（37 条）
  - B16 推荐源：recommendImport.flow（30 条）
  - airplay/raop.ts：raopPlayer（79 条，本轮早些时候已完成、本次一并纳入发版）
- 全量覆盖率：Statements 93.14% / Branches 85.71% / Functions 91.72% / Lines 93.14%。
- 全部新用例均做变异反证或隔离证伪，守住产品契约；用例相互隔离、可重复 shuffle 跑。

### 已知缺陷（本轮未改产品代码，待后续处理）
- `rebuildPlaylistEntries`（`services/plugin/playlistSync.ts`）对已匹配条目不做二次曲库校验：
  本地文件被删/移走后，该条目仍 `playable=1` 且 `song_id` 悬空，播放端会投空。
  已由 `tests/services/playlistSyncDegrade.test.ts` 记入口账（现状断言），
  修复方案为曲库匹配不到时降级为占位（`playable=0` + `unavailable_reason`）。

## [4.0.57] - 2026-09-28

### Fixed
- **测试门禁修复(产品逻辑不变)**:`tests/dlna/controlRecast.test.ts` 的「落位校验:异常必须被吞掉」用例原本用 `expect(seeks).toBe(2)` 写死了 SOAP Seek 的精确计数。该计数来自 `verifySeekLanding` 这个 `void` 派发的异步协程;全量套件 shuffle 下,上一条用例的校验协程可能在本用例开始前尚未结束、串入本用例的 soap 桩,偶发多记一次 Seek(CI 实测 3、隔离跑恒 2)。这并非重发风暴——产品逻辑每次重发恰好一次、且只派生一个校验协程——纯属测试隔离假象。断言改为 `expect([2,3]).toContain(seeks)`,仍守住两条硬契约:① 至少发生过一次重发(校验走到了错误吞掉路径);② 重发抛错被校验协程自己收场、未冒泡成 unhandledRejection。同时仍能抓住两类真回归:完全没重发(seeks=1)与重发真成循环(seeks>=4)。
- 随 v4.0.56 的 Dxx-1/Dxx-3 产品修复一并发布;本次仅修正测试断言,后端运行行为无任何变化。

## [4.0.56] - 2026-09-28

### 修复

- **Dxx-1(`services/dlna/control.ts` `castToDevice`)**:重投流重建(`reseekByRecast`)自己开的 seek
  落位保护窗,会被它触发的那次 `castToDevice` 在尾段**无条件 `seekGuards.delete`** 立刻清掉
  (本意是"换歌清掉上一首的窗")。重投**不换歌**(songId 不变、`timeOffset` 有值),却同样被清 →
  `getDeviceStatus` 的重投间隙 STOPPED 防线读不到窗 → 误删 `reseekByRecast` 刚改锚的基线。
  240 真机实锤:170s 重投后进度从头重爬。修复:`castToDevice` 只在 `opts.timeOffset === undefined`
  (真换歌)时才删窗,重投保留窗。
- **Dxx-3(`services/dlna/control.ts` `setDeviceAlias` / `setDeviceDisabled`)**:仅存于 DB
  (尚未进缓存)的设备,写库成功后返回 `undefined`,调用方(`api/dlna.ts`)按"找不到设备"处置 →
  改名/禁用返回 404。新增 `readDlnaDeviceRow` 辅助,写库后从 DB 读回构造 `DlnaDevice` 返回
  (`dev ?? readDlnaDeviceRow`,缓存命中时短路、无额外 DB 读)。

### 测试

- `backend/tests/dlna/controlRecast.test.ts`:**26 条**(原 24 + 2 覆盖补充 + 1 台账修正),全绿。
  `control.ts` 语句覆盖率 **99.34%**,7(未覆盖行 [642, 643, 1176, 1177, 1178, 1571, 1572])。
- `tsc --noEmit` 通过;dlna 套件 4 轮 shuffle **260 条 × 4 全绿**。

### 纠正缺陷台账误判

- **Dxx-2(`reseekByRecast` `control.ts:1145-1147`)** 原被标成"死代码",重读确认**可达**:
  `castToDevice` 内部在 849/861/867 行有 `shouldAbort()` 检查点,当后续重投推进代际
  (`recastGens` 变大)时,旧重投会在 `castToDevice` 内抛 `SeekSupersededError`,被 1145 的
  `catch` 接住优雅退出;删掉它反而在那种时序下把错误抛给调用方(`seekDevice` 报错)。
  **不动产品代码**,仅把测试台账从"现状断言(死代码)"改为正确契约断言
  (旧重投串行化让位、1145 作为安全网保留)。

### 双向证伪变异(Dxx-1 / Dxx-3 各 1 条,均 KILLED)

- **Dxx-1**:把 `if (opts.timeOffset === undefined)` 改回"无条件删窗" → 重投保护窗测试立即变红
  (设备旧读数 5s 不再被回填成 >=87)。恢复后转绿。
- **Dxx-3**:把 `return dev ?? readDlnaDeviceRow` 改回 `return dev` → DB-only 设备改名测试立即变红
  (返回 undefined)。恢复后转绿。

### 备注

- 1541-1542(换歌删基线)与 618-619(过期 session 清理)仍属未覆盖:前者实际由 `castToDevice:905`
  同步更新 `positionEstimateSong` 兜底、属冗余防御分支,强行覆盖需操纵私有 Map,本轮跳过;
  后者是 `sessions.size>50` 的机会主义清理,低价值,跳过。

## [4.0.55] - 2026-09-28

### 测试

- `backend/tests/dlna/controlRecast.test.ts`(B7 补测):**24 条**,全绿。目标 `src/services/dlna/control.ts` ——
  专啃「SOAP Seek 无效」这条最值钱的产品链路:部分固件(HiVi/MUZO)播实时转码流时
  `GetPositionInfo` 恒回 `RelTime=0`、`Seek(REL_TIME)` **静默失效**(不报错也不跳),
  后端据此**学**出「该设备 seek 不可靠」并改走 `play_index(seek_position)` 语义的**重投流重建**
  (`reseekByRecast`:Stop → SetAVTransportURI(timeOffset=N) → 等可播放 → Play)。
  学习过程必须走满两次观察才落库判定 —— 这条「不许提前降级」的契约此前没有任何用例守着。
- `control.ts` 语句覆盖率 **99.13%**,9 行(未覆盖行号 [618, 619, 1146, 1147, 1148, 1229, 1230, 1541, 1542])。
- `tsc --noEmit` 通过;dlna 套件 4 轮 shuffle **258 条 × 4 全绿**。

### 双向证伪变异:6 条补断言后 6/6 被抓

补测写完**不等于**测住了。第二轮变异跑出 6 条"存活",逐条查下来全是**我的断言口径不对**
(不是变异无效),补强后全部被抓:

- **`waitUntilStopped` 的 1000ms 轮询间隔改成就绪 0ms,照样探 2 次就绿** ——
  数探测次数杀不掉"忙轮询"。补了**墙钟断言**:两次探测之间必须真的退让。
- **`verifySeekLanding` 的 catch 改成 `throw e`,用例照样绿** —— 那条 `void` 派出的协程
  异常无人接收,只有守在 `unhandledRejection` 上才看得见。补了该监听。
- **「暂停冻结」分支、`POSITION_ESTIMATE_MAX_AGE_MS` 重算分支各关掉一条,照样绿** ——
  原因是断言写的是 `frozen + 2` 这种容差,几毫秒的外推被吃掉。改成**精确相等**,
  精确钉住「暂停时长不许算进进度」。
- **`isSeekUnreliable` 的内存优先分支关掉,照样绿** —— 那条分支与它后面的落库查询结果
  恒真,只有**「内存为真、库里为假」**才分得出(运维重置持久化判定之后)。补了该用例。
- **`reseekByRecast` 里 `seekGuards.set` 这一行测了也白测** —— 正常路径上紧接着的
  `castToDevice` 会无条件 `seekGuards.delete`,窗开等于没开;只有让 `castToDevice`
  在删窗**之前**就退出(设备已被禁用),这行才显形。

### 修复

全量回归连跑三轮、红了两轮的**不同**用例,根因是同一类:**断言预算低于被测行为的最坏耗时**。
两处都不是产品缺陷,放宽的都是断言预算,没有动产品侧常量。

- `tests/routes/apiScanRead.test.ts`:`GET /v1/dlna/devices -> 非 5xx` 偶发红
  (`Test timed out in 5000ms`),单独跑该文件 5/5 全绿。根因:这条端点在发现缓存过期时会
  走真实 SSDP 冷扫描(`refreshDevices()` 预算 4000ms,`--reporter=verbose` 实测耗时
  **4003ms**),而 vitest 全局超时 5000ms 只剩 1s 余量,304 个文件一起跑时必然越线。
  本条契约要守的是「不抛 5xx」而非「快」,预算放宽到 20s。
- `tests/plugins/sandbox.test.ts`:`OOM 触顶耗尽 deadline 后重建仍成功` **单独跑就红**
  (32399ms > 自身 30000ms 预算)。用临时诊断脚本分阶段量过:干净进程 **12.7s**
  (load 36ms + leak 触顶与自愈重建 12695ms + ping 2ms),但同文件前面的 leak 用例会在
  **同一个 worker 进程**里留下内存压力(每个循环最多吃到 256MB,堆越满同样的 1MB
  字符串分配越慢),同一场景就此涨到 32.4s。产品侧给 rebuild 的独立预算是
  `REBUILD_TIMEOUT_MS = 30000`,断言预算理应高于它而不是等于它,故提到 60s。
  诊断脚本已删除。

### 已观察(建议后续单开一轮处理,本轮不动)

- OOM 类用例的耗时上限取决于**进程里已堆了多少垃圾**而不是被测代码,属测试隔离问题
  (把 `leak` 系列拆到独立文件即可根治),不是产品缺陷。

### 已知问题(本轮只登记,不改产品行为)

以下三条按「挂起 + 固化」处理:测试里写**现状断言**并标注 `现状记录(缺陷台账 Dxx)`,
本轮不动产品行为。

- **重投自己开的落位保护窗,会被它自己触发的那次投屏立刻清掉**(`control.ts:1141` 开窗 →
  `1143` `castToDevice` → `castToDevice` 在 `914` 无条件 `seekGuards.delete`,本意是"换歌时清窗")。
  重投**不换歌**却同样被清,于是「170s 重投后 STOPPED 样本删锚点 → 进度从头重爬」这条
  真机防线在重投链上等于没有。修复后该断言应改为回填成 `>= 87`。
- **`reseekByRecast` 的「中途被取代」分支不可达**(`control.ts:1145-1147` 是死代码):
  `recastChains` 把同设备的重投排队串行,后到者必须先 `await prevChain`,旧重投还在飞时
  不可能有新的 seek 去推进代际,`recastAborted` 永远为 false、`SeekSupersededError` 永远抛不出。
- **`setDeviceAlias` 对仅存于 DB 的设备写库成功但返回 `undefined`** —— 调用方拿到
  `undefined` 通常按"找不到设备"处置,这条路径上的改名会 404。

### 备注

- 变异脚本新增两项自检:每个变异串**必须恰好命中 1 处**(命中 0 处会假报"存活"),
  以及先跑一次**未变异基线**自证检测器不会把"全绿"误判成"存活"。
  上一轮的检测器正则在全绿时匹配不到任何失败数,把 6 条统统记成了 SURVIVED。

## [4.0.54] - 2026-09-28


### 补齐测试(services/dlna)

**`discovery.ts` 27.0% → 100%**(未覆盖行 119 → 0)。这块是用正则手撸的 UPnP
description 解析器,没有任何外部依赖兜底 —— 改错任何一条都不会报错,只会让部分
DLNA 音箱**静默地从设备列表里消失**:用户看到的是「设备偶发不见了」,日志里什么
都没有,属于最难复现的一类缺陷。

新增 `discoveryDescription.test.ts`(19 条)钉 description.xml 解析契约:相对
controlURL 转绝对地址、多 service 按 serviceType 挑选而不是按位置、缺 AVTransport
判为不可投屏、HTTP 非 2xx 与抓取抛错都返回 null 而不是把整轮扫描带崩、friendlyName /
UDN 的各种兜底。

新增 `discoveryScan.test.ts`(13 条)钉扫描与合并契约:socket 出错必须早退并标记
本轮不可信(否则空集会被当成权威答案,把**全网设备一次性判成离线**)、被动通告与
主动 M-SEARCH 结果合并去重、超过 10 分钟没再听到通告的设备必须剔除、`addMembership`
失败(容器/多网卡下 EADDRNOTAVAIL 是常态)必须被静默吞掉而不是让 SSDP 监听死掉。

**`control.ts` 81.73% → 86.47%**(未覆盖行 189 → 140)。新增
`controlAlignGuard.test.ts`(11 条)钉两条「位置真相」契约:

- `alignDeviceToPosition`(一次性校准 seek):设备没进稳定 PLAYING 前不许 seek、
  进了立刻开校、落位在容差内只发一次、leader 实时目标优先于固定目标、settle 窗
  耗尽仍尽力校准、seek 连续失败只重试不抛出。
- `getDeviceStatus` 里的 seek 保护窗:窗内 STOPPED 不得清基线(240 实锤那条路径)、
  窗过期即视为真停清基线、窗内读到陈旧读数用预期值回填且不被曲长封顶压回、窗外恢复
  采用设备读数。

`announce.ts` 维持 99% 覆盖(余下两行是 500ms 等待,纯 IO 型)。


### 覆盖率数字的陷阱:假 socket 自己就是盲区

`discovery.ts` 最后 1 行未覆盖(`try { sock.addMembership(...) } catch {}`)差点被
「覆盖率 99.4%」蒙混过去 —— 查下去发现**那个 catch 从来没有被执行过**,因为测试里的
假 socket 把 `bind` 写成了单参 `bind(cb)`,而监听端真实调用是 `bind(port, cb)`:
回调在**最后一个参数**,于是监听器的回调被静默丢弃,`addMembership` 一行都跑不到。

覆盖率能到 99.4%,说明「统计口径」没有问题,有问题的是「这一行到底有没有被验证过」。
是变异反证(去掉 catch 后测试竟然还是绿的)把这件事翻出来的。


### 本轮修掉的测试自身缺陷(共 4 条,都不是产品缺陷)

1. **用例间共享可变状态**:`lastAliveEmitAt`(alive 去抖)与 `announced` 都是模块级
   Map,前一个用例用同一 LOCATION 占掉 60s 窗口后,排在后面的用例发 alive 会被直接
   吞掉 —— 表现为「用例顺序一 shuffle 就红」(8 轮里红 4 轮,恰好是 `sequence.shuffle`
   把它排到 alive 用例之后的那些顺序)。修法:每个用例开跑前用官方清理入口
   `clearAliveEmit` 放开窗口,并用一条 byebye 清掉通告登记。
2. **断言依赖绝对时钟(与 v4.0.53 同一根因)**:`markStaleDevices` 边界用例裸写
   `Date.now() - X`,「构造设备」与「判定」之间过去真实毫秒,差 1 毫秒的两条于是随机
   翻红。修法:把造设备**和断言**一起放进冻结时钟 —— 断言必须也在块内,初版把断言留在
   块外,`markStaleDevices` 又跑回真实时钟(12 轮里红 3 次)。
3. **异步协程跨用例污染**:`seekDevice` 会派生 `verifySeekLanding`(sleep 1200ms),
   它「落位不符就重发一次 seek」的那一枪会落进**下一个**用例的调用计数里,seek 次数
   随 shuffle 顺序漂移。修法:让本文件的设备恒不报位置(`NOT_IMPLEMENTED`,即 MUZO
   播转码 chunked 流的真实表现),校验协程随即自行放弃。
4. **测试桩自递归**:覆盖 `soap` 时写了 `soap(a)` 回指刚赋值的那个 lambda,非目标动作
   于是无限自递归。修法:先把基础桩捕获到本地常量。


### 变异反证

10 条变异全部被新断言杀掉:

- discovery:`discovery.ts` 去掉 AVTransport 的 null 兜底 / 相对 controlURL 不转绝对
  / UDN 兜底退化成用 location 当 id / 陈旧通告不剔除 / 过期判定 `>` 改 `>=` / socket
  报错不标记不可信 / 去掉 `addMembership` 的 catch。
- control:align 跳过稳定态等待 / align 单轮异常不再继续重试 / 重投间隙 STOPPED 不清
  基线 / 陈旧读数不再回填。

`discovery.ts` 与 `control.ts` 的新用例改完连跑 12 轮(每轮重新洗牌用例顺序)全绿。

## [4.0.53] - 2026-09-28


### 修复(测试基建:断言不得依赖绝对时钟)

v4.0.52 的 CI 在「类型检查 + 全量测试」上红了两条用例,根因都不是产品缺陷,而是
**断言依赖真实时钟往前走一格** —— 慢机器 / VM 时钟被调整(kvmclock 跳变、NTP 校正)时,
两次读取会落进同一毫秒,`not.toBe` 于是随机翻红。本轮把三条同类断言从根上改写。

- `memoryReclaim.test.ts`(阈值边界用例):原来在真实时钟上拨 `Date.now() - 5*MIN + 1`
  再隔真实毫秒判定 —— 中间过去 ≥1 毫秒就翻成「空闲」。现在把 `Date` 换成假时钟:
  `isIdle()` 只读 `Date.now()`,判定时钟完全静止,「>= 才空闲 / 差 1 毫秒就不算」
  这条边界语义反而被钉得更死,与机器快慢无关。
- `discoveryHost.test.ts`(replaceEntries 刷 updated_at):原来断言「≠ 刷新前的值」,
  等于要求时钟真的走了一格(CI 上两侧同值:2026-09-28T09:29:09.188Z)。现在**钉哨兵 +
  冻时钟** —— 先把 updated_at 写成一个 2000 年的哨兵旧值,再把 Date 冻住:产品照常写
  就写成冻住的 now,漏写则保持哨兵。「有没有写」与「时钟有没有走」彻底脱钩。
- `recommendImportBranches.test.ts`(二次导入刷 updatedAt):同一根因(原来靠
  `await setTimeout(5)` 空等 5 毫秒)。同样改为「钉哨兵 + 冻时钟」,那 5 毫秒空等一并省掉。

范式由此统一:判断「某列有没有被改写」要用**与绝对时钟无关的哨兵比对**,而不是「前后两个
时间戳不相等」。`playlistsRoutesContract` 那条本来就是这么写的,现已作为参照。


### 变异反证(断言没有被绕过)

改完必须自证,否则只是把断言绕开:

- `isIdle()` 的 `>=` 改成 `>` → 2 条立刻翻红。
- `discovery.ts` 里三处 updated_at 写入(main UPDATE / `refreshPluginPlaylistCounts` /
  cover 兜底)全删 → 1 条翻红。
- `recommendImport.ts` 与 `shared.ts` 里的 updated_at 写入全删 → 1 条翻红。

期间还识别出两条**等价变异**并记账:只删掉 `recommendImport` 中 existing 分支那一条
updatedAt 写入时用例不红 —— `replacePlaylistSongs` 末尾的 `refreshPlaylistCounts()`
已经把 updated_at 刷回去了;discovery 侧同理(去掉前两处仍有第三处兜底)。
两者都不是测试缺口,不计为漏测。

回归:类型检查通过;全量 300 文件 / 4480 条全绿;满载(6 路并发占满核)连跑 3 轮共 18 次,
每次都是 170 条全绿、退出码全 0。

## [4.0.52] - 2026-09-28

### 测试

- `backend/tests/airplay/controlOrchestration.test.ts`(B31 补测):**107 条**。目标 `src/services/airplay/control.ts` —— 按「未覆盖行数 × 可测性」联合排序选中,是最后一块整文件未覆盖的服务层文件。分会话生命周期、起播编排、收尾 finalizer、设备持久化、暂停/恢复/停止、seek、音量与静音、状态读取、服务开关九个分组。
- `control.ts` 覆盖率(全量口径):**语句 100% / 行 100% / 函数 100% / 分支 96.96%**,唯一未覆盖分支落在第 28 行的 re-export 上。
- `tsc --noEmit` 通过;全量回归 **300 个文件 / 4480 条全绿**。

### 双向证伪变异(73 条,68 条被抓住)

把 `control.ts` 的 73 条契约逐个改坏后重跑本文件。首轮 53 条立即转红、**20 条存活**;
逐条归因后补掉 15 条真实测试缺口,复跑 15/15 全部转红;剩下 5 条判为等价变异或死代码。
首轮存活暴露出的测试缺口(补断言后均已钉住):

- **`stopSession` 没断言「解码器被 kill」** —— 只看了会话表移除与 `player.stop()`。
- **握手失败分支断言的是「上一次成功那一个」player** —— `startSession` 开头就会 `stopSession` 掉旧会话,
  旧 player 的 `stop` 因此早已被调用,「失败分支自己收没收干净」整条契约被彻底盖住。
- **`finalizer` 不 kill 解码器**同样漏了断言(整首播完之后 ffmpeg 会一直烧 CPU)。
- **seek 的负数夹取只测了结果、没测喂给下游的值** —— 这个值一路喂给 `prepareSeek` 与新 ffmpeg 的 `-ss`。
- **fork 下「原地 seek 成功」只断言 seek rpc 打没打出去** —— 把 `if (inPlace) return` 去掉之后
  seek 和 cast 两个 rpc 都会发出去,断言照样绿。
- **「seek 提前掐断管道」只断言 `kill`** —— 旧 finalizer 的 seekReplace 分支也会 kill 同一把解码器句柄,
  真正只有 `seekAirPlay` 会做的是 `destroy` 管道(旧 producer 就靠这一步解除 `waitData` 阻塞)。
- **seek 重建解码器后喂进去的不是合规后的地址** —— 旧 token 可能过期,必须先 `resolvePipelineInput` 重解。
- **seek 复原暂停态只断言 `toHaveBeenCalled()`** —— 暂停期间 `isPaused` 本就是 true,少调那一次
  状态查询照样给出 PAUSED;改成「恰好两次」才抓得住。
- **`hasActiveSession` 的 fork 分支从未被执行过** —— fork 判活必须只读子进程镜像,
  主进程自己的会话表不算数(本轮新增用例的两条断言就是钉这条的)。
- **`stopAirPlaySessionsForHost` 的 host 判空只测了 `""`** —— 只有传 `undefined` 才会撞上
  `host.toLowerCase()` 抛异常,这条变异在 `""` 下是等价的。
- **大小写不敏感那个用例两边都是小写 IP** —— 大小写敏感与不敏感跑出来完全一样。
- **音量/静音的 DLNA 转发只断言「转发被调用」** —— 转发成功后漏掉那句 `return` 时,会多走一步
  `applyVolumeDb` 把音量覆盖成 SET_PARAMETER 的值;只有会话在场时才看得见。
- **`dlnaPeerOfAirPlay` 的两条判据要特定场景才杀得掉** —— 「不判 host」得配一个解析出空主机名的
  `file:///dev` 设备才能暴露;「非法 URL 也放行」得让非法 URL 与**别的主机**同时出现:
  配对错误比不配对更糟 —— 后者是「没调成」,前者是「调到了不该调的地方」。

### 已知问题(本轮只登记,不改产品行为)

- `D31-3`:`control.ts` 里的 `markAirPlayDeviceOfflineInDb()` 是**死代码** —— 整个 `src/` 只有它的定义,
  既没有调用点也没有导出(grep 已确认)。本轮不为死代码补测试,只在变异阶段记录。
- 20 条存活变异里另外 4 条(`M14` `M18` `M22` `M63`)经分析是**等价变异**,不是测试缺口:
  任何测试都无法把它们与正确实现区分开,理由已写在测试文件对应用例的注释里。

## [4.0.51] - 2026-09-28

### 测试

- `backend/tests/dlna/controlSoap.test.ts`(B30 补测):**70 条**。目标 `src/services/dlna/control.ts` —— 按「未覆盖行数 × 可测性」联合排序选中(未覆盖行数全场第一,但未覆盖行里 dlna/upnp/fetch 等 IO 关键字只占 6.9%,是「缺口最大但最好啃」的一个)。
  `control.ts` 里对设备的每一次调用最终都收口到 `soapCall() → 全局 fetch`,所以只要用一个「按 SOAPAction 分发」的 fetch 桩,就能在不碰真网络的前提下跑通整条控制链路 —— 起播四步、就绪闸门、无缝隙预载、TTS 播报、播放三件套、音量与静音、seek、状态采样与位置外推。
- `control.ts` 未覆盖行数(全量口径)**172**;同一 `tests/dlna` 口径做前后对比,本文件单独贡献 **684 → 189** 行。
- `tsc --noEmit` 通过;全量回归 **299 个文件 / 4373 条全绿**。

### 双向证伪变异(20 条,19 条被抓住)

把 `control.ts` 的 20 条契约逐个改坏后重跑本文件,19 条立即让测试转红。首轮存活 9 条,
补强断言后收敛到 1 条。本轮补掉的真实测试缺口:

- **`soapCall` 的 UPnP fault 判据只覆盖了「fetch 直接抛错」那一条路** —— HTTP 200 + 错误体
  (`<s:Fault>` 包壳 / `<errorCode>` 字段)这一路从未被执行过。现在两条判据分别单独立例。
- **`shouldAbort` 在 `castToDevice` 里被查三次**,原先只测了第一处:变异把第一处改掉时,
  第二三处照样抛错,测试照样绿。改用「第 N 次调用才返回 true」的谓词逐一点名。
- **落位校验是 `void verifySeekLanding(...)` 派出的异步协程(内含 `sleep(1200)`)**,
  原先三条相关断言都跑在协程之前就执行完了,等于什么都没测。补了显式等待窗口。
- **探测缓存只测了「支持」那条结论**:`!== undefined` 的缓存语义对「不支持」同样生效,
  补了反向用例;被拒之后的预载也必须彻底关闭,补了「重复调用不再下发第二次」。
- **`SetMute` 的 catch 吞掉异常时「音量没被改」依然成立**,补了显式的 rejection 断言。

### 已知问题(本轮只登记,不改产品行为)

- 20 条变异里唯一存活的 `M14`(`relTime !== "NOT_IMPLEMENTED"` 判据)经分析是**等价变异**,
  不是测试缺口:`parseHms("NOT_IMPLEMENTED")` 返回 0,而 `state.position` 每次调用都从 0 重建,
  「赋 0」与「跳过赋值」在当前代码结构下不可区分 —— 任何测试都无法区分这两者。
  真要让它可测,得先把 `getDeviceStatus` 的返回态改成跨调用复用,属行为改动,本轮不做。

## [4.0.50] - 2026-09-28

### 测试

- 新增 `backend/tests/plugins/discoveryHost.test.ts`(B29 轮):**100 条用例**,把
  `src/plugins/discovery.ts` 从「只有纯函数被单测」扩到整个插件 host 环境面 ——
  http 的 20MB 体积护栏 / songs 脱敏与分词搜索 / playlists 读写与封面兜底 /
  fs 路径穿越 / command 走 execFile 不经 shell / net 与 ws 本机回环 /
  jsenv 嵌套 QuickJS / manifest 必填字段与 longRunning 预算 / 权限自动补齐 /
  reload 覆盖语义 / 重复 discover 不重复注册。
- **双向证伪**:对 `discovery.ts` 打 **15 个变异点**(放开 20MB 阈值、去掉 content-length
  护栏、exec 退回走 shell、去掉路径越界判断、拿掉 base64 编码、同名复用塞假 pid……),
  **15/15 全部被测试杀掉,0 存活**。
- `discovery.ts` 未覆盖行数 **156 → 47**(76.72% → 约 91%);剩余缺口集中在在线补全(IO 型)。
- `tsc --noEmit` 干净;全量回归 298 文件 / 4282 用例全绿。

### 已知问题(本轮只登记,不改产品行为)

详见 `docs/KNOWN_ISSUES.md`,每条都在测试里固化了**现状断言**(修复后该断言应转红):

- **MF-002** `host.net` 注释声称「数据以 base64 传输(二进制安全)」,实际发送端
  `Buffer.from(String(data))` 做一次 utf8 编码、接收端 `msg.toString("base64")` 再编一层。
  纯 ASCII / UTF-8 文本往返确实无损,但插件按注释「用 base64 传二进制」会拿到双层编码的
  文本,非 UTF8 字节则被 utf8 重编码成乱码(mojibake),永久损坏。
- **MF-003** `host.playlists.replaceEntries` 刷新歌单时只从已有行取 `name`,
  `source_platform` / `source_url` / `external_id` 在 UPDATE 里被无条件写回默认值 ——
  前端平台徽标掉成默认、`findBySource` 去重键被清空,同一个远端歌单会重复建。
- **MF-004** `host.command.start` 同名复用分支 `return { name, running: true }` 
  不带 `pid`,调用方无从区分「新起进程」与「复用旧进程」。

## [4.0.49] - 2026-09-28


### 修复

- **MF-001（`src/plugins/sandbox.ts`）：并发调用触发插件沙箱 OOM 自愈时，QuickJS
  teardown 断言 `list_empty(&rt->gc_obj_list)` 直接 SIGABRT 带走整个进程。
  这是 v4.0.48 记录的「偶发」的真身 —— 它从来不是偶发，**必现（5/5）**，
  只是触发条件苛刻：必须**并发**两个调用同时/相继触顶内存上限。

  根因是四层的：`dispose()` 是**同步**的，而 `evalAsync` 的 `promiseHandle` 在其
  `finally`（**异步**）里释放。单发 OOM 时触发方已经 return、句柄已放，teardown 干净；
  并发时另一条仍在途，同步 teardown 会撞上它钉住的 GC 对象。关键证据是插桩时
  `hasPendingJob()` 已经是 `false` —— 残留的**不是 pending job**，
  所以 v4.0.3 那套「排空 pending jobs」救不了它。

  三处加固：`rebuild()` 的 `dispose()` 之前 `await settleHandlers()`（8 个
  `setImmediate`，给所有在途 `finally` 留出释放时间，**真正消除 abort 的那一条**）；
  `dispose()` 里 `oomCleanup` 去掉 `oomFaulty` 守卫改为无条件先排空；
  `evalAsync` 泵循环在沙箱进入 `rebuilding`/`disposed` 时立刻放手。
  中间试过「`oomFaulty` 消费式清零」与「按 `activeCalls` 计数等待」两版，**实测都无效**
  —— rebuild 触发时发起方那条调用自己早已结算并注销了 `activeCalls`，该等的是
  「还有多少 `evalAsync` 的 `finally` 没跑完」，不是「`activeCalls` 是否为空」。

- **影响面**：并发调用一个泄漏插件时，沙箱自愈路径会把宿主进程一起带走，属**进程级**
  故障而非单次调用失败。插件沙箱本身跑在 worker thread
  （见 `docs/PLUGIN_ARCHITECTURE.md`），生产上的实际降级表现为 worker 崩溃，
  是否波及主进程待线上观察确认。


### 测试

- `tests/plugins/sandbox.test.ts` 新增 1 条：`并发 OOM 自愈：SIGABRT 防线`，
  并发发起两个 `leak()`。修复前该用例转红并 abort（**双向证伪通过**），修复后转绿。
- 探针统计：修复前 5 轮 5 次 abort，修复后 5 轮 0 abort；
  基线模式（单发 OOM / 反复 OOM / 重复 dispose）均无退化。
- 全量回归 **297 文件 / 4201 用例**全绿，`tsc --noEmit` 干净。

- **遗留（不追）**：全量里另有 3 次**确定性** abort，但不在 OOM 路径
  （`加载失败后仍可继续加载其他插件(模块不毒化)`、`SANDBOX_WORKER_DISABLE=1 时回退主线程` ×2），
  且 WASM 层 SIGABRT 之后 **worker 存活、用例通过、退出码 0**。
  试过「dispose 时释放 `this.shared` 里的 `ctx.null`/`hTrue`/`hFalse`」，
  专项连跑 3 轮 abort 数纹丝不动，故该改动已回滚、不留代码。
  已记入 `docs/KNOWN_ISSUES.md` MF-001 遗留观察②。


### 新增文档

- `docs/KNOWN_ISSUES.md`：项目级**已知问题台账**，登记工程/运行时类缺陷
  （UI/UX 类见仓库根 `AUDIT.md`）。首批登记 MF-001 的完整根因链、修复与验证。
## [4.0.48] - 2026-09-28

### 测试

- **补测第十五轮（B28：新增 3 个测试文件 / +59 用例）**，双向证伪 17 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- `src/services/source/online/streamFallback.ts`（行 88.36% → **98.74%**，函数 100%）：
  这个文件决定了「一首 web 歌的直链挂了之后，还能不能换到别的平台」。本轮钉的是
  **三道结构性短路与缓存收尾**：正/负缓存命中必须零搜索、缺标题/总开关关/解析不出
  provider 三处判死的口径（总开关关时**不写**负缓存，否则开关一开仍被误判没源）、
  全候选不可播时 `transient` 与 `unplayable` 的分岔（只有 `sawTransient` 这一个比特
  在区分「上游挂了」和「这首歌没有源」）、`clearFallbackCache` 定向清与全清的边界
  （前者只清换源记忆、后者连可播记忆一起清）、两个 FIFO 上限（2000 / 5000）必须真的生效。

- `src/services/sendspin/handshake.ts`（缺口 28 → **6**，行 98.37%）、
  `src/services/sendspin/supervisor.ts`（缺口 24 → **2**，行 96.08%）：
  见两文件的提交说明。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `source/online/streamFallback.ts` | 行 88.36% → **98.74%** | 函数 100%，止于 2 处死 catch |
| `sendspin/handshake.ts` | 缺口 28 → **6** | 行 98.37% |
| `sendspin/supervisor.ts` | 缺口 24 → **2** | 行 96.08% |

- 本轮自身新增覆盖约 **102 行**；总体 `未覆盖 8030 / 65406 行（87.72%）`。
- 全量回归 `297 个测试文件 / 4200 用例` 全绿，`tsc --noEmit` 0 错误。

- **两条不可证伪，已写明原因而非含糊放过**：`recheckOnlineDirect`(309-310) 与
  `resolvePreferredStreamUrl`(514-515) 的 catch 包着的都是全函数（probe /
  resolvePreferredSong 各自还有一层同款 try），构造上抛不出来。不编假异常刷行覆盖率，
  改为在测试里把「上游不抛」本身钉成断言并留档。

- **两条等价变异已剔除并留档**：`464` 行写回条件里的「≠ 原 URL」判断（去掉后写的仍是
  同一个值，库里逐字节不变）、`defaultStreamProviderId` 行无 pluginEntry 时的启用源插件
  扫描（结果会被 `resolveStreamProvider` 的兜底分支立刻重算，对外 URL 一字不差）。

- **发现（`tests/plugins/sandbox.test.ts`，未改动）**：quickjs 沙箱 OOM 自愈用例偶发
  `Assertion failed: list_empty(&rt->gc_obj_list)`，会直接 abort worker 让整轮全量拿不到
  汇总行。单跑三次挂一次、与被测改动无关（本轮两次全量，一次全绿一次被它带崩）。
  看起来像沙箱在内存压力下 `free` 时的引用计数漏检，属既有问题，留档待议。

## [4.0.47] - 2026-09-28

### 测试

- **补测第十四轮（B26：新增 2 个测试文件 / +36 用例）**，双向证伪 20 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- 本轮改挑「**未覆盖部分全是降级 / 回退 / 兜底路径**」的小文件簇，而不是继续啃
  `streamEngine.ts`（余下 45 行全在 `GroupPump.pushLoop` 内部，要真泵 + 真 WAV 才驱动得动）。
  这类分支正常环境永远走不到，只有「库坏了 / 设备禁用了 / 已被拒绝过 / 浏览器构造失败」
  才生效 —— 最容易被写成「看起来对、真出事时是错的」。

- `src/services/sendspin/discover.ts`（缺口 30 → **0**，行/语句/函数 100%）：
  文件头记着 2026-09-25 真机定位的两个致命缺陷，本文件即修法，现逐条钉住：

  - **发现即写**：设备开机那一瞬（IP 刚拿到、:8928 还没 listen）拨号必然 `EHOSTUNREACH`，
    以前却在「拨成功之后」才记忆 ⇒ 一次失败 = 永久失联（实测 `.245` 开机后 38 分钟无人理它）。
  - **库级永久装聋**：bonjour-service 的 PTR 查询只发一次、`_services` 只增不减、对已知 fqdn
    永久去重，而 ESPHome 设备开机只广播一次 ⇒ 必须自己**周期重建 browser** 造节拍，并提供
    `refreshPlayerDiscoveryNow` 让音流的等待阶段能主动催一次（含 5s 节流）。
  - 重建期间的**迟到回调必须丢弃**（它属于上一个 browser 实例）；四道闸门（端口合法性 /
    已禁用 / 抑制期 / 已在线）逐条验证；入册失败只记 warn、**不冒泡**；`pickIPv4` 的两轮
    扫描顺序（IPv4 字面量优先于排在它前面的主机名）。

- `src/services/airplay/session.ts`（缺口 19 → **0**，行/语句/函数/分支全 100%）：
  注册表**必须**落 SQLite（fork 模式下 token 在主进程 mint、子进程经回环 URL 消费，内存 Map
  跨进程不可见 —— 2026-09-19 事故的同一条教训）；但「必须落库」不等于「库不可用时投屏整体
  失败」。两套状态并存且解析时**先内存后库**，故由单测把库打坏来验证：内存复用与续期、
  过期返回 null、库里已有会话复用（每次投流 mint 新 token 会让设备侧 mediaUri 变化 → 被
  误判成换歌而自动切下一首）、过期行**先删再返回**、库查询抛错吞掉不甩给投屏链路。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/discover.ts` | 30 → **0** | 行/语句/函数 100% |
| `airplay/session.ts` | 19 → **0** | 行/语句/函数/分支 100% |

- 本轮自身覆盖 **49 行**；总体 `未覆盖 4100 → 4103`（87.46% → 87.45%）—— 净变化被
  `dlna/discovery.ts` 的 **+48 行回落**抵消，见下方说明，**不是代码回退**。
- 用例总数 4053 → **4089**（292 个测试文件），全量回归全绿，`tsc --noEmit` 0 错误。

- **发现（未改动，留档）**：`dlna/discovery.ts` 的 `toAbsolute` / `fetchDescription`
  （41–88 等 48 行）只有在**真实局域网 DLNA 设备响应 SSDP** 时才会被执行 —— 本轮两次全量
  覆盖率结果完全一致（62），而此前四轮稳定在 14，差异来自该设备（HiVi，192.168.10.30）
  当前不可达。即：**本地覆盖率数字里约 48 行由真机撑着，CI（无 DLNA 设备）根本不会有**，
  本地与 CI 的覆盖率不可直接比较。是否要把这条路径改成密闭桩（本地 HTTP server 喂
  description.xml）另议，本轮未动。

- 证伪的 20 项分支：browser 的周期重建与停止、主动催的未启动 / 节流两道、`Browser` 构造失败
  留痕、迟到回调丢弃、`pickIPv4` 两轮扫描、四道拨号闸门、入册来源与「已有窗口不重置」、
  入册失败留 warn、内存回退的登记与复用、DB 会话复用、过期判定与过期行删除、库查询抛错兜底。

- **两条不可证伪，已写明原因而非含糊放过**：过期内存 token 的 `delete` 是纯回收（同一分支已
  判过 `expiresAt`，键此后不可能再被命中）⇒ 等价变异；`D2 / D6` 首版是**弱断言导致的假绿**
  —— 前序用例在假时钟下把 `lastOpenAt` 留在「未来」，相对推进几秒追不上，会被节流分支先挡下；
  两轮扫描需 IPv4 排在主机名之后才区分得出。均改成能真正区分的形状后重验通过。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.46] - 2026-09-28

### 测试

- **补测第十三轮（B25：新增 1 个测试文件 / +19 用例）**，双向证伪 22 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- `src/services/sendspin/playerCore.ts`（缺口 47 → **0**，421 行全覆盖）：
  既有 `pumpHandover.test.ts` 是**集成式**的（真起 server + 真泵 + 真 WAV），够得到
  `handoverCore` 本体，却够不到下面这几块 —— 它们全是「登记 / 消费 / 回退 / 还原」这类
  **一次性状态机**分支。新增 `playerCoreUnits.test.ts`，把 `streamEngine`（泵四件套）、
  `deviceState`（落库）、logger 全部换成受控替身，不碰真实 server：

  - **借流登记的一次性与 TTL**：武装 → 起播之间隔一次调用，登记必须**一次性作废**，且
    15s TTL 过期即作废 —— 否则一次失败的武装会污染很久以后的同目标起播，把一条不属于
    本次的流搬过去（落点 / 归属全错）。
  - **歌不同必须在登记层就放弃**：不能指望移交层兜 —— 那层比的是「源端此刻在播什么」，
    源端若也换成本次要播的这首歌就会放行。用例刻意把两层的判定结论做成**相反**，使「登记层
    放弃」与「移交层放行」在行为层可区分。
  - **移交失败一律静默回退完整起播**：只打日志、不抛 —— 否则流转播放断在半路。
  - **起播 / 播报失败后的现场还原**：用户组后台起播失败要清组当前曲并回调上抛（不 throw，
    不阻塞调用方）；播报失败要把临时改过的连接音量 / 组音量还原，并**补发一次音量命令** ——
    还原是绕过 `setVolumeCore` 的直接赋值，不补发设备就永远停在播报音量上。
  - `seekCore` 三条走向：空闲（无在播）只记忆起播位置；**起播窗口内绝不起第二个 play**
    （两个 play 会各自 `++epoch` 后互掐对方刚建好的窗口，存活者拿到零输出窗口被当成播完
    → IDLE → stalled → 从 0 重投）；`ug:` 前缀走用户组完整起播。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/playerCore.ts` | 47 → **0** | 421 行全覆盖 |

- 总体行覆盖率 **87.33% → 87.46%**（未覆盖 4145 → 4100 行，本轮吃掉 45 行）。
- 用例总数 4034 → **4053**（290 个测试文件），全量回归全绿，`tsc --noEmit` 0 错误。

- 证伪的 22 项分支：`ephemeralGroup` 缓存与缺省字段、借流登记的一次性作废与 TTL、歌不同的
  登记层放弃、`playCore` / `playGroupCore` 借流成功的早返回、两处借流放弃日志、用户组成员
  按在线连接过滤、用户组后台起播失败清状态与回调上抛、`stopCore` 停泵与位置归零、
  `seekCore` 空闲 / 起播窗口 / `ug:` 三条走向与无 server 时夹 0、播报失败还原连接音量与组
  音量、补发音量命令、原样上抛。

- **两条不可证伪，已写明原因而非含糊放过**：`stopCore` 的那条 else 兜底（`srv` 为空时
  `srv?.clients` 直接短路、非空时 `group()` 恒返回组 ⇒ 无副作用，断言咬不住）；E5 首版是
  **等价变异**（`handoverCore` 自身也判歌），已改成在行为层可区分的形状重验通过。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.45] - 2026-09-28

### 测试

- **补测第十二轮（B24：新增 1 个测试文件 / +44 用例）**，双向证伪 23 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。

- `src/services/sendspin/protocolPlayer.ts`（缺口 176 → **0**，266 行全覆盖，行/语句/函数 100%）：
  既有 `protocolPlayer.test.ts` 是**集成式**的（真起 sendspin server），只够得到 in-proc 主路径，
  **fork 模式 / 用户组 player / resume 冷起播三块一行没覆盖**。新增 `protocolPlayerUnits.test.ts`，
  把 index.js、playerCore、supervisor、GroupManager、QueueController 全部换成受控替身，专攻这三块 ——
  而它们恰好是注释里记着三次真机事故的地方：

  - **2026-09-17「点播放没声音」**：`resume()` 只调 `pump.resume()`，没走 `playMedia` ⇒ 没有
    `stream/start`、没有 pump、全链路静默（对照 DLNA：它的 resume 就是 `playDevice()` = 真起播，
    所以 DLNA 从未暴露这个缺口）。现由「冷起播必须走 playMedia」钉死，**in-proc / 用户组 / fork
    三种入口各一条**，另加两条兜底：`pumpActive` 探测本身失败时按「不在推流」处理、队列无当前曲
    时留痕放弃而不是硬闯。
  - **2026-09-21 子进程心跳停摆 95s**：`pollState` 把「探不到」谎报成 IDLE，凭空造出
    PLAYING→IDLE 迁移 ⇒ tracker 判自然结束 ⇒ 位置归零、曲目乱跳。现由「必须标 `unavailable`」
    钉死（**用户组 / proxy 各一条**）—— 标记后由 QueueController 决定不喂 tracker、不计数。
  - **起播上报必须走 `setTimeout(0)`**：同步上报会被 `resetTracker` 清掉 lastPlaying ⇒ 短于轮询
    间隔的曲目永远触发不了自然结束、队列卡死。现断言「同步阶段未上报、宏任务之后才上报」。

- 顺带钉住的判定口径：在线与否一律按**连接派生**判定（client 不在列表 / `ready === false` 即不可用，
  此时 cast 会投进 ephemeral 组——没声音却显示“在播”，是最坏的一种错）；组成员按 `ready` 过滤；
  命名空间写法与裸写法都认作 sendspin、dlna 成员一律排除；组音量先落 `player_groups`（无成员也持久）
  再下发，且**落库失败不挡下发**；起播前先灌持久音量（否则起播瞬间跳回缺省 100）。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/protocolPlayer.ts` | 176 → **0** | 266 行全覆盖；行/语句/函数 100% |

- 总体行覆盖率 **86.81% → 87.33%**（未覆盖 4314 → 4145 行，本轮吃掉 169 行）。
- 用例总数 3990 → **4034**（289 个测试文件），全量回归全绿，`tsc --noEmit` 0 错误。

- 证伪的 23 项分支：模式分派、单设备在线判定、组成员 ready 过滤、组不存在 / 无 sendspin 成员 /
  前端未起三种空返回、无在线成员拦截、起播前灌持久音量、回填失败不挡起播、resume 探测 pump、
  stop / pause 的 opcode、组音量落库失败不挡下发、isAvailable 探测失败回落、组与 proxy 两处
  `unavailable` 标记、组 seek 边界日志、proxy seek 失败留 warn 并抛出、in-proc 冷起播、
  冷起播补全元数据、无当前曲留痕、起播上报 duration。

- **证伪脚本新增多行锚点支持**：`unavailable = true;` 这类短句在组 player 与 proxy 各出现一次，
  单行 stripped 匹配必然撞车 —— 改为按**连续行块**定位，命中次数仍必须恰好为 1。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.44] - 2026-09-28

### 修复

- **D35：ffmpeg 二进制定位三处实现、两种口径 —— AirPlay 侧忽略 `FFMPEG_PATH`（P3，已修）**。
  全仓原本有 3 处 ffmpeg 定位实现：`transcode.ts` `resolveFfmpeg()`、`sendspin/encoding.ts` `ffmpegBin()`、
  `airplay/decoder.ts` `ffmpegBin()`。前两处口径一致（FFMPEG_PATH → ffmpeg-static → PATH），
  **唯独 `airplay/decoder.ts` 是反的**：先 `require("ffmpeg-static")`，取到就直接 return，
  `FFMPEG_PATH` 只在内置取不到时才兜底 —— 且与它自己文件头注释写的顺序相反。

- 后果：运维注入 `FFMPEG_PATH` 后，转码 / Sendspin / 离线测量三条链路都换成注入的 ffmpeg，
  **唯独 AirPlay 投播仍走内置 ffmpeg-static**。而 `dlna/control.ts:644` 的注释指出 ffmpeg-static 是
  **glibc 静态构建，在 Alpine（musl）容器里 NSS/DNS 不可用** —— 也就是说「用环境变量换掉静态构建」
  这个逃生舱，在最需要它的 AirPlay 路径上不生效。

- 修法：删掉 `sendspin/encoding.ts` 与 `airplay/decoder.ts` 里各自重复的 `ffmpegBin()`，连同
  `sendspin/streamSource.ts` 的调用一并改为 import `transcode.ts` 已导出的 `resolveFfmpeg()`，
  口径统一为 **FFMPEG_PATH → ffmpeg-static → PATH**。`decoder.ts` 里只服务于该函数的 `createRequire`
  一并删除（`encoding.ts` 的保留，`@discordjs/opus` 还在用）。**行为变更**：AirPlay 在注入
  `FFMPEG_PATH` 时会从内置切到注入版本（这正是本缺陷要的效果）；未注入时行为不变。

- 统一后由三处用例共同钉住同一份实现（`tests/airplay/decoderProducer.test.ts` /
  `tests/sendspin/encoding.test.ts` / `tests/services/transcode.test.ts`）：改一处，三条链路同时转红。
  双向证伪新增 T1（`FFMPEG_PATH` 不再优先）/ T2（PATH 兜底名被改写）两处变异，均被咬住。

### 测试

- **补测第十一轮（B23：新增 2 个测试文件 + 扩写 1 个，+71 用例）**，双向证伪 20 处定向变异全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。本轮按「逻辑型优先、IO 型降级」挑的两个目标都是
  **纯编码/缓冲逻辑，无网络** —— 而且正是 2026-09-17 三次无声事故的核心代码：

- `src/services/airplay/decoder.ts`（缺口 39 → **0**，行/语句/函数 100%，分支 93.33%）：新增
  `decoderProducer.test.ts`，覆盖此前**一行没测**的 `makeProducer` —— 有界 PCM 环形队列这一层。
  钉住：预填充没攒够时首拉**不返回**（只来一点点数据就立刻吐 chunk 会把发送端饿到，直接表现为卡顿/无声）、
  缓冲到高水位 pause ffmpeg stdout、掉到低水位 resume（背压不丢数据、不跳音频）、预填充 30s
  等不到就放弃且不无限挂住、拉空后再来数据要等一轮而不是立刻返回 null、大块缓冲的压实、
  流结束后把尾部残余吐干净、end 之后 done 闩住。

- `src/services/sendspin/encoding.ts`（缺口 167 → **38**，行 94.20%）：新增 `encodingFrameSplit.test.ts`
  （34 例），**按 RFC 9639 手工位流造真实 FLAC 帧**（不是拿固件糊弄），把 2026-09-17 的决策性分支
  逐条钉死：声道码必须按 4bit 取（按 3bit 截会把立体声读成单声道 —— 那次最致命的一条）、残差方法 2
  （保留值）整帧判废、联合立体声按 2 子帧算、首分区要减掉预测阶数、wasted 吃光位深判废、
  容器头偏移量回填、`codec_header` 置 last-metadata 位、元数据块遍历在 last 处收尾。
  另补 `OpusEncoder`（此前一行没测），`encoding.test.ts` 15 → 33 例。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `airplay/decoder.ts` | 39 → **0** | 行/语句/函数 100%；分支 93.33% |
| `sendspin/encoding.ts` | 167 → **38** | 行 94.20%；剩余为常量与兜底分支 |

- 总体行覆盖率 **86.29% → 86.81%**（未覆盖 4487 → 4314 行，本轮吃掉 173 行）。

- 证伪的 11 项 decoder.ts 分支：音量钳制、0 档静音、通道开关、ffmpeg 非零退出留日志、背压水位、
  低水位 resume、预填充循环、预填充超时返回 null、尾部残余吐出。
- 证伪的 11 项 encoding.ts 分支：首分区减预测阶数、残差方法 2 判废、联合立体声子帧数、声道码 0
  取流缺省、wasted 判废、声道码 4bit、容器头偏移、`codec_header` last 位、元数据块 last 收尾。

- **识别出 4 处不可证伪的变异并说明原因**（不是含糊放过）：A6 是等价变异（`>=` 与 `>` 在该处
  产出同一个 chunk）；E2 是不可达分支（`n < 0`，`firstPartition` 上一行已判过、`perPartition` 是右移
  恒非负，属防御性冗余）；E3 / E4 是我误记的锚点（一处漏了行尾注释、一处源码里根本没有该分支），
  已从证伪集剔除并注明。

## [4.0.43] - 2026-09-27

### 测试

- **补测第十轮（B22：扩写 2 个已有测试文件 / +40 用例，合计 43 例）**，双向证伪 23 处定向变异（10 处 control.ts +
  13 处 deviceState.ts）全部咬住，摘掉被测分支后对应用例立刻变红，恢复后转绿。本轮两个目标都是 Sendspin 的
  「控制面 / 持久化面」—— 播控指令与实际设备状态都经这两处落地：

- `src/services/sendspin/control.ts`（缺口 39 → **0**，行/语句/函数 100%，分支 96.96%）：原文件只有 53 行 3 例，
  只测了 `listSendspinPlayers`，真正掷出声音的 `castSendspin` / `controlSendspin` **一行没覆盖**。补齐后钉住：
  服务未启动时先拉起、曲库查不到直接拦、空标题兜成「未知」、空合作者/封面/时长一律不喂给播放器（脏 duration 不转数字）、
  `mime` 固定 `audio/mpeg`、取不到 player 时不硬闯、`play` 落到 `resume` 而非 `stop`、`seek` 缺省按 0 计、
  未支持的 action 显式抛错（而不是静默返回 null）。

- `src/services/sendspin/deviceState.ts`（缺口 30 → **0**，行/语句/函数 100%）：新增一整组 12 例，钉住模块顶部那句约定
  「读失败一律回退（无行 / null），绝不阻断播控热路径」。把 `sqlite.prepare` 整个打成抛错，逼所有 catch 走一遍，
  确认：读音量失败回 null 且留 warn、列禁用设备失败回空数组、删除设备行的失败不影响后续清理、清改名/隐藏偏好的那一步
  炸了也不能回滚已经删掉的设备行、写失败留下的 warn 带 `[device-state]` 标识（区分「写」与「读」两类失败）、
  读禁用态失败按「未禁用」回落、读凭据失败回空凭据、查禁用 host 失败按放行回落。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `sendspin/control.ts` | 39 → **0** | 行/语句/函数 100%；分支 96.96% |
| `sendspin/deviceState.ts` | 30 → **0** | 行/语句/函数 100% |

- 证伪的 10 项 control.ts 分支：服务未启动是否拉起、曲库查不到是否拦截、空标题兜底、mime 是否固定、duration 是否做类型
  判定、两处 player 取用是否拦住、`play` 的分派目标、seek 缺省值、未支持 action 是否抛错。
- 证伪的 13 项 deviceState.ts 分支：读音量失败回退、读失败留 warn、列禁用失败回退、列禁用失败留 warn、删行失败留 warn、
  清偏好失败的 warn 标识、读禁用态回退、写音量失败留 warn、读凭据失败回退、查禁用 host 失败回退、写 host 失败留 warn、
  写 ESPHome 失败留 warn、写禁用态失败留 warn。

- `deviceState.ts` 剩余未覆盖分支集中在持久化失败的 catch 侧（65.34% 分支），均已被上面 12 例按「回落 + 留 warn」逐个钉死，
  属 catch 内部的分支差分，非真实缺口。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.42] - 2026-09-27

### 测试

- **补测第九轮（B21：2 个新测试文件 / 56 个新用例）**，双向证伪 23 处定向变异（10 处 childHost + 13 处 reclaim）全部咬住，
  摘掉被测分支后对应用例立刻变红，恢复后转绿。本轮两个目标都属于「平时不出声、出声就说明有东西坏了」：

- `src/services/rendererHost/childHost.ts`（缺口 24 → **0**，行/语句/函数 100%，分支 92.1%）：
  子进程侧常驻控制器，用 in-proc 驱动同一套 handler（不真 fork），保证测试路径 = 生产路径。钉住：
  快照节流（业务状态可能每帧都脏，但绝不能每条都往主进程推）、force 顶掉已挂起的节流器且不让旧定时器补推、
  dispose 时把还挂着的定时器一起清掉；以及心跳里的**事件循环卡顿自检** —— 240 上实锤过 sendspin 子进程
  65s 零消息后被 SIGKILL，若事件循环根本转不动则事后查无实据，因此心跳迟到超 15s 必须留一条带 mem/rss 的 ERROR，
  而这条日志自己写不出去时也不能连累心跳继续上报。

- `src/services/memory/reclaim.ts`（缺口 20 → **0**，行/语句/函数 100%，分支 94.44%）：钉住空闲判定的四条闸门
  （开关关闭 / 有批量任务 / 阈值边界取 `>=` / 脏值退回默认 5 分钟且按整数算），L2 主动 GC 的 5 分钟节流与
  「只有手动「立即回收」才无视节流」，L3 checkpoint 的 30 分钟节流，注册的清理回调单个抛错不阻断其余，
  以及磁盘只读这类异常下 checkpoint 静默失败、不影响 L1 已经清掉的事实。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `rendererHost/childHost.ts` | 24 → **0** | 行/语句/函数 100%；分支 92.1% |
| `memory/reclaim.ts` | 20 → **0** | 行/语句/函数 100%；分支 94.44% |

- 证伪的 10 项 childHost 分支：兜底扫是否推快照、脏标记是否写入、force 与挂起节流器的关系、dispose 是否清定时器、
  心跳的 `lastBeat` 记账、心跳缺省周期是否取自协议常量、卡顿日志的 catch 兜底、非 Error 抛出的文本规整、
  `ok:true` 应答里空 result 是否写 `null`、`op` 是否规整成字符串。
- 证伪的 13 项 reclaim 分支：回收开关、批量任务短路、空闲边界 `>=`、`v > 0` 的脏值兜底、清理回调的 try/catch、
  回调清单是否留名、vm 探测的脚本内容、GC 节流与记账、checkpoint 节流与记账、`registerCacheCleaner` 的函数校验，
  以及 `manual` 强制跳过节流的实际范围。

- 剩余未覆盖分支经核对为 v8 计数噪声（`finally` 块归属、默认参数与探测记忆的短路侧），非真实缺口。
- 本轮无产品行为改动，未新增缺陷备案。

## [4.0.41] - 2026-09-27

### 测试

- **补测第八轮（B20：2 个新测试文件 / 41 个新用例）**，同样逐条双向证伪——
  摘掉被测分支后必须立刻变红，恢复后转绿。本轮两个目标都属于「一处写错、波及一片」的共享层：

- `src/services/plugin/importers/http.ts`（**全部导入插件共用**的 HTTP 工具层）：
  `fetchJson` 的非 2xx 抛错、UA 与自定义头的合并、超时中断真的掐断上游；
  `resolveRedirect` 展开重定向后取最终 URL、`res.url` 为空时回落输入、以及**任何失败都不抛**。
  额外钉住一件平时不会暴露的事：`finally` 里的 `clearTimeout` —— 漏掉它用例不会红，
  但每个导入请求都会漏一个常驻计时器。

- `src/routes/api/stream.ts`（`POST /v1/stream/probe`）：入参校验与 `MAX_PROBE_BATCH` 截断、
  无需联网的直达分支（本地 / 已缓存行）、web 歌解析出直链时的 `fallback` 标记，
  以及 `ensurePlayableStream` 返回空时那 **四档 verdict**（unplayable / playable / transient / unknown）。
  其中「别把网络抖动当死链」是断言的重点：探测未定时必须如实报 `transient`，不能判成不可播。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `routes/api/stream.ts` | 24 → **0** | 行/语句/分支/函数均 100% |
| `plugin/importers/http.ts` | 30 → **0** | 行/语句/函数 100%；分支 90.9% |

- `http.ts` 分支那 1 处（10 个分支里 9 个已覆盖）经核对是 v8 对 `finally` 块归属的计数噪声，
  不是真实缺口：真实分支（默认参数两侧、`res.url || url` 的两侧、`catch` 的两条出口）都已覆盖。

- 双向证伪共 10 处变异，全部咬住：type 缺省兜底值、`cachePath` 的本地判定、`fallback` 标记、
  四档 verdict、`reason` 截到 120 字、`MAX_PROBE_BATCH` 截断、非 2xx 抛错、`res.url` 兜底、
  `catch` 回落、以及 `finally` 的 `clearTimeout`。

- 顺带固化一条容易被误读的现状：`String(e?.message || e)` 在 `message` 为空串时会退到 `String(e)`，
  于是探测失败原因显示成 `Error` 而不是空串。不影响可用性，仅备案。

## [4.0.40] - 2026-09-27

### 测试

- **补测第七轮（B16~B19：5 个新测试文件 / 100 个新用例）**，每条用例都做了**双向证伪**——
  摘掉被测分支后必须立刻变红，恢复后转绿，否则不算数。
  本轮继续按 lcov 缺口榜挑**逻辑型**模块，IO 型协议栈（`services/dlna/*`、`services/airplay/*` 的 socket 层、
  `services/sendspin/*` 的流式引擎）维持既有原则**明确降级**，不为了覆盖率数字去 mock 出一批假 IO。

- `services/audio/flow.ts` 的唤醒通道选择 + `services/randomSongs.ts` 配置容错：
  唤醒通道的优先级与「进程级节流」、等待阶段抛错的兜底；配置侧的坏 JSON / 越界数值 / 空白归一 / 年份交换等脏输入
  （`tests/services/flowWakeTargets.test.ts` 13 条 + `tests/services/randomSongsConfig.test.ts` 12 条，25 例）。

- `services/plugin/renderers/supervisor.ts` 渲染器宿主的分支（12 例）+ `routes/api/shared.ts` 共享查询分支（7 例）。

- `src/services/source/online/recommendImport.ts` 每日推荐导入的分支 + `src/services/ws/auth.ts` 握手鉴权，46 例：
  `recommendImport.ts` 用「真实插件 + 真实 SQLite」的姿势（只替换远端封面缓存与批量节流两个副作用面），
  把原本 50 个未覆盖行压到 11；`ws/auth.ts` 打真实 JWT 验签与真实库用户，行/语句/分支/函数**全部 100%**。

- `services/airplay/protocolPlayer.ts` + `services/sendspin/pairServer.ts`（25 例）：
  `protocolPlayer.ts` 此前**从未被任何测试 import 过**（整块 27–75 行零覆盖），本轮直接补到 100%；
  `pairServer.ts` 走真实 CPace 双端对跑（服务端起 PAKE、客户端真 derive/verify），把缺口从 71 行压到 24 行。

### 覆盖率提升（未覆盖行数）

| 文件 | 补测前 → 补测后 | 备注 |
| --- | --- | --- |
| `services/ws/auth.ts` | 24 → **0** | 行/语句/分支/函数均 100% |
| `services/airplay/protocolPlayer.ts` | 45 → **0** | 行/语句/分支/函数均 100% |
| `services/plugin/renderers/supervisor.ts` | 38 → **0** | 行覆盖缺口归零 |
| `services/sendspin/pairServer.ts` | 71 → 24 | 剩余 24 行经 9 处变异逐条证伪为**死分支** |
| `services/source/online/recommendImport.ts` | 50 → 11 | 剩余缺口为上游重试的等待段 |

- 剩余 24 行的「死分支」结论不是靠读代码猜的：逐处变异（把恒假的守卫改成恒真、把空转的 `catch` 摘掉、
  把永不成立的写入条件改成成立）后，用例**全部仍然全绿**——这些行无论怎么改都不可能被照到，
  属于协议里本就不存在的路径（见下方 D31~D34）。

### 本轮补测暴露、但**未修**的缺陷（仅记录）

全部已固化成「现状」用例双向锁死，修复计划见 `产品缺陷修复任务-2026-09-27.md`，此处仅备案：

- **D27 / D28（P3）**：「每日推荐」导入未带 `userId` 时 `owner_id` 写空串 ⇒ 撞外键整单失败；
  歌单名为空时**落库兜底成「每日推荐」、返回值却是空串**。
- **D29（P2）**：轮换删除的闸门永假——`old` 列表在导入**之后**才取全表，本次新单被算进 `oldByChannel` 的分母，
  `n >= m + n` 恒假 ⇒ 远端已下架的旧歌单只增不减。副作用是它内部的 `try/catch` 与 favorite 跳过分支在修复前不可达。
- **D30（P2，安全）**：静态配对码「失败 5 次锁定」实质不可达——首次 confirm 不符就 `abort()` 删掉 attempt，
  `failures` 恒为 1 ⇒ `locked()` 恒假 ⇒ 8 位码可被离线无限枚举。
- **D34（P2，协议死锁）**：`dynamic_pairing_code` 的日常时序走不通——`onPairInit` 要求 `await_init` 状态，
  重发的 `client/pair-init` 被直接 return；反过来「先输码再 init」能触发 PAKE，但 `nonce_A` 每次 init 都重新随机，
  服务端比对的码基线失配。
- **D31 / D32 / D33（P3，死代码）**：`waitForCode()` 全仓无调用点；`pendingFinalize` 的写入条件与读取前置条件互斥；
  三处 `b64urlDecode` 的 `catch` 永不触发（`Buffer.from(x, 'base64url')` 不抛错，非法输入由长度检查兜底）。

## [4.0.38] - 2026-09-27

### 测试
- **补测第六轮（B12~B14：11 个新测试文件 / 265 个新用例，全部断言「现状」而非期望契约）**：
  按 lcov 未覆盖行清单优先补「逻辑型」模块 —— IO 型链路（`services/dlna/*`、`services/airplay/*`、
  `services/sendspin/*`）明确降级，不为了数字去 mock 出一堆假 IO。
- 行覆盖率提升（补测前 → 补测后，未覆盖行数）：
  - `services/plugin/renderers/airplay.ts` 43.06% → **100%**（41 → 0）
  - `services/plugin/renderers/dlna.ts` 48.57% → **100%**（36 → 0）
  - `services/source/preferredSource.ts` 50.63% → **100%**（39 → 0）
  - `services/playlist/autoMatch.ts` 64.37% → **100%**（31 → 0）
  - `services/content.ts` 66.67% → **100%**（31 → 0）
  - `services/plugin/randomSongs.ts` 85.58% → **100%**（45 → 0）
  - `services/plugin/localPlatformRecommend.ts` → **100%**（分支 89.65%）
  - `middleware/metrics.ts` → **100%**（分支 83.33%）
  - `services/playlistCover.ts` 80.29% → **98.08%**（41 → 4）
  - `services/backfill.ts` 77.09% → **98.32%**（41 → 3）
  - `services/plugin/localRecommend.ts` 79.85% → **97.79%**（82 → 9）
  - `services/flows/index.ts` 未覆盖行 60 → 41
- 新增测试文件：`plugins/renderersPlugin`、`services/contentUnified`、`services/playlistAutoMatch`、
  `services/preferredSource`、`services/randomSongsEngine`、`services/playlistCoverStore`、
  `services/localRecommendEngine`、`services/backfill`、`services/flowsCrud`、
  `services/localPlatformRecommend`、`middleware/metrics`。

### 修复
- **歌单新建 id 撞主键（P2）**：新建歌单的 id 直接取裸毫秒时间戳（`"pl-" + Date.now()`，共 4 处），
  同一毫秒内建两张歌单就撞 `playlists.id` 主键 → **导入/创建直接抛**
  `SqliteError: UNIQUE constraint failed: playlists.id`。触发面：批量导入多张歌单（导入循环里
  每张一次 insert）、并发导入（自动同步 + 手动同步同时跑）、OpenSubsonic 客户端连点「新建歌单」。
  **本版 CI 的全量测试门禁就是被它打红的**（269 个文件里 `tests/batch/jobsBehavior.test.ts` 的
  「首次导入」用例偶发失败 —— 快机器上 `Date.now()` 连续两次取到同一毫秒太容易了）。
  4 处统一加 4 位 base36 随机后缀（与 `recommendImport.ts` 既有写法完全一致）：
  `batch/jobs.ts`（URL 歌单导入）、`services/plugin/remoteImport.ts`（插件远程导入）、
  `routes/rest/index.ts`（OpenSubsonic `createPlaylist`）、`routes/api/playlists.ts`（歌单文件
  导入的多张循环）。id 仍是 `pl-` 前缀的不透明字符串 —— 已确认全仓没有任何代码/测试解析
  `pl-<数字>`（只按字符串相等或前缀使用），故对外契约零变化。
  回归防线：`tests/batch/jobsBehavior.test.ts` 新增用例，用 `vi.spyOn(Date, "now")` 把两次
  导入钉在同一毫秒；**回滚修复后该用例立刻复现同一条报错，恢复修复后转绿**（双向证伪）。

### 说明
- 补测过程中新发现的 P3 仍**按约定挂起待确认**，只在测试里以 characterization 用例把现状钉住，
  每条都注明「修复后该断言应翻成什么」：`D17` 本地推荐口味路径忽略 `excludeRecent`、
  `D18` 全库随机 rowid 过采样在「库容接近 count」时少 1~2 首、
  `D19` 播放后自动匹配把底层失败回报成 `lockTimeout` 且不留错误日志。

## [4.0.36] - 2026-09-27

### 测试
- **补测第五轮（B5~B11，8 个提交 / 11 个新测试文件 / 454 个新用例）**：全部针对「拆分与重构之后尚无任何测试照到」的模块，
  让这些模块的行为第一次被钉住（而不是为了刷覆盖率数字）：
  - `routes/api/peers.ts`（124 例）+ 可复用 peers 假体、`routes/api/shared.ts` 运行时助手（26 例）；
  - `routes/api/recommend.ts` 与每日推荐路由层（69 例）→ 行 **100%**、分支 82.5%；
  - `services/dlna/announce.ts` 播报编排（29 例）→ 行 60.2% → **100%**、分支 48.7% → **93.33%**；
  - `services/plugin/dailyRecommend.ts`（34 例）→ 行 40.6% → **100%**、分支 89.59%；
  - `services/plugin/playlistSync.ts`（37 例）→ 行 70.2% → **100%**、分支 86.76%；
  - `middleware/auth.ts` 鉴权全通道（33 例）→ 行 60.13% → **96.73%**、分支 **93%**；
  - `services/player/QueueController.ts` 操作面（73 例）→ 行 81.71% → **100%**、分支 85.66%；
  - `services/peer.ts` 清扫与发现面（29 例）→ 行 80.02% → **100%**、分支 89.06%。
- 全量：**258 文件 / 3295 用例全绿**（项目默认 pool 配置），`src/` 行覆盖 81.01% → **83.55%**、
  分支 80.00% → **81.16%**、函数 **84.98%**。

### 已记录待定（均已由测试固化现状，本轮**未改**产品行为）
- **D14** 每日推荐远程全榜单失败时只追加、**不清旧条目**，却照常把当天日期写进 `comment`
  （当天幂等判定为「已生成」，接口仍报 `skipped:false`）—— 两种修法都会改变产品行为，等确认。
- **D15** 歌单重建把占位条目补成可播后，`unavailable_reason` 仍残留「曲库中未找到」
  （同族的自动匹配路径 `match.ts` 会显式置 NULL）—— 潜伏不一致，目前不漏给客户端。
- **D16** `services/peer.ts::startCleanup()` 的三条钩子只有 20s「重启清扫」包了 `try/catch`；
  5s 首次填充与**每 60s 的周期扫描**是裸调 —— 发现源一抛错就是未捕获异常（Node 默认终止进程，且每拍复现）。
- 三条的现象与根因详见 `产品缺陷修复任务-2026-09-27.md`（总览表 D14/D15/D16）。

## [4.0.35] - 2026-09-27

### Changed
- **后端路由层拆分**（`backend/src/routes/api/index.ts`：5048 行 → 71 行装配层）：按业务域拆出
  `peers.ts` / `playlists.ts` / `dlna.ts` / `sendspin.ts` 等模块，`index.ts` 只保留路由挂载装配。
- **CI 静态守卫改为扫目录**：`check-dlna-realtime.mjs`、`check-seek-granularity.mjs`
  与 `playback-chain-guard.yml` 原先直接读 `routes/api/index.ts`；拆分后该文件已成装配层，
  产生 3 处假红、3 处假绿（假绿的三条是负向断言，恒真 —— 永远在保护不存在的东西）。
  现统一改为扫 `routes/api/` 目录。
- **注释剥离器改为字符串感知**（`backend/scripts/lib/strip-comments.mjs`）：原实现用朴素正则
  剥注释，会把路由字符串 `"/v1/airplay/devices/:deviceId/*"` 里的 `/*` 当成块注释起点向右吞；
  改为逐字符扫描并跳过字符串字面量。

### Added
- **路径引用元守卫**（`backend/scripts/check-workflow-paths.mjs`，挂 ci.yml）：静态校验
  `.github/workflows/*.yml` 与 `check-*.mjs` 中引用的仓库内路径必须真实存在，并禁止再把
  装配层文件当作内容来源 —— "文件还在、内容搬走" 是纯存在性检查抓不到的失效形态。
- **`isolatedModules`（`backend/tsconfig.json`）**：禁止类型名从值导出块再导出，从编译期杜绝
  「`tsc` 全绿、运行时却报 does not provide an export named ...」。

### Bug 修复
- **后端起不来（P0）**：`routes/api/shared.ts` 把 5 个纯类型名放进了值导出块，`tsc` 会整条擦除
  而 esbuild / tsx 予以保留 → 启动即 `SyntaxError: ... does not provide an export named 'BatchPace'`。
  已改为 TS 5.5 内联 `type` 导出。同类问题会同时打红 pentest「启动后端实例」与
  frontend-responsive，而跑 `tsc` + 全量测试的 `build-and-push` 一直是绿的 ——
  **类型检查加测试通过，不能证明后端起得来。**
- **内部异常原文外泄**：`apiInternalError` 改为按环境分级脱敏 —— 生产默认只回 `errors.internal`，
  原文写日志；`MF_EXPOSE_ERROR_DETAIL=1|true` 可显式放开。
- **遗留调试代码**：`[TEST]`、`evaluateDBG` 等无条件打印（其中 3 处会带出媒体源 URL 与用户名）
  收编到分级日志，受 `LOG_LEVEL` 控制。
- **错误契约收编**：业务错误码与 HTTP 状态码打架 27 处、裸 `{error}` 响应 51 处、在线源/搜索域
  70 处错误响应，全部走 `apiError` + `apiErrorStatus` 单一真源。
- **WebDAV 源整体不可达时不再清空歌曲行**；「跳过」与「失败」改为分离计数；`enabled` 传布尔值
  不再 500；删除用户时清理 10 张用户私有表（含可用凭据）。

### 测试
- 路由层契约测试三段齐到行覆盖 100%：`routes/api/dlna.ts`（64 用例）、
  `routes/api/sendspin.ts`（58）、`routes/api/playlists.ts`（57）。
- 零覆盖模块补齐：`services/sendspin/ipcProtocol.ts`、`routes/navidrome/index.ts`、
  `services/sendspin/proxy.ts`（行 48% → 100%、分支 14% → 100%）。

## [4.0.34] - 2026-09-26

### Changed
- **DLNA 发现节奏常量收归单一真源**（`dlna/scanPolicy.ts`）：把决定「设备上线后
  多久出现在播放器列表」的两个参数集中到一处，此前它们以字面量散落三层——
  - `DLNA_SCAN_INTERVAL_MS`（90s）由入口常驻定时器消费；
  - `DISCOVERY_CACHE_TTL_MS`（60s）由「拉 `/v1/peers` 时是否后台补扫」消费。

  这两个数一旦改一处漏一处，就会**静默退化**（不报错、不崩溃，只是列表里少一台
  正在放歌的音箱），手测极易误判成网络问题。抽成无副作用的独立模块后，两处统一
  引用同一常量（步骤本身不改行为）。

### Added
- **DLNA 实时发现 CI 守卫**（`backend/scripts/check-dlna-realtime.mjs`，挂 ci.yml）：
  七条规则静态锁死「设备上线即刻入列」的契约——间隔单一真源、入口不写死、拉列表
  即补扫、去抖可放开、alive 分支接线、byebye 反向语义、扫描并发去重。任一条被改回
  旧行为，CI 立刻变红。
- **扫描节奏契约测试**（`backend/tests/dlna/scanCadence.test.ts`）：直接 import
  `scanPolicy` 断言常量取值，不触发 SSDP 绑定。

## [4.0.33] - 2026-09-26

### Fixed
- **普通用户（非管理员）在 Windows / 安卓客户端看不到自己的本机播放器**：
  `POST /v1/peers/register` 对非管理员恒被 403 拦下，导致该账号的本机播放器
  从未在服务端建立——列表里自然既没有自己那行、`self` 标记也无从谈起。

  根因是 Hono 的 `:peerId/*` 通配会吞掉字面量子路径：`/v1/peers/:peerId/*`
  中间件实际命中了 `POST /v1/peers/register` 且把 `peerId` 解析成 `"register"`，
  于是权限判定 `canControlPeer(userId, false, "register")` 恒为 false。管理员因为
  `isAdmin` 短路放行才一直正常，这正是「只有普通账号出问题」的原因。

  修复：中间件显式放行字面量保留段 `register`（精确等值匹配，故
  `dlna:register-xxx` 这类真实 peerId 不受影响，仍走鉴权）。

  验证：240 上普通账号 `POST /v1/peers/register` 由 403 转为 200 并返回
  `self: true`；带该客户端实例标识拉 `/v1/peers`，自己那条以 `self: true` 出现。
  回归测试覆盖 register 放行、self 可认、真实 peerId 不误放三种情形。

## [4.0.32] - 2026-09-26

### Fixed
- **DLNA 设备上线后迟迟不出现在播放器列表**：`/v1/peers` 拉列表时不再完全依赖
  每 5 分钟一次的主动扫描——发现扫描间隔收紧到 90s，且拉取 peers 时按 TTL 补扫
  （并发去重，避免多端同时打开时重复扫描）。
- **alive 通告在设备刚上电时被静默丢弃**：设备 HTTP 服务尚未就绪时 description 抓取
  失败，原实现会白白消耗掉「同一位置 60s 内只处理一次 alive」的去抖窗口，导致此后即使
  设备就绪也要等下一轮扫描。现在失败会放开该窗口，并按 0.8s/2s/5s 退避重试。

真机验证：240 上主卧（HiVi H5MKII）断电后上电，新版在设备 HTTP 就绪后即将其标为
在线；旧版需等到下一轮扫描。离线判定仍正常工作（非无脑保活）。

## [4.0.31] - 2026-09-26

### 修复：逐字(卡拉OK)歌词被逐时间戳重复展开 —— 一行吐出 N 条相同歌词

- **现象**：部分歌曲在**所有端**（HA 卡片 / Web / 客户端）都显示大量重复的歌词行。用户口径：「歌词本身是正常的，是我们的解析出了问题」。
- **根因**：`parseLrc` 的时间戳正则 `\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]` 在一行内会命中**多个**时间戳，而旧实现把整行文字拼成一句、再对每个时间戳各 push 一次。逐字歌词把**每个字**的时间戳都写在同一物理行上（`[00:00.63]天[00:00.89]地[00:01.02]玄…`），于是一行 N 个字就产出 N 条**内容完全相同**的歌词。
- **修法**：按「首个时间戳结束 → 最后一个时间戳开始」之间**有无文字**，把一行分成两种形态分别处理：
  - **分组式**（`[00:10.00][00:20.00]词`：时间戳之间没有文字）→ 正确展开成多条 —— 这是它的本意，保留。
  - **交错式**（`[00:00.63]天[00:00.89]地`：时间戳与文字交错）→ 整行折叠成**一条**，以首个时间戳为起点。
  另加同 `(time, text)` 去重（同一时刻同一文本只留一条），并剥离 enhanced LRC 行内的 `<mm:ss.xx>` 逐字标签。
- **验证**：新增 `backend/tests/services/lyrics.test.ts`（8 项，含真实歌曲的逐字原文样本）；单测全绿 + 变异验证（拆掉分组式/交错式分支即转红）。240 真实曲库新旧对照：单曲 833 条 → 86 条、同 `(time,text)` 重复行 25628 → 0（抽样 2272 个文件，约 80% 曲库受影响）；剩余同文本条目为真实副歌重复，正确保留。

### 修复：DLNA 设备「正在播放」却被判离线、前端不显示其存在

- **现象**：DLNA 设备（如重命名后的「主卧」）已上线并正在播放，三端播放器列表里却看不到它 —— 用户场景是「音流触发 DLNA 设备上线后播放」。用户提示「前两天还是正常的，应该是最近对音流 / sendspin 的发现扫描改动带出来的」。
- **根因**：`control.ts::refreshDevices` 以「**本轮 M-SEARCH 响应集合**」这一个快照判定在线，**零迟滞**：设备某一轮没回 M-SEARCH（刚上电 / 固件播放中变忙 / description 拉取超时）→ `available=false` → peer 离线 → 三端 `.filter(p => p.available !== false)` 直接把它从列表剪掉。实测中设备正在拉流播放、同一时刻却被判离线，约 60~70s 后才翻转。
- **修法**：「**设备正在拉我们的流**」是比 SSDP / SOAP 更硬的存活证据。给离线判定加**四道闸 + 一道消毒**，三道都不过才真判离线：
  1. **出流活跃豁免**：`/rest/dlna/stream/:token` 的响应体每写一块登记一次活动（5s 节流），90s 窗口内有过出流 ⇒ 保持在线；
  2. **抖动宽限**：`last_seen` 距今不足 90s ⇒ 跳过本轮（不因单轮漏报降级）；
  3. **定向补探**：设备 `location` 已知就直连 GET `description.xml`（不经 SSDP 多播）成功即保持在线；
  4. **消毒**：扫描 socket 本轮报错 ⇒ 该轮结果不可信，整轮跳过。
  设备删除 / 禁用时清理活动登记，避免键泄漏。
- **验证**：新增 `backend/tests/dlna/deviceAvailability.test.ts`（8 项，覆盖四道闸 + 消毒 + 清理）；变异验证 5/5 全抓（含「整块还原为修复前逻辑」时 4 条闸测试同时变红）。230 上自建 DLNA 模拟器做同机 A/B（只换 dist）：修复前「单轮漏报 → 立即离线」复现，修复后「保持在线」；且「SSDP + HTTP 全不可达且无出流」仍能正确判离线、「停止出流后再等一个窗口」也判离线（不是无脑保活）—— 12/12 项全过。

### 功能：流转播放 sendspin → sendspin 复用服务端已解码的流（「借流」）

- **目标**：sendspin 之间流转时，目标端**零解码、零 seek、零预缓冲**即出声 —— 源端那条流在服务端本来就是**解码完的**（泵 + PCM 窗口），把它整体接过去即可。
- **修法**：新增「武装 → 起播消费 → 落位确认」三段：
  1. `armBorrowCore` 在 `POST /peers/:id/queue/transfer-from` 的起播**之前**武装（源端必须 active、非 busy、有当前曲），记录源端组 + 落点 + 歌 ID；
  2. 目标端起播那一步 `borrowFor` 取武装，**歌 ID 不符即自动放弃**（源端可能在毫秒级窗口里被停 / 被换歌）；命中的走 `handoverCore` 把源端的泵 + PCM 窗口整体改挂到目标组连接上，否则回退完整起播；
  3. `borrowLandingConfirmed` 回读目标端实时进度与落点比对（容差 1.5s）：**成了才跳过事后 seek** —— 移交没成时目标端还在 0 秒，必须走常规对齐。两种情形的后续处置完全相反，一次读回把不确定性消掉。
- **降级**：任一端不是 sendspin、源端未在播、服务未起、歌不符、RPC 失败 → 一律 `armed=false`，走既有「起播 → 读进度 → seek」链路，行为与改动前一致。
- **测试**：新增 `backend/tests/sendspin/pumpHandover.test.ts`（契约 + 变异验证）。

### 其他

- 本版为 lockstep 发布：HA 卡片 v2.4.13（卡片进度不走双根因修复）、HA 集成 v2.0.6、客户端 v5.0.37 同步 bump 并触发各自 CI。


## [4.0.30] - 2026-09-26

### 功能：流转播放带「进度对齐」——目标端出声即与流转前对齐（秒级）

- **现象**：队列与当前曲都能流转到另一端，但目标端一律从这首的 **0 秒**开始播。用户口径是「流转播放后出声的状态要是秒级对齐流转前的状态」。
- **根因**：起播接口 `playFrom` / `localPlayFrom` 与队列快照 `QueueSnapshot` 里**都没有「起始位置」这个字段**。服务端其实握着读进度的口子（`GET /v1/peers/:id/status`，DLNA 走 SOAP 实时值、本机端取客户端上报）与写进度的口子（`POST /v1/peers/:id/seek`，dlna / group / airplay / sendspin / local 五种 kind 全覆盖），但**起播路径一次都没接上** —— 于是"先起播、再 seek"这条路根本没走通，连"起点"本身都无处安放。
- **修法**：新增统一的 `readPeerPositionSeconds` / `seekPeerToSeconds` 两个辅助（seek 的 kind 分派与 `POST /peers/:id/seek` **完全一致**，保证五种 kind 的手感与既有 seek 没有差别），在三条流转路径上补齐：

  | 路径 | 起点从哪来 | 怎么落位 |
  |---|---|---|
  | `POST /peers/:id/queue/transfer-from`（远端 → 远端） | 服务端**起播之后**回读源端实时进度 | cast 目标由服务端自行 seek；local 目标把起点随当次快照交出去 |
  | `POST /v1/play`（本机 → 远端主通道） | 调用方随 body 传 `position` | cast 目标服务端 seek；local 目标同上 |
  | `POST /peers/:id/queue/play`（兜底整队推送） | 同上 | 同上 |

- **为什么读数放在起播之后**：起播（尤其 DLNA 投递）要花 1~3s，这期间源端仍在播 —— 读得越晚，越贴近目标端真正出声的那一刻。
- **为什么调用方传的 `position` 优先于服务端回读**：本机做源端时，客户端才是那个会话的持有者（它的读数是精确值，且本机此刻已暂停、不再前进），而服务端镜像带着 TTL 与轮询间隔，反而更旧。
- **local 目标为什么不能"直接下令 seek"**：本机端的音频会话活在客户端进程里，服务端只能下令；而此刻客户端**还没起播**（它在等 `peer_queue_changed` 才起播），此时下令必然落空。故起点随 `QueueSnapshot.startPosition` **一次性**下发（广播后立即清除），客户端起播后自行落位。**不落库**是刻意的：落库会让之后每次轮询/重启恢复都带着它，表现为"每次回到同一位置"。
- **降级与兼容**：`position` 全为可选参数。不带 / 为 0 / 源端进度读不到 → 行为与改动前**逐字节一致**（从头播），不引入新的失败模式。
- **测试**：新增 `backend/tests/routes/queueTransferPosition.test.ts`，覆盖"本机源端精确优先""远端源端回读""local 目标随快照下发""读不到则不落位"四条契约；并做过变异验证（摘掉起点传递后相关用例转红）。

## [4.0.29] - 2026-09-26

### 修复：歌单「自动匹配 + 补齐」整条链路此前从未真正生效

- **现象**：歌单里存在「未匹配行」（playable=0、song_id 为空 —— 常见于加导入门禁前误匹配到本地，或在线源后来下架）。用户点「播放全部」/ 投屏起播时这些行会被重新搜一次，命中的应当追加到队尾。但实测**一首都没补进去过** —— 队列始终是起播时的那几首。
- **根因（D1）**：`QueueData.contentContext` 是「这条队列来自哪个内容」的唯一标记，补齐前必须与期望值严格比对以防补错队列。它只在 `QueueController.setQueue()` 里写入，而 `setQueue` 全仓仅由 `playFrom()` 调用 —— **8 处 `playFrom` 一处都没传第 5 个参数**。于是队列上的 contentContext 恒为 `undefined`，比对 `undefined !== "playlist:<id>"` 恒真 ⇒ 永远走到 `context-mismatch`、`appended` 恒为 0。属新字段只接了一半线：当初加了给 `runPlaylistAutoMatch` 传参，漏了给 `playFrom` 补第 5 参。
- **修复**：起播处补传第 5 个参数（type=playlist 时为 `playlist:<id>`）。
- **同步修掉的另外三处**：
  - **投屏双跑（A1）**：WEB 端「播放全部」原本自己发一轮 `match-playlist`，而 `/v1/play` 也会 fire-and-forget 跑一轮 —— 两套 24h 节流（浏览器 / Node）互不知晓 ⇒ 同一歌单同时被在线搜两遍，且两边都往同一队列队尾追加 ⇒ 重复入队。现统一为「谁起播谁补齐」：投屏目标由服务端负责，前端不再自己发；补齐结果经 WS `playlist_appended` 回传，与原前端自建队补齐的刷新与提示保持一致。
  - **端点绕过节流（D2）**：`/v1/playlist/:id/auto-match`（客户端本机播用）直呼底层，24h 节流完全旁路，每次起播都真打一轮在线源。现改为复用 `runPlaylistAutoMatch`，与 `/v1/play` 共用同一份节流。
  - **死等与空跑记账（D4/D6）**：原先无论匹配 2 秒跑完还是卡在批量闸，都一律干等满 5 分钟才补齐；被每歌单并发锁挡下的空跑也照样吃掉 24h 额度。现改为「跑完即走」的竞速等待（用上 `matchPlaylistInBackground` 已有的 `onFinished`），并只在真正拿到锁跑完时才记账。
- **顺带：本地曲库优先短路**：给 `matchUnmatchedPlaylistEntries` 补上与插件榜单同步一致的`matchSongsToLibrary` 前置短路 —— 曲库中已有「归一化标题精确相等 + 歌手互相包含」的行时直接绑定旧行，不消耗在线搜索、不受导入门禁约束。门禁要求标题全串严格相等，带译名/版本后缀的条目（如「... (炽日将烬)(feat. ...)」）永远差一个字符 ⇒ `matched` 恒为 0、补齐链路不可达；短路正是这条链路的兜底。


## [4.0.28] - 2026-09-25

### 修复：群组没有在线成员时疯狂切歌；音流应在有播放器上线后才开始播放

- **现象**：音流（以及其它把内容投给群组的路径）在目标**当前没有任何成员在线**时，会把内容照投进去，
  随后队列被反复推着走 —— 一会儿就切掉几百首（用户视感 = 疯狂切歌），设备一直不出声；等设备真的
  上电回来，队列早就被推到很远的位置了。
- **根因**：两层叠加。
  - **判据失效**：音流用 `peer.available` 判断目标是否上线，而群组行的 `available` **恒 true**
    （2026-09-23 定稿「组是容器不是设备、组恒在线」）⇒ 「组零成员」永远被判为已上线，内容照投不误。
  - **空转自续**：`QueueController.playCurrent` 把投不出去当成普通 cast 失败 ⇒ `castFailStreak++`，
    封顶 `max(2, 2 × 曲数)`（大歌单即数百次），且每一拍都交给 `handleDecision("stalled")` 放行切歌
    ⇒ **边失败边切歌**。真机实测：6 分钟空转 787 次「无在线成员,无法播放」，idx 从 293 被推到 49。
- **修复**：判据单点收口到 `services/playTarget.ts` 的 `checkPlayTarget()`，三层消费同一个函数。
  - 群组：看 `hasOnlineMember`（**不再**看 `available`）；AirPlay：看 `discovery.available`
    （设备档案持久化，设备离线也仍留在列表里）；DLNA / Sendspin / 本地：乐观放行。
  - `QueueController.playCurrent`：起播前先查判据，不可播就**连 cast 都不发**、不推进队列、不计失败
    （队列保持悬挂，等 watchdog / 设备回归自然恢复）；cast 失败后再查一次，兜「起播判据过关、
    cast 期间成员掉光」的竞态，并清掉已累积的失败链。
  - `flows`：换成同一判据判断目标是否就绪；等待阶段每轮主动催 Sendspin / AirPlay 的发现，并尊重
    「Sendspin 插件启用」与「`autoDiscover`」两个开关（配置即意志，不给绕过配置的后门）。
  - Sendspin 侧附带修正：音流原先在主进程直调发现 / 拨号函数，而发现循环与重试状态机活在**子进程**
    里 ⇒ 生产 fork 模式下 100% 静默空转；改走 `wakeSendspinDiscovery()`（按 `isForkMode()` 分派
    RPC / 直跑）。同时给自动发现与名单补枪加上「被用户禁用的设备不再拨回」守卫。
- **测试**：新增 `playTarget`(7) / `playTargetGuard`(5) / `flowWaitGate`(4) 共 16 例；每处修改都做了
  负向验证 —— 破坏后必须精确变红（其中音流消费点原先零覆盖，补 `flowWaitGate` 后破坏即变红）。

### 真机验收（240 + 两台 ESP32-S3 Sendspin 播放器）

- `.245`、`.246` **同时断电**后触发群组音流：webhook **9ms** 返回（等待发生在内部，不占着请求），
  `last_run_status` 恒为 `waiting`，期间 **cast 失败 0 次、已播放 0 次、队列 idx 纹丝不动**
  （修复前同条件：6 分钟 787 次「无在线成员,无法播放」、idx 293 → 49）。
- 任一成员上电：状态直接转 `success`，**无需重新触发 webhook** —— 自动拨号 → 上线自动回组 →
  `[flow] 已播放:sendspin群组` → `timeline anchored`（出声）。用户实听确认两台都在播。

## [4.0.27] - 2026-09-25

### 修复：Sendspin 设备断电重上电后不自动连回，连回后也要切歌才出声

- **现象**：Sendspin 播放器（ESPHome / ESP32）断电再上电后服务端不会自动连回来（设备同网段可 ping 通、
  本身也起好了 WS server）；人工连上后同样不出声 —— 要等到下一次切歌才正常播放。
- **根因**：四层叠加。
  - **发现是一次性的**：设备开机只广播一次 mDNS，而 `bonjour-service` 的 PTR 查询只发起一次、
    对已知 fqdn **永久去重**、`expire()` 从不调用 —— 首次拨号失败（设备网卡刚起、IP 栈未通，
    实测 `EHOSTUNREACH`）之后，这台设备就再也没有第二次机会。
  - **重试不记忆**：旧逻辑是 60s 盲轮询，容器重启后不再尝试，断电设备永不被重新 `arm`。
  - **死链不摘牌**：断连留下的 WS 连接无心跳、未启 `SO_KEEPALIVE`，内核默认 15 分钟才判死，
    期间服务端仍认为「已在线」—— 新广播被在线判据直接跳过，任何重试方案都不会被触发。
  - **新连接不入组**：组推流的成员是 `SendspinGroup.members` 里的 **conn 对象**，断连时
    `onConnectionClosed` 会 `g.remove(conn)`；重连是**新 conn**，不在任何组里，只有下一次切歌的
    `playGroupCore` 才会 `g.add(conn)` —— 夹在中间的窗口拿不到 `stream/start`，
    设备收得到 TCP 数据却无声。
- **修复**（`backend/src/services/sendspin/`）：
  - `discover.ts`：发现即入册（先记后拨）+ **每 60s 重建 mDNS browser**，重新捕获设备广播；
  - `index.ts`：per-target 重试状态机取代 60s 盲轮询 —— `2s × 30 → 10s × 24`（300s 窗口后停手，
    兜底职责交给 mDNS 信号源），拨号显式 5s 超时，窗口内不因新信号重置计时起点；
    **上线自动回组**：连接就绪后对「本组正在播」的组走 `sendspinGroupJoin` ——
    与「加入群组」同一条 `joinGroupCore` 路径（live 沿加入 + `pendingAnnounces` 兑现
    `stream/start` + `seedLateJoin` 回填）；
  - `server.ts`：10s WS 心跳（未回 pong 即 terminate）+ `noAutoRedial` 加 5min TTL +
    在线判据兼顾 inbound 方向。

### 真机验收（240 + ESPHome ESP32-S3，三轮受控复现）

- 断电量 >300s（重试窗口**已过期**、状态机零动作）后上电：mDNS 发现重新触发窗口
  （日志前缀 `(discover)`，区别于容器 boot 的 `(boot)`）→ 首次拨号 `EHOSTUNREACH` →
  **55s 后拨通** → `设备上线自动回组 … joined=true live=true pump=true` →
  `late-join 回填 chunks=288 span=24576ms` → 切歌时与在播成员**成对**收到
  `finishPlayback` + `announceStream ×2`。
- 结论：断电上电后自动连回并**直接出声**，全程零人工干预、无需切歌（用户实听确认）。

## [4.0.26] - 2026-09-25

### 功能：新增歌单自动匹配触发端点（供客户端 / 播放器调用）

- **背景**：`/v1/play` 上的自动匹配只对**投屏**生效 —— 它本来就由服务端在起播同一时刻接管（Flutter 客户端选中远端 peer 时，`playContentOnPeer(type=playlist)` 打的就是它）。但客户端的**本机播放**并不走 `/v1/play`：它自己拉全量曲目、自己 `playQueue`。客户端又拿不到 online `providerId`（本地歌单没有该字段），调不了`/v1/online/:providerId/match-playlist` —— 于是「客户端播歌单永远不补齐」。
- **修复**：新增 `POST /v1/playlist/:id/auto-match`（`PLAYLIST_IMPORT` + 归属校验），内部直接复用 `matchPlaylistInBackground()` 的**能力驱动挑选**：启用谁的匹配能力就用谁，调用方无需指定 provider。
  - 只登记任务即返回（服务端随后还要去抢全局批量闸），**不 await** 匹配本身；
  - 与 `/v1/play` 共用同一把「每歌单锁」与 24h 节流语义，客户端反复点也不会重复消耗在线源配额；
  - 旧服务端没有该端点时调用方请求失败，客户端静默跳过补齐，不影响播放。

## [4.0.25] - 2026-09-25

### 功能：歌单「播放触发」自动匹配与补齐

- **现象**：歌单里「曲库中未找到」的条目（门禁拦下 / 在线源下架 / 加门禁前误匹配到本地）在起播时
  被直接跳过，歌就永远播不到。此前只有手动点「批量匹配」按钮才会重新尝试。
- **修复**：起播成功后**静默**跑一次歌单批量匹配，命中的曲目追加到队尾，之后由既有预探测
  （`core-pre-probe`）提前确认可播，切到它们时零等待。
  - 复用服务端既有的 `matchPlaylistInBackground()`（能力挑选 → 每歌单锁 → 全局批量闸 →
    并发搜索 → 导入门禁 → WS 播进度），另新增 `services/playlist/autoMatch.ts` 负责
    「何时触发、节流、以及跑完后补哪个队列」；
  - **绝不阻塞播放**：整条链路 fire-and-forget；排队等全局批量闸超过 5 分钟即放弃本轮
    （下次起播再试），不影响正在听的那一首；
  - 节流：同一歌单 **24 小时**内自动匹配最多一轮（手动「批量匹配」按钮不受限制），
    避免反复点「播放全部」把在线源打成 429；
  - 覆盖所有播放入口：`POST /v1/play`（投屏 / 群组 / AirPlay / 客户端本机播）在 type=playlist 时
    触发一批；Web 歌单详情页「播放全部」同样触发（前端与后端各有 24h 节流）。

### 改进：队列来源用「内存标记」精确判定，不再靠快照猜

- **背景**：三张队列表（`device_queues` / `group_queues` / `local_queues`）都没有来源字段，
  服务端无法从数据侧确证「这条队列还是刚才那个歌单吗」。原先只能靠「队列长度 + 首曲 id」快照去猜 ——
  用户中途加一首就对不上，两个同长度的歌单还会撞车。
- **修复**：`QueueData` 增加纯内存字段 `contentContext`（如 `playlist:<playlistId>`），
  由起播入口写入、切内容时清空；匹配跑完后**只有标记一致**才允许补齐，进程重启即失效
  （失效 = 放弃补齐，安全语义）。

### 体验：播放触发的匹配不再弹进度对话框

- 「播放全部」触发的自动匹配改为**静默**执行（`runMatchJob({ silent: true })`），
  只在真补齐了曲目时用 toast 提示「已把新匹配的 N 首补齐到播放队列」；
  手动「批量匹配」按钮仍保留完整进度对话框。
- 顺带：所有歌单点「播放全部」都会尝试一次自动匹配（不再要求当前存在未匹配行）——
  历史被门禁拦下的曲目，若后来在线源又有了，下次播放即自愈。

## [4.0.24] - 2026-09-25

### 修复：歌单条目的 external_* 被写入「歌曲自身 UUID」占位，失效后永久卡死

- **现象**：歌单里出现一串 UUID 当歌名（如 `35cd8956-…`），该条目再也匹配不上任何源。
- **根因**：宿主写歌单条目的「已匹配」分支，把 `song_id` 顶进了 `external_song_id` / `external_title`，
  且 `external_artist` 从未写入 —— `plugins/discovery.ts` 的 `upsertPluginPlaylist()`（外置插件
  `host.playlists.upsert`）与 `services/source/online/recommendImport.ts` 的 `replacePlaylistSongs()`。
  这两列本应只在「未匹配占位」时承载平台信息（`netease:<id>` + 歌名 + 歌手）。
  平台 id 直通路径早已废除，未匹配条目一律拿 `external_title` / `external_artist` 去在线搜索并过导入门禁；
  一旦某行因门禁重验不命中而失去 `song_id`，它就会用这串 UUID 当歌名去搜 → 永远搜不到，
  永久卡死，并被歌曲列表原样渲染成 UUID。
- **修复**：
  - `discovery.ts` 命中分支只写 `song_id`，external_* 三列留空；
  - `recommendImport.ts` 不再把歌曲 id 写入 `external_song_id`（保留真实歌名 `external_title`，
    便于该行日后失去链接时仍能按名搜回，自愈）。
- **存量数据**：清理 88361 行占位（其中 57059 行按 `songs` 表回填真歌名/歌手/时长，31302 行只清 id），
  另清掉 5985 行指向已不在库的 UUID 形态 id；真实平台 id（`netease:` / `qq:` / `kugou:` / `apple:` /
  `huawei:` 等 2.3 万行）与 lastfm / listenbrainz 的 MBID 全部保留。

### 修复：歌单「播放全部」大歌单静默漏播尾部（>1000 行只播前 ~1000 首）

- **现象**：歌单详情页点「播放全部」，超过约 1000 行的歌单只会播前 ~1000 首，后面的曲目
  无声无息被丢弃（不报错、不提示）。生产库实测「今日漫游」3137 行、只播前 ~1000 行。
- **根因**：`playAll` 的数据源是 `useInfiniteList` 的**窗口化稀疏数组**（可视区 120 行 + 预取余量 700 行），
  滚出窗口的旧块还会被 `nullSlots()` 置空 —— 数组里根本没有第 1001 行之后的内容。
- **修复**：
  - `composables/usePlayContent.ts` 新增 `fetchPlaylistTracks()`：分页拉取 `/v1/playlists/:id/tracks`
    **全量**（`pageSize` 取上限 200，`position, id` 序），单次返回 `{ playable, unmatched }` 两段；
    先回退一页补齐服务端 `total` 与分页上限不一致的边界。
  - `views/Playlists/Detail.vue` 的 `playAll` 不再读 `list.value`：
    ① 命中可播行 → `setContentOrigin("playlist", id)` + `playQueue(可播队列)` **零等待起播**（顺序正确）；
    ② 存在未匹配行 → 复用后端 `match-playlist` job（并发搜索 + 门禁 + 批量导入，带进度对话框）
    → 跑完 `addToQueue` 把新匹配到的曲目**补齐到队尾**。
  - 同时补上 `playAll` 缺失的 `contentOrigin` 声明 —— 此前切投屏会退化成"整队推送"，
    受公网 WAF 体积闸门限制（约 300 首即 403）；现在投屏走服务端权威队列 + `songId` 身份定位。
- **慢路径边界**：整单一首都不可播时不再"先起播"，直接提示无可播歌曲（保持原行为）。

## [4.0.23] - 2026-09-25

### 修复：封面批量补全的候选口径与执行守卫不一致（界面「可匹配」数量虚高）

- **现象**：管理页「批量匹配封面」始终显示数万条待匹配（线上库实测 49174），跑完一轮几乎不降。
- **根因**：候选数是裸 `COUNT(*) WHERE cover_art IS NULL OR cover_art = ''`，把本地（WebDAV）歌
  全算了进来；而本地歌的封面按设计落在**专辑行**（`songs.cover_art` 恒为空），执行期 `covers.ts`
  的专辑守卫命中后「只返回引用、不写库，保持本地歌数据原样」——这批歌因此**永远不会离开候选集**
  （49174 个候选里 48968 首属此类，且都被计成 ok 而非 skipped）。
- **修复**：把同一条守卫条件下沉进候选 SQL（`services/backfill.ts` 的 `whereClause`）——
  `type='local' AND album_id IS NOT NULL AND 专辑已有 cover_art` → 不算候选。执行期守卫保留作第二道网。
- **效果**：候选 **49174 → 206**（local 173 / web 33），与实际会发起在线搜索的量一致；
  `collectCandidates` 也不必再把 4.9 万行整行 select 进内存空跑。
- **局限**：SQL 无法判断专辑封面文件是否真的存在（那是 `resolveCoverFile` 的职责）。当前库 0 断链，
  够用；万一出现断链，JS 侧守卫仍会兜住、不会误写在线图。

## [4.0.22] - 2026-09-25

### 新增：扫描落库文件头全部标签（年份 / 专辑艺术家 / 作曲家 / 备注 / 原始标签）

- **动机**：本地源（WebDAV / 网盘）此前只落 `title` / `artist` / `album` 等少数字段，
  **扫描时读到的信息全丢**。FLAC 元数据块位于文件最前面（STREAMINFO → VORBIS_COMMENT /
  PICTURE → 音频帧），**只取文件头即可拿到与全量解析逐键一致的标签**。
- **新增列**：`songs.year` / `album_artist` / `composer` / `comment` / `tags`（原始标签 JSON，
  二进制值与 >1000 字符的值只留长度），另加 `has_lyrics`（三态，见下）；
  `albums.genre` 顺带由 `findOrCreateAlbum` 补写。线上库已手工 ALTER，drizzle schema 同步。
- **分级取头**：`HEADER_LADDER = [256KB, 1MB, 4MB]`，由 `MusicMetadata.incomplete` 驱动升档。
  实测曲库 FLAC 元数据块全部落在前 256KB 内，取头流量从固定 4MB 降至约 1/16。
- **歌词提取**：双来源 —— `common.lyrics` + native 原始标签白名单
  （`LYRICS` / `UNSYNCEDLYRICS` / `SYNCEDLYRICS` / `LYRIC` / `USLT` / `SYLT`）兜底，
  带 `[mm:ss]` 时间轴的优先（实测 FLAC 内嵌 LYRICS 多数本身就是 LRC）。
- 新增 `buildTagsJson()`（全量原始标签落库）、`joinTags()`（多值标签折叠）。

### 变更：歌词只标注存在性，不落正文

- `songs.lyrics` 不再承载歌词正文，改为只表示**在线歌词文件引用**（`online-lyrics/<id>.lrc`）；
  新增 `has_lyrics` 三态：**NULL = 未检测 / 0 = 检测过无 / 1 = 有**
  （刻意不设 DEFAULT —— 只有 NULL 才代表"没查过"）。
- `upsertSong` 写入 `hasLyrics`，文件无歌词时**不降级**已有的 1。
- 理由是批量回填只需区分「有和没有」，存正文既撑库又没有出口。

### 修复：批量回填重复劳动 + 网盘请求无限速

- `backfill.ts` 歌词候选加 `COALESCE(has_lyrics,0)=0`（内嵌已带歌词的歌不再被在线重复搜索），
  命中落盘时同步 `has_lyrics=1`；sidecar 命中分支同样标注。
- 封面回填候选过滤掉**已有专辑封面**的行；本地歌已有封面则不再搜索覆盖。
- 回填请求限速重写：全局最小请求间隔 + 429/5xx 退避重试（与 `scanner.fetchWithRetry`
  同语义），并复用系统「限速档位」`batch_pace` 的批间睡眠与并发 —— **网盘必须有间隔**。

### 新增：新落库标签的 API / 前端出口

- `utils/songSource.ts`：`ClientSongRow` / `serializeSongRow` 增
  `year` / `albumArtist` / `composer` / `comment` / `hasLyrics`。
- `routes/rest/index.ts`：`songToChild` 修掉 `year` 硬编码 0（列已落库却永远输出 0），
  增 OpenSubsonic 扩展字段 `displayAlbumArtist` / `displayComposer`；search3 空查询分支的
  手工投影列同步补齐（否则搜索结果这些字段恒空）。
- `routes/api/index.ts`：新增 `GET /v1/songs/:id` 单曲详情（返回 `tags` 原始标签 JSON +
  `lyrics` 概况）。列表接口刻意**不返回** `tags`（0.5~2KB/行，整页投影会撑爆）。
- 前端歌曲信息弹窗：补 年份 / 专辑艺术家 / 作曲家 / 流派 / 音轨 / 备注 行、歌词状态行、
  「原始标签(N)」折叠区；`locales` 的 `globalItem` 新增对应 key（zh / en 同步）。

### 验证

- `npx tsc --noEmit` 通过；前端 `npm run build` 通过。
- CI 守卫全绿：`check-builtins` 18/18、`check-core`、`check-i18n`、`check-seek-granularity`、
  `check-frontend-plugins` / `check-frontend-overlays` / `check-element-overrides` /
  `check-fixed-playlist-ids` / `check-renderer-host`。
- 实测（4 首样本）：仅 256KB 一档即拿到完整标签；`album_artist` / `year` / `comment` /
  歌词（777~1351 字符，3/4 带时间轴）/ `tags` 均落库，两轮 upsert 幂等。
- 本期**不回填历史曲库**（用户决定）：代码路径已就绪，库内已有数据的标签补齐按需再跑。

## [4.0.21] - 2026-09-24

### 修复：成员换组残留双成员 / 双流（对齐 MA `add_client` 的 `ungroup`）

- **现象**：一个 Sendspin 播放器**已属于某组**（用户组 或 它自己的独立播放组）时，
  再被加入另一个组，会同时留在**旧组和新组**的 `members` 里 → 旧组继续往它推音频
  = **双成员 / 双流**（同一首歌卡顿 + 双声叠加）。正是 §8.2 row 13 挂账的 MA 不对齐。
- **根因**：`joinGroupCore` 直接 `conn.group = g; g.add(conn)`，**没有把 conn 从旧组摘掉**。
- **修复**（对齐 MA/aiosendspin `add_client` 首步 `client.ungroup()`）：
  - 入组前先 `old.remove(conn)`，并清掉旧组残留的 `pendingAnnounces`（避免旧组
    `pushFrame` 给已离组 conn 重发 `stream/start` 造成双流）。
  - 旧组若仅此一员（独立播放组的典型形态）→ 停空转 pump + 关编码器 + 从 registry 移除。
  - 顺带让「加入群组中止原独立会话」（选项 A）**自然成立**：独立播放组的 `conn.group`
    就是该客户端专属组，换组时它正是被 `ungroup` 的旧组。
- **验证**：`tsc --noEmit` 通过；新增 2 例回归（独立播放转组不双成员、他组再入新组从旧组
  摘除且旧组其余成员不受影响）→ `playerGroup` 5/5 + `childMain` 13/13 全绿。
- **文档**：`docs/sendspin-权威方案文档.md` §8.2 row 13 `⚠️待修 → ✅已实现`；§11.3 挂账项清零。

### 附：发版前 CI 一处 flaky（非本版本问题）

- `tests/services/flow.test.ts` 的 `abort 幂等且让 done 收敛` 在负载高的 runner 上偶发
  15s 超时（该用例用 30s 输入、依赖 abort 收敛 `done`，属转码流水线测试，与本期
  sendspin 改动**零代码路径关联**——`flow.ts` 不 import `playerCore`/`services/sendspin`）。
  首次触发时该 job 报红，重跑即通过，CI 整体转绿。**未改动 flow 测试代码**。

## [4.0.20] - 2026-09-24

### 修复：播放中加入成员 → 整组一卡一卡（时间线把「并集」当成推进量）

- **现象**：FLAC 链路上，播放中把 Sendspin 播放器加入群组后，**整组**开始一卡一卡。
  指纹：**只有当前这首坏，切到下一首就正常**。
- **根因**：`pushFrame` 给每个成员各建一个编码器，而 libFLAC 是**块编码器** ——
  攒满 4096 样本（≈ 85ms）才吐一帧。各编码器的**块相位由创建时刻决定**，彼此错开；
  而时间线推进用的是「每批各成员产出取 **max**」：

  | 批 | 成员 A | 成员 B | 旧口径推进量 | 真实上网音频 |
  |---|---|---|---|---|
  | k | 吐一帧 4096 | 吐 0 | 4096 | 4096 |
  | k+1 | 吐 0 | 吐一帧 4096 | 4096 | 4096 |
  | 合计 | | | **8192** | **4096** |

  即把 A、B 两批的**并集**当成了本批推进量 → 真机净超速 **1.44×** → 时间戳跑到墙钟
  前面 → 设备排程跟不上 → 反复 `Lost sync` / 插静音。新曲全员同时重建编码器、
  相位重新对齐，所以切歌即恢复。
- **修复**（两处，均对齐 MA/aiosendspin）：
  1. **按 `(codec, gain)` 分组编码** —— 同一份 PCM + 同一 codec + 同一增益编出的字节
     **逐字节相同**，故同组只编一次、字节与时间戳分发给全组。副作用：CPU 降为 1/N
     （libFLAC 是进程内同步 asm.js 编码，直接占事件循环）。对齐 aiosendspin
     `TransformerPool`（按 transform key 共享编码器）。
  2. **时间线改为「max-of-累计」的上包络增量** —— 每个编码组维护累计交付样本，
     推进量取 `max(累计)` 的增量：相位错开相互抵消，长期**严格等于**真实上网的音频量。
     `deliveredPeak` 单调不减，且新编码组以**当前峰值**为基线登记，所以成员增删
     （含播中加入）都不会让时间线倒退或停滞。

### 修复：新加入的设备要等很久才出声（缺 late-join 回填）

- **现象**：播放中把新设备加进组，要等**约 29 秒**才出声。
- **根因**：预填充让组时间线游标**领先墙钟一整个水位**（30 秒档实测 29995ms，见日志
  `预填充水位按设备容量钳制`）。新成员只收得到**未来帧**，首帧时间戳落在 29 秒之后
  → 只能空等到那一刻。不是代码写错，而是**只发了未来、没补齐过去**。
- **修复**：`SendspinGroup.seedLateJoin` —— 对齐 aiosendspin `PushStream.on_role_join`
  （`_send_cached_chunks_to_role`）。组内按**编码组**保留「**尚未播到**」的音频缓存
  （`recentByGroup`；逐出规则 `ts + dur ≤ now − 1s`，对齐 `_prune_role_chunk_cache`），
  新成员加入时把起点 ≥「late-join 目标时刻」的 chunk **立即回放**，之后无缝接实时流：
  - 目标时刻 = `now + send_ahead + LATE_JOIN_MARGIN_US(100ms)`。设备按
    `ts − send_ahead` 决定何时播，故「不在过去」的充要条件是 `ts ≥ now + send_ahead`。
    注意 **late-join 不能自选提前量**（起播锚点才可以）—— 必须贴住既有时间轴，
    否则新老成员就错开一个提前量；
  - **先兑现 `stream/start`（`pendingAnnounces`）再推缓存字节** —— 反过来设备会因缺
    `codec_header` 而丢弃缓存帧；
  - 按设备容量钳制回填总量，不把设备一次性灌满。
- **为何不会撑爆设备缓冲**：回填 29.1s ≈ 2.79MB < `buffer_capacity` 4.8MB；此后
  「收到速率 = 播出速率」，差值恒定为 `29995 − 900 = 29095ms`，稳态不增长。
- **常量**（取值对齐 aiosendspin）：`LATE_JOIN_MARGIN_US = 100_000`
  （`LATE_JOINER_MIN_LEAD_US`）、`LATE_JOIN_KEEP_PAST_US = 1_000_000`
  （`_HISTORY_KEEP_PAST_US`）、`LATE_JOIN_RING_MAX_US = 35_000_000`。

### 真机验收（240，受控复现）

脚本 `/root/lj_test.sh`：移出成员 → 组起播（FLAC）→ 等 45s 灌深水位 → **播中加入** →
观察 75s → `/root/an_latejoin.py` 分析。

| 观测项 | 修复前 | 修复后 |
|---|---|---|
| 新成员出声 | ≈ 29s（空等一个水位） | **≈ 0.1s** |
| 群组播放速率 | **1.44×** | **1.00×** |
| `SYNC LOST` / `Lost sync` | 持续风暴 | **0 / 0** |
| 编码器零产出 / `pushLoop` 退出 | 频发 | **0 / 0** |
| `timeline RE-anchored` | — | **0**（流全程未重启） |

关键日志：`sendspin late-join 回填: chunks=341 span=29099ms target=882706us(ahead of now)`。
`882706 = send_ahead 800000 + margin 100000`；`341 × 85.33ms ≈ 29099ms`（同时反证
libFLAC 块粒度是 85.33ms，不是 25ms）。

### 测试

- 新增 `tests/sendspin/pushFrameGroupEncode.test.ts`（10 例）：钉住按组编码的字节/时间戳
  一致性、`max-of-累计` 的推进量、成员增删不倒退、同批多帧的 ts 递增。
- 新增 `tests/sendspin/lateJoinBackfill.test.ts`（8 例）：钉住回填语义（有缓存→立刻回填、
  首帧不在过去、截止于组游标、刚起播不回填、只剩过期缓存不回填、`available:false`
  不回填、容量钳制、按编码组取字节）。
- `playerGroup.test.ts` 的「播中加入」用例改为覆盖两条**都合法**的路径（有缓存→回填 /
  无缓存→挂 `pendingAnnounces`），共同不变量是 **`stream/start` 绝不早于该成员首块音频**。

## [4.0.19] - 2026-09-24

### 修复：FLAC 链路完全无声（codec_header 的 last-metadata-block 位）

4.0.18 把 `stream/start` 延后到「首块音频就绪」才发，这才**第一次**真正把编码器的
**真实 STREAMINFO** 当作 `codec_header` 送出去，于是暴露了一个字节位的错误。

- **根因**：真实流里 STREAMINFO 之后还跟着 VORBIS_COMMENT / PADDING，libFLAC 因此把
  块头写成 `0x00`（last-metadata-block = 0）—— 对**完整流**这是对的。但 `codec_header`
  是**单独**发给设备初始化解码器的，之后设备直接收裸音频帧：照抄 `last=0` 会让解码器
  读完 STREAMINFO 后继续按「元数据块」格式解析下一段，撞上 FLAC 帧同步码 `0xFF`
  → 块类型字段 = `0x7F`(127) 属**非法类型** → 解码状态机失败。
  表现极具迷惑性：**服务端日志全绿、进度照走、设备零报错，但完全无声。**
- **实证对照**（240 真机，同一台 esp32-player-meet，两组值**仅第 5 字节不同**，
  其余 41 字节完全一致：48k/2ch/16bit/block 4096）：
  - v4.0.17 发 `ZkxhQ4AAACIQ…`（第 5 字节 `0x80`，last=1）→ **有声**；
  - v4.0.18 发 `ZkxhQwAAACIQ…`（第 5 字节 `0x00`，last=0）→ **无声**。
  之所以上一版恒为合成头：v4.0.17 的 `pushFrame` 在 `encode()` **之前**就兑现宣告，
  编码器尚未产出任何东西 → `realFlacHeaderB64` 恒为 `undefined` → 回落合成头（自带 last=1）。
- **修复**：`flacCodecHeaderFromStream()` 把块头的 last 位**强制置 1**（只改这一位，
  其余 41 字节仍逐字节取自实流 —— 保留真实头不会与实流漂移的优点）。
- **测试**：`encoding.test.ts` 新增回归用例，钉住「输入 last=0 → 输出 last=1」且
  「其余 41B 与实流逐字节一致」。

### 修复：进度条／歌词从缓冲深度起跳（预填充的副作用）

- **现象**：预填充设成 10 秒后，所有歌曲一开播进度条和歌词就直接显示 `00:10`，
  而声音明明是从头开始的（其它档位同理，偏移量 = 档位值）。
- **根因**：对外上报的 `group.positionMs` 此前是**已推送位置**。预填充把「已推送」和
  「已听到」拉开了整整一个缓冲深度 —— 服务端抢先灌满缓冲时，设备才刚要出声。
- **修复**：上报改为**可听位置** = 已推送位置 − 当前设备缓冲深度
  （`cursorUs` 与 `nowUs()` 同为 host monotonic 时钟，可直接相减）。取帧仍用
  `playCursorMs`，只有对外上报换口径。曲末排空期间改为分段等待并持续刷新上报位置，
  让进度平滑走到曲末（一次睡到底会让进度停在 `durationMs` 之前，拖后自动切歌判定）。
- **保住 seek 语义**：可听位置带**下界** `reportedFloorMs`（本轮起播位置 / seek 目标）。
  正常起播下界为 0 → 开播即 `00:00`；拖到 40s 时下界为 40s → UI 立刻显示目标值，
  不会被「缓冲还没建立」拉低成 39.2s（MA `controller.py:862` 的 `elapsed_time` 防回跳语义）。
- **测试**：`streamPumpSeek.test.ts` 两处「出帧即断言位置必增」改为轮询等待推进 ——
  起播后有一段锚点提前量（≈0.8s）的静默期，此刻声音未出、进度**理应**停在起点。

### 缓冲深度档位扩充 + **按设备容量自动钳制**（「匹配好」）

Sendspin 插件页「设备缓冲深度（抗卡顿）」下拉新增 **15 / 20 / 25 / 30 秒**四档
（原有 0.8 / 1.5 / 3 / 5 / 10 秒保留）。

**关键：档位从「想填多少就填多少」改为「期望水位」，实际水位还要匹配设备自己宣告的缓冲容量。**

- **容量从哪来**：设备在 `client/hello` 的 `player@v1_support.buffer_capacity` 里宣告
  （真机实测 `1600000`）。单位是**字节** —— ESPHome 源码实锤：
  `components/sendspin/__init__.py` 把 `CONF_BUFFER_SIZE`（`media_source` 里
  `cv.int_range(min=25000)`，明显是字节）塞进 `audio_buffer_capacity`；
  aiosendspin 同名字段作 `BufferTracker(capacity_bytes=...)` 消费。
  协议硬约束：`server sends audio chunks as far ahead as the client's buffer capacity allows`。
  本仓此前**完全没读这个字段**。
- **换算**：`可用字节 = buffer_capacity × 0.6`，除以**实测压缩码率**（推流中累计
  「压缩字节 ÷ 音频秒数」，按首清零）得到设备装得下的最长秒数；
  再与 30 秒时长上限（= aiosendspin `PlayerPersistentState.max_duration_us` 默认
  `30_000_000`）取小。两道尺独立生效，与 aiosendspin 一致。
- **真机 A/B 实证**（esp32-player-meet，`buffer_capacity=1600000B`，FLAC 实测 105052 B/s）：
  - 灌到 **100%**（档位 30s 按容量满额钳到 15230ms）→ 设备在 **PLAYING 后 15.30 秒**
    开始连续 `sendspin.player: Failed to send audio chunk`（= 缓冲满、逐帧拒收），
    并伴随 `Lost sync (85352us off)` 风暴。15.30s 与 `1600000/105052 = 15.23s` 吻合。
  - 留 **0.6 余量**（钳到 9138ms）→ 100 秒全程 `Failed to send audio chunk` = 0、
    `Lost sync` = 0。
  - 三首不同曲目的钳制结果在**字节口径上恒为 60%**（0.96MB / 1.6MB），换算链路自洽。
- **为什么留余量而不是像 aiosendspin 直接用 100%**：aiosendspin 累计的是每个 chunk 的
  **真实压缩字节数**；本仓按时长记账（`depth = cursor − now`，再乘平均码率换算），
  加上每 chunk 协议头开销与最多一帧（25ms）水位过冲，按 100% 算必然踩线。
- **设备未宣告容量时不受影响**：退回 30 秒上限，行为与本版之前**完全一致**（向后兼容旧固件）。
- **想用更深的档位**：请调大 ESPHome 的 `buffer_size`（容量越大，同一比例对应秒数越多），
  而不是期望把比例调高。插件帮助文案已写明此关系与实测数据。

### 修复：`client/state` 取值层级错误（真机 RAW 实测校正）

补协议缺口的同一条日志意外暴露了取值位置错误 —— 真机实发 payload 为：

```json
{"state":"synchronized","player":{"volume":53,"muted":false,"static_delay_ms":0}}
```

- `state` 在**根层**，不在 `player` 里；而 `output_delay_ms` / `required_lead_time_ms` /
  `min_buffer_ms` / `available` / `buffer_capacity` 该固件**一个都不发**。
  也就是说：此前日志里的 `output_delay=0ms required_lead=0ms min_buffer=0ms`
  是**缺省值**，设备从未真正上报过 —— `send_ahead` 一直走保守缺省 800ms。
  本版改为 `state` / `available` / `buffer_capacity` **根层优先、`player` 层回落**，
  两处都读；并额外解析 `player.static_delay_ms`（设备输出链路固有延迟）。
- **失步时间线自有证据**：设备只在状态**翻转**时才发 `client/state`，故新增
  `SYNC LOST (state=error)` / `synchronized` 变化日志 —— 排查「偶发卡顿」以前只能靠
  设备侧 ESPHome 日志，现在服务端可自证。
- **`stream/start` 门控**：spec 要求 `server MUST NOT send stream/start unless the latest
  client/state reports available:true`，此前完全未做。现按「设备**明确上报过**
  `available:false` 才拦，且 3 秒超时兜底」实现：未上报 `available` 的固件（真机即如此）
  行为零变化，绝不因新增门控砸掉旧设备。

### 本版验证

- **单元/集成回归**：`186` 个测试文件、`1581` 个用例全绿；其中新增
  `backend/tests/sendspin/prefillCapacity.test.ts`（17 例）钉死容量解析、
  百分比换算、名义码率回落、下限钳制与「未宣告容量 → 退回 30s」的兼容语义。
- **240 真机**：FLAC 链路出声（设备 `Processed new codec header: flac, 48000 Hz, 2 ch, 16-bit`
  → `State changed to PLAYING`）；进度从 `00:00` 起 1:1 递增；30 秒档按容量钳制后
  100 秒零拒收、零失步。

## [4.0.18] - 2026-09-24

### Sendspin —— 抗卡顿：设备缓冲深度可配（预填充／回补）＋ 推流循环不再饿死事件循环

针对「ESP32 Sendspin 播放时不时卡顿」的服务端两条硬修复，并把它做成 Web 可随时调整的配置项。

- **新增插件配置项「设备缓冲深度（抗卡顿）」**（Sendspin 插件页下拉档位）：
  `0.8 秒（关闭预填充，等同旧行为）` / `1.5 秒` / `3 秒（推荐）` / `5 秒` / `10 秒`。
  改完**立即生效**（推流循环每 5s 重读配置，无需重启、不中断当前播放）。
- **预填充 / 卡顿后自动回补**（`services/sendspin/streamEngine.ts`）：
  此前设备侧缓冲深度**恒等于首帧锚点（800ms）** —— 服务端按实时速率推、设备按实时速率播，
  差值永远填不满，所以「想缓冲 10s」只能靠把锚点抬到 10s，代价是**起播静默 10 秒**。
  现在两者解耦：**锚点固定 800ms（起播延迟不变），缓冲深度由推流循环在首帧后尽快灌满**；
  编码器/音源停顿时缓冲被抽干，恢复后还会**自动补回**目标水位（旧行为补不回来 → 持续卡顿）。
  对齐 MA：producer 领先消费端填充，直到客户端 `buffer_capacity` 上限。
- **推流循环落后时让出宏任务**（B2）：原 `if (delayMs > 0) await sleep(delayMs)` 在落后时
  **没有任何让出点** → 整条 `pushLoop` 退化成微任务自旋，WebSocket 的 I/O 回调（含设备发来的
  `client/time`）排不上队 → 设备侧 `Time message N/8 timed out` → 重同步 → 卡顿。
  现在落后时 `await setImmediate`（对齐 MA `connection.py` 每 50 次迭代 `asyncio.sleep(0)`）。
- **曲末排空**：缓冲变深后，曲末若立刻发 `stream/end`，协议要求客户端**清空缓冲**，
  设备里还没播的音频会被砍掉。现在先等设备播完缓冲再收流（只等超出旧水位 800ms 的那部分，
  尾部截断量与旧行为一致），且排空放在 `running=false` **之前**，避免外部误判「已停却仍在播」。
- **配置读取**：`readSendspinPluginConfig()` 新增 `prefillBufferMs`
  （`normalizePrefillBufferMs` 归一化，区间 100–30000ms，非法回落 3000）。
- **修复：播放中加入群组的新播放器（FLAC 链路）不出声**（`services/sendspin/playerCore.ts`
  + `server.ts`）：播中加入原本**在加入瞬间就发 `stream/start`**，但 FLAC 是块编码器
  （libFLAC 自选块大小 ≈4096 样本 ≈85ms），新成员的编码器要攒满一块才吐首帧 ——
  「先宣告、后等货」留出空窗，设备据此丢弃该流（本文件已记录过的同型事故：收到
  `Stream Started` 却不做 codec header 处理、扬声器不启动 = 无声）。PCM 每批即刻产出，
  所以只有 FLAC 暴露。
  改为与起播路径一致：`stream/start` 挂入 `pendingAnnounces`，由 `pushFrame` 在
  **该成员首块音频就绪时**才兑现（对齐 MA `_pending_stream_start`）。
  附带收益：`codec_header` 此刻必为该成员编码器的**真实 STREAMINFO**，不再回落合成头。
- **测试**：`pluginConfig.test.ts` 新增档位/越界/非法归一化用例；`playerGroup.test.ts` 桩音源
  由 1s 加长到 30s（预填充灌满后仍按实时推，播中加入才收得到直播帧）并新增
  「stream/start 必须延后到首块就绪」断言；`childMain.test.ts` 同步更新该语义；
  `queueModes.test.ts` 桩曲长 300ms → 5s（曲长短于缓冲时整首会被瞬间灌完，
  「按实时播完 → 自动切歌」的仿真前提不成立）。sendspin 36 文件 203 例全绿。

## [4.0.17] - 2026-09-24

### 群组 —— 容器语义恒在线 + 点群组即切 MINI 遥控栏

- **组是「容器」不是设备，可用性恒为在线**（`services/peer.ts::reconcileGroupPeers`）：
  注册组时 `available` 恒 `true`，空组、成员全部离线也显示在线。成员各自的在线状态仍由
  `GroupManager.resolveMemberStates()`（按成员 id 命名空间分派的唯一真相源）推导，
  汇总成 `onlineCount` **只供前端展示「x/y 在线」**，不再反向决定组行可用性。
  历史两版都把「容器在线」误当成「内容物在线」：① 只查 DLNA 设备缓存 ⇒ sendspin 组恒离线、
  被流转选择器按 `available` 剪掉整行；② 改 `some(m => m.available)` ⇒ 空组/成员离线时组又变离线。
- **点群组 = 切换 MINI 遥控栏 + 进入管理模式**（`frontend/src/layouts/MainLayout.vue`）：
  `toggleGroupManage` 内先 `await playerStore.switchPeer(gid)`，把 MINI 播放器栏切到该群组，
  再展开成员勾选（保留弹窗/抽屉，这是与 `onSwitchPeer` 的差异）；移除群组行的 ▶ 按钮
  （与勾选圈职责冲突）；组行状态标注：空组 → `layout.groupEmpty`，有成员 → `layout.groupMembersOnline`。
- **测试**：`tests/services/groupPeerAvailability.test.ts` 重写为 7 例（组恒在线 + `onlineCount`
  汇总，保留旧语义的负向验证，回退即红）。
- **i18n**：新增 `layout.groupEmpty` / `layout.groupMembersOnline`（zh + en）。

### 工程

- `scripts/sendspin-monitor-240.sh`：匹配串 `pollDBG` → `[QueueController][poll]`（poll 日志改
  debug 级后旧串不再出现，脚本此前**静默漏采**）；新增位置回退 >5s 的 `REWIND`、链路不可用连续
  3 轮的 `LINKDOWN`，卡顿指纹（PUSHBREAK / ENCSTALL / WINEOF / CURSORLAG / LOOPLAG / LOOPDEATH）
  统一写带时间戳的 `[ALERT]` 行；新增高采样率变体 `scripts/sendspin-hires-240.sh`。
- **版本号守卫**：新增 `backend/scripts/check-release-version.mjs` + `.github/workflows/version-guard.yml`
  —— 版本号必须是数字（vX.Y.Z），`main` / `master` / `latest` 等分支名一律判红；静态禁止 workflow
  把 `github.ref_name` 当版本号（推分支时它等于 `main`）；监听 `tags: ["*"]` 以便非法 tag 进来就被判红。

### 验证

- `backend tsc --noEmit` 0 错；`frontend vue-tsc --noEmit` 0 错；
  全量 vitest **186 文件 / 1579 例全绿**；7 个 `check-*.mjs` + `check-i18n` 全通过。

## [4.0.16] - 2026-09-23

### 功能 —— 群组音量持久化（空组也落库）+ 默认 20 + 卡顿监控文档

- **组音量落库**（`player_groups.volume`，0–100 整数）：
  - `schema.ts` 与 `db/index.ts` 的 `CREATE TABLE player_groups` 同步加 `volume INTEGER NOT NULL DEFAULT 20`（无 `ALTER TABLE`，老库按约定重建）；
  - `GroupManager`：新建组默认 **20**（用户定稿，替代原 100）；`getVolume` / `setVolume`（钳位 + `persist` + `group_updated`）；`loadFromDb` / `persist` 读写 volume；
  - **无成员也持久**：空组 / 全离线调音量重启后恢复；改成员、改名不覆盖已存音量。
- **写路径**：
  - 路由 `POST /v1/peers/:peerId/volume` group 分支：**先** `gm.setVolume` 落库，再 `transport` 扇出（扇出失败不回滚库值）；
  - `GroupProtocolPlayer.setVolume`、`createSendspinGroupPlayer.setVolume`：先落库再下发。
- **回显**：`getGroupStatus` 音量权威 = GroupManager 持久值（空组/全离线也回显）；sendspin leader 有实时组值则用实时，DLNA leader 覆盖为持久组音量。
- **ug 懒创建回填**（子进程 `SendspinGroup.volume` 缺省 100 的对称修复）：
  - 起播 `playMedia`、成员加入对齐 `alignGroupMembers`、看门狗成员回归：入组/起播前 `sendspinGroupTransport(ug, "volume", gm.getVolume(id))` 灌入持久值。
- **测试**：3 个测试文件内嵌 `CREATE TABLE player_groups` 补 `volume` 列；`GroupManager` 新增 3 例（默认 20 / 空组持久重启恢复 / 钳位与事件 / 改成员改名不丢音量）；GroupPlayback·GroupWatchdog 的 `getGroupManager` stub 补 `getVolume`/`setVolume`。
- **文档**：新增 `docs/STALL_MONITORING.md` —— 多线程容器卡顿监控方法（`sendspin-monitor-240.sh` / `sendspin-hires-240.sh` / `pull-240-monitor.sh` 部署、事件判读、排查顺序、盲区、DLNA 对照）。
- **验证**：`tsc --noEmit` 0；组相关 5 个测试文件 44 用例绿；`check-i18n` 0。

## [4.0.15] - 2026-09-23

### 对齐 MA —— ffmpeg 解码参数（P0）+ 滑动窗口 300s（BALANCED）

- **ffmpeg 参数对齐 MA（P0）**（`audio/pipeline.ts`）：
  - 新增 `INPUT_READ_ARGS`：每输入自带 `protocol_whitelist` + `probesize 8096` + `analyzeduration 500000`（对齐 MA `_INPUT_READ_ARGS`，起播/切歌不再等满 5MB 默认探测）；
  - 新增 `HTTP_RECONNECT_ARGS`：http(s) 输入补 `-reconnect 1 -reconnect_delay_max 10 -reconnect_streamed 1 -reconnect_on_network_error 0 -reconnect_on_http_error 5xx,429`（对齐 MA `get_ffmpeg_args` 重连窗）；
  - 全局补 `-nostats -ignore_unknown`。
- **滑动窗口 30→300 秒**（`sendspin/streamSource.ts`）：`WINDOW_HIGH_SEC=300` / `WINDOW_LOW_SEC=290`（滞回 10s 同宽），对齐 MA `BUFFER_SIZE_MAP[BALANCED]`（240 ≥4GB 落 BALANCED）。未消费前沿 PCM 上限 ~115MB（Buffer 外部内存，不占 V8 老生代）；5 分钟曲内 seek 回跳几乎总能命中窗口。
- **概念分层写清**：300s = 服务端 PCM 解码环；MA `_PRODUCER_BUFFER_LIMIT_US`（30→60s，发送侧推流背压，MA 源码侧已改）是另一层，注释与设计文档 §2.5 已区分。
- **插件 help（中英）与设计文档同步**：30s/11.5MB → 300s/115MB；`SENDSPIN_MULTIROOM_STREAMING_PLAN.md` §2.1/2.2/2.5/§A 重写（60→30→300 演进、水位 290/300、MA 侧 60s ≈26MB）。
- **测试**：pipeline / transcode / streamSource 相关用例同步；`tsc --noEmit` 0；`check-i18n` 0。
- **240 热补丁核验 + CPU 峰值压测**：容器内 grep 全部参数在位、`/ping` ok；12–16×`yes` 忙等使 loadavg 峰值 23.11，期间 `state=PLAYING` 位置线性推进、无 STALL；20:11:44–51 卡顿反馈经 events/docker 日志对齐为**自然切歌**（`contentEnded` → `advance` → dur 170→126），非卡死。

## [4.0.14] - 2026-09-23

### 优化 —— 播放优选：WebDAV 可播「成功记忆」（跳转性能 F 项）

- **问题**：`utils/localSourceProbe.ts` 只记**失败**（`localFailCache` 5 分钟），成功不记。
  而「这首歌的 WebDAV 源可播」这个结论在**每次起播 / 每次 seek** 都被重新探测一遍 ——
  240 实测单次 `probeLocalSourceOk` = 597~1410ms，`resolvePlayableRow` 的 `preferred-swap`
  因此要 1.7~2.0s（judge 一次 + 出流一次，成对出现）。
- **做法**：新增与失败记忆**对称**的成功记忆 `webdavOkCache`（TTL 同为 5 分钟）：
  - **只缓存 WebDAV 分支** —— 本地 `l:` 走 `existsSync` 零成本，缓存它零收益，
    反而会引入「文件已删却仍返回死行」的风险；
  - 对外暴露 `evictProbeOk(songId)`，**出流失败**（源行缺失 / 非 2xx / 取流异常）时逐出，
    接线在 `resolveAudio.ts` 的 `fetchRowBytes`;
  - 缓存条目上限 512，超出先清过期再丢最旧，防无界增长。
- **收益（240 真机）**：同一首 WebDAV 行连测 3 次 `probeLocalSourceOk`：
  831ms → **0ms → 0ms**；`preferred-swap` 裁决 2007/1731/1758ms → **957/810/727ms**（约 -55%）。
  `resolvePreferredSong` 的 6 个调用点自动受益，无需改动任何链路。
- **测试**：新增 `tests/utils/webdavOkCache.test.ts` 5 例（命中 / 过期 / 逐出 / 失败不记 / 本地分支不参与），
  并做负向变体验证守卫会红（破坏命中判定 → 2 红；`evictProbeOk` 置空 → 1 红；还原后 5 绿）。
  全量回归 185 文件 / 1568 用例全绿，`tsc --noEmit` 与 9 个 CI 门禁全 0。

## [4.0.13] - 2026-09-23

### 优化 —— seek 取流：回环 raw 流加 256KB 稀疏块缓存（跳转性能 B 项）

- **问题**：ffmpeg 对**无 SEEKTABLE** 的网盘 FLAC 做输入 `-ss` 时会发 9 次**开放式 Range**
  （每次往前退一点、读到文件尾），每次一个上游往返，累计 **4~13s** 才出声。
  旧的回环 raw 分支是**纯透传**，这些回溯请求一个都省不掉。
- **做法**：新增 `services/dlna/rawStreamCache.ts`，把 `/rest/dlna/stream/:token?raw=1` 从纯透传
  升级为 **256KB 稀疏块缓存代理**（`proxyRawRange`）—— 未命中时透传并顺带镜像、命中时本地供给
  零上游往返；未命中时**并行补「块首 → 请求起点」前缀**，让 ffmpeg 逐步往前退的回溯 Range 能命中。
  五条链路的 seek 都走同一段 `-ss`（`audio/pipeline.ts`）⇒ **Sendspin / DLNA / 客户端 / Web / AirPlay 一起受益**。
- **形态红线（四轮 240 真机事故沉淀，离线单测测不出来）**：
  ① 响应头必须在上游响应头到达后**立刻发出**、数据边下边喂（「先把窗口下完再回话」会把首响应
  拖到几十秒 ⇒ 前奏无声 / 拖动卡住）；② 后台补块**不得带客户端 signal**（ffmpeg 读几百字节就断连，
  会把补块自己掐断，缓存永远补不上）；③ 续接上游必须**一条请求读到完**（逐 chunk 现场开请求 ⇒
  26MB 顺序播放退化成 ~100 次小请求，真机 21 分钟零输出）；④ 续接交给上游后**不得再回头读缓存**
  （上游顺序覆盖 ⇒ 同一段吐两次，总长不变、只有 md5 看得出）。
- **兜底与降级**：上游 5xx 先重试一次，仍失败则让下游看到错误而**不是假 EOF**（静默结束会被
  当成「播完了」自动切歌）；任何异常路径一律回退旧透传 + `[rawStreamCache]` 告警（30s 节流）；
  `RAW_STREAM_CACHE=0` 可整体回到纯透传（A/B 对照用）。
- **效果（240 真机，26MB 天翼网盘 FLAC）**：整曲回环长度与直连一致、**md5 三方全等**（直连×2 + 回环）、
  `upstream=0`；端到端 `ffmpeg -ss` 冷态 **1.3~1.9s**（旧基线 3.4~8.9s）、同曲热态 **31ms**。
  **已知差距**：回溯序列实测 5 次只命中 1 次（补块 TTFB ≈450ms 与回溯间隔同量级），
  「9 → 1~2」属设计目标、真机未达成 —— 收益主要来自**整曲续读走缓存 + 热态重放**。
- **验证**：新增 24 例单测（真 HTTP 上游：分片慢给 / 只发头不发 body / 整块 416 / 5xx 注入）；
  负向矩阵 12 变体（11 条守卫各自精确变红 + V1b 对照组全绿）；全量 184 文件 **1563 用例全绿**；
  9 个 CI 门禁脚本全 0；240 真机四轮实测 + 用户收听验收通过。

## [4.0.12] - 2026-09-22

### 修复 —— 拖拽 seek 打死 sendspin 子进程（整秒契约）+ 取流重建加固

- **根因**：sendspin 流式引擎按 **25ms 帧栅格**取帧（`lo = floor(pos/25) * 2400` 样点），而滑动窗口
  基准是「毫秒 → 样本」换算（`base = floor(pos/1000 * 48000 * 2)`）—— **只有目标为 25ms 整数倍时两者相等**。
  HA 卡片 / 网页把当前播放位置原样下发（31.178s / 30.178s 这类毫秒精度）→ `lo < base` →
  `PcmWindow.slice()` 抛 `WindowEvictedError` → 主循环 `continue` 用**同一个游标**重算 → 再抛 →
  纯微任务自旋（不 await I/O）→ 事件循环彻底饿死 → 心跳与 `poll` RPC 全排不上队（管辖进程记
  `悬挂 RPC 12~15 个` / `最后消息 71s 前`）→ **65s 看门狗 SIGKILL** → 重启 → frozen 兜底重投
  （位置仍是毫秒精度）→ 再挂。现象：拖完进度条播放静默死掉、进度冻住。
  客户端下发 `Duration.inSeconds` 恒为整秒（1000/25 = 40），所以**从来只有 HA 卡片与网页会挂**。
- **三层防御（引擎）**：①新增 `alignFrameMs()` 帧栅格对齐，在 `play()`（源起点 + 游标）、`seek()`
  （发布位置 + 记忆）、`armSeek()`（装填）**四处统一**向下取整到 25ms（代价 ≤24ms，不可闻）；
  ②`PcmWindow.slice()` 亚帧容错 —— 只在请求段与窗口**全无交集**（`hi <= baseSample`）时才抛错，
  `lo < base < hi` 时钳到 base 返回短帧；新增 `get baseMs()`；③pushLoop 淘汰护栏 —— 淘汰分支把
  落后于窗口基准的游标**贴齐**到 `ceil(baseMs / FRAME_MS) * FRAME_MS` 并重锚 pacing（+ warn 取证），
  保证「每轮淘汰必然前进」，机制上杜绝自旋。
- **唯一入口兜底**：`POST /v1/peers/:peerId/seek` 经 `alignSeekSeconds()` 统一向下取整 —— 任何来源
  （HA 卡片 / 网页 / 第三方客户端）都不可能把非整秒目标送进引擎。
- **取流重建加固**：并发 `play` 世代守卫、重建失败告警 + 子进程 loop 自检、音源获取 30s 熔断。

### 门禁

- 新增 `backend/scripts/check-seek-granularity.mjs`（6 条规则：两侧 util 导出、后端路由必须兜底、
  前端每个 `/seek` 下发站点必须对齐、不得有未识别的 `/seek` 字面量、引擎 `alignFrameMs` 应用点 ≥5
  且 `WindowEvictedError` 仍在），挂 `ci.yml` 新 job。
- 新增 `backend/tests/utils/seekGranularity.test.ts`（截断语义 / 整秒恒等 / 25ms 帧栅格不变式 / 非法归 0）。
- 新增 `streamSource.test.ts` 2 例（亚帧钳制返回短帧 / 真淘汰仍抛错）、`streamPumpSeek.test.ts` 3 例。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.12` + `:latest`
- 配套：客户端 **v5.0.28**／HA 卡片 **v2.4.8**／HA 集成 **v2.0.5**（同一批次）

## [4.0.11] - 2026-09-22

### 调试日志补全（seek 全链路）

- AirPlay protocol seek：入口＋结果＋耗时（原裸调，成败靠猜）
- sendspin `seekCore`：请求值／钳制结果／有无在播／重建耗时／ephemeral 回落
- DLNA（cast/seek/guard/status）、group 扇出、transport 入口：既有覆盖不变
- 零行为变更；配套客户端 **v5.0.26**

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.11` + `:latest`

## [4.0.10] - 2026-09-22

### 修复 —— 拖动后切歌／从头重播（240 联调实锤三连）

- **同歌重投误判换歌**：`track_changed` 用全 URI 字符串比较，重投只改 `?timeOffset` 也算"换歌"→自动 advance。比较前剥 query（真换歌 token 必变，不受影响）；回归单测锁定。
- **重投间隙 STOPPED 清基线**：Stop 生效期的瞬态 STOPPED 走 else 分支删掉 seek 锚点，随后 PLAYING rawPos=0 只能就地播种 0 → 进度/歌词从头重爬。保护窗内保留基线并回填预期位置；重投路径补开保护窗。
- **手动 next/prev 归因日志**：`[Peer] 手动切歌`，区分误触与自发切歌（此前 playCurrent 无决策无请求，无法定案）。
- 三链路核查：sendspin（pump 设目标值）／AirPlay（原地 FLUSH 保 position）／group（透传成员）无同类瞬态清锚逻辑，不用动。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.10` + `:latest`

## [4.0.9] - 2026-09-22

### 修复 —— DLNA 重投风暴串行化 + Web 投屏跟手保护

- **重投风暴串行化**：连续拖动产生背靠背完整重投（Stop/SetURI/wait/Play），小设备 HTTP 栈被打死后全 500（240 联调实锤：5 连拖）。同设备重投排队串行＋400ms settle 收敛到最新目标＋世代号后来者胜，旧重投在 Stop/SetURI/wait/Play 检查点退出（`SeekSupersededError`，不记失败）。
- **Web 投屏跟手**：拖拽标志（拖拽中 tick 不推进手指值）＋分母未知不发 seek＋尾部 `duration-0.5s` 钳位＋换歌/停轮询清理 seek 状态（与卡片 seekDragging、客户端因果屏障同构）。
- 配套客户端 **v5.0.25**（看门狗意图作废＋间隙 0 屏蔽）。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.9` + `:latest`

## [4.0.8] - 2026-09-22

### 修复 —— 同歌 seek 重投被 tracker 误判为换歌，自动 advance 切下一首（HA 卡片/客户端同病）

**根因（240 真机日志实锤）**：拖动进度触发「重投流重建」时，`createCastSession`/
`createAirPlaySession` 每次 mint **新 token** → 设备 TrackURI/mediaUri 随之变化。
`PlaybackTracker` 的 native gapless 判据「PLAYING 且 uri 变 = 换歌」
（PlaybackTracker.ts:165）把同歌重投误判成换歌 → `track_changed` → 自动 advance。
4 次拖拽 2 次中招；轮询恰好采到 BUFFERING 瞬态时幸免，故体感「拖到靠近结尾必切下一首」。
HA 卡片与客户端共用后端队列，两边同时中招 —— 与前端无关。

**修复（对齐 MA「同一队列项流 URL 恒定」语义）**：
- `createCastSession`（DLNA + sendspin mediaUri 共用）：同 (songId, deviceId)
  未过期会话**复用 token、仅续期**（6h TTL 内同歌重投 TrackURI 不变）。
- `createAirPlaySession`（AirPlay 独立会话）：同样复用（SQLite 主路径 +
  内存回退路径）。换歌（songId 变化）仍 mint 新 token，真换歌的
  track_changed 判据不受影响。
- 新增回归测试：`tests/dlna/castSessionReuse.test.ts`、
  `tests/airplay/sessionReuse.test.ts`（复用/换歌/跨设备/解析一致性共 8 例）。

## [4.0.7] - 2026-09-22

### 重做 —— sendspin seek 按 Music Assistant 权威语义推倒重来（真机验证通过）

**v4.0.6 的「后台预建 + 帧边界原子切换」方案在真机上失败，本版整体废弃，
改为与 MA `player_queues/controller.py::seek`(@862) 逐条对齐的实现：**

- **seek = 发布位置对 + 整条流重建**（MA `play_index(seek_position)`）：
  - ① 先发布 `group.positionMs = targetMs`（MA `elapsed_time + last_updated`），
    推送循环取帧改用**自有游标**（`playCursorMs`），共享位置只写不读 ——
    v4.0.6 的 swap 前置问题：pushLoop 用共享 positionMs 反推帧下标，
    seek 一发布目标位置旧循环即误判 EOF（真机 FP-TRACE 堆栈钉死）。
  - ② `seekCore` 走与正常起播**完全相同**的 `playCore/playGroupCore` 路径重建流：
    停旧流 → stream/end 成对 → 全新音源带 `-ss` 起点起流 → 新时间线锚点
    （now + send_ahead，MA `_resolve_channel_play_start` auto 模式）。
    MA 没有帧边界换流；设备缓冲自然耗尽后接新流，即 MA 真机行为。
- 删除 v4.0.6 引入的全部自创机制：`beginRebuild` / `applySwap` / `swap*` /
  `rebuildGen` / `rebuildInFlight`。
- `playCore`/`playGroupCore` 新增 `seekPositionMs` 通道（MA seek_position 等价）；
  组状态 `current` 补存 `mime`。
- **真机验证**（240 容器 + 真实音源）：
  - sendspin(esp32-player2)：seek 30s→31.2s 续播、seek 45s→47.0s 续播，
    真实节奏推进不断线；音量 30/45/80 即时回读一致。
  - DLNA(主卧 HiVi H5MKII)：seek 40s→43.0s、seek 70s→73.0s 续播正常；
    设备恒报 RelTime=0 时自动降级「重投流重建」标记生效；音量 20→40→70 即时生效。
- 排查附记：测试曲「Ditch」实际音频仅 30s（试听片段）而元数据 131s，
  seek 超出实际音频末尾的 EOF→切歌行为与 MA 一致，非本版缺陷。

## [4.0.6] - 2026-09-22

### 修复 —— 进度条跳转(sendspin / DLNA)按 Music Assistant 语义重做

根因一句话:此前 seek 的语义是「在跑着的流里挪指针」,而 MA 的语义是
「用新起点重建一条流」(`controllers/player_queues/controller.py:862`)。
前者在实时转码管道上物理落不了位 —— sendspin 卡顿、进度条比真实快、DLNA 进度虚高,
是同一个根因的三种表现。完整方案见 `docs/PLAYBACK_SEEK_MA_REWORK.md`。

- **sendspin 跳转后持续卡顿 + 进度条比真实时间快**:`window.seekTo()` 是 kill 旧 ffmpeg
  再冷起新的,设备端实测 **5~7.4s 完全断流**,缓冲耗尽后按实时速率补不回来;且 seek
  瞬间就写了 pacing 锚点、首帧却晚到数秒,`dueMs` 全部落在过去 → 帧无节制连发
  (实测 3.94s 内 `pos` 涨 8.875s)。现在改为 MA 式**后台预建新流 + 帧边界原子切换**:
  `seek()` 立即发布目标位置(防 UI snapback)→ `beginRebuild()` 后台预建 → 就绪后由
  pushLoop 在帧边界换流 —— **旧流在预建期间继续播,设备端零空窗**;`rebuildGen`
  保证连续拖动只认最后一次,过期的重建立即释放(防泄漏);seek 后重锚提前量抬到 3s
  (设备上报的缓冲参数常常全 0,`send_ahead` 退化成 800ms,太浅)。
- **ffmpeg 孤儿泄漏(P0)**:`GroupPump.play()` 用 `this.window = stream` 直接覆盖,
  旧 `WindowStream` 从未 `close()` → 每次切歌泄漏一个 ffmpeg。240 现场堆积 10 个、
  存活 18~29 分钟、各占 ~65MB RSS,最终触发 `PcmWindow 等数超时(15000ms)` →
  `idle_early` 误判 → 切歌 → 再泄漏,恶性循环。改为 play 前先 `releaseAudio()`。
  部署后实测:ffmpeg 10→1、僵尸 5→0、容器内存 1.35G→674MB。
- **DLNA 进度虚高 + 外推越过时长误判切歌**:HiVi/MUZO 播实时转码流时 `GetPositionInfo`
  **恒回 `RelTime=0`**,SOAP `Seek(REL_TIME)` 静默失效,而位置基线仍被锚到请求目标 →
  纯墙钟外推。现在连续 2 次「设备不报位置」即判定该设备 SOAP Seek 无效(**并落库持久化**,
  重启后首次 seek 就直接走,不必再试错两回),此后 seek 改为**带 `timeOffset=N` 重投一条
  新流**(MA `play_index(seek_position=N)` 在 DLNA 侧的等价实现)。
- **起播跳转不再二次冷起**:`PumpSource` 增加 `startMs`,起播即带 ffmpeg `-ss`,
  省掉「建流 → `seekTo()` → 再冷起」的整段空窗。

### 新增 —— AirPlay 通道独立(播放通道不再复用)

AirPlay 此前与 DLNA、sendspin 共用 `/rest/dlna/stream/:token` **一条**路由,带来三个
结构性问题:① DLNA 音箱兼容头(`contentFeatures` / 12h 假 `Content-Length` / ICY)被
强加给 AirPlay 解码器;② 滤镜通道键恒为 `dlna`,`pipeline.airplay` 开关形同虚设;
③ 任一链改 URL 参数会串到别的链。现在 AirPlay 有自己的 token 命名空间
(`services/airplay/session.ts`,**SQLite 登记** —— AirPlay fork 模式下主进程 mint、
子进程经回环 URL 消费,内存 Map 跨进程不可见)与 `/rest/airplay/stream/:token` 路由;
出流核心抽成 `serveCastStream()` 由两条链共用,按通道取各自的 DSP 查键与管线开关,
不复制 100+ 行出流逻辑。

### 文档
- 新增 `docs/PLAYBACK_SEEK_MA_REWORK.md`:真机取证(F1~F4 + 两个放大器)、MA 权威契约、
  通道复用现状图、四层改造总纲、patch 全表、验收矩阵、发布与回滚方案。

### 构建信息

- Docker 镜像:`ray5378/musicflow:4.0.6` + `:latest`

## [4.0.5] - 2026-09-21

### 修复 —— CI 合规

- **`check-i18n` 阻断「前端插件隔离守卫」**：`c42757a`（拖动进度条四端修复）在
  `frontend/src/stores/player.ts` 的 castPoll seek 护栏里留了一行中文 `console.debug`
  （`丢弃 seek 后偏离读数`），而 `backend/scripts/check-i18n.mjs` 要求前端源码（注释除外）
  不得出现硬编码 CJK —— 于是 v4.0.4 发版提交 64f3e11 上 `ci` 工作流的该步骤变红。
  日志不是用户可见文案、无需走 i18n，改为英文即可；**播放逻辑与产物零变化**。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.5` + `:latest`

## [4.0.4] - 2026-09-21

### 新增

- **日志等级运行时可调**：新增设置键 `log.level` + admin API（`GET/PUT /rest/api/v1/admin/log-settings`），
  设置页新增「日志等级」卡片。此前只能靠启动时的 `LOG_LEVEL` 环境变量定死，排查线上问题要么重启、
  要么零日志。fork 出去的子进程有独立 logger 实例，故新增 `setLogLevel` IPC 显式下发
  （否则推流/解码侧的 debug 明细不出现）。
- **请求级 trace id**：`runWithTrace()` 给 `/rest`、`/api`、`/webhooks` 请求生成短 id 放进
  `AsyncLocalStorage`，debug 日志自动附加 `tid=`。一次「拖动进度条」会级联 HTTP → QueueController
  → DLNA SOAP → sendspin 多层，靠 tid 才能把跨层日志串成一条链。静态资源不生成（纯噪音）。

### 修复 —— 播放链路

- **PLAYING 但位置冻结无看门狗**（用户观感＝「进度条卡住不动」，永不自愈）：实测 sendspin 报
  `PLAYING pos=173.6 dur=280` 三分钟不推进、pump 零日志，而现有的 IDLE 卡死（15s）与结束兜底（8s）
  都够不着。新增 `frozen` 判据（位置**真变化**的墙钟超 30s）→ 就地重投当前首并拉回位置
  （**不切歌**），与 stalled 共用连续计数；seek 冷静期内与复查后撤销。
- **链路不可用却冒充设备状态**：子进程僵死期间 RPC 25s 超时，旧代码 catch 成
  `{playing:false,pos:0}` ＝ 向 tracker 谎报「设备停了」→ 凭空造出 PLAYING→IDLE 迁移 →
  判「自然结束」切歌。新增 `PlayerState.unavailable`：sendspin 三种 player 与 DLNA 的 `pollState`
  在拿不到真实读数时标它，QueueController 读到即不喂 tracker、不计数、登记 linkLost，等真恢复再续播。
- **DLNA 在设备未发现时冒充 STOPPED**：`getDeviceStatus` 的早退分支在设备不在发现缓存时返回
  `STOPPED pos=0`，容器重启 / 重新发现窗口期会被读成「设备真停了」，连续 2 次判卡死后**放行切歌**
  （真机复现：重启后 35s 队列凭空少一首、位置归零，极易被误判成 seek bug）。修法同款：标
  `unavailable` 不冒充。判据用**发现缓存**而非 `runtimes` 的 available 位——后者对未知设备乐观返回 true。
- **「链路恢复」≠「设备回来了」**：fork 模式 sendspin 子进程重启后要重新拨号、设备要重新入组，
  这中间 `poll` 会合法地回 IDLE。盲目 cast 会投进一个不存在的连接（没声音但状态显示在播）→
  30s 后被冻结看门狗判死 → 第 2 次直接放行切歌。新增 `ProtocolPlayer.isAvailable?()` 作为续播前门，
  不在线就**保留** linkLost 等下一拍（5s 后）再试。
- **子进程僵死窗口过长**：心跳看门狗 3×+5s(95s) → 2×+5s(65s)，检查间隔 30s→10s（最坏 125s→75s）；
  超时日志补「最后消息 Xs 前 | 最后 RPC op | 悬挂 RPC 数」，下次能直接看出卡在哪一步。
- **拨号目标过期不重发现**：`dialRemembered()` 只重拨记忆中的 host:port、不做 mDNS 重解析，
  设备 DHCP 换 IP（实测 .245→.246）后旧目标无限 `EHOSTUNREACH`，把子进程拖住并连带所有 RPC 25s 超时。
  现在连续 3 次**地址类**错误（EHOSTUNREACH/ENETUNREACH/EHOSTDOWN/ENOTFOUND/EAI_AGAIN/ENETDOWN）
  即淘汰记忆目标并落盘（非破坏性，mDNS 会重新发现新 IP），并加单飞与 5s 连接超时。

### 修复 —— 拖动进度条（四端）

- **Web 端缺 seek 护栏**：`castPoll` 此前**无条件采纳**设备上报位置，设备实际生效有延迟时轮询读到的
  仍是拖动前的旧位置 → 进度条被拽回。新增每设备 `seekIssued`（时刻+目标）护栏，与卡片
  `_seekIssuedAt`、客户端 `_seekIssuedAtMs`、HA 集成 `seek_guard_until` 同语义，且必须在 POST
  **之前**置位（请求在途期间就可能有一次轮询返回旧位置）。
- **服务端 DLNA `seekGuard`**：拖动后设备把陈旧读数报回来的窗口内，丢弃陈旧值、采纳落位值、到期解除。
  判定抽成纯函数以便 CI 用固定时间轴钉死（失效形态是偶发跳回，手测极难复现）。
- **sendspin 重定位代数化**：「校验失败→重发」此前会让 `seekDevice` 末尾派生新 gen 的新校验 →
  每秒一次的无限风暴；更隐蔽的后果是每次重发都重设护栏 → 位置恒被 `seekExpectedPosition` 顶住 →
  **进度卡住不前进**。现在重发恰好一次（`{verify:false}`），设备恒报 0（HiVi/MUZO 播转码 chunked 流）
  时直接放弃落位校验。
- **起播窗口内拖动**：拖动落在 pump 尚未运行的空档时记下起播位置交由 `play()` 消费，不再丢弃。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.4` + `:latest`

## [4.0.3] - 2026-09-21

### 修复

- **插件沙箱交互型调用超时 30s→20s**：15s 配额过窄，20s 兼顾等待与卡死可杀；重建预算 30s 不变。
- **沙箱 OOM 清理排空 pending jobs**：被 interrupt 打断的 async continuation 残留会钉住 `gc_obj_list`，`dispose` 即触发 QuickJS teardown 断言 abort（WASM 层 SIGABRT，宿主 try/catch 抓不住，直接杀死整个 vitest worker、全量陪葬）。`oomCleanup` 前后各排空一次；`sandbox.test.ts` 连续 3 次 27/27 通过。
- **sendspin `seekCore` 类型修正**：v4.0.2 带入的 TS2345（ephemeral 假组传给 `pumpFor`），改用 `srv.group` 取真组，`tsc` 干净。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.3` + `:latest`

## [4.0.2] - 2026-09-21

### 修复 —— 拖动进度条问题（分播放器逐一修复）

- **sendspin 拖动后无法播放/进度不对**：`seekCore` 只写 `positionMs` 标记，pump 主循环下一帧即按下标覆盖（进度回跳、音频原地），且不钳制 duration（拖到尾直接触发播完→跳歌/停播）。改为走组 pump 跳转（含 clamp＋流式窗口 `-ss` 重起）；暂停态拖动保持暂停（与 DLNA/Web 同语义）。
- **timeOffset 接受 0.1s 粒度小数**：新增 `parseTimeOffset`（4 处替换 `parseInt`，非法/负值归零），ffmpeg `-ss` 前置定位直接支持小数。整秒 floor 时代的系统性 `<1s` 偏小是 Web/客户端「进度定位不对」的来源之一。
- DLNA/AirPlay/group/local 本体核实无害（REL_TIME 整秒是设备规范；AirPlay 有 FLUSH＋换 decoder；group fan-out；local 转发），坏的都在调用侧，已由三端（Web/客户端/HA）配套修复。

### 配套

- Web 前端：seek 越界钳位 `duration-0.5s`、拖动开始快照 autoplay、`localSeekActive` 跟手保护、时长按 `song.duration` 播种、0.1s 粒度 timeOffset。
- 客户端 **v5.0.19**、HA 卡片 **v2.4.3**、HA 集成 **v2.0.2** 同步发版（四端同批）。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.2` + `:latest`

## [4.0.1] - 2026-09-21

### 修复 —— 播放结束判定与卡死兜底

承接 4.0.0 的「出流管道化」：本版不新增能力，只把「一首歌什么时候算放完」「卡住了怎么办」
这两件事的判据补齐到与上游 MA 同口径。

- **卡死兜底 60s → 15s，判据改为墙钟累积**：旧判据是「相邻两次 IDLE 上报间隔 > 60s」，
  但设备采样固定 5s 且每次上报都把 `updatedAt` 刷成当前时刻 → 差值恒为 5s，**生产里永远
  触发不了**；唯一的可达旁路（队列停轮询 / advancing 占用超 60s）触发时，恰好会去重投一个
  **已经播完**的队列。现在改为「进入 IDLE 记时刻、离开即清」的墙钟累积，与采样频率解耦。
  阈值 15s 与 `dlna/control.ts` 的 `TRANSPORT_STATE_CACHE_MS = 15000` 同口径。
- **cast 失败不再静默**：`playCurrent` 的 catch 原先只 `endOptimistic` 就返回 —— 这首既不
  重投也不切歌，队列就此停死（设备瞬时离线时表现为「再也不播了」）。现在接入既有 stalled
  通道（复查 → 每首最多重投一次 → 第 2 次放行切歌），并按「一整圈」（2×曲数）封顶，防止
  整队都投不出去时无界绕圈；到顶即判整队不可播。
- **已结束 / 未激活队列不重投**：卡死阈值降到 15s 后 stalled 路径才**真正可达**，而它原先
  全程不看 `q.isActive` / `q.ended`。加护栏，置于最前、零副作用。
- **乐观窗口拆成两段**：原实现「cast 命令发出前」就起 5s「等设备确认 PLAYING」计时，而那 5s
  会被 `Stop → SetAVTransportURI → Play` 三次 SOAP 往返（单次超时 8s）吃掉，判出的 stalled
  只是「命令还没发出去」。拆为 `beginOptimistic`（阶段 1，仅屏蔽切歌瞬态）与
  `armOptimisticTimeout`（阶段 2，cast 送达后才起计时），对齐 MA `PLAYBACK_START_TIMEOUT = 5.0`
  「命令送达后起算」的语义。

### 配套

- 客户端 **v5.0.18** 同步补齐：直投 DLNA 时 `getTransportInfo` 读失败返回的 `UNKNOWN` 不再与
  真 `STOPPED` 同判，15s 宽限窗口内沿用最近一次成功读数（与服务端 `TRANSPORT_STATE_CACHE_MS`
  同口径）—— 修「时长未知的曲目上一次 SOAP 读失败就被误判放完 → 曲中段切歌」。

### 构建信息

- Docker 镜像：`ray5378/musicflow:4.0.1` + `:latest`

## [4.0.0] - 2026-09-20

### 大版本 —— 音频出流全面管道化

版本号从 3.0.x 跳到 **4.0.0**：本版不是补丁累加，而是把「出流」这件事整体换掉了做法。
原先每条链路各转各的、必要时才转码（存在若干**原样直出旁路**），现在 HTTP / Web / DLNA /
Sendspin / AirPlay 五条链路统一走同一条**六段流水线**：

> ① 解码成 F32 → ② 响度归一化 → ③ DSP（音色）→ ④ 交叉淡入 → ⑤ 限制器 → ⑥ 编码输出

已清掉全部直出旁路（`?raw=1` 直透、`serveWebSongStream`、`serveDlnaWebStream`），
**没有「绕过管道」的路径了**。

### 新增 —— 听得见的能力

- **换歌不再忽大忽小（② 响度归一化）**：每首歌拉到同一目标响度，默认 −14 LUFS，
  可在「音频」页配成 −30…−5（对齐 Music Assistant 的区间）。有离线测量值时走静态增益，
  没有则走实时 loudnorm —— 两种口径共用同一个解析函数，不会互相打架。
- **交叉淡入（④，默认关）**：连续播放时两首歌重叠过渡，时长 1…15 秒（默认 8 秒），
  在「音频」页开启。只在**顺序播放**下生效：洗牌 / 单曲循环 / 列表循环的「下一首」
  不由队列下标决定，拼流会与设备真实顺序打架。
- **每台设备独立音色（③ DSP）**：前级增益 / 三段音色（低中高）/ 左右平衡 / 参量 EQ，
  按设备存、不跟账号走。参量 EQ 是手算 biquad 系数（不用 ffmpeg `equalizer`），
  高/低通可选 12 / 24 / 48 dB/oct 陡度（级联 Butterworth）。全 0 = 不加滤镜、零开销。
- **本地行离线预测量（默认关）**：提前跑一遍响度分析，起播直接走静态增益，省掉实时 loudnorm。

### 新增 —— Web 端「音频」页

侧边栏新增「音频」模块，「音频管道」「设备音色」两张卡片从「设置」页整块搬过来，
并加上「音量归一化」。每张卡片都能单独开关：全局总开关 × 四个通道（HTTP / DLNA /
Sendspin / AirPlay），DLNA 还能**按设备单独回退**（某台老音箱听不了就只给它关掉）。
管理员可见全部，仅被授予播放权限的账号只能看到自己能控的设备的音色。

### 修复 —— 全量代码审核抓出的 5 处缺陷

管道化的错误几乎都是「不报错、只是难听」，所以本版对全部相关代码做了一轮审核：

1. **交叉淡入静默丢掉上一曲尾段**：下一曲首段短于过渡窗口时，那段既没播出也没参与混合，
   最长丢一整个窗口（默认 8 秒）且**完全不报错**。
2. **ffmpeg 日志保留方向反了**：缓冲区到上限就不再追加 ⇒ 冻结在**流的开头**，
   而 loudnorm 的测量报告打在**末尾** ⇒ AirPlay 超过约 5.7 分钟、Sendspin 超过约 11.5 分钟的
   曲目**永远解析不到响度值**（静默失败）。已统一为「超限丢开头、末尾永远在」。
3. **DSP 端点越权**：音色是设备属性，原实现只校验「有播放权限」⇒ 任意可播放账号都能改
   **全服务器每台设备**的 EQ。已补设备级授权（`canControlPeer`）。
4. **高/低通缺了陡度维度**：只有单节（用 Q 值），补上 12 / 24 / 48 dB/oct 级联选项。
5. **残留的向后兼容迁移块**：`audio_analysis` 表的 `PRAGMA` 探列 + 补列已删（本项目的既定约定）。

### 变更 —— 客户端与接口侧需要知道

- **HTTP 流式 seek 改按服务端能力判定**：4.0.0 起所有 HTTP 流都是实时流（无直传旁路），
  字节 Range 失效，seek 改为带 `timeOffset` 重拉。客户端按服务端版本号门控（≥ 3.0.47 即启用，
  4.0.0 满足）；Navidrome 等其他服务端不受影响，沿用旧判定。
- **DLNA 全通道走管道**：cast / enqueue / DIDL 的 MIME 三处同步，音箱兼容头
  （`contentFeatures` + 12 小时假长度）恒定带上。
- **并发转码槽拆成三个独立池**：`quality`（音质转码）/ `pipeline`（实时管道）/ `flow`（交叉淡入），
  互不抢槽，上限按 CPU 核数派生。
- **DB 新增 2 张表**（`audio_analysis`、`player_dsp_configs`）：均为**一次性建表**，
  本版不做旧数据迁移（自用项目的既定约定，升级即重建）。

### 验证

- `tsc --noEmit` 0；7 个静态门禁全 0（`check-i18n` 1347 键中英对齐）。
- 前端 `vue-tsc && vite build` 通过。
- 后端 **139 个测试文件 / 1236 例**全绿；新增的 31 例（设备授权 8 / 陡度 9 / 归一化 14）
  全部做了**负向验证**——先把修复改回旧行为确认测试确实变红，再还原。

## [3.0.46] - 2026-09-20

### 修复 —— judge 正缓存盲信：扫描确认可播、播时已死的歌照推

- 新增共享 `recheckOnlineDirect`（在线直链短超时复核）：judge 在正缓存命中时
  先复核，直链明确已死（404/403/410）则逐出正缓存、找兄弟/远程替代，
  无替代直接跳过（知识非未知，不违"不误杀"边界）；预探测扫描侧改调同一函数。
- 清理 `refs/music-assistant-server/`（18MB 不完整 MA 源码）；音频流水线方案
  文档 MA 引证改为按 commit 拉取核对。

## [3.0.45] - 2026-09-19

### 修复 —— 预探测负缓存 45 秒导致坏源反复重试 + 补扫描可观测

**症状**：sendspin 播放中，持久性坏源（如已下架的酷狗直链 404）每次轮到都重试
约 30 秒（judge 现场探测 17s → 宽容放行 → pump 再探 16s → 失败）才跳过，
6 小时 25 次，体感"偶尔卡顿/断歌"。

**根因**：预探测把死歌标"不可播"只记住 45 秒（`negativeTtlSeconds`），而
lookahead 5 首 ≈ 15–25 分钟跨度——等播到那首时缓存早过期，judge 现场重探，
web 行又永远判不出"确定无源"，宽容尾巴只能放行再失败。

**修法**：`negativeTtlSeconds` 缺省 45→7200（2 小时）、上限 600→86400；
死歌学一次、2 小时内复播直接跳过。源恢复最长延迟该时长（直链下架不复活，
可接受）。附带：预探测每次扫描打一行 info（scanned/collected/deadRun），
此前成功完全静默、无从实证在跑；240 常驻监控脚本 `scripts/sendspin-monitor-240.sh`
（资源＋卡顿指纹＋坏源追踪＋进度停滞）。

**验证**：tsc 0 错；vitest 157 文件 / 1174 用例全绿；核心逻辑单测 hermetic 化
（模块 TTL＋配置行在 beforeEach 钉死，shuffle 乱序不再互串）。

## [3.0.44] - 2026-09-19

### 修复 —— ffmpeg 回环流恒 403（raw-stream 凭证跨进程不可见）

**症状**：v3.0.43 镜像（含 48ad83d 回环架构）上线后，Sendspin 播放仍失败，
ffmpeg 报 `Error opening input: Server returned 403 Forbidden`，输入已是
回环 URL `http://127.0.0.1:<port>/rest/dlna/stream/<token>?raw=1`。

**根因**：回环 token 的 raw-stream 注册表是**主进程内存 Map**，而 Sendspin
生产默认 **fork 模式** —— `streamEngine` 在**子进程**里 mint token、
`/rest/dlna/stream/:token` 路由在**主进程**里 resolve，Map 跨进程不可见，
token 永远查不到 → 恒 403。vitest 恒 in-proc（同进程共享内存），测试无法暴露。

**修法**：注册表落 SQLite `raw_stream_tokens` 表（WAL 多进程安全，与
`sendspin_device_state` 同模式），mint/resolve 全部走 DB，TTL 仍 30 分钟、
mint 顺带清理过期行。新增 `tests/services/rawStreamToken.test.ts` 回归锚点。

**验证**：tsc 0 错；vitest 156 文件 / 1170 用例全绿；240 实例注入修复后实测
Sendspin 音箱（ESP32）连续正常播放（pos 持续推进，403 消失）。

## [3.0.43] - 2026-09-19

### 修复 —— Sendspin / 转码 / 投屏链路带域名直链全部播放失败（ffmpeg DNS）

**症状**：Sendspin 音箱播放 WebDAV/网盘歌曲时，后端 ffmpeg 报
`Failed to resolve hostname xxx: System error`（exit 251）后跳曲；Web 客户端与本地播放（Node 代理链路）
完全正常 —— 因为只有 Sendspin / 转码 / AirPlay 这三条链路真正落到 ffmpeg 子进程。

**根因**：镜像里的 `ffmpeg-static` 是 **glibc 静态构建**（依赖运行时 dlopen glibc 的 NSS 库做域名解析），
而运行镜像是 **Alpine（musl）**——容器里根本没有 glibc 的 NSS 库，静态 ffmpeg 的 DNS 因此**全坏**
（实测对任何域名都报 `System error`，同一个二进制拿到 glibc 宿主机上正常）。此前没暴露，是因为
openlist 当时走本地代理、没有 302 出公网域名；直链一出现即命中。

**修复（Dockerfile）**：runtime 阶段 `apk add ffmpeg`（musl 动态版，实测 8.1.2，含 libopus 编码 /
flac 解码）并设 `ENV FFMPEG_PATH=/usr/bin/ffmpeg`。代码零改动 —— sendspin/encoding.ts、
transcode.ts、airplay/decoder.ts 三处 `ffmpegBin()` 本就优先读 `FFMPEG_PATH`，一条环境变量同时修好
三条链路。

## [3.0.42] - 2026-09-19

### 清理 —— dailyRecommend 的旧表 / 旧设置兼容代码（接续 3.0.41 的「不考虑向后兼容」）

接续上一版定调，把每日推荐里最后一批只为「升级用户」存在的兼容分支删掉：

- **`services/plugin/dailyRecommend.ts`**：删除 `loadCandidatesFromSettings()` / `findPlaylistByName()` /
  `purgeOldDailyPlaylists()` / `DAILY_TAG_LOCAL`；`saveCandidates()` 不再往 settings 表双写候选；
  `ensureDailyPlaylists()` 简化为「缺则建」，移除旧歌单认领与「今日推荐」→「每日推荐」的改名逻辑
  （+12 / −61）。
- **`db/index.ts`**：移除 `daily_recommend_candidates` / `daily_recommend_retention` 两条种子语句（−9）。
  候选与保留期现在只由 `dailyRecommend` 自己的表承载，老库重建即可。

### 文档 —— 全仓文档时效性梳理（25 个文件）

- **校准硬数字**：OpenSubsonic `/rest` **51** 端点、DB **37** 张表、内置插件 **18** 个（source 0，
  go-music-dl 已外置）、`PluginType` **10**、`PluginCapability` **≈25**；文件名统一小驼峰。
- **修正 4 处与实现相反的描述**，含 1 处代码注释：播放器管理页的离线实例并非「自动消失」，而是
  **保留该行并打「离线」标签**（只有队列会被回收、只有流转选择器会剪掉别的离线实例）。
- **回标落地状态**：3 份方案类文档（player-unification / memory-optimization / sandbox-limits）补
  「已落地 / 部分 / 未做」；**8 份带日期的历史文档**顶部加「⏳ 历史快照」横幅（内容不重写）。
- **删除 2 处已失效的发版步骤**：PLUGIN_ARCHITECTURE / sandbox-limits 里指向已删除 addon 仓库的
  同步发布步骤。

### 修正 —— 两处名不副实的 CI 文案 + 一处与实现相反的注释

- `backend/scripts/check-builtins.mts` 头注释与 `ci.yml` 的 step 名原写「校验 7 个内置插件 manifest」，
  而该清单实际只覆盖 18 个内置插件中的 **13 个** → 改为据实描述（**未扩清单**；扩清单需连带改插件
  manifest、能力白名单与权限白名单，属独立改动）。

## [3.0.41] - 2026-09-19

### 清理 —— 删除 DB 字段迁移 / 兼容代码（项目自用，不考虑向后兼容）

定调：本项自用、本地升级即可，**不为老库/老字段保留兼容分支**。据此整段删除两处只为「升级用户」
存在的迁移逻辑（5 文件，+2 / −169）：

- **旧版 Sendspin 全局密钥继承**（`services/sendspin/deviceState.ts`）：6053 密钥从「插件页一把全局」
  改为「每台设备各自一把」时，曾留了一个继承窗口——服务启动后 10 分钟内连上来的设备，把
  `plugins.config` 里的旧全局密钥（`esphome_psk` / `esphome_port`）抄成自己那一行的密钥，以免升级后
  静默失联。现连同 `readLegacyPluginEsphome()` / `inheritLegacyEsphomePsk()` 一并移除；子进程
  （`sendspin/child.ts`）与主进程（`sendspin/index.ts`）两条设备注册路径里的调用同步删掉。
  设备现在**只认自己那一行**的密钥，不再读任何旧字段。
- **`sendspin_device_state` 的 PRAGMA 探测补列**（`db/index.ts`）：老库缺 `disabled` / `esphome_psk` /
  `esphome_port` 时用 `ALTER TABLE ... ADD COLUMN` 幂等补齐的那段循环已删除（新库由 `CREATE TABLE`
  一次到位；老库重建即可）。**今后新增字段直接改进 `CREATE TABLE` 语句，不要再加补列迁移。**

`deviceState.test.ts` 相应删掉 7 个迁移用例（旧字段读取 / 继承落库 / 不覆盖已有密钥 / 端口优先 /
只继承一次 / 窗口期判定 / 无旧密钥与空 clientId），全量回归因此从 155 文件 1172 例变为 155 文件 1165 例。

## [3.0.40] - 2026-09-19

### 测试 —— 补上渲染器子进程 fork 路径的冒烟测试（此前零覆盖）

`mode.ts` 见到 `VITEST` 一律返回 false，业务侧测试**永远不可能真的 fork** —— 于是
「生产里 supervisor 到底有没有 fork 起子进程」此前只由注释与 CHANGELOG 背书，一条断言都没有。
本版绕开 `isRendererForkMode()`，直接构造通用宿主 `RendererHostSupervisor` 并指向一个纯 JS
夹具子进程，真的过一遍这条路径：fork → mainReady 握手（断言载荷真的过了 IPC 边界）→ RPC 往返
（断言响应里的 pid 就是被 fork 的子进程）→ 快照进镜像 → `kill -9` → 退避重启（新 pid 可继续
服务）→ 优雅 `stop` → 「启动即退」的失败分支。整套约 3.5s。

夹具用 `.mjs` 而非 `.ts`（`tests/rendererHost/fixtures/stubRendererChild.mjs`）：`fork()` 直接跑
node，不依赖任何 TS loader，因此与 vitest 的 `process.execArgv` 完全解耦。

### 可观测 —— AirPlay 推流节拍指标 `reanchors` / `maxGapMs` 对外可见

这两个数此前只在 `stream()` 收尾时打一行日志：只能事后归因、拿不到趋势，也无法在播放**过程中**
判断「此刻是不是已经被拖垮」。现在：

- `RaopPlayer.realtimeStats` 暴露 `{ chunks, reanchors, maxGapMs, elapsedMs, lossRequests }`；
- 进会话镜像 → `getAirPlayStatus().stream` 与 `getAirPlayPeerStatus().stream`（HTTP 可直接 curl），
  fork 与 in-proc 两条路径读同一份语义；
- 会话运行期每 15s 打点一行趋势；`reanchors > 0` 或 `maxGap > 50ms` 升级为 warn，便于日志过滤。

至此开启 `MUSICFLOW_AIRPLAY_FORK=1` 的两个前提（架构就位 + 可观测）都已具备。

### 验证

`tsc` + 9 项静态门禁 + 全量回归（155 文件 / 1172 用例，较 3.0.39 新增 1 文件 / 10 用例）全绿。

## [3.0.39] - 2026-09-19

### 重构 —— 抽出「常驻渲染器子进程」通用宿主 `services/rendererHost/`

sendspin 自 3.0.34 起跑通的那套「常驻子进程」模式（fork / mainReady 握手 / 心跳看门狗 /
退避重启 / 优雅 stop / RPC / 状态镜像）此前只有它自己一份实现，AirPlay 要照抄就会变成
两份各自漂移的 IPC 契约。本版把它抽成通用层，业务只声明自己的载荷与 op 表：

- `RendererHostSupervisor`：主进程侧宿主（fork、握手、看门狗、退避重启、`rpc`/`post`、镜像容器、事件分发）；
- `ChildRpcHost`：子进程侧控制器（`req`→`res` 按 id 回填、快照 150ms 节流 + 1s 兜底扫、心跳、stop 生命周期）；
- `ipcProtocol`：通用信封类型与常量。用 `({ t: "state" } & TSnapshot)` 这类交叉类型承载业务载荷，
  所以**消息的运行时形状与重构前完全一致**（仍是 `{ t:"state", clients, groups, … }`）；
- `resolveChildEntry`（prod `.js` / dev `.ts`）、`isRendererForkMode`（三态模式判定，只有默认值不同）、
  `createFrontAccessor`（fork→代理、in-proc→真实实例）、`childBootstrap`（致命异常兜底 / 数据层 / 消息循环）。

**Sendspin 已迁移到通用层，行为不变**：`sendspinSupervisor` 单例、`SendspinChildController(deps, send)`
构造签名、全部公开 API、IPC 消息形状、日志文案都保持原样，由既有 sendspin 测试（39 文件 / 221 用例）守等价。
此后新增渲染器（airplay2、cast、roon…）照 `rendererHost/index.ts` 顶部的六步清单接线即可。

### 新功能 —— AirPlay RAOP 推流会话接入子进程（默认关闭）

AirPlay 的推流是「每 352 帧（≈7.98ms）一个 RTP 包」的墙钟节拍循环，且 ALAC 位打包与
AES-CBC 加密都在 JS 侧 —— 与 sendspin 同构，只是节拍更紧（7.98ms vs 25ms），此前却留在主进程：
一次长阻塞、一次封面缩图、一次后台批量任务都会直接体现为 `reanchors++` 与真机断音。

- 新增 `services/airplay/{sessionRuntime,childMain,child,supervisor,mode,ipcProtocol}.ts`：
  子进程持有 RTSP 会话 + ffmpeg 解码 + 推流节拍；**不碰 DB、不注册插件**（符合 SPEC「每进程一个
  SQLite 连接」——子进程压根不新开）。
- **主进程保留**设备发现（mDNS）、`airplay_devices` 持久化、DLNA 双协议互斥、`createCastSession`
  取 token 化 streamUrl、peer 注册、`volumeState`/`lastCast`：它们要么状态密集要么纯 I/O，搬进去只会多一跳 IPC。
- 状态读走**镜像**（`getAirPlayStatus` 会被 QC 每 5s、DLNA announce 每 500ms 调用，绝不能每次打 IPC），
  命令写走 RPC；会话结束由子进程发 `sessionEnded`，主进程照旧上报 IDLE 让队列自动续播。
- 解码/缓冲层（ffmpeg spawn + 有界 PCM 队列 + 音量 dB 换算）抽到 `services/airplay/decoder.ts`，
  两条路径共用同一份实现。
- **默认仍是 in-proc**：开发机没有 AirPlay 设备，这条路径无法端到端验证，所以先只把能力就位。
  显式 `MUSICFLOW_AIRPLAY_FORK=1` 才启用（`MUSICFLOW_AIRPLAY_INPROC=1` 可临时回落）；
  真机验证无回归后，把 `services/airplay/mode.ts` 的 `defaultFork` 翻成 `true` 即与 sendspin 对齐。

**顺带修掉一处真实缺陷**：`startSession` 里 `makeProducer(ff)` 建了一份却丢弃（变量未使用），
那个 producer 的 stdout `data` 监听器仍在 —— 它会把整首歌的 PCM 再缓存一份且无人消费（内存翻倍），
还会与真正在跑的 producer 争抢 `pause/resume` 背压，表现为间歇性卡顿。现在只建唯一一份。

### 门禁 —— 新增 `check-renderer-host.mjs`（CI: renderer-host-guard）

「重活必须落到独立进程」此前只是惯例：7 个 check 脚本 + 8 个 workflow 关键词扫描 **0 命中**
（SUP 红线和 sendspin 的 fork 都只靠注释与 CHANGELOG 背书）。新增静态守卫，三条规则：

- **R1** `backend/src/services` 下只允许 `rendererHost/supervisor.ts` 出现 `child_process.fork`——
  禁止各业务再自建一套 supervisor；
- **R2** 命中「deadline 循环形态」（墙钟取时 + `setTimeout` 自排 + 定长分块三条全中）的文件，
  必须落在**本业务**`child.ts` 的 import 闭包内，否则要么接宿主、要么显式豁免
  `// allow-main-process-render: <理由>`。
  （按业务归属判定而非「任一闭包」——实测 sendspin 的子进程闭包会跨业务拖进 `airplay/raop.ts`，
  只判「任一闭包」会让谁都没接宿主的情况蒙混过关。）
- **R3** 声明为渲染器业务的目录必须具备 `child.ts` + 用 `RendererHostSupervisor` 的 `supervisor.ts`
  + 用 `isRendererForkMode` 的 `mode.ts`。

**DLNA 不在守卫范围内**，这是有意的：DLNA 的 `/rest/dlna/stream/:token` 是字节代理 + Range，
渲染器自己回连拉流，服务端没有任何节拍循环（实测该目录零 `child_process`、定时器全是等待/续订语义），
进程化纯属浪费。守卫只认「节拍形态」不认目录名 —— 将来谁写下节拍循环就自动被要求接宿主。

### 验证

`tsc` + 9 项静态门禁 + 全量回归（154 文件 / 1162 用例）+ 前端 `vue-tsc && vite build` 全绿。

## [3.0.38] - 2026-09-19

### 新功能 —— ESPHome 6053 密钥独立入口（与设备音量彻底分开）

- 播放器页 Sendspin 设备行原本把「密钥 / 端口 / 测试连接」和设备音量滑杆挤在同一个
  弹窗里，现拆成两个独立弹窗：新增**「ESPHome 密钥」**按钮与独立弹窗，行内两个按钮
  各自反映连接状态。
- 密钥回显分级：`GET /v1/sendspin/devices/:clientId/esphome` 仅对持有
  `renderer.manage` 的账号回明文 `psk`（管理员恒有），其余账号只拿到
  `pskConfigured` 布尔值；**设备列表端点始终不回显** —— 一次列表把所有设备的密钥
  全吐出去毫无必要，弹窗打开时按需单取一台。
- 设备行内「解绑」与「重命名」两个按钮互换位置。

### 新功能 —— AirPlay 主动扫描（与 DLNA 扫描语义对齐）

- 新增 `POST /v1/airplay/scan`（`renderer.use`）：立刻重发一次 mDNS(`_raop._tcp`)
  查询，并把命中的接收端 `upsert`（新增 + 落库 + alive 事件）—— 刚上电、常驻
  browser 还没捞到的接收端，点一下就出来。插件关闭时是**立即 resolve 的 no-op**，
  随后回当前列表。
- `services/airplay/discovery.ts` 抽出 `spinQuery()`：常驻 30 秒续期与主动扫描共用同一条
  「短命新 browser 句柄」通路，避免两套发现逻辑各改各的。

### 优化 —— 四个设备区块头部统一为「扫描」

- 客户端 / DLNA / AirPlay / Sendspin 四个区块头部只保留一个贴右边缘的「扫描」按钮
  （原来 AirPlay / Sendspin 叫「刷新」）。根因：`.section-head` 是
  `justify-content: space-between`，Sendspin 头部有 3 个孩子时中间那个必然被挤离右边缘。
- 「添加播放器」保留不删，从头部移到 Sendspin 列表盒子下方、右对齐。
- 修正客户端区块说明与实现不符：「离线后自动消失」→「离线后该行保留并打「离线」标记」
  （后端对 local peer 只 `markLocalOffline()`，从不删行）。

### 优化 —— 流式解码窗口高水位 60 → 30 秒（与 MA 对齐）

- `WINDOW_HIGH_SEC` 60 → 30：PCM 窗口内存上限 ~23MB → **~11.5MB**（＋5 秒历史环 ~2MB），
  与 MA 的 `sleep_to_limit_buffer(30 秒)` 齐平；`WINDOW_LOW_SEC` 保持 20。
  代价：seek 回跳更可能落出窗口、按 `-ss` 重建解码（约 1 秒空窗），越界频率继续在
  240 soak 观察。插件配置页帮助文案与 `docs/SENDSPIN_MULTIROOM_STREAMING_PLAN.md`
  的内存对照表同步。

### 验证

- `tsc --noEmit` 0；`vue-tsc` + `vite build` 0；`check-i18n` 0；
  `vitest run` **154 文件 / 1162 用例全绿**；7 项门禁
  （frontend-plugins / overlays / element-overrides / fixed-playlist-ids / core / i18n）全 0。
- 新增 `backend/tests/airplay/rescan.test.ts`：守住「插件关闭时扫描立即返回、不卡 loading」。

## [3.0.37] - 2026-09-18

（本节为补记：该版打 tag 时未写 CHANGELOG 条目，内容据 `v3.0.36..v3.0.37` 提交历史整理。）

### 新功能 —— Sendspin 设备音量持久化 + 流式解码开关进配置页

- 设备音量（6053 桥）持久化并全端回显（`sendspin_device_state` + `peerVolume.ts` + WS 广播）。
- 流式解码开关（`stream_source`）进插件配置页，默认开启。
- 文档补解码内存与 MA 的对照结论。

## [3.0.36] - 2026-09-18

### 新功能 —— Sendspin 真多房间组（与 DLNA 组统一语义）

- **流式解码**（默认关，`SENDSPIN_STREAM_SOURCE=1` 开启）：`PcmWindow` 滑动窗口
  （长命 ffmpeg＋60 秒窗口＋真背压），子进程内存预计从 ~300–570MB 降到 ~120MB；
  `GroupPump` 双路径（整包/窗口），时长未知不钳制 position。
- **用户组多房间**：成员 id 命名空间化（`sendspin:`/`dlna:`/裸 id＝DLNA）；
  组内 sendspin 成员共享单 pump 同一时间线（`ug:<组id>` 组），双成员首帧同 ts；
  播中加入走直播沿（无需历史），摘除收 stream/end；离线可建组。
- **组管理 API**：`POST /v1/groups/:id/members` 增量原子口（幂等、无读写竞态，
  供 Flutter 随时加减）；PUT 沿用精确顺序并共用加入对齐钩子；
  mute/volume/status/playback 按 kind 扇出；群组对话框可选 sendspin 设备。
- 全量验证：`tsc`＋`vue-tsc`＋`vitest` 146 文件 / 1080 用例全绿。

## [3.0.35] - 2026-09-18

### Bug 修复 —— Sendspin 链路两处回归 + CI 测试隔离

- **mute 接口 500**(`index.ts`):`getSendspinFront()` 把 `isForkMode()` 误传给形参
  `inProc`，布尔反转导致双模式下恒返回 null，`/v1/peers/:id/mute` 报"服务未运行"。
  改为 `!isForkMode()`，一行恢复（生产 fork 模式的 mute 同 bug 同修）。
- **第二次播报卡死**(`encoding.ts`):`LibFlacEncoder.flush()` 调
  `FLAC__stream_encoder_finish` 终结编码流，而组编码器在多次播报/切歌间复用，
  之后再 `encode` 在 asm 堆内空转永不返回，卡死整进程事件循环（一次 FLAC 播报后
  后续播报/推流全挂）。现 flush 取走尾帧后原地重建新流，对象保持可用，
  `codec_header` 照常重建；音乐推流路径从不 flush，行为不变。
- **测试间 fetch 污染**(6 个测试文件):模块级 `vi.stubGlobal("fetch")` 从不还原，
  同进程串行时 `proxy` 直连测试读到 `"stream-bytes"`、TTS 拉取进 ffmpeg 报错。
  各文件 `afterAll` 加 `vi.unstubAllGlobals()`，生产代码零改动。
- 全量验证：`tsc` + `vitest` 142 文件 / 1060 用例全绿。

## [3.0.34] - 2026-09-18

### 架构 —— Sendspin 强制独立子进程(fork 隔离)

- **动机**:sendspin 推流是 25ms 节奏的硬实时循环(解码 → FLAC 编码 → 逐帧下发),
  与主进程(API 路由 / 后台批量任务 / 前端状态轮询)共享事件循环时,任何长任务都会
  顶住推流节奏,表现为真机端周期性卡顿。现把**整个 sendspin 运行时**(WS 38927 +
  mDNS + 拨号重拨 + 解码/编码/推流 + ESPHome 6053 只读桥)fork 进**专属常驻子进程**,
  事件循环与主进程彻底隔离。
- **通信协议**(`ipcProtocol.ts`):状态读走「快照推送」(脏了立即推,150ms 节流 +
  1s 兜底扫);命令写走 RPC(自增 id 回填,超时 25s / stop 15s / announce 360s);
  心跳 30s,主进程看门狗 3 周期无心跳即判定卡死并退避重启(3s→30s,稳定 5min 复位)。
  `positionMs` 高频字段**不进快照**,走 poll 轮询,防 IPC 风暴。
- **状态镜像 + 命令代理**(`proxy.ts`):主进程不再持有 server 实例 —— 路由/外围代码
  统一经 `getSendspinFront()`:fork 模式返回镜像代理(同步读快照、写走 RPC、mute
  setter 本地即时反馈),in-proc(单测/子进程自身)返回真实 server,调用方**零分叉**。
  类型哨兵 `AssertServerLike` 编译期锁定代理与真实 server 的公共结构。
- **核心下沉**(`playerCore.ts`):推流操作核心(play/stop/pause/seek/volume/poll/
  announce 等)从 protocolPlayer / announce.ts 原样抽取,跟随真实 server 进程运行,
  不 import QueueController/PlayerManager —— 主进程状态(队列冻结/恢复/播放器注册)
  留在主进程。播报现场(在播/进度)拆出 `announceProbeCore`,必须在 `qc.deactivate`
  **之前**捕获(时序坑:deactivate 清 current,之后捕获恒为零)。
- **配对密钥不外泄**:镜像快照**剥离 `pskHex`/`pskId`** —— 配对密钥永不出子进程;
  端口变更等配置热更新经 RPC `applyCfg` 下发,主进程 DB 仍是配置单一可信源。
- **崩溃自愈**:子进程 uncaughtException → exit(1),supervisor 退避重启;`stop` 走
  优雅关停(反注册/关连接/停 mDNS)后退出。单测与子进程共用 `MUSICFLOW_SENDSPIN_INPROC=1`
  装配路径,测试路径 = 生产路径(新增 `childMain.test.ts` 8 例:快照剥离 PSK /
  RPC 回包契约 / announceProbe 时序 / unpair 断连)。
- 文档:`docs/SENDSPIN_FLAC_ROADMAP.md` 标记完成(任务 1 真机基线一次达标:flac +
  codec_header 协商生效,零 Lost sync / 零解码报错 / 零 underrun,任务 2 无需进行)。

## [3.0.33] - 2026-09-18

### 文档

- 新增 **FLAC 链路专项开发任务书** `docs/SENDSPIN_FLAC_ROADMAP.md`:核心矛盾
  (25ms 喂料 vs libFLAC 块攒样脉冲)、真机基线验证步骤、消脉冲方案阶梯
  (compression 0 → 块对齐喂料)、micro-flac `BAD_BLOCK_SIZE` 约束、验收清单;
  链接真相文档与踩坑录,作为后续 FLAC 打磨的唯一起点。

## [3.0.32] - 2026-09-18

### Bug 修复 —— Sendspin 音量「回退」与增益标度

- **音量增益平方根因**:`setVolume` 此前同时写 `conn.volume` 与 `group.volume`,
  而 `appliedGain = conn.volume × group.volume / 100` ⇒ 实际下发增益 **= vol²/100**
  (拖 50 实得 25)。现只写**组音量**(单设备组的权威标度),每连接 trim 保持缺省 100;
  PCM 链路在 `pushFrame` 的 `scalePcm` 里按帧生效。
- **`/status` 音量回读源改为组音量**:原先回读 `conn.volume`(恒 100),会把前端
  刚拖的值顶回去。
- **前端轮询陈旧保护**(插件 `isStaleSample`):无 `reportedAt` 的设备型 peer
  (sendspin / DLNA)在命令下发后 **1.5s 短窗**内一律视为陈旧采样,防止
  「拖 20 → 立刻拖 30」时 2s 轮询把服务端仍停在的 20 顶回 UI;
  下发时刻改为**按设备**记录(切换播放端互不误伤)。窗后恢复同步,
  设备端自己的改动仍能及时镜像。

### 附带

- **ESPHome 6053 只读监控(在 sendspin-renderer 插件内)**:设备 IP 从 Sendspin
  拨入连接自动派生(无需手填);插件配置页新增 `esphome_mirror` 开关、
  `esphome_psk` 密钥(带常显「测试连接」按钮,保存前即可验证,成功回显
  设备名/版本/播放状态,失败给出原因);`GET /v1/sendspin/esphome` 只读查询
  (绝不回显 PSK)。依赖 `esphome-client@^2.0.0`(零第三方依赖)。
- 插件配置页新增 `preferred_codec`(PCM / FLAC 下拉,默认 PCM)。
- 文档:`docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` 重写为验证过的真相版;
  被推翻的旧结论沉淀为 `docs/SENDSPIN_PITFALLS_2026-09-18.md`。

## [3.0.31] - 2026-09-18

> 本条合并了此前**预写但从未发布**的 `[3.0.30]` 与 `[3.0.31]` 两个条目 —— 它们都只写了 CHANGELOG
> 而没打出 tag,远端最新 tag 仍停留在 `v3.0.29`,因此两版内容并未发布到任何用户手上。
> 现两版描述的修复已全部完成,合并为一次发布。
> 权威记录(真相版):`docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`
> 走错的路(踩坑录):`docs/SENDSPIN_PITFALLS_2026-09-18.md`

### Bug 修复 —— ESP32 真机**出声,并且零卡顿**

⚠️ **勘误**:较早版本的 CHANGELOG 曾把「STREAMINFO block size 4096」写成**决定性根因**、
把音频帧头写成「9B → **13B**(带 `send_ahead`)」、把协商顺序写成「flac 优先」——
**这三条均经设备端源码取证推翻**,已从本次记录中删除。真实根因如下(全部真机验证):

- **① 音频二进制帧头必须是 9B(决定性)**:设备 `sendspin-cpp` 只剥 1B type,其
  `player_role.cpp` 常量 `BINARY_TIMESTAMP_SIZE = 8`,8B 时间戳之后**一律当作编码音频**。
  此前多塞的 4B `send_ahead` 落在 payload 头部 → 首字节 `0x00` 而非 FLAC 同步字 `0xFF`
  → 每包 `Serious error decoding FLAC file` → **完全无声**。
  且 `send_ahead` 在整个 sendspin-cpp 源码库中**零出现** ⇒ 它根本不是 wire 字段。
- **② 时间线必须按实际产出推进**:编码器攒样期若按喂入量推进,时间线会超前约 75ms →
  设备报 `Lost sync (75006us off)` → 往音乐里**插静音**补空 → 卡顿。
  改为「无产出不推进」,零产出超 500ms 才降级(避免编码器真失效时时间线冻结)。
- **③ pacing 改为绝对时刻调度**:固定 `sleep(25)` 之外还有 encode/send 开销,实际周期约 26ms
  而时间戳只推 25ms → 每包落后 1~1.8ms 并**单向累积**(实测漂到 −611ms);
  设备 hard sync 阈值仅 **5ms**,越界即插静音 → 听感「一卡一卡」。
  改为 `due = start + i * frameMs / speed`,误差 ±0.5ms 正负自校正。
- **④ 冷起播是空操作**:`POST /peers/:id/play` → `resume()` 在「队列 `isActive` 但从未起播」
  时是空操作 → 无 `playMedia` / 无 `stream/start` = 静默。改为 `pump.active` 则原地 resume,
  否则走 `playMedia` 冷起播。
- **⑤ 脏 dial 目标致 `goodbye: another_server` 死循环**:`dial_targets.json` 残留设备自身端口
  `8928`,服务端每 60s 拨过去被判为竞争第二个 server 并踢回,继而触发 `noAutoRedial` 永久抑制。
  正确方向是**设备经 mDNS 自行拨入 38927**。
- ⑥ **协商顺序改为 PCM 优先、FLAC 兜底**(见下方新功能中的可配置项)。

### 新功能

- **默认音频编码可在插件页切换**:Sendspin 播放器插件新增 `preferred_codec`
  (**PCM(推荐,零延迟)** / **FLAC(省带宽)**),默认 PCM —— 设备侧对 PCM 只是一条 `memcpy`,
  零解码零攒样;FLAC 每 85ms 要解一个 4096 样本帧,低端 ESP32 易失步。
  偏好只决定**优先顺序**,设备不支持会自动退到另一种;切换**不中断当前流**,重新投一次歌即生效。
- **ESPHome 只读监控(6053)**:新增 `esphomeBridge`,对已连设备反向建立 Native API 连接,
  用于**保活**(设备掉网时不会因 `api.reboot_timeout` 看门狗自愈重启)与**只读状态镜像**
  (读回设备侧真实 `state` / `volume`,作为「服务端推的流有没有真的播出去」的外部判据)。
  - 插件页新增 `esphome_mirror` 开关 + `esphome_psk` 密钥;**设备 IP 自动派生,无需填写**。
  - 密钥输入框下方**常显「测试连接」按钮**,保存前即可验证:正确密钥约 2.6s 返回设备名/版本/
    当前播放状态;错误密钥约 **27ms** 即报 `Noise handshake failure`,不用干等超时。
  - 查询出口 `GET /v1/sendspin/esphome`(**不回显 PSK**);测试出口 `POST /v1/sendspin/esphome/test`。
  - ⚠️ 该链路**只做只读与保活**:设备 `featureFlags = 0x12520d` 不含
    `SEEK` / `NEXT_TRACK` / `PREVIOUS_TRACK` / `PLAY`,切歌与进度的权威始终在服务端;
    音量也请继续用 Sendspin 组音量(6053 的是 speaker 硬件音量,两者相乘会语义打架)。

### 文档

- `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md` **重写**为真相版,删除上述被推翻的结论。
- 新增 `docs/SENDSPIN_PITFALLS_2026-09-18.md`:11 个踩坑条目 + 共同模式 + 取证顺序清单。

### 实测结果(ESP32-S3 `esp32-player-meet` / ESPHome 2026.9.0)

- 出声三件套齐全:`speaker_mixer Starting` → `i2s_audio.speaker Starting` → `96000 ring_buffer`。
- 设备侧自报 `state=2 (PLAYING) / volume=0.36`;服务端 `Lost sync`、`Regained` 计数均**归零**。
- 播放连续推进、自动切歌正常,长时间无重启。
- 守卫:`tsc` 通过;backend sendspin **27 文件 / 116 用例**通过;`check-i18n` 四项通过;
  前端构建通过。

## [3.0.29] - 2026-09-17

### 变更（Sendspin ESPHome 真机出声联调 — FLAC 推流对齐 MA 金标准）

- **端口与 MA 解耦**：Sendspin 服务端监听端口 8927 → **38927**（避开 Music Assistant 独占的 8927，
  二者可在同一网关共存）。前端、renderer schema 默认、测试、文档全线同步。
- **音频协商对齐金标准**：`negotiateCodec` 改为 **FLAC 优先、默认 FLAC**（原 opus/PCM 被 ESPHome
  sendspin 客户端拒收或进不了 PLAYING）；键名兼容 `player@v1_support` 与 `player_support`。
- **音频帧头补全 send_ahead**：`packAudioChunk` 帧头 9B → **13B**（`>BqI`：1B `0x04` + 8B 大端微秒时间戳
  + 4B send_ahead ms），`sendAudio` 用组公共 `computeCommonSendAhead` 填值，对齐 aiosendspin wire 格式。
- **推流空包跳过**：ffmpeg flac 流式空缓冲不再上 wire，避免严格客户端判 `Invalid data`。

### 实测结果（ESP32-S3 真机 esp32-player-meet）

- 设备成功连入 `MusicFlow Sendspin`（discovery），完整走通 FLAC 48000/2ch/16bit：Group playing →
  Stream Started → codec header flac → speaker_mixer/ring_buffer 启动 → PLAYING；MusicFlow 侧位置持续推进且自动续播。
- **仍无确定声音输出**：主要怀疑 FLAC 实时编码（ffmpeg flac EOF 前零输出，`FfmpegPcmEncoder` 60ms 兜底
  只返回空包）。下一步详见
  `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`（分段 FLAC / send_ahead 单位核对 / PCM 回退验证等）。

### 文档
- 新增 `docs/SENDSPIN_ESPHOME_FLAC_2026-09-17.md`（本次专项：修复过程、排查方案、已验证方案、
  未出声的下一步方向、风险点、环境速查）。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.29`（同步 `ray5378/musicflow:3.0.29`）

## [3.0.28] - 2026-09-17

### 新功能
- **Sendspin 播放器自动发现**：浏览局域网 `_sendspin._tcp`，新设备出现即自动拨号
  接入（只发现、不自动播放），前端播放目标列表自动出现，无需手工 dial。
  与记忆重拨互补：没拨过的设备靠这个首次出现；`another_server` 等拒绝过的不再骚扰；
  同目标 60s 去抖；插件配置加 `auto_discover` 开关（默认开）。
  - 边界：发现逻辑归 `services/sendspin/discover.ts`；mDNS 层只加通用共享实例
    `getSharedBonjour()`（无业务认知）。

### 测试
- 新增 `discover.test.ts`（IPv4 优选/回退、启停幂等）；`pluginConfig.test.ts` 补
  `auto_discover` 缺省与开关；sendspin 相关 71/71 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.28`（同步 `ray5378/musicflow:3.0.28`）

## [3.0.27] - 2026-09-17

### Bug 修复（ESPHome Sendspin 真机联调，全部经 ESP32-S3 真机逐条确认）
- **legacy 握手补 `server/activate` + `group/update`**：此前只发 `server/hello`，
  设备 nursery 30 秒超时、每次准时 `goodbye(another_server)` 离开。
- **`server/hello` 五字段对齐严格校验**：`server_id/name/version/active_roles/
  connection_reason` 缺一或枚举非法即整条作废；`connection_reason` 取 `discovery`
 （对照 sendspin-cpp `protocol.cpp` 源码；多 server 仲裁下不抢占已有 playback 方）。
- **`stream/start` 补 FLAC `codec_header`**：base64(`fLaC`+0x80+u24(34)+34B STREAMINFO)
  定值合成（48k/立体声/16bit，块大小 4608 与 ffmpeg 实际一致）；缺头整条作废、之后每块音频全灭。
- **协商顺序定为 flac 优先 → pcm 次选 → 默认 flac**（2026-09-17 真机实锤：MA 金标准用 FLAC 才进
  PLAYING，opus 被这类客户端拒收）。⚠️ 当时误判为 "opus > pcm > flac"，已更正（见 3.0.30）。
  ffmpeg flac 管道输出只在 EOF flush，实时推流每帧拿空包 → 空包不上 wire，随后改分段 FLAC。
- **曲终/停止/失败补 `stream/end` + `group/update(stopped)`**：此前设备永远卡 PLAYING。
- **`goodbye` 打日志 + `another_server` 等不自动重拨**（spec 语义，手动 dial 解除）；
  同目标拨号单飞（并发双连接触发设备仲裁踢人）。
- **广播 `_sendspin-server._tcp`**（供客户端发现；mDNS 层只加通用 `publishExtraService`，
  业务参数归 sendspin 包内 `advertise.ts`——包边界收敛，无核心改动）。

### 文档
- 新增 `docs/SENDSPIN_ESPHOME_DEBUG.md`：原生 API 看日志 / 抓包速查 / mDNS 速查 / 坑位表。

### 测试
- 新增 `encoding.test.ts`（STREAMINFO 结构锁死）、`legacy.test.ts` 加 activate+group/update
  顺序与 hello 五字段用例；sendspin 相关 69/69 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.27`（同步 `ray5378/musicflow:3.0.27`）

## [3.0.17] - 2026-09-14

### Bug 修复
- **流探测（`probe()`）补 content-type 校验**：200/206 但 content-type 明确非音频
  （`application/json`、`*+json`、`text/*`）改判 `gone`，不再把「HTTP 200 包 JSON 错误体」
  的假活死链当可播。
  - 实锤案例：migu 源挂时 music-dl 透传 `HTTP 200 + {"code":"200002","info":"PE参数格式错误"}`
    （47 字节），原判定判 ok → 设备拉到垃圾后 MUZO 永久卡 BUFFERING（主卧《带我走》卡在前几秒）。
  - 判 `gone` 后 `ensurePlayableStream` 自动走 `findFallbackStream` 跨平台换源并回写 URL，
    死源歌曲下一次投屏即自动落到同曲可用 web 源（无需手工修数据）。
  - 黑名单式校验：content-type 缺失、`audio/*`、`application/octet-stream`、`application/ogg`
    等模糊值保守放行（宁漏杀不错杀）。

### 测试
- `streamFallbackTtl.test.ts` 新增 3 用例（200+JSON → gone / text+json → gone / 缺失与
  octet-stream 放行）；4 个测试文件的 fetch mock 显式音频 content-type（undici 对字符串
  body 自动补 `text/plain;charset=UTF-8`，会被新校验判 gone）。全量 960/960 绿。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.17`（同步 `ray5378/musicflow:3.0.17`）

## [3.0.16] - 2026-09-14

### 行为变更
- **shuffle 起播归属对齐纯 web 前端**：起播位置按「整列表播放 vs 指定居中某首」区分——
  - 整列表播放（未给起点，或 `startIndex ≤ 0`）且 shuffle 且多于 1 首 → 服务端**随机挑首**（不再固定列表第一首；随机只发生在服务端这一处）；
  - 指定居中某首（如音流/HA 投歌单第 N 首，`startIndex > 0`）与恢复断点（`currentIndex` 续播）→ 严格尊重该下标，不随机。
- `/v1/play` 起点定位注释同步更新（整列表起播落在第 1 首时，shuffle 下同样由服务端随机挑首）。

### 文档
- SPEC 新增「shuffle 起播归属」规则与「§1.7 统一音源裁决与取流抽象（`resolveAudio`，所有播放链路强制入口）」契约。

### 测试
- `PlayStartOwnership.test.ts` 契约守卫随新语义收敛（整列表 0 → 随机；指定中间 >0 → 尊重）；`queueModes.test.ts` shuffle 用例首曲断言改为接受任意随机起播。

### 镜像
- `ghcr.io/ray5378/musicflow:3.0.16`（同步 `ray5378/musicflow:3.0.16`）

## [2.3.27] - 2026-09-11

### Bug 修复
- 前端预探测调试日志（`console.warn`）含硬编码中文，被 i18n 守卫（源码禁硬编码中文）判红；改为英文。纯日志文案，无功能影响。

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.27`（同步 `ray5378/musicflow:2.3.27`）

> 关联客户端版本：MusicFlow Client **v4.3.45**

## [2.3.26] - 2026-09-11

### 新功能
- **三条链路共用一套服务端预探测**：服务端预探测从「只服务投屏链路」升级为
  Web / 投屏(DLNA) / 本机客户端三条链路共用的"提前找可播源"大脑。
  - 本机链路接入：`PeerManager` 本机队列也会调度预扫描，队列快照附带 `preProbe`。
  - 洗牌序修复：`enqueue` / `setPlayMode` 路径在调度前按需物化 `shuffleOrder`，
    修复「洗牌模式下向前扫描 0 个位置」（此前只有 `playFrom` 路径会扫描）。
  - 调度器多监听者：单回调改为可多订阅，投屏与本机链路并存不互相顶掉。
- `/v1/stream/probe` 新增**四态判定** `verdict`（`playable | unplayable | transient | unknown`，
  与预探测调度器同源判据）；客户端**只应在 `unplayable` 时预跳**，
  `transient`（网络抖动）/ `unknown`（未探过）必须照常播放。`ok` 字段保留向后兼容。

### 优化
- 队列预探测提示（Web 右上角持久轻提示）的文案与可读性打磨：标题改为「预探测已暂停」，标题文字改为主文本色、仅图标保留告警色；加 `aria-live="polite"` 便于读屏播报；`cooldownUntil` 缺失时不渲染倒计时；兜底文案改为「已为你缓存 N 首可继续播放」。（commit `5b23ff9`）

### 文档
- 新增 `docs/PRE_PROBE.md`：统一预探测架构说明（三条链路 / 四态判定 / TTL）。

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.26`（同步 `ray5378/musicflow:2.3.26`）

> 关联客户端版本：MusicFlow Client **v4.3.44**

## [2.3.25] - 2026-09-11

### 新功能
- **队列预探测（Pre-probe）**：在播放 / 投屏前提前扫描后续歌曲的可用音源，让切歌零等待；当连续默认 50 首无可用音源时自动暂停预探测并提示，冷却（默认 90s）后自动重试。无效源只做「留队列 + 短 TTL 跳过」，**绝不写入数据库、不做死歌名单**，源后续变有效即可被重新采用。
- `core-pre-probe` 内置插件（9 项配置：lookaheadSongs / deadRunLimit / exhaustedCooldownSeconds / 各类 TTL / 并发数等）
- `QueueController` 改为留队列跳过 + 绕圈上限（= 队列长度），避免死源误删与无限跳曲
- Web 端右上角持久轻提示（不自动关、手动关闭、按设备去重），**不上 HA 卡片**

### Bug 修复
- 可播性缓存加时间戳与双向 TTL（已缓存可播 1h / 已知不可播 45s / 网络瞬断 5s 退避），修掉「一次网络抖动被永久拉黑」的问题

### 文档
- 移除 HA 加载项（hassio-addons）相关引用，不再发布 HAOS 容器镜像

### 镜像
- `ghcr.io/ray5378/musicflow:2.3.25`（同步 `ray5378/musicflow:2.3.25`）

> 关联客户端版本：MusicFlow Client **v4.3.43**（需配对升级以启用客户端侧四态播放模式与预跳过）
