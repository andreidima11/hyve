"""Resolve Hyve HTTP bind address."""

from __future__ import annotations

import os

import core.settings as settings


def resolve_bind_host() -> str:
    """Return the host interface Hyve should listen on.

    - ``HYVE_BIND_HOST`` env overrides everything.
    - Until setup completes, defaults to ``127.0.0.1`` (cloudflared / local proxy still works).
    - After setup, defaults to ``0.0.0.0``.
    """
    env = (os.environ.get("HYVE_BIND_HOST") or "").strip()
    if env:
        return env
    security = settings.CFG.get("security") if isinstance(settings.CFG.get("security"), dict) else {}
    cfg_host = str(security.get("bind_host") or "").strip()
    if cfg_host:
        return cfg_host
    from core.setup_service import is_setup_complete

    if not is_setup_complete():
        return "127.0.0.1"
    return str(security.get("listen_host") or "0.0.0.0").strip() or "0.0.0.0"
