<template>
  <div class="admin-fetch">
    <div class="page-header">
      <h2>{{ t('admin.fetch.title') }}</h2>
      <el-button :loading="jobsLoading" @click="refreshJobs"><MfIcon name="RefreshCw" />{{ t('admin.fetch.jobs.refresh') }}</el-button>
    </div>

    <el-tabs v-model="activeTab" class="fetch-tabs">
      <!-- ===== 1. 配置 ===== -->
      <el-tab-pane :label="t('admin.fetch.tabConfig')" name="config">
        <div v-loading="configLoading" class="config-wrap">
          <el-form label-position="top" class="config-form">
            <el-divider content-position="left">{{ t('admin.fetch.config.basic') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.enabled')">
                <div class="field-inline">
                  <el-switch v-model="config.enabled" />
                  <span class="hint">{{ t('admin.fetch.config.enabledHint') }}</span>
                </div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.downloadRoot')">
                <el-input v-model="config.downloadRoot" />
                <div class="hint">{{ t('admin.fetch.config.downloadRootHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.cacheRoot')">
                <el-input v-model="config.cacheRoot" />
                <div class="hint">{{ t('admin.fetch.config.cacheRootHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.quality') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.qualityFloor')">
                <el-select v-model="config.qualityFloor">
                  <el-option v-for="o in floorOptions" :key="o" :label="floorLabel(o)" :value="o" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.minBitrateKbps')">
                <el-input-number v-model="config.minBitrateKbps" :min="0" :step="10" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.minBitrateKbpsHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.durationToleranceSec')">
                <el-input-number v-model="config.durationToleranceSec" :min="0" :max="60" :step="1" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.durationToleranceSecHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.minSampleRateHz')">
                <el-input-number v-model="config.minSampleRateHz" :min="0" :step="1000" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.preferLossless')">
                <el-switch v-model="config.preferLossless" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.rejectFakeLossless')">
                <el-switch v-model="config.rejectFakeLossless" />
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.semantics') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.skipIfInLibrary')">
                <el-switch v-model="config.skipIfInLibrary" />
                <div class="hint">{{ t('admin.fetch.config.skipIfInLibraryHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.strictBestTier')">
                <el-switch v-model="config.strictBestTier" />
                <div class="hint">{{ t('admin.fetch.config.strictBestTierHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.downloadCooldownDays')">
                <el-input-number v-model="config.downloadCooldownDays" :min="0" :max="365" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.downloadCooldownDaysHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.ssrfTrustedHosts')">
                <el-input v-model="ssrfHostsText" :placeholder="t('admin.fetch.config.ssrfTrustedHostsPlaceholder')" />
                <div class="hint">{{ t('admin.fetch.config.ssrfTrustedHostsHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.jobRetentionDays')">
                <el-input-number v-model="config.jobRetentionDays" :min="0" :max="3650" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.jobRetentionDaysHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.libraryAutoContinue')">
                <el-switch v-model="config.libraryAutoContinue" />
                <div class="hint">{{ t('admin.fetch.config.libraryAutoContinueHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.libraryCooldownDays')">
                <el-input-number v-model="config.libraryCooldownDays" :min="1" :max="365" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.libraryCooldownDaysHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.libraryAutoEnabled')">
                <el-switch v-model="config.libraryAutoEnabled" />
                <div class="hint">{{ t('admin.fetch.config.libraryAutoEnabledHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.libraryAutoIntervalDays')">
                <el-input-number v-model="config.libraryAutoIntervalDays" :min="1" :max="365" controls-position="right" :disabled="!config.libraryAutoEnabled" />
                <div class="hint">{{ t('admin.fetch.config.libraryAutoIntervalDaysHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.libraryAutoTimeOfDay')">
                <el-input v-model="config.libraryAutoTimeOfDay" placeholder="03:00" class="time-input" :disabled="!config.libraryAutoEnabled" />
                <div class="hint">{{ t('admin.fetch.config.libraryAutoTimeOfDayHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.transcode') }}</el-divider>
            <el-alert class="transcode-warn" type="warning" :closable="false" show-icon>
              {{ t('admin.fetch.config.transcodeWarn') }}
            </el-alert>
            <div class="hint loudness-hint">{{ t('admin.fetch.config.transcodeLoudnessHint') }}</div>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.transcodeEnabled')">
                <el-switch v-model="config.transcodeEnabled" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeTarget')">
                <el-select v-model="config.transcodeTarget">
                  <el-option label="FLAC" value="flac" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeSampleRateHz')">
                <el-select v-model="config.transcodeSampleRateHz">
                  <el-option :label="t('admin.fetch.config.transcodeFollow')" value="follow" />
                  <el-option label="44100 Hz" :value="44100" />
                  <el-option label="48000 Hz" :value="48000" />
                </el-select>
                <div class="hint">{{ t('admin.fetch.config.transcodeSampleRateFollowHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeBitDepth')">
                <el-select v-model="config.transcodeBitDepth">
                  <el-option :label="t('admin.fetch.config.transcodeFollow')" value="follow" />
                  <el-option label="16 bit" :value="16" />
                  <el-option label="24 bit" :value="24" />
                </el-select>
                <div v-if="config.transcodeBitDepth === 'follow'" class="hint">{{ t('admin.fetch.config.transcodeBitDepthFollowHint') }}</div>
                <div v-if="config.transcodeBitDepth === 24" class="hint">{{ t('admin.fetch.config.transcodeBitDepth24Hint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.transcodeKeepOriginal')">
                <el-switch v-model="config.transcodeKeepOriginal" />
                <div class="hint">{{ t('admin.fetch.config.transcodeKeepOriginalHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.concurrency') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.maxConcurrentJobs')">
                <el-input-number v-model="config.maxConcurrentJobs" :min="1" :max="16" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.maxConcurrentJobsHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.maxConcurrentDownloads')">
                <el-input-number v-model="config.maxConcurrentDownloads" :min="1" :max="32" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.maxConcurrentPerHost')">
                <el-input-number v-model="config.maxConcurrentPerHost" :min="1" :max="16" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.perHostMinIntervalMs')">
                <el-input-number v-model="config.perHostMinIntervalMs" :min="0" :step="100" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.rateLimitKBps')">
                <el-input-number v-model="config.rateLimitKBps" :min="0" :step="128" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.rateLimitHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.conflict') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.config.fileConflictPolicy')">
                <el-select v-model="config.fileConflictPolicy">
                  <el-option v-for="o in conflictOptions" :key="o" :label="conflictLabel(o)" :value="o" />
                </el-select>
                <div class="hint">{{ t('admin.fetch.config.fileConflictPolicyHint') }}</div>
              </el-form-item>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.config.sources') }}</el-divider>
            <el-form-item :label="t('admin.fetch.config.sourcePriority')">
              <div class="hint">{{ t('admin.fetch.config.sourcePriorityHint') }}</div>
              <div class="priority-list">
                <div v-for="(s, i) in config.sourcePriority" :key="s + '#' + i" class="priority-row">
                  <span class="priority-idx">{{ i + 1 }}</span>
                  <el-input v-model="config.sourcePriority[i]" size="small" class="priority-input" />
                  <el-button size="small" :disabled="i === 0" :title="t('common.moveUp')" @click="movePriority(i, -1)">&#8593;</el-button>
                  <el-button size="small" :disabled="i === config.sourcePriority.length - 1" :title="t('common.moveDown')" @click="movePriority(i, 1)">&#8595;</el-button>
                  <el-button size="small" type="danger" plain :title="t('admin.fetch.config.sourceRemove')" @click="removePriority(i)"><MfIcon name="X" /></el-button>
                </div>
                <div v-if="!config.sourcePriority.length" class="hint">{{ t('admin.fetch.config.sourcePriorityEmpty') }}</div>
                <div class="priority-add">
                  <el-input v-model="priorityInput" size="small" :placeholder="t('admin.fetch.config.sourcePriorityPlaceholder')" @keyup.enter="addPriority" />
                  <el-button size="small" @click="addPriority"><MfIcon name="Plus" />{{ t('admin.fetch.config.sourceAdd') }}</el-button>
                </div>
                <div class="avail-sources">
                  <span class="hint">{{ t('admin.fetch.config.sourceAvailable') }}:</span>
                  <template v-if="availableSources.length">
                    <el-tag
                      v-for="src in availableSources"
                      :key="src.pluginId"
                      class="src-tag"
                      size="small"
                      @click="addSourceTag(src)"
                    >{{ src.platform || src.pluginId }}</el-tag>
                  </template>
                  <span v-else class="hint">{{ t('admin.fetch.config.sourceAvailableEmpty') }}</span>
                </div>
              </div>
            </el-form-item>
          </el-form>

          <div class="config-actions">
            <el-button type="primary" :loading="configSaving" @click="saveConfig">{{ t('admin.fetch.config.save') }}</el-button>
          </div>
        </div>
      </el-tab-pane>

      <!-- ===== 2. 新建任务 + 预览 ===== -->
      <el-tab-pane :label="t('admin.fetch.tabCreate')" name="create">
        <el-form label-position="top" class="create-form">
          <el-form-item :label="t('admin.fetch.create.inputLabel')">
            <div class="hint">{{ t('admin.fetch.create.inputHint') }}</div>
            <el-input v-model="targetsText" type="textarea" :rows="8" :placeholder="t('admin.fetch.create.placeholder')" />
          </el-form-item>
          <div class="create-actions">
            <span class="hint">{{ t('admin.fetch.create.parsedCount', { count: parsedCount }) }}</span>
            <span class="hint">{{ t('admin.fetch.create.dryRunHint') }}</span>
            <el-button :loading="previewLoading" @click="doPreview"><MfIcon name="Search" />{{ t('admin.fetch.create.preview') }}</el-button>
            <el-button type="primary" :loading="startLoading" @click="doStart"><MfIcon name="Download" />{{ t('admin.fetch.create.start') }}</el-button>
          </div>
        </el-form>

        <div class="library-block">
          <el-divider content-position="left">{{ t('admin.fetch.library.title') }}</el-divider>
          <div class="library-stats">
            <el-tag type="warning">{{ t('admin.fetch.library.pending', { count: libraryPlan?.pending ?? 0 }) }}</el-tag>
            <el-tag type="info">{{ t('admin.fetch.library.attempted', { count: libraryPlan?.attempted ?? 0 }) }}</el-tag>
            <span v-if="libraryPlan" class="hint">{{ t('admin.fetch.library.total', { count: libraryPlan.total }) }}</span>
          </div>
          <div class="library-actions">
            <span class="hint">{{ t('admin.fetch.library.batchSize') }}</span>
            <el-input-number v-model="libraryBatchSize" :min="1" :max="500" controls-position="right" />
            <el-button type="primary" :loading="libraryStarting" @click="doStartLibrary"><MfIcon name="Download" />{{ t('admin.fetch.library.start') }}</el-button>
            <el-button :loading="libraryResetting" @click="doResetLibrary">{{ t('admin.fetch.library.reset') }}</el-button>
            <el-button :loading="libraryPlanLoading" @click="loadLibraryPlan"><MfIcon name="RefreshCw" />{{ t('admin.fetch.library.reload') }}</el-button>
          </div>
          <div class="hint library-hint">{{ t('admin.fetch.library.hint') }}</div>
        </div>

        <div v-if="previewSummary" class="preview-block">
          <el-divider content-position="left">{{ t('admin.fetch.create.previewResult') }}</el-divider>
          <div class="summary-bar">
            <el-tag type="success">{{ t('admin.fetch.create.summaryDownloadable', { count: previewSummary.downloadable }) }}</el-tag>
            <el-tag type="warning">{{ t('admin.fetch.create.summaryBelowBar', { count: previewSummary.belowBar }) }}</el-tag>
            <el-tag type="info">{{ t('admin.fetch.create.summaryNoCandidate', { count: previewSummary.noCandidate }) }}</el-tag>
            <el-tag>{{ t('admin.fetch.create.summaryTotal', { count: previewSummary.total }) }}</el-tag>
          </div>
          <el-table :data="previewItems" stripe>
            <el-table-column prop="title" :label="t('admin.fetch.create.colTitle')" min-width="180" />
            <el-table-column prop="artist" :label="t('admin.fetch.create.colArtist')" width="140" />
            <el-table-column :label="t('admin.fetch.create.colStatus')" width="110">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.create.colTier')" width="120">
              <template #default="{ row }">{{ row.tier || '-' }}</template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.create.colReason')" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reason ? errorText(row.reason) : '' }}</template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ===== 3. 任务列表 + 详情 ===== -->
      <el-tab-pane :label="t('admin.fetch.tabJobs')" name="jobs">
        <div class="jobs-toolbar">
          <div class="jobs-filters">
            <span class="hint">{{ t('admin.fetch.jobs.autoRefreshHint') }}</span>
            <el-select v-model="statusFilter" size="small" class="filter-select" @change="refreshJobs">
              <el-option :label="t('admin.fetch.jobs.filterAll')" value="" />
              <el-option v-for="s in jobStatusOptions" :key="s" :label="statusText(s)" :value="s" />
            </el-select>
            <el-select v-model="limit" size="small" class="limit-select" @change="refreshJobs">
              <el-option label="20" :value="20" />
              <el-option label="50" :value="50" />
              <el-option label="100" :value="100" />
            </el-select>
          </div>
          <el-button size="small" :loading="jobsLoading" @click="refreshJobs"><MfIcon name="RefreshCw" />{{ t('admin.fetch.jobs.refresh') }}</el-button>
          <el-button size="small" type="danger" plain @click="doClearJobs">{{ t('admin.fetch.jobs.clearAll') }}</el-button>
        </div>

        <el-alert v-if="jobsError" type="error" :closable="false" :title="jobsError" class="jobs-error" />

        <el-table v-if="jobs.length" :data="jobs" stripe v-loading="jobsLoading" @row-dblclick="openDetail">
          <el-table-column :label="t('admin.fetch.jobs.colId')" width="120">
            <template #default="{ row }"><span class="mono">{{ shortId(row.id) }}</span></template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colStatus')" width="110">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colTotal')" width="80" align="center">
            <template #default="{ row }">{{ row.counts?.total ?? 0 }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colDone')" width="80" align="center">
            <template #default="{ row }">{{ row.counts?.done ?? 0 }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colFailed')" width="80" align="center">
            <template #default="{ row }"><span :class="{ 'cell-fail': (row.counts?.failed ?? 0) > 0 }">{{ row.counts?.failed ?? 0 }}</span></template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colSkipped')" width="80" align="center">
            <template #default="{ row }">{{ row.counts?.skipped ?? 0 }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colBytes')" width="110">
            <template #default="{ row }">{{ formatBytes(row.counts?.bytes) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colCreatedAt')" width="150">
            <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.colActions')" width="160" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openDetail(row)">{{ t('admin.fetch.jobs.view') }}</el-button>
              <el-button v-if="isActiveStatus(row.status)" size="small" type="danger" plain @click="doCancel(row)">{{ t('admin.fetch.jobs.cancel') }}</el-button>
              <el-button v-if="!isActiveStatus(row.status)" size="small" type="danger" plain @click="doDeleteJob(row)">{{ t('admin.fetch.jobs.delete') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
        <EmptyState
          v-else-if="!jobsLoading"
          icon="box"
          :title="t('admin.fetch.jobs.emptyTitle')"
          :description="t('admin.fetch.jobs.emptyDesc')"
          compact
        />
      </el-tab-pane>

      <!-- ===== 4. 洗版(无损替换低码率) ===== -->
      <el-tab-pane :label="t('admin.fetch.tabUpgrade')" name="upgrade">
        <div v-loading="upgradeConfigLoading" class="upgrade-wrap">
          <el-form label-position="top" class="upgrade-form">
            <el-divider content-position="left">{{ t('admin.fetch.upgrade.settings') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.upgrade.batchLimit')">
                <el-input-number v-model="upgradeConfig.batchLimit" :min="1" :max="500" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.originalAction')">
                <el-select v-model="upgradeConfig.originalAction">
                  <el-option :label="t('admin.fetch.upgrade.actionKeep')" value="keep" />
                  <el-option :label="t('admin.fetch.upgrade.actionMove')" value="move" />
                  <el-option :label="t('admin.fetch.upgrade.actionDelete')" value="delete" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.losslessRoot')">
                <el-input v-model="upgradeConfig.losslessRoot" :placeholder="t('admin.fetch.upgrade.losslessRootPlaceholder')" />
                <div class="hint">{{ t('admin.fetch.upgrade.losslessRootHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.compressedMinKbps')">
                <el-input-number v-model="upgradeConfig.compressedMinKbps" :min="0" :step="50" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.uncompressedMinKbps')">
                <el-input-number v-model="upgradeConfig.uncompressedMinKbps" :min="0" :step="100" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.inspectCandidates')">
                <el-switch v-model="upgradeConfig.inspectCandidates" />
                <div class="hint">{{ t('admin.fetch.upgrade.inspectCandidatesHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.upgradeCooldownDays')">
                <el-input-number v-model="upgradeConfig.upgradeCooldownDays" :min="1" :max="365" :step="1" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.upgrade.upgradeCooldownDaysHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.upgradeAutoEnabled')">
                <el-switch v-model="upgradeConfig.upgradeAutoEnabled" />
                <div class="hint">{{ t('admin.fetch.upgrade.upgradeAutoEnabledHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.upgradeAutoIntervalDays')">
                <el-input-number v-model="upgradeConfig.upgradeAutoIntervalDays" :min="1" :max="365" :step="1" controls-position="right" :disabled="!upgradeConfig.upgradeAutoEnabled" />
                <div class="hint">{{ t('admin.fetch.upgrade.upgradeAutoIntervalDaysHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.upgradeAutoTimeOfDay')">
                <el-input v-model="upgradeConfig.upgradeAutoTimeOfDay" placeholder="03:00" class="time-input" :disabled="!upgradeConfig.upgradeAutoEnabled" />
                <div class="hint">{{ t('admin.fetch.upgrade.upgradeAutoTimeOfDayHint') }}</div>
              </el-form-item>
            </div>
            <el-alert
              v-if="upgradeConfig.originalAction === 'delete'"
              type="error"
              :closable="false"
              show-icon
              class="upgrade-warn"
            >{{ t('admin.fetch.upgrade.deleteWarn') }}</el-alert>
            <div class="config-actions">
              <el-button :loading="upgradeSaving" @click="saveUpgradeConfig">{{ t('admin.fetch.upgrade.save') }}</el-button>
            </div>
          </el-form>

          <el-divider content-position="left">{{ t('admin.fetch.upgrade.preview') }}</el-divider>
          <div class="upgrade-toolbar">
            <div class="upgrade-summary">
              <el-tag>{{ t('admin.fetch.upgrade.summaryTotal', { count: upgradePlan?.total ?? 0 }) }}</el-tag>
              <el-tag type="warning">{{ t('admin.fetch.upgrade.summaryBelowBar', { count: upgradePlan?.belowBar ?? 0 }) }}</el-tag>
              <el-tag v-if="(upgradePlan?.cooled ?? 0) > 0" type="info">{{ t('admin.fetch.upgrade.summaryCooled', { count: upgradePlan?.cooled ?? 0 }) }}</el-tag>
              <el-tag v-if="upgradePlan?.truncated" type="info">{{ t('admin.fetch.upgrade.summaryTruncated') }}</el-tag>
              <span v-if="upgradePlan && upgradePlan.sourceNames && upgradePlan.sourceNames.length" class="hint">
                {{ t('admin.fetch.upgrade.sources') }}: {{ upgradePlan.sourceNames.join(', ') }}
              </span>
            </div>
            <el-button :loading="planLoading" @click="loadUpgradePlan"><MfIcon name="Search" />{{ t('admin.fetch.upgrade.loadPlan') }}</el-button>
            <el-button :loading="upgradeAttemptsResetting" @click="doResetUpgradeAttempts">{{ t('admin.fetch.upgrade.resetAttempts') }}</el-button>
          </div>

          <el-alert v-if="planError" type="error" :closable="false" :title="planError" class="jobs-error" />

          <el-table
            v-if="planItems.length"
            ref="planTableRef"
            :data="planItems"
            row-key="songId"
            stripe
            v-loading="planLoading"
            @selection-change="onPlanSelectionChange"
          >
            <el-table-column type="selection" width="48" />
            <el-table-column :label="t('admin.fetch.upgrade.colTitle')" min-width="180">
              <template #default="{ row }">
                <div class="song-cell">
                  <span class="song-title">{{ row.title }}</span>
                  <span v-if="row.artist" class="song-artist">{{ row.artist }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.upgrade.colAlbum')" width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ row.album || '-' }}</template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.upgrade.colSuffix')" width="90">
              <template #default="{ row }">{{ row.suffix || '-' }}</template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.upgrade.colBitrate')" width="130" align="right">
              <template #default="{ row }">{{ formatKbps(row.bitrateKbps) }}</template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.upgrade.colDuration')" width="100" align="right">
              <template #default="{ row }">{{ formatDuration(row.durationSec) }}</template>
            </el-table-column>
            <el-table-column :label="t('admin.fetch.upgrade.colReason')" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reason ? errorText(row.reason) : '' }}</template>
            </el-table-column>
          </el-table>
          <EmptyState
            v-else-if="planLoaded && !planLoading"
            icon="box"
            :title="t('admin.fetch.upgrade.emptyTitle')"
            :description="t('admin.fetch.upgrade.emptyDesc')"
            compact
          />
          <div v-else-if="!planLoading" class="hint upgrade-hint">{{ t('admin.fetch.upgrade.notLoaded') }}</div>

          <div class="upgrade-actions">
            <span class="hint">{{ t('admin.fetch.upgrade.selectedCount', { count: selectedSongIds.length }) }}</span>
            <el-button :disabled="!planItems.length" @click="selectAllPlan">{{ t('admin.fetch.upgrade.selectAll') }}</el-button>
            <el-button :disabled="!selectedSongIds.length" @click="clearPlanSelection">{{ t('admin.fetch.upgrade.clearSelect') }}</el-button>
            <el-button type="danger" :loading="upgradeStarting" @click="doStartUpgrade"><MfIcon name="Download" />{{ t('admin.fetch.upgrade.start') }}</el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- ===== 任务详情 ===== -->
    <el-dialog v-model="detailVisible" :title="t('admin.fetch.jobs.detailTitle')" width="min(1160px, 96vw)" :append-to-body="true">
      <div v-if="detail" v-loading="detailLoading" class="detail-body">
        <div class="detail-head">
          <div class="detail-meta">
            <span class="mono">{{ detail.id }}</span>
            <el-tag :type="statusTagType(detail.status)" size="small">{{ statusText(detail.status) }}</el-tag>
          </div>
          <div class="detail-counts">
            <span>{{ t('admin.fetch.jobs.colTotal') }}: {{ detail.counts?.total ?? 0 }}</span>
            <span>{{ t('admin.fetch.jobs.colDone') }}: {{ detail.counts?.done ?? 0 }}</span>
            <span v-if="(detail.counts?.failed ?? 0) > 0" class="cell-fail">{{ t('admin.fetch.jobs.colFailed') }}: {{ detail.counts.failed }}</span>
            <span>{{ t('admin.fetch.jobs.colSkipped') }}: {{ detail.counts?.skipped ?? 0 }}</span>
            <span>{{ t('admin.fetch.jobs.colBytes') }}: {{ formatBytes(detail.counts?.bytes) }}</span>
            <span>{{ t('admin.fetch.jobs.duration') }}: {{ jobDuration(detail) }}</span>
          </div>
        </div>
        <el-alert
          v-if="detail.error"
          type="error"
          :closable="false"
          :title="t('admin.fetch.jobs.jobError', { error: detail.error })"
        />
        <div class="detail-actions">
          <el-button size="small" type="warning" :disabled="!(detail.counts?.failed ?? 0)" @click="doRetryAll">
            <MfIcon name="RotateCcw" />{{ t('admin.fetch.jobs.retryAll') }}
          </el-button>
          <el-button v-if="isActiveStatus(detail.status)" size="small" type="danger" plain @click="doCancel(detail)">{{ t('admin.fetch.jobs.cancel') }}</el-button>
        </div>
        <el-table v-if="detail.items && detail.items.length" :data="detail.items" stripe size="small" class="detail-table">
          <el-table-column :label="t('admin.fetch.jobs.detailColSong')" min-width="170">
            <template #default="{ row }">
              <div class="song-cell">
                <span class="song-title">{{ row.title }}</span>
                <span v-if="row.artist" class="song-artist">{{ row.artist }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColStatus')" width="110">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColSource')" width="120">
            <template #default="{ row }">{{ sourceText(row.chosen) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColQuality')" width="150">
            <template #default="{ row }">{{ qualityText(row.chosen) }}</template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColError')" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.errorCode" class="cell-fail">{{ errorText(row.errorCode) }}</span>
              <span v-else-if="row.errorMsg">{{ row.errorMsg }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColPath')" min-width="180" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono">{{ row.finalPath || '-' }}</span></template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColReplaced')" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.replaced">
                {{ t('admin.fetch.jobs.replaced') }}
                <span class="mono">{{ replacedText(row.replaced) }}</span>
              </span>
            </template>
          </el-table-column>
          <el-table-column :label="t('admin.fetch.jobs.detailColActions')" width="90">
            <template #default="{ row }">
              <el-button size="small" :disabled="!canRetryItem(row.status)" @click="retryItem(row)">{{ t('admin.fetch.jobs.retry') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="hint empty-items">{{ t('admin.fetch.jobs.noItems') }}</div>
      </div>
      <div v-else v-loading="detailLoading" class="detail-empty"></div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import { apiErrorText } from "@/utils/apiError";
import {
  getFetchConfig,
  updateFetchConfig,
  getFetchSources,
  previewFetch,
  createFetchTask,
  listFetchJobs,
  getFetchJob,
  cancelFetchJob,
  clearFetchJobs,
  deleteFetchJob,
  retryFetchJob,
  getUpgradePlan,
  getUpgradeConfig,
  updateUpgradeConfig,
  startUpgradeTask,
  getLibraryPlan,
  startLibraryTask,
  resetLibraryAttempts,
  resetUpgradeAttempts,
} from "@/api/fetch";
import type {
  FetchConfig,
  FetchChosen,
  FetchSourceInfo,
  FetchPreviewItem,
  FetchPreviewSummary,
  FetchJobSummary,
  FetchJobDetail,
  FetchTargetInput,
  UpgradePlan,
  UpgradePlanItem,
  UpgradeConfig,
  LibraryPlan,
} from "@/api/fetch";

const { t } = useI18n();

const activeTab = ref("config");

// ---------- 配置 ----------
// 转码采样率/位深为「可选」字段:UI 用 "follow" 表示「跟随源」,提交时省略该键。
type TranscodeFollow = "follow";
type ConfigForm = Omit<Required<FetchConfig>, "transcodeSampleRateHz" | "transcodeBitDepth"> & {
  transcodeSampleRateHz: number | TranscodeFollow;
  transcodeBitDepth: 16 | 24 | TranscodeFollow;
};

function defaultConfig(): ConfigForm {
  return {
    enabled: true,
    downloadRoot: "/MUSIC/DOWNLOAD",
    cacheRoot: "/MUSIC/DOWNLOADCACHE",
    qualityFloor: "any",
    minBitrateKbps: 90,
    durationToleranceSec: 10,
    minSampleRateHz: 44100,
    preferLossless: true,
    rejectFakeLossless: true,
    skipIfInLibrary: true,
    strictBestTier: true,
    downloadCooldownDays: 7,
    transcodeEnabled: true,
    transcodeTarget: "flac",
    transcodeSampleRateHz: "follow",
    transcodeBitDepth: "follow",
    transcodeKeepOriginal: false,
    maxConcurrentDownloads: 2,
    maxConcurrentJobs: 2,
    maxConcurrentPerHost: 1,
    perHostMinIntervalMs: 500,
    rateLimitKBps: 0,
    fileConflictPolicy: "keepBetter",
    sourcePriority: [],
    ssrfTrustedHosts: [],
    jobRetentionDays: 30,
    libraryAutoContinue: true,
    libraryCooldownDays: 30,
    libraryAutoEnabled: false,
    libraryAutoIntervalDays: 1,
    libraryAutoTimeOfDay: "03:00",
  };
}

const config = reactive<ConfigForm>(defaultConfig());
const configLoading = ref(false);
const configSaving = ref(false);
const priorityInput = ref("");
// 可信内网主机（逗号分隔文本 ↔ 字符串数组）
const ssrfHostsText = computed({
  get: () => config.ssrfTrustedHosts.join(", "),
  set: (v: string) => {
    config.ssrfTrustedHosts = v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  },
});
const availableSources = ref<FetchSourceInfo[]>([]);

const floorOptions = ["lossless", "hires", "320", "256", "192", "128", "any"];
const conflictOptions = ["skip", "overwrite", "rename", "keepBetter"];

function floorLabel(v: string): string {
  if (v === "lossless" || v === "hires" || v === "any") return t(`admin.fetch.floor.${v}`);
  return `${v} kbps`;
}
function conflictLabel(v: string): string {
  return t(`admin.fetch.conflictOption.${v}`);
}

async function loadConfig() {
  configLoading.value = true;
  try {
    const remote = await getFetchConfig();
    const merged = defaultConfig();
    Object.assign(merged, remote);
    // 远端缺省/空值/显式 "auto" → UI 的「跟随源」语义(提交时省略该键)
    if (remote.transcodeSampleRateHz == null) merged.transcodeSampleRateHz = "follow";
    if (remote.transcodeBitDepth == null || (remote.transcodeBitDepth as unknown) === "auto") merged.transcodeBitDepth = "follow";
    if (!Array.isArray(merged.sourcePriority)) merged.sourcePriority = [];
    if (!Array.isArray(merged.ssrfTrustedHosts)) merged.ssrfTrustedHosts = [];
    if (merged.jobRetentionDays == null) merged.jobRetentionDays = 30;
    if (merged.maxConcurrentJobs == null) merged.maxConcurrentJobs = 2;
    if (merged.libraryAutoContinue == null) merged.libraryAutoContinue = true;
    if (merged.downloadCooldownDays == null) merged.downloadCooldownDays = 7;
    if (merged.libraryCooldownDays == null) merged.libraryCooldownDays = 30;
    if (merged.libraryAutoEnabled == null) merged.libraryAutoEnabled = false;
    if (merged.libraryAutoIntervalDays == null) merged.libraryAutoIntervalDays = 1;
    if (!merged.libraryAutoTimeOfDay) merged.libraryAutoTimeOfDay = "03:00";
    Object.assign(config, merged);
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.config.saveFailed")));
  } finally {
    configLoading.value = false;
  }
}

async function loadSources() {
  try {
    availableSources.value = await getFetchSources();
  } catch {
    availableSources.value = [];
  }
}

async function saveConfig() {
  configSaving.value = true;
  try {
    const payload: any = { ...config };
    // 「跟随源」= 省略该键(不传 null / 空串)
    if (payload.transcodeSampleRateHz === "follow") delete payload.transcodeSampleRateHz;
    if (payload.transcodeBitDepth === "follow") delete payload.transcodeBitDepth;
    await updateFetchConfig(payload);
    ElMessage.success(t("admin.fetch.config.saved"));
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.config.saveFailed")));
  } finally {
    configSaving.value = false;
  }
}

function addPriority() {
  const v = priorityInput.value.trim();
  if (!v) return;
  if (!config.sourcePriority.includes(v)) config.sourcePriority.push(v);
  priorityInput.value = "";
}
function addSourceTag(src: FetchSourceInfo) {
  const id = src.pluginId || src.platform;
  if (id && !config.sourcePriority.includes(id)) config.sourcePriority.push(id);
}
function removePriority(i: number) {
  config.sourcePriority.splice(i, 1);
}
function movePriority(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= config.sourcePriority.length) return;
  const list = config.sourcePriority;
  [list[i], list[j]] = [list[j], list[i]];
}

// ---------- 新建任务 ----------
const targetsText = ref("");
const previewLoading = ref(false);
const startLoading = ref(false);
const previewSummary = ref<FetchPreviewSummary | null>(null);
const previewItems = ref<FetchPreviewItem[]>([]);

function parseTargets(text: string): FetchTargetInput[] {
  const out: FetchTargetInput[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.lastIndexOf(" - ");
    if (idx > 0) {
      const title = line.slice(0, idx).trim();
      const artist = line.slice(idx + 3).trim();
      if (title) out.push(artist ? { title, artist } : { title });
    } else {
      out.push({ title: line });
    }
  }
  return out;
}

const parsedCount = computed(() => parseTargets(targetsText.value).length);

async function doPreview() {
  const targets = parseTargets(targetsText.value);
  if (!targets.length) {
    ElMessage.warning(t("admin.fetch.create.emptyInput"));
    return;
  }
  previewLoading.value = true;
  try {
    const res = await previewFetch(targets);
    previewSummary.value = res.summary;
    previewItems.value = res.items;
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.create.previewFailed")));
  } finally {
    previewLoading.value = false;
  }
}

async function doStart() {
  const targets = parseTargets(targetsText.value);
  if (!targets.length) {
    ElMessage.warning(t("admin.fetch.create.emptyInput"));
    return;
  }
  startLoading.value = true;
  try {
    const jobId = await createFetchTask(targets, false);
    ElMessage.success(t("admin.fetch.create.started", { id: shortId(jobId) }));
    activeTab.value = "jobs";
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.create.startFailed")));
  } finally {
    startLoading.value = false;
  }
}

// ---------- 任务列表 ----------
const jobs = ref<FetchJobSummary[]>([]);
const jobsLoading = ref(false);
const jobsError = ref("");
const statusFilter = ref("");
const limit = ref(50);
const jobStatusOptions = ["pending", "running", "done", "partial", "cancelled", "failed"];
const ACTIVE_STATUS = ["pending", "running"];

function isActiveStatus(s?: string): boolean {
  return !!s && ACTIVE_STATUS.includes(s);
}

async function fetchJobList(): Promise<FetchJobSummary[]> {
  return listFetchJobs({ limit: limit.value, status: statusFilter.value || undefined });
}

async function refreshJobs() {
  jobsLoading.value = true;
  jobsError.value = "";
  try {
    jobs.value = await fetchJobList();
    ensurePolling();
  } catch (e: any) {
    jobsError.value = apiErrorText(e, t("admin.fetch.jobs.loadFailed"));
  } finally {
    jobsLoading.value = false;
  }
}

// 进行中的任务每 2 秒轮询一次;全部结束/取消后自动停止。
let pollTimer: ReturnType<typeof setInterval> | null = null;

function hasActiveJobs(): boolean {
  return jobs.value.some((j) => isActiveStatus(j.status));
}
function ensurePolling() {
  if (hasActiveJobs()) {
    if (!pollTimer) pollTimer = setInterval(pollTick, 2000);
  } else {
    stopPolling();
  }
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
async function pollTick() {
  try {
    jobs.value = await fetchJobList();
    if (detailVisible.value && detailId.value) {
      const d = await getFetchJob(detailId.value);
      if (d) detail.value = d;
    }
  } catch {
    /* 轮询失败静默,下个 tick 再试 */
  }
  if (!hasActiveJobs()) stopPolling();
}

// ---------- 任务详情 ----------
const detailVisible = ref(false);
const detailId = ref("");
const detail = ref<FetchJobDetail | null>(null);
const detailLoading = ref(false);

async function openDetail(job: any) {
  detailId.value = job.id;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await getFetchJob(job.id);
    ensurePolling();
  } catch (e: any) {
    detail.value = null;
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.detailFailed")));
  } finally {
    detailLoading.value = false;
  }
}

// 删除单条任务记录（仅终态；运行中先取消）。
async function doDeleteJob(job: any) {
  try {
    await ElMessageBox.confirm(
      t("admin.fetch.jobs.deleteConfirm", { id: shortId(job.id) }),
      t("admin.fetch.jobs.delete"),
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await deleteFetchJob(job.id);
    ElMessage.success(t("admin.fetch.jobs.deleted"));
    if (detailVisible.value && detailId.value === job.id) detailVisible.value = false;
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.deleteFailed")));
  }
}

// 一键清空任务记录（只清终态）。
async function doClearJobs() {
  try {
    await ElMessageBox.confirm(t("admin.fetch.jobs.clearConfirm"), t("admin.fetch.jobs.clearAll"), {
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    const r = await clearFetchJobs();
    ElMessage.success(t("admin.fetch.jobs.cleared", { n: r.cleared ?? 0 }));
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.clearFailed")));
  }
}

async function doCancel(job: any) {
  try {
    await ElMessageBox.confirm(
      t("admin.fetch.jobs.cancelConfirm", { id: shortId(job.id) }),
      t("admin.fetch.jobs.cancel"),
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await cancelFetchJob(job.id);
    ElMessage.success(t("admin.fetch.jobs.cancelled"));
    await refreshJobs();
    if (detailVisible.value && detailId.value === job.id && detail.value) {
      const d = await getFetchJob(job.id);
      if (d) detail.value = d;
    }
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.cancelFailed")));
  }
}

// 顶部按钮:重试当前任务的全部失败项(job 级端点,onlyFailed)。
async function doRetryAll() {
  if (!detail.value) return;
  try {
    const newId = await retryFetchJob(detail.value.id, { onlyFailed: true });
    ElMessage.success(t("admin.fetch.jobs.retryStarted", { id: shortId(newId) }));
    detailVisible.value = false;
    activeTab.value = "jobs";
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.retryFailed")));
  }
}

// 逐曲重试:同走 job 级端点,传 targetIds 只重试该曲(targetId 缺失时退回只重试失败项)。
function canRetryItem(s?: string): boolean {
  return s === "failed" || s === "skipped" || s === "cancelled";
}
async function retryItem(item: any) {
  try {
    const opts = detail.value && item.targetId
      ? { targetIds: [item.targetId as string] }
      : { onlyFailed: true };
    const newId = await retryFetchJob(detailId.value, opts);
    ElMessage.success(t("admin.fetch.jobs.retryStarted", { id: shortId(newId) }));
    detailVisible.value = false;
    activeTab.value = "jobs";
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.jobs.retryFailed")));
  }
}

// ---------- 洗版(无损替换低码率) ----------
function defaultUpgradeConfig(): Required<UpgradeConfig> {
  return {
    sourceIds: [],
    batchLimit: 20,
    originalAction: "delete",
    losslessRoot: "",
    compressedMinKbps: 700,
    uncompressedMinKbps: 1400,
    inspectCandidates: true,
    upgradeCooldownDays: 30,
    upgradeAutoEnabled: false,
    upgradeAutoIntervalDays: 30,
    upgradeAutoTimeOfDay: "03:00",
  };
}

const upgradeConfig = reactive<Required<UpgradeConfig>>(defaultUpgradeConfig());
const upgradeConfigLoading = ref(false);
const upgradeSaving = ref(false);
const upgradeStarting = ref(false);
const planLoading = ref(false);
const planLoaded = ref(false);
const planError = ref("");
const upgradePlan = ref<UpgradePlan | null>(null);
const planItems = ref<UpgradePlanItem[]>([]);
const selectedSongIds = ref<string[]>([]);
const planTableRef = ref<any>(null);

async function loadUpgradeConfig() {
  upgradeConfigLoading.value = true;
  try {
    const remote = await getUpgradeConfig();
    const merged = defaultUpgradeConfig();
    Object.assign(merged, remote);
    const a = merged.originalAction;
    if (a !== "keep" && a !== "move" && a !== "delete") merged.originalAction = "delete";
    if (!Array.isArray(merged.sourceIds)) merged.sourceIds = [];
    // 冷却/定时四件套钳制(与后端 PUT 校验同口径):整数 1-365 + HH:mm 格式。
    merged.upgradeCooldownDays = Math.min(365, Math.max(1, Math.floor(Number(merged.upgradeCooldownDays) || 30)));
    merged.upgradeAutoEnabled = !!merged.upgradeAutoEnabled;
    merged.upgradeAutoIntervalDays = Math.min(365, Math.max(1, Math.floor(Number(merged.upgradeAutoIntervalDays) || 30)));
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(merged.upgradeAutoTimeOfDay ?? ""))) merged.upgradeAutoTimeOfDay = "03:00";
    Object.assign(upgradeConfig, merged);
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.upgrade.saveFailed")));
  } finally {
    upgradeConfigLoading.value = false;
  }
}

async function saveUpgradeConfig() {
  upgradeSaving.value = true;
  try {
    await updateUpgradeConfig({ ...upgradeConfig });
    ElMessage.success(t("admin.fetch.upgrade.saved"));
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.upgrade.saveFailed")));
  } finally {
    upgradeSaving.value = false;
  }
}

async function loadUpgradePlan() {
  planLoading.value = true;
  planError.value = "";
  try {
    const plan = await getUpgradePlan({ limit: upgradeConfig.batchLimit });
    upgradePlan.value = plan;
    planItems.value = plan.items || [];
    planLoaded.value = true;
    selectedSongIds.value = [];
  } catch (e: any) {
    planError.value = apiErrorText(e, t("admin.fetch.upgrade.loadFailed"));
  } finally {
    planLoading.value = false;
  }
}

function onPlanSelectionChange(rows: any[]) {
  selectedSongIds.value = (rows || []).map((r) => r.songId).filter(Boolean);
}
function selectAllPlan() {
  const tbl = planTableRef.value;
  if (!tbl || !planItems.value.length) return;
  if (selectedSongIds.value.length === planItems.value.length) return;
  tbl.clearSelection();
  tbl.toggleAllSelection();
}
function clearPlanSelection() {
  planTableRef.value?.clearSelection();
}

// 二次确认里列出将被删除的原文件(勾选项,或未勾选时按批量上限取的预览清单)。
function currentTriggerPaths(): string[] {
  const items = planItems.value;
  const picked = selectedSongIds.value.length
    ? items.filter((i) => selectedSongIds.value.includes(i.songId))
    : items.slice(0, upgradeConfig.batchLimit);
  return picked.map((i) => i.path).filter(Boolean) as string[];
}

async function confirmDelete(paths: string[]): Promise<boolean> {
  const list = (paths || []).filter(Boolean);
  const lines = list.slice(0, 10).map(escapeHtml);
  const more = list.length > 10
    ? `<br>${escapeHtml(t("admin.fetch.upgrade.deleteMore", { count: list.length - 10 }))}`
    : "";
  const listHtml = lines.length ? `<br><br>${lines.join("<br>")}${more}` : "";
  try {
    await ElMessageBox.confirm(
      escapeHtml(t("admin.fetch.upgrade.deleteWarn")) + listHtml,
      t("admin.fetch.upgrade.deleteTitle"),
      { type: "warning", dangerouslyUseHTMLString: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function doStartUpgrade() {
  const action = upgradeConfig.originalAction;
  if (action === "delete") {
    if (!(await confirmDelete(currentTriggerPaths()))) return;
  } else if (action === "move") {
    try {
      await ElMessageBox.confirm(t("admin.fetch.upgrade.moveConfirm"), t("admin.fetch.upgrade.start"), { type: "warning" });
    } catch {
      return;
    }
  } else {
    try {
      await ElMessageBox.confirm(t("admin.fetch.upgrade.keepConfirm"), t("admin.fetch.upgrade.start"), { type: "info" });
    } catch {
      return;
    }
  }

  upgradeStarting.value = true;
  try {
    const body: any = { dryRun: false };
    if (selectedSongIds.value.length) body.songIds = [...selectedSongIds.value];
    else body.limit = upgradeConfig.batchLimit;
    const job = await startUpgradeTask(body);
    ElMessage.success(t("admin.fetch.upgrade.started", { id: shortId(job?.id) }));
    activeTab.value = "jobs";
    await refreshJobs();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.upgrade.startFailed")));
  } finally {
    upgradeStarting.value = false;
  }
}

// 清空洗版冷却记录:下一次所有歌都可重新触发洗版。
const upgradeAttemptsResetting = ref(false);
async function doResetUpgradeAttempts() {
  try {
    await ElMessageBox.confirm(
      t("admin.fetch.upgrade.resetAttemptsConfirm"),
      t("admin.fetch.upgrade.resetAttempts"),
      { type: "warning" },
    );
  } catch {
    return;
  }
  upgradeAttemptsResetting.value = true;
  try {
    const cleared = await resetUpgradeAttempts();
    ElMessage.success(t("admin.fetch.upgrade.resetAttemptsDone", { count: cleared }));
    await loadUpgradePlan();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.upgrade.resetAttemptsFailed")));
  } finally {
    upgradeAttemptsResetting.value = false;
  }
}

// ---------- 全库平台音乐下载 ----------
const libraryPlan = ref<LibraryPlan | null>(null);
const libraryPlanLoading = ref(false);
const libraryStarting = ref(false);
const libraryResetting = ref(false);
const libraryBatchSize = ref(500);

async function loadLibraryPlan() {
  libraryPlanLoading.value = true;
  try {
    libraryPlan.value = await getLibraryPlan(0);
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.library.loadFailed")));
  } finally {
    libraryPlanLoading.value = false;
  }
}

async function doStartLibrary() {
  libraryStarting.value = true;
  try {
    const res = await startLibraryTask(libraryBatchSize.value);
    ElMessage.success(t("admin.fetch.library.started", { enqueued: res.enqueued, remaining: res.remaining }));
    await loadLibraryPlan();
    await refreshJobs();
    activeTab.value = "jobs";
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.library.startFailed")));
  } finally {
    libraryStarting.value = false;
  }
}

async function doResetLibrary() {
  try {
    await ElMessageBox.confirm(t("admin.fetch.library.resetConfirm"), t("admin.fetch.library.reset"), { type: "warning" });
  } catch {
    return;
  }
  libraryResetting.value = true;
  try {
    const cleared = await resetLibraryAttempts();
    ElMessage.success(t("admin.fetch.library.resetDone", { count: cleared }));
    await loadLibraryPlan();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.library.resetFailed")));
  } finally {
    libraryResetting.value = false;
  }
}

// ---------- 展示辅助 ----------
const STATUS_KEY: Record<string, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  partial: "partial",
  cancelled: "cancelled",
  failed: "failed",
  queued: "queued",
  probing: "probing",
  downloading: "downloading",
  verifying: "verifying",
  tagging: "tagging",
  transcoding: "transcoding",
  moving: "moving",
  scanned: "scanned",
  skipped: "skipped",
  downloadable: "downloadable",
  belowBar: "belowBar",
  noCandidate: "noCandidate",
};

function statusText(s?: string): string {
  if (!s) return "-";
  const k = STATUS_KEY[s];
  return k ? t(`admin.fetch.status.${k}`) : s;
}

function statusTagType(s?: string): "success" | "info" | "warning" | "danger" {
  if (!s) return "info";
  if (["done", "scanned", "downloadable"].includes(s)) return "success";
  if (["failed", "partial"].includes(s)) return "danger";
  if (["running", "probing", "downloading", "verifying", "tagging", "transcoding", "moving", "belowBar"].includes(s)) return "warning";
  return "info";
}

// 失败原因码 -> 中文/英文文案(按码给文案,不要裸码)。
const ERROR_CODE_KEY: Record<string, string> = {
  NO_CANDIDATE: "noCandidate",
  BELOW_BAR: "belowBar",
  ALREADY_IN_LIBRARY: "alreadyInLibrary",
  DUPLICATE_TARGET: "duplicateTarget",
  FAKE_LOSSLESS: "fakeLossless",
  INTEGRITY_FAILED: "integrityFailed",
  HTTP_403: "http403",
  TIMEOUT: "timeout",
  STALL: "stall",
  TAG_FAILED: "tagFailed",
  TRANSCODE_FAILED: "transcodeFailed",
  DISK_FULL: "diskFull",
  MOVE_FAILED: "moveFailed",
  SCAN_FAILED: "scanFailed",
  SSRF_BLOCKED: "ssrfBlocked",
  UNKNOWN: "unknown",
};

function errorText(code?: string): string {
  if (!code) return "";
  const k = ERROR_CODE_KEY[code];
  if (k) return t(`admin.fetch.errorCode.${k}`);
  const sk = STATUS_KEY[code];
  return sk ? t(`admin.fetch.status.${sk}`) : code;
}

function shortId(id?: string): string {
  if (!id) return "-";
  return id.length > 10 ? id.slice(0, 8) + "..." : id;
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatKbps(n?: number): string {
  return n == null ? "-" : `${n} kbps`;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 仅在「删除原件」二次确认里拼 HTML(路径来自服务端,必须转义)。
function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

// 洗版结果里的 replaced 字段容错展示(形状可能缺字段)。
function replacedText(r: any): string {
  if (!r || typeof r !== "object") return "";
  const from = r.originalPath || "";
  const to = r.newPath || r.movedTo || "";
  if (from && to) return `${from} -> ${to}`;
  return to || from || "";
}

function formatDateTime(v?: string | number): string {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function jobDuration(job: FetchJobSummary): string {
  const start = job.startedAt || job.createdAt;
  const end = job.finishedAt;
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function sourceText(chosen?: FetchChosen): string {
  if (!chosen) return "-";
  return chosen.platform || chosen.pluginId || "-";
}

function qualityText(chosen?: FetchChosen): string {
  if (!chosen) return "-";
  const p = chosen.probed ?? chosen.declared;
  const parts: string[] = [];
  if (p && typeof p === "object") {
    if (p.codec) parts.push(String(p.codec));
    if (p.bitrateKbps) parts.push(`${p.bitrateKbps} kbps`);
    if (p.sampleRateHz) parts.push(`${p.sampleRateHz} Hz`);
    if (p.bitDepth) parts.push(`${p.bitDepth} bit`);
  } else if (typeof p === "string" && p) {
    parts.push(p);
  }
  return parts.length ? parts.join(" / ") : "-";
}

onMounted(() => {
  loadConfig();
  loadSources();
  refreshJobs();
  loadUpgradeConfig();
  loadLibraryPlan();
});
// 切到「创建」页签时刷新一次全库统计。
watch(activeTab, (v) => {
  if (v === "create") loadLibraryPlan();
});
onUnmounted(stopPolling);
</script>

<style lang="scss" scoped>
.admin-fetch { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 8px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; }
}
.fetch-tabs { margin-top: 8px; }
.hint { font-size: 12px; color: var(--fnos-text-tertiary); line-height: 1.6; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cell-fail { color: var(--fnos-red); font-weight: 600; }

/* 配置 */
.config-wrap { max-width: 960px; }
.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 4px 20px;
  align-items: start;
}
.config-form :deep(.el-form-item) { margin-bottom: 16px; }
.field-inline { display: flex; align-items: center; gap: 10px; }
.transcode-warn { margin: 4px 0 16px; }
.loudness-hint { margin: -10px 0 16px; max-width: 960px; }
.time-input { width: 120px; }
.config-actions { margin-top: 8px; }

.priority-list { width: 100%; }
.priority-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.priority-idx { flex: 0 0 18px; text-align: center; font-size: 12px; color: var(--fnos-text-tertiary); }
.priority-input { flex: 1; min-width: 0; }
.priority-add { display: flex; gap: 8px; margin-top: 8px; max-width: 460px; }
.avail-sources { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.src-tag { cursor: pointer; }

/* 新建任务 */
.create-form { max-width: 900px; }
.library-block { max-width: 900px; }
.library-stats { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.library-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.library-hint { margin-top: 10px; }
.create-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.preview-block { margin-top: 8px; }
.summary-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

/* 任务列表 */
.jobs-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 12px; margin-bottom: 12px;
}
.jobs-filters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.filter-select { width: 140px; }
.limit-select { width: 100px; }
.jobs-error { margin-bottom: 12px; }

/* 详情 */
.detail-body { min-height: 120px; }
.detail-empty { min-height: 160px; }
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.detail-meta { display: flex; align-items: center; gap: 10px; }
.detail-counts { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--fnos-text-tertiary); }
.detail-actions { display: flex; gap: 10px; margin: 12px 0; flex-wrap: wrap; }
.detail-table { margin-top: 4px; }
.song-cell { display: flex; flex-direction: column; }
.song-title { color: var(--fnos-text-primary); }
.song-artist { font-size: 12px; color: var(--fnos-text-tertiary); }
.empty-items { padding: 24px 0; text-align: center; }

/* 洗版 */
.upgrade-wrap { max-width: 1100px; }
.upgrade-form :deep(.el-form-item) { margin-bottom: 16px; }
.upgrade-warn { margin: 4px 0 16px; }
.upgrade-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.upgrade-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.upgrade-hint { padding: 20px 0; }
.upgrade-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }

@media (max-width: 768px) {
  .admin-fetch { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .config-grid { grid-template-columns: 1fr; }
  .jobs-filters { width: 100%; }
  /* 详情弹窗手机端:统计行距收紧、路径等长文本可断行,防压叠 */
  .detail-head { flex-direction: column; align-items: flex-start; }
  .detail-counts { gap: 6px 12px; }
  .mono { word-break: break-all; }
}
</style>
