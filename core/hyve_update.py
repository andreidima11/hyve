"""Hyve self-update: GitHub Releases check + git checkout of release tags."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import core.settings as settings

log = logging.getLogger(__name__)

DEFAULT_GITHUB_REPO = "andreidima11/hyve"
_PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Local rebuild outputs — do not block in-app update when only these differ.
_DIRTY_IGNORE_PATHS = (
    "static/css/tailwind.built.css",
    "package-lock.json",
)

_FRONTEND_DIST_APP = _PROJECT_ROOT / "static" / "dist" / "app.js"
_FRONTEND_BUILD_COMMANDS = "npm ci && npm run js:build"

_last_hyve_check: dict[str, Any] = {
    "latest": None,
    "tag": None,
    "release_url": None,
    "release_notes": "",
    "checked_at": None,
    "error": None,
}


def _persist_hyve_check() -> None:
    try:
        settings.save_config({"updates": {"hyve_check": dict(_last_hyve_check)}})
    except Exception as exc:
        log.debug("persist hyve check failed: %s", exc)


def _hydrate_hyve_check() -> None:
    global _last_hyve_check
    try:
        stored = (settings.CFG.get("updates") or {}).get("hyve_check")
        if isinstance(stored, dict) and stored.get("checked_at"):
            _last_hyve_check.update(stored)
    except Exception:
        pass


_hydrate_hyve_check()


class HyveUpdateError(Exception):
    def __init__(self, key: str, params: dict[str, Any] | None = None):
        self.key = key
        self.params = params or {}
        super().__init__(key)


def project_root() -> Path:
    return _PROJECT_ROOT


def github_repo() -> str:
    cfg = (settings.CFG.get("updates") or {}).get("hyve") or {}
    repo = str(cfg.get("github_repo") or DEFAULT_GITHUB_REPO).strip().strip("/")
    return repo or DEFAULT_GITHUB_REPO


def github_token() -> str:
    from core.github_api import github_token as _token

    return _token()


def current_version() -> str:
    return str(settings.RELEASE_VERSION)


def _normalize_tag(tag: str) -> str:
    raw = str(tag or "").strip()
    if raw.lower().startswith("v") and len(raw) > 1 and (raw[1].isdigit() or raw[1] == "."):
        return raw[1:]
    return raw


def _parse_version(version: str) -> tuple[int, ...]:
    raw = _normalize_tag(version)
    parts: list[int] = []
    for piece in re.split(r"[.-]", raw):
        if piece.isdigit():
            parts.append(int(piece))
        else:
            break
    return tuple(parts) if parts else (0,)


def is_newer(latest: str, current: str) -> bool:
    return _parse_version(latest) > _parse_version(current)


def _github_request(url: str) -> dict[str, Any]:
    from core.github_api import github_api_headers

    req = Request(url, headers=github_api_headers())
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def fetch_latest_release(repo: str | None = None) -> dict[str, Any]:
    repo_name = str(repo or github_repo()).strip()
    url = f"https://api.github.com/repos/{repo_name}/releases/latest"
    data = _github_request(url)
    tag = str(data.get("tag_name") or data.get("name") or "").strip()
    version = _normalize_tag(tag)
    if not version:
        raise HyveUpdateError("updates.hyve_release_invalid")
    return {
        "tag": tag,
        "version": version,
        "html_url": str(data.get("html_url") or ""),
        "body": str(data.get("body") or "").strip(),
        "published_at": str(data.get("published_at") or ""),
    }


def is_git_install() -> bool:
    return (_PROJECT_ROOT / ".git").is_dir() and shutil.which("git") is not None


def check_for_update() -> dict[str, Any]:
    global _last_hyve_check
    cur = current_version()
    try:
        release = _fetch_latest_release_with_fallback()
        latest = str(release["version"])
        _last_hyve_check = {
            "latest": latest,
            "tag": release["tag"],
            "release_url": release.get("html_url") or "",
            "release_notes": release.get("body") or "",
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "error": None,
            "source": release.get("source") or "github",
        }
    except HTTPError as exc:
        code = getattr(exc, "code", 0) or 0
        key = "updates.hyve_release_not_found" if code == 404 else "updates.hyve_check_failed"
        _last_hyve_check = _failed_check_state(cur, key, {"status": code})
    except (URLError, TimeoutError, json.JSONDecodeError, HyveUpdateError) as exc:
        key = getattr(exc, "key", "updates.hyve_check_failed")
        _last_hyve_check = _failed_check_state(cur, key)
    _persist_hyve_check()
    return get_status()


def _failed_check_state(cur: str, key: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "latest": cur,
        "tag": cur,
        "release_url": "",
        "release_notes": "",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "error": {"key": key, **({"params": params} if params else {})},
        "source": None,
    }


def _fetch_latest_release_with_fallback() -> dict[str, Any]:
    return _resolve_latest_release()


def _release_from_github() -> dict[str, Any] | None:
    try:
        release = fetch_latest_release()
        release["source"] = "github"
        return release
    except HTTPError:
        return None


def _release_from_git_tag(tag: str) -> dict[str, Any]:
    version = _normalize_tag(tag)
    return {
        "tag": tag,
        "version": version,
        "html_url": "",
        "body": "",
        "source": "git",
    }


def _resolve_latest_release() -> dict[str, Any]:
    """Pick the newest semver from GitHub latest and remote git tags."""
    candidates: list[dict[str, Any]] = []
    github = _release_from_github()
    if github:
        candidates.append(github)
    git_tag = _git_remote_latest_tag()
    if git_tag:
        candidates.append(_release_from_git_tag(git_tag))
    if not candidates:
        raise HyveUpdateError("updates.hyve_check_failed")
    best = max(candidates, key=lambda row: _parse_version(str(row.get("version") or "")))
    if github and not str(best.get("body") or "").strip():
        best = {
            **best,
            "body": github.get("body") or "",
            "html_url": str(best.get("html_url") or "").strip() or str(github.get("html_url") or ""),
        }
    return best


def _enrich_release_notes_from_github(version: str) -> dict[str, str]:
    """Best-effort release notes when the last check did not persist GitHub body."""
    repo = github_repo()
    ver = str(version or "").strip()
    try:
        from addons.github_releases import github_release_info as _github_release_info

        info = None
        if ver:
            info = _github_release_info(repo, ver)
        if not info or not str(info.get("body") or "").strip():
            latest = _github_release_info(repo, None)
            if latest:
                if info:
                    info = {
                        **info,
                        "body": info.get("body") or latest.get("body") or "",
                        "url": info.get("url") or latest.get("url") or "",
                    }
                else:
                    info = latest
        if info:
            return {
                "body": str(info.get("body") or "").strip(),
                "url": str(info.get("url") or "").strip(),
            }
    except Exception as exc:
        log.debug("enrich hyve release notes failed: %s", exc)
    tag = str(_last_hyve_check.get("tag") or ver or "").strip()
    if tag:
        return {"body": "", "url": f"https://github.com/{repo}/releases/tag/{tag}"}
    return {"body": "", "url": f"https://github.com/{repo}/releases"}


def _dirty_path_from_porcelain(line: str) -> str:
    raw = (line or "").strip()
    if len(raw) >= 4 and raw[2] == " ":
        return raw[3:].strip()
    if len(raw) >= 3 and raw[2] != " ":
        return raw[2:].strip()
    return raw


def _is_ignored_dirty_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    if normalized in _DIRTY_IGNORE_PATHS:
        return True
    if normalized.startswith("static/dist/"):
        return True
    if normalized.startswith("static/js/") and normalized.endswith(".js"):
        return True
    return False


def _blocking_dirty_lines(porcelain: str) -> list[str]:
    blocking: list[str] = []
    for line in (porcelain or "").splitlines():
        if not line.strip():
            continue
        path = _dirty_path_from_porcelain(line)
        if _is_ignored_dirty_path(path):
            continue
        blocking.append(line)
    return blocking


def _git_remote_latest_tag() -> str | None:
    if not is_git_install():
        return None
    proc = _run_cmd(
        ["git", "ls-remote", "--tags", "origin"],
        extra_git_config=_git_extra_config(),
        check=False,
    )
    if proc.returncode != 0:
        return None
    tags: list[str] = []
    for line in (proc.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        ref = parts[1].strip()
        if not ref.startswith("refs/tags/"):
            continue
        tag = ref.removeprefix("refs/tags/").removesuffix("^{}")
        if tag and _parse_version(tag) != (0,):
            tags.append(tag)
    if not tags:
        return None
    return max(tags, key=lambda t: _parse_version(_normalize_tag(t)))


def get_status() -> dict[str, Any]:
    cur = current_version()
    err = _last_hyve_check.get("error")
    latest = str(_last_hyve_check.get("latest") or cur)
    update_available = not err and bool(latest and is_newer(latest, cur))
    release_notes = str(_last_hyve_check.get("release_notes") or "")
    release_url = str(_last_hyve_check.get("release_url") or "")
    if not release_notes.strip() or not release_url.strip():
        enriched = _enrich_release_notes_from_github(latest)
        if not release_notes.strip():
            release_notes = enriched.get("body") or release_notes
        if not release_url.strip():
            release_url = enriched.get("url") or release_url
    return {
        "current": cur,
        "latest": latest,
        "tag": _last_hyve_check.get("tag") or latest,
        "update_available": update_available,
        "release_url": release_url,
        "release_notes": release_notes,
        "checked_at": _last_hyve_check.get("checked_at"),
        "error": err,
        "source": _last_hyve_check.get("source"),
        "git_available": is_git_install(),
        "github_repo": github_repo(),
        "github_token_configured": bool(github_token()),
        "prerequisites": {
            "npm_available": _npm_available(),
            "frontend_dist_ready": _frontend_dist_ready(),
            "frontend_build_required": _frontend_build_required(),
            "frontend_build_commands": _FRONTEND_BUILD_COMMANDS,
        },
    }


def _run_cmd(
    args: list[str],
    *,
    cwd: Path | None = None,
    extra_git_config: list[str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    cmd = list(args)
    if extra_git_config and args and args[0] == "git":
        injected: list[str] = ["git"]
        for item in extra_git_config:
            injected.extend(["-c", item])
        injected.extend(args[1:])
        cmd = injected
    proc = subprocess.run(
        cmd,
        cwd=str(cwd or _PROJECT_ROOT),
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:400]
        raise HyveUpdateError("updates.hyve_git_failed", {"detail": detail})
    return proc


def _git_extra_config() -> list[str]:
    token = github_token()
    if not token:
        return []
    return [f"http.extraHeader=Authorization: Bearer {token}"]


def _assert_git_ready() -> None:
    if not is_git_install():
        raise HyveUpdateError("updates.hyve_not_git")
    status = _run_cmd(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        check=True,
    )
    blocking = _blocking_dirty_lines(status.stdout)
    if blocking:
        detail = "\n".join(_dirty_path_from_porcelain(line) for line in blocking[:8])
        raise HyveUpdateError("updates.hyve_dirty_tree", {"detail": detail})


def _fetch_tags() -> None:
    _run_cmd(
        ["git", "fetch", "origin", "--tags", "--force"],
        extra_git_config=_git_extra_config(),
    )


def _checkout_tag(tag: str) -> None:
    raw = str(tag or "").strip()
    if not raw:
        raise HyveUpdateError("updates.hyve_release_invalid")
    candidates = [raw, _normalize_tag(raw)]
    if not raw.startswith("v"):
        candidates.append(f"v{raw}")
    candidates.append(f"tags/{raw}")
    seen: set[str] = set()
    last_error = ""
    for ref in candidates:
        if ref in seen:
            continue
        seen.add(ref)
        proc = subprocess.run(
            ["git", "checkout", "--force", ref],
            cwd=str(_PROJECT_ROOT),
            capture_output=True,
            text=True,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        if proc.returncode == 0:
            return
        last_error = (proc.stderr or proc.stdout or "").strip()
    raise HyveUpdateError("updates.hyve_checkout_failed", {"detail": last_error[:400]})


def _pip_install() -> None:
    pip = _PROJECT_ROOT / ".venv" / "bin" / "pip"
    if not pip.is_file():
        pip = _PROJECT_ROOT / "venv" / "bin" / "pip"
    if not pip.is_file():
        pip_path = shutil.which("pip3") or shutil.which("pip")
        if not pip_path:
            raise HyveUpdateError("updates.hyve_pip_missing")
        pip = Path(pip_path)
    req = _PROJECT_ROOT / "requirements.txt"
    if not req.is_file():
        return
    _run_cmd([str(pip), "install", "-r", str(req)], cwd=_PROJECT_ROOT)


def _npm_path() -> str | None:
    npm = shutil.which("npm")
    if npm:
        return npm
    for candidate in (
        "/usr/local/bin/npm",
        "/usr/bin/npm",
        "/opt/homebrew/bin/npm",
    ):
        if Path(candidate).is_file():
            return candidate
    return None


def _npm_available() -> bool:
    return _npm_path() is not None


def _frontend_dist_ready() -> bool:
    return _FRONTEND_DIST_APP.is_file()


def _frontend_build_required() -> bool:
    pkg = _PROJECT_ROOT / "package.json"
    if not pkg.is_file():
        return False
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        scripts = data.get("scripts") or {}
        return "js:build" in scripts
    except Exception:
        return True


def _require_npm_for_frontend() -> str:
    npm = _npm_path()
    if not npm:
        raise HyveUpdateError(
            "updates.hyve_npm_required",
            {"commands": _FRONTEND_BUILD_COMMANDS},
        )
    return npm


def _git_head_ref() -> str:
    proc = _run_cmd(["git", "rev-parse", "HEAD"])
    return (proc.stdout or "").strip()


def _git_checkout_ref(ref: str) -> None:
    proc = subprocess.run(
        ["git", "checkout", "--force", ref],
        cwd=str(_PROJECT_ROOT),
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:400]
        raise HyveUpdateError("updates.hyve_checkout_failed", {"detail": detail})


def _js_build() -> None:
    """Build Vite bundles into ``static/dist/``. Raises ``HyveUpdateError`` on failure."""
    if not _frontend_build_required():
        return
    npm = _require_npm_for_frontend()
    try:
        if (_PROJECT_ROOT / "package-lock.json").is_file():
            _run_cmd([npm, "ci"], cwd=_PROJECT_ROOT)
        else:
            _run_cmd([npm, "install"], cwd=_PROJECT_ROOT)
        _run_cmd([npm, "run", "js:build"], cwd=_PROJECT_ROOT)
    except HyveUpdateError as exc:
        detail = str(exc.params.get("detail") or exc.key)
        raise HyveUpdateError(
            "updates.hyve_frontend_build_failed",
            {"detail": detail, "commands": _FRONTEND_BUILD_COMMANDS},
        ) from exc
    if not _frontend_dist_ready():
        raise HyveUpdateError(
            "updates.hyve_frontend_build_failed",
            {
                "detail": "static/dist/app.js missing after build",
                "commands": _FRONTEND_BUILD_COMMANDS,
            },
        )


def apply_update() -> dict[str, Any]:
    check_for_update()
    status = get_status()
    if not status.get("update_available"):
        raise HyveUpdateError("updates.hyve_already_latest")
    tag = str(_last_hyve_check.get("tag") or status.get("latest") or "").strip()
    if not tag:
        raise HyveUpdateError("updates.hyve_release_invalid")

    _assert_git_ready()
    _fetch_tags()

    if _frontend_build_required():
        _require_npm_for_frontend()

    head_before = _git_head_ref()
    try:
        _checkout_tag(tag)
        _pip_install()
        _js_build()
    except HyveUpdateError:
        log.warning("Hyve update failed after checkout — rolling back to %s", head_before)
        try:
            _git_checkout_ref(head_before)
        except HyveUpdateError:
            log.exception("rollback to %s failed", head_before)
        raise
    except Exception as exc:
        log.exception("Hyve update failed after checkout — rolling back to %s", head_before)
        try:
            _git_checkout_ref(head_before)
        except HyveUpdateError:
            log.exception("rollback to %s failed", head_before)
        raise HyveUpdateError("updates.hyve_apply_failed", {"detail": str(exc)}) from exc

    from core.server_restart import schedule_restart

    target = _normalize_tag(tag)
    schedule_restart(delay=1.0, log_msg=f"Hyve updated to {target} — restarting...")
    return {
        "status": "restarting",
        "version": target,
        "message_key": "updates.hyve_updated_restarting",
        "message_params": {"version": target},
    }
