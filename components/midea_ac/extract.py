from __future__ import annotations

from typing import Any

from integrations.entity_utils import finalize_entities as _finalize, slugify

# ── Midea AC ─────────────────────────────────────────────────────────────

_MIDEA_FAN_LABEL = {
    "AUTO": "Auto", "SILENT": "Silent", "LOW": "Mic", "MEDIUM": "Mediu",
    "HIGH": "Mare", "FOCUSED": "Focus",
}
_MIDEA_MODE_LABEL = {
    "AUTO": "Auto", "COOL": "Răcire", "DRY": "Dezumidificare",
    "HEAT": "Încălzire", "FAN_ONLY": "Doar ventilator",
}
_MIDEA_SWING_LABEL = {
    "OFF": "Oprit", "VERTICAL": "Vertical", "HORIZONTAL": "Orizontal",
    "BOTH": "Vertical + Orizontal",
}


def _midea_hvac_state(value: Any, powered: bool) -> str:
    if not powered:
        return "off"
    text = str(value or "AUTO").strip().lower().replace(" ", "_")
    return text or "auto"


def _midea_option_values(values: Any, label_map: dict[str, str], *, include_off: bool = False) -> list[dict[str, str]]:
    raw_values = values if isinstance(values, list) else []
    options: list[dict[str, str]] = []
    if include_off:
        options.append({"value": "off", "label": "Oprit"})
    seen = {item["value"] for item in options}
    for raw in raw_values:
        source = str(raw or "").strip()
        if not source:
            continue
        value = source.lower().replace(" ", "_")
        if value in seen:
            continue
        options.append({"value": value, "label": label_map.get(source.upper(), source.replace("_", " ").title())})
        seen.add(value)
    return options


def extract_midea_ac_candidates(payload: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not isinstance(payload, dict):
        return items
    devices = payload.get("devices") if isinstance(payload.get("devices"), list) else []

    def _state(value: Any) -> str:
        if isinstance(value, bool):
            return "on" if value else "off"
        if isinstance(value, float):
            return f"{value:.1f}".rstrip("0").rstrip(".")
        return str(value) if value is not None and value != "" else "unknown"

    def _device_attrs(device: dict[str, Any]) -> dict[str, Any]:
        device_id = str(device.get("id") or "0")
        name = str(device.get("name") or f"Midea AC {device_id}").strip()
        return {
            "device_id": f"midea_ac_{slugify(device_id)}",
            "device_name": name,
            "device_model": "Midea AC",
            "device_manufacturer": "Midea",
            "ip": device.get("ip") or "",
            "sn": device.get("sn") or "",
            "version": device.get("version") or "",
            "online": bool(device.get("online", True)),
        }

    def _append(
        device: dict[str, Any],
        suffix: str,
        label: str,
        value: Any,
        *,
        unit: str = "",
        domain: str = "sensor",
        controllable: bool = False,
        capabilities: dict[str, Any] | None = None,
        aliases: list[str] | None = None,
    ) -> None:
        if value in (None, ""):
            return
        attrs = _device_attrs(device)
        device_id = str(device.get("id") or "0")
        entity_id = f"midea_ac:{device_id}:{suffix}"
        name = f"{attrs['device_name']} • {label}"
        attributes = {**attrs, "raw_state": {suffix: value}}
        if capabilities:
            attributes["capabilities"] = capabilities
        items.append({
            "entity_id": entity_id,
            "name": name,
            "state": _state(value),
            "domain": domain,
            "source": "midea_ac",
            "aliases": [name, label, *(aliases or [])],
            "unit": unit,
            "controllable": controllable,
            "attributes": attributes,
        })

    for device in devices:
        if not isinstance(device, dict):
            continue
        attrs = _device_attrs(device)
        device_id = str(device.get("id") or "0")
        temperature_unit = "°F" if device.get("fahrenheit") else "°C"
        power_state = bool(device.get("power_state"))
        hvac_state = _midea_hvac_state(device.get("operational_mode"), power_state)
        target = device.get("target_temperature")
        min_temp = device.get("min_target_temperature") or 16
        max_temp = device.get("max_target_temperature") or 30
        hvac_modes = _midea_option_values(device.get("supported_operation_modes"), _MIDEA_MODE_LABEL, include_off=True)
        fan_modes = _midea_option_values(device.get("supported_fan_speeds"), _MIDEA_FAN_LABEL)
        swing_modes = _midea_option_values(device.get("supported_swing_modes"), _MIDEA_SWING_LABEL)
        climate_capabilities = {
            "min": min_temp,
            "max": max_temp,
            "step": 0.5,
            "unit": temperature_unit,
            "hvac_modes": hvac_modes,
            "fan_modes": fan_modes,
            "swing_modes": swing_modes,
        }
        items.append({
            "entity_id": f"midea_ac:{device_id}:climate",
            "name": attrs["device_name"],
            "state": hvac_state,
            "domain": "climate",
            "source": "midea_ac",
            "aliases": [attrs["device_name"], "aer condiționat", "AC", "climate", "termostat"],
            "unit": temperature_unit,
            "controllable": True,
            "attributes": {
                **attrs,
                "current_temperature": device.get("indoor_temperature"),
                "temperature": target,
                "target_temperature": target,
                "temperature_unit": temperature_unit,
                "min_temp": min_temp,
                "max_temp": max_temp,
                "target_temp_step": 0.5,
                "target_temperature_step": 0.5,
                "hvac_mode": hvac_state,
                "hvac_modes": hvac_modes,
                "fan_mode": str(device.get("fan_speed") or "").strip().lower().replace(" ", "_"),
                "fan_modes": fan_modes,
                "swing_mode": str(device.get("swing_mode") or "").strip().lower().replace(" ", "_"),
                "swing_modes": swing_modes,
                "online": bool(device.get("online", True)),
                "raw_state": {
                    "power_state": power_state,
                    "operational_mode": device.get("operational_mode"),
                    "fan_speed": device.get("fan_speed"),
                    "swing_mode": device.get("swing_mode"),
                    "target_temperature": target,
                    "indoor_temperature": device.get("indoor_temperature"),
                    "outdoor_temperature": device.get("outdoor_temperature"),
                },
                "capabilities": climate_capabilities,
            },
        })
        # Connectivity status
        _append(
            device, "online", "Conectivitate", bool(device.get("online", True)),
            domain="binary_sensor",
            aliases=["online", "conectat", attrs["device_name"]],
        )
        # Power switch (controllable)
        _append(
            device, "power", "Putere", bool(device.get("power_state")),
            domain="switch", controllable=True,
            aliases=["aer condiționat", "AC", attrs["device_name"]],
        )
        # Indoor / outdoor temperature
        _append(device, "indoor_temperature", "Temperatură interior",
                device.get("indoor_temperature"), unit="°C")
        _append(device, "outdoor_temperature", "Temperatură exterior",
                device.get("outdoor_temperature"), unit="°C")
        if device.get("supports_humidity"):
            _append(device, "indoor_humidity", "Umiditate",
                    device.get("indoor_humidity"), unit="%")
        # Target temperature (controllable number)
        target = device.get("target_temperature")
        if target is not None:
            _append(
                device, "target_temperature", "Temperatură setată", target, unit="°C",
                domain="number", controllable=True,
                capabilities={
                    "min": device.get("min_target_temperature") or 16,
                    "max": device.get("max_target_temperature") or 30,
                    "step": 0.5,
                },
            )
        # Mode (controllable select)
        modes = device.get("supported_operation_modes") or []
        if modes:
            _append(
                device, "operational_mode", "Mod", device.get("operational_mode") or modes[0],
                domain="select", controllable=True,
                capabilities={
                    "options": [
                        {"value": m, "label": _MIDEA_MODE_LABEL.get(m, m.title())}
                        for m in modes
                    ],
                },
            )
        # Fan speed (controllable select)
        fans = device.get("supported_fan_speeds") or []
        if fans:
            _append(
                device, "fan_speed", "Viteză ventilator", device.get("fan_speed") or fans[0],
                domain="select", controllable=True,
                capabilities={
                    "options": [
                        {"value": f, "label": _MIDEA_FAN_LABEL.get(f, f.title())}
                        for f in fans
                    ],
                },
            )
        # Swing mode (controllable select)
        swings = device.get("supported_swing_modes") or []
        if swings:
            _append(
                device, "swing_mode", "Oscilare", device.get("swing_mode") or swings[0],
                domain="select", controllable=True,
                capabilities={
                    "options": [
                        {"value": s, "label": _MIDEA_SWING_LABEL.get(s, s.title())}
                        for s in swings
                    ],
                },
            )
        # Eco / turbo / display switches
        if device.get("supports_eco"):
            _append(device, "eco", "Mod Eco", bool(device.get("eco")),
                    domain="switch", controllable=True)
        if device.get("supports_turbo"):
            _append(device, "turbo", "Turbo", bool(device.get("turbo")),
                    domain="switch", controllable=True)
        if device.get("supports_display_control"):
            _append(device, "display_on", "Afișaj", bool(device.get("display_on")),
                    domain="switch", controllable=True)
        # Diagnostic
        if device.get("error_code"):
            _append(device, "error_code", "Cod eroare", device.get("error_code"))

    return _finalize(items, default_source="midea_ac")


_RE_OUTAGE_KEYS = ("Result", "result", "errorCode", "errorMessage")

_RE_MONTHS_RO = (
    "ianuarie", "februarie", "martie", "aprilie", "mai", "iunie",
    "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie",
)


