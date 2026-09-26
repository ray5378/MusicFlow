// ==================== Sendspin 播放核心(跟随真实 server 进程运行) ====================
//
// protocolPlayer(in-proc 模式)与 child 子进程(childMain)共用的推流操作核心。
// 全部函数只操作 SendspinServer/SendspinGroup 内存对象,不 import QueueController /
// PlayerController / dlna control —— 那些是主进程侧的状态,由调用方(protocolPlayer
// 或 IPC 桥)负责,保证「核心逻辑跟着真实 server 走,主进程状态留在主进程」。
//
// 从 protocolPlayer.ts / dlna/announce.ts 原样抽取(行为逐行对齐,勿改时序):
//  - playCore  : group 收尾 → 置新曲元数据 → 入组宣告 → 后台起 pump(失败清理+回调)
//  - announceCore: TTS 拉取解码 → 按组时间线逐帧推 → flush 尾帧 → 音量/成员还原
import type { QueueItem } from "../player/types.js";
import type { SendspinServer, SendspinConnection, SendspinGroup } from "./server.js";
import { pumpFor, peekPump, transferPumpTo, stopGroupPump } from "./streamEngine.js";
import { FIRST_FRAME_LEAD_US, FRAME_MS } from "./streamEngine.js";
import { nowUs } from "./clock.js";
import { SAMPLE_RATE, CHANNELS, decodeToF32 } from "./encoding.js";
import { saveDeviceVolumeState } from "./deviceState.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Sendspin");

/** 服务未运行时的内存假组(供未连接时的幂等控制;原 protocolPlayer ephemeralMap)。 */
export interface SendspinGroupLike {
  positionMs: number;
  volume: number;
  muted: boolean;
  current: { songId: string; title?: string; artist?: string; durationMs: number } | null;
}
const ephemeralMap = new Map<string, SendspinGroupLike>();
export function ephemeralGroup(clientId: string): SendspinGroupLike {
  let g = ephemeralMap.get(clientId);
  if (!g) {
    g = { positionMs: 0, volume: 100, muted: false, current: null };
    ephemeralMap.set(clientId, g);
  }
  return g;
}

/** pump.play 失败回调(in-proc=打日志;child=IPC 通知主进程)。 */
export type PlayFailedSink = (clientId: string, songId: string, message: string) => void;

/** 用户组 → sendspin 组名映射:与单设备组(clientId 裸名)互不碰撞。
 *  路由层/组 player/测试统一走这里,不要手拼前缀。 */
export function sendspinGroupName(userGroupId: string): string {
  return `ug:${userGroupId}`;
}

/** peerId → sendspin 组名(sendspin 设备 = 裸 clientId;用户组 = `ug:<groupId>`)。
 *  非 sendspin 系(本机 / DLNA / AirPlay)返回 null。
 *
 *  ⚠️ 返回 null **不等于**「那个端不能复用服务端的解码结果」—— 它能,而且一直都在复用:
 *  解码 + 响度归一(+ per-peer DSP)这一段是**端无关**的,服务端本来就握在手里。
 *  null 只说明那端在服务端侧**没有可移交的推送泵**(GroupPump)——DLNA / 客户端走 HTTP
 *  **拉**流,出流会话绑死在各自 socket 上;要让它们复用同一段 PCM,需要的是
 *  「多消费者共享 PCM 窗口」(见 `services/audio/buffer.ts` 已备好的骨架 + AudioBuffer
 *  的两段式管道),那是**另一套机制**,不是本文件的泵移交。别把这两件事混为一谈。 */
export function sendspinGroupNameForPeer(peerId: string): string | null {
  if (peerId.startsWith("sendspin:")) return peerId.slice("sendspin:".length);
  if (peerId.startsWith("group:")) return sendspinGroupName(peerId.slice("group:".length));
  return null;
}

// ==================== 借流(泵移交):流转时复用源端已解码的流 ====================
//
// 用户在流转播放里要的是"目标端出声的位置与流转前秒级对齐,而且是**立刻**出声"。
// sendspin 天然满足这个前提:音频是服务端**推**出去的,泵持有已解码窗口 + 时间线,
// 全部归服务端所有 —— 于是"把这条流交给另一个组"只是换个下发目标(见 GroupPump.rehost)。
//
// 与「共享解码窗口」方案的区别(重要):那条路要给窗口加多消费者读指针、引用计数、
// 按最慢者淘汰;而同一时刻只有一个组在播,移交根本不需要这些 —— 零额外 PCM 内存、
// 不多起进程。下一首由目标组自己的泵起播(`play()` 里 `groupDspFilters()` 按**新组**
// 重算),自然回到该设备独立的 DSP 链路,这正是用户要的语义。

/** 借流**规格**:移交所需的最小信息。key = **目标组名**(与 srv.groups 同一命名空间)。
 *  ⚠️ 刻意**不含**登记时刻 —— 时间戳是 TTL 的记账,不是移交语义的一部分,不该出现在
 *  `handoverCore` 这类"拿着规格干活"的签名里(曾因此让类型上说不过去)。 */
export interface BorrowSpec {
  fromGroup: string;
  /** 移交时的落点(ms):源端此刻的**可听位置**(不是已推送位置)。 */
  positionMs: number;
  /** 武装时源端正在播的歌。起播时歌不同即自动放弃(见 handoverCore)。 */
  songId: string;
}

/** 武装结果(对外形状)。字段平铺是**故意的**:它同时是 fork RPC 的载荷
 *  (`sendspinSupervisor.rpc("armBorrow", …)`),嵌一层对象只是白增序列化面。 */
export interface BorrowArmed {
  armed: boolean;
  positionMs?: number;
  songId?: string;
  reason?: string;
}

/** 登记项 = 规格 ＋ 登记时刻。`at` 只活在本模块内。 */
interface BorrowEntry {
  spec: BorrowSpec;
  at: number;
}

const armedBorrows = new Map<string, BorrowEntry>();

/** 登记有效期。武装 → 起播是同步推进的(路由里紧挨着的两步),超时即视为陈旧 ——
 *  否则一次失败的武装会污染很久以后的一次同目标起播。 */
const BORROW_TTL_MS = 15_000;

/** 武装一次「借流」:目标组下一次起播若正好要放源端**正在播的同一首**,就把源端
 *  那条流整体移交过去(见 handoverCore)。
 *
 *  返回 `armed=false` 时调用方走既有链路(起播 → 读进度 → seek),行为与改动前一致。
 *  位置读数取**可听位置**而非已推送位置:目标端要从"用户正听到的地方"接上。
 *
 *  纯判定,不动任何状态(除登记本身)—— 故可以放心在路由里先探后起播。 */
export function armBorrowCore(
  srv: SendspinServer | null,
  targetGroup: string,
  sourceGroup: string,
  overrideMs?: number | null,
): BorrowArmed {
  if (!srv) return { armed: false, reason: "no-server" };
  // ⚠️ 一律 groups.get 而**不**用 srv.group():后者会凭空建一个空组。
  const gTo = srv.groups.get(targetGroup);
  const gFrom = srv.groups.get(sourceGroup);
  if (!gTo) return { armed: false, reason: "target-group-absent" };
  if (!gFrom || gFrom === gTo) return { armed: false, reason: "source-group-absent" };
  const p = peekPump(gFrom);
  if (!p || !p.active) return { armed: false, reason: "source-not-playing" };
  if (p.busy) return { armed: false, reason: "source-starting" };
  const songId = p.playingSongId;
  if (!songId) return { armed: false, reason: "source-no-song" };
  const pos = typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs >= 0
    ? overrideMs
    : gFrom.positionMs;
  armedBorrows.set(targetGroup, {
    spec: { fromGroup: sourceGroup, positionMs: pos, songId },
    at: Date.now(),
  });
  return { armed: true, positionMs: pos, songId };
}

/** 消费登记(一次性;陈旧即作废)。返回**规格**(不含时刻)。 */
function takeBorrow(groupName: string): BorrowSpec | null {
  const e = armedBorrows.get(groupName);
  if (!e) return null;
  armedBorrows.delete(groupName);
  if (Date.now() - e.at > BORROW_TTL_MS) return null;
  return e.spec;
}

/** 起播时是否该走借流(供 playCore/playGroupCore 共用;不成立返回 null 即静默回退)。 */
function borrowFor(group: SendspinGroup, item: QueueItem): BorrowSpec | null {
  const spec = takeBorrow(group.name);
  if (!spec) return null;
  if (spec.songId !== item.songId) {
    log.info(
      `[Sendspin][handover] ${group.name} ← ${spec.fromGroup} 借流放弃 song-mismatch` +
        `(源端=${spec.songId} 本次=${item.songId}),走完整起播`,
    );
    return null;
  }
  return spec;
}

export interface HandoverResult {
  ok: boolean;
  positionMs?: number;
  reason?: string;
}

/** ★ 借流核心:把源端正在播的那条流整体交给目标组。成功即返回(调用方不得再起播)。
 *
 *  顺序上有一处不能调换:必须**先**把目标成员挂进新组并排好延迟宣告,**再**搬泵 ——
 *  pushFrame 一旦指向新组就要能立刻兑现 stream/start(协议要求宣告先于音频,见
 *  SendspinGroup.flushAnnounceFor),否则新组第一帧音频会被设备当"无流数据"丢弃,
 *  表现为目标端开口就少一小段。
 *
 *  失败一律返回 ok=false 且不改变现场(调用方回退完整起播,行为与改动前一致)。 */
export function handoverCore(
  srv: SendspinServer | null,
  spec: BorrowSpec,
  targetGroup: string,
  item: QueueItem,
  conns: SendspinConnection[],
): HandoverResult {
  if (!srv) return { ok: false, reason: "no-server" };
  const gTo = srv.groups.get(targetGroup);
  const gFrom = srv.groups.get(spec.fromGroup);
  if (!gTo) return { ok: false, reason: "target-group-absent" };
  if (!gFrom || gFrom === gTo) return { ok: false, reason: "source-group-absent" };
  const p = peekPump(gFrom);
  if (!p || !p.active) return { ok: false, reason: "source-not-playing" };
  if (p.playingSongId !== item.songId) return { ok: false, reason: "song-mismatch" };
  if (p.busy) return { ok: false, reason: "source-starting" };

  // ① 目标组旧现场清干净:它可能正放着别的(新旧两泵并存 = 双流),旧编码器(含 flac
  //    的 ffmpeg 子进程)也必须杀,否则孤儿进程。与 playCore 的收尾段逐条对齐。
  stopGroupPump(gTo);
  gTo.current = null;
  gTo.finishPlayback();
  gTo.close();
  // ② 目标组就位(先成员 + 宣告,后搬泵 —— 见上文顺序说明)。
  for (const c of conns) {
    try { c.group = gTo; gTo.add(c); } catch { /* 单成员挂载失败不挡其余 */ }
  }
  gTo.current = {
    songId: item.songId,
    title: item.title,
    artist: item.artist,
    album: item.album,
    coverArt: item.coverArt,
    mime: item.mime,
    durationMs: (item.duration ?? 0) * 1000,
  };
  for (const c of gTo.members) {
    try { c.sendGroupUpdate(); gTo.pendingAnnounces.push(c); } catch { /* ignore */ }
  }
  // ③ 搬泵(落点由 rehost 决定并回传;移交自带落点,**调用方不得再 seek**)。
  const at = transferPumpTo(gFrom, gTo, spec.positionMs);
  if (at === null) return { ok: false, reason: "transfer-failed" };
  // ④ 源端到此为止:流的归属已经交出去了,不留半截状态(与 stopCore 同语义)。
  gFrom.current = null;
  gFrom.finishPlayback();
  gFrom.close();
  log.info(
    `[Sendspin][handover] 借流成功 ${gFrom.name} → ${gTo.name} song=${item.songId} ` +
      `pos=${at}ms(源端零重建:不启 ffmpeg、不 seek、不预缓冲)`,
  );
  return { ok: true, positionMs: at };
}

/** 起播核心:对应原 ProtocolPlayer.playMedia 的「推流侧」段落。同步段执行完即返回,
 *  解码/推流在 pump 内异步进行;失败经 onPlayFailed 上抛(不 throw —— 与原行为一致,
 *  playMedia 不因解码失败阻塞 QC,清理由核心内完成)。 */
export function playCore(
  srv: SendspinServer | null,
  clientId: string,
  item: QueueItem,
  onPlayFailed: PlayFailedSink = () => {},
  /** MA `play_index(seek_position=N)` 等价通道:新流从该位置起(音源 -ss)。
   *  必须在 pump.stop() 之后装填(stop 清 pendingSeekMs 属"旧上下文丢弃"语义)。 */
  seekPositionMs?: number,
): void {
  if (!srv) return; // 无 server 时无推流可言(原 playMedia 在 !srv 时 throw,由调用方处理)
  const conn = srv.clients.get(clientId);
  // 同一时间线推流:组 = 以 clientId 命名的组(多客户端场景由注册层归并)。
  const g = srv.group(clientId);
  // ★ 借流:这一首若正好是源端**正在播**的那首,就把源端那条已解码的流整体接过来
  //   —— 目标端不启 ffmpeg、不 seek、不预缓冲,首帧现成即出声。不成立即静默回退。
  const arm = borrowFor(g, item);
  if (arm) {
    const r = handoverCore(srv, arm, g.name, item, conn ? [conn] : []);
    if (r.ok) return;
    log.info(`[Sendspin][handover] ${clientId} ← ${arm.fromGroup} 借流放弃(${r.reason}),走完整起播`);
  }
  const pump = pumpFor(srv, g);
  pump.stop(); // 打断上一首,避免重叠推流(MA:track change 丢弃旧 PushStream)
  // MA seek_position 属于**新**流:stop 之后装填,play() 起流即带 -ss 起点。
  if (seekPositionMs != null) pump.armSeek(seekPositionMs);
  // ⚠️ 切歌必须先 stream/end 收尾旧流,再 stream/start 起新流(成对)。
  // 只发 stream/start 会让设备把新流塞进「旧解码上下文」——它认为扬声器已在跑,
  // 不重建 ring buffer/speaker task,新流音频无从解码 → 链路上一切正常但**无声**
  // (2026-09-17 ESPHome 真机:重发 stream/start 后只剩 codec header 一行日志)。
  // MA 金标准同样是 `Stream ended` → `Stream Started` 成对出现。
  // 顺序:先置空 current 让 group/update 报 stopped,再 finishPlayback 发 stream/end;
  // 关掉旧编码器同时清掉残留分段(否则旧段字节会混进新歌首帧)。
  g.current = null;
  g.close();
  g.finishPlayback();
  g.positionMs = seekPositionMs ?? 0;
  // 当前曲元数据进组状态:status.media / queue currentMedia 据此上报,
  // 前端与 HA 靠 media.songId 变化触发歌词/封面刷新(缺了就卡在第一首)。
  g.current = { songId: item.songId, title: item.title, artist: item.artist, album: item.album, coverArt: item.coverArt, mime: item.mime, durationMs: (item.duration ?? 0) * 1000 };
  if (conn) {
    conn.group = g;
    g.add(conn); // 成员入组,推流才真正下发
    // 起播宣告:先组状态(playing),**再** stream/start —— 对齐 aiosendspin 的
    // `group/update(playing) → stream/start`(见 MA 真机:前者先到)。此前我们
    // 反着发(stream/start 在前),组状态仍 stopped 时设备端直接忽略 stream/start,
    // 无 format 不播 → ESPHome 真机一直不进入 PLAYING 的根因在此。
    //
    // ⚠️ stream/start **不能在这里立刻发**:pump.play() 要先解析网络源 + ffmpeg
    // 解码整曲,实测耗时可达 **10s**(长曲更久)。若 stream/start 先发而首块音频
    // 10s 后才到,设备侧会在等待中丢弃该流 —— 表现为收到 `Stream Started` 但
    // **不做 codec header 处理**、扬声器不启动 = 无声(2026-09-17 真机实锤)。
    // MA 的解法(player/v1.py `_pending_stream_start`)正是把这个消息**推迟到
    // 第一块音频到达时**才发 —— 我们同样用 pump 的 onFirstFrame 回调触发。
    conn.sendGroupUpdate();
    g.pendingAnnounces.push(conn);
  }
  // 后台起播:解码→按组时间线推流。不阻塞调用方(pollState 反映进度)。
  void pump.play(item.songId).catch((e) => {
    // 无可播源等:置空 current,交 QueueController 走跳过/换源。
    // stream/start 已发过,必须 stream/end 收尾,否则客户端空等。
    g.current = null;
    g.finishPlayback();
    onPlayFailed(clientId, item.songId, (e as Error)?.message || String(e));
  });
}

/** 停止核心(原 stop():打断 pump + 清组状态 + stream/end 成对收尾)。 */
export function stopCore(srv: SendspinServer | null, clientId: string): void {  const g = ephemeralOrReal(srv, clientId);
  if (srv) pumpFor(srv, srv.group(clientId)).stop();
  g.positionMs = 0;
  g.current = null;
  // 流结束 + playback_state → stopped,组状态同步给客户端(自然结束走 pump)。
  const live = srv?.group(clientId);
  if (live) live.finishPlayback();
  else srv?.clients.get(clientId)?.sendGroupUpdate();
}

/** 用户组起播核心:与 playCore 同步序(收尾旧流 → 元数据 → 入组宣告 → 后台 pump),
 *  区别是组 = 用户组名映射的共享组,成员 = 在线 conn 全集,共用一个 pump 同一时间线。
 *  各成员的 stream/start 由 pushFrame 首帧前逐个兑现(pendingAnnounces),与单设备
 *  时序一致 —— 新成员首块同样拿到真实 codec_header,不走合成回退。
 *  离线成员直接跳过(回归由重连/看门狗覆盖,不在此阻塞起播)。 */
export function playGroupCore(
  srv: SendspinServer | null,
  groupName: string,
  memberIds: string[],
  item: QueueItem,
  onPlayFailed: PlayFailedSink = () => {},
  /** MA `play_index(seek_position=N)` 等价通道(用户组重建流起点)。 */
  seekPositionMs?: number,
): void {
  if (!srv) return;
  const g = srv.group(groupName);
  // ★ 借流(见 playCore 同名段落):用户组作目标时同样适用 —— 泵照搬,成员原样。
  const arm = borrowFor(g, item);
  if (arm) {
    const conns = memberIds
      .map((id) => srv.clients.get(id))
      .filter((c): c is SendspinConnection => !!c);
    const r = handoverCore(srv, arm, g.name, item, conns);
    if (r.ok) return;
    log.info(`[Sendspin][handover] ${groupName} ← ${arm.fromGroup} 借流放弃(${r.reason}),走完整起播`);
  }
  const pump = pumpFor(srv, g);
  pump.stop(); // 打断上一首,避免重叠推流
  if (seekPositionMs != null) pump.armSeek(seekPositionMs);
  // stream/end 收尾旧流(成对)＋关旧编码器清残留分段:与 playCore 同因(无声事故)。
  g.current = null;
  g.close();
  g.finishPlayback();
  g.positionMs = seekPositionMs ?? 0;
  g.current = { songId: item.songId, title: item.title, artist: item.artist, album: item.album, coverArt: item.coverArt, mime: item.mime, durationMs: (item.duration ?? 0) * 1000 };
  for (const id of memberIds) {
    const conn = srv.clients.get(id);
    if (!conn) continue;
    conn.group = g;
    g.add(conn); // 成员入组,推流才真正下发
    // 组状态先行、stream/start 延迟到首帧前兑现:与 playCore 单成员时序逐项一致。
    conn.sendGroupUpdate();
    g.pendingAnnounces.push(conn);
  }
  // 后台起播:解码→按组时间线推流。不阻塞调用方(pollState 反映进度)。
  void pump.play(item.songId).catch((e) => {
    g.current = null;
    g.finishPlayback();
    onPlayFailed(groupName, item.songId, (e as Error)?.message || String(e));
  });
}

/** 用户组停止核心:打断 pump＋清状态＋stream/end(成员保留,下次起播复用)。 */
export function stopGroupCore(srv: SendspinServer | null, groupName: string): void {
  if (!srv) return;
  const g = srv.group(groupName);
  pumpFor(srv, g).stop();
  g.positionMs = 0;
  g.current = null;
  g.finishPlayback();
}

export interface GroupJoinResult {
  joined: boolean;
  /** true=组正在播,新成员从直播沿入流;false=组空闲,仅登记,下次起播生效。 */
  live: boolean;
  /** 播中加入时**已回填**的 chunk 数(>0 表示新成员立刻就有音频可播,无需等水位)。 */
  backfilled?: number;
}

/** 用户组成员直播沿加入:组在播 → 新成员立即拿 stream/start＋组状态,从当前
 *  cursor 收帧(与 announce 临时入流同构,无需历史);组空闲 → 仅登记。
 *  幂等(已在组内直接返回),离线 conn 返回 joined:false。 */
export function joinGroupCore(srv: SendspinServer | null, groupName: string, clientId: string): GroupJoinResult {
  if (!srv) return { joined: false, live: false };
  const conn = srv.clients.get(clientId);
  if (!conn) return { joined: false, live: false };
  const g = srv.group(groupName);
  if (g.members.has(conn)) return { joined: false, live: !!g.current };

  // MA 对齐:add_client 第一步 `await client.ungroup()` —— **一个客户端只属于一个组**。
  // 否则 conn 仍留在旧组(另一个用户组 / 它自己的独立播放组)的 `members` 里 → 旧组
  // 继续往它推音频 = 双成员 / 双流(同一首歌卡顿 + 双声叠加;2026-09-24 复盘 §8.2 row 13)。
  // 等价于 MA 的「先退旧组再入新组」,顺带让「加入群组中止原独立会话」(选项 A)自然成立。
  const old = conn.group;
  if (old && old !== g) {
    // 旧流先收尾(stream/end 成对 + 组状态 stopped),再摘出 conn —— 与 leaveGroupCore 同序。
    try { conn.sendJson("stream/end", {}); } catch { /* ignore */ }
    try { conn.sendGroupUpdate(); } catch { /* ignore */ }
    old.remove(conn);
    // 清掉旧组残留的延迟宣告,避免旧组 pushFrame 给已离组 conn 重发 stream/start(双流)。
    const pa = old.pendingAnnounces;
    let pi = pa.indexOf(conn);
    while (pi >= 0) { pa.splice(pi, 1); pi = pa.indexOf(conn); }
    conn.group = null;
    // 旧组若仅此一员(独立播放组)→ 停空转 pump + 关编码器 + 从 registry 移除
    // (与 onConnectionClosed 空组清理同因;多成员用户组不动,其余成员照常播)。
    if (old.empty) {
      pumpFor(srv, old).stop();
      old.close();
      srv.groups.delete(old.name);
    }
  }

  conn.group = g;
  g.add(conn);
  if (!g.current) return { joined: true, live: false };
  conn.sendGroupUpdate();
  // ★ 不能在加入瞬间就发 stream/start:FLAC 是块编码器(约 4096 样本 ≈ 85ms),
  //   新成员的编码器要攒满一块才吐首帧,「先宣告、后等货」会留出空窗,设备据此
  //   丢弃该流 → **播放中加入的新成员无声**(2026-09-24 真机;PCM 首批即产出,
  //   所以只有 FLAC 链路暴露)。改为挂入 pendingAnnounces,由 pushFrame 在该成员
  //   首块音频就绪时兑现 —— 与起播路径(playCore/playGroupCore)语义完全一致。
  g.pendingAnnounces.push(conn);
  // ★ late-join 回填(MA/aiosendspin `on_role_join` 的等价物,见
  //   SendspinGroup.seedLateJoin):组时间线游标领先墙钟**一整个预填充水位**
  //   (30s 档 ≈ 29s),只发未来帧会让新成员空等一个水位才出声 —— 这正是
  //   2026-09-24 真机「加入新设备要很久才发出声音」。有缓存就立刻补齐(内部按
  //   「先 stream/start、后音频」的顺序兑现宣告),没缓存就退回等首帧。
  // ⚠️ 两个可选调用都为了最小桩:`seedLateJoin` 缺席(childMain 单测的假组)当 0;
  //   `backfilled` 仅在**真的回填了**才出现在返回值里,保持既有
  //   `{joined, live}` 契约不变(两个既有测试用 toEqual 比对)。
  const backfilled = g.seedLateJoin?.(conn) ?? 0;
  return backfilled > 0 ? { joined: true, live: true, backfilled } : { joined: true, live: true };
}

/** 用户组成员摘除:给该成员发 stream/end＋组状态后移出(播中摘除不断其他成员)。
 *  按 clientId 在组成员里找(不依赖 clients 表,重连换 conn 引用仍可摘)。
 *  返回是否真的摘掉了一个成员。 */
export function leaveGroupCore(srv: SendspinServer | null, groupName: string, clientId: string): boolean {
  if (!srv) return false;
  const g = srv.group(groupName);
  for (const c of [...g.members]) {
    if (c.clientId !== clientId) continue;
    try { c.sendJson("stream/end", {}); } catch { /* ignore */ }
    try { c.sendGroupUpdate(); } catch { /* ignore */ }
    g.remove(c);
    return true;
  }
  return false;
}

/** 暂停核心(打断节奏循环,不断连接;恢复走 resumePumpCore)。 */
export function pauseCore(srv: SendspinServer | null, clientId: string): void {
  if (!srv) return;
  pumpFor(srv, srv.group(clientId)).pause();
}

/** 恢复核心:仅在「已有推流(暂停中)」时原地恢复;冷起播由主进程侧走 playMedia。 */
export function resumePumpCore(srv: SendspinServer | null, clientId: string): void {
  if (!srv) return;
  pumpFor(srv, srv.group(clientId)).resume();
}

/** seek 核心 —— **MA 权威语义**(controllers/player_queues/controller.py `seek` @862,
 *  逐条对齐,不自创机制):
 *    ① 先发布 (elapsed_time, last_updated) 位置对 —— `pump.seek()` 里的
 *       `group.positionMs = targetMs`(防 UI 回跳);泵空闲时同时记忆起播位置。
 *    ② `play_index(current_index, seek_position)` —— **整条流重建,且走与正常起播
 *       完全相同的路径**(playCore/playGroupCore:停旧流 → stream/end 成对 → 全新
 *       音源带 -ss 起点起流 → 新时间线锚点 now + send_ahead)。MA 没有"在跑着的
 *       流里挪指针",也没有帧边界换流;设备缓冲自然耗尽后接新流即 MA 真机行为。
 *  ⚠️ 不能只写 positionMs(旧实现):pump 主循环每帧按下标重写 positionMs,
 *  光写标记会被下一帧覆盖(进度回跳、音频原地),且不钳制 duration(拖到尾直接
 *  触发播完→跳歌/停播)。 */
export function seekCore(srv: SendspinServer | null, clientId: string, seconds: number): void {
  // 入口留痕:三条下发路径(index/childMain/protocolPlayer)最终都汇到这里,
  // 钳制结果与空闲记忆必须可见 —— 否则"拖了没反应"时分不清是没下发还是被钳制。
  const t0 = Date.now();
  if (srv) {
    const g = srv.group(clientId);
    const pump = pumpFor(srv, g);
    const cur = g.current;
    // 钳制到曲目时长(MA:`max(0, min(position, duration))`)。
    const durMs = cur?.durationMs && cur.durationMs > 0 ? cur.durationMs : null;
    const targetMs = Math.max(0, Math.round(seconds * 1000));
    const clampedMs = durMs != null ? Math.min(targetMs, durMs) : targetMs;
    log.debug(`[Sendspin][seekCore] ${clientId} 请求=${seconds.toFixed(2)}s 钳制=${(clampedMs / 1000).toFixed(2)}s 有在播=${!!cur}`);
    // ① 发布位置对 + 空闲态记忆起播位置。
    // 起播窗口内 `durationMs` 可能属于**上一首** → 此时不钳制(见 GroupPump.seek 的
    // opts.clamp),否则「切歌后立刻拖到靠后位置」会被上一首时长裁短(240:140s→114s)。
    // 收口改由本轮 play() 拿到新歌时长后完成(见 GroupPump.play 的起播期间 seek 分支)。
    const busy = pump.busy;
    pump.seek(seconds, { clamp: !busy && !!cur });
    if (!cur) {
      // 无在播曲(空闲):位置已记忆,下一次起播消费 —— MA resume_with_position 语义。
      return;
    }
    // ★ 起播窗口内(音源还没就绪,但**已有一次 play 在飞**):只记起播位置,由那次 play
    //   在音源就绪后自纠(带新起点重建一次,见 GroupPump.play 的起播期间 seek 分支)。
    //   此处**绝不能**再走 ②:两个 play 会各自 ++epoch 后互掐对方刚建好的窗口,存活者
    //   拿到零输出窗口(eof=true / decoded==baseSample)→ 被当成播完 → IDLE → 15s stalled
    //   → 从 0 重投 → frozen → 放行切歌(240 日志 12:31 实锤)。
    if (busy) {
      log.debug(`[Sendspin][seekCore] ${clientId} 起播窗口内 → 只记起播位置,不再起第二个 play`);
      return;
    }
    // ② play_index 等价:走完整起播路径重建流(同一首歌、新起点)。
    const item: QueueItem = {
      songId: cur.songId,
      title: cur.title ?? "",
      artist: cur.artist ?? "",
      album: cur.album ?? "",
      coverArt: cur.coverArt ?? "",
      mime: cur.mime ?? "",
      duration: (cur.durationMs || 0) / 1000,
    };
    const onFailed: PlayFailedSink = (cid, songId, message) => {
      // seek 重建失败绝不能静默:此前 noop 导致"拖动后无声"且无任何日志,
      // 只能靠 frozen 看门狗兜底(它会用无偏移重投,见 recoverInPlace)。
      log.error(`[Sendspin][seekCore] ${cid} 重建流失败 song=${songId}: ${message}`);
    };
    if (clientId.startsWith("ug:")) {
      const memberIds = Array.from(g.members, (m) => m.clientId).filter((id): id is string => !!id);
      playGroupCore(srv, clientId, memberIds, item, onFailed, clampedMs);
    } else {
      playCore(srv, clientId, item, onFailed, clampedMs);
    }
    log.debug(`[Sendspin][seekCore] ${clientId} 已走完整起播路径重建流 ${Date.now() - t0}ms`);
    return;
  }
  ephemeralOrReal(srv, clientId).positionMs = Math.max(0, seconds * 1000);
  log.debug(`[Sendspin][seekCore] ${clientId} 无 server,落 ephemeral 标记 ${Date.now() - t0}ms`);
}

/** 把当前组音量/静音**立刻**下发给设备(MA 语义:音量由设备输出级实时施加)。
 *
 *  这是「改了群组音量要等 30s 缓冲里的旧增益播完才生效」的根治点:命令是控制面
 *  (`server/command`),不携带音频,与设备缓冲深度无关。
 *  设备未宣告 volume/mute ⇒ `syncVolume` 内部判定后不发任何命令,音量继续走编码增益
 *  (改动前行为),故调用方**不需要任何分支**。
 *  srv 为空(服务未启动/子进程不在)时无事可做 —— 等真正起播时 `SendspinGroup.add`
 *  会再对齐一次。 */
function syncVolumeNow(srv: SendspinServer | null, clientId: string): void {
  if (!srv) return;
  try {
    srv.syncVolume(srv.group(clientId));
  } catch { /* 单条命令失败不影响音量落库/推送 */ }
}

/** 音量核心:**只写组音量**(Sendspin 单设备组的权威音量标度)。
 *  ⚠️ 不可同时写 conn.volume 与 group.volume —— 旧编码增益 = 两者乘积/100,
 *  双写即平方增益(拖 50 实得 25,v3.0.32 已修)。
 *  persist=true 时同步落库(按设备持久,重连恢复);`ug:` 用户组 volume 不落库
 *  (组成员关系临时,落库只认裸设备 id);announce 播报不走本函数(临时双写不持久)。 */
export function setVolumeCore(srv: SendspinServer | null, clientId: string, vol: number, persist = true): void {
  const g = ephemeralOrReal(srv, clientId);
  g.volume = Math.min(100, Math.max(0, vol));
  if (persist && !clientId.startsWith("ug:")) {
    saveDeviceVolumeState(clientId, { volume: g.volume });
  }
  syncVolumeNow(srv, clientId);
}

/** 静音核心:组与连接两侧同置(离线重连后组标记仍有效)。落库语义同 setVolumeCore。 */
export function setMutedCore(srv: SendspinServer | null, clientId: string, muted: boolean, persist = true): void {
  const g = ephemeralOrReal(srv, clientId);
  g.muted = muted;
  const conn = srv?.clients.get(clientId);
  if (conn) conn.muted = muted;
  if (persist && !clientId.startsWith("ug:")) {
    saveDeviceVolumeState(clientId, { muted });
  }
  syncVolumeNow(srv, clientId);
}

/** 轮询核心:逻辑播放状态以「组当前曲」为准(已注册播放器在投/续播即视为播放中);
 *  连接就绪与否只影响推流可达性,不改变 QueueController 的切歌/恢复判定。 */
export function pollCore(srv: SendspinServer | null, clientId: string): { playing: boolean; positionMs: number; durationMs: number } {
  const g = ephemeralOrReal(srv, clientId);
  return {
    playing: !!g.current,
    positionMs: g.positionMs,
    durationMs: (g as any).current?.durationMs ?? 0,
  };
}

/** pump 是否在推流(供主进程侧 resume 判定冷起播/原地恢复)。 */
export function pumpActiveCore(srv: SendspinServer | null, clientId: string): boolean {
  if (!srv) return false;
  return pumpFor(srv, srv.group(clientId)).active;
}

function ephemeralOrReal(srv: SendspinServer | null, clientId: string): { positionMs: number; volume: number; muted: boolean; current: any } {
  if (!srv) return ephemeralGroup(clientId) as any;
  return srv.group(clientId) as any;
}

// ==================== TTS 播报核心(原 announceSendspin 推流侧) ====================

export interface AnnounceProbeResult {
  /** 播报前组是否正在播(主进程据此决定 playFrom 恢复)。 */
  wasPlaying: boolean;
  /** 播报前的进度(ms,主进程恢复 seek 用)。 */
  savedPos: number;
}

/** 播报现场探针:必须在主进程 qc.deactivate **之前**调用 —— deactivate 会停流并清
 *  g.current,之后再捕获恒为「未在播/进度 0」,恢复就丢了现场。fork 模式经 RPC
 *  announceProbe 下发,in-proc 由 announce.ts 直调。 */
export function announceProbeCore(srv: SendspinServer, peerId: string): AnnounceProbeResult {
  const clientId = peerId.slice("sendspin:".length);
  const g = srv.group(clientId);
  return { wasPlaying: !!g.current, savedPos: g.current ? g.positionMs : 0 };
}

export interface AnnounceCoreOptions {
  volume?: number;
  timeoutMs?: number;
  /** 播报前进度(ms):由 announceProbeCore 在 deactivate 前捕获传入;不传则现场捕获
   *  (仅直调场景成立,主进程流程必须传)。 */
  savedPos?: number;
}

export interface AnnounceCoreResult {
  targets: number;
}

/** 播报核心:拉 TTS → 解码 → 按组时间线推帧 → flush 尾帧 → 音量/成员还原。
 *  队列冻结/恢复(playFrom/seek)是主进程状态,由调用方处理。 */
export async function announceCore(
  srv: SendspinServer,
  peerId: string,
  url: string,
  opts: AnnounceCoreOptions,
): Promise<AnnounceCoreResult> {
  const clientId = peerId.slice("sendspin:".length);
  const conn = srv.clients.get(clientId);
  const g = srv.group(clientId);

  // 现场:音量(连接+组)与进度。进度优先取探针值(主进程流程在 deactivate 前捕获,
  // 此时 g.current 已被清空);直调无探针时现场捕获兜底。无 current 则进度从 0 起。
  const savedVol = conn?.volume ?? 100;
  const savedGroupVol = g.volume;
  const savedPos = opts.savedPos ?? (g.current ? g.positionMs : 0);
  try {
    if (typeof opts.volume === "number") {
      const v = Math.max(0, Math.min(100, Math.round(opts.volume)));
      if (conn) conn.volume = v;
      g.volume = v;
    }
    // 拉 TTS → 解码 48k 立体声。外链抓取 15s 超时,失败直接进恢复流程抛错。
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`TTS 拉取失败: HTTP ${resp.status}`);
    const pcm = await decodeToF32(new Uint8Array(await resp.arrayBuffer()));
    // 入组(之前没在播就没成员)+ 宣告流格式,否则帧无处下发 / 客户端无格式丢弃。
    // 播完后若是新加的则摘掉,恢复播报前成员原样。
    let joined = false;
    if (conn && !g.members.has(conn)) {
      g.add(conn);
      joined = true;
    }
    if (conn) conn.announceStream();
    try {
      // 固定 20ms 喂料(960 样本/声道):播报要短延迟出首声,粒度越小越早凑满首块。
      // MA `chunk_duration_us = 25_000` 是**稳态推流**的粒度,播报属一次性短音频,
      // 粒度取 20ms 让 libFLAC 尽快凑满 4096 样本的块(≈85ms)并回调首帧。
      // ⚠️ 此处不依赖任何编码器前瞻 —— flac 走进程内 libFLAC(`LibFlacEncoder`),
      // `process_interleaved()` 同步返回、每回调恰好一帧,flush() 只用于冲尾帧。
      const frameSamples = SAMPLE_RATE * CHANNELS * 20 / 1000;
      const endCap = g.current && g.current.durationMs > 0 ? Math.max(0, g.current.durationMs - 500) : Infinity;
      let cursor = g.timelineBaseUs;
      let firstFrame = true;
      const deadline = Date.now() + (opts.timeoutMs ?? 300000);
      for (let off = 0; off < pcm.length; off += frameSamples) {
        if (Date.now() > deadline) break;
        const slice = pcm.subarray(off, Math.min(off + frameSamples, pcm.length));
        const posMs = Math.min(savedPos + Math.round((off / frameSamples) * 20), endCap);
        g.positionMs = posMs;
        // 时间戳与曲库推流同一套模型(MA `push_stream.py:1313`):
        // 首块锚在「当时墙钟 + 组公共 send_ahead」,之后**按实际产出样本数**累加。
        // 锚点必须用与帧头同源的 send_ahead,否则 delta≠0 → 设备立即吐字节 → 断流。
        if (firstFrame) {
          firstFrame = false;
          const aheadUs = g.commonSendAheadUs();
          cursor = nowUs() + BigInt(Math.max(aheadUs, FIRST_FRAME_LEAD_US));
        }
        const produced = Number(await g.pushFrame(cursor, slice)) || 0;
        cursor += BigInt(Math.round(((produced > 0 ? produced : Math.floor(slice.length / CHANNELS)) / SAMPLE_RATE) * 1_000_000));
        g.timelineBaseUs = cursor;
        await new Promise((r) => setTimeout(r, 20));
      }
      // 逼出编码器内部尚未吐出的尾帧:不 flush 则短播报可能一帧都没出去;
      // 顺带让首段拿到真实 STREAMINFO。
      for (const c of [...g.members]) {
        const enc = g.encoderFor(c);
        if (!enc.flush) continue;
        try {
          const tail = await enc.flush();
          for (const ck of tail) {
            if (!ck?.data || ck.data.length === 0) continue;
            c.sendAudio(cursor, ck.data);
            cursor += BigInt(Math.round(((ck.frameSamples ?? 0) / SAMPLE_RATE) * 1_000_000));
          }
        } catch { /* 尾帧失败不影响主流程 */ }
      }
      g.timelineBaseUs = cursor;
    } finally {
      if (joined && conn) g.remove(conn);
    }
    if (conn) conn.volume = savedVol;
    g.volume = savedGroupVol;
    // 播报期间音量被临时改过(见上 `g.volume = v`),这里是**直接还原赋值**、绕过
    // setVolumeCore ⇒ 必须显式补发一次命令,否则设备停在播报音量上再也回不来。
    syncVolumeNow(srv, clientId);
    return { targets: 1 };
  } catch (e) {
    // 失败也要把现场还原(音量/成员),否则播报一次失败永久改音量。
    if (conn) conn.volume = savedVol;
    g.volume = savedGroupVol;
    syncVolumeNow(srv, clientId);
    throw e;
  }
}
