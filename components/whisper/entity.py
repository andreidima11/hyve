"""Wyoming Faster Whisper — speech-to-text service integration."""

from __future__ import annotations

import asyncio
from typing import Any

from integrations.base import BaseEntity


class WhisperEntity(BaseEntity):
    slug = "whisper"
    label = "Whisper"
    description = "Wyoming Faster Whisper — transcriere vocală în chat."
    icon = "fa-microphone"
    color = "text-amber-400"
    supports_sync = False
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {"key": "host", "label": "Host server", "type": "text", "default": "localhost", "required": True},
        {"key": "port", "label": "Port", "type": "number", "default": 10300, "min": 1, "max": 65535},
        {
            "key": "language",
            "label": "Limbă",
            "type": "select",
            "default": "ro",
            "options": [
                {"value": "ro", "label": "Română"},
                {"value": "en", "label": "English"},
                {"value": "de", "label": "Deutsch"},
                {"value": "auto", "label": "Auto"},
            ],
        },
        {"key": "vad_silence_ms", "label": "VAD silence (ms)", "type": "number", "default": 2500, "min": 500, "max": 10000},
        {
            "key": "vad_sensitivity",
            "label": "VAD sensitivity",
            "type": "select",
            "default": "medium",
            "options": [
                {"value": "low", "label": "Low"},
                {"value": "medium", "label": "Medium"},
                {"value": "high", "label": "High"},
            ],
        },
    ]

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        host = str((data or {}).get("host") or "localhost").strip() or "localhost"
        try:
            port = int((data or {}).get("port") or 10300)
        except (TypeError, ValueError):
            port = 10300
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
            writer.close()
            await writer.wait_closed()
            return {"ok": True, "message": f"Conectat la Whisper ({host}:{port})."}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or "Conexiune Whisper eșuată"}

    async def fetch_entities(self) -> dict[str, Any]:
        return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return []
