// ==================== AirPlay 运行模式(leaf,零依赖) ====================
//
//  - MUSICFLOW_AIRPLAY_CHILD=1:自身就是 airplay 子进程 → 装配推流运行时本体;
//  - MUSICFLOW_AIRPLAY_INPROC=1 或 vitest:主进程内装配(排障回落,免 fork);
//  - MUSICFLOW_AIRPLAY_FORK=1:显式开启把推流会话 fork 到专属子进程;
//  - 其余(生产主进程):**默认 fork**(与 sendspin 对齐)。
//
// 2026-10-22 翻默认值:此前为了先在开发机把能力就位,默认留在 in-proc;真机暴露了
// 主进程事件循环被前端请求/批量任务占住时 RTP 7.98ms 节拍被打散(reanchors 抬升、
// maxGap 达 2s,听感断音)。子进程路径的 cast/seek RPC 挂死(旧连接 close 不 reject)
// 与收尾无上限问题已在本版修复并真机回归,故默认改为 fork。
// 排障需要回主进程时置 MUSICFLOW_AIRPLAY_INPROC=1。
import { isRendererForkMode } from "../rendererHost/mode.js";

export function isAirPlayForkMode(): boolean {
  return isRendererForkMode({
    childEnv: "MUSICFLOW_AIRPLAY_CHILD",
    inprocEnv: "MUSICFLOW_AIRPLAY_INPROC",
    forkEnv: "MUSICFLOW_AIRPLAY_FORK",
    defaultFork: true,
  });
}
