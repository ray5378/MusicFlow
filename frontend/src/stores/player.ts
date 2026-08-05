import { defineStore } from "pinia";
import { ref, computed, reactive } from "vue";
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

// Convert a backend QueueItem back to the frontend Song shape for display.
function queueItemToSong(it: any): Song {
  return {
    id: it.songId,
    title: it.title || "未知",
    artist: it.artist || "",
    album: it.album || "",
    duration: it.duration || 0,
    coverArt: it.coverArt,
  };
}

export const usePlayerStore = defineStore("player", () => {
  type PlayMode = "order" | "one" | "all" | "shuffle";

  // ==================== Shared UI state ====================
  const volume = ref(parseFloat(localStorage.getItem("volume") || "0.8"));
  const showLyrics = ref(false);
  const showPlaylist = ref(false);
  const playModeVisible = ref(false); // fullscreen play mode overlay

  // ==================== Local (本机) state machine ====================
  // Completely independent from DLNA. Howl's onend only calls localNext,
  // never touching the DLNA state machine. The user can switch the UI to
  // control a DLNA device while本机 keeps playing on its own.
  const localQueue = ref<Song[]>([]);
  const localIndex = ref(-1);
  const localIsPlaying = ref(false);
  const localCurrentTime = ref(0);
  const localDuration = ref(0);
  const localPlayMode = ref<PlayMode>((localStorage.getItem("playMode") as PlayMode) || "order");
  const localLyrics = ref<LyricLine[]>([]);
  const localCurrentLyricLine = ref("");
  const localCurrentLyricIndex = ref(-1);
  let howl: Howl | null = null;

  // ==================== Unified peer system (core refs, declared early) ====================
  // currentPeerId drives which state machine the UI shows/controls.
  //   local:<userId>  → 本机 state machine (Howl audio + backend-stored queue)
  //   dlna:<deviceId> → that device's CastState (backend-owned queue + auto-advance)
  // Declared here (before the cast state machine) because activeCastDeviceId
  // derives from it.
  const currentPeerId = ref<string>("");
  const localPeerId = computed(() => `local:${useAuthStore().userId}`);
  const isDlnaPeer = computed(() => currentPeerId.value.startsWith("dlna:"));

  // ==================== DLNA (cast) state machine ====================
  // Multi-device: each DLNA renderer gets its own CastState, so multiple
  // devices can play independently and the UI can switch between them
  // without losing any device's mirrored state. The backend
  // device_queues table is the single source of truth per device; the
  // frontend only mirrors state via per-device polling + REST.
  interface CastState {
    deviceId: string;
    name: string;
    queue: Song[];
    index: number;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    playMode: PlayMode;
    lyrics: LyricLine[];
    currentLyricLine: string;
    currentLyricIndex: number;
    pollTimer: ReturnType<typeof setInterval> | null;
    // Smooth-progress interpolation timer: ticks every 250ms and advances
    // currentTime locally so the progress bar moves smoothly between the
    // slower 2s backend polls (which then correct any drift).
    tickTimer: ReturnType<typeof setInterval> | null;
    lastCastState: string;
    lastScrobbledSongId: string;
  }
  // reactive Map so Vue tracks deep changes to each device's state.
  const castStates = reactive(new Map<string, CastState>());

  function getCastState(deviceId: string): CastState | undefined {
    return castStates.get(deviceId);
  }
  function ensureCastState(deviceId: string, name: string = "DLNA 设备"): CastState {
    let st = castStates.get(deviceId);
    if (!st) {
      const raw: CastState = {
        deviceId,
        name,
        queue: [],
        index: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        playMode: "order" as PlayMode,
        lyrics: [],
        currentLyricLine: "",
        currentLyricIndex: -1,
        pollTimer: null,
        tickTimer: null,
        lastCastState: "STOPPED",
        lastScrobbledSongId: "",
      };
      castStates.set(deviceId, raw);
      // IMPORTANT: reactive Map wraps the value in a proxy on set, so the
      // original `raw` object is NOT the reactive one. Re-fetch the proxy
      // so all subsequent mutations (st.currentTime = ..., st.isPlaying =
      // ...) go through reactivity and the UI actually updates.
      st = castStates.get(deviceId)!;
    } else if (name && name !== "DLNA 设备") {
      st.name = name;
    }
    return st;
  }
  function removeCastState(deviceId: string): void {
    const st = castStates.get(deviceId);
    if (st?.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    if (st?.tickTimer) { clearInterval(st.tickTimer); st.tickTimer = null; }
    castStates.delete(deviceId);
  }

  // The currently-active DLNA device (the one the UI is bound to, if any).
  // Derived from currentPeerId so there's a single source of truth.
  const activeCastDeviceId = computed(() => {
    const pid = currentPeerId.value;
    return pid.startsWith("dlna:") ? pid.slice(5) : "";
  });
  const activeCast = computed(() => {
    const id = activeCastDeviceId.value;
    return id ? castStates.get(id) : undefined;
  });
  // castActive now means "at least one DLNA device is being tracked".
  const castActive = computed(() => castStates.size > 0);
  const castDeviceName = computed(() => activeCast.value?.name || "");

  // ==================== Unified peer system (rest) ====================
  const peers = ref<any[]>([]);
  const currentPeer = computed(() => peers.value.find(p => p.peerId === currentPeerId.value));
  const currentPeerName = computed(() => {
    const p = currentPeer.value;
    if (!p) return isDlnaPeer.value ? castDeviceName.value : "本机";
    return p.kind === "local" ? "本机" : p.name;
  });
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let peerWs: WebSocket | null = null;

  // ==================== UI-routed computed properties ====================
  // These pick the active state machine based on currentPeerId. For DLNA,
  // they read from the active device's CastState. The UI (MainLayout) binds
  // to these, so it automatically shows/controls the right device when the
  // user switches peers.
  const queue = computed(() => isDlnaPeer.value ? (activeCast.value?.queue ?? []) : localQueue.value);
  const currentIndex = computed(() => isDlnaPeer.value ? (activeCast.value?.index ?? -1) : localIndex.value);
  const isPlaying = computed(() => isDlnaPeer.value ? (activeCast.value?.isPlaying ?? false) : localIsPlaying.value);
  const currentTime = computed(() => isDlnaPeer.value ? (activeCast.value?.currentTime ?? 0) : localCurrentTime.value);
  const duration = computed(() => isDlnaPeer.value ? (activeCast.value?.duration ?? 0) : localDuration.value);
  const playMode = computed(() => isDlnaPeer.value ? (activeCast.value?.playMode ?? "order") : localPlayMode.value);
  const lyrics = computed(() => isDlnaPeer.value ? (activeCast.value?.lyrics ?? []) : localLyrics.value);
  const currentLyricLine = computed(() => isDlnaPeer.value ? (activeCast.value?.currentLyricLine ?? "") : localCurrentLyricLine.value);
  const currentLyricIndex = computed(() => isDlnaPeer.value ? (activeCast.value?.currentLyricIndex ?? -1) : localCurrentLyricIndex.value);

  const currentSong = computed(() => {
    const q = queue.value;
    const idx = currentIndex.value;
    if (idx >= 0 && idx < q.length) return q[idx];
    return null;
  });
  const progress = computed(() => duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0);

  function getStreamUrl(id: string) {
    const authStore = useAuthStore();
    const token = authStore.token || "";
    return `/rest/stream?id=${id}&token=${encodeURIComponent(token)}`;
  }
  function getCoverUrl(id: string | undefined) { if (!id) return ""; return `/rest/getCoverArt?id=${id}&size=300`; }

  // ==================== Local playback (本机) ====================

  function localPlaySong(song: Song) {
    const idx = localQueue.value.findIndex(s => s.id === song.id);
    if (idx >= 0) { localIndex.value = idx; } else { localQueue.value.push(song); localIndex.value = localQueue.value.length - 1; }
    startLocalPlayback();
  }

  function localAddToQueue(song: Song) {
    if (localQueue.value.findIndex(s => s.id === song.id) >= 0) return;
    localQueue.value.push(song);
    syncLocalQueueToBackend();
  }

  function localPlayQueue(songs: Song[], index: number = 0) {
    localQueue.value = [...songs];
    if (localPlayMode.value === "shuffle" && songs.length > 1) {
      localIndex.value = Math.floor(Math.random() * songs.length);
    } else {
      localIndex.value = index;
    }
    startLocalPlayback();
    syncLocalQueueToBackend();
  }

  // Push the current local queue + index + play mode to the backend's
  // local_queues store (peerId = local:<userId>). Called after every queue
  // mutation so reopening the tab restores the exact state. Best-effort.
  function syncLocalQueueToBackend(): void {
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    const items = localQueue.value.map(songToQueueItem);
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue/play`, {
      items,
      startIndex: localIndex.value >= 0 ? localIndex.value : 0,
    }).catch(() => {});
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/play-mode`, {
      mode: localPlayMode.value,
    }).catch(() => {});
  }

  function startLocalPlayback() {
    if (howl) { howl.unload(); howl = null; }
    const song = localQueue.value[localIndex.value];
    if (!song) return;
    loadLocalLyrics(song.id);
    howl = new Howl({
      src: [getStreamUrl(song.id)],
      volume: volume.value,
      html5: true,
      onplay: () => {
        localIsPlaying.value = true;
        localDuration.value = howl?.duration() || 0;
        startLocalProgressTimer();
        api.get(`/rest/scrobble?id=${song.id}`).catch(() => {});
      },
      onpause: () => { localIsPlaying.value = false; stopLocalProgressTimer(); },
      onend: () => { localNext(); },
      onload: () => { localDuration.value = howl?.duration() || 0; },
    });
    howl.play();
  }

  async function loadLocalLyrics(songId: string) {
    localLyrics.value = [];
    localCurrentLyricLine.value = "";
    localCurrentLyricIndex.value = -1;
    try {
      const res = await api.get(`/rest/getLyricsBySongId?id=${songId}&f=json`);
      const structured = res.data["subsonic-response"]?.lyricsList?.structuredLyrics || [];
      const first = structured.find((l: any) => l.synced) || structured[0];
      if (!first || !first.line) return;
      localLyrics.value = first.line
        .filter((l: any) => l.start !== undefined && l.start !== null)
        .map((l: any) => ({ time: Number(l.start) / 1000, text: l.value }))
        .sort((a: LyricLine, b: LyricLine) => a.time - b.time);
    } catch { localLyrics.value = []; }
  }

  function updateLocalLyric() {
    if (localLyrics.value.length === 0) { localCurrentLyricLine.value = ""; localCurrentLyricIndex.value = -1; return; }
    const t = localCurrentTime.value;
    let idx = -1;
    for (let i = 0; i < localLyrics.value.length; i++) {
      if (localLyrics.value[i].time <= t) idx = i;
      else break;
    }
    if (idx !== localCurrentLyricIndex.value) {
      localCurrentLyricIndex.value = idx;
      localCurrentLyricLine.value = idx >= 0 ? localLyrics.value[idx].text : "";
    }
  }

  function localTogglePlay() {
    if (!howl) return;
    if (localIsPlaying.value) howl.pause(); else howl.play();
  }

  // Pick a random index different from the current one (for shuffle mode).
  function localRandomIndex(): number {
    const n = localQueue.value.length;
    if (n <= 1) return localIndex.value;
    let idx = localIndex.value;
    while (idx === localIndex.value) idx = Math.floor(Math.random() * n);
    return idx;
  }

  function localNext() {
    if (localQueue.value.length === 0) return;
    if (localPlayMode.value === "one") { startLocalPlayback(); syncLocalIndex(); return; }
    if (localPlayMode.value === "shuffle") { localIndex.value = localRandomIndex(); startLocalPlayback(); syncLocalIndex(); return; }
    if (localIndex.value < localQueue.value.length - 1) localIndex.value++;
    else if (localPlayMode.value === "all") localIndex.value = 0;
    else { localIsPlaying.value = false; syncLocalIndex(); return; }
    startLocalPlayback();
    syncLocalIndex();
  }

  function localPrev() {
    if (localQueue.value.length === 0) return;
    if (localCurrentTime.value > 3) { localSeek(0); return; }
    if (localPlayMode.value === "shuffle") { localIndex.value = localRandomIndex(); startLocalPlayback(); syncLocalIndex(); return; }
    if (localIndex.value > 0) localIndex.value--;
    else if (localPlayMode.value === "all") localIndex.value = localQueue.value.length - 1;
    startLocalPlayback();
    syncLocalIndex();
  }

  function syncLocalIndex(): void {
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue/index`, {
      index: localIndex.value,
    }).catch(() => {});
  }

  function localSeek(time: number) {
    if (howl) { howl.seek(time); localCurrentTime.value = time; }
  }

  function localRemoveFromQueue(index: number) {
    localQueue.value.splice(index, 1);
    if (index < localIndex.value) localIndex.value--;
    else if (index === localIndex.value) startLocalPlayback();
    syncLocalQueueToBackend();
  }

  function localClearQueue() {
    if (howl) { howl.unload(); howl = null; }
    stopLocalProgressTimer();
    localQueue.value = []; localIndex.value = -1; localIsPlaying.value = false;
    localCurrentTime.value = 0; localDuration.value = 0;
    localLyrics.value = []; localCurrentLyricLine.value = ""; localCurrentLyricIndex.value = -1;
    const pid = localPeerId.value;
    if (pid && useAuthStore().userId) {
      api.delete(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue`).catch(() => {});
    }
  }

  function localCyclePlayMode() {
    const modes: PlayMode[] = ["order", "one", "all", "shuffle"];
    localPlayMode.value = modes[(modes.indexOf(localPlayMode.value) + 1) % modes.length];
    localStorage.setItem("playMode", localPlayMode.value);
    const pid = localPeerId.value;
    if (pid && useAuthStore().userId) {
      api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/play-mode`, { mode: localPlayMode.value }).catch(() => {});
    }
  }

  let localProgressTimer: ReturnType<typeof setInterval> | null = null;
  function startLocalProgressTimer() {
    stopLocalProgressTimer();
    localProgressTimer = setInterval(() => {
      if (howl && localIsPlaying.value) {
        localCurrentTime.value = howl.seek() as number || 0;
        updateLocalLyric();
      }
    }, 250);
  }
  function stopLocalProgressTimer() { if (localProgressTimer) { clearInterval(localProgressTimer); localProgressTimer = null; } }

  // ==================== DLNA (cast) playback ====================
  // All functions operate on a specific device's CastState. The UI-routed
  // wrappers below pass the active device's state.

  function castPlaySong(st: CastState, song: Song) {
    const idx = st.queue.findIndex(s => s.id === song.id);
    if (idx >= 0) { st.index = idx; } else { st.queue.push(song); st.index = st.queue.length - 1; }
    startCastPlayback(st);
  }

  function castAddToQueue(st: CastState, song: Song) {
    if (st.queue.findIndex(s => s.id === song.id) >= 0) return;
    st.queue.push(song);
    api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/queue/enqueue`, {
      items: [songToQueueItem(song)],
    }).catch(() => {});
  }

  function castPlayQueue(st: CastState, songs: Song[], index: number = 0) {
    st.queue = [...songs];
    if (st.playMode === "shuffle" && songs.length > 1) {
      st.index = Math.floor(Math.random() * songs.length);
    } else {
      st.index = index;
    }
    startCastPlayback(st);
  }

  // Push a device's queue to the backend as the authoritative queue and
  // start playing from the current index.
  async function pushCastQueueToBackend(st: CastState, startIndex: number): Promise<void> {
    const items = st.queue.map(songToQueueItem);
    try {
      await api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/queue/play`, {
        items,
        startIndex,
      });
      await api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/play-mode`, {
        mode: st.playMode,
      }).catch(() => {});
    } catch (e: any) {
      console.error("pushCastQueueToBackend failed:", e?.message || e);
    }
  }

  function startCastPlayback(st: CastState) {
    pushCastQueueToBackend(st, st.index >= 0 ? st.index : 0);
  }

  async function loadCastLyrics(st: CastState, songId: string) {
    st.lyrics = [];
    st.currentLyricLine = "";
    st.currentLyricIndex = -1;
    try {
      const res = await api.get(`/rest/getLyricsBySongId?id=${songId}&f=json`);
      const structured = res.data["subsonic-response"]?.lyricsList?.structuredLyrics || [];
      const first = structured.find((l: any) => l.synced) || structured[0];
      if (!first || !first.line) return;
      st.lyrics = first.line
        .filter((l: any) => l.start !== undefined && l.start !== null)
        .map((l: any) => ({ time: Number(l.start) / 1000, text: l.value }))
        .sort((a: LyricLine, b: LyricLine) => a.time - b.time);
    } catch { st.lyrics = []; }
  }

  function updateCastLyric(st: CastState) {
    if (st.lyrics.length === 0) { st.currentLyricLine = ""; st.currentLyricIndex = -1; return; }
    const t = st.currentTime;
    let idx = -1;
    for (let i = 0; i < st.lyrics.length; i++) {
      if (st.lyrics[i].time <= t) idx = i;
      else break;
    }
    if (idx !== st.currentLyricIndex) {
      st.currentLyricIndex = idx;
      st.currentLyricLine = idx >= 0 ? st.lyrics[idx].text : "";
    }
  }

  function castTogglePlay(st: CastState) {
    if (st.isPlaying) {
      api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/pause`).catch(() => {});
      st.isPlaying = false;
    } else {
      api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/play`).catch(() => {});
      st.isPlaying = true;
    }
  }

  function castNext(st: CastState) {
    if (st.queue.length === 0) return;
    api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/next`).catch(() => {});
  }

  function castPrev(st: CastState) {
    if (st.queue.length === 0) return;
    if (st.currentTime > 3) { castSeek(st, 0); return; }
    api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/prev`).catch(() => {});
  }

  function castSeek(st: CastState, time: number) {
    api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/seek`, { seconds: time }).catch(() => {});
    st.currentTime = time; updateCastLyric(st);
  }

  function castRemoveFromQueue(st: CastState, index: number) {
    api.delete(`/rest/api/v1/dlna/devices/${st.deviceId}/queue/${index}`).catch(() => {});
  }

  function castClearQueue(st: CastState) {
    api.delete(`/rest/api/v1/dlna/devices/${st.deviceId}/queue`).catch(() => {});
    stopCastPoll(st);
    removeCastState(st.deviceId);
    // If the cleared device was the active peer, fall back to本机.
    if (activeCastDeviceId.value === st.deviceId) {
      currentPeerId.value = localPeerId.value;
    }
  }

  function castCyclePlayMode(st: CastState) {
    const modes: PlayMode[] = ["order", "one", "all", "shuffle"];
    st.playMode = modes[(modes.indexOf(st.playMode) + 1) % modes.length];
    api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/play-mode`, { mode: st.playMode }).catch(() => {});
  }

  // Per-device poll: mirrors backend transport state + queue into the
  // device's CastState. Each device has its own timer, so multiple devices
  // are tracked simultaneously without interfering with each other.
  function startCastPoll(st: CastState) {
    stopCastPoll(st);
    // Backend poll (2s): ground-truth state + queue snapshot.
    st.pollTimer = setInterval(async () => {
      try {
        const res = await api.get(`/rest/api/v1/dlna/devices/${st.deviceId}/status`);
        const s = res.data || {};
        st.lastCastState = s.state || "STOPPED";
        if (typeof s.position === "number") st.currentTime = s.position;
        if (typeof s.duration === "number" && s.duration > 0) st.duration = s.duration;
        st.isPlaying = s.state === "PLAYING";

        const media = s.media;
        if (media && media.songId && media.songId !== st.lastScrobbledSongId) {
          st.lastScrobbledSongId = media.songId;
          api.get(`/rest/scrobble?id=${media.songId}`).catch(() => {});
          loadCastLyrics(st, media.songId);
        }
        updateCastLyric(st);
        syncCastQueueFromBackend(st);
      } catch {}
    }, 2000);
    // Smooth interpolation (250ms): advance currentTime locally while
    // playing so the progress bar moves smoothly between the 2s polls. The
    // next poll overwrites with the backend ground truth, correcting drift.
    st.tickTimer = setInterval(() => {
      if (st.isPlaying && st.duration > 0 && st.currentTime < st.duration) {
        st.currentTime += 0.25;
        if (st.currentTime > st.duration) st.currentTime = st.duration;
        updateCastLyric(st);
      }
    }, 250);
  }
  function stopCastPoll(st: CastState) {
    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    if (st.tickTimer) { clearInterval(st.tickTimer); st.tickTimer = null; }
  }

  // Pull the backend's authoritative queue snapshot into a device's state.
  async function syncCastQueueFromBackend(st: CastState): Promise<void> {
    try {
      const res = await api.get(`/rest/api/v1/dlna/devices/${st.deviceId}/queue`);
      const snap = res.data || {};
      if (Array.isArray(snap.items)) {
        st.queue = snap.items.map(queueItemToSong);
      }
      if (typeof snap.currentIndex === "number") st.index = snap.currentIndex;
      if (typeof snap.playMode === "string") st.playMode = snap.playMode as PlayMode;
    } catch {}
  }

  // Enter cast mode for a device: push the queue to the backend and start
  // polling. This is the "投屏" operation — it pushes the current本机 queue
  // to the DLNA device and switches the UI to control that device. 本机 Howl
  // is paused because投屏 means "play on the remote device instead of here".
  // (Distinct from switchPeer, which only changes the UI view.)
  async function startCast(deviceId: string, deviceName: string) {
    if (howl) { howl.pause(); }
    stopLocalProgressTimer();
    const st = ensureCastState(deviceId, deviceName);

    if (localQueue.value.length > 0) {
      st.queue = [...localQueue.value];
      st.index = localIndex.value >= 0 ? localIndex.value : 0;
      st.playMode = localPlayMode.value;
      await pushCastQueueToBackend(st, st.index);
    } else {
      await syncCastQueueFromBackend(st);
    }

    const song = st.queue[st.index];
    if (song) {
      api.get(`/rest/scrobble?id=${song.id}`).catch(() => {});
      loadCastLyrics(st, song.id);
    }

    st.isPlaying = true;
    st.lastCastState = "PLAYING";
    st.lastScrobbledSongId = song?.id || "";
    currentPeerId.value = `dlna:${deviceId}`;
    startCastPoll(st);
  }

  // Exit cast mode for the active device: tell the backend to mark its queue
  // inactive (preserved in DB for later restore) and stop its transport.
  async function stopCast() {
    const st = activeCast.value;
    if (!st) return;
    try {
      await api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/stop`);
      await api.post(`/rest/api/v1/dlna/devices/${st.deviceId}/deactivate`);
    } catch {}
    stopCastPoll(st);
    removeCastState(st.deviceId);
    currentPeerId.value = localPeerId.value;
  }

  // On Web tab reopen: restore all active DLNA devices from the backend so
  // the user can see/control whatever is still playing. The first active
  // device becomes the current peer (matches the old single-device restore).
  async function restoreCast(): Promise<void> {
    try {
      const res = await api.get("/rest/api/v1/dlna/active");
      const active = res.data?.active || [];
      if (active.length === 0) return;
      // Resolve device names once.
      let devices: any[] = [];
      try {
        const devRes = await api.get("/rest/api/v1/dlna/devices");
        devices = devRes.data?.devices || [];
      } catch {}
      let firstRestored = false;
      for (const { deviceId, snapshot } of active) {
        if (!deviceId || !snapshot || !snapshot.isActive) continue;
        if (castStates.has(deviceId)) continue; // already tracked
        const dev = devices.find((d: any) => d.id === deviceId);
        const name = dev?.name || "DLNA 设备";
        const st = ensureCastState(deviceId, name);
        await syncCastQueueFromBackend(st);
        const song = st.queue[st.index];
        if (song) loadCastLyrics(st, song.id);
        st.lastScrobbledSongId = song?.id || "";
        startCastPoll(st);
        if (!firstRestored) {
          currentPeerId.value = `dlna:${deviceId}`;
          firstRestored = true;
        }
      }
    } catch {}
  }

  // ==================== UI-routed control functions ====================
  // These route to the active state machine based on currentPeerId. For
  // DLNA, they pass the active device's CastState. The UI calls these, so a
  // single button works for whichever device is selected.

  function playSong(song: Song) {
    if (isDlnaPeer.value && activeCast.value) castPlaySong(activeCast.value, song);
    else localPlaySong(song);
  }
  function addToQueue(song: Song) {
    if (isDlnaPeer.value && activeCast.value) castAddToQueue(activeCast.value, song);
    else localAddToQueue(song);
  }
  function playQueue(songs: Song[], index: number = 0) {
    if (isDlnaPeer.value && activeCast.value) castPlayQueue(activeCast.value, songs, index);
    else localPlayQueue(songs, index);
  }
  function togglePlay() {
    if (isDlnaPeer.value && activeCast.value) castTogglePlay(activeCast.value);
    else localTogglePlay();
  }
  function next() {
    if (isDlnaPeer.value && activeCast.value) castNext(activeCast.value);
    else localNext();
  }
  function prev() {
    if (isDlnaPeer.value && activeCast.value) castPrev(activeCast.value);
    else localPrev();
  }
  function seek(time: number) {
    if (isDlnaPeer.value && activeCast.value) castSeek(activeCast.value, time);
    else localSeek(time);
  }
  function seekPercent(percent: number) { if (duration.value > 0) seek((percent / 100) * duration.value); }
  function setVolume(v: number) {
    volume.value = v; localStorage.setItem("volume", String(v));
    if (isDlnaPeer.value && activeCast.value) {
      api.post(`/rest/api/v1/dlna/devices/${activeCast.value.deviceId}/volume`, { volume: Math.round(v * 100) }).catch(() => {});
      return;
    }
    if (howl) howl.volume(v);
  }
  function cyclePlayMode() {
    if (isDlnaPeer.value && activeCast.value) castCyclePlayMode(activeCast.value);
    else localCyclePlayMode();
  }
  function removeFromQueue(index: number) {
    if (isDlnaPeer.value && activeCast.value) castRemoveFromQueue(activeCast.value, index);
    else localRemoveFromQueue(index);
  }
  function clearQueue() {
    if (isDlnaPeer.value && activeCast.value) castClearQueue(activeCast.value);
    else localClearQueue();
    showPlaylist.value = false;
    playModeVisible.value = false;
  }

  function toggleLyrics() { showLyrics.value = !showLyrics.value; }
  function togglePlaylistPanel() { showPlaylist.value = !showPlaylist.value; }
  function togglePlayMode() { playModeVisible.value = !playModeVisible.value; }
  function loadLyrics(songId: string) {
    if (isDlnaPeer.value && activeCast.value) loadCastLyrics(activeCast.value, songId);
    else loadLocalLyrics(songId);
  }
  function updateCurrentLyric() {
    if (isDlnaPeer.value && activeCast.value) updateCastLyric(activeCast.value);
    else updateLocalLyric();
  }

  // ==================== Peer management ====================

  async function refreshPeers(): Promise<void> {
    try {
      const res = await api.get("/rest/api/v1/peers");
      peers.value = res.data?.peers || [];
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

  async function registerLocalPeer(): Promise<void> {
    const authStore = useAuthStore();
    if (!authStore.userId) return;
    try {
      await api.post("/rest/api/v1/peers/register", { name: authStore.username || "本机" });
    } catch {}
    startHeartbeat();
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/heartbeat`).catch(() => {});
    heartbeatTimer = setInterval(() => {
      api.post(`/rest/api/v1/peers/${encodeURIComponent(pid)}/heartbeat`).catch(() => {});
    }, 30_000);
  }
  function stopHeartbeat(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // Switch the player bar + queue panel to a different peer.
  // This is a PURE UI operation: it only changes currentPeerId. Neither
  // state machine is touched — 本机 keeps playing, every DLNA device keeps
  // playing. The UI computed properties (queue/isPlaying/currentTime/...)
  // automatically re-route to the newly selected peer's state machine.
  async function switchPeer(peerId: string): Promise<void> {
    if (peerId === currentPeerId.value) return;
    if (peerId.startsWith("dlna:")) {
      // Switching UI to control a DLNA device. If we don't yet have a
      // CastState for it (e.g. it's a device HA started playing on), create
      // one and pull its queue so the UI mirrors what's playing, and start
      // polling it. 本机 Howl and all other DLNA devices are NOT touched.
      const deviceId = peerId.slice(5);
      let st = castStates.get(deviceId);
      if (!st) {
        let name = "DLNA 设备";
        try {
          const devRes = await api.get("/rest/api/v1/dlna/devices");
          const dev = (devRes.data?.devices || []).find((d: any) => d.id === deviceId);
          if (dev?.name) name = dev.name;
        } catch {}
        st = ensureCastState(deviceId, name);
        await syncCastQueueFromBackend(st);
        const song = st.queue[st.index];
        if (song) loadCastLyrics(st, song.id);
        st.lastScrobbledSongId = song?.id || "";
        startCastPoll(st);
      }
      currentPeerId.value = peerId;
    } else {
      // Switching UI back to本机. Every DLNA device keeps playing on its
      // own. 本机 state is already intact (Howl kept playing if it was
      // playing). Just flip the UI pointer — the computed properties will
      // show本机 state again.
      currentPeerId.value = peerId;
    }
  }

  // Restore the local queue + index + play mode from the backend's
  // local_queues store. Called on tab reopen. Does NOT auto-resume playback.
  async function restoreLocalPeer(): Promise<void> {
    const pid = localPeerId.value;
    if (!pid || !useAuthStore().userId) return;
    try {
      const res = await api.get(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue`);
      const snap = res.data || {};
      if (Array.isArray(snap.items) && snap.items.length > 0) {
        localQueue.value = snap.items.map(queueItemToSong);
        if (typeof snap.currentIndex === "number") localIndex.value = snap.currentIndex;
        if (typeof snap.playMode === "string") {
          localPlayMode.value = snap.playMode as PlayMode;
          localStorage.setItem("playMode", localPlayMode.value);
        }
        const song = localQueue.value[localIndex.value];
        if (song) loadLocalLyrics(song.id);
      }
    } catch {}
  }

  // One-shot init for the local peer: register, restore queue, connect WS,
  // fetch the peer list. Called once from MainLayout onMounted after login.
  async function initLocalPeer(): Promise<void> {
    const authStore = useAuthStore();
    if (!authStore.userId) return;
    if (!castActive.value) currentPeerId.value = localPeerId.value;
    await registerLocalPeer();
    await restoreLocalPeer();
    await refreshPeers();
    connectPeerWs();
  }

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

  function teardownPeer(): void {
    stopHeartbeat();
    // Stop polling every tracked DLNA device.
    castStates.forEach(st => stopCastPoll(st));
    disconnectPeerWs();
  }

  return {
    // UI-routed computed (auto-switch based on currentPeerId)
    queue, currentIndex, isPlaying, currentTime, duration, playMode,
    lyrics, currentLyricLine, currentLyricIndex,
    currentSong, progress,
    // shared UI state
    volume, showLyrics, showPlaylist, playModeVisible,
    // cast indicators
    castActive, castDeviceName,
    // peer system
    currentPeerId, peers, localPeerId, currentPeer, currentPeerName,
    switchPeer, refreshPeers, initLocalPeer, restoreLocalPeer, teardownPeer,
    // UI-routed controls
    playSong, addToQueue, playQueue, togglePlay, next, prev,
    seek, seekPercent, setVolume, cyclePlayMode,
    removeFromQueue, clearQueue, getCoverUrl, loadLyrics, updateCurrentLyric,
    toggleLyrics, togglePlaylistPanel, togglePlayMode,
    // cast lifecycle (投屏)
    startCast, stopCast, restoreCast,
  };
});
