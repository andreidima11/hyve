"""Bind Hyve aiohttp session to pymammotion account sessions."""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("mammotion")


def resolve_mammotion_http(client: Any, account: str | None = None) -> Any:
    """Return MammotionHTTP for *account*, with fallbacks pymammotion's property misses."""
    if client is None:
        return None
    account_key = (account or "").strip()
    registry = getattr(client, "_account_registry", None)
    if registry is not None and account_key:
        acct = registry.get(account_key)
        if acct is not None:
            http = getattr(acct, "mammotion_http", None)
            if http is not None:
                return http
            cloud_client = getattr(acct, "cloud_client", None)
            if cloud_client is not None:
                cloud_http = getattr(cloud_client, "mammotion_http", None)
                if cloud_http is not None:
                    return cloud_http
    if registry is not None:
        for acct in getattr(registry, "all_sessions", []) or []:
            if account_key and getattr(acct, "account_id", "") != account_key:
                continue
            http = getattr(acct, "mammotion_http", None)
            if http is not None:
                return http
            cloud_client = getattr(acct, "cloud_client", None)
            if cloud_client is not None:
                cloud_http = getattr(cloud_client, "mammotion_http", None)
                if cloud_http is not None:
                    return cloud_http
    return None


async def ensure_account_http(
    client: Any,
    account: str,
    password: str,
    *,
    aiohttp_session: Any = None,
) -> Any:
    """Ensure MammotionHTTP exists and is registered (survives MQTT transport failures)."""
    account_key = (account or "").strip()
    if not account_key or not password:
        return None

    http = resolve_mammotion_http(client, account_key)
    if http is not None:
        if aiohttp_session is not None:
            http._session = aiohttp_session  # noqa: SLF001
        return http

    from pymammotion.account.registry import AccountSession
    from pymammotion.http.http import MammotionHTTP

    from components.mammotion.utils import mammotion_ha_fingerprint

    ha_version = getattr(client, "_ha_version", None) or mammotion_ha_fingerprint()
    http = MammotionHTTP(account_key, password, session=aiohttp_session, ha_version=ha_version)
    login_resp = await http.login_v2(account_key, password)
    if login_resp.code != 0:
        log.warning(
            "mammotion ensure_account_http login failed for %s (code=%s): %s",
            account_key,
            login_resp.code,
            login_resp.msg or "unknown",
        )
        return None

    registry = getattr(client, "_account_registry", None)
    if registry is None:
        return http

    acct = registry.get(account_key)
    if acct is None:
        acct = AccountSession(
            account_id=account_key,
            email=account_key,
            password=password,
            mammotion_http=http,
        )
        await registry.register(acct)
    else:
        acct.mammotion_http = http
        acct.password = password
        if not acct.email:
            acct.email = account_key
    try:
        if not acct.user_account:
            acct.user_account = client._extract_user_account(http)
    except Exception:
        pass
    return http


def bind_http_to_client(client: Any, http: Any, *, account: str | None = None) -> None:
    """Attach the hub's persistent aiohttp session to all MammotionHTTP instances."""
    if client is None or http is None:
        return
    client._hyve_http_session = http  # noqa: SLF001 — read by pymammotion compat patches

    registry = getattr(client, "_account_registry", None)
    if registry is None:
        return
    sessions = [registry.get(account)] if account else list(getattr(registry, "all_sessions", []) or [])
    for acct in sessions:
        if acct is None:
            continue
        mammotion_http = getattr(acct, "mammotion_http", None)
        if mammotion_http is not None:
            mammotion_http._session = http  # noqa: SLF001
        cloud_client = getattr(acct, "cloud_client", None)
        if cloud_client is not None:
            cloud_http = getattr(cloud_client, "mammotion_http", None)
            if cloud_http is not None:
                cloud_http._session = http  # noqa: SLF001
