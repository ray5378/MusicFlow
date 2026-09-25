// 音流(MusicFlow)执行引擎。
// 一条音流 = 按顺序执行的「节点」列表(trigger/target/content/playmode/volume/delay),
// 节点可拖拽排序、任意位置插入、可重复。执行时:先收集所有 target 节点目标并等待任一
// 上线,再按节点顺序逐一执行;任何节点抛错 → 整个流程中止(状态 error)。
// 旧版固定配置(targets/volume/playmode/content)已作废,不再解析。
import { randomUUID as uuidv4 } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { flows } from "../../db/schema.js";
import { getPeerManager, parsePeerId } from "../peer.js";
import { getQueueManager } from "../dlna/queue.js";
import { getQueueController } from "../player/index.js";
import { setDeviceVolume, refreshDevices } from "../dlna/control.js";
import { resolveContentSongs, songsToQueueItems } from "../content.js";
import { isFixedRecommendPlaylist, ensureHomePlaylist } from "../plugin/fixedRecommend.js";
import { getGroupManager, splitMemberId } from "../group/index.js";
import { checkPlayTarget } from "../playTarget.js";
import { wakeSendspinDiscovery, isSendspinEnabled, readSendspinPluginConfig } from "../sendspin/index.js";
import { rescanAirPlayDevices } from "../airplay/discovery.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("INDEX");
export type FlowPlayMode = "order" | "one" | "all" | "shuffle";
export type FlowContentType = "playlist" | "album" | "artist" | "genre";

/** 音流节点:触发 / 目标设备/组 / 播放内容 / 播放模式 / 设置音量 / 延迟。
 *  节点按 nodes 数组顺序执行,可拖拽排序、任意位置插入、可重复。 */
export type FlowNode =
  | { type: "trigger"; triggerType: "webhook" }
  | { type: "target"; targets: string[] }
  | { type: "content"; contentType: FlowContentType; id: string; name?: string; startIndex?: number }
  | { type: "playmode"; mode: FlowPlayMode }
  | { type: "volume"; value: number; windowMs?: number; pollMs?: number }
  | { type: "delay"; ms: number };

export interface FlowDefinition {
  /** 按顺序执行的节点列表。旧版 targets/volume/playmode/content 字段已作废(旧格式不再解析)。 */
  nodes: FlowNode[];
  /** 等待设备上线超时(秒);0 = 无限等待 */
  waitTimeoutSec: number;
  /** 持续扫描间隔(秒),2..60 */
  scanIntervalSec: number;
}

export interface FlowRow {
  id: string;
  token: string;
  /** 对外链接绑定的「通用播放器控制」渠道 token id;空 = 未绑定,链接不可用。 */
  tokenId: string;
  /** 归属用户 id:音流按用户划分,普通用户仅见/管自己的;管理员见全部。 */
  ownerUserId: string;
  name: string;
  definition: FlowDefinition;
  enabled: boolean;
  lastRunAt: string;
  lastRunStatus: string; // waiting|playing|success|error|timeout
  lastRunError: string;
  createdAt: string;
  updatedAt: string;
}

function isValidNode(n: any): n is FlowNode {
  if (!n || typeof n !== "object") return false;
  switch (n.type) {
    case "trigger": return n.triggerType === "webhook";
    case "target": return Array.isArray(n.targets);
    case "content": return ["playlist", "album", "artist", "genre"].includes(n.contentType) && typeof n.id === "string";
    case "playmode": return ["order", "one", "all", "shuffle"].includes(n.mode);
    case "volume": return typeof n.value === "number";
    case "delay": return typeof n.ms === "number";
    default: return false;
  }
}

function parseDef(json: string): FlowDefinition {
  try {
    const raw = JSON.parse(json || "{}");
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isValidNode) : [];
    return {
      nodes,
      waitTimeoutSec: typeof raw.waitTimeoutSec === "number" ? raw.waitTimeoutSec : 0,
      scanIntervalSec: typeof raw.scanIntervalSec === "number" ? raw.scanIntervalSec : 5,
    };
  } catch {
    return { nodes: [], waitTimeoutSec: 0, scanIntervalSec: 5 };
  }
}

function rowToFlow(r: any): FlowRow {
  return {
    id: r.id,
    token: r.token,
    tokenId: r.tokenId || "",
    ownerUserId: r.ownerUserId || "",
    name: r.name,
    definition: parseDef(r.definitionJson),
    enabled: r.enabled === 1,
    lastRunAt: r.lastRunAt || "",
    lastRunStatus: r.lastRunStatus || "",
    lastRunError: r.lastRunError || "",
    createdAt: r.createdAt || "",
    updatedAt: r.updatedAt || "",
  };
}

export function listFlows(ownerUserId?: string): FlowRow[] {
  if (ownerUserId) {
    return db.select().from(flows).where(eq(flows.ownerUserId, ownerUserId)).all().map(rowToFlow);
  }
  return db.select().from(flows).all().map(rowToFlow);
}

export function getFlow(id: string, ownerUserId?: string): FlowRow | undefined {
  const cond = ownerUserId
    ? and(eq(flows.id, id), eq(flows.ownerUserId, ownerUserId))
    : eq(flows.id, id);
  const r = db.select().from(flows).where(cond).get();
  return r ? rowToFlow(r) : undefined;
}

export function getFlowByToken(token: string): FlowRow | undefined {
  const r = db.select().from(flows).where(eq(flows.token, token)).get();
  return r ? rowToFlow(r) : undefined;
}

export function createFlow(ownerUserId: string, name: string, definition: FlowDefinition, tokenId = ""): FlowRow {
  const id = `flow-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const now = new Date().toISOString();
  db.insert(flows).values({
    id,
    token: uuidv4().replace(/-/g, ""),
    tokenId,
    ownerUserId,
    name,
    definitionJson: JSON.stringify(definition),
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  }).run();
  return getFlow(id, ownerUserId)!;
}

export function updateFlow(id: string, ownerUserId: string | undefined, patch: { name?: string; definition?: FlowDefinition; enabled?: boolean; tokenId?: string }): FlowRow | undefined {
  const cur = getFlow(id, ownerUserId);
  if (!cur) return undefined;
  const now = new Date().toISOString();
  db.update(flows).set({
    name: patch.name ?? cur.name,
    tokenId: patch.tokenId === undefined ? cur.tokenId : patch.tokenId,
    definitionJson: patch.definition ? JSON.stringify(patch.definition) : JSON.stringify(cur.definition),
    enabled: patch.enabled === undefined ? (cur.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
    updatedAt: now,
  }).where(eq(flows.id, id)).run();
  return getFlow(id, ownerUserId);
}

export function deleteFlow(id: string, ownerUserId?: string): boolean {
  const cur = getFlow(id, ownerUserId);
  if (!cur) return false;
  db.delete(flows).where(eq(flows.id, id)).run();
  return true;
}

export function setFlowEnabled(id: string, ownerUserId: string | undefined, enabled: boolean): void {
  if (!getFlow(id, ownerUserId)) return;
  db.update(flows).set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() }).where(eq(flows.id, id)).run();
}

function touchRunStatus(id: string, status: string, error: string): void {
  db.update(flows).set({
    lastRunAt: new Date().toISOString(),
    lastRunStatus: status,
    lastRunError: error,
  }).where(eq(flows.id, id)).run();
}

const running = new Set<string>();

export function isFlowRunning(id: string): boolean {
  return running.has(id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 目标唤醒(2026-09-25)──────────────────────────────────────────────────
// 等待阶段原本只做两件事:`refreshDevices()`(只扫 DLNA)+ 读 `peer.available`。
// 而 sendspin 的 peer **只在设备已连上时才注册**(peer.ts registerSendspin),
// airplay 靠自己的常驻 mDNS browser —— 两者都不在 refreshDevices 的覆盖范围内:
//   - sendspin 的 browser 每 60s 才重建一次(discover.ts BROWSER_REFRESH_MS),
//     音流的等待窗口(waitTimeoutSec,常见 30~60s)往往更短 ⇒ 不主动催,必然
//     等到 timeout 也看不见设备;
//   - airplay 的常驻句柄收不到刚上电设备的首轮应答(见 discovery.ts spinQuery 注释),
//     得开个短命句柄重扫一次。
// 这里在每轮扫描时**主动催一次发现**,全程复用既有链路(不新增拨号路径):
//   sendspin(独立设备 **与** 群组里的 sendspin 成员一视同仁)
//            → wakeSendspinDiscovery():重建 browser(在线设备重新 emit up →
//              discover 自动入册 + 开重试窗口)+ 对拨号名单里「当前未在线」的目标补一枪
//   airplay  → rescanAirPlayDevices()(短命 `_raop._tcp` 查询,upsert 后 peer 实时桥接)
// DLNA 无需唤醒:refreshDevices() 本来就是同步扫描。
//
// 🔴 sendspin 那一路**必须**走 wakeSendspinDiscovery() 这个入口,不能在本文件里直调
// refreshPlayerDiscoveryNow / armDialTarget:发现循环(browser + 重试状态机)活在
// **sendspin 子进程**里,而音流引擎跑在主进程 —— fork 模式下直调是**静默空转**
// (2026-09-25 实测:音流唤醒 100% 无效,日志只有 `armDialTarget: sendspin 服务未运行`)。
// 入口内部按 isForkMode() 分派到 RPC / 直跑,并统一做「插件启用 + autoDiscover」守卫。
const WAKE_MIN_GAP_MS = 5_000; // 与 discover.refreshPlayerDiscoveryNow 的默认节流对齐
let lastWakeAt = 0;            // 进程级节流(多条音流共享,避免叠加轰炸 mDNS)
let dialSweepBusy = false;     // sendspin 唤醒的 in-flight 门(等 RPC 回来)
let airplayRescanBusy = false; // airplay 重扫的 in-flight 门(其内部要等 2.5s 收应答)
let wakeLogged = false;        // 每次执行首轮打 info,之后降 debug(免得每 3s 刷屏)

/** 目标需要哪条唤醒通道。group 只看**组内是否真有 sendspin 成员** ——
 *  组自己的 `available` 恒 true(不因成员掉线而不可用,故也不在等待里挂成员),
 *  但成员设备得先连上才可能出声,所以要按独立设备同一条通道去催。 */
function wakeChannels(targets: Set<string>): { sendspin: boolean; airplay: boolean } {
  let sendspin = false;
  let airplay = false;
  const gm = getGroupManager();
  for (const pid of targets) {
    const p = parsePeerId(pid);
    if (!p) continue;
    if (p.kind === "sendspin") sendspin = true;
    else if (p.kind === "airplay") airplay = true;
    else if (p.kind === "group") {
      const g = gm.get(p.id);
      if ((g?.memberIds || []).some((m) => splitMemberId(m)?.kind === "sendspin")) sendspin = true;
    }
  }
  return { sendspin, airplay };
}

/** 主动唤醒目标设备(节流 + 非阻塞)。失败静默:下一轮还会来。 */
async function wakeTargets(targets: Set<string>, flowName: string): Promise<void> {
  const need = wakeChannels(targets);
  if (!need.sendspin && !need.airplay) return;
  const now = Date.now();
  if (now - lastWakeAt < WAKE_MIN_GAP_MS) return;
  lastWakeAt = now;
  const did: string[] = [];
  if (need.sendspin) {
    // 守卫(2026-09-25):尊重插件启用与 `autoDiscover` 开关 —— **配置即意志**。
    // 插件没启用 / 用户关掉了「自动发现」时,音流也不主动拨号(否则就成了绕过配置的
    // 后门);此时设备只能靠自己连入或手工 dial,等不到就按 waitTimeoutSec 走 timeout。
    // (wakeSendspinDiscovery() 内部也做同样的守卫,这里是头一道,顺带给出可读的日志。)
    let why = "";
    try {
      if (!isSendspinEnabled()) why = "sendspin 插件未启用";
      else if (!readSendspinPluginConfig().autoDiscover) why = "autoDiscover 已关闭";
    } catch { why = "读取 sendspin 插件配置失败"; }
    if (why) {
      log.debug(`[flow ${flowName}] 跳过 sendspin 唤醒:${why}`);
    } else if (!dialSweepBusy) {
      dialSweepBusy = true;
      try {
        // 一次调用完成两件事(①重建 browser 重发 PTR 查询 ②对名单里未在线的目标补
        // 开重试窗口)。**必须串行 await**:wakeLogged 只让首轮打 info,而 RPC 是异步的
        // —— 早先 fire-and-forget 时 did 还是空的,连「重扫」这条记录都攒不出来。
        const r = await wakeSendspinDiscovery();
        if (r.rescanned) did.push("sendspin 重扫");
        if (r.rearmed.length) did.push(`sendspin 名单补枪 ×${r.rearmed.length}`);
      } catch { /* 下一轮重来 */ } finally { dialSweepBusy = false; }
    }
  }
  if (need.airplay && !airplayRescanBusy) {
    airplayRescanBusy = true;
    void rescanAirPlayDevices()
      .catch(() => { /* ignore */ })
      .finally(() => { airplayRescanBusy = false; });
    did.push("airplay 重扫");
  }
  if (did.length === 0) return;
  if (!wakeLogged) {
    wakeLogged = true;
    log.info(`[flow ${flowName}] 等待阶段主动发现目标:${did.join(" + ")}`);
  } else {
    log.debug(`[flow ${flowName}] 等待阶段主动发现目标:${did.join(" + ")}`);
  }
}

/** 目标此刻是否「可播」。与「peer 是否 available」的区别在**群组与 AirPlay**:
 *
 *  两者的「peer 行可用」都不代表「真能出声」 —— 组行 `available` **恒 true**
 *  (peer.ts「组恒可见」的展示约定:不因成员掉线而整行不可用/消失);
 *  AirPlay 设备档案持久化,离线也仍留在列表里。
 *
 *  判据不在这里算,统一问 `playTarget.checkPlayTarget()`(单一真相源,播放层的
 *  QueueController 起播前查的是**同一个**函数):组 = 有没有在线成员;
 *  AirPlay = discovery 的 available;dlna/sendspin 乐观放行。
 *
 *  🔴 判为「未就绪」时音流**继续等待**(并持续催发现),而不是把内容投进不可播的目标 ——
 *  投进去的后果不是「静默不播」,而是 QueueController 反复 cast 失败 →
 *  `castFailStreak++` + `handleDecision("stalled")` 自我续 loop → **边失败边切歌**:
 *  2026-09-25 真机实测,组零成员 + 大歌单,6 分钟空转 787 次 `无在线成员,无法播放`,
 *  idx 从 293 被一路推到 49(视感 = 疯狂切歌)。这违背「没播放器在线就不开始播放」的
 *  长久行为,故在此拦死(等待到有 ≥1 个在线才继续)。 */
function isTargetReady(pid: string): boolean {
  return checkPlayTarget(pid).playable;
}

/**
 * 异步执行一条音流。同一时间同一流程只允许一个运行实例(重复触发直接跳过)。
 * 执行过程:
 *   1) 校验节点列表非空 + 至少一个 target 节点;
 *   2) 状态 → waiting:持续扫描(主动 refreshDevices + 读 peer 可用性),
 *      直到任一目标上线(waitTimeoutSec=0 时无限等待);
 *   3) 状态 → playing:按顺序遍历节点执行(target 并集 → content 解析+播放 →
 *      playmode / volume / delay 任意组合),任何节点失败即中止;
 *   4) 状态 → success / error / timeout,结果写回 flows 表。
 */
export async function executeFlow(flowId: string, baseUrl: string): Promise<"started" | "already-running"> {
  if (running.has(flowId)) return "already-running";
  const flow = getFlow(flowId);
  if (!flow) return "started"; // 不存在的情况由调用方处理
  running.add(flowId);
  setTimeout(() => {
    runInternal(flow.id, baseUrl).catch((e: any) => {
      console.warn(`[flow ${flow.name}] 执行异常:`, e?.message || e);
      touchRunStatus(flow.id, "error", e?.message || "执行异常");
    }).finally(() => running.delete(flowId));
  }, 0);
  return "started";
}

async function runInternal(flowId: string, baseUrl: string): Promise<void> {
  const flow = getFlow(flowId);
  if (!flow) return;
  const def = flow.definition;
  const pm = getPeerManager();
  const qm = getQueueManager();
  const qc = getQueueController();

  const nodes = def.nodes || [];
  if (nodes.length === 0) {
    touchRunStatus(flowId, "error", "音流未配置节点(旧版固定配置已作废,请在编辑器中重新搭建节点流程)");
    return;
  }

  // 收集所有 target 节点声明的目标(并集,可多个 target 节点)。
  const declaredTargets = new Set<string>();
  for (const n of nodes) {
    if (n.type === "target") {
      for (const t of n.targets || []) {
        if (parsePeerId(t)) declaredTargets.add(t);
      }
    }
  }
  if (declaredTargets.size === 0) {
    touchRunStatus(flowId, "error", "未配置目标设备/组节点");
    return;
  }

  // 阶段 1:持续扫描等待任一目标上线(保留原等待语义)。
  touchRunStatus(flowId, "waiting", "");
  const intervalMs = Math.max(2, Math.min(60, def.scanIntervalSec || 5)) * 1000;
  const deadline = def.waitTimeoutSec > 0 ? Date.now() + def.waitTimeoutSec * 1000 : 0;
  let online: string[] = [];
  wakeLogged = false; // 本次执行的首轮唤醒打 info,之后降 debug
  while (true) {
    try { await refreshDevices(); } catch { /* 扫描失败下一轮重试 */ }
    // 主动催一次 sendspin / airplay 的发现(见上方 wakeTargets 注释):
    // 这两类设备的 peer 不靠 refreshDevices 更新,不催的话等待窗口内根本看不见它们。
    await wakeTargets(declaredTargets, flow.name);
    // 目标解析:本机播放器对外只有 local:<userId>(临时端 ID 不外露),这里按该用户
    // 已注册的客户端实例解析成真实 peerId;客户端还没连上时保留原样下一轮再试。
    online = [...declaredTargets]
      .map((pid) => pm.resolveVisiblePeerId(pid))
      .filter((pid) => isTargetReady(pid));
    if (online.length > 0) break;
    if (deadline > 0 && Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  if (online.length === 0) {
    touchRunStatus(flowId, "timeout", `等待设备上线超时(${def.waitTimeoutSec || 0}s),未找到可用目标`);
    return;
  }

  // 阶段 2:按顺序遍历节点执行。任何节点抛错 → 整个流程中止(状态 error)。
  touchRunStatus(flowId, "playing", "");
  const activeTargets = new Set<string>(online); // 当前目标集:target 节点并集 ∩ 在线
  const nameOf = (pid: string) => pm.get(pid)?.name || pid;
  const parseOrThrow = (pid: string) => {
    const p = parsePeerId(pid);
    if (!p) throw new Error(`无效目标:${pid}`);
    return p;
  };
  try {
    for (const node of nodes) {
      switch (node.type) {
        case "trigger": {
          // 触发匹配在路由层完成(webhook token / 手动执行);节点本身无副作用,
          // 作为流程的触发声明存在(未来可扩展 schedule 等其它触发类型)。
          break;
        }
        case "target": {
          for (const pid of node.targets || []) {
            if (!activeTargets.has(pid) && isTargetReady(pid)) activeTargets.add(pid);
          }
          break;
        }
        case "content": {
          if (activeTargets.size === 0) throw new Error("播放内容节点执行时无在线目标(请把目标设备/组节点放在播放内容之前)");
          // 固定推荐歌单(今日漫游/今日推荐/本地推荐)自愈:缺失或暂无内容时自动生成。
          if (node.contentType === "playlist" && isFixedRecommendPlaylist(node.id)) {
            const ensure = await ensureHomePlaylist(node.id);
            if (!ensure.ok) throw new Error(`推荐歌单「${node.name || node.id}」未就绪:${ensure.reason || "生成失败"}`);
          }
          const resolved = await resolveContentSongs(node.contentType || "playlist", node.id);
          if (!resolved || resolved.rows.length === 0) {
            throw new Error(`内容解析失败:${node.name ? `「${node.name}」` : "所选内容"}无可播放歌曲`);
          }
            const items = songsToQueueItems(resolved.rows);
          for (const pid of activeTargets) {
            const parsed = parseOrThrow(pid);
            await qm.playFrom(parsed.id, items, node.startIndex || 0, baseUrl);
            console.log(`[flow ${flow.name}] 已播放:${nameOf(pid)} → 「${resolved.name}」`);
          }
          break;
        }
        case "playmode": {
          for (const pid of activeTargets) {
            const parsed = parseOrThrow(pid);
            qm.setPlayMode(parsed.id, node.mode);
          }
          break;
        }
        case "volume": {
          // 常规路径:直接发一次 SetVolume 就完事,不回读、不对账(与播放器音量接口
          // 同一条后端链路)。dlna 目标 → setDeviceVolume;group → 组内成员扇出。
          const value = Math.max(0, Math.min(100, Math.round(node.value)));
          for (const pid of activeTargets) {
            const parsed = parseOrThrow(pid);
            try {
              if (parsed.kind === "dlna") {
                await setDeviceVolume(parsed.id, value);
                console.log(`[flow ${flow.name}] 已设置音量:${nameOf(pid)} → ${value}%`);
              } else if (parsed.kind === "group") {
                await qc.transport(parsed.id, "volume", value);
              }
            } catch (e: any) {
              log.warn(`[flow ${flow.name}] ${nameOf(pid)} 音量 ${value}% 设置失败,继续执行下一节点:${e?.message || e}`);
            }
          }
          break;
        }
        case "delay": {
          const ms = Math.max(0, Math.min(3600000, Math.round(node.ms || 0)));
          if (ms > 0) await sleep(ms);
          break;
        }
      }
    }
    touchRunStatus(flowId, "success", "");
  } catch (e: any) {
    touchRunStatus(flowId, "error", e?.message || String(e));
    log.warn(`[flow ${flow.name}] 节点执行失败:${e?.message || e}`);
  }
}