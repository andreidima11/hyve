"""Shared path constants for the add-on subsystem."""

from __future__ import annotations

import os
from pathlib import Path

ADDONS_DIR = Path(__file__).resolve().parent
AVAILABLE_DIR = ADDONS_DIR / "available"
PROJECT_ROOT = ADDONS_DIR.parent
CUSTOM_DIR = Path(
    os.environ.get("HYVE_CUSTOM_ADDONS_DIR")
    or (PROJECT_ROOT / "custom_addons")
)
