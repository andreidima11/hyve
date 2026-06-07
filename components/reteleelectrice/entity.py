from __future__ import annotations

import asyncio
from typing import Any

import reteleelectrice_client
from integrations.base import BaseEntity
from pathlib import Path

from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_reteleelectrice_candidates = _extract_mod.extract_reteleelectrice_candidates



class ReteleElectriceEntity(BaseEntity):
    slug = "reteleelectrice"
    label = "Rețele Electrice"
    description = "Monitorizare întreruperi de curent programate/neprogramate de la Distribuție Energie Oltenia (CEO/Rețele Electrice)."
    icon = "fa-bolt-lightning"
    color = "text-amber-400"
    scan_interval_seconds = 3600
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
            async with reteleelectrice_client.ReteleElectriceClient(
                email, password, timeout=30.0
            ) as client:
                return await asyncio.wait_for(client.test_connection(), timeout=60.0)
        except asyncio.TimeoutError:
            return {"ok": False, "message_key": "integrations.reteleelectrice_timeout"}
        except Exception as exc:  # noqa: BLE001
            message = str(exc or "").strip()
            return {"ok": False, "message": message or None, "message_key": "integrations.reteleelectrice_failed"}

    async def fetch_entities(self) -> dict[str, Any]:
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
        async with reteleelectrice_client.ReteleElectriceClient(
            email, password, timeout=60.0, selected_pods=pods_list or None,
        ) as client:
            return await client.fetch_all()

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_reteleelectrice_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        items = self.extract_entities(entities)
        outages = [
            i for i in items
            if "intreruperi" in i.get("entity_id", "")
            and str(i.get("state", "")).lower() == "on"
        ]
        parts = [f"Rețele Electrice: {len(items)} entități"]
        if outages:
            parts.append(f"{len(outages)} POD cu întrerupere activă")
        return "; ".join(parts)
