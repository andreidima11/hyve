"""Shared WebSocket entity snapshot hub — one poller, many subscribers."""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from fastapi import WebSocket
from logger import log_line


def entity_signature(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "entity_id": item.get("entity_id"),
        "state": item.get("state"),
        "available": item.get("available", True),
        "unit": item.get("unit") or "",
        "attributes": item.get("attributes") or {},
    }


def diff_snapshot(prev: dict[str, dict], curr_items: list[dict]) -> tuple[list[dict], list[str]]:
    changed: list[dict] = []
    curr_ids: set[str] = set()
    for item in curr_items:
        sig = entity_signature(item)
        eid = sig["entity_id"]
        if not eid:
            continue
        curr_ids.add(eid)
        old = prev.get(eid)
        if old != sig:
            changed.append(sig)
    removed = [eid for eid in prev.keys() if eid not in curr_ids]
    return changed, removed


class _UserLike(Protocol):
    username: str


FetchItemsFn = Callable[[], Awaitable[list[dict[str, Any]]]]
EnrichItemsFn = Callable[[list[dict[str, Any]], _UserLike], Awaitable[list[dict[str, Any]]]]


@dataclass
class _LiveClient:
    websocket: WebSocket
    user: _UserLike
    last_signatures: dict[str, dict[str, Any]] = field(default_factory=dict)


class LiveEntityWsHub:
    """Fan out entity diffs to every connected WebSocket.

    When ``mirror_driven`` is True the hub does not poll — ``EntityMirror``
    pushes fresh snapshots via :meth:`ingest_snapshot`.
    """

    def __init__(
        self,
        *,
        name: str,
        poll_interval_sec: float,
        fetch_items: FetchItemsFn,
        enrich_items: EnrichItemsFn | None = None,
        log_icon: str = "📊",
        mirror_driven: bool = False,
        mirror_include_derived: bool = True,
        mirror_sort_mode: str = "name",
    ) -> None:
        self._name = name
        self._poll_interval = poll_interval_sec
        self._fetch_items = fetch_items
        self._enrich_items = enrich_items
        self._log_icon = log_icon
        self._mirror_driven = mirror_driven
        self._mirror_include_derived = bool(mirror_include_derived)
        self._mirror_sort_mode = mirror_sort_mode if mirror_sort_mode in {"name", "dashboard"} else "name"
        self._clients: dict[int, _LiveClient] = {}
        self._poll_task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def attach(self, websocket: WebSocket, user: _UserLike) -> None:
        self._clients[id(websocket)] = _LiveClient(websocket=websocket, user=user)
        if self._mirror_driven:
            asyncio.create_task(self._ingest_initial_mirror_snapshot())
        else:
            self._ensure_poller()

    async def _ingest_initial_mirror_snapshot(self) -> None:
        if not self._clients:
            return
        try:
            from core.entity_mirror import get_entity_mirror

            items = await get_entity_mirror().get_items(
                include_derived=self._mirror_include_derived,
                sort_mode=self._mirror_sort_mode,
            )
            await self.ingest_snapshot(items)
        except Exception as exc:
            log_line("websocket", "⚠️", f"{self._name.upper()}_WS_BOOT", f"{exc}")

    async def detach(self, websocket: WebSocket) -> None:
        self._clients.pop(id(websocket), None)
        if not self._mirror_driven and not self._clients:
            await self._stop_poller()

    async def ingest_snapshot(self, items: list[dict[str, Any]]) -> None:
        """Apply a mirror-built entity list to all connected clients."""
        if not self._clients:
            return
        dead: list[int] = []
        for cid, client in list(self._clients.items()):
            enriched = await self._items_for_client(items, client)
            if not await self._deliver(client, enriched):
                dead.append(cid)
        for cid in dead:
            self._clients.pop(cid, None)

    def _ensure_poller(self) -> None:
        if self._poll_task and not self._poll_task.done():
            return
        self._stop.clear()
        self._poll_task = asyncio.create_task(self._poll_loop(), name=f"live-ws-{self._name}")

    async def _stop_poller(self) -> None:
        self._stop.set()
        task = self._poll_task
        self._poll_task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _items_for_client(self, base_items: list[dict[str, Any]], client: _LiveClient) -> list[dict[str, Any]]:
        if self._enrich_items is None:
            return base_items
        return await self._enrich_items(base_items, client.user)

    async def _deliver(self, client: _LiveClient, items: list[dict[str, Any]]) -> bool:
        """Push snapshot/diff to one client. Returns False if the socket is dead."""
        last = client.last_signatures
        try:
            if not last:
                sigs = [entity_signature(it) for it in items if it.get("entity_id")]
                client.last_signatures = {sig["entity_id"]: sig for sig in sigs}
                await client.websocket.send_json({"type": "snapshot", "items": sigs})
                return True

            if not items and last:
                return True

            changed, removed = diff_snapshot(last, items)
            if changed:
                await client.websocket.send_json({"type": "diff", "items": changed})
                for sig in changed:
                    last[sig["entity_id"]] = sig
            if removed:
                threshold = max(10, int(len(last) * 0.8))
                if len(removed) < threshold:
                    await client.websocket.send_json({"type": "removed", "entity_ids": removed})
                    for eid in removed:
                        last.pop(eid, None)
                else:
                    log_line(
                        "websocket",
                        "⚠️",
                        f"{self._name.upper()}_WS_POLL",
                        f"large removal ignored ({len(removed)}/{len(last)})",
                    )
            return True
        except Exception as exc:
            log_line("websocket", "⚠️", f"{self._name.upper()}_WS_SEND", f"{exc}")
            return False

    async def _poll_loop(self) -> None:
        tag = f"{self._name.upper()}_WS_POLL"
        try:
            while not self._stop.is_set():
                try:
                    base_items = await self._fetch_items()
                    dead: list[int] = []
                    for cid, client in list(self._clients.items()):
                        items = await self._items_for_client(base_items, client)
                        if not await self._deliver(client, items):
                            dead.append(cid)
                    for cid in dead:
                        self._clients.pop(cid, None)
                except Exception as exc:
                    log_line("websocket", "⚠️", tag, f"{exc}")

                if not self._clients:
                    break

                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self._poll_interval)
                    break
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            pass
        finally:
            self._poll_task = None
