#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一份采集 JSON 渲染成 GitHub Step Summary 用的 markdown。

为什么单独一个文件：这段渲染逻辑原本内联在 workflow 的 heredoc 里，
会踩 YAML block scalar 的缩进规则（heredoc 内容顶格 → block 被截断 → workflow 语法错）。
拆出来之后 YAML 里只剩一行调用，也能本地验证。

用法：
  python3 summary_md.py /tmp/mf_ci_cap.json >> "$GITHUB_STEP_SUMMARY"
退出码：0=渲染完成（含读不到文件的降级分支）；2=没给参数
"""
import json
import sys


def render(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception as e:
        return ["| 采样文件 | 读取失败：`%s` |" % e]
    m = d.get("meta") or {}
    fp = (m.get("codeFingerprint") or {})
    tick = d.get("A_tick") or {}
    lines = [
        "| 项 | 值 |",
        "|---|---|",
        "| label | `%s` |" % m.get("label"),
        "| 窗口 | %s min（解析 %s 行）|" % (m.get("windowMin"), m.get("rowsParsed")),
        "| 设备数 | %s（%s）|" % (len(tick), ", ".join("`%s`" % k[-6:] for k in sorted(tick))),
    ]
    for k, v in (fp.get("dist_sha256_16") or {}).items():
        lines.append("| dist/%s | `%s` |" % (k, v))
    if fp.get("image"):
        lines.append("| image | `%s` |" % fp.get("image"))
    # 每台设备的关键量，便于一眼看出哪台红了
    for dev, c in sorted(tick.items()):
        du = c.get("deltaUs") or {}
        iq = c.get("inQueueMs") or {}
        pm = c.get("perMin") or {}
        lines.append("| %s | deltaUs p50=%.0fms negPct=%s%% · inQ p95=%sms overCap=%s%% · "
                     "realign/min=%s |"
                     % (dev[-6:], (du.get("p50") or 0) / 1000.0, du.get("negPct"),
                        iq.get("p95"), iq.get("overCapPct"), pm.get("realigned")))
    return lines


def main():
    if len(sys.argv) < 2:
        print("usage: summary_md.py <capture.json>", file=sys.stderr)
        return 2
    print("\n".join(render(sys.argv[1])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
