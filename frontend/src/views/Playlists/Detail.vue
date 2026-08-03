<template>
  <div class="playlist-detail" v-loading="loading">
    <div class="playlist-header" v-if="playlist">
      <div class="playlist-cover">
        <img v-if="playlist.coverArt" :src="`/rest/getCoverArt?id=${playlist.coverArt}&size=300`" />
        <div v-else class="cover-placeholder"><el-icon :size="64"><List /></el-icon></div>
      </div>
      <div class="playlist-meta">
        <div class="label">歌单</div>
        <h1>{{ playlist.name }}</h1>
        <div class="info">{{ playlist.songCount }}首 · {{ formatDuration(playlist.duration) }}</div>
        <div class="actions">
          <el-button type="primary" @click="playAll">播放全部</el-button>
          <el-button @click="showRenameDialog = true"><el-icon><Edit /></el-icon>重命名</el-button>
          <el-button type="danger" plain @click="deletePlaylist"><el-icon><Delete /></el-icon>删除歌单</el-button>
        </div>
      </div>
    </div>
    <el-table :data="songs" stripe @row-dblclick="playSong" highlight-current-row style="width: 100%" @selection-change="onSelectionChange">
      <el-table-column type="selection" width="45" />
      <el-table-column type="index" width="60" label="#" />
      <el-table-column label="" width="60">
        <template #default="{ row }">
          <img v-if="row.coverArt" :src="`/rest/getCoverArt?id=${row.coverArt}&size=80`" class="song-cover" />
          <div v-else class="cover-placeholder"><el-icon><Headset /></el-icon></div>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="200" />
      <el-table-column prop="artist" label="艺术家" width="180" />
      <el-table-column label="时长" width="100">
        <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button-group>
            <el-tooltip content="播放" placement="top">
              <el-button :icon="Play" circle size="small" @click="playSong(row)" />
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
import { List, Delete, Headset, Edit, VideoPlay as Play } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const playlist = ref<any>(null);
const songs = ref<any[]>([]);
const loading = ref(false);
const showRenameDialog = ref(false);
const newName = ref("");
const selectedSongs = ref<any[]>([]);

function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
function playSong(song: any) { if (song.playable) playerStore.playSong(song); }
function playAll() { const playable = songs.value.filter(s => s.playable); if (playable.length > 0) playerStore.playQueue(playable); }
function playSelected() { const playable = selectedSongs.value.filter(s => s.playable); if (playable.length > 0) playerStore.playQueue(playable); }
function onSelectionChange(rows: any[]) { selectedSongs.value = rows; }

async function loadPlaylist() {
  loading.value = true;
  try {
    const res = await api.get(`/rest/getPlaylist?id=${route.params.id}&f=json`);
    const data = res.data["subsonic-response"]?.playlist;
    playlist.value = data;
    songs.value = (data?.entry || []).map((e: any) => ({ ...e, playable: true }));
  } catch {}
  finally { loading.value = false; }
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
    .label { font-size: 12px; color: #999; text-transform: uppercase; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; }
    .info { color: #999; font-size: 14px; }
    .actions { margin-top: 16px; display: flex; gap: 8px; }
  }
}
.song-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; }
.cover-placeholder { width: 40px; height: 40px; border-radius: 4px; background: #e5e7eb; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 18px; }
.batch-bar { margin-top: 12px; display: flex; align-items: center; gap: 12px; font-size: 13px; color: #666; }
</style>