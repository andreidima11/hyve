"""Minimal Wyoming protocol test - just send describe and see response."""
import asyncio
import json


async def main():
    host, port = "localhost", 10300
    print(f"Connecting to {host}:{port}...")
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port), timeout=5
    )
    print("Connected!")

    # Test 1: describe event
    header = {"type": "describe", "data": {}, "version": "1.0"}
    msg = json.dumps(header).encode("utf-8") + b"\n"
    print(f"Sending: {msg}")
    writer.write(msg)
    await writer.drain()

    print("Waiting for response...")
    try:
        data = await asyncio.wait_for(reader.read(65536), timeout=10)
        print(f"Response ({len(data)} bytes):")
        # Try to parse lines
        for line in data.split(b"\n"):
            line = line.strip()
            if line:
                try:
                    parsed = json.loads(line)
                    print(f"  {json.dumps(parsed, indent=2)}")
                except json.JSONDecodeError:
                    print(f"  RAW: {line[:300]}")
    except asyncio.TimeoutError:
        print("No response within 10 seconds!")

    writer.close()
    print("Done.")


asyncio.run(main())
