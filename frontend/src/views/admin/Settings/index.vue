<template>
  <div class="admin-settings">
    <div class="page-header"><h2>系统设置</h2></div>
    <el-card>
      <el-form label-width="200px">
        <el-form-item label="允许回写源文件标签">
          <el-switch v-model="settings.writeBackTags" />
          <div class="form-tip">开启后，刮削和清洗结果会写回音频文件的ID3/Vorbis/MP4标签</div>
        </el-form-item>
        <el-form-item label="启用音频指纹">
          <el-switch v-model="settings.fingerprintEnabled" />
          <div class="form-tip">开启后，扫描时会计算Chromaprint指纹，用于去重检测</div>
        </el-form-item>
      </el-form>
      <el-button type="primary" @click="saveSettings">保存设置</el-button>
    </el-card>

    <el-card style="margin-top: 16px">
      <h3>系统信息</h3>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="版本">{{ frontendVersion }}</el-descriptions-item>
        <el-descriptions-item label="服务器版本">{{ serverVersion }}</el-descriptions-item>
        <el-descriptions-item label="哈希版本号">{{ gitCommit }}</el-descriptions-item>
        <el-descriptions-item label="OpenSubsonic">1.16.1</el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const settings = reactive({ writeBackTags: false, fingerprintEnabled: false });

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

async function loadSettings() {
  try { const res = await api.get("/rest/api/v1/settings"); Object.assign(settings, res.data); } catch {}
}

function saveSettings() { ElMessage.success("设置已保存"); }

onMounted(() => { loadSettings(); loadVersion(); });
</script>

<style lang="scss" scoped>
.admin-settings { padding: 24px 32px 130px; max-width: 900px; margin: 0 auto; }
.page-header { margin-bottom: 24px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
:deep(.el-card) { background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.07) !important; border-radius: var(--fnos-radius-lg) !important; }
:deep(.el-descriptions__body) { background: transparent !important; }
:deep(.el-descriptions__label) { background: rgba(255,255,255,0.04) !important; color: var(--fnos-text-secondary) !important; }
:deep(.el-descriptions__content) { background: transparent !important; color: var(--fnos-text-primary) !important; }
.form-tip { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; }
@media (max-width: 768px) {
  .admin-settings { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  :deep(.el-form-item__label) { text-align: left; line-height: 1.4; padding-bottom: 6px; }
}
</style>
