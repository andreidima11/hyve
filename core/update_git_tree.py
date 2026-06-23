"""Git tree helpers for Hyve self-update — runtime vs. source paths.

Layer 1 (repo): ``scripts/check_tracked_artifacts.py`` blocks committing build/cache files.
Layer 2 (server): before in-app update, discard dirty paths classified here as safe runtime artifacts.
"""

from __future__ import annotations

# Exact paths that may differ on a running server (settings, lockfile, CSS emit).
_LOCAL_RUNTIME_EXACT = frozenset(
    {
        "config.json",
        "package-lock.json",
        "static/css/tailwind.built.css",
        # Version bump files — safe to reset before git checkout / artifact apply.
        "core/settings.py",
        "package.json",
        "README.md",
        "android/HyveBridge/app/build.gradle.kts",
    }
)

# Directory prefixes — entire trees are build/runtime output on the server.
_LOCAL_RUNTIME_PREFIXES = (
    "static/dist/",
    "static/hyveview/",
    "node_modules/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    "logs/",
    "core/logs/",
    "output/",
    "chroma_db/",
    "sessions/",
    "conferences/",
    ".venv/",
    "venv/",
    "static/css/themes/",
)

# In-path markers (anywhere in the path).
_LOCAL_RUNTIME_SEGMENTS = (
    "/__pycache__/",
    "__pycache__/",
)

# Suffixes for generated/cache files.
_LOCAL_RUNTIME_SUFFIXES = (
    ".pyc",
    ".pyo",
    ".js.map",
)

# Legacy tsc/vite emit beside sources — edit .ts only.
_LEGACY_STATIC_JS_PREFIX = "static/js/"


def is_safe_runtime_dirty_path(path: str) -> bool:
    """True when local git diffs on ``path`` should not block in-app Hyve update."""
    normalized = str(path or "").replace("\\", "/").strip()
    if not normalized:
        return False
    if normalized in _LOCAL_RUNTIME_EXACT:
        return True
    for prefix in _LOCAL_RUNTIME_PREFIXES:
        if normalized.startswith(prefix):
            return True
    for segment in _LOCAL_RUNTIME_SEGMENTS:
        if segment in normalized:
            return True
    for suffix in _LOCAL_RUNTIME_SUFFIXES:
        if normalized.endswith(suffix):
            return True
    if normalized.startswith(_LEGACY_STATIC_JS_PREFIX) and normalized.endswith(".js"):
        # lang/*.js remain tracked sources; still safe to reset emit on update.
        return True
    return False


# Stricter set: must never be ``git add``'d (CI gate).
_FORBIDDEN_TRACKED_SEGMENTS = (
    "/__pycache__/",
    "__pycache__/",
)

_FORBIDDEN_TRACKED_PREFIXES = (
    "static/dist/",
    "node_modules/",
    ".venv/",
    "venv/",
    ".pytest_cache/",
)

_FORBIDDEN_TRACKED_SUFFIXES = (
    ".pyc",
    ".pyo",
)


def is_forbidden_tracked_path(path: str) -> bool:
    """True when ``path`` must not appear in ``git ls-files`` (accidental commit)."""
    normalized = str(path or "").replace("\\", "/").strip()
    if not normalized:
        return False
    for prefix in _FORBIDDEN_TRACKED_PREFIXES:
        if normalized.startswith(prefix):
            return True
    for segment in _FORBIDDEN_TRACKED_SEGMENTS:
        if segment in normalized:
            return True
    for suffix in _FORBIDDEN_TRACKED_SUFFIXES:
        if normalized.endswith(suffix):
            return True
    return False
