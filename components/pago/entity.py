from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.base import BaseEntity
from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
_client_mod = import_sibling(_component_dir, "client")
_context_mod = import_sibling(_component_dir, "context")
extract_pago_candidates = _extract_mod.extract_pago_candidates
PagoClient = _client_mod.PagoClient


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

    async def _client(self) -> PagoClient:
        if self.entry_data:
            email = (self.entry_data.get("email") or "").strip()
            password = (self.entry_data.get("password") or "").strip()
            if not email or not password:
                raise ValueError("Pago entry is missing credentials")
            ttl = int(self.entry_data.get("scan_interval") or 3600)
            return PagoClient(email, password, cache_ttl=ttl)
        raise ValueError("Pago is not configured — add a config entry")

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        client = await self._client()
        return await client.fetch_all()

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        client = await self._client()
        return await client.fetch_light(cached)

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_pago_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_pago_context(entities if isinstance(entities, dict) else {})
