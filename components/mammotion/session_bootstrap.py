"""HA-parity Mammotion session helpers (pymammotion 0.8.x)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from components.mammotion.status import telemetry_ready

log = logging.getLogger("mammotion")

_CONNECTION_STABLE_SECONDS = 8.0
_CONNECTION_TIMEOUT_SECONDS = 35.0
_TELEMETRY_WAIT_SECONDS = 45.0
_FRESH_STATE_MAX_AGE_SECONDS = 120.0
_MQTT_ACTIVITY_MAX_AGE_SECONDS = 120.0
# pymammotion DeviceHandle backs off 15 minutes after TooManyRequestsException.
PYMAMMOTION_RATE_LIMIT_BACKOFF = 120.0

RATE_LIMIT_USER_MESSAGE = (
    "Prea multe cereri către cloud Mammotion — încearcă din nou peste 1–2 minute."
)


_NUDGE_TRANSPORT_FAILED = (
    "Canal MQTT indisponibil pentru nudge — Integrări → Mammotion → Sync, "
    "așteaptă ~1 minut, apoi încearcă din nou."
)


def reset_mqtt_auth_failures(client: Any, device_name: str) -> None:
    """Clear pymammotion auth circuit-breaker flags so Sync can recover Aliyun MQTT."""
    if client is None:
        return
    handle = client.mower(device_name)
    if handle is None:
        return
    from pymammotion.transport.base import TransportType

    for transport_type in (TransportType.CLOUD_ALIYUN, TransportType.CLOUD_MAMMOTION):
        transport = handle.get_transport(transport_type)
        if transport is None:
            continue
        transport.clear_auth_failed()
        transport._unrecoverable_auth_failure = False  # noqa: SLF001 — Hyve recovery hook


async def ensure_nudge_transport(client: Any, device_name: str) -> str:
    """Reconnect MQTT if needed before manual movement commands."""
    from pymammotion.transport.base import NoTransportAvailableError, TransportType

    reset_mqtt_auth_failures(client, device_name)
    handle = client.mower(device_name)
    if handle is None:
        raise ValueError(_NUDGE_TRANSPORT_FAILED)

    for transport_type in (TransportType.CLOUD_ALIYUN, TransportType.CLOUD_MAMMOTION):
        transport = handle.get_transport(transport_type)
        if transport is None or not transport.is_usable:
            continue
        if transport.is_connected:
            continue
        try:
            await transport.connect()
        except Exception as exc:
            log.debug("mammotion nudge reconnect %s for %s: %s", transport_type.value, device_name, exc)

    try:
        selected = handle.active_transport(prefer_ble=False)
    except NoTransportAvailableError as exc:
        raise ValueError(_NUDGE_TRANSPORT_FAILED) from exc
    return str(getattr(getattr(selected, "transport_type", None), "value", selected))


def clear_rate_limit_if_control_ready(client: Any, device_name: str) -> None:
    """Drop sync backoff when live MQTT telemetry proves the robot is reachable."""
    if client is None:
        return
    if not device_handle_online(client, device_name):
        return
    device = client.get_device_by_name(device_name)
    if device is None:
        return
    dev = getattr(getattr(device, "report_data", None), "dev", None)
    if dev is None:
        return
    if not telemetry_ready(
        sys_status=getattr(dev, "sys_status", 0),
        battery=getattr(dev, "battery_val", 0),
        charge_state=getattr(dev, "charge_state", 0),
    ):
        return
    client._hyve_rate_limited_until = 0.0


def device_handle_rate_limited(client: Any, device_name: str) -> bool:
    """True only during Hyve-imposed sync poll backoff (not pymammotion heartbeat flag)."""
    del device_name
    return _client_rate_limited(client)


def raise_if_device_rate_limited(client: Any, device_name: str) -> None:
    """Block only explicit Hyve sync backoff — never pymammotion ``_rate_limited``."""
    if device_handle_rate_limited(client, device_name):
        raise ValueError(RATE_LIMIT_USER_MESSAGE)


def _iter_cloud_transports(client: Any, device_name: str):
    """Yield Mammotion/Aliyun cloud transports for a device (handle + account pool)."""
    from pymammotion.transport.base import TransportType

    seen: set[int] = set()
    handle = client.mower(device_name)
    if handle is not None:
        transports = getattr(handle, "_transports", None)
        if isinstance(transports, dict):
            for transport_type in (TransportType.CLOUD_ALIYUN, TransportType.CLOUD_MAMMOTION):
                transport = transports.get(transport_type)
                if transport is not None:
                    key = id(transport)
                    if key not in seen:
                        seen.add(key)
                        yield transport
    acct = _account_for_device(client, device_name)
    if acct is not None:
        for attr in ("mammotion_transport", "aliyun_transport"):
            transport = getattr(acct, attr, None)
            if transport is not None:
                key = id(transport)
                if key not in seen:
                    seen.add(key)
                    yield transport


def pymammotion_handle_rate_limited(client: Any, device_name: str) -> bool:
    """True when a cloud transport is in pymammotion rate-limit backoff."""
    return any(getattr(transport, "is_rate_limited", False) for transport in _iter_cloud_transports(client, device_name))


def any_pymammotion_handle_rate_limited(client: Any, device_names: list[str]) -> bool:
    return any(pymammotion_handle_rate_limited(client, name) for name in device_names)


def clear_pymammotion_rate_limit_for_command(client: Any, device_name: str) -> None:
    """HA parity: transport rate limit backs off keep-alive, not explicit user commands."""
    if not device_handle_online(client, device_name):
        return
    for transport in _iter_cloud_transports(client, device_name):
        if getattr(transport, "is_rate_limited", False):
            transport._rate_limited_until = 0.0


def prepare_device_for_command(client: Any, device_name: str) -> None:
    """Clear stale cloud-offline flags so pymammotion does not silently drop commands."""
    clear_rate_limit_if_control_ready(client, device_name)
    handle = client.mower(device_name) if client is not None else None
    if handle is None:
        return
    if not getattr(getattr(handle, "availability", None), "mqtt_reported_offline", False):
        return
    device = client.get_device_by_name(device_name)
    if device is None:
        return
    dev = getattr(getattr(device, "report_data", None), "dev", None)
    if dev is None:
        return
    if not telemetry_ready(
        sys_status=getattr(dev, "sys_status", 0),
        battery=getattr(dev, "battery_val", 0),
        charge_state=getattr(dev, "charge_state", 0),
    ):
        return
    from pymammotion.transport.base import TransportType

    for transport_type in (TransportType.CLOUD_ALIYUN, TransportType.CLOUD_MAMMOTION):
        if not handle.has_transport(transport_type):
            continue
        handle.update_availability(
            transport_type,
            handle.availability.mqtt,
            mqtt_reported_offline=False,
        )
        log.debug("mammotion cleared stale mqtt_reported_offline for %s", device_name)
        return


def device_handle_online(client: Any, device_name: str) -> bool:
    """Mirror Mammotion-HA ``MammotionReportUpdateCoordinator.is_online()``."""
    from pymammotion.transport.base import TransportType

    device = client.get_device_by_name(device_name)
    if device is None:
        return False
    handle = client.mower(device_name)
    if handle is None:
        return bool(getattr(device, "online", False))
    ble = handle.get_transport(TransportType.BLE) if hasattr(handle, "get_transport") else None
    if ble is not None and getattr(ble, "is_usable", False):
        return True
    if not bool(getattr(handle.availability, "mqtt_reported_offline", False)):
        return True
    # Telemetry still updating over MQTT — cloud "offline" flag is stale.
    if mqtt_transport_connected(client, device_name):
        device = client.get_device_by_name(device_name)
        dev = getattr(getattr(device, "report_data", None), "dev", None) if device else None
        if dev is not None and telemetry_ready(
            sys_status=getattr(dev, "sys_status", 0),
            battery=getattr(dev, "battery_val", 0),
            charge_state=getattr(dev, "charge_state", 0),
        ):
            return True
    return False


def _account_for_device(client: Any, device_name: str) -> Any | None:
    registry = getattr(client, "_account_registry", None)
    if registry is None:
        return None
    handle = client.mower(device_name)
    if handle is None:
        return None
    sessions = list(getattr(registry, "all_sessions", []) or [])
    for acct in sessions:
        if device_name in getattr(acct, "device_ids", set()):
            return acct
    if len(sessions) == 1:
        return sessions[0]
    return None


def _transport_live(transport: Any) -> bool:
    """Connected flag or recent inbound MQTT activity."""
    if transport is None:
        return False
    if getattr(transport, "is_connected", False):
        return True
    last = float(getattr(transport, "last_received_monotonic", 0.0) or 0.0)
    return last > 0 and time.monotonic() - last <= _MQTT_ACTIVITY_MAX_AGE_SECONDS


def mqtt_transport_connected(client: Any, device_name: str) -> bool:
    from pymammotion.transport.base import TransportType

    handle = client.mower(device_name)
    if handle is None:
        return False
    for transport_type in (TransportType.CLOUD_ALIYUN, TransportType.CLOUD_MAMMOTION):
        if hasattr(handle, "is_transport_connected") and handle.is_transport_connected(transport_type):
            return True
        if handle.has_transport(transport_type):
            transports = getattr(handle, "_transports", None)
            if isinstance(transports, dict):
                transport = transports.get(transport_type)
                if _transport_live(transport):
                    return True
    acct = _account_for_device(client, device_name)
    if acct is not None:
        device_ids = getattr(acct, "device_ids", set()) or set()
        for attr in ("mammotion_transport", "aliyun_transport"):
            transport = getattr(acct, attr, None)
            if transport is None:
                continue
            if device_ids and device_name not in device_ids:
                continue
            if _transport_live(transport):
                return True
    return False


def control_path_ready(client: Any, device_name: str) -> bool:
    """True when user commands can reach the robot (HA parity — not only ``is_connected``)."""
    if mqtt_transport_connected(client, device_name):
        return True
    if not device_handle_online(client, device_name):
        return False
    device = client.get_device_by_name(device_name)
    dev = getattr(getattr(device, "report_data", None), "dev", None) if device else None
    if dev is None:
        return False
    return telemetry_ready(
        sys_status=getattr(dev, "sys_status", 0),
        battery=getattr(dev, "battery_val", 0),
        charge_state=getattr(dev, "charge_state", 0),
    )


async def await_device_connection(client: Any, device_name: str) -> bool:
    """Wait for MQTT/BLE like HA ``_await_device_connection`` (best effort)."""
    deadline = time.monotonic() + _CONNECTION_TIMEOUT_SECONDS
    stable_since: float | None = None
    while time.monotonic() < deadline:
        if device_handle_online(client, device_name):
            if stable_since is None:
                stable_since = time.monotonic()
            if time.monotonic() - stable_since >= _CONNECTION_STABLE_SECONDS:
                return True
        else:
            stable_since = None
        await asyncio.sleep(1.0)
    return device_handle_online(client, device_name)


async def _safe_command(client: Any, device_name: str, command: str, **kwargs: Any) -> None:
    try:
        await client.send_command_with_args(device_name, command, **kwargs)
    except Exception as exc:
        log.debug("mammotion bootstrap cmd %s for %s: %s", command, device_name, exc)


async def bootstrap_device(client: Any, device_name: str) -> None:
    """Initial command batch from HA ``MammotionReportUpdateCoordinator._async_setup``."""
    from pymammotion.utility.device_type import DeviceType

    await _safe_command(client, device_name, "send_todev_ble_sync", sync_type=3)
    for command in (
        "async_read_rain_detection",
        "async_read_sidelight",
        "async_read_turning_mode",
        "async_read_traversal_mode",
    ):
        await _safe_command(client, device_name, command)

    if DeviceType.is_mini_or_x_series(device_name):
        for command in (
            "async_read_manual_light",
            "async_read_night_light",
            "async_read_cutter_mode",
        ):
            await _safe_command(client, device_name, command)

    if DeviceType.is_luba_pro(device_name):
        for command in ("async_fetch_audio_config", "async_read_wildlife_safety"):
            await _safe_command(client, device_name, command)

    await request_report_snapshot(client, device_name)


async def request_report_snapshot(client: Any, device_name: str) -> None:
    """One-shot telemetry poll (HA ``async_request_report_snapshot``)."""
    if pymammotion_handle_rate_limited(client, device_name):
        log.debug("mammotion skip snapshot for %s (cloud rate limit backoff)", device_name)
        return
    from components.mammotion.utils import is_rate_limited_error

    try:
        await client.request_iot_sync(device_name)
    except Exception as exc:
        if is_rate_limited_error(exc):
            log.warning("mammotion request_report_snapshot rate limited for %s", device_name)
        else:
            log.debug("mammotion request_report_snapshot failed for %s: %s", device_name, exc)


async def start_report_stream(client: Any, device_name: str) -> None:
    """Transient continuous stream before dock (HA ``async_start_report_stream``)."""
    try:
        await client.request_iot_sync_continuous(device_name)
    except Exception as exc:
        log.debug("mammotion start_report_stream failed for %s: %s", device_name, exc)


async def ensure_fresh_state(
    client: Any,
    device_name: str,
    *,
    last_fresh_at: float | None,
) -> float:
    """Refresh stale device state before user actions."""
    now = time.monotonic()
    if last_fresh_at is not None and now - last_fresh_at <= _FRESH_STATE_MAX_AGE_SECONDS:
        return last_fresh_at
    await request_report_snapshot(client, device_name)
    await asyncio.sleep(2.0)
    return now


async def wait_for_telemetry(
    client: Any,
    device_name: str,
    *,
    timeout_seconds: float | None = None,
) -> bool:
    """Block until report_data is populated or timeout."""
    cap = float(timeout_seconds if timeout_seconds is not None else _TELEMETRY_WAIT_SECONDS)
    deadline = time.monotonic() + cap
    poll_interval = 12.0
    next_poll_at = 0.0
    while time.monotonic() < deadline:
        device = client.get_device_by_name(device_name)
        if device is not None:
            dev = getattr(getattr(device, "report_data", None), "dev", None)
            if dev is not None and telemetry_ready(
                sys_status=getattr(dev, "sys_status", 0),
                battery=getattr(dev, "battery_val", 0),
            ):
                return True
        now = time.monotonic()
        if now >= next_poll_at:
            next_poll_at = now + poll_interval
            await request_report_snapshot(client, device_name)
        await asyncio.sleep(2.0)
    device = client.get_device_by_name(device_name)
    if device is None:
        return False
    dev = getattr(getattr(device, "report_data", None), "dev", None)
    if dev is None:
        return False
    return telemetry_ready(
        sys_status=getattr(dev, "sys_status", 0),
        battery=getattr(dev, "battery_val", 0),
    )


def _client_rate_limited(client: Any) -> bool:
    until = float(getattr(client, "_hyve_rate_limited_until", 0.0) or 0.0)
    return time.monotonic() < until


def mark_client_rate_limited(client: Any, *, seconds: float = PYMAMMOTION_RATE_LIMIT_BACKOFF) -> None:
    if client is not None:
        client._hyve_rate_limited_until = time.monotonic() + seconds


def require_device_ready(
    client: Any,
    device_name: str,
    *,
    strict: bool = True,
    for_control: bool = False,
) -> None:
    """Raise when device is missing/offline. Sync-only strict mode checks telemetry poll."""
    device = client.get_device_by_name(device_name)
    if device is None:
        raise ValueError("Dispozitivul nu este înregistrat — apasă Sync la integrare.")
    if not device_handle_online(client, device_name):
        raise ValueError("Robotul este offline în cloud — verifică în app Mammotion.")
    if for_control:
        return
    dev = getattr(getattr(device, "report_data", None), "dev", None)
    if dev is None:
        if _client_rate_limited(client) and not strict:
            return
        raise ValueError("Datele robotului nu sunt încărcate — apasă Sync și așteaptă ~1 minut.")
    if strict and not telemetry_ready(
        sys_status=getattr(dev, "sys_status", 0),
        battery=getattr(dev, "battery_val", 0),
        charge_state=getattr(dev, "charge_state", 0),
    ):
        if _client_rate_limited(client):
            return
        raise ValueError(
            "Robotul nu este pregătit — sincronizarea MQTT este în curs. "
            "Apasă Sync și așteaptă 30–60 secunde."
        )
