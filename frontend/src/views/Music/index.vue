<template>
  <div class="songs-page">
    <!-- ===== 页头 ===== -->
    <div class="page-header">
      <div class="page-title">
        <h2>音乐</h2>
        <span class="song-count">{{ total }} 首</span>
      </div>
      <div class="header-actions">
        <el-input
          v-model="searchQuery"
          placeholder="搜索音乐..."
          prefix-icon="Search"
          clearable
          class="search-input"
          @input="onSearchInput"
          @clear="onSearchClear"
        />
        <el-button type="primary" :icon="VideoPlay" class="play-all-btn" @click="playAll" :disabled="songs.length === 0">
          播放全部
        </el-button>
      </div>
    </div>

    <!-- ===== 彩色磁贴（飞牛首页风格） ===== -->
    <div class="hero-tiles">
      <div class="tile tile-mix" @click="playAll">
        <div class="tile-glow"></div>
        <el-icon class="tile-icon" :size="34"><Headset /></el-icon>
        <span class="tile-label">混音</span>
      </div>
      <div class="tile tile-fav" @click="$router.push('/favorites')">
        <div class="tile-glow"></div>
        <el-icon class="tile-icon" :size="34"><svg viewBox="0 0 24 24" fill="currentColor" width="34" height="34"><path d="M12 21s-7-4.5-9.5-9.2C.7 8.4 2.5 4.5 6 4.5c2 0 3.4 1.1 4.2 2.5C11.1 5.6 12.5 4.5 14.5 4.5c3.5 0 5.3 3.9 3.5 7.3C19 16.5 12 21 12 21z"/></svg></el-icon>
        <span class="tile-label">收藏</span>
      </div>
      <div class="tile tile-recent" @click="$router.push('/history')">
        <div class="tile-glow"></div>
        <el-icon class="tile-icon" :size="34"><Clock /></el-icon>
        <span class="tile-label">最近播放</span>
      </div>
      <div class="tile tile-added" @click="playAll">
        <div class="tile-glow"></div>
        <el-icon class="tile-icon" :size="34"><Plus /></el-icon>
        <span class="tile-label">最近添加</span>
      </div>
    </div>

    <!-- ===== 歌曲列表 ===== -->
    <div class="song-list" v-loading="loading">
      <div class="list-header">
        <span class="col col-index">#</span>
        <span class="col col-title">标题</span>
        <span class="col col-artist">艺术家</span>
        <span class="col col-album">专辑</span>
        <span class="col col-duration">
          <el-icon><Clock /></el-icon>
        </span>
        <span class="col col-actions"></span>
      </div>

      <div
        v-for="(song, idx) in songs"
        :key="song.id"
        class="song-row"
        :class="{
          active: playerStore.currentSong && playerStore.currentSong.id === song.id,
          playing: playerStore.currentSong && playerStore.currentSong.id === song.id && playerStore.isPlaying
        }"
        @dblclick="playSong(song)"
      >
        <span class="col col-index">
          <span class="row-index">{{ (currentPage - 1) * pageSize + idx + 1 }}</span>
          <span class="row-playing">
            <span></span><span></span><span></span>
          </span>
        </span>
        <span class="col col-title">
          <div class="song-cover-wrap">
            <el-image
              v-if="song.coverArt"
              :src="`/rest/getCoverArt?id=${song.coverArt}&size=120`"
              class="song-cover"
              fit="cover"
              lazy
            >
              <template #error>
                <div class="cover-placeholder"><el-icon><Headset /></el-icon></div>
              </template>
            </el-image>
            <div v-else class="cover-placeholder"><el-icon><Headset /></el-icon></div>
            <div class="cover-play" @click.stop="playSong(song)">
              <el-icon :size="20"><VideoPlay /></el-icon>
            </div>
          </div>
          <div class="title-meta">
            <div class="song-title" :class="{ 'is-active': playerStore.currentSong && playerStore.currentSong.id === song.id }">{{ song.title }}</div>
            <div class="song-bitrate" v-if="song.bitRate">{{ song.bitRate }}kbps · {{ (song.suffix || '').toUpperCase() }}</div>
          </div>
        </span>
        <span class="col col-artist">{{ song.artist || '—' }}</span>
        <span class="col col-album">{{ song.album || '—' }}</span>
        <span class="col col-duration">{{ formatDuration(song.duration) }}</span>
        <span class="col col-actions">
          <button class="row-btn" :class="{ active: favoritesStore.isFavorite(song.id) }" @click.stop="toggleFavorite(song)" :title="favoritesStore.isFavorite(song.id) ? '取消喜欢' : '我喜欢'">
            <HeartIcon :filled="favoritesStore.isFavorite(song.id)" :size="16" />
          </button>
          <button class="row-btn" @click.stop="openAddToPlaylist(song)" title="添加到歌单">
            <el-icon :size="16"><Plus /></el-icon>
          </button>
        </span>
      </div>

      <div v-if="!loading && songs.length === 0" class="empty-state">
        <el-icon :size="48"><Headset /></el-icon>
        <p>暂无歌曲</p>
      </div>
    </div>

    <div class="pagination-bar" v-if="total > 0">
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

    <!-- ===== 添加到歌单对话框 ===== -->
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
import { VideoPlay, Plus, Headset, List, Loading, Clock } from "@element-plus/icons-vue";
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

const showPlaylistDialog = ref(false);
const playlistTargetSong = ref<Song | null>(null);
const playlists = ref<any[]>([]);
const playlistsLoading = ref(false);
const addingPlaylistId = ref("");
const newPlaylistName = ref("");

let searchTimer: ReturnType<typeof setTimeout> | null = null;

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
    await api.post("/rest/createPlaylist", { name: newPlaylistName.value, songId: playlistTargetSong.value.id });
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
.songs-page {
  padding: 32px 36px;
  max-width: 1400px;
  margin: 0 auto;
}

/* ===== Hero tiles (FnOS home dashboard) ===== */
.hero-tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 36px;
}
.tile {
  position: relative;
  height: 160px;
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 18px;
  color: #fff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
  isolation: isolate;
}
.tile:hover {
  transform: translateY(-4px);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.tile .tile-glow {
  position: absolute;
  inset: -40%;
  pointer-events: none;
  filter: blur(40px);
  opacity: 0.7;
  animation: fnos-aurora-drift-b 18s ease-in-out infinite alternate;
  z-index: -1;
}
.tile .tile-icon {
  align-self: flex-start;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(255, 255, 255, 0.18);
  border-radius: 50%;
  padding: 8px;
  width: 50px; height: 50px;
  display: inline-flex; align-items: center; justify-content: center;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.tile .tile-label {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
/* 混音：紫橙渐变 + 黑胶质感 */
.tile-mix {
  background:
    radial-gradient(ellipse at 70% 50%, #1a1a1a 0%, #0a0a0a 40%, transparent 70%),
    linear-gradient(135deg, #ff7a3d 0%, #c934e1 60%, #5b2bbf 100%);
}
.tile-mix .tile-glow {
  background: radial-gradient(circle, rgba(255, 122, 61, 0.6), transparent 60%);
}
/* 收藏：橙红 + 心形 */
.tile-fav {
  background: linear-gradient(135deg, #ffb347 0%, #ff6b3d 35%, #f62c55 75%, #d11d4a 100%);
}
.tile-fav .tile-glow {
  background: radial-gradient(circle, rgba(255, 107, 61, 0.7), transparent 60%);
}
/* 最近播放：绿 */
.tile-recent {
  background: linear-gradient(135deg, #6bab45 0%, #16a34a 45%, #0d8a6e 100%);
}
.tile-recent .tile-glow {
  background: radial-gradient(circle, rgba(107, 171, 69, 0.7), transparent 60%);
}
/* 最近添加：白灰 */
.tile-added {
  background: linear-gradient(135deg, #f5f5f5 0%, #d8d8d8 45%, #a8a8a8 100%);
  color: #2a2a2a;
}
.tile-added .tile-icon { color: #2a2a2a; background: rgba(0, 0, 0, 0.08); }
.tile-added .tile-label { color: #2a2a2a; text-shadow: none; }
.tile-added .tile-glow {
  background: radial-gradient(circle, rgba(255, 255, 255, 0.8), transparent 60%);
}

@media (max-width: 1100px) {
  .hero-tiles { grid-template-columns: repeat(2, 1fr); }
  .tile { height: 140px; }
}
@media (max-width: 768px) {
  .hero-tiles { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .tile { height: 120px; padding: 14px; }
  .tile .tile-icon { width: 42px; height: 42px; padding: 6px; }
  .tile .tile-label { font-size: 14px; }
}

/* ===== Page header ===== */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 28px;
  gap: 16px;
  flex-wrap: wrap;
  .page-title {
    display: flex;
    align-items: baseline;
    gap: 14px;
    h2 {
      font-size: 32px;
      font-weight: 700;
      margin: 0;
      letter-spacing: -0.4px;
      color: var(--fnos-text-primary);
    }
    .song-count {
      font-size: 14px;
      color: var(--fnos-text-tertiary);
      font-weight: 500;
    }
  }
  .header-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    .search-input {
      width: 320px;
    }
    .play-all-btn {
      padding: 0 20px;
      height: 38px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
  }
}

/* ===== Song list ===== */
.song-list {
  border-radius: 12px;
  overflow: hidden;
}

.list-header {
  display: grid;
  grid-template-columns: 56px 1fr 180px 200px 80px 90px;
  align-items: center;
  padding: 0 16px;
  height: 40px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--fnos-text-tertiary);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.02);
  .col { padding: 0 8px; }
  .col-duration { text-align: center; }
  .col-actions { text-align: right; }
}

.song-row {
  display: grid;
  grid-template-columns: 56px 1fr 180px 200px 80px 90px;
  align-items: center;
  padding: 0 16px;
  height: 64px;
  border-radius: 8px;
  margin: 2px 0;
  cursor: pointer;
  transition: background 0.18s ease;
  color: var(--fnos-text-primary-dim);

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    .col-actions .row-btn { opacity: 1; }
    .song-cover-wrap .cover-play { opacity: 1; transform: scale(1); }
    .row-index { display: none; }
    .row-hover-play { display: inline-flex; }
  }
  &.active {
    background: linear-gradient(90deg, rgba(246, 44, 85, 0.14) 0%, rgba(246, 44, 85, 0.02) 100%);
    .row-index { display: none; }
    .row-playing { display: inline-flex; }
    .song-title { color: var(--fnos-red); }
  }

  .col { padding: 0 8px; min-width: 0; }
  .col-index {
    text-align: center;
    font-size: 14px;
    color: var(--fnos-text-tertiary);
    .row-index { font-variant-numeric: tabular-nums; }
    .row-playing {
      display: none;
      align-items: flex-end;
      justify-content: center;
      gap: 2px;
      height: 16px;
      span {
        display: block;
        width: 3px;
        background: var(--fnos-red);
        border-radius: 1px;
        animation: bar 0.9s ease-in-out infinite;
        &:nth-child(1) { height: 8px; animation-delay: -0.3s; }
        &:nth-child(2) { height: 14px; animation-delay: 0s; }
        &:nth-child(3) { height: 8px; animation-delay: -0.6s; }
      }
    }
    .row-hover-play {
      display: none;
      color: var(--fnos-text-primary);
      font-size: 16px;
    }
  }
  &:hover .row-hover-play { display: inline-flex; }
  .col-title {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    .song-cover-wrap {
      position: relative;
      width: 44px; height: 44px;
      flex-shrink: 0;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      .song-cover, .cover-placeholder {
        width: 100%; height: 100%;
        object-fit: cover;
        border-radius: 6px;
      }
      .cover-placeholder {
        background: rgba(255, 255, 255, 0.06);
        display: flex; align-items: center; justify-content: center;
        color: rgba(255, 255, 255, 0.4);
      }
      .cover-play {
        position: absolute; inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
        color: #fff;
        opacity: 0;
        transform: scale(0.8);
        transition: opacity 0.18s ease, transform 0.18s ease;
        cursor: pointer;
      }
    }
    .title-meta { min-width: 0; flex: 1; }
    .song-title {
      font-size: 14px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fnos-text-primary);
      &.is-active { color: var(--fnos-red); font-weight: 600; }
    }
    .song-bitrate {
      font-size: 11px;
      color: var(--fnos-text-muted);
      margin-top: 2px;
      letter-spacing: 0.3px;
    }
  }
  .col-artist, .col-album {
    font-size: 13px;
    color: var(--fnos-text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .col-duration {
    text-align: center;
    font-size: 12px;
    color: var(--fnos-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .col-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    .row-btn {
      width: 32px; height: 32px;
      border: none; background: transparent;
      color: var(--fnos-text-tertiary);
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      opacity: 0;
      transition: opacity 0.18s, color 0.18s, background 0.18s;
      &:hover { color: var(--fnos-text-primary); background: rgba(255, 255, 255, 0.08); }
      &.active { color: var(--fnos-red); opacity: 1; }
      &.active:hover { color: var(--fnos-red-hover); }
    }
  }
  &.active .col-actions .row-btn { opacity: 1; }
}

@keyframes bar {
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1); }
}

.empty-state {
  display: flex; flex-direction: column; align-items: center;
  gap: 12px;
  padding: 80px 0;
  color: var(--fnos-text-muted);
  p { margin: 0; font-size: 14px; }
}

.pagination-bar {
  margin-top: 24px;
  display: flex;
  justify-content: center;
}

.playlist-dialog-song { font-size: 13px; color: var(--fnos-text-tertiary); margin-bottom: 12px; }
.playlist-list { max-height: 320px; overflow-y: auto; }
.playlist-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 8px;
  cursor: pointer; transition: background 0.2s;
  &:hover { background: rgba(255, 255, 255, 0.06); }
  .pl-icon { font-size: 18px; color: var(--fnos-text-tertiary); }
  .pl-info { flex: 1;
    .pl-name { font-size: 14px; font-weight: 500; color: var(--fnos-text-primary); }
    .pl-meta { font-size: 12px; color: var(--fnos-text-tertiary); }
  }
}
.create-playlist-row {
  display: flex; gap: 8px;
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.empty-tip { text-align: center; color: var(--fnos-text-muted); font-size: 13px; padding: 20px 0; }

@media (max-width: 1100px) {
  .list-header, .song-row {
    grid-template-columns: 48px 1fr 80px 90px;
  }
  .col-artist, .col-album { display: none; }
  .col-actions { display: none !important; }
}
@media (max-width: 768px) {
  .songs-page { padding: 20px 16px; }
  .page-header .page-title h2 { font-size: 24px; }
  .page-header .header-actions .search-input { width: 200px; }
}
</style>