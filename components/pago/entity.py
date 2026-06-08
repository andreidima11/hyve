from __future__ import annotations

from typing import Any

import pago_client
from integrations.base import BaseEntity
from pathlib import Path

from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_pago_candidates = _extract_mod.extract_pago_candidates



class PagoEntity(BaseEntity):
    slug = "pago"
    label = "Pago"
    description = "Facturi și plăți prin Pago — monitorizare facturi restante la utilități (curent, gaz, apă, internet etc.)."
    icon = "fa-credit-card"
    color = "text-emerald-400"
    scan_interval_seconds = 3600
    uses_refresh_layers = True
    probe_interval_cycles = 6
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "email", "label": "Email", "type": "text", "required": True, "placeholder": "nume@exemplu.ro"},
        {"key": "password", "label": "Parolă", "type": "password", "required": True, "secret": True},
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 3600, "min": 300},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool((section.get("email") or "").strip() and (section.get("password") or "").strip())

    async def _client(self) -> pago_client.PagoClient:
        if self.entry_data:
            email = (self.entry_data.get("email") or "").strip()
            password = (self.entry_data.get("password") or "").strip()
            if not email or not password:
                raise ValueError("Pago entry is missing credentials")
            ttl = int(self.entry_data.get("scan_interval") or 3600)
            return pago_client.PagoClient(email, password, cache_ttl=ttl)
        client = await pago_client.ensure_client()
        if not client:
            raise ValueError("Pago is not configured")
        return client

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self) -> dict[str, Any]:
        client = await self._client()
        return await client.fetch_all()

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        client = await self._client()
        return await client.fetch_light(cached)

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_pago_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        from integrations.context_formatters import format_pago_context
        return format_pago_context(entities if isinstance(entities, dict) else {})