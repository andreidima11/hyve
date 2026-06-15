"""Load and cache per-component translation JSON files."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from core.i18n.util import deep_merge, load_translation_file, normalize_lang
from integrations.component_loader import discover_component_classes
from integrations.component_paths import component_search_paths
from integrations.config_entries import list_entries
from integrations.manifest import load_manifest

log = logging.getLogger("integrations.component_i18n")

_cache: dict[str, dict[str, Any]] = {}


def configured_domains() -> set[str]:
    return {str(entry.get("slug") or "").strip() for entry in list_entries() if entry.get("slug")}


def discovered_domains() -> set[str]:
    try:
        return set(discover_component_classes().keys())
    except Exception as exc:
        log.debug("discover_component_classes failed: %s", exc)
        return configured_domains()


def _component_dir_for_domain(domain: str) -> Path | None:
    key = str(domain or "").strip()
    if not key:
        return None
    found: Path | None = None
    for _origin, root in component_search_paths():
        candidate = root / key
        if candidate.is_dir() and load_manifest(candidate) is not None:
            found = candidate
    return found


def _namespace_component(domain: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"components": {domain: payload}}


def warm_cache(*, domains: set[str] | None = None) -> None:
    """Preload translations for integration domains."""
    target_domains = domains if domains is not None else discovered_domains()
    for lang in ("en", "ro"):
        get_component_translations(lang, domains=target_domains, force=True)


def get_component_translations(
    lang: str,
    *,
    domains: set[str] | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Return merged namespaced translations for components."""
    language = normalize_lang(lang)
    target_domains = domains if domains is not None else configured_domains()
    cache_key = f"{language}:{','.join(sorted(target_domains))}"
    if not force and cache_key in _cache:
        return _cache[cache_key]

    merged: dict[str, Any] = {}
    for domain in sorted(target_domains):
        component_dir = _component_dir_for_domain(domain)
        if component_dir is None:
            continue
        trans_path = component_dir / "translations" / f"{language}.json"
        payload = load_translation_file(trans_path)
        if payload is None and language != "en":
            payload = load_translation_file(component_dir / "translations" / "en.json")
        if payload is None:
            continue
        deep_merge(merged, _namespace_component(domain, payload))

    _cache[cache_key] = merged
    return merged


def invalidate_cache() -> None:
    _cache.clear()
