"""Orchestrate integration device rename (alias, registry, upstream, resync)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("integrations.device_rename")


@dataclass
class DeviceRenameRequest:
    name: str
    current_name: str | None = None
    homeassistant_rename: bool = True


class DeviceRenameService:
    """Rename a device across Hyve registries and optional upstream (e.g. Z2M)."""

    async def rename(
        self,
        slug: str,
        device_id: str,
        request: DeviceRenameRequest,
    ) -> dict[str, Any]:
        from integrations import device_aliases, get_integration_manager

        slug = (slug or "").strip()
        device_id = (device_id or "").strip()
        new_name = (request.name or "").strip()
        if not slug or not device_id or not new_name:
            raise ValueError("slug, device_id and name are required")

        canonical_id = device_aliases.canonical_device_id(device_id) or device_id
        previous_alias = device_aliases.get_alias(slug, canonical_id)

        try:
            from core import device_registry

            previous_device = device_registry.get_device(canonical_id)
        except Exception:
            previous_device = None

        try:
            device_aliases.set_alias(slug, canonical_id, new_name)
        except Exception as exc:
            raise RuntimeError(f"Failed to save alias: {exc}") from exc

        try:
            from core import device_registry

            device_registry.set_device_name(
                canonical_id,
                new_name,
                source=slug,
                z2m_friendly_name=new_name,
            )
        except Exception as exc:
            log.warning("device registry rename failed for %s/%s: %s", slug, canonical_id, exc)

        supplied = (request.current_name or "").strip()
        old_name_candidates = [
            supplied,
            previous_alias,
            (previous_device or {}).get("z2m_friendly_name"),
            (previous_device or {}).get("name") if (previous_device or {}).get("name_by_user") else None,
        ]

        def _refresh_registry_entities() -> dict[str, Any]:
            from core import entity_registry

            return entity_registry.refresh_entity_ids_for_device_rename(
                canonical_id,
                old_friendly=supplied or str(old_name_candidates[0] or ""),
                old_friendly_names=[str(v) for v in old_name_candidates if v],
                new_friendly=new_name,
            )

        registry_refresh: dict[str, Any] | None = None
        try:
            registry_refresh = _refresh_registry_entities()
            self._invalidate_entity_cache()
        except Exception as exc:
            log.warning("entity registry refresh after rename failed: %s", exc)

        old_names_for_purge = [
            str(v).strip()
            for v in old_name_candidates
            if v and str(v).strip() and str(v).strip().lower() != new_name.lower()
        ]

        purged_discovery = self._purge_bridge_discovery(
            slug,
            canonical_id,
            old_names_for_purge,
        )

        upstream = await self._upstream_rename(
            slug,
            canonical_id,
            new_name,
            supplied,
            request.homeassistant_rename,
            _refresh_registry_entities,
        )

        await self._resync_after_rename(slug)

        return {
            "status": "ok",
            "slug": slug,
            "device_id": canonical_id,
            "name": new_name,
            "registry_refresh": registry_refresh,
            "upstream": upstream,
            "purged_discovery": purged_discovery,
            "resynced": True,
        }

    @staticmethod
    def _invalidate_entity_cache() -> None:
        from core.entity_catalog import invalidate_entity_cache

        invalidate_entity_cache()

    def _purge_bridge_discovery(
        self,
        slug: str,
        canonical_id: str,
        old_names_for_purge: list[str],
    ) -> int:
        if slug != "mosquitto":
            return 0
        try:
            from components.mosquitto import bridge as mosquitto_bridge
            from integrations import get_integration_manager

            removed = 0
            for inst in get_integration_manager().entries_for(slug):
                br = mosquitto_bridge.get_bridge(inst.entry_id)
                if br is not None:
                    removed += br.purge_discovery_for_device(
                        canonical_id,
                        old_friendly_names=old_names_for_purge,
                    )
            return removed
        except Exception as exc:
            log.debug("bridge discovery purge failed: %s", exc)
            return 0

    async def _resync_after_rename(self, slug: str) -> None:
        try:
            from addons.entity_store import get_entity_store
            from integrations import get_integration_manager

            store = get_entity_store()
            manager = get_integration_manager()
            for inst in manager.entries_for(slug):
                if not inst.supports_sync:
                    continue
                key = inst.store_key
                if not store.get_fetcher(key):
                    manager.register_fetcher(inst.entry_id or slug, store, include_disabled=True)
                await store.do_sync(key, force=True)
        except Exception as exc:
            log.warning("post-rename sync failed for %s: %s", slug, exc)
        try:
            self._invalidate_entity_cache()
            from core.mirror_nudge import nudge_entity_mirror

            nudge_entity_mirror(slug)
        except Exception as exc:
            log.debug("post-rename mirror nudge failed: %s", exc)

    async def _upstream_rename(
        self,
        slug: str,
        canonical_id: str,
        new_name: str,
        supplied: str,
        homeassistant_rename: bool,
        refresh_registry_entities,
    ) -> dict[str, Any]:
        from integrations import get_integration_manager

        upstream: dict[str, Any] = {"attempted": False, "ok": False, "detail": None}
        integration = get_integration_manager().get(slug)
        rename_fn = getattr(integration, "rename_zigbee_device", None) if integration else None
        if not callable(rename_fn):
            return upstream

        upstream["attempted"] = True
        current = supplied or canonical_id
        try:
            result = await rename_fn(
                current,
                new_name,
                device_id=canonical_id,
                homeassistant_rename=homeassistant_rename,
            )
            upstream["ok"] = True
            upstream["detail"] = result if isinstance(result, dict) else None
            log.info("Upstream rename ok for %s: %s -> %s", slug, current, new_name)
            if homeassistant_rename:
                try:
                    registry_refresh = refresh_registry_entities()
                    self._invalidate_entity_cache()
                    upstream["entity_ids"] = registry_refresh
                except Exception as exc:
                    log.warning("entity_id refresh after rename failed: %s", exc)
        except Exception as exc:
            log.warning("Upstream rename failed for %s/%s: %s", slug, current, exc)
            upstream["detail"] = str(exc)
            if supplied and supplied != canonical_id:
                try:
                    result = await rename_fn(
                        canonical_id,
                        new_name,
                        device_id=canonical_id,
                        homeassistant_rename=homeassistant_rename,
                    )
                    upstream["ok"] = True
                    upstream["detail"] = result if isinstance(result, dict) else None
                    log.info("Upstream rename ok on retry for %s: %s -> %s", slug, canonical_id, new_name)
                    if homeassistant_rename:
                        try:
                            registry_refresh = refresh_registry_entities()
                            self._invalidate_entity_cache()
                            upstream["entity_ids"] = registry_refresh
                        except Exception as exc2:
                            log.warning("entity_id refresh after rename retry failed: %s", exc2)
                except Exception as exc2:
                    log.warning("Upstream rename retry failed for %s/%s: %s", slug, canonical_id, exc2)
        return upstream


_device_rename_service: DeviceRenameService | None = None


def get_device_rename_service() -> DeviceRenameService:
    global _device_rename_service
    if _device_rename_service is None:
        _device_rename_service = DeviceRenameService()
    return _device_rename_service
