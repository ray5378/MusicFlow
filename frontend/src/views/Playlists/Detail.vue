<template>
  <div class="playlist-detail" v-loading="loading">
    <div class="playlist-header" v-if="playlist">
      <div class="playlist-cover">
        <img v-if="playlist.coverArt" :src="coverUrl(playlist.coverArt, 300)" loading="lazy" decoding="async" />
        <div v-else class="cover-placeholder"><MfIcon name="List" :size="64"  /></div>
      </div>
      <div class="playlist-meta">
        <div class="label">{{ t('playlists.label') }}<el-tag v-if="playlist.sourcePlatform" size="small" style="margin-left: 8px">{{ platformLabel(playlist.sourcePlatform) }}</el-tag><el-tag v-if="playlist.isImported" size="small" type="warning" style="margin-left: 4px">{{ t('playlists.badgeImported') }}</el-tag><el-tag v-else-if="playlist.pluginSynced" size="small" type="info" style="margin-left: 4px">{{ t('playlists.badgePluginSynced') }}</el-tag></div>
        <h1>{{ playlist.name }}</h1>
        <div class="info">{{ t('playlists.songsCount', { count: playlist.songCount }) }} · {{ formatTotalDuration(playlist.duration) }}</div>
        <div class="info" v-if="playlist.isImported && playlist.matched !== undefined">
          <span class="matched-count">{{ t('playlists.matchedCount', { matched: playlist.matched, total: playlist.songCount }) }}</span>
        </div>
        <div class="info" v-if="playlist.isImported && playlist.created">{{ t('playlists.importedAt', { date: formatCreated(playlist.created) }) }}</div>
        <div class="actions">
          <el-button type="primary" @click="playAll">{{ t('playlists.playAll') }}</el-button>
          <el-button v-if="hasOnlineSource" :loading="matchingAll" @click="matchAllPlaylist"><MfIcon name="Search" />{{ t('playlists.matchUnmatchedBtn') }}</el-button>
          <el-button @click="exportPlaylist"><MfIcon name="Download" />{{ t('playlists.export') }}</el-button>
          <el-button @click="showRenameDialog = true"><MfIcon name="Pencil" />{{ t('playlists.rename') }}</el-button>
          <el-button v-if="playlist.isImported" :loading="syncing" @click="syncPlaylist"><MfIcon name="RefreshCw" />{{ t('playlists.sync') }}</el-button>
          <el-button v-else-if="playlist.pluginSynced" :loading="gmdlRefreshing" @click="refreshGmdlPlugin"><MfIcon name="RefreshCw" />{{ t('playlists.refresh') }}</el-button>
          <el-button v-if="playlist.isDaily" @click="convertToLocal"><MfIcon name="Pin" />{{ t('playlists.convertLocal') }}</el-button>
          <el-button @click="togglePool"><MfIcon name="Wand2" />{{ inPool ? t('playlists.removeFromPool') : t('playlists.addToPool') }}</el-button>
          <el-button type="danger" plain @click="deletePlaylist"><MfIcon name="Trash2" />{{ t('playlists.deletePlaylist') }}</el-button>
        </div>
        <div class="settings" v-if="playlist.isImported">
          <el-switch v-model="playlist.syncEnabled" @change="toggleSyncEnabled" />
          <span class="setting-label">{{ t('playlists.autoSyncLabel') }}</span>
          <el-switch v-model="playlist.public" @change="togglePublic" style="margin-left: 24px" />
          <span class="setting-label">{{ t('playlists.publicPlaylistLabel') }}</span>
        </div>
      </div>
    </div>
    <SongTable
      :songs="list"
      :selectable="!isMobile"
      :loading="loading"
      show-source
      allow-unmatched-play
      :extra-actions="playlistRowActions"
      :on-window="onWindow"
      @play="playSong"
      @select="onSelectionChange"
    >
      <template #row-actions="{ row }">
        <button class="row-btn" @click.stop="removeSong(row)" :title="t('playlists.removeSong')">
          <MfIcon name="Trash2" :size="16" />
        </button>
      </template>
    </SongTable>
    <div class="batch-bar" v-if="selectedSongs.length > 0">
      <span>{{ t('playlists.selectedCount', { count: selectedSongs.length }) }}</span>
      <el-button size="small" type="danger" plain @click="removeSelected">{{ t('playlists.batchRemove') }}</el-button>
      <el-button size="small" @click="playSelected">{{ t('playlists.playSelected') }}</el-button>
    </div>

    <el-dialog v-model="showRenameDialog" :title="t('playlists.renameDialogTitle')" width="400px" :append-to-body="true">
      <el-input v-model="newName" :placeholder="t('playlists.newNamePlaceholder')" @keyup.enter="renamePlaylist" />
      <template #footer>
        <el-button @click="showRenameDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="renamePlaylist">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showMatchDialog" :title="t('playlists.matchDialogTitle')" width="480px" :close-on-click-modal="false" :append-to-body="true">
      <div v-if="matchRunning" class="match-progress">
        <el-progress :percentage="matchPercent" />
        <p class="match-hint">{{ t('playlists.matchProgressA', { name: playlist?.name, total: matchTotal }) }}<br>{{ t('playlists.matchProgressB', { done: matchDone, total: matchTotal }) }}</p>
      </div>
      <div v-else-if="matchResult">
        <p class="match-result">{{ t('playlists.matchResultMsg', { matched: matchResult.matched, noMatch: matchResult.noMatch, error: matchResult.error }) }}</p>
      </div>
      <p v-else class="match-hint">{{ t('playlists.matchHintIntro') }}</p>
      <template #footer>
        <el-button @click="showMatchDialog = false" :disabled="matchRunning">{{ t('playlists.close') }}</el-button>
        <el-button v-if="matchResult" type="primary" @click="closeMatchAndReload">{{ t('playlists.done') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { usePlayerStore } from "@/stores/player";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";
import { waitAsyncTask } from "@/utils/asyncTask";
import { useIsMobile } from "@/composables/useIsMobile";
import SongTable from "@/components/SongTable.vue";
import { useInfiniteList } from "@/composables/useInfiniteList";
import { parseManifest, parseConfig } from "@/utils/plugin";
import { Trash2 } from "lucide-vue-next";
import { coverUrl } from "@/utils/cover";

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const { t } = useI18n();
const playlist = ref<any>(null);
// Whether this playlist is in the daily-recommend pool.
const inPool = ref(false);
const isMobile = useIsMobile();
const syncing = ref(false);
const showRenameDialog = ref(false);
const newName = ref("");
const selectedSongs = ref<any[]>([]);
const onlineSourceId = ref("");
const matchingAll = ref(false);
const showMatchDialog = ref(false);
const matchRunning = ref(false);
const matchTotal = ref(0);
const matchDone = ref(0);
const matchResult = ref<any>(null);
const hasOnlineSource = computed(() => !!onlineSourceId.value);

// 窗口化分块加载(与 HA 卡片同构):全曲目稀疏数组 + 视口窗口预取 + 越界剪枝。
// 分块 fetch 的同时把歌单头信息吸附到 playlist(首块响应即带 total/playlist 元数据)。
const { list, loading, total, init: reloadTracks, onWindow } = useInfiniteList<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get(`/rest/api/v1/playlists/${route.params.id}/tracks`, {
      params: { page, pageSize: size },
    });
    if (res.data?.playlist) {
      playlist.value = res.data.playlist;
      loadPoolStatus();
      loadOnlineSource();
    }
    return { items: res.data.items || [], total: res.data.total || 0 };
  },
  // chunk 需与后端 pageSize 上限(200)对齐。prefetchBlocks/concurrency 调大:
  // 预取跑道更长、并发更高,滚动更丝滑不卡骨架。
  { chunk: 200, keepRows: 300, prefetchBlocks: 2, concurrency: 3 }
);

function playlistRowActions(row: any) {
  return [
    {
      label: t("playlists.removeSong"),
      icon: Trash2,
      danger: true,
      onClick: () => removeSong(row),
    },
  ];
}
function platformLabel(p: string): string {
  return p === "qq" ? t("playlists.platform.qq") :
    p === "netease" ? t("playlists.platform.netease") :
    p === "kugou" ? t("playlists.platform.kugou") :
    p === "kuwo" ? t("playlists.platform.kuwo") :
    p === "soda" ? t("playlists.platform.soda") : "";
}
function formatTotalDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? t("playlists.duration.hm", { h, m }) : t("playlists.duration.h", { h });
  return t("playlists.duration.m", { m });
}
function formatCreated(t: string): string {
  if (!t) return "";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function playSong(song: any) {
  if (song.isMatched !== false) { playerStore.playSong(song); return; }
  await matchAndPlay(song);
}
async function playAll() {
  const loaded = list.value;
  const playable = loaded.filter(s => !!s && s.isMatched !== false);
  const unmatched = loaded.filter(s => !!s && s.isMatched === false);
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
  if (!pid || !song.entryId) { ElMessage.warning(t("playlists.noOnlineSourceTrack")); return; }
  matchingAll.value = true;
  try {
    const res = await api.post(`/rest/api/v1/online/${pid}/match-track`, { entryId: song.entryId });
    if (res.data?.success && res.data.songId) {
      ElMessage.success(t("playlists.matchedTrack", { title: song.title }));
      await reloadTracks();
      const updated = list.value.find(s => s && s.id === res.data.songId);
      if (updated) playerStore.playSong(updated);
    } else {
      ElMessage.warning(t("playlists.unmatchedTrack", { title: song.title, message: res.data?.message || t("playlists.noReliableResult") }));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("playlists.matchTrackFailed"));
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
        const updated = list.value.find(s => s && s.id === res.data.songId) || { ...song, id: res.data.songId, playable: true, isMatched: true };
        ok.push(updated);
      }
    } catch {}
  }
  if (ok.length > 0) await reloadTracks();
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
      ElMessage.warning(res.data?.error || t("playlists.onlineSourceUnavailable"));
    }
  } catch (e: any) {
    matchRunning.value = false;
    ElMessage.error(e.response?.data?.error || t("playlists.matchStartFailed"));
  } finally { matchingAll.value = false; }
}
const matchPercent = computed(() => (matchTotal.value > 0 ? Math.min(100, Math.round((matchDone.value / matchTotal.value) * 100)) : 0));
async function closeMatchAndReload() {
  showMatchDialog.value = false;
  await loadPlaylist();
  ElMessage.success(t("playlists.matchDoneReload"));
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
    ElMessage.error(e.response?.data?.message || t("playlists.exportFailed"));
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

function loadPlaylist() { return reloadTracks(); }

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
      ElMessage.success(t("playlists.removedFromPool", { name: playlist.value.name }));
    } else {
      const res = await api.post(`/rest/api/v1/recommend-pool/playlist/${playlist.value.id}`);
      inPool.value = true;
      ElMessage.success(res.data.message || t("playlists.addedToPool", { name: playlist.value.name }));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

async function syncPlaylist() {
  syncing.value = true;
  try {
    const res = await api.post(`/rest/api/v1/playlists/${route.params.id}/sync`);
    if (res.data?.alreadyRunning) {
      ElMessage.warning(t("playlists.syncingPlaylist"));
    } else if (res.data.success && res.data.taskId) {
      // 异步任务:轮询直到完成(手动同步已异步化,触发即返回 taskId)
      const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
      if (r?.total !== undefined) {
        ElMessage.success(t("playlists.syncComplete", { total: r.total, matched: r.matched, unmatched: r.unmatched }));
      } else {
        ElMessage.success(t("playlists.synced"));
      }
      loadPlaylist();
    } else {
      ElMessage.error(res.data.error || t("playlists.syncFailed"));
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e?.message || t("playlists.syncFailed"));
  } finally {
    syncing.value = false;
  }
}

// 插件同步歌单「刷新」:按歌单归属插件(sourcePluginId)精确刷新;旧数据回退 go-music-dl。
let gmdlPollCancelled = false;
let gmdlPollTimer: ReturnType<typeof setTimeout> | null = null;
const gmdlRefreshing = ref(false);
async function refreshGmdlPlugin() {
  if (gmdlRefreshing.value) return;
  const pluginId = playlist.value?.sourcePluginId || "go-music-dl";
  gmdlRefreshing.value = true;
  try {
    const res = await api.post("/rest/api/v1/recommend/refresh", { pluginId });
    if (res.data?.success) {
      ElMessage.success(res.data.alreadyRunning ? t("playlists.refreshRunning") : t("playlists.refreshStarted"));
      pollGmdlJob(pluginId);
    } else {
      ElMessage.error(res.data?.error || t("playlists.refreshStartFailed"));
      gmdlRefreshing.value = false;
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("playlists.refreshStartFailed"));
    gmdlRefreshing.value = false;
  }
}
function pollGmdlJob(pluginId: string) {
  const tick = async () => {
    if (gmdlPollCancelled) return;
    try {
      const res = await api.get(`/rest/api/v1/plugins/${pluginId}/job`);
      if (gmdlPollCancelled) return;
      if (res.data?.running) { gmdlPollTimer = setTimeout(tick, 2000); return; }
      const job = res.data?.job;
      gmdlRefreshing.value = false;
      if (job?.status === "ok") {
        const s = job.summary;
        ElMessage.success(typeof s === "string" && s ? s : t("playlists.refreshed"));
      } else if (job?.status === "error") {
        ElMessage.error(job.error || t("playlists.refreshFailed"));
      } else {
        ElMessage.info(t("playlists.refreshEnded"));
      }
      loadPlaylist();
    } catch {
      gmdlPollTimer = setTimeout(tick, 2000);
    }
  };
  tick();
}

// Convert a daily-recommend imported playlist into a permanent local playlist.
async function convertToLocal() {
  await ElMessageBox.confirm(
    t("playlists.convertConfirmTitle", { name: playlist.value?.name }),
    t("playlists.convertTitle"),
    { type: "warning", confirmButtonText: t("playlists.convertAction"), cancelButtonText: t("common.cancel") },
  );
  try {
    const res = await api.post(`/rest/api/v1/playlists/${route.params.id}/convert-to-local`);
    if (res.data.success) {
      ElMessage.success(t("playlists.converted", { name: playlist.value?.name }));
      loadPlaylist();
    } else {
      ElMessage.error(res.data.error || t("playlists.convertFailed"));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("playlists.convertFailed"));
  }
}

async function toggleSyncEnabled(val: string | number | boolean) {
  const v = Boolean(val);
  try {
    await api.put(`/rest/api/v1/playlists/${route.params.id}`, { syncEnabled: v });
    ElMessage.success(v ? t("playlists.autoSyncOn") : t("playlists.autoSyncOff"));
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("common.operationFailed")); }
}

async function togglePublic(val: string | number | boolean) {
  const v = Boolean(val);
  try {
    await api.put(`/rest/api/v1/playlists/${route.params.id}`, { isPublic: v });
    ElMessage.success(v ? t("playlists.publicSet") : t("playlists.privateSet"));
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("common.operationFailed")); }
}

async function removeSong(row: any) {
  await ElMessageBox.confirm(t("playlists.removeConfirmTitle", { name: row.title }), t("playlists.confirmRemove"), { type: "warning" });
  try {
    await api.post("/rest/updatePlaylist", { playlistId: route.params.id, songIdToRemove: row.id });
    ElMessage.success(t("playlists.removed"));
    loadPlaylist();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("playlists.removeFailed")); }
}

async function removeSelected() {
  try {
    for (const s of selectedSongs.value) {
      await api.post("/rest/updatePlaylist", { playlistId: route.params.id, songIdToRemove: s.id });
    }
    ElMessage.success(t("playlists.removedCount", { count: selectedSongs.value.length }));
    loadPlaylist();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("playlists.removeFailed")); }
}

async function renamePlaylist() {
  if (!newName.value) { ElMessage.warning(t("playlists.enterName")); return; }
  try {
    await api.post("/rest/updatePlaylist", { playlistId: route.params.id, name: newName.value });
    showRenameDialog.value = false;
    ElMessage.success(t("playlists.renamed"));
    loadPlaylist();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("playlists.renameFailed")); }
}

async function deletePlaylist() {
  await ElMessageBox.confirm(t("playlists.deleteConfirmTitle", { name: playlist.value?.name }), t("playlists.confirmDelete"), { type: "warning" });
  try {
    await api.post("/rest/deletePlaylist", { id: route.params.id });
    ElMessage.success(t("playlists.deleted"));
    router.push("/playlists");
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t("playlists.deleteFailed")); }
}

onMounted(() => {
  loadPlaylist();
  // 右键「从音乐库删除」成功后刷新歌单(删除的 web 歌曲会级联清出本歌单)
  window.addEventListener("mf:song-deleted", loadPlaylist);
});

// Cancel any in-flight match-progress poll when the page is left. Without this,
// the recursive setTimeout keeps issuing /match-playlist/status requests after
// the component has been unmounted.
let matchPollCancelled = false;
onUnmounted(() => {
  matchPollCancelled = true;
  gmdlPollCancelled = true;
  if (gmdlPollTimer) clearTimeout(gmdlPollTimer);
  window.removeEventListener("mf:song-deleted", loadPlaylist);
});
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

@media (max-width: 768px) {
  .playlist-detail { padding: 20px 16px; }
  .playlist-header { flex-direction: column; align-items: center; text-align: center; gap: 16px; }
  .playlist-header .playlist-cover { width: 160px; height: 160px; }
  .playlist-header .playlist-meta .actions { justify-content: center; }
}
</style>