"""Shared helpers for JSON translation bundles."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("core.i18n")

SUPPORTED_LANGS = ("en", "ro")


def normalize_lang(lang: str) -> str:
    language = str(lang or "en").strip().lower()
    return language if language in SUPPORTED_LANGS else "en"


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    for key, value in overlay.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def load_translation_file(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Invalid translation file %s: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def load_translations_dir(
    base_dir: Path,
    lang: str,
    *,
    namespace: str | None = None,
) -> dict[str, Any]:
    """Load ``base_dir/translations/{lang}.json`` with optional root namespace."""
    language = normalize_lang(lang)
    payload = load_translation_file(base_dir / "translations" / f"{language}.json")
    if payload is None and language != "en":
        payload = load_translation_file(base_dir / "translations" / "en.json")
    if not payload:
        return {}
    if namespace:
        return {namespace: payload}
    return dict(payload)
