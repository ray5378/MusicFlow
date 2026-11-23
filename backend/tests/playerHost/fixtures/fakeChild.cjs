// 测试用假子进程：按协议回 ready/pong/status；MF_FIXTURE_HANG_AFTER_MS 之后不再响应
const hangAfter = Number(process.env.MF_FIXTURE_HANG_AFTER_MS || 0);
let hung = false;
const t0 = Date.now();
const send = (m) => process.send && process.send(m);
process.on('message', (m) => {
  if (m && m.t === 'ping') {
    if (!hung) send({ t: 'pong', at: m.at });
  }
  if (m && m.t === 'stop') { send({ t: 'ended', reason: 'stop' }); process.exit(0); }
});
setInterval(() => {
  if (hangAfter && Date.now() - t0 > hangAfter) { hung = true; return; }
  if (!hung) send({ t: 'status', gen: 1, state: 'live', queueMs: 1, inQueueMs: 2, underruns: 0, lastUnderrunMs: 0, watermarkUs: 0, framesOut: 1 });
}, 100);
send({ t: 'ready', pid: process.pid });
