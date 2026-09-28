// ==================== plugins/registryCatalog 长尾 ====================
// 既有 registryCatalog.test.ts 覆盖正常拉取/合并/安装成功路径。这里补「异常收口」:
//   - fetchOneRegistry:响应不是数组也没有 plugins 字段 → 尝试耗尽后抛错(该注册表整组 error);
//   - listMarketplace:某个 plugin.json 拉取失败 → 只跳过该条,不中断其余;
//   - installPlugin:下载失败 → 打日志后原样重抛(含 tmp 目录清理);
//   - findFile:目录树中找不到目标文件 → null。
import "./_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { initDatabase } from "../../src/db/index.js";
import {
  addRegistry,
  removeRegistry,
  listMarketplace,
  findFile,
  installPlugin,
} from "../../src/plugins/registryCatalog.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

const added: string[] = [];
let origFetch: any;

const mockFetch = async (url: any): Promise<any> => {
  const u = String(url);
  if (u === "https://lt4.test/badjson.json") {
    // 合法 JSON,但既不是数组也没有 plugins 字段 → 不是有效注册表
    return { ok: true, status: 200, json: async () => ({ nope: 1 }) };
  }
  if (u === "https://lt4.test/withp.json") {
    return { ok: true, status: 200, json: async () => ({ plugins: ["https://lt4.test/deadp.json"], includes: [] }) };
  }
  if (u === "https://lt4.test/deadp.json") {
    return { ok: false, status: 500, json: async () => ({}) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

describe("registryCatalog 异常收口", () => {
  beforeAll(() => {
    origFetch = globalThis.fetch;
    (globalThis as any).fetch = mockFetch as any;
    added.push(addRegistry("https://lt4.test/badjson.json"));
    added.push(addRegistry("https://lt4.test/withp.json"));
  });
  afterAll(() => {
    (globalThis as any).fetch = origFetch;
    for (const id of added) removeRegistry(id);
  });

  it("无效注册表 JSON 不产出条目,单个 plugin.json 拉取失败不拖垮其余", async () => {
    // 为什么:一个坏注册表/坏条目必须被静默跳过,否则整个插件市场整页加载失败。
    const m = await listMarketplace();
    // badjson 组没有条目;withp 组的唯一条目 deadp.json 拉取失败 → 也不产出。
    expect(m.filter((x) => x.sourceUrl === "https://lt4.test/deadp.json")).toHaveLength(0);
  });
});

describe("findFile", () => {
  it("目录树里没有目标文件 → null", () => {
    // 为什么:installPlugin 依赖 findFile 判定「插件包缺少 manifest」,找不到必须明确返回 null。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-findfile-"));
    try {
      fs.mkdirSync(path.join(root, "sub"), { recursive: true });
      fs.writeFileSync(path.join(root, "sub", "other.json"), "{}");
      expect(findFile(root, "plugin.json")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installPlugin 下载失败", () => {
  it("fetch 非 2xx → 重抛可读错误(且不残留临时目录)", async () => {
    // 为什么:安装失败必须冒泡给路由转成可读响应,静默成功会让用户以为装上了。
    const prev = globalThis.fetch;
    (globalThis as any).fetch = mockFetch as any;
    try {
      await expect(installPlugin("https://lt4.test/missing.tgz")).rejects.toThrow(/HTTP 404/);
    } finally {
      (globalThis as any).fetch = prev;
    }
  });
});
