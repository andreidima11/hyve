"""Wyoming protocol framing helpers (Piper TTS, Whisper STT, …)."""

from __future__ import annotations

import json
from typing import Iterator, Optional


def make_event(
    event_type: str,
    data: Optional[dict] = None,
    payload: Optional[bytes] = None,
) -> bytes:
    header: dict = {"type": event_type, "version": "1.0"}
    data_bytes = b""
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


def parse_events(raw: bytes) -> Iterator[tuple[str, dict, bytes]]:
    pos = 0
    while pos < len(raw):
        nl = raw.find(b"\n", pos)
        if nl == -1:
            break
        line = raw[pos:nl].strip()
        pos = nl + 1
        if not line:
            continue
        try:
            header = json.loads(line)
        except json.JSONDecodeError:
            continue
        data_length = header.get("data_length", 0)
        evt_data: dict = {}
        if data_length and pos + data_length <= len(raw):
            try:
                evt_data = json.loads(raw[pos : pos + data_length])
            except json.JSONDecodeError:
                pass
            pos += data_length
        payload_length = header.get("payload_length", 0)
        payload = b""
        if payload_length and pos + payload_length <= len(raw):
            payload = raw[pos : pos + payload_length]
            pos += payload_length
        yield header.get("type", ""), evt_data, payload
