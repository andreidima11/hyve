"""Installed/latest version resolution for add-ons."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from addons.discovery import get_manifest
from addons.github_releases import (
    addon_release_notes,
    github_latest_version as _github_latest_version,
    github_release_info as _github_release_info,
    github_repo as _github_repo,
    github_tag_candidates as _github_tag_candidates,
)
from addons.state_store import get_state
from addons.version_utils import (
    is_channel_tag as _is_channel_tag,
    normalize_version_string as _normalize_version_string,
    plausible_version_string as _plausible_version_string,
)

log = logging.getLogger("addons.versions")


def _project_root() -> Path:
    from addons import registry
    return registry._PROJECT_ROOT

def version_is_newer(latest: str, current: str) -> bool:
    """Return True if ``latest`` is a newer version than ``current``.

    Handles arbitrary version strings (``2024.11.0``, ``2.0``, ``stable``,
    ``latest``). Numeric dotted parts compare semantically; non-numeric parts
    compare lexicographically. Equal strings → no update. Generic for every
    add-on — nothing is hardcoded per add-on.
    """
    latest = str(latest or "").strip()
    current = str(current or "").strip()
    if not latest or not current or latest == current:
        return False

    def _tokens(v: str):
        out = []
        for part in re.split(r"[.\-_+]", v):
            out.append((1, int(part)) if part.isdigit() else (0, 0, part))
        return out

    lt, ct = _tokens(latest), _tokens(current)
    for i in range(max(len(lt), len(ct))):
        a = lt[i] if i < len(lt) else (1, -1)
        b = ct[i] if i < len(ct) else (1, -1)
        if a != b:
            try:
                return a > b
            except TypeError:
                # Mixed numeric/string token → fall back to string inequality.
                return latest != current
    # Tokens identical but raw strings differ (rare) → treat as update.
    return latest != current


def is_update_available(manifest: dict, state: dict) -> bool:
    """Whether an installed add-on has a newer version available.

    Prefers the live ``latest_version`` cached on the state (resolved from the
    package registry during a check); falls back to the bundled manifest
    version for add-ons we can't query live. Fully generic — works for any
    add-on, including ones added in the future.
    """
    state = state or {}
    if not state.get("installed"):
        return False
    current = state.get("version") or ""
    latest = state.get("latest_version")
    if latest:
        return version_is_newer(latest, current)
    return version_is_newer((manifest or {}).get("version") or "", current)

def _strip_pkg_version(spec: str, npm: bool = False) -> str:
    """Extract the bare package name from a dependency spec."""
    spec = (spec or "").strip()
    if not spec:
        return ""
    if npm:
        if spec.startswith("@"):
            # Scoped package: @scope/name@version
            idx = spec.find("@", 1)
            return spec[:idx] if idx != -1 else spec
        return spec.split("@", 1)[0]
    # pip: name[extras]<op>version
    return re.split(r"[<>=!~\[ ]", spec, 1)[0].strip()


def _npm_prefix_dir(manifest: dict) -> Path | None:
    args = (manifest.get("install", {}) or {}).get("args", []) or []
    for i, a in enumerate(args):
        if a == "--prefix" and i + 1 < len(args):
            p = Path(args[i + 1])
            return p if p.is_absolute() else (_project_root() / p)
    return None


def _run_capture(cmd: list[str], timeout: float = 30) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception as e:
        log.debug("version cmd failed %s: %s", cmd, e)
    return None


def _run_capture_text(cmd: list[str], timeout: float = 15) -> str | None:
    """Like ``_run_capture`` but also accepts stderr (e.g. ``mosquitto -h``)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout or "").strip()
        err = (r.stderr or "").strip()
        return out or err or None
    except Exception as e:
        log.debug("cmd failed %s: %s", cmd, e)
    return None


def _brew_binary_path(pkg: str) -> str | None:
    from addons import registry

    candidates = [
        registry.shutil.which(pkg),
        os.path.join("/opt/homebrew/sbin", pkg),
        os.path.join("/opt/homebrew/bin", pkg),
        os.path.join("/usr/local/sbin", pkg),
        os.path.join("/usr/local/bin", pkg),
        os.path.join("/usr/sbin", pkg),
        os.path.join("/usr/bin", pkg),
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def _brew_binary_present(pkg: str) -> bool:
    return _brew_binary_path(pkg) is not None


def _brew_binary_version(pkg: str) -> str | None:
    cmd = _brew_binary_path(pkg)
    if not cmd:
        return None
    for args in ([cmd, "-h"], [cmd, "--version"], [cmd, "version"]):
        out = _run_capture_text(args, timeout=10)
        if not out:
            continue
        match = re.search(r"(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)", out)
        if match:
            normalized = _normalize_version_string(match.group(1))
            if normalized:
                return normalized
    return None


def _brew_installed_version(pkg: str) -> str | None:
    pkg = str(pkg or "").strip()
    if not pkg:
        return None
    if shutil.which("brew"):
        out = _run_capture(["brew", "list", "--versions", pkg], timeout=20)
        if out:
            for line in out.splitlines():
                parts = line.strip().split()
                if len(parts) >= 2 and parts[0] == pkg:
                    return _normalize_version_string(parts[-1]) or parts[-1]
    return _brew_binary_version(pkg)


from addons.github_releases import (
    addon_release_notes,
    github_latest_version as _github_latest_version,
    github_release_info as _github_release_info,
    github_repo as _github_repo,
    github_tag_candidates as _github_tag_candidates,
)
from addons.version_utils import (
    is_channel_tag as _is_channel_tag,
    normalize_version_string as _normalize_version_string,
    plausible_version_string as _plausible_version_string,
)


def _docker_image(manifest: dict) -> str:
    return str((manifest.get("install") or {}).get("image") or "").strip()


def _docker_image_exists(image: str) -> bool:
    if not image or not shutil.which("docker"):
        return False
    try:
        r = subprocess.run(
            ["docker", "image", "inspect", image],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return r.returncode == 0
    except Exception as e:
        log.debug("docker image inspect failed for %s: %s", image, e)
        return False


def _docker_daemon_reachable() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        r = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        return r.returncode == 0
    except Exception as e:
        log.debug("docker info failed: %s", e)
        return False


def _resolve_channel_version(manifest: dict, ref: str) -> str:
    """Map Docker channel tags (latest/stable/…) to a concrete version when possible."""
    from addons import registry

    raw = str(ref or "").strip()
    if raw and not _is_channel_tag(raw):
        return raw
    latest = registry._github_latest_version(registry._github_repo(manifest))
    if latest:
        return latest
    return raw or str(manifest.get("version") or "").strip() or "?"


def _docker_installed_version(image: str) -> str | None:
    from addons import registry

    if not image or not registry._docker_image_exists(image):
        return None
    fmt = '{{index .Config.Labels "org.opencontainers.image.version"}}'
    label = registry._run_capture(["docker", "image", "inspect", image, "--format", fmt], timeout=15)
    if label and label not in ("<no value>", ""):
        normalized = _normalize_version_string(label)
        if normalized and not _is_channel_tag(normalized):
            return normalized
    if ":" in image:
        tag = image.rsplit(":", 1)[-1].strip()
        if tag:
            normalized = _normalize_version_string(tag)
            return normalized or tag
    return "installed"


def _http_runtime_version(manifest: dict, state: dict) -> str | None:
    hc = manifest.get("health_check") or {}
    if hc.get("type") != "http" or not hc.get("path"):
        return None
    cfg = state.get("config") or {}
    host = hc.get("host") or cfg.get(hc.get("host_key", "host"), "localhost")
    port = int(cfg.get(hc.get("port_key", "port"), 0) or 0)
    if not port:
        return None
    import urllib.request
    url = f"http://{host}:{port}{hc.get('path')}"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            body = resp.read().decode("utf-8", "replace").strip()
        if body.startswith("{"):
            data = json.loads(body)
            ver = str(data.get("version") or data.get("tag") or "").strip()
        else:
            ver = ""
        normalized = _plausible_version_string(_normalize_version_string(ver))
        return normalized if normalized and not _is_channel_tag(normalized) else None
    except Exception as e:
        log.debug("runtime version probe failed for %s: %s", manifest.get("slug"), e)
        return None


def _resolve_display_version(manifest: dict, state: dict) -> str:
    """Best-effort semver for UI — never a Docker channel tag when avoidable."""
    from addons import registry

    manifest_ver = str(manifest.get("version") or "").strip()

    if state.get("installed"):
        saved = str(state.get("version") or "").strip()
        plausible_saved = _plausible_version_string(saved) if saved else None
        if plausible_saved and not _is_channel_tag(plausible_saved):
            return plausible_saved
        runtime = registry._http_runtime_version(manifest, state)
        if runtime:
            return runtime
        resolved = registry._resolve_installed_version(manifest)
        if resolved and not _is_channel_tag(resolved):
            return resolved
        channel_ref = resolved or saved or manifest_ver
        return registry._resolve_channel_version(manifest, channel_ref)

    install = manifest.get("install") or {}
    docker_tag: str | None = None
    if install.get("method") == "docker":
        docker_tag = registry._docker_installed_version(_docker_image(manifest))
        if docker_tag and not _is_channel_tag(docker_tag):
            return docker_tag

    return registry._resolve_channel_version(manifest, docker_tag or manifest_ver)


def addon_entry(manifest: dict, state: dict | None = None) -> dict:
    """Manifest + state enriched with a resolved catalog version for the UI."""
    state = state if state is not None else get_state(manifest["slug"])
    entry = {
        **manifest,
        "version": _resolve_display_version(manifest, state),
        "state": state,
        "update_available": is_update_available(manifest, state),
    }
    from addons import lifecycle as addon_lifecycle

    return addon_lifecycle.enrich_catalog_entry(entry, manifest)


def list_all() -> list[dict]:
    """Return manifests merged with installed state + an update-available flag."""
    from addons.discovery import list_available

    return [addon_entry(manifest) for manifest in list_available()]


def _pip_installed_version(pkg: str) -> str | None:
    out = _run_capture([sys.executable, "-m", "pip", "show", pkg], timeout=30)
    if not out:
        return None
    for line in out.splitlines():
        if line.lower().startswith("version:"):
            return line.split(":", 1)[1].strip()
    return None


def _pypi_latest_version(pkg: str) -> str | None:
    import urllib.request
    try:
        with urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/json", timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        return _plausible_version_string((data.get("info") or {}).get("version"))
    except Exception as e:
        log.debug("pypi latest failed for %s: %s", pkg, e)
        return None


def _npm_installed_version(pkg: str, prefix: Path | None) -> str | None:
    if prefix:
        pj = prefix / "node_modules" / pkg / "package.json"
        try:
            if pj.is_file():
                return json.loads(pj.read_text(encoding="utf-8")).get("version")
        except Exception:
            pass
    cmd = ["npm", "ls", pkg, "--depth=0", "--json"]
    if prefix:
        cmd += ["--prefix", str(prefix)]
    out = _run_capture(cmd, timeout=30)
    if out:
        try:
            data = json.loads(out)
            dep = (data.get("dependencies") or {}).get(pkg) or {}
            return dep.get("version") or None
        except Exception:
            pass
    return None


def _npm_latest_version(pkg: str) -> str | None:
    return _plausible_version_string(_run_capture(["npm", "view", pkg, "version"], timeout=30))


def _resolve_installed_version(manifest: dict) -> str | None:
    """Read the *actual* installed version (local, fast — no network)."""
    install = manifest.get("install", {}) or {}
    method = install.get("method", "pip")
    if method == "docker":
        return _docker_installed_version(_docker_image(manifest))
    packages = install.get("packages") or []
    if not packages:
        return None
    if method in ("pip", "wyoming"):
        return _pip_installed_version(_strip_pkg_version(packages[0]))
    if method == "npm":
        return _npm_installed_version(_strip_pkg_version(packages[0], npm=True), _npm_prefix_dir(manifest))
    if method == "brew":
        for pkg in packages:
            ver = _brew_installed_version(_strip_pkg_version(pkg))
            if ver:
                return ver
            if _brew_binary_present(_strip_pkg_version(pkg)):
                return str(manifest.get("version") or "installed")
    return None


def _resolve_latest_version(manifest: dict) -> str | None:
    """Query the package registry for the latest version (may hit the network)."""
    install = manifest.get("install", {}) or {}
    method = install.get("method", "pip")
    if method == "docker":
        return _github_latest_version(_github_repo(manifest))
    if method == "brew" and _github_repo(manifest):
        return _github_latest_version(_github_repo(manifest))
    packages = install.get("packages") or []
    if not packages:
        return None
    if method in ("pip", "wyoming"):
        return _pypi_latest_version(_strip_pkg_version(packages[0]))
    if method == "npm":
        return _npm_latest_version(_strip_pkg_version(packages[0], npm=True))
    return None


def refresh_addon_versions(slug: str) -> dict:
    """Resolve and persist the real installed + latest versions for an add-on.

    Used by the update-check flow. No-op for add-ons whose version cannot be
    resolved (docker / brew / binary, or missing tooling) — those keep the
    manifest-based comparison and never produce false positives.
    """
    manifest = get_manifest(slug)
    state = get_state(slug)
    if not manifest or not state.get("installed"):
        return state

    changed = False
    existing_version = state.get("version")
    if existing_version and not _plausible_version_string(str(existing_version)):
        state["version"] = None
        changed = True

    try:
        installed = _http_runtime_version(manifest, state) or _resolve_installed_version(manifest)
        installed = _plausible_version_string(str(installed or "")) if installed else None
        if installed and state.get("version") != installed:
            state["version"] = installed
            changed = True
    except Exception as e:
        log.debug("installed version resolve failed for %s: %s", slug, e)

    try:
        latest = _resolve_latest_version(manifest)
        if latest is not None and state.get("latest_version") != latest:
            state["latest_version"] = latest
            changed = True
        note_version = latest or state.get("version")
        if note_version is not None:
            notes = addon_release_notes(manifest, str(note_version))
            body = str(notes.get("body") or "").strip()
            url = str(notes.get("url") or "").strip()
            if body and state.get("release_notes") != body:
                state["release_notes"] = body
                changed = True
            if url and state.get("release_url") != url:
                state["release_url"] = url
                changed = True
    except Exception as e:
        log.debug("latest version resolve failed for %s: %s", slug, e)

    existing_latest = state.get("latest_version")
    if existing_latest and not _plausible_version_string(str(existing_latest)):
        state["latest_version"] = None
        changed = True

    if changed:
        _save_state(slug, state)
    return state



def _save_state(slug: str, state: dict) -> dict:
    from addons.state_store import save_state
    return save_state(slug, state)
