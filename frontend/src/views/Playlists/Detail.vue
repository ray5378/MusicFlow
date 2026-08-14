<template>
  <div class="playlist-detail" v-loading="loading">
    <div class="playlist-header" v-if="playlist">
      <div class="playlist-cover">
        <img v-if="playlist.coverArt" :src="`/rest/getCoverArt?id=${playlist.coverArt}&size=300`" loading="lazy" decoding="async" />
        <div v-else class="cover-placeholder"><MfIcon name="List" :size="64"  /></div>
      </div>
      <div class="playlist-meta">
        <div class="label">歌单<el-tag v-if="playlist.sourcePlatform" size="small" style="margin-left: 8px">{{ playlist.sourcePlatform === 'qq' ? 'QQ 音乐' : playlist.sourcePlatform === 'netease' ? '网易云' : playlist.sourcePlatform === 'kugou' ? '酷狗' : playlist.sourcePlatform === 'kuwo' ? '酷我' : '' }}</el-tag><el-tag v-if="playlist.isImported" size="small" type="warning" style="margin-left: 4px">导入</el-tag></div>
        <h1>{{ playlist.name }}</h1>
        <div class="info">{{ playlist.songCount }}首 · {{ formatTotalDuration(playlist.duration) }}</div>
        <div class="info" v-if="playlist.isImported && playlist.matched !== undefined">
          <span class="matched-count">已匹配 {{ playlist.matched }} / {{ playlist.songCount }}</span>
        </div>
        <div class="actions">
          <el-button type="primary" @click="playAll">播放全部</el-button>
          <el-button v-if="hasOnlineSource" :loading="matchingAll" @click="matchAllPlaylist"><MfIcon name="Search" />在线匹配未匹配</el-button>
          <el-button @click="exportPlaylist"><MfIcon name="Download" />导出</el-button>
          <el-button @click="showRenameDialog = true"><MfIcon name="Pencil" />重命名</el-button>
          <el-button v-if="playlist.isImported" :loading="syncing" @click="syncPlaylist"><MfIcon name="RefreshCw" />同步</el-button>
          <el-button v-if="playlist.isDaily" @click="convertToLocal"><MfIcon name="Pin" />转成本地永久歌单</el-button>
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
      allow-unmatched-play
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

    <el-dialog v-model="showMatchDialog" title="在线匹配" width="480px" :close-on-click-modal="false">
      <div v-if="matchRunning" class="match-progress">
        <el-progress :percentage="matchPercent" />
        <p class="match-hint">正在通过在线源匹配「{{ playlist?.name }}」中未收录的 {{ matchTotal }} 首...<br>已匹配 {{ matchDone }} / {{ matchTotal }} 首(耗时较长,可稍后查看)</p>
      </div>
      <div v-else-if="matchResult">
        <p class="match-result">匹配完成: 成功 {{ matchResult.matched }} 首,未找到 {{ matchResult.noMatch }} 首,出错 {{ matchResult.error }} 首</p>
      </div>
      <p v-else class="match-hint">将对该歌单中所有「曲库中未找到」的歌曲,通过在线源自动匹配并导入,匹配成功后即可直接播放。</p>
      <template #footer>
        <el-button @click="showMatchDialog = false" :disabled="matchRunning">关闭</el-button>
        <el-button v-if="matchResult" type="primary" @click="closeMatchAndReload">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayerStore } from "@/stores/player";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";
import { useIsMobile } from "@/composables/useIsMobile";
import SongTable from "@/components/SongTable.vue";
import { parseManifest, parseConfig } from "@/utils/plugin";
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
const onlineSourceId = ref("");
const matchingAll = ref(false);
const showMatchDialog = ref(false);
const matchRunning = ref(false);
const matchTotal = ref(0);
const matchDone = ref(0);
const matchResult = ref<any>(null);
const hasOnlineSource = computed(() => !!onlineSourceId.value);
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
async function playSong(song: any) {
  if (song.isMatched !== false) { playerStore.playSong(song); return; }
  await matchAndPlay(song);
}
async function playAll() {
  const playable = songs.value.filter(s => s.isMatched !== false);
  const unmatched = songs.value.filter(s => s.isMatched === false);
  if (unmatched.length > 0) {
    const matched = await matchBeforePlay(unmatched);
    if (matched.length > 0) playerStore.playQueue([...playable, ...matched]);
    else if (playable.length > 0) playerStore.playQueue(playable);
    return;
  }
  if (playable.length > 0) playerStore.playQueue(playable);
}
async function playSelected() {
  const playable = selectedSongs.value.filter(s => s.isMatched !== false);
  const unmatched = selectedSongs.value.filter(s => s.isMatched === false);
  if (unmatched.length > 0) {
    const matched = await matchBeforePlay(unmatched);
    if (matched.length > 0) playerStore.playQueue([...playable, ...matched]);
    else if (playable.length > 0) playerStore.playQueue(playable);
    return;
  }
  if (playable.length > 0) playerStore.playQueue(playable);
}

// Auto-match an unmatched track via the online source, then play it.
async function matchAndPlay(song: any) {
  const pid = onlineSourceId.value;
  if (!pid || !song.entryId) { ElMessage.warning("未配置在线源,无法匹配该歌曲"); return; }
  matchingAll.value = true;
  try {
    const res = await api.post(`/rest/api/v1/online/${pid}/match-track`, { entryId: song.entryId });
    if (res.data?.success && res.data.songId) {
      ElMessage.success(`已匹配「${song.title}」`);
      await loadPlaylist();
      const updated = songs.value.find(s => s.id === res.data.songId);
      if (updated) playerStore.playSong(updated);
    } else {
      ElMessage.warning(`未匹配「${song.title}」: ${res.data?.message || "未找到可靠结果"}`);
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "匹配失败");
  } finally { matchingAll.value = false; }
}

// Auto-match a batch of unmatched tracks before queueing them for playback.
async function matchBeforePlay(unmatched: any[]) {
  const pid = onlineSourceId.value;
  if (!pid) return [];
  const ok: any[] = [];
  for (const song of unmatched) {
    if (!song.entryId) continue;
    try {
      const res = await api.post(`/rest/api/v1/online/${pid}/match-track`, { entryId: song.entryId });
      if (res.data?.success && res.data.songId) {
        const updated = songs.value.find(s => s.id === res.data.songId) || { ...song, id: res.data.songId, playable: true, isMatched: true };
        ok.push(updated);
      }
    } catch {}
  }
  if (ok.length > 0) await loadPlaylist();
  return ok;
}

// Batch-match all unmatched tracks of this playlist as a background job, with progress.
async function matchAllPlaylist() {
  const pid = onlineSourceId.value;
  if (!pid) return;
  showMatchDialog.value = true;
  matchRunning.value = true;
  matchResult.value = null;
  matchDone.value = 0;
  matchingAll.value = true;
  try {
    const res = await api.post(`/rest/api/v1/online/${pid}/match-playlist`, { playlistId: route.params.id });
    if (res.data?.success) {
      if (res.data.jobId) {
        matchTotal.value = res.data.progress?.total || 0;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        const poll = async () => {
          if (matchPollCancelled) return;
          try {
            const s = await api.get(`/rest/api/v1/online/${pid}/match-playlist/status`, { params: { jobId: res.data.jobId } });
            if (matchPollCancelled) return;
            if (s.data?.progress) matchDone.value = s.data.progress.done || 0;
            if (s.data?.status === "completed" || s.data?.status === "failed") {
              matchRunning.value = false;
              matchResult.value = s.data.result || { matched: 0, noMatch: 0, error: 0 };
              if (s.data.error) ElMessage.warning(s.data.error);
              return;
            }
          } catch { /* keep polling */ }
          if (matchPollCancelled) return;
          pollTimer = setTimeout(poll, 2000);
        };
        matchPollCancelled = false;
        poll();
      } else {
        matchTotal.value = res.data.total || 0;
        matchDone.value = matchTotal.value;
        matchResult.value = res.data;
        matchRunning.value = false;
      }
    } else {
      matchRunning.value = false;
      ElMessage.warning(res.data?.error || "在线源未配置或未启用");
    }
  } catch (e: any) {
    matchRunning.value = false;
    ElMessage.error(e.response?.data?.error || "匹配启动失败");
  } finally { matchingAll.value = false; }
}
const matchPercent = computed(() => (matchTotal.value > 0 ? Math.min(100, Math.round((matchDone.value / matchTotal.value) * 100)) : 0));
async function closeMatchAndReload() {
  showMatchDialog.value = false;
  await loadPlaylist();
  ElMessage.success("匹配完成,未匹配歌曲已刷新");
}
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

async function loadOnlineSource() {
  if (onlineSourceId.value) return;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    // /v1/plugins 返回的 manifest / config 是 JSON 字符串,须解析后再判断。
    // (此前直接 p.manifest?.type === "source" → 字符串取属性恒 undefined,
    //  导致永远找不到在线源 → 播放外部条目提示「未配置在线源」)
    const source = (res.data || []).find((p: any) => {
      const cfg = parseConfig(p);
      const mf = parseManifest(p);
      return p.enabled && cfg.baseUrl && mf.type === "source";
    });
    if (source) onlineSourceId.value = source.id;
  } catch { onlineSourceId.value = ""; }
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
    loadOnlineSource();
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

// Convert a daily-recommend imported playlist into a permanent local playlist.
async function convertToLocal() {
  await ElMessageBox.confirm(
    `确定将「${playlist.value?.name}」转成本地永久歌单？转换后将不再作为每日推荐被轮换,但歌曲内容保持不变。`,
    "转成本地歌单",
    { type: "warning", confirmButtonText: "转换", cancelButtonText: "取消" },
  );
  try {
    const res = await api.post(`/rest/api/v1/playlists/${route.params.id}/convert-to-local`);
    if (res.data.success) {
      ElMessage.success(`「${playlist.value?.name}」已转为本地永久歌单`);
      loadPlaylist();
    } else {
      ElMessage.error(res.data.error || "转换失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "转换失败");
  }
}

async function toggleSyncEnabled(val: string | number | boolean) {
  const v = Boolean(val);
  try {
    await api.put(`/rest/api/v1/playlists/${route.params.id}`, { syncEnabled: v });
    ElMessage.success(v ? "已启用自动同步" : "已关闭自动同步");
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "操作失败"); }
}

async function togglePublic(val: string | number | boolean) {
  const v = Boolean(val);
  try {
    await api.put(`/rest/api/v1/playlists/${route.params.id}`, { isPublic: v });
    ElMessage.success(v ? "歌单已设为公开" : "歌单已设为私有");
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

// Cancel any in-flight match-progress poll when the page is left. Without this,
// the recursive setTimeout keeps issuing /match-playlist/status requests after
// the component has been unmounted.
let matchPollCancelled = false;
onUnmounted(() => { matchPollCancelled = true; });
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
.match-progress { padding: 8px 0; }
.match-hint { color: var(--fnos-text-secondary); font-size: 13px; line-height: 1.8; }
.match-result { color: var(--fnos-green); font-size: 14px; line-height: 1.8; }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }

@media (max-width: 768px) {
  .playlist-detail { padding: 20px 16px; }
  .playlist-header { flex-direction: column; align-items: center; text-align: center; gap: 16px; }
  .playlist-header .playlist-cover { width: 160px; height: 160px; }
  .playlist-header .playlist-meta .actions { justify-content: center; }
}
</style>