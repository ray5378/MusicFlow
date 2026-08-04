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

  // ==================== Unified peer system ====================
  // A "peer" is any playback target the UI can switch between and control:
  //   local:<userId>  → this Web client (Howl audio + backend-stored queue)
  //   dlna:<deviceId> → a DLNA renderer (backend-owned queue + auto-advance)
  // currentPeerId drives which peer the player bar + queue panel show and
  // control. Switching peers does not stop the other peer — it just changes
  // which one the UI is bound to (per the confirmed "本机不受影响" requirement).
  const currentPeerId = ref<string>("");
  const peers = ref<any[]>([]);
  const localPeerId = computed(() => `local:${useAuthStore().userId}`);
  const currentPeer = computed(() => peers.value.find(p => p.peerId === currentPeerId.value));
  const currentPeerName = computed(() => {
    const p = currentPeer.value;
    if (!p) return currentPeerId.value.startsWith("dlna:") ? castDeviceName.value : "本机";
    return p.kind === "local" ? "本机" : p.name;
  });
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let peerWs: WebSocket | null = null;

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
    } else {
      // Local mode: persist to backend so the queue survives tab close.
      syncLocalQueueToBackend();
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
    // Persist the local queue so it survives tab close/reopen. (Cast mode is
    // owned by the backend already — pushQueueToBackend handles it.)
    if (!castActive.value) syncLocalQueueToBackend();
  }

  // Push the current frontend queue + index + play mode to the backend's
  // local_queues store (peerId = local:<userId>). Called after every queue
  // mutation in local mode so reopening the tab restores the exact state.
  // Best-effort: failures are logged but never block playback.
  function syncLocalQueueToBackend(): void {
    if (castActive.value) return; // backend owns the queue in cast mode
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    const items = queue.value.map(songToQueueItem);
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue/play`, {
      items,
      startIndex: currentIndex.value >= 0 ? currentIndex.value : 0,
    }).catch(() => {});
    // Also sync the play mode so restore matches.
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/play-mode`, {
      mode: playMode.value,
    }).catch(() => {});
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
    if (playMode.value === "one") { startPlayback(); syncLocalIndex(); return; }
    if (playMode.value === "shuffle") { currentIndex.value = randomIndex(); startPlayback(); syncLocalIndex(); return; }
    if (currentIndex.value < queue.value.length - 1) currentIndex.value++;
    else if (playMode.value === "all") currentIndex.value = 0;
    else {
      // Reached the end in "order" mode — stop.
      isPlaying.value = false; syncLocalIndex(); return;
    }
    startPlayback();
    syncLocalIndex();
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
    if (playMode.value === "shuffle") { currentIndex.value = randomIndex(); startPlayback(); syncLocalIndex(); return; }
    if (currentIndex.value > 0) currentIndex.value--;
    else if (playMode.value === "all") currentIndex.value = queue.value.length - 1;
    startPlayback();
    syncLocalIndex();
  }

  // Report the current track index to the backend so the local peer's stored
  // queue stays in sync with what's actually playing (used by HA + restore).
  function syncLocalIndex(): void {
    if (castActive.value) return;
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue/index`, {
      index: currentIndex.value,
    }).catch(() => {});
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
    } else {
      // Local mode: persist the mode so restore matches.
      const pid = localPeerId.value;
      if (pid && useAuthStore().userId) {
        api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/play-mode`, { mode: playMode.value }).catch(() => {});
      }
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
    // Persist the local queue change.
    syncLocalQueueToBackend();
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
    // Keep the peer switcher in sync: casting = viewing the dlna peer.
    currentPeerId.value = `dlna:${deviceId}`;

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
    // Return the switcher to the local peer.
    currentPeerId.value = localPeerId.value;
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
      currentPeerId.value = `dlna:${deviceId}`;
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
    } else {
      // Local mode: clear the persisted local queue too.
      const pid = localPeerId.value;
      if (pid && useAuthStore().userId) {
        api.delete(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue`).catch(() => {});
      }
    }
    queue.value = []; currentIndex.value = -1; isPlaying.value = false; currentTime.value = 0; duration.value = 0; lyrics.value = []; currentLyricLine.value = ""; currentLyricIndex.value = -1; showPlaylist.value = false; playModeVisible.value = false;
  }

  // ==================== Peer management ====================
  //
  // The player switcher lets the user flip the player bar + queue panel
  // between the local Web client and any DLNA renderer. Switching does NOT
  // stop the other peer — it just rebinds the UI. Local audio (Howl) is
  // paused when switching to a DLNA peer to avoid double audio; resuming it
  // is the user's choice when they switch back.

  // Fetch the full peer list (with queue snapshots) from the backend.
  async function refreshPeers(): Promise<void> {
    try {
      const res = await api.get("/rest/api/v1/peers");
      peers.value = res.data?.peers || [];
      // Ensure the local peer is always present in the list even before the
      // backend registers it (so the switcher shows "本机" immediately).
      if (!peers.value.find(p => p.peerId === localPeerId.value)) {
        peers.value.unshift({
          peerId: localPeerId.value,
          kind: "local",
          name: "本机",
          available: true,
          lastActiveAt: Date.now(),
        });
      }
    } catch {}
  }

  // Register this Web client as a local peer + start the heartbeat loop.
  async function registerLocalPeer(): Promise<void> {
    const authStore = useAuthStore();
    if (!authStore.userId) return;
    try {
      await api.post("/rest/api/v1/peers/register", { name: authStore.username || "本机" });
    } catch {}
    startHeartbeat();
  }

  // Heartbeat every 30s so the backend's 10-min inactivity cleanup doesn't
  // purge this tab's local queue while it's still open.
  function startHeartbeat(): void {
    stopHeartbeat();
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    // Immediate beat + interval.
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/heartbeat`).catch(() => {});
    heartbeatTimer = setInterval(() => {
      api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/heartbeat`).catch(() => {});
    }, 30_000);
  }
  function stopHeartbeat(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // Switch the player bar + queue panel to a different peer.
  //   - local peer: leave cast mode, restore the local queue (Howl stays as-is)
  //   - dlna peer:  rebind the UI to that device's backend queue; the local
  //                 Howl keeps playing on its own (切换只换控制目标,不停本机)
  async function switchPeer(peerId: string): Promise<void> {
    if (peerId === currentPeerId.value) return;
    const isDlna = peerId.startsWith("dlna:");
    if (isDlna) {
      const deviceId = peerId.slice(5);
      // 切换播放器只改变 UI 控制目标,绝不动本机 Howl —— 本机继续按原状态
      // 播放出声。这里只停掉本机进度计时器,因为切到 DLNA 后 currentTime/
      // duration 由 castPoll 负责更新(显示 DLNA 的进度);本机 Howl 仍在后台
      // 播放,只是它的进度不再写 UI。切回本机时再从 Howl 重新同步进度。
      stopProgressTimer();
      // Resolve the device's friendly name for the player bar label.
      let name = "DLNA 设备";
      try {
        const devRes = await api.get("/rest/api/v1/dlna/devices");
        const dev = (devRes.data?.devices || []).find((d: any) => d.id === deviceId);
        if (dev?.name) name = dev.name;
      } catch {}
      castDeviceId.value = deviceId;
      castDeviceName.value = name;
      currentPeerId.value = peerId;
      // Pull the backend's authoritative queue so the UI mirrors the device.
      await syncQueueFromBackend();
      const song = currentSong.value;
      if (song) loadLyrics(song.id);
      lastScrobbledSongId = song?.id || "";
      startCastPoll();
    } else {
      // Switching to local: stop mirroring the DLNA device (the device keeps
      // playing on its own — the backend owns its queue). Just rebind to local.
      stopCastPoll();
      castDeviceId.value = "";
      castDeviceName.value = "";
      currentPeerId.value = peerId;
      lastCastState = "STOPPED";
      // Restore the local queue from the backend so a freshly reopened tab or
      // a switch back from DLNA shows the user's last local queue.
      await restoreLocalPeer();
      // 切回本机时,本机 Howl 可能一直在后台播放(切换到 DLNA 时我们没有
      // pause 它)。从 Howl 重新同步 isPlaying/currentTime/duration 到 UI ——
      // 因为切到 DLNA 期间这几个值被 castPoll 用 DLNA 的状态覆盖了。如果
      // Howl 正在播,重启进度计时器让进度条继续走。
      if (howl) {
        isPlaying.value = howl.playing();
        duration.value = howl.duration() || 0;
        currentTime.value = (howl.seek() as number) || 0;
        if (howl.playing()) startProgressTimer();
      }
    }
  }

  // Restore the local queue + index + play mode from the backend's
  // local_queues store. Called on tab reopen (initLocalPeer) and when
  // switching back to the local peer. Does NOT auto-resume playback — the
  // user pressed pause/close, so we leave Howl stopped until they hit play.
  async function restoreLocalPeer(): Promise<void> {
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    try {
      const res = await api.get(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue`);
      const snap = res.data || {};
      if (Array.isArray(snap.items) && snap.items.length > 0) {
        queue.value = snap.items.map((it: any) => ({
          id: it.songId,
          title: it.title || "未知",
          artist: it.artist || "",
          album: it.album || "",
          duration: it.duration || 0,
          coverArt: it.coverArt,
        }));
        if (typeof snap.currentIndex === "number") currentIndex.value = snap.currentIndex;
        if (typeof snap.playMode === "string") {
          playMode.value = snap.playMode as PlayMode;
          localStorage.setItem("playMode", playMode.value);
        }
        // Load lyrics for the restored track so the lyrics view works.
        const song = currentSong.value;
        if (song) loadLyrics(song.id);
      }
    } catch {}
  }

  // One-shot init for the local peer: register, restore queue, connect WS,
  // fetch the peer list. Called once from MainLayout onMounted after login.
  // If restoreCast() already bound the UI to an active DLNA session, leave
  // currentPeerId on the dlna peer — only default to local when nothing is
  // casting.
  async function initLocalPeer(): Promise<void> {
    const authStore = useAuthStore();
    if (!authStore.userId) return;
    if (!castActive.value) currentPeerId.value = localPeerId.value;
    await registerLocalPeer();
    await restoreLocalPeer();
    await refreshPeers();
    connectPeerWs();
  }

  // WebSocket subscription for live peer updates (registration, availability,
  // queue changes). Replaces polling /v1/peers; falls back to refreshPeers()
  // on reconnect.
  function connectPeerWs(): void {
    disconnectPeerWs();
    const authStore = useAuthStore();
    if (!authStore.token) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      peerWs = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(authStore.token)}`);
    } catch { return; }
    peerWs.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case "peer_snapshot":
          peers.value = msg.peers || [];
          // Ensure local peer is always listed.
          if (!peers.value.find(p => p.peerId === localPeerId.value)) {
            peers.value.unshift({ peerId: localPeerId.value, kind: "local", name: "本机", available: true, lastActiveAt: Date.now() });
          }
          break;
        case "peer_registered":
        case "peer_available":
        case "peer_unavailable": {
          const p = msg.peer;
          if (!p) break;
          const idx = peers.value.findIndex(x => x.peerId === p.peerId);
          if (idx >= 0) peers.value[idx] = { ...peers.value[idx], ...p };
          else peers.value.push(p);
          break;
        }
        case "peer_queue_changed": {
          // Update the queue snapshot cached on the peer entry.
          const idx = peers.value.findIndex(x => x.peerId === msg.peer_id);
          if (idx >= 0) peers.value[idx].queue = msg.queue;
          break;
        }
        case "peer_queue_cleared": {
          const idx = peers.value.findIndex(x => x.peerId === msg.peer_id);
          if (idx >= 0) peers.value[idx].queue = { items: [], currentIndex: -1, playMode: "order", isActive: false };
          break;
        }
      }
    };
    peerWs.onclose = () => {
      // Reconnect after a short delay so a transient drop doesn't leave the
      // switcher stale.
      setTimeout(() => { if (currentPeerId.value) connectPeerWs(); }, 3000);
    };
    peerWs.onerror = () => { try { peerWs?.close(); } catch {} };
  }
  function disconnectPeerWs(): void {
    if (peerWs) {
      peerWs.onclose = null;
      try { peerWs.close(); } catch {}
      peerWs = null;
    }
  }

  // Tear down everything (called on logout).
  function teardownPeer(): void {
    stopHeartbeat();
    stopCastPoll();
    disconnectPeerWs();
  }

  return {
    queue, currentIndex, isPlaying, volume, playMode, currentTime, duration, showLyrics, showPlaylist,
    playModeVisible, lyrics, currentLyricLine, currentLyricIndex,
    currentSong, progress, castActive, castDeviceName,
    // peer system
    currentPeerId, peers, localPeerId, currentPeer, currentPeerName,
    switchPeer, refreshPeers, initLocalPeer, restoreLocalPeer, teardownPeer,
    playSong, addToQueue, playQueue, togglePlay, next, prev, seek, seekPercent, setVolume, cyclePlayMode, toggleLyrics, togglePlaylistPanel, togglePlayMode,
    removeFromQueue, clearQueue, getCoverUrl, loadLyrics, updateCurrentLyric,
    startCast, stopCast, restoreCast,
  };
});
