<template>
  <div class="playlists-page">
    <div class="page-header">
      <h2>歌单</h2>
      <div class="header-actions">
        <el-button type="primary" @click="showCreateDialog = true"><el-icon><Plus /></el-icon>新建歌单</el-button>
        <el-button @click="showImportDialog = true"><el-icon><Download /></el-icon>导入歌单</el-button>
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
          <div class="playlist-name">
            {{ pl.name }}
            <el-tag v-if="pl.sourcePlatform" size="small" style="margin-left: 4px">{{ pl.sourcePlatform === 'qq' ? 'QQ' : pl.sourcePlatform === 'netease' ? '网易云' : '' }}</el-tag>
            <el-tag v-if="pl.public" size="small" type="success" style="margin-left: 4px">公开</el-tag>
          </div>
          <div class="playlist-meta">{{ pl.songCount }}首 · {{ formatDuration(pl.duration) }}</div>
        </div>
        <el-dropdown trigger="click" class="playlist-menu" @click.stop @command="(cmd: string) => handleCardCommand(cmd, pl)">
          <el-button size="small" circle :icon="MoreFilled" @click.stop />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="play"><el-icon><VideoPlay /></el-icon>播放全部</el-dropdown-item>
              <el-dropdown-item v-if="pl.isImported" command="sync"><el-icon><Refresh /></el-icon>同步</el-dropdown-item>
              <el-dropdown-item command="rename"><el-icon><Edit /></el-icon>重命名</el-dropdown-item>
              <el-dropdown-item command="delete" divided><el-icon><Delete /></el-icon>删除歌单</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <div class="pagination-bar">
      <el-pagination
        layout="total, sizes, prev, pager, next, jumper"
        :total="total"
        :page-size="pageSize"
        :page-sizes="[15, 20, 50, 100]"
        :current-page="currentPage"
        background
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
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

    <el-dialog v-model="showImportDialog" title="导入歌单" width="520px">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
        支持 QQ 音乐、网易云音乐歌单分享链接。导入时自动匹配本地曲库,匹配到的歌曲可直接播放;未匹配的歌曲加入许愿清单
      </el-alert>
      <el-form label-width="80px">
        <el-form-item label="歌单链接">
          <el-input v-model="importUrl" placeholder="粘贴 QQ 音乐 / 网易云音乐歌单分享链接..." type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="歌单名称">
          <el-input v-model="importName" placeholder="留空则使用原歌单名" />
        </el-form-item>
        <el-form-item label="自动同步">
          <el-switch v-model="importAutoSync" />
          <span style="margin-left: 8px; font-size: 12px; color: #999">每 6 小时自动同步(需手动同步时也可在详情页操作)</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showImportDialog = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="importPlaylist">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { List, Plus, MoreFilled, Edit, Delete, VideoPlay, Download, Refresh } from "@element-plus/icons-vue";
import HeartIcon from "@/components/HeartIcon.vue";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";

const router = useRouter();
const playlists = ref<any[]>([]);
const loading = ref(false);
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("playlistsPageSize") || "20"));
if (![15, 20, 50, 100].includes(pageSize.value)) pageSize.value = 20;
const showCreateDialog = ref(false);
const showRenameDialog = ref(false);
const newPlaylistName = ref("");
const renamePlaylistName = ref("");
const renameTarget = ref<any>(null);
const showImportDialog = ref(false);
const importUrl = ref("");
const importName = ref("");
const importAutoSync = ref(true);
const importing = ref(false);
const syncingId = ref("");

function formatDuration(sec: number) { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`; }

async function loadPlaylists() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/playlists", {
      params: { page: currentPage.value, pageSize: pageSize.value },
    });
    playlists.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch { playlists.value = []; total.value = 0; }
  finally { loading.value = false; }
}

function onPageChange(page: number) { currentPage.value = page; loadPlaylists(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("playlistsPageSize", String(size));
  currentPage.value = 1;
  loadPlaylists();
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

async function importPlaylist() {
  if (!importUrl.value.trim()) { ElMessage.warning("请输入歌单链接"); return; }
  importing.value = true;
  try {
    const res = await api.post("/rest/api/v1/playlists/import", { url: importUrl.value, name: importName.value, autoSync: importAutoSync.value });
    if (res.data.success) {
      ElMessage.success(`导入成功: 共 ${res.data.trackCount} 首,匹配曲库 ${res.data.matched} 首,未匹配 ${res.data.unmatched} 首(已加入许愿清单)`);
      showImportDialog.value = false;
      importUrl.value = "";
      importName.value = "";
      loadPlaylists();
    } else {
      ElMessage.error(res.data.error || "导入失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "导入失败");
  } finally {
    importing.value = false;
  }
}

async function syncPlaylist(pl: any) {
  syncingId.value = pl.id;
  try {
    const res = await api.post(`/rest/api/v1/playlists/${pl.id}/sync`);
    if (res.data.success) {
      ElMessage.success(`同步完成: 共 ${res.data.total} 首,匹配 ${res.data.matched} 首,未匹配 ${res.data.unmatched} 首`);
      loadPlaylists();
    } else {
      ElMessage.error(res.data.error || "同步失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "同步失败");
  } finally {
    syncingId.value = "";
  }
}

function handleCardCommand(cmd: string, pl: any) {
  switch (cmd) {
    case "play": playAll(pl); break;
    case "sync": syncPlaylist(pl); break;
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
.pagination-bar { margin-top: 24px; display: flex; justify-content: center; }
</style>