<template>
  <div class="playlists-page">
    <div class="page-header">
      <h2>歌单<span class="song-count">{{ total }} 个</span></h2>
      <div class="search-area">
        <span class="search-label">搜索</span>
        <el-dropdown trigger="click" @command="onSearchSourceCommand">
          <el-button>
            {{ currentSourceLabel }}
            <el-icon class="el-icon--right"><MfIcon name="ChevronDown" /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="local">本地</el-dropdown-item>
              <el-dropdown-item v-for="(p, i) in searchProviders" :key="p.id" :command="p.id" :divided="i === 0">{{ p.name }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-input v-model="searchQuery" :placeholder="searchPlaceholder" prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
      </div>
      <div class="header-actions">
        <el-button :type="activeFilter === 'favorite' ? 'danger' : ''" @click="toggleFavoriteFilter">
          <el-icon class="fav-heart"><MfIcon name="Heart" :filled="activeFilter === 'favorite'" :size="16" /></el-icon>收藏的歌单
        </el-button>
        <el-dropdown trigger="click" @command="onFilterCommand">
          <el-button><MfIcon name="Library" />筛选歌单<el-icon class="el-icon--right"><MfIcon name="ChevronDown" /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="f in FILTERS" :key="f.key" :command="f.key">{{ f.label }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-dropdown trigger="click" @command="onSortCommand">
          <el-button><MfIcon name="ListOrdered" />排序：{{ sortLabel }}<el-icon class="el-icon--right"><MfIcon name="ChevronDown" /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="s in SORTS" :key="s.key" :command="s.key">{{ s.label }}</el-dropdown-item>
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
            <div class="manage-item" @click="openManage('matchAll')"><MfIcon name="Search" />一键在线适配</div>
            <div class="manage-item" @click="openManage('refreshPrivate')"><MfIcon name="RefreshCw" />一键刷新私人歌单</div>
            <div class="manage-item" @click="openManage('sync')"><MfIcon name="RefreshCw" />同步所有平台</div>
            <div v-if="authStore.isAdmin" class="manage-item" @click="openManage('wish')"><MfIcon name="MessageCircle" />未命中音乐</div>
          </div>
        </el-popover>
      </div>
    </div>
    <el-alert v-if="systemBusy" type="info" :closable="false" class="busy-banner" show-icon>
      <template #title>后台批量任务运行中（同步 / 导入 / 推荐刷新），操作可能短暂变慢，请稍候</template>
    </el-alert>
    <div v-if="activeFilter" class="platform-filter-bar">
      <span class="platform-filter-label"><MfIcon name="Library" />筛选：{{ filterName(activeFilter) }}</span>
      <el-button size="small" text @click="clearFilter"><MfIcon name="X" />清除</el-button>
    </div>
    <div v-if="isLocalMode" class="playlist-grid virt-grid" ref="gridEl" v-loading="loading" :style="{ height: frameHeight }">
      <!-- User playlists (windowed: fixed-height spacer + absolutely positioned virtual tiles) -->
      <template v-for="g in gridViews" :key="g.item ? g.item.id : 'ph-' + g.idx">
      <div
        v-if="g.item"
        class="playlist-card"
        :style="cardStyle(g.idx)"
        @contextmenu="openContextMenu($event, cardActions(g.item), g.item.name, `${g.item.songCount} 首 · ${formatDuration(g.item.duration)}`)"
        v-longpress="() => openActionSheet(cardActions(g.item), g.item.name, `${g.item.songCount} 首 · ${formatDuration(g.item.duration)}`)"
      >
        <div class="playlist-cover mf-coverwrap" @click.stop="open(g.item)">
          <PlatformBadge :source="g.item.sourcePlatform" />
          <img v-if="g.item.coverArt" :src="coverUrl(g.item.coverArt)" loading="lazy" decoding="async" />
          <div v-else class="cover-placeholder"><MfIcon name="List" :size="48"  /></div>
          <CoverPlay size="md" :label="`播放 ${g.item.name}`" :action="() => playAll(g.item)" />
        </div>
        <div class="playlist-info" @click="open(g.item)">
          <div class="playlist-name">
            {{ g.item.name }}
            <el-tag v-if="g.item.sourcePlatform" size="small" style="margin-left: 4px">{{ g.item.sourcePlatform === 'qq' ? 'QQ' : g.item.sourcePlatform === 'netease' ? '网易云' : g.item.sourcePlatform === 'kugou' ? '酷狗' : g.item.sourcePlatform === 'kuwo' ? '酷我' : g.item.sourcePlatform === 'soda' ? '汽水' : '' }}</el-tag>
            <el-tag v-if="g.item.public" size="small" type="success" style="margin-left: 4px">公开</el-tag>
          </div>
          <div class="playlist-meta">
            <span>{{ g.item.songCount }}首 · {{ formatDuration(g.item.duration) }}</span>
            <MfIcon v-if="g.item.favorite" name="Heart" :filled="true" :size="13" class="pl-fav-heart" />
          </div>
          <div class="playlist-sub" v-if="g.item.isImported && g.item.created">导入于 {{ formatCreated(g.item.created) }}</div>
        </div>
        <el-dropdown trigger="click" class="playlist-menu" @click.stop @command="(cmd: string) => handleCardCommand(cmd, g.item)">
          <el-button size="small" circle @click.stop><MfIcon name="MoreHorizontal" /></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="play"><MfIcon name="Play" />播放全部</el-dropdown-item>
              <el-dropdown-item v-if="g.item.isImported" command="sync"><MfIcon name="RefreshCw" />同步</el-dropdown-item>
              <el-dropdown-item v-else-if="g.item.pluginSynced" command="refresh"><MfIcon name="RefreshCw" />刷新</el-dropdown-item>
              <el-dropdown-item v-if="g.item.isDaily" command="convertLocal"><MfIcon name="Pin" />转成本地永久歌单</el-dropdown-item>
              <el-dropdown-item command="rename"><MfIcon name="Pencil" />重命名</el-dropdown-item>
              <el-dropdown-item command="export"><MfIcon name="Download" />导出</el-dropdown-item>
              <el-dropdown-item command="favorite">
                <MfIcon name="Heart" :filled="g.item.favorite" :size="14" />{{ g.item.favorite ? '取消收藏' : '收藏歌单' }}
              </el-dropdown-item>
              <el-dropdown-item command="addToDaily" divided>
                <MfIcon name="Wand2" />{{ g.item._inPool ? '移出每日推荐池' : '加入每日推荐池' }}
              </el-dropdown-item>
              <el-dropdown-item command="delete" divided><MfIcon name="Trash2" />删除歌单</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div v-else class="playlist-card is-placeholder" :style="cardStyle(g.idx)">
        <div class="playlist-cover ph-cover"></div>
        <div class="playlist-placeholder"><span class="ph-bar"></span><span class="ph-bar short"></span></div>
      </div>
      </template>
    </div>

    <!-- 平台(插件)歌单搜索结果:由启用的 playlistSearch 插件(如 go-music-dl)提供,可「加入库」 -->
    <div v-else class="remote-results" v-loading="remoteSearching">
      <div v-if="remoteResults.length === 0 && !remoteSearching" class="remote-empty">
        <MfIcon name="List" :size="40" />
        <p>{{ searchQuery.trim() ? "没有找到相关歌单" : `输入关键词,搜索${currentProviderName}支持的全网歌单` }}</p>
      </div>
      <div class="playlist-grid">
        <div class="playlist-card" v-for="(rp, i) in remoteResults" :key="i">
          <div class="playlist-cover mf-coverwrap" @click="openRemote(rp)">
            <span class="remote-source-tag">{{ rp.platformLabel }}</span>
            <img v-if="rp.cover" :src="rp.cover" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            <div v-else class="cover-placeholder"><MfIcon name="List" :size="48" /></div>
            <CoverPlay size="md" :label="`播放 ${rp.name}`" :action="() => playRemotePl(rp)" />
          </div>
          <div class="playlist-info" @click="openRemote(rp)">
            <div class="playlist-name">{{ rp.name }}</div>
            <div class="playlist-meta">
              <span>{{ rp.creator ? rp.creator + " · " : "" }}{{ rp.trackCount ? rp.trackCount + "首" : "" }}</span>
            </div>
          </div>
          <el-button
            class="remote-import-btn"
            size="small"
            type="primary"
            :loading="importingId === rp.source + ':' + rp.id"
            :disabled="rp._imported"
            @click="importRemote(rp)"
          >{{ rp._imported ? "已加入库" : "加入库" }}</el-button>
        </div>
      </div>

      <!-- 远程歌单详情:点击卡片 → 预览歌单歌曲(未入库也可播放/加入库) -->
      <RemoteDetailDialog
        v-model="remoteDetailVisible"
        kind="playlist"
        :provider-id="searchMode"
        :item="remoteDetailItem"
        @imported="loadPlaylists"
      />
    </div>

    <el-dialog v-model="showCreateDialog" title="新建歌单" width="400px" :append-to-body="true">
      <el-input v-model="newPlaylistName" placeholder="歌单名称" @keyup.enter="createPlaylist" />
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="createPlaylist">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showRenameDialog" title="重命名歌单" width="400px" :append-to-body="true">
      <el-input v-model="renamePlaylistName" placeholder="新歌单名称" @keyup.enter="renamePlaylist" />
      <template #footer>
        <el-button @click="showRenameDialog = false">取消</el-button>
        <el-button type="primary" @click="renamePlaylist">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showImportDialog" title="导入歌单" width="560px" :append-to-body="true">
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
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import CoverPlay from "@/components/CoverPlay.vue";
import RemoteDetailDialog from "@/components/RemoteDetailDialog.vue";
import { useItemActions, MenuAction } from "@/composables/useItemActions";
import { playRemoteCollection } from "@/composables/useEntitySearch";
import { useCardGrid } from "@/composables/useCardGrid";
import { ElMessage, ElMessageBox } from "element-plus";
import { Play, Folder, RefreshCw, Pencil, Wand2, Trash2, Download, Pin, Heart } from "lucide-vue-next";
import { coverUrl } from "@/utils/cover";
import { parseManifest, parseConfig } from "@/utils/plugin";
import api from "@/api";
import { waitAsyncTask } from "@/utils/asyncTask";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const route = useRoute();
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
  else if (pl.pluginSynced) acts.push({ label: "刷新", icon: RefreshCw, onClick: () => refreshPluginPlaylist(pl) });
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

// 本地歌单网格:窗口化分块加载(与 HA 卡片同构)。整页展示 + 滚动懒加载:
// 数据按块 fetch,仅视口窗口渲染,越界剪枝,内存不随浏览条目数增长。
const cardGrid = useCardGrid<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get("/rest/api/v1/playlists", {
      params: {
        page,
        pageSize: size,
        query: searchQuery.value,
        ...(activeFilter.value === "local" ? { local: "1" } : {}),
        ...(activeFilter.value === "favorite" ? { favorite: "1" } : {}),
        ...(activeFilter.value && activeFilter.value !== "local" && activeFilter.value !== "favorite" ? { platform: activeFilter.value } : {}),
        ...(sortMode.value ? { sort: sortMode.value } : {}),
      },
    });
    const items = res.data.items || [];
    // 逐条标注推荐池状态,按钮文案才能正确显示「加入/移出每日推荐池」。
    for (const pl of items) pl._inPool = poolPlaylistIds.value.has(pl.id);
    return { items, total: res.data.total || 0 };
  },
  { chunk: 60, keepRows: 120, prefetchBlocks: 2, concurrency: 3, minTileWidth: 220, gap: 18, coverRatio: 1, rowFooter: 64 }
);
const gridEl = cardGrid.gridEl;
const loading = cardGrid.loading;
const total = cardGrid.total;
const frameHeight = cardGrid.frameHeight;
const cardStyle = cardGrid.cardStyle;
// 窗口化渲染辅助:当前可见卡片区间(全局下标)+ 列数。
const gridViews = computed(() => {
  const start = cardGrid.startIndex.value;
  const end = cardGrid.endIndex.value;
  const arr: { idx: number; item: any }[] = [];
  for (let i = Math.max(0, start); i < end; i++) arr.push({ idx: i, item: cardGrid.list.value[i] });
  return arr;
});

const searchQuery = ref("");
// 搜索模式:local=本地库搜索(现状) | <pluginId>=平台(插件)歌单搜索
const searchMode = ref("local");
const searchProviders = ref<{ id: string; name: string; platforms: string[]; platformLabels: Record<string, string> }[]>([]);
const remoteResults = ref<any[]>([]);
const remoteSearching = ref(false);
const importingId = ref("");
const isLocalMode = computed(() => searchMode.value === "local");
const currentProvider = computed(() => searchProviders.value.find(p => p.id === searchMode.value));
const currentProviderName = computed(() => currentProvider.value?.name || "平台");
// 搜索来源下拉按钮文案:本地模式显示「本地」,插件模式显示插件名
const currentSourceLabel = computed(() => isLocalMode.value ? "本地" : (currentProvider.value?.name || "本地"));
const searchPlaceholder = computed(() => isLocalMode.value ? "搜索歌单..." : `搜索${currentProviderName.value}全网歌单...`);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const showManageMenu = ref(false);
// 歌单筛选:空=全部 | local=本地歌单 | 平台值(netease/qq/kugou/kuwo)
// 「收藏的歌单」已独立为顶部专属按钮(不再出现在筛选下拉里),由 activeFilter==="favorite" 触发。
const FILTERS = [
  { key: "", label: "全部歌单" },
  { key: "local", label: "本地歌单" },
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
  loadPlaylists();
}
function clearFilter() {
  activeFilter.value = "";
  loadPlaylists();
}
// 独立「收藏的歌单」按钮:点击切换收藏筛选,再次点击回到全部。
function toggleFavoriteFilter() {
  activeFilter.value = activeFilter.value === "favorite" ? "" : "favorite";
  loadPlaylists();
}
// 歌单排序:按创建时间/名称升序降序;空=后端默认(每日推荐优先+最近更新)
const SORTS = [
  { key: "", label: "默认(推荐优先)" },
  { key: "created_desc", label: "创建时间(最新在前)" },
  { key: "created_asc", label: "创建时间(最早在前)" },
  { key: "name_asc", label: "名称(升序 A→Z)" },
  { key: "name_desc", label: "名称(降序 Z→A)" },
];
const sortMode = ref("");
const sortLabel = computed(() => SORTS.find(s => s.key === sortMode.value)?.label || "默认(推荐优先)");
function onSortCommand(key: string) {
  sortMode.value = key;
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
const gmdlRefreshing = ref(false);

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
// 聚合「同步所有平台」:路径A公开推荐歌单重导 + 所有 recommendPlaylist 插件
// (go-music-dl 私人歌单 / listenbrainz 推荐)异步刷新。立即返回,轮询汇总。
const syncAllTasks = ref<any[]>([]);
const syncAllTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const gmdlRefreshTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const matchAllTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const matchAllRunning = ref(false);
const matchAllBatchId = ref("");
const matchAllTotal = ref(0);
const matchAllDone = ref(0);
const matchAllCurrent = ref("");

async function syncDailyAll() {
  if (!dailySourceId.value) await detectDailySource(); // 未探测到源,先尝试探测
  if (!dailySourceId.value) {
    ElMessage.warning("未检测到在线源插件,请先在「插件」页配置 baseUrl 并启用一个 source 类型插件后再同步");
    return;
  }
  if (syncingDaily.value) return;
  syncingDaily.value = true;
  syncAllTasks.value = [];
  try {
    const res = await api.post(`/rest/api/v1/online/${dailySourceId.value}/recommend/sync-all`);
    if (res.data?.success && res.data.started) {
      syncAllTasks.value = res.data.tasks || [];
      ElMessage.success(`已开始同步:每日推荐 + ${(res.data.tasks || []).length} 个插件推荐,完成后自动提示`);
      pollSyncAll();
    } else if (res.data?.success && res.data?.alreadyRunning) {
      ElMessage.info("同步任务已在后台进行中");
      syncingDaily.value = false;
    } else {
      ElMessage.error(res.data?.error || "同步失败");
      syncingDaily.value = false;
    }
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "同步失败"); syncingDaily.value = false; }
}

// 轮询聚合同步:路径A状态 + 各插件 job 状态,全部结束后汇总提示。
function pollSyncAll() {
  const tick = async () => {
    try {
      const a = await api.get(`/rest/api/v1/online/${dailySourceId.value}/recommend/sync-all/status`).catch(() => null);
      const pluginStates = await Promise.all((syncAllTasks.value || []).map(async (t: any) => {
        try {
          const r = await api.get(`/rest/api/v1/plugins/${t.pluginId}/job`);
          return { pluginId: t.pluginId, job: r.data?.job };
        } catch { return { pluginId: t.pluginId, job: null }; }
      }));
      const pathADone = !a?.data?.running;
      const pluginsDone = pluginStates.every((p) => !p.job || !p.job.running);
      if (!pathADone || !pluginsDone) {
        syncAllTimer.value = setTimeout(tick, 2000);
        return;
      }
      syncingDaily.value = false;
      const failCount = pluginStates.filter((p) => p.job?.status === "error").length;
      const aResult = a?.data?.result;
      const aSummary = aResult?.synced ? `每日推荐更新 ${aResult.synced} 个` : "每日推荐更新完成";
      ElMessage.success(`${aSummary}${failCount ? `,${failCount} 个插件任务失败(详见插件页)` : ",插件任务全部完成"}`);
      loadPlaylists();
    } catch {
      syncAllTimer.value = setTimeout(tick, 2000);
    }
  };
  tick();
}

// go-music-dl 私人歌单「刷新」(插件同步歌单的刷新入口;也用于「一键刷新私人歌单」)。
// 优先按歌单归属插件(sourcePluginId)精确刷新;旧数据无归属时回退 go-music-dl。
async function refreshPluginPlaylist(pl?: any) {
  await startGmdlRefresh(pl?.sourcePluginId || "go-music-dl");
}
async function refreshAllPrivate() {
  await startGmdlRefresh("go-music-dl");
}
async function startGmdlRefresh(pluginId: string) {
  if (gmdlRefreshing.value) return;
  gmdlRefreshing.value = true;
  try {
    const res = await api.post("/rest/api/v1/recommend/refresh", { pluginId });
    if (res.data?.success) {
      ElMessage.success(res.data.alreadyRunning ? "刷新任务已在后台进行中,完成后自动提示" : "已开始后台刷新,完成后自动提示");
      pollGmdlJob(pluginId);
    } else {
      ElMessage.error(res.data?.error || "刷新启动失败");
      gmdlRefreshing.value = false;
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "刷新启动失败");
    gmdlRefreshing.value = false;
  }
}
function pollGmdlJob(pluginId: string) {
  const tick = async () => {
    try {
      const res = await api.get(`/rest/api/v1/plugins/${pluginId}/job`);
      if (res.data?.running) { gmdlRefreshTimer.value = setTimeout(tick, 2000); return; }
      const job = res.data?.job;
      gmdlRefreshing.value = false;
      if (job?.status === "ok") {
        const s = job.summary;
        ElMessage.success(typeof s === "string" && s ? s : "私人歌单刷新完成");
      } else if (job?.status === "error") {
        ElMessage.error(job.error || "刷新失败");
      } else {
        ElMessage.info("刷新任务已结束");
      }
      loadPlaylists();
    } catch {
      gmdlRefreshTimer.value = setTimeout(tick, 2000);
    }
  };
  tick();
}

// 一键在线适配:对所有含未匹配条目的歌单启动后台批量匹配,轮询进度。
async function matchAllPlaylists() {
  if (!dailySourceId.value) await detectDailySource();
  if (!dailySourceId.value) {
    ElMessage.warning("未检测到在线源插件,请先在「插件」页配置 baseUrl 并启用一个 source 类型插件");
    return;
  }
  if (matchAllRunning.value) return;
  matchAllRunning.value = true;
  matchAllTotal.value = 0; matchAllDone.value = 0; matchAllCurrent.value = ""; matchAllBatchId.value = "";
  try {
    const res = await api.post(`/rest/api/v1/online/${dailySourceId.value}/match-playlists`);
    if (res.data?.started) {
      matchAllBatchId.value = res.data.batchId;
      matchAllTotal.value = res.data.total || 0;
      ElMessage.success(`已开始后台在线适配 ${res.data.total} 个歌单…`);
      pollMatchAll();
    } else if (res.data?.alreadyMatched) {
      ElMessage.success("所有歌单均已在线适配,无需处理");
      matchAllRunning.value = false;
    } else {
      ElMessage.error(res.data?.error || "启动失败");
      matchAllRunning.value = false;
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "启动失败");
    matchAllRunning.value = false;
  }
}
function pollMatchAll() {
  const tick = async () => {
    try {
      const res = await api.get(`/rest/api/v1/online/${dailySourceId.value}/match-playlists/status`, { params: { batchId: matchAllBatchId.value } });
      const d = res.data;
      if (!d || d.status === "running") {
        if (d) { matchAllDone.value = d.done || 0; matchAllCurrent.value = d.current || ""; }
        matchAllTimer.value = setTimeout(tick, 2000);
        return;
      }
      matchAllDone.value = d.done || 0;
      matchAllCurrent.value = "";
      matchAllRunning.value = false;
      if (d.status === "completed") {
        const failed = (d.results || []).filter((r: any) => r.error).length;
        ElMessage.success(`在线适配完成:${d.total} 个歌单已处理${failed ? `,${failed} 个失败` : ""}`);
        loadPlaylists();
      } else {
        ElMessage.error(d.error || "在线适配失败");
      }
    } catch {
      matchAllTimer.value = setTimeout(tick, 2000);
    }
  };
  tick();
}

function formatDuration(sec: number) { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`; }
function formatCreated(t: string): string {
  if (!t) return "";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 重新拉取本地歌单(窗口化):更新推荐池状态后重置并补拉窗口所在块。
async function loadPlaylists() {
  await loadPoolStatus();
  cardGrid.reload();
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

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (isLocalMode.value) loadPlaylists();
    else doRemoteSearch();
  }, 300);
}

function onSearchClear() { if (isLocalMode.value) loadPlaylists(); else doRemoteSearch(); }

// 模式切换:清空远程结果;切到插件模式时若有关键词立即搜索;切回本地刷新列表
function onSearchModeChange() {
  remoteResults.value = [];
  if (isLocalMode.value) { loadPlaylists(); return; }
  if (searchQuery.value.trim()) doRemoteSearch();
}

// 搜索来源下拉命令:本地=local,其余=对应 playlistSearch 插件 id;复用 onSearchModeChange 切换逻辑
function onSearchSourceCommand(cmd: string) {
  if (searchMode.value === cmd) return;
  searchMode.value = cmd;
  onSearchModeChange();
}

// 已启用的 playlistSearch 插件列表(前端切换器数据源,动态)
async function loadSearchProviders() {
  try {
    const res = await api.get("/rest/api/v1/playlist-search/providers");
    searchProviders.value = res.data.providers || [];
  } catch {
    searchProviders.value = [];
  }
}

// 平台歌单搜索:调插件的 searchPlaylists(聚合其全部平台),结果带平台标签
async function doRemoteSearch() {
  const q = searchQuery.value.trim();
  if (!q) { remoteResults.value = []; return; }
  remoteSearching.value = true;
  try {
    const res = await api.post(`/rest/api/v1/playlist-search/${searchMode.value}/search`, { q });
    if (res.data?.success) {
      remoteResults.value = (res.data.playlists || []).map((p: any) => ({ ...p, _imported: false }));
    } else {
      remoteResults.value = [];
      ElMessage.error(res.data?.error || "搜索失败");
    }
  } catch {
    remoteResults.value = [];
    ElMessage.error("搜索失败:插件未启用或服务不可达");
  } finally {
    remoteSearching.value = false;
  }
}

// 把搜索结果加入库:插件 playlistSongs 拉歌 → 核心导入(合成 sourceUrl 幂等,重复加入=增量更新)
async function importRemote(rp: any) {
  const key = `${rp.source}:${rp.id}`;
  if (importingId.value === key) return;
  try {
    await ElMessageBox.confirm(`将歌单「${rp.name}」加入本地库?`, "加入库", {
      confirmButtonText: "加入",
      cancelButtonText: "取消",
      type: "info",
    });
  } catch { return; }
  importingId.value = key;
  try {
    const res = await api.post(`/rest/api/v1/playlist-search/${searchMode.value}/import`, {
      source: rp.source, id: rp.id, name: rp.name, cover: rp.cover,
    });
    if (res.data?.alreadyRunning) {
      ElMessage.warning("该歌单正在导入中,请稍候");
    } else if (res.data?.success && res.data.taskId) {
      // 异步任务:轮询直到完成(导入端点已异步化,触发即返回 taskId)
      const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
      if (r?.success) {
        rp._imported = true;
        ElMessage.success(`已加入库:${r.name}(${r.trackCount}首,匹配 ${r.added})`);
        loadPlaylists(); // 刷新本地列表(新歌单出现)
      } else {
        ElMessage.error(r?.error || "导入失败");
      }
    } else {
      ElMessage.error(res.data?.error || "导入失败");
    }
  } catch (e: any) {
    ElMessage.error(e?.message || "导入失败:插件未启用或服务不可达");
  } finally {
    importingId.value = "";
  }
}

// 「歌单管理」下拉菜单入口分发:新建/导入走原有对话框,导出/同步直接执行,未命中音乐跳未命中音乐页
function openManage(action: string) {
  showManageMenu.value = false;
  if (action === "create") showCreateDialog.value = true;
  else if (action === "import") { showImportDialog.value = true; loadImportPlatforms(); }
  else if (action === "export") exportAllPlaylists();
  else if (action === "matchAll") matchAllPlaylists();
  else if (action === "refreshPrivate") refreshAllPrivate();
  else if (action === "sync") syncDailyAll();
  else if (action === "wish") router.push("/admin/wish");
}

// ===== 远程歌单:悬浮播放(未入库直接播) + 点击卡片看详情 =====
const remoteDetailVisible = ref(false);
const remoteDetailItem = ref<any>(null);
function openRemote(rp: any) {
  if (menuGuard()) return;
  remoteDetailItem.value = rp;
  remoteDetailVisible.value = true;
}
async function playRemotePl(rp: any) {
  if (menuGuard()) return;
  const n = await playRemoteCollection("playlist", searchMode.value, rp);
  if (n) ElMessage.success(`正在播放「${rp.name}」`);
  else ElMessage.warning("该歌单暂无可播放歌曲");
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
      if (res.data.taskId) {
        // URL 导入异步任务:轮询直到完成
        const r = await waitAsyncTask(res.data.taskId, { intervalMs: 1000 });
        if (!r?.success) throw new Error(r?.error || "导入失败");
        if (r.created && r.created > 1) {
          ElMessage.success(`导入 ${r.created} 个歌单成功: 共 ${r.trackCount} 首,匹配曲库 ${r.matched} 首,未匹配 ${r.unmatched} 首(已加入未命中音乐)`);
        } else {
          ElMessage.success(`导入成功: 共 ${r.trackCount} 首,匹配曲库 ${r.matched} 首,未匹配 ${r.unmatched} 首(已加入未命中音乐)`);
        }
        showImportDialog.value = false;
        importUrl.value = "";
        importName.value = "";
        nativeFile.value = null;
        nativeFileList.value = [];
        loadPlaylists();
      } else if (res.data.created && res.data.created > 1) {
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
    ElMessage.error(e?.response?.data?.error || e?.message || "导入失败");
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
    if (res.data?.alreadyRunning) {
      ElMessage.warning("该歌单正在同步中,请稍候");
    } else if (res.data.success && res.data.taskId) {
      // 异步任务:轮询直到完成(手动同步已异步化,触发即返回 taskId)
      const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
      if (r?.total !== undefined) {
        ElMessage.success(`同步完成: 共 ${r.total} 首,匹配 ${r.matched} 首,未匹配 ${r.unmatched} 首`);
      } else {
        ElMessage.success("同步完成");
      }
      loadPlaylists();
    } else {
      ElMessage.error(res.data.error || "同步失败");
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e?.message || "同步失败");
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
    case "refresh": refreshPluginPlaylist(pl); break;
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

// 后端 busy 感知:批量任务(每日推荐/自动匹配/插件任务/异步导入同步)运行中显示横幅,
// 替代「前端假死」的无反馈表现。
const systemBusy = ref(false);
let busyTimer: ReturnType<typeof setInterval> | null = null;
async function pollBusy() {
  try {
    const res = await api.get("/rest/api/v1/system/busy");
    systemBusy.value = !!res.data?.busy;
  } catch { /* 网络抖动忽略,维持上一次状态 */ }
}

onMounted(() => { detectDailySource(); loadImportPlatforms(); loadSearchProviders(); pollBusy(); busyTimer = setInterval(pollBusy, 4000); nextTick(() => cardGrid.bindGrid()); });

// 首页「查看收藏的歌单 / 查看网易云歌单」等入口通过 ?filter= 深链到本页。
// keep-alive 下组件复用,onMounted 不重跑,故用 watch 监听路由 query 每次生效。
watch(
  () => route.query.filter,
  (f) => {
    const qf = String(f || "").trim();
    if (qf) activeFilter.value = qf;
    else activeFilter.value = ""; // 无 query(如侧边栏直达)回落到全部歌单
    loadPlaylists();
  },
  { immediate: true },
);

// 首块拉到总数后需要据此重算一次可见窗口;之后由滚动驱动。
watch(cardGrid.total, (t) => { if (t > 0) cardGrid.recomputeGrid(); });
onUnmounted(() => {
  if (busyTimer) clearInterval(busyTimer);
  if (syncAllTimer.value) clearTimeout(syncAllTimer.value);
  if (gmdlRefreshTimer.value) clearTimeout(gmdlRefreshTimer.value);
  if (matchAllTimer.value) clearTimeout(matchAllTimer.value);
});
</script>

<style lang="scss" scoped>
.playlists-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; display: flex; align-items: baseline; gap: 14px;
    .song-count { font-size: 14px; color: var(--fnos-text-tertiary); font-weight: 500; }
  }
  .header-actions { display: flex; gap: 10px;
    .fav-heart { margin-right: 2px; }
  }
}
.search-area { display: flex; align-items: center; gap: 10px; }
.search-label { font-size: 14px; color: var(--fnos-text-secondary); margin-right: 2px; white-space: nowrap; }
.busy-banner { margin: 0 0 16px; }
.remote-results {
  .remote-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 0; color: var(--fnos-text-tertiary); font-size: 13px; }
  .remote-source-tag {
    position: absolute; top: 8px; left: 8px; z-index: 2;
    padding: 2px 8px; border-radius: 6px; font-size: 11px;
    background: rgba(0,0,0,0.55); color: #fff; backdrop-filter: blur(4px);
  }
  .remote-import-btn { position: absolute; right: 8px; bottom: 8px; z-index: 2; }
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
// 本地网格窗口化:固定高度 spacer + 绝对定位虚拟卡片。覆盖默认 grid 布局;
// `.playlist-grid`(远程结果)仍走自动 grid 排列。
.playlist-grid.virt-grid { display: block; position: relative; width: 100%; }
.playlist-grid.virt-grid .playlist-card { box-sizing: border-box; }
// 窗口化懒加载:未加载槽位占位卡(封面灰块 + 骨架条),块到达后由真实卡片替换。
.playlist-card.is-placeholder {
  cursor: default;
  .ph-cover { aspect-ratio: 1; border-radius: 12px; background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.05) 63%); background-size: 400% 100%; animation: mf-ph 1.2s ease-in-out infinite; }
  .playlist-placeholder { padding: 10px 4px 0; display: flex; flex-direction: column; gap: 8px;
    .ph-bar { height: 12px; width: 60%; border-radius: 6px; background: rgba(255,255,255,0.08);
      &.short { width: 40%; }
    }
  }
}
@keyframes mf-ph { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
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
    .playlist-sub { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; }
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