// dlna/queue.ts —— 兼容层的两件真事。
//
// 这个文件看着只有十几行,却是两条链路上都躲不开的一环:
//   · suffixToMime 决定跑给 DLNA 设备的 Content-Type(设备靠它决定接不接这条流);
//   · getQueueManager 决定「同一台设备的队列有几份」—— 两份就是队列分裂。
// 路由层还有未迁移的调用点仍在用它,所以这两条契约必须钉住。
import "../plugins/_env.js";

import { describe, expect, it, vi } from "vitest";

// 真实 QueueController 有 heavy 依赖(DB / 插件 / 定时器);这里只要证明兼容层是
// **转发**、没有自己再造一份实例 —— 用替身验证"转发的就是那一个对象"最直白。
const QC = vi.hoisted(() => ({ controller: { tag: "the-one-and-only" } as unknown }));
vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => QC.controller,
}));

import { suffixToMime, getQueueManager } from "../../src/services/dlna/queue.js";

describe("suffixToMime:给 DLNA 设备的 Content-Type", () => {
  it("已知后缀各自映射正确", () => {
    expect(suffixToMime("flac")).toBe("audio/flac");
    expect(suffixToMime("mp3")).toBe("audio/mpeg");
    expect(suffixToMime("wav")).toBe("audio/wav");
    expect(suffixToMime("aac")).toBe("audio/aac");
    expect(suffixToMime("ogg")).toBe("audio/ogg");
    expect(suffixToMime("m4a")).toBe("audio/mp4");
    expect(suffixToMime("opus")).toBe("audio/opus");
    expect(suffixToMime("wma")).toBe("audio/x-ms-wma");
    expect(suffixToMime("ape")).toBe("audio/ape");
  });

  it("后缀大小写与点号不敏感(盘里的文件名不会统一大小写)", () => {
    expect(suffixToMime("FLAC")).toBe("audio/flac");
    expect(suffixToMime("Mp3")).toBe("audio/mpeg");
    expect(suffixToMime(".flac")).toBe("audio/mpeg"); // 带点不算 —— 调用方已去掉点
  });

  it("未知/空后缀回落到 audio/mpeg(宁可给个能播的,不能给空)", () => {
    expect(suffixToMime("")).toBe("audio/mpeg");
    expect(suffixToMime("dsf")).toBe("audio/mpeg");
    expect(suffixToMime("mp4")).toBe("audio/mpeg");
  });
});

describe("getQueueManager:兼容层必须是转发而不是新实例", () => {
  it("返回的是 QueueController 本体(不存在第二份队列状态)", () => {
    expect(getQueueManager()).toBe(QC.controller);
    expect(getQueueManager()).toBe(getQueueManager());
  });
});
