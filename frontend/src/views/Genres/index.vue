<template>
  <div class="genres-page">
    <div class="page-header">
      <h2>风格</h2>
      <div class="header-actions" v-if="currentGenre">
        <el-button type="primary" @click="playAll" :disabled="songs.length === 0"><MfIcon name="Play" />播放全部</el-button>
        <el-button :disabled="selectedSongs.length === 0" @click="showPlaylistDialog = true"><MfIcon name="Plus" />添加到歌单({{ selectedSongs.length }})</el-button>
        <el-button @click="clearGenre"><MfIcon name="X" />返回</el-button>
      </div>
    </div>

    <!-- Genre filter chips -->
    <div class="genre-list" v-loading="genresLoading">
      <div
        class="genre-chip"
        :class="{ active: currentGenre === g.name }"
        v-for="g in genres"
        :key="g.name"
        @click="selectGenre(g.name)"
      >
        <span class="genre-name">{{ g.name }}</span>
        <span class="genre-count">{{ g.songCount }}首</span>
      </div>
      <div v-if="genres.length === 0 && !genresLoading" class="genre-empty">暂无风格标签(刮削歌曲时会根据标签自动分类)</div>
    </div>

    <!-- Songs of selected genre -->
    <template v-if="currentGenre">
      <el-table
        :data="songs"
        stripe
        @row-dblclick="playSong"
        @row-contextmenu="onRowContextMenu"
        v-longpress="onTableLongPress"
        highlight-current-row
        v-loading="loading"
        style="width: 100%"
        @selection-change="onSelectionChange"
      >
        <el-table-column v-if="!isMobile" type="selection" width="45" />
        <el-table-column v-if="!isMobile" type="index" width="60" label="#" :index="indexMethod" />
        <el-table-column label="" :width="isMobile ? 52 : 60">
          <template #default="{ row }">
            <img v-if="row.coverArt" :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`" class="song-cover" />
            <div v-else class="cover-placeholder"><MfIcon name="Headphones" /></div>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="160">
          <template v-if="isMobile" #default="{ row }">
            <div class="m-title">{{ row.title }}</div>
            <div class="m-sub">{{ [row.artist, row.album].filter(Boolean).join(' · ') || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column v-if="!isMobile" prop="artist" label="艺术家" width="180" />
        <el-table-column v-if="!isMobile" prop="album" label="专辑" width="200" />
        <el-table-column label="时长" :width="isMobile ? 58 : 100">
          <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
        </el-table-column>
        <el-table-column v-if="!isMobile" label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-tooltip content="播放" placement="top">
              <el-button circle size="small" @click="playSong(row)"><MfIcon name="Play" /></el-button>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination-bar">
        <PagePagination :total="total" :page="currentPage" :page-size="pageSize" storage-key="genresPageSize" @change="onPageChange" />
      </div>
    </template>

    <!-- Add to playlist dialog -->
    <el-dialog v-model="showPlaylistDialog" title="添加到歌单" width="420px">
      <div class="playlist-dialog-song">将选中的 {{ selectedSongs.length }} 首歌曲添加到：</div>
      <div class="playlist-list" v-loading="playlistsLoading">
        <div v-for="pl in playlists" :key="pl.id" class="playlist-item" :class="{ active: addingPlaylistId === pl.id }" @click="addToPlaylist(pl)">
          <MfIcon name="List" class="pl-icon"  />
          <div class="pl-info">
            <div class="pl-name">{{ pl.name }}</div>
            <div class="pl-meta">{{ pl.songCount }}首</div>
          </div>
          <MfIcon name="Loader2" v-if="addingPlaylistId === pl.id" class="is-loading"  spin />
        </div>
        <div v-if="playlists.length === 0 && !playlistsLoading" class="empty-tip">暂无歌单,先创建一个吧</div>
      </div>
      <div class="create-playlist-row">
        <el-input v-model="newPlaylistName" placeholder="新建歌单名称..." clearable @keyup.enter="createAndAdd" />
        <el-button type="primary" @click="createAndAdd" :disabled="!newPlaylistName">新建并添加</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { usePlayerStore, Song } from "@/stores/player";
import { ElMessage } from "element-plus";
import api from "@/api";
import PagePagination from "@/components/PagePagination.vue";
import { useSongTableMenu } from "@/composables/useSongTableMenu";
import { useIsMobile } from "@/composables/useIsMobile";

const playerStore = usePlayerStore();
const genres = ref<any[]>([]);
const genresLoading = ref(false);
const currentGenre = ref("");
const songs = ref<Song[]>([]);
const isMobile = useIsMobile();
const { onRowContextMenu, onTableLongPress } = useSongTableMenu(songs);
const loading = ref(false);
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("genresPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;

// Batch add to playlist
const showPlaylistDialog = ref(false);
const selectedSongs = ref<Song[]>([]);
const playlists = ref<any[]>([]);
const playlistsLoading = ref(false);
const addingPlaylistId = ref("");
const newPlaylistName = ref("");

function indexMethod(index: number) { return (currentPage.value - 1) * pageSize.value + index + 1; }
function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
function playSong(song: Song) { playerStore.playSong(song); }
function playAll() { if (songs.value.length > 0) playerStore.playQueue(songs.value); }
function onSelectionChange(rows: Song[]) { selectedSongs.value = rows; }

async function loadGenres() {
  genresLoading.value = true;
  try {
    const res = await api.get("/rest/api/v1/genres");
    genres.value = res.data.items || [];
  } catch { genres.value = []; }
  finally { genresLoading.value = false; }
}

function selectGenre(name: string) {
  currentGenre.value = name;
  currentPage.value = 1;
  loadSongs();
}

function clearGenre() {
  currentGenre.value = "";
  songs.value = [];
  total.value = 0;
}

async function loadSongs() {
  if (!currentGenre.value) return;
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/songs", {
      params: { page: currentPage.value, pageSize: pageSize.value, genre: currentGenre.value },
    });
    songs.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch { songs.value = []; total.value = 0; }
  finally { loading.value = false; }
}

function onPageChange(page: number, size?: number) {
  currentPage.value = page;
  if (size) pageSize.value = size;
  loadSongs();
}

async function openAddToPlaylist() {
  showPlaylistDialog.value = true;
  newPlaylistName.value = "";
  playlistsLoading.value = true;
  try {
    const res = await api.get("/rest/getPlaylists?f=json");
    playlists.value = res.data["subsonic-response"]?.playlists?.playlist || [];
  } catch { playlists.value = []; }
  finally { playlistsLoading.value = false; }
}

async function addToPlaylist(pl: any) {
  if (selectedSongs.value.length === 0 || addingPlaylistId.value) return;
  addingPlaylistId.value = pl.id;
  try {
    for (const s of selectedSongs.value) {
      await api.post("/rest/updatePlaylist", { playlistId: pl.id, songIdToAdd: s.id });
    }
    ElMessage.success(`已添加 ${selectedSongs.value.length} 首到「${pl.name}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "添加失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

async function createAndAdd() {
  if (!newPlaylistName.value || selectedSongs.value.length === 0) return;
  if (addingPlaylistId.value) return;
  addingPlaylistId.value = "new";
  try {
    const res = await api.post("/rest/createPlaylist", { name: newPlaylistName.value });
    const plId = res.data["subsonic-response"]?.playlist?.id;
    if (plId) {
      for (const s of selectedSongs.value) {
        await api.post("/rest/updatePlaylist", { playlistId: plId, songIdToAdd: s.id });
      }
    }
    ElMessage.success(`已创建并添加 ${selectedSongs.value.length} 首`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "创建失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

onMounted(loadGenres);
</script>

<style lang="scss" scoped>
.genres-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; } .header-actions { display: flex; gap: 8px; flex-wrap: wrap; } }
.genre-list { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; min-height: 40px; }
.genre-chip { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 20px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; transition: all 0.2s;
  &:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.18); }
  &:active { transform: scale(0.96); }
  &.active { background: var(--fnos-red); border-color: var(--fnos-red); color: #fff; box-shadow: 0 4px 14px rgba(246,44,85,0.35);
    .genre-count { color: rgba(255,255,255,0.8); }
  }
  .genre-name { font-size: 13px; font-weight: 500; color: var(--fnos-text-primary); }
  .genre-count { font-size: 11px; color: var(--fnos-text-tertiary); }
}
.genre-empty { width: 100%; text-align: center; color: var(--fnos-text-muted); padding: 30px 0; font-size: 13px; }
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); font-size: 18px; }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }
.playlist-dialog-song { font-size: 13px; color: var(--fnos-text-secondary); margin-bottom: 12px; }
.playlist-list { max-height: 320px; overflow-y: auto; }
.playlist-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background 0.2s;
  &:hover { background: rgba(255,255,255,0.06); }
  &.active { background: var(--fnos-red-soft); }
  .pl-icon { font-size: 18px; color: var(--fnos-text-tertiary); }
  .pl-info { flex: 1; .pl-name { font-size: 14px; font-weight: 500; color: var(--fnos-text-primary); } .pl-meta { font-size: 12px; color: var(--fnos-text-tertiary); } }
}
.create-playlist-row { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08); }
.empty-tip { text-align: center; color: var(--fnos-text-muted); font-size: 13px; padding: 20px 0; }

@media (max-width: 768px) {
  .genres-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
  .header-actions { width: 100%; }
  .header-actions .el-button { flex: 1; }
}
</style>