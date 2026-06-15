"""Mammotion lawn mower camera — Agora WebRTC token + device wake (HA parity)."""

from __future__ import annotations

import logging
import time
from typing import Any

log = logging.getLogger("mammotion.camera")

_STREAM_TOKEN_TTL = 300.0


def _token_payload(subscription: Any) -> dict[str, Any]:
    if subscription is None:
        raise ValueError("Cloud Mammotion nu a returnat token video — încearcă din nou.")
    data = getattr(subscription, "data", None)
    if data is None:
        raise ValueError("Cloud Mammotion nu a returnat token video — încearcă din nou.")
    if hasattr(data, "to_dict"):
        payload = data.to_dict()
    elif isinstance(data, dict):
        payload = dict(data)
    else:
        payload = {
            "appid": getattr(data, "appid", "") or getattr(data, "appId", ""),
            "channelName": getattr(data, "channelName", "") or getattr(data, "channel_name", ""),
            "token": getattr(data, "token", ""),
            "uid": getattr(data, "uid", 0),
        }
    if payload.get("appId") and not payload.get("appid"):
        payload["appid"] = payload["appId"]
    if payload.get("channel_name") and not payload.get("channelName"):
        payload["channelName"] = payload["channel_name"]
    for key in ("appid", "channelName", "token"):
        if not str(payload.get(key) or "").strip():
            raise ValueError("Token video incomplet — apasă Sync la integrare și reîncearcă.")
    return payload


async def _ensure_cloud_http(hub: Any) -> Any:
    """Ensure Mammotion cloud HTTP login — Agora tokens do not require MQTT."""
    if not hub.account or not hub.password:
        raise ValueError("Cont Mammotion incomplet — completează e-mail și parola.")
    async with hub._lock:
        client = hub._ensure_client()
        http = await hub._ensure_http()
        from components.mammotion.session_binding import bind_http_to_client, ensure_account_http, resolve_mammotion_http

        bind_http_to_client(client, http, account=hub.account)
        try:
            if not hub._session_active():
                from components.mammotion.cloud_login import async_attempt_cloud_login

                hub._cache = await async_attempt_cloud_login(
                    client,
                    hub.account,
                    hub.password,
                    http,
                    hub._cache or {},
                )
                if hub._cache and hub._persist_cache:
                    hub._persist_cache(hub._cache)
            else:
                layer = await ensure_account_http(
                    client,
                    hub.account,
                    hub.password,
                    aiohttp_session=http,
                )
                if layer is None:
                    raise ValueError("Autentificare Mammotion eșuată — apasă Sync.")
        except RuntimeError as exc:
            raise ValueError(str(exc) or "Autentificare Mammotion eșuată.") from exc
        if resolve_mammotion_http(client, hub.account) is None:
            raise ValueError("Cloud Mammotion indisponibil — apasă Sync la integrare.")
        return client


def _slugify_device_name(name: str) -> str:
    from components.mammotion.control import _slugify_device_name as slugify

    return slugify(name)


def _names_match(left: str, right: str) -> bool:
    a = str(left or "").strip()
    b = str(right or "").strip()
    if not a or not b:
        return False
    if a == b or a.lower() == b.lower():
        return True
    return _slugify_device_name(a) == _slugify_device_name(b)


def _match_registry_device_name(hub: Any, hint: str) -> str | None:
    needle = str(hint or "").strip()
    if not needle:
        return None
    names = hub._iter_device_names()
    if needle in names:
        return needle
    for name in names:
        if _names_match(name, needle):
            return name
    return None


def _resolve_camera_device_name(hub: Any, ent: dict[str, Any]) -> str:
    """Map a camera entity to the cloud device name used by pymammotion."""
    from components.mammotion.control import parse_target_id

    names = hub._iter_device_names()
    entity_id = str(ent.get("entity_id") or "").strip()
    if entity_id:
        try:
            device_name, _, _ = parse_target_id(entity_id, known_devices=names)
            matched = _match_registry_device_name(hub, device_name)
            if matched:
                return matched
            if device_name:
                return device_name
        except ValueError:
            pass

    unique_id = str(ent.get("unique_id") or "").strip()
    if unique_id.startswith("mammotion:"):
        parts = unique_id.split(":")
        if len(parts) >= 2:
            matched = _match_registry_device_name(hub, parts[1])
            if matched:
                return matched

    attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
    for candidate in (
        attrs.get("device_name"),
        attrs.get("model_name"),
        ent.get("device_name"),
    ):
        matched = _match_registry_device_name(hub, str(candidate or ""))
        if matched:
            return matched

    if unique_id.startswith("mammotion:"):
        parts = unique_id.split(":")
        if len(parts) >= 2 and parts[1].strip():
            return parts[1].strip()

    fallback = _mammotion_camera_device_name(ent)
    matched = _match_registry_device_name(hub, fallback)
    return matched or fallback


def _iot_id_from_registry(hub: Any, device_name: str) -> tuple[str, str]:
    client = hub._ensure_client()
    registry = getattr(client, "_device_registry", None)
    if registry is None:
        return device_name, ""
    handle = registry.get_by_name(device_name)
    if handle is None:
        for name in hub._iter_device_names():
            if _names_match(name, device_name):
                handle = registry.get_by_name(name)
                if handle is not None:
                    device_name = name
                    break
    if handle is None:
        return device_name, ""
    iot_id = str(getattr(handle, "iot_id", "") or "").strip()
    canonical = str(getattr(handle, "device_name", "") or device_name).strip() or device_name
    return canonical, iot_id


async def _lookup_iot_id_http(hub: Any, device_name: str) -> tuple[str, str]:
    from components.mammotion.session_binding import resolve_mammotion_http

    mammotion_http = resolve_mammotion_http(hub._ensure_client(), hub.account)
    if mammotion_http is None:
        return device_name, ""
    try:
        await mammotion_http.fetch_authorization_token()
    except Exception as exc:
        log.debug("mammotion camera fetch_authorization_token: %s", exc)

    rows: list[Any] = []
    try:
        rows.extend(list((await mammotion_http.get_user_device_list()).data or []))
    except Exception as exc:
        log.debug("mammotion camera get_user_device_list: %s", exc)
    try:
        page = await mammotion_http.get_user_device_page()
        rows.extend(list((page.data.records if page.data else []) or []))
    except Exception as exc:
        log.debug("mammotion camera get_user_device_page: %s", exc)

    for row in rows:
        row_name = str(getattr(row, "device_name", "") or "").strip()
        if not row_name or not _names_match(row_name, device_name):
            continue
        iot_id = str(getattr(row, "iot_id", "") or "").strip()
        if iot_id:
            return row_name, iot_id
    return device_name, ""


async def _resolve_device_ref(hub: Any, device_name: str) -> tuple[str, str]:
    """Return ``(canonical_device_name, iot_id)`` using registry first, then cloud HTTP."""
    canonical, iot_id = _iot_id_from_registry(hub, device_name)
    if iot_id:
        return canonical, iot_id

    canonical, iot_id = await _lookup_iot_id_http(hub, canonical or device_name)
    if iot_id:
        return canonical, iot_id

    known = ", ".join(hub._iter_device_names()) or "—"
    raise ValueError(
        f"Nu am găsit dispozitivul {device_name} în contul Mammotion. "
        f"Robot cunoscut în sesiune: {known}."
    )


def _mammotion_camera_device_name(ent: dict[str, Any]) -> str:
    attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
    device_name = str(attrs.get("device_name") or "").strip()
    if device_name:
        return device_name
    uid = str(ent.get("unique_id") or "")
    parts = uid.split(":")
    if len(parts) >= 2 and parts[0] == "mammotion":
        return parts[1].strip()
    eid = str(ent.get("entity_id") or "")
    if eid.startswith("camera.") and eid.endswith("_webrtc"):
        slug = eid[len("camera.") : -len("_webrtc")]
        if slug:
            return slug.replace("_", "-")
    return ""


def _resolve_mammotion_integration(ent: dict[str, Any], device_name: str) -> Any:
    from integrations import get_integration_manager

    manager = get_integration_manager()
    entry_id = str(ent.get("entry_id") or "").strip()
    if entry_id:
        inst = manager.get_by_entry(entry_id)
        if inst is not None:
            return inst
    candidates = manager.entries_for("mammotion")
    entity_id = str(ent.get("entity_id") or "").strip()
    if entity_id and candidates:
        from components.mammotion.control import parse_target_id

        for inst in candidates:
            session = getattr(inst, "_session", None)
            hub = getattr(session, "_hub", None)
            if hub is None:
                continue
            names = hub._iter_device_names()
            try:
                parsed_name, _, _ = parse_target_id(entity_id, known_devices=names)
            except ValueError:
                parsed_name = ""
            if parsed_name and parsed_name in names:
                return inst
    if device_name and candidates:
        for inst in candidates:
            session = getattr(inst, "_session", None)
            hub = getattr(session, "_hub", None)
            if hub is None:
                continue
            if _match_registry_device_name(hub, device_name):
                return inst
            coordinators = getattr(hub, "_coordinators", {})
            if device_name in coordinators:
                return inst
    if len(candidates) == 1:
        return candidates[0]
    return None


def is_mammotion_webrtc_camera(ent: dict[str, Any]) -> bool:
    if str(ent.get("source") or "").strip().lower() != "mammotion":
        return False
    attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
    if str(attrs.get("mammotion_key") or "") == "webrtc":
        return True
    if str(attrs.get("stream_type") or "") == "agora_webrtc":
        return True
    eid = str(ent.get("entity_id") or "")
    return eid.endswith("_webrtc")


async def mammotion_hub_for_camera_entity(ent: dict[str, Any]) -> tuple[Any, str]:
    """Return ``(hub, device_name)`` for a Mammotion ``camera.*_webrtc`` entity."""
    source = str(ent.get("source") or "").lower()
    if source != "mammotion":
        raise ValueError("Entitatea nu este o cameră Mammotion.")
    attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
    key = str(attrs.get("mammotion_key") or "")
    stream_type = str(attrs.get("stream_type") or "")
    eid = str(ent.get("entity_id") or "")
    is_webrtc = (
        key == "webrtc"
        or stream_type == "agora_webrtc"
        or eid.endswith("_webrtc")
    )
    if not is_webrtc:
        raise ValueError("Entitatea nu este camera WebRTC Mammotion.")
    hint = _mammotion_camera_device_name(ent)
    inst = _resolve_mammotion_integration(ent, hint)
    if inst is None:
        raise ValueError("Integrarea Mammotion nu este activă — apasă Sync.")
    session = await inst._get_session()
    hub = session._hub
    device_name = _resolve_camera_device_name(hub, ent)
    if not device_name:
        raise ValueError("Lipsește numele dispozitivului Mammotion.")
    return hub, device_name


async def refresh_mammotion_stream_tokens(hub: Any, device_name: str, *, force: bool = False) -> dict[str, Any]:
    """Fetch (or reuse cached) Agora stream subscription tokens."""
    cache = hub._stream_cache.setdefault(device_name, {})
    now = time.monotonic()
    cached = cache.get("payload")
    fetched_at = float(cache.get("fetched_at") or 0.0)
    if not force and cached and (now - fetched_at) < _STREAM_TOKEN_TTL:
        return dict(cached)

    client = await _ensure_cloud_http(hub)
    canonical_name, iot_id = await _resolve_device_ref(hub, device_name)
    await _try_mqtt_camera_prep(hub, canonical_name)

    try:
        subscription = await client.get_stream_subscription(canonical_name, iot_id)
    except Exception as exc:
        log.warning("mammotion get_stream_subscription for %s failed: %s", canonical_name, exc)
        raise ValueError(f"Token video eșuat: {exc}") from exc
    payload = _token_payload(subscription)
    cache["payload"] = payload
    cache["fetched_at"] = now
    return payload


async def _try_mqtt_camera_prep(hub: Any, device_name: str) -> None:
    """Best-effort encoder wake via MQTT — skipped when the control path is down."""
    from components.mammotion.session_bootstrap import control_path_ready

    try:
        client = hub._ensure_client()
        if not control_path_ready(client, device_name):
            log.debug("mammotion camera mqtt prep skipped — control path down for %s", device_name)
            return
        coord = hub._coordinator_for(device_name)
        try:
            await coord._send("send_todev_ble_sync", sync_type=3)
        except Exception as exc:
            log.debug("mammotion camera ble sync skipped for %s: %s", device_name, exc)
    except Exception as exc:
        log.debug("mammotion camera mqtt prep for %s: %s", device_name, exc)


async def keepalive_mammotion_camera(hub: Any, device_name: str) -> dict[str, Any]:
    """Keep the mower encoder awake and return a fresh Agora token (viewer keepalive)."""
    await _ensure_cloud_http(hub)
    canonical_name, _iot_id = await _resolve_device_ref(hub, device_name)
    await _try_mqtt_camera_wake(hub, canonical_name)
    return await refresh_mammotion_stream_tokens(hub, canonical_name, force=True)


async def start_mammotion_camera(hub: Any, device_name: str) -> dict[str, Any]:
    """Wake the mower encoder (when MQTT is up) and return fresh Agora tokens."""
    import asyncio

    await _ensure_cloud_http(hub)
    canonical_name, _iot_id = await _resolve_device_ref(hub, device_name)
    await _try_mqtt_camera_wake(hub, canonical_name)
    # Give the robot time to enter the Agora channel as publisher before the browser joins.
    await asyncio.sleep(1.5)
    return await refresh_mammotion_stream_tokens(hub, canonical_name, force=True)


async def _try_mqtt_camera_wake(hub: Any, device_name: str) -> None:
    from components.mammotion.session_bootstrap import control_path_ready

    try:
        client = hub._ensure_client()
        if not control_path_ready(client, device_name):
            log.debug("mammotion camera wake skipped — control path down for %s", device_name)
            return
        coord = hub._coordinator_for(device_name)
        try:
            await coord._send("send_todev_ble_sync", sync_type=3)
        except Exception as exc:
            log.debug("mammotion camera ble sync before start for %s: %s", device_name, exc)
        try:
            await coord._send("device_agora_join_channel_with_position", enter_state=1)
        except Exception as exc:
            log.debug("mammotion camera join channel for %s: %s", device_name, exc)
    except Exception as exc:
        log.debug("mammotion camera wake for %s: %s", device_name, exc)


async def stop_mammotion_camera(hub: Any, device_name: str) -> None:
    """Ask the device to leave the Agora channel (best-effort)."""
    try:
        canonical_name, _ = await _resolve_device_ref(hub, device_name)
    except ValueError:
        canonical_name = device_name
    try:
        from components.mammotion.session_bootstrap import control_path_ready

        client = hub._ensure_client()
        if control_path_ready(client, canonical_name):
            coord = hub._coordinator_for(canonical_name)
            await coord._send("device_agora_join_channel_with_position", enter_state=0)
    except Exception as exc:
        log.debug("mammotion camera stop for %s: %s", canonical_name, exc)
    hub._stream_cache.pop(device_name, None)
    hub._stream_cache.pop(canonical_name, None)


def invalidate_mammotion_stream_cache(hub: Any, device_name: str) -> None:
    """Drop cached Agora tokens so the next viewer gets a fresh uid."""
    hub._stream_cache.pop(device_name, None)
