"""Xiaomi Home MIoT profile → Hyve entity mapping."""

from __future__ import annotations

from typing import Any

import xiaomi_home_client as xh
from integrations.entity_utils import set_status_attrs, slugify

# ── entity mapping ────────────────────────────────────────────────────────
_ON_DOMAINS = {"light", "switch", "fan", "humidifier", "climate", "water_heater"}

# Domains that get a rich "primary" device entity (toggle / vacuum buttons /
# cover-lock state). Everything else is represented purely by its properties.
_PRIMARY_DOMAINS = _ON_DOMAINS | {"cover", "lock", "vacuum"}


def _pretty(prop: str) -> str:
    return str(prop or "").replace("-", " ").replace("_", " ").strip()


def _object_id(name: str, did: str, suffix: str = "") -> str:
    """Build a stable, unique HA-style object_id for an entity.

    Combines the device name slug with a short ``did`` tail (uniqueness across
    same-named devices) plus an optional per-property suffix.
    """
    base = slugify(name) or "device"
    tail = slugify(str(did))[-6:] or "0"
    parts = [base, tail]
    if suffix:
        parts.append(slugify(suffix))
    return "_".join(p for p in parts if p)


def _prop_entity(
    did: str,
    name: str,
    model: str,
    online: bool,
    prop: dict[str, Any],
    value: Any,
) -> dict[str, Any] | None:
    """Build a generic per-property entity from a classified MIoT property."""
    platform = prop.get("platform")
    if not platform:
        return None
    siid, piid = prop["siid"], prop["piid"]
    pname = prop.get("prop") or "value"
    value_list = prop.get("value_list") or {}
    meta = xh.PROP_META.get(pname, {})
    unit = prop.get("unit") or meta.get("unit")
    label = f"{name} {_pretty(pname)}".strip()

    attributes: dict[str, Any] = {
        "did": did,
        "device_id": did,
        "device_name": name,
        "device_model": model,
        "online": online,
    }
    caps: dict[str, Any] = {}
    controllable = platform in ("switch", "select", "number")

    if platform in ("switch", "binary_sensor"):
        if value is None and platform == "binary_sensor":
            return None
        state: Any = "on" if bool(value) else "off"
    elif platform == "select":
        caps["options"] = [
            {"value": str(k), "label": str(v)} for k, v in value_list.items()
        ]
        state = "" if value is None else str(value)
    elif platform == "number":
        rng = prop.get("value_range")
        if isinstance(rng, list) and len(rng) >= 2:
            caps["min"] = rng[0]
            caps["max"] = rng[1]
            if len(rng) >= 3 and rng[2]:
                caps["step"] = rng[2]
        state = value
    else:  # sensor
        if value is None:
            return None
        state = value_list.get(value, value) if value_list else value

    if unit:
        attributes["unit_of_measurement"] = unit
    if meta.get("device_class"):
        attributes["device_class"] = meta["device_class"]
    elif platform in ("sensor", "binary_sensor"):
        attributes["device_class"] = pname
    if caps:
        attributes["capabilities"] = caps

    return {
        "entity_id": f"{platform}.{_object_id(name, did, pname)}",
        "unique_id": f"xiaomi_home:{did}:p:{siid}:{piid}",
        "name": label,
        "friendly_name": label,
        "state": state,
        "domain": platform,
        "source": "xiaomi_home",
        "controllable": controllable,
        "icon": _icon_for_domain(platform),
        "attributes": attributes,
    }


def _profile_to_entities(did: str, profile: dict[str, Any]) -> list[dict[str, Any]]:
    name = profile.get("name") or did
    model = profile.get("model") or ""
    domain = profile.get("domain") or "sensor"
    controls = profile.get("controls") or {}
    values = profile.get("values") or {}
    online = bool(profile.get("online"))
    out: list[dict[str, Any]] = []

    def _val(desc: dict[str, Any] | None) -> Any:
        if not desc:
            return None
        return values.get(f"{desc['siid']}.{desc['piid']}")

    # Properties already represented by the primary entity (skip in the
    # generic pass to avoid a duplicate toggle / state row).
    primary_keys: set[tuple[int, int]] = set()
    has_primary = domain in _PRIMARY_DOMAINS

    if has_primary:
        on_desc = controls.get("on")
        attributes: dict[str, Any] = {
            "did": did,
            "device_id": did,
            "device_name": name,
            "device_model": model,
            "online": online,
        }
        state: Any
        if on_desc is not None:
            primary_keys.add((on_desc["siid"], on_desc["piid"]))
            state = "on" if bool(_val(on_desc)) else "off"
        elif domain == "vacuum":
            status_desc = controls.get("status")
            status_raw = _val(status_desc)
            battery_level = _battery_level_from_profile(profile, values)
            if battery_level is not None:
                attributes["battery_level"] = battery_level
            state, status_key, status_label = _vacuum_state_and_label(
                status_desc,
                status_raw,
                profile,
                values,
                battery_level=battery_level,
            )
            if status_desc:
                primary_keys.add((status_desc["siid"], status_desc["piid"]))
            if status_key:
                set_status_attrs(attributes, key=status_key, label=status_label)
            elif status_label:
                attributes["status"] = status_label
            charge_code, _ = _charging_from_profile(profile, values)
            if charge_code is not None:
                attributes["charging_state"] = charge_code
        elif domain in ("cover", "lock"):
            state = "unknown"
        else:
            state = "online" if online else "offline"

        out.append(
            {
                "entity_id": f"{domain}.{_object_id(name, did)}",
                "unique_id": f"xiaomi_home:{did}",
                "name": name,
                "friendly_name": name,
                "state": state,
                "domain": domain,
                "source": "xiaomi_home",
                "controllable": True,
                "icon": _icon_for_domain(domain),
                "attributes": attributes,
            }
        )

    # Generic per-property entities (switch / select / number / sensor /
    # binary_sensor) — the HA-style "every property is an entity" model.
    seen: set[tuple[int, int]] = set()
    for prop in profile.get("props") or []:
        key = (prop.get("siid"), prop.get("piid"))
        if key in primary_keys or key in seen:
            continue
        seen.add(key)
        ent = _prop_entity(did, name, model, online, prop, values.get(f"{key[0]}.{key[1]}"))
        if ent is not None:
            out.append(ent)

    # If a device exposed no usable properties and no primary entity, still
    # surface a minimal online/offline sensor so it appears in the UI.
    if not out:
        out.append(
            {
                "entity_id": f"sensor.{_object_id(name, did)}",
                "unique_id": f"xiaomi_home:{did}",
                "name": name,
                "friendly_name": name,
                "state": "online" if online else "offline",
                "domain": "sensor",
                "source": "xiaomi_home",
                "controllable": False,
                "icon": _icon_for_domain("sensor"),
                "attributes": {
                    "did": did,
                    "device_id": did,
                    "device_name": name,
                    "device_model": model,
                    "online": online,
                },
            }
        )
    return out


def _vacuum_state(status_desc: dict[str, Any] | None, raw: Any) -> str:
    """Map a vacuum's raw status value to a generic Hyve state string."""
    if status_desc is None or raw is None:
        return "unknown"
    label = (status_desc.get("value_list") or {}).get(raw)
    text = str(label if label is not None else raw).lower()
    if any(k in text for k in ("sweep", "clean", "mop", "work", "busy")):
        return "cleaning"
    if any(k in text for k in ("return", "go charg", "go-charg", "back")):
        return "returning"
    if any(k in text for k in ("full", "complete")):
        return "docked"
    if any(k in text for k in ("charg", "dock")):
        return "docked"
    if "pause" in text:
        return "paused"
    if any(k in text for k in ("error", "fault", "fail")):
        return "error"
    return "idle"


def _status_label(status_desc: dict[str, Any] | None, raw: Any) -> str | None:
    if status_desc is None or raw is None:
        return None
    label = (status_desc.get("value_list") or {}).get(raw)
    return str(label) if label is not None else None


def _battery_level_from_profile(
    profile: dict[str, Any], values: dict[str, Any]
) -> int | None:
    """Read ``battery-level`` from MIoT props/reads (same source as sensor entity)."""
    candidates: list[dict[str, Any]] = []
    candidates.extend(profile.get("props") or [])
    candidates.extend(profile.get("reads") or [])
    for prop in candidates:
        pname = str(prop.get("prop") or "").lower().replace("-", "_")
        if pname not in {"battery_level", "battery"} and "battery" not in pname:
            continue
        if pname != "battery" and "level" not in pname:
            continue
        siid, piid = prop.get("siid"), prop.get("piid")
        if siid is None or piid is None:
            continue
        raw = values.get(f"{siid}.{piid}")
        if raw is None:
            continue
        try:
            return int(round(float(raw)))
        except (TypeError, ValueError):
            continue
    return None


def _charging_from_profile(
    profile: dict[str, Any], values: dict[str, Any]
) -> tuple[int | None, str | None]:
    """Read ``battery.charging-state`` (or similar) from MIoT property values."""
    for prop in profile.get("props") or []:
        pname = str(prop.get("prop") or "").lower().replace("-", "_")
        if "charg" not in pname:
            continue
        if pname not in {"charging_state", "charge_state", "charging_status"} and "state" not in pname:
            continue
        siid, piid = prop.get("siid"), prop.get("piid")
        if siid is None or piid is None:
            continue
        raw = values.get(f"{siid}.{piid}")
        if raw is None:
            continue
        value_list = prop.get("value_list") or {}
        label = value_list.get(raw)
        if label is None and prop.get("platform") == "binary_sensor":
            label = "Charging" if bool(raw) else None
        try:
            code = int(raw)
        except (TypeError, ValueError):
            code = 1 if bool(raw) else 0
        return code, str(label) if label is not None else None
    return None, None


def _vacuum_state_and_label(
    status_desc: dict[str, Any] | None,
    raw: Any,
    profile: dict[str, Any],
    values: dict[str, Any],
    *,
    battery_level: Any = None,
) -> tuple[str, str, str | None]:
    """Derive vacuum state, status_key, and display label, honouring MIoT charging-state.

    Many Xiaomi / Roborock vacuums bound to Mi Home keep ``vacuum.status`` at
    Idle on the dock while ``battery.charging-state`` reports active charging.
    """
    base = _vacuum_state(status_desc, raw)
    label = _status_label(status_desc, raw)

    if base in ("cleaning", "returning", "paused", "error"):
        status_key = base
        if base == "cleaning" and label:
            text = label.lower()
            if "sweep" in text or "mop" in text:
                status_key = "cleaning"
        return base, status_key, label

    charge_code, charge_label = _charging_from_profile(profile, values)
    try:
        pct = int(battery_level) if battery_level is not None else None
    except (TypeError, ValueError):
        pct = None
    if pct is None:
        pct = _battery_level_from_profile(profile, values)

    if charge_code == 1:
        if pct == 100:
            return "docked", "fully_charged", "Fully charged"
        return "docked", "charging", charge_label or "Charging"
    if charge_label:
        text = charge_label.lower()
        if any(k in text for k in ("charg", "full", "complete")):
            if "full" in text or "complete" in text:
                return "docked", "fully_charged", charge_label
            return "docked", "charging", charge_label

    if base == "docked":
        return base, "docked", label or charge_label
    if pct == 100 and base == "idle" and charge_code in (0, None):
        return "docked", "fully_charged", label or "Fully charged"

    status_key = base if base in ("idle", "docked", "unknown") else base
    return base, status_key, label


def _icon_for_domain(domain: str) -> str:
    return {
        "light": "fas fa-lightbulb",
        "switch": "fas fa-plug",
        "fan": "fas fa-fan",
        "climate": "fas fa-temperature-half",
        "humidifier": "fas fa-droplet",
        "water_heater": "fas fa-shower",
        "cover": "fas fa-blinds",
        "lock": "fas fa-lock",
        "vacuum": "fas fa-robot",
        "binary_sensor": "fas fa-circle-dot",
        "sensor": "fas fa-gauge",
        "number": "fas fa-sliders",
        "select": "fas fa-list",
    }.get(domain, "fas fa-house-signal")

def extract_xiaomi_home_candidates(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    profiles = payload.get("profiles") or {}
    out: list[dict[str, Any]] = []
    for did, profile in profiles.items():
        out.extend(_profile_to_entities(did, profile))
    return out
