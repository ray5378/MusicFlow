<template>
  <div class="admin-fetch">
    <div class="page-header">
      <h2>{{ t('admin.fetch.title') }}</h2>
      <el-button :loading="jobsLoading" @click="refreshAllJobs"><MfIcon name="RefreshCw" />{{ t('admin.fetch.jobs.refresh') }}</el-button>
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
              <el-form-item :label="t('admin.fetch.config.deadSongPurgeThreshold')">
                <el-input-number v-model="config.deadSongPurgeThreshold" :min="0" :max="20" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.deadSongPurgeThresholdHint') }}</div>
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
              <el-form-item :label="t('admin.fetch.config.maxConcurrentTargets')">
                <el-input-number v-model="config.maxConcurrentTargets" :min="1" :max="64" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.maxConcurrentTargetsHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.config.maxConcurrentTranscodes')">
                <el-input-number v-model="config.maxConcurrentTranscodes" :min="1" :max="16" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.config.maxConcurrentTranscodesHint') }}</div>
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

      <!-- ===== 2. 下载：新建任务 + 全库 ===== -->
      <el-tab-pane :label="t('admin.fetch.tabCreate')" name="create">
        <div v-loading="createLoading" class="create-wrap">
        <el-form label-position="top" class="create-form">
          <el-form-item :label="t('admin.fetch.create.inputLabel')">
            <div class="hint">{{ t('admin.fetch.create.inputHint') }}</div>
            <el-input v-model="targetsText" type="textarea" :rows="8" :placeholder="t('admin.fetch.create.placeholder')" />
          </el-form-item>
          <div class="create-actions">
            <span class="hint">{{ t('admin.fetch.create.parsedCount', { count: parsedCount }) }}</span>
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
        </div>
      </el-tab-pane>

      <!-- ===== 3. 洗版(无损替换低码率) ===== -->
      <el-tab-pane :label="t('admin.fetch.tabUpgrade')" name="upgrade">
        <div v-loading="upgradeConfigLoading" class="upgrade-wrap">
          <el-form label-position="top" class="upgrade-form">
            <el-divider content-position="left">{{ t('admin.fetch.upgrade.settings') }}</el-divider>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.upgrade.batchLimit')">
                <el-input-number v-model="upgradeConfig.batchLimit" :min="1" :max="500" controls-position="right" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.losslessRoot')">
                <el-input v-model="upgradeConfig.losslessRoot" :placeholder="t('admin.fetch.upgrade.losslessRootPlaceholder')" />
                <div class="hint">{{ t('admin.fetch.upgrade.losslessRootHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.compressedMinKbps')">
                <el-input-number v-model="upgradeConfig.compressedMinKbps" :min="0" :step="50" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.upgrade.compressedMinKbpsHint') }}</div>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.upgrade.uncompressedMinKbps')">
                <el-input-number v-model="upgradeConfig.uncompressedMinKbps" :min="0" :step="100" controls-position="right" />
                <div class="hint">{{ t('admin.fetch.upgrade.uncompressedMinKbpsHint') }}</div>
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
              <el-form-item :label="t('admin.fetch.upgrade.upgradeAutoContinue')">
                <el-switch v-model="upgradeConfig.upgradeAutoContinue" />
                <div class="hint">{{ t('admin.fetch.upgrade.upgradeAutoContinueHint') }}</div>
              </el-form-item>
            </div>
            <div class="config-actions">
              <el-button :loading="upgradeSaving" @click="saveUpgradeConfig">{{ t('admin.fetch.upgrade.save') }}</el-button>
            </div>
          </el-form>

          <el-divider content-position="left">{{ t('admin.fetch.upgrade.stats') }}</el-divider>
          <div class="upgrade-stats">
            <el-tag type="warning">{{ t('admin.fetch.upgrade.pending', { count: upgradePlan?.belowBar ?? 0 }) }}</el-tag>
            <el-tag type="info">{{ t('admin.fetch.upgrade.attempted', { count: upgradePlan?.attempted ?? 0 }) }}</el-tag>
            <span v-if="upgradePlan" class="hint">{{ t('admin.fetch.upgrade.total', { count: upgradePlan.total }) }}</span>
          </div>
          <div class="upgrade-actions">
            <el-button type="primary" :loading="upgradeStarting" @click="doStartUpgrade"><MfIcon name="Download" />{{ t('admin.fetch.upgrade.start') }}</el-button>
            <el-button :loading="upgradeAttemptsResetting" @click="doResetUpgradeAttempts">{{ t('admin.fetch.upgrade.resetAttempts') }}</el-button>
            <el-button :loading="planLoading" @click="loadUpgradeStats"><MfIcon name="RefreshCw" />{{ t('admin.fetch.upgrade.reload') }}</el-button>
          </div>
          <div class="hint upgrade-hint">{{ t('admin.fetch.upgrade.autoContinueHint') }}</div>
        </div>
      </el-tab-pane>

      <!-- ===== 4. 标签修复（独立子页：双挡位） ===== -->
      <el-tab-pane :label="t('admin.fetch.tabTagRepair')" name="tagRepair">
        <div class="tag-repair-wrap">
          <div class="tag-repair-status">
            <el-tag :type="tagRepairStatus.running ? 'warning' : 'info'">
              {{ tagRepairStatus.running ? t('admin.fetch.tagRepair.running') : t('admin.fetch.tagRepair.idle') }}
            </el-tag>
            <el-button size="small" @click="loadTagRepairStatus"><MfIcon name="RefreshCw" />{{ t('admin.fetch.tagRepair.reload') }}</el-button>
          </div>

          <!-- 实时统计：已修复 / 待修复 / 全部 / 终态不可得 -->
          <div class="tag-repair-stats">
            <div class="stat-card">
              <div class="stat-value">{{ tagRepairStatRepaired }}</div>
              <div class="stat-label">{{ t('admin.fetch.tagRepair.statRepaired') }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ tagRepairStatPending }}</div>
              <div class="stat-label">{{ t('admin.fetch.tagRepair.statPending') }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ tagRepairStatTotal }}</div>
              <div class="stat-label">{{ t('admin.fetch.tagRepair.statTotal') }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ tagRepairStatUnobtainable }}</div>
              <div class="stat-label">{{ t('admin.fetch.tagRepair.statUnobtainable') }}</div>
            </div>
          </div>

          <!-- 标签来源分布：按完成标记行的 platform 聚合（QQ音乐 / 网易云音乐 / 历史未记录） -->
          <div v-if="tagRepairPlatformRows.length" class="tag-repair-source">
            <div class="source-head">
              <span class="source-title">{{ t('admin.fetch.tagRepair.sourceTitle') }}</span>
              <span class="hint">{{ t('admin.fetch.tagRepair.sourceHint') }}</span>
            </div>
            <div class="source-rows">
              <div v-for="row in tagRepairPlatformRows" :key="row.key" class="source-row">
                <span class="source-name">{{ row.label }}</span>
                <div class="source-bar">
                  <div class="source-bar-fill" :style="{ width: row.percent + '%' }" />
                </div>
                <span class="source-count">{{ row.count }} · {{ row.percent }}%</span>
              </div>
            </div>
          </div>

          <!-- 运行中进度条 -->
          <div v-if="tagRepairStatus.running && tagRepairStatus.progress" class="tag-repair-progress">
            <div class="progress-head">
              <span>{{ tagRepairProgressLabel }}</span>
              <span>{{ tagRepairProgressText }}</span>
            </div>
            <el-progress
              :percentage="tagRepairProgressPercent"
              :indeterminate="tagRepairProgressIndeterminate"
              :stroke-width="10"
            />
          </div>

          <el-form label-position="top" class="tag-repair-form">
            <el-divider content-position="left">{{ t('admin.fetch.tagRepair.settings') }}</el-divider>
            <div class="hint tag-repair-hint">{{ t('admin.fetch.tagRepair.settingsHint') }}</div>
            <div class="config-grid">
              <el-form-item :label="t('admin.fetch.tagRepair.enabled')">
                <el-switch v-model="config.tagRepairEnabled" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.tagRepair.intervalHours')">
                <el-input-number v-model="config.tagRepairIntervalHours" :min="1" :max="8760" controls-position="right" :disabled="!config.tagRepairEnabled" />
              </el-form-item>
              <el-form-item :label="t('admin.fetch.tagRepair.scopeLabel')">
                <el-select v-model="config.tagRepairScope" style="width: 100%">
                  <el-option :label="t('admin.fetch.tagRepair.scopeDownload')" value="download" />
                  <el-option :label="t('admin.fetch.tagRepair.scopeLossless')" value="lossless" />
                  <el-option :label="t('admin.fetch.tagRepair.scopeBoth')" value="both" />
                </el-select>
              </el-form-item>
              <el-form-item :label="t('admin.fetch.tagRepair.textVariantLabel')">
                <el-select v-model="config.chineseVariant" style="width: 100%">
                  <el-option :label="t('admin.fetch.tagRepair.textVariantSimplified')" value="simplified" />
                  <el-option :label="t('admin.fetch.tagRepair.textVariantTraditional')" value="traditional" />
                </el-select>
              </el-form-item>
            </div>
            <div class="hint tag-repair-hint">{{ t('admin.fetch.tagRepair.textVariantHint') }}</div>
            <div class="config-actions">
              <el-button type="primary" :loading="tagRepairSaving" @click="saveTagRepairSettings">{{ t('admin.fetch.tagRepair.save') }}</el-button>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.tagRepair.mediaTitle') }}</el-divider>
            <div class="hint tag-repair-hint">{{ t('admin.fetch.tagRepair.mediaDesc') }}</div>
            <div class="tag-repair-actions">
              <el-button type="primary" :loading="tagRepairBusyMedia" :disabled="tagRepairStatus.running" @click="onTagRepairMedia">{{ t('admin.fetch.tagRepair.mediaBtn') }}</el-button>
            </div>

            <el-divider content-position="left">{{ t('admin.fetch.tagRepair.allTitle') }}</el-divider>
            <el-alert class="tag-repair-alert" type="warning" :closable="false" show-icon>{{ t('admin.fetch.tagRepair.allWarn') }}</el-alert>
            <div class="hint tag-repair-hint">{{ t('admin.fetch.tagRepair.allDesc') }}</div>
            <div class="tag-repair-actions">
              <el-button type="primary" :loading="tagRepairBusyAll" :disabled="tagRepairStatus.running" @click="onTagRepairAll">{{ t('admin.fetch.tagRepair.allBtn') }}</el-button>
            </div>

            <div class="hint tag-repair-write-hint">{{ t('admin.fetch.tagRepair.writeHint') }}</div>
          </el-form>
        </div>
      </el-tab-pane>

      <!-- ===== 5. 下载任务列表（全部非洗版：搜索导入 / 全库 / 重试） ===== -->
      <el-tab-pane :label="t('admin.fetch.tabJobs')" name="jobs" lazy>
        <JobListPanel ref="downloadJobsRef" :kinds="DOWNLOAD_JOB_KINDS" />
      </el-tab-pane>

      <!-- ===== 6. 洗版任务列表（独立模块，与下载任务完全分开） ===== -->
      <el-tab-pane :label="t('admin.fetch.tabUpgradeJobs')" name="upgradeJobs" lazy>
        <JobListPanel ref="upgradeJobsRef" :kinds="UPGRADE_JOB_KINDS" />
      </el-tab-pane>
    </el-tabs>

  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import JobListPanel from "./JobListPanel.vue";
import { apiErrorText } from "@/utils/apiError";
import {
  errorText as fmtErrorText,
  shortId as fmtShortId,
  type TFn,
} from "./jobFormat";
import {
  getFetchConfig,
  updateFetchConfig,
  getFetchSources,
  createFetchTask,
  getUpgradePlan,
  getUpgradeConfig,
  updateUpgradeConfig,
  startUpgradeTask,
  getLibraryPlan,
  startLibraryTask,
  resetLibraryAttempts,
  resetUpgradeAttempts,
  getTagRepairStatus,
  runTagRepair,
} from "@/api/fetch";
import type {
  FetchConfig,
  FetchSourceInfo,
  FetchTargetInput,
  UpgradePlan,
  UpgradeConfig,
  LibraryPlan,
  TagRepairMode,
  TagRepairStatus,
} from "@/api/fetch";

const { t } = useI18n();
// jobFormat 里的纯函数统一吃 (t, ...)，这里把它收窄成字符串键形式。
const tt = t as unknown as TFn;

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
    skipIfInLibrary: true,
    strictBestTier: true,
    downloadCooldownDays: 7,
    deadSongPurgeThreshold: 2,
    transcodeEnabled: true,
    transcodeTarget: "flac",
    transcodeSampleRateHz: "follow",
    transcodeBitDepth: "follow",
    transcodeKeepOriginal: false,
    maxConcurrentDownloads: 2,
    maxConcurrentJobs: 2,
    maxConcurrentTargets: 3,
    maxConcurrentTranscodes: 4,
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
    tagRepairEnabled: true,
    tagRepairIntervalHours: 168,
    tagRepairScope: "both",
    chineseVariant: "simplified",
  };
}

const config = reactive<ConfigForm>(defaultConfig());
const configLoading = ref(false);
const configSaving = ref(false);

// ==================== 标签缺失修复（2026-10-11；2026-10-16 独立页签 + 双挡位） ====================
const tagRepairStatus = ref<TagRepairStatus>({ enabled: false, intervalHours: 168, scope: "both", queueSize: 0, running: false, lastResult: null, lastResults: {}, stats: { total: 0, pending: 0, repaired: 0, unobtainableTotal: 0, platforms: [] }, progress: null });
const tagRepairSaving = ref(false);
const tagRepairBusyMedia = ref(false);
const tagRepairBusyAll = ref(false);
let tagRepairPoll: ReturnType<typeof setInterval> | null = null;
// 组件是否已卸载：卸载瞬间仍在途的 loadTagRepairStatus 落地后不得再写状态或重建轮询定时器
// （2026-10-16 修正：否则会产生一个无人清理的 5s 定时器）。
let tagRepairDisposed = false;

// 挡位显示名：兼容历史值 "full"（旧版全量挡位）映射到「全量」文案；未知/缺省归到队列。
function tagRepairModeLabel(mode?: string): string {
  if (mode === "all" || mode === "full") return t("admin.fetch.tagRepair.modeAll");
  if (mode === "media") return t("admin.fetch.tagRepair.modeMedia");
  return t("admin.fetch.tagRepair.modeQueue");
}

// ---------- 实时统计（已修复 / 待修复 / 全部） ----------
// 已修复口径 = 真正写入修复的 + 无需修/命中下载期完成标记跳过的（两类都算「已完成」）。
// 【2026-10-17 修正 4】stats.repaired 后端已改为**完成标记行数**（每首修复即写标记），
// 因此直接取用即可实时反映进度；不再叠加本轮 progress（否则同一首歌会被计两次）。
const tagRepairStatRepaired = computed(() => tagRepairStatus.value.stats?.repaired ?? 0);
// 待修复：运行中取「本阶段剩余」（总数 - 已处理）；空闲取 DB 待修候选数。
const tagRepairStatPending = computed(() => {
  const p = tagRepairStatus.value.progress;
  if (tagRepairStatus.value.running && p && p.total > 0) return Math.max(0, p.total - p.checked);
  return tagRepairStatus.value.stats?.pending ?? 0;
});
const tagRepairStatTotal = computed(() => tagRepairStatus.value.stats?.total ?? 0);
// 终态不可得（累计）：真缺标签但各来源都拿不到、已被标记跳过不再重扫的歌数（= 后端统计
// stats.unobtainableTotal，即 outcome='unobtainable' 的完成标记行数；带 30 天 TTL）。
const tagRepairStatUnobtainable = computed(() => tagRepairStatus.value.stats?.unobtainableTotal ?? 0);

// 标签来源分布（按完成标记行的 platform 聚合，后端 DB 聚合、无实时探测）：
// 把 platform 码映射为可读名并算占比；"" = 历史（未记录来源，旧行 platform 为 NULL）。
// 只在有数据时展示，且按 count 降序排（QQ 优先命中 → 通常居首）。
const tagRepairPlatformRows = computed(() => {
  const list = tagRepairStatus.value.stats?.platforms ?? [];
  const total = list.reduce((s, r) => s + (r.count ?? 0), 0);
  return list
    .filter((r) => (r.count ?? 0) > 0)
    .map((r) => {
      const label =
        r.platform === "qq"
          ? t("admin.fetch.tagRepair.platformQq")
          : r.platform === "netease"
            ? t("admin.fetch.tagRepair.platformNetease")
            : r.platform
              ? r.platform
              : t("admin.fetch.tagRepair.platformUnknown");
      return {
        key: r.platform || "__unknown__",
        label,
        count: r.count ?? 0,
        percent: total > 0 ? Math.round(((r.count ?? 0) / total) * 100) : 0,
      };
    })
    .sort((a, b) => b.count - a.count);
});

// 运行中进度条：scan 阶段为不定长（indeterminate），repair 阶段按 checked/total 显示百分比。
const tagRepairProgressIndeterminate = computed(() => tagRepairStatus.value.progress?.phase === "scan");
const tagRepairProgressPercent = computed(() => {
  const p = tagRepairStatus.value.progress;
  if (!p || p.total <= 0) return 0;
  return Math.min(100, Math.round((p.checked / p.total) * 100));
});
const tagRepairProgressLabel = computed(() => {
  const p = tagRepairStatus.value.progress;
  if (!p) return "";
  const phase = p.phase === "scan" ? t("admin.fetch.tagRepair.phaseScan") : t("admin.fetch.tagRepair.phaseRepair");
  return `${tagRepairModeLabel(p.mode)} · ${phase}`;
});
const tagRepairProgressText = computed(() => {
  const p = tagRepairStatus.value.progress;
  if (!p) return "";
  // scan 阶段只精探文件头、不产生修复结果，故只报精探进度（此阶段 fixed/skipped/unobtainable 恒为 0，
  // 若与「已处理」并列展示会造成「三项之和 ≠ 已处理」的假不一致）。
  if (p.phase === "scan") {
    return t("admin.fetch.tagRepair.progressTextScan", { checked: p.checked, total: p.total });
  }
  // repair 阶段给出完整拆分：已修复 + 跳过 + 未获取到 == 已处理。
  return t("admin.fetch.tagRepair.progressText", {
    checked: p.checked,
    total: p.total,
    fixed: p.fixed,
    skipped: p.skipped ?? 0,
    unobtainable: p.unobtainable ?? 0,
  });
});

function formatTagRepairResult(r: NonNullable<TagRepairStatus["lastResult"]>): string {
  return t("admin.fetch.tagRepair.resultLine", {
    mode: tagRepairModeLabel(r.mode),
    fixed: r.fixed ?? 0,
    cover: r.coverFixed ?? 0,
    lyric: r.lyricFixed ?? 0,
    album: r.albumFixed ?? 0,
    meta: r.metaFixed ?? 0,
    miss: r.unobtainable ?? 0,
  });
}

async function loadTagRepairStatus() {
  try {
    const wasRunning = tagRepairStatus.value.running;
    const next = await getTagRepairStatus();
    if (tagRepairDisposed) return; // 已卸载：丢弃在途响应，不得重建轮询定时器
    tagRepairStatus.value = next;
    // 运行中每 5s 轮询一次；到终态停表并提示。
    if (tagRepairStatus.value.running && !tagRepairPoll) {
      tagRepairPoll = setInterval(loadTagRepairStatus, 5000);
    } else if (!tagRepairStatus.value.running && tagRepairPoll) {
      clearInterval(tagRepairPoll);
      tagRepairPoll = null;
      if (wasRunning && tagRepairStatus.value.lastResult) {
        ElMessage.success(formatTagRepairResult(tagRepairStatus.value.lastResult));
      }
    }
  } catch {
    /* 状态获取失败不打扰 */
  }
}

// 两个入口共用：统一的 loading 管理 + 409「忙」识别（避免重复处理）。
async function runTagRepairMode(mode: TagRepairMode, busy: Ref<boolean>): Promise<void> {
  busy.value = true;
  try {
    // 本次扫描范围沿用当前选择（未保存也即时生效）；保存设置则持久化给定时常规扫用。
    await runTagRepair(mode, config.tagRepairScope);
    if (mode === "media") ElMessage.success(t("admin.fetch.tagRepair.mediaStarted"));
    else ElMessage.success(t("admin.fetch.tagRepair.allStarted"));
  } catch (e: any) {
    // 后端「已有修复在跑」时返回 HTTP 409（{busy:true}），axios 会把它抛成异常 → 识别 409 走「正在运行」提示。
    if (e?.response?.status === 409) ElMessage.warning(t("admin.fetch.tagRepair.running"));
    else ElMessage.error(apiErrorText(e, t("admin.fetch.tagRepair.saveFailed")));
  } finally {
    busy.value = false;
    loadTagRepairStatus();
  }
}

function onTagRepairMedia(): void {
  void runTagRepairMode("media", tagRepairBusyMedia);
}
function onTagRepairAll(): void {
  void runTagRepairMode("all", tagRepairBusyAll);
}

// 「保存设置」与配置页签共用同一份覆盖项存储，后端 PUT /config 为**整体替换**语义，
// 故这里必须提交完整配置字段（含 chineseVariant），否则会把其它覆盖项（如字形、全库下载开关）
// 一并清空回默认值（2026-10-16 修正）。
async function saveTagRepairSettings(): Promise<void> {
  tagRepairSaving.value = true;
  try {
    await updateFetchConfig(buildConfigPayload());
    ElMessage.success(t("admin.fetch.tagRepair.saved"));
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.tagRepair.saveFailed")));
  } finally {
    tagRepairSaving.value = false;
  }
}
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
    if (merged.maxConcurrentTargets == null) merged.maxConcurrentTargets = 3;
    if (merged.maxConcurrentTranscodes == null) merged.maxConcurrentTranscodes = 4;
    if (merged.libraryAutoContinue == null) merged.libraryAutoContinue = true;
    if (merged.downloadCooldownDays == null) merged.downloadCooldownDays = 7;
    if (merged.deadSongPurgeThreshold == null) merged.deadSongPurgeThreshold = 2;
    if (merged.libraryCooldownDays == null) merged.libraryCooldownDays = 30;
    if (merged.libraryAutoEnabled == null) merged.libraryAutoEnabled = false;
    if (merged.libraryAutoIntervalDays == null) merged.libraryAutoIntervalDays = 1;
    if (!merged.libraryAutoTimeOfDay) merged.libraryAutoTimeOfDay = "03:00";
    if (merged.tagRepairEnabled == null) merged.tagRepairEnabled = true;
    if (merged.tagRepairIntervalHours == null) merged.tagRepairIntervalHours = 168;
    if (merged.tagRepairScope !== "download" && merged.tagRepairScope !== "lossless" && merged.tagRepairScope !== "both") merged.tagRepairScope = "both";
    if (merged.chineseVariant !== "traditional") merged.chineseVariant = "simplified";
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

// 组装提交给 PUT /config 的完整覆盖项：转码「跟随源」= 省略该键（不传 null / 空串）。
// 后端为整体替换语义，两个保存入口（配置页签 / 标签修复设置）都必须提交完整字段集。
function buildConfigPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...config };
  if (payload.transcodeSampleRateHz === "follow") delete payload.transcodeSampleRateHz;
  if (payload.transcodeBitDepth === "follow") delete payload.transcodeBitDepth;
  return payload;
}

async function saveConfig() {
  configSaving.value = true;
  try {
    await updateFetchConfig(buildConfigPayload());
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
const startLoading = ref(false);
// 「新建任务」页签的独立 loading(T14):仅覆盖首次进入该页签时触发的全库计划拉取,
// 避免此前该页签完全没有自身加载态;日常手动刷新仍由 libraryPlanLoading 承担。
const createLoading = ref(false);

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

async function doStart() {
  const targets = parseTargets(targetsText.value);
  if (!targets.length) {
    ElMessage.warning(t("admin.fetch.create.emptyInput"));
    return;
  }
  startLoading.value = true;
  try {
    const jobId = await createFetchTask(targets);
    ElMessage.success(t("admin.fetch.create.started", { id: shortId(jobId) }));
    activeTab.value = "jobs";
    await downloadJobsRef.value?.refresh();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.create.startFailed")));
  } finally {
    startLoading.value = false;
  }
}

// ---------- 任务列表（两个独立面板：下载 / 洗版） ----------
// 列表本身的筛选、轮询、详情弹窗、逐条操作全部下沉到 JobListPanel.vue；
// 这里只保留「新建任务后把对应面板刷一下」这一条父级职责。
// 下载任务 = 全部非洗版（搜索导入 search / 全库 library / 重试 retry / 历史 manual）；
// 洗版任务 = upgrade。两类任务因此永远不会混在同一个列表里。
// 「下载任务列表」= 全部非洗版 kind（洗版单独一栏）。新增 kind 必须显式决定归哪一栏。
const DOWNLOAD_JOB_KINDS = ["search", "import", "library", "retry", "manual"];
const UPGRADE_JOB_KINDS = ["upgrade"];

const downloadJobsRef = ref<InstanceType<typeof JobListPanel> | null>(null);
const upgradeJobsRef = ref<InstanceType<typeof JobListPanel> | null>(null);
const jobsLoading = ref(false);

async function refreshAllJobs() {
  jobsLoading.value = true;
  try {
    await Promise.all([downloadJobsRef.value?.refresh(), upgradeJobsRef.value?.refresh()]);
  } finally {
    jobsLoading.value = false;
  }
}

// ---------- 洗版(无损替换低码率) ----------
function defaultUpgradeConfig(): Required<UpgradeConfig> {
  return {
    sourceIds: [],
    batchLimit: 20,
    losslessRoot: "",
    compressedMinKbps: 700,
    uncompressedMinKbps: 1400,
    upgradeCooldownDays: 30,
    upgradeAutoEnabled: false,
    upgradeAutoIntervalDays: 30,
    upgradeAutoTimeOfDay: "03:00",
    upgradeAutoContinue: true,
  };
}

const upgradeConfig = reactive<Required<UpgradeConfig>>(defaultUpgradeConfig());
const upgradeConfigLoading = ref(false);
const upgradeSaving = ref(false);
const upgradeStarting = ref(false);
const planLoading = ref(false);
const upgradePlan = ref<UpgradePlan | null>(null);

async function loadUpgradeConfig() {
  upgradeConfigLoading.value = true;
  try {
    const remote = await getUpgradeConfig();
    const merged = defaultUpgradeConfig();
    Object.assign(merged, remote);
    if (!Array.isArray(merged.sourceIds)) merged.sourceIds = [];
    // 冷却/定时四件套钳制(与后端 PUT 校验同口径):整数 1-365 + HH:mm 格式。
    merged.upgradeCooldownDays = Math.min(365, Math.max(1, Math.floor(Number(merged.upgradeCooldownDays) || 30)));
    merged.upgradeAutoEnabled = !!merged.upgradeAutoEnabled;
    merged.upgradeAutoIntervalDays = Math.min(365, Math.max(1, Math.floor(Number(merged.upgradeAutoIntervalDays) || 30)));
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(merged.upgradeAutoTimeOfDay ?? ""))) merged.upgradeAutoTimeOfDay = "03:00";
    if (merged.upgradeAutoContinue == null) merged.upgradeAutoContinue = true;
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

// 洗版统计（待洗版 / 已尝试 / 全库共）：不带 limit → 只取计数不列清单（预览已下线）。
async function loadUpgradeStats() {
  planLoading.value = true;
  try {
    upgradePlan.value = await getUpgradePlan();
  } catch (e: any) {
    ElMessage.error(apiErrorText(e, t("admin.fetch.upgrade.loadFailed")));
  } finally {
    planLoading.value = false;
  }
}

async function doStartUpgrade() {
  upgradeStarting.value = true;
  try {
    // 全库范围触发（不带 songIds）：一批终态后自动续下一批，重启容器也会接上。
    const job = await startUpgradeTask({ limit: upgradeConfig.batchLimit });
    ElMessage.success(t("admin.fetch.upgrade.started", { id: shortId(job?.id) }));
    activeTab.value = "upgradeJobs";
    await upgradeJobsRef.value?.refresh();
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
    await loadUpgradeStats();
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
    await downloadJobsRef.value?.refresh();
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

// ---------- 展示辅助（任务列表相关的已下沉到 jobFormat.ts，这里只留父级自己用的） ----------
const errorText = (c?: string) => fmtErrorText(tt, c);
const shortId = fmtShortId;

function formatKbps(n?: number): string {
  return n == null ? "-" : `${n} kbps`;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

onMounted(() => {
  loadConfig();
  loadSources();
  loadUpgradeConfig();
  loadTagRepairStatus();
  // 两个任务面板用 el-tab-pane `lazy` 懒挂载：切到对应页签才 mount 并自拉，不在这里重复请求。
});

// 离开页面必须清掉标签修复轮询定时器（2026-10-16 修正）：否则切走后定时器仍在后台
// 每 5s 空转发请求，白耗资源（且可能对着已卸载组件 set 状态）。
onUnmounted(() => {
  tagRepairDisposed = true;
  if (tagRepairPoll) {
    clearInterval(tagRepairPoll);
    tagRepairPoll = null;
  }
});

// 全库统计（洗版 / 全库下载）各是一次全表扫描，**首次切到对应页签才拉**：
// 打开页面默认停在「配置」页签 → 首屏不再触发扫描，避免同步 SQLite 长扫描阻塞事件循环
// 把整页拖成「卡加载」；之后由页签内的「刷新」按钮手动重拉（loadUpgradeStats / loadLibraryPlan）。
const libraryPlanLoaded = ref(false);
const upgradeStatsLoaded = ref(false);

watch(activeTab, (v) => {
  if (v === "create" && !libraryPlanLoaded.value) {
    libraryPlanLoaded.value = true;
    createLoading.value = true;
    loadLibraryPlan().finally(() => { createLoading.value = false; });
  }
  if (v === "upgrade" && !upgradeStatsLoaded.value) {
    upgradeStatsLoaded.value = true;
    loadUpgradeStats();
  }
  if (v === "jobs") downloadJobsRef.value?.refresh();
  if (v === "upgradeJobs") upgradeJobsRef.value?.refresh();
});
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
.upgrade-stats { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.upgrade-hint { padding: 20px 0; }
.upgrade-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }

/* 标签修复 */
.tag-repair-wrap { max-width: 900px; }
.tag-repair-status { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.tag-repair-form :deep(.el-form-item) { margin-bottom: 16px; }
.tag-repair-hint { margin: 0 0 12px; }
.tag-repair-alert { margin: 4px 0 12px; }
.tag-repair-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 4px 0 16px; }
.tag-repair-write-hint { margin-top: 8px; }
.tag-repair-stats { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 12px; margin: 4px 0 16px; max-width: 720px; }
.stat-card { background: var(--fnos-bg-elevated, rgba(255, 255, 255, 0.04)); border: 1px solid var(--fnos-border, rgba(255, 255, 255, 0.1)); border-radius: 8px; padding: 12px 16px; text-align: center; }
.stat-value { font-size: 26px; font-weight: 700; line-height: 1.2; }
.stat-label { margin-top: 4px; font-size: 12px; color: var(--fnos-text-tertiary); }
.tag-repair-progress { margin: 0 0 16px; max-width: 720px; }
.progress-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; font-size: 12px; color: var(--fnos-text-tertiary); }
/* 标签来源分布：来源名 + 占比条 + 数量/占比 */
.tag-repair-source { margin: 0 0 16px; max-width: 720px; }
.source-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.source-title { font-size: 13px; font-weight: 600; }
.source-rows { display: flex; flex-direction: column; gap: 8px; }
.source-row { display: grid; grid-template-columns: 96px 1fr 96px; align-items: center; gap: 10px; }
.source-name { font-size: 13px; color: var(--fnos-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.source-bar { height: 10px; border-radius: 5px; background: var(--fnos-bg-elevated, rgba(255, 255, 255, 0.06)); overflow: hidden; }
.source-bar-fill { height: 100%; border-radius: 5px; background: var(--fnos-primary, #409eff); transition: width 0.3s ease; }
.source-count { font-size: 12px; color: var(--fnos-text-tertiary); text-align: right; white-space: nowrap; }

@media (max-width: 768px) {
  .admin-fetch { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .config-grid { grid-template-columns: 1fr; }
  .tag-repair-stats { grid-template-columns: repeat(2, 1fr); max-width: 100%; }
  .jobs-filters { width: 100%; }
  /* 详情弹窗手机端:统计行距收紧、路径等长文本可断行,防压叠 */
  .detail-head { flex-direction: column; align-items: flex-start; }
  .detail-counts { gap: 6px 12px; }
  .mono { word-break: break-all; }
}
</style>
