"""
Dashboard live WebSocket router (Phase 4).

Pushes entity-state diffs to the dashboard UI so cards update in
near-real-time without the client having to poll. Each connection runs
its own lightweight poller on the server side that compares the
current entity snapshot against the last snapshot it sent and emits
only the diff. The first message after connect is a full snapshot.

Wire format:
    -> {"type":"ping"}
    <- {"type":"pong"}
    <- {"type":"snapshot","items":[{entity_id,state,attributes,available,unit}, ...]}
    <- {"type":"diff","items":[{entity_id,state,...}]}        # only changed
    <- {"type":"removed","entity_ids":[...]}                   # gone
"""
from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

import auth
import database
import models
from logger import log_line

# Re-use the heavy lifting from the existing dashboard module.
from routers.dashboard import _available_entities, _scene_synthetic_entities

router = APIRouter(prefix="/api/dashboard", tags=["dashboard-ws"])

# How often each connection polls the entity store.
_POLL_INTERVAL_SEC = 1.5


def _entity_signature(item: dict[str, Any]) -> dict[str, Any]:
    """Slim, comparable representation of an entity used in diffs."""
    return {
        "entity_id": item.get("entity_id"),
        "state": item.get("state"),
        "available": item.get("available", True),
        "unit": item.get("unit") or "",
        "attributes": item.get("attributes") or {},
    }


def _diff_snapshot(prev: dict[str, dict], curr_items: list[dict]) -> tuple[list[dict], list[str]]:
    changed: list[dict] = []
    curr_ids: set[str] = set()
    for item in curr_items:
        sig = _entity_signature(item)
        eid = sig["entity_id"]
        if not eid:
            continue
        curr_ids.add(eid)
        old = prev.get(eid)
        if old != sig:
            changed.append(sig)
    removed = [eid for eid in prev.keys() if eid not in curr_ids]
    return changed, removed


async def _authenticate(token: str | None) -> models.User | None:
    return auth.authenticate_ws_token(token)


@router.websocket("/ws/live")
async def dashboard_live_ws(websocket: WebSocket, token: str = Query(default=None)):
    """Streams entity state diffs to the dashboard."""
    user = await _authenticate(token)
    if not user:
        await websocket.close(code=1008, reason="auth required")
        return

    await websocket.accept()
    log_line("websocket", "📊", "DASH_WS_OPEN", f"user={user.username}")

    last_signatures: dict[str, dict[str, Any]] = {}
    stop = asyncio.Event()

    async def _poller():
        nonlocal last_signatures
        try:
            while not stop.is_set():
                try:
                    items = await _available_entities()
                    # Best-effort: include scenes (cheap, sync).
                    try:
                        db = next(database.get_db())
                        try:
                            items = items + _scene_synthetic_entities(db, user)
                        finally:
                            db.close()
                    except Exception:
                        pass

                    if not last_signatures:
                        # First push: full snapshot.
                        sigs = [_entity_signature(it) for it in items if it.get("entity_id")]
                        last_signatures = {sig["entity_id"]: sig for sig in sigs}
                        await websocket.send_json({"type": "snapshot", "items": sigs})
                    else:
                        # Guard against transient empty polls broadcasting mass removal
                        if not items and last_signatures:
                            pass  # skip diff on empty response — likely transient failure
                        else:
                            changed, removed = _diff_snapshot(last_signatures, items)
                            if changed:
                                await websocket.send_json({"type": "diff", "items": changed})
                                for sig in changed:
                                    last_signatures[sig["entity_id"]] = sig
                            # Protect against mass removal (>80% at once = likely transient)
                            if removed and len(removed) < len(last_signatures) * 0.8:
                                await websocket.send_json({"type": "removed", "entity_ids": removed})
                                for eid in removed:
                                    last_signatures.pop(eid, None)
                except Exception as exc:
                    log_line("websocket", "⚠️", "DASH_WS_POLL", f"{exc}")
                try:
                    await asyncio.wait_for(stop.wait(), timeout=_POLL_INTERVAL_SEC)
                except asyncio.TimeoutError:
                    continue
        except Exception:
            pass

    poll_task = asyncio.create_task(_poller())

    try:
        while True:
            msg = await websocket.receive_text()
            if msg == "ping" or msg.startswith("ping:"):
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log_line("websocket", "⚠️", "DASH_WS_ERR", f"{exc}")
    finally:
        stop.set()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(poll_task, timeout=1.0)
        with contextlib.suppress(Exception):
            await websocket.close()
        log_line("websocket", "📊", "DASH_WS_CLOSE", f"user={user.username}")
