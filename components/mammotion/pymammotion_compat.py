"""Hyve runtime patches for pymammotion 0.8.x (Python 3.13+)."""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("mammotion")

_PATCHED = False
_ALIYUN_GATEWAY_PATCHED = False


def apply_pymammotion_patches() -> None:
    """Apply idempotent Hyve patches on top of pymammotion 0.8.x."""
    global _PATCHED
    if _PATCHED:
        return

    from pymammotion.client import MammotionClient

    _orig_full_relogin = MammotionClient._full_relogin
    _orig_restore_aliyun = MammotionClient._restore_aliyun

    def _bind_hyve_http_session(client: Any, session: Any) -> None:
        """Keep MammotionHTTP on the hub's shared aiohttp session during re-login."""
        http_sess = getattr(client, "_hyve_http_session", None)
        if http_sess is None or session is None:
            return
        mammotion_http = getattr(session, "mammotion_http", None)
        if mammotion_http is not None:
            mammotion_http._session = http_sess
        cloud_client = getattr(session, "cloud_client", None)
        if cloud_client is not None:
            cloud_http = getattr(cloud_client, "mammotion_http", None)
            if cloud_http is not None:
                cloud_http._session = http_sess

    async def _patched_full_relogin(
        self: Any,
        session: Any,
        transport_type: Any = None,
    ) -> None:
        """Delegate to pymammotion 0.8.x re-login (Aliyun IoT token refresh) with Hyve HTTP binding."""
        _bind_hyve_http_session(self, session)
        await _orig_full_relogin(self, session, transport_type=transport_type)

    async def _patched_restore_aliyun(
        self: Any,
        account: str,
        password: str,
        cached_data: dict[str, Any],
        acct_session: Any,
        *,
        check_for_new_devices: bool,
    ) -> None:
        await _orig_restore_aliyun(
            self,
            account,
            password,
            cached_data,
            acct_session,
            check_for_new_devices=check_for_new_devices,
        )
        http_sess = getattr(self, "_hyve_http_session", None)
        if http_sess is None:
            return
        mammotion_http = getattr(acct_session, "mammotion_http", None)
        if mammotion_http is not None:
            mammotion_http._session = http_sess
        cloud_client = getattr(acct_session, "cloud_client", None)
        if cloud_client is not None:
            cloud_http = getattr(cloud_client, "mammotion_http", None)
            if cloud_http is not None:
                cloud_http._session = http_sess

    if not getattr(MammotionClient._full_relogin, "_hyve_patched", False):
        _patched_full_relogin._hyve_patched = True  # type: ignore[attr-defined]
        MammotionClient._full_relogin = _patched_full_relogin  # type: ignore[method-assign]

    _orig_setup_aliyun = MammotionClient._setup_aliyun_transport

    def _patched_setup_aliyun(self: Any, cloud_client: Any, acct_session: Any) -> Any:
        import time

        transport = _orig_setup_aliyun(self, cloud_client, acct_session)
        orig_failure = transport.on_auth_failure
        if orig_failure is None:
            return transport

        state = {"last_at": 0.0}

        async def _guarded_auth_failure() -> bool:
            now = time.monotonic()
            if now - state["last_at"] < 60.0:
                return False
            state["last_at"] = now
            try:
                ok = await orig_failure()
            except Exception as exc:
                from components.mammotion.utils import is_auth_session_error

                if is_auth_session_error(exc):
                    log.warning("mammotion Aliyun token refresh aborted: %s", exc)
                return False
            if not ok:
                log.warning("mammotion Aliyun token refresh failed")
            return ok

        transport.on_auth_failure = _guarded_auth_failure
        return transport

    if not getattr(MammotionClient._restore_aliyun, "_hyve_patched", False):
        _patched_restore_aliyun._hyve_patched = True  # type: ignore[attr-defined]
        MammotionClient._restore_aliyun = _patched_restore_aliyun  # type: ignore[method-assign]

    if not getattr(MammotionClient._setup_aliyun_transport, "_hyve_patched", False):
        _patched_setup_aliyun._hyve_patched = True  # type: ignore[attr-defined]
        MammotionClient._setup_aliyun_transport = _patched_setup_aliyun  # type: ignore[method-assign]

    _patch_active_transport_mqtt_selection()

    _patch_aliyun_decode_noise()

    _PATCHED = True
    log.debug("applied pymammotion 0.8.x Hyve patches")


def _patch_active_transport_mqtt_selection() -> None:
    """Prefer the first *usable* MQTT transport (skip dead Aliyun when Mammotion MQTT works)."""
    from pymammotion.device.handle import DeviceHandle
    from pymammotion.transport.base import NoTransportAvailableError, Transport, TransportType

    if getattr(DeviceHandle.active_transport, "_hyve_patched", False):
        return

    _orig = DeviceHandle.active_transport
    _handle_logger = logging.getLogger("pymammotion.device.handle")

    def _pick_mqtt(handle: Any, mqtt_reported_offline: bool) -> Transport | None:
        candidates: list[Transport] = []
        for transport_type in (TransportType.CLOUD_ALIYUN, TransportType.CLOUD_MAMMOTION):
            transport = handle._transports.get(transport_type)
            if transport is None or not transport.is_usable:
                continue
            candidates.append(transport)
        if not candidates:
            return None
        for transport in candidates:
            if transport.is_connected:
                return transport
        return candidates[0]

    def _patched_active_transport(self: Any, *, prefer_ble: bool | None = None) -> Transport:
        use_ble_first = self._prefer_ble if prefer_ble is None else prefer_ble

        ble = self._transports.get(TransportType.BLE)
        ble_connected = ble is not None and ble.is_connected
        ble_usable = ble is not None and ble.is_usable

        mqtt_reported_offline = self._availability.mqtt_reported_offline
        mqtt = _pick_mqtt(self, mqtt_reported_offline)
        mqtt_usable = mqtt is not None and not mqtt_reported_offline and mqtt.is_usable

        def _log_selection(path: str, *args: Any) -> None:
            key = (path, use_ble_first, ble_usable, mqtt_usable)
            if self._last_active_transport_log == key:
                return
            self._last_active_transport_log = key
            _handle_logger.debug(path, self.device_name, *args)

        if ble_connected and ble is not None:
            _log_selection("active_transport '%s': selected BLE (actively connected)")
            return ble

        if mqtt_usable and mqtt is not None:
            _log_selection("active_transport '%s': selected %s", mqtt.transport_type)
            return mqtt
        if ble_usable and ble is not None:
            _log_selection("active_transport '%s': MQTT unusable — falling back to BLE")
            return ble

        transport_states = (
            ", ".join(f"{tt.value}={t.availability.value}" for tt, t in self._transports.items()) or "none registered"
        )
        offline_suffix = " (mqtt_reported_offline=True)" if mqtt_reported_offline else ""
        msg = f"No transport available for device '{self.device_id}' [{transport_states}]{offline_suffix}"
        _handle_logger.debug("active_transport '%s': %s", self.device_name, msg)
        raise NoTransportAvailableError(msg)

    _patched_active_transport._hyve_patched = True  # type: ignore[attr-defined]
    DeviceHandle.active_transport = _patched_active_transport  # type: ignore[method-assign]


def _patch_aliyun_decode_noise() -> None:
    """Benign Aliyun JSON parse failures are debug-only (pymammotion returns code 22000)."""
    global _ALIYUN_GATEWAY_PATCHED
    if _ALIYUN_GATEWAY_PATCHED:
        return

    import json
    from json import JSONDecodeError

    from pymammotion.aliyun.cloud_gateway import CloudIOTGateway

    gateway_logger = logging.getLogger("pymammotion.aliyun.cloud_gateway")

    @staticmethod
    def _quiet_parse_json_response(response_body_str: str) -> dict:
        try:
            return json.loads(response_body_str) if response_body_str is not None else {}
        except JSONDecodeError:
            preview = (response_body_str or "")[:120]
            gateway_logger.debug("Couldn't decode Aliyun message (ignored): %r", preview)
            return {"code": 22000}

    if not getattr(CloudIOTGateway.parse_json_response, "_hyve_patched", False):
        _quiet_parse_json_response._hyve_patched = True  # type: ignore[attr-defined]
        CloudIOTGateway.parse_json_response = _quiet_parse_json_response  # type: ignore[method-assign]
        _ALIYUN_GATEWAY_PATCHED = True
