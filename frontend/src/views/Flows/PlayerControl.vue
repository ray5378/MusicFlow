<template>
  <!-- ==================== 通用播放器控制(与音流流程解耦) ==================== -->
  <div class="player-ctl">
    <div class="player-ctl-head">
      <span class="player-ctl-title"><MfIcon name="SlidersHorizontal" />通用播放器控制</span>
      <span class="player-ctl-tip">与音流(流程)无关:下方 URL 的参数就是配置,可直接控制已上线的 DLNA 音箱 / 播放器群组,无需内部流程。可手工增删改参数、可重复使用、支持一次串联多个动作。音流的对外链接也复用这里的渠道 token 做鉴权。</span>
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
          <div class="tokens-meta">归属「{{ t.ownerName || '-' }}」 · 创建 {{ formatTime(t.createdAt) }}</div>
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
      <div class="tokens-note">操作说明:每个 token 独立有效,停用 = 旧链接立即返回 403,删除 = 链接永久失效(401/404)。「我喜欢」归属各 token 创建者。已绑定该 token 的音流,其对外链接随之立即生效/失效。</div>
    </div>

    <div class="player-ctl-body">
      <div class="ctl-grid">
        <div class="ctl-field">
          <span class="ctl-label">目标播放器</span>
          <el-select v-model="ctl.device" placeholder="选择播放器(DLNA / AirPlay / 群组)" filterable clearable style="width: 100%">
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
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

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