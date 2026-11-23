import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlayerHost } from "../../src/services/playerHost/host.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "fakeChild.cjs");

const hosts: PlayerHost[] = [];
function mk(id: string, env: Record<string, string> = {}) {
  const h = new PlayerHost({ deviceId: id, entry: FIXTURE, env, heartbeatMs: 200, deadAfterMs: 700, maxBackoffMs: 300 });
  hosts.push(h);
  return h;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PlayerHost — 每播放器一进程隔离", () => {
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((h) => h.stop()));
  });

  it("两台各自就绪并独立上报状态", async () => {
    const a = mk("dev-a");
    const b = mk("dev-b");
    await a.start();
    await b.start();
    const seen = new Map<string, number>();
    a.onStatus((s) => seen.set("a", s.framesOut));
    b.onStatus((s) => seen.set("b", s.framesOut));
    await sleep(600);
    expect(a.isReady()).toBe(true);
    expect(b.isReady()).toBe(true);
    expect(seen.get("a")).toBeGreaterThan(0);
    expect(seen.get("b")).toBeGreaterThan(0);
  });

  it("一台卡死不影响另一台，且卡死那台会被重启", async () => {
    const a = mk("dev-hang", { MF_FIXTURE_HANG_AFTER_MS: "300" });
    const b = mk("dev-ok");
    await a.start();
    await b.start();

    let bTicks = 0;
    b.onStatus(() => (bTicks += 1));
    await sleep(1_200); // 覆盖 A 判死 + 杀 + 重启窗口
    const bAfter = bTicks;
    await sleep(600);

    // B 不受影响：判死窗口内仍在持续上报
    expect(bTicks).toBeGreaterThan(bAfter);
    // A 已被父进程判死重启（重启后同样会再次 ready）
    expect(a.isReady()).toBe(true);
  });

  it("stop 后子进程退出、不再上报", async () => {
    const a = mk("dev-stop");
    await a.start();
    let n = 0;
    a.onStatus(() => (n += 1));
    await sleep(400);
    await a.stop();
    // stop 期间可能有在途消息，先取基线再观察是否还在增长
    const atStop = n;
    await sleep(600);
    expect(n - atStop).toBeLessThanOrEqual(1); // 至多一条在途 status
    expect(a.isReady()).toBe(false);
  });
});
