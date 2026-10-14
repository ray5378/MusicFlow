<template>
  <div class="page-header">
    <h2>{{ t('admin.plugins.marketTitle') }}</h2>
    <el-button type="primary" plain @click="loadMarketplace" :loading="marketLoading">{{ t('common.refresh') }}</el-button>
  </div>

  <el-card class="market-card" shadow="never">
    <template #header>
      <div class="card-head">
        <span>{{ t('admin.plugins.registrySource') }}</span>
        <el-button size="small" type="primary" plain @click="openRegDialog()">{{ t('admin.plugins.addRegistry') }}</el-button>
      </div>
    </template>
    <template v-if="registries.length > 0">
      <el-table v-if="!isMobile" :data="registries" stripe size="small">
        <el-table-column prop="url" label="URL" min-width="320" show-overflow-tooltip />
        <el-table-column :label="t('common.status')" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.error" size="small" type="danger" effect="light">{{ t('admin.plugins.loadFailed') }}</el-tag>
            <el-tag v-else size="small" :type="row.enabled ? 'success' : 'info'" effect="light">{{ row.enabled ? t('common.enable') : t('common.disable') }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('common.actions')" width="90">
          <template #default="{ row }">
            <el-button size="small" type="danger" plain @click="removeRegistry(row)">{{ t('common.delete') }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-else class="registry-cards">
        <div v-for="row in registries" :key="row.id" class="registry-card">
          <div class="rc-url">{{ row.url }}</div>
          <div class="rc-meta">
            <el-tag v-if="row.error" size="small" type="danger" effect="light">{{ t('admin.plugins.loadFailed') }}</el-tag>
            <el-tag v-else size="small" :type="row.enabled ? 'success' : 'info'" effect="light">{{ row.enabled ? t('common.enable') : t('common.disable') }}</el-tag>
            <el-button size="small" type="danger" plain @click="removeRegistry(row)">{{ t('common.delete') }}</el-button>
          </div>
        </div>
      </div>
    </template>
    <el-empty v-else :description="t('admin.plugins.noRegistry')" :image-size="60" />
  </el-card>

  <el-card class="market-card" shadow="never">
    <template #header><span>{{ t('admin.plugins.marketGrouped') }}</span></template>
    <div v-for="group in groupedMarket" :key="group.key" class="market-group">
      <div class="group-head">
        <span class="group-title">{{ group.title }}</span>
        <el-tag v-if="group.sourceLabel" size="small" type="primary" effect="plain">{{ group.sourceLabel }}</el-tag>
        <el-tag v-if="group.error" size="small" type="danger" effect="plain">{{ t('admin.plugins.loadFailed') }}</el-tag>
      </div>
      <el-alert
        v-if="group.error && group.items.length === 0"
        type="warning"
        :closable="false"
        show-icon
        class="market-group-err"
        :title="t('admin.plugins.registryLoadFailedTitle')"
        :description="t('admin.plugins.registryLoadFailedDesc', { error: group.error })"
      />
      <template v-if="group.items.length > 0">
        <el-table v-if="!isMobile" :data="group.items" stripe v-loading="marketLoading">
          <el-table-column :label="t('admin.plugins.colName')" min-width="200">
            <template #default="{ row }">
              <div class="plugin-name">
                {{ row.name }}
                <el-tag v-if="row.builtin" size="small" type="warning" effect="light">{{ t('admin.plugins.builtin') }}</el-tag>
              </div>
              <div class="plugin-id">{{ row.id }}</div>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.plugins.colTypeCap')" min-width="200">
            <template #default="{ row }">
              <div class="cap-row">
                <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
                <el-tag v-for="cap in capabilityList(row).slice(0, 5)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="version" :label="t('admin.plugins.colVersion')" width="86" />
          <el-table-column prop="description" :label="t('admin.plugins.colDesc')" min-width="200" show-overflow-tooltip />
          <el-table-column :label="t('common.status')" width="104">
            <template #default="{ row }">
              <el-switch v-if="row.installed" v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
              <el-tag v-else size="small" type="info" effect="light">{{ t('admin.plugins.notInstalled') }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.actions')" width="190">
            <template #default="{ row }">
              <template v-if="!row.builtin">
                <el-button v-if="!row.installed" size="small" type="success" plain :loading="installing === installKey(row)" @click="installPlugin(row)">{{ t('admin.plugins.install') }}</el-button>
                <el-button v-else-if="isUpdatable(row)" size="small" type="primary" :loading="installing === installKey(row)" @click="installPlugin(row)">{{ t('admin.plugins.update') }}</el-button>
                <el-button v-else size="small" plain :loading="installing === installKey(row)" @click="installPlugin(row)">{{ t('admin.plugins.reinstall') }}</el-button>
              </template>
              <el-button size="small" plain @click="editPlugin(row)">{{ t('common.detail') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
        <!-- 移动端卡片列表 -->
        <div v-else class="plugin-cards">
          <div v-for="row in group.items" :key="row.id" class="plugin-card">
            <div class="pc-row">
              <div class="pc-id">
                <div class="plugin-name">
                  {{ displayName(row) }}
                  <el-tag v-if="row.builtin" size="small" type="warning" effect="light">{{ t('admin.plugins.builtin') }}</el-tag>
                </div>
                <div class="plugin-id">{{ row.id }}</div>
              </div>
              <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
            </div>
            <div class="cap-row">
              <el-tag v-for="cap in capabilityList(row).slice(0, 5)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
            </div>
            <div class="pc-desc m-sub">{{ displayDesc(row) || "—" }}</div>
            <div class="pc-meta">
              <span class="pc-ver">v{{ row.version }}</span>
              <el-switch v-if="row.installed" v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
              <el-tag v-else size="small" type="info" effect="light">{{ t('admin.plugins.notInstalled') }}</el-tag>
            </div>
            <div class="pc-actions">
              <template v-if="!row.builtin">
                <el-button v-if="!row.installed" size="small" type="success" plain :loading="installing === installKey(row)" @click="installPlugin(row)">{{ t('admin.plugins.install') }}</el-button>
                <el-button v-else-if="isUpdatable(row)" size="small" type="primary" :loading="installing === installKey(row)" @click="installPlugin(row)">{{ t('admin.plugins.update') }}</el-button>
                <el-button v-else size="small" plain :loading="installing === installKey(row)" @click="installPlugin(row)">{{ t('admin.plugins.reinstall') }}</el-button>
              </template>
              <el-button size="small" plain @click="editPlugin(row)">{{ t('common.detail') }}</el-button>
            </div>
          </div>
        </div>
      </template>
      <el-empty v-else :description="t('admin.plugins.noPluginsInRegistry')" :image-size="50" />
    </div>
    <p v-if="groupedMarket.length > 0" class="market-note">{{ t('admin.plugins.marketNote') }}</p>
    <el-empty v-else :description="t('admin.plugins.noRegistry')" :image-size="60" />
  </el-card>
  <el-alert type="info" :closable="false" show-icon class="market-warn"
    :title="t('admin.plugins.securityTitle')"
    :description="t('admin.plugins.securityDesc')"
  />
</template>

<script setup lang="ts">
defineProps<{
  t: (key: string, ...args: any[]) => string;
  marketLoading: boolean;
  loadMarketplace: () => void;
  openRegDialog: () => void;
  isMobile: boolean;
  registries: any[];
  removeRegistry: (row: any) => void;
  groupedMarket: any[];
  typeTagColor: (plugin: any) => any;
  typeLabel: (plugin: any) => string;
  capabilityList: (plugin: any) => string[];
  capLabel: (cap: string) => string;
  togglePlugin: (plugin: any) => void;
  installing: string;
  installKey: (row: any) => string;
  installPlugin: (row: any) => void;
  isUpdatable: (row: any) => boolean;
  editPlugin: (plugin: any) => void;
  displayName: (plugin: any) => string;
  displayDesc: (plugin: any) => string;
}>();
</script>

<style lang="scss" scoped>
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.plugin-name { font-weight: 600; line-height: 1.35; }
.plugin-id { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.35; }
.cap-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.market-card { margin-bottom: 20px; }
.market-card .card-head { display: flex; justify-content: space-between; align-items: center; }
.market-warn { margin-top: 4px; }
.market-note { margin: 12px 4px 0; font-size: 12px; color: var(--el-text-color-secondary); }
.market-group { margin-bottom: 18px; }
.market-group .group-head { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; }
.market-group .group-title { font-size: 13px; font-weight: 600; color: var(--el-text-color-primary); word-break: break-all; }
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
.rc-url { font-size: 13px; color: var(--fnos-text-primary); word-break: break-all; line-height: 1.5; }
.rc-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

@media (max-width: 768px) {
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
}
</style>
