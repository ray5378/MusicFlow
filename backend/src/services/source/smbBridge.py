#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SMB 桥接进程(smbprotocol)：Node 侧只通过 stdin/stdout 的 JSON 行调用。

为什么需要它
------------
v9u-smb2 只实现到 SMB2，没有 SMB3 加密。服务端一旦 `smb encrypt = required`
(飞牛 FNOS 的默认策略)，tree connect 直接返回 STATUS_ACCESS_DENIED；而容器
非特权(无 CAP_SYS_ADMIN)，既不能 mount.cifs 也没有系统 smbclient。
smbprotocol 是纯 Python 的 SMB2/3 实现，自带 AES-CCM，支持加密共享，并且
open_file 支持按偏移 seek/read —— 足以覆盖扫描、取标签头、播放 seek。

协议
----
stdin/stdout 各一行一个 UTF-8 JSON；请求带自增 id，响应原样带回 id。
  {"id":1,"op":"hello","config":{host,port,share,domain,username,password}}
  {"id":2,"op":"stat","path":"/a/b"}
  {"id":3,"op":"readdir","path":"/a"}
  {"id":4,"op":"open","path":"/a/b","start":0}
  {"id":5,"op":"read","handle":1,"length":262144}
  {"id":6,"op":"closeFile","handle":1}
  {"id":7,"op":"ping"}
  {"id":8,"op":"shutdown"}
响应: {"id":N,"ok":true,"result":...} / {"id":N,"ok":false,"error":{message,status}}

stdout 只允许出现 JSON(否则 Node 侧解析失败)，所有日志走 stderr。
进程是串行的：一条 SMB 连接本来就不适合并发乱序请求，顺序处理反而最稳。
"""

import base64
import json
import os
import sys
import traceback

try:
    import smbclient
except Exception as exc:  # 依赖没装进镜像时给出明确原因，而不是让 Node 侧看到无输出的子进程
    sys.stderr.write("[smbbridge] 无法导入 smbclient(smbprotocol): %s\n" % exc)
    sys.exit(2)

CONFIG = None
UNC_ROOT = ""
HANDLES = {}
NEXT_HANDLE = 1

# 连接级错误：命中后丢弃连接重连。文件不存在/无权限属于业务结果，不能动连接，
# 否则一次扫描里的正常 404 会把健康会话踢掉。
CONN_STATUS = {
    0xC00000C9,  # STATUS_NETWORK_NAME_DELETED
    0xC000020C,  # STATUS_CONNECTION_DISCONNECTED
    0xC0000203,  # STATUS_USER_SESSION_DELETED
    0xC000035C,  # STATUS_NETWORK_SESSION_EXPIRED
}
CONN_ERRNOS = {32, 104, 110, 111}  # EPIPE / ECONNRESET / ETIMEDOUT / ECONNREFUSED


def write_line(obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(data + b"\n")
    sys.stdout.buffer.flush()


def log(msg):
    sys.stderr.write("[smbbridge] %s\n" % msg)
    sys.stderr.flush()


def status_of(exc):
    status = getattr(exc, "ntstatus", None)
    if isinstance(status, int):
        return "0x%08X" % status
    return None


def is_conn_error(exc):
    status = getattr(exc, "ntstatus", None)
    if isinstance(status, int) and status in CONN_STATUS:
        return True
    if isinstance(exc, (ConnectionError, BrokenPipeError)):
        return True
    if isinstance(exc, OSError) and getattr(exc, "errno", None) in CONN_ERRNOS:
        return True
    msg = str(exc).lower()
    return "broken pipe" in msg or "connection reset" in msg


def account(cfg):
    """本地账号一般不需要域前缀；显式域(非 WORKGROUP)时按 DOMAIN\\user 传。"""
    user = (cfg.get("username") or "").strip()
    domain = (cfg.get("domain") or "").strip()
    if not user:
        return None
    if domain and domain.upper() != "WORKGROUP" and "\\" not in user and "@" not in user:
        return domain + "\\" + user
    return user


def ensure_session(force=False):
    if CONFIG is None:
        raise RuntimeError("桥接进程尚未初始化")
    if force:
        try:
            smbclient.reset_connection_cache(fail_on_error=False)
        except Exception:
            pass
    smbclient.register_session(
        CONFIG["host"],
        username=account(CONFIG),
        password=CONFIG.get("password") or None,
        port=int(CONFIG.get("port") or 445),
        connection_timeout=20,
    )


def unc(path):
    """共享内 POSIX 路径 -> UNC。空路径表示共享根。"""
    rel = str(path or "/").replace("\\", "/").strip("/")
    if not rel:
        return UNC_ROOT
    return UNC_ROOT + "\\" + rel.replace("/", "\\")


def ms(dt):
    try:
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def do_stat(req):
    st = smbclient.stat(unc(req.get("path")), follow_symlinks=True)
    attrs = int(getattr(st, "st_file_attributes", 0) or 0)
    return {
        "size": int(st.st_size or 0),
        "mtimeMs": int((st.st_mtime or 0) * 1000),
        "isDirectory": bool(attrs & 0x10),  # FILE_ATTRIBUTE_DIRECTORY
    }


def do_readdir(req):
    # scandir 一次 query_directory 就把 size/mtime/属性都带回来了，
    # 不要改成 listdir + 每个文件 stat(一万多首个文件的目录会慢到不可用)。
    out = []
    with smbclient.scandir(unc(req.get("path"))) as it:
        for entry in it:
            name = entry.name
            if name in (".", ".."):
                continue
            info = entry.smb_info
            out.append({
                "name": name,
                "size": int(info.end_of_file or 0),
                "mtimeMs": ms(info.last_write_time),
                "isDirectory": bool(entry.is_dir()),
            })
    return out


def do_open(req):
    global NEXT_HANDLE
    path = unc(req.get("path"))
    start = int(req.get("start") or 0)
    f = smbclient.open_file(path, mode="rb")
    try:
        try:
            # 取大小会把游标推到文件尾,必须无条件回卷到 start —— start=0 时漏掉
            # 这一步会让「从 0 读」永远读到空(扫描取头拿不到标签、播放拿不到流)。
            size = int(f.seek(0, os.SEEK_END) or 0)
        except Exception:
            size = int(smbclient.stat(path).st_size or 0)
        f.seek(start)
    except Exception:
        try:
            f.close()
        except Exception:
            pass
        raise
    handle = NEXT_HANDLE
    NEXT_HANDLE += 1
    HANDLES[handle] = f
    return {"handle": handle, "size": size}


def do_read(req):
    handle = int(req.get("handle"))
    f = HANDLES.get(handle)
    if f is None:
        raise RuntimeError("文件句柄已关闭")
    length = int(req.get("length") or 0)
    if length <= 0:
        return {"data": "", "length": 0}
    data = f.read(length)
    return {"data": base64.b64encode(data).decode("ascii"), "length": len(data)}


def do_close_file(req):
    handle = int(req.get("handle"))
    f = HANDLES.pop(handle, None)
    if f is not None:
        try:
            f.close()
        except Exception:
            pass
    return {}


def do_ping(_req):
    return {"pong": True}


OPS = {
    "stat": do_stat,
    "readdir": do_readdir,
    "open": do_open,
    "read": do_read,
    "closeFile": do_close_file,
    "ping": do_ping,
}


def run_op(req):
    op = req.get("op")
    fn = OPS.get(op)
    if fn is None:
        raise RuntimeError("未知操作: %s" % op)
    try:
        return fn(req)
    except Exception as exc:
        # 幂等读操作遇到连接级错误时重连重试一次(扫描/播放重试不会产生副作用)。
        if not is_conn_error(exc):
            raise
        log("连接异常，重连后重试 %s: %s" % (op, exc))
        ensure_session(force=True)
        return fn(req)


def main():
    global CONFIG, UNC_ROOT
    for raw in sys.stdin.buffer:
        line = raw.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line.decode("utf-8"))
            op = req.get("op")
            if op == "hello":
                CONFIG = req.get("config") or {}
                UNC_ROOT = "\\\\%s\\%s" % (CONFIG["host"], CONFIG["share"])
                ensure_session()
                result = {"root": UNC_ROOT}
            elif op == "shutdown":
                break
            else:
                result = run_op(req)
            write_line({"id": req.get("id"), "ok": True, "result": result})
        except Exception as exc:
            log("操作失败 %s: %s\n%s" % (req.get("op"), exc, traceback.format_exc(limit=3)))
            write_line({
                "id": req.get("id"),
                "ok": False,
                "error": {"message": str(exc) or exc.__class__.__name__, "status": status_of(exc)},
            })

    for f in list(HANDLES.values()):
        try:
            f.close()
        except Exception:
            pass
    HANDLES.clear()
    try:
        smbclient.reset_connection_cache(fail_on_error=False)
    except Exception:
        pass


if __name__ == "__main__":
    main()
