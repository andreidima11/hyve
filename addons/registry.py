"""
Add-on registry — discovers, installs, configures and monitors add-ons.

Each add-on is a JSON manifest in  addons/available/<slug>.json  with:
  - slug, name, description, version, icon (FA class), color (tailwind)
  - install.method  : "pip" | "docker" | "binary" | "wyoming" | "brew" | "npm"
  - install.requirements / install.packages / install.image / install.url  (depending on method)
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
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import settings as settings_mod

log = logging.getLogger("addons")

_ADDONS_DIR = Path(__file__).parent
_AVAILABLE_DIR = _ADDONS_DIR / "available"
_PROJECT_ROOT = _ADDONS_DIR.parent
# Community / user-supplied addons live outside the bundled catalog so they
# survive Hyve upgrades and don't pollute the repo. HA-style: drop a folder in
# here and it shows up in Settings → Add-ons without touching Hyve sources.
_CUSTOM_DIR = Path(
    os.environ.get("HYVE_CUSTOM_ADDONS_DIR")
    or (_PROJECT_ROOT / "custom_addons")
)

# Cache of slug → source directory (where manifest.json or <slug>.json lives).
# Used by process_manager to resolve start_command script paths relative to the
# addon's own folder, so community addons can ship their own run.sh.
_addon_dirs: dict[str, Path] = {}

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

def _iter_manifest_paths(root: Path):
    """Yield (slug, manifest_path, addon_dir) for each addon under ``root``.

    Two layouts are supported:
      - Folder-based:  <root>/<slug>/manifest.json   (preferred, HA-style)
      - Single file:   <root>/<slug>.json            (legacy / quick prototype)
    Folder layout takes precedence when both exist for the same slug.
    """
    if not root.is_dir():
        return
    seen: set[str] = set()
    for entry in sorted(root.iterdir()):
        if entry.name.startswith(".") or entry.name.startswith("_"):
            continue
        if entry.is_dir():
            mf = entry / "manifest.json"
            if mf.is_file():
                seen.add(entry.name)
                yield entry.name, mf, entry
    for entry in sorted(root.glob("*.json")):
        slug = entry.stem
        if slug in seen:
            continue
        yield slug, entry, root


def _load_manifest_file(slug: str, path: Path, addon_dir: Path) -> dict | None:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("Bad addon manifest %s: %s", path, e)
        return None
    manifest.setdefault("slug", slug)
    manifest["_addon_dir"] = str(addon_dir)
    manifest["_source"] = "custom" if _CUSTOM_DIR in addon_dir.parents or addon_dir == _CUSTOM_DIR else "builtin"
    _addon_dirs[slug] = addon_dir
    return manifest


def list_available() -> list[dict]:
    """Return all available addon manifests, builtin + custom.

    Custom addons (under ``custom_addons/`` or ``$HYVE_CUSTOM_ADDONS_DIR``)
    can override builtin ones by sharing the same slug.
    """
    result: dict[str, dict] = {}
    for slug, mf_path, addon_dir in _iter_manifest_paths(_AVAILABLE_DIR):
        manifest = _load_manifest_file(slug, mf_path, addon_dir)
        if manifest:
            result[slug] = manifest
    # Custom addons loaded second → they win on slug collision.
    for slug, mf_path, addon_dir in _iter_manifest_paths(_CUSTOM_DIR):
        manifest = _load_manifest_file(slug, mf_path, addon_dir)
        if manifest:
            result[slug] = manifest
    return sorted(result.values(), key=lambda m: m.get("slug", ""))


def get_manifest(slug: str) -> dict | None:
    """Load a single addon manifest by slug. Custom overrides builtin."""
    # Custom first (override semantics)
    for root in (_CUSTOM_DIR, _AVAILABLE_DIR):
        if not root.is_dir():
            continue
        folder = root / slug
        mf = folder / "manifest.json"
        if mf.is_file():
            return _load_manifest_file(slug, mf, folder)
        single = root / f"{slug}.json"
        if single.is_file():
            return _load_manifest_file(slug, single, root)
    return None


def get_addon_dir(slug: str) -> Path | None:
    """Return the directory that owns the addon (where run.sh / assets live).

    Falls back to triggering a manifest load if the cache is cold.
    """
    if slug not in _addon_dirs:
        get_manifest(slug)
    return _addon_dirs.get(slug)


def get_state(slug: str) -> dict:
    """Return the installed state for an addon (or defaults)."""
    return _addons_cfg().get(slug, {
        "installed": False,
        "enabled": False,
        "version": None,
        "config": {},
        "watchdog": False,
    })


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


# ── live version resolution (per install method, generic) ──────────────────

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
            return p if p.is_absolute() else (_PROJECT_ROOT / p)
    return None


def _run_capture(cmd: list[str], timeout: float = 30) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception as e:
        log.debug("version cmd failed %s: %s", cmd, e)
    return None


_CHANNEL_TAGS = frozenset({
    "stable", "latest", "main", "master", "dev", "edge", "nightly", "beta", "rc",
})


def _is_channel_tag(version: str) -> bool:
    return str(version or "").strip().lower() in _CHANNEL_TAGS


def _normalize_version_string(version: str) -> str:
    raw = str(version or "").strip()
    if not raw:
        return ""
    if raw.lower().startswith("v") and len(raw) > 1 and (raw[1].isdigit() or raw[1] == "."):
        return raw[1:]
    return raw


def _docker_image(manifest: dict) -> str:
    return str((manifest.get("install") or {}).get("image") or "").strip()


def _github_repo(manifest: dict) -> str:
    install = manifest.get("install") or {}
    return str(install.get("version_github") or install.get("github_repo") or "").strip()


def _github_latest_version(repo: str) -> str | None:
    repo = str(repo or "").strip().strip("/")
    if not repo or "/" not in repo:
        return None
    import urllib.request
    try:
        url = f"https://api.github.com/repos/{repo}/releases/latest"
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        tag = str(data.get("tag_name") or data.get("name") or "").strip()
        normalized = _normalize_version_string(tag)
        return normalized or None
    except Exception as e:
        log.debug("github latest failed for %s: %s", repo, e)
        return None


def _docker_installed_version(image: str) -> str | None:
    if not image or not shutil.which("docker"):
        return None
    fmt = '{{index .Config.Labels "org.opencontainers.image.version"}}'
    label = _run_capture(["docker", "image", "inspect", image, "--format", fmt], timeout=15)
    if label and label not in ("<no value>", ""):
        normalized = _normalize_version_string(label)
        if normalized and not _is_channel_tag(normalized):
            return normalized
    if ":" in image:
        tag = image.rsplit(":", 1)[-1].strip()
        if tag and not _is_channel_tag(tag):
            normalized = _normalize_version_string(tag)
            if normalized:
                return normalized
    return None


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
            ver = body.strip().strip('"')
        normalized = _normalize_version_string(ver)
        return normalized if normalized and not _is_channel_tag(normalized) else None
    except Exception as e:
        log.debug("runtime version probe failed for %s: %s", manifest.get("slug"), e)
        return None


def _resolve_display_version(manifest: dict, state: dict) -> str:
    """Best-effort semver for UI — never a Docker channel tag when avoidable."""
    manifest_ver = str(manifest.get("version") or "").strip()

    if state.get("installed"):
        saved = str(state.get("version") or "").strip()
        if saved and not _is_channel_tag(saved):
            return saved
        runtime = _http_runtime_version(manifest, state)
        if runtime:
            return runtime
        resolved = _resolve_installed_version(manifest)
        if resolved:
            return resolved

    install = manifest.get("install") or {}
    if install.get("method") == "docker":
        resolved = _docker_installed_version(_docker_image(manifest))
        if resolved:
            return resolved

    if _is_channel_tag(manifest_ver):
        latest = _github_latest_version(_github_repo(manifest))
        if latest:
            return latest

    return manifest_ver or "?"


def addon_entry(manifest: dict, state: dict | None = None) -> dict:
    """Manifest + state enriched with a resolved catalog version for the UI."""
    state = state if state is not None else get_state(manifest["slug"])
    return {
        **manifest,
        "version": _resolve_display_version(manifest, state),
        "state": state,
        "update_available": is_update_available(manifest, state),
    }


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
        return (data.get("info") or {}).get("version")
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
    return _run_capture(["npm", "view", pkg, "version"], timeout=30)


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
    return None


def _resolve_latest_version(manifest: dict) -> str | None:
    """Query the package registry for the latest version (may hit the network)."""
    install = manifest.get("install", {}) or {}
    method = install.get("method", "pip")
    if method == "docker":
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
    try:
        installed = _http_runtime_version(manifest, state) or _resolve_installed_version(manifest)
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
    except Exception as e:
        log.debug("latest version resolve failed for %s: %s", slug, e)

    if changed:
        _save_addon_state(slug, state)
    return state


def list_all() -> list[dict]:
    """Return manifests merged with installed state + an update-available flag."""
    return [addon_entry(manifest) for manifest in list_available()]


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

    # docker method needs docker — but if it's missing we auto-install
    # Colima via Homebrew during the install step, so the preflight passes
    # as long as either docker OR brew is available.
    if method == "docker":
        if shutil.which("docker"):
            checks.append({"name": "Docker", "ok": True, "detail": "OK", "fix": ""})
        elif shutil.which("brew"):
            checks.append({
                "name": "Docker",
                "ok": True,
                "detail": "Lipsă — va fi instalat automat (Colima via Homebrew).",
                "fix": "",
            })
        else:
            checks.append({
                "name": "Docker",
                "ok": False,
                "detail": "Nici Docker, nici Homebrew nu sunt instalate.",
                "fix": "Instalează Homebrew: https://brew.sh (apoi reîncearcă instalarea — Hyve aduce restul).",
            })

    if method == "brew":
        checks.append(await _check_command(
            ["brew", "--version"],
            name="Homebrew",
            fix="Instalează Homebrew: https://brew.sh",
        ))

    if method == "npm":
        checks.append(await _check_command(
            ["npm", "--version"],
            name="npm",
            fix="Instalează Node.js și npm: https://nodejs.org",
        ))
        checks.append(await _check_command(
            ["node", "--version"],
            name="Node.js",
            fix="Instalează Node.js: https://nodejs.org",
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


def update_addon(slug: str) -> dict:
    """Update an installed addon to the latest available version while preserving state."""
    manifest = get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    current = get_state(slug)
    if not current.get("installed"):
        raise ValueError(f"Addon {slug} is not installed")

    _run_install_commands(manifest)

    schema = manifest.get("config_schema", [])
    default_config = {field["key"]: field.get("default", "") for field in schema}
    merged_config = {**default_config, **(current.get("config") or {})}

    version = manifest.get("version", "1.0.0")
    try:
        resolved = _resolve_installed_version(manifest)
        if resolved:
            version = resolved
        elif _is_channel_tag(version):
            latest = _github_latest_version(_github_repo(manifest))
            if latest:
                version = latest
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
    _save_addon_state(slug, state)
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
    cmds = _build_install_cmds(method, install)

    # Auto-bootstrap missing prerequisites (e.g. Docker daemon for `docker`
    # method on macOS — we install Colima via brew so a single click works
    # without forcing the user to download Docker Desktop manually).
    bootstrap = _bootstrap_cmds_for_method(method)

    if not cmds:
        if method == "binary":
            _finalize_install(slug, manifest)
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
                ok, msg = _apply_patch(patch)
                yield f"  {'✅' if ok else '❌'} {msg}\n"

        _finalize_install(slug, manifest)
        yield "__DONE__"

    except Exception as e:
        yield f"\nEroare: {e}\n"
        yield f"__FAIL__:{e}"


# ── install helpers ──────────────────────────────────────────────────────

def _build_install_cmds(method: str, install: dict) -> list[list[str]]:
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


def _bootstrap_cmds_for_method(method: str) -> list[list[str]]:
    """Return commands needed to make `method` usable, or [] if already ready.

    For ``docker`` on macOS this auto-installs Colima (a free, headless Docker
    runtime) and starts its VM, so the user can install Docker-based add-ons
    with one click instead of downloading Docker Desktop manually.
    """
    cmds: list[list[str]] = []
    if method != "docker":
        return cmds

    docker_cli = shutil.which("docker")
    colima_cli = shutil.which("colima")

    # Need Homebrew to bootstrap anything on macOS.
    brew = shutil.which("brew")

    # Install missing CLIs via brew.
    missing_pkgs: list[str] = []
    if not docker_cli:
        missing_pkgs.append("docker")
    if not colima_cli:
        missing_pkgs.append("colima")
    if missing_pkgs:
        if brew:
            cmds.append(["brew", "install"] + missing_pkgs)
        else:
            # No brew → can't bootstrap. Let the docker pull fail with a
            # clear message instead of pretending we can fix it.
            return []

    # Ensure the Colima daemon is running. `colima start` is idempotent —
    # exits 0 quickly if the VM is already up, otherwise creates it.
    cmds.append(["bash", "-lc", "colima start || true"])
    return cmds


def _build_install_cmd(method: str, install: dict) -> list[str] | None:
    """Backwards-compatible single install command helper used by tests and diagnostics."""
    cmds = _build_install_cmds(method, install)
    return cmds[-1] if cmds else None


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
    cmds = _build_install_cmds(method, install)
    if cmds:
        for cmd in cmds:
            log.info("Installing %s: %s", manifest.get("slug"), cmd)
            subprocess.check_call(cmd, timeout=600)
    elif method != "binary":
        raise ValueError(f"Unsupported or misconfigured install method: {method}")
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

    version = manifest.get("version", "1.0.0")
    try:
        resolved = _resolve_installed_version(manifest)
        if resolved:
            version = resolved
        elif _is_channel_tag(version):
            latest = _github_latest_version(_github_repo(manifest))
            if latest:
                version = latest
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
    """Update addon config fields and bootstrap external/local usage if needed."""
    manifest = get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    state = get_state(slug)
    if not state.get("installed"):
        schema = manifest.get("config_schema", [])
        default_config = {field["key"]: field.get("default", "") for field in schema}
        state = {
            "installed": True,
            "enabled": False,
            "version": manifest.get("version", "1.0.0"),
            "config": default_config,
            "watchdog": False,
        }

    state.setdefault("config", {})
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
    if not state.get("installed"):
        return {"ok": False, "detail": "not_configured"}

    hc = manifest.get("health_check")
    if not hc:
        return {"ok": True, "detail": "no_check"}

    cfg = state.get("config", {})
    host = hc.get("host") or cfg.get(hc.get("host_key", "host"), "localhost")
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
