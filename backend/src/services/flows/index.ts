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
import { setDeviceVolume, getDeviceVolume, refreshDevices } from "../dlna/control.js";
import { resolveContentSongs, songsToQueueItems } from "../content.js";
import { isFixedRecommendPlaylist, ensureHomePlaylist } from "../plugin/fixedRecommend.js";
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

/**
 * 对 dlna 设备发送 SetVolume 并在 windowMs 窗口内回读对账(±1 不符重发)。
 * 返回设备最终确认的音量;窗口内始终对不上时返回 -1(不抛错,由调用方决定是否中止)。
 * 全程带日志:成功记 info,超时记 warn —— 修复原先「成功不打日志、静默失败也不打」的可观测性盲区。
 */
async function applyVolumeWithReconcile(
  deviceId: string,
  value: number,
  windowMs: number,
  pollMs: number,
  logTag: string,
): Promise<number> {
  await setDeviceVolume(deviceId, value);
  let attempts = 1;
  let got = -1;
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try { got = await getDeviceVolume(deviceId); } catch { got = -1; }
    if (got >= 0 && Math.abs(got - value) <= 1) break; // 对上
    if (Date.now() < deadline) { await setDeviceVolume(deviceId, value); attempts++; }
  }
  if (got >= 0 && Math.abs(got - value) <= 1) {
    log.info(`${logTag} SetVolume(${value}) 对账通过(发送${attempts}次,设备回读 ${got})`);
    return got;
  }
  log.warn(`${logTag} SetVolume(${value}) 对账超时(${windowMs}ms 内发送${attempts}次,设备最终回读 ${got < 0 ? "失败" : got})`);
  return -1;
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
  while (true) {
    try { await refreshDevices(); } catch { /* 扫描失败下一轮重试 */ }
    // 目标解析:本机播放器对外只有 local:<userId>(临时端 ID 不外露),这里按该用户
    // 已注册的客户端实例解析成真实 peerId;客户端还没连上时保留原样下一轮再试。
    online = [...declaredTargets]
      .map((pid) => pm.resolveVisiblePeerId(pid))
      .filter((pid) => {
        const p = pm.get(pid);
        return p && p.available;
      });
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
    // 本次运行中各 dlna 目标最近一次设定的目标音量。用于起播后补偿重发:
    // Linkplay 类设备(如 HiVi H5MKII/MUZO)在刚通电就位时会对 SetVolume「假接受」,
    // 随后的 SetAVTransportURI/Play 起播流程会把实际输出音量重置回设备自己的值,
    // 而 UPnP 状态仍保留设定值(对账显示成功)→ 听感上音量没生效。
    // 因此 content 节点起播稳定后,需要把此前 volume 节点设过的音量再补发一次。
    const volumeByTarget = new Map<string, number>();
    for (const node of nodes) {
      switch (node.type) {
        case "trigger": {
          // 触发匹配在路由层完成(webhook token / 手动执行);节点本身无副作用,
          // 作为流程的触发声明存在(未来可扩展 schedule 等其它触发类型)。
          break;
        }
        case "target": {
          for (const pid of node.targets || []) {
            if (!activeTargets.has(pid) && pm.get(pid)?.available) activeTargets.add(pid);
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
            // 起播后音量补偿:设备在 SetAVTransportURI/Play 起播流程中可能重置实际输出
            // 音量(UPnP 状态仍保留旧设定值,对账显示成功)。等 2 秒起播流程走完后,
            // 把此前 volume 节点设过的目标音量补发一次。失败仅 warn,不中止流程。
            const want = volumeByTarget.get(pid);
            if (parsed.kind === "dlna" && want !== undefined) {
              await sleep(2000);
              try {
                await applyVolumeWithReconcile(parsed.id, want, 5000, 500, `[flow ${flow.name}] ${nameOf(pid)} 起播后音量补偿`);
              } catch (e: any) {
                log.warn(`[flow ${flow.name}] ${nameOf(pid)} 起播后音量补偿 ${want}% 失败,继续:${e?.message || e}`);
              }
            }
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
          // 默认作用于全部目标集。dlna 目标:发送后**自动对账**——在 windowMs
          // (默认 10s)轮询窗口内每 pollMs(默认 500ms)回读 GetVolume,发现对不上
          // (±1)就重发 SetVolume,直到对上或窗口结束;对账失败**不中止流程**
          // (仅 warn),继续下一节点。group 仅发送(成员对账由各设备自理)。
          // 同时记录目标音量到 volumeByTarget,供 content 节点起播后补偿重发。
          const value = Math.max(0, Math.min(100, Math.round(node.value)));
          const windowMs = Math.max(500, Math.min(60000, typeof node.windowMs === "number" ? node.windowMs : 10000));
          const pollMs = Math.max(100, Math.min(5000, typeof node.pollMs === "number" ? node.pollMs : 500));
          for (const pid of activeTargets) {
            const parsed = parseOrThrow(pid);
            try {
              if (parsed.kind === "dlna") {
                volumeByTarget.set(pid, value);
                await applyVolumeWithReconcile(parsed.id, value, windowMs, pollMs, `[flow ${flow.name}] ${nameOf(pid)} 音量`);
              } else if (parsed.kind === "group") {
                await qc.transport(parsed.id, "volume", value);
              }
            } catch (e: any) {
              log.warn(`[flow ${flow.name}] ${nameOf(pid)} 音量 ${value}% 对账失败,继续执行下一节点:${e?.message || e}`);
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