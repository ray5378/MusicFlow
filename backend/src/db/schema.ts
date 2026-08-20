import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  salt: text("salt").notNull(),
  subsonicSalt: text("subsonic_salt").notNull(),
  passEnc: text("pass_enc"),
  isAdmin: integer("is_admin").default(0),
  isActive: integer("is_active").default(1),
  email: text("email").default(""),
  apiKey: text("api_key"),
  apiKeyHash: text("api_key_hash"),
  apiKeyExpiresAt: text("api_key_expires_at"),
  mustChangePassword: integer("must_change_password").default(0),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const artists = sqliteTable("artists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  coverArt: text("cover_art"),
  bio: text("bio"),
  country: text("country"),
  birthDate: text("birth_date"),
  albumCount: integer("album_count").default(0),
  scrapeMissing: integer("scrape_missing").default(0),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const albums = sqliteTable("albums", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  artistId: text("artist_id"),
  artist: text("artist"),
  year: integer("year").default(0),
  genre: text("genre").default(""),
  coverArt: text("cover_art"),
  songCount: integer("song_count").default(0),
  duration: integer("duration").default(0),
  playCount: integer("play_count").default(0),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const songs = sqliteTable("songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  artist: text("artist").default(""),
  artistId: text("artist_id"),
  album: text("album").default(""),
  albumId: text("album_id"),
  duration: integer("duration").default(0),
  bitRate: integer("bit_rate").default(0),
  contentType: text("content_type").default("audio/mpeg"),
  suffix: text("suffix").default("mp3"),
  path: text("path").notNull(),
  coverArt: text("cover_art"),
  playCount: integer("play_count").default(0),
  discNumber: integer("disc_number").default(1),
  track: integer("track").default(0),
  genre: text("genre").default(""),
  size: integer("size").default(0),
  fingerprint: text("fingerprint"),
  type: text("type").default("local"),
  url: text("url"),
  streamHeaders: text("stream_headers"),
  sourceData: text("source_data"),
  pluginEntry: text("plugin_entry"),
  cachePath: text("cache_path"),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const albumArtists = sqliteTable("album_artists", {
  albumId: text("album_id").notNull(),
  artistId: text("artist_id").notNull(),
  role: text("role").default("participant"),
}, (t) => ({
  pk: primaryKey({ columns: [t.albumId, t.artistId] }),
}));

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
  isPublic: integer("is_public").default(0),
  comment: text("comment").default(""),
  coverArt: text("cover_art"),
  songCount: integer("song_count").default(0),
  duration: integer("duration").default(0),
  syncEnabled: integer("sync_enabled").default(0),
  favorite: integer("favorite").default(0), // 用户收藏标记;平台歌单收藏后脱离每日推荐轮换并保留每天同步
  sourceUrl: text("source_url"),
  sourcePlatform: text("source_platform"),
  sourcePlugin: text("source_plugin"), // 插件同步歌单的归属插件 id(如 go-music-dl 私人歌单);导入歌单为空
  externalId: text("external_id"),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const playlistSongs = sqliteTable("playlist_songs", {
  id: integer("id").primaryKey(),
  playlistId: text("playlist_id").notNull(),
  songId: text("song_id"),
  position: integer("position").default(0),
  playable: integer("playable").default(1),
  externalSongId: text("external_song_id"),
  externalTitle: text("external_title"),
  externalArtist: text("external_artist"),
  externalAlbum: text("external_album"),
  externalDuration: integer("external_duration"),
  unavailableReason: text("unavailable_reason"),
  createdAt: text("created_at").default(""),
});

export const userFavoriteSongs = sqliteTable("user_favorite_songs", {
  userId: text("user_id").notNull(),
  songId: text("song_id").notNull(),
  createdAt: text("created_at").default(""),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.songId] }),
}));

// 歌单收藏按用户隔离:谁收藏归谁(user_id + playlist_id 联合主键)。
// 旧 playlists.favorite 全局列仅作迁移快照,新收藏一律写这张表。
export const playlistFavorites = sqliteTable("playlist_favorites", {
  userId: text("user_id").notNull(),
  playlistId: text("playlist_id").notNull(),
  createdAt: text("created_at").default(""),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.playlistId] }),
}));

export const playHistory = sqliteTable("play_history", {
  id: integer("id").primaryKey(),
  userId: text("user_id").notNull(),
  songId: text("song_id").notNull(),
  playedAt: text("played_at").default(""),
});

// OpenSubsonic 评分(setRating):按用户 × 条目类型(song|album|artist) × 条目 id
// 存储 0–5 星;rating=0 表示删除评分。列表响应里的 userRating 来自这里。
export const userRatings = sqliteTable("user_ratings", {
  userId: text("user_id").notNull(),
  itemType: text("item_type").notNull(), // "song" | "album" | "artist"
  itemId: text("item_id").notNull(),
  rating: integer("rating").notNull().default(0),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.itemType, t.itemId] }),
}));

// OpenSubsonic 播放队列持久化(getPlayQueue/savePlayQueue):每个用户一份,
// 存第三方客户端(如 Symfonik/DSub)的排队现场,换设备/重开客户端可恢复。
export const userPlayQueues = sqliteTable("user_play_queues", {
  userId: text("user_id").primaryKey(),
  entryIdsJson: text("entry_ids_json").notNull().default("[]"), // songId[] serialized
  currentId: text("current_id"),
  position: integer("position").notNull().default(0),
  changedAt: text("changed_at").default(""),
  changedBy: text("changed_by").default(""),
});

export const mediaSources = sqliteTable("media_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("local"),
  enabled: integer("enabled").default(1),
  config: text("config").default("{}"),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").default(""),
  description: text("description").default(""),
  manifest: text("manifest").default("{}"),
  enabled: integer("enabled").default(0),
  config: text("config").default("{}"),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const pluginRegistries = sqliteTable("plugin_registries", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  enabled: integer("enabled").default(1),
  createdAt: text("created_at").default(""),
});

export const cleaningRules = sqliteTable("cleaning_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  obj: text("obj").notNull(),
  enabled: integer("enabled").default(1),
  content: text("content").default("{}"),
  sortOrder: integer("sort_order").default(0),
  isBuiltin: integer("is_builtin").default(0),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const wishes = sqliteTable("wishes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  songTitle: text("song_title").notNull(),
  artist: text("artist").default(""),
  album: text("album").default(""),
  status: text("status").default("pending"),
  playlistSongId: integer("playlist_song_id"),
  notes: text("notes").default(""),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default(""),
});

// User-curated recommend pool: when a user clicks "加入每日推荐池" on a playlist
// (or on "我喜欢的音乐"), that source is recorded here. Each daily-recommend
// generation picks 50 random playable songs from each pool member and merges
// them into the day's combined playlist.
// sourceType: "playlist" (a real playlists row) | "favorites" (user's starred songs)
// sourceId:   playlist id for "playlist"; user id for "favorites"
export const recommendPool = sqliteTable("recommend_pool", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceType: text("source_type").notNull(), // "playlist" | "favorites"
  sourceId: text("source_id").notNull(),     // playlist id OR user id
  sourceName: text("source_name").default(""), // denormalized for display
  userId: text("user_id").notNull(),         // who added it
  enabled: integer("enabled").default(1),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

// 持久化的 DLNA 设备记录。发现/下线都会 upsert;离线设备保留显示(用户可在
// 「播放器」页手动重命名或删除)。alias 为用户自定义显示名,播放控件/HA 卡片
// 显示的设备名 = alias || name。
export const dlnaDevices = sqliteTable("dlna_devices", {
  id: text("id").primaryKey(),                  // UDN (uuid)
  name: text("name").notNull().default(""),     // SSDP friendlyName(原始名)
  alias: text("alias").notNull().default(""),   // 用户自定义显示名,空则用 name
  manufacturer: text("manufacturer").notNull().default(""),
  model: text("model").notNull().default(""),
  firstSeen: text("first_seen").notNull().default(""),
  lastSeen: text("last_seen").notNull().default(""),
  available: integer("available").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(""),
});

// Per-DLNA-device persisted playback queue. Survives backend restarts and
// Web-client disconnects so the device keeps playing (auto-advance runs in
// the backend, not the frontend). HA and Web share the same queue.
export const deviceQueues = sqliteTable("device_queues", {
  deviceId: text("device_id").primaryKey(),
  itemsJson: text("items_json").notNull().default("[]"), // QueueItem[] serialized
  currentIndex: integer("current_index").notNull().default(-1),
  playMode: text("play_mode").notNull().default("order"), // order|one|all|shuffle
  isActive: integer("is_active").notNull().default(0),     // 1 = currently casting
  updatedAt: text("updated_at").default(""),
});

// Per-Web-client persisted playback queue (one local peer per user —
// peerId = "local:<userId>"). Lets the user close the tab and reopen it to
// find their queue again, and lets HA browse the same queue. The actual
// audio playback runs on the Web client (Howl); the backend only stores the
// queue metadata. lastActiveAt is updated by heartbeats and drives the
// 10-minute inactivity cleanup (peer becomes unavailable → queue cleared).
export const localQueues = sqliteTable("local_queues", {
  peerId: text("peer_id").primaryKey(),
  userId: text("user_id").notNull(),
  itemsJson: text("items_json").notNull().default("[]"),
  currentIndex: integer("current_index").notNull().default(-1),
  playMode: text("play_mode").notNull().default("order"),
  isActive: integer("is_active").notNull().default(0),
  lastActiveAt: text("last_active_at").notNull(),
  updatedAt: text("updated_at").default(""),
});

// 播放器群组(SyncGroup,仿 MA Sync Group):一个组聚合多台 DLNA 设备。
// 成员只能是 DLNA 设备(裸 deviceId);一台设备最多属于一个组;组不能套组。
// 组持有自己的持久化队列(group_queues),播放时并发向成员 cast 同一首歌。
export const playerGroups = sqliteTable("player_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  memberIds: text("member_ids").notNull().default("[]"), // dlna deviceId[] serialized
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

// 组级持久化队列,镜像 device_queues。后端重启后组可恢复续播。
export const groupQueues = sqliteTable("group_queues", {
  groupId: text("group_id").primaryKey(),
  itemsJson: text("items_json").notNull().default("[]"), // QueueItem[] serialized
  currentIndex: integer("current_index").notNull().default(-1),
  playMode: text("play_mode").notNull().default("order"), // order|one|all|shuffle
  isActive: integer("is_active").notNull().default(0),     // 1 = 组当前在播
  updatedAt: text("updated_at").default(""),
});

// 风格(Genre):给每个风格名分配唯一 ID(供外部 API/webhook 引用)。
// 歌曲/专辑仍保留自由文本 genre 字段,查询时按 name 关联,避免大规模迁移。
export const genres = sqliteTable("genres", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  songCount: integer("song_count").default(0),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

// 音流(MusicFlow):一条可复用的自动播放流程(等设备上线→音量→播放模式→播歌单)。
// 每个流程持有一个唯一 token,对外暴露免登录的 webhook 链接。
export const flows = sqliteTable("flows", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  name: text("name").notNull(),
  definitionJson: text("definition_json").notNull().default("{}"), // FlowDefinition
  enabled: integer("enabled").notNull().default(1), // 1 = 可被 webhook/UI 触发
  lastRunAt: text("last_run_at").default(""),
  lastRunStatus: text("last_run_status").default(""), // waiting|playing|success|error|timeout
  lastRunError: text("last_run_error").default(""),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});

// 通用播放器控制渠道 Token:支持多条独立 token,各自启用/停用。
// 「我喜欢」收藏归属各自的 owner_user_id;enable 由用户自行管理。
export const playerWebhookTokens = sqliteTable("player_webhook_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  token: text("token").notNull().unique(),
  enabled: integer("enabled").notNull().default(1), // 1 = 可被 webhook 执行
  ownerUserId: text("owner_user_id").default(""),
  createdAt: text("created_at").default(""),
  updatedAt: text("updated_at").default(""),
});
