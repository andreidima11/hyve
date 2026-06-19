"""Denylist paths that must never be read via agent tools."""

from __future__ import annotations

import os

_DENIED_BASENAMES = frozenset({
    ".env",
    ".secret_key",
    "config.json",
    "assist_keys.json",
    "integration_entries.key",
    "integration_entries.sqlite",
    "hyve.db",
})

_DENIED_PREFIXES = (
    "secrets/",
    "secrets\\",
    "core/.secret_key",
    "core\\secret_key",
)


def is_denied_agent_read_path(relative_path: str) -> bool:
    """True when *relative_path* must not be read by file_read / similar tools."""
    if not relative_path:
        return False
    norm = relative_path.strip().lstrip("/").replace("\\", "/")
    if not norm or ".." in norm.split("/"):
        return False
    base = os.path.basename(norm)
    if base in _DENIED_BASENAMES:
        return True
    lowered = norm.lower()
    for prefix in _DENIED_PREFIXES:
        if lowered == prefix.rstrip("/") or lowered.startswith(prefix):
            return True
    return False
