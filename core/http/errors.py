"""Structured API error payloads for i18n on the frontend."""

from __future__ import annotations

from typing import Any


def error_detail(key: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"key": key}
    if params:
        payload["params"] = params
    return payload
