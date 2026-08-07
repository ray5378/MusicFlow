<template>
  <div class="main-layout" :class="pageTheme">
    <!-- 全屏统一底层（标题栏/侧栏所在的收敛端：所有页面同一主体色调） -->
    <div class="app-bg" aria-hidden="true"></div>
    <!-- 内容区极光层：覆盖整个布局（含侧栏列与底部），向上渗透收敛、底部铺满，消除侧栏四周露黑 -->
    <div class="content-aurora" :class="pageTheme" aria-hidden="true"></div>
    <!-- ===== Mobile top bar ===== -->
    <header class="mobile-header" v-if="isMobile" :class="{ 'mc-hidden': playerStore.playModeVisible }">
      <button type="button" class="mobile-hamburger" aria-label="菜单" @click="mobileNavOpen = !mobileNavOpen">
        <MfIcon name="Menu" :size="22"  />
      </button>
      <img src="/favicon.png" alt="MusicFlow" class="mobile-brand-logo" @click="mobileNavOpen = false" />
      <span class="mobile-brand" @click="mobileNavOpen = false">MusicFlow</span>
    </header>

    <!-- ===== Mobile drawer overlay ===== -->
    <transition name="fade">
      <div class="sidebar-overlay" v-if="isMobile && mobileNavOpen" @click="mobileNavOpen = false"></div>
    </transition>

    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed, mobile: isMobile, 'mobile-open': isMobile && mobileNavOpen }">
      <div class="logo" @click="onLogoClick">
        <img src="/favicon.png" alt="MusicFlow" class="logo-img" />
        <span v-if="!sidebarCollapsed || isMobile" class="logo-text">MusicFlow</span>
      </div>
      <el-menu :default-active="activeMenu" :collapse="!isMobile && sidebarCollapsed" router class="sidebar-menu" @select="closeMobileNav">
        <el-menu-item index="/"><MfIcon name="Home" /><template #title>首页</template></el-menu-item>
        <el-menu-item index="/songs"><MfIcon name="Headphones" /><template #title>音乐</template></el-menu-item>
        <el-menu-item index="/genres"><MfIcon name="Library" /><template #title>风格</template></el-menu-item>
        <el-menu-item index="/albums"><MfIcon name="Disc3" /><template #title>专辑</template></el-menu-item>
        <el-menu-item index="/artists"><MfIcon name="User" /><template #title>艺术家</template></el-menu-item>
        <el-menu-item index="/playlists"><MfIcon name="List" /><template #title>歌单</template></el-menu-item>
        <el-menu-item index="/favorites"><MfIcon name="Heart" :filled="true" :size="16" /><template #title>我喜欢的音乐</template></el-menu-item>
        <el-menu-item index="/groups"><MfIcon name="Box" /><template #title>播放器群组</template></el-menu-item>
        <el-menu-item index="/flows"><MfIcon name="Workflow" /><template #title>音流</template></el-menu-item>
        <el-menu-item index="/history"><MfIcon name="Clock" /><template #title>播放历史</template></el-menu-item>
        <el-divider v-if="authStore.isAdmin" />
        <el-menu-item v-if="authStore.isAdmin" index="/admin/music"><MfIcon name="Search" /><template #title>音乐管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/plugins"><MfIcon name="Cable" /><template #title>插件管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/sources"><MfIcon name="FolderOpen" /><template #title>媒体源</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/users"><MfIcon name="User" /><template #title>用户管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/wish"><MfIcon name="MessageCircle" /><template #title>许愿</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/settings"><MfIcon name="Settings" /><template #title>系统设置</template></el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <el-dropdown @command="handleCommand">
          <span class="user-info"><MfIcon name="User" /><span v-if="!sidebarCollapsed || isMobile">{{ authStore.username }}</span></span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="settings">设置</el-dropdown-item>
              <el-dropdown-item command="logout" divided>登出</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <main class="main-content">
      <!-- 可滚动内容 -->
      <div class="main-scroll">
        <router-view v-slot="{ Component, route }">
          <transition name="page" mode="out-in">
            <component :is="Component" :key="route.path" />
          </transition>
        </router-view>
      </div>
    </main>

    <!-- ===== Mobile player bar (compact) ===== -->
    <footer class="player-bar-mobile" v-if="isMobile" :class="{ 'mc-hidden': playerStore.playModeVisible }">
      <div class="mp-cover" @click="playerStore.togglePlayMode">
        <img v-if="coverUrl" :src="coverUrl" />
        <div v-else class="mp-cover-ph"><MfIcon name="Headphones" :size="20"  /></div>
      </div>
      <div class="mp-info" @click="playerStore.togglePlayMode">
        <div class="mp-title">{{ playerStore.currentSong ? playerStore.currentSong.title : '未在播放' }}</div>
        <div class="mp-artist">
          <span v-if="playerStore.currentLyricLine" class="mp-lyric">{{ playerStore.currentLyricLine }}</span>
          <span v-else>{{ playerStore.currentSong ? playerStore.currentSong.artist : '选择一首歌曲开始播放' }}</span>
        </div>
      </div>
      <div class="mp-controls">
        <button type="button" class="mp-btn" @click="playerStore.prev"><MfIcon name="SkipBack" :size="18" /></button>
        <button type="button" class="mp-btn mp-play" :class="{ active: playerStore.isPlaying }" @click="playerStore.togglePlay">
          <MfIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="24" />
        </button>
        <button type="button" class="mp-btn" @click="playerStore.next"><MfIcon name="SkipForward" :size="18" /></button>

        <!-- More: opens the full playback controls panel (mirrors desktop bar,
             including the player switcher + DLNA rescan). -->
        <el-popover
          placement="top-end"
          :width="340"
          trigger="click"
          popper-class="mobile-controls-popover"
          v-model:visible="mobileControlsVisible"
        >
          <template #reference>
            <button type="button" class="mp-btn mp-more" :class="{ active: mobileControlsVisible }">
              <MfIcon name="MoreHorizontal" :size="18"  />
            </button>
          </template>
          <div class="mc-body">
            <!-- Player switcher (same data/actions as the desktop popover) -->
            <div class="mc-section">
              <div class="mc-title">选择播放器</div>
              <div class="mc-peer-list">
                <div
                  v-for="p in playerStore.peers"
                  :key="p.peerId"
                  class="mc-peer-item"
                  :class="{ active: p.peerId === playerStore.currentPeerId, unavailable: !p.available }"
                  @click="onMobileSwitchPeer(p.peerId)"
                >
                  <MfIcon :name="p.kind === 'group' ? 'box' : 'headphones'" class="mc-peer-icon" />
                  <div class="mc-peer-info">
                    <div class="mc-peer-name">
                      {{ p.kind === 'local' ? '本机' : p.name }}
                      <span v-if="!p.available" class="mc-peer-offline">离线</span>
                    </div>
                    <div class="mc-peer-meta">
                      <span v-if="p.queue && p.queue.items && p.queue.items.length > 0">
                        {{ p.queue.items.length }} 首
                        <span v-if="p.queue.isActive">
                          · 播放中
                          <span v-if="peerPlayingTitle(p)" class="mc-playing-title">· {{ peerPlayingTitle(p) }}</span>
                        </span>
                      </span>
                      <span v-else>空闲</span>
                    </div>
                  </div>
                  <MfIcon name="Check" v-if="p.peerId === playerStore.currentPeerId" class="mc-peer-check"  />
                </div>
                <div v-if="playerStore.peers.length === 0" class="mc-peer-empty">暂无可用播放器</div>
              </div>
              <div class="mc-scan">
                <el-button size="small" :loading="dlnaScanning" @click="scanDlnaDevices">
                  <MfIcon name="RefreshCw" />重新扫描DLNA设备
                </el-button>
              </div>
            </div>

            <!-- Progress -->
            <div class="mc-section mc-progress">
              <span class="mc-time">{{ formatTime(playerStore.currentTime) }}</span>
              <el-slider :model-value="playerStore.progress" @input="playerStore.seekPercent" :show-tooltip="false" class="mc-slider" />
              <span class="mc-time">{{ formatTime(playerStore.duration) }}</span>
            </div>

            <!-- Transport controls -->
            <div class="mc-section mc-ctrl-row">
              <el-tooltip :content="playModeTooltip" placement="top">
                <el-button circle size="small" @click="playerStore.cyclePlayMode" :type="playerStore.playMode !== 'order' ? 'primary' : ''">
                  <MfIcon :name="playModeIconName" :size="16" />
                </el-button>
              </el-tooltip>
              <el-button circle @click="playerStore.prev"><MfIcon name="SkipBack" :size="22" /></el-button>
              <el-button circle type="primary" class="mc-play" @click="playerStore.togglePlay">
                <MfIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="28" />
              </el-button>
              <el-button circle @click="playerStore.next"><MfIcon name="SkipForward" :size="22" /></el-button>
              <el-button circle size="small" @click="openMobileQueue" :type="playerStore.showPlaylist ? 'primary' : ''"><MfIcon name="List" /></el-button>
            </div>

            <!-- Tools: add to playlist, favorite, volume -->
            <div class="mc-section mc-tools">
              <el-tooltip content="添加到歌单" placement="top">
                <el-button circle size="small" @click="openAddToPlaylist"><MfIcon name="Plus" /></el-button>
              </el-tooltip>
              <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
                <el-button circle size="small" class="fav-btn" :class="{ active: isCurrentFavorite }" @click="toggleCurrentFavorite">
                  <MfIcon name="Heart" :filled="isCurrentFavorite" :size="16" />
                </el-button>
              </el-tooltip>
              <div class="mc-volume">
                <span class="mc-vol-label">音量</span>
                <el-slider
                  :model-value="playerStore.volume * 100"
                  @input="(v: number) => playerStore.setVolume(v / 100)"
                  :format-tooltip="(v: number) => `${Math.round(v)}%`"
                  class="mc-vol-slider"
                />
              </div>
            </div>
          </div>
        </el-popover>
      </div>
    </footer>

    <!-- ===== Player bar (always visible) ===== -->
    <footer class="player-bar" v-if="!isMobile">
      <div class="player-left" v-if="playerStore.currentSong">
        <div class="np-main" @click="playerStore.togglePlayMode">
          <img v-if="coverUrl" :src="coverUrl" class="player-cover" />
          <div v-else class="player-cover-placeholder"><MfIcon name="Headphones" :size="24"  /></div>
          <div class="player-song-info">
            <div class="player-title">{{ playerStore.currentSong.title }}</div>
            <div class="player-artist">
              <span v-if="playerStore.currentLyricLine" class="player-lyric">{{ playerStore.currentLyricLine }}</span>
              <span v-else>{{ playerStore.currentSong.artist }}</span>
            </div>
          </div>
        </div>
        <div class="np-progress-thin" title="拖动以定位播放进度">
          <div class="np-progress-line">
            <div class="np-progress-fill" :style="{ width: playerStore.progress + '%' }"></div>
          </div>
        </div>
        <div class="np-progress-panel">
          <span class="np-time">{{ formatTime(playerStore.currentTime) }}</span>
          <el-slider :model-value="playerStore.progress" @input="playerStore.seekPercent" :show-tooltip="false" class="np-slider" />
          <span class="np-time">{{ formatTime(playerStore.duration) }}</span>
        </div>
      </div>
      <div class="player-left" v-else>
        <div class="np-main">
          <div class="player-cover-placeholder"><MfIcon name="Headphones" :size="24"  /></div>
          <div class="player-song-info">
            <div class="player-title player-title-empty">未在播放</div>
            <div class="player-artist">选择一首歌曲开始播放</div>
          </div>
        </div>
      </div>
      <div class="player-center">
        <div class="player-controls">
          <el-tooltip :content="playModeTooltip" placement="top">
              <el-button circle size="small" @click="playerStore.cyclePlayMode" :type="playerStore.playMode !== 'order' ? 'primary' : ''" class="ctrl-btn">
              <MfIcon :name="playModeIconName" :size="16" />
            </el-button>
          </el-tooltip>
          <el-tooltip content="上一首" placement="top">
            <el-button circle @click="playerStore.prev" class="ctrl-btn"><MfIcon name="SkipBack" :size="20" /></el-button>
          </el-tooltip>
          <el-tooltip :content="playerStore.isPlaying ? '暂停' : '播放'" placement="top">
            <el-button circle @click="playerStore.togglePlay" type="primary" class="ctrl-btn play-btn">
              <MfIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="26" />
            </el-button>
          </el-tooltip>
          <el-tooltip content="下一首" placement="top">
            <el-button circle @click="playerStore.next" class="ctrl-btn"><MfIcon name="SkipForward" :size="20" /></el-button>
          </el-tooltip>
        </div>
      </div>
      <div class="player-right">
        <!-- Player switcher: opens a popup above the button listing all peers
             (local + DLNA + groups). Clicking a peer rebinds the player bar
             + queue panel to it and starts controlling that player. For a
             DLNA device this effectively casts to it. The popup also hosts
             the manual "重新扫描DLNA设备" action. -->
        <el-popover
          placement="top-start"
          :width="280"
          trigger="click"
          v-model:visible="peerSwitcherVisible"
          popper-class="peer-switcher-popover"
        >
          <template #reference>
            <el-button class="peer-switch-btn" size="small">
              <MfIcon name="headphones" class="peer-switch-icon"  />
              <span class="peer-switch-label">{{ playerStore.currentPeerName }}</span>
              <MfIcon name="ArrowUp" class="peer-switch-arrow"  />
            </el-button>
          </template>
          <div class="peer-switcher">
            <div class="peer-switcher-title">选择播放器</div>
            <div class="peer-switcher-list">
              <div
                v-for="p in playerStore.peers"
                :key="p.peerId"
                class="peer-switcher-item"
                :class="{ active: p.peerId === playerStore.currentPeerId, unavailable: !p.available }"
                @click="onSwitchPeer(p.peerId)"
              >
                <MfIcon :name="p.kind === 'group' ? 'box' : 'headphones'" class="psi-icon" />
                <div class="psi-info">
                  <div class="psi-name">
                    {{ p.kind === 'local' ? '本机' : p.name }}
                    <span v-if="!p.available" class="psi-offline">离线</span>
                  </div>
                  <div class="psi-meta">
                    <span v-if="p.queue && p.queue.items && p.queue.items.length > 0">
                      {{ p.queue.items.length }} 首
                      <span v-if="p.queue.isActive">
                        · 播放中
                        <span v-if="peerPlayingTitle(p)" class="psi-playing-title">· {{ peerPlayingTitle(p) }}</span>
                      </span>
                    </span>
                    <span v-else>空闲</span>
                  </div>
                </div>
                <MfIcon name="Check" v-if="p.peerId === playerStore.currentPeerId" class="psi-check"  />
              </div>
              <div v-if="playerStore.peers.length === 0" class="peer-switcher-empty">暂无可用播放器</div>
            </div>
            <div class="peer-switcher-scan">
              <el-button size="small" :loading="dlnaScanning" @click="scanDlnaDevices">
                <MfIcon name="RefreshCw" />重新扫描DLNA设备
              </el-button>
            </div>
            <div class="peer-switcher-tip">切换播放器仅改变当前控制目标,不会停止其他播放器</div>
          </div>
        </el-popover>
        <!-- 播放列表 -->
        <el-tooltip content="播放列表" placement="top">
          <el-button circle size="small" @click="playerStore.togglePlaylistPanel" :type="playerStore.showPlaylist ? 'primary' : ''"><MfIcon name="List" /></el-button>
        </el-tooltip>
        <!-- 添加到歌单 -->
        <el-tooltip content="添加到歌单" placement="top">
          <el-button circle size="small" @click="openAddToPlaylist"><MfIcon name="Plus" /></el-button>
        </el-tooltip>
        <!-- 我喜欢的音乐 -->
        <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
          <el-button circle size="small" class="fav-btn" :class="{ active: isCurrentFavorite }" @click="toggleCurrentFavorite">
            <MfIcon name="Heart" :filled="isCurrentFavorite" :size="16" />
          </el-button>
        </el-tooltip>
        <!-- 音量：点击展开控制条（去掉常驻滑块，更清爽） -->
        <el-popover placement="top" :width="210" trigger="click" v-model:visible="volumePopoverVisible" popper-class="volume-popover">
          <template #reference>
            <el-button circle size="small" :class="{ 'vol-active': volumePopoverVisible }" class="vol-btn">
              <MfIcon :name="playerStore.volume > 0 ? 'volume-2' : 'volume-x'" :size="16" />
            </el-button>
          </template>
          <div class="volume-popover-body">
            <span class="vol-label">音量</span>
            <el-slider :model-value="playerStore.volume * 100" @input="(v: number) => playerStore.setVolume(v / 100)" :format-tooltip="(v: number) => `${Math.round(v)}%`" class="volume-pop-slider" />
          </div>
        </el-popover>
      </div>
    </footer>

    <!-- ===== Queue panel ===== -->
    <transition name="slide-right">
      <div class="queue-panel" v-if="playerStore.showPlaylist">
        <div class="queue-header">
          <span>播放队列 ({{ playerStore.queue.length }})</span>
          <div class="queue-actions">
            <el-button size="small" text @click="playerStore.clearQueue">清空</el-button>
            <el-button size="small" text @click="playerStore.togglePlaylistPanel">关闭</el-button>
          </div>
        </div>
        <div class="queue-list" ref="queueListEl">
          <div
            v-for="(song, idx) in playerStore.queue"
            :key="song.id"
            ref="queueItemEls"
            class="queue-item"
            :class="{ active: idx === playerStore.currentIndex }"
            @click="playFromQueue(idx)"
          >
            <div class="queue-cover">
              <img v-if="song.coverArt" :src="`/rest/getCoverArt?id=${song.coverArt}&size=80`" />
              <div v-else class="queue-cover-ph"><MfIcon name="Headphones" /></div>
              <span v-if="idx === playerStore.currentIndex" class="playing-indicator" :class="{ paused: !playerStore.isPlaying }"></span>
            </div>
            <div class="queue-info">
              <div class="queue-title">{{ song.title }}</div>
              <div class="queue-artist">{{ song.artist }}</div>
            </div>
            <div class="queue-duration">{{ formatTime(song.duration) }}</div>
            <el-button circle size="small" text class="queue-remove" @click.stop="removeFromQueue(idx)"><MfIcon name="X" /></el-button>
          </div>
          <div v-if="playerStore.queue.length === 0" class="queue-empty">队列为空</div>
        </div>
      </div>
    </transition>

    <!-- ===== Fullscreen play mode (NetEase style) ===== -->
    <transition name="fade">
      <div class="play-mode" v-if="playerStore.playModeVisible && playerStore.currentSong">
        <div class="play-mode-bg"></div>
        <button class="play-mode-close" @click="playerStore.togglePlayMode"><MfIcon name="X" :size="24"  /></button>

        <div class="play-mode-body">
          <!-- Left: rotating disc -->
          <div class="pm-left">
            <div class="pm-disc" :class="{ spinning: playerStore.isPlaying }">
              <img v-if="coverUrl" :src="coverUrl" class="pm-disc-img" />
              <div v-else class="pm-disc-ph"><MfIcon name="Headphones" :size="80"  /></div>
              <div class="pm-disc-hole"></div>
            </div>
            <div class="pm-song-title">{{ playerStore.currentSong.title }}</div>
            <div class="pm-song-artist">{{ playerStore.currentSong.artist }}</div>
            <div class="pm-song-album" v-if="playerStore.currentSong.album">{{ playerStore.currentSong.album }}</div>
          </div>

          <!-- Right: scrolling lyrics -->
          <div class="pm-right" ref="lyricsContainer">
            <div class="pm-lyrics">
              <div
                v-for="(line, i) in playerStore.lyrics"
                :key="i"
                class="pm-lyric-line"
                :class="{ active: i === playerStore.currentLyricIndex }"
              >{{ line.text }}</div>
              <div v-if="playerStore.lyrics.length === 0" class="pm-lyrics-empty">暂无歌词</div>
            </div>
          </div>
        </div>

        <!-- Bottom: controls -->
        <div class="play-mode-controls">
          <div class="pm-progress">
            <span class="time">{{ formatTime(playerStore.currentTime) }}</span>
            <el-slider :model-value="playerStore.progress" @input="playerStore.seekPercent" :show-tooltip="false" class="pm-slider" />
            <span class="time">{{ formatTime(playerStore.duration) }}</span>
          </div>
          <div class="pm-buttons">
            <el-tooltip :content="playModeTooltip" placement="top">
              <el-button circle size="small" @click="playerStore.cyclePlayMode" :type="playerStore.playMode !== 'order' ? 'primary' : ''" class="ctrl-btn">
                <MfIcon :name="playModeIconName" :size="18" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="上一首" placement="top">
              <el-button circle @click="playerStore.prev" class="ctrl-btn pm-nav-btn"><MfIcon name="SkipBack" :size="26" /></el-button>
            </el-tooltip>
            <el-tooltip :content="playerStore.isPlaying ? '暂停' : '播放'" placement="top">
              <el-button circle @click="playerStore.togglePlay" type="primary" class="ctrl-btn pm-play-btn">
                <MfIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="30" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="下一首" placement="top">
              <el-button circle @click="playerStore.next" class="ctrl-btn pm-nav-btn"><MfIcon name="SkipForward" :size="26" /></el-button>
            </el-tooltip>
            <el-tooltip content="添加到歌单" placement="top">
              <el-button circle size="small" @click="openAddToPlaylist"><MfIcon name="Plus" /></el-button>
            </el-tooltip>
            <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
              <el-button
                circle
                size="small"
                class="fav-btn pm-fav-btn"
                :class="{ active: isCurrentFavorite }"
                @click="toggleCurrentFavorite"
              >
                <MfIcon name="Heart" :filled="isCurrentFavorite" :size="18" />
              </el-button>
            </el-tooltip>
          </div>
        </div>
      </div>
    </transition>

    <!-- ===== Add to playlist dialog ===== -->
    <el-dialog v-model="showPlaylistDialog" title="添加到歌单" width="420px">
      <div class="playlist-dialog-song" v-if="playlistTargetSong">
        将「{{ playlistTargetSong.title }} - {{ playlistTargetSong.artist }}」添加到：
      </div>
      <div class="playlist-list" v-loading="playlistsLoading">
        <div
          v-for="pl in playlists"
          :key="pl.id"
          class="playlist-item"
          :class="{ active: addingPlaylistId === pl.id }"
          @click="addToPlaylist(pl)"
        >
          <MfIcon name="List" class="pl-icon"  />
          <div class="pl-info">
            <div class="pl-name">{{ pl.name }}</div>
            <div class="pl-meta">{{ pl.songCount }}首</div>
          </div>
          <MfIcon name="Loader2" v-if="addingPlaylistId === pl.id" class="is-loading"  spin />
        </div>
        <div v-if="playlists.length === 0 && !playlistsLoading" class="empty-tip">暂无歌单，先创建一个吧</div>
      </div>
      <div class="create-playlist-row">
        <el-input v-model="newPlaylistName" placeholder="新建歌单名称..." clearable @keyup.enter="createAndAdd" />
        <el-button type="primary" @click="createAndAdd" :disabled="!newPlaylistName">新建并添加</el-button>
      </div>
    </el-dialog>

    <!-- 全局：右键菜单 / 长按操作面板 / 添加到歌单 / 歌曲信息 -->
    <GlobalItemUI />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import GlobalItemUI from "@/components/GlobalItemUI.vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const playerStore = usePlayerStore();
const favoritesStore = useFavoritesStore();

// On layout mount (i.e. after login), restore any active DLNA cast session
// from the backend so the UI reflects what's still playing on the device
// after the tab was closed or the backend restarted. Then init the local
// peer (register + heartbeat + WS + restore local queue).
onMounted(async () => {
  if (!authStore.isLoggedIn) return;
  await playerStore.restoreCast().catch(() => {});
  await playerStore.initLocalPeer().catch(() => {});
});
const sidebarCollapsed = ref(false);

// ===== Responsive layout state =====
const isMobile = ref(false);
const mobileNavOpen = ref(false);
const mobileControlsVisible = ref(false);
function updateViewport() { isMobile.value = window.innerWidth < 768; }
updateViewport();
window.addEventListener("resize", updateViewport);
onUnmounted(() => window.removeEventListener("resize", updateViewport));

function onLogoClick() {
  if (isMobile.value) mobileNavOpen.value = false;
  else sidebarCollapsed.value = !sidebarCollapsed.value;
}
function closeMobileNav() { if (isMobile.value) mobileNavOpen.value = false; }
const lyricsContainer = ref<HTMLElement | null>(null);
const queueListEl = ref<HTMLElement | null>(null);
const queueItemEls = ref<HTMLElement[]>([]);

// Add-to-playlist dialog state
const showPlaylistDialog = ref(false);
const playlistTargetSong = ref<any>(null);
const playlists = ref<any[]>([]);
const playlistsLoading = ref(false);
const addingPlaylistId = ref("");
const newPlaylistName = ref("");

const isCurrentFavorite = computed(() => {
  const s = playerStore.currentSong;
  return s ? favoritesStore.isFavorite(s.id) : false;
});

const activeMenu = computed(() => route.path);

// 按路由映射主题：favorites→红, history→绿, 其余→蓝
const pageTheme = computed(() => {
  const p = route.path;
  if (p.startsWith("/favorites")) return "fnos-theme-red";
  if (p.startsWith("/history")) return "fnos-theme-green";
  return "fnos-theme-blue";
});
const coverUrl = computed(() => {
  if (!playerStore.currentSong) return "";
  return playerStore.getCoverUrl(playerStore.currentSong.coverArt || playerStore.currentSong.id);
});

const playModeIconName = computed(() => {
  switch (playerStore.playMode) {
    case "one": return "repeat-1";
    case "all": return "repeat";
    case "shuffle": return "shuffle";
    default: return "list-ordered";
  }
});
const playModeTooltip = computed(() => {
  switch (playerStore.playMode) {
    case "one": return "单曲循环";
    case "all": return "列表循环";
    case "shuffle": return "随机播放";
    default: return "顺序播放";
  }
});

function formatTime(seconds: number) { const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); return `${m}:${s.toString().padStart(2, "0")}`; }

function handleCommand(cmd: string) {
  if (cmd === "logout") { authStore.logout(); router.push("/login"); }
  else if (cmd === "settings") router.push("/settings");
}

function playFromQueue(idx: number) {
  const song = playerStore.queue[idx];
  if (song) playerStore.playSong(song);
}

function removeFromQueue(idx: number) { playerStore.removeFromQueue(idx); }

async function openAddToPlaylist() {
  const song = playerStore.currentSong;
  if (!song) return;
  playlistTargetSong.value = song;
  showPlaylistDialog.value = true;
  newPlaylistName.value = "";
  await loadPlaylists();
}

async function loadPlaylists() {
  playlistsLoading.value = true;
  try {
    const res = await api.get("/rest/getPlaylists?f=json");
    playlists.value = res.data["subsonic-response"]?.playlists?.playlist || [];
  } catch { playlists.value = []; }
  finally { playlistsLoading.value = false; }
}

async function addToPlaylist(pl: any) {
  if (!playlistTargetSong.value || addingPlaylistId.value) return;
  addingPlaylistId.value = pl.id;
  try {
    await api.post("/rest/updatePlaylist", { playlistId: pl.id, songIdToAdd: playlistTargetSong.value.id });
    ElMessage.success(`已添加到「${pl.name}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "添加失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

async function createAndAdd() {
  if (!newPlaylistName.value || !playlistTargetSong.value) return;
  if (addingPlaylistId.value) return;
  addingPlaylistId.value = "new";
  try {
    const res = await api.post("/rest/createPlaylist", { name: newPlaylistName.value, songId: playlistTargetSong.value.id });
    ElMessage.success(`已创建并添加「${newPlaylistName.value}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "创建失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

async function toggleCurrentFavorite() {
  const song = playerStore.currentSong;
  if (!song) return;
  try {
    const fav = await favoritesStore.toggleFavorite(song.id);
    ElMessage.success(fav ? "已添加到我喜欢的音乐" : "已从我喜欢的音乐移除");
  } catch (e: any) { ElMessage.error(e.message || "操作失败"); }
}

const dlnaScanning = ref(false);

const peerSwitcherVisible = ref(false);
const volumePopoverVisible = ref(false);

/* ===== 手机端滑动/系统返回关闭所有弹窗 =====
   思路：任一弹窗（播放模式/播放列表/更多/音量/侧边栏）打开时 history.pushState
   占位（URL 不变），系统返回手势触发 popstate 时按优先级关闭最上层弹窗并重新
   占位；全部弹窗关闭后 back() 消费占位，使下一次返回恢复正常路由后退。 */
const overlaySources = [
  () => playerStore.playModeVisible,
  () => playerStore.showPlaylist,
  () => mobileControlsVisible.value,
  () => volumePopoverVisible.value,
  () => mobileNavOpen.value,
];
function closeTopOverlay(): boolean {
  if (playerStore.playModeVisible) { playerStore.playModeVisible = false; return true; }
  if (playerStore.showPlaylist) { playerStore.showPlaylist = false; return true; }
  if (mobileControlsVisible.value) { mobileControlsVisible.value = false; return true; }
  if (volumePopoverVisible.value) { volumePopoverVisible.value = false; return true; }
  if (mobileNavOpen.value) { mobileNavOpen.value = false; return true; }
  return false;
}
/* ===== 手机端滑动返回关闭所有弹窗 =====
   左缘右滑手势（iOS 风格）→ 关闭最上层弹窗（播放模式/播放列表/更多/音量/侧边栏）。
   纯应用内手势，不触碰 history，避免与 vue-router 的 history state 冲突。 */
let overlayPrevOpen = false;
watch(overlaySources, (now) => {
  if (!isMobile.value) { overlayPrevOpen = now.some(Boolean); return; }
  overlayPrevOpen = now.some(Boolean);
}, { flush: "sync" });
function anyOverlayOpen(): boolean {
  return playerStore.playModeVisible || playerStore.showPlaylist ||
    mobileControlsVisible.value || volumePopoverVisible.value || mobileNavOpen.value;
}
// 手势状态
let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartT = 0;
let swipeActive = false;
function onSwipeTouchStart(e: TouchEvent) {
  if (!isMobile.value) return;
  const t = e.touches[0];
  if (t.clientX > 44) return;             // 仅从左缘开始的手势
  swipeStartX = t.clientX;
  swipeStartY = t.clientY;
  swipeStartT = Date.now();
  swipeActive = true;
}
function onSwipeTouchMove(e: TouchEvent) {
  if (!swipeActive) return;
  const t = e.touches[0];
  const dx = t.clientX - swipeStartX;
  const dy = t.clientY - swipeStartY;
  // 判定为右滑手势后阻止默认（避免触发浏览器边缘返回/滚动冲突）
  if (dx > 10 && Math.abs(dy) < 40) e.preventDefault();
}
function onSwipeTouchEnd(e: TouchEvent) {
  if (!swipeActive) { swipeActive = false; return; }
  swipeActive = false;
  if (!isMobile.value) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeStartX;
  const dy = t.clientY - swipeStartY;
  const dt = Date.now() - swipeStartT;
  // 右滑 > 70px、水平为主、快速滑动
  if (dx > 70 && Math.abs(dy) < 60 && dt < 600) {
    if (anyOverlayOpen()) closeTopOverlay();
    else history.back();                  // 无弹窗：放行系统返回
  }
}
window.addEventListener("touchstart", onSwipeTouchStart, { passive: false });
window.addEventListener("touchmove", onSwipeTouchMove, { passive: false });
window.addEventListener("touchend", onSwipeTouchEnd, { passive: false });
onUnmounted(() => {
  window.removeEventListener("touchstart", onSwipeTouchStart);
  window.removeEventListener("touchmove", onSwipeTouchMove);
  window.removeEventListener("touchend", onSwipeTouchEnd);
});

/** 手机端更多弹窗内打开播放列表：先打开队列面板，再关闭更多弹窗 */
function openMobileQueue() {
  playerStore.showPlaylist = true;
  mobileControlsVisible.value = false;
}

/** 弹窗互斥：更多弹窗一打开就关闭播放列表面板。
 *  用 watch 而非按钮 @click —— el-popover 的 reference 插槽对原生 click 监听
 *  的合并在部分场景不触发（实测点击到达按钮但 @click 未执行）。 */
watch(() => mobileControlsVisible.value, (v) => {
  if (v && playerStore.showPlaylist) playerStore.showPlaylist = false;
});

async function onSwitchPeer(peerId: string) {
  peerSwitcherVisible.value = false;
  await playerStore.switchPeer(peerId);
  playerStore.refreshPeers();
}

async function onMobileSwitchPeer(peerId: string) {
  mobileControlsVisible.value = false;
  await playerStore.switchPeer(peerId);
  playerStore.refreshPeers();
}

function peerPlayingTitle(p: any): string {
  if (!p.queue || !p.queue.isActive) return "";
  const items = p.queue.items || [];
  const idx = p.queue.currentIndex;
  if (idx >= 0 && items[idx]?.title) return items[idx].title;
  return "";
}

async function scanDlnaDevices() {
  if (dlnaScanning.value) return;
  dlnaScanning.value = true;
  try {
    const res = await api.post("/rest/api/v1/dlna/scan");
    const count = (res.data.devices || []).length;
    await playerStore.refreshPeers();
    ElMessage.success(`扫描完成,发现 ${count} 台 DLNA 设备`);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "扫描失败");
  } finally { dlnaScanning.value = false; }
}

nextTick(() => {
  if (!authStore.isLoggedIn) return;
  favoritesStore.loadFavorites();
  import("@/stores/preload").then(({ usePreloadStore }) => usePreloadStore().preloadHome()).catch(() => {});
});

watch(() => playerStore.currentLyricIndex, async (idx) => {
  if (idx < 0) return;
  await nextTick();
  const container = lyricsContainer.value;
  if (!container) return;
  const lines = container.querySelectorAll(".pm-lyric-line");
  const active = lines[idx] as HTMLElement | undefined;
  if (!active) return;
  const cRect = container.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  const targetTop = container.scrollTop + (aRect.top - cRect.top) - container.clientHeight / 2 + active.clientHeight / 2;
  container.scrollTo({ top: targetTop, behavior: "smooth" });
});

async function scrollQueueToCurrent() {
  const idx = playerStore.currentIndex;
  if (idx < 0) return;
  await nextTick();
  const list = queueListEl.value;
  if (!list) return;
  if (list.matches(":hover")) return;
  const active = queueItemEls.value[idx];
  if (!active) return;
  const listRect = list.getBoundingClientRect();
  const itemRect = active.getBoundingClientRect();
  if (itemRect.top >= listRect.top && itemRect.bottom <= listRect.bottom) return;
  const targetTop = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
  list.scrollTo({ top: targetTop, behavior: "smooth" });
}
watch(() => playerStore.currentIndex, scrollQueueToCurrent);
watch(() => playerStore.showPlaylist, (open) => { if (open) scrollQueueToCurrent(); });
</script>

<style lang="scss" scoped>
/* ===== Layout (CSS Grid): sidebar | main  /  player-bar ===== */
.main-layout {
  --current-sidebar: var(--fnos-sidebar-width);
  display: grid;
  grid-template-columns: var(--current-sidebar) 1fr;
  grid-template-rows: 1fr;            /* 播放器改为悬浮退出 grid */
  height: 100vh;
  overflow: hidden;
  position: relative;                 /* 是 .player-bar 绝对定位的锚点 */
  background: transparent;            /* 背景由全屏 .app-bg 承载（平铺整个页面） */
}
.main-layout:has(.sidebar.collapsed) { --current-sidebar: var(--fnos-sidebar-collapsed); }

/* ===== Mobile chrome (only visible < 768px) ===== */
.mobile-header { display: none; }
.sidebar-overlay { display: none; }
.player-bar-mobile { display: none; }

/* ===== Sidebar ===== */
.sidebar {
  grid-column: 1;
  grid-row: 1;
  width: 100%;
  margin: 14px;                /* 恢复原始悬浮卡片样式：四周留白 */
  border-radius: var(--fnos-radius-lg);
  /* 浮动圆角玻璃面板：透明、悬浮于全屏极光背景之上 */
  background: rgba(255, 255, 255, 0.045);
  backdrop-filter: blur(26px) saturate(180%);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.07);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  color: var(--fnos-text-primary);
  display: flex;
  flex-direction: column;
  transition: background 0.3s ease, box-shadow 0.3s ease;
  flex-shrink: 0;
  border-right: none;
  position: relative;
  z-index: 50;
  overflow: hidden;

  .logo {
    display: flex;
    align-items: center;
    padding: 18px 18px;
    cursor: pointer;
    gap: 10px;
    height: var(--fnos-topbar-height);
    flex-shrink: 0;
    .logo-img { width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0; box-shadow: 0 4px 12px rgba(246, 44, 85, 0.35); }
    .logo-text { font-size: 17px; font-weight: 600; white-space: nowrap; letter-spacing: 0.3px; }
  }

  .sidebar-menu {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;   /* 禁止横向滚动（选中高亮/菜单项导致的 30px 级超宽不再可左右滑动） */
    padding: 8px 0;
    background: transparent;
    /* 标题栏展开时空间充足，隐藏滚动条（仍保留滚动能力，避免矮屏内容裁切） */
    scrollbar-width: none;
    -ms-overflow-style: none;
    &::-webkit-scrollbar { display: none; }
    :deep(.el-menu) { background: transparent; border-right: none; }
    :deep(.el-menu-item) {
      height: 40px;
      line-height: 40px;
      margin: 2px 12px;
      padding-left: 14px !important;
      border-radius: 8px;
      font-size: 14px;
      color: var(--fnos-text-secondary) !important;
      background: transparent !important;
      position: relative;
      /* 图标与文字间距统一为 8px，与底部用户名区 (user-info gap: 8px) 一致 */
      gap: 8px;
      &:hover {
        background: rgba(255, 255, 255, 0.06) !important;
        color: var(--fnos-text-primary) !important;
      }
      &.is-active {
        background: linear-gradient(90deg, rgba(246, 44, 85, 0.22) 0%, rgba(246, 44, 85, 0.06) 100%) !important;
        color: var(--fnos-red) !important;
        &::before {
          content: '';
          position: absolute;
          left: 0; top: 8px; bottom: 8px;
          width: 3px;
          background: var(--fnos-red);
          border-radius: 0 2px 2px 0;
          box-shadow: 0 0 12px rgba(246, 44, 85, 0.6);
        }
      }
    }
    :deep(.el-divider) {
      border-color: rgba(255, 255, 255, 0.08);
      margin: 12px 16px;
    }
  }

  .sidebar-footer {
    padding: 12px;
    /* 移除 border-top —— 侧栏底部与上方菜单区是一整块连续画布 */
    border-top: none;
    flex-shrink: 0;
    .user-info {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--fnos-text-secondary);
      cursor: pointer;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 14px;
      &:hover { background: rgba(255, 255, 255, 0.06); color: var(--fnos-text-primary); }
    }
  }
}

/* ===== Main content ===== */
.main-content {
  grid-column: 2;
  grid-row: 1;
  position: relative;
  overflow: hidden;
  z-index: 1;                /* 位于全屏 .app-bg 之上 */
  isolation: isolate;        /* 内容独立层叠上下文 */
}
/* 内层滚动容器，让 page-canvas 始终覆盖可视区而不随内容滚动 */
.main-scroll {
  position: relative;
  z-index: 1;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
}

/* ===== Floating player pill (overlays content; content scrolls BEHIND) ===== */
.player-bar {
  /* 绝对定位悬浮 —— 居中窄药丸 */
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  width: min(870px, calc(100% - 200px));
  height: 84px;
  border-radius: 999px;
  background: rgba(15, 14, 22, 0.55);
  backdrop-filter: blur(32px) saturate(180%);
  -webkit-backdrop-filter: blur(32px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.50), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  overflow: hidden;
  display: flex;
  align-items: center;
  padding: 0 26px 0 40px;
  gap: 14px;
  z-index: 50;

  .player-left {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 8px;
    width: 230px;
    flex-shrink: 0;
    cursor: pointer;
    overflow: hidden;
    border-radius: 14px;
    .np-main {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 52px;
      margin-top: 10px;
    }
    .player-cover {
      width: 52px; height: 52px;
      border-radius: 8px;
      object-fit: cover;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
    .player-cover-placeholder {
      width: 52px; height: 52px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      display: flex; align-items: center; justify-content: center;
      color: rgba(255, 255, 255, 0.4);
      flex-shrink: 0;
    }
    .player-song-info {
      flex: 1; min-width: 0;
      .player-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .player-artist { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .player-lyric { color: var(--fnos-yellow); }
    }
    /* 默认：仅一根可视细线（不显示时间、不可拖） */
    .np-progress-thin {
      position: relative;
      height: 16px;
      display: flex;
      align-items: center;
      cursor: pointer;
      margin-top: auto;
      .np-progress-line {
        position: relative;
        width: 100%;
        height: 4px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.18);
        overflow: hidden;
      }
      .np-progress-fill {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        background: var(--fnos-red);
        border-radius: 2px;
      }
    }
    /* 悬停细线 → 从底部升起的透明玻璃层，遮盖专辑图+歌词，内部放大进度条并显示时间、可拖动 */
    .np-progress-panel {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 12px;
      border-radius: inherit;
      background: rgba(18, 16, 24, 0.5);
      backdrop-filter: blur(20px) saturate(160%);
      -webkit-backdrop-filter: blur(20px) saturate(160%);
      transform: translateY(110%);
      opacity: 0;
      transition: transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.3s ease;
      pointer-events: none;
      cursor: default;
      z-index: 5;
      .np-time { font-size: 11px; color: var(--fnos-text-tertiary); min-width: 40px; text-align: center; }
      .np-slider { flex: 1; }
    }
    .np-progress-thin:hover ~ .np-progress-panel,
    .np-progress-panel:hover {
      transform: translateY(0);
      opacity: 1;
      pointer-events: auto;
    }
  }
  .player-center {
    flex: 1; min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    .player-controls { display: flex; align-items: center; justify-content: center; gap: 12px; }
  }
  .player-right {
    display: flex; align-items: center; gap: 8px;
    flex-shrink: 0; justify-content: flex-end;
    /* 工具按钮（播放列表/添加歌单/我喜欢的音乐/音量）：无边框透明，hover 淡白
       这些裸 el-button circle 没有 .ctrl-btn 类，需单独去 global 默认边框+淡背景 */
    :deep(.el-button.is-circle:not(.play-btn):not(.el-button--primary)) {
      border: none !important;
      background: transparent !important;
      color: rgba(255, 255, 255, 0.85) !important;
      outline: none !important;
      box-shadow: none !important;
      &:hover, &:focus {
        background: rgba(255, 255, 255, 0.1) !important;
        color: #fff !important;
        outline: none !important;
        box-shadow: none !important;
      }
    }
    .vol-btn { color: var(--fnos-text-secondary); }
    .vol-btn.vol-active { color: var(--fnos-red); background: rgba(246, 44, 85, 0.12); }
  }
  .player-title-empty { color: var(--fnos-text-muted); }

  /* 较窄的桌面宽度下，切换播放器按钮收起为纯图标，避免与下一首重叠 */
  @media (max-width: 1000px) {
    .peer-switch-btn {
      max-width: 38px; padding: 0; justify-content: center;
      .peer-switch-label, .peer-switch-arrow { display: none; }
    }
  }

  /* 音量弹出控制条 */
  .volume-popover-body {
    display: flex; align-items: center; gap: 10px;
    padding: 4px 2px;
    .vol-label { font-size: 12px; color: var(--fnos-text-secondary); white-space: nowrap; }
    .volume-pop-slider { flex: 1; }
  }
}

/* ===== Player switcher button ===== */
/* 与其他播放控件按钮一致：无边框透明，hover 淡白（去掉原矩形淡底色"框"） */
.peer-switch-btn {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 160px; padding: 0 10px; height: 30px;
  border: none !important;
  background: transparent !important;
  color: rgba(255, 255, 255, 0.85) !important;
  &:hover, &:focus {
    background: rgba(255, 255, 255, 0.1) !important;
    color: #fff !important;
  }
  .peer-switch-icon { font-size: 14px; }
  .peer-switch-label { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px; }
  .peer-switch-arrow { font-size: 10px; color: var(--fnos-text-tertiary); }
}

/* ===== Transport control buttons ===== */
/* 所有可点击的播放控件按钮统一为无边框透明（对齐手机端默认 4 按钮），
   仅 hover 淡白反馈；主播放按钮与选中态保留红色实心 */
.ctrl-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; min-width: 36px; width: 36px; height: 36px; min-height: 36px;
  border: none !important;
  background: transparent !important;
  color: rgba(255, 255, 255, 0.85) !important;
  &:hover, &:focus {
    background: rgba(255, 255, 255, 0.1) !important;
    color: #fff !important;
  }
}
.ctrl-btn .playback-icon { display: block; }
/* 主播放按钮：保留红色实心（无边框） */
.ctrl-btn.play-btn {
  width: 44px; height: 44px;
  min-width: 44px; min-height: 44px;
  background: var(--fnos-red) !important;
  border-color: var(--fnos-red) !important;
  box-shadow: 0 4px 16px rgba(246, 44, 85, 0.5);
}
/* 选中态（如播放模式/歌单面板激活）：保留红色实心提示 */
.ctrl-btn.el-button--primary {
  background: var(--fnos-red) !important;
  border-color: var(--fnos-red) !important;
  color: #fff !important;
  &:hover { background: var(--fnos-red-hover) !important; }
}
/* 音量按钮：同样无边框透明 */
.vol-btn.el-button {
  border: none !important;
  background: transparent !important;
  color: rgba(255, 255, 255, 0.85) !important;
  &:hover, &:focus { background: rgba(255, 255, 255, 0.1) !important; color: #fff !important; }
}
.vol-btn.vol-active.el-button {
  background: rgba(246, 44, 85, 0.12) !important;
  color: var(--fnos-red) !important;
}

/* ===== Queue panel ===== */
.queue-panel {
  /* 播放器已是悬浮药丸（bottom:18px height:84px，占底部约 102px）——
     队列面板底部避让播放条，不再贴底盖住播放条右端的控制按钮 */
  position: fixed; top: 0; right: 0; bottom: 112px;
  width: 360px;
  background: rgba(31, 28, 42, 0.96);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  z-index: 200;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.45);
  display: flex; flex-direction: column;
  color: var(--fnos-text-primary);
  .queue-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 18px 18px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    font-weight: 600;
    color: var(--fnos-text-primary);
    .queue-actions .el-button { color: var(--fnos-text-secondary); border: none !important; background: transparent !important; }
  }
  .queue-list {
    flex: 1; overflow-y: auto; padding: 8px;
    .queue-item {
      display: flex; align-items: center; gap: 10px;
      padding: 8px; border-radius: 8px; cursor: pointer;
      color: var(--fnos-text-primary-dim);
      &:hover { background: rgba(255, 255, 255, 0.06); }
      &.active {
        background: linear-gradient(90deg, rgba(255, 197, 45, 0.22) 0%, rgba(255, 197, 45, 0.04) 100%);
        color: #ffc52d;
        .queue-artist { color: #ffc52d; opacity: 0.8; }
      }
      .queue-cover {
        position: relative; width: 40px; height: 40px;
        border-radius: 6px; overflow: hidden; flex-shrink: 0;
        img { width: 100%; height: 100%; object-fit: cover; }
        .queue-cover-ph {
          width: 100%; height: 100%;
          background: rgba(255, 255, 255, 0.06);
          display: flex; align-items: center; justify-content: center;
          color: rgba(255, 255, 255, 0.4);
        }
        .playing-indicator {
          position: absolute; inset: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex; align-items: center; justify-content: center;
          &::before {
            content: ''; width: 8px; height: 12px;
            background: linear-gradient(180deg, #ffc52d 0 33%, transparent 33% 66%, #ffc52d 66%);
            animation: eq 1s infinite;
          }
          &.paused::before { animation: none; opacity: 0.7; }
        }
      }
      .queue-info { flex: 1; min-width: 0;
        .queue-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .queue-artist { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      }
      .queue-duration { font-size: 12px; color: var(--fnos-text-tertiary); }
      .queue-remove {
        opacity: 0; transition: opacity 0.2s;
        color: var(--fnos-text-tertiary) !important;
        &:hover { color: var(--fnos-red) !important; }
      }
      &:hover .queue-remove { opacity: 1; }
    }
    .queue-empty { text-align: center; color: var(--fnos-text-muted); padding: 40px 0; }
  }
}

/* ===== Fullscreen play mode (FnOS-inspired aurora) ===== */
.play-mode {
  position: fixed; inset: 0; z-index: 300;
  background: linear-gradient(160deg, #1a1825 0%, #2d293a 40%, #14121b 100%);
  color: #fff; display: flex; flex-direction: column; overflow: hidden;
  .play-mode-bg {
    position: absolute; inset: 0;
    background:
      radial-gradient(ellipse 70% 50% at 30% 30%, rgba(246, 44, 85, 0.22), transparent 60%),
      radial-gradient(ellipse 60% 50% at 75% 70%, rgba(201, 52, 225, 0.18), transparent 60%),
      radial-gradient(ellipse 50% 40% at 50% 100%, rgba(27, 115, 251, 0.14), transparent 60%);
    pointer-events: none;
  }
  .play-mode-close {
    position: absolute; top: 20px; right: 24px; z-index: 10;
    background: rgba(255, 255, 255, 0.1); border: none; color: #fff;
    width: 44px; height: 44px; border-radius: 50%; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.2s;
    &:hover { background: rgba(255, 255, 255, 0.2); }
  }
  .play-mode-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 120px;
    padding: 40px 80px;
    position: relative;
  }
  .pm-left {
    display: flex; flex-direction: column; align-items: center;
    width: 400px; flex-shrink: 0;
    .pm-disc {
      position: relative;
      width: 340px; height: 340px;
      border-radius: 50%; overflow: hidden;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06);
      .pm-disc-img { width: 100%; height: 100%; object-fit: cover; }
      .pm-disc-ph {
        width: 100%; height: 100%;
        background: #1a1a24;
        display: flex; align-items: center; justify-content: center;
        color: rgba(255, 255, 255, 0.3);
      }
      .pm-disc-hole {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 44px; height: 44px;
        border-radius: 50%;
        background: #14121b;
        border: 4px solid rgba(255, 255, 255, 0.18);
      }
      &.spinning { animation: spin 20s linear infinite; }
    }
    .pm-song-title { margin-top: 28px; font-size: 22px; font-weight: 700; text-align: center; max-width: 380px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pm-song-artist { margin-top: 8px; font-size: 15px; color: rgba(255, 255, 255, 0.7); }
    .pm-song-album { margin-top: 4px; font-size: 13px; color: rgba(255, 255, 255, 0.4); }
  }
  .pm-right {
    width: 480px; height: 60vh; overflow-y: auto;
    display: flex; flex-direction: column; align-items: center;
    scrollbar-width: none; scroll-behavior: smooth;
    &::-webkit-scrollbar { display: none; }
    .pm-lyrics { width: 100%; display: flex; flex-direction: column; align-items: center; padding: 45% 0; }
    .pm-lyric-line {
      font-size: 15px;
      color: rgba(255, 255, 255, 0.35);
      padding: 10px 0; text-align: center; line-height: 1.6;
      transition: all 0.4s ease; cursor: default;
      &.active {
        color: var(--fnos-yellow);
        font-size: 21px;
        font-weight: 700;
        text-shadow: 0 0 24px rgba(248, 191, 40, 0.5);
      }
    }
    .pm-lyrics-empty { color: rgba(255, 255, 255, 0.3); font-size: 15px; padding: 60px 0; }
  }
  .play-mode-controls {
    padding: 24px 80px 40px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    position: relative;
    .pm-progress {
      display: flex; align-items: center; gap: 12px;
      width: 100%; max-width: 700px;
      .time { font-size: 12px; color: rgba(255, 255, 255, 0.6); min-width: 40px; }
      .pm-slider { flex: 1; }
    }
    .pm-buttons {
      display: flex; align-items: center; gap: 16px;
      .pm-play-btn { width: 60px; height: 60px; min-width: 60px; min-height: 60px; background: var(--fnos-red) !important; border-color: var(--fnos-red) !important; box-shadow: 0 4px 24px rgba(246, 44, 85, 0.55); }
      .pm-nav-btn { width: 48px; height: 48px; min-width: 48px; min-height: 48px; }
    }
  }
}

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes eq { 0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1); } }

.slide-right-enter-active, .slide-right-leave-active { transition: transform 0.3s ease; }
.slide-right-enter-from, .slide-right-leave-to { transform: translateX(100%); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* 页面切换过渡 */
.page-enter-active,
.page-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.page-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 按钮/控件点击触感反馈 */
.ctrl-btn,
.mp-btn,
.mobile-hamburger {
  transition: transform 0.12s ease, background 0.2s ease;
  &:active { transform: scale(0.92); }
}
.play-btn,
.mp-play,
.mc-play,
.pm-play-btn {
  transition: transform 0.12s ease, box-shadow 0.2s ease;
  &:active { transform: scale(0.94); }
}

:deep(.el-slider__runway) { background: rgba(255, 255, 255, 0.18) !important; }
:deep(.el-slider__bar) { background: var(--fnos-red) !important; }
:deep(.el-slider__button) {
  border: 2px solid var(--fnos-red) !important;
  background: #fff !important;
}
.play-mode :deep(.el-slider__runway) { background: rgba(255, 255, 255, 0.2) !important; }
.play-mode :deep(.el-slider__bar) { background: var(--fnos-red) !important; }
.play-mode :deep(.el-button) {
  border-color: transparent !important;
  color: #fff !important;
  background: transparent !important;   /* 播放模式面板按钮统一透明（无圆形淡白"外框"） */
  box-shadow: none !important;
  outline: none !important;
  &:hover { border-color: transparent !important; background: rgba(255, 255, 255, 0.1) !important; box-shadow: none !important; outline: none !important; }
}
.play-mode :deep(.el-button--primary) {
  background: var(--fnos-red) !important;
  border-color: var(--fnos-red) !important;
  box-shadow: 0 4px 16px rgba(246, 44, 85, 0.5);
  &:hover { background: var(--fnos-red-hover) !important; }
}

/* ===== Heart favorite button ===== */
/* 点亮的心形必须是红色。容器(.player-right/.mc-body/.play-mode)里高优先级的
   `color: … !important` 会强制按钮颜色，但按钮色只影响图标继承；这里直接给图标元素
   本体设色即可越过所有继承（MfIcon 根节点同时带本组件 scope，能命中） */
.fav-btn {
  display: inline-flex; align-items: center; justify-content: center;
  &.active { color: var(--fnos-red); }
  &.active .mf-icon { color: var(--fnos-red); }
  &.active:hover .mf-icon { color: var(--fnos-red-hover); }
}

/* ===== Add-to-playlist dialog ===== */
.playlist-dialog-song { font-size: 13px; color: var(--fnos-text-tertiary); margin-bottom: 12px; }
.playlist-list { max-height: 320px; overflow-y: auto; }
.playlist-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 8px;
  cursor: pointer; transition: background 0.2s;
  &:hover { background: rgba(255, 255, 255, 0.06); }
  .pl-icon { font-size: 18px; color: var(--fnos-text-tertiary); }
  .pl-info {
    flex: 1;
    .pl-name { font-size: 14px; font-weight: 500; color: var(--fnos-text-primary); }
    .pl-meta { font-size: 12px; color: var(--fnos-text-tertiary); }
  }
}
.create-playlist-row {
  display: flex; gap: 8px;
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.empty-tip { text-align: center; color: var(--fnos-text-muted); font-size: 13px; padding: 20px 0; }

/* ============================================================
   Mobile (< 768px): drawer sidebar, compact player bar,
   stacked fullscreen play mode, full-width queue panel.
   ============================================================ */
@media (max-width: 768px) {
  .main-layout {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
    height: 100dvh;   /* 动态视口高度，避免移动端地址栏导致底部被截断 */
  }

  /* --- Top bar --- */
  .mobile-header {
    display: flex; align-items: center; gap: 8px;
    height: 48px; padding: 0 12px; flex-shrink: 0;
    /* 移除 border-bottom —— 顶栏与下方内容是一整块连续画布 */
    background: transparent;
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    color: #fff; z-index: 500;
    border-bottom: none;
    grid-column: 1; grid-row: 1;
    align-self: flex-start;
    /* 与 .play-mode 的 fade(0.3s) 同步交叉淡化，避免 display:none 瞬切造成闪烁 */
    transition: opacity 0.3s ease, visibility 0.3s ease;
    .mobile-hamburger {
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; border: none; border-radius: 6px;
      background: transparent; color: #fff; cursor: pointer;
      &:active { background: rgba(255, 255, 255, 0.15); }
    }
    .mobile-brand-logo { width: 26px; height: 26px; border-radius: 6px; }
    .mobile-brand { font-size: 16px; font-weight: 600; }
  }

  /* --- Drawer sidebar (out of flow on mobile) --- */
  .sidebar-overlay {
    display: block; position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    z-index: 590;
  }
  .sidebar.mobile {
    grid-column: auto; grid-row: auto;
    position: fixed; top: 0; left: 0; bottom: 0;
    width: min(280px, 82vw); z-index: 600;
    transform: translateX(-100%); transition: transform 0.3s ease;   /* 与 sidebar-overlay fade(0.3s) 时长对齐，避免微差不同步 */
    background: rgba(31, 28, 42, 0.94);
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0 18px 18px 0;
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5);
    &.mobile-open { transform: translateX(0); }
    &.collapsed { width: min(280px, 82vw); }
    /* 移动端侧边栏同样隐藏滚动条（含 Element Plus 内部滚动容器） */
    .sidebar-menu,
    :deep(.el-menu),
    :deep(.el-menu--popup) {
      scrollbar-width: none;
      -ms-overflow-style: none;
      &::-webkit-scrollbar { display: none; }
    }
  }

  /* --- Main content occupies full width --- */
  .main-content {
    grid-column: 1; grid-row: 1;
    /* mobile-header is grid-row 1 already and main-content overlaps it because
       mobile-header is in flow at top; we add padding to account for it. */
  }

  /* Desktop player bar hidden; mobile compact bar shown as floating pill */
  .player-bar { display: none; }
  .player-bar-mobile {
    /* 悬浮药丸 —— 退出 grid，贴底悬浮；内容从它后面透出来 */
    position: fixed;
    bottom: 12px;
    left: 12px;
    right: 12px;
    height: 64px;
    border-radius: 18px;
    background: rgba(15, 14, 22, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.08);
    /* 移除 border-top —— 播放器是悬浮的，不再是底栏 */
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    z-index: 520;   /* 始终在最前：高于内容页与顶栏(500)，低于弹窗层(queue 550 / sidebar 600 / playmode 700) */
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px;
    /* 与 .play-mode 的 fade(0.3s) 同步交叉淡化，避免 display:none 瞬切造成闪烁 */
    transition: opacity 0.3s ease, visibility 0.3s ease;
    .mp-cover {
      width: 44px; height: 44px; border-radius: 8px; overflow: hidden; flex-shrink: 0;
      cursor: pointer;
      img { width: 100%; height: 100%; object-fit: cover; }
      .mp-cover-ph { width: 100%; height: 100%; background: rgba(255, 255, 255, 0.06); display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.4); }
    }
    .mp-info { flex: 1; min-width: 0; cursor: pointer;
      .mp-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mp-artist { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mp-lyric { color: var(--fnos-yellow); }
    }
    .mp-controls { display: flex; align-items: center; gap: 4px; flex-shrink: 0;
      .mp-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 34px; height: 34px; border: none; border-radius: 50%;
        background: transparent; color: #fff; cursor: pointer;
        &:active { background: rgba(255, 255, 255, 0.1); }
        &.mp-play {
          background: var(--fnos-red); color: #fff;
          width: 42px; height: 42px;
          box-shadow: 0 4px 12px rgba(246, 44, 85, 0.5);
        }
        &.mp-more.active { color: var(--fnos-red); }
      }
    }
  }

  /* Mobile main-content (non-scrolling wrapper); main-scroll handles scroll + top padding */
  .main-content { padding-top: 0; }

  /* --- Main scroll container on mobile: account for mobile-header + floating player pill --- */
  .main-scroll { padding-top: 48px; padding-bottom: 88px; }

  /* --- Queue panel: 移动端卡片式浮层（不全宽不全高）---
     左右留边距、底部在播放条上方留空隙截断；想看更多在面板内滚动下拉。
     z-index 550：高于播放条(520)/顶栏(500)，低于侧边栏(600)。 */
  .queue-panel {
    width: calc(100% - 24px);
    left: 12px; right: 12px;
    top: auto;
    bottom: 88px;               /* 播放条(76)上方留 12px 空隙 */
    height: min(58vh, 460px);
    max-height: 62vh;
    border-radius: 18px;
    border-left: none;
    z-index: 550;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  }

  /* --- Fullscreen play mode: stacked single column --- */
  .play-mode { overflow-y: auto; z-index: 700; }
  /* 播放模式打开时隐藏顶栏/播放条：用 opacity+visibility 过渡（与 play-mode
     的 fade 0.3s 同步交叉淡化），不再用 display:none 瞬切 —— 瞬切会让
     顶栏/播放条瞬间消失而 play-mode 还在半透明淡入，造成强烈闪烁。 */
  .mc-hidden {
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
  .play-mode .play-mode-body {
    flex-direction: column; justify-content: flex-start;
    gap: 8px; padding: 20px 16px 6px;
    .pm-left { width: 100%;
      .pm-disc { width: min(200px, 56vw); height: min(200px, 56vw); }
      .pm-song-title { margin-top: 10px; font-size: 16px; max-width: 100%; }
      .pm-song-artist { font-size: 13px; margin-top: 4px; }
      .pm-song-album { font-size: 12px; }
    }
    .pm-right { width: 100%; height: min(200px, 24vh); min-height: 88px; }
    .pm-lyrics { padding: 30% 0; }
    .pm-lyric-line { font-size: 13px; padding: 6px 0; }
    .pm-lyric-line.active { font-size: 17px; }
  }
  .play-mode .play-mode-controls { padding: 6px 16px 14px; gap: 8px;
    .pm-progress { max-width: none; }
    .pm-buttons { gap: 12px;
      .pm-play-btn { width: 48px; height: 48px; min-width: 48px; min-height: 48px; }
      .pm-nav-btn { width: 40px; height: 40px; min-width: 40px; min-height: 40px; }
    }
  }
  .play-mode .play-mode-close { top: 12px; right: 12px; width: 38px; height: 38px; }

  /* Dialog paddings stay compact on phones */
  .create-playlist-row { flex-direction: column; align-items: stretch; }
  .create-playlist-row .el-button { margin-left: 0 !important; }
}
</style>

<!-- Non-scoped: el-popover teleports the popper to <body>, so scoped styles
     won't reach it. These rules style the player-switcher popup content. -->
<style lang="scss">
.peer-switcher-popover.el-popover.el-popper { padding: 0 !important; }
.peer-switcher { width: 100%; }
.peer-switcher-title { font-size: 13px; font-weight: 600; color: var(--fnos-text-primary); padding: 12px 14px 8px; }
.peer-switcher-list { max-height: 320px; overflow-y: auto; padding: 0 6px; }
.peer-switcher-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 8px;
  cursor: pointer; transition: background 0.15s;
  color: var(--fnos-text-primary-dim);
  &:hover { background: rgba(255, 255, 255, 0.06); }
  &.active {
    background: linear-gradient(90deg, rgba(246, 44, 85, 0.18) 0%, rgba(246, 44, 85, 0.04) 100%);
    .psi-name { color: var(--fnos-red); }
    .psi-icon { color: var(--fnos-red); }
  }
  &.unavailable { opacity: 0.55; }
  .psi-icon { font-size: 18px; color: var(--fnos-text-tertiary); flex-shrink: 0; }
  .psi-info { flex: 1; min-width: 0;
    .psi-name {
      font-size: 14px; font-weight: 500;
      display: flex; align-items: center; gap: 6px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .psi-offline {
      font-size: 11px; color: #fff;
      background: var(--fnos-text-muted); border-radius: 8px;
      padding: 0 6px;
    }
    .psi-meta {
      font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      .psi-playing-title { color: var(--fnos-green); font-weight: 500; }
    }
  }
  .psi-check { color: var(--fnos-red); font-size: 16px; flex-shrink: 0; }
}
.peer-switcher-empty { text-align: center; color: var(--fnos-text-muted); font-size: 13px; padding: 20px 0; }
.peer-switcher-scan {
  display: flex; justify-content: center;
  padding: 8px 12px; border-top: 1px solid rgba(255, 255, 255, 0.06);
  .el-button { width: 100%; }
}
.peer-switcher-tip { font-size: 11px; color: var(--fnos-text-muted); padding: 8px 14px 12px; line-height: 1.5; }

/* ===== Mobile "more" controls popover ===== */
.mobile-controls-popover.el-popover.el-popper {
  padding: 0 !important;
  max-width: calc(100vw - 24px) !important;
  background: rgba(24, 22, 33, 0.98) !important;
  backdrop-filter: none !important;
  isolation: isolate;
}
.mc-body { width: 100%; max-height: 72vh; overflow-y: auto; color: var(--fnos-text-primary-dim); }
.mc-section {
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  &:last-child { border-bottom: none; }
}
.mc-title { font-size: 13px; font-weight: 600; color: var(--fnos-text-primary); margin-bottom: 8px; }
.mc-peer-list { max-height: 220px; overflow-y: auto; }
.mc-peer-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 8px; border-radius: 8px; cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.06); }
  &.active {
    background: linear-gradient(90deg, rgba(246, 44, 85, 0.18) 0%, rgba(246, 44, 85, 0.04) 100%);
    .mc-peer-name { color: var(--fnos-red); }
    .mc-peer-icon { color: var(--fnos-red); }
  }
  &.unavailable { opacity: 0.55; }
  .mc-peer-icon { font-size: 18px; color: var(--fnos-text-tertiary); flex-shrink: 0; }
  .mc-peer-info { flex: 1; min-width: 0;
    .mc-peer-name {
      font-size: 14px; font-weight: 500;
      display: flex; align-items: center; gap: 6px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .mc-peer-offline { font-size: 11px; color: #fff; background: var(--fnos-text-muted); border-radius: 8px; padding: 0 6px; flex-shrink: 0; }
    .mc-peer-meta {
      font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      .mc-playing-title { color: var(--fnos-green); font-weight: 500; }
    }
  }
  .mc-peer-check { color: var(--fnos-red); font-size: 16px; flex-shrink: 0; }
}
.mc-peer-empty { text-align: center; color: var(--fnos-text-muted); font-size: 13px; padding: 16px 0; }
.mc-scan { padding-top: 8px;
  .el-button { width: 100%; }
}
.mc-progress {
  display: flex; align-items: center; gap: 8px;
  .mc-time { font-size: 12px; color: var(--fnos-text-tertiary); min-width: 36px; }
  .mc-slider { flex: 1; }
}
.mc-ctrl-row {
  display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap;
  .mc-play {
    width: 48px; height: 48px;
    min-width: 48px; min-height: 48px;
    background: var(--fnos-red) !important; border-color: var(--fnos-red) !important;
    box-shadow: 0 4px 16px rgba(246, 44, 85, 0.5);
  }
}
/* 更多弹窗内所有可点击按钮：无边框透明（对齐手机端默认 4 按钮），hover 淡白 */
.mc-body .el-button {
  border: none !important;
  background: transparent !important;
  color: rgba(255, 255, 255, 0.85) !important;
  outline: none !important;
  box-shadow: none !important;
  &:hover, &:focus {
    background: rgba(255, 255, 255, 0.1) !important;
    color: #fff !important;
    outline: none !important;
    box-shadow: none !important;
  }
}
/* 更多弹窗主播放按钮 / 选中态：保留红色实心 */
.mc-body .el-button.mc-play,
.mc-body .el-button.el-button--primary {
  background: var(--fnos-red) !important;
  border-color: var(--fnos-red) !important;
  color: #fff !important;
  &:hover, &:focus { background: var(--fnos-red-hover) !important; border-color: var(--fnos-red-hover) !important; }
}
.mc-tools {
  display: flex; align-items: center; gap: 10px;
  .mc-volume {
    flex: 1; display: flex; align-items: center; gap: 8px; margin-left: 4px;
    .mc-vol-label { font-size: 12px; color: var(--fnos-text-tertiary); white-space: nowrap; }
    .mc-vol-slider { flex: 1; }
  }
}
</style>

<style lang="scss">
/* 全局兜底：点亮的心形强制红色。
   容器（.player-right/.mc-body/.play-mode）里 `color: … !important` 只作用于按钮本身，
   此处直接给图标本体设色，优先级高于 MfIcon 的 `color: currentColor`，且不依赖 scope 属性。 */
.fav-btn.active .mf-icon { color: var(--fnos-red); }
.fav-btn.active:hover .mf-icon { color: var(--fnos-red-hover); }
</style>