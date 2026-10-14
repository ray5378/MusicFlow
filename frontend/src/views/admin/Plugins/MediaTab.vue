<template>
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
        <el-button size="small" type="primary" @click="goMarket()">{{ t('admin.plugins.goMarket') }}</el-button>
      </el-empty>
    </div>
    <div v-else class="mf-media">
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.sourcePlugin') }}</span>
        <span class="field-hint">{{ t('admin.plugins.lyricsProviderPriorityHint') }}</span>
      </div>
      <SourcePriorityList :model-value="lyricsSettings.providerPriority" :options="lyricProviderOptions" :available-values="lyricProviderAvailable" @update:model-value="onLyricsPriorityChange" />
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
        <el-button size="small" type="primary" @click="goMarket()">{{ t('admin.plugins.goMarket') }}</el-button>
      </el-empty>
    </div>
    <div v-else class="mf-media">
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.sourcePlugin') }}</span>
        <span class="field-hint">{{ t('admin.plugins.coversProviderPriorityHint') }}</span>
      </div>
      <SourcePriorityList :model-value="coversSettings.providerPriority" :options="coverProviderOptions" :available-values="coverProviderAvailable" @update:model-value="onCoversPriorityChange" />
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

  <el-card class="mf-card" shadow="never">
    <template #header>
      <div class="card-head">
        <span class="card-title">{{ t('admin.plugins.streamSourcePriority') }}</span>
      </div>
    </template>
    <div class="mf-media">
      <div class="mf-media-row">
        <span class="field-hint">{{ t('admin.plugins.streamSourcePriorityHint') }}</span>
      </div>
      <SourcePriorityList :model-value="streamSourcePriority" :options="availableStreamSources" @update:model-value="onStreamPriorityChange" />
    </div>
  </el-card>

  <el-card class="mf-card" shadow="never">
    <template #header>
      <div class="card-head">
        <span class="card-title">{{ t('admin.plugins.prefetchSettings') }}</span>
      </div>
    </template>
    <div class="mf-media">
      <div class="mf-media-row">
        <span class="field-hint">{{ t('admin.plugins.prefetchSettingsHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchSectionPrefetch') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchLookahead') }}</span>
        <el-input-number v-model="prefetchSettings.lookahead" v-bind="specRange('lookahead')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchLookaheadHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchConcurrency') }}</span>
        <el-input-number v-model="prefetchSettings.concurrency" v-bind="specRange('concurrency')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchConcurrencyHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchBudgetRatio') }}</span>
        <el-input-number v-model="prefetchSettings.budgetRatio" v-bind="specRange('budgetRatio')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchBudgetRatioHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchDeadlineSec') }}</span>
        <el-input-number v-model="prefetchSettings.deadlineSec" v-bind="specRange('deadlineSec')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchDeadlineSecHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchStallSec') }}</span>
        <el-input-number v-model="prefetchSettings.stallSec" v-bind="specRange('stallSec')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchStallSecHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchEntryTtlSec') }}</span>
        <el-input-number v-model="prefetchSettings.entryTtlSec" v-bind="specRange('entryTtlSec')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchEntryTtlSecHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchMaxAltSources') }}</span>
        <el-input-number v-model="prefetchSettings.maxAltSources" v-bind="specRange('maxAltSources')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchMaxAltSourcesHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchSectionJudge') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchIntegrityEnabled') }}</span>
        <el-switch v-model="prefetchSettings.integrityEnabled" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchIntegrityEnabledHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchIntegrityDeltaSec') }}</span>
        <el-input-number v-model="prefetchSettings.integrityDeltaSec" v-bind="specRange('integrityDeltaSec')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchIntegrityDeltaSecHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchIntegrityBitrateDeltaSec') }}</span>
        <el-input-number v-model="prefetchSettings.integrityBitrateDeltaSec" v-bind="specRange('integrityBitrateDeltaSec')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchIntegrityBitrateDeltaSecHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.prefetchMinAudioKB') }}</span>
        <el-input-number v-model="prefetchSettings.minAudioKB" v-bind="specRange('minAudioKB')" size="small" controls-position="right" @change="savePrefetchSettings" />
        <span class="field-hint">{{ t('admin.plugins.prefetchMinAudioKBHint') }}</span>
      </div>
    </div>
  </el-card>

  <!-- 起播 TTFB 金丝雀探针(默认关;开不开用户定,开启需先钉死一首网络源歌曲) -->
  <el-card class="mf-card" shadow="never">
    <template #header>
      <div class="card-head">
        <span class="card-title">{{ t('admin.plugins.probeSettings') }}</span>
      </div>
    </template>
    <div class="mf-media">
      <div class="mf-media-row">
        <span class="field-hint">{{ t('admin.plugins.probeSettingsHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.probeEnabled') }}</span>
        <el-switch v-model="probeSettings.enabled" :loading="savingProbe" @change="onProbeToggle" />
        <span class="field-hint">{{ t('admin.plugins.probeEnabledHint') }}</span>
      </div>
      <div class="mf-media-row">
        <span class="mf-media-label">{{ t('admin.plugins.probeSong') }}</span>
        <el-button size="small" @click="openProbeSongPicker">{{ t('admin.plugins.probePickSong') }}</el-button>
        <span class="field-hint">{{ probeSongText }}</span>
      </div>
      <div class="mf-media-row" v-if="probeSnapshot">
        <span class="mf-media-label">{{ t('admin.plugins.probeStatus') }}</span>
        <el-tag size="small" :type="probeHealthType" effect="dark">{{ t('admin.plugins.probeHealth.' + (probeSnapshot.health || 'unknown')) }}</el-tag>
        <span class="field-hint">{{ probeStatusText }}</span>
      </div>
      <div class="mf-media-row" v-if="probeSnapshot && (probeSnapshot.lastTtfbMs != null || probeSnapshot.samples)">
        <span class="mf-media-label">{{ t('admin.plugins.probeTtfb') }}</span>
        <span class="field-hint">
          {{ t('admin.plugins.probeTtfbRecent') }} {{ probeSnapshot.lastTtfbMs == null ? '-' : probeSnapshot.lastTtfbMs + 'ms' }}
          · p50 {{ probeSnapshot.p50Ms == null ? '-' : probeSnapshot.p50Ms + 'ms' }}
          · p95 {{ probeSnapshot.p95Ms == null ? '-' : probeSnapshot.p95Ms + 'ms' }}
          · {{ t('admin.plugins.probeSamples') }} {{ probeSnapshot.samples }}
        </span>
      </div>
      <div class="mf-media-row" v-if="probeSnapshot && probeSnapshot.lastSkipReason">
        <span class="mf-media-label">{{ t('admin.plugins.probeSkip') }}</span>
        <span class="field-hint">{{ t('admin.plugins.probeSkipReason.' + probeSnapshot.lastSkipReason) }}</span>
      </div>
      <div class="mf-media-row" v-if="probeSnapshot && probeSnapshot.enabled">
        <span class="mf-media-label">{{ t('admin.plugins.probeCounts') }}</span>
        <span class="field-hint">
          ok {{ probeSnapshot.counts.ok }} · fail {{ probeSnapshot.counts.fail }} · skip {{ probeSnapshot.counts.skip }}
          · {{ t('admin.plugins.probeInterval') }} {{ Math.round(probeSnapshot.intervalMs / 60000) }}min
        </span>
      </div>
    </div>
  </el-card>

  <div class="mf-actions">
    <el-button type="primary" :loading="savingMedia" @click="saveAllMedia">{{ t('admin.plugins.saveSettings') }}</el-button>
    <span class="field-hint">{{ t('admin.plugins.saveSettingsHint') }}</span>
  </div>
</template>

<script setup lang="ts">
import SourcePriorityList from "@/components/SourcePriorityList.vue";

defineProps<{
  t: (key: string, ...args: any[]) => string;
  lyricProviderPlugins: any[];
  coverProviderPlugins: any[];
  goMarket: () => void;
  lyricsSettings: any;
  coversSettings: any;
  lyricProviderOptions: any[];
  coverProviderOptions: any[];
  lyricProviderAvailable: string[];
  coverProviderAvailable: string[];
  onLyricsPriorityChange: (v: string[]) => void;
  onCoversPriorityChange: (v: string[]) => void;
  saveMediaSettings: (kind: "lyrics" | "covers") => void;
  lyricsBackfill: any;
  coversBackfill: any;
  startBackfill: (kind: "lyrics" | "covers") => void;
  backfillText: (kind: "lyrics" | "covers") => string;
  streamSourcePriority: string[];
  availableStreamSources: any[];
  onStreamPriorityChange: (v: string[]) => void;
  prefetchSettings: any;
  specRange: (k: string) => { min: number; max: number; step: number };
  savePrefetchSettings: () => void;
  probeSettings: any;
  savingProbe: boolean;
  onProbeToggle: (val: any) => void;
  openProbeSongPicker: () => void;
  probeSongText: string;
  probeSnapshot: any;
  probeHealthType: any;
  probeStatusText: string;
  savingMedia: boolean;
  saveAllMedia: () => void;
}>();
</script>

<style lang="scss" scoped>
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.page-sub { font-size: 13px; color: var(--el-text-color-secondary); }
.mf-card { margin-bottom: 20px; }
.mf-actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
.mf-card .card-title { font-size: 15px; font-weight: 600; color: var(--el-text-color-primary); }
.mf-empty { padding: 8px 0; }
.field-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; display: inline-block; max-width: 360px; }
.mf-media { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.mf-media-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mf-media-label { flex: 0 0 64px; font-size: 13px; color: var(--el-text-color-primary); }
.mf-media .field-hint { margin-left: 0; max-width: 340px; }

@media (max-width: 768px) {
  .page-header h2 { font-size: 24px; }
  /* 媒体获取行的固定宽控件在窄屏占满 */
  .mf-media-row .el-select { width: 100% !important; }
}
</style>
