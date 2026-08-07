<template>
  <div class="playlist-detail" v-loading="loading">
    <div class="playlist-header" v-if="playlist">
      <div class="playlist-cover">
        <img v-if="playlist.coverArt" :src="`/rest/getCoverArt?id=${playlist.coverArt}&size=300`" />
        <div v-else class="cover-placeholder"><MfIcon name="List" :size="64"  /></div>
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
          <el-button @click="exportPlaylist"><MfIcon name="Download" />导出</el-button>
          <el-button @click="showRenameDialog = true"><MfIcon name="Pencil" />重命名</el-button>
          <el-button v-if="playlist.isImported" :loading="syncing" @click="syncPlaylist"><MfIcon name="RefreshCw" />同步</el-button>
          <el-button @click="togglePool"><MfIcon name="Wand2" />{{ inPool ? '移出每日推荐池' : '加入每日推荐池' }}</el-button>
          <el-button type="danger" plain @click="deletePlaylist"><MfIcon name="Trash2" />删除歌单</el-button>
        </div>
        <div class="settings" v-if="playlist.isImported">
          <el-switch v-model="playlist.syncEnabled" @change="toggleSyncEnabled" />
          <span class="setting-label">自动同步(每 6 小时)</span>
          <el-switch v-model="playlist.public" @change="togglePublic" style="margin-left: 24px" />
          <span class="setting-label">公开歌单</span>
        </div>
      </div>
    </div>
    <SongTable
      :songs="songs"
      :offset="(currentPage - 1) * pageSize"
      :selectable="!isMobile"
      :loading="loading"
      :extra-actions="playlistRowActions"
      @play="playSong"
      @select="onSelectionChange"
    >
      <template #row-actions="{ row }">
        <button class="row-btn" @click.stop="removeSong(row)" title="从歌单移除">
          <MfIcon name="Trash2" :size="16" />
        </button>
      </template>
    </SongTable>
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
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";
import { useIsMobile } from "@/composables/useIsMobile";
import SongTable from "@/components/SongTable.vue";
import { Trash2 } from "lucide-vue-next";

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const playlist = ref<any>(null);
// Whether this playlist is in the daily-recommend pool.
const inPool = ref(false);
const songs = ref<any[]>([]);
const isMobile = useIsMobile();
const loading = ref(false);
const syncing = ref(false);
const showRenameDialog = ref(false);
const newName = ref("");
const selectedSongs = ref<any[]>([]);
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("playlistTracksPageSize") || "50"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 50;

function playlistRowActions(row: any) {
  return [
    {
      label: "从歌单移除",
      icon: Trash2,
      danger: true,
      onClick: () => removeSong(row),
    },
  ];
}
function formatTotalDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
  return `${m}分钟`;
}
function playSong(song: any) { if (song.isMatched !== false) playerStore.playSong(song); }
function playAll() { const playable = songs.value.filter(s => s.isMatched !== false); if (playable.length > 0) playerStore.playQueue(playable); }
function playSelected() { const playable = selectedSongs.value.filter(s => s.isMatched !== false); if (playable.length > 0) playerStore.playQueue(playable); }
function onSelectionChange(rows: any[]) { selectedSongs.value = rows; }
async function exportPlaylist() {
  if (!playlist.value?.id) return;
  try {
    const res = await api.get(`/rest/api/v1/playlists/${playlist.value.id}/export`, { responseType: "blob" });
    const blob = new Blob([res.data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const cd = (res.headers["content-disposition"] as string) || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const a = document.createElement("a");
    a.href = url;
    a.download = m ? decodeURIComponent(m[1]) : `${playlist.value.name}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.message || "导出失败");
  }
}

async function loadPlaylist() {
  loading.value = true;
  try {
    const res = await api.get(`/rest/api/v1/playlists/${route.params.id}/tracks`, {
      params: { page: currentPage.value, pageSize: pageSize.value },
    });
    playlist.value = res.data.playlist;
    songs.value = res.data.items || [];
    total.value = res.data.total || 0;
    loadPoolStatus();
  } catch {}
  finally { loading.value = false; }
}

async function loadPoolStatus() {
  if (!playlist.value?.id) return;
  try {
    const res = await api.get(`/rest/api/v1/recommend-pool/playlist/${playlist.value.id}/status`);
    inPool.value = !!res.data.inPool;
  } catch { inPool.value = false; }
}

async function togglePool() {
  if (!playlist.value?.id) return;
  try {
    if (inPool.value) {
      await api.delete(`/rest/api/v1/recommend-pool/playlist/${playlist.value.id}`);
      inPool.value = false;
      ElMessage.success(`已将「${playlist.value.name}」移出每日推荐池`);
    } else {
      const res = await api.post(`/rest/api/v1/recommend-pool/playlist/${playlist.value.id}`);
      inPool.value = true;
      ElMessage.success(res.data.message || `已将「${playlist.value.name}」加入每日推荐池`);
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "操作失败");
  }
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
.playlist-detail { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.playlist-header { display: flex; gap: 24px; margin-bottom: 24px;
  .playlist-cover { width: 200px; height: 200px; border-radius: var(--fnos-radius-lg); overflow: hidden; flex-shrink: 0; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    img { width: 100%; height: 100%; object-fit: cover; }
    .cover-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); }
  }
  .playlist-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: var(--fnos-text-tertiary); text-transform: uppercase; display: flex; align-items: center; letter-spacing: 0.06em; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; color: var(--fnos-text-primary); }
    .info { color: var(--fnos-text-tertiary); font-size: 14px; }
    .actions { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
    .settings { margin-top: 14px; display: flex; align-items: center; gap: 6px;
      .setting-label { font-size: 12px; color: var(--fnos-text-tertiary); margin-right: 4px; }
    }
  }
}
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); font-size: 18px; }
.unmatched-icon { color: #e6a23c; margin-left: 6px; vertical-align: middle; }
.matched-count { color: var(--fnos-green); font-weight: 500; }
.batch-bar { margin-top: 12px; display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--fnos-text-secondary); }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }

@media (max-width: 768px) {
  .playlist-detail { padding: 20px 16px; }
  .playlist-header { flex-direction: column; align-items: center; text-align: center; gap: 16px; }
  .playlist-header .playlist-cover { width: 160px; height: 160px; }
  .playlist-header .playlist-meta .actions { justify-content: center; }
}
</style>