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
  // When castDeviceId is set, all transport controls (play/pause/next/prev/
  // seek/volume) are proxied to the DLNA renderer via HTTP instead of driving
  // the local Howl. The local player is paused so only the device produces
  // sound. A poller syncs progress from the device and auto-advances the queue
  // when the device finishes a track.
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
  }

  function playQueue(songs: Song[], index: number = 0) {
    // Keep the queue in its original order — shuffle is handled per-skip in
    // next()/prev() via randomIndex(), not by reordering the array. This keeps
    // the queue panel display stable and currentIndex pointing at the right song.
    queue.value = [...songs];
    currentIndex.value = index;
    startPlayback();
  }

  function startPlayback() {
    // In cast mode, "play this song" means push it to the DLNA device — the
    // local Howl stays paused. This keeps every entry point (playSong,
    // playQueue, queue click, prev/next) working without cast-specific forks.
    if (castActive.value) { castCurrent(); return; }
    if (howl) { howl.unload(); howl = null; }
    const song = currentSong.value;
    if (!song) return;
    loadLyrics(song.id);
    howl = new Howl({
      src: [getStreamUrl(song.id)],
      volume: volume.value,
      html5: true,
      onplay: () => { isPlaying.value = true; duration.value = howl?.duration() || 0; startProgressTimer(); api.get(`/rest/scrobble?id=${song.id}&submission=false`).catch(() => {}); },
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
    if (playMode.value === "one") { startPlayback(); return; }
    if (playMode.value === "shuffle") { currentIndex.value = randomIndex(); startPlayback(); return; }
    if (currentIndex.value < queue.value.length - 1) currentIndex.value++;
    else if (playMode.value === "all") currentIndex.value = 0;
    else {
      // Reached the end in "order" mode — stop. In cast mode, also stop the
      // device so it doesn't keep idle-playing the last track.
      if (castActive.value) { stopCast(); return; }
      isPlaying.value = false; return;
    }
    startPlayback();
  }

  function prev() {
    if (queue.value.length === 0) return;
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
  }
  function toggleLyrics() { showLyrics.value = !showLyrics.value; }
  function togglePlaylistPanel() { showPlaylist.value = !showPlaylist.value; }
  function togglePlayMode() { playModeVisible.value = !playModeVisible.value; }
  function removeFromQueue(index: number) { queue.value.splice(index, 1); if (index < currentIndex.value) currentIndex.value--; else if (index === currentIndex.value) startPlayback(); }
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  function startProgressTimer() { stopProgressTimer(); progressTimer = setInterval(() => { if (howl && isPlaying.value) { currentTime.value = howl.seek() as number || 0; updateCurrentLyric(); } }, 250); }
  function stopProgressTimer() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

  // ==================== DLNA cast control ====================

  // Track whether the device supports gapless enqueue (SetNextAVTransportURI).
  // Probed lazily on the first enqueue attempt; when false we fall back to
  // poll-and-recast (still seamless enough for most use cases).
  let enqueueSupported: boolean | null = null;

  // Best-effort preload of the next queue item onto the device so it can
  // switch tracks gaplessly. Called after each cast and after every track
  // change detected by the poller. Silently no-ops if the device doesn't
  // support SetNextAVTransportURI (probe result is cached).
  async function enqueueNext() {
    if (!castDeviceId.value) return;
    const nextSong = queue.value[currentIndex.value + 1];
    if (!nextSong) return; // last track in queue, nothing to preload
    try {
      const res = await api.post("/rest/api/v1/dlna/enqueue", { songId: nextSong.id, deviceId: castDeviceId.value });
      enqueueSupported = res.data?.enqueueSupported ?? false;
    } catch {
      enqueueSupported = false;
    }
  }

  // Push the current song to the active DLNA device and report scrobble.
  async function castCurrent() {
    const song = currentSong.value;
    if (!song || !castDeviceId.value) return;
    try {
      await api.post("/rest/api/v1/dlna/cast", { songId: song.id, deviceId: castDeviceId.value });
      isPlaying.value = true;
      currentTime.value = 0;
      duration.value = song.duration || 0;
      lastCastState = "PLAYING";
      loadLyrics(song.id);
      api.get(`/rest/scrobble?id=${song.id}&submission=false`).catch(() => {});
      // Preload the next track for gapless playback (no-op if unsupported).
      enqueueNext();
    } catch { isPlaying.value = false; }
  }

  // Enter cast mode: pause local playback, switch all controls to the device.
  async function startCast(deviceId: string, deviceName: string) {
    if (howl) { howl.pause(); }
    stopProgressTimer();
    castDeviceId.value = deviceId;
    castDeviceName.value = deviceName;
    enqueueSupported = null; // re-probe for the new device
    await castCurrent();
    startCastPoll();
  }

  // Exit cast mode: stop the device, resume local control (does not auto-play).
  async function stopCast() {
    if (castDeviceId.value) {
      try { await api.post(`/rest/api/v1/dlna/devices/${castDeviceId.value}/stop`); } catch {}
    }
    castDeviceId.value = "";
    castDeviceName.value = "";
    stopCastPoll();
    isPlaying.value = false;
    currentTime.value = 0;
    lastCastState = "STOPPED";
    enqueueSupported = null;
  }

  // Poll the device for progress + state. When the device transitions from
  // PLAYING to STOPPED on its own, the track ended — advance the queue and
  // cast the next song automatically (the whole point of casting a playlist).
  // After advancing, also try to preload the *next* next track for gapless.
  function startCastPoll() {
    stopCastPoll();
    castPollTimer = setInterval(async () => {
      if (!castDeviceId.value) { stopCastPoll(); return; }
      try {
        const res = await api.get(`/rest/api/v1/dlna/devices/${castDeviceId.value}/status`);
        const st = res.data || {};
        const prevState = lastCastState;
        lastCastState = st.state || "STOPPED";
        if (typeof st.position === "number") currentTime.value = st.position;
        if (typeof st.duration === "number" && st.duration > 0) duration.value = st.duration;
        isPlaying.value = st.state === "PLAYING";
        updateCurrentLyric();
        // Track finished on the device → auto-advance the queue, then preload
        // the next track again for continued gapless playback.
        if (prevState === "PLAYING" && st.state === "STOPPED") {
          next();
          enqueueNext();
        }
      } catch {}
    }, 2000);
  }
  function stopCastPoll() { if (castPollTimer) { clearInterval(castPollTimer); castPollTimer = null; } }

  function clearQueue() {
    if (howl) { howl.unload(); howl = null; }
    stopProgressTimer();
    if (castDeviceId.value) { stopCast(); }
    queue.value = []; currentIndex.value = -1; isPlaying.value = false; currentTime.value = 0; duration.value = 0; lyrics.value = []; currentLyricLine.value = ""; currentLyricIndex.value = -1; showPlaylist.value = false; playModeVisible.value = false;
  }

  return {
    queue, currentIndex, isPlaying, volume, playMode, currentTime, duration, showLyrics, showPlaylist,
    playModeVisible, lyrics, currentLyricLine, currentLyricIndex,
    currentSong, progress, castActive, castDeviceName,
    playSong, addToQueue, playQueue, togglePlay, next, prev, seek, seekPercent, setVolume, cyclePlayMode, toggleLyrics, togglePlaylistPanel, togglePlayMode,
    removeFromQueue, clearQueue, getCoverUrl, loadLyrics, updateCurrentLyric,
    startCast, stopCast,
  };
});
