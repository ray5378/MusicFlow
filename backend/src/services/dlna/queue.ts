// Per-DLNA-device playback queue with DB persistence.
//
// This is the single source of truth for "what's playing on a DLNA device".
// Both the Web frontend and the HA integration talk to it through REST/WS, so
// the queue survives:
//   - Web client closing (the backend keeps auto-advancing, not the frontend)
//   - Backend restart (queue is persisted to device_queues table)
//
// playMode mirrors the frontend's NetEase-style modes:
//   order   — play to the end, then stop
//   one     — repeat current track
//   all     — repeat the whole queue
//   shuffle — random next track (queue order preserved, only the index jumps)
import { EventEmitter } from "events";
import { db } from "../../db/index.js";
import { deviceQueues } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { castToDevice, consumeAutoAdvanceFlag, clearCurrentMedia, getCurrentMedia } from "./control.js";

export type PlayMode = "order" | "one" | "all" | "shuffle";

export interface QueueItem {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  mime: string;
  coverArt?: string;
  duration?: number;
}

export interface QueueSnapshot {
  items: QueueItem[];
  currentIndex: number;
  playMode: PlayMode;
  isActive: boolean;
  currentMedia?: ReturnType<typeof getCurrentMedia>;
}

interface Queue {
  items: QueueItem[];
  currentIndex: number;
  playMode: PlayMode;
  isActive: boolean;
}

const SUFFIX_MIME: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
  ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/opus",
  wma: "audio/x-ms-wma", ape: "audio/ape",
};

export function suffixToMime(suffix: string): string {
  return SUFFIX_MIME[(suffix || "").toLowerCase()] || "audio/mpeg";
}

class QueueManager extends EventEmitter {
  private queues = new Map<string, Queue>();
  private advancing = new Set<string>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Load all persisted queues from DB on startup. Called once from index.ts. */
  loadFromDb(): void {
    const rows = db.select().from(deviceQueues).all();
    for (const r of rows) {
      try {
        const items = JSON.parse(r.itemsJson || "[]") as QueueItem[];
        this.queues.set(r.deviceId, {
          items,
          currentIndex: r.currentIndex,
          playMode: (r.playMode as PlayMode) || "order",
          isActive: !!r.isActive,
        });
      } catch {}
    }
    console.log(`[queue] loaded ${this.queues.size} persisted device queue(s) from DB`);
  }

  private persist(deviceId: string): void {
    const q = this.queues.get(deviceId);
    if (!q) return;
    db.insert(deviceQueues)
      .values({
        deviceId,
        itemsJson: JSON.stringify(q.items),
        currentIndex: q.currentIndex,
        playMode: q.playMode,
        isActive: q.isActive ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: deviceQueues.deviceId,
        set: {
          itemsJson: JSON.stringify(q.items),
          currentIndex: q.currentIndex,
          playMode: q.playMode,
          isActive: q.isActive ? 1 : 0,
          updatedAt: new Date().toISOString(),
        },
      })
      .run();
  }

  private get(deviceId: string): Queue {
    let q = this.queues.get(deviceId);
    if (!q) {
      q = { items: [], currentIndex: -1, playMode: "order", isActive: false };
      this.queues.set(deviceId, q);
    }
    return q;
  }

  snapshot(deviceId: string): QueueSnapshot {
    const q = this.get(deviceId);
    return {
      items: q.items,
      currentIndex: q.currentIndex,
      playMode: q.playMode,
      isActive: q.isActive,
      currentMedia: getCurrentMedia(deviceId),
    };
  }

  /** List all devices that have an active (non-empty) queue — for the Web
   *  client to restore state on reopen. */
  activeDevices(): Array<{ deviceId: string; snapshot: QueueSnapshot }> {
    const out: Array<{ deviceId: string; snapshot: QueueSnapshot }> = [];
    for (const [id, q] of this.queues) {
      if (q.isActive && q.items.length > 0) {
        out.push({ deviceId: id, snapshot: this.snapshot(id) });
      }
    }
    return out;
  }

  setPlayMode(deviceId: string, mode: PlayMode): void {
    const q = this.get(deviceId);
    q.playMode = mode;
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  /** Replace the queue and start playing from `startIndex`. Marks the device
   *  active so the Web client can restore it on reopen. */
  async playFrom(deviceId: string, items: QueueItem[], startIndex: number, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    q.items = items;
    q.currentIndex = Math.max(-1, Math.min(items.length - 1, startIndex));
    q.isActive = true;
    await this.playCurrent(deviceId, baseUrl);
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  /** Append items without switching playback. */
  async enqueue(deviceId: string, items: QueueItem[], baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    q.items.push(...items);
    if (q.currentIndex < 0 && q.items.length > 0) {
      q.currentIndex = 0;
      q.isActive = true;
      await this.playCurrent(deviceId, baseUrl);
    }
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  /** Remove a single item by index and keep playback coherent. */
  removeAt(deviceId: string, index: number, baseUrl: string): void {
    const q = this.get(deviceId);
    if (index < 0 || index >= q.items.length) return;
    q.items.splice(index, 1);
    if (index < q.currentIndex) {
      q.currentIndex--;
    } else if (index === q.currentIndex) {
      // Removed the playing track → play the new item at the same index
      // (which is the next song), or stop if the queue is now empty.
      if (q.items.length === 0) {
        q.currentIndex = -1;
        q.isActive = false;
        clearCurrentMedia(deviceId);
      } else if (q.currentIndex >= q.items.length) {
        q.currentIndex = q.items.length - 1;
      }
      this.playCurrent(deviceId, baseUrl).catch(() => {});
    }
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  async next(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    const nextIdx = this.pickNextIndex(q, false);
    if (nextIdx === -1) {
      // No next track — stop.
      q.currentIndex = -1;
      q.isActive = false;
      clearCurrentMedia(deviceId);
      this.persist(deviceId);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
      return;
    }
    q.currentIndex = nextIdx;
    await this.playCurrent(deviceId, baseUrl);
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  async prev(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    if (q.currentIndex < 0) return;
    // "one" mode just replays current.
    if (q.playMode === "one") {
      await this.playCurrent(deviceId, baseUrl);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
      return;
    }
    if (q.playMode === "shuffle") {
      q.currentIndex = this.randomIndex(q);
      await this.playCurrent(deviceId, baseUrl);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
      return;
    }
    if (q.currentIndex > 0) q.currentIndex--;
    else if (q.playMode === "all") q.currentIndex = q.items.length - 1;
    await this.playCurrent(deviceId, baseUrl);
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  clear(deviceId: string): void {
    const q = this.get(deviceId);
    q.items = [];
    q.currentIndex = -1;
    q.isActive = false;
    clearCurrentMedia(deviceId);
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  /** Mark a device inactive without clearing the queue (e.g. user stopped cast
   *  from the Web client). The queue stays in DB for potential reuse. */
  deactivate(deviceId: string): void {
    const q = this.get(deviceId);
    q.isActive = false;
    this.persist(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  /** Called by eventing.ts when a track ends naturally. */
  async onTrackEnded(deviceId: string, baseUrl: string): Promise<void> {
    if (this.advancing.has(deviceId)) return;
    if (!consumeAutoAdvanceFlag(deviceId)) return;
    const q = this.get(deviceId);
    if (q.playMode === "one") {
      // Repeat current track.
      this.advancing.add(deviceId);
      try {
        await this.playCurrent(deviceId, baseUrl);
        this.emit("queue_changed", deviceId, this.snapshot(deviceId));
      } finally {
        this.advancing.delete(deviceId);
      }
      return;
    }
    const nextIdx = this.pickNextIndex(q, true);
    if (nextIdx === -1) {
      q.currentIndex = -1;
      q.isActive = false;
      this.persist(deviceId);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
      return;
    }
    this.advancing.add(deviceId);
    try {
      q.currentIndex = nextIdx;
      await this.playCurrent(deviceId, baseUrl);
      this.persist(deviceId);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
    } finally {
      this.advancing.delete(deviceId);
    }
  }

  /** Resume playback for an active queue after backend restart. */
  async resumeActive(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    if (!q.isActive || q.currentIndex < 0 || q.currentIndex >= q.items.length) return;
    // Don't restart from 0 — just re-cast the current track so the device
    // resumes from the beginning of the song it was on.
    await this.playCurrent(deviceId, baseUrl);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  private pickNextIndex(q: Queue, autoAdvance: boolean): number {
    const n = q.items.length;
    if (n === 0) return -1;
    if (q.playMode === "shuffle") return this.randomIndex(q);
    if (q.playMode === "all") {
      if (q.currentIndex + 1 < n) return q.currentIndex + 1;
      return 0; // wrap
    }
    // order
    if (q.currentIndex + 1 < n) return q.currentIndex + 1;
    return -1; // reached the end
  }

  private randomIndex(q: Queue): number {
    const n = q.items.length;
    if (n <= 1) return q.currentIndex;
    let idx = q.currentIndex;
    while (idx === q.currentIndex) idx = Math.floor(Math.random() * n);
    return idx;
  }

  private async playCurrent(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    const item = q.currentIndex >= 0 ? q.items[q.currentIndex] : undefined;
    if (!item) return;
    // Cast errors (device offline, SOAP failure) must NOT abort the queue
    // bookkeeping — the queue metadata is still correct and should be
    // persisted + emitted so the UI/HA stay in sync. The device will pick up
    // the current track on resume once it's reachable again.
    try {
      await castToDevice({
        songId: item.songId,
        title: item.title,
        artist: item.artist,
        album: item.album,
        mime: item.mime,
        deviceId,
        baseUrl,
        coverArt: item.coverArt,
      });
    } catch (e: any) {
      console.warn(`[queue] cast to ${deviceId} failed (queue state preserved):`, e?.message || e);
    }
  }
}

let instance: QueueManager | null = null;
export function getQueueManager(): QueueManager {
  if (!instance) instance = new QueueManager();
  return instance;
}
