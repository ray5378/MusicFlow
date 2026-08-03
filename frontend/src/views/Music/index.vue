<template>
  <div class="songs-page">
    <div class="page-header">
      <h2>音乐</h2>
      <div class="header-actions">
        <el-input v-model="searchQuery" placeholder="搜索音乐..." prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
        <el-button type="primary" @click="playAll" :disabled="songs.length === 0">播放全部</el-button>
      </div>
    </div>
    <el-table :data="songs" stripe style="width: 100%" @row-dblclick="playSong" highlight-current-row v-loading="loading">
      <el-table-column type="index" width="60" label="#" :index="indexMethod" />
      <el-table-column label="" width="60">
        <template #default="{ row }">
          <el-image
            v-if="row.coverArt"
            :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`"
            class="song-cover"
            fit="cover"
            lazy
          >
            <template #error>
              <div class="cover-placeholder"><el-icon><Headset /></el-icon></div>
            </template>
          </el-image>
          <div v-else class="cover-placeholder"><el-icon><Headset /></el-icon></div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="200">
        <template #default="{ row }">
          <div class="song-title-cell">
            <span>{{ row.title }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="artist" label="艺术家" width="180" />
      <el-table-column prop="album" label="专辑" width="200" />
      <el-table-column label="时长" width="100">
        <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
      </el-table-column>
      <el-table-column label="码率" width="100">
        <template #default="{ row }">{{ row.bitRate ? `${row.bitRate}kbps` : '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button-group>
            <el-tooltip content="播放" placement="top">
              <el-button :icon="Play" circle size="small" @click="playSong(row)" />
            </el-tooltip>
            <el-tooltip :content="favoritesStore.isFavorite(row.id) ? '取消喜欢' : '我喜欢的音乐'" placement="top">
              <el-button
                circle
                size="small"
                class="fav-btn"
                @click="toggleFavorite(row)"
              >
                <HeartIcon :filled="favoritesStore.isFavorite(row.id)" :size="16" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="添加到歌单" placement="top">
              <el-button :icon="Plus" circle size="small" @click="openAddToPlaylist(row)" />
            </el-tooltip>
          </el-button-group>
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

    <!-- Add to playlist dialog -->
    <el-dialog v-model="showPlaylistDialog" title="添加到歌单" width="420px">
      <div class="playlist-dialog-song" v-if="playlistTargetSong">
        将「{{ playlistTargetSong.title }} - {{ playlistTargetSong.artist }}」添加到：
      </div>
      <div class="playlist-list" v-loading="playlistsLoading">
        <div
          v-for="pl in playlists"
          :key="pl.id"
          class="playlist-item"
          :class="{ active: addingPlaylistId === pl.id }"
          @click="addToPlaylist(pl)"
        >
          <el-icon class="pl-icon"><List /></el-icon>
          <div class="pl-info">
            <div class="pl-name">{{ pl.name }}</div>
            <div class="pl-meta">{{ pl.songCount }}首</div>
          </div>
          <el-icon v-if="addingPlaylistId === pl.id" class="el-icon is-loading"><Loading /></el-icon>
        </div>
        <div v-if="playlists.length === 0 && !playlistsLoading" class="empty-tip">暂无歌单，先创建一个吧</div>
      </div>
      <div class="create-playlist-row">
        <el-input v-model="newPlaylistName" placeholder="新建歌单名称..." clearable @keyup.enter="createAndAdd" />
        <el-button type="primary" @click="createAndAdd" :disabled="!newPlaylistName">新建并添加</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { usePlayerStore, Song } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { VideoPlay as Play, Plus, Headset, List, Loading } from "@element-plus/icons-vue";
import HeartIcon from "@/components/HeartIcon.vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const playerStore = usePlayerStore();
const favoritesStore = useFavoritesStore();
const songs = ref<Song[]>([]);
const loading = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("songsPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;

// Playlist dialog state
const showPlaylistDialog = ref(false);
const playlistTargetSong = ref<Song | null>(null);
const playlists = ref<any[]>([]);
const playlistsLoading = ref(false);
const addingPlaylistId = ref("");
const newPlaylistName = ref("");

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function indexMethod(index: number) { return (currentPage.value - 1) * pageSize.value + index + 1; }

function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }

async function loadSongs() {
  loading.value = true;
  try {
    const res = await api.get(`/rest/api/v1/songs`, {
      params: { page: currentPage.value, pageSize: pageSize.value, query: searchQuery.value },
    });
    songs.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch { songs.value = []; total.value = 0; }
  finally { loading.value = false; }
}

function onPageChange(page: number) { currentPage.value = page; loadSongs(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("songsPageSize", String(size));
  currentPage.value = 1;
  loadSongs();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadSongs(); }, 300);
}

function onSearchClear() { currentPage.value = 1; loadSongs(); }

function playSong(song: Song) { playerStore.playSong(song); }
function playAll() { if (songs.value.length > 0) playerStore.playQueue(songs.value); }
async function toggleFavorite(song: Song) {
  try {
    const fav = await favoritesStore.toggleFavorite(song.id);
    ElMessage.success(fav ? "已添加到我喜欢的音乐" : "已从我喜欢的音乐移除");
  } catch (e: any) { ElMessage.error(e.message || "操作失败"); }
}

async function openAddToPlaylist(song: Song) {
  playlistTargetSong.value = song;
  showPlaylistDialog.value = true;
  newPlaylistName.value = "";
  await loadPlaylists();
}

async function loadPlaylists() {
  playlistsLoading.value = true;
  try {
    const res = await api.get("/rest/getPlaylists?f=json");
    playlists.value = res.data["subsonic-response"]?.playlists?.playlist || [];
  } catch { playlists.value = []; }
  finally { playlistsLoading.value = false; }
}

async function addToPlaylist(pl: any) {
  if (!playlistTargetSong.value || addingPlaylistId.value) return;
  addingPlaylistId.value = pl.id;
  try {
    await api.post("/rest/updatePlaylist", { playlistId: pl.id, songIdToAdd: playlistTargetSong.value.id });
    ElMessage.success(`已添加到「${pl.name}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "添加失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

async function createAndAdd() {
  if (!newPlaylistName.value || !playlistTargetSong.value) return;
  if (addingPlaylistId.value) return;
  addingPlaylistId.value = "new";
  try {
    const res = await api.post("/rest/createPlaylist", { name: newPlaylistName.value, songId: playlistTargetSong.value.id });
    ElMessage.success(`已创建并添加「${newPlaylistName.value}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "创建失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

onMounted(() => { loadSongs(); favoritesStore.loadFavorites(); });
</script>

<style lang="scss" scoped>
.songs-page { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;
  h2 { font-size: 24px; font-weight: 600; }
  .header-actions { display: flex; gap: 12px; align-items: center; }
}
.song-cover { width: 40px; height: 40px; border-radius: 4px; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: #e5e7eb; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 18px; }
.song-title-cell { font-weight: 500; }
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