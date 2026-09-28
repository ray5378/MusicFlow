// 覆盖率长尾补充:utils/env.ts 的配置读取分支。
//   - loadDotEnv():惰性读取 backend/.env(真实环境变量优先、已有变量不覆盖、去掉引号)
//   - getCorsOrigins():逗号分隔 + trim + 去空
//   - getPlayHistoryRetentionDays():非法/负数回落 3,0 合法
// loadDotEnv 用 process.cwd() 定位 .env;这里用 spy 把 cwd 指向临时目录,
// 避免在仓库里创建/污染真实 .env。
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getCorsOrigins, getPlayHistoryRetentionDays } from "../../src/utils/env.js";

const TOUCHED = ["TAIL_DOTENV_A", "TAIL_DOTENV_QUOTED", "TAIL_DOTENV_EXISTING", "CORS_ORIGINS", "PLAY_HISTORY_RETENTION_DAYS"];

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  vi.restoreAllMocks();
});

describe("loadDotEnv(经 getCorsOrigins 触达)", () => {
  it("读取 cwd/.env:新增变量生效、已有变量不被覆盖、引号被剥掉", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-tail-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      [
        "TAIL_DOTENV_A=plain-value",
        'TAIL_DOTENV_QUOTED="quoted-value"',
        "TAIL_DOTENV_EXISTING=from-file",
        "# 注释行",
        "不是合法行",
        "CORS_ORIGINS=http://a.test, http://b.test ,",
        "",
      ].join("\n"),
    );
    // 已存在的真实环境变量必须优先(部署时注入的值不能被 .env 顶掉)。
    process.env.TAIL_DOTENV_EXISTING = "from-real-env";

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      const origins = getCorsOrigins(); // 触发 loadDotEnv()
      expect(origins).toEqual(["http://a.test", "http://b.test"]);
      expect(process.env.TAIL_DOTENV_A).toBe("plain-value");
      expect(process.env.TAIL_DOTENV_QUOTED).toBe("quoted-value"); // 首尾引号被剥掉
      expect(process.env.TAIL_DOTENV_EXISTING).toBe("from-real-env"); // 未被 .env 覆盖
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cwd 下没有 .env 时静默返回,不影响配置读取", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-tail-none-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      process.env.CORS_ORIGINS = " http://only.test ";
      expect(getCorsOrigins()).toEqual(["http://only.test"]);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getCorsOrigins", () => {
  it("未配置 → 空数组", () => {
    delete process.env.CORS_ORIGINS;
    expect(getCorsOrigins()).toEqual([]);
  });
});

describe("getPlayHistoryRetentionDays", () => {
  it("合法非负整数原样返回(0 = 不保留 也合法)", () => {
    process.env.PLAY_HISTORY_RETENTION_DAYS = "7";
    expect(getPlayHistoryRetentionDays()).toBe(7);
    process.env.PLAY_HISTORY_RETENTION_DAYS = "0";
    expect(getPlayHistoryRetentionDays()).toBe(0);
  });

  it("未配置 / 非法 / 负数 → 回落默认 3", () => {
    delete process.env.PLAY_HISTORY_RETENTION_DAYS;
    expect(getPlayHistoryRetentionDays()).toBe(3);
    process.env.PLAY_HISTORY_RETENTION_DAYS = "abc";
    expect(getPlayHistoryRetentionDays()).toBe(3);
    process.env.PLAY_HISTORY_RETENTION_DAYS = "-1";
    expect(getPlayHistoryRetentionDays()).toBe(3);
  });
});
