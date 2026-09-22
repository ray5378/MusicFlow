/**
 * 回环 raw 流的「可随机访问」代理层(PERF-B,2026-09-23)
 * ============================================================
 * **要解决的问题**
 * 本实例曲库全是天翼网盘 WebDAV(`w:<src>:` 前缀),其中大量是无 SEEKTABLE 的 FLAC。
 * ffmpeg 对这种输入做**输入侧定位**(`-ss`,见 `audio/pipeline.ts:72-73`)时无法直接算字节
 * 偏移,只能在目标点附近**反复用开放式 Range 回溯找帧同步** —— 实测 `-ss 129` 要发
 * **9 次 `Range: bytes=N-`**(每次都从 N 一直拉到 EOF),耗时 4~13s;而同一首歌落到**本地
 * 文件路径**上是 **13ms**(详见 `docs/PLAYBACK_SEEK_OPTIMIZATION.md` §6.3)。
 *
 * **做法**:在回环 raw 分支上加一层**稀疏块缓存**,让第 2 次起的回溯 Range 命中本地字节。
 *
 * ### ⚠️ 形态红线:首响应**不允许**等数据(2026-09-23 事故沉淀)
 * 第一版实现是「先把 256KB 窗口整段下载完,再构造响应」。上游(网盘)并发一紧张,
 * 这一步就把首响应拖到几十秒 ⇒ 服务端 408、ffmpeg 卡住、听感「拖动后一直卡住 / 没声音」。
 * **旧版(纯透传)之所以不出事,是因为它拿到上游响应头就立刻转发** —— 首响延迟只等一个 TTFB。
 * ⇒ 本层必须保住这条性质:**响应头在上游响应头到达后立刻发出,数据边下边喂**。
 * 于是本层只有两种形态:
 *   ① **透传 + 镜像**:未命中时,转发上游状态行与头,并在 pull 里把经过的字节顺手写进缓存;
 *   ② **缓存供给**:请求起点落在已缓存区间时,直接本地供给(零上游往返);
 * 另在透传时**并行补一块前缀**(`[块首, 请求起点)`),因为 ffmpeg 的回溯是逐步**往前**退的,
 * 不补前缀的话后续更早的 Range 永远命中不了。
 *
 * ### 正确性红线(负向变体各守一条)
 * - V1 前缀补齐:不补 ⇒ 回溯每次都回源,优化白做;
 * - V2 查缓存:不做缓存查找 ⇒ 退化成旧行为;
 * - V3 起点:响应的首字节必须是**请求的逻辑起点**,不是窗口的物理起点(否则整首错位);
 * - V4 有效区间:块必须带 `[from,to)`,半个块不能当整块吐(否则给 ffmpeg 喂零字节);
 * - V5 不吐未取得字节:镜像/供给都只能吐真实取到的字节。
 *
 * **其它边界(踩过的坑)**
 * - 镜像必须**限量**(MAX_MIRROR_BYTES),否则一首 26MB 的歌会被整首塞进内存;
 * - 回源异常 / 上游不认 Range / 空响应 ⇒ **一律退回旧的纯透传**(宁可慢,不能给错字节),
 *   并打 `[rawStreamCache]` 告警(生产上「播到一半静音」没有日志就只能靠猜);
 * - 缓存账本受 MAX_SOURCES × MAX_SOURCE_MB 约束,命中要挪到 LRU 末尾。
 *
 * **降级**:`RAW_STREAM_CACHE=0` 关闭本层,回到旧的纯透传(也用于 A/B 对照)。
 */

const KB = 1024;
const MB = 1024 * KB;

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** 缓存粒度(字节)。seek 回溯集中区(~85KB)落在一块内 ⇒ 一次回源覆盖后续几次探针。 */
export const RAW_BLOCK_BYTES = envInt("RAW_CACHE_BLOCK_KB", 256) * KB;
/** 单个上游(entry)最多缓存多少字节。 */
const MAX_SOURCE_BYTES = envInt("RAW_CACHE_SOURCE_MB", 16) * MB;
/** 最多同时保留多少个上游 entry。 */
const MAX_SOURCES = envInt("RAW_CACHE_SOURCES", 4);
/** entry 空闲多久可被回收。 */
const SOURCE_TTL_MS = envInt("RAW_CACHE_TTL_MIN", 10) * 60 * 1000;
/** 一次透传最多镜像多少字节进缓存(防止整首歌进内存)。 */
const MAX_MIRROR_BYTES = envInt("RAW_CACHE_MIRROR_MB", 2) * MB;

/** 总开关(默认开)。置 0/off/false = 回到旧的纯透传。 */
export function rawProxyEnabled(): boolean {
  const v = process.env.RAW_STREAM_CACHE;
  if (v === undefined || v === "") return true;
  return !(v === "0" || v === "off" || v === "false");
}

// ==================== Range 解析 ====================

export interface ParsedRange {
  /** 起点(字节)。suffix 形态(`bytes=-N`)时为负,由上游裁定。 */
  start: number;
  /** 终点(字节),null = 开放式 `bytes=N-`。 */
  end: number | null;
}

/** 解析 HTTP Range 头,非法返回 null(调用方按「无 Range」处理)。 */
export function parseRangeHeader(header?: string | null): ParsedRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === "") {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: -n, end: null };
  }
  const start = Number(s);
  if (!Number.isFinite(start)) return null;
  const end = e === "" ? null : Number(e);
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

/** 从 Content-Range 解出总长:206 是 `bytes S-E/T`,416 是 `bytes 星号/T`。 */
export function parseTotalFromRange(v?: string | null): number | undefined {
  if (!v) return undefined;
  const m = /bytes\s+[^/]*\/(\d+|\*)/i.exec(v.trim());
  if (!m) return undefined;
  if (m[1] === "*") return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseContentRangeStart(v?: string | null): number | undefined {
  if (!v) return undefined;
  const m = /bytes\s+(\d+)-/i.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

// ==================== 单个上游的稀疏块缓存 ====================

/** 一个缓存块。`[from,to)` 之外的字节**无效**,绝不能吐给下游。 */
interface Block {
  data: Uint8Array;
  from: number;
  to: number;
}

interface UpstreamHead {
  status: number;
  realStart: number;
  total?: number;
  contentType?: string | null;
  /** true = 上游没按 206 应答 ⇒ 本层不介入,调用方应透传。 */
  whole?: boolean;
}

class SourceCache {
  readonly key: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  blocks = new Map<number, Block>(); // 插入序 = 访问序(直接当 LRU 用)
  bytes = 0;
  touchedAt = Date.now();
  upstreamRequests = 0;
  /** 已从 Content-Range 探明的资源总长。 */
  total?: number;
  contentType?: string | null;
  /** 正在补的前缀区间(`块首 → 请求起点`),同一区间只发一次。 */
  prefixInflight = new Map<number, Promise<void>>();

  constructor(key: string, url: string, headers: Record<string, string>) {
    this.key = key;
    this.url = url;
    this.headers = headers;
  }

  touch(): void { this.touchedAt = Date.now(); }

  get(idx: number): Block | undefined {
    const b = this.blocks.get(idx);
    if (!b) return undefined;
    this.blocks.delete(idx);
    this.blocks.set(idx, b);
    this.touch();
    return b;
  }

  put(idx: number, blk: Block): void {
    const prev = this.blocks.get(idx);
    if (prev) this.bytes -= prev.data.length;
    this.blocks.set(idx, blk);
    this.bytes += blk.data.length;
    this.touch();
    this.trim();
  }

  private trim(): void {
    while (this.bytes > MAX_SOURCE_BYTES) {
      const oldest = this.blocks.keys().next();
      if (oldest.done) break;
      const victim = this.blocks.get(oldest.value)!;
      this.bytes -= victim.data.length;
      this.blocks.delete(oldest.value);
    }
  }

  clear(): void {
    this.blocks.clear();
    this.bytes = 0;
    this.prefixInflight.clear();
  }

  /** 该块里 off 处是否已是有效数据。 */
  static covers(blk: Block, off: number): boolean {
    return off >= blk.from && off < blk.to;
  }

  /**
   * 按块把一段数据写进缓存,并收紧有效区间 `[from,to)`。
   *
   * ⚠️ **不相连的两段绝不能合并**:Block 只有一个区间,合并会把中间的空洞算成有效数据
   * (典型来源:上游短读 —— 声明 1000 字节只给 500,补块又只补到 500,中间就空了)。
   * 合并后 `[from,to)` 会覆盖空洞 ⇒ 给 ffmpeg 喂零字节 ⇒ 症状是「拖动后无声」。
   * ⇒ 不相连时**丢弃**旧区间,只认这次真实写进来的字节。
   */
  store(start: number, data: Uint8Array): void {
    if (data.length === 0) return;
    let pos = start;
    let off = 0;
    while (off < data.length) {
      const idx = Math.floor(pos / RAW_BLOCK_BYTES);
      const inBlock = pos - idx * RAW_BLOCK_BYTES;
      const take = Math.min(RAW_BLOCK_BYTES - inBlock, data.length - off);
      let blk = this.blocks.get(idx);
      if (!blk) {
        blk = { data: new Uint8Array(RAW_BLOCK_BYTES), from: RAW_BLOCK_BYTES, to: 0 };
        this.put(idx, blk);
        blk = this.get(idx)!;
      }
      blk.data.set(data.subarray(off, off + take), inBlock);
      const lo = inBlock;
      const hi = inBlock + take; // [lo, hi)
      if (blk.to === 0) {
        // 空块:第一次写入
        blk.from = lo;
        blk.to = hi;
      } else if (lo <= blk.to && hi >= blk.from) {
        // 与已有区间重叠或首尾相接 ⇒ 正常扩张
        blk.from = Math.min(blk.from, lo);
        blk.to = Math.max(blk.to, hi);
      } else {
        // 不相连(中间有空洞)⇒ 只认这一段
        blk.from = lo;
        blk.to = hi;
      }
      pos += take;
      off += take;
    }
  }
}

// ==================== entry 注册表 ====================

const registry = new Map<string, SourceCache>();

function cacheKey(url: string, headers: Record<string, string>): string {
  const h = Object.keys(headers).sort().map((k) => `${k}=${headers[k]}`).join("&");
  return `${url}|${h}`;
}

function sweep(): void {
  const now = Date.now();
  for (const [k, src] of registry) {
    if (now - src.touchedAt > SOURCE_TTL_MS) {
      src.clear();
      registry.delete(k);
    }
  }
  while (registry.size > MAX_SOURCES) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, src] of registry) {
      if (src.touchedAt < oldestAt) { oldestAt = src.touchedAt; oldestKey = k; }
    }
    if (!oldestKey) break;
    registry.get(oldestKey)?.clear();
    registry.delete(oldestKey);
  }
}

function acquire(url: string, headers: Record<string, string>): SourceCache {
  sweep();
  const key = cacheKey(url, headers);
  const found = registry.get(key);
  if (found) { found.touch(); return found; }
  const created = new SourceCache(key, url, headers);
  registry.set(key, created);
  return created;
}

/** 可观测 / 测试用:当前缓存账本。 */
export function describeRawCache(): {
  sources: number;
  bytes: number;
  blocks: number;
  upstreamRequests: number;
  entries: Array<{ url: string; blocks: number; bytes: number }>;
} {
  let bytes = 0;
  let blocks = 0;
  let upstreamRequests = 0;
  const entries: Array<{ url: string; blocks: number; bytes: number }> = [];
  for (const src of registry.values()) {
    bytes += src.bytes;
    blocks += src.blocks.size;
    upstreamRequests += src.upstreamRequests;
    entries.push({ url: src.url, blocks: src.blocks.size, bytes: src.bytes });
  }
  return { sources: registry.size, bytes, blocks, upstreamRequests, entries };
}

/** 测试用:清空全部缓存。 */
export function resetRawCache(): void {
  for (const src of registry.values()) src.clear();
  registry.clear();
}

// ==================== 告警(回退/异常必须留痕) ====================

const warnLast = new Map<string, number>();
function warnThrottled(key: string, msg: string): void {
  const now = Date.now();
  const last = warnLast.get(key) || 0;
  if (now - last < 30_000) return;
  warnLast.set(key, now);
  if (warnLast.size > 200) warnLast.clear();
  try {
    console.warn(`[rawStreamCache] ${msg}`);
  } catch { /* 日志不可用绝不能影响取流 */ }
}

// ==================== 回源 ====================

/**
 * 只等**响应头**:拿到 header 就返回,body 交给调用方按需 pull。
 * 这是「首响应延迟与旧版一致」的关键,绝不能在返回前 `await arrayBuffer()`。
 */
async function openUpstream(
  src: SourceCache,
  rangeHeader: string,
  signal?: AbortSignal,
): Promise<{ head: UpstreamHead; response?: Response }> {
  const headers: Record<string, string> = { ...src.headers, Range: rangeHeader };
  src.upstreamRequests += 1;
  const res = await fetch(src.url, {
    headers,
    redirect: "follow",
    ...(signal ? { signal } : {}),
  });
  const contentRange = res.headers.get("content-range");
  const total = parseTotalFromRange(contentRange);
  const crStart = parseContentRangeStart(contentRange);
  const contentType = res.headers.get("content-type");
  if (total !== undefined) src.total = total;
  if (contentType) src.contentType = contentType;
  if (res.status === 416) {
    await res.body?.cancel().catch(() => {});
    return { head: { status: 416, realStart: 0, total, contentType } };
  }
  if (res.status !== 206 || crStart === undefined) {
    return { head: { status: res.status, realStart: 0, total, contentType, whole: true }, response: res };
  }
  return { head: { status: res.status, realStart: crStart, total, contentType }, response: res };
}

/**
 * 把经过的字节写进缓存,受**单次镜像预算**约束(见 MAX_MIRROR_BYTES)。
 * 预算是**硬上限**:只写前 `allow` 字节,绝不让一个 chunk 把总量顶穿
 * (否则块粒度记账会多算一整块,整首歌的镜像量就不可控了)。
 */
function mirrorInto(src: SourceCache, pos: number, buf: Uint8Array, state: { mirrored: number }): void {
  const allow = MAX_MIRROR_BYTES - state.mirrored;
  if (allow <= 0 || buf.length === 0) return;
  const slice = buf.length <= allow ? buf : buf.subarray(0, allow);
  src.store(pos, slice);
  state.mirrored += slice.length;
}

/**
 * 后台补**一整块** `[块首, 块尾)`,让后续落在这块里的 Range 全部命中。
 *
 * ### ⚠️ 两条都不能省(都是真机踩出来的)
 * 1. **绝不能传客户端的 `signal`**。ffmpeg 的 seek 回溯是「读几百字节就断连、再发下一个 Range」,
 *    请求一结束 signal 就 abort ⇒ 带着 signal 的补块**必然被自己掐断**,缓存永远补不上,
 *    优化在真机上等于白做(首版在 240 上「开关开着却没收益」的根因)。
 *    主线响应仍带 signal(客户端跑了就该停),**只有后台补块不带**。
 * 2. **必须 `.catch()`**。后台 fetch 失败若冒泡成 unhandled rejection,
 *    Node 默认会直接**杀进程** —— 这是「一个性能优化把整个服务搞挂」的最短路径。
 */
function warmBlock(src: SourceCache, serveStart: number): void {
  const blkStart = Math.floor(serveStart / RAW_BLOCK_BYTES) * RAW_BLOCK_BYTES;
  const idx = Math.floor(blkStart / RAW_BLOCK_BYTES);
  let blkEnd = blkStart + RAW_BLOCK_BYTES - 1;
  if (src.total !== undefined) blkEnd = Math.min(blkEnd, src.total - 1);
  if (blkEnd < blkStart) return;
  const need = blkEnd - blkStart + 1; // 需要覆盖的块内字节数
  const existing = src.blocks.get(idx);
  if (existing && existing.from === 0 && existing.to >= need) return; // 这块已经满了
  if (src.prefixInflight.has(blkStart)) return;
  const p = (async () => {
    const { head, response } = await openUpstream(src, `bytes=${blkStart}-${blkEnd}`);
    if (!response) return;
    try {
      const buf = new Uint8Array(await response.arrayBuffer());
      src.store(head.realStart, buf);
    } catch { /* 后台补齐失败无所谓,主线不受影响 */ }
  })()
    .catch(() => {})
    .finally(() => src.prefixInflight.delete(blkStart));
  src.prefixInflight.set(blkStart, p);
}

// ==================== 响应构造 ====================

function toWebStream(
  produce: () => Promise<Uint8Array | null>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const chunk = await produce();
        if (chunk === null) { ctrl.close(); return; }
        if (chunk.length > 0) ctrl.enqueue(chunk);
      } catch (e: any) {
        ctrl.error(e);
      }
    },
    cancel() { onCancel?.(); },
  });
}

function copyPassthrough(res: Response, tag = "passthrough"): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-cache" };
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === "transfer-encoding") return;
    headers[k] = v;
  });
  headers["X-MusicFlow-RawCache"] = tag;
  return new Response(res.body, { status: res.status, headers });
}

export interface ProxyRawOptions {
  url: string;
  headers?: Record<string, string>;
  rangeHeader?: string | null;
  signal?: AbortSignal;
}

/** 旧行为:直接把上游响应透传(本层无法介入 / 不确定时的兜底)。 */
async function passthrough(opts: ProxyRawOptions): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.rangeHeader) headers["Range"] = opts.rangeHeader;
  const upstream = await fetch(opts.url, {
    headers,
    redirect: "follow",
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return copyPassthrough(upstream);
}

/** 缓存里 serveStart 所在块的可用字节数(不足返回 0)。 */
function cachedRunLength(src: SourceCache, pos: number): number {
  const idx = Math.floor(pos / RAW_BLOCK_BYTES);
  const blk = src.get(idx);
  if (!blk) return 0;
  const off = pos - idx * RAW_BLOCK_BYTES;
  if (!SourceCache.covers(blk, off)) return 0;
  return blk.to - off;
}

/**
 * 处理回环 raw 流的一个 GET:Range 语义与上游等价,命中缓存时零上游往返。
 * **性质**:响应头在上游响应头到达后立刻发出(与旧版纯透传同量级),数据边下边喂。
 */
export async function proxyRawRange(opts: ProxyRawOptions): Promise<Response> {
  if (!rawProxyEnabled()) return passthrough(opts);
  const range = parseRangeHeader(opts.rangeHeader);
  const src = acquire(opts.url, opts.headers || {});
  const before = src.upstreamRequests;

  try {
    // ---------- suffix(`bytes=-N`):起点由服务器裁定,本层无法预估落点 ⇒ 透传 ----------
    if (range && range.start < 0) {
      return passthrough(opts);
    }
    const serveStart = range ? range.start : 0;

    // ---------- ① 命中缓存 ⇒ 本地供给(零上游往返) ----------
    if (src.total !== undefined && cachedRunLength(src, serveStart) > 0) {
      const total = src.total;
      const lastByte = range?.end === null || range?.end === undefined
        ? total - 1
        : Math.min(range.end, total - 1);
      if (serveStart > lastByte || serveStart >= total) {
        return new Response(null, {
          status: 416,
          headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${total}`, "X-MusicFlow-RawCache": "416" },
        });
      }
      let pos = serveStart;
      // ⚠️ 续接必须**一条上游请求读到完**。
      // 曾经写成「每个 chunk 现场 openUpstream 一次」⇒ 缓存放完之后变成**每 chunk 一次网盘往返**
      // (真实网盘 TTFB ≈450ms)⇒ 256KB 缓存放完(≈2 秒音频)就开始逐 chunk 卡顿直至停住。
      // 240 实测:同一首歌 `-t 2` 从 2.2s 变成 **21 分钟**且零输出。别再写回去。
      let tailReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const tailBudget = { mirrored: 0 };
      const produce = async (): Promise<Uint8Array | null> => {
        if (pos > lastByte) return null;
        // ⚠️ 一旦交给上游,就**绝不再回头读缓存**。
        // 上游那条流是顺序覆盖 [tailStart, EOF] 的:若中途又去命中一个已缓存的块,
        // 那段字节会被**吐两次**(缓存一次 + 上游流再一次)⇒ 整条流「前面多一段、末尾被
        // pos > lastByte 截掉抵消」,总长度还一样,极难发现。
        // 240 实测:整曲 md5 与直连不符、且两次回环互不相同,首个差异正好落在块边界。
        if (tailReader) {
          const { done, value } = await tailReader.read();
          if (done) return null;
          const buf = new Uint8Array(value);
          mirrorInto(src, pos, buf, tailBudget);
          pos += buf.length;
          return buf;
        }
        const idx = Math.floor(pos / RAW_BLOCK_BYTES);
        const blk = src.get(idx);
        const off = pos - idx * RAW_BLOCK_BYTES;
        if (blk && SourceCache.covers(blk, off)) {
          const take = Math.min(blk.to - off, lastByte - pos + 1);
          // ⚠️ 用 slice(拷贝)而不是 subarray(视图):块缓冲区是可变的,
          //    后台补块随时可能往同一块里写,吐视图等于把「以后才确定的内容」交给下游。
          const chunk = blk.data.slice(off, off + take);
          pos += take;
          return chunk;
        }
        // 缓存用尽 ⇒ 转上游续接(一次请求,持续读到结束;仍然边下边喂)
        if (!tailReader) {
          // 上游偶发 5xx(实测网盘会返回 500)⇒ **重试一次**,别让一次抖动就断流。
          let opened = false;
          for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
            const upstream = await openUpstream(src, `bytes=${pos}-${lastByte}`, opts.signal);
            // 上游没按 206 从请求起点应答 ⇒ 字节会错位,绝不能接着喂
            if (upstream.response && !upstream.head.whole && upstream.head.realStart === pos) {
              tailReader = upstream.response.body!.getReader();
              opened = true;
              break;
            }
            if (upstream.response) await upstream.response.body?.cancel().catch(() => {});
            warnThrottled(
              `tail:${src.key}`,
              `续接重试(${attempt}/2):上游未按 206 从 ${pos} 应答(status=${upstream.head.status},start=${upstream.head.realStart})`,
            );
          }
          if (!opened) {
            // ⚠️ 必须**报错**而不是 return null:静默收尾会被下游当成「这首歌放完了」,
            //    sendspin 会据此自动切下一首 —— 比一个明确的取流错误更糟。
            warnThrottled(`tail-fail:${src.key}`, `续接彻底失败 @${pos} ⇒ 让下游看到错误而不是假 EOF`);
            throw new Error(`rawStreamCache: 续接失败 @${pos}`);
          }
        }
        // 上面要么赋值成功、要么 throw ⇒ 此处必非空(TS 无法证明循环体至少执行一次,故显式收敛)
        const tail = tailReader!;
        const { done, value } = await tail.read();
        if (done) return null;
        const buf = new Uint8Array(value);
        mirrorInto(src, pos, buf, tailBudget);
        pos += buf.length;
        return buf;
      };
      const headers: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        "Content-Length": String(Math.max(0, lastByte - serveStart + 1)),
        "X-MusicFlow-RawCache": `hit;block=${RAW_BLOCK_BYTES};upstream=${src.upstreamRequests - before}`,
      };
      if (src.contentType) headers["Content-Type"] = src.contentType;
      if (opts.rangeHeader) headers["Content-Range"] = `bytes ${serveStart}-${lastByte}/${total}`;
      return new Response(
        toWebStream(produce, () => { void tailReader?.cancel().catch(() => {}); }),
        { status: opts.rangeHeader ? 206 : 200, headers },
      );
    }

    // ---------- ② 未命中 ⇒ 透传 + 镜像(+ 并行补前缀) ----------
    // Range 原样转发(保持旧版语义:上游决定真实起点与总长);只等响应头,不等数据。
    const reqRange = opts.rangeHeader || `bytes=0-`;
    const { head, response } = await openUpstream(src, reqRange, opts.signal);
    if (!response) {
      if (head.status === 416) {
        return new Response(null, {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "X-MusicFlow-RawCache": "416",
            ...(head.total !== undefined ? { "Content-Range": `bytes */${head.total}` } : {}),
          },
        });
      }
      return passthrough(opts);
    }
    if (head.whole || head.total === undefined) {
      warnThrottled(`whole:${src.key}`, `回退透传:上游未按 206 应答(status=${head.status}) ⇒ 本层不介入`);
      return copyPassthrough(response);
    }
    const total = head.total;
    const realStart = head.realStart;
    // 上游答的数据没覆盖到请求的逻辑起点 ⇒ 不确定就退回透传
    if (serveStart !== realStart) {
      warnThrottled(
        `start:${src.key}`,
        `回退透传:上游应答起点 ${realStart} 与请求起点 ${serveStart} 不一致`,
      );
      await response.body?.cancel().catch(() => {});
      return passthrough(opts);
    }
    const lastByte = range?.end === null || range?.end === undefined ? total - 1 : Math.min(range.end, total - 1);

    // 后台补整块(不带客户端 signal —— 见 warmBlock 注释:带了就会被自己掐断)
    warmBlock(src, realStart);

    const reader = response.body!.getReader();
    let pos = realStart;
    const budget = { mirrored: 0 };
    const produce = async (): Promise<Uint8Array | null> => {
      if (pos > lastByte) return null;
      const { done, value } = await reader.read();
      if (done) return null;
      const buf = new Uint8Array(value);
      mirrorInto(src, pos, buf, budget);
      pos += buf.length;
      return buf;
    };
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
      "Content-Length": String(Math.max(0, lastByte - realStart + 1)),
      "X-MusicFlow-RawCache": `miss;block=${RAW_BLOCK_BYTES};upstream=${src.upstreamRequests - before}`,
    };
    if (head.contentType) headers["Content-Type"] = head.contentType;
    if (opts.rangeHeader) headers["Content-Range"] = `bytes ${realStart}-${lastByte}/${total}`;
    return new Response(
      toWebStream(produce, () => { void reader.cancel().catch(() => {}); }),
      { status: opts.rangeHeader ? 206 : 200, headers },
    );
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    warnThrottled(`err:${src.key}`, `回退透传:本层异常 ${e?.message || e}`);
    try {
      return await passthrough(opts);
    } catch {
      throw e;
    }
  }
}
