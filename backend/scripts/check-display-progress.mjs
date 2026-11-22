#!/usr/bin/env node
// ==================== 播放进度：显示口径 / hold / 出声事件 守卫 ====================
//
// 背景（2026-11-21 真机）：切歌后「封面晚 1~3 秒才换」「新曲第一眼就是 02 秒」
// 「上一首没播完就切封面」。三次修复分别落在：
//   v4.11.12  displayHold 按住旧曲           v4.11.20  400ms 观察器 + 显示位置加上界
//   v4.14.30  出声即事件（泵 → IPC → 主进程放开并广播 pos=0）
//
// 这些点的共同体质是**静默退化**：改坏了不崩不报错，只是界面又开始骗人（多 2 秒 /
// 回跳 / 封面提前）。本守卫把「两个位置各自的口径」和「出声事件这条链」钉死。
//
//   D1  pollCore 同时产出判定位置与显示位置（少一个 ⇒ 三端只能二选一）。
//   D2  显示位置是**纯派生**：framePos − depth + lead；禁止 Math.max(历史值) 之类
//       伪造单调（会把 seek 往回拖卡死）。
//   D3  物理上界「内容起点 + 已流逝墙钟 × 倍速」在推送与排空两条路径都生效。
//   D4  lead 按曲粘住（桥组 2.05s），收尾不回落。
//   D5  seek 显式复位显示位置（回退的唯一合法来源之一）。
//   D6  出声上报值必须是 floorMs（新曲=0、seek=目标），不能是 positionMs/displayPositionMs。
//   D7  事件三跳齐备：泵 → childMain → ipc → supervisor。
//   D8  主进程收到后放开 hold 并按精确值广播。
//   D9  组名三种形态归一化（group:/ug:/裸 id），否则找不到持有者。
//   D10 状态推送补在轮询回路里，且带 `state` 字符串（ws 消费方直接读）。
//   D11 hold 硬顶与 400ms 观察器仍在。
//   D12 audible-started 放开路径**不**补采样（补采样会把精确 0 覆盖成 1~2s）。
//   D13 持有期间对外出口用 hold 的旧曲（displayHoldState / snapshot.index）。
//
// 零依赖 node 脚本，挂 ci.yml 守卫 job。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => stripComments(readFileSync(join(root, rel), "utf8"));

const ENGINE = "backend/src/services/sendspin/streamEngine.ts";
const CORE = "backend/src/services/sendspin/playerCore.ts";
const SIDX = "backend/src/services/sendspin/index.ts";
const CHILD = "backend/src/services/sendspin/childMain.ts";
const IPC = "backend/src/services/sendspin/ipcProtocol.ts";
const SUP = "backend/src/services/sendspin/supervisor.ts";
const QC = "backend/src/services/player/QueueController.ts";

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) console.log("  ✓ " + name);
  else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}
const count = (s, needle) => s.split(needle).length - 1;

const se = read(ENGINE);
const core = read(CORE);
const sidx = read(SIDX);
const child = read(CHILD);
const ipc = read(IPC);
const sup = read(SUP);
const qc = read(QC);

console.log("===== D1/D2 两个位置各自的口径 =====");
check(
  "pollCore 同时产出 positionMs 与 displayPositionMs（+ buffering）",
  core.includes("displayPositionMs: number; durationMs: number; buffering: boolean }"),
  "少 displayPositionMs ⇒ 各端只能拿判定值显示（新曲会带 1~2s）",
);
check(
  "显示位置 = 已推送 − 缓冲深度 + 粘住的 lead（纯派生）",
  se.includes("const raw = framePosMs - depthMs + leadBack;"),
  "改成取历史最大值会让 seek 往回拖卡死",
);
check(
  "禁止用 Math.max 伪造显示单调",
  !se.includes("displayPositionMs = Math.max(") && !se.includes("displayPositionMs = Math.max ("),
  "「只升不降」补丁会让 seek 回拖永久失效",
);

console.log("===== D3 物理上界（内容起点 + 流逝墙钟 × 倍速）=====");
check(
  "上界函数在推送与排空两条路径各调一次（含定义共 3 处）",
  count(se, "capDisplayByElapsed(") === 3,
  "漏一处 ⇒ 该路径新曲又从 01~02 秒起算",
);

console.log("===== D4/D5 lead 粘曲与 seek 复位 =====");
check(
  "桥组 lead 按曲粘住（只升不降，收尾不回落）",
  se.includes(
    "if (this.group.hasBridges?.() === true) this.group.displayLeadMs = AUDIBLE_DEVICE_LEAD_MS;",
  ),
  "跟着 hasBridges 翻 0 ⇒ 曲末显示位置当场掉 2.05s",
);
check(
  "seek 显式复位显示位置（回退的合法来源之一）",
  se.includes("this.group.displayPositionMs = 0;"),
  "不复位 ⇒ seek 后显示还停在旧位置（或被上界误钳）",
);

console.log("===== D6 出声上报值必须是 floorMs =====");
check(
  "sink 上报 Math.max(0, floorMs)（新曲=0 / seek=目标）",
  se.includes("audibleStartSink?.(this.group.name, this.songId, Math.max(0, floorMs), this.durationMs);"),
  "改传 positionMs/displayPositionMs ⇒ 接续切歌时带 1~2s，界面第一眼就是 02 秒",
);

console.log("===== D7 事件三跳齐备 =====");
check("泵侧 sink 已装填（childMain setAudibleStartSink）", child.includes("setAudibleStartSink("));
check("IPC 协议声明 audibleStarted 事件", ipc.includes('| { t: "audibleStarted";'));
check("supervisor 分发 case 存在", sup.includes('case "audibleStarted":'));

console.log("===== D8/D9 主进程处理与组名归一化 =====");
check(
  "收到事件即放开 hold 并广播精确起播值",
  sidx.includes('qc.releaseDisplayHold(bareId, "audible-started");') &&
    sidx.includes("qc.broadcastState(bareId, {"),
  "缺任一步 ⇒ 退回 400ms 观察器（实测又慢 1~2s）",
);
check(
  "组名剥到裸 id（group: / ug: / 裸 id 三种形态）",
  sidx.includes('clientId.replace(/^(?:ug|group):/, "")'),
  "不剥干净 ⇒ clearDisplayHold 找不到持有者，静默失效",
);

console.log("===== D10/D11 推送节奏与 hold 生命周期 =====");
check(
  "每轮轮询采样后补发一次状态（sendspin 组本身不发 state_changed）",
  qc.includes("this.broadcastState(deviceId, state);"),
  "不补发 ⇒ App 2s / HA 30s 轮询，切歌第一眼永远错过 00:00",
);
check(
  "broadcastState 补 `state` 字符串字段（ws 消费方按它判断）",
  qc.includes("state: state.playbackState ?? state.state,"),
  "只发 playbackState ⇒ 老消费方读不到 state",
);
check(
  "hold 硬顶 = 可听尾 + 20s",
  qc.includes("releaseAt: until + 20000,"),
  "硬顶过小 ⇒ 新曲没出声就放开封面（用户报「上一首没播完就切」）",
);
check(
  "400ms 轻量观察器仍在（只做放开判定，不进 handleDecision）",
  qc.includes("}, 400);") && qc.includes("maybeReleaseDisplayHold"),
  "观察器被并进主轮询 ⇒ 重新引入「poll 侧造触发器」的链式跳歌",
);

console.log("===== D12 audible-started 不补采样 =====");
check(
  "放开路径跳过补采样（避免用 1~2s 的轮询读数覆盖精确值）",
  qc.includes('if (reason !== "audible-started") {'),
  "补采样 ⇒ 刚广播的 pos=0 立刻被覆盖成 1~2s",
);

console.log("===== D13 持有期间的对外出口 =====");
check(
  "持有期间 snapshot/状态出口用旧曲",
  qc.includes("displayHoldState(playerId: string)") &&
    qc.includes("currentIndex: hold ? hold.index :"),
  "不用 hold 的 index ⇒ 队列内部已换曲，界面先切封面",
);
check(
  "倍速折算墙钟持有（remain/speed）",
  qc.includes("const wallRemainMs = (Math.max(0, remainSec) * 1000) / (speed > 0 ? speed : 1);"),
  "不折算 ⇒ 2x 下声音先走、进度条还在旧曲爬",
);

console.log("");
if (failures.length > 0) {
  console.log(`[显示进度守卫] FAIL:${failures.length} 项(通过 ${checks - failures.length} 项)`);
  for (const f of failures) console.log("  · " + f);
  process.exit(1);
}
console.log(`[显示进度守卫] ${checks} 条断言全部通过`);
