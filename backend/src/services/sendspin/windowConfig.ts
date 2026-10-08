// ==================== Sendspin 解码窗口配置(纯函数,零依赖) ====================
//
// 窗口上限档位与归一化:独立成模块是为了让**两条使用方**(streamSource.ts 的 PcmWindow
// 音源层、index.ts 的插件配置装配层)都能引用而不引入循环依赖 —— 二者彼此不能互引。
//
// 2026-10-08:窗口上限由固定 300s 改为插件配置「解码窗口上限」可调(30s~10min,
// 缺省 30s 最省内存档)。
// 内存按 ~0.375MB/秒(48k 立体声 F32,见 streamSource BYTES_PER_SAMPLE)线性增长:
// 30s ≈ 11MB、300s ≈ 115MB、600s ≈ 225MB(**每个正在播放的组**一份)。

/** 合法档位(秒):插件配置 select 的选项顺序,也是归一化的吸附目标。 */
export const WINDOW_SECONDS_OPTIONS: readonly number[] =
  [30, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600];

/** 缺省窗口上限(秒):30s 最省内存档(≈11MB/组;用户拍板 2026-10-08,
 *  原缺省 300s 对齐 MA AudioBuffer BALANCED)。 */
export const WINDOW_DEFAULT_SEC = 30;

/** 归一化「解码窗口上限」:吸附到最近合法档位;非法/缺省 → 缺省档;超范围钳到两端。
 *  返回**秒**(整数)。下拉档位存的是字符串,故对 `Number(raw)` 生效。 */
export function normalizeWindowSeconds(raw: unknown): number {
  // null / undefined / 空串 → 缺省(注意 Number(null) === 0,不能只靠 NaN 判据)。
  if (raw === null || raw === undefined || raw === "") return WINDOW_DEFAULT_SEC;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return WINDOW_DEFAULT_SEC;
  let best = WINDOW_DEFAULT_SEC;
  let bestD = Math.abs(WINDOW_DEFAULT_SEC - n);
  for (const v of WINDOW_SECONDS_OPTIONS) {
    const d = Math.abs(v - n);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}
