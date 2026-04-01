"""Utilities for tracked asyncio background tasks with error logging."""
import asyncio
import contextvars
from typing import Set, Coroutine, Any

from logger import log_line

# Global set to prevent GC of fire-and-forget tasks
_background_tasks: Set[asyncio.Task] = set()


def create_tracked_task(coro: Coroutine[Any, Any, Any], *, name: str = "") -> asyncio.Task:
    """Create an asyncio task that is tracked (won't be GC'd) and logs exceptions.

    Use this instead of bare ``asyncio.create_task()`` for fire-and-forget work
    like memory pipelines, notification sends, etc.
    """
    ctx = contextvars.copy_context()
    try:
        task = asyncio.create_task(coro, name=name or None, context=ctx)
    except TypeError:
        task = ctx.run(asyncio.create_task, coro, name=name or None)
    _background_tasks.add(task)

    def _on_done(t: asyncio.Task) -> None:
        _background_tasks.discard(t)
        if t.cancelled():
            return
        exc = t.exception()
        if exc:
            label = name or t.get_name()
            log_line("error", "⚠️", "TASK", f"Background task '{label}' failed: {type(exc).__name__}: {exc}")

    task.add_done_callback(_on_done)
    return task


def pending_task_count() -> int:
    """Return the number of currently tracked background tasks."""
    return len(_background_tasks)
