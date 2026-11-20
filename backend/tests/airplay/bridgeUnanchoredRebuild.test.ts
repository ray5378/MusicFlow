// 空壳桥会话重建回归锁（A 自检 + B 设备上线触发），2026-11-20
//
// 现场（240 实测 11-20 09:37）：设备离线时 prepare 建出 connected 却无 anchor 的"空壳"，
// 之后每次换代都 warm-reuse 它 ⇒ 同 token 复用 8 小时、全程 0 条 `bridge first packet`、
// 内容按 14s/次 overflow 丢弃、设备整首静音、只有重启容器才能恢复。
// 这两条锁的是"空壳必须能被自动重建"，删掉任何一条都会让该故障复发且无日志。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AIR = fileURLToPath(new URL("../../src/services/airplay", import.meta.url));
const GRP = fileURLToPath(new URL("../../src/services/group", import.meta.url));
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

const bs = () => read(AIR, "bridgeSession.ts");
const cm = () => read(AIR, "childMain.ts");
const ct = () => read(AIR, "control.ts");
const pp = () => read(GRP, "protocolPlayer.ts");

describe("空壳会话判据（有内容在投却始终无 anchor）", () => {
  it("门槛常量存在", () => {
    const s = bs();
    expect(s).toContain("const BRIDGE_UNANCHORED_REBUILD_MS = 25_000;");
    expect(s).toContain("const BRIDGE_UNANCHORED_ONLINE_GRACE_MS = 5_000;");
  });

  it("★判据必须要求 backlog > 0 —— 否则正常起播（还没内容）会被误判成空壳", () => {
    const s = bs();
    const i = s.indexOf("private isUnanchoredShell(");
    expect(i).toBeGreaterThan(0);
    const body = s.slice(i, i + 1400);
    expect(body).toContain("this.anchorUs !== null) return false");
    expect(body).toContain("this.backlogMs() <= 0) return false");
    expect(body).toContain("this.raopReconnectInFlight || this.raopReconnectTimer !== null");
  });

  it("重建走 reconnectRaop（显式 TEARDOWN + 新 RECORD），并留下可 grep 的日志", () => {
    const s = bs();
    expect(s).toContain('ev: "unanchored-rebuild"');
    expect(s).toContain("this.scheduleRaopReconnect(`unanchored(${reason})`)");
  });

  it("A：每 2s 的 stats tick 里自检（不依赖设备上线事件）", () => {
    expect(bs()).toContain('this.reanchorIfUnanchored(0, "tick")');
  });
});

describe("暖复用必须挡住空壳", () => {
  it("warmReusable 对超时未锚定者返回 false", () => {
    const s = bs();
    const i = s.indexOf("get warmReusable()");
    expect(i).toBeGreaterThan(0);
    const body = s.slice(i, i + 700);
    expect(body).toContain("this.anchorUs === null");
    expect(body).toContain("Date.now() - this.createdAtMs > BRIDGE_UNANCHORED_REBUILD_MS");
  });

  it("prepare 拆旧建新时记录拒绝原因（否则现场看起来只是每次都重建）", () => {
    expect(bs()).toContain("sessions: warm-reuse 拒绝");
  });
});

describe("B：设备上线事件触发重建", () => {
  it("子进程有 bridgeReanchor op，并带宽限（刚 prepare 的不要当场重建）", () => {
    const s = cm();
    expect(s).toContain('case "bridgeReanchor"');
    expect(s).toContain("reanchorUnanchored(");
    expect(s).toContain("5_000,");
  });

  it("主进程封装 bridgeReanchorDevice（走现有 rpc 通道，幂等）", () => {
    const s = ct();
    expect(s).toContain("export async function bridgeReanchorDevice");
    expect(s).toContain('airplaySupervisor.rpc<boolean>("bridgeReanchor"');
  });

  it("★notifyAirplayDeviceOnline 的「已在路由内」分支必须尝试重建（这是本次的缺口）", () => {
    const s = pp();
    const i = s.indexOf("activeBridgeRoutes.get(g.id)?.some((r) => r.deviceId === deviceId)");
    expect(i).toBeGreaterThan(0);
    const body = s.slice(i, i + 900);
    expect(body).toContain("bridgeReanchorDevice(deviceId)");
    expect(body).toContain("continue;");
    // 不能回退成"直接 continue"（那正是空壳永不被替换的原因）
    expect(body).not.toContain("continue; // 已在路由内");
  });
});
