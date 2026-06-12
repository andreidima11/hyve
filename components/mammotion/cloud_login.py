"""Mammotion cloud login — parity with Mammotion-HA ``_async_attempt_login``."""

from __future__ import annotations

import logging
from typing import Any

from components.mammotion.utils import (
    friendly_auth_error,
    mammotion_cache_for_storage,
    mammotion_cache_usable,
)

log = logging.getLogger("mammotion")

# Keys removed when Aliyun/MQTT cache is stale (HA ``EXPIRED_CREDENTIAL_EXCEPTIONS`` path).
STALE_CACHE_KEYS = frozenset(
    {
        "aep_data",
        "auth_data",
        "region_data",
        "session_data",
        "device_data",
        "connect_response",
        "connect_data",
        "mammotion_data",
        "mammotion_mqtt",
        "mammotion_device_records",
        "mammotion_jwt_info",
        "mammotion_device_list",
    }
)

# HA historically stored ``connect_response`` as ``connect_data``.
_LIBRARY_TO_STORAGE_KEY = {"connect_response": "connect_data"}
_STORAGE_TO_LIBRARY_KEY = {v: k for k, v in _LIBRARY_TO_STORAGE_KEY.items()}


def load_cached_credentials(cache: dict[str, Any] | None) -> dict[str, Any]:
    """Return a pymammotion ``restore_credentials`` cache dict, or {}."""
    if not isinstance(cache, dict) or not cache:
        return {}
    library = {_STORAGE_TO_LIBRARY_KEY.get(k, k): v for k, v in cache.items()}
    if not mammotion_cache_usable(library):
        return {}
    return library


def store_cloud_credentials(client: Any) -> dict[str, Any]:
    """Serialize ``client.to_cache()`` for Hyve ``_mammotion_cache`` storage."""
    try:
        raw = client.to_cache()
    except Exception as exc:
        log.warning("mammotion to_cache failed: %s", exc)
        return {}
    safe = mammotion_cache_for_storage(raw)
    if not safe:
        return {}
    return {_LIBRARY_TO_STORAGE_KEY.get(k, k): v for k, v in safe.items()}


def _strip_stale_cache(cache: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in cache.items() if k not in STALE_CACHE_KEYS}


def _expired_credential_exceptions() -> tuple[type[BaseException], ...]:
    from pymammotion.aliyun.exceptions import CheckSessionException
    from pymammotion.http.model.http import UnauthorizedExceptionError
    from pymammotion.transport.base import AuthError, LoginFailedError, ReLoginRequiredError, SessionExpiredError

    return (
        CheckSessionException,
        AuthError,
        UnauthorizedExceptionError,
        LoginFailedError,
        ReLoginRequiredError,
        SessionExpiredError,
    )


async def async_attempt_cloud_login(
    client: Any,
    account: str,
    password: str,
    http_session: Any,
    cache: dict[str, Any] | None,
    *,
    force_fresh: bool = False,
) -> dict[str, Any]:
    """Restore cached credentials or run ``login_and_initiate_cloud`` (HA parity).

    Returns the cache dict to persist (may be empty). Raises ``RuntimeError``
    with a user-facing message when login fails.
    """
    from pymammotion.aliyun.exceptions import TooManyRequestsException
    from pymammotion.transport.base import LoginFailedError

    account_key = (account or "").strip()
    if not account_key or not password:
        raise RuntimeError("Cont Mammotion incomplet — completează e-mail și parola.")

    working_cache = dict(cache or {})
    cached = {} if force_fresh else load_cached_credentials(working_cache)
    expired_types = _expired_credential_exceptions()

    try:
        if cached:
            await client.restore_credentials(
                account_key,
                password,
                cached,
                http_session,
                check_for_new_devices=True,
            )
        else:
            await client.login_and_initiate_cloud(account_key, password, http_session)
        stored = store_cloud_credentials(client)
        if stored:
            working_cache = stored
        return working_cache
    except TooManyRequestsException as exc:
        raise RuntimeError(friendly_auth_error(exc)) from exc
    except LoginFailedError as exc:
        raise RuntimeError(friendly_auth_error(exc)) from exc
    except expired_types as exc:
        log.warning("mammotion stale cloud cache for %s: %s", account_key, exc)
        if cached:
            working_cache = _strip_stale_cache(working_cache)
            try:
                await client.login_and_initiate_cloud(account_key, password, http_session)
                stored = store_cloud_credentials(client)
                if stored:
                    working_cache = stored
                return working_cache
            except LoginFailedError as retry_exc:
                raise RuntimeError(friendly_auth_error(retry_exc)) from retry_exc
            except TooManyRequestsException as retry_exc:
                raise RuntimeError(friendly_auth_error(retry_exc)) from retry_exc
        raise RuntimeError(friendly_auth_error(exc)) from exc
    except Exception as exc:
        if exc.__class__ in expired_types or exc.__class__.__name__ in {
            t.__name__ for t in expired_types
        }:
            raise RuntimeError(friendly_auth_error(exc)) from exc
        raise RuntimeError(str(exc) or "Eroare Mammotion.") from exc


async def async_test_cloud_login(
    client: Any,
    account: str,
    password: str,
    http_session: Any,
    *,
    timeout: float = 120.0,
) -> tuple[bool, str, int]:
    """Config-flow style test: always fresh ``login_and_initiate_cloud``."""
    import asyncio

    from pymammotion.aliyun.exceptions import TooManyRequestsException
    from pymammotion.transport.base import LoginFailedError

    account_key = (account or "").strip()
    try:
        await asyncio.wait_for(
            client.login_and_initiate_cloud(account_key, password, http_session),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        return False, "Autentificare Mammotion — timeout. Încearcă din nou.", 0
    except TooManyRequestsException as exc:
        return False, friendly_auth_error(exc), 0
    except LoginFailedError as exc:
        return False, friendly_auth_error(exc), 0
    except Exception as exc:
        return False, str(exc) or "Eroare Mammotion.", 0

    http_layer = client.mammotion_http
    if http_layer is None or http_layer.login_info is None:
        return False, "Autentificare Mammotion eșuată — verifică contul și parola.", 0

    names = [
        str(getattr(h, "device_name", "") or "").strip()
        for h in client._device_registry.all_devices
        if getattr(h, "device_name", None)
    ]
    names = [n for n in names if n]
    if names:
        return True, f"Autentificare reușită — {len(names)} dispozitive găsite.", len(names)
    return True, "Autentificare reușită, dar nu s-au găsit dispozitive pe cont.", 0
