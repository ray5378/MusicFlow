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

  // ==================== DLNA (cast) state machine ====================
  // The backend device_queues table is the single source of truth. The
  // backend auto-advances tracks on its own (GENA track_ended). The
  // frontend only mirrors state via polling + REST.
  const castDeviceId = ref("");
  const castDeviceName = ref("");
  const castQueue = ref<Song[]>([]);
  const castIndex = ref(-1);
  const castIsPlaying = ref(false);
  const castCurrentTime = ref(0);
  const castDuration = ref(0);
  const castPlayMode = ref<PlayMode>("order");
  const castLyrics = ref<LyricLine[]>([]);
  const castCurrentLyricLine = ref("");
  const castCurrentLyricIndex = ref(-1);
  let castPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastCastState = "STOPPED";
  let lastScrobbledSongId = "";

  // ==================== Unified peer system ====================
  // currentPeerId drives which state machine the UI shows/controls.
  //   local:<userId>  → 本机 state machine (Howl audio + backend-stored queue)
  //   dlna:<deviceId> → DLNA state machine (backend-owned queue + auto-advance)
  // switchPeer only changes currentPeerId — it never touches either state
  // machine. Both devices keep playing independently.
  const currentPeerId = ref<string>("");
  const peers = ref<any[]>([]);
  const localPeerId = computed(() => `local:${useAuthStore().userId}`);
  const isDlnaPeer = computed(() => currentPeerId.value.startsWith("dlna:"));
  const castActive = computed(() => !!castDeviceId.value);
  const currentPeer = computed(() => peers.value.find(p => p.peerId === currentPeerId.value));
  const currentPeerName = computed(() => {
    const p = currentPeer.value;
    if (!p) return isDlnaPeer.value ? castDeviceName.value : "本机";
    return p.kind === "local" ? "本机" : p.name;
  });
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let peerWs: WebSocket | null = null;

  // ==================== UI-routed computed properties ====================
  // These pick the active state machine based on currentPeerId. The UI
  // (MainLayout) binds to these, so it automatically shows/controls the
  // right device when the user switches peers.
  const queue = computed(() => isDlnaPeer.value ? castQueue.value : localQueue.value);
  const currentIndex = computed(() => isDlnaPeer.value ? castIndex.value : localIndex.value);
  const isPlaying = computed(() => isDlnaPeer.value ? castIsPlaying.value : localIsPlaying.value);
  const currentTime = computed(() => isDlnaPeer.value ? castCurrentTime.value : localCurrentTime.value);
  const duration = computed(() => isDlnaPeer.value ? castDuration.value : localDuration.value);
  const playMode = computed(() => isDlnaPeer.value ? castPlayMode.value : localPlayMode.value);
  const lyrics = computed(() => isDlnaPeer.value ? castLyrics.value : localLyrics.value);
  const currentLyricLine = computed(() => isDlnaPeer.value ? castCurrentLyricLine.value : localCurrentLyricLine.value);
  const currentLyricIndex = computed(() => isDlnaPeer.value ? castCurrentLyricIndex.value : localCurrentLyricIndex.value);

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

  function castPlaySong(song: Song) {
    const idx = castQueue.value.findIndex(s => s.id === song.id);
    if (idx >= 0) { castIndex.value = idx; } else { castQueue.value.push(song); castIndex.value = castQueue.value.length - 1; }
    startCastPlayback();
  }

  function castAddToQueue(song: Song) {
    if (castQueue.value.findIndex(s => s.id === song.id) >= 0) return;
    castQueue.value.push(song);
    api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue/enqueue`, {
      items: [songToQueueItem(song)],
    }).catch(() => {});
  }

  function castPlayQueue(songs: Song[], index: number = 0) {
    castQueue.value = [...songs];
    if (castPlayMode.value === "shuffle" && songs.length > 1) {
      castIndex.value = Math.floor(Math.random() * songs.length);
    } else {
      castIndex.value = index;
    }
    startCastPlayback();
  }

  // Push the current cast queue to the backend as the authoritative queue
  // and start playing from the current index.
  async function pushCastQueueToBackend(startIndex: number): Promise<void> {
    if (!castDeviceId.value) return;
    const items = castQueue.value.map(songToQueueItem);
    try {
      await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue/play`, {
        items,
        startIndex,
      });
      await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/play-mode`, {
        mode: castPlayMode.value,
      }).catch(() => {});
    } catch (e: any) {
      console.error("pushCastQueueToBackend failed:", e?.message || e);
    }
  }

  function startCastPlayback() {
    pushCastQueueToBackend(castIndex.value >= 0 ? castIndex.value : 0);
  }

  async function loadCastLyrics(songId: string) {
    castLyrics.value = [];
    castCurrentLyricLine.value = "";
    castCurrentLyricIndex.value = -1;
    try {
      const res = await api.get(`/rest/getLyricsBySongId?id=${songId}&f=json`);
      const structured = res.data["subsonic-response"]?.lyricsList?.structuredLyrics || [];
      const first = structured.find((l: any) => l.synced) || structured[0];
      if (!first || !first.line) return;
      castLyrics.value = first.line
        .filter((l: any) => l.start !== undefined && l.start !== null)
        .map((l: any) => ({ time: Number(l.start) / 1000, text: l.value }))
        .sort((a: LyricLine, b: LyricLine) => a.time - b.time);
    } catch { castLyrics.value = []; }
  }

  function updateCastLyric() {
    if (castLyrics.value.length === 0) { castCurrentLyricLine.value = ""; castCurrentLyricIndex.value = -1; return; }
    const t = castCurrentTime.value;
    let idx = -1;
    for (let i = 0; i < castLyrics.value.length; i++) {
      if (castLyrics.value[i].time <= t) idx = i;
      else break;
    }
    if (idx !== castCurrentLyricIndex.value) {
      castCurrentLyricIndex.value = idx;
      castCurrentLyricLine.value = idx >= 0 ? castLyrics.value[idx].text : "";
    }
  }

  function castTogglePlay() {
    if (!castDeviceId.value) return;
    const id = castDeviceId.value;
    if (castIsPlaying.value) {
      api.post(`/rest/api/v1/dlna/devices/${id}/pause`).catch(() => {});
      castIsPlaying.value = false;
    } else {
      api.post(`/rest/api/v1/dlna/devices/${id}/play`).catch(() => {});
      castIsPlaying.value = true;
    }
  }

  function castNext() {
    if (!castDeviceId.value || castQueue.value.length === 0) return;
    api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/next`).catch(() => {});
  }

  function castPrev() {
    if (!castDeviceId.value || castQueue.value.length === 0) return;
    if (castCurrentTime.value > 3) { castSeek(0); return; }
    api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/prev`).catch(() => {});
  }

  function castSeek(time: number) {
    if (!castDeviceId.value) return;
    api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/seek`, { seconds: time }).catch(() => {});
    castCurrentTime.value = time; updateCastLyric();
  }

  function castRemoveFromQueue(index: number) {
    if (!castDeviceId.value) return;
    api.delete(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue/${index}`).catch(() => {});
  }

  function castClearQueue() {
    if (!castDeviceId.value) return;
    api.delete(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue`).catch(() => {});
    castDeviceId.value = "";
    castDeviceName.value = "";
    stopCastPoll();
    castQueue.value = []; castIndex.value = -1; castIsPlaying.value = false;
    castCurrentTime.value = 0; castDuration.value = 0;
    castLyrics.value = []; castCurrentLyricLine.value = ""; castCurrentLyricIndex.value = -1;
    lastCastState = "STOPPED";
  }

  function castCyclePlayMode() {
    const modes: PlayMode[] = ["order", "one", "all", "shuffle"];
    castPlayMode.value = modes[(modes.indexOf(castPlayMode.value) + 1) % modes.length];
    if (castDeviceId.value) {
      api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/play-mode`, { mode: castPlayMode.value }).catch(() => {});
    }
  }

  // Poll the backend for device transport state + the authoritative queue
  // snapshot. The backend handles auto-advance on its own; the poller just
  // mirrors that state into the cast state machine so the UI stays in sync.
  function startCastPoll() {
    stopCastPoll();
    castPollTimer = setInterval(async () => {
      if (!castDeviceId.value) { stopCastPoll(); return; }
      try {
        const res = await api.get(`/rest/api/v1/dlna/devices/${castDeviceId.value}/status`);
        const st = res.data || {};
        lastCastState = st.state || "STOPPED";
        if (typeof st.position === "number") castCurrentTime.value = st.position;
        if (typeof st.duration === "number" && st.duration > 0) castDuration.value = st.duration;
        castIsPlaying.value = st.state === "PLAYING";

        const media = st.media;
        if (media && media.songId && media.songId !== lastScrobbledSongId) {
          lastScrobbledSongId = media.songId;
          api.get(`/rest/scrobble?id=${media.songId}`).catch(() => {});
          loadCastLyrics(media.songId);
        }
        updateCastLyric();
        syncCastQueueFromBackend();
      } catch {}
    }, 2000);
  }
  function stopCastPoll() { if (castPollTimer) { clearInterval(castPollTimer); castPollTimer = null; } }

  // Pull the backend's authoritative queue snapshot into the cast state.
  async function syncCastQueueFromBackend(): Promise<void> {
    if (!castDeviceId.value) return;
    try {
      const res = await api.get(`/rest/api/v1/dlna/devices/${castDeviceId.value}/queue`);
      const snap = res.data || {};
      if (Array.isArray(snap.items)) {
        castQueue.value = snap.items.map(queueItemToSong);
      }
      if (typeof snap.currentIndex === "number") castIndex.value = snap.currentIndex;
      if (typeof snap.playMode === "string") castPlayMode.value = snap.playMode as PlayMode;
    } catch {}
  }

  // Enter cast mode: push the queue to the backend and start polling.
  // This is the "投屏" operation — it pushes the current本机 queue to the
  // DLNA device and switches the UI to control that device. 本机 Howl is
  // paused because投屏 means "play on the remote device instead of here".
  // (This is distinct from switchPeer, which only changes the UI view.)
  async function startCast(deviceId: string, deviceName: string) {
    if (howl) { howl.pause(); }
    stopLocalProgressTimer();
    castDeviceId.value = deviceId;
    castDeviceName.value = deviceName;
    currentPeerId.value = `dlna:${deviceId}`;

    if (localQueue.value.length > 0) {
      castQueue.value = [...localQueue.value];
      castIndex.value = localIndex.value >= 0 ? localIndex.value : 0;
      castPlayMode.value = localPlayMode.value;
      await pushCastQueueToBackend(castIndex.value);
    } else {
      await syncCastQueueFromBackend();
    }

    const song = castQueue.value[castIndex.value];
    if (song) {
      api.get(`/rest/scrobble?id=${song.id}`).catch(() => {});
      loadCastLyrics(song.id);
    }

    castIsPlaying.value = true;
    lastCastState = "PLAYING";
    lastScrobbledSongId = song?.id || "";
    startCastPoll();
  }

  // Exit cast mode: tell the backend to mark this device's queue inactive
  // (preserved in DB for later restore) and stop the device's transport.
  async function stopCast() {
    if (castDeviceId.value) {
      try {
        await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/stop`);
        await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/deactivate`);
      } catch {}
    }
    castDeviceId.value = "";
    castDeviceName.value = "";
    currentPeerId.value = localPeerId.value;
    stopCastPoll();
    castIsPlaying.value = false;
    castCurrentTime.value = 0;
    lastCastState = "STOPPED";
  }

  // On Web tab reopen: if the backend has an active cast queue, restore the
  // cast state machine so the user sees what's playing on the DLNA device.
  async function restoreCast(): Promise<void> {
    if (castActive.value) return;
    try {
      const res = await api.get("/rest/api/v1/dlna/active");
      const active = res.data?.active || [];
      if (active.length === 0) return;
      const { deviceId, snapshot } = active[0];
      if (!deviceId || !snapshot || !snapshot.isActive) return;
      let name = "DLNA 设备";
      try {
        const devRes = await api.get("/rest/api/v1/dlna/devices");
        const dev = (devRes.data?.devices || []).find((d: any) => d.id === deviceId);
        if (dev?.name) name = dev.name;
      } catch {}
      castDeviceId.value = deviceId;
      castDeviceName.value = name;
      currentPeerId.value = `dlna:${deviceId}`;
      await syncCastQueueFromBackend();
      const song = castQueue.value[castIndex.value];
      if (song) loadCastLyrics(song.id);
      lastScrobbledSongId = song?.id || "";
      startCastPoll();
    } catch {}
  }

  // ==================== UI-routed control functions ====================
  // These route to the active state machine based on currentPeerId. The UI
  // calls these, so a single button works for whichever device is selected.

  function playSong(song: Song) {
    if (isDlnaPeer.value) castPlaySong(song); else localPlaySong(song);
  }
  function addToQueue(song: Song) {
    if (isDlnaPeer.value) castAddToQueue(song); else localAddToQueue(song);
  }
  function playQueue(songs: Song[], index: number = 0) {
    if (isDlnaPeer.value) castPlayQueue(songs, index); else localPlayQueue(songs, index);
  }
  function togglePlay() {
    if (isDlnaPeer.value) castTogglePlay(); else localTogglePlay();
  }
  function next() {
    if (isDlnaPeer.value) castNext(); else localNext();
  }
  function prev() {
    if (isDlnaPeer.value) castPrev(); else localPrev();
  }
  function seek(time: number) {
    if (isDlnaPeer.value) castSeek(time); else localSeek(time);
  }
  function seekPercent(percent: number) { if (duration.value > 0) seek((percent / 100) * duration.value); }
  function setVolume(v: number) {
    volume.value = v; localStorage.setItem("volume", String(v));
    if (isDlnaPeer.value && castDeviceId.value) {
      api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/volume`, { volume: Math.round(v * 100) }).catch(() => {});
      return;
    }
    if (howl) howl.volume(v);
  }
  function cyclePlayMode() {
    if (isDlnaPeer.value) castCyclePlayMode(); else localCyclePlayMode();
  }
  function removeFromQueue(index: number) {
    if (isDlnaPeer.value) castRemoveFromQueue(index); else localRemoveFromQueue(index);
  }
  function clearQueue() {
    if (isDlnaPeer.value) castClearQueue(); else localClearQueue();
    showPlaylist.value = false;
    playModeVisible.value = false;
  }

  function toggleLyrics() { showLyrics.value = !showLyrics.value; }
  function togglePlaylistPanel() { showPlaylist.value = !showPlaylist.value; }
  function togglePlayMode() { playModeVisible.value = !playModeVisible.value; }
  function loadLyrics(songId: string) {
    if (isDlnaPeer.value) loadCastLyrics(songId); else loadLocalLyrics(songId);
  }
  function updateCurrentLyric() {
    if (isDlnaPeer.value) updateCastLyric(); else updateLocalLyric();
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
  // state machine is touched — 本机 keeps playing, DLNA keeps playing. The
  // UI computed properties (queue/isPlaying/currentTime/...) automatically
  // re-route to the newly selected peer's state machine.
  async function switchPeer(peerId: string): Promise<void> {
    if (peerId === currentPeerId.value) return;
    if (peerId.startsWith("dlna:")) {
      // Switching UI to control a DLNA device. If we're not already casting
      // to it (e.g. it's a device HA started playing on), pull its queue so
      // the UI mirrors what's playing. 本机 Howl is NOT touched.
      const deviceId = peerId.slice(5);
      if (castDeviceId.value !== deviceId) {
        let name = "DLNA 设备";
        try {
          const devRes = await api.get("/rest/api/v1/dlna/devices");
          const dev = (devRes.data?.devices || []).find((d: any) => d.id === deviceId);
          if (dev?.name) name = dev.name;
        } catch {}
        castDeviceId.value = deviceId;
        castDeviceName.value = name;
        await syncCastQueueFromBackend();
        const song = castQueue.value[castIndex.value];
        if (song) loadCastLyrics(song.id);
        lastScrobbledSongId = song?.id || "";
        startCastPoll();
      }
      currentPeerId.value = peerId;
    } else {
      // Switching UI back to本机. DLNA keeps playing on its own. 本机 state
      // is already intact (Howl kept playing if it was playing). Just flip
      // the UI pointer — the computed properties will show本机 state again.
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
    stopCastPoll();
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
