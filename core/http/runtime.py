"""Process-wide asyncio runtime handles (main event loop for thread callbacks)."""

from __future__ import annotations

import asyncio
import logging
from typing import TypeVar

log = logging.getLogger("runtime")

_main_loop: asyncio.AbstractEventLoop | None = None

T = TypeVar("T")


def set_main_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    global _main_loop
    _main_loop = loop


def get_main_loop() -> asyncio.AbstractEventLoop | None:
    return _main_loop


def run_coroutine_on_main_loop(
    coro,
    *,
    timeout: float = 30.0,
    allow_fallback: bool = False,
) -> T:
    """Run *coro* on the Hyve main loop from a worker thread (e.g. APScheduler).

    When *allow_fallback* is True and the main loop is unavailable (unit tests),
    runs the coroutine on a short-lived temporary loop instead of spawning one
    silently in production hot paths.
    """
    loop = get_main_loop()
    if loop is not None and loop.is_running():
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=timeout)

    if allow_fallback:
        log.debug("run_coroutine_on_main_loop: using temporary loop (allow_fallback=True)")
        temp = asyncio.new_event_loop()
        try:
            return temp.run_until_complete(coro)
        finally:
            temp.close()

    raise RuntimeError(
        "Hyve main event loop is not running; refuse to spawn orphan event loop"
    )
