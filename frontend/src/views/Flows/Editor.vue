<template>
  <div class="flow-editor" v-loading="loading">
    <div class="editor-header">
      <el-button class="back-btn" circle size="small" @click="router.back()"><MfIcon name="ArrowLeft" /></el-button>
      <div class="editor-title-wrap">
        <input
          v-model="form.name"
          class="editor-title-input"
          placeholder="音流名称..."
          maxlength="50"
          @keyup.enter="save"
        />
        <span class="editor-tip">节点按顺序执行,可拖拽排序、任意插入;手动「立即执行」始终可用</span>
      </div>
      <div class="editor-tools">
        <el-switch v-model="form.enabled" active-text="启用" />
        <el-button type="primary" :loading="saving" @click="save"><MfIcon name="Check" />保存</el-button>
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
          <span class="node-name">{{ nodeMeta(node.type).label }}</span>
          <span class="node-drag-hint">⠿</span>
          <span class="node-ops">
            <el-button v-if="i > 0" link size="small" @click.stop="moveNode(i, -1)" title="上移"><MfIcon name="ChevronUp" /></el-button>
            <el-button v-if="i < nodes.length - 1" link size="small" @click.stop="moveNode(i, 1)" title="下移"><MfIcon name="ChevronDown" /></el-button>
            <el-button link size="small" @click.stop="duplicateNode(i)" title="复制"><MfIcon name="Copy" /></el-button>
            <el-button link size="small" type="danger" @click.stop="removeNode(i)" title="删除"><MfIcon name="Trash2" /></el-button>
          </span>
        </div>

        <div class="node-body">
          <!-- 触发节点 -->
          <template v-if="node.type === 'trigger'">
            <div class="trigger-info">
              <div class="token-row">
                <span class="token-label">鉴权渠道 Token</span>
                <el-select v-model="form.tokenId" placeholder="选择渠道 token" size="small" style="width: 260px" @change="onTokenChange">
                  <el-option v-for="t in tokens" :key="t.id" :label="`${t.name}${t.enabled ? '' : '(停用)'}`" :value="t.id" />
                </el-select>
              </div>
              <div class="wh-row">
                <span class="wh-label">对外链接</span>
                <IdBadge :id="webhookUrl" copy-label="对外链接" style="min-width: 0" />
              </div>
              <div v-if="!webhookUrl" class="wh-note">所选渠道 token 不存在或已停用,对外链接不可用。手动「立即执行」不受影响。</div>
              <div v-else class="wh-note">链接内已包含所绑定的私有 Token,勿公开分享。手动触发始终可用。</div>
            </div>
          </template>

          <!-- 目标设备/组 -->
          <template v-else-if="node.type === 'target'">
            <div class="field-row">
              <span class="field-label">目标设备/组(可多选;多个目标节点取并集)</span>
              <span class="field-hint">DLNA 设备与设备组自动列出,任一上线即继续</span>
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
                <span class="target-name">{{ p.kind === 'local' ? '本机' : p.name }}</span>
                <span class="target-id">{{ p.peerId }}</span>
              </label>
              <label v-if="castTargets.length > 1" class="target-chip target-chip--all" :class="{ checked: nodeAllChecked(node) }">
                <el-checkbox :model-value="nodeAllChecked(node)" size="small" @change="(v: any) => toggleNodeAllTargets(node, !!v)" />
                <span class="target-name">全选</span>
              </label>
              <div v-if="castTargets.length === 0" class="target-empty">暂无可投播放器(DLNA / AirPlay / 群组)。可到「播放器」页查看在线设备。</div>
            </div>
          </template>

          <!-- 播放内容 -->
          <template v-else-if="node.type === 'content'">
            <div class="select-row">
              <span class="select-label">内容类型</span>
              <el-select v-model="node.contentType" size="small" style="width: 140px" @change="onContentTypeChange(node)">
                <el-option v-for="(label, val) in CONTENT_TYPE_OPTIONS" :key="val" :label="label" :value="val" />
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
              <span class="select-label">推荐歌单</span>
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
                <el-option v-for="(label, val) in MODE_OPTIONS" :key="val" :label="label" :value="val" />
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
                <span class="inline-label">延迟(毫秒,0-3600000)</span>
                <el-input-number v-model="node.ms" :min="0" :max="3600000" :step="100" controls-position="right" size="small" style="width: 180px" />
              </label>
            </div>
          </template>
        </div>
      </div>

      <!-- 每个节点下方:插入节点 -->
      <el-dropdown trigger="click" @command="(t: string) => insertNode(i + 1, t)">
        <div class="add-node-btn" @click.stop><MfIcon name="Plus" /> 插入节点</div>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="(m, t) in NODE_META" :key="t" :command="t"><MfIcon :name="m.icon" />{{ m.label }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 空状态:无节点 -->
    <div v-if="nodes.length === 0" class="empty-nodes">
      <div class="empty-title">还没有节点</div>
      <div class="empty-desc">旧版固定配置已作废,请从下方添加节点开始搭建(建议:触发 → 目标 → 播放内容 → 延迟 → 音量)。手动触发始终可用。</div>
      <el-dropdown trigger="click" @command="(t: string) => insertNode(0, t)">
        <el-button type="primary"><MfIcon name="Plus" />添加第一个节点</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="(m, t) in NODE_META" :key="t" :command="t"><MfIcon :name="m.icon" />{{ m.label }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div v-else class="end-node">结束</div>

    <!-- 高级设置:等待上线 -->
    <div class="adv-settings">
      <div class="adv-title">高级设置 — 等待目标上线</div>
      <div class="row-inline">
        <label class="inline-field">
          <span class="inline-label">等待超时(秒,0=无限)</span>
          <el-input-number v-model="form.waitTimeoutSec" :min="0" :max="86400" :step="10" controls-position="right" size="small" />
        </label>
        <label class="inline-field">
          <span class="inline-label">扫描间隔(秒)</span>
          <el-input-number v-model="form.scanIntervalSec" :min="2" :max="60" :step="1" controls-position="right" size="small" />
        </label>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import api from "@/api";
import IdBadge from "@/components/IdBadge.vue";
import MfIcon from "@/components/MfIcon.vue";

const route = useRoute();
const router = useRouter();
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

const NODE_META: Record<NodeType, { label: string; icon: string; cls: string }> = {
  trigger: { label: "触发 (Webhook)", icon: "Zap", cls: "node--trigger" },
  target: { label: "目标设备/组", icon: "Radar", cls: "node--target" },
  content: { label: "播放内容", icon: "ListMusic", cls: "node--content" },
  playmode: { label: "播放模式", icon: "Shuffle", cls: "node--mode" },
  volume: { label: "设置音量", icon: "Speaker", cls: "node--volume" },
  delay: { label: "延迟", icon: "Clock", cls: "node--delay" },
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
  order: "顺序播放",
  shuffle: "随机播放",
  all: "列表循环",
  one: "单曲循环",
};

const CONTENT_TYPE_OPTIONS: Record<string, string> = {
  playlist: "歌单",
  album: "专辑",
  artist: "艺人",
  genre: "风格",
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
  name: "新音流",
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
  const map: Record<string, string> = { playlist: "搜索并选择要播放的歌单", album: "搜索并选择专辑", artist: "搜索并选择艺人", genre: "搜索并选择风格" };
  return map[node.contentType || "playlist"] || "搜索并选择内容";
}

function contentOptionLabel(item: any, type: string): string {
  switch (type) {
    case "album": return `${item.name || ""}${item.artist ? ` — ${item.artist}` : ""}(${item.songCount || 0}首)`;
    case "artist": return `${item.name || ""}(${item.albumCount || 0}张专辑)`;
    case "genre": return `${item.name || ""}(${item.songCount || 0}首)`;
    default: return `${item.name || ""}(${item.songCount || 0}首 — ${platformLabel(item.sourcePlatform)})`;
  }
}

function platformLabel(platform?: string): string {
  if (platform === "qq") return "QQ";
  if (platform === "netease") return "网易云";
  return platform || "本地";
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
    ElMessage.error(e.response?.data?.error || "加载失败");
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
  if (!name) { ElMessage.warning("请填写音流名称"); return; }
  if (nodes.value.length === 0) { ElMessage.warning("请至少添加一个节点"); return; }
  const targetNodes = nodes.value.filter((n) => n.type === "target");
  if (targetNodes.length === 0) { ElMessage.warning("请添加「目标设备/组」节点"); return; }
  if (!targetNodes.some((n) => (n.targets || []).length > 0)) { ElMessage.warning("「目标设备/组」节点请至少勾选一个目标"); return; }
  const contentNodes = nodes.value.filter((n) => n.type === "content");
  if (contentNodes.some((n) => !n.id)) { ElMessage.warning("「播放内容」节点请选择要播放的内容(或删除该节点)"); return; }
  saving.value = true;
  try {
    const body = { name, enabled: form.enabled, tokenId: form.tokenId, definition: toDefinition() };
    if (isNew) {
      // 新建模式:点保存才真正创建(避免"没点保存就默认保存")。
      const res = await api.post("/rest/api/v1/flows", body);
      ElMessage.success("已创建");
    } else {
      await api.put(`/rest/api/v1/flows/${flowId}`, body);
      ElMessage.success("已保存");
    }
    router.push("/flows");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "保存失败");
  } finally { saving.value = false; }
}

// 新建模式:路由 /flows/new(不立即创建,点保存才 POST)。
const isNew = flowId === "new";

function initNewFlow() {
  form.name = "新音流";
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
