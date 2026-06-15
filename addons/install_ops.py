"""Add-on install, update, and uninstall operations."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

from addons import integration_sync
from addons.discovery import get_manifest
from addons.meta import HYVE_META_KEY, save_addon_state
from addons.reconcile import _install_requires_artifacts
from addons.state_store import get_state
from addons.versions import (
    _docker_daemon_reachable,
    _resolve_channel_version,
    _resolve_installed_version,
    _strip_pkg_version,
)

log = logging.getLogger("addons.install_ops")

def install_addon(slug: str) -> dict:
    """Install an addon (blocking, no log streaming). Returns updated state."""
    from addons import registry

    manifest = get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    registry._run_install_commands(manifest)
    return finalize_install(slug, manifest)


def update_addon(slug: str) -> dict:
    """Update an installed addon to the latest available version while preserving state."""
    from addons import registry

    manifest = get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    current = get_state(slug)
    if not current.get("installed"):
        raise ValueError(f"Addon {slug} is not installed")

    registry._run_install_commands(manifest)

    schema = manifest.get("config_schema", [])
    default_config = {field["key"]: field.get("default", "") for field in schema}
    merged_config = {**default_config, **(current.get("config") or {})}

    version = manifest.get("version", "1.0.0")
    try:
        resolved = registry._resolve_installed_version(manifest)
        if resolved:
            version = resolved
        version = registry._resolve_channel_version(manifest, str(version))
    except Exception:
        pass

    state = {
        "installed": True,
        "enabled": bool(current.get("enabled", False)),
        "version": version,
        "latest_version": version,  # freshly updated → clears the badge
        "config": merged_config,
        "watchdog": bool(current.get("watchdog", False)),
    }
    save_addon_state(slug, state)
    log.info("Addon %s updated successfully", slug)
    return state


async def install_addon_stream(slug: str):
    """Install an addon, yielding log lines as they arrive (async generator).

    Yields str lines.  Final line is either  __DONE__  or  __FAIL__:<msg>.
    """
    manifest = get_manifest(slug)
    if not manifest:
        yield "__FAIL__:Unknown addon: " + slug
        return

    install = manifest.get("install", {})
    method = install.get("method", "pip")
    cmds = build_install_cmds(method, install)

    # Auto-bootstrap missing prerequisites (e.g. Docker daemon for `docker`
    # method on macOS — we install Colima via brew so a single click works
    # without forcing the user to download Docker Desktop manually).
    bootstrap = bootstrap_cmds_for_method(method)

    if not cmds:
        if method == "binary":
            finalize_install(slug, manifest)
            yield "Add-on marcat ca instalat (binary — fără descărcare)."
            yield "__DONE__"
            return
        yield f"__FAIL__:Metoda de instalare {method!r} nu este configurată corect pentru add-on-ul {slug}."
        return

    try:
        if bootstrap:
            yield "── Pregătire prerechizite ──────────────────────\n"
        for cmd in bootstrap + cmds:
            yield f"$ {' '.join(cmd)}\n"
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(Path(__file__).resolve().parent.parent),
            )

            async for raw_line in proc.stdout:
                yield raw_line.decode("utf-8", errors="replace")

            await proc.wait()

            if proc.returncode != 0:
                yield f"\nProces terminat cu cod {proc.returncode}\n"
                yield f"__FAIL__:Install exited with code {proc.returncode}"
                return

        # Apply post-install patches
        patches = install.get("post_install_patches", [])
        if patches:
            yield "\n── Post-install patches ──────────────────────\n"
            for patch in patches:
                desc = patch.get("description", "patch")
                yield f"⚙ {desc}\n"
                ok, msg = apply_patch(patch)
                yield f"  {'✅' if ok else '❌'} {msg}\n"

        finalize_install(slug, manifest)
        yield "__DONE__"

    except Exception as e:
        yield f"\nEroare: {e}\n"
        yield f"__FAIL__:{e}"


# ── install helpers ──────────────────────────────────────────────────────

def _apt_install_cmd(packages: list[str]) -> list[str]:
    """Non-interactive apt install for Linux hosts without Homebrew."""
    pkgs = [str(p).strip() for p in packages if str(p).strip()]
    if not pkgs:
        return []
    joined = " ".join(pkgs)
    return [
        "bash",
        "-lc",
        "export DEBIAN_FRONTEND=noninteractive && "
        "apt-get update -qq && "
        f"apt-get install -y {joined}",
    ]


def build_install_cmds(method: str, install: dict) -> list[list[str]]:
    """Build one or more install commands, with requirements executed before main packages."""
    requirements = install.get("requirements", []) or []
    packages = install.get("packages", []) or []
    extra_args = install.get("args", []) or []
    cmds: list[list[str]] = []

    if method in ("pip", "wyoming"):
        if requirements:
            cmds.append([sys.executable, "-m", "pip", "install", "--upgrade"] + requirements)
        if packages:
            cmds.append([sys.executable, "-m", "pip", "install", "--upgrade"] + packages)
        return cmds

    if method == "docker":
        image = install.get("image", "")
        if image:
            # Use a login shell so we pick up brew-installed binaries even
            # when Hyve was started outside a terminal session.
            return [["bash", "-lc", f"docker pull {image}"]]
        return []

    if method == "brew":
        requirements = [_strip_pkg_version(p) for p in requirements]
        packages = [_strip_pkg_version(p) for p in packages]
        from addons import registry as _reg

        if _reg.sys.platform.startswith("linux") and shutil.which("apt-get"):
            apt_pkgs = [p for p in requirements + packages if p]
            if apt_pkgs:
                return [_apt_install_cmd(apt_pkgs)]
            return []
        if requirements:
            cmds.append(["brew", "install"] + requirements)
        if packages:
            cmds.append(["brew", "install"] + packages)
        return cmds

    if method == "npm":
        if requirements:
            cmds.append(["npm", "install"] + extra_args + requirements)
        if packages:
            cmds.append(["npm", "install"] + extra_args + packages)
        return cmds

    if method == "binary":
        return []

    return []


def bootstrap_cmds_for_method(method: str) -> list[list[str]]:
    """Return commands needed to make `method` usable, or [] if already ready."""
    from addons import registry as _reg

    if method != "docker":
        return []
    if _reg._docker_daemon_reachable():
        return []
    if _reg.sys.platform == "darwin":
        return _bootstrap_docker_macos()
    if _reg.sys.platform.startswith("linux"):
        return _bootstrap_docker_linux()
    return []


def _bootstrap_docker_macos() -> list[list[str]]:
    """Auto-install Colima + docker CLI via Homebrew on macOS."""
    cmds: list[list[str]] = []
    docker_cli = shutil.which("docker")
    colima_cli = shutil.which("colima")
    brew = shutil.which("brew")

    missing_pkgs: list[str] = []
    if not docker_cli:
        missing_pkgs.append("docker")
    if not colima_cli:
        missing_pkgs.append("colima")
    if missing_pkgs:
        if brew:
            cmds.append(["brew", "install"] + missing_pkgs)
        else:
            return []

    cmds.append(["bash", "-lc", "colima start || true"])
    return cmds


def _bootstrap_docker_linux() -> list[list[str]]:
    """Auto-install docker.io via apt and start the daemon on Debian/Ubuntu."""
    cmds: list[list[str]] = []
    if not shutil.which("docker"):
        if not shutil.which("apt-get"):
            return []
        cmds.append([
            "bash",
            "-lc",
            "export DEBIAN_FRONTEND=noninteractive && "
            "apt-get update -qq && "
            "apt-get install -y docker.io",
        ])
    cmds.append([
        "bash",
        "-lc",
        "systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true",
    ])
    return cmds


def _build_install_cmd(method: str, install: dict) -> list[str] | None:
    """Backwards-compatible single install command helper used by tests and diagnostics."""
    cmds = build_install_cmds(method, install)
    return cmds[-1] if cmds else None


def apply_patch(patch: dict) -> tuple[bool, str]:
    """Apply a single post-install source patch.

    Returns (success, message).
    """
    module = patch.get("module", "")
    find = patch.get("find", "")
    replace = patch.get("replace", "")
    if not module or not find:
        return False, "Patch incomplet (module/find lipsă)"

    spec = importlib.util.find_spec(module)
    if spec is None or spec.origin is None:
        return False, f"Modul {module!r} nu a fost găsit"

    src = Path(spec.origin)
    try:
        content = src.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"Nu pot citi {src}: {e}"

    if replace in content:
        return True, "Deja aplicat"
    if find not in content:
        return False, f"Fragment negăsit în {src.name}"

    content = content.replace(find, replace, 1)
    try:
        src.write_text(content, encoding="utf-8")
    except OSError as e:
        return False, f"Nu pot scrie {src}: {e}"

    return True, "Aplicat cu succes"


def run_install_commands(manifest: dict):
    """Run the install command synchronously (fallback, no streaming)."""
    install = manifest.get("install", {})
    method = install.get("method", "pip")
    cmds = build_install_cmds(method, install)
    if cmds:
        for cmd in cmds:
            log.info("Installing %s: %s", manifest.get("slug"), cmd)
            subprocess.check_call(cmd, timeout=600)
    elif method != "binary":
        raise ValueError(f"Unsupported or misconfigured install method: {method}")
    # Apply post-install patches (blocking path — log only)
    for patch in install.get("post_install_patches", []):
        ok, msg = apply_patch(patch)
        log.info("Patch [%s]: %s — %s", manifest.get("slug"), patch.get("description", "?"), msg)


def finalize_install(slug: str, manifest: dict) -> dict:
    """Save installed state + default config. Returns the new state dict."""
    from addons import registry

    schema = manifest.get("config_schema", [])
    default_config = {}
    for field in schema:
        default_config[field["key"]] = field.get("default", "")

    version = manifest.get("version", "1.0.0")
    try:
        resolved = registry._resolve_installed_version(manifest)
        if resolved:
            version = resolved
        version = registry._resolve_channel_version(manifest, str(version))
    except Exception:
        pass

    state = {
        "installed": True,
        "enabled": False,
        "version": version,
        "latest_version": version,  # just installed → up to date until next check
        "config": default_config,
        "watchdog": False,
    }
    save_addon_state(slug, state)
    integration_sync.sync_from_addon_state(slug, state)
    log.info("Addon %s installed successfully", slug)
    return state


def uninstall_addon(slug: str) -> dict:
    """Uninstall an addon. Returns updated state."""
    state = {
        "installed": False,
        "enabled": False,
        "version": None,
        "config": {HYVE_META_KEY: {"user_uninstalled": True}},
        "watchdog": False,
    }
    save_addon_state(slug, state)
    integration_sync.sync_enabled(slug, False)
    log.info("Addon %s uninstalled", slug)
    return state
