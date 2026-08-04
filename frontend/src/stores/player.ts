import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { Howl } from "howler";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";

export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverArt?: string;
  artistId?: string;
  albumId?: string;
  suffix?: string;
  bitRate?: number;
  playCount?: number;
}

export interface LyricLine {
  time: number; // seconds
  text: string;
}

export const usePlayerStore = defineStore("player", () => {
  const queue = ref<Song[]>([]);
  const currentIndex = ref(-1);
  const isPlaying = ref(false);
  const volume = ref(parseFloat(localStorage.getItem("volume") || "0.8"));
  // NetEase-style play mode: order -> repeat one -> repeat all -> shuffle
  type PlayMode = "order" | "one" | "all" | "shuffle";
  const playMode = ref<PlayMode>((localStorage.getItem("playMode") as PlayMode) || "order");
  const currentTime = ref(0);
  const duration = ref(0);
  const showLyrics = ref(false);
  const showPlaylist = ref(false);
  const playModeVisible = ref(false); // fullscreen play mode overlay
  const lyrics = ref<LyricLine[]>([]);
  const currentLyricLine = ref("");
  const currentLyricIndex = ref(-1);
  let howl: Howl | null = null;

  // ==================== DLNA cast mode ====================
  // When castDeviceId is set, the backend is the single source of truth for
  // the playback queue: the queue lives in the device_queues table, and the
  // backend auto-advances tracks on its own (via GENA track_ended events).
  // This means the queue keeps playing even if the Web tab is closed or the
  // backend restarts. The frontend only mirrors state via polling + REST.
  const castDeviceId = ref("");
  const castDeviceName = ref("");
  let castPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastCastState = "STOPPED";
  const castActive = computed(() => !!castDeviceId.value);

  const currentSong = computed(() => {
    if (currentIndex.value >= 0 && currentIndex.value < queue.value.length) {
      return queue.value[currentIndex.value];
    }
    return null;
  });

  const progress = computed(() => duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0);

  function getStreamUrl(id: string) {
    const authStore = useAuthStore();
    const token = authStore.token || "";
    return `/rest/stream?id=${id}&token=${encodeURIComponent(token)}`;
  }
  function getCoverUrl(id: string | undefined) { if (!id) return ""; return `/rest/getCoverArt?id=${id}&size=300`; }

  function playSong(song: Song) {
    const idx = queue.value.findIndex(s => s.id === song.id);
    if (idx >= 0) { currentIndex.value = idx; } else { queue.value.push(song); currentIndex.value = queue.value.length - 1; }
    startPlayback();
  }

  function addToQueue(song: Song) {
    if (queue.value.findIndex(s => s.id === song.id) >= 0) return;
    queue.value.push(song);
    // In cast mode the backend queue is authoritative — mirror the append so
    // the persisted queue matches what the user sees in the queue panel.
    if (castActive.value) {
      api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue/enqueue`, {
        items: [songToQueueItem(song)],
      }).catch(() => {});
    }
  }

  // Convert a frontend Song to the QueueItem shape the backend expects.
  // Kept in sync with backend's songsToQueueItems().
  function songToQueueItem(song: Song): any {
    const SUFFIX_MIME: Record<string, string> = {
      mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
      ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/opus",
      wma: "audio/x-ms-wma", ape: "audio/ape",
    };
    return {
      songId: song.id,
      title: song.title || "未知",
      artist: song.artist || undefined,
      album: song.album || undefined,
      mime: SUFFIX_MIME[(song.suffix || "").toLowerCase()] || "audio/mpeg",
      coverArt: song.coverArt || undefined,
      duration: song.duration || undefined,
    };
  }

  function playQueue(songs: Song[], index: number = 0) {
    // Keep the queue in its original order — shuffle is handled per-skip in
    // next()/prev() via randomIndex(), not by reordering the array. This keeps
    // the queue panel display stable and currentIndex pointing at the right song.
    queue.value = [...songs];
    // In shuffle mode, start from a random track instead of always the first —
    // the user picked "shuffle", so the entry point should be random too.
    if (playMode.value === "shuffle" && songs.length > 1) {
      currentIndex.value = Math.floor(Math.random() * songs.length);
    } else {
      currentIndex.value = index;
    }
    startPlayback();
  }

  function startPlayback() {
    // In cast mode the backend owns the queue. "Play this song/album" means
    // push the (possibly updated) frontend queue to the backend and let it
    // cast from the current index. The local Howl stays paused.
    if (castActive.value) {
      pushQueueToBackend(currentIndex.value >= 0 ? currentIndex.value : 0);
      return;
    }
    if (howl) { howl.unload(); howl = null; }
    const song = currentSong.value;
    if (!song) return;
    loadLyrics(song.id);
    howl = new Howl({
      src: [getStreamUrl(song.id)],
      volume: volume.value,
      html5: true,
      onplay: () => {
        isPlaying.value = true;
        duration.value = howl?.duration() || 0;
        startProgressTimer();
        // Submit a real scrobble on play start (submission=true, the default).
        // Backend dedupes within 10s so Howl's repeated onplay (e.g. after
        // seek) won't create duplicate history rows. We intentionally do NOT
        // use submission=false here — that's "now playing" and doesn't write
        // play_history, which left the Web frontend with no history at all.
        api.get(`/rest/scrobble?id=${song.id}`).catch(() => {});
      },
      onpause: () => { isPlaying.value = false; stopProgressTimer(); },
      onend: () => { next(); },
      onload: () => { duration.value = howl?.duration() || 0; },
    });
    howl.play();
  }

  // ==================== Lyrics ====================

  async function loadLyrics(songId: string) {
    lyrics.value = [];
    currentLyricLine.value = "";
    currentLyricIndex.value = -1;
    try {
      const res = await api.get(`/rest/getLyricsBySongId?id=${songId}&f=json`);
      const structured = res.data["subsonic-response"]?.lyricsList?.structuredLyrics || [];
      const first = structured.find((l: any) => l.synced) || structured[0];
      if (!first || !first.line) return;
      lyrics.value = first.line
        .filter((l: any) => l.start !== undefined && l.start !== null)
        .map((l: any) => ({ time: Number(l.start) / 1000, text: l.value }))
        .sort((a: LyricLine, b: LyricLine) => a.time - b.time);
    } catch { lyrics.value = []; }
  }

  function updateCurrentLyric() {
    if (lyrics.value.length === 0) { currentLyricLine.value = ""; currentLyricIndex.value = -1; return; }
    const t = currentTime.value;
    let idx = -1;
    for (let i = 0; i < lyrics.value.length; i++) {
      if (lyrics.value[i].time <= t) idx = i;
      else break;
    }
    if (idx !== currentLyricIndex.value) {
      currentLyricIndex.value = idx;
      currentLyricLine.value = idx >= 0 ? lyrics.value[idx].text : "";
    }
  }

  function togglePlay() {
    if (castActive.value) {
      const id = castDeviceId.value;
      if (isPlaying.value) { api.post(`/rest/api/v1/dlna/devices/${id}/pause`).catch(() => {}); isPlaying.value = false; }
      else { api.post(`/rest/api/v1/dlna/devices/${id}/play`).catch(() => {}); isPlaying.value = true; }
      return;
    }
    if (!howl) return; if (isPlaying.value) howl.pause(); else howl.play();
  }

  // Pick a random index different from the current one (for shuffle mode).
  // Keeps the next pick unpredictable without repeating the playing track.
  function randomIndex(): number {
    const n = queue.value.length;
    if (n <= 1) return currentIndex.value;
    let idx = currentIndex.value;
    while (idx === currentIndex.value) idx = Math.floor(Math.random() * n);
    return idx;
  }

  function next() {
    if (queue.value.length === 0) return;
    // In cast mode the backend owns the queue — ask it to advance. The poller
    // will pick up the new track + index from the next /status response, and
    // the WS queue_changed event keeps the queue panel in sync.
    if (castActive.value) {
      api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/next`).catch(() => {});
      return;
    }
    if (playMode.value === "one") { startPlayback(); return; }
    if (playMode.value === "shuffle") { currentIndex.value = randomIndex(); startPlayback(); return; }
    if (currentIndex.value < queue.value.length - 1) currentIndex.value++;
    else if (playMode.value === "all") currentIndex.value = 0;
    else {
      // Reached the end in "order" mode — stop.
      isPlaying.value = false; return;
    }
    startPlayback();
  }

  function prev() {
    if (queue.value.length === 0) return;
    if (castActive.value) {
      if (currentTime.value > 3) {
        // Within first 3s fallback: seek to start instead of going to prev.
        seek(0);
        return;
      }
      api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/prev`).catch(() => {});
      return;
    }
    if (currentTime.value > 3) { seek(0); return; }
    if (playMode.value === "shuffle") { currentIndex.value = randomIndex(); startPlayback(); return; }
    if (currentIndex.value > 0) currentIndex.value--;
    else if (playMode.value === "all") currentIndex.value = queue.value.length - 1;
    startPlayback();
  }

  function seek(time: number) {
    if (castActive.value) {
      api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/seek`, { seconds: time }).catch(() => {});
      currentTime.value = time; updateCurrentLyric();
      return;
    }
    if (howl) { howl.seek(time); currentTime.value = time; }
  }
  function seekPercent(percent: number) { if (duration.value > 0) seek((percent / 100) * duration.value); }
  function setVolume(v: number) {
    volume.value = v; localStorage.setItem("volume", String(v));
    if (castActive.value) { api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/volume`, { volume: Math.round(v * 100) }).catch(() => {}); return; }
    if (howl) howl.volume(v);
  }
  // NetEase-style: order -> repeat one -> repeat all -> shuffle -> order
  function cyclePlayMode() {
    const modes: PlayMode[] = ["order", "one", "all", "shuffle"];
    playMode.value = modes[(modes.indexOf(playMode.value) + 1) % modes.length];
    localStorage.setItem("playMode", playMode.value);
    // In cast mode the backend also needs the new mode so its auto-advance
    // logic (repeat-one / repeat-all / shuffle) matches the frontend UI.
    if (castActive.value) {
      api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/play-mode`, { mode: playMode.value }).catch(() => {});
    }
  }
  function toggleLyrics() { showLyrics.value = !showLyrics.value; }
  function togglePlaylistPanel() { showPlaylist.value = !showPlaylist.value; }
  function togglePlayMode() { playModeVisible.value = !playModeVisible.value; }
  function removeFromQueue(index: number) {
    // In cast mode the backend owns the queue — removing is delegated so the
    // persisted queue + current playback stay coherent (the backend plays the
    // next song if you remove the currently-playing one).
    if (castActive.value) {
      api.delete(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue/${index}`).catch(() => {});
      return;
    }
    queue.value.splice(index, 1);
    if (index < currentIndex.value) currentIndex.value--;
    else if (index === currentIndex.value) startPlayback();
  }
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  function startProgressTimer() { stopProgressTimer(); progressTimer = setInterval(() => { if (howl && isPlaying.value) { currentTime.value = howl.seek() as number || 0; updateCurrentLyric(); } }, 250); }
  function stopProgressTimer() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

  // ==================== DLNA cast control ====================
  //
  // Architecture (after the backend-queue refactor):
  //   - The backend device_queues table is the single source of truth for the
  //     cast queue. The backend auto-advances tracks on its own (GENA
  //     track_ended → queue.onTrackEnded), so playback continues even when
  //     this Web tab is closed or the backend restarts.
  //   - The frontend only mirrors state: a poller syncs progress + current
  //     track from /status, and periodically re-syncs the queue snapshot from
  //     /queue so the queue panel reflects backend-driven changes (auto-next,
  //     HA-initiated next/prev, etc.).
  //   - User actions (next/prev/add/remove/play-mode) are sent to the backend
  //     via REST; the poller picks up the resulting state change.

  // Push the current frontend queue to the backend as the authoritative
  // queue and start playing from the current index. Called by startCast().
  // After this call the frontend queue is just a mirror — the backend owns it.
  async function pushQueueToBackend(startIndex: number): Promise<void> {
    if (!castDeviceId.value) return;
    const items = queue.value.map(songToQueueItem);
    try {
      await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue/play`, {
        items,
        startIndex,
      });
      // Sync the backend's play mode so its auto-advance matches the UI.
      await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/play-mode`, {
        mode: playMode.value,
      }).catch(() => {});
    } catch (e: any) {
      console.error("pushQueueToBackend failed:", e?.message || e);
    }
  }

  // Enter cast mode: pause local playback, push the queue to the backend, and
  // start polling for state. If the frontend queue is empty but the backend
  // already has an active queue for this device (e.g. user reopened the tab),
  // restore from the backend snapshot instead of pushing an empty queue.
  async function startCast(deviceId: string, deviceName: string) {
    if (howl) { howl.pause(); }
    stopProgressTimer();
    castDeviceId.value = deviceId;
    castDeviceName.value = deviceName;

    // If the frontend has a queue, push it (this is the normal "cast current
    // playlist" flow). Otherwise pull the backend's existing queue so the UI
    // reflects what's already playing on the device.
    if (queue.value.length > 0) {
      await pushQueueToBackend(currentIndex.value >= 0 ? currentIndex.value : 0);
    } else {
      await syncQueueFromBackend();
    }

    // Scrobble the track that's about to play (once per cast start; the poller
    // never re-scrobbles, matching the Web onplay semantics).
    const song = currentSong.value;
    if (song) {
      api.get(`/rest/scrobble?id=${song.id}`).catch(() => {});
      loadLyrics(song.id);
    }

    isPlaying.value = true;
    lastCastState = "PLAYING";
    startCastPoll();
  }

  // Exit cast mode: tell the backend to mark this device's queue inactive
  // (the queue is preserved in DB for later restore, not cleared) and stop
  // the device's transport. The frontend returns to local-Howl mode.
  async function stopCast() {
    if (castDeviceId.value) {
      try {
        await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/stop`);
        await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/deactivate`);
      } catch {}
    }
    castDeviceId.value = "";
    castDeviceName.value = "";
    stopCastPoll();
    isPlaying.value = false;
    currentTime.value = 0;
    lastCastState = "STOPPED";
  }

  // Poll the backend for device transport state + the authoritative queue
  // snapshot. The backend handles auto-advance on its own; the poller's job
  // is just to mirror that state into the frontend so the UI stays in sync.
  // Scrobbling is intentionally NOT done here — it's done once per track
  // change (see the media-changed detection below) to avoid double-counting.
  let lastScrobbledSongId = "";
  function startCastPoll() {
    stopCastPoll();
    castPollTimer = setInterval(async () => {
      if (!castDeviceId.value) { stopCastPoll(); return; }
      try {
        const res = await api.get(`/rest/api/v1/dlna/devices/${castDeviceId.value}/status`);
        const st = res.data || {};
        lastCastState = st.state || "STOPPED";
        if (typeof st.position === "number") currentTime.value = st.position;
        if (typeof st.duration === "number" && st.duration > 0) duration.value = st.duration;
        isPlaying.value = st.state === "PLAYING";

        // Detect track changes via the media info embedded in /status, and
        // scrobble + reload lyrics exactly once per new track. This replaces
        // the old "scrobble on castCurrent + scrobble on STOPPED" double path.
        const media = st.media;
        if (media && media.songId && media.songId !== lastScrobbledSongId) {
          lastScrobbledSongId = media.songId;
          api.get(`/rest/scrobble?id=${media.songId}`).catch(() => {});
          loadLyrics(media.songId);
        }

        updateCurrentLyric();
        // Sync the queue snapshot so auto-advance / HA-initiated changes show
        // up in the queue panel. Cheaper than a WS subscription for now.
        syncQueueFromBackend();
      } catch {}
    }, 2000);
  }
  function stopCastPoll() { if (castPollTimer) { clearInterval(castPollTimer); castPollTimer = null; } }

  // Pull the backend's authoritative queue snapshot into the frontend mirror.
  // Used by startCast (restore), the poller (keep in sync), and restoreCast
  // (on tab reopen). Updates queue + currentIndex + playMode + currentMedia.
  async function syncQueueFromBackend(): Promise<void> {
    if (!castDeviceId.value) return;
    try {
      const res = await api.get(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue`);
      const snap = res.data || {};
      if (Array.isArray(snap.items)) {
        // Convert QueueItem back to the frontend Song shape for display.
        queue.value = snap.items.map((it: any) => ({
          id: it.songId,
          title: it.title || "未知",
          artist: it.artist || "",
          album: it.album || "",
          duration: it.duration || 0,
          coverArt: it.coverArt,
        }));
      }
      if (typeof snap.currentIndex === "number") currentIndex.value = snap.currentIndex;
      if (typeof snap.playMode === "string") {
        playMode.value = snap.playMode as PlayMode;
        localStorage.setItem("playMode", playMode.value);
      }
    } catch {}
  }

  // On Web tab reopen: if the backend has an active cast queue, restore the
  // cast state so the user sees what's playing. Called once from the player
  // view's onMounted (or app init). Safe to call multiple times.
  async function restoreCast(): Promise<void> {
    if (castActive.value) return; // already in cast mode
    try {
      const res = await api.get("/rest/api/v1/dlna/active");
      const active = res.data?.active || [];
      if (active.length === 0) return;
      // Restore the first active device. (Multi-device restore is a future
      // enhancement; for now one active cast at a time matches typical use.)
      const { deviceId, snapshot } = active[0];
      if (!deviceId || !snapshot || !snapshot.isActive) return;
      // Look up the device's friendly name from the device list.
      let name = "DLNA 设备";
      try {
        const devRes = await api.get("/rest/api/v1/dlna/devices");
        const dev = (devRes.data?.devices || []).find((d: any) => d.id === deviceId);
        if (dev?.name) name = dev.name;
      } catch {}
      // Set cast mode WITHOUT pushing the queue (the backend already has it).
      castDeviceId.value = deviceId;
      castDeviceName.value = name;
      await syncQueueFromBackend();
      // Load lyrics for the current track so the lyrics view works post-restore.
      const song = currentSong.value;
      if (song) loadLyrics(song.id);
      lastScrobbledSongId = song?.id || "";
      startCastPoll();
    } catch {}
  }

  function clearQueue() {
    if (howl) { howl.unload(); howl = null; }
    stopProgressTimer();
    if (castDeviceId.value) {
      // Clear the backend queue too so the device stops and the persisted
      // state is wiped (not just deactivated).
      api.delete(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue`).catch(() => {});
      castDeviceId.value = "";
      castDeviceName.value = "";
      stopCastPoll();
      lastCastState = "STOPPED";
    }
    queue.value = []; currentIndex.value = -1; isPlaying.value = false; currentTime.value = 0; duration.value = 0; lyrics.value = []; currentLyricLine.value = ""; currentLyricIndex.value = -1; showPlaylist.value = false; playModeVisible.value = false;
  }

  return {
    queue, currentIndex, isPlaying, volume, playMode, currentTime, duration, showLyrics, showPlaylist,
    playModeVisible, lyrics, currentLyricLine, currentLyricIndex,
    currentSong, progress, castActive, castDeviceName,
    playSong, addToQueue, playQueue, togglePlay, next, prev, seek, seekPercent, setVolume, cyclePlayMode, toggleLyrics, togglePlaylistPanel, togglePlayMode,
    removeFromQueue, clearQueue, getCoverUrl, loadLyrics, updateCurrentLyric,
    startCast, stopCast, restoreCast,
  };
});
