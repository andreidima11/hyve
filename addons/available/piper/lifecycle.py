"""Piper add-on lifecycle — detect local voice models on disk."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


def detect_on_disk_version(
    manifest: dict[str, Any],
    *,
    project_root: Path,
    resolve_channel_version: Callable[[dict[str, Any], str], str] | None = None,
) -> str | None:
    del resolve_channel_version
    models_dir = project_root / "piper_models"
    if models_dir.is_dir() and any(models_dir.glob("*.onnx")):
        return manifest.get("version") or None
    return None
