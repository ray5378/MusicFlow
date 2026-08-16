<template>
  <div class="admin-settings">
    <div class="page-header"><h2>系统设置</h2></div>

    <el-card>
      <h3>系统信息</h3>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="版本">{{ frontendVersion }}</el-descriptions-item>
        <el-descriptions-item label="服务器版本">{{ serverVersion }}</el-descriptions-item>
        <el-descriptions-item label="哈希版本号">{{ gitCommit }}</el-descriptions-item>
        <el-descriptions-item label="OpenSubsonic">1.16.1</el-descriptions-item>
        <el-descriptions-item label="项目地址">
          <a href="https://github.com/ray5378/MusicFlow" target="_blank" rel="noopener" class="gh-link">GitHub 仓库 ↗</a>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="mt-card">
      <h3>网络代理</h3>
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">启用代理</div>
          <div class="desc">用于插件市场拉取 GitHub 等源（registry / 插件包下载）。仅影响插件拉取，其它网络直连。</div>
        </div>
        <div class="setting-value"><el-switch v-model="proxyEnabled" /></div>
      </div>
      <div v-if="proxyEnabled" class="setting-item">
        <div class="setting-label"><div class="title">代理地址</div><div class="desc">格式：http://ip:port、https://ip:port 或 socks5://ip:port，例如 http://192.168.1.10:7890 或 socks5://127.0.0.1:1080</div></div>
        <div class="setting-value proxy-actions">
          <el-input v-model="proxyUrl" placeholder="http://ip:port 或 socks5://ip:port" class="proxy-input" clearable />
          <el-button :loading="proxyTesting" @click="testProxy">测试连接</el-button>
          <el-button type="primary" :loading="proxySaving" @click="saveProxy">保存</el-button>
        </div>
      </div>
    </el-card>

    <el-card class="mt-card">
      <h3>后台任务限速</h3>
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">批量任务档位</div>
          <div class="desc">控制歌单同步 / 在线匹配 / 推荐补全等批量任务的 CPU 占用与速度。低速最省 CPU（白天在用电脑时推荐），全速最快但可能占用较高。</div>
        </div>
        <div class="setting-value batch-pace-actions">
          <el-select v-model="batchPace" style="width: 160px" @change="saveBatchPace">
            <el-option label="低速（最省 CPU）" value="slow" />
            <el-option label="标准（推荐）" value="standard" />
            <el-option label="全速（最快）" value="full" />
          </el-select>
          <span class="pace-hint">{{ batchPaceHint }}</span>
        </div>
      </div>
    </el-card>

    <el-card class="mt-card">
      <h3>空闲内存回收</h3>
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">自动回收</div>
          <div class="desc">没有播放活动、也没有歌单拉取/导入/同步/扫描等操作持续一段时间后，自动清理可重建缓存（曲库索引/封面/歌词等）并回收内存。</div>
        </div>
        <div class="setting-value">
          <el-switch v-model="memoryAutoReclaim" @change="saveMemorySettings" />
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">空闲阈值</div>
          <div class="desc">连续多少分钟无活动后触发回收。</div>
        </div>
        <div class="setting-value memory-actions">
          <el-input-number v-model="memoryIdleMinutes" :min="1" :max="60" size="small" @change="saveMemorySettings" />
          <span class="pace-hint">分钟</span>
          <el-button type="primary" :loading="reclaiming" @click="reclaimNow">立即回收</el-button>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

// 前端版本:构建时由 Vite 从 CI 注入(import.meta.env.VITE_APP_VERSION)
const frontendVersion = ref(import.meta.env.VITE_APP_VERSION || "—");
// 服务器版本 / 哈希版本号:运行时经 /ping 取后端真实值(APP_VERSION / APP_COMMIT)
const serverVersion = ref("—");
const gitCommit = ref("—");
async function loadVersion() {
  try {
    const res = await api.get("/ping");
    const v = res.data?.version;
    serverVersion.value = v ? (v === "dev" ? "dev" : `v${v}`) : "未知";
    gitCommit.value = res.data?.commit || "未知";
  } catch {
    serverVersion.value = "未知";
    gitCommit.value = "未知";
  }
}

// ---------- 网络代理 ----------
const proxyEnabled = ref(false);
const proxyUrl = ref("");
const proxySaving = ref(false);
const proxyTesting = ref(false);

async function loadProxy() {
  try {
    const res = await api.get("/rest/api/v1/proxy");
    proxyEnabled.value = !!res.data.enabled;
    proxyUrl.value = res.data.url || "";
  } catch { /* 静默 */ }
}

async function saveProxy() {
  proxySaving.value = true;
  try {
    await api.put("/rest/api/v1/proxy", { enabled: proxyEnabled.value, url: proxyUrl.value });
    ElMessage.success("代理设置已保存");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "保存失败");
  } finally {
    proxySaving.value = false;
  }
}

// 测试连接：先保存当前输入（让后端用最新配置测），再验证代理通道能否出网。
async function testProxy() {
  proxyTesting.value = true;
  try {
    await api.put("/rest/api/v1/proxy", { enabled: proxyEnabled.value, url: proxyUrl.value });
    const res = await api.post("/rest/api/v1/proxy/test", {});
    if (res.data?.success) ElMessage.success(res.data?.message || "代理可用");
    else ElMessage.error(res.data?.message || res.data?.error || "代理不可用");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.message || e.response?.data?.error || "测试失败");
  } finally {
    proxyTesting.value = false;
  }
}

// ---------- 后台任务限速档位 ----------
const batchPace = ref<"slow" | "standard" | "full">("standard");
const batchPaceHint = ref("并发 2、批间睡眠 120ms，前台忙时自动降速");
const PACE_HINTS: Record<string, string> = {
  slow: "并发 1、批间睡眠 120ms，最平缓",
  standard: "并发 2、批间睡眠 120ms，前台忙时自动降速",
  full: "并发 4、批间不睡眠，最快但占用高",
};

async function loadBatchPace() {
  try {
    const res = await api.get("/rest/api/v1/batch-pace");
    const p = res.data?.pace;
    if (p === "slow" || p === "standard" || p === "full") {
      batchPace.value = p;
      batchPaceHint.value = PACE_HINTS[p];
    }
  } catch { /* 静默 */ }
}

async function saveBatchPace(pace: string) {
  try {
    const res = await api.put("/rest/api/v1/batch-pace", { pace });
    if (res.data?.success) {
      batchPaceHint.value = PACE_HINTS[pace] || "";
      ElMessage.success("限速档位已保存，立即生效");
    } else {
      ElMessage.error(res.data?.error || "保存失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "保存失败");
  }
}

// ---------- 空闲内存自动回收 ----------
const memoryAutoReclaim = ref(true);
const memoryIdleMinutes = ref(5);
const reclaiming = ref(false);

async function loadMemorySettings() {
  try {
    const res = await api.get("/rest/api/v1/admin/memory-settings");
    memoryAutoReclaim.value = !!res.data?.enabled;
    if (Number.isFinite(res.data?.idleMinutes)) memoryIdleMinutes.value = res.data.idleMinutes;
  } catch { /* 静默 */ }
}
async function saveMemorySettings() {
  try {
    await api.put("/rest/api/v1/admin/memory-settings", {
      enabled: memoryAutoReclaim.value,
      idleMinutes: memoryIdleMinutes.value,
    });
    ElMessage.success("内存回收设置已保存");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "保存失败");
  }
}
async function reclaimNow() {
  reclaiming.value = true;
  try {
    const res = await api.post("/rest/api/v1/admin/memory/reclaim", {});
    const r = res.data || {};
    const n = (r.caches || []).length;
    ElMessage.success(`已回收 ${n} 类缓存${r.gc ? "，已执行 GC" : ""}${r.checkpoint ? "，已合并 WAL" : ""}`);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "回收失败");
  } finally {
    reclaiming.value = false;
  }
}

onMounted(() => { loadVersion(); loadProxy(); loadBatchPace(); loadMemorySettings(); });
</script>

<style lang="scss" scoped>
.admin-settings { padding: 24px 32px 130px; max-width: 900px; margin: 0 auto; }
.page-header { margin-bottom: 24px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.gh-link { color: var(--el-color-primary); text-decoration: none; &:hover { text-decoration: underline; } }
.mt-card { margin-top: 18px; }
.setting-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
  &:last-child { border-bottom: none; }
  .setting-label { .title { font-weight: 600; color: var(--fnos-text-primary); } .desc { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; } }
  .setting-value { flex-shrink: 0; }
}
.proxy-actions { display: flex; gap: 8px; align-items: center; }
.proxy-input { width: 300px; }
.batch-pace-actions { display: flex; gap: 10px; align-items: center; }
.memory-actions { display: flex; gap: 10px; align-items: center; }
.pace-hint { font-size: 12px; color: var(--fnos-text-tertiary); }
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.07) !important; border-radius: var(--fnos-radius-lg) !important; }
:deep(.el-descriptions__body) { background: transparent !important; }
:deep(.el-descriptions__label) { background: rgba(255,255,255,0.04) !important; color: var(--fnos-text-secondary) !important; }
:deep(.el-descriptions__content) { background: transparent !important; color: var(--fnos-text-primary) !important; }
@media (max-width: 768px) {
  .admin-settings { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .setting-item { flex-direction: column; gap: 10px; }
  .proxy-input { width: 100%; }
  .proxy-actions { flex-wrap: wrap; }
}
</style>
