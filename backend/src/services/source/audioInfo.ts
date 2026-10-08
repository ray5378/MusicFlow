// ==================== 源音频位深探测（batch49） ====================
//
// 「位深自动 = 跟随源位深」需要知道**源文件自己的位深**。为什么不能用别的办法：
//   - 不能靠设备宣告：DLNA 协议压根不报（连采样率都不报，更没有位深）；
//     sendspin 的 `client/hello` 里那个 `bit_depth` 是**设备编码给上位机**的位深，
//     跟「我们出流给它多少位」不是一回事。
//   - 不能靠 ffmpeg 自动跟随：出流链里有 `loudnorm`，它内部走浮点 ⇒ 不显式指定
//     `osf` 时编码器恒吃 f32、FLAC 恒落 24bit（230 实测，见 playerRate.ts 文件头）。
//   - 不能只看文件后缀：`.flac` 既有 16bit 也有 24bit，`.wav` 同理。
// 所以只能**读文件头**。用扫描器同一套 `music-metadata`（`parseBuffer` 的同族
// `parseFile`），并且只读头：`duration:false` 跳过时长估算、`skipCovers:true`
// 不解析内嵌封面（大封面是这类解析最贵的部分）。
//
// 成本与缓存：每首歌**每个进程只解析一次**（按 path + size + mtimeMs 判缓存命中，
// 覆盖「文件被替换」的情况）；命中后出流热路径上只剩一次 `statSync`。
// 任何一步失败（文件不在 / 解析不了 / 是有损格式拿不到位深 / 远端源没有本地文件）
// 一律回 null = 「不知道」⇒ 调用方不干预位深，落回缺省行为（24bit）。
// **本函数绝不抛** —— 它在出流热路径上，探不到位深最多是位深不优化，
// 绝不能让一首歌因此放不出来。
import { statSync } from "node:fs";
import { parseFile } from "music-metadata";
import { parseSongPath } from "../../utils/localSourceProbe.js";
import { classifySourceBits } from "../playerRate.js";

interface CacheEntry {
  size: number;
  mtimeMs: number;
  bits: number | null;
}

/** 上限（防无界增长）：超了直接清空重来 —— 重解析一次的代价远小于 LRU 记账复杂度。 */
const CACHE_MAX = 4096;
const cache = new Map<string, CacheEntry>();

/**
 * 探测本地源文件的位深，归到 16 / 24；拿不到 → null。
 *
 * @param song 歌曲行（至少要 `path` / `type`）。远端源（web/webdav）没有本地文件 → null。
 */
export async function probeSourceBits(
  song: { path?: string | null; type?: string | null } | null | undefined,
): Promise<number | null> {
  const p = song?.path;
  if (!p) return null;
  if ((song?.type || "local") !== "local") return null;
  const parsed = parseSongPath(p);
  if (!parsed || parsed.type !== "l") return null; // 'w' = WebDAV，不做网络探测
  const file = parsed.filePath;
  try {
    const st = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.bits;
    const meta = await parseFile(file, { duration: false, skipCovers: true });
    const bits = classifySourceBits(meta?.format?.bitsPerSample);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, bits });
    return bits;
  } catch {
    return null;
  }
}

/** 测试用：清空缓存（生产不调用）。 */
export function _clearSourceBitsCache(): void {
  cache.clear();
}
