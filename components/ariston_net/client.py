"""AristonNET cloud client wrapper.

Hyve keeps integrations provider-shaped; this module isolates the optional
``ariston`` dependency and returns plain dictionaries that extractors can turn
into Hyve entities.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from datetime import date, datetime
from typing import Any

import core.settings as settings_mod

log = logging.getLogger("ariston_net")

FALLBACK_ARISTON_API_URL = "https://www.ariston-net.remotethermo.com/api/v2/"
FALLBACK_ARISTON_USER_AGENT = "RestSharp/106.11.7.0"


class AristonNetError(Exception):
    """Raised when AristonNET API calls fail."""


class AristonNetDependencyError(AristonNetError):
    """Raised when the optional ariston package is missing."""


def _import_ariston() -> tuple[Any, Any, str, str]:
    try:
        from ariston import Ariston, DeviceAttribute  # type: ignore
        try:
            from ariston.const import ARISTON_API_URL, ARISTON_USER_AGENT  # type: ignore
        except Exception:
            ARISTON_API_URL = FALLBACK_ARISTON_API_URL
            ARISTON_USER_AGENT = FALLBACK_ARISTON_USER_AGENT
    except ImportError as exc:  # pragma: no cover - depends on optional package
        raise AristonNetDependencyError(
            "Pachetul Python 'ariston' nu este instalat. Rulează pip install -r requirements.txt."
        ) from exc
    return Ariston, DeviceAttribute, ARISTON_API_URL, ARISTON_USER_AGENT


def _enum_name(value: Any) -> str:
    if value is None:
        return ""
    name = getattr(value, "name", None)
    if name:
        return str(name)
    text = str(value)
    return text.split(".")[-1] if "." in text else text


def _serialize(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (list, tuple, set)):
        return [_serialize(v) for v in value]
    if isinstance(value, dict):
        return {str(_serialize(k)): _serialize(v) for k, v in value.items()}
    if hasattr(value, "name"):
        return getattr(value, "name")
    return str(value)


def _safe_get(obj: Any, attr: str, default: Any = None) -> Any:
    try:
        value = getattr(obj, attr)
    except Exception:
        return default
    if callable(value):
        return default
    return _serialize(value)


async def _safe_call(obj: Any, method: str, *args: Any, default: Any = None) -> Any:
    fn = getattr(obj, method, None)
    if not callable(fn):
        return default
    try:
        result = fn(*args)
        if inspect.isawaitable(result):
            result = await result
        return _serialize(result)
    except Exception:
        return default


def _cloud_attr(device: Any, key: str, DeviceAttribute: Any = None) -> Any:
    if not isinstance(device, dict):
        return None
    candidates: list[Any] = [key, key.lower(), key.upper()]
    aliases = {
        "gateway": ["gw", "GW"],
        "gw": ["gateway", "Gateway"],
        "name": ["Name", "NAME"],
        "serial": ["sn", "SN", "serial_number"],
        "sn": ["serial", "serial_number", "SN"],
    }
    candidates.extend(aliases.get(key.lower(), []))
    if DeviceAttribute is not None:
        for enum_name in {key.upper(), *[str(a).upper() for a in aliases.get(key.lower(), [])]}:
            enum_key = getattr(DeviceAttribute, enum_name, None)
            if enum_key is not None:
                candidates.append(enum_key)
    for candidate in candidates:
        try:
            if candidate in device:
                return device.get(candidate)
        except Exception:
            continue
    return None


def _norm(text: Any) -> str:
    return str(text or "").strip().lower()


class AristonNetClient:
    """Thin async wrapper around the public ``ariston`` Python package."""

    def __init__(
        self,
        username: str,
        password: str,
        *,
        api_url: str | None = None,
        user_agent: str | None = None,
        device: str | None = None,
        metric: bool = True,
        cache_ttl: int = 180,
    ) -> None:
        self._username = str(username or "").strip()
        self._password = str(password or "").strip()
        self._api_url = str(api_url or "").strip()
        self._user_agent = str(user_agent or "").strip()
        self._device_selector = str(device or "").strip()
        self._metric = bool(metric)
        self._cache_ttl = max(60, int(cache_ttl or 180))
        self._lock = asyncio.Lock()
        self._ariston_session: Any | None = None
        self._device: Any | None = None
        self._cloud_device: dict[str, Any] | None = None
        self._cache: dict[str, Any] | None = None
        self._cache_ts = 0.0

    def _is_configured(self) -> bool:
        return bool(self._username and self._password)

    def _select_cloud_device(self, cloud_devices: list[Any], DeviceAttribute: Any) -> dict[str, Any]:
        if not cloud_devices:
            raise AristonNetError("Nu a fost găsit niciun dispozitiv AristonNET în cont.")
        selector = _norm(self._device_selector)
        normalized_devices = [d for d in cloud_devices if isinstance(d, dict)]
        if not normalized_devices:
            raise AristonNetError("Lista de dispozitive AristonNET este invalidă.")
        if not selector:
            return normalized_devices[0]
        for device in normalized_devices:
            values = [
                _cloud_attr(device, "gw", DeviceAttribute),
                _cloud_attr(device, "gateway", DeviceAttribute),
                _cloud_attr(device, "name", DeviceAttribute),
                _cloud_attr(device, "sn", DeviceAttribute),
                _cloud_attr(device, "serial", DeviceAttribute),
            ]
            if selector in {_norm(v) for v in values if v is not None}:
                return device
        raise AristonNetError("Dispozitivul AristonNET configurat nu a fost găsit în cont.")

    async def discover_devices(self) -> list[dict[str, Any]]:
        if not self._is_configured():
            raise AristonNetError("Username și parolă AristonNET sunt obligatorii.")
        Ariston, DeviceAttribute, default_api_url, default_user_agent = _import_ariston()
        ariston = Ariston()
        ok = await ariston.async_connect(
            self._username,
            self._password,
            self._api_url or default_api_url,
            self._user_agent or default_user_agent,
        )
        if not ok:
            raise AristonNetError("Autentificarea AristonNET a eșuat.")
        cloud_devices = await ariston.async_discover()
        result: list[dict[str, Any]] = []
        for idx, item in enumerate(cloud_devices or [], start=1):
            if not isinstance(item, dict):
                continue
            gateway = _cloud_attr(item, "gw", DeviceAttribute) or _cloud_attr(item, "gateway", DeviceAttribute) or f"device_{idx}"
            name = _cloud_attr(item, "name", DeviceAttribute) or gateway
            serial = _cloud_attr(item, "sn", DeviceAttribute) or _cloud_attr(item, "serial", DeviceAttribute) or ""
            result.append({
                "gateway": _serialize(gateway),
                "name": _serialize(name),
                "serial_number": _serialize(serial),
                "raw": _serialize(item),
            })
        return result

    async def _connect_device(self) -> tuple[Any, dict[str, Any]]:
        if not self._is_configured():
            raise AristonNetError("Username și parolă AristonNET sunt obligatorii.")
        Ariston, DeviceAttribute, default_api_url, default_user_agent = _import_ariston()
        ariston = Ariston()
        ok = await ariston.async_connect(
            self._username,
            self._password,
            self._api_url or default_api_url,
            self._user_agent or default_user_agent,
        )
        if not ok:
            raise AristonNetError("Autentificarea AristonNET a eșuat.")
        cloud_devices = await ariston.async_discover()
        cloud_device = self._select_cloud_device(cloud_devices or [], DeviceAttribute)
        gateway = _cloud_attr(cloud_device, "gw", DeviceAttribute) or _cloud_attr(cloud_device, "gateway", DeviceAttribute)
        if not gateway:
            raise AristonNetError("Dispozitivul AristonNET nu are gateway ID.")
        device = await ariston.async_hello(gateway, self._metric)
        if device is None:
            raise AristonNetError("AristonNET nu a returnat date pentru dispozitiv.")
        await _safe_call(device, "async_get_features")
        self._ariston_session = ariston
        self._device = device
        self._cloud_device = cloud_device
        return device, cloud_device

    async def _live_device(self, *, force_reconnect: bool = False) -> tuple[Any, dict[str, Any]]:
        async with self._lock:
            if force_reconnect or self._device is None or self._cloud_device is None:
                return await self._connect_device()
            return self._device, self._cloud_device

    async def _update_device(self, device: Any) -> list[str]:
        errors: list[str] = []

        async def call(method: str) -> tuple[bool, Any]:
            fn = getattr(device, method, None)
            if not callable(fn):
                return True, None
            try:
                result = fn()
                if inspect.isawaitable(result):
                    result = await result
                return True, _serialize(result)
            except Exception as exc:
                return False, exc

        ok, err = await call("async_update_state")
        if not ok:
            errors.append(f"AristonNET nu a putut actualiza starea dispozitivului: {err}")
        # Some Ariston cloud responses do not populate ``features`` reliably,
        # which makes ``has_metering`` evaluate to None even though energy data
        # is available. Try optional refreshes unconditionally and let
        # ``_safe_call`` ignore methods unsupported by the concrete device.
        ok, err = await call("async_update_energy")
        has_energy_cache = bool(getattr(device, "consumptions_sequences", None) or getattr(device, "energy_account", None))
        if not ok and not has_energy_cache:
            errors.append(f"AristonNET nu a putut actualiza consumurile: {err}")
        ok, err = await call("async_update_settings")
        if not ok:
            errors.append(f"AristonNET nu a putut actualiza setările: {err}")
        await call("async_get_bus_errors")
        return errors

    async def fetch_all(self, *, force: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        if not force and self._cache is not None and (now - self._cache_ts) < self._cache_ttl:
            return self._cache
        device, cloud_device = await self._live_device(force_reconnect=force)
        update_errors = await self._update_device(device)
        if update_errors and self._cache is not None:
            return self._cache
        payload = self._snapshot(device, cloud_device)
        if update_errors:
            message = "; ".join(update_errors)
            payload.setdefault("summary", {})["status"] = "partial"
            payload.setdefault("summary", {})["partial"] = True
            payload.setdefault("summary", {})["last_error"] = message
            for row in payload.get("devices") or []:
                if isinstance(row, dict):
                    row["partial"] = True
                    row["unavailable_reason"] = message
        self._cache = payload
        self._cache_ts = time.monotonic()
        return payload

    async def test_connection(self) -> dict[str, Any]:
        devices = await self.discover_devices()
        selected = None
        if devices:
            selector = _norm(self._device_selector)
            selected = next((d for d in devices if selector and selector in {_norm(d.get("gateway")), _norm(d.get("name")), _norm(d.get("serial_number"))}), devices[0])
        suffix = f" — dispozitiv: {selected.get('name')}" if selected else ""
        return {
            "ok": True,
            "message": f"Conectat la AristonNET ({len(devices)} dispozitiv{'e' if len(devices) != 1 else ''}){suffix}",
            "device_count": len(devices),
            "devices": devices,
        }

    def clear_cache(self) -> None:
        self._cache = None
        self._cache_ts = 0.0

    def _snapshot(self, device: Any, cloud_device: dict[str, Any]) -> dict[str, Any]:
        gateway = _safe_get(device, "gateway") or _cloud_attr(cloud_device, "gw") or _cloud_attr(cloud_device, "gateway") or "ariston"
        name = _safe_get(device, "name") or _cloud_attr(cloud_device, "name") or "AristonNET"
        serial = _safe_get(device, "serial_number") or _cloud_attr(cloud_device, "sn") or _cloud_attr(cloud_device, "serial") or ""
        zone_numbers = _safe_get(device, "zone_numbers", []) or []
        if not zone_numbers and isinstance(cloud_device.get("zones"), list):
            zone_numbers = [zone.get("num") for zone in cloud_device.get("zones") or [] if isinstance(zone, dict) and zone.get("num") is not None]
        data: dict[str, Any] = {
            "gateway": gateway,
            "name": name,
            "serial_number": serial,
            "firmware_version": _safe_get(device, "firmware_version") or cloud_device.get("fwVer"),
            "system_type": _enum_name(_safe_get(device, "system_type")),
            "whe_type": _enum_name(_safe_get(device, "whe_type")),
            "whe_model_type": _safe_get(device, "whe_model_type"),
            "has_metering": _safe_get(device, "has_metering", False),
            "has_dhw": _safe_get(device, "has_dhw"),
            "features": _safe_get(device, "features", {}) or {},
            "custom_features": _safe_get(device, "custom_features", {}) or {},
            "zone_numbers": zone_numbers,
            "cloud": _serialize(cloud_device),
        }

        settings = cloud_device.get("consumptionsSettings") if isinstance(cloud_device.get("consumptionsSettings"), dict) else {}
        if settings:
            data.setdefault("elect_cost", settings.get("elecCost"))
            data.setdefault("gas_cost", settings.get("gasCost"))
            data.setdefault("currency", settings.get("currency"))
            data.setdefault("gas_type", settings.get("gasType"))
            data.setdefault("gas_energy_unit", settings.get("gasEnergyUnit"))

        scalar_attrs = [
            "plant_mode_text", "plant_mode_opt_texts", "is_flame_on_value", "is_heating_pump_on_value",
            "is_plant_in_heat_mode", "is_plant_in_cool_mode", "holiday_mode_value", "holiday_expires_on",
            "plant_mode", "plant_mode_options", "plant_mode_supported", "automatic_thermoregulation",
            "heating_circuit_pressure_value", "heating_circuit_pressure_unit",
            "ch_flow_setpoint_temp_value", "ch_flow_setpoint_temp_unit", "ch_flow_temp_value", "ch_flow_temp_unit",
            "ch_return_temp_value", "ch_return_temp_unit", "outside_temp_value", "outside_temp_unit",
            "signal_strength_value", "signal_strength_unit",
            "water_heater_current_temperature", "water_heater_target_temperature", "water_heater_minimum_temperature",
            "water_heater_maximum_temperature", "water_heater_temperature_unit", "water_heater_temperature_step",
            "water_heater_temperature_decimals", "water_heater_reduced_minimum_temperature", "water_heater_reduced_maximum_temperature",
            "water_heater_reduced_temperature_step", "water_heater_mode", "water_heater_mode_value", "water_heater_mode_options",
            "water_heater_current_mode_text", "water_heater_mode_operation_texts", "dhw_mode_changeable",
            "water_heater_power_value", "water_heater_eco_value", "water_heater_boost", "water_heater_preheating_on_off",
            "water_heater_power_option_value", "water_anti_leg_value", "anti_legionella_on_off", "is_antileg", "is_heating",
            "rm_tm_in_minutes", "rm_tm_value", "water_heater_heating_rate", "water_heater_reduced_temperature",
            "water_heater_minimum_setpoint_temperature", "water_heater_maximum_setpoint_temperature",
            "water_heater_minimum_setpoint_temperature_minimum", "water_heater_minimum_setpoint_temperature_maximum",
            "water_heater_maximum_setpoint_temperature_minimum", "water_heater_maximum_setpoint_temperature_maximum",
            "max_setpoint_temp", "proc_req_temp_value", "av_shw_value", "req_shower", "max_req_shower",
            "gas_consumption_for_heating_last_month", "electricity_consumption_for_heating_last_month",
            "electricity_consumption_for_cooling_last_month", "gas_consumption_for_water_last_month",
            "electric_consumption_for_water_last_two_hours",
            "electricity_consumption_for_water_last_month", "central_heating_total_energy_consumption",
            "domestic_hot_water_total_energy_consumption", "central_heating_gas_consumption",
            "central_heating_electricity_consumption", "domestic_hot_water_gas_consumption",
            "domestic_hot_water_electricity_consumption", "domestic_hot_water_heating_pump_electricity_consumption",
            "domestic_hot_water_resistor_electricity_consumption", "consumption_sequence_last_changed_utc",
            "bus_errors", "is_quiet_value", "currency", "gas_type", "gas_energy_unit", "elect_cost", "gas_cost",
            "hybrid_mode", "hybrid_mode_value", "hybrid_mode_options", "hybrid_mode_opt_texts",
            "buffer_control_mode", "buffer_control_mode_value", "buffer_control_mode_options", "buffer_control_mode_opt_texts",
            "permanent_boost_value", "anti_cooling_value", "anti_cooling_temperature_value",
            "anti_cooling_temperature_minimum", "anti_cooling_temperature_maximum", "night_mode_value",
            "night_mode_begin_as_minutes_value", "night_mode_begin_min_as_minutes_value", "night_mode_begin_max_as_minutes_value",
            "night_mode_end_as_minutes_value", "night_mode_end_min_as_minutes_value", "night_mode_end_max_as_minutes_value",
        ]
        for attr in scalar_attrs:
            value = _safe_get(device, attr)
            if value is not None:
                data[attr] = value

        option_methods = {
            "currency_options": "get_currencies",
            "gas_type_options": "get_gas_types",
            "gas_energy_unit_options": "get_gas_energy_units",
        }
        for key, method in option_methods.items():
            fn = getattr(device, method, None)
            if not callable(fn):
                continue
            try:
                value = fn()
                if not inspect.isawaitable(value) and value is not None:
                    data[key] = _serialize(value)
            except Exception:
                continue

        data["zones"] = self._snapshot_zones(device, data.get("zone_numbers") or [])
        return {"devices": [data], "summary": {"device_count": 1, "status": "online", "selected_gateway": gateway}}

    def _snapshot_zones(self, device: Any, zone_numbers: list[Any]) -> list[dict[str, Any]]:
        zones: list[dict[str, Any]] = []

        def call(method: str, zone: int) -> Any:
            fn = getattr(device, method, None)
            if not callable(fn):
                return None
            try:
                result = fn(zone)
                if inspect.isawaitable(result):
                    return None
                return _serialize(result)
            except Exception:
                return None

        method_map = {
            "temperature_unit": "get_measured_temp_unit",
            "temperature_decimals": "get_measured_temp_decimals",
            "current_temperature": "get_measured_temp_value",
            "target_temperature": "get_target_temp_value",
            "target_temperature_step": "get_target_temp_step",
            "min_temperature": "get_comfort_temp_min",
            "max_temperature": "get_comfort_temp_max",
            "economy_temperature": "get_zone_economy_temp_value",
            "heat_request": "get_zone_heat_request_value",
            "heating_flow_temperature": "get_heating_flow_temp_value",
            "heating_flow_temperature_min": "get_heating_flow_temp_min",
            "heating_flow_temperature_max": "get_heating_flow_temp_max",
            "heating_flow_temperature_step": "get_heating_flow_temp_step",
            "heating_flow_offset": "get_heating_flow_offset_value",
            "heating_flow_offset_min": "get_heating_flow_offset_min",
            "heating_flow_offset_max": "get_heating_flow_offset_max",
            "heating_flow_offset_step": "get_heating_flow_offset_step",
        }
        for zone_raw in zone_numbers:
            try:
                zone = int(zone_raw)
            except Exception:
                continue
            row = {"zone": zone}
            for key, method in method_map.items():
                value = call(method, zone)
                if value is not None:
                    row[key] = value
            for method in ["is_zone_in_manual_mode", "is_zone_in_time_program_mode", "is_zone_in_cool_mode"]:
                value = call(method, zone)
                if value is not None:
                    row[method.removeprefix("is_zone_")] = bool(value)
            options = call("get_zone_mode_options", zone)
            if options is not None:
                row["zone_mode_options"] = options
            zones.append(row)
        return zones

    async def control_entity(self, entity_id: str, action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        data = data or {}
        action = str(action or "").strip().lower()
        suffix = str(entity_id or "").split(":", 2)[-1]
        value = data.get("value")
        device, _cloud_device = await self._live_device(force_reconnect=False)

        async def call_required(method: str, *args: Any) -> None:
            fn = getattr(device, method, None)
            if not callable(fn):
                raise AristonNetError(f"Comanda AristonNET '{method}' nu este disponibilă pentru acest dispozitiv.")
            result = fn(*args)
            if inspect.isawaitable(result):
                await result

        def enum_member(enum_name: str, raw: Any) -> Any:
            try:
                from ariston import const as ariston_const  # type: ignore
                enum_cls = getattr(ariston_const, enum_name, None)
            except Exception:
                enum_cls = None
            if enum_cls is None:
                return raw
            text = str(raw or "").strip()
            for member in enum_cls:
                if text in {str(getattr(member, "name", "")), str(getattr(member, "value", "")), str(member)}:
                    return member
            try:
                return enum_cls(text)
            except Exception:
                return raw

        if suffix.startswith("zone_") and suffix.endswith("_target_temperature"):
            zone = int(suffix.split("_")[1])
            await call_required("async_set_comfort_temp", float(value), zone)
        elif suffix.startswith("zone_") and suffix.endswith("_heating_flow_temperature"):
            zone = int(suffix.split("_")[1])
            await call_required("async_set_heating_flow_temp", float(value), zone)
        elif suffix.startswith("zone_") and suffix.endswith("_heating_flow_offset"):
            zone = int(suffix.split("_")[1])
            await call_required("async_set_heating_flow_offset", float(value), zone)
        elif suffix.startswith("zone_") and suffix.endswith("_mode"):
            zone = int(suffix.split("_")[1])
            await call_required("async_set_zone_mode", enum_member("ZoneMode", value), zone)
        elif suffix == "plant_mode":
            await call_required("async_set_plant_mode", enum_member("PlantMode", value))
        elif suffix == "water_heater_target_temperature":
            await call_required("async_set_water_heater_temperature", float(value))
        elif suffix == "water_heater_reduced_temperature":
            await call_required("async_set_water_heater_reduced_temperature", float(value))
        elif suffix == "water_heater_minimum_setpoint_temperature":
            await call_required("async_set_min_setpoint_temp", float(value))
        elif suffix == "water_heater_maximum_setpoint_temperature":
            await call_required("async_set_max_setpoint_temp", float(value))
        elif suffix == "requested_showers":
            await call_required("async_set_water_heater_number_of_showers", int(float(value)))
        elif suffix == "anti_cooling_temperature":
            await call_required("async_set_cooling_temperature_value", int(float(value)))
        elif suffix == "night_mode_begin":
            await call_required("async_set_night_mode_begin_as_minutes_value", int(float(value)))
        elif suffix == "night_mode_end":
            await call_required("async_set_night_mode_end_as_minutes_value", int(float(value)))
        elif suffix == "electricity_cost":
            await call_required("async_set_elect_cost", float(value))
        elif suffix == "gas_cost":
            await call_required("async_set_gas_cost", float(value))
        elif suffix == "water_heater_mode":
            await call_required("async_set_water_heater_operation_mode", str(value))
        elif suffix == "currency":
            await call_required("async_set_currency", str(value))
        elif suffix == "gas_type":
            await call_required("async_set_gas_type", str(value))
        elif suffix == "gas_energy_unit":
            await call_required("async_set_gas_energy_unit", str(value))
        elif suffix == "hybrid_mode":
            await call_required("async_set_hybrid_mode", str(value))
        elif suffix == "buffer_control_mode":
            await call_required("async_set_buffer_control_mode", str(value))
        elif suffix == "water_heater_power":
            await call_required("async_set_power", action == "turn_on")
        elif suffix == "water_heater_eco":
            await call_required("async_set_eco_mode", action == "turn_on")
        elif suffix == "water_heater_boost":
            await call_required("async_set_water_heater_boost", action == "turn_on")
        elif suffix == "automatic_thermoregulation":
            await call_required("async_set_automatic_thermoregulation", action == "turn_on")
        elif suffix == "quiet_mode":
            await call_required("async_set_is_quiet", action == "turn_on")
        elif suffix == "water_heater_power_option":
            await call_required("async_set_water_heater_power_option", action == "turn_on")
        elif suffix == "anti_legionella":
            await call_required("async_set_antilegionella", action == "turn_on")
        elif suffix == "water_heater_preheating":
            await call_required("async_set_preheating", action == "turn_on")
        elif suffix == "permanent_boost":
            await call_required("async_set_permanent_boost_value", action == "turn_on")
        elif suffix == "anti_cooling":
            await call_required("async_set_anti_cooling_value", action == "turn_on")
        elif suffix == "night_mode":
            await call_required("async_set_night_mode_value", action == "turn_on")
        else:
            raise AristonNetError(f"Entitatea AristonNET '{entity_id}' nu are control mapat.")

        self.clear_cache()
        await self._update_device(device)
        return {"ok": True, "entity_id": entity_id, "action": action}


_client: AristonNetClient | None = None
_client_key: tuple[Any, ...] | None = None


def _client_from_config(cfg: dict[str, Any], *, allow_disabled: bool = False) -> AristonNetClient | None:
    if not cfg.get("enabled") and not allow_disabled:
        return None
    username = str(cfg.get("username") or "").strip()
    password = str(cfg.get("password") or "").strip()
    if not username or not password:
        return None
    return AristonNetClient(
        username,
        password,
        api_url=cfg.get("api_url") or "",
        user_agent=cfg.get("user_agent") or "",
        device=cfg.get("device") or cfg.get("gateway") or "",
        metric=cfg.get("metric", True) is not False,
        cache_ttl=max(60, int(cfg.get("scan_interval") or 180)),
    )


async def ensure_client(*, allow_disabled: bool = False) -> AristonNetClient | None:
    global _client, _client_key
    cfg = settings_mod.CFG.get("ariston_net") or {}
    key = (
        bool(cfg.get("enabled")),
        cfg.get("username") or "",
        cfg.get("password") or "",
        cfg.get("api_url") or "",
        cfg.get("user_agent") or "",
        cfg.get("device") or cfg.get("gateway") or "",
        cfg.get("metric", True) is not False,
        int(cfg.get("scan_interval") or 180),
    )
    if _client is None or _client_key != key:
        _client = _client_from_config(cfg, allow_disabled=allow_disabled)
        _client_key = key
    if _client is None and allow_disabled:
        return _client_from_config(cfg, allow_disabled=True)
    return _client
