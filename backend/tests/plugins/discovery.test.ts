import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  validateManifest,
  compareVersion,
  isAppVersionCompatible,
  safeResolve,
  discoverExternalPlugins,
  derivePermissions,
} from "../../src/plugins/discovery.js";
import { registerPlugin, getPlugin } from "../../src/plugins/registry.js";
import { pluginSandboxes } from "../../src/plugins/discovery.js";

const tmp = path.join(os.tmpdir(), `mfv2-plugins-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

function writePlugin(id: string, body: string) {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), body, "utf8");
}

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true });

  // 1) A fully valid importer plugin (QuickJS 沙箱契约)。
  writePlugin(
    "valid-plugin",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "valid-plugin",
        name: "Valid Plugin",
        version: "1.0.0",
        type: "importer",
        description: "a valid test plugin",
        capabilities: ["playlistImport"],
        configSchema: [],
      },
      create() { return { canHandle: () => false, fetchPlaylist: async () => ({}) }; },
    };`,
  );

  // 2) Invalid manifest (illegal capability + bad id via missing field).
  writePlugin(
    "badmanifest",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "badmanifest",
        name: "Bad",
        version: "1.0.0",
        type: "importer",
        capabilities: ["notARealCapability"],
        configSchema: [],
      },
      create() { return {}; },
    };`,
  );

  // 3) Requires a newer app than what we'll scan with.
  writePlugin(
    "oldversion",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "oldversion",
        name: "Old Version",
        version: "1.0.0",
        type: "importer",
        capabilities: ["playlistImport"],
        minAppVersion: "2.0.0",
        configSchema: [],
      },
      create() { return {}; },
    };`,
  );

  // 4) Conflicts with an already-registered id.
  writePlugin(
    "conflict-plugin",
    `globalThis.__mfPlugin = {
      manifest: {
        id: "conflict-plugin",
        name: "Conflict",
        version: "1.0.0",
        type: "importer",
        capabilities: ["playlistImport"],
        configSchema: [],
      },
      create() { return {}; },
    };`,
  );

  // 5) A plain file (not a directory) — discovery should skip it.
  fs.writeFileSync(path.join(tmp, "not-a-dir.js"), "export const x = 1;", "utf8");

  // 6) plugin.json 缺失 permissions(旧分发包/手工放置)但 index.js 声明了 net。
  //    沙箱权限必须用 index.js manifest 兜底,否则 host.http 被拒(HTTP undefined)。
  const permDir = path.join(tmp, "perm-fallback");
  fs.mkdirSync(permDir, { recursive: true });
  fs.writeFileSync(
    path.join(permDir, "plugin.json"),
    JSON.stringify({ id: "perm-fallback", name: "Perm", version: "1.0.0", type: "source", capabilities: ["stream"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(permDir, "index.js"),
    `globalThis.__mfPlugin = {
      manifest: {
        id: "perm-fallback", name: "Perm", version: "1.0.0", type: "source",
        capabilities: ["stream"], configSchema: [], permissions: ["net"],
      },
      create() { return { streamUrl: () => "http://x" }; },
    };`,
    "utf8",
  );

  // 6b) P0 根因用例:plugin.json 与 index.js **都**不声明 permissions(历史
  //     分发事故的最坏情形——开发者漏写 net),但 capabilities 是网络型
  //     (search/recommend/stream/lyricProvider)。discovery 必须按能力推导
  //     自动补齐 net,否则 test/search/lyrics 会因 host.http 被拒而静默失效。
  const derivedDir = path.join(tmp, "perm-derived");
  fs.mkdirSync(derivedDir, { recursive: true });
  fs.writeFileSync(
    path.join(derivedDir, "plugin.json"),
    JSON.stringify({
      id: "perm-derived", name: "Derived", version: "1.0.0", type: "source",
      capabilities: ["search", "recommend", "stream", "lyricProvider"],
      configSchema: [],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(derivedDir, "index.js"),
    `globalThis.__mfPlugin = {
      manifest: {
        id: "perm-derived", name: "Derived", version: "1.0.0", type: "source",
        capabilities: ["search", "recommend", "stream", "lyricProvider"], configSchema: [],
      },
      create() { return { streamUrl: () => "http://x", search: async () => ({ songs: [] }) }; },
    };`,
    "utf8",
  );

  // 6c) 最坏情形兜底:source 插件声明了「非网络型」capabilities(playlistFile→fs),
  //     **不写任何 permissions**。靠 capabilities 自身推导只拿到 fs、拿不到 net;
  //     但 source 类型按契约必联网 → 规则补 net,确保 test/search/lyrics 不因
  //     host.http 被拒而静默失效(HTTP undefined)。
  const srcNopermDir = path.join(tmp, "src-noperm");
  fs.mkdirSync(srcNopermDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcNopermDir, "plugin.json"),
    JSON.stringify({ id: "src-noperm", name: "SrcNoPerm", version: "1.0.0", type: "source", capabilities: ["playlistFile"], configSchema: [] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(srcNopermDir, "index.js"),
    `globalThis.__mfPlugin = {
      manifest: { id: "src-noperm", name: "SrcNoPerm", version: "1.0.0", type: "source", capabilities: ["playlistFile"], configSchema: [] },
      create() { return { streamUrl: () => "http://x", test: async () => ({ success: true }) }; },
    };`,
    "utf8",
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(
      validateManifest({
        id: "abc-1",
        name: "X",
        version: "1.0.0",
        type: "source",
        capabilities: ["search"],
        configSchema: [],
      }),
    ).toBeNull();
  });
  it("rejects missing / malformed id", () => {
    expect(validateManifest({ name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: [] })).toMatch(/id/);
    expect(validateManifest({ id: "-bad", name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: [] })).toMatch(/id/);
    expect(validateManifest({ id: "has space", name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: [] })).toMatch(/id/);
  });
  it("rejects illegal type", () => {
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "widget", capabilities: ["search"], configSchema: [] })).toMatch(/type/);
  });
  it("rejects empty / illegal capabilities", () => {
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "source", capabilities: [], configSchema: [] })).toMatch(/capabilities/);
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "source", capabilities: ["bogus"], configSchema: [] })).toMatch(/capabilities/);
  });
  it("rejects non-array configSchema", () => {
    expect(validateManifest({ id: "p", name: "X", version: "1", type: "source", capabilities: ["search"], configSchema: {} })).toMatch(/configSchema/);
  });
});

describe("compareVersion", () => {
  it("orders semver-ish strings", () => {
    expect(compareVersion("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersion("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersion("1.1.0", "1.2.0")).toBeLessThan(0);
    expect(compareVersion("2.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersion("1.0", "1.0.1")).toBeLessThan(0);
  });
});

describe("isAppVersionCompatible", () => {
  it("dev builds accept anything", () => {
    expect(isAppVersionCompatible({ id: "x", name: "x", version: "1", type: "source", capabilities: [], configSchema: [], minAppVersion: "99.0.0" }, "dev")).toBe(true);
  });
  it("missing minAppVersion is always compatible", () => {
    expect(isAppVersionCompatible({ id: "x", name: "x", version: "1", type: "source", capabilities: [], configSchema: [] }, "1.0.0")).toBe(true);
  });
  it("respects the floor", () => {
    const m = { id: "x", name: "x", version: "1", type: "source", capabilities: [], configSchema: [], minAppVersion: "1.5.0" };
    expect(isAppVersionCompatible(m, "1.5.0")).toBe(true);
    expect(isAppVersionCompatible(m, "1.4.9")).toBe(false);
    expect(isAppVersionCompatible(m, "2.0.0")).toBe(true);
  });
});

describe("safeResolve (path-traversal guard)", () => {
  it("keeps paths inside the root", () => {
    expect(safeResolve("/data/plugins", "my-plugin")).toBe(path.resolve("/data/plugins", "my-plugin", "index.js"));
  });
  it("rejects escape attempts", () => {
    expect(safeResolve("/data/plugins", "../evil")).toBeNull();
    expect(safeResolve("/data/plugins", "../../etc")).toBeNull();
  });
});

describe("derivePermissions (P0 能力推导权限)", () => {
  it("网络型能力一律推导 net", () => {
    expect(derivePermissions(["search", "recommend", "stream", "lyricProvider", "coverProvider"])).toEqual(["net"]);
  });
  it("调度型能力推导 storage(+net 当实现联网)", () => {
    expect(derivePermissions(["dailyPlaylist"]).sort()).toEqual(["net", "storage"]);
    expect(derivePermissions(["localPlaylist"])).toEqual(["storage"]);
  });
  it("文件型能力推导 fs,无能力/纯本地能力推导为空", () => {
    expect(derivePermissions(["playlistFile"])).toEqual(["fs"]);
    expect(derivePermissions(["webRotation"])).toEqual([]);
    expect(derivePermissions(undefined)).toEqual([]);
    expect(derivePermissions([])).toEqual([]);
  });
  it("未知能力不参与推导", () => {
    expect(derivePermissions(["search", "notACap"] as any)).toEqual(["net"]);
  });
});

describe("discoverExternalPlugins", () => {
  let loaded = 0;

  // 预注册冲突插件 + 扫描一次,保证 pluginSandboxes(perm-fallback /
  // perm-derived / src-noperm 等)就绪,使读沙箱的用例不依赖"先跑扫描用例"
  // 的执行顺序(shuffle 时顺序不定 → 曾见 undefined)。
  beforeAll(async () => {
    registerPlugin(
      { id: "conflict-plugin", name: "Builtin", version: "1", type: "importer", capabilities: ["playlistImport"], configSchema: [] },
      {},
    );
    loaded = await discoverExternalPlugins("1.0.0", tmp);
  });

  it("loads valid plugins, skips invalid / too-old / conflicting / non-dir", () => {
    expect(loaded).toBe(4); // valid-plugin + perm-fallback + perm-derived + src-noperm
    expect(getPlugin("valid-plugin")).toBeDefined();
    expect(getPlugin("badmanifest")).toBeUndefined();
    expect(getPlugin("oldversion")).toBeUndefined(); // needs 2.0.0
    expect(getPlugin("conflict-plugin")).toBeDefined(); // the pre-registered builtin wins
  });

  it("plugin.json 缺 permissions 时用 index.js manifest 兜底,host.http 不被拒", () => {
    const sb = pluginSandboxes.get("perm-fallback");
    expect(sb).toBeDefined();
    // 沙箱权限已兜底为 ["net"] → host.http(net) 可调用;若未兜底会是空权限被拒。
    // (hasPerm 是 sandbox 内部方法,这里通过 env 权限已注入验证:直接看沙箱能访问 net 权限)
    expect((sb as any).env?.permissions).toEqual(["net"]);
  });

  it("P0:capabilities 是网络型但全程未声明 permissions → 按能力推导自动补齐 net", () => {
    const sb = pluginSandboxes.get("perm-derived");
    expect(sb).toBeDefined();
    const perms = (sb as any).env?.permissions as string[];
    // 既没在 plugin.json 也没在 index.js 写 permissions,但 capability 含
    // search/recommend/stream/lyricProvider → 推导结果必须含 "net",
    // 否则 host.http 会被权限门控拒绝(测试连接 HTTP undefined / 歌词拿不到)。
    expect(perms).toContain("net");
  });

  it("P0+:source 插件只声明非网络型 capabilities 且不写 permissions 也按契约补 net(杜绝 HTTP undefined)", () => {
    const sb = pluginSandboxes.get("src-noperm");
    expect(sb).toBeDefined();
    const perms = (sb as any).env?.permissions as string[];
    // 仅靠 capabilities 推导只能拿到 fs(playlistFile→fs);source 类型契约补 net,
    // 确保 test/search/lyrics 不因 host.http 被拒而静默失效(HTTP undefined)。
    expect(perms).toContain("net");
  });

  it("returns 0 when the root is absent", async () => {
    expect(await discoverExternalPlugins("1.0.0", path.join(os.tmpdir(), "does-not-exist-xyz"))).toBe(0);
  });
});
