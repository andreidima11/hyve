"""Report telemetry coordinator — online state and MQTT refresh."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from components.mammotion.session_bootstrap import (
    device_handle_online,
    prepare_device_for_command,
    require_device_ready,
)
from components.mammotion.status import telemetry_ready


class ReportCoordinator:
    """HA ``MammotionReportUpdateCoordinator`` subset for pymammotion 0.7.x."""

    def __init__(self, client: Any, device_name: str) -> None:
        self._client = client
        self.device_name = device_name
        self.mqtt_online = True
        self._last_fresh_at: float | None = None

    @property
    def last_fresh_at(self) -> float | None:
        return self._last_fresh_at

    @last_fresh_at.setter
    def last_fresh_at(self, value: float | None) -> None:
        self._last_fresh_at = value

    def is_online(self) -> bool:
        return device_handle_online(self._client, self.device_name)

    def meta(self) -> dict[str, Any]:
        device = self._client.get_device_by_name(self.device_name)
        online = self.is_online()
        self.mqtt_online = online
        ready = False
        if device is not None:
            dev = getattr(getattr(device, "report_data", None), "dev", None)
            if dev is not None:
                ready = telemetry_ready(
                    sys_status=getattr(dev, "sys_status", 0),
                    battery=getattr(dev, "battery_val", 0),
                    charge_state=getattr(dev, "charge_state", 0),
                )
        return {
            "mqtt_online": online,
            "telemetry_ready": ready,
        }

    async def refresh_snapshot(self) -> None:
        from components.mammotion.session_bootstrap import request_report_snapshot

        await request_report_snapshot(self._client, self.device_name)
        await asyncio.sleep(2.0)
        self._last_fresh_at = time.monotonic()

    async def request_report_snapshot(self) -> None:
        from components.mammotion.session_bootstrap import request_report_snapshot

        await request_report_snapshot(self._client, self.device_name)
        await asyncio.sleep(1.5)
        self._last_fresh_at = time.monotonic()

    async def ensure_ready_for_control(self) -> None:
        """User commands use MQTT push state — no pre-flight telemetry polling."""
        prepare_device_for_command(self._client, self.device_name)
        require_device_ready(self._client, self.device_name, for_control=True)
        self._last_fresh_at = time.monotonic()
