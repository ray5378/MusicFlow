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
  sourceUrl: text("source_url"),
  sourcePlatform: text("source_platform"),
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

export const playHistory = sqliteTable("play_history", {
  id: integer("id").primaryKey(),
  userId: text("user_id").notNull(),
  songId: text("song_id").notNull(),
  playedAt: text("played_at").default(""),
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
