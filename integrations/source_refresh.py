"""SourceRefreshRunner — per-integration upstream refresh orchestration.

Hyve splits optional *probe* (full discovery) from *pull* (light state sync).
Integrations opt in via ``BaseEntity.uses_refresh_layers``. The entity store
invokes ``runner.run(force=…)`` instead of calling ``fetch_entities`` directly.
"""

from __future__ import annotations

import logging
import time as _time
from dataclasses import dataclass, field
from typing import Any

from integrations.base import BaseEntity

log = logging.getLogger("integrations.source_refresh")

MODE_PROBE = "probe"
MODE_PULL = "pull"
MODE_FETCH = "fetch"


@dataclass
class SourceRefreshStatus:
    store_key: str
    slug: str
    entry_id: str
    last_ok_at: float | None = None
    last_error: str | None = None
    last_mode: str = ""
    last_duration_ms: int = 0
    consecutive_failures: int = 0
    cycle_count: int = 0
    reachable: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "store_key": self.store_key,
            "slug": self.slug,
            "entry_id": self.entry_id,
            "last_ok_at": self.last_ok_at,
            "last_error": self.last_error,
            "last_mode": self.last_mode,
            "last_duration_ms": self.last_duration_ms,
            "consecutive_failures": self.consecutive_failures,
            "cycle_count": self.cycle_count,
            "reachable": self.reachable,
        }


_RUNNERS: dict[str, SourceRefreshRunner] = {}


class SourceRefreshRunner:
    """Runs probe / pull / fetch for one config entry."""

    def __init__(self, integration: BaseEntity) -> None:
        self._integration_ref = integration
        self.store_key = integration.store_key
        self.status = SourceRefreshStatus(
            store_key=self.store_key,
            slug=integration.slug,
            entry_id=integration.entry_id or "",
        )

    def _live_integration(self) -> BaseEntity:
        """Resolve the current provider instance after manager.reload()."""
        try:
            from integrations import get_integration_manager

            manager = get_integration_manager()
            if self.status.entry_id:
                inst = manager.get_by_entry(self.status.entry_id)
                if inst is not None:
                    return inst
            inst = manager.get(self.status.slug)
            if inst is not None:
                return inst
        except Exception:
            pass
        return self._integration_ref

    @property
    def integration(self) -> BaseEntity:
        return self._live_integration()

    def _load_cached_payload(self) -> dict[str, Any]:
        try:
            from addons.entity_store import get_entity_store

            stored = get_entity_store().get_entities(self.store_key) or {}
            payload = stored.get("entities") or {}
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def _choose_mode(self, *, force: bool, cached: dict[str, Any]) -> str:
        inst = self.integration
        return inst.choose_refresh_mode(
            force=force,
            cached=cached,
            cycle_count=self.status.cycle_count,
        )

    async def _execute_mode(self, mode: str, cached: dict[str, Any]) -> dict[str, Any]:
        inst = self.integration
        if mode == MODE_PROBE:
            return await inst.probe_source(cached)
        if mode == MODE_PULL:
            return await inst.pull_live_states(cached)
        return await inst.fetch_entities()

    def _record_success(self, mode: str, started: float) -> None:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        self.status.last_ok_at = _time.time()
        self.status.last_error = None
        self.status.last_mode = mode
        self.status.last_duration_ms = elapsed_ms
        self.status.consecutive_failures = 0
        self.status.reachable = True
        self.status.cycle_count += 1

    def _record_failure(self, mode: str, started: float, exc: Exception) -> None:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        self.status.last_error = str(exc) or exc.__class__.__name__
        self.status.last_mode = mode
        self.status.last_duration_ms = elapsed_ms
        self.status.consecutive_failures += 1
        self.status.reachable = False
        self.status.cycle_count += 1

    async def run(self, *, force: bool = False) -> dict[str, Any]:
        """Entry point registered with the entity store."""
        cached = self._load_cached_payload()
        mode = self._choose_mode(force=force, cached=cached)
        started = _time.monotonic()
        try:
            payload = await self._execute_mode(mode, cached)
            if not isinstance(payload, dict):
                raise TypeError(f"{self.store_key} refresh returned {type(payload).__name__}, expected dict")
            self._record_success(mode, started)
            return payload
        except Exception as exc:
            if mode == MODE_PULL and cached:
                log.warning(
                    "%s pull failed (%s); keeping last cached payload",
                    self.store_key,
                    exc,
                )
                self.status.last_error = str(exc) or exc.__class__.__name__
                self.status.last_mode = mode
                self.status.last_duration_ms = int((_time.monotonic() - started) * 1000)
                self.status.cycle_count += 1
                return cached
            if mode == MODE_PULL:
                log.debug("%s pull failed (%s), retrying with probe", self.store_key, exc)
                try:
                    payload = await self._execute_mode(MODE_PROBE, cached)
                    if not isinstance(payload, dict):
                        raise TypeError("probe fallback returned non-dict")
                    self._record_success(MODE_PROBE, started)
                    return payload
                except Exception as probe_exc:
                    self._record_failure(MODE_PROBE, started, probe_exc)
                    raise probe_exc from exc
            self._record_failure(mode, started, exc)
            raise


def attach_refresh_runner(integration: BaseEntity) -> SourceRefreshRunner:
    runner = SourceRefreshRunner(integration)
    _RUNNERS[integration.store_key] = runner
    return runner


def detach_refresh_runner(store_key: str) -> None:
    _RUNNERS.pop(str(store_key or ""), None)


def get_refresh_runner(store_key: str) -> SourceRefreshRunner | None:
    return _RUNNERS.get(str(store_key or ""))


def all_refresh_status() -> dict[str, dict[str, Any]]:
    return {key: runner.status.as_dict() for key, runner in _RUNNERS.items()}
