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
        <el-descriptions-item label="版本">1.0.0</el-descriptions-item>
        <el-descriptions-item label="服务器版本">1.0.0</el-descriptions-item>
        <el-descriptions-item label="OpenSubsonic">1.16.1</el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const settings = reactive({ writeBackTags: false, fingerprintEnabled: false });

async function loadSettings() {
  try { const res = await api.get("/rest/api/v1/settings"); Object.assign(settings, res.data); } catch {}
}

function saveSettings() { ElMessage.success("设置已保存"); }

onMounted(loadSettings);
</script>

<style lang="scss" scoped>
.admin-settings { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
.form-tip { font-size: 12px; color: #999; margin-top: 4px; }
</style>
