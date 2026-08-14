// ==================== External (drop-in) plugin discovery ====================
//
// Phase 3: at boot, scan `<data>/plugins/<id>/index.js`, dynamically import each
// one, validate its manifest, check the app-version floor, and register it into
// the same runtime registry the built-ins use. From that point on the core treats
// an external plugin exactly like a built-in — no special-casing anywhere.
//
// Safety boundaries:
//   - path whitelist: only `<data>/plugins/<id>/index.js` is importable; a plugin
//     can NEVER escape that directory (path-traversal guard in safeResolve()).
//   - manifest validation: id / type / capabilities / configSchema must be well
//     formed or the plugin is skipped (never throws, never halts boot).
//   - minAppVersion: a plugin requiring a newer app is skipped with a warning.
//   - id collision: a built-in (or already-discovered) id wins; the duplicate is
//     skipped so an external file can't shadow a first-party plugin.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile, spawn } from "child_process";
import dgram from "dgram";
import net from "net";
import WebSocket from "ws";
import { eq, like, or } from "drizzle-orm";
import { getDataDir } from "../utils/env.js";
import { db, sqlite } from "../db/index.js";
import { songs } from "../db/schema.js";
import { registerPlugin, getPlugin, getPluginConfig, getEnabledByCapability } from "./registry.js";
import { seedPluginRows } from "./builtins.js";
import { validatePermissions } from "./host.js";
import { loadSandboxedPlugin, type SandboxedPlugin, getSandboxModule } from "./sandbox.js";
import { makeScopedStorage } from "./storage.js";
import { createComm } from "./comm.js";
import type { PluginManifest, PluginType, PluginCapability } from "./types.js";
import { importOnlineSongs } from "../services/source/online/service.js";

const VALID_TYPES: PluginType[] = [
  "source", "importer", "recommender", "sync",
  "lyrics", "cover", "renderer", "scrobbler", "artist",
];
const VALID_CAPS: PluginCapability[] = [
  "search", "recommend", "playlistSongs", "stream", "lyrics", "webRotation",
  "playlistImport", "playlistFile", "dailyPlaylist", "localPlaylist",
  "recommendPlaylist",
  "playlistSync", "autoMatch",
  "lyricProvider", "coverProvider", "renderer", "scrobbler",
  "artistInfo",
];

// 能力 → 该能力实现「必然需要」的宿主权限。
//
// 根因修复(P0):外置插件若漏写 plugin.json 的 permissions(尤其 `net`),
// 沙箱里所有走 host.http / host.net 的能力(搜索/歌词/封面/推荐…)会被权限
// 门控静默拒绝 —— 表现为「音乐能播(streamUrl 是同步纯构造不碰网络)但歌词
// 拿不到 / 测试连接 HTTP undefined / 无可用音源」。这里按 capabilities 推导
// 出必需权限,与 plugin.json 声明的 permissions 取并集,**无论开发者是否手写
// 对权限,平台都自动补齐**,根除整类「漏写 permissions 静默失效」问题。
//
// 映射依据(backend/src/plugins/sandbox.ts 的 hostAsync 调用点):
//   host.http → net,host.storage → storage,host.fs → fs,host.command → command,
//   host.net → net,host.ws → websocket,host.jsenv → jsenv,host.songs → songs:read,
//   host.comm → inter-plugin。具体能力的 impl 内部会调用哪些 host.* 由插件决定,
// 这里取「该能力可能用到」的最小权限集(网络型能力一律 net)。
const CAP_PERMISSIONS: Record<string, string[]> = {
  // 源 / 在线能力:实现几乎都走 host.http 取数据 → net
  search: ["net"],
  recommend: ["net"],
  playlistSongs: ["net"],
  stream: ["net"],          // 兜底流可能走 host.http;即使仅构造 URL,补 net 也无害
  webRotation: [],          // 核心 purge 定时器触发,插件无需权限
  autoMatch: ["net"],
  lyricProvider: ["net"],   // searchLyrics 走 host.http
  coverProvider: ["net"],   // searchCover 走 host.http
  lyrics: ["net"],          // legacy source-lyrics
  scrobbler: ["net"],       // onPlay/onScrobble 通常上报到外部服务
  artistInfo: ["net"],      // fetchArtistInfo 走 host.http
  playlistImport: ["net"],  // fetchPlaylist 走 host.http
  // 文件型:解析上传的歌单文件需要 host.fs
  playlistFile: ["fs"],
  // 调度型:持久化候选池 / 重新拉取需要 storage,部分实现会联网
  dailyPlaylist: ["storage", "net"],
  localPlaylist: ["storage"],
  playlistSync: ["storage", "net"],
  // 设备投射:发现/投送设备走网络
  renderer: ["net"],
};

/** 按 capabilities 推导插件需要的权限集合(去重)。 */
export function derivePermissions(caps: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const c of caps || []) {
    for (const p of CAP_PERMISSIONS[c] || []) out.add(p);
  }
  return [...out];
}

/** 已加载外置插件的沙箱实例(id → SandboxedPlugin),热重载/卸载时 dispose。 */
export const pluginSandboxes = new Map<string, SandboxedPlugin>();

/** 本机 IPv4 地址(非回环),供 host.plugin.getNetworkAddresses 使用。 */
function getNetworkAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === "IPv4" && !it.internal) out.push(it.address);
    }
  }
  return out;
}

/** songs 表 → 沙箱插件可见的脱敏视图(不含 path/streamHeaders/sourceData 等内部字段)。 */
function toPluginSong(s: any): any {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist || "",
    album: s.album || "",
    duration: s.duration || 0,
    coverArt: s.coverArt || "",
    playCount: s.playCount || 0,
    genre: s.genre || "",
    track: s.track || 0,
    type: s.type || "local",
  };
}

/** host.fs:插件专属目录文件读写(防路径穿越,只允许 <pluginDir>/files/ 内)。 */
export function makeFsApi(pluginDir: string): any {
  const baseDir = path.join(pluginDir, "files");
  const resolveSafe = (p: string): string => {
    const full = path.resolve(baseDir, String(p));
    if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
      throw new Error("路径越界: 只能在插件 files/ 目录内");
    }
    return full;
  };
  fs.mkdirSync(baseDir, { recursive: true });
  return {
    readFile: async (p: string, enc?: string) => fs.readFileSync(resolveSafe(p), (enc || "utf8") as any),
    writeFile: async (p: string, data: string, enc?: string) => { fs.writeFileSync(resolveSafe(p), data, (enc || "utf8") as any); return null; },
    appendFile: async (p: string, data: string, enc?: string) => { fs.appendFileSync(resolveSafe(p), data, (enc || "utf8") as any); return null; },
    readdir: async (p: string) => { const full = resolveSafe(p); if (!fs.existsSync(full)) return []; return fs.readdirSync(full); },
    unlink: async (p: string) => { fs.rmSync(resolveSafe(p), { force: true }); return null; },
    exists: async (p: string) => fs.existsSync(resolveSafe(p)),
    mkdir: async (p: string, o?: any) => { fs.mkdirSync(resolveSafe(p), { recursive: !!(o && o.recursive) }); return null; },
    stat: async (p: string) => {
      const full = resolveSafe(p);
      if (!fs.existsSync(full)) return null;
      const s = fs.statSync(full);
      return { size: s.size, mtime: s.mtime.toISOString(), isDirectory: s.isDirectory() };
    },
    rename: async (a: string, b: string) => { fs.renameSync(resolveSafe(a), resolveSafe(b)); return null; },
  };
}

/** host.command:执行外部命令(exec 走 execFile 不经 shell;start/stop 管理常驻进程)。 */
export function makeCommandApi(): any {
  const procs = new Map<string, any>();
  return {
    exec: async (program: string, args: string[], options?: any) => {
      const timeout = Number(options?.timeout) > 0 ? Number(options.timeout) : 30000;
      return new Promise((resolve) => {
        execFile(program, args || [], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
          resolve({
            code: err ? (err.code ?? -1) : 0,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
            timedOut: !!(err && err.killed),
          });
        });
      });
    },
    start: async (name: string, program: string, args: string[]) => {
      if (procs.has(name)) return { name, running: true };
      const child = spawn(String(program), args || [], { stdio: ["ignore", "pipe", "pipe"] });
      procs.set(name, child);
      child.on("exit", () => procs.delete(name));
      return { name, running: true, pid: child.pid };
    },
    stop: async (name: string) => { const p = procs.get(String(name)); if (p) { try { p.kill(); } catch { /* ignore */ } procs.delete(String(name)); } return null; },
    isRunning: async (name: string) => { const p = procs.get(String(name)); return !!(p && !p.killed); },
  };
}

/** host.net:原始 UDP/TCP socket。数据以 base64 传输(二进制安全)。 */
export function makeNetApi(): any {
  const udps = new Map<string, any>();
  const udpHooks = new Map<string, (data: any) => void>();
  const tcpSockets = new Map<string, any>();
  const tcpDataHooks = new Map<string, (data: any) => void>();
  const tcpCloseHooks = new Map<string, () => void>();
  const nextId = (prefix: string) => `${prefix}${Date.now()}${Math.floor(Math.random() * 10000)}`;
  return {
    udpBind: async (options?: any) => {
      const sock = dgram.createSocket({ type: options?.ipv6 ? "udp6" : "udp4", reuseAddr: !!options?.reuseAddr });
      const id = nextId("udp");
      sock.on("message", (msg, rinfo) => { const h = udpHooks.get(id); if (h) h({ data: msg.toString("base64"), from: rinfo.address, port: rinfo.port }); });
      await new Promise((resolve, reject) => {
        sock.once("error", reject);
        sock.bind(Number(options?.port) || 0, options?.address || "0.0.0.0", () => { sock.removeListener("error", reject); resolve(null); });
      });
      udps.set(id, sock);
      return { socketId: id, address: sock.address().address, port: sock.address().port };
    },
    udpSend: async (socketId: string, data: string, addr?: any) => {
      const sock = udps.get(String(socketId));
      if (!sock) throw new Error("UDP socket 不存在");
      await new Promise((resolve, reject) => {
        sock.send(Buffer.from(String(data)), Number(addr?.port) || 0, String(addr?.address || "127.0.0.1"), (err: any) => err ? reject(err) : resolve(null));
      });
      return null;
    },
    udpClose: async (socketId: string) => {
      const s = udps.get(String(socketId));
      if (s) { try { s.close(); } catch { /* ignore */ } udps.delete(String(socketId)); udpHooks.delete(String(socketId)); }
      return null;
    },
    udpOnData: (socketId: string, handler: (data: any) => void) => udpHooks.set(String(socketId), handler),
    tcpConnect: async (host: string, port: number, options?: any) => {
      return new Promise((resolve, reject) => {
        const sock = net.connect({ host: String(host), port: Number(port) });
        const id = nextId("tcp");
        const timer = setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } reject(new Error("TCP 连接超时")); }, Number(options?.timeout) || 10000);
        sock.once("connect", () => {
          clearTimeout(timer);
          tcpSockets.set(id, sock);
          resolve({ socketId: id, localAddr: `${sock.localAddress}:${sock.localPort}`, remoteAddr: `${host}:${port}` });
        });
        sock.once("error", (e) => { clearTimeout(timer); reject(e); });
        sock.on("data", (buf) => { const h = tcpDataHooks.get(id); if (h) h({ data: buf.toString("base64") }); });
        sock.on("close", () => {
          tcpSockets.delete(id);
          const h = tcpCloseHooks.get(id);
          if (h) h();
          tcpDataHooks.delete(id); tcpCloseHooks.delete(id);
        });
      });
    },
    tcpSend: async (socketId: string, data: string) => {
      const s = tcpSockets.get(String(socketId));
      if (!s) throw new Error("TCP socket 不存在");
      s.write(Buffer.from(String(data)));
      return null;
    },
    tcpClose: async (socketId: string) => {
      const s = tcpSockets.get(String(socketId));
      if (s) { try { s.end(); } catch { /* ignore */ } tcpSockets.delete(String(socketId)); }
      return null;
    },
    tcpOnData: (socketId: string, handler: (data: any) => void) => tcpDataHooks.set(String(socketId), handler),
    tcpOnClose: (socketId: string, handler: () => void) => tcpCloseHooks.set(String(socketId), handler),
  };
}

/** host.ws:WebSocket 客户端(文本直传,二进制 base64)。 */
export function makeWsApi(): any {
  const sockets = new Map<string, any>();
  const msgHooks = new Map<string, (data: any) => void>();
  const closeHooks = new Map<string, (code: number, reason: string) => void>();
  const nextId = () => `ws${Date.now()}${Math.floor(Math.random() * 10000)}`;
  return {
    connect: async (url: string, options?: any) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(String(url), options?.protocols, {
          headers: options?.headers || {},
          handshakeTimeout: Number(options?.timeout) || 10000,
        });
        const id = nextId();
        ws.once("open", () => { sockets.set(id, ws); resolve({ socketId: id }); });
        ws.once("error", (e) => reject(e));
        ws.on("message", (data, isBinary) => {
          const h = msgHooks.get(id);
          if (h) h(isBinary ? { data: Buffer.from(data as any).toString("base64"), binary: true } : { data: String(data), binary: false });
        });
        ws.on("close", (code, reason) => {
          sockets.delete(id);
          const h = closeHooks.get(id);
          if (h) h(code || 0, String(reason || ""));
          msgHooks.delete(id); closeHooks.delete(id);
        });
      });
    },
    wsSend: async (socketId: string, data: string) => {
      const ws = sockets.get(String(socketId));
      if (!ws) throw new Error("WS 连接不存在");
      ws.send(String(data));
      return null;
    },
    wsClose: async (socketId: string) => {
      const ws = sockets.get(String(socketId));
      if (ws) { try { ws.close(); } catch { /* ignore */ } sockets.delete(String(socketId)); }
      return null;
    },
    wsOnMessage: (socketId: string, handler: (data: any) => void) => msgHooks.set(String(socketId), handler),
    wsOnClose: (socketId: string, handler: (code: number, reason: string) => void) => closeHooks.set(String(socketId), handler),
  };
}

/** host.jsenv:嵌套 QuickJS 子环境(独立 context,与主沙箱共享 WASM 模块)。 */
export function makeJsenvApi(): any {
  const envs = new Map<string, { runtime: any; ctx: any }>();
  const modulePromise = getSandboxModule();
  return {
    create: async (name: string, initCode?: string) => {
      const n = String(name);
      if (envs.has(n)) return n;
      const module = await modulePromise;
      const runtime = module.newRuntime();
      runtime.setMemoryLimit(64 * 1024 * 1024);
      runtime.setMaxStackSize(512 * 1024);
      let deadline = Date.now() + 30000;
      runtime.setInterruptHandler(() => Date.now() > deadline);
      const ctx = runtime.newContext();
      if (initCode) {
        const r = ctx.evalCode(String(initCode));
        if (r.error !== undefined) {
          const e = ctx.dump(r.error); r.error.dispose();
          try { ctx.dispose(); runtime.dispose(); } catch { /* ignore */ }
          throw new Error(`jsenv init 失败: ${e}`);
        }
        ctx.unwrapResult(r).dispose();
      }
      envs.set(n, { runtime, ctx });
      return n;
    },
    execute: async (name: string, code: string) => {
      const e = envs.get(String(name));
      if (!e) throw new Error(`jsenv 不存在: ${name}`);
      deadlineRefresh(e, 30000);
      const r = e.ctx.evalCode(String(code));
      if (r.error !== undefined) {
        const msg = e.ctx.dump(r.error); r.error.dispose();
        return { ok: false, error: String(msg) };
      }
      const vh = e.ctx.unwrapResult(r);
      const v = e.ctx.dump(vh);
      vh.dispose();
      return { ok: true, result: v };
    },
    destroy: async (name: string) => {
      const e = envs.get(String(name));
      if (e) {
        try { e.ctx.dispose(); } catch { /* ignore */ }
        try { e.runtime.dispose(); } catch { /* ignore */ }
        envs.delete(String(name));
      }
      return null;
    },
  };
  function deadlineRefresh(e: { runtime: any }, ms: number) {
    const dl = Date.now() + ms;
    try { e.runtime.setInterruptHandler(() => Date.now() > dl); } catch { /* ignore */ }
  }
}

/** Validate a plugin manifest. Returns an error string, or null when valid. Pure. */
export function validateManifest(manifest: any): string | null {  if (!manifest || typeof manifest !== "object") return "manifest 必须是对象";
  if (typeof manifest.id !== "string" || !manifest.id) return "manifest.id 缺失";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(manifest.id)) {
    return "manifest.id 只能含字母/数字/连字符,且不以连字符开头";
  }
  if (typeof manifest.name !== "string" || !manifest.name) return "manifest.name 缺失";
  if (typeof manifest.version !== "string" || !manifest.version) return "manifest.version 缺失";
  if (!VALID_TYPES.includes(manifest.type)) return `manifest.type 非法: ${String(manifest.type)}`;
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    return "manifest.capabilities 必须是非空数组";
  }
  for (const c of manifest.capabilities) {
    if (!VALID_CAPS.includes(c)) return `manifest.capabilities 含非法能力: ${String(c)}`;
  }
  if (!Array.isArray(manifest.configSchema)) return "manifest.configSchema 必须是数组";
  const permErr = validatePermissions(manifest.permissions);
  if (permErr) return `manifest.permissions: ${permErr}`;
  return null;
}

/** Compare two semver-ish version strings.
 *  Returns <0 if a<b, 0 if equal, >0 if a>b. Missing/non-numeric segments = 0.
 *  Tolerates a leading "v"/"V" (git describe tags like "v1.5.0-8-g595a0d8" would
 *  otherwise parse the first segment as 0 and wrongly fail minAppVersion checks). */
export function compareVersion(a: string, b: string): number {
  const clean = (s: string) => String(s).replace(/^[vV]/, "");
  const pa = clean(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = clean(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Is the plugin compatible with the running app version?
 *  `dev` builds accept any plugin (no version floor enforced). */
export function isAppVersionCompatible(manifest: PluginManifest, appVersion: string): boolean {
  if (!manifest.minAppVersion) return true;
  if (appVersion === "dev" || appVersion === "") return true;
  return compareVersion(appVersion, manifest.minAppVersion) >= 0;
}

/** Build the absolute path to a plugin's entry file, guaranteeing it stays
 *  inside `root`. Returns null on any escape attempt. Exported for testing. */
export function safeResolve(root: string, id: string): string | null {
  const full = path.resolve(root, id, "index.js");
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

/**
 * Scan `data/plugins` for drop-in plugins and register the valid ones.
 *
 * @param appVersion  running app version (from process.env.APP_VERSION)
 * @param rootDir     override the scan root (used by tests); when omitted the
 *                    real `data/plugins` directory is used and discovered plugins
 *                    are seeded into the DB immediately.
 * @param opts.reload 热重载模式:同 id 的外置插件先 dispose 旧沙箱再覆盖注册(文件改动生效);
 *                    内置插件仍不可被外置遮蔽。
 * @returns number of plugins successfully loaded
 */
export async function discoverExternalPlugins(
  appVersion: string,
  rootDir?: string,
  opts?: { reload?: boolean },
): Promise<number> {
  const reload = opts?.reload === true;
  const root = rootDir ?? path.join(getDataDir(), "plugins");
  if (!rootDir && !fs.existsSync(root)) return 0; // real dir absent → nothing to do
  if (rootDir && !fs.existsSync(root)) return 0;

  let loaded = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // 跳过隐藏/临时目录(如安装中的 .install-* 暂存目录),避免噪音日志。
    if (entry.name.startsWith(".")) continue;
    const id = entry.name;
    const file = safeResolve(root, id);
    if (!file || !fs.existsSync(file)) {
      console.warn(`[PLUGIN] 跳过外置插件 ${id}: 缺少 index.js`);
      continue;
    }
    try {
      // 外置插件一律在 QuickJS 沙箱里运行(拿不到 Node 能力,只能用 host.*)。
      const code = fs.readFileSync(file, "utf8");
      // 优先用插件目录里的 plugin.json 作为 manifest(与 index.js 内 manifest 比对)。
      let expectedManifest: PluginManifest | undefined;
      const jsonPath = path.join(path.dirname(file), "plugin.json");
      if (fs.existsSync(jsonPath)) {
        try { expectedManifest = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as PluginManifest; } catch { /* ignore */ }
      }
      // 版本预检:用 plugin.json 的 manifest 提前判定,不兼容则根本不必创建 QuickJS 沙箱。
      // 这是必须的——若等沙箱建好再 dispose,QuickJS JS_FreeRuntime 的 gc 断言
      // (list_empty(&rt->gc_obj_list))会以 abort 终止整个进程(实测崩溃,容器退出)。
      if (expectedManifest && !isAppVersionCompatible(expectedManifest, appVersion)) {
        console.warn(`[PLUGIN] 跳过外置插件 ${id}: 需要 App >= ${expectedManifest.minAppVersion}, 当前 ${appVersion}`);
        continue;
      }
      const declaredPerms = expectedManifest?.permissions ?? [];
      // P0:按 plugin.json 的 capabilities 推导必需权限,与声明权限取并集
      // (plugin.json 缺 capabilities 时,待沙箱加载后用 index.js manifest 再补一次)。
      const derivedFromJson = derivePermissions(expectedManifest?.capabilities);
      const initialPerms = [...new Set([...declaredPerms, ...derivedFromJson])];
      const comm = createComm(id, initialPerms);
      const env = {
        version: process.env.APP_VERSION || "dev",
        getConfig: () => getPluginConfig(id) ?? {},
        permissions: initialPerms,
        http: async (input: string, init?: any) => {
          try {
            const timeout = Number(init?.timeout) > 0 ? Number(init.timeout) : 20000;
            const { timeout: _t, ...rest } = init || {};
            const res = await fetch(String(input), { ...rest, signal: AbortSignal.timeout(timeout) });
            const body = await res.text();
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => { headers[k] = v; });
            return { ok: res.ok, status: res.status, headers, body };
          } catch (e: any) {
            return { ok: false, status: 0, headers: {}, body: "", error: String(e?.message || e) };
          }
        },
        storage: makeScopedStorage(id),
        log: (...args: any[]) => console.log(`[PLUGIN:${id}]`, ...args),
        comm: {
          send: (targetId: string, message: any) => comm.send(targetId, message),
          broadcast: (message: any) => comm.broadcast(message),
          on: (handler: (message: any) => void) => comm.on(handler),
        },
        songs: {
          list: async (options?: any) => {
            const limit = Math.min(Math.max(Number(options?.limit) || 200, 1), 500);
            const offset = Math.max(Number(options?.offset) || 0, 0);
            return db.select().from(songs).limit(limit).offset(offset).all().map(toPluginSong);
          },
          search: async (query: string, options?: any) => {
            const q = String(query || "").trim();
            if (!q) return [];
            const limit = Math.min(Math.max(Number(options?.limit) || 50, 1), 200);
            const likeQ = `%${q}%`;
            return db.select().from(songs).where(
              or(like(songs.title, likeQ), like(songs.artist, likeQ), like(songs.album, likeQ)),
            ).limit(limit).all().map(toPluginSong);
          },
          getById: async (songId: string) => {
            const s = db.select().from(songs).where(eq(songs.id, String(songId))).get();
            return s ? toPluginSong(s) : null;
          },
        },
        playlists: {
          upsert: async (playlistId: string, opts: any) => upsertPluginPlaylist(String(playlistId), opts || {}),
          get: async (playlistId: string) => {
            const p = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(String(playlistId)) as any;
            if (!p) return null;
            const entries = sqlite.prepare("SELECT * FROM playlist_songs WHERE playlist_id = ? ORDER BY position").all(String(playlistId)) as any[];
            return { ...p, entries };
          },
          replaceEntries: async (playlistId: string, entries: any[]) =>
            upsertPluginPlaylist(String(playlistId), { name: (sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(String(playlistId)) as any)?.name || "ListenBrainz 推荐", entries: entries || [] }),
          updateCover: async (playlistId: string, coverSongId: string) => {
            const cover = coverArtForSong(String(coverSongId));
            if (cover) sqlite.prepare("UPDATE playlists SET cover_art = ?, updated_at = ? WHERE id = ?").run(cover, new Date().toISOString(), String(playlistId));
            return { ok: true };
          },
        },
        sources: {
          complete: async (opts: any) => completeFromSources(opts || {}),
        },
        plugin: {
          getHostUrl: async () => process.env.DLNA_BASE_URL || "",
          getNetworkAddresses: async () => getNetworkAddresses(),
        },
        fs: makeFsApi(path.dirname(file)),
        command: makeCommandApi(),
        net: makeNetApi(),
        ws: makeWsApi(),
        jsenv: makeJsenvApi(),
      };
      const { sandbox, impl } = await loadSandboxedPlugin(id, code, env, expectedManifest);
      const manifest: PluginManifest = sandbox.manifest;
      // P0 根因修复(权威来源 = index.js manifest.capabilities):无论 plugin.json
      // 是否声明 permissions,凡声明了网络型能力的插件都自动获得 `net`(同理
      // 文件型→fs、调度型→storage),与 plugin.json 声明权限、index.js 自身
      // 声明的 permissions 三者取并集。彻底根除「漏写 permissions 静默失效」
      // (测试连接 HTTP undefined / 歌词拿不到 / 无可用音源)整类问题。
      // 沙箱 hasPerm 每次调用读 this.env.permissions 同一引用,此处修改即时生效。
      const derived = derivePermissions(manifest.capabilities);
      const merged = new Set<string>([...env.permissions, ...(manifest.permissions ?? []), ...derived]);
      // 源插件按契约必然需要联网(source 的职责就是从远端取数据);
      // 即使插件文件老旧、未声明 capabilities/permissions,也保证能联网,
      // 兜住「HTTP undefined」整类静默失效(实测:net 未授权时 host.http 返回
      // {ok:false,error} 无 status 字段 → 插件读 r.status 得 undefined)。
      // 注意:仅补 net/storage/fs 这类最小必要权限,绝不动用 jsenv/command/*。
      if (manifest.type === "source") merged.add("net");
      const added = [...merged].filter((p) => !env.permissions.includes(p));
      if (added.length) {
        env.permissions = [...merged];
        console.warn(`[PLUGIN] ${id}: 按能力/类型推导自动补齐权限: ${added.join(",")}`);
      }
      const reason = validateManifest(manifest);
      if (reason) { sandbox.dispose(); console.warn(`[PLUGIN] 跳过外置插件 ${id}: ${reason}`); continue; }
      if (!impl || typeof impl !== "object") {
        sandbox.dispose();
        console.warn(`[PLUGIN] 跳过外置插件 ${id}: create() 未返回 impl 对象`);
        continue;
      }
      if (getPlugin(manifest.id) && !reload) {
        sandbox.dispose();
        console.warn(`[PLUGIN] 跳过外置插件 ${id}: 与已注册插件 id 冲突`);
        continue;
      }
      if (reload) {
        // 重载:仅允许覆盖「同 id 的外置插件」;内置插件不可被外置遮蔽。
        const existingSandbox = pluginSandboxes.get(manifest.id);
        if (!existingSandbox && getPlugin(manifest.id)) {
          sandbox.dispose();
          console.warn(`[PLUGIN] 跳过外置插件 ${id}: 与内置插件 id 冲突,不可覆盖`);
          continue;
        }
        if (existingSandbox) {
          existingSandbox.dispose();
          pluginSandboxes.delete(manifest.id);
        }
      }
      if (!isAppVersionCompatible(manifest, appVersion)) {
        sandbox.dispose();
        console.warn(`[PLUGIN] 跳过外置插件 ${id}: 需要 App >= ${manifest.minAppVersion}, 当前 ${appVersion}`);
        continue;
      }
      registerPlugin(manifest, impl);
      pluginSandboxes.set(manifest.id, sandbox);
      loaded++;
      console.log(`[PLUGIN] 已加载外置插件 ${id} (${manifest.type}, ${manifest.capabilities.join("/")}) [沙箱]`);
    } catch (e: any) {
      console.warn(`[PLUGIN] 加载外置插件 ${id} 失败: ${e?.message || e}`);
    }
  }

  // Only auto-seed when scanning the real data/plugins dir (the boot path); the
  // DB is already ready by then, so a second seed creates rows for the new ids
  // without touching existing ones.
  if (!rootDir && loaded > 0) seedPluginRows();
  return loaded;
}

// ==================== 外置推荐插件受控写接口实现(host.playlists / host.sources) ====================
// 这些实现只在沙箱宿主侧调用(由 sandbox.ts 的 hostAsync 转发),插件只拿到受控的
// host.playlists.* / host.sources.* 表面,无法直接触达 DB,权限在调用点由沙箱门控。

function pluginSystemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}

function refreshPluginPlaylistCounts(playlistId: string): void {
  const entries = sqlite.prepare("SELECT * FROM playlist_songs WHERE playlist_id = ?").all(playlistId) as any[];
  let duration = 0, count = 0;
  for (const e of entries) {
    if (e.playable && e.song_id) {
      const song = sqlite.prepare("SELECT duration FROM songs WHERE id = ?").get(e.song_id) as any;
      if (song) { duration += song.duration || 0; count++; }
    } else if (e.external_title) {
      duration += (e.external_duration || 0) / 1000;
      count++;
    }
  }
  sqlite.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
    .run(count, Math.round(duration), new Date().toISOString(), playlistId);
}

function coverArtForSong(songId: string): string | null {
  const song = sqlite.prepare("SELECT id, album_id, cover_art FROM songs WHERE id = ?").get(songId) as any;
  if (!song) return null;
  if (song.cover_art) return `so-${song.id}`;
  if (song.album_id) {
    const album = sqlite.prepare("SELECT cover_art FROM albums WHERE id = ?").get(song.album_id) as any;
    if (album?.cover_art) return `al-${song.album_id}`;
  }
  return null;
}

/** 按固定 id 创建或全量更新一张歌单(同名刷新覆盖)。entries 为混合条目:
 *  { songId } 本地歌曲;或 { externalSongId, externalTitle, externalArtist, externalAlbum?, externalDuration? } 外部条目。 */
async function upsertPluginPlaylist(playlistId: string, opts: any): Promise<any> {
  const now = new Date().toISOString();
  const name = String(opts?.name || "ListenBrainz 推荐");
  const desc = opts?.description || "ListenBrainz 推荐歌单";
  const existing = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(playlistId) as any;
  if (!existing) {
    sqlite.prepare(`INSERT INTO playlists (id, name, owner_id, is_public, comment, cover_art, source_url, source_platform, external_id, sync_enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, NULL, ?, 'listenbrainz', NULL, 0, ?, ?)`)
      .run(playlistId, name, pluginSystemOwnerId(), desc, `lb://${playlistId}`, now, now);
  } else {
    sqlite.prepare("UPDATE playlists SET name = ?, comment = ?, updated_at = ? WHERE id = ?")
      .run(name, desc, now, playlistId);
  }
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(playlistId);
  const entries = Array.isArray(opts?.entries) ? opts.entries : [];
  entries.forEach((e: any, i: number) => {
    if (e && e.songId) {
      const sid = String(e.songId);
      sqlite.prepare(`INSERT INTO playlist_songs (playlist_id, song_id, position, playable, external_song_id, external_title)
        VALUES (?, ?, ?, 1, ?, ?)`)
        .run(playlistId, sid, i, sid, sid);
    } else if (e && (e.externalTitle || e.externalSongId)) {
      sqlite.prepare(`INSERT INTO playlist_songs (playlist_id, position, playable, external_song_id, external_title, external_artist, external_album, external_duration)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?)`)
        .run(playlistId, i, e.externalSongId || null, e.externalTitle || null, e.externalArtist || null, e.externalAlbum || null, e.externalDuration || null);
    }
  });
  refreshPluginPlaylistCounts(playlistId);
  // 封面:确定性选取——优先插件显式指定的 coverSongId;否则宿主自动从歌单自身
  // 可播条目中按 position 取第一首有封面的歌(歌曲封面 > 专辑封面);都没有则
  // 显式清空(避免残留上一次的旧封面,造成「封面不稳定」)。
  const cover = coverForPluginPlaylist(playlistId, opts?.coverSongId ? String(opts.coverSongId) : null);
  sqlite.prepare("UPDATE playlists SET cover_art = ?, updated_at = ? WHERE id = ?").run(cover, now, playlistId);
  // 生成后自动补匹配:仍存在外部(不可播)条目时,后台经已启用在线源再匹配一轮
  // (与每日推荐 rebuildPlaylistEntries 后的 auto-match 行为一致),成功即导入为
  // 可播 web 歌曲。失败不阻塞、不报错。
  const extCount = sqlite.prepare(
    "SELECT COUNT(*) AS n FROM playlist_songs WHERE playlist_id = ? AND playable = 0 AND external_title IS NOT NULL AND external_title <> ''",
  ).get(playlistId) as { n: number };
  if ((extCount?.n || 0) > 0) {
    autoMatchPluginPlaylist(playlistId).catch((e) => {
      console.error(`[auto-match] ${playlistId} 后台匹配失败:`, e?.message || e);
    });
  }
  return sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(playlistId);
}

// 外置插件歌单后台自动匹配:每歌单同时只跑一个(内存锁),经 autoMatch 优先、
// search 兜底的能力插件,把 playable=0 的 external 条目匹配并导入为可播 web 歌曲。
const pluginAutoMatchLocks = new Set<string>();
async function autoMatchPluginPlaylist(playlistId: string): Promise<void> {
  if (pluginAutoMatchLocks.has(playlistId)) return;
  pluginAutoMatchLocks.add(playlistId);
  const started = Date.now();
  try {
    const matcher = getEnabledByCapability("autoMatch")[0] ?? getEnabledByCapability("search")[0];
    if (!matcher || typeof matcher.impl?.search !== "function") return; // 无可用在线源
    const config = getPluginConfig(matcher.manifest.id);
    if (!config) return;
    const { matchUnmatchedPlaylistEntries } = await import("../services/source/online/match.js");
    const result = await matchUnmatchedPlaylistEntries(matcher.manifest.id, config, matcher.impl, playlistId);
    if (result.total > 0) {
      console.log(
        `[auto-match] ${playlistId}: ${result.matched} matched, ${result.noMatch} no-match, ${result.error} errors in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      refreshPluginPlaylistCounts(playlistId); // 条目 playable 变化后刷新计数/时长
    }
  } finally {
    pluginAutoMatchLocks.delete(playlistId);
  }
}

/** 歌单封面:优先指定 songId 的封面;否则按 position 顺序扫自身条目取第一首
 *  有封面的歌(歌曲封面优先于专辑封面);无则返回 null。 */
function coverForPluginPlaylist(playlistId: string, preferSongId: string | null): string | null {
  if (preferSongId) {
    const c = coverArtForSong(preferSongId);
    if (c) return c;
  }
  const row = sqlite.prepare(`
    SELECT ps.song_id AS songId, s.cover_art AS songCover, a.cover_art AS albumCover, a.id AS albumId
    FROM playlist_songs ps
    JOIN songs s ON ps.song_id = s.id
    LEFT JOIN albums a ON a.id = s.album_id
    WHERE ps.playlist_id = ? AND ps.playable = 1 AND ps.song_id IS NOT NULL
      AND (
        (s.cover_art IS NOT NULL AND s.cover_art <> '')
        OR (a.cover_art IS NOT NULL AND a.cover_art <> '')
      )
    ORDER BY ps.position ASC
    LIMIT 1
  `).get(playlistId) as { songId: string; songCover: string | null; albumCover: string | null; albumId: string | null } | undefined;
  if (!row) return null;
  if (row.songCover && row.songCover.trim()) return `so-${row.songId}`;
  if (row.albumCover && row.albumCover.trim() && row.albumId) return `al-${row.albumId}`;
  return null;
}

/** 未匹配本地的曲目,经已启用 source 插件(go-music-dl 等)搜索并导入本地库,返回可播 songId。 */
async function completeFromSources(opts: any): Promise<{ songId: string | null }> {
  const artist = String(opts?.artist || "").trim();
  const title = String(opts?.title || "").trim();
  if (!artist && !title) return { songId: null };
  const query = [artist, title].filter(Boolean).join(" ");
  for (const { manifest, impl } of getEnabledByCapability("search")) {
    if (typeof impl?.search !== "function") continue;
    try {
      // 在线源 search 契约是 (config, { query })——config 里含 baseUrl 等;此前
      // 单参 impl.search(query) 把字符串当 config 传,内置 go-music-dl 读不到
      // baseUrl → 补全恒失败 → 歌单全是外部占位。与 matchToOnlineSong 同约定。
      const config = getPluginConfig(manifest.id) || {};
      const res: any = await impl.search(config, { query });
      const songs: any[] = Array.isArray(res?.songs) ? res.songs : [];
      const cand = songs[0];
      if (!cand || !cand.id) continue;
      // 归一化为 OnlineSongResult,容忍字段名差异(name/title)。
      const normalized: any = {
        id: cand.id,
        source: cand.source || manifest.id,
        name: cand.name || cand.title || title,
        artist: cand.artist || artist,
        album: cand.album || "",
        duration: cand.duration || 0,
        cover: cand.cover || "",
        extra: cand.extra || null,
      };
      const imp = await importOnlineSongs(manifest.id, [normalized], { userId: pluginSystemOwnerId() });
      if (imp?.songs && imp.songs[0]?.id) return { songId: imp.songs[0].id };
    } catch { /* 单源失败跳过,试下一个 */ }
  }
  return { songId: null };
}
