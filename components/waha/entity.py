"""WAHA — WhatsApp HTTP API integration."""

from __future__ import annotations

from typing import Any

import httpx

from integrations.base import BaseEntity


class WahaEntity(BaseEntity):
    slug = "waha"
    label = "WAHA"
    description = "WhatsApp prin WAHA (webhook + mesagerie)."
    icon = "fa-whatsapp"
    color = "text-emerald-400"
    supports_sync = False
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {
            "key": "api_url",
            "label": "API URL",
            "type": "url",
            "required": True,
            "placeholder": "http://localhost:3000",
            "help": "Webhook Hyve: /api/webhook/waha (setează în WAHA).",
        },
        {"key": "api_key", "label": "API key", "type": "password", "secret": True},
        {"key": "session", "label": "Session WAHA", "type": "text", "default": "default"},
        {"key": "username", "label": "Utilizator (basic auth)", "type": "text"},
        {"key": "password", "label": "Parolă (basic auth)", "type": "password", "secret": True},
    ]

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        base = str((data or {}).get("api_url") or "").strip().rstrip("/")
        if not base:
            return {"ok": False, "message": "API URL este obligatoriu."}
        headers = {}
        api_key = str((data or {}).get("api_key") or "").strip()
        if api_key:
            headers["X-Api-Key"] = api_key
        auth = None
        user = str((data or {}).get("username") or "").strip()
        password = str((data or {}).get("password") or "")
        if user:
            auth = (user, password)
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                resp = await client.get(f"{base}/api/sessions", headers=headers, auth=auth)
                if resp.status_code >= 400:
                    return {"ok": False, "message": f"HTTP {resp.status_code}"}
                return {"ok": True, "message": "Conectat la WAHA."}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or "Conexiune WAHA eșuată"}

    async def fetch_entities(self) -> dict[str, Any]:
        return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return []
