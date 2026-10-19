// scanScheduler 每日定时增量扫描调度 + scanRunner 共享扫描任务运行器 单元测试。
//
// 覆盖两块：
//   - runScanSchedulerOnce：类型闸（local/webdav）/ 开关闸 / 配置解析失败 / 当日已跑 /
//     未到点 / 已在跑让渡（不落标记） / 正常触发（落 lastRunAt + 起扫描）；
//   - startScanScheduler：幂等挂载 + tick 异常吞掉；
//   - scanRunner.startSourceScan：并发让渡、手动/定时来源标记、scan 与 scrape 载荷分流、
//     完成 / 失败 / 停止 三态收尾。
//
// 全程 vi.mock 打桩外围依赖：零真实网络 / 零真实子进程；media_sources 查询走 spy 控制，
// settings 亦已打桩（避免 5s TTL 缓存带来的顺序耦合）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ==================== 模块打桩（vi.mock 会被提升到 import 之前） ====================
vi.mock("../../src/services/settings.js", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
// scanScheduler 仅借用 todayTriggerMs：整体打桩以便自由控制「到点」判定。
vi.mock("../../src/services/fetch/upgradeScheduler.js", () => ({
  todayTriggerMs: vi.fn(),
}));
// 批量子进程一律打桩：scanRunner 内部经此发起扫描。
vi.mock("../../src/batch/runner.js", () => ({
  runBatchJob: vi.fn(),
}));

import { sqlite } from "../../src/db/index.js";
import { getSetting, setSetting } from "../../src/services/settings.js";
import { todayTriggerMs } from "../../src/services/fetch/upgradeScheduler.js";
import { runBatchJob } from "../../src/batch/runner.js";
import { runScanSchedulerOnce, startScanScheduler } from "../../src/services/source/scanScheduler.js";
import { scanJobs, startSourceScan } from "../../src/services/source/scanRunner.js";

// ==================== 公用件 ====================

const NOW = 1_800_000_000_000;
const realPrepare = sqlite.prepare.bind(sqlite);

let mediaRows: any[] = [];
let prepareSpy: any;

/** 构造一条 media_sources 行（config 已是 JSON 串）。 */
function sourceRow(over: Record<string, any> = {}) {
  return {
    id: "s1",
    name: "src-one",
    type: "local",
    config: JSON.stringify({ scanAutoEnabled: true, scanAutoTimeOfDay: "03:00" }),
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mediaRows = [];
  // 只拦 media_sources 查询，其余走真实连接。
  prepareSpy = vi.spyOn(sqlite, "prepare").mockImplementation(((sql: any) => {
    if (String(sql).includes("media_sources")) return { all: () => mediaRows } as any;
    return realPrepare(sql);
  }) as any);
  vi.mocked(getSetting).mockReturnValue("0");
  vi.mocked(todayTriggerMs).mockReturnValue(1); // 默认视为「今天已到点」
  // runBatchJob 的真实返回：result 是 batch 作业外层载荷（scanHandler 返回 {result,aborted,scrape}）。
  vi.mocked(runBatchJob).mockResolvedValue({
    result: { result: { added: 1, updated: 0, removed: 0, skipped: 0 }, aborted: false, scrape: null },
    childRss: 0,
  } as any);
  scanJobs.clear();
});

afterEach(() => {
  prepareSpy?.mockRestore();
  scanJobs.clear();
});

// ==================== runScanSchedulerOnce：闸门与触发 ====================

describe("runScanSchedulerOnce — 闸门与触发", () => {
  it("类型闸：非 local/webdav（如 webdav 以外的类型）跳过", () => {
    mediaRows = [sourceRow({ type: "s3" })];
    expect(runScanSchedulerOnce(NOW)).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("开关闸：scanAutoEnabled 非 true → 不触发", () => {
    mediaRows = [sourceRow({ config: JSON.stringify({ scanAutoEnabled: false }) })];
    expect(runScanSchedulerOnce(NOW)).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("config 非法 JSON → 跳过（不抛）", () => {
    mediaRows = [sourceRow({ config: "{not-json" })];
    expect(() => runScanSchedulerOnce(NOW)).not.toThrow();
    expect(runScanSchedulerOnce(NOW)).toEqual([]);
  });

  it("当日已触发（lastRunAt >= 日界）→ 跳过且不落标记", () => {
    mediaRows = [sourceRow()];
    vi.mocked(getSetting).mockReturnValue(String(NOW));
    expect(runScanSchedulerOnce(NOW)).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("未到点（todayTriggerMs<=0 或 now < 触发时刻）→ 跳过", () => {
    mediaRows = [sourceRow()];
    vi.mocked(todayTriggerMs).mockReturnValue(0);
    expect(runScanSchedulerOnce(NOW)).toEqual([]);
    vi.mocked(todayTriggerMs).mockReturnValue(NOW + 10_000);
    expect(runScanSchedulerOnce(NOW)).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("已有扫描在跑 → 让渡：不落标记、不起新任务，下一 tick 再判", () => {
    mediaRows = [sourceRow()];
    scanJobs.set("s1", { status: "running", startedAt: new Date(NOW).toISOString(), mode: "incremental", trigger: "manual" });
    expect(runScanSchedulerOnce(NOW)).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
    // 让渡期间沿用既有任务，不被覆盖成新的 auto 任务
    expect(scanJobs.get("s1")!.trigger).toBe("manual");
  });

  it("正常触发：落 lastRunAt + 起扫描（来源标记 auto）", () => {
    mediaRows = [sourceRow()];
    const triggered = runScanSchedulerOnce(NOW);
    expect(triggered).toEqual(["s1"]);
    expect(setSetting).toHaveBeenCalledWith("scan.auto.lastRunAt.s1", String(NOW));
    expect(scanJobs.get("s1")!.status).toBe("running");
    expect(scanJobs.get("s1")!.trigger).toBe("auto");
    expect(scanJobs.get("s1")!.mode).toBe("incremental");
  });

  it("正常触发后，子进程回执 → 状态收尾为 completed", async () => {
    mediaRows = [sourceRow()];
    runScanSchedulerOnce(NOW);
    await vi.waitFor(() => expect(scanJobs.get("s1")!.status).toBe("completed"));
    expect(scanJobs.get("s1")!.result).toEqual({ added: 1, updated: 0, removed: 0, skipped: 0 });
  });

  it("lastRunAt 非法字符串 → 视作 0（放行当日闸）", () => {
    mediaRows = [sourceRow()];
    vi.mocked(getSetting).mockReturnValue("not-a-number");
    expect(runScanSchedulerOnce(NOW)).toEqual(["s1"]);
  });
});

// ==================== startScanScheduler：挂载与 tick ====================

describe("startScanScheduler — 挂载与 tick", () => {
  it("幂等挂载：只注册一次定时器，tick 异常被吞掉", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as any);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((() => 0) as any);
    try {
      startScanScheduler();
      startScanScheduler(); // 第二次应被 started 守卫挡下
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const tick = setTimeoutSpy.mock.calls[0][0] as () => void;

      // 正常 tick：无行 → 不触发、不抛。
      expect(() => tick()).not.toThrow();

      // 异常分支：prepare 抛错被 tick 吞掉，不向外冒。
      prepareSpy.mockImplementation(() => {
        throw new Error("boom");
      });
      expect(() => tick()).not.toThrow();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});

// ==================== scanRunner.startSourceScan：共享状态与收尾 ====================

describe("startSourceScan — 共享扫描状态与收尾", () => {
  it("首次发起：置 running + 记录来源/模式，二次发起被并发闸挡下", () => {
    vi.mocked(runBatchJob).mockImplementation((() => new Promise(() => {})) as any); // 永不 settle
    const first = startSourceScan({ sourceId: "s9", mode: "full", trigger: "manual" });
    expect(first.started).toBe(true);
    expect(scanJobs.get("s9")!.status).toBe("running");
    expect(scanJobs.get("s9")!.trigger).toBe("manual");
    expect(scanJobs.get("s9")!.mode).toBe("full");

    const second = startSourceScan({ sourceId: "s9", mode: "incremental", trigger: "auto" });
    expect(second).toEqual({ started: false, busy: true });
  });

  it("载荷分流：scan → job.progress；scrape-* → 旁路回调", () => {
    let emit: ((p: any) => void) | undefined;
    vi.mocked(runBatchJob).mockImplementation(((_k: any, _a: any, opts: any) => {
      emit = opts?.onProgress;
      return new Promise(() => {});
    }) as any);
    const scrapeSpy = vi.fn();
    startSourceScan({ sourceId: "s9", mode: "incremental", trigger: "manual", onProgress: scrapeSpy });

    emit!({ stage: "scan", phase: "scanning", processedFiles: 3, totalFiles: 10 });
    expect(scanJobs.get("s9")!.progress).toMatchObject({ phase: "scanning", processedFiles: 3, totalFiles: 10 });
    expect(scrapeSpy).not.toHaveBeenCalled();

    emit!({ stage: "scrape-start", total: 4 });
    expect(scrapeSpy).toHaveBeenCalledWith({ stage: "scrape-start", total: 4 });
    // scrape 载荷不得污染 job.progress
    expect(scanJobs.get("s9")!.progress).toMatchObject({ phase: "scanning", processedFiles: 3 });
  });

  it("完成：状态收尾 completed + onDone 回执", async () => {
    const done = vi.fn();
    vi.mocked(runBatchJob).mockResolvedValue({
      result: { result: { added: 2, skipped: 1 }, aborted: false, scrape: null },
      childRss: 0,
    } as any);
    startSourceScan({ sourceId: "s9", mode: "incremental", trigger: "auto", onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(scanJobs.get("s9")!.status).toBe("completed");
    // 必须解一层 batch 外层载荷：result.result 才是扫描计数
    expect(done).toHaveBeenCalledWith({ status: "completed", result: { added: 2, skipped: 1 }, error: undefined });
  });

  it("失败：子进程抛错 → 状态 failed + 回执错误信息", async () => {
    const done = vi.fn();
    vi.mocked(runBatchJob).mockRejectedValue(new Error("child exploded"));
    startSourceScan({ sourceId: "s9", mode: "full", trigger: "manual", onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(scanJobs.get("s9")!.status).toBe("failed");
    expect(scanJobs.get("s9")!.error).toContain("child exploded");
  });

  it("停止：父进程 abort → 状态 stopped", async () => {
    const done = vi.fn();
    vi.mocked(runBatchJob).mockImplementation(((_k: any, _a: any, opts: any) =>
      new Promise((resolve) => {
        // 真实语义：abort 时父进程 runner 会以 aborted=true 收尾（外层载荷含 aborted）。
        opts.signal.addEventListener(
          "abort",
          () => resolve({ result: { result: { added: 1, aborted: true }, aborted: true, scrape: null }, childRss: 0, aborted: true }),
          { once: true },
        );
      })) as any);
    startSourceScan({ sourceId: "s9", mode: "full", trigger: "manual", onDone: done });
    scanJobs.get("s9")!.controller!.abort();
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(scanJobs.get("s9")!.status).toBe("stopped");
  });
});
