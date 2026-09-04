<template>
  <div class="flow-editor" v-loading="loading">
    <div class="editor-header">
      <el-button class="back-btn" circle size="small" @click="router.back()"><MfIcon name="ArrowLeft" /></el-button>
      <div class="editor-title-wrap">
        <input
          v-model="form.name"
          class="editor-title-input"
          :placeholder="t('flows.namePlaceholder')"
          maxlength="50"
          @keyup.enter="save"
        />
        <span class="editor-tip">{{ t('flows.editorTip') }}</span>
      </div>
      <div class="editor-tools">
        <el-switch v-model="form.enabled" :active-text="t('flows.enable')" />
        <el-button type="primary" :loading="saving" @click="save"><MfIcon name="Check" />{{ t('common.save') }}</el-button>
      </div>
    </div>

    <!-- 节点列表(可拖拽排序) -->
    <div
      v-for="(node, i) in nodes"
      :key="node.uid"
      class="node-wrap"
      :class="{ 'drag-over': dragOverIndex === i && dragIndex >= 0 && dragIndex !== i }"
    >
      <div
        class="node"
        :class="[nodeMeta(node.type).cls, { dragging: dragIndex === i }]"
        draggable="true"
        @dragstart="onDragStart(i, $event)"
        @dragover.prevent="onDragOver(i)"
        @drop.prevent="onDrop(i)"
        @dragend="onDragEnd"
      >
        <div class="node-head">
          <span class="node-icon"><MfIcon :name="nodeMeta(node.type).icon" /></span>
          <span class="node-name">{{ t(nodeMeta(node.type).labelKey) }}</span>
          <span class="node-drag-hint">⠿</span>
          <span class="node-ops">
            <el-button v-if="i > 0" link size="small" @click.stop="moveNode(i, -1)" :title="t('common.moveUp')"><MfIcon name="ChevronUp" /></el-button>
            <el-button v-if="i < nodes.length - 1" link size="small" @click.stop="moveNode(i, 1)" :title="t('common.moveDown')"><MfIcon name="ChevronDown" /></el-button>
            <el-button link size="small" @click.stop="duplicateNode(i)" :title="t('common.copy')"><MfIcon name="Copy" /></el-button>
            <el-button link size="small" type="danger" @click.stop="removeNode(i)" :title="t('common.delete')"><MfIcon name="Trash2" /></el-button>
          </span>
        </div>

        <div class="node-body">
          <!-- 触发节点 -->
          <template v-if="node.type === 'trigger'">
            <div class="trigger-info">
              <div class="token-row">
                <span class="token-label">{{ t('flows.tokenLabel') }}</span>
                <el-select v-model="form.tokenId" :placeholder="t('flows.tokenPlaceholder')" size="small" style="width: 260px" @change="onTokenChange">
                  <el-option v-for="tk in tokens" :key="tk.id" :label="tk.name + (tk.enabled ? '' : '(' + t('flows.deactivated') + ')')" :value="tk.id" />
                </el-select>
              </div>
              <div class="wh-row">
                <span class="wh-label">{{ t('flows.webhookLabel') }}</span>
                <IdBadge :id="webhookUrl" :copy-label="t('flows.webhookLabel')" style="min-width: 0" />
              </div>
              <div v-if="!webhookUrl" class="wh-note">{{ t('flows.whNoteDisabled') }}</div>
              <div v-else class="wh-note">{{ t('flows.whNoteReady') }}</div>
            </div>
          </template>

          <!-- 目标设备/组 -->
          <template v-else-if="node.type === 'target'">
            <div class="field-row">
              <span class="field-label">{{ t('flows.targetFieldLabel') }}</span>
              <span class="field-hint">{{ t('flows.targetFieldHint') }}</span>
            </div>
            <div class="target-list">
              <label
                v-for="p in castTargets"
                :key="p.peerId"
                class="target-chip"
                :class="{ checked: (node.targets || []).includes(p.peerId) }"
              >
                <el-checkbox
                  :model-value="(node.targets || []).includes(p.peerId)"
                  size="small"
                  @change="(v: any) => setNodeTarget(node, p.peerId, !!v)"
                />
                <MfIcon :name="p.kind === 'group' ? 'Box' : 'Monitor'" class="target-icon" />
                <span class="target-name">{{ p.kind === 'local' ? t('flows.localPeer') : p.name }}</span>
                <span class="target-id">{{ p.peerId }}</span>
              </label>
              <label v-if="castTargets.length > 1" class="target-chip target-chip--all" :class="{ checked: nodeAllChecked(node) }">
                <el-checkbox :model-value="nodeAllChecked(node)" size="small" @change="(v: any) => toggleNodeAllTargets(node, !!v)" />
                <span class="target-name">{{ t('flows.selectAll') }}</span>
              </label>
              <div v-if="castTargets.length === 0" class="target-empty">{{ t('flows.noCastDevice') }}</div>
            </div>
          </template>

          <!-- 播放内容 -->
          <template v-else-if="node.type === 'content'">
            <div class="select-row">
              <span class="select-label">{{ t('flows.contentType') }}</span>
              <el-select v-model="node.contentType" size="small" style="width: 140px" @change="onContentTypeChange(node)">
                <el-option v-for="(labelKey, val) in CONTENT_TYPE_OPTIONS" :key="val" :label="t(labelKey)" :value="val" />
              </el-select>
            </div>
            <div class="select-row select-row--content">
              <el-select
                v-model="node.id"
                filterable
                remote
                clearable
                :remote-method="(q: string) => onContentRemoteSearch(node, q)"
                :loading="contentLoading"
                :placeholder="contentPlaceholder(node)"
                size="small"
                style="width: 100%"
                @change="(id: string) => onContentChange(node, id)"
              >
                <el-option v-for="opt in contentOptions" :key="opt.id" :label="opt.label" :value="opt.id" />
              </el-select>
            </div>
            <div v-if="node.contentType === 'playlist' && recommendCards.length" class="select-row select-row--recommend">
              <span class="select-label">{{ t('flows.recommendPlaylist') }}</span>
              <div class="recommend-chips">
                <el-tag
                  v-for="card in recommendCards"
                  :key="card.playlistId"
                  class="recommend-chip"
                  :class="{ active: node.id === card.playlistId }"
                  :type="node.id === card.playlistId ? 'primary' : 'info'"
                  effect="plain"
                  @click="pickRecommendCard(node, card)"
                >{{ card.name }}</el-tag>
              </div>
            </div>
            <div class="content-name" v-if="node.id && node.name">{{ node.name }}</div>
          </template>

          <!-- 播放模式 -->
          <template v-else-if="node.type === 'playmode'">
            <div class="select-row">
              <el-select v-model="node.mode" size="small" style="width: 220px">
                <el-option v-for="(labelKey, val) in MODE_OPTIONS" :key="val" :label="t(labelKey)" :value="val" />
              </el-select>
            </div>
          </template>

          <!-- 设置音量 -->
          <template v-else-if="node.type === 'volume'">
            <div class="slider-row">
              <el-slider v-model="node.value" :min="0" :max="100" :step="1" show-input size="small" />
            </div>
          </template>

          <!-- 延迟 -->
          <template v-else-if="node.type === 'delay'">
            <div class="row-inline">
              <label class="inline-field">
                <span class="inline-label">{{ t('flows.delayLabel') }}</span>
                <el-input-number v-model="node.ms" :min="0" :max="3600000" :step="100" controls-position="right" size="small" style="width: 180px" />
              </label>
            </div>
          </template>
        </div>
      </div>

      <!-- 每个节点下方:插入节点 -->
      <el-dropdown trigger="click" @command="(t: string) => insertNode(i + 1, t)">
        <div class="add-node-btn" @click.stop><MfIcon name="Plus" /> {{ t('flows.insertNode') }}</div>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="(meta, type) in NODE_META" :key="type" :command="type"><MfIcon :name="meta.icon" />{{ t(meta.labelKey) }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 空状态:无节点 -->
    <div v-if="nodes.length === 0" class="empty-nodes">
      <div class="empty-title">{{ t('flows.noNodesTitle') }}</div>
      <div class="empty-desc">{{ t('flows.noNodesDesc') }}</div>
      <el-dropdown trigger="click" @command="(t: string) => insertNode(0, t)">
        <el-button type="primary"><MfIcon name="Plus" />{{ t('flows.addFirstNode') }}</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="(meta, type) in NODE_META" :key="type" :command="type"><MfIcon :name="meta.icon" />{{ t(meta.labelKey) }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div v-else class="end-node">{{ t('flows.end') }}</div>

    <!-- 高级设置:等待上线 -->
    <div class="adv-settings">
      <div class="adv-title">{{ t('flows.advTitle') }}</div>
      <div class="row-inline">
        <label class="inline-field">
          <span class="inline-label">{{ t('flows.waitTimeout') }}</span>
          <el-input-number v-model="form.waitTimeoutSec" :min="0" :max="86400" :step="10" controls-position="right" size="small" />
        </label>
        <label class="inline-field">
          <span class="inline-label">{{ t('flows.scanInterval') }}</span>
          <el-input-number v-model="form.scanIntervalSec" :min="2" :max="60" :step="1" controls-position="right" size="small" />
        </label>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";
import IdBadge from "@/components/IdBadge.vue";
import MfIcon from "@/components/MfIcon.vue";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const flowId = route.params.id as string;

type NodeType = "trigger" | "target" | "content" | "playmode" | "volume" | "delay";

interface FlowNode {
  type: NodeType;
  uid: string;
  triggerType?: "webhook";
  targets?: string[];
  contentType?: string;
  id?: string;
  name?: string;
  startIndex?: number;
  mode?: string;
  value?: number;
  ms?: number;
}

const NODE_META: Record<NodeType, { labelKey: string; icon: string; cls: string }> = {
  trigger: { labelKey: "flows.nodeTrigger", icon: "Zap", cls: "node--trigger" },
  target: { labelKey: "flows.nodeTarget", icon: "Radar", cls: "node--target" },
  content: { labelKey: "flows.nodeContent", icon: "ListMusic", cls: "node--content" },
  playmode: { labelKey: "flows.nodePlaymode", icon: "Shuffle", cls: "node--mode" },
  volume: { labelKey: "flows.nodeVolume", icon: "Speaker", cls: "node--volume" },
  delay: { labelKey: "flows.nodeDelay", icon: "Clock", cls: "node--delay" },
};

function nodeMeta(t: NodeType) { return NODE_META[t]; }

function defaultNode(t: NodeType): FlowNode {
  const base: FlowNode = { type: t, uid: nextUid() };
  switch (t) {
    case "trigger": base.triggerType = "webhook"; break;
    case "target": base.targets = []; break;
    case "content": base.contentType = "playlist"; base.id = ""; base.startIndex = 0; break;
    case "playmode": base.mode = "shuffle"; break;
    case "volume": base.value = 20; break;
    case "delay": base.ms = 1000; break;
  }
  return base;
}

let uidSeq = 0;
function nextUid(): string { return "n" + Date.now().toString(36) + "-" + uidSeq++; }

const MODE_OPTIONS: Record<string, string> = {
  order: "flows.modeOrder",
  shuffle: "flows.modeShuffle",
  all: "flows.modeAll",
  one: "flows.modeOne",
};

const CONTENT_TYPE_OPTIONS: Record<string, string> = {
  playlist: "flows.contentPlaylist",
  album: "flows.contentAlbum",
  artist: "flows.contentArtist",
  genre: "flows.contentGenre",
};

const loading = ref(false);
const saving = ref(false);
const nodes = ref<FlowNode[]>([]);
const webhookUrl = ref("");
const tokens = ref<any[]>([]);
const tokensTemplateUrl = ref("");
const peers = ref<any[]>([]);
const contentOptions = ref<any[]>([]);
const contentLoading = ref(false);
const recommendCards = ref<any[]>([]);

const form = reactive({
  name: t('flows.newFlowName'),
  enabled: true,
  tokenId: "",
  waitTimeoutSec: 0,
  scanIntervalSec: 5,
});

// ---------- 拖拽排序 ----------
const dragIndex = ref(-1);
const dragOverIndex = ref(-1);
function onDragStart(i: number, e: DragEvent) {
  dragIndex.value = i;
  dragOverIndex.value = -1;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragOver(i: number) {
  if (dragIndex.value < 0 || dragIndex.value === i) { dragOverIndex.value = -1; return; }
  dragOverIndex.value = i;
}
function onDrop(i: number) {
  if (dragIndex.value < 0 || dragIndex.value === i) return;
  const arr = nodes.value;
  const [moved] = arr.splice(dragIndex.value, 1);
  arr.splice(i, 0, moved);
  dragIndex.value = -1;
  dragOverIndex.value = -1;
}
function onDragEnd() { dragIndex.value = -1; dragOverIndex.value = -1; }

function moveNode(i: number, dir: number) {
  const arr = nodes.value;
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function insertNode(index: number, t: string) {
  nodes.value.splice(index, 0, defaultNode(t as NodeType));
}

function removeNode(i: number) { nodes.value.splice(i, 1); }

function duplicateNode(i: number) {
  const src = nodes.value[i];
  const copy = JSON.parse(JSON.stringify(src));
  copy.uid = nextUid();
  nodes.value.splice(i + 1, 0, copy);
}

// ---------- 目标选择 ----------
const castTargets = computed(() =>
  (peers.value || []).filter((p: any) => (p.kind === "dlna" || p.kind === "group" || p.kind === "airplay") && p.name),
);

function setNodeTarget(node: FlowNode, peerId: string, checked: boolean) {
  node.targets = node.targets || [];
  const i = node.targets.indexOf(peerId);
  if (checked && i < 0) node.targets.push(peerId);
  if (!checked && i >= 0) node.targets.splice(i, 1);
}

function nodeAllChecked(node: FlowNode): boolean {
  const ids = node.targets || [];
  return castTargets.value.length > 0 && castTargets.value.every((p: any) => ids.includes(p.peerId));
}

function toggleNodeAllTargets(node: FlowNode, checked: boolean) {
  node.targets = node.targets || [];
  if (checked) {
    for (const p of castTargets.value) if (!node.targets.includes(p.peerId)) node.targets.push(p.peerId);
  } else {
    const set = new Set(castTargets.value.map((p: any) => p.peerId));
    node.targets = node.targets.filter((id) => !set.has(id));
  }
}

// ---------- 内容选择 ----------
const CONTENT_ENDPOINTS: Record<string, string> = {
  playlist: "/rest/api/v1/playlists",
  album: "/rest/api/v1/albums",
  artist: "/rest/api/v1/artists",
  genre: "/rest/api/v1/genres",
};

function contentPlaceholder(node: FlowNode): string {
  const map: Record<string, string> = { playlist: "flows.contentPhPlaylist", album: "flows.contentPhAlbum", artist: "flows.contentPhArtist", genre: "flows.contentPhGenre" };
  return t(map[node.contentType || "playlist"] || "flows.contentPhDefault");
}

function contentOptionLabel(item: any, type: string): string {
  switch (type) {
    case "album": return `${item.name || ""}${item.artist ? ` — ${item.artist}` : ""}${t('flows.optSongs', { count: item.songCount || 0 })}`;
    case "artist": return `${item.name || ""}${t('flows.optArtistSuffix', { count: item.albumCount || 0 })}`;
    case "genre": return `${item.name || ""}${t('flows.optSongs', { count: item.songCount || 0 })}`;
    default: return `${item.name || ""}${t('flows.optDefaultSuffix', { count: item.songCount || 0, platform: platformLabel(item.sourcePlatform) })}`;
  }
}

function platformLabel(platform?: string): string {
  if (platform === "qq") return "QQ";
  if (platform === "netease") return t('flows.platformNetease');
  return platform || t('flows.localSource');
}

async function fetchContentOptions(type: string, query: string) {
  contentLoading.value = true;
  try {
    const endpoint = CONTENT_ENDPOINTS[type] || CONTENT_ENDPOINTS.playlist;
    const params: any = { page: 1, pageSize: 50 };
    if (query.trim()) params.query = query.trim();
    const res = await api.get(endpoint, { params });
    const items: any[] = res.data?.items || [];
    contentOptions.value = items.map((o: any) => ({ id: o.id, label: contentOptionLabel(o, type), raw: o }));
  } catch {
    contentOptions.value = [];
  } finally { contentLoading.value = false; }
}

function onContentTypeChange(node: FlowNode) {
  node.id = "";
  node.name = "";
  fetchContentOptions(node.contentType || "playlist", "");
}

function onContentRemoteSearch(node: FlowNode, query: string) {
  fetchContentOptions(node.contentType || "playlist", query);
}

function onContentChange(node: FlowNode, id: string) {
  const opt = contentOptions.value.find((o: any) => o.id === id);
  node.name = opt ? String(opt.raw.name || opt.raw.id) : "";
}

function pickRecommendCard(node: FlowNode, card: any) {
  node.id = card.playlistId;
  node.name = card.name;
}

// ---------- 加载 ----------
async function loadRecommendCards() {
  try {
    const res = await api.get("/rest/api/v1/recommend/home-cards", { params: { all: "1" } });
    recommendCards.value = (res.data?.cards || []).filter((c: any) => c.playlistId);
  } catch { recommendCards.value = []; }
}

async function loadTokens() {
  try {
    const res = await api.get("/rest/api/v1/player-webhook/tokens");
    tokens.value = res.data?.items || [];
    tokensTemplateUrl.value = res.data?.templateUrl || `${location.origin}/webhook/player`;
  } catch { tokens.value = []; }
}

function buildWebhookUrl(): string {
  const tk = tokens.value.find((t) => t.id === form.tokenId && t.enabled);
  if (!tk) return "";
  const base = tokensTemplateUrl.value.replace(/\/webhook\/player$/, "");
  return `${base}/webhooks/flows/${flowId}?token=${encodeURIComponent(tk.token)}`;
}

function onTokenChange() { webhookUrl.value = buildWebhookUrl(); }

async function loadFlow() {
  loading.value = true;
  try {
    if (tokens.value.length === 0) await loadTokens();
    const res = await api.get(`/rest/api/v1/flows/${flowId}`);
    const f = res.data.flow;
    form.name = f.name;
    form.enabled = !!f.enabled;
    form.tokenId = f.tokenId || "";
    const d = f.definition || {};
    form.waitTimeoutSec = d.waitTimeoutSec ?? 0;
    form.scanIntervalSec = d.scanIntervalSec ?? 5;
    if (Array.isArray(d.nodes) && d.nodes.length > 0) {
      nodes.value = d.nodes.map((n: any) => ({ ...n, uid: nextUid() }));
    } else {
      nodes.value = [];
    }
    webhookUrl.value = buildWebhookUrl();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t('common.loadFailed'));
  } finally { loading.value = false; }
}

async function loadPeers() {
  try {
    const res = await api.get("/rest/api/v1/peers");
    peers.value = res.data?.peers || [];
  } catch { peers.value = []; }
}

function stripUid(n: FlowNode): any {
  const { uid, ...rest } = n;
  return rest;
}

function toDefinition() {
  return {
    nodes: nodes.value.map(stripUid),
    waitTimeoutSec: form.waitTimeoutSec,
    scanIntervalSec: form.scanIntervalSec,
  };
}

async function save() {
  const name = form.name.trim();
  if (!name) { ElMessage.warning(t('flows.needName')); return; }
  if (nodes.value.length === 0) { ElMessage.warning(t('flows.needNode')); return; }
  const targetNodes = nodes.value.filter((n) => n.type === "target");
  if (targetNodes.length === 0) { ElMessage.warning(t('flows.needTargetNode')); return; }
  if (!targetNodes.some((n) => (n.targets || []).length > 0)) { ElMessage.warning(t('flows.needCheckTarget')); return; }
  const contentNodes = nodes.value.filter((n) => n.type === "content");
  if (contentNodes.some((n) => !n.id)) { ElMessage.warning(t('flows.needContent')); return; }
  saving.value = true;
  try {
    const body = { name, enabled: form.enabled, tokenId: form.tokenId, definition: toDefinition() };
    if (isNew) {
      // 新建模式:点保存才真正创建(避免"没点保存就默认保存")。
      const res = await api.post("/rest/api/v1/flows", body);
      ElMessage.success(t('flows.created'));
    } else {
      await api.put(`/rest/api/v1/flows/${flowId}`, body);
      ElMessage.success(t('flows.saved'));
    }
    router.push("/flows");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t('flows.saveFailed'));
  } finally { saving.value = false; }
}

// 新建模式:路由 /flows/new(不立即创建,点保存才 POST)。
const isNew = flowId === "new";

function initNewFlow() {
  form.name = t('flows.newFlowName');
  form.enabled = true;
  form.tokenId = "";
  form.waitTimeoutSec = 0;
  form.scanIntervalSec = 5;
  // 默认模板:触发 → 目标 → 播放内容 → 设置音量(与后端 DEFAULT_DEFINITION 一致)。
  nodes.value = [
    defaultNode("trigger"),
    defaultNode("target"),
    defaultNode("content"),
    defaultNode("volume"),
  ];
  webhookUrl.value = buildWebhookUrl();
}

onMounted(() => {
  if (isNew) {
    loadTokens();
    initNewFlow();
  } else {
    loadFlow();
  }
  loadPeers(); fetchContentOptions("playlist", ""); loadRecommendCards();
});
</script>

<style lang="scss" scoped>
.flow-editor { padding: 24px 32px 130px; max-width: 860px; margin: 0 auto; }
.editor-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap;
  .back-btn { flex-shrink: 0; }
  .editor-title-wrap { flex: 1; min-width: 220px;
    .editor-title-input { width: 100%; background: transparent; border: none; border-bottom: 1px solid rgba(255,255,255,0.15); color: var(--fnos-text-primary); font-size: 20px; font-weight: 700; padding: 4px 0; outline: none;
      &:focus { border-bottom-color: var(--fnos-red); }
    }
    .editor-tip { display: block; font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; }
  }
  .editor-tools { display: flex; align-items: center; gap: 12px; }
}
.node-wrap { position: relative;
  &.drag-over .node { border-color: var(--fnos-red); box-shadow: 0 0 0 2px var(--fnos-red-soft); }
}
.node {
  background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.09); border-radius: 14px;
  padding: 12px 16px; transition: opacity 0.2s, border-color 0.15s, box-shadow 0.15s; cursor: grab;
  &.dragging { opacity: 0.4; }
  &:active { cursor: grabbing; }
  .node-head { display: flex; align-items: center; gap: 10px;
    .node-icon { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; color: #0f0f0f; }
    .node-name { font-size: 14px; font-weight: 600; flex: 1; }
    .node-drag-hint { font-size: 13px; color: var(--fnos-text-tertiary); letter-spacing: 1px; }
    .node-ops { display: flex; align-items: center; gap: 2px; }
  }
  .node-body { margin-top: 10px; }
}
.node--trigger .node-icon { background: #ffc52d; }
.node--target .node-icon { background: #5aa2ff; }
.node--volume .node-icon { background: #34d399; }
.node--mode .node-icon { background: #e879f9; }
.node--content .node-icon { background: var(--fnos-red); }
.node--delay .node-icon { background: #22d3ee; }

.add-node-btn { display: flex; align-items: center; justify-content: center; gap: 4px; margin: 8px 0; padding: 6px 0; border: 1px dashed rgba(255,255,255,0.18); border-radius: 10px; color: var(--fnos-text-secondary); font-size: 12px; cursor: pointer; transition: all 0.15s;
  &:hover { border-color: var(--fnos-red); color: var(--fnos-red); background: var(--fnos-red-soft); }
}

.empty-nodes { text-align: center; padding: 40px 20px; border: 1px dashed rgba(255,255,255,0.2); border-radius: 14px;
  .empty-title { font-size: 15px; font-weight: 600; color: var(--fnos-text-primary); }
  .empty-desc { font-size: 12px; color: var(--fnos-text-tertiary); margin: 8px 0 16px; line-height: 1.7; }
}
.end-node { text-align: center; font-size: 13px; color: var(--fnos-text-tertiary); padding: 6px 0; border: 1px dashed rgba(255,255,255,0.2); border-radius: 12px; margin-top: 8px; }
.adv-settings { margin-top: 16px; padding: 12px 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
  .adv-title { font-size: 12px; color: var(--fnos-text-secondary); margin-bottom: 10px; }
}
.wh-row { display: flex; align-items: center; gap: 10px;
  .wh-label { font-size: 12px; color: var(--fnos-text-tertiary); flex-shrink: 0; }
}
.wh-note { font-size: 11px; color: var(--fnos-text-muted); margin-top: 6px; }
.token-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;
  .token-label { font-size: 12px; color: var(--fnos-text-secondary); flex-shrink: 0; }
  .token-hint { font-size: 11px; color: var(--fnos-text-tertiary); }
}
.trigger-info { .wh-row { margin-top: 6px; } }
.field-row { margin-bottom: 8px;
  .field-label { font-size: 12px; color: var(--fnos-text-secondary); }
  .field-hint { font-size: 11px; color: var(--fnos-text-tertiary); margin-left: 8px; }
}
.target-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
  .target-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 6px 10px; font-size: 12px; cursor: pointer; transition: all 0.15s; background: rgba(255,255,255,0.03); user-select: none;
    .target-icon { color: var(--fnos-text-tertiary); font-size: 13px; }
    .target-name { font-weight: 500; }
    .target-id { font-family: ui-monospace, monospace; font-size: 10px; color: var(--fnos-text-muted); }
    &:hover { border-color: rgba(255,255,255,0.3); }
    &.checked { border-color: var(--fnos-red); background: var(--fnos-red-soft); }
    &.target-chip--all { opacity: 0.9; }
  }
  .target-empty { font-size: 12px; color: var(--fnos-text-muted); padding: 4px 0; }
}
.row-inline { display: flex; gap: 24px; flex-wrap: wrap;
  .inline-field { display: inline-flex; align-items: center; gap: 8px;
    .inline-label { font-size: 12px; color: var(--fnos-text-secondary); white-space: nowrap; }
  }
}
.slider-row { padding: 4px 4px 0; }
.select-row { display: flex; align-items: center; gap: 8px;
  .select-label { font-size: 12px; color: var(--fnos-text-secondary); flex-shrink: 0; }
  &.select-row--content { margin-top: 8px; }
  &.select-row--recommend { margin-top: 8px; flex-wrap: wrap; }
}
.recommend-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.recommend-chip { cursor: pointer; user-select: none; }
.content-name { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 6px; }

@media (max-width: 768px) {
  .flow-editor { padding: 20px 16px; }
  .editor-tools { width: 100%; justify-content: space-between; }
}
</style>
