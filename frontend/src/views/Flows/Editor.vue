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
        <span class="editor-tip">一条音流 = 等待设备/组上线 → 设音量 → 播放模式 → 播放内容</span>
      </div>
      <div class="editor-tools">
        <el-switch v-model="form.enabled" active-text="启用" />
        <el-button type="primary" :loading="saving" @click="save"><MfIcon name="Check" />保存</el-button>
      </div>
    </div>

    <!-- Webhook trigger node (top, always present) -->
    <div class="node node--trigger">
      <div class="node-head">
        <span class="node-icon"><MfIcon name="Zap" /></span>
        <span class="node-name">触发 (Webhook)</span>
        <span class="node-hint">外部工具直接打开/GET/POST 下方链接即可启动本音流</span>
      </div>
      <div class="node-body">
        <div class="wh-row">
          <span class="wh-label">对外链接</span>
          <IdBadge :id="webhookUrl" copy-label="对外链接" style="min-width: 0" />
        </div>
        <div class="wh-note">链接内已包含私有 Token,勿公开分享。</div>
      </div>
    </div>

    <div class="link-arrow"><span class="link-line"></span></div>

    <!-- Node 1: 目标设备/组 (等待上线 + 持续扫描) -->
    <div class="node node--target">
      <div class="node-head">
        <span class="node-icon"><MfIcon name="Radar" /></span>
        <span class="node-name">目标设备/组</span>
      </div>
      <div class="node-body">
        <div class="field-row">
          <span class="field-label">目标设备/组(勾选即选中,可多选)</span>
          <span class="field-hint">DLNA 设备与设备组会自动列出,任一上线即继续</span>
        </div>
        <div class="target-list">
          <label
            v-for="p in castTargets"
            :key="p.peerId"
            class="target-chip"
            :class="{ checked: form.targets.includes(p.peerId) }"
          >
            <el-checkbox
              :model-value="form.targets.includes(p.peerId)"
              size="small"
              @change="(v: any) => setTarget(p.peerId, !!v)"
            />
            <MfIcon :name="p.kind === 'group' ? 'Box' : 'Monitor'" class="target-icon" />
            <span class="target-name">{{ p.kind === 'local' ? '本机' : p.name }}</span>
            <span class="target-id">{{ p.peerId }}</span>
          </label>
          <label v-if="castTargets.length > 1" class="target-chip target-chip--all" :class="{ checked: allChecked }">
            <el-checkbox :model-value="allChecked" size="small" @change="(v: any) => toggleAllTargets(!!v)" />
            <span class="target-name">全选</span>
          </label>
          <div v-if="castTargets.length === 0" class="target-empty">暂无可投 DLNA 设备。可到「播放器群组」页扫描/编排。</div>
        </div>
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

    <div class="link-arrow"><span class="link-line"></span></div>

    <!-- Node 2: 音量 -->
    <div class="node node--volume">
      <div class="node-head">
        <span class="node-icon"><MfIcon name="Speaker" /></span>
        <span class="node-name">设置音量</span>
      </div>
      <div class="node-body">
        <div class="slider-row">
          <el-slider v-model="form.volumeValue" :min="0" :max="100" :step="1" show-input size="small" />
        </div>
      </div>
    </div>

    <div class="link-arrow"><span class="link-line"></span></div>

    <!-- Node 3: 播放模式 -->
    <div class="node node--mode">
      <div class="node-head">
        <span class="node-icon"><MfIcon name="Shuffle" /></span>
        <span class="node-name">播放模式</span>
      </div>
      <div class="node-body">
        <div class="select-row">
          <el-select v-model="form.playmodeMode" size="small" style="width: 220px">
            <el-option v-for="(label, val) in MODE_OPTIONS" :key="val" :label="label" :value="val" />
          </el-select>
        </div>
      </div>
    </div>

    <div class="link-arrow"><span class="link-line"></span></div>

    <!-- Node 4: 播放内容(歌单/专辑/艺人/风格) -->
    <div class="node node--content">
      <div class="node-head">
        <span class="node-icon"><MfIcon name="ListMusic" /></span>
        <span class="node-name">播放内容</span>
      </div>
      <div class="node-body">
        <div class="select-row">
          <span class="select-label">内容类型</span>
          <el-select v-model="form.contentType" size="small" style="width: 140px" @change="onContentTypeChange">
            <el-option v-for="(label, val) in CONTENT_TYPE_OPTIONS" :key="val" :label="label" :value="val" />
          </el-select>
        </div>
        <div class="select-row select-row--content">
          <el-select
            v-model="form.contentId"
            filterable
            remote
            clearable
            :remote-method="onContentRemoteSearch"
            :loading="contentLoading"
            :placeholder="contentPlaceholder"
            size="small"
            style="width: 100%"
            @change="onContentChange"
          >
            <el-option
              v-for="opt in contentOptions"
              :key="opt.id"
              :label="opt.label"
              :value="opt.id"
            />
          </el-select>
        </div>
        <div class="content-name" v-if="form.contentId && form.contentName">{{ form.contentName }}</div>
      </div>
    </div>

    <div class="link-arrow"><span class="link-line"></span></div>

    <div class="end-node">结束(投递到在线目标并开始播放)</div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import api from "@/api";
import IdBadge from "@/components/IdBadge.vue";

const route = useRoute();
const router = useRouter();
const flowId = route.params.id as string;

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
const webhookUrl = ref("");
const peers = ref<any[]>([]);
const contentOptions = ref<any[]>([]);
const contentLoading = ref(false);

const form = reactive({
  name: "新音流",
  enabled: true,
  targets: [] as string[],
  waitTimeoutSec: 0,
  scanIntervalSec: 5,
  volumeValue: 80,
  playmodeMode: "shuffle",
  contentType: "playlist",
  contentId: "",
  contentName: "",
});

const castTargets = computed(() =>
  (peers.value || []).filter((p: any) => (p.kind === "dlna" || p.kind === "group") && p.name),
);

const contentPlaceholder = computed(() => {
  const map: Record<string, string> = { playlist: "搜索并选择要播放的歌单", album: "搜索并选择专辑", artist: "搜索并选择艺人", genre: "搜索并选择风格" };
  return map[form.contentType] || "搜索并选择内容";
});

const CONTENT_ENDPOINTS: Record<string, string> = {
  playlist: "/rest/api/v1/playlists",
  album: "/rest/api/v1/albums",
  artist: "/rest/api/v1/artists",
  genre: "/rest/api/v1/genres",
};

function contentOptionLabel(item: any): string {
  switch (form.contentType) {
    case "album": return `${item.name || ""}${item.artist ? ` — ${item.artist}` : ""}(${item.songCount || 0}首)`;
    case "artist": return `${item.name || ""}(${item.albumCount || 0}张专辑)`;
    case "genre": return `${item.name || ""}(${item.songCount || 0}首)`;
    default: return `${item.name || ""}(${item.songCount || 0}首 — ${platformLabel(item.sourcePlatform)})`;
  }
}

async function fetchContentOptions(query: string) {
  contentLoading.value = true;
  try {
    const endpoint = CONTENT_ENDPOINTS[form.contentType] || CONTENT_ENDPOINTS.playlist;
    const params: any = { page: 1, pageSize: 50 };
    if (query.trim()) params.query = query.trim();
    const res = await api.get(endpoint, { params });
    const items: any[] = res.data?.items || [];
    contentOptions.value = items.map((o: any) => ({ id: o.id, label: contentOptionLabel(o), raw: o }));
  } catch {
    contentOptions.value = [];
  } finally { contentLoading.value = false; }
}

function setTarget(peerId: string, checked: boolean) {
  const i = form.targets.indexOf(peerId);
  if (checked && i < 0) form.targets.push(peerId);
  if (!checked && i >= 0) form.targets.splice(i, 1);
}

const allChecked = computed(() => castTargets.value.length > 0 && castTargets.value.every((p: any) => form.targets.includes(p.peerId)));

function toggleAllTargets(checked: boolean) {
  if (checked) {
    const ids = castTargets.value.map((p: any) => p.peerId);
    for (const id of ids) if (!form.targets.includes(id)) form.targets.push(id);
  } else {
    const ids = new Set(castTargets.value.map((p: any) => p.peerId));
    form.targets = form.targets.filter((id) => !ids.has(id));
  }
}

function onContentTypeChange() {
  form.contentId = "";
  form.contentName = "";
  fetchContentOptions("");
}

function onContentRemoteSearch(query: string) {
  fetchContentOptions(query);
}

function onContentChange(id: string) {
  const opt = contentOptions.value.find((o: any) => o.id === id);
  form.contentName = opt ? String(opt.raw.name || opt.raw.id) : "";
}

function platformLabel(platform?: string): string {
  if (platform === "qq") return "QQ";
  if (platform === "netease") return "网易云";
  return platform || "本地";
}

async function loadFlow() {
  loading.value = true;
  try {
    const res = await api.get(`/rest/api/v1/flows/${flowId}`);
    const f = res.data.flow;
    form.name = f.name;
    form.enabled = !!f.enabled;
    const d = f.definition;
    form.targets = [...(d.targets || [])];
    form.waitTimeoutSec = d.waitTimeoutSec ?? 0;
    form.scanIntervalSec = d.scanIntervalSec ?? 5;
    if (d.volume) { form.volumeValue = d.volume.value ?? 60; }
    if (d.playmode) { form.playmodeMode = d.playmode.mode || "order"; }
    if (d.content) {
      form.contentType = ["playlist", "album", "artist", "genre"].includes(d.content.type) ? d.content.type : "playlist";
      form.contentId = d.content.id || "";
      form.contentName = d.content.name || "";
    }
    webhookUrl.value = f.webhookUrl || "";
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

function toDefinition() {
  return {
    targets: [...form.targets],
    waitTimeoutSec: form.waitTimeoutSec,
    scanIntervalSec: form.scanIntervalSec,
    volume: { enabled: true, value: form.volumeValue },
    playmode: { enabled: true, mode: form.playmodeMode },
    content: {
      enabled: !!form.contentId,
      type: form.contentType,
      id: form.contentId,
      name: form.contentName || undefined,
      startIndex: 0,
    },
  };
}

async function save() {
  const name = form.name.trim();
  if (!name) { ElMessage.warning("请填写音流名称"); return; }
  if (form.targets.length === 0) { ElMessage.warning("请选择目标设备/组"); return; }
  if (!form.contentId) { ElMessage.warning("请选择要播放的内容"); return; }
  saving.value = true;
  try {
    await api.put(`/rest/api/v1/flows/${flowId}`, { name, enabled: form.enabled, definition: toDefinition() });
    ElMessage.success("已保存");
    router.push("/flows");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "保存失败");
  } finally { saving.value = false; }
}

onMounted(() => { loadFlow(); loadPeers(); fetchContentOptions(""); });
</script>

<style lang="scss" scoped>
.flow-editor { padding: 24px 32px 130px; max-width: 860px; margin: 0 auto; }
.editor-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap;
  .back-btn { flex-shrink: 0; }
  .editor-title-wrap { flex: 1; min-width: 220px;
    .editor-title-input { width: 100%; background: transparent; border: none; border-bottom: 1px solid rgba(255,255,255,0.15); color: var(--fnos-text-primary); font-size: 20px; font-weight: 700; padding: 4px 0; outline: none;
      &:focus { border-bottom-color: var(--fnos-red); }
    }
    .editor-tag { display: block; font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; }
  }
  .editor-tools { display: flex; align-items: center; gap: 12px; }
}
.node {
  background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.09); border-radius: 14px;
  padding: 12px 16px;
  transition: opacity 0.2s;
  &.node-off { opacity: 0.45; }
  .node-head { display: flex; align-items: center; gap: 10px;
    .node-icon { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0;
      color: #0f0f0f; }
    .node-name { font-size: 14px; font-weight: 600; flex: 1; }
    .node-hint { font-size: 11px; color: var(--fnos-text-tertiary); }
  }
  .node-body { margin-top: 10px; }
}
.node--trigger .node-icon { background: #ffc52d; }
.node--target .node-icon { background: #5aa2ff; }
.node--volume .node-icon { background: #34d399; }
.node--mode .node-icon { background: #e879f9; }
.node--content .node-icon { background: var(--fnos-red); }

.link-arrow { display: flex; justify-content: center; padding: 2px 0;
  .link-line { width: 2px; height: 14px; background: rgba(255,255,255,0.22); border-radius: 2px; position: relative;
    &::after { content: ''; position: absolute; left: 50%; bottom: -3px; transform: translateX(-50%); border: 4px solid transparent; border-top-color: rgba(255,255,255,0.28); }
  }
}
.end-node { text-align: center; font-size: 13px; color: var(--fnos-text-tertiary); padding: 6px 0; border: 1px dashed rgba(255,255,255,0.2); border-radius: 12px; }

.end-node { text-align: center; font-size: 13px; color: var(--fnos-text-tertiary); padding: 6px 0; border: 1px dashed rgba(255,255,255,0.2); border-radius: 12px; }

.wh-row { display: flex; align-items: center; gap: 10px;
  .wh-label { font-size: 12px; color: var(--fnos-text-tertiary); flex-shrink: 0; }
}
.wh-note { font-size: 11px; color: var(--fnos-text-muted); margin-top: 6px; }

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
}
.content-name { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 6px; }

@media (max-width: 768px) {
  .flow-editor { padding: 20px 16px; }
  .editor-tools { width: 100%; justify-content: space-between; }
}
</style>
