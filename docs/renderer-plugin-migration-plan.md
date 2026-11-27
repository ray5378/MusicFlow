# 渲染器插件化 · 完整任务文档（前置清理 v4.15.15 + 阶段 0–4 迁移）

> 状态：**阶段 -1 已完成**（v4.15.15 发版 + 240 部署 + G1–G8 全绿）；**阶段 0 已落地**（契约扩容 + 同步门面 + 边界守卫，QueueController 零 diff）。
> **执行纪律见 §0.0：每完成一项必须当场在本文件打勾并写证据，禁止事后批量补勾。**
> 一句话目标：让 `airplay` / `sendspin` 真正「住在插件侧」，核心只按能力拿 `ProtocolPlayer` 工厂；
> 该迁移**必须做到播放行为逐项等价**（第一铁律，见 §0.2），且 `airplay` / `sendspin` 均为「内置、不可停用、但走插件契约」的常驻渲染器（对齐 MA 的 `builtin: true` 语义）。
>
> 关联文档（改动前必读，改动后必须同步）：
> `SPEC.md` §1.4 / §1.5 / §五 / §六、`docs/PLUGIN_ARCHITECTURE.md` §1–§2、
> `docs/player-unification-plan.md` §2.6 / §7、`docs/PLUGIN_DEV.md`、
> `docs/airplay-权威方案文档.md`、`docs/sendspin-权威方案文档.md`、`docs/group-权威方案文档.md`、
> `docs/播放链路排障与采样手册.md`、`CONTRIBUTING.md`。

---

## 0.0 执行纪律与总进度（硬约束）

> 本文件是**唯一任务台账**。进度以本文件的勾选状态为准，不以聊天记录、commit message 或记忆为准。

### 0.0.1 标记规则（每条都必须遵守）

1. **完成即标记**：一项任务做完（命令跑完 / 代码落盘 / 真机验完）后，**立即**把该行 `- [ ]` 改成 `- [x]`，并在行尾追加证据块。**禁止**攒到最后批量补勾 —— 批量补勾等于没有台账。
2. **证据格式**（同一行末尾，一行写完）：
   `（✅ YYYY-MM-DD HH:MM · 证据：<命令/CI run id/commit sha/关键输出>）`
   - 测试类：`npx vitest run → Test Files N passed / Tests M passed, EXIT=0`
   - 守卫类：`check-xxx.mjs → ✓ 全部通过, EXIT=0`
   - 提交类：`commit 1234abc`；发版类：`tag vX.Y.Z + Release 已发布 + digest sha256:…`
   - 真机类：`240 G1–G4 通过，[ray] 确认`
3. **状态四态**：`- [ ]` 未开始 ｜ `- [~]` 进行中（行尾写当前卡在哪） ｜ `- [x]` 已完成 ｜ `- [!]` 阻塞（行尾写阻塞原因与解除条件）。**不允许**空着不写状态。
4. **阶段门禁**：阶段 N 存在任何未 `[x]` 的条目，**不得**开始阶段 N+1 的代码改动（允许并行做只读调研）。
5. **谁勾谁签**：AI 执行的条目在证据块前缀 `[ai]`，用户真机确认的条目前缀 `[ray]`。二者不可互相替代 —— 机器绿不能代替真机确认。
6. **失败也要记**：某项尝试失败/回滚，把该行改回 `- [ ]` 并在行尾写 `（↩ 回滚 YYYY-MM-DD · 原因：…）`，**不得删除该行**。
7. **改动判据与验收标准冲突时**：先改验收标准（并在 §4 记一行变更原因），再继续；**禁止**为了过关而悄悄调低判据。

### 0.0.2 总进度看板（每次标记后同步更新本表）

| 阶段 | 内容 | 状态 | 已完成条目 |
|---|---|---|---|
| **-1** | v4.15.15 前置清理（不可停用 + 死门面删除） | ✅ v4.15.15 已发版、240 部署、G1–G8 全绿、文案与 SPEC 已对齐 | 15 项 ✅ / 15 |
| **0** | 契约扩容 + 同步门面（不动物理位置） | ⬜ 未开始 | 0 |
| **1** | DLNA 试点（风险最低） | ⬜ 未开始 | 0 |
| **2** | AirPlay | ⬜ 未开始 | 0 |
| **3** | Sendspin | ⬜ 未开始 | 0 |
| **4** | 收口（守卫硬拦截 + 文档） | ⬜ 未开始 | 0 |

> 阶段 -1 的**明细台账见「阶段 -1」小节（-1a~-1o，15 条）**；§4.3 只保留 4 条宏观出口判据，便于一页看完整体节奏。

### 0.0.3 全流程路线图（12 步，照此顺序执行）

| 步 | 做什么 | 产出 / 判据 | 门禁（不满足不许进下一步） |
|---|---|---|---|
| **1** | 通读本文 + `SPEC.md` §1.4/§1.5 + `docs/PLUGIN_DEV.md` §4.7 | 能复述「唯一允许的变更 = 谁 new 播放器」 | — |
| **2** | 环境核对（§2.6） | 仓库干净、`git rev-parse HEAD` 记录在案 | `git status --short` 只剩本次改动 |
| **3** | 基线快照（§2.6.2） | 用例数（**-1 前 9136 / -1 后 9129，以实测为准**）/ 守卫 37 / M1–M7 实测值写入 §4.2 | 实测与 §4.2 不一致时以实测为准并改表 |
| **4** | 完成阶段 -1 尾巴：全量测试 → SPEC §1.5 → CHANGELOG → 热补丁 240 → 真机 G1–G8 → 发版 v4.15.15 | tag + Release + digest 核对通过 | 真机 G1–G8 全过，`[ray]` 确认 |
| **5** | ✅ 阶段 0：契约扩容 + 同步门面（不动 import 图） | `createPlayer?` + `createRendererPlayer` + B1–B7 守卫落地，`QueueController` diff 为空 | `tsc` 0 错 + 37 守卫绿 + 单测 365 passed |
| **6** | 🔄 阶段 1：DLNA 试点（代码完成，真机待部署） | `QueueController` 不再 import `createDlnaProtocolPlayer`（命中 0） | 定向 1385 用例绿 + 专项守卫 4 绿；HiVi 真机四项待部署 |
| **7** | 阶段 2：AirPlay | 同上（AirPlay） | 含已配对 AP2 与未配对回落 AP1 各一次 |
| **8** | 阶段 3：Sendspin | 同上（Sendspin） | ESP32 真机 + 多房同步 + 群组桥回归 |
| **9** | 阶段 4：收口 | 边界守卫改硬拦截；M1/M3 达标；文档同步 | B1 命中即非零，且 38 守卫全绿 |
| **10** | 全量验收（§4.1 五层 + §4.4 GWZ + §4.5 真机矩阵） | L1–L5 全过，五拓扑指标不退化 | 任一票否决命中即停 |
| **11** | 发版（§4.6 Gate） | tag + 双路 CI 绿 + Release 非 draft + digest≠旧版 + APP_VERSION 正确 | 回滚 job 未触发 |
| **12** | 观察期（§12） | 7 天内无播放类告警，指标稳定 | 出现回退类告警 → 按 §9.2 回滚该阶段 |

---

## 0. 结论先行：三个判断逐条裁决

| # | 原判断 | 裁决 | 依据 |
|---|---|---|---|
| 1 | sendspin / airplay 是内置插件 | ✅ **形式成立，名不副实** | 有 `renderer` 插件壳（manifest/discover/control），但 5.3 万行真身在核心 `services/`；`castToRenderer` / `controlRenderer` **全仓零真实调用点** |
| 2 | sendspin 改为「不能关闭的核心插件，但走插件侧」；**airplay 同样不可停用** | ✅ **方向正确，且「不可停用」已是既成事实 → 本期不动启用逻辑** | MA sendspin = `builtin: true` + `allow_disable: false`；本仓 `plugins.ts:83` `builtin ? 1` 使全部内置插件强制启用（比 MA 更严）。**用户 2026-11-27 追加：airplay 也改为不可停用** ⇒ 三个渲染器语义统一，`builtin ? 1` 恰好正确，**本期零改动** |
| 3 | 「把插件接口做厚」 | ⚠️ **提法需修正** | MA 的 `PlayerProvider` 只有 **83 行**（很薄）；MA 的「厚」在 `Player` ABC（9 个抽象方法）。本仓 `ProtocolPlayer` **已有 8 个方法（另含 `playerId` 字段）、四协议同形实现**，注释写着「对照 MA 协议 player 契约」 |

**修正后的正确表述**：不是发明一个厚接口，而是**在 `RendererPlugin` 上加一个工厂方法 `createPlayer(protocol, deviceId): ProtocolPlayer | null`（**必须自带协议归属判定，禁止盲透传**，见 §2.7a），把已经存在的 `ProtocolPlayer` 抽象暴露到插件契约上**，让核心不再 `import` 具体协议目录。

**「airplay 也不可停用」带来的范围收缩（重要）**：

| 原计划要做 | 追加该约束后 |
|---|---|
| 引入 `allowDisable` 字段区分「核心协议 / 可选内置」 | ❌ **不做** —— 三个渲染器语义统一为不可停用，无需分型 |
| 改 `plugins.ts:83` `builtin ? 1` → 按 `allowDisable` 判定 | ❌ **不做** —— 现状即正确语义，**零改动** |
| 恢复 `stopAirPlayService()` 可达性（"停用零常驻"） | ❌ **不做** —— airplay 常驻是既定语义；且现状本就常驻，改它反而是行为变更 |
| 修「静默忽略」为 409、修「存配置意外启用」 | ❌ **本期不做** —— 两者都是可观察行为变更（返回码 / 写库结果），违反 §0.2；另立一轮（§7） |
| 工厂化迁移（`createPlayer`）+ 守卫 | ✅ **本期唯一交付** —— 风险面因此大幅收窄 |

**副作用（需同步文档、非代码变更）**：`SPEC.md` §1.5 与 airplay 插件注释中「停用后零常驻资源」的承诺**随之失效**，须校正为「内置渲染器一律常驻，不可停用、不可删除」。实际资源占用与今天**完全一致**（今天本来就关不掉），因此不构成行为变更。

---

## 0.1 文档时效性判定（独立校验，一律以代码实值为准）

> 立项时对文档库做了逐条实测对账。**以下文档声明已被代码推翻，本方案不采用**；后续实施也不得再拿它们当判据。

| 文档位置 | 文档声明 | 实测（2026-11-27） | 判定 |
|---|---|---|---|
| `SPEC.md` §1.5 | 「**内置插件均可停用**（v1.13.42+）：移除"内置不可停用"限制，toggle 对所有插件生效」 | 两条接口语义相反：`PUT /:id` 恒写 `enabled=1`，而 `PUT /:id/toggle` **无内置判定**（`nextEnabled = p.enabled ? 0 : 1`）会真停服务。**v4.15.15 已按用户裁决统一为「渲染器不可停用」** | ❌ 文档过时（代码已修，文档待 -1l 改） |
| `SPEC.md` §1.5 | `/v1/plugins` 的 **`optionalBuiltin: true`** 行显示开关按钮 | `optionalBuiltin` 全仓 **零命中**（字段已不存在） | ❌ 字段已移除 |
| `SPEC.md` §1.5 | AirPlay「**默认关闭**」，未开启不启动任何服务 | manifest `defaultEnabled: true`；240 生产库 `airplay-renderer enabled=1` | ❌ 过时 |
| `services/plugin/renderers/airplay.ts` 注释 | 「关闭仍可在插件管理页操作：停用后 discovery/子进程/设备注册全部回收」 | toggle 被 `builtin ? 1` 忽略 → **无法从 UI 关闭** | ❌ 注释与代码矛盾 |
| `CONTRIBUTING.md` | `npx vitest run`「当前 **155 文件 / 1165 用例**，约 3.5 分钟」 | **643 文件 / 9136 用例**（`find tests -name '*.test.ts'` + `it/test(` 计数） | ❌ 差 4 倍以上 |
| `CONTRIBUTING.md` | 「CI 静态守卫（**8 项**，必须全绿）」 | `scripts/check-*.mjs` + `check-*.mts` 共 **37 个** | ❌ 过时 |
| `docs/PLUGIN_DEV.md` §4.7 vs §4.11 | §4.7 说 renderer impl = `discover`/`cast`/`control`；§4.11 `CAP_METHODS` 表**无 renderer 行** | 代码 `sandbox.ts:193` 确认 `CAP_METHODS` 无 `renderer` | ⚠️ 文档自相矛盾（外置 renderer 结构性不可用） |
| `docs/RELEASE_POLICY.md` | 服务端 CHANGELOG 是 CRLF | 实测 `CRLF=0`（LF） | ❌ 过时（已在 v4.15.14 发版时确认） |
| `docs/player-unification-plan.md` §2 | `ProtocolPlayer` 在 `player/types.ts` 约 `:67` | 实测 `:96` | ⚠️ 行号漂移（该文档已声明「行号快照刻意不校正」） |
| `docs/player-unification-plan.md` §2.6 | 插件 renderer 的 `control()` 是「**第三套控制面待收敛（未开始）**」 | 实测 `castToRenderer`/`controlRenderer` **全仓零调用** | ✅ 仍有效，且比文档描述更严重（是死代码，不只是待收敛） |
| `docs/PLUGIN_ARCHITECTURE.md` §1 | 耦合点 C1–C9（围绕 go-music-dl） | `check-core.mts` 的 `KNOWN_COUPLINGS` **白名单已为空**（Phase 2 收口完成） | ⚠️ 属历史快照，不具备现状效力 |

**由上述对账得出的关键结论（本方案立场）**：

1. **「内置插件不可停用」此前并不是事实**（立项时的判断有误）：`PUT /:id/toggle` 无内置判定，管理页开关对内置行照常渲染，点一下真停服务。**v4.15.15 已用 `BUILTIN_RENDERER_IDS` 幂等置 1 落实该语义**；与 MA 的差别是本仓按「渲染器类别」一刀切，MA 是逐插件 `allow_disable`。
2. 该实现目前带三个缺陷（**均属可观察行为，本期一律不修**，理由见 §0.2；修复另立一轮，见 §7）：
   - **静默忽略**：用户点停用，接口 200 成功但值没变（无任何提示，返回体也不拒绝）；
   - **保存配置会意外启用**：`PUT /v1/plugins/:id` 只要带 `config` 就会把 `enabled` 一并强制写 1 —— 240 上 `sendspin-renderer`（manifest `defaultEnabled: false`）实测 `enabled=1`，正是这条路径的产物；
   - **AirPlay 的「零常驻」承诺失效**：只要 seed 后 enabled=1，`isAirPlayEnabled()` 恒真，停止分支 `stopAirPlayService()` 永远走不到。
3. **用户 2026-11-27 追加裁决：airplay 也改为不可停用。** 三个渲染器语义统一 ⇒ **本方案不引入 `allowDisable` 字段、不恢复 `stopAirPlayService()` 可达性**。停用语义已由 **v4.15.15 单独一版**落实（toggle 幂等置 1 + 删停机联动 + sendspin 默认开启，见「阶段 -1」小节）。⇒ **本方案（阶段 0–4）对 `plugins.ts` 与 manifest 的启用逻辑一行不动。**
4. **文档与代码已在 v4.15.15 同步落地**：`SPEC.md` §1.5 重写为「内置渲染器一律不可停用、一律常驻」（替换全文见 §11.1），toggle 语义同步改实。⇒ 本方案开工时 **SPEC §1.5 已是校正版**，阶段 0 只需确认、不再修改。

---

## 0.2 第一铁律：行为等价（零可观察变更）

> **用户约束（2026-11-27，优先级最高）**：现行播放链路是长期打磨才稳定的结果，插件化**不得改变任何可观察行为**。
> 因此本方案的成功判据不是「架构达标」，而是「**架构达标的同时，播放行为逐项等价**」。两者冲突时 —— **行为优先，架构让步**。

### 0.2.1 本期只允许改变一件东西

**唯一允许的变更**：`QueueController` 拿到 `ProtocolPlayer` 实例的**来源** —— 从「核心目录直接 `import` 工厂」改为「向插件注册表索取工厂」。

除此之外，下面每一项都必须**逐项等价**：

| 维度 | 必须不变的内容 | 为什么（均有历史血案） |
|---|---|---|
| **起播时序** | `createPlayer` **同步返回**，不得引入 `await` / 微任务 / `setImmediate` | `register*Device` 现状是同步 `void`（`QueueController.ts:472/513/540`）；一旦异步，起播窗口多一跳，撞「起播即落位」的时序前提 |
| **工厂调用次数** | 每次调用**恰好 new 一个**实例；不得缓存 / 复用 / 单例化 | `ProtocolPlayer` 持有协议会话状态；复用会让下次起播继承上一首的会话 |
| **三元分工** | `positionMs`（判定）/ `displayPositionMs`（派生）/ `state`（与进度同源）三者的分工与取值口径 | 「一个数字不能同时当判定和显示」；动任一处即复现「进度回跳 / 凭空多 9s」 |
| **hold 语义** | `displayHold` 逻辑**一行不改**；hold 期间 `state` 必须 `PLAYING` | v4.15.10：只换进度不换 state → 客户端「显示暂停 + 进度冻结 → 放开跳几秒」 |
| **lead / delay** | 延迟补偿唯一落点仍在**投递时戳**；`mixed_anchor_lead_ms` 仍由 `streamEngine` 绕 cache 直查 | 插件工厂**不得**介入 lead 计算，哪怕只是「顺手传个参」 |
| **桥会话** | 桥预热 / 会话暖复用 / tick 节奏 / `[airplay-bridge]` 日志逐字不变 | `[airplay-bridge]` tick 是同步权威判据，改节奏=改判据 |
| **启用判定** | `isAirPlayEnabled()` / `isSendspinEnabled()` **读取路径与今天同源**（直读 `plugins.enabled`） | `delayCalib cache` 前车之鉴：多加一层缓存 = 判定陈旧 |
| **日志** | 级别 / 前缀 / 文案 / 出现次数不变 | 排障手册与守卫按字面量钉行；文案一改，红的是守卫但看不出是回归还是改名 |

### 0.2.2 三个「看起来无害、实际会变行为」的陷阱（本次专项盯防）

1. **同步改异步（最高危）**
   门面若写成 `async function createRendererPlayer()`，即使函数体内无 IO，也必然多一次微任务。
   → **契约签名必须同步**：`createPlayer(protocol: RendererProtocol, deviceId: string): ProtocolPlayer | null`（归属判定见 §2.7a）。
   → 已核实依据：`pluginAccess.ts` 现有 8 个导出门面**全部同步**；`registry.getEnabledByCapability()` 同步；三处注册点同步。

2. **启用判定改走缓存**
   `registry` 有内存表，但 `isAirPlayEnabled()` 现在是直读 DB 行。改读内存态会在插件热更新 / 多进程场景产生陈旧窗口。
   → **本期不动 `isXxxEnabled()` 实现**；只在「停用语义」那一轮（另立，见 §7）才碰。

3. **import 图变化带来模块初始化顺序漂移**
   `db/index.ts` 建表、`middleware/restExempt.ts` 注册鉴权豁免、`index.ts` 启动门控，全靠**模块加载顺序**生效。阶段 0 若顺手改 `renderers/*.ts` 的 import 图，启动顺序会静默变化。
   → **阶段 0 只加类型与门面，不动任何现有 import 图**；工厂转发按协议分在阶段 1–3，每阶段独立可回滚。

### 0.2.3 等价性的验证手段（全部可机检，不靠肉眼）

| 层 | 手段 | 判据 | 阻塞 |
|---|---|---|---|
| **L1 单测** | 643 个测试文件 | **零删除、零断言修改**跑绿 | ✅ 阻塞 |
| **L2 拓扑** | CI `playback-baseline.yml` → `sim-e2e` 五拓扑（mixed / ap-only / ap1-only / ap2-only / ss-only） | 与改造前**同判据同值**：`deltaUs p50∈[1.2,4]s`、`negPct≤1%`、`inQueueMs p95≤3925ms`、`overCapPct≤5%`、`realigned/min≤30`、`advanceRate∈[0.98,1.02]`、无回退、`A_switch.count≥5`、`failed=0`、`maxSettleMs≤25s` | ✅ 阻塞 |
| **L3 守卫** | 37 个既有 `check-*.mjs` | **零修改**跑绿；若某条因搬迁变红 → 先假定「行为变了」，查清原因再放行 | ✅ 阻塞 |
| **L4 真机 A/B** | 240 同一设备 / 同一歌单，改造前后各一轮采样 | 按 `docs/播放基线-基准值与判读-20261126.md` §3 指标集逐项比对，须落在同一判读区间 | ✅ 阻塞发版 |
| **L5 代码审查** | 每阶段 `git diff` | 只允许三类改动：`import` 行、工厂调用行、新增文件。**出现任何逻辑行变更即拒收** | ✅ 阻塞 |

> **L1 的「零断言修改」是硬红线**：某个既有测试需要改断言才能过，等于自认行为变了 —— 此时不是改测试，而是**回滚该阶段重新设计**。
>
> **L2 是本期最有力的证据**：五拓扑不依赖真机、在 CI 里可重复，且覆盖了桥（tick/ring）、纯 sendspin 帧活性、切歌 5 次后 settle；只要判据区间不变，就说明「桥、泵、切歌、延迟锚点」这条最脆弱的主链路没被碰坏。

### 0.2.4 一票否决

任一层出现行为差异 → **该阶段就地回滚，不发下一阶段**，并把差异记入 §6 风险台账。

---

## 1. 两项目事实对照（调研结论，2026-11-27 实测）

### 1.1 MA（`/workspace/ma-ref`）

| 维度 | 事实 |
|---|---|
| 插件基类 | `models/player_provider.py`，**83 行**：`loaded_in_mass` / `on_player_enabled` / `on_player_disabled` / `remove_player` / `create_group_player` / `remove_group_player` / `discover_players` / `players` |
| 真正的「厚」 | `models/player.py` 的 `Player` ABC（文件 3738 行），9 个抽象方法：`power` / `volume_set` / `volume_mute` / `play` / `stop` / `pause` / `seek` / `play_media` / `play_announcement`，外加 `_attr_supported_features` 能力位 |
| 插件如何交出播放器 | `self.mass.players.register_or_update(player)`（`providers/sendspin/provider.py:681`），核心只认 `Player` |
| 核心如何驱动 | 全部对抽象编程：`await player.play_media(media)` / `await player.volume_set(...)`（`controllers/players/controller.py` 5000+ 行，无一条 import 具体协议类） |
| sendspin | `builtin: true` + `allow_disable: false`，`requirements: aiosendspin[server]` |
| airplay | `builtin: false`（可插拔，需 `pyatv==0.18.0`） |
| sync_group（同步组） | `builtin: true` + `allow_disable: false`，**住在 providers 目录、走 provider 契约** |
| universal_group（跨协议组） | `builtin: false`，但核心 `controllers/streams/controller.py` **直接 import 其实现类** `UniversalGroupPlayer` |
| 反向依赖谱系 | 协议 provider **零**；`sync_group` 仅 import **常量**（`SGP_PREFIX`、`CONF_ALLOWED_MEMBERS`）；`universal_group` import **常量 + 实现类** |
| `allow_disable` 实现 | 双保险：① `controllers/config/providers.py:750` 禁用请求直接抛 `RuntimeError("Provider can not be disabled.")`；② `mass.py:1350` 加载条件 `prov_conf.enabled or manifest.allow_disable is False`（配置里关了也照常加载）；③ `mass.py:1605` 允许运行时程序化改写 |

### 1.2 MusicFlow（`/workspace/MusicFlow`）

| 维度 | 事实 |
|---|---|
| 插件壳 | `services/plugin/renderers/{airplay,sendspin,dlna}.ts`，`RendererPlugin` 仅 `discover()` / `cast()` / `control?()` |
| **抽象已存在** | `services/player/types.ts:96` `ProtocolPlayer`：`playMedia` / `stop` / `pause` / `resume` / `seek` / `setVolume` / `pollState` / `isAvailable?` —— 注释原文「**对照 MA 协议 player 契约**」 |
| 四协议同形 | `createAirPlayPlayerForDevice` / `createSendspinProtocolPlayer` / `createDlnaProtocolPlayer` / `createGroupProtocolPlayer` **全部返回 `ProtocolPlayer`** |
| 聚合壳 | `services/player/UniversalPlayer.ts` 头部注释「**对照 MA UniversalPlayer**」，`attachProtocol()` + 纯转发 |
| **门面是装饰性的** | `castToRenderer` 全仓 **0 处真实调用**（仅注释提及）；`controlRenderer` 同样 **0 处**；`discoverRenderers` 仅 1 处（`GET /v1/plugins/renderers`，管理页列设备） |
| 真实耦合 | **18 个核心文件、43 条 import**（实测口径：airplay+sendspin，排除两协议目录内部） 直连 `services/{airplay,sendspin}`；DLNA 的 proven 路由 `/v1/dlna/cast` 也**绕过插件门面**直调 `castToDevice()` |
| 启动门控已有 | `index.ts:510` `if (isAirPlayEnabled()) startAirPlayService()`；`index.ts:541` `if (isSendspinEnabled()) startSendspinService()` |
| 服务规模 | airplay **43 文件 / 15361 行**；sendspin **105 文件 / 25672 行**；group 5 文件 / 2135 行 |
| 进程层已隔离 | 两者均已接 `services/rendererHost/`（`child.ts` + `supervisor.ts` + `mode.ts`），受 `check-renderer-host.mjs` R1–R3 约束 |
| 现存矛盾（实测校正） | `sendspin` manifest `defaultEnabled: false`，但 240 生产库 `enabled=1` —— `isSendspinEnabled()` 直读该列，故服务恒启动。两个原因叠加：① toggle 被 `builtin ? 1` 静默忽略；② **带 `config` 的 PUT 会顺带把 `enabled` 写 1** |

### 1.3 关键差距（一句话）

> **抽象层已经和 MA 一样厚了，缺的是「工厂上移」：核心仍按目录名 import 工厂，而不是按能力向插件要工厂。**

---

## 2. 目标架构

### 2.1 分两层看，不要混

| 层 | 现状 | 本方案 |
|---|---|---|
| **进程层**（推流运行时装在哪） | ✅ 已就绪：`rendererHost` 常驻子进程，`check-renderer-host.mjs` 守 R1–R3 | **不动**。插件化是契约层的事，不许借机改进程模型 |
| **契约层**（核心怎么拿到播放器） | ❌ 核心 `import` 具体目录的工厂 | **本方案范围**：插件暴露工厂，核心按能力取 |

### 2.2 契约扩展（唯一新增面）

```ts
// plugins/types.ts —— RendererPlugin 增加一个可选方法（不破坏现有实现）
export interface RendererPlugin {
  manifest: PluginManifest;
  discover(): Promise<RendererDevice[]>;
  cast(deviceId: string, songId: string): Promise<{ mediaUri: string }>;
  control?(deviceId: string, action: string, payload?: any): Promise<any>;
  /** 新增：为本插件名下的设备创建协议播放器。
   *  **必须同步返回**（起播链路同步，依据见 §3.0②）；不得 async、不得返回 Promise。
   *  返回的 ProtocolPlayer 是 services/player/types.ts 的既有契约，
   *  四个协议（dlna/airplay/sendspin/group）同形实现，核心不感知具体协议。
   *  null = 「本设备不归我管」，调用方静默跳过并记 debug 日志。 */
  createPlayer?(protocol: RendererProtocol, deviceId: string): ProtocolPlayer | null;
}
```

> 为什么是**可选**：`group` 这类核心语义的播放器不走插件工厂；未实现的插件退化为「只能 cast、不能进队列」，与今天行为一致。

### 2.3 核心侧接线（复用既有门面，不新建体系）

```ts
// services/pluginAccess.ts —— 同步、无状态、每次调用新建实例（不缓存）
export function createRendererPlayer(protocol: RendererProtocol, deviceId: string): ProtocolPlayer | null;
```

```ts
// services/player/QueueController.ts —— 改造前后对比
// 前：import { createAirPlayPlayerForDevice } from "../airplay/protocolPlayer.js";
//     up.attachProtocol(createAirPlayPlayerForDevice(deviceId));
// 后：const p = createRendererPlayer(protocol, deviceId);
//     if (!p) return;                       // 插件未实现 → 不注册该设备（不抛错）
//     up.attachProtocol(p);
```

命名说明：**不用 `xxxApi()` 后缀** —— 现有 `dailyRecommendApi()` 等返回的是「插件暴露的 API 句柄」，而这里每次调用都要**新建一个播放器实例**，语义是动作而非句柄；也**不做模块级单例句柄**（避免引入全局状态，负面清单第 4 条）。

`registry.getEnabledByCapability("renderer")` 本就存在，`pluginAccess` 门面本就是「核心按能力拿插件」的既有收口点 —— **不发明新机制**。

### 2.4 明确「搬不走、也不该搬」的部分

| 保留在核心 | 理由（有 MA 佐证） |
|---|---|
| `services/group/protocolPlayer.ts`（桥会话、RAOP 探测、延迟锚点，9 条 import） | 群组泵是**核心语义**（选歌/推进时间线/AirPlay 桥旁路投递）。MA 的 `universal_group` 同样被核心 `streams/controller.py` 直接 import 实现类 |
| `index.ts` 启动门控（`isAirPlayEnabled` / `isSendspinEnabled`） | 生命周期必须由核心掌握，否则「插件没加载时服务已起」 |
| `dlna/announce.ts` + `check-airplay-dlna-mutex` 互斥链 | `SPEC.md` §1.4 硬约束，按 host 互斥，用动态 import 规避循环依赖 |
| `access.ts` 权限挂载、`peer.ts` 设备列表、`pruneOrphans` 清理 | 跨模块基础设施，是「设备管理」不是「协议播放」 |

### 2.5 插件开发契约（`docs/PLUGIN_DEV.md`）对本方案的硬约束

读 `PLUGIN_DEV.md` 后确认三条边界，**本方案必须遵守**：

**① 内置插件与外置插件是两条完全不同的执行路径**

| | 内置插件（本方案对象） | 外置插件（QuickJS 沙箱） |
|---|---|---|
| 注册 | `builtins.ts` → `registerPlugin(manifest, impl)`，**impl 是主进程对象** | `<data>/plugins/<id>/index.js` → `__mfPlugin.create(host)` |
| 能力 | 可直接持有子进程、socket、mDNS、`ProtocolPlayer` 实例 | 只有标准 JS + `host.*`；无 `import`/`require`/`fetch`/`fs`/`process` |
| 返回值 | 任意（含资源句柄） | 必须可结构化克隆的**纯数据** |

⇒ **`createPlayer()` 只能作为内置插件契约**，返回带资源句柄的 `ProtocolPlayer` 在沙箱模型下不可行。

**② `CAP_METHODS` 不含 `renderer` —— 外置 renderer 结构性不可用（实测）**

`backend/src/plugins/sandbox.ts:193` 的 `CAP_METHODS` 表里有 `search` / `stream` / `lyricProvider` / `scrobbler` / `qrLogin` 等 22 项，**唯独没有 `renderer`**。而 `makeImpl` 只暴露白名单内方法 —— 与同表 `stream` 那条注释记录的坑同构（「白名单里若不含它，makeImpl 永不暴露该方法，插件实现了也调不到」）。

⇒ 今天 `renderers.ts` 能调到 `impl.discover`，**唯一原因是内置插件绕过了沙箱**。方案**不动 `CAP_METHODS`**（不把 `renderer` 加进白名单），因为沙箱无法承载 `ProtocolPlayer`。

**③ 文档自身的缺口，顺带记录**

`PLUGIN_DEV.md` §4.7 写着 renderer 的 impl 是 `discover` + `cast` + 可选 `control`，但 §4.11 的 `CAP_METHODS` 映射表**没有 renderer 行** —— 两节不一致，会让读者误以为外置能写 renderer 插件。建议本方案阶段 0 顺手在 §4.7 加一句：
> 「renderer 目前**仅内置插件可用**：沙箱 `CAP_METHODS` 未映射 renderer，外置 renderer 插件不会暴露任何方法。」

**④ Manifest 新字段需同步 `check-builtins.mts`（本期已不适用）**

本期**不新增任何 manifest 字段**（`allowDisable` 随停用语义一并移出范围，见 §7），因此 `check-builtins.mts` 无需同步。若将来做停用语义那一轮，才需同步其字段白名单。**这是本期风险面收窄的一项直接收益。**

---

### 2.6 开工前准备（环境核对 + 基线快照）

> 这一步不写代码，只做「确认起点」。起点不确定，后面任何一次红灯都无法判断是本次改动还是历史遗留。

#### 2.6.1 环境核对

| 项 | 命令 | 期望 |
|---|---|---|
| 工作目录 | `cd /workspace/MusicFlow && git rev-parse --show-toplevel` | `/workspace/MusicFlow` |
| 分支 / 提交 | `git status --short && git rev-parse HEAD` | 干净（最多只有本文档改动）；HEAD 记入 §4.2 备注 |
| Node / npm | `node -v && npm -v` | 与本仓 CI 一致（`package.json` engines） |
| 测试可跑 | `cd backend && npx vitest --version` | 能输出版本即 OK |
| 阶段 -1 已发版 | `git tag --list 'v4.15.15'` | 有输出（否则先走「阶段 -1」小节剩余项） |
| 240 可达 | `curl -s 192.168.10.240:46400/ping` | 有 JSON 且 `status: ok` |

#### 2.6.2 基线快照（必须写入 §4.2 备注，作为后续比对锚点）

```bash
cd /workspace/MusicFlow/backend

# ① 用例基线（期望 9129；数量不符先查是不是有测试被跳过/新增）
npx vitest run 2>&1 | tail -6

# ② 守卫基线（期望 37 个全绿；逐个跑，别用通配符直接 node）
for f in scripts/check-*.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
for f in scripts/check-*.mts; do npx tsx "$f" >/dev/null 2>&1 || echo "FAIL $f"; done

# ③ 类型基线
npx tsc --noEmit -p tsconfig.json && echo TSC_OK

# ④ 耦合基线（M1/M2/M3 的实测值）
grep -nE '^import .*services/(airplay|sendspin|dlna)/' src/services/player/QueueController.ts
grep -cE 'create(DlnaProtocolPlayer|AirPlayPlayerForDevice|SendspinProtocolPlayer)' src/services/player/QueueController.ts
grep -rlE 'from "[^"]*services/(airplay|sendspin|dlna)/' src | sort
```

把 ①②③ 的输出与 ④ 的计数**抄进 §4.2 的「改造前实测」列**；与表里现有数字不一致时，以实测为准并改表（同时在 §4.2 末记一行变更原因）。

#### 2.6.3 冻结项确认（改了就等于提前引入行为变更）

- [ ] `routes/api/plugins.ts` 的 `BUILTIN_RENDERER_IDS` 判定存在且**本方案不再改**
- [ ] 三个 renderer manifest 的 `defaultEnabled` 均为 `true`
- [ ] `isAirPlayEnabled()` / `isSendspinEnabled()` 实现未动
- [ ] `renderers.ts` 已无 `castToRenderer` / `controlRenderer`

---

## 3. 迁移步骤（逐阶段可执行）

> **执行总则**
> 1. **每阶段单独提交、单独发版、单独回滚**；任一阶段真机不过就地停下，不发下一阶段。
> 2. **每阶段的 `git diff` 只允许出现三类改动**：`import` 行、工厂调用行、新增文件。出现任何**逻辑行**变更即视为越界，回滚重做（§0.2.3 L5）。
> 3. 每阶段开始前先 `git status` 确认干净；结束时跑 `tsc --noEmit` + 全部守卫 + 受影响目录测试。
> 4. 每阶段结束都要过一遍 §4.3 的该阶段验收清单，**逐条打勾**，不允许"整体感觉没问题"。

### 3.0 前置可行性结论（已实测，非推断）

**① 循环依赖现状：项目早已大量存在，且本方案不新增"顶层依赖"**

用只读脚本（解析 `backend/src` 全部静态 `import`，DFS 找回到入口的环）实测：

| 入口 | 静态出边 | 回到入口的环数 |
|---|---|---|
| `services/plugin/renderers/airplay.ts` | 2（`airplay/control`、`plugins/types`） | **3** |
| `services/plugin/renderers/sendspin.ts` | 2（`plugins/types`、`sendspin/control`） | **57** |
| `services/plugin/renderers/dlna.ts` | 5 | **2** |

环的共同形态：`renderers/X.ts → … → plugins/builtins.ts → renderers/X.ts`（`builtins.ts:98-100` 静态注册三个插件，而插件间接依赖的模块又回溯到 `builtins`）。

**结论与约束**：
- 「有环」**不能**作为本方案的失败判据 —— 现状就有，且运行正常；ESM 环只要**不在模块顶层执行期访问对方未初始化的绑定**就安全。
- 因此 **`createPlayer` 的实现必须写成「函数体内惰性调用工厂」，禁止在模块顶层持有工厂结果**：
  ```ts
  // ✅ 正确：调用时才求值，环存在也安全
  createPlayer(protocol, deviceId) {
    if (protocol !== "airplay") return null;          // 归属闸门（强制）
    if (!airPlayOwnsDevice(deviceId)) return null;    // 用 AirPlay 自身设备表校验，禁止盲透传
    return createAirPlayPlayerForDevice(deviceId);
  }
  // ❌ 错误：模块顶层就执行，环里可能拿到 undefined
  const _factory = createAirPlayPlayerForDevice;
  ```
- 新增的 `renderers/airplay → airplay/protocolPlayer` 这条边**不引入新的叶**：`airplay/protocolPlayer` 的依赖集（`session` / `bridgeChannel` / `playbackSpeed` / `control`）是 `renderers/airplay` 已间接依赖的子集。`sendspin` / `dlna` 同理。
- **不装新依赖**（负面清单第 1 条），环检测用一次性只读脚本，不入仓。

**② 为什么 `createPlayer` 必须同步（有代码依据，不是风格偏好）**

| 事实 | 位置 |
|---|---|
| 三处注册方法均为同步 `void`，内部同步调用工厂 | `QueueController.ts:472 / 513 / 540` |
| 现有 8 个 `pluginAccess` 导出**全部同步** | `services/pluginAccess.ts` |
| 注册表查询同步 | `registry.ts:98 getEnabledByCapability()` |
| `attachProtocol(player)` 同步 | `UniversalPlayer.ts:18` |

⇒ 契约签名固定为 `createPlayer(protocol: RendererProtocol, deviceId: string): ProtocolPlayer | null`，**不得 `async`、不得返回 `Promise`**。

**③ 契约落点**

`RendererPlugin`（`plugins/types.ts:513-521`）现有 4 个成员：`manifest`、`discover()`、`cast()`、`control?()`。
本期**只加第 5 个可选成员**：

```ts
export interface RendererPlugin {
  manifest: PluginManifest;
  discover(): Promise<RendererDevice[]>;
  cast(deviceId: string, songId: string): Promise<{ mediaUri: string }>;
  control?(deviceId: string, action: string, payload?: any): Promise<any>;
  /**
   * 队列播放器工厂（v4.x）：核心据此拿到 ProtocolPlayer 实例，
   * 从而不再 import 具体协议目录。
   * **必须同步返回** —— 起播链路是同步的（见 QueueController 三处 register*Device）。
   * 返回 null = 「本设备不归我管」，调用方必须静默跳过并记 debug 日志。
   * 对照 MA：PlayerProvider 通过 mass.players.register(player) 交出 Player 实体，
   * 本仓等价做法是交出「工厂」而非实例（因为本仓是「设备先发现、播放器后创建」）。
   */
  createPlayer?(protocol: RendererProtocol, deviceId: string): ProtocolPlayer | null;
}
```

---

### 2.7a 归属判定与三处强制修正（2026-11-27 审核，优先级高于上文示例）

**1）归属判定（P0，强制）**：三个协议工厂对任意 `deviceId` 都会返回非 null 对象（AirPlay 只在直连/桥接间二选一，DLNA 直接 `dlna:${deviceId}`，Sendspin 只在 fork/in-proc 间二选一），而插件注册顺序是 `dlna → airplay → sendspin`。若门面按「遍历、首个非 null 胜出」，**所有设备都会被 DLNA 插件劫持**。因此：
- `createRendererPlayer(protocol, deviceId)` 的 `protocol` 由调用方给出（`registerDlnaDevice` / `registerAirPlayDevice` / `registerSendspinDevice` 本来就知道协议，传字符串不产生 import 依赖）；
- 插件 `createPlayer` 必须双闸门：`protocol` 不匹配 → `null`；设备不在自己的设备表 → `null`。**禁止**把协议工厂原样透传；
- 同一设备可能同时被 DLNA 与 AirPlay 发现（见 `check-airplay-dlna-mutex`），不得靠注册顺序消歧；
- 示例里的 `dlnaOwnsDevice` / `airPlayOwnsDevice` / `sendspinOwnsDevice` 是示意名，落地时改用各协议**现有**设备表查询（DLNA `getDevice`、AirPlay `listAirPlayDevices`、Sendspin `listSendspinPlayers`）。

**2）允许缓存的范围**：**player 实例禁止缓存复用**；但「renderer 插件实现 / `id → createPlayer` 映射」允许在 boot 缓存，避免每次设备注册都走一遍 `getEnabledPlugins()` 的 SQL。启动顺序已实测安全（`seedDefaultRegistry()` 早于 `startAirPlayService()`）。

**3）新增验收：设备→播放器选择矩阵（P0 对应）**：对 `{dlna, airplay-direct, airplay-bridge, sendspin-fork, sendspin-inproc, group×3}` × `{正常, 未知 deviceId, 双协议同名, 渲染器异常态}` 生成期望表，迁移前后各跑一次逐格比对；这比存量用例更能直接抓住「选错协议」。

**4）建议（未纳入必做）**：先「归一」再「搬家」——先把三个协议各自收敛成唯一 `makePlayer()` 入口（含 `group/protocolPlayer.ts` 的 6 处、`/v1/dlna/cast` 直调），再整体迁到插件；这样每阶段只移动不造逻辑，等价性最稳。

### 2.7b 工程建议（2026-11-27 审核提出，待裁决后再纳入必做项）

1. **目标校准**：本期真正的收益是「内置解耦」；外置渲染器应独立立项——沙箱 `CAP_METHODS` 无 renderer，无法返回带方法的 Player 活对象，未来形态应为「子进程 / HTTP sidecar + 核心侧 RPC 客户端」，不要在本期契约里预留假通用性。
2. **先归一、后搬家**：先把三协议各自收敛成唯一 `makePlayer()` 入口（含 `group/protocolPlayer.ts` 6 处 `new`、`/v1/dlna/cast` 直调），再整体迁入插件；每阶段只「移动 + 换调用点」，不夹带逻辑改动。
3. **失败语义分级**：注册阶段拿到 `null` → warn（节流）+ 跳过 + 可重试；组播成员加入拿到 `null` → throw；播放中解析失败 → 返回统一错误码，便于 UI 区分「设备离线」与「协议未加载」。
4. **可观测性**：迁移期加开关式日志 `renderer resolve protocol=... deviceId=... plugin=... ms=...`，真机排查可直接定位「为什么这台设备不出声」。
5. **回退粒度**：增加临时开关 `MF_RENDERER_FACTORY=legacy|registry`（默认 `registry`），异常时切开关即可回退，不必重建镜像；阶段 4 收口时删除，避免长期双轨。
6. **契约清理**：`cast` 目前实现全为 throw（dead surface），建议阶段 4 评估删除或改名；`control` 保持 optional。

### 阶段 -1 — 前置清理（v4.15.15，已落盘待发版）

> 性质：**唯一改变可观察行为的一版**，必须先于迁移发版并稳定，否则迁移出问题无法归因。
> 完整台账：本文「阶段 -1」小节（代码 / 测试 / 守卫明细）+ §11（热补丁、真机 G1–G8、回滚）。

**-1.1 不可停用**

- `routes/api/plugins.ts` 的 toggle 按 `BUILTIN_RENDERER_IDS`（`plugins/builtins.ts`，由 `BUILTIN_RENDERER_PLUGINS` 派生）判定：三个渲染器幂等写 `enabled=1` 后立即返回。
- 删除 toggle 内 airplay/sendspin 的 `start/stop*Service()` 联动（13 行 → 9 行）及 4 个不再使用的顶层 import。
- `renderers/sendspin.ts` `defaultEnabled: false → true`（否则不可停用 + 默认关闭 = 新装实例永远开不起来）。

**-1.2 死门面删除**

- 删 `plugins/renderers.ts` 的 `castToRenderer` / `controlRenderer`（-1288 字节）；`discoverRenderers` 保留。
- 三插件 manifest 文案去掉两个已删函数名（`dlna` 中文 2 条、`airplay` 中英各 1 条）。
- `RendererPlugin.cast` / `control?` 契约与三个 `impl` 实现保留不动。

**-1.3 测试与守卫**

- `tests/routes/lt2_pluginsRouteBranches.test.ts`：两条 toggle 用例改为「不可停用」（DB 仍 1 / stop+start 零调用 / 外部改 0 后幂等拉回）。
- 删死门面 7 条用例：`renderersLongTail` 6→2、`dispatch` 12→9。
- `check-airplay-playback-chain.mjs` R19 三条断言改写；**判据用 `void stopXxxService()`**（`await stopSendspinService()` 是端口热更新，合法）。

**-1.4 出口判据**

- [x] `-1a` toggle 幂等置 1（`builtinRenderer ? 1 : (p.enabled ? 0 : 1)`）`（✅ 2026-11-27 21:16 · 证据：[ai] patch_v41515b.py --apply 落盘，diff 13 行→9 行）`
- [x] `-1b` 停机联动删除 + 4 个 import 删除 `（✅ 2026-11-27 21:16 · 证据：[ai] git diff backend/src/routes/api/plugins.ts）`
- [x] `-1c` sendspin `defaultEnabled: true` `（✅ 2026-11-27 21:16 · 证据：[ai] git diff renderers/sendspin.ts）`
- [x] `-1d` 两死门面删除 + 文案同步 `（✅ 2026-11-27 21:16 · 证据：[ai] renderers.ts -1288 字节；dlna 2 行 / airplay 2 行）`
- [x] `-1e` lt2 两条用例改写 `（✅ 2026-11-27 21:16 · 证据：[ai] 13 tests passed）`
- [x] `-1f` 死门面 7 条用例删除 `（✅ 2026-11-27 21:16 · 证据：[ai] longtail 2 passed / dispatch 9 passed）`
- [x] `-1g` R19 三条断言改写 `（✅ 2026-11-27 21:17 · 证据：[ai] check-airplay-playback-chain.mjs EXIT=0，R19 三项 ✓）`
- [x] `-1h` `tsc --noEmit` 0 错 `（✅ 2026-11-27 21:16 · 证据：[ai] TSC_EXIT=0）`
- [x] `-1i` 全量守卫 37 个全绿 `（✅ 2026-11-27 21:17 · 证据：[ai] GUARDS total=37 failed=0）`
- [x] `-1j` 全量 `npx vitest run` 全绿 `（✅ 2026-11-27 21:24 · 证据：[ai] Test Files 696 passed / Tests 9113 passed + 16 skipped (9129) / 0 failed，耗时 336s）`
  - 2026-11-27 复审：全量 3 轮，2 轮全绿（696 / 9113 passed + 16 skipped = 9129）；1 轮 1 例超时（`tests/rest/opensubsonic.test.ts` 的 `getLyricsBySongId 无歌词时返回空 structuredLyrics 且 ok`，并发下 >20s；单文件单跑 17.6s 通过）。判定为既有慢用例触顶，与本方案无关；✅ 保留。
 - [x] `-1k` 构建 + 热补丁 240 + 真机 G1–G8 `（✅ 2026-11-27 全绿：镜像 digest 054b3f2c…66c665、/ping 4.15.15+fd03e97、启动 ERROR=0；G1–G5 服务端实测（三渲染器 toggle 回弹 en=1、PUT 不改写、child PID 28/46/70 不变）；G6 用户听感确认通过；G7 DB/dist 旧门面 0 命中；G8 空库实例三渲染器默认 en=1，唯一 FATAL 为 JWT 自动生成，良性）`
- [x] `-1l` `SPEC.md` §1.5 重写 `（✅ 2026-11-27：按 §11.1 全文替换；旧条款「可停用/默认关闭/零常驻」已零残留）`
 - [x] `-1m` `CHANGELOG.md` v4.15.15 条目 `（✅ 2026-11-27：条目已随 fd03e971 提交，见 §11.2）`
 - [x] `-1n` push main + tag + CI 双绿 + digest/APP_VERSION 核对 `（✅ 2026-11-27：main/tag 已推送，CI 12/12 全绿，镜像 ghcr 4.15.15，digest 054b3f2c…66c665；240 /ping 核对 4.15.15+fd03e97）`

---

**-1o（2026-11-27 审核新增，✅ 已落地）** 渲染器用户可见文案与「不可停用」对齐：
- `sendspin.ts` 中/英文「默认关闭 / Disabled by default」已改为「始终启用 / Always enabled」；
- `airplay.ts` 注释与中/英文说明已改为「始终启用，随进程常驻」。
验收：`grep -rn "停用后\|默认关闭\|零常驻" services/plugin/renderers/` 对 sendspin / airplay 零命中（dlna 的「大文件直通默认关闭」属另一语义，保留）。

### 阶段 0 — 前置（不动物理位置，不改任何播放入口）

**0.1 契约扩容**
- `plugins/types.ts:513` 的 `RendererPlugin` 增加 `createPlayer?(protocol: RendererProtocol, deviceId: string): ProtocolPlayer | null`（内容见 §3.0③）。
- `ProtocolPlayer` 类型从 `services/player/types.ts` **仅做类型 re-export** 供插件契约引用；**不改接口本体**（8 个方法一字不动）。

**0.2 核心门面**
- `services/pluginAccess.ts` 增加同步门面：
  ```ts
  /** 按 deviceId 找拥有该设备的 renderer 插件，取其 createPlayer 工厂。
   *  遍历顺序 = 注册顺序；首个返回非 null 者胜出。
   *  对照 MA mass.get_provider(instance_id)：核心按能力查表，不 import 实现。 */
  export function createRendererPlayer(protocol: RendererProtocol, deviceId: string): ProtocolPlayer | null
  ```
- 实现要点：`registry.getEnabledByCapability("renderer")`（同步）→ 逐个 `impl.createPlayer?.(protocol, deviceId)` → 非 null 即返回；全程**不得** `await`、不得缓存实例。

**0.3 守卫先行**
- 新增 `backend/scripts/check-renderer-plugin-boundary.mjs`（规则 B1–B7，见 §4.2b），**首版以「白名单全量」上线**（只打印不退出非零），待阶段 1 起逐项收紧。
- 实测（2026-11-27）：`check-workflow-paths.mjs` 按 `SCRIPT_DIRS`（`backend/scripts`）**自动扫描**，无需手工登记；B4 改为自检该目录仍在扫描范围。

**0.4 文档**
- `docs/PLUGIN_ARCHITECTURE.md` 契约章节补 `createPlayer`；
- `docs/PLUGIN_DEV.md` §4.7 补一句「renderer 仍仅内置可用（`CAP_METHODS` 无 renderer 行），`createPlayer` 只对内建插件生效」。

**0.5 不改清单（阶段 0 严格禁止）**
- ❌ 不改 `QueueController.ts` 任何一行
- ❌ 不改三个 `renderers/*.ts`
- ❌ 不改 `plugins.ts` / `builtins.ts` / `registry.ts`
- ❌ 不改 manifest
- ❌ 不改任何现有 import 图（§0.2.2 陷阱 3）

**0.6 验证**
```bash
cd backend && npx tsc --noEmit                       # 0 错
node scripts/check-renderer-plugin-boundary.mjs       # 可运行，白名单模式
for f in scripts/check-*.mjs; do node "$f" || echo "RED: $f"; done   # 37 个全绿
npx vitest run tests/plugins tests/player             # 定向
```

**0.7 出口判据**
- [x] `tsc --noEmit` 0 错 `（✅ 2026-11-27）`
- [x] 37 个既有守卫全绿，新增守卫可运行 `（✅ 36 个 .mjs + check-builtins.mts 19/19；新守卫 PASS，白名单模式）`
- [x] `git diff` 仅含 `plugins/types.ts` / `services/pluginAccess.ts` / 新增守卫脚本 / 文档 `（另含 tests/plugins/rendererFactory.test.ts，用户 2026-11-27 批准新增）`
- [x] `QueueController.ts` diff 为空（`git diff --stat` 无输出）

---

### 阶段 1 — DLNA 试点（风险最低）

选 DLNA 打头：`cast` 是**真实现**（走 `castToDevice`），且 DLNA **不入群组**（SPEC 已定：群组只支持 airplay/sendspin 入组），完全不碰桥。

**1.1 插件侧加工厂** — `services/plugin/renderers/dlna.ts`（142 行，插件对象在 `:97`）
```ts
export const dlnaRendererPlugin: RendererPlugin = {
  manifest: dlnaRendererManifest,
  // ...现有 discover / cast / control 原样不动...
  createPlayer(protocol, deviceId: string) {
    if (protocol !== "dlna") return null;             // 归属闸门（强制）
    if (!dlnaOwnsDevice(deviceId)) return null;       // 用 DLNA 自身设备表校验，禁止盲透传
    return createDlnaProtocolPlayer(deviceId);
  },
};
```
> **需新增一个符号到现有 import 块**（`:16-21` 的 `from "../../../services/dlna/control.js"` 里加 `createDlnaProtocolPlayer,`）。
> 注意相对层级是**三层**（`renderers → plugin → services → src`），现有代码即如此，别写成两层。

**1.2 核心侧换接线** — `services/player/QueueController.ts`
| 位置 | 改法 |
|---|---|
| `:13` import 行 | 从 `{ createDlnaProtocolPlayer, getEffectiveBaseUrl, clearCurrentMedia, getDevice, alignDeviceToPosition }` 中**只删掉 `createDlnaProtocolPlayer` 一个符号**，其余四个保留（它们仍被本文件使用） |
| `:475` `registerDlnaDevice` | 原 `up.attachProtocol(createDlnaProtocolPlayer(deviceId));` 改为三行：`const proto = createRendererPlayer("dlna", deviceId);` / `if (!proto) { log.debug("[QueueController] DLNA 设备无播放器工厂，跳过注册", { deviceId }); return; }` / `up.attachProtocol(proto);` |
| `:2777` 组内 DLNA 分支 | 改成 `const p = createRendererPlayer("dlna", deviceId); if (!p) continue;`（该处已在 `try` 内，保持原有 catch 语义与 `continue` 行为） |

**1.3 不改清单**
- ❌ `dlna/control.ts` 的 `createDlnaProtocolPlayer` 实现（原样保留，只是改调用方）
- ❌ `castToDevice` / `/v1/dlna/cast` 语义
- ❌ `dlna:${deviceId}` 前缀约定
- ❌ 任何日志文案（`registered DLNA device:` 保持逐字）

**1.4 验证**
```bash
npx tsc --noEmit
npx vitest run tests/dlna tests/player tests/plugins
node scripts/check-dlna-realtime.mjs && node scripts/check-seek-granularity.mjs \
  && node scripts/check-audio-output-format.mjs && node scripts/check-playback-regression.mjs
node scripts/check-renderer-plugin-boundary.mjs   # 白名单移除 QueueController 的 DLNA 那条
```

**1.5 回滚**：`git revert <该阶段单提交>`，或把 `:475/:2777` 换回直接调用（1 分钟）。

**1.6 出口判据**
- [x] `QueueController.ts` 内 `createDlnaProtocolPlayer` 命中数 = **0** `（✅ 2026-11-27：tsc 0 错；tests/dlna+player+plugins 106 文件/1385 用例全过；专项守卫 4 条全绿；B2 降为 2（airplay+sendspin）。HiVi 真机四项待下次构建部署）`
- [ ] `tests/dlna` / `tests/player` 用例数不降且全绿
- [ ] DLNA 真机（HiVi）：起播 / 切歌 / seek / 音量 / 暂停续播 各一次正常
- [ ] 五拓扑基线中 `mixed` 与 `ap-only` 不受影响（DLNA 不入组，本阶段不应改变任何 tick 数据）
- [ ] `git diff` 仅含 `renderers/dlna.ts`、`QueueController.ts`（两类改动）

---

### 阶段 2 — AirPlay

> **最敏感的一阶段**：AirPlay 同时存在「直连」与「桥成员」两条路径，且桥是本项目踩坑最多的模块。**只换取实例的入口，桥的一切逻辑不动。**

**2.1 插件侧加工厂** — `services/plugin/renderers/airplay.ts`（149 行，插件对象在 `:112`）
```ts
createPlayer(protocol, deviceId: string) {
  if (protocol !== "airplay") return null;          // 归属闸门（强制）
  if (!airPlayOwnsDevice(deviceId)) return null;    // 用 AirPlay 自身设备表校验
  return createAirPlayPlayerForDevice(deviceId);
},
```
> 需**新增 import**：`import { createAirPlayPlayerForDevice } from "../../../services/airplay/protocolPlayer.js";`（三层相对层级，与现有 `:13` 的 `listAirPlayDevices` 同款）
> 环安全性见 §3.0①：`airplay/protocolPlayer` 不反向依赖 `renderers/airplay`。

**2.2 核心侧换接线** — `QueueController.ts`
| 位置 | 改法 |
|---|---|
| `:14` import 行 | 整行删除（`createAirPlayPlayerForDevice` 是该行唯一符号） |
| `:517` `registerAirPlayDevice` | 改经门面；null 时 `return`（**不要**退化成"跳过桥、走直连"——那会改变行为） |
| `:2847` 组内 AirPlay 非桥分支 | 改经门面；null 时 `throw`（保持原 `throw new Error("桥路由未激活...")` 的同级语义：宁可失败也不静默降级） |

**2.3 不改清单（本阶段红线）**
- ❌ `airplay/protocolPlayer.ts` 内部任何一行（含桥/非桥分支、`selectAirPlayBridgeProtocol`、`bridgePrepareDevice`）
- ❌ `group/protocolPlayer.ts`（群组泵）
- ❌ `MUSICFLOW_AIRPLAY_BRIDGE` 开关语义
- ❌ DLNA-AP 互斥链（`check-airplay-dlna-mutex` 必须原样绿）
- ❌ AP2 配对 / 凭证路径

**2.4 验证**
```bash
npx tsc --noEmit
npx vitest run tests/airplay tests/group tests/player tests/plugins
node scripts/check-airplay-playback-chain.mjs && node scripts/check-airplay-bridge.mjs \
  && node scripts/check-airplay-dlna-mutex.mjs && node scripts/check-airplay-decode-af.mjs \
  && node scripts/check-airplay-stream-auth.mjs && node scripts/check-airplay-rtsp-line.mjs \
  && node scripts/check-airplay-ap2-discovery.mjs && node scripts/check-group-invariants.mjs
```

**2.5 出口判据**
- [ ] `QueueController.ts` 内 `createAirPlayPlayerForDevice` 命中数 = **0**
- [ ] `tests/airplay`(75 个测试文件) / `tests/group`(17 个测试文件) 全绿且用例数不降
- [ ] 真机四组合各一次：**AP1 非桥**、**AP1 桥成员**、**AP2 已配对**、**AP2 未配对回落**
- [ ] 群组（airplay+sendspin 混合）切歌 5 次：桥会话不断、`[airplay-bridge]` tick 连续、无 tick 断档
- [ ] 五拓扑基线 `mixed` / `ap-only` / `ap1-only` / `ap2-only` 四项判据同改造前
- [ ] 日志中 `registered AirPlay device:` 文案与次数不变

---

### 阶段 3 — Sendspin

**3.1 插件侧加工厂** — `services/plugin/renderers/sendspin.ts`（232 行，插件对象在 `:221`）
```ts
createPlayer(protocol, deviceId: string) {
  if (protocol !== "sendspin") return null;         // 归属闸门（强制）
  if (!sendspinOwnsDevice(deviceId)) return null;   // 用 Sendspin 自身名单校验
  return createSendspinProtocolPlayer(deviceId);
},
```
> 需**新增 import**：`import { createSendspinProtocolPlayer } from "../../../services/sendspin/protocolPlayer.js";`（与现有 `:16-20` 的 `from "../../../services/sendspin/control.js"` 同层级）

**3.2 核心侧换接线** — `QueueController.ts`
| 位置 | 改法 |
|---|---|
| `:15` import 行 | 整行删除 |
| `:543` `registerSendspinDevice` | 改经门面；null 时 `return` |

**3.3 不改清单**
- ❌ `sendspin/protocolPlayer.ts` 内部（in-proc / fork 双模式分支）
- ❌ `isForkMode()`、`getServer()`、supervisor RPC 路径
- ❌ 推流引擎 `streamEngine`、`playerCore`
- ❌ **启用/停用语义整块**（`plugins.ts`、`isSendspinEnabled()`、manifest `defaultEnabled`）—— 见 §7 第 7 条

**3.4 验证**
```bash
npx tsc --noEmit
npx vitest run tests/sendspin tests/player tests/plugins
for f in scripts/check-*.mjs; do node "$f" >/dev/null 2>&1 || echo "RED: $f"; done   # 全量守卫
node scripts/check-playback-regression.mjs && node scripts/check-display-progress.mjs
```
> 注意：`node scripts/check-sendspin-*.mjs` 这类写法在 node 下**不会**展开通配符（只会执行第一个），必须用 `for` 循环逐个跑。

**3.5 出口判据**
- [ ] `QueueController.ts` **静态 import** 中三个工厂符号 = **0**；仅剩 `:24` 的 `suffixToMime`（M1 = 1，见 §4.2 口径澄清）
- [ ] `tests/sendspin`(80 个测试文件) 全绿且用例数不降
- [ ] 真机 ESP32 sendspin（`esp32-player2`）：起播 / 切歌 / seek / 音量 / 多房同步
- [ ] 五拓扑基线 `ss-only` 的帧判据（`A_ssFrame.maxGapMs`、每次切歌后帧增量）同改造前
- [ ] 插件页 sendspin 行行为与改造前**逐项一致**（点停用 → 200 + enabled 仍 1，不改）

---

### 阶段 4 — 收口

1. **守卫收紧到最终态**：`check-renderer-plugin-boundary.mjs` 从白名单模式改为**硬拦截**（B1 命中即退出非零）。
2. **死门面已删除**（**v4.15.15 已完成，本阶段只做确认**）：`renderers.ts` 的 `castToRenderer` / `controlRenderer` 生产零调用，属被淘汰的「把 URL 交给设备自拉流」模型（会绕过 `QueueController` 的进度 / hold / 延迟处理）。
   - 已删函数体，文件头注释写明删除原因与新入口（`createPlayer`）；
   - 对应用例 7 条一并移除（`renderersLongTail` 4 条 + `dispatch` 3 条）；
   - **`discoverRenderers` 保留**（`GET /v1/plugins/renderers` 在用）；
   - `RendererPlugin.cast/control?` 契约字段与三个 `impl` 实现**保留**（`cast` 在类型上必填，删它会波及外置插件形状）。
   - 本阶段判据：`grep -rn 'castToRenderer\|controlRenderer' backend/src` 只应命中注释与 manifest 文案以外的 0 处。
3. **文档收口**：
   - `docs/player-unification-plan.md` §2.6「第三套控制面待收敛（未开始）」→ 标记已收敛，§7 步骤 2 更新；
   - `docs/PLUGIN_ARCHITECTURE.md` §1 的耦合点清单更新为迁移后状态；
   - 本文档状态改为「已实施」。

**阶段 4 出口判据**
- [ ] M3 达成：对两服务的**播放器工厂符号引用 = 0**；18 个存量 importer 逐条有结论（迁移 / 永久豁免 / 移出本方案）；白名单外零新增（旧「≤ 8 / ≤ 20」经实测不可达，已作废，见 §4.2 / §4.2a）
- [ ] 守卫 38 个全绿，边界守卫为硬拦截
- [ ] `git grep -n "createDlnaProtocolPlayer\|createAirPlayPlayerForDevice\|createSendspinProtocolPlayer" backend/src/services/player/` 输出为空
- [ ] 全量：`npx vitest run` 全绿，**用例总数 ≥ 9129**（v4.15.15 后的新基线 = 9136 − 死门面 7 条；见 §4.2 M5 口径）

---

## 4. 验收标准（完整版）

> 分三层：**§4.1 五层等价（每阶段必跑）** → **§4.2 量化指标 + §4.2b 守卫规则 + §4.3 阶段清单（逐阶段）** → **§4.6 发版终验（全部阶段完成后）**。
> 任一层不通过 = 不进入下一步；不允许「先合并、后面补」。

### 4.1 五层行为等价（每阶段都必须全过）

| 层 | 命令 / 手段 | 通过判据 | 不通过怎么办 |
|---|---|---|---|
| **L1 单测** | `npx vitest run`（受影响目录先跑，收尾跑全量） | 用例数 **≥ 9129**（新基线）；**零删除**；**零断言修改** | 有断言要改 = 行为已变 → **回滚该阶段**，不改测试 |
| **L2 拓扑** | CI `playback-baseline.yml` → `sim-e2e` 五拓扑 | `deltaUs p50∈[1.2,4]s`、`negPct≤1%`、`inQueueMs p95≤3925ms`、`overCapPct≤5%`、`realigned/min≤30`、`advanceRate∈[0.98,1.02]`、无回退、`A_switch.count≥5`、`failed=0`、`maxSettleMs≤25s` | 逐拓扑比对找出是哪个拓扑、哪个指标漂了，回到该阶段的 diff 查 |
| **L3 守卫** | `for f in scripts/check-*.mjs; do node "$f"; done` | 37 个既有守卫**零修改**全绿 | 某条变红 → 先假定「行为变了」，查清再放行；**不得**为了让守卫过而改守卫 |
| **L4 真机 A/B** | 240 同设备同歌单，改造前后各一轮采样 | 按 `docs/播放基线-基准值与判读-20261126.md` §3 指标集逐项比对，落在同一判读区间 | 差异项单独取证（pcap + 日志双面），定性后再决定是否回滚 |
| **L5 diff 审查** | `git diff` 人工过一遍 | 只含三类改动：import 行、工厂调用行、新增文件 | 出现逻辑行变更 → 拒收 |

**L5 的机械检查（可直接粘，只审源码不动文档）**：
```bash
# 每阶段提交前跑：backend/src 内除「import 行 / 工厂调用行 / attachProtocol 行 / null 守卫行」外的改动应为 0
git diff --unified=0 -- backend/src | grep -E '^[+-][^+-]' \
  | grep -vE '^[+-]\s*import |^[+-]\s*\} from ' \
  | grep -vE 'createRendererPlayer|create(Player|Dlna|AirPlay|Sendspin)|attachProtocol' \
  | grep -vE '^[+-].*(if \(!(proto|p)\)|return;|continue;|log\.debug\(.*跳过注册)' \
  | grep -vE '^(\+\+\+|---) ' \
  || echo "L5_OK: 无逻辑行改动"
```
> 这是**辅助**检查，不是唯一判据：白名单里放行了 `return;` / `continue;`，理论上能藏真逻辑。**最终必须人工过一遍完整 diff**（本方案每阶段 diff 都应在 10 行以内）。

### 4.2 量化指标（写入守卫，最终态）

| # | 指标 | 改造前实测 | 目标 |
|---|---|---|---|
| **M1** | `QueueController.ts` **静态 import** 到 `services/{airplay,sendspin,dlna}/` 的语句条数 | **4**（`:13` `:14` `:15` 三条是播放器工厂；`:24` 是 `suffixToMime`） | **1**（只保留 `:24`，并加注释说明它是纯 MIME 工具、非播放器工厂） |
| **M2** | `QueueController.ts` 内三个工厂标识符命中数 | **5**（`:475` `:517` `:543` `:2777` `:2847`） | **0** |
| **M3** | 对两服务的**静态 import**：播放器工厂符号引用数 / 存量 importer 结论覆盖率 | 工厂符号 5 处直连（QueueController）；全 src 共 18 文件 / 43 条 | **工厂符号引用 = 0**；18 个存量 importer 逐条在 §4.2a 有结论（迁移 / 永久豁免 / 移出本方案）；白名单外**零新增**（原「≤ 8 / ≤ 20」经实测不可达，已作废） |
| **M4** | 白名单外新增静态 import | — | **零容忍** |
| **M5** | 测试文件数 / 用例数（**运行时 vitest 计数**） | **696 / 9129**（v4.15.15 基线；v4.15.14 为 696 / 9136，死门面删除 −7） | **≥ 9129**，且 `tests/{airplay,sendspin,group,player}` **零删除** |
| **M6** | 守卫脚本数 | 37 | **38**（新增边界守卫），全绿 |
| **M7** | `tsc --noEmit` | 0 错 | **0 错** |

**M5 口径澄清（2026-11-27 实测更正）**

早期文档写的「643 文件 / 9136 用例」来自源码文本计数（`find tests -name '*.test.ts'` + 正则数 `it(`/`test(`），**与运行时口径不同**（`.each` 展开、循环生成的用例、`src/**/*.test.ts` 旁置测试都不计入文本计数）。
以 `npx vitest run` 的运行时汇总为准：v4.15.14 = **696 文件 / 9136 用例**；v4.15.15（删死门面 7 条）= **696 / 9129**（9113 passed + 16 skipped）。

### 4.2a 存量 importer 清单与归属结论（2026-11-27 实测，M3/B1 口径）

- ✅ **永久豁免（8 文件 / 26 条）**：`group/{index,protocolPlayer,watchdog}.ts`（16）、`index.ts`（4）、`dlna/announce.ts`（1）、`services/{access,peer}.ts`（3）、`memory/pruneOrphans.ts`（2）。
- 🟡 **同类豁免（2 文件 / 2 条）**：`plugin/renderers/{airplay,sendspin}.ts` 属插件侧，本就应 import 协议实现，B1 不扫描。
- ⏳ **待定（8 文件 / 15 条，阶段 4 前逐条给结论）**：`routes/api/airplay.ts`(1)、`routes/api/peers.ts`(2)、`routes/api/settings.ts`(1)、`routes/api/shared.ts`(5)、`routes/rest/index.ts`(2)、`services/flows/index.ts`(2)、`services/playTarget.ts`(1)、`services/player/playerWebhook.ts`(1)。
- 判定原则：`import type` 一律放行；仅「用协议工厂造播放器」算越界；纯常量/类型引用登记后豁免。

后续所有「用例数不降」一律按运行时口径判定。

**M1/M3 口径澄清（重要，避免验收误判）**

`QueueController.ts` 里还有 **7 条动态 `await import(...)`** 指向协议目录，**本期一律不动**：

| 位置 | 动态导入 | 性质 |
|---|---|---|
| `:775` `:1045` `:1046` | `sendspin/playerCore` · `sendspin/index`（`sendspinGroupName` / `sendspinGroupSetPlaybackRate` / `sendspinGroupPumpActive`） | 群组状态查询 |
| `:2821` `:2838` | `airplay/control`（`getAirPlayStatus` / `isAirPlayDeviceDisabled` / `isAirplayBridgeEnabled`） | 设备状态 / 桥开关 |
| `:2842` | `group/protocolPlayer`（`bridgeJoinMember`） | 群组泵（本就豁免） |

不动它们的三个理由：
1. 它们**不是播放器工厂**，不属于本方案的解耦目标（目标是「谁 new 播放器」）；
2. 动态 import 本身就是**为规避循环依赖**而写的（该文件头部与 `:2821` 上下文都能看出）；
3. 改成门面会扩大改动面、把「状态查询」也卷进插件抽象，**增加行为风险而收益极小**。

⇒ **M1 只统计静态 import**；动态 import 既不计入 M1，也不计入 M3 的"条数"。守卫 B1 只匹配 `^import …` / `from "…"` 形态，不匹配 `await import(`。

**M3 白名单（最终态，共 4 类语义，不得再扩）**：
`group/*`（群组泵+桥，MA 同样技术债）、`index.ts`（启动门控）、`dlna/announce.ts`（§1.4 互斥）、
`services/{access,peer,memory/pruneOrphans}.ts`（设备基础设施）。

### 4.2b 新增守卫 `check-renderer-plugin-boundary.mjs` 规则（B1–B7）

风格对齐 `check-core.mts`：**剥注释后按行匹配**、白名单显式列明、新增越界零容忍。零依赖 node 脚本（与既有 37 个同款）。

| 规则 | 内容 | 对应目标 |
|---|---|---|
| **B1** | 核心目录**不得引用**协议模块的**非类型导出**（工厂 / service 函数 / 常量）；`import type` 放行；`plugin/renderers/*` 不纳入扫描 | M3 |
| **B2** | `services/player/QueueController.ts` 内**禁止出现** `createAirPlayPlayerForDevice` / `createSendspinProtocolPlayer` / `createDlnaProtocolPlayer` 标识符（含静态 import 行）。**动态 `await import(` 不匹配** | M1 · M2 |
| **B3** | 声明了 `capabilities: ["renderer"]` 的内置插件**必须**实现 `createPlayer`（除显式声明的核心语义组插件） | 契约完整性 |
| **B4** | 元守卫联动：脚本位于 `backend/scripts`（`check-workflow-paths.mjs` 的 `SCRIPT_DIRS` 自动扫描）；守卫自检该目录仍在范围内 | 元守卫一致性 |
| **B5** | manifest 字段：**本期不新增字段**，故 `check-builtins.mts` 不动。将来若引入 `allowDisable`，再同步其字段白名单 + `PLUGIN_DEV.md` §3 字段表 | 防「未知字段」误红 |
| **B6** | **同步签名锁定**：`createPlayer` 声明中不得出现 `async` / `Promise`；`QueueController.ts` 不得对 `createRendererPlayer(...)` 的返回值 `await` | §0.2.2 陷阱 1 |
| **B7** | **启用逻辑冻结（以阶段 0 打点为基线）**：`plugins.ts` 的 `BUILTIN_RENDERER_IDS` 判定、各 `isXxxEnabled()` 实现、三个 renderer manifest 的 `defaultEnabled` 值，在**阶段 0 之后**的 diff 中必须零改动（v4.15.15 的改动属于基线，不计入） | §7 第 7 条 |

> B1/B2 在阶段 0 以**白名单全量模式**上线（只打印、不退出非零），每完成一个阶段就收紧一项；阶段 4 改为**硬拦截**。
> B6/B7 是本次「行为等价」专用规则 —— 它们不检查架构，只防止**顺手改坏播放语义**。

### 4.3 每阶段验收清单（逐条打勾，不许跳过）

格式：`[阶段] 编号 · 检查项 · 判据`

**阶段 -1（v4.15.15 前置清理）** —— 明细 15 条在「阶段 -1」小节，这里只列 4 条宏观出口判据

- [x] `-1-a` 代码与测试改动完成（toggle 幂等置 1 / sendspin 默认开启 / 死门面删除 / 7 条用例移除 / R19 改写）`（✅ 2026-11-27 21:17 · [ai] 19 处补丁落盘 + git diff 复核）`
- [x] `-1-b` 机器验证全绿（tsc 0 错 / 定向 24 用例 / 37 守卫 / CRLF 0）`（✅ 2026-11-27 21:17 · [ai] TSC_EXIT=0 · 3 files 24 tests · GUARDS 37 绿 · CR=0）`
- [ ] `-1-c` 240 热补丁 + 真机 G1–G8 `（[~] 全量 vitest 已绿(9129)，热补丁与真机未开始）`
- [ ] `-1-d` SPEC §1.5（§11.1）+ CHANGELOG（§11.2）+ push/tag/Release + digest 核对 `（未开始）`

**阶段 0**
**阶段 0**
- [ ] `0-a` `RendererPlugin` 已含 `createPlayer?` 且**同步**签名（`grep -A2 'createPlayer' plugins/types.ts` 无 `Promise`）
- [ ] `0-b` `createRendererPlayer` 为同步函数（无 `async`），内部无 `await`
- [ ] `0-c` `tsc --noEmit` 0 错
- [ ] `0-d` 37 守卫全绿 + 新守卫可运行
- [ ] `0-e` `QueueController.ts` diff 为空
- [ ] `0-f` 三份文档已就位：`SPEC.md` §1.5 已是校正版（v4.15.15 已改，只确认）；`PLUGIN_ARCHITECTURE.md` §1 与 `PLUGIN_DEV.md` §4.7 的更新在本阶段执行

**阶段 1（DLNA）**
- [ ] `1-a` `QueueController.ts` 中 `createDlnaProtocolPlayer` = 0 命中
- [ ] `1-b` `tests/dlna` 用例数不降，全绿
- [ ] `1-c` 守卫：`check-dlna-realtime` / `check-seek-granularity` / `check-audio-output-format` / `check-playback-regression` 全绿
- [ ] `1-d` HiVi 真机：起播 / 切歌 / seek / 音量 各一次正常，`[ERROR]` = 0
- [ ] `1-e` L5 diff 仅两类改动
- [ ] `1-f` 五拓扑基线未退化（重点 `mixed`、`ap-only`）

**阶段 2（AirPlay）**
- [ ] `2-a` `QueueController.ts` 中 `createAirPlayPlayerForDevice` = 0 命中
- [ ] `2-b` `tests/airplay`(75 个测试文件) / `tests/group`(17 个测试文件) 全绿且用例数不降
- [ ] `2-c` 八个 airplay/group 守卫全绿（playback-chain / bridge / dlna-mutex / decode-af / stream-auth / rtsp-line / ap2-discovery / group-invariants）
- [ ] `2-d` 真机四组合：AP1 非桥 / AP1 桥成员 / AP2 已配对 / AP2 未配对回落
- [ ] `2-e` 混合群组切歌 5 次：桥不断、tick 连续、无断档
- [ ] `2-f` 五拓扑 `mixed` / `ap-only` / `ap1-only` / `ap2-only` 判据同前
- [ ] `2-g` 日志 `registered AirPlay device:` 文案与次数不变

**阶段 3（Sendspin）**
- [ ] `3-a` M1 达成（4 → 1：三条工厂消失，仅留 `suffixToMime`）
- [ ] `3-b` `tests/sendspin`(80 个测试文件) 全绿且用例数不降
- [ ] `3-c` `check-playback-regression` / `check-display-progress` 全绿
- [ ] `3-d` ESP32 真机：起播 / 切歌 / seek / 音量 / 多房同步
- [ ] `3-e` 五拓扑 `ss-only` 帧判据同前
- [ ] `3-f` 停用语义零改动：`plugins.ts` / manifest / `isSendspinEnabled()` diff 为空

**阶段 4（收口）**
- [ ] `4-a` M2 达成（5 → 0）
- [ ] `4-b` M3 达成（静态 import ≤8 文件 / ≤20 条，全白名单；动态 import 不计入）
- [ ] `4-c` M6 达成（38 守卫全绿，边界守卫硬拦截）
- [ ] `4-d` 全量 `npx vitest run` 全绿，用例 ≥ 改造前
- [ ] `4-e` 文档三处收口（player-unification §2.6 / PLUGIN_ARCHITECTURE §1 / 本文档状态）

### 4.4 行为等价专项（Given-When-Then）

**主流程（每阶段都要复验）**
```
Given 目标插件已启用，设备在线
When  从队列对设备起播一首
Then  设备出声；QueueController 经 pluginAccess 同步拿到 ProtocolPlayer；
      /v1/peers/:id/status 的 positionMs 连续单调、无回跳；
      /status 的 state 与进度同源（暂停态不出现进度继续走）
```

**三元分工不被打乱**
```
Given 一首歌播放到曲末最后 10s
When   tracker 用 positionMs=duration 判结束
Then  API 暴露的 displayPositionMs 仍为真实播放位置（不得被 pin 到 duration）；
      客户端进度条不出现「凭空多几秒」或「往回跳」
```

**hold 期间 state 同源**
```
Given 切歌瞬间旧曲 tail 仍在响（displayHold 生效）
When  客户端拉 /status
Then  position/duration 指向旧曲的同时 state 必为 PLAYING；
      放开 hold 后进度不跳变
```

**工厂不缓存、不复用**
```
Given 同一设备连续起播两首不同的歌
When  第二次注册/取实例
Then  两次拿到的是不同实例（或至少不复用上一次的协议会话）；
      第二首不继承第一首的会话状态（表现为不出现「接着上一首播」）
```

**异常：插件未实现 createPlayer**
```
Given 某 renderer 插件无 createPlayer
When  该设备被发现
Then  不注册该设备（不抛错、不崩），其余协议不受影响；仅一条 debug 日志
```

**边界：群组桥（最易踩）**
```
Given 群组正在播放，成员含 airplay + sendspin
When  触发切歌
Then  桥会话不断、延迟锚点不变；group/protocolPlayer 的 9 条 import 原样保留；
      [airplay-bridge] tick 连续，无断档
```

**边界：DLNA-AP 互斥**
```
Given 同一台设备同时暴露 DLNA 与 AirPlay
When  AirPlay 起播
Then  check-airplay-dlna-mutex 仍绿（互斥链未被搬迁打断）
```

**边界：启动顺序**
```
Given 容器重启
When  插件尚未加载完成
Then  不启动任何协议服务（启动门控在 core/index.ts，先于插件加载判定）；
      启动日志顺序与改造前一致
```

**边界：停用语义（本期必须"没变"）**
```
Given 任一内置渲染器（airplay / sendspin / dlna）
When  PUT /v1/plugins/<id> {enabled:false}
Then  与改造前逐字节一致：HTTP 200、DB enabled 仍 1、服务未停、设备仍可播、无新增日志
```

### 4.5 真机验收细则（240）

每阶段按 `docs/播放链路排障与采样手册.md`：

1. **热补丁**：230 build → tar(dist+public) → 240 `docker cp`（先备份 `backup_v<ver>/`）→ restart → `/ping`；**版本号不随热补丁更新，以 `dist` 内 `grep` 新符号为准**（如 `grep -c createRendererPlayer dist/**`）。
2. **设备矩阵**（按阶段取子集）：

| 阶段 | 必测设备 | 必测动作 |
|---|---|---|
| 1 | HiVi DLNA | 起播 / 切歌 / seek / 音量 / 暂停续播 |
| 2 | AirPlay 接收端（AP1、AP2 各一） | 非桥起播 / 桥成员起播 / 切歌 / AP2 已配对 / 未配对回落 |
| 3 | ESP32 sendspin（`esp32-player2`） | 起播 / 切歌 / seek / 音量 / 多房同步 |
| 4 | 全矩阵 | 上述全部 + 混合群组长播 10 分钟 |

3. **日志判据**：`[ERROR]` = 0；`[airplay-bridge]` tick 连续；无 `[WARN]` 新增类型。
4. **时序铁律**：**用户真机确认后才 push / tag**；每阶段单独发版，不合并发。

### 4.6 发版终验（Gate，全部阶段后一次性）

| # | 项 | 判据 |
|---|---|---|
| G1 | 五个阶段提交独立、可单独 revert | `git log` 可见 5 个阶段提交 |
| G2 | 全量测试 | `npx vitest run` 全绿，用例 ≥ 9129（v4.15.15 新基线；9136 为 -1 前旧基线） |
| G3 | 全部守卫 | 38 个全绿 |
| G4 | 五拓扑基线 | 五拓扑全绿，判据同改造前 |
| G5 | 240 真机 A/B | §4.5 全矩阵通过，且与改造前采样同判读区间 |
| G6 | 耦合终态 | `QueueController.ts` 静态 import 中的三个工厂符号 = 0（M1=1）；M3 静态 ≤8/≤20 |
| G7 | 文档 | SPEC §1.5 校正获批并落地；PLUGIN_ARCHITECTURE / PLUGIN_DEV / player-unification §2.6 / 本文档状态 全部更新 |
| G8 | 发版流程 | CHANGELOG（LF、条目间 1 空行、`### Change`）→ tag → 盯 main+tag 两路 CI 全 success → Release 非 draft → 镜像 digest ≠ 旧版 **且 image config 的 APP_VERSION 为本次版本**（防回滚 job 用旧 main 重打新 tag） |

### 4.7 一票否决项（任一命中即停止推进）

1. 某个既有测试需要改断言才能过（L1）。
2. 任一拓扑基线判据漂出区间，且无法归因到「非本次改动」。
3. 真机上出现「切歌空窗 / 进度回跳 / 进度冻住 / 凭空多秒」任一症状。
4. `QueueController.ts` 出现逻辑行改动（非 import、非工厂调用）。
5. 启用/停用语义（`plugins.ts` / manifest / `isXxxEnabled()`）在 diff 中出现改动。
6. `createPlayer` 变成 `async`，或门面返回值被 `await`。

---

### 4.8 失败处理手册（红灯先归因，再决定改还是回滚）

> 铁律：**红灯的第一假设永远是「行为变了」，不是「测试/守卫过时了」。** 只有证明是判据本身过时（例如本次已获批的语义变更），才允许改判据，且必须在 §4 记一行变更原因。

| 症状 | 先查什么 | 结论与动作 |
|---|---|---|
| 定向测试红，且断言内容涉及进度/状态/时序 | `git diff` 该测试文件 | 测试**没被改过** → 实现行为变了 → **回滚该阶段**，不回改测试 |
| 定向测试红，断言是「找不到函数/模块」 | 是否删/改了导出名 | 属编译级问题，修 import 或门面名即可，不算行为变更 |
| 37 个既有守卫某条变红 | 该守卫钉的字面量是否被本阶段改动命中 | 命中 → 行为变了 → 回滚；未命中 → 守卫自身对注释/格式敏感，逐条核对后修守卫（记原因） |
| 新增守卫 B1/B2 误报 | 白名单是否漏登记（`group/*`、`index.ts`、`dlna/announce.ts`、`services/{access,peer,pruneOrphans}`） | 补白名单，**不得**放宽规则本身 |
| `tsc` 报 `createPlayer` 返回 `Promise` | 是否顺手写成 `async` | 必须同步返回；B6 会拦。改回同步 |
| 真机进度条回跳 / 曲末不切歌 | `positionMs`（判定）与 `displayPositionMs`（派生）是否被改；hold 期间 `state` 是否与进度同源 | 见 §5.3 铁律；出现即为行为变更 → 回滚该阶段 |
| 切歌空窗变长 / 桥 tick 异常 | `[airplay-bridge]` tick 日志节奏、桥会话是否被复用 | 阶段 2/3 特有；对比改造前采样（§4.5） |
| 热补丁后 `/ping` 版本没变 | **正常现象**（version 不随热补丁更新） | 用容器内 `grep -r BUILTIN_RENDERER_IDS dist/` 验证符号已生效 |
| 240 restart 后接口无响应 | 沉默期约 3.5 min | 等满再判；不要连续 restart |
| CI `ci` 红但 `build-and-push` 绿 | 看是哪个 job、哪一步 | 测试门禁失败会触发**回滚 job**，把 GHCR/DockerHub 的新 tag 与 `:latest` 打回旧 digest（Release 页仍存活） |
| 发版后 digest 变了但版本是旧的 | 读 image config blob 的 `APP_VERSION` | 回滚 job 把旧 main 构建重打了新 tag；补救：`docker buildx imagetools create <repo>:main --tag <repo>:<ver>`，不动 git |

---

## 5. 代码规范与硬约束

### 5.1 SPEC §1.5 变更（2026-11-27 已获批，随 v4.15.15 执行）

**状态：✅ 已获批。** 用户裁决「内置插件改为不可停用」，并明确「按 A 执行」（toggle 幂等置 1 + sendspin 默认开启 + 改守卫/用例/SPEC，单独一版 v4.15.15）。

⚠️ **本节的原始判断已作废**：立项时写的「`plugins.ts:83` `builtin ? 1` 使内置插件强制启用、停用请求被静默忽略」**只对 `PUT /:id` 成立**；`PUT /:id/toggle` 无内置判定，点开关会真停服务。因此这次不是纯文档校正，而是**行为变更**（已单独成版，不与迁移混发）。

落地范围（明细见「阶段 -1」小节）：

| 项 | 落点 | 状态 |
|---|---|---|
| toggle 幂等置 1、不联动停机 | `routes/api/plugins.ts` + `BUILTIN_RENDERER_IDS` | ✅ 已落盘 |
| sendspin 默认开启 | `renderers/sendspin.ts` `defaultEnabled: true` | ✅ 已落盘 |
| 守卫 R19 改写（原「默认开启 ≠ 不可手动关闭」作废） | `check-airplay-playback-chain.mjs` | ✅ 已落盘 |
| 回归用例改写 | `lt2_pluginsRouteBranches.test.ts` | ✅ 已落盘 |
| SPEC §1.5 重写 | `SPEC.md` | ⬜ 待执行（文本见 §11.1） |

**对迁移的约束（不变）**：本方案阶段 0–4 **不再改动** `plugins.ts` 的启用判定、`isXxxEnabled()`、三个 manifest 的 `defaultEnabled`；迁移结束后才允许考虑「停用被拒改 409」「移除 PUT 带 config 顺带写 enabled」等语义细化（另立一轮）。



1 不引入/升级依赖 · 2 不改表结构（本方案**不涉及 DB**）· 3 不重构未指明模块（本次由 ray 显式下达）·
4 不加缓存/队列/中间件/全局状态（`pluginAccess` 是既有门面，**不新增**）· 5 不改路由路径/返回结构/错误码 ·
6 不动无关文件 · 7 不新增无界 Map/Set/定时器 · 8 不吞异常（catch 必打 Error + 入参） ·
9 不碰 `.workbuddy/` `node_modules/` `dist/` `backend/data/` · 10 不私自提交/push/tag ·
11 不把插件仓改动混入本仓 · 12 注释不编造 API/配置项。

### 5.3 项目铁律（本次最易违反的几条）

| 铁律 | 本方案中的落点 |
|---|---|
| **一个数字不能同时当「判定」和「显示」** | 搬迁不得改变 `positionMs`（判定）与 `displayPositionMs`（派生）的分工 |
| **hold 期间 `state` 必须与进度同源** | `createPlayer` 只是取实例的入口变了，`displayHold` 逻辑**一行不改** |
| **延迟补偿唯一落点在投递时戳** | 插件工厂不得介入 lead/delay 计算；`mixed_anchor_lead_ms` 仍在 streamEngine 直查 |
| **对齐 MA 的逻辑必须加注释**（用户铁律） | `createPlayer` 落地处注 `// MA PlayerProvider → mass.players.register(player)`；`getEnabledByCapability` 用法处注 `// MA mass.get_provider(instance_id) 同款：核心按能力取，不 import 实现` |
| **改延迟/桥/BUFFERING 代码必须同步三份权威文档** | 阶段 2/3 完成后同步 `airplay-` / `sendspin-` / `group-权威方案文档.md` |
| **改守卫脚本必须跑全部 `check-*.mjs`** | 每阶段收尾跑全 37+1 个 |
| **日志格式 `[LEVEL] [PREFIX] msg`** | 新增日志走 `createLogger`，禁裸 `console`（`check-log-format.mjs`） |
| **CRLF 双向查** | 文档与脚本用 LF；`grep -c $'\r'` 必须 0 |
| **不写迁移代码** | 本方案不涉及 schema，若后续要加列，直接改建表语句 + 三处同步 |

### 5.4 插件契约规范（`PLUGIN_DEV.md` / `PLUGIN_ARCHITECTURE.md`）

1. **manifest 合规**：`check-builtins.mts` 必须绿 —— `documentation` 必填、`configSchema` 合法、`capabilities` 在白名单内；**本期不新增字段**。
2. **能力 = 契约，不是装饰**：`capabilities: ["renderer"]` 就必须实现 `discover`；声明了 `createPlayer` 就不得返回 `null` 以外的静默失败（返回 `null` = 「本设备不归我管」，必须显式且记 debug 日志）。
3. **不新增 `host.*`**：本方案是内置插件契约扩容，**不碰** `host.ts` / `KNOWN_PERMISSIONS` / `sandbox.ts` / `sandboxWorker.ts`。若未来真要动，按既有约定「三处同步（discovery/sandbox/sandboxWorker）+ capability 四处（types/sandbox/discovery/check.mjs）」。
4. **插件间不得互相调用**：airplay 插件不许 import sendspin 插件（否则回到今天的耦合，只是换了层皮）。跨协议协作**只能经核心**（组泵、互斥链、pluginAccess）。
5. **文档同步**（CONTRIBUTING 硬要求）：
   - `docs/PLUGIN_ARCHITECTURE.md` → 契约章节补 `createPlayer`；
   - `docs/PLUGIN_DEV.md` §4.7 补「renderer 仅内置可用」的说明（`CAP_METHODS` 无 renderer 行是硬事实）；
   - `SPEC.md` §1.5 按 §5.1 修订；
   - 阶段 2/3 完成后，仅当**插件边界描述**变化才同步 `airplay-` / `sendspin-` 权威方案文档；本方案不改延迟/桥/BUFFERING 代码，故按铁律不属于强制同步范围；
   - `docs/player-unification-plan.md` §2.6 / §7 步骤 2 标记为已收敛。

### 5.5 提交与发版

- 提交信息 `<type>(<scope>): <subject>`，如 `refactor(renderer): 插件暴露 createPlayer 工厂`。
- 每阶段独立提交；**只推 main，不擅自打 tag**；发版走既有流程（服务端先热补丁 240 → 真机确认 → 才 push/tag）。
- 前端 `frontend/package.json` 不随发版 bump。

---

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| **目标本身跑偏：为了架构好看而顺手改动播放逻辑** | **最高** | §0.2 五层等价验证 + L5 diff 审查（只准动 import 行与工厂调用行）；出现逻辑行变更即拒收 |
| 门面写成 `async` → 起播时序多一跳 | **高** | 契约强制同步签名；`check-renderer-plugin-boundary` 加规则：`createPlayer` 声明**不得**含 `Promise`/`async` |
| 搬迁过程中「取实例路径」变化导致切歌空窗/进度回跳复发 | **高** | 阶段 1 先拿 DLNA 试（不入组、无桥）；每阶段真机 + `check-playback-regression` R1–R8 + `check-display-progress` + 五拓扑基线 |
| `group/protocolPlayer` 的 9 条 import 被误当作越界而强迁 | **高** | 白名单显式豁免；守卫 B1 只拦「非白名单文件」，group 三文件永久豁免并注明理由 |
| 既有测试需改断言才能过 | **高** | 视为「行为已变」的硬信号：**不改测试，回滚该阶段**（§0.2.3 L1） |
| 插件停用后仍有残留 `ProtocolPlayer` 注册 | 中 | 本期停用不可达（`enabled` 恒 1），风险实际为零；仍保留「`create()` 返回 null 必须 unregister」的设计约束备将来 |
| 误把停用语义一起改进去 | **高** | 停用语义已由 v4.15.15 单独发版落实；本方案以阶段 0 为基线，`plugins.ts` / manifest / `isXxxEnabled()` 列入 diff 禁止改动清单（B7） |
| `castToRenderer` 清理影响管理页 | 低 | **已消解**：v4.15.15 只删编排层门面，`discoverRenderers` 保留，管理页设备列表不受影响 |
| 真机 AP2 配对凭证路径受影响 | 中 | 阶段 2 验收必含「已配对 AP2 设备」与「未配对回落 AP1」各一次 |
| 守卫数量增加拖慢 CI | 低 | 零依赖 node 脚本（与既有 37 个同款），耗时可忽略 |

---

## 7. 明确「不做」的事

1. **不搬 `services/group/`**（群组泵/桥/延迟锚点留核心，MA 也这么做）。
2. **不改进程模型**（`rendererHost` 分工不动，不新增 supervisor）。
3. **不重写 `ProtocolPlayer` 契约**（8 个方法已稳定，只做「导出 + 工厂化」）。
4. **不做外置插件化**（不让 airplay/sendspin 进 QuickJS 沙箱）。硬依据：`sandbox.ts:193` 的 `CAP_METHODS` **不含 `renderer`**，外置 renderer 即使实现也不会被 `makeImpl` 暴露；且沙箱返回值必须是纯数据，承载不了带子进程/socket 句柄的 `ProtocolPlayer`。本方案**不把 `renderer` 加进 `CAP_METHODS`**。
5. **不动 DLNA 既有 `cast` 语义**（`/v1/dlna/cast` 行为契约不变，仅把队列路径改走工厂）。
6. **不做任何前端改动**（插件页维持现状即可：三个渲染器都不可停用，开关态与今天一致）。
7. **不在本方案内再动启用 / 停用语义** —— 该语义已由 **v4.15.15** 单独落地（toggle 幂等置 1、删停机联动、sendspin 默认开启），并已单独发版验证；本方案阶段 0–4 以此为冻结基线。以下三项**仍需另立一轮**，因为它们都进一步改变可观察行为，违反 §0.2：
   - 停用被拒从「200 + 静默忽略」改为「409 + 可读文案」；
   - 移除「带 `config` 的 PUT 顺带把 `enabled` 写 1」的副作用；
   - 把 `builtin ? 1` 改为按 manifest `allowDisable` 显式声明（为将来「可选内置插件」留口子）。
   > 这三项的价值是「把静默缺陷变成明确契约」，但它们会让返回码 / 写库结果 / 日志发生变化。**必须与插件化迁移分开验证**，否则一旦真机出问题无法归因是迁移还是语义改动。

---

## 8. 一句话总结

> 抽象层（`ProtocolPlayer` + `UniversalPlayer`）早就按 MA 的形状建好了，**本方案只做一件事：把「谁 new 播放器」从核心目录 import 改成插件工厂，其余播放行为逐项等价**。
> 两条硬边界：
> ① **行为等价优先于架构达标** —— 任一层（单测 / 五拓扑基线 / 守卫 / 真机 A/B / diff 审查）出现差异就回滚，不让「架构更干净」成为冒险的理由；
> ② **启用/停用语义已在 v4.15.15 前置版落地并冻结** —— 三个渲染器不可停用、sendspin 默认开启；本方案阶段 0–4 以此为基线一行不改，语义细化（409 / PUT 副作用）另立一轮。
> 收尾只加一条守卫：「核心不得直连协议目录」，防止耦合回流。

---

## 9. 回滚

### 9.1 阶段 -1（v4.15.15）

改动集中在 7 个源文件 + 3 个测试 + 1 个守卫，**未提交前**回滚即：

```bash
cd /workspace/MusicFlow
git checkout -- backend/src backend/tests backend/scripts
```

回滚后必须重跑：`npx tsc --noEmit` → 三个定向测试（`lt2_pluginsRouteBranches` / `renderersLongTail` / `dispatch`）→ `node scripts/check-airplay-playback-chain.mjs`（此时 R19 仍是旧语义，应全绿）。

### 9.2 阶段 0–4（迁移）

按阶段回滚：每个阶段应是一个独立 commit，回滚 = `git revert <该阶段 commit>`。**禁止**跨阶段一起 revert（否则无法判断是哪一阶段的耦合导致回退）。

回滚后必跑：§4.1 的 L1（定向测试）+ L3（37 守卫）+ 受影响拓扑的 L2。

### 9.3 240 热补丁回滚

热补丁前已建 `/root/backup_v<ver>/`，回滚 = 把备份目录的 `dist` / `public` 拷回容器 + `docker restart musicflow`，再等 ~3.5min 沉默期。

---

## 10. 发版时序（前置清理与迁移的关系）

| 顺序 | 内容 | 性质 | 前置条件 |
|---|---|---|---|
| ① v4.15.15（阶段 -1） | 不可停用 + sendspin 默认开启 + 死门面删除 | **唯一改变可观察行为的一版**（API 语义 + 管理页开关效果） | 全量 vitest 绿 → 240 热补丁 → 真机 G1–G8 通过 → push/tag/Release |
| ② 阶段 0–4 | `createPlayer` 工厂化 + 守卫收口 | 纯重构（行为零变更） | ① 已发版并稳定 ≥1 天 |

**为什么必须分开**：迁移的第一铁律是「行为等价」，而 ① 必然改变行为。两件事混在一版，真机一旦出问题无法归因是「迁移改坏了」还是「停用语义引入的副作用」。这也是 §0.2 一票否决项的前提。

---

## 11. 附录（阶段 -1 执行材料）

### 11.1 `SPEC.md` §1.5 替换全文

> 替换整节（现文「AirPlay 可停用 / 默认关闭 / 关闭零常驻」与代码相反）。

```md
### 1.5 渲染器插件开关契约（v4.15.15 校正）

> 历史注记：v1.13.42+ 曾规定「内置插件均可停用」，但 `routes/api/plugins.ts` 的
> `PUT /v1/plugins/:id` 对内置行恒写 `enabled=1`；`PUT /v1/plugins/:id/toggle` 却未做
> 内置判定，于是形成「保存配置掰回 1、点开关真停用」两套语义。v4.15.15 按用户裁决
> 统一为「内置渲染器一律不可停用」。

- **内置渲染器（`airplay-renderer` / `sendspin-renderer` / `dlna-renderer`）一律不可停用**：
  - `PUT /v1/plugins/:id/toggle` 按 `BUILTIN_RENDERER_IDS`（`plugins/builtins.ts`，由
    `BUILTIN_RENDERER_PLUGINS` 派生）判定：对三者**幂等写 `enabled=1`** 并返回
    `{ success: true }`，**不联动任何服务启停**（管理页开关点击后回弹）。
  - `PUT /v1/plugins/:id`（保存配置）对内置行同样恒写 `enabled=1`。
  - 三者**均常驻**：由 `index.ts` 启动门控按 `enabled` 启动；不再承诺「停用后零常驻资源」。
  - manifest `defaultEnabled` 一律 `true`（sendspin 于 v4.15.15 由 `false` 改为 `true`）。
- **core 行为插件仍可停用**：`manifest.type === "core"`（同曲多源组 / 播放优选 / 导入命中门禁）
  的状态开关不受本契约约束；总开关之外的功能子开关仍在插件「配置」弹窗。
- **插件身份保留**：三者继续住在插件契约侧（manifest / 配置 / `/v1/plugins/renderers` 发现接口），
  仅不可停用；播放器工厂由插件提供（见 `docs/renderer-plugin-migration-plan.md`）。
- **停机逻辑保留但不可达**：`stopAirPlayService()` / `stopSendspinService()` 本体保留
  （TEARDOWN / 清 peer / 注销 player / 停 mDNS），仅由进程停机路径使用；`/v1/airplay/*`
  的 409 守卫保留为防御（`enabled` 恒 1 时不可达）。
- **禁止**：未启用状态下任何代码路径调用 discovery / 设备注册（mDNS 仍是唯一设备来源）。
```

### 11.2 `CHANGELOG.md` v4.15.15 建议条目

> 格式铁律：LF、条目间恰 1 空行、`### Change` / `### Fix`，root CHANGELOG 不写日期以外的元信息。

```md
## v4.15.15 (2026-11-27)

### Change
- 内置渲染器（AirPlay / Sendspin / DLNA）改为不可停用：插件开关点击后幂等保持启用，不再联动服务停机；Sendspin 默认改为开启。修复「关闭后改配置又被写回启用、但服务未重启」的状态失配。
- 移除插件层 `castToRenderer` / `controlRenderer` 两个零调用门面（播放入口是 `QueueController` + `ProtocolPlayer`，不经「把 URL 交给设备」路径）。
```

### 11.3 240 热补丁步骤

1. `cd /workspace/MusicFlow/backend && npm run build`（产物 `dist/`）。
2. 打包 `dist` + `public` → 本机中转 → 240 容器 `musicflow`。
3. `docker cp` 前先备份：`/root/backup_v4.15.14/`（保留上一版）。
4. `docker restart musicflow` → 等 ~3.5 min 沉默期。
5. 核验：`curl -s localhost:46400/ping`；`docker logs --since 6m musicflow` 无异常。
6. ⚠️ **`/ping` 的 version 不随热补丁更新**：必须在容器内 `grep` dist 里的新符号（如 `BUILTIN_RENDERER_IDS`）确认生效，否则会误判为「补丁没打上」。

### 11.4 阶段 -1 真机验收（240）

| # | 场景 | 判据 |
|---|---|---|
| G1 | 管理页点 AirPlay 开关 | 请求 200；开关回弹为「启用」；DB `airplay-renderer.enabled` 仍 1；AirPlay 设备列表不变 |
| G2 | 管理页点 Sendspin 开关 | 同上；Sendspin 服务未停（已连客户端不掉线） |
| G3 | 管理页点 DLNA 开关 | 同上；DLNA 设备列表不变 |
| G4 | 关开关后再改该插件配置并保存 | `enabled` 仍 1，且**不再出现「显示已启用、服务实际停着」**的错位 |
| G5 | core 行为插件（同曲多源组 / 播放优选）开关 | **仍可停用**（未被本次改动波及） |
| G6 | 播放回归 | AirPlay 单机 / Sendspin 直连 / 混合组切换、seek、曲末自动切歌与 v4.15.14 一致 |
| G7 | 插件管理页三插件「说明」 | 不再出现 `castToRenderer()` / `controlRenderer()` 字样 |
| G8 | 新装实例 | 三个渲染器开箱全启用（sendspin 不再默认关） |

### 11.5 阶段 -1 验证矩阵

| ID | 项目 | 命令 | 状态 |
|---|---|---|---|
| V1 | 类型检查 | `cd backend && npx tsc --noEmit -p tsconfig.json` | ✅ EXIT=0 |
| V2 | 定向测试 | 三个受影响文件 | ✅ 3 files / 24 tests |
| V3 | 全量守卫 | 循环跑 `scripts/check-*.mjs`（`node`）与 `scripts/check-*.mts`（`npx tsx`）；临时脚本 `run_guards_all.sh` 不入仓 | ✅ total=37 failed=0（2026-11-27 复核） |
| V4 | CRLF 双向 | 每个改动文件 `grep -c $'\r'` | ✅ 全 0 |
| V5 | 全量测试 | `npx vitest run` | ✅ 2026-11-27 复跑 3 轮：2 轮 9129 全绿；1 轮 1 例既有慢用例超时（`tests/rest/opensubsonic.test.ts` 歌词用例，单跑 17.6s / 全量并发 >20s），与本方案无关 |
| V6 | 构建 | `npm run build` | ⬜ |
| V7 | 240 热补丁 | 见 §11.3 | ⬜ |
| V8 | 真机 | 见 §11.4 | ⬜ |

---

## 12. 收尾清单与观察期（成功路径的最后一步）

### 12.1 文档同步矩阵（缺一项都算没完）

| 文档 | 必须反映的内容 | 状态 |
|---|---|---|
| `docs/renderer-plugin-migration-plan.md`（本文） | 全部阶段 `[x]`，§0.0.2 看板全绿，状态行改「已实施」 | ⬜ |
| `SPEC.md` §1.5 | 渲染器不可停用契约（§11.1 文本） | ⬜ |
| `SPEC.md` §五 模块边界 | `services/player` 不再 import 协议实现 | ⬜ |
| `docs/PLUGIN_ARCHITECTURE.md` §1 | 耦合点清单更新为迁移后状态 | ⬜ |
| `docs/PLUGIN_DEV.md` §4.7 | renderer impl 增加「可选 `createPlayer`」，并注明外置 renderer 不可用 | ⬜ |
| `docs/player-unification-plan.md` §2.6 / §7 | 「第三套控制面待收敛」→ 已收敛 | ⬜ |
| `docs/airplay-权威方案文档.md` | 取播放器实例的入口改为插件工厂 | ⬜ |
| `docs/sendspin-权威方案文档.md` | 同上 | ⬜ |
| `docs/group-权威方案文档.md` | 群组泵仍是核心（豁免），但需说明与工厂的关系 | ⬜ |
| `docs/README.md` | 本文件索引描述更新为「完整任务文档（含执行纪律）」 | ⬜ |

### 12.2 代码卫生

- [ ] 删除临时脚本（`patch_*.py`、`run_guards_all.sh` 等）不进仓库
- [ ] 无遗留 `TODO/FIXME` 指向前置版
- [ ] `git grep -n 'castToRenderer\|controlRenderer' backend/src` 只剩注释/文档字符串
- [ ] 新增守卫位于 `backend/scripts`（被 `check-workflow-paths.mjs` 自动扫描，B4）

### 12.3 观察期（发版后 7 天）

| 观察项 | 判据 | 超标动作 |
|---|---|---|
| 服务启动成功率 | 重启 5 次均能进入可播放状态 | 查启动门控与插件注册顺序 |
| 起播/切歌失败日志 | `[ERROR]` 中无新增播放类错误 | 按 §4.8 归因，必要时回滚该阶段 |
| 五拓扑指标（CI 每日跑） | 与 §4.1 L2 判据同区间 | 连续 2 次漂移 → 回滚最近一阶段 |
| 真机主观验收 | AirPlay / Sendspin / DLNA / 混合组各一轮无异常 | 记录到 §4.5 真机矩阵 |

> 观察期结束且全部通过 → 本文状态行改「已实施（vX.Y.Z）」，本任务闭环。

## 附录 C 审核更正记录（2026-11-27）

本次为独立审核（只读核对 230 源码、240 生产库插件表、tsc / 37 守卫 / 3 轮全量 vitest），更正如下：

| 类别 | 更正内容 |
|---|---|
| P0 | 补「归属判定」：门面改 `createRendererPlayer(protocol, deviceId)`；插件 `createPlayer` 双闸门（协议 + 设备表）；新增选择矩阵验收（§2.7a） |
| P1 | M3 原「≤ 8 / ≤ 20」经实测不可达（白名单自身即 8 文件 / 26 条），改为「工厂符号引用 = 0 + 18 个 importer 逐条结论」；B1 改为符号级规则并排除 `plugin/renderers/*`（§4.2、§4.2a） |
| P2 | G2 门槛 9136 → 9129；§3.4 失效引用改「阶段 -1」小节；T11 → -1l；V5 更新为复跑结论；新增 -1o（sendspin/airplay 停用文案残留） |
| P3 | `ProtocolPlayer` 8 个方法；`plugins.ts:83`；dlna `:97` / 142 行、airplay 149 行、sendspin 232 行；耦合 18 文件 / 43 条；75/17/80 标注为测试文件数 |
| 建议 | 新增 §2.7b：目标校准（外置渲染器独立立项）、先归一后搬家、失败语义分级、`renderer resolve` 日志、`MF_RENDERER_FACTORY` 临时回退开关、`cast` dead surface 清理，均标记为「待裁决」 |
| 复跑 | 全量 3 轮：2 轮 9129 全绿；1 轮 `opensubsonic.getLyricsBySongId` 既有慢用例并发超时（单跑 17.6s），与本方案无关 |
| 保留 | 阶段 -1 的 10 项代码结论、`-1e/-1f/-1g` 用例与断言、37 守卫、tsc=0、240 三个渲染器 enabled=1，均复核通过 |

