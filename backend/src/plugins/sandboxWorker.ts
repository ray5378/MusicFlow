// ==================== 沙箱 worker 线程执行器 ====================
//
// 目的:把插件的 longRunning 批量方法(playlistSongs/searchPlaylists/runDailyJob/
// runSyncJob 等)放到独立 worker 线程执行——插件计算(QuickJS evalCode/泵送/值转换)
// 不再占用主线程事件循环,根治「同步刷新歌单时前端假死」。
//
// 设计:worker 内复用 SandboxedPlugin 的完整 VM 逻辑(init/invoke/evalAsync/泵送分片/
// 软看门狗/内存限制),唯一差异是 host.* 换成「异步桥」——每次 host 调用发 host-call
// 消息回主线程,由主线程用真实 env 执行后回传结果。批量方法只用 http/config/storage/
// log 等无函数句柄能力,天然适配结构化克隆;net/ws/jsenv 等含函数句柄的高级能力
// 在 worker 模式返回「不支持」信封(批量任务用不到,事件仍走主线程 runtime)。
//
// 消息协议(与 SandboxedPluginRemote 配对):
//   主线程 → worker: init / invoke / host-result / dispose
//   worker → 主线程: ready / init-done / invoke-result / host-call

import { parentPort } from "worker_threads";
import { createHash } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync } from "fs";
import { dirname, join } from "path";
import type { SandboxHostEnv } from "./sandbox.js";
import type { PluginManifest } from "./types.js";

// dev(tsx/vitest)跑 .ts 源、dist(node dist/index.js)跑编译产物:静态 import "./sandbox.js"
// 在 dev 下指向不存在的文件,这里运行时动态解析(两边通)。
const HERE = dirname(fileURLToPath(import.meta.url));
const sandboxEntry = existsSync(join(HERE, "sandbox.js"))
  ? join(HERE, "sandbox.js")
  : join(HERE, "sandbox.ts");
const { SandboxedPlugin } = await import(pathToFileURL(sandboxEntry).href) as typeof import("./sandbox.js");

const port = parentPort!;
let sandbox: InstanceType<typeof SandboxedPlugin> | null = null;
let cachedConfig: Record<string, any> = {};
const pendingHost = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let callSeq = 0;

const UNSUPPORTED = (what: string): Promise<any> => Promise.resolve({
  ok: false,
  error: { message: `[SANDBOX_WORKER] 沙箱限制:host.${what} 含函数句柄,无法在后台批量任务(worker)中使用;请改为在主线程交互方法中调用` },
});

function hostCall(name: string, args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const callId = ++callSeq;
    pendingHost.set(callId, { resolve, reject });
    port.postMessage({ type: "host-call", callId, name, args });
  });
}

function makeWorkerEnv(permissions: string[]): SandboxHostEnv {
  const env: SandboxHostEnv = {
    version: process.env.APP_VERSION || "dev",
    getConfig: () => cachedConfig,
    permissions,
    http: (input, init) => hostCall("http", [input, init]),
    // hostSync 唯一能力(crypto.md5):纯计算,worker 本地同步实现,无需回主线程。
    crypto: { md5: (s) => createHash("md5").update(String(s)).digest("hex") },
    storage: {
      get: (k) => hostCall("storage.get", [k]),
      set: (k, v) => hostCall("storage.set", [k, v]),
      delete: (k) => hostCall("storage.delete", [k]),
      keys: () => hostCall("storage.keys", []),
    },
    log: (...args) => console.log("[PLUGIN-WORKER]", ...args),
    comm: {
      send: (t, m) => { void hostCall("comm.send", [t, m]); },
      broadcast: (m) => { void hostCall("comm.broadcast", [m]); },
      on: () => { /* 批量任务不注册事件监听(事件走主线程 runtime) */ },
      off: () => {},
    },
    songs: {
      list: (o) => hostCall("songs.list", [o]),
      search: (q, o) => hostCall("songs.search", [q, o]),
      getById: (id) => hostCall("songs.getById", [id]),
    },
    plugin: {
      getHostUrl: () => hostCall("plugin.getHostUrl", []),
      getNetworkAddresses: () => hostCall("plugin.getNetworkAddresses", []),
    },
    fs: {
      readFile: (p, e) => hostCall("fs.readFile", [p, e]),
      writeFile: (p, d, e) => hostCall("fs.writeFile", [p, d, e]),
      appendFile: (p, d, e) => hostCall("fs.appendFile", [p, d, e]),
      readdir: (p) => hostCall("fs.readdir", [p]),
      unlink: (p) => hostCall("fs.unlink", [p]),
      exists: (p) => hostCall("fs.exists", [p]),
      mkdir: (p, o) => hostCall("fs.mkdir", [p, o]),
      stat: (p) => hostCall("fs.stat", [p]),
      rename: (a, b) => hostCall("fs.rename", [a, b]),
    },
    command: {
      exec: (p, a, o) => hostCall("command.exec", [p, a, o]),
      start: (n, p, a) => hostCall("command.start", [n, p, a]),
      stop: (n) => hostCall("command.stop", [n]),
      isRunning: (n) => hostCall("command.isRunning", [n]),
    },
    net: {
      udpBind: () => UNSUPPORTED("net.udpBind"),
      udpSend: () => UNSUPPORTED("net.udpSend"),
      udpClose: () => UNSUPPORTED("net.udpClose"),
      udpOnData: () => {},
      tcpConnect: () => UNSUPPORTED("net.tcpConnect"),
      tcpSend: () => UNSUPPORTED("net.tcpSend"),
      tcpClose: () => UNSUPPORTED("net.tcpClose"),
      tcpOnData: () => {},
      tcpOnClose: () => {},
    },
    ws: {
      connect: () => UNSUPPORTED("ws.connect"),
      wsSend: () => UNSUPPORTED("ws.wsSend"),
      wsClose: () => UNSUPPORTED("ws.wsClose"),
      wsOnMessage: () => {},
      wsOnClose: () => {},
    },
    jsenv: {
      create: () => UNSUPPORTED("jsenv.create"),
      execute: () => UNSUPPORTED("jsenv.execute"),
      destroy: () => UNSUPPORTED("jsenv.destroy"),
    },
    playlists: {
      upsert: (pl, o) => hostCall("playlists.upsert", [pl, o]),
      get: (pl) => hostCall("playlists.get", [pl]),
      list: () => hostCall("playlists.list", []),
      replaceEntries: (pl, e) => hostCall("playlists.replaceEntries", [pl, e]),
      updateCover: (pl, c) => hostCall("playlists.updateCover", [pl, c]),
      findBySource: (sp, ei) => hostCall("playlists.findBySource", [sp, ei]),
      delete: (pl) => hostCall("playlists.delete", [pl]),
      importSongs: (providerId, songs) => hostCall("playlists.importSongs", [providerId, songs]),
    },
    sources: {
      complete: (o) => hostCall("sources.complete", [o]),
    },
  };
  return env;
}

port.on("message", async (msg: any) => {
  try {
    switch (msg.type) {
      case "init": {
        const env = makeWorkerEnv(msg.permissions || []);
        const sb = new SandboxedPlugin(msg.id, env);
        await sb.init(msg.code, msg.expectedManifest as PluginManifest | undefined);
        sandbox = sb;
        port.postMessage({ type: "init-done", ok: true });
        break;
      }
      case "invoke": {
        if (!sandbox) {
          port.postMessage({ type: "invoke-result", invokeId: msg.invokeId, ok: false, error: "沙箱未初始化" });
          break;
        }
        // config 随消息携带,invoke 内部 refreshConfig() 会读 workerEnv.getConfig()。
        cachedConfig = msg.config || {};
        try {
          const value = await sandbox.invoke(msg.method, msg.args);
          port.postMessage({ type: "invoke-result", invokeId: msg.invokeId, ok: true, value });
        } catch (e: any) {
          port.postMessage({
            type: "invoke-result", invokeId: msg.invokeId, ok: false,
            error: String((e && e.message) || e),
            sandboxCode: (e as any)?.sandboxCode,
            hint: (e as any)?.hint,
          });
        }
        break;
      }
      case "host-result": {
        const p = pendingHost.get(msg.callId);
        if (p) {
          pendingHost.delete(msg.callId);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(new Error(msg.error || "host 调用失败"));
        }
        break;
      }
      case "dispose": {
        try { sandbox?.dispose(); } catch { /* ignore */ }
        process.exit(0);
        break;
      }
      default: break;
    }
  } catch (e: any) {
    // 消息处理级兜底(init 失败等)
    if (msg.type === "init") port.postMessage({ type: "init-done", ok: false, error: String((e && e.message) || e) });
    else if (msg.type === "invoke") port.postMessage({ type: "invoke-result", invokeId: msg.invokeId, ok: false, error: String((e && e.message) || e) });
  }
});

port.postMessage({ type: "ready" });
