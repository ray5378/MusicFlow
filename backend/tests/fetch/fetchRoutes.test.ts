// MusicFetch 路由单测（/v1/fetch/*）——用 app.request 直接打 Hono app（范式照
// tests/routes/apiLibrarySources.test.ts）。批量子进程运行器整体替换成桩，避免真 fork。
//
// MUST be the first import: 与既有路由测试一致，先加载 env 助手（DATA_DIR 隔离已由
// tests/setup.ts 统一分配）。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, settings } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import {
  _resetFetchJobsForTest,
  createFetchJob,
  getFetchJob,
  saveFetchJobItems,
} from "../../src/services/fetch/jobStore.js";

const { runBatchJobMock } = vi.hoisted(() => ({
  runBatchJobMock: vi.fn(async () => ({ result: { hasMore: false }, aborted: false, childRss: 0 })),
}));

vi.mock("../../src/batch/runner.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runBatchJob: runBatchJobMock };
});

import { registerFetch } from "../../src/routes/api/fetch.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerFetch(api);
app.route("/rest/api", api);

const PLAIN = "hunter2";
const SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;
async function call(method: string, path: string, body?: any) {
  const res = await app.request(`/rest/api${path}${path.includes("?") ? "&" : "?"}${authQS()}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users)
    .values({
      id: "u1",
      username: "alice",
      password: "",
      salt: "s",
      subsonicSalt: SALT,
      passEnc: encryptPassword(PLAIN),
      isAdmin: 1,
      isActive: 1,
    })
    .run();
});

beforeEach(() => {
  // 用例顺序不保证，清掉已存配置覆盖项 + 失效 settings 内存缓存 + 清空 fetch_jobs。
  db.delete(settings).where(eq(settings.key, "fetch.config")).run();
  _resetSettingsCacheForTest();
  _resetFetchJobsForTest();
  runBatchJobMock.mockClear();
});

/**
 * 造一个含 3 个 items 的任务：done / failed / queued（三者都带对应 target）。
 * 返回 jobId 与三条 targetId，供 retry 选择语义的用例断言。
 */
function seedJob(): { jobId: string; done: string; failed: string; queued: string } {
  const done = "t-done";
  const failed = "t-failed";
  const queued = "t-queued";
  const job = createFetchJob({
    kind: "manual",
    targets: {
      targets: [
        { id: done, title: "A" },
        { id: failed, title: "B" },
        { id: queued, title: "C" },
      ],
    },
    config: {},
  });
  saveFetchJobItems(job.id, [
    { id: done, targetId: done, status: "done", attempts: 1 },
    { id: failed, targetId: failed, status: "failed", attempts: 1, errorCode: "TIMEOUT" },
    { id: queued, targetId: queued, status: "queued", attempts: 0 },
  ]);
  return { jobId: job.id, done, failed, queued };
}

describe("fetch 域：配置 / 音源 / 任务", () => {
  it("GET /v1/fetch/config 返回默认合并结果", async () => {
    const r = await call("GET", "/v1/fetch/config");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.config.downloadRoot).toBe("/MUSIC/DOWNLOAD");
    expect(r.body.config.cacheRoot).toBe("/MUSIC/DOWNLOADCACHE");
    expect(r.body.config.chunkSize).toBe(20);
  });

  it("PUT /v1/fetch/config：cacheRoot 落在 downloadRoot 之内 → 400 且 errors 非空，不落库", async () => {
    const r = await call("PUT", "/v1/fetch/config", {
      downloadRoot: "/MUSIC/DOWNLOAD",
      cacheRoot: "/MUSIC/DOWNLOAD/cache",
    });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect(Array.isArray(r.body.errors)).toBe(true);
    expect(r.body.errors.length).toBeGreaterThan(0);

    // 未落库：GET 仍是默认值。
    const after = await call("GET", "/v1/fetch/config");
    expect(after.body.config.downloadRoot).toBe("/MUSIC/DOWNLOAD");
  });

  it("GET /v1/fetch/sources 返回数组", async () => {
    const r = await call("GET", "/v1/fetch/sources");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(Array.isArray(r.body.sources)).toBe(true);
  });

  it("GET /v1/fetch/jobs 空列表", async () => {
    const r = await call("GET", "/v1/fetch/jobs");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.jobs).toEqual([]);
  });

  it("GET /v1/fetch/jobs/<不存在> → 404", async () => {
    const r = await call("GET", "/v1/fetch/jobs/does-not-exist");
    expect(r.status).toBe(404);
    expect(r.body.success).toBe(false);
  });

  it("POST /jobs/:id/retry with targetIds：只重试显式指定且未完成的条目", async () => {
    const { jobId, queued } = seedJob();
    const r = await call("POST", `/v1/fetch/jobs/${jobId}/retry`, { targetIds: [queued] });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.jobId).toBeTruthy();

    const newJob = getFetchJob(r.body.jobId)!;
    expect(newJob.targets.targets.length).toBe(1);
    expect(newJob.targets.targets[0].id).toBe(queued);
  });

  it("POST /jobs/:id/retry with onlyFailed：回归保护，只重试 failed 条目", async () => {
    const { jobId, failed } = seedJob();
    const r = await call("POST", `/v1/fetch/jobs/${jobId}/retry`, { onlyFailed: true });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.jobId).toBeTruthy();

    const newJob = getFetchJob(r.body.jobId)!;
    expect(newJob.targets.targets.length).toBe(1);
    expect(newJob.targets.targets[0].id).toBe(failed);
  });

  it("GET /jobs/:id：items 从 targets 快照 join title/artist（无匹配 target 则留空）", async () => {
    const job = createFetchJob({
      kind: "manual",
      targets: { targets: [{ id: "t1", title: "晴天", artist: "周杰伦" }] },
      config: {},
    });
    saveFetchJobItems(job.id, [
      { id: "t1", targetId: "t1", status: "done", attempts: 1 },
      { id: "t-unknown", targetId: "t-unknown", status: "failed", attempts: 1 },
    ]);

    const r = await call("GET", `/v1/fetch/jobs/${job.id}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    const items = r.body.job.items;
    expect(items).toHaveLength(2);

    const hit = items.find((i: any) => i.targetId === "t1");
    expect(hit.title).toBe("晴天");
    expect(hit.artist).toBe("周杰伦");
    expect(hit.status).toBe("done");
    expect(hit.targetId).toBe("t1");

    // 无匹配 target 的 item：不崩、不误填。
    const miss = items.find((i: any) => i.targetId === "t-unknown");
    expect(miss.title).toBe("");
    expect(miss.artist).toBe("");
  });
});
