// 本播放端的「临时端 ID」。
//
// 作用:让服务端把同一账号下多个播放端(网页 / 桌面客户端 / 手机客户端)的播放
// 队列隔离开,谁也不会覆盖谁。它**只是服务端内部用来区分实体的值**:不会出现在
// 任何界面上,也不会出现在服务端返回的任何字段里(服务端对外一律只呈现打码后的
// 实例键 local:<userId>:<instanceKey>)—— 对本前端来说是一个完全透明的内部常量。
//
// 用 localStorage(**按浏览器持久化**,而不是按标签页):这一点是 Web 播放器自身的改名/隐藏偏好
// 能**保住**、且同账号多客户端队列互不覆盖的前提 —— 服务端把偏好按「实例键」存储,而实例键 =
// H(账号 + 这个 ID)。ID 一旦在关掉标签页后重新生成,实例键就变了,之前起的名、拨过的
// 隐藏开关全部对不上,表现为「设置一刷新就没了」。
// 因此该 ID 必须跨会话稳定:同一浏览器 = 同一个 Web 播放器实例(多标签页共享同一条
// 本机播放队列,这也是更符合直觉的语义)。关掉后服务端那条队列会在 6 小时静默回收,
// 下次打开复用同一个 ID 重新注册即可。
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

/** 取本播放端的临时端 ID,首次调用时生成并持久化(跨会话稳定)。 */
export function getClientId(): string {
  if (cached) return cached;
  try {
    // 兼容迁移:早期版本把它存在 sessionStorage(按标签页),读到时提升到 localStorage。
    const saved = localStorage.getItem(KEY)
      || (typeof sessionStorage !== "undefined" ? sessionStorage.getItem(KEY) : null);
    if (saved && VALID.test(saved)) {
      cached = saved;
      localStorage.setItem(KEY, cached);
      return cached;
    }
    cached = `web-${randomId()}`;
    localStorage.setItem(KEY, cached);
  } catch {
    // 隐私模式等 localStorage 不可用:退回会话内随机(改名/隐藏无法跨会话保持,但不出错)。
    cached = `web-${randomId()}`;
  }
  return cached;
}
