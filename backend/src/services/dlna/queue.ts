// Per-DLNA-device playback queue.
//
// castToDevice() only casts a single song; this module adds the
// "next / previous / play whole album" semantics the Home Assistant
// integration (and the frontend) expect. MA has a much richer queue model
// (per-player queues with shuffle/repeat/move); we keep this intentionally
// minimal — a flat list + current index — which covers the HA entity's
// next_track / previous_track / play_media(album|playlist) needs.
//
// Auto-advance: when eventing.ts emits `track_ended` (transport went
// PLAYING → STOPPED naturally, not via an explicit stop()), the queue manager
// advances to the next item and calls castToDevice() again. An explicit
// stop() sets the suppressAutoNext flag (via control.ts), which the queue
// manager consumes to avoid auto-advancing.
import { EventEmitter } from "events";
import { castToDevice, consumeAutoAdvanceFlag, clearCurrentMedia } from "./control.js";

export interface QueueItem {
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  mime: string;
  coverArt?: string;
}

export interface QueueSnapshot {
  items: QueueItem[];
  currentIndex: number; // -1 when stopped/empty
}

interface Queue {
  items: QueueItem[];
  currentIndex: number;
}

// MIME map mirrors control.ts's DLNA_MIME so callers can pass a raw suffix.
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
  // Re-entrancy guard: while an auto-advance cast is in flight, ignore
  // further track_ended events for the same device.
  private advancing = new Set<string>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  private get(deviceId: string): Queue {
    let q = this.queues.get(deviceId);
    if (!q) { q = { items: [], currentIndex: -1 }; this.queues.set(deviceId, q); }
    return q;
  }

  snapshot(deviceId: string): QueueSnapshot {
    const q = this.get(deviceId);
    return { items: q.items, currentIndex: q.currentIndex };
  }

  /** Replace the queue and start playing from `startIndex`. */
  async playFrom(deviceId: string, items: QueueItem[], startIndex: number, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    q.items = items;
    q.currentIndex = Math.max(-1, Math.min(items.length - 1, startIndex));
    await this.playCurrent(deviceId, baseUrl);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  /** Append items to the queue without switching the current playback. */
  async enqueue(deviceId: string, items: QueueItem[], baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    q.items.push(...items);
    // If nothing is playing, start from the first appended item.
    if (q.currentIndex < 0 && q.items.length > 0) {
      q.currentIndex = 0;
      await this.playCurrent(deviceId, baseUrl);
    }
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  async next(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    if (q.currentIndex + 1 < q.items.length) {
      q.currentIndex++;
      await this.playCurrent(deviceId, baseUrl);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
    }
  }

  async prev(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    if (q.currentIndex > 0) {
      q.currentIndex--;
      await this.playCurrent(deviceId, baseUrl);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
    }
  }

  clear(deviceId: string): void {
    this.queues.set(deviceId, { items: [], currentIndex: -1 });
    clearCurrentMedia(deviceId);
    this.emit("queue_changed", deviceId, this.snapshot(deviceId));
  }

  /**
   * Called by eventing.ts track_ended handler. Advances to the next track
   * unless an explicit stop() suppressed auto-advance.
   */
  async onTrackEnded(deviceId: string, baseUrl: string): Promise<void> {
    if (this.advancing.has(deviceId)) return;
    if (!consumeAutoAdvanceFlag(deviceId)) return;
    const q = this.get(deviceId);
    if (q.currentIndex + 1 < q.items.length) {
      this.advancing.add(deviceId);
      try {
        q.currentIndex++;
        await this.playCurrent(deviceId, baseUrl);
        this.emit("queue_changed", deviceId, this.snapshot(deviceId));
      } finally {
        this.advancing.delete(deviceId);
      }
    } else {
      // Reached the end of the queue — reset index so a later prev() works.
      q.currentIndex = -1;
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
    }
  }

  private async playCurrent(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.get(deviceId);
    const item = q.currentIndex >= 0 ? q.items[q.currentIndex] : undefined;
    if (!item) return;
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
  }
}

let instance: QueueManager | null = null;
export function getQueueManager(): QueueManager {
  if (!instance) instance = new QueueManager();
  return instance;
}
