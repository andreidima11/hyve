from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import database
import midea_ac_client
from sqlalchemy import text
from integrations.base import BaseEntity
from pathlib import Path

from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_midea_ac_candidates = _extract_mod.extract_midea_ac_candidates


log = logging.getLogger("midea_ac")


class MideaAcEntity(BaseEntity):
    slug = "midea_ac"
    label = "Midea AC"
    description = "Aparate de aer condiționat Midea/Comfee — control temperatură, mod (răcire/încălzire/ventilare), ventilator."
    icon = "fa-snowflake"
    color = "text-sky-400"
    scan_interval_seconds = 60
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {
            "key": "account",
            "label": "Cont Midea (doar prima descoperire)",
            "type": "text",
            "placeholder": "email — folosit o singură dată pentru token/key V3",
            "help": "După prima descoperire reușită, token-ul și cheia fiecărui aer condiționat sunt cache-uite local și cloud-ul Midea nu mai este folosit.",
        },
        {"key": "password", "label": "Parolă Midea (doar prima descoperire)", "type": "password", "secret": True},
        {
            "key": "region",
            "label": "Țară cloud",
            "type": "select",
            "default": "US",
            "options": [
                {"value": "US", "label": "US (NetHome Plus)"},
                {"value": "DE", "label": "DE / EU"},
                {"value": "KR", "label": "KR / SEA"},
                {"value": "CN", "label": "CN (SmartHome China, cere cont)"},
            ],
            "help": "Compatibil cu msmart-ng: EU este mapat la DE, SEA la KR. CN cere cont SmartHome China sau configurare manuală token/key.",
        },
        {
            "key": "cloud_provider",
            "label": "Provider cloud",
            "type": "select",
            "default": "auto",
            "options": [
                {"value": "auto", "label": "Auto"},
                {"value": "nethome", "label": "NetHome Plus"},
                {"value": "smarthome", "label": "SmartHome / MSmartHome"},
                {"value": "smarthome_china", "label": "SmartHome China"},
            ],
            "help": "Auto încearcă NetHome Plus, apoi SmartHome când există cont/parolă, iar la final credențialele publice msmart-ng pentru token/key.",
        },
        {
            "key": "discovery_target",
            "label": "Adresă broadcast LAN",
            "type": "text",
            "default": "255.255.255.255",
            "help": "Folosește IP-ul de broadcast al subrețelei (ex. 192.168.1.255) dacă routerul blochează 255.255.255.255.",
        },
        {
            "key": "devices",
            "label": "Dispozitive manuale (JSON, opțional)",
            "type": "text",
            "placeholder": '[{"name":"Living","host":"192.168.1.50","id":12345678901234,"token":"…","key":"…"}]',
            "help": "Folosește când broadcast-ul nu funcționează. Pentru V3 e nevoie de token și key. Lasă gol pentru auto-discovery.",
        },
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 60, "min": 30},
    ]

    # ── helpers ───────────────────────────────────────────────────────
    @classmethod
    def _parse_cached(cls, raw: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if not isinstance(raw, list):
            return out
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            host = str(entry.get("host") or "").strip()
            try:
                dev_id = int(entry.get("id") or 0)
            except (TypeError, ValueError):
                dev_id = 0
            if not host or not dev_id:
                continue
            out.append({
                "host": host,
                "port": int(entry.get("port") or 6444),
                "id": dev_id,
                "token": (str(entry.get("token") or "").strip() or None),
                "key": (str(entry.get("key") or "").strip() or None),
                "name": str(entry.get("name") or "").strip(),
            })
        return out

    @classmethod
    def _remembered_lan_devices(cls) -> list[dict[str, Any]]:
        """Return host/id pairs from previous Midea snapshots.

        These rows do not carry token/key, but they let setup target the real
        AC IPs directly instead of relying on LAN broadcast discovery.
        """
        devices: dict[int, dict[str, Any]] = {}
        try:
            session_gen = database.get_db()
            db = next(session_gen)
        except Exception as exc:  # pragma: no cover - defensive
            log.debug("midea remembered devices skipped: %s", exc)
            return []
        try:
            rows = db.execute(
                text(
                    "SELECT entity_data FROM integration_entities "
                    "WHERE integration_slug = :slug OR integration_slug LIKE :prefix"
                ),
                {"slug": cls.slug, "prefix": f"{cls.slug}:%"},
            ).fetchall()
            for (raw_payload,) in rows:
                try:
                    payload = json.loads(raw_payload or "{}")
                except (TypeError, json.JSONDecodeError):
                    continue
                for item in payload.get("devices") or []:
                    if not isinstance(item, dict):
                        continue
                    host = str(item.get("ip") or item.get("host") or "").strip()
                    try:
                        dev_id = int(item.get("id") or item.get("device_id") or 0)
                    except (TypeError, ValueError):
                        dev_id = 0
                    if not host or not dev_id:
                        continue
                    devices[dev_id] = {
                        "host": host,
                        "port": int(item.get("port") or 6444),
                        "id": dev_id,
                        "token": None,
                        "key": None,
                        "name": str(item.get("name") or "").strip(),
                    }
        except Exception as exc:  # pragma: no cover - best effort
            log.debug("midea remembered devices read failed: %s", exc)
        finally:
            try:
                session_gen.close()
            except Exception:
                pass
        return list(devices.values())

    @classmethod
    def _build_client(
        cls,
        data: dict[str, Any],
        *,
        cache_callback=None,
        include_remembered: bool = False,
    ) -> midea_ac_client.MideaAcClient:
        manual_devices = midea_ac_client.parse_devices_field(data.get("devices"))
        cached_devices = cls._parse_cached(data.get("_cached_devices"))
        if include_remembered and not manual_devices:
            cached_ids = {int(item.get("id") or 0) for item in cached_devices if item.get("id")}
            manual_devices = [item for item in cls._remembered_lan_devices() if int(item.get("id") or 0) not in cached_ids]
        return midea_ac_client.MideaAcClient(
            account=str(data.get("account") or "").strip(),
            password=str(data.get("password") or "").strip(),
            region=str(data.get("region") or "US").strip(),
            cloud_provider=str(data.get("cloud_provider") or "auto").strip(),
            discovery_target=str(data.get("discovery_target") or "255.255.255.255").strip(),
            devices=manual_devices,
            cached_devices=cached_devices,
            cache_callback=cache_callback,
        )

    def _make_cache_callback(self):
        """Return a callback that persists discovered token/key tuples back
        into the integration entry, so subsequent syncs skip the cloud."""
        entry_id = self.entry_id
        if not entry_id or entry_id == "__test__":
            return None

        def _persist(snapshot: list[dict[str, Any]]) -> None:
            try:
                from integrations import config_entries as _ce
            except Exception as exc:  # pragma: no cover - import guard
                log.debug("midea cache persist skipped: %s", exc)
                return
            try:
                existing = _ce.get_entry(entry_id) or {}
                prev = (existing.get("data") or {}).get("_cached_devices") or []
                by_id: dict[int, dict[str, Any]] = {}
                if isinstance(prev, list):
                    for item in prev:
                        if isinstance(item, dict) and item.get("id"):
                            try:
                                by_id[int(item["id"])] = dict(item)
                            except (TypeError, ValueError):
                                continue
                for item in snapshot:
                    by_id[int(item["id"])] = dict(item)
                merged = list(by_id.values())
                _ce.update_entry(
                    entry_id,
                    data={"_cached_devices": merged},
                    schema=self.get_config_schema(),
                )
                # Keep in-memory copy in sync so the running provider uses the
                # cached devices on the very next sync without a reload.
                self.entry_data["_cached_devices"] = merged
                log.info("midea_ac %s: cached %d device(s) for offline use", entry_id[:8], len(merged))
            except Exception as exc:
                log.warning("midea cache persist failed: %s", exc)

        return _persist

    # ── BaseEntity overrides ──────────────────────────────────────────
    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        try:
            manual = midea_ac_client.parse_devices_field(section.get("devices"))
        except midea_ac_client.MideaAcError:
            manual = []
        cached = self._parse_cached(section.get("_cached_devices"))
        has_account = bool((section.get("account") or "").strip() and (section.get("password") or "").strip())
        return bool(manual) or bool(cached) or has_account or bool((section.get("discovery_target") or "").strip())

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        try:
            client = cls._build_client(dict(data or {}), include_remembered=True)
        except midea_ac_client.MideaAcError as exc:
            return {"ok": False, "message": str(exc)}
        try:
            return await asyncio.wait_for(client.test_connection(), timeout=30.0)
        except asyncio.TimeoutError:
            return {"ok": False, "message_key": "integrations.midea_timeout"}
        except midea_ac_client.MideaAcDependencyError as exc:
            return {"ok": False, "message": str(exc)}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or None, "message_key": "integrations.midea_failed"}

    async def fetch_entities(self) -> dict[str, Any]:
        data = self.entry_data or {}
        client = self._build_client(data, cache_callback=self._make_cache_callback())
        async with client:
            return await client.fetch_all()

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_midea_ac_candidates(payload)

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        client = self._build_client(self.entry_data or {}, cache_callback=self._make_cache_callback())
        async with client:
            return await client.control_entity(entity_id, action, data)

    def format_context(self, entities: dict[str, Any]) -> str:
        items = self.extract_entities(entities)
        if not items:
            return ""
        powered = [item for item in items if item.get("entity_id", "").endswith(":power") and str(item.get("state")) == "on"]
        return f"Midea AC: {len(items)} entități, {len(powered)} pornite"
