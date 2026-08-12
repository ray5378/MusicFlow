// In-memory cover image cache.
//
// Covers live on slow storage (e.g. a mechanical HDD mounted as data/covers or
// data/online-covers). Reads used to be synchronous and re-read the file on
// every request, which stalled the event loop and hammered the disk. This
// module turns those reads async (fs.promises) and caches the decoded bytes so
// repeated /getCoverArt requests (home, playlist, song list, artist pages all
// hit the same covers) are served from RAM after the first HDD read.
//
// Memory safety mirrors the existing patterns in this codebase (see
// services/lyrics.ts CACHE_TTL, services/peer.ts inactivity cleanup):
//   - every successful cover request refreshes an "activity" timestamp;
//   - a 60s interval sweep clears the whole cache once no cover has been
//     requested for 10 minutes (the web client heartbeats every 30s while a tab
//     is open, so a quiet server means nobody is browsing covers);
//   - as a hard safety net the cache also drops entries when the total byte
//     budget (COVER_CACHE_BUDGET_BYTES) is exceeded, independent of age.
import fs from "fs";

const INACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min without a cover request
const SWEEP_INTERVAL_MS = 60 * 1000;        // check once a minute
const COVER_CACHE_BUDGET_BYTES = 128 * 1024 * 1024; // 128 MB

const cache = new Map<string, { buf: Uint8Array<ArrayBuffer>; size: number }>();
let heldBytes = 0;
let lastRequestAt = Date.now();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    // No cover requested in the timeout window → nobody is looking at covers
    // (no open frontend tab / user stopped scrolling) → release the memory.
    if (cache.size > 0 && Date.now() - lastRequestAt >= INACTIVE_TIMEOUT_MS) {
      cache.clear();
      heldBytes = 0;
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/** Read a cover file into memory, serving repeated reads from the cache. */
export async function readCoverFile(filePath: string): Promise<Uint8Array<ArrayBuffer>> {
  ensureSweeper();
  lastRequestAt = Date.now();
  const hit = cache.get(filePath);
  if (hit) {
    // Refresh insertion order so byte-budget eviction behaves as LRU.
    cache.delete(filePath);
    cache.set(filePath, hit);
    return hit.buf;
  }
  const data = await fs.promises.readFile(filePath);
  const size = data.byteLength;
  cache.set(filePath, { buf: data, size });
  heldBytes += size;
  // Hard budget: evict least-recently-accessed entries once we hold too much.
  // Age-based cleanup (10-min inactivity) is the primary mechanism; this only
  // guards against a single very long browsing session holding hundreds of MB.
  while (heldBytes > COVER_CACHE_BUDGET_BYTES && cache.size > 1) {
    const oldestKey = cache.keys().next().value as string;
    const evicted = cache.get(oldestKey);
    if (!evicted) break;
    cache.delete(oldestKey);
    heldBytes -= evicted.size;
  }
  return data;
}

/** Drop everything. Used by tests / maintenance hooks if ever needed. */
export function clearCoverCache(): void {
  cache.clear();
  heldBytes = 0;
}