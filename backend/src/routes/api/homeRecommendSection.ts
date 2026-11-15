// ==================== 首页「为你推荐」纯计算(GET /v1/home/recommend-section) ====================
//
// 背景:此前「最终展示哪 12 张卡片」由 Web / Flutter(音流)/ HA 卡片三端**各自本地组装**:
// 固定卡取 /v1/recommend/home-cards,随机补位从 /v1/home/playlist-pool 自己洗牌。三端
// 洗牌口径互不相同(有的 Math.random、有的按下标取模),同一用户同一时刻打开三个客户端会
// 看到三套不同的卡片;而且客户端若只拿到「最新 200 个歌单」,还得再翻 4 页才能凑齐随机池。
//
// 现在收敛为服务端单一真源。首页拆成两个端点、各管一件事(稳定性策略本来就不同):
//   1) 本模块 buildRecommendSection() → GET /v1/home/recommend-section
//      固定卡(零门槛)+ 随机补位(**快照冻结随机位**,见下)。有随机位,所以必须冻结。
//   2) homeRecentPlaylists.ts selectRecentPlaylists() → GET /v1/home/recent-playlists
//      按 updated_at 倒序的「最近更新」。**无随机位** → 纯查询、天然确定、保持新鲜,
//      刻意不做快照(冻结反而会让「最近更新」失真)。
//
// 本模块只做**纯计算**:入参是已经取好的固定卡候选与歌单池,不读库、不写库、不存快照、
// 不写缓存、不用 Math.random()。读库/权限/可见性/快照读写都在 homePreload.ts 的路由层。
//
// ==================== 「同一小时内结果确定」的精确语义 ====================
// 靠**持久化快照**实现,且快照**只冻结随机位**(randomIds):
//   - 固定卡由插件配置决定(按 position 排),本身没有随机性 —— 数据不变则结果必然相同,
//     不冻结就是「确定且新鲜」的;
//   - 只有随机补位需要冻结,否则一小时内的重复请求会跳("固定的不会轮换,随机的才参与轮换")。
// 因此:同一 hourBucket 内 random 逐项恒定(快照命中);但快照里的 id 若已不可见/已变成
// 固定卡,校验会失败并重算(绝不返回死链)。快照落库/读取在 homePreload.ts。

import md5 from "md5";

/** 随机补位门槛:曲目数 **大于等于** 该值(挡掉刚建的空/小歌单)。 */
export const RANDOM_CARD_MIN_SONG_COUNT = 30;

/** buildRecommendSection 的固定卡候选(内部形态:多带 pluginId 供位次并列时做字典序裁决)。 */
export interface FixedCardCandidate {
  /** 声明该卡的插件 id(`listHomeCardPlugins()[].pluginId`)。 */
  pluginId: string;
  /** 固定歌单 id(客户端长期引用,如 pl-daily-today)。 */
  playlistId: string;
  /** 卡名(插件 manifest.homePlaylistId(s) 里声明的展示名)。 */
  name: string;
  /** 歌单在库里的真实名字(playlists.name),缺行时为 ""。 */
  playlistName: string;
  /** 首页位次(1 起;0 = 未固定,排序时算最后)。 */
  position: number;
  /** 歌单曲目数(playlists.song_count),缺行时为 0。 */
  songCount: number;
  /** 标准逻辑封面 ref `pl-<playlistId>`;歌单行不存在时为 null。 */
  coverArt: string | null;
  /** 是否为组合歌单(能力含 comboPlaylist)。 */
  isCombo: boolean;
  /** true = playlists 表里查不到这一行(插件还没生成/歌单被删/id 配错)。 */
  missing: boolean;
}

/** 歌单池最小投影(buildPlaylistPool 的 items 元素,已做可见性过滤)。 */
export interface RecommendPoolItem {
  id: string;
  name: string;
  songCount: number;
  /** 歌单最后更新时间(ISO 8601 UTC 字符串,直接比字符串即时间序)。 */
  changed: string;
}

/** 响应里的固定卡(不含 pluginId —— 客户端不需要,也不想让它参与展示逻辑)。 */
export interface RecommendSectionFixedCard {
  playlistId: string;
  name: string;
  playlistName: string;
  position: number;
  songCount: number;
  coverArt: string | null;
  isCombo: boolean;
  /** 仅在该卡指向的歌单行不存在时出现(= true);正常卡不带这个键。 */
  missing?: true;
}

/** 卡片最小投影(随机补位卡 / 最近更新卡共用)。coverArt 由服务端算好。 */
export interface RecommendCard {
  id: string;
  name: string;
  songCount: number;
  coverArt: string;
}

/** buildRecommendSection 的结果(= GET /v1/home/recommend-section 的响应体 + 两个内部字段)。 */
export interface RecommendSection {
  success: true;
  /** Math.floor(Date.now() / 3600000),客户端可用于判断「本响应是否还处于同一小时」。 */
  hourBucket: number;
  /** 首页「为你推荐」展示张数(dailyRecommendHomeCount(),生产 12)。 */
  homeCount: number;
  /** true = 有固定卡指向**不存在的歌单**(固定卡失效,前端应提示而不是静默空着)。 */
  degraded: boolean;
  fixed: RecommendSectionFixedCard[];
  random: RecommendCard[];
  /** 本次生效的随机位 id(路由层据此落快照)。**不对外返回**。 */
  randomIds: string[];
  /** true = 本次用了传入的 frozenRandomIds(快照命中)。**不对外返回**。 */
  frozen: boolean;
}

/** buildRecommendSection 入参。 */
export interface RecommendSectionInput {
  /** showOnHome 的固定卡候选(已补 playlist 行,不做任何门槛过滤)。 */
  fixedCandidates: FixedCardCandidate[];
  /** 可见性过滤后的全量歌单池最小投影。 */
  pool: RecommendPoolItem[];
  /** 展示张数(dailyRecommendHomeCount())。 */
  homeCount: number;
  /** 由 buildSectionSeed() 生成的 seed(**必须**含 user.id 与 hourBucket)。 */
  seed: string;
  /** Math.floor(now / 3600000),原样回显。 */
  hourBucket: number;
  /** 路由层从 settings 快照读出的随机位。只有「全部 id 仍在池子里、都不是固定卡、
   *  且条数恰好等于当前应补张数」才生效,否则视为失效(歌单被删/变固定卡/配置变了)
   *  并重算 —— 绝不返回死链,也绝不因旧快照补不满张数。 */
  frozenRandomIds?: string[];
}

/** 整点小时桶:同一小时内恒定,跨整点整体+1。 */
export function hourBucketOf(now: number): number {
  return Math.floor(now / 3600000);
}

/** 洗牌 seed。user.id 缺省时用空串(未登录/无用户上下文)——此时所有匿名用户同批,
 *  这是可接受的(没有 user 就没有「谁」可区分),但**必须**保持拼接顺序稳定。 */
export function buildSectionSeed(userId: string | undefined, hourBucket: number): string {
  return `${userId ?? ""}|${hourBucket}`;
}

/** 稳定权重:`md5(seed|playlistId)` 前 8 个十六进制位 → [0, 2^32) 的整数。
 *  纯函数,不依赖调用顺序、不依赖 Math.random;同一 (seed, playlistId) 永远同一个值。 */
export function stableKey(seed: string, playlistId: string): number {
  const head = md5(`${seed}|${playlistId}`).slice(0, 8);
  const key = parseInt(head, 16);
  // 理论上 md5 输出恒为十六进制;NaN 兜底成 0,保证「有 key 可比」而不是让 sort 乱序。
  return Number.isFinite(key) ? key : 0;
}

/** 固定卡排序:位次升序;位次相同(或都是 0=未固定)按 pluginId 字典序。
 *  与 GET /v1/recommend/home-cards 的排序**逐字一致**(同一份卡片三端顺序才对得上)。 */
function compareFixedCards(a: FixedCardCandidate, b: FixedCardCandidate): number {
  const pa = a.position || Number.MAX_SAFE_INTEGER;
  const pb = b.position || Number.MAX_SAFE_INTEGER;
  return pa - pb || a.pluginId.localeCompare(b.pluginId);
}

/** 一张歌单 → 卡片(id/name/songCount/coverArt)。 */
function toCard(p: RecommendPoolItem): RecommendCard {
  return { id: p.id, name: p.name, songCount: p.songCount, coverArt: `pl-${p.id}` };
}

/**
 * 组装「为你推荐」section(纯计算)。
 *
 * 步骤:
 *   1. 固定卡:**零门槛**(showOnHome 全返回),按 (position, pluginId) 排序;缺行的卡标 missing;
 *   2. degraded:任一固定卡 missing(指向不存在的歌单);
 *   3. 随机池:歌单池去掉固定卡占用的 id、只留 songCount >= 30;
 *   4. 有可用快照(frozenRandomIds 全部仍在池子里、都不是固定卡、且条数恰好等于
 *      max(0, homeCount - fixed.length))→ 直接用它(frozen=true);
 *      否则按 stableKey(seed, id) 升序洗牌取前 max(0, homeCount - fixed.length) 条(frozen=false);
 *   5. 回传 randomIds 供路由层落快照。
 *
 * @param input 固定卡候选 / 歌单池 / 展示张数 / seed / hourBucket / 可选快照
 * @return 响应体 + randomIds + frozen
 */
export function buildRecommendSection(input: RecommendSectionInput): RecommendSection {
  const candidates: FixedCardCandidate[] = Array.isArray(input.fixedCandidates) ? input.fixedCandidates : [];

  // 1) 固定卡:零门槛(用户定调:固定卡就该一直显示),只做位次排序。拷贝一份,不改调用方数组。
  const fixed = [...candidates].sort(compareFixedCards);

  // 2) 展示张数:非法值一律按 0 处理,避免 NaN 传进 slice。
  const homeCount = Number.isFinite(input.homeCount) ? Math.max(0, Math.trunc(input.homeCount)) : 0;

  // 3) 固定卡失效:有 showOnHome 的卡,且其中至少一张指向的歌单已不存在。
  //    (没有门槛后,「fixed 为空」只可能是 showOnHome 全 false —— 那不是降级。)
  const degraded = candidates.length > 0 && fixed.some((c) => c.missing === true);

  // 4) 随机位:快照优先,失效则重算。
  const fixedIds = new Set(fixed.map((c) => c.playlistId));
  const poolItems: RecommendPoolItem[] = Array.isArray(input.pool) ? input.pool : [];
  const poolById = new Map(poolItems.map((p) => [p.id, p]));

  // 应补张数:按**当前** fixed 张数算。插件配置在同小时内变了(某张卡 showOnHome 开关、
  // homePosition 调整导致 fixed 张数变化)时 want 会跟着变 —— 下面的条数校验会让快照
  // 自动失效并重算,保证「该补几张就补几张」。
  const want = Math.max(0, homeCount - fixed.length);

  const frozenIds = Array.isArray(input.frozenRandomIds) ? input.frozenRandomIds : null;
  // 快照采纳必须**同时**满足三条:
  //   1. 每个 id 仍在当前池子里(歌单没被删、没转私密);
  //   2. 每个 id 都不是当前的固定卡(固定卡不占随机位);
  //   3. 条数恰好等于当前应补张数 want。
  // 第 3 条是彻底修法:只校验 id 合法性的话,「fixed 变少 → want 变大」时旧快照会被
  // 直接采纳,导致该补的张数补不满(这正是「先冻结再 slice」解决不了的方向)。
  // 顺带覆盖空池:want > 0 而池子算不出候选时 randomIds = [],条数不匹配 → 每请求重算
  // (空池只出现在新装/无歌单的极端场景,多一次 UPSERT 无所谓);want === 0 时 []
  // 是正确结果,会被正常复用,不需要特判。
  const canFreeze =
    !!frozenIds &&
    frozenIds.length === want &&
    frozenIds.every((id) => poolById.has(id) && !fixedIds.has(id));

  let randomIds: string[];
  let frozen = false;
  if (canFreeze) {
    frozen = true;
    randomIds = frozenIds!.map(String);
  } else {
    randomIds = poolItems
      .filter((p) => !fixedIds.has(p.id) && p.songCount >= RANDOM_CARD_MIN_SONG_COUNT)
      .sort(
        (a, b) =>
          stableKey(input.seed, a.id) - stableKey(input.seed, b.id) || a.id.localeCompare(b.id),
      )
      .slice(0, want)
      .map((p) => p.id);
  }
  // 卡片内容永远取当前池子里的最新投影(名字/曲目数可能已变,id 才是身份)。
  const random: RecommendCard[] = randomIds.map((id) => toCard(poolById.get(id)!));

  return {
    success: true,
    hourBucket: input.hourBucket,
    homeCount,
    degraded,
    fixed: fixed.map((c) => {
      const card: RecommendSectionFixedCard = {
        playlistId: c.playlistId,
        name: c.name,
        playlistName: c.playlistName,
        position: c.position,
        songCount: c.songCount,
        coverArt: c.coverArt,
        isCombo: c.isCombo,
      };
      // 只在缺行时带 missing,健康卡的响应形状/体积与旧版一致。
      return c.missing ? { ...card, missing: true } : card;
    }),
    random,
    randomIds,
    frozen,
  };
}
