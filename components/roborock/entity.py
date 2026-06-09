"""Roborock vacuum integration (hybrid local + cloud).

Authentication uses the two-step Roborock cloud flow on the **v4** endpoints.
After login, ``python-roborock`` prefers **LAN control** (TCP 58867 / UDP 58866)
when Hyve can reach the vacuum on the local network, and falls back to cloud
MQTT otherwise — same model as the Home Assistant Roborock integration.

Cloud is still used for initial discovery, MQTT push updates, maps and routines.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from pathlib import Path
from integrations.component_import import import_sibling
from integrations.base import BaseEntity

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
_cache_mod = import_sibling(_component_dir, "cache")
_transport_mod = import_sibling(_component_dir, "transport")
_context_mod = import_sibling(_component_dir, "context")
extract_roborock_candidates = _extract_mod.extract_roborock_candidates
_friendly_auth_error = _extract_mod._friendly_auth_error
EntryRoborockCache = _cache_mod.EntryRoborockCache
network_ip_from_cache = _cache_mod.network_ip_from_cache
device_transport_snapshot = _transport_mod.device_transport_snapshot
transport_log_message = _transport_mod.transport_log_message


def _safe(fn: Any, default: Any = None) -> Any:
    try:
        return fn()
    except Exception:
        return default


def _enum_code(value: Any) -> Any:
    return getattr(value, "value", value)


def _enum_name(value: Any) -> str | None:
    name = getattr(value, "name", None)
    return name if isinstance(name, str) else None


def _status_snapshot(st: Any) -> dict[str, Any]:
    return {
        "state": _enum_code(st.state),
        "state_name": _safe(lambda: st.state_name),
        "battery": st.battery,
        "clean_time": st.clean_time,
        "clean_area": st.clean_area,
        "square_meter_clean_area": _safe(lambda: st.square_meter_clean_area),
        "error_code": _enum_code(st.error_code),
        "error_code_name": _safe(lambda: st.error_code_name),
        "fan_power": st.fan_power,
        "fan_speed_name": _safe(lambda: st.fan_speed_name),
        "water_box_mode": st.water_box_mode,
        "water_mode_name": _safe(lambda: st.water_mode_name),
        "mop_mode": st.mop_mode,
        "mop_route_name": _safe(lambda: st.mop_route_name),
        "in_cleaning": _enum_code(st.in_cleaning),
        "charge_status": _enum_code(st.charge_status),
        "dock_state": _safe(lambda: getattr(st.dock_state, "value", st.dock_state)),
        "water_box_status": st.water_box_status,
        "water_box_carriage_status": st.water_box_carriage_status,
        "water_shortage_status": st.water_shortage_status,
        "dock_error_status": _enum_name(st.dock_error_status),
        "dock_type": _enum_name(st.dock_type),
        "dnd_enabled": st.dnd_enabled,
    }


def _consumable_snapshot(c: Any) -> dict[str, Any]:
    return {
        "main_brush_time_left": _safe(lambda: c.main_brush_time_left),
        "side_brush_time_left": _safe(lambda: c.side_brush_time_left),
        "filter_time_left": _safe(lambda: c.filter_time_left),
        "sensor_time_left": _safe(lambda: c.sensor_time_left),
    }


def _clean_summary_snapshot(cs: Any) -> dict[str, Any]:
    return {
        "clean_time": cs.clean_time,
        "square_meter_clean_area": _safe(lambda: cs.square_meter_clean_area),
        "clean_count": cs.clean_count,
        "dust_collection_count": cs.dust_collection_count,
    }


log = logging.getLogger("roborock")

_CONNECT_TIMEOUT = 20
_PROP_TIMEOUT = 20

# Region → Roborock IoT host. "auto" lets the library resolve the correct host
# from the account e-mail. Mirrors the official Home Assistant integration.
_REGION_HOSTS = {
    "us": "https://usiot.roborock.com",
    "eu": "https://euiot.roborock.com",
    "ru": "https://ruiot.roborock.com",
    "cn": "https://cniot.roborock.com",
}


def _base_url_for_region(region: str | None) -> str | None:
    region = (region or "auto").strip().lower()
    return _REGION_HOSTS.get(region)


def _stable_device_id(email: str) -> str:
    """Deterministic device identifier per account.

    Roborock binds the e-mailed verification code to the request's
    ``header_clientid`` = md5(username + device_identifier). The library
    randomises ``device_identifier`` on every ``RoborockApiClient`` instance,
    so the "request code" step and the "login" step (separate HTTP requests in
    Hyve) would otherwise use different client ids and the code would be
    rejected as invalid. Deriving the identifier from the e-mail keeps it stable
    across both steps.
    """
    import hashlib

    return hashlib.sha256(f"hyve-roborock::{email.lower()}".encode()).hexdigest()[:22]


def _new_api_client(email: str, region: str | None):
    """Create a RoborockApiClient with a stable per-account client id."""
    from roborock.web_api import RoborockApiClient

    api = RoborockApiClient(username=email, base_url=_base_url_for_region(region))
    api._device_identifier = _stable_device_id(email)
    return api


class RoborockEntity(BaseEntity):
    slug = "roborock"
    label = "Roborock"
    description = (
        "Aspirator robot Roborock — control local (LAN) când e posibil, altfel cloud MQTT. "
        "Serverul Hyve trebuie să ajungă la aspirator pe TCP 58867 / UDP 58866; recomandat IP static."
    )
    icon = "fa-robot"
    color = "text-emerald-400"
    scan_interval_seconds = 120
    uses_refresh_layers = True
    probe_interval_cycles = 6
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {
            "key": "email",
            "label": "E-mail cont Roborock",
            "type": "text",
            "required": True,
            "placeholder": "nume@exemplu.com",
            "help": "Apasă „Testează” pentru a primi un cod de verificare pe e-mail.",
        },
        {
            "key": "code",
            "label": "Cod de verificare",
            "type": "text",
            "placeholder": "ex. 1234",
            "help": "Codul primit pe e-mail. Este folosit o singură dată pentru autentificare.",
        },
        {
            "key": "region",
            "label": "Regiune",
            "type": "select",
            "default": "auto",
            "options": [
                {"value": "auto", "label": "Automat"},
                {"value": "eu", "label": "Europa"},
                {"value": "us", "label": "America"},
                {"value": "ru", "label": "Rusia"},
                {"value": "cn", "label": "China"},
            ],
            "help": "Lasă „Automat” dacă nu ești sigur — regiunea se determină din cont.",
        },
        {
            "key": "scan_interval",
            "label": "Interval sync (sec)",
            "type": "number",
            "default": 120,
            "min": 30,
            "help": (
                "Pentru control local rapid, lasă serverul Hyve pe aceeași rețea cu aspiratorul. "
                "Deschide firewall TCP 58867 și UDP 58866 către IP-ul aspiratorului; IP static recomandat."
            ),
        },
    ]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._manager = None  # roborock.devices DeviceManager
        self._session = None  # aiohttp.ClientSession
        self._cache: EntryRoborockCache | None = None
        self._transport_logged: dict[str, str] = {}
        self._manager_lock = asyncio.Lock()

    # ── two-step auth helpers ────────────────────────────────────────────
    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        email = str((data or {}).get("email") or "").strip()
        code = str((data or {}).get("code") or "").strip()
        region = str((data or {}).get("region") or "auto").strip().lower()
        if not email:
            return {"ok": False, "message": "Completează adresa de e-mail."}
        try:
            from roborock.web_api import RoborockApiClient  # noqa: F401
        except Exception:
            return {"ok": False, "message": "Biblioteca python-roborock nu este instalată."}

        if code:
            # The code is consumed only on save — here we just confirm the form
            # is ready so we don't burn a one-time code during testing.
            return {"ok": True, "message": "Cod completat. Apasă „Salvează” pentru a finaliza autentificarea."}

        api = _new_api_client(email, region)
        try:
            await asyncio.wait_for(api.request_code_v4(), timeout=20)
        except Exception as exc:
            return {"ok": False, "message": f"Nu am putut trimite codul: {_friendly_auth_error(exc)}"}
        return {"ok": True, "message": "Cod trimis pe e-mail. Introdu-l mai jos și apasă „Salvează”."}

    @classmethod
    async def async_validate_entry(cls, data: dict[str, Any]) -> dict[str, Any]:
        email = str((data or {}).get("email") or "").strip()
        code = str((data or {}).get("code") or "").strip()
        has_token = bool((data or {}).get("_user_data"))
        errors: dict[str, str] = {}
        if not email:
            errors["email"] = "Adresa de e-mail este obligatorie."
        if not code and not has_token:
            errors["code"] = "Introdu codul de verificare primit pe e-mail."
        if errors:
            return {"ok": False, "errors": errors}

        # Exchange the one-time code for a long-lived token *now*, while the code
        # is freshest — Roborock codes expire within minutes. This also gives the
        # user immediate feedback if the code is wrong, instead of failing later
        # in a background sync.
        if not has_token:
            region = str((data or {}).get("region") or "auto").strip().lower()
            try:
                from roborock import UserData  # noqa: F401
                from roborock.web_api import RoborockApiClient  # noqa: F401
            except Exception:
                return {"ok": False, "errors": {"code": "Biblioteca python-roborock nu este instalată."}}

            api = _new_api_client(email, region)
            try:
                user_data = await api.code_login_v4(code)
            except Exception as exc:
                return {"ok": False, "errors": {"code": _friendly_auth_error(exc)}}
            try:
                base_url = await api.base_url
            except Exception:
                base_url = None
            extra: dict[str, Any] = {"_user_data": user_data.as_dict(), "code": ""}
            if base_url:
                extra["_base_url"] = base_url
            return {"ok": True, "title": email, "data": extra}

        return {"ok": True, "title": email}

    # ── token persistence (HA-style, mirrors xiaomi_home._oauth) ─────────
    def _persist_user_data(self, user_data, base_url: str | None) -> None:
        entry_id = self.entry_id
        if not entry_id or entry_id == "__test__":
            return
        try:
            from integrations import config_entries as _ce

            ud = user_data.as_dict()
            patch: dict[str, Any] = {"_user_data": ud, "code": ""}
            if base_url:
                patch["_base_url"] = base_url
            _ce.update_entry(entry_id, data=patch, schema=self.get_config_schema())
            self.entry_data.update(patch)
            log.info("roborock %s: stored user token", entry_id[:8])
        except Exception as exc:
            log.warning("roborock token persist failed: %s", exc)

    def _persist_roborock_cache(self, payload: dict[str, Any]) -> None:
        entry_id = self.entry_id
        if not entry_id or entry_id == "__test__":
            return
        try:
            from integrations import config_entries as _ce

            patch = {"_roborock_cache": payload}
            _ce.update_entry(entry_id, data=patch, schema=self.get_config_schema())
            self.entry_data.update(patch)
        except Exception as exc:
            log.warning("roborock cache persist failed: %s", exc)

    def _ensure_cache(self) -> EntryRoborockCache:
        if self._cache is None:
            self._cache = EntryRoborockCache(
                entry_id=str(self.entry_id or ""),
                initial=self.entry_data.get("_roborock_cache"),
                persist=self._persist_roborock_cache,
            )
        return self._cache

    async def _flush_cache(self) -> None:
        if self._cache is not None:
            await self._cache.flush()

    async def _note_transport(self, device: Any, *, context: str = "sync") -> dict[str, Any]:
        snap = device_transport_snapshot(device)
        cache_data = await self._ensure_cache().get()
        ip = network_ip_from_cache(cache_data, str(getattr(device, "duid", "") or ""))
        if ip:
            snap["local_ip"] = ip
        duid = str(getattr(device, "duid", "") or "")
        mode = str(snap.get("transport") or "offline")
        prev = self._transport_logged.get(duid)
        if prev != mode:
            self._transport_logged[duid] = mode
            msg = transport_log_message(device, snap, ip=ip)
            if mode == "local":
                log.info("roborock %s [%s]: %s", duid[:8], context, msg)
            elif mode == "cloud":
                log.warning("roborock %s [%s]: %s", duid[:8], context, msg)
            else:
                log.warning("roborock %s [%s]: %s", duid[:8], context, msg)
        else:
            log.debug(
                "roborock %s [%s]: transport=%s ip=%s",
                duid[:8],
                context,
                mode,
                ip or "-",
            )
        return snap

    async def _ensure_user_data(self):
        from roborock import UserData

        stored = self.entry_data.get("_user_data")
        if stored:
            return UserData.from_dict(stored)
        email = str(self.entry_data.get("email") or "").strip()
        code = str(self.entry_data.get("code") or "").strip()
        if not (email and code):
            raise RuntimeError("Autentificare Roborock incompletă — reintrodu codul de verificare.")
        region = str(self.entry_data.get("region") or "auto").strip().lower()
        api = _new_api_client(email, region)
        try:
            # country / country_code are derived from the account by the library.
            user_data = await api.code_login_v4(code)
        except Exception as exc:
            raise RuntimeError(_friendly_auth_error(exc)) from exc
        try:
            base_url = await api.base_url
        except Exception:
            base_url = None
        self._persist_user_data(user_data, base_url)
        return user_data

    # ── device manager (created once, reused across scans) ───────────────
    async def _ensure_manager(self):
        if self._manager is not None:
            return self._manager
        async with self._manager_lock:
            if self._manager is not None:
                return self._manager

            import aiohttp
            from roborock import UserData
            from roborock.devices.device_manager import UserParams, create_device_manager

            user_data = await self._ensure_user_data()
            email = str(self.entry_data.get("email") or "").strip()
            base_url = self.entry_data.get("_base_url") or _base_url_for_region(
                self.entry_data.get("region")
            )

            if self._session is None or self._session.closed:
                self._session = aiohttp.ClientSession()

            cache = self._ensure_cache()
            stored = self.entry_data.get("_user_data")
            params = UserParams(
                username=email,
                user_data=UserData.from_dict(stored) if stored else user_data,
                base_url=base_url,
            )
            self._manager = await create_device_manager(
                params,
                cache=cache,
                session=self._session,
                prefer_cache=True,
            )
            return self._manager

    async def _reset_manager(self) -> None:
        await self._flush_cache()
        mgr, self._manager = self._manager, None
        if mgr is not None:
            try:
                await mgr.close()
            except Exception:
                pass

    # ── BaseEntity contract ──────────────────────────────────────────────
    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool(section.get("_user_data") or (section.get("email") and section.get("code")))

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._sync_devices(full=True)

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        return await self._sync_devices(full=False, cached=cached)

    async def _sync_devices(
        self,
        *,
        full: bool,
        cached: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cached_by_duid = {
            str(row.get("duid") or ""): row
            for row in ((cached or {}).get("devices") or [])
            if isinstance(row, dict) and row.get("duid")
        }
        try:
            manager = await self._ensure_manager()
            devices = await manager.get_devices()
        except Exception:
            await self._reset_manager()
            raise

        results: list[dict[str, Any]] = []
        for device in devices:
            props = getattr(device, "v1_properties", None)
            if props is None:
                continue

            online = True
            status: dict[str, Any] = {}
            consumable: dict[str, Any] = {}
            clean_summary: dict[str, Any] = {}
            transport: dict[str, Any] = {"transport": "offline", "local_connected": False}
            prior = cached_by_duid.get(str(device.duid)) or {}
            try:
                if not device.is_connected:
                    await asyncio.wait_for(device.connect(), timeout=_CONNECT_TIMEOUT)
                transport = await self._note_transport(device, context="sync")
                await asyncio.wait_for(props.status.refresh(), timeout=_PROP_TIMEOUT)
                status = _status_snapshot(props.status)
                if full:
                    consumable = await self._refresh_snapshot(
                        getattr(props, "consumables", None), _consumable_snapshot
                    )
                    clean_summary = await self._refresh_snapshot(
                        getattr(props, "clean_summary", None), _clean_summary_snapshot
                    )
                else:
                    consumable = dict(prior.get("consumable") or {})
                    clean_summary = dict(prior.get("clean_summary") or {})
            except Exception as exc:
                online = False
                transport = device_transport_snapshot(device)
                log.warning("roborock status poll failed for %s: %s", device.name, exc)
                if not full:
                    consumable = dict(prior.get("consumable") or {})
                    clean_summary = dict(prior.get("clean_summary") or {})

            results.append(
                {
                    "duid": device.duid,
                    "name": device.name,
                    "model": getattr(device.product, "model", "") or "",
                    "online": online,
                    "transport": transport.get("transport"),
                    "local_connected": bool(transport.get("local_connected")),
                    "local_ip": transport.get("local_ip"),
                    "status": status,
                    "consumable": consumable,
                    "clean_summary": clean_summary,
                }
            )

        await self._flush_cache()
        return {"devices": results}

    async def _refresh_snapshot(self, trait: Any, snapshot: Any) -> dict[str, Any]:
        """Refresh an optional trait and snapshot it, swallowing failures."""
        if trait is None:
            return {}
        try:
            await asyncio.wait_for(trait.refresh(), timeout=_PROP_TIMEOUT)
            return snapshot(trait)
        except Exception as exc:
            log.debug("roborock optional trait refresh skipped: %s", exc)
            return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_roborock_candidates(payload)

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        from roborock import RoborockCommand

        parts = str(entity_id).split(":")
        if len(parts) < 2 or parts[0] != self.slug:
            raise ValueError(f"entity_id Roborock invalid: {entity_id}")
        duid = parts[1]

        manager = await self._ensure_manager()
        device = await manager.get_device(duid)
        if device is None or getattr(device, "v1_properties", None) is None:
            raise ValueError(f"Dispozitiv Roborock necunoscut: {duid}")

        act = (action or "").lower()
        command_map = {
            "turn_on": RoborockCommand.APP_START,
            "start": RoborockCommand.APP_START,
            "resume": RoborockCommand.APP_START,
            "turn_off": RoborockCommand.APP_STOP,
            "stop": RoborockCommand.APP_STOP,
            "pause": RoborockCommand.APP_PAUSE,
            "return_to_base": RoborockCommand.APP_CHARGE,
            "dock": RoborockCommand.APP_CHARGE,
            "locate": RoborockCommand.FIND_ME,
        }

        params: Any = None
        command = command_map.get(act)
        if command is None and act in ("set", "set_fan_speed"):
            fan = (data or {}).get("fan_speed", (data or {}).get("value"))
            try:
                level = int(fan)
            except (TypeError, ValueError):
                raise ValueError(f"Viteză ventilator invalidă: {fan!r}")
            command = RoborockCommand.SET_CUSTOM_MODE
            params = [level]
        if command is None:
            raise ValueError(f"Acțiune Roborock nesuportată: {action}")

        try:
            if not device.is_connected:
                await asyncio.wait_for(device.connect(), timeout=_CONNECT_TIMEOUT)
            await self._note_transport(device, context=f"control:{act}")
            await device.v1_properties.command.send(command, params)
            await self._flush_cache()
        except Exception:
            await self._reset_manager()
            raise
        return {"status": "ok", "action": act}

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_roborock_context(entities if isinstance(entities, dict) else {})


