// 每个测试文件运行在 setup 阶段(见 vitest.config.ts poolOptions.forks.singleFork)。
// 这里为每个测试文件分配独立的 DATA_DIR,使各文件使用各自的 SQLite 库,彻底消除跨文件
// 数据残留导致的顺序/运行次数耦合(曾因共享 /tmp/musicflow-test-data 残留的 "Song Four"
// 行,掩盖 playlistImport.incremental 的索引缓存缺陷,CI 全新环境才暴露)。
//
// 注意:此前用 process.pid 作为目录键之一(singleFork 之外每文件独立 fork 进程 pid 唯一);
// 现改为纯 randomUUID 作为统一区分键——singleFork 下全部文件跑在同一 fork 进程里,
// pid 恒定,必须换成随机键才能保证每个测试文件仍拿到独立库。
//
// 同时调用 initDatabase() 建全量 schema:此前各测试文件靠共享库"捡"其他文件
// 创建的表(如 songs / settings),隔离后必须每文件自带 schema,否则
// 查询 songs / setSetting 等会报 "no such table"。initDatabase 是纯幂等 DDL。
// 注意:必须用动态 import 加载 db——ESM 静态 import 会被提升到模块最前求值,
// 那时 DATA_DIR 尚未设置,db 会落到 cwd/data(生产库),并因并发 fork 争用同一
// 文件产生 SQLITE_BUSY。
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

// ---- 陈旧测试数据目录清扫(housekeeping,Phase 5)----
// 每个测试文件都在 mf-test-data 下留一个 t-<uuid> 目录;长期不清会在 CI/开发机上
// 无界堆积(230 实测堆到 13GB → ENOSPC 打满磁盘)。这里在 setup 阶段顺手清扫
// mtime 超过 6h 的陈旧目录:正在运行的会话(刚创建/mtime 新鲜)绝不受影响,
// 跨进程并发(forks)也安全 —— 只删「6 小时没人碰过」的目录。
const dataRoot = path.join(os.tmpdir(), "mf-test-data");
try {
  for (const e of fs.readdirSync(dataRoot)) {
    if (!e.startsWith("t-")) continue;
    const p = path.join(dataRoot, e);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3_600_000) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* 单目录失败忽略(可能正被并发使用) */ }
  }
} catch { /* 根目录不存在 = 无残留 */ }

const dir = path.join(dataRoot, `t-${randomUUID()}`);
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;
const { initDatabase } = await import("../src/db/index.js");
initDatabase();
