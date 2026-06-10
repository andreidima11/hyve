"""
Debug endpoints for diagnosing event-loop hangs.

Mirrors Home Assistant's `/api/debug/` namespace: protected by admin auth,
returns runtime diagnostics that are normally only visible via py-spy.
"""

from __future__ import annotations

import asyncio
import os
import time

from fastapi import APIRouter, Depends, HTTPException

import models
from auth import get_current_user
from core.http.errors import error_detail
from core.loop_watchdog import dump_all_stacks

router = APIRouter(prefix="/api/debug", tags=["debug"])


def _require_admin(user: models.User) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail=error_detail("common.admin_required"))


@router.get("/stacks")
async def get_stacks(user: models.User = Depends(get_current_user)):
    """Return current Python stacks for every thread (admin only)."""
    _require_admin(user)
    return {
        "pid": os.getpid(),
        "timestamp": time.time(),
        "stacks": dump_all_stacks(),
    }


@router.get("/loop")
async def get_loop_status(user: models.User = Depends(get_current_user)):
    """Quick liveness probe: returns how long a yield round-trip takes.

    Values >100ms suggest the event loop is under load; >1s means a
    blocking call is in progress.
    """
    _require_admin(user)
    started = time.monotonic()
    await asyncio.sleep(0)
    yield_ms = (time.monotonic() - started) * 1000
    started = time.monotonic()
    await asyncio.sleep(0.05)
    sleep_ms = (time.monotonic() - started) * 1000
    return {
        "yield_ms": round(yield_ms, 3),
        "sleep_50ms_actual_ms": round(sleep_ms, 3),
        "tasks": len(asyncio.all_tasks()),
    }


@router.get("/tasks")
async def list_tasks(user: models.User = Depends(get_current_user)):
    """List currently scheduled asyncio tasks (admin only)."""
    _require_admin(user)
    out = []
    for t in asyncio.all_tasks():
        coro = t.get_coro()
        out.append({
            "name": t.get_name(),
            "done": t.done(),
            "coro": getattr(coro, "__qualname__", repr(coro)),
        })
    return {"count": len(out), "tasks": out}
