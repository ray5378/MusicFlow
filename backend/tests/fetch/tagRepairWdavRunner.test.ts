// 云盘修复运行器单测：游标续跑 / 熔断 / 停止。修复本体打桩，只验调度语义。
import { describe, expect, it, vi, beforeEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { setSetting } from "../../src/services/settings.js";

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("../../src/services/fetch/tagRepairWdav.js", () => ({
  repairWebdavSongTags: mocks.repair,
}));

const {
  startWdavRepair,
  stopWdavRepair,
  getWdavRepairState,
  _resetWdavRepairForTest,
  getWdavProgressInfo,
  previewWdavRepair,
  resumeWdavRepairOnBoot,
} = await import("../../src/services/fetch/tagRepairWdavRunner.js");

const SRC = "src-runner";
const DIR = "/dav/共享/音乐/测试目录";

function seedSongs(n: number) {
  for (let i = 0; i < n; i++) {
    sqlite
      .prepare(
        `INSERT INTO songs (id,title,artist,album,duration,path,has_lyrics,created_at,updated_at)
         VALUES (?,?,?,?,?,?,0,datetime('now'),datetime('now'))`,
      )
      .run(`r${i}`, `歌${i}`, "歌手", "", 200000, `w:${SRC}:${DIR}/歌${i}.flac`);
  }
}

const targets = [{ sourceId: SRC, dir: DIR }];

async function waitIdle(ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!getWdavRepairState()?.running) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("wdav 运行器", () => {
  beforeEach(async () => {
    _resetWdavRepairForTest();
    sqlite.prepare(`DELETE FROM songs WHERE path LIKE ?`).run(`w:${SRC}:%`);
    sqlite.prepare("DELETE FROM settings WHERE key LIKE 'fetch.tagrepair.wdav%'").run();
    mocks.repair.mockReset();
  });

  it("正常跑完：计数正确、游标到位、finished 置真", async () => {
    seedSongs(3);
    mocks.repair.mockResolvedValue({ outcome: "skip", note: "标签已齐" });
    await startWdavRepair({ targets });
    await waitIdle();
    const st = getWdavRepairState()!;
    expect(st.running).toBe(false);
    expect(st.done).toBe(3);
    const p = getWdavProgressInfo()!;
    expect(p.finished).toBe(true);
    expect(p.lastPath).toContain("歌2.flac");
  });

  it("同目标再次开始 ⇒ 从游标继续，不重置计数", async () => {
    seedSongs(3);
    mocks.repair.mockResolvedValue({ outcome: "skip", note: "标签已齐" });
    await startWdavRepair({ targets });
    await waitIdle();
    const before = getWdavProgressInfo()!.done;

    await startWdavRepair({ targets }); // 同一目标
    await waitIdle();
    const after = getWdavProgressInfo()!;
    expect(after.done).toBeGreaterThanOrEqual(before);
    expect(after.lastPath).toContain("歌2.flac");
  });

  it("写盘失败：游标不前进，且连续 5 首失败熔断", async () => {
    seedSongs(8);
    mocks.repair.mockResolvedValue({ outcome: "error", note: "上传失败: 405" });
    await startWdavRepair({ targets });
    await waitIdle(5000);
    const st = getWdavRepairState()!;
    const p = getWdavProgressInfo()!;
    expect(st.running).toBe(false);
    expect(p.done).toBe(0); // 一首都没算成功，游标停在起点
    expect(st.failed).toBeGreaterThanOrEqual(5);
    expect(st.lastError).toContain("405");
  });

  it("stop 请求后本轮结束，进度保留", async () => {
    seedSongs(3);
    let n = 0;
    mocks.repair.mockImplementation(async () => {
      n += 1;
      if (n === 2) stopWdavRepair();
      return { outcome: "skip", note: "" };
    });
    await startWdavRepair({ targets });
    await waitIdle();
    const p = getWdavProgressInfo()!;
    expect(p.done).toBeGreaterThanOrEqual(1);
    expect(p.done).toBeLessThan(3);
  });
});

describe("wdav 运行器 — 预演与启动续跑", () => {
  beforeEach(async () => {
    _resetWdavRepairForTest();
    sqlite.prepare(`DELETE FROM songs WHERE path LIKE ?`).run(`w:${SRC}:%`);
    sqlite.prepare("DELETE FROM settings WHERE key LIKE 'fetch.tagrepair.wdav%'").run();
    mocks.repair.mockReset();
  });

  it("previewWdavRepair 只统计候选，不启动任务", async () => {
    seedSongs(4);
    const r = previewWdavRepair(targets as never);
    expect(r.candidates).toBe(4);
    expect(r.estSeconds).toBeGreaterThan(0);
    expect(getWdavRepairState()).toBeNull();
  });

  it("boot 续跑：有未完成进度时自动接上（不新建）", async () => {
    seedSongs(2);
    mocks.repair.mockResolvedValue({ outcome: "skip", note: "" });
    await startWdavRepair({ targets });
    await waitIdle();
    // 把 finished 改回 false，模拟"上次进程被杀"
    const raw = JSON.parse(
      (sqlite.prepare("SELECT value FROM settings WHERE key='fetch.tagrepair.wdavProgress'").get() as any).value,
    );
    raw.finished = false;
    // 走 setSetting（同一进程内的设置缓存才能被读到）
    setSetting("fetch.tagrepair.wdavProgress", JSON.stringify(raw));

    const r = resumeWdavRepairOnBoot();
    expect(r.resumed).toBe(true);
    expect(r.total).toBe(2);
    await waitIdle();
  });

  it("空闲时 stop 不报错", () => {
    const r = stopWdavRepair();
    expect(r.requested).toBe(true);
  });
});
