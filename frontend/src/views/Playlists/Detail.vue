<template>
  <div class="playlist-detail" v-loading="loading">
    <div class="playlist-header" v-if="playlist">
      <div class="playlist-cover">
        <img v-if="playlist.coverArt" :src="`/rest/getCoverArt?id=${playlist.coverArt}&size=300`" />
        <div v-else class="cover-placeholder"><el-icon :size="64"><List /></el-icon></div>
      </div>
      <div class="playlist-meta">
        <div class="label">歌单<el-tag v-if="playlist.sourcePlatform" size="small" style="margin-left: 8px">{{ playlist.sourcePlatform === 'qq' ? 'QQ 音乐' : playlist.sourcePlatform === 'netease' ? '网易云' : '' }}</el-tag><el-tag v-if="playlist.isImported" size="small" type="warning" style="margin-left: 4px">导入</el-tag></div>
        <h1>{{ playlist.name }}</h1>
        <div class="info">{{ playlist.songCount }}首 · {{ formatTotalDuration(playlist.duration) }}</div>
        <div class="info" v-if="playlist.isImported && playlist.matched !== undefined">
          <span class="matched-count">已匹配 {{ playlist.matched }} / {{ playlist.songCount }}</span>
        </div>
        <div class="actions">
          <el-button type="primary" @click="playAll">播放全部</el-button>
          <el-button @click="showRenameDialog = true"><el-icon><Edit /></el-icon>重命名</el-button>
          <el-button v-if="playlist.isImported" :loading="syncing" @click="syncPlaylist"><el-icon><Refresh /></el-icon>同步</el-button>
          <el-button type="danger" plain @click="deletePlaylist"><el-icon><Delete /></el-icon>删除歌单</el-button>
        </div>
        <div class="settings" v-if="playlist.isImported">
          <el-switch v-model="playlist.syncEnabled" @change="toggleSyncEnabled" />
          <span class="setting-label">自动同步(每 6 小时)</span>
          <el-switch v-model="playlist.public" @change="togglePublic" style="margin-left: 24px" />
          <span class="setting-label">公开歌单</span>
        </div>
      </div>
    </div>
    <el-table :data="songs" stripe @row-dblclick="playSong" highlight-current-row style="width: 100%" @selection-change="onSelectionChange">
      <el-table-column type="selection" width="45" />
      <el-table-column type="index" width="60" label="#" :index="indexMethod" />
      <el-table-column label="" width="60">
        <template #default="{ row }">
          <img v-if="row.coverArt" :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`" class="song-cover" />
          <div v-else class="cover-placeholder"><el-icon><Headset /></el-icon></div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="200">
        <template #default="{ row }">
          <span>{{ row.title }}</span>
          <el-tooltip v-if="!row.isMatched" :content="row.unavailableReason || '曲库中未找到'" placement="top">
            <el-icon class="unmatched-icon" :size="14"><Warning /></el-icon>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column prop="artist" label="艺术家" width="180" />
      <el-table-column label="时长" width="100">
        <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.isMatched" type="success" size="small">可播放</el-tag>
          <el-tag v-else type="info" size="small">未匹配</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button-group>
            <el-tooltip content="播放" placement="top">
              <el-button :icon="Play" circle size="small" :disabled="!row.isMatched" @click="playSong(row)" />
            </el-tooltip>
            <el-tooltip content="从歌单移除" placement="top">
              <el-button :icon="Delete" circle size="small" @click="removeSong(row)" />
            </el-tooltip>
          </el-button-group>
        </template>
      </el-table-column>
    </el-table>
    <div class="batch-bar" v-if="selectedSongs.length > 0">
      <span>已选 {{ selectedSongs.length }} 首</span>
      <el-button size="small" type="danger" plain @click="removeSelected">批量移除</el-button>
      <el-button size="small" @click="playSelected">播放所选</el-button>
    </div>
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

    <el-dialog v-model="showRenameDialog" title="重命名歌单" width="400px">
      <el-input v-model="newName" placeholder="新歌单名称" @keyup.enter="renamePlaylist" />
      <template #footer>
        <el-button @click="showRenameDialog = false">取消</el-button>
        <el-button type="primary" @click="renamePlaylist">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayerStore } from "@/stores/player";
import { List, Delete, Headset, Edit, VideoPlay as Play, Warning, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const playlist = ref<any>(null);
const songs = ref<any[]>([]);
const loading = ref(false);
const syncing = ref(false);
const showRenameDialog = ref(false);
const newName = ref("");
const selectedSongs = ref<any[]>([]);
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("playlistTracksPageSize") || "50"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 50;

function indexMethod(index: number) { return (currentPage.value - 1) * pageSize.value + index + 1; }
function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
// Total playlist duration in hours/minutes, e.g. "117小时39分钟"
function formatTotalDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
  return `${m}分钟`;
}
function playSong(song: any) { if (song.isMatched) playerStore.playSong(song); }
function playAll() { const playable = songs.value.filter(s => s.isMatched); if (playable.length > 0) playerStore.playQueue(playable); }
function playSelected() { const playable = selectedSongs.value.filter(s => s.isMatched); if (playable.length > 0) playerStore.playQueue(playable); }
function onSelectionChange(rows: any[]) { selectedSongs.value = rows; }

async function loadPlaylist() {
  loading.value = true;
  try {
    const res = await api.get(`/rest/api/v1/playlists/${route.params.id}/tracks`, {
      params: { page: currentPage.value, pageSize: pageSize.value },
    });
    playlist.value = res.data.playlist;
    songs.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch {}
  finally { loading.value = false; }
}

function onPageChange(page: number) { currentPage.value = page; loadPlaylist(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("playlistTracksPageSize", String(size));
  currentPage.value = 1;
  loadPlaylist();
}

async function syncPlaylist() {
  syncing.value = true;
  try {
    const res = await api.post(`/rest/api/v1/playlists/${route.params.id}/sync`);
    if (res.data.success) {
      ElMessage.success(`同步完成: 共 ${res.data.total} 首,匹配 ${res.data.matched} 首,未匹配 ${res.data.unmatched} 首`);
      loadPlaylist();
    } else {
      ElMessage.error(res.data.error || "同步失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "同步失败");
  } finally {
    syncing.value = false;
  }
}

async function toggleSyncEnabled(val: boolean) {
  try {
    await api.put(`/rest/api/v1/playlists/${route.params.id}`, { syncEnabled: val });
    ElMessage.success(val ? "已启用自动同步" : "已关闭自动同步");
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "操作失败"); }
}

async function togglePublic(val: boolean) {
  try {
    await api.put(`/rest/api/v1/playlists/${route.params.id}`, { isPublic: val });
    ElMessage.success(val ? "歌单已设为公开" : "歌单已设为私有");
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "操作失败"); }
}

async function removeSong(row: any) {
  await ElMessageBox.confirm(`从歌单移除「${row.title}」？`, "确认移除", { type: "warning" });
  try {
    await api.post("/rest/updatePlaylist", { playlistId: route.params.id, songIdToRemove: row.id });
    ElMessage.success("已移除");
    loadPlaylist();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "移除失败"); }
}

async function removeSelected() {
  try {
    for (const s of selectedSongs.value) {
      await api.post("/rest/updatePlaylist", { playlistId: route.params.id, songIdToRemove: s.id });
    }
    ElMessage.success(`已移除 ${selectedSongs.value.length} 首`);
    loadPlaylist();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "移除失败"); }
}

async function renamePlaylist() {
  if (!newName.value) { ElMessage.warning("请输入名称"); return; }
  try {
    await api.post("/rest/updatePlaylist", { playlistId: route.params.id, name: newName.value });
    showRenameDialog.value = false;
    ElMessage.success("已重命名");
    loadPlaylist();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "重命名失败"); }
}

async function deletePlaylist() {
  await ElMessageBox.confirm(`确定删除歌单「${playlist.value?.name}」？`, "确认删除", { type: "warning" });
  try {
    await api.post("/rest/deletePlaylist", { id: route.params.id });
    ElMessage.success("已删除");
    router.push("/playlists");
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "删除失败"); }
}

onMounted(loadPlaylist);
</script>

<style lang="scss" scoped>
.playlist-detail { padding: 24px; }
.playlist-header { display: flex; gap: 24px; margin-bottom: 24px;
  .playlist-cover { width: 200px; height: 200px; border-radius: 8px; overflow: hidden; flex-shrink: 0;
    img { width: 100%; height: 100%; object-fit: cover; }
    .cover-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; }
  }
  .playlist-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: #999; text-transform: uppercase; display: flex; align-items: center; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; }
    .info { color: #999; font-size: 14px; }
    .actions { margin-top: 16px; display: flex; gap: 8px; }
    .settings { margin-top: 14px; display: flex; align-items: center; gap: 6px;
      .setting-label { font-size: 12px; color: #999; margin-right: 4px; }
    }
  }
}
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: #e5e7eb; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 18px; }
.unmatched-icon { color: #e6a23c; margin-left: 6px; vertical-align: middle; }
.matched-count { color: #16a34a; font-weight: 500; }
.batch-bar { margin-top: 12px; display: flex; align-items: center; gap: 12px; font-size: 13px; color: #666; }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }
</style>