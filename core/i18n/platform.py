"""Platform UI bundles under ``core/i18n/<bundle>/translations/``."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from core.i18n.util import deep_merge, load_translation_file, load_translations_dir, normalize_lang

_ROOT = Path(__file__).resolve().parent
_cache: dict[str, dict[str, Any]] = {}


def platform_bundle_dirs() -> list[Path]:
    return sorted(
        path for path in _ROOT.iterdir()
        if path.is_dir() and not path.name.startswith("_") and path.name != "util"
    )


def get_platform_translations(lang: str, *, force: bool = False) -> dict[str, Any]:
    """Merge each subfolder as a top-level namespace (e.g. ``cameras.*``)."""
    language = normalize_lang(lang)
    if not force and language in _cache:
        return _cache[language]

    merged: dict[str, Any] = {}
    for bundle_dir in platform_bundle_dirs():
        if not (bundle_dir / "translations").is_dir():
            continue
        payload = load_translations_dir(bundle_dir, language)
        if payload:
            deep_merge(merged, {bundle_dir.name: payload})

    _cache[language] = merged
    return merged


def invalidate_cache() -> None:
    _cache.clear()
