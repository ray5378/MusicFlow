/**
 * 对外进度(秒)的统一精度 = 0.1s。
 *
 * 背景(2026-11-26 D3):此前 API 出口一律 `Math.floor(ms/1000)`,只给整秒。
 * 而所有消费端(HA 卡片 / Web 前端 / Flutter 客户端)都按「服务端 position +
 * 本地按真实时间推进」做校准 —— 整秒值把不足 1s 的零头丢掉,每次校准就把
 * 本地时钟往回拽 ≤1s。按卡片的真实算法模拟复现:30s 内回退 3 次、每次恒
 * −1.00s(HA 歌词同步回退)。0.1s 精度把回退幅度压到 ≤0.1s(视觉不可见),
 * 同时与 sendspin 已有的小数口径统一(此前同一台泵三种精度)。
 *
 * ⚠️ 只用于**对外显示**:唱完/切歌/接续判定仍用内部毫秒真值,
 *    不要拿这个函数的结果去做业务判断。
 */
export function toDecisecond(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.round(ms / 100) / 10;
}
