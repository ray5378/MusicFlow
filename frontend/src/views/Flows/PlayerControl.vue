<template>
  <!-- ==================== 通用播放器控制(与音流流程解耦) ==================== -->
  <div class="player-ctl">
    <div class="player-ctl-head">
      <span class="player-ctl-title"><MfIcon name="SlidersHorizontal" />{{ t('flows.ctlTitle') }}</span>
      <span class="player-ctl-tip">{{ t('flows.ctlTip') }}</span>
      <div class="player-ctl-tokenrow">
        <el-select v-model="ctlTokenId" :placeholder="t('flows.tokenPlaceholder')" style="width: 220px" @change="urlText = buildPlayerUrl()">
          <el-option v-for="tk in ctlTokens" :key="tk.id" :label="tk.name + (tk.enabled ? '' : '(' + t('flows.deactivated') + ')')" :value="tk.id" />
        </el-select>
        <el-button size="small" plain :class="{ active: showTokens }" @click="showTokens = !showTokens"><MfIcon name="KeyRound" />{{ t('flows.manageTokens') }}</el-button>
      </div>
    </div>

    <!-- Token 管理面板:独立多条 token,各自启用/停用/删除,有效性由用户自管 -->
    <div v-if="showTokens" class="player-tokens">
      <div class="tokens-row" v-for="tk in ctlTokens" :key="tk.id">
        <div class="tokens-info">
          <div class="tokens-name">
            <span class="tokens-dot" :class="{ off: !tk.enabled }"></span>
            <span class="tokens-text">{{ tk.name }}</span>
          </div>
          <div class="tokens-token">{{ tk.token }}</div>
          <div class="tokens-meta">{{ t('flows.tokenBelongs', { owner: tk.ownerName || '-', time: formatTime(tk.createdAt) }) }}</div>
        </div>
        <div class="tokens-ops">
          <el-switch v-model="tk.enabled" :loading="busyToken === tk.id" @change="(val: any) => toggleToken(tk, !!val)" />
          <el-button size="small" type="danger" plain :loading="busyToken === tk.id" @click="removeToken(tk)">{{ t('common.delete') }}</el-button>
        </div>
      </div>
      <div class="tokens-create">
        <el-input v-model="newTokenName" :placeholder="t('flows.newTokenPh')" style="width: 260px" maxlength="40" @keyup.enter="createToken" />
        <el-button size="small" type="primary" :loading="busyToken === 'new'" @click="createToken"><MfIcon name="Plus" />{{ t('flows.newToken') }}</el-button>
      </div>
      <div class="tokens-note">{{ t('flows.tokensNote') }}</div>
    </div>

    <div class="player-ctl-body">
      <div class="ctl-grid">
        <div class="ctl-field">
          <span class="ctl-label">{{ t('flows.ctlDevice') }}</span>
          <el-select v-model="ctl.device" :placeholder="t('flows.ctlDevicePh')" filterable clearable style="width: 100%">
            <el-option :label="t('flows.ctlAllDevices')" value="all" />
            <el-option v-for="p in ctlTargets" :key="p.peerId" :label="p.kind === 'group' ? `${p.name}${t('flows.ctlGroup')}` : p.name" :value="p.peerId" />
          </el-select>
        </div>

        <div class="ctl-field">
          <span class="ctl-label">{{ t('flows.ctlMode') }}</span>
          <el-select v-model="ctl.mode" clearable :placeholder="t('flows.modeKeep')" style="width: 100%">
            <el-option v-for="(mnKey, mv) in MODE_TEXT" :key="mv" :label="t(mnKey)" :value="mv" />
          </el-select>
        </div>

        <div class="ctl-field">
          <span class="ctl-label">{{ t('flows.ctlVolume') }}</span>
          <el-input-number v-model="ctl.volume" :min="0" :max="100" :step="1" controls-position="right" :placeholder="t('flows.volumeKeep')" style="width: 100%" />
        </div>

        <div class="ctl-field">
          <span class="ctl-label">{{ t('flows.ctlTransport') }}</span>
          <div class="ctl-transport">
            <el-checkbox v-model="ctl.play">{{ t('flows.ctlPlay') }}</el-checkbox>
            <el-checkbox v-model="ctl.pause">{{ t('flows.ctlPause') }}</el-checkbox>
            <el-checkbox v-model="ctl.stop">{{ t('flows.ctlStop') }}</el-checkbox>
            <el-checkbox v-model="ctl.prev">{{ t('flows.ctlPrev') }}</el-checkbox>
            <el-checkbox v-model="ctl.next">{{ t('flows.ctlNext') }}</el-checkbox>
          </div>
        </div>

        <div class="ctl-field">
          <span class="ctl-label">{{ t('flows.ctlActions') }}</span>
          <el-checkbox v-model="ctl.favorite">{{ t('flows.ctlFavorite') }}</el-checkbox>
        </div>
      </div>

      <div class="ctl-preview">
        <span class="ctl-label">{{ t('flows.ctlGenLink') }}</span>
        <div class="ctl-url-row">
          <el-input v-model.trim="urlText" type="textarea" :rows="2" resize="vertical" readonly class="ctl-url" />
          <div class="ctl-url-actions">
            <el-button size="small" @click="onCopyUrl"><MfIcon name="Copy" />{{ t('common.copy') }}</el-button>
            <el-button size="small" type="primary" :loading="testing" @click="testUrl"><MfIcon name="Play" />{{ t('flows.ctlTest') }}</el-button>
          </div>
        </div>
        <div class="ctl-order">{{ t('flows.ctlOrder') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";

const { t } = useI18n();
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
  if (!name) { ElMessage.warning(t('flows.needTokenName')); return; }
  busyToken.value = "new";
  try {
    const res = await api.post("/rest/api/v1/player-webhook/tokens", { name });
    ElMessage.success(t('flows.tokenCreated', { name: res.data?.name || name }));
    newTokenName.value = "";
    await loadPlayerTokens();
    ctlTokenId.value = ctlTokens.value.find(x => x.token === res.data?.token)?.id || ctlTokenId.value;
    urlText.value = buildPlayerUrl();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t('flows.tokenCreateFailed')); }
  finally { busyToken.value = ""; }
}

async function toggleToken(t: any, enabled: boolean) {
  busyToken.value = t.id;
  try {
    await api.put(`/rest/api/v1/player-webhook/tokens/${t.id}`, { enabled });
    await loadPlayerTokens();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t('common.operationFailed')); }
  finally { busyToken.value = ""; }
}

async function removeToken(t: any) {
  busyToken.value = t.id;
  try {
    await api.delete(`/rest/api/v1/player-webhook/tokens/${t.id}`);
    ElMessage.success(t('flows.tokenDeleted'));
    await loadPlayerTokens();
  } catch (e: any) { ElMessage.error(e.response?.data?.error || t('flows.deleteFailed')); }
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
  try {
    const a = await api.get("/rest/api/v1/airplay/devices");
    for (const it of a.data?.devices || []) {
      out.push({ peerId: `airplay:${it.id}`, name: it.name || it.id, kind: "airplay", available: it.available });
    }
  } catch {}
  ctlTargets.value = out;
}

async function onCopyUrl() {
  const text = urlText.value;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(t('flows.copied'));
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
    if (ok) { ElMessage.success(t('flows.copied')); return; }
    ElMessage.warning(t('flows.copyFailed'));
  } catch {
    ElMessage.warning(t('flows.copyFailed'));
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
    ElMessage.error(e?.message || t('flows.testFailed'));
  } finally { testing.value = false; }
}

function formatResult(d: any): string {
  if (!d || typeof d !== "object") return t('flows.testFailed');
  const parts = (d.results || []).map((r: any) => (r.ok ? r.op : `${r.op}:${r.detail || t('flows.failedLabel')}`));
  const s = parts.length ? parts.join(t('flows.listSeparator')) : (d.error || t('flows.successLabel'));
  return d.success === false ? t('flows.partialFail', { msg: s }) : t('flows.resultOk', { msg: s });
}

const MODE_TEXT: Record<string, string> = { order: "flows.modeOrder", shuffle: "flows.modeShuffle", all: "flows.modeAll", one: "flows.modeOne" };

function formatTime(t: string): string {
  if (!t) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onMounted(() => { loadPlayerTokens(); loadCtlTargets(); });
</script>

<style lang="scss" scoped>
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
</style>