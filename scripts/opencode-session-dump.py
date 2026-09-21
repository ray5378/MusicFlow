#!/usr/bin/env python3
"""dump 一个 opencode 会话的对话内容(直读 SQLite,不依赖 web 界面)。

背景:opencode web 的 `/session/<id>` 是**纯 JSON API**,根 `/` 是 SPA 空壳,
把会话 URL 贴进浏览器拿不到界面;而对话正文也不在 `message` 表里 —— 它在 `part`
表(见 docs/OPENCODE_SESSION_HOWTO.md)。本脚本按真实数据契约把一次会话还原成人话。

用法:
    # 列出所有会话(挑 sessionId 用)
    python3 scripts/opencode-session-dump.py --list

    # dump 最近更新的那个会话
    python3 scripts/opencode-session-dump.py --latest

    # dump 指定会话(默认只打印最近 40 条消息)
    python3 scripts/opencode-session-dump.py ses_xxxxxxxx

    # 全量输出每条消息正文(不截断,适合导出后精读)
    python3 scripts/opencode-session-dump.py ses_xxxxxxxx --full

    # 指定数据库位置(默认 ~/.local/share/opencode/opencode.db)
    python3 scripts/opencode-session-dump.py --db /path/to/opencode.db --list

零依赖(仅标准库),只读打开数据库(?mode=ro),不会影响正在运行的 opencode。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import Counter

DEFAULT_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
# 一条消息正文的截断长度(--full 时不截断)
CLIP = 200
# role=user 的消息里,这些是 opencode 内部的系统/摘要消息,不是人敲的话
INTERNAL_USER_MARKERS = ("<system-reminder", "<command-name", "This session is being continued")


def connect(path: str) -> sqlite3.Connection:
    if not os.path.exists(path):
        sys.exit(f"[dump] 数据库不存在: {path}")
    # 只读 + 不写 WAL:与被看护的 opencode 进程并存,零副作用。
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.OperationalError as e:
        sys.exit(f"[dump] 打开失败: {e}")


def table_cols(conn: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [r[1] for r in conn.execute(f"pragma table_info({table})")]
    except sqlite3.Error:
        return []


def fmt_ts(ms) -> str:
    try:
        import datetime
        return datetime.datetime.fromtimestamp(int(ms) / 1000).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ms)


def list_sessions(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "select id, coalesce(title,''), time_created, time_updated, "
        "coalesce(agent,''), coalesce(directory,'') from session order by time_updated desc"
    ).fetchall()
    print(f"共 {len(rows)} 个会话(按最后更新倒序):\n")
    for sid, title, tc, tu, agent, directory in rows:
        n = conn.execute("select count(*) from message where session_id = ?", (sid,)).fetchone()[0]
        print(f"{sid}  {fmt_ts(tu)}  [{agent}] {n:>5} 条  {title[:48]}")
        if directory:
            print(f"       dir: {directory}")


def pick_latest(conn: sqlite3.Connection) -> str:
    row = conn.execute("select id from session order by time_updated desc limit 1").fetchone()
    if not row:
        sys.exit("[dump] 数据库里没有任何会话")
    return row[0]


def part_kind(data: str) -> tuple[str, dict]:
    """解析 part.data(JSON)。返回 (type, 整个 dict)。"""
    try:
        d = json.loads(data)
    except Exception:
        return "?", {}
    if not isinstance(d, dict):
        return "?", {}
    return str(d.get("type") or "?"), d


def render_part(kind: str, d: dict) -> str:
    if kind == "text":
        return d.get("text") or ""
    if kind == "reasoning":
        return "[思考] " + (d.get("text") or "")
    if kind == "tool":
        st = d.get("state") or {}
        inp = st.get("input") if isinstance(st, dict) else None
        out = st.get("output") if isinstance(st, dict) else None
        head = f"[工具 {d.get('tool')}] " + json.dumps(inp, ensure_ascii=False)[:400]
        if out:
            head += "\n    → " + str(out)[:300]
        return head
    if kind in ("step-start", "step-finish"):
        return ""
    if kind == "patch":
        return "[改动] " + json.dumps(d, ensure_ascii=False)[:200]
    if kind == "compaction":
        return "[上下文压缩]"
    return ""


def dump(conn: sqlite3.Connection, sid: str, full: bool, last: int) -> None:
    meta = conn.execute(
        "select coalesce(title,''), time_created, time_updated, coalesce(agent,''), "
        "coalesce(model,''), coalesce(directory,'') from session where id = ?",
        (sid,),
    ).fetchone()
    if not meta:
        sys.exit(f"[dump] 找不到会话: {sid}")
    title, tc, tu, agent, model, directory = meta
    print("# opencode 会话")
    print(f"id       : {sid}")
    print(f"标题     : {title}")
    print(f"目录     : {directory}")
    print(f"agent    : {agent}   model: {model}")
    print(f"时间     : {fmt_ts(tc)} → {fmt_ts(tu)}")

    msgs = conn.execute(
        "select id, time_created, data from message where session_id = ? order by time_created",
        (sid,),
    ).fetchall()
    print(f"消息     : {len(msgs)} 条")

    instructions: list[tuple[str, str]] = []   # 真人指令流
    rows: list[tuple[str, str, str]] = []      # (时间, role, 正文)
    tools: Counter[str] = Counter()

    for mid, mtime, mdata in msgs:
        try:
            md = json.loads(mdata)
        except Exception:
            md = {}
        role = md.get("role") or "?"
        parts = conn.execute(
            "select data from part where message_id = ? order by rowid", (mid,)
        ).fetchall()
        texts: list[str] = []
        for (pdata,) in parts:
            kind, d = part_kind(pdata)
            if kind == "tool":
                tools[str(d.get("tool") or "?")] += 1
            s = render_part(kind, d)
            if s:
                texts.append(s)
        body = "\n".join(texts).strip()
        if not body:
            continue
        if role == "user" and not any(m in body for m in INTERNAL_USER_MARKERS):
            instructions.append((fmt_ts(mtime), body))
        rows.append((fmt_ts(mtime), role, body))

    print(f"\n## 真人指令流({len(instructions)} 条)")
    for ts, t in instructions:
        flat = " ".join(t.split())
        print(f"- [{ts}] {flat[:400] if not full else flat}")

    if tools:
        print("\n## 工具调用统计")
        for name, n in tools.most_common():
            print(f"  {name}: {n}")

    show = rows if full else rows[-last:]
    print(f"\n## 消息流水({'全部 ' + str(len(rows)) if full else '最近 ' + str(len(show))} 条)")
    for ts, role, body in show:
        flat = " ".join(body.split())
        print(f"[{ts}] {role}: {flat if full else flat[:CLIP]}")


def main() -> None:
    ap = argparse.ArgumentParser(description="dump 一个 opencode 会话的对话内容")
    ap.add_argument("session", nargs="?", help="sessionId;省略时配合 --latest 或 --list")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"opencode.db 路径(默认 {DEFAULT_DB})")
    ap.add_argument("--list", action="store_true", help="列出所有会话后退出")
    ap.add_argument("--latest", action="store_true", help="dump 最近更新的会话")
    ap.add_argument("--full", action="store_true", help="输出全部消息且不截断")
    ap.add_argument("--last", type=int, default=40, help="非 --full 时打印最近 N 条(默认 40)")
    args = ap.parse_args()

    conn = connect(args.db)
    # 表不存在 = 不是 opencode 库
    if not table_cols(conn, "session"):
        sys.exit(f"[dump] {args.db} 里没有 session 表,不是 opencode 数据库?")

    if args.list:
        list_sessions(conn)
        return
    sid = args.session or (pick_latest(conn) if args.latest else None)
    if not sid:
        list_sessions(conn)
        sys.exit("\n[dump] 未指定 sessionId:上面挑一个再跑,或用 --latest。")
    if not table_cols(conn, "part"):
        print("[dump] 警告:没有 part 表(旧版 opencode?),正文可能取不到", file=sys.stderr)
    dump(conn, sid, args.full, args.last)


if __name__ == "__main__":
    main()
