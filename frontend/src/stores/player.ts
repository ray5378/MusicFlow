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
    if (playMode.value === "shuffle") {
      const shuffled = [...songs];
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      queue.value = shuffled;
    } else { queue.value = [...songs]; }
    currentIndex.value = index;
    startPlayback();
  }

  function startPlayback() {
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

  function togglePlay() { if (!howl) return; if (isPlaying.value) howl.pause(); else howl.play(); }

  function next() {
    if (queue.value.length === 0) return;
    if (playMode.value === "one") { startPlayback(); return; }
    if (currentIndex.value < queue.value.length - 1) currentIndex.value++;
    else if (playMode.value === "all" || playMode.value === "shuffle") currentIndex.value = 0;
    else { isPlaying.value = false; return; }
    startPlayback();
  }

  function prev() {
    if (queue.value.length === 0) return;
    if (currentTime.value > 3) { seek(0); return; }
    if (currentIndex.value > 0) currentIndex.value--;
    else if (playMode.value === "all" || playMode.value === "shuffle") currentIndex.value = queue.value.length - 1;
    startPlayback();
  }

  function seek(time: number) { if (howl) { howl.seek(time); currentTime.value = time; } }
  function seekPercent(percent: number) { if (howl && duration.value > 0) seek((percent / 100) * duration.value); }
  function setVolume(v: number) { volume.value = v; localStorage.setItem("volume", String(v)); if (howl) howl.volume(v); }
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

  function clearQueue() { if (howl) { howl.unload(); howl = null; } stopProgressTimer(); queue.value = []; currentIndex.value = -1; isPlaying.value = false; currentTime.value = 0; duration.value = 0; lyrics.value = []; currentLyricLine.value = ""; currentLyricIndex.value = -1; showPlaylist.value = false; playModeVisible.value = false; }

  return {
    queue, currentIndex, isPlaying, volume, playMode, currentTime, duration, showLyrics, showPlaylist,
    playModeVisible, lyrics, currentLyricLine, currentLyricIndex,
    currentSong, progress,
    playSong, addToQueue, playQueue, togglePlay, next, prev, seek, seekPercent, setVolume, cyclePlayMode, toggleLyrics, togglePlaylistPanel, togglePlayMode,
    removeFromQueue, clearQueue, getCoverUrl, loadLyrics, updateCurrentLyric,
  };
});
