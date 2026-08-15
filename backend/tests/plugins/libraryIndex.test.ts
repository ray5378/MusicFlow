// Library index memory-reclamation tests.
//
// Verifies the shared, memory-bounded library index (./libraryIndex.ts):
//   - only indexes playable songs (suffix IS NOT NULL) — online-only rows that
//     can never match locally are excluded entirely
//   - rows carry ONLY the lean columns (id/title/artist/suffix/path); the large
//     source_data / stream_headers text blobs are NEVER loaded into memory
//   - the instance is cached and reused across calls (no rebuild per call)
//   - clearLibraryIndex() / force rebuild drops the cache so memory is reclaimed
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { getLibraryIndex, clearLibraryIndex } from "../../src/services/plugin/libraryIndex.js";

const PLAYABLE = "lib-idx-playable-1";
const ONLINE = "lib-idx-online-1";
const BLOB = "X".repeat(5000); // stand-in for a heavy source_data text column

function seedSongs() {
  sqlite.prepare(
    "INSERT OR IGNORE INTO songs (id, title, artist, album, duration, path, suffix, type, created_at, source_data) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(PLAYABLE, "LibIdx Playable", "LibIdx Artist", "A", 200, "l:src:/t/p.mp3", "mp3", "local", new Date().toISOString(), null);
  // online-only: no suffix, carries a heavy source_data blob that must NOT be loaded
  sqlite.prepare(
    "INSERT OR IGNORE INTO songs (id, title, artist, album, duration, path, suffix, type, created_at, source_data) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(ONLINE, "LibIdx Online", "LibIdx Artist", "A", 200, "", null, "web", new Date().toISOString(), BLOB);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
  initDatabase();
});
beforeEach(() => {
  clearLibraryIndex();
  seedSongs();
});

describe("libraryIndex (lean + reclaimed)", () => {
  it("indexes only playable (suffix not null) songs, excludes online-only rows", () => {
    clearLibraryIndex();
    const idx = getLibraryIndex();
    const allIds = new Set<string>();
    for (const arr of idx.values()) for (const s of arr) allIds.add(s.id);
    expect(allIds.has(PLAYABLE)).toBe(true); // local playable song is indexed
    expect(allIds.has(ONLINE)).toBe(false);   // online-only song is excluded
  });

  it("rows carry only lean columns — never the heavy source_data blob", () => {
    const idx = getLibraryIndex();
    for (const arr of idx.values()) {
      for (const s of arr as any[]) {
        expect(typeof s.id).toBe("string");
        expect("sourceData" in s).toBe(false);
        expect("source_data" in s).toBe(false);
        expect("streamHeaders" in s).toBe(false);
      }
    }
  });

  it("caches and reuses the same instance across calls (no rebuild per call)", () => {
    const a = getLibraryIndex();
    const b = getLibraryIndex();
    expect(a).toBe(b);
  });

  it("clearLibraryIndex drops the cache so the next call rebuilds a fresh instance", () => {
    const a = getLibraryIndex();
    clearLibraryIndex();
    const b = getLibraryIndex();
    expect(a).not.toBe(b);
  });

  it("force rebuild returns a fresh instance", () => {
    const a = getLibraryIndex();
    const b = getLibraryIndex(true);
    expect(a).not.toBe(b);
  });
});
