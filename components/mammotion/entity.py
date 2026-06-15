"""Mammotion lawn mower integration (Luba / Yuka / Spino via PyMammotion cloud)."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from integrations.base import BaseEntity
from integrations.component_import import import_sibling

log = logging.getLogger("mammotion")

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
_context_mod = import_sibling(_component_dir, "context")
extract_mammotion_entities = _extract_mod.extract_mammotion_entities

def _pymammotion_version_tuple(version: str) -> tuple[int, ...]:
    parts: list[int] = []
    for piece in (version or "").strip().split(".")[:3]:
        try:
            parts.append(int(piece.split("-")[0]))
        except ValueError:
            break
    return tuple(parts)


def _pymammotion_import_error() -> str | None:
    try:
        from pymammotion.client import MammotionClient  # noqa: F401
    except Exception as exc:
        detail = str(exc).strip() or exc.__class__.__name__
        return (
            "Biblioteca pymammotion nu este instalată în mediul Python care rulează Hyve. "
            f"Rulează: pip install pymammotion==0.8.5 'betterproto2==0.9.1' "
            f"(detaliu: {detail})"
        )
    try:
        import importlib.metadata

        installed = importlib.metadata.version("pymammotion")
    except Exception:
        return None
    if _pymammotion_version_tuple(installed) < (0, 8, 0):
        import sys

        py = f"{sys.version_info.major}.{sys.version_info.minor}"
        return (
            f"Hyve rulează pymammotion {installed} (Python {py}) — prea vechi pentru cloud Mammotion "
            f"(necesar ≥ 0.8.5, Python ≥ 3.13). Oprește serverul și pornește-l cu "
            f"./start.sh (folosește .venv) sau: .venv/bin/pip install -r requirements.txt"
        )
    return None


def _client_module() -> Any:
    return import_sibling(_component_dir, "client")


class MammotionEntity(BaseEntity):
    slug = "mammotion"
    label = "Mammotion"
    description = (
        "Roboți Mammotion (Luba, Yuka, Spino) prin cloud PyMammotion — paritate cu integrarea Home Assistant: "
        "senzori, switch-uri, programări, comenzi avansate start_mow. Cont secundar recomandat."
    )
    icon = "fa-leaf"
    color = "text-lime-400"
    scan_interval_seconds = 300
    fetch_timeout_seconds = 180.0
    uses_refresh_layers = True
    updates_live = True
    probe_interval_cycles = 12
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {
            "key": "account",
            "label": "Cont Mammotion",
            "type": "text",
            "required": True,
            "placeholder": "email@exemplu.com",
            "help": "E-mail sau telefon cu prefix internațional (ex. +407xxxxxxxx), exact ca în app Mammotion.",
        },
        {
            "key": "password",
            "label": "Parolă",
            "type": "password",
            "required": True,
            "secret": True,
        },
        {
            "key": "movement_use_wifi",
            "label": "Nudge prin cloud (fără BLE pe server)",
            "type": "bool",
            "default": False,
            "help": "Trimite comenzile nudge prin cloud/MQTT în loc de BLE pe server. Nu înlocuiește Bluetooth la robot: firmware-ul acceptă mișcarea manuală doar cu sesiune BT activă (app Mammotion lângă robot sau dongle BLE pe Hyve). Robotul trebuie scos din dock.",
        },
        {
            "key": "scan_interval",
            "label": "Interval sync (sec)",
            "type": "number",
            "default": 300,
            "min": 120,
            "help": "Interval minim 120 secunde. Recomandat 300s (5 min) ca în Home Assistant.",
        },
    ]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._session: Any | None = None
        self._session_lock = asyncio.Lock()
        self._push_sync_task: asyncio.Task[None] | None = None
        self._push_sync_pending = False

    def _schedule_push_sync(self) -> None:
        """Debounced light sync after MQTT push (HA coordinator pattern)."""
        if self._push_sync_pending:
            return
        self._push_sync_pending = True

        async def _run() -> None:
            await asyncio.sleep(3.0)
            self._push_sync_pending = False
            store_key = self.store_key
            try:
                session = await self._get_session()
                payload = await session._hub.build_live_payload()
                from core.entity_store import get_entity_store
                from core.entity_mirror import signal_source_refresh

                store = get_entity_store()
                store.set_entities(store_key, payload, error=None)
                signal_source_refresh(store_key)
            except Exception as exc:
                log.debug("mammotion push sync skipped for %s: %s", store_key, exc)

        try:
            loop = asyncio.get_running_loop()
            if self._push_sync_task is not None and not self._push_sync_task.done():
                return
            self._push_sync_task = loop.create_task(_run())
        except RuntimeError:
            self._push_sync_pending = False

    def _account(self) -> str:
        return str(self.entry_data.get("account") or "").strip()

    def _password(self) -> str:
        return str(self.entry_data.get("password") or "").strip()

    def _persist_cache(self, cache: dict[str, Any]) -> None:
        entry_id = self.entry_id
        if not entry_id or entry_id == "__test__":
            return
        try:
            from integrations import config_entries as _ce

            patch = {"_mammotion_cache": cache}
            _ce.update_entry(entry_id, data=patch, schema=self.get_config_schema())
            self.entry_data.update(patch)
        except Exception as exc:
            log.warning("mammotion cache persist failed: %s", exc)

    def _persist_device_settings(self, settings: dict[str, Any]) -> None:
        entry_id = self.entry_id
        if not entry_id or entry_id == "__test__":
            return
        try:
            from integrations import config_entries as _ce

            patch = {"_mammotion_device_settings": settings}
            _ce.update_entry(entry_id, data=patch, schema=self.get_config_schema())
            self.entry_data.update(patch)
        except Exception as exc:
            log.warning("mammotion settings persist failed: %s", exc)

    def _movement_use_wifi(self) -> bool:
        from components.mammotion.utils import movement_use_wifi_from_entry

        return movement_use_wifi_from_entry(self.entry_data)

    def _sync_session_runtime_options(self) -> None:
        if self._session is None:
            return
        self._session._hub.apply_runtime_options(movement_use_wifi=self._movement_use_wifi())

    async def _get_session(self) -> Any:
        if self._session is not None:
            self._sync_session_runtime_options()
            return self._session
        async with self._session_lock:
            if self._session is not None:
                self._sync_session_runtime_options()
                return self._session
            MammotionSession = _client_module().MammotionSession
            on_push = self._schedule_push_sync if self.entry_id and self.entry_id != "__test__" else None
            self._session = MammotionSession(
                account=self._account(),
                password=self._password(),
                cache=self.entry_data.get("_mammotion_cache"),
                device_settings=self.entry_data.get("_mammotion_device_settings"),
                movement_use_wifi=self._movement_use_wifi(),
                persist_cache=self._persist_cache,
                persist_settings=self._persist_device_settings,
                on_push=on_push,
            )
            return self._session

    async def _reset_session(self, *, clear_cache: bool = False) -> None:
        async with self._session_lock:
            if clear_cache:
                self._persist_cache({})
                self.entry_data.pop("_mammotion_cache", None)
            if self._session is not None:
                try:
                    await self._session.close()
                except Exception:
                    pass
            self._session = None

    async def _recover_session(self, exc: Exception | None = None) -> None:
        from components.mammotion.utils import is_auth_session_error, is_rate_limited_error

        if is_rate_limited_error(exc):
            return
        clear_cache = is_auth_session_error(exc)
        await self._reset_session(clear_cache=clear_cache)
        if clear_cache:
            try:
                session = await self._get_session()
                await session._hub.recover_auth()
            except Exception as recover_exc:
                log.warning("mammotion auth recovery failed: %s", recover_exc)
                await self._reset_session(clear_cache=True)

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        account = str((data or {}).get("account") or "").strip()
        password = str((data or {}).get("password") or "")
        if not account:
            return {"ok": False, "message": "Completează contul Mammotion."}
        if not password:
            return {"ok": False, "message": "Completează parola Mammotion."}
        missing = _pymammotion_import_error()
        if missing:
            return {"ok": False, "message": missing}

        from components.mammotion.cloud_login import async_test_cloud_login
        from components.mammotion.pymammotion_compat import apply_pymammotion_patches
        from components.mammotion.utils import mammotion_ha_fingerprint
        from pymammotion.client import MammotionClient

        import aiohttp

        apply_pymammotion_patches()
        client = MammotionClient(ha_version=mammotion_ha_fingerprint())
        http = aiohttp.ClientSession()
        try:
            ok, message, _count = await async_test_cloud_login(
                client,
                account,
                password,
                http,
                timeout=120.0,
            )
            return {"ok": ok, "message": message}
        finally:
            try:
                await client.stop()
            except Exception:
                pass
            if not http.closed:
                await http.close()

    @classmethod
    async def async_validate_entry(cls, data: dict[str, Any]) -> dict[str, Any]:
        account = str((data or {}).get("account") or "").strip()
        password = str((data or {}).get("password") or "").strip()
        errors: dict[str, str] = {}
        if not account:
            errors["account"] = "Contul Mammotion este obligatoriu."
        if not password:
            errors["password"] = "Parola este obligatorie."
        if errors:
            return {"ok": False, "errors": errors}
        return {"ok": True, "title": account}

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool(section.get("account") and section.get("password"))

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        del cached
        session = await self._get_session()
        try:
            return await session.sync_devices(full=True, snapshot=True)
        except Exception as exc:
            await self._recover_session(exc)
            raise RuntimeError(str(exc)) from exc

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        del cached
        session = await self._get_session()
        try:
            return await session._hub.pull_live()
        except Exception as exc:
            await self._recover_session(exc)
            raise RuntimeError(str(exc)) from exc

    def choose_refresh_mode(self, *, force: bool, cached: dict[str, Any], cycle_count: int) -> str:
        from integrations.source_refresh import MODE_PROBE, MODE_PULL

        if force:
            return MODE_PROBE
        if not cached:
            return MODE_PROBE
        devices = cached.get("devices") if isinstance(cached, dict) else None
        if not isinstance(devices, list) or not devices:
            return MODE_PROBE
        interval = max(1, int(self.probe_interval_cycles))
        if cycle_count > 0 and cycle_count % interval == 0:
            return MODE_PROBE
        return MODE_PULL

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_mammotion_entities(payload)

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        session = await self._get_session()
        try:
            return await session.control(entity_id, action, data)
        except ValueError:
            raise
        except Exception as exc:
            from components.mammotion.utils import friendly_auth_error, is_rate_limited_error

            if is_rate_limited_error(exc):
                raise ValueError(
                    "Prea multe cereri către cloud Mammotion — încearcă din nou peste 1–2 minute."
                ) from exc
            await self._recover_session(exc)
            if isinstance(exc, RuntimeError):
                raise ValueError(str(exc)) from exc
            raise ValueError(friendly_auth_error(exc)) from exc

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_mammotion_context(entities if isinstance(entities, dict) else {})
