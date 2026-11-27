#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DLNA 出流判据（第 11 条）—— 判「流能不能正常交给渲染器」，不判设备出声。

为什么单列一条
--------------
DLNA 的职责边界与 AirPlay/sendspin 不同：服务端只负责把一条**无鉴权流 URL**
交给渲染器（`POST /v1/dlna/stream-url` 签发 cast token），渲染器自己回连
`/rest/dlna/stream/:token` 拉字节并解码。因此「曲中空洞 / 曲末空洞」那十条
（桥 servo、首投 seek、endUs 接续……）在 DLNA 拓扑上结构不存在，用它们判会恒
SKIP 或误判；能判、且必须判的是**出流面**：

  1. 签发：token 非空、streamUrl 与 token 自洽、TTL 为正
  2. 首字节：HTTP 200/206，TTFB ≤ 3s（真机实测 0.01~0.55s）
  3. 连续：连续读到 ≥1MB 无 5xx / 连接重置 / 提前 EOF
  4. 复用：同一 token 连续 3 次 GET 全部可取（渲染器 seek/重投会重拉）
  5. 切歌：换一首立即签发新 token，新流 TTFB ≤ 3s 且可取 ≥256KB

已知实现特征（不是回归，不要判红）
----------------------------------
* 端点**忽略 Range**：恒返回 200、无 Content-Range，从头出流（渲染器按顺
  序读即可，不需要随机定位）。
* `Content-Length` 恒为哨兵值（实测 7619400000），与实际字节数不符 —— 管道
  出流长度未知，客户端以 EOF/关连接为准。故**不能**用 Content-Length 判完整性。

设备侧：当前 240 上 DLNA 设备均 `available=False`（发现链路未上报），因此本
脚本只判服务端出流；设备真正拉流解码出声需设备在线后另测，不在本条范围。

与 docs/曲中静音与曲末空洞-判定全流程-20261126.md §6 第 11 条同源，改阈值
必须同步文档。

用法（在 240 上跑）：
    python3 backend/scripts/baseline/dlna_stream_guard.py --songs 3
    python3 backend/scripts/baseline/dlna_stream_guard.py --out /tmp/dlna.json
退出码：0=PASS / 1=FAIL / 2=样本问题（登录失败、曲库无可用短曲）。
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = os.environ.get("MF_BASE_URL", "http://127.0.0.1:46400")
USER = os.environ.get("MF_USER", "xyz5378")
# 与 /root/mf_transfer_matrix.py 同源口令（base64 内联，避开多层 shell 转义）
PW_B64 = os.environ.get("MF_PW_B64", "QCRxUSFKNHBOblNveTg=")

TTFB_MAX_S = 3.0
MIN_CONTINUOUS_BYTES = 1024 * 1024
MIN_SWITCH_BYTES = 256 * 1024
MIN_RATE_BPS = 64 * 1024
TOKEN_REUSE_TIMES = 3


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.api = self.base + "/rest/api"
        self.token = None

    def _open(self, url, headers=None, timeout=60):
        h = {"Accept": "*/*"}
        if self.token and url.startswith(self.api):
            h["Authorization"] = "Bearer " + self.token
        if headers:
            h.update(headers)
        req = urllib.request.Request(url, headers=h, method="GET")
        t0 = time.time()
        try:
            r = urllib.request.urlopen(req, timeout=timeout)
            return r, r.status, round(time.time() - t0, 3), None
        except urllib.error.HTTPError as e:
            return None, e.code, round(time.time() - t0, 3), "HTTP %s" % e.code
        except Exception as e:
            return None, 0, round(time.time() - t0, 3), "%s: %s" % (type(e).__name__, e)

    def api_json(self, method, path, body=None, timeout=60):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.api + path, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as f:
                return f.status, json.loads(f.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, {"_err": e.read()[:200].decode("utf-8", "replace")}
        except Exception as e:
            return 0, {"_exc": "%s: %s" % (type(e).__name__, e)}

    def login(self):
        st, js = self.api_json("POST", "/v1/auth/login",
                               {"username": USER, "password": base64.b64decode(PW_B64).decode()}, 20)
        if st != 200 or not js.get("token"):
            print("LOGIN_FAILED http=%s resp=%s" % (st, str(js)[:200]))
            return False
        self.token = js["token"]
        return True


def read_capped(f, cap, deadline_s=15.0):
    """读至多 cap 字节；返回 (bytes, seconds, error)。error 只记异常，不把读满当错。"""
    got, t0, err = 0, time.time(), None
    try:
        while got < cap and time.time() - t0 < deadline_s:
            chunk = f.read(min(262144, cap - got))
            if not chunk:
                break
            got += len(chunk)
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, str(e)[:100])
    return got, round(time.time() - t0, 3), err


def pick_songs(cli, want, dur_min=20, dur_max=90):
    st, js = cli.api_json("GET", "/v1/songs?pageSize=300", None, 120)
    if st != 200:
        return [], "songs http=%s" % st
    rows = js.get("items") or js.get("songs") or []
    if not rows:
        return [], "songs empty"

    def dur(r):
        d = r.get("duration") or r.get("durationMs") or 0
        return d / 1000.0 if d > 1000 else d

    cand = [r for r in rows if dur_min <= dur(r) <= dur_max and (r.get("id") or r.get("songId"))]
    # 至少混入一首 local、一首 web（两条音源链差异最大）
    picked, seen_types = [], set()
    for pref in ("local", "web"):
        for r in cand:
            if (r.get("type") or "local") == pref and r not in picked:
                picked.append(r)
                seen_types.add(pref)
                break
    for r in cand:
        if len(picked) >= want:
            break
        if r not in picked:
            picked.append(r)
    return picked[:want], "ok"


def check_one(cli, row, idx, verify_switch):
    sid = row.get("id") or row.get("songId")
    name = row.get("title") or sid[:8]
    kind = row.get("type") or "local"
    res = {"songId": sid, "title": name, "type": kind, "checks": {}, "fails": []}

    def fail(k, msg):
        res["fails"].append("%s: %s" % (k, msg))

    st, js = cli.api_json("POST", "/v1/dlna/stream-url",
                          {"songId": sid, "deviceId": "client-cast"}, 30)
    tok, surl, exp = js.get("token"), js.get("streamUrl"), js.get("expiresAt")
    res["mint_http"] = st
    res["checks"]["mint"] = st == 200 and bool(tok) and bool(surl) and (exp or 0) > time.time() * 1000
    if not res["checks"]["mint"]:
        fail("mint", "http=%s token=%s url=%s ttl=%s" % (st, bool(tok), surl, exp))
        return res
    res["streamUrl"] = surl
    res["checks"]["mint_selfconsistent"] = surl.endswith(tok)
    if not res["checks"]["mint_selfconsistent"]:
        fail("mint_selfconsistent", "streamUrl 与 token 不自洽")

    url = cli.base + surl
    f, status, ttfb, err = cli._open(url, {"Range": "bytes=0-262143"}, 60)
    res["first_ttfb_s"] = ttfb
    res["first_status"] = status
    if not f:
        fail("first_byte", "status=%s err=%s" % (status, err))
        return res
    ctype = f.headers.get("Content-Type") or ""
    got, rt, rerr = read_capped(f, MIN_CONTINUOUS_BYTES)
    f.close()
    res["first_bytes"] = got
    res["first_read_s"] = rt
    res["content_type"] = ctype
    res["checks"]["content_type"] = ctype.startswith("audio/") or "octet-stream" in ctype
    res["checks"]["status_ok"] = status in (200, 206)
    res["checks"]["ttfb"] = ttfb <= TTFB_MAX_S
    res["checks"]["continuous"] = got >= MIN_CONTINUOUS_BYTES and not rerr
    res["rate_bps"] = int(got / rt) if rt > 0 else 0
    res["checks"]["rate"] = res["rate_bps"] >= MIN_RATE_BPS
    if not res["checks"]["status_ok"]:
        fail("status", str(status))
    if not res["checks"]["ttfb"]:
        fail("ttfb", "%.3fs > %.1fs" % (ttfb, TTFB_MAX_S))
    if not res["checks"]["continuous"]:
        fail("continuous", "bytes=%d err=%s" % (got, rerr))
    if not res["checks"]["rate"]:
        fail("rate", "%d B/s < %d" % (res["rate_bps"], MIN_RATE_BPS))
    if not res["checks"]["content_type"]:
        fail("content_type", ctype or "(缺失)")

    reuse_ok = True
    for i in range(TOKEN_REUSE_TIMES):
        f, status, ttfb, err = cli._open(url, {"Range": "bytes=0-4095"}, 30)
        if not f:
            reuse_ok = False
            fail("reuse%d" % i, "status=%s err=%s" % (status, err))
            continue
        got, _, rerr = read_capped(f, 4096, 10)
        f.close()
        if status not in (200, 206) or got < 4096 or rerr:
            reuse_ok = False
            fail("reuse%d" % i, "status=%s bytes=%d err=%s" % (status, got, rerr))
    res["checks"]["token_reuse"] = reuse_ok

    if verify_switch:
        nxt = verify_switch
        nsid = nxt.get("id") or nxt.get("songId")
        st2, js2 = cli.api_json("POST", "/v1/dlna/stream-url",
                                {"songId": nsid, "deviceId": "client-cast"}, 30)
        tok2 = js2.get("token")
        res["switch"] = {"to_song": nxt.get("title"), "mint_http": st2,
                         "new_token": bool(tok2) and tok2 != tok}
        if st2 != 200 or not tok2:
            fail("switch_mint", "http=%s" % st2)
        else:
            f, status, ttfb, err = cli._open(cli.base + js2["streamUrl"],
                                             {"Range": "bytes=0-262143"}, 60)
            res["switch"]["ttfb_s"] = ttfb
            res["switch"]["status"] = status
            ok = bool(f) and status in (200, 206) and ttfb <= TTFB_MAX_S
            if f:
                got, _, rerr = read_capped(f, MIN_SWITCH_BYTES)
                f.close()
                ok = ok and got >= MIN_SWITCH_BYTES and not rerr
                res["switch"]["bytes"] = got
            if not ok:
                fail("switch_stream", "status=%s ttfb=%.3fs err=%s" % (status, ttfb, err))
            res["checks"]["track_switch"] = ok
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description="DLNA 出流判据（判定文档 §6 第 11 条）")
    ap.add_argument("--base", default=DEFAULT_BASE, help="服务地址（默认 240 本机 46400）")
    ap.add_argument("--songs", type=int, default=3, help="连续验证的曲目数（含切歌）")
    ap.add_argument("--out", help="判读 JSON 输出路径")
    args = ap.parse_args(argv)

    cli = Client(args.base)
    if not cli.login():
        return 2
    songs, why = pick_songs(cli, max(2, args.songs))
    if len(songs) < 2:
        print("SAMPLE_INSUFFICIENT %s" % why)
        return 2

    results = []
    for i, row in enumerate(songs):
        nxt = songs[i + 1] if i + 1 < len(songs) else None
        r = check_one(cli, row, i, nxt)
        results.append(r)
        verdict = "PASS" if not r["fails"] else "FAIL"
        print("[%d] %-8s %-22s ttfb=%.3fs bytes=%s type=%s -> %s"
              % (i + 1, verdict, (r["title"] or "")[:22], r.get("first_ttfb_s", -1),
                 r.get("first_bytes"), r.get("type"), "; ".join(r["fails"]) or "ok"))

    fails = [x for r in results for x in r["fails"]]
    print("SUMMARY songs=%d fails=%d" % (len(results), len(fails)))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       "base": args.base, "results": results}, f, ensure_ascii=False, indent=2)
        print("写入: %s" % args.out)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
