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
extract_fusion_solar_candidates = _extract_mod.extract_fusion_solar_candidates
FusionSolarClient = _client_mod.FusionSolarClient
FusionSolarKioskClient = _client_mod.FusionSolarKioskClient
FusionSolarRateLimitError = _client_mod.FusionSolarRateLimitError


# Reuse one API client per config entry so token + in-memory rate-limit
# caches survive between sync cycles. Creating a fresh client every 600 s
# forced a re-login and discarded Huawei cooldown state.
_ENTRY_CLIENTS: dict[str, Any] = {}


class FusionSolarEntity(BaseEntity):
    slug = "fusion_solar"
    label = "FusionSolar"
    description = "Panouri fotovoltaice Huawei FusionSolar — producție energie solară, consum, export rețea și stare invertor."
    icon = "fa-solar-panel"
    color = "text-amber-400"
    scan_interval_seconds = 90
    fetch_timeout_seconds = 120.0
    uses_refresh_layers = True
    probe_interval_cycles = 40
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "mode", "label": "Mod", "type": "select", "default": "auto", "options": [
            {"value": "auto", "label": "Auto"},
            {"value": "openapi", "label": "OpenAPI (user/parolă)"},
            {"value": "kiosk", "label": "Kiosk URL"},
        ]},
        {"key": "host", "label": "Host", "type": "text", "placeholder": "uni005eu5.fusionsolar.huawei.com"},
        {"key": "username", "label": "Utilizator", "type": "text"},
        {"key": "password", "label": "Parolă", "type": "password", "secret": True},
        {"key": "kiosk_url", "label": "Kiosk URL", "type": "url", "placeholder": "https://…?kk=…"},
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 90, "min": 60,
         "help": "Light pull ~90s (HA-style). Full device discovery probe runs every ~40 cycles."},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        has_auth = bool((section.get("username") or "").strip() and (section.get("password") or "").strip())
        has_kiosk = bool((section.get("kiosk_url") or "").strip() or ("kk=" in str(section.get("host") or "")))
        return has_auth or has_kiosk

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        d = dict(data or {})
        mode = str(d.get("mode") or "auto").strip().lower()
        host = str(d.get("host") or "https://eu5.fusionsolar.huawei.com").strip()
        kiosk_url = str(d.get("kiosk_url") or "").strip()
        if not kiosk_url and "kk=" in host:
            kiosk_url = host
        username = (d.get("username") or "").strip()
        password = (d.get("password") or "").strip()
        wants_kiosk = mode == "kiosk" or (kiosk_url and mode == "auto" and (not username or not password))

        try:
            if wants_kiosk:
                if not kiosk_url:
                    return {"ok": False, "message_key": "integrations.fusion_solar_kiosk_url"}
                client = FusionSolarKioskClient(kiosk_url, timeout=8.0)
                return await asyncio.wait_for(client.test_connection(), timeout=15.0)

            if not username or not password:
                return {"ok": False, "message_key": "integrations.fusion_solar_credentials"}

            client = FusionSolarClient(host, username, password, timeout=15.0)
            return await asyncio.wait_for(client.test_connection(), timeout=45.0)
        except asyncio.TimeoutError:
            return {"ok": False, "message_key": "integrations.fusion_solar_timeout"}
        except FusionSolarRateLimitError as exc:
            return {
                "ok": True,
                "message_key": "integrations.fusion_solar_rate_limit_ok",
                "message_params": {"detail": str(exc)},
            }
        except Exception as exc:
            message = str(exc or "").strip()
            if "rate limit" in message.lower():
                return {
                    "ok": True,
                    "message_key": "integrations.fusion_solar_rate_limit_ok",
                    "message_params": {"detail": message},
                }
            if "user.login.user_or_value_invalid" in message:
                return {"ok": False, "message_key": "integrations.fusion_solar_invalid_login"}
            return {"ok": False, "message": message or None, "message_key": "integrations.fusion_solar_failed"}

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        client = await self._ensure_entry_client()
        if cached and hasattr(client, "fetch_probe"):
            return await client.fetch_probe(cached)
        return await client.fetch_all()

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        client = await self._ensure_entry_client()
        if hasattr(client, "fetch_realtime"):
            return await client.fetch_realtime(cached)
        return await client.fetch_all()

    async def _ensure_entry_client(self):
        """Return a persistent FusionSolar client for this config entry."""
        if not self.entry_data:
            raise ValueError("FusionSolar is not configured — add a config entry")

        key = self.entry_id or self.store_key
        d = self.entry_data
        mode = str(d.get("mode") or "auto").strip().lower()
        host = str(d.get("host") or "https://eu5.fusionsolar.huawei.com").strip()
        kiosk_url = str(d.get("kiosk_url") or "").strip()
        if not kiosk_url and "kk=" in host:
            kiosk_url = host
        username = (d.get("username") or "").strip()
        password = (d.get("password") or "").strip()
        wants_kiosk = mode == "kiosk" or (kiosk_url and mode == "auto" and (not username or not password))

        existing = _ENTRY_CLIENTS.get(key)
        import core.settings as settings_mod

        def _finalize(c):
            if hasattr(c, "set_user_sync_interval"):
                c.set_user_sync_interval(self.sync_interval(settings_mod.CFG))
            return c

        if wants_kiosk:
            if not kiosk_url:
                raise ValueError("FusionSolar kiosk_url is required")
            if (
                existing is not None
                and isinstance(existing, FusionSolarKioskClient)
                and existing._kiosk_url == kiosk_url
            ):
                return _finalize(existing)
            client = FusionSolarKioskClient(kiosk_url)
        elif username and password:
            host_norm = host.rstrip("/")
            if (
                existing is not None
                and isinstance(existing, FusionSolarClient)
                and existing._host == host_norm
                and existing._username == username
                and existing._password == password
            ):
                return _finalize(existing)
            client = FusionSolarClient(host, username, password)
        elif kiosk_url:
            if (
                existing is not None
                and isinstance(existing, FusionSolarKioskClient)
                and existing._kiosk_url == kiosk_url
            ):
                return _finalize(existing)
            client = FusionSolarKioskClient(kiosk_url)
        else:
            raise ValueError("FusionSolar entry is missing credentials")

        _ENTRY_CLIENTS[key] = client
        return _finalize(client)

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_fusion_solar_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_fusion_solar_context(entities if isinstance(entities, dict) else {})