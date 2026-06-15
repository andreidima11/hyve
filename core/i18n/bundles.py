"""Merge platform, integration, and add-on translation bundles for the UI."""

from __future__ import annotations

from typing import Any

from addons import i18n as addon_i18n
from core.i18n.platform import get_platform_translations, invalidate_cache as invalidate_platform_cache
from core.i18n.util import deep_merge, normalize_lang
from integrations import component_i18n

_bundle_cache: dict[str, dict[str, Any]] = {}


def warm_cache() -> None:
    """Preload EN/RO bundles for startup."""
    for lang in ("en", "ro"):
        get_bundled_translations(lang, all_components=True, all_addons=True, force=True)


def invalidate_cache() -> None:
    _bundle_cache.clear()
    component_i18n.invalidate_cache()
    addon_i18n.invalidate_cache()
    invalidate_platform_cache()


def get_bundled_translations(
    lang: str,
    *,
    all_components: bool = True,
    all_addons: bool = True,
    force: bool = False,
) -> dict[str, Any]:
    """Deep-merge platform, component, and add-on translation trees."""
    language = normalize_lang(lang)
    cache_key = f"{language}:c={int(all_components)}:a={int(all_addons)}"
    if not force and cache_key in _bundle_cache:
        return _bundle_cache[cache_key]

    merged: dict[str, Any] = {}
    deep_merge(merged, get_platform_translations(language, force=force))

    domains = (
        component_i18n.discovered_domains()
        if all_components
        else component_i18n.configured_domains()
    )
    deep_merge(merged, component_i18n.get_component_translations(language, domains=domains, force=force))

    slugs = (
        addon_i18n.discovered_addon_slugs()
        if all_addons
        else addon_i18n.installed_addon_slugs()
    )
    deep_merge(merged, addon_i18n.get_addon_translations(language, slugs=slugs, force=force))

    _bundle_cache[cache_key] = merged
    return merged
