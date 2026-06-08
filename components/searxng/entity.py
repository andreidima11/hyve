"""SearXNG — private web search integration."""

from __future__ import annotations

from typing import Any

import urllib.parse

import httpx

from integrations.base import BaseEntity

_SEARXNG_URL_DEFAULT = "http://localhost:8888"


class SearxngEntity(BaseEntity):
    slug = "searxng"
    label = "SearXNG"
    description = "Căutare web privată prin instanță SearXNG."
    icon = "fa-magnifying-glass"
    color = "text-blue-400"
    supports_sync = False
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {
            "key": "url",
            "label": "URL SearXNG",
            "type": "url",
            "required": True,
            "placeholder": _SEARXNG_URL_DEFAULT,
            "default": _SEARXNG_URL_DEFAULT,
            "help": "Adresa de bază a serverului SearXNG (fără parametri de căutare).",
        },
        {"key": "fetch_pages", "label": "Descarcă pagini din rezultate", "type": "bool", "default": True},
        {"key": "max_pages_to_fetch", "label": "Max pagini / căutare", "type": "number", "default": 2, "min": 0, "max": 3},
        {"key": "max_search_results", "label": "Max rezultate", "type": "number", "default": 5, "min": 1, "max": 20},
        {"key": "search_timeout", "label": "Timeout căutare (sec)", "type": "number", "default": 10, "min": 3, "max": 60},
        {"key": "max_searches_per_request", "label": "Max căutări / mesaj", "type": "number", "default": 5, "min": 1, "max": 20},
    ]

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        raw = str((data or {}).get("url") or "").strip().rstrip("/")
        if not raw:
            return {"ok": False, "message": "URL SearXNG este obligatoriu."}
        query = "hyve"
        if "%3Cquery%3E" in raw:
            test_url = raw.replace("%3Cquery%3E", urllib.parse.quote(query))
        elif "<query>" in raw:
            test_url = raw.replace("<query>", urllib.parse.quote(query))
        else:
            base = raw.split("?")[0].rstrip("/")
            test_url = f"{base}/search?q={urllib.parse.quote(query)}&format=json"
        try:
            async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
                resp = await client.get(test_url)
                if resp.status_code >= 400:
                    return {"ok": False, "message": f"HTTP {resp.status_code}"}
                return {"ok": True, "message": "Conectat la SearXNG."}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or "Conexiune SearXNG eșuată"}

    async def fetch_entities(self) -> dict[str, Any]:
        return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return []
