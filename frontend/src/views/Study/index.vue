<template>
  <div class="study-page">
    <!-- ===== 页头 ===== -->
    <div class="page-header">
      <div class="page-title">
        <h2>{{ t("study.title") }}</h2>
        <span class="sub">{{ t("study.subtitle") }}</span>
      </div>
      <div class="header-actions" />
    </div>

    <div class="study-body">
      <section class="content-panel">
        <!-- 搜索入口与三个模块 Tab 同一排 -->
        <div class="tab-row">
          <el-tabs v-model="mode" class="content-tabs" @tab-change="onTabChange">
            <el-tab-pane :label="t('study.root')" name="dir" />
            <el-tab-pane :label="t('study.playlists')" name="playlists" />
            <el-tab-pane :label="t('study.continueLearning')" name="continue" />
            <el-tab-pane :label="t('study.recent')" name="recent" />
          </el-tabs>
          <el-input
            v-model="query"
            :placeholder="t('study.searchBothPlaceholder')"
            clearable
            class="search-input"
            @keyup.enter="doSearch"
            @clear="clearSearch"
          >
            <template #prefix><MfIcon name="Search" /></template>
          </el-input>
        </div>

        <!-- 学习歌单多选工具条:右键/长按「多选」后出现,可批量拖动或移动到文件夹 -->
        <div v-if="mode === 'playlists' && playlistSelection.size > 0" class="sel-bar">
          <span class="sel-count">{{ t("study.selected", { count: playlistSelection.size }) }}</span>
          <el-button size="small" type="primary" @click="openBatchMoveDialog">
            <MfIcon name="Folder" :size="14" />{{ t("study.moveToFolder") }}
          </el-button>
          <el-button size="small" type="danger" plain @click="deleteSelectedPlaylists">
            <MfIcon name="Trash2" :size="14" />{{ t("study.deleteSelected") }}
          </el-button>
          <el-button size="small" text @click="clearPlaylistSelection">{{ t("study.clearSelection") }}</el-button>
        </div>

        <!-- ===== 搜索 ===== -->
        <div v-if="searchResults !== null || playlistResults !== null" class="search-block">
          <div class="block-head">
            <span class="block-title">
              {{ t("study.unifiedSearchResult", { playlists: sortedPlaylists.length, songs: sortedSongs.length }) }}
            </span>
            <div class="search-sort">
              <span class="sort-label">{{ t("study.sortBy") }}</span>
              <el-select v-model="searchSort" size="small" class="sort-select">
                <el-option :label="t('study.sortPlaylistFirst')" value="playlist-first" />
                <el-option :label="t('study.sortContentFirst')" value="content-first" />
                <el-option :label="t('study.sortByName')" value="name" />
              </el-select>
              <el-button text size="small" @click="clearSearch">{{ t("study.clearSearch") }}</el-button>
            </div>
          </div>

          <div v-if="sortedPlaylists.length === 0 && sortedSongs.length === 0" class="empty">{{ t("study.noResult") }}</div>

          <!-- 歌单优先(默认):歌单组在内容组之前 -->
          <template v-if="playlistsFirst">
            <template v-if="sortedPlaylists.length > 0">
              <div class="result-subhead">{{ t("study.playlists") }} · {{ sortedPlaylists.length }}</div>
              <div class="playlist-grid">
                <div
                  v-for="p in sortedPlaylists"
                  :key="p.id"
                  class="playlist-card"
                  :class="{ selected: playlistSelection.has(p.id) }"
                  draggable="true"
                  @dragstart="onPlaylistDragStart(p, $event)"
                  @click="onSearchPlaylistClick(p)"
                  @contextmenu="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))"
                  v-longpress="() => openActionSheet(playlistMenuActions(p), p.name, playlistMeta(p))"
                >
                  <span class="pl-icon pl-play" :title="t('playlists.playAll')" @click.stop="playPlaylist(p)">
                    <MfIcon name="ListMusic" :size="22" class="ic-idle" />
                    <MfIcon name="Play" :size="22" class="ic-play" />
                  </span>
                  <div class="pl-info">
                    <div class="pl-name">{{ p.name }}</div>
                    <div class="pl-meta">{{ playlistMeta(p) }}</div>
                  </div>
                  <span class="card-more" :title="t('songTable.moreActions')" @click.stop="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))">
                    <MfIcon name="MoreHorizontal" :size="16" />
                  </span>
                </div>
              </div>
            </template>

            <template v-if="sortedSongs.length > 0">
              <div class="result-subhead">{{ t("study.searchContent") }} · {{ sortedSongs.length }}</div>
              <div class="study-list">
                <div
                  v-for="(s, i) in sortedSongs"
                  :key="s.id"
                  class="study-row"
                  @click="jumpToSongDir(s)"
                  @contextmenu="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')"
                  v-longpress="() => openActionSheet(songMenuActions(s), s.title, s.relDir || '')"
                >
                  <span class="row-play" :title="t('layout.play')" @click.stop="onSearchPlay(s, i)"><MfIcon name="Play" :size="14" /></span>
                  <span class="row-title">{{ s.title }}</span>
                  <span class="row-dir" :title="s.relDir || s.album || ''">{{ s.relDir || s.album || "—" }}</span>
                  <span class="row-dur">{{ fmtTime(s.duration) }}</span>
                  <span class="row-actions" @click.stop>
                    <span class="row-btn" :title="t('study.openDir')" @click="jumpToSongDir(s)">
                      <MfIcon name="Folder" :size="15" />
                    </span>
                    <span class="row-btn" :title="t('songTable.moreActions')" @click="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')">
                      <MfIcon name="MoreHorizontal" :size="15" />
                    </span>
                  </span>
                </div>
              </div>
            </template>
          </template>

          <!-- 内容优先 -->
          <template v-else>
            <template v-if="sortedSongs.length > 0">
              <div class="result-subhead">{{ t("study.searchContent") }} · {{ sortedSongs.length }}</div>
              <div class="study-list">
                <div
                  v-for="(s, i) in sortedSongs"
                  :key="s.id"
                  class="study-row"
                  @click="jumpToSongDir(s)"
                  @contextmenu="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')"
                  v-longpress="() => openActionSheet(songMenuActions(s), s.title, s.relDir || '')"
                >
                  <span class="row-play" :title="t('layout.play')" @click.stop="onSearchPlay(s, i)"><MfIcon name="Play" :size="14" /></span>
                  <span class="row-title">{{ s.title }}</span>
                  <span class="row-dir" :title="s.relDir || s.album || ''">{{ s.relDir || s.album || "—" }}</span>
                  <span class="row-dur">{{ fmtTime(s.duration) }}</span>
                  <span class="row-actions" @click.stop>
                    <span class="row-btn" :title="t('study.openDir')" @click="jumpToSongDir(s)">
                      <MfIcon name="Folder" :size="15" />
                    </span>
                    <span class="row-btn" :title="t('songTable.moreActions')" @click="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')">
                      <MfIcon name="MoreHorizontal" :size="15" />
                    </span>
                  </span>
                </div>
              </div>
            </template>

            <template v-if="sortedPlaylists.length > 0">
              <div class="result-subhead">{{ t("study.playlists") }} · {{ sortedPlaylists.length }}</div>
              <div class="playlist-grid">
                <div
                  v-for="p in sortedPlaylists"
                  :key="p.id"
                  class="playlist-card"
                  :class="{ selected: playlistSelection.has(p.id) }"
                  draggable="true"
                  @dragstart="onPlaylistDragStart(p, $event)"
                  @click="onSearchPlaylistClick(p)"
                  @contextmenu="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))"
                  v-longpress="() => openActionSheet(playlistMenuActions(p), p.name, playlistMeta(p))"
                >
                  <span class="pl-icon pl-play" :title="t('playlists.playAll')" @click.stop="playPlaylist(p)">
                    <MfIcon name="ListMusic" :size="22" class="ic-idle" />
                    <MfIcon name="Play" :size="22" class="ic-play" />
                  </span>
                  <div class="pl-info">
                    <div class="pl-name">{{ p.name }}</div>
                    <div class="pl-meta">{{ playlistMeta(p) }}</div>
                  </div>
                  <span class="card-more" :title="t('songTable.moreActions')" @click.stop="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))">
                    <MfIcon name="MoreHorizontal" :size="16" />
                  </span>
                </div>
              </div>
            </template>
          </template>
        </div>

        <!-- ===== 总目录（根层平铺学习源，进入后显示子目录） ===== -->
        <div v-else-if="mode === 'dir'" class="pane">
          <template v-if="!currentDir">
            <div class="block-head">
              <span class="block-title">{{ t("study.root") }}</span>
              <el-button text size="small" :loading="sourcesLoading" @click="loadSources">
                <MfIcon name="RefreshCw" :size="14" />
              </el-button>
            </div>
            <div v-if="sources.length === 0 && !sourcesLoading" class="folder-empty">
              <MfIcon name="FolderOpen" :size="28" />
              <p>{{ t("study.noSource") }}</p>
              <p class="hint">{{ t("study.noSourceHint") }}</p>
            </div>
            <div v-else class="folder-grid" v-loading="sourcesLoading">
              <div
                v-for="s in sources"
                :key="s.id"
                class="folder-card"
                @click="onSourceClick(s)"
                @contextmenu="openContextMenu($event, sourceMenuActions(s), s.name, t('study.trackCount', { count: s.songCount }))"
                v-longpress="() => openActionSheet(sourceMenuActions(s), s.name, t('study.trackCount', { count: s.songCount }))"
              >
                <div class="folder-icon"><MfIcon name="FolderOpen" :size="30" /></div>
                <div class="folder-info">
                  <div class="folder-name">{{ s.name }}</div>
                  <div class="folder-meta">{{ t("study.trackCount", { count: s.songCount }) }}</div>
                </div>
                <span class="card-more" :title="t('songTable.moreActions')" @click.stop="openContextMenu($event, sourceMenuActions(s), s.name, t('study.trackCount', { count: s.songCount }))">
                  <MfIcon name="MoreHorizontal" :size="16" />
                </span>
              </div>
            </div>
            <!-- 空白区域:右键 / 长按新建歌单 -->
            <div
              class="blank-zone"
              @contextmenu="onBlankContextMenu($event, false)"
              v-longpress="() => onBlankLongPress(false)"
            >{{ t("study.blankNewPlaylistHint") }}</div>
          </template>

          <template v-else>
            <div class="block-head">
              <nav class="crumb">
                <button type="button" class="crumb-home" @click="goRoot">
                  <MfIcon name="Home" :size="14" />
                  <span>{{ t("study.root") }}</span>
                </button>
                <MfIcon name="ChevronRight" :size="14" class="crumb-sep" />
                <button
                  type="button"
                  class="crumb-seg"
                  :class="{ current: crumbs.length === 0 }"
                  @click="jumpTo('')"
                >{{ currentDir?.sourceName }}</button>
                <template v-for="(c, i) in crumbs" :key="c.relDir">
                  <MfIcon name="ChevronRight" :size="14" class="crumb-sep" />
                  <button
                    type="button"
                    class="crumb-seg"
                    :class="{ current: i === crumbs.length - 1 }"
                    @click="jumpTo(c.relDir)"
                  >{{ c.label }}</button>
                </template>
              </nav>
              <el-button size="small" type="primary" :disabled="dirAudio.length === 0" :loading="resolving" @click="playDir(0)">
                <MfIcon name="Play" :size="14" />{{ t("music.playAll") }}
              </el-button>
            </div>
            <!-- 多选工具条:Windows 风格框选 / Ctrl 点选 / Shift 连选后批量加入歌单 -->
            <div v-if="selectedCount > 0" class="sel-bar">
              <span class="sel-count">{{ t("study.selected", { count: selectedCount }) }}</span>
              <el-button size="small" type="primary" @click="addSelectedToPlaylist">
                <MfIcon name="Plus" :size="14" />{{ t("study.addToPlaylist") }}
              </el-button>
              <el-button size="small" text @click="clearSelection">{{ t("study.clearSelection") }}</el-button>
            </div>
            <div v-else-if="dirAudio.length > 1" class="sel-hint">{{ t("study.multiSelectHint") }}</div>
            <div v-if="dirLoading" v-loading="true" class="empty"></div>
            <template v-else>
              <!-- 子目录:树里也能点,这里再给一排入口,避免「根目录只有文件夹」时误以为空 -->
              <div v-if="dirFolders.length > 0" class="folder-grid sub">
                <div
                  v-for="d in dirFolders"
                  :key="d.relPath"
                  class="folder-card"
                  @click="onFolderClick(d)"
                  @contextmenu="openContextMenu($event, folderMenuActions(d), d.name, d.relPath)"
                  v-longpress="() => openActionSheet(folderMenuActions(d), d.name, d.relPath)"
                >
                  <div class="folder-icon"><MfIcon name="FolderOpen" :size="26" /></div>
                  <div class="folder-info">
                    <div class="folder-name">{{ d.name }}</div>
                  </div>
                  <span class="card-more" :title="t('songTable.moreActions')" @click.stop="openContextMenu($event, folderMenuActions(d), d.name, d.relPath)">
                    <MfIcon name="MoreHorizontal" :size="16" />
                  </span>
                </div>
              </div>
              <div v-if="dirAudio.length === 0" class="empty">
                <MfIcon name="FolderOpen" :size="36" />
                <p>{{ dirFolders.length > 0 ? t("study.pickSubdir") : t("study.dirEmpty") }}</p>
              </div>
              <div v-else ref="listEl" class="study-list" @mousedown="onListMouseDown">
              <div
                v-for="(e, i) in dirAudio"
                :key="e.relPath"
                class="study-row"
                :data-relpath="e.relPath"
                :class="{ active: currentRowKey === dirKey(e), selected: selectedKeys.has(e.relPath) }"
                @click="onDirRowClick(i, $event)"
                @dblclick="onDirRowDblClick(i)"
                @contextmenu="onEntryContext($event, e, i)"
                v-longpress="() => openActionSheet(entryMenuActions(e, i), e.name, e.relPath)"
              >
                <span class="row-play" :title="t('layout.play')" @click.stop="playDir(i)">
                  <MfIcon :name="selectedKeys.has(e.relPath) ? 'Check' : 'Play'" :size="14" />
                </span>
                <span class="row-title">{{ e.name }}</span>
                <span class="row-progress">
                  <span class="bar"><span class="bar-in" :style="{ width: Math.round((e.progress || 0) * 100) + '%' }"></span></span>
                  <span class="pct-text">{{ e.finished ? t("study.finished") : Math.round((e.progress || 0) * 100) + "%" }}</span>
                </span>
                <span class="row-dur">{{ fmtTime(e.durationSec) }}</span>
                <span class="row-actions" @click.stop>
                  <span class="row-btn" :title="t('layout.addToPlaylist')" @click="addRowToPlaylist(e)">
                    <MfIcon name="Plus" :size="15" />
                  </span>
                  <span class="row-btn" :title="t('songTable.moreActions')" @click="openContextMenu($event, entryMenuActions(e, i), e.name, e.relPath)">
                    <MfIcon name="MoreHorizontal" :size="15" />
                  </span>
                </span>
              </div>
              </div>
            </template>
          </template>
        </div>

        <!-- ===== 学习歌单 ===== -->
        <div v-else-if="mode === 'playlists'" v-loading="loadingPlaylists" class="pane">
          <div class="block-head">
            <nav v-if="currentFolder" class="crumb">
              <button type="button" class="crumb-home" @click="currentFolder = ''">
                <MfIcon name="Home" :size="14" />
                <span>{{ t("study.playlists") }}</span>
              </button>
              <MfIcon name="ChevronRight" :size="14" class="crumb-sep" />
              <span class="crumb-seg current">{{ currentFolder }}</span>
            </nav>
            <span v-else class="block-title">{{ t("study.playlists") }}</span>
            <div class="block-actions">
              <el-button size="small" @click="openImportDialog">
                <MfIcon name="Upload" :size="14" />{{ t("study.importPlaylists") }}
              </el-button>
              <el-button size="small" :disabled="playlists.length === 0" @click="exportAllPlaylists">
                <MfIcon name="Download" :size="14" />{{ t("study.exportAll") }}
              </el-button>
              <el-button size="small" @click="createFolder">
                <MfIcon name="Folder" :size="14" />{{ t("study.newFolder") }}
              </el-button>
              <el-button size="small" type="primary" @click="createPlaylist">
                <MfIcon name="Plus" :size="14" />{{ t("study.newPlaylist") }}
              </el-button>
            </div>
          </div>

          <!-- 根层:文件夹 + 未归夹歌单 -->
          <template v-if="!currentFolder">
            <div v-if="folders.length > 0" class="folder-grid playlists">
              <div
                v-for="f in folders"
                :key="f"
                class="folder-card"
                :class="{ 'drop-active': dragOverFolder === f }"
                @click="currentFolder = f"
                @contextmenu="openContextMenu($event, playlistFolderMenuActions(f), f, t('study.folderPlaylistCount', { count: folderCount(f) }))"
                v-longpress="() => openActionSheet(playlistFolderMenuActions(f), f, t('study.folderPlaylistCount', { count: folderCount(f) }))"
                @dragover.prevent="dragOverFolder = f"
                @dragleave="onFolderDragLeave(f)"
                @drop.prevent="dropPlaylistOnFolder(f)"
              >
                <div class="folder-icon"><MfIcon name="FolderOpen" :size="26" /></div>
                <div class="folder-info">
                  <div class="folder-name">{{ f }}</div>
                  <div class="folder-meta">{{ t("study.folderPlaylistCount", { count: folderCount(f) }) }}</div>
                </div>
                <span class="card-more" :title="t('songTable.moreActions')" @click.stop="openContextMenu($event, playlistFolderMenuActions(f), f, t('study.folderPlaylistCount', { count: folderCount(f) }))">
                  <MfIcon name="MoreHorizontal" :size="16" />
                </span>
              </div>
            </div>
            <div v-if="rootPlaylists.length > 0" class="playlist-grid">
              <div
                v-for="p in rootPlaylists"
                :key="p.id"
                class="playlist-card"
                :class="{ selected: playlistSelection.has(p.id) }"
                draggable="true"
                @dragstart="onPlaylistDragStart(p, $event)"
                @click="onPlaylistCardClick(p)"
                @contextmenu="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))"
                v-longpress="() => openActionSheet(playlistMenuActions(p), p.name, playlistMeta(p))"
              >
                <span class="pl-icon pl-play" :title="t('playlists.playAll')" @click.stop="playPlaylist(p)">
                  <MfIcon name="ListMusic" :size="22" class="ic-idle" />
                  <MfIcon name="Play" :size="22" class="ic-play" />
                </span>
                <div class="pl-info">
                  <div class="pl-name">{{ p.name }}</div>
                  <div class="pl-meta">{{ playlistMeta(p) }}</div>
                </div>
                <span class="card-more" :title="t('songTable.moreActions')" @click.stop="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))">
                  <MfIcon name="MoreHorizontal" :size="16" />
                </span>
              </div>
            </div>
            <div v-if="!loadingPlaylists && folders.length === 0 && rootPlaylists.length === 0" class="empty">
              {{ t("study.playlistEmpty") }}
            </div>
          </template>

          <!-- 文件夹内部:可拖回根目录 -->
          <template v-else>
            <div
              class="folder-card root-drop"
              :class="{ 'drop-active': dragOverFolder === '__root__' }"
              @dragover.prevent="dragOverFolder = '__root__'"
              @dragleave="onFolderDragLeave('__root__')"
              @drop.prevent="dropPlaylistOnFolder('')"
            >
              <div class="folder-icon"><MfIcon name="Home" :size="24" /></div>
              <div class="folder-info">
                <div class="folder-name">{{ t("study.rootFolder") }}</div>
                <div class="folder-meta">{{ t("study.dropToRootHint") }}</div>
              </div>
            </div>
            <div v-if="currentFolderPlaylists.length === 0" class="empty">{{ t("study.folderEmpty") }}</div>
            <div v-else class="playlist-grid">
              <div
                v-for="p in currentFolderPlaylists"
                :key="p.id"
                class="playlist-card"
                :class="{ selected: playlistSelection.has(p.id) }"
                draggable="true"
                @dragstart="onPlaylistDragStart(p, $event)"
                @click="onPlaylistCardClick(p)"
                @contextmenu="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))"
                v-longpress="() => openActionSheet(playlistMenuActions(p), p.name, playlistMeta(p))"
              >
                <span class="pl-icon pl-play" :title="t('playlists.playAll')" @click.stop="playPlaylist(p)">
                  <MfIcon name="ListMusic" :size="22" class="ic-idle" />
                  <MfIcon name="Play" :size="22" class="ic-play" />
                </span>
                <div class="pl-info">
                  <div class="pl-name">{{ p.name }}</div>
                  <div class="pl-meta">{{ playlistMeta(p) }}</div>
                </div>
                <span class="card-more" :title="t('songTable.moreActions')" @click.stop="openContextMenu($event, playlistMenuActions(p), p.name, playlistMeta(p))">
                  <MfIcon name="MoreHorizontal" :size="16" />
                </span>
              </div>
            </div>
          </template>

          <!-- 空白区域:右键 / 长按新建歌单与文件夹 -->
          <div
            class="blank-zone"
            @contextmenu="onBlankContextMenu($event, true)"
            v-longpress="() => onBlankLongPress(true)"
          >{{ t("study.blankNewPlaylistHint") }}</div>
        </div>

        <!-- ===== 继续学习 ===== -->
        <div v-else-if="mode === 'continue'" v-loading="loadingContinue" class="pane">
          <div v-if="continueItems.length === 0" class="empty">
            <MfIcon name="BookOpen" :size="36" />
            <p>{{ t("study.continueEmpty") }}</p>
          </div>
          <div v-else class="study-list">
            <div
              v-for="(s, i) in continueItems"
              :key="s.id"
              class="study-row"
              @click="onResumeClick(i)"
              @contextmenu="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')"
              v-longpress="() => openActionSheet(songMenuActions(s), s.title, s.relDir || '')"
            >
              <span class="row-play"><MfIcon name="Play" :size="14" /></span>
              <span class="row-title">{{ s.title }}</span>
              <span class="row-dir" :title="s.relDir || s.album || ''">{{ s.relDir || s.album || "—" }}</span>
              <span class="row-progress">
                <span class="bar"><span class="bar-in" :style="{ width: pct(s) + '%' }"></span></span>
                <span class="pct-text">{{ pct(s) }}%</span>
              </span>
              <span class="row-dur">{{ fmtTime(s.positionSec) }} / {{ fmtTime(s.durationSec || s.duration) }}</span>
              <span class="row-actions" @click.stop>
                <span class="row-btn" :title="t('songTable.moreActions')" @click="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')">
                  <MfIcon name="MoreHorizontal" :size="15" />
                </span>
              </span>
            </div>
          </div>
        </div>

        <!-- ===== 最近添加 ===== -->
        <div v-else-if="mode === 'recent'" v-loading="loadingRecent" class="pane">
          <div class="block-head">
            <span class="block-title">{{ t("study.recent") }}</span>
            <el-button size="small" type="primary" :disabled="recentItems.length === 0" @click="playSongs(recentItems, 0)">
              <MfIcon name="Play" :size="14" />{{ t("music.playAll") }}
            </el-button>
          </div>
          <div v-if="recentItems.length === 0" class="empty">{{ t("study.recentEmpty") }}</div>
          <div v-else class="study-list">
            <div
              v-for="(s, i) in recentItems"
              :key="s.id"
              class="study-row"
              @click="onRecentClick(i)"
              @contextmenu="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')"
              v-longpress="() => openActionSheet(songMenuActions(s), s.title, s.relDir || '')"
            >
              <span class="row-play"><MfIcon name="Play" :size="14" /></span>
              <span class="row-title">{{ s.title }}</span>
              <span class="row-dir" :title="s.relDir || s.album || ''">{{ s.relDir || s.album || "—" }}</span>
              <span class="row-dur">{{ fmtTime(s.duration) }}</span>
              <span class="row-actions" @click.stop>
                <span class="row-btn" :title="t('songTable.moreActions')" @click="openContextMenu($event, songMenuActions(s), s.title, s.relDir || '')">
                  <MfIcon name="MoreHorizontal" :size="15" />
                </span>
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ===== 加入学习歌单 ===== -->
    <el-dialog v-model="addDialogOpen" :title="t('study.addToPlaylist')" width="420px">
      <div class="add-dialog">
        <el-select v-model="addPlaylistId" :placeholder="t('study.pickPlaylist')" class="add-select" :loading="loadingPlaylists">
          <el-option v-for="p in playlists" :key="p.id" :label="`${p.name} (${p.songCount})`" :value="p.id" />
        </el-select>
        <el-input v-model="newPlaylistName" :placeholder="t('study.orNewPlaylist')" class="add-new" />
      </div>
      <template #footer>
        <el-button @click="addDialogOpen = false">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :loading="adding" @click="confirmAdd">{{ t("common.confirm") }}</el-button>
      </template>
    </el-dialog>

    <!-- ===== 移动歌单到文件夹 ===== -->
    <el-dialog
      v-model="moveDialogOpen"
      :title="moveDialogTitle"
      width="420px"
    >
      <div class="add-dialog">
        <el-select v-model="moveFolder" :placeholder="t('study.pickFolder')" class="add-select">
          <el-option :label="t('study.rootFolder')" value="" />
          <el-option v-for="f in folders" :key="f" :label="f" :value="f" />
        </el-select>
        <el-input v-model="moveNewFolder" :placeholder="t('study.orNewFolder')" class="add-new" />
      </div>
      <template #footer>
        <el-button @click="moveDialogOpen = false">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :loading="moving" @click="confirmMove">{{ t("common.confirm") }}</el-button>
      </template>
    </el-dialog>

    <!-- ===== 导入学习歌单 ===== -->
    <el-dialog v-model="importDialogOpen" :title="t('study.importPlaylists')" width="520px" :append-to-body="true">
      <el-alert type="info" :closable="false" show-icon class="import-hint">
        {{ t("study.importHint") }}
      </el-alert>
      <el-upload
        drag
        class="import-upload"
        :auto-upload="false"
        :limit="1"
        accept=".json,application/json"
        :on-change="onImportFileChange"
        :on-remove="clearImportFile"
        :file-list="importFileList"
      >
        <el-icon class="el-icon--upload"><MfIcon name="Upload" :size="36" /></el-icon>
        <div class="el-upload__text">{{ t("study.importDragText") }}<em>{{ t("study.importDragClick") }}</em></div>
      </el-upload>
      <template #footer>
        <el-button @click="importDialogOpen = false">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :loading="importing" :disabled="!importFile" @click="confirmImport">
          {{ t("study.importAction") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 拖拽框选矩形(Windows 资源管理器风格) -->
    <div v-if="marquee.active" class="marquee" :style="marqueeStyle"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { Play, Folder, RefreshCw, ListMusic, Plus, Info, Pencil, Trash2, Download, Check } from "lucide-vue-next";
import api from "@/api";
import { usePlayerStore } from "@/stores/player";
import { useItemActions, type MenuAction } from "@/composables/useItemActions";
import {
  type StudyDirEntry,
  type StudyPlaylist,
  type StudyPlaylistExportFile,
  type StudySong,
  type StudySource,
  addStudyPlaylistTracks,
  createStudyPlaylist,
  createStudyPlaylistFolder,
  deleteStudyPlaylist,
  deleteStudyPlaylistFolder,
  fetchContinueLearning,
  fetchRecentStudy,
  fetchStudyDir,
  fetchStudyPlaylistTracks,
  fetchStudyPlaylists,
  fetchStudySources,
  importStudyPlaylists,
  refreshStudySource,
  renameStudyPlaylistFolder,
  resolveStudyFiles,
  searchStudy,
  updateStudyPlaylist,
} from "@/api/study";

const { t } = useI18n();
const router = useRouter();
const playerStore = usePlayerStore();
const { openContextMenu, openActionSheet, menuGuard, openSongInfo } = useItemActions();

// ==================== 学习源目录(平铺文件夹) ====================
const sources = ref<StudySource[]>([]);
const sourcesLoading = ref(false);
const currentDir = ref<{ sourceId: string; sourceName: string; relDir: string } | null>(null);

async function loadSources() {
  sourcesLoading.value = true;
  try { sources.value = await fetchStudySources(); } catch { sources.value = []; }
  finally { sourcesLoading.value = false; }
}

function openSource(s: StudySource) {
  currentDir.value = { sourceId: s.id, sourceName: s.name, relDir: "" };
  mode.value = "dir";
  loadDir();
}

async function refreshSource(s: StudySource) {
  try {
    await refreshStudySource(s.id);
    await loadSources();
    if (currentDir.value?.sourceId === s.id) await loadDir();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  }
}

// ==================== 目录章节 ====================
const dirEntries = ref<StudyDirEntry[]>([]);
const dirLoading = ref(false);
const resolving = ref(false);
const currentRowKey = ref("");
const dirAudio = computed(() => dirEntries.value.filter((e) => !e.isDir));
/** 部分 WebDAV 服务会把目录自身也放进 PROPFIND 结果;这里按 relPath 再做一次兜底过滤。 */
const dirFolders = computed(() =>
  dirEntries.value.filter((e) => e.isDir && e.relPath !== (currentDir.value?.relDir || "")),
);

// ==================== 多选(Windows 风格) ====================
const selectedKeys = ref<Set<string>>(new Set());
const anchorKey = ref("");
const listEl = ref<HTMLElement | null>(null);
const marquee = ref({ active: false, startX: 0, startY: 0, x: 0, y: 0 });
const selectedEntries = computed(() => dirAudio.value.filter((e) => selectedKeys.value.has(e.relPath)));
const selectedCount = computed(() => selectedEntries.value.length);
const marqueeStyle = computed(() => {
  const m = marquee.value;
  return {
    left: `${Math.min(m.startX, m.x)}px`,
    top: `${Math.min(m.startY, m.y)}px`,
    width: `${Math.abs(m.x - m.startX)}px`,
    height: `${Math.abs(m.y - m.startY)}px`,
  };
});
let dragStart: { x: number; y: number; additive: boolean; base: Set<string> } | null = null;
let suppressClickAt = 0;

function setSelection(next: Set<string>) {
  selectedKeys.value = next;
}
function clearSelection() {
  if (selectedKeys.value.size === 0) return;
  setSelection(new Set());
  anchorKey.value = "";
}
function selectOnly(key: string) {
  const next = new Set<string>();
  if (key) next.add(key);
  setSelection(next);
  anchorKey.value = key;
}
function toggleKey(key: string) {
  const next = new Set(selectedKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  setSelection(next);
  anchorKey.value = key;
}
function selectRange(key: string) {
  const keys = dirAudio.value.map((e) => e.relPath);
  const a = keys.indexOf(anchorKey.value);
  const b = keys.indexOf(key);
  if (a < 0 || b < 0) return selectOnly(key);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const next = new Set(selectedKeys.value);
  for (let i = lo; i <= hi; i++) next.add(keys[i]);
  setSelection(next);
}

function onListMouseDown(ev: MouseEvent) {
  if (ev.button !== 0 || ev.shiftKey) return;
  const target = ev.target as HTMLElement;
  if (target.closest(".row-btn")) return;
  dragStart = {
    x: ev.clientX,
    y: ev.clientY,
    additive: ev.ctrlKey || ev.metaKey,
    base: new Set(selectedKeys.value),
  };
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd, { once: true });
}

function onDragMove(ev: MouseEvent) {
  if (!dragStart) return;
  const dx = ev.clientX - dragStart.x;
  const dy = ev.clientY - dragStart.y;
  if (!marquee.value.active) {
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    marquee.value = { active: true, startX: dragStart.x, startY: dragStart.y, x: ev.clientX, y: ev.clientY };
    document.body.style.userSelect = "none";
  } else {
    marquee.value = { ...marquee.value, x: ev.clientX, y: ev.clientY };
  }
  updateMarqueeSelection();
}

function updateMarqueeSelection() {
  if (!listEl.value || !dragStart) return;
  const m = marquee.value;
  const left = Math.min(m.startX, m.x);
  const top = Math.min(m.startY, m.y);
  const right = Math.max(m.startX, m.x);
  const bottom = Math.max(m.startY, m.y);
  const next = new Set<string>(dragStart.additive ? dragStart.base : []);
  listEl.value.querySelectorAll<HTMLElement>("[data-relpath]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
      const key = el.getAttribute("data-relpath");
      if (key) next.add(key);
    }
  });
  setSelection(next);
}

function onDragEnd() {
  window.removeEventListener("mousemove", onDragMove);
  document.body.style.userSelect = "";
  if (marquee.value.active) {
    suppressClickAt = Date.now() + 300;
    marquee.value = { active: false, startX: 0, startY: 0, x: 0, y: 0 };
  }
  dragStart = null;
}

function onDirRowClick(i: number, ev: MouseEvent) {
  if (Date.now() < suppressClickAt || menuGuard()) return;
  const key = dirAudio.value[i]?.relPath;
  if (!key) return;
  if (ev.shiftKey) selectRange(key);
  else if (ev.ctrlKey || ev.metaKey) toggleKey(key);
  else selectOnly(key);
}

function onDirRowDblClick(i: number) {
  if (Date.now() < suppressClickAt) return;
  playDir(i);
}

function onEntryContext(ev: MouseEvent, e: StudyDirEntry, i: number) {
  // Windows 行为:右键未选中项时先改为单选该项;右键已选中项则保留整组选择。
  if (!selectedKeys.value.has(e.relPath)) selectOnly(e.relPath);
  openContextMenu(ev, entryMenuActions(e, i), e.name, e.relPath);
}

function onWindowKeydown(ev: KeyboardEvent) {
  if (mode.value !== "dir" || !currentDir.value) return;
  if (ev.key === "Escape") {
    clearSelection();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    ev.preventDefault();
    setSelection(new Set(dirAudio.value.map((e) => e.relPath)));
  }
}
/** 面包屑:源根之后的每一级目录(累计 relDir,用于点击跳转)。 */
const crumbs = computed(() => {
  const segs = currentDir.value?.relDir ? currentDir.value.relDir.split("/").filter(Boolean) : [];
  const out: Array<{ label: string; relDir: string }> = [];
  let acc = "";
  for (const seg of segs) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push({ label: seg, relDir: acc });
  }
  return out;
});

async function loadDir() {
  if (!currentDir.value) return;
  // 连续点树节点时,先发的请求可能后到;用序号丢弃过期响应,避免目录内容被旧结果覆盖。
  const seq = ++dirReqSeq;
  dirLoading.value = true;
  try {
    const items = await fetchStudyDir(currentDir.value.sourceId, currentDir.value.relDir);
    if (seq !== dirReqSeq) return;
    dirEntries.value = items;
    // 换目录后旧的 relPath 已失效,直接清空选择。
    clearSelection();
  } catch (e: any) {
    if (seq !== dirReqSeq) return;
    dirEntries.value = [];
    ElMessage.error(e?.response?.data?.error || t("study.loadDirFailed"));
  } finally {
    if (seq === dirReqSeq) dirLoading.value = false;
  }
}

let dirReqSeq = 0;

function enterSubdir(d: StudyDirEntry) {
  if (!currentDir.value) return;
  currentDir.value = { ...currentDir.value, relDir: d.relPath };
  loadDir();
}

/** 面包屑跳转:relDir 为 "" 表示回到源根。 */
function jumpTo(relDir: string) {
  if (!currentDir.value || currentDir.value.relDir === relDir) return;
  currentDir.value = { ...currentDir.value, relDir };
  loadDir();
}

/** 面包屑首级「总目录」:回到所有学习源平铺的根层。 */
function goRoot() {
  clearSearch();
  currentDir.value = null;
  dirEntries.value = [];
  currentRowKey.value = "";
  mode.value = "dir";
  loadSources();
}

function dirKey(e: StudyDirEntry) {
  return `${currentDir.value?.sourceId}:${e.relPath}`;
}

/** 播放某目录:整目录一次批量入库(已有 songId 的直接命中),再按顺序入队。 */
async function playDir(index: number) {
  if (!currentDir.value || dirAudio.value.length === 0 || resolving.value) return;
  const audio = dirAudio.value;
  resolving.value = true;
  try {
    const paths = audio.map((e) => e.relPath);
    const results = await resolveStudyFiles(currentDir.value.sourceId, paths);
    const songs: StudySong[] = [];
    const songByPath = new Map<string, StudySong>();
    for (const r of results) {
      if (r.song) { songs.push(r.song); songByPath.set(r.path, r.song); }
    }
    if (songs.length === 0) {
      ElMessage.error(t("study.resolveFailed"));
      return;
    }
    if (songs.length < paths.length) ElMessage.warning(t("study.partialResolved", { ok: songs.length, total: paths.length }));
    // 顺序按目录条目排(批量结果已按入参顺序返回,但仍按 relPath 对齐,避免乱序)
    const ordered = audio.map((e) => songByPath.get(e.relPath)).filter(Boolean) as StudySong[];
    const target = ordered[Math.min(index, ordered.length - 1)];
    const startIndex = Math.max(0, ordered.findIndex((s) => s.id === target?.id));
    playSongs(ordered, startIndex, audio[index]?.positionSec || 0);
    currentRowKey.value = dirKey(audio[index]);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("study.resolveFailed"));
  } finally {
    resolving.value = false;
  }
}

/** 播放另一个子目录(右键「播放此目录」):先列目录,再整目录点播。 */
async function playFolder(d: StudyDirEntry) {
  if (!currentDir.value || resolving.value) return;
  const src = currentDir.value.sourceId;
  resolving.value = true;
  try {
    const items = await fetchStudyDir(src, d.relPath);
    const audio = items.filter((e) => !e.isDir);
    if (audio.length === 0) {
      ElMessage.warning(t("study.dirEmpty"));
      return;
    }
    const results = await resolveStudyFiles(src, audio.map((e) => e.relPath));
    const songs = results.map((r) => r.song).filter(Boolean) as StudySong[];
    if (songs.length === 0) {
      ElMessage.error(t("study.resolveFailed"));
      return;
    }
    if (songs.length < audio.length) ElMessage.warning(t("study.partialResolved", { ok: songs.length, total: audio.length }));
    playSongs(songs, 0);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("study.resolveFailed"));
  } finally {
    resolving.value = false;
  }
}

function playSongs(songs: StudySong[], index = 0, startSec = 0) {
  if (!songs.length) return;
  playerStore.playQueue(songs, Math.max(0, Math.min(index, songs.length - 1)));
  if (startSec > 3) {
    const target = startSec;
    // 首次点播要等 howl 建立后再按 timeOffset 重拉定位。
    setTimeout(() => playerStore.seek(target), 400);
  }
}

// ==================== 右键 / 长按菜单 ====================
function sourceMenuActions(s: StudySource): MenuAction[] {
  return [
    { label: t("study.open"), icon: Folder, onClick: () => openSource(s) },
    { label: t("common.refresh"), icon: RefreshCw, onClick: () => refreshSource(s) },
  ];
}

function folderMenuActions(d: StudyDirEntry): MenuAction[] {
  return [
    { label: t("study.open"), icon: Folder, onClick: () => enterSubdir(d) },
    { label: t("study.playFolder"), icon: Play, onClick: () => playFolder(d) },
    { label: t("study.addToPlaylist"), icon: Plus, onClick: () => addFolderToPlaylist(d) },
  ];
}

function entryMenuActions(e: StudyDirEntry, index: number): MenuAction[] {
  const multi = selectedKeys.value.has(e.relPath) && selectedCount.value > 1;
  return [
    { label: t("layout.play"), icon: Play, onClick: () => playDir(index) },
    { label: t("actions.addToQueue"), icon: ListMusic, onClick: () => queueEntry(e) },
    {
      label: multi ? t("study.addSelectedToPlaylist", { count: selectedCount.value }) : t("study.addToPlaylist"),
      icon: Plus,
      onClick: () => addRowToPlaylist(e),
    },
    { divider: true },
    { label: t("actions.songInfo"), icon: Info, onClick: () => showEntryInfo(e) },
  ];
}

function songMenuActions(s: StudySong): MenuAction[] {
  return [
    { label: t("layout.play"), icon: Play, onClick: () => playSongs([s], 0, s.positionSec || 0) },
    { label: t("actions.addToQueue"), icon: ListMusic, onClick: () => addSongToQueue(s) },
    { label: t("layout.addToPlaylist"), icon: Plus, onClick: () => openAddSong(s) },
    { divider: true },
    { label: t("actions.songInfo"), icon: Info, onClick: () => openSongInfo(s) },
  ];
}

function playlistMenuActions(p: StudyPlaylist): MenuAction[] {
  return [
    { label: t("playlists.playAll"), icon: Play, onClick: () => playPlaylist(p) },
    { label: t("playlists.viewPlaylist"), icon: Folder, onClick: () => openPlaylist(p) },
    { label: t("study.exportPlaylist"), icon: Download, onClick: () => exportPlaylist(p) },
    ...(playlistSelection.value.size === 0
      ? [{ label: t("study.multiSelect"), icon: Check, onClick: () => enterPlaylistSelection(p) }]
      : []),
    { divider: true },
    { label: t("study.moveToFolder"), icon: Folder, onClick: () => openMoveDialog(p) },
    ...(p.folder
      ? [{ label: t("study.removeFromFolder"), icon: Folder, onClick: () => movePlaylistToFolder(p, "") }]
      : []),
    { label: t("playlists.rename"), icon: Pencil, onClick: () => renamePlaylist(p) },
    { label: t("playlists.deletePlaylist"), icon: Trash2, danger: true, onClick: () => removePlaylist(p) },
  ];
}

function playlistFolderMenuActions(name: string): MenuAction[] {
  return [
    { label: t("playlists.rename"), icon: Pencil, onClick: () => renameFolder(name) },
    { label: t("study.deleteFolder"), icon: Trash2, danger: true, onClick: () => removeFolder(name) },
  ];
}

async function queueEntry(e: StudyDirEntry) {
  const src = currentDir.value?.sourceId;
  if (!src) return;
  try {
    const results = await resolveStudyFiles(src, [e.relPath]);
    const song = results[0]?.song;
    if (!song) { ElMessage.error(t("study.resolveFailed")); return; }
    playerStore.addToQueue(song);
    ElMessage.success(t("actions.addedToQueue"));
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || t("common.operationFailed"));
  }
}

function addSongToQueue(s: StudySong) {
  playerStore.addToQueue(s);
  ElMessage.success(t("actions.addedToQueue"));
}

function showEntryInfo(e: StudyDirEntry) {
  const relDir = e.relPath.includes("/") ? e.relPath.slice(0, e.relPath.lastIndexOf("/")) : "";
  openSongInfo({
    id: e.songId || "",
    title: e.name,
    album: relDir || currentDir.value?.sourceName || "",
    duration: e.durationSec || 0,
    kind: "study",
  });
}

// ==================== 继续学习 / 最近添加 ====================
const mode = ref<"dir" | "playlists" | "continue" | "recent">("dir");
const continueItems = ref<StudySong[]>([]);
const loadingContinue = ref(false);
const recentItems = ref<StudySong[]>([]);
const loadingRecent = ref(false);

async function loadContinue() {
  loadingContinue.value = true;
  try { continueItems.value = await fetchContinueLearning(30); } catch { continueItems.value = []; }
  finally { loadingContinue.value = false; }
}
async function loadRecent() {
  loadingRecent.value = true;
  try { recentItems.value = await fetchRecentStudy(100); } catch { recentItems.value = []; }
  finally { loadingRecent.value = false; }
}
function resume(index: number) {
  const s = continueItems.value[index];
  if (!s) return;
  playSongs([s], 0, s.positionSec || 0);
}
function onTabChange(name: any) {
  searchResults.value = null;
  playlistResults.value = null;
  clearPlaylistSelection();
  if (name === "continue") loadContinue();
  else if (name === "recent") loadRecent();
  else if (name === "playlists") loadPlaylists();
  else if (name === "dir" && currentDir.value && dirEntries.value.length === 0) loadDir();
}

// ==================== 搜索(内容 + 歌单统一) ====================
const query = ref("");
const searchResults = ref<StudySong[] | null>(null);
const playlistResults = ref<StudyPlaylist[] | null>(null);
/** 搜索结果排序:默认歌单在前,可切换内容在前或按名称。 */
const searchSort = ref<"playlist-first" | "content-first" | "name">("playlist-first");
const playlistsFirst = computed(() => searchSort.value !== "content-first");
const sortedPlaylists = computed(() => {
  const list = playlistResults.value || [];
  if (searchSort.value !== "name") return list;
  return [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
});
const sortedSongs = computed(() => {
  const list = searchResults.value || [];
  if (searchSort.value !== "name") return list;
  return [...list].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
});
async function doSearch() {
  const q = query.value.trim();
  if (!q) return;
  // 统一搜索:一次同时查学习内容与学习歌单,结果分组展示。
  const [songs, playlists] = await Promise.all([
    searchStudy(q, 100).catch(() => [] as StudySong[]),
    fetchStudyPlaylists(q).catch(() => ({ items: [] as StudyPlaylist[], folders: [] as string[] })),
  ]);
  searchResults.value = songs;
  playlistResults.value = playlists.items;
}
function clearSearch() {
  query.value = "";
  searchResults.value = null;
  playlistResults.value = null;
}

/** 内容结果:点击跳转到该文件所在目录(总目录内定位)。 */
async function jumpToSongDir(s: StudySong) {
  const sourceId = s.sourceId || "";
  if (!sourceId) return;
  let sourceName = sources.value.find((x) => x.id === sourceId)?.name || "";
  if (!sourceName) {
    await loadSources();
    sourceName = sources.value.find((x) => x.id === sourceId)?.name || "";
  }
  clearSearch();
  mode.value = "dir";
  currentDir.value = { sourceId, sourceName, relDir: s.relDir || "" };
  await loadDir();
}

/** 歌单结果:点击跳转到该歌单所在的学习歌单文件夹。 */
function jumpToPlaylistFolder(p: StudyPlaylist) {
  clearSearch();
  mode.value = "playlists";
  currentFolder.value = p.folder || "";
  loadPlaylists();
}

function onSearchPlaylistClick(p: StudyPlaylist) {
  if (menuGuard()) return;
  if (playlistSelection.value.size > 0) {
    const next = new Set(playlistSelection.value);
    if (next.has(p.id)) next.delete(p.id);
    else next.add(p.id);
    playlistSelection.value = next;
    return;
  }
  jumpToPlaylistFolder(p);
}

/** 内容结果的播放按钮:只播这一条,不影响结果列表。 */
function onSearchPlay(s: StudySong, _index: number) {
  playSongs([s], 0);
}

// ==================== 学习歌单 ====================
const playlists = ref<StudyPlaylist[]>([]);
const folders = ref<string[]>([]);
const loadingPlaylists = ref(false);
const currentFolder = ref("");
const rootPlaylists = computed(() => playlists.value.filter((p) => !p.folder));
const currentFolderPlaylists = computed(() =>
  playlists.value.filter((p) => (p.folder || "") === currentFolder.value),
);
function folderCount(name: string) {
  return playlists.value.filter((p) => p.folder === name).length;
}
function playlistMeta(p: StudyPlaylist) {
  return p.folder
    ? `${t("study.trackCount", { count: p.songCount })} · ${p.folder}`
    : t("study.trackCount", { count: p.songCount });
}
async function loadPlaylists() {
  loadingPlaylists.value = true;
  try {
    const res = await fetchStudyPlaylists();
    playlists.value = res.items;
    folders.value = res.folders;
    if (currentFolder.value && !res.folders.includes(currentFolder.value)) currentFolder.value = "";
  } catch {
    playlists.value = [];
    folders.value = [];
  } finally {
    loadingPlaylists.value = false;
  }
}
async function createPlaylist() {
  try {
    const { value } = await ElMessageBox.prompt(t("study.newPlaylistTip"), t("study.newPlaylist"), {
      confirmButtonText: t("common.confirm"), cancelButtonText: t("common.cancel"),
      inputPlaceholder: t("study.playlistNamePlaceholder"),
      inputValidator: (v: string) => (String(v || "").trim() ? true : t("study.nameRequired")),
    });
    // 在文件夹视图里新建时,直接归入当前文件夹。
    await createStudyPlaylist(String(value).trim(), currentFolder.value);
    await loadPlaylists();
    ElMessage.success(t("study.playlistCreated"));
  } catch { /* 取消 */ }
}

async function createFolder() {
  try {
    const { value } = await ElMessageBox.prompt(t("study.folderNamePlaceholder"), t("study.newFolder"), {
      confirmButtonText: t("common.confirm"), cancelButtonText: t("common.cancel"),
      inputPlaceholder: t("study.folderNamePlaceholder"),
      inputValidator: (v: string) => (String(v || "").trim() ? true : t("study.nameRequired")),
    });
    await createStudyPlaylistFolder(String(value).trim());
    await loadPlaylists();
    ElMessage.success(t("study.folderCreated"));
  } catch { /* 取消 */ }
}

async function renameFolder(name: string) {
  try {
    const { value } = await ElMessageBox.prompt(t("study.folderRenameTip"), t("study.renameFolder"), {
      confirmButtonText: t("common.confirm"), cancelButtonText: t("common.cancel"),
      inputValue: name,
      inputValidator: (v: string) => (String(v || "").trim() ? true : t("study.nameRequired")),
    });
    const next = String(value || "").trim();
    if (!next || next === name) return;
    await renameStudyPlaylistFolder(name, next);
    if (currentFolder.value === name) currentFolder.value = next;
    await loadPlaylists();
    ElMessage.success(t("study.folderRenamed"));
  } catch (e: any) {
    if (e?.response) ElMessage.error(e.response.data?.error || t("common.operationFailed"));
  }
}

async function removeFolder(name: string) {
  try {
    await ElMessageBox.confirm(t("study.deleteFolderConfirm", { name }), t("study.deleteFolder"), {
      type: "warning", confirmButtonText: t("common.confirm"), cancelButtonText: t("common.cancel"),
    });
  } catch { return; }
  try {
    await deleteStudyPlaylistFolder(name);
    if (currentFolder.value === name) currentFolder.value = "";
    await loadPlaylists();
    ElMessage.success(t("study.folderDeleted"));
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  }
}

// ---- 多选:右键/长按「多选」进入,再点卡片勾选;选中后可整体拖入文件夹 ----
const playlistSelection = ref<Set<string>>(new Set());
function enterPlaylistSelection(p: StudyPlaylist) {
  playlistSelection.value = new Set([p.id]);
}
function onPlaylistCardClick(p: StudyPlaylist) {
  if (menuGuard()) return;
  if (playlistSelection.value.size > 0) {
    const next = new Set(playlistSelection.value);
    if (next.has(p.id)) next.delete(p.id);
    else next.add(p.id);
    playlistSelection.value = next;
    return;
  }
  openPlaylist(p);
}
function clearPlaylistSelection() {
  if (playlistSelection.value.size === 0) return;
  playlistSelection.value = new Set();
}
function selectedPlaylists(): StudyPlaylist[] {
  return playlists.value.filter((p) => playlistSelection.value.has(p.id));
}

// ---- 拖拽歌单到文件夹(支持多选批量) ----
const draggedPlaylistId = ref("");
const draggedPlaylistIds = ref<string[]>([]);
const dragOverFolder = ref("");
function onPlaylistDragStart(p: StudyPlaylist, ev: DragEvent) {
  const ids = playlistSelection.value.has(p.id) && playlistSelection.value.size > 1
    ? [...playlistSelection.value]
    : [p.id];
  draggedPlaylistIds.value = ids;
  draggedPlaylistId.value = p.id;
  ev.dataTransfer?.setData("text/plain", ids.join(","));
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
}
function onFolderDragLeave(name: string) {
  if (dragOverFolder.value === name) dragOverFolder.value = "";
}
async function dropPlaylistOnFolder(folder: string) {
  const ids = draggedPlaylistIds.value.length
    ? [...draggedPlaylistIds.value]
    : (draggedPlaylistId.value ? [draggedPlaylistId.value] : []);
  draggedPlaylistId.value = "";
  draggedPlaylistIds.value = [];
  dragOverFolder.value = "";
  const targets = playlists.value.filter((p) => ids.includes(p.id) && (p.folder || "") !== folder);
  if (targets.length === 0) return;
  try {
    for (const p of targets) await updateStudyPlaylist(p.id, { folder });
    await loadPlaylists();
    clearPlaylistSelection();
    ElMessage.success(
      targets.length > 1
        ? t("study.movedSelectedToFolder", { count: targets.length, name: folder || t("study.rootFolder") })
        : folder
          ? t("study.movedToFolder", { name: folder })
          : t("study.removedFromFolder"),
    );
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  }
}
async function movePlaylistToFolder(p: StudyPlaylist, folder: string) {
  try {
    await updateStudyPlaylist(p.id, { folder });
    await loadPlaylists();
    ElMessage.success(folder ? t("study.movedToFolder", { name: folder }) : t("study.removedFromFolder"));
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  }
}

// ---- 右键菜单「移动到文件夹」(单个/多选共用) ----
const moveDialogOpen = ref(false);
const moveTargets = ref<StudyPlaylist[]>([]);
const moveFolder = ref("");
const moveNewFolder = ref("");
const moving = ref(false);
const moveDialogTitle = computed(() =>
  moveTargets.value.length > 1
    ? t("study.moveSelectedToFolderTitle", { count: moveTargets.value.length })
    : t("study.moveToFolderTitle", { name: moveTargets.value[0]?.name || "" }),
);
function openMoveDialog(p: StudyPlaylist) {
  moveTargets.value = [p];
  moveFolder.value = p.folder || "";
  moveNewFolder.value = "";
  moveDialogOpen.value = true;
  if (folders.value.length === 0) loadPlaylists();
}
function openBatchMoveDialog() {
  const targets = selectedPlaylists();
  if (targets.length === 0) return;
  moveTargets.value = targets;
  moveFolder.value = "";
  moveNewFolder.value = "";
  moveDialogOpen.value = true;
  if (folders.value.length === 0) loadPlaylists();
}
async function confirmMove() {
  if (moveTargets.value.length === 0) return;
  const targets = [...moveTargets.value];
  moving.value = true;
  try {
    const folder = moveNewFolder.value.trim() || moveFolder.value;
    for (const p of targets) await updateStudyPlaylist(p.id, { folder });
    moveDialogOpen.value = false;
    clearPlaylistSelection();
    await loadPlaylists();
    ElMessage.success(
      targets.length > 1
        ? t("study.movedSelectedToFolder", { count: targets.length, name: folder || t("study.rootFolder") })
        : folder
          ? t("study.movedToFolder", { name: folder })
          : t("study.removedFromFolder"),
    );
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  } finally {
    moving.value = false;
  }
}

// ---- 空白区域:右键 / 长按 ----
let blankPressAt = 0;
function blankActions() {
  return [
    { label: t("study.newPlaylist"), icon: Plus, onClick: () => createPlaylist() },
    { label: t("study.newFolder"), icon: Folder, onClick: () => createFolder() },
  ];
}
function onBlankContextMenu(ev: MouseEvent, withFolder = false) {
  // 触屏长按后会补发 contextmenu,避免重复弹出。
  if (Date.now() - blankPressAt < 800) return;
  openContextMenu(ev, withFolder ? blankActions() : blankActions().slice(0, 1));
}
function onBlankLongPress(withFolder = false) {
  blankPressAt = Date.now();
  openActionSheet(withFolder ? blankActions() : blankActions().slice(0, 1));
}
async function removePlaylist(p: StudyPlaylist) {
  try {
    await ElMessageBox.confirm(t("study.deletePlaylistConfirm", { name: p.name }), t("study.deletePlaylist"), {
      type: "warning", confirmButtonText: t("common.confirm"), cancelButtonText: t("common.cancel"),
    });
  } catch { return; }
  try {
    await deleteStudyPlaylist(p.id);
    await loadPlaylists();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  }
}
async function deleteSelectedPlaylists() {
  const targets = selectedPlaylists();
  if (targets.length === 0) return;
  try {
    await ElMessageBox.confirm(
      t("study.deleteSelectedConfirm", { count: targets.length }),
      t("study.deletePlaylist"),
      { type: "warning", confirmButtonText: t("common.confirm"), cancelButtonText: t("common.cancel") },
    );
  } catch { return; }
  try {
    for (const p of targets) await deleteStudyPlaylist(p.id);
    const count = targets.length;
    clearPlaylistSelection();
    await loadPlaylists();
    ElMessage.success(t("study.deleteSelectedDone", { count }));
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  }
}
async function renamePlaylist(p: StudyPlaylist) {
  try {
    const { value } = await ElMessageBox.prompt(t("study.newPlaylistTip"), t("playlists.rename"), {
      confirmButtonText: t("common.confirm"), cancelButtonText: t("common.cancel"),
      inputValue: p.name,
      inputValidator: (v: string) => (String(v || "").trim() ? true : t("study.nameRequired")),
    });
    const name = String(value || "").trim();
    if (!name || name === p.name) return;
    await updateStudyPlaylist(p.id, { name });
    await loadPlaylists();
    ElMessage.success(t("playlists.renamed"));
  } catch (e: any) {
    if (e?.response) ElMessage.error(e.response.data?.error || t("playlists.renameFailed"));
  }
}
async function playPlaylist(p: StudyPlaylist) {
  try {
    const res = await fetchStudyPlaylistTracks(p.id);
    if (!res.items.length) { ElMessage.warning(t("study.playlistEmpty")); return; }
    playSongs(res.items, 0);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("playlists.playFailed"));
  }
}
function openPlaylist(p: StudyPlaylist) {
  router.push(`/study/playlists/${encodeURIComponent(p.id)}`);
}

// ==================== 学习歌单导出 / 导入 ====================
const importDialogOpen = ref(false);
const importFile = ref<StudyPlaylistExportFile | null>(null);
const importFileList = ref<any[]>([]);
const importing = ref(false);

function openImportDialog() {
  importFile.value = null;
  importFileList.value = [];
  importDialogOpen.value = true;
}

function clearImportFile() {
  importFile.value = null;
  importFileList.value = [];
}

// 读取选中的学习歌单 JSON:结构必须是「tracks 数组(单歌单)」或「playlists 数组(全部歌单)」。
function onImportFileChange(file: any) {
  importFileList.value = file?.fileList?.length ? [file.fileList[file.fileList.length - 1]] : [];
  const raw = file?.raw;
  if (!raw) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result as string);
      if (!Array.isArray(parsed?.tracks) && !Array.isArray(parsed?.playlists)) throw new Error("invalid");
      importFile.value = parsed;
    } catch {
      importFile.value = null;
      ElMessage.error(t("study.importInvalidFile"));
    }
  };
  reader.readAsText(raw);
}

async function confirmImport() {
  if (!importFile.value) {
    ElMessage.warning(t("study.importSelectFirst"));
    return;
  }
  importing.value = true;
  try {
    // 在某个歌单文件夹内导入时,新歌单直接归入该文件夹。
    const res = await importStudyPlaylists(importFile.value, currentFolder.value);
    importDialogOpen.value = false;
    clearImportFile();
    await loadPlaylists();
    ElMessage.success(t("study.importSuccess", {
      playlists: (res.created || 0) + (res.merged || 0),
      tracks: res.matched || 0,
      unmatched: res.unmatched || 0,
    }));
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("study.importFailed"));
  } finally {
    importing.value = false;
  }
}

function downloadBlob(data: BlobPart, headers: any, fallbackName: string) {
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const cd = (headers?.["content-disposition"] as string) || "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const a = document.createElement("a");
  a.href = url;
  a.download = m ? decodeURIComponent(m[1]) : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportAllPlaylists() {
  if (!playlists.value.length) return;
  try {
    const res = await api.get("/rest/api/v1/study/playlists/export-all", { responseType: "blob" });
    downloadBlob(res.data, res.headers, `${t("study.exportAllFilename")}_${new Date().toISOString().slice(0, 10)}.json`);
  } catch {
    ElMessage.error(t("study.exportFailed"));
  }
}

/** 单个学习歌单导出(右键菜单):文件名用歌单名,便于单独分享/备份。 */
async function exportPlaylist(p: StudyPlaylist) {
  try {
    const res = await api.get(`/rest/api/v1/study/playlists/${encodeURIComponent(p.id)}/export`, {
      responseType: "blob",
    });
    downloadBlob(res.data, res.headers, `${p.name || "study-playlist"}.json`);
  } catch {
    ElMessage.error(t("study.exportFailed"));
  }
}

// ---- 点击入口:长按弹出菜单后,吞掉随后触发的那次 click ----
function onSourceClick(s: StudySource) { if (menuGuard()) return; openSource(s); }
function onFolderClick(d: StudyDirEntry) { if (menuGuard()) return; enterSubdir(d); }
function onResumeClick(i: number) { if (menuGuard()) return; resume(i); }
function onRecentClick(i: number) { if (menuGuard()) return; playSongs(recentItems.value, i); }
// ==================== 加入学习歌单(单首 / 多选 / 整目录) ====================
interface AddTarget {
  songIds: string[];
  /** 尚未入库的文件:确认时再批量 resolve,取消则不产生额外请求。 */
  pending?: { sourceId: string; paths: string[] };
  name: string;
}
const addDialogOpen = ref(false);
const addPlaylistId = ref("");
const newPlaylistName = ref("");
const adding = ref(false);
const addTarget = ref<AddTarget | null>(null);

function openAddEntries(entries: StudyDirEntry[]) {
  if (!entries.length) return;
  const src = currentDir.value?.sourceId || "";
  const songIds = entries.map((e) => e.songId).filter((x): x is string => !!x);
  const paths = entries.filter((e) => !e.songId).map((e) => e.relPath);
  addTarget.value = {
    songIds,
    pending: paths.length ? { sourceId: src, paths } : undefined,
    name: entries.length === 1 ? entries[0].name : t("study.trackCount", { count: entries.length }),
  };
  openAddDialog();
}
/** 行右键/加号:若该行在整组选中里,则批量加入整组。 */
function addRowToPlaylist(entry: StudyDirEntry) {
  const useMulti = selectedKeys.value.has(entry.relPath) && selectedCount.value > 1;
  openAddEntries(useMulti ? selectedEntries.value : [entry]);
}
function addSelectedToPlaylist() {
  openAddEntries(selectedEntries.value);
}
async function addFolderToPlaylist(folder: StudyDirEntry) {
  const src = currentDir.value?.sourceId;
  if (!src) return;
  try {
    const items = await fetchStudyDir(src, folder.relPath);
    const audio = items.filter((e) => !e.isDir);
    if (!audio.length) {
      ElMessage.warning(t("study.dirEmpty"));
      return;
    }
    openAddEntries(audio);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("study.loadDirFailed"));
  }
}
function openAddSong(song: StudySong) {
  addTarget.value = { songIds: [song.id], name: song.title };
  openAddDialog();
}
function openAddDialog() {
  addPlaylistId.value = "";
  newPlaylistName.value = "";
  addDialogOpen.value = true;
  if (playlists.value.length === 0) loadPlaylists();
}
async function confirmAdd() {
  if (!addTarget.value) return;
  adding.value = true;
  try {
    let playlistId = addPlaylistId.value;
    if (!playlistId) {
      const name = newPlaylistName.value.trim();
      if (!name) { ElMessage.warning(t("study.pickOrCreate")); return; }
      playlistId = await createStudyPlaylist(name);
    }
    const target = addTarget.value;
    const ids = [...target.songIds];
    if (target.pending?.paths.length) {
      // 首次加入歌单也要先入库(与点播同一条链路)。
      const results = await resolveStudyFiles(target.pending.sourceId, target.pending.paths);
      for (const r of results) if (r.song?.id) ids.push(r.song.id);
    }
    const uniq = [...new Set(ids)];
    if (!uniq.length) { ElMessage.error(t("study.resolveFailed")); return; }
    await addStudyPlaylistTracks(playlistId, uniq);
    addDialogOpen.value = false;
    clearSelection();
    ElMessage.success(t("study.addedToPlaylist"));
    loadPlaylists();
    // 目录行上的「已加入」状态不作展示,但刷新一次可让新入库的时长/进度即时出现。
    if (mode.value === "dir" && currentDir.value) loadDir();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("common.operationFailed"));
  } finally {
    adding.value = false;
  }
}

// ==================== 工具 ====================
function fmtTime(sec?: number) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}
function pct(s: StudySong) {
  const p = s.progress ?? (s.durationSec ? (s.positionSec || 0) / s.durationSec : 0);
  return Math.min(100, Math.max(0, Math.round((Number(p) || 0) * 100)));
}

onMounted(() => {
  loadSources();
  loadContinue();
  loadPlaylists();
  window.addEventListener("keydown", onWindowKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("mousemove", onDragMove);
  document.body.style.userSelect = "";
});
</script>

<style lang="scss" scoped>
.study-page {
  padding: 32px 36px 210px;
  max-width: 1400px;
  margin: 0 auto;
}
.page-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  gap: 16px; flex-wrap: wrap; margin-bottom: 24px;
  .page-title { display: flex; align-items: baseline; gap: 14px;
    h2 { font-size: 32px; font-weight: 700; margin: 0; letter-spacing: -0.4px; color: var(--fnos-text-primary); }
    .sub { font-size: 13px; color: var(--fnos-text-tertiary); }
  }
  .search-input { width: 320px; }
}
/* Tab 与搜索同一排 */
.tab-row {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  .content-tabs { flex: 1; min-width: 260px; }
  .search-input { width: 260px; flex-shrink: 0; }
}
/* 空白区域:右键/长按可新建 */
.blank-zone {
  margin-top: 14px; min-height: 120px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.1);
  color: var(--fnos-text-tertiary); font-size: 12px; user-select: none;
}
.folder-card.drop-active {
  background: rgba(84, 160, 255, 0.18);
  border-color: rgba(84, 160, 255, 0.65);
}
.folder-card.root-drop { margin-bottom: 12px; }
.folder-grid.playlists { margin-bottom: 12px; }
.playlist-card.selected {
  background: rgba(84, 160, 255, 0.14);
  outline: 2px solid rgba(84, 160, 255, 0.55);
  outline-offset: -2px;
}
.search-sort { display: flex; align-items: center; gap: 8px; }
.search-sort .sort-label { font-size: 12px; color: var(--fnos-text-tertiary); }
.search-sort .sort-select { width: 132px; }
.result-subhead {
  margin: 12px 0 8px; font-size: 12px; font-weight: 600;
  color: var(--fnos-text-secondary);
}
.study-body { display: block; }
.content-panel { min-width: 0; }

/* ===== 学习目录:平铺文件夹(类似 Windows 资源管理器) ===== */
.folder-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px;
  &.sub { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); margin-bottom: 14px; }
}
.folder-card {
  position: relative;
  display: flex; align-items: center; gap: 12px; padding: 14px;
  border-radius: 12px; cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: transform 0.18s ease, background 0.18s ease;
  &:hover { transform: translateY(-2px); background: rgba(255, 255, 255, 0.08); }
  &:hover .card-more { opacity: 1; }
  .folder-icon {
    width: 48px; height: 48px; border-radius: 10px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, rgba(255, 196, 79, 0.28), rgba(255, 214, 102, 0.12));
    color: #f3c969;
  }
  .folder-info { min-width: 0; flex: 1; }
  /* 文件夹名称必须完整显示:允许换行,不做省略号截断。 */
  .folder-name {
    font-size: 14px; font-weight: 600; color: var(--fnos-text-primary);
    line-height: 1.35; white-space: normal; overflow-wrap: anywhere;
  }
  .folder-meta { font-size: 12px; color: var(--fnos-text-tertiary); }
}
.folder-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 26px 12px; color: var(--fnos-text-tertiary); font-size: 12px; text-align: center;
  border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.12);
  .hint { font-size: 11px; opacity: 0.8; margin: 0; }
}

/* ===== 内容区 ===== */
.block-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px 0 14px; }
.block-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.import-hint { margin-bottom: 12px; }
.import-upload { width: 100%; }
.block-title { font-size: 14px; font-weight: 700; color: var(--fnos-text-primary); }
.crumb { display: flex; align-items: center; gap: 2px; font-size: 13px; color: var(--fnos-text-secondary); min-width: 0; flex-wrap: wrap; }
.crumb-home, .crumb-seg {
  border: 0; background: transparent; padding: 3px 6px; border-radius: 6px;
  font: inherit; color: inherit; cursor: pointer; white-space: normal; overflow-wrap: anywhere;
  text-align: left;
  &:hover { background: rgba(255, 255, 255, 0.08); color: var(--fnos-text-primary); }
}
.crumb-home { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.crumb-seg.current { color: var(--fnos-text-primary); font-weight: 700; cursor: default; }
.crumb-sep { opacity: 0.5; flex-shrink: 0; }
.empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 56px 0; color: var(--fnos-text-tertiary); font-size: 13px;
}

.study-list { display: flex; flex-direction: column; gap: 2px; }
.study-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: 10px; cursor: pointer;
  transition: background 0.18s ease;
  &:hover { background: rgba(255, 255, 255, 0.07); }
  &.active { background: rgba(64, 158, 255, 0.14); }
  /* 多选高亮:与 Windows 资源管理器一致,选中项整行描边 + 高亮。 */
  &.selected {
    background: rgba(64, 158, 255, 0.2);
    box-shadow: inset 0 0 0 1px rgba(64, 158, 255, 0.45);
  }
  &.selected .row-play { background: rgba(64, 158, 255, 0.35); color: #fff; }
  .row-play {
    width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(255, 255, 255, 0.08); color: var(--fnos-text-secondary);
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
    /* 悬停时二次高亮:让用户明确这里就是播放按钮。 */
    &:hover {
      background: #409eff; color: #fff; transform: scale(1.12);
      box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.25);
    }
  }
  /* 课名完整显示:允许换行,不再用省略号截断。 */
  .row-title {
    flex: 1 1 auto; min-width: 0;
    font-size: 14px; color: var(--fnos-text-primary);
    line-height: 1.35; overflow-wrap: anywhere;
  }
  .row-dir { flex: 0 0 160px; font-size: 12px; color: var(--fnos-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-dur { flex: 0 0 auto; min-width: 76px; font-size: 12px; color: var(--fnos-text-tertiary); text-align: right; white-space: nowrap; }
  .row-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
}
.row-progress {
  flex: 0 0 160px; display: flex; align-items: center; gap: 8px; min-width: 0;
  .bar { flex: 1; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.12); overflow: hidden; }
  .bar-in { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, #4facfe, #00f2fe); }
  .pct-text { font-size: 11px; color: var(--fnos-text-tertiary); white-space: nowrap; }
}
.row-btn {
  width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--fnos-text-tertiary); cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.1); color: var(--fnos-text-primary); }
}

/* ===== 多选工具条 / 拖拽框选 ===== */
.sel-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 0 12px; padding: 8px 12px; border-radius: 10px;
  background: rgba(64, 158, 255, 0.12);
  border: 1px solid rgba(64, 158, 255, 0.3);
  .sel-count { font-size: 13px; font-weight: 600; color: var(--fnos-text-primary); }
}
.sel-hint {
  margin: -4px 0 10px; font-size: 12px; color: var(--fnos-text-tertiary);
}
.marquee {
  position: fixed; z-index: 3000; pointer-events: none;
  border: 1px solid rgba(64, 158, 255, 0.9);
  background: rgba(64, 158, 255, 0.16);
  border-radius: 2px;
}

/* 卡片右上角的「更多」入口:与右键菜单内容一致,方便桌面端发现。 */
.card-more {
  position: absolute; top: 8px; right: 8px;
  width: 26px; height: 26px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--fnos-text-tertiary); opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
  &:hover { background: rgba(255, 255, 255, 0.12); color: var(--fnos-text-primary); }
}

/* ===== 歌单 ===== */
.playlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.playlist-card {
  position: relative;
  display: flex; align-items: center; gap: 12px; padding: 14px;
  border-radius: 12px; cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: transform 0.18s ease, background 0.18s ease;
  &:hover { transform: translateY(-2px); background: rgba(255, 255, 255, 0.08); }
  &:hover .card-more { opacity: 1; }
  .pl-icon {
    width: 44px; height: 44px; border-radius: 10px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, rgba(79, 172, 254, 0.35), rgba(0, 242, 254, 0.18));
    color: #7fd0ff;
  }
  /* 歌单图标即播放入口:悬停二次高亮并切换成播放三角。 */
  .pl-play {
    cursor: pointer;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
    .ic-play { display: none; }
    &:hover {
      background: #409eff; color: #fff; transform: scale(1.06);
      box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.25);
      .ic-idle { display: none; }
      .ic-play { display: block; }
    }
  }
  .pl-info { min-width: 0; flex: 1; }
  .pl-name { font-size: 14px; font-weight: 600; color: var(--fnos-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pl-meta { font-size: 12px; color: var(--fnos-text-tertiary); }
}

/* ===== 播放控制复用全局播放条:学习页不再单独做播放器 ===== */

.add-dialog { display: flex; flex-direction: column; gap: 12px; }
.add-select, .add-new { width: 100%; }

.search-block { margin-bottom: 18px; }

@media (max-width: 900px) {
  .study-page { padding: 20px 16px 220px; }
  .page-header { .search-input { width: 100%; } }
  .folder-grid { grid-template-columns: 1fr; }
  .card-more { opacity: 1; }
  .study-row { .row-dir, .row-progress, .row-actions { display: none; } }
}
</style>
