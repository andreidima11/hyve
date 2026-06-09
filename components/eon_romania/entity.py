from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from integrations.base import BaseEntity
from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
_client_mod = import_sibling(_component_dir, "client")
_context_mod = import_sibling(_component_dir, "context")
extract_eon_romania_candidates = _extract_mod.extract_eon_romania_candidates
EonRomaniaClient = _client_mod.EonRomaniaClient
EonRomaniaMfaRequired = _client_mod.EonRomaniaMfaRequired



class EonRomaniaEntity(BaseEntity):
    slug = "eon_romania"
    label = "E.ON România"
    description = "Facturi și consum gaze/electricitate E.ON România — sold restant, istoric facturi, index contoare."
    icon = "fa-bolt"
    color = "text-rose-400"
    scan_interval_seconds = 21600
    uses_refresh_layers = True
    probe_interval_cycles = 4
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "email", "label": "Email", "type": "text", "required": True, "placeholder": "nume@exemplu.ro"},
        {"key": "password", "label": "Parolă", "type": "password", "required": True, "secret": True},
        {
            "key": "selected_contracts",
            "label": "Contracte monitorizate",
            "type": "text",
            "placeholder": "gol = toate, sau coduri separate prin virgulă",
            "help": "După test vezi câte contracte sunt găsite. Poți lăsa gol ca Hyve să le monitorizeze pe toate.",
        },
        {"key": "include_history", "label": "Include istoric/plăți", "type": "bool", "default": False},
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 21600, "min": 1800},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool((section.get("email") or "").strip() and (section.get("password") or "").strip())

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        email = str((data or {}).get("email") or "").strip()
        password = str((data or {}).get("password") or "").strip()
        if not email or not password:
            return {"ok": False, "message_key": "integrations.eon_credentials"}
        try:
            async with EonRomaniaClient(email, password, timeout=20.0) as client:
                return await asyncio.wait_for(client.test_connection(), timeout=35.0)
        except EonRomaniaMfaRequired as exc:
            return {"ok": False, "message": str(exc)}
        except asyncio.TimeoutError:
            return {"ok": False, "message_key": "integrations.eon_timeout"}
        except Exception as exc:
            message = str(exc or "").strip()
            return {"ok": False, "message": message or None, "message_key": "integrations.eon_failed"}

    def _client_kwargs(self) -> dict[str, Any]:
        data = self.entry_data or {}
        email = str(data.get("email") or "").strip()
        password = str(data.get("password") or "").strip()
        if not email or not password:
            raise ValueError("E.ON Romania entry is missing credentials")
        return {
            "username": email,
            "password": password,
            "selected_contracts": data.get("selected_contracts"),
            "include_history": bool(data.get("include_history")),
            "timeout": 30.0,
        }

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        async with EonRomaniaClient(**self._client_kwargs()) as client:
            return await client.fetch_all()

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        async with EonRomaniaClient(**self._client_kwargs()) as client:
            return await client.fetch_light(cached)

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_eon_romania_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_eon_romania_context(entities if isinstance(entities, dict) else {})
