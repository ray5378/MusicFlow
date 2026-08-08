<template>
  <div class="artists-page">
    <div class="page-header">
      <h2>艺术家</h2>
      <div class="header-actions">
        <div class="scrape-status" v-if="scrapeProgress">
          <el-tag :type="scrapeRunning ? 'warning' : 'success'" size="small" class="scrape-tag">
            <template v-if="scrapeRunning">
              <span class="scrape-spin"><MfIcon name="Loader2" class="is-loading"  spin /></span>
              刮削中 {{ scrapeProgress.processed }}/{{ scrapeProgress.total }}
              <span v-if="scrapeProgress.current">({{ scrapeProgress.current }})</span>
              · 成功 {{ scrapeProgress.scraped }} · 专辑兜底 {{ scrapeProgress.fallback }} · 跳过 {{ scrapeProgress.skipped }}
            </template>
            <template v-else>
              刮削完成: 成功 {{ scrapeProgress.scraped }} · 专辑兜底 {{ scrapeProgress.fallback }} · 跳过 {{ scrapeProgress.skipped }}
            </template>
          </el-tag>
        </div>
        <el-tooltip content="为缺少头像的歌手刮削头像(优先 QQ 音乐,其次网易云)" placement="top">
          <el-button :loading="scraping" @click="scrapeArtists"><MfIcon name="Wand2" />刮削歌手头像</el-button>
        </el-tooltip>
        <el-tooltip content="重新刮削缺失歌手信息的歌手(平台有信息则更新为真实头像)" placement="top">
          <el-button :loading="scrapingMissing" :badge="missingCount" @click="scrapeMissingArtists">
            <MfIcon name="RotateCcw" />仅刮削缺失歌手信息<template v-if="missingCount > 0">({{ missingCount }})</template>
          </el-button>
        </el-tooltip>
        <el-input v-model="searchQuery" placeholder="搜索艺术家..." prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
      </div>
    </div>
    <div class="artist-grid" v-loading="loading">
      <div
        class="artist-card"
        v-for="artist in artists"
        :key="artist.id"
        @contextmenu="openContextMenu($event, artistActions(artist), artist.name, formatAlbumCount(artist.albumCount))"
        v-longpress="() => openActionSheet(artistActions(artist), artist.name, formatAlbumCount(artist.albumCount))"
      >
        <div class="artist-avatar mf-coverwrap" @click="open(artist)">
          <img v-if="artist.coverArt" :src="`/rest/getCoverArt?id=${artist.coverArt}&size=300`" loading="lazy" decoding="async" />
          <div v-else class="avatar-placeholder"><MfIcon name="User" :size="48"  /></div>
          <el-tooltip v-if="artist.scrapeMissing" content="缺失歌手信息(当前为专辑封面兜底)" placement="top">
            <el-tag size="small" type="warning" class="missing-tag">缺信息</el-tag>
          </el-tooltip>
          <CoverPlay size="md" :label="`播放 ${artist.name} 的歌曲`" :action="() => playAr(artist)" />
        </div>
        <div class="artist-name" @click="open(artist)">{{ artist.name }}</div>
        <div class="artist-meta" @click="open(artist)">{{ formatAlbumCount(artist.albumCount) }}</div>
      </div>
    </div>
    <div class="pagination-bar">
      <PagePagination :total="total" :page="currentPage" :page-size="pageSize" storage-key="artistsPageSize" @change="onPageChange" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import PagePagination from "@/components/PagePagination.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";
import api from "@/api";

const router = useRouter();
const { openContextMenu, openActionSheet, menuGuard, artistActions } = useItemActions();
const play = usePlayContent();

function open(artist: any) {
  if (menuGuard()) return;
  router.push(`/artists/${artist.id}`);
}
async function playAr(artist: any) {
  if (menuGuard()) return;
  const n = await play.playArtist(artist.id);
  if (n) ElMessage.success(`正在播放「${artist.name}」的 ${n} 首歌曲`);
  else ElMessage.warning("该艺人暂无可播放歌曲");
}
const artists = ref<any[]>([]);
const loading = ref(false);
const scraping = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("artistsPageSize") || "25"));
if (![15, 25, 50, 100].includes(pageSize.value)) pageSize.value = 25;

// Scrape progress polling
const scrapeProgress = ref<any>(null);
const scrapeRunning = computed(() => scrapeProgress.value?.status === "running");
let scrapeTimer: ReturnType<typeof setInterval> | null = null;

const scrapingMissing = ref(false);
const missingCount = ref(0);

let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function loadArtists() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/artists", {
      params: { page: currentPage.value, pageSize: pageSize.value, query: searchQuery.value },
    });
    artists.value = res.data.items || [];
    total.value = res.data.total || 0;
  } catch { artists.value = []; total.value = 0; }
  finally { loading.value = false; }
}

// Count of artists marked missing-info (shown on the "仅刮削缺失" button)
async function loadMissingCount() {
  try {
    const res = await api.get("/rest/api/v1/artists/missing-info-count");
    missingCount.value = res.data.count || 0;
  } catch { missingCount.value = 0; }
}

// Check scrape job status periodically while running
async function checkScrapeStatus() {
  try {
    const res = await api.get("/rest/api/v1/artists/scrape-status");
    const data = res.data;
    scrapeProgress.value = data;
    if (data.status === "running") {
      if (!scrapeTimer) {
        scrapeTimer = setInterval(checkScrapeStatus, 1500);
      }
    } else {
      if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
      if (data.status === "done" && data.progress) {
        const p = data.progress;
        if (p.status === "done" && p.total > 0) {
          ElMessage.success(`刮削完成: 成功 ${p.scraped},专辑兜底 ${p.fallback},跳过 ${p.skipped}`);
          loadArtists();
          loadMissingCount();
        }
      }
    }
  } catch { /* ignore */ }
}

// Manually trigger full scrape for all artists missing avatars (QQ first, NetEase fallback)
async function scrapeArtists() {
  scraping.value = true;
  try {
    const res = await api.post("/rest/api/v1/artists/scrape", {});
    if (res.data.success) {
      if (res.data.total === 0) {
        ElMessage.info("所有歌手已有头像,无需刮削");
        scrapeProgress.value = { status: "done", progress: { status: "done", total: 0, scraped: 0, fallback: 0, skipped: 0 } };
      } else {
        ElMessage.info(`开始刮削 ${res.data.total} 位歌手...`);
        scrapeProgress.value = { status: "running", progress: { status: "running", total: res.data.total, processed: 0, scraped: 0, fallback: 0, skipped: 0 } };
        checkScrapeStatus();
      }
    } else {
      ElMessage.error(res.data.error || "刮削失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "刮削失败");
  } finally {
    scraping.value = false;
  }
}

// Retry scraping ONLY artists marked as missing-info (replace fallback cover with real avatar when found)
async function scrapeMissingArtists() {
  scrapingMissing.value = true;
  try {
    const res = await api.post("/rest/api/v1/artists/scrape-missing", {});
    if (res.data.success) {
      if (res.data.total === 0) {
        ElMessage.info("没有缺失歌手信息的歌手");
      } else {
        ElMessage.info(`开始刮削 ${res.data.total} 位缺失歌手信息的歌手...`);
        scrapeProgress.value = { status: "running", progress: { status: "running", total: res.data.total, processed: 0, scraped: 0, fallback: 0, skipped: 0 } };
        checkScrapeStatus();
      }
    } else {
      ElMessage.error(res.data.error || "刮削失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "刮削失败");
  } finally {
    scrapingMissing.value = false;
  }
}

function onPageChange(page: number, size?: number) {
  currentPage.value = page;
  if (size) pageSize.value = size;
  loadArtists();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadArtists(); }, 300);
}

function onSearchClear() { currentPage.value = 1; loadArtists(); }

function formatAlbumCount(n: number) {
  if (!n || n <= 0) return '';
  if (n === 1) return '1 张专辑';
  return `${n} 张专辑`;
}

onMounted(() => { loadArtists(); loadMissingCount(); checkScrapeStatus(); });

// Stop the scrape-progress poll when leaving the page so the 1.5s interval
// doesn't keep running (and issuing requests) in the background.
onUnmounted(() => {
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
});
</script>

<style lang="scss" scoped>
.artists-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; }
  .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
}
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 18px; }
.artist-card {
  cursor: pointer; text-align: center; padding: 16px 12px;
  border-radius: var(--fnos-radius-lg);
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  animation: home-card-in 0.45s ease backwards;  /* backwards: 动画结束后回退到元素常态（无 transform 残留），both 会保持 translateY(0) 终态形成永久 stacking context，旧 Chromium 上可能穿透 fixed 弹窗 */
  &:hover {
    transform: translateY(-5px);
    background: rgba(255,255,255,0.08);
    box-shadow: 0 14px 34px rgba(0,0,0,0.4);
  }
  &:active { transform: translateY(-2px) scale(0.98); }
  .artist-avatar { position: relative; width: 120px; height: 120px; border-radius: 50%; overflow: hidden; margin: 0 auto 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.45s ease; }
    .avatar-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); border-radius: 50%; }
    .missing-tag { position: absolute; top: 4px; right: 4px; }
  }
  &:hover .artist-avatar img { transform: scale(1.06); }
  .artist-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); transition: color 0.18s ease; }
  .artist-name:hover { color: var(--fnos-red); }
  .artist-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 5px; min-height: 16px; }
}
.pagination-bar { margin-top: 24px; display: flex; justify-content: center; }
@keyframes home-card-in {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (max-width: 768px) {
  .artists-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
  .header-actions { width: 100%; }
  .header-actions .el-input { width: 100% !important; flex: 1; }
  .artist-grid { grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .artist-card { padding: 12px 8px; }
  .artist-card .artist-avatar { width: 88px; height: 88px; }
  .artist-card .artist-name { font-size: 13px; }
}
</style>