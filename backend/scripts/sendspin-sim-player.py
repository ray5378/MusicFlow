"""最小 Sendspin 模拟播放器(拨入模式,基于官方 aiosendspin 9.x,含 Noise 加密握手)。

用途:连上局域网内 MusicFlow 容器的 sendspin 服务端(:38927),
注册为 sendspin:<clientId> peer,接收并统计推流音频帧,验证"发现+推流"链路。
e2e 测试与手工联调共用。
用法: python sendspin-sim-player.py [ws_url] [static_pin]
环境: SIM_LOG=DEBUG 看客户端握手日志。
"""
import asyncio
import logging
import os
import sys
from dataclasses import replace

from aiosendspin.client.client import SendspinClient
from aiosendspin.client.models import PairingSupport
from aiosendspin.models.player import ClientHelloPlayerSupport, SupportedAudioFormat
from aiosendspin.models.types import AudioCodec, PlayerCommand, Roles
from aiosendspin.noise.keys import Identity
from aiosendspin.noise.trust_store import InMemoryClientPairingStore

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://192.168.10.240:38927/sendspin"
STATIC_PIN = sys.argv[2] if len(sys.argv) > 2 else ""

logging.basicConfig(
    level=getattr(logging, os.environ.get("SIM_LOG", "WARNING")),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

stats = {"chunks": 0, "bytes": 0}


def on_audio(ts_us: int, data: bytes, fmt) -> None:
    stats["chunks"] += 1
    stats["bytes"] += len(data)
    if stats["chunks"] <= 3 or stats["chunks"] % 100 == 1:
        print(f"[audio] chunks={stats['chunks']} bytes={stats['bytes']} ts_us={ts_us} fmt={fmt}", flush=True)


async def main() -> None:
    store = InMemoryClientPairingStore()
    # MusicFlow 无配对记录、对未配对 Sentinel 会话直接给 playback:
    # 按 spec 这是合法的"未配对访问",客户端侧需显式打开该运营商开关,
    # 否则 SDK 默认按 pairing_required 拒绝激活。
    cfg = await store.get_pairing_config()
    await store.store_pairing_config(replace(
        cfg, unpaired_access_enabled=True, static_pin_enabled=True,
    ))
    if STATIC_PIN:
        await store.set_static_pin(STATIC_PIN)
        print("[player] static PIN configured", flush=True)
    ident = Identity.generate()
    print(f"[player] client_id={ident.peer_id}", flush=True)
    support = ClientHelloPlayerSupport(
        supported_formats=[
            SupportedAudioFormat(codec=AudioCodec.FLAC, channels=2, sample_rate=48000, bit_depth=16),
            SupportedAudioFormat(codec=AudioCodec.PCM, channels=2, sample_rate=48000, bit_depth=16),
        ],
        buffer_capacity=4 * 1024 * 1024,
        supported_commands=[PlayerCommand.VOLUME, PlayerCommand.MUTE],
    )
    client = SendspinClient(
        identity=ident,
        client_name="MF-Test-Speaker",
        roles=[Roles.PLAYER, Roles.CONTROLLER, Roles.METADATA],
        pairing_store=store,
        player_support=support,
        # 声明配对能力(否则 hello 里不报 static_pin,服务端只能看到 pairing_psk)
        pairing_support=PairingSupport() if STATIC_PIN else None,
    )
    client.add_audio_chunk_listener(on_audio)
    await client.connect(URL)
    print("[player] CONNECTED+ADMITTED, waiting for audio... (Ctrl-C to stop)", flush=True)
    if STATIC_PIN:
        # 模拟物理按键:打开配对窗口,使 static 流程能发 pair-init
        client.open_pairing_window()
        print("[player] pairing window OPEN (static PIN ready)", flush=True)
    try:
        while True:
            await asyncio.sleep(10)
            print(f"[player] alive chunks={stats['chunks']} bytes={stats['bytes']}", flush=True)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
