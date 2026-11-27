import { describe, it, expect } from "vitest";
import {
  SCHEDULE_GROUP,
  SCHEDULED_CAPS,
  SCHEDULE_FIELDS,
  BATCH_GROUP,
  BATCH_PARALLEL_FIELD,
  withScheduleFields,
  isBatchCapable,
  withBatchParallelField,
} from "../../src/services/plugin/scheduleFields.js";
import type { PluginManifest } from "../../src/plugins/types.js";

function manifest(patch: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "p1", name: "P1", version: "1.0.0", description: "", capabilities: [],
    configSchema: [], ...patch,
  } as PluginManifest;
}

// 歌单插件共用调度开关：按能力/声明幂等注入 schedule 与 batch 字段。
describe("withScheduleFields（定时开关注入）", () => {
  it("常量契约：默认 scheduleEnabled=true / runOnBoot=false", () => {
    expect(SCHEDULE_FIELDS.find((f) => f.key === "scheduleEnabled")?.default).toBe(true);
    expect(SCHEDULE_FIELDS.find((f) => f.key === "runOnBoot")?.default).toBe(false);
    expect(SCHEDULE_FIELDS.every((f) => f.group === SCHEDULE_GROUP)).toBe(true);
  });

  it("无调度能力且 schedules 未声明 → 不注入", () => {
    const m = manifest({ capabilities: ["source"] });
    expect(withScheduleFields(m).configSchema).toEqual([]);
  });

  it("声明了 SCHEDULED_CAPS 之一（缺省 schedules）→ 注入两个字段", () => {
    const m = manifest({ capabilities: ["dailyPlaylist"] });
    const out = withScheduleFields(m);
    expect(out.configSchema.map((f) => f.key)).toEqual(["scheduleEnabled", "runOnBoot"]);
  });

  it("schedules=true 全注入，false 不注入", () => {
    expect(withScheduleFields(manifest({ schedules: true })).configSchema.length).toBe(2);
    expect(withScheduleFields(manifest({ schedules: false, capabilities: ["dailyPlaylist"] })).configSchema).toEqual([]);
  });

  it("schedules 对象按逐项 true 选择子集", () => {
    const out = withScheduleFields(manifest({ schedules: { scheduleEnabled: true, runOnBoot: false } as any }));
    expect(out.configSchema.map((f) => f.key)).toEqual(["scheduleEnabled"]);
  });

  it("幂等：已有字段不重复注入", () => {
    const m = manifest({ capabilities: ["dailyPlaylist"], configSchema: [SCHEDULE_FIELDS[0]] });
    const out = withScheduleFields(m);
    expect(out.configSchema.filter((f) => f.key === "scheduleEnabled").length).toBe(1);
    expect(out.configSchema.length).toBe(2);
  });

  it("畸形 manifest 原样返回", () => {
    expect(withScheduleFields({ configSchema: null } as any).configSchema).toBeNull();
  });
});

describe("isBatchCapable / withBatchParallelField（并行开关注入）", () => {
  it("SCHEDULED_CAPS 能力 → batch capable", () => {
    expect(isBatchCapable(manifest({ capabilities: ["playlistImport"] }))).toBe(true);
    expect(isBatchCapable(undefined)).toBe(false);
    expect(isBatchCapable(manifest({ capabilities: [] }))).toBe(false);
  });

  it("longRunning 非空 → capable", () => {
    expect(isBatchCapable(manifest({ longRunning: { do: async () => {} } } as any))).toBe(true);
    expect(isBatchCapable(manifest({ longRunning: {} } as any))).toBe(false);
  });

  it("batch capable 才注入 batchParallel，默认 false", () => {
    expect(BATCH_PARALLEL_FIELD.default).toBe(false);
    expect(BATCH_PARALLEL_FIELD.group).toBe(BATCH_GROUP);
    const out = withBatchParallelField(manifest({ capabilities: ["dailyPlaylist"] }));
    expect(out.configSchema.some((f) => f.key === "batchParallel")).toBe(true);
    const no = withBatchParallelField(manifest({ capabilities: ["source"] }));
    expect(no.configSchema).toEqual([]);
  });

  it("幂等：已有 batchParallel 不重复", () => {
    const m = manifest({ capabilities: ["dailyPlaylist"], configSchema: [BATCH_PARALLEL_FIELD] });
    const out = withBatchParallelField(m);
    expect(out.configSchema.filter((f) => f.key === "batchParallel").length).toBe(1);
  });
});
