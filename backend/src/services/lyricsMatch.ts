// ==================== 歌词匹配判据（纯函数） ====================
//
// 抽成独立模块是为了**共用**：既要给 lyrics 管线做入口闸门（①缓存/②sidecar/③在线），
// 也要给 provider 调度做「这条不合用 ⇒ 换下一个候选/下一个 provider」的过滤。
// 若把它留在 lyrics.ts 里，providers.ts 反向 import 会形成循环。
import { applyVariant } from "../utils/chineseConv.js";

/** 少于这么多非空行的「歌词」一律视为占位文本（纯音乐请欣赏 / 作者简介 / 版权声明）。 */
export const MIN_LYRIC_LINES = 5;

/**
 * 这份 LRC 到底是不是这首歌的？
 *
 * 为什么要它（2026-11-21 真机）：`狂信者 / 黄立行` 的歌词里存的是 `分开旅行`（同歌手
 * 另一首）的整篇 —— 历史误匹配落库后，「①落库缓存」永远优先，provider 再也不会被问到。
 * 更恶性的情况存在：provider 按 id 取回的 LRC 也可能是别的歌（服务端 id 串了），
 * 不校验就会把错词写进库里、永久错误。
 *
 * 判据只认**首部标题行**（大多数 LRC 有 `[00:00.00]艺人 - 歌名` 这种行）：
 *   - 找不到标题行（纯时间轴歌词）→ 放行（无从判断，宁放不误杀）；
 *   - 找到标题行但**任何一段**都对不上歌名 → 判为不属于这首歌；
 *   - 歌名对得上（含互含/繁简统一/去括号）→ 放行。
 * 另外补一条时长上界：末行时间戳比歌曲时长还长 30s 以上 → 显然不是同一首。
 */
export function lrcBelongsToSong(
  content: string,
  song: { title?: string | null; artist?: string | null; duration?: number | null },
): boolean {
  if (!content) return false;
  // 内容可用性(2026-11-22 真机):少于 MIN_LYRIC_LINES(5)行的「歌词」几乎都是占位文本 ——
  //   `[00:01.58]纯音乐，请欣赏`、`此歌曲为没有填词的纯音乐，请您欣赏`、作者简介/版权声明。
  // 真歌词即使没有时间轴也是多行，占位文本通常只有一行(实例:该死的温柔 缓存了一句
  //   「四川音乐学院毕业…未经许可,不得翻唱或使用」，界面整首歌只有这一句)。
  // 这类内容既不该当歌词显示，也不该写进文件标签。
  const contentLines = content
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]/g, "").trim())
    .filter((l) => l.length > 0);
  // 逐字/卡拉OK 歌词是**一行到底**（每个字前都带时间戳），剥掉时间戳后只剩 1 行 ——
  // 只按物理行数判会把它们整片误杀（实测 MELANCHOLY 这类）。所以「内容量」取
  // 「非空文本行数」与「时间戳个数」的较大者：真歌词至少一个维度 ≥MIN_LYRIC_LINES，
  // 占位文本（纯音乐请欣赏 / 作者简介）两个维度都是 1。
  const timeStampCount = (content.match(/\[[\d]{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g) || []).length;
  const contentUnits = Math.max(contentLines.length, timeStampCount);
  if (contentUnits < MIN_LYRIC_LINES) return false;
  const norm = (v: unknown) =>
    applyVariant(String(v ?? "").toLowerCase(), "simplified")
      .replace(/[\s\p{P}\p{S}]+/gu, "")
      .replace(/[（(【\[].*?[)）】\]]/g, "");
  const wantTitle = norm(song.title);
  const head = content.split(/\r?\n/).slice(0, 8);
  let headerLine: string | null = null;
  for (const raw of head) {
    const t = raw.replace(/^\[[^\]]*\]/g, "").trim();
    if (!t) continue;
    if (/^(作词|作曲|编曲|词|曲|混音|制作|录音|和声|吉他|贝斯|鼓|母带|演唱|原唱|出品|监制)/.test(t)) continue;
    if (/\[\d{1,2}:\d{1,2}/.test(t)) continue; // 逐字行
    if (/[-–—]/.test(t)) { headerLine = t; break; }
  }
  if (headerLine && wantTitle) {
    const parts = headerLine.split(/[-–—]/).map(norm).filter((x) => x.length >= 2);
    // 顺序无关:`歌名 - 艺人` 与 `艺人 - 歌名` 都认 —— 逐个分段比对即可。
    // 但**歌名本身带连字符**时(如「A-B」),分段会把歌名切碎 ⇒ 必须同时拿整行去比。
    const wholeLine = norm(headerLine);
    const titleHit =
      wholeLine.includes(wantTitle) ||
      wantTitle.includes(wholeLine) ||
      parts.some((p) => p.includes(wantTitle) || wantTitle.includes(p));
    if (!titleHit) {
      // 标题对不上时,再看**歌手**是否出现在同一行:出现了就是「同歌手的另一首歌」的标题行
      // (狂信者 → 刘若英、黄立行 - 分开旅行),必须否决。
      // 歌手也对不上 ⇒ 这行本来就只是歌词正文(正文常带连字符,如 a-only),放行避免误杀。
      const wantArtist = norm(song.artist);
      const artistHit =
        wantArtist.length >= 2 &&
        parts.some((p) => p.includes(wantArtist) || wantArtist.includes(p));
      if (artistHit) return false;
    }
  }
  // 时长上界:末行时间戳远超歌曲时长 ⇒ 是另一首(更长的)歌。
  const d = Number(song.duration) || 0;
  if (d > 0) {
    const times = [...content.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
      .map((m) => Number(m[1]) * 60 + Number(m[2]));
    const maxTs = times.length > 0 ? Math.max(...times) : 0;
    if (maxTs > d + 30) return false;
  }
  return true;
}
