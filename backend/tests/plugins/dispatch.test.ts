// Unit tests for the capability-driven dispatch layer: providers (lyrics /
// cover, first-match-wins), renderers (device casting) and scrobblers
// (playback event fan-out). Uses in-memory mock plugins + minimal DB rows so
// no network / DLNA is touched.
//
// NOTE: this MUST be the first import so DATA_DIR points at an isolated temp DB
// before src/db/index.js opens the SQLite file at module-load time. Without it
// the `plugin_health` rows for the mock plugins persist across runs and the
// "first failure => yellow" assertion sees a stale `red`.
import "./_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { sqlite } from "../../src/db/index.js";
import { TMP_DATA_DIR } from "./_env.js";
import { initDatabase } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { registerPlugin } from "../../src/plugins/registry.js";
import type { PluginManifest, LyricProviderPlugin, CoverProviderPlugin, RendererPlugin, ScrobblerPlugin } from "../../src/plugins/types.js";

import { hasLyricProvider, hasCoverProvider, searchLyrics, searchCover } from "../../src/plugins/providers.js";
import { getRendererPlugins, discoverRenderers, castToRenderer, controlRenderer } from "../../src/plugins/renderers.js";
import { getScrobblerPlugins, notifyScrobble } from "../../src/plugins/scrobblers.js";
import { getHealth } from "../../src/plugins/health.js";

// ---- mock manifests / impls -------------------------------------------------
const failLyric: PluginManifest = { id: "mock-lyric-fail", name: "Fail Lyric", version: "1", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [], permissions: ["net"] };
const failLyricImpl: LyricProviderPlugin = { searchLyrics: async () => { throw new Error("boom"); } };

const okLyric: PluginManifest = { id: "mock-lyric-ok", name: "OK Lyric", version: "1", type: "lyrics", capabilities: ["lyricProvider"], configSchema: [] };
const okLyricImpl: LyricProviderPlugin = { searchLyrics: async () => ({ text: "mock lyrics" }) };

const okCover: PluginManifest = { id: "mock-cover-ok", name: "OK Cover", version: "1", type: "cover", capabilities: ["coverProvider"], configSchema: [] };
const okCoverImpl: CoverProviderPlugin = { searchCover: async () => ({ url: "http://cover/x" }) };

const okRenderer: PluginManifest = { id: "mock-renderer", name: "OK Renderer", version: "1", type: "renderer", capabilities: ["renderer"], configSchema: [] };
const okRendererImpl: RendererPlugin = {
  discover: async () => ([{ id: "d1", name: "Dev1", meta: { kind: "test" } }]),
  cast: async (_host, deviceId, songId) => ({ mediaUri: `http://x/${songId}` }),
  control: async () => ({ ok: true }),
};

const okScrobbler: PluginManifest = { id: "mock-scrobbler", name: "OK Scrobbler", version: "1", type: "scrobbler", capabilities: ["scrobbler"], configSchema: [] };
const playEvents: any[] = [];
const scrobbleEvents: any[] = [];
const okScrobblerImpl: ScrobblerPlugin = {
  onPlay: async (_host, e) => { playEvents.push(e); },
  onScrobble: async (_host, e) => { scrobbleEvents.push(e); },
};

const MOCK_IDS = [failLyric.id, okLyric.id, okCover.id, okRenderer.id, okScrobbler.id];

function upsertRow(id: string, enabled: 0 | 1) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
     VALUES (?, ?, '1.0.0', 'mock', '{}', ?, '{}', datetime('now'), datetime('now'))`,
  ).run(id, id, enabled);
}
function setEnabled(id: string, enabled: 0 | 1) {
  sqlite.prepare("UPDATE plugins SET enabled = ? WHERE name = ?").run(enabled, id);
}

beforeAll(() => {
  registerBuiltinPlugins();
  initDatabase();
  // Disable the built-in renderer so the in-memory mock is the only enabled
  // renderer (keeps first-match-wins deterministic). Lyric/cover built-ins were
  // externalized to the marketplace, so they no longer seed rows here.
  setEnabled("dlna-renderer", 0);
  for (const m of [failLyric, okLyric, okCover, okRenderer, okScrobbler]) {
    registerPlugin(m, (m === failLyric && failLyricImpl) || (m === okLyric && okLyricImpl) || (m === okCover && okCoverImpl) || (m === okRenderer && okRendererImpl) || okScrobblerImpl);
    upsertRow(m.id, 1);
  }
});

afterAll(() => {
  for (const id of MOCK_IDS) sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(id);
  // restore built-in defaults
  setEnabled("dlna-renderer", 1);
  try { fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch {}
});

describe("provider presence", () => {
  it("reports whether a provider capability has any enabled plugin", () => {
    expect(hasLyricProvider()).toBe(true);
    expect(hasCoverProvider()).toBe(true);
  });
});

describe("lyric provider (first-match-wins)", () => {
  it("skips a throwing provider and returns the first that answers", async () => {
    const r = await searchLyrics({ url: "http://s", title: "T", artist: "A", duration: 1000 });
    expect(r).toBe("mock lyrics");
    // health reflects the skip + the win
    expect(getHealth("mock-lyric-fail").status).toBe("yellow");
    expect(getHealth("mock-lyric-ok").status).toBe("green");
  });

  it("returns null when no enabled provider can answer", async () => {
    setEnabled("mock-lyric-ok", 0);
    setEnabled("mock-lyric-fail", 0);
    expect(hasLyricProvider()).toBe(false);
    const r = await searchLyrics({ url: "http://s", title: "T", artist: "A", duration: 1000 });
    expect(r).toBeNull();
    setEnabled("mock-lyric-ok", 1);
    setEnabled("mock-lyric-fail", 1);
  });
});

describe("cover provider (first-match-wins)", () => {
  it("returns the first provider's cover url", async () => {
    const r = await searchCover({ url: "http://s", title: "T", artist: "A", duration: 1000 });
    expect(r).toBe("http://cover/x");
  });
});

describe("renderer plugins", () => {
  it("lists enabled renderer plugins", () => {
    expect(getRendererPlugins().map((p) => p.id)).toContain("mock-renderer");
  });

  it("discovers devices tagged with their pluginId", async () => {
    const devs = await discoverRenderers();
    const d = devs.find((x) => x.id === "d1");
    expect(d).toBeTruthy();
    expect(d!.pluginId).toBe("mock-renderer");
    expect(d!.meta).toEqual({ kind: "test" });
  });

  it("casts a song to a device", async () => {
    const r = await castToRenderer("mock-renderer", "d1", "song9");
    expect(r.mediaUri).toBe("http://x/song9");
  });

  it("controls a device when the plugin supports it", async () => {
    const r = await controlRenderer("mock-renderer", "d1", "pause");
    expect(r).toEqual({ ok: true });
  });

  it("throws when the renderer plugin is unknown", async () => {
    await expect(castToRenderer("nope", "d1", "s")).rejects.toThrow();
  });
});

describe("scrobbler plugins", () => {
  it("lists enabled scrobblers", () => {
    expect(getScrobblerPlugins().map((p) => p.id)).toContain("mock-scrobbler");
  });

  it("fans a play event out to onPlay", async () => {
    playEvents.length = 0;
    await notifyScrobble("play", { songId: "s1" } as any);
    expect(playEvents).toEqual([{ songId: "s1" }]);
  });

  it("fans a scrobble event out to onScrobble", async () => {
    scrobbleEvents.length = 0;
    await notifyScrobble("scrobble", { songId: "s2" } as any);
    expect(scrobbleEvents).toEqual([{ songId: "s2" }]);
  });
});
