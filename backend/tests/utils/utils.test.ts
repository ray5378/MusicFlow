// logger / errors 工具模块专项测试。
import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../../src/utils/logger.js";
import { BusinessErrorCode, apiError, apiOk } from "../../src/utils/errors.js";

describe("createLogger", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    delete process.env.LOG_LEVEL;
  });
  function capture() {
    const log = console.log;
    const err = console.error;
    const warn = console.warn;
    const out: string[] = [];
    spies.push(vi.spyOn(console, "log").mockImplementation((...a: any[]) => out.push(a.join(" "))));
    spies.push(vi.spyOn(console, "error").mockImplementation((...a: any[]) => out.push(a.join(" "))));
    spies.push(vi.spyOn(console, "warn").mockImplementation((...a: any[]) => out.push(a.join(" "))));
    void log; void err; void warn;
    return out;
  }

  it("info 输出带前缀与结构化字段", () => {
    const out = capture();
    const log = createLogger("TEST-PREFIX");
    log.info("启动完成", { deviceCount: 3 });
    expect(out[0]).toMatch(/^\[INFO\] \[TEST-PREFIX\] 启动完成 deviceCount=3$/);
  });

  it("error 输出到 console.error 且含 err 字段", () => {
    const out = capture();
    const log = createLogger("TEST-ERR");
    log.error("任务失败", { taskId: "t-1", err: "boom" });
    expect(out[0]).toMatch(/^\[ERROR\] \[TEST-ERR\] 任务失败 taskId=t-1 err=boom$/);
  });

  it("warn/debug 同样以等级标志开头（四级格式统一）", () => {
    process.env.LOG_LEVEL = "debug";
    const out = capture();
    const log = createLogger("TEST-LV");
    log.warn("降级处理");
    log.debug("明细");
    expect(out[0]).toMatch(/^\[WARN\] \[TEST-LV\] 降级处理$/);
    expect(out[1]).toMatch(/^\[DEBUG\] \[TEST-LV\] 明细$/);
  });

  it("旧文案自带同名 [PREFIX] 时输出层去重，不会双前缀", () => {
    const out = capture();
    const log = createLogger("TEST-DEDUP");
    log.info("[TEST-DEDUP] 迁移中的旧文案", { n: 1 });
    expect(out[0]).toMatch(/^\[INFO\] \[TEST-DEDUP\] 迁移中的旧文案 n=1$/);
    expect(out[0]).not.toContain("[TEST-DEDUP] [TEST-DEDUP]");
  });

  it("LOG_LEVEL=error 时过滤 info/warn", () => {
    process.env.LOG_LEVEL = "error";
    const out = capture();
    const log = createLogger("TEST-LEVEL");
    log.info("不应出现");
    log.warn("不应出现");
    log.error("应出现");
    expect(out.join("\n")).not.toContain("不应出现");
    expect(out.join("\n")).toContain("应出现");
  });
});

describe("BusinessErrorCode / apiError", () => {
  it("枚举覆盖 SPEC 定义的 7 个稳定字符串", () => {
    expect(BusinessErrorCode.INVALID_PARAM).toBe("INVALID_PARAM");
    expect(BusinessErrorCode.NOT_FOUND).toBe("NOT_FOUND");
    expect(BusinessErrorCode.CONFLICT).toBe("CONFLICT");
    expect(BusinessErrorCode.BUSY).toBe("BUSY");
    expect(BusinessErrorCode.FORBIDDEN).toBe("FORBIDDEN");
    expect(BusinessErrorCode.UPSTREAM_ERROR).toBe("UPSTREAM_ERROR");
    expect(BusinessErrorCode.INTERNAL).toBe("INTERNAL");
  });

  it("apiError 返回兼容结构(success:false + code + error)", () => {
    const e = apiError(BusinessErrorCode.NOT_FOUND, "歌单不存在");
    expect(e).toEqual({ success: false, code: "NOT_FOUND", error: "歌单不存在" });
  });

  it("apiOk 返回 success:true 并可附加数据", () => {
    expect(apiOk()).toEqual({ success: true });
    expect(apiOk({ n: 1 })).toEqual({ success: true, n: 1 });
  });
});
