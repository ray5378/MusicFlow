// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// `routes/api/online.ts` 的**任务 TTL 清扫**补测(49-51 / 53-55 / 57-59)。
//
// 为什么必须玩假时钟:**清扫定时器是模块加载时用 setInterval 建起来的(5 分钟一轮)**,
// 要让它被接管,必须在 import online.js **之前**装好 vi.useFakeTimers()。
//
// 产品契约(内存红线):
//   ① 完成的任务要保留 30 分钟 —— 前端靠轮询取结果,清太早会看到"任务不见了";
//   ② 保留期满必须清掉 —— 三个进程内 Map 不清就会随任务次数**无界增长**(内存泄漏);
//   ③ **running 中的任务永不被清** —— 清掉会放行重复的并发任务。
//
// 三个 Map(matchJobs / batchMatchJobs / syncAllState)都是模块私有,只能经路由灌数据。
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";

type Any = any;

const leaf = vi.hoisted(() => ({
  getConfiguredProvider: vi.fn(),
  runBatchJob: vi.fn(async () => ({ result: {} })),
  runPluginJob: vi.fn(() => ({ started: true, alreadyRunning: false })),
  getEnabledByCapability: vi.fn(() => [] as Any[]),
}));

vi.mock("../../src/middleware/auth.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  // 放行鉴权/权限,让用例专注"定时器是否按 TTL 清理"这一件事
  permMiddleware: () => async (_c: Any, next: Any) => { await next(); },
  adminMiddleware: async (_c: Any, next: Any) => { await next(); },
}));

vi.mock("../../src/services/source/online/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getConfiguredProvider: leaf.getConfiguredProvider,
}));

vi.mock("../../src/batch/runner.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  runBatchJob: leaf.runBatchJob,
}));

vi.mock("../../src/services/plugin/jobRunner.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  runPluginJob: leaf.runPluginJob,
}));

vi.mock("../../src/plugins/registry.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getEnabledByCapability: leaf.getEnabledByCapability,
}));

// 关键顺序:装假时钟 → 再动态加载 online.js(其顶层 setInterval 才会被接管)
vi.useFakeTimers();
const { onlineRoutes } = await import("../../src/routes/api/online.js");
const { db, initDatabase } = await import("../../src/db/index.js");
const { users, playlists, playlistSongs } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const app = new Hono();
app.route("/", onlineRoutes);

const PROVIDER = "gmd";

async function post(path: string, body?: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Any };
}
async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  return { status: res.status, body: (await res.json()) as Any };
}

/** 推进假时钟并冲刷微任务(后台任务是 fire-and-forget,靠它落地状态)。 */
async function tick(ms = 1) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeAll(async () => {
  initDatabase();
  db.insert(users).values({ id: "u1", username: "u1", password: "", salt: "s", subsonicSalt: "ss", passEnc: "", isAdmin: 1, isActive: 1 }).run();
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  leaf.getConfiguredProvider.mockReset();
  leaf.getConfiguredProvider.mockReturnValue({ provider: { name: "fake" }, config: {} });
  leaf.runBatchJob.mockReset();
  leaf.runBatchJob.mockImplementation(async () => ({ result: {} }));
  leaf.runPluginJob.mockReset();
  leaf.runPluginJob.mockImplementation(() => ({ started: true, alreadyRunning: false }));
  leaf.getEnabledByCapability.mockReset();
  leaf.getEnabledByCapability.mockImplementation(() => []);
  db.delete(playlistSongs).run();
  db.delete(playlists).run();
});

/** 建一个含 n 条"未匹配(外部占位)"条目的歌单,返回 playlistId。 */
function seedUnmatched(id: string, n: number): string {
  db.insert(playlists).values({ id, name: id, ownerId: "u1" }).run();
  for (let i = 0; i < n; i++) {
    db.insert(playlistSongs).values({ playlistId: id, position: i, playable: 0, externalTitle: `T${i}`, externalArtist: "A" }).run();
  }
  return id;
}

/** 轮询单歌单匹配任务直到非 running。 */
async function waitMatchJob(jobId: string) {
  for (let i = 0; i < 50; i++) {
    const s = await get(`/v1/online/${PROVIDER}/match-playlist/status?jobId=${jobId}`);
    if (s.body.status !== "running") return s.body;
    await tick();
  }
  throw new Error("match job did not settle");
}

describe("matchJobs TTL 清扫", () => {
  it("完成的任务 30 分钟内可查,期满被清(可查变 404);running 的不被清", async () => {
    // 大歌单(>30 条)→ 后台任务;第一条 runBatchJob 挂起(模拟长任务),第二条立即完成
    const pendingId = seedUnmatched("pl-pending", 31);
    const doneId = seedUnmatched("pl-done", 31);

    let call = 0;
    leaf.runBatchJob.mockImplementation(async () => {
      call++;
      if (call === 1) return new Promise(() => {}) as Any; // 永不落地 → 一直是 running
      return { result: {} };
    });

    const pendingRes = await post(`/v1/online/${PROVIDER}/match-playlist`, { playlistId: pendingId });
    const pendingJob = pendingRes.body.jobId as string;
    const doneRes = await post(`/v1/online/${PROVIDER}/match-playlist`, { playlistId: doneId });
    const doneJob = doneRes.body.jobId as string;

    await tick();
    const doneBody = await waitMatchJob(doneJob);
    expect(doneBody.status).toBe("completed");

    // 保留期内(TTL 是 30 分钟):完成任务的记录还在 —— 前端还能轮询到结果
    await tick(5 * 60 * 1000);
    expect((await get(`/v1/online/${PROVIDER}/match-playlist/status?jobId=${doneJob}`)).status).toBe(200);

    // 推进 36 分钟(>30 分钟 TTL)→ 完成的任务被清,running 的仍在。
    // 为什么是 36 而不是 31:清扫是 5 分钟一格的固定相位,任务落地时刻不与网格对齐时,
    // 推进 31 分钟可能只走到"距落地 29 分钟"的那一格 —— 36 分钟保证必然跨过 ≥30 分钟那一格。
    await tick(36 * 60 * 1000);
    expect((await get(`/v1/online/${PROVIDER}/match-playlist/status?jobId=${doneJob}`)).status).toBe(404);
    const still = await get(`/v1/online/${PROVIDER}/match-playlist/status?jobId=${pendingJob}`);
    expect(still.status).toBe(200);
    expect(still.body.status).toBe("running");
  });
});

describe("batchMatchJobs TTL 清扫", () => {
  it("完成后的批量适配任务期满被清(状态转 404)", async () => {
    seedUnmatched("pl-batch", 31);
    leaf.getEnabledByCapability.mockReturnValue([]);
    const r = await post(`/v1/online/${PROVIDER}/match-playlists`);
    const batchId = r.body.batchId as string;
    await tick();

    let st = await get(`/v1/online/${PROVIDER}/match-playlists/status?batchId=${batchId}`);
    for (let i = 0; i < 50 && st.body.status === "running"; i++) { await tick(); st = await get(`/v1/online/${PROVIDER}/match-playlists/status?batchId=${batchId}`); }
    expect(st.body.status).toBe("completed");

    // 36 分钟(见上:必须跨过清扫的 5 分钟相位网格)后记录被清
    await tick(36 * 60 * 1000);
    expect((await get(`/v1/online/${PROVIDER}/match-playlists/status?batchId=${batchId}`)).status).toBe(404);
  });
});

describe("syncAllState TTL 清扫", () => {
  it("路径 A 同步任务期满被清(状态转 404)", async () => {
    const r = await post(`/v1/online/${PROVIDER}/recommend/sync-all`);
    expect(r.status).toBe(200);
    expect(r.body.started).toBe(true);
    await tick();

    let st = await get(`/v1/online/${PROVIDER}/recommend/sync-all/status`);
    for (let i = 0; i < 50 && st.body.running === true; i++) { await tick(); st = await get(`/v1/online/${PROVIDER}/recommend/sync-all/status`); }
    expect(st.body.running).toBe(false);

    // 36 分钟(见上:必须跨过清扫的 5 分钟相位网格)后记录被清
    await tick(36 * 60 * 1000);
    expect((await get(`/v1/online/${PROVIDER}/recommend/sync-all/status`)).status).toBe(404);
  });
});
