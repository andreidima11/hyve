"""Command transport — parity with Mammotion-HA ``async_send_command`` / ``async_send_and_wait``."""

from __future__ import annotations

import logging
from typing import Any

from components.mammotion.session_bootstrap import (
    RATE_LIMIT_USER_MESSAGE,
    clear_pymammotion_rate_limit_for_command,
    device_handle_online,
    prepare_device_for_command,
)
from components.mammotion.utils import is_rate_limited_error

log = logging.getLogger("mammotion.commands")

_COMMAND_FAILED = "Comanda nu a putut fi trimisă — verifică conexiunea MQTT."
_OFFLINE = "Robotul este offline în cloud — verifică în app Mammotion."


def _mark_device_offline(client: Any, device_name: str) -> None:
    device = client.get_device_by_name(device_name)
    if device is not None:
        device.online = False


async def async_send_command(
    client: Any,
    device_name: str,
    command: str,
    *,
    bluetooth_enabled: bool = True,
    **kwargs: Any,
) -> None:
    """Send via ``send_command_with_args`` like HA ``MammotionReportUpdateCoordinator.async_send_command``."""
    clear_pymammotion_rate_limit_for_command(client, device_name)
    prepare_device_for_command(client, device_name)
    if client.get_device_by_name(device_name) is None or not device_handle_online(client, device_name):
        raise ValueError(_OFFLINE)

    from pymammotion.transport.base import NoTransportAvailableError

    try:
        await client.send_command_with_args(
            device_name,
            command,
            prefer_ble=kwargs.pop("prefer_ble", bluetooth_enabled),
            **kwargs,
        )
    except NoTransportAvailableError as exc:
        log.debug("No transport for %s command %s: %s", device_name, command, exc)
        raise ValueError(_COMMAND_FAILED) from exc
    except Exception as exc:
        if is_rate_limited_error(exc):
            from components.mammotion.session_bootstrap import mark_client_rate_limited

            mark_client_rate_limited(client, seconds=90.0)
            raise ValueError(RATE_LIMIT_USER_MESSAGE) from exc
        raise


async def async_send_and_wait(
    client: Any,
    device_name: str,
    command: str,
    expected_field: str,
    *,
    bluetooth_enabled: bool = True,
    send_timeout: float = 5.0,
    **kwargs: Any,
) -> Any:
    """Send and wait like HA ``async_send_and_wait`` (uses ``send_raw``, not the offline skip gate)."""
    clear_pymammotion_rate_limit_for_command(client, device_name)
    prepare_device_for_command(client, device_name)
    if client.get_device_by_name(device_name) is None or not device_handle_online(client, device_name):
        raise ValueError(_OFFLINE)

    from pymammotion.aliyun.exceptions import DeviceOfflineException, GatewayTimeoutException
    from pymammotion.transport.base import CommandTimeoutError, ConcurrentRequestError, NoTransportAvailableError

    try:
        return await client.send_command_and_wait(
            device_name,
            command,
            expected_field,
            send_timeout=send_timeout,
            **kwargs,
        )
    except NoTransportAvailableError as exc:
        log.debug("No transport for %s command %s: %s", device_name, command, exc)
        raise ValueError(_COMMAND_FAILED) from exc
    except DeviceOfflineException:
        _mark_device_offline(client, device_name)
        raise ValueError(_OFFLINE) from None
    except (GatewayTimeoutException, CommandTimeoutError, ConcurrentRequestError):
        return None
    except Exception as exc:
        if is_rate_limited_error(exc):
            from components.mammotion.session_bootstrap import mark_client_rate_limited

            mark_client_rate_limited(client, seconds=90.0)
            raise ValueError(RATE_LIMIT_USER_MESSAGE) from exc
        raise
