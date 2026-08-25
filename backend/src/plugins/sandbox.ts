// ==================== Plugin sandbox (QuickJS/WASM) ====================
//
// 方案 B:外置插件在独立 QuickJS 虚拟机里运行(quickjs-emscripten,WASM 引擎)。
// 插件代码拿不到 Node 的任何能力 —— 只能用宿主注入的 `host.*` 反向调用后端。
// 权限(permissions)在宿主函数的调用点强制执行,不再只是契约。
//
// 已验证的技术要点(quickjs-emscripten 0.32.0,sync 变体):
//   - 宿主异步函数用 deferred-promise 模式:newFunction 返回 newPromise().handle,
//     原生 promise 结算后 resolve + executePendingJobs 泵送;
//   - 插件调用统一走「信封」:guest promise 永远 resolve 为 {ok,value}|{ok,false,error},
//     宿主永不面对 guest rejection(避免异步变体的 teardown bug);
//   - 值转换:jsToHandle 纯构造(newString/newNumber/newObject/newArray + 共享 null/true/false),
//     禁止在宿主函数执行期间 evalCode(会破坏 wasm 栈);
//   - teardown:runtime.dispose 在宿主注入的 host.* 函数(host-ref 由模块级 Scope 持有)
//     未释放时会触发 QuickJS gc_obj_list 断言(Aborted)。该 abort 可被 try/catch 捕获,
//     但会毒化「共享 WASM module」(后续 newRuntime/newContext 全崩 "null function")。
//     故 dispose() 捕获后标记 module 已损坏,下一个沙箱经 getQuickJS() 重建全新 module,
//     单插件卸载不会拖垮全局沙箱能力,服务永不因插件卸载崩溃。

import { newQuickJSWASMModule, type QuickJSWASMModule } from "quickjs-emscripten";
import type { QuickJSRuntime, QuickJSContext, QuickJSHandle, QuickJSDeferredPromise } from "quickjs-emscripten";
import type { PluginManifest } from "./types.js";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { dirname, join } from "path";

const MEMORY_LIMIT = 256 * 1024 * 1024; // 单插件内存上限 256MB
const STACK_LIMIT = 1024 * 1024;        // 单插件栈上限 1MB
const INVOKE_TIMEOUT_MS = 15000;        // 交互型调用超时(卡死可杀);长耗时方法见 manifest.longRunning
const REBUILD_TIMEOUT_MS = 30000;       // OOM 自愈重建的 init 全程预算:触顶可能已耗尽旧 deadline(15s),
                                        // 重建时若沿用旧 deadline,interrupt handler 会立即中断重建代码
                                        // (CI 实测 rebuild 失败 "interrupted" → 沙箱半死)。重建应给足
                                        // 独立预算(init 加载 stdlib + 插件代码正常 <1s,30s 宽裕且不失控)。
const JOB_TIMEOUT_CAP_MS = 600000;      // longRunning 声明预算上限(10 分钟);任务经 jobRunner 异步执行、HTTP 不阻塞、前端轮询,长预算无副作用
const MAX_DEFERS = 256;                 // 单次调用内未结算 deferred 上限(防御性;支持并行 host 调用)
// 单次 executePendingJobs 最多结算的 job 数:分片泵送,避免「结算风暴」一次连续执行全部
// pending 回调(几百首歌的 host 调用结算累积)同步阻塞宿主主线程。剩余 job 由 evalAsync
// 主循环的下一轮(setImmediate 让行后)继续泵送,功能等价、时序更平滑。
const MAX_JOBS_PER_PUMP = 64;
// longRunning 批量任务采用「软看门狗」:无墙钟硬超时(歌单/封面/歌词数量无限,只要每步
// 都在等网络/DB 就永不超时);仅在「连续该时长无任何 host 调用完成」时判定 CPU 空转/
// 死循环并中断(QuickJS interrupt 只在 guest 真正执行 JS 时触发,await 挂起不计时)。
// 支持 SANDBOX_CPU_IDLE_MS 环境变量覆盖(测试用短值,运行时读取便于用例控制)。
function cpuIdleLimitMs(): number {
  const v = Number(process.env.SANDBOX_CPU_IDLE_MS);
  return Number.isFinite(v) && v > 0 ? v : 60000;
}
// 单插件内存上限(QuickJS setMemoryLimit 硬上限,触顶即 OOM):支持 SANDBOX_MEMORY_LIMIT
// 环境变量覆盖(测试用短值便于触发触顶自愈,运行时读取同 cpuIdleLimitMs 模式)。
function memoryLimitBytes(): number {
  const v = Number(process.env.SANDBOX_MEMORY_LIMIT);
  return Number.isFinite(v) && v > 0 ? v : MEMORY_LIMIT;
}
const MEMORY_LIMIT_MB = MEMORY_LIMIT / 1024 / 1024;
/** 内存超限(OOM)的修复提示:识别后自动重建沙箱,频繁出现指向插件侧 guest 累积。 */
const OOM_HINT = `插件疑似内存泄漏(guest 全局数据跨调用累积,如把搜索结果缓存在模块级变量)。已自动重建沙箱,本次调用失败;若频繁出现请检查插件的全局缓存/累积逻辑`;

/** 沙箱限制类错误:全链路可辨识(稳定错误码 + 中文说明 + 修复提示)。
 *  路由 / jobRunner 透传 sandboxCode/hint 给前端,避免「timeout of 15000ms exceeded」
 *  「HTTP undefined」这类无从排查的裸报错。 */
export class SandboxLimitError extends Error {
  readonly sandboxCode: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "SandboxLimitError";
    this.sandboxCode = code;
    this.hint = hint;
  }
}

// QuickJS 标准库缺失的兼容层(URL / URLSearchParams):插件代码可正常使用,
// 与浏览器/Node 行为保持一致。网络一律走 host.http(自带超时),插件不需要
// fetch / AbortController / setTimeout。
const SANDBOX_STDLIB = `
if (typeof URLSearchParams === "undefined") {
  globalThis.URLSearchParams = class {
    constructor(init) {
      this._p = new Map();
      if (typeof init === "string") {
        const q = init.startsWith("?") ? init.slice(1) : init;
        for (const pair of q.split("&")) {
          if (!pair) continue;
          const eq = pair.indexOf("=");
          const k = eq >= 0 ? pair.slice(0, eq) : pair;
          const v = eq >= 0 ? pair.slice(eq + 1) : "";
          this.append(decodeURIComponent(k.replace(/\\+/g, " ")), decodeURIComponent(v.replace(/\\+/g, " ")));
        }
      } else if (init && typeof init === "object") {
        for (const [k, v] of Object.entries(init)) this.append(k, v);
      }
    }
    append(k, v) { const key = String(k); if (!this._p.has(key)) this._p.set(key, []); this._p.get(key).push(String(v)); }
    set(k, v) { this._p.set(String(k), [String(v)]); }
    get(k) { const a = this._p.get(String(k)); return a && a.length ? a[0] : null; }
    has(k) { return this._p.has(String(k)); }
    delete(k) { this._p.delete(String(k)); }
    entries() { const out = []; for (const [k, vs] of this._p) for (const v of vs) out.push([k, v]); return out[Symbol.iterator](); }
    toString() { const parts = []; for (const [k, vs] of this._p) for (const v of vs) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); return parts.join("&"); }
  };
}
if (typeof URL === "undefined") {
  globalThis.URL = class {
    constructor(url) {
      const s = String(url);
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(s);
      if (!m) throw new Error("URL parse error: " + s);
      this.protocol = m[1] + ":";
      this.host = m[2];
      this.pathname = m[3];
      this.search = m[4] || "";
      this.searchParams = new URLSearchParams(this.search);
    }
    toString() {
      const q = this.searchParams.toString();
      this.search = q ? "?" + q : "";
      return this.protocol + "//" + this.host + this.pathname + this.search;
    }
  };
}
if (typeof btoa === "undefined") {
  const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  globalThis.btoa = function (str) {
    const b = String(str);
    let out = "";
    for (let i = 0; i < b.length; i += 3) {
      const c1 = b.charCodeAt(i) & 0xff;
      const c2 = i + 1 < b.length ? b.charCodeAt(i + 1) & 0xff : 0;
      const c3 = i + 2 < b.length ? b.charCodeAt(i + 2) & 0xff : 0;
      out += _B64[c1 >> 2] + _B64[((c1 & 3) << 4) | (c2 >> 4)] + (i + 1 < b.length ? _B64[((c2 & 15) << 2) | (c3 >> 6)] : "=") + (i + 2 < b.length ? _B64[c3 & 63] : "=");
    }
    return out;
  };
  globalThis.atob = function (str) {
    const s = String(str).replace(/=+$/, "");
    let out = "";
    for (let i = 0; i < s.length; i += 4) {
      const n = (_B64.indexOf(s[i]) << 18) | (_B64.indexOf(s[i + 1]) << 12) | (_B64.indexOf(s[i + 2]) << 6) | _B64.indexOf(s[i + 3]);
      out += String.fromCharCode((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    }
    return out.slice(0, Math.floor(s.length * 3 / 4));
  };
}
`;

// 同步方法:core 同步取值(不能返回 Promise)。插件契约要求这些方法纯同步。
const SYNC_METHODS = new Set(["streamUrl", "lyricUrl", "canHandle", "canHandleFile"]);
// core 以 (host, ...) 调用、但沙箱插件用自己 host.* 的方法 → 剥掉第一个 host 参数。
const STRIP_HOST_FIRST = new Set(["searchLyrics", "searchCover", "onPlay", "onScrobble"]);

// capability → 需要暴露的 impl 方法(在 VM 内调用)。
const CAP_METHODS: Record<string, string[]> = {
  search: ["search"],
  playlistSearch: ["searchPlaylists"],
  songSearch: ["searchSongs"],
  artistSearch: ["searchArtists"],
  albumSearch: ["searchAlbums"],
  recommend: ["recommend"],
  playlistSongs: ["playlistSongs"],
  stream: ["streamUrl"],
  autoMatch: ["search"],
  lyricProvider: ["searchLyrics"],
  coverProvider: ["searchCover"],
  scrobbler: ["onPlay", "onScrobble"],
  artistInfo: ["fetchArtistInfo"],
  playlistImport: ["canHandle", "fetchPlaylist"],
  playlistFile: ["canHandleFile", "parseFile"],
  dailyPlaylist: ["runDailyJob"],
  localPlaylist: ["runDailyJob"],
  recommendPlaylist: ["runDailyJob"],
  playlistSync: ["runSyncJob"],
};
// source 插件额外暴露 test(连线探测)
const EXTRA_METHODS = new Set(["test"]);

/** 宿主提供给沙箱的环境:副作用全部由宿主实现,沙箱只转发参数/结果。 */
export interface SandboxHostEnv {
  version: string;
  /** 每次调用前刷新(host.config 属性指向最新的插件配置)。 */
  getConfig(): Record<string, any>;
  /** 权限白名单(manifest.permissions)。 */
  permissions: string[];
  /** host.http:发起 HTTP 请求,返回 { ok, status, headers, body } 信封。 */
  http(input: string, init?: any): Promise<any>;
  /** host.crypto:纯同步工具(需 crypto 权限)。MD5 hex(Last.fm api_sig 等签名需要)。 */
  crypto: {
    md5(input: string): string;
  };
  /** host.storage:按插件隔离的 KV(与 host.ts PluginStorage 同契约,异步)。 */
  storage: {
    get(key: string): Promise<any | null>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  log(...args: any[]): void;
  /** host.comm:插件间消息(与 comm.ts CommTarget 同契约)。 */
  comm: {
    send(targetId: string, message: any): void;
    broadcast(message: any): void;
    on(handler: (message: any) => void): void;
    off?(handler: (message: any) => void): void;
  };
  /** host.songs:宿主曲库只读查询(需 songs:read 权限)。返回脱敏视图,不含内部字段。 */
  songs: {
    list(options?: { limit?: number; offset?: number }): Promise<any[]>;
    search(query: string, options?: { limit?: number }): Promise<any[]>;
    getById(id: string): Promise<any | null>;
  };
  /** host.plugin:宿主身份/地址信息(只读,低敏感,无需权限)。 */
  plugin: {
    getHostUrl(): Promise<string>;
    getNetworkAddresses(): Promise<string[]>;
  };
  /** host.fs:插件专属目录(<data>/plugins/<id>/files)内文件读写(需 fs 权限,防路径穿越)。 */
  fs: {
    readFile(path: string, encoding?: string): Promise<string>;
    writeFile(path: string, data: string, encoding?: string): Promise<null>;
    appendFile(path: string, data: string, encoding?: string): Promise<null>;
    readdir(path: string): Promise<string[]>;
    unlink(path: string): Promise<null>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<null>;
    stat(path: string): Promise<any | null>;
    rename(oldPath: string, newPath: string): Promise<null>;
  };
  /** host.command:执行外部命令(需 command 权限)。exec 用 execFile 不经 shell;start/stop 管理常驻进程。 */
  command: {
    exec(program: string, args?: string[], options?: any): Promise<any>;
    start(name: string, program: string, args?: string[]): Promise<any>;
    stop(name: string): Promise<null>;
    isRunning(name: string): Promise<boolean>;
  };
  /** host.net:原始 UDP/TCP socket(需 net 权限)。事件回调经 onData/onClose 推回 VM。 */
  net: {
    udpBind(options?: any): Promise<any>;
    udpSend(socketId: string, data: string, addr?: any): Promise<null>;
    udpClose(socketId: string): Promise<null>;
    udpOnData(socketId: string, handler: (data: any) => void): void;
    tcpConnect(host: string, port: number, options?: any): Promise<any>;
    tcpSend(socketId: string, data: string): Promise<null>;
    tcpClose(socketId: string): Promise<null>;
    tcpOnData(socketId: string, handler: (data: any) => void): void;
    tcpOnClose(socketId: string, handler: () => void): void;
  };
  /** host.ws:WebSocket 客户端(需 websocket 权限)。 */
  ws: {
    connect(url: string, options?: any): Promise<any>;
    wsSend(socketId: string, data: string): Promise<null>;
    wsClose(socketId: string): Promise<null>;
    wsOnMessage(socketId: string, handler: (data: any) => void): void;
    wsOnClose(socketId: string, handler: (code: number, reason: string) => void): void;
  };
  /** host.jsenv:嵌套 QuickJS 子环境跑隔离脚本(需 jsenv 权限)。 */
  jsenv: {
    create(name: string, initCode?: string): Promise<string>;
    execute(name: string, code: string): Promise<any>;
    destroy(name: string): Promise<null>;
  };
  /** host.playlists:受控写推荐歌单(需 playlists:write 权限)。外置推荐插件用
   *  它生成/更新自己的固定歌单;权限门控在 sandbox 调用点(hostAsync)完成。
   *  opts.sourcePlatform / opts.sourceUrl:可选的平台标签(如 "netease"/"qq")与
   *  来源标记,写入 playlists.source_platform / source_url——前端据此显示平台徽标。
   *  opts.externalId:远端平台歌单 ID,配合 findBySource 用于去重判断。 */
  playlists: {
    upsert(playlistId: string, opts: { name?: string; description?: string; entries?: any[]; coverSongId?: string; sourcePlatform?: string; sourceUrl?: string; externalId?: string }): Promise<any>;
    get(playlistId: string): Promise<any | null>;
    replaceEntries(playlistId: string, entries: any[]): Promise<any>;
    updateCover(playlistId: string, coverSongId: string): Promise<any>;
    /** 按 sourcePlatform + externalId 查找已入库歌单,用于关键词搜索导入去重。 */
    findBySource(sourcePlatform: string, externalId: string): Promise<any | null>;
  };
  /** host.sources:在线源补全(需 songs:write 权限)。把匹配不到本地的曲目交给
   *  已启用的 source 插件搜索并导入为可播本地 song,返回 songId。 */
  sources: {
    complete(opts: { artist?: string; title?: string }): Promise<{ songId: string | null }>;
  };
}

let moduleSingleton: Promise<QuickJSWASMModule> | null = null;
/** 共享 WASM module 是否已被某次 runtime.dispose() 的 QuickJS teardown 断言毒化。
 *  一旦毒化,所有后续 newRuntime/newContext 都会 "null function" / "table index out of
 *  bounds",必须丢弃并重新加载一份全新的 module(见 getQuickJS)。 */
let modulePoisoned = false;
function markModulePoisoned(): void {
  modulePoisoned = true;
}
function getQuickJS(): Promise<QuickJSWASMModule> {
  if (!moduleSingleton || modulePoisoned) {
    modulePoisoned = false;
    moduleSingleton = newQuickJSWASMModule();
  }
  return moduleSingleton;
}
/** 共享 QuickJS WASM 模块(供 jsenv 嵌套子环境等复用,避免重复加载 WASM)。 */
export function getSandboxModule(): Promise<QuickJSWASMModule> {
  return getQuickJS();
}

export class SandboxedPlugin {
  readonly id: string;
  manifest!: PluginManifest;
  private env: SandboxHostEnv;
  private runtime!: QuickJSRuntime;
  private ctx!: QuickJSContext;
  private shared = new Set<QuickJSHandle>();
  private hTrue!: QuickJSHandle;
  private hFalse!: QuickJSHandle;
  private defers: QuickJSDeferredPromise[] = [];
  /** host.comm.on 注册的监听器包装(注册在 env.comm 上)。dispose 时必须 off,否则 hot-reload 重载插件会累积监听器,导致同一条消息被重复投递 N 次。 */
  private commListeners = new Map<QuickJSHandle, (message: any) => void>();
  private deadline = Date.now() + INVOKE_TIMEOUT_MS;
  /** 软看门狗状态:最近一次 host 调用完成时间(CPU 空转检测基准)、当前调用是否
   *  longRunning(interrupt 按此选检测方式)、是否因 CPU 空转被杀(错误分类用)。 */
  private lastHostProgressAt = Date.now();
  private currentIsLong = false;
  private cpuKilled = false;
  private disposed = false;
  /** 自愈重建(内存超限后):dispose + 重新 init。init 入参缓存在此,重建无需上层重新读盘。 */
  private initCode: string | null = null;
  private initManifest: PluginManifest | undefined;
  /** 重建进行中标志:init 是异步的,重建期间拒绝并发调用(防访问已 dispose 的 ctx/runtime)。 */
  private rebuilding = false;
  /** 内存超限标志:置位后 dispose() 先解除限制+触发 GC 再销毁(见 dispose 注释),避免毒化 WASM module。 */
  private oomFaulty = false;
  /** 批量 worker 代理(longRunning 方法执行线程);attachWorker 挂接,dispose 联动销毁。 */
  private workerRemote: SandboxedPluginRemote | null = null;

  constructor(id: string, env: SandboxHostEnv) {
    this.id = id;
    this.env = env;
  }

  // ---------- 生命周期 ----------

  /** 创建 VM → 注入 host.* → 运行插件代码 → 校验 manifest → 调 create(host) 拿 impl。
   *  @param expectedManifest 可选:plugin.json 里的 manifest,与 VM 内 __mfPlugin.manifest 比对。 */
  async init(code: string, expectedManifest?: PluginManifest): Promise<void> {
    // 缓存 init 入参,供内存超限后自愈重建(rebuild)使用;不随首次加载失败而丢失(init 失败路径 dispose 但不清缓存)。
    this.initCode = code;
    this.initManifest = expectedManifest;
    const module = await getQuickJS();
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(memoryLimitBytes());
    this.runtime.setMaxStackSize(STACK_LIMIT);
    this.runtime.setInterruptHandler(() => {
      // 长耗时批量任务:软看门狗——只杀 CPU 空转(连续 JOB_CPU_IDLE_LIMIT_MS 无任何
      // host 调用完成 = 死循环/超重计算);等网络/DB(await 挂起)期间 guest 不执行
      // JS,interrupt 不触发,不计时 → 无限等待合法(歌单/封面/歌词数量不限)。
      if (this.currentIsLong) {
        if (this.cpuKilled) return true;
        if (Date.now() - this.lastHostProgressAt > cpuIdleLimitMs()) {
          this.cpuKilled = true;
          return true;
        }
        return false;
      }
      // 交互型调用:维持墙钟 15s 看门狗(用户等一个搜索/歌词不该无限等待)。
      return Date.now() > this.deadline;
    });

    this.ctx = this.runtime.newContext();
    this.hTrue = this.ctx.unwrapResult(this.ctx.evalCode("true"));
    this.hFalse = this.ctx.unwrapResult(this.ctx.evalCode("false"));
    this.shared.add(this.ctx.null);
    this.shared.add(this.hTrue);
    this.shared.add(this.hFalse);

    // 0. 注入 QuickJS 缺失的兼容层(URL/URLSearchParams)
    const std = this.ctx.evalCode(SANDBOX_STDLIB);
    if (std.error !== undefined) {
      const e = this.ctx.dump(std.error);
      std.error.dispose();
      this.dispose();
      throw new SandboxLimitError("SANDBOX_VM", `沙箱限制:stdlib 注入失败,原因: ${e}`);
    }
    this.ctx.unwrapResult(std).dispose();

    // 1. 运行插件代码 → globalThis.__mfPlugin
    const reg = this.ctx.evalCode(code);
    if (reg.error !== undefined) {
      const e = this.ctx.dump(reg.error);
      reg.error.dispose();
      this.dispose();
      throw new SandboxLimitError("SANDBOX_VM", `沙箱限制:插件 ${this.id} 语法/加载错误,原因: ${e}`);
    }
    this.ctx.unwrapResult(reg).dispose();

    // 2. 读取并校验 manifest
    const pluginHandle = this.ctx.getProp(this.ctx.global, "__mfPlugin");
    if (!this.ctx.typeof(pluginHandle) || !["object", "function"].includes(this.ctx.typeof(pluginHandle))) {
      pluginHandle.dispose();
      this.dispose();
      throw new Error(`插件 ${this.id} 未定义 globalThis.__mfPlugin`);
    }
    const mHandle = this.ctx.getProp(pluginHandle, "manifest");
    const vmManifest = this.ctx.dump(mHandle) as PluginManifest;
    mHandle.dispose();
    if (!vmManifest || typeof vmManifest.id !== "string") {
      pluginHandle.dispose();
      this.dispose();
      throw new Error(`插件 ${this.id} 的 __mfPlugin.manifest 缺失`);
    }
    if (vmManifest.id !== this.id) {
      pluginHandle.dispose();
      this.dispose();
      throw new Error(`插件 ${this.id}: manifest.id(${vmManifest.id}) 与目录名不一致`);
    }
    if (expectedManifest && (expectedManifest.id !== vmManifest.id || expectedManifest.version !== vmManifest.version)) {
      pluginHandle.dispose();
      this.dispose();
      throw new Error(`插件 ${this.id} 的 index.js manifest 与 plugin.json 不一致(js=${vmManifest.version}, json=${expectedManifest.version})`);
    }
    this.manifest = vmManifest;

    // 3. 注入 host.* 对象并调用 create(host)
    this.injectHost();
    const hostHandle = this.ctx.getProp(this.ctx.global, "__mfHost");
    const createFn = this.ctx.getProp(pluginHandle, "create");
    const implResult = this.ctx.callFunction(createFn, this.ctx.undefined, hostHandle);
    createFn.dispose();
    hostHandle.dispose();
    if (implResult.error !== undefined) {
      const e = this.ctx.dump(implResult.error);
      implResult.error.dispose();
      this.dispose();
      const msg = e && typeof e === "object" ? (e.message || e.name || JSON.stringify(e)) : String(e);
      throw new Error(`插件 ${this.id} create() 失败: ${msg}`);
    }
    const implHandle = this.ctx.unwrapResult(implResult);
    this.ctx.setProp(this.ctx.global, "__mfImpl", implHandle);
    implHandle.dispose();
    pluginHandle.dispose();
  }

  /** 当前插件在 VM 里实现了哪些方法(用于 facade 只暴露存在的)。 */
  presentMethods(): Set<string> {
    const r = this.ctx.evalCode(`JSON.stringify(Object.keys(globalThis.__mfImpl || {}))`);
    if (r.error !== undefined) { r.error.dispose(); return new Set(); }
    const vh = this.ctx.unwrapResult(r);
    const v = this.ctx.dump(vh) as string;
    vh.dispose();
    try { return new Set(JSON.parse(v)); } catch { return new Set(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.workerRemote?.dispose(); } catch { /* ignore */ }
    // 先移除 host.comm.on 注册的监听器,避免 hot-reload 累积导致消息重复投递
    for (const listener of this.commListeners.values()) {
      try { this.env.comm.off?.(listener); } catch { /* ignore */ }
    }
    this.commListeners.clear();
    for (const d of this.defers) { try { if (d.alive) d.dispose(); } catch { /* ignore */ } }
    this.defers = [];
    for (const h of [this.hTrue, this.hFalse]) { try { if (h.alive) h.dispose(); } catch { /* ignore */ } }
    // 内存超限(OOM)后的 runtime 处于「malloc 超限」状态,直接 dispose 会触发 QuickJS
    // gc_obj_list 断言(Aborted)把 WASM function table 打坏(实测后续 newContext 全崩
    // "RuntimeError: null function")。先走 oomCleanup(解除限制+禁用 interrupt+触发 GC
    // 清空对象列表),dispose 恢复安全(实测连续多次 OOM 自愈均干净、module 不毒化)。
    if (this.oomFaulty && this.runtime) this.oomCleanup();
    try { this.ctx?.dispose(); } catch { /* ignore */ }
    // 兜底:QuickJS teardown 断言(gc_obj_list 非空)若仍发生(如某插件/宿主侧句柄泄漏),
    // 该 abort 会永久毒化「共享 WASM module」(后续 newRuntime/newContext 全崩
    // "null function" / "table index out of bounds")。捕获后标记 module 已损坏,下一个
    // 沙箱会用全新 module 重建(见 getQuickJS),避免单个插件卸载拖垮全局沙箱能力。
    try { this.runtime?.dispose(); } catch { markModulePoisoned(); }
  }

  /** OOM 后清理 runtime:① 解除内存限制(否则任何分配都抛 OOM);② 禁用 interrupt handler
   *   (否则 deadline 已过 → evalCode 一执行就被 interrupt 中断,GC 代码跑不完);
   *   ③ 触发一次小分配驱动 QuickJS 周期 GC 清空 gc_obj_list,dispose 不再断言失败。 */
  private oomCleanup(): void {
    try { this.runtime.setMemoryLimit(-1); } catch { /* ignore */ }
    try { this.runtime.setInterruptHandler(() => false); } catch { /* ignore */ }
    try {
      this.ctx?.evalCode(
        `let __mfGc__ = []; for (let __mfI__ = 0; __mfI__ < 128; __mfI__++) __mfGc__.push({ __mfS__: "y".repeat(2048) }); __mfGc__ = null; 1;`
      );
    } catch { /* ignore */ }
  }

  /** 挂接批量 worker 代理(dispose 时一并销毁)。 */
  attachWorker(worker: SandboxedPluginRemote): void {
    this.workerRemote = worker;
  }

  /** 调用前守卫:沙箱已销毁或重建进行中时拒绝执行(防访问已释放的 ctx/runtime 崩溃)。 */
  private assertUsable(): void {
    if (this.disposed) throw new Error(`插件 ${this.id} 沙箱不可用(已销毁)`);
    if (this.rebuilding) throw new Error(`插件 ${this.id} 沙箱重建中,请重试`);
  }

  /** 自愈重建:销毁当前 VM 后用缓存的 init 入参重建全新 runtime。
   *   impl 门面(makeImpl 产物)闭包引用本实例的 invoke/this,重建后无需重新注册。
   *   注意:dispose 会一并销毁批量 worker(workerRemote),重建后 longRunning 方法回退
   *   主线程执行(既有合法回退路径);shared 句柄集合整体重建,防旧句柄残留累积。 */
  async rebuild(): Promise<void> {
    if (this.rebuilding) return;
    const code = this.initCode;
    if (!code) return;
    const manifest = this.initManifest;
    this.rebuilding = true;
    try {
      // 内存超限后 runtime.dispose() 会抛 QuickJS gc 断言异常(实测 abort 可捕获),
      // dispose 内部已 try/catch 吞掉;全新 init 不受旧 runtime 状态影响。
      // 关键:OOM 触顶可能已耗尽旧 deadline(默认 15s),init() 会重新设置 interrupt
      // handler(Date.now() > this.deadline),若沿用旧 deadline,重建代码一执行就被
      // 中断 → rebuild 失败 "interrupted" → 沙箱半死(CI 实测)。重置 deadline 给
      // 重建独立预算(REBUILD_TIMEOUT_MS),init 全程不被看门狗打断。
      this.deadline = Date.now() + REBUILD_TIMEOUT_MS;
      this.dispose();
      this.disposed = false;
      this.oomFaulty = false;
      this.shared = new Set<QuickJSHandle>();
      await this.init(code, manifest);
    } catch (e) {
      // init 失败:沙箱保持已销毁状态,后续调用被 assertUsable 拦截,
      // 避免「半死沙箱」访问未就绪的 __mfImpl 等全局导致 cannot read property 类崩溃。
      this.disposed = true;
      throw e;
    } finally {
      this.rebuilding = false;
    }
  }

  /** 识别 QuickJS 内存超限错误(实测:guest 抛 InternalError "out of memory",invoke 信封 message 即此)。 */
  private isOomMessage(msg: unknown): boolean {
    const s = String(msg || "");
    return /out of memory/i.test(s) || /OutOfMemory/i.test(s) || /cannot allocate/i.test(s);
  }

  /** 异步上下文 OOM 处理:打日志 → 自愈重建(await 完成后再抛)→ 抛 SANDBOX_MEMORY。
   *   rebuild 失败(如插件 create() 依赖异常状态)时沙箱保持已销毁,后续调用被 assertUsable 拦截。 */
  private async handleOom(method?: string): Promise<never> {
    console.error(`[PLUGIN:${this.id}]${method ? " " + method + "()" : ""} 内存超限(> ${MEMORY_LIMIT_MB}MB),自动重建沙箱`);
    this.oomFaulty = true;
    try {
      await this.rebuild();
      console.warn(`[PLUGIN:${this.id}] 沙箱已重建,后续调用生效`);
    } catch (e: any) {
      console.error(`[PLUGIN:${this.id}] 沙箱重建失败,该插件暂不可用: ${e?.message || e}`);
    }
    throw new SandboxLimitError("SANDBOX_MEMORY", `沙箱限制:插件 ${this.id} 内存超限(${MEMORY_LIMIT_MB}MB),已自动重建沙箱`, OOM_HINT);
  }

  /** 同步上下文 OOM 处理(invokeSync 是同步方法,rebuild 为异步 → fire-and-forget;
   *   重建期间并发调用被 assertUsable 的 rebuilding 标志拦截)。 */
  private handleOomSync(method?: string): never {
    console.error(`[PLUGIN:${this.id}]${method ? " " + method + "()" : ""} 内存超限(> ${MEMORY_LIMIT_MB}MB),自动重建沙箱`);
    this.oomFaulty = true;
    void this.rebuild();
    throw new SandboxLimitError("SANDBOX_MEMORY", `沙箱限制:插件 ${this.id} 内存超限(${MEMORY_LIMIT_MB}MB),已自动重建沙箱`, OOM_HINT);
  }

  // ---------- 宿主 host.* 注入 ----------

  private hasPerm(perm: string): boolean {
    const perms = this.env.permissions || [];
    if (perms.includes(perm) || perms.includes("*")) return true;
    if (perm.includes(":")) {
      const ns = perm.split(":")[0];
      if (perms.includes(`${ns}.*`)) return true;
    }
    return false;
  }

  private jsToHandle(value: any): QuickJSHandle {
    if (value === null || value === undefined) return this.ctx.null;
    const t = typeof value;
    if (t === "boolean") return value ? this.hTrue : this.hFalse;
    if (t === "string") return this.ctx.newString(value);
    if (t === "number") return this.ctx.newNumber(value);
    if (Array.isArray(value)) {
      const arr = this.ctx.newArray();
      value.forEach((item, i) => { const h = this.jsToHandle(item); this.ctx.setProp(arr, i, h); this.safeDispose(h); });
      return arr;
    }
    const obj = this.ctx.newObject();
    for (const [k, v] of Object.entries(value)) {
      const vh = this.jsToHandle(v);
      this.ctx.setProp(obj, k, vh);
      this.safeDispose(vh);
    }
    return obj;
  }

  private safeDispose(h: QuickJSHandle): void {
    if (h && !this.shared.has(h)) { try { h.dispose(); } catch { /* ignore */ } }
  }

  /** 从在途清单移除已结算的 deferred(避免 defers 数组只增不减导致误限流)。 */
  private removeDefer(d: QuickJSDeferredPromise): void {
    const i = this.defers.indexOf(d);
    if (i >= 0) this.defers.splice(i, 1);
    // host 调用结算(成功/失败/拒绝)即视为任务有进展:重置 CPU 空转基准。
    // 批量任务只要持续有网络/DB 调用完成,就永不触发软看门狗。
    this.lastHostProgressAt = Date.now();
  }

  /** 宿主异常兜底信封:必须带 status 字段,否则插件读 r.status 得 undefined
   *  (表现为 "HTTP undefined" 这类无从排查的报错)。补 status:0 + 真实原因。 */
  private hostErrorEnvelope(message: string, name = "HostError"): any {
    return { ok: false, status: 0, error: { name, message } };
  }

  /** 分片泵送:单次最多结算 MAX_JOBS_PER_PUMP 个 pending job,避免同步段长时间占用宿主主线程。
   *  剩余 job 由 evalAsync 主循环(setImmediate 让行)继续泵送;宿主事件派发点同样限次。 */
  private pumpJobs(): void {
    if (this.runtime?.alive) this.runtime.executePendingJobs(MAX_JOBS_PER_PUMP);
  }

  /** 宿主异步函数:deferred-promise 模式。返回 VM promise handle。 */
  private hostAsync(name: string, impl: (...args: any[]) => Promise<any>, perm: string | null): QuickJSHandle {
    const fn = this.ctx.newFunction(name, (...argHandles: QuickJSHandle[]) => {
      const args = argHandles.map((h) => this.ctx.dump(h));
      const deferred = this.ctx.newPromise();
      this.defers.push(deferred);
      // 仅当「同时未结算」(in-flight)的 host 调用数超上限才拒绝,防御失控并发。
      // 关键:defers 必须只统计在途请求——每次结算后由 finally 移除(见 removeDefer),
      // 否则它会随插件整个生命周期只增不减;累计约 MAX_DEFERS 次调用后就永久误报
      // "调用过于密集,拒绝新请求",使搜索/歌词/封面等长跑功能间歇性全部失败。
      if (this.defers.length > MAX_DEFERS) {
        this.removeDefer(deferred);
        const msg = `[SANDBOX_CONCURRENCY] 沙箱限制:并发宿主调用过多(在途 ${this.defers.length} > 上限 ${MAX_DEFERS})。插件应降低并行度或分批串行`;
        deferred.resolve(this.jsToHandle({ ok: false, error: { message: msg } }));
        // 极少触发的分支:先泵送结算,再延后一拍释放 handle,避免 VM 尚未读取就被 dispose
        try { this.pumpJobs(); } catch { /* ignore */ }
        Promise.resolve().then(() => { try { deferred.dispose(); } catch { /* ignore */ } });
        return deferred.handle;
      }
      Promise.resolve()
        .then(() => {
          if (perm && !this.hasPerm(perm)) {
            // 权限拒绝要打日志:否则容器日志完全静默,前端只看到 HTTP undefined
            // 之类无从排查的报错(如 plugin.json 缺 permissions 时 host.http 被拒)。
            console.warn(`[PLUGIN:${this.id}] host.${name} 权限拒绝: ${perm} (permissions=${JSON.stringify(this.env.permissions || [])})`);
            return { ok: false, error: { message: `[SANDBOX_PERMISSION] 沙箱限制:权限不足(缺少 ${perm})。请确认插件 manifest 已声明所需权限` } };
          }
          return impl(...args);
        })
        .then((value) => {
          if (deferred.alive) {
            // raw-handle 通道:impl 返回 { __mfRawHandle } 时直接 resolve 该 handle
            // (用于 tcpConnect / ws.connect 这类需要返回「含函数对象」的场景)。
            const raw = value && (value as any).__mfRawHandle;
            if (raw) { deferred.resolve(raw); try { raw.dispose(); } catch { /* ignore */ } }
            else deferred.resolve(this.jsToHandle(value));
          }
        })
        .catch((err) => {
          const msg = String((err && err.message) || err);
          // 任何宿主侧实现抛出都到此兜底:服务端记真实错误便于排查(plugin id + 方法 + 所需权限),
          // 同时给插件一个带 status:0 的透明信封,使其能读出真实原因而非 undefined。
          console.error(`[PLUGIN:${this.id}] host.${name} 执行异常: ${msg}${perm ? ` (需权限 ${perm})` : ""}`);
          if (deferred.alive) deferred.resolve(this.jsToHandle(this.hostErrorEnvelope(msg)));
        })
        .finally(() => {
          this.removeDefer(deferred);
          try { this.pumpJobs(); } catch { /* ignore */ }
          try { deferred.dispose(); } catch { /* ignore */ }
        });
      return deferred.handle;
    });
    return fn;
  }

  /** 宿主同步函数(返回 handle;仅用于纯同步能力如 storage)。 */
  private hostSync(name: string, impl: (...args: any[]) => any, perm: string | null): QuickJSHandle {
    const fn = this.ctx.newFunction(name, (...argHandles: QuickJSHandle[]) => {
      const args = argHandles.map((h) => this.ctx.dump(h));
      if (perm && !this.hasPerm(perm)) {
        console.warn(`[PLUGIN:${this.id}] host.${name} 权限拒绝: ${perm} (permissions=${JSON.stringify(this.env.permissions || [])})`);
        return this.jsToHandle({ error: `[SANDBOX_PERMISSION] 沙箱限制:权限不足(缺少 ${perm})。请确认插件 manifest 已声明所需权限` });
      }
      try {
        return this.jsToHandle(impl(...args));
      } catch (e) {
        return this.jsToHandle({ error: String((e && (e as any).message) || e) });
      }
    });
    return fn;
  }

  private injectHost(): void {
    const c = this.ctx;
    // host.http(委托宿主 env.http,便于测试 mock 与宿主统一封装)。
    // 统一在此记录失败(超时/DNS 解析失败/非 2xx),否则容器日志静默、真因无法定位。
    const httpFn = this.hostAsync("http", async (input: any, init: any) => {
      const url = String(input);
      try {
        const r = await this.env.http(url, init || {});
        if (r.ok === false && (r.status === 0 || (typeof r.status === "number" && r.status >= 400))) {
          console.warn(`[PLUGIN:${this.id}] host.http 失败 ${r.status} ${url}${r.error ? " (" + String(r.error) + ")" : ""}`);
        }
        return r;
      } catch (e: any) {
        console.error(`[PLUGIN:${this.id}] host.http 异常 ${url} -> ${e?.message || e}`);
        throw e;
      }
    }, "net");

    // host.storage(异步,与 host.ts PluginStorage 同契约)
    const storageObj = c.newObject();
    const storageGet = this.hostAsync("get", (k: string) => this.env.storage.get(String(k)), "storage");
    const storageSet = this.hostAsync("set", async (k: string, v: any) => { await this.env.storage.set(String(k), v); return null; }, "storage");
    const storageDelete = this.hostAsync("delete", async (k: string) => { await this.env.storage.delete(String(k)); return null; }, "storage");
    const storageKeys = this.hostAsync("keys", () => this.env.storage.keys(), "storage");
    c.setProp(storageObj, "get", storageGet);
    c.setProp(storageObj, "set", storageSet);
    c.setProp(storageObj, "delete", storageDelete);
    c.setProp(storageObj, "keys", storageKeys);
    storageGet.dispose(); storageSet.dispose(); storageDelete.dispose(); storageKeys.dispose();

    // host.comm(与 comm.ts CommTarget 同契约:send/broadcast/on)
    const commObj = c.newObject();
    const commSend = this.hostAsync("send", async (target, message) => { this.env.comm.send(String(target), message); return null; }, "inter-plugin");
    const commBroadcast = this.hostAsync("broadcast", async (message) => { this.env.comm.broadcast(message); return null; }, "inter-plugin");
    c.setProp(commObj, "send", commSend);
    c.setProp(commObj, "broadcast", commBroadcast);
    commSend.dispose(); commBroadcast.dispose();
    // host.comm.on(handler):插件侧注册的 VM 函数 → 收到消息时经信封调用(防异常扩散)
    // 关键:必须把注册的闭包存进 commListeners,dispose 时调 env.comm.off 移除,否则
    // hot-reload 重载插件会累积监听器,导致同一条消息被重复投递 N 次(累计型隐患)。
    const commOn = c.newFunction("on", (handlerHandle: QuickJSHandle) => {
      const listener = (message: any) => {
        if (this.disposed || !this.ctx || !this.runtime?.alive) return;
        try {
          const payload = JSON.stringify(message === undefined ? null : message);
          const code = `(async () => { try { const h = globalThis.__mfCommOn; if (typeof h !== "function") return; await h(${payload}); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
          const r = this.ctx.evalCode(code);
          if (r.error !== undefined) { r.error.dispose(); return; }
          const ph = this.ctx.unwrapResult(r);
          const rp = this.ctx.resolvePromise(ph);
          rp.then(() => { try { ph.dispose(); } catch { /* ignore */ } }, () => { try { ph.dispose(); } catch { /* ignore */ } });
          this.pumpJobs();
        } catch { /* 消息回调异常不影响宿主 */ }
      };
      this.env.comm.on(listener);
      this.commListeners.set(handlerHandle, listener);
      this.ctx.setProp(this.ctx.global, "__mfCommOn", handlerHandle);
      return this.ctx.undefined;
    });
    // host.comm.off(handler):按 VM 函数引用移除监听器(配对 on)。
    const commOff = c.newFunction("off", (handlerHandle: QuickJSHandle) => {
      const listener = this.commListeners.get(handlerHandle);
      if (listener) {
        try { this.env.comm.off?.(listener); } catch { /* ignore */ }
        this.commListeners.delete(handlerHandle);
      }
      return this.ctx.undefined;
    });
    c.setProp(commObj, "on", commOn);
    c.setProp(commObj, "off", commOff);
    commOn.dispose(); commOff.dispose();

    // host.log(无需权限)
    const logFn = c.newFunction("log", (...args: QuickJSHandle[]) => {
      this.env.log(...args.map((h) => c.dump(h)));
      return c.undefined;
    });

    // host.songs(曲库只读查询,需 songs:read;支持 songs:* 通配)
    const songsObj = c.newObject();
    const songsList = this.hostAsync("list", (options: any) => this.env.songs.list(options || {}), "songs:read");
    const songsSearch = this.hostAsync("search", (query: any, options: any) => this.env.songs.search(String(query ?? ""), options || {}), "songs:read");
    const songsGetById = this.hostAsync("getById", (id: any) => this.env.songs.getById(String(id)), "songs:read");
    c.setProp(songsObj, "list", songsList);
    c.setProp(songsObj, "search", songsSearch);
    c.setProp(songsObj, "getById", songsGetById);
    songsList.dispose(); songsSearch.dispose(); songsGetById.dispose();

    // host.plugin(宿主身份/地址,只读低敏,无需权限)
    const pluginObj = c.newObject();
    const pluginGetHostUrl = this.hostAsync("getHostUrl", () => this.env.plugin.getHostUrl(), null);
    const pluginGetAddresses = this.hostAsync("getNetworkAddresses", () => this.env.plugin.getNetworkAddresses(), null);
    c.setProp(pluginObj, "getHostUrl", pluginGetHostUrl);
    c.setProp(pluginObj, "getNetworkAddresses", pluginGetAddresses);
    pluginGetHostUrl.dispose(); pluginGetAddresses.dispose();

    // host.playlists(受控写,需 playlists:write)
    const playlistsObj = c.newObject();
    const plUpsert = this.hostAsync("upsert", (playlistId: any, opts: any) => this.env.playlists.upsert(String(playlistId), opts || {}), "playlists:write");
    const plGet = this.hostAsync("get", (playlistId: any) => this.env.playlists.get(String(playlistId)), "playlists:write");
    const plReplace = this.hostAsync("replaceEntries", (playlistId: any, entries: any) => this.env.playlists.replaceEntries(String(playlistId), entries || []), "playlists:write");
    const plCover = this.hostAsync("updateCover", (playlistId: any, coverSongId: any) => this.env.playlists.updateCover(String(playlistId), String(coverSongId)), "playlists:write");
    const plFindBySource = this.hostAsync("findBySource", (sourcePlatform: any, externalId: any) => this.env.playlists.findBySource(String(sourcePlatform), String(externalId)), "playlists:read");
    c.setProp(playlistsObj, "upsert", plUpsert);
    c.setProp(playlistsObj, "get", plGet);
    c.setProp(playlistsObj, "replaceEntries", plReplace);
    c.setProp(playlistsObj, "updateCover", plCover);
    c.setProp(playlistsObj, "findBySource", plFindBySource);
    plUpsert.dispose(); plGet.dispose(); plReplace.dispose(); plCover.dispose(); plFindBySource.dispose();

    // host.sources(在线源补全,需 songs:write)
    const sourcesObj = c.newObject();
    const srcComplete = this.hostAsync("complete", (opts: any) => this.env.sources.complete(opts || {}), "songs:write");
    c.setProp(sourcesObj, "complete", srcComplete);
    srcComplete.dispose();

    // host.config(每次调用前刷新)/ host.version
    // host.crypto(纯同步工具,需 crypto 权限;Last.fm api_sig = MD5(排序拼接 + secret))
    const cryptoObj = c.newObject();
    const cryptoMd5 = this.hostSync("md5", (s: any) => this.env.crypto.md5(String(s ?? "")), "crypto");
    c.setProp(cryptoObj, "md5", cryptoMd5);
    cryptoMd5.dispose();

    const hostObj = c.newObject();
    c.setProp(hostObj, "http", httpFn);
    c.setProp(hostObj, "storage", storageObj);
    c.setProp(hostObj, "comm", commObj);
    c.setProp(hostObj, "songs", songsObj);
    c.setProp(hostObj, "playlists", playlistsObj);
    c.setProp(hostObj, "sources", sourcesObj);
    c.setProp(hostObj, "plugin", pluginObj);
    c.setProp(hostObj, "crypto", cryptoObj);
    // [FIX] 子 inject 返回的 newObject 句柄必须显式 dispose,否则 host-ref 泄漏 →
    // runtime.dispose() 触发 QuickJS gc_obj_list 断言并毒化共享 WASM module。
    const fsObj = this.injectFs();
    c.setProp(hostObj, "fs", fsObj);
    fsObj.dispose();
    const commandObj = this.injectCommand();
    c.setProp(hostObj, "command", commandObj);
    commandObj.dispose();
    const netObj = this.injectNet();
    c.setProp(hostObj, "net", netObj);
    netObj.dispose();
    const wsObj = this.injectWs();
    c.setProp(hostObj, "ws", wsObj);
    wsObj.dispose();
    const jsenvObj = this.injectJsenv();
    c.setProp(hostObj, "jsenv", jsenvObj);
    jsenvObj.dispose();
    c.setProp(hostObj, "log", logFn);
    const versionStr = c.newString(this.env.version || "");
    c.setProp(hostObj, "version", versionStr);
    versionStr.dispose();
    httpFn.dispose(); storageObj.dispose(); commObj.dispose(); songsObj.dispose(); playlistsObj.dispose(); sourcesObj.dispose(); pluginObj.dispose(); cryptoObj.dispose(); logFn.dispose();
    c.setProp(c.global, "__mfHost", hostObj);
    hostObj.dispose();
  }

  /** 每次调用前把 host.config 刷新为最新配置(插件里应实时读 host.config)。 */
  private refreshConfig(): void {
    if (!this.ctx || this.disposed) return;
    try {
      const hostHandle = this.ctx.getProp(this.ctx.global, "__mfHost");
      if (!hostHandle) return;
      const cfgHandle = this.jsToHandle(this.env.getConfig() || {});
      this.ctx.setProp(hostHandle, "config", cfgHandle);
      this.safeDispose(cfgHandle);
      hostHandle.dispose();
    } catch { /* ignore */ }
  }

  // ---------- 宿主事件 → VM handler 派发(net/ws 用) ----------

  /** 把 VM 函数 handle 注册到全局槽位(宿主事件到达时派发)。 */
  private registerVmHandler(globalKey: string, handlerHandle: QuickJSHandle): void {
    try { this.ctx.setProp(this.ctx.global, globalKey, handlerHandle); } catch { /* ignore */ }
  }

  /** 派发事件到 VM handler(信封调用,异常不扩散宿主)。 */
  private callVmHandler(globalKey: string, payload: any): void {
    if (this.disposed || !this.ctx || !this.runtime?.alive) return;
    try {
      const code = `(async () => { try { const h = globalThis[${JSON.stringify(globalKey)}]; if (typeof h !== "function") return { ok: true }; await h(${JSON.stringify(payload)}); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
      const r = this.ctx.evalCode(code);
      if (r.error !== undefined) { r.error.dispose(); return; }
      const ph = this.ctx.unwrapResult(r);
      const rp = this.ctx.resolvePromise(ph);
      rp.then(() => { try { ph.dispose(); } catch { /* ignore */ } }, () => { try { ph.dispose(); } catch { /* ignore */ } });
      this.pumpJobs();
    } catch { /* ignore */ }
  }

  // ---------- host.* 高风险能力组注入(fs / command / net / ws / jsenv) ----------

  private injectFs(): QuickJSHandle {
    const c = this.ctx;
    const obj = c.newObject();
    const defs: Array<[string, (...a: any[]) => any]> = [
      ["readFile", (p: any, enc: any) => this.env.fs.readFile(String(p), enc ? String(enc) : undefined)],
      ["writeFile", (p: any, d: any, enc: any) => this.env.fs.writeFile(String(p), String(d), enc ? String(enc) : undefined)],
      ["appendFile", (p: any, d: any, enc: any) => this.env.fs.appendFile(String(p), String(d), enc ? String(enc) : undefined)],
      ["readdir", (p: any) => this.env.fs.readdir(String(p))],
      ["unlink", (p: any) => this.env.fs.unlink(String(p))],
      ["exists", (p: any) => this.env.fs.exists(String(p))],
      ["mkdir", (p: any, o: any) => this.env.fs.mkdir(String(p), o || {})],
      ["stat", (p: any) => this.env.fs.stat(String(p))],
      ["rename", (a: any, b: any) => this.env.fs.rename(String(a), String(b))],
    ];
    for (const [name, impl] of defs) {
      const fn = this.hostAsync(name, impl, "fs");
      c.setProp(obj, name, fn);
      fn.dispose();
    }
    return obj;
  }

  private injectCommand(): QuickJSHandle {
    const c = this.ctx;
    const obj = c.newObject();
    const execFn = this.hostAsync("exec", (program: any, args: any, options: any) =>
      this.env.command.exec(String(program), Array.isArray(args) ? args.map(String) : [], options || {}), "command");
    const startFn = this.hostAsync("start", (name: any, program: any, args: any) =>
      this.env.command.start(String(name), String(program), Array.isArray(args) ? args.map(String) : []), "command");
    const stopFn = this.hostAsync("stop", (name: any) => this.env.command.stop(String(name)), "command");
    const isRunningFn = this.hostAsync("isRunning", (name: any) => this.env.command.isRunning(String(name)), "command");
    c.setProp(obj, "exec", execFn);
    c.setProp(obj, "start", startFn);
    c.setProp(obj, "stop", stopFn);
    c.setProp(obj, "isRunning", isRunningFn);
    execFn.dispose(); startFn.dispose(); stopFn.dispose(); isRunningFn.dispose();
    return obj;
  }

  /** 构造 TCP socket 的 VM 对象(含 send/onData/onClose/close 方法)。 */
  private buildTcpSocketHandle(info: any): QuickJSHandle {
    const c = this.ctx;
    const socketId = String(info.socketId);
    const obj = c.newObject();
    const sendFn = this.hostAsync("send", (data: any) => this.env.net.tcpSend(socketId, String(data)), "net");
    const closeFn = this.hostAsync("close", () => this.env.net.tcpClose(socketId), "net");
    const onDataFn = c.newFunction("onData", (handlerHandle: QuickJSHandle) => {
      const key = "__mfNetTcp_" + socketId;
      this.registerVmHandler(key, handlerHandle);
      this.env.net.tcpOnData(socketId, (data: any) => this.callVmHandler(key, data));
      return c.undefined;
    });
    const onCloseFn = c.newFunction("onClose", (handlerHandle: QuickJSHandle) => {
      const key = "__mfNetTcpClose_" + socketId;
      this.registerVmHandler(key, handlerHandle);
      this.env.net.tcpOnClose(socketId, () => this.callVmHandler(key, null));
      return c.undefined;
    });
    const sidHandle = c.newString(socketId);
    c.setProp(obj, "socketId", sidHandle);
    sidHandle.dispose();
    if (info.localAddr) { const h = c.newString(String(info.localAddr)); c.setProp(obj, "localAddr", h); h.dispose(); }
    else c.setProp(obj, "localAddr", c.null);
    if (info.remoteAddr) { const h = c.newString(String(info.remoteAddr)); c.setProp(obj, "remoteAddr", h); h.dispose(); }
    else c.setProp(obj, "remoteAddr", c.null);
    c.setProp(obj, "send", sendFn);
    c.setProp(obj, "onData", onDataFn);
    c.setProp(obj, "onClose", onCloseFn);
    c.setProp(obj, "close", closeFn);
    sendFn.dispose(); closeFn.dispose(); onDataFn.dispose(); onCloseFn.dispose();
    return obj;
  }

  private injectNet(): QuickJSHandle {
    const c = this.ctx;
    const obj = c.newObject();
    const udpBind = this.hostAsync("udpBind", (options: any) => this.env.net.udpBind(options || {}), "net");
    const udpSend = this.hostAsync("udpSend", (sid: any, data: any, addr: any) => this.env.net.udpSend(String(sid), String(data), addr), "net");
    const udpClose = this.hostAsync("udpClose", (sid: any) => this.env.net.udpClose(String(sid)), "net");
    c.setProp(obj, "udpBind", udpBind);
    c.setProp(obj, "udpSend", udpSend);
    c.setProp(obj, "udpClose", udpClose);
    udpBind.dispose(); udpSend.dispose(); udpClose.dispose();

    const udpOnData = c.newFunction("onData", (sidHandle: QuickJSHandle, handlerHandle: QuickJSHandle) => {
      const sid = String(c.dump(sidHandle));
      const key = "__mfNetUdp_" + sid;
      this.registerVmHandler(key, handlerHandle);
      this.env.net.udpOnData(sid, (data: any) => this.callVmHandler(key, data));
      return c.undefined;
    });
    c.setProp(obj, "onData", udpOnData);
    udpOnData.dispose();

    const tcpConnect = this.hostAsync("tcpConnect", (host: any, port: any, options: any) =>
      this.env.net.tcpConnect(String(host), Number(port), options || {}).then((info: any) => ({ __mfRawHandle: this.buildTcpSocketHandle(info) })), "net");
    c.setProp(obj, "tcpConnect", tcpConnect);
    tcpConnect.dispose();
    return obj;
  }

  private injectWs(): QuickJSHandle {
    const c = this.ctx;
    const obj = c.newObject();
    const connect = this.hostAsync("connect", (url: any, options: any) =>
      this.env.ws.connect(String(url), options || {}).then((info: any) => {
        const socketId = String(info.socketId);
        const sockObj = c.newObject();
        const sendFn = this.hostAsync("send", (data: any) => this.env.ws.wsSend(socketId, String(data)), "websocket");
        const closeFn = this.hostAsync("close", () => this.env.ws.wsClose(socketId), "websocket");
        const onMessageFn = c.newFunction("onMessage", (handlerHandle: QuickJSHandle) => {
          const key = "__mfWsMsg_" + socketId;
          this.registerVmHandler(key, handlerHandle);
          this.env.ws.wsOnMessage(socketId, (data: any) => this.callVmHandler(key, data));
          return c.undefined;
        });
        const onCloseFn = c.newFunction("onClose", (handlerHandle: QuickJSHandle) => {
          const key = "__mfWsClose_" + socketId;
          this.registerVmHandler(key, handlerHandle);
          this.env.ws.wsOnClose(socketId, (code: number, reason: string) => this.callVmHandler(key, { code, reason }));
          return c.undefined;
        });
        const sidHandle = c.newString(socketId);
        c.setProp(sockObj, "socketId", sidHandle);
        sidHandle.dispose();
        c.setProp(sockObj, "send", sendFn);
        c.setProp(sockObj, "onMessage", onMessageFn);
        c.setProp(sockObj, "onClose", onCloseFn);
        c.setProp(sockObj, "close", closeFn);
        sendFn.dispose(); closeFn.dispose(); onMessageFn.dispose(); onCloseFn.dispose();
        return sockObj;
      }), "websocket");
    c.setProp(obj, "connect", connect);
    connect.dispose();
    return obj;
  }

  private injectJsenv(): QuickJSHandle {
    const c = this.ctx;
    const obj = c.newObject();
    const createFn = this.hostAsync("create", (name: any, initCode: any) => this.env.jsenv.create(String(name), initCode ? String(initCode) : ""), "jsenv");
    const executeFn = this.hostAsync("execute", (name: any, code: any) => this.env.jsenv.execute(String(name), String(code)), "jsenv");
    const destroyFn = this.hostAsync("destroy", (name: any) => this.env.jsenv.destroy(String(name)), "jsenv");
    c.setProp(obj, "create", createFn);
    c.setProp(obj, "execute", executeFn);
    c.setProp(obj, "destroy", destroyFn);
    createFn.dispose(); executeFn.dispose(); destroyFn.dispose();
    return obj;
  }

  // ---------- 调用 ----------

  /** 异步方法调用(搜索/推荐/上报等)。guest 永远 resolve 信封,宿主不面对 rejection。 */
  async invoke(method: string, args: any[]): Promise<any> {
    this.assertUsable();
    this.refreshConfig();
    const tmo = this.timeoutForMethod(method);
    this.deadline = Date.now() + tmo;
    // 软看门狗状态初始化:longRunning 方法无墙钟(等网络无限合法),只杀 CPU 空转。
    this.currentIsLong = tmo !== INVOKE_TIMEOUT_MS;
    this.cpuKilled = false;
    this.lastHostProgressAt = Date.now();
    const body = `globalThis.__mfImpl[${JSON.stringify(method)}](${(args || []).map((a) => JSON.stringify(a === undefined ? null : a)).join(",")})`;
    const code = `(async () => { try { const v = await (${body}); return { ok: true, value: v }; } catch (e) { return { ok: false, error: { name: String(e && e.name || ""), message: String(e && e.message || String(e)), stack: String(e && e.stack || "") } }; } })()`;
    return this.evalAsync(code, method, tmo);
  }

  /** 方法级超时:manifest.longRunning[method] 声明的长耗时预算(cap 5 分钟),否则默认 15s。 */
  private timeoutForMethod(method: string): number {
    try {
      const lr = this.manifest?.longRunning;
      const t = lr && lr[method];
      if (typeof t === "number" && Number.isFinite(t) && t > 0) return Math.min(t, JOB_TIMEOUT_CAP_MS);
    } catch { /* ignore */ }
    return INVOKE_TIMEOUT_MS;
  }

  /** 同步方法调用(streamUrl/lyricUrl/canHandle/canHandleFile)。插件契约:这些方法必须纯同步。 */
  invokeSync(method: string, args: any[]): any {
    this.assertUsable();
    this.refreshConfig();
    this.deadline = Date.now() + INVOKE_TIMEOUT_MS;
    const body = `globalThis.__mfImpl[${JSON.stringify(method)}](${(args || []).map((a) => JSON.stringify(a === undefined ? null : a)).join(",")})`;
    const code = `(() => { try { const v = (${body}); return { ok: true, value: v }; } catch (e) { return { ok: false, error: { name: String(e && e.name || ""), message: String(e && e.message || String(e)) } }; } })()`;
    const result = this.ctx.evalCode(code);
    if (result.error !== undefined) {
      const e = this.ctx.dump(result.error);
      result.error.dispose();
      if (this.isOomMessage(e)) return this.handleOomSync(method);
      throw new Error(`插件 ${this.id} ${method}() 执行失败: ${e}`);
    }
    const vh = this.ctx.unwrapResult(result);
    const v = this.ctx.dump(vh);
    vh.dispose();
    if (v && v.ok === true) return v.value;
    const syncErrMsg = (v && v.error && (v.error.message || v.error.name)) || "执行失败";
    if (this.isOomMessage(syncErrMsg)) return this.handleOomSync(method);
    console.error(`[PLUGIN:${this.id}] ${method}() 失败: ${syncErrMsg}`);
    throw new Error(`插件 ${this.id} ${method}(): ${syncErrMsg}`);
  }

  private async evalAsync(code: string, method?: string, timeoutMs: number = INVOKE_TIMEOUT_MS): Promise<any> {
    const result = this.ctx.evalCode(code);
    if (result.error !== undefined) {
      const e = this.ctx.dump(result.error);
      result.error.dispose();
      if (this.isOomMessage(e)) return this.handleOom(method);
      throw new SandboxLimitError("SANDBOX_VM", `沙箱限制:虚拟机执行失败(${method || "eval"}),原因: ${e}`);
    }
    const promiseHandle = this.ctx.unwrapResult(result);
    const settledPromise = this.ctx.resolvePromise(promiseHandle);
    let done = false;
    settledPromise.then(() => { done = true; }, () => { done = true; });
    // 长耗时批量任务:无墙钟硬超时——循环一直推进,退出靠 done(任务完成)或
    // interrupt 软看门狗(CPU 空转 60s 杀)。等网络/DB(await 挂起)无限合法,
    // 支持任意规模歌单/封面/歌词;交互型调用维持 15s 墙钟。
    const isLong = timeoutMs !== INVOKE_TIMEOUT_MS;
    const t0 = Date.now();
    while (!done) {
      if (isLong && !this.cpuKilled && Date.now() - this.lastHostProgressAt > cpuIdleLimitMs()) {
        // 兜底:guest 挂起后 CPU 空转(理论上 interrupt 已杀,此处双保险)
        this.cpuKilled = true;
      }
      if (this.runtime.hasPendingJob()) this.runtime.executePendingJobs(MAX_JOBS_PER_PUMP);
      await new Promise((r) => setImmediate(r));
      if (!isLong && Date.now() - t0 >= timeoutMs) break; // 交互:墙钟到点退出
      if (isLong && this.cpuKilled) break;                 // 长任务:CPU 空转被杀退出
    }
    try {
      // 超时(在途未结算):明确告知是沙箱限制而非笼统"执行失败",附修复提示。
      if (!done) {
        if (isLong) {
          const hint = "批量任务 CPU 空转超限:若插件确在拉取平台/外网数据(网络/DB 调用有进展)则属正常,不应被杀;若为死循环请修复插件";
          console.error(`[PLUGIN:${this.id}] 调用${method ? " " + method + "()" : ""} CPU 空转超限(> ${cpuIdleLimitMs()}ms 无网络/DB 进展),已中断`);
          throw new SandboxLimitError("SANDBOX_TIMEOUT", `沙箱限制:批量任务 CPU 空转超限(连续 ${(cpuIdleLimitMs() / 1000).toFixed(0)}s 无网络/DB 进展,疑似死循环)`, hint);
        }
        const hint = `该操作可能需拉取平台/外网数据。可在插件 manifest 的 longRunning 中为${method ? ` ${method}()` : "该方法"}声明更长预算(默认 ${INVOKE_TIMEOUT_MS}ms,上限 ${JOB_TIMEOUT_CAP_MS}ms)后更新插件`;
        console.error(`[PLUGIN:${this.id}] 调用${method ? " " + method + "()" : ""} 执行超时(> ${timeoutMs}ms),已中断`);
        throw new SandboxLimitError("SANDBOX_TIMEOUT", `沙箱限制:单次调用超时(配额 ${timeoutMs}ms)`, hint);
      }
      let rr: any;
      try { rr = await settledPromise; } catch (e) { rr = { rejected: e }; }
      if (rr && rr.rejected) {
        const msg = String((rr.rejected && (rr.rejected as any).message) || rr.rejected);
        if (this.isOomMessage(msg)) return this.handleOom(method);
        // 长任务被 CPU 空转中断(QuickJS interrupt):归为沙箱限制而非插件内部错误。
        if (isLong && this.cpuKilled) {
          const hint = "批量任务 CPU 空转超限:若插件确在拉取平台/外网数据则属正常,不应被杀;若为死循环请修复插件";
          console.error(`[PLUGIN:${this.id}] 调用${method ? " " + method + "()" : ""} CPU 空转超限,已中断`);
          throw new SandboxLimitError("SANDBOX_TIMEOUT", `沙箱限制:批量任务 CPU 空转超限(连续 ${(cpuIdleLimitMs() / 1000).toFixed(0)}s 无网络/DB 进展,疑似死循环)`, hint);
        }
        console.error(`[PLUGIN:${this.id}]${method ? " " + method + "()" : ""} 内部异常: ${msg}`);
        throw new Error(`插件 ${this.id} 内部错误: ${msg}`);
      }
      const vh: any = this.ctx.unwrapResult(rr as any);
      const v = this.ctx.dump(vh);
      vh.dispose();
      if (v && v.ok === true) return v.value;
      // 长任务被软看门狗中断(QuickJS interrupt 被 guest 外层 catch 收成普通信封):
      // 归为沙箱限制(CPU 空转超限),而非插件内部错误。
      if (isLong && this.cpuKilled) {
        const hint = "批量任务 CPU 空转超限:若插件确在拉取平台/外网数据则属正常,不应被杀;若为死循环请修复插件";
        console.error(`[PLUGIN:${this.id}] 调用${method ? " " + method + "()" : ""} CPU 空转超限,已中断`);
        throw new SandboxLimitError("SANDBOX_TIMEOUT", `沙箱限制:批量任务 CPU 空转超限(连续 ${(cpuIdleLimitMs() / 1000).toFixed(0)}s 无网络/DB 进展,疑似死循环)`, hint);
      }
      // 插件侧抛错:服务端记录完整 message + stack,便于定位真因;前端只收到精简文案。
      const errMsg = (v && v.error && (v.error.message || v.error.name)) || "执行失败";
      if (this.isOomMessage(errMsg)) return this.handleOom(method);
      if (v && v.error && v.error.stack) console.error(`[PLUGIN:${this.id}]${method ? " " + method + "()" : ""} 失败: ${errMsg}`, v.error.stack);
      else console.error(`[PLUGIN:${this.id}]${method ? " " + method + "()" : ""} 失败: ${errMsg}`);
      throw new Error(`插件 ${this.id}: ${errMsg}`);
    } finally {
      try { promiseHandle.dispose(); } catch { /* ignore */ }
    }
  }

  /** 生成 core 侧的 impl 门面:只暴露插件实际实现且能力要求的方法。
   *  @param worker 可选:批量 worker 代理——manifest.longRunning 声明的方法路由到
   *   worker 线程执行(插件计算不占主线程,根治同步刷新假死);同步方法与普通交互
   *   方法保持主线程执行(快路径,无 IPC 开销,同步语义不变)。 */
  makeImpl(worker?: SandboxedPluginRemote): any {
    const candidates = new Set<string>();
    for (const cap of this.manifest.capabilities) {
      for (const m of CAP_METHODS[cap] || []) candidates.add(m);
    }
    if (this.manifest.type === "source") for (const m of EXTRA_METHODS) candidates.add(m);
    const present = this.presentMethods();
    const impl: any = {};
    for (const m of candidates) {
      if (!present.has(m)) continue;
      impl[m] = (...args: any[]) => {
        const clean = STRIP_HOST_FIRST.has(m) ? args.slice(1) : args;
        if (worker && this.manifest.longRunning?.[m]) return worker.invoke(m, clean, this.env.getConfig());
        if (SYNC_METHODS.has(m)) return this.invokeSync(m, clean);
        return this.invoke(m, clean);
      };
    }
    // health() 是可选自检钩子(非能力):插件实现了就暴露,供 /v1/plugins/health 主动 ping。
    if (present.has("health")) {
      impl.health = (...args: any[]) => this.invoke("health", args);
    }
    return impl;
  }
}

/** 沙箱批量 worker 的宿主侧代理:持有 worker 线程,把 longRunning 批量方法调用发到
 *  worker 执行(插件计算不占主线程事件循环),host.* 调用由 worker 发回本代理用真实
 *  env 执行后回传。与 sandboxWorker.ts 配对(消息协议一致)。 */
export class SandboxedPluginRemote {
  readonly id: string;
  private env: SandboxHostEnv;
  private worker: Worker | null = null;
  private seq = 0;
  private pendingInvoke = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private readyWait: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private initWait: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((e: any) => void) | null = null;
  private disposed = false;
  /** 销毁时回调(loadSandboxedPlugin 注入:注销批量 worker 计数)。 */
  private onDispose: (() => void) | null = null;

  constructor(id: string, env: SandboxHostEnv) {
    this.id = id;
    this.env = env;
  }

  setOnDispose(fn: () => void): void { this.onDispose = fn; }

  /** 启动 worker 并完成插件 VM 初始化(等 ready + init-done)。 */
  async init(code: string, expectedManifest?: PluginManifest): Promise<void> {
    if (this.initWait) return this.initWait;
    this.readyWait = new Promise<void>((r) => { this.readyResolve = r; });
    this.initWait = new Promise<void>((r, j) => { this.initResolve = r; this.initReject = j; });

    const here = dirname(fileURLToPath(import.meta.url));
    const workerPath = existsSync(join(here, "sandboxWorker.js"))
      ? join(here, "sandboxWorker.js")
      : join(here, "sandboxWorker.ts");
    const w = new Worker(workerPath);
    this.worker = w;
    // 不阻止宿主进程退出(测试/关闭时无需等待 worker)。
    w.unref();
    w.on("message", (msg: any) => this.onMessage(msg));
    w.on("error", (e: Error) => {
      this.failAll(`沙箱 worker 错误: ${e?.message || e}`);
      this.initReject?.(e);
    });
    w.on("exit", (code) => {
      if (code !== 0 && !this.disposed) this.failAll(`沙箱 worker 异常退出(code=${code})`);
    });

    const timer = setTimeout(() => this.initReject?.(new Error("沙箱 worker 初始化超时")), 20000);
    try {
      await this.readyWait; // worker 启动就绪
      w.postMessage({ type: "init", id: this.id, code, expectedManifest, permissions: expectedManifest?.permissions || this.env.permissions || [] });
      await this.initWait;  // VM init 完成
      clearTimeout(timer);
    } catch (e) {
      clearTimeout(timer);
      try { w.terminate(); } catch { /* ignore */ }
      throw e;
    }
  }

  /** 调用 worker 里的批量方法。config 随消息携带(worker 侧 refreshConfig 同步可读)。 */
  async invoke(method: string, args: any[], config?: Record<string, any>): Promise<any> {
    if (!this.worker) throw new Error("沙箱 worker 未初始化");
    const invokeId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pendingInvoke.set(invokeId, { resolve, reject });
      this.worker!.postMessage({ type: "invoke", invokeId, method, args, config: config || {} });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll("沙箱 worker 已销毁");
    try { this.onDispose?.(); } catch { /* ignore */ }
    try { this.worker?.postMessage({ type: "dispose" }); } catch { /* ignore */ }
    setTimeout(() => { try { this.worker?.terminate(); } catch { /* ignore */ } }, 50);
  }

  // ---------- 内部 ----------

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve?.();
        break;
      case "init-done":
        if (msg.ok) this.initResolve?.();
        else this.initReject?.(new Error(msg.error || "沙箱 worker 初始化失败"));
        break;
      case "invoke-result": {
        const p = this.pendingInvoke.get(msg.invokeId);
        if (p) {
          this.pendingInvoke.delete(msg.invokeId);
          if (msg.ok) p.resolve(msg.value);
          else {
            const e = new Error(msg.error || "执行失败");
            (e as any).sandboxCode = msg.sandboxCode;
            (e as any).hint = msg.hint;
            p.reject(e);
          }
        }
        break;
      }
      case "host-call": {
        this.dispatchHostCall(msg.callId, msg.name, msg.args).catch(() => { /* dispatch 内已兜底 */ });
        break;
      }
      default:
        break;
    }
  }

  private async dispatchHostCall(callId: number, name: string, args: any[]): Promise<void> {
    try {
      const [m, sub] = name.split(".");
      const env = this.env as any;
      let value: any;
      switch (m) {
        case "http": value = await env.http(args[0], args[1]); break;
        case "storage": value = await env.storage[sub](...args); break;
        case "comm": value = env.comm[sub](...args); break;
        case "songs": value = await env.songs[sub](...args); break;
        case "plugin": value = await env.plugin[sub](...args); break;
        case "fs": value = await env.fs[sub](...args); break;
        case "command": value = await env.command[sub](...args); break;
        case "playlists": value = await env.playlists[sub](...args); break;
        case "sources": value = await env.sources[sub](...args); break;
        default: throw new Error(`未知 host 能力: ${name}`);
      }
      this.worker?.postMessage({ type: "host-result", callId, ok: true, value });
    } catch (e: any) {
      this.worker?.postMessage({ type: "host-result", callId, ok: false, error: String((e && e.message) || e) });
    }
  }

  private failAll(reason: string): void {
    for (const [, p] of this.pendingInvoke) p.reject(new Error(reason));
    this.pendingInvoke.clear();
  }
}

/** 加载沙箱插件:返回 manifest(与 plugin.json 校验过)与 impl 门面。
 *  插件声明了 longRunning 批量方法时,额外启动批量 worker(挂到 sandbox,dispose 联动),
 *  这些方法由 worker 线程执行;SANDBOX_WORKER_DISABLE=1 可关(测试/排障用)。 */
export async function loadSandboxedPlugin(
  id: string,
  code: string,
  env: SandboxHostEnv,
  expectedManifest?: PluginManifest,
): Promise<{ sandbox: SandboxedPlugin; impl: any }> {
  const sandbox = new SandboxedPlugin(id, env);
  await sandbox.init(code, expectedManifest);
  let worker: SandboxedPluginRemote | null = null;
  const lr = sandbox.manifest?.longRunning;
  if (lr && Object.keys(lr).length > 0 && process.env.SANDBOX_WORKER_DISABLE !== "1") {
    try {
      worker = new SandboxedPluginRemote(id, env);
      // 延迟拿批量闸(避免 sandbox.ts 顶层拉入 batchPacer→settings→db 的模块链,worker 里会重复开 DB)。
      const pacer = await import("../services/plugin/batchPacer.js");
      worker.setOnDispose(() => { try { pacer.unregisterBatchWorker(); } catch { /* ignore */ } });
      await worker.init(code, expectedManifest);
      pacer.registerBatchWorker(); // 并发上限随 worker 数提升(多核并行批量任务)
      sandbox.attachWorker(worker);
    } catch (e: any) {
      console.warn(`[PLUGIN:${id}] 批量 worker 初始化失败,longRunning 方法回退主线程执行:`, e?.message || e);
      try { worker?.dispose(); } catch { /* ignore */ }
      worker = null;
    }
  }
  return { sandbox, impl: sandbox.makeImpl(worker ?? undefined) };
}
