import { reactive } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { usePlayContent } from "./usePlayContent";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";
import router from "@/router";
import { Play, Plus, ListMusic, Star, Info, User, Folder, Trash2 } from "lucide-vue-next";
import { gt } from "@/locales";

export interface MenuAction {
  label?: string;
  icon?: any;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  loading?: boolean;
  onClick?: () => void;
}

// ---- shared singletons (module scope, one UI for the whole app) ----
const menu = reactive({
  open: false,
  mode: "desktop" as "desktop" | "mobile",
  x: 0,
  y: 0,
  title: "",
  subtitle: "",
  openedAt: 0,
  actions: [] as MenuAction[],
});

const addDlg = reactive({
  open: false,
  song: null as any,
  /** 待加入歌单的歌曲(支持批量多首;单首时长度为 1) */
  songs: [] as any[],
  playlists: [] as any[],
  loading: false,
  addingId: "",
  newName: "",
});

const infoDlg = reactive({
  open: false,
  song: null as any,
});

// captured in setup
let player: ReturnType<typeof usePlayerStore>;
let fav: ReturnType<typeof useFavoritesStore>;
let play: ReturnType<typeof usePlayContent>;

export function useItemActions() {
  player = usePlayerStore();
  fav = useFavoritesStore();
  play = usePlayContent();
  return {
    menu, addDlg, infoDlg,
    openContextMenu, openActionSheet, closeMenu,
    pressStart, pressMove, pressEnd, menuGuard,
    openAddToPlaylist, addToPlaylist, createAndAdd,
    openSongInfo, closeAddDlg,
    songActions, playlistActions, albumActions, artistActions,
  };
}

/** Desktop: open a dropdown at the pointer. */
function openContextMenu(e: MouseEvent, actions: MenuAction[], title = "", subtitle = "") {
  e.preventDefault();
  e.stopPropagation();
  menu.actions = actions;
  menu.mode = "desktop";
  menu.x = e.clientX;
  menu.y = e.clientY;
  menu.title = title;
  menu.subtitle = subtitle;
  menu.openedAt = Date.now();
  menu.open = true;
}

/** Mobile: open a bottom action sheet. */
function openActionSheet(actions: MenuAction[], title = "", subtitle = "") {
  menu.actions = actions;
  menu.mode = "mobile";
  menu.title = title;
  menu.subtitle = subtitle;
  menu.openedAt = Date.now();
  menu.open = true;
}

function closeMenu() {
  menu.open = false;
}

// ==================== Long-press (mobile) ====================
let lpTimer: any = null;
let lpMoved = false;
let suppressUntil = 0;
const LP_DELAY = 460;

/** Low-level long-press primitives, used by the `v-longpress` directive. */
export function lpBegin(cb: () => void) {
  lpMoved = false;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    if (lpMoved) return;
    suppressUntil = Date.now() + 700;
    cb();
    try { navigator.vibrate?.(12); } catch { /* noop */ }
  }, LP_DELAY);
}
export function lpMove() {
  lpMoved = true;
  clearTimeout(lpTimer);
}
export function lpEnd() {
  clearTimeout(lpTimer);
}
/** True when a click should be swallowed because a long-press just fired. */
export function menuGuard() {
  return Date.now() < suppressUntil;
}

function pressStart(actions: MenuAction[], title = "", subtitle = "") {
  lpBegin(() => openActionSheet(actions, title, subtitle));
}
const pressMove = lpMove;
const pressEnd = lpEnd;

function openSongInfo(song: any) {
  infoDlg.song = song;
  infoDlg.open = true;
}

// ==================== Add to playlist (shared dialog) ====================
async function loadPlaylists() {
  addDlg.loading = true;
  try {
    const res = await api.get("/rest/getPlaylists?f=json");
    addDlg.playlists = res.data?.["subsonic-response"]?.playlists?.playlist || [];
  } catch {
    addDlg.playlists = [];
  } finally {
    addDlg.loading = false;
  }
}
function openAddToPlaylist(song: any) {
  addDlg.songs = Array.isArray(song) ? song : [song];
  addDlg.song = addDlg.songs[0] ?? null;
  addDlg.newName = "";
  addDlg.addingId = "";
  addDlg.open = true;
  loadPlaylists();
}
function closeAddDlg() {
  addDlg.open = false;
}
async function addToPlaylist(pl: any) {
  if (!addDlg.songs.length || addDlg.addingId) return;
  addDlg.addingId = pl.id;
  try {
    await api.post("/rest/updatePlaylist", { playlistId: pl.id, songIdToAdd: addDlg.songs.map((s) => s.id) });
    ElMessage.success(gt("genres.added", { count: addDlg.songs.length, name: pl.name }));
    closeAddDlg();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || gt("genres.addFailed"));
  } finally {
    addDlg.addingId = "";
  }
}
async function createAndAdd() {
  if (!addDlg.newName || !addDlg.songs.length || addDlg.addingId) return;
  addDlg.addingId = "new";
  try {
    await api.post("/rest/createPlaylist", { name: addDlg.newName, songIds: addDlg.songs.map((s) => s.id) });
    ElMessage.success(gt("actions.createdAndAdded", { count: addDlg.songs.length, name: addDlg.newName }));
    closeAddDlg();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || gt("genres.createFailed"));
  } finally {
    addDlg.addingId = "";
  }
}

// ==================== Action builders ====================
function songActions(song: any): MenuAction[] {
  const matched = song.isMatched !== false; // 库内歌曲没有该字段，默认可播放
  const acts: MenuAction[] = [
    {
      label: gt("layout.play"), icon: Play, disabled: !matched, onClick: () => player.playSong(song),
    },
    {
      label: gt("actions.addToQueue"), icon: ListMusic, disabled: !matched, onClick: () => {
        player.addToQueue(song);
        ElMessage.success(gt("actions.addedToQueue"));
      },
    },
    {
      label: gt("layout.addToPlaylist"), icon: Plus, onClick: () => openAddToPlaylist(song),
    },
    { divider: true },
    {
      label: fav.isFavorite(song.id) ? gt("actions.removeFromFav") : gt("actions.addToFav"),
      icon: Star,
      onClick: async () => {
        try {
          const on = await fav.toggleFavorite(song.id);
          ElMessage.success(on ? gt("layout.favAdded") : gt("layout.favRemoved"));
        } catch {
          ElMessage.error(gt("common.operationFailed"));
        }
      },
    },
    {
      label: gt("actions.songInfo"), icon: Info, onClick: () => openSongInfo(song),
    },
  ];
  // 库内 web 歌曲(插件匹配入库)支持从音乐库删除:级联清歌单条目/收藏/历史。
  // 远程搜索结果行(未入库,isWeb 为空)不显示;本地歌曲删除会随媒体源重扫恢复,也不在此入口。
  if (song.isWeb) {
    acts.push({
      label: gt("music.deleteFromLibrary"), icon: Trash2, danger: true,
      onClick: async () => {
        try {
          await ElMessageBox.confirm(
            gt("actions.deleteConfirmBody", { title: song.title }),
            gt("music.deleteFromLibrary"),
            { type: "warning", confirmButtonText: gt("common.delete"), cancelButtonText: gt("common.cancel"), confirmButtonClass: "el-button--danger" },
          );
        } catch { return; }
        try {
          await api.delete(`/rest/api/v1/songs/${song.id}`);
          ElMessage.success(gt("actions.deletedFromLibrary"));
          window.dispatchEvent(new CustomEvent("mf:song-deleted", { detail: { songId: song.id } }));
        } catch (e: any) {
          ElMessage.error(e?.response?.data?.error || gt("common.deleteFailed"));
        }
      },
    });
  }
  if (song.artistId) {
    acts.push({
      label: gt("actions.viewArtist"), icon: User, onClick: () => router.push(`/artists/${song.artistId}`),
    });
  }
  if (song.albumId) {
    acts.push({
      label: gt("actions.viewAlbum"), icon: Folder, onClick: () => router.push(`/albums/${song.albumId}`),
    });
  }
  return acts;
}

function playlistActions(pl: any): MenuAction[] {
  return [
    {
      label: gt("layout.play"), icon: Play, onClick: async () => {
        const n = await play.playPlaylist(pl.id);
        if (n) ElMessage.success(gt("playlists.playing", { name: pl.name }));
        else ElMessage.warning(gt("playlists.noPlayable"));
      },
    },
    {
      label: gt("actions.addToQueue"), icon: ListMusic, onClick: async () => {
        const songs = await play.fetchPlaylistSongs(pl.id);
        songs.forEach((s: any) => player.addToQueue(s));
        if (songs.length) ElMessage.success(gt("actions.addedToQueueCount", { count: songs.length }));
      },
    },
    { divider: true },
    { label: gt("playlists.viewPlaylist"), icon: Folder, onClick: () => router.push(`/playlists/${pl.id}`) },
  ];
}

function albumActions(al: any): MenuAction[] {
  const acts: MenuAction[] = [
    {
      label: gt("layout.play"), icon: Play, onClick: async () => {
        const n = await play.playAlbum(al.id);
        if (n) ElMessage.success(gt("albums.playing", { name: al.name }));
        else ElMessage.warning(gt("albums.noPlayable"));
      },
    },
    {
      label: gt("actions.addToQueue"), icon: ListMusic, onClick: async () => {
        const songs = await play.fetchAlbumSongs(al.id);
        songs.forEach((s: any) => player.addToQueue(s));
        if (songs.length) ElMessage.success(gt("actions.addedToQueueCount", { count: songs.length }));
      },
    },
    { divider: true },
    {
      label: fav.isAlbumFavorite(al.id) ? gt("albums.unfavorite") : gt("albums.favorite"),
      icon: Star,
      onClick: async () => {
        try {
          const on = await fav.toggleAlbumFavorite(al.id);
          ElMessage.success(on ? gt("albums.favorited") : gt("albums.unfavorited"));
        } catch {
          ElMessage.error(gt("common.operationFailed"));
        }
      },
    },
    { label: gt("actions.viewAlbum"), icon: Folder, onClick: () => router.push(`/albums/${al.id}`) },
  ];
  if (al.artistId) {
    acts.push({ label: gt("actions.viewArtist"), icon: User, onClick: () => router.push(`/artists/${al.artistId}`) });
  }
  return acts;
}

function artistActions(ar: any): MenuAction[] {
  return [
    {
      label: gt("artists.playAllSongs"), icon: Play, onClick: async () => {
        const n = await play.playArtist(ar.id);
        if (n) ElMessage.success(gt("playlists.playing", { name: ar.name }));
        else ElMessage.warning(gt("artists.noPlayable"));
      },
    },
    { divider: true },
    {
      label: fav.isArtistFavorite(ar.id) ? gt("artists.unfavorite") : gt("artists.favorite"),
      icon: Star,
      onClick: async () => {
        try {
          const on = await fav.toggleArtistFavorite(ar.id);
          ElMessage.success(on ? gt("artists.favorited") : gt("artists.unfavorited"));
        } catch {
          ElMessage.error(gt("common.operationFailed"));
        }
      },
    },
    { label: gt("actions.viewArtist"), icon: User, onClick: () => router.push(`/artists/${ar.id}`) },
  ];
}
