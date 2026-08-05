<template>
  <div class="main-layout" :class="pageTheme">
    <!-- 全屏统一底层（标题栏/侧栏所在的收敛端：所有页面同一主体色调） -->
    <div class="app-bg" aria-hidden="true"></div>
    <!-- ===== Mobile top bar ===== -->
    <header class="mobile-header" v-if="isMobile" :class="{ 'mc-hidden': playerStore.playModeVisible }">
      <button type="button" class="mobile-hamburger" aria-label="菜单" @click="mobileNavOpen = !mobileNavOpen">
        <el-icon :size="22"><Menu /></el-icon>
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
        <el-menu-item index="/"><el-icon><HomeFilled /></el-icon><template #title>首页</template></el-menu-item>
        <el-menu-item index="/songs"><el-icon><Headset /></el-icon><template #title>音乐</template></el-menu-item>
        <el-menu-item index="/genres"><el-icon><Collection /></el-icon><template #title>风格</template></el-menu-item>
        <el-menu-item index="/albums"><el-icon><Service /></el-icon><template #title>专辑</template></el-menu-item>
        <el-menu-item index="/artists"><el-icon><User /></el-icon><template #title>艺术家</template></el-menu-item>
        <el-menu-item index="/playlists"><el-icon><List /></el-icon><template #title>歌单</template></el-menu-item>
        <el-menu-item index="/favorites"><el-icon><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 21s-7-4.5-9.5-9.2C.7 8.4 2.5 4.5 6 4.5c2 0 3.4 1.1 4.2 2.5C11.1 5.6 12.5 4.5 14.5 4.5c3.5 0 5.3 3.9 3.5 7.3C19 16.5 12 21 12 21z"/></svg></el-icon><template #title>我喜欢的音乐</template></el-menu-item>
        <el-menu-item index="/groups"><el-icon><Box /></el-icon><template #title>播放器群组</template></el-menu-item>
        <el-menu-item index="/history"><el-icon><Clock /></el-icon><template #title>播放历史</template></el-menu-item>
        <el-divider v-if="authStore.isAdmin" />
        <el-menu-item v-if="authStore.isAdmin" index="/admin/music"><el-icon><Search /></el-icon><template #title>音乐管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/plugins"><el-icon><Connection /></el-icon><template #title>插件管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/sources"><el-icon><FolderOpened /></el-icon><template #title>媒体源</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/users"><el-icon><UserFilled /></el-icon><template #title>用户管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/wish"><el-icon><ChatDotRound /></el-icon><template #title>许愿</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/settings"><el-icon><Setting /></el-icon><template #title>系统设置</template></el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <el-dropdown @command="handleCommand">
          <span class="user-info"><el-icon><UserFilled /></el-icon><span v-if="!sidebarCollapsed || isMobile">{{ authStore.username }}</span></span>
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
      <!-- 内容区极光层：各页强调色，向上渗透、在标题栏处收敛回统一主体色 -->
      <div class="content-aurora" :class="pageTheme" aria-hidden="true"></div>
      <!-- 可滚动内容 -->
      <div class="main-scroll"><router-view /></div>
    </main>

    <!-- ===== Mobile player bar (compact) ===== -->
    <footer class="player-bar-mobile" v-if="isMobile" :class="{ 'mc-hidden': playerStore.playModeVisible }">
      <div class="mp-cover" @click="playerStore.togglePlayMode">
        <img v-if="coverUrl" :src="coverUrl" />
        <div v-else class="mp-cover-ph"><el-icon :size="20"><Headset /></el-icon></div>
      </div>
      <div class="mp-info" @click="playerStore.togglePlayMode">
        <div class="mp-title">{{ playerStore.currentSong ? playerStore.currentSong.title : '未在播放' }}</div>
        <div class="mp-artist">
          <span v-if="playerStore.currentLyricLine" class="mp-lyric">{{ playerStore.currentLyricLine }}</span>
          <span v-else>{{ playerStore.currentSong ? playerStore.currentSong.artist : '选择一首歌曲开始播放' }}</span>
        </div>
      </div>
      <div class="mp-controls">
        <button type="button" class="mp-btn" @click="playerStore.prev"><PlaybackIcon name="prev" :size="18" /></button>
        <button type="button" class="mp-btn mp-play" :class="{ active: playerStore.isPlaying }" @click="playerStore.togglePlay">
          <PlaybackIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="24" />
        </button>
        <button type="button" class="mp-btn" @click="playerStore.next"><PlaybackIcon name="next" :size="18" /></button>

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
              <el-icon :size="18"><MoreFilled /></el-icon>
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
                  <el-icon class="mc-peer-icon">
                    <Headset v-if="p.kind === 'local'" />
                    <Box v-else-if="p.kind === 'group'" />
                    <Monitor v-else />
                  </el-icon>
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
                  <el-icon v-if="p.peerId === playerStore.currentPeerId" class="mc-peer-check"><Check /></el-icon>
                </div>
                <div v-if="playerStore.peers.length === 0" class="mc-peer-empty">暂无可用播放器</div>
              </div>
              <div class="mc-scan">
                <el-button size="small" :loading="dlnaScanning" @click="scanDlnaDevices">
                  <el-icon><Refresh /></el-icon>重新扫描DLNA设备
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
                  <PlaybackIcon :name="playModeIconName" :size="16" />
                </el-button>
              </el-tooltip>
              <el-button circle @click="playerStore.prev"><PlaybackIcon name="prev" :size="22" /></el-button>
              <el-button circle type="primary" class="mc-play" @click="playerStore.togglePlay">
                <PlaybackIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="28" />
              </el-button>
              <el-button circle @click="playerStore.next"><PlaybackIcon name="next" :size="22" /></el-button>
              <el-button circle size="small" :icon="List" @click="playerStore.togglePlaylistPanel" :type="playerStore.showPlaylist ? 'primary' : ''" />
            </div>

            <!-- Tools: add to playlist, favorite, volume -->
            <div class="mc-section mc-tools">
              <el-tooltip content="添加到歌单" placement="top">
                <el-button circle size="small" :icon="Plus" @click="openAddToPlaylist" />
              </el-tooltip>
              <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
                <el-button circle size="small" class="fav-btn" @click="toggleCurrentFavorite">
                  <HeartIcon :filled="isCurrentFavorite" :size="16" />
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
      <div class="player-left" v-if="playerStore.currentSong" @click="playerStore.togglePlayMode">
        <img v-if="coverUrl" :src="coverUrl" class="player-cover" />
        <div v-else class="player-cover-placeholder"><el-icon :size="24"><Headset /></el-icon></div>
        <div class="player-song-info">
          <div class="player-title">{{ playerStore.currentSong.title }}</div>
          <div class="player-artist">
            <span v-if="playerStore.currentLyricLine" class="player-lyric">{{ playerStore.currentLyricLine }}</span>
            <span v-else>{{ playerStore.currentSong.artist }}</span>
          </div>
        </div>
      </div>
      <div class="player-left" v-else>
        <div class="player-cover-placeholder"><el-icon :size="24"><Headset /></el-icon></div>
        <div class="player-song-info">
          <div class="player-title player-title-empty">未在播放</div>
          <div class="player-artist">选择一首歌曲开始播放</div>
        </div>
      </div>
      <div class="player-center">
        <div class="player-controls">
          <el-tooltip :content="playModeTooltip" placement="top">
            <el-button circle size="small" @click="playerStore.cyclePlayMode" :type="playerStore.playMode !== 'order' ? 'primary' : ''" class="ctrl-btn">
              <PlaybackIcon :name="playModeIconName" :size="16" />
            </el-button>
          </el-tooltip>
          <el-tooltip content="上一首" placement="top">
            <el-button circle @click="playerStore.prev" class="ctrl-btn"><PlaybackIcon name="prev" :size="20" /></el-button>
          </el-tooltip>
          <el-tooltip :content="playerStore.isPlaying ? '暂停' : '播放'" placement="top">
            <el-button circle @click="playerStore.togglePlay" type="primary" class="ctrl-btn play-btn">
              <PlaybackIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="26" />
            </el-button>
          </el-tooltip>
          <el-tooltip content="下一首" placement="top">
            <el-button circle @click="playerStore.next" class="ctrl-btn"><PlaybackIcon name="next" :size="20" /></el-button>
          </el-tooltip>
        </div>
        <div class="player-progress">
          <span class="time">{{ formatTime(playerStore.currentTime) }}</span>
          <el-slider :model-value="playerStore.progress" @input="playerStore.seekPercent" :show-tooltip="false" class="progress-slider" />
          <span class="time">{{ formatTime(playerStore.duration) }}</span>
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
            <el-button class="peer-switch-btn" size="small" :title="`切换播放器: ${playerStore.currentPeerName}`">
              <el-icon class="peer-switch-icon"><Connection /></el-icon>
              <span class="peer-switch-label">{{ playerStore.currentPeerName }}</span>
              <el-icon class="peer-switch-arrow"><ArrowUp /></el-icon>
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
                <el-icon class="psi-icon">
                  <Headset v-if="p.kind === 'local'" />
                  <Box v-else-if="p.kind === 'group'" />
                  <Monitor v-else />
                </el-icon>
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
                <el-icon v-if="p.peerId === playerStore.currentPeerId" class="psi-check"><Check /></el-icon>
              </div>
              <div v-if="playerStore.peers.length === 0" class="peer-switcher-empty">暂无可用播放器</div>
            </div>
            <div class="peer-switcher-scan">
              <el-button size="small" :loading="dlnaScanning" @click="scanDlnaDevices">
                <el-icon><Refresh /></el-icon>重新扫描DLNA设备
              </el-button>
            </div>
            <div class="peer-switcher-tip">切换播放器仅改变当前控制目标,不会停止其他播放器</div>
          </div>
        </el-popover>
        <!-- 播放列表 -->
        <el-tooltip content="播放列表" placement="top">
          <el-button :icon="List" circle size="small" @click="playerStore.togglePlaylistPanel" :type="playerStore.showPlaylist ? 'primary' : ''" />
        </el-tooltip>
        <!-- 添加到歌单 -->
        <el-tooltip content="添加到歌单" placement="top">
          <el-button :icon="Plus" circle size="small" @click="openAddToPlaylist" />
        </el-tooltip>
        <!-- 我喜欢的音乐 -->
        <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
          <el-button circle size="small" class="fav-btn" @click="toggleCurrentFavorite">
            <HeartIcon :filled="isCurrentFavorite" :size="16" />
          </el-button>
        </el-tooltip>
        <!-- 音量：点击展开控制条（去掉常驻滑块，更清爽） -->
        <el-popover placement="top" :width="210" trigger="click" v-model:visible="volumePopoverVisible" popper-class="volume-popover">
          <template #reference>
            <el-button circle size="small" :class="{ 'vol-active': volumePopoverVisible }" class="vol-btn">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M4 9v6h4l5 5V4L8 9H4z" />
                <template v-if="playerStore.volume > 0">
                  <path d="M16 8.5a4.5 4.5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  <path d="M18.5 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </template>
                <template v-else>
                  <line x1="16" y1="9" x2="21" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  <line x1="21" y1="9" x2="16" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </template>
              </svg>
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
      <div class="queue-panel" v-if="playerStore.showPlaylist && playerStore.currentSong">
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
              <div v-else class="queue-cover-ph"><el-icon><Headset /></el-icon></div>
              <span v-if="idx === playerStore.currentIndex" class="playing-indicator" :class="{ paused: !playerStore.isPlaying }"></span>
            </div>
            <div class="queue-info">
              <div class="queue-title">{{ song.title }}</div>
              <div class="queue-artist">{{ song.artist }}</div>
            </div>
            <div class="queue-duration">{{ formatTime(song.duration) }}</div>
            <el-button :icon="Close" circle size="small" text class="queue-remove" @click.stop="removeFromQueue(idx)" />
          </div>
          <div v-if="playerStore.queue.length === 0" class="queue-empty">队列为空</div>
        </div>
      </div>
    </transition>

    <!-- ===== Fullscreen play mode (NetEase style) ===== -->
    <transition name="fade">
      <div class="play-mode" v-if="playerStore.playModeVisible && playerStore.currentSong">
        <div class="play-mode-bg"></div>
        <button class="play-mode-close" @click="playerStore.togglePlayMode"><el-icon :size="24"><Close /></el-icon></button>

        <div class="play-mode-body">
          <!-- Left: rotating disc -->
          <div class="pm-left">
            <div class="pm-disc" :class="{ spinning: playerStore.isPlaying }">
              <img v-if="coverUrl" :src="coverUrl" class="pm-disc-img" />
              <div v-else class="pm-disc-ph"><el-icon :size="80"><Headset /></el-icon></div>
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
                <PlaybackIcon :name="playModeIconName" :size="18" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="上一首" placement="top">
              <el-button circle @click="playerStore.prev" class="ctrl-btn pm-nav-btn"><PlaybackIcon name="prev" :size="26" /></el-button>
            </el-tooltip>
            <el-tooltip :content="playerStore.isPlaying ? '暂停' : '播放'" placement="top">
              <el-button circle @click="playerStore.togglePlay" type="primary" class="ctrl-btn pm-play-btn">
                <PlaybackIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="30" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="下一首" placement="top">
              <el-button circle @click="playerStore.next" class="ctrl-btn pm-nav-btn"><PlaybackIcon name="next" :size="26" /></el-button>
            </el-tooltip>
            <el-tooltip content="添加到歌单" placement="top">
              <el-button :icon="Plus" circle size="small" @click="openAddToPlaylist" />
            </el-tooltip>
            <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
              <el-button
                circle
                size="small"
                class="fav-btn pm-fav-btn"
                @click="toggleCurrentFavorite"
              >
                <HeartIcon :filled="isCurrentFavorite" :size="18" />
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
          <el-icon class="pl-icon"><List /></el-icon>
          <div class="pl-info">
            <div class="pl-name">{{ pl.name }}</div>
            <div class="pl-meta">{{ pl.songCount }}首</div>
          </div>
          <el-icon v-if="addingPlaylistId === pl.id" class="el-icon is-loading"><Loading /></el-icon>
        </div>
        <div v-if="playlists.length === 0 && !playlistsLoading" class="empty-tip">暂无歌单，先创建一个吧</div>
      </div>
      <div class="create-playlist-row">
        <el-input v-model="newPlaylistName" placeholder="新建歌单名称..." clearable @keyup.enter="createAndAdd" />
        <el-button type="primary" @click="createAndAdd" :disabled="!newPlaylistName">新建并添加</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { Headset, HomeFilled, User, List, Clock, Search, Connection, FolderOpened, UserFilled, Setting, Close, Plus, Loading, Collection, Monitor, Refresh, ArrowUp, Check, Box, Menu, MoreFilled } from "@element-plus/icons-vue";
import HeartIcon from "@/components/HeartIcon.vue";
import PlaybackIcon from "@/components/PlaybackIcon.vue";
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
    case "one": return "loopOne";
    case "all": return "loopAll";
    case "shuffle": return "shuffle";
    default: return "order";
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
  margin: 14px;                /* 四周留白，使面板悬浮于全屏背景之上 */
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
    padding: 8px 0;
    background: transparent;
    &::-webkit-scrollbar { width: 4px; }
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
      .el-icon { font-size: 16px; }
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
  /* 绝对定位悬浮 —— 不再占 grid 一行、也不把内容往上推 */
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  width: min(980px, calc(100% - 32px));
  height: 76px;
  border-radius: 999px;
  background: rgba(15, 14, 22, 0.55);
  backdrop-filter: blur(32px) saturate(180%);
  -webkit-backdrop-filter: blur(32px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.50), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  padding: 0 18px;
  gap: 14px;
  z-index: 50;

  .player-left {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 230px;
    flex-shrink: 0;
    cursor: pointer;
    overflow: hidden;
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
      .player-lyric { color: var(--fnos-red); }
    }
  }
  .player-center {
    flex: 1; min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    .player-controls { display: flex; align-items: center; gap: 12px; }
    .player-progress {
      display: flex; align-items: center; gap: 10px;
      width: 100%;
      margin-top: 4px;
      .time { font-size: 11px; color: var(--fnos-text-tertiary); min-width: 40px; text-align: center; }
      .progress-slider { flex: 1; }
    }
  }
  .player-right {
    display: flex; align-items: center; gap: 8px;
    flex-shrink: 0; justify-content: flex-end;
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
.peer-switch-btn {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 160px; padding: 0 10px; height: 30px;
  background: rgba(255, 255, 255, 0.06) !important;
  border-color: rgba(255, 255, 255, 0.12) !important;
  .peer-switch-icon { font-size: 14px; }
  .peer-switch-label { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px; }
  .peer-switch-arrow { font-size: 10px; color: var(--fnos-text-tertiary); }
}

/* ===== Transport control buttons ===== */
.ctrl-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; min-width: 36px; width: 36px; height: 36px; min-height: 36px;
}
.ctrl-btn .playback-icon { display: block; }
.ctrl-btn.play-btn {
  width: 44px; height: 44px;
  min-width: 44px; min-height: 44px;
  background: var(--fnos-red) !important;
  border-color: var(--fnos-red) !important;
  box-shadow: 0 4px 16px rgba(246, 44, 85, 0.5);
}

/* ===== Queue panel ===== */
.queue-panel {
  /* 播放器已是悬浮药丸，不再占底部空间 —— 队列面板直接贴底 */
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 360px;
  background: rgba(31, 28, 42, 0.92);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
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
    .queue-actions .el-button { color: var(--fnos-text-secondary); }
  }
  .queue-list {
    flex: 1; overflow-y: auto; padding: 8px;
    .queue-item {
      display: flex; align-items: center; gap: 10px;
      padding: 8px; border-radius: 8px; cursor: pointer;
      color: var(--fnos-text-primary-dim);
      &:hover { background: rgba(255, 255, 255, 0.06); }
      &.active {
        background: linear-gradient(90deg, rgba(246, 44, 85, 0.22) 0%, rgba(246, 44, 85, 0.04) 100%);
        color: var(--fnos-red);
        .queue-artist { color: var(--fnos-red); opacity: 0.8; }
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
            background: linear-gradient(180deg, var(--fnos-red) 0 33%, transparent 33% 66%, var(--fnos-red) 66%);
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
        color: var(--fnos-red);
        font-size: 21px;
        font-weight: 700;
        text-shadow: 0 0 24px rgba(246, 44, 85, 0.5);
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

:deep(.el-slider__runway) { background: rgba(255, 255, 255, 0.18) !important; }
:deep(.el-slider__bar) { background: var(--fnos-red) !important; }
:deep(.el-slider__button) {
  border: 2px solid var(--fnos-red) !important;
  background: #fff !important;
}
.play-mode :deep(.el-slider__runway) { background: rgba(255, 255, 255, 0.2) !important; }
.play-mode :deep(.el-slider__bar) { background: var(--fnos-red) !important; }
.play-mode :deep(.el-button) {
  border-color: rgba(255, 255, 255, 0.55) !important;
  color: #fff !important;
  background: rgba(255, 255, 255, 0.08) !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  &:hover { border-color: rgba(255, 255, 255, 0.85) !important; background: rgba(255, 255, 255, 0.16) !important; }
}
.play-mode :deep(.el-button--primary) {
  background: var(--fnos-red) !important;
  border-color: var(--fnos-red) !important;
  box-shadow: 0 4px 16px rgba(246, 44, 85, 0.5);
  &:hover { background: var(--fnos-red-hover) !important; }
}

/* ===== Heart favorite button ===== */
.fav-btn {
  display: inline-flex; align-items: center; justify-content: center;
  .heart-icon { color: var(--fnos-text-tertiary); }
  .heart-icon .heart-fill { color: var(--fnos-red); }
}
.play-mode .fav-btn {
  border-color: rgba(255, 255, 255, 0.55) !important;
  background: rgba(255, 255, 255, 0.08) !important;
}
.play-mode .fav-btn .heart-icon { color: rgba(255, 255, 255, 0.85); }
.play-mode .fav-btn .heart-icon .heart-fill { color: var(--fnos-red); }

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
    transform: translateX(-100%); transition: transform 0.28s ease;
    background: rgba(31, 28, 42, 0.94);
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0 18px 18px 0;
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5);
    &.mobile-open { transform: translateX(0); }
    &.collapsed { width: min(280px, 82vw); }
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
    background: rgba(15, 14, 22, 0.62);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    /* 移除 border-top —— 播放器是悬浮的，不再是底栏 */
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    z-index: 100;
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px;
    .mp-cover {
      width: 44px; height: 44px; border-radius: 8px; overflow: hidden; flex-shrink: 0;
      cursor: pointer;
      img { width: 100%; height: 100%; object-fit: cover; }
      .mp-cover-ph { width: 100%; height: 100%; background: rgba(255, 255, 255, 0.06); display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, 0.4); }
    }
    .mp-info { flex: 1; min-width: 0; cursor: pointer;
      .mp-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mp-artist { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mp-lyric { color: var(--fnos-red); }
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

  /* --- Queue panel full width, extends to bottom (player is floating) --- */
  .queue-panel { width: 100%; bottom: 0; }

  /* --- Fullscreen play mode: stacked single column --- */
  .play-mode { overflow-y: auto; z-index: 700; }
  .mc-hidden { display: none !important; }
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
.mobile-controls-popover.el-popover.el-popper { padding: 0 !important; max-width: calc(100vw - 24px) !important; }
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
.mc-tools {
  display: flex; align-items: center; gap: 10px;
  .mc-volume {
    flex: 1; display: flex; align-items: center; gap: 8px; margin-left: 4px;
    .mc-vol-label { font-size: 12px; color: var(--fnos-text-tertiary); white-space: nowrap; }
    .mc-vol-slider { flex: 1; }
  }
}
</style>