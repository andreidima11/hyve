"""EntityMirror — one live snapshot for the whole app.

Hyve keeps a single in-process mirror of integration entities instead of
several independent pollers (automations, smarthome WS, dashboard WS, catalog).
Upstream integration sync calls ``signal_source_refresh()`` to bump the mirror
immediately instead of waiting for the next tick.
"""

from __future__ import annotations

import asyncio
import logging
import time as _time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from core import event_bus

log = logging.getLogger("entity_mirror")

# Published after each successful mirror rebuild.
TOPIC_MIRROR_TICK = "entity_mirror_tick"

SortMode = Literal["name", "dashboard"]
SnapshotKey = tuple[bool, SortMode]

DEFAULT_TICK_SEC = 2.0
_BUILD_TIMEOUT_SEC = 8.0

PushHandler = Callable[[list[dict[str, Any]]], Awaitable[None]]


@dataclass
class _Snapshot:
    items: list[dict[str, Any]] = field(default_factory=list)
    by_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    built_at: float = 0.0


@dataclass
class _PushTarget:
    target_id: str
    handler: PushHandler
    include_derived: bool
    sort_mode: SortMode


def _snapshot_key(include_derived: bool, sort_mode: SortMode) -> SnapshotKey:
    return (bool(include_derived), sort_mode)


def _index_items(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {item.get("entity_id"): item for item in items if item.get("entity_id")}


class EntityMirror:
    """Maintains shared entity snapshots and fans updates to subscribers."""

    def __init__(self, tick_sec: float = DEFAULT_TICK_SEC) -> None:
        self._tick_sec = float(tick_sec)
        self._revision = 0
        self._snapshots: dict[SnapshotKey, _Snapshot] = {}
        self._targets: list[_PushTarget] = []
        self._loop_task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._refresh_lock = asyncio.Lock()
        self._kick = asyncio.Event()
        self._last_trigger = "boot"
        self._last_store_key: str | None = None

    @property
    def revision(self) -> int:
        return self._revision

    def is_running(self) -> bool:
        return self._loop_task is not None and not self._loop_task.done()

    def register_push_target(
        self,
        target_id: str,
        handler: PushHandler,
        *,
        include_derived: bool = True,
        sort_mode: SortMode = "name",
    ) -> None:
        """Deliver rebuilt items to ``handler`` after each mirror tick."""
        self._targets[:] = [t for t in self._targets if t.target_id != target_id]
        self._targets.append(
            _PushTarget(
                target_id=target_id,
                handler=handler,
                include_derived=bool(include_derived),
                sort_mode=sort_mode,
            )
        )

    def unregister_push_target(self, target_id: str) -> None:
        self._targets[:] = [t for t in self._targets if t.target_id != target_id]

    def peek_items(
        self,
        *,
        include_derived: bool = True,
        sort_mode: SortMode = "name",
    ) -> list[dict[str, Any]] | None:
        snap = self._snapshots.get(_snapshot_key(include_derived, sort_mode))
        if snap is None or not snap.items:
            return None
        return list(snap.items)

    def peek_by_id(
        self,
        *,
        include_derived: bool = False,
        sort_mode: SortMode = "dashboard",
    ) -> dict[str, dict[str, Any]]:
        snap = self._snapshots.get(_snapshot_key(include_derived, sort_mode))
        return dict(snap.by_id) if snap else {}

    async def get_items(
        self,
        *,
        include_derived: bool = True,
        sort_mode: SortMode = "name",
    ) -> list[dict[str, Any]]:
        cached = self.peek_items(include_derived=include_derived, sort_mode=sort_mode)
        if cached is not None:
            return cached
        await self.refresh_now(trigger="read")
        return self.peek_items(include_derived=include_derived, sort_mode=sort_mode) or []

    def signal_source_refresh(self, store_key: str | None = None) -> None:
        """Request an immediate mirror rebuild (e.g. after integration sync)."""
        self._last_store_key = str(store_key or "").strip() or None
        self._kick.set()

    async def refresh_now(self, *, trigger: str = "manual", store_key: str | None = None) -> int:
        async with self._refresh_lock:
            return await self._rebuild(trigger=trigger, store_key=store_key)

    async def _rebuild(self, *, trigger: str, store_key: str | None = None) -> int:
        from core.entity_catalog import build_entities_uncached

        needed: set[SnapshotKey] = {
            _snapshot_key(t.include_derived, t.sort_mode) for t in self._targets
        }
        # API reads use these variants even before WS clients attach.
        needed.add((True, "name"))
        needed.add((False, "dashboard"))

        built: dict[SnapshotKey, list[dict[str, Any]]] = {}
        try:
            tasks = {
                key: asyncio.to_thread(
                    build_entities_uncached,
                    include_derived=key[0],
                    sort_mode=key[1],
                )
                for key in needed
            }
            results = await asyncio.wait_for(
                asyncio.gather(*tasks.values(), return_exceptions=True),
                timeout=_BUILD_TIMEOUT_SEC,
            )
            for key, result in zip(tasks.keys(), results):
                if isinstance(result, Exception):
                    log.warning("entity mirror build failed key=%s: %s", key, result)
                    prior = self._snapshots.get(key)
                    if prior:
                        built[key] = list(prior.items)
                    else:
                        built[key] = []
                else:
                    built[key] = list(result or [])
        except Exception as exc:
            log.warning("entity mirror rebuild failed: %s", exc)
            return self._revision

        now = _time.monotonic()
        for key, items in built.items():
            self._snapshots[key] = _Snapshot(items=items, by_id=_index_items(items), built_at=now)

        self._revision += 1
        self._last_trigger = trigger
        sk = store_key if store_key is not None else self._last_store_key
        self._last_store_key = None

        payload = {
            "revision": self._revision,
            "trigger": trigger,
            "store_key": sk or "",
            "entity_count": len(self._snapshots.get((True, "name"), _Snapshot()).items),
        }
        event_bus.publish(TOPIC_MIRROR_TICK, payload)

        dead: list[str] = []
        for target in self._targets:
            items = built.get(_snapshot_key(target.include_derived, target.sort_mode), [])
            try:
                await target.handler(items)
            except Exception as exc:
                log.warning("entity mirror push target %s failed: %s", target.target_id, exc)
                dead.append(target.target_id)
        for target_id in dead:
            self.unregister_push_target(target_id)

        return self._revision

    async def _loop(self) -> None:
        log.info("EntityMirror started (tick=%.1fs)", self._tick_sec)
        try:
            await self.refresh_now(trigger="boot")
            while not self._stop.is_set():
                source_refresh = False
                try:
                    await asyncio.wait_for(self._kick.wait(), timeout=self._tick_sec)
                    source_refresh = True
                except asyncio.TimeoutError:
                    pass
                if self._stop.is_set():
                    break
                trigger = "source" if source_refresh else "tick"
                await self.refresh_now(trigger=trigger, store_key=self._last_store_key)
                self._last_store_key = None
                self._kick.clear()
        except asyncio.CancelledError:
            log.info("EntityMirror stopped")
        finally:
            self._loop_task = None

    def start(self) -> None:
        if self.is_running():
            return
        self._stop.clear()
        self._loop_task = asyncio.create_task(self._loop(), name="entity-mirror")

    async def stop(self) -> None:
        self._stop.set()
        self._kick.set()
        task = self._loop_task
        self._loop_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


_mirror: EntityMirror | None = None


def get_entity_mirror() -> EntityMirror:
    global _mirror
    if _mirror is None:
        _mirror = EntityMirror()
    return _mirror


def signal_source_refresh(store_key: str | None = None) -> None:
    """Notify the mirror that an upstream integration finished syncing."""
    mirror = get_entity_mirror()
    mirror.signal_source_refresh(store_key)
    if mirror.is_running():
        return
    # Before startup wiring, catalog invalidation still helps readers.
    try:
        from core.entity_catalog import invalidate_entity_cache

        invalidate_entity_cache()
    except Exception:
        pass
