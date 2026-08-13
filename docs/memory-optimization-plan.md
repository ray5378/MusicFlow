# 内存优化与回收方案

> 依据：2026-08-13 对主项目前后端的三轮内存分析（初查 → 二次确认 → 源码级终核）。
> 范围：仅内存治理，不涉及任何 API/功能变更。

---

## 一、最终结论（三次分析收敛）

| 项 | 结论 | 处置 |
|---|---|---|
| 后端各缓存（coverCache / coverImage / lyrics / peer / WS / DLNA GENA / 队列 / 在线流） | 治理到位：均有硬预算 + LRU / TTL / 静默清空，清理代码实测存在（真实 `delete`/`clear`） | 无需改动 |
| 后端 `scanJobs` / `scrapeJobs` | key 覆盖 / 常量单 key，天然有界 | 无需改动 |
| **前端 `RemoteState` 泄漏** | 确认真实存在：`peer_unavailable` 不回收状态与定时器 | **必做（高性价比）** |
| 后端 `matchJobs` | 唯一慢增长点：大歌单匹配唯一 key 完成后不删 | 可选（低优先） |
| `SongTable` 无虚拟滚动 | 扩展性问题（大库 DOM 多），非泄漏 | 可选（看库规模） |

---

## 二、必做项：前端 RemoteState 离线回收

### 2.1 源码定位（`frontend/src/stores/player.ts`）

| 符号 | 行号 | 说明 |
|---|---|---|
| `RemoteState` 接口 | 129-136 | 含 `pollTimer`(2s) / `tickTimer`(250ms) |
| `ensureRemoteState` | 143-175 | 不存在自动创建，存在则复用 |
| `removeRemoteState` | 176-181 | **唯一**清理点：`clearInterval`×2 + `Map.delete` |
| `startCastPoll` | 607-654 | 开头 `stopCastPoll`(608)，复用不叠加定时器 |
| `castClearQueue` | 587-595 | 既有清理模式：`stopCastPoll` → `removeRemoteState` → 活动 peer 回退本机 |
| **`peer_unavailable` 分支** | **1010-1022** | **泄漏点**：只移列表 + 切 `currentPeerId`，不回收 |

### 2.2 泄漏机制

投屏 / 切换设备时 `ensureRemoteState` 创建状态并启动两个轮询定时器。设备离线后 WS 推 `peer_unavailable`，该分支仅执行：
1. `peers.value = peers.value.filter(...)` 移除列表项；
2. 若为当前设备，`switchPeer` 切到下一可用或回本机。

**没有调用 `removeRemoteState`** → 该设备的状态对象（queue/lyrics 数组）与两个 `setInterval` 永久残留，每 2s 仍请求一台已离线设备的 `/status`（错误被 `catch{}` 吞掉）。

- 累积模型：随「历史上投屏过且离线过的设备数」**线性残留、永不回收**（再次投屏同设备复用条目、不叠加；但离线后不再投屏则一直占着）。
- 影响：内存慢增长 + 定时器空转占 event loop。影响温和，但确凿存在。

### 2.3 修复设计

在 `peer_unavailable` 分支末尾**无条件** `removeRemoteState(p.peerId)`（与 `castClearQueue` 同款清理）：

```ts
case "peer_unavailable": {
  const p = msg.peer;
  if (!p || p.kind === "local") break; // 本机恒在列表
  // 离线设备从列表移除(不再置灰显示)。
  peers.value = peers.value.filter(x => x.peerId !== p.peerId);
  // 当前播放设备离线 → 自动切换到下一个可用设备;无可用则回本机。
  if (currentPeerId.value === p.peerId) {
    const next = peers.value.find(x => x.available && x.peerId !== localPeerId.value);
    if (next) void switchPeer(next.peerId).catch(() => {});
    else currentPeerId.value = localPeerId.value;
  }
  // 回收离线设备残留的 RemoteState(pollTimer 2s + tickTimer 250ms),
  // 与 castClearQueue/stopCast 同款清理。设备重新上线/再次投屏时
  // ensureRemoteState 自动重建,无需保留。
  removeRemoteState(p.peerId);
  break;
}
```

### 2.4 边界分析（为何无条件删除是安全的）

| 场景 | 行为 | 安全性 |
|---|---|---|
| 当前设备离线 | 先切 `currentPeerId`（`switchPeer` 异步，末尾同步赋值，但可能被内部 `await` 延迟）→ 再删 | 安全：删除的是离线设备自己的 state，与切换目标无关；切换目标若无 state 会 `ensureRemoteState` 新建 |
| 非当前设备离线 | 直接删 | 安全：该 state 无人引用 |
| `switchPeer` 尚未完成赋值时 UI 短暂读到空 `activeRemote` | 设备已从列表移除，UI 本就该显示无此设备 | 可接受 |
| 设备重新上线（`peer_available`） | 回到列表，再次投屏时 `ensureRemoteState` 自动重建 | 自愈，无副作用 |
| group 群组离线 | 同样走此分支，`removeRemoteState` 对 `group:` 前缀同样有效 | 安全 |
| 影响 `castActive` computed？ | 遍历 `remoteStates`，删除后若仅此一台则变 false | 合理：设备离线本不该显示「正在投屏」 |

改动量：**+2 行注释 +1 行调用**，零功能影响。

---

## 三、可选项 A：后端 matchJobs 过期清理

### 3.1 源码定位（`backend/src/routes/api/online.ts`）

- 26：`matchJobs = new Map<...>()`
- 102：大歌单（>30 首）匹配生成唯一 key `match-<ts>-<rand>`
- 110/112：完成/失败后仅 `matchJobs.set(...)`，**永不 `delete`**

触发条件：仅手动对 >30 首未匹配曲目的歌单发起匹配，频次低，result 为小摘要 → 慢增长但影响极小。

### 3.2 方案（参照 `lyrics.ts` 的 `lrcCacheSweep` 模式）

```ts
const JOB_TTL_MS = 30 * 60 * 1000; // 完成/失败后保留 30 min 供前端取结果
const matchJobsSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of matchJobs) {
    if (!v.finishedAt) continue; // running 中的 job 不清理
    if (now - Date.parse(v.finishedAt) >= JOB_TTL_MS) matchJobs.delete(k);
  }
}, 5 * 60 * 1000);
(matchJobsSweep as any).unref?.();
```

改动量：约 10 行，仅 `online.ts`。

---

## 四、可选项 B：SongTable 虚拟滚动

### 4.1 现状

`frontend/src/components/SongTable.vue` 对歌曲列表全量 `v-for` 渲染 DOM（每行含封面 `el-image`、按钮、图标），无虚拟化。单张专辑/歌单（几百行）无压力；「全部歌曲」或超大型库（万首级）时 DOM 节点数随库规模线性增长，首屏与滚动流畅度受压（封面已用 lazy 缓解，但节点不回收）。

### 4.2 方案概述

- 引入 `vue-virtual-scroller`（推荐，成熟）或 Element Plus 表格虚拟化 / 自实现 windowing；
- 仅渲染可视区 ± 缓冲行，滚动时回收不可见行；
- 需保持现有行交互（封面懒加载、行内按钮、右键菜单）不回归。

### 4.3 决策

- 工作量：中量（组件接入 + 交互回归测试）；
- 建议：库规模未到万首级前**暂缓**，需要时再做；
- 若做，建议独立提交、独立验证，不与其他改动混入。

---

## 五、验证与发布计划

### 5.1 必做项本地验证

1. `frontend: npx vue-tsc --noEmit` 0 错；
2. `node backend/scripts/check-frontend-plugins.mjs` 插件隔离守卫通过；
3. 手动冒烟（dev 环境）：
   - 投屏 A 设备 → 播放 → 关闭设备电源（离线）→ 观察控制台无对 A 的轮询请求；
   - 重新开机 → A 回到设备列表 → 再次投屏正常（state 自动重建）；
   - 多设备场景：投屏 A/B 后 A 离线 → B 状态不受影响。

### 5.2 可选项 A 验证

- `backend: npx tsc --noEmit`；
- `npx vitest run` 全绿（可补一个 matchJobs 清理单测）。

### 5.3 发布

- 走常规流程：bump → tag → push → CI 镜像 → Release；
- 建议：必做项单独发版（纯前端、无 API 变化）；可选项 A 可同版或下版；
- hassio-addons 按既有约定不自动同步（除非明确指示）。

---

## 六、执行建议

1. **本期只做必做项**（`peer_unavailable` 补 `removeRemoteState`，约 1 行 + 注释）→ 本地验证 → 发版；
2. 可选项 A（`matchJobs` TTL 清理，约 10 行）可顺手带上，风险极低；
3. 可选项 B（虚拟滚动）按库规模另行决定。
