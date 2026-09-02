<template>
  <div class="settings-page">
    <div class="page-header"><h2>系统设置</h2></div>

    <!-- ===== 账户 ===== -->
    <el-card>
      <h3>账户</h3>
      <div class="setting-item">
        <div class="setting-label"><div class="title">用户信息</div><div class="desc">当前登录用户的基本信息</div></div>
        <div class="setting-value">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="用户名">{{ authStore.username }}</el-descriptions-item>
            <el-descriptions-item label="角色">{{ authStore.isAdmin ? '管理员' : '普通用户' }}</el-descriptions-item>
            <el-descriptions-item label="用户 ID">{{ authStore.userId || '-' }}</el-descriptions-item>
          </el-descriptions>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">修改用户名</div><div class="desc">修改后需使用新用户名登录</div></div>
        <div class="setting-value">
          <el-button type="primary" plain @click="showNameDialog = true">修改用户名</el-button>
        </div>
      </div>
    </el-card>

    <!-- ===== API Key ===== -->
    <el-card class="mt-card">
      <h3>API Key</h3>
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">第三方客户端接入</div>
          <div class="desc">
            供 Home Assistant 集成等第三方客户端长期使用。登录 Token 24 小时过期，常驻客户端请用这里的 Key。
            <span v-if="apiKeyExpiresAt" class="expire">（到期：{{ apiKeyExpiresAt.slice(0, 10) }}）</span>
          </div>
          <div v-if="apiKey" class="apikey-box">
            <el-input
              v-model="apiKey"
              readonly
              size="small"
              class="apikey-input"
              :type="apiKeyVisible ? 'text' : 'password'"
            >
              <template #append>
                <el-button @click="apiKeyVisible = !apiKeyVisible">{{ apiKeyVisible ? '隐藏' : '显示' }}</el-button>
              </template>
            </el-input>
            <el-button
              class="apikey-copy"
              type="primary"
              plain
              size="small"
              @click="copyApiKey"
            >
              复制
            </el-button>
          </div>
        </div>
        <div class="setting-value apikey-actions">
          <el-button type="primary" plain :loading="apiKeyLoading" @click="generateApiKey">
            {{ apiKey ? '重新生成' : '生成' }}
          </el-button>
          <el-button v-if="apiKey" type="danger" plain :loading="apiKeyLoading" @click="revokeApiKey">撤销</el-button>
        </div>
      </div>
    </el-card>

    <!-- ===== 外观 ===== -->
    <el-card class="mt-card">
      <h3>外观</h3>
      <div class="setting-item">
        <div class="setting-label"><div class="title">主题风格</div><div class="desc">当前使用飞牛音乐暗色玻璃主题</div></div>
        <div class="setting-value"><el-tag size="small" type="info">FnOS Dark</el-tag></div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">减少动画</div><div class="desc">开启后减弱页面动效，适合敏感人群</div></div>
        <div class="setting-value"><el-switch v-model="reduceMotion" @change="toggleMotion" /></div>
      </div>
    </el-card>

    <!-- ===== 播放 ===== -->
    <el-card class="mt-card">
      <h3>播放</h3>
      <div class="setting-item">
        <div class="setting-label">
          <div class="title">播放优选（首选 Local）</div>
          <div class="desc">已并入「播放优选」内置核心插件：多源组歌曲自动播本地/WebDAV 无损源，Local 不可用时回退平台源。功能开关请在插件管理页的插件「配置」弹窗中调整</div>
        </div>
        <div class="setting-value">
          <el-button size="small" plain @click="$router.push('/admin/plugins')">前往插件管理</el-button>
        </div>
      </div>
    </el-card>

    <!-- ===== 系统（仅管理员） ===== -->
    <template v-if="authStore.isAdmin">
      <el-card class="mt-card">
        <h3>系统信息</h3>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="服务器版本">{{ serverVersion }}</el-descriptions-item>
          <el-descriptions-item label="哈希版本号">{{ gitCommit }}</el-descriptions-item>
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
    </template>

    <!-- ===== 通用 ===== -->
    <el-card class="mt-card">
      <h3>通用</h3>
      <div class="setting-item">
        <div class="setting-label"><div class="title">清除缓存</div><div class="desc">重置本地设置并重新加载页面</div></div>
        <div class="setting-value"><el-button @click="clearCache">清除缓存</el-button></div>
      </div>
      <div class="setting-item">
        <div class="setting-label"><div class="title">关于 MusicFlow</div><div class="desc">自托管音乐库播放器 · 飞牛风格重构版（版本号见「系统信息」）</div></div>
        <div class="setting-value">
          <a href="https://github.com/ray5378/MusicFlow" target="_blank" rel="noopener" class="gh-link">GitHub 仓库 ↗</a>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="showNameDialog" title="修改用户名" width="400px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item label="新用户名"><el-input v-model="newName" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNameDialog = false">取消</el-button>
        <el-button type="primary" @click="changeUsername">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { copyText } from "@/utils/clipboard";
const authStore = useAuthStore();

const showNameDialog = ref(false);
const newName = ref("");

// ---------- 版本 / 哈希（前后端 lockstep 绑定发布，仅展示后端版本） ----------
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

// ---------- API Key ----------
const apiKey = ref("");
const apiKeyExpiresAt = ref<string | null>(null);
const apiKeyVisible = ref(false);
const apiKeyLoading = ref(false);

async function loadApiKey() {
  try {
    const res = await api.get("/rest/api/v1/users/me/api-key");
    apiKey.value = res.data.apiKey || "";
    apiKeyExpiresAt.value = res.data.expiresAt || null;
  } catch { /* 静默：不影响页面其他部分 */ }
}

async function generateApiKey() {
  if (apiKey.value) {
    try {
      await ElMessageBox.confirm(
        "重新生成会立即让旧 Key 失效，所有使用旧 Key 的客户端（如 Home Assistant）都需要重新填写。",
        "重新生成 API Key",
        { type: "warning", confirmButtonText: "确认生成", cancelButtonText: "取消" },
      );
    } catch { return; }
  }
  apiKeyLoading.value = true;
  try {
    const res = await api.post("/rest/api/v1/users/me/api-key", {});
    apiKey.value = res.data.apiKey;
    apiKeyExpiresAt.value = res.data.expiresAt || null;
    apiKeyVisible.value = true;
    ElMessage.success("API Key 已生成");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "生成失败");
  } finally {
    apiKeyLoading.value = false;
  }
}

async function revokeApiKey() {
  try {
    await ElMessageBox.confirm("撤销后使用该 Key 的客户端会立即失去访问权限。", "撤销 API Key", {
      type: "warning", confirmButtonText: "确认撤销", cancelButtonText: "取消",
    });
  } catch { return; }
  apiKeyLoading.value = true;
  try {
    await api.delete("/rest/api/v1/users/me/api-key");
    apiKey.value = "";
    apiKeyExpiresAt.value = null;
    apiKeyVisible.value = false;
    ElMessage.success("API Key 已撤销");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "撤销失败");
  } finally {
    apiKeyLoading.value = false;
  }
}

async function copyApiKey() {
  await copyText(apiKey.value);
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

// ---------- 外观 / 通用 ----------
const reduceMotion = ref(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function toggleMotion(v: string | number | boolean) {
  const on = Boolean(v);
  document.documentElement.style.setProperty('prefers-reduced-motion', on ? 'reduce' : 'no-preference');
  if (on) document.documentElement.classList.add('reduce-motion');
  else document.documentElement.classList.remove('reduce-motion');
  ElMessage.success(on ? '已开启减弱动画' : '已关闭减弱动画');
}

function clearCache() {
  localStorage.clear();
  ElMessage.success('本地缓存已清除，即将刷新');
  setTimeout(() => location.reload(), 800);
}

async function changeUsername() {
  const name = newName.value.trim();
  if (!name) { ElMessage.warning("请输入新用户名"); return; }
  try {
    const res = await api.put(`/rest/api/v1/users/${authStore.userId}/username`, { username: name });
    authStore.setUsername(res.data.username);
    showNameDialog.value = false;
    ElMessage.success("用户名已修改");
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "修改失败");
  }
}

onMounted(() => { loadApiKey(); loadVersion(); loadProxy(); loadBatchPace(); loadMemorySettings(); });
</script>

<style lang="scss" scoped>
.settings-page { padding: 24px 32px 130px; max-width: 900px; margin: 0 auto; }
.page-header { margin-bottom: 24px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.mt-card { margin-top: 18px; }
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.08) !important; border-radius: var(--fnos-radius-lg) !important; }
:deep(.el-descriptions__body) { background: transparent !important; }
:deep(.el-descriptions__label) { background: rgba(255,255,255,0.04) !important; color: var(--fnos-text-secondary) !important; }
:deep(.el-descriptions__content) { background: transparent !important; color: var(--fnos-text-primary) !important; }
h3 { font-size: 15px; font-weight: 600; margin: 0 0 2px; color: var(--fnos-text-primary); }
.setting-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
  &:last-child { border-bottom: none; }
  .setting-label { .title { font-weight: 600; color: var(--fnos-text-primary); } .desc { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; } }
  .setting-value { flex-shrink: 0; }
}
.setting-label .expire { color: var(--fnos-text-secondary); }
.apikey-box { margin-top: 10px; max-width: 560px; display: flex; gap: 8px; align-items: stretch; }
.apikey-box .apikey-input { flex: 1 1 auto; min-width: 0; }
.apikey-box .apikey-copy { flex: 0 0 auto; }
.apikey-actions { display: flex; gap: 8px; }
.gh-link { color: var(--el-color-primary); text-decoration: none; &:hover { text-decoration: underline; } }
.proxy-actions { display: flex; gap: 8px; align-items: center; }
.proxy-input { width: 300px; }
.batch-pace-actions { display: flex; gap: 10px; align-items: center; }
.memory-actions { display: flex; gap: 10px; align-items: center; }
.pace-hint { font-size: 12px; color: var(--fnos-text-tertiary); }

@media (max-width: 768px) {
  .settings-page { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .setting-item { flex-direction: column; gap: 10px; }
  .apikey-box { max-width: 100%; }
  .proxy-input { width: 100%; }
  .proxy-actions { flex-wrap: wrap; }
}
</style>
