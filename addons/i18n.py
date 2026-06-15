"""Per-addon translation JSON from addon catalog folders."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from addons import registry
from core.i18n.util import deep_merge, load_translation_file, normalize_lang

log = logging.getLogger("addons.i18n")

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_CATALOG_TRANSLATIONS = Path(__file__).resolve().parent / "translations"
_CUSTOM_DIR = Path(
    os.environ.get("HYVE_CUSTOM_ADDONS_DIR")
    or (_PROJECT_ROOT / "custom_addons")
)
_cache: dict[str, dict[str, Any]] = {}


def _addon_dirs_for_slug(slug: str) -> list[Path]:
    slug = str(slug or "").strip()
    if not slug:
        return []
    dirs: list[Path] = []
    bundled = _PROJECT_ROOT / "addons" / "available" / slug
    if bundled.is_dir():
        dirs.append(bundled)
    custom = _CUSTOM_DIR / slug
    if custom.is_dir():
        dirs.append(custom)
    return dirs


def discovered_addon_slugs() -> set[str]:
    return {str(m.get("slug") or "").strip() for m in registry.list_available() if m.get("slug")}


def installed_addon_slugs() -> set[str]:
    slugs: set[str] = set()
    for addon in registry.list_all():
        state = addon.get("state") or {}
        if state.get("installed"):
            slug = str(addon.get("slug") or "").strip()
            if slug:
                slugs.add(slug)
    return slugs


def _namespace_addon(slug: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"addons": {slug: payload}}


def get_addon_translations(
    lang: str,
    *,
    slugs: set[str] | None = None,
    include_catalog_shared: bool = True,
    force: bool = False,
) -> dict[str, Any]:
    """Return ``addons.<slug>.*`` plus shared ``apps.*`` from ``addons/translations/``."""
    language = normalize_lang(lang)
    target_slugs = slugs if slugs is not None else discovered_addon_slugs()
    cache_key = f"{language}:{'|'.join(sorted(target_slugs))}:{include_catalog_shared}"
    if not force and cache_key in _cache:
        return _cache[cache_key]

    merged: dict[str, Any] = {}
    if include_catalog_shared and _CATALOG_TRANSLATIONS.is_dir():
        shared = load_translation_file(_CATALOG_TRANSLATIONS / f"{language}.json")
        if shared is None and language != "en":
            shared = load_translation_file(_CATALOG_TRANSLATIONS / "en.json")
        if shared:
            deep_merge(merged, shared)

    for slug in sorted(target_slugs):
        payload: dict[str, Any] | None = None
        for addon_dir in _addon_dirs_for_slug(slug):
            trans_path = addon_dir / "translations" / f"{language}.json"
            candidate = load_translation_file(trans_path)
            if candidate is None and language != "en":
                candidate = load_translation_file(addon_dir / "translations" / "en.json")
            if candidate:
                payload = deep_merge(payload or {}, candidate)
        if payload:
            deep_merge(merged, _namespace_addon(slug, payload))

    _cache[cache_key] = merged
    return merged


def invalidate_cache() -> None:
    _cache.clear()
