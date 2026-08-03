<template>
  <div class="artists-page">
    <div class="page-header">
      <h2>艺术家</h2>
      <div class="header-actions">
        <div class="scrape-status" v-if="scrapeProgress">
          <el-tag :type="scrapeRunning ? 'warning' : 'success'" size="small" class="scrape-tag">
            <template v-if="scrapeRunning">
              <span class="scrape-spin"><el-icon class="is-loading"><Loading /></el-icon></span>
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
          <el-button :loading="scraping" @click="scrapeArtists"><el-icon><MagicStick /></el-icon>刮削歌手头像</el-button>
        </el-tooltip>
        <el-tooltip content="重新刮削缺失歌手信息的歌手(平台有信息则更新为真实头像)" placement="top">
          <el-button :loading="scrapingMissing" :badge="missingCount" @click="scrapeMissingArtists">
            <el-icon><RefreshLeft /></el-icon>仅刮削缺失歌手信息<template v-if="missingCount > 0">({{ missingCount }})</template>
          </el-button>
        </el-tooltip>
        <el-input v-model="searchQuery" placeholder="搜索艺术家..." prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
      </div>
    </div>
    <div class="artist-grid" v-loading="loading">
      <div class="artist-card" v-for="artist in artists" :key="artist.id" @click="router.push(`/artists/${artist.id}`)">
        <div class="artist-avatar">
          <img v-if="artist.coverArt" :src="`/rest/getCoverArt?id=${artist.coverArt}&size=300`" />
          <div v-else class="avatar-placeholder"><el-icon :size="48"><User /></el-icon></div>
          <el-tooltip v-if="artist.scrapeMissing" content="缺失歌手信息(当前为专辑封面兜底)" placement="top">
            <el-tag size="small" type="warning" class="missing-tag">缺信息</el-tag>
          </el-tooltip>
        </div>
        <div class="artist-name">{{ artist.name }}</div>
        <div class="artist-meta">{{ artist.albumCount }}张专辑</div>
      </div>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { User, MagicStick, RefreshLeft, Loading } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const router = useRouter();
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

function onPageChange(page: number) { currentPage.value = page; loadArtists(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("artistsPageSize", String(size));
  currentPage.value = 1;
  loadArtists();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadArtists(); }, 300);
}

function onSearchClear() { currentPage.value = 1; loadArtists(); }

onMounted(() => { loadArtists(); loadMissingCount(); checkScrapeStatus(); });
</script>

<style lang="scss" scoped>
.artists-page { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } .header-actions { display: flex; align-items: center; gap: 10px; } }
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; }
.artist-card { cursor: pointer; text-align: center; padding: 16px; border-radius: 8px; transition: background 0.2s;
  &:hover { background: #f5f5f5; }
  .artist-avatar { position: relative; width: 120px; height: 120px; border-radius: 50%; overflow: hidden; margin: 0 auto 12px;
    img { width: 100%; height: 100%; object-fit: cover; }
    .avatar-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; border-radius: 50%; }
    .missing-tag { position: absolute; top: 4px; right: 4px; }
  }
  .artist-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artist-meta { font-size: 12px; color: #999; margin-top: 4px; }
}
.pagination-bar { margin-top: 24px; display: flex; justify-content: center; }
</style>