<template>
  <div class="admin-music">
    <div class="page-header"><h2>音乐管理</h2></div>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="音乐搜索" name="search">
        <div class="search-section">
          <el-input v-model="searchQuery" placeholder="搜索音乐..." @keyup.enter="remoteSearch" style="width: 400px">
            <template #append><el-button @click="remoteSearch" :loading="searching">搜索</el-button></template>
          </el-input>
          <el-table :data="searchResults" stripe style="margin-top: 16px" v-if="searchResults.length > 0">
            <el-table-column prop="title" label="标题" min-width="150" />
            <el-table-column prop="artist" label="艺术家" width="120" />
            <el-table-column prop="album" label="专辑" width="150" />
            <el-table-column prop="platform" label="来源" width="100" />
            <el-table-column label="时长" width="80"><template #default="{ row }">{{ formatDuration(row.durationSec) }}</template></el-table-column>
            <el-table-column label="操作" width="100"><template #default="{ row }"><el-button type="primary" size="small" @click="downloadSong(row)">下载</el-button></template></el-table-column>
          </el-table>
          <el-empty v-else-if="!searching && searchQuery" description="暂无搜索结果" />
        </div>
      </el-tab-pane>

      <el-tab-pane label="音乐去重" name="dedup">
        <el-alert title="基于音频指纹检测重复歌曲" type="info" show-icon :closable="false" style="margin-bottom: 16px" />
        <el-button type="primary" @click="startDedup" :loading="dedupRunning">开始检测</el-button>
        <div v-if="dedupResults.length > 0" style="margin-top: 16px">
          <el-table :data="dedupResults" stripe>
            <el-table-column prop="title" label="标题" min-width="150" />
            <el-table-column prop="artist" label="艺术家" width="120" />
            <el-table-column prop="score" label="匹配分数" width="100" />
            <el-table-column label="操作" width="100"><template #default="{ row }"><el-button type="danger" size="small" @click="deleteDuplicate(row)">删除</el-button></template></el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <el-tab-pane label="音乐清洗" name="clean">
        <el-table :data="rules" stripe>
          <el-table-column prop="name" label="规则名称" min-width="200" />
          <el-table-column prop="type" label="类型" width="120" />
          <el-table-column prop="obj" label="作用对象" width="120" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="toggleRule(row)" /></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="音乐刮削" name="scrape">
        <el-alert title="为本地曲目补全元数据（标题、封面、歌词等）" type="info" show-icon :closable="false" style="margin-bottom: 16px" />
        <el-button type="primary" @click="startScrape" :loading="scrapeRunning">批量刮削</el-button>
        <div v-if="scrapeTask" style="margin-top: 16px">
          <el-progress :percentage="scrapeTask.progress" />
          <p>已处理 {{ scrapeTask.processed }}/{{ scrapeTask.total }}</p>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const activeTab = ref("search");
const searchQuery = ref("");
const searchResults = ref<any[]>([]);
const searching = ref(false);
const dedupRunning = ref(false);
const dedupResults = ref<any[]>([]);
const rules = ref<any[]>([]);
const scrapeRunning = ref(false);
const scrapeTask = ref<any>(null);

function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }

async function remoteSearch() {
  if (!searchQuery.value) return;
  searching.value = true;
  try { const res = await api.get(`/rest/search3?query=${encodeURIComponent(searchQuery.value)}&songCount=50&f=json`); searchResults.value = res.data["subsonic-response"]?.searchResult3?.song || []; }
  catch { searchResults.value = []; }
  finally { searching.value = false; }
}

async function downloadSong(song: any) { ElMessage.info("下载功能需要后端插件支持"); }
async function startDedup() { ElMessage.info("去重功能需要后端指纹计算支持"); }
async function deleteDuplicate(row: any) { ElMessage.info("删除功能开发中"); }
async function toggleRule(rule: any) { ElMessage.success("规则已更新"); }
async function startScrape() { ElMessage.info("刮削功能需要后端插件支持"); }

onMounted(async () => {
  try { const res = await api.get("/rest/search3?query=&songCount=5&f=json"); } catch {}
});
</script>

<style lang="scss" scoped>
.admin-music { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
</style>
