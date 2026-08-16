// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { WebSocketServer } from "ws";
import { makeFsApi, makeCommandApi, makeNetApi, makeWsApi, makeJsenvApi } from "../../src/plugins/discovery.js";
import { loadSandboxedPlugin } from "../../src/plugins/sandbox.js";
import type { SandboxHostEnv } from "../../src/plugins/sandbox.js";

const TMP = path.join(os.tmpdir(), `mf-hostcaps-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------- 宿主实现层 ----------------

describe("host.fs(宿主实现)", () => {
  const pluginDir = path.join(TMP, "fs-plugin");
  const api = makeFsApi(pluginDir);

  it("写/读/列目录/stat 全链路", async () => {
    expect(await api.exists("a.txt")).toBe(false);
    await api.writeFile("a.txt", "hello 世界");
    expect(await api.exists("a.txt")).toBe(true);
    expect(await api.readFile("a.txt")).toBe("hello 世界");
    expect(await api.readdir(".")).toContain("a.txt");
    const st = await api.stat("a.txt");
    expect(st.size).toBe(Buffer.byteLength("hello 世界", "utf8"));
    expect(st.isDirectory).toBe(false);
    // append + rename
    await api.appendFile("a.txt", "!");
    expect(await api.readFile("a.txt")).toBe("hello 世界!");
    await api.rename("a.txt", "b.txt");
    expect(await api.exists("a.txt")).toBe(false);
    expect(await api.exists("b.txt")).toBe(true);
    // mkdir + unlink
    await api.mkdir("sub", { recursive: true });
    expect(await api.stat("sub")).toMatchObject({ isDirectory: true });
    await api.unlink("b.txt");
    expect(await api.exists("b.txt")).toBe(false);
  });

  it("路径穿越被拒绝(../ 与绝对路径)", async () => {
    await api.writeFile("ok.txt", "x");
    await expect(api.readFile("../outside.txt")).rejects.toThrow(/路径越界/);
    await expect(api.writeFile("../../evil.txt", "x")).rejects.toThrow(/路径越界/);
    const absPath = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd";
    await expect(api.readFile(absPath)).rejects.toThrow(/路径越界/);
    // 越界写入绝不能落到插件目录外
    expect(fs.existsSync(path.join(TMP, "evil.txt"))).toBe(false);
  });

  it("不存在的文件返回 null / 空列表", async () => {
    expect(await api.stat("nope.txt")).toBeNull();
    expect(await api.readdir("nope")).toEqual([]);
  });
});

describe("host.command(宿主实现)", () => {
  const api = makeCommandApi();

  it("exec 成功返回 code 0 + stdout", async () => {
    const r = await api.exec(process.execPath, ["-e", "console.log(1+1)"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("2");
  });

  it("exec 失败返回非 0 code + stderr", async () => {
    const r = await api.exec(process.execPath, ["-e", "console.error('boom'); process.exit(3)"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  it("exec 不存在的程序返回 code!=0", async () => {
    const r = await api.exec("no-such-program-xyz", []);
    expect(r.code).not.toBe(0);
  });

  it("start/stop/isRunning 进程生命周期", async () => {
    expect(await api.isRunning("demo")).toBe(false);
    const started = await api.start("demo", process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    expect(started.running).toBe(true);
    expect(await api.isRunning("demo")).toBe(true);
    await api.stop("demo");
    await new Promise((r) => setTimeout(r, 200));
    expect(await api.isRunning("demo")).toBe(false);
  });
});

describe("host.net(宿主实现)", () => {
  it("UDP bind → send → 收包 → close", async () => {
    const api = makeNetApi();
    const recv: any[] = [];
    const a = await api.udpBind({ port: 0 });
    const b = await api.udpBind({ port: 0 });
    api.udpOnData(a.socketId, (d: any) => recv.push(d));
    await api.udpSend(b.socketId, "ping-42", { address: "127.0.0.1", port: a.port });
    await new Promise((r) => setTimeout(r, 200));
    expect(recv.length).toBe(1);
    expect(Buffer.from(recv[0].data, "base64").toString()).toBe("ping-42");
    await api.udpClose(a.socketId);
    await api.udpClose(b.socketId);
  });
});

describe("host.ws(宿主实现)", () => {
  it("connect → 收发 → close", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as any).port;
    const got: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (m) => { got.push(String(m)); ws.send("echo:" + String(m)); });
    });
    try {
      const api = makeWsApi();
      const info = await api.connect(`ws://127.0.0.1:${port}`);
      const msgs: any[] = [];
      api.wsOnMessage(info.socketId, (d: any) => msgs.push(d));
      await api.wsSend(info.socketId, "hi");
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toEqual(["hi"]);
      expect(msgs.some((m) => m.data === "echo:hi")).toBe(true);
      await api.wsClose(info.socketId);
    } finally {
      wss.close();
    }
  });
});

describe("host.jsenv(宿主实现)", () => {
  it("create/execute/destroy 嵌套 QuickJS 环境", async () => {
    const api = makeJsenvApi();
    await api.create("t1", "globalThis.base = 40;");
    const r = await api.execute("t1", "globalThis.base + 2");
    expect(r.ok).toBe(true);
    expect(r.result).toBe(42);
    const bad = await api.execute("t1", "this is not valid js {{{");
    expect(bad.ok).toBe(false);
    await api.destroy("t1");
    await expect(api.execute("t1", "1")).rejects.toThrow(/不存在/);
  });
});

// ---------------- 沙箱桥接层 ----------------

function makeFullEnv(permissions: string[]): SandboxHostEnv {
  const store = new Map<string, any>();
  return {
    version: "1.4.0",
    getConfig: () => ({ baseUrl: "http://demo:18080" }),
    permissions,
    http: async () => ({ ok: true, status: 200, headers: {}, body: "{}" }),
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
      keys: async () => [...store.keys()],
    },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {} },
    songs: {
      list: async () => [],
      search: async () => [],
      getById: async () => null,
    },
    plugin: {
      getHostUrl: async () => "http://host:46400",
      getNetworkAddresses: async () => ["127.0.0.1"],
    },
    fs: makeFsApi(path.join(TMP, "bridge-fs")),
    command: makeCommandApi(),
    net: makeNetApi(),
    ws: makeWsApi(),
    jsenv: makeJsenvApi(),
  };
}

const CAPS_PLUGIN_CODE = `
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-caps",
    name: "高风险能力演示",
    version: "1.0.0",
    type: "source",
    capabilities: ["search"],
    configSchema: [],
    permissions: ["fs", "command", "net", "websocket", "jsenv"]
  },
  create(host) {
    return {
      async search(config, params) {
        if (params.fsTest) {
          await host.fs.writeFile("data.txt", "fs-ok");
          return { songs: [{ id: "r", title: await host.fs.readFile("data.txt"), source: "demo" }] };
        }
        if (params.cmdTest) {
          const r = await host.command.exec("node", ["-e", "console.log(6*7)"]);
          return { songs: [{ id: "r", title: "code:" + r.code + ";out:" + r.stdout.trim(), source: "demo" }] };
        }
        if (params.jsenvTest) {
          await host.jsenv.create("sub", "");
          const r = await host.jsenv.execute("sub", "2+2");
          return { songs: [{ id: "r", title: "jsenv:" + JSON.stringify(r), source: "demo" }] };
        }
        return { songs: [] };
      }
    };
  }
};
`;

describe("沙箱桥接(高风险能力)", () => {
  it("host.fs 透传 + 无 fs 权限拒绝", async () => {
    const { impl } = await loadSandboxedPlugin("demo-caps", CAPS_PLUGIN_CODE, makeFullEnv(["fs"]));
    const r = await impl.search({}, { fsTest: true });
    expect(r.songs[0].title).toBe("fs-ok");

    const denied = await loadSandboxedPlugin("demo-caps", CAPS_PLUGIN_CODE, makeFullEnv(["net"]));
    const r2 = await denied.impl.search({}, { fsTest: true });
    // 无权限时 host.fs 返回 PERMISSION_DENIED 信封,插件读到的 writeFile/readFile 结果都是信封
    expect(r2.songs[0].title).toMatchObject({ ok: false });
  });

  it("host.command 透传(exec 经宿主执行)", async () => {
    const { impl } = await loadSandboxedPlugin("demo-caps", CAPS_PLUGIN_CODE, makeFullEnv(["command"]));
    const r = await impl.search({}, { cmdTest: true });
    expect(r.songs[0].title).toBe("code:0;out:42");
  });

  it("host.jsenv 嵌套环境执行", async () => {
    const { impl } = await loadSandboxedPlugin("demo-caps", CAPS_PLUGIN_CODE, makeFullEnv(["jsenv"]));
    const r = await impl.search({}, { jsenvTest: true });
    expect(r.songs[0].title).toBe('jsenv:{"ok":true,"result":4}');
  });
});
