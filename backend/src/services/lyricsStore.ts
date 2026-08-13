// 歌词文件存储:落库歌词与封面同构,不存数据库文本列。
//   - 插件获取并落库的歌词存 data/online-lyrics/<songId>.lrc
//   - songs.lyrics 列存"文件引用"(如 <songId>.lrc),读取时探测文件,
//     文件缺失(如缓存被清)时回退到列内旧文本(兼容 v1.7.4 已落库的文本数据)。
// 独立目录可单独挂卷/清空,与 online-covers 一致;清空后缺歌词会重新按需获取。
import fs from "fs";
import path from "path";
import { getDataDir } from "../utils/env.js";

const LYRICS_DIR = path.join(getDataDir(), "online-lyrics");

function ensureDir() {
  if (!fs.existsSync(LYRICS_DIR)) fs.mkdirSync(LYRICS_DIR, { recursive: true });
}

/** 落库歌词:写入 <songId>.lrc 并返回文件引用,失败返回 null。 */
export function saveLyricFile(songId: string, content: string): string | null {
  if (!songId || !content) return null;
  try {
    ensureDir();
    const ref = `${songId}.lrc`;
    fs.writeFileSync(path.join(LYRICS_DIR, ref), content, "utf8");
    return ref;
  } catch {
    return null;
  }
}

/** 按引用读取歌词文件内容,文件不存在返回 null。 */
export function readLyricFile(ref: string): string | null {
  if (!ref) return null;
  try {
    const fp = path.join(LYRICS_DIR, ref);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
}

/**
 * 读取 songs.lyrics 列:值可能是新格式文件引用(<id>.lrc)或 v1.7.4 旧文本。
 * 优先按文件引用读 online-lyrics/<value>;文件缺失时把原值当文本返回。
 */
export function resolveLyricContent(raw: string | null): string | null {
  if (!raw) return null;
  const fromFile = readLyricFile(raw);
  if (fromFile !== null) return fromFile;
  return raw;
}

/** 删除某首歌的歌词文件(配合删歌/清理)。返回删除的文件数。 */
export function deleteSongLyric(songId: string): number {
  if (!songId) return 0;
  let removed = 0;
  try {
    const fp = path.join(LYRICS_DIR, `${songId}.lrc`);
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); removed++; }
  } catch { /* ignore */ }
  return removed;
}
