// ==================== controller@v1 role ====================
//
// 客户端经 `client/command.controller` 控制当前组。命令一致性校验 + 映射到
// 复用层动作(QueueController / 组音量算法)。出站 `server/state.controller` 在
// server.ts / group.ts 编排,这里提供纯函数 `mapControllerCommand`(可单测)。
import { BaseRole } from "./base.js";

export type Cmd = Record<string, any>;

const REQUIRED_FIELDS: Record<string, string> = {
  volume: "volume",
  mute: "muted",
  seek: "position_ms",
  seek_relative: "offset_ms",
};

export function mapControllerCommand(cmd: Cmd): { k: string; v?: any } {
  const cmdName = cmd.command;
  if (typeof cmdName !== "string" || cmdName.length === 0) {
    throw new Error("controller command requires a command name");
  }
  const req = REQUIRED_FIELDS[cmdName];
  if (req && !(req in cmd)) throw new Error(`${cmdName} requires ${req}`);
  if (cmdName === "seek") {
    const p = cmd.position_ms;
    const max = cmd.seek_max ?? Infinity;
    if (typeof p !== "number" || p < 0 || p > max) throw new Error("bad seek position");
  }
  if (cmdName === "seek_relative") {
    const o = cmd.offset_ms;
    if (typeof o !== "number") throw new Error("bad seek offset");
  }
  return { k: cmdName, v: req !== undefined ? cmd[req] : undefined };
}

export class ControllerRole extends BaseRole {
  constructor(client: any) {
    super("controller@v1", client);
  }
}

export function createControllerRole(client: any): ControllerRole {
  return new ControllerRole(client);
}