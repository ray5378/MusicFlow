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
import { db } from "../db/index.js";
import { songs } from "../db/schema.js";
import { registerPlugin, getPlugin, getPluginConfig } from "./registry.js";
import { seedPluginRows } from "./builtins.js";
import { validatePermissions } from "./host.js";
import { loadSandboxedPlugin, type SandboxedPlugin, getSandboxModule } from "./sandbox.js";
import { makeScopedStorage } from "./storage.js";
import { createComm } from "./comm.js";
import type { PluginManifest, PluginType, PluginCapability } from "./types.js";

const VALID_TYPES: PluginType[] = [
  "source", "importer", "recommender", "sync",
  "lyrics", "cover", "renderer", "scrobbler", "artist",
];
const VALID_CAPS: PluginCapability[] = [
  "search", "recommend", "playlistSongs", "stream", "lyrics", "webRotation",
  "playlistImport", "playlistFile", "dailyPlaylist", "localPlaylist",
  "playlistSync", "autoMatch",
  "lyricProvider", "coverProvider", "renderer", "scrobbler",
  "artistInfo",
];

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
      const comm = createComm(id, expectedManifest?.permissions ?? []);
      const env = {
        version: process.env.APP_VERSION || "dev",
        getConfig: () => getPluginConfig(id) ?? {},
        permissions: expectedManifest?.permissions ?? [],
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
