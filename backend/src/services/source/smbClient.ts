// ==================== SMB 客户端(Python 桥接进程 + 薄适配层) ====================
//
// 为什么是"桥接进程"而不是纯 JS 库：
//   - v9u-smb2 只实现 SMB2，没有 SMB3 加密；服务端 `smb encrypt = required`
//     (飞牛等 NAS 的默认策略)时 tree connect 直接 STATUS_ACCESS_DENIED；
//   - 容器非特权，mount.cifs / 系统 smbclient 都不可用。
//   smbprotocol(纯 Python SMB2/3，自带 AES-CCM)能连加密共享，且 open_file 支持
//   按偏移 seek/read。Node 侧只保留对外的四个动作(stat / readdir / 读一段字节 /
//   开文件流)，底层实现不出现在其它模块里。
//
// 连接策略：
//   - 每个音源一条桥接进程(按 sourceId + 配置指纹复用)，进程内复用一条 SMB 会话；
//   - 空闲 10 分钟自动关闭进程，下次调用重新拉起；
//   - 连接级错误由 Python 侧重连重试一次；进程退出/超时才丢弃池条目。
//
// 并发：桥接进程串行处理请求(SMB 单会话本来也是串行复用)，扫描/预取/播放共用
// 一条会话，避免触发 NAS "同一账号并发连接数" 限制。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mediaSources } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("SMB");

/** 空闲关闭：太长会占着 NAS 连接，太短会让暂停播放的流断在半路。 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** 单次操作超时(子进程卡死不能永久挂住调用方)。 */
const OP_TIMEOUT_MS = 30 * 1000;
/** 读整首的上限，与网络源内存缓冲口径一致(100MB)。 */
export const SMB_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
/** 每块读取大小：太小往返多，太大占内存/阻塞同一进程的其它请求。 */
const CHUNK_BYTES = 256 * 1024;

const PYTHON_BIN = process.env.MF_SMB_PYTHON || "python3";
/** 编译后与本文件同目录(dist 里由 build 脚本一并拷贝)。 */
const BRIDGE_SCRIPT = fileURLToPath(new URL("./smbBridge.py", import.meta.url));

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

/** 共享内路径归一：统一 `/` 分隔、绝对路径、去掉重复斜杠与尾部斜杠。 */
export function normalizeSmbPath(p: string | null | undefined): string {
  let s = String(p ?? "").replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s || "/";
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

function configKey(cfg: SmbConfig): string {
  return [cfg.host, cfg.port, cfg.share, cfg.domain, cfg.username, cfg.password].join("\u0000");
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 一个音源一条桥接进程：请求按 id 匹配，响应顺序无关，但执行是串行的。 */
class SmbBridge {
  readonly key: string;
  /** hello 握手结果；后续所有调用都先等它。 */
  readonly ready: Promise<void>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private closed = false;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(cfg: SmbConfig) {
    this.key = configKey(cfg);
    this.child = spawn(PYTHON_BIN, ["-u", BRIDGE_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });

    let buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.onLine(line);
        idx = buf.indexOf("\n");
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = String(chunk).trim();
      if (text) log.warn("SMB 桥接进程", { detail: text.slice(0, 500) });
    });
    this.child.on("error", (err) => {
      log.warn("SMB 桥接进程启动失败", { err: err.message });
      this.failAll(err);
    });
    this.child.on("exit", (code, signal) => {
      this.failAll(new Error(`SMB 桥接进程退出(code=${code}, signal=${signal})`));
    });

    this.ready = this.call({ op: "hello", config: cfg }, 30_000).then(() => undefined);
    // 调用方会 await 拿到失败原因；这里再挂一个空 catch，避免早期拒绝变成
    // unhandledRejection 把进程日志刷满。
    void this.ready.catch(() => {});
  }

  /** 发一条请求；超时即认为子进程卡死，直接杀掉(下次调用重新拉起)。 */
  call(req: Record<string, unknown>, timeoutMs: number = OP_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(new Error("SMB 桥接进程已关闭"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SMB ${String(req.op)} 超时(${timeoutMs}ms)`));
        this.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.touch();
      try {
        this.child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** 主动关闭(源被删除/停用，或配置变了要重建)。 */
  kill(): void {
    this.failAll(new Error("SMB 桥接进程已关闭"));
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    try {
      this.child.stdin.end();
    } catch {
      /* 已关闭 */
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn("无法解析桥接进程输出", { line: line.slice(0, 200) });
      return;
    }
    const hit = this.pending.get(msg?.id);
    if (!hit) return;
    this.pending.delete(msg.id);
    clearTimeout(hit.timer);
    if (msg.ok) hit.resolve(msg.result);
    else hit.reject(new Error(msg?.error?.message || "SMB 操作失败"));
  }
}

const pool = new Map<string, SmbBridge>();

function dropPool(sourceId: string): void {
  const hit = pool.get(sourceId);
  if (!hit) return;
  pool.delete(sourceId);
  hit.kill();
}

/** 取(或新建)该音源的桥接进程。配置指纹变了就重建。 */
function getBridge(sourceId: string, cfg: SmbConfig): SmbBridge {
  const key = configKey(cfg);
  const hit = pool.get(sourceId);
  if (hit && hit.key === key) return hit;
  if (hit) dropPool(sourceId);
  const bridge = new SmbBridge(cfg);
  pool.set(sourceId, bridge);
  return bridge;
}

/** 列目录(带 stat：一次往返拿到 size/mtime/是否目录)。 */
export async function smbReaddir(sourceId: string, cfg: SmbConfig, dir: string): Promise<SmbEntry[]> {
  const bridge = getBridge(sourceId, cfg);
  await bridge.ready;
  const base = normalizeSmbPath(dir);
  const list = (await bridge.call({ op: "readdir", path: base })) as any[];
  return (Array.isArray(list) ? list : []).map((v) => ({
    name: String(v?.name ?? ""),
    path: normalizeSmbPath(`${base}/${v?.name ?? ""}`),
    size: Number(v?.size ?? 0) || 0,
    mtimeMs: Number(v?.mtimeMs ?? 0) || 0,
    isDirectory: !!v?.isDirectory,
  }));
}

/** 单文件/目录 stat；文件不存在会抛错(调用方按不可用处理)。 */
export async function smbStat(sourceId: string, cfg: SmbConfig, p: string): Promise<SmbStatResult> {
  const bridge = getBridge(sourceId, cfg);
  await bridge.ready;
  const st = (await bridge.call({ op: "stat", path: normalizeSmbPath(p) })) as any;
  return {
    size: Number(st?.size ?? 0) || 0,
    mtimeMs: Number(st?.mtimeMs ?? 0) || 0,
    isDirectory: !!st?.isDirectory,
  };
}

/** 按块拉取的只读流：Node 侧背压直接映射到"下一次 read 请求"。 */
class SmbReadable extends Readable {
  private handle: number | null;
  private sent = 0;
  private busy = false;
  private done = false;

  constructor(
    private readonly bridge: SmbBridge,
    handle: number,
    /** 0 表示读到文件尾；否则最多再吐这么多字节(闭区间换算结果)。 */
    private readonly limit: number,
  ) {
    super({ highWaterMark: CHUNK_BYTES });
    this.handle = handle;
  }

  _read(): void {
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.done || this.handle === null) return;
    this.busy = true;
    try {
      while (!this.done && this.handle !== null && !this.destroyed) {
        const want = this.limit > 0 ? Math.min(CHUNK_BYTES, this.limit - this.sent) : CHUNK_BYTES;
        if (want <= 0) {
          this.done = true;
          this.push(null);
          break;
        }
        const res = await this.bridge.call({ op: "read", handle: this.handle, length: want });
        const buf = Buffer.from(String(res?.data ?? ""), "base64");
        if (buf.length === 0) {
          this.done = true;
          this.push(null);
          break;
        }
        this.sent += buf.length;
        if (!this.push(buf)) break; // 背压：等 _read 再次被调用
      }
    } catch (err) {
      this.destroy(err as Error);
    } finally {
      this.busy = false;
    }
  }

  _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    const handle = this.handle;
    this.handle = null;
    this.done = true;
    if (handle !== null) {
      void this.bridge.call({ op: "closeFile", handle }, 5_000).catch(() => {
        /* 进程可能已退出，句柄随之释放 */
      });
    }
    cb(err);
  }
}

/** 打开文件流；`end` 为闭区间(与旧实现保持一致)，不传则读到文件尾。 */
export async function smbOpenStream(
  sourceId: string,
  cfg: SmbConfig,
  p: string,
  opts?: { start?: number; end?: number },
): Promise<{ stream: Readable; size: number }> {
  const bridge = getBridge(sourceId, cfg);
  await bridge.ready;
  const start = Math.max(0, Number(opts?.start) || 0);
  const res = await bridge.call({ op: "open", path: normalizeSmbPath(p), start });
  const size = Number(res?.size ?? 0) || 0;
  const limit = typeof opts?.end === "number" ? Math.max(0, opts.end - start + 1) : 0;
  return { stream: new SmbReadable(bridge, Number(res?.handle), limit), size };
}

function collectStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
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
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(`SMB 文件过大(${size} 字节，上限 ${maxBytes})`);
  }
  return collectStream(stream, maxBytes);
}

/** 源被删除/停用时主动断开，避免池里留死进程。 */
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
  const bridge = new SmbBridge(cfg);
  try {
    await bridge.ready;
    const list = (await bridge.call({ op: "readdir", path: cfg.root_path }, 15_000)) as any[];
    const n = Array.isArray(list) ? list.length : 0;
    return { success: true, message: `连接成功 (${n} 个条目)`, fileCount: n };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) || "无法连接 SMB 共享" };
  } finally {
    bridge.kill();
  }
}
