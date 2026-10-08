// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { loadSandboxedPlugin } from "../../src/plugins/sandbox.js";
import { createPluginCrypto } from "../../src/plugins/pluginCrypto.js";

// ==================== host.crypto 双通道一致性 KAT ====================
//
// host.crypto.* 有两条返回路径,形态必须完全一致:
//   ① 主线程交互通道:sandbox.ts injectHost → hostSync → this.env.crypto.*
//      (返回值经 jsToHandle:只认 null/boolean/string/number/Array/普通对象)
//   ② worker 批量通道:manifest.longRunning 方法 → sandboxWorker.ts makeWorkerEnv
//      → createPluginCrypto() 直连(返回值经结构化克隆,认 TypedArray)
//
// 若原语返回 TypedArray,① 会把它摊成 {0:…} 普通对象、② 却回传真 TypedArray
// → 双通道形态不对称(后台任务与前台交互行为分叉)。因此 base64Encode /
// base64Decode / utf8Decode 一律**纯字符串出入参**,本测试把「同一组用例在两通道
// 逐字节相同且类型一致」固化为回归门禁。
const DUAL_PLUGIN = `
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-crypto-dual", name: "crypto dual", version: "1.0.0", type: "source",
    capabilities: ["search"], configSchema: [], permissions: ["crypto"],
    longRunning: { search: 30000 }
  },
  create(host) {
    var CASES = [
      { id: "b64dec-latin1",   op: "base64Decode", input: "Qf8=", opts: null },
      { id: "b64dec-hex",      op: "base64Decode", input: "Qf8=", opts: { outputEncoding: "hex" } },
      { id: "b64dec-p1",       op: "base64Decode", input: "QUJDRA==", opts: null },
      { id: "b64dec-p2",       op: "base64Decode", input: "QUJDREU=", opts: null },
      { id: "b64dec-ws",       op: "base64Decode", input: " QQ == ", opts: null },
      { id: "b64dec-bad",      op: "base64Decode", input: "!!!", opts: null },
      { id: "utf8dec-multi",   op: "utf8Decode", input: "\\u00e4\\u00bd\\u00a0\\u00e5\\u00a5\\u00bd", opts: null },
      { id: "utf8dec-hex",     op: "utf8Decode", input: "e4bda0e5a5bd", opts: { inputEncoding: "hex" } },
      { id: "utf8dec-bad",     op: "utf8Decode", input: "\\u00ff\\u00fe", opts: null },
      { id: "utf8dec-bom",     op: "utf8Decode", input: "\\u00ef\\u00bb\\u00bf", opts: null },
      { id: "b64enc-latin1",   op: "base64Encode", input: "\\u0041\\u00ff", opts: { inputEncoding: "latin1" } },
      { id: "b64enc-p1",       op: "base64Encode", input: "\\u0041\\u0042\\u0043\\u0044", opts: { inputEncoding: "latin1" } },
      { id: "b64enc-p2",       op: "base64Encode", input: "\\u0041\\u0042\\u0043\\u0044\\u0045", opts: { inputEncoding: "latin1" } },
      { id: "b64enc-utf8",     op: "base64Encode", input: "hello", opts: null }
    ];
    function call(c) {
      if (c.op === "base64Encode") return host.crypto.base64Encode(c.input, c.opts || undefined);
      if (c.op === "base64Decode") return host.crypto.base64Decode(c.input, c.opts || undefined);
      return host.crypto.utf8Decode(c.input, c.opts || undefined);
    }
    function runCases() {
      return CASES.map(function (c) {
        var got = call(c);
        return { id: c.id, op: c.op, input: c.input, opts: c.opts, got: got, kind: typeof got };
      });
    }
    return {
      // longRunning 声明的方法 → worker 通道
      async search(config, params) { return { channel: "worker", results: runCases() }; },
      // 交互方法(未列入 longRunning)→ 主线程通道
      async test(config) { return { success: true, channel: "main", results: runCases() }; }
    };
  }
};
`;

type Case = { id: string; op: string; input: string; opts: unknown; got: unknown; kind: string };
type Dual = { channel: string; results: Case[] };

/** 判定该用例预期是错误信封(与实现语义对齐,与通道无关)。 */
function isErrCase(c: Case): boolean {
  return (c.op === "base64Decode" && c.input === "!!!") ||
    (c.op === "utf8Decode" && c.input === "\u00ff\u00fe");
}

function sameOpts(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function pick(d: Dual, id: string): Case[] {
  return d.results.filter((r) => r.id === id);
}

function one(d: Dual, id: string): Case {
  const hits = pick(d, id);
  expect(hits.length, `用例 ${id} 在 ${d.channel} 通道应恰好出现一次`).toBe(1);
  return hits[0];
}

/** 失败时把实际值打进消息,便于定位。 */
function dbg(c: Case): string {
  return `${c.id}[${c.op}] kind=${c.kind} got=${JSON.stringify(c.got)}`;
}

async function runDual(): Promise<{ main: Dual; worker: Dual }> {
  const env = {
    version: "1.2.0",
    getConfig: () => ({}),
    permissions: ["crypto"],
    http: async () => ({ ok: false, status: 0, headers: {}, body: "" }),
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {} },
    songs: { list: async () => [], search: async () => [], getById: async () => null },
    plugin: { getHostUrl: async () => "", getNetworkAddresses: async () => [] },
    playlists: {
      upsert: async () => ({ ok: true }),
      get: async () => ({ ok: true }),
      replaceEntries: async () => ({ ok: true }),
      updateCover: async () => ({ ok: true }),
    },
    sources: { complete: async () => ({ ok: true }) },
    crypto: createPluginCrypto(),
  };
  const { impl } = await loadSandboxedPlugin("demo-crypto-dual", DUAL_PLUGIN, env as any);
  const main = (await (impl as any).test({})) as Dual;
  const worker = (await (impl as any).search({}, {})) as Dual;
  return { main, worker };
}

describe("host.crypto 双通道一致性(主线程 vs worker/longRunning)", () => {
  it("同一组用例:主线程与 worker 通道返回逐字节相同", async () => {
    const { main, worker } = await runDual();
    expect(main.channel).toBe("main");
    expect(worker.channel).toBe("worker");
    expect(worker.results.length).toBe(main.results.length);
    expect(worker.results.map((r) => dbg(r))).toEqual(main.results.map((r) => dbg(r)));
    expect(worker.results).toEqual(main.results);
  });

  it("类型一致:成功用例两通道均为 string,错误用例两通道均为 { error } 对象", async () => {
    const { main, worker } = await runDual();
    for (let i = 0; i < main.results.length; i++) {
      const a = main.results[i];
      const b = worker.results[i];
      expect(b.kind, `case#${i} ${dbg(a)} 两通道类型须一致`).toBe(a.kind);
      if (isErrCase(a)) {
        expect(a.kind, `case#${i} ${dbg(a)} 应为错误信封(object)`).toBe("object");
        expect(typeof (a.got as { error?: unknown }).error, `case#${i} ${dbg(a)}`).toBe("string");
      } else {
        expect(a.kind, `case#${i} ${dbg(a)} 主线程应为 string`).toBe("string");
        expect(b.kind, `case#${i} ${dbg(a)} worker 应为 string`).toBe("string");
      }
    }
  });

  it("padded 环回(两通道同值):len%3==1 / %3==2 各至少一条", async () => {
    const { main, worker } = await runDual();
    // %3==1(4 字节 → 2 个 =)与 %3==2(5 字节 → 1 个 =)的编码
    expect(one(main, "b64enc-p1").got, "b64enc-p1 main").toBe("QUJDRA==");
    expect(one(main, "b64enc-p2").got, "b64enc-p2 main").toBe("QUJDREU=");
    expect(one(worker, "b64enc-p1").got, "b64enc-p1 worker").toBe("QUJDRA==");
    expect(one(worker, "b64enc-p2").got, "b64enc-p2 worker").toBe("QUJDREU=");
    // 对应解码环回
    expect(one(main, "b64dec-p1").got, "b64dec-p1 main").toBe("ABCD");
    expect(one(main, "b64dec-p2").got, "b64dec-p2 main").toBe("ABCDE");
    expect(one(worker, "b64dec-p1").got, "b64dec-p1 worker").toBe("ABCD");
    expect(one(worker, "b64dec-p2").got, "b64dec-p2 worker").toBe("ABCDE");
  });

  it("锚点值:latin1 二进制串 / hex / 多字节 UTF-8 / BOM / 非法序列,两通道一致", async () => {
    const { main, worker } = await runDual();
    // b64dec-latin1:Qf8= → latin1 字节 41 FF
    // 注:锚点刻意避开 U+0000 —— 含 NUL 的字符串跨 QuickJS 桥(jsToHandle/dump)会被
    // 截断,这是宿主桥接层的固有特性(两通道同样如此,不影响一致性结论);
    // 原语本身对 0x00 的正确性由 pluginCrypto.test.ts(纯 Node,不过桥)覆盖。
    for (const d of [main, worker]) {
      const c = one(d, "b64dec-latin1");
      const s = c.got as string;
      expect(c.kind, `b64dec-latin1 ${d.channel} ${dbg(c)}`).toBe("string");
      expect(s.length, `b64dec-latin1 ${d.channel} ${dbg(c)}`).toBe(2);
      expect(s.charCodeAt(0), `b64dec-latin1 ${d.channel} ${dbg(c)}`).toBe(0x41);
      expect(s.charCodeAt(1), `b64dec-latin1 ${d.channel} ${dbg(c)}`).toBe(0xff);
    }
    expect(one(main, "b64dec-hex").got, "b64dec-hex main").toBe("41ff");
    expect(one(worker, "b64dec-hex").got, "b64dec-hex worker").toBe("41ff");
    expect(one(main, "b64dec-ws").got, "b64dec-ws main(容忍空白)").toBe("A");
    expect(one(worker, "b64dec-ws").got, "b64dec-ws worker(容忍空白)").toBe("A");
    // 多字节 UTF-8
    expect(one(main, "utf8dec-multi").got, "utf8dec-multi main").toBe("你好");
    expect(one(worker, "utf8dec-multi").got, "utf8dec-multi worker").toBe("你好");
    expect(one(main, "utf8dec-hex").got, "utf8dec-hex main").toBe("你好");
    expect(one(worker, "utf8dec-hex").got, "utf8dec-hex worker").toBe("你好");
    // 非法 UTF-8 → { error },不静默替换
    for (const d of [main, worker]) {
      const e = one(d, "utf8dec-bad").got as { error?: unknown };
      expect(typeof e, `utf8dec-bad ${d.channel}`).toBe("object");
      expect(typeof e.error, `utf8dec-bad ${d.channel}`).toBe("string");
    }
    // BOM 保留为 U+FEFF(与 Buffer.toString("utf8") 一致)
    expect(one(main, "utf8dec-bom").got, "utf8dec-bom main").toBe("\ufeff");
    expect(one(worker, "utf8dec-bom").got, "utf8dec-bom worker").toBe("\ufeff");
    // base64Encode 锚点
    expect(one(main, "b64enc-latin1").got, "b64enc-latin1 main").toBe("Qf8=");
    expect(one(worker, "b64enc-latin1").got, "b64enc-latin1 worker").toBe("Qf8=");
    expect(one(main, "b64enc-utf8").got, "b64enc-utf8 main").toBe("aGVsbG8=");
    expect(one(worker, "b64enc-utf8").got, "b64enc-utf8 worker").toBe("aGVsbG8=");
  });
});
