"""GitHub release metadata for add-on update UI and version resolution."""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.parse
import urllib.request
from typing import Any

from addons.version_utils import (
    is_channel_tag,
    normalize_version_string,
    plausible_version_string,
)
from core.github_api import github_api_headers

log = logging.getLogger("addons.github")


def github_repo(manifest: dict[str, Any]) -> str:
    install = manifest.get("install") or {}
    repo = str(install.get("version_github") or install.get("github_repo") or "").strip()
    if repo:
        return repo.strip("/")
    for raw in (manifest.get("url"), install.get("url")):
        url = str(raw or "").strip()
        match = re.match(r"https?://github\.com/([^/#?]+/[^/#?]+)", url, re.I)
        if match:
            return match.group(1).strip("/")
    return ""


def github_tag_candidates(tag: str) -> list[str]:
    """Try common GitHub release tag spellings (1.2.3 vs v1.2.3)."""
    raw = str(tag or "").strip()
    if not raw:
        return []
    out: list[str] = []
    for candidate in (raw, normalize_version_string(raw)):
        if candidate and candidate not in out:
            out.append(candidate)
    base = out[0] if out else raw
    if base and not base.lower().startswith("v"):
        prefixed = f"v{base}"
        if prefixed not in out:
            out.append(prefixed)
    return out


def _github_release_info_request(repo: str, tag: str | None) -> dict[str, str] | None:
    repo = str(repo or "").strip().strip("/")
    if not repo or "/" not in repo:
        return None
    if tag:
        safe_tag = urllib.parse.quote(str(tag).strip(), safe="")
        url = f"https://api.github.com/repos/{repo}/releases/tags/{safe_tag}"
    else:
        url = f"https://api.github.com/repos/{repo}/releases/latest"
    req = urllib.request.Request(url, headers=github_api_headers())
    with urllib.request.urlopen(req, timeout=12) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    tag_name = str(data.get("tag_name") or data.get("name") or "").strip()
    return {
        "version": normalize_version_string(tag_name) or tag_name,
        "body": str(data.get("body") or "").strip(),
        "url": str(data.get("html_url") or "").strip(),
    }


_release_info_cache: dict[str, tuple[float, dict[str, str]]] = {}
_RELEASE_INFO_TTL = 3600.0


def github_release_info(repo: str, tag: str | None = None) -> dict[str, str] | None:
    """Fetch {version, body, url} from GitHub releases (cached)."""
    repo = str(repo or "").strip().strip("/")
    if not repo or "/" not in repo:
        return None
    cache_key = f"{repo}:{tag or 'latest'}"
    now = time.monotonic()
    cached = _release_info_cache.get(cache_key)
    if cached and now - cached[0] < _RELEASE_INFO_TTL:
        return cached[1]

    try:
        if tag:
            result = None
            for candidate in github_tag_candidates(tag):
                try:
                    result = _github_release_info_request(repo, candidate)
                    if result:
                        break
                except Exception:
                    continue
            if not result:
                return github_release_info(repo, None)
        else:
            result = _github_release_info_request(repo, None)
        if result is not None:
            _release_info_cache[cache_key] = (now, result)
        return result
    except Exception as exc:
        log.debug("github release info failed for %s (%s): %s", repo, tag, exc)
        if tag:
            return github_release_info(repo, None)
        return None


def addon_release_notes(manifest: dict[str, Any], version: str | None = None) -> dict[str, str]:
    """Best-effort release notes for update UI (GitHub releases or project URL)."""
    install = manifest.get("install") or {}
    ver = str(version or manifest.get("version") or "").strip()
    repo = github_repo(manifest)
    info: dict[str, str] | None = None
    if repo:
        if ver and not is_channel_tag(ver):
            info = github_release_info(repo, ver)
        if not info or not info.get("body"):
            latest_info = github_release_info(repo, None)
            if latest_info:
                info = latest_info if not info else {
                    **info,
                    "body": info.get("body") or latest_info.get("body") or "",
                    "url": info.get("url") or latest_info.get("url") or "",
                }
    project_url = str(manifest.get("url") or install.get("url") or "").strip()
    if info:
        return {
            "version": info.get("version") or ver,
            "body": info.get("body") or "",
            "url": info.get("url") or project_url,
        }
    return {"version": ver, "body": "", "url": project_url}


def github_latest_version(repo: str) -> str | None:
    info = github_release_info(repo, None)
    if not info:
        return None
    normalized = plausible_version_string(normalize_version_string(info.get("version") or ""))
    return normalized or None
