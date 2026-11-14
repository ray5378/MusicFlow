<template>
  <div class="study-pl-page">
    <div class="page-header">
      <div class="page-title">
        <el-button text class="back-btn" @click="$router.push('/study')">
          <MfIcon name="ArrowLeft" :size="18" />
        </el-button>
        <div>
          <h2>{{ name || t("study.playlist") }}</h2>
          <span class="sub">{{ t("study.trackCount", { count: items.length }) }}</span>
        </div>
      </div>
      <div class="header-actions">
        <el-button :disabled="items.length === 0" :loading="exporting" @click="exportPlaylist">
          <MfIcon name="Download" :size="16" />{{ t("study.exportPlaylist") }}
        </el-button>
        <el-button type="primary" :disabled="items.length === 0" :loading="loading" @click="playAll">
          <MfIcon name="Play" :size="16" />{{ t("music.playAll") }}
        </el-button>
      </div>
    </div>

    <div v-loading="loading" class="pane">
      <div v-if="!loading && items.length === 0" class="empty">
        <MfIcon name="ListMusic" :size="36" />
        <p>{{ t("study.playlistEmpty") }}</p>
      </div>
      <div v-else class="study-list">
        <div
          v-for="(s, i) in items"
          :key="(s.entryId || s.id) + '-' + i"
          class="study-row"
          @click="onRowClick(i)"
          @contextmenu="openContextMenu($event, trackMenuActions(s, i), s.fileName || s.title, s.relDir || '')"
          v-longpress="() => openActionSheet(trackMenuActions(s, i), s.fileName || s.title, s.relDir || '')"
        >
          <span class="row-play" :title="t('layout.play')" @click.stop="playAt(i)">
            <MfIcon name="Play" :size="14" />
          </span>
          <span class="row-title">{{ s.fileName || s.title }}</span>
          <span class="row-dir" :title="s.relDir || s.album || ''">{{ s.relDir || s.album || "—" }}</span>
          <span class="row-dur">{{ fmtTime(s.duration) }}</span>
          <span class="row-actions" @click.stop>
            <span class="row-btn" :title="t('songTable.moreActions')" @click="openContextMenu($event, trackMenuActions(s, i), s.fileName || s.title, s.relDir || '')">
              <MfIcon name="MoreHorizontal" :size="15" />
            </span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { Play, ListMusic, Info, Trash2 } from "lucide-vue-next";
import api from "@/api";
import { usePlayerStore } from "@/stores/player";
import { useItemActions, type MenuAction } from "@/composables/useItemActions";
import {
  type StudySong,
  fetchStudyPlaylistTracks,
  removeStudyPlaylistTracks,
} from "@/api/study";

const { t } = useI18n();
const route = useRoute();
const playerStore = usePlayerStore();
const { openContextMenu, openActionSheet, menuGuard, openSongInfo } = useItemActions();

const playlistId = String(route.params.id || "");
const name = ref("");
const items = ref<StudySong[]>([]);
const loading = ref(false);
const exporting = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await fetchStudyPlaylistTracks(playlistId);
    name.value = res.name;
    items.value = res.items;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.loadFailed"));
  } finally {
    loading.value = false;
  }
}

function playAll() {
  if (!items.value.length) return;
  playerStore.playQueue([...items.value], 0);
}
async function exportPlaylist() {
  if (!playlistId) return;
  exporting.value = true;
  try {
    const res = await api.get(`/rest/api/v1/study/playlists/${encodeURIComponent(playlistId)}/export`, { responseType: "blob" });
    const url = URL.createObjectURL(new Blob([res.data], { type: "application/json" }));
    const cd = (res.headers["content-disposition"] as string) || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const a = document.createElement("a");
    a.href = url;
    a.download = m ? decodeURIComponent(m[1]) : `${name.value || t("study.playlist")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    ElMessage.error(t("study.exportFailed"));
  } finally {
    exporting.value = false;
  }
}
function playAt(index: number) {
  const s = items.value[index];
  if (!s) return;
  playerStore.playQueue([...items.value], index);
  if ((s as any).positionSec > 3) {
    const target = (s as any).positionSec as number;
    setTimeout(() => playerStore.seek(target), 400);
  }
}
function onRowClick(index: number) {
  if (menuGuard()) return;
  playAt(index);
}
function trackMenuActions(s: StudySong, index: number): MenuAction[] {
  return [
    { label: t("layout.play"), icon: Play, onClick: () => playAt(index) },
    {
      label: t("actions.addToQueue"),
      icon: ListMusic,
      onClick: () => {
        playerStore.addToQueue(s);
        ElMessage.success(t("actions.addedToQueue"));
      },
    },
    { divider: true },
    { label: t("actions.songInfo"), icon: Info, onClick: () => openSongInfo(s) },
    { label: t("playlists.removeSong"), icon: Trash2, danger: true, onClick: () => removeAt(index) },
  ];
}
async function removeAt(index: number) {
  const s = items.value[index];
  if (!s) return;
  try {
    await removeStudyPlaylistTracks(playlistId, [s.id]);
    items.value.splice(index, 1);
    ElMessage.success(t("study.removedFromPlaylist"));
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  }
}

function fmtTime(sec?: number) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

onMounted(load);
</script>

<style lang="scss" scoped>
.study-pl-page { padding: 32px 36px 210px; max-width: 1200px; margin: 0 auto; }
.page-header {
  display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 22px;
  .page-title { display: flex; align-items: center; gap: 10px; min-width: 0;
    h2 { font-size: 28px; font-weight: 700; margin: 0; color: var(--fnos-text-primary); }
    .sub { font-size: 13px; color: var(--fnos-text-tertiary); }
  }
  .back-btn { flex-shrink: 0; }
  .header-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
}
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 0; color: var(--fnos-text-tertiary); font-size: 13px; }
.study-list { display: flex; flex-direction: column; gap: 2px; }
.study-row {
  display: grid; grid-template-columns: 40px minmax(0, 1fr) 180px 80px 60px;
  align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; cursor: pointer;
  transition: background 0.18s ease;
  &:hover { background: rgba(255, 255, 255, 0.07); }
  .row-play {
    width: 24px; height: 24px; border-radius: 50%; margin: 0 auto; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(255, 255, 255, 0.08); color: var(--fnos-text-secondary);
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
    /* 与学习内容列表一致:悬停二次高亮,明确此处可点击播放。 */
    &:hover {
      background: #409eff; color: #fff; transform: scale(1.12);
      box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.25);
    }
  }
  .row-title { font-size: 14px; color: var(--fnos-text-primary); line-height: 1.35; overflow-wrap: anywhere; }
  .row-dir { font-size: 12px; color: var(--fnos-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-dur { font-size: 12px; color: var(--fnos-text-tertiary); text-align: right; }
  .row-actions { display: flex; justify-content: flex-end; }
}
.row-btn {
  width: 26px; height: 26px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--fnos-text-tertiary); cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.1); color: var(--fnos-text-primary); }
}
/* 播放控制复用全局播放条:学习歌单页不再单独做播放器 */
@media (max-width: 900px) {
  .study-pl-page { padding: 20px 16px 220px; }
  .study-row { grid-template-columns: 30px minmax(0, 1fr) 60px; .row-dir, .row-dur { display: none; } }
}
</style>
