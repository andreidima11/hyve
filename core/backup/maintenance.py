"""Process-wide maintenance mode during backup restore."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

_lock = threading.Lock()
_depth = 0
_reason = ""


@dataclass(frozen=True)
class MaintenanceStatus:
    active: bool
    reason: str


def get_status() -> MaintenanceStatus:
    with _lock:
        return MaintenanceStatus(active=_depth > 0, reason=_reason)


def is_active() -> bool:
    return get_status().active


def enter(reason: str) -> None:
    global _depth, _reason
    with _lock:
        _depth += 1
        if _depth == 1:
            _reason = reason or "maintenance"


def exit_maintenance() -> None:
    global _depth, _reason
    with _lock:
        _depth = max(0, _depth - 1)
        if _depth == 0:
            _reason = ""


@contextmanager
def maintenance_mode(reason: str) -> Iterator[None]:
    enter(reason)
    try:
        yield
    finally:
        exit_maintenance()


def path_allowed_during_maintenance(path: str) -> bool:
    """Return True if the request may proceed while maintenance is active."""
    if path.startswith("/static/") or path in {"/", "/sw.js"}:
        return True
    if path.startswith("/api/backup"):
        return True
    if path in {"/api/health", "/api/startup/status"}:
        return True
    if path.startswith("/api/auth/") or path == "/api/users/me":
        return True
    return False
