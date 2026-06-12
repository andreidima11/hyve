"""Backward-compatible re-exports — prefer pymammotion_compat + device_registration."""

from __future__ import annotations

from components.mammotion.device_registration import complete_device_registration, list_http_device_names
from components.mammotion.pymammotion_compat import apply_pymammotion_patches

__all__ = [
    "apply_pymammotion_patches",
    "complete_device_registration",
    "list_http_device_names",
]
