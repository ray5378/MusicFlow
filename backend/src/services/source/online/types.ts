// ==================== Online Source Provider Interface ====================
//
// A "source provider" bridges MusicFlow to an external online-music aggregator
// (like the user-deployed go-music-dl web service). Search results are stored
// as DB songs with type="web" and streams are served by proxying the provider's
// /music/download stream URL from /rest/stream (see serveWebSongStream).
//
// Providers are registered here and surfaced as built-in "source" plugins in
// the admin Plugins page. Config lives in the plugin's `config` JSON.

export interface OnlineSongResult {
  // Remote identity (used to build the stream URL)
  id: string;
  source: string; // platform slug: netease / qq / kugou / bilibili ...
  // Display metadata (mirrors the DB `songs` columns)
  name: string;
  artist: string;
  album: string;
  duration: number; // seconds
  cover: string; // remote cover URL
  extra?: Record<string, string> | null;
  // Optional details surfaced by the aggregator (may be empty)
  sortSize?: string;
  sortBitrate?: string;
}

export interface OnlineSearchParams {
  query: string;
  sources?: string[];
}

export interface OnlineSearchResult {
  songs: OnlineSongResult[];
}

/** A configured, instantiated online source provider. */
export interface OnlineProvider {
  readonly id: string;
  readonly name: string;
  /** Test connectivity to the configured instance. */
  test(config: Record<string, any>): Promise<{ success: boolean; message?: string }>;
  /** Search the aggregated online catalog. */
  search(config: Record<string, any>, params: OnlineSearchParams): Promise<OnlineSearchResult>;
  /** Build the audio proxy URL for a song (go-music-dl /download?stream=1). */
  streamUrl(config: Record<string, any>, song: OnlineSongResult, range?: string): string;
}

// ==================== Registry ====================

const providers = new Map<string, OnlineProvider>();

export function registerOnlineProvider(p: OnlineProvider) {
  providers.set(p.id, p);
}

export function getOnlineProvider(id: string): OnlineProvider | undefined {
  return providers.get(id);
}

export function listOnlineProviders(): OnlineProvider[] {
  return [...providers.values()];
}