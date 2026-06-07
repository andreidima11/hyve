"""Load and cache per-component translation JSON files."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from integrations.component_paths import component_search_paths
from integrations.config_entries import list_entries
from integrations.manifest import load_manifest

log = logging.getLogger("integrations.component_i18n")

_SUPPORTED_LANGS = ("en", "ro")
_cache: dict[str, dict[str, Any]] = {}


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    for key, value in overlay.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _configured_domains() -> set[str]:
    return {str(entry.get("slug") or "").strip() for entry in list_entries() if entry.get("slug")}


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


def _load_translation_file(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Invalid component translation %s: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def _namespace_component(domain: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"components": {domain: payload}}


def warm_cache(*, domains: set[str] | None = None) -> None:
    """Preload translations for configured integration domains."""
    target_domains = domains if domains is not None else _configured_domains()
    for lang in _SUPPORTED_LANGS:
        get_component_translations(lang, domains=target_domains, force=True)


def get_component_translations(
    lang: str,
    *,
    domains: set[str] | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Return merged namespaced translations for configured components."""
    language = str(lang or "en").strip().lower()
    if language not in _SUPPORTED_LANGS:
        language = "en"

    target_domains = domains if domains is not None else _configured_domains()
    cache_key = f"{language}:{','.join(sorted(target_domains))}"
    if not force and cache_key in _cache:
        return _cache[cache_key]

    merged: dict[str, Any] = {}
    for domain in sorted(target_domains):
        component_dir = _component_dir_for_domain(domain)
        if component_dir is None:
            continue
        trans_path = component_dir / "translations" / f"{language}.json"
        payload = _load_translation_file(trans_path)
        if payload is None and language != "en":
            payload = _load_translation_file(component_dir / "translations" / "en.json")
        if payload is None:
            continue
        _deep_merge(merged, _namespace_component(domain, payload))

    _cache[cache_key] = merged
    return merged


def invalidate_cache() -> None:
    _cache.clear()
