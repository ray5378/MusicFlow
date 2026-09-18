// ==================== Sendspin 主进程侧外观(镜像 + RPC 代理) ====================
//
// fork 模式下,主进程不再持有 SendspinServer 实例 —— 路由/外围代码通过本「外观」
// 访问 sendspin 状态:
//  - 同步读(实时性要求高的路由展示):读 supervisor 维护的**状态镜像**(child 推送);
//  - 命令写(配对/拨号/静音等):RPC 转发到子进程。
// in-proc 模式(单测/MUSICFLOW_SENDSPIN_INPROC=1)下 getSendspinFront() 直接返回真实
// SendspinServer —— 它天然满足 SendspinServerLike 结构,路由代码两种模式零分叉。
//
// ⚠️ 镜像不含 positionMs(40 次/秒的高频字段,走 QC pollState → RPC poll 轮询);
// ⚠️ 镜像不含 PSK / 任何敏感字段,当前曲等纯展示字段除外。
import type { SendspinServer } from "./server.js";
import { getServer } from "./runtime.js";
import { sendspinSupervisor } from "./supervisor.js";
import { AssertImplements, rpcFireAndForget } from "../rendererHost/front.js";

/** 连接视图:真实 SendspinConnection 与镜像行的公共字段(主进程侧只许用这些)。 */
export interface ConnView {
  clientId: string | null;
  name: string;
  roles: string[];
  legacy: boolean;
  ready: boolean;
  remoteHost: string;
  dialed: boolean;
  dialHost: string;
  dialPort: number;
  volume: number;
  muted: boolean;
}

/** 组视图:真实 SendspinGroup 与镜像行的公共字段。 */
export interface GroupView {
  name: string;
  volume: number;
  muted: boolean;
  current: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string; durationMs: number } | null;
}

/** 配对记录视图。clientId 可选:真实 PairingStore.getRecord 返回的 PairingRecord
 *  不含 clientId(它是 Map key),proxy 镜像侧才补上一份。 */
export interface RecordView {
  clientId?: string;
  createdAt: number | null;
  lastUsedAt: number | null;
}

/** 主进程侧访问 sendspin 的统一外观(真实 server 与 fork 代理的公共结构)。 */
export interface SendspinServerLike {
  readonly port: number;
  readonly serverId: string;
  readonly clients: ReadonlyMap<string, ConnView>;
  readonly groups: ReadonlyMap<string, GroupView>;
  // 真实 server 的 pairingStore 在 listen 前为 null(startSendspinInProcess 稍后挂上),
  // Like 接口必须同为可空 —— 调用方(routes)一律 `?.` 判空。
  readonly pairingStore: {
    getRecord(clientId: string): RecordView | undefined;
    isApproved(clientId: string): boolean;
    setApproved(clientId: string, approved: boolean): Promise<void>;
    removeRecord(clientId: string): Promise<boolean>;
  } | null;
  readonly pairing: {
    listAttempts(): unknown[];
    getAttempt(clientId: string): unknown;
    start(clientId: string, method: string, format?: "digits" | "qr_code"): Promise<void>;
    enterCode(clientId: string, code: string): Promise<void>;
    pairWithToken(clientId: string, token: string): Promise<void>;
    cancel(clientId: string): void;
  } | null;
  dialPlayer(url: string, timeoutMs?: number): Promise<{ clientId: string | null; name: string }>;
  clearNoRedial(host: string, port: number): void;
  group(name: string): GroupView;
  currentMedia(clientId: string): { songId: string; title?: string; artist?: string; album?: string; coverArt?: string } | undefined;
  // 注意:**不含 esphomeStatus** —— 真实 server 无此方法,放进 Like 会破坏 AssertServerLike
  // 哨兵;ESPHome 状态走独立 proxyEsphomeStatus()(fork)/sendspinEsphomeStatus()(装配层)。
}

// ==================== fork 模式实现 ====================

class MirrorConnView implements ConnView {
  constructor(private sup: typeof sendspinSupervisor, private d: { clientId: string; name: string; roles: string[]; legacy: boolean; ready: boolean; remoteHost: string; dialed: boolean; dialHost: string; dialPort: number; volume: number; muted: boolean }) {}
  get clientId() { return this.d.clientId; }
  get name() { return this.d.name; }
  get roles() { return this.d.roles; }
  get legacy() { return this.d.legacy; }
  get ready() { return this.d.ready; }
  get remoteHost() { return this.d.remoteHost; }
  get dialed() { return this.d.dialed; }
  get dialHost() { return this.d.dialHost; }
  get dialPort() { return this.d.dialPort; }
  get volume() { return this.d.volume; }
  /** 静音 setter:镜像即时更新 + RPC 下发(路由 mute 语义,幂等)。 */
  get muted() { return this.d.muted; }
  set muted(v: boolean) {
    this.d.muted = v;
    rpcFireAndForget(this.sup, "setMuted", { clientId: this.d.clientId, muted: v });
  }
}

class MirrorGroupView implements GroupView {
  constructor(private sup: typeof sendspinSupervisor, public name: string, private d: { volume: number; muted: boolean; current: GroupView["current"] }) {}
  get volume() { return this.d.volume; }
  get muted() { return this.d.muted; }
  set muted(v: boolean) {
    this.d.muted = v;
    rpcFireAndForget(this.sup, "setMuted", { clientId: this.name, muted: v });
  }
  get current() { return this.d.current; }
}

class ProxyPairingStore {
  constructor(private sup: typeof sendspinSupervisor) {}
  getRecord(clientId: string): RecordView | undefined {
    const r = this.sup.mirror.records.get(clientId);
    return r ? { clientId: r.clientId, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt } : undefined;
  }
  isApproved(clientId: string): boolean {
    return this.sup.mirror.records.get(clientId)?.approved ?? false;
  }
  async setApproved(clientId: string, approved: boolean): Promise<void> {
    await this.sup.rpc("setApproved", { clientId, approved });
  }
  async removeRecord(clientId: string): Promise<boolean> {
    return this.sup.rpc<boolean>("unpair", { clientId });
  }
}

class ProxyPairing {
  constructor(private sup: typeof sendspinSupervisor) {}
  listAttempts(): unknown[] {
    return this.sup.mirror.attempts;
  }
  getAttempt(clientId: string): unknown {
    return this.sup.mirror.attempts.find((a: any) => a?.clientId === clientId) ?? null;
  }
  async start(clientId: string, method: string, format?: "digits" | "qr_code"): Promise<void> {
    await this.sup.rpc("pairStart", { clientId, method, format });
  }
  async enterCode(clientId: string, code: string): Promise<void> {
    await this.sup.rpc("pairCode", { clientId, code });
  }
  async pairWithToken(clientId: string, token: string): Promise<void> {
    await this.sup.rpc("pairToken", { clientId, token });
  }
  cancel(clientId: string): void {
    rpcFireAndForget(this.sup, "pairCancel", { clientId });
  }
}

class SendspinServerProxy implements SendspinServerLike {
  constructor(private sup: typeof sendspinSupervisor) {}

  get port(): number {
    return this.sup.mirror.port;
  }
  get serverId(): string {
    return this.sup.mirror.serverId;
  }
  get clients(): ReadonlyMap<string, ConnView> {
    const sup = this.sup;
    const out = new Map<string, ConnView>();
    for (const [k, c] of sup.mirror.clients) out.set(k, new MirrorConnView(sup, c));
    return out;
  }
  get groups(): ReadonlyMap<string, GroupView> {
    const sup = this.sup;
    const out = new Map<string, GroupView>();
    for (const [k, g] of sup.mirror.groups) out.set(k, new MirrorGroupView(sup, g.name, g));
    return out;
  }
  get pairingStore() {
    return new ProxyPairingStore(this.sup);
  }
  get pairing() {
    return new ProxyPairing(this.sup);
  }
  async dialPlayer(url: string, timeoutMs?: number) {
    return this.sup.rpc<{ clientId: string | null; name: string }>("dial", { url, timeoutMs }, (timeoutMs ?? 15_000) + 10_000);
  }
  clearNoRedial(host: string, port: number): void {
    rpcFireAndForget(this.sup, "clearNoRedial", { host, port });
  }
  group(name: string): GroupView {
    const g = this.sup.mirror.groups.get(name);
    // 镜像没有的组返回占位(与真实 server 的 group() 懒创建语义一致)。
    return new MirrorGroupView(this.sup, name, g ?? { volume: 100, muted: false, current: null });
  }
  currentMedia(clientId: string) {
    const cur = this.sup.mirror.groups.get(clientId)?.current;
    if (!cur) return undefined;
    return { songId: cur.songId, title: cur.title, artist: cur.artist, album: cur.album, coverArt: cur.coverArt };
  }
}

let proxySingleton: SendspinServerProxy | null = null;

/** 取 sendspin 外观:fork=代理镜像;in-proc=真实 server。未运行返回 null。 */
export function getSendspinFront(inProc: boolean): SendspinServerLike | null {
  if (!inProc) {
    if (!sendspinSupervisor.isRunning()) return null;
    proxySingleton ??= new SendspinServerProxy(sendspinSupervisor);
    return proxySingleton;
  }
  return getServer();
}

/** 代理侧 ESPHome 状态(fork 专用;index.ts 的 sendspinEsphomeStatus() 分模式调用)。
 *  ⚠️ 已无全局开关/密钥/端口 —— 只有逐台的桥接快照(是否连上、设备侧真值音量),
 *  且快照本身不含 PSK。 */
export function proxyEsphomeStatus(): Promise<{ devices: unknown[] }> {
  if (!sendspinSupervisor.isRunning()) {
    return Promise.resolve({ devices: [] });
  }
  return sendspinSupervisor.rpc("esphomeStatus");
}

/** 类型兼容哨兵:真实 SendspinServer 必须满足 SendspinServerLike(编译期验证,
 *  server.ts 结构变动时第一时间在这里爆,而不是路由运行时才炸)。 */
export type AssertServerLike = AssertImplements<SendspinServer, SendspinServerLike>;
