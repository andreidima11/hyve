"""Device fault / sensor error coordinator."""

from __future__ import annotations

from typing import Any

from pymammotion.data.model.enums import SensorCheckState
from pymammotion.utility.constant.device_constant import WorkMode

_SENSOR_FIELDS = (
    ("bumper_state", "Bumper"),
    ("ult_left", "Ultrasonic left"),
    ("ult_left_front", "Ultrasonic left front"),
    ("ult_right", "Ultrasonic right"),
    ("ult_right_front", "Ultrasonic right front"),
)


class ErrorCoordinator:
    """Collect active device faults for snapshot + binary_sensor entities."""

    def __init__(self, client: Any, device_name: str) -> None:
        self._client = client
        self.device_name = device_name
        self._errors: dict[str, str] = {}

    @property
    def errors(self) -> dict[str, str]:
        return dict(self._errors)

    def meta(self) -> dict[str, Any]:
        return {"errors": self.errors}

    def refresh(self, device: Any | None = None) -> dict[str, str]:
        if device is None:
            device = self._client.get_device_by_name(self.device_name)
        self._errors = self._collect(device)
        return self.errors

    def _collect(self, device: Any | None) -> dict[str, str]:
        if device is None:
            return {}
        rd = getattr(device, "report_data", None)
        dev = getattr(rd, "dev", None) if rd is not None else None
        if dev is None:
            return {}

        out: dict[str, str] = {}
        mode = int(getattr(dev, "sys_status", 0) or 0)
        if mode == WorkMode.MODE_LOCK:
            out["lock_mode"] = "Mower locked"
        elif mode == WorkMode.MODE_LOCATION_ERROR:
            out["location"] = "Location error"
        elif mode == WorkMode.MODE_BOUNDARY_JUMP:
            out["boundary"] = "Boundary jump"

        lock_state = getattr(getattr(dev, "lock_state", None), "lock_state", 0)
        if int(lock_state or 0) not in (0,):
            out["physical_lock"] = f"Lock state {lock_state}"

        for field, label in _SENSOR_FIELDS:
            if not hasattr(dev, field):
                continue
            state = getattr(dev, field)
            try:
                level = int(state)
            except (TypeError, ValueError):
                continue
            if level >= int(SensorCheckState.ERROR):
                out[field] = f"{label} fault"
            elif level == int(SensorCheckState.WARNING):
                out[f"{field}_warn"] = f"{label} warning"

        fpv = getattr(dev, "fpv_info", None)
        if fpv is not None and int(getattr(fpv, "fpv_flag", 0) or 0) == 2:
            out["fpv"] = "Camera FPV error"

        check = int(getattr(dev, "self_check_status", 0) or 0)
        if check:
            out["self_check"] = f"Self-check status {check}"

        return out
