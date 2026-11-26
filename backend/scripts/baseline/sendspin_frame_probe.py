#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI 混合群组体检：sendspin 拨入播放器 + 音频帧级采样。

为什么需要它
------------
A 层 tick / ring-diag 由 backend/src/services/airplay/bridgeSession.ts 产出，
**只有含 AirPlay 成员的组才有**。纯 sendspin 组不经过桥，tick 恒为 0 —— 拿
invariant_guard 的 tick 判据去判它只会得到「样本不足」的假红。

纯 sendspin 组的等价 A 层真值是「服务端实际推出来的音频帧」：本探针用
aiosendspin 9.x 以真实拨入播放器身份接入 MusicFlow（:38927/sendspin），
每收到一帧就写一行结构化证据：

    {"t": <epoch_ms>, "ts_us": <协议时间戳us>, "bytes": <帧字节数>}

CI 里由 baseline_cap.py 汇总成 A_ssFrame（帧数 / 最大帧间隔 / 每次切歌窗口
的帧增量），invariant_guard.py 按绝对阈值判读。这个口径与设备是不是真音箱
无关，4.15.9 那种「泵在推但音频空洞」会在 maxGapMs / 切歌后帧增量上暴露。

用法（CI 内，环境变量注入）：
    MF_SS_FRAME_OUT=<work>/sendspin_frames.jsonl \
    MF_SS_NAME=MF-CI-SPIN1 \
    python3 backend/scripts/baseline/sendspin_frame_probe.py [ws_url] [static_pin]
"""
import asyncio
import base64
import json
import logging
import os
import sys
import time
import urllib.request
from dataclasses import replace

from aiosendspin.client.client import SendspinClient
from aiosendspin.client.models import PairingSupport
from aiosendspin.models.player import ClientHelloPlayerSupport, SupportedAudioFormat
from aiosendspin.models.types import AudioCodec, PlayerCommand, Roles
from aiosendspin.noise.keys import Identity
from aiosendspin.noise.trust_store import InMemoryClientPairingStore

URL = os.environ.get("MF_SS_URL", "ws://127.0.0.1:38927/sendspin")
NAME = os.environ.get("MF_SS_NAME", "MF-CI-SPIN")
OUT = os.environ.get("MF_SS_FRAME_OUT", "")   # 空 = 只当普通模拟播放器，不落盘
STATIC_PIN = sys.argv[2] if len(sys.argv) > 2 else ""
if len(sys.argv) > 1:
    URL = sys.argv[1]
API_BASE = os.environ.get("MF_BASE_URL", "http://127.0.0.1:46400")
API_USER = os.environ.get("MF_USER", "")
API_PASS = os.environ.get("MF_PASS", "")


def approve_self(client_id):
    """CI 测试设备预批准：服务端 needsPairingActivation() 看 pairingStore.isApproved，
    已批准就跳过 PAKE 直接激活注册 peer。9.x SDK 的配对 wire 与本仓服务端
    不兼容（pin_mismatch），但 approved 标记不需要设备在线（setApproved 纯内存写），
    所以连接前就能批准。生产环境不注入 MF_USER，这段自动 no-op。"""
    if not API_USER:
        print("[ss-probe] no admin creds; self-approve skipped", flush=True)
        return
    try:
        auth = base64.b64encode(("%s:%s" % (API_USER, API_PASS)).encode()).decode()
        body = json.dumps({"clientId": client_id, "approved": True}).encode()
        req = urllib.request.Request(
            API_BASE + "/rest/api/v1/sendspin/approve", data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
        with urllib.request.urlopen(req, timeout=10) as resp:
            print("[ss-probe] self-approved rc=%d" % resp.status, flush=True)
    except Exception as e:
        print("[ss-probe] self-approve failed: %s" % e, flush=True)

logging.basicConfig(
    level=getattr(logging, os.environ.get("SIM_LOG", "WARNING")),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

stats = {"chunks": 0, "bytes": 0}
_f = open(OUT, "a", encoding="utf-8", buffering=1) if OUT else None


def on_audio(ts_us: int, data: bytes, fmt) -> None:
    stats["chunks"] += 1
    stats["bytes"] += len(data)
    if _f is not None:
        # 行缓冲：CI 每轮采样结束会 timeout 杀进程，不能等进程正常退出才 flush。
        _f.write(json.dumps({"t": int(time.time() * 1000),
                             "ts_us": int(ts_us), "bytes": len(data)}) + "\n")
    if stats["chunks"] <= 3 or stats["chunks"] % 200 == 1:
        print("[ss-probe] chunks=%d bytes=%d ts_us=%d fmt=%s" %
              (stats["chunks"], stats["bytes"], ts_us, fmt), flush=True)


async def make_client(ident):
    store = InMemoryClientPairingStore()
    cfg = await store.get_pairing_config()
    # MusicFlow 无配对记录、对未配对 Sentinel 会话直接给 playback；
    # 按 spec 这是合法的「未配对访问」，SDK 默认拒绝，必须显式打开开关。
    await store.store_pairing_config(replace(
        cfg, unpaired_access_enabled=True, static_pin_enabled=True,
    ))
    if STATIC_PIN:
        await store.set_static_pin(STATIC_PIN)
    support = ClientHelloPlayerSupport(
        supported_formats=[
            SupportedAudioFormat(codec=AudioCodec.FLAC, channels=2,
                                 sample_rate=48000, bit_depth=16),
            SupportedAudioFormat(codec=AudioCodec.PCM, channels=2,
                                 sample_rate=48000, bit_depth=16),
        ],
        buffer_capacity=4 * 1024 * 1024,
        supported_commands=[PlayerCommand.VOLUME, PlayerCommand.MUTE],
    )
    client = SendspinClient(
        identity=ident,
        client_name=NAME,
        roles=[Roles.PLAYER, Roles.CONTROLLER, Roles.METADATA],
        pairing_store=store,
        player_support=support,
        pairing_support=PairingSupport() if STATIC_PIN else None,
    )
    client.add_audio_chunk_listener(on_audio)
    return client


async def main() -> None:
    ident = Identity.generate()
    print("[ss-probe] name=%s client_id=%s out=%s" % (NAME, ident.peer_id, OUT or "-"),
          flush=True)
    approve_self(ident.peer_id)
    # 插件 toggle 后服务才监听 :38927，冷启动 + 容器重启都要覆盖；
    # 失败必须重建 client（aiohttp session 用坏后不能复用）。
    client = None
    for attempt in range(1, 31):
        c = await make_client(ident)
        try:
            await c.connect(URL)
            client = c
            print("[ss-probe] CONNECTED+ADMITTED attempt=%d" % attempt, flush=True)
            if STATIC_PIN:
                # 只配 static pin 不够：必须主动开配对窗，服务端才能完成
                # 配对并 activate（否则日志 "pairing hold ... 空激活挂起"）。
                c.open_pairing_window()
                print("[ss-probe] pairing window OPEN", flush=True)
            break
        except Exception as e:
            print("[ss-probe] connect %d/30 failed: %s" % (attempt, e), flush=True)
            try:
                await c.disconnect()
            except Exception:
                pass
            await asyncio.sleep(2)
    if client is None:
        raise SystemExit("sendspin service unreachable at %s after 60s" % URL)
    try:
        while True:
            await asyncio.sleep(10)
            print("[ss-probe] alive chunks=%d bytes=%d" %
                  (stats["chunks"], stats["bytes"]), flush=True)
    finally:
        await client.disconnect()
        if _f is not None:
            _f.flush()


if __name__ == "__main__":
    asyncio.run(main())
