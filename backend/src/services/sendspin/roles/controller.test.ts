import { describe, it, expect } from "vitest";
import { mapControllerCommand } from "./controller.js";

describe("controller command fields", () => {
  it("volume 命令必须带 volume 字段", () => {
    expect(mapControllerCommand({ command: "volume", volume: 40 })).toEqual({ k: "volume", v: 40 });
    expect(() => mapControllerCommand({ command: "volume" } as any)).toThrow();
  });

  it("play 命令不得带 position", () => {
    expect(mapControllerCommand({ command: "play" })).toEqual({ k: "play", v: undefined });
  });

  it("seek 校验 0<=pos<=seek_max", () => {
    expect(() => mapControllerCommand({ command: "seek", position_ms: -1 } as any)).toThrow();
    expect(() =>
      mapControllerCommand({ command: "seek", position_ms: 5000, seek_max: 1000 } as any),
    ).toThrow();
    expect(mapControllerCommand({ command: "seek", position_ms: 5000 })).toEqual({
      k: "seek",
      v: 5000,
    });
  });
});