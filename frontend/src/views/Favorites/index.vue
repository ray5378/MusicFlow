<template>
  <div class="favorites-page" v-loading="loading">
    <div class="fav-header">
      <div class="fav-cover">
        <HeartIcon :filled="true" :size="64" class="fav-heart" />
      </div>
      <div class="fav-meta">
        <div class="label">我喜欢的音乐</div>
        <h1>我喜欢的音乐</h1>
        <div class="info">{{ songs.length }}首 · 喜欢的音乐都在这里</div>
        <div class="actions">
          <el-button type="primary" @click="playAll" :disabled="songs.length === 0">播放全部</el-button>
          <el-button :icon="MagicStick" @click="togglePool">{{ inPool ? '移出每日推荐池' : '加入每日推荐池' }}</el-button>
        </div>
      </div>
    </div>
    <el-table :data="songs" stripe @row-dblclick="playSong" highlight-current-row style="width: 100%">
      <el-table-column type="index" width="60" label="#" />
      <el-table-column label="" width="60">
        <template #default="{ row }">
          <img v-if="row.coverArt" :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`" class="song-cover" />
          <div v-else class="cover-placeholder"><el-icon><Headset /></el-icon></div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="200" />
      <el-table-column prop="artist" label="艺术家" width="180" />
      <el-table-column prop="album" label="专辑" width="200" />
      <el-table-column label="时长" width="100"><template #default="{ row }">{{ formatDuration(row.duration) }}</template></el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button-group>
            <el-tooltip content="播放" placement="top">
              <el-button :icon="Play" circle size="small" @click="playSong(row)" />
            </el-tooltip>
            <el-tooltip content="添加到歌单" placement="top">
              <el-button :icon="Plus" circle size="small" @click="openAddToPlaylist(row)" />
            </el-tooltip>
            <el-tooltip content="取消喜欢" placement="top">
              <el-button circle size="small" class="fav-btn" @click="unstar(row)">
                <HeartIcon :filled="true" :size="16" />
              </el-button>
            </el-tooltip>
          </el-button-group>
        </template>
      </el-table-column>
    </el-table>

    <!-- Add to playlist dialog -->
    <el-dialog v-model="showPlaylistDialog" title="添加到歌单" width="420px">
      <div class="playlist-dialog-song" v-if="playlistTargetSong">
        将「{{ playlistTargetSong.title }} - {{ playlistTargetSong.artist }}」添加到：
      </div>
      <div class="playlist-list" v-loading="playlistsLoading">
        <div v-for="pl in playlists" :key="pl.id" class="playlist-item" :class="{ active: addingPlaylistId === pl.id }" @click="addToPlaylist(pl)">
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
import { ref, onMounted } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { VideoPlay as Play, List, Plus, Headset, Loading, MagicStick } from "@element-plus/icons-vue";
import HeartIcon from "@/components/HeartIcon.vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const playerStore = usePlayerStore();
const favoritesStore = useFavoritesStore();
const songs = ref<any[]>([]);
const loading = ref(false);
const showPlaylistDialog = ref(false);
const playlistTargetSong = ref<any>(null);
const playlists = ref<any[]>([]);
const playlistsLoading = ref(false);
const addingPlaylistId = ref("");
const newPlaylistName = ref("");
// Whether "我喜欢的音乐" is in the daily-recommend pool.
const inPool = ref(false);

async function loadPoolStatus() {
  try {
    const res = await api.get("/rest/api/v1/recommend-pool/favorites/status");
    inPool.value = !!res.data.inPool;
  } catch { inPool.value = false; }
}

async function togglePool() {
  try {
    if (inPool.value) {
      await api.delete("/rest/api/v1/recommend-pool/favorites");
      inPool.value = false;
      ElMessage.success("已将「我喜欢的音乐」移出每日推荐池");
    } else {
      const res = await api.post("/rest/api/v1/recommend-pool/favorites");
      inPool.value = true;
      ElMessage.success(res.data.message || "已将「我喜欢的音乐」加入每日推荐池");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "操作失败");
  }
}

function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
function playSong(song: any) { playerStore.playSong(song); }
function playAll() { if (songs.value.length > 0) playerStore.playQueue(songs.value); }
async function unstar(song: any) {
  try {
    await favoritesStore.removeFavorite(song.id);
    ElMessage.success("已取消收藏");
    loadFavorites();
  } catch (e: any) { ElMessage.error(e.message || "操作失败"); }
}

async function loadFavorites() {
  loading.value = true;
  try {
    const res = await api.get("/rest/getStarred?f=json");
    songs.value = res.data["subsonic-response"]?.starred?.song || [];
  } catch { songs.value = []; }
  finally { loading.value = false; }
}

async function openAddToPlaylist(song: any) {
  playlistTargetSong.value = song;
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
  if (!playlistTargetSong.value || addingPlaylistId.value) return;
  addingPlaylistId.value = pl.id;
  try {
    await api.post("/rest/updatePlaylist", { playlistId: pl.id, songIdToAdd: playlistTargetSong.value.id });
    ElMessage.success(`已添加到「${pl.name}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "添加失败"); }
  finally { addingPlaylistId.value = ""; }
}

async function createAndAdd() {
  if (!newPlaylistName.value || !playlistTargetSong.value) return;
  if (addingPlaylistId.value) return;
  addingPlaylistId.value = "new";
  try {
    await api.post("/rest/createPlaylist", { name: newPlaylistName.value, songId: playlistTargetSong.value.id });
    ElMessage.success(`已创建并添加「${newPlaylistName.value}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "创建失败"); }
  finally { addingPlaylistId.value = ""; }
}

onMounted(() => { loadFavorites(); favoritesStore.loadFavorites(); loadPoolStatus(); });
</script>

<style lang="scss" scoped>
.favorites-page { padding: 24px; }
.fav-header { display: flex; gap: 24px; margin-bottom: 24px;
  .fav-cover { width: 200px; height: 200px; border-radius: 8px; background: linear-gradient(135deg, #f5b942, #e94560); display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;
    .fav-heart { color: #fff; } }
  .fav-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: #999; text-transform: uppercase; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; }
    .info { color: #999; font-size: 14px; }
    .actions { margin-top: 16px; }
  }
}
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: #e5e7eb; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 18px; }
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