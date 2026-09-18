// AirPlay「扫描」按钮的后端语义:rescanAirPlayDevices 立刻重发一次 mDNS(_raop._tcp) 查询。
// 这里只守「安全网」这一条 —— discovery 未运行(插件关闭 / mDNS 不可用)时必须是
// 立即 resolve 的 no-op:路由随后回当前列表即可,前端不会一直挂在 loading 上。
import { describe, it, expect } from "vitest";
import { rescanAirPlayDevices } from "../../src/services/airplay/discovery.js";

describe("AirPlay 手动重扫", () => {
  it("discovery 未运行时立即 resolve(no-op),不抛错", async () => {
    const t0 = Date.now();
    await expect(rescanAirPlayDevices(10)).resolves.toBeUndefined();
    // 未运行 ⇒ 早返回;万一真的在跑,窗口也只有 10ms。两者都远小于 200ms。
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
