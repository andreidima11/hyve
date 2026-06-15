"""Pre-install requirement checks for add-ons."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sys

from addons.discovery import get_manifest
from addons.versions import (
    _brew_binary_present,
    _docker_daemon_reachable,
    _strip_pkg_version,
)

log = logging.getLogger("addons.preflight")

def _preflight_item(
    name: str,
    ok: bool,
    *,
    detail_key: str | None = None,
    detail_params: dict | None = None,
    detail: str = "",
    fix: str = "",
    fix_key: str | None = None,
    fix_params: dict | None = None,
) -> dict:
    item: dict = {"name": name, "ok": ok}
    if detail_key:
        item["detail_key"] = detail_key
        if detail_params:
            item["detail_params"] = detail_params
    elif detail:
        item["detail"] = detail
    if not ok:
        if fix_key:
            item["fix_key"] = fix_key
            if fix_params:
                item["fix_params"] = fix_params
        elif fix:
            item["fix"] = fix
    return item


async def preflight_check(slug: str) -> list[dict]:
    """Run pre-install checks for an addon.

    Returns a list of  { name, ok, detail, fix }  dicts.
    """
    manifest = get_manifest(slug)
    if not manifest:
        return [_preflight_item(
            "manifest",
            False,
            detail_key="apps.preflight_unknown_addon",
        )]

    install = manifest.get("install", {})
    method = install.get("method", "pip")
    checks: list[dict] = []

    # pip / wyoming need a working C compiler on macOS for native extensions
    if method in ("pip", "wyoming"):
        checks.append(await _check_compiler())

    # Check for native library dependencies (e.g. portaudio for pyaudio)
    packages = install.get("packages", [])
    if method in ("pip", "wyoming") and any("pyaudio" in p.lower() for p in packages):
        checks.append(await _check_portaudio())

    # docker method needs docker — auto-install on macOS (Colima/brew) or Linux (apt).
    if method == "docker":
        if _docker_daemon_reachable():
            checks.append(_preflight_item("Docker", True))
        elif sys.platform == "darwin" and shutil.which("brew"):
            checks.append(_preflight_item(
                "Docker",
                True,
                detail_key="apps.preflight_docker_auto_install",
            ))
        elif sys.platform.startswith("linux") and shutil.which("apt-get"):
            checks.append(_preflight_item(
                "Docker",
                True,
                detail_key="apps.preflight_docker_auto_install_linux",
            ))
        elif shutil.which("docker"):
            checks.append(_preflight_item(
                "Docker",
                False,
                detail_key="apps.preflight_docker_daemon_down",
                fix_key="apps.preflight_fix_start_docker",
            ))
        else:
            fix_key = (
                "apps.preflight_fix_install_brew"
                if sys.platform == "darwin"
                else "apps.preflight_fix_install_docker_linux"
            )
            checks.append(_preflight_item(
                "Docker",
                False,
                detail_key="apps.preflight_docker_missing",
                fix_key=fix_key,
            ))

    if method == "brew":
        packages = install.get("packages", []) or []
        requirements = install.get("requirements", []) or []
        all_pkgs = [_strip_pkg_version(p) for p in requirements + packages]
        missing = [p for p in all_pkgs if p and not _brew_binary_present(p)]
        if not missing:
            label = packages[0] if packages else (requirements[0] if requirements else "Package")
            checks.append(_preflight_item(str(label), True))
        elif sys.platform == "darwin":
            checks.append(await _check_command(
                ["brew", "--version"],
                name="Homebrew",
                fix_key="apps.preflight_fix_brew",
            ))
        elif sys.platform.startswith("linux") and shutil.which("apt-get"):
            label = missing[0] if missing else "Package"
            checks.append(_preflight_item(
                str(label),
                True,
                detail_key="apps.preflight_brew_auto_install_linux",
            ))
        else:
            label = missing[0] if missing else "Package"
            fix_key = (
                "apps.preflight_fix_install_brew"
                if sys.platform == "darwin"
                else "apps.preflight_fix_install_brew_linux"
            )
            checks.append(_preflight_item(
                str(label),
                False,
                detail_key="apps.preflight_brew_missing",
                fix_key=fix_key,
            ))

    if method == "npm":
        checks.append(await _check_command(
            ["npm", "--version"],
            name="npm",
            fix_key="apps.preflight_fix_node",
        ))
        checks.append(await _check_command(
            ["node", "--version"],
            name="Node.js",
            fix_key="apps.preflight_fix_node",
        ))

    return checks


async def _check_compiler() -> dict:
    """Check that a C compiler (clang) works."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "clang", "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        text = out.decode("utf-8", errors="replace")
        if proc.returncode == 0:
            return _preflight_item("C compiler (clang)", True)
        if "license" in text.lower():
            return _preflight_item(
                "Xcode license",
                False,
                detail_key="apps.preflight_xcode_license",
                fix="sudo xcodebuild -license accept",
            )
        return _preflight_item("C compiler (clang)", False, detail=text[:200], fix="xcode-select --install")
    except FileNotFoundError:
        return _preflight_item(
            "C compiler (clang)",
            False,
            detail_key="apps.preflight_clang_missing",
            fix="xcode-select --install",
        )
    except Exception as e:
        return _preflight_item("C compiler (clang)", False, detail=str(e))


async def _check_command(cmd: list[str], *, name: str, fix: str = "", fix_key: str | None = None) -> dict:
    """Generic check: can we run `cmd` successfully?"""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=10)
        if proc.returncode == 0:
            return _preflight_item(name, True)
        return _preflight_item(
            name,
            False,
            detail_key="apps.preflight_exit_code",
            detail_params={"code": proc.returncode},
            fix=fix,
            fix_key=fix_key,
        )
    except FileNotFoundError:
        return _preflight_item(
            name,
            False,
            detail_key="apps.preflight_command_not_found",
            detail_params={"command": cmd[0]},
            fix=fix,
            fix_key=fix_key,
        )
    except Exception as e:
        return _preflight_item(name, False, detail=str(e), fix=fix, fix_key=fix_key)


async def _check_portaudio() -> dict:
    """Check that the portaudio library is installed (needed by pyaudio)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "pkg-config", "--exists", "portaudio-2.0",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5)
        if proc.returncode == 0:
            return _preflight_item("portaudio (pyaudio)", True)
    except (FileNotFoundError, asyncio.TimeoutError):
        pass
    # Fallback: check if the header file exists in common locations
    for p in ("/opt/homebrew/include/portaudio.h", "/usr/local/include/portaudio.h", "/usr/include/portaudio.h"):
        if os.path.isfile(p):
            return _preflight_item("portaudio (pyaudio)", True)
    return _preflight_item(
        "portaudio (pyaudio)",
        False,
        detail_key="apps.preflight_portaudio_missing",
        fix="brew install portaudio",
    )
