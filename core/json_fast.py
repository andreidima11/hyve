"""Fast JSON serialization helper.

Uses orjson when available (2-3x faster than stdlib json on dict serialization,
and writes UTF-8 natively without ensure_ascii overhead). Falls back to stdlib
json otherwise. Provides a single :func:`jdumps` returning a ``str`` so it can
be embedded directly in SSE / WebSocket text frames.
"""
from __future__ import annotations

import json as _stdlib_json

try:  # pragma: no cover - import path differs only by availability
    import orjson as _orjson

    _OPT = _orjson.OPT_NON_STR_KEYS

    def jdumps(obj) -> str:
        try:
            return _orjson.dumps(obj, option=_OPT).decode("utf-8")
        except TypeError:
            # orjson rejects some types (e.g. custom objects); fall back.
            return _stdlib_json.dumps(obj, ensure_ascii=False, default=str)
except Exception:  # pragma: no cover - orjson not installed
    def jdumps(obj) -> str:
        return _stdlib_json.dumps(obj, ensure_ascii=False, default=str)


__all__ = ["jdumps"]
