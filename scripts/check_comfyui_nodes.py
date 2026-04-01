#!/usr/bin/env python3
"""Quick script to check available ComfyUI nodes."""
import httpx
import json
import sys

url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
try:
    r = httpx.get(f"{url}/object_info", timeout=10)
    info = r.json()
    nodes = sorted(info.keys())
    print(f"Total nodes: {len(nodes)}")
    keywords = ["flux", "clip", "sampl", "guider", "unet", "conditioning", "ksampler"]
    for n in nodes:
        nl = n.lower()
        if any(k in nl for k in keywords):
            print(f"  {n}")
except Exception as e:
    print(f"Error: {e}")
