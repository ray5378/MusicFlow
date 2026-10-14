<template>
  <div class="page-header">
    <h2>{{ t('admin.plugins.title') }}</h2>
    <el-button type="primary" @click="openAddDialog()">{{ t('admin.plugins.addPlugin') }}</el-button>
  </div>

  <template v-if="plugins.length > 0">
    <div v-for="sec in installedSections" :key="sec.key" class="installed-section">
      <div class="section-header">
        <span class="section-title">{{ sec.title }}</span>
        <el-tag size="small" effect="plain" round>{{ sec.items.length }}</el-tag>
        <span class="section-hint">{{ sec.hint }}</span>
      </div>
      <el-table v-if="!isMobile" :data="sec.items" stripe v-loading="loading">
      <el-table-column :label="t('admin.plugins.colName')" min-width="200">
        <template #default="{ row }">
          <div class="plugin-name">{{ displayName(row) }}</div>
          <div class="plugin-id">{{ row.name }}</div>
        </template>
      </el-table-column>
      <el-table-column :label="t('common.type')" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="version" :label="t('admin.plugins.colVersion')" width="90" />
      <el-table-column :label="t('admin.plugins.colDesc')" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ displayDesc(row) || "—" }}</template>
      </el-table-column>
      <el-table-column :label="t('admin.plugins.colHealth')" width="96">
        <template #default="{ row }">
          <el-tag size="small" :type="healthType(row.name)" effect="dark">{{ healthLabel(row.name) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('common.status')" width="104">
        <template #default="{ row }">
          <!-- core 内置行为插件(多源组/播放优选):列表开关 = 总开关(整体启停),功能子开关在「配置」弹窗 -->
          <el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
        </template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="210">
        <template #default="{ row }">
          <el-button size="small" type="primary" plain @click="editPlugin(row)">
            {{ hasConfig(row) ? t('common.config') : t('common.detail') }}
          </el-button>
          <el-button v-if="!row.builtin" size="small" type="danger" plain @click="confirmDelete(row)">{{ t('common.delete') }}</el-button>
        </template>
      </el-table-column>
    </el-table>
    <!-- 移动端卡片列表:保留配置/详情/删除/启停,避免 el-table 横向滚动 -->
    <div v-else class="plugin-cards">
      <div v-for="row in sec.items" :key="row.name" class="plugin-card">
        <div class="pc-row">
          <div class="pc-id">
            <div class="plugin-name">{{ displayName(row) }}</div>
            <div class="plugin-id">{{ row.name }}</div>
          </div>
          <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
        </div>
        <div class="pc-meta">
          <span class="pc-ver">v{{ row.version }}</span>
          <el-tag size="small" :type="healthType(row.name)" effect="dark">{{ healthLabel(row.name) }}</el-tag>
        </div>
        <div class="pc-desc m-sub">{{ displayDesc(row) || "—" }}</div>
        <div class="pc-actions">
          <el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
          <el-button size="small" type="primary" plain @click="editPlugin(row)">
            {{ hasConfig(row) ? t('common.config') : t('common.detail') }}
          </el-button>
          <el-button v-if="!row.builtin" size="small" type="danger" plain @click="confirmDelete(row)">{{ t('common.delete') }}</el-button>
        </div>
      </div>
    </div>
    <!-- 外置插件模块为空:引导去插件市场 -->
    <div v-if="sec.key === 'external' && sec.items.length === 0 && !loading" class="section-empty">
      <span>{{ t('admin.plugins.sectionExternalEmpty') }}</span>
      <el-button size="small" type="primary" plain @click="goMarket()">{{ t('admin.plugins.tabMarket') }}</el-button>
    </div>
  </div>
  </template>
  <EmptyState v-else icon="cable" :title="t('admin.plugins.emptyTitle')" :description="t('admin.plugins.emptyDesc')">
    <template #action>
      <el-button type="primary" @click="openAddDialog()">{{ t('admin.plugins.addPlugin') }}</el-button>
    </template>
  </EmptyState>
</template>

<script setup lang="ts">
import EmptyState from "@/components/EmptyState.vue";

defineProps<{
  t: (key: string, ...args: any[]) => string;
  plugins: any[];
  installedSections: any[];
  isMobile: boolean;
  loading: boolean;
  displayName: (plugin: any) => string;
  typeTagColor: (plugin: any) => any;
  typeLabel: (plugin: any) => string;
  displayDesc: (plugin: any) => string;
  healthType: (id: string) => any;
  healthLabel: (id: string) => string;
  togglePlugin: (plugin: any) => void;
  hasConfig: (plugin: any) => boolean;
  editPlugin: (plugin: any) => void;
  confirmDelete: (row: any) => void;
  openAddDialog: () => void;
  goMarket: () => void;
}>();
</script>

<style lang="scss" scoped>
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.plugin-name { font-weight: 600; line-height: 1.35; }
.plugin-id { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.35; }
/* 移动端卡片列表(替代 el-table) */
.plugin-cards, .registry-cards { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
.plugin-card, .registry-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--fnos-radius-lg);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pc-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.pc-id { min-width: 0; }
.pc-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pc-ver { font-size: 12px; color: var(--fnos-text-tertiary); }
.pc-desc { line-height: 1.5; word-break: break-word; }
.pc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* 已安装列表 内置/外置 两模块 */
.installed-section { margin-bottom: 24px; }
.section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.section-title { font-size: 16px; font-weight: 600; }
.section-hint { font-size: 12px; color: var(--fnos-text-tertiary); }
.section-empty {
  display: flex; align-items: center; gap: 12px; padding: 18px 16px;
  border: 1px dashed var(--fnos-border-color, rgba(255, 255, 255, 0.12));
  border-radius: var(--fnos-radius-lg);
  font-size: 13px; color: var(--fnos-text-secondary);
}

@media (max-width: 768px) {
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
}
</style>
