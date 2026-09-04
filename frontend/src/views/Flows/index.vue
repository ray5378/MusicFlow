<template>
  <div class="flows-page">
    <div class="page-header">
      <h2>{{ t('flows.title') }}</h2>
      <el-button type="primary" @click="createFlow"><MfIcon name="Plus" />{{ t('flows.new') }}</el-button>
    </div>
    <div class="flows-tip">
      {{ t('flows.tip') }}
    </div>

    <!-- 通用播放器控制(独立模块,与音流流程解耦;音流的对外链接复用其渠道 token 做鉴权) -->
    <PlayerControl />

    <div class="flows-list" v-loading="loading">
      <div v-for="f in flows" :key="f.id" class="flow-card">
        <div class="flow-card-head">
          <div class="flow-name">
            <span class="flow-flag" :class="{ disabled: !f.enabled }"></span>
            <span class="flow-name-text">{{ f.name }}</span>
          </div>
          <div class="flow-status" :class="f.lastRunStatus || 'idle'">
            <MfIcon name="Loader2" v-if="f.lastRunStatus === 'waiting' || f.lastRunStatus === 'playing'" spin class="flow-status-icon" />
            <span>{{ statusText(f) }}</span>
          </div>
        </div>

        <div class="flow-webhook">
          <span class="wh-label">{{ t('flows.webhookLabel') }}</span>
          <IdBadge :id="f.webhookUrl || ''" :copy-label="t('flows.webhookLabel')" style="min-width: 0" />
        </div>

        <!-- 节点流程预览(节点化) -->
        <div class="flow-steps" v-if="nodeList(f).length">
          <template v-for="(n, i) in nodeList(f)" :key="i">
            <div class="step">
              <span class="step-icon" :style="{ background: nodeMeta(n.type).bg, color: nodeMeta(n.type).fg }"><MfIcon :name="nodeMeta(n.type).icon" /></span>
              <span class="step-body">
                <span class="step-title">{{ t(nodeMeta(n.type).titleKey) }}</span>
                <span class="step-desc">{{ nodeSummary(n) }}</span>
              </span>
            </div>
            <div v-if="i < nodeList(f).length - 1" class="step-arrow"><span class="step-arrow-line"></span></div>
          </template>
        </div>
        <div v-else class="flow-steps flow-steps--empty">{{ t('flows.noNodes') }}</div>

        <div class="flow-meta">
          <span v-if="f.lastRunAt" class="meta-time">{{ t('flows.lastRunAt', { time: formatTime(f.lastRunAt) }) }}</span>
          <span v-if="f.lastRunError" class="meta-error" :title="f.lastRunError">{{ f.lastRunError }}</span>
        </div>

        <div class="flow-actions">
          <el-button size="small" type="primary" @click="openEditor(f)"><MfIcon name="Pencil" />{{ t('flows.edit') }}</el-button>
          <el-button size="small" :disabled="!f.enabled" :loading="runningId === f.id" @click="runFlow(f)"><MfIcon name="Play" />{{ t('flows.run') }}</el-button>
          <el-button size="small" @click="toggleEnabled(f)">
            <MfIcon :name="f.enabled ? 'CircleSlash' : 'CircleCheck'" />
            {{ f.enabled ? t('flows.disable') : t('flows.enable') }}
          </el-button>
          <el-popconfirm
            :title="t('flows.deleteConfirm')"
            :confirm-button-text="t('common.delete')"
            :cancel-button-text="t('common.cancel')"
            width="240"
            @confirm="removeFlow(f)"
          >
            <template #reference>
              <el-button size="small" type="danger" plain><MfIcon name="Trash2" />{{ t('common.delete') }}</el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>

      <el-empty v-if="!loading && flows.length === 0" :description="t('flows.empty')">
        <el-button type="primary" @click="createFlow"><MfIcon name="Plus" />{{ t('flows.new') }}</el-button>
      </el-empty>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onActivated } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";
import IdBadge from "@/components/IdBadge.vue";
import PlayerControl from "./PlayerControl.vue";

const router = useRouter();
const { t } = useI18n();
const flows = ref<any[]>([]);
const loading = ref(false);
const runningId = ref("");
const peers = ref<any[]>([]);

const MODE_TEXT: Record<string, string> = { order: "flows.modeOrder", shuffle: "flows.modeShuffle", all: "flows.modeAll", one: "flows.modeOne" };
function modeText(m: string): string { return MODE_TEXT[m] ? t(MODE_TEXT[m]) : m; }

const NODE_META: Record<string, { icon: string; titleKey: string; bg: string; fg: string }> = {
  trigger: { icon: "Zap", titleKey: "flows.nodeTrigger", bg: "rgba(255,197,45,0.18)", fg: "#ffc52d" },
  target: { icon: "Radar", titleKey: "flows.nodeTarget", bg: "rgba(90,162,255,0.18)", fg: "#5aa2ff" },
  content: { icon: "ListMusic", titleKey: "flows.nodeContent", bg: "rgba(255,90,90,0.18)", fg: "var(--fnos-red)" },
  playmode: { icon: "Shuffle", titleKey: "flows.nodePlaymode", bg: "rgba(232,121,249,0.18)", fg: "#e879f9" },
  volume: { icon: "Speaker", titleKey: "flows.nodeVolume", bg: "rgba(52,211,153,0.18)", fg: "#34d399" },
  delay: { icon: "Clock", titleKey: "flows.nodeDelay", bg: "rgba(34,211,238,0.18)", fg: "#22d3ee" },
};

function nodeMeta(t: string) { return NODE_META[t] || { icon: "Workflow", titleKey: "", bg: "rgba(255,255,255,0.1)", fg: "var(--fnos-text-secondary)" }; }

function nodeList(f: any): any[] { return f.definition?.nodes || []; }

function nodeSummary(n: any): string {
  switch (n.type) {
    case "trigger": return t('flows.summaryTrigger');
    case "target": {
      const tgt = n.targets || [];
      return tgt.length ? tgt.map(peerName).join("、") : t('flows.noTarget');
    }
    case "content": {
      if (!n.id) return t('flows.noContent');
      const prefix: Record<string, string> = { playlist: "flows.contentPlaylist", album: "flows.contentAlbum", artist: "flows.contentArtist", genre: "flows.contentGenre" };
      return `${t(prefix[n.contentType] || "flows.contentPlaylist")}:${n.name || n.id}`;
    }
    case "playmode": return modeText(n.mode);
    case "volume": return `${n.value ?? 0}%`;
    case "delay": return `${n.ms ?? 0}ms`;
    default: return "";
  }
}

function peerName(peerId: string): string {
  const p = peers.value.find((x) => x.peerId === peerId);
  if (p) return p.kind === "local" ? t('flows.localPeer') : p.name;
  const id = peerId.split(":")[1] || peerId;
  return id.slice(0, 8) + "…";
}
function statusText(f: any): string {
  if (!f.enabled) return t('flows.statusDisabled');
  const map: Record<string, string> = { waiting: "flows.statusWaiting", playing: "flows.statusPlaying", success: "flows.statusSuccess", error: "flows.statusError", timeout: "flows.statusTimeout" };
  return f.lastRunAt ? (map[f.lastRunStatus] ? t(map[f.lastRunStatus]) : t('flows.statusNotRun')) : t('flows.statusNotRun');
}
function formatTime(t: string): string {
  if (!t) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function hasTargets(f: any): boolean { return (f.definition?.nodes || []).some((n: any) => n.type === "target" && (n.targets || []).length > 0); }

async function loadPeers() {
  try {
    const res = await api.get("/rest/api/v1/peers");
    peers.value = (res.data?.peers || []).filter((p: any) => p.kind === "dlna" || p.kind === "group" || p.kind === "airplay");
  } catch { peers.value = []; }
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/flows");
    flows.value = res.data?.items || [];
  } catch { flows.value = []; }
  finally { loading.value = false; }
}

async function createFlow() {
  // 不立即创建(避免"没点保存就默认保存"):跳转新建模式,点保存才 POST 创建。
  router.push("/flows/new");
}
function openEditor(f: any) { router.push(`/flows/${f.id}`); }

async function runFlow(f: any) {
  if (runningId.value) return;
  runningId.value = f.id;
  try {
    await api.post(`/rest/api/v1/flows/${f.id}/run`);
    ElMessage.success(t('flows.triggered'));
    setTimeout(load, 1500);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t('flows.triggerFailed'));
  } finally { runningId.value = ""; }
}

async function toggleEnabled(f: any) {
  try {
    await api.put(`/rest/api/v1/flows/${f.id}`, { enabled: !f.enabled });
    await load();
  } catch { ElMessage.error(t('common.operationFailed')); }
}

async function removeFlow(f: any) {
  try {
    await api.delete(`/rest/api/v1/flows/${f.id}`);
    ElMessage.success(t('flows.deleted', { name: f.name }));
    await load();
  } catch { ElMessage.error(t('flows.deleteFailed')); }
}

onMounted(() => { load(); loadPeers(); });
// keep-alive 下组件复用,onMounted 不重跑;从编辑器保存返回时激活即刷新列表,
// 无需手动刷新(参考 Playlists/index.vue 同模式)。
onActivated(() => { load(); });
</script>

<style lang="scss" scoped>
.flows-page { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; }
}
.flows-tip {
  font-size: 12px; color: var(--fnos-text-tertiary); background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08); border-left: 3px solid var(--fnos-red);
  border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; line-height: 1.6;
}
.flows-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; }
.flow-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
  border-radius: var(--fnos-radius); padding: 16px;
  transition: transform 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  &:hover { transform: translateY(-2px); background: rgba(255,255,255,0.07); box-shadow: 0 12px 30px rgba(0,0,0,0.4); }
  &:active { transform: translateY(0) scale(0.99); }
  .flow-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px;
    .flow-name { display: flex; align-items: center; gap: 8px; min-width: 0;
      .flow-flag { width: 8px; height: 8px; border-radius: 50%; background: var(--fnos-red); flex-shrink: 0;
        &.disabled { background: var(--fnos-text-muted); }
      }
      .flow-name-text { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    }
    .flow-status { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.06);
      color: var(--fnos-text-tertiary); white-space: nowrap;
      &.waiting, &.playing { color: var(--fnos-orange); }
      &.success { color: var(--fnos-green); }
      &.error, &.timeout { color: var(--fnos-red); }
    }
  }
  .flow-webhook { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; min-width: 0;
    .webhook-label { font-size: 12px; color: var(--fnos-text-tertiary); flex-shrink: 0; }
  }
  .flow-steps {
    background: rgba(0,0,0,0.18); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 10px 12px;
    &.flow-steps--empty { font-size: 12px; color: var(--fnos-text-tertiary); text-align: center; padding: 14px; }
    .step { display: flex; align-items: center; gap: 8px; opacity: 1;
      &.off { opacity: 0.45; }
      .step-icon { width: 24px; height: 24px; border-radius: 6px; background: var(--fnos-red-soft); color: var(--fnos-red); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; }
      .step-body { min-width: 0;
        .step-title { display: block; font-size: 12px; font-weight: 500; }
        .step-desc { display: block; font-size: 12px; color: var(--fnos-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      }
    }
    .step-arrow { display: flex; justify-content: center; padding: 1px 0;
      .step-arrow-line { width: 2px; height: 10px; background: rgba(255,255,255,0.18); border-radius: 2px; position: relative;
        &::after { content: ''; position: absolute; left: 50%; bottom: -2px; transform: translateX(-50%); border: 3px solid transparent; border-top-color: rgba(255,255,255,0.18); }
      }
    }
  }
  .flow-meta { margin: 10px 0 12px; font-size: 11px; color: var(--fnos-text-tertiary);
    .meta-error { color: var(--fnos-red); margin-left: 10px; display: inline-block; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  }
  .flow-actions { display: flex; gap: 8px; flex-wrap: wrap; }
}
@media (max-width: 768px) {
  .flows-page { padding: 20px 16px; }
  .flows-list { grid-template-columns: 1fr; }
  .flow-card { padding: 12px; }
}
</style>