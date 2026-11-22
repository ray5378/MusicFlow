// ==================== WebDAV 只读写「字节」的最小客户端 ====================
//
// 标签修复要「下载 → 内存改标签 → 传回」，只需要四个动作：GET 全文 / GET 范围 /
// PUT / MOVE 覆盖。这里不碰目录递归、不做缓存，全部由调用方控制生命周期。
//
// 关键约定（实测 天翼云盘 / 群晖 都成立）：
//   - 鉴权：Basic（源配置里的 username/password）；
//   - 上传先 PUT 到同目录临时名，再 MOVE 覆盖原名（Overwrite: T）——
//     直接 PUT 原名会在中途断网时留下半截文件；
//   - 路径：songs.path 形如 `w:<sourceId>:<filePath>`，filePath 以 / 开头；
//     源配置 url 可能自带 base path（如 https://host/dav），拼接后编码。
import { sqlite } from "../../db/index.js";

export interface WdavCtx {
  /** 形如 https://host:port/dav（已含 root_path，无尾斜杠） */
  base: string;
  auth: string | null;
}

export function wdavCtxOfConfig(cfg: any): WdavCtx {
  const base = String(cfg?.url || "").trim().replace(/\/+$/, "");
  const auth =
    cfg?.username && cfg?.password
      ? "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")
      : null;
  return { base, auth };
}

/** 从 songs.path 拆出源 id 与文件路径（非 w: 前缀返回 null）。 */
export function wdavPathParts(songPath: string): { sourceId: string; filePath: string } | null {
  if (!songPath.startsWith("w:")) return null;
  const rest = songPath.slice(2);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const filePath = rest.slice(i + 1);
  if (!filePath.startsWith("/")) return null;
  return { sourceId: rest.slice(0, i), filePath };
}

/** 按源 id 取配置（media_sources.config 是 JSON 文本）。 */
export function wdavCtxOfSource(sourceId: string): WdavCtx | null {
  const row = sqlite
    .prepare("SELECT config FROM media_sources WHERE id = ?")
    .get(sourceId) as { config?: string } | undefined;
  if (!row?.config) return null;
  try {
    return wdavCtxOfConfig(JSON.parse(row.config));
  } catch {
    return null;
  }
}

/** filePath → 绝对 URL（逐段编码，避免中文/空格 404）。 */
export function wdavUrlOf(ctx: WdavCtx, filePath: string): string {
  // ⚠️ songs.path 里的 filePath **已经带了 base 路径段**（如 /dav/共享/...），
  //   而源配置的 url 也以 /dav 结尾。直接拼会得到 /dav/dav/… ⇒ 恒 404
  //   （与歌词 sidecar 那个 bug 同一类）。这里做一次去重：filePath 以 basePath 开头就剥掉。
  const u = new URL(ctx.base);
  const basePath = u.pathname.replace(/\/+$/, "");
  let p = filePath;
  if (basePath && (p === basePath || p.startsWith(basePath + "/"))) p = p.slice(basePath.length);
  const encoded = p
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
  return u.origin + basePath + "/" + encoded;
}

function headersOf(ctx: WdavCtx, extra: Record<string, string> = {}): Record<string, string> {
  return ctx.auth ? { Authorization: ctx.auth, ...extra } : { ...extra };
}

/** 整文件读进内存（标签修复必须整文件，才能重组 metadata 后原样拼回音频）。 */
export async function wdavGetWhole(ctx: WdavCtx, filePath: string, timeoutMs = 120_000): Promise<Buffer> {
  const res = await fetch(wdavUrlOf(ctx, filePath), {
    headers: headersOf(ctx),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${res.status} ${filePath}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 读前 N 字节（只取标签头时用，省流量）。 */
export async function wdavGetRange(
  ctx: WdavCtx,
  filePath: string,
  end: number,
  timeoutMs = 60_000,
): Promise<Buffer> {
  const res = await fetch(wdavUrlOf(ctx, filePath), {
    headers: headersOf(ctx, { Range: `bytes=0-${end}` }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok && res.status !== 206) throw new Error(`GET(range) ${res.status} ${filePath}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 上传一段字节到指定路径（不覆盖判定由服务端语义决定）。 */
export async function wdavPut(
  ctx: WdavCtx,
  filePath: string,
  data: Buffer,
  timeoutMs = 180_000,
): Promise<number> {
  const res = await fetch(wdavUrlOf(ctx, filePath), {
    method: "PUT",
    headers: headersOf(ctx, { "Content-Type": "application/octet-stream" }),
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 201=新建, 204=覆盖成功 都算成功
  if (res.status !== 201 && res.status !== 204 && res.status !== 200) {
    throw new Error(`PUT ${res.status} ${filePath}`);
  }
  return res.status;
}

/** MOVE 覆盖：先传到临时名，再一次性改名到目标（原文件在此之前保持完好）。 */
export async function wdavMoveOverwrite(
  ctx: WdavCtx,
  fromPath: string,
  toPath: string,
  timeoutMs = 60_000,
): Promise<void> {
  const res = await fetch(wdavUrlOf(ctx, fromPath), {
    method: "MOVE",
    headers: headersOf(ctx, {
      Destination: wdavUrlOf(ctx, toPath),
      Overwrite: "T",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 201 && res.status !== 204) {
    throw new Error(`MOVE ${res.status} ${fromPath} → ${toPath}`);
  }
}

/** 删文件（清理临时名用；失败不抛）。 */
export async function wdavDelete(ctx: WdavCtx, filePath: string): Promise<void> {
  try {
    await fetch(wdavUrlOf(ctx, filePath), {
      method: "DELETE",
      headers: headersOf(ctx),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 取文件字节数。⚠️ 不用 HEAD：实测这台网关的 HEAD 会返回错误值（100KB 的文件回 617），
 * 改用 `Range: bytes=0-0` 读 `Content-Range` 里的总长。
 */
export async function wdavSize(ctx: WdavCtx, filePath: string): Promise<number | null> {
  try {
    const res = await fetch(wdavUrlOf(ctx, filePath), {
      headers: headersOf(ctx, { Range: "bytes=0-0" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 206) {
      const cr = res.headers.get("content-range") || "";
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) return Number(m[1]);
    }
    const len = res.headers.get("content-length");
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

/** 头部探测用的字节数：MP3 按 ID3 头声明的长度精确取（含大封面），FLAC 先取 1MB。 */
export async function wdavProbeTags(
  ctx: WdavCtx,
  filePath: string,
  container: "flac" | "mp3",
): Promise<Buffer> {
  const MAX = 8 * 1024 * 1024;
  if (container === "mp3") {
    const head10 = await wdavGetRange(ctx, filePath, 9);
    if (head10.length >= 10 && head10.subarray(0, 3).toString("latin1") === "ID3") {
      const tagLen =
        10 +
        (((head10[6] & 0x7f) << 21) |
          ((head10[7] & 0x7f) << 14) |
          ((head10[8] & 0x7f) << 7) |
          (head10[9] & 0x7f));
      return wdavGetRange(ctx, filePath, Math.min(tagLen + 4096, MAX) - 1);
    }
    return head10;
  }
  // FLAC：metadata 全在音频之前；1MB 覆盖绝大多数（封面通常 <1MB），不够再取 2MB。
  const first = await wdavGetRange(ctx, filePath, 1024 * 1024 - 1);
  return first;
}

/** 同目录临时名（隐藏文件，避免被扫描入库）。 */
export function wdavTmpNameFor(filePath: string, songId: string): string {
  const i = filePath.lastIndexOf("/");
  const dir = filePath.slice(0, i + 1);
  const name = filePath.slice(i + 1);
  // ⚠️ 必须带随机后缀：用 songId 做名字时，同一首重跑会产生**同名**临时文件，
  //    天翼网关对"覆盖已存在的隐藏文件"回 405（实测「人间半途」两首），任务就会卡在这里。
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${dir}.mf-up-${songId}-${rnd}-${name}`;
}

/** 把任意形式的目录换算成「与 songs.path 前缀一致」的规范形态（含 base 路径段）。 */
export function wdavCanonicalDir(ctx: WdavCtx, dirPath: string): string {
  const u = new URL(ctx.base);
  const basePath = u.pathname.replace(/\/+$/, "");
  let p = dirPath.startsWith("/") ? dirPath : "/" + dirPath;
  p = p.replace(/\/+$/, "");
  if (basePath && !(p === basePath || p.startsWith(basePath + "/"))) p = basePath + p;
  return p || "/";
}

export interface WdavDirEntry {
  name: string;
  /** 与 songs.path 前缀一致的规范路径（含源 base 路径段，可直接当修复目标） */
  path: string;
  isDir: boolean;
  size?: number;
}

/** 列一层目录（PROPFIND Depth:1），给前端「选目录」用。 */
export async function wdavList(ctx: WdavCtx, dirPath: string, timeoutMs = 60_000): Promise<WdavDirEntry[]> {
  const url = wdavUrlOf(ctx, dirPath.endsWith("/") ? dirPath : dirPath + "/");
  const body =
    '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop>' +
    "<D:resourcetype/><D:getcontentlength/></D:prop></D:propfind>";
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: headersOf(ctx, { Depth: "1", "Content-Type": "application/xml", Accept: "application/xml, text/xml" }),
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok && res.status !== 207) throw new Error(`PROPFIND ${res.status} ${dirPath}`);
  const xml = await res.text();
  const selfHref = decodeURIComponent(url.replace(/\/+$/, ""));
  const out: WdavDirEntry[] = [];
  for (const block of xml.split(/<D:response>/i).slice(1)) {
    const hrefMatch = block.match(/<D:href>([^<]+)<\/D:href>/i);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[1]).replace(/\/+$/, "");
    if (href === selfHref) continue;
    const name = href.slice(href.lastIndexOf("/") + 1);
    if (!name || name.startsWith(".")) continue; // 跳过隐藏文件（含本功能的临时名）
    const isDir = /<D:collection/i.test(block);
    const lenMatch = block.match(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/i);
    out.push({ name, path: "", isDir, size: lenMatch ? Number(lenMatch[1]) : undefined });
  }
  const root = wdavCanonicalDir(ctx, dirPath);
  for (const e of out) e.path = root.replace(/\/+$/, "") + "/" + e.name;
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1));
  return out;
}

/**
 * 用内存里的新内容替换云盘上的原文件（实测：该网关 MOVE 到**已存在**的目标会 500）。
 * 顺序：
 *   1) PUT 临时名（原文件此刻完好）；
 *   2) 若目标已存在 → 先 DELETE，再 MOVE（DELETE 后目标消失，MOVE 才返回 201）；
 *   3) MOVE 失败时用内存里的 data 直接 PUT 目标名兜底（最多 2 次），最后删临时名。
 * 全过程中新内容始终在调用方内存里，因此任何一步失败都还能重来。
 */
export async function wdavReplaceFile(
  ctx: WdavCtx,
  tmpPath: string,
  targetPath: string,
  data: Buffer,
): Promise<void> {
  try {
    await wdavMoveOverwrite(ctx, tmpPath, targetPath);
    return;
  } catch {
    /* 目标已存在时该网关回 500 → 走删除后改名 */
  }
  await wdavDelete(ctx, targetPath);
  try {
    await wdavMoveOverwrite(ctx, tmpPath, targetPath);
    return;
  } catch {
    /* 仍失败 → 直接 PUT 兜底 */
  }
  let lastErr: unknown = null;
  for (let i = 0; i < 2; i++) {
    try {
      await wdavPut(ctx, targetPath, data);
      await wdavDelete(ctx, tmpPath);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  await wdavDelete(ctx, tmpPath);
  throw new Error(`替换失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
