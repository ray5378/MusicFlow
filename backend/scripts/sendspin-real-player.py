"""230 测试床:真实 Sendspin 播放器(aiosendspin 官方 SDK,拨入模式)。

与仓库里的 sendspin-sim-player.py 的区别:这里把 SDK **解码后的 PCM** 真正写到
音频管道(FIFO),从而可以录音量测「是否真的出声」,而不是只统计字节数。

用法:
  sendspin_real_player.py [ws_url] [codec: pcm|flac|both] [out_fifo|""] [name]
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
CODEC = (sys.argv[2] if len(sys.argv) > 2 else "pcm").lower()
OUT = sys.argv[3] if len(sys.argv) > 3 else ""
NAME = sys.argv[4] if len(sys.argv) > 4 else "MF-230-Real-Player"

logging.basicConfig(
    level=getattr(logging, os.environ.get("SIM_LOG", "WARNING")),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

stats = {"chunks": 0, "bytes": 0, "first_ts": None, "last_ts": None}
out_fd = None
decoder = None


def open_out():
    global out_fd
    if not OUT:
        return
    # FIFO:阻塞到有读者;普通文件直接追加。
    out_fd = open(OUT, "wb", buffering=0)


def on_stream_start(msg):
    payload = getattr(msg, "payload", msg)
    print(f"[stream/start] {payload}", flush=True)


def on_stream_end(msg):
    print(f"[stream/end] chunks={stats['chunks']} bytes={stats['bytes']}", flush=True)


def ensure_decoder(fmt):
    """按流声明的编码格式建解码器(FLAC/Opus 用 SDK 自带 create_decoder → PCM)。"""
    global decoder
    if decoder is not None:
        return decoder
    from aiosendspin.audio.codecs import create_decoder

    codec = getattr(fmt.codec, "value", str(fmt.codec))
    pcm = fmt.pcm_format
    decoder = create_decoder(
        codec,
        sample_rate=pcm.sample_rate,
        bit_depth=pcm.bit_depth,
        channels=pcm.channels,
        codec_header=fmt.codec_header,
    )
    print(f"[audio] decoder ready codec={codec} {pcm.sample_rate}Hz/{pcm.bit_depth}bit/{pcm.channels}ch", flush=True)
    return decoder


def on_audio(ts_us: int, data: bytes, fmt) -> None:
    if stats["first_ts"] is None:
        stats["first_ts"] = ts_us
        print(f"[audio] first chunk fmt={fmt}", flush=True)
    prev_ts = stats["last_ts"]
    if prev_ts is not None:
        # 服务端 seek 会重锚时间线:相邻块时间戳出现 >1.5s 的跳变即为拖动生效的直接证据。
        jump_ms = (ts_us - prev_ts) / 1000.0
        if abs(jump_ms) > 1500:
            print(f"[timeline] jump {jump_ms:+.0f}ms (server seek/reanchor) at chunk={stats['chunks']}", flush=True)
    stats["chunks"] += 1
    stats["bytes"] += len(data)
    stats["last_ts"] = ts_us
    pcm = ensure_decoder(fmt).decode(data)
    if out_fd is not None and pcm:
        try:
            out_fd.write(pcm)
        except Exception as e:  # 读者消失时不拖垮客户端
            print(f"[audio] write failed: {e}", flush=True)
    if stats["chunks"] <= 5 or stats["chunks"] % 500 == 0:
        print(f"[audio] chunks={stats['chunks']} bytes={stats['bytes']} pcm={len(pcm)} ts_us={ts_us}", flush=True)


async def main() -> None:
    open_out()
    store = InMemoryClientPairingStore()
    cfg = await store.get_pairing_config()
    await store.store_pairing_config(replace(cfg, unpaired_access_enabled=True, static_pin_enabled=False))
    ident = Identity.generate()

    fmts = {
        "pcm": [SupportedAudioFormat(codec=AudioCodec.PCM, channels=2, sample_rate=48000, bit_depth=16)],
        "flac": [SupportedAudioFormat(codec=AudioCodec.FLAC, channels=2, sample_rate=48000, bit_depth=16)],
        "both": [
            SupportedAudioFormat(codec=AudioCodec.FLAC, channels=2, sample_rate=48000, bit_depth=16),
            SupportedAudioFormat(codec=AudioCodec.PCM, channels=2, sample_rate=48000, bit_depth=16),
        ],
    }[CODEC]
    support = ClientHelloPlayerSupport(
        supported_formats=fmts,
        buffer_capacity=4 * 1024 * 1024,
        supported_commands=[PlayerCommand.VOLUME, PlayerCommand.MUTE],
    )
    client = SendspinClient(
        identity=ident,
        client_name=NAME,
        roles=[Roles.PLAYER, Roles.CONTROLLER, Roles.METADATA],
        pairing_store=store,
        player_support=support,
    )
    client.add_stream_start_listener(on_stream_start)
    client.add_stream_end_listener(on_stream_end)
    client.add_audio_chunk_listener(on_audio)
    await client.connect(URL)
    print(f"[player] CONNECTED+ADMITTED id={ident.peer_id} codec={CODEC} out={OUT or 'null'}", flush=True)
    try:
        while True:
            await asyncio.sleep(10)
            print(f"[player] alive chunks={stats['chunks']} bytes={stats['bytes']}", flush=True)
    finally:
        await client.disconnect()
        if out_fd is not None:
            out_fd.close()


if __name__ == "__main__":
    asyncio.run(main())
