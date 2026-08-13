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

    <!-- ==================== 通用播放器控制(与音流流程解耦) ==================== -->
    <div class="player-ctl">
      <div class="player-ctl-head">
        <span class="player-ctl-title"><MfIcon name="SlidersHorizontal" />通用播放器控制</span>
        <span class="player-ctl-tip">与音流(流程)无关:下方 URL 的参数就是配置,可直接控制已上线的 DLNA 音箱 / 播放器群组,无需内部流程。可手工增删改参数、可重复使用、支持一次串联多个动作。</span>
        <div class="player-ctl-tokenrow">
          <el-select v-model="ctlTokenId" placeholder="选择渠道 token" style="width: 220px" @change="urlText = buildPlayerUrl()">
            <el-option v-for="t in ctlTokens" :key="t.id" :label="`${t.name}${t.enabled ? '' : '(停用)'}`" :value="t.id" />
          </el-select>
          <el-button size="small" plain :class="{ active: showTokens }" @click="showTokens = !showTokens"><MfIcon name="KeyRound" />管理 Token</el-button>
        </div>
      </div>

      <!-- Token 管理面板:独立多条 token,各自启用/停用/删除,有效性由用户自管 -->
      <div v-if="showTokens" class="player-tokens">
        <div class="tokens-row" v-for="t in ctlTokens" :key="t.id">
          <div class="tokens-info">
            <div class="tokens-name">
              <span class="tokens-dot" :class="{ off: !t.enabled }"></span>
              <span class="tokens-text">{{ t.name }}</span>
            </div>
            <div class="tokens-token">{{ t.token }}</div>
            <div class="tokens-meta">归属「我喜欢」:{{ t.ownerName || '-' }} · 创建 {{ formatTime(t.createdAt) }}</div>
          </div>
          <div class="tokens-ops">
            <el-switch v-model="t.enabled" :loading="busyToken === t.id" @change="(val: any) => toggleToken(t, !!val)" />
            <el-button size="small" type="danger" plain :loading="busyToken === t.id" @click="removeToken(t)">删除</el-button>
          </div>
        </div>
        <div class="tokens-create">
          <el-input v-model="newTokenName" placeholder="新 token 名称,如:客厅音箱/临时授权…" style="width: 260px" maxlength="40" @keyup.enter="createToken" />
          <el-button size="small" type="primary" :loading="busyToken === 'new'" @click="createToken"><MfIcon name="Plus" />新建 token</el-button>
        </div>
        <div class="tokens-note">操作说明:每个 token 独立有效,停用 = 旧链接立即返回 403,删除 = 链接永久失效(401/404)。「我喜欢」归属各 token 创建者。</div>
      </div>

      <div class="player-ctl-body">
        <div class="ctl-grid">
          <div class="ctl-field">
            <span class="ctl-label">目标播放器</span>
            <el-select v-model="ctl.device" placeholder="选择 DLNA 设备/群组" filterable clearable style="width: 100%">
              <el-option label="全部在线播放器 (all)" value="all" />
              <el-option v-for="p in ctlTargets" :key="p.peerId" :label="p.kind === 'group' ? `${p.name}(组)` : p.name" :value="p.peerId" />
            </el-select>
          </div>

          <div class="ctl-field">
            <span class="ctl-label">播放模式</span>
            <el-select v-model="ctl.mode" clearable placeholder="不改变" style="width: 100%">
              <el-option v-for="(mn, mv) in MODE_TEXT" :key="mv" :label="mn" :value="mv" />
            </el-select>
          </div>

          <div class="ctl-field">
            <span class="ctl-label">音量(0-100 或 +N/-N)</span>
            <el-input-number v-model="ctl.volume" :min="0" :max="100" :step="1" controls-position="right" placeholder="留空则不变" style="width: 100%" />
          </div>

          <div class="ctl-field">
            <span class="ctl-label">传输控制</span>
            <div class="ctl-transport">
              <el-checkbox v-model="ctl.play">播放</el-checkbox>
              <el-checkbox v-model="ctl.pause">暂停</el-checkbox>
              <el-checkbox v-model="ctl.stop">停止</el-checkbox>
              <el-checkbox v-model="ctl.prev">上一首</el-checkbox>
              <el-checkbox v-model="ctl.next">下一首</el-checkbox>
            </div>
          </div>

          <div class="ctl-field">
            <span class="ctl-label">动作</span>
            <el-checkbox v-model="ctl.favorite">把当前播放曲加入「我喜欢」</el-checkbox>
          </div>
        </div>

        <div class="ctl-preview">
          <span class="ctl-label">生成链接(可手工编辑参数)</span>
          <div class="ctl-url-row">
            <el-input v-model.trim="urlText" type="textarea" :rows="2" resize="vertical" readonly class="ctl-url" />
            <div class="ctl-url-actions">
              <el-button size="small" @click="onCopyUrl"><MfIcon name="Copy" />复制</el-button>
              <el-button size="small" type="primary" :loading="testing" @click="testUrl"><MfIcon name="Play" />执行测试</el-button>
            </div>
          </div>
          <div class="ctl-order">执行顺序:播放模式 → 播放/暂停/停止/上一首/下一首 → 音量 → 收藏当前曲;参数留空即跳过,可任意组合。</div>
        </div>
      </div>
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
import { ref, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import api from "@/api";
import IdBadge from "@/components/IdBadge.vue";

const router = useRouter();
const flows = ref<any[]>([]);
const loading = ref(false);
const runningId = ref("");
const peers = ref<any[]>([]);

// ---- 通用播放器控制 ----
const ctl = ref({ device: "", mode: "", volume: null as number | null, play: false, pause: false, stop: false, prev: false, next: false, favorite: false });
const ctlTokens = ref<any[]>([]);
const ctlTokenId = ref("");
const ctlTemplateUrl = ref("");
const ctlTargets = ref<any[]>([]);
const urlText = ref("");
const testing = ref(false);
const showTokens = ref(false);
const newTokenName = ref("");
const busyToken = ref("");

watch(ctl, () => { urlText.value = buildPlayerUrl(); }, { deep: true });

function buildPlayerUrl(): string {
  const p = ctl.value;
  const qs: string[] = [];
  if (ctlTokenId.value) {
    const tk = ctlTokens.value.find(x => x.id === ctlTokenId.value);
    if (tk) qs.push(`token=${encodeURIComponent(tk.token)}`);
  }
  if (p.device) qs.push(`device=${encodeURIComponent(p.device)}`);
  if (p.mode) qs.push(`mode=${p.mode}`);
  if (p.play) qs.push("play=1");
  if (p.pause) qs.push("pause=1");
  if (p.stop) qs.push("stop=1");
  if (p.prev) qs.push("prev=1");
  if (p.next) qs.push("next=1");
  if (p.volume !== null && p.volume !== undefined) qs.push(`volume=${p.volume}`);
  if (p.favorite) qs.push("favorite=1");
  const base = ctlTemplateUrl.value || `${location.origin}/webhook/player`;
  return qs.length ? `${base}?${qs.join("&")}` : base;
}

async function loadPlayerTokens() {
  try {
    const res = await api.get("/rest/api/v1/player-webhook/tokens");
    ctlTokens.value = res.data?.items || [];
    ctlTemplateUrl.value = res.data?.templateUrl || `${location.origin}/webhook/player`;
    if (!ctlTokenId.value || !ctlTokens.value.find(x => x.id === ctlTokenId.value)) {
      ctlTokenId.value = ctlTokens.value.find(x => x.enabled)?.id || ctlTokens.value[0]?.id || "";
    }
    urlText.value = buildPlayerUrl();
  } catch { /* ignore */ }
}

async function createToken() {
  const name = newTokenName.value.trim() || "";
  if (!name) { ElMessage.warning("请输入 token 名称"); return; }
  busyToken.value = "new";
  try {
    const res = await api.post("/rest/api/v1/player-webhook/tokens", { name });
    ElMessage.success(`已创建 token「${res.data?.name || name}」`);
    newTokenName.value = "";
    await loadPlayerTokens();
    ctlTokenId.value = ctlTokens.value.find(x => x.token === res.data?.token)?.id || ctlTokenId.value;
    urlText.value = buildPlayerUrl();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "创建失败"); }
  finally { busyToken.value = ""; }
}

async function toggleToken(t: any, enabled: boolean) {
  busyToken.value = t.id;
  try {
    await api.put(`/rest/api/v1/player-webhook/tokens/${t.id}`, { enabled });
    await loadPlayerTokens();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "操作失败"); }
  finally { busyToken.value = ""; }
}

async function removeToken(t: any) {
  busyToken.value = t.id;
  try {
    await api.delete(`/rest/api/v1/player-webhook/tokens/${t.id}`);
    ElMessage.success("已删除该 token,此 token 的链接立即失效");
    await loadPlayerTokens();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || "删除失败"); }
  finally { busyToken.value = ""; }
}

async function loadCtlTargets() {
  const out: any[] = [];
  try {
    const d = await api.get("/rest/api/v1/dlna/devices");
    // 禁用设备不作为控制目标(后端 peer 已过滤,这里兜底排除)。
    for (const it of d.data?.devices || []) {
      if (it.disabled) continue;
      out.push({ peerId: `dlna:${it.id}`, name: it.name || it.id, kind: "dlna", available: it.available });
    }
  } catch {}
  try {
    const g = await api.get("/rest/api/v1/groups");
    for (const it of g.data?.groups || []) out.push({ peerId: `group:${it.id}`, name: it.name || it.id, kind: "group", available: true });
  } catch {}
  ctlTargets.value = out;
}

async function onCopyUrl() {
  const text = urlText.value;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制链接");
    return;
  } catch { /* fall through to legacy copy */ }
  // 旧浏览器/非安全上下文:clipboard API 不可用,退回 execCommand。
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.readOnly = true;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) { ElMessage.success("已复制链接"); return; }
    ElMessage.warning("复制失败,请手动选择复制");
  } catch {
    ElMessage.warning("复制失败,请手动选择复制");
  }
}

async function testUrl() {
  if (!urlText.value) return;
  testing.value = true;
  try {
    const res = await fetch(urlText.value);
    const data = await res.json().catch(() => ({ raw: true }));
    ElMessage[data.success === false ? "warning" : "success"](formatResult(data));
  } catch (e: any) {
    ElMessage.error(e?.message || "执行失败");
  } finally { testing.value = false; }
}

function formatResult(d: any): string {
  if (!d || typeof d !== "object") return "执行失败";
  const parts = (d.results || []).map((r: any) => (r.ok ? r.op : `${r.op}:${r.detail || "失败"}`));
  const s = parts.length ? parts.join("、") : (d.error || "成功");
  return d.success === false ? `部分失败:${s}` : `成功:${s}`;
}

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

onMounted(() => { load(); loadPeers(); loadPlayerTokens(); loadCtlTargets(); });
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
.player-ctl {
  background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.08);
  border-left: 3px solid var(--fnos-blue, #4a9eff); border-radius: 10px; padding: 14px 16px; margin-bottom: 22px;
  .player-ctl-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;
    .player-ctl-title { font-size: 15px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; }
    .player-ctl-tip { font-size: 12px; color: var(--fnos-text-tertiary); flex: 1 1 320px; min-width: 200px; line-height: 1.6; }
    .player-ctl-tokenrow { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  }
  .player-tokens {
    border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; background: rgba(0,0,0,0.18);
    padding: 10px 12px; margin-bottom: 12px;
    .tokens-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 4px; border-bottom: 1px dashed rgba(255,255,255,0.08);
      &:last-of-type { border-bottom: none; }
      .tokens-info { min-width: 0;
        .tokens-name { display: flex; align-items: center; gap: 6px;
          .tokens-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fnos-green); flex-shrink: 0;
            &.off { background: var(--fnos-text-muted); }
          }
          .tokens-text { font-size: 13px; font-weight: 600; }
        }
        .tokens-token { font-family: monospace; font-size: 11px; color: var(--fnos-text-tertiary); opacity: 0.7; word-break: break-all; margin-top: 2px; }
        .tokens-meta { font-size: 11px; color: var(--fnos-text-tertiary); margin-top: 2px; }
      }
      .tokens-ops { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    }
    .tokens-create { display: flex; align-items: center; gap: 8px; padding-top: 10px; }
    .tokens-note { font-size: 11px; color: var(--fnos-text-tertiary); margin-top: 8px; line-height: 1.6; }
  }
  .ctl-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; margin-bottom: 12px;
    .ctl-field { display: flex; flex-direction: column; gap: 6px;
      .ctl-label { font-size: 12px; color: var(--fnos-text-tertiary); }
      .ctl-transport { display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: center; }
    }
  }
  .ctl-preview { border-top: 1px dashed rgba(255,255,255,0.12); padding-top: 12px;
    .ctl-label { font-size: 12px; color: var(--fnos-text-tertiary); display: block; margin-bottom: 6px; }
    .ctl-url-row { display: flex; gap: 8px; align-items: flex-start;
      .ctl-url { flex: 1; }
      .ctl-url-actions { display: flex; flex-direction: column; gap: 6px; }
    }
    .ctl-order { font-size: 11px; color: var(--fnos-text-tertiary); margin-top: 6px; line-height: 1.5; }
  }
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