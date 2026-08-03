<template>
  <div class="genres-page">
    <div class="page-header">
      <h2>风格</h2>
      <div class="header-actions" v-if="currentGenre">
        <el-button type="primary" @click="playAll" :disabled="songs.length === 0"><el-icon><VideoPlay /></el-icon>播放全部</el-button>
        <el-button :disabled="selectedSongs.length === 0" @click="showPlaylistDialog = true"><el-icon><Plus /></el-icon>添加到歌单({{ selectedSongs.length }})</el-button>
        <el-button @click="clearGenre"><el-icon><Close /></el-icon>返回</el-button>
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
        highlight-current-row
        v-loading="loading"
        style="width: 100%"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="45" />
        <el-table-column type="index" width="60" label="#" :index="indexMethod" />
        <el-table-column label="" width="60">
          <template #default="{ row }">
            <img v-if="row.coverArt" :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`" class="song-cover" />
            <div v-else class="cover-placeholder"><el-icon><Headset /></el-icon></div>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column prop="artist" label="艺术家" width="180" />
        <el-table-column prop="album" label="专辑" width="200" />
        <el-table-column label="时长" width="100">
          <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-tooltip content="播放" placement="top">
              <el-button :icon="Play" circle size="small" @click="playSong(row)" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination-bar">
        <el-pagination
          layout="total, sizes, prev, pager, next, jumper"
          :total="total"
          :page-size="pageSize"
          :page-sizes="[15, 25, 50, 100]"
          :current-page="currentPage"
          background
          @current-change="onPageChange"
          @size-change="onSizeChange"
        />
      </div>
    </template>

    <!-- Add to playlist dialog -->
    <el-dialog v-model="showPlaylistDialog" title="添加到歌单" width="420px">
      <div class="playlist-dialog-song">将选中的 {{ selectedSongs.length }} 首歌曲添加到：</div>
      <div class="playlist-list" v-loading="playlistsLoading">
        <div v-for="pl in playlists" :key="pl.id" class="playlist-item" :class="{ active: addingPlaylistId === pl.id }" @click="addToPlaylist(pl)">
          <el-icon class="pl-icon"><List /></el-icon>
          <div class="pl-info">
            <div class="pl-name">{{ pl.name }}</div>
            <div class="pl-meta">{{ pl.songCount }}首</div>
          </div>
          <el-icon v-if="addingPlaylistId === pl.id" class="el-icon is-loading"><Loading /></el-icon>
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
import { VideoPlay as Play, Plus, Close, Headset, List, Loading } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const playerStore = usePlayerStore();
const genres = ref<any[]>([]);
const genresLoading = ref(false);
const currentGenre = ref("");
const songs = ref<Song[]>([]);
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

function onPageChange(page: number) { currentPage.value = page; loadSongs(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("genresPageSize", String(size));
  currentPage.value = 1;
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
.genres-page { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } .header-actions { display: flex; gap: 8px; } }
.genre-list { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; min-height: 40px; }
.genre-chip { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 20px; background: #f5f7fa; border: 1px solid #e4e7ed; cursor: pointer; transition: all 0.2s;
  &:hover { background: #eef4ff; border-color: #409eff; }
  &.active { background: #409eff; border-color: #409eff; color: #fff;
    .genre-count { color: rgba(255,255,255,0.8); }
  }
  .genre-name { font-size: 13px; font-weight: 500; }
  .genre-count { font-size: 11px; color: #999; }
}
.genre-empty { width: 100%; text-align: center; color: #999; padding: 30px 0; font-size: 13px; }
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: #e5e7eb; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 18px; }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }
.playlist-dialog-song { font-size: 13px; color: #666; margin-bottom: 12px; }
.playlist-list { max-height: 320px; overflow-y: auto; }
.playlist-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background 0.2s;
  &:hover { background: #f5f7fa; }
  .pl-icon { font-size: 18px; color: #909399; }
  .pl-info { flex: 1; .pl-name { font-size: 14px; font-weight: 500; } .pl-meta { font-size: 12px; color: #999; } }
}
.create-playlist-row { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0f0f0; }
.empty-tip { text-align: center; color: #999; font-size: 13px; padding: 20px 0; }
</style>