// importer 插件共享 HTTP 工具补测（src/services/plugin/importers/http.ts）。
//
// 这个文件是**所有第三方导入插件共用**的一层：超时、UA、重定向展开三件事在这里
// 统一做一次，插件作者不必各写一遍。也就是说这里的任何一个分支写错，受影响的是
// 全部导入插件，不是单个插件。
//
// 两条函数的共同形状是「AbortController + setTimeout + finally clearTimeout」，
// 所以除了结果，还要盯**定时器有没有被清掉**——漏了 clearTimeout 不会让用例红，
// 但会让每个导入请求的超时计时器活到天荒地老（Node 里表现为进程被拖住）。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchJson,
  resolveRedirect,
  IMPORTER_UA,
} from "../../src/services/plugin/importers/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 记录最后一次 fetch 调用的探针。 */
function installFetch(impl: (url: string, init: any) => any) {
  const spy = vi.fn(impl);
  (globalThis as any).fetch = spy;
  return spy;
}

function okBody(body: any, extra: any = {}) {
  return { ok: true, status: 200, json: async () => body, ...extra };
}

// ---------------------------------------------------------------- fetchJson

describe("fetchJson", () => {
  it("200:解析出 JSON", async () => {
    const spy = installFetch(() => Promise.resolve(okBody({ list: [1, 2] })));
    await expect(fetchJson("http://x/api")).resolves.toEqual({ list: [1, 2] });
    expect(spy.mock.calls[0][0]).toBe("http://x/api");
  });

  it("不带 headers 时只带默认 UA", async () => {
    const spy = installFetch(() => Promise.resolve(okBody({})));
    await fetchJson("http://x/api");
    expect(spy.mock.calls[0][1].headers).toEqual({ "User-Agent": IMPORTER_UA });
  });

  it("自定义 headers 与默认 UA 合并（调用方可覆盖 UA）", async () => {
    const spy = installFetch(() => Promise.resolve(okBody({})));
    await fetchJson("http://x/api", { "User-Agent": "my-ua", "X-Token": "t" });
    expect(spy.mock.calls[0][1].headers).toEqual({
      "User-Agent": "my-ua",
      "X-Token": "t",
    });
  });

  it("把 signal 交给 fetch,超时才能真的掐断上游", async () => {
    const spy = installFetch(() => Promise.resolve(okBody({})));
    await fetchJson("http://x/api", {}, 1234);
    const signal = spy.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("非 2xx:抛 HTTP <status>(不解析 body)", async () => {
    installFetch(() => Promise.resolve({
      ok: false, status: 404, json: async () => ({ msg: "not found" }),
    }));
    await expect(fetchJson("http://x/api")).rejects.toThrow("HTTP 404");
  });

  it("500 也一样抛,不会静默吞掉上游错误页", async () => {
    installFetch(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    await expect(fetchJson("http://x/api")).rejects.toThrow("HTTP 500");
  });

  it("network 层 reject 时原样上抛(不是包成 HTTP xxx)", async () => {
    const boom = new Error("ECONNREFUSED");
    installFetch(() => Promise.reject(boom));
    await expect(fetchJson("http://x/api")).rejects.toBe(boom);
  });

  it("超时真的会中断:signal abort 后立刻失败,不等上游慢慢回", async () => {
    let aborted = false;
    installFetch((_url, init) => new Promise((_resolve, reject) => {
      // 上游是个 200 秒才回来的慢服务,要靠超时把它掐掉。
      setTimeout(() => _resolve(okBody({ late: true })), 200_000);
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    }));
    await expect(fetchJson("http://x/api", {}, 5)).rejects.toThrow(/abort/i);
    expect(aborted).toBe(true);
  });

  it("成功路径也清掉计时器(finally),不留常驻 timer", async () => {
    installFetch(() => Promise.resolve(okBody({})));
    const spy = vi.spyOn(globalThis, "clearTimeout");
    await fetchJson("http://x/api");
    expect(spy).toHaveBeenCalled();
  });

  it("显式传 timeoutMs 时同样照常走完整流程(不因自定义超时走旁路)", async () => {
    installFetch(() => Promise.resolve(okBody({ custom: 1 })));
    await expect(fetchJson("http://x/api", {}, 0)).resolves.toEqual({ custom: 1 });
  });

  it("抛错路径同样清掉计时器(否则每次失败导入都漏一个 timer)", async () => {
    installFetch(() => Promise.resolve({ ok: false, status: 502, json: async () => ({}) }));
    const spy = vi.spyOn(globalThis, "clearTimeout");
    await expect(fetchJson("http://x/api")).rejects.toThrow("HTTP 502");
    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------- resolveRedirect

describe("resolveRedirect", () => {
  it("成功:返回最终 URL(fetch 解析后的 res.url)", async () => {
    const spy = installFetch(() => Promise.resolve({
      ok: true, status: 200, url: "http://x/final/target",
    }));
    await expect(resolveRedirect("http://x/s")).resolves.toBe("http://x/final/target");
    expect(spy.mock.calls[0][1].redirect).toBe("follow");
  });

  it("res.url 为空时回落成输入 URL", async () => {
    installFetch(() => Promise.resolve({ ok: true, status: 200, url: "" }));
    await expect(resolveRedirect("http://x/short")).resolves.toBe("http://x/short");
  });

  it("默认头只有 UA,不吞调用方传进来的东西(本函数不接受 headers 入参)", async () => {
    const spy = installFetch(() => Promise.resolve({ ok: true, status: 200, url: "u" }));
    await resolveRedirect("http://x/s");
    expect(spy.mock.calls[0][1].headers).toEqual({ "User-Agent": IMPORTER_UA });
  });

  it("【契约】任何失败都**不抛**,一律回落成输入 URL", async () => {
    const boom = new Error("socket hang up");
    installFetch(() => Promise.reject(boom));
    const r = await resolveRedirect("http://x/short");
    expect(r).toBe("http://x/short");
  });

  it("res.url 为 undefined 时也回落成输入 URL(与空串同侧)", async () => {
    installFetch(() => Promise.resolve({ ok: true, status: 200, url: undefined }));
    await expect(resolveRedirect("http://x/short")).resolves.toBe("http://x/short");
  });

  it("显式传 timeoutMs 时行为不变(默认值分支被显式值顶掉)", async () => {
    installFetch(() => Promise.resolve({ ok: true, status: 200, url: "http://final" }));
    await expect(resolveRedirect("http://x/s", 0)).resolves.toBe("http://final");
  });

  it("超时也不抛:回落成输入 URL", async () => {
    installFetch((_url, init) => new Promise((_resolve, reject) => {
      setTimeout(() => _resolve({ ok: true, status: 200, url: "http://late" }), 200_000);
      init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }));
    await expect(resolveRedirect("http://x/short", 5)).resolves.toBe("http://x/short");
  });

  it("成功路径清掉计时器", async () => {
    installFetch(() => Promise.resolve({ ok: true, status: 200, url: "u" }));
    const spy = vi.spyOn(globalThis, "clearTimeout");
    await resolveRedirect("http://x/s");
    expect(spy).toHaveBeenCalled();
  });

  it("失败路径也清掉计时器", async () => {
    installFetch(() => Promise.reject(new Error("nope")));
    const spy = vi.spyOn(globalThis, "clearTimeout");
    await resolveRedirect("http://x/s");
    expect(spy).toHaveBeenCalled();
  });
});
