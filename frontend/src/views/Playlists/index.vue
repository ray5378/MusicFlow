<template>
  <div class="playlists-page">
    <div class="page-header">
      <h2>歌单</h2>
      <div class="header-actions">
        <el-button type="primary" @click="showCreateDialog = true"><el-icon><Plus /></el-icon>新建歌单</el-button>
      </div>
    </div>
    <div class="playlist-grid" v-loading="loading">
      <!-- Favorites special playlist -->
      <div class="playlist-card" @click="router.push('/favorites')">
        <div class="playlist-cover fav-cover"><HeartIcon :filled="true" :size="48" /></div>
        <div class="playlist-info">
          <div class="playlist-name">我喜欢的音乐</div>
          <div class="playlist-meta">喜欢的音乐都在这里</div>
        </div>
      </div>
      <!-- User playlists -->
      <div class="playlist-card" v-for="pl in playlists" :key="pl.id" @click="router.push(`/playlists/${pl.id}`)">
        <div class="playlist-cover">
          <img v-if="pl.coverArt" :src="`/rest/getCoverArt?id=${pl.coverArt}&size=300`" />
          <div v-else class="cover-placeholder"><el-icon :size="48"><List /></el-icon></div>
        </div>
        <div class="playlist-info">
          <div class="playlist-name">{{ pl.name }}</div>
          <div class="playlist-meta">{{ pl.songCount }}首 · {{ formatDuration(pl.duration) }}</div>
        </div>
        <el-dropdown trigger="click" class="playlist-menu" @click.stop @command="(cmd: string) => handleCardCommand(cmd, pl)">
          <el-button size="small" circle :icon="MoreFilled" @click.stop />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="play"><el-icon><VideoPlay /></el-icon>播放全部</el-dropdown-item>
              <el-dropdown-item command="rename"><el-icon><Edit /></el-icon>重命名</el-dropdown-item>
              <el-dropdown-item command="delete" divided><el-icon><Delete /></el-icon>删除歌单</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <el-dialog v-model="showCreateDialog" title="新建歌单" width="400px">
      <el-input v-model="newPlaylistName" placeholder="歌单名称" @keyup.enter="createPlaylist" />
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="createPlaylist">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showRenameDialog" title="重命名歌单" width="400px">
      <el-input v-model="renamePlaylistName" placeholder="新歌单名称" @keyup.enter="renamePlaylist" />
      <template #footer>
        <el-button @click="showRenameDialog = false">取消</el-button>
        <el-button type="primary" @click="renamePlaylist">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { List, Plus, MoreFilled, Edit, Delete, VideoPlay } from "@element-plus/icons-vue";
import HeartIcon from "@/components/HeartIcon.vue";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";

const router = useRouter();
const playlists = ref<any[]>([]);
const loading = ref(false);
const showCreateDialog = ref(false);
const showRenameDialog = ref(false);
const newPlaylistName = ref("");
const renamePlaylistName = ref("");
const renameTarget = ref<any>(null);

function formatDuration(sec: number) { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`; }

async function loadPlaylists() {
  loading.value = true;
  try {
    const res = await api.get("/rest/getPlaylists?f=json");
    playlists.value = res.data["subsonic-response"]?.playlists?.playlist || [];
  } catch { playlists.value = []; }
  finally { loading.value = false; }
}

async function createPlaylist() {
  if (!newPlaylistName.value) { ElMessage.warning("请输入歌单名称"); return; }
  try {
    const res = await api.post("/rest/createPlaylist", { name: newPlaylistName.value });
    showCreateDialog.value = false;
    newPlaylistName.value = "";
    ElMessage.success("创建成功");
    if (res.data["subsonic-response"]?.playlist?.id) router.push(`/playlists/${res.data["subsonic-response"].playlist.id}`);
    loadPlaylists();
  } catch { ElMessage.error("创建失败"); }
}

function handleCardCommand(cmd: string, pl: any) {
  switch (cmd) {
    case "play": playAll(pl); break;
    case "rename": openRename(pl); break;
    case "delete": deletePlaylist(pl); break;
  }
}

async function playAll(pl: any) {
  try {
    const res = await api.get(`/rest/getPlaylist?id=${pl.id}&f=json`);
    const songs = res.data["subsonic-response"]?.playlist?.entry?.filter((e: any) => e.playable) || [];
    if (songs.length > 0) { const { usePlayerStore } = await import("@/stores/player"); usePlayerStore().playQueue(songs); }
    else ElMessage.warning("歌单为空");
  } catch { ElMessage.error("播放失败"); }
}

function openRename(pl: any) {
  renameTarget.value = pl;
  renamePlaylistName.value = pl.name;
  showRenameDialog.value = true;
}

async function renamePlaylist() {
  if (!renamePlaylistName.value || !renameTarget.value) { ElMessage.warning("请输入名称"); return; }
  try {
    await api.post("/rest/updatePlaylist", { playlistId: renameTarget.value.id, name: renamePlaylistName.value });
    showRenameDialog.value = false;
    ElMessage.success("已重命名");
    loadPlaylists();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "重命名失败"); }
}

async function deletePlaylist(pl: any) {
  await ElMessageBox.confirm(`确定删除歌单「${pl.name}」？`, "确认删除", { type: "warning" });
  try {
    await api.post("/rest/deletePlaylist", { id: pl.id });
    ElMessage.success("已删除");
    loadPlaylists();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "删除失败"); }
}

onMounted(loadPlaylists);
</script>

<style lang="scss" scoped>
.playlists-page { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } .header-actions { display: flex; gap: 8px; } }
.playlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
.playlist-card { position: relative; cursor: pointer; border-radius: 8px; overflow: hidden; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s;
  &:hover { transform: translateY(-4px); }
  .playlist-cover { aspect-ratio: 1; overflow: hidden;
    img { width: 100%; height: 100%; object-fit: cover; }
    .cover-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; }
    &.fav-cover { background: linear-gradient(135deg, #f5b942, #e94560); color: #fff; display: flex; align-items: center; justify-content: center;
      .heart-icon { color: #fff; } }
  }
  .playlist-info { padding: 12px;
    .playlist-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .playlist-meta { font-size: 12px; color: #999; margin-top: 4px; }
  }
  .playlist-menu { position: absolute; top: 8px; right: 8px; opacity: 0; transition: opacity 0.2s; }
  &:hover .playlist-menu { opacity: 1; }
}
</style>