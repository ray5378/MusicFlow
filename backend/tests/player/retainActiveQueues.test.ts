import { describe, it, expect } from "vitest";
import { QueueController } from "../../src/services/player/QueueController.js";

const BASE = "http://127.0.0.1:46400";

function item(songId: string): any {
  return {
    songId,
    title: songId,
    artist: "a",
    album: "b",
    duration: 100,
    source: "local",
    streamUrl: `${BASE}/rest/stream/${songId}`,
  };
}

describe("关停保留活跃队列(保住重启后的自动续播)", () => {
  it("停机把队列标记 inactive 后,retainActiveQueues 按快照恢复 isActive", () => {
    const qc = new QueueController();
    qc.setQueue("dev1", [item("s1")], 0, BASE);
    expect(qc.snapshot("dev1").isActive).toBe(true);
    expect(qc.activeDevices().map((a) => a.deviceId)).toContain("dev1");

    qc.stopPlayback("dev1"); // 模拟停机流程(SIGTERM → stop/TEARDOWN)清活跃标记
    expect(qc.snapshot("dev1").isActive).toBe(false);
    expect(qc.activeDevices().map((a) => a.deviceId)).not.toContain("dev1");

    qc.retainActiveQueues(["dev1"]);
    expect(qc.snapshot("dev1").isActive).toBe(true);
    expect(qc.activeDevices().map((a) => a.deviceId)).toContain("dev1");
  });

  it("空队列不复活,未知 id 不抛错", () => {
    const qc = new QueueController();
    qc.setQueue("dev2", [], -1, BASE);
    qc.stopPlayback("dev2");
    qc.retainActiveQueues(["dev2", "not-exist"]);
    expect(qc.snapshot("dev2").isActive).toBe(false);
  });
});
