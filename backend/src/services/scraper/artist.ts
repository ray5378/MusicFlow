// Artist info scraper: fetch artist avatars/bios from QQ Music first,
// fall back to NetEase Cloud Music when QQ has no info. When neither platform
// has the artist, fall back to a random album cover from the local library and
// mark the artist as "missing info" so it can be retried later.
import { db } from "../../db/index.js";
import { artists, albums } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { getEnabledByCapability } from "../../plugins/registry.js";
import { getDataDir } from "../../utils/env.js";
import { invalidateArtistList } from "../../utils/artistListCache.js";

const COVERS_DIR = path.join(getDataDir(), "covers");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function ensureDir() {
  if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });
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
  platform: string; // 抓取来源标记(由 artistInfo 插件返回)
  coverArt?: string;
  bio?: string;
  fallbackCover?: boolean; // used a local album cover because platforms had no info
}

// 抓取歌手资料:遍历启用的 artistInfo 能力插件,首个返回非空的胜出。
// 核心不写死任何数据源平台——新抓取源 = 新插件(参考内置 artist-info)。
async function fetchArtistInfoByName(name: string): Promise<ArtistScrapeResult | null> {
  for (const { impl } of getEnabledByCapability("artistInfo")) {
    if (typeof impl?.fetchArtistInfo !== "function") continue;
    try {
      const r = await impl.fetchArtistInfo(name);
      if (r) {
        return { name: r.name, platform: r.platform, coverArt: r.coverArtUrl, bio: r.bio };
      }
    } catch {
      // 插件抓取异常跳过(健康追踪记录),继续下一个
    }
  }
  return null;
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

  // 按 artistInfo 能力遍历插件抓取(数据源由插件决定,核心不写死平台)
  let result = await fetchArtistInfoByName(artistName);

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
  invalidateArtistList();

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
