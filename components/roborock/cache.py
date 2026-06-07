"""Persist python-roborock device cache on the Hyve config entry.

Mirrors Home Assistant's ``CacheStore``: stores home-data and per-device
network info (IP, keys) so reconnects prefer LAN without re-fetching cloud
home-data on every sync.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger("roborock")

PersistFn = Callable[[dict[str, Any]], None]


class EntryRoborockCache:
    """``roborock.devices.cache.Cache`` backed by ``_roborock_cache`` on the entry."""

    def __init__(
        self,
        *,
        entry_id: str,
        initial: dict[str, Any] | None,
        persist: PersistFn | None,
    ) -> None:
        self._entry_id = entry_id
        self._initial = initial if isinstance(initial, dict) else {}
        self._persist = persist
        self._data: Any = None
        self._dirty = False

    async def get(self) -> Any:
        from roborock.devices.cache import CacheData

        if self._data is None:
            if self._initial:
                try:
                    self._data = CacheData.from_dict(self._initial)
                except Exception as exc:
                    log.debug("roborock cache load failed for %s: %s", self._entry_id[:8], exc)
                    self._data = CacheData()
            else:
                self._data = CacheData()
        return self._data

    async def set(self, value: Any) -> None:
        self._data = value
        self._dirty = True

    async def flush(self) -> None:
        if not self._dirty or self._data is None or not self._persist:
            return
        try:
            payload = self._data.as_dict()
        except Exception as exc:
            log.warning("roborock cache serialize failed: %s", exc)
            return
        try:
            self._persist(payload)
            self._dirty = False
        except Exception as exc:
            log.warning("roborock cache persist failed: %s", exc)


def network_ip_from_cache(cache_data: Any, duid: str) -> str | None:
    """Best-effort LAN IP for a device from cached network info."""
    if cache_data is None or not duid:
        return None
    try:
        device_info = getattr(cache_data, "device_info", None) or {}
        row = device_info.get(duid)
        if row is not None:
            net = getattr(row, "network_info", None)
            ip = getattr(net, "ip", None) if net is not None else None
            if ip:
                return str(ip).strip() or None
        legacy = getattr(cache_data, "network_info", None) or {}
        net = legacy.get(duid)
        ip = getattr(net, "ip", None) if net is not None else None
        return str(ip).strip() or None if ip else None
    except Exception:
        return None
