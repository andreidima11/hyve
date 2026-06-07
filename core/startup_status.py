"""Track Hyve startup progress (integrations, addons) for the UI loading indicator."""
from __future__ import annotations

import threading
import time
from typing import Any

_lock = threading.Lock()
_started_at = time.time()
_core_ready = False
_tasks: dict[str, bool] = {
    "integrations": False,
    "addons": False,
}

_TASK_LABELS = {
    "integrations": "Integrations",
    "addons": "Services",
}


def reset_startup_status() -> None:
    """Call at the beginning of each server lifespan."""
    global _started_at, _core_ready
    with _lock:
        _started_at = time.time()
        _core_ready = False
        for key in _tasks:
            _tasks[key] = False


def set_startup_core_ready() -> None:
    global _core_ready
    with _lock:
        _core_ready = True


def mark_startup_task_done(name: str) -> None:
    with _lock:
        if name in _tasks:
            _tasks[name] = True


def _pending_tasks() -> list[str]:
    with _lock:
        return [name for name, done in _tasks.items() if not done]


def get_startup_status() -> dict[str, Any]:
    with _lock:
        pending = [name for name, done in _tasks.items() if not done]
        ready = _core_ready and not pending
        if ready:
            message = "ready"
        elif not _core_ready:
            message = "starting"
        elif pending:
            message = pending[0]
        else:
            message = "starting"

    elapsed = max(0.0, time.time() - _started_at)
    return {
        "ready": ready,
        "core_ready": _core_ready,
        "phase": "ready" if ready else "starting",
        "message": message,
        "pending": pending,
        "pending_labels": [_TASK_LABELS.get(p, p) for p in pending],
        "elapsed_seconds": round(elapsed, 1),
    }
