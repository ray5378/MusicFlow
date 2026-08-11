// Shared HTTP helpers for importer plugins.
//
// Kept separate from any single importer so a third-party importer can reuse the
// same timeout/UA behaviour without importing another plugin's module.

export const IMPORTER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** GET + parse JSON with a hard timeout (importers talk to third-party APIs that
 *  can hang forever). Throws on non-2xx. */
export async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 20000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": IMPORTER_UA, ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Follow redirects and return the final URL (used to expand share short links).
 *  Never throws — falls back to the input URL. */
export async function resolveRedirect(url: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": IMPORTER_UA },
      redirect: "follow",
      signal: controller.signal,
    });
    return res.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timeout);
  }
}
