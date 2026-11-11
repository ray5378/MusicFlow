// ==================== SMB 客户端(连接池 + 薄适配层) ====================
//
// 为什么要有这一层：SMB 不是 HTTP —— ffmpeg / 预取 / DLNA 代理都不认它。
// 业务代码只依赖本文件的四个动作(stat / readdir / 读一段字节 / 开文件流)，
// 底层库(v9u-smb2)不出现在其它模块里，将来换库(例如改用系统 smbclient)
// 只改这一个文件。
//
// 连接策略：
//   - 每个音源复用一条连接(按 sourceId + 配置指纹)；
//   - 空闲 10 分钟由库自己断开(autoCloseTimeout)，下次调用自动重连；
//   - 出错时只有「连接级错误」才丢弃连接池条目 —— 文件不存在这类业务错误
//     不能把健康连接踢掉，否则一次探测未命中就要重连一次，白白多几百毫秒。
//
// 并发：SMB2 协议本身多路复用(一条连接可同时开多个文件句柄)，所以扫描/预取/
// 播放共用一条连接没问题；SMB 服务器通常限制「同一账号并发连接数」，这正是不
// 给每次请求都新建连接的原因。
import SMB2 from "v9u-smb2";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mediaSources } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("SMB");

/** 空闲断开时间：太长会占着服务器连接，太短会让暂停播放的流断在半路。 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** 单次操作超时(库本身没有超时，卡死会永久挂住调用方)。 */
const OP_TIMEOUT_MS = 30 * 1000;
/** 读整首的上限，与网络源内存缓冲口径一致(100MB)。 */
export const SMB_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

const CONN_ERR_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket|not connected|connection/i;
const CONN_STATUS = new Set([
  "STATUS_NETWORK_NAME_DELETED",
  "STATUS_CONNECTION_DISCONNECTED",
  "STATUS_USER_SESSION_DELETED",
  "STATUS_NETWORK_SESSION_EXPIRED",
]);

export interface SmbConfig {
  host: string;
  port: number;
  share: string;
  username: string;
  password: string;
  domain: string;
  /** 扫描起点(共享内绝对路径，`/` 分隔)；也是新配源时的默认目录。 */
  root_path: string;
}

export interface SmbEntry {
  name: string;
  /** 共享内绝对路径，统一用 `/` 分隔(入库路径也用它)。 */
  path: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

export interface SmbStatResult {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

interface PoolEntry {
  client: SMB2;
  /** 配置指纹：改了主机/共享/账号就重建连接。 */
  key: string;
}

const pool = new Map<string, PoolEntry>();

/** 共享内路径归一：统一 `/` 分隔、绝对路径、去掉重复斜杠与尾部斜杠。 */
export function normalizeSmbPath(p: string | null | undefined): string {
  let s = String(p ?? "").replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s || "/";
}

/** 协议层要反斜杠(SMB2 CREATE 的 Name 字段)；库不做归一，必须在这里转。 */
function wirePath(p: string | null | undefined): string {
  return normalizeSmbPath(p).replace(/\//g, "\\");
}

/** 配置 → 强类型(校验 host/share，顺手把 root_path 归一)。非法返回 null。 */
export function buildSmbConfig(raw: any): SmbConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const host = String(raw.host ?? "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  const share = String(raw.share ?? "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!host || !share) return null;
  const port = Number(raw.port);
  return {
    host,
    share,
    port: Number.isFinite(port) && port > 0 ? port : 445,
    username: String(raw.username ?? ""),
    password: String(raw.password ?? ""),
    domain: String(raw.domain ?? "").trim() || "WORKGROUP",
    root_path: normalizeSmbPath(String(raw.root_path ?? "") || "/"),
  };
}

/** 按音源 id 读配置(只有 type='smb' 才返回)。 */
export function loadSmbConfig(sourceId: string): SmbConfig | null {
  try {
    const row = db.select().from(mediaSources).where(eq(mediaSources.id, sourceId)).get();
    if (!row || row.type !== "smb") return null;
    return buildSmbConfig(JSON.parse(row.config || "{}"));
  } catch {
    return null;
  }
}

function shareRoot(cfg: SmbConfig): string {
  return `\\\\${cfg.host}\\${cfg.share}`;
}

function configKey(cfg: SmbConfig): string {
  return [cfg.host, cfg.port, cfg.share, cfg.domain, cfg.username, cfg.password].join("\u0000");
}

function dropPool(sourceId: string): void {
  const hit = pool.get(sourceId);
  if (!hit) return;
  pool.delete(sourceId);
  try {
    hit.client.disconnect();
  } catch {
    /* 已断开 */
  }
}

/** 取(或新建)该音源的连接。库在第一次调用时自动 connect。 */
export function getSmbClient(sourceId: string, cfg: SmbConfig): SMB2 {
  const key = configKey(cfg);
  const hit = pool.get(sourceId);
  if (hit && hit.key === key) return hit.client;
  if (hit) dropPool(sourceId);
  const client = new SMB2({
    share: shareRoot(cfg),
    domain: cfg.domain,
    username: cfg.username,
    password: cfg.password,
    port: cfg.port,
    packetConcurrency: 8,
    autoCloseTimeout: IDLE_TIMEOUT_MS,
  });
  pool.set(sourceId, { client, key });
  return client;
}

/** 连接级错误才丢池；文件不存在/无权限属于业务结果，连接本身是好的。 */
function shouldInvalidate(e: any): boolean {
  const code = String(e?.code || "");
  if (code.startsWith("STATUS_")) return CONN_STATUS.has(code);
  return CONN_ERR_RE.test(String(e?.message || e || ""));
}

function noteError(sourceId: string, e: any): void {
  if (shouldInvalidate(e)) {
    log.warn("SMB 连接异常，丢弃连接池条目", { sourceId, err: e?.message || String(e) });
    dropPool(sourceId);
  }
}

/** 给库调用套一层超时：库没有超时，网络半开时会永久挂住。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SMB ${label} 超时(${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function toEntry(dir: string, v: any): SmbEntry {
  const name = String(v?.name ?? "");
  const isDirectory = typeof v?.isDirectory === "function" ? !!v.isDirectory() : !!v?.isDirectory;
  return {
    name,
    path: normalizeSmbPath(`${dir}/${name}`),
    size: Number(v?.size ?? 0) || 0,
    mtimeMs: v?.mtime instanceof Date ? v.mtime.getTime() : Number(v?.mtime ?? 0) || 0,
    isDirectory,
  };
}

/** 列目录(带 stat：一次往返拿到 size/mtime/是否目录)。 */
export async function smbReaddir(sourceId: string, cfg: SmbConfig, dir: string): Promise<SmbEntry[]> {
  try {
    const client = getSmbClient(sourceId, cfg);
    const list = (await withTimeout(
      client.readdir(wirePath(dir), { stats: true } as any),
      OP_TIMEOUT_MS,
      "readdir",
    )) as any[];
    return list
      .filter((v) => v && v.name !== "." && v.name !== "..")
      .map((v) => toEntry(dir, v));
  } catch (e) {
    noteError(sourceId, e);
    throw e;
  }
}

/** 单文件/目录 stat；文件不存在会抛错(调用方按不可用处理)。 */
export async function smbStat(sourceId: string, cfg: SmbConfig, p: string): Promise<SmbStatResult> {
  try {
    const client = getSmbClient(sourceId, cfg);
    const st = (await withTimeout(client.stat(wirePath(p)), OP_TIMEOUT_MS, "stat")) as any;
    return {
      size: Number(st?.size ?? 0) || 0,
      mtimeMs: st?.mtime instanceof Date ? st.mtime.getTime() : Number(st?.mtime ?? 0) || 0,
      isDirectory: typeof st?.isDirectory === "function" ? !!st.isDirectory() : !!st?.isDirectory,
    };
  } catch (e) {
    noteError(sourceId, e);
    throw e;
  }
}

/** 打开文件流；`end` 为闭区间(库的语义)，不传则读到文件尾。 */
export async function smbOpenStream(
  sourceId: string,
  cfg: SmbConfig,
  p: string,
  opts?: { start?: number; end?: number },
): Promise<{ stream: any; size: number }> {
  try {
    const client = getSmbClient(sourceId, cfg);
    const stream = (await withTimeout(
      client.createReadStream(wirePath(p), opts as any),
      OP_TIMEOUT_MS,
      "open",
    )) as any;
    return { stream, size: Number(stream?.fileSize ?? 0) || 0 };
  } catch (e) {
    noteError(sourceId, e);
    throw e;
  }
}

function collectStream(stream: any, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (e: any) => {
      if (settled) return;
      settled = true;
      try { stream.destroy?.(); } catch { /* ignore */ }
      reject(e);
    };
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new Error(`SMB 文件过大(上限 ${maxBytes} 字节)`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", fail);
  });
}

/** 读文件头/区间(扫描取标签用)：闭区间。 */
export async function smbReadRange(
  sourceId: string,
  cfg: SmbConfig,
  p: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const { stream } = await smbOpenStream(sourceId, cfg, p, { start, end });
  const want = Math.max(0, end - start + 1);
  return collectStream(stream, want + 1024);
}

/** 整文件读入内存(供 sendspin 等需要 Buffer 的链路；有 100MB 上限)。 */
export async function smbReadFile(
  sourceId: string,
  cfg: SmbConfig,
  p: string,
  maxBytes: number = SMB_MAX_BUFFER_BYTES,
): Promise<Buffer> {
  const { stream, size } = await smbOpenStream(sourceId, cfg, p);
  if (size > maxBytes) {
    try { stream.destroy?.(); } catch { /* ignore */ }
    throw new Error(`SMB 文件过大(${size} 字节，上限 ${maxBytes})`);
  }
  return collectStream(stream, maxBytes);
}

/** 源被删除/停用时主动断开，避免连接池里留死连接。 */
export function closeSmbSource(sourceId?: string): void {
  if (sourceId) {
    dropPool(sourceId);
    return;
  }
  for (const id of [...pool.keys()]) dropPool(id);
}

/** 连接测试：连上 + 列一次根目录(证明鉴权与目录权限都通)。 */
export async function testSmbConnection(raw: any): Promise<{
  success: boolean;
  message?: string;
  error?: string;
  fileCount?: number;
}> {
  const cfg = buildSmbConfig(raw);
  if (!cfg) return { success: false, error: "SMB 配置缺少服务器地址或共享名" };
  const client = new SMB2({
    share: shareRoot(cfg),
    domain: cfg.domain,
    username: cfg.username,
    password: cfg.password,
    port: cfg.port,
    autoCloseTimeout: 5000,
  });
  try {
    const list = (await withTimeout(
      client.readdir(wirePath(cfg.root_path), {} as any),
      15000,
      "测试连接",
    )) as any[];
    const n = Array.isArray(list) ? list.length : 0;
    return { success: true, message: `连接成功 (${n} 个条目)`, fileCount: n };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) || "无法连接 SMB 共享" };
  } finally {
    try { client.disconnect(); } catch { /* 已断开 */ }
  }
}
