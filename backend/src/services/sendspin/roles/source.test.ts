import { describe, it, expect } from "vitest";
import { packSourceChunk, parseSourceChunk } from "./source.js";

describe("source role", () => {
  it("type 12 = [0x0C][i64 μs][data]", () => {
    const b = packSourceChunk(5n, new Uint8Array([9, 8]));
    expect(b[0]).toBe(12);
    expect(parseSourceChunk(b)).toEqual({ timestampUs: 5n, data: new Uint8Array([9, 8]) });
  });
});