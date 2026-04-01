"""
Add-on registry — discovers, installs, configures and monitors add-ons.

Each add-on is a JSON manifest in  addons/available/<slug>.json  with:
  - slug, name, description, version, icon (FA class), color (tailwind)
  - install.method  : "pip" | "docker" | "binary" | "wyoming"
  - install.packages / install.image / install.url  (depending on method)
  - config_schema   : list of field defs for the settings UI
  - health_check    : { type: "tcp"|"http", host_key, port_key }
  - integration_key : if set, maps to an existing integration in config.json

Installed state is tracked in  config.json  under  addons.<slug>:
  { installed: bool, enabled: bool, version: str, config: { ... } }
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import settings as settings_mod

log = logging.getLogger("addons")

_ADDONS_DIR = Path(__file__).parent
_AVAILABLE_DIR = _ADDONS_DIR / "available"


# ── helpers ────────────────────────────────────────────────────────────────

def _addons_cfg() -> dict:
    """Return the addons section of config.json (mutable)."""
    cfg = settings_mod.CFG
    if "addons" not in cfg:
        cfg["addons"] = {}
    return cfg["addons"]


def _save_addon_state(slug: str, state: dict):
    """Persist addon state to config.json."""
    addons = _addons_cfg()
    addons[slug] = state
    settings_mod.save_config({"addons": addons})


# ── registry ───────────────────────────────────────────────────────────────

def list_available() -> list[dict]:
    """Return all available addon manifests."""
    result = []
    if not _AVAILABLE_DIR.is_dir():
        return result
    for f in sorted(_AVAILABLE_DIR.glob("*.json")):
        try:
            manifest = json.loads(f.read_text(encoding="utf-8"))
            manifest.setdefault("slug", f.stem)
            result.append(manifest)
        except Exception as e:
            log.warning("Bad addon manifest %s: %s", f.name, e)
    return result


def get_manifest(slug: str) -> dict | None:
    """Load a single addon manifest by slug."""
    p = _AVAILABLE_DIR / f"{slug}.json"
    if not p.is_file():
        return None
    try:
        m = json.loads(p.read_text(encoding="utf-8"))
        m.setdefault("slug", slug)
        return m
    except Exception:
        return None


def get_state(slug: str) -> dict:
    """Return the installed state for an addon (or defaults)."""
    return _addons_cfg().get(slug, {
        "installed": False,
        "enabled": False,
        "version": None,
        "config": {},
        "watchdog": False,
    })


def list_all() -> list[dict]:
    """Return manifests merged with installed state."""
    result = []
    for manifest in list_available():
        slug = manifest["slug"]
        state = get_state(slug)
        result.append({**manifest, "state": state})
    return result


# ── preflight checks ─────────────────────────────────────────────────────

async def preflight_check(slug: str) -> list[dict]:
    """Run pre-install checks for an addon.

    Returns a list of  { name, ok, detail, fix }  dicts.
    """
    manifest = get_manifest(slug)
    if not manifest:
        return [{"name": "manifest", "ok": False, "detail": "Add-on necunoscut", "fix": ""}]

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

    # docker method needs docker
    if method == "docker":
        checks.append(await _check_command(
            ["docker", "--version"],
            name="Docker",
            fix="Instalează Docker Desktop: https://www.docker.com/products/docker-desktop",
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
            return {"name": "Compilator C (clang)", "ok": True, "detail": "OK", "fix": ""}
        if "license" in text.lower():
            return {
                "name": "Licență Xcode",
                "ok": False,
                "detail": "Licența Xcode nu a fost acceptată.",
                "fix": "sudo xcodebuild -license accept",
            }
        return {"name": "Compilator C (clang)", "ok": False, "detail": text[:200], "fix": "xcode-select --install"}
    except FileNotFoundError:
        return {
            "name": "Compilator C (clang)",
            "ok": False,
            "detail": "clang nu a fost găsit.",
            "fix": "xcode-select --install",
        }
    except Exception as e:
        return {"name": "Compilator C (clang)", "ok": False, "detail": str(e), "fix": ""}


async def _check_command(cmd: list[str], *, name: str, fix: str) -> dict:
    """Generic check: can we run `cmd` successfully?"""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=10)
        if proc.returncode == 0:
            return {"name": name, "ok": True, "detail": "OK", "fix": ""}
        return {"name": name, "ok": False, "detail": f"Exit code {proc.returncode}", "fix": fix}
    except FileNotFoundError:
        return {"name": name, "ok": False, "detail": f"{cmd[0]} nu a fost găsit.", "fix": fix}
    except Exception as e:
        return {"name": name, "ok": False, "detail": str(e), "fix": fix}


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
            return {"name": "portaudio (pyaudio)", "ok": True, "detail": "OK", "fix": ""}
    except (FileNotFoundError, asyncio.TimeoutError):
        pass
    # Fallback: check if the header file exists in common locations
    for p in ("/opt/homebrew/include/portaudio.h", "/usr/local/include/portaudio.h", "/usr/include/portaudio.h"):
        if os.path.isfile(p):
            return {"name": "portaudio (pyaudio)", "ok": True, "detail": "OK", "fix": ""}
    return {
        "name": "portaudio (pyaudio)",
        "ok": False,
        "detail": "Biblioteca portaudio lipsește — pyaudio nu se poate compila.",
        "fix": "brew install portaudio",
    }


# ── install / uninstall ───────────────────────────────────────────────────

def install_addon(slug: str) -> dict:
    """Install an addon (blocking, no log streaming). Returns updated state."""
    manifest = get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    _run_install_commands(manifest)
    return _finalize_install(slug, manifest)


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
    cmd = _build_install_cmd(method, install)

    if cmd is None:
        # method == "binary" — nothing to run
        _finalize_install(slug, manifest)
        yield "Add-on marcat ca instalat (binary — fără descărcare)."
        yield "__DONE__"
        return

    yield f"$ {' '.join(cmd)}\n"

    try:
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
                ok, msg = _apply_patch(patch)
                yield f"  {'✅' if ok else '❌'} {msg}\n"

        _finalize_install(slug, manifest)
        yield "__DONE__"

    except Exception as e:
        yield f"\nEroare: {e}\n"
        yield f"__FAIL__:{e}"


# ── install helpers ──────────────────────────────────────────────────────

def _build_install_cmd(method: str, install: dict) -> list[str] | None:
    """Build the subprocess command list for an install method (or None for binary)."""
    if method == "pip":
        packages = install.get("packages", [])
        if packages:
            return [sys.executable, "-m", "pip", "install"] + packages
        return None

    if method == "docker":
        image = install.get("image", "")
        if image:
            return ["docker", "pull", image]
        return None

    if method == "binary":
        return None

    if method == "wyoming":
        pip_packages = install.get("packages", [])
        if pip_packages:
            return [sys.executable, "-m", "pip", "install"] + pip_packages
        return None

    return None


def _apply_patch(patch: dict) -> tuple[bool, str]:
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


def _run_install_commands(manifest: dict):
    """Run the install command synchronously (fallback, no streaming)."""
    install = manifest.get("install", {})
    method = install.get("method", "pip")
    cmd = _build_install_cmd(method, install)
    if cmd:
        log.info("Installing %s: %s", manifest.get("slug"), cmd)
        subprocess.check_call(cmd, timeout=600)
    # Apply post-install patches (blocking path — log only)
    for patch in install.get("post_install_patches", []):
        ok, msg = _apply_patch(patch)
        log.info("Patch [%s]: %s — %s", manifest.get("slug"), patch.get("description", "?"), msg)


def _finalize_install(slug: str, manifest: dict) -> dict:
    """Save installed state + default config. Returns the new state dict."""
    schema = manifest.get("config_schema", [])
    default_config = {}
    for field in schema:
        default_config[field["key"]] = field.get("default", "")

    state = {
        "installed": True,
        "enabled": False,
        "version": manifest.get("version", "1.0.0"),
        "config": default_config,
        "watchdog": False,
    }
    _save_addon_state(slug, state)
    log.info("Addon %s installed successfully", slug)
    return state


def uninstall_addon(slug: str) -> dict:
    """Uninstall an addon. Returns updated state."""
    state = {"installed": False, "enabled": False, "version": None, "config": {}, "watchdog": False}
    _save_addon_state(slug, state)
    log.info("Addon %s uninstalled", slug)
    return state


def update_addon_config(slug: str, config: dict) -> dict:
    """Update addon config fields, returns updated state."""
    state = get_state(slug)
    if not state.get("installed"):
        raise ValueError(f"Addon {slug} is not installed")
    state["config"].update(config)
    _save_addon_state(slug, state)
    return state


def set_addon_enabled(slug: str, enabled: bool) -> dict:
    """Enable/disable an addon. Returns updated state."""
    state = get_state(slug)
    if not state.get("installed"):
        raise ValueError(f"Addon {slug} is not installed")
    state["enabled"] = enabled
    _save_addon_state(slug, state)
    return state


def set_addon_watchdog(slug: str, enabled: bool) -> dict:
    """Enable/disable watchdog for an addon. Returns updated state."""
    state = get_state(slug)
    if not state.get("installed"):
        raise ValueError(f"Addon {slug} is not installed")
    state["watchdog"] = enabled
    _save_addon_state(slug, state)
    return state


def get_watchdog_addons() -> list[str]:
    """Return slugs of addons with watchdog enabled."""
    result = []
    for manifest in list_available():
        slug = manifest["slug"]
        state = get_state(slug)
        if state.get("installed") and state.get("enabled") and state.get("watchdog"):
            if manifest.get("start_command"):
                result.append(slug)
    return result


# ── health checks ─────────────────────────────────────────────────────────

async def check_health(slug: str) -> dict:
    """Run a health check for an addon. Returns { ok: bool, detail: str }."""
    manifest = get_manifest(slug)
    if not manifest:
        return {"ok": False, "detail": "unknown_addon"}

    state = get_state(slug)
    if not state.get("installed") or not state.get("enabled"):
        return {"ok": False, "detail": "not_running"}

    hc = manifest.get("health_check")
    if not hc:
        return {"ok": True, "detail": "no_check"}

    cfg = state.get("config", {})
    host = cfg.get(hc.get("host_key", "host"), "localhost")
    port = int(cfg.get(hc.get("port_key", "port"), 0))

    if not port:
        return {"ok": False, "detail": "no_port_configured"}

    hc_type = hc.get("type", "tcp")

    if hc_type == "tcp":
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=5
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"ok": True, "detail": "connected"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    elif hc_type == "http":
        try:
            import httpx
            url = f"http://{host}:{port}{hc.get('path', '/')}"
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(url)
                return {"ok": r.status_code < 400, "detail": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"ok": False, "detail": str(e)}

    return {"ok": False, "detail": f"unknown_check_type: {hc_type}"}
