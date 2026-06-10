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
    from integrations.device_rename import DeviceRenameRequest, get_device_rename_service

    try:
        return await get_device_rename_service().rename(
            slug,
            device_id,
            DeviceRenameRequest(
                name=body.name,
                current_name=body.current_name,
                homeassistant_rename=body.homeassistant_rename,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
