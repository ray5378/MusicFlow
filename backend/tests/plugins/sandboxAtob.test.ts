// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { loadSandboxedPlugin } from "../../src/plugins/sandbox.js";
import { createPluginCrypto } from "../../src/plugins/pluginCrypto.js";

// ==================== 沙箱 atob 修复回归(真实 QuickJS VM)====================
//
// 旧实现按 4 字符组一次取 24 bit,末组缺位时 s[i+n] 为 undefined → _B64.indexOf
// 返回 -1,其全 1 位经 << / | 污染整个 24 bit → 末组解出 0xFF 垃圾字节;再叠加
// out.slice(0, floor(len*3/4)) 的长度近似。后果:**任何带 padding 的 base64**
// (即明文长度 %3 != 0,btoa 的常见输出)都满足 atob(btoa(x)) !== x。
//
// 修复(见 sandbox.ts prelude):按位累加器 —— 逐字符累加 6 bit,凑满 8 bit 输出一字节,
// 非字母表字符(含 = 与空白)剥除,Latin-1 字节串语义。
//
// 本文件**不在测试里复刻 polyfill 函数体**:所有断言都通过真实 QuickJS VM 里
// 插件代码调用全局 atob/btoa 完成(与插件运行时完全同一条代码路径)。
const ATOB_PLUGIN = `
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-atob", name: "atob", version: "1.0.0", type: "source",
    capabilities: [], configSchema: [], permissions: []
  },
  create(host) {
    return {
      async test(config) {
        // 1) 往返:长度 0..12 全覆盖(含 %3 == 0/1/2 三种余数,padding / 无 padding 两种形态),
        //    字节取自全 0x00..0xFF 区间(含 0x00 与 0xFF 边界)。
        var roundtrip = [];
        for (var n = 0; n <= 12; n++) {
          var s = "";
          for (var i = 0; i < n; i++) s += String.fromCharCode((i * 37 + n) & 0xff);
          roundtrip.push({ n: n, ok: atob(btoa(s)) === s });
        }
        // 2) 独立 KAT(不依赖 btoa):标准 base64 向量
        var katSrc = [
          { b64: "QQ==", want: "A" },
          { b64: "QUI=", want: "AB" },
          { b64: "QUJD", want: "ABC" },
          { b64: "QUJDRA==", want: "ABCD" }
        ];
        var kat = katSrc.map(function (e) { return { b64: e.b64, got: atob(e.b64), want: e.want }; });
        // 3) 宿主参考一致性样本(合法 base64,含空白变体);宿主侧与
        //    Buffer.from(b64,"base64").toString("latin1") 比对。
        var samples = ["", "QQ==", "QUI=", "QUJD", "QUJDRA==", "QUJDREU=", "QUJDREVG", " QQ ==\\n", "QUJ DRA=="];
        var ref = samples.map(function (b) { return { b64: b, got: atob(b) }; });
        return { roundtrip: roundtrip, kat: kat, ref: ref };
      }
    };
  }
};
`;

type AtobResult = {
  roundtrip: { n: number; ok: boolean }[];
  kat: { b64: string; got: string; want: string }[];
  ref: { b64: string; got: string }[];
};

async function runAtobInVm(): Promise<AtobResult> {
  const env = {
    version: "1.2.0",
    getConfig: () => ({}),
    permissions: [] as string[],
    http: async () => ({ ok: false, status: 0, headers: {}, body: "" }),
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      keys: async () => [] as string[],
    },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {} },
    songs: {
      list: async () => [],
      search: async () => [],
      getById: async () => null,
    },
    plugin: {
      getHostUrl: async () => "",
      getNetworkAddresses: async () => [] as string[],
    },
    playlists: {
      upsert: async () => ({ ok: true }),
      get: async () => ({ ok: true }),
      replaceEntries: async () => ({ ok: true }),
      updateCover: async () => ({ ok: true }),
    },
    sources: { complete: async () => ({ ok: true }) },
    crypto: createPluginCrypto(),
  };
  const { impl } = await loadSandboxedPlugin("demo-atob", ATOB_PLUGIN, env as any);
  return (await impl.test({})) as AtobResult;
}

describe("沙箱 atob 修复(真实 QuickJS VM,插件内调用)", () => {
  it("atob(btoa(x)) === x,长度 0..12 覆盖 %3 全部余数(Latin-1 字节串)", async () => {
    const r = await runAtobInVm();
    expect(r.roundtrip).toHaveLength(13);
    const bad = r.roundtrip.filter((e) => !e.ok).map((e) => e.n);
    expect(bad, `以下明文长度往返失败: ${bad.join(",")}`).toEqual([]);
  });

  it("独立 KAT:标准向量解码正确(不依赖 btoa)", async () => {
    const r = await runAtobInVm();
    for (const e of r.kat) {
      expect(e.got, `atob("${e.b64}")`).toBe(e.want);
    }
  });

  it("与 Node Buffer.from(b64,'base64').toString('latin1') 逐字节一致", async () => {
    const r = await runAtobInVm();
    for (const e of r.ref) {
      expect(e.got, `atob(${JSON.stringify(e.b64)})`).toBe(
        Buffer.from(e.b64, "base64").toString("latin1"),
      );
    }
  });
});
