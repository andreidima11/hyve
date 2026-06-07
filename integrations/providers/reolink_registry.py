"""Legacy import path — implementation lives in components/reolink/registry.py."""

from __future__ import annotations

from integrations.component_import import import_sibling
from integrations.component_paths import BUNDLED_COMPONENTS_DIR

_mod = import_sibling(BUNDLED_COMPONENTS_DIR / "reolink", "registry")

ReolinkSpec = _mod.ReolinkSpec
all_specs = _mod.all_specs
build_entities = _mod.build_entities

__all__ = ['ReolinkSpec', 'all_specs', 'build_entities']
