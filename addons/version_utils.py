"""Version string normalization for add-on catalog and GitHub releases."""

from __future__ import annotations

import re

_CHANNEL_TAGS = frozenset({
    "stable", "latest", "main", "master", "dev", "edge", "nightly", "beta", "rc",
})


def is_channel_tag(version: str) -> bool:
    return str(version or "").strip().lower() in _CHANNEL_TAGS


def normalize_version_string(version: str) -> str:
    raw = str(version or "").strip()
    if not raw:
        return ""
    if raw.lower().startswith("v") and len(raw) > 1 and (raw[1].isdigit() or raw[1] == "."):
        return raw[1:]
    return raw


def plausible_version_string(version: str | None) -> str | None:
    raw = normalize_version_string(str(version or ""))
    if not raw or len(raw) > 64:
        return None
    upper = raw.upper()
    if "<" in raw or ">" in raw or "DOCTYPE" in upper or "HTML" in upper:
        return None
    if not re.match(r"^[\d][\d.A-Za-z_-]*$", raw):
        return None
    return raw
