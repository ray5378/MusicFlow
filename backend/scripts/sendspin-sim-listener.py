"""Sendspin 监听模式模拟播放器(服务端主动拨号方向)。
用法: python sendspin-sim-listener.py [port] [name]
监听 :port/sendspin,来连接即 attach 为 player,收音频帧计数。
e2e 测试(dialE2E)与手工联调共用。
"""
import asyncio
import logging
import os
import sys
from dataclasses import replace

from aiosendspin.client.client import SendspinClient
from aiosendspin.client.listener import ClientListener
from aiosendspin.models.player import ClientHelloPlayerSupport, SupportedAudioFormat
from aiosendspin.models.types import AudioCodec, PlayerCommand, Roles
from aiosendspin.noise.keys import Identity
from aiosendspin.noise.trust_store import InMemoryClientPairingStore

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18931
NAME = sys.argv[2] if len(sys.argv) > 2 else "MF-Listen-Speaker"

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
    cfg = await store.get_pairing_config()
    await store.store_pairing_config(replace(cfg, unpaired_access_enabled=True))
    ident = Identity.generate()
    print(f"[listen-player] client_id={ident.peer_id} port={PORT}", flush=True)
    support = ClientHelloPlayerSupport(
        supported_formats=[
            SupportedAudioFormat(codec=AudioCodec.FLAC, channels=2, sample_rate=48000, bit_depth=16),
            SupportedAudioFormat(codec=AudioCodec.PCM, channels=2, sample_rate=48000, bit_depth=16),
        ],
        buffer_capacity=4 * 1024 * 1024,
        supported_commands=[PlayerCommand.VOLUME, PlayerCommand.MUTE],
    )

    async def handle_connection(ws) -> None:
        client = SendspinClient(
            identity=ident,
            client_name=NAME,
            roles=[Roles.PLAYER, Roles.CONTROLLER, Roles.METADATA],
            pairing_store=store,
            player_support=support,
        )
        client.add_audio_chunk_listener(on_audio)
        await client.attach_websocket(ws)
        print("[listen-player] server attached, admitted", flush=True)
        done = asyncio.Event()
        client.add_disconnect_listener(done.set)
        await done.wait()
        print("[listen-player] disconnected", flush=True)

    listener = ClientListener(
        client_id=ident.peer_id,
        on_connection=handle_connection,
        port=PORT,
        advertise_mdns=False,
        client_name=NAME,
    )
    await listener.start()
    print("[listen-player] listening, waiting for server dial... (Ctrl-C to stop)", flush=True)
    try:
        while True:
            await asyncio.sleep(10)
            print(f"[listen-player] alive chunks={stats['chunks']} bytes={stats['bytes']}", flush=True)
    finally:
        if hasattr(listener, "stop"):
            await listener.stop()


if __name__ == "__main__":
    asyncio.run(main())
