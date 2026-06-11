from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import core.settings as settings

from . import config_entries
from .base import BaseEntity
from .component_loader import discover_integration_classes
from .source_refresh import attach_refresh_runner

log = logging.getLogger(__name__)


def _format_bootstrap_deferred_message(wait_seconds: float) -> str:
    secs = max(1, int(wait_seconds + 0.5))
    if secs >= 3600:
        eta = f"~{secs // 3600}h {(secs % 3600) // 60}m".strip()
    elif secs >= 120:
        eta = f"~{secs // 60} min"
    else:
        eta = f"{secs}s"
    return (
        f"Startup sync deferred — next allowed in {eta} "
        f"(scan_interval; cached entities remain available)"
    )

try:
    from addons.entity_store import FETCH_TIMEOUT_SECONDS, SyncThrottledError
except ImportError:  # pragma: no cover
    FETCH_TIMEOUT_SECONDS = 60.0

    class SyncThrottledError(Exception):  # pragma: no cover
        retry_after = 0


class IntegrationManager:
    """Discovers provider classes and instantiates one BaseEntity per
    config entry. Falls back to a single legacy instance (no entry_data)
    when an integration has no entries yet — preserves backward compat
    with code that still reads from ``config.json[slug]``.
    """

    def __init__(self, providers_dir: Path | None = None) -> None:
        self.providers_dir = providers_dir or (Path(__file__).resolve().parent / "providers")
        self._classes: dict[str, type[BaseEntity]] = {}
        # Live instances keyed by entry_id. The legacy single-instance entry
        # for slugs without explicit entries lives under key ``"@" + slug``.
        self._instances: dict[str, BaseEntity] = {}
        self._loaded = False

    # ── discovery ─────────────────────────────────────────────────────────
    def _discover_classes(self, force: bool = False) -> dict[str, type[BaseEntity]]:
        if self._loaded and not force:
            return self._classes
        self._classes = discover_integration_classes(providers_dir=self.providers_dir, force=force)
        self._loaded = True
        return self._classes

    def discover(self, force: bool = False) -> dict[str, type[BaseEntity]]:
        """Public alias used by tests and tooling."""
        if force:
            self._loaded = False
        return self._discover_classes(force=force)

    def reload(self) -> None:
        """Re-instantiate all live providers from current entries."""
        self._instances = {}
        self._loaded = False

    # ── classes / metadata ────────────────────────────────────────────────
    def classes(self) -> dict[str, type[BaseEntity]]:
        return self._discover_classes()

    def get_class(self, slug: str) -> type[BaseEntity] | None:
        return self._discover_classes().get(str(slug or "").strip())

    def source_meta(self) -> dict[str, dict[str, str]]:
        out: dict[str, dict[str, str]] = {}
        for slug, cls in self.classes().items():
            out[slug] = {
                "slug": slug,
                "label": getattr(cls, "label", "") or slug,
                "icon": getattr(cls, "icon", "fa-puzzle-piece"),
                "color": getattr(cls, "color", "text-slate-400"),
            }
        return out

    # ── live instances per entry ──────────────────────────────────────────
    def _legacy_instance(self, slug: str) -> BaseEntity | None:
        cls = self.get_class(slug)
        if not cls:
            return None
        key = f"@{slug}"
        inst = self._instances.get(key)
        if inst is None:
            inst = cls()
            self._instances[key] = inst
        return inst

    def _entry_instance(self, entry: dict[str, Any]) -> BaseEntity | None:
        cls = self.get_class(entry["slug"])
        if not cls:
            return None
        eid = entry["entry_id"]
        inst = self._instances.get(eid)
        if inst is None:
            inst = cls(
                entry_id=eid,
                entry_data=entry.get("data") or {},
                entry_title=entry.get("title") or entry["slug"],
            )
            self._instances[eid] = inst
        else:
            inst.entry_data = dict(entry.get("data") or {})
            inst.entry_title = entry.get("title") or inst.entry_title
        return inst

    def entries_for(self, slug: str) -> list[BaseEntity]:
        # Entries are the sole source of truth (HA-style). When the user
        # deletes the last entry the integration vanishes — no silent
        # resurrection from the legacy ``cfg[slug]`` section.
        out: list[BaseEntity] = []
        for entry in config_entries.list_entries(slug):
            if not entry.get("enabled", True):
                continue
            inst = self._entry_instance(entry)
            if inst is not None:
                out.append(inst)
        return out

    def all_instances(self) -> list[BaseEntity]:
        out: list[BaseEntity] = []
        for slug in self.classes():
            out.extend(self.entries_for(slug))
        return out

    def get_by_entry(self, entry_id: str) -> BaseEntity | None:
        entry = config_entries.get_entry(entry_id)
        if not entry:
            return None
        return self._entry_instance(entry)

    # ── back-compat shims: routers that pass plain slug ──────────────────
    def all(self) -> list[BaseEntity]:
        out: list[BaseEntity] = []
        for slug in self.classes():
            insts = self.entries_for(slug)
            if insts:
                out.append(insts[0])
        return out

    def get(self, slug_or_entry: str) -> BaseEntity | None:
        key = str(slug_or_entry or "").strip()
        if not key:
            return None
        if ":" in key:
            _, _, eid = key.partition(":")
            return self.get_by_entry(eid)
        if key in self._instances and not key.startswith("@"):
            return self._instances[key]
        entry = config_entries.get_entry(key)
        if entry:
            return self._entry_instance(entry)
        insts = self.entries_for(key)
        return insts[0] if insts else None

    # ── registry / sync (multi-instance aware) ────────────────────────────
    def _store_key(self, integration: BaseEntity) -> str:
        return integration.store_key

    def is_bootstrap_eligible(self, integration: BaseEntity, *, include_disabled: bool = False) -> bool:
        if integration.entry_id:
            return True
        cfg = settings.CFG
        if include_disabled:
            return integration.is_configured(cfg)
        return integration.is_enabled(cfg)

    def _is_bootstrap_eligible(self, integration: BaseEntity, *, include_disabled: bool = False) -> bool:
        return self.is_bootstrap_eligible(integration, include_disabled=include_disabled)

    def register_fetcher(self, slug_or_entry: str, store, *, include_disabled: bool = False) -> bool:
        integration = self.get(slug_or_entry)
        if not integration or not integration.supports_sync:
            return False
        if not self._is_bootstrap_eligible(integration, include_disabled=include_disabled):
            return False
        key = self._store_key(integration)
        timeout = float(getattr(integration, "fetch_timeout_seconds", FETCH_TIMEOUT_SECONDS))
        runner = attach_refresh_runner(integration)
        store.register_fetcher(
            key,
            runner.run,
            integration.format_context,
            description=getattr(integration, "description", "") or "",
            timeout_seconds=timeout,
        )
        interval = integration.sync_interval(settings.CFG)
        if store.get_schedule(key):
            store.set_interval(key, interval)
        else:
            store.init_schedule(key, interval)
        return True

    async def bootstrap_store(self, store, *, include_disabled: bool = False, run_initial_sync: bool = True, logger=None) -> None:
        eligible: list[tuple[str, Any, int]] = []
        for integration in self.all_instances():
            if not integration.supports_sync:
                continue
            if not self._is_bootstrap_eligible(integration, include_disabled=include_disabled):
                continue
            key = self._store_key(integration)
            timeout = float(getattr(integration, "fetch_timeout_seconds", FETCH_TIMEOUT_SECONDS))
            runner = attach_refresh_runner(integration)
            store.register_fetcher(
                key,
                runner.run,
                integration.format_context,
                description=getattr(integration, "description", "") or "",
                timeout_seconds=timeout,
            )
            interval = integration.sync_interval(settings.CFG)
            if store.get_schedule(key):
                store.set_interval(key, interval)
            else:
                store.init_schedule(key, interval)
            eligible.append((key, integration, interval))

        if run_initial_sync and eligible:
            # Cap parallel startup sync so N integrations do not hammer upstream
            # APIs and SQLite at once.
            bootstrap_sem = asyncio.Semaphore(4)

            async def _one(key: str) -> None:
                async with bootstrap_sem:
                    try:
                        await store.do_sync(key, force=True)
                        if logger:
                            logger("success", key, f"Startup sync OK for {key}")
                    except SyncThrottledError as exc:
                        msg = _format_bootstrap_deferred_message(exc.retry_after or 0)
                        if logger:
                            logger("deferred", key, msg)
                    except Exception as exc:
                        if logger:
                            logger("error", key, f"Startup sync failed for {key}: {exc}")

            await asyncio.gather(*(_one(k) for k, _, _ in eligible), return_exceptions=True)

        for key, integration, interval in eligible:
            if integration.uses_background_sync():
                await store.start_sync_loop(key, interval)
            else:
                store.stop_sync_loop(key)

    async def list_entities(self, store, *, include_disabled: bool = False) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for integration in self.all_instances():
            if integration.supports_sync and not self._is_bootstrap_eligible(integration, include_disabled=include_disabled):
                continue
            try:
                items.extend(await integration.list_entities(store))
            except Exception as exc:
                log.warning(
                    "list_entities failed slug=%s entry=%s",
                    integration.slug,
                    integration.entry_id,
                    exc_info=exc,
                )
                continue
        return items


_MANAGER = IntegrationManager()


def get_integration_manager() -> IntegrationManager:
    return _MANAGER
