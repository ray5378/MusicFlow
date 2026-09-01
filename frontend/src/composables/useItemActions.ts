import { reactive } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { usePlayContent } from "./usePlayContent";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";
import router from "@/router";
import { Play, Plus, ListMusic, Star, Info, User, Folder, Trash2 } from "lucide-vue-next";

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
  addDlg.song = song;
  addDlg.newName = "";
  addDlg.addingId = "";
  addDlg.open = true;
  loadPlaylists();
}
function closeAddDlg() {
  addDlg.open = false;
}
async function addToPlaylist(pl: any) {
  if (!addDlg.song || addDlg.addingId) return;
  addDlg.addingId = pl.id;
  try {
    await api.post("/rest/updatePlaylist", { playlistId: pl.id, songIdToAdd: addDlg.song.id });
    ElMessage.success(`已添加到「${pl.name}」`);
    closeAddDlg();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "添加失败");
  } finally {
    addDlg.addingId = "";
  }
}
async function createAndAdd() {
  if (!addDlg.newName || !addDlg.song || addDlg.addingId) return;
  addDlg.addingId = "new";
  try {
    await api.post("/rest/createPlaylist", { name: addDlg.newName, songId: addDlg.song.id });
    ElMessage.success(`已创建并添加「${addDlg.newName}」`);
    closeAddDlg();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "创建失败");
  } finally {
    addDlg.addingId = "";
  }
}

// ==================== Action builders ====================
function songActions(song: any): MenuAction[] {
  const matched = song.isMatched !== false; // 库内歌曲没有该字段，默认可播放
  const acts: MenuAction[] = [
    {
      label: "播放", icon: Play, disabled: !matched, onClick: () => player.playSong(song),
    },
    {
      label: "添加到播放队列", icon: ListMusic, disabled: !matched, onClick: () => {
        player.addToQueue(song);
        ElMessage.success("已加入播放队列");
      },
    },
    {
      label: "添加到歌单", icon: Plus, onClick: () => openAddToPlaylist(song),
    },
    { divider: true },
    {
      label: fav.isFavorite(song.id) ? "从我喜欢的音乐移除" : "添加到我喜欢的音乐",
      icon: Star,
      onClick: async () => {
        try {
          const on = await fav.toggleFavorite(song.id);
          ElMessage.success(on ? "已添加到我喜欢的音乐" : "已从我喜欢的音乐移除");
        } catch {
          ElMessage.error("操作失败");
        }
      },
    },
    {
      label: "歌曲信息", icon: Info, onClick: () => openSongInfo(song),
    },
  ];
  // 库内 web 歌曲(插件匹配入库)支持从音乐库删除:级联清歌单条目/收藏/历史。
  // 远程搜索结果行(未入库,isWeb 为空)不显示;本地歌曲删除会随媒体源重扫恢复,也不在此入口。
  if (song.isWeb) {
    acts.push({
      label: "从音乐库删除", icon: Trash2, danger: true,
      onClick: async () => {
        try {
          await ElMessageBox.confirm(
            `确定从音乐库删除「${song.title}」？\n该歌曲来自插件匹配,删除后需重新搜索匹配才会恢复。`,
            "从音乐库删除",
            { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消", confirmButtonClass: "el-button--danger" },
          );
        } catch { return; }
        try {
          await api.delete(`/rest/api/v1/songs/${song.id}`);
          ElMessage.success("已从音乐库删除");
          window.dispatchEvent(new CustomEvent("mf:song-deleted", { detail: { songId: song.id } }));
        } catch (e: any) {
          ElMessage.error(e?.response?.data?.error || "删除失败");
        }
      },
    });
  }
  if (song.artistId) {
    acts.push({
      label: "查看艺人", icon: User, onClick: () => router.push(`/artists/${song.artistId}`),
    });
  }
  if (song.albumId) {
    acts.push({
      label: "查看专辑", icon: Folder, onClick: () => router.push(`/albums/${song.albumId}`),
    });
  }
  return acts;
}

function playlistActions(pl: any): MenuAction[] {
  return [
    {
      label: "播放", icon: Play, onClick: async () => {
        const n = await play.playPlaylist(pl.id);
        if (n) ElMessage.success(`正在播放「${pl.name}」`);
        else ElMessage.warning("该歌单暂无可播放歌曲");
      },
    },
    {
      label: "添加到播放队列", icon: ListMusic, onClick: async () => {
        const songs = await play.fetchPlaylistSongs(pl.id);
        songs.forEach((s: any) => player.addToQueue(s));
        if (songs.length) ElMessage.success(`已加入队列（${songs.length} 首）`);
      },
    },
    { divider: true },
    { label: "查看歌单", icon: Folder, onClick: () => router.push(`/playlists/${pl.id}`) },
  ];
}

function albumActions(al: any): MenuAction[] {
  const acts: MenuAction[] = [
    {
      label: "播放", icon: Play, onClick: async () => {
        const n = await play.playAlbum(al.id);
        if (n) ElMessage.success(`正在播放「${al.name}」`);
        else ElMessage.warning("该专辑暂无可播放歌曲");
      },
    },
    {
      label: "添加到播放队列", icon: ListMusic, onClick: async () => {
        const songs = await play.fetchAlbumSongs(al.id);
        songs.forEach((s: any) => player.addToQueue(s));
        if (songs.length) ElMessage.success(`已加入队列（${songs.length} 首）`);
      },
    },
    { divider: true },
    {
      label: fav.isAlbumFavorite(al.id) ? "取消收藏专辑" : "收藏专辑",
      icon: Star,
      onClick: async () => {
        try {
          const on = await fav.toggleAlbumFavorite(al.id);
          ElMessage.success(on ? "已收藏专辑" : "已取消收藏专辑");
        } catch {
          ElMessage.error("操作失败");
        }
      },
    },
    { label: "查看专辑", icon: Folder, onClick: () => router.push(`/albums/${al.id}`) },
  ];
  if (al.artistId) {
    acts.push({ label: "查看艺人", icon: User, onClick: () => router.push(`/artists/${al.artistId}`) });
  }
  return acts;
}

function artistActions(ar: any): MenuAction[] {
  return [
    {
      label: "播放全部歌曲", icon: Play, onClick: async () => {
        const n = await play.playArtist(ar.id);
        if (n) ElMessage.success(`正在播放「${ar.name}」`);
        else ElMessage.warning("该艺人暂无可播放歌曲");
      },
    },
    { divider: true },
    {
      label: fav.isArtistFavorite(ar.id) ? "取消收藏艺人" : "收藏艺人",
      icon: Star,
      onClick: async () => {
        try {
          const on = await fav.toggleArtistFavorite(ar.id);
          ElMessage.success(on ? "已收藏艺人" : "已取消收藏艺人");
        } catch {
          ElMessage.error("操作失败");
        }
      },
    },
    { label: "查看艺人", icon: User, onClick: () => router.push(`/artists/${ar.id}`) },
  ];
}
