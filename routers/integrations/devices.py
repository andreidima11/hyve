from __future__ import annotations

import logging

import auth
import models
from fastapi import Depends, HTTPException

from routers.integrations import helpers
from routers.integrations.models import DeviceControlBody, DeviceRenameBody
from routers.integrations.router import router

log = logging.getLogger("integrations")


@router.get("/{slug}/devices")
async def list_integration_devices(slug: str, user: models.User = Depends(auth.get_current_user)):
    from integrations import device_aliases
    from integrations.source_aliases import entity_matches_integration, entity_sources_for_integration

    slug = (slug or "").strip()
    if not slug:
        raise HTTPException(status_code=400, detail="slug is required")

    entities = [e for e in await helpers.all_entities() if entity_matches_integration(str(e.get("source") or ""), slug)]
    for src in entity_sources_for_integration(slug):
        device_aliases.apply_to_entities(src, entities)
    devices = helpers.group_entities_into_devices(entities)
    return {"slug": slug, "devices": devices, "total": len(devices)}


@router.post("/{slug}/control")
async def control_integration_entity(
    slug: str,
    body: DeviceControlBody,
    user: models.User = Depends(auth.get_current_admin),
):
    from integrations import get_integration_manager

    manager = get_integration_manager()
    integration = manager.get(slug)

    raw_id = body.entity_id.strip()
    target_id = raw_id
    target_entry_id = ""
    target_source = ""
    try:
        for entity in await helpers.all_entities():
            if entity.get("entity_id") == raw_id or entity.get("unique_id") == raw_id:
                target_id = str(entity.get("unique_id") or raw_id)
                target_entry_id = str(entity.get("entry_id") or "")
                target_source = str(entity.get("source") or "")
                break
    except Exception:
        pass

    if target_entry_id:
        integration = manager.get_by_entry(target_entry_id) or integration
    if integration is None and target_source:
        integration = manager.get(target_source)

    if not integration:
        raise HTTPException(status_code=404, detail=f"Integration '{slug}' not found")

    try:
        result = await integration.control_entity(
            target_id, body.action.strip(), body.data or {}
        )
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("Control failed for %s/%s", slug, body.entity_id)
        raise HTTPException(status_code=500, detail=str(exc))

    try:
        from brain.pattern_detector import record_manual_control

        record_manual_control(raw_id, body.action.strip(), source="user")
    except Exception:
        pass

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

    try:
        device_aliases.set_alias(slug, canonical_id, new_name)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save alias: {exc}")

    upstream = {"attempted": False, "ok": False, "detail": None}
    integration = get_integration_manager().get(slug)
    rename_fn = getattr(integration, "rename_zigbee_device", None) if integration else None
    if callable(rename_fn):
        upstream["attempted"] = True
        supplied = (body.current_name or "").strip()
        current = supplied or canonical_id
        try:
            result = await rename_fn(current, new_name)
            upstream["ok"] = True
            upstream["detail"] = result if isinstance(result, dict) else None
            log.info("Upstream rename ok for %s: %s -> %s", slug, current, new_name)
        except Exception as exc:
            log.warning("Upstream rename failed for %s/%s: %s", slug, current, exc)
            upstream["detail"] = str(exc)
            if supplied and supplied != canonical_id:
                try:
                    result = await rename_fn(canonical_id, new_name)
                    upstream["ok"] = True
                    upstream["detail"] = result if isinstance(result, dict) else None
                    log.info("Upstream rename ok on retry for %s: %s -> %s", slug, canonical_id, new_name)
                except Exception as exc2:
                    log.warning("Upstream rename retry failed for %s/%s: %s", slug, canonical_id, exc2)

    return {
        "status": "ok",
        "slug": slug,
        "device_id": canonical_id,
        "name": new_name,
        "upstream": upstream,
    }
