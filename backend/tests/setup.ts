// 每个测试文件运行在独立的 fork 进程(见 vitest.config.ts pool:"forks"),
// 本 setup 文件会在每个测试文件前执行一次。这里为每个文件分配独立的 DATA_DIR,
// 使各文件使用各自的 SQLite 库,彻底消除跨文件数据残留导致的顺序/运行次数耦合
// (曾因共享 /tmp/musicflow-test-data 残留的 "Song Four" 行,掩盖
//  playlistImport.incremental 的索引缓存缺陷,CI 全新环境才暴露)。
//
// 同时调用 initDatabase() 建全量 schema:此前各测试文件靠共享库"捡"其他文件
// 创建的表(如 songs / settings),隔离后必须每文件自带 schema,否则
// 查询 songs / setSetting 等会报 "no such table"。initDatabase 是纯幂等 DDL。
// 注意:必须用动态 import 加载 db——ESM 静态 import 会被提升到模块最前求值,
// 那时 DATA_DIR 尚未设置,db 会落到 cwd/data(生产库),并因并行 fork 争用同一
// 文件产生 SQLITE_BUSY。
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const dir = path.join(os.tmpdir(), "mf-test-data", `t-${process.pid}-${randomUUID().slice(0, 8)}`);
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;
const { initDatabase } = await import("../src/db/index.js");
initDatabase();
