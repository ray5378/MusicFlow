// 自动生成 —— 由 index.ts 物理拆分而来（wish 域，3 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  PERM,
  count,
  db,
  permMiddleware,
  uuidv4,
  wishes,
} from "./shared.js";

export function registerWish(app: Hono): void {
app.get("/v1/wish", permMiddleware(PERM.WISH_VIEW), (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "20") || 20));
  const query = (c.req.query("query") || "").trim();
  const status = (c.req.query("status") || "").trim();
  let all = db.select().from(wishes).all();
  if (query) {
    const q = query.toLowerCase();
    all = all.filter(w => (w.songTitle || "").toLowerCase().includes(q) || (w.artist || "").toLowerCase().includes(q));
  }
  if (status) all = all.filter(w => w.status === status);
  const total = all.length;
  const items = all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice((page - 1) * pageSize, page * pageSize);
  return c.json({ total, page, pageSize, items });
});

app.post("/v1/wish", permMiddleware(PERM.WISH_VIEW), async (c) => { const user = c.get("user"); const body = await c.req.json(); const id = uuidv4(); db.insert(wishes).values({ id, userId: user?.id || "", songTitle: body.songTitle, artist: body.artist || "", album: body.album || "", status: "pending" }).run(); return c.json({ id }); });

// Export ALL wishes as "artist songTitle" lines (for copying to import into download tools)

app.get("/v1/wish/export", permMiddleware(PERM.WISH_VIEW), (c) => {
  const all = db.select().from(wishes).all()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const text = all.map(w => [w.artist, w.songTitle].filter(Boolean).join(" ")).filter(Boolean).join("\n");
  return c.json({ text, count: all.length });
});

// ==================== Stats ====================
}
