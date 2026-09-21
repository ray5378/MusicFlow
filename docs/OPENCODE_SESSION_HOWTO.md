# 如何查看 opencode 的对话内容

> 用途:在跑着 opencode 的开发机(或容器)上,把某个会话的**对话正文 / 工具调用 / 用户指令流**
> 取出来看或落成文本。踩过的坑记在下面 —— 照着做能少走一小时弯路。
>
> 配套脚本:`scripts/opencode-session-dump.py`(零依赖,只读)。

---

## 0. 结论先行

**想看对话内容 → 直接读 SQLite,不要指望浏览器。**
`opencode web` 的根路径只是 SPA 空壳,会话详情走的是 JSON API;而**对话正文根本不在
`message` 表里**,在 `part` 表。三条路径的对照:

| 你以为的路径 | 实际行为 |
|---|---|
| 浏览器打开 `http://<host>:4096/session/<sid>` | 返回**纯 JSON**(API 响应),不是界面 |
| 浏览器打开 `http://<host>:4096/` | SPA 空壳,自己拉"最近会话"列表,deep-link 进不去指定会话 |
| `sqlite3 opencode.db` 读 `message` 表 | 只有元信息(role/finish/时间),**没有正文** |
| **读 `part` 表(本文件第 2 节)** | ✅ 正文 / 思考 / 工具调用参数与输出,全在这里 |

为什么会这样:opencode 的 web 端按 `Accept` 头分流 —— 带 `text/html` 才给 SPA,
否则按 API 处理;而会话数据由**服务端 SQLite 唯一持有**。所以"从后端读库"是最稳、
也是唯一可靠的做法(并且不受前端版本变化影响)。

---

## 1. 数据在哪

| 项 | 位置 |
|---|---|
| 会话库 | `~/.local/share/opencode/opencode.db`(SQLite,默认 WAL 模式) |
| 会话文件快照 | `~/.local/share/opencode/snapshot/` |
| opencode 本体 | `~/.opencode/`(打包二进制 `bin/opencode`;并无前端源码可读) |
| web 服务 | `opencode web --hostname 0.0.0.0 --port 4096`(默认无鉴权,**勿暴露公网**) |

> 库可能很大(长期使用的实例到过 1GB+,WAL 另算)。**只读打开**
> (`file:...?mode=ro`)既能避免锁库,也不会让正在运行的 opencode 受影响。

---

## 2. 表结构与字段语义(关键)

```
session(id, title, time_created, time_updated, agent, model, directory, ...)
message(id, session_id, time_created, time_updated, data)      -- data: JSON,含 role 等元信息
part   (id, message_id, session_id, time_created, time_updated, data)  -- data: JSON,正文在这
```

`part.data` 是个 JSON,**类型在 `data.type` 字段里**(没有独立的 `type` 列):

| `data.type` | 含义 | 取哪个字段 |
|---|---|---|
| `text` | 对话正文(用户说的话、模型最终回答) | `data.text` |
| `reasoning` | 模型的思考过程 | `data.text` |
| `tool` | 工具调用 | `data.tool`(名字)、`data.state.input`(入参)、`data.state.output`(结果) |
| `step-start` / `step-finish` | 一步的开始/结束标记 | —(无正文) |
| `patch` | 文件改动 | — |
| `compaction` | 上下文被压缩过 | —(说明早期内容已折叠) |

`message.data.role` 是 `user` / `assistant`。⚠️ **不要一看到 `role=user` 就当成"人说的话"**:
摘要消息、`<system-reminder>` 包裹的上下文、`<command-name>` 触发的 slash command
也都是 `role=user`,且往往**只有 `summary` 没有 `parts`**(这正是"抽出来全是空字符串"
的原因)。脚本已按标记位过滤。

---

## 3. 怎么用

### 3.1 现成脚本(推荐)

```bash
# 列出所有会话(按最后更新倒序,含条数与工作目录)
python3 scripts/opencode-session-dump.py --list

# dump 最近更新的那个会话
python3 scripts/opencode-session-dump.py --latest

# dump 指定会话(默认只打印最近 40 条)
python3 scripts/opencode-session-dump.py ses_xxxxxxxxxxxxxxxxxxxxxxxx

# 全量、不截断(适合导出后精读)
python3 scripts/opencode-session-dump.py ses_xxxxxxxx --full > /tmp/session.md

# 库不在默认位置时
python3 scripts/opencode-session-dump.py --db /data/opencode.db --list
```

输出结构固定三段:**元信息 → 真人指令流(带时间戳)→ 工具调用统计 → 消息流水**。

### 3.2 手上没有脚本时的一行命令

```bash
python3 - <<'PY'
import json, sqlite3
c = sqlite3.connect("file:$HOME/.local/share/opencode/opencode.db?mode=ro", uri=True)
sid = c.execute("select id from session order by time_updated desc limit 1").fetchone()[0]
for mid, mdata in c.execute("select id, data from message where session_id=? order by time_created", (sid,)):
    role = json.loads(mdata).get("role")
    for (pdata,) in c.execute("select data from part where message_id=? order by rowid", (mid,)):
        p = json.loads(pdata)
        if p.get("type") == "text":
            print(role, "|", p["text"][:200])
PY
```

---

## 4. 踩坑清单(照抄会疼,提前避开)

1. **别在 `message` 表里找正文** —— 只有 `part` 表有。`message.data` 里连 `parts` 都没有。
2. **别在 SQL 里拼 `$.role`** —— 一是 shell 会吞掉 `$`(heredoc / 双引号里尤甚),
   二是 SQLite 没有 `chr()` 这类函数兜底。**取出来在 Python 里过滤**最省事。
3. **`$` 引号地狱的标准解**:把脚本写成本地文件 → `base64 -w0` → 远端
   `echo <b64> | base64 -d > /tmp/x.py && python3 /tmp/x.py`。`ssh_exec.py --shell` 同理。
4. **只读打开**:`file:<path>?mode=ro`;不要 `sqlite3 opencode.db` 写操作,
   正在跑的 opencode 还在用同一个库(WAL)。
5. **`role=user` ≠ 人说的话**(见第 2 节),先按内容特征过滤再统计指令流。
6. **远端查库不用 SSH 也行**:opencode 常驻在跑,`web` 端口只提供 API;
   真想从另一台机器看,**读库比调 API 稳**(API 形状随版本变,库结构相对稳定)。

---

## 5. 相关

- 同机联调/部署链路见 `docs/DEVELOPER.md` §7「常见开发任务速查」。
- 日志级别(排障时开 debug)见「设置 → 日志等级」,或 `LOG_LEVEL` 环境变量;
  API:`GET/PUT /rest/api/v1/admin/log-settings`。
