"""Discover Hyveview dashboard card packages (bundled + community drop-ins)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BUNDLED_CARDS_DIR = _PROJECT_ROOT / "static" / "hyveview" / "cards"
DEFAULT_CUSTOM_CARDS_DIR = _PROJECT_ROOT / "custom_components" / "cards"


def custom_cards_dir() -> Path:
    raw = (os.environ.get("HYVE_CUSTOM_CARDS_DIR") or "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else (_PROJECT_ROOT / path)
    return DEFAULT_CUSTOM_CARDS_DIR


def _read_manifest(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _package_from_dir(
    card_dir: Path,
    *,
    origin: str,
    url_prefix: str,
) -> dict[str, Any] | None:
    manifest_path = card_dir / "manifest.json"
    manifest = _read_manifest(manifest_path) if manifest_path.is_file() else {}
    if manifest is None:
        return None

    card_id = str(manifest.get("id") or card_dir.name).strip()
    if not card_id:
        return None

    entry_file = str(manifest.get("entry") or "index.js").strip() or "index.js"
    entry_path = card_dir / entry_file
    if not entry_path.is_file():
        return None

    styles: list[str] = []
    for rel in manifest.get("styles") or []:
        rel_s = str(rel).strip().lstrip("/")
        if rel_s:
            styles.append(f"{url_prefix}/{card_id}/{rel_s}")

    return {
        "id": card_id,
        "origin": origin,
        "entry": f"{url_prefix}/{card_id}/{entry_file}",
        "styles": styles,
        "name": manifest.get("name") or card_id,
        "version": manifest.get("version") or "0.0.0",
        "description": manifest.get("description") or "",
    }


def discover_bundled_card_packages() -> list[dict[str, Any]]:
    """Card folders under static/hyveview/cards/ (excludes shared/)."""
    if not BUNDLED_CARDS_DIR.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for child in sorted(BUNDLED_CARDS_DIR.iterdir()):
        if not child.is_dir() or child.name in ("shared",):
            continue
        pkg = _package_from_dir(child, origin="bundled", url_prefix="/static/hyveview/cards")
        if pkg:
            out.append(pkg)
    return out


def discover_custom_card_packages() -> list[dict[str, Any]]:
    """User drop-ins under custom_components/cards/ (or HYVE_CUSTOM_CARDS_DIR)."""
    root = custom_cards_dir()
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        pkg = _package_from_dir(child, origin="custom", url_prefix="/custom_components/cards")
        if pkg:
            out.append(pkg)
    return out


def list_card_packages() -> dict[str, Any]:
    bundled = discover_bundled_card_packages()
    custom = discover_custom_card_packages()
    return {"bundled": bundled, "custom": custom}
