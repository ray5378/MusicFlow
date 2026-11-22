// ==================== 标签可信度闸门（三条链路共用） ====================
//
// 背景（2026-11-23 真机）：云盘修复把何韵诗《好奇心杀死猫》写进了 SNOW THA PRODUCT 的封面、
// 把吴奇隆《思念就像一条河流》写进了《追风少年》的封面，还把「专辑=歌名」的占位值写进文件。
// 根因是「搜到的图不一定属于这首歌」，而原来三条链路（云盘修复 / 本地修复 / 下载洗版）
// 各自直接采用 provider 结果，没有任何一致性判据。
//
// 这里收口成三个纯函数，三条链路都调它，避免口径分裂：
//   1) coverAllowed   —— 封面必须能证明归属，否则宁可不写；
//   2) writableAlbum  —— 「专辑=歌名」是占位值，不写；
//   3) needLyricByFile—— 是否有歌词只看文件，不信 DB 的 has_lyrics（云盘上它经常是脏的）。
//
// 判据刻意保守：**宁可少写，也不写错**。少写只是"缺"，写错会污染曲库且难回溯。

const PLACEHOLDER_ALBUMS = new Set(["unknown album", "未知专辑"]);
const PLACEHOLDER_ARTISTS =
  /^(unknown artist|未知歌手|网络歌手|群星|华语群星|佚名|various artists)$/i;

/** 归一化：小写、去空白与常见标点，用于「专辑=歌名」「歌手一致」这类等值判断。 */
export function normKey(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[\s\-_/\\()（）\[\]【】,，.。!！?？'"“”‘’·~]/g, "");
}

/** 歌手分词（中文顿号/逗号/斜杠/空白都算分隔），占位歌手不参与否决。 */
export function artistTokens(v: unknown): string[] {
  const whole = String(v ?? "").trim();
  // 整串就是占位歌手（"Unknown Artist" / "群星"…）⇒ 不产生任何 token（不参与否决）
  if (!whole || PLACEHOLDER_ARTISTS.test(whole)) return [];
  return whole
    .split(/[、,，/&;；|·]+|\s+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length >= 2 && !PLACEHOLDER_ARTISTS.test(x));
}

/**
 * 异体字/人名用字的近似判定（2026-11-23）：
 * 简繁表（OpenCC T2S）只覆盖「繁→简」，不合并异体字（蒨/倩、峯/峰、喆/哲…）。
 * 歌手名同长度且**只差一个字**、且两边都是汉字时视为同一人 ——
 * 实测「叶蒨文 vs 叶倩文」这种就是异体字写法差异，不该判成两个人。
 * 限定长度 ≥3：两字名（王菲/王非）差一个字就可能是别人，不放过。
 */
export function nameCloseMatch(a: unknown, b: unknown): boolean {
  const x = String(a ?? "").trim();
  const y = String(b ?? "").trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length !== y.length || x.length < 3) return false;
  if (!/[一-鿿]/.test(x) || !/[一-鿿]/.test(y)) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) {
      diff += 1;
      if (diff > 1) return false;
    }
  }
  return diff === 1;
}

/**
 * 在长串里找「近似包含」：用于标题行里带括注/英文名的写法
 * （"叶倩文(Sally Yeh)" 归一后是 "叶倩文sallyyeh"），整串比长度不等会漏，
 * 这里按窗口逐段比，任一段与目标近似即可。
 */
export function containsClose(hay: unknown, needle: unknown): boolean {
  const h = String(hay ?? "");
  const n = String(needle ?? "");
  if (!h || !n) return false;
  if (h.includes(n)) return true;
  if (n.length < 3 || h.length < n.length) return false;
  for (let i = 0; i + n.length <= h.length; i++) {
    if (nameCloseMatch(h.slice(i, i + n.length), n)) return true;
  }
  return false;
}

/** 歌手是否一致：分词后有交集即视为一致；任一侧无可信歌手 ⇒ 不否决（true）。 */
export function artistMatches(local: unknown, remote: unknown): boolean {
  const a = artistTokens(local);
  const b = artistTokens(remote);
  if (!a.length || !b.length) return true;
  return a.some((x) => b.some((y) => x === y || x.includes(y) || y.includes(x)));
}

export function isPlaceholderAlbum(v: unknown): boolean {
  const s = String(v ?? "").trim();
  if (!s) return true;
  return PLACEHOLDER_ALBUMS.has(s.toLowerCase());
}

/** 「专辑 = 歌名」或已知占位 ⇒ 不可信，不能写进文件。 */
export function albumIsPlaceholder(album: unknown, title: unknown): boolean {
  const a = String(album ?? "").trim();
  if (!a || isPlaceholderAlbum(a)) return true;
  const t = String(title ?? "").trim();
  if (!t) return false;
  return normKey(a) === normKey(t);
}

/**
 * 可写入的专辑名（不可用返回 null）。
 * 优先 DB 声明值（下载期 provider 写的），DB 是占位值时用元数据专辑；
 * 二者都等于歌名 ⇒ 不写。
 */
export function writableAlbum(opts: {
  dbAlbum?: unknown;
  metaAlbum?: unknown;
  title?: unknown;
}): string | null {
  const db = String(opts.dbAlbum ?? "").trim();
  const meta = String(opts.metaAlbum ?? "").trim();
  const title = opts.title;
  if (db && !albumIsPlaceholder(db, title)) return db;
  if (meta && !albumIsPlaceholder(meta, title)) return meta;
  return null;
}

export interface CoverContext {
  /** 本曲已知信息 */
  title?: unknown;
  artist?: unknown;
  /** DB 里的专辑（可能是占位值） */
  dbAlbum?: unknown;
  /** 元数据命中（searchMetadata 的结果） */
  metaAlbum?: unknown;
  metaArtist?: unknown;
  /** 元数据命中的来源插件 id 与封面命中的来源插件 id（onMatch 回调给） */
  metaProvider?: string | null;
  coverProvider?: string | null;
  /** 封面来源是否内置（内置=有严格评分）；undefined=调用方未上报 */
  builtinCover?: boolean;
}

export interface CoverDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * 封面是否可信。通过条件（满足任一）：
 *   A. 元数据与封面是**同一个 provider** 命中的（内置 tag-provider 有标题/歌手/专辑/时长评分，
 *      同一首歌两次调用复用同一候选 ⇒ 封面必然来自那首歌的专辑）；
 *   B. 元数据专辑与本曲专辑一致（DB 非占位时要求相等；DB 占位时只要求非占位），
 *      且歌手一致。
 * 其余一律拒绝——实测错图都是"歌手没对上 / 专辑是别的专辑"。
 */
export function coverAllowed(ctx: CoverContext): CoverDecision {
  const dbAlbum = String(ctx.dbAlbum ?? "").trim();
  const metaAlbum = String(ctx.metaAlbum ?? "").trim();
  const hasMeta = Boolean(metaAlbum || String(ctx.metaArtist ?? "").trim());
  const dbUsable = dbAlbum && !albumIsPlaceholder(dbAlbum, ctx.title);

  // ① 元数据在，就按它校验归属（这是唯一能证明"图属于这首歌"的证据）
  if (hasMeta) {
    if (!artistMatches(ctx.artist, ctx.metaArtist)) {
      return {
        allowed: false,
        reason: `歌手不一致(local=${String(ctx.artist ?? "")} meta=${String(ctx.metaArtist ?? "")})`,
      };
    }
    const sameProvider =
      Boolean(ctx.metaProvider) && ctx.metaProvider === ctx.coverProvider;
    if (dbUsable) {
      // 本曲专辑可信：元数据专辑必须能对上（空则视为未知，仍按同源判断）
      if (metaAlbum && normKey(dbAlbum) !== normKey(metaAlbum)) {
        return { allowed: false, reason: `专辑不一致(db=${dbAlbum} meta=${metaAlbum})` };
      }
      return { allowed: true, reason: sameProvider ? `同一来源命中(${ctx.metaProvider})` : "专辑+歌手一致" };
    }
    // 本曲专辑不可信（空/占位=歌名）：只有「元数据专辑就是歌名」（单曲常见）或
    // 「元数据与封面同源命中」才敢采信 —— 否则无从证明，宁可不写。
    if (metaAlbum && albumIsPlaceholder(metaAlbum, ctx.title)) {
      return { allowed: true, reason: "元数据专辑即单曲名" };
    }
    // ⚠️ 2026-11-23 真机教训：**同源命中不能当放行理由**。
    //   吴奇隆《思念就像一条河流》被 provider 命中到《追风少年》那张专辑，
    //   元数据与封面同源、标题也对得上，图却属于另一张专辑 —— 这类只能靠专辑对齐，
    //   本曲专辑不可用时一律不写（缺图好过错图）。
    return {
      allowed: false,
      reason: `本曲专辑未知，无法用元数据专辑对齐(db=${dbAlbum || "空"} meta=${metaAlbum || "空"})`,
    };
  }

  // ② 没有元数据：只有内置来源（标题/歌手/时长/版本严格评分）的封面可采信；
  //    外置来源按标题松匹配，实测会拿到别的歌/别的专辑的图 ⇒ 拒绝。
  if (ctx.coverProvider && ctx.builtinCover === false) {
    return { allowed: false, reason: `无元数据且来源非内置(${ctx.coverProvider})` };
  }
  return { allowed: true, reason: "无元数据但来源为内置/未上报" };
}

/**
 * 是否需要补歌词：只看文件里有没有。
 * 不再参考 DB 的 has_lyrics —— 云盘扫描出来的这一列经常是脏的（实测 has_lyrics=1、
 * 文件无词、同目录也没有 .lrc），信它会让歌词永远补不上。
 */
export function needLyricByFile(embeddedLyric: unknown): boolean {
  return !embeddedLyric || !String(embeddedLyric).trim();
}
