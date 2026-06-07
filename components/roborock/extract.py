"""Roborock cloud snapshot → Hyve vacuum/sensor entities."""

from __future__ import annotations

from typing import Any

from integrations.entity_utils import set_status_attrs


_DOCK_STATE_KEYS = {
    "charging": "charging",
    "full": "fully_charged",
    "off_peak_waiting": "charging_paused",
    "dusting": "emptying_bin",
    "returning": "returning",
}


def _generic_state(state_name: str | None, raw_state: Any) -> str:
    """Map a Roborock status into Hyve's generic vacuum state vocabulary."""
    text = str(state_name if state_name is not None else raw_state or "").lower()
    if not text:
        return "unknown"
    if any(k in text for k in ("error", "fault", "fail")):
        return "error"
    if "pause" in text:
        return "paused"
    if any(k in text for k in ("return", "go charg", "go home", "going to")):
        return "returning"
    if any(k in text for k in ("charg", "dock", "sleep", "full", "idle")):
        return "docked" if any(k in text for k in ("charg", "dock", "full")) else "idle"
    if any(k in text for k in ("clean", "sweep", "mop", "wash", "spot", "segment", "zone")):
        return "cleaning"
    return "idle"


def _charge_status_code(status: dict[str, Any]) -> int | None:
    value = status.get("charge_status")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _dock_state_label(dock_state: str | None, *, battery: Any = None) -> str | None:
    if not dock_state:
        return None
    key = str(dock_state).lower()
    if key == "charging":
        return "Charging"
    if key == "off_peak_waiting":
        return "Charging paused during peak hours"
    if key == "full":
        return "Fully charged"
    if key == "dusting":
        return "Emptying bin"
    if key == "returning":
        return "Returning"
    return _state_label(key)


def _vacuum_state_from_status(status: dict[str, Any]) -> tuple[str, str, str | None]:
    """Derive Hyve vacuum state, status_key, and human label from a Roborock snapshot.

    Older models (e.g. S5) sometimes report ``state=idle`` while ``charge_status=1``
    on the dock. python-roborock exposes ``dock_state`` for newer firmware; we
    also honour ``charge_status`` directly for backwards compatibility.
    """
    state_name = status.get("state_name")
    raw_state = status.get("state")
    active = _generic_state(state_name, raw_state)
    if active in ("cleaning", "returning", "paused", "error"):
        label = _state_label(state_name)
        return active, active, label

    dock_state = status.get("dock_state")
    if dock_state:
        ds = str(dock_state).lower()
        if ds in _DOCK_STATE_KEYS:
            label = _dock_state_label(ds, battery=status.get("battery"))
            return "docked", _DOCK_STATE_KEYS[ds], label
        if ds == "returning":
            label = _dock_state_label(ds)
            return "returning", "returning", label

    charge = _charge_status_code(status)
    if charge == 1:
        return "docked", "charging", "Charging"
    if charge == 0:
        battery = status.get("battery")
        try:
            pct = int(battery) if battery is not None else None
        except (TypeError, ValueError):
            pct = None
        if pct is not None and pct < 100:
            return "docked", "charging_paused", "Charging paused during peak hours"

    label = _state_label(state_name)
    status_key = active if active in ("idle", "docked", "unknown") else active
    return active, status_key, label


def _seconds_to(value: Any, divisor: float) -> float | None:
    if value is None:
        return None
    try:
        return round(float(value) / divisor, 1)
    except (TypeError, ValueError):
        return None


def _bool_or_none(value: Any) -> bool | None:
    if value is None:
        return None
    try:
        return int(value) > 0
    except (TypeError, ValueError):
        return bool(value)


def _state_label(name: str | None) -> str | None:
    if not name:
        return None
    return str(name).replace("_", " ").capitalize()


# ── derived entity descriptors (Home Assistant parity) ───────────────────
# Each Roborock device fans out into a vacuum entity plus the sensors and
# binary sensors below — mirroring the official HA Roborock platforms. They
# are data-driven so new ones can be added without touching extract_entities.
#   sensor:  (key, label, icon, unit, device_class, getter(status, cons, clean))
_SENSOR_SPECS: list[tuple[str, str, str, str | None, str | None, Any]] = [
    ("battery", "Baterie", "fas fa-battery-half", "%", "battery",
        lambda s, c, cs: s.get("battery")),
    ("status", "Stare", "fas fa-robot", None, None,
        lambda s, c, cs: _state_label(s.get("state_name"))),
    ("fan_speed", "Putere aspirare", "fas fa-wind", None, None,
        lambda s, c, cs: s.get("fan_speed_name")),
    ("cleaning_area", "Suprafață curățată", "fas fa-ruler-combined", "m²", None,
        lambda s, c, cs: s.get("square_meter_clean_area")),
    ("cleaning_time", "Durată curățare", "fas fa-stopwatch", "min", "duration",
        lambda s, c, cs: _seconds_to(s.get("clean_time"), 60)),
    ("total_cleaning_area", "Suprafață totală", "fas fa-ruler-combined", "m²", None,
        lambda s, c, cs: cs.get("square_meter_clean_area")),
    ("total_cleaning_time", "Durată totală", "fas fa-clock", "h", "duration",
        lambda s, c, cs: _seconds_to(cs.get("clean_time"), 3600)),
    ("total_cleaning_count", "Număr curățări", "fas fa-list-ol", None, None,
        lambda s, c, cs: cs.get("clean_count")),
    ("dust_collection_count", "Goliri rezervor", "fas fa-trash-can", None, None,
        lambda s, c, cs: cs.get("dust_collection_count")),
    ("main_brush_left", "Perie principală rămasă", "fas fa-broom", "h", "duration",
        lambda s, c, cs: _seconds_to(c.get("main_brush_time_left"), 3600)),
    ("side_brush_left", "Perie laterală rămasă", "fas fa-broom", "h", "duration",
        lambda s, c, cs: _seconds_to(c.get("side_brush_time_left"), 3600)),
    ("filter_left", "Filtru rămas", "fas fa-filter", "h", "duration",
        lambda s, c, cs: _seconds_to(c.get("filter_time_left"), 3600)),
    ("sensor_dirty_left", "Senzori rămas", "fas fa-wave-square", "h", "duration",
        lambda s, c, cs: _seconds_to(c.get("sensor_time_left"), 3600)),
]

#   binary_sensor: (key, label, icon, device_class, getter(status) -> bool|None)
_BINARY_SPECS: list[tuple[str, str, str, str | None, Any]] = [
    ("mop_attached", "Mop atașat", "fas fa-paint-roller", None,
        lambda s: _bool_or_none(s.get("water_box_carriage_status"))),
    ("water_box_attached", "Rezervor apă atașat", "fas fa-droplet", None,
        lambda s: _bool_or_none(s.get("water_box_status"))),
    ("water_shortage", "Lipsă apă", "fas fa-triangle-exclamation", "problem",
        lambda s: _bool_or_none(s.get("water_shortage_status"))),
    ("cleaning", "În curățare", "fas fa-broom", "running",
        lambda s: (None if s.get("in_cleaning") is None else int(s.get("in_cleaning")) != 0)),
    ("charging", "Se încarcă", "fas fa-bolt", "battery_charging",
        lambda s: (None if s.get("charge_status") is None else int(s.get("charge_status")) == 1)),
]

def extract_roborock_candidates(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    out: list[dict[str, Any]] = []
    for dev in payload.get("devices") or []:
        duid = dev.get("duid")
        if not duid:
            continue
        name = dev.get("name") or "Roborock"
        model = dev.get("model")
        online = bool(dev.get("online"))
        status = dev.get("status") or {}
        consumable = dev.get("consumable") or {}
        clean_summary = dev.get("clean_summary") or {}
        obj = _object_id(name, duid)
        if online:
            state, status_key, status_label = _vacuum_state_from_status(status)
        else:
            state, status_key, status_label = "unavailable", "", None

        attributes: dict[str, Any] = {
            "device_id": duid,
            "device_name": name,
            "device_model": model,
            "online": online,
        }
        transport = dev.get("transport")
        if transport:
            attributes["connection_transport"] = transport
        if dev.get("local_connected") is not None:
            attributes["local_connected"] = bool(dev.get("local_connected"))
        local_ip = dev.get("local_ip")
        if local_ip:
            attributes["local_ip"] = local_ip
        battery = status.get("battery")
        if battery is not None:
            try:
                attributes["battery_level"] = int(round(float(battery)))
            except (TypeError, ValueError):
                attributes["battery_level"] = battery
        fan = status.get("fan_speed_name") or status.get("fan_power")
        if fan is not None:
            attributes["fan_speed"] = fan
        if status.get("state_name"):
            set_status_attrs(
                attributes,
                key=status_key or _generic_state(status.get("state_name"), status.get("state")),
                label=status_label or _state_label(status.get("state_name")),
            )
        elif status_key:
            set_status_attrs(attributes, key=status_key, label=status_label)
        elif status_label:
            attributes["status"] = status_label
        charge = _charge_status_code(status)
        if charge is not None:
            attributes["charge_status"] = charge
        if status.get("error_code_name") and str(status.get("error_code")) not in ("0", "None", ""):
            attributes["error"] = status.get("error_code_name")

        out.append(
            {
                "entity_id": f"vacuum.{obj}",
                "unique_id": f"roborock:{duid}",
                "name": name,
                "friendly_name": name,
                "state": state,
                "domain": "vacuum",
                "source": "roborock",
                "controllable": True,
                "icon": "fas fa-robot",
                "attributes": attributes,
            }
        )

        # Fan out the diagnostic sensors / binary sensors, but only when the
        # device is reachable and actually reported a value (so models that
        # don't support a field — or a transient offline scan — don't create
        # churn or empty entities).
        if not online:
            continue

        base_attrs = {"device_id": duid, "device_name": name, "device_model": model}
        for key, label, icon, unit, device_class, getter in _SENSOR_SPECS:
            try:
                value = getter(status, consumable, clean_summary)
            except Exception:
                value = None
            if value is None:
                continue
            sensor_attrs = dict(base_attrs)
            if unit:
                sensor_attrs["unit_of_measurement"] = unit
            if device_class:
                sensor_attrs["device_class"] = device_class
            out.append(
                {
                    "entity_id": f"sensor.{obj}_{key}",
                    "unique_id": f"roborock:{duid}:{key}",
                    "name": f"{name} {label}",
                    "friendly_name": f"{name} {label}",
                    "state": value,
                    "domain": "sensor",
                    "source": "roborock",
                    "controllable": False,
                    "icon": icon,
                    "attributes": sensor_attrs,
                }
            )

        for key, label, icon, device_class, getter in _BINARY_SPECS:
            try:
                flag = getter(status)
            except Exception:
                flag = None
            if flag is None:
                continue
            bin_attrs = dict(base_attrs)
            if device_class:
                bin_attrs["device_class"] = device_class
            out.append(
                {
                    "entity_id": f"binary_sensor.{obj}_{key}",
                    "unique_id": f"roborock:{duid}:{key}",
                    "name": f"{name} {label}",
                    "friendly_name": f"{name} {label}",
                    "state": "on" if flag else "off",
                    "domain": "binary_sensor",
                    "source": "roborock",
                    "controllable": False,
                    "icon": icon,
                    "attributes": bin_attrs,
                }
            )
    return out

def _object_id(name: str, duid: str) -> str:
    import re

    base = re.sub(r"[^a-z0-9]+", "_", str(name or "").lower()).strip("_")
    if not base:
        base = f"roborock_{str(duid)[:8]}"
    return base


def _friendly_auth_error(exc: Exception) -> str:
    """Translate python-roborock login errors into actionable Romanian text."""
    name = exc.__class__.__name__
    if name in ("RoborockInvalidUserAgreement", "RoborockNoUserAgreement"):
        return (
            "Cloud-ul Roborock a refuzat contul: trebuie să accepți din nou termenii "
            "în aplicația Roborock. Dacă aspiratorul a fost configurat prin aplicația "
            "Xiaomi / Mi Home, integrarea Roborock nu îl suportă — folosește integrarea "
            "Xiaomi Home pentru el."
        )
    if name in ("RoborockInvalidCode",):
        return "Cod de verificare invalid sau expirat. Apasă din nou „Testează” pentru un cod nou."
    if name in ("RoborockAccountDoesNotExist",):
        return "Contul nu există pentru regiunea aleasă — verifică e-mailul și regiunea."
    if name == "RoborockInvalidCredentials":
        return "Date de autentificare invalide — verifică adresa de e-mail."
    if name == "RoborockTooFrequentCodeRequests":
        return "Prea multe cereri de cod. Așteaptă câteva minute și încearcă din nou."
    return str(exc) or name
