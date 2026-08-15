// Idle memory reclaim tests.
//
// Verifies the idle-aware memory reclamation module (./memory/reclaim.ts):
//   - isIdle(): fresh activity -> not idle; stale activity (past the 5-min
//     threshold) -> idle; disabled by settings -> never idle
//   - touch() resets the activity clock
//   - reclaimNow() runs L1 cache cleaners (registered callbacks included) and
//     returns a per-layer report (caches / gc / checkpoint)
//   - every cache clear function is callable without throwing
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { setSetting } from "../../src/services/settings.js";
import {
  isIdle, touch, reclaimNow, registerCacheCleaner,
  _resetReclaimForTest, _setLastActivityForTest,
} from "../../src/services/memory/reclaim.js";
import { clearLyricsCache } from "../../src/services/lyrics.js";
import { clearCoverResolveCache } from "../../src/services/playlistCover.js";
import { clearStreamFallbackCache } from "../../src/services/source/online/streamFallback.js";
import { clearCoverCache } from "../../src/services/coverCache.js";
import { clearRenderedCovers } from "../../src/services/coverImage.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  registerBuiltinPlugins();
  initDatabase();
  sqlite.prepare("DELETE FROM settings").run();
});
beforeEach(() => {
  _resetReclaimForTest();
  sqlite.prepare("DELETE FROM settings").run();
});

describe("reclaim isIdle", () => {
  it("fresh activity -> not idle", () => {
    touch();
    expect(isIdle()).toBe(false);
  });

  it("stale activity (past 5-min threshold) -> idle", () => {
    _setLastActivityForTest(0); // epoch: way past the threshold
    expect(isIdle()).toBe(true);
  });

  it("touch() refreshes the activity clock back to non-idle", () => {
    _setLastActivityForTest(0);
    expect(isIdle()).toBe(true);
    touch();
    expect(isIdle()).toBe(false);
  });

  it("disabled by settings -> never idle even when stale", () => {
    setSetting("memory_auto_reclaim", "false");
    _setLastActivityForTest(0);
    expect(isIdle()).toBe(false);
  });
});

describe("reclaimNow", () => {
  it("runs L1 cache cleaners including registered callbacks", () => {
    let called = 0;
    registerCacheCleaner(() => { called++; });
    const report = reclaimNow();
    expect(called).toBe(1);
    expect(report.caches).toContain("libraryIndex");
    expect(report.caches).toContain("registeredCleaners");
    expect(typeof report.gc).toBe("boolean");
    expect(typeof report.checkpoint).toBe("boolean");
  });

  it("survives a failing registered cleaner without blocking the rest", () => {
    registerCacheCleaner(() => { throw new Error("boom"); });
    const report = reclaimNow();
    expect(report.caches).toContain("libraryIndex"); // rest still cleared
  });
});

describe("cache clear helpers", () => {
  it("all clear functions are callable without throwing", () => {
    expect(() => clearLyricsCache()).not.toThrow();
    expect(() => clearCoverResolveCache()).not.toThrow();
    expect(() => clearStreamFallbackCache()).not.toThrow();
    expect(() => clearCoverCache()).not.toThrow();
    expect(() => clearRenderedCovers()).not.toThrow();
  });
});
