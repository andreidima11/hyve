"""Shared GitHub REST API helpers (releases, tags)."""

from __future__ import annotations

import os


def github_token() -> str:
    for name in ("HYVE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
        val = str(os.environ.get(name) or "").strip()
        if val:
            return val
    return ""


def github_api_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "Hyve",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = github_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers
