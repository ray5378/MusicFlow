// 本播放端的「临时端 ID」。
//
// 作用:让服务端把同一账号下多个播放端(多个标签页 / 网页 + 桌面客户端)的播放
// 队列隔离开,谁也不会覆盖谁。它**只是服务端内部用来区分实体的值**:不会出现在
// 任何界面上,也不会出现在服务端返回的任何字段里(服务端对外一律只呈现
// local:<userId>)—— 对本前端来说是一个完全透明的内部常量。
//
// 用 sessionStorage(按标签页):同一浏览器的多个标签页各算一个独立播放端,互不
// 干扰;刷新页面仍然复用同一个 ID,所以刷新后队列照常恢复。关掉标签页后服务端那条
// 队列会在 6 小时静默回收;下次打开是新端,队列由本前端的本地存储恢复并重新上报。
const KEY = "mf_client_id";
const VALID = /^[A-Za-z0-9_-]{1,32}$/;

function randomId(): string {
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return Math.random().toString(36).slice(2, 14).padEnd(12, "0");
  }
}

let cached = "";

/** 取本标签页的临时端 ID,首次调用时生成并持久化。 */
export function getClientId(): string {
  if (cached) return cached;
  try {
    const saved = sessionStorage.getItem(KEY);
    if (saved && VALID.test(saved)) {
      cached = saved;
      return cached;
    }
    cached = `web-${randomId()}`;
    sessionStorage.setItem(KEY, cached);
  } catch {
    cached = `web-${randomId()}`;
  }
  return cached;
}
