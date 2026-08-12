import { defineStore } from "pinia";
import { ref, computed, reactive } from "vue";
import { Howl } from "howler";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { useIsMobile } from "@/composables/useIsMobile";
import { coverUrl } from "@/utils/cover";

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
    albumId: song.albumId || undefined,
    mime: SUFFIX_MIME[(song.suffix || "").toLowerCase()] || "audio/mpeg",
    coverArt: song.coverArt || (song.albumId ? `al-${song.albumId}` : undefined),
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
    albumId: it.albumId,
    duration: it.duration || 0,
    coverArt: it.coverArt || (it.albumId ? `al-${it.albumId}` : undefined),
  };
}

export const usePlayerStore = defineStore("player", () => {
  type PlayMode = "order" | "one" | "all" | "shuffle";

  // ==================== Shared UI state ====================
  const volume = ref(parseFloat(localStorage.getItem("volume") || "0.8"));
  const showLyrics = ref(false);
  const showPlaylist = ref(false);
  const playModeVisible = ref(false); // fullscreen play mode overlay

  // Desktop: automatically open the queue panel when playback starts, or when
  // switching to a player that is already playing. Mobile has its own bottom
  // sheet, so this only applies to ≥769px viewports.
  const isMobile = useIsMobile();
  function autoshowQueue() { if (!isMobile.value) showPlaylist.value = true; }

  // ==================== Local (本机) state machine ====================
  // Completely independent from DLNA. Howl's onend only calls localNext,
  // never touching the DLNA state machine. The user can switch the UI to
  // control a DLNA device while本机 keeps playing on its own.
  const localQueue = ref<Song[]>([]);
  const localIndex = ref(-1);
  const localIsPlaying = ref(false);
  const localCurrentTime = ref(0);
  const localDuration = ref(0);
  const localPlayMode = ref<PlayMode>((localStorage.getItem("playMode") as PlayMode) || "shuffle");
  const localLyrics = ref<LyricLine[]>([]);
  const localCurrentLyricLine = ref("");
  const localCurrentLyricIndex = ref(-1);
  let howl: Howl | null = null;
  // Consecutive load/play failures; reaching MAX stops auto-skipping to avoid an
  // infinite loop when the whole queue is unplayable.
  let localFailStreak = 0;
  const LOCAL_MAX_FAIL_STREAK = 5;

  // ==================== Unified peer system (core refs, declared early) ====================
  // currentPeerId drives which state machine the UI shows/controls.
  //   local:<userId>  → 本机 state machine (Howl audio + backend-stored queue)
  //   dlna:<deviceId> → that device's RemoteState (backend-owned queue + auto-advance)
  //   group:<groupId> → that player group's RemoteState (MA SyncGroup 同款:队列/状态归组,
  //                     播放时后端并发向在线成员 cast)
  // Declared here (before the remote state machine) because activeRemotePeerId
  // derives from it.
  const currentPeerId = ref<string>("");
  const localPeerId = computed(() => `local:${useAuthStore().userId}`);
  const isRemotePeer = computed(() => {
    const pid = currentPeerId.value;
    return pid.startsWith("dlna:") || pid.startsWith("group:");
  });

  // ==================== Remote (DLNA cast + player group) state machine ====================
  // Multi-target: each remote peer (dlna:<deviceId> or group:<groupId>) gets its
  // own RemoteState, so multiple devices/groups can play independently and the
  // UI can switch between them without losing any target's mirrored state. The
  // backend device_queues / group_queues tables are the single source of truth
  // per peer; the frontend only mirrors state via per-peer polling + REST.
  interface RemoteState {
    peerId: string; // "dlna:<deviceId>" | "group:<groupId>"
    kind: "dlna" | "group";
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
  // reactive Map so Vue tracks deep changes to each peer's state.
  const remoteStates = reactive(new Map<string, RemoteState>());

  function getRemoteState(peerId: string): RemoteState | undefined {
    return remoteStates.get(peerId);
  }
  function ensureRemoteState(peerId: string, name: string = ""): RemoteState {
    let st = remoteStates.get(peerId);
    if (!st) {
      const kind: RemoteState["kind"] = peerId.startsWith("group:") ? "group" : "dlna";
      const raw: RemoteState = {
        peerId,
        kind,
        name: name || (kind === "group" ? "播放器群组" : "DLNA 设备"),
        queue: [],
        index: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        playMode: "shuffle" as PlayMode,
        lyrics: [],
        currentLyricLine: "",
        currentLyricIndex: -1,
        pollTimer: null,
        tickTimer: null,
        lastCastState: "STOPPED",
        lastScrobbledSongId: "",
      };
      remoteStates.set(peerId, raw);
      // IMPORTANT: reactive Map wraps the value in a proxy on set, so the
      // original `raw` object is NOT the reactive one. Re-fetch the proxy
      // so all subsequent mutations (st.currentTime = ..., st.isPlaying =
      // ...) go through reactivity and the UI actually updates.
      st = remoteStates.get(peerId)!;
    } else if (name && name !== st.name) {
      st.name = name;
    }
    return st;
  }
  function removeRemoteState(peerId: string): void {
    const st = remoteStates.get(peerId);
    if (st?.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    if (st?.tickTimer) { clearInterval(st.tickTimer); st.tickTimer = null; }
    remoteStates.delete(peerId);
  }

  // The currently-active remote peer (the one the UI is bound to, if any).
  // Derived from currentPeerId so there's a single source of truth.
  const activeRemotePeerId = computed(() => (isRemotePeer.value ? currentPeerId.value : ""));
  const activeRemote = computed(() => {
    const id = activeRemotePeerId.value;
    return id ? remoteStates.get(id) : undefined;
  });
  // castActive means "at least one DLNA device is being tracked" (group peers
  // don't count — the 投屏 button/dialog is DLNA-only).
  const castActive = computed(() => {
    for (const pid of remoteStates.keys()) {
      if (pid.startsWith("dlna:")) return true;
    }
    return false;
  });
  const castDeviceName = computed(() => {
    const st = activeRemote.value;
    return st && st.kind === "dlna" ? st.name : "";
  });

  // ==================== Unified peer system (rest) ====================
  const peers = ref<any[]>([]);
  const currentPeer = computed(() => peers.value.find(p => p.peerId === currentPeerId.value));
  const currentPeerName = computed(() => {
    const p = currentPeer.value;
    if (!p) return isRemotePeer.value ? castDeviceName.value : "本机";
    return p.kind === "local" ? "本机" : p.name;
  });
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let peerWs: WebSocket | null = null;

  // ==================== UI-routed computed properties ====================
  // These pick the active state machine based on currentPeerId. For remote
  // peers (dlna / group), they read from the active peer's RemoteState. The
  // UI (MainLayout) binds to these, so it automatically shows/controls the
  // right target when the user switches peers.
  const queue = computed(() => isRemotePeer.value ? (activeRemote.value?.queue ?? []) : localQueue.value);
  const currentIndex = computed(() => isRemotePeer.value ? (activeRemote.value?.index ?? -1) : localIndex.value);
  const isPlaying = computed(() => isRemotePeer.value ? (activeRemote.value?.isPlaying ?? false) : localIsPlaying.value);
  const currentTime = computed(() => isRemotePeer.value ? (activeRemote.value?.currentTime ?? 0) : localCurrentTime.value);
  const duration = computed(() => isRemotePeer.value ? (activeRemote.value?.duration ?? 0) : localDuration.value);
  const playMode = computed(() => isRemotePeer.value ? (activeRemote.value?.playMode ?? "shuffle") : localPlayMode.value);
  const lyrics = computed(() => isRemotePeer.value ? (activeRemote.value?.lyrics ?? []) : localLyrics.value);
  const currentLyricLine = computed(() => isRemotePeer.value ? (activeRemote.value?.currentLyricLine ?? "") : localCurrentLyricLine.value);
  const currentLyricIndex = computed(() => isRemotePeer.value ? (activeRemote.value?.currentLyricIndex ?? -1) : localCurrentLyricIndex.value);

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
  function getCoverUrl(id: string | undefined) { return coverUrl(id, 300); }

  // Build a backend peer API path for a remote peer (dlna:<id> or group:<id>).
  // The backend routes both kinds through the same unified queue controller
  // and transport layer, so one path shape serves both.
  function peerApi(peerId: string, suffix: string): string {
    return `/rest/api/v1/peers/${encodeURIComponent(peerId)}${suffix}`;
  }

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
    const fmt = (song.suffix || "").toLowerCase();
    howl = new Howl({
      src: [getStreamUrl(song.id)],
      format: fmt ? [fmt] : [],
      volume: volume.value,
      html5: true,
      onplay: () => {
        localFailStreak = 0;
        localIsPlaying.value = true;
        localDuration.value = howl?.duration() || 0;
        startLocalProgressTimer();
        api.get(`/rest/scrobble?id=${song.id}`).catch(() => {});
      },
      onpause: () => { localIsPlaying.value = false; stopLocalProgressTimer(); },
      onend: () => { localNext(); },
      onload: () => { localDuration.value = howl?.duration() || 0; },
      onloaderror: () => { localHandlePlaybackError(song.id); },
      onplayerror: () => { localHandlePlaybackError(song.id); },
    });
    howl.play();
    // 乐观置位:点击播放后立即让按钮显示"暂停",不再单纯依赖浏览器 onplay 事件。
    // html5 自动播放策略下 onplay 偶发迟到/丢失,会导致"在播但按钮仍是播放"的偶发 bug;
    // 后续由 onplay/onpause 与进度轮询(howl.playing())共同校正状态。
    localIsPlaying.value = true;
    startLocalProgressTimer();
    autoshowQueue();
  }

  // Auto-skip when a song can't be fetched/played (e.g. no stream available on
  // any source). Stops after LOCAL_MAX_FAIL_STREAK consecutive failures so a
  // fully-unplayable queue doesn't spin forever.
  function localHandlePlaybackError(songId: string) {
    try { howl?.unload(); } catch {}
    howl = null;
    localFailStreak++;
    console.warn(`[player] 播放失败(${localFailStreak}) songId=${songId}, 自动跳过`);
    if (localFailStreak >= LOCAL_MAX_FAIL_STREAK) {
      console.warn("[player] 连续失败过多,停止自动跳过");
      localFailStreak = 0;
      localIsPlaying.value = false;
      stopLocalProgressTimer();
      return;
    }
    localNext();
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
    if (localIsPlaying.value) {
      howl.pause();
    } else {
      howl.play();
      localIsPlaying.value = true; // 乐观置位,避免 onplay 丢失导致按钮不切换
      startLocalProgressTimer();
    }
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
      if (!howl) return;
      // 自愈校正:onplay/onpause 偶发丢失时,以 howl.playing()(源自 <audio>.paused,权威)
      // 为真值源修正按钮状态,避免"在播却显示播放"或"已暂停却仍显示暂停"的偶发不同步。
      const playing = howl.playing();
      if (playing !== localIsPlaying.value) localIsPlaying.value = playing;
      if (playing) {
        localCurrentTime.value = howl.seek() as number || 0;
        updateLocalLyric();
      }
    }, 250);
  }
  function stopLocalProgressTimer() { if (localProgressTimer) { clearInterval(localProgressTimer); localProgressTimer = null; } }

  // ==================== Remote (DLNA cast + group) playback ====================
  // All functions operate on a specific peer's RemoteState. The UI-routed
  // wrappers below pass the active peer's state.

  function castPlaySong(st: RemoteState, song: Song) {
    const idx = st.queue.findIndex(s => s.id === song.id);
    if (idx >= 0) { st.index = idx; } else { st.queue.push(song); st.index = st.queue.length - 1; }
    startCastPlayback(st);
  }

  function castAddToQueue(st: RemoteState, song: Song) {
    if (st.queue.findIndex(s => s.id === song.id) >= 0) return;
    st.queue.push(song);
    api.post(peerApi(st.peerId, "/queue/enqueue"), {
      items: [songToQueueItem(song)],
    }).catch(() => {});
  }

  function castPlayQueue(st: RemoteState, songs: Song[], index: number = 0) {
    st.queue = [...songs];
    if (st.playMode === "shuffle" && songs.length > 1) {
      st.index = Math.floor(Math.random() * songs.length);
    } else {
      st.index = index;
    }
    startCastPlayback(st);
  }

  // Push a peer's queue to the backend as the authoritative queue and
  // start playing from the current index (dlna: casts to the device;
  // group: fans out to all online members).
  async function pushCastQueueToBackend(st: RemoteState, startIndex: number): Promise<void> {
    const items = st.queue.map(songToQueueItem);
    try {
      await api.post(peerApi(st.peerId, "/queue/play"), {
        items,
        startIndex,
      });
      await api.post(peerApi(st.peerId, "/play-mode"), {
        mode: st.playMode,
      }).catch(() => {});
    } catch (e: any) {
      console.error("pushCastQueueToBackend failed:", e?.message || e);
    }
  }

  function startCastPlayback(st: RemoteState) {
    pushCastQueueToBackend(st, st.index >= 0 ? st.index : 0);
    // 乐观置位:点击播放后立刻让按钮显示"暂停",不依赖后端轮询/事件。
    // 否则在「清空→重选设备→重新播放」场景下,GENA 事件缓存的 state 可能停在 STOPPED,
    // 导致轮询读到的 state 一直非 PLAYING 而按钮卡在"未播放"(进度条却仍在走)。
    st.isPlaying = true;
    autoshowQueue();
  }

  async function loadCastLyrics(st: RemoteState, songId: string) {
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

  function updateCastLyric(st: RemoteState) {
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

  function castTogglePlay(st: RemoteState) {
    if (st.isPlaying) {
      api.post(peerApi(st.peerId, "/pause")).catch(() => {});
      st.isPlaying = false;
    } else {
      api.post(peerApi(st.peerId, "/play")).catch(() => {});
      st.isPlaying = true;
    }
  }

  function castNext(st: RemoteState) {
    if (st.queue.length === 0) return;
    api.post(peerApi(st.peerId, "/next")).catch(() => {});
  }

  function castPrev(st: RemoteState) {
    if (st.queue.length === 0) return;
    if (st.currentTime > 3) { castSeek(st, 0); return; }
    api.post(peerApi(st.peerId, "/prev")).catch(() => {});
  }

  function castSeek(st: RemoteState, time: number) {
    api.post(peerApi(st.peerId, "/seek"), { seconds: time }).catch(() => {});
    st.currentTime = time; updateCastLyric(st);
  }

  function castRemoveFromQueue(st: RemoteState, index: number) {
    api.delete(peerApi(st.peerId, `/queue/${index}`)).catch(() => {});
  }

  function castClearQueue(st: RemoteState) {
    api.delete(peerApi(st.peerId, "/queue")).catch(() => {});
    stopCastPoll(st);
    removeRemoteState(st.peerId);
    // If the cleared peer was the active one, fall back to本机.
    if (activeRemotePeerId.value === st.peerId) {
      currentPeerId.value = localPeerId.value;
    }
  }

  function castCyclePlayMode(st: RemoteState) {
    const modes: PlayMode[] = ["order", "one", "all", "shuffle"];
    st.playMode = modes[(modes.indexOf(st.playMode) + 1) % modes.length];
    api.post(peerApi(st.peerId, "/play-mode"), { mode: st.playMode }).catch(() => {});
  }

  // Per-peer poll: mirrors backend transport state + queue into the peer's
  // RemoteState. Each peer has its own timer, so multiple targets are tracked
  // simultaneously without interfering with each other. For groups the status
  // is derived from the leader by the backend (MA 同款)。
  function startCastPoll(st: RemoteState) {
    stopCastPoll(st);
    // 进度自愈:记录上次轮询到的真实 position,用于判断"是否真的在前进"。
    let lastPos = -1;
    // Backend poll (2s): ground-truth state + queue snapshot.
    st.pollTimer = setInterval(async () => {
      try {
        const res = await api.get(peerApi(st.peerId, "/status"));
        const s = res.data || {};
        st.lastCastState = s.state || "STOPPED";
        if (typeof s.position === "number") st.currentTime = s.position;
        if (typeof s.duration === "number" && s.duration > 0) st.duration = s.duration;
        // 播放状态判定(自愈):
        // 1) 后端 state 明确为 PLAYING/playing/STARTED → 在播;
        // 2) 关键自愈:部分 DLNA 设备经「清空→重选→重新播放」后,GENA 事件缓存的
        //    state 停留在旧值(如 STOPPED)并覆盖 SOAP 实时 PLAYING,轮询读到
        //    state=STOPPED 却 position 仍在前进(进度条在走)。此时以"position 真实前进"
        //    作为在播的权威证据,强制 isPlaying=true,避免按钮卡在"未播放"。
        const statePlaying = s.state === "PLAYING" || s.state === "playing" || s.state === "STARTED";
        const advancing = st.duration > 0 && st.currentTime > lastPos && st.currentTime < st.duration;
        st.isPlaying = statePlaying || advancing;
        if (typeof s.position === "number") lastPos = s.position;
        // 同步设备真实音量(含 外部 webhook / 其它端 改的)。仅当当前正控制该 peer。
        if (typeof s.volume === "number" && currentPeerId.value === st.peerId) {
          volume.value = Math.max(0, Math.min(100, s.volume)) / 100;
        }

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
  function stopCastPoll(st: RemoteState) {
    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    if (st.tickTimer) { clearInterval(st.tickTimer); st.tickTimer = null; }
  }

  // Pull the backend's authoritative queue snapshot into a peer's state.
  async function syncCastQueueFromBackend(st: RemoteState): Promise<void> {
    try {
      const res = await api.get(peerApi(st.peerId, "/queue"));
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
    const st = ensureRemoteState(`dlna:${deviceId}`, deviceName);

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
    const st = activeRemote.value;
    if (!st) return;
    try {
      await api.post(`/rest/api/v1/dlna/devices/${st.peerId.slice(5)}/stop`);
      await api.post(`/rest/api/v1/dlna/devices/${st.peerId.slice(5)}/deactivate`);
    } catch {}
    stopCastPoll(st);
    removeRemoteState(st.peerId);
    currentPeerId.value = localPeerId.value;
  }

  // On Web tab reopen: restore all active DLNA devices (and any actively
  // playing player groups) from the backend so the user can see/control
  // whatever is still playing. The first restored target becomes the current
  // peer (matches the old single-device restore).
  async function restoreCast(): Promise<void> {
    try {
      const res = await api.get("/rest/api/v1/dlna/active");
      const active = res.data?.active || [];
      // Resolve device names once.
      let devices: any[] = [];
      try {
        const devRes = await api.get("/rest/api/v1/dlna/devices");
        devices = devRes.data?.devices || [];
      } catch {}
      let firstRestored = false;
      for (const { deviceId, snapshot } of active) {
        if (!deviceId || !snapshot || !snapshot.isActive) continue;
        if (remoteStates.has(`dlna:${deviceId}`)) continue; // already tracked
        const dev = devices.find((d: any) => d.id === deviceId);
        const name = dev?.name || "DLNA 设备";
        const st = ensureRemoteState(`dlna:${deviceId}`, name);
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
      // Player groups: restore any group whose queue is active (isActive) —
      // the group peer itself is permanent and carries its queue snapshot.
      if (!firstRestored) {
        try {
          const peersRes = await api.get("/rest/api/v1/peers");
          const groupPeers = (peersRes.data?.peers || [])
            .filter((p: any) => p.kind === "group" && p.queue && p.queue.isActive);
          for (const p of groupPeers) {
            if (remoteStates.has(p.peerId)) continue;
            const st = ensureRemoteState(p.peerId, p.name || "播放器群组");
            await syncCastQueueFromBackend(st);
            const song = st.queue[st.index];
            if (song) loadCastLyrics(st, song.id);
            st.lastScrobbledSongId = song?.id || "";
            startCastPoll(st);
            if (!firstRestored) {
              currentPeerId.value = p.peerId;
              firstRestored = true;
            }
          }
        } catch {}
      }
    } catch {}
  }

  // ==================== UI-routed control functions ====================
  // These route to the active state machine based on currentPeerId. For
  // remote peers (dlna / group), they pass the active peer's RemoteState.
  // The UI calls these, so a single button works for whichever target is
  // selected.

  function playSong(song: Song) {
    if (isRemotePeer.value && activeRemote.value) castPlaySong(activeRemote.value, song);
    else localPlaySong(song);
  }
  function addToQueue(song: Song) {
    if (isRemotePeer.value && activeRemote.value) castAddToQueue(activeRemote.value, song);
    else localAddToQueue(song);
  }
  function playQueue(songs: Song[], index: number = 0) {
    if (isRemotePeer.value && activeRemote.value) castPlayQueue(activeRemote.value, songs, index);
    else localPlayQueue(songs, index);
  }
  function togglePlay() {
    if (isRemotePeer.value && activeRemote.value) castTogglePlay(activeRemote.value);
    else localTogglePlay();
  }
  function next() {
    if (isRemotePeer.value && activeRemote.value) castNext(activeRemote.value);
    else localNext();
  }
  function prev() {
    if (isRemotePeer.value && activeRemote.value) castPrev(activeRemote.value);
    else localPrev();
  }
  function seek(time: number) {
    if (isRemotePeer.value && activeRemote.value) castSeek(activeRemote.value, time);
    else localSeek(time);
  }
  function seekPercent(percent: number) { if (duration.value > 0) seek((percent / 100) * duration.value); }
  function setVolume(v: number) {
    volume.value = v; localStorage.setItem("volume", String(v));
    if (isRemotePeer.value && activeRemote.value) {
      api.post(peerApi(activeRemote.value.peerId, "/volume"), { volume: Math.round(v * 100) }).catch(() => {});
      return;
    }
    if (howl) howl.volume(v);
  }
  function cyclePlayMode() {
    if (isRemotePeer.value && activeRemote.value) castCyclePlayMode(activeRemote.value);
    else localCyclePlayMode();
  }
  function removeFromQueue(index: number) {
    if (isRemotePeer.value && activeRemote.value) castRemoveFromQueue(activeRemote.value, index);
    else localRemoveFromQueue(index);
  }
  function clearQueue() {
    // 记住被清空的 peer,便于同步播放器切换器列表的队列状态。
    const clearedPeerId = isRemotePeer.value && activeRemote.value
      ? activeRemote.value.peerId
      : localPeerId.value;
    if (isRemotePeer.value && activeRemote.value) castClearQueue(activeRemote.value);
    else localClearQueue();
    if (clearedPeerId) markPeerQueueEmpty(clearedPeerId);
    showPlaylist.value = false;
    playModeVisible.value = false;
  }

  // 立即清空 peers 列表中对应播放器的队列显示(切换器无需手动刷新)。
  function markPeerQueueEmpty(peerId: string): void {
    const idx = peers.value.findIndex(p => p.peerId === peerId);
    if (idx < 0) return;
    peers.value[idx] = {
      ...peers.value[idx],
      queue: { items: [], currentIndex: -1, playMode: "shuffle", isActive: false },
    };
  }

  function toggleLyrics() { showLyrics.value = !showLyrics.value; }
  function togglePlaylistPanel() { showPlaylist.value = !showPlaylist.value; }
  function togglePlayMode() { playModeVisible.value = !playModeVisible.value; }
  function loadLyrics(songId: string) {
    if (isRemotePeer.value && activeRemote.value) loadCastLyrics(activeRemote.value, songId);
    else loadLocalLyrics(songId);
  }
  function updateCurrentLyric() {
    if (isRemotePeer.value && activeRemote.value) updateCastLyric(activeRemote.value);
    else updateLocalLyric();
  }

  // ==================== Peer management ====================

  // 离线 DLNA 设备 / 成员全离线的群组不显示;local(本机)恒显示。
  // 设备重新上线时后端发 peer_available/peer_registered 会把它加回列表。
  function filterVisiblePeers(list: any[]): any[] {
    return (list || []).filter((p) =>
      p.available || (p.kind !== "dlna" && p.kind !== "group"));
  }

  async function refreshPeers(): Promise<void> {
    try {
      const res = await api.get("/rest/api/v1/peers");
      peers.value = filterVisiblePeers(res.data?.peers || []);
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
  // state machine is touched — 本机 keeps playing, every DLNA device and
  // player group keeps playing. The UI computed properties
  // (queue/isPlaying/currentTime/...) automatically re-route to the newly
  // selected peer's state machine.
  async function switchPeer(peerId: string): Promise<void> {
    if (peerId === currentPeerId.value) return;
    if (peerId.startsWith("dlna:") || peerId.startsWith("group:")) {
      // Switching UI to control a remote peer (DLNA device or player group).
      // If we don't yet have a RemoteState for it (e.g. it's a device HA
      // started playing on, or a group that was playing), create one and
      // pull its queue so the UI mirrors what's playing, and start polling
      // it. 本机 Howl and all other peers are NOT touched.
      let st = remoteStates.get(peerId);
      if (!st) {
        let name = peerId.startsWith("group:") ? "播放器群组" : "DLNA 设备";
        try {
          const p = peers.value.find(x => x.peerId === peerId);
          if (p?.name) name = p.name;
        } catch {}
        st = ensureRemoteState(peerId, name);
        await syncCastQueueFromBackend(st);
        const song = st.queue[st.index];
        if (song) loadCastLyrics(st, song.id);
        st.lastScrobbledSongId = song?.id || "";
        startCastPoll(st);
      }
      currentPeerId.value = peerId;
      // If the player we switched to is already playing, mirror the queue panel.
      if (isRemotePeer.value && activeRemote.value?.isPlaying) autoshowQueue();
    } else {
      // Switching UI back to本机. Every remote peer keeps playing on its
      // own. 本机 state is already intact (Howl kept playing if it was
      // playing). Just flip the UI pointer — the computed properties will
      // show本机 state again.
      currentPeerId.value = peerId;
      if (localIsPlaying.value) autoshowQueue();
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
    if (remoteStates.size === 0) currentPeerId.value = localPeerId.value;
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
          peers.value = filterVisiblePeers(msg.peers || []);
          if (!peers.value.find(p => p.peerId === localPeerId.value)) {
            peers.value.unshift({ peerId: localPeerId.value, kind: "local", name: "本机", available: true, lastActiveAt: Date.now() });
          }
          break;
        case "peer_registered":
        case "peer_available": {
          const p = msg.peer;
          if (!p) break;
          const idx = peers.value.findIndex(x => x.peerId === p.peerId);
          if (idx >= 0) peers.value[idx] = { ...peers.value[idx], ...p };
          else if (p.available !== false) peers.value.push(p);
          break;
        }
        case "peer_unavailable": {
          const p = msg.peer;
          if (!p || p.kind === "local") break; // 本机恒在列表
          // 离线设备从列表移除(不再置灰显示)。
          peers.value = peers.value.filter(x => x.peerId !== p.peerId);
          // 当前播放设备离线 → 自动切换到下一个可用设备;无可用则回本机。
          if (currentPeerId.value === p.peerId) {
            const next = peers.value.find(x => x.available && x.peerId !== localPeerId.value);
            if (next) void switchPeer(next.peerId).catch(() => {});
            else currentPeerId.value = localPeerId.value;
          }
          break;
        }
        case "peer_queue_changed": {
          const idx = peers.value.findIndex(x => x.peerId === msg.peer_id);
          if (idx >= 0) peers.value[idx].queue = msg.queue;
          break;
        }
        case "peer_queue_cleared": {
          const idx = peers.value.findIndex(x => x.peerId === msg.peer_id);
          if (idx >= 0) peers.value[idx].queue = { items: [], currentIndex: -1, playMode: "shuffle", isActive: false };
          break;
        }
        case "queue_changed": {
          // DLNA 设备 / 播放器群组的队列变更(src 发裸 device_id=裸 id):
          // 同步播放器切换器列表中的队列显示,无需手动刷新。
          const devId = msg.device_id;
          const idx = peers.value.findIndex(x =>
            (x.peerId === `dlna:${devId}` || x.peerId === `group:${devId}`));
          if (idx >= 0) peers.value[idx].queue = msg.queue;
          break;
        }
        // Group events (播放器群组页 + 播放器切换器):refresh on create/rename/
        // member change,remove on delete. Bumps groupVersion so the Groups page
        // can reload without polling.
        case "group_changed":
        case "group_deleted":
          groupVersion.value++;
          refreshPeers();
          break;
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
    // Stop polling every tracked remote peer.
    remoteStates.forEach(st => stopCastPoll(st));
    disconnectPeerWs();
  }

  // Bumped by the WS handler on group_changed / group_deleted so the
  // 播放器群组 page can reactively reload.
  const groupVersion = ref(0);

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
    // group events (播放器群组页刷新信号)
    groupVersion,
    // UI-routed controls
    playSong, addToQueue, playQueue, togglePlay, next, prev,
    seek, seekPercent, setVolume, cyclePlayMode,
    removeFromQueue, clearQueue, getCoverUrl, loadLyrics, updateCurrentLyric,
    toggleLyrics, togglePlaylistPanel, togglePlayMode,
    // cast lifecycle (投屏)
    startCast, stopCast, restoreCast,
  };
});
