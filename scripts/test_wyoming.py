"""Quick test: send synthetic audio to Wyoming Faster Whisper and check response."""
import asyncio
import io
import json
import math
import struct
import wave


def make_event(event_type, data=None, payload=None):
    data_bytes = b""
    header = {"type": event_type, "version": "1.0"}
    if data:
        data_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        header["data_length"] = len(data_bytes)
    if payload:
        header["payload_length"] = len(payload)
    frame = json.dumps(header, ensure_ascii=False).encode("utf-8") + b"\n"
    frame += data_bytes
    if payload:
        frame += payload
    return frame


async def main():
    rate = 16000
    duration = 2
    # Generate 2s of 440Hz tone
    samples = []
    for i in range(rate * duration):
        val = int(32767 * 0.5 * math.sin(2 * math.pi * 440 * i / rate))
        samples.append(struct.pack("<h", val))
    pcm = b"".join(samples)
    print(f"Test PCM: {len(pcm)} bytes, {duration}s, {rate}Hz mono 16-bit")

    host, port = "localhost", 10300
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port), timeout=5
    )
    print(f"Connected to {host}:{port}")

    # transcribe event
    writer.write(make_event("transcribe", {"language": "ro"}))
    # audio-start
    writer.write(make_event("audio-start", {"rate": rate, "width": 2, "channels": 1}))
    # audio-chunks
    chunk_size = 8192
    n = 0
    for i in range(0, len(pcm), chunk_size):
        chunk = pcm[i : i + chunk_size]
        writer.write(
            make_event(
                "audio-chunk",
                {"rate": rate, "width": 2, "channels": 1},
                payload=chunk,
            )
        )
        n += 1
    print(f"Sent {n} audio-chunk events")
    # audio-stop
    writer.write(make_event("audio-stop"))
    await writer.drain()
    print("Sent audio-stop, waiting for response...")

    # Read response
    response = b""
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), timeout=30)
            if not data:
                break
            response += data
            if b'"transcript"' in response or b'"error"' in response:
                try:
                    extra = await asyncio.wait_for(reader.read(4096), timeout=0.5)
                    if extra:
                        response += extra
                except asyncio.TimeoutError:
                    pass
                break
    except asyncio.TimeoutError:
        print("Timeout waiting for response!")

    print(f"\nResponse ({len(response)} bytes):")
    # Parse
    pos = 0
    while pos < len(response):
        nl = response.find(b"\n", pos)
        if nl == -1:
            break
        line = response[pos:nl].strip()
        pos = nl + 1
        if not line:
            continue
        try:
            hdr = json.loads(line)
            data_len = hdr.get("data_length", 0)
            evt_data = {}
            if data_len and pos + data_len <= len(response):
                try:
                    evt_data = json.loads(response[pos : pos + data_len])
                except json.JSONDecodeError:
                    pass
                pos += data_len
            pl = hdr.get("payload_length", 0)
            if pl:
                pos += pl
            print(f"  Event: type={hdr['type']}  data={evt_data}")
        except json.JSONDecodeError:
            print(f"  Raw line: {line[:200]}")

    writer.close()
    print("\nDone.")


asyncio.run(main())
