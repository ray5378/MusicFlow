// ==================== 混合组切歌等待按组可配（v4.8.6） ====================
//
// 用户痛点：混合组（桥 + 直连成员并存）切歌前全组静默 ~5s —— 那是混合组锚点 lead
// （BRIDGE_MIXED_GROUP_ANCHOR_LEAD_US，v4.7.6 真机定标：低于接收端就绪窗口必吞开头），
// 过去是全局常量，无法按组调。本版改为 `player_groups.mixed_anchor_lead_ms` 组级覆盖。
//
// 语义铁律：
//   ① 0 或 NULL = **自动**（全局默认 5000ms）；>0 = 用户值；负数 = 钳到 0（无物理意义）。
//   ② 只影响混合组分支；纯桥组深锚 / 非桥分支零改动（垫片组值手动口已删 v4.9.1）。
//   ③ 🔴 子进程实时性：消费点在 Sendspin fork 子进程（streamEngine 重锚分支），而
//      delayCalib 的 cache 是懒加载 + 写时更新、**无失效广播**（写在主进程）⇒ 子进程
//      一旦读过一次 cache 就固化。所以消费点 `mixedAnchorLeadUsOf` **必须绕过 cache
//      直查 db**（读频率 = 每次重锚一次，性能无忧）—— 本文件用「直接改库」复现
//      「主进程写库、子进程 cache 陈旧」的场景钉死这一点。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users, playerGroups } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { generateToken } from "../../src/utils/auth.js";
import { getGroupManager } from "../../src/services/group/index.js";
import {
  MIXED_ANCHOR_LEAD_MAX_MS,
  MIXED_ANCHOR_LEAD_STEP_MS,
  clampMixedAnchorLeadMs,
  getMixedAnchorLeadMs,
  invalidateGroupDelays,
  mixedAnchorLeadUsOf,
  setMixedAnchorLeadMs,
} from "../../src/services/group/delayCalib.js";

const GID = "g-mixed-1";

// ---------------- delayCalib 单测 ----------------

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  db.delete(playerGroups).run();
  invalidateGroupDelays(GID);
  db.insert(playerGroups)
    .values({ id: GID, name: "客厅组", memberIds: JSON.stringify(["airplay:hivi", "sendspin:esp1"]) })
    .run();
});

describe("clampMixedAnchorLeadMs（0~30000，负数归自动）", () => {
  it("范围内原样返回并取整；常量 30000 / 100（前端 input-number 用）", () => {
    expect(clampMixedAnchorLeadMs(0)).toBe(0);
    expect(clampMixedAnchorLeadMs(1500)).toBe(1500);
    expect(clampMixedAnchorLeadMs(12.6)).toBe(13);
    expect(MIXED_ANCHOR_LEAD_MAX_MS).toBe(30000);
    expect(MIXED_ANCHOR_LEAD_STEP_MS).toBe(100);
  });

  it("越界钳到 30000；负数/非数字 → 0（= 自动，不报错）", () => {
    expect(clampMixedAnchorLeadMs(999999)).toBe(MIXED_ANCHOR_LEAD_MAX_MS);
    expect(clampMixedAnchorLeadMs(-1)).toBe(0);
    expect(clampMixedAnchorLeadMs(-99999)).toBe(0);
    expect(clampMixedAnchorLeadMs(undefined)).toBe(0);
    expect(clampMixedAnchorLeadMs(null)).toBe(0);
    expect(clampMixedAnchorLeadMs("abc")).toBe(0);
    expect(clampMixedAnchorLeadMs(NaN)).toBe(0);
  });
});

describe("getMixedAnchorLeadMs / setMixedAnchorLeadMs（组级往返）", () => {
  it("新组默认 0（= 自动，不是某个写死的覆盖值）", () => {
    expect(getMixedAnchorLeadMs(GID)).toBe(0);
    expect(getMixedAnchorLeadMs(undefined)).toBe(0);
    expect(getMixedAnchorLeadMs(null)).toBe(0);
  });

  it("写入后立即读到（内存先更新）；越界写入被钳制后回读一致", () => {
    expect(setMixedAnchorLeadMs(GID, 2500)).toBe(2500);
    expect(getMixedAnchorLeadMs(GID)).toBe(2500);
    expect(setMixedAnchorLeadMs(GID, 999999)).toBe(MIXED_ANCHOR_LEAD_MAX_MS);
    expect(getMixedAnchorLeadMs(GID)).toBe(MIXED_ANCHOR_LEAD_MAX_MS);
  });

  it("落库成功：清缓存后仍读到新值（不是只活在内存里）", () => {
    setMixedAnchorLeadMs(GID, 1200);
    invalidateGroupDelays(GID);
    expect(getMixedAnchorLeadMs(GID)).toBe(1200);
  });

  it("与既有成员延迟互不干扰（各写各的列）；v4.9.1 起垫片组值列已由迁移 DROP", () => {
    setMixedAnchorLeadMs(GID, 3000);
    expect(getMixedAnchorLeadMs(GID)).toBe(3000);
    // 成员格子没有被顺带改写
    const row = db.select().from(playerGroups).where(eq(playerGroups.id, GID)).get() as any;
    expect(row.memberDelaysJson).toBe("{}");
    // 旧手动口 track_switch_lead_ms 已被幂等迁移删除(防复活:列必须不在)
    const cols = (db as any).all(sql`SELECT name FROM pragma_table_info('player_groups')`) as Array<{ name: string }>;
    expect(cols.some((c: { name: string }) => c.name === "track_switch_lead_ms")).toBe(false);
  });
});

describe("mixedAnchorLeadUsOf（子进程消费点，µs）", () => {
  it("组值 0/未设 ⇒ null（= 自动，调用方回退全局默认常量）", () => {
    expect(mixedAnchorLeadUsOf(`ug:${GID}`)).toBeNull();
    setMixedAnchorLeadMs(GID, 0); // 显式 0 也是自动
    expect(mixedAnchorLeadUsOf(`ug:${GID}`)).toBeNull();
  });

  it("组值 >0 ⇒ ms*1000（µs，number 型 —— 消费点 Math.max 全是 number µs）", () => {
    setMixedAnchorLeadMs(GID, 2500);
    expect(mixedAnchorLeadUsOf(`ug:${GID}`)).toBe(2_500_000);
  });

  it("非 ug: 组名（设备组/桩）与空 id ⇒ null（无组级配置，回退全局默认）", () => {
    expect(mixedAnchorLeadUsOf("esp1")).toBeNull();
    expect(mixedAnchorLeadUsOf("ug:")).toBeNull();
    expect(mixedAnchorLeadUsOf("")).toBeNull();
  });

  it("组不存在 ⇒ null（不抛，回退自动）", () => {
    expect(mixedAnchorLeadUsOf("ug:no-such-group")).toBeNull();
  });

  it("🔴 子进程实时性：另一进程直改库后，消费点立即读到新值（绕过 cache 直查）", () => {
    setMixedAnchorLeadMs(GID, 8000);
    expect(mixedAnchorLeadUsOf(`ug:${GID}`)).toBe(8_000_000);
    // 模拟「主进程写库、子进程 cache 陈旧」：绕过 setMixedAnchorLeadMs 的内存更新直接改库。
    // 子进程场景里，主进程 PUT 落库后子进程收不到任何失效通知 —— cache 只会停留在旧值。
    db.update(playerGroups).set({ mixedAnchorLeadMs: 1500 }).where(eq(playerGroups.id, GID)).run();
    // 消费点（直查 db）立刻看到新值 ⇒ PUT 后下一首切歌即生效，无需重启/重建。
    expect(mixedAnchorLeadUsOf(`ug:${GID}`)).toBe(1_500_000);
    // cache 口仍是旧值 —— 这正是消费点**必须**绕过它的原因。
    expect(getMixedAnchorLeadMs(GID)).toBe(8000);
  });
});

// ---------------- API（GET/PUT /v1/groups/:id/delays） ----------------

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

function seedAdmin(): string {
  const id = uuidv4();
  db.insert(users)
    .values({
      id,
      username: `adm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword("pw"),
      isAdmin: 1,
      isActive: 1,
      email: "",
    })
    .run();
  return id;
}

function adminHeaders(uid: string): Record<string, string> {
  const token = generateToken(uid, "tester", true);
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function seedGroup(uid: string): string {
  const id = `g-${uuidv4()}`;
  db.insert(playerGroups)
    .values({ id, name: "混合组", memberIds: JSON.stringify(["airplay:hivi", "sendspin:esp1"]), ownerUserId: uid })
    .run();
  invalidateGroupDelays(id);
  getGroupManager().loadFromDb(); // 单例内存表看到新行,否则 gm.get 拿不到
  return id;
}

function putDelays(id: string, headers: Record<string, string>, body: Record<string, unknown>) {
  return app.request(`/rest/api/v1/groups/${id}/delays`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

describe("API /v1/groups/:id/delays 收发 mixedAnchorLeadMs", () => {
  it("GET 带上 mixedAnchorLeadMs + 前端渲染常量（step/max）", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const res = await app.request(`/rest/api/v1/groups/${id}/delays`, { headers: adminHeaders(uid) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.mixedAnchorLeadMs).toBe(0);
    expect(body.mixedAnchorLeadStepMs).toBe(MIXED_ANCHOR_LEAD_STEP_MS);
    expect(body.mixedAnchorLeadMaxMs).toBe(MIXED_ANCHOR_LEAD_MAX_MS);
  });

  it("PUT 写入 → 响应即回显 → 再 GET 一致（保存后弹窗徽标免重拉）", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const headers = adminHeaders(uid);
    const put = await putDelays(id, headers, { mixedAnchorLeadMs: 2500 });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as any;
    expect(saved.mixedAnchorLeadMs).toBe(2500);
    const get = await app.request(`/rest/api/v1/groups/${id}/delays`, { headers });
    expect(((await get.json()) as any).mixedAnchorLeadMs).toBe(2500);
  });

  it("PUT 越界被钳到 30000；0 = 自动；不改成员表（memberId 缺省不动成员格子）", async () => {
    const uid = seedAdmin();
    const id = seedGroup(uid);
    const headers = adminHeaders(uid);
    const r1 = await putDelays(id, headers, { mixedAnchorLeadMs: 999999 });
    expect(((await r1.json()) as any).mixedAnchorLeadMs).toBe(MIXED_ANCHOR_LEAD_MAX_MS);
    const r2 = await putDelays(id, headers, { mixedAnchorLeadMs: 0 });
    expect(((await r2.json()) as any).mixedAnchorLeadMs).toBe(0);
    const get = await app.request(`/rest/api/v1/groups/${id}/delays`, { headers });
    const body = (await get.json()) as any;
    expect(body.memberDelays).toEqual({});
    expect(body.mixedAnchorLeadMs).toBe(0);
  });

  it("组不存在 → GET/PUT 404（不存在的 id 不得拿到 200/空表）", async () => {
    const uid = seedAdmin();
    const headers = adminHeaders(uid);
    const g = await app.request("/rest/api/v1/groups/no-such-group/delays", { headers });
    expect(g.status).toBe(404);
    const p = await putDelays("no-such-group", headers, { mixedAnchorLeadMs: 1000 });
    expect(p.status).toBe(404);
  });
});
