<template>
  <div class="flows-page">
    <div class="page-header">
      <h2>音流</h2>
      <el-button type="primary" @click="createFlow"><MfIcon name="Plus" />新建音流</el-button>
    </div>
    <div class="flows-tip">
      音流是一条可反复触发的自动播放流程:外部通过下方「对外链接」（Webhook）触发后,项目会在后台持续扫描 DLNA 设备,
      一旦指定的设备/设备组上线,就依次 设置音量 → 设置播放模式 → 播放指定内容(歌单/专辑/艺人/风格)。整条流程随两端节点编排,类似 Node-RED。
    </div>

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
          <span class="wh-label">对外链接</span>
          <IdBadge :id="f.webhookUrl || ''" copy-label="对外链接" style="min-width: 0" />
        </div>

        <!-- Node-RED 风格节点画线预览 -->
        <div class="flow-steps">
          <div class="step" :class="{ off: !hasTargets(f) }">
            <span class="step-icon"><MfIcon name="Radar" /></span>
            <span class="step-body">
              <span class="step-title">目标设备/组</span>
              <span class="step-desc">{{ targetSummary(f) }}</span>
            </span>
          </div>
          <div class="step-arrow"><span class="step-arrow-line"></span></div>
          <div class="step" :class="{ off: !f.definition.volume.enabled }">
            <span class="step-icon"><MfIcon name="Speaker" /></span>
            <span class="step-body">
              <span class="step-title">音量</span>
              <span class="step-desc">{{ f.definition.volume.enabled ? f.definition.volume.value + '%' : '未启用' }}</span>
            </span>
          </div>
          <div class="step-arrow"><span class="step-arrow-line"></span></div>
          <div class="step" :class="{ off: !f.definition.playmode.enabled }">
            <span class="step-icon"><MfIcon name="Shuffle" /></span>
            <span class="step-body">
              <span class="step-title">播放模式</span>
              <span class="step-desc">{{ f.definition.playmode.enabled ? modeText(f.definition.playmode.mode) : '未启用' }}</span>
            </span>
          </div>
          <div class="step-arrow"><span class="step-arrow-line"></span></div>
          <div class="step" :class="{ off: !f.definition.content.enabled }">
            <span class="step-icon"><MfIcon name="List" /></span>
            <span class="step-body">
              <span class="step-title">播放内容</span>
              <span class="step-desc">{{ contentSummary(f) }}</span>
            </span>
          </div>
        </div>

        <div class="flow-meta">
          <span v-if="f.lastRunAt" class="meta-time">最近运行:{{ formatTime(f.lastRunAt) }}</span>
          <span v-if="f.lastRunError" class="meta-error" :title="f.lastRunError">{{ f.lastRunError }}</span>
        </div>

        <div class="flow-actions">
          <el-button size="small" type="primary" @click="openEditor(f)"><MfIcon name="Pencil" />编辑</el-button>
          <el-button size="small" :disabled="!f.enabled" :loading="runningId === f.id" @click="runFlow(f)"><MfIcon name="Play" />运行</el-button>
          <el-button size="small" @click="toggleEnabled(f)">
            <MfIcon :name="f.enabled ? 'CircleSlash' : 'CircleCheck'" />
            {{ f.enabled ? '停用' : '启用' }}
          </el-button>
          <el-popconfirm
            title="确定删除该音流?触发链接将立即失效"
            confirm-button-text="删除"
            cancel-button-text="取消"
            width="240"
            @confirm="removeFlow(f)"
          >
            <template #reference>
              <el-button size="small" type="danger" plain><MfIcon name="Trash2" />删除</el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>

      <el-empty v-if="!loading && flows.length === 0" description="还没有音流">
        <el-button type="primary" @click="createFlow"><MfIcon name="Plus" />新建音流</el-button>
      </el-empty>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import api from "@/api";
import IdBadge from "@/components/IdBadge.vue";

const router = useRouter();
const flows = ref<any[]>([]);
const loading = ref(false);
const runningId = ref("");
const peers = ref<any[]>([]);

const MODE_TEXT: Record<string, string> = { order: "顺序播放", shuffle: "随机播放", all: "列表循环", one: "单曲循环" };
function modeText(m: string): string { return MODE_TEXT[m] || m; }

function peerName(peerId: string): string {
  const p = peers.value.find((x) => x.peerId === peerId);
  if (p) return p.kind === "local" ? "本机" : p.name;
  const id = peerId.split(":")[1] || peerId;
  return id.slice(0, 8) + "…";
}
function targetSummary(f: any): string {
  const t = f.definition.targets || [];
  if (t.length === 0) return "未配置";
  return t.map(peerName).join("、");
}
function contentSummary(f: any): string {
  const c = f.definition.content || {};
  if (!c.enabled || !c.id) return "未选择播放内容";
  const prefix: Record<string, string> = { playlist: "歌单", album: "专辑", artist: "艺人", genre: "风格" };
  const label = prefix[c.type] || prefix.playlist;
  return `${label}:${c.name || c.id}`;
}
function statusText(f: any): string {
  if (!f.enabled) return "已停用";
  const map: Record<string, string> = { waiting: "等待设备上线", playing: "播放中", success: "成功", error: "失败", timeout: "等待超时" };
  return f.lastRunAt ? (map[f.lastRunStatus] || "未运行") : "未运行";
}
function formatTime(t: string): string {
  if (!t) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function hasTargets(f: any): boolean { return (f.definition.targets || []).length > 0; }

async function loadPeers() {
  try {
    const res = await api.get("/rest/api/v1/peers");
    peers.value = (res.data?.peers || []).filter((p: any) => p.kind === "dlna" || p.kind === "group");
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
  try {
    const res = await api.post("/rest/api/v1/flows", { name: "新音流" });
    router.push(`/flows/${res.data.flow.id}`);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "新建失败");
  }
}
function openEditor(f: any) { router.push(`/flows/${f.id}`); }

async function runFlow(f: any) {
  if (runningId.value) return;
  runningId.value = f.id;
  try {
    await api.post(`/rest/api/v1/flows/${f.id}/run`);
    ElMessage.success("已触发,后台开始持续扫描设备");
    setTimeout(load, 1500);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "触发失败");
  } finally { runningId.value = ""; }
}

async function toggleEnabled(f: any) {
  try {
    await api.put(`/rest/api/v1/flows/${f.id}`, { enabled: !f.enabled });
    await load();
  } catch { ElMessage.error("操作失败"); }
}

async function removeFlow(f: any) {
  try {
    await api.delete(`/rest/api/v1/flows/${f.id}`);
    ElMessage.success(`已删除「${f.name}」`);
    await load();
  } catch { ElMessage.error("删除失败"); }
}

onMounted(() => { load(); loadPeers(); });
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