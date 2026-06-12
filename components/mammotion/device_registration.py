"""Post-login Mammotion device registration (MQTT / Aliyun bootstrap)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from components.mammotion.session_binding import resolve_mammotion_http

log = logging.getLogger("mammotion")

_POST_LOGIN_WAIT_SECONDS = 5.0


def _registry_device_names(client: Any) -> list[str]:
    names: list[str] = []
    for handle in client._device_registry.all_devices:
        name = str(getattr(handle, "device_name", "") or "").strip()
        if name:
            names.append(name)
    return names


async def ensure_mqtt_transports(
    client: Any,
    account: str,
    *,
    password: str | None = None,
    aiohttp_session: Any = None,
    for_control: bool = False,
) -> bool:
    """Soft-reconnect Mammotion/Aliyun MQTT without tearing down the whole session."""
    from components.mammotion.session_bootstrap import (
        any_pymammotion_handle_rate_limited,
        clear_pymammotion_rate_limit_for_command,
        mqtt_transport_connected,
    )
    from pymammotion.transport.base import TransportType

    names = _registry_device_names(client)
    if not names:
        await complete_device_registration(
            client,
            account,
            password=password,
            aiohttp_session=aiohttp_session,
        )
        names = _registry_device_names(client)
    if not names:
        return False
    if any(mqtt_transport_connected(client, name) for name in names):
        return True
    if for_control:
        for device_name in names:
            clear_pymammotion_rate_limit_for_command(client, device_name)
    elif any_pymammotion_handle_rate_limited(client, names):
        log.debug("mammotion skip MQTT reconnect — cloud rate limit backoff")
        return False

    acct = client._account_registry.get(account) if getattr(client, "_account_registry", None) else None
    if acct is not None:
        mammotion_t = getattr(acct, "mammotion_transport", None)
        if mammotion_t is not None and not getattr(mammotion_t, "is_connected", False):
            try:
                await mammotion_t.connect()
            except Exception as exc:
                log.debug("mammotion transport reconnect failed: %s", exc)
        aliyun_t = getattr(acct, "aliyun_transport", None)
        if aliyun_t is not None and not getattr(aliyun_t, "is_connected", False):
            try:
                await aliyun_t.connect()
            except Exception as exc:
                log.debug("aliyun transport reconnect failed: %s", exc)

    for device_name in names:
        handle = client.mower(device_name)
        if handle is None:
            continue
        for transport_type in (TransportType.CLOUD_ALIYUN, TransportType.CLOUD_MAMMOTION):
            if not handle.has_transport(transport_type):
                continue
            if handle.is_transport_connected(transport_type):
                continue
            try:
                await handle.connect_transport(transport_type)
            except Exception as exc:
                log.debug("mammotion %s reconnect %s: %s", device_name, transport_type.value, exc)

    deadline = time.monotonic() + 8.0
    while time.monotonic() < deadline:
        if any(mqtt_transport_connected(client, name) for name in names):
            return True
        await asyncio.sleep(1.0)

    return any(mqtt_transport_connected(client, name) for name in names)


async def complete_device_registration(
    client: Any,
    account: str,
    *,
    password: str | None = None,
    aiohttp_session: Any = None,
) -> None:
    """Register devices when PyPI login skipped Aliyun/MQTT bootstrap (owned-only accounts)."""
    if _registry_device_names(client):
        await ensure_mqtt_transports(
            client,
            account,
            password=password,
            aiohttp_session=aiohttp_session,
        )
        return

    from components.mammotion.session_binding import ensure_account_http

    http = resolve_mammotion_http(client, account)
    if http is None and password:
        http = await ensure_account_http(client, account, password, aiohttp_session=aiohttp_session)
    if http is None:
        log.warning(
            "mammotion: HTTP session unavailable after login (account=%s, sessions=%s) — "
            "check credentials or wait if Mammotion rate-limited the account",
            account,
            len(getattr(getattr(client, "_account_registry", None), "all_sessions", []) or []),
        )
        return

    try:
        await http.fetch_authorization_token()
    except Exception as exc:
        log.debug("mammotion fetch_authorization_token: %s", exc)

    owned = list((await http.get_user_device_list()).data or [])
    page_resp = await http.get_user_device_page()
    records = list((page_resp.data.records if page_resp.data else []) or [])
    log.info(
        "mammotion post-login discovery account=%s owned=%d page_records=%d registry=%d",
        account,
        len(owned),
        len(records),
        len(client._device_registry.all_devices),
    )

    acct = client._account_registry.get(account)
    if acct is None:
        if password:
            await ensure_account_http(client, account, password, aiohttp_session=aiohttp_session)
            acct = client._account_registry.get(account)
    if acct is None:
        log.warning("mammotion: no account session for %s — cannot register devices", account)
        return
    if not acct.user_account:
        acct.user_account = client._extract_user_account(http)

    owned_map = {
        d.device_name: d.iot_id for d in owned if getattr(d, "device_name", None) and getattr(d, "iot_id", None)
    }
    registered = {h.device_name for h in client._device_registry.all_devices}

    missing_mqtt = [r for r in records if r.device_name and r.device_name not in registered]
    if missing_mqtt:
        await _bootstrap_mqtt_devices(client, account, acct, http, missing_mqtt, owned_map)

    if owned and not client._device_registry.all_devices:
        await _bootstrap_aliyun_owned(client, account, acct, http, owned_map)

    if client._device_registry.all_devices:
        await asyncio.sleep(_POST_LOGIN_WAIT_SECONDS)


async def _bootstrap_mqtt_devices(
    client: Any,
    account: str,
    acct: Any,
    http: Any,
    records: list[Any],
    owned_map: dict[str, str],
) -> None:
    from pymammotion.auth.token_manager import TokenManager

    try:
        await http.get_mqtt_credentials()
    except Exception as exc:
        log.warning("mammotion get_mqtt_credentials failed: %s", exc)
        return
    if http.mqtt_credentials is None:
        log.warning("mammotion: MQTT credentials missing — cannot register post-2025 devices")
        return

    if acct.token_manager is None:
        acct.token_manager = TokenManager(account, http)
    if acct.mammotion_transport is None:
        acct.mammotion_transport = client._setup_mammotion_transport(
            http.mqtt_credentials, http, acct, acct.token_manager
        )

    ua = int(acct.user_account or 0)
    for record in records:
        if record.device_name in {h.device_name for h in client._device_registry.all_devices}:
            continue
        iot_override = owned_map.get(record.device_name, "")
        await client._register_mammotion_device(record, acct.mammotion_transport, ua, iot_override)
        acct.device_ids.add(record.device_name)
    try:
        await acct.mammotion_transport.connect()
    except Exception as exc:
        log.warning("mammotion MQTT connect failed (devices may still appear): %s", exc)


async def _bootstrap_aliyun_owned(
    client: Any,
    account: str,
    acct: Any,
    http: Any,
    owned_map: dict[str, str],
) -> None:
    from pymammotion.aliyun.cloud_gateway import CloudIOTGateway
    from pymammotion.auth.token_manager import TokenManager

    try:
        cloud_client = CloudIOTGateway(http)
        await client._connect_iot(cloud_client)
        if cloud_client.aep_response is None or cloud_client.region_response is None:
            log.warning("mammotion aliyun bootstrap incomplete (region/aep missing)")
            return
        if cloud_client.session_by_authcode_response.data is None:
            log.warning("mammotion aliyun bootstrap incomplete (session missing)")
            return

        acct.cloud_client = cloud_client
        if acct.token_manager is None:
            acct.token_manager = TokenManager(account, http, cloud_client)
        al_transport = client._setup_aliyun_transport(cloud_client, acct)
        acct.aliyun_transport = al_transport
        ua = int(acct.user_account or 0)
        devices = cloud_client.devices_by_account_response.data.data if cloud_client.devices_by_account_response else []
        for device in devices or []:
            if not device.device_name:
                continue
            if device.device_name in {h.device_name for h in client._device_registry.all_devices}:
                continue
            iot_id = owned_map.get(device.device_name) or device.iot_id
            await client._register_aliyun_device(device.device_name, iot_id, al_transport, ua, device.product_key)
            acct.device_ids.add(device.device_name)
        await al_transport.connect()
    except Exception as exc:
        log.warning("mammotion aliyun owned bootstrap failed: %s", exc)


async def list_http_device_names(
    client: Any,
    account: str | None = None,
    *,
    password: str | None = None,
    aiohttp_session: Any = None,
) -> list[str]:
    """Return device names from Mammotion HTTP APIs (fallback when registry is empty)."""
    http = resolve_mammotion_http(client, account)
    if http is None and password and account:
        from components.mammotion.session_binding import ensure_account_http

        http = await ensure_account_http(client, account, password, aiohttp_session=aiohttp_session)
    if http is None:
        return []
    try:
        await http.fetch_authorization_token()
    except Exception:
        pass
    names: list[str] = []
    seen: set[str] = set()
    try:
        owned = (await http.get_user_device_list()).data or []
        for row in owned:
            name = str(getattr(row, "device_name", "") or "").strip()
            if name and name not in seen:
                seen.add(name)
                names.append(name)
    except Exception as exc:
        log.warning("mammotion get_user_device_list failed: %s", exc)
    try:
        page = await http.get_user_device_page()
        for row in (page.data.records if page.data else []) or []:
            name = str(getattr(row, "device_name", "") or "").strip()
            if name and name not in seen:
                seen.add(name)
                names.append(name)
    except Exception as exc:
        log.warning("mammotion get_user_device_page failed: %s", exc)
    return names
