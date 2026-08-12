<template>
  <div class="admin-plugins">
    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <!-- ============ Installed plugins ============ -->
      <el-tab-pane label="已安装" name="installed">
        <div class="page-header">
          <h2>插件管理</h2>
          <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
        </div>

        <el-table :data="plugins" stripe v-loading="loading" v-if="plugins.length > 0">
          <el-table-column label="插件名称" min-width="200">
            <template #default="{ row }">
              <div class="plugin-name">{{ displayName(row) }}</div>
              <div class="plugin-id">{{ row.name }}</div>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="version" label="版本" width="90" />
          <el-table-column label="说明" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ parseManifest(row).description || row.description || "—" }}</template>
          </el-table-column>
          <el-table-column label="健康" width="96">
            <template #default="{ row }">
              <el-tag size="small" :type="healthType(row.name)" effect="dark">{{ healthLabel(row.name) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="104">
            <template #default="{ row }">
              <!-- 内置插件是核心功能:不显示关闭按钮 -->
              <el-tag v-if="row.builtin" size="small" type="warning" effect="light">核心·启用</el-tag>
              <el-switch v-else v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="210">
            <template #default="{ row }">
              <el-button size="small" type="primary" plain @click="editPlugin(row)">
                {{ hasConfig(row) ? "配置" : "详情" }}
              </el-button>
              <el-button v-if="!row.builtin" size="small" type="danger" plain @click="confirmDelete(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <EmptyState v-else icon="cable" title="暂无插件" description="插件用于扩展搜索、下载、刮削、歌词、封面、设备投屏等功能">
          <template #action>
            <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
          </template>
        </EmptyState>
      </el-tab-pane>

      <!-- ============ Plugin marketplace ============ -->
      <el-tab-pane label="插件市场" name="market">
        <div class="page-header">
          <h2>插件市场</h2>
          <el-button type="primary" plain @click="loadMarketplace" :loading="marketLoading">刷新</el-button>
        </div>

        <el-card class="market-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span>注册表来源</span>
              <el-button size="small" type="primary" plain @click="showRegDialog = true">添加注册表</el-button>
            </div>
          </template>
          <el-table :data="registries" stripe v-if="registries.length > 0" size="small">
            <el-table-column prop="url" label="URL" min-width="320" show-overflow-tooltip />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.enabled ? 'success' : 'info'" effect="light">{{ row.enabled ? "启用" : "停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ row }">
                <el-button size="small" type="danger" plain @click="removeRegistry(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="尚未添加任何插件注册表" :image-size="60" />
        </el-card>

        <el-card class="market-card" shadow="never">
          <template #header><span>插件市场（官方内置 + 注册表）</span></template>
          <el-table :data="marketPlugins" stripe v-loading="marketLoading" v-if="marketPlugins.length > 0">
            <el-table-column label="名称" min-width="170">
              <template #default="{ row }">
                <div class="plugin-name">
                  {{ row.name }}
                  <el-tag v-if="row.builtin" size="small" type="warning" effect="light">内置</el-tag>
                </div>
                <div class="plugin-id">{{ row.id }}</div>
              </template>
            </el-table-column>
            <el-table-column label="来源" min-width="210">
              <template #default="{ row }">
                <template v-if="row.builtin">
                  <span class="src-builtin">随服务端发行</span>
                </template>
                <template v-else>
                  <div class="src-host">{{ sourceHost(row.sourceUrl) }}</div>
                  <div class="src-url">{{ row.sourceUrl }}</div>
                </template>
              </template>
            </el-table-column>
            <el-table-column label="平台" min-width="150">
              <template #default="{ row }">
                <div v-if="platformList(row).length > 0" class="cap-row">
                  <el-tag v-for="p in platformList(row)" :key="p.slug" size="small" effect="plain">{{ p.label }}</el-tag>
                </div>
                <span v-else class="src-builtin">—</span>
              </template>
            </el-table-column>
            <el-table-column label="类型 / 能力" min-width="200">
              <template #default="{ row }">
                <div class="cap-row">
                  <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
                  <el-tag v-for="cap in capabilityList(row).slice(0, 5)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="version" label="版本" width="86" />
            <el-table-column prop="description" label="说明" min-width="200" show-overflow-tooltip />
            <el-table-column label="状态" width="104">
              <template #default="{ row }">
                <!-- 内置核心插件不显示关闭按钮 -->
                <el-tag v-if="row.builtin" size="small" type="warning" effect="light">核心</el-tag>
                <el-switch v-else-if="row.installed" v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
                <el-tag v-else size="small" type="info" effect="light">未安装</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="190">
              <template #default="{ row }">
                <template v-if="!row.builtin">
                  <el-button v-if="!row.installed" size="small" type="success" plain :loading="installing === installKey(row)" @click="installPlugin(row)">安装</el-button>
                  <el-button v-else-if="isUpdatable(row)" size="small" type="primary" :loading="installing === installKey(row)" @click="installPlugin(row)">更新</el-button>
                  <el-button v-else size="small" plain :loading="installing === installKey(row)" @click="installPlugin(row)">重装</el-button>
                </template>
                <el-button size="small" plain @click="editPlugin(row)">详情</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="市场为空或注册表暂不可达" :image-size="60" />
          <p v-if="marketPlugins.length > 0" class="market-note">同一插件可能来自多个来源（注册表不同、支持的平台/版本不同），每个来源单独一行，请按平台选择你要安装的源头。</p>
        </el-card>
        <el-alert type="info" :closable="false" show-icon class="market-warn"
          title="插件运行模型与安全提示"
          description="内置插件随服务端发行,是核心功能(不可停用/删除);第三方插件在 QuickJS 沙箱中运行——拿不到 Node 进程能力,网络仅经受控的 host.http(需声明 net 权限),单插件内存/超时受限。但插件访问的外部服务地址仍由你配置,请仅从你信赖的注册表安装。" />
      </el-tab-pane>
    </el-tabs>

    <!-- Add plugin dialog -->
    <el-dialog v-model="showAddDialog" title="添加插件" width="500px">
      <el-form label-width="80px">
        <el-form-item label="插件名称"><el-input v-model="newPlugin.name" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="newPlugin.description" type="textarea" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addPlugin">添加</el-button>
      </template>
    </el-dialog>

    <!-- Add registry dialog -->
    <el-dialog v-model="showRegDialog" title="添加插件注册表" width="500px">
      <el-form label-width="80px">
        <el-form-item label="URL">
          <el-input v-model="newRegistryUrl" placeholder="https://example.com/registry.json" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRegDialog = false">取消</el-button>
        <el-button type="primary" :loading="addingReg" @click="addRegistry">添加</el-button>
      </template>
    </el-dialog>

    <!-- Plugin detail dialog: 功能介绍 / 处理逻辑 / 能力 / 权限 / 配置 -->
    <el-dialog v-model="showConfigDialog" :title="`插件详情 · ${displayName(editing)}`" width="720px" top="6vh">
      <div class="pd-head">
        <span class="pd-id">{{ editing?.id }}@{{ editing?.version }}</span>
        <el-tag size="small" :type="typeTagColor(editing)" effect="light">{{ typeLabel(editing) }}</el-tag>
        <el-tag v-if="editing?.builtin" size="small" type="warning" effect="light">内置</el-tag>
        <el-tag v-else-if="editing" size="small" type="info" effect="light">外置</el-tag>
      </div>

      <div class="pd-section">
        <h4>功能介绍</h4>
        <p class="pd-desc">{{ parseManifest(editing).description || "—" }}</p>
      </div>

      <div class="pd-section">
        <h4>处理逻辑</h4>
        <div v-if="docMarkdown" class="pd-md" v-html="docMarkdown"></div>
        <template v-else>
          <ul class="pd-capdocs">
            <li v-for="cap in capabilityList(editing)" :key="cap">{{ capLabel(cap) }}：{{ capDoc(cap) }}</li>
          </ul>
          <p v-if="capabilityList(editing).length" class="pd-hint">该插件未提供详细文档，以上为按能力自动生成的说明。</p>
          <p v-else class="pd-hint">该插件未提供详细文档。</p>
        </template>
      </div>

      <div v-if="capabilityList(editing).length > 0" class="pd-section">
        <h4>能力清单</h4>
        <div class="cap-row">
          <el-tag v-for="cap in capabilityList(editing)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
        </div>
      </div>

      <div v-if="permissionList(editing).length > 0" class="pd-section">
        <h4>权限</h4>
        <div class="cap-row">
          <el-tag v-for="perm in permissionList(editing)" :key="perm" size="small" type="warning" effect="plain">{{ permLabel(perm) }}</el-tag>
        </div>
      </div>

      <div v-if="canSaveConfig && configFields.length > 0" class="pd-section">
        <h4>配置</h4>
        <el-form label-width="120px">
          <!-- Config form is driven entirely by the plugin manifest's configSchema.
               No field is hardcoded to go-music-dl. -->
          <el-form-item v-for="f in configFields" :key="f.key" :label="f.label">
            <el-input
              v-if="f.type === 'text' || f.type === 'url'"
              v-model="editConfig[f.key]"
              :placeholder="f.help"
              style="width: 100%"
            />
            <el-input-number
              v-else-if="f.type === 'number'"
              v-model="editConfig[f.key]"
              :min="0"
              controls-position="right"
              style="width: 180px"
            />
            <el-radio-group v-else-if="f.type === 'radio'" v-model="editConfig[f.key]">
              <el-radio v-for="o in (f.options || [])" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
            </el-radio-group>
            <el-select v-else-if="f.type === 'select'" v-model="editConfig[f.key]" style="width: 100%">
              <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <el-select
              v-else-if="f.type === 'multiselect'"
              v-model="editConfig[f.key]"
              multiple
              collapse-tags
              style="width: 100%"
            >
              <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <el-switch v-else-if="f.type === 'switch'" v-model="editConfig[f.key]" />
            <span v-if="f.help" class="field-hint">{{ f.help }}</span>
          </el-form-item>

          <!-- Only source plugins expose a reachable endpoint to test / web songs to purge. -->
          <el-form-item v-if="isSourcePlugin(editing) || hasWebRotation">
            <el-button v-if="isSourcePlugin(editing)" type="success" plain :loading="testing" @click="testSource">测试连接</el-button>
            <el-button v-if="hasWebRotation" type="warning" plain :loading="purging" @click="purgeWebSongs">立即清理</el-button>
            <span v-if="testResult" class="test-result" :class="{ ok: testResult.success }">{{ testResult.message }}</span>
          </el-form-item>

          <el-alert
            type="info"
            :closable="false"
            show-icon
            :title="`${typeLabel(editing)}插件`"
            :description="pluginHint(editing)"
          />
        </el-form>
      </div>

      <template #footer>
        <el-button @click="showConfigDialog = false">关闭</el-button>
        <el-button v-if="canSaveConfig && configFields.length > 0" type="primary" :loading="saving" @click="() => saveConfig()">保存配置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api from "@/api";

const activeTab = ref<"installed" | "market">("installed");

// ---- installed plugins ----
const plugins = ref<any[]>([]);
const loading = ref(false);
const showAddDialog = ref(false);
const newPlugin = reactive({ name: "", description: "" });

// ---- marketplace ----
const registries = ref<any[]>([]);
const marketPlugins = ref<any[]>([]);
const marketLoading = ref(false);
const installing = ref<string>("");
const showRegDialog = ref(false);
const newRegistryUrl = ref("");
const addingReg = ref(false);

// ---- config dialog ----
const showConfigDialog = ref(false);
const editing = ref<any>(null);
const editConfig = reactive<any>({});
const testing = ref(false);
const saving = ref(false);
const purging = ref(false);
const testResult = ref<any>(null);

// ---- health ----
const healthMap = ref<Record<string, any>>({});

function parseManifest(plugin: any): any {
  const m = plugin?.manifest;
  if (!m) return {};
  return typeof m === "string" ? JSON.parse(m || "{}") : m;
}

function parseConfig(plugin: any) {
  try {
    return typeof plugin.config === "string" ? JSON.parse(plugin.config || "{}") : plugin.config || {};
  } catch {
    return {};
  }
}

/** Config fields rendered in the dialog — driven by the plugin manifest. */
const configFields = computed<any[]>(() => parseManifest(editing.value).configSchema || []);

/** Whether the plugin declares the web-rotation capability (shows the purge button). */
const hasWebRotation = computed<boolean>(() =>
  (parseManifest(editing.value).capabilities || []).includes("webRotation"),
);

function isSourcePlugin(plugin: any) {
  return parseManifest(plugin).type === "source";
}

/** Manifest display name, falling back to the stored row name (= plugin id). */
function displayName(plugin: any): string {
  return parseManifest(plugin).name || plugin?.name || "";
}

function hasConfig(plugin: any): boolean {
  return (parseManifest(plugin).configSchema || []).length > 0;
}

// 详情弹窗:处理逻辑(markdown)与配置可保存性
const docMarkdown = computed(() => {
  const md = parseManifest(editing.value).documentation;
  return md ? renderMarkdown(md) : "";
});
const canSaveConfig = computed(() => !!editing.value && editing.value.installed !== false);

// Plugin taxonomy — labels only. The backend decides what each type can do via
// manifest capabilities; the UI just renders whatever it declares.
const TYPE_LABELS: Record<string, string> = {
  source: "在线源",
  importer: "歌单导入",
  recommender: "推荐",
  sync: "同步",
  lyrics: "歌词",
  cover: "封面",
  renderer: "设备投屏",
  scrobbler: "播放上报",
};
const TYPE_COLORS: Record<string, string> = {
  source: "primary",
  importer: "success",
  recommender: "warning",
  sync: "info",
  lyrics: "danger",
  cover: "danger",
  renderer: "info",
  scrobbler: "info",
};
const CAP_LABELS: Record<string, string> = {
  search: "在线搜索",
  recommend: "平台推荐歌单",
  playlistSongs: "远程歌单曲目",
  stream: "音频流",
  lyrics: "在线歌词",
  webRotation: "在线歌曲轮换清理",
  playlistImport: "分享链接导入",
  playlistFile: "歌单文件导入",
  dailyPlaylist: "每日歌单生成",
  playlistSync: "歌单定时同步",
  autoMatch: "条目自动匹配",
  lyricProvider: "歌词提供方",
  coverProvider: "封面提供方",
  renderer: "设备投屏",
  scrobbler: "播放上报",
};
const PERM_LABELS: Record<string, string> = {
  log: "日志",
  storage: "存储",
  net: "网络",
  command: "命令",
  fs: "文件系统",
  "fs:music": "音乐目录",
  "fs:external": "外部目录",
  "songs:read": "读取歌曲",
  "songs:write": "写入歌曲",
  "playlists:read": "读取歌单",
  "playlists:write": "写入歌单",
  "inter-plugin": "插件间通信",
};

// 能力 → 处理逻辑说明(详情页在插件未提供 documentation 时按能力自动生成)
const CAP_DOCS: Record<string, string> = {
  search: "向在线源发起歌曲搜索并返回结果",
  recommend: "生成平台每日推荐歌单并同步到本地",
  playlistSongs: "拉取单个远程歌单的曲目列表",
  stream: "构造歌曲的音频流地址供播放器拉流",
  lyrics: "提供在线歌词（逐字/逐行）",
  webRotation: "定期清理过期的在线歌曲（每日推荐轮换）",
  playlistImport: "认领分享链接并解析成可导入的歌单",
  playlistFile: "认领上传的歌单文件并解析",
  dailyPlaylist: "每天定时生成「今日推荐」歌单",
  localPlaylist: "基于播放历史与收藏口味生成本地推荐",
  playlistSync: "定期重新拉取已导入的远程歌单",
  autoMatch: "把歌单条目自动匹配到曲库或在线源",
  lyricProvider: "提供在线歌词的源",
  coverProvider: "提供在线封面的源",
  renderer: "投屏到局域网播放设备（DLNA 等）",
  scrobbler: "把播放事件上报到 Last.fm / ListenBrainz 等",
};

// 极简 markdown 渲染（文档为受控内容,先转义再套标签,防 XSS）
function renderMarkdown(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc(md);
  html = html.replace(/^```\n?([\s\S]*?)```$/gm, (_m, c) => `<pre class="md-code">${c}</pre>`);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  let listOpen = false;
  for (const line of html.split("\n")) {
    if (line.startsWith("<li>")) {
      if (!listOpen) { out.push("<ul>"); listOpen = true; }
      out.push(line);
    } else {
      if (listOpen) { out.push("</ul>"); listOpen = false; }
      if (line.trim()) out.push(`<p>${line}</p>`);
    }
  }
  if (listOpen) out.push("</ul>");
  return out.join("\n");
}

function capDoc(cap: string): string {
  return CAP_DOCS[cap] || "参与对应能力的工作流";
}

function typeLabel(plugin: any): string {
  const t = parseManifest(plugin).type;
  return TYPE_LABELS[t] || t || "未知";
}

function typeTagColor(plugin: any): any {
  return TYPE_COLORS[parseManifest(plugin).type] || "info";
}

function capabilityList(plugin: any): string[] {
  return parseManifest(plugin).capabilities || [];
}

function permissionList(plugin: any): string[] {
  return parseManifest(plugin).permissions || [];
}

/** 平台标签:优先 manifest.platformLabels 的中文名,缺省回退 slug。 */
function platformList(plugin: any): { slug: string; label: string }[] {
  const m = parseManifest(plugin);
  const slugs: string[] = Array.isArray(m.platforms) ? m.platforms : [];
  const labels: Record<string, string> = m.platformLabels || {};
  return slugs.map((s) => ({ slug: s, label: labels[s] || s }));
}

function capLabel(cap: string): string {
  return CAP_LABELS[cap] || cap;
}

function permLabel(perm: string): string {
  return PERM_LABELS[perm] || perm;
}

// Health status -> tag color / label.
function healthType(id: string): any {
  const s = healthMap.value[id]?.status;
  if (s === "green") return "success";
  if (s === "yellow") return "warning";
  if (s === "red" || s === "down") return "danger";
  return "info";
}
function healthLabel(id: string): string {
  const s: string = healthMap.value[id]?.status || "unknown";
  return ({ green: "正常", yellow: "波动", red: "异常", down: "离线", unknown: "未知" } as Record<string, string>)[s] || "未知";
}

const TYPE_HINTS: Record<string, string> = {
  source: "填写在线源服务地址后,即可在「在线音乐搜索」中搜索并导入为在线歌曲。",
  importer: "停用后,对应平台的歌单分享链接 / 歌单文件将无法导入。",
  recommender: "停用后,不再自动生成对应的推荐歌单。",
  sync: "停用后,不再自动重新拉取已开启同步的歌单(手动同步仍可用)。",
  lyrics: "作为歌词提供方参与「能力优先」调度,首个可用方胜出。",
  cover: "作为封面提供方参与「能力优先」调度,首个可用方胜出。",
  renderer: "提供 DLNA / 设备投屏能力,可在播放器中选择设备投放。",
  scrobbler: "在播放 / 记录事件时上报到外部服务(如 Last.fm)。",
};

function pluginHint(plugin: any): string {
  const m = parseManifest(plugin);
  const extra = hasConfig(plugin) ? "" : "该插件无需额外配置,用开关启用/停用即可。";
  return [m.description, TYPE_HINTS[m.type], extra].filter(Boolean).join(" ");
}

function providerId(plugin: any): string {
  return parseManifest(plugin).id || "";
}

async function loadPlugins() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    plugins.value = (res.data || []).map((p: any) => ({ ...p, manifest: p.manifest, config: p.config }));
  } catch {
    plugins.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadHealth() {
  try {
    const res = await api.get("/rest/api/v1/plugins/health");
    const map: Record<string, any> = {};
    for (const h of res.data?.health || []) map[h.pluginId] = h;
    healthMap.value = map;
  } catch {
    healthMap.value = {};
  }
}

async function togglePlugin(plugin: any) {
  await api.put(`/rest/api/v1/plugins/${plugin.id}/toggle`);
  ElMessage.success("已更新");
  loadHealth();
}

/** 简单 semver 比较:<0 表示 a<b,=0 相等,>0 表示 a>b。 */
function verCmp(a: string, b: string): number {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** 已安装且市场版本比本地更高 → 显示「更新」按钮(覆盖安装即升级)。 */
function isUpdatable(row: any): boolean {
  return !!row.installed && !!row.installedVersion && verCmp(row.version, row.installedVersion) > 0;
}

/** 来源 host(如 raw.githubusercontent.com),用于区分同一插件的不同源头。 */
function sourceHost(url: string): string {
  try { return new URL(url).host; } catch { return url || "—"; }
}

/** 安装按钮的加载键:同 id 不同来源也要能独立显示 loading。 */
function installKey(row: any): string {
  return `${row.id}@${row.sourceUrl || "builtin"}`;
}

/** 删除外置插件(确认后调 DELETE /v1/plugins/:id)。 */
async function confirmDelete(row: any) {
  try {
    await ElMessageBox.confirm(
      `删除「${displayName(row)}」后将移除其插件文件与记录,确定删除吗?`,
      "删除插件",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await api.delete(`/rest/api/v1/plugins/${row.id}`);
    ElMessage.success("已删除");
    loadPlugins();
    loadHealth();
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "删除失败");
  }
}

function editPlugin(plugin: any) {
  editing.value = plugin;
  const cfg = parseConfig(plugin);
  const schema = parseManifest(plugin).configSchema || [];
  for (const key of Object.keys(editConfig)) delete editConfig[key];
  for (const f of schema) {
    let v = cfg[f.key];
    if (v === undefined) v = f.default;
    if (v === undefined) {
      if (f.type === "multiselect" || f.type === "select") v = [];
      else if (f.type === "switch") v = false;
      else if (f.type === "number") v = 0;
      else v = "";
    }
    editConfig[f.key] = v;
  }
  testResult.value = null;
  showConfigDialog.value = true;
}

async function testSource() {
  if (!editing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/test`, {});
    testResult.value = { success: res.data.success, message: res.data.message || res.data.error || "未知结果" };
  } catch (e: any) {
    testResult.value = { success: false, message: e?.response?.data?.error || e.message || "连接失败" };
  } finally {
    testing.value = false;
  }
}

async function saveConfig(opts?: { silent?: boolean }) {
  if (!editing.value) return;
  saving.value = true;
  try {
    const cfg: any = {};
    for (const f of configFields.value) cfg[f.key] = editConfig[f.key];
    await api.put(`/rest/api/v1/plugins/${editing.value.id}`, { config: cfg });
    if (!opts?.silent) {
      ElMessage.success("已保存");
      showConfigDialog.value = false;
      loadPlugins();
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function addPlugin() {
  if (!newPlugin.name) {
    ElMessage.warning("请输入插件名称");
    return;
  }
  await api.post("/rest/api/v1/plugins", newPlugin);
  showAddDialog.value = false;
  newPlugin.name = "";
  newPlugin.description = "";
  ElMessage.success("添加成功");
  loadPlugins();
}

async function purgeWebSongs() {
  if (!editing.value) return;
  purging.value = true;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/purge-web-songs`, {});
    if (res.data.success) {
      if (res.data.mode === "rotate") {
        ElMessage.success(`已清理 ${res.data.purged} 首歌曲,${res.data.covers} 张封面`);
      } else {
        ElMessage.info("当前为「永不过期」模式,未清理任何歌曲");
      }
    } else {
      ElMessage.warning(res.data.error || "清理失败");
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e.message || "清理失败");
  } finally {
    purging.value = false;
  }
}

// ---- marketplace ----
async function loadMarketplace() {
  marketLoading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins/registry");
    registries.value = res.data?.registries || [];
    marketPlugins.value = res.data?.plugins || [];
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "拉取插件市场失败");
    registries.value = [];
    marketPlugins.value = [];
  } finally {
    marketLoading.value = false;
  }
}

async function addRegistry() {
  if (!/^https?:\/\//.test(newRegistryUrl.value)) {
    ElMessage.warning("注册表 URL 必须是 http(s) 链接");
    return;
  }
  addingReg.value = true;
  try {
    await api.post("/rest/api/v1/plugins/registry", { url: newRegistryUrl.value });
    newRegistryUrl.value = "";
    showRegDialog.value = false;
    ElMessage.success("已添加");
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "添加失败");
  } finally {
    addingReg.value = false;
  }
}

async function removeRegistry(row: any) {
  try {
    await api.delete(`/rest/api/v1/plugins/registry/${row.id}`);
    ElMessage.success("已删除");
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "删除失败");
  }
}

async function installPlugin(row: any) {
  const key = installKey(row);
  installing.value = key;
  try {
    await api.post("/rest/api/v1/plugins/registry/install", { downloadUrl: row.downloadUrl || row.url });
    ElMessage.success(`已安装 ${row.name}`);
    loadMarketplace();
    loadPlugins();
    loadHealth();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "安装失败");
  } finally {
    installing.value = "";
  }
}

/** 切到「插件市场」标签页时自动刷新一次市场(注册表/插件列表)。 */
function onTabChange(name: string | number) {
  if (name === "market") loadMarketplace();
}

onMounted(() => {
  loadPlugins();
  loadHealth();
});
</script>

<style lang="scss" scoped>
.admin-plugins { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.test-result { margin-left: 12px; font-size: 13px; color: var(--el-color-danger); &.ok { color: var(--el-color-success); } }
.plugin-name { font-weight: 600; line-height: 1.35; }
.plugin-id { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.35; }
.cap-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.cap-label { font-size: 12px; color: var(--el-text-color-secondary); margin-right: 2px; }
.field-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; display: inline-block; max-width: 360px; }
.market-card { margin-bottom: 20px; }
.market-card .card-head { display: flex; justify-content: space-between; align-items: center; }
.market-warn { margin-top: 4px; }
.market-note { margin: 12px 4px 0; font-size: 12px; color: var(--el-text-color-secondary); }
.src-host { font-size: 13px; font-weight: 600; line-height: 1.4; }
.src-url { font-size: 11px; color: var(--el-text-color-secondary); line-height: 1.4; word-break: break-all; }
.src-builtin { font-size: 13px; color: var(--el-text-color-secondary); }
.pd-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.pd-id { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--el-text-color-secondary); }
.pd-section { margin-bottom: 18px; }
.pd-section h4 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--el-text-color-primary); }
.pd-desc { margin: 0; font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular); }
.pd-md { font-size: 13px; line-height: 1.75; color: var(--el-text-color-regular); }
.pd-md h2 { font-size: 15px; margin: 14px 0 6px; }
.pd-md h3 { font-size: 14px; margin: 12px 0 6px; }
.pd-md p { margin: 6px 0; }
.pd-md ul { margin: 6px 0; padding-left: 20px; }
.pd-md li { margin: 3px 0; }
.pd-md strong { font-weight: 600; }
.pd-md code { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--el-fill-color-light); padding: 1px 5px; border-radius: 4px; }
.pd-md pre.md-code { background: var(--el-fill-color-light); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.pd-capdocs { margin: 0; padding-left: 20px; }
.pd-capdocs li { font-size: 13px; line-height: 1.8; color: var(--el-text-color-regular); }
.pd-hint { margin: 8px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
@media (max-width: 768px) {
  .admin-plugins { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
}
</style>
