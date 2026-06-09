"""Load bundled/custom component modules in tests."""

from __future__ import annotations

from typing import Any

from integrations.component_import import load_component_module


def component_module(domain: str, stem: str = "client") -> Any:
    return load_component_module(domain, stem)
