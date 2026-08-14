<template>
  <div class="playlists-page">
    <div class="page-header">
      <h2>歌单</h2>
      <el-input v-model="searchQuery" placeholder="搜索歌单..." prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
      <div class="header-actions">
        <el-dropdown trigger="click" @command="onFilterCommand">
          <el-button><MfIcon name="Library" />筛选歌单<el-icon class="el-icon--right"><MfIcon name="ChevronDown" /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="f in FILTERS" :key="f.key" :command="f.key">{{ f.label }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-popover placement="bottom-end" :width="200" trigger="click" v-model:visible="showManageMenu">
          <template #reference>
            <el-button type="primary"><MfIcon name="Settings" />歌单管理</el-button>
          </template>
          <div class="manage-menu">
            <div class="manage-item" @click="openManage('create')"><MfIcon name="Plus" />新建歌单</div>
            <div class="manage-item" @click="openManage('import')"><MfIcon name="Upload" />导入歌单</div>
            <div class="manage-item" @click="openManage('export')"><MfIcon name="Download" />导出全部歌单</div>
            <div class="manage-item" @click="openManage('sync')"><MfIcon name="RefreshCw" />同步所有平台</div>
            <div v-if="authStore.isAdmin" class="manage-item" @click="openManage('wish')"><MfIcon name="MessageCircle" />未命中音乐</div>
          </div>
        </el-popover>
      </div>
    </div>
    <div v-if="activeFilter" class="platform-filter-bar">
      <span class="platform-filter-label"><MfIcon name="Library" />筛选：{{ filterName(activeFilter) }}</span>
      <el-button size="small" text @click="clearFilter"><MfIcon name="X" />清除</el-button>
    </div>
    <div class="playlist-grid" v-loading="loading">
      <!-- User playlists -->
      <div
        class="playlist-card"
        v-for="pl in playlists"
        :key="pl.id"
        @contextmenu="openContextMenu($event, cardActions(pl), pl.name, `${pl.songCount} 首 · ${formatDuration(pl.duration)}`)"
        v-longpress="() => openActionSheet(cardActions(pl), pl.name, `${pl.songCount} 首 · ${formatDuration(pl.duration)}`)"
      >
        <div class="playlist-cover mf-coverwrap" @click.stop="open(pl)">
          <PlatformBadge :source="pl.sourcePlatform" />
          <img v-if="pl.coverArt" :src="coverUrl(pl.coverArt)" loading="lazy" decoding="async" />
          <div v-else class="cover-placeholder"><MfIcon name="List" :size="48"  /></div>
          <CoverPlay size="md" :label="`播放 ${pl.name}`" :action="() => playAll(pl)" />
        </div>
        <div class="playlist-info" @click="open(pl)">
          <div class="playlist-name">
            {{ pl.name }}
            <el-tag v-if="pl.sourcePlatform" size="small" style="margin-left: 4px">{{ pl.sourcePlatform === 'qq' ? 'QQ' : pl.sourcePlatform === 'netease' ? '网易云' : pl.sourcePlatform === 'kugou' ? '酷狗' : pl.sourcePlatform === 'kuwo' ? '酷我' : '' }}</el-tag>
            <el-tag v-if="pl.public" size="small" type="success" style="margin-left: 4px">公开</el-tag>
          </div>
          <div class="playlist-meta">
            <span>{{ pl.songCount }}首 · {{ formatDuration(pl.duration) }}</span>
            <MfIcon v-if="pl.favorite" name="Heart" :filled="true" :size="13" class="pl-fav-heart" />
          </div>
        </div>
        <el-dropdown trigger="click" class="playlist-menu" @click.stop @command="(cmd: string) => handleCardCommand(cmd, pl)">
          <el-button size="small" circle @click.stop><MfIcon name="MoreHorizontal" /></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="play"><MfIcon name="Play" />播放全部</el-dropdown-item>
              <el-dropdown-item v-if="pl.isImported" command="sync"><MfIcon name="RefreshCw" />同步</el-dropdown-item>
              <el-dropdown-item v-if="pl.isDaily" command="convertLocal"><MfIcon name="Pin" />转成本地永久歌单</el-dropdown-item>
              <el-dropdown-item command="rename"><MfIcon name="Pencil" />重命名</el-dropdown-item>
              <el-dropdown-item command="export"><MfIcon name="Download" />导出</el-dropdown-item>
              <el-dropdown-item command="favorite">
                <MfIcon name="Heart" :filled="pl.favorite" :size="14" />{{ pl.favorite ? '取消收藏' : '收藏歌单' }}
              </el-dropdown-item>
              <el-dropdown-item command="addToDaily" divided>
                <MfIcon name="Wand2" />{{ pl._inPool ? '移出每日推荐池' : '加入每日推荐池' }}
              </el-dropdown-item>
              <el-dropdown-item command="delete" divided><MfIcon name="Trash2" />删除歌单</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <div class="pagination-bar">
      <PagePagination :total="total" :page="currentPage" :page-size="pageSize" :sizes="[15, 20, 50, 100]" storage-key="playlistsPageSize" @change="onPageChange" />
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

    <el-dialog v-model="showImportDialog" title="导入歌单" width="560px">
      <!-- 支持的平台来自「已启用的导入插件」,不再写死:在插件页停用某个导入插件后
           这里的提示会同步变化。 -->
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px">
        {{ importHint }}
      </el-alert>
      <el-form label-width="80px">
        <el-form-item label="歌单链接">
          <el-input v-model="importUrl" :placeholder="importPlaceholder" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="或选择文件">
          <el-upload
            drag
            :auto-upload="false"
            :limit="1"
            accept=".json,application/json"
            :on-change="onNativeFileChange"
            :on-remove="clearNativeFile"
            :file-list="nativeFileList"
            style="width: 100%"
          >
            <el-icon class="el-icon--upload"><MfIcon name="Upload" :size="36" /></el-icon>
            <div class="el-upload__text">拖拽本项目的歌单 .json 文件到此处，或<em>点击选择</em></div>
          </el-upload>
        </el-form-item>
        <el-form-item label="歌单名称">
          <el-input v-model="importName" placeholder="留空则使用原歌单名" />
        </el-form-item>
        <el-form-item label="自动同步" v-if="!nativeFile">
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
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import CoverPlay from "@/components/CoverPlay.vue";
import PagePagination from "@/components/PagePagination.vue";
import { useItemActions, MenuAction } from "@/composables/useItemActions";
import { ElMessage, ElMessageBox } from "element-plus";
import { Play, Folder, RefreshCw, Pencil, Wand2, Trash2, Download, Pin, Heart } from "lucide-vue-next";
import { coverUrl } from "@/utils/cover";
import { parseManifest, parseConfig } from "@/utils/plugin";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const { openContextMenu, openActionSheet, menuGuard } = useItemActions();

function open(pl: any) {
  if (menuGuard()) return;
  router.push(`/playlists/${pl.id}`);
}

/** 歌单卡片的右键 / 长按操作集（复用页面已有的命令实现） */
function cardActions(pl: any): MenuAction[] {
  const acts: MenuAction[] = [
    { label: "播放全部", icon: Play, onClick: () => playAll(pl) },
    { label: "查看歌单", icon: Folder, onClick: () => router.push(`/playlists/${pl.id}`) },
  ];
  if (pl.isImported) acts.push({ label: "同步", icon: RefreshCw, onClick: () => syncPlaylist(pl) });
  if (pl.isDaily)
    acts.push({ label: "转成本地永久歌单", icon: Pin, onClick: () => convertToLocal(pl) });
  acts.push({ divider: true });
  acts.push({ label: "重命名", icon: Pencil, onClick: () => openRename(pl) });
  acts.push({ label: "导出歌单", icon: Download, onClick: () => exportPlaylist(pl) });
  acts.push({ label: pl.favorite ? "取消收藏" : "收藏歌单", icon: Heart, onClick: () => toggleFavorite(pl) });
  acts.push({
    label: pl._inPool ? "移出每日推荐池" : "加入每日推荐池",
    icon: Wand2,
    onClick: () => togglePlaylistPool(pl),
  });
  acts.push({ divider: true });
  acts.push({ label: "删除歌单", icon: Trash2, danger: true, onClick: () => deletePlaylist(pl) });
  return acts;
}

const playlists = ref<any[]>([]);
const loading = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const total = ref(0);
const pageSize = ref(parseInt(localStorage.getItem("playlistsPageSize") || "20"));
if (![15, 20, 50, 100].includes(pageSize.value)) pageSize.value = 20;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const showManageMenu = ref(false);
// 歌单筛选:空=全部 | local=本地歌单 | favorite=收藏的歌单 | 平台值(netease/qq/kugou/kuwo)
const FILTERS = [
  { key: "", label: "全部歌单" },
  { key: "local", label: "本地歌单" },
  { key: "favorite", label: "收藏的歌单" },
  { key: "netease", label: "网易云" },
  { key: "qq", label: "QQ音乐" },
  { key: "kugou", label: "酷狗" },
  { key: "kuwo", label: "酷我" },
];
const PLATFORM_NAMES: Record<string, string> = { netease: "网易云", qq: "QQ音乐", kugou: "酷狗", kuwo: "酷我" };
const activeFilter = ref("");
function filterName(key: string) { return FILTERS.find(f => f.key === key)?.label || PLATFORM_NAMES[key] || key || "全部"; }
function onFilterCommand(key: string) {
  activeFilter.value = key;
  currentPage.value = 1;
  loadPlaylists();
}
function clearFilter() {
  activeFilter.value = "";
  currentPage.value = 1;
  loadPlaylists();
}
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
const nativeFile = ref<any>(null);        // parsed MusicFlow JSON (or null)
const nativeFileList = ref<any[]>([]);    // el-upload file list (for display/remove)
const syncingId = ref("");
// Recommend-pool membership state, so the dropdown item can toggle between
// "加入每日推荐池" / "移出每日推荐池".
const poolPlaylistIds = ref<Set<string>>(new Set());

// 已启用「歌单链接导入」插件覆盖的平台(来自插件清单,不再写死 QQ/网易云)。
// 停用某个导入插件后,导入弹窗的提示文案会同步变化。
const importPlatforms = ref<string[]>([]);
const enabledImportPlatformLabels = computed(() =>
  importPlatforms.value.map((p) => PLATFORM_NAMES[p] || p).join(" / "),
);
const importHint = computed(() => {
  const links = enabledImportPlatformLabels.value;
  const head = links ? `支持 ${links} 歌单分享链接` : "支持已启用导入插件对应的歌单分享链接";
  return `${head},或本项目「导出」生成的 .json 歌单文件。导入时自动匹配本地曲库,匹配到的歌曲可直接播放;未匹配的歌曲加入未命中音乐`;
});
const importPlaceholder = computed(() =>
  importPlatforms.value.length ? `粘贴 ${enabledImportPlatformLabels.value} 歌单分享链接...` : "粘贴歌单分享链接...",
);
async function loadImportPlatforms() {
  try {
    const res = await api.get("/rest/api/v1/plugins");
    const plats = new Set<string>();
    for (const p of (res.data || []) as any[]) {
      if (!p.enabled) continue;
      const m = parseManifest(p.manifest);
      if (m?.capabilities?.includes("playlistImport")) for (const pl of m.platforms || []) plats.add(pl);
    }
    importPlatforms.value = [...plats];
  } catch {
    importPlatforms.value = [];
  }
}

// 在线源插件(用于同步所有平台的每日推荐歌单):只认 type==="source" 且已配置 baseUrl,不再写死 go-music-dl
const dailySourceId = ref("");
const syncingDaily = ref(false);

async function detectDailySource() {
  if (dailySourceId.value) return;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    const src = (res.data || []).find((p: any) => {
      const cfg = parseConfig(p);
      const manifest = parseManifest(p);
      return p.enabled && cfg?.baseUrl && manifest?.type === "source";
    });
    if (src) dailySourceId.value = src.id;
  } catch {}
}
async function syncDailyAll() {
  if (!dailySourceId.value) await detectDailySource(); // 未探测到源,先尝试探测
  if (!dailySourceId.value) {
    ElMessage.warning("未检测到在线源插件,请先在「插件」页配置 baseUrl 并启用一个 source 类型插件后再同步");
    return;
  }
  syncingDaily.value = true;
  try {
    const res = await api.post(`/rest/api/v1/online/${dailySourceId.value}/recommend/sync-all`);
    if (res.data?.success) {
      ElMessage.success(res.data.errors?.length ? `已更新 ${res.data.synced} 个,失败 ${res.data.failed} 个` : `已更新 ${res.data.synced} 个每日推荐歌单`);
      loadPlaylists();
    } else ElMessage.error(res.data?.error || "更新失败");
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "更新失败"); }
  finally { syncingDaily.value = false; }
}

function formatDuration(sec: number) { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`; }

async function loadPlaylists() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/playlists", {
      params: {
        page: currentPage.value,
        pageSize: pageSize.value,
        query: searchQuery.value,
        ...(activeFilter.value === "local" ? { local: "1" } : {}),
        ...(activeFilter.value === "favorite" ? { favorite: "1" } : {}),
        ...(activeFilter.value && activeFilter.value !== "local" && activeFilter.value !== "favorite" ? { platform: activeFilter.value } : {}),
      },
    });
    playlists.value = res.data.items || [];
    total.value = res.data.total || 0;
    // Annotate each playlist with its recommend-pool membership so the
    // dropdown item label can toggle.
    await loadPoolStatus();
    for (const pl of playlists.value) {
      pl._inPool = poolPlaylistIds.value.has(pl.id);
    }
  } catch { playlists.value = []; total.value = 0; }
  finally { loading.value = false; }
}

// Fetch the full recommend-pool list once, then derive the playlist-id set
// from it (saves N+1 requests).
async function loadPoolStatus() {
  try {
    const res = await api.get("/rest/api/v1/recommend-pool");
    const pool = res.data.pool || [];
    poolPlaylistIds.value = new Set(
      pool.filter((p: any) => p.source_type === "playlist").map((p: any) => p.source_id)
    );
  } catch {
    poolPlaylistIds.value = new Set();
  }
}

function onPageChange(page: number, size?: number) {
  currentPage.value = page;
  if (size) pageSize.value = size;
  loadPlaylists();
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage.value = 1; loadPlaylists(); }, 300);
}

function onSearchClear() { currentPage.value = 1; loadPlaylists(); }

// 「歌单管理」下拉菜单入口分发:新建/导入走原有对话框,导出/同步直接执行,未命中音乐跳未命中音乐页
function openManage(action: string) {
  showManageMenu.value = false;
  if (action === "create") showCreateDialog.value = true;
  else if (action === "import") { showImportDialog.value = true; loadImportPlatforms(); }
  else if (action === "export") exportAllPlaylists();
  else if (action === "sync") syncDailyAll();
  else if (action === "wish") router.push("/admin/wish");
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
  const hasUrl = importUrl.value.trim();
  const hasFile = !!nativeFile.value;
  if (!hasUrl && !hasFile) { ElMessage.warning("请输入歌单链接或选择歌单文件"); return; }
  importing.value = true;
  try {
    const body: any = hasFile
      ? { native: nativeFile.value, name: importName.value }
      : { url: importUrl.value, name: importName.value, autoSync: importAutoSync.value };
    const res = await api.post("/rest/api/v1/playlists/import", body);
    if (res.data.success) {
      if (res.data.created && res.data.created > 1) {
        ElMessage.success(`导入 ${res.data.created} 个歌单成功: 共 ${res.data.trackCount} 首,匹配曲库 ${res.data.matched} 首,未匹配 ${res.data.unmatched} 首(已加入未命中音乐)`);
      } else {
        ElMessage.success(`导入成功: 共 ${res.data.trackCount} 首,匹配曲库 ${res.data.matched} 首,未匹配 ${res.data.unmatched} 首(已加入未命中音乐)`);
      }
      showImportDialog.value = false;
      importUrl.value = "";
      importName.value = "";
      nativeFile.value = null;
      nativeFileList.value = [];
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

// Read a selected MusicFlow .json playlist file as text, then parse it for import.
function onNativeFileChange(file: any) {
  nativeFileList.value = file?.fileList?.length ? [file.fileList[file.fileList.length - 1]] : [];
  const raw = file?.raw;
  if (!raw) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      nativeFile.value = JSON.parse(reader.result as string);
    } catch {
      nativeFile.value = null;
      ElMessage.error("无效的歌单文件，请选择本项目导出的 .json 歌单");
    }
  };
  reader.readAsText(raw);
}
function clearNativeFile() {
  nativeFile.value = null;
  nativeFileList.value = [];
}

// Download a playlist as a MusicFlow-native .json export file.
async function exportPlaylist(pl: any) {
  try {
    const res = await api.get(`/rest/api/v1/playlists/${pl.id}/export`, { responseType: "blob" });
    const blob = new Blob([res.data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const cd = (res.headers["content-disposition"] as string) || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const a = document.createElement("a");
    a.href = url;
    a.download = m ? decodeURIComponent(m[1]) : `${pl.name}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.message || "导出失败");
  }
}

// Download every one of the user's playlists as a single MusicFlow-native .json file.
async function exportAllPlaylists() {
  try {
    const res = await api.get("/rest/api/v1/playlists/export-all", { responseType: "blob" });
    const blob = new Blob([res.data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const cd = (res.headers["content-disposition"] as string) || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const a = document.createElement("a");
    a.href = url;
    a.download = m ? decodeURIComponent(m[1]) : `MusicFlow全部歌单_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.message || "导出失败");
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

// Convert a daily-recommend imported playlist into a permanent local playlist.
// After conversion it is detached from the platform source and won't be rotated
// (replaced/deleted) by the daily recommend sync anymore.
async function convertToLocal(pl: any) {
  await ElMessageBox.confirm(
    `确定将「${pl.name}」转成本地永久歌单？转换后将不再作为每日推荐被轮换,但歌曲内容保持不变。`,
    "转成本地歌单",
    { type: "warning", confirmButtonText: "转换", cancelButtonText: "取消" },
  );
  try {
    const res = await api.post(`/rest/api/v1/playlists/${pl.id}/convert-to-local`);
    if (res.data.success) {
      ElMessage.success(`「${pl.name}」已转为本地永久歌单`);
      loadPlaylists();
    } else {
      ElMessage.error(res.data.error || "转换失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "转换失败");
  }
}

function handleCardCommand(cmd: string, pl: any) {
  switch (cmd) {
    case "play": playAll(pl); break;
    case "sync": syncPlaylist(pl); break;
    case "convertLocal": convertToLocal(pl); break;
    case "rename": openRename(pl); break;
    case "export": exportPlaylist(pl); break;
    case "favorite": toggleFavorite(pl); break;
    case "addToDaily": togglePlaylistPool(pl); break;
    case "delete": deletePlaylist(pl); break;
  }
}

// 收藏 / 取消收藏歌单。平台歌单收藏后转本地并开启每天自动同步(后端处理)。
async function toggleFavorite(pl: any) {
  try {
    const res = await api.post(`/rest/api/v1/playlists/${pl.id}/favorite`, { favorite: !pl.favorite });
    if (res.data.success) {
      const nowFav = res.data.favorite === true;
      pl.favorite = nowFav;
      if (nowFav) {
        ElMessage.success(pl.isImported ? `已收藏「${pl.name}」,已转本地并开启每天自动同步` : `已收藏「${pl.name}」`);
      } else {
        ElMessage.success(`已取消收藏「${pl.name}」`);
      }
      loadPlaylists();
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "操作失败");
  }
}

// Toggle a playlist in / out of the daily-recommend pool.
async function togglePlaylistPool(pl: any) {
  try {
    if (pl._inPool) {
      await api.delete(`/rest/api/v1/recommend-pool/playlist/${pl.id}`);
      pl._inPool = false;
      poolPlaylistIds.value.delete(pl.id);
      ElMessage.success(`已将「${pl.name}」移出每日推荐池`);
    } else {
      const res = await api.post(`/rest/api/v1/recommend-pool/playlist/${pl.id}`);
      pl._inPool = true;
      poolPlaylistIds.value.add(pl.id);
      ElMessage.success(res.data.message || `已将「${pl.name}」加入每日推荐池`);
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "操作失败");
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

onMounted(() => { loadPlaylists(); detectDailySource(); loadImportPlatforms(); });
</script>

<style lang="scss" scoped>
.playlists-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; }
  .header-actions { display: flex; gap: 10px; }
}
.manage-menu { display: flex; flex-direction: column; gap: 2px; }
.platform-filter-bar {
  display: flex; align-items: center; gap: 8px; margin-bottom: 14px;
  padding: 8px 14px; border-radius: 8px; font-size: 13px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
  .platform-filter-label { display: inline-flex; align-items: center; gap: 6px; color: var(--fnos-text-primary); }
}
.manage-item {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px;
  cursor: pointer; font-size: 13px; color: var(--fnos-text-primary); transition: background 0.18s ease, color 0.18s ease;
  &:hover { background: rgba(255,255,255,0.08); color: var(--fnos-red); }
}
.playlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.playlist-card {
  position: relative; cursor: pointer;
  border-radius: var(--fnos-radius-lg);
  overflow: hidden;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.07);
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  animation: home-card-in 0.45s ease backwards;  /* backwards: 动画结束后回退到元素常态（无 transform 残留），both 会保持 translateY(0) 终态形成永久 stacking context，旧 Chromium 上可能穿透 fixed 弹窗 */
  &:hover {
    transform: translateY(-5px);
    background: rgba(255,255,255,0.08);
    box-shadow: 0 14px 34px rgba(0,0,0,0.42);
    .playlist-cover img { transform: scale(1.06); }
  }
  &:active { transform: translateY(-2px) scale(0.98); }
  .playlist-cover { position: relative; aspect-ratio: 1; overflow: hidden; background: rgba(255,255,255,0.04);
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.5s ease; }
    .cover-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); }
    &.fav-cover { background: linear-gradient(135deg, #f5b942, #e94560); color: #fff; display: flex; align-items: center; justify-content: center;
      .heart-icon { color: #fff; } }
  }
  .playlist-info {
    position: relative;
    padding: 12px;
    background: linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.55) 100%);
    margin-top: -40px;
    padding-top: 48px;
    .playlist-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); transition: color 0.18s ease; }
    .playlist-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; display: flex; align-items: center; justify-content: space-between; gap: 4px;
      .pl-fav-heart { color: var(--fnos-red); flex-shrink: 0; }
    }
  }
  .playlist-info:hover .playlist-name { color: var(--fnos-red); }
  .playlist-menu { position: absolute; top: 8px; right: 8px; opacity: 0; transition: opacity 0.2s; z-index: 8; }
  &:hover .playlist-menu { opacity: 1; }
}
@keyframes home-card-in {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.pagination-bar { margin-top: 24px; display: flex; justify-content: center; }

@media (max-width: 768px) {
  .playlists-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
  .playlist-grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .playlist-card .playlist-info {
    padding: 10px;
    margin-top: -32px;
    padding-top: 36px;
    .playlist-name { font-size: 13px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-clamp: 2; }
    .playlist-meta { font-size: 11px; }
  }
  .playlist-menu { opacity: 1; }
}
</style>