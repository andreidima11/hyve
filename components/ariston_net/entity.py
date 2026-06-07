from __future__ import annotations

from typing import Any

import ariston_net_client
from integrations.base import BaseEntity
from pathlib import Path

from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_ariston_net_candidates = _extract_mod.extract_ariston_net_candidates



class AristonNetEntity(BaseEntity):
    slug = "ariston_net"
    label = "AristonNET"
    description = "Centrală termică/boiler Ariston — temperatură apă, mod încălzire, consum energie și programare."
    icon = "fa-fire-flame-simple"
    color = "text-red-400"
    scan_interval_seconds = 180
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "username", "label": "Utilizator", "type": "text", "required": True},
        {"key": "password", "label": "Parolă", "type": "password", "required": True, "secret": True},
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 180, "min": 60},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool((section.get("username") or "").strip() and (section.get("password") or "").strip())

    async def fetch_entities(self) -> dict[str, Any]:
        if self.entry_data:
            d = self.entry_data
            username = (d.get("username") or "").strip()
            password = (d.get("password") or "").strip()
            if not username or not password:
                raise ValueError("AristonNET entry is missing credentials")
            client = ariston_net_client.AristonNetClient(
                username,
                password,
                cache_ttl=int(d.get("scan_interval") or 180),
            )
            return await client.fetch_all()
        client = await ariston_net_client.ensure_client()
        if not client:
            raise ValueError("AristonNET is not configured")
        return await client.fetch_all()

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_ariston_net_candidates(payload)

    async def control_entity(self, entity_id: str, action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.entry_data:
            d = self.entry_data
            username = (d.get("username") or "").strip()
            password = (d.get("password") or "").strip()
            if not username or not password:
                raise ValueError("AristonNET entry is missing credentials")
            client = ariston_net_client.AristonNetClient(
                username, password, cache_ttl=int(d.get("scan_interval") or 180),
            )
            return await client.control_entity(entity_id, action, data)
        client = await ariston_net_client.ensure_client()
        if not client:
            raise ValueError("AristonNET is not configured")
        return await client.control_entity(entity_id, action, data)
