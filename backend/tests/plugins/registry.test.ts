// Unit tests for the unified plugin registry + capability-driven dispatch.
//
// These are the guard-rails for the pluginization refactor: the core must resolve plugins by
// *capability* and honour the DB `enabled` flag, and importer routing must come
// from the plugins themselves (no URL if-chain left in the core).
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins, seedPluginRows, BUILTIN_PLUGINS } from "../../src/plugins/builtins.js";
import {
  listRegistered,
  getEnabledByCapability,
  firstEnabledByCapability,
  getEnabledPlugins,
  getPluginConfig,
} from "../../src/plugins/registry.js";
import {
  importPlaylistFromUrl,
  parsePlaylistFile,
  findUrlImporter,
  supportedImportPlatforms,
  NATIVE_APP,
} from "../../src/services/plugin/playlistImport.js";

const QQ_URL = "https://y.qq.com/n/ryqq/playlist/8802318711";
const QQ_TOPLIST_URL = "https://y.qq.com/n/ryqq/toplist/26";
const NETEASE_URL = "https://music.163.com/playlist?id=3778678";

function setEnabled(id: string, enabled: 0 | 1) {
  sqlite.prepare("UPDATE plugins SET enabled = ? WHERE name = ?").run(enabled, id);
}

function enabledFlag(id: string): number | undefined {
  const row = sqlite.prepare("SELECT enabled FROM plugins WHERE name = ?").get(id) as any;
  return row?.enabled;
}

let seededCount = 0;

beforeAll(() => {
  registerBuiltinPlugins();
  initDatabase(); // fires the db-ready hook -> seeds a row per registered plugin
  // The test DB is shared with the other test files, so a plugin row may already
  // exist with whatever state they left behind. Drop the built-in rows and let
  // the seeder rebuild them, so the seeding assertions below test the seeder
  // rather than leftover state.
  for (const { manifest } of BUILTIN_PLUGINS) {
    sqlite.prepare("DELETE FROM plugins WHERE name = ?").run(manifest.id);
  }
  seededCount = seedPluginRows();
});

afterEach(() => {
  // Restore each plugin's seeded default so tests stay independent.
  for (const { manifest } of BUILTIN_PLUGINS) {
    setEnabled(manifest.id, manifest.defaultEnabled ? 1 : 0);
  }
});

describe("plugin registry", () => {
  it("registers every built-in plugin exactly once (idempotent)", () => {
    registerBuiltinPlugins();
    registerBuiltinPlugins();
    const ids = listRegistered().map((p) => p.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { manifest } of BUILTIN_PLUGINS) {
      expect(ids).toContain(manifest.id);
    }
  });

  it("covers all built-in plugin types", () => {
    const types = new Set(listRegistered().map((p) => p.manifest.type));
    // 内置插件:go-music-dl 三合一(源/歌词/封面)已改回**外置**插件
    // (MusicFlow-plugins 仓库分发),因此内置插件已不再有 source 类型——
    // source 类型由外置插件在市场/官方注册表安装后提供。其余内置为
    // importer/recommender/sync/renderer/artist。
    expect([...types].sort()).toEqual([
      "artist", "importer", "recommender", "renderer", "sync",
    ]);
  });

  it("seeds exactly one row per registered plugin", () => {
    expect(seededCount).toBe(BUILTIN_PLUGINS.length);
  });

  it("seeds built-in helper plugins enabled", () => {
    // These replaced hardcoded core paths — they must be on, or importing a
    // playlist / daily recommend would silently stop working after upgrade.
    expect(enabledFlag("qq-playlist-importer")).toBe(1);
    expect(enabledFlag("netease-playlist-importer")).toBe(1);
    expect(enabledFlag("musicflow-file-importer")).toBe(1);
    expect(enabledFlag("daily-recommend")).toBe(1);
    expect(enabledFlag("playlist-sync")).toBe(1);
    // New renderer / recommender plugins (replacing hardcoded core paths).
    // 注意: go-music-dl-lyrics / go-music-dl-cover 已外置为官方市场插件,不再内置。
    expect(enabledFlag("dlna-renderer")).toBe(1);
    expect(enabledFlag("local-recommend")).toBe(1);
  });

  it("re-seeding never duplicates or resets existing rows", () => {
    setEnabled("qq-playlist-importer", 0);
    const inserted = seedPluginRows();
    expect(inserted).toBe(0);
    expect(enabledFlag("qq-playlist-importer")).toBe(0); // user state survives
    const rows = sqlite.prepare("SELECT COUNT(*) AS n FROM plugins WHERE name = ?")
      .get("qq-playlist-importer") as any;
    expect(rows.n).toBe(1);
  });

  it("resolves plugins by capability and respects the enabled flag", () => {
    const ids = () => getEnabledByCapability("playlistImport").map((p) => p.manifest.id);
    expect(ids()).toEqual(expect.arrayContaining(["qq-playlist-importer", "netease-playlist-importer"]));

    setEnabled("qq-playlist-importer", 0);
    expect(ids()).not.toContain("qq-playlist-importer");
    expect(ids()).toContain("netease-playlist-importer");
  });

  it("exposes scheduler capabilities as impls the core can call blindly", () => {
    const daily = firstEnabledByCapability("dailyPlaylist");
    expect(daily?.manifest.type).toBe("recommender");
    expect(typeof daily?.impl.runDailyJob).toBe("function");

    const sync = firstEnabledByCapability("playlistSync");
    expect(sync?.manifest.type).toBe("sync");
    expect(typeof sync?.impl.runSyncJob).toBe("function");
  });

  it("returns nothing for a capability no enabled plugin declares", () => {
    // go-music-dl 已改回外置插件,内置插件里不再有 source 类型——
    // search/stream/webRotation 这些 source 能力需在市场安装并启用外置
    // 插件后才可用,因此默认查询为空。
    expect(firstEnabledByCapability("search")).toBeUndefined();
    expect(firstEnabledByCapability("stream")).toBeUndefined();
    expect(getEnabledByCapability("webRotation")).toEqual([]);
  });

  it("getEnabledPlugins filters by type", () => {
    expect(getEnabledPlugins("source")).toEqual([]); // 无内置 source,需外置安装
    expect(getEnabledPlugins("importer").length).toBe(3);
    expect(getEnabledPlugins("sync").map((p) => p.manifest.id)).toEqual(["playlist-sync"]);
  });

  it("getPluginConfig returns null for a disabled plugin", () => {
    setEnabled("qq-playlist-importer", 0);
    expect(getPluginConfig("qq-playlist-importer")).toBeNull();
    setEnabled("qq-playlist-importer", 1);
    expect(getPluginConfig("qq-playlist-importer")).toMatchObject({});
  });
});

describe("playlist import dispatch", () => {
  it("routes share URLs to the plugin that claims them", () => {
    expect(findUrlImporter(QQ_URL)?.manifest.id).toBe("qq-playlist-importer");
    expect(findUrlImporter(QQ_TOPLIST_URL)?.manifest.id).toBe("qq-playlist-importer");
    expect(findUrlImporter(NETEASE_URL)?.manifest.id).toBe("netease-playlist-importer");
    expect(findUrlImporter("https://example.com/playlist/1")).toBeUndefined();
  });

  it("stops routing to a disabled importer", () => {
    setEnabled("qq-playlist-importer", 0);
    expect(findUrlImporter(QQ_URL)).toBeUndefined();
  });

  it("reports the platforms enabled importers cover", () => {
    expect(supportedImportPlatforms().sort()).toEqual(["netease", "qq"]);
    setEnabled("netease-playlist-importer", 0);
    expect(supportedImportPlatforms()).toEqual(["qq"]);
  });

  it("rejects an unsupported link without hitting the network", async () => {
    await expect(importPlaylistFromUrl("https://example.com/playlist/1"))
      .rejects.toThrow(/不支持的音乐平台链接/);
  });

  it("reports missing importers instead of silently doing nothing", async () => {
    setEnabled("qq-playlist-importer", 0);
    setEnabled("netease-playlist-importer", 0);
    await expect(importPlaylistFromUrl(QQ_URL)).rejects.toThrow(/没有启用的歌单导入插件/);
  });
});

describe("playlist file dispatch", () => {
  const single = {
    app: NATIVE_APP,
    version: 1,
    name: "我的歌单",
    tracks: [
      { externalId: "1", title: "歌曲A", artist: "歌手A", album: "专辑A", duration: 210000 },
      { externalId: "2", title: "歌曲B", artist: "歌手B" },
    ],
  };

  it("parses a MusicFlow single-playlist export", () => {
    const out = parsePlaylistFile(single);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ name: "我的歌单", platform: "local" });
    expect(out[0].tracks.map((t) => t.title)).toEqual(["歌曲A", "歌曲B"]);
    expect(out[0].tracks[1].duration).toBeUndefined(); // absent duration stays absent
  });

  it("expands an export-all file into one playlist per block", () => {
    const out = parsePlaylistFile({
      app: NATIVE_APP,
      version: 1,
      exportAll: true,
      playlists: [single, { name: "第二个", tracks: [{ title: "歌曲C" }] }],
    });
    expect(out.map((p) => p.name)).toEqual(["我的歌单", "第二个"]);
  });

  it("rejects a payload no importer recognizes", () => {
    expect(() => parsePlaylistFile({ app: "SomethingElse", tracks: [] }))
      .toThrow(/无法识别该歌单文件格式/);
  });

  it("rejects an empty MusicFlow file", () => {
    expect(() => parsePlaylistFile({ app: NATIVE_APP, version: 1, name: "空", tracks: [] }))
      .toThrow(/没有可用曲目/);
  });

  it("reports missing file importers when the plugin is disabled", () => {
    setEnabled("musicflow-file-importer", 0);
    expect(() => parsePlaylistFile(single)).toThrow(/没有启用的歌单文件导入插件/);
  });
});
