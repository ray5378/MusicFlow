// On-the-fly cover rendering for GET /rest/getCoverArt.
//
// Previously covers were served at their FULL on-disk resolution and the
// `size` query param was ignored — so a 1000×1000 cover was shipped to a
// 38px thumbnail on a slow external link. This module resizes to the requested
// size (capped) and, when the client advertises `Accept: image/webp`, encodes
// to webp, which is typically 3-5× smaller than the equivalent JPEG.
//
// Output is cached in RAM (keyed by content ETag) so repeated requests for the
// same cover+size+format don't re-run sharp. Browser/proxy caching is handled
// by the caller via Cache-Control + ETag (see routes/rest getCoverArt).
//
// `sharp` is a native module. We import it lazily and tolerate its absence:
// if it fails to load (e.g. a deployment whose base image can't run it) the
// caller falls back to serving the raw bytes, so the backend never crashes.
import crypto from "crypto";
import fs from "fs";
import { readCoverFile } from "./coverCache.js";

// sharp is a CJS module; its dynamic import yields a namespace whose `.default`
// is the callable factory. Type it loosely to avoid CJS/ESM interop friction,
// and tolerate its absence (missing native binary → serve raw bytes instead).
let sharpLib: any = null;
let sharpTried = false;
async function getSharp(): Promise<any> {
  if (sharpTried) return sharpLib;
  sharpTried = true;
  try {
    const mod: any = await import("sharp");
    sharpLib = mod?.default ?? mod;
  } catch {
    sharpLib = null;
  }
  return sharpLib;
}

interface Rendered {
  buf: Uint8Array;
  contentType: string;
  at: number;
}

// RAM budget for rendered (resized/encoded) covers. Distinct covers are few;
// a 160px webp is ~10-30KB so this holds thousands of entries.
const RENDER_BUDGET = 96 * 1024 * 1024;
const RENDER_MAX_ENTRIES = 500;
const cache = new Map<string, Rendered>();
let heldBytes = 0;

function evict(): void {
  if (cache.size <= RENDER_MAX_ENTRIES && heldBytes <= RENDER_BUDGET) return;
  const keys = [...cache.keys()].sort((a, b) => cache.get(a)!.at - cache.get(b)!.at);
  for (const k of keys) {
    if (cache.size <= RENDER_MAX_ENTRIES && heldBytes <= RENDER_BUDGET) break;
    const e = cache.get(k)!;
    heldBytes -= e.buf.byteLength;
    cache.delete(k);
  }
}

function guessMime(ref: string): string {
  const ext = ref.toLowerCase().split(".").pop() || "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export interface CoverOut {
  data: Uint8Array;
  contentType: string;
  etag: string;
}

/**
 * Resolve + resize + (optionally) re-encode a cover file.
 * @param filePath absolute path to the cover image
 * @param size     requested edge length in px (clamped to [24, 1200])
 * @param wantWebp encode webp when true (raster sources only; gif preserved)
 */
export async function loadAndRenderCover(
  filePath: string,
  size: number,
  wantWebp: boolean,
): Promise<CoverOut | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const reqSize = Math.min(1200, Math.max(24, Math.round(size || 300)));
  const etagSrc = `${filePath}|${stat.size}|${stat.mtimeMs}|${reqSize}|${wantWebp ? 1 : 0}`;
  const etag = `"${crypto.createHash("md5").update(etagSrc).digest("hex")}"`;

  const hit = cache.get(etag);
  if (hit) {
    hit.at = Date.now();
    return { data: hit.buf, contentType: hit.contentType, etag };
  }

  let raw: Uint8Array;
  try {
    raw = await readCoverFile(filePath);
  } catch {
    return null;
  }

  const sharp = await getSharp();
  if (!sharp) {
    // No image library available — serve the original bytes as-is.
    const out: Rendered = { buf: raw, contentType: guessMime(filePath), at: Date.now() };
    cache.set(etag, out);
    heldBytes += raw.byteLength;
    evict();
    return { data: out.buf, contentType: out.contentType, etag };
  }

  let out: Rendered;
  try {
    const img = sharp(Buffer.from(raw));
    const meta = await img.metadata().catch(() => null);
    const isGif = meta?.format === "gif";
    const useWebp = wantWebp && !isGif;
    const pipeline = img.rotate().resize(reqSize, reqSize, {
      fit: "cover",
      withoutEnlargement: true,
    });
    if (useWebp) {
      const buf = await pipeline.webp({ quality: 80, effort: 4 }).toBuffer();
      out = { buf, contentType: "image/webp", at: Date.now() };
    } else if (meta?.format === "png") {
      const buf = await pipeline.png({ quality: 80 }).toBuffer();
      out = { buf, contentType: "image/png", at: Date.now() };
    } else if (meta?.format === "webp") {
      const buf = await pipeline.webp({ quality: 80, effort: 4 }).toBuffer();
      out = { buf, contentType: "image/webp", at: Date.now() };
    } else {
      const buf = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      out = { buf, contentType: "image/jpeg", at: Date.now() };
    }
  } catch {
    // Decode/encode failed (corrupt or unsupported) — serve the original bytes.
    out = { buf: raw, contentType: guessMime(filePath), at: Date.now() };
  }

  cache.set(etag, out);
  heldBytes += out.buf.byteLength;
  evict();
  return { data: out.buf, contentType: out.contentType, etag };
}

/** Drop the rendered-cover cache (used by maintenance hooks if needed). */
export function clearRenderedCovers(): void {
  cache.clear();
  heldBytes = 0;
}
