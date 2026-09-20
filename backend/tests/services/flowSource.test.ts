/**
 * P3-7（接线层）：flow 的「开关 / 队列选曲 / ICY 元数据」纯函数。
 *
 * 这三件都不碰 DB / 队列 / HTTP（`get` 是注入的），所以能逐条断言；
 * 它们错了同样"不报错、只是行为不对"：
 *   - 开关缺省判错 → 用户以为开了交叉淡入，其实逐首（或反过来，客户端被拼流搞乱队列）；
 *   - 选曲判错 → 洗牌模式下服务端按队列下标拼流，与设备真实顺序打架；
 *   - ICY 块格式写错 → 设备把音频字节当元数据长度读，爆音/静音（且没有任何报错）。
 */
import { describe, it, expect } from "vitest";
import {
  CROSSFADE_DURATION_KEY,
  CROSSFADE_MODE_KEY,
  FLOW_ENABLED_KEY,
  FLOW_MAX_ITEMS,
  icyMetadataBlock,
  icyStreamTitle,
  resolveFlowSettings,
  selectFlowCandidates,
} from "../../src/services/audio/flowSource.js";
import type { QueueItem } from "../../src/services/player/types.js";

/** 造一个假队列快照（只带被测字段）。 */
function snap(items: string[], playMode: any = "order", currentIndex = 0) {
  return {
    items: items.map((songId) => ({ songId, title: songId, mime: "audio/mpeg" }) as QueueItem),
    currentIndex,
    playMode,
  };
}

/** 纯 Map 版配置读取（与路由传 getSetting 同形）。 */
function settingsFrom(map: Record<string, string>) {
  return (key: string, def: string) => (key in map ? map[key] : def);
}

describe("resolveFlowSettings：缺省必须全关", () => {
  it("什么都不配 → enabled 但 crossfade=false（行为等价逐首管道）", () => {
    const s = resolveFlowSettings(settingsFrom({}));
    expect(s.enabled).toBe(true);
    expect(s.crossfade).toBe(false);
    expect(s.mode).toBe("disabled");
    expect(s.fade.durationSec).toBe(8);
    expect(s.fade.curve).toBe("equal_power");
  });

  it("crossfade.mode=standard 才真正开启；总开关 0 能一票否决", () => {
    const on = resolveFlowSettings(
      settingsFrom({ [CROSSFADE_MODE_KEY]: "standard", [CROSSFADE_DURATION_KEY]: "5" }),
    );
    expect(on.crossfade).toBe(true);
    expect(on.mode).toBe("standard");
    expect(on.fade.durationSec).toBe(5);

    const vetoed = resolveFlowSettings(
      settingsFrom({ [FLOW_ENABLED_KEY]: "0", [CROSSFADE_MODE_KEY]: "standard" }),
    );
    expect(vetoed.enabled).toBe(false);
    expect(vetoed.crossfade).toBe(true); // 开关状态如实反映配置,由调用方用 enabled 把关
  });

  it("非法/越界配置收敛：模式只认 standard，时长夹到下限 3s、非法值回缺省", () => {
    expect(resolveFlowSettings(settingsFrom({ [CROSSFADE_MODE_KEY]: "SMART_CROSSFADE" })).mode).toBe("disabled");
    expect(resolveFlowSettings(settingsFrom({ [CROSSFADE_MODE_KEY]: " Standard " })).mode).toBe("standard");
    expect(resolveFlowSettings(settingsFrom({ [CROSSFADE_MODE_KEY]: "standard", [CROSSFADE_DURATION_KEY]: "1" })).fade.durationSec).toBe(3);
    expect(resolveFlowSettings(settingsFrom({ [CROSSFADE_MODE_KEY]: "standard", [CROSSFADE_DURATION_KEY]: "8" })).fade.durationSec).toBe(8);
    expect(resolveFlowSettings(settingsFrom({ [CROSSFADE_MODE_KEY]: "standard", [CROSSFADE_DURATION_KEY]: "abc" })).fade.durationSec).toBe(8);
    expect(resolveFlowSettings(settingsFrom({ [CROSSFADE_MODE_KEY]: "standard", [CROSSFADE_DURATION_KEY]: "-4" })).fade.durationSec).toBe(8);
  });

  it("P5-1：管道开关关掉 ⇒ 不拼流（effectsOn=false 一票否决，与 pipeline.flow 无关）", () => {
    const cfg = settingsFrom({ [CROSSFADE_MODE_KEY]: "standard", [FLOW_ENABLED_KEY]: "1" });
    expect(resolveFlowSettings(cfg, { effectsOn: true }).enabled).toBe(true);
    const off = resolveFlowSettings(cfg, { effectsOn: false });
    expect(off.enabled).toBe(false);
    // crossfade 只如实反映配置，由调用方用 enabled 把关（与本文件既有约定一致）
    expect(off.crossfade).toBe(true);
    // 缺省 = 不传该项 = 沿用原语义（逐首管道时代的行为不变）
    expect(resolveFlowSettings(cfg).enabled).toBe(true);
  });
});

describe("selectFlowCandidates：只在顺序播放、且歌在队列里时才拼流", () => {
  it("从当前首起按队列顺序截取（含自己）", () => {
    const out = selectFlowCandidates(snap(["a", "b", "c", "d"]), "b", 3);
    expect(out.map((i) => i.songId)).toEqual(["b", "c", "d"]);
  });

  it("默认上限 FLOW_MAX_ITEMS；给 max 时按 max 截断，不补不循环", () => {
    const items = Array.from({ length: FLOW_MAX_ITEMS + 50 }, (_, i) => `s${i}`);
    expect(selectFlowCandidates(snap(items), "s0").length).toBe(FLOW_MAX_ITEMS);
    expect(selectFlowCandidates(snap(items), "s10", 2).map((i) => i.songId)).toEqual(["s10", "s11"]);
    // 末尾不足 max → 只给剩下的（不回头补队列开头）
    expect(selectFlowCandidates(snap(["a", "b"]), "b", 5).map((i) => i.songId)).toEqual(["b"]);
  });

  it("洗牌 / 单曲循环 / 列表循环一律不拼（下一首不由队列下标决定）", () => {
    for (const mode of ["shuffle", "one", "all"] as const) {
      expect(selectFlowCandidates(snap(["a", "b", "c"], mode), "a", 5)).toEqual([]);
    }
  });

  it("歌已不在队列 / 队列为空 / 快照缺失 → 空（调用方回退单曲管道）", () => {
    expect(selectFlowCandidates(snap(["a", "b"]), "zzz")).toEqual([]);
    expect(selectFlowCandidates(snap([]), "a")).toEqual([]);
    expect(selectFlowCandidates(null, "a")).toEqual([]);
    expect(selectFlowCandidates(undefined, "a")).toEqual([]);
    expect(selectFlowCandidates(snap(["a"]), "")).toEqual([]);
  });

  it("没有 songId 的坏项被过滤掉（不让它变成一条空解码器）", () => {
    const s = snap(["a", "b"]);
    (s.items as any).splice(1, 0, { title: "bad", mime: "audio/mpeg" });
    expect(selectFlowCandidates(s, "a", 5).map((i) => i.songId)).toEqual(["a", "b"]);
  });
});

describe("ICY 元数据（P3-5：连续流里设备唯一的曲目边界来源）", () => {
  it("StreamTitle：有艺术家用 `Artist - Title`，否则只有标题；剔掉会破坏协议的分隔符", () => {
    expect(icyStreamTitle("Song", "Artist")).toBe("Artist - Song");
    expect(icyStreamTitle("Song")).toBe("Song");
    expect(icyStreamTitle("Song", "")).toBe("Song");
    expect(icyStreamTitle("Son'g;", "Ar'tist")).toBe("Artist - Song");
    expect(icyStreamTitle(undefined, undefined)).toBe("");
    expect(icyStreamTitle("", "Artist")).toBe("Artist");
  });

  it("块格式：首字节 = 16 字节分片数，总长 = 1 + N×16，右侧补 0", () => {
    const block = icyMetadataBlock("Song", "Artist");
    const payload = `StreamTitle='Artist - Song';`;
    const chunks = Math.ceil(Buffer.byteLength(payload) / 16);
    expect(block.length).toBe(1 + chunks * 16);
    expect(block.readUInt8(0)).toBe(chunks);
    expect(block.subarray(1, 1 + Buffer.byteLength(payload)).toString("utf8")).toBe(payload);
    // 尾部必须是 0 填充（设备按 N×16 读满）
    expect([...block.subarray(1 + Buffer.byteLength(payload))].every((b) => b === 0)).toBe(true);
  });

  it("空标题 = 长度 0 的单字节块（与'无更新'同义）", () => {
    expect([...icyMetadataBlock(undefined, undefined)]).toEqual([0]);
    expect([...icyMetadataBlock("", "")]).toEqual([0]);
  });

  it("超长标题被截到 255×16 字节（分片数是 1 字节，多一个分片就溢出成音频长度）", () => {
    const block = icyMetadataBlock("x".repeat(9000));
    expect(block.readUInt8(0)).toBe(255);
    expect(block.length).toBe(1 + 255 * 16);
  });

  it("多字节标题按**字节**算分片（不是按字符）", () => {
    const title = "中文标题很长很长很长";
    const block = icyMetadataBlock(title);
    const payload = Buffer.from(`StreamTitle='${title}';`, "utf8");
    expect(block.readUInt8(0)).toBe(Math.ceil(payload.length / 16));
    expect(block.length).toBe(1 + block.readUInt8(0) * 16);
  });
});
