import { defineStore } from "pinia";
import { ref, computed, reactive } from "vue";
import { Howl } from "howler";
import { ElMessage } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { useIsMobile } from "@/composables/useIsMobile";
import { coverUrl } from "@/utils/cover";
import { waitAsyncTask } from "@/utils/asyncTask";

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
  /** 远程(未入库)歌曲:直接指向后端代理流的相对 URL(如 /rest/stream-remote?...)。
   *  有值时代替 /rest/stream?id= 作为播放源,播放不要求先入库。 */
  streamUrl?: string;
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

// ==================== 远程歌(未入库,带 streamUrl)播放辅助 ====================
// 主项目播放插件搜索结果(远程歌)的两条路:
//   - 本机:Howl 直接播 streamUrl(/rest/stream-remote 代理流),不要求先入库;
//   - DLNA/群组 peer:后端 peer 队列按真实 DB songId 取曲,必须先「导入拿 songId」再入队
//     (与 HA 卡片 _remotePlaySong 同思路),否则 remote:... 伪 id 后端查不到歌曲。
/** 远程(未入库)歌曲:带 streamUrl 即视为远程歌。 */
function isRemoteSong(song: Song): boolean { return !!song.streamUrl; }

/** 从远程歌 streamUrl 解析 provider/source/id(与 useEntitySearch.remoteItemToSong 生成的 URL 对齐)。 */
function remoteParams(song: Song): { provider: string; source: string; id: string } {
  try {
    const u = new URL(song.streamUrl!, window.location.origin);
    return {
      provider: u.searchParams.get("provider") || "",
      source: u.searchParams.get("source") || "",
      id: u.searchParams.get("id") || "",
    };
  } catch {
    return { provider: "", source: "", id: "" };
  }
}

/** 远程歌 → 导入 payload(与搜索 item 同形状;优先原始 item,兜底用 Song 字段)。 */
function remoteSongPayload(song: Song): any {
  const it = (song as any)._item;
  if (it && typeof it === "object" && (it.source || it.id)) return it;
  const p = remoteParams(song);
  return {
    source: p.source, id: p.id,
    name: song.title || "", artist: song.artist || "",
    album: song.album || "", duration: song.duration || 0,
    cover: song.coverArt || "",
  };
}

/** 远程歌拿到真实 DB songId 后构造的可播放 Song(去掉 streamUrl,DLNA peer 可播)。 */
function remoteToDbSong(remote: Song, dbId: string): Song {
  return {
    id: dbId, title: remote.title || "未知", artist: remote.artist || "",
    album: remote.album || "", duration: remote.duration || 0,
    coverArt: remote.coverArt, suffix: "mp3",
  };
}

// DLNA/群组播远程歌:按 provider 分组批量导入,用 fingerprint 精确映射(导入并发执行、
// 失败项被过滤,按序对应会错位)。返回 Map<远程歌 id, DB Song>;无 provider/导入失败的
// 远程歌不进 Map。整批失败抛错由调用方提示。
let castImportRunning = false;
async function importRemoteForCast(songs: Song[]): Promise<Map<string, Song>> {
  const map = new Map<string, Song>();
  const byProvider = new Map<string, Song[]>();
  for (const s of songs) {
    if (!isRemoteSong(s)) continue;
    const { provider } = remoteParams(s);
    if (!provider) continue;
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(s);
  }
  for (const [provider, group] of byProvider) {
    const res = await api
      .post(`/rest/api/v1/song-search/${encodeURIComponent(provider)}/import`, {
        songs: group.map(remoteSongPayload),
      })
      .catch((e: any) => { throw new Error(e?.message || "远程歌曲导入失败"); });
    if (!res.data?.success || !res.data.taskId) throw new Error(res.data?.error || "远程歌曲导入失败");
    const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
    const imported = Array.isArray(r?.imported) ? r.imported : [];
    const ids = Array.isArray(r?.ids) ? r.ids : [];
    for (const s of group) {
      const { source, id } = remoteParams(s);
      const fp = `${provider}:${source}:${id}`;
      let dbId = "";
      const hit = imported.find((x: any) => x.fingerprint === fp);
      if (hit?.id) dbId = hit.id;
      else if (ids.length === 1) dbId = ids[0]; // 单首场景兼容旧后端(无 imported 字段)
      if (dbId) map.set(s.id, remoteToDbSong(s, dbId));
    }
  }
  return map;
}

// Convert a backend QueueItem back to the frontend Song shape for display.
function queueItemToSong(it: any): Song {
  const s: Song = {
    id: it.songId,
    title: it.title || "未知",
    artist: it.artist || "",
    album: it.album || "",
    albumId: it.albumId,
    duration: it.duration || 0,
    coverArt: it.coverArt || (it.albumId ? `al-${it.albumId}` : undefined),
  };
  // 恢复的远程歌(id 为 remote:provider:source:rid)没有 streamUrl(同步到后端时只存了
  // songId),按 id 重新拼出 /rest/stream-remote 代理流,保证恢复队列里的远程歌可播。
  if (typeof it.songId === "string" && it.songId.startsWith("remote:")) {
    const parts = it.songId.split(":");
    const provider = parts[1] || "";
    const source = parts[2] || "";
    const rid = parts.slice(3).join(":");
    if (provider && source && rid) {
      const qs = new URLSearchParams({ provider, source, id: rid });
      if (s.title) qs.set("title", s.title);
      if (s.artist) qs.set("artist", s.artist);
      if (s.album) qs.set("album", s.album);
      if (s.duration) qs.set("duration", String(s.duration));
      if (s.coverArt) qs.set("cover", s.coverArt);
      s.streamUrl = `/rest/stream-remote?${qs.toString()}`;
      s.suffix = "mp3";
    }
  }
  return s;
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
    // Liveness flag for the chained setTimeout poll loop: true while the peer
    // is being tracked, false after stopCastPoll. (pollTimer alone can't tell
    // "never started yet" from "stopped" — both are null — so the first
    // schedulePoll() call must not be mistaken for a stopped loop.)
    polling: boolean;
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
        polling: false,
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
    if (st?.pollTimer) { clearTimeout(st.pollTimer); st.pollTimer = null; }
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

  // 播放源 URL:远程歌(带 streamUrl)直接用它(需补 token),否则走后端 /rest/stream?id=。
  function getStreamUrl(song: Song): string {
    const authStore = useAuthStore();
    const token = authStore.token || "";
    if (song.streamUrl) {
      const sep = song.streamUrl.includes("?") ? "&" : "?";
      return `${song.streamUrl}${sep}token=${encodeURIComponent(token)}`;
    }
    return `/rest/stream?id=${song.id}&token=${encodeURIComponent(token)}`;
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
    if (idx >= 0) {
      // 用传入的最新对象覆盖队列条目:恢复队列里同 id 的远程歌可能缺 streamUrl(后端
      // 只存 songId),点播放时必须以当前对象为准,否则 Howl 无 format 直接播放失败。
      localQueue.value[idx] = song;
      localIndex.value = idx;
    } else {
      localQueue.value.push(song);
      localIndex.value = localQueue.value.length - 1;
    }
    // 随机模式下跳播后重建序列:当前曲固定到新序列头,避免 next/prev 沿用旧
    // shufflePos 错位(旧 pos 指向跳播前位置,切歌会跳到无关的歌)。
    if (localPlayMode.value === "shuffle") rebuildShuffle({ keepCurrent: true });
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
      localIndex.value = Math.floor(Math.random() * songs.length); // 随机起点开播
      rebuildShuffle({ keepCurrent: true });                       // 其后走洗牌序列(当前曲除外)
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

  // 远程歌(/rest/stream-remote 代理流)格式探测:Range 请求拿上游 Content-Type → 真实格式。
  // 不写死 mp3(go-music-dl 等插件可能返回 flac/wav/aac/ogg);结果按 URL 缓存。
  const remoteFmtCache = new Map<string, string>();
  let playbackSeq = 0; // 防 async 探测乱序覆盖更新的播放请求
  async function probeRemoteFormat(url: string): Promise<string> {
    if (remoteFmtCache.has(url)) return remoteFmtCache.get(url)!;
    try {
      const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const map: Record<string, string> = {
        "audio/mpeg": "mp3", "audio/mp3": "mp3",
        "audio/flac": "flac", "audio/x-flac": "flac",
        "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
        "audio/aac": "aac", "audio/aacp": "aac",
        "audio/ogg": "ogg", "audio/opus": "opus", "application/ogg": "ogg",
        "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
        "audio/aiff": "aiff", "audio/x-aiff": "aiff",
        "audio/x-ms-wma": "wma", "audio/ape": "ape",
      };
      const fmt = map[ct] || "";
      remoteFmtCache.set(url, fmt);
      return fmt;
    } catch {
      remoteFmtCache.set(url, "");
      return "";
    }
  }

  async function startLocalPlayback() {
    const mySeq = ++playbackSeq;
    if (howl) { howl.unload(); howl = null; }
    // 预探测确认不可播的外部音源直接跳过(需求:提前跳过,不打断不卡顿)。
    // guard 防死循环:整队都不可播时停止,交给失败连击上限兜底。
    let skipGuard = 0;
    while (localQueue.value[localIndex.value] && deadSongs.has(localQueue.value[localIndex.value].id)) {
      if (++skipGuard > localQueue.value.length) break;
      if (localPlayMode.value === "shuffle") {
        // 沿洗牌序列前进跳过(序列生成时已排除 dead,此处兜底异步新标记的)
        ensureShuffleReady();
        if (shufflePos + 1 >= shuffleOrder.length) {
          rebuildShuffle({ keepCurrent: true });
          if (shuffleOrder.length === 0) break;
          shufflePos = 0;
        } else {
          shufflePos++;
        }
        localIndex.value = shuffleOrder[shufflePos];
      } else {
        localIndex.value = (localIndex.value + 1) % localQueue.value.length;
      }
      console.warn(`[player] 跳过已确认不可播的歌曲: ${localQueue.value[localIndex.value]?.title || localQueue.value[localIndex.value]?.id}`);
    }
    const song = localQueue.value[localIndex.value];
    if (!song) return;
    loadLocalLyrics(song.id);
    let fmt = (song.suffix || "").toLowerCase();
    if (song.streamUrl) {
      // 远程歌:探测真实格式(Range 拿 Content-Type,带缓存;suffix 占位不参与本机格式)。
      // 探测失败兜底 mp3(主流在线源默认);探测期间有更新的播放请求则放弃本次。
      const probed = (await probeRemoteFormat(getStreamUrl(song))) || "mp3";
      if (mySeq !== playbackSeq) return;
      fmt = probed;
    }
    howl = new Howl({
      src: [getStreamUrl(song)],
      format: fmt ? [fmt] : [],
      volume: volume.value,
      html5: true,
      onplay: () => {
        localFailStreak = 0;
        localIsPlaying.value = true;
        localDuration.value = howl?.duration() || 0;
        startLocalProgressTimer();
        // 远程歌(未入库)不 scrobble:后端按 songId 写播放记录,remote: 伪 id 会外键报错。
        if (!song.streamUrl) api.get(`/rest/scrobble?id=${song.id}`).catch(() => {});
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
    // 播放不阻塞:预探测接下来可能播放的外部音源,提前确认可用/换源/跳过。
    probeUpcoming();
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

  // ===== 播放前外部音源预探测(需求:下一首是外部音源前提前确认可用,含随机播放) =====
  // 前端无法预知哪些歌是外部音源(Song 无 url 字段),故对「接下来可能播放的 3 首」
  // 无脑批量探测,后端对本地歌曲直接返回 ok:true(零开销)、对 web 歌曲做轻量
  // Range 探测并自动换源写回;不可用的歌提前跳过(deadSongs),不打断播放。
  const probeCache = new Map<string, boolean>(); // songId -> 可用性(session 内,重启失效)
  const deadSongs = new Set<string>();           // 探测确认不可播 → 播放前直接跳过
  let probing = false;
  const PROBE_WINDOW = 3;

  async function probeUpcoming() {
    if (probing || localQueue.value.length === 0) return;
    const n = localQueue.value.length;
    const cands: string[] = [];
    const unseen = (idx: number): boolean => {
      const s = localQueue.value[idx];
      // 远程歌(带 streamUrl)跳过预探测:后端 probe 按 DB songId 判可用性,远程歌
      // 无 DB 行会被误判不可播;其可用性由播放时的失败兜底(跳过/换源)处理。
      return !!s && !s.streamUrl && !probeCache.has(s.id) && idx !== localIndex.value;
    };
    if (localPlayMode.value === "shuffle") {
      // 随机模式:从洗牌序列取接下来 3 首(精确命中实际播放顺序,不浪费探测)。
      ensureShuffleReady();
      let used = 0;
      for (let i = shufflePos + 1; i < shuffleOrder.length && used < PROBE_WINDOW; i++) {
        const s = localQueue.value[shuffleOrder[i]];
        if (s && !s.streamUrl && !probeCache.has(s.id)) { cands.push(s.id); used++; }
      }
      // 序列剩余不足 3 首:为下一轮洗牌补随机未探测候选(渐进预热)。
      for (let tries = 0; tries < n && used < PROBE_WINDOW; tries++) {
        const idx = Math.floor(Math.random() * n);
        const s = localQueue.value[idx];
        if (s && !s.streamUrl && !probeCache.has(s.id) && !cands.includes(s.id)) { cands.push(s.id); used++; }
      }
    } else {
      for (let i = 1; i <= PROBE_WINDOW; i++) {
        const idx = localIndex.value + i;
        if (idx < n && unseen(idx)) cands.push(localQueue.value[idx].id);
        else if (idx >= n && localPlayMode.value === "all") {
          const wrap = idx % n;
          if (wrap !== localIndex.value && unseen(wrap)) cands.push(localQueue.value[wrap].id);
        }
      }
    }
    if (!cands.length) return;
    probing = true;
    try {
      const res = await api.post("/rest/api/v1/stream/probe", { songIds: cands });
      const results = res.data?.results || [];
      for (const r of results) {
        probeCache.set(r.songId, !!r.ok);
        // 远程歌(remote: 前缀)按 DB songId 探测必判不可播,不可进 deadSongs(否则整队被跳过);
        // 其可用性由播放时失败兜底处理。
        if (String(r.songId).startsWith("remote:")) continue;
        if (!r.ok) {
          deadSongs.add(r.songId);
          console.warn(`[player] 预探测不可播,提前跳过: ${r.songId} (${r.reason || "无可用音源"})`);
        } else {
          deadSongs.delete(r.songId);
        }
      }
    } catch {
      // 探测失败不阻塞播放:交给播放时的失败兜底(换源/跳过)。
    } finally {
      probing = false;
    }
  }

  // ===== 洗牌序(随机播放 = 一轮内不重复的洗牌序列) =====
  // 主流播放器标准随机语义:开始播放时把队列打乱成固定顺序(shuffleOrder,存队列
  // index),「下一首」= 序列中下一首,播完一轮重新洗牌;已知不可播(deadSongs)
  // 的歌不进入序列。相比「每次切歌即时随机」,洗牌序让预探测窗口精确命中真正
  // 要播的歌,且不会「刚播完的又马上回来」。队列增删(长度变化)时惰性重建。
  let shuffleOrder: number[] = [];
  let shufflePos = -1;
  let shuffleLen = -1;

  function rebuildShuffle(opts?: { keepCurrent?: boolean }) {
    const n = localQueue.value.length;
    const idxs: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = localQueue.value[i];
      if (!s) continue;
      if (opts?.keepCurrent && i === localIndex.value) { idxs.unshift(i); continue; } // 当前曲固定序列头
      if (deadSongs.has(s.id)) continue;                          // 已知不可播不进序列
      idxs.push(i);
    }
    // Fisher-Yates(不动头部当前曲)
    for (let i = 1; i < idxs.length; i++) {
      const j = 1 + Math.floor(Math.random() * i);
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    shuffleOrder = idxs;
    // keepCurrent:当前曲在新序列头(pos=0),"上一首"可沿序列回退;
    // 否则下一首从序列头开始。
    shufflePos = opts?.keepCurrent && localIndex.value >= 0 ? 0 : -1;
    shuffleLen = n;
  }

  // 队列增删后序列失效:长度与生成时不符 → 重建(保留当前曲)。
  function ensureShuffleReady() {
    if (shuffleLen !== localQueue.value.length) rebuildShuffle({ keepCurrent: true });
  }

  function localNext() {
    if (localQueue.value.length === 0) return;
    if (localPlayMode.value === "one") { startLocalPlayback(); syncLocalIndex(); return; }
    if (localPlayMode.value === "shuffle") {
      ensureShuffleReady();
      if (shufflePos + 1 >= shuffleOrder.length) {
        // 一轮播完(或序列为空):重新洗牌(当前曲入新序列头),从其后继续
        rebuildShuffle({ keepCurrent: true });
        if (shuffleOrder.length === 0) return;
        shufflePos = 0;
        if (shuffleOrder.length > 1) shufflePos++; // 第 2 位,避开当前曲(不立刻重播)
      } else {
        shufflePos++;
      }
      localIndex.value = shuffleOrder[shufflePos];
      startLocalPlayback();
      syncLocalIndex();
      return;
    }
    if (localIndex.value < localQueue.value.length - 1) localIndex.value++;
    else if (localPlayMode.value === "all") localIndex.value = 0;
    else { localIsPlaying.value = false; syncLocalIndex(); return; }
    startLocalPlayback();
    syncLocalIndex();
  }

  function localPrev() {
    if (localQueue.value.length === 0) return;
    // 上一首始终切歌:不做「进度>3s 先回到当前曲开头」的常规播放器行为——用户
    // 要求点上一首就是跳转,不重播当前曲。
    if (localPlayMode.value === "shuffle") {
      ensureShuffleReady();
      if (shufflePos > 0) {
        shufflePos--;
        localIndex.value = shuffleOrder[shufflePos];
      }
      // 已在序列头部:不绕回,保持当前曲
      startLocalPlayback();
      syncLocalIndex();
      return;
    }
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
    shuffleOrder = []; shufflePos = -1; shuffleLen = -1;
    const pid = localPeerId.value;
    if (pid && useAuthStore().userId) {
      api.delete(`/rest/api/v1/peers/${encodeURIComponent(pid)}/queue`).catch(() => {});
    }
  }

  function localCyclePlayMode() {
    const modes: PlayMode[] = ["order", "one", "all", "shuffle"];
    localPlayMode.value = modes[(modes.indexOf(localPlayMode.value) + 1) % modes.length];
    if (localPlayMode.value === "shuffle") {
      // 进入随机播放:生成洗牌序列(保留当前曲,后续走序列)
      rebuildShuffle({ keepCurrent: true });
    }
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
    // 上一首始终切歌(与 localPrev 一致,不做 3s 重播当前曲)。
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
    // 自适应轮询(P2):链式 setTimeout + 失败退避——后端繁忙(批量导入/匹配)时
    // 接口慢/超时,固定 2s setInterval 会持续叠加请求雪上加霜;改为失败加倍间隔
    // (上限 15s)、成功回落到 2s,兼顾实时性与对后端的友好。
    let pollInterval = 2000;
    // 修复:首调用时 pollTimer 还是 null(刚被 stopCastPoll 清掉),旧守卫
    // `!st.pollTimer` 把「从未启动」误判为「已停止」,导致 DLNA/群组的状态轮询
    // 永不启动——Web 端投屏后进度只能靠 250ms tickTimer 本地模拟,与设备真实
    // 状态脱节(HA 卡片独立拉后端状态,所以正常)。改用独立 polling 标志判活:
    // startCastPoll 置 true,stopCastPoll 置 false。
    st.polling = true;
    const schedulePoll = () => {
      if (!st || !st.polling) return; // 已停止(stopCastPoll 置 polling=false)
      st.pollTimer = setTimeout(async () => {
        try {
          const res = await api.get(peerApi(st.peerId, "/status"), { timeout: 10000 });
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
          pollInterval = 2000; // 成功:回落基准间隔
        } catch {
          // 失败/超时:退避(上限 15s),避免后端繁忙时请求叠加雪上加霜。
          pollInterval = Math.min(pollInterval * 2, 15000);
        } finally {
          schedulePoll();
        }
      }, pollInterval);
    };
    schedulePoll();
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
    st.polling = false;
    if (st.pollTimer) { clearTimeout(st.pollTimer); st.pollTimer = null; }
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
        // 禁用设备不恢复投屏会话(后端已过滤 peer,这里兜底防恢复一个已禁用的设备)。
        if (dev && dev.disabled) continue;
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
    if (isRemotePeer.value && activeRemote.value) {
      if (isRemoteSong(song)) { void playRemoteOnPeer(activeRemote.value, [song], 0); return; }
      castPlaySong(activeRemote.value, song);
    }
    else localPlaySong(song);
  }
  function addToQueue(song: Song) {
    if (isRemotePeer.value && activeRemote.value) {
      if (isRemoteSong(song)) { void addRemoteToPeerQueue(activeRemote.value, song); return; }
      castAddToQueue(activeRemote.value, song);
    }
    else localAddToQueue(song);
  }
  function playQueue(songs: Song[], index: number = 0) {
    if (isRemotePeer.value && activeRemote.value) {
      if (songs.some(isRemoteSong)) { void playRemoteOnPeer(activeRemote.value, songs, index); return; }
      castPlayQueue(activeRemote.value, songs, index);
    }
    else localPlayQueue(songs, index);
  }

  // ==================== 远程歌 → DLNA/群组播放(先导入拿 DB songId) ====================
  // 与 HA 卡片 _remotePlaySong 同思路:后端 peer 队列按真实 songId 取曲,远程歌必须先
  // 导入为可播在线歌曲,拿到 DB songId 后才能入队播放。单首走 castPlaySong(追加播放),
  // 多首走 castPlayQueue(整队播放);导入失败的远程歌跳过并提示。
  async function playRemoteOnPeer(st: RemoteState, songs: Song[], index: number) {
    if (castImportRunning) { ElMessage.warning("正在导入远程歌曲,请稍候"); return; }
    castImportRunning = true;
    try {
      const map = await importRemoteForCast(songs);
      const missing = songs.filter((s) => isRemoteSong(s) && !map.has(s.id));
      if (songs.length === 1) {
        const db = map.get(songs[0].id);
        if (db) castPlaySong(st, db);
        else ElMessage.error("远程歌曲导入失败,无法在所选设备播放");
      } else {
        const resolved = songs.map((s) => (isRemoteSong(s) ? (map.get(s.id) || s) : s));
        castPlayQueue(st, resolved, index);
        if (missing.length) ElMessage.warning(`${missing.length} 首远程歌曲导入失败,已跳过`);
      }
    } catch (e: any) {
      ElMessage.error(e?.message || "远程歌曲导入失败,无法播放");
    } finally {
      castImportRunning = false;
    }
  }

  async function addRemoteToPeerQueue(st: RemoteState, song: Song) {
    if (castImportRunning) { ElMessage.warning("正在导入远程歌曲,请稍候"); return; }
    castImportRunning = true;
    try {
      const map = await importRemoteForCast([song]);
      const db = map.get(song.id);
      if (!db) { ElMessage.error("远程歌曲导入失败,无法加入队列"); return; }
      castAddToQueue(st, db);
    } catch (e: any) {
      ElMessage.error(e?.message || "远程歌曲导入失败,无法加入队列");
    } finally {
      castImportRunning = false;
    }
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
          // 回收离线设备残留的 RemoteState(pollTimer 2s + tickTimer 250ms),
          // 与 castClearQueue/stopCast 同款清理,避免定时器永久空转与状态泄漏。
          // 设备重新上线/再次投屏时 ensureRemoteState 自动重建,无需保留。
          removeRemoteState(p.peerId);
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
