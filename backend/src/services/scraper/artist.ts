// Artist info scraper: fetch artist avatars/bios from QQ Music first,
// fall back to NetEase Cloud Music when QQ has no info. When neither platform
// has the artist, fall back to a random album cover from the local library and
// mark the artist as "missing info" so it can be retried later.
import { db } from "../../db/index.js";
import { artists, albums } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

const COVERS_DIR = path.join(process.cwd(), "data", "covers");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function ensureDir() {
  if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Download an image to the covers dir, return file ref or null
async function downloadImage(url: string, ref: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    const ext = res.headers.get("content-type")?.includes("png") ? "png" : "jpg";
    const fileName = `${ref}.${ext}`;
    ensureDir();
    fs.writeFileSync(path.join(COVERS_DIR, fileName), buf);
    return fileName;
  } catch {
    return null;
  }
}

export interface ArtistScrapeResult {
  name: string;
  platform: "qq" | "netease" | "none";
  coverArt?: string;
  bio?: string;
  fallbackCover?: boolean; // used a local album cover because platforms had no info
}

// ==================== QQ Music ====================

// Search songs to find the singer mid, then build the avatar CDN URL.
async function scrapeFromQQ(name: string): Promise<ArtistScrapeResult | null> {
  const q = encodeURIComponent(name);
  const data = await fetchJson(
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=${q}&format=json`,
    { Referer: "https://y.qq.com/" }
  );
  const songList = data?.data?.song?.list || [];
  for (const song of songList) {
    const singers = song.singer || [];
    const match = singers.find((s: any) => (s.name || "").toLowerCase() === name.toLowerCase());
    const singer = match || singers[0];
    if (singer?.mid) {
      const picUrl = `https://y.gtimg.cn/music/photo_new/T001R300x300M000${singer.mid}.jpg`;
      return { name: singer.name || name, platform: "qq", coverArt: picUrl };
    }
  }
  return null;
}

// ==================== NetEase ====================

async function scrapeFromNetease(name: string): Promise<ArtistScrapeResult | null> {
  const q = encodeURIComponent(name);
  const data = await fetchJson(`https://music.163.com/api/search/get?s=${q}&type=100&limit=3`);
  const artistsList = data?.result?.artists || [];
  const match = artistsList.find((a: any) => (a.name || "").toLowerCase() === name.toLowerCase())
    || artistsList[0];
  if (!match?.id) return null;
  const result: ArtistScrapeResult = { name: match.name || name, platform: "netease" };
  if (match.picUrl) result.coverArt = match.picUrl;
  // Bio from artist detail
  const detail = await fetchJson(`https://music.163.com/api/artist/${match.id}`);
  const brief = detail?.artist?.briefDesc || "";
  if (brief) result.bio = brief;
  return result;
}

// ==================== Entry ====================

// Copy a random album cover from the local library (prefer the artist's own albums)
// to use as the artist avatar when platforms have no info. Returns file ref or null.
function useRandomAlbumCover(artistId: string): string | null {
  try {
    const ownAlbums = db.select().from(albums).where(eq(albums.artistId, artistId)).all().filter(a => a.coverArt);
    let pool = ownAlbums;
    if (pool.length === 0) {
      pool = db.select().from(albums).all().filter(a => a.coverArt);
    }
    if (pool.length === 0) return null;
    const album = pool[Math.floor(Math.random() * pool.length)];
    const src = path.join(COVERS_DIR, album.coverArt!);
    if (!fs.existsSync(src)) return null;
    const fileName = `ar-${artistId}.jpg`;
    ensureDir();
    fs.copyFileSync(src, path.join(COVERS_DIR, fileName));
    return fileName;
  } catch {
    return null;
  }
}

// Scrape an artist's info (QQ first, NetEase fallback) and persist it.
// When neither platform has info, falls back to a random local album cover and
// marks the artist as scrape_missing (retryable via scrape-missing).
// Returns the updated artist row data or null.
export async function scrapeArtist(artistName: string, artistId?: string): Promise<ArtistScrapeResult | null> {
  if (!artistName || artistName === "Unknown Artist") return null;

  // 1. Prefer QQ Music
  let result = await scrapeFromQQ(artistName);
  // 2. Fallback to NetEase if QQ returned nothing
  if (!result) {
    result = await scrapeFromNetease(artistName);
  }

  const id = artistId || findArtistIdByName(result?.name || artistName) || findArtistIdByName(artistName);
  if (!id) return null;

  let coverRef: string | undefined;
  let fallbackCover = false;

  if (result?.coverArt) {
    const downloaded = await downloadImage(result.coverArt, `ar-${id}`);
    if (downloaded) coverRef = downloaded;
  }

  const update: any = { updatedAt: new Date().toISOString() };
  if (coverRef) {
    update.coverArt = coverRef;
    update.scrapeMissing = 0; // real info found, clear the missing flag
  } else {
    // Neither platform has this artist -> use a random local album cover as avatar
    const fallback = useRandomAlbumCover(id);
    if (fallback) {
      coverRef = fallback;
      update.coverArt = fallback;
      fallbackCover = true;
    }
    update.scrapeMissing = 1; // mark as missing info so it can be retried
  }
  if (result?.bio) update.bio = result.bio;
  db.update(artists).set(update).where(eq(artists.id, id)).run();

  return { name: result?.name || artistName, platform: result?.platform || "none", coverArt: coverRef, bio: result?.bio, fallbackCover };
}

function findArtistIdByName(name: string): string | null {
  const row = db.select().from(artists).where(eq(artists.name, name)).get();
  return row?.id || null;
}

export interface ScrapeProgress {
  status: "running" | "done";
  total: number;
  processed: number; // attempted
  scraped: number;   // real platform info found
  fallback: number;  // no platform info, used random local album cover
  skipped: number;   // no info at all
  errors: string[];
  current: string;   // artist name currently scraping
}

// Scrape a specific list of artists (by id) with progress callback.
// Used for: manual full scrape, auto scrape of newly-added artists,
// and retry of artists marked as missing-info.
export async function scrapeArtistList(
  artistIds: string[],
  onProgress?: (p: ScrapeProgress) => void
): Promise<ScrapeProgress> {
  const progress: ScrapeProgress = {
    status: "running", total: artistIds.length, processed: 0, scraped: 0, fallback: 0, skipped: 0, errors: [], current: "",
  };
  for (const id of artistIds) {
    const a = db.select().from(artists).where(eq(artists.id, id)).get();
    if (!a) { progress.processed++; continue; }
    progress.current = a.name;
    if (onProgress) onProgress({ ...progress });
    try {
      const result = await scrapeArtist(a.name, a.id);
      if (result && result.coverArt) {
        if (result.fallbackCover) progress.fallback++;
        else progress.scraped++;
      } else {
        progress.skipped++;
      }
    } catch (e: any) {
      progress.skipped++;
      progress.errors.push(`${a.name}: ${e.message || "刮削失败"}`);
    }
    progress.processed++;
    if (onProgress) onProgress({ ...progress });
    await new Promise(r => setTimeout(r, 200)); // be gentle to the APIs
  }
  progress.status = "done";
  progress.current = "";
  if (onProgress) onProgress({ ...progress });
  return progress;
}

// All artists currently missing a cover
export function artistsMissingCovers(): { id: string; name: string }[] {
  return db.select().from(artists).all().filter(a => !a.coverArt).map(a => ({ id: a.id, name: a.name }));
}

// All artists marked as missing-info (platforms had no data, used fallback cover)
export function artistsMissingInfo(): { id: string; name: string }[] {
  return db.select().from(artists).all()
    .filter(a => a.scrapeMissing === 1)
    .map(a => ({ id: a.id, name: a.name }));
}
