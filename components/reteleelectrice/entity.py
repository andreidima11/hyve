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
extract_reteleelectrice_candidates = _extract_mod.extract_reteleelectrice_candidates
ReteleElectriceClient = _client_mod.ReteleElectriceClient



class ReteleElectriceEntity(BaseEntity):
    slug = "reteleelectrice"
    label = "Rețele Electrice"
    description = "Monitorizare întreruperi de curent programate/neprogramate de la Distribuție Energie Oltenia (CEO/Rețele Electrice)."
    icon = "fa-bolt-lightning"
    color = "text-amber-400"
    scan_interval_seconds = 3600
    uses_refresh_layers = True
    probe_interval_cycles = 6
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "email", "label": "Email", "type": "text", "required": True,
         "placeholder": "nume@exemplu.ro",
         "help": "Contul contulmeu.reteleelectrice.ro"},
        {"key": "password", "label": "Parolă", "type": "password",
         "required": True, "secret": True},
        {"key": "selected_pods", "label": "POD-uri monitorizate",
         "type": "text",
         "placeholder": "gol = toate, sau ex: RO001E12345, RO001E67890",
         "help": "După primul sync vei vedea câte POD-uri sunt găsite. Lasă gol pentru toate."},
        {"key": "scan_interval", "label": "Interval sync (sec)",
         "type": "number", "default": 3600, "min": 1800, "max": 86400},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool(
            (section.get("email") or "").strip()
            and (section.get("password") or "").strip()
        )

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        email = str((data or {}).get("email") or "").strip()
        password = str((data or {}).get("password") or "").strip()
        if not email or not password:
            return {"ok": False, "message_key": "integrations.reteleelectrice_credentials"}
        try:
            async with ReteleElectriceClient(
                email, password, timeout=30.0
            ) as client:
                return await asyncio.wait_for(client.test_connection(), timeout=60.0)
        except asyncio.TimeoutError:
            return {"ok": False, "message_key": "integrations.reteleelectrice_timeout"}
        except Exception as exc:  # noqa: BLE001
            message = str(exc or "").strip()
            return {"ok": False, "message": message or None, "message_key": "integrations.reteleelectrice_failed"}

    def _client_kwargs(self) -> dict[str, Any]:
        data = self.entry_data or {}
        email = str(data.get("email") or "").strip()
        password = str(data.get("password") or "").strip()
        if not email or not password:
            raise ValueError("Rețele Electrice entry is missing credentials")
        raw_pods = data.get("selected_pods")
        if isinstance(raw_pods, list):
            pods_list = [str(p).strip() for p in raw_pods if str(p).strip()]
        else:
            pods_list = [
                p.strip() for p in str(raw_pods or "").replace("\n", ",").split(",")
                if p.strip()
            ]
        return {
            "username": email,
            "password": password,
            "timeout": 60.0,
            "selected_pods": pods_list or None,
        }

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        async with ReteleElectriceClient(**self._client_kwargs()) as client:
            return await client.fetch_all()

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        async with ReteleElectriceClient(**self._client_kwargs()) as client:
            return await client.fetch_light(cached)

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_reteleelectrice_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_reteleelectrice_context(entities if isinstance(entities, dict) else {})
