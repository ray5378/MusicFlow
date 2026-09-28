# 已知问题台账（KNOWN ISSUES）

登记**工程/运行时**类缺陷（测试基础设施、进程存活、资源泄漏、并发正确性），
并追踪其状态。**UI/UX 类缺陷不在本台账**，见仓库根的 `AUDIT.md`。

每条目格式：`ID / 状态 / 现象 / 复现率 / 影响 / 根因 / 修复 / 验证`。

---

## MF-001 并发调用触发沙箱 OOM 自愈时，QuickJS teardown 断言 abort（SIGABRT）

- **状态**：已修复（2026-09-28，v4.0.49）
- **现象**：日志出现
  `Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c:2036, JS_FreeRuntime)`。
  这是 WASM 层 SIGABRT，宿主 `try/catch` **抓不住**，会直接杀死整个进程
  （测试场景下即整个 vitest worker 陪葬，表现为「全量回归拿不到汇总行」）。
- **复现率**：**必现（5/5）**。触发条件精确：**并发**两个调用同时/相继触顶内存上限。
  单发 OOM 的自愈（既有 3 条 SANDBOX_MEMORY 用例）从不触发。
- **影响**：① 生产 —— 并发调用一个泄漏插件时，插件沙箱的自愈路径会把宿主进程一起带走，
  这是**进程级**故障而非单次调用失败；② 测试 —— 一次性崩掉整轮全量回归。
  注：插件沙箱本身跑在 worker thread 中（见 `docs/PLUGIN_ARCHITECTURE.md`），
  生产上的实际降级表现为 worker 崩溃，具体是否波及主进程待线上观察确认。
- **根因链**（插桩实测，四层）：
  1. `dispose()`（`src/plugins/sandbox.ts`）是**同步**函数；而 `evalAsync` 里的
     `promiseHandle` 是在其 `finally`（**异步**）中释放的。
  2. 单发 OOM 时，触发的那条调用已经 return、`promiseHandle` 已释放，dispose 干净；
     并发时**另一条仍在途**，它的 GC 对象还被钉着。
  3. `rebuild()` 直接调用同步的 `dispose()`，不给在途 `finally` 留任何让出窗口。
  4. `hasPendingJob()` 此时已是 `false`（pending job 早已排空）——
     **残留的不是 job**，而是被在途句柄/栈帧钉住的 GC 对象，所以排空救不了。
  > 历史对照：v4.0.3 曾修复过「被 interrupt 打断的 async continuation 残留钉住
  > `gc_obj_list`」的问题（在 `oomCleanup` 里排空 pending jobs）。本次是**同一族问题的
  > 第二层根因**：那次治的是「job 未排空」，这次是「job 排空了但对象仍被在途
  > `promiseHandle` 钉着」——排空本身不是充分条件。
- **修复**（`src/plugins/sandbox.ts`，三处加固）：
  1. `rebuild()` 的 `dispose()` 之前 `await this.settleHandlers()`（8 个 `setImmediate`），
     给所有在途 `evalAsync` 的 `finally` 留出释放时间。**这是真正消除 abort 的那一条。**
  2. `dispose()` 里 `oomCleanup` 去掉 `oomFaulty` 守卫，改为对任何有 runtime 的 dispose
     无条件先排空（终态销毁，代价可接受）。
  3. `evalAsync` 泵循环在沙箱进入 `rebuilding`/`disposed` 时立刻退出，
     让在途调用尽快放手、错误交给上层重试。
  > 注：中间两版（`oomFaulty` 消费式清零、按 `activeCalls` 计数等待）**实测均无效**
  > ——因为 rebuild 触发时发起方那条调用自己早已结算并注销了 `activeCalls` 条目，
  > 该等的是「有多少 `evalAsync` 的 `finally` 还没跑完」，不是「`activeCalls` 是否为空」。
- **验证**：
  - `tests/plugins/sandbox.test.ts` 新增用例「并发 OOM 自愈:SIGABRT 防线」；
    修复前该用例转红并 abort，修复后转绿（**双向证伪通过**）。
  - 修复前探针跑 5 轮 5 次 abort，修复后 5 轮 0 abort；
    基线模式（单发 OOM、反复 OOM、重复 dispose）均无退化。
  - `sandbox.test.ts` 28/28 绿，`tsc --noEmit` 干净。
- **遗留观察**：`ticks = 8` 是经验值，不是推导值。8 拍对当前用例足够，
  但在**极端慢速 CI** 机器上若某个 `finally` 被明显拖后，理论上仍可能 abort。
  若日后线上出现同类 abort，优先调大该值，而不是回到「排空 pending jobs」的老思路。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-28 | 建立本台账，登记 MF-001 |
