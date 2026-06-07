from __future__ import annotations

import asyncio
from typing import Any

import eon_romania_client
from integrations.base import BaseEntity
from pathlib import Path

from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_eon_romania_candidates = _extract_mod.extract_eon_romania_candidates



class EonRomaniaEntity(BaseEntity):
    slug = "eon_romania"
    label = "E.ON România"
    description = "Facturi și consum gaze/electricitate E.ON România — sold restant, istoric facturi, index contoare."
    icon = "fa-bolt"
    color = "text-rose-400"
    scan_interval_seconds = 21600
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
            async with eon_romania_client.EonRomaniaClient(email, password, timeout=20.0) as client:
                return await asyncio.wait_for(client.test_connection(), timeout=35.0)
        except eon_romania_client.EonRomaniaMfaRequired as exc:
            return {"ok": False, "message": str(exc)}
        except asyncio.TimeoutError:
            return {"ok": False, "message_key": "integrations.eon_timeout"}
        except Exception as exc:
            message = str(exc or "").strip()
            return {"ok": False, "message": message or None, "message_key": "integrations.eon_failed"}

    async def fetch_entities(self) -> dict[str, Any]:
        data = self.entry_data or {}
        email = str(data.get("email") or "").strip()
        password = str(data.get("password") or "").strip()
        if not email or not password:
            raise ValueError("E.ON Romania entry is missing credentials")
        async with eon_romania_client.EonRomaniaClient(
            email,
            password,
            selected_contracts=data.get("selected_contracts"),
            include_history=bool(data.get("include_history")),
            timeout=30.0,
        ) as client:
            return await client.fetch_all()

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_eon_romania_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        items = self.extract_entities(entities)
        bills = [item for item in items if "factura_restanta" in item.get("entity_id", "") and str(item.get("state")) == "Da"]
        balances = [item for item in items if "sold_factura" in item.get("entity_id", "") and str(item.get("state")) == "Da"]
        parts = [f"E.ON România: {len(items)} entități"]
        if balances:
            parts.append(f"{len(balances)} contracte cu sold")
        if bills:
            parts.append(f"{len(bills)} contracte cu facturi restante")
        return "; ".join(parts)
