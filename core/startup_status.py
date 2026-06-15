"""Track Hyve startup progress (integrations, addons) for the UI loading indicator."""

from __future__ import annotations

import threading
import time
from typing import Any, Literal

SubsystemLevel = Literal["ok", "degraded", "fatal"]

_lock = threading.Lock()
_started_at = time.time()
_core_ready = False
_tasks: dict[str, bool] = {
    "integrations": False,
    "addons": False,
}

_subsystems: dict[str, dict[str, Any]] = {}

_TASK_LABELS = {
    "integrations": "Integrations",
    "addons": "Services",
}

_SUBSYSTEM_LABELS = {
    "scheduler": "Scheduler",
    "entities": "Entity store",
    "memory": "Memory",
    "watchdog": "Watchdog",
    "integration_lifecycle": "Integration hooks",
    "entity_mirror": "Entity mirror",
    "history": "History",
    "sun": "Sun",
    "integrations": "Integrations",
    "addons": "Services",
    "i18n": "Translations",
    "auth": "Auth",
}


def reset_startup_status() -> None:
    """Call at the beginning of each server lifespan."""
    global _started_at, _core_ready
    with _lock:
        _started_at = time.time()
        _core_ready = False
        for key in _tasks:
            _tasks[key] = False
        _subsystems.clear()


def set_startup_core_ready() -> None:
    global _core_ready
    with _lock:
        _core_ready = True


def mark_startup_task_done(name: str) -> None:
    with _lock:
        if name in _tasks:
            _tasks[name] = True


def report_subsystem(name: str, level: SubsystemLevel, *, message: str = "") -> None:
    """Record a subsystem health outcome from a startup phase."""
    key = str(name or "").strip()
    if not key:
        return
    entry = {
        "name": key,
        "label": _SUBSYSTEM_LABELS.get(key, key.replace("_", " ").title()),
        "level": level,
        "message": str(message or "").strip(),
    }
    with _lock:
        _subsystems[key] = entry


def _subsystem_snapshot() -> list[dict[str, Any]]:
    with _lock:
        return [dict(item) for item in _subsystems.values()]


def _overall_health(subsystems: list[dict[str, Any]]) -> SubsystemLevel:
    if any(item.get("level") == "fatal" for item in subsystems):
        return "fatal"
    if any(item.get("level") == "degraded" for item in subsystems):
        return "degraded"
    return "ok"


def get_startup_status() -> dict[str, Any]:
    with _lock:
        pending = [name for name, done in _tasks.items() if not done]
        ready = _core_ready and not pending
        subsystems = [dict(item) for item in _subsystems.values()]
        if ready:
            message = "ready"
        elif not _core_ready:
            message = "starting"
        elif pending:
            message = pending[0]
        else:
            message = "starting"
        task_total = len(_tasks)
        task_done = task_total - len(pending)

    health = _overall_health(subsystems)
    issues = [item for item in subsystems if item.get("level") in ("degraded", "fatal")]

    elapsed = max(0.0, time.time() - _started_at)
    if ready:
        progress = 100
    elif not _core_ready:
        progress = min(18, int(8 + elapsed * 2))
    else:
        progress = 35 + int(55 * task_done / max(task_total, 1))

    return {
        "ready": ready,
        "core_ready": _core_ready,
        "phase": "ready" if ready else "starting",
        "message": message,
        "pending": pending,
        "pending_labels": [_TASK_LABELS.get(p, p) for p in pending],
        "elapsed_seconds": round(elapsed, 1),
        "progress": progress,
        "health": health,
        "subsystems": subsystems,
        "issues": issues,
    }
