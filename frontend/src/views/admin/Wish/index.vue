<template>
  <div class="admin-wish">
    <div class="page-header">
      <h2>未命中音乐</h2>
      <div class="header-actions">
        <el-button :loading="loadingChunks" @click="openWishList"><MfIcon name="Copy" />未命中音乐列表</el-button>
        <el-input v-model="searchQuery" placeholder="搜索未命中音乐..." prefix-icon="Search" clearable style="width: 260px" @input="onSearchInput" @clear="onSearchClear" />
      </div>
    </div>
    <template v-if="wishes.length > 0">
      <el-table v-if="!isMobile" :data="wishes" stripe v-loading="loading">
        <el-table-column type="index" width="60" label="#" :index="indexMethod" />
        <el-table-column prop="songTitle" label="歌曲" min-width="200" />
        <el-table-column prop="artist" label="艺术家" width="150" />
        <el-table-column prop="album" label="专辑" width="150" />
        <el-table-column prop="notes" label="来源" width="180" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'fulfilled' ? 'success' : row.status === 'pending' ? 'warning' : 'info'" size="small">
              {{ row.status === 'fulfilled' ? '已实现' : row.status === 'pending' ? '未适配' : row.status }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <!-- 移动端卡片列表 -->
      <div v-else class="wish-cards">
        <div v-for="(row, i) in wishes" :key="row.id ?? i" class="wish-card">
          <div class="wc-index">{{ indexMethod(i) }}</div>
          <div class="wc-main">
            <div class="m-title">{{ row.songTitle }}</div>
            <div class="m-sub">{{ row.artist }} · {{ row.album }}</div>
            <div class="m-sub">{{ row.notes }}</div>
          </div>
          <el-tag :type="row.status === 'fulfilled' ? 'success' : row.status === 'pending' ? 'warning' : 'info'" size="small">
            {{ row.status === 'fulfilled' ? '已实现' : row.status === 'pending' ? '未适配' : row.status }}
          </el-tag>
        </div>
      </div>
    </template>
    <EmptyState v-else icon="box" title="暂无未命中音乐" description="导入外部歌单时未匹配的歌曲会出现在这里" compact />
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

    <!-- Wish list dialog: split into copyable chunks (<= 1000 chars) -->
    <el-dialog v-model="showListDialog" title="未命中音乐列表" width="620px">
      <div class="wish-list-info" v-if="totalWishes > 0">
        共 {{ totalWishes }} 首未命中音乐,已分成 {{ chunks.length }} 段(每段不超过 1000 字符)
      </div>
      <div class="wish-chunks" v-loading="loadingChunks">
        <div
          v-for="(chunk, idx) in chunks"
          :key="idx"
          class="wish-chunk-item"
        >
          <el-button
            type="primary"
            plain
            class="wish-chunk-btn"
            :class="{ copied: copiedIdx === idx }"
            @click="copyChunk(idx)"
          >
            <MfIcon name="Copy" />
            {{ chunk.label }}（{{ chunk.end - chunk.start + 1 }}首）
          </el-button>
          <span v-if="copiedIdx === idx" class="copied-tip">已复制</span>
        </div>
        <div v-if="chunks.length === 0 && !loadingChunks" class="wish-empty">暂无未命中音乐</div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api from "@/api";
import { useIsMobile } from "@/composables/useIsMobile";

const wishes = ref<any[]>([]);
const loading = ref(false);
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("wishPageSize") || "20"));
if (![15, 20, 50, 100].includes(pageSize.value)) pageSize.value = 20;
const searchQuery = ref("");

// 移动端(≤768)把 el-table 切换为卡片列表,避免横向滚动(见 frontend-responsive CI 守卫)。
const isMobile = useIsMobile();

// Wish list dialog: chunked copy
const showListDialog = ref(false);
const loadingChunks = ref(false);
const chunks = ref<{ label: string; start: number; end: number; text: string }[]>([]);
const totalWishes = ref(0);
const copiedIdx = ref(-1);
const CHUNK_MAX_CHARS = 1000;

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function indexMethod(index: number) { return (currentPage.value - 1) * pageSize.value + index + 1; }

// Open the wish list dialog, fetch all wishes and split into copyable chunks
async function openWishList() {
  showListDialog.value = true;
  loadingChunks.value = true;
  copiedIdx.value = -1;
  try {
    const res = await api.get("/rest/api/v1/wish/export");
    const text = res.data.text || "";
    const lines = text.split("\n").filter(Boolean);
    totalWishes.value = lines.length;
    chunks.value = splitChunks(lines);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "加载未命中音乐列表失败");
    chunks.value = [];
  } finally {
    loadingChunks.value = false;
  }
}

// Split lines into chunks where each chunk's text <= 1000 chars (lines are never split)
function splitChunks(lines: string[]): { label: string; start: number; end: number; text: string }[] {
  const result: { label: string; start: number; end: number; text: string }[] = [];
  let startLine = 0;
  let current: string[] = [];
  let currentLen = 0;
  const newlineLen = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + newlineLen;
    if (currentLen + lineLen > CHUNK_MAX_CHARS && current.length > 0) {
      result.push({
        label: `${startLine + 1}-${i}首`,
        start: startLine,
        end: i - 1,
        text: current.join("\n"),
      });
      startLine = i;
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) {
    result.push({
      label: `${startLine + 1}-${lines.length}首`,
      start: startLine,
      end: lines.length - 1,
      text: current.join("\n"),
    });
  }
  return result;
}

// Copy a specific chunk's text to clipboard
async function copyChunk(idx: number) {
  const chunk = chunks.value[idx];
  if (!chunk) return;
  try {
    await copyText(chunk.text);
    copiedIdx.value = idx;
    ElMessage.success(`已复制 ${chunk.label}(${chunk.end - chunk.start + 1}首)到剪贴板`);
    setTimeout(() => { if (copiedIdx.value === idx) copiedIdx.value = -1; }, 2000);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "复制失败");
  }
}

// Clipboard helper with fallback for non-secure contexts
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

async function loadWishes() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/wish", {
      params: { page: currentPage.value, pageSize: pageSize.value, query: searchQuery.value },
    });
    wishes.value = res.data.items || [];
    total.value = res.data.total || 0;
  }
  catch { wishes.value = []; total.value = 0; }
  finally { loading.value = false; }
}

function onPageChange(page: number) { currentPage.value = page; loadWishes(); }

function onSizeChange(size: number) {
  pageSize.value = size;
  localStorage.setItem("wishPageSize", String(size));
  currentPage.value = 1;
  loadWishes();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadWishes(); }, 300);
}

function onSearchClear() { currentPage.value = 1; loadWishes(); }

onMounted(loadWishes);
</script>

<style lang="scss" scoped>
.admin-wish { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } }
.pagination-bar { margin-top: 20px; display: flex; justify-content: center; }
.wish-list-info { font-size: 13px; color: var(--fnos-text-tertiary); margin-bottom: 12px; }
.wish-chunks { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; max-height: 420px; overflow-y: auto; padding: 4px; }
.wish-chunk-item { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.wish-chunk-btn { width: 100%; margin: 0 !important; }
.wish-chunk-btn.copied { border-color: var(--fnos-green); color: var(--fnos-green); }
.copied-tip { font-size: 12px; color: var(--fnos-green); }
.wish-empty { grid-column: 1 / -1; text-align: center; color: var(--fnos-text-muted); padding: 30px 0; font-size: 13px; }
/* 移动端卡片列表(替代 el-table) */
.wish-cards { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
.wish-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--fnos-radius-lg);
  padding: 10px 12px;
}
.wc-index { flex: 0 0 22px; text-align: center; font-size: 12px; color: var(--fnos-text-tertiary); }
.wc-main { flex: 1; min-width: 0; }
@media (max-width: 768px) {
  .admin-wish { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .header-actions .el-input { width: 100% !important; }
  .header-actions { width: 100%; }
}
</style>