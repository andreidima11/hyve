"""Paths preserved during artifact-based Hyve self-update.

User data and runtime trees must never be overwritten by a release tarball.
Code trees from ``core/backup/paths.py`` Tier A/B/C inform the preserve list.
"""

from __future__ import annotations

from pathlib import Path

from core.backup.paths import CRITICAL_FILES, OPTIONAL_DIRS, USER_DIRS

# Single files that always stay on the server (config, secrets, databases).
PRESERVE_FILES = frozenset(
    {
        *CRITICAL_FILES,
        ".gitignore",
        ".hyve_server.pid",
        "install.sh",
    }
)

# Directory prefixes — anything under these paths is kept as-is.
PRESERVE_PREFIXES = tuple(
    sorted(
        {
            *USER_DIRS,
            *OPTIONAL_DIRS,
            "output/",
            "logs/",
            ".venv/",
            "venv/",
            "node_modules/",
            ".git/",
            "core/logs/",
            "core/automations/",
            "secrets/",
            "config/",
            "static/generated/",
            "conferences/",
            "custom_components/",
            "custom_addons/",
            "dashboards/",
            "skills/",
            "chroma_db/",
            "sessions/",
        }
    )
)


def normalize_rel_path(path: str | Path) -> str:
    return str(path or "").replace("\\", "/").strip().lstrip("./")


def should_preserve_path(rel_path: str | Path) -> bool:
    """True when ``rel_path`` (relative to Hyve root) must not be replaced."""
    normalized = normalize_rel_path(rel_path)
    if not normalized:
        return True
    if normalized in PRESERVE_FILES:
        return True
    for prefix in PRESERVE_PREFIXES:
        if normalized == prefix.rstrip("/") or normalized.startswith(prefix):
            return True
    return False
