"""
Asyncio event-loop watchdog (Home Assistant style).

A monitor thread checks an in-loop heartbeat and, if the loop is blocked
beyond ``threshold_seconds``, dumps every Python thread's stack to the
log so the offending blocking call can be identified post-mortem.

This is intentionally lightweight: one asyncio task that updates a
timestamp every ``poll_seconds`` and one OS thread that watches that
timestamp. No third-party dependencies.

Usage::

    from core.loop_watchdog import start_loop_watchdog
    start_loop_watchdog()
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import traceback
from typing import Optional

log = logging.getLogger("loop_watchdog")

_state: dict = {
    "task": None,
    "thread": None,
    "stop": False,
    "last_beat": 0.0,
    "last_dump": 0.0,
}


def _format_all_stacks() -> str:
    frames = sys._current_frames()
    parts: list[str] = []
    for tid, frame in frames.items():
        thread_name = "?"
        for t in threading.enumerate():
            if t.ident == tid:
                thread_name = t.name
                break
        parts.append(f"\n--- Thread {tid} ({thread_name}) ---")
        parts.append("".join(traceback.format_stack(frame)).rstrip())
    return "\n".join(parts)


async def _heartbeat(poll_seconds: float) -> None:
    while not _state["stop"]:
        _state["last_beat"] = time.monotonic()
        try:
            await asyncio.sleep(poll_seconds)
        except asyncio.CancelledError:
            break


def _watcher(threshold_seconds: float, poll_seconds: float, dump_cooldown: float) -> None:
    # Wait for the first beat so we don't false-positive at startup.
    while not _state["stop"] and _state["last_beat"] == 0.0:
        time.sleep(poll_seconds)

    while not _state["stop"]:
        time.sleep(poll_seconds)
        delta = time.monotonic() - _state["last_beat"]
        if delta < threshold_seconds:
            continue
        now = time.monotonic()
        if now - _state["last_dump"] < dump_cooldown:
            continue
        _state["last_dump"] = now
        try:
            log.warning(
                "Event loop blocked for %.2fs (threshold %.2fs). Stack dump:%s",
                delta,
                threshold_seconds,
                _format_all_stacks(),
            )
        except Exception as exc:  # pragma: no cover
            log.error("loop watchdog dump failed: %s", exc)


def start_loop_watchdog(
    *,
    threshold_seconds: float = 2.0,
    poll_seconds: float = 0.25,
    dump_cooldown: float = 30.0,
) -> None:
    """Install the loop watchdog (idempotent)."""
    if _state["task"] is not None:
        return
    loop = asyncio.get_event_loop()
    _state["stop"] = False
    _state["last_beat"] = 0.0
    _state["last_dump"] = 0.0
    _state["task"] = loop.create_task(
        _heartbeat(poll_seconds), name="loop-watchdog-heartbeat"
    )
    t = threading.Thread(
        target=_watcher,
        args=(threshold_seconds, poll_seconds, dump_cooldown),
        name="loop-watchdog",
        daemon=True,
    )
    _state["thread"] = t
    t.start()
    log.info(
        "loop watchdog started (threshold=%.2fs, poll=%.2fs)",
        threshold_seconds,
        poll_seconds,
    )


async def stop_loop_watchdog() -> None:
    _state["stop"] = True
    task: Optional[asyncio.Task] = _state.get("task")
    if task and not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    _state["task"] = None
    _state["thread"] = None


def dump_all_stacks() -> str:
    """Return a string with every thread's current stack (for debug endpoint)."""
    return _format_all_stacks()
