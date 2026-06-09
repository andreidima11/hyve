from __future__ import annotations

import logging
from typing import Any

import auth
import database
import models
from fastapi import Depends, Header, HTTPException, Query, status
from fastapi.responses import Response

from routers.integrations import helpers
from routers.integrations.models import DeviceControlBody, DeviceRenameBody
from routers.integrations.router import router

log = logging.getLogger("integrations")


def _user_from_media_url_token(
    token: str | None = Query(None, description="Short-lived media auth token or access JWT"),
    authorization: str | None = Header(None),
) -> models.User:
    """Authenticate ``<img>`` proxy URLs (cannot send Authorization header)."""
    raw_token = (token or "").strip()
    if not raw_token and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            raw_token = value.strip()
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.unauthorized"},
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = auth.decode_media_url_token(raw_token)
    if not payload:
        raise credentials_exception
    db = next(database.get_db())
    try:
        jti = payload.get("jti")
        if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
            raise credentials_exception
        user = db.query(models.User).filter(models.User.username == payload.get("sub")).first()
        if user is None or not user.is_active:
            raise credentials_exception
        return user
    finally:
        db.close()


@router.get("/device-image")
async def z2m_device_image(
    model: str = Query("", description="Z2M device model (e.g. TS0003_switch_module_2)"),
    user: models.User = Depends(_user_from_media_url_token),
):
    """Proxy zigbee2mqtt.io device images (Hyve CSP allows only same-origin img)."""
    from integrations.z2m_images import fetch_device_image_bytes

    slug = (model or "").strip()
    if not slug:
        raise HTTPException(status_code=400, detail="model is required")
    item = await fetch_device_image_bytes(slug)
    if not item:
        raise HTTPException(status_code=404, detail="image not found")
    body, content_type = item
    return Response(
        content=body,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/{slug}/devices/registry")
async def list_device_registry(slug: str, user: models.User = Depends(auth.get_current_user)):
    from core import device_registry

    slug = (slug or "").strip()
    if not slug:
        raise HTTPException(status_code=400, detail="slug is required")
    return {
        "slug": slug,
        "devices": device_registry.all_entries(source=slug),
        "total": len(device_registry.all_entries(source=slug)),
    }


@router.get("/{slug}/devices")
async def list_integration_devices(slug: str, user: models.User = Depends(auth.get_current_user)):
    from integrations import device_aliases
    from integrations.source_aliases import (
        device_config_slugs_for_entity_source,
        entity_matches_integration,
        entity_sources_for_integration,
    )

    slug = (slug or "").strip()
    if not slug:
        raise HTTPException(status_code=400, detail="slug is required")

    entities = [e for e in await helpers.all_entities() if entity_matches_integration(str(e.get("source") or ""), slug)]
    applied: set[str] = set()
    for src in entity_sources_for_integration(slug):
        for config_slug in device_config_slugs_for_entity_source(src):
            if config_slug in applied:
                continue
            applied.add(config_slug)
            try:
                from core import device_registry

                device_registry.apply_to_entities(config_slug, entities)
            except Exception as exc:
                log.warning("device registry apply failed for %s: %s", config_slug, exc)
            device_aliases.apply_to_entities(config_slug, entities)
    devices = helpers.group_entities_into_devices(entities, integration_slug=slug)
    try:
        from integrations.z2m_images import attach_device_images

        attach_device_images(devices, slug=slug)
    except Exception as exc:
        log.debug("device image urls skipped: %s", exc)
    return {"slug": slug, "devices": devices, "total": len(devices)}


@router.post("/{slug}/control")
async def control_integration_entity(
    slug: str,
    body: DeviceControlBody,
    user: models.User = Depends(auth.get_current_user),
):
    from core.device_control import ControlTargetNotFound, control_entity

    raw_id = body.entity_id.strip()
    try:
        result = await control_entity(
            raw_id,
            body.action.strip(),
            body.data or {},
            slug_hint=slug,
        )
    except ControlTargetNotFound:
        raise HTTPException(status_code=404, detail=f"Integration '{slug}' not found")
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("Control failed for %s/%s", slug, body.entity_id)
        raise HTTPException(status_code=500, detail=str(exc))

    return {"status": "ok", "result": result}


@router.post("/{slug}/device/{device_id}/rename")
async def rename_integration_device(
    slug: str,
    device_id: str,
    body: DeviceRenameBody,
    user: models.User = Depends(auth.get_current_admin),
):
    from integrations import device_aliases, get_integration_manager

    slug = (slug or "").strip()
    device_id = (device_id or "").strip()
    new_name = (body.name or "").strip()
    if not slug or not device_id or not new_name:
        raise HTTPException(status_code=400, detail="slug, device_id and name are required")

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
        raise HTTPException(status_code=500, detail=f"Failed to save alias: {exc}")

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

    supplied = (body.current_name or "").strip()
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
        helpers.invalidate_all_entities_cache()
    except Exception as exc:
        log.warning("entity registry refresh after rename failed: %s", exc)

    old_names_for_purge = [
        str(v).strip()
        for v in old_name_candidates
        if v and str(v).strip() and str(v).strip().lower() != new_name.lower()
    ]

    def _purge_bridge_discovery() -> int:
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

    async def _resync_after_rename() -> None:
        try:
            from addons.entity_store import get_entity_store

            store = get_entity_store()
            for inst in get_integration_manager().entries_for(slug):
                if not inst.supports_sync:
                    continue
                key = inst.store_key
                if not store.get_fetcher(key):
                    helpers.register_instance_fetcher(store, inst)
                await store.do_sync(key, force=True)
        except Exception as exc:
            log.warning("post-rename sync failed for %s: %s", slug, exc)
        try:
            helpers.invalidate_all_entities_cache()
            from core.mirror_nudge import nudge_entity_mirror

            nudge_entity_mirror(slug)
        except Exception as exc:
            log.debug("post-rename mirror nudge failed: %s", exc)

    upstream = {"attempted": False, "ok": False, "detail": None}
    integration = get_integration_manager().get(slug)
    rename_fn = getattr(integration, "rename_zigbee_device", None) if integration else None
    if callable(rename_fn):
        upstream["attempted"] = True
        supplied = (body.current_name or "").strip()
        current = supplied or canonical_id
        try:
            result = await rename_fn(
                current,
                new_name,
                device_id=canonical_id,
                homeassistant_rename=body.homeassistant_rename,
            )
            upstream["ok"] = True
            upstream["detail"] = result if isinstance(result, dict) else None
            log.info("Upstream rename ok for %s: %s -> %s", slug, current, new_name)
            if body.homeassistant_rename:
                try:
                    registry_refresh = _refresh_registry_entities()
                    helpers.invalidate_all_entities_cache()
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
                        homeassistant_rename=body.homeassistant_rename,
                    )
                    upstream["ok"] = True
                    upstream["detail"] = result if isinstance(result, dict) else None
                    log.info("Upstream rename ok on retry for %s: %s -> %s", slug, canonical_id, new_name)
                    if body.homeassistant_rename:
                        try:
                            registry_refresh = _refresh_registry_entities()
                            helpers.invalidate_all_entities_cache()
                            upstream["entity_ids"] = registry_refresh
                        except Exception as exc:
                            log.warning("entity_id refresh after rename retry failed: %s", exc)
                except Exception as exc2:
                    log.warning("Upstream rename retry failed for %s/%s: %s", slug, canonical_id, exc2)

    purged_discovery = _purge_bridge_discovery()
    await _resync_after_rename()

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
