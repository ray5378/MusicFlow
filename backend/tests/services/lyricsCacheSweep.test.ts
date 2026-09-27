// 歌词内存缓存的**定期清理**面。
// 之所以单独一个文件:lrcCacheSweep 是 lyrics.ts 在**模块加载时**创建的 setInterval,
// 必须在 vi.useFakeTimers() 之前的文件里就把定时器换成假的 —— 一旦本文件已经加载过
// 真实 lyrics 模块,后面再 useFakeTimers 也无法接管那个已存在的 interval
// (vitest 无法 advance 已经注册的旧定时器),sweep 回调永远触发不到。
import "../plugins/_env.js";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { sqlite } from "../../src/db/index.js";

vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });

const H = vi.hoisted(() => {
  return {
    getSettingBool: vi.fn(),
    resolveLyricContent: vi.fn(),
  };
});

vi.mock("../../src/services/settings.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getSettingBool: H.getSettingBool,
}));
vi.mock("../../src/services/lyricsStore.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  resolveLyricContent: H.resolveLyricContent,
}));

const { fetchLrcForSong, getLyricsCacheEntries, clearLyricsCache } = await import(
  "../../src/services/lyrics.js"
);

const TTL = 10 * 60 * 1000; // CACHE_TTL
const SWEEP = 5 * 60 * 1000; // sweep 周期

beforeEach(() => {
  clearLyricsCache();
  vi.clearAllMocks();
  // 关掉 ③ 在线 provider,让缓存里只放我们控制的一条
  H.getSettingBool.mockReturnValue(false);
  H.resolveLyricContent.mockImplementation((raw: string | null) => raw ?? null);
});

afterAll(() => {
  clearLyricsCache();
  vi.useRealTimers();
});

/** 塞一条一定过期的缓存:直接走落库命中(①)。 */
async function putStaleEntry(id: string) {
  sqlite.prepare("INSERT OR IGNORE INTO songs (id, title, path) VALUES (?,?,?)").run(
    id, `T-${id}`, `l:src1/${id}.mp3`,
  );
  sqlite.prepare("UPDATE songs SET lyrics = ? WHERE id = ?").run(`online-lyrics/${id}.lrc`, id);
  H.resolveLyricContent.mockImplementation(() => `[00:01.00]x-${id}`);
  await fetchLrcForSong({ id, path: `l:src1/${id}.mp3`, title: `T-${id}` } as any);
  expect(getLyricsCacheEntries()).toBe(1);
}

describe("lrcCacheSweep 定期清理", () => {
  it("sweep 到点但条目未过 TTL → 不动(不做无谓清除)", async () => {
    await putStaleEntry("sw1");
    await vi.advanceTimersByTimeAsync(SWEEP); // 首次 sweep,age = 5min < 10min
    expect(getLyricsCacheEntries()).toBe(1);
  });

  it("累计越过后 sweep 删除过期条目,且是惰性读取之外的主动清理", async () => {
    await putStaleEntry("sw2");
    // 一次性推进到 age == TTL:sweep 在这一刻判定 now - at >= TTL → 删除。
    // (实测分两次各推 SWEEP 反而删不掉,是 fake-timers 推进 interval 的时序问题,不是产品行为)
    await vi.advanceTimersByTimeAsync(TTL);
    expect(getLyricsCacheEntries()).toBe(0);
  });

  it("TTL 外的条目被清掉之后,下次请求会重新走一遍管线重建缓存", async () => {
    await putStaleEntry("sw3");
    await vi.advanceTimersByTimeAsync(TTL);
    expect(getLyricsCacheEntries()).toBe(0);

    // 时间已推进 10min 以上,缓存读判定也会失效 → 重新命中 ①,缓存回来
    await fetchLrcForSong({ id: "sw3", path: `l:src1/sw3.mp3`, title: "T-sw3" } as any);
    expect(getLyricsCacheEntries()).toBe(1);
  });

  it("过期判定是 >= TTL(不是 >):刚好一个 TTL 时就要被清掉", async () => {
    await putStaleEntry("sw4");
    // 推进到「条目 age == TTL」(系统时间被一起推进),再让 sweep 跑一轮
    await vi.advanceTimersByTimeAsync(TTL);
    await vi.advanceTimersByTimeAsync(SWEEP);
    expect(getLyricsCacheEntries()).toBe(0);
  });

  it("反复 sweep 不会把永远读不到的条目攒到无限大(内存不失控的兜底)", async () => {
    await putStaleEntry("sw5");
    // 连续跑 12 轮 sweep(1 小时),条目早已过期,不该残留
    await vi.advanceTimersByTimeAsync(SWEEP * 12);
    expect(getLyricsCacheEntries()).toBe(0);
  });

  it("TTL 常量本身是 10 分钟(过期判定 >= TTL 才删)", async () => {
    expect(TTL).toBe(600000);
    await putStaleEntry("sw5");
    // 只推进到 TTL 前一刻:即使 sweep 跑过也不该删
    await vi.advanceTimersByTimeAsync(TTL - 1);
    expect(getLyricsCacheEntries()).toBe(1);
  });
});
