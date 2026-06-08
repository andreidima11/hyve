"""Wyoming Piper — text-to-speech service integration."""

from __future__ import annotations

import asyncio
from typing import Any

from integrations.base import BaseEntity


class PiperEntity(BaseEntity):
    slug = "piper"
    label = "Piper"
    description = "Wyoming Piper — sinteză vocală pentru răspunsurile AI."
    icon = "fa-volume-up"
    color = "text-cyan-400"
    supports_sync = False
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {
            "key": "voice",
            "label": "Voce",
            "type": "select",
            "default": "ro_RO-mihai-medium",
            "options": [
                {"value": "ro_RO-mihai-medium", "label": "ro_RO Mihai (medium)"},
                {"value": "ro_RO-lili-high", "label": "ro_RO Lili (high)"},
                {"value": "en_US-lessac-medium", "label": "en_US Lessac"},
            ],
        },
        {"key": "host", "label": "Host server", "type": "text", "default": "localhost", "required": True},
        {"key": "port", "label": "Port", "type": "number", "default": 10200, "min": 1, "max": 65535},
        {"key": "speaker_id", "label": "Speaker ID", "type": "number", "default": 0, "min": 0},
        {"key": "length_scale", "label": "Viteză vorbire", "type": "text", "default": "1.0", "placeholder": "1.0"},
    ]

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        host = str((data or {}).get("host") or "localhost").strip() or "localhost"
        try:
            port = int((data or {}).get("port") or 10200)
        except (TypeError, ValueError):
            port = 10200
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"ok": True, "message": f"Conectat la Piper ({host}:{port})."}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or "Conexiune Piper eșuată"}

    async def fetch_entities(self) -> dict[str, Any]:
        return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return []
