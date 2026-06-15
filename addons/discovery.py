"""Add-on manifest discovery (bundled + custom)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from addons.paths import AVAILABLE_DIR, CUSTOM_DIR

log = logging.getLogger("addons.discovery")

_addon_dirs: dict[str, Path] = {}


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
    manifest["_source"] = "custom" if CUSTOM_DIR in addon_dir.parents or addon_dir == CUSTOM_DIR else "builtin"
    _addon_dirs[slug] = addon_dir
    return manifest


def list_available() -> list[dict]:
    """Return all available addon manifests, builtin + custom.

    Custom addons (under ``custom_addons/`` or ``$HYVE_CUSTOM_ADDONS_DIR``)
    can override builtin ones by sharing the same slug.
    """
    result: dict[str, dict] = {}
    for slug, mf_path, addon_dir in _iter_manifest_paths(AVAILABLE_DIR):
        manifest = _load_manifest_file(slug, mf_path, addon_dir)
        if manifest:
            result[slug] = manifest
    # Custom addons loaded second → they win on slug collision.
    for slug, mf_path, addon_dir in _iter_manifest_paths(CUSTOM_DIR):
        manifest = _load_manifest_file(slug, mf_path, addon_dir)
        if manifest:
            result[slug] = manifest
    return sorted(result.values(), key=lambda m: m.get("slug", ""))


def get_manifest(slug: str) -> dict | None:
    """Load a single addon manifest by slug. Custom overrides builtin."""
    # Custom first (override semantics)
    for root in (CUSTOM_DIR, AVAILABLE_DIR):
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

