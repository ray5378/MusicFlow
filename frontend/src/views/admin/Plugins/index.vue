<template>
  <div class="admin-plugins">
    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <!-- ============ Installed plugins ============ -->
      <el-tab-pane :label="t('admin.plugins.tabInstalled')" name="installed">
        <div class="page-header">
          <h2>{{ t('admin.plugins.title') }}</h2>
          <el-button type="primary" @click="showAddDialog = true">{{ t('admin.plugins.addPlugin') }}</el-button>
        </div>

        <template v-if="plugins.length > 0">
          <el-table v-if="!isMobile" :data="plugins" stripe v-loading="loading">
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
            <div v-for="row in plugins" :key="row.name" class="plugin-card">
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
        </template>
        <EmptyState v-else icon="cable" :title="t('admin.plugins.emptyTitle')" :description="t('admin.plugins.emptyDesc')">
          <template #action>
            <el-button type="primary" @click="showAddDialog = true">{{ t('admin.plugins.addPlugin') }}</el-button>
          </template>
        </EmptyState>
      </el-tab-pane>

      <!-- ============ Plugin marketplace ============ -->
      <el-tab-pane :label="t('admin.plugins.tabMarket')" name="market">
        <div class="page-header">
          <h2>{{ t('admin.plugins.marketTitle') }}</h2>
          <el-button type="primary" plain @click="loadMarketplace" :loading="marketLoading">{{ t('common.refresh') }}</el-button>
        </div>

        <el-card class="market-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span>{{ t('admin.plugins.registrySource') }}</span>
              <el-button size="small" type="primary" plain @click="showRegDialog = true">{{ t('admin.plugins.addRegistry') }}</el-button>
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
      </el-tab-pane>

      <!-- ============ Media fetch (lyrics / covers) — 能力级全局设置,独立于任何单个插件 ============ -->
      <el-tab-pane :label="t('admin.plugins.tabMedia')" name="media">
        <div class="page-header">
          <h2>{{ t('admin.plugins.mediaTitle') }}</h2>
          <span class="page-sub">{{ t('admin.plugins.mediaSub') }}</span>
        </div>

        <el-card class="mf-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span class="card-title">{{ t('admin.plugins.lyricsFetch') }}</span>
              <el-tag v-if="lyricProviderPlugins.length === 0" size="small" type="warning" effect="plain">{{ t('admin.plugins.noLyricProvider') }}</el-tag>
            </div>
          </template>
          <div v-if="lyricProviderPlugins.length === 0" class="mf-empty">
            <el-empty :description="t('admin.plugins.noLyricProviderDesc')" :image-size="60">
              <el-button size="small" type="primary" @click="activeTab = 'market'">{{ t('admin.plugins.goMarket') }}</el-button>
            </el-empty>
          </div>
          <div v-else class="mf-media">
            <div class="mf-media-row">
              <span class="mf-media-label">{{ t('admin.plugins.sourcePlugin') }}</span>
              <el-select v-model="lyricsSettings.providerId" clearable :placeholder="t('admin.plugins.auto')" style="width: 260px" @change="saveMediaSettings('lyrics')">
                <el-option v-for="p in lyricProviderPlugins" :key="p.id" :label="providerLabel(p)" :value="p.id" />
              </el-select>
              <span class="field-hint">{{ t('admin.plugins.sourcePluginHint') }}</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">{{ t('admin.plugins.onDemand') }}</span>
              <el-switch v-model="lyricsSettings.onDemand" @change="saveMediaSettings('lyrics')" />
              <span class="field-hint">{{ t('admin.plugins.onDemandHintLyrics') }}</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">{{ t('admin.plugins.persist') }}</span>
              <el-switch v-model="lyricsSettings.persist" @change="saveMediaSettings('lyrics')" />
              <span class="field-hint">{{ t('admin.plugins.persistHintLyrics') }}</span>
            </div>
            <div class="mf-media-row">
              <el-button size="small" type="primary" plain :loading="lyricsBackfill.running" @click="startBackfill('lyrics')">{{ t('admin.plugins.batchBackfill') }}</el-button>
              <span v-if="lyricsBackfill.total > 0" class="field-hint">{{ backfillText('lyrics') }}</span>
            </div>
          </div>
        </el-card>

        <el-card class="mf-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span class="card-title">{{ t('admin.plugins.coverFetch') }}</span>
              <el-tag v-if="coverProviderPlugins.length === 0" size="small" type="warning" effect="plain">{{ t('admin.plugins.noCoverProvider') }}</el-tag>
            </div>
          </template>
          <div v-if="coverProviderPlugins.length === 0" class="mf-empty">
            <el-empty :description="t('admin.plugins.noCoverProviderDesc')" :image-size="60">
              <el-button size="small" type="primary" @click="activeTab = 'market'">{{ t('admin.plugins.goMarket') }}</el-button>
            </el-empty>
          </div>
          <div v-else class="mf-media">
            <div class="mf-media-row">
              <span class="mf-media-label">{{ t('admin.plugins.sourcePlugin') }}</span>
              <el-select v-model="coversSettings.providerId" clearable :placeholder="t('admin.plugins.auto')" style="width: 260px" @change="saveMediaSettings('covers')">
                <el-option v-for="p in coverProviderPlugins" :key="p.id" :label="providerLabel(p)" :value="p.id" />
              </el-select>
              <span class="field-hint">{{ t('admin.plugins.sourcePluginHint') }}</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">{{ t('admin.plugins.onDemand') }}</span>
              <el-switch v-model="coversSettings.onDemand" @change="saveMediaSettings('covers')" />
              <span class="field-hint">{{ t('admin.plugins.onDemandHintCovers') }}</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">{{ t('admin.plugins.persist') }}</span>
              <el-switch v-model="coversSettings.persist" @change="saveMediaSettings('covers')" />
              <span class="field-hint">{{ t('admin.plugins.persistHintCovers') }}</span>
            </div>
            <div class="mf-media-row">
              <el-button size="small" type="primary" plain :loading="coversBackfill.running" @click="startBackfill('covers')">{{ t('admin.plugins.batchBackfill') }}</el-button>
              <span v-if="coversBackfill.total > 0" class="field-hint">{{ backfillText('covers') }}</span>
            </div>
          </div>
        </el-card>

        <div class="mf-actions">
          <el-button type="primary" :loading="savingMedia" @click="saveAllMedia">{{ t('admin.plugins.saveSettings') }}</el-button>
          <span class="field-hint">{{ t('admin.plugins.saveSettingsHint') }}</span>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Add plugin dialog -->
    <el-dialog v-model="showAddDialog" :title="t('admin.plugins.addPlugin')" width="500px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item :label="t('admin.plugins.pluginName')"><el-input v-model="newPlugin.name" /></el-form-item>
        <el-form-item :label="t('admin.plugins.description')"><el-input v-model="newPlugin.description" type="textarea" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="addPlugin">{{ t('common.add') }}</el-button>
      </template>
    </el-dialog>

    <!-- Add registry dialog -->
    <el-dialog v-model="showRegDialog" :title="t('admin.plugins.addRegistry')" width="500px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item label="URL">
          <el-input v-model="newRegistryUrl" placeholder="https://example.com/registry.json" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRegDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="addingReg" @click="addRegistry">{{ t('common.add') }}</el-button>
      </template>
    </el-dialog>

    <!-- Plugin detail dialog: 功能介绍 / 处理逻辑 / 能力 / 权限 / 配置 -->
    <el-dialog v-model="showConfigDialog" class="plugin-config-dialog" :title="`${t('admin.plugins.pluginDetail')} · ${displayName(editing)}`" width="720px" top="6vh" :append-to-body="true">
      <div class="pd-head">
        <span class="pd-id">{{ editing?.id }}@{{ editing?.version }}</span>
        <el-tag size="small" :type="typeTagColor(editing)" effect="light">{{ typeLabel(editing) }}</el-tag>
        <el-tag v-if="editing?.builtin" size="small" type="warning" effect="light">{{ t('admin.plugins.builtin') }}</el-tag>
        <el-tag v-else-if="editing" size="small" type="info" effect="light">{{ t('admin.plugins.external') }}</el-tag>
      </div>

      <div class="pd-section">
        <h4>{{ t('admin.plugins.funcIntro') }}</h4>
        <p class="pd-desc">{{ displayDesc(editing) || "—" }}</p>
      </div>

      <div class="pd-section">
        <h4>{{ t('admin.plugins.processingLogic') }}</h4>
        <div v-if="docMarkdown" class="pd-md" v-html="docMarkdown"></div>
        <template v-else>
          <ul class="pd-capdocs">
            <li v-for="cap in capabilityList(editing)" :key="cap">{{ capLabel(cap) }}{{ t('admin.plugins.capSep') }}{{ capDoc(cap) }}</li>
          </ul>
          <p v-if="capabilityList(editing).length" class="pd-hint">{{ t('admin.plugins.autoDocHint') }}</p>
          <p v-else class="pd-hint">{{ t('admin.plugins.noDocHint') }}</p>
        </template>
      </div>

      <div v-if="capabilityList(editing).length > 0" class="pd-section">
        <h4>{{ t('admin.plugins.capList') }}</h4>
        <div class="cap-row">
          <el-tag v-for="cap in capabilityList(editing)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
        </div>
      </div>

      <div v-if="permissionList(editing).length > 0" class="pd-section">
        <h4>{{ t('admin.plugins.permissionsTitle') }}</h4>
        <div class="cap-row">
          <el-tag v-for="perm in permissionList(editing)" :key="perm" size="small" type="warning" effect="plain">{{ permLabel(perm) }}</el-tag>
        </div>
      </div>

      <div v-if="canSaveConfig && configFields.length > 0">
        <template v-for="g in groupedConfigFields" :key="g.key">
          <div class="pd-section">
            <h4>{{ g.label }}</h4>
            <el-form label-width="120px">
              <!-- Config form is driven entirely by the plugin manifest's configSchema.
                   No field is hardcoded to go-music-dl. -->
              <el-form-item v-for="f in g.fields" :key="f.key" :label="f.label">
                <!-- keywords 字段特殊处理：渲染为标签输入组件，内置搜索入库按钮。
                     必须在 type === 'text' 之前，否则 keywords (type: text) 会被普通文本输入框吃掉。 -->
                <div v-if="f.key === 'keywords'" class="tag-input-wrap">
                  <el-input
                    v-model="tagInputValue"
                    :placeholder="t('admin.plugins.tagPlaceholder')"
                    @keyup.enter="addTag(f.key)"
                  >
                    <template #append>
                      <el-button @click="addTag(f.key)">{{ t('common.add') }}</el-button>
                    </template>
                  </el-input>
                  <div v-if="getTags(f.key).length > 0" class="tag-list">
                    <el-tag
                      v-for="(tag, idx) in getTags(f.key)"
                      :key="idx"
                      closable
                      :disable-transitions="true"
                      @close="removeTag(f.key, idx)"
                    >{{ tag }}</el-tag>
                  </div>
                  <div class="tag-actions">
                    <el-button type="primary" plain :loading="refreshingPlugin" @click="refreshPlugin">
                      {{ t('admin.plugins.keywordSearchImport') }}
                    </el-button>
                    <span v-if="pluginRefreshResult" class="test-result" :class="{ ok: pluginRefreshResult.success }">{{ pluginRefreshResult.message }}</span>
                  </div>
                  <span v-if="f.help" class="field-hint">{{ f.help }}</span>
                </div>
                <el-input
                  v-else-if="f.type === 'text' || f.type === 'url'"
                  v-model="editConfig[f.key]"
                  :placeholder="f.help"
                  style="width: 100%"
                />
                <el-input
                  v-else-if="f.type === 'password'"
                  v-model="editConfig[f.key]"
                  type="password"
                  show-password
                  :placeholder="f.help"
                  style="width: 100%"
                />
                <el-input-number
                  v-else-if="f.type === 'number'"
                  v-model="editConfig[f.key]"
                  :min="0"
                  controls-position="right"
                  style="width: 180px"
                />
                <el-radio-group v-else-if="f.type === 'radio'" v-model="editConfig[f.key]">
                  <el-radio v-for="o in (f.options || [])" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
                </el-radio-group>
                <el-select v-else-if="f.type === 'select'" v-model="editConfig[f.key]" style="width: 100%">
                  <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
                </el-select>
                <el-select
                  v-else-if="f.type === 'multiselect' || f.type === 'multi-select'"
                  v-model="editConfig[f.key]"
                  multiple
                  collapse-tags
                  style="width: 100%"
                >
                  <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
                </el-select>
                <!-- playlist-multi:参考歌单多选(本地 + 平台导入歌单,可搜索),由 manifest configSchema 声明 -->
                <el-select
                  v-else-if="f.type === 'playlist-multi'"
                  v-model="editConfig[f.key]"
                  multiple
                  filterable
                  collapse-tags
                  clearable
                  :placeholder="t('admin.plugins.playlistPlaceholder')"
                  style="width: 100%"
                >
                  <el-option v-for="o in playlistOptions" :key="o.value" :label="o.label" :value="o.value" />
                </el-select>
                <!-- candidate-list:推荐榜单(平台 + URL + 显示名)可增删替换,由 manifest configSchema 声明 -->
                <div v-else-if="f.type === 'candidate-list'" class="candidate-list">
                  <div v-for="(item, idx) in (editConfig[f.key] || [])" :key="idx" class="candidate-row">
                    <el-select v-model="item.platform" style="width: 104px; flex: none">
                      <el-option :label="t('admin.plugins.platformNetease')" value="netease" />
                      <el-option :label="t('admin.plugins.platformQQ')" value="qq" />
                    </el-select>
                    <el-input v-model="item.url" :placeholder="t('admin.plugins.chartUrl')" style="flex: 1; min-width: 0" />
                    <el-input v-model="item.name" :placeholder="t('admin.plugins.chartNamePlaceholder')" style="width: 150px; flex: none" />
                    <el-button
                      circle
                      text
                      type="danger"
                      :disabled="(editConfig[f.key] || []).length <= 1"
                      :title="t('admin.plugins.removeChartTitle')"
                      @click="removeCandidate(f.key, idx)"
                    >✕</el-button>
                  </div>
                  <el-button text type="primary" @click="addCandidate(f.key)">+ {{ t('admin.plugins.addChart') }}</el-button>
                </div>
                <el-switch v-else-if="f.type === 'switch'" v-model="editConfig[f.key]" />
                <span v-if="f.help && f.key !== 'keywords'" class="field-hint">{{ f.help }}</span>
                <!-- 配置项下方的「获取链接」:点击快速进入对应申请 / 授权 / 说明页。
                     支持 ${fieldKey} 插值当前配置值(如把已填的 apiKey 拼进授权页 URL)。
                     纯 manifest 驱动,不写死任何插件。 -->
                <div v-if="(f.links || []).length" class="field-links">
                  <a
                    v-for="(lk, li) in resolvedLinks(f)"
                    :key="li"
                    :href="lk.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="field-link"
                  ><span class="field-link-icon">↗</span>{{ lk.text }}</a>
                </div>
              </el-form-item>
            </el-form>
          </div>
        </template>
      </div>

      <!-- 操作模块:独立于配置项,只要有相关操作能力的插件都显示 -->
      <div v-if="showOperationSection" class="pd-section">
        <h4>{{ t('admin.plugins.operations') }}</h4>
        <el-form label-width="120px">
          <el-form-item v-if="isSourcePlugin(editing) || hasWebRotation">
            <el-button v-if="isSourcePlugin(editing)" type="success" plain :loading="testing" @click="testSource">{{ t('common.testConnection') }}</el-button>
            <el-button v-if="hasWebRotation" type="warning" plain :loading="purging" @click="purgeWebSongs">{{ t('admin.plugins.purgeNow') }}</el-button>
            <span v-if="testResult" class="test-result" :class="{ ok: testResult.success }">{{ testResult.message }}</span>
          </el-form-item>

          <el-form-item v-if="isRecommenderPlugin(editing)">
            <el-button type="warning" plain :loading="refreshingPlugin" @click="refreshPlugin">
              {{ t('admin.plugins.refreshNow') }}
            </el-button>
            <span v-if="pluginRefreshResult" class="test-result" :class="{ ok: pluginRefreshResult.success }">{{ pluginRefreshResult.message }}</span>
            <span class="field-hint">{{ t('admin.plugins.refreshNowHint') }}</span>
          </el-form-item>

          <el-form-item v-if="isCleanupPlugin(editing)">
            <el-button type="danger" plain :loading="refreshingPlugin" @click="refreshPlugin">
              {{ t('admin.plugins.purgeNow') }}
            </el-button>
            <span v-if="pluginRefreshResult" class="test-result" :class="{ ok: pluginRefreshResult.success }">{{ pluginRefreshResult.message }}</span>
            <span class="field-hint">{{ t('admin.plugins.cleanupHint') }}</span>
          </el-form-item>
        </el-form>
      </div>

      <el-alert
        v-if="canSaveConfig && configFields.length > 0"
        type="info"
        :closable="false"
        show-icon
        :title="t('admin.plugins.pluginTypeTitle', { type: typeLabel(editing) })"
        :description="pluginHint(editing)"
      />

      <template #footer>
        <el-button @click="showConfigDialog = false">{{ t('common.close') }}</el-button>
        <el-button v-if="canSaveConfig && configFields.length > 0" type="primary" :loading="saving" @click="() => saveConfig()">{{ t('admin.plugins.saveConfig') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api, { formatApiError } from "@/api";
import { useIsMobile } from "@/composables/useIsMobile";
import { parseManifest, parseConfig } from "@/utils/plugin";
import { resolveField, localName, localDesc, localDoc, resolvePluginI18n } from "@/utils/pluginI18n";

const { t } = useI18n();
const activeTab = ref<"installed" | "market" | "media">("installed");

// 移动端(≤768)把 el-table 切换为卡片列表,避免横向滚动(见 frontend-responsive CI 守卫)。
const isMobile = useIsMobile();

// ---- installed plugins ----
const plugins = ref<any[]>([]);
const loading = ref(false);
const showAddDialog = ref(false);
const newPlugin = reactive({ name: "", description: "" });

// ---- marketplace ----
const registries = ref<any[]>([]);
const marketPlugins = ref<any[]>([]);
const marketLoading = ref(false);
const installing = ref<string>("");
const showRegDialog = ref(false);
const newRegistryUrl = ref("");
const addingReg = ref(false);

/** 市场按注册表分组:以「注册表来源」里每个启用的注册表为分组骨架,
 *  确保即便某个注册表加载失败(网络不可达),也会显示为一个分组并给出错误提示,
 *  而不是静默消失。官方内置核心插件已不在此列表(只在「已安装」tab 展示)。 */
const groupedMarket = computed<any[]>(() => {
  const groups: any[] = [];
  for (const r of registries.value) {
    if (!r.enabled) continue;
    const items = marketPlugins.value.filter((p) => p.registryUrl === r.url);
    groups.push({
      key: r.url,
      title: r.url,
      sourceLabel: sourceLabel(r.url),
      items,
      error: r.error || null,
    });
  }
  return groups;
});

// ---- config dialog ----
const showConfigDialog = ref(false);
const editing = ref<any>(null);
const editConfig = reactive<any>({});
const testing = ref(false);
const saving = ref(false);
const purging = ref(false);
const testResult = ref<any>(null);

// ---- 歌词/封面按需获取(全局设置 + 批量补全) ----
const lyricsSettings = reactive({ providerId: "", onDemand: true, persist: false });
const coversSettings = reactive({ providerId: "", onDemand: true, persist: true });
const lyricsBackfill = reactive({ running: false, total: 0, done: 0, ok: 0, fail: 0, skipped: 0 });
const coversBackfill = reactive({ running: false, total: 0, done: 0, ok: 0, fail: 0, skipped: 0 });
const savingMedia = ref(false);

// ---- health ----
const healthMap = ref<Record<string, any>>({});

/** Config fields rendered in the dialog — driven by the plugin manifest.
 *  若 manifest 声明了 i18n 字典,按当前语言覆盖字段 label/help/options。 */
const configFields = computed<any[]>(() => {
  const m = parseManifest(editing.value);
  return (m.configSchema || []).map((f: any) => resolveField(m, f));
});

/** 按 group 字段分组的配置项,每组渲染为带标题的模块框。无 group 的字段归入"其他"。
 *  分组标题优先取插件 dict 覆盖,其次核心内置分组翻译,最后回退分组名。 */
const groupedConfigFields = computed(() => {
  const groups: Record<string, any[]> = {};
  const groupOrder = ['schedule', 'batch', 'backend', 'recommend', 'keyword', 'frontend'];
  const groupLabels: Record<string, string> = {
    schedule: t('admin.plugins.group.schedule'),
    batch: t('admin.plugins.group.batch'),
    backend: t('admin.plugins.group.backend'),
    recommend: t('admin.plugins.group.recommend'),
    keyword: t('admin.plugins.group.keyword'),
    frontend: t('admin.plugins.group.frontend'),
  };
  const dictGroups = resolvePluginI18n(parseManifest(editing.value)).groupLabels;
  for (const f of configFields.value) {
    const g = f.group || '_ungrouped';
    if (!groups[g]) groups[g] = [];
    groups[g].push(f);
  }
  const result: any[] = [];
  for (const k of groupOrder) {
    if (groups[k]) {
      result.push({ key: k, label: dictGroups[k] || groupLabels[k] || k, fields: groups[k] });
      delete groups[k];
    }
  }
  // 剩余未识别的 group 和未分组字段
  for (const k of Object.keys(groups).sort()) {
    result.push({ key: k, label: k === '_ungrouped' ? t('admin.plugins.group.other') : dictGroups[k] || k, fields: groups[k] });
  }
  return result;
});

// ---- playlist-multi(参考歌单多选):歌单选项(本地 + 平台导入),打开详情弹窗时懒加载 ----
const allPlaylists = ref<any[]>([]);
const playlistOptions = computed(() =>
  allPlaylists.value.map((p: any) => ({
    value: p.id,
    label: p.sourcePlatform ? `[${p.sourcePlatform}] ${p.name}` : p.name,
  })),
);
async function loadPlaylistOptions() {
  if (allPlaylists.value.length) return;
  try {
    const res = await api.get("/rest/api/v1/playlists", { params: { page: 1, pageSize: 200 } });
    allPlaylists.value = res.data.items || [];
  } catch {
    allPlaylists.value = [];
  }
}

/** Whether the plugin declares the web-rotation capability (shows the purge button). */
const hasWebRotation = computed<boolean>(() =>
  (parseManifest(editing.value).capabilities || []).includes("webRotation"),
);

/** 操作模块是否显示:插件有测试连接、立即清理、立即刷新、立即清理(cleanup)等操作按钮时显示。 */
const showOperationSection = computed<boolean>(() =>
  !!editing.value && (
    isSourcePlugin(editing.value) ||
    hasWebRotation.value ||
    isRecommenderPlugin(editing.value) ||
    isCleanupPlugin(editing.value)
  ),
);

/** 歌词/封面 provider 候选:所有已安装且声明对应能力的插件(媒体获取页下拉用),
 *  不写死插件名 —— 未来装新歌词/封面插件自动出现,零代码改动。 */
const lyricProviderPlugins = computed<any[]>(() =>
  plugins.value.filter((p) => (parseManifest(p).capabilities || []).includes("lyricProvider")),
);
const coverProviderPlugins = computed<any[]>(() =>
  plugins.value.filter((p) => (parseManifest(p).capabilities || []).includes("coverProvider")),
);
function providerLabel(p: any): string {
  return `${displayName(p)}${p.enabled ? "" : t('admin.plugins.providerDisabled')}`;
}

function isSourcePlugin(plugin: any) {
  return parseManifest(plugin).type === "source";
}

/** 推荐歌单类插件(每日推荐 / 本地推荐 / 今日漫游 / 平台榜单入库如 QQ/网易/酷狗 / 第三方推荐歌单如 ListenBrainz):支持手动刷新。 */
function isRecommenderPlugin(plugin: any): boolean {
  const caps = parseManifest(plugin).capabilities || [];
  return ["dailyPlaylist", "localPlaylist", "comboPlaylist", "recommendPlaylist", "localPlatformRecommend"].some((c) => caps.includes(c));
}

/** 歌单清理类插件:支持手动触发清理。 */
function isCleanupPlugin(plugin: any): boolean {
  return (parseManifest(plugin).capabilities || []).includes("playlistCleanup");
}

/** 插件是否配置了 keywords 字段(关键词搜索导入)。 */
const hasKeywordsConfig = computed(() => {
  if (!editing.value) return false;
  const m = parseManifest(editing.value);
  return (m.configSchema || []).some((f: any) => f.key === "keywords");
});

// ---- tag-input 组件支持 ----
const tagInputValue = ref('');

/** 把 editConfig 中以换行分隔的关键词字符串转为数组。 */
function getTags(key: string): string[] {
  const v = editConfig[key];
  if (!v) return [];
  return String(v).split('\n').filter((s: string) => s.trim().length > 0);
}

/** 添加一个关键词标签。 */
function addTag(key: string) {
  const val = tagInputValue.value.trim();
  if (!val) return;
  const tags = getTags(key);
  if (tags.includes(val)) {
    tagInputValue.value = '';
    return;
  }
  tags.push(val);
  editConfig[key] = tags.join('\n');
  tagInputValue.value = '';
}

/** 删除指定索引的关键词标签。 */
function removeTag(key: string, idx: number) {
  const tags = getTags(key);
  tags.splice(idx, 1);
  editConfig[key] = tags.join('\n');
}

// 手动刷新:调 /v1/recommend/refresh 传 pluginId,只重新生成「该插件自身」的歌单。
// 后端为**异步任务通道**(立即返回 started),前端轮询 GET /v1/plugins/:id/job
// 直到任务完成——不再被沙箱 15s / axios 15s 卡死。
const refreshingPlugin = ref(false);
const pluginRefreshResult = ref<{ success: boolean; message: string } | null>(null);
let pluginJobPollTimer: ReturnType<typeof setInterval> | null = null;
function stopPluginJobPoll() {
  if (pluginJobPollTimer) { clearInterval(pluginJobPollTimer); pluginJobPollTimer = null; }
}
onUnmounted(stopPluginJobPoll);

async function refreshPlugin() {
  if (!editing.value || refreshingPlugin.value) return;
  const pluginId = editing.value.id;
  refreshingPlugin.value = true;
  pluginRefreshResult.value = null;
  let done = false;
  const finish = (r: { success: boolean; message: string }) => {
    if (done) return;
    done = true;
    stopPluginJobPoll();
    pluginRefreshResult.value = r;
    refreshingPlugin.value = false;
  };
  try {
    const res = await api.post("/rest/api/v1/recommend/refresh", { pluginId, keywordOnly: true });
    const d = res.data || {};
    if (!d.success) { finish({ success: false, message: d.error || t('admin.plugins.refreshFailed') }); return; }
    if (!d.started && !d.alreadyRunning) { finish({ success: true, message: t('admin.plugins.refreshDone') }); return; }
    finish({ success: true, message: d.alreadyRunning ? t('admin.plugins.refreshRunningQueued') : t('admin.plugins.refreshRunningStarted') });
    // 轮询任务状态(每 2s,上限 6 分钟;超过则提示仍在后台运行)
    let elapsed = 0;
    const POLL_MS = 2000;
    const MAX_POLL_MS = 360000;
    const poll = async () => {
      try {
        const st = await api.get(`/rest/api/v1/plugins/${pluginId}/job`, { timeout: 10000 });
        const job = st.data?.job;
        if (job?.status === "ok") {
          finish({ success: true, message: job.summary ? String(job.summary) : t('admin.plugins.refreshDone') });
        } else if (job?.status === "error") {
          const err = job.sandboxCode
            ? `[${job.sandboxCode}] ${String(job.error || t('admin.plugins.refreshFailed'))}${job.hint ? t('admin.plugins.periodDot') + String(job.hint) : ""}`
            : String(job.error || t('admin.plugins.refreshFailed'));
          finish({ success: false, message: err });
        } else if (elapsed >= MAX_POLL_MS) {
          finish({ success: true, message: t('admin.plugins.refreshStillRunning') });
        }
      } catch { /* 单次轮询失败忽略,下一轮再试 */ }
    };
    pluginJobPollTimer = setInterval(() => { elapsed += POLL_MS; poll().catch(() => {}); }, POLL_MS);
  } catch (e: any) {
    finish({ success: false, message: formatApiError(e, t('admin.plugins.refreshFailed')) });
  }
}

/** Manifest display name, falling back to the stored row name (= plugin id).
 *  若 manifest 声明了 i18n 字典,按当前界面语言取本地化名字。 */
function displayName(plugin: any): string {
  const name = parseManifest(plugin).name || plugin?.name || "";
  return localName(parseManifest(plugin), name);
}

/** Manifest 简介文案(按字典本地化,未覆盖回退默认)。 */
function displayDesc(plugin: any): string {
  return localDesc(parseManifest(plugin), parseManifest(plugin).description || plugin?.description || "");
}

/** core 内置行为插件(同曲多源组 / 播放优选等):列表状态开关 = 总开关(整体启停,
 *  关 = 不再归组 / 不再优选),配置弹窗 configSchema = 功能子开关,两层叠加控制。 */
function isCore(plugin: any): boolean {
  return parseManifest(plugin).type === "core";
}

function hasConfig(plugin: any): boolean {
  return (parseManifest(plugin).configSchema || []).length > 0;
}

// 详情弹窗:处理逻辑(markdown)与配置可保存性(文档按插件 i18n 字典本地化,缺省回退默认)
const docMarkdown = computed(() => {
  const md = localDoc(parseManifest(editing.value), parseManifest(editing.value).documentation || "");
  return md ? renderMarkdown(md) : "";
});
const canSaveConfig = computed(() => !!editing.value && editing.value.installed !== false);

// Plugin taxonomy — labels only. The backend decides what each type can do via
// manifest capabilities; the UI just renders whatever it declares.
const TYPE_LABELS: Record<string, string> = {
  source: t('admin.plugins.type.source'),
  importer: t('admin.plugins.type.importer'),
  recommender: t('admin.plugins.type.recommender'),
  sync: t('admin.plugins.type.sync'),
  lyrics: t('admin.plugins.type.lyrics'),
  cover: t('admin.plugins.type.cover'),
  renderer: t('admin.plugins.type.renderer'),
  scrobbler: t('admin.plugins.type.scrobbler'),
  core: t('admin.plugins.type.core'),
};
const TYPE_COLORS: Record<string, string> = {
  source: "primary",
  importer: "success",
  recommender: "warning",
  sync: "info",
  lyrics: "danger",
  cover: "danger",
  renderer: "info",
  scrobbler: "info",
  core: "warning",
};
const CAP_LABELS: Record<string, string> = {
  search: t('admin.plugins.cap.search'),
  playlistSearch: t('admin.plugins.cap.playlistSearch'),
  songSearch: t('admin.plugins.cap.songSearch'),
  artistSearch: t('admin.plugins.cap.artistSearch'),
  albumSearch: t('admin.plugins.cap.albumSearch'),
  recommend: t('admin.plugins.cap.recommend'),
  playlistSongs: t('admin.plugins.cap.playlistSongs'),
  stream: t('admin.plugins.cap.stream'),
  lyrics: t('admin.plugins.cap.lyrics'),
  webRotation: t('admin.plugins.cap.webRotation'),
  playlistImport: t('admin.plugins.cap.playlistImport'),
  playlistFile: t('admin.plugins.cap.playlistFile'),
  dailyPlaylist: t('admin.plugins.cap.dailyPlaylist'),
  localPlaylist: t('admin.plugins.cap.localPlaylist'),
  comboPlaylist: t('admin.plugins.cap.comboPlaylist'),
  recommendPlaylist: t('admin.plugins.cap.recommendPlaylist'),
  localPlatformRecommend: t('admin.plugins.cap.localPlatformRecommend'),
  playlistSync: t('admin.plugins.cap.playlistSync'),
  autoMatch: t('admin.plugins.cap.autoMatch'),
  playlistCleanup: t('admin.plugins.cap.playlistCleanup'),
  lyricProvider: t('admin.plugins.cap.lyricProvider'),
  coverProvider: t('admin.plugins.cap.coverProvider'),
  renderer: t('admin.plugins.cap.renderer'),
  scrobbler: t('admin.plugins.cap.scrobbler'),
  songGroup: t('admin.plugins.cap.songGroup'),
  playPreference: t('admin.plugins.cap.playPreference'),
  artistInfo: t('admin.plugins.cap.artistInfo'),
};
const PERM_LABELS: Record<string, string> = {
  log: t('admin.plugins.perm.log'),
  storage: t('admin.plugins.perm.storage'),
  net: t('admin.plugins.perm.net'),
  command: t('admin.plugins.perm.command'),
  fs: t('admin.plugins.perm.fs'),
  "fs:music": t('admin.plugins.perm.fsMusic'),
  "fs:external": t('admin.plugins.perm.fsExternal'),
  "songs:read": t('admin.plugins.perm.songsRead'),
  "songs:write": t('admin.plugins.perm.songsWrite'),
  "playlists:read": t('admin.plugins.perm.playlistsRead'),
  "playlists:write": t('admin.plugins.perm.playlistsWrite'),
  "inter-plugin": t('admin.plugins.perm.interPlugin'),
};

// 能力 → 处理逻辑说明(详情页在插件未提供 documentation 时按能力自动生成)
const CAP_DOCS: Record<string, string> = {
  search: t('admin.plugins.capDoc.search'),
  playlistSearch: t('admin.plugins.capDoc.playlistSearch'),
  songSearch: t('admin.plugins.capDoc.songSearch'),
  artistSearch: t('admin.plugins.capDoc.artistSearch'),
  albumSearch: t('admin.plugins.capDoc.albumSearch'),
  recommend: t('admin.plugins.capDoc.recommend'),
  playlistSongs: t('admin.plugins.capDoc.playlistSongs'),
  stream: t('admin.plugins.capDoc.stream'),
  lyrics: t('admin.plugins.capDoc.lyrics'),
  webRotation: t('admin.plugins.capDoc.webRotation'),
  playlistImport: t('admin.plugins.capDoc.playlistImport'),
  playlistFile: t('admin.plugins.capDoc.playlistFile'),
  dailyPlaylist: t('admin.plugins.capDoc.dailyPlaylist'),
  localPlaylist: t('admin.plugins.capDoc.localPlaylist'),
  comboPlaylist: t('admin.plugins.capDoc.comboPlaylist'),
  recommendPlaylist: t('admin.plugins.capDoc.recommendPlaylist'),
  localPlatformRecommend: t('admin.plugins.capDoc.localPlatformRecommend'),
  playlistSync: t('admin.plugins.capDoc.playlistSync'),
  autoMatch: t('admin.plugins.capDoc.autoMatch'),
  playlistCleanup: t('admin.plugins.capDoc.playlistCleanup'),
  lyricProvider: t('admin.plugins.capDoc.lyricProvider'),
  coverProvider: t('admin.plugins.capDoc.coverProvider'),
  renderer: t('admin.plugins.capDoc.renderer'),
  scrobbler: t('admin.plugins.capDoc.scrobbler'),
  songGroup: t('admin.plugins.capDoc.songGroup'),
  playPreference: t('admin.plugins.capDoc.playPreference'),
  artistInfo: t('admin.plugins.capDoc.artistInfo'),
};

// 极简 markdown 渲染（文档为受控内容,先转义再套标签,防 XSS）
function renderMarkdown(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc(md);
  html = html.replace(/^```\n?([\s\S]*?)```$/gm, (_m, c) => `<pre class="md-code">${c}</pre>`);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  let listOpen = false;
  for (const line of html.split("\n")) {
    if (line.startsWith("<li>")) {
      if (!listOpen) { out.push("<ul>"); listOpen = true; }
      out.push(line);
    } else {
      if (listOpen) { out.push("</ul>"); listOpen = false; }
      if (line.trim()) out.push(`<p>${line}</p>`);
    }
  }
  if (listOpen) out.push("</ul>");
  return out.join("\n");
}

function capDoc(cap: string): string {
  return t(CAP_DOCS[cap] || 'admin.plugins.capDoc.fallback');
}

function typeLabel(plugin: any): string {
  const ty = parseManifest(plugin).type;
  return t(TYPE_LABELS[ty] || ty || 'admin.plugins.typeUnknown');
}

function typeTagColor(plugin: any): any {
  return TYPE_COLORS[parseManifest(plugin).type] || "info";
}

function capabilityList(plugin: any): string[] {
  return parseManifest(plugin).capabilities || [];
}

function permissionList(plugin: any): string[] {
  return parseManifest(plugin).permissions || [];
}

/** 平台标签:优先 manifest.platformLabels 的中文名,缺省回退 slug。 */
function platformList(plugin: any): { slug: string; label: string }[] {
  const m = parseManifest(plugin);
  const slugs: string[] = Array.isArray(m.platforms) ? m.platforms : [];
  const labels: Record<string, string> = m.platformLabels || {};
  return slugs.map((s) => ({ slug: s, label: labels[s] || s }));
}

function capLabel(cap: string): string {
  return t(CAP_LABELS[cap] || cap);
}

function permLabel(perm: string): string {
  return t(PERM_LABELS[perm] || perm);
}

// Health status -> tag color / label.
function healthType(id: string): any {
  const s = healthMap.value[id]?.status;
  if (s === "green") return "success";
  if (s === "yellow") return "warning";
  if (s === "red" || s === "down") return "danger";
  return "info";
}
function healthLabel(id: string): string {
  const s: string = healthMap.value[id]?.status || "none";
  const key: Record<string, string> = {
    green: 'admin.plugins.health.green',
    yellow: 'admin.plugins.health.yellow',
    red: 'admin.plugins.health.red',
    down: 'admin.plugins.health.down',
    unknown: 'admin.plugins.health.unknown',
    none: 'admin.plugins.health.none',
  };
  return t(key[s] || 'admin.plugins.health.none');
}

const TYPE_HINTS: Record<string, string> = {
  source: t('admin.plugins.typeHint.source'),
  importer: t('admin.plugins.typeHint.importer'),
  recommender: t('admin.plugins.typeHint.recommender'),
  sync: t('admin.plugins.typeHint.sync'),
  lyrics: t('admin.plugins.typeHint.lyrics'),
  cover: t('admin.plugins.typeHint.cover'),
  renderer: t('admin.plugins.typeHint.renderer'),
  scrobbler: t('admin.plugins.typeHint.scrobbler'),
  core: t('admin.plugins.typeHint.core'),
};

function pluginHint(plugin: any): string {
  const m = parseManifest(plugin);
  const extra = hasConfig(plugin) ? "" : t('admin.plugins.noConfigHint');
  return [localDesc(m, m.description || ""), TYPE_HINTS[m.type], extra].filter(Boolean).join(" ");
}

function providerId(plugin: any): string {
  return parseManifest(plugin).id || "";
}

/** 配置项下方的「获取链接」:渲染为可点击外链,支持 ${fieldKey} 插值当前配置值。
 *  例:sessionKey 的 link.url = "https://last.fm/api/auth?api_key=${apiKey}"
 *  → 自动把用户已填的 apiKey 拼进去,点开即是带 Key 的授权页。 */
function resolvedLinks(f: any): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  for (const lk of f.links || []) {
    const raw = typeof lk.url === "string" ? lk.url : "";
    const url = raw.replace(/\$\{(\w+)\}/g, (_m: string, k: string) => {
      const v = editConfig[k];
      return v === undefined || v === null ? "" : encodeURIComponent(String(v));
    });
    out.push({ text: lk.text || url, url });
  }
  return out;
}

async function loadPlugins() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    plugins.value = (res.data || []).map((p: any) => ({ ...p, manifest: p.manifest, config: p.config }));
  } catch {
    plugins.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadHealth() {
  try {
    const res = await api.get("/rest/api/v1/plugins/health");
    const map: Record<string, any> = {};
    for (const h of res.data?.health || []) map[h.pluginId] = h;
    healthMap.value = map;
  } catch {
    healthMap.value = {};
  }
}

async function togglePlugin(plugin: any) {
  await api.put(`/rest/api/v1/plugins/${plugin.id}/toggle`);
  ElMessage.success(t('common.updated'));
  loadHealth();
}

/** 简单 semver 比较:<0 表示 a<b,=0 相等,>0 表示 a>b。 */
function verCmp(a: string, b: string): number {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** 已安装且市场版本比本地更高 → 显示「更新」按钮(覆盖安装即升级)。 */
function isUpdatable(row: any): boolean {
  return !!row.installed && !!row.installedVersion && verCmp(row.version, row.installedVersion) > 0;
}

/** 来源 host(如 raw.githubusercontent.com),用于区分同一插件的不同源头。 */
function sourceHost(url: string): string {
  try { return new URL(url).host; } catch { return url || "—"; }
}

/** 来源标识:github / gitee / 其他 host。 */
function sourceLabel(url: string): string {
  if (!url) return "";
  if (url.includes("gitee.com")) return "gitee";
  if (url.includes("github.com") || url.includes("githubusercontent.com")) return "github";
  return sourceHost(url);
}

/** 安装按钮的加载键:同 id 不同来源也要能独立显示 loading。 */
function installKey(row: any): string {
  return `${row.id}@${row.sourceUrl || "builtin"}`;
}

/** 删除外置插件(确认后调 DELETE /v1/plugins/:id)。 */
async function confirmDelete(row: any) {
  try {
    await ElMessageBox.confirm(
      t('admin.plugins.deleteConfirm', { name: displayName(row) }),
      t('admin.plugins.deleteTitle'),
      { type: "warning", confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await api.delete(`/rest/api/v1/plugins/${row.id}`);
    ElMessage.success(t('common.deleted'));
    loadPlugins();
    loadHealth();
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('common.deleteFailed'));
  }
}

function editPlugin(plugin: any) {
  editing.value = plugin;
  const cfg = parseConfig(plugin);
  const schema = parseManifest(plugin).configSchema || [];
  for (const key of Object.keys(editConfig)) delete editConfig[key];
  for (const f of schema) {
    let v = cfg[f.key];
    if (v === undefined) v = f.default;
    if (v === undefined) {
      if (f.type === "multiselect" || f.type === "select" || f.type === "playlist-multi") v = [];
      else if (f.type === "switch") v = false;
      else if (f.type === "number") v = 0;
      else v = "";
    }
    // 数组型默认值(如 candidate-list 的预填榜单)深拷贝,避免编辑行时污染 manifest 默认对象。
    if (Array.isArray(v)) v = JSON.parse(JSON.stringify(v));
    editConfig[f.key] = v;
  }
  // 有 playlist-multi 字段时懒加载歌单选项(本地 + 平台导入)
  if (schema.some((f: any) => f.type === "playlist-multi")) loadPlaylistOptions();
  testResult.value = null;
  showConfigDialog.value = true;
}

// candidate-list:新增一行空白榜单(默认网易云)
function addCandidate(key: string) {
  if (!Array.isArray(editConfig[key])) editConfig[key] = [];
  editConfig[key].push({ platform: "netease", url: "", name: "" });
}

// candidate-list:删除指定行(至少保留 1 个,由按钮 disabled 兜底)
function removeCandidate(key: string, idx: number) {
  const arr = editConfig[key];
  if (Array.isArray(arr) && arr.length > 1) arr.splice(idx, 1);
}

async function testSource() {
  if (!editing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/test`, {});
    testResult.value = { success: res.data.success, message: res.data.message || res.data.error || t('admin.plugins.unknownResult') };
  } catch (e: any) {
    testResult.value = { success: false, message: e?.response?.data?.error || e.message || t('admin.plugins.connectionFailed') };
  } finally {
    testing.value = false;
  }
}

async function saveConfig(opts?: { silent?: boolean }) {
  if (!editing.value) return;
  saving.value = true;
  try {
    const cfg: any = {};
    for (const f of configFields.value) {
      let v = editConfig[f.key];
      // candidate-list:清洗空行 + 至少保留 1 个有效榜单,与后端 cleanCandidates 对齐。
      if (f.type === "candidate-list") {
        const arr = Array.isArray(v) ? v : [];
        const cleaned = arr
          .filter((c: any) => c && c.url && String(c.url).trim() && c.platform)
          .map((c: any) => ({
            platform: c.platform,
            url: String(c.url).trim(),
            name: (c.name || "").trim() || undefined,
          }));
        if (cleaned.length === 0) {
          ElMessage.error(t('admin.plugins.candidateRequired'));
          saving.value = false;
          return;
        }
        v = cleaned;
      }
      cfg[f.key] = v;
    }
    await api.put(`/rest/api/v1/plugins/${editing.value.id}`, { config: cfg });
    if (!opts?.silent) {
      ElMessage.success(t('common.saveSuccess'));
      showConfigDialog.value = false;
      loadPlugins();
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('common.saveFailed'));
  } finally {
    saving.value = false;
  }
}

async function addPlugin() {
  if (!newPlugin.name) {
    ElMessage.warning(t('admin.plugins.nameRequired'));
    return;
  }
  await api.post("/rest/api/v1/plugins", newPlugin);
  showAddDialog.value = false;
  newPlugin.name = "";
  newPlugin.description = "";
  ElMessage.success(t('common.addSuccess'));
  loadPlugins();
}

async function purgeWebSongs() {
  if (!editing.value) return;
  purging.value = true;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/purge-web-songs`, {});
    if (res.data.success) {
      if (res.data.mode === "rotate") {
        ElMessage.success(t('admin.plugins.purgeDone', { songs: res.data.purged, covers: res.data.covers }));
      } else {
        ElMessage.info(t('admin.plugins.purgeSkipNoExpiry'));
      }
    } else {
      ElMessage.warning(res.data.error || t('admin.plugins.purgeFailed'));
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e.message || t('admin.plugins.purgeFailed'));
  } finally {
    purging.value = false;
  }
}

// ---- 歌词/封面按需获取设置 + 批量补全 ----
async function loadMediaSettings() {
  try {
    const l = await api.get("/rest/api/v1/lyrics/settings");
    if (l.data) Object.assign(lyricsSettings, l.data);
    const c = await api.get("/rest/api/v1/covers/settings");
    if (c.data) Object.assign(coversSettings, c.data);
  } catch { /* 后端旧版本无此端点时保持默认 */ }
}

async function saveMediaSettings(kind: "lyrics" | "covers"): Promise<boolean> {
  const s = kind === "lyrics" ? lyricsSettings : coversSettings;
  try {
    await api.put(`/rest/api/v1/${kind}/settings`, { providerId: s.providerId, onDemand: s.onDemand, persist: s.persist });
    return true;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('admin.plugins.mediaSaveFailed'));
    return false;
  }
}

/** 一次性保存「歌词获取」+「封面获取」两组全局设置(保留开关即时保存的同时,给显式确认入口)。 */
async function saveAllMedia() {
  savingMedia.value = true;
  const [a, b] = await Promise.all([saveMediaSettings("lyrics"), saveMediaSettings("covers")]);
  savingMedia.value = false;
  if (a && b) ElMessage.success(t('admin.plugins.mediaSaved'));
}

async function startBackfill(kind: "lyrics" | "covers") {
  const st = kind === "lyrics" ? lyricsBackfill : coversBackfill;
  if (st.running) return;
  try {
    const res = await api.post(`/rest/api/v1/${kind}/backfill`);
    if (res.data.running) {
      st.running = true;
      if (res.data.total !== undefined) st.total = res.data.total;
      ElMessage.success(t('admin.plugins.backfillStarted', { total: st.total, kind: kind === "lyrics" ? t('admin.plugins.kindLyrics') : t('admin.plugins.kindCovers') }));
      pollBackfill(kind);
    } else if (res.data.accepted === false && res.data.error) {
      ElMessage.error(res.data.error);
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('admin.plugins.backfillStartFailed'));
  }
}

function pollBackfill(kind: "lyrics" | "covers") {
  const st = kind === "lyrics" ? lyricsBackfill : coversBackfill;
  const timer = window.setInterval(async () => {
    try {
      const res = await api.get(`/rest/api/v1/${kind}/backfill/status`);
      if (res.data) Object.assign(st, res.data);
      if (!res.data?.running) {
        window.clearInterval(timer);
        st.running = false;
        ElMessage.success(t('admin.plugins.backfillDone', { ok: st.ok, fail: st.fail, skipped: st.skipped || 0 }));
      }
    } catch {
      window.clearInterval(timer);
      st.running = false;
    }
  }, 2000);
}

function backfillText(kind: "lyrics" | "covers"): string {
  const st = kind === "lyrics" ? lyricsBackfill : coversBackfill;
  let tOut = t('admin.plugins.backfillProgress', { done: st.done, total: st.total, ok: st.ok, fail: st.fail });
  if (st.skipped) tOut += t('admin.plugins.backfillSkipped', { skipped: st.skipped });
  tOut += st.running ? t('admin.plugins.backfillRunning') : t('admin.plugins.backfillFinished');
  return tOut;
}

// ---- marketplace ----
async function loadMarketplace() {
  marketLoading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins/registry");
    registries.value = res.data?.registries || [];
    marketPlugins.value = res.data?.plugins || [];
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('admin.plugins.marketLoadFailed'));
    registries.value = [];
    marketPlugins.value = [];
  } finally {
    marketLoading.value = false;
  }
}

async function addRegistry() {
  if (!/^https?:\/\//.test(newRegistryUrl.value)) {
    ElMessage.warning(t('admin.plugins.registryUrlInvalid'));
    return;
  }
  addingReg.value = true;
  try {
    await api.post("/rest/api/v1/plugins/registry", { url: newRegistryUrl.value });
    newRegistryUrl.value = "";
    showRegDialog.value = false;
    ElMessage.success(t('admin.plugins.added'));
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('admin.plugins.addFailed'));
  } finally {
    addingReg.value = false;
  }
}

async function removeRegistry(row: any) {
  try {
    await api.delete(`/rest/api/v1/plugins/registry/${row.id}`);
    ElMessage.success(t('common.deleted'));
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('common.deleteFailed'));
  }
}

async function installPlugin(row: any) {
  const key = installKey(row);
  installing.value = key;
  try {
    await api.post("/rest/api/v1/plugins/registry/install", { downloadUrl: row.downloadUrl || row.url });
    ElMessage.success(t('admin.plugins.installed', { name: row.name }));
    loadMarketplace();
    loadPlugins();
    loadHealth();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t('admin.plugins.installFailed'));
  } finally {
    installing.value = "";
  }
}

/** 切到「插件市场」标签页时自动刷新一次市场;切到「媒体获取」时刷新一次全局设置。 */
function onTabChange(name: string | number) {
  if (name === "market") loadMarketplace();
  else if (name === "media") loadMediaSettings();
}

onMounted(() => {
  loadPlugins();
  loadHealth();
  loadMediaSettings();
});
</script>

<style lang="scss" scoped>
.admin-plugins { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.page-sub { font-size: 13px; color: var(--el-text-color-secondary); }
.mf-card { margin-bottom: 20px; }
.mf-actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
.mf-card .card-title { font-size: 15px; font-weight: 600; color: var(--el-text-color-primary); }
.mf-empty { padding: 8px 0; }
.test-result { margin-left: 12px; font-size: 13px; color: var(--el-color-danger); &.ok { color: var(--el-color-success); } }
.plugin-name { font-weight: 600; line-height: 1.35; }
.plugin-id { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.35; }
.cap-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.cap-label { font-size: 12px; color: var(--el-text-color-secondary); margin-right: 2px; }
.field-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; display: inline-block; max-width: 360px; }
.tag-input-wrap { width: 100%; }
.tag-input-wrap .tag-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.tag-input-wrap .tag-actions { margin-top: 10px; }
.tag-input-wrap .tag-actions .test-result { margin-left: 12px; }
.field-links { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 0 0 12px; }
.field-link { font-size: 12px; color: var(--el-color-primary); text-decoration: none; display: inline-flex; align-items: center; gap: 3px; line-height: 1.6; }
.field-link:hover { text-decoration: underline; }
.field-link-icon { font-size: 11px; transform: translateY(0.5px); }
.candidate-list { display: flex; flex-direction: column; gap: 8px; max-width: 640px; }
.candidate-row { display: flex; align-items: center; gap: 8px; }
.candidate-row .el-input { margin: 0; }
.mf-media { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.mf-media-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mf-media-label { flex: 0 0 64px; font-size: 13px; color: var(--el-text-color-primary); }
.mf-media .field-hint { margin-left: 0; max-width: 340px; }
.market-card { margin-bottom: 20px; }
.market-card .card-head { display: flex; justify-content: space-between; align-items: center; }
.market-warn { margin-top: 4px; }
.market-note { margin: 12px 4px 0; font-size: 12px; color: var(--el-text-color-secondary); }
.market-group { margin-bottom: 18px; }
.market-group .group-head { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; }
.market-group .group-title { font-size: 13px; font-weight: 600; color: var(--el-text-color-primary); word-break: break-all; }
.src-host { font-size: 13px; font-weight: 600; line-height: 1.4; }
.src-url { font-size: 11px; color: var(--el-text-color-secondary); line-height: 1.4; word-break: break-all; }
.src-builtin { font-size: 13px; color: var(--el-text-color-secondary); }
.pd-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.pd-id { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--el-text-color-secondary); }
.pd-section { margin-bottom: 18px; border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 14px 16px; background: var(--el-fill-color-blank); }
.pd-section h4 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--el-text-color-primary); }
.pd-desc { margin: 0; font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular); }
.pd-md { font-size: 13px; line-height: 1.75; color: var(--el-text-color-regular); }
.pd-md h2 { font-size: 15px; margin: 14px 0 6px; }
.pd-md h3 { font-size: 14px; margin: 12px 0 6px; }
.pd-md p { margin: 6px 0; }
.pd-md ul { margin: 6px 0; padding-left: 20px; }
.pd-md li { margin: 3px 0; }
.pd-md strong { font-weight: 600; }
.pd-md code { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--el-fill-color-light); padding: 1px 5px; border-radius: 4px; }
.pd-md pre.md-code { background: var(--el-fill-color-light); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.pd-capdocs { margin: 0; padding-left: 20px; }
.pd-capdocs li { font-size: 13px; line-height: 1.8; color: var(--el-text-color-regular); }
.pd-hint { margin: 8px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
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
  .admin-plugins { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
  /* 候选榜单行在窄屏换行,每个输入占满一行 */
  .candidate-row { flex-wrap: wrap; }
  .candidate-row .el-input,
  .candidate-row .el-select { flex: 1 1 100% !important; width: 100% !important; }
  .candidate-row .el-button { flex: 0 0 auto; }
  /* 媒体获取行的固定宽控件在窄屏占满 */
  .mf-media-row .el-select { width: 100% !important; }
}
</style>

<style lang="scss">
/* 非 scoped:el-dialog 经 teleport 渲染到 body,scoped 的 class 选择器带 [data-v] 匹配不到其根节点,
   因此插件配置/详情弹窗的手机端高地适配必须放在全局作用域(用 .plugin-config-dialog 限定唯一)。
   schedules 分组加入后弹窗内容变长,在 390/360 视口超出可视高度,中心点越界会被层级守卫误判为遮挡;
   限制 max-height 让内容区内部滚动、footer 常驻可见,弹窗始终完整落在视口内。 */
@media (max-width: 768px) {
  .plugin-config-dialog {
    max-height: calc(100vh - 12vh);
    display: flex;
    flex-direction: column;
  }
  .plugin-config-dialog .el-dialog__header,
  .plugin-config-dialog .el-dialog__footer { flex-shrink: 0; }
  .plugin-config-dialog .el-dialog__body { flex: 1 1 auto; overflow-y: auto; }
}
</style>
