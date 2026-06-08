"""Backend UI strings — loaded from locales/{lang}.json (parallel to static/js/lang)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_LOCALES_DIR = Path(__file__).resolve().parent.parent / "locales"
_cache: dict[str, dict[str, Any]] = {}


def ui_lang_code() -> str:
    import settings as settings_mod

    lang = ((settings_mod.CFG or {}).get("ui") or {}).get("language", "en")
    return "ro" if str(lang).strip().lower() == "ro" else "en"


def _load(lang: str) -> dict[str, Any]:
    code = "ro" if str(lang).strip().lower() == "ro" else "en"
    if code not in _cache:
        path = _LOCALES_DIR / f"{code}.json"
        with open(path, encoding="utf-8") as fh:
            _cache[code] = json.load(fh)
    return _cache[code]


def get(key: str, lang: str | None = None) -> Any:
    """Resolve a dot-path key, e.g. brain.language_name."""
    node: Any = _load(lang or ui_lang_code())
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(key)
        node = node[part]
    return node


def t(key: str, lang: str | None = None, **kwargs: Any) -> str:
    """Translate a string key; format with kwargs when provided."""
    value = get(key, lang=lang)
    if not isinstance(value, str):
        raise KeyError(key)
    if kwargs:
        return value.format(**kwargs)
    return value


def invalidate_cache() -> None:
    _cache.clear()
