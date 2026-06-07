"""manifest.json parsing for folder-based integration components."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("integrations.manifest")

REQUIRED_KEYS = ("domain", "name", "version")


def load_manifest(component_dir: Path) -> dict[str, Any] | None:
    path = component_dir / "manifest.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Invalid manifest %s: %s", path, exc)
        return None
    if not isinstance(data, dict):
        log.warning("manifest.json must be an object: %s", path)
        return None
    missing = [key for key in REQUIRED_KEYS if not str(data.get(key) or "").strip()]
    if missing:
        log.warning("manifest.json missing required keys %s: %s", missing, path)
        return None
    domain = str(data["domain"]).strip()
    folder = component_dir.name
    if domain != folder:
        log.warning(
            "manifest domain %r does not match folder %r (%s); using manifest domain",
            domain,
            folder,
            path,
        )
    data["domain"] = domain
    data["name"] = str(data["name"]).strip()
    data["version"] = str(data["version"]).strip()
    return data
