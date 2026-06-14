"""Post-restore add-on artifact reconciliation (Phase 1 — planning + optional refetch)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from core.backup.addons_policy import (
    list_addon_slugs_with_data,
    slugs_needing_artifact_refetch,
)

log = logging.getLogger("backup.addon_restore")


@dataclass
class AddonRestorePlan:
    slugs_with_data: list[str]
    refetch_slugs: list[str]


class AddonRestoreCoordinator:
    """Plan and optionally trigger add-on artifact refetch after restore."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def plan(self, manifest_addons: dict | None = None) -> AddonRestorePlan:
        meta = manifest_addons or {}
        slugs = list(meta.get("included_slugs") or list_addon_slugs_with_data(self.root))
        refetch = list(
            meta.get("refetch_on_restore") or slugs_needing_artifact_refetch(slugs)
        )
        return AddonRestorePlan(slugs_with_data=sorted(slugs), refetch_slugs=refetch)

    def refetch_artifacts(self, slugs: list[str], *, dry_run: bool = False) -> list[str]:
        """Re-run install for slugs that need runtime artifacts. Returns log lines."""
        lines: list[str] = []
        if not slugs:
            return lines

        try:
            from addons import registry
        except ImportError:
            for slug in slugs:
                lines.append(f"skip_refetch:{slug}:registry_unavailable")
            return lines

        for slug in slugs:
            state = registry.get_state(slug)
            if not state.get("installed"):
                lines.append(f"skip_refetch:{slug}:not_installed")
                continue
            if dry_run:
                lines.append(f"would_refetch:{slug}")
                continue
            try:
                registry.install_addon(slug)
                lines.append(f"refetched:{slug}")
            except Exception as exc:
                log.warning("Add-on refetch failed for %s: %s", slug, exc)
                lines.append(f"refetch_failed:{slug}:{exc}")
        return lines
