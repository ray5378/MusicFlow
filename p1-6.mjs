// P1#6 真实设备队列全模式复测编排器（对接真实 aiosendspin 玩家）
// 用法: node p1-6.mjs <peerId>   (peerId 形如 sendspin:<clientId>)
import process from "node:process";

const BASE = "http://127.0.0.1:46400/rest/api/v1";
const SONG1 = "real-song-1", SONG2 = "real-song-2", SONG3 = "real-song-3", BAD = "real-bad-1";

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  const j = await r.json();
  const token = j.token || j.accessToken || j.access_token;
  if (!token) { console.error("LOGIN FAIL:", r.status, JSON.stringify(j)); process.exit(1); }
  return token;
}

async function api(token, path, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        ...opts,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      });
      let body = null;
      try { body = await r.json(); } catch {}
      return { status: r.status, body };
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400);
    }
  }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function status(token, peer) {
  const { body } = await api(token, `/peers/${peer}/status`);
  return body || {};
}
async function queue(token, peer) {
  const { body } = await api(token, `/peers/${peer}/queue`);
  return body || {};
}
async function playOn(token, peer, songId, enqueue) {
  return api(token, `/play`, {
    method: "POST", body: JSON.stringify({ peerId: peer, type: "song", id: songId, enqueue: !!enqueue }),
  });
}
async function ctl(token, peer, op, body) {
  return api(token, `/peers/${peer}/${op}`, { method: "POST", body: JSON.stringify(body || {}) });
}

// 等待队列 currentIndex 变为某值(或具体状态)出现,并连续采样状态判断是否推进
async function waitIndex(token, peer, targetIdx, timeoutMs = 9000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const q = await queue(token, peer);
    const idx = q.currentIndex;
    const st = await status(token, peer);
    last = { idx, state: st.state, position: st.position, duration: st.duration };
    if (idx === targetIdx) return { ok: true, last };
    await sleep(350);
  }
  return { ok: false, last };
}

async function readQueueTitles(token, peer) {
  const q = await queue(token, peer);
  return { currentIndex: q.currentIndex, state: q.state, playMode: q.playMode, isActive: q.isActive, total: q.total, songs: (q.items || []).map(i => i.songId) };
}

const peer = process.argv[2];
if (!peer || !peer.startsWith("sendspin:")) { console.error("usage: node p1-6.mjs sendspin:<clientId>"); process.exit(1); }

const token = await login();
console.log("== logged in, peer =", peer);
const banner = readQueueTitles; // noop marker

// ---------- 建 3 曲队列 ----------
console.log("\n=== build queue: play song1 + enqueue song2 + enqueue song3 ===");
let r = await playOn(token, peer, SONG1); console.log("play song1 ->", r.status, JSON.stringify(r.body));
await sleep(1200);
r = await playOn(token, peer, SONG2, true); console.log("enqueue song2 ->", r.status, JSON.stringify(r.body));
r = await playOn(token, peer, SONG3, true); console.log("enqueue song3 ->", r.status, JSON.stringify(r.body));
console.log("queue now:", JSON.stringify(await readQueueTitles(token, peer)));

// ---------- T1 自动下一曲 (0→1→2) ----------
console.log("\n=== T1 auto-advance: expect currentIndex 0->1->2 ===");
for (const target of [1, 2]) {
  const w = await waitIndex(token, peer, target);
  console.log(`auto -> currentIndex ${target}:`, JSON.stringify(w.ok ? { ok: true } : w), "at", JSON.stringify(w.last));
}

// ---------- T2 跳到第一首,测 next/prev ----------
console.log("\n=== T2 skip: play song1 fresh, then /next then /prev ===");
r = await playOn(token, peer, SONG1); console.log("replay song1 ->", r.status);
await sleep(800);
let q = await queue(token, peer);
console.log("start idx:", q.currentIndex, "state:", (await status(token, peer)).state);
r = await ctl(token, peer, "next"); console.log("/next ->", r.status);
await sleep(700);
q = await queue(token, peer); console.log("after /next idx:", q.currentIndex, "expected", q.currentIndex === 1 ? "OK" : "FAIL");
r = await ctl(token, peer, "prev"); console.log("/prev ->", r.status);
await sleep(700);
q = await queue(token, peer); console.log("after /prev idx:", q.currentIndex, "expected", q.currentIndex === 0 ? "OK" : "FAIL");

// ---------- T3 pause/resume ----------
console.log("\n=== T3 pause / resume ===");
r = await ctl(token, peer, "pause"); console.log("/pause ->", r.status);
await sleep(900);
let st = await status(token, peer); console.log("after pause state:", st.state, "position:", st.position, "expected PAUSED_PLAYBACK/PAUSED:", /PAUSED/.test(st.state) ? "OK" : "FAIL");
r = await ctl(token, peer, "play"); console.log("/play(resume) ->", r.status);
await sleep(1000);
st = await status(token, peer); console.log("after resume state:", st.state, "expected PLAYING:", st.state === "PLAYING" ? "OK" : "FAIL");

// ---------- T4 seek ----------
console.log("\n=== T4 seek to 1.5s ===");
r = await ctl(token, peer, "seek", { seconds: 1.5 }); console.log("/seek 1.5 ->", r.status);
await sleep(800);
st = await status(token, peer);
const near15 = Math.abs((st.position || 0) - 1500) < 900;
console.log("after seek position:", st.position, "duration:", st.duration, "expected ~1500:", near15 ? "OK" : "FAIL");

// ---------- T5 failover: 追加坏源,播完当前后应跳过而非卡死 ----------
console.log("\n=== T5 source failover: enqueue real-bad-1 (404 url), expect no hang ===");
r = await playOn(token, peer, BAD, true); console.log("enqueue bad ->", r.status);
await sleep(500);
console.log("queue now:", JSON.stringify(await readQueueTitles(token, peer)));
let idx0 = (await queue(token, peer)).currentIndex;
console.log("tracking from idx", idx0, "for ~7s (bad track ~3s should fail & skip, not freeze)");
const t0 = Date.now();
let stalled = null;
let idxNow = idx0;
while (Date.now() - t0 < 7000) {
  await sleep(500);
  const qq = await queue(token, peer);
  const ss = await status(token, peer);
  idxNow = qq.currentIndex;
  console.log(`  t=${(Date.now()-t0)/1000 |0}s idx=${qq.currentIndex} state=${ss.state} pos=${ss.position}`);
  stalled = ss;
}
const advanced = idxNow > idx0;
console.log("bad track skipped/de-advanced:", advanced ? "OK (no hang)" : "CHECK (may be stuck on bad)");

console.log("\n=== DONE ===");