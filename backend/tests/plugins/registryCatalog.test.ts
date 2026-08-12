// MUST be the first import: redirects DATA_DIR to a temp dir before the backend
// opens its SQLite DB at module-load time.
import "./_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { initDatabase } from "../../src/db/index.js";
import { hasTar, TMP_DATA_DIR } from "./_env.js";
import {
  addRegistry,
  listRegistries,
  removeRegistry,
  listMarketplace,
  findFile,
  findTopDir,
  installPlugin,
  seedDefaultRegistry,
  officialRegistryUrl,
} from "../../src/plugins/registryCatalog.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterAll(() => {
  try { fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch {}
});

describe("registry CRUD", () => {
  it("rejects a non-http(s) registry URL", () => {
    expect(() => addRegistry("ftp://example.com/reg.json")).toThrow(/http/);
  });

  it("adds, lists and removes a registry", () => {
    const id = addRegistry("https://example.com/registry.json");
    expect(typeof id).toBe("string");
    expect(listRegistries().some((r) => r.id === id && r.url === "https://example.com/registry.json")).toBe(true);
    removeRegistry(id);
    expect(listRegistries().some((r) => r.id === id)).toBe(false);
  });
});

describe("marketplace listing", () => {
  const registryUrls = [
    "https://reg.test/a.json",
    "https://reg.test/b.json",
    "https://reg.test/dead.json",
  ];
  const added: string[] = [];

  const mockFetch = async (url: any): Promise<any> => {
    const u = String(url);
    if (u === "https://reg.test/a.json") {
      return { ok: true, status: 200, json: async () => ({ plugins: ["https://reg.test/p1.json", "https://reg.test/p1-v2.json"], includes: ["https://reg.test/b.json"] }) };
    }
    if (u === "https://reg.test/b.json") {
      return { ok: true, status: 200, json: async () => ({ plugins: ["https://reg.test/p3.json"], includes: [] }) };
    }
    if (u === "https://reg.test/dead.json") {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (u === "https://reg.test/p1.json") {
      return { ok: true, status: 200, json: async () => ({ id: "p1", name: "P1", version: "1.0.0", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [], downloadUrl: "https://x/p1.zip" }) };
    }
    if (u === "https://reg.test/p1-v2.json") {
      return { ok: true, status: 200, json: async () => ({ id: "p1", name: "P1", version: "2.0.0", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [], downloadUrl: "https://x/p1-v2.zip" }) };
    }
    if (u === "https://reg.test/p3.json") {
      return { ok: true, status: 200, json: async () => ({ id: "p3", name: "P3", version: "1.0.0", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [], downloadUrl: "https://x/p3.zip" }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  let origFetch: any;
  beforeAll(() => {
    origFetch = globalThis.fetch;
    (globalThis as any).fetch = mockFetch as any;
    for (const u of registryUrls) added.push(addRegistry(u));
  });
  afterAll(() => {
    (globalThis as any).fetch = origFetch;
    for (const id of added) removeRegistry(id);
  });

  it("keeps every source of the same id (user picks which to install) and follows includes", async () => {
    const m = await listMarketplace();
    // p1 有两个来源(p1.json v1.0.0 / p1-v2.json v2.0.0),都不合并;每个来源带 sourceUrl。
    expect(m.map((x) => x.id).sort()).toEqual(["p1", "p1", "p3"]);
    const p1Sources = m.filter((x) => x.id === "p1");
    expect(p1Sources).toHaveLength(2);
    expect(p1Sources.map((x) => x.sourceUrl).sort()).toEqual([
      "https://reg.test/p1-v2.json",
      "https://reg.test/p1.json",
    ]);
    const v1 = p1Sources.find((x) => x.version === "1.0.0");
    expect(v1?.downloadUrl).toBe("https://x/p1.zip");
    const v2 = p1Sources.find((x) => x.version === "2.0.0");
    expect(v2?.downloadUrl).toBe("https://x/p1-v2.zip");
    expect(m.find((x) => x.id === "p3")?.sourceUrl).toBe("https://reg.test/p3.json");
  });

  it("tolerates an unreachable registry without dropping the rest", async () => {
    const m = await listMarketplace();
    expect(m.find((x) => x.id === "p3")).toBeTruthy();
  });
});

describe("extraction helpers", () => {
  it("finds a manifest nested in a subdirectory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-extr-"));
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "plugin.json"), JSON.stringify({ id: "x" }));
    expect(findFile(root, "plugin.json")).toBe(path.join(root, "sub", "plugin.json"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prefers a single top-level directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-top-"));
    fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "pkg", "index.js"), "x");
    expect(findTopDir(root)).toBe(path.join(root, "pkg"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null when there are multiple top-level entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-top2-"));
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, "b"));
    expect(findTopDir(root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// Kept last: it mutates the shared registry table (and sets the seeded flag),
// so running it after the marketplace tests avoids perturbing their fixtures.
describe("official registry seeding", () => {
  const url = officialRegistryUrl();

  afterAll(() => {
    for (const r of listRegistries()) if (r.url === url) removeRegistry(r.id);
  });

  it("seeds the official registry once, then is a no-op", () => {
    expect(url).toMatch(/^https:\/\/.+registry\.json$/);
    expect(seedDefaultRegistry()).toBe(true);
    expect(listRegistries().filter((r) => r.url === url).length).toBe(1);
    // Re-running (i.e. every subsequent boot) must not duplicate the row.
    expect(seedDefaultRegistry()).toBe(false);
    expect(listRegistries().filter((r) => r.url === url).length).toBe(1);
  });

  it("does not re-add a registry the admin deliberately removed", () => {
    for (const r of listRegistries()) if (r.url === url) removeRegistry(r.id);
    expect(listRegistries().some((r) => r.url === url)).toBe(false);
    // The seeded flag survives the removal, so boot must leave it removed.
    expect(seedDefaultRegistry()).toBe(false);
    expect(listRegistries().some((r) => r.url === url)).toBe(false);
  });
});

const tarOk = hasTar();
describe.skipIf(!tarOk)("installPlugin (download + extract + hot-register)", () => {
  it("downloads a tarball, extracts it and re-discovers the plugin", async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "mf-plug-"));
    fs.writeFileSync(
      path.join(src, "plugin.json"),
      JSON.stringify({ id: "installed-plug", name: "Installed", version: "1.0.0", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [] }),
    );
    fs.writeFileSync(path.join(src, "index.js"), "export const manifest = globalThis.__m; export const impl = {};");
    const archive = path.join(os.tmpdir(), `mf-plug-${Date.now()}.tar`);
    const toTarPath = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
    const tarArgs = ["-cf", toTarPath(archive), "-C", toTarPath(src), "."];
    if (process.platform === "win32") tarArgs.unshift("--force-local");
    execFileSync("tar", tarArgs, { windowsHide: true });

    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (): Promise<any> => {
      const buf = fs.readFileSync(archive);
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };

    try {
      const r = await installPlugin("https://x/installed-plug.tar");
      expect(r.id).toBe("installed-plug");
      const dest = path.join(TMP_DATA_DIR, "plugins", "installed-plug");
      expect(fs.existsSync(path.join(dest, "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(dest, "plugin.json"))).toBe(true);
    } finally {
      (globalThis as any).fetch = origFetch;
      fs.rmSync(path.join(TMP_DATA_DIR, "plugins", "installed-plug"), { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
    }
  });
});
