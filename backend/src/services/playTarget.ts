// ==================== 播放目标「可播」判据(单一真相源) ====================
//
// 定稿(2026-09-25):**目标没有在线播放器,就不开始播放** —— 这是播放侧的硬限制,
// 判据统一由本模块给出。之所以要单独收口,是因为对下面两类目标而言,
// 「peer 行可用」与「真能出声」是**两件事**:
//
//   - **群组**:组是「容器不是设备」,组行 `available` **恒 true**
//     (2026-09-23 定稿「组恒在线」,见 peer.ts reconcileGroupPeers 与
//     tests/services/groupPeerAvailability.test.ts 的 7 例守卫)。
//     所以 `available` 根本不能用来判断能不能播;真判据是**组内有没有在线成员**
//     (`hasOnlineMember`,跨 kind:dlna 实时可达 or sendspin front ready 任一 ——
//     与 group/protocolPlayer.playMedia 的裁决、group/watchdog 的悬挂判定同源同口径)。
//   - **AirPlay**:设备档案是**持久化**的,设备离线也仍留在列表里(可重命名/禁用),
//     所以「档案存在」≠「能出声」。真判据是 discovery 的 `available`
//     (90s 无 mDNS 刷新即置 false,读取时惰性过期 —— 见 discovery.ts 的 STALENESS_MS)。
//
// **不收口** dlna / sendspin / local:前者的 `isDeviceAvailable` 对未知设备乐观返回
// true、后者的 peer 只在连接就绪时才注册 —— 各自已有语义,不在这里重复判断。
//
// 消费方(两处,都只消费、不自行解析成员/设备状态):
//   1. `QueueController.playCurrent`:起播前查一次,cast 失败后再查一次(后者兜
//      「起播判据过关、cast 期间成员掉光」的竞态)。判为不可播 ⇒ **不起播、不推进队列、
//      不计 cast 失败**:队列保持 isActive 悬挂,等 group watchdog 的 resumeActive /
//      设备回归自然恢复。
//   2. `flows`(音流等待阶段):不可播的目标判为「未上线」⇒ 继续等待并持续催发现。
//
// 🔴 为什么必须拦在播放层:一旦让「不可播」落到 QueueController 的 cast 失败分支,
//    `castFailStreak++` 会累加到 `max(2, 2×曲数)` 并把每一拍交给
//    `handleDecision("stalled")` → 放行切歌 → **边失败边切歌**。
//    2026-09-25 真机实测:组零在线成员 + 大歌单,6 分钟空转 787 次
//    `无在线成员,无法播放`,idx 从 293 一路被推到 49(视感 = 疯狂切歌)。
import { getGroupManager } from "./group/index.js";
import { hasOnlineMember } from "./group/protocolPlayer.js";
import { getAirPlayDevice } from "./airplay/discovery.js";

export interface PlayTargetCheck {
  playable: boolean;
  /** 不可播的原因(可直接进日志);可播时为 undefined。 */
  reason?: string;
}

/** 判断一个播放目标此刻能否出声。
 *
 *  `idOrPeerId` 两种形态都收:
 *   - 带命名空间前缀(`group:<gid>` / `airplay:<id>`)—— 音流等按 peerId 工作的调用方;
 *   - **裸 id** —— QueueController 全程用裸 id 作 key(见其 stripPlayerPrefix 注释)。
 *  裸 id 靠「这个 id 是不是某个已知群组 / 已知 AirPlay 设备」反推类别;
 *  两者都不是即视为 dlna/sendspin/local,乐观放行。 */
export function checkPlayTarget(idOrPeerId: string): PlayTargetCheck {
  const bare = stripKindPrefix(idOrPeerId);
  try {
    // 群组优先:组 id 是 UUID,与 AirPlay 设备 id(MAC 派生)不可能相撞。
    if (getGroupManager().get(bare)) {
      return hasOnlineMember(bare)
        ? { playable: true }
        : { playable: false, reason: "组内没有在线成员" };
    }
    const ap = getAirPlayDevice(bare);
    if (ap) {
      return ap.available
        ? { playable: true }
        : { playable: false, reason: `AirPlay 设备「${(ap.alias || ap.name || bare).trim()}」不在线` };
    }
  } catch {
    // 判据本身异常时**放行**:宁可照旧尝试投递(投不出去还有既有失败分支) ,
    // 也不想因为一次判据读取失败把播放整条卡死。
  }
  return { playable: true };
}

/** 剥掉 `group:` / `airplay:` 前缀;其它形态原样返回。 */
function stripKindPrefix(v: string): string {
  if (v.startsWith("group:")) return v.slice(6);
  if (v.startsWith("airplay:")) return v.slice(8);
  return v;
}
