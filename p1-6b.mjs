// P1#6 真实设备队列全模式复测 v3（order 模式 + 暂停门控确定性）
// 用法: node p1-6b.mjs <peerId>
import process from "node:process";
const BASE = "http://127.0.0.1:46400/rest/api/v1";
const S1="real-song-1",S2="real-song-2",S3="real-song-3",BAD="real-bad-1";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function login(){
  const r=await fetch(`${BASE}/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"admin"})});
  const j=await r.json(); const t=j.token||j.accessToken||j.access_token;
  if(!t){console.error("LOGIN FAIL",r.status,JSON.stringify(j));process.exit(1);} return t;
}
async function api(token,path,opts={},tries=4){
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(`${BASE}${path}`,{...opts,headers:{"content-type":"application/json",authorization:`Bearer ${token}`,...(opts.headers||{})}});
      let b=null; try{b=await r.json();}catch{}
      return{status:r.status,body:b};
    }catch(e){ if(i===tries-1)throw e; await sleep(350); }
  }
}
async function q(token,peer){ return (await api(token,`/peers/${peer}/queue`)).body||{}; }
async function st(token,peer){ return (await api(token,`/peers/${peer}/status`)).body||{}; }
async function playOn(token,peer,id,enq){ return api(token,`/play`,{method:"POST",body:JSON.stringify({peerId:peer,type:"song",id,enqueue:!!enq})}); }
async function ctl(token,peer,op,body){ return api(token,`/peers/${peer}/${op}`,{method:"POST",body:JSON.stringify(body||{})}); }
async function clr(token,peer){ return api(token,`/peers/${peer}/queue`,{method:"DELETE"}); }
async function setMode(token,peer,mode){ return api(token,`/peers/${peer}/play-mode`,{method:"POST",body:JSON.stringify({mode})}); }
async function idxOf(qq){ return qq.currentIndex; }

let pass=0,fail=0;
const report=(name,ok,detail)=>{ console.log(`${ok?"OK  ":"FAIL"} [${name}] ${detail}`); ok?pass++:fail++; };

// 轮询直到 currentIndex 达到 target，每秒采样
async function waitIndex(token,peer,target,label,timeoutMs=15000){
  const t0=Date.now(); let last=null;
  while(Date.now()-t0<timeoutMs){
    const qq=await q(token,peer); const ss=await st(token,peer);
    last={qq,ss};
    console.log(`  t=${((Date.now()-t0)/1000).toFixed(1)}s ${label}: idx=${qq.currentIndex} state=${ss.state} pos=${+(ss.position||0).toFixed(2)} dur=${ss.duration}`);
    if(qq.currentIndex===target) return {ok:true,last,idx:target};
    await sleep(500);
  }
  return {ok:false,last,idx:last?.qq?.currentIndex};
}
// 等 position 前进(确认真在播放),最多 waitMs
async function waitPlaying(token,peer,waitMs=4000){
  const t0=Date.now(); let p0=-1;
  while(Date.now()-t0<waitMs){
    const ss=await st(token,peer);
    const p=+(ss.position||0);
    if(p>p0+0.05 && p>0.1) return {ok:true,p};
    p0=p;
    await sleep(250);
  }
  return {ok:false,p:p0};
}
// 立即读当前 idx(transport op 后调用,playCurrent 已同步设置 currentIndex)
async function getIdx(token,peer){ await sleep(250); return idxOf(await q(token,peer)); }

const peer=process.argv[2];
if(!peer||!peer.startsWith("sendspin:")){console.error("usage: node p1-6b.mjs sendspin:<id>");process.exit(1);}
const token=await login();
console.log("== logged in peer =",peer);

// ---- 重置 ----
console.log("\n=== reset queue (clear) ===");
await ctl(token,peer,"pause").catch(()=>{});
await clr(token,peer); await sleep(800);

// ===================== T1 order 自动下一曲 0->1->2 =====================
console.log("\n=== T1 auto-advance (order) 0->1->2 ===");
await playOn(token,peer,S1); await sleep(800);
await playOn(token,peer,S2,true); await playOn(token,peer,S3,true);
await setMode(token,peer,"order"); await sleep(400);
let qq=await q(token,peer);
console.log("queue:",JSON.stringify({idx:qq.currentIndex,total:qq.total,playMode:qq.playMode,songs:(qq.items||[]).map(i=>i.songId)}));
if(qq.playMode!=="order"){console.error("ABORT: play-mode not order");process.exit(2);}
const a1=await waitIndex(token,peer,1,"T1 wait idx=1");
report("T1 auto order 0->1",a1.ok,`currentIndex=${a1.idx}`);
const a2=await waitIndex(token,peer,2,"T1 wait idx=2");
report("T1 auto order 1->2",a2.ok,`currentIndex=${a2.idx}`);

// ===================== T2 跳过 next/prev（暂停门控，确定性） =====================
console.log("\n=== T2 skip next/prev (pause-gated, 3-song queue) ===");
await ctl(token,peer,"pause").catch(()=>{});
await clr(token,peer); await sleep(600);
await playOn(token,peer,S1); await sleep(500);
await playOn(token,peer,S2,true); await playOn(token,peer,S3,true);
await setMode(token,peer,"order"); await sleep(300);
await waitPlaying(token,peer,4000);      // 确认在播
await ctl(token,peer,"pause");           // 冻结,阻止自然 auto-advance 干扰
await sleep(400);
let i0=await getIdx(token,peer);
let out=[];
async function step(op){
  await ctl(token,peer,op);
  await ctl(token,peer,"pause");
  await sleep(250);
  return await getIdx(token,peer);
}
const n1=await step("next"); out.push(`next->${n1}`);
report("T2 /next 0->1",n1===1,`idx0=${i0} -> idx1=${n1}`);
const n2=await step("next"); out.push(`next->${n2}`);
report("T2 /next 1->2",n2===2,`-> idx2=${n2}`);
const p1=await step("prev"); out.push(`prev->${p1}`);
report("T2 /prev 2->1",p1===1,`-> idx1=${p1}`);
const p0=await step("prev"); out.push(`prev->${p0}`);
report("T2 /prev 1->0",p0===0,`-> idx0=${p0}`);
console.log("  seq:",out.join(" "));

// ===================== T3 暂停/恢复（音频流用 position 判定） =====================
console.log("\n=== T3 pause/resume (position flow) ===");
await ctl(token,peer,"play"); // 恢复播放
const wp=await waitPlaying(token,peer,4000);
if(!wp.ok){report("T3 pre: playing",false,"not advancing");}
else{
  await ctl(token,peer,"pause"); await sleep(1000);
  let s1=await st(token,peer), p1=+(s1.position||0);
  await sleep(2200);
  let s2=await st(token,peer), p2=+(s2.position||0);
  const froze = Math.abs(p2-p1)<0.25 && p1>0;
  report("T3 pause freezes position",froze,`p1=${p1} p2=${p2} (Δ=${Math.abs(p2-p1).toFixed(2)})`);
  await ctl(token,peer,"play"); await sleep(1500);
  let p3=+(await st(token,peer)).position||0;
  report("T3 resume advances position",p3>p2+0.1,`p2=${p2} -> p3=${p3}`);
}

// ===================== T4 seek（秒） =====================
console.log("\n=== T4 seek to 1.5s ===");
await ctl(token,peer,"play"); await waitPlaying(token,peer,3000).catch(()=>{});
await ctl(token,peer,"seek",{seconds:1.5}); await sleep(700);
let ss4=await st(token,peer);
report("T4 seek lands ~1.5s",Math.abs((ss4.position||0)-1.5)<1.2,`pos=${(ss4.position||0).toFixed(2)} dur=${ss4.duration} state=${ss4.state}`);

// ===================== T5 换源回退:坏源在队列中间,自动切歌时跳过不卡死 =====================
console.log("\n=== T5 bad-source mid-queue failover auto-skip ===");
await ctl(token,peer,"pause").catch(()=>{});
await clr(token,peer); await sleep(600);
await playOn(token,peer,S1); await sleep(500);
await playOn(token,peer,BAD,true); await playOn(token,peer,S2,true);
await setMode(token,peer,"order"); await sleep(300);
qq=await q(token,peer);
const badIdx=qq.items.findIndex(i=>i.songId===BAD);
console.log("queue:",JSON.stringify({idx:qq.currentIndex,total:qq.total,playMode:qq.playMode,badAt:badIdx,songs:(qq.items||[]).map(i=>i.songId)}));
report("T5 queue [s,bad,s] built",badIdx===1,`bad at index ${badIdx}`);
// 自动切歌:S1(3s) → 应跳过 bad(idx1) → 到达 S2(idx2),不卡死
const t5=await waitIndex(token,peer,2,"T5 auto-skip bad -> idx2",20000);
report("T5 auto-skip bad source (no hang)",t5.ok && badIdx !== t5.idx,`finalIdx=${t5.idx} badAt=${badIdx} reached=${t5.ok}`);

console.log(`\n===== PASS=${pass} FAIL=${fail} =====`);